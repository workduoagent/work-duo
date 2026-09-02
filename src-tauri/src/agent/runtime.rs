//! ReAct 运行时调度引擎（对应方案步骤 3）。
//!
//! 职责（单轮任务）：
//!  1. 由 `AgentRuntimeConfig` 组装 system prompt 与 tools（经 `ExtensionHub::assemble_registry`）；
//!  2. 调云端 OpenAI 兼容 LLM（reqwest 直连，base_url 来自模型配置；客户端不做本地重推理）；
//!  3. 解析 `tool_calls`：按 name 派发到注册表工具，敏感工具经 `ApprovalManager` 挂起等审批；
//!  4. 工具结果回填进 messages，循环直至模型输出纯文本（终态）或达最大轮次；
//!  5. 全程经 `events` 推送 `tool_started/finished`、`text_chunk`、`status` 等，驱动前端 UI。
//!
//! 约束：
//!  - Token 滑动窗口裁剪：messages 超长时裁剪早期历史（保留 system + 最近 N 轮）；
//!  - 熔断保护：单轮工具调用次数上限，防模型死循环；
//!  - 客户端一律走云端 API（与项目架构定调一致）。

use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::agent::approval::ApprovalManager;
use crate::agent::approval::ApprovalOutcome;
use crate::agent::events;
use crate::agent::native;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::ApprovalRequest;
use crate::agent::types::ToolStep;

/// 单轮任务最大工具调用次数（熔断）。
const MAX_TOOL_ITERATIONS: usize = 16;
/// 历史消息保留轮次（滑动窗口）。
const MAX_HISTORY_TURNS: usize = 24;

/// 运行时共享状态（托管于 Tauri State，供命令访问）。
#[derive(Clone)]
pub struct AgentRuntime {
    pub approval: Arc<ApprovalManager>,
    pub native: Arc<Mutex<ToolRegistry>>,
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            approval: Arc::new(ApprovalManager::new()),
            native: Arc::new(Mutex::new(ToolRegistry::new())),
        }
    }

    /// 启动一轮任务（被 `run_agent_task` 命令调用，后台 spawn）。
    pub async fn run_task(&self, app: &AppHandle, cfg: AgentRuntimeConfig, prompt: String) {
        // 1) 组装工具注册表（基础原生 + 绑定的 Skill/MCP 工具）
        let mut base = self.native.lock().await.clone();
        native::register_native_tools(&mut base, app);
        // 技能：直接注册进本轮本地注册表（AgentTool 只读包装，真实执行待接入业务核心）
        crate::agent::skill_adapter::register_skills_into(&mut base, cfg.skill_tools.clone());
        // MCP：按 mcp_id 分组，逐 server 注册（复用现有 mcp::call_mcp_tool 透传）
        let mut by_server: std::collections::BTreeMap<String, Vec<crate::agent::mcp_adapter::MountedMcpTool>> =
            Default::default();
        for t in &cfg.mcp_tools {
            by_server.entry(t.mcp_id.clone()).or_default().push(t.clone());
        }
        for (server, tools) in by_server {
            crate::agent::mcp_adapter::register_mcp_into(&mut base, &server, tools);
        }
        // 工具已全部直接注册进 base（原生 + Skill + MCP），base 即完整注册表。
        let registry = base;
        println!(
            "[agent] run_task: 工具注册完成，共 {} 个工具（原生 + Skill + MCP）",
            registry.get_tools_for_llm().len()
        );

        // 2) 工作空间上下文
        let ws = cfg.workspace.as_ref().map(std::path::PathBuf::from);
        let ctx = ToolContext {
            workspace: ws,
            sandbox_enabled: cfg.allow_sandbox,
        };

        // 3) messages 初始化
        let mut messages: Vec<Value> = Vec::new();
        if !cfg.system_prompt.is_empty() {
            messages.push(json!({ "role": "system", "content": cfg.system_prompt }));
        }
        messages.push(json!({ "role": "user", "content": prompt }));

        // 4) ReAct 循环
        let mut iteration = 0;
        loop {
            if iteration >= MAX_TOOL_ITERATIONS {
                events::emit_error(app, "已达最大工具调用次数，任务终止以防死循环");
                break;
            }
            iteration += 1;

            // 裁剪历史（滑动窗口）
            let trimmed = trim_history(&messages);

            // 调用 LLM
            let tools = registry.get_tools_for_llm();
            println!(
                "[agent] run_task: 第 {} 轮，调用 LLM（模型={} 工具数={}）",
                iteration,
                if cfg.llm_model_name.is_empty() {
                    "<无>"
                } else {
                    cfg.llm_model_name.as_str()
                },
                tools.len()
            );
            let choice = match call_llm(&cfg, &trimmed, &tools).await {
                Ok(c) => c,
                Err(e) => {
                    println!("[agent] run_task: LLM 调用失败：{e}");
                    events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                    return;
                }
            };

            let content = choice.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let tool_calls = choice.get("tool_calls").and_then(|v| v.as_array()).cloned();

            // 没有工具调用 → 终态：走真实 SSE 流式输出
            if tool_calls.is_none() || tool_calls.as_ref().map(|t| t.is_empty()).unwrap_or(true) {
                println!(
                    "[agent] run_task: 第 {} 轮无工具调用，走 SSE 流式输出终态文本",
                    iteration
                );
                let full = match call_llm_stream(app, &cfg, &trimmed, &tools).await {
                    Ok(t) => t,
                    Err(e) => {
                        println!("[agent] run_task: LLM 流式调用失败：{e}");
                        events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                        return;
                    }
                };
                messages.push(json!({ "role": "assistant", "content": full }));
                break;
            }

            // 有工具调用：逐条执行
            messages.push(json!({ "role": "assistant", "content": content, "tool_calls": tool_calls }));

            // 把模型在决定调用工具之前的「真实推理/思考」推送给前端，作为思考过程的内容
            // （content 多为模型的规划/分析文本；reasoning 为 DeepSeek 等风格的独立思考字段）。
            // 替换原先硬编码的「正在分析需求…」等步骤口号，让用户看到 LLM 真正的思考。
            if let Some(r) = choice.get("reasoning").and_then(|v| v.as_str()) {
                let r = r.trim();
                if !r.is_empty() {
                    events::emit_status(app, r);
                }
            }
            let content_trim = content.trim();
            if !content_trim.is_empty() {
                events::emit_status(app, content_trim);
            }

            for tc in tool_calls.unwrap() {
                let (call_id, tool_name, args) = match parse_tool_call(&tc) {
                    Some(x) => x,
                    None => {
                        events::emit_error(app, "工具调用格式无法解析，跳过");
                        continue;
                    }
                };

                let tool = match registry.get(&tool_name) {
                    Some(t) => t,
                    None => {
                        events::emit_error(app, &format!("未知工具：{tool_name}"));
                        continue;
                    }
                };

                // 构造步骤快照（running）
                let step_id = call_id.clone();
                let sensitive = tool.check_permission(&args) == PermissionLevel::RequireApproval;
                let started = ToolStep {
                    call_id: step_id.clone(),
                    tool_name: tool_name.clone(),
                    status: "running".into(),
                    sensitive,
                    args: Some(serde_json::to_string(&args).unwrap_or_default()),
                    result: None,
                    duration_ms: None,
                    created_at: now_ms(),
                };
                events::emit_tool_started(app, &started);

                // 敏感工具：审批挂起（auto_tool_exec_mode 时跳过逐次确认）
                if sensitive && !cfg.auto_tool_exec_mode {
                    let approval_id = format!("ap-{}-{}", cfg.agent_id, step_id);
                    let req = ApprovalRequest {
                        approval_id: approval_id.clone(),
                        tool_name: tool_name.clone(),
                        description: format!("智能体请求执行敏感操作：{}", tool_name),
                        args: serde_json::to_string(&args).unwrap_or_default(),
                        kind: detect_kind(&tool_name, &args),
                        hint: Some("请在弹窗中允许或拒绝（拒绝可填写原因引导纠偏）".into()),
                    };
                    events::emit_awaiting_approval(app, &req);
                    let rx = self.approval.suspend(req).await;
                    let outcome: ApprovalOutcome = match rx.await {
                        Ok(o) => o,
                        Err(_) => {
                            // 通道关闭（前端未响应 / 超时）：默认拒绝
                            self.approval.cancel(&approval_id).await;
                            ApprovalOutcome {
                                approved: false,
                                reason: Some("审批超时，已自动拒绝".into()),
                            }
                        }
                    };
                    if !outcome.approved {
                        let reason = outcome.reason.unwrap_or_else(|| "用户拒绝".into());
                        let finished = ToolStep {
                            call_id: step_id.clone(),
                            tool_name: tool_name.clone(),
                            status: "failed".into(),
                            sensitive,
                            args: Some(serde_json::to_string(&args).unwrap_or_default()),
                            result: Some(format!("已拒绝：{reason}")),
                            duration_ms: None,
                            created_at: now_ms(),
                        };
                        events::emit_tool_finished(app, &finished);
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": format!("用户拒绝执行：{reason}")
                        }));
                        continue;
                    }
                }

                // 执行工具
                let t0 = Instant::now();
                let result = tool.execute(args.clone(), &ctx).await;
                let (status, result_text) = match &result {
                    Ok(s) => ("success".into(), s.clone()),
                    Err(ToolError::InvalidArgs(m))
                    | Err(ToolError::ExecutionFailed(m))
                    | Err(ToolError::PermissionDenied(m)) => ("failed".into(), m.clone()),
                };
                let finished = ToolStep {
                    call_id: step_id.clone(),
                    tool_name: tool_name.clone(),
                    status,
                    sensitive,
                    args: Some(serde_json::to_string(&args).unwrap_or_default()),
                    result: Some(result_text.clone()),
                    duration_ms: Some(t0.elapsed().as_millis() as u64),
                    created_at: now_ms(),
                };
                events::emit_tool_finished(app, &finished);
                println!(
                    "[agent] run_task: 工具 {tool_name} 执行完成 ok={} 耗时 {}ms",
                    result.is_ok(),
                    t0.elapsed().as_millis()
                );
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": result_text
                }));
            }
        }

        events::emit_task_done(app);
    }
}

/* ----------------------------- LLM 调用 ----------------------------- */

async fn call_llm(
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
) -> Result<Value, String> {
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }

    println!(
        "[agent] call_llm: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let client = reqwest::Client::new();
    let url = normalize_chat_url(&cfg.llm_base_url);

    let mut body = json!({
        "model": cfg.llm_model_name,
        "messages": messages,
        "stream": false,
    });
    // 注入智能体私有参数副本（temperature / max_tokens ...）
    if let Some(obj) = cfg.llm_config.as_object() {
        for (k, v) in obj {
            if k != "model" && k != "messages" && k != "stream" {
                body[k] = v.clone();
            }
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    // 兼容多后端网关（如 gmi-serving）：部分网关的 OpenAI Chat 模型要求
    // `reasoning` 为字典而非布尔。用户在前端把 reasoning 配成 true/false 时，
    // 这里归一化为网关可接受的形态（true→{} 开启默认推理；false→移除该字段）。
    if let Some(obj) = body.as_object_mut() {
        let action = match obj.get("reasoning") {
            Some(v) if v.is_boolean() => Some(v.as_bool() == Some(true)),
            _ => None,
        };
        if let Some(enabled) = action {
            if enabled {
                obj.insert("reasoning".into(), json!({}));
                println!("[agent] call_llm: reasoning=true 归一化为 {{}}（网关要求字典）");
            } else {
                obj.remove("reasoning");
                println!("[agent] call_llm: reasoning=false 已移除");
            }
        }
    }

    let body_json = serde_json::to_string(&body).unwrap_or_default();
    println!("[agent] call_llm: 请求体 =\n{body_json}");

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }

    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // 完整输出错误体（不再截断），便于定位校验失败的具体字段
        println!("[agent] call_llm: HTTP {status} 错误体 =\n{text}");
        return Err(format!("HTTP {status}：{text}"));
    }
    let data: Value = resp.json().await.map_err(|e| format!("响应解析失败：{e}"))?;
    data.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or_else(|| "LLM 响应缺少 choices[0].message".into())
}

/// 流式调用 LLM（SSE），逐 token 推送给前端并返回完整文本。
///
/// 用于终态文本输出，让前端感受到真实打字机效果；工具判断仍走非流式 `call_llm`。
async fn call_llm_stream(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
) -> Result<String, String> {
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }

    println!(
        "[agent] call_llm_stream: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let client = reqwest::Client::new();
    let url = normalize_chat_url(&cfg.llm_base_url);

    let mut body = json!({
        "model": cfg.llm_model_name,
        "messages": messages,
        "stream": true,
    });
    // 注入智能体私有参数副本
    if let Some(obj) = cfg.llm_config.as_object() {
        for (k, v) in obj {
            if k != "model" && k != "messages" && k != "stream" {
                body[k] = v.clone();
            }
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    // reasoning 归一化（同 call_llm）
    if let Some(obj) = body.as_object_mut() {
        let action = match obj.get("reasoning") {
            Some(v) if v.is_boolean() => Some(v.as_bool() == Some(true)),
            _ => None,
        };
        if let Some(enabled) = action {
            if enabled {
                obj.insert("reasoning".into(), json!({}));
                println!("[agent] call_llm_stream: reasoning=true 归一化为 {{}}");
            } else {
                obj.remove("reasoning");
                println!("[agent] call_llm_stream: reasoning=false 已移除");
            }
        }
    }

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }
    // 部分网关需要显式声明 Accept: text/event-stream
    req = req.header("Accept", "text/event-stream");

    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        println!("[agent] call_llm_stream: HTTP {status} 错误体 =\n{text}");
        return Err(format!("HTTP {status}：{text}"));
    }

    // 跨 chunk 字节缓冲：SSE 的 `data:` 行可能被 TCP 分片切到不同 chunk，
    // 旧逻辑按 chunk 直接 lines() 会把半截 JSON 拿去解析 → "EOF while parsing" 报错。
    // 这里累积原始字节，仅处理以 `\n` 结尾的完整行；多字节 UTF-8 字符也只在整行
    // 转换时解析，避免被分片截断成乱码（如中文 content 被切坏）。
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("流读取失败：{e}"))?;
        buf.extend_from_slice(&chunk);
        // 处理缓冲区中所有以 \n 结尾的完整行
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let mut line_bytes = buf[..pos].to_vec();
            buf.drain(..=pos); // 移除该行及换行符
            if line_bytes.last() == Some(&b'\r') {
                line_bytes.pop(); // 去掉可能的 \r
            }
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data == "[DONE]" {
                continue;
            }
            match serde_json::from_str::<Value>(data) {
                Ok(json) => {
                    if let Some(content) = extract_delta_content(&json) {
                        if !content.is_empty() {
                            full.push_str(content);
                            events::emit_text_chunk(app, content, false);
                        }
                    }
                }
                Err(e) => {
                    // 整行已缓冲完整，正常不应再出现半截 JSON；若仍出现仅记录，不中断流。
                    println!("[agent] call_llm_stream: SSE JSON 解析失败：{e}，data={data}");
                }
            }
        }
    }
    // 处理流结束时缓冲区残留的尾行（极少数服务端不以换行结尾）
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if line.starts_with("data:") {
            let data = line.trim_start_matches("data:").trim();
            if data != "[DONE]" {
                if let Ok(json) = serde_json::from_str::<Value>(data) {
                    if let Some(content) = extract_delta_content(&json) {
                        if !content.is_empty() {
                            full.push_str(content);
                            events::emit_text_chunk(app, content, false);
                        }
                    }
                }
            }
        }
    }
    events::emit_text_chunk(app, "", true);
    Ok(full)
}

/// 把 base_url 规整为 `/chat/completions` 端点（兼容用户填 `/v1` 或完整地址）。
fn normalize_chat_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else if trimmed.ends_with("/v1/") {
        format!("{trimmed}chat/completions")
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/* ----------------------------- 工具辅助 ----------------------------- */

/// 从 SSE `chat.completion.chunk` 的 JSON 中提取 `choices[0].delta.content` 文本。
fn extract_delta_content(json: &Value) -> Option<&str> {
    json.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
}

fn parse_tool_call(tc: &Value) -> Option<(String, String, Value)> {
    let id = tc.get("id").and_then(|v| v.as_str())?.to_string();
    let func = tc.get("function")?;
    let name = func.get("name").and_then(|v| v.as_str())?.to_string();
    let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
    let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
    Some((id, name, args))
}

fn detect_kind(tool_name: &str, args: &Value) -> String {
    if tool_name.contains("edit_file") {
        "edit_file".into()
    } else if tool_name.contains("execute_command") {
        "execute_command".into()
    } else {
        // 把 path/command 等字段透传给前端做友好展示
        let _ = args;
        "other".into()
    }
}

fn trim_history(messages: &[Value]) -> Vec<Value> {
    // 保留 system，裁剪早期 user/assistant/tool 轮次至最近 N 轮
    if messages.len() <= MAX_HISTORY_TURNS * 2 + 1 {
        return messages.to_vec();
    }
    let system = messages.first().cloned();
    let rest = &messages[1..];
    let keep = rest.len().saturating_sub(MAX_HISTORY_TURNS * 2);
    let mut out = Vec::new();
    if let Some(s) = system {
        out.push(s);
    }
    out.extend_from_slice(&rest[keep..]);
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

