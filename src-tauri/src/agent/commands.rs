//! 智能体运行时 Tauri 命令入口（供前端 invoke）。
//!
//!  - `run_agent_task`：启动一轮任务（后台 spawn ReAct 循环，事件流推前端）；
//!  - `submit_approval_decision`：回传高危操作审批决策；
//!  - `cancel_agent_task`：取消当前任务（best-effort）。
//!
//! 命令经 `@tauri-apps/plugin-sql` 读取 agent_info 与关联表，组装 `AgentRuntimeConfig`，
//! 不依赖前端重复传参（前端仅传 agentId + prompt + workspace）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

use sqlx::Row;
use tauri_plugin_sql::{DbInstances, DbPool};

/// 运行时单轮能力上限（与前端 draft.ts 创建约束一致）：技能数、MCP 服务数。
/// `@` 临时启用的能力并入后同样受此上限兜底，超出部分按"先绑定后启用"顺序截断。
const MAX_SKILLS: usize = 3;
const MAX_MCP_SERVERS: usize = 3;

/// 自测闭环 run_id 自增序号（与毫秒时间戳组合，保证单次进程内唯一且可读）。
static RUN_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// 生成自测运行 id（如 `run-1715223456789-0`）。
fn next_run_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = RUN_ID_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("run-{ts}-{seq}")
}

/// 当前毫秒时间戳（用于运行记录）。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

use crate::agent::approval::ApprovalDecisionInput;
use crate::agent::events;
use crate::agent::mcp_adapter::MountedMcpTool;
use crate::agent::recovery::RecoveryDecision;
use crate::agent::runtime::AgentRuntime;
use crate::agent::runtime::RunRecord;
use crate::agent::skill_adapter::SkillToolWrapper;
use crate::agent::tools::{PathGuard, ToolContext};
use crate::agent::native::parse_host_allowlist;
use crate::agent::types::MountedUserPlugin;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::BranchStep;
use crate::agent::types::PlanBranchGenerated;
use crate::agent::types::PlanDAG;
use crate::agent::types::ReadArtifactResult;
use crate::agent::knowledge;
use crate::agent::memory::{self, HeatmapPoint, MemoryItem};
use crate::agent::types::{
    SquadChatConfig, SquadMemberConfig, SquadRunStrategy, SquadRuntimeConfig,
};

/// 前端入参（run_agent_task）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentTaskInput {
    pub agent_id: String,
    pub prompt: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// 前端建好的会话 id（agent_conversation_session.id），用于累计 input_token 与上下文压缩。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 前端建好的本轮 id（agent_conversation_round.id），ReAct 循环结束后由 Rust 回填 raw_messages_json。
    #[serde(default)]
    pub round_id: Option<String>,
    /// 本轮临时禁用的技能 id 列表（仅会话内有效，不写库）。load_config 据此从技能工具集中剔除。
    #[serde(default)]
    pub disabled_skill_ids: Option<Vec<String>>,
    /// 本轮临时禁用的 MCP 服务 id 列表（仅会话内有效，不写库）。load_config 据此剔除该服务下全部工具。
    #[serde(default)]
    pub disabled_mcp_ids: Option<Vec<String>>,
    /// 本轮临时禁用的单个 MCP 工具 id 列表（仅会话内有效，不写库）。键为 mcp_tool_definition.id。
    #[serde(default)]
    pub disabled_mcp_tool_ids: Option<Vec<String>>,
    /// 本轮临时启用的技能 id 列表（`@` 提及触发，仅会话内有效，不写库）。
    /// 可包含「智能体未绑定」的技能——load_config 据此把其临时并入工具集（受 MAX_SKILLS 兜底）。
    #[serde(default)]
    pub enabled_skill_ids: Option<Vec<String>>,
    /// 本轮临时启用的 MCP 服务 id 列表（`@` 提及触发，仅会话内有效，不写库）。
    /// 可包含「智能体未绑定」的 MCP 服务——load_config 据此把其全部工具临时并入工具集。
    #[serde(default)]
    pub enabled_mcp_ids: Option<Vec<String>>,
    /// 本轮临时禁用的插件 id 列表（仅会话内有效，不写库）。load_config 据此从插件工具集中剔除。
    #[serde(default)]
    pub disabled_plugin_ids: Option<Vec<String>>,
    /// 本轮临时启用的插件 id 列表（`@` 提及触发，仅会话内有效，不写库）。
    /// 可包含「智能体未绑定」的插件——load_config 据此临时并入工具集（受 10 个上限兜底）。
    #[serde(default)]
    pub enabled_plugin_ids: Option<Vec<String>>,
    /// 本轮用户消息附件（多模态图片）。前端契约 { type, dataUrl, name? }。
    #[serde(default)]
    pub attachments: Option<Vec<crate::agent::types::AttachmentInput>>,
    /// §3.2 分支重跑：前端直接提供完整计划（head + 新分支 tail），跳过 LLM 规划阶段，
    /// 流水线仅执行 tail 新分支（head 由 `pre_completed` 标记为已完成、跳过执行）。
    #[serde(default)]
    pub plan_override: Option<PlanDAG>,
    /// 分支起点之前的已完成 head 步骤 task_id 列表（流水线跳过执行，仅沿用其结果）。
    #[serde(default)]
    pub pre_completed: Option<Vec<String>>,
    /// 产物管道初始上下文（head 步骤的已完成摘要），供 tail 步骤续接。
    #[serde(default)]
    pub initial_context: Option<String>,
}

/// 启动一轮智能体任务。
#[tauri::command]
pub async fn run_agent_task(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: RunAgentTaskInput,
) -> Result<(), String> {
    // 并发互斥（spawn 前主闸门，且必须早于 load_config）：连点「运行」时第二次请求
    // 立刻拿到 Err，零 DB 开销；若 load_config 失败，guard 随 `?` 提前 return 自动 Drop，
    // 锁正确释放，无需额外处理。
    // 20260919002：锁粒度 per-agent——同一 Agent 互斥，不同 Agent 可并行。
    let (task_state, running_guard) = match runtime.try_acquire_run_lock(&input.agent_id) {
        Some(pair) => pair,
        None => {
            tracing::warn!("[agent] run_agent_task: agent {} 已有任务在运行，拒绝重复启动", input.agent_id);
            return Err("该智能体已有任务正在运行，请先等待其完成或点击停止。".into());
        }
    };

    let cfg = load_config(
        &app,
        &input.agent_id,
        input.workspace.clone(),
        input.session_id.clone(),
        input.round_id.clone(),
        input.disabled_skill_ids.clone(),
        input.disabled_mcp_ids.clone(),
        input.disabled_mcp_tool_ids.clone(),
        input.enabled_skill_ids.clone(),
        input.enabled_mcp_ids.clone(),
        input.disabled_plugin_ids.clone(),
        input.enabled_plugin_ids.clone(),
        input.attachments.clone(),
        Some(input.prompt.clone()),
    )
    .await?;

    tracing::info!(
        "[agent] run_agent_task 收到请求: agent_id={} prompt_len={} workspace={:?} 附件数={}",
        input.agent_id,
        input.prompt.chars().count(),
        input.workspace,
        input.attachments.as_ref().map(|a| a.len()).unwrap_or(0),
    );

    let app_clone = app.clone();
    let rt = runtime.inner().clone();
    let prompt = input.prompt.clone();
    // §3.2 分支重跑：把前端传入的计划覆盖 / 预完成步骤 / 初始上下文透传给 run_task。
    let plan_override = input.plan_override.clone();
    let pre_completed: std::collections::HashSet<String> =
        input.pre_completed.clone().unwrap_or_default().into_iter().collect();
    let initial_context = input.initial_context.clone().unwrap_or_default();

    // 锁已在上方入口处抢占（running_guard）：跨 spawn 持有，run_task 任意出口
    // （正常 / 取消 / panic）自动复位 running 并回收状态束；本处不再抢锁。
    events::reset_trace(); // 自测闭环：清空轨迹缓冲，保证只反映本次 run
    tauri::async_runtime::spawn(async move {
        let _running_guard = running_guard;
        tracing::info!("[agent] run_agent_task 后台任务已 spawn，开始 run_task");
        rt.run_task(&app_clone, cfg, prompt, plan_override, pre_completed, initial_context, &task_state)
            .await;
        tracing::info!("[agent] run_agent_task 后台任务 run_task 结束");
    });
    Ok(())
}

/// 自测闭环专用：启动一轮任务并返回 `run_id`，供 `get_status`/`wait_task` 轮询。
///
/// 内部**完全复用** `run_agent_task` 的既有链路（全局互斥锁 → `load_config` → spawn `run_task`），
/// 仅额外在 `AgentRuntime::run_registry` 中写入一条 `running` 记录，并在 run_task 结束后置为 `done`。
/// 不改变 `run_agent_task` 的任何既有行为（其 run_id 为 None，不入表），零侵入。
#[tauri::command]
pub async fn run_task_ex(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: RunAgentTaskInput,
) -> Result<String, String> {
    let run_id = next_run_id();

    // 20260919002：锁粒度 per-agent——同一 Agent 互斥，不同 Agent 可并行。
    let (task_state, running_guard) = match runtime.try_acquire_run_lock(&input.agent_id) {
        Some(pair) => pair,
        None => {
            return Err(format!(
                "智能体 {} 已有任务正在运行，请先等待其完成。",
                input.agent_id
            ));
        }
    };

    let cfg = load_config(
        &app,
        &input.agent_id,
        input.workspace.clone(),
        input.session_id.clone(),
        input.round_id.clone(),
        input.disabled_skill_ids.clone(),
        input.disabled_mcp_ids.clone(),
        input.disabled_mcp_tool_ids.clone(),
        input.enabled_skill_ids.clone(),
        input.enabled_mcp_ids.clone(),
        input.disabled_plugin_ids.clone(),
        input.enabled_plugin_ids.clone(),
        input.attachments.clone(),
        Some(input.prompt.clone()),
    )
    .await?;

    {
        let mut reg = runtime.run_registry.lock().await;
        reg.insert(
            run_id.clone(),
            RunRecord {
                run_id: run_id.clone(),
                agent_id: input.agent_id.clone(),
                session_id: input.session_id.clone(),
                round_id: input.round_id.clone(),
                status: "running".to_string(),
                started_at: now_ms(),
                finished_at: None,
                error: None,
            },
        );
    }

    let app_clone = app.clone();
    let rt = runtime.inner().clone();
    let prompt = input.prompt.clone();
    let plan_override = input.plan_override.clone();
    let pre_completed: std::collections::HashSet<String> =
        input.pre_completed.clone().unwrap_or_default().into_iter().collect();
    let initial_context = input.initial_context.clone().unwrap_or_default();
    let reg = runtime.run_registry.clone();
    let rid = run_id.clone();

    events::reset_trace(); // 自测闭环：清空轨迹缓冲，保证只反映本次 run
    tauri::async_runtime::spawn(async move {
        let _running_guard = running_guard;
        rt.run_task(
            &app_clone,
            cfg,
            prompt,
            plan_override,
            pre_completed,
            initial_context,
            &task_state,
        )
        .await;
        let mut reg = reg.lock().await;
        if let Some(rec) = reg.get_mut(&rid) {
            rec.status = "done".to_string();
            rec.finished_at = Some(now_ms());
        }
    });

    Ok(run_id)
}

/// 自测闭环：按 `run_id` 查询单次运行状态。
#[tauri::command]
pub async fn get_status(
    runtime: State<'_, AgentRuntime>,
    run_id: String,
) -> Result<RunRecord, String> {
    let reg = runtime.run_registry.lock().await;
    match reg.get(&run_id) {
        Some(r) => Ok(r.clone()),
        None => Err(format!("run_id 不存在: {run_id}")),
    }
}

/// 自测闭环：轮询等待 `run_id` 进入终态（done/error），超时返回 Err。
#[tauri::command]
pub async fn wait_task(
    runtime: State<'_, AgentRuntime>,
    run_id: String,
    timeout_ms: Option<u64>,
) -> Result<RunRecord, String> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        {
            let reg = runtime.run_registry.lock().await;
            match reg.get(&run_id) {
                Some(r) if r.status == "done" || r.status == "error" => {
                    return Ok(r.clone());
                }
                None => return Err(format!("run_id 不存在: {run_id}")),
                _ => {}
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("等待 run_id={run_id} 超时（{}ms）", timeout.as_millis()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// 回传审批决策。20260919002：agent_id 缺省时路由到唯一在跑任务（多任务并行须显式传）。
#[tauri::command]
pub async fn submit_approval_decision(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
    decision: ApprovalDecisionInput,
) -> Result<bool, String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    // 15007：「本任务内记住」勾选 → 把策略授权 key 写入 grants（同信号后续操作放行）。
    // 仅 approve/takeover 生效；skip 意味着拒绝，不该记住。
    if decision.remember && decision.decision != "skip" {
        if let Some(key) = &decision.grant_key {
            task.approval_grants.grant(key);
        }
    }
    Ok(task.approval.resolve(decision).await)
}

/// 回传方案推荐选择（Agent 调 `native__ask_user_choice` 挂起后，用户点选唤醒）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitChoiceInput {
    pub choice_id: String,
    pub option_id: String,
    /// 用户走「其他 / 自定义」自由文本入口时填写的方案文本（可选）。
    #[serde(default)]
    pub custom_text: Option<String>,
}

#[tauri::command]
pub async fn submit_choice_decision(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
    input: SubmitChoiceInput,
) -> Result<bool, String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    Ok(task
        .choice
        .resolve(&input.choice_id, &input.option_id, input.custom_text)
        .await)
}

/// 取消当前任务（最佳努力）：置位该 Agent 的取消标志，后台 run_task 流水线与流式拉取循环
/// 会在下一轮边界 / 下一个 SSE chunk 处感知并立即终止，无需额外的任务句柄。
/// 20260919002：按 agent_id 路由（并行任务只停目标 Agent）；agent_id 缺省时取唯一在跑任务。
#[tauri::command]
pub async fn cancel_agent_task(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
) -> Result<(), String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    task.cancel_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    // 若后台流水线正挂在恢复等待上，同步唤醒（否则取消信号无法跳出 wait 挂起）。
    task.recovery.cancel();
    // 若后台流水线正挂在敏感工具审批上，清空所有 pending 审批（drop Sender →
    // `rx.await` 走拒绝分支），否则「停止」无法跳出审批挂起、任务永久卡住。
    task.approval.cancel_all().await;
    task.choice.cancel_all().await;
    // 若后台流水线正挂在计划审批门禁上，唤醒（否则「停止」无法跳出等待、任务永久卡住）。
    task.plan_approval.cancel();
    tracing::info!(
        "[agent] cancel_agent_task: agent {} 已置位取消标志，后台任务将尽快终止",
        task.agent_id
    );
    Ok(())
}

/// 通用恢复决策入参（resolve_subtask 使用）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSubtaskInput {
    /// 决策：retry | skip | takeover | change-approach。
    pub decision: String,
    /// 接管 / 改方案时用户的补充指示或新方案（可空；空等价于各自默认回灌诊断重试）。
    #[serde(default)]
    pub guidance: Option<String>,
}

/// 重试当前受阻子任务（步骤级恢复按钮之一）。20260919002：按 agent_id 路由。
#[tauri::command]
pub async fn retry_subtask(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
) -> Result<bool, String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    if !task.recovery.is_blocked() {
        return Ok(false); // 当前没有子任务在等待恢复
    }
    task.recovery.resolve(RecoveryDecision::Retry);
    Ok(true)
}

/// 跳过当前受阻子任务，标记为已跳过并继续后续步骤（步骤级恢复按钮之一）。
#[tauri::command]
pub async fn skip_subtask(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
) -> Result<bool, String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    if !task.recovery.is_blocked() {
        return Ok(false);
    }
    task.recovery.resolve(RecoveryDecision::Skip);
    Ok(true)
}

/// 通用恢复决策入口：decision ∈ {retry, skip, takeover}，takeover 时携带 guidance。
/// 前端恢复面板三按钮统一经此下发（retry/skip 也可改用专用命令）。
#[tauri::command]
pub async fn resolve_subtask(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
    input: ResolveSubtaskInput,
) -> Result<bool, String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    if !task.recovery.is_blocked() {
        return Ok(false);
    }
    let decision = match input.decision.to_lowercase().as_str() {
        "retry" => RecoveryDecision::Retry,
        "skip" => RecoveryDecision::Skip,
        "takeover" => RecoveryDecision::Takeover(input.guidance.unwrap_or_default()),
        "change-approach" => RecoveryDecision::ChangeApproach(input.guidance.unwrap_or_default()),
        other => {
            return Err(format!(
                "未知恢复决策：{other}（应为 retry/skip/takeover/change-approach）"
            ))
        }
    };
    task.recovery.resolve(decision);
    Ok(true)
}

/// 计划审批决策入参（submit_plan_decision 使用）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitPlanApprovalInput {
    /// 决策：approve | reject | revise。
    pub decision: String,
    /// 修改意见（revise 时携带，可空；空等价于 approve）。
    #[serde(default)]
    pub guidance: Option<String>,
}

/// 计划审批门禁决策入口（Phase 2b-3）：decision ∈ {approve, reject, revise}。
/// 前端「计划确认」弹窗统一经此下发；后端 `run_task` 在规划完成后、执行前挂起等待。
#[tauri::command]
pub async fn submit_plan_decision(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
    input: SubmitPlanApprovalInput,
) -> Result<bool, String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    if !task.plan_approval.is_blocked() {
        return Ok(false);
    }
    let decision = match input.decision.to_lowercase().as_str() {
        "approve" => crate::agent::plan_approval::PlanApprovalDecision::Approve,
        "reject" => crate::agent::plan_approval::PlanApprovalDecision::Reject,
        "revise" => crate::agent::plan_approval::PlanApprovalDecision::Revise(input.guidance.unwrap_or_default()),
        other => {
            return Err(format!(
                "未知计划审批决策：{other}（应为 approve/reject/revise）"
            ))
        }
    };
    task.plan_approval.resolve(decision);
    Ok(true)
}

/// 开始附件分片暂存会话（前端分块上传超大文件，避免在 `run_agent_task` IPC 中内联 base64）。
#[tauri::command]
pub async fn begin_stage_attachment(name: String, mime: String) -> Result<String, String> {
    Ok(crate::agent::context::stage_begin(name, mime))
}

/// 追加一个分片（来自前端 `Uint8Array`，经 Tauri 二进制 IPC 传输）。
#[tauri::command]
pub async fn append_stage_chunk(stage_id: String, data: Vec<u8>) -> Result<(), String> {
    crate::agent::context::stage_append(&stage_id, &data)
}

/// 提交分片暂存：落盘到 `workspace/.attachments/` 并返回最终路径，清理缓冲。
#[tauri::command]
pub async fn commit_stage_attachment(
    stage_id: String,
    workspace: Option<String>,
) -> Result<String, String> {
    crate::agent::context::stage_commit(&stage_id, &workspace)
}

/// 取消分片暂存（前端上传失败 / 超时清理）。
#[tauri::command]
pub async fn abort_stage_attachment(stage_id: String) -> Result<(), String> {
    crate::agent::context::stage_abort(&stage_id);
    Ok(())
}

/// 读取产物预览内容（画布点击产物调用）。路径经 `PathGuard::check` 校验仍位于 workspace 内，
/// 防止越界读取宿主文件。按扩展名返回不同载荷：文本（截断）/ 图片 base64 / 目录列表 / 二进制不可预览。
#[tauri::command]
pub async fn read_artifact(
    path: String,
    workspace: Option<String>,
    max_bytes: Option<u64>,
) -> Result<ReadArtifactResult, String> {
    let ws = workspace.ok_or_else(|| "read_artifact 需要 workspace 参数".to_string())?;
    let ctx = ToolContext {
        workspace: Some(PathBuf::from(&ws)),
        sandbox_enabled: false,
        agent_id: String::new(),
        session_id: None,
        http_allowed_hosts: Vec::new(),
        run_outcomes: Default::default(),
    };
    let abs = match PathGuard::check(&path, &ctx) {
        Ok(p) => p,
        Err(e) => {
            let name = file_name(&path);
            return Ok(ReadArtifactResult {
                path,
                name,
                kind: "error".into(),
                size: 0,
                content: Some(format!("路径校验失败：{e:?}")),
                data_url: None,
                mime: None,
                entries: None,
                truncated: false,
            });
        }
    };
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未知文件")
        .to_string();

    let meta = match std::fs::metadata(&abs) {
        Ok(m) => m,
        Err(e) => {
            let kind = if e.kind() == std::io::ErrorKind::NotFound {
                "not_found"
            } else {
                "error"
            };
            return Ok(ReadArtifactResult {
                path: abs.to_string_lossy().into(),
                name,
                kind: kind.into(),
                size: 0,
                content: Some(format!("读取失败：{e}")),
                data_url: None,
                mime: None,
                entries: None,
                truncated: false,
            });
        }
    };

    // 目录：返回子项名称列表。
    if meta.is_dir() {
        let entries = std::fs::read_dir(&abs)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        return Ok(ReadArtifactResult {
            path: abs.to_string_lossy().into(),
            name,
            kind: "directory".into(),
            size: meta.len(),
            content: None,
            data_url: None,
            mime: None,
            entries: Some(entries),
            truncated: false,
        });
    }

    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = guess_mime(&ext);
    let is_image = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
    );

    // 图片：读取字节编码为 data URL，前端直接 <img> 渲染。
    if is_image {
        return match std::fs::read(&abs) {
            Ok(bytes) => {
                let b64 = BASE64_STANDARD.encode(&bytes);
                Ok(ReadArtifactResult {
                    path: abs.to_string_lossy().into(),
                    name,
                    kind: "image".into(),
                    size: meta.len(),
                    content: None,
                    data_url: Some(format!("data:{};base64,{}", mime, b64)),
                    mime: Some(mime),
                    entries: None,
                    truncated: false,
                })
            }
            Err(e) => Ok(ReadArtifactResult {
                path: abs.to_string_lossy().into(),
                name,
                kind: "error".into(),
                size: meta.len(),
                content: Some(format!("读取失败：{e}")),
                data_url: None,
                mime: None,
                entries: None,
                truncated: false,
            }),
        };
    }

    // 文本 / 二进制：先尝试按 UTF-8 文本读取（超长截断），失败则视为 binary。
    let limit = max_bytes.unwrap_or(200_000).min(1_000_000);
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => {
            return Ok(ReadArtifactResult {
                path: abs.to_string_lossy().into(),
                name,
                kind: "error".into(),
                size: meta.len(),
                content: Some(format!("读取失败：{e}")),
                data_url: None,
                mime: None,
                entries: None,
                truncated: false,
            });
        }
    };
    match String::from_utf8(bytes) {
        Ok(text) => {
            let truncated = text.len() > limit as usize;
            let preview = if truncated {
                text.chars().take(limit as usize).collect::<String>()
            } else {
                text
            };
            Ok(ReadArtifactResult {
                path: abs.to_string_lossy().into(),
                name,
                kind: "text".into(),
                size: meta.len(),
                content: Some(preview),
                data_url: None,
                mime: Some(mime),
                entries: None,
                truncated,
            })
        }
        Err(_) => Ok(ReadArtifactResult {
            path: abs.to_string_lossy().into(),
            name,
            kind: "binary".into(),
            size: meta.len(),
            content: Some(format!(
                "该文件为二进制（{}），暂不支持内联预览；完整路径：{}",
                mime,
                abs.display()
            )),
            data_url: None,
            mime: Some(mime),
            entries: None,
            truncated: false,
        }),
    }
}

/// 分支重规划入参（画布右键「从此步骤分支」触发）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFromStepInput {
    pub agent_id: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// 分支起点步骤序号（从该步骤之后重新规划）。
    pub from_step: usize,
    /// 用户触发分支时的目标 / 原因摘要。
    pub goal_summary: String,
    /// 已完成前序步骤的上下文摘要（可选，供规划器复用）。
    #[serde(default)]
    pub prior_context: Option<String>,
    /// 原方案尾部步骤（step > from_step），由前端传回以便对比展示（后端不持运行期规划状态）。
    #[serde(default)]
    pub original_tail: Option<Vec<BranchStep>>,
    /// 额外补充指示（可选）。
    #[serde(default)]
    pub guidance: Option<String>,
}

/// 分支重规划：基于已完成上下文，从 `from_step` 之后重新生成后续步骤 DAG，
/// 与原尾段做双分支对比，经 `agent-plan-branch` 事件推前端画布渲染对比横幅 + 应用按钮。
#[tauri::command]
pub async fn branch_from_step(app: AppHandle, input: BranchFromStepInput) -> Result<(), String> {
    let cfg = load_config(
        &app,
        &input.agent_id,
        input.workspace.clone(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, // disabled_plugin_ids：分支规划阶段不剔除插件
        None, // enabled_plugin_ids：分支规划阶段不临时并入插件
        None, // attachments：分支规划阶段不携带附件
        None, // prompt：分支规划无 session，记忆召回保持 ref_count 序
    )
    .await?;

    let prior = input.prior_context.clone().unwrap_or_default();
    let guidance = input.guidance.clone().unwrap_or_default();
    let prompt = format!(
        "请重新规划任务「从步骤 {} 起」的后续步骤（分支重规划）。\n\n\
        【已完成的前序步骤（step ≤ {}）上下文】：\n{}\n\n\
        【需要重新规划的原因 / 目标】：\n{}{}\n\n\
        请基于上述已完成上下文，产出从步骤 {} 开始的后续步骤 DAG（JSON）。\
        步骤须能独立执行、产出可核验文件；不要重复前序已完成步骤；\
        新步骤的 step 字段从 {} 开始连续编号；保持与原方案一致的拆分粒度。",
        input.from_step + 1,
        input.from_step,
        if prior.is_empty() {
            "（无，或上下文由对话历史提供）"
        } else {
            &prior
        },
        input.goal_summary,
        if guidance.is_empty() {
            String::new()
        } else {
            format!(" 补充指示：{guidance}")
        },
        input.from_step + 1,
        input.from_step + 1,
    );

    let (plan, _, _) =
        crate::agent::planner::build_plan(&cfg, &prompt, cfg.workspace.as_deref()).await;

    // 重编号新分支步骤，续接原步骤序号（from_step+1 起）。
    let base = input.from_step;
    let branch_tasks: Vec<BranchStep> = plan
        .tasks
        .into_iter()
        .enumerate()
        .map(|(i, t)| BranchStep {
            step: base + i + 1,
            task_id: t.task_id,
            title: t.title,
            description: t.description,
            depends_on: t.depends_on,
        })
        .collect();

    let branch = PlanBranchGenerated {
        from_step: input.from_step,
        original_tail: input.original_tail.unwrap_or_default(),
        branch_tasks,
        goal_summary: input.goal_summary.clone(),
    };
    crate::agent::events::emit_plan_branch(&app, &branch);
    tracing::info!(
        "[agent] branch_from_step: 已生成分支（from_step={} 共 {} 步新分支）",
        input.from_step,
        branch.branch_tasks.len()
    );
    Ok(())
}

/// 列举记忆宫殿记忆（对应前端卡片网格）。可选 agent_id / 分类 / 关键词过滤。
#[tauri::command]
pub async fn list_memories(
    app: AppHandle,
    agent_id: Option<String>,
    category: Option<String>,
    query: Option<String>,
) -> Result<Vec<MemoryItem>, String> {
    memory::list_memories(&app, agent_id.as_deref(), category.as_deref(), query.as_deref()).await
}

/// 记忆热力图数据：按日聚合的召回次数（驱动 GitHub 式日历热力图）。
#[tauri::command]
pub async fn get_memory_heatmap(
    app: AppHandle,
    agent_id: Option<String>,
) -> Result<Vec<HeatmapPoint>, String> {
    memory::get_memory_heatmap(&app, agent_id.as_deref()).await
}

/// 锚定记忆入参（anchor_memory 命令）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorMemoryInput {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub key: String,
    pub content: String,
    #[serde(default)]
    pub category: Option<String>,
    /// true=手动锚定（钉住，anchored=1）；省略或 false=仅沉淀（anchored=0，参与 ref_count 排序但不钉）。
    /// 原生工具 native__anchor_memory 经此传 false，手动 UI 锚定按钮传 true。
    #[serde(default)]
    pub anchored: Option<bool>,
}

/// 锚定（新建/更新）一条记忆：同一 (agent_id, key) 已存在则更新内容，否则插入新记忆。
/// anchored 默认 true（手动「锚定」动作语义为钉住）；原生自动沉淀工具显式传 false 仅做沉淀。
#[tauri::command]
pub async fn anchor_memory(app: AppHandle, input: AnchorMemoryInput) -> Result<MemoryItem, String> {
    memory::anchor_memory(
        &app,
        input.agent_id.as_deref(),
        input.session_id.as_deref(),
        &input.key,
        &input.content,
        input.category.as_deref().unwrap_or("other"),
        input.anchored.unwrap_or(true),
        // 手动 UI 锚定不走质量护栏（用户明确意图，宽松处理）。
        false,
    )
    .await
}

/// M3 蒸馏候选：列出全部 pending（记忆宫殿「待确认」区）。
#[tauri::command]
pub async fn list_memory_candidates(
    app: AppHandle,
) -> Result<Vec<memory::MemoryCandidate>, String> {
    memory::list_memory_candidates(&app).await
}

/// M3 蒸馏候选：采纳（anchor_memory auto_merge 转入正表 + 向量回写）。
#[tauri::command]
pub async fn confirm_memory_candidate(
    app: AppHandle,
    id: String,
) -> Result<MemoryItem, String> {
    memory::confirm_memory_candidate(&app, &id).await
}

/// M3 蒸馏候选：忽略（标 rejected，不再出现）。
#[tauri::command]
pub async fn reject_memory_candidate(app: AppHandle, id: String) -> Result<(), String> {
    memory::reject_memory_candidate(&app, &id).await
}

/// 更新记忆入参（update_memory 命令）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryInput {
    pub id: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

/// 更新一条记忆的部分字段（仅更新提供的非空字段）。
#[tauri::command]
pub async fn update_memory(app: AppHandle, input: UpdateMemoryInput) -> Result<MemoryItem, String> {
    memory::update_memory(
        &app,
        &input.id,
        input.key.as_deref(),
        input.content.as_deref(),
        input.category.as_deref(),
    )
    .await
}

/// 删除一条记忆（级联清理其事件日志）。
#[tauri::command]
pub async fn delete_memory(app: AppHandle, id: String) -> Result<(), String> {
    memory::delete_memory(&app, &id).await
}

/// 显式召回一条记忆（引用计数 +1，触发 memory_recalled 事件），用于前端「引用一次」手动埋点。
#[tauri::command]
pub async fn recall_memory(app: AppHandle, id: String) -> Result<MemoryItem, String> {
    memory::recall_memory(&app, &id).await
}

/// 取路径末段文件名（用于错误载荷的 name 字段）。
fn file_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未知文件")
        .to_string()
}

/// 由扩展名推导 MIME 类型（项目未引入 mime 库，手写覆盖常用类型）。
fn guess_mime(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "txt" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "py" | "rs" | "js" | "ts" | "tsx" | "jsx" | "go" | "java" | "c" | "cpp" | "h" => "text/plain",
        "xlsx" | "xls" => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        "docx" | "doc" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 从 SQLite 读取智能体配置（agent_info + 关联表），组装运行配置。
///
/// 表结构与前端 `agent-mapper` 一致（int8→TEXT、bool→INTEGER、jsonb→TEXT）。
///
/// 注：tauri-plugin-sql 2.x 的 `DbPool::select` 为 `pub(crate)`，外部 crate 不可直接调用，
/// 因此这里经插件托管的 `DbInstances` 取出 `sqlite::Pool`，改用 sqlx 直查。
pub async fn load_config(
    app: &AppHandle,
    agent_id: &str,
    workspace: Option<String>,
    session_id: Option<String>,
    round_id: Option<String>,
    disabled_skill_ids: Option<Vec<String>>,
    disabled_mcp_ids: Option<Vec<String>>,
    disabled_mcp_tool_ids: Option<Vec<String>>,
    enabled_skill_ids: Option<Vec<String>>,
    enabled_mcp_ids: Option<Vec<String>>,
    disabled_plugin_ids: Option<Vec<String>>,
    enabled_plugin_ids: Option<Vec<String>>,
    attachments: Option<Vec<crate::agent::types::AttachmentInput>>,
    // 本轮用户 prompt（M1 语义召回）：Some 时记忆召回先走向量检索、失败自动落关键词链；
    // None（分支规划/squad 装配等内部调用或无 session 场景）保持 ref_count 序，行为不变。
    prompt: Option<String>,
) -> Result<AgentRuntimeConfig, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db），请先在前端 load".to_string())?;
    let pool = match db_pool {
        // 本 crate 仅启用 sqlite 特性，DbPool 仅有 Sqlite 变体
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);
    tracing::info!("[agent] load_config: 数据库连接已就绪 (sqlite:workduo.db)");

    let row = sqlx::query("SELECT * FROM agent_info WHERE id = ?")
        .bind(agent_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询智能体失败：{e}"))?
        .ok_or_else(|| format!("智能体不存在：{agent_id}"))?;
    tracing::info!("[agent] load_config: 已找到智能体 {agent_id}");

    let get_str = |row: &sqlx::sqlite::SqliteRow, col: &str| -> String {
        row.try_get::<Option<String>, _>(col)
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    let get_i64 = |row: &sqlx::sqlite::SqliteRow, col: &str| -> i64 {
        row.try_get::<Option<i64>, _>(col)
            .ok()
            .flatten()
            .unwrap_or(0)
    };

    let llm_id = get_str(&row, "llm_id");
    let (llm_base_url, llm_api_key, llm_model_name, llm_config) = if llm_id.is_empty() {
        (String::new(), String::new(), String::new(), serde_json::Value::Null)
    } else {
        match sqlx::query("SELECT base_url, api_key, model_name, config FROM models WHERE id = ?")
            .bind(&llm_id)
            .fetch_optional(&pool)
            .await
        {
            Ok(Some(m)) => {
                let base = get_str(&m, "base_url");
                let key = get_str(&m, "api_key");
                let name = get_str(&m, "model_name");
                let cfg = get_str(&m, "config");
                let cfg_val = serde_json::from_str::<serde_json::Value>(&cfg)
                    .unwrap_or(serde_json::Value::Null);
                (base, key, name, cfg_val)
            }
            _ => (String::new(), String::new(), String::new(), serde_json::Value::Null),
        }
    };

    let mcp_rows = sqlx::query(
        "SELECT m.id AS tool_def_id, m.mcp_id AS mcp_id, m.tool_code AS tool_code, m.description AS description, \
                i.endpoint_url AS endpoint_url, i.protocol_type AS protocol_type, \
                i.headers AS headers, i.auth_type AS auth_type, i.auth_config AS auth_config \
         FROM mcp_tool_definition m \
         JOIN agent_mcp_ref r ON r.tool_id = m.id \
         JOIN mcp_info i ON i.id = m.mcp_id \
         WHERE r.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询 MCP 工具失败：{e}"))?;
    // 临时禁用：前端按会话内移除的 MCP 服务 / 单个工具 id（均不写库），Rust 侧从工具集剔除。
    let disabled_mcp: std::collections::HashSet<String> =
        disabled_mcp_ids.unwrap_or_default().into_iter().collect();
    let disabled_mcp_tool: std::collections::HashSet<String> =
        disabled_mcp_tool_ids.unwrap_or_default().into_iter().collect();
    let mut mcp_tools: Vec<MountedMcpTool> = mcp_rows
        .iter()
        .filter_map(|r| {
            let tool_def_id = r.try_get::<Option<String>, _>("tool_def_id").ok().flatten()?;
            let mcp_id = r.try_get::<Option<String>, _>("mcp_id").ok().flatten()?;
            // 整服务被临时移除，或单个工具被临时关闭 → 跳过
            if disabled_mcp.contains(&mcp_id) || disabled_mcp_tool.contains(&tool_def_id) {
                return None;
            }
            let tool_code = r.try_get::<Option<String>, _>("tool_code").ok().flatten()?;
            let description = r
                .try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
                .unwrap_or_default();
            // 真实连接信息（来自 mcp_info），运行时透传给 call_mcp_tool。
            let endpoint_url = r
                .try_get::<Option<String>, _>("endpoint_url")
                .ok()
                .flatten()
                .unwrap_or_default();
            let protocol_type = r
                .try_get::<Option<String>, _>("protocol_type")
                .ok()
                .flatten()
                .unwrap_or_else(|| "HTTP".to_string());
            let headers = r
                .try_get::<Option<String>, _>("headers")
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok());
            let auth_type = r.try_get::<Option<String>, _>("auth_type").ok().flatten();
            let auth_config = r
                .try_get::<Option<String>, _>("auth_config")
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            Some(MountedMcpTool {
                mcp_id,
                tool_name: tool_code,
                description,
                endpoint_url,
                protocol_type,
                headers,
                auth_type,
                auth_config,
            })
        })
        .collect();

    // 临时启用（`@` 提及触发）：把「智能体未绑定」的 MCP 服务整体并入工具集。
    // 受 MAX_MCP_SERVERS 兜底；已绑定（mcp_tools 已含）或本轮回禁用的服务/工具跳过。
    if let Some(enabled_mcp) = &enabled_mcp_ids {
        let en_set: std::collections::HashSet<String> = enabled_mcp.iter().cloned().collect();
        if !en_set.is_empty() {
            let ph = en_set.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let q = format!(
                "SELECT m.id AS tool_def_id, m.mcp_id AS mcp_id, m.tool_code AS tool_code, m.description AS description, \
                        i.endpoint_url AS endpoint_url, i.protocol_type AS protocol_type, \
                        i.headers AS headers, i.auth_type AS auth_type, i.auth_config AS auth_config \
                 FROM mcp_tool_definition m JOIN mcp_info i ON i.id = m.mcp_id \
                 WHERE m.mcp_id IN ({})",
                ph
            );
            let mut qb = sqlx::query(&q);
            for id in &en_set {
                qb = qb.bind(id);
            }
            if let Ok(rows) = qb.fetch_all(&pool).await {
                let mut servers: std::collections::HashSet<String> =
                    mcp_tools.iter().map(|t| t.mcp_id.clone()).collect();
                for r in rows {
                    let tool_def_id = r.try_get::<Option<String>, _>("tool_def_id").ok().flatten();
                    let mcp_id = r.try_get::<Option<String>, _>("mcp_id").ok().flatten();
                    let (Some(tool_def_id), Some(mcp_id)) = (tool_def_id, mcp_id) else {
                        continue;
                    };
                    // 整服务被临时移除、单个工具被临时关闭、或该工具已由绑定服务纳入 → 跳过
                    if disabled_mcp.contains(&mcp_id) || disabled_mcp_tool.contains(&tool_def_id) {
                        continue;
                    }
                    if mcp_tools.iter().any(|t| t.mcp_id == mcp_id && t.tool_name == tool_def_id) {
                        continue;
                    }
                    if !servers.contains(&mcp_id) {
                        if servers.len() >= MAX_MCP_SERVERS {
                            continue; // 已达 MCP 服务上限，不再并入新服务
                        }
                        servers.insert(mcp_id.clone());
                    }
                    let tool_code = r.try_get::<Option<String>, _>("tool_code").ok().flatten().unwrap_or_default();
                    if tool_code.is_empty() {
                        continue;
                    }
                    let description = r.try_get::<Option<String>, _>("description").ok().flatten().unwrap_or_default();
                    let endpoint_url = r.try_get::<Option<String>, _>("endpoint_url").ok().flatten().unwrap_or_default();
                    let protocol_type = r.try_get::<Option<String>, _>("protocol_type").ok().flatten().unwrap_or_else(|| "HTTP".to_string());
                    let headers = r.try_get::<Option<String>, _>("headers").ok().flatten().and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok());
                    let auth_type = r.try_get::<Option<String>, _>("auth_type").ok().flatten();
                    let auth_config = r.try_get::<Option<String>, _>("auth_config").ok().flatten().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                    mcp_tools.push(MountedMcpTool {
                        mcp_id,
                        tool_name: tool_code,
                        description,
                        endpoint_url,
                        protocol_type,
                        headers,
                        auth_type,
                        auth_config,
                    });
                }
            }
        }
    }

    let skill_rows = sqlx::query(
        "SELECT s.id AS skill_id, s.name AS name, s.description AS description, s.instruction AS instruction, \
                s.skill_markdown AS skill_markdown, s.path AS skill_path \
         FROM skill_info s JOIN agent_skill_ref r ON r.skill_id = s.id \
         WHERE r.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询技能失败：{e}"))?;
    // 临时禁用：前端按会话内移除的技能 id（不写库），Rust 侧从工具集剔除。
    let disabled: std::collections::HashSet<String> = disabled_skill_ids
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut skill_tools: Vec<SkillToolWrapper> = skill_rows
        .iter()
        .filter(|r| {
            let skill_id = r
                .try_get::<Option<String>, _>("skill_id")
                .ok()
                .flatten()
                .unwrap_or_default();
            !disabled.contains(&skill_id)
        })
        .map(|r| {
            let skill_id = r
                .try_get::<Option<String>, _>("skill_id")
                .ok()
                .flatten()
                .unwrap_or_default();
            let name = r
                .try_get::<Option<String>, _>("name")
                .ok()
                .flatten()
                .unwrap_or_default();
            let desc = r
                .try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
                .unwrap_or_default();
            let instruction = r
                .try_get::<Option<String>, _>("instruction")
                .ok()
                .flatten()
                .unwrap_or_default();
            let skill_markdown = r
                .try_get::<Option<String>, _>("skill_markdown")
                .ok()
                .flatten()
                .unwrap_or_default();
            let skill_path = r
                .try_get::<Option<String>, _>("skill_path")
                .ok()
                .flatten()
                .unwrap_or_default();
            SkillToolWrapper {
                skill_id: skill_id.clone(),
                skill_name: if name.is_empty() { skill_id } else { name },
                skill_description: if desc.is_empty() { instruction } else { desc },
                skill_markdown,
                skill_path,
            }
        })
        .collect();

    // 临时启用（`@` 提及触发）：把「智能体未绑定」的技能临时并入工具集。
    // enabled 优先于 disabled（本轮显式 @ 启用即覆盖临时移除）；受 MAX_SKILLS 兜底。
    if let Some(enabled_skill) = &enabled_skill_ids {
        let en_set: std::collections::HashSet<String> = enabled_skill.iter().cloned().collect();
        if !en_set.is_empty() {
            let ph = en_set.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let q = format!(
                "SELECT id, name, description, instruction, skill_markdown, path FROM skill_info WHERE id IN ({})",
                ph
            );
            let mut qb = sqlx::query(&q);
            for id in &en_set {
                qb = qb.bind(id);
            }
            if let Ok(rows) = qb.fetch_all(&pool).await {
                for r in rows {
                    let sid = r.try_get::<Option<String>, _>("id").ok().flatten().unwrap_or_default();
                    if sid.is_empty() {
                        continue;
                    }
                    // 已绑定（skill_tools 已含）的技能跳过；enabled 覆盖 disabled，故不判 disabled
                    if skill_tools.iter().any(|s| s.skill_id == sid) {
                        continue;
                    }
                    if skill_tools.len() >= MAX_SKILLS {
                        break; // 已达技能上限，不再并入
                    }
                    let name = r.try_get::<Option<String>, _>("name").ok().flatten().unwrap_or_default();
                    let desc = r.try_get::<Option<String>, _>("description").ok().flatten().unwrap_or_default();
                    let instruction = r.try_get::<Option<String>, _>("instruction").ok().flatten().unwrap_or_default();
                    let skill_markdown = r.try_get::<Option<String>, _>("skill_markdown").ok().flatten().unwrap_or_default();
                    let skill_path = r.try_get::<Option<String>, _>("path").ok().flatten().unwrap_or_default();
                    skill_tools.push(SkillToolWrapper {
                        skill_id: sid.clone(),
                        skill_name: if name.is_empty() { sid } else { name },
                        skill_description: if desc.is_empty() { instruction } else { desc },
                        skill_markdown,
                        skill_path,
                    });
                }
            }
        }
    }

    // 沙箱开关：同一个真值源同时决定「能力层注册哪些工具」与「提示层声明哪些能力」。
    // 二者必须同源——否则提示里写「不暴露 execute_command」而工具表里照样注册，
    // 模型以工具表为准，试探后必然绕过沙箱（实测会去找系统 python 甚至 winget 安装）。
    let allow_sandbox = get_i64(&row, "allow_sandbox") == 1;
    // 记忆模式：off=关闭 / active=主动 / forced=强制。存量智能体列缺省回落 off（兼容老数据）。
    let memory_mode = {
        let m = get_str(&row, "memory_mode");
        if m.is_empty() {
            "off".to_string()
        } else {
            m
        }
    };
    let plan_auto_approve_mode = {
        let m = get_str(&row, "plan_auto_approve_mode");
        if m.is_empty() {
            "always".to_string()
        } else {
            m
        }
    };

    // ===== 本地插件装配（P2 纯增量，无插件绑定时 plugin_tools 为空、行为不变） =====
    // 过滤条件（设计稿 §6.3）：ref.is_active=1 AND tool.enabled=1 AND agent.allow_sandbox=1；
    // disabled_plugin_ids 仅会话内临时剔除（对齐 disabled_skill_ids 语义），不写库。
    let mut plugin_tools: Vec<MountedUserPlugin> = Vec::new();
    if allow_sandbox {
        let plugin_rows = sqlx::query(
            "SELECT p.id AS plugin_id, p.identifier AS identifier, p.name AS name, \
                    p.description AS description, p.runtime AS runtime, \
                    p.script_content AS script_content, p.parameters_schema AS parameters_schema, \
                    p.timeout_sec AS timeout_sec \
             FROM user_plugin_tool p JOIN agent_plugin_ref r ON r.plugin_id = p.id \
             WHERE r.agent_id = ? AND r.is_active = 1 AND p.enabled = 1",
        )
        .bind(agent_id)
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
        let disabled_plugins: std::collections::HashSet<String> = disabled_plugin_ids
            .unwrap_or_default()
            .into_iter()
            .collect();
        for r in &plugin_rows {
            let plugin_id = r
                .try_get::<Option<String>, _>("plugin_id")
                .ok()
                .flatten()
                .unwrap_or_default();
            let identifier = r
                .try_get::<Option<String>, _>("identifier")
                .ok()
                .flatten()
                .unwrap_or_default();
            if plugin_id.is_empty() || identifier.is_empty() {
                continue;
            }
            // 会话内临时禁用：插件 id 或工具标识符命中均可
            if disabled_plugins.contains(&plugin_id) || disabled_plugins.contains(&identifier) {
                continue;
            }
            let runtime = r
                .try_get::<Option<String>, _>("runtime")
                .ok()
                .flatten()
                .unwrap_or_default();
            if runtime != "python" && runtime != "bun" {
                continue; // 未知运行时兜底跳过（adapter 处还有一层防御）
            }
            let script_content = r
                .try_get::<Option<String>, _>("script_content")
                .ok()
                .flatten()
                .unwrap_or_default();
            if script_content.trim().is_empty() {
                continue; // 无脚本内容的插件无法执行
            }
            let schema_raw = r
                .try_get::<Option<String>, _>("parameters_schema")
                .ok()
                .flatten()
                .unwrap_or_default();
            let parameters_schema = serde_json::from_str::<serde_json::Value>(&schema_raw)
                .unwrap_or_else(|_| serde_json::json!({"type": "object", "properties": {}}));
            let timeout_sec = r
                .try_get::<Option<i64>, _>("timeout_sec")
                .ok()
                .flatten()
                .unwrap_or(60)
                .clamp(1, 300) as u64;
            let name = r
                .try_get::<Option<String>, _>("name")
                .ok()
                .flatten()
                .unwrap_or_else(|| identifier.clone());
            let description = r
                .try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
                .unwrap_or_default();
            plugin_tools.push(MountedUserPlugin {
                plugin_id,
                identifier,
                name,
                description,
                runtime,
                script_content,
                parameters_schema,
                timeout_sec,
            });
        }

        // `@` 提及临时并入（P2 纯增量，语义对齐 enabled_skill_ids）：把「智能体未绑定」
        // 的插件临时并入工具集；allow_sandbox 前置条件同样适用；受 10 个上限兜底
        // （与前端 draft.MAX_PLUGINS 一致）。
        if let Some(enabled_plugin) = &enabled_plugin_ids {
            let en_set: std::collections::HashSet<String> =
                enabled_plugin.iter().cloned().collect();
            if !en_set.is_empty() {
                let bound_ids: std::collections::HashSet<String> = plugin_tools
                    .iter()
                    .map(|p| p.plugin_id.clone())
                    .collect();
                let pending: Vec<String> = en_set
                    .iter()
                    .filter(|id| !bound_ids.contains(*id))
                    .cloned()
                    .collect();
                if !pending.is_empty() {
                    let ph = pending.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let q = format!(
                        "SELECT id, identifier, name, description, runtime, script_content, \
                         parameters_schema, timeout_sec FROM user_plugin_tool WHERE id IN ({ph})"
                    );
                    let mut qb = sqlx::query(&q);
                    for id in &pending {
                        qb = qb.bind(id);
                    }
                    if let Ok(rows) = qb.fetch_all(&pool).await {
                        for r in &rows {
                            if plugin_tools.len() >= 10 {
                                break; // MAX_PLUGINS 兜底（与前端 draft.MAX_PLUGINS 一致）
                            }
                            let plugin_id = r
                                .try_get::<Option<String>, _>("id")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            let identifier = r
                                .try_get::<Option<String>, _>("identifier")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            if plugin_id.is_empty() || identifier.is_empty() {
                                continue;
                            }
                            if plugin_tools.iter().any(|p| p.plugin_id == plugin_id) {
                                continue; // 已绑定，去重
                            }
                            let runtime = r
                                .try_get::<Option<String>, _>("runtime")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            if runtime != "python" && runtime != "bun" {
                                continue;
                            }
                            let script_content = r
                                .try_get::<Option<String>, _>("script_content")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            if script_content.trim().is_empty() {
                                continue;
                            }
                            let schema_raw = r
                                .try_get::<Option<String>, _>("parameters_schema")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            let parameters_schema =
                                serde_json::from_str::<serde_json::Value>(&schema_raw)
                                    .unwrap_or_else(|_| {
                                        serde_json::json!({"type": "object", "properties": {}})
                                    });
                            let timeout_sec = r
                                .try_get::<Option<i64>, _>("timeout_sec")
                                .ok()
                                .flatten()
                                .unwrap_or(60)
                                .clamp(1, 300) as u64;
                            let name = r
                                .try_get::<Option<String>, _>("name")
                                .ok()
                                .flatten()
                                .unwrap_or_else(|| identifier.clone());
                            let description = r
                                .try_get::<Option<String>, _>("description")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            plugin_tools.push(MountedUserPlugin {
                                plugin_id,
                                identifier,
                                name,
                                description,
                                runtime,
                                script_content,
                                parameters_schema,
                                timeout_sec,
                            });
                        }
                    }
                }
            }
        }
    } else {
        // 沙箱未开启：设计稿 §5.1「Agent 必须 allow_sandbox=1 才注册插件工具」——
        // 保持 plugin_tools 为空（向导保存时已有前端强提示，此处运行时兜底不加载）。
        let _ = disabled_plugin_ids;
    }

    tracing::info!(
        "[agent] load_config 完成: llm_id={} model={} mcp_tools={} skill_tools={} plugins={} auto_exec={} sandbox={} system_prompt={}字符 附件数={}",
        if llm_id.is_empty() { "<无>" } else { llm_id.as_str() },
        if llm_model_name.is_empty() { "<无>" } else { llm_model_name.as_str() },
        mcp_tools.len(),
        skill_tools.len(),
        plugin_tools.len(),
        get_i64(&row, "auto_tool_exec_mode") == 1,
        allow_sandbox,
        get_str(&row, "system_prompt").chars().count(),
        attachments.as_ref().map(|a| a.len()).unwrap_or(0),
    );

    let mut system_prompt = get_str(&row, "system_prompt");
    // 把真实工作空间路径注入系统提示：避免 LLM 猜测 `/workspace` 等虚拟路径，
    // 导致原生工具（写文件 / 跑 Python / 列目录）路径越界。
    if let Some(ws) = &workspace {
        if !ws.trim().is_empty() {
            let ws_trim = ws.trim();
            system_prompt.push_str(&format!(
                "\n\n### 工作环境\n你当前的工作空间目录为：{}\n所有文件读写、Python 脚本执行、命令执行都必须在此目录或其子目录内进行。请使用相对于该目录的路径（如 `script.py`）或该目录下的绝对路径来指定文件位置，不要使用 `/workspace` 等虚拟路径。",
                ws_trim
            ));
            // 执行环境提示必须与「能力层实际注册的工具」保持一致（同源）：
            // - 沙箱开启：execute_command 未注册，只能走 native__run_python_sandbox；
            //   此时若仍教模型 cmd/sh 语法，等于诱导它去调一个根本不存在的工具，
            //   模型转而自寻出路（实测：找系统 python、winget 安装 Python）脱离沙箱。
            // - 沙箱关闭：才注入宿主 shell 的语法约定。
            if allow_sandbox {
                system_prompt.push_str(
                    "\n\n### 执行环境（沙箱模式）\n本任务运行在**隔离沙箱**中，宿主 shell 命令工具（execute_command）未对你开放。\
\n运行任何 Python 代码的唯一正确方式：\
\n1. 先用 `native__write_file` 把 .py 脚本写入工作空间（建议放 `.wd_mem/scripts/`，便于复用）；\
\n2. 再调用 `native__run_python_sandbox` 并传入该脚本的绝对路径执行（默认环境 `default`）。\
\n运行任何 JavaScript / TypeScript 代码（如前端脚本、轻量数据处理、API 调用），用 `native__run_node_sandbox` 传入代码或脚本绝对路径即可（默认环境 `default`）。\
\n**严禁**：\
\n- 不要尝试调用系统 `python` / `python3` / `node` / `bun`，不要用 `where python`、`python --version`、`node -v` 探测本机运行时；\
\n- 绝对禁止用 winget / choco / brew / apt 安装系统级 Python / Node 或任何系统软件——这会脱离沙箱并污染用户本机环境；\
\n- 沙箱缺少第三方库（Python 的 pandas / Node 的 axios 等）时先 import / require 确认，确实缺失则如实告知用户，切勿自行安装系统级包。",
                );
            } else if cfg!(target_os = "windows") {
                system_prompt.push_str(
                    "\n\n### 命令执行环境\n本机为 Windows，命令经 `cmd.exe /C` 执行（**不是** bash/PowerShell）。\
请勿使用 `tail`/`cat`/`grep`/`head`/`wc` 等 Unix 专用命令，也不要依赖 `|` 管道做文本截取；\
需要文本处理请用纯 Python 脚本或 PowerShell 语法。安装 Python 依赖用 `pip install <包名>`，不要带 `| tail` 之类后缀。",
                );
            } else {
                system_prompt.push_str(
                    "\n\n### 命令执行环境\n本机为类 Unix 系统，命令经 `sh -c` 执行，可使用标准 Unix 管道与命令。",
                );
            }
            // .wd_mem 记忆与素材区：确保结构就绪，并注入复用清单与约定。
            match crate::agent::wd_mem::ensure_wd_mem(ws_trim) {
                Ok(_) => {
                    system_prompt.push_str(&format!(
                        "\n\n### 工作空间记忆区 `.wd_mem/`（已就绪，位于 {}/.wd_mem）\n\
这是本工作空间的专属记忆与素材库，由你在上次运行中沉淀，本次应优先复用其中的素材、避免重复生成：\n\
- `scripts/`：可复用的自动化脚本（Python/Shell 等）——**再跑同类任务前，先检查这里是否已有可用脚本，有则直接复用或小幅改写，不要从零重写**。\n\
- `data/`：抓取/计算的中间数据（CSV/JSON 等）——已有则优先读取复用，避免重复联网获取。\n\
                    - `outputs/`：最终产物的归档副本（可选）。\n\
- `MEMORY.md`：项目长期全局记忆（架构/避坑/用户偏好），全量注入系统提示，你可直接读取/编辑。\n\
- `artifacts/`：你完成复杂任务后主动沉淀的设计蓝图（用 `native__archive_artifact` 写入）。\n\
约定：**新生成的、值得保留的脚本请写入 `scripts/`；中间数据写入 `data/`；不要把临时/一次性脚本散落在工作空间根目录**，以免污染用户目录。**最终交付物**仍放在工作空间根目录或用户指定位置。",
                        ws_trim
                    ));
                    // [双轨记忆 Slot 0] 树状索引（artifacts/sessions/scripts/data，仅首行标题，绝不读正文）+ 自主发现指令。
                    if let Some(index) = crate::agent::wd_mem::build_tree_index(ws_trim) {
                        system_prompt.push_str(&format!(
                            "\n\n{}\n\n> The `artifacts/`, `sessions/` and `scripts/` directories under `.wd_mem/` contain historical designs and bug-fixing records. You MUST use the `native__read_file` tool to inspect specific files before proceeding if the user's request relates to these modules.",
                            index
                        ));
                    }
                    // [双轨记忆 Slot 0] 长期全局记忆 MEMORY.md（规范命名；兼容旧 project_memory.md 回退）。
                    if let Some(mem) = crate::agent::wd_mem::read_project_memory(ws_trim) {
                        if !mem.trim().is_empty() {
                            system_prompt.push_str(&format!(
                                "\n\n### 项目长期记忆（.wd_mem/MEMORY.md）\n{}",
                                mem
                            ));
                        }
                    }
                    // [固化闭环] 长期记忆主动沉淀指令：完成实质性任务后主动归档 artifacts/。
                    system_prompt.push_str("\n\n### 长期记忆固化闭环（Long-term Memory Consolidation）\n\
完成一个实质性的功能模块开发或深度 Bug 修复后，若本次任务沉淀了值得长期复用的「设计蓝图 / 架构约定 / 避坑法则」，请主动调用 `native__archive_artifact` 将其写入 `.wd_mem/artifacts/`（文件名用 kebab-case，如 `auth-flow.md`）。\
若你不确定是否值得归档，请直接向用户提问：「本次任务涉及的核心设计是否需要提炼并归档至 `.wd_mem/artifacts/` 作为永久知识资产？」——得到确认后再写入。日常闲聊或微小改动无需归档。");
                    tracing::info!("[agent] load_config: 已确保 .wd_mem 结构并注入复用清单 workspace={}", ws_trim);
                }
                Err(e) => {
                    tracing::info!("[agent] load_config: 创建 .wd_mem 失败（降级为不使用记忆区）：{e}");
                }
            }
        }
    }

    // 本地插件使用规则（P2 纯增量）：仅在确有插件挂载时追加，无插件时系统提示不变。
    if !plugin_tools.is_empty() {
        let plugin_list = plugin_tools
            .iter()
            .map(|p| format!("- `custom__{}`：{}", p.identifier, p.description))
            .collect::<Vec<_>>()
            .join("\n");
        system_prompt.push_str(&format!(
            "\n\n### 本地插件工具（custom__ 前缀）\n已为你可以调用以下本地插件工具：\n{plugin_list}\n\
调用规则：\n\
1. 仅当任务与插件描述匹配时调用，传参必须严格符合该工具的 JSON Schema；\n\
2. 禁止伪造不存在的 custom__ 工具名，禁止猜测未列出的插件；\n\
3. 插件在你的沙箱内执行，缺依赖会自动安装并重试一次；调用即视为执行用户本机代码，结果以工具返回为准。"
        ));
    }

    // 记忆宫殿：自动召回 top-K 记忆注入系统提示（引用计数随运行累计，驱动热力图）。
    // 仅在真实任务运行（有 session_id）且记忆模式非 off 时召回；off 模式不读记忆库。
    // M1：传本轮 prompt——嵌入已配置时先走向量语义召回，失败/未配置自动落关键词降级链。
    if session_id.is_some() && memory_mode != "off" {
        let (recalled, block) =
            memory::recall_top_memories(app, Some(agent_id), memory::recall_top(), prompt.as_deref())
                .await;
        if !block.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&block);
            tracing::info!(
                "[agent] load_config: 已自动召回 {} 条记忆注入系统提示",
                recalled.len()
            );
        }

        // 主动 / 强制模式：在 system_prompt 注入「记忆沉淀引导」，提示模型用原生工具 native__anchor_memory
        // 沉淀可跨会话复用的信息。off 模式不注入（且 anchor 工具未注册），记忆能力整体关闭。
        // 注意：这只是提示层引导，强制档的确定性沉淀由 pipeline 末置步骤引擎级落地（见 runtime.rs）。
        if memory_mode == "active" || memory_mode == "forced" {
            system_prompt.push_str(
                "\n\n### 长期记忆锚定（原生工具 native__anchor_memory）\n\
你拥有原生工具 `native__anchor_memory(key, content, category)`。当本次对话涌现**可跨会话复用**的稳定信息时，主动调用它沉淀为长期记忆，使未来同智能体会话能自动召回：\n\
① 用户明确表达的偏好或约束；② 已确认的技术决策 / 架构约定；③ 踩过的坑与规避方式；④ 可复用代码 / 脚本模式。\n\
请勿锚定：一次性任务步骤、临时草稿、当轮琐碎状态。记忆按 (agent_id, key) 去重，可放心重复沉淀。\n\
category 取值：decision（决策）/ code_pattern（代码模式）/ user_pref（用户偏好）/ architecture（架构）/ fix（避坑）/ other（其他）。",
            );
        }
    }

    // L2 项目知识片段注入（#20260918006）：按本轮 prompt 向量检索 .wd_mem/artifacts
    // 分节片段 top-k（隔离键 = 工作空间路径，同工程多 agent 共享）。与「文件名清单 +
    // MEMORY.md 全量注入」既有通道叠加；嵌入未配置 / 无命中 / 检索失败 = 静默跳过，
    // 绝不阻断任务启动。与记忆宫殿解耦：off 模式仍注入（知识资产 ≠ agent 记忆）。
    if session_id.is_some() {
        if let Some(ws) = workspace.as_deref() {
            if let Some(pr) = prompt.as_deref() {
                if !pr.trim().is_empty() {
                    match crate::agent::artifact_index::recall_artifact_snippets(
                        app, &pool, ws, pr, crate::agent::artifact_index::RECALL_SNIPPET_TOP_K,
                    )
                    .await
                    {
                        Ok(block) if !block.is_empty() => {
                            system_prompt.push_str("\n\n");
                            system_prompt.push_str(&block);
                            tracing::info!(
                                "[agent] load_config: 已注入 .wd_mem/artifacts 相关知识片段"
                            );
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::info!("[agent] load_config: artifacts 片段检索跳过：{e}")
                        }
                    }
                }
            }
        }
    }

    // HTTP 请求主机白名单（app_config.http_allowed_hosts）：空 = 不限制；非空 = 仅允许命中主机（含子域）。
    let http_allowed_hosts = {
        let row = sqlx::query("SELECT value FROM app_config WHERE key = 'http_allowed_hosts'")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
        match row {
            Some(r) => {
                let raw = r
                    .try_get::<Option<String>, _>("value")
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                parse_host_allowlist(&raw)
            }
            None => Vec::new(),
        }
    };

    // ===== 知识库绑定装配（K2 第四期）：绑定关系驱动 native__kb_search 注册与 planner 大纲 =====
    let kb_ids: Vec<String> = sqlx::query("SELECT kb_id FROM agent_kb_ref WHERE agent_id = ? ORDER BY created_at ASC")
        .bind(agent_id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("查询知识库绑定失败：{e}"))?
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>("kb_id").ok().flatten())
        .collect();

    Ok(AgentRuntimeConfig {
        agent_id: agent_id.to_string(),
        system_prompt,
        llm_base_url,
        llm_api_key,
        llm_model_name,
        llm_config,
        auto_tool_exec_mode: get_i64(&row, "auto_tool_exec_mode") == 1,
        allow_sandbox: get_i64(&row, "allow_sandbox") == 1,
        memory_mode,
        plan_auto_approve_mode,
        workspace,
        mcp_tools,
        skill_tools,
        session_id,
        round_id,
        attachments: attachments.unwrap_or_default(),
        http_allowed_hosts,
        network_proxy: crate::net::load_network_proxy(&pool).await,
        plugin_tools,
        kb_ids,
    })
}

/// 加载一个小分队的完整运行配置：读取 squad 定义 + 成员任职 + 群聊配置，
/// 对每个成员调用 `load_config` 组装 base AgentRuntimeConfig（复用全部现有能力层装配），
/// 再把 `persona_override` 追加到该成员的 `system_prompt` 末尾（人设注入，不污染 base agent 库），
/// 并由 `global_mcp_ids` 强制并入成员的 MCP 工具集。
///
/// 返回的 `SquadRuntimeConfig` 供 Phase 3-5 的协作引擎（orchestrator / pipeline / chat）消费。
/// `workspace` 读取自 agent_squad.workspace_dir（用户自选产物根目录，可空）：
/// 运行期据此派生成员私有 workspace（{workspace}/{agent_id}，有值）或回退默认
/// `.wd_mem/squads/{squad_id}/{agent_id}/`。详见 squad_orchestrator::squad_member_workspace。
pub async fn load_squad(app: &AppHandle, squad_id: &str) -> Result<SquadRuntimeConfig, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db），请先在前端 load".to_string())?;
    let pool = match db_pool {
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);

    let squad = sqlx::query("SELECT * FROM agent_squad WHERE id = ?")
        .bind(squad_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询小分队失败：{e}"))?
        .ok_or_else(|| format!("小分队不存在：{squad_id}"))?;

    let get_str = |row: &sqlx::sqlite::SqliteRow, col: &str| -> String {
        row.try_get::<Option<String>, _>(col).ok().flatten().unwrap_or_default()
    };
    let get_i64 = |row: &sqlx::sqlite::SqliteRow, col: &str| -> i64 {
        row.try_get::<Option<i64>, _>(col).ok().flatten().unwrap_or(0)
    };

    let name = get_str(&squad, "name");
    let mode = get_str(&squad, "mode");
    let leader_agent_id = {
        let l = get_str(&squad, "leader_agent_id");
        if l.is_empty() {
            None
        } else {
            Some(l)
        }
    };
    let global_mcp_ids: Vec<String> =
        serde_json::from_str(&get_str(&squad, "global_mcp_ids")).unwrap_or_default();
    // 全局 MCP 工具级开关：{ [mcpId]: 被禁用工具 id[] }，合并为运行期禁用集合。
    let global_mcp_tools: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(&get_str(&squad, "global_mcp_tools")).unwrap_or_default();
    let disabled_mcp_tool_ids: Vec<String> = global_mcp_tools.values().flatten().cloned().collect();
    let workspace_dir = {
        let w = get_str(&squad, "workspace_dir");
        if w.trim().is_empty() {
            None
        } else {
            Some(w)
        }
    };
    let run_strategy: SquadRunStrategy = serde_json::from_str(&get_str(&squad, "run_strategy"))
        .unwrap_or_else(|_| SquadRunStrategy {
            execution_mode: "manual".to_string(),
            schedule_cron: None,
            retry_count: 3,
            schedule_prompt: None,
        });

    // 成员任职：按 pipeline_order 升序（无序号者排前），保证流水线模式工序顺序稳定。
    let member_rows = sqlx::query(
        "SELECT * FROM agent_squad_member WHERE squad_id = ? ORDER BY \
         CASE WHEN pipeline_order IS NULL THEN 0 ELSE 1 END, pipeline_order ASC, created_at ASC",
    )
    .bind(squad_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询小分队成员失败：{e}"))?;

    let mut members: Vec<SquadMemberConfig> = Vec::new();
    for m in &member_rows {
        let agent_id = get_str(m, "agent_id");
        if agent_id.is_empty() {
            continue;
        }
        // 复用 load_config 组装 base AgentRuntimeConfig（全局 MCP 强制并入成员工具集）。
        let mut base = load_config(
            app,
            &agent_id,
            None, // workspace：运行期派生私有 workspace 后覆盖
            None, // session_id
            None, // round_id
            None, // disabled_skill_ids
            None, // disabled_mcp_ids
            if disabled_mcp_tool_ids.is_empty() {
                None
            } else {
                Some(disabled_mcp_tool_ids.clone())
            }, // disabled_mcp_tool_ids
            None, // enabled_skill_ids
            if global_mcp_ids.is_empty() {
                None
            } else {
                Some(global_mcp_ids.clone())
            },
            None, // disabled_plugin_ids
            None, // enabled_plugin_ids
            None, // attachments
            None, // prompt：squad 装配无 session，记忆召回保持 ref_count 序
        )
        .await?;

        // 人设注入：追加到 system_prompt 末尾（不污染 base agent 库）。
        let persona_override = get_str(m, "persona_override");
        if !persona_override.trim().is_empty() {
            base.system_prompt
                .push_str("\n\n### 你的角色设定（Squad 定制）\n");
            base.system_prompt.push_str(persona_override.trim());
        }

        // 团队黑板记忆召回：注入本小分队共享 + 该成员个人的历史记忆（top-K，按引用热度）。
        let mem_block = load_squad_memory_block(&pool, squad_id, &agent_id).await;
        if !mem_block.is_empty() {
            base.system_prompt.push_str("\n\n");
            base.system_prompt.push_str(&mem_block);
        }

        let role = get_str(m, "role");
        let is_leader = get_i64(m, "is_leader") == 1;
        let pipeline_order = {
            let po = get_i64(m, "pipeline_order");
            if po <= 0 {
                None
            } else {
                Some(po as usize)
            }
        };
        let depends_on: Vec<String> = serde_json::from_str(&get_str(m, "depends_on"))
            .unwrap_or_default();
        members.push(SquadMemberConfig {
            agent: base,
            role,
            persona_override,
            pipeline_order,
            depends_on,
            is_leader,
        });
    }

    if members.is_empty() {
        return Err(format!("小分队 {squad_id} 未配置任何成员智能体"));
    }

    // 群聊配置（可选；缺省 max_rounds=8、无单独汇总主笔）。
    let chat_config =
        match sqlx::query("SELECT * FROM agent_squad_chat_config WHERE squad_id = ?")
            .bind(squad_id)
            .fetch_optional(&pool)
            .await
        {
            Ok(Some(c)) => SquadChatConfig {
                max_rounds: {
                    let n = get_i64(&c, "max_rounds");
                    if n <= 0 {
                        8
                    } else {
                        n as usize
                    }
                },
                summarizer_agent_id: {
                    let s = get_str(&c, "summarizer_agent_id");
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                },
            },
            _ => SquadChatConfig {
                max_rounds: 8,
                summarizer_agent_id: None,
            },
        };

    tracing::info!(
        "[agent] load_squad: 已加载小分队 {} 模式={} 成员数={} 全局MCP={}",
        squad_id,
        mode,
        members.len(),
        global_mcp_ids.len()
    );

    Ok(SquadRuntimeConfig {
        squad_id: squad_id.to_string(),
        name,
        mode,
        leader_agent_id,
        global_mcp_ids,
        run_strategy,
        members,
        chat_config,
        workspace: workspace_dir,
    })
}

/// 召回小分队级共享记忆（agent_squad_memory 中 agent_id IS NULL）与指定成员个人记忆
/// （agent_id = 该成员），拼成系统提示注入块；同时累加 ref_count + 更新 last_recalled
/// （驱动记忆热力图）。无记忆时返回空串（调用方据此跳过注入）。
async fn load_squad_memory_block(
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    agent_id: &str,
) -> String {
    let rows = sqlx::query(
        "SELECT id, key, content, category FROM agent_squad_memory \
         WHERE squad_id = ? AND (agent_id IS NULL OR agent_id = ?) \
         ORDER BY ref_count DESC LIMIT 5",
    )
    .bind(squad_id)
    .bind(agent_id)
    .fetch_all(pool)
    .await;

    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[agent] load_squad_memory_block: 查询失败：{e}");
            return String::new();
        }
    };
    if rows.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for r in &rows {
        let key: String = r.try_get("key").unwrap_or_default();
        let content: String = r.try_get("content").unwrap_or_default();
        let category: String = r.try_get("category").unwrap_or_default();
        let id: String = r.try_get("id").unwrap_or_default();
        lines.push(format!("- [{}] {}: {}", category, key, content));
        ids.push(id);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    for id in &ids {
        let _ = sqlx::query(
            "UPDATE agent_squad_memory SET ref_count = ref_count + 1, last_recalled = ? WHERE id = ?",
        )
        .bind(now)
        .bind(id)
        .execute(pool)
        .await;
    }

    format!(
        "## 团队记忆（Squad 黑板召回）\n以下是本小分队共享及你的个人历史记忆，供你参考：\n{}\n",
        lines.join("\n")
    )
}

/// 小分队协作任务入参：指定小分队与用户任务描述。
#[derive(serde::Deserialize)]
pub struct RunSquadTaskInput {
    pub squad_id: String,
    pub prompt: String,
}

/// 启动一次小分队协作任务（编排式 / 流水线 / 群聊 共用入口）。
///
/// 先 `load_squad` 组装 `SquadRuntimeConfig`（含成员人设注入 + 全局 MCP 并入），
/// 再 spawn 后台任务交给 `squad_orchestrator::run_squad_task` 执行（成员各自独立运行、互不共享文件系统）。
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn run_squad_task(app: AppHandle, input: RunSquadTaskInput) -> Result<(), String> {
    let squad = load_squad(&app, &input.squad_id).await?;
    let app_clone = app.clone();
    let prompt = input.prompt.clone();
    tauri::async_runtime::spawn(async move {
        crate::agent::squad_orchestrator::run_squad_task(&app_clone, squad, prompt).await;
    });
    Ok(())
}

/* ------------------------------------------------------------------ *
 * 小分队 API 触发服务配置（存于 app_config）
 * ------------------------------------------------------------------ */

async fn get_api_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?;
    match db_pool {
        DbPool::Sqlite(p) => Ok(p.clone()),
    }
}

async fn api_read_cfg(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    let row = sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    row.try_get::<Option<String>, _>("value").ok().flatten()
}

async fn api_upsert_cfg(pool: &sqlx::SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| format!("写入配置失败：{e}"))?;
    Ok(())
}

/// 读取小分队 API 触发服务的当前配置（enabled / port / token）。
#[tauri::command]
pub async fn get_squad_api_config(app: AppHandle) -> Result<SquadApiConfigView, String> {
    let pool = get_api_pool(&app).await?;
    let enabled = api_read_cfg(&pool, "squad_api_enabled").await.as_deref() == Some("true");
    let port = api_read_cfg(&pool, "squad_api_port")
        .await
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3939);
    let token = api_read_cfg(&pool, "squad_api_token").await.unwrap_or_default();
    Ok(SquadApiConfigView {
        enabled,
        port,
        token,
    })
}

/// 更新小分队 API 触发服务的配置（仅传入的字段生效）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadApiConfigInput {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub token: Option<String>,
}

#[tauri::command]
pub async fn set_squad_api_config(
    app: AppHandle,
    input: SquadApiConfigInput,
) -> Result<SquadApiConfigView, String> {
    let pool = get_api_pool(&app).await?;
    if let Some(e) = input.enabled {
        api_upsert_cfg(&pool, "squad_api_enabled", if e { "true" } else { "false" }).await?;
    }
    if let Some(p) = input.port {
        api_upsert_cfg(&pool, "squad_api_port", &p.to_string()).await?;
    }
    if let Some(t) = input.token {
        api_upsert_cfg(&pool, "squad_api_token", &t).await?;
    }
    get_squad_api_config(app).await
}

/// 小分队 API 触发服务配置视图。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadApiConfigView {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// 小分队记忆锚定入参（camelCase 自动反序列化）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorSquadMemoryInput {
    pub squad_id: String,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub key: String,
    pub content: String,
    pub category: Option<String>,
}

/// 锚定一条小分队记忆（团队黑板写入路径）。命中同 squad_id+agent_id+key 则强化计数，否则新建。
/// 详见 `memory::anchor_squad_memory`。
#[tauri::command]
pub async fn anchor_squad_memory(app: AppHandle, input: AnchorSquadMemoryInput) -> Result<crate::agent::memory::SquadMemoryItem, String> {
    crate::agent::memory::anchor_squad_memory(
        &app,
        &input.squad_id,
        input.agent_id.as_deref(),
        input.session_id.as_deref(),
        &input.key,
        &input.content,
        input.category.as_deref().unwrap_or("general"),
        true,
    )
    .await
}

/// 列出某小分队的全部记忆（团队共享 + 成员个人）。
#[tauri::command]
pub async fn list_squad_memories(
    app: AppHandle,
    squad_id: String,
) -> Result<Vec<crate::agent::memory::SquadMemoryItem>, String> {
    crate::agent::memory::list_squad_memories(&app, &squad_id).await
}

/// 删除一条小分队记忆。
#[tauri::command]
pub async fn delete_squad_memory(app: AppHandle, id: String) -> Result<(), String> {
    crate::agent::memory::delete_squad_memory(&app, &id).await
}
// ============================ 知识库 RAG 索引（K1 第四期，设计稿 docs/knowledge-rag-design.md） ============================

/// 前端入参：单资产索引命令（sync / remove 共用）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbAssetInput {
    pub kb_id: String,
    pub asset_id: String,
}

/// 单资产增量同步：前端 kbFs 写入点 fire-and-forget 调用；digest 未变幂等跳过。
#[tauri::command]
pub async fn kb_sync_asset(app: AppHandle, input: KbAssetInput) -> Result<knowledge::KbSyncReport, String> {
    knowledge::sync_asset_index(&app, &input.kb_id, &input.asset_id, false).await
}

/// 级联清理资产向量段（删除资产/文件后调用；幂等）。
#[tauri::command]
pub async fn kb_remove_asset(app: AppHandle, input: KbAssetInput) -> Result<(), String> {
    knowledge::remove_asset_index(&app, &input.kb_id, &input.asset_id).await
}

/// 前端入参：全量重建。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbRebuildInput {
    pub kb_id: String,
}

/// 全量重建（详情页按钮）：spawn 异步 + agent-kb-index-progress 进度事件；重入保护。
#[tauri::command]
pub async fn kb_rebuild_index(app: AppHandle, input: KbRebuildInput) -> Result<knowledge::KbRebuildAccepted, String> {
    knowledge::spawn_rebuild_kb_index(app, input.kb_id).await
}
