//! MCP OAuth2 授权（通用实现，补全 `authType=OAUTH2` 的真实链路）。
//!
//! 覆盖任意 MCP Streamable HTTP 保护资源的浏览器授权：
//!   1. 发现 `/.well-known/oauth-protected-resource` + 授权服务器元数据（RFC 8414 / 9728）；
//!   2. 动态客户端注册（RFC 7591，public client，`token_endpoint_auth_method=none`）；
//!   3. PKCE（RFC 7636，S256）授权码流程，本地回环端口收 `redirect_uri`；
//!   4. 换取 / 刷新 access_token，结果写入 `mcp_info.auth_config.oauth`。
//!
//! 设计约束：
//!   - 回调只绑定 `127.0.0.1`，校验 `state`，不落日志 token 明文；
//!   - 与既有 `NONE` / `API_KEY` 路径完全正交——未走 OAuth 时不改任何请求头；
//!   - `call_mcp_tool` / `sync_mcp_tools` 经 [`oauth_bearer`] 自动带 Bearer，并尽量自动刷新。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

/* ------------------------------------------------------------------ *
 * 对外类型
 * ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOauthBeginRequest {
    /// 受保护 MCP 端点（如 https://api.gatemcp.ai/mcp/exchange）。
    pub endpoint_url: String,
    /// 可选 scope 列表；缺省时取元数据 `scopes_supported`。
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// 注册时展示的客户端名，默认 WorkDuo。
    #[serde(default)]
    pub client_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOauthBeginResponse {
    pub session_id: String,
    /// 浏览器打开此 URL 完成授权。
    pub authorize_url: String,
    pub redirect_uri: String,
}

/// 授权成功后的 token 集（前端合并进 `authConfig.oauth` 落库）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOauthTokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// 毫秒时间戳；0 表示未知（按不自动过期处理）。
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub token_endpoint: Option<String>,
    #[serde(default)]
    pub authorization_server: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOauthWaitResponse {
    pub tokens: McpOauthTokenSet,
}

/* ------------------------------------------------------------------ *
 * 元数据 / 注册
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default, Deserialize)]
struct OauthMetadata {
    #[serde(default)]
    authorization_endpoint: Option<String>,
    #[serde(default)]
    token_endpoint: Option<String>,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
    #[serde(default)]
    authorization_servers: Option<Vec<String>>,
    #[serde(default)]
    issuer: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_b64url(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    rand::thread_rng().fill_bytes(&mut buf);
    B64URL.encode(buf)
}

fn pkce_challenge_s256(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    B64URL.encode(hash)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))
}

async fn fetch_oauth_json(client: &reqwest::Client, url: &str) -> Result<OauthMetadata, String> {
    let res = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("OAuth 元数据请求失败 {url}：{e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "OAuth 元数据不可用 {url}：HTTP {}",
            res.status()
        ));
    }
    res.json::<OauthMetadata>()
        .await
        .map_err(|e| format!("OAuth 元数据解析失败 {url}：{e}"))
}

/// 从资源 URL 出发发现授权服务器元数据。
async fn discover(client: &reqwest::Client, endpoint_url: &str) -> Result<(OauthMetadata, String), String> {
    let trimmed = endpoint_url.trim().trim_end_matches('/');
    let origin = {
        let u = reqwest::Url::parse(trimmed).map_err(|e| format!("endpointUrl 非法：{e}"))?;
        format!(
            "{}://{}",
            u.scheme(),
            u.host_str().ok_or("endpointUrl 缺少主机")?
        )
    };

    // RFC 9728：资源元数据；同时兼容授权服务器元数据直出（如 api.gatemcp.ai）。
    let candidates = [
        format!("{origin}/.well-known/oauth-protected-resource"),
        format!("{origin}/.well-known/oauth-authorization-server"),
        format!("{origin}/.well-known/openid-configuration"),
    ];

    let mut auth_servers: Vec<String> = Vec::new();
    let mut meta = OauthMetadata::default();
    let mut saw_any = false;

    for cand in &candidates {
        if let Ok(m) = fetch_oauth_json(client, cand).await {
            saw_any = true;
            if let Some(list) = m.authorization_servers.clone() {
                auth_servers.extend(list);
            }
            if m.authorization_endpoint.is_some() || m.token_endpoint.is_some() {
                if meta.authorization_endpoint.is_none() {
                    meta.authorization_endpoint = m.authorization_endpoint.clone();
                }
                if meta.token_endpoint.is_none() {
                    meta.token_endpoint = m.token_endpoint.clone();
                }
                if meta.registration_endpoint.is_none() {
                    meta.registration_endpoint = m.registration_endpoint.clone();
                }
                if meta.scopes_supported.is_none() {
                    meta.scopes_supported = m.scopes_supported.clone();
                }
                if meta.issuer.is_none() {
                    meta.issuer = m.issuer.clone();
                }
            }
        }
    }

    if !saw_any {
        return Err(
            "未发现 OAuth 元数据（/.well-known/oauth-protected-resource 等均不可用），该端点可能无需或未启用 OAuth2"
                .into(),
        );
    }

    // 若仅有 authorization_servers，再拉权威元数据。
    if meta.token_endpoint.is_none() {
        for as_url in &auth_servers {
            let base = as_url.trim().trim_end_matches('/');
            for path in [
                "/.well-known/oauth-authorization-server",
                "/.well-known/openid-configuration",
            ] {
                if let Ok(m) = fetch_oauth_json(client, &format!("{base}{path}")).await {
                    if m.token_endpoint.is_some() {
                        meta = m;
                        break;
                    }
                }
            }
            if meta.token_endpoint.is_some() {
                break;
            }
        }
    }

    let token_endpoint = meta
        .token_endpoint
        .clone()
        .ok_or("OAuth 元数据缺少 token_endpoint")?;
    if meta.authorization_endpoint.is_none() {
        return Err("OAuth 元数据缺少 authorization_endpoint".into());
    }
    Ok((meta, token_endpoint))
}

#[derive(Debug, Deserialize)]
struct RegistrationResponse {
    client_id: String,
}

async fn register_client(
    client: &reqwest::Client,
    registration_endpoint: &str,
    redirect_uri: &str,
    client_name: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "client_name": client_name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    });
    let res = client
        .post(registration_endpoint)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OAuth 客户端注册失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "OAuth 客户端注册被拒：HTTP {} {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    let parsed: RegistrationResponse = serde_json::from_str(&text)
        .map_err(|e| format!("OAuth 注册响应解析失败：{e} body={}", text.chars().take(200).collect::<String>()))?;
    Ok(parsed.client_id)
}

/* ------------------------------------------------------------------ *
 * 本地回环回调
 * ------------------------------------------------------------------ */

struct PendingLogin {
    code_verifier: String,
    /// 与回调比对的 state（监听线程已校验，此处仅留档）。
    #[allow(dead_code)]
    state: String,
    client_id: String,
    token_endpoint: String,
    redirect_uri: String,
    authorization_server: String,
    /// 回调线程 → wait：收到 code 或错误。
    code_rx: Mutex<Option<mpsc::Receiver<Result<String, String>>>>,
}

static SESSIONS: Mutex<Option<HashMap<String, PendingLogin>>> = Mutex::new(None);
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

fn with_sessions<T>(f: impl FnOnce(&mut HashMap<String, PendingLogin>) -> T) -> T {
    let mut guard = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    f(guard.as_mut().unwrap())
}

/// 进程级 token 缓存：refresh 后未落库时，同客户端后续请求仍可用新 access_token。
static TOKEN_CACHE: Mutex<Option<HashMap<String, McpOauthTokenSet>>> = Mutex::new(None);

fn with_token_cache<T>(f: impl FnOnce(&mut HashMap<String, McpOauthTokenSet>) -> T) -> T {
    let mut guard = TOKEN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    f(guard.as_mut().unwrap())
}

static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

fn app_slot() -> &'static Mutex<Option<AppHandle>> {
    APP_HANDLE.get_or_init(|| Mutex::new(None))
}

/// 在 app setup 时注入句柄，供 token 刷新后回写 `mcp_info.auth_config`。
pub fn init(app: AppHandle) {
    let mut g = app_slot().lock().unwrap_or_else(|e| e.into_inner());
    *g = Some(app);
}

fn parse_query(target: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let q = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 在 127.0.0.1 临时端口上等一次 OAuth 回调。
fn spawn_callback_listener(
    expected_state: String,
    timeout: Duration,
) -> Result<(u16, mpsc::Receiver<Result<String, String>>), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("绑定回环端口失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取端口失败：{e}"))?
        .port();
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        // 短超时 accept 轮询，到点自动放弃。
        loop {
            if Instant::now() >= deadline {
                let _ = tx.send(Err("OAuth 回调超时（浏览器未完成授权）".into()));
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let raw = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let target = raw
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();
                    let params = parse_query(&target);

                    let result = if let Some(err) = params.get("error") {
                        let desc = params.get("error_description").cloned().unwrap_or_default();
                        Err(format!("授权被拒绝或失败：{err} {desc}"))
                    } else {
                        match (params.get("code"), params.get("state")) {
                            (Some(code), Some(st)) if st == &expected_state => {
                                Ok(code.clone())
                            }
                            (Some(_), Some(_)) => Err("OAuth state 校验失败（疑似 CSRF）".into()),
                            _ => Err("OAuth 回调缺少 code/state".into()),
                        }
                    };

                    let ok_body = "<!doctype html><meta charset=\"utf-8\"><title>WorkDuo</title><div style=\"font-family:sans-serif;padding:32px\">授权成功，可以回到 WorkDuo 继续。</div>";
                    let err_body = "<!doctype html><meta charset=\"utf-8\"><title>WorkDuo</title><div style=\"font-family:sans-serif;padding:32px\">授权失败，请回到 WorkDuo 查看错误。</div>";
                    let (status, body): (&str, &str) = match &result {
                        Ok(_) => ("200 OK", ok_body),
                        Err(_) => ("400 Bad Request", err_body),
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                    let _ = tx.send(result);
                    return;
                }
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
    });

    Ok((port, rx))
}

/* ------------------------------------------------------------------ *
 * Token 交换 / 刷新
 * ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

fn parse_token_json(text: &str) -> Result<TokenResponse, String> {
    serde_json::from_str(text).map_err(|e| {
        format!(
            "token 响应解析失败：{e} body={}",
            text.chars().take(200).collect::<String>()
        )
    })
}

fn to_token_set(
    tr: TokenResponse,
    client_id: &str,
    token_endpoint: &str,
    authorization_server: &str,
) -> McpOauthTokenSet {
    let expires_at = match tr.expires_in {
        Some(sec) if sec > 0 => now_ms() + sec * 1000 - 30_000,
        _ => 0,
    };
    McpOauthTokenSet {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token,
        expires_at,
        token_type: tr.token_type,
        scope: tr.scope,
        client_id: Some(client_id.to_string()),
        token_endpoint: Some(token_endpoint.to_string()),
        authorization_server: Some(authorization_server.to_string()),
    }
}

async fn exchange_code(
    client: &reqwest::Client,
    token_endpoint: &str,
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    code_verifier: &str,
    authorization_server: &str,
) -> Result<McpOauthTokenSet, String> {
    let res = client
        .post(token_endpoint)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("token 交换请求失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "token 交换失败：HTTP {} {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    let tr = parse_token_json(&text)?;
    Ok(to_token_set(
        tr,
        client_id,
        token_endpoint,
        authorization_server,
    ))
}

async fn refresh_tokens(
    client: &reqwest::Client,
    token_endpoint: &str,
    refresh_token: &str,
    client_id: &str,
) -> Result<McpOauthTokenSet, String> {
    let res = client
        .post(token_endpoint)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| format!("token 刷新请求失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "token 刷新失败：HTTP {} {}",
            status,
            text.chars().take(200).collect::<String>()
        ));
    }
    let mut tr = parse_token_json(&text)?;
    // 部分服务刷新不返回新 refresh_token，保留旧值。
    if tr.refresh_token.is_none() {
        tr.refresh_token = Some(refresh_token.to_string());
    }
    Ok(to_token_set(tr, client_id, token_endpoint, token_endpoint))
}

/* ------------------------------------------------------------------ *
 * Tauri 命令
 * ------------------------------------------------------------------ */

/// 发现 + 注册 + 生成授权 URL，并监听本地回调。
#[tauri::command]
pub async fn mcp_oauth_begin(request: McpOauthBeginRequest) -> Result<McpOauthBeginResponse, String> {
    let endpoint = request.endpoint_url.trim().to_string();
    if endpoint.is_empty() {
        return Err("缺少 endpointUrl".into());
    }
    let client = http_client()?;
    let (meta, token_endpoint) = discover(&client, &endpoint).await?;
    let auth_ep = meta
        .authorization_endpoint
        .clone()
        .ok_or("OAuth 元数据缺少 authorization_endpoint")?;

    let session_id = format!(
        "oauth-{}-{}",
        now_ms(),
        SESSION_SEQ.fetch_add(1, Ordering::SeqCst)
    );
    let state = random_b64url(24);
    let code_verifier = random_b64url(48);
    let code_challenge = pkce_challenge_s256(&code_verifier);

    let timeout = Duration::from_secs(180);
    let (port, rx) = spawn_callback_listener(state.clone(), timeout)?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let client_id = match &meta.registration_endpoint {
        Some(reg) => {
            register_client(
                &client,
                reg,
                &redirect_uri,
                request.client_name.as_deref().unwrap_or("WorkDuo"),
            )
            .await?
        }
        None => {
            return Err(
                "OAuth 元数据缺少 registration_endpoint（不支持动态注册），无法自动授权".into(),
            )
        }
    };

    let scopes: Vec<String> = match &request.scopes {
        Some(s) if !s.is_empty() => s.clone(),
        _ => meta.scopes_supported.clone().unwrap_or_default(),
    };

    let mut pairs = vec![
        ("response_type".to_string(), "code".to_string()),
        ("client_id".to_string(), client_id.clone()),
        ("redirect_uri".to_string(), redirect_uri.clone()),
        ("state".to_string(), state.clone()),
        ("code_challenge".to_string(), code_challenge),
        ("code_challenge_method".to_string(), "S256".to_string()),
    ];
    if !scopes.is_empty() {
        pairs.push(("scope".to_string(), scopes.join(" ")));
    }
    let authorize_url = reqwest::Url::parse_with_params(&auth_ep, &pairs)
        .map_err(|e| format!("构造授权 URL 失败：{e}"))?
        .to_string();

    let auth_server = meta.issuer.clone().unwrap_or_else(|| auth_ep.clone());
    with_sessions(|map| {
        map.insert(
            session_id.clone(),
            PendingLogin {
                code_verifier,
                state,
                client_id: client_id.clone(),
                token_endpoint: token_endpoint.clone(),
                redirect_uri: redirect_uri.clone(),
                authorization_server: auth_server.clone(),
                code_rx: Mutex::new(Some(rx)),
            },
        );
    });

    Ok(McpOauthBeginResponse {
        session_id,
        authorize_url,
        redirect_uri,
    })
}

/// 等待浏览器授权完成，返回 token（前端合并进 authConfig 保存）。
#[tauri::command]
pub async fn mcp_oauth_wait(
    session_id: String,
    timeout_sec: Option<u64>,
) -> Result<McpOauthWaitResponse, String> {
    let timeout = Duration::from_secs(timeout_sec.unwrap_or(180));
    // 取出一次性 receiver，避免重复 wait。
    let code_rx = with_sessions(|map| {
        map.get(&session_id)
            .and_then(|p| p.code_rx.lock().ok().and_then(|mut g| g.take()))
    });
    let code_rx = code_rx.ok_or("OAuth 会话不存在或已被消费，请重新发起授权")?;

    let code = tauri::async_runtime::spawn_blocking(move || code_rx.recv_timeout(timeout))
        .await
        .map_err(|e| format!("等待 OAuth 回调线程失败：{e}"))?;

    let code = match code {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            with_sessions(|map| map.remove(&session_id));
            return Err(e);
        }
        Err(_) => {
            with_sessions(|map| map.remove(&session_id));
            return Err("OAuth 回调超时（浏览器未完成授权）".into());
        }
    };

    let pending = with_sessions(|map| map.remove(&session_id));
    let p = pending.ok_or("OAuth 会话已失效，请重新发起授权")?;

    let client = http_client()?;
    let tokens = exchange_code(
        &client,
        &p.token_endpoint,
        &code,
        &p.redirect_uri,
        &p.client_id,
        &p.code_verifier,
        &p.authorization_server,
    )
    .await?;
    cache_put(&tokens);
    Ok(McpOauthWaitResponse { tokens })
}

/// 手动刷新（也可由请求路径自动触发）。
#[tauri::command]
pub async fn mcp_oauth_refresh(
    auth_config: serde_json::Value,
) -> Result<McpOauthWaitResponse, String> {
    let client = http_client()?;
    let tokens = extract_oauth_tokens(&auth_config)
        .ok_or("authConfig 中没有 oauth token，请先完成 OAuth 授权")?;
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or("oauth token 没有 refresh_token，请重新授权")?;
    let token_endpoint = tokens
        .token_endpoint
        .clone()
        .ok_or("oauth token 缺少 token_endpoint")?;
    let client_id = tokens.client_id.clone().unwrap_or_default();
    let mut next = refresh_tokens(&client, &token_endpoint, &refresh_token, &client_id).await?;
    if next.authorization_server.is_none() {
        next.authorization_server = tokens.authorization_server.clone();
    }
    cache_put(&next);
    Ok(McpOauthWaitResponse { tokens: next })
}

/* ------------------------------------------------------------------ *
 * 供 mcp.rs 复用：取 Bearer / 自动刷新
 * ------------------------------------------------------------------ */

fn cache_key(t: &McpOauthTokenSet) -> String {
    if let Some(cid) = &t.client_id {
        return format!("cid:{cid}");
    }
    if let Some(rt) = &t.refresh_token {
        return format!("rt:{rt}");
    }
    t.access_token.clone()
}

fn cache_put(t: &McpOauthTokenSet) {
    with_token_cache(|map| {
        map.insert(cache_key(t), t.clone());
    });
}

/// 从 authConfig 解析 oauth token（兼容 camelCase / snake_case）。
pub fn extract_oauth_tokens(auth_config: &serde_json::Value) -> Option<McpOauthTokenSet> {
    let obj = auth_config.as_object()?;
    let oauth = obj.get("oauth")?.as_object()?;

    let get = |keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(v) = oauth.get(*k) {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() {
                        return Some(s.to_string());
                    }
                }
            }
        }
        None
    };

    let access_token = get(&["accessToken", "access_token"])?;
    let refresh_token = get(&["refreshToken", "refresh_token"]);
    let expires_at = oauth
        .get("expiresAt")
        .or_else(|| oauth.get("expires_at"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let token_type = get(&["tokenType", "token_type"]);
    let scope = oauth.get("scope").and_then(|v| v.as_str()).map(|s| s.to_string());
    let client_id = get(&["clientId", "client_id"]);
    let token_endpoint = get(&["tokenEndpoint", "token_endpoint"]);
    let authorization_server = get(&["authorizationServer", "authorization_server"]);

    Some(McpOauthTokenSet {
        access_token,
        refresh_token,
        expires_at,
        token_type,
        scope,
        client_id,
        token_endpoint,
        authorization_server,
    })
}

fn is_expired(t: &McpOauthTokenSet) -> bool {
    t.expires_at > 0 && now_ms() >= t.expires_at
}

/// 组装 `Authorization: Bearer …`；必要时自动刷新。
///
/// 返回 `Ok(None)` 表示该请求不应注入 OAuth 头（非 OAUTH2 或未配置）。
pub async fn oauth_bearer(
    auth_type: Option<&str>,
    auth_config: &Option<serde_json::Value>,
) -> Result<Option<String>, String> {
    let is_oauth = auth_type
        .map(|s| s.eq_ignore_ascii_case("OAUTH2"))
        .unwrap_or(false);
    // 即便 authType 未标 OAUTH2，只要 authConfig 里有 oauth token 也注入（兼容手填）。
    // 未配置 oauth token 时不报错、不注入——允许用户在 headers 里手写 Authorization。
    let base = match auth_config {
        Some(v) => extract_oauth_tokens(v),
        None => None,
    };
    let base = match base {
        Some(t) => t,
        None => {
            let _ = is_oauth;
            return Ok(None);
        }
    };

    // 内存缓存若更新则优先。
    let cached = with_token_cache(|map| map.get(&cache_key(&base)).cloned());
    let mut tokens = match cached {
        Some(c) if c.access_token.len() >= base.access_token.len() => c,
        _ => base.clone(),
    };

    if is_expired(&tokens) {
        let rt = tokens.refresh_token.clone();
        let te = tokens.token_endpoint.clone().unwrap_or_default();
        let cid = tokens.client_id.clone().unwrap_or_default();
        if rt.is_some() && !te.is_empty() {
            let client = http_client()?;
            let mut next = refresh_tokens(&client, &te, rt.as_deref().unwrap_or(""), &cid).await?;
            if next.authorization_server.is_none() {
                next.authorization_server = tokens.authorization_server.clone();
            }
            cache_put(&next);
            tokens = next;
        } else {
            return Err("OAuth access_token 已过期且无法刷新，请重新授权".into());
        }
    }

    let token_type = tokens.token_type.clone().unwrap_or_else(|| "Bearer".into());
    Ok(Some(format!("{token_type} {}", tokens.access_token)))
}

/// 刷新成功后，把新 token 合并进原 auth_config（调用方负责落库）。
#[allow(dead_code)]
pub fn merge_oauth_into_auth_config(
    auth_config: &Option<serde_json::Value>,
    tokens: &McpOauthTokenSet,
) -> serde_json::Value {
    let mut root = match auth_config {
        Some(v) => v.as_object().cloned().unwrap_or_default(),
        None => Default::default(),
    };
    let oauth = serde_json::to_value(tokens).unwrap_or_else(|_| serde_json::json!({}));
    root.insert("oauth".into(), oauth);
    serde_json::Value::Object(root)
}

/// 供测试/诊断：当前是否已缓存可用 token。
#[allow(dead_code)]
pub fn has_cached_token(auth_config: &Option<serde_json::Value>) -> bool {
    match auth_config {
        Some(v) => extract_oauth_tokens(v).map(|t| !is_expired(&t)).unwrap_or(false),
        None => false,
    }
}

// 保持 base64 编码引用，避免未使用告警（B64 在部分路径备用）。
#[allow(dead_code)]
fn _keep_b64() -> String {
    B64.encode(b"work-duo")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636 附录 B 的 PKCE 测试向量。
    #[test]
    fn pkce_s256_matches_rfc7636() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(pkce_challenge_s256(verifier), expected);
    }

    #[test]
    fn extract_oauth_tokens_camel_and_snake() {
        let camel = serde_json::json!({
            "oauth": {
                "accessToken": "at-1",
                "refreshToken": "rt-1",
                "expiresAt": 123,
                "tokenType": "Bearer",
                "clientId": "cid"
            }
        });
        let t = extract_oauth_tokens(&camel).expect("camel");
        assert_eq!(t.access_token, "at-1");
        assert_eq!(t.refresh_token.as_deref(), Some("rt-1"));
        assert_eq!(t.expires_at, 123);

        let snake = serde_json::json!({
            "oauth": { "access_token": "at-2" }
        });
        let t2 = extract_oauth_tokens(&snake).expect("snake");
        assert_eq!(t2.access_token, "at-2");
        assert!(extract_oauth_tokens(&serde_json::json!({})).is_none());
    }

    #[test]
    fn query_parse_handles_plus_and_percent() {
        let p = parse_query("/callback?code=abc%201&state=x%2By&error=access_denied");
        assert_eq!(p.get("code").map(|s| s.as_str()), Some("abc 1"));
        assert_eq!(p.get("state").map(|s| s.as_str()), Some("x+y"));
        assert_eq!(p.get("error").map(|s| s.as_str()), Some("access_denied"));
    }
}
