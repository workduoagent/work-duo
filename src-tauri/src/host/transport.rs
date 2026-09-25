//! SSH 传输层（最小可用：connect + auth + exec）。
//!
//! 本文件先承载管理面「测试连接」；工具面切片在此扩展为
//! `trait SshTransport` + `HostPool`（懒连接 / 保活 / 空闲 Logout，见设计稿 §6）。
//!
//! 安全说明：测试连接首版**信任服务器主机键**（不做 known_hosts 指纹比对），
//! TOFU 指纹校验在工具面切片接入；凭证即用即弃，不落日志。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::ChannelMsg;
use russh_keys::key;
use tauri::AppHandle;

use super::credential::SecretPayload;
use super::known_key;

/// 测试连接专用 Handler：TOFU 主机键校验（台账 P0-1）。
/// 持有 app+server_id 以读写 `server_host.known_key_fingerprint`；
/// DB 不可用/未建档时的策略见 known_key.rs（fail-close / 无档案放行）。
struct ProbeHandler {
    app: AppHandle,
    server_id: String,
}

#[async_trait]
impl client::Handler for ProbeHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &key::PublicKey) -> Result<bool, Self::Error> {
        Ok(
            known_key::check_server_key(&self.app, &self.server_id, server_public_key)
                .await
                .unwrap_or(false), // TOFU 内部错误已日志化，fail-close
        )
    }
}

/// 连接 + 认证 + 三条探测命令，返回 `(login_user, os_hint, home)`。
///
/// `timeout_secs` 内未完成整体视为失败（网络不可达 / 端口不通 / 握手挂起）。
/// `server_id` 用于 TOFU 指纹记录（未建档时跳过记录直接放行，见 known_key.rs）。
pub async fn probe(
    app: &AppHandle,
    server_id: &str,
    host: &str,
    port: u16,
    user: &str,
    secret: &SecretPayload,
    timeout_secs: u64,
) -> Result<(String, String, String), String> {
    let fut = probe_inner(app.clone(), server_id.to_string(), host, port, user, secret);
    tokio::time::timeout(Duration::from_secs(timeout_secs), fut)
        .await
        .map_err(|_| format!("连接超时（{timeout_secs}s）：主机不可达或端口未开放"))?
}

async fn probe_inner(
    app: AppHandle,
    server_id: String,
    host: &str,
    port: u16,
    user: &str,
    secret: &SecretPayload,
) -> Result<(String, String, String), String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        ..Default::default()
    });

    let mut handle: Handle<ProbeHandler> = client::connect(config, (host, port), ProbeHandler { app, server_id })
        .await
        .map_err(|e| known_key::friendly_connect_error(&e, host))?;

    match secret {
        SecretPayload::Password(pass) => {
            let ok = handle
                .authenticate_password(user, pass)
                .await
                .map_err(|e| format!("认证失败：{e}"))?;
            if !ok {
                return Err("认证失败：用户名或密码不正确".into());
            }
        }
        SecretPayload::Pem { pem, passphrase } => {
            let kp = russh_keys::decode_secret_key(pem, passphrase.as_deref())
                .map_err(|e| format!("私钥解析失败：{e}"))?;
            let ok = handle
                .authenticate_publickey(user, Arc::new(kp))
                .await
                .map_err(|e| format!("认证失败：{e}"))?;
            if !ok {
                return Err("认证失败：私钥被服务器拒绝".into());
            }
        }
    }

    let login_user = exec_trim(&mut handle, "whoami").await?;
    let os_hint = exec_trim(&mut handle, "uname -sr").await?;
    let home = exec_trim(&mut handle, "echo $HOME").await?;
    Ok((login_user, os_hint, home))
}

/// 打开通道执行单条命令，收集 stdout+stderr（trim 后返回）。
async fn exec_trim(handle: &mut Handle<ProbeHandler>, cmd: &str) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败：{e}"))?;
    channel
        .exec(false, cmd)
        .await
        .map_err(|e| format!("命令发送失败：{e}"))?;

    let mut out: Vec<u8> = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { .. }) => {}
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let s = String::from_utf8_lossy(&out).trim().to_string();
    if s.is_empty() {
        return Err("命令无输出".into());
    }
    Ok(s)
}
