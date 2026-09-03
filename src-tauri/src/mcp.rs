//! MCP 同步工具命令（Rust 后端执行，避免前端跨域 CORS）。
//!
//! 流程：按 MCP（Model Context Protocol）JSON-RPC 执行
//!   initialize 握手 -> tools/list，解析返回的工具列表。
//! 仅 HTTP / SSE 可在后端直接连通；STDIO 需本地子进程，返回错误提示。
//!
//! 前端通过 `invoke('sync_mcp_tools', { request })` 调用。

use std::collections::HashMap;
use std::time::Instant;

use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSyncRequest {
    endpoint_url: String,
    protocol_type: String,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    auth_type: Option<String>,
    #[serde(default)]
    auth_config: Option<serde_json::Value>,
    /// 请求超时（秒），默认 120
    #[serde(default)]
    timeout_sec: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolOut {
    name: String,
    title: Option<String>,
    description: Option<String>,
    input_schema: Option<serde_json::Value>,
    output_schema: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSyncResponse {
    /// 1 正常 / 2 异常
    status: u8,
    ok: bool,
    error: Option<String>,
    latency_ms: u64,
    tools: Vec<McpToolOut>,
}

const JSON_RPC_HEADERS: &[(&str, &str)] = &[
    ("Content-Type", "application/json"),
    ("Accept", "application/json, text/event-stream"),
];

/// 日志展示 endpoint 时隐藏 query 参数，避免 URL 内 token 泄露。
pub(crate) fn redact_endpoint(endpoint: &str) -> String {
    endpoint
        .split_once('?')
        .map(|(base, _)| format!("{base}?<已隐藏query>"))
        .unwrap_or_else(|| endpoint.to_string())
}

fn fail_resp(start: Instant, error: String) -> McpSyncResponse {
    McpSyncResponse {
        status: 2,
        ok: false,
        error: Some(error),
        latency_ms: start.elapsed().as_millis() as u64,
        tools: Vec::new(),
    }
}

/// 解析 JSON-RPC 响应体：兼容纯 JSON 与 SSE（text/event-stream）。
///
/// Streamable HTTP 服务端在 Accept 含 text/event-stream 时，会以 SSE 形式返回
/// `event: message\ndata: {...}`（data 字段内才是 JSON-RPC 响应）。reqwest 的
/// `.json()` 无法解析 SSE 流，故先取文本再抽取 data 行解析。
fn parse_json_rpc_body(body: &str) -> Result<serde_json::Value, String> {
    let trimmed = body.trim_start();
    // 纯 JSON：直接解析
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return serde_json::from_str::<serde_json::Value>(body)
            .map_err(|e| format!("响应 JSON 解析失败：{e}"));
    }
    // 视为 SSE：抽取所有 data: 行拼接为 JSON（多行 data 以换行连接，符合 SSE 规范）
    let mut buf = String::new();
    for line in body.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("data:") {
            buf.push_str(rest.trim_start());
            buf.push('\n');
        }
    }
    if buf.trim().is_empty() {
        let preview: String = body.chars().take(200).collect();
        return Err(format!("响应体为空或无法识别（非 JSON / 非 SSE），前 200 字符：{preview}"));
    }
    serde_json::from_str::<serde_json::Value>(buf.trim())
        .map_err(|e| format!("SSE data 解析失败：{e}"))
}

/// 发送 MCP `notifications/initialized` 通知（initialize 握手成功后、调用其它方法前）。
/// 部分严格服务端（如 MinerU）会要求此通知，缺失会报 "not initialized"。
/// 通知无 id、不期待结果，best-effort：发送失败也不阻断后续调用。
async fn notify_initialized(
    client: &reqwest::Client,
    url: &str,
    session_id: &Option<String>,
) {
    let started = Instant::now();
    let mut req = client.post(url).json(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    }));
    if let Some(sid) = session_id {
        req = req.header("Mcp-Session-Id", sid.as_str());
    }
    match req.send().await {
        Ok(resp) => println!(
            "[agent] mcp.notify_initialized: HTTP {} 耗时={}ms",
            resp.status(),
            started.elapsed().as_millis()
        ),
        Err(e) => println!(
            "[agent] mcp.notify_initialized: 发送失败（best-effort，继续后续调用）耗时={}ms error={}",
            started.elapsed().as_millis(),
            e
        ),
    }
}

#[tauri::command]
pub async fn sync_mcp_tools(request: McpSyncRequest) -> McpSyncResponse {
    let start = Instant::now();

    if request.protocol_type.eq_ignore_ascii_case("STDIO") {
        return fail_resp(
            start,
            "STDIO 类型需本地进程支持，无法在后端执行同步（请改用 HTTP / SSE）".into(),
        );
    }
    if request.endpoint_url.trim().is_empty() {
        return fail_resp(start, "缺少 endpointUrl（SSE / HTTP 类型必须填写访问地址）".into());
    }

    // 构造基础请求头（用户头与认证头先放，协议必备头在末尾覆盖，避免被误填的
    // Accept 覆盖而触发 406 Not Acceptable）
    let mut header_map = reqwest::header::HeaderMap::new();
    if let Some(map) = &request.headers {
        for (k, v) in map {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }
    }
    // API_KEY：authConfig { key_name, key_value } 注入为请求头
    if request.auth_type.as_deref() == Some("API_KEY") {
        if let Some(obj) = request.auth_config.as_ref().and_then(|v| v.as_object()) {
            if let (Some(kn), Some(kv)) = (
                obj.get("key_name").and_then(|v| v.as_str()),
                obj.get("key_value").and_then(|v| v.as_str()),
            ) {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(kn.as_bytes()),
                    reqwest::header::HeaderValue::from_str(kv),
                ) {
                    header_map.insert(name, val);
                }
            }
        }
    }

    // Streamable HTTP 协议必备头：Content-Type=application/json、Accept 须含
    // text/event-stream。放在最后覆盖用户 headers，防止其 Accept 仅 application/json
    // 触发 406 Not Acceptable（"Client must accept both ..."）。
    for (k, v) in JSON_RPC_HEADERS {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(name, val);
        }
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(request.timeout_sec.unwrap_or(120)))
        .default_headers(header_map)
        .build()
    {
        Ok(c) => c,
        Err(e) => return fail_resp(start, format!("HTTP 客户端初始化失败：{e}")),
    };

    let url = request.endpoint_url.trim().to_string();

    // 1) initialize 握手
    let init_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "work-duo", "version": "1.0.0" }
        }
    });

    let init_res = match client.post(&url).json(&init_body).send().await {
        Ok(r) => r,
        Err(e) => return fail_resp(start, format!("initialize 请求失败：{e}")),
    };

    // 取会话 id，供后续请求携带（Streamable HTTP 协议要求）
    let session_id = init_res
        .headers()
        .get("mcp-session-id")
        .or_else(|| init_res.headers().get("Mcp-Session-Id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if !init_res.status().is_success() {
        let status = init_res.status();
        let text = init_res.text().await.unwrap_or_default();
        let preview: String = text.chars().take(200).collect();
        return fail_resp(start, format!("initialize 失败：HTTP {} {}", status, preview));
    }

    // 1.5) 发送 notifications/initialized（MCP 规范要求；部分严格服务端会要求）
    notify_initialized(&client, &url, &session_id).await;

    // 2) tools/list（携带会话 id）
    let tools_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });

    let mut tools_req = client.post(&url).json(&tools_body);
    if let Some(sid) = &session_id {
        tools_req = tools_req.header("Mcp-Session-Id", sid.as_str());
    }

    let tools_res = match tools_req.send().await {
        Ok(r) => r,
        Err(e) => return fail_resp(start, format!("tools/list 请求失败：{e}")),
    };
    if !tools_res.status().is_success() {
        let status = tools_res.status();
        let text = tools_res.text().await.unwrap_or_default();
        let preview: String = text.chars().take(200).collect();
        return fail_resp(start, format!("tools/list 失败：HTTP {} {}", status, preview));
    }

    let data: serde_json::Value = match tools_res.text().await {
        Ok(text) => match parse_json_rpc_body(&text) {
            Ok(v) => v,
            Err(e) => return fail_resp(start, format!("tools/list 响应解析失败：{e}")),
        },
        Err(e) => return fail_resp(start, format!("tools/list 读取响应失败：{e}")),
    };

    // JSON-RPC 层错误（服务端在 result 之外返回 error）
    if let Some(err) = data.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return fail_resp(start, format!("tools/list 返回错误：{msg}"));
    }

    let raw_tools = data
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let tools: Vec<McpToolOut> = raw_tools
        .into_iter()
        .filter_map(|t| {
            let obj = t.as_object()?;
            let name = obj.get("name")?.as_str()?.to_string();
            Some(McpToolOut {
                name,
                title: obj.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                description: obj
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                input_schema: obj.get("inputSchema").cloned(),
                output_schema: obj.get("outputSchema").cloned(),
            })
        })
        .collect();

    McpSyncResponse {
        status: 1,
        ok: true,
        error: None,
        latency_ms: start.elapsed().as_millis() as u64,
        tools,
    }
}

/* ------------------------------------------------------------------ *
 * 工具调用命令（call_mcp_tool）
 * 流程：initialize 握手取会话 id -> tools/call，返回调用结果的原始 JSON 文本。
 * 仅 HTTP / SSE 可在后端直接连通；STDIO 需本地子进程，返回错误提示。
 * 前端通过 invoke('call_mcp_tool', { request }) 调用。
 * ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallRequest {
    pub endpoint_url: String,
    pub protocol_type: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub auth_type: Option<String>,
    #[serde(default)]
    pub auth_config: Option<serde_json::Value>,
    pub tool_name: String,
    #[serde(default)]
    pub arguments: Option<serde_json::Value>,
    /// 请求超时（秒），默认 120
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub latency_ms: u64,
    /// tools/call 响应的原始 JSON 文本（前端解析后展示）
    pub raw: String,
}

#[tauri::command]
pub async fn call_mcp_tool(request: McpCallRequest) -> McpCallResponse {
    let start = Instant::now();
    println!(
        "[agent] mcp.call: 开始 tool={} endpoint={} protocol={} auth_type={} args={}",
        request.tool_name,
        redact_endpoint(&request.endpoint_url),
        request.protocol_type,
        request.auth_type.as_deref().unwrap_or("NONE"),
        crate::agent::runtime::clip(
            &request.arguments.as_ref().map(|v| v.to_string()).unwrap_or_else(|| "{}".into()),
            500,
        ),
    );

    if request.protocol_type.eq_ignore_ascii_case("STDIO") {
        return McpCallResponse {
            ok: false,
            error: Some("STDIO 类型需在本地进程运行，无法在后端调用工具（请改用 HTTP / SSE）".into()),
            latency_ms: 0,
            raw: String::new(),
        };
    }
    if request.endpoint_url.trim().is_empty() {
        return McpCallResponse {
            ok: false,
            error: Some("缺少 endpointUrl（SSE / HTTP 类型必须填写访问地址）".into()),
            latency_ms: 0,
            raw: String::new(),
        };
    }

    // 构造基础请求头（用户头与认证头先放，协议必备头在末尾覆盖，避免被误填的
    // Accept 覆盖而触发 406 Not Acceptable）
    let mut header_map = reqwest::header::HeaderMap::new();
    if let Some(map) = &request.headers {
        for (k, v) in map {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }
    }
    // API_KEY：authConfig { key_name, key_value } 注入为请求头
    if request.auth_type.as_deref() == Some("API_KEY") {
        if let Some(obj) = request.auth_config.as_ref().and_then(|v| v.as_object()) {
            if let (Some(kn), Some(kv)) = (
                obj.get("key_name").and_then(|v| v.as_str()),
                obj.get("key_value").and_then(|v| v.as_str()),
            ) {
                if let (Ok(name), Ok(val)) = (
                    reqwest::header::HeaderName::from_bytes(kn.as_bytes()),
                    reqwest::header::HeaderValue::from_str(kv),
                ) {
                    header_map.insert(name, val);
                }
            }
        }
    }

    // Streamable HTTP 协议必备头：Content-Type=application/json、Accept 须含
    // text/event-stream。放在最后覆盖用户 headers，防止其 Accept 仅 application/json
    // 触发 406 Not Acceptable（"Client must accept both ..."）。
    for (k, v) in JSON_RPC_HEADERS {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(name, val);
        }
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(request.timeout_sec.unwrap_or(120)))
        .default_headers(header_map)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return McpCallResponse {
                ok: false,
                error: Some(format!("HTTP 客户端初始化失败：{e}")),
                latency_ms: 0,
                raw: String::new(),
            }
        }
    };

    let url = request.endpoint_url.trim().to_string();

    // 1) initialize 握手（取会话 id）
    let init_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "work-duo", "version": "1.0.0" }
        }
    });

    println!("[agent] mcp.call: initialize 请求发送 url={}", redact_endpoint(&url));
    let init_res = match client.post(&url).json(&init_body).send().await {
        Ok(r) => r,
        Err(e) => {
            println!("[agent] mcp.call: initialize 网络失败 耗时={}ms error={}", start.elapsed().as_millis(), e);
            return McpCallResponse {
                ok: false,
                error: Some(format!("initialize 请求失败：{e}")),
                latency_ms: start.elapsed().as_millis() as u64,
                raw: String::new(),
            }
        }
    };
    let session_id = init_res
        .headers()
        .get("mcp-session-id")
        .or_else(|| init_res.headers().get("Mcp-Session-Id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    println!(
        "[agent] mcp.call: initialize 返回 HTTP {} session_id={} 耗时={}ms",
        init_res.status(),
        session_id.as_deref().map(|_| "<存在>").unwrap_or("<无>"),
        start.elapsed().as_millis()
    );

    if !init_res.status().is_success() {
        let status = init_res.status();
        let text = init_res.text().await.unwrap_or_default();
        let preview: String = text.chars().take(200).collect();
        println!("[agent] mcp.call: initialize 失败 HTTP {} body={}", status, preview);
        return McpCallResponse {
            ok: false,
            error: Some(format!("initialize 失败：HTTP {} {}", status, preview)),
            latency_ms: start.elapsed().as_millis() as u64,
            raw: String::new(),
        };
    }

    // 1.5) 发送 notifications/initialized（MCP 规范要求；部分严格服务端会要求）
    println!("[agent] mcp.call: 发送 notifications/initialized session_id={}", session_id.as_deref().map(|_| "<存在>").unwrap_or("<无>"));
    notify_initialized(&client, &url, &session_id).await;
    println!("[agent] mcp.call: initialized 通知完成，准备 tools/call");

    // 2) tools/call
    let call_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": request.tool_name,
            "arguments": request.arguments.unwrap_or(serde_json::Value::Object(Default::default()))
        }
    });

    let mut call_req = client.post(&url).json(&call_body);
    if let Some(sid) = &session_id {
        call_req = call_req.header("Mcp-Session-Id", sid.as_str());
    }

    println!("[agent] mcp.call: tools/call 请求发送 tool={} session_id={}", request.tool_name, session_id.as_deref().map(|_| "<存在>").unwrap_or("<无>"));
    let call_res = match call_req.send().await {
        Ok(r) => r,
        Err(e) => {
            println!("[agent] mcp.call: tools/call 网络失败 tool={} 耗时={}ms error={}", request.tool_name, start.elapsed().as_millis(), e);
            return McpCallResponse {
                ok: false,
                error: Some(format!("tools/call 请求失败：{e}")),
                latency_ms: start.elapsed().as_millis() as u64,
                raw: String::new(),
            }
        }
    };

    let status = call_res.status();
    let raw_text = call_res.text().await.unwrap_or_default();
    // 兼容 SSE 响应：抽取 data 行解析为 JSON，失败则原样返回文本
    let raw = match parse_json_rpc_body(&raw_text) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| raw_text.clone()),
        Err(_) => raw_text,
    };
    let ok = status.is_success();
    let error = if ok {
        None
    } else {
        let preview: String = raw.chars().take(200).collect();
        Some(format!("tools/call 失败：HTTP {} {}", status, preview))
    };
    println!(
        "[agent] mcp.call: tools/call 返回 tool={} HTTP {} ok={} raw={}字符 耗时={}ms result={}",
        request.tool_name,
        status,
        ok,
        raw.chars().count(),
        start.elapsed().as_millis(),
        crate::agent::runtime::clip(&raw, 500),
    );

    McpCallResponse {
        ok,
        error,
        latency_ms: start.elapsed().as_millis() as u64,
        raw,
    }
}
