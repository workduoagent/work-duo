//! 智能体运行时 Tauri 命令入口（供前端 invoke）。
//!
//!  - `run_agent_task`：启动一轮任务（后台 spawn ReAct 循环，事件流推前端）；
//!  - `submit_approval_decision`：回传高危操作审批决策；
//!  - `cancel_agent_task`：取消当前任务（best-effort）。
//!
//! 命令经 `@tauri-apps/plugin-sql` 读取 agent_info 与关联表，组装 `AgentRuntimeConfig`，
//! 不依赖前端重复传参（前端仅传 agentId + prompt + workspace）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

use sqlx::Row;
use tauri_plugin_sql::{DbInstances, DbPool};
use serde_json;

/// 自测闭环 run_id 自增序号（与毫秒时间戳组合，保证单次进程内唯一且可读）。
static RUN_ID_SEQ: AtomicU64 = AtomicU64::new(0);

/// 生成自测运行 id（如 `run-1715223456789-0`）。
pub(crate) fn next_run_id() -> String {
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

use crate::agent::hitl::approval::ApprovalDecisionInput;
use crate::agent::events;
use crate::agent::hitl::recovery::RecoveryDecision;
use crate::agent::engine::runtime::AgentRuntime;
use crate::agent::engine::runtime::RunRecord;
use crate::agent::engine::tools::{PathGuard, ToolContext};
use crate::agent::types::BranchStep;
use crate::agent::types::PlanBranchGenerated;
use crate::agent::types::PlanDAG;
use crate::agent::types::ReadArtifactResult;
use crate::agent::knowledge::knowledge;
use crate::agent::knowledge::memory::{self, HeatmapPoint, MemoryItem};

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
    /// P2-2（2026-09-23）：期望产物清单（相对工作空间路径）。非空且绑定 workspace 时注入系统提示
    /// 做收尾核对（文件名逐字一致、缺一不可）——修复「做了 90% 的活但不落盘最终产物」。
    #[serde(default)]
    pub expected_artifacts: Option<Vec<String>>,
}

/// 启动一轮智能体任务。
/// 预算软窗口看门狗（P0-1 两阶段软超时，2026-09-23）：run 预算到期前 `RUN_SOFT_WINDOW` 先置位
/// 既有 `cancel_flag`——流水线在既有边界检查点停止发起新步骤、在途调用自然收尾（timeout 到点
/// 硬 drop 内层 future 无法「等收尾」，软阶段必须在到点前置位）。返回 JoinHandle 供 run 结束后
/// abort，防止取消信号泄漏到该 Agent 的下一个任务。预算 ≤ 软窗口时不启用（防 0 点即取消）。
fn spawn_budget_watchdog(
    cancel_flag: std::sync::Arc<AtomicBool>,
    fired: std::sync::Arc<AtomicBool>,
    run_limit: std::time::Duration,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let soft = run_limit.saturating_sub(crate::agent::engine::runtime::RUN_SOFT_WINDOW);
    if soft.is_zero() {
        return None;
    }
    Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(soft).await;
        fired.store(true, std::sync::atomic::Ordering::SeqCst);
        cancel_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        tracing::warn!("[agent] run 预算软窗口触发：停止发起新步骤，等待在途调用收尾");
    }))
}

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
        input.expected_artifacts.clone(),
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
    // #8 per-run：UI 入口也注入内部 run_id（不入 run_registry、前端不感知），保证并发 run 的轨迹桶隔离。
    let internal_rid = next_run_id();

    // 锁已在上方入口处抢占（running_guard）：跨 spawn 持有，run_task 任意出口
    // （正常 / 取消 / panic）自动复位 running 并回收状态束；本处不再抢锁。
    events::reset_trace(&internal_rid); // #8 per-run：重置该 run 的轨迹桶
    // 台账 D4：注入归属上下文——终态落盘（agent_run_trace）的轨迹行带 agent/session，
    // 历史回放可按会话/智能体检索（spawn 顶层同步调用，桶内可见）。
    events::set_trace_context(
        &internal_rid,
        Some(input.agent_id.clone()),
        input.session_id.clone(),
    );
    tauri::async_runtime::spawn(async move {
        let _running_guard = running_guard;
        // #8 per-run：当前任务的所有 emit 点经 task_local 落到 internal_rid 桶，并发 run 互不串台。
        let _scope = crate::agent::events::with_run_id_scope(internal_rid.clone(), async move {
            tracing::info!("[agent] run_agent_task 后台任务已 spawn，开始 run_task");
            // 支柱① 终态铁律：run 级总墙钟兜底（验收口径第③层）。
            // 两阶段软超时（2026-09-23 L2 评审修正）：预算到期前 RUN_SOFT_WINDOW 先置位既有
            // cancel_flag——流水线在既有边界检查点停止发起新步骤、在途调用自然收尾（timeout
            // 到点硬 drop 内层 future 无法「等收尾」）；watchdog 在 run 结束后 abort，
            // 防止取消信号泄漏到该 Agent 的下一个任务。
            let run_limit = crate::agent::engine::runtime::run_wall_clock_limit();
            let cfg_workspace = cfg.workspace.clone();
            let budget_soft = std::sync::Arc::new(AtomicBool::new(false));
            let watchdog = spawn_budget_watchdog(
                task_state.cancel_flag.clone(),
                budget_soft.clone(),
                run_limit,
            );
            // cfg 被 run_task 消耗，先捕获 run id 供 host_grant 清理（与 gate/审批写入同源）。
            let host_run_id = cfg.round_id.clone();
            let run_outcome = tokio::time::timeout(
                run_limit,
                rt.run_task(&app_clone, cfg, prompt, plan_override, pre_completed, initial_context, &task_state),
            )
            .await;
            if let Some(h) = watchdog {
                let _ = h.abort();
            }
            // 服务器托管（Host）：run 结束强制过期该 run 的全部 host_grant（设计稿 §7.2，
            // 「记住」仅限本任务内——正常/取消/超时任意出口都清理，跨 run 本就不互认）。
            if let Some(rid) = host_run_id.as_deref() {
                if !rid.is_empty() {
                    crate::host::authz::cleanup_run_grants(&app_clone, rid).await;
                }
            }
            match run_outcome {
                Ok(()) => {}
                Err(_) => {
                    tracing::warn!(
                        "[agent] run_agent_task: run 总墙钟超时（{}s）——强制终态，释放运行锁",
                        run_limit.as_secs()
                    );
                    // P0-2：非正常终态 reply 必须非空（原因 + 已产出文件表）。
                    crate::agent::events::finalize_run_summary(
                        cfg_workspace.as_deref(),
                        "run_budget_exhausted",
                        &format!("运行总时长超时（{}s），已强制终止", run_limit.as_secs()),
                    );
                    crate::agent::events::emit_task_error(
                        &app_clone,
                        &format!("运行总时长超时（{}s），已强制终止以防任务永不结束", run_limit.as_secs()),
                    );
                }
            }
            // P0-2：软收尾（预算提前结束）/ 用户取消同样写观测兜底（reply 非空）。
            if run_outcome.is_ok() {
                if task_state.cancel_requested.load(Ordering::SeqCst) {
                    crate::agent::events::finalize_run_summary(
                        cfg_workspace.as_deref(),
                        "cancelled_by_user",
                        "任务已被用户取消；已产出文件保留，可据此续跑",
                    );
                } else if budget_soft.load(Ordering::SeqCst) {
                    tracing::warn!("[agent] run_agent_task: 预算软窗口生效，任务提前收尾");
                    crate::agent::events::finalize_run_summary(
                        cfg_workspace.as_deref(),
                        "run_budget_exhausted",
                        "运行预算耗尽（软收尾），已停止发起新步骤",
                    );
                    crate::agent::events::emit_task_error(
                        &app_clone,
                        "运行预算耗尽，已保留已产出文件；可加大 WD_RUN_MAX_SECS 或拆分任务后续跑",
                    );
                }
            }
            tracing::info!("[agent] run_agent_task 后台任务 run_task 结束");
        })
        .await;
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
        input.expected_artifacts.clone(),
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

    events::reset_trace(&rid); // #8 per-run：重置该 run 的轨迹桶
    // 台账 D4：同上——归属上下文注入（run_task_ex / MCP 链路）。
    events::set_trace_context(&rid, Some(cfg.agent_id.clone()), cfg.session_id.clone());
    // 超时/取消/预算标志（P0-1+P1-2，2026-09-23）：registry 终态区分 done / error / cancelled，
    // 且非正常终态必须带结构化 error（否则观测上分不清「正常完成/被终止/被取消」，违反支柱③）。
    let timed_out = std::sync::Arc::new(AtomicBool::new(false));
    let to_flag = timed_out.clone();
    let budget_soft = std::sync::Arc::new(AtomicBool::new(false));
    let budget_out = budget_soft.clone();
    let cancel_in = task_state.cancel_requested.clone();
    let cancel_out = cancel_in.clone();
    let cfg_workspace = cfg.workspace.clone();
    tauri::async_runtime::spawn(async move {
        let _running_guard = running_guard;
        // #8 per-run：当前任务的所有 emit 点经 task_local 落到 rid 桶，并发 run 互不串台。
        let _scope = crate::agent::events::with_run_id_scope(rid.clone(), async move {
            // 支柱① 终态铁律：run 级总墙钟兜底（同 run_agent_task，含预算软窗口两阶段收尾）。
            let run_limit = crate::agent::engine::runtime::run_wall_clock_limit();
            let watchdog = spawn_budget_watchdog(
                task_state.cancel_flag.clone(),
                budget_soft.clone(),
                run_limit,
            );
            let run_outcome = tokio::time::timeout(
                run_limit,
                rt.run_task(
                    &app_clone,
                    cfg,
                    prompt,
                    plan_override,
                    pre_completed,
                    initial_context,
                    &task_state,
                ),
            )
            .await;
            if let Some(h) = watchdog {
                let _ = h.abort();
            }
            match run_outcome {
                Ok(()) => {}
                Err(_) => {
                    to_flag.store(true, Ordering::Relaxed);
                    tracing::warn!(
                        "[agent] run_task_ex: run 总墙钟超时（{}s）——强制终态，释放运行锁",
                        run_limit.as_secs()
                    );
                    // P0-2：非正常终态 reply 必须非空（原因 + 已产出文件表）。
                    crate::agent::events::finalize_run_summary(
                        cfg_workspace.as_deref(),
                        "run_budget_exhausted",
                        &format!("运行总时长超时（{}s），已强制终止", run_limit.as_secs()),
                    );
                    crate::agent::events::emit_task_error(
                        &app_clone,
                        &format!("运行总时长超时（{}s），已强制终止以防任务永不结束", run_limit.as_secs()),
                    );
                }
            }
            // P0-2：软收尾（预算提前结束）/ 用户取消同样写观测兜底（reply 非空）。
            if run_outcome.is_ok() {
                if cancel_in.load(Ordering::SeqCst) {
                    crate::agent::events::finalize_run_summary(
                        cfg_workspace.as_deref(),
                        "cancelled_by_user",
                        "任务已被用户取消；已产出文件保留，可据此续跑",
                    );
                } else if budget_soft.load(Ordering::SeqCst) {
                    tracing::warn!("[agent] run_task_ex: 预算软窗口生效，任务提前收尾");
                    crate::agent::events::finalize_run_summary(
                        cfg_workspace.as_deref(),
                        "run_budget_exhausted",
                        "运行预算耗尽（软收尾），已停止发起新步骤",
                    );
                    crate::agent::events::emit_task_error(
                        &app_clone,
                        "运行预算耗尽，已保留已产出文件；可加大 WD_RUN_MAX_SECS 或拆分任务后续跑",
                    );
                }
            }
        })
        .await;
        let mut reg = reg.lock().await;
        if let Some(rec) = reg.get_mut(&rid) {
            // 终态三态（P1-2）：error=超时/预算耗尽；cancelled=用户取消；done=正常完成。
            // P0-2：非正常终态 rec.error 必须带结构化原因（MCP get_status 可读）。
            if timed_out.load(Ordering::Relaxed) || budget_out.load(Ordering::Relaxed) {
                rec.status = "error".to_string();
                rec.error = Some("run_budget_exhausted".to_string());
            } else if cancel_out.load(Ordering::SeqCst) {
                rec.status = "cancelled".to_string();
                rec.error = Some("cancelled_by_user".to_string());
            } else {
                rec.status = "done".to_string();
            }
            rec.finished_at = Some(now_ms());
        }
    });

    Ok(run_id)
}

/// MCP 状态详情：在 `RunRecord` 基础上叠加「审批挂起」可观测性，供外部 Agent
/// 判断是否需要调 `agent_submit_approval` / `agent_submit_plan_decision`。
///
/// - `waiting_approval=true` 且 `pending` 非空：任务正卡在人工审批（高危工具或计划门禁）。
/// - 仅当 `status=running` 时才探测 Hub（done/error 后 Hub 已被流水线清空）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusDetail {
    /// 运行态：`running` | `done` | `error`（取自 RunRecord，供 `wait` 终态判定）。
    pub status: String,
    pub run_id: String,
    pub agent_id: String,
    /// 是否正等待人工审批（高危工具 / 计划门禁）。
    pub waiting_approval: bool,
    /// 是否正等待步骤级恢复决策（子任务失败重试耗尽；决策经 agent_submit_recovery_decision）。
    /// 20260922：此前恢复等待对 MCP 完全不可观测，外部驱动遇失败步骤即永久卡死。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub recovery_waiting: bool,
    /// 挂起的审批摘要：`{kind:"tool", request:ApprovalRequest}` / `{kind:"plan", goal, stepCount}`
    /// 或 `{kind:"recovery", request:RecoveryRequest}`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<serde_json::Value>,
    /// `wait_task_interactive` 因审批挂起提前返回时为 true（外部 Agent 应去 submit 而非空转）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub interrupted: bool,
}

/// 组装一次状态详情（读 run_registry + 探测审批 Hub）。
async fn build_status_detail(
    runtime: &AgentRuntime,
    run_id: &str,
) -> Result<AgentStatusDetail, String> {
    let rec = {
        let reg = runtime.run_registry.lock().await;
        match reg.get(run_id) {
            Some(r) => r.clone(),
            None => return Err(format!("run_id 不存在: {run_id}")),
        }
    };
    let mut detail = AgentStatusDetail {
        status: rec.status.clone(),
        run_id: rec.run_id.clone(),
        agent_id: rec.agent_id.clone(),
        waiting_approval: false,
        recovery_waiting: false,
        pending: None,
        interrupted: false,
    };
    if rec.status == "running" {
        if let Ok(task) = runtime.resolve_task_state(Some(&rec.agent_id)) {
            if task.approval.has_pending().await {
                if let Some(req) = task.approval.current_request().await {
                    detail.waiting_approval = true;
                    detail.pending = Some(serde_json::json!({ "kind": "tool", "request": req }));
                }
            } else if task.plan_approval.is_blocked() {
                if let Some((goal, step_count)) = task.plan_approval.snapshot() {
                    detail.waiting_approval = true;
                    detail.pending =
                        Some(serde_json::json!({ "kind": "plan", "goal": goal, "stepCount": step_count }));
                }
            } else if task.recovery.is_blocked() {
                if let Some(req) = task.recovery.snapshot() {
                    detail.recovery_waiting = true;
                    detail.pending =
                        Some(serde_json::json!({ "kind": "recovery", "request": req }));
                }
            }
        }
    }
    Ok(detail)
}

/// 自测闭环：按 `run_id` 查询单次运行状态（含审批挂起详情）。
pub async fn get_status_detail(
    runtime: State<'_, AgentRuntime>,
    run_id: String,
) -> Result<AgentStatusDetail, String> {
    build_status_detail(&runtime, &run_id).await
}

/// 自测闭环：轮询等待 `run_id` 终态；但若任务卡在人工审批，立即带 `interrupted=true`
/// 返回（而非空转到超时），让外部 Agent 进入「提交审批决策 → 继续 wait」循环。
pub async fn wait_task_interactive(
    runtime: State<'_, AgentRuntime>,
    run_id: String,
    timeout_ms: Option<u64>,
) -> Result<AgentStatusDetail, String> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let detail = build_status_detail(&runtime, &run_id).await?;
        if detail.status == "done" || detail.status == "error" {
            return Ok(detail);
        }
        if detail.waiting_approval {
            let mut d = detail;
            d.interrupted = true;
            return Ok(d);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(detail);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
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
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
    decision: ApprovalDecisionInput,
) -> Result<bool, String> {
    // P1-2：无在跑任务（状态束已随上次任务回收）→ 结构化 no_pending（Ok(false)），不再 Err 吓人。
    let task = match runtime.resolve_task_state(agent_id.as_deref()) {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
    // 15007：「本任务内记住」勾选 → 把策略授权 key 写入 grants（同信号后续操作放行）。
    // 仅 approve/takeover 生效；skip 意味着拒绝，不该记住。
    if decision.remember && decision.decision != "skip" {
        if let Some(key) = &decision.grant_key {
            if key.starts_with("host:") {
                // Host 授权域：写 host_grant 独立表（与 local grants 物理分表，key 强制 host: 前缀）
                if let Some(req) = task.approval.pending_request(&decision.approval_id).await {
                    if let Some(meta) = &req.host_meta {
                        // L3 一律不写 host_grant（设计稿 §7.3：仅单次批准或拒绝，禁止记住）
                        let l3 = meta.get("l3").and_then(|v| v.as_bool()).unwrap_or(false);
                        if l3 {
                            tracing::info!("[agent] L3 风险不允许「本任务内记住」，按单次批准处理");
                        } else if let Err(e) = crate::host::authz::remember_grant_from_meta(&app, &task.agent_id, meta).await {
                            tracing::error!("[agent] host_grant 写入失败：{e}");
                        }
                    }
                }
            } else {
                task.approval_grants.grant(key);
            }
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
    // P1-2：无在跑任务（状态束已随上次任务回收）→ 结构化 no_pending（Ok(false)），不再 Err 吓人。
    let task = match runtime.resolve_task_state(agent_id.as_deref()) {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
    Ok(task
        .choice
        .resolve(&input.choice_id, &input.option_id, input.custom_text)
        .await)
}

/// 取消当前任务（最佳努力）：置位该 Agent 的取消标志，后台 run_task 流水线与流式拉取循环
/// 会在下一轮边界 / 下一个 SSE chunk 处感知并立即终止，无需额外的任务句柄。
/// 20260919002：按 agent_id 路由（并行任务只停目标 Agent）；agent_id 缺省时取唯一在跑任务。
/// 沙箱守卫状态快照（设置页「沙箱安全」区块读取；台账 P0-3）。
#[tauri::command]
pub fn sandbox_guard_status() -> Result<serde_json::Value, String> {
    Ok(crate::mamba_manager::guard_status_snapshot())
}

#[tauri::command]
pub async fn cancel_agent_task(
    runtime: State<'_, AgentRuntime>,
    agent_id: Option<String>,
) -> Result<(), String> {
    let task = runtime.resolve_task_state(agent_id.as_deref())?;
    task.cancel_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    // P1-2：记录取消来源（用户主动）——run 收尾据此写 `cancelled` 终态而非 `done`（修复 F-1）。
    task.cancel_requested
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
    // P1-2：无在跑任务（状态束已随上次任务回收）→ 结构化 no_pending（Ok(false)），不再 Err 吓人。
    let task = match runtime.resolve_task_state(agent_id.as_deref()) {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
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
    // P1-2：无在跑任务（状态束已随上次任务回收）→ 结构化 no_pending（Ok(false)），不再 Err 吓人。
    let task = match runtime.resolve_task_state(agent_id.as_deref()) {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
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
    // P1-2：无在跑任务（状态束已随上次任务回收）→ 结构化 no_pending（Ok(false)），不再 Err 吓人。
    let task = match runtime.resolve_task_state(agent_id.as_deref()) {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
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
    // P1-2：无在跑任务（状态束已随上次任务回收）→ 结构化 no_pending（Ok(false)），不再 Err 吓人。
    // 短任务可能在门禁暴露前就跑完，此时收到 false 属正常（勿重试 run_task）。
    let task = match runtime.resolve_task_state(agent_id.as_deref()) {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };
    if !task.plan_approval.is_blocked() {
        return Ok(false);
    }
    let decision = match input.decision.to_lowercase().as_str() {
        "approve" => crate::agent::hitl::plan_approval::PlanApprovalDecision::Approve,
        "reject" => crate::agent::hitl::plan_approval::PlanApprovalDecision::Reject,
        "revise" => crate::agent::hitl::plan_approval::PlanApprovalDecision::Revise(input.guidance.unwrap_or_default()),
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
    Ok(crate::agent::engine::context::stage_begin(name, mime))
}

/// 追加一个分片（来自前端 `Uint8Array`，经 Tauri 二进制 IPC 传输）。
#[tauri::command]
pub async fn append_stage_chunk(stage_id: String, data: Vec<u8>) -> Result<(), String> {
    crate::agent::engine::context::stage_append(&stage_id, &data)
}

/// 提交分片暂存：落盘到 `workspace/.attachments/` 并返回最终路径，清理缓冲。
#[tauri::command]
pub async fn commit_stage_attachment(
    stage_id: String,
    workspace: Option<String>,
) -> Result<String, String> {
    crate::agent::engine::context::stage_commit(&stage_id, &workspace)
}

/// 取消分片暂存（前端上传失败 / 超时清理）。
#[tauri::command]
pub async fn abort_stage_attachment(stage_id: String) -> Result<(), String> {
    crate::agent::engine::context::stage_abort(&stage_id);
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
        run_id: None,
        http_allowed_hosts: Vec::new(),
        run_outcomes: Default::default(),
        call_id: None,
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
        None, // expected_artifacts：分支规划阶段无产物核对
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

    // 分支重跑规划：branch_from_step 是独立命令（无运行中 task_state 可达），无取消语义传 None；
    // 规划产出的 DAG 随后经 agent_run_task(plan_override) 执行，彼时任务级取消链路正常生效。
    // 台账 S6：注册链与能力大纲同源——分支规划与 run_task 共用 build_full_registry。
    let registry = crate::agent::engine::runtime::build_full_registry(&app, &cfg);
    let (plan, _, _) = crate::agent::engine::planner::build_plan(
        &cfg,
        &prompt,
        cfg.workspace.as_deref(),
        None,
        &registry,
        None,
    )
    .await;

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

// 台账 S3：运行配置装配已抽至 engine::config_loader（load_config）与 squad::config（load_squad），
// 本文件仅保留 Tauri 接口层（参数解析 + 调用）。
use crate::agent::engine::config_loader::load_config;
use crate::agent::squad::config::load_squad;

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
        crate::agent::squad::squad_orchestrator::run_squad_task(&app_clone, squad, prompt).await;
    });
    Ok(())
}

/// 取消指定小分队的全部活跃会话（小分队 S0-3 取消穿线）：置位 squad 级取消标志，
/// 成员 pipeline / build_plan / 编排侧 call_llm 三层即时生效；返回取消的会话数。
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn cancel_squad_task(_app: AppHandle, squad_id: String) -> Result<usize, String> {
    Ok(crate::agent::squad::squad_orchestrator::cancel_squad_sessions(&squad_id))
}

/// S2（§4.6 L1）：计划门禁决议——用户批准 / 拒绝 manual 协作的委派计划。
/// 批准 → 协作继续；拒绝 → 会话以 cancelled 收尾。返回是否命中挂起的门禁。
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn squad_plan_approve(
    _app: AppHandle,
    session_id: String,
    approved: bool,
) -> Result<bool, String> {
    Ok(crate::agent::squad::squad_orchestrator::resolve_plan_gate(
        &session_id,
        approved,
    ))
}

/// S2（§4.11）打断说话：向运行中的协作会话目标（任务 id / 成员 agent_id / 角色）插入用户发言。
/// mode：soft（默认，下一安全点生效）| hard（尽快注入，UI 强调）| pre_talk（未启动任务的预嘱）。
/// 返回 inject_id（审计主键，agent_squad_inject 表）。
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn squad_inject_send(
    app: AppHandle,
    squad_id: String,
    session_id: String,
    task_id: String,
    content: String,
    mode: Option<String>,
) -> Result<String, String> {
    let pool = get_api_pool(&app).await?;
    crate::agent::squad::squad_orchestrator::squad_inject_send(
        &app,
        &pool,
        &squad_id,
        &session_id,
        &task_id,
        &content,
        mode.as_deref().unwrap_or("soft"),
    )
    .await
}

/// S2（§4.6 L2）：检查点决议——Wave 完成后挂起时用户选择继续（continue）或返工（rework）。
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn squad_checkpoint_resolve(
    _app: AppHandle,
    session_id: String,
    decision: String,
) -> Result<bool, String> {
    Ok(crate::agent::squad::squad_orchestrator::resolve_squad_checkpoint(
        &session_id,
        &decision,
    ))
}

/// S2（§4.6 L4）：交付确认——Delivery Pack 生成后用户确认交付（true）或要求修订（false，会话按取消收尾）。
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn squad_delivery_resolve(
    _app: AppHandle,
    session_id: String,
    approved: bool,
) -> Result<bool, String> {
    Ok(crate::agent::squad::squad_orchestrator::resolve_squad_delivery(
        &session_id,
        approved,
    ))
}

/// S2（§4.2）小分队成员工具面目录：原生工具全名清单 + 指定智能体实际挂载的 MCP 工具全名。
/// 编辑器工具面 chips 的候选数据源——能力层实时真相，避免前端硬编码工具名漂移。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadToolCatalogView {
    pub native_tools: Vec<String>,
    pub mcp_tools: Vec<String>,
}

#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn list_squad_tool_catalog(
    app: AppHandle,
    agent_id: Option<String>,
) -> Result<SquadToolCatalogView, String> {
    // 原生工具：注册一次取真名。宿主集与沙箱集各注册一遍取并集（重名覆盖无害），
    // memory_mode 传 active 让 anchor_memory 进入候选；此处仅为候选目录，成员实际可用
    // 集仍由其自身配置 + 工具面裁剪决定。
    let mut reg = crate::agent::engine::tools::ToolRegistry::new();
    crate::agent::engine::native::register_native_tools(&mut reg, &app, false, "active");
    crate::agent::engine::native::register_native_tools(&mut reg, &app, true, "active");
    let mut native_tools = reg.tool_names();
    native_tools.sort();
    // MCP 工具：该智能体（含全局并入）实际挂载的清单，给全名 mcp__{server}__{tool}。
    let mut mcp_tools: Vec<String> = Vec::new();
    if let Some(aid) = agent_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = crate::agent::engine::config_loader::load_config(
            &app, aid, None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
        .await?;
        for t in &cfg.mcp_tools {
            mcp_tools.push(format!("mcp__{}__{}", t.mcp_id, t.tool_name));
        }
    }
    mcp_tools.sort();
    mcp_tools.dedup();
    Ok(SquadToolCatalogView { native_tools, mcp_tools })
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
pub async fn anchor_squad_memory(app: AppHandle, input: AnchorSquadMemoryInput) -> Result<crate::agent::knowledge::memory::SquadMemoryItem, String> {
    crate::agent::knowledge::memory::anchor_squad_memory(
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
) -> Result<Vec<crate::agent::knowledge::memory::SquadMemoryItem>, String> {
    crate::agent::knowledge::memory::list_squad_memories(&app, &squad_id).await
}

/// 删除一条小分队记忆。
#[tauri::command]
pub async fn delete_squad_memory(app: AppHandle, id: String) -> Result<(), String> {
    crate::agent::knowledge::memory::delete_squad_memory(&app, &id).await
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

/// 删除知识库前级联清理该库全部向量段（2026-09-21 缺口修复：防孤儿段残留）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbIdInput {
    pub kb_id: String,
}

#[tauri::command]
pub async fn kb_remove_kb_index(app: AppHandle, input: KbIdInput) -> Result<(), String> {
    knowledge::remove_kb_index(&app, &input.kb_id).await
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

/// 台账 D4 第三步：任务交付包导出——把一次已完成 run 的轨迹/产物/KB 引用/审批链/成本
/// 归档为用户选定目录下的自包含交付包（manifest + report.md + trajectory + approvals
/// + sources + artifacts/）。业务逻辑在 agent/delivery.rs，本层只做参数透传。
#[tauri::command]
pub async fn agent_export_run_package(
    app: tauri::AppHandle,
    input: crate::agent::delivery::ExportRunPackageInput,
) -> Result<crate::agent::delivery::ExportRunPackageOutput, String> {
    crate::agent::delivery::export_run_package(&app, &input).await
}

/// 台账 D4 收官：事件级分叉——从已归档 run 的事件时间线选分叉点，
/// 合成「原目标 + 进展摘要」续跑指令（原会话开新一轮走 run(initialContext)）。
#[tauri::command]
pub async fn agent_build_event_fork(
    app: tauri::AppHandle,
    input: crate::agent::delivery::BuildEventForkInput,
) -> Result<crate::agent::delivery::BuildEventForkOutput, String> {
    crate::agent::delivery::build_event_fork(&app, &input).await
}
