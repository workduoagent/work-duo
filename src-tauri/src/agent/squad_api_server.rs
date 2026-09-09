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

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::net::TcpStream;
use std::time::Duration;

use sqlx::Row;

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;

use crate::agent::commands::load_squad;
use crate::agent::squad_orchestrator::run_squad_task;

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
        }
        (method, path, auth)
    };
    // reader 离开作用域，释放对 stream 的借用，随后可写回。

    let (status, body) = tauri::async_runtime::block_on(async {
        route(&app, &request.0, &request.1, request.2.as_deref()).await
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
        return match load_squad(app, &resolved).await {
            Ok(cfg) => {
                let prompt = cfg
                    .run_strategy
                    .schedule_prompt
                    .clone()
                    .unwrap_or_default();
                run_squad_task(app, cfg, prompt).await;
                (200, "{\"ok\":true}".to_string())
            }
            Err(e) => (404, err_json(&e)),
        };
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
