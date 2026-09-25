//! 平台网络出口统一代理策略。
//!
//! 所有对外 HTTP 请求（LLM 连通性探测、智能体 LLM 调用、MCP 等）都应经过本模块，
//! 以遵循 `app_config.network_proxy` 的三模式（direct / system / manual），而非各调用点
//! 各自 `reqwest::Client::new()`——后者会沿用 reqwest 默认行为（读取系统代理），导致开
//! VPN 时私网 / 本机模型（如 192.168.x.x 的 Ollama）被系统代理劫持而返回 502。

use crate::agent::engine::round_compactor::get_pool;
use crate::agent::types::NetworkProxy;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;

/// 从 `app_config.network_proxy` 读取代理配置（缺失 / 解析失败回退 direct）。
pub async fn load_network_proxy(pool: &SqlitePool) -> NetworkProxy {
    let row = sqlx::query("SELECT value FROM app_config WHERE key = 'network_proxy'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    match row {
        Some(r) => {
            let raw = r.try_get::<Option<String>, _>("value").ok().flatten();
            match raw {
                Some(s) => serde_json::from_str::<NetworkProxy>(&s).unwrap_or_default(),
                None => NetworkProxy::default(),
            }
        }
        None => NetworkProxy::default(),
    }
}

/// 把代理配置应用到 reqwest `ClientBuilder`。
///
/// - `direct`：`.no_proxy()`，彻底无视系统代理（开 VPN 也能直连 LAN / 本机模型）；
/// - `manual`：按 `http` / `https` / `socks5` 字段设置代理（任一条失败则跳过，不阻断整体）；
/// - `system` / 未知：沿用 reqwest 默认（读取系统代理）。
pub fn apply_proxy(mut builder: reqwest::ClientBuilder, proxy: &NetworkProxy) -> reqwest::ClientBuilder {
    match proxy.mode.to_lowercase().as_str() {
        "direct" => {
            builder = builder.no_proxy();
        }
        "manual" => {
            if let Some(http) = &proxy.http {
                if let Ok(p) = reqwest::Proxy::http(http.clone()) {
                    builder = builder.proxy(p);
                }
            }
            if let Some(https) = &proxy.https {
                if let Ok(p) = reqwest::Proxy::https(https.clone()) {
                    builder = builder.proxy(p);
                }
            }
            if let Some(socks5) = &proxy.socks5 {
                if let Ok(p) = reqwest::Proxy::all(socks5.clone()) {
                    builder = builder.proxy(p);
                }
            }
        }
        _ => {}
    }
    builder
}

/// 构建遵循 `network_proxy` 的 reqwest 客户端（best-effort：任何失败回退默认客户端）。
pub async fn platform_client(app: &AppHandle) -> reqwest::Client {
    match get_pool(app).await {
        Ok(pool) => {
            let proxy = load_network_proxy(&pool).await;
            apply_proxy(reqwest::Client::builder(), &proxy)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        }
        Err(_) => reqwest::Client::new(),
    }
}

#[derive(Debug, Serialize)]
pub struct HttpProbeResult {
    pub status: u16,
    pub body: String,
}

/// 连通性探测命令：按 `network_proxy` 建客户端发起最小请求，返回状态码与响应体。
/// 前端 `modelTest.ts` 的 `classify()` 据此细分判定；TS 侧仍负责 URL 形态识别与请求体构造。
#[tauri::command]
pub async fn http_probe(
    app: AppHandle,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpProbeResult, String> {
    let client = platform_client(&app).await;
    let method = if method.eq_ignore_ascii_case("GET") {
        reqwest::Method::GET
    } else {
        reqwest::Method::POST
    };
    let mut req = client
        .request(method, &url)
        .timeout(Duration::from_secs(30));
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let Some(b) = &body {
        req = req.body(b.clone());
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            Ok(HttpProbeResult { status, body: text })
        }
        Err(e) => Err(format!("探测请求失败：{e}")),
    }
}
