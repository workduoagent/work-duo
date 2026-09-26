//! 上下文 token 估算（台账 S7 / D3 第一步：真计量）。
//!
//! 为什么不做真 tokenizer：本项目多模型并存（DeepSeek / GLM / MiniMax / Anthropic…），
//! 每家 BPE 词表不同，为每家内置 tokenizer 的体积与维护成本不成立。业界通行的
//! 工程近似是**分类加权**：CJK 字符 ≈ 1 token/字、ASCII 词 ≈ 4 chars/token——
//! 把「字符数」的 ±100% 误差收敛到 ±30% 量级，足以驱动压缩/裁剪决策。
//!
//! 取舍纪律：**宁可高估**（1 CJK 字记 1 token；实测主流中文 tokenizer 约 0.6~0.75），
//! 高估让压缩提前触发、裁剪提前收紧——代价是多压几轮；低估则会撑爆上下文窗口。
//!
//! 纯函数零依赖，全部可单测。

/// 单段文本的 token 估算。
/// - CJK（汉字/假名/谚文/全角标点）：1 token/字（保守高估）；
/// - ASCII 字母数字：4 chars/token；
/// - 空白与标点：8 chars/token；
/// - 其余（emoji 等）：2 chars/token。
pub fn estimate_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut alnum = 0u64;
    let mut space_punct = 0u64;
    let mut other = 0u64;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if c.is_ascii_alphanumeric() {
            alnum += 1;
        } else if c.is_whitespace() || c.is_ascii_punctuation() {
            space_punct += 1;
        } else {
            other += 1;
        }
    }
    cjk + alnum.div_ceil(4) + space_punct.div_ceil(8) + other.div_ceil(2)
}

/// CJK 判定：汉字基本/扩展A区、日文假名、谚文、全角形式与 CJK 标点。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F   // CJK 符号与标点（。，、）
        | 0x3040..=0x30FF // 平假名/片假名
        | 0x3400..=0x4DBF // 汉字扩展 A
        | 0x4E00..=0x9FFF // 汉字基本区
        | 0xAC00..=0xD7AF // 谚文
        | 0xF900..=0xFAFF // CJK 兼容表意
        | 0xFF00..=0xFFEF // 全角形式（！＂＃）
    )
}

/// 单条多模态图片的固定 token 估算（visionDetail=auto 低分辨率档，参照 OpenAI vision 定价
/// 取整）。**绝不对 base64 数据按字符估算**——一张几百 KB 的图 base64 按文本算会虚高 5 万+
/// tokens，导致带图首轮立即触发压缩、原始问答退出活跃窗口，后续「这个图/上面说的国家」
/// 指代断链（2026-09-26 用户实锤）。
pub const PER_IMAGE_TOKENS: u64 = 1200;

/// 从 JSON 值中剥出「非 base64 图片」的可计文本：递归收集所有字符串，跳过 image_url 的
/// data URL 载荷（该部分按 PER_IMAGE_TOKENS 计，由调用方单独累加）。
fn collect_text_excluding_images(v: &serde_json::Value, out: &mut String, images: &mut u64) {
    match v {
        serde_json::Value::String(s) => out.push_str(s),
        serde_json::Value::Array(arr) => {
            for item in arr {
                // 多模态图片项：{"type":"image_url","image_url":{"url":"data:...;base64,.."}}
                let is_image = item.get("type").and_then(|t| t.as_str()) == Some("image_url")
                    || item.get("image_url").is_some();
                if is_image {
                    *images += 1;
                } else {
                    collect_text_excluding_images(item, out, images);
                }
            }
        }
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                if k == "image_url" {
                    // 命中图片字段：计一张图，跳过其 url 载荷
                    *images += 1;
                } else if k == "url" && val.as_str().map(|u| u.starts_with("data:image/")).unwrap_or(false) {
                    // 防御：裸 url 字段是 data URL 也按图片计（正常不会走到）
                    *images += 1;
                } else {
                    collect_text_excluding_images(val, out, images);
                }
            }
        }
        serde_json::Value::Null => {}
        other => out.push_str(&other.to_string()),
    }
}

/// 单条 message 的 token 估算：content 主体 + role/结构开销。
/// OpenAI 报文每条约有 4~8 token 的固定结构开销（role/命名/分隔）；
/// tool_calls（含 function.name/arguments JSON）按完整序列化文本估算；
/// 多模态图片按 PER_IMAGE_TOKENS 固定计（base64 载荷不按字符估算）。
pub fn estimate_message_tokens(m: &serde_json::Value) -> u64 {
    const PER_MESSAGE_OVERHEAD: u64 = 8;
    let mut total = PER_MESSAGE_OVERHEAD;
    if let Some(c) = m.get("content") {
        match c {
            serde_json::Value::String(s) => total += estimate_tokens(s),
            serde_json::Value::Null => {}
            serde_json::Value::Array(_) => {
                // 多模态 content 数组：文本部分正常估算，图片按固定值计
                let mut text = String::new();
                let mut images = 0u64;
                collect_text_excluding_images(c, &mut text, &mut images);
                total += estimate_tokens(&text) + images * PER_IMAGE_TOKENS;
            }
            other => total += estimate_tokens(&other.to_string()),
        }
    }
    // tool_calls（assistant 发起的调用）：name + arguments 全文
    if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
        for call in calls {
            total += estimate_tokens(&call.to_string());
        }
    }
    // tool_call_id（role=tool 的回包关联）
    if let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) {
        total += estimate_tokens(id);
    }
    total
}

/// 消息序列总 token 估算（上下文体量决策入口：压缩/裁剪判定用）。
pub fn estimate_messages_tokens(messages: &[serde_json::Value]) -> u64 {
    messages.iter().map(estimate_message_tokens).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pure_chinese_counts_one_token_per_char() {
        // 10 个汉字 ≈ 10 token（保守高估，实测约 7）
        assert_eq!(estimate_tokens("上下文压缩测试十个字"), 10);
    }

    #[test]
    fn pure_ascii_counts_quarter_per_char() {
        // 40 个 ASCII 字母 = 10 token
        assert_eq!(estimate_tokens("abcdefghijabcdefghijabcdefghijabcdefghij"), 10);
    }

    #[test]
    fn empty_string_is_zero() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn mixed_text_sums_classes() {
        // 4 汉字(4) + 8 字母(2) + 1 空格(1) = 7
        assert_eq!(estimate_tokens("四个汉字abcdefgh "), 7);
    }

    #[test]
    fn message_overhead_and_tool_calls_counted() {
        let m = json!({
            "role": "assistant",
            "content": "你好",
            "tool_calls": [{"id": "call_1", "type": "function",
              "function": {"name": "native__read_file", "arguments": "{\"path\":\"a.py\"}"}}]
        });
        let t = estimate_message_tokens(&m);
        // 8 结构 + 2 中文 + tool_calls JSON（>10）——只断言下界，防实现回归
        assert!(t > 20, "实际 {t}");
        let plain = estimate_message_tokens(&json!({"role": "user", "content": "你好"}));
        assert_eq!(plain, 8 + 2);
    }

    #[test]
    fn messages_sum_is_additive() {
        let msgs = vec![
            json!({"role": "user", "content": "第一问"}),
            json!({"role": "assistant", "content": null}),
        ];
        // 第一条 8 结构开销 + 3 CJK；第二条仅 8 结构开销（content=null 不计）
        assert_eq!(estimate_messages_tokens(&msgs), 8 + 3 + 8);
    }

    /// 图片 base64 不按字符估算（2026-09-26 指代断链修复）：一张大图按固定
    /// PER_IMAGE_TOKENS 计，文本部分正常估算——防止带图轮 token 虚高触发过早压缩。
    #[test]
    fn multimodal_image_counts_fixed_not_by_base64_length() {
        let big_base64 = "A".repeat(400_000);
        let m = json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "识别图中国家"},
                {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{big_base64}")}}
            ]
        });
        let t = estimate_message_tokens(&m);
        // 8 结构 + 6 CJK + content 数组键名("type" 4 ASCII=1) + 固定 1200；
        // 绝不允许 400KB base64 按文本涨进去（>10_000 即回归）
        assert_eq!(t, 8 + 6 + 1 + PER_IMAGE_TOKENS, "实际 {t}");
        assert!(t < 10_000);
    }
}
