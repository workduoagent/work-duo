//! 知识库域工具：kb_search（S1 拆分自 native.rs，台账 §2.1）。

//! 系统原生工具（对应方案步骤 2）。
//!
//! 提供一组最小可用的本地工具，全部纳入 `native__` 命名空间：
//!  - `native__read_file`：读取工作空间内文本文件（ReadSafe）；
//!  - `native__write_file`：写入/覆盖文件（RequireApproval，sensitive）；
//!  - `native__edit_file`：字符串替换式改文件（RequireApproval，sensitive，审批弹窗走 Diff）；
//!  - `native__list_directory`：列出目录内容（ReadSafe）；
//!  - `native__path_exists`：判断路径（文件/目录）是否存在及类型（ReadSafe，list/edit/read/write 的强制前置闭环）；
//!  - `native__execute_command`：执行系统命令（RequireApproval，sensitive）；
//!  - `native__run_python_sandbox`：在 micromamba 沙箱环境运行 Python 脚本（RequireApproval）。
//!
//! 所有文件操作都经 `PathGuard` 校验，约束在 workspace 内；沙箱执行复用 `mamba_manager`
//! 的 `run_python_script` 命令（不新建运行时）。


use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;

use crate::agent::engine::tools::AgentTool;
use crate::agent::engine::tools::PermissionLevel;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolError;


// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。




/// 构造标准 function-calling 定义骨架。

use super::*;


#[async_trait]
impl AgentTool for KbSearchTool {
    fn name(&self) -> String {
        "native__kb_search".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__kb_search",
            "检索已绑定的知识库（Markdown/TXT 文档），默认范围为**全部已绑定库**（可用 kb_ids 收窄到指定库），返回与查询最相关的资料片段（含源文件路径与层级位置，可溯源）。回答事实性、配置类、领域知识问题时应优先调用本工具核对资料，而非凭记忆臆测。只读，无需审批。每个片段带 cite 字段 = 任务内全局引用编号（同一片段跨调用编号不变）；**在最终回答中引用某片段内容时，请在对应句子末尾标注其引用编号**（如 [1]、[2]，紧跟句末标点前），便于用户悬浮溯源；未引用到的片段不必标注。",
            json!({
                "query": { "type": "string", "description": "检索查询（自然语言，可含关键词）" },
                "top_k": { "type": "integer", "description": "返回片段数上限，默认 5，最大 8；除非确需多角度覆盖，保持默认即可" },
                "kb_ids": { "type": "array", "items": { "type": "string" }, "description": "可选：限定检索的知识库范围，值为知识库的 id 或 identifier（须为当前智能体已绑定的库，指定未绑定的库会直接报错）。默认省略 = 检索全部已绑定库。**不要把库名填进 tags**" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "可选：文档（资产）级标签过滤，匹配 meta_data.tags 文档标签——**不是知识库名/identifier**（按库限定请用 kb_ids）；仅检索打了这些标签的文件，标签清单见知识库详情页标签云。用户明确要求按标签限定范围时才传，否则省略" }
            }),
            &["query"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, _ctx: &ToolContext) -> Result<String, ToolError> {        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if query.is_empty() {
            return Err(ToolError::InvalidArgs("kb_search 缺少 query 参数".into()));
        }
        // 护栏硬化（#5）：先取号再干活——超过硬上限直接拒绝执行，强制模型基于已有资料作答。
        let n = self
            .call_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if n > KB_SEARCH_HARD_LIMIT {
            return Ok(serde_json::to_string(&serde_json::json!({
                "blocked": true,
                "notice": format!(
                    "已达本任务知识库检索硬上限（{} 次），本次检索未执行。你已拥有足够的检索资料，请立即基于已有信息输出最终答案，不要再尝试调用本工具。",
                    KB_SEARCH_HARD_LIMIT
                ),
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        let top_k = args.get("top_k").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
        // K3-3 标签圈定（可选）：传入资产标签 → 仅在命中标签的资产范围内检索。
        let mut tags: Option<Vec<String>> = args.get("tags").and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        });
        // P-04 §4.1/4.2：按库收窄（可选）——值可为库 id 或 identifier，必须 ⊆ 绑定库（越权明确报错）。
        let kb_req: Option<Vec<String>> = args.get("kb_ids").and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        });
        let mut scope: Option<Vec<String>> = None;
        if let Some(req) = kb_req.filter(|r| !r.is_empty()) {
            scope = Some(
                crate::agent::knowledge::knowledge::resolve_kb_scope(&self.app, &self.kb_ids, &req)
                    .await
                    .map_err(ToolError::InvalidArgs)?,
            );
        } else if tags.as_ref().is_some_and(|t| !t.is_empty()) {
            // P-04 §4.5 兼容捷径：tags 值全部精确命中绑定库的 id/identifier → 视为按库过滤
            // （真机 2026-09-22 实锤：模型把库名塞进 tags → 标签圈定 0 命中静默空）。
            let tags_v = tags.clone().unwrap();
            if let Ok(resolved) =
                crate::agent::knowledge::knowledge::resolve_kb_scope(&self.app, &self.kb_ids, &tags_v).await
            {
                if !resolved.is_empty() {
                    tracing::warn!(
                        "[agent] kb_search deprecated: tags-as-kb tags={:?} → 已按库过滤 scope={:?}；请改用 kb_ids 参数",
                        tags_v,
                        resolved
                    );
                    scope = Some(resolved);
                    tags = None;
                }
            }
        }
        let outcome = crate::agent::knowledge::knowledge::kb_search(
            &self.app,
            &self.kb_ids,
            &query,
            top_k,
            false,
            tags.as_deref(),
            scope.as_deref(),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;
        if outcome.hits.is_empty() {
            // P-04 §4.3：空结果结构化诊断（消灭静默空/假绿）——reason 区分「语义无命中」vs「过滤误杀」。
            let diag = outcome.diagnostics;
            let reason = diag.as_ref().map(|d| d.reason).unwrap_or("no_match");
            tracing::warn!(
                "[agent] kb_search 空结果 reason={} tags={:?} bound_kb={:?}",
                reason,
                tags,
                self.kb_ids
            );
            let note = diag.as_ref().map(|d| d.note.as_str()).unwrap_or("");
            return Ok(serde_json::to_string(&serde_json::json!({
                "hits": [],
                "diagnostics": diag,
                "notice": format!("知识库中未找到与查询相关的片段。{note}"),
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        let hits = outcome.hits;
        // K3-4 任务内去重：过滤本任务已返回过的 chunk（省重复 token）；全部重复时
        // 直接给收敛指令而非空列表（避免模型把「空」误读为「知识库没有」而臆测）。
        // 轮 7 实锤：模型重检同一内容时，目标 chunk 被 seen 过滤，而 fresh 里只有
        // 次要新命中 → full 通路（仅在 fresh 全空时触发）没开，模型永远拿不回被
        // 截断的正文。此处记录「score 优于 fresh 全部」的重复命中（L2 距离越小越
        // 相关）= 模型明确重检想要的旧内容，供下方 full 重取附带完整原文。
        let (fresh_hits, duplicate_count, better_dup_ids) = {
            let mut seen = self
                .seen_chunks
                .lock()
                .map_err(|_| ToolError::ExecutionFailed("kb_search 去重锁中毒".into()))?;
            let mut fresh = Vec::new();
            let mut dup_ids: Vec<(String, f32)> = Vec::new();
            for h in hits {
                if seen.insert(h.id.clone()) {
                    fresh.push(h);
                } else {
                    dup_ids.push((h.id, h.score));
                }
            }
            let best_fresh = fresh.first().map(|h| h.score).unwrap_or(f32::INFINITY);
            let better: Vec<String> = dup_ids
                .iter()
                .filter(|(_, s)| *s < best_fresh)
                .map(|(id, _)| id.clone())
                .collect();
            (fresh, dup_ids.len(), better)
        };
        if fresh_hits.is_empty() {
            // K3-4 修订（2026-09-20 轮 4 实锤）：全重复时重取完整原文——裁剪分级+去重叠加
            // 曾导致超长 chunk（调色板 ~700 字）被 600 上限腰斩且永远拿不回完整版。
            let full_hits = crate::agent::knowledge::knowledge::kb_search(
                &self.app,
                &self.kb_ids,
                &query,
                top_k,
                true,
                tags.as_deref(),
                scope.as_deref(),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?
            .hits;
            let full_hits = self.with_cite(full_hits)?;
            return Ok(serde_json::to_string(&serde_json::json!({
                "notice": format!(
                    "该查询命中的 {} 个片段此前已返回过（截断版）；以下为未截断的完整原文，请以此为准整理最终答案，无需再次检索。",
                    duplicate_count
                ),
                "hits": full_hits,
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        // 轮 7 修订：fresh 非空但存在「更优重复命中」时，full 重取其完整原文附带返回
        // （上限 2 个，token 有界）——重取通路的最后一块拼图：只要模型明确重检旧内容，
        // 就能拿回完整版，不再依赖「本次命中全部重复」这个过窄的触发条件。
        let mut out_hits = fresh_hits;
        let mut extra_notice = String::new();
        if !better_dup_ids.is_empty() {
            let full_hits = crate::agent::knowledge::knowledge::kb_search(
                &self.app,
                &self.kb_ids,
                &query,
                top_k,
                true,
                tags.as_deref(),
                scope.as_deref(),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?
            .hits;
            let extras: Vec<_> = full_hits
                .into_iter()
                .filter(|h| better_dup_ids.contains(&h.id))
                .take(2)
                .collect();
            let extra_n = extras.len();
            if extra_n > 0 {
                out_hits.extend(extras);
                extra_notice = format!(
                    "另有 {extra_n} 个本次重检命中、此前被截断的片段，其未截断完整原文已附在结果尾部，请以此为准整理最终答案。"
                );
            }
        }
        let hits_json = serde_json::to_value(self.with_cite(out_hits)?)
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?;
        // 收敛引导（软上限）：超限后包装返回，注入「立即整理答案」的强提示，
        // 把模型从「无限换词再检索」循环里拽出来（硬上限在 execute 入口短路）。
        if n > KB_SEARCH_SOFT_LIMIT {
            let mut notice = format!(
                "注意：本任务已执行 {} 次知识库检索（硬上限 {} 次）。多数章节应已覆盖；若确有明确的信息缺口可继续检索，否则请立即基于已有资料整理最终答案。",
                n, KB_SEARCH_HARD_LIMIT
            );
            notice.push_str(&extra_notice);
            return Ok(serde_json::to_string(&serde_json::json!({
                "notice": notice,
                "hits": hits_json,
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        if !extra_notice.is_empty() {
            return Ok(serde_json::to_string(&serde_json::json!({
                "notice": extra_notice,
                "hits": hits_json,
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        serde_json::to_string(&hits_json)
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))
    }
}

