//! HostAuthz：`host__*` 工具的唯一授权入口（独立授权域 domain=host）。
//!
//! 判定顺序（短路，设计稿 §7.5）：
//! 绑定 → 路径/cwd 闸 → sudo 策略 → HOST_RISKY_SIGNALS → host_grant 免弹 → 级别门禁。
//! **绝不**调用本地 `policy::evaluate_edge`、**绝不**读写 local grants。

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::AppHandle;

use crate::agent::types::ApprovalRequest;
use crate::host::policy;
use crate::host::types::{HostAction, ServerBinding};

/// 授权判定结果。
pub enum GateOutcome {
    /// 放行（decision: allow_auto / allow_grant，写审计）。
    Proceed(&'static str),
    /// 需要用户审批（runtime 经 ApprovalManager 挂起弹 host 卡片）。
    NeedApproval(ApprovalRequest),
    /// 结构化拒绝（Err 语义：模型可见原因，任务继续由 LLM 纠偏）。
    Denied(String),
}

/// Host 审批卡片 / host_grant 写入所需上下文。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostApprovalMeta {
    pub server_id: String,
    pub server_name: String,
    pub server_label: String,
    pub login_user: String,
    pub as_user: String,
    pub action: String,
    pub risk_level: String,
    pub risk_keys: Vec<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub remote_path: Option<String>,
    pub local_path: Option<String>,
    pub path_allow: Vec<String>,
    pub grant_key: String,
    pub scope_digest: String,
    pub run_id: String,
    pub allow_grant_memory: bool,
    pub l3: bool,
}

/// 工具调用侧输入（从 args / ctx / cfg 组装）。
pub struct GateInput<'a> {
    pub agent_id: &'a str,
    pub session_id: Option<&'a str>,
    pub run_id: &'a str,
    pub server_id: &'a str,
    pub action: HostAction,
    pub as_user: &'a str,
    pub command: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub remote_path: Option<&'a str>,
    pub local_path: Option<&'a str>,
    pub delete_extraneous: bool,
}

/// 授权入口（唯一）。Err = 结构化拒绝（PathDenied / SudoDenied / NotBound / RiskL3…）。
pub async fn authorize(
    app: &AppHandle,
    input: &GateInput<'_>,
) -> Result<GateOutcome, String> {
    // 1. 绑定闸：agent 必须绑定该 server
    let bindings = crate::host::types::load_bindings(app, input.agent_id).await?;
    let binding: ServerBinding = bindings
        .into_iter()
        .find(|b| b.server_id == input.server_id)
        .ok_or_else(|| {
            format!("NotBound：该智能体未绑定服务器 {}（请先在装配中绑定）", input.server_id)
        })?;

    // 2. 路径 / cwd / sudo 前置闸（含默认黑名单）
    policy::precheck(
        &binding,
        input.action,
        input.as_user,
        input.command,
        input.remote_path,
        input.cwd,
    )?;

    // 3. 风险评估
    let signals = policy::evaluate(
        &binding,
        input.action,
        input.as_user,
        input.command,
        input.remote_path,
        input.delete_extraneous,
    );
    let level = policy::max_level(&signals);
    let risk_key = policy::risk_key_of(&signals);

    // 4. host_grant 免弹（domain=host ∧ 同 agent+server+action+as_user+risk_key ∧ 未过期）
    if let Some(grant_id) = lookup_grant(app, input.run_id, input.agent_id, input.server_id, input.action.as_str(), input.as_user, &risk_key).await? {
        bump_grant_uses(app, &grant_id).await;
        write_authz_log(app, input, &binding, level, &signals, "allow_grant", Some(&grant_id)).await;
        return Ok(GateOutcome::Proceed("allow_grant"));
    }

    // 5. 级别门禁（host_auto_mode：strict=全部弹；balanced/auto=L0 自动、L1 自动、L2/L3 弹）
    let level_str = format!("L{}", level);
    let as_str_level = level;
    let needs_approval = match input.action.base_level().max(as_str_level) {
        0 => false,
        1 => binding.host_auto_mode == "strict",
        _ => true,
    };

    if !needs_approval {
        write_authz_log(app, input, &binding, level, &signals, "allow_auto", None).await;
        return Ok(GateOutcome::Proceed("allow_auto"));
    }

    // 6. L3 策略：reject → 直接拒绝；single_shot → 单次批准（不提供记住）
    if level >= 3 && binding.l3_policy == "reject" {
        write_authz_log(app, input, &binding, level, &signals, "deny", None).await;
        return Err("RiskL3：命中最高危信号（rm -rf / mkfs / 反弹 shell 等），本主机策略为直接拒绝".into());
    }

    // 7. 需要审批：构造 host 审批卡片请求
    let grant_key = format!(
        "host:{}|{}|{}|{}|{}",
        input.agent_id, input.server_id, input.action.as_str(), input.as_user, risk_key
    );
    let meta = HostApprovalMeta {
        server_id: input.server_id.to_string(),
        server_name: binding.name.clone(),
        server_label: format!("{}@{}:{}", binding.login_user, binding.host, binding.port),
        login_user: binding.login_user.clone(),
        as_user: input.as_user.to_string(),
        action: input.action.as_str().to_string(),
        risk_level: level_str,
        risk_keys: signals.iter().map(|s| s.risk_key.to_string()).collect(),
        command: input.command.map(|s| s.to_string()),
        cwd: input.cwd.map(|s| s.to_string()),
        remote_path: input.remote_path.map(|s| s.to_string()),
        local_path: input.local_path.map(|s| s.to_string()),
        path_allow: binding.path_allow.clone(),
        grant_key,
        scope_digest: scope_digest(input),
        run_id: input.run_id.to_string(),
        allow_grant_memory: binding.allow_grant_memory,
        l3: level >= 3,
    };
    write_authz_log(app, input, &binding, level, &signals, "pending_approval", None).await;
    Ok(GateOutcome::NeedApproval(build_request(input, &meta)))
}

/// 工具名 → HostAction（host__* 命名空间）。
pub fn action_of_tool(tool_name: &str) -> Option<HostAction> {
    match tool_name {
        "host__connect" => Some(HostAction::Connect),
        "host__disconnect" | "host__disconnect_all" => Some(HostAction::Disconnect),
        "host__list_servers" | "host__status" | "host__list" => Some(HostAction::RemoteRead),
        "host__exec" => Some(HostAction::RemoteExec),
        "host__upload" => Some(HostAction::RemoteWrite),
        "host__download" => Some(HostAction::RemoteRead),
        "host__sync" => Some(HostAction::RemoteWrite),
        "host__mkdir" => Some(HostAction::RemoteWrite),
        "host__remove" => Some(HostAction::RemoteDelete),
        _ => None,
    }
}

fn build_request(input: &GateInput<'_>, meta: &HostApprovalMeta) -> ApprovalRequest {
    let approval_id = format!("ap-host-{}-{}-{}", input.agent_id, input.server_id, crate::agent::engine::runtime::now_ms());
    ApprovalRequest {
        approval_id,
        tool_name: format!("host__{}", action_tool_slug(input.action)),
        description: format!(
            "Host 操作审批：{} · {} · as_user={}",
            meta.server_name, meta.action, meta.as_user
        ),
        args: serde_json::json!({
            "command": meta.command,
            "cwd": meta.cwd,
            "remotePath": meta.remote_path,
            "localPath": meta.local_path,
        })
        .to_string(),
        kind: "host".into(),
        hint: Some(match meta.l3 {
            true => "命中 L3 最高危信号：仅允许单次批准（禁止记住），或拒绝".to_string(),
            false => "请确认主机、身份与操作范围；L2「记住」需勾选确认知悉生产影响".to_string(),
        }),
        reason: Some(format!("命中信号 [{}]：{}", meta.risk_keys.join("+"), meta.scope_digest)),
        grant_key: Some(meta.grant_key.clone()),
        domain: Some("host".into()),
        host_meta: Some(serde_json::to_value(meta).unwrap_or_default()),
        run_id: Some(input.run_id.to_string()),
    }
}

fn action_tool_slug(a: HostAction) -> &'static str {
    match a {
        HostAction::Connect => "connect",
        HostAction::RemoteRead => "read",
        HostAction::RemoteWrite => "write",
        HostAction::RemoteDelete => "delete",
        HostAction::RemoteExec => "exec",
        HostAction::Disconnect => "disconnect",
    }
}

fn scope_digest(input: &GateInput<'_>) -> String {
    let mut parts: Vec<String> = vec![input.action.as_str().to_string()];
    if let Some(c) = input.command {
        parts.push(c.chars().take(120).collect());
    }
    if let Some(p) = input.remote_path {
        parts.push(policy::normalize_posix(p));
    }
    if let Some(c) = input.cwd {
        parts.push(policy::normalize_posix(c));
    }
    parts.join(" :: ")
}

/* ---------------------------- host_grant 存储 ---------------------------- */

async fn lookup_grant(
    app: &AppHandle,
    run_id: &str,
    agent_id: &str,
    server_id: &str,
    action: &str,
    as_user: &str,
    risk_key: &str,
) -> Result<Option<String>, String> {
    let pool = crate::agent::engine::round_compactor::get_pool(app).await?;
    let rows = sqlx::query(
        "SELECT grant_id FROM host_grant WHERE domain='host' AND run_id=? AND agent_id=? \
         AND server_id=? AND action=? AND as_user=? AND risk_key=? AND expires_at > ? \
         AND uses < max_uses LIMIT 1",
    )
    .bind(run_id)
    .bind(agent_id)
    .bind(server_id)
    .bind(action)
    .bind(as_user)
    .bind(risk_key)
    .bind(crate::agent::engine::runtime::now_ms())
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("host_grant 查询失败：{e}"))?;
    Ok(rows.first().map(|r| r.get::<String, _>("grant_id")))
}

async fn bump_grant_uses(app: &AppHandle, grant_id: &str) {
    if let Ok(pool) = crate::agent::engine::round_compactor::get_pool(app).await {
        let _ = sqlx::query("UPDATE host_grant SET uses = uses + 1 WHERE grant_id = ?")
            .bind(grant_id)
            .execute(&pool)
            .await;
    }
}

/// 从审批请求携带的 host_meta（JSON）恢复上下文并写入 host_grant。
pub async fn remember_grant_from_meta(
    app: &AppHandle,
    agent_id: &str,
    meta: &serde_json::Value,
) -> Result<String, String> {
    let meta: HostApprovalMeta =
        serde_json::from_value(meta.clone()).map_err(|e| format!("host_meta 解析失败：{e}"))?;
    remember_grant(app, agent_id, &meta).await
}

/// 工具调度分流入口：host__* 工具按 args 组装 GateInput 并走 authorize。
/// 三态：Proceed（放行）/ NeedApproval（runtime 挂起弹 host 卡片）/ Denied（Err 语义拒绝）。
pub async fn gate_tool_call(
    app: &AppHandle,
    agent_id: &str,
    session_id: Option<&str>,
    run_id: &str,
    tool_name: &str,
    args: &serde_json::Value,
) -> GateOutcome {
    let action = match action_of_tool(tool_name) {
        Some(a) => a,
        None => return GateOutcome::Denied(format!("未知的 host 工具：{tool_name}")),
    };
    // host__list_servers 仅枚举本智能体的绑定档案（无参、无远端 I/O、无 server 目标），
    // 不需要 server_id，也不进授权闸——直接放行（元数据读取，无审计对象）。
    if tool_name == "host__list_servers" {
        return GateOutcome::Proceed("allow_auto");
    }
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    let server_id = match get("server_id") {
        Some(s) if !s.is_empty() => s,
        _ => return GateOutcome::Denied("缺少 server_id 参数".into()),
    };
    let remote_path = get("remote_path").or_else(|| get("path")).or_else(|| get("remote_dir"));
    let local_path = get("local_path").or_else(|| get("local_dir"));
    // 先绑定 String 再借用（避免结构体字面量里引用临时值）
    let as_user_v = get("as_user").unwrap_or_else(|| "login".to_string());
    let command_v = get("command");
    let cwd_v = get("cwd");
    let input = GateInput {
        agent_id,
        session_id,
        run_id,
        server_id: &server_id,
        action,
        as_user: &as_user_v,
        command: command_v.as_deref(),
        cwd: cwd_v.as_deref(),
        remote_path: remote_path.as_deref(),
        local_path: local_path.as_deref(),
        delete_extraneous: args.get("delete_extraneous").and_then(|v| v.as_bool()).unwrap_or(false),
    };
    match authorize(app, &input).await {
        Ok(GateOutcome::Proceed(d)) => GateOutcome::Proceed(d),
        Ok(GateOutcome::NeedApproval(req)) => GateOutcome::NeedApproval(req),
        Ok(GateOutcome::Denied(m)) => GateOutcome::Denied(m),
        Err(e) => GateOutcome::Denied(e),
    }
}

/// 「本任务内记住」写入 host_grant（submit_approval_decision 域分流调用）。
pub async fn remember_grant(
    app: &AppHandle,
    agent_id: &str,
    meta: &HostApprovalMeta,
) -> Result<String, String> {
    let pool = crate::agent::engine::round_compactor::get_pool(app).await?;
    let now = crate::agent::engine::runtime::now_ms();
    let grant_id = format!("hg_{}", &crate::agent::engine::runtime::now_ms().to_string()[..13]);
    // 生命周期：6h 硬上限 + run 结束强制清理（authorize 查询恒带 run_id，跨 run 天然不互认）
    sqlx::query(
        "INSERT INTO host_grant (grant_id, domain, run_id, agent_id, server_id, action, as_user, \
         risk_key, scope_digest, granted_by, granted_at, expires_at, max_uses, uses) \
         VALUES (?,'host',?,?,?,?,?,?,?,?,?,?,?,0)",
    )
    .bind(&grant_id)
    .bind(&meta.run_id)
    .bind(agent_id)
    .bind(&meta.server_id)
    .bind(&meta.action)
    .bind(&meta.as_user)
    .bind(meta.risk_keys.join("+"))
    .bind(&meta.scope_digest)
    .bind("user")
    .bind(now)
    .bind(now + 6 * 3600 * 1000)
    .bind(999_i64)
    .execute(&pool)
    .await
    .map_err(|e| format!("host_grant 写入失败：{e}"))?;
    Ok(grant_id)
}

/// 清理某 run 的全部 host_grant（run 结束调用；跨 run 不互认，残留仅占位）。
pub async fn cleanup_run_grants(app: &AppHandle, run_id: &str) {
    if let Ok(pool) = crate::agent::engine::round_compactor::get_pool(app).await {
        let _ = sqlx::query("DELETE FROM host_grant WHERE run_id = ?")
            .bind(run_id)
            .execute(&pool)
            .await;
    }
}

/// 过期 GC（每次 run 装配时顺手清理，保持 host_grant 表干净）。
pub async fn gc_expired(app: &AppHandle) {
    if let Ok(pool) = crate::agent::engine::round_compactor::get_pool(app).await {
        let _ = sqlx::query("DELETE FROM host_grant WHERE expires_at < ?")
            .bind(crate::agent::engine::runtime::now_ms())
            .execute(&pool)
            .await;
    }
}

/* ---------------------------- 授权审计 ---------------------------- */

async fn write_authz_log(
    app: &AppHandle,
    input: &GateInput<'_>,
    binding: &ServerBinding,
    level: u8,
    signals: &[policy::RiskSignal],
    decision: &str,
    grant_id: Option<&str>,
) {
    let pool = match crate::agent::engine::round_compactor::get_pool(app).await {
        Ok(p) => p,
        Err(_) => return,
    };
    let signals_json = serde_json::to_string(
        &signals
            .iter()
            .map(|s| serde_json::json!({ "riskKey": s.risk_key, "level": s.level, "detail": s.detail }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".into());
    let _ = sqlx::query(
        "INSERT INTO host_authz_log (id, run_id, session_id, agent_id, server_id, action, as_user, \
         risk_level, risk_key, signals_json, decision, grant_id, request_digest, created_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(format!("hal_{}_{}", crate::agent::engine::runtime::now_ms(), crate::agent::engine::runtime::now_ms() % 1000))
    .bind(input.run_id)
    .bind(input.session_id.unwrap_or(""))
    .bind(input.agent_id)
    .bind(input.server_id)
    .bind(input.action.as_str())
    .bind(input.as_user)
    .bind(format!("L{level}"))
    .bind(policy::risk_key_of(signals))
    .bind(signals_json)
    .bind(decision)
    .bind(grant_id)
    .bind(scope_digest(input))
    .bind(crate::agent::engine::runtime::now_ms())
    .execute(&pool)
    .await;
    let _ = binding;
}
