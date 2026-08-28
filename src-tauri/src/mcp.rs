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

fn fail_resp(start: Instant, error: String) -> McpSyncResponse {
    McpSyncResponse {
        status: 2,
        ok: false,
        error: Some(error),
        latency_ms: start.elapsed().as_millis() as u64,
        tools: Vec::new(),
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

    // 构造基础请求头
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in JSON_RPC_HEADERS {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(name, val);
        }
    }
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

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
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

    let data: serde_json::Value = match tools_res.json().await {
        Ok(v) => v,
        Err(e) => return fail_resp(start, format!("tools/list 响应解析失败：{e}")),
    };

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
    endpoint_url: String,
    protocol_type: String,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    auth_type: Option<String>,
    #[serde(default)]
    auth_config: Option<serde_json::Value>,
    tool_name: String,
    #[serde(default)]
    arguments: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResponse {
    ok: bool,
    error: Option<String>,
    latency_ms: u64,
    /// tools/call 响应的原始 JSON 文本（前端解析后展示）
    raw: String,
}

#[tauri::command]
pub async fn call_mcp_tool(request: McpCallRequest) -> McpCallResponse {
    let start = Instant::now();

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

    // 构造基础请求头
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in JSON_RPC_HEADERS {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            header_map.insert(name, val);
        }
    }
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

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
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

    let init_res = match client.post(&url).json(&init_body).send().await {
        Ok(r) => r,
        Err(e) => {
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

    if !init_res.status().is_success() {
        let status = init_res.status();
        let text = init_res.text().await.unwrap_or_default();
        let preview: String = text.chars().take(200).collect();
        return McpCallResponse {
            ok: false,
            error: Some(format!("initialize 失败：HTTP {} {}", status, preview)),
            latency_ms: start.elapsed().as_millis() as u64,
            raw: String::new(),
        };
    }

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

    let call_res = match call_req.send().await {
        Ok(r) => r,
        Err(e) => {
            return McpCallResponse {
                ok: false,
                error: Some(format!("tools/call 请求失败：{e}")),
                latency_ms: start.elapsed().as_millis() as u64,
                raw: String::new(),
            }
        }
    };

    let status = call_res.status();
    let raw = call_res.text().await.unwrap_or_default();
    let ok = status.is_success();
    let error = if ok {
        None
    } else {
        let preview: String = raw.chars().take(200).collect();
        Some(format!("tools/call 失败：HTTP {} {}", status, preview))
    };

    McpCallResponse {
        ok,
        error,
        latency_ms: start.elapsed().as_millis() as u64,
        raw,
    }
}
