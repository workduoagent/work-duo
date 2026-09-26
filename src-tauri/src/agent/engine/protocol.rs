//! 消息协议纯函数（S1 拆分自 runtime.rs，台账 §2.1）。
//!
//! 全部为无 IO 的纯函数：工具调用解析（parse_tool_call）、消息序列自检自愈
//! （sanitize_message_sequence）、历史裁剪（trim_history + token 预算 + 配对安全切点）。
//! 单测随迁（配对安全 5 用例）。

use serde_json::{json, Value};

/// 历史消息保留轮数上限（台账 D3①：主预算已升级为 token（`history_token_budget`），
/// 本常量退化为条数反常保护——估算器对极端重复内容可能低估时的兜底）。
const MAX_HISTORY_TURNS: usize = 24;

/// 工具调用解析结果。
pub(crate) enum ParseOutcome {
    /// 字段缺失（无 id / 无 function / 无 name）：无法回传 ToolResult，直接跳过。
    Skip,
    /// 字段齐全但 `arguments` 不是合法 JSON：把解析错误作为 ToolResult 回传，强制模型自我纠错。
    ParseError {
        call_id: String,
        name: String,
        error: String,
    },
    /// 正常解析。
    Ready {
        call_id: String,
        name: String,
        args: Value,
    },
}

pub(crate) fn parse_tool_call(tc: &Value) -> ParseOutcome {
    let id = match tc.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return ParseOutcome::Skip,
    };
    let func = match tc.get("function") {
        Some(f) => f,
        None => return ParseOutcome::Skip,
    };
    let name = match func.get("name").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return ParseOutcome::Skip,
    };
    let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
    match serde_json::from_str::<Value>(args_str) {
        Ok(args) => ParseOutcome::Ready {
            call_id: id,
            name,
            args,
        },
        Err(e) => ParseOutcome::ParseError {
            call_id: id,
            name,
            error: e.to_string(),
        },
    }
}
/// 裁剪历史（滑动窗口）：保留 system + 最近若干条消息。
///
/// **关键不变量**：绝不允许切开 `tool_calls ↔ tool result` 的配对。
/// 一旦被保留的 assistant(tool_calls) 丢失了它的任一 tool 结果（或保留了
/// tool 结果却丢掉发出它的 assistant），网关会直接拒绝整个请求：
/// `invalid params, tool result's tool id(...) not found`（HTTP 400 / code 2013）。
/// 因此切点必须从"按条数算出的理想位置"逐条向前（更早）推进，
/// 直到落在一个配对安全的边界上——宁可多丢一点历史，也不能产生半截配对。
/// 消息序列自检 + 自愈：确保发给 LLM（以及落库）的 messages 满足工具配对不变量。
///
/// 覆盖：
/// - I2：每个含 `tool_calls` 的 assistant，其**全部** `tool_call.id` 都必须有对应 tool 结果；
/// - I3：每条 tool 消息的 `tool_call_id` 必须能追溯到发起它的 assistant（否则为孤儿，直接丢弃）；
/// - I5：序列末尾不得是悬空的 assistant(tool_calls)。
///
/// 为什么必须在发送前做：并行工具调用会产生「1 条 assistant + N 条 tool 结果」，
/// 只要其中任意一条结果缺失（被裁剪切掉、工具被跳过、任务取消、熔断 break），
/// 网关就会拒绝整个请求：
/// `invalid params, tool result's tool id(...) not found`（HTTP 400 / code 2013）。
/// 补一条占位结果远优于让整个任务崩溃——模型读到占位后会自行改道，而不是反复重试。
pub(crate) fn sanitize_message_sequence(messages: &mut Vec<Value>) {
    // ① 收集每个 assistant 声明的 tool_call id
    let mut declared: Vec<(usize, Vec<String>)> = Vec::new();
    let mut all_declared: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (i, m) in messages.iter().enumerate() {
        if m.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
            let ids: Vec<String> = calls
                .iter()
                .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            for id in &ids {
                all_declared.insert(id.clone());
            }
            if !ids.is_empty() {
                declared.push((i, ids));
            }
        }
    }

    // ② 已存在结果的 tool_call_id
    let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in messages.iter() {
        if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
            if let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) {
                answered.insert(id.to_string());
            }
        }
    }

    // ③ 为缺失结果的 tool_call 补占位（紧随其 assistant 之后）
    let mut patches: Vec<(usize, Value)> = Vec::new();
    for (ai, ids) in &declared {
        let mut offset = 1usize;
        for id in ids {
            if !answered.contains(id) {
                patches.push((
                    ai + offset,
                    json!({
                        "role": "tool",
                        "tool_call_id": id,
                        "content": "[Tool result missing] This tool call has no recorded result \
(it may have been interrupted, cancelled, or dropped while trimming history). \
Do NOT blindly retry the same call — re-evaluate your plan and either try a different \
approach or report the situation to the user."
                    }),
                ));
                offset += 1;
            }
        }
    }
    // 倒序插入，避免下标偏移
    patches.sort_by(|a, b| b.0.cmp(&a.0));
    let patched = patches.len();
    for (pos, msg) in patches {
        let at = pos.min(messages.len());
        messages.insert(at, msg);
    }
    if patched > 0 {
        tracing::info!(
            "[agent] sanitize_message_sequence: 补齐 {} 条缺失的 tool 结果占位（防止 tool_call 悬空触发 HTTP 400）",
            patched
        );
    }

    // ④ 丢弃孤儿 tool 消息（找不到发起它的 assistant）
    let before = messages.len();
    messages.retain(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return true;
        }
        match m.get("tool_call_id").and_then(|v| v.as_str()) {
            Some(id) => all_declared.contains(id),
            None => false, // 连 id 都没有的 tool 消息必然是脏数据
        }
    });
    let dropped = before - messages.len();
    if dropped > 0 {
        tracing::info!(
            "[agent] sanitize_message_sequence: 丢弃 {} 条孤儿 tool 结果（其发起者 assistant 已不在上下文中）",
            dropped
        );
    }
}

/// 历史裁剪 token 预算（台账 D3①）：env `WD_HISTORY_TOKEN_BUDGET` 可调，默认 80_000，
/// 下限 4_000。S7 的分类加权估算器计量——「巨型轮（多工具调用 / 长产物）2~3 条顶过去
/// 48 条」时条数预算失真，token 预算才真实反映窗口占用。
fn history_token_budget() -> u64 {
    const DEFAULT: u64 = 80_000;
    const FLOOR: u64 = 4_000;
    match std::env::var("WD_HISTORY_TOKEN_BUDGET") {
        Ok(v) => v
            .parse::<u64>()
            .map(|n| n.max(FLOOR))
            .unwrap_or(DEFAULT),
        Err(_) => DEFAULT,
    }
}

pub(crate) fn trim_history(messages: &[Value]) -> Vec<Value> {
    let max_entries = MAX_HISTORY_TURNS * 2; // 条数上限保留为反常保护（估算器低估兜底）
    if messages.len() <= 1 {
        return messages.to_vec();
    }
    let system = messages.first().cloned();
    let rest = &messages[1..];

    // 台账 D3①：token 预算优先——从尾部向前累计，找「累计 ≤ 预算」的最大保留窗口；
    // 条数上限（MAX_HISTORY_TURNS*2）退化为反常保护。配对安全推进与兜底逻辑不变。
    let per_msg_tokens: Vec<u64> = rest
        .iter()
        .map(crate::agent::engine::token_estimate::estimate_message_tokens)
        .collect();
    let total: u64 = per_msg_tokens.iter().sum();
    let token_budget = history_token_budget();
    let mut start = if total <= token_budget && rest.len() <= max_entries {
        0
    } else {
        let mut acc: u64 = 0;
        let mut s = rest.len();
        while s > 0 {
            let t = per_msg_tokens[s - 1];
            // 尾部第一条无论多大都收下（最后一条 user 必须保留）；此后超预算即停。
            if acc + t > token_budget && s < rest.len() {
                break;
            }
            acc += t;
            s -= 1;
            if rest.len() - s >= max_entries {
                break; // 条数反常保护：估算器对极端内容可能低估
            }
        }
        s
    };
    tracing::info!(
        "[agent] trim_history: {} 条 / 约 {} tokens → 预算 {} tokens × {} 条上限，保留自第 {} 条起",
        rest.len(),
        total,
        token_budget,
        max_entries,
        start + 1
    );

    // 理想起点（token/条数预算），随后向前推进直到配对安全
    while start < rest.len() {
        if is_safe_start(rest, start) && !has_orphan_tool_result(&rest[start..]) {
            break;
        }
        start += 1;
    }
    // 兜底：极端情况下所有候选切点都不安全（例如历史几乎全是被打断的破碎配对），
    // 绝不能退化成「只剩 system、一条 user/tool 都不剩」——那会让本次调用失去用户输入。
    // 此时回退到「最后一条非 tool 消息」作为起点：宁可超出预算，也要保证上下文可用。
    if start >= rest.len() {
        start = rest
            .iter()
            .rposition(|m| m.get("role").and_then(|v| v.as_str()) != Some("tool"))
            .unwrap_or(0);
        tracing::info!(
            "[agent] trim_history: 所有候选切点均不安全，退化保留最后一条非 tool 消息（start={}）",
            start
        );
    }

    let mut out = Vec::new();
    if let Some(s) = system {
        out.push(s);
    }
    out.extend_from_slice(&rest[start..]);
    out
}

/// 切点自身不得破坏配对：
/// ① 切点不能是 tool 结果本身（否则发出它的 assistant 被留在了前一段）；
/// ② 切点若是带 tool_calls 的 assistant，则它**全部** tool_call 的结果都必须落在本段内
///    （并行工具调用时一轮会产生多条 tool 结果，只留一半必然 400）。
fn is_safe_start(rest: &[Value], start: usize) -> bool {
    let Some(first) = rest.get(start) else {
        return true;
    };
    let role = first.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if role == "tool" {
        return false;
    }
    if role == "assistant" {
        if let Some(calls) = first.get("tool_calls").and_then(|v| v.as_array()) {
            for c in calls {
                let Some(id) = c.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let result_in_segment = rest[start + 1..].iter().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("tool")
                        && m.get("tool_call_id").and_then(|v| v.as_str()) == Some(id)
                });
                if !result_in_segment {
                    return false;
                }
            }
        }
    }
    true
}

/// 段内不得存在"孤儿 tool 结果"：某条 tool 消息的 tool_call_id，
/// 在本段内找不到任何发出它的 assistant。
fn has_orphan_tool_result(seg: &[Value]) -> bool {
    seg.iter().any(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return false;
        }
        let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) else {
            return true;
        };
        !seg.iter().any(|a| {
            a.get("role").and_then(|v| v.as_str()) == Some("assistant")
                && a.get("tool_calls")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .any(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
                    })
                    .unwrap_or(false)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── trim_history token 预算（台账 D3①）──

    fn msg(role: &str, content: &str) -> Value {
        json!({ "role": role, "content": content })
    }

    /// 少量小消息：条数与 token 双达标 → 原样返回。
    #[test]
    fn trim_small_history_passthrough() {
        let msgs = vec![
            msg("system", "sys"),
            msg("user", "q1"),
            msg("assistant", "a1"),
        ];
        assert_eq!(trim_history(&msgs).len(), 3);
    }

    /// 少量巨型消息超 token 预算 → 从尾部保留预算内窗口，头部丢弃。
    /// （3 条各约 60k CJK tokens，预算 80k：只能留下尾部 1 条。）
    #[test]
    fn trim_trims_by_token_budget() {
        let giant = "字".repeat(60_000); // CJK 每字 1 token（保守估算）
        let msgs = vec![
            msg("system", "sys"),
            msg("user", &giant),
            msg("assistant", &giant),
            msg("user", "最新提问"),
        ];
        let out = trim_history(&msgs);
        assert!(out.len() < 4, "应发生 token 裁剪，实际保留 {} 条", out.len());
        // system 永远保留，最后一条 user 永远保留
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out.last().unwrap()["content"], "最新提问");
    }

    /// 大量小消息超条数上限 → 条数反常保护生效（不超 MAX_HISTORY_TURNS*2 条）。
    #[test]
    fn trim_entry_cap_protection() {
        let mut msgs = vec![msg("system", "sys")];
        for i in 0..200 {
            msgs.push(msg(if i % 2 == 0 { "user" } else { "assistant" }, &format!("m{i}")));
        }
        let out = trim_history(&msgs);
        assert!(
            out.len() <= MAX_HISTORY_TURNS * 2 + 1,
            "条数反常保护应生效，实际 {} 条",
            out.len()
        );
        assert_eq!(out.last().unwrap()["content"], "m199");
    }

    /// 尾部单条巨型消息（超过整个预算）也必须保留——绝不能丢用户输入。
    #[test]
    fn trim_keeps_oversized_tail() {
        let giant = "字".repeat(120_000); // 单条即超 80k 预算
        let msgs = vec![
            msg("system", "sys"),
            msg("user", "q1"),
            msg("assistant", "a1"),
            msg("user", &giant),
        ];
        let out = trim_history(&msgs);
        assert_eq!(out.last().unwrap()["role"], "user");
        assert_eq!(out.len() >= 2, true, "system + 尾部巨型 user 至少 2 条");
    }

    /// 配对安全：切点不得落在 assistant(tool_calls) 与其 tool 结果之间。
    #[test]
    fn trim_respects_tool_pairing() {
        let mut msgs = vec![msg("system", "sys")];
        for i in 0..40 {
            msgs.push(msg("user", &format!("q{i}")));
            let mut assistant = json!({ "role": "assistant", "content": null });
            assistant["tool_calls"] = json!([{
                "id": format!("call_{i}"),
                "type": "function",
                "function": { "name": "native__read_file", "arguments": "{}" }
            }]);
            msgs.push(assistant);
            msgs.push(json!({ "role": "tool", "tool_call_id": format!("call_{i}"), "content": "r" }));
        }
        let out = trim_history(&msgs);
        // 首条非 system 消息不得是 tool（孤儿结果）或带 tool_calls 的 assistant
        let first = &out[1];
        assert_ne!(first["role"], "tool", "切点不得产生孤儿 tool 结果");
    }
}

