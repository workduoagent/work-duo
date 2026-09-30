//! 小分队 API 触发服务（api 模式真触发）。
//!
//! 在 app 启动时由 lib.rs 的 setup() 调用 `start_api_server(app)` 拉起一个**本地 TCP HTTP 服务**
//! （手写极简实现，零新增网络依赖），监听 `127.0.0.1:<port>`：
//!   - `POST /api/squads/:id/run`：经 Bearer（`Authorization`）或 `?token=` 校验 `squad_api_token`，
//!     校验通过则经 `load_squad` + `run_squad_task` 触发执行；
//!   - `GET  /api/health`：健康检查，返回 `{"ok":true}`。
//!
//! 开关 `squad_api_enabled`、端口 `squad_api_port`、令牌 `squad_api_token` 均存于 app_config，
//! 每次请求实时读取 —— 改令牌/开关无需重启（端口变更需重启服务）。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::net::TcpStream;
use std::time::Duration;

use sqlx::Row;

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;

use crate::agent::squad::config::load_squad;
use crate::agent::squad::squad_orchestrator::{run_squad_task, SquadContractTask};

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

/// 启动本地 API 触发服务（在 app setup 中调用，独立 std 线程）。
pub fn start_api_server(app: AppHandle) {
    std::thread::spawn(move || {
        let (enabled, port) = tauri::async_runtime::block_on(async {
            let pool = match get_pool(&app).await {
                Ok(p) => p,
                Err(_) => return (false, 3939u16),
            };
            // S3 批次3（§4.10-3）：启动清扫——上一进程遗留半终态会话收敛为 failed。
            let enabled = read_cfg(&pool, "squad_api_enabled").await.as_deref() == Some("true");
            let port = read_cfg(&pool, "squad_api_port")
                .await
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(3939);
            (enabled, port)
        });

        if !enabled {
            tracing::info!("[api] 小分队 API 服务未启用（app_config.squad_api_enabled != 'true'），跳过监听");
            return;
        }

        let addr = format!("127.0.0.1:{port}");
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                tracing::info!("[api] 无法绑定 {addr}：{e}");
                return;
            }
        };
        tracing::info!("[api] 小分队 API 服务已启动：{addr}");
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    let app2 = app.clone();
                    std::thread::spawn(move || handle_conn(s, app2));
                }
                Err(e) => tracing::info!("[api] accept 错误：{e}"),
            }
        }
    });
}

/// 处理单个 HTTP 连接：读取请求行 + 头部，路由后回写 JSON 响应。
fn handle_conn(mut stream: TcpStream, app: AppHandle) {
    // 限定读取超时，避免挂死线程。
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));

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

        let mut auth: Option<String> = None;
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                break;
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some(rest) = l.strip_prefix("Authorization:") {
                auth = Some(rest.trim().to_string());
            }
            if let Some(rest) = l.strip_prefix("Content-Length:") {
                content_length = rest.trim().parse::<usize>().unwrap_or(0);
            }
        }
        // S2：读请求体（/inject 需要 JSON body；上限 64KB 防滥用）。
        let body = if content_length > 0 && content_length <= 64 * 1024 {
            let mut buf = vec![0u8; content_length];
            if reader.read_exact(&mut buf).is_ok() {
                Some(String::from_utf8_lossy(&buf).to_string())
            } else {
                None
            }
        } else {
            None
        };
        (method, path, auth, body)
    };
    // reader 离开作用域，释放对 stream 的借用，随后可写回。

    let (status, body) = tauri::async_runtime::block_on(async {
        route(&app, &request.0, &request.1, request.2.as_deref(), request.3.as_deref()).await
    });

    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

/// 路由处理。
async fn route(
    app: &AppHandle,
    method: &str,
    path: &str,
    auth: Option<&str>,
    body: Option<&str>,
) -> (u16, String) {
    if method == "GET" && path == "/api/health" {
        return (200, "{\"ok\":true}".to_string());
    }

    if method == "POST" && path.starts_with("/api/squads/") && path.ends_with("/run") {
        let id = &path["/api/squads/".len()..path.len() - "/run".len()];
        if id.is_empty() {
            return (400, err_json("missing squad id"));
        }
        let token = auth
            .and_then(|a| {
                if let Some(t) = a.strip_prefix("Bearer ") {
                    Some(t.trim().to_string())
                } else {
                    Some(a.trim().to_string())
                }
            })
            .or_else(|| extract_query_token(path));

        let pool = match get_pool(app).await {
            Ok(p) => p,
            Err(e) => return (500, err_json(&e)),
        };
        let cfg_token = read_cfg(&pool, "squad_api_token").await.unwrap_or_default();
        if cfg_token.is_empty() || token.as_deref() != Some(cfg_token.as_str()) {
            return (401, "{\"ok\":false,\"error\":\"unauthorized\"}".to_string());
        }

        let resolved = match resolve_squad_id(&pool, id).await {
            Some(rid) => rid,
            None => return (404, err_json("squad not found")),
        };
        // S3 批次3（§8）：body 可带 {prompt, contract, wait}——prompt 覆盖 schedule_prompt；
        // contract=外部直接给委派计划（跳过主管规划与 L1 门禁）；wait=false 异步触发立即返回 sessionId。
        let (body_prompt, contract_tasks, wait) = match body {
            Some(raw) if !raw.trim().is_empty() => match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(v) => (
                    v.get("prompt").and_then(|x| x.as_str()).map(|s| s.to_string()),
                    v.get("contract")
                        .and_then(|x| x.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|t| serde_json::from_value::<SquadContractTask>(t.clone()).ok())
                                .collect::<Vec<SquadContractTask>>()
                        })
                        .filter(|c| !c.is_empty()),
                    v.get("wait").and_then(|x| x.as_bool()).unwrap_or(true),
                ),
                Err(_) => (None, None, true),
            },
            _ => (None, None, true),
        };
        return match load_squad(app, &resolved).await {
            Ok(cfg) => {
                let prompt = body_prompt
                    .or(cfg.run_strategy.schedule_prompt.clone())
                    .unwrap_or_default();
                if wait {
                    // 阻塞至终态（既有语义，外部可轮询 DB 配合）。
                    let session_id = run_squad_task(app, cfg, prompt, contract_tasks, None).await;
                    (200, format!("{{\"ok\":true,\"sessionId\":\"{session_id}\",\"waited\":true}}"))
                } else {
                    // 异步触发（§8）：预生成 session_id 立即返回，任务后台跑。
                    let session_id = format!(
                        "sqs_{}_{}",
                        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_else(|| {
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_nanos() as i64)
                                .unwrap_or(0)
                        }),
                        crate::agent::squad::squad_orchestrator::next_session_seq()
                    );
                    let app2 = app.clone();
                    let session_id2 = session_id.clone();
                    tauri::async_runtime::spawn(async move {
                        run_squad_task(&app2, cfg, prompt, contract_tasks, Some(session_id2)).await;
                    });
                    (200, format!("{{\"ok\":true,\"sessionId\":\"{session_id}\",\"waited\":false}}"))
                }
            }
            Err(e) => (404, err_json(&e)),
        };
    }

    // S3 批次3（§4.10）：外部暂停——完成当前节点后挂起（波次/层/发言轮边界），状态 paused。
    if method == "POST" && path.starts_with("/api/squads/") && path.ends_with("/pause") {
        let id = &path["/api/squads/".len()..path.len() - "/pause".len()];
        if id.is_empty() {
            return (400, err_json("squad id 为空"));
        }
        let pool = match get_pool(app).await {
            Ok(p) => p,
            Err(e) => return (500, err_json(&e)),
        };
        let resolved = match resolve_squad_id(&pool, id).await {
            Some(rid) => rid,
            None => return (404, err_json("squad not found")),
        };
        let n = crate::agent::squad::squad_orchestrator::squad_pause_sessions(&resolved);
        return (200, format!("{{\"ok\":true,\"paused_sessions\":{n}}}"));
    }

    // S3 批次3（§4.10）：外部恢复——body 缺省（或 {sessionId 缺省}）= 同进程清暂停标志；
    // body 带 {sessionId} 且该会话已无存活协程 = 从 BoardState 重入续跑（crash 恢复）。
    if method == "POST" && path.starts_with("/api/squads/") && path.ends_with("/resume") {
        let id = &path["/api/squads/".len()..path.len() - "/resume".len()];
        if id.is_empty() {
            return (400, err_json("squad id 为空"));
        }
        let pool = match get_pool(app).await {
            Ok(p) => p,
            Err(e) => return (500, err_json(&e)),
        };
        let resolved = match resolve_squad_id(&pool, id).await {
            Some(rid) => rid,
            None => return (404, err_json("squad not found")),
        };
        let explicit_session = body
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|v| {
                v.get("sessionId")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            });
        match explicit_session {
            Some(sid) => {
                return match crate::agent::squad::squad_orchestrator::resume_squad_session(app, &resolved, &sid).await {
                    Ok(r) => (200, format!("{{\"ok\":true,\"resumed\":\"reenter\",\"sessionId\":\"{r}\"}}")),
                    Err(e) => (400, err_json(&e)),
                };
            }
            None => {
                let n = crate::agent::squad::squad_orchestrator::squad_resume_sessions(&resolved);
                return (200, format!("{{\"ok\":true,\"resumed\":\"unpark\",\"resumed_sessions\":{n}}}"));
            }
        }
    }

    // S0-5（2026-09-28）：外部取消入口——对指定小分队的全部活跃会话置取消信号。
    if method == "POST" && path.starts_with("/api/squads/") && path.ends_with("/cancel") {
        let id = &path["/api/squads/".len()..path.len() - "/cancel".len()];
        if id.is_empty() {
            return (400, err_json("squad id 为空"));
        }
        let pool = match get_pool(app).await {
            Ok(p) => p,
            Err(e) => return (500, err_json(&e)),
        };
        let resolved = match resolve_squad_id(&pool, id).await {
            Some(rid) => rid,
            None => return (404, err_json("squad not found")),
        };
        let n = crate::agent::squad::squad_orchestrator::cancel_squad_sessions(&resolved);
        return (200, format!("{{\"ok\":true,\"cancelled_sessions\":{n}}}"));
    }

    // S2（§4.11）：外部插话入口——body JSON {sessionId?, taskId, content, mode?}。
    // sessionId 缺省时解析该小分队最新的 running 会话；鉴权口径与 /cancel 一致（本机回环）。
    if method == "POST" && path.starts_with("/api/squads/") && path.ends_with("/inject") {
        let id = &path["/api/squads/".len()..path.len() - "/inject".len()];
        if id.is_empty() {
            return (400, err_json("squad id 为空"));
        }
        let Some(raw) = body else {
            return (400, err_json("missing JSON body"));
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            return (400, err_json("invalid JSON body"));
        };
        let task_id = v.get("taskId").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let content = v.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let mode = v.get("mode").and_then(|x| x.as_str()).unwrap_or("soft").to_string();
        if task_id.is_empty() {
            return (400, err_json("taskId 为空"));
        }
        let pool = match get_pool(app).await {
            Ok(p) => p,
            Err(e) => return (500, err_json(&e)),
        };
        let resolved = match resolve_squad_id(&pool, id).await {
            Some(rid) => rid,
            None => return (404, err_json("squad not found")),
        };
        let session_id = match v
            .get("sessionId")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(sid) => sid,
            None => {
                match sqlx::query_scalar::<_, String>(
                    "SELECT id FROM agent_squad_session WHERE squad_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
                )
                .bind(&resolved)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                {
                    Some(sid) => sid,
                    None => return (404, err_json("no running session for squad")),
                }
            }
        };
        return match crate::agent::squad::squad_orchestrator::squad_inject_send(
            app, &pool, &resolved, &session_id, &task_id, &content, &mode,
        )
        .await
        {
            Ok(inject_id) => (
                200,
                format!("{{\"ok\":true,\"injectId\":\"{inject_id}\",\"sessionId\":\"{session_id}\"}}"),
            ),
            Err(e) => (400, err_json(&e)),
        };
    }

    // S2（§4.6）：三门禁外部决议入口——body JSON {sessionId?, gate, decision}。
    // gate：plan（L1 计划，decision=approve|reject）| checkpoint（L2 检查点，decision=continue|rework）|
    // delivery（L4 交付确认，decision=approve|reject）。sessionId 缺省取该小分队最新会话。
    if method == "POST" && path.starts_with("/api/squads/") && path.ends_with("/resolve") {
        let id = &path["/api/squads/".len()..path.len() - "/resolve".len()];
        if id.is_empty() {
            return (400, err_json("squad id 为空"));
        }
        let Some(raw) = body else {
            return (400, err_json("missing JSON body"));
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            return (400, err_json("invalid JSON body"));
        };
        let gate = v.get("gate").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let decision = v
            .get("decision")
            .map(|d| {
                if d.is_boolean() {
                    if d.as_bool().unwrap_or(false) { "approve".to_string() } else { "reject".to_string() }
                } else {
                    d.as_str().unwrap_or("").trim().to_string()
                }
            })
            .unwrap_or_default();
        if gate.is_empty() || decision.is_empty() {
            return (400, err_json("gate / decision 为空"));
        }
        let pool = match get_pool(app).await {
            Ok(p) => p,
            Err(e) => return (500, err_json(&e)),
        };
        let resolved = match resolve_squad_id(&pool, id).await {
            Some(rid) => rid,
            None => return (404, err_json("squad not found")),
        };
        let session_id = match v
            .get("sessionId")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(sid) => sid,
            None => {
                match sqlx::query_scalar::<_, String>(
                    "SELECT id FROM agent_squad_session WHERE squad_id = ? ORDER BY created_at DESC LIMIT 1",
                )
                .bind(&resolved)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                {
                    Some(sid) => sid,
                    None => return (404, err_json("no session for squad")),
                }
            }
        };
        use crate::agent::squad::squad_orchestrator as orch;
        let hit = match gate.as_str() {
            "plan" => orch::resolve_plan_gate(&session_id, decision == "approve"),
            "checkpoint" => orch::resolve_squad_checkpoint(&session_id, &decision),
            "delivery" => orch::resolve_squad_delivery(&session_id, decision == "approve"),
            other => return (400, err_json(&format!("未知 gate：{other}"))),
        };
        tracing::info!("[api] /resolve：session={session_id} gate={gate} decision={decision} hit={hit}");
        return (200, format!("{{\"ok\":true,\"resolved\":{hit}}}"));
    }

    (404, "{\"ok\":false,\"error\":\"not found\"}".to_string())
}

/// 从 `?token=xxx` 查询串提取令牌。
fn extract_query_token(path: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("token=") {
            return Some(v.to_string());
        }
    }
    None
}

fn err_json(msg: &str) -> String {
    format!("{{\"ok\":false,\"error\":\"{}\"}}", msg.replace('"', "'"))
}

/// 按内部 id 或 unique_id 解析出小分队 id（外部触发既可用内部 id，也可用唯一标识）。
async fn resolve_squad_id(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM agent_squad WHERE id = ?1 OR unique_id = ?1 LIMIT 1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}
