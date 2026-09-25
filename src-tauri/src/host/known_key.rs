//! TOFU（Trust On First Use）主机键校验（台账 P0-1，设计稿「known_hosts/TOFU」项）。
//!
//! 语义：首次连接某服务器时记录其 SSH 主机键指纹（SHA-256，`russh_keys::key::PublicKey::fingerprint`）
//! 到 `server_host.known_key_fingerprint`；后续连接逐一比对——
//! - 一致：放行；
//! - 不一致：**拒绝连接**（中间人攻击或服务器重装换键，必须人工确认后重置）；
//! - 首次（NULL）：记录并放行。
//!
//! 策略红线：**DB 不可用时 fail-close（拒绝连接）**——安全门在无法读取记录时不得悄悄放行。
//! 重置入口：`server_host_save` 携带 `reset_known_key: true`（仅 UI；MCP 通道凭证红线同款思路，
//! 重置属于敏感操作，经审批面之外的显式用户动作完成）。

use russh_keys::key;
use sqlx::Row;
use tauri::AppHandle;

/// TOFU 校验结果。
pub enum TofuOutcome {
    /// 首次使用：已记录指纹，放行。
    FirstUse,
    /// 指纹一致，放行。
    Matched,
    /// 指纹不一致：拒绝连接（中间人/换键）。
    Mismatch,
    /// 无档案记录（未建档的临时连接）：无持久化语义，放行但不记录。
    NoRecord,
}

/// 校验（或首次记录）服务器主机键指纹。返回是否允许继续连接。
pub async fn check_server_key(app: &AppHandle, server_id: &str, presented: &key::PublicKey) -> Result<bool, String> {
    let fingerprint = presented.fingerprint();
    match verify_or_record(app, server_id, &fingerprint).await? {
        TofuOutcome::FirstUse => {
            tracing::info!(
                "[host][tofu] 首次记录主机键指纹 server={} fp={}（TOFU 信任建立）",
                server_id,
                fingerprint
            );
            Ok(true)
        }
        TofuOutcome::Matched => Ok(true),
        TofuOutcome::Mismatch => {
            tracing::error!(
                "[host][tofu] 主机键不匹配 server={} presented={} —— 拒绝连接（疑似中间人或服务器重装换键）",
                server_id,
                fingerprint
            );
            Ok(false)
        }
        TofuOutcome::NoRecord => {
            tracing::info!("[host][tofu] 服务器未建档（{}），跳过指纹记录直接放行", server_id);
            Ok(true)
        }
    }
}

async fn verify_or_record(app: &AppHandle, server_id: &str, fingerprint: &str) -> Result<TofuOutcome, String> {
    let pool = crate::agent::engine::round_compactor::get_pool(app)
        .await
        .map_err(|e| format!("TOFU：读取数据库失败（fail-close）：{e}"))?;
    let rows = sqlx::query("SELECT known_key_fingerprint FROM server_host WHERE id = ?")
        .bind(server_id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("TOFU：查询指纹失败（fail-close）：{e}"))?;
    let Some(row) = rows.first() else {
        return Ok(TofuOutcome::NoRecord);
    };
    let known: Option<String> = row.get("known_key_fingerprint");
    match known {
        None => {
            // 首次：记录并放行
            sqlx::query("UPDATE server_host SET known_key_fingerprint = ? WHERE id = ?")
                .bind(fingerprint)
                .bind(server_id)
                .execute(&pool)
                .await
                .map_err(|e| format!("TOFU：记录指纹失败（fail-close）：{e}"))?;
            Ok(TofuOutcome::FirstUse)
        }
        Some(k) if k == fingerprint => Ok(TofuOutcome::Matched),
        Some(k) => {
            let _ = k;
            Ok(TofuOutcome::Mismatch)
        }
    }
}

/// 将 russh 连接错误翻译为含 TOFU 引导的友好提示（check_server_key=false 时 russh 报 UnknownKey）。
pub fn friendly_connect_error(e: &russh::Error, server_name: &str) -> String {
    if matches!(e, russh::Error::UnknownKey) {
        format!(
            "SSH 主机键校验失败：{server_name} 本次出示的主机键与首次记录的指纹不一致——\
             可能是中间人攻击，或服务器重装/换键。若确认服务器合法，请在「百宝箱 → 服务器」\
             编辑该服务器并勾选「重置主机键指纹」，下次连接将重新记录。"
        )
    } else {
        format!("SSH 连接失败：{e}")
    }
}
