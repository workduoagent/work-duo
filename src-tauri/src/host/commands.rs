//! 服务器托管管理面 Tauri 命令：CRUD + 测试连接。
//!
//! 凭证边界：明文仅出现在「保存（加密入库）」与「测试连接（解密即用即弃）」两个瞬间；
//! 所有列表 / 详情返回值只含指纹 hint。Agent 不可调用本组命令（管理面专属）。

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::AppHandle;

use super::credential::{self, SecretKind};

/* ------------------------------------------------------------------ *
 * DTO / 输入
 * ---------------------------------------------------------------- */

/// 管理面返回值（camelCase 直达前端；**不含任何凭证明文**，仅 hint）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHostDto {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub user: String,
    pub auth_type: String,
    pub credential_id: Option<String>,
    pub credential_hint: Option<String>,
    pub path_allow: Vec<String>,
    pub path_deny: Vec<String>,
    pub local_path_allow: Vec<String>,
    pub default_cwd: Option<String>,
    pub login_note: Option<String>,
    pub sudo_mode: String,
    pub sudo_user: String,
    pub host_auto_mode: String,
    pub allow_grant_memory: bool,
    pub l3_policy: String,
    pub grant_bind_as_user: bool,
    pub tags: Vec<String>,
    pub note: Option<String>,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 保存入参（id 必填：前端生成 `srv_` 前缀 id，保存 = upsert）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHostInput {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: Option<i64>,
    pub user: String,
    pub auth_type: Option<String>,
    /// 凭证明文（password 原文 / PEM 文本）。**仅写入瞬间经内存传入，永不回传**。
    /// 为空 = 不改动已存凭证（编辑时未重填场景）。
    #[serde(default)]
    pub secret: Option<String>,
    /// private_key_passphrase 时的密钥口令（与 secret 分开传，一并加密入同一密文）。
    #[serde(default)]
    pub key_passphrase: Option<String>,
    #[serde(default)]
    pub path_allow: Option<Vec<String>>,
    #[serde(default)]
    pub path_deny: Option<Vec<String>>,
    #[serde(default)]
    pub local_path_allow: Option<Vec<String>>,
    #[serde(default)]
    pub default_cwd: Option<String>,
    #[serde(default)]
    pub login_note: Option<String>,
    #[serde(default)]
    pub sudo_mode: Option<String>,
    #[serde(default)]
    pub sudo_user: Option<String>,
    #[serde(default)]
    pub host_auto_mode: Option<String>,
    #[serde(default)]
    pub allow_grant_memory: Option<bool>,
    #[serde(default)]
    pub l3_policy: Option<String>,
    #[serde(default)]
    pub grant_bind_as_user: Option<bool>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 测试连接报告。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionReport {
    pub ok: bool,
    pub login_user: Option<String>,
    pub os_hint: Option<String>,
    pub home: Option<String>,
    pub latency_ms: i64,
    pub error: Option<String>,
}

/* ------------------------------------------------------------------ *
 * 行 → DTO
 * ---------------------------------------------------------------- */

fn json_arr(s: Option<&String>) -> Vec<String> {
    s.and_then(|t| serde_json::from_str::<Vec<String>>(t).ok())
        .unwrap_or_default()
}

fn row_to_dto(row: &sqlx::sqlite::SqliteRow) -> ServerHostDto {
    let credential_id: Option<String> = row.get("credential_id");
    ServerHostDto {
        id: row.get("id"),
        name: row.get("name"),
        host: row.get("host"),
        port: row.get::<i64, _>("port"),
        user: row.get("user"),
        auth_type: row.get("auth_type"),
        credential_hint: credential_id.as_ref().map(|_| row.get::<String, _>("hint")),
        credential_id,
        path_allow: json_arr(row.get::<Option<String>, _>("path_allow").as_ref()),
        path_deny: json_arr(row.get::<Option<String>, _>("path_deny").as_ref()),
        local_path_allow: json_arr(row.get::<Option<String>, _>("local_path_allow").as_ref()),
        default_cwd: row.get("default_cwd"),
        login_note: row.get("login_note"),
        sudo_mode: row.get("sudo_mode"),
        sudo_user: row.get("sudo_user"),
        host_auto_mode: row.get("host_auto_mode"),
        allow_grant_memory: row.get::<i64, _>("allow_grant_memory") == 1,
        l3_policy: row.get("l3_policy"),
        grant_bind_as_user: row.get::<i64, _>("grant_bind_as_user") == 1,
        tags: json_arr(row.get::<Option<String>, _>("tags").as_ref()),
        note: row.get("note"),
        last_used_at: row.get("last_used_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

const SELECT_HOST: &str = "SELECT h.*, c.hint AS hint FROM server_host h \
     LEFT JOIN server_credential c ON c.id = h.credential_id";

/* ------------------------------------------------------------------ *
 * CRUD 命令
 * ---------------------------------------------------------------- */

#[tauri::command]
pub async fn server_host_list(app: AppHandle) -> Result<Vec<ServerHostDto>, String> {
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    let rows = sqlx::query(&format!("{SELECT_HOST} ORDER BY h.updated_at DESC"))
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("读取服务器列表失败：{e}"))?;
    Ok(rows.iter().map(row_to_dto).collect())
}

#[tauri::command]
pub async fn server_host_get(app: AppHandle, id: String) -> Result<Option<ServerHostDto>, String> {
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    let rows = sqlx::query(&format!("{SELECT_HOST} WHERE h.id = ?"))
        .bind(&id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("读取服务器失败：{e}"))?;
    Ok(rows.first().map(row_to_dto))
}

#[tauri::command]
pub async fn server_host_save(app: AppHandle, input: ServerHostInput) -> Result<ServerHostDto, String> {
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    let now = crate::agent::runtime::now_ms();
    let kind = SecretKind::parse(input.auth_type.as_deref().unwrap_or("password"));

    // 凭证：传了明文 secret → 加密 upsert；未传 → 保留既有 credential_id
    let credential_id: Option<String>;
    if let Some(secret) = input.secret.as_deref().filter(|s| !s.trim().is_empty()) {
        let payload = credential::build_payload(kind.as_str(), secret, input.key_passphrase.as_deref())?;
        let enc = credential::encrypt_payload(&payload)?;
        let hint = credential::secret_hint(kind.as_str(), secret);
        let cred_id = credential::new_credential_id(kind.as_str(), secret);
        sqlx::query(
            "INSERT INTO server_credential (id, secret_type, secret_enc, hint, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET secret_type = excluded.secret_type, \
             secret_enc = excluded.secret_enc, hint = excluded.hint, updated_at = excluded.updated_at",
        )
        .bind(&cred_id)
        .bind(kind.as_str())
        .bind(&enc)
        .bind(&hint)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|e| format!("凭证写入失败：{e}"))?;
        credential_id = Some(cred_id);
    } else {
        // 编辑且未重填凭证：沿用旧 credential_id
        let rows = sqlx::query("SELECT credential_id FROM server_host WHERE id = ?")
            .bind(&input.id)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("读取原凭证关联失败：{e}"))?;
        credential_id = rows.first().and_then(|r| r.get::<Option<String>, _>("credential_id"));
    }
    let credential_id = credential_id.ok_or("缺少凭证：请填写密码或私钥")?;

    // 认证方式变化时，旧凭证种类不再匹配 → 必须重填（防止 password 密文被当 PEM 解）
    let old_type: Option<String> = {
        let rows = sqlx::query("SELECT auth_type FROM server_host WHERE id = ?")
            .bind(&input.id)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("读取原记录失败：{e}"))?;
        rows.first().map(|r| r.get::<String, _>("auth_type"))
    };
    let kind_changed = old_type.as_deref().map(|t| SecretKind::parse(t) != kind).unwrap_or(false)
        && input.secret.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true);
    if kind_changed {
        return Err("认证方式已变更，请重新填写对应凭证".into());
    }

    let json = |v: &Option<Vec<String>>| -> Option<String> {
        v.as_ref().map(|list| serde_json::to_string(list).unwrap_or_else(|_| "[]".into()))
    };
    let exists = sqlx::query("SELECT 1 FROM server_host WHERE id = ?")
        .bind(&input.id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询失败：{e}"))?
        .is_some();

    if exists {
        sqlx::query(
            "UPDATE server_host SET name=?, host=?, port=?, user=?, auth_type=?, credential_id=?, \
             path_allow=?, path_deny=?, local_path_allow=?, default_cwd=?, login_note=?, \
             sudo_mode=?, sudo_user=?, host_auto_mode=?, allow_grant_memory=?, l3_policy=?, \
             grant_bind_as_user=?, tags=?, note=?, updated_at=? WHERE id=?",
        )
        .bind(&input.name)
        .bind(&input.host)
        .bind(input.port.unwrap_or(22))
        .bind(&input.user)
        .bind(kind.as_str())
        .bind(&credential_id)
        .bind(json(&input.path_allow))
        .bind(json(&input.path_deny))
        .bind(json(&input.local_path_allow))
        .bind(&input.default_cwd)
        .bind(&input.login_note)
        .bind(input.sudo_mode.as_deref().unwrap_or("none"))
        .bind(input.sudo_user.as_deref().unwrap_or("root"))
        .bind(input.host_auto_mode.as_deref().unwrap_or("strict"))
        .bind(input.allow_grant_memory.unwrap_or(false) as i64)
        .bind(input.l3_policy.as_deref().unwrap_or("single_shot"))
        .bind(input.grant_bind_as_user.unwrap_or(true) as i64)
        .bind(json(&input.tags))
        .bind(&input.note)
        .bind(now)
        .bind(&input.id)
        .execute(&pool)
        .await
        .map_err(|e| format!("保存服务器失败：{e}"))?;
    } else {
        sqlx::query(
            "INSERT INTO server_host (id, name, host, port, user, auth_type, credential_id, \
             path_allow, path_deny, local_path_allow, default_cwd, login_note, sudo_mode, \
             sudo_user, host_auto_mode, allow_grant_memory, l3_policy, grant_bind_as_user, \
             tags, note, last_used_at, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&input.id)
        .bind(&input.name)
        .bind(&input.host)
        .bind(input.port.unwrap_or(22))
        .bind(&input.user)
        .bind(kind.as_str())
        .bind(&credential_id)
        .bind(json(&input.path_allow))
        .bind(json(&input.path_deny))
        .bind(json(&input.local_path_allow))
        .bind(&input.default_cwd)
        .bind(&input.login_note)
        .bind(input.sudo_mode.as_deref().unwrap_or("none"))
        .bind(input.sudo_user.as_deref().unwrap_or("root"))
        .bind(input.host_auto_mode.as_deref().unwrap_or("strict"))
        .bind(input.allow_grant_memory.unwrap_or(false) as i64)
        .bind(input.l3_policy.as_deref().unwrap_or("single_shot"))
        .bind(input.grant_bind_as_user.unwrap_or(true) as i64)
        .bind(json(&input.tags))
        .bind(&input.note)
        .bind(Option::<i64>::None)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .map_err(|e| format!("新建服务器失败：{e}"))?;
    }

    server_host_get(app, input.id)
        .await?
        .ok_or_else(|| "保存后回读失败".into())
}

#[tauri::command]
pub async fn server_host_delete(app: AppHandle, id: String) -> Result<(), String> {
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    // 级联：凭证 + 绑定引用一并清理（host_grant / 日志按 run 生命周期，保留审计）
    sqlx::query("DELETE FROM agent_server_ref WHERE server_id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| format!("清理绑定失败：{e}"))?;
    sqlx::query("DELETE FROM server_host WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| format!("删除服务器失败：{e}"))?;
    let cred = sqlx::query("SELECT credential_id FROM server_host WHERE id = ?")
        .bind(&id)
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten();
    if let Some(row) = cred {
        if let Some(cid) = row.get::<Option<String>, _>("credential_id") {
            sqlx::query("DELETE FROM server_credential WHERE id = ?")
                .bind(cid)
                .execute(&pool)
                .await
                .map_err(|e| format!("清理凭证失败：{e}"))?;
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 测试连接（管理面专属：connect + whoami + uname + pwd）
 * ---------------------------------------------------------------- */

/// 解析出可用于本次连接的凭证负载：优先用入参明文，否则按 id 解密已存凭证。
async fn resolve_secret(
    app: &AppHandle,
    input: &ServerHostInput,
) -> Result<credential::SecretPayload, String> {
    if let Some(secret) = input.secret.as_deref().filter(|s| !s.trim().is_empty()) {
        let kind = SecretKind::parse(input.auth_type.as_deref().unwrap_or("password"));
        let payload = credential::build_payload(kind.as_str(), secret, input.key_passphrase.as_deref())?;
        return credential::parse_payload(kind.as_str(), &payload);
    }
    let id = input
        .id
        .trim()
        .to_string();
    if id.is_empty() {
        return Err("缺少凭证：请填写密码或私钥".into());
    }
    let pool = crate::agent::round_compactor::get_pool(app).await?;
    let rows = sqlx::query(
        "SELECT c.secret_type, c.secret_enc FROM server_host h \
         JOIN server_credential c ON c.id = h.credential_id WHERE h.id = ?",
    )
    .bind(&id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取凭证失败：{e}"))?;
    let row = rows.first().ok_or("该服务器尚未保存凭证，请先填写并保存")?;
    let secret_type: String = row.get("secret_type");
    let enc: String = row.get("secret_enc");
    let payload = credential::decrypt_payload(&enc)?;
    credential::parse_payload(&secret_type, &payload)
}

#[tauri::command]
pub async fn server_host_test_connection(
    app: AppHandle,
    input: ServerHostInput,
) -> Result<TestConnectionReport, String> {
    let started = std::time::Instant::now();
    let secret = resolve_secret(&app, &input).await;
    let secret = match secret {
        Ok(s) => s,
        Err(e) => {
            return Ok(TestConnectionReport {
                ok: false,
                login_user: None,
                os_hint: None,
                home: None,
                latency_ms: started.elapsed().as_millis() as i64,
                error: Some(e),
            })
        }
    };

    let host = input.host.trim().to_string();
    let port = input.port.unwrap_or(22) as u16;
    let user = input.user.trim().to_string();
    if host.is_empty() || user.is_empty() {
        return Ok(TestConnectionReport {
            ok: false,
            login_user: None,
            os_hint: None,
            home: None,
            latency_ms: started.elapsed().as_millis() as i64,
            error: Some("主机地址与登录用户不能为空".into()),
        });
    }

    match crate::host::transport::probe(&host, port, &user, &secret, 15).await {
        Ok((login_user, os_hint, home)) => {
            // 成功测试刷新 last_used_at（尽力而为，失败不阻断）
            if let Ok(pool) = crate::agent::round_compactor::get_pool(&app).await {
                if !input.id.trim().is_empty() {
                    let _ = sqlx::query("UPDATE server_host SET last_used_at = ? WHERE id = ?")
                        .bind(crate::agent::runtime::now_ms())
                        .bind(&input.id)
                        .execute(&pool)
                        .await;
                }
            }
            Ok(TestConnectionReport {
                ok: true,
                login_user: Some(login_user),
                os_hint: Some(os_hint),
                home: Some(home),
                latency_ms: started.elapsed().as_millis() as i64,
                error: None,
            })
        }
        Err(e) => Ok(TestConnectionReport {
            ok: false,
            login_user: None,
            os_hint: None,
            home: None,
            latency_ms: started.elapsed().as_millis() as i64,
            error: Some(e),
        }),
    }
}

/// MCP：绑定智能体 ↔ 服务器（agent_server_ref 先删后插；serverIds 第一个为 primary/默认 Host）。
/// 与前端 agent-mapper 的写路径同构；供外部 Agent 自助装配与验证（服务器托管工具面）。
pub async fn agent_server_bind(
    app: AppHandle,
    agent_id: String,
    server_ids: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    use sqlx::Row;
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    // 存在性校验：agent 与 server 必须真实存在（防 MCP 侧写脏关联）
    let agent_ok: Option<String> = sqlx::query_scalar("SELECT id FROM agent_info WHERE id = ?")
        .bind(&agent_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询智能体失败：{e}"))?;
    if agent_ok.is_none() {
        return Err(format!("智能体不存在：{agent_id}"));
    }
    for sid in &server_ids {
        let ok: Option<String> = sqlx::query_scalar("SELECT id FROM server_host WHERE id = ?")
            .bind(sid)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("查询服务器失败：{e}"))?;
        if ok.is_none() {
            return Err(format!("服务器不存在：{sid}（请先 server_host_save）"));
        }
    }
    let now = crate::agent::runtime::now_ms();
    let mut tx = pool.begin().await.map_err(|e| format!("开启事务失败：{e}"))?;
    sqlx::query("DELETE FROM agent_server_ref WHERE agent_id = ?")
        .bind(&agent_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("清理旧绑定失败：{e}"))?;
    for (idx, sid) in server_ids.iter().enumerate() {
        sqlx::query(
            "INSERT INTO agent_server_ref (id, agent_id, server_id, role, cwd_override, created_at, updated_at) \
             VALUES (?,?,?,?,NULL,?,?)",
        )
        .bind(format!(
            "asr_{now}_{}_{}",
            &agent_id[agent_id.len().saturating_sub(6)..],
            idx
        ))
        .bind(&agent_id)
        .bind(sid)
        .bind(if idx == 0 { "primary" } else { "secondary" })
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("写入绑定失败：{e}"))?;
    }
    tx.commit().await.map_err(|e| format!("提交事务失败：{e}"))?;
    // 回读绑定清单（含服务器名/地址，便于外部 Agent 直接核对）
    let rows = sqlx::query(
        "SELECT r.server_id, r.role, s.name, s.host, s.port, s.user \
         FROM agent_server_ref r JOIN server_host s ON s.id = r.server_id \
         WHERE r.agent_id = ? ORDER BY r.created_at ASC",
    )
    .bind(&agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取绑定失败：{e}"))?;
    Ok(rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "serverId": r.get::<String, _>("server_id"),
                "role": r.get::<String, _>("role"),
                "name": r.get::<String, _>("name"),
                "host": r.get::<String, _>("host"),
                "port": r.get::<i64, _>("port"),
                "loginUser": r.get::<String, _>("user"),
            })
        })
        .collect())
}
