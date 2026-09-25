//! 服务器托管共享类型（ServerBinding / HostAction）。

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::AppHandle;

/// 单台已绑定服务器的运行时档案（agent_server_ref JOIN server_host）。
#[derive(Debug, Clone)]
pub struct ServerBinding {
    pub server_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    /// SSH 登录用户（不必是 root）。
    pub login_user: String,
    pub credential_id: Option<String>,
    /// 远端路径白名单（空 = 不限制，不推荐）。
    pub path_allow: Vec<String>,
    /// 远端路径黑名单（优先于白名单）。
    pub path_deny: Vec<String>,
    /// 本地侧路径白名单（空 = 绑定工作空间）。
    pub local_path_allow: Vec<String>,
    pub default_cwd: Option<String>,
    pub sudo_mode: String,
    pub sudo_user: String,
    pub host_auto_mode: String,
    pub allow_grant_memory: bool,
    pub l3_policy: String,
}

/// Host 操作类型（授权绑定的四元组之一：agent + server + action + as_user）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostAction {
    Connect,
    RemoteRead,
    RemoteWrite,
    RemoteDelete,
    RemoteExec,
    Disconnect,
}

impl HostAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            HostAction::Connect => "Connect",
            HostAction::RemoteRead => "RemoteRead",
            HostAction::RemoteWrite => "RemoteWrite",
            HostAction::RemoteDelete => "RemoteDelete",
            HostAction::RemoteExec => "RemoteExec",
            HostAction::Disconnect => "Disconnect",
        }
    }

    /// 基础风险级别（无命中信号时的下限）：exec/write 恒 L1+，delete 恒 L2。
    pub fn base_level(&self) -> u8 {
        match self {
            HostAction::Connect | HostAction::Disconnect | HostAction::RemoteRead => 0,
            HostAction::RemoteExec | HostAction::RemoteWrite => 1,
            HostAction::RemoteDelete => 2,
        }
    }
}

/// 读取某智能体绑定的全部服务器档案（agent_server_ref JOIN server_host）。
pub async fn load_bindings(app: &AppHandle, agent_id: &str) -> Result<Vec<ServerBinding>, String> {
    let pool = crate::agent::engine::round_compactor::get_pool(app).await?;
    let rows = sqlx::query(
        "SELECT s.id, s.name, s.host, s.port, s.user, s.credential_id, \
         s.path_allow, s.path_deny, s.local_path_allow, s.default_cwd, s.sudo_mode, s.sudo_user, \
         s.host_auto_mode, s.allow_grant_memory, s.l3_policy, r.role \
         FROM agent_server_ref r JOIN server_host s ON s.id = r.server_id \
         WHERE r.agent_id = ? ORDER BY r.role DESC, s.name",
    )
    .bind(agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取服务器绑定失败：{e}"))?;

    let parse_arr = |s: Option<String>| -> Vec<String> {
        s.and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()).unwrap_or_default()
    };
    Ok(rows
        .iter()
        .map(|r| ServerBinding {
            server_id: r.get("id"),
            name: r.get("name"),
            host: r.get("host"),
            port: r.get::<i64, _>("port") as u16,
            login_user: r.get("user"),
            credential_id: r.get("credential_id"),
            path_allow: parse_arr(r.get::<Option<String>, _>("path_allow")),
            path_deny: parse_arr(r.get::<Option<String>, _>("path_deny")),
            local_path_allow: parse_arr(r.get::<Option<String>, _>("local_path_allow")),
            default_cwd: r.get("default_cwd"),
            sudo_mode: r.get("sudo_mode"),
            sudo_user: r.get("sudo_user"),
            host_auto_mode: r.get("host_auto_mode"),
            allow_grant_memory: r.get::<i64, _>("allow_grant_memory") == 1,
            l3_policy: r.get("l3_policy"),
        })
        .collect())
}
