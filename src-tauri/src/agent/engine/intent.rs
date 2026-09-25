//! 阶段一：意图分流链（Intent Classifier）。
//!
//! 纯文本轻量推理，**绝对不挂载任何 Tool**（防止模型产生调用幻觉），要求极速响应。
//! 产出 `IntentProfile`：`SIMPLE_CHAT`（直接单次流式输出）或 `COMPOSITE_TASK`（进规划链）。
//!
//! 为省一次 LLM 调用，先做**规则短路**：明显的闲聊/明显的复杂信号直接判定，
//! 只有灰色地带才走 LLM 分类；分类失败按**信号定向降级**（#20260918010-#1）：
//! 命中强工具信号维持 COMPOSITE_TASK（宁可多规划，不可漏拆解），无强工具信号降级 SIMPLE_CHAT
//! ——Q1 两次实证：无强工具信号的事实问答被一律降级 COMPOSITE 后误走规划+写文件+多轮执行，
//! 单次白烧约 5 万 tokens 并向工作空间写入用户未要求的文件；解析失败先重试一次（空响应瞬态自愈）。

use serde_json::json;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::agent::engine::runtime;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::IntentProfile;

/// 强工具信号关键词（中英对照）：命中即倾向 COMPOSITE_TASK，**直接规则短路**进入规划链，
/// 不再走 LLM 分类——属于「明确要用电脑/工具干活」的语义（文件/脚本/抓取/部署/报错修复等）。
/// 2026-09-24 capability D3-1 实证补扩展名组：短命令「创建 app.txt，内容 v1」不含「文件」二字
/// 但带 .txt 扩展名，曾漏过短路 1（len≤20 无信号→SIMPLE_CHAT）口头完成不落盘。
/// 提扩展名即文件操作意图，误伤面≈0；其余灰区仍由 LLM 分类兜底。
const STRONG_TOOL_HINTS: &[&str] = &[
    "文件", "代码", "脚本", "python", "excel", "csv", "json", "抓取", "采集", "下载", "读取",
    "写入", "安装", "卸载", "格式化", "部署", "删除", "移除", "清空", "爬", "截图", "建模",
    "仿真", "file", "code", "script", "fetch", "download", "install", "uninstall", "format",
    "rm -rf", "报错", "修复", "bug", "error", "fix", "运行", "执行",
    ".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".xlsx", ".xls", ".html", ".css",
    ".yaml", ".yml", ".sh", ".sql", ".toml", ".ini", ".log",
];

/// 弱任务信号关键词（中英对照）：仅表示「生成/分析/整理」等任务**类型**，本身不必然需要工具，
/// **不触发** COMPOSITE 短路——命中后若消息较短仍走 LLM 分类，避免「帮我生成一句祝福」被误判复合任务。
const WEAK_TASK_HINTS: &[&str] = &[
    "数据", "生成", "报表", "预测", "分析", "检查", "整理", "data", "generate", "predict",
    "analy",
];

/// 高风险信号关键词（命中即视为 HIGH 风险，强制走人工审批，哪怕开启自动执行）。
/// 2026-09-18 误伤收窄：原表含「覆盖/改名/移除/删除/格式化/部署/发布/上线」等
/// 高频技术词（子串匹配），「list 被 override 覆盖」「删除重复行」「格式化字符串」
/// 这类正常开发表述全部被误判 HIGH → 敏感工具逐个弹审批卡（实测一次任务弹 13 次）。
/// 现只保留**低误伤、高置信**的破坏性组合词；其余风险交由 LLM 分类与工具级审批兜底。
const RISK_HINTS: &[&str] = &[
    "删除文件", "删除目录", "删除数据库", "删除整个", "格式化磁盘", "格式化硬盘",
    "清空数据库", "清空目录", "清空磁盘", "清空全部", "rm -rf", "drop table",
    "drop database", "truncate table", "reboot", "shutdown", "杀进程", "kill -9",
    "卸载系统", "改密码", "提权", "付款", "转账", "关机",
];

/// 意图分类入口：规则短路优先，灰色地带走 LLM 轻量分类。
pub async fn classify_intent(
    cfg: &AgentRuntimeConfig,
    prompt: &str,
    cancel: Option<&Arc<AtomicBool>>,
) -> IntentProfile {
    let trimmed = prompt.trim();
    let len = trimmed.chars().count();
    let lower = trimmed.to_lowercase();
    // 仅强工具信号触发 COMPOSITE 短路；弱任务信号（生成/分析…）不短路，交 LLM 判断。
    let has_strong = STRONG_TOOL_HINTS.iter().any(|k| lower.contains(&k.to_lowercase()));
    let has_weak = WEAK_TASK_HINTS.iter().any(|k| lower.contains(&k.to_lowercase()));

    // 短路 1：短消息且「强/弱工具信号均无」→ 明显闲聊，0 成本直接判 SIMPLE；
    // 含弱信号但无强工具的短消息（如「帮我分析一下」）仍走 LLM，避免误判闲聊漏掉复合任务。
    if len <= 20 && !has_strong && !has_weak {
        tracing::info!("[agent] intent: 规则短路 → SIMPLE_CHAT（len={len} 无强/弱工具信号）");
        return profile("SIMPLE_CHAT", "规则短路：短消息且无工具关键词", prompt);
    }
    // 短路 2：命中强工具信号且描述较长 → 明显复合任务，直接判。
    if has_strong && len >= 30 {
        tracing::info!("[agent] intent: 规则短路 → COMPOSITE_TASK（命中强工具关键词）");
        return profile("COMPOSITE_TASK", "规则短路：命中强工具任务关键词", prompt);
    }

    // 灰色地带 → LLM 轻量分类（非流式、0 工具）。
    let mut sys = "你是一个意图分类器。评估用户输入的任务复杂度。\
若属于日常打招呼、单一常识问答、简单文本润色，判定为 SIMPLE_CHAT；\
若涉及文件操作、数据抓取、代码执行、环境检查或多步骤业务，判定为 COMPOSITE_TASK。\
同时评估执行策略：requires_planning（是否需拆解规划）、requires_tool（是否需调用工具）、\
risk_level（low/medium/high/critical，涉及删除/安装/执行/改系统/部署等为 high）、requires_approval（是否必须人工审批）、requires_artifact（是否产出文件）。\
只输出一行 JSON，不要任何多余文本：\
{\"intent_type\":\"SIMPLE_CHAT 或 COMPOSITE_TASK\",\"reason\":\"一句话理由\",\
\"requires_planning\":true,\"requires_tool\":true,\"risk_level\":\"medium\",\"requires_approval\":false,\"requires_artifact\":true}"
        .to_string();
    // 20260922 #1：KB 绑定的智能体，纯知识问答走 SIMPLE_CHAT 快路径（简单对话路径已携带
    // native__kb_search，检索后综合即答，无需规划）。含文件写入/命令执行/多步骤的仍判 COMPOSITE。
    if !cfg.kb_ids.is_empty() {
        sys.push_str("\n本智能体已绑定知识库：若任务仅为检索知识库并作答（不含文件写入、代码执行、命令操作或多步骤业务流程），判定为 SIMPLE_CHAT——知识库检索工具在简单对话路径可用，无需规划。");
    }
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": trimmed }),
    ];

    let started = std::time::Instant::now();
    // 解析失败（含空响应）重试一次（#20260918010-#1 ②）：Q1 两次实证 MiniMax-M3 非流式分类
    // 偶发空 content（系统性），空响应/坏 JSON 同属「本次调用无可用信号」，立即重试一次成本极低、
    // 命中率高的瞬态自愈。调用层 Err 不重试：网关级故障立即重试成功率低、徒增延迟（4xx 类按
    // 20260918001B 修A原则本就不重试），双重失败后走信号定向降级。
    let mut parsed: Option<IntentProfile> = None;
    for attempt in 1..=2 {
        match runtime::call_llm(cfg, &messages, &[], cancel).await {
            Ok((resp, _usage)) => {
                let content = extract_content(&resp);
                match parse_intent_json(&content) {
                    Some(mut p) => {
                        enrich(&mut p, prompt);
                        tracing::info!(
                            "[agent] intent: LLM 分类 → {}（第{attempt}次尝试，{}ms）reason={} risk={} approval={}",
                            p.intent_type,
                            started.elapsed().as_millis(),
                            runtime::clip(&p.reason, 200),
                            p.risk_level,
                            p.requires_approval,
                        );
                        parsed = Some(p);
                        break;
                    }
                    None => {
                        tracing::warn!(
                            "[agent] intent: 第{attempt}次分类结果解析失败 content={}",
                            runtime::clip(&content, 300),
                        );
                    }
                }
            }
            Err(e) => {
                tracing::warn!("[agent] intent: 第{attempt}次分类调用失败：{e}");
                break;
            }
        }
    }
    match parsed {
        Some(p) => p,
        None => fallback("分类结果解析失败", prompt),
    }
}

/// 规则短路 / 降级时直接构造一份「执行策略」一致的意图档案：
/// - SIMPLE_CHAT：无需规划、无需工具、低风险、无需审批、无产物；
/// - COMPOSITE_TASK：需规划、需工具、中等风险（命中高风险信号则 high）、命中高风险强制审批、需产物。
fn profile(intent_type: &str, reason: &str, prompt: &str) -> IntentProfile {
    let simple = intent_type.eq_ignore_ascii_case("SIMPLE_CHAT");
    let high = has_risk_hint(prompt);
    let risk = if simple {
        "low"
    } else if high {
        "high"
    } else {
        "medium"
    };
    IntentProfile {
        intent_type: if simple { "SIMPLE_CHAT" } else { "COMPOSITE_TASK" }.into(),
        reason: reason.into(),
        requires_planning: !simple,
        requires_tool: !simple,
        risk_level: risk.into(),
        requires_approval: !simple && high,
        requires_artifact: !simple,
    }
}

/// LLM 解析结果补全：保证意图与策略自洽（不让 Planner 自己重新判断权限/风险）。
/// - 复合任务强制 requires_planning/requires_tool/requires_artifact；
/// - 风险等级缺失时按 prompt 高风险信号推导；
/// - 高风险的任务一律 requires_approval（即便 LLM 未显式要求）。
fn enrich(p: &mut IntentProfile, prompt: &str) {
    if p.is_simple_chat() {
        p.requires_planning = false;
        p.requires_tool = false;
        p.requires_artifact = false;
        if p.risk_level.trim().is_empty() {
            p.risk_level = "low".into();
        }
    } else {
        p.requires_planning = true;
        p.requires_tool = true;
        p.requires_artifact = true;
        if p.risk_level.trim().is_empty() {
            p.risk_level = if has_risk_hint(prompt) {
                "high"
            } else {
                "medium"
            }
            .into();
        }
    }
    p.requires_approval = p.requires_approval || p.is_high_risk();
}

fn has_risk_hint(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    RISK_HINTS.iter().any(|k| lower.contains(&k.to_lowercase()))
}

fn fallback(reason: &str, prompt: &str) -> IntentProfile {
    // 降级方向随信号走，不再一律 COMPOSITE（#20260918010-#1 ①）：
    // - 命中强工具信号（「明确要用电脑/工具干活」语义）→ 维持 COMPOSITE_TASK（宁可多规划，不可漏拆解——
    //   强信号提示词裸答等于让模型臆造工具结果，误导风险更高）；
    // - 无强工具信号（纯问答/闲聊/润色，Q1 实证的事实问答即此类）→ 降级 SIMPLE_CHAT：
    //   误规划的代价（规划+写文件+多轮执行，单次白烧约 5 万 tokens）远大于裸答——会话历史、
    //   记忆与 .wd_mem 片段注入仍可供答，且 0 工具绝无文件写入/命令执行风险。
    // 风险轴安全：SIMPLE=low/0 工具；COMPOSITE 且命中 RISK_HINTS 仍经 profile() 强制 requires_approval。
    let lower = prompt.to_lowercase();
    let has_strong = STRONG_TOOL_HINTS.iter().any(|k| lower.contains(&k.to_lowercase()));
    if has_strong {
        profile("COMPOSITE_TASK", reason, prompt)
    } else {
        profile("SIMPLE_CHAT", reason, prompt)
    }
}

/// 从 `call_llm` 返回的归一化 message 对象中提取 content。
///
/// 重要：`runtime::call_llm` 返回的是 `choices[0].message` 这一层（已在 call_llm 内
/// 将 content 规范化为字符串），**不是**完整响应信封。此前按 `choices[0].message.content`
/// 取导致永远拿到空字符串 → 意图分类 100% 解析失败 → 一律降级 SIMPLE_CHAT → 知识库检索工具
/// 永远无调用机会。这里直接取顶层 `content`，并保留对「完整信封」形态的兼容以防回归。
fn extract_content(resp: &Value) -> String {
    if let Some(s) = resp.get("content").and_then(|c| c.as_str()) {
        return s.to_string();
    }
    resp.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string()
}

/// 剥离可能的 markdown 代码块包裹，截取首个 `{` 到末个 `}` 之间的 JSON 文本。
fn extract_json_str(s: &str) -> &str {
    let t = s.trim();
    match (t.find('{'), t.rfind('}')) {
        (Some(start), Some(end)) if end > start => &t[start..=end],
        _ => t,
    }
}

fn parse_intent_json(s: &str) -> Option<IntentProfile> {
    serde_json::from_str(extract_json_str(s)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 误伤回归（2026-09-18 外部评审链）：正常开发表述不得判 HIGH——
    /// 此前「覆盖/删除/格式化/移除」子串误伤，导致 auto_exec 被强制覆盖、敏感工具逐个弹卡。
    #[test]
    fn risk_hints_not_triggered_by_common_dev_phrases() {
        assert!(!has_risk_hint(
            "list 和标量直接以 override 整体覆盖；断言嵌套 dict 合并正确、list 被 override 覆盖"
        ));
        assert!(!has_risk_hint("删除重复行与空行，清理格式化字符串占位符"));
        assert!(!has_risk_hint("删除 __pycache__ 目录后重跑测试"));
        assert!(!has_risk_hint("发布前先跑 deploy 脚本的 dry-run（不实际上线）"));
        assert!(!has_risk_hint("remove duplicates from the list"));
    }

    /// 真破坏性表述必须命中（强制人工审批的设计语义保留）。
    #[test]
    fn risk_hints_still_catch_destructive_phrases() {
        assert!(has_risk_hint("rm -rf C:\\WorkDuoTest"));
        assert!(has_risk_hint("格式化磁盘后重装系统"));
        assert!(has_risk_hint("drop table users"));
        assert!(has_risk_hint("清空数据库重新导入"));
        assert!(has_risk_hint("删除文件后再重建"));
        assert!(has_risk_hint("帮我重启服务器 reboot"));
    }

    /// 空响应根现象（Q1 两次实证 MiniMax-M3 偶发空 content）：空文本必须解析失败，
    /// 走「重试一次 → 信号定向降级」链路，而非被误当有效分类结果。
    #[test]
    fn empty_content_fails_parse() {
        assert!(parse_intent_json("").is_none());
        assert!(parse_intent_json("   \n ").is_none());
    }

    /// 降级方向随信号走（#1 ①）：无强工具信号的事实问答降级 SIMPLE_CHAT（不再误走规划+写文件），
    /// 命中强工具信号维持 COMPOSITE_TASK（宁可多规划）。
    #[test]
    fn fallback_direction_follows_tool_signals() {
        // Q1 同类事实问答：无强工具关键词 → SIMPLE_CHAT（requires_planning/tool/artifact 全 false）。
        let qa = fallback(
            "分类结果解析失败",
            "根据知识库讲讲统一 LanceDB 的决策记录是什么，为什么否决了 SQLite BLOB 方案",
        );
        assert!(qa.is_simple_chat(), "无强工具信号的事实问答应降级 SIMPLE_CHAT");
        assert!(!qa.requires_planning && !qa.requires_tool && !qa.requires_artifact);

        // 强工具信号提示词：维持 COMPOSITE_TASK（宁可多规划，不可漏拆解）。
        let task = fallback(
            "分类结果解析失败",
            "帮我读取 config.json 并生成报表文件",
        );
        assert!(!task.is_simple_chat(), "命中强工具信号应维持 COMPOSITE_TASK");
        assert!(task.requires_planning && task.requires_tool);
    }
}
