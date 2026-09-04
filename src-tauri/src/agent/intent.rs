//! 阶段一：意图分流链（Intent Classifier）。
//!
//! 纯文本轻量推理，**绝对不挂载任何 Tool**（防止模型产生调用幻觉），要求极速响应。
//! 产出 `IntentProfile`：`SIMPLE_CHAT`（直接单次流式输出）或 `COMPOSITE_TASK`（进规划链）。
//!
//! 为省一次 LLM 调用，先做**规则短路**：明显的闲聊/明显的复杂信号直接判定，
//! 只有灰色地带才走 LLM 分类；分类失败一律降级为 COMPOSITE_TASK（宁可多规划，不可漏拆解）。

use serde_json::json;
use serde_json::Value;

use crate::agent::runtime;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::IntentProfile;

/// 复杂任务信号关键词（中英对照，命中任一即倾向 COMPOSITE_TASK）。
const COMPOSITE_HINTS: &[&str] = &[
    "文件", "代码", "脚本", "python", "数据", "抓取", "采集", "下载", "生成", "读取", "写入",
    "excel", "csv", "json", "报表", "预测", "分析", "安装", "检查", "报错", "修复", "bug",
    "运行", "执行", "整理", "爬", "截图", "建模", "仿真", "file", "code", "script", "data",
    "fetch", "download", "generate", "predict", "analy", "install", "error", "fix",
];

/// 意图分类入口：规则短路优先，灰色地带走 LLM 轻量分类。
pub async fn classify_intent(cfg: &AgentRuntimeConfig, prompt: &str) -> IntentProfile {
    let trimmed = prompt.trim();
    let len = trimmed.chars().count();
    let lower = trimmed.to_lowercase();
    let has_hint = COMPOSITE_HINTS.iter().any(|k| lower.contains(&k.to_lowercase()));

    // 短路 1：短消息且无复杂信号 → 明显闲聊，0 成本直接判。
    if len <= 20 && !has_hint {
        println!("[agent] intent: 规则短路 → SIMPLE_CHAT（len={len} 无复杂信号）");
        return IntentProfile {
            intent_type: "SIMPLE_CHAT".into(),
            reason: "规则短路：短消息且无复杂关键词".into(),
        };
    }
    // 短路 2：命中复杂信号且描述较长 → 明显复合任务，直接判。
    if has_hint && len >= 30 {
        println!("[agent] intent: 规则短路 → COMPOSITE_TASK（命中复杂关键词）");
        return IntentProfile {
            intent_type: "COMPOSITE_TASK".into(),
            reason: "规则短路：命中复杂任务关键词".into(),
        };
    }

    // 灰色地带 → LLM 轻量分类（非流式、0 工具）。
    let sys = "你是一个意图分类器。评估用户输入的任务复杂度。\
若属于日常打招呼、单一常识问答、简单文本润色，判定为 SIMPLE_CHAT；\
若涉及文件操作、数据抓取、代码执行、环境检查或多步骤业务，判定为 COMPOSITE_TASK。\
只输出一行 JSON，不要任何多余文本：\
{\"intent_type\":\"SIMPLE_CHAT 或 COMPOSITE_TASK\",\"reason\":\"一句话理由\"}";
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": trimmed }),
    ];

    let started = std::time::Instant::now();
    match runtime::call_llm(cfg, &messages, &[]).await {
        Ok((resp, _usage)) => {
            let content = extract_content(&resp);
            match parse_intent_json(&content) {
                Some(p) => {
                    println!(
                        "[agent] intent: LLM 分类 → {}（{}ms）reason={}",
                        p.intent_type,
                        started.elapsed().as_millis(),
                        runtime::clip(&p.reason, 200),
                    );
                    p
                }
                None => {
                    println!(
                        "[agent] intent: 分类结果解析失败，降级 COMPOSITE_TASK content={}",
                        runtime::clip(&content, 300),
                    );
                    fallback("分类结果解析失败")
                }
            }
        }
        Err(e) => {
            println!("[agent] intent: 分类调用失败：{e}，降级 COMPOSITE_TASK");
            fallback("分类调用失败")
        }
    }
}

fn fallback(reason: &str) -> IntentProfile {
    // 宁可多规划（多耗一点 Token），不可把复杂任务误判成闲聊而直接裸答。
    IntentProfile {
        intent_type: "COMPOSITE_TASK".into(),
        reason: reason.into(),
    }
}

/// 从完整 chat.completion JSON 中提取 choices[0].message.content。
fn extract_content(resp: &Value) -> String {
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
