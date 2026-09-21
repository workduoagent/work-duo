//! WorkDuo 内建 MCP Server（自测闭环用）。
//!
//! 让 WorkDuo 自身成为标准 MCP Server，无需任何外部 sidecar / Node 进程。
//! 复用 `squad_api_server.rs` 的手写极简 HTTP 骨架（零新增网络依赖），
//! 在 `127.0.0.1:<port>` 暴露 MCP Streamable HTTP 端点（`POST /mcp`，可选 `GET /mcp` SSE）。
//!
//! 工具分三层：
//! - 引擎层（Rust 直调，无需前端）：`agent_run_task` / `agent_get_status` /
//!   `agent_wait_task` / `agent_get_run_logs`
//! - 模块发现层（Rust 直读 workduo.db，零业务副作用，供自测驱动方「看到可选集」后智能选值）：
//!   `agent_list_models` / `agent_list_skills` / `agent_list_mcps` / `agent_list_mcp_tools` /
//!   `agent_list_plugins` / `agent_list_kbs` / `agent_list_scenarios`
//! - UI 意图层（派发到前端真实 handler，走完整 Tauri2 全流程，所有操作留痕、可经 UI 抽查）：
//!   `agent_ui_create` / `agent_ui_update` / `agent_ui_delete` / `agent_ui_get` / `agent_ui_list`
//!   + 插件模块 `plugin_*`（百宝箱→插件：增删改查/启用/试跑/提取头注/执行日志）
//!   + 知识库模块 `kb_*`（创建/编辑/删除/列资产/新增文件/导入/建文件夹/移除/重建索引）
//!   + 记忆宫殿模块 `memory_*`（设置→记忆宫殿：锚定/更新/删除/召回/蒸馏候选/热力图）
//!
//! UI 意图工具经 Tauri 事件 `mcp:intent` 派发到前端 `mcpBridge`，
//! 前端用 `invoke('mcp_resolve_result', {id, ok, data})` 回传结果。
//!
//! 开关 `mcp_server_enabled`、端口 `mcp_server_port` 存于 app_config（默认启用、端口 18755），
//! 每次请求实时读取端口；开关变更需重启服务（与 squad_api_server 一致）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Map, Value};
use sqlx::{Column, Row, TypeInfo};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;

use crate::agent::commands;
use crate::agent::events;
use crate::agent::runtime::AgentRuntime;
use crate::logging;

/// 待前端回传的 UI 意图请求：`request_id -> oneshot sender`。
type PendingMap = HashMap<String, tokio::sync::oneshot::Sender<Value>>;

static PENDING: OnceLock<Mutex<PendingMap>> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
static REQ_COUNTER: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();

fn pending() -> &'static Mutex<PendingMap> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}
fn sessions() -> &'static Mutex<std::collections::HashSet<String>> {
    SESSIONS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}
fn req_counter() -> &'static std::sync::atomic::AtomicU64 {
    REQ_COUNTER.get_or_init(|| std::sync::atomic::AtomicU64::new(1))
}

fn next_req_id() -> String {
    let n = req_counter().fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("wd-{}-{}", chrono::Local::now().timestamp_millis(), n)
}

/// 从 app_config 读取数据库池（与 squad_api_server 同款）。
async fn get_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?;
    match db_pool {
        DbPool::Sqlite(p) => Ok(p.clone()),
    }
}

async fn read_cfg(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    let row = sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    row.try_get::<Option<String>, _>("value").ok().flatten()
}

/// 通用只读查询：把任意 SELECT 的结果行按列名映射为 JSON 对象数组。
/// 仅用于自测闭环的「模块发现」工具，零业务副作用。
async fn fetch_rows(app: &AppHandle, sql: &str, binds: &[String]) -> Value {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => return json!({ "error": e }),
    };
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(b.clone());
    }
    match q.fetch_all(&pool).await {
        Ok(rows) => {
            let mut out: Vec<Value> = Vec::with_capacity(rows.len());
            for row in &rows {
                let mut obj = Map::new();
                for col in row.columns() {
                    let name = col.name().to_string();
                    let v = column_value(row, col);
                    obj.insert(name, v);
                }
                out.push(Value::Object(obj));
            }
            json!({ "rows": out, "count": out.len() })
        }
        Err(e) => json!({ "error": format!("查询失败: {e}") }),
    }
}

/// 把单个 Sqlite 列值转为 JSON（按列类型分派，未知类型回退 Null）。
fn column_value(row: &sqlx::sqlite::SqliteRow, col: &sqlx::sqlite::SqliteColumn) -> Value {
    let name = col.name().to_string();
    let key = name.as_str();
    let tname = col.type_info().name();
    match tname {
        "INTEGER" => row
            .try_get::<Option<i64>, _>(key)
            .ok()
            .flatten()
            .map(|n| Value::Number(n.into()))
            .unwrap_or(Value::Null),
        "REAL" => row
            .try_get::<Option<f64>, _>(key)
            .ok()
            .flatten()
            .and_then(|f| serde_json::Number::from_f64(f).map(Value::Number))
            .unwrap_or(Value::Null),
        "TEXT" => row
            .try_get::<Option<String>, _>(key)
            .ok()
            .flatten()
            .map(Value::String)
            .unwrap_or(Value::Null),
        "BLOB" => row
            .try_get::<Option<Vec<u8>>, _>(key)
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok())
            .map(Value::String)
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// 启动内建 MCP Server（在 app setup 中调用，独立 std 线程）。
pub fn start_mcp_server(app: AppHandle) {
    std::thread::spawn(move || {
        let (enabled, port) = tauri::async_runtime::block_on(async {
            let pool = match get_pool(&app).await {
                Ok(p) => p,
                Err(_) => return (true, 18755u16), // 未就绪时按默认启用
            };
            let enabled = read_cfg(&pool, "mcp_server_enabled")
                .await
                .as_deref()
                != Some("false");
            let port = read_cfg(&pool, "mcp_server_port")
                .await
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(18755);
            (enabled, port)
        });

        if !enabled {
            tracing::info!("[mcp] 内建 MCP Server 未启用（app_config.mcp_server_enabled != 'true'），跳过监听");
            return;
        }

        let addr = format!("127.0.0.1:{port}");
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("[mcp] 无法绑定 {addr}：{e}");
                return;
            }
        };
        tracing::info!("[mcp] WorkDuo 内建 MCP Server 已启动：{addr}/mcp");
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    let app2 = app.clone();
                    std::thread::spawn(move || handle_conn(s, app2));
                }
                Err(e) => tracing::info!("[mcp] accept 错误：{e}"),
            }
        }
    });
}

/// 处理单个 HTTP 连接。
fn handle_conn(mut stream: TcpStream, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));

    let request = {
        let mut reader = BufReader::new(&stream);
        let mut first_line = String::new();
        if reader.read_line(&mut first_line).is_err() {
            return;
        }
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        if parts.len() < 2 {
            return;
        }
        let method = parts[0].to_string();
        let path = parts[1].to_string();

        let mut headers: HashMap<String, String> = HashMap::new();
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                break;
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some(idx) = l.find(':') {
                let k = l[..idx].trim().to_lowercase();
                let v = l[idx + 1..].trim().to_string();
                if k == "content-length" {
                    content_length = v.parse().unwrap_or(0);
                }
                headers.insert(k, v);
            }
        }

        let mut body = vec![0u8; content_length];
        if content_length > 0 {
            if reader.read_exact(&mut body).is_err() {
                return;
            }
        }
        (method, path, headers, body)
    };

    if request.1 != "/mcp" {
        let _ = stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"error\":\"not found\"}",
        );
        return;
    }

    if request.0 == "GET" {
        // MCP Streamable HTTP：GET 用于服务端→客户端 SSE 通道，保持打开并心跳。
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: mcp-connected\r\n\r\n",
        );
        let mut elapsed = Duration::from_secs(0);
        while elapsed < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_secs(5));
            elapsed += Duration::from_secs(5);
            if stream.write_all(b": hb\r\n\r\n").is_err() {
                break;
            }
        }
        return;
    }

    if request.0 != "POST" {
        let _ = stream.write_all(
            b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let accept = request.2.get("accept").cloned().unwrap_or_default();
    let use_sse = accept.to_lowercase().contains("text/event-stream");
    let session_id = request.2.get("mcp-session-id").cloned();

    let resp: Option<(Value, Option<String>)> = tauri::async_runtime::block_on(async {
        let body_str = String::from_utf8_lossy(&request.3);
        let parsed: Value = match serde_json::from_str(&body_str) {
            Ok(v) => v,
            Err(e) => {
                return Some((
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}}),
                    session_id.clone(),
                ))
            }
        };
        if parsed.is_array() {
            let mut out = Vec::new();
            if let Some(arr) = parsed.as_array() {
                for item in arr {
                    if let Some((r, _)) = handle_jsonrpc(&app, item, session_id.as_deref()).await {
                        out.push(r);
                    }
                }
            }
            Some((Value::Array(out), session_id.clone()))
        } else {
            handle_jsonrpc(&app, &parsed, session_id.as_deref()).await
        }
    });

    match resp {
        Some((json_resp, sess)) => {
            let body = serde_json::to_vec(&json_resp).unwrap_or_default();
            let session_header = sess
                .as_ref()
                .map(|s| format!("Mcp-Session-Id: {s}\r\n"))
                .unwrap_or_default();
            if use_sse {
                let payload =
                    format!("event: message\r\ndata: {}\r\n\r\n", String::from_utf8_lossy(&body));
                let resp_str = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n{session_header}\r\n{payload}"
                );
                let _ = stream.write_all(resp_str.as_bytes());
            } else {
                // 修复：头部严格以单个 \r\n\r\n 结尾，避免多余 CRLF 前缀导致 Content-Length
                // 与实际实体字节数不一致（严格客户端按 Content-Length 截断 → JSON 被腰斩、解析失败）。
                let mut head = String::from("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n");
                head.push_str(&format!("Content-Length: {}\r\n", body.len()));
                head.push_str("Connection: close\r\n");
                if let Some(s) = &sess {
                    head.push_str(&format!("Mcp-Session-Id: {s}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        }
        None => {
            // 通知类（如 notifications/initialized），无响应
            let _ = stream.write_all(
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    }
}

/// 处理单条 JSON-RPC 请求；返回 `Some((响应, 需回传的 session id))` 或 `None`（通知，无响应）。
async fn handle_jsonrpc(app: &AppHandle, req: &Value, session_id: Option<&str>) -> Option<(Value, Option<String>)> {
    let method = req.get("method").and_then(|v| v.as_str())?;
    let id = req.get("id").cloned();
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => {
            let proto = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05")
                .to_string();
            let new_session = next_req_id();
            sessions().lock().unwrap().insert(new_session.clone());
            Some((
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": proto,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "workduo-mcp", "version": "0.1.0" }
                    }
                }),
                Some(new_session),
            ))
        }
        "notifications/initialized" | "initialized" => None,
        "ping" => Some((json!({"jsonrpc":"2.0","id":id,"result":{}}), session_id.map(|s| s.to_string()))),
        "tools/list" => Some((
            json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools_list() } }),
            session_id.map(|s| s.to_string()),
        )),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let result = call_tool(app, name, &args).await;
            Some((
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [ { "type": "text", "text": serde_json::to_string(&result).unwrap_or_default() } ],
                        "isError": result.get("error").is_some()
                    }
                }),
                session_id.map(|s| s.to_string()),
            ))
        }
        _ => Some((
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            }),
            session_id.map(|s| s.to_string()),
        )),
    }
}

/// 执行具体工具调用。
async fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Value {
    match name {
        "agent_run_task" => {
            let rt = app.state::<AgentRuntime>();
            let input: commands::RunAgentTaskInput = match merge_input(args) {
                Ok(i) => i,
                Err(e) => return json!({"error": format!("参数错误: {e}")}),
            };
            match commands::run_task_ex(app.clone(), rt, input).await {
                Ok(run_id) => json!({ "run_id": run_id }),
                Err(e) => json!({ "error": e }),
            }
        }
        "agent_get_status" => {
            let rt = app.state::<AgentRuntime>();
            let run_id = args.get("run_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match commands::get_status(rt, run_id).await {
                Ok(r) => json!({ "status": r }),
                Err(e) => json!({ "error": e }),
            }
        }
        "agent_wait_task" => {
            let rt = app.state::<AgentRuntime>();
            let run_id = args.get("run_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64());
            match commands::wait_task(rt, run_id, timeout_ms).await {
                Ok(r) => json!({ "status": r }),
                Err(e) => json!({ "error": e }),
            }
        }
        "agent_get_run_logs" => {
            let cursor = args.get("cursor").and_then(|v| v.as_u64()).map(|n| n as usize);
            let since_ts = args.get("since_ts").and_then(|v| v.as_str()).map(|s| s.to_string());
            let level = args.get("level").and_then(|v| v.as_str()).map(|s| s.to_string());
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
            match logging::get_run_logs(app.clone(), cursor, since_ts, level, limit) {
                Ok(lines) => json!({ "lines": lines }),
                Err(e) => json!({ "error": e }),
            }
        }
        "agent_get_run_trace" => {
            // 自测闭环：取出本 run 的完整轨迹缓冲（事件列表 + 累计思考 + 累计正文）。
            // get_run_logs 只回 Rust tracing 日志、不含思考/轨迹/正文；本工具补上事件流视角，
            // 用于判断「整链哪里断」：plan / step / tool / intent / status / task_done 全在 events，
            // 思考过程在 thinking，正文回复在 reply。
            json!({ "trace": events::get_trace() })
        }
        // —— 模块发现层（Rust 直读 workduo.db，零业务副作用）——
        "agent_list_models" => {
            fetch_rows(
                app,
                "SELECT id, name, model_name, provider, category, enabled, tool_calls, description, config FROM models ORDER BY created_at DESC",
                &[],
            )
            .await
        }
        "agent_list_skills" => {
            fetch_rows(
                app,
                "SELECT id, identifier, name, description, scenario, status, tags FROM skill_info ORDER BY created_at DESC",
                &[],
            )
            .await
        }
        "agent_list_mcps" => {
            fetch_rows(
                app,
                "SELECT id, alias_name, mcp_name, protocol_type, status, is_active, scenario, description FROM mcp_info ORDER BY created_at DESC",
                &[],
            )
            .await
        }
        "agent_list_mcp_tools" => {
            let mcp_id = args
                .get("mcp_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            fetch_rows(
                app,
                "SELECT id, mcp_id, tool_code, display_name, description, is_active FROM mcp_tool_definition WHERE mcp_id = ? ORDER BY created_at DESC",
                &[mcp_id],
            )
            .await
        }
        "agent_list_plugins" => {
            fetch_rows(
                app,
                "SELECT id, name, identifier, description, runtime, enabled, scenario FROM user_plugin_tool ORDER BY created_at DESC",
                &[],
            )
            .await
        }
        "agent_list_kbs" => {
            fetch_rows(
                app,
                "SELECT id, identifier, name, description, scenario, file_count FROM knowledge_base ORDER BY created_at DESC",
                &[],
            )
            .await
        }
        "agent_list_scenarios" => {
            let scope = args
                .get("scope")
                .and_then(|v| v.as_str())
                .unwrap_or("AGENT")
                .to_string();
            fetch_rows(
                app,
                "SELECT id, scope, value, label FROM scenario_category WHERE scope = ? ORDER BY created_at ASC",
                &[scope],
            )
            .await
        }
        // —— UI 意图层：派发到前端真实 handler ——
        "agent_ui_create" | "agent_ui_update" => {
            let intent = if name == "agent_ui_create" { "agent:ui_create" } else { "agent:ui_update" };
            // 解包 args.payload（MCP 工具入参形如 {payload: <AgentUpsertInput>}），避免双重嵌套。
            let p = args.get("payload").cloned().unwrap_or_else(|| args.clone());
            dispatch_ui(app, intent, p).await
        }
        "agent_ui_delete" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            dispatch_ui(app, "agent:ui_delete", json!({ "id": id })).await
        }
        "agent_ui_get" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            dispatch_ui(app, "agent:ui_get", json!({ "id": id })).await
        }
        "agent_ui_list" => dispatch_ui(app, "agent:ui_list", Value::Null).await,
        // —— 会话 / 轮次：经前端真实 handler（createSession / appendRound / updateRound / updateSession / list*）——
        "agent_session_create" | "agent_round_create" | "agent_round_update" | "agent_session_update" => {
            let intent = match name {
                "agent_session_create" => "agent:session_create",
                "agent_round_create" => "agent:round_create",
                "agent_round_update" => "agent:round_update",
                _ => "agent:session_update",
            };
            let p = args.get("payload").cloned().unwrap_or_else(|| args.clone());
            dispatch_ui(app, intent, p).await
        }
        "agent_session_list" => {
            let id = args.get("agentIdentifier").and_then(|v| v.as_str()).unwrap_or("").to_string();
            dispatch_ui(app, "agent:session_list", json!({ "agentIdentifier": id })).await
        }
        "agent_session_get" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            dispatch_ui(app, "agent:session_get", json!({ "id": id })).await
        }
        "agent_round_list" => {
            let sid = args.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            dispatch_ui(app, "agent:round_list", json!({ "sessionId": sid })).await
        }
        // —— 插件模块（百宝箱 → 插件）：UI 级真实 handler（增删改查/启用/试跑/提取头注/执行日志）——
        "plugin_list" => dispatch_ui(app, "plugin:list", args.clone()).await,
        "plugin_get" => dispatch_ui(app, "plugin:get", args.clone()).await,
        "plugin_upsert" => dispatch_ui(app, "plugin:upsert", args.clone()).await,
        "plugin_delete" => dispatch_ui(app, "plugin:delete", args.clone()).await,
        "plugin_set_enabled" => dispatch_ui(app, "plugin:set_enabled", args.clone()).await,
        "plugin_test" => dispatch_ui(app, "plugin:test", args.clone()).await,
        "plugin_extract_meta" => dispatch_ui(app, "plugin:extract_meta", args.clone()).await,
        "plugin_list_run_logs" => dispatch_ui(app, "plugin:list_run_logs", args.clone()).await,
        // —— 知识库模块：UI 级真实 handler（创建/编辑/删除/列资产/新增文件/导入/建文件夹/移除/重建索引）——
        "kb_list" => dispatch_ui(app, "kb:list", args.clone()).await,
        "kb_get" => dispatch_ui(app, "kb:get", args.clone()).await,
        "kb_create" => dispatch_ui(app, "kb:create", args.clone()).await,
        "kb_update" => dispatch_ui(app, "kb:update", args.clone()).await,
        "kb_delete" => dispatch_ui(app, "kb:delete", args.clone()).await,
        "kb_list_assets" => dispatch_ui(app, "kb:list_assets", args.clone()).await,
        "kb_add_file" => dispatch_ui(app, "kb:add_file", args.clone()).await,
        "kb_import_file" => dispatch_ui(app, "kb:import_file", args.clone()).await,
        "kb_create_folder" => dispatch_ui(app, "kb:create_folder", args.clone()).await,
        "kb_remove_file" => dispatch_ui(app, "kb:remove_file", args.clone()).await,
        "kb_rebuild_index" => dispatch_ui(app, "kb:rebuild_index", args.clone()).await,
        "kb_add_tag" => dispatch_ui(app, "kb:add_tag", args.clone()).await,
        "kb_remove_tag" => dispatch_ui(app, "kb:remove_tag", args.clone()).await,
        "kb_rename_tag" => dispatch_ui(app, "kb:rename_tag", args.clone()).await,
        "kb_get_tags" => dispatch_ui(app, "kb:get_tags", args.clone()).await,
        // —— 记忆宫殿模块（设置 → 记忆宫殿）：UI 级 invoke 调用（与 MemoryPalace.tsx 同款）——
        "memory_list" => dispatch_ui(app, "memory:list", args.clone()).await,
        "memory_heatmap" => dispatch_ui(app, "memory:heatmap", args.clone()).await,
        "memory_anchor" => dispatch_ui(app, "memory:anchor", args.clone()).await,
        "memory_update" => dispatch_ui(app, "memory:update", args.clone()).await,
        "memory_delete" => dispatch_ui(app, "memory:delete", args.clone()).await,
        "memory_recall" => dispatch_ui(app, "memory:recall", args.clone()).await,
        "memory_list_candidates" => dispatch_ui(app, "memory:list_candidates", args.clone()).await,
        "memory_confirm_candidate" => dispatch_ui(app, "memory:confirm_candidate", args.clone()).await,
        "memory_reject_candidate" => dispatch_ui(app, "memory:reject_candidate", args.clone()).await,
        _ => json!({ "error": format!("unknown tool: {name}") }),
    }
}

/// 把 MCP 参数合并成 RunAgentTaskInput（补全可选字段默认值）。
/// 字段名须 camelCase（与 Rust RunAgentTaskInput 的 serde rename 一致）。
fn merge_input(args: &Value) -> Result<commands::RunAgentTaskInput, String> {
    let mut v = args.clone();
    if let Value::Object(ref mut map) = v {
        for key in [
            "workspace",
            "sessionId",
            "roundId",
            "attachments",
            "planOverride",
            "preCompleted",
            "initialContext",
            "disabledSkillIds",
            "disabledMcpIds",
            "disabledMcpToolIds",
            "enabledSkillIds",
            "enabledMcpIds",
            "disabledPluginIds",
            "enabledPluginIds",
        ] {
            map.entry(key).or_insert(Value::Null);
        }
    }
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// 经 Tauri 事件派发 UI 意图，等待前端回传。
async fn dispatch_ui(app: &AppHandle, intent: &str, payload: Value) -> Value {
    let req_id = next_req_id();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    pending().lock().unwrap().insert(req_id.clone(), tx);
    let _ = app.emit(
        "mcp:intent",
        json!({ "id": req_id, "intent": intent, "payload": payload }),
    );
    match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => json!({ "error": "前端回传通道已关闭（receiver dropped）" }),
        Err(_) => json!({ "error": "等待前端 handler 响应超时（60s）" }),
    }
}

/// 前端完成 UI 意图处理后回传结果（由 mcpBridge 通过 invoke 调用）。
#[tauri::command]
pub async fn mcp_resolve_result(id: String, ok: bool, data: Value) {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(json!({ "ok": ok, "data": data }));
    }
}

/// 工具清单（MCP 名称用下划线，符合 `^[a-zA-Z0-9_-]+$`）。
fn tools_list() -> Value {
    Value::Array(vec![
        tool(
            "agent_run_task",
            "运行一个 Agent 任务，返回 run_id（复用 run_task_ex，含 run_registry 记录）。\n\
【入参契约】字段名必须 camelCase，与 Rust `RunAgentTaskInput(#[serde(rename_all=\"camelCase\")]` 一致：\
agentId(必填) / prompt(必填) / workspace(可选, 工作区路径) / sessionId(可选, 会话 id) / roundId(可选, 轮次 id) / \
attachments / planOverride / preCompleted / initialContext / disabledSkillIds / disabledMcpIds / disabledMcpToolIds / \
enabledSkillIds / enabledMcpIds / disabledPluginIds / enabledPluginIds。\n\
【自由会话 vs 任务会话】不传 workspace/sessionId/roundId = 自由会话（无产物持久化，仅事件流+轨迹缓冲）；\
传入 workspace 且前端已建 sessionId+roundId = 任务会话（run_task 终态仅自动回填 raw_messages_json）。\n\
【必做-结果回填】任务会话在 wait_task 终态后，必须取 agent_get_run_trace 的 reply/thinking 经 agent_round_update 回填 \
assistantAnswer/thinkingContent——否则 agent_conversation_round 的正文列为空，UI 会话历史抽查不到本次问答（2026-09-20 实锤）。\n\
【注意】get_run_logs 只回 Rust tracing 日志（不含思考/轨迹/正文）；完整轨迹请用 agent_get_run_trace（事件流缓冲，含 thinking/reply/plan/steps）。",
            json!({
                "type": "object",
                "properties": {
                    "agentId": { "type": "string", "description": "目标 Agent id" },
                    "prompt": { "type": "string", "description": "任务提示词" },
                    "workspace": { "type": "string", "description": "工作区（可选）" },
                    "sessionId": { "type": "string", "description": "会话 id（任务会话必填）" },
                    "roundId": { "type": "string", "description": "轮次 id（任务会话必填）" },
                    "attachments": { "type": "array", "description": "多模态附件 {type,dataUrl,name}" },
                    "planOverride": { "type": "object", "description": "分支重跑：完整计划 DAG" },
                    "preCompleted": { "type": "array", "description": "分支重跑：已完成 head 步骤 task_id" },
                    "initialContext": { "type": "string", "description": "分支重跑：head 步骤摘要" },
                    "disabledSkillIds": { "type": "array", "items": { "type": "string" } },
                    "disabledMcpIds": { "type": "array", "items": { "type": "string" } },
                    "disabledMcpToolIds": { "type": "array", "items": { "type": "string" } },
                    "enabledSkillIds": { "type": "array", "items": { "type": "string" } },
                    "enabledMcpIds": { "type": "array", "items": { "type": "string" } },
                    "disabledPluginIds": { "type": "array", "items": { "type": "string" } },
                    "enabledPluginIds": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["agentId", "prompt"]
            }),
        ),
        tool(
            "agent_get_status",
            "查询 run_id 的当前状态 / 轨迹快照（RunRecord）。",
            json!({ "type": "object", "properties": { "run_id": { "type": "string" } }, "required": ["run_id"] }),
        ),
        tool(
            "agent_wait_task",
            "轮询等待 run_id 进入终态（done/error），超时返回错误。",
            json!({ "type": "object", "properties": { "run_id": { "type": "string" }, "timeout_ms": { "type": "number" } }, "required": ["run_id"] }),
        ),
        tool(
            "agent_get_run_logs",
            "增量读取 Rust 运行日志（workduo.log.YYYY-MM-DD），按游标/时间窗过滤。",
            json!({ "type": "object", "properties": {
                "cursor": { "type": "integer", "description": "字节/行游标，传上次返回的 next_cursor" },
                "since_ts": { "type": "string", "description": "起始时间戳字符串" },
                "level": { "type": "string", "description": "日志等级过滤（INFO/WARN/ERROR）" },
                "limit": { "type": "integer", "description": "最大返回行数" }
            } }),
        ),
        tool(
            "agent_get_run_trace",
            "自测闭环专用：取出当次 run 的完整执行轨迹（事件流缓冲）。\n\
与 agent_get_run_logs（仅 Rust tracing 日志）互补：本工具返回 events（plan/step/tool/intent/status/task_done 等结构化事件）、\
thinking（累计思考过程）、reply（累计正文回复）、counts（各维度计数）。\n\
用途：判断「整链哪里断」——例如 events 里有没有 plan_generated、step 卡在哪、thinking 是否出现、reply 是否为空。\
run_task_ex / run_agent_task 启动时会 reset 该缓冲，故只反映最近一次 run；须在 wait_task 返回 done 后调用。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_ui_create",
            "经前端真实 handler 创建 Agent（完整 Tauri2 全流程：前端校验→mapper SQL→tauri-plugin-sql→SQLite）。\n\
【智能体装配指引】给定一句话需求（如『合同审计助手』），应先依次调用 agent_list_models / agent_list_mcps / agent_list_mcp_tools / agent_list_skills / agent_list_plugins / agent_list_kbs / agent_list_scenarios 拿到真实可选集，再智能判断后组装 payload。\n\
【payload = AgentUpsertInput 字段】\n\
- name(必填) 智能体名；identifier(必填, 须匹配 ^[a-zA-Z0-9_-]+$) 唯一标识；scenario 场景 value（来自 agent_list_scenarios 的 value）；description 描述；systemPrompt 人设与指令(markdown)；welcomeMessage 欢迎语。\n\
- llmId(必填) 大脑模型 id（来自 agent_list_models，category∈{text,multimodal} 且 enabled=1）；llmConfig 可选参数副本(JSON)；ttsId/sttId 可选（嘴巴/耳朵，category 分别为 tts/stt）。\n\
- mcpTools: 数组，元素 {mcpId, toolId}，toolId 来自 agent_list_mcp_tools（服务数≤3、工具总数≤10）。\n\
- skillIds: 技能 id 数组（≤3，来自 agent_list_skills）。\n\
- pluginIds: 本地插件 id 数组（≤10，来自 agent_list_plugins）。\n\
- kbIds: 知识库 id 数组（无上限，来自 agent_list_kbs）。\n\
- isActive 默认 true；autoToolExecMode 默认 false；allowSandbox 默认 true；memoryMode 默认 'off'('off'|'active'|'forced')；planAutoApproveMode 默认 'always'('always'|'sensitive'|'never')。\n\
【选值启发-合同/文档审计类】大脑优先选 tool_calls=1 的强推理模型；MCP 选文件/文档类并挑 read/write/search/extract 工具；Skill 选文档分析/法律类；KB 绑定合同语料库；scenario 选 'office-efficiency' 或 'data-analysis'。\n\
【必做-步骤2模型参数副本】选中 llmId 后，必须取 agent_list_models 返回的对应行 config（JSON 字符串），解析为对象后原样写入 llmConfig；ttsId/sttId 同理写入 ttsConfig/sttConfig。漏写 llmConfig 等价于 UI 未展开参数卡，模型无参调用，属漏配。\n\
【必做-行为策略字段】isActive/autoToolExecMode/allowSandbox/memoryMode/planAutoApproveMode 必须在 payload 中**显式赋值**，不要省略（省略会落到 upsertAgent 的兜底默认，可能与 UI 向导默认值不一致：UI 向导默认 allowSandbox=true，而 upsertAgent 默认 false）。不确定时采用 UI 向导默认：isActive=true、autoToolExecMode=false、allowSandbox=true、memoryMode='off'、planAutoApproveMode='always'。\n\
【必做-MCP 工具选择】凡 mcpTools 挂载了 MCP 服务，必须再经 agent_list_mcp_tools(mcp_id) 选出具体工具，以 {mcpId, toolId} 写入 mcpTools（服务≤3、工具≤10），不能只挂服务不勾工具。",
            json!({ "type": "object", "properties": { "payload": { "type": "object", "description": "AgentUpsertInput 字段（装配规则见 description）" } }, "required": ["payload"] }),
        ),
        tool(
            "agent_ui_update",
            "经前端真实 handler 更新 Agent（同 upsertAgent 入口，payload 必须含已存在 Agent 的 id）。装配规则与 agent_ui_create 的 description 一致：先调用各 agent_list_* 工具取真实可选集，再组装 payload。",
            json!({ "type": "object", "properties": { "payload": { "type": "object", "description": "AgentUpsertInput 字段（须含 id）" } }, "required": ["payload"] }),
        ),
        tool(
            "agent_ui_delete",
            "经前端真实 handler 删除 Agent。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "agent_ui_get",
            "经前端真实 handler 查询单个 Agent。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "agent_ui_list",
            "经前端真实 handler 列出全部 Agent（精简字段，供核对）。",
            json!({ "type": "object", "properties": {} }),
        ),
        // —— 会话 / 轮次：与 Agent 对话页「发送」同款真实链路（createSession→appendRound→run→updateRound）——
        tool(
            "agent_session_create",
            "经前端真实 handler 创建智能体会话（与对话页「新建对话」同款）：createSession(agentIdentifier, sessionName?, {projectId?})。\n\
返回新建 session（含 id/sessionName/agentCode/status='RUNNING'/from_site='DEBUG_CHAT' 等）。\n\
用途：在跑任务前先建会话，使 run_task 带上 sessionId，跑完历史可经 UI 会话列表抽查。\n\
入参：payload={ agentIdentifier(必填, Agent 的 identifier), sessionName(可选), projectId(可选, 绑工程) }。",
            json!({ "type": "object", "properties": { "payload": { "type": "object", "description": "{agentIdentifier,sessionName?,projectId?}" } }, "required": ["payload"] }),
        ),
        tool(
            "agent_round_create",
            "经前端真实 handler 追加一轮（与对话页点「发送」时同款）：appendRound({sessionId, llmCode?, roundIndex, userQuestion, startTime?})。\n\
返回新建 round（含 id）。run_task 的 roundId 必须传此 id，后端才会在终态回填 agent_conversation_round 的 raw_messages_json，且本工具链再经 agent_round_update 回填 thinking_content/assistant_answer 供 UI 展示。\n\
入参：payload={ sessionId(必填), llmCode(可选, Agent 的 llmId), roundIndex(必填, 从0自增), userQuestion(可选, 本次提问文本), startTime(可选) }。",
            json!({ "type": "object", "properties": { "payload": { "type": "object", "description": "{sessionId,llmCode?,roundIndex,userQuestion?,startTime?}" } }, "required": ["payload"] }),
        ),
        tool(
            "agent_round_update",
            "经前端真实 handler 回填一轮结果（与对话页流式结束后同款）：updateRound(roundId, patch)。\n\
必做：run_task 完成后，把 agent_get_run_trace 取到的 reply/thinking 回填，使 UI 会话历史可见本次问答；否则 round 行 assistant_answer/thinking_content 为空，UI 抽查不到正文。\n\
入参：payload={ roundId(必填), patch(可选, 字段含 assistantAnswer/thinkingContent/toolCallsSummary/planStepsSummary/segments/inputTokens/outputTokens/endTime) }。",
            json!({ "type": "object", "properties": { "payload": { "type": "object", "description": "{roundId,patch?}" } }, "required": ["payload"] }),
        ),
        tool(
            "agent_session_update",
            "经前端真实 handler 更新会话状态（与对话页结束同款）：updateSession(id, patch)。\n\
用途：run_task 完成后把会话状态置为 'COMPLETED'（或出错置 'ERROR'）并写 endTime，UI 会话列表才显示「已完成」。\n\
入参：payload={ id(必填), patch(可选, 字段含 status/endTime/summary/errorMessage 等) }。",
            json!({ "type": "object", "properties": { "payload": { "type": "object", "description": "{id,patch?}" } }, "required": ["payload"] }),
        ),
        tool(
            "agent_session_list",
            "经前端真实 handler 列出某 Agent 的全部会话（按置顶+更新时间倒序）。",
            json!({ "type": "object", "properties": { "agentIdentifier": { "type": "string", "description": "Agent identifier" } }, "required": ["agentIdentifier"] }),
        ),
        tool(
            "agent_session_get",
            "经前端真实 handler 按 id 查询单个会话。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "agent_round_list",
            "经前端真实 handler 列出某会话的全部轮次（按 round_index 升序）。",
            json!({ "type": "object", "properties": { "sessionId": { "type": "string" } }, "required": ["sessionId"] }),
        ),
        tool(
            "agent_list_models",
            "【模块发现】读取 workduo.db.models，列出全部可用模型。返回每行含 id/name/model_name/provider/category/enabled/tool_calls/description/config。\n用途：为 agent_ui_create 的 llmId/ttsId/sttId 选值。category∈{text,multimodal,tts,stt,embedding,rerank}；大脑(llmId)必须选 category∈{text,multimodal} 且 enabled=1 的模型；需工具调用的智能体优先选 tool_calls=1 的模型。\n⚠️ config 字段=该模型的「默认参数副本」（JSON 字符串，内容即其所属 category 对应的参数对象，如 multimodal 模型 config 为温度/TopP/maxTokens/visionDetail 等）。**选中某模型后，必须把 config 解析成对象、原样作为 llmConfig（或 ttsConfig/sttConfig）写入**——这等价于 UI 步骤2「选中模型自动复制默认参数」行为；若留空 llmConfig，等价于用户从未点开参数卡，模型将以无参方式调用，属漏配。返回 {rows:[...], count}。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_list_skills",
            "【模块发现】读取 skill_info，列出全部可用技能。返回 id/identifier/name/description/scenario/status/tags。\n用途：为 agent_ui_create 的 skillIds 选值（数组，≤3）。优先选 status=1、description 与任务语义匹配的技能。返回 {rows:[...], count}。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_list_mcps",
            "【模块发现】读取 mcp_info，列出全部已接入 MCP 服务。返回 id/alias_name/mcp_name/protocol_type/status/is_active/scenario/description。\n用途：先在此找到目标 MCP 服务的 id，再调用 agent_list_mcp_tools 取其工具。agent_ui_create 的 mcpTools 以工具为最小单元 {mcpId, toolId}，服务数≤3。返回 {rows:[...], count}。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_list_mcp_tools",
            "【模块发现】给定 mcp_id，读取 mcp_tool_definition 返回该服务下全部工具（id/tool_code/display_name/description/is_active）。\n用途：从返回工具里挑相关工具，把 {mcpId: <mcp_id>, toolId: <工具 id>} 放进 agent_ui_create 的 mcpTools 数组（总工具数≤10）。",
            json!({ "type": "object", "properties": { "mcp_id": { "type": "string", "description": "来自 agent_list_mcps 的 MCP 服务 id" } }, "required": ["mcp_id"] }),
        ),
        tool(
            "agent_list_plugins",
            "【模块发现】读取 user_plugin_tool，列出全部本地插件（FaaS）。返回 id/name/identifier/description/runtime/enabled/scenario。\n用途：为 agent_ui_create 的 pluginIds 选值（数组，≤10）。返回 {rows:[...], count}。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_list_kbs",
            "【模块发现】读取 knowledge_base，列出全部知识库。返回 id/identifier/name/description/scenario/file_count。\n用途：为 agent_ui_create 的 kbIds 选值（数组，无上限）；绑定后智能体获得 native__kb_search 检索能力。合同/文档类智能体应优先绑定相关语料库。返回 {rows:[...], count}。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_list_scenarios",
            "【模块发现】读取 scenario_category（默认 scope='AGENT'），列出智能体场景分类 {id,scope,value,label}。\n用途：为 agent_ui_create 的 scenario 字段选 value（如 office-efficiency / data-analysis / dev-programming）。",
            json!({ "type": "object", "properties": { "scope": { "type": "string", "description": "场景域，默认 AGENT；可选 MCP/SKILL/KB" } } }),
        ),
        // —— 插件模块（百宝箱 → 插件）——
        tool(
            "plugin_list",
            "【插件·发现】列出全部本地插件（FaaS）。返回每行含 id/name/identifier/description/runtime/enabled/scenario。\n用途：为 agent_ui_create 的 pluginIds 选值（数组，≤10）；或定位 identifier 做编辑/删除。",
            json!({ "type": "object", "properties": { "scenario": { "type": "string", "description": "场景 key（可选，按场景过滤）" } } }),
        ),
        tool(
            "plugin_get",
            "【插件·查】按 id 查询单个插件（含 scriptContent 完整脚本）。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "plugin_upsert",
            "【插件·自编写/增/改】创建或更新插件（id 空=新建）。\n这是「插件自编写」核心入口：把一段 run(params) 函数 + 头注释元数据写入 platform（落 user_plugin_tool 表，script_content 字段），平台以 custom__<identifier> 注册为智能体工具。\n【字段】id(可选,空则新建) / name(必填) / identifier(必填,slug,^[a-z0-9][a-z0-9_-]{1,47}$,不得含 native__/mcp__/skill__/custom__ 前缀) / description(必填) / runtime(必填,'python'|'bun'，注意：本系统无 node，TypeScript 用 'bun') / scriptContent(必填,用户核心代码，仅 run+头注释) / parametersSchema(必填,JSON Schema 对象) / dependencies(可选,依赖数组如['requests']) / sampleParams(可选,试跑示例参数) / enabled(可选,默认true) / timeoutSec(可选,秒,默认60,硬上限300) / scenario(可选)。\n【脚本范式】Python 头注释用 \"\"\"name/description/dependencies/parameters\"\"\"；Bun/TS 用 JSDoc /** ... */。函数签名固定 def run(params): / export async function run(params)。详见 Skill 内 scripts/ 目录的标准范式模板。",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "空=新建，否则按 id 更新" },
                "name": { "type": "string" },
                "identifier": { "type": "string", "description": "slug，不含 custom__ 前缀" },
                "description": { "type": "string" },
                "runtime": { "type": "string", "enum": ["python", "bun"], "description": "脚本运行期（无 node）" },
                "scriptContent": { "type": "string", "description": "用户核心代码（run + 头注释）" },
                "parametersSchema": { "type": "object", "description": "JSON Schema 对象" },
                "dependencies": { "type": "array", "items": { "type": "string" } },
                "sampleParams": { "type": "object" },
                "enabled": { "type": "boolean" },
                "timeoutSec": { "type": "number" },
                "scenario": { "type": "string" }
            }, "required": ["name", "identifier", "description", "runtime", "scriptContent", "parametersSchema"] }),
        ),
        tool(
            "plugin_delete",
            "【插件·删】真实删除插件（级联清理 agent_plugin_ref；run_log 由 Rust 侧按需清理）。\n⚠️ 为真实不可逆删除，请显式传入 id，谨慎使用；测试数据清理请故意、显式进行，以便人工抽查留痕。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "plugin_set_enabled",
            "【插件·启停】切换插件启用/禁用（enabled=0/1）。",
            json!({ "type": "object", "properties": { "id": { "type": "string" }, "enabled": { "type": "boolean" } }, "required": ["id", "enabled"] }),
        ),
        tool(
            "plugin_test",
            "【插件·试跑】端到端试跑插件：读 DB → 拼 Runner → 沙箱执行（python 走 micromamba，bun 走 bun）→ exit 42 依赖自愈 → 写 plugin_run_log。\n返回 PluginTestResult{ok,callId,durationMs,exitCode,result,stdout,stderr,depsInstalled,errorType,missingPackage,errorMessage,traceback}。params 缺省回退 sampleParams→{}。",
            json!({ "type": "object", "properties": { "pluginId": { "type": "string" }, "params": { "type": "object", "description": "试跑入参（覆盖 sampleParams）" } }, "required": ["pluginId"] }),
        ),
        tool(
            "plugin_extract_meta",
            "【插件·解析】从脚本头注释解析元数据（name/description/dependencies/parameters→JSON Schema），不落库。用于自编写时先校验/预览元数据。",
            json!({ "type": "object", "properties": { "runtime": { "type": "string", "enum": ["python", "bun"] }, "script": { "type": "string" } }, "required": ["runtime", "script"] }),
        ),
        tool(
            "plugin_list_run_logs",
            "【插件·日志】列出某插件最近执行日志（plugin_run_log，按时间倒序，limit 默认 50）。",
            json!({ "type": "object", "properties": { "pluginId": { "type": "string" }, "limit": { "type": "number" } }, "required": ["pluginId"] }),
        ),
        // —— 知识库模块 ——
        tool(
            "kb_list",
            "【KB·发现】列出全部知识库（knowledge_base）。返回 id/identifier/name/description/scenario/file_count。\n用途：为 agent_ui_create 的 kbIds 选值（数组，无上限）；绑定后智能体获得 native__kb_search 检索能力。",
            json!({ "type": "object", "properties": { "scenarioFilter": { "type": "string", "description": "场景 key（可选）" } } }),
        ),
        tool(
            "kb_get",
            "【KB·查】按 id 查询单个知识库（含派生 path）。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "kb_create",
            "【KB·创建】新建知识库：建物理目录 + 写 knowledge_base 行 + 扫描初始资产。\n【字段】identifier(必填,唯一 slug,同时是磁盘目录名) / name(必填) / description(可选) / logo(可选) / scenario(可选场景 value)。",
            json!({ "type": "object", "properties": {
                "identifier": { "type": "string" },
                "name": { "type": "string" },
                "description": { "type": "string" },
                "logo": { "type": "string" },
                "scenario": { "type": "string" }
            }, "required": ["identifier", "name"] }),
        ),
        tool(
            "kb_update",
            "【KB·编辑】更新知识库元数据（名称/简介/Logo/场景/唯一标识）；identifier 变化会同步重命名物理目录。",
            json!({ "type": "object", "properties": {
                "id": { "type": "string" },
                "identifier": { "type": "string" },
                "name": { "type": "string" },
                "description": { "type": "string" },
                "logo": { "type": "string" },
                "scenario": { "type": "string" }
            }, "required": ["id", "name"] }),
        ),
        tool(
            "kb_delete",
            "【KB·删除】删除知识库：级联清理 LanceDB 向量段 + 删 knowledge_asset 行 + 删 knowledge_base 行 + 删物理目录。\n⚠️ 真实不可逆删除，请显式传入 id，谨慎使用；测试数据清理请故意、显式进行，以便人工抽查留痕。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "kb_list_assets",
            "【KB·资产】列出某知识库全部资产（knowledge_asset）：id/name/type/fileExt/fileSize/filePath/digest/indexedAt。",
            json!({ "type": "object", "properties": { "kbId": { "type": "string" } }, "required": ["kbId"] }),
        ),
        tool(
            "kb_add_file",
            "【KB·新增文件】在知识库内写一段文本内容（如新建 Markdown），并自动 refreshAssets 触发增量索引同步（新增/变化资产 fire-and-forget 调 kb_sync_asset）。\n入参：kbId(必填) / relPath(必填,相对根目录路径如 docs/a.md) / content(必填,文本)。返回刷新后的 {ok,fileCount,fileSize}。",
            json!({ "type": "object", "properties": {
                "kbId": { "type": "string" },
                "relPath": { "type": "string", "description": "相对知识库根目录路径，如 docs/a.md" },
                "content": { "type": "string" }
            }, "required": ["kbId", "relPath", "content"] }),
        ),
        tool(
            "kb_import_file",
            "【KB·导入文件】向知识库导入二进制文件（落盘 + 触发索引）。content 以 base64 编码传入。\n入参：kbId(必填) / relPath(必填) / base64(必填)。返回刷新后的 {ok,fileCount,fileSize}。",
            json!({ "type": "object", "properties": {
                "kbId": { "type": "string" },
                "relPath": { "type": "string" },
                "base64": { "type": "string", "description": "文件字节的 base64" }
            }, "required": ["kbId", "relPath", "base64"] }),
        ),
        tool(
            "kb_create_folder",
            "【KB·建文件夹】在知识库内新建文件夹（仅落盘，不写库、不触发索引）。",
            json!({ "type": "object", "properties": { "kbId": { "type": "string" }, "relPath": { "type": "string" } }, "required": ["kbId", "relPath"] }),
        ),
        tool(
            "kb_remove_file",
            "【KB·移除文件】删除知识库内文件/目录：删磁盘条目 + deleteAssetsUnderPath 清库 + 对每个资产 fireKbRemoveAsset 同步删除 LanceDB 向量段（按 kb_id='..' AND asset_id='..' 谓词）。\n⚠️ 会同步删除已索引向量，请确认后操作。",
            json!({ "type": "object", "properties": { "kbId": { "type": "string" }, "relPath": { "type": "string" } }, "required": ["kbId", "relPath"] }),
        ),
        tool(
            "kb_rebuild_index",
            "【KB·重建索引】全量重建知识库向量索引（异步 spawn，含重入单飞保护；逐资产 force 重切重嵌）。返回 spawn 受理结果 {started,reason?}。进度经 Tauri 事件 agent-kb-index-progress 推送。",
            json!({ "type": "object", "properties": { "kbId": { "type": "string" } }, "required": ["kbId"] }),
        ),
        tool(
            "kb_add_tag",
            "【KB·打标签·增】给指定资产（文件）追加一个标签（写入 knowledge_asset.meta_data.tags 数组；已存在则幂等忽略）。\n入参：kbId(必填) / assetId(必填,目标文件资产 id) / tag(必填,标签文本,自动 trim)。返回 {ok,existed,tags}（tags=操作后完整标签数组）。标签读取可经 kb_list_assets 的 metaData.tags。",
            json!({ "type": "object", "properties": {
                "kbId": { "type": "string", "description": "知识库 id" },
                "assetId": { "type": "string", "description": "目标文件资产 id（kb_list_assets 取）" },
                "tag": { "type": "string", "description": "标签文本" }
            }, "required": ["kbId", "assetId", "tag"] }),
        ),
        tool(
            "kb_remove_tag",
            "【KB·打标签·删】从指定资产移除一个标签（从 meta_data.tags 过滤掉）。\n入参：kbId(必填) / assetId(必填) / tag(必填)。返回 {ok,removed,tags}。",
            json!({ "type": "object", "properties": {
                "kbId": { "type": "string" },
                "assetId": { "type": "string" },
                "tag": { "type": "string" }
            }, "required": ["kbId", "assetId", "tag"] }),
        ),
        tool(
            "kb_rename_tag",
            "【KB·打标签·改】在指定资产内把某标签改名（保持原顺序）。\n入参：kbId(必填) / assetId(必填) / from(必填,原标签) / to(必填,新标签)。返回 {ok,renamed,tags}。",
            json!({ "type": "object", "properties": {
                "kbId": { "type": "string" },
                "assetId": { "type": "string" },
                "from": { "type": "string", "description": "原标签文本" },
                "to": { "type": "string", "description": "新标签文本" }
            }, "required": ["kbId", "assetId", "from", "to"] }),
        ),
        tool(
            "kb_get_tags",
            "【KB·打标签·查】读取指定资产（文件）当前的全部标签（解析 knowledge_asset.meta_data.tags 数组）。\n入参：kbId(必填) / assetId(必填,目标文件资产 id)。返回 {assetId,tags}（tags=该文件标签字符串数组）。Agent 判读/检索某文件主题时用。",
            json!({ "type": "object", "properties": {
                "kbId": { "type": "string", "description": "知识库 id" },
                "assetId": { "type": "string", "description": "目标文件资产 id（kb_list_assets 取）" }
            }, "required": ["kbId", "assetId"] }),
        ),
        // —— 记忆宫殿模块（设置 → 记忆宫殿）——
        tool(
            "memory_list",
            "【记忆·列】列出记忆宫殿全部记忆（agent_memories，全局视图；分类/关键词过滤在 UI 端做，这里透传 agentId/category/query 给后端）。返回 MemoryItem[]{id,agentId,sessionId,key,content,category,refCount,anchored,lastRecalledAt,createdAt,updatedAt}。",
            json!({ "type": "object", "properties": {
                "agentId": { "type": "string", "description": "归属智能体 id（可选，NULL=全局）" },
                "category": { "type": "string", "description": "分类枚举 decision/code_pattern/user_pref/architecture/fix/other" },
                "query": { "type": "string" }
            } }),
        ),
        tool(
            "memory_heatmap",
            "【记忆·热力图】按日聚合召回次数（agent_memory_events），返回 HeatmapPoint[]{date,count}。",
            json!({ "type": "object", "properties": { "agentId": { "type": "string" } } }),
        ),
        tool(
            "memory_anchor",
            "【记忆·锚定/自编写】新增或更新一条记忆（UPSERT，同 agentId+key 存在则更新 content/category 保留 refCount）。\n入参（即 AnchorMemoryInput）：agentId(可选) / sessionId(可选) / key(必填,短标题) / content(必填,记忆正文) / category(可选,默认 'other'，切勿留空依赖 SQL 默认 'general') / anchored(可选,默认 true)。",
            json!({ "type": "object", "properties": {
                "agentId": { "type": "string" },
                "sessionId": { "type": "string" },
                "key": { "type": "string" },
                "content": { "type": "string" },
                "category": { "type": "string", "description": "decision/code_pattern/user_pref/architecture/fix/other，默认 other" },
                "anchored": { "type": "boolean" }
            }, "required": ["key", "content"] }),
        ),
        tool(
            "memory_update",
            "【记忆·编辑】更新某条记忆（仅更新非空字段，key/content 变更后重算向量）。",
            json!({ "type": "object", "properties": {
                "id": { "type": "string" },
                "key": { "type": "string" },
                "content": { "type": "string" },
                "category": { "type": "string" }
            }, "required": ["id"] }),
        ),
        tool(
            "memory_delete",
            "【记忆·删除】删除一条记忆（DELETE agent_memories 级联清事件 + 删 LanceDB 向量）。\n⚠️ 真实不可逆删除，请显式传入 id，谨慎使用；测试数据清理请故意、显式进行，以便人工抽查留痕。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "memory_recall",
            "【记忆·召回】手动召回一次（refCount+1、写 recall 事件、emit agent-memory-recalled）。返回更新后的 MemoryItem。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "memory_list_candidates",
            "【记忆·蒸馏候选】列出待确认蒸馏候选（agent_memory_candidates status='pending'）。",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "memory_confirm_candidate",
            "【记忆·采纳候选】采纳一条蒸馏候选（过 M0 护栏+去噪后转入 agent_memories，候选置 confirmed）。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
        tool(
            "memory_reject_candidate",
            "【记忆·忽略候选】忽略一条蒸馏候选（候选置 rejected）。",
            json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }),
        ),
    ])
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema
    })
}
