//! Host 连接池：懒连接 / 保活 / 空闲 Logout（设计稿 §6）。
//!
//! 全局单例（OnceLock）；会话按 server_id 复用（russh Handle 不可 Clone，
//! 池内持 `Arc<Mutex<Handle>>`，工具面 lock 后在其上开 channel——
//! 对齐 Xshell「一连接多通道」体验）。空闲 10min 自动 Logout（访问时 sweep + 周期 reaper）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh_keys::key;
use sqlx::Row;
use tauri::AppHandle;
use tokio::sync::Mutex;

use super::credential::{self, SecretPayload};
use super::known_key;
use super::types::ServerBinding;

const IDLE_TIMEOUT_MS: u128 = 10 * 60 * 1000;
const KEEPALIVE_SECS: u64 = 15;

/// 池内 Handler：TOFU 主机键校验（台账 P0-1）。
/// 每个 PoolHandler 实例绑定一台服务器（app + server_id），按会话档案读写指纹记录。
pub struct PoolHandler {
    app: AppHandle,
    server_id: String,
}

#[async_trait::async_trait]
impl client::Handler for PoolHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &key::PublicKey) -> Result<bool, Self::Error> {
        Ok(
            known_key::check_server_key(&self.app, &self.server_id, server_public_key)
                .await
                .unwrap_or(false), // TOFU 内部错误已日志化，fail-close
        )
    }
}

pub type SharedHandle = Arc<Mutex<Handle<PoolHandler>>>;

struct PooledSession {
    handle: SharedHandle,
    last_used: Instant,
    connected_at: Instant,
}

/// 连接池（全局单例）。
pub struct HostPool {
    sessions: Mutex<HashMap<String, PooledSession>>,
}

static POOL: OnceLock<HostPool> = OnceLock::new();
static REAPER_SPAWNED: AtomicBool = AtomicBool::new(false);

pub fn global() -> &'static HostPool {
    POOL.get_or_init(|| HostPool {
        sessions: Mutex::new(HashMap::new()),
    })
}

/// 连接配置：keepalive + 协议层不活动超时（池层面的空闲 Logout 由 sweep 决定）。
fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(120)),
        keepalive_interval: Some(Duration::from_secs(KEEPALIVE_SECS)),
        ..Default::default()
    })
}

async fn connect_binding(app: &tauri::AppHandle, binding: &ServerBinding) -> Result<Handle<PoolHandler>, String> {
    // 凭证解密（即用即弃）
    let credential_id = binding
        .credential_id
        .as_deref()
        .ok_or_else(|| format!("服务器 {} 未配置凭证", binding.name))?;
    let pool = crate::agent::engine::round_compactor::get_pool(app).await?;
    let rows = sqlx::query("SELECT secret_type, secret_enc FROM server_credential WHERE id = ?")
        .bind(credential_id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("读取凭证失败：{e}"))?;
    let row = rows.first().ok_or_else(|| format!("凭证不存在（{credential_id}）"))?;
    let secret_type: String = row.get("secret_type");
    let enc: String = row.get("secret_enc");
    let payload_json = credential::decrypt_payload(&enc)?;
    let secret = credential::parse_payload(&secret_type, &payload_json)?;

    let mut handle = client::connect(
        client_config(),
        (binding.host.as_str(), binding.port),
        PoolHandler {
            app: app.clone(),
            server_id: binding.server_id.clone(),
        },
    )
    .await
    .map_err(|e| {
        use super::known_key::friendly_connect_error;
        format!(
            "{}（{}:{}）",
            friendly_connect_error(&e, &binding.name),
            binding.host,
            binding.port
        )
    })?;

    let ok = match &secret {
        SecretPayload::Password(pass) => handle
            .authenticate_password(&binding.login_user, pass)
            .await
            .map_err(|e| format!("认证失败：{e}"))?,
        SecretPayload::Pem { pem, passphrase } => {
            let kp = russh_keys::decode_secret_key(pem, passphrase.as_deref())
                .map_err(|e| format!("私钥解析失败：{e}"))?;
            handle
                .authenticate_publickey(&binding.login_user, Arc::new(kp))
                .await
                .map_err(|e| format!("认证失败：{e}"))?
        }
    };
    if !ok {
        return Err(format!(
            "认证失败：用户 {} 的凭证被服务器拒绝（请检查密码/私钥）",
            binding.login_user
        ));
    }
    Ok(handle)
}

impl HostPool {
    /// 取（或建立）指定服务器的会话；顺带 sweep 空闲会话。
    /// 返回共享句柄（Arc<Mutex<Handle>>），调用方 lock 后在其上开 channel。
    pub async fn get_or_connect(
        &self,
        app: &tauri::AppHandle,
        binding: &ServerBinding,
    ) -> Result<SharedHandle, String> {
        self.spawn_reaper();
        let mut guard = self.sessions.lock().await;
        self.sweep_idle_locked(&mut guard);
        if let Some(pooled) = guard.get_mut(&binding.server_id) {
            pooled.last_used = Instant::now();
            return Ok(pooled.handle.clone());
        }
        let handle = connect_binding(app, binding).await?;
        guard.insert(
            binding.server_id.clone(),
            PooledSession {
                handle: Arc::new(Mutex::new(handle)),
                last_used: Instant::now(),
                connected_at: Instant::now(),
            },
        );
        Ok(guard.get(&binding.server_id).unwrap().handle.clone())
    }

    /// 断开指定服务器（幂等；优雅发送 disconnect 后移除池条目）。
    pub async fn disconnect(&self, server_id: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().await;
        if let Some(pooled) = guard.remove(server_id) {
            let handle = pooled.handle.lock().await;
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
        }
        Ok(())
    }

    /// 全断。
    pub async fn disconnect_all(&self) -> Result<usize, String> {
        let mut guard = self.sessions.lock().await;
        let n = guard.len();
        for (_, pooled) in guard.drain() {
            let handle = pooled.handle.lock().await;
            let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
        }
        Ok(n)
    }

    /// 连接状态摘要（host_status 用）。
    pub async fn status(&self, server_id: &str) -> (bool, Option<String>) {
        let guard = self.sessions.lock().await;
        match guard.get(server_id) {
            Some(p) => (true, Some(format!("已连接 {}s", p.connected_at.elapsed().as_secs()))),
            None => (false, None),
        }
    }

    fn sweep_idle_locked(&self, guard: &mut HashMap<String, PooledSession>) {
        let dead: Vec<String> = guard
            .iter()
            .filter(|(_, s)| s.last_used.elapsed().as_millis() > IDLE_TIMEOUT_MS)
            .map(|(k, _)| k.clone())
            .collect();
        for id in dead {
            if let Some(pooled) = guard.remove(&id) {
                tracing::info!("[host] 空闲超时，自动 Logout：{id}");
                tokio::spawn(async move {
                    let handle = pooled.handle.lock().await;
                    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
                });
            }
        }
    }

    fn spawn_reaper(&self) {
        if REAPER_SPAWNED.swap(true, Ordering::SeqCst) {
            return;
        }
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if let Some(pool) = POOL.get() {
                    let mut guard = pool.sessions.lock().await;
                    pool.sweep_idle_locked(&mut guard);
                }
            }
        });
    }
}
