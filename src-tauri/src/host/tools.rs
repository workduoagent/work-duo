//! `host__*` 工具族（12 个，设计稿 §8）：Connection / Command / FTP / Logout。
//!
//! 授权：`authz_domain() == Host` → 调度器在执行前统一走 `HostAuthz::authorize`
//! （本文件内不做授权判定，执行即视为已过闸）。路径白/黑名单为纵深防御，
//! 工具内部对远端路径再做一次校验（防同一工具多入口绕过）。
//! 凭证不入工具参数：连接由 HostPool 依 server_id 托管。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tauri::AppHandle;

use super::exec as exec_impl;
use super::pool;
use super::sftp as sftp_impl;
use super::types::ServerBinding;
use crate::agent::engine::tools::{
    AuthzDomain, PermissionLevel, ToolContext, ToolError, ToolRegistry,
};

type Bindings = Arc<Vec<ServerBinding>>;

fn find_binding<'a>(bindings: &'a Bindings, server_id: &str) -> Result<&'a ServerBinding, ToolError> {
    bindings
        .iter()
        .find(|b| b.server_id == server_id)
        .ok_or_else(|| {
            ToolError::PermissionDenied(format!(
                "NotBound：该智能体未绑定服务器 {server_id}"
            ))
        })
}

fn arg_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn arg_bool(args: &serde_json::Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// 远端路径纵深校验（HostAuthz 之后的第二道闸）。
fn path_guard(binding: &ServerBinding, path: &str) -> Result<(), ToolError> {
    super::policy::check_path(path, &binding.path_allow, &binding.path_deny)
        .map_err(ToolError::PermissionDenied)
}

/// 本地路径守卫：优先 binding.local_path_allow，否则约束在工作空间内。
fn local_guard(ctx: &ToolContext, binding: &ServerBinding, path: &str) -> Result<PathBuf, ToolError> {
    let p = Path::new(path);
    let normalized = if p.is_absolute() {
        p.to_path_buf()
    } else {
        match &ctx.workspace {
            Some(ws) => ws.join(p),
            None => return Err(ToolError::InvalidArgs("本地路径必须为绝对路径".into())),
        }
    };
    if !binding.local_path_allow.is_empty() {
        let norm = normalized.to_string_lossy().replace('\\', "/");
        let hit = binding.local_path_allow.iter().any(|a| {
            let a = a.trim_end_matches('/');
            norm.starts_with(a)
        });
        if !hit {
            return Err(ToolError::PermissionDenied(format!(
                "本地路径不在 local_path_allow 内：{norm}"
            )));
        }
    } else if let Some(ws) = &ctx.workspace {
        let ws = ws.to_string_lossy().replace('\\', "/");
        let norm = normalized.to_string_lossy().replace('\\', "/");
        if !norm.starts_with(ws.trim_end_matches('/')) {
            return Err(ToolError::PermissionDenied(format!(
                "本地路径越出工作空间：{norm}"
            )));
        }
    }
    Ok(normalized)
}

async fn binding_and_session(
    app: &AppHandle,
    bindings: &Bindings,
    ctx: &ToolContext,
    args: &serde_json::Value,
) -> Result<(ServerBinding, pool::SharedHandle), ToolError> {
    let server_id = arg_str(args, "server_id").ok_or_else(|| ToolError::InvalidArgs("缺少 server_id".into()))?;
    let binding = find_binding(bindings, &server_id)?.clone();
    let handle = pool::global()
        .get_or_connect(app, &binding)
        .await
        .map_err(ToolError::ExecutionFailed)?;
    let _ = ctx;
    Ok((binding, handle))
}

/// 执行审计（server_exec_log；approved 恒 approved——详细决策链在 host_authz_log）。
async fn write_exec_log(
    app: &AppHandle,
    ctx: &ToolContext,
    server_id: &str,
    tool_name: &str,
    argv: &str,
    as_user: &str,
    cwd: Option<&str>,
    started: std::time::Instant,
    ok: bool,
    error: Option<String>,
    bytes_in: Option<i64>,
    bytes_out: Option<i64>,
) {
    let pool = match crate::agent::engine::round_compactor::get_pool(app).await {
        Ok(p) => p,
        Err(_) => return,
    };
    let _ = sqlx::query(
        "INSERT INTO server_exec_log (id, server_id, agent_id, session_id, run_id, tool_name, \
         argv, as_user, cwd, started_at, duration_ms, exit_code, bytes_in, bytes_out, approved, error, created_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(format!("sel_{}_{}", crate::agent::engine::runtime::now_ms(), tool_name))
    .bind(server_id)
    .bind(&ctx.agent_id)
    .bind(ctx.session_id.clone().unwrap_or_default())
    .bind(ctx.run_id.clone().unwrap_or_default())
    .bind(tool_name)
    .bind(argv)
    .bind(as_user)
    .bind(cwd.unwrap_or(""))
    .bind(crate::agent::engine::runtime::now_ms() as i64 - started.elapsed().as_millis() as i64)
    .bind(started.elapsed().as_millis() as i64)
    .bind(if ok { Some(0i64) } else { None })
    .bind(bytes_in)
    .bind(bytes_out)
    .bind("approved")
    .bind(error)
    .bind(crate::agent::engine::runtime::now_ms())
    .execute(&pool)
    .await;
}

macro_rules! host_tool_common {
    ($name:literal, $slug:literal, $domain:expr) => {
        fn name(&self) -> String {
            $name.to_string()
        }
        fn authz_domain(&self) -> AuthzDomain {
            $domain
        }
    };
}

/* ----------------------------- Connection 族 ----------------------------- */

struct HostListServersTool {
    app: AppHandle,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostListServersTool {
    host_tool_common!("host__list_servers", "list_servers", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__list_servers",
            "列出当前智能体已绑定的服务器档案（名称 / 地址 / 登录用户 / 路径白名单 / 提权策略）。",
            json!({}),
            &[],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }

    async fn execute(&self, _args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let bindings = super::types::load_bindings(&self.app, &ctx.agent_id)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        Ok(serde_json::to_string(
            &bindings
                .iter()
                .map(|b| json!({
                    "serverId": b.server_id,
                    "name": b.name,
                    "host": b.host,
                    "port": b.port,
                    "user": b.login_user,
                    "sudoMode": b.sudo_mode,
                    "pathAllow": b.path_allow,
                    "defaultCwd": b.default_cwd,
                }))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into()))
    }
}

struct HostConnectTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostConnectTool {
    host_tool_common!("host__connect", "connect", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__connect",
            "连接 / 重连指定服务器（通常自动触发，无需主动调用）。返回登录用户、默认目录与路径白名单。",
            json!({"server_id": {"type": "string"}}),
            &["server_id"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let (binding, _session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        Ok(json!({
            "ok": true,
            "server": binding.name,
            "login_user": binding.login_user,
            "cwd_default": binding.default_cwd,
            "path_allow": binding.path_allow,
            "sudo_mode": binding.sudo_mode,
        })
        .to_string())
    }
}

struct HostStatusTool {
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostStatusTool {
    host_tool_common!("host__status", "status", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__status",
            "查询指定服务器的连接状态与最近错误。",
            json!({"server_id": {"type": "string"}}),
            &["server_id"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> Result<String, ToolError> {
        let server_id = arg_str(&args, "server_id").ok_or_else(|| ToolError::InvalidArgs("缺少 server_id".into()))?;
        find_binding(&self.bindings, &server_id)?;
        let (connected, detail) = pool::global().status(&server_id).await;
        Ok(json!({ "ok": true, "serverId": server_id, "connected": connected, "detail": detail }).to_string())
    }
}

/* ----------------------------- Command 族 ----------------------------- */

struct HostExecTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostExecTool {
    host_tool_common!("host__exec", "exec", AuthzDomain::Host);

    // 台账 S6 进阶：声明式行为元数据——旧 runtime::tool_op 叶子名 "exec" 命中语义。
    // host__ 前缀已走 HostAuthz 独立授权域，此 op 仅驱动本地危险信号的双保险评估
    // （Proceed 已授权时本地 EdgeOp::Exec 仍扫描命令内容，与改造前一致）。
    fn behavior(&self) -> crate::agent::engine::tools::ToolBehavior {
        crate::agent::engine::tools::ToolBehavior {
            op: Some("exec"),
            file_mutating: false,
            file_reading: false,
        }
    }

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__exec",
            "在已连接服务器上执行非交互 shell 命令（Xshell 终端）。需审批。cwd 须在白名单；默认 60s 超时强杀（上限 300s）。禁止交互式 TTY 命令。禁止手拼 sudo/su，请用 as_user。",
            json!({"server_id": {"type": "string"}, "command": {"type": "string"}, "cwd": {"type": "string"}, "timeout_sec": {"type": "number"}, "as_user": {"type": "string", "description": "login（默认）| root | 其他用户；非 login 走 sudo 策略包装并强制 HostAuthz"}, "fail_on_nonzero": {"type": "boolean", "description": "默认 true"}}),
            &["server_id", "command"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let started = std::time::Instant::now();
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let command = arg_str(&args, "command").ok_or_else(|| ToolError::InvalidArgs("缺少 command".into()))?;
        let cwd = arg_str(&args, "cwd");
        let as_user = arg_str(&args, "as_user").unwrap_or_else(|| "login".into());
        let timeout_sec = args.get("timeout_sec").and_then(|v| v.as_u64()).unwrap_or(60);
        let fail_on_nonzero = arg_bool(&args, "fail_on_nonzero", true);

        // 台账 D5：exec 流式传输——执行期间逐块推送 stdout/stderr（agent-event 单通道
        // event_type=host_exec_output + trace 桶双发），前端按 callId 关联到运行中的
        // 工具步骤卡片实时展示；64KB 总量封顶由 exec.rs 内部处理。
        let stream_app = self.app.clone();
        let stream_agent = ctx.agent_id.clone();
        let stream_session = ctx.session_id.clone();
        let stream_server = binding.server_id.clone();
        let stream_call = ctx.call_id.clone().unwrap_or_default();
        let streamed_total = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let streamed_cb = streamed_total.clone();
        let on_output = move |is_stderr: bool, chunk: &str| {
            let n = streamed_cb.fetch_add(chunk.len(), std::sync::atomic::Ordering::Relaxed);
            crate::agent::events::emit_host_exec_output(
                &stream_app,
                &crate::agent::events::HostExecOutputPayload {
                    call_id: stream_call.clone(),
                    tool_name: "host__exec".into(),
                    agent_id: stream_agent.clone(),
                    session_id: stream_session.clone(),
                    server_id: stream_server.clone(),
                    stream: if is_stderr { "stderr".into() } else { "stdout".into() },
                    chunk: chunk.to_string(),
                    streamed_bytes: n + chunk.len(),
                    truncated: false,
                },
            );
        };

        let outcome = exec_impl::exec_command(
            &mut *session.lock().await, &command, cwd.as_deref(), &as_user, &binding.login_user, timeout_sec,
            Some(&on_output),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;

        write_exec_log(
            &self.app, ctx, &binding.server_id, "host_exec", &command, &as_user,
            cwd.as_deref(), started, outcome.exit_code == Some(0), None, None, None,
        ).await;

        let payload = json!({
            "exit_code": outcome.exit_code,
            "stdout": outcome.stdout,
            "stderr": outcome.stderr,
            "elapsed_ms": outcome.elapsed_ms,
            "server_id": binding.server_id,
            "cwd": cwd,
            "as_user": as_user,
        });
        if fail_on_nonzero && outcome.exit_code.unwrap_or(0) != 0 {
            return Err(ToolError::ExecutionFailed(payload.to_string()));
        }
        Ok(payload.to_string())
    }
}

/* ----------------------------- FTP / 文件同步族 ----------------------------- */

struct HostListTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostListTool {
    host_tool_common!("host__list", "list", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__list",
            "列出远程目录内容（名称 / 类型 / 大小）。",
            json!({"server_id": {"type": "string"}, "path": {"type": "string"}}),
            &["server_id", "path"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let path = arg_str(&args, "path").ok_or_else(|| ToolError::InvalidArgs("缺少 path".into()))?;
        path_guard(&binding, &path)?;
        let entries = sftp_impl::list_dir(&mut *session.lock().await, &path)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        Ok(serde_json::to_string(
            &entries
                .iter()
                .map(|e| json!({ "name": e.name, "dir": e.is_dir, "size": e.size }))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_else(|_| "[]".into()))
    }
}

struct HostUploadTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostUploadTool {
    host_tool_common!("host__upload", "upload", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__upload",
            "上传本地文件 / 目录到远程服务器（可递归）。本地路径须在工作空间或 local_path_allow 内。",
            json!({"server_id": {"type": "string"}, "local_path": {"type": "string"}, "remote_path": {"type": "string"}, "recursive": {"type": "boolean"}}),
            &["server_id", "local_path", "remote_path"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let started = std::time::Instant::now();
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let local = arg_str(&args, "local_path").ok_or_else(|| ToolError::InvalidArgs("缺少 local_path".into()))?;
        let remote = arg_str(&args, "remote_path").ok_or_else(|| ToolError::InvalidArgs("缺少 remote_path".into()))?;
        let recursive = arg_bool(&args, "recursive", false);
        let local_path = local_guard(ctx, &binding, &local)?;
        path_guard(&binding, &remote)?;

        let (files, bytes) = sftp_impl::upload(&mut *session.lock().await, &local_path, &remote, recursive)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        write_exec_log(
            &self.app, ctx, &binding.server_id, "host_upload",
            &format!("{local} -> {remote}"), "login", None, started, true, None,
            Some(bytes as i64), None,
        ).await;
        Ok(json!({ "ok": true, "files": files, "bytes": bytes }).to_string())
    }
}

struct HostDownloadTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostDownloadTool {
    host_tool_common!("host__download", "download", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__download",
            "从远程服务器下载文件 / 目录到本地（可递归）。本地落点须在工作空间内。",
            json!({"server_id": {"type": "string"}, "remote_path": {"type": "string"}, "local_path": {"type": "string"}, "recursive": {"type": "boolean"}}),
            &["server_id", "remote_path", "local_path"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let started = std::time::Instant::now();
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let remote = arg_str(&args, "remote_path").ok_or_else(|| ToolError::InvalidArgs("缺少 remote_path".into()))?;
        let local = arg_str(&args, "local_path").ok_or_else(|| ToolError::InvalidArgs("缺少 local_path".into()))?;
        let recursive = arg_bool(&args, "recursive", false);
        let local_path = local_guard(ctx, &binding, &local)?;
        path_guard(&binding, &remote)?;

        let (files, bytes) = sftp_impl::download(&mut *session.lock().await, &remote, &local_path, recursive)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        write_exec_log(
            &self.app, ctx, &binding.server_id, "host_download",
            &format!("{remote} -> {local}"), "login", None, started, true, None,
            Some(bytes as i64), None,
        ).await;
        Ok(json!({ "ok": true, "files": files, "bytes": bytes }).to_string())
    }
}

struct HostSyncTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostSyncTool {
    host_tool_common!("host__sync", "sync", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__sync",
            "双向同步本地与远端目录（按相对路径 + 大小判异）。direction: upload/download/both；delete_extraneous=true 会删除对侧多余文件（升 L2 审批）。",
            json!({"server_id": {"type": "string"}, "local_dir": {"type": "string"}, "remote_dir": {"type": "string"}, "direction": {"type": "string", "enum": ["upload", "download", "both"]}, "delete_extraneous": {"type": "boolean"}, "exclude": {"type": "array", "items": {"type": "string"}}}),
            &["server_id", "local_dir", "remote_dir", "direction"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let started = std::time::Instant::now();
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let local_dir = local_guard(
            ctx,
            &binding,
            &arg_str(&args, "local_dir").ok_or_else(|| ToolError::InvalidArgs("缺少 local_dir".into()))?,
        )
        ?;
        let remote_dir = arg_str(&args, "remote_dir").ok_or_else(|| ToolError::InvalidArgs("缺少 remote_dir".into()))?;
        path_guard(&binding, &remote_dir)?;
        let direction = arg_str(&args, "direction").unwrap_or_else(|| "upload".into());
        let delete_extraneous = arg_bool(&args, "delete_extraneous", false);
        let exclude: Vec<String> = args
            .get("exclude")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        let excluded = |rel: &str, name: &str| {
            exclude.iter().any(|pat| rel.contains(pat.as_str()) || name == pat)
        };

        let remote_tree = sftp_impl::list_tree(&mut *session.lock().await, &remote_dir)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let local_tree = sftp_impl::list_local_tree(&local_dir).map_err(ToolError::ExecutionFailed)?;

        let (mut up_files, mut down_files, mut del_files) = (0u64, 0u64, 0u64);
        let (mut up_bytes, mut down_bytes) = (0u64, 0u64);

        let local_map: std::collections::HashMap<String, u64> =
            local_tree.iter().cloned().map(|e| (e.rel, e.size)).collect();
        let remote_map: std::collections::HashMap<String, u64> =
            remote_tree.iter().cloned().map(|e| (e.rel, e.size)).collect();

        if direction == "upload" || direction == "both" {
            for e in &local_tree {
                if excluded(&e.rel, e.rel.rsplit('/').next().unwrap_or("")) {
                    continue;
                }
                if remote_map.get(&e.rel) != Some(&e.size) {
                    let lf = local_dir.join(&e.rel);
                    let rf = format!("{}/{}", remote_dir.trim_end_matches('/'), e.rel);
                    sftp_impl::upload(&mut *session.lock().await, &lf, &rf, false)
                        .await
                        .map_err(ToolError::ExecutionFailed)?;
                    up_files += 1;
                    up_bytes += e.size;
                }
            }
        }
        if direction == "download" || direction == "both" {
            for e in &remote_tree {
                if excluded(&e.rel, e.rel.rsplit('/').next().unwrap_or("")) {
                    continue;
                }
                if local_map.get(&e.rel) != Some(&e.size) {
                    let rf = format!("{}/{}", remote_dir.trim_end_matches('/'), e.rel);
                    let lf = local_dir.join(&e.rel);
                    sftp_impl::download(&mut *session.lock().await, &rf, &lf, false)
                        .await
                        .map_err(ToolError::ExecutionFailed)?;
                    down_files += 1;
                    down_bytes += e.size;
                }
            }
        }
        if delete_extraneous {
            if direction == "upload" || direction == "both" {
                for e in &remote_tree {
                    if !local_map.contains_key(&e.rel) {
                        sftp_impl::remove(
                            &mut *session.lock().await,
                            &format!("{}/{}", remote_dir.trim_end_matches('/'), e.rel),
                            false,
                        )
                        .await
                        .map_err(ToolError::ExecutionFailed)?;
                        del_files += 1;
                    }
                }
            }
            if direction == "download" || direction == "both" {
                for e in &local_tree {
                    if !remote_map.contains_key(&e.rel) {
                        let _ = tokio::fs::remove_file(local_dir.join(&e.rel)).await;
                        del_files += 1;
                    }
                }
            }
        }

        write_exec_log(
            &self.app, ctx, &binding.server_id, "host_sync",
            &format!("{direction} {local_dir:?} <-> {remote_dir:?}"), "login", None, started, true, None,
            Some(down_bytes as i64), Some(up_bytes as i64),
        ).await;
        Ok(json!({
            "ok": true, "direction": direction,
            "uploaded": up_files, "uploadedBytes": up_bytes,
            "downloaded": down_files, "downloadedBytes": down_bytes,
            "deleted": del_files, "deleteExtraneous": delete_extraneous,
        })
        .to_string())
    }
}

struct HostMkdirTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostMkdirTool {
    host_tool_common!("host__mkdir", "mkdir", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__mkdir",
            "在远程服务器递归创建目录（已存在跳过）。",
            json!({"server_id": {"type": "string"}, "path": {"type": "string"}}),
            &["server_id", "path"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let started = std::time::Instant::now();
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let path = arg_str(&args, "path").ok_or_else(|| ToolError::InvalidArgs("缺少 path".into()))?;
        path_guard(&binding, &path)?;
        sftp_impl::mkdir_p(&mut *session.lock().await, &path)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        write_exec_log(
            &self.app, ctx, &binding.server_id, "host_mkdir", &path, "login", None,
            started, true, None, None, None,
        ).await;
        Ok(json!({ "ok": true, "path": path }).to_string())
    }
}

struct HostRemoveTool {
    app: AppHandle,
    bindings: Bindings,
}

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostRemoveTool {
    host_tool_common!("host__remove", "remove", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__remove",
            "删除远程文件 / 目录（recursive=true 递归删除，属 L2 高危操作）。",
            json!({"server_id": {"type": "string"}, "path": {"type": "string"}, "recursive": {"type": "boolean"}}),
            &["server_id", "path"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let started = std::time::Instant::now();
        let (binding, session) = binding_and_session(&self.app, &self.bindings, ctx, &args).await?;
        let path = arg_str(&args, "path").ok_or_else(|| ToolError::InvalidArgs("缺少 path".into()))?;
        let recursive = arg_bool(&args, "recursive", false);
        path_guard(&binding, &path)?;
        let (files, dirs) = sftp_impl::remove(&mut *session.lock().await, &path, recursive)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        write_exec_log(
            &self.app, ctx, &binding.server_id, "host_remove", &path, "login", None,
            started, true, None, None, None,
        ).await;
        Ok(json!({ "ok": true, "files": files, "dirs": dirs }).to_string())
    }
}

/* ----------------------------- Logout 族 ----------------------------- */

struct HostDisconnectTool;

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostDisconnectTool {
    host_tool_common!("host__disconnect", "disconnect", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__disconnect",
            "断开指定服务器的连接（幂等）。",
            json!({"server_id": {"type": "string"}}),
            &["server_id"],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext) -> Result<String, ToolError> {
        let server_id = arg_str(&args, "server_id").ok_or_else(|| ToolError::InvalidArgs("缺少 server_id".into()))?;
        pool::global().disconnect(&server_id).await.map_err(ToolError::ExecutionFailed)?;
        Ok(json!({ "ok": true, "serverId": server_id }).to_string())
    }
}

struct HostDisconnectAllTool;

#[async_trait]
impl crate::agent::engine::tools::AgentTool for HostDisconnectAllTool {
    host_tool_common!("host__disconnect_all", "disconnect_all", AuthzDomain::Host);

    fn tool_definition(&self) -> serde_json::Value {
        // 规范 function-calling 形状（复用 native::def；扁平结构会被网关丢弃 → 模型看不到工具）
        crate::agent::engine::native::def(
            "host__disconnect_all",
            "断开全部服务器连接。",
            json!({}),
            &[],
        )
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }

    async fn execute(&self, _args: serde_json::Value, _ctx: &ToolContext) -> Result<String, ToolError> {
        let n = pool::global().disconnect_all().await.map_err(ToolError::ExecutionFailed)?;
        Ok(json!({ "ok": true, "disconnected": n }).to_string())
    }
}

/* ----------------------------- 装配 ----------------------------- */

pub fn all_tools(app: AppHandle, bindings: Bindings) -> Vec<Box<dyn crate::agent::engine::tools::AgentTool>> {
    vec![
        Box::new(HostListServersTool { app: app.clone() }),
        Box::new(HostConnectTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostStatusTool { bindings: bindings.clone() }),
        Box::new(HostExecTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostListTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostUploadTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostDownloadTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostSyncTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostMkdirTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostRemoveTool { app: app.clone(), bindings: bindings.clone() }),
        Box::new(HostDisconnectTool),
        Box::new(HostDisconnectAllTool),
    ]
}

/// 提供给 runtime 的公共入口：把 host 工具注册进注册表（绑定非空才注册）。
pub fn register_host_tools_into(
    registry: &mut ToolRegistry,
    app: &AppHandle,
    bindings: Bindings,
) {
    if bindings.is_empty() {
        return;
    }
    for tool in all_tools(app.clone(), bindings) {
        registry.register(Arc::from(tool));
    }
}
