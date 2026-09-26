//! 记忆与交互域工具：archive_artifact / anchor_memory / ask_user_choice / query_graph（S1 拆分自 native.rs，台账 §2.1）。

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

use std::fs::OpenOptions;
use std::io::Write;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;
use tauri::Manager;
use tokio::time::timeout;
use tokio::time::Duration;

use crate::agent::events;
use crate::agent::engine::graph::KnowledgeGraph;
use crate::agent::engine::tools::AgentTool;
use crate::agent::engine::tools::ToolBehavior;
use crate::agent::engine::tools::PathGuard;
use crate::agent::engine::tools::PermissionLevel;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolError;
use crate::agent::types::ChoiceOption;
use crate::agent::types::ChoiceRequest;


// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。

/// 宿主命令绝对硬超时（秒）。超时即显式 Kill 子进程，严防阻塞型命令挂死 Tokio 运行时。
const COMMAND_TIMEOUT_SECS: u64 = 60;
/// read_file 体积上限（问题 6 修复）：超过该值的文件不读入内存，直接拒绝并引导改用沙箱分段处理。
/// 2MB 读入内存可接受（返回值再由 truncate_tool_output 截到约 15KB）；再大则为截断而全读不值得。
const MAX_READ_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// zip 打包总大小上限（与 zip_extract 的 500MB 解体对称）：待打包源文件累计超过该值直接拒绝，防磁盘写满。
const MAX_ZIP_TOTAL_BYTES: u64 = 1024 * 1024 * 1024; // 1GB
/// grep_files 遍历深度上限：防符号链接环 / 极端嵌套导致的无限递归。
const MAX_GREP_DEPTH: usize = 20;

/// zip 解压防御上限（防 zip 炸弹）：单包条目数 / 解压后总大小。
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ZIP_EXTRACT_BYTES: u64 = 500 * 1024 * 1024;

/// 构造标准 function-calling 定义骨架。

use super::*;


/// 实体图检索工具：智能体运行时查询「某步产出了哪些文件 / 某文件被哪些步骤读写 / 历史任务链」
/// 等真实图数据，替代从模型 summary 文本猜测（对齐图驱动约束铁律：约束必须读真实图数据）。
/// 只读，ReadSafe 始终注册。
pub struct QueryGraphTool;

#[async_trait]
impl AgentTool for QueryGraphTool {
    fn name(&self) -> String {
        "native__query_graph".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__query_graph",
            "检索当前工作区的实体图（任务/文件/产物/记忆节点），用于查询「某步产出了哪些文件」「某文件被哪些步骤读写」「历史任务链」等真实图数据，辅助后续决策。只读，无需审批。",
            json!({
                "keyword": { "type": "string", "description": "模糊匹配关键词（标题/描述/路径）" },
                "kind": { "type": "string", "enum": ["session", "task", "artifact", "file_ref", "memory", "prompt"], "description": "可选节点类型过滤" },
                "limit": { "type": "integer", "description": "返回上限，默认 20" }
            }),
            &["keyword"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let keyword = args
            .get("keyword")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if keyword.is_empty() {
            return Err(ToolError::InvalidArgs("query_graph 缺少 keyword 参数".into()));
        }
        let kind = args.get("kind").and_then(|v| v.as_str()).and_then(parse_node_kind);
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20) as usize;

        let workspace = ctx.workspace.as_ref().and_then(|p| p.to_str());
        let graph = KnowledgeGraph::open(workspace)
            .map_err(|e| ToolError::ExecutionFailed(format!("打开实体图失败：{e}")))?;

        let nodes = graph.search(&keyword, kind, limit);
        let mut out: Vec<Value> = Vec::new();
        for n in nodes {
            out.push(json!({
                "id": n.id,
                "kind": serde_json::to_value(n.kind).unwrap_or(Value::Null),
                "title": n.props.get("title").and_then(|v| v.as_str()),
                "status": n.props.get("status").and_then(|v| v.as_str()),
                "path": n.props.get("path").and_then(|v| v.as_str()),
                "step": n.props.get("step").and_then(|v| v.as_u64()),
                "description": n.props.get("description").and_then(|v| v.as_str()),
            }));
        }
        serde_json::to_string(&out)
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))
    }
}


#[async_trait]
impl AgentTool for AskUserChoiceTool {
    fn name(&self) -> String {
        "native__ask_user_choice".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__ask_user_choice",
            "当需要用户在多个合理方案间做选择时调用（而非开放文本追问）。给出 2–5 个明确选项，用户点选后其结果（选中项文案/值）会作为本工具结果返回，供你据此续写。适用于：多分支路径决策、范围/格式确认、取舍对比。弹窗同时提供「其他 / 自定义」自由文本入口——若预设选项都不合适，用户可直接填写自己的方案，回传文案以「用户选择了（自定义）：<文本>」形式带回。不要用于危险动作授权（那走审批弹窗）。",
            json!({
                "question": { "type": "string", "description": "向用户提出的问题" },
                "options": {
                    "type": "array",
                    "description": "可选项列表（2–5 个）",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "选项唯一 id（前端回传时用）" },
                            "label": { "type": "string", "description": "展示文案" },
                            "description": { "type": "string", "description": "补充说明（可选）" },
                            "value": { "type": "string", "description": "机器语义值（可选，如具体路径/模型名；回传时一并带回）" }
                        },
                        "required": ["id", "label"]
                    }
                }
            }),
            &["question", "options"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let question = args
            .get("question")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("ask_user_choice 缺少 question 参数".into()))?
            .to_string();
        let options = args
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ToolError::InvalidArgs("ask_user_choice 缺少 options 参数".into()))?;
        if options.len() < 2 {
            return Err(ToolError::InvalidArgs(
                "ask_user_choice 的 options 至少需要 2 项".into(),
            ));
        }
        let mut opts = Vec::with_capacity(options.len());
        for (i, o) in options.iter().enumerate() {
            let id = o
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(&format!("opt_{i}"))
                .to_string();
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if label.trim().is_empty() {
                return Err(ToolError::InvalidArgs(format!(
                    "ask_user_choice 第 {i} 项缺少 label"
                )));
            }
            let description = o
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let value = o.get("value").and_then(|v| v.as_str()).map(|s| s.to_string());
            opts.push(ChoiceOption {
                id,
                label,
                description,
                value,
            });
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let choice_id = format!("choice-{}-{}", ctx.agent_id, nanos);
        let req = ChoiceRequest {
            choice_id: choice_id.clone(),
            question,
            options: opts,
        };
        // 任务已完成后的「推荐」不弹阻塞弹窗：把建议作为工具结果回传，由模型写入最终回复。
        // 判定：会话计划步骤中至少已有一步闭环（任务已推进），且最多只有「最后一步」仍开口，
        // 说明主体工作已完成，此询问只是收尾推荐——不应再以弹窗打断用户（符合「推荐追加到最终回复」设定）。
        if let (Some(ws), Some(sid)) = (
            ctx.workspace.as_ref().and_then(|p| p.to_str()),
            ctx.session_id.as_deref(),
        ) {
            if let Ok(g) = KnowledgeGraph::open(Some(ws)) {
                if is_post_completion_recommendation(&g, sid) {
                    let opts_text = req
                        .options
                        .iter()
                        .enumerate()
                        .map(|(i, o)| format!("{}. {}", i + 1, o.label))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let rec = format!(
                        "（任务主体已完成，以下后续方向为可选建议，已记入最终回复，无需通过弹窗选择）\n\n{}\n{}",
                        req.question, opts_text
                    );
                    tracing::info!(
                        "[agent] ask_user_choice: 任务已完成，按「推荐」非阻塞处理（不弹窗），建议已回传模型写入最终回复"
                    );
                    return Ok(rec);
                }
            }
        }
        events::emit_choice_needed(&self.app, &req);
        // 20260919002 per-agent：经工具上下文的 agent_id 路由到本任务的状态束（choice 中枢随 agent 走）。
        let task_state = self
            .app
            .state::<crate::agent::engine::runtime::AgentRuntime>()
            .task_state(&ctx.agent_id)
            .ok_or_else(|| ToolError::ExecutionFailed("任务状态已失效（任务可能已被回收）".into()))?;
        let rx = task_state.choice.suspend(req).await;
        let outcome = match timeout(Duration::from_secs(CHOICE_TIMEOUT_SECS), rx).await {
            Ok(Ok(o)) => o,
            Ok(Err(_)) => {
                // 通道关闭（停止触发 drop Sender）：回灌「已取消」，避免循环挂死。
                task_state.choice.cancel(&choice_id).await;
                return Ok("（用户已取消选择）".into());
            }
            Err(_) => {
                // 超时：清理挂起项后回灌「未收到选择」。
                task_state.choice.cancel(&choice_id).await;
                return Ok("（用户选择超时，未收到选择）".into());
            }
        };
        let text = if let Some(custom) = outcome.custom_text {
            // 用户走「其他 / 自定义」自由文本入口：以自定义文案回传。
            format!("用户选择了（自定义）：{}", custom)
        } else {
            match outcome.value {
                Some(v) => format!("用户选择了：{}（值：{}）", outcome.label, v),
                None => format!("用户选择了：{}", outcome.label),
            }
        };
        Ok(text)
    }
}


#[async_trait]
impl AgentTool for AnchorMemoryTool {
    fn name(&self) -> String {
        "native__anchor_memory".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("memory"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__anchor_memory",
            "将对话中确认的可跨会话复用的稳定信息沉淀为长期记忆，使未来会话能自动召回：① 用户明确表达的偏好；② 已确认的技术决策/架构约定；③ 踩过的坑与规避方式；④ 可复用代码模式。按 (agent_id, key) 去重，重复调用只更新内容，可放心沉淀。请勿锚定一次性任务步骤、临时草稿或当轮琐碎状态。",
            json!({
                "key": { "type": "string", "description": "记忆关键词/标题（同 (agent_id, key) 重复调用会更新既有记忆内容）" },
                "content": { "type": "string", "description": "记忆正文（具体约定、决策背景、适用场景与规避方式）" },
                "category": { "type": "string", "description": "分类：decision(决策) / code_pattern(代码模式) / user_pref(用户偏好) / architecture(架构) / fix(避坑) / other(其他)，缺省 other" }
            }),
            &["key", "content"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let key = args
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("anchor_memory 缺少 key 参数".into()))?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if content.trim().is_empty() {
            return Err(ToolError::InvalidArgs("anchor_memory 的 content 为空".into()));
        }
        let category = args
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("other")
            .to_string();
        match crate::agent::knowledge::memory::anchor_memory(
            &self.app,
            if ctx.agent_id.is_empty() {
                None
            } else {
                Some(&ctx.agent_id)
            },
            ctx.session_id.as_deref(),
            key,
            &content,
            &category,
            false,
            // native 工具属自动路径，走质量护栏（去噪合并 + category 强校验）。
            true,
        )
        .await
        {
            Ok(item) => Ok(format!(
                "已沉淀记忆（key={}，分类={}，引用数={}）",
                item.key, item.category, item.ref_count
            )),
            Err(e) => Err(ToolError::ExecutionFailed(format!("锚定记忆失败：{e}"))),
        }
    }
}


#[async_trait]
impl AgentTool for ArchiveArtifactTool {
    fn name(&self) -> String {
        "native__archive_artifact".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__archive_artifact",
            "将本次任务沉淀的核心设计/架构约定/避坑法则归档为 Markdown 到 .wd_mem/artifacts/（长期知识资产，随工程留存）。需用户审批。目标路径由工具按 name 自动生成并已内置目录冲突校验，无需调用 native__path_exists。",
            json!({
                "name": { "type": "string", "description": "归档文件名（kebab-case，可带或不带 .md 后缀，如 auth-flow 或 auth-flow.md）" },
                "content": { "type": "string", "description": "Markdown 正文（设计蓝图/约定摘要）" }
            }),
            &["name", "content"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let name = args.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("archive_artifact 缺少 name 参数".into())
        })?;
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
        // 无绑定工作空间（全局沙箱旁路）：无法落盘 .wd_mem，直接拒绝。
        if ctx.workspace.is_none() {
            return Err(ToolError::ExecutionFailed(
                "当前无绑定工作空间，无法归档到 .wd_mem/artifacts/（全局闲聊模式不落地项目文件）".into(),
            ));
        }
        // 规范化文件名：去非法字符、确保 .md 后缀。
        let cleaned: String = name
            .chars()
            .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
            .collect();
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            return Err(ToolError::InvalidArgs("archive_artifact 的 name 为空或非法".into()));
        }
        let file_name = if cleaned.to_lowercase().ends_with(".md") {
            cleaned.to_string()
        } else {
            format!("{}.md", cleaned)
        };
        let rel = format!(".wd_mem/artifacts/{}", file_name);
        let abs = match PathGuard::check(&rel, ctx) {
            Ok(abs) => abs,
            Err(e) => {
                tracing::info!(
                    "[agent] native__archive_artifact: 路径校验失败 rel={} error={:?}",
                    rel, e
                );
                return Err(e);
            }
        };
        // 闭环前置检查（统一复用 probe_path）：防御目标已存在且为目录的极端情况
        // （正常 name 已剔除路径分隔符不会触发），落实「写前验存在/类型」。
        let probe = probe_path(&abs);
        if probe.exists && probe.is_dir {
            tracing::info!("[agent] native__archive_artifact: 目标已是目录 rel={}", rel);
            return Err(ToolError::ExecutionFailed(format!(
                "目标已是目录：{}（无法作为文件写入，请更换 name）",
                abs.display()
            )));
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
        }
        tracing::info!(
            "[agent] native__archive_artifact: 开始 rel={} resolved={} content_bytes={}",
            rel,
            abs.display(),
            content.len()
        );
        let started = Instant::now();
        // 问题 3 修复：打开时不截断（truncate(false)），待 TOCTOU 校验通过后再 set_len(0) 清空；
        // 校验失败时原归档文件内容完好可恢复。
        let mut file = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&abs)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__archive_artifact: 失败 rel={} 耗时={}ms error={}",
                    rel,
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("创建归档文件失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__archive_artifact: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        if let Err(e) = file.set_len(0) {
            tracing::info!(
                "[agent] native__archive_artifact: 清空失败 rel={} 耗时={}ms error={}",
                rel,
                started.elapsed().as_millis(),
                e
            );
            return Err(ToolError::ExecutionFailed(format!("清空原归档文件失败：{e}")));
        }
        match file.write_all(content.as_bytes()) {
            Ok(()) => {
                tracing::info!(
                    "[agent] native__archive_artifact: 成功 path={} bytes={} 耗时={}ms",
                    abs.display(),
                    content.len(),
                    started.elapsed().as_millis()
                );
                // #20260918006：归档成功后异步索引进 LanceDB artifacts（分节切块 → embed →
                // upsert；digest 未变跳过）。fire-and-forget，失败仅日志不影响归档结果。
                if let Some(ws) = &ctx.workspace {
                    crate::agent::artifact::artifact_index::spawn_artifact_index_sync(
                        self.app.clone(),
                        ws.to_string_lossy().to_string(),
                        rel.clone(),
                        content.to_string(),
                    );
                }
                Ok(format!(
                    "已归档 {} 字节到 .wd_mem/artifacts/{}",
                    content.len(),
                    file_name
                ))
            }
            Err(e) => Err(ToolError::ExecutionFailed(format!("写入归档失败：{e}"))),
        }
    }
}

