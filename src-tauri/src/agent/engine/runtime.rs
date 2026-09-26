//! ReAct 运行时调度引擎（对应方案步骤 3）。
//!
//! 职责（单轮任务）：
//!  1. 由 `AgentRuntimeConfig` 组装 system prompt 与 tools（经 `ExtensionHub::assemble_registry`）；
//!  2. 调云端 OpenAI 兼容 LLM（reqwest 直连，base_url 来自模型配置；客户端不做本地重推理）；
//!  3. 解析 `tool_calls`：按 name 派发到注册表工具，敏感工具经 `ApprovalManager` 挂起等审批；
//!  4. 工具结果回填进 messages，循环直至模型输出纯文本（终态）或达最大轮次；
//!  5. 全程经 `events` 推送 `tool_started/finished`、`text_chunk`、`status` 等，驱动前端 UI。
//!
//! 约束：
//!  - Token 滑动窗口裁剪：messages 超长时裁剪早期历史（保留 system + 最近 N 轮）；
//!  - 熔断保护：单轮工具调用次数上限，防模型死循环；
//!  - 客户端一律走云端 API（与项目架构定调一致）。

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tokio::time::timeout;

use crate::agent::hitl::approval::ApprovalManager;
use crate::agent::hitl::approval::ApprovalOutcome;
use crate::agent::hitl::choice::ChoiceHub;
use crate::agent::engine::tools::AgentTool;
use crate::agent::events;
use crate::agent::engine::graph::KnowledgeGraph;
use crate::agent::engine::native;
use crate::agent::engine::tools::PermissionLevel;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolError;
use crate::agent::engine::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::ApprovalRequest;
use crate::agent::types::PlanDAG;
use crate::agent::types::ToolStep;

/// 历史消息保留轮次（滑动窗口）。
const MAX_HISTORY_TURNS: usize = 24;
/// 工具返回结果物理截断阈值（字符）。防止超大输出撑爆上下文、无谓消耗 Token。
const MAX_TOOL_OUTPUT_LENGTH: usize = 15000;
/// 敏感工具审批挂起超时（秒）。用户不点弹窗时避免任务永久挂起；
/// 超时与「停止」(`cancel_all` drop Sender) 都收敛到拒绝分支，不新增状态通路。
const APPROVAL_TIMEOUT_SECS: u64 = 300;

/// 单 Agent 任务级状态束（20260919002 per-agent 隔离）。
///
/// 取消标志 / 审批挂起 / 步骤恢复 / 方案推荐 / 计划审批 / 授权集 / 工具注册表
/// 全部随 agent 走——不同 Agent 的并行任务互不串台（此前全部是全局单例，
/// A 任务的「停止」会误伤 B 任务）。由 `try_acquire_run_lock(agent_id)` 创建或复用，
/// `RunningGuard` Drop 时从注册表移除（复位 running + 回收状态束）。
#[derive(Clone)]
pub struct AgentTaskState {
    pub agent_id: String,
    /// 该 Agent 的并发互斥标志（true = 有任务在跑）。
    pub running: Arc<AtomicBool>,
    /// 任务取消标志（用户点击「停止」时由 `cancel_agent_task` 置 true）。
    pub cancel_flag: Arc<AtomicBool>,
    /// 取消来源（P1-2）：仅用户主动取消时置 true。run 收尾据此把 registry 终态写成
    /// `cancelled` 而非 `done`（修复 F-1：取消后仍显示 done）；预算软收尾不置位本标志。
    pub cancel_requested: Arc<AtomicBool>,
    pub approval: Arc<ApprovalManager>,
    pub recovery: Arc<crate::agent::hitl::recovery::RecoveryHub>,
    pub choice: Arc<ChoiceHub>,
    pub plan_approval: Arc<crate::agent::hitl::plan_approval::PlanApprovalHub>,
    pub approval_grants: Arc<crate::agent::engine::policy::ApprovalGrants>,
}

impl AgentTaskState {
    fn new(agent_id: &str) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            running: Arc::new(AtomicBool::new(false)),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
            approval: Arc::new(ApprovalManager::new()),
            recovery: crate::agent::hitl::recovery::RecoveryHub::new(),
            choice: Arc::new(ChoiceHub::new()),
            plan_approval: crate::agent::hitl::plan_approval::PlanApprovalHub::new(),
            approval_grants: Arc::new(crate::agent::engine::policy::ApprovalGrants::new()),
        }
    }
}

/// 运行时共享状态（托管于 Tauri State，供命令访问）。
///
/// 20260919002：任务级状态全部下沉到 `AgentTaskState`（per-agent），本结构仅保留
/// 「per-agent 状态注册表」与「run 注册表」两块路由设施。
#[derive(Clone)]
pub struct AgentRuntime {
    /// per-agent 任务状态束注册表（key = agent_id）。
    /// 锁抢占（`try_acquire_run_lock`）按 agent 查/建；`RunningGuard` Drop 时移除。
    pub tasks: Arc<std::sync::Mutex<HashMap<String, AgentTaskState>>>,
    /// 自测闭环运行注册表：run_id → 单次运行记录。仅由 `run_task_ex` 写入，
    /// 供 `get_status`/`wait_task` 轮询，不改变既有 `run_agent_task` 行为（其 run_id 为 None，不入表）。
    pub run_registry: Arc<tokio::sync::Mutex<HashMap<String, RunRecord>>>,
}

/// 自测闭环的单次运行记录，关联一次 `run_task_ex` 调用。
#[derive(Clone, Serialize)]
pub struct RunRecord {
    pub run_id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub round_id: Option<String>,
    /// 状态机：`running` → `done` | `error`。
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

/// 并发互斥守卫：生命周期结束（正常退出 / 取消 / 异常 / panic）时自动复位该 Agent 的
/// `running` 并从注册表回收状态束。持有 `Arc<AtomicBool>`（而非借用），以便跨 `spawn`
/// 闭包移动（'static 要求）；这样无论任务从哪条路径结束，都不会遗留 `running=true`
/// 把该 Agent 的后续任务永久挡在门外。
pub(crate) struct RunningGuard {
    flag: Arc<AtomicBool>,
    tasks: Arc<std::sync::Mutex<HashMap<String, AgentTaskState>>>,
    agent_id: String,
}
impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(&self.agent_id);
        }
    }
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(std::sync::Mutex::new(HashMap::new())),
            run_registry: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// 抢占指定 Agent 的并发互斥锁（spawn 前主闸门，20260919002 per-agent 粒度）。
    /// 成功返回该 Agent 的任务状态束 + `RunningGuard`（收尾时自动复位并回收）；
    /// 该 Agent 已有任务在跑返回 `None`——调用方应同步 `Err` 给前端，
    /// 而非返回 `Ok(())` 后把任务静默忽略（UX 修复：连点「运行」可见「已有任务在运行」）。
    /// **不同 Agent 互不影响**：A 在跑不挡 B。
    pub fn try_acquire_run_lock(&self, agent_id: &str) -> Option<(AgentTaskState, RunningGuard)> {
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        let state = tasks
            .entry(agent_id.to_string())
            .or_insert_with(|| AgentTaskState::new(agent_id));
        if state
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Some((
                state.clone(),
                RunningGuard {
                    flag: state.running.clone(),
                    tasks: self.tasks.clone(),
                    agent_id: agent_id.to_string(),
                },
            ))
        } else {
            None
        }
    }

    /// 按需路由任务状态束：显式 agent_id 精确查找；缺省时取「唯一在跑」的任务
    /// （决策/取消命令的平滑兼容——单任务场景前端可不传 agent_id，多任务时必须显式传）。
    pub fn resolve_task_state(&self, agent_id: Option<&str>) -> Result<AgentTaskState, String> {
        let tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        match agent_id {
            Some(id) => tasks.get(id).cloned().ok_or_else(|| {
                format!("智能体 {id} 当前没有运行中的任务（状态束已随上次任务回收）")
            }),
            None => {
                let running: Vec<&AgentTaskState> =
                    tasks.values().filter(|t| t.running.load(Ordering::SeqCst)).collect();
                match running.len() {
                    1 => Ok(running[0].clone()),
                    0 => Err("当前没有运行中的任务".into()),
                    _ => Err(format!(
                        "有 {} 个任务并行在跑，请指定 agent_id 以路由决策",
                        running.len()
                    )),
                }
            }
        }
    }

    /// 按 agent_id 精确取任务状态束（任务内工具执行时使用，如 ask_user_choice 的
    /// choice 中枢路由）；该 Agent 无运行中任务返回 None。
    pub fn task_state(&self, agent_id: &str) -> Option<AgentTaskState> {
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).get(agent_id).cloned()
    }

    /// 启动一轮任务（被 `run_agent_task` 命令调用，后台 spawn）。
    ///
    /// **调用约束**：本方法**仅允许**由 `run_agent_task` 在持有 `run_task` 运行锁
    /// （`try_acquire_run_lock()` 返回的 `RunningGuard`）之后调用。并发互斥的唯一真源
    /// 是 `run_agent_task` 入口处那次抢锁——本方法内部不再做任何补抢/忽略判断，
    /// 故不可被其他路径直接调用（否则会绕过闸门、产生双流水线并发）。
    #[allow(unreachable_code)]
    pub async fn run_task(
        &self,
        app: &AppHandle,
        cfg: AgentRuntimeConfig,
        prompt: String,
        plan_override: Option<PlanDAG>,
        pre_completed: std::collections::HashSet<String>,
        initial_context: String,
        task: &AgentTaskState,
    ) {
        // 0) 新一轮任务开始：清除上一轮可能残留的取消标志。
        // P0-4 洞二修复：抢锁成功到真正执行之间隔着异步 load_config（commands.rs），该窗口内的
        // 「停止」会置位 cancel_flag/cancel_requested——无条件复位会把它静默吞掉。改为：
        // cancel_requested 已置位（窗口内取消；上轮残留已由 spawn 包装收尾复位，见 commands.rs）
        // 则保留置位，下方既有取消检查点（规划完成后等）将立即触发取消终态。
        // 「上一次取消未生效就立刻发起新任务」的误杀防护由运行锁承接：上轮未收尾时新任务
        // 抢不到运行锁，能进到这里的本轮必然始于收尾复位之后。
        if task.cancel_requested.load(Ordering::SeqCst) {
            tracing::warn!(
                "[agent] run_task: 检测到启动窗口内的取消置位（load_config 期间点停止），本轮直接按取消处理"
            );
        } else {
            task.cancel_flag.store(false, Ordering::SeqCst);
            task.cancel_requested.store(false, Ordering::SeqCst);
        }
        // 新一轮开始：清空前一轮可能残留的恢复挂起态（避免上轮 cancel 残留误导前端面板）。
        task.recovery.reset();
        // 同步清空计划审批 hub：cancel() 会无条件把 decision 置为 Cancel，若当时没有
        // 等待者消费（如用户在非门禁阶段点了停止），残留的 Cancel 会被**下一个任务**的
        // wait() 第一轮 take 走 → 新任务刚进门禁就被误判「用户取消」终止（真机 2026-09-17
        // 出现两次）。与 cancel_flag / recovery 的启动重置同源同必要。
        task.plan_approval.reset();
        // 边审批策略授权集（15007）：任务级生命周期，启动重置。
        task.approval_grants.reset();

        // 0.1) 动态重算并回写 tools_tokens：按当前已解析的 MCP/Skill 工具数覆盖写入会话表，
        //    中途移除 Skill / 停用（解绑）MCP 后，下一轮会自动下调；重新绑定则上调。
        if let Some(sid) = &cfg.session_id {
            crate::agent::engine::round_compactor::persist_tools_tokens(
                app,
                sid,
                cfg.mcp_tools.len(),
                cfg.skill_tools.len(),
            )
            .await;
        }

        // 1) 组装工具注册表（台账 S6 收敛：原生 + kb + MCP + 插件 + Host 统一在
        //    build_full_registry 注册——run_task / 分支规划 / squad 成员规划三处共用，
        //    注册链单一事实源；每次调用产出全新 registry，per-run 隔离语义不变）。
        let registry = build_full_registry(app, &cfg);
        tracing::info!(
            "[agent] run_task: 工具注册完成，共 {} 个工具（原生 + Skill + MCP + 插件）",
            registry.get_tools_for_llm().len()
        );

        // 2) 工作空间上下文
        let ws = cfg.workspace.as_ref().map(std::path::PathBuf::from);
        let ctx = ToolContext {
            workspace: ws,
            sandbox_enabled: cfg.allow_sandbox,
            agent_id: cfg.agent_id.clone(),
            session_id: cfg.session_id.clone(),
            run_id: cfg.round_id.clone(),
            http_allowed_hosts: cfg.http_allowed_hosts.clone(),
            run_outcomes: Default::default(),
        };

        // ────────────────────────────────────────────────────────────────────
        // 三层流水线调度（新架构）：意图分流 → DAG 规划 → 微 ReAct 流水线执行。
        // 下方旧的全局大 ReAct 循环已废弃（if false 留档，验证后删除）。
        // ────────────────────────────────────────────────────────────────────

        // 阶段一：意图分流（规则短路优先，灰色地带走轻量 LLM 分类）。
        let mut intent = crate::agent::engine::intent::classify_intent(&cfg, &prompt, Some(&task.cancel_flag)).await;
        // KB 已绑定 + SIMPLE_CHAT → 简单对话快路径（20260922 #1）：run_simple_chat 现已携带
        // native__kb_search 工具（kb_ids 非空时构造实例），纯 KB 问答跳过规划直接「检索→综合」，
        // 不再强制转 COMPOSITE（旧设计因空工具集导致 KB 不可检索而强制转换；网关慢时规划调用
        // 纯属开销，实测可达 1~3 分钟）。requires_tool 保留为语义标记，requires_planning=false。
        let kb_tool = if !cfg.kb_ids.is_empty() {
            Some(crate::agent::engine::native::KbSearchTool::new_arc(app.clone(), cfg.kb_ids.clone()))
        } else {
            None
        };
        if kb_tool.is_some() && intent.is_simple_chat() {
            tracing::info!(
                "[agent] run_task: KB 已绑定({}个) 且意图=SIMPLE_CHAT → 简单对话路径携带 native__kb_search（跳过规划）",
                cfg.kb_ids.len()
            );
            intent.requires_tool = true;
            intent.requires_planning = false;
            intent.requires_artifact = false;
        }
        events::emit_intent_classified(app, &intent);
        tracing::info!(
            "[agent] run_task: 意图判定 = {} reason={} risk={} 需规划={} 需工具={} 需审批={}",
            intent.intent_type,
            clip(&intent.reason, 200),
            intent.risk_level,
            intent.requires_planning,
            intent.requires_tool,
            intent.requires_approval,
        );

        // Intent→Policy：把风险等级映射为审批策略，驱动审批而非让 Planner 自判权限/风险。
        // 高风险任务即便开启 auto_tool_exec_mode 也强制走人工审批（RequireApproval）；
        // 低风险复合任务沿用用户配置（自动执行或逐次审批）。
        let effective_auto_exec =
            cfg.auto_tool_exec_mode && !intent.requires_approval && !intent.is_high_risk();
        if !effective_auto_exec && cfg.auto_tool_exec_mode {
            tracing::info!(
                "[agent] run_task: 风险等级 {} 触发强制人工审批（覆盖 auto_tool_exec_mode）",
                intent.risk_level
            );
        }
        // 注：不再向前端推送意图分类状态（技术细节，用户不需要）；仅保留后端日志便于排查。
        tracing::info!(
            "[agent] run_task: 意图 = {} 风险={} 需规划={} 需工具={}（不推送前端）",
            intent.intent_type,
            intent.risk_level,
            intent.requires_planning,
            intent.requires_tool,
        );
        // 将审批策略固化进配置：流水线执行工具轮时据此决定是否挂起审批。
        let mut cfg = cfg;
        cfg.auto_tool_exec_mode = effective_auto_exec;
        tracing::info!(
            "[agent] run_task: 核心参数 agent={} auto_exec={} allow_sandbox={} memory_mode={:?} workspace={:?} intent={} risk={}",
            cfg.agent_id, cfg.auto_tool_exec_mode, cfg.allow_sandbox, cfg.memory_mode, cfg.workspace, intent.intent_type, intent.risk_level,
        );

        // 分支 A：简单对话 → 单次流式输出，0 工具介入，终态即结束。
        // 注意：分支重跑（plan_override 存在）时即便意图被分为 simple_chat 也强制走复合路径，
        // 因为用户已显式给出待执行的 DAG，必须进入流水线。
        if intent.is_simple_chat() && plan_override.is_none() {
            self.run_simple_chat(app, &cfg, &prompt, &task.cancel_flag, kb_tool).await;
            return;
        }

        // 分支 B：复合任务 → 阶段二任务拆解规划。
        // §3.2 分支重跑：若前端已提供 plan_override，直接采用（跳过 LLM 规划，token 计 0）。
        // 注：不再向前端推送「正在规划任务步骤…」状态（用户不需要该提示），仅保留后端日志。
        tracing::info!("[agent] run_task: 进入复合任务规划阶段");
        let is_branch_rerun = plan_override.is_some();
        let (mut plan, mut plan_usage, mut plan_raw) = if let Some(po) = plan_override {
            tracing::info!(
                "[agent] run_task: 采用前端分支计划（共 {} 步，其中 {} 步预完成跳过），跳过 LLM 规划",
                po.tasks.len(),
                pre_completed.len()
            );
            (po, (0u64, 0u64), String::new())
        } else {
            crate::agent::engine::planner::build_plan(&cfg, &prompt, cfg.workspace.as_deref(), Some(&task.cancel_flag), &registry).await
        };

        // 规划期间用户可能已点击取消：规划完成后立即检查，避免拉起无意义的流水线。
        if task.cancel_flag.load(Ordering::SeqCst) {
            tracing::info!("[agent] run_task: 规划完成后检测到取消信号，终止任务");
            events::emit_status(app, "⛔ 任务已被用户取消");
            events::emit_task_done(app, plan_usage.0, plan_usage.1);
            return;
        }

        // ── Phase 2b-3 计划审批门禁 + allow 规则层 ──
        // 分支重跑（plan_override 已存在）视为用户已确认，跳过门禁；
        // 否则根据 `plan_auto_approve_mode` 策略决定挂起还是自动放行：
        //   - "always"（默认）：规划完成后挂起，等待用户「批准 / 拒绝 / 修改意见」；
        //   - "sensitive"：仅含敏感操作的计划挂起，纯低风险计划自动放行；
        //   - "never"：一律不审批，规划后直接执行。
        // 手动模式（agent-studio 后台任务）下 "always"/"sensitive" 保持永久阻塞，直到用户决策。
        let auto_approve_mode = cfg.plan_auto_approve_mode.clone();
        let auto_skip = if is_branch_rerun {
            false
        } else {
            match auto_approve_mode.as_str() {
                "never" => true,
                "sensitive" => !crate::agent::hitl::plan_approval::plan_requires_approval(&plan),
                _ => false, // "always" 及其它未知值：保持最严格，走门禁
            }
        };
        if auto_skip {
            tracing::info!(
                "[agent] run_task: 计划审批策略={} 自动放行（无需人工确认），直接执行",
                auto_approve_mode
            );
            events::emit_status(app, "✅ 计划审批策略：自动放行（无需人工确认），直接执行");
        } else if !is_branch_rerun {
            loop {
                if task.cancel_flag.load(Ordering::SeqCst) {
                    tracing::info!("[agent] run_task: 计划审批等待期间检测到取消信号，终止任务");
                    events::emit_status(app, "⛔ 任务已被用户取消");
                    events::emit_task_done(app, plan_usage.0, plan_usage.1);
                    return;
                }
                // 15007 闸 1：计划门禁处对整个 DAG 做策略评估——敏感操作清单随审批卡下发，
                // 用户「批准执行」即一次性授权整计划（清单写入 grants，执行期同信号不再弹卡）。
                let sensitive_ops = crate::agent::engine::policy::evaluate_plan(&plan);
                let req = crate::agent::hitl::plan_approval::PlanApprovalRequest {
                    goal_summary: plan.goal_summary.clone(),
                    plan: plan.clone(),
                    sensitive_ops: sensitive_ops.clone(),
                };
                events::emit_plan_approval_needed(app, &req);
                task.plan_approval.request(req);
                let decision = task.plan_approval.wait(&task.cancel_flag).await;
                match decision {
                    crate::agent::hitl::plan_approval::PlanApprovalDecision::Approve => {
                        task.plan_approval.reset();
                        // 批准 = 授权整计划敏感清单（执行期同信号操作放行）
                        for op in &sensitive_ops {
                            task.approval_grants
                                .grant(&format!("{}:{}", op.category, op.pattern));
                        }
                        break;
                    }
                    crate::agent::hitl::plan_approval::PlanApprovalDecision::Reject => {
                        task.plan_approval.reset();
                        tracing::info!("[agent] run_task: 计划被用户拒绝，整体终止任务");
                        events::emit_status(app, "✋ 任务计划已被用户拒绝，已终止");
                        events::emit_task_done(app, plan_usage.0, plan_usage.1);
                        return;
                    }
                    crate::agent::hitl::plan_approval::PlanApprovalDecision::Revise(guidance) => {
                        task.plan_approval.reset();
                        // 空指引等价于 Approve：直接放行，避免无意义死循环。
                        if guidance.trim().is_empty() {
                            tracing::info!("[agent] run_task: 计划审批收到空修改意见，按批准处理");
                            break;
                        }
                        tracing::info!("[agent] run_task: 计划审批收到修改意见，重新规划：{}", clip(&guidance, 200));
                        events::emit_status(app, "🔄 已收到修改意见，正在重新规划…");
                        let revised_prompt = format!("{}\n\n用户修改意见：{}", prompt, guidance);
                        let (np, nu, nr) =
                            crate::agent::engine::planner::build_plan(&cfg, &revised_prompt, cfg.workspace.as_deref(), Some(&task.cancel_flag), &registry).await;
                        plan = np;
                        plan_usage.0 += nu.0;
                        plan_usage.1 += nu.1;
                        plan_raw = nr;
                        // 重新规划期间可能取消：完成即重新进入门禁循环。
                        if task.cancel_flag.load(Ordering::SeqCst) {
                            tracing::info!("[agent] run_task: 重新规划期间检测到取消信号，终止任务");
                            events::emit_status(app, "⛔ 任务已被用户取消");
                            events::emit_task_done(app, plan_usage.0, plan_usage.1);
                            return;
                        }
                        continue;
                    }
                    crate::agent::hitl::plan_approval::PlanApprovalDecision::Cancel => {
                        task.plan_approval.reset();
                        tracing::info!("[agent] run_task: 计划审批等待期间用户取消，终止任务");
                        events::emit_status(app, "⛔ 任务已被用户取消");
                        events::emit_task_done(app, plan_usage.0, plan_usage.1);
                        return;
                    }
                }
            }
        }

        events::emit_plan_generated(app, &plan);
        // 规划阶段模型原始输出作为 plan 层思考推送给轨迹视图（与执行期 exec / 收尾 selfcheck 分层区分）。
        if !plan_raw.trim().is_empty() {
            events::emit_thinking_chunk(app, &clip(&plan_raw, 2000), true, "plan");
        }
        // 规划阶段已产生 token 消耗，立即推送一次实时用量（后续各子任务完成再累加推送）。
        events::emit_token_update(app, plan_usage.0, plan_usage.1);

        // 阶段三：流水线隔离执行（子任务独立上下文、产物管道、失败重试 3 次）。
        // 图驱动：打开（或新建）本工作空间的统一实体图，把规划写入图，运行时状态由图承载。
        let mut graph = match KnowledgeGraph::open(cfg.workspace.as_deref()) {
            Ok(g) => g,
            Err(e) => {
                tracing::error!("[agent] run_task: 打开实体图失败：{e}");
                events::emit_task_error(app, &format!("打开实体图失败：{e}"));
                return;
            }
        };
        let session_id = cfg
            .session_id
            .clone()
            .unwrap_or_else(|| format!("sess_{}", now_ms()));
        graph.plan_to_graph(&plan, &session_id);
        // §3.2 分支重跑：把预完成的 head 步骤标记为 completed（流水线跳过执行），
        // 并补发 step_finished 让前端画布标记为「已完成」。
        let plan_total = plan.tasks.len();
        for tid in &pre_completed {
            if let Some(nid) = graph.find_task_node(&session_id, tid) {
                graph.set_task_status(&nid, "completed");
                let (step, title) = match graph.get_node(&nid) {
                    Some(n) => (
                        n.props.get("step").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                        n.props
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    None => (0, String::new()),
                };
                events::emit_step_finished(
                    app,
                    step,
                    plan_total,
                    &title,
                    true,
                    "（沿用已完成结果，分支重跑跳过）",
                    false,
                    "（沿用已完成结果，未做客观校验）",
                    true,
                );
            }
        }
        // 分支重跑基底：initial_context 作为产物管道初始摘要，供 tail 步骤续接 head 成果。
        if !initial_context.is_empty() {
            graph.set_session_initial_context(&session_id, &initial_context);
        }
        let result = crate::agent::engine::pipeline::run_pipeline(
            app,
            &cfg,
            &registry,
            &ctx,
            &task.approval,
            &mut graph,
            &session_id,
            &task.cancel_flag,
            &task.recovery,
            false,
            Some(&task.approval_grants),
        )
        .await;
        // 收尾：保存会话子图快照（完整子图，供后续检索/复盘）。
        graph.snapshot(&session_id);

        // 用户中途取消：跳过正常收尾（不持久化半成品 round），仅做取消提示并收尾。
        if result.cancelled {
            tracing::info!("[agent] run_task: 流水线检测到取消信号，已提前收尾");
            let task_usage = (plan_usage.0 + result.usage.0, plan_usage.1 + result.usage.1);
            // 问题 1 修复：按取消来源分流文案——用户主动停止保持原文案；
            // 无人值守恢复超时（cancel_reason=Some）带出系统自动取消原因，不再误报「用户取消」。
            let status_msg = match &result.cancel_reason {
                None => "⛔ 任务已被用户取消".to_string(),
                Some(r) => format!("⛔ {r}"),
            };
            events::emit_status(app, &status_msg);
            events::emit_task_done(app, task_usage.0, task_usage.1);
            return;
        }

        // 强制记忆模式：流水线成功收尾后，引擎级确定性沉淀（不依赖模型是否主动调工具）。
        if cfg.memory_mode == "forced" && result.success {
            // M0 输入增强：final_text 面向用户只含「已生成/更新 X」模板行（产物型步骤的
            // summary 被去 AI 味规则丢弃），提炼器无米下锅 → 追加各步 summary 作提炼素材。
            // 烧钱护栏（2026-09-18 审计）：长任务步骤多/摘要长时全量拼接会顶高这次单发调用的
            // input——提炼记忆不需要逐字全文，各段裁剪到够提炼即可。
            let mut settle_input = crate::agent::engine::runtime::clip(result.final_text.trim(), 4000);
            if !result.step_summaries.is_empty() {
                settle_input.push_str("\n\n各步骤产出详情：\n");
                for (i, s) in result.step_summaries.iter().enumerate() {
                    settle_input.push_str(&format!("{}. {}\n", i + 1, crate::agent::engine::runtime::clip(s.trim(), 600)));
                }
            }
            // 补料（2026-09-18 实测）：模型常把长期约定写进 .wd_mem/ 文件而不调 anchor_memory，
            // summary 又偷懒（「本步骤完成。」）→ 提炼器无米下锅误判无可沉淀。把本轮写入
            // .wd_mem/ 的文件内容带给提炼器，forced 模式才能从文件内容补齐记忆宫殿条目。
            if !result.wd_mem_notes.is_empty() {
                settle_input.push_str("\n\n本轮写入记忆区（.wd_mem/）的文件内容摘录：\n");
                for (path, content) in result.wd_mem_notes.iter() {
                    settle_input
                        .push_str(&format!("【{}】\n{}\n", path, crate::agent::engine::runtime::clip(content, 1200)));
                }
            }
            Self::forced_memory_settle(app, &cfg, &plan.goal_summary, &settle_input).await;
        }

        // 阶段四：合并全局执行视图，切片流式推送终态文本（#20260918011 工作空间模式打字机：
        // 原实现一次性整段下发，观感「一起输出」；改为与自由会话同款逐片流式，推完再收尾 done）。
        Self::stream_final_text(app, &result.final_text, &task.cancel_flag).await;
        events::emit_text_chunk(app, "", true);

        // token 用量 = 规划 + 各子任务累计，写回会话表并随事件带出。
        let task_usage = (plan_usage.0 + result.usage.0, plan_usage.1 + result.usage.1);
        events::emit_task_done(app, task_usage.0, task_usage.1);
        if let Some(sid) = &cfg.session_id {
            crate::agent::engine::round_compactor::persist_session_tokens(app, sid, task_usage.0, task_usage.1).await;
        }

        // 持久化精简协议日志（宏观意图 + 步骤规划 + 最终交付），入库前自检防孤儿消息。
        if let Some(round_id) = &cfg.round_id {
            let mut compact_round = vec![
                json!({ "role": "user", "content": prompt.clone() }),
                json!({
                    "role": "assistant",
                    "content": format!(
                        "[任务规划：{}（{} 步）]\n{}",
                        plan.goal_summary,
                        plan.tasks.len(),
                        plan.tasks.iter().map(|t| format!("步骤{}：{}", t.step, t.title)).collect::<Vec<_>>().join("；")
                    )
                }),
                json!({ "role": "assistant", "content": result.final_text.clone() }),
            ];
            sanitize_message_sequence(&mut compact_round);
            match serde_json::to_string(&compact_round) {
                Ok(raw_json) => {
                    tracing::info!(
                        "[agent] run_task: 回填精简 raw_messages_json（round={} 大小={}字符）",
                        round_id,
                        raw_json.chars().count(),
                    );
                    crate::agent::engine::round_compactor::persist_round_raw(app, round_id, &raw_json).await;
                    crate::agent::engine::round_compactor::persist_round_answer_if_empty(app, round_id, &result.final_text).await;
                    // #8 per-run：取当前 run 的桶（task_local 注入的 run_id）。
                    let rid = crate::agent::events::current_run_id();
                    let trace_thinking = crate::agent::events::trace_thinking_snapshot(&rid);
                    let trace_tools = crate::agent::events::trace_tool_calls_summary_json(&rid);
                    crate::agent::engine::round_compactor::persist_round_process_if_empty(app, round_id, &trace_thinking, &trace_tools).await;
                }
                Err(e) => tracing::error!("[agent] run_task: 序列化精简 raw_messages_json 失败：{e}"),
            }
            if let Some(sid) = &cfg.session_id {
                crate::agent::engine::round_compactor::bump_session_turns(app, sid).await;
                crate::agent::engine::round_compactor::trigger_background_compaction(app, &cfg, sid).await;
            }
        } else {
            tracing::info!("[agent] run_task: 无 round_id，跳过精简 raw_messages_json 回填");
        }
        return;

    }

    /// 终态文本切片流式推送（#20260918011 工作空间模式打字机）：复合任务此前把聚合后的最终回复
    /// 一次性整段下发（前端观感「一起蹦出来」，与自由会话的逐字流式不一致）。这里沿用同款
    /// `text_chunk` 协议按字符块切片推送（总量自适应，约 1.5~2s 推完），推送完再由调用方收尾
    /// `done=true`；长回复不会拖到几十秒（片长随总量放大）。取消标志置位后立即停止推送。
    /// 注意：一律按 `chars()` 切分（中文多字节安全，禁止 &s[..n] 字节切片）。
    async fn stream_final_text(app: &AppHandle, text: &str, cancel: &Arc<AtomicBool>) {
        if text.is_empty() {
            return;
        }
        let chars: Vec<char> = text.chars().collect();
        let total = chars.len();
        // 目标约 120 片：片长随总量放大（长回复加速，保证总时长可控），最小 2 字符/片
        let step = std::cmp::max(2, (total + 119) / 120);
        let mut i = 0usize;
        while i < total {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let end = std::cmp::min(total, i + step);
            let piece: String = chars[i..end].iter().collect();
            events::emit_text_chunk(app, &piece, false);
            i = end;
            tokio::time::sleep(std::time::Duration::from_millis(16)).await;
        }
    }

    /// 强制记忆模式的引擎级确定性沉淀：流水线成功收尾后，引擎自己调 LLM 总结本次任务可复用的长期记忆，
    /// 直接落库 `agent_memories`（anchored=false，仅沉淀、参与 ref_count 排序），不依赖模型是否主动调工具。
    /// 这是「强制」档与「主动」档的本质区别——前者是能力层后置步骤，必然发生；后者仅靠提示引导，模型自主决定。
    async fn forced_memory_settle(
        app: &AppHandle,
        cfg: &AgentRuntimeConfig,
        goal_summary: &str,
        final_text: &str,
    ) {
        let sys = "你是智能体的长期记忆提炼器。你的任务是把一次完成的任务中**可跨会话复用**的稳定知识，提炼成若干条长期记忆。\
只沉淀真正值得长期保留的：用户明确表达的偏好/约束、已确认的技术决策/架构约定、踩过的坑与规避方式、可复用代码/脚本模式。\
不要沉淀一次性任务步骤、临时草稿、当轮琐碎状态。\
注意：交付内容里可能存在「预算耗尽收尾、暂定完成、建议人工复核」字样的步骤——这类步骤未经行为级验收，\
提炼时只采纳用户显式表达的约定/偏好本身，不要把暂定步骤的执行结果当作已验证事实写入记忆。";
        let user = format!(
            "本次任务目标：\n{}\n\n最终交付内容：\n{}\n\n提炼判定规则（严格遵循）：\n\
1. 若本次创建/修改的文件中包含「团队约定 / 编码规范 / 用户偏好 / 流程 / 技术决策」类内容，**必须**将其提炼为记忆条目（分类通常为 user_pref 或 decision）——此情形禁止回答「无」。\n\
2. 若用户在对话中明确表达了偏好或约束，同样必须提炼。\n\
3. 仅当任务纯属一次性执行（如验证环境、跑临时脚本）且确实没有任何稳定知识产出时，才回复「无」。\n\n\
若无值得长期沉淀的内容，只回复一个字「无」。\n\
否则按每行一条输出，格式严格为：关键词 | 分类 | 记忆内容\n\
其中分类取 decision（决策）/ code_pattern（代码模式）/ user_pref（用户偏好）/ architecture（架构）/ fix（避坑）/ other（其他）之一。",
            goal_summary, final_text
        );
        let messages = vec![
            serde_json::json!({ "role": "system", "content": sys }),
            serde_json::json!({ "role": "user", "content": user }),
        ];
        // 提炼是确定性任务：temperature=0 抑制小模型输出波动
        // （实测 gemma4 同 prompt 三次 34/614/35 token 波动，0.7 下频繁偷懒回「无」）。
        let mut settle_cfg = cfg.clone();
        if let Some(obj) = settle_cfg.llm_config.as_object_mut() {
            obj.insert("temperature".into(), serde_json::json!(0));
        }
        match call_llm(&settle_cfg, &messages, &[], None).await {
            Ok((resp, _usage)) => {
                let content = resp
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("message"))
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if content == "无" || content.is_empty() {
                    tracing::info!("[agent] forced_memory_settle: 模型判定无可沉淀记忆");
                    return;
                }
                let mut count = 0usize;
                let mut skipped = 0usize;
                for line in content.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let parts: Vec<&str> = line.splitn(3, '|').map(|s| s.trim()).collect();
                    if parts.len() < 3 || parts[0].is_empty() || parts[2].is_empty() {
                        continue;
                    }
                    let key = parts[0];
                    let category = parts[1];
                    let body = parts[2];
                    // M0 质量护栏：短 key / 短 content / 模板复述句 / 非法分类直接丢弃，不落库。
                    if let Err(reason) =
                        crate::agent::knowledge::memory::validate_forced_entry(key, category, body)
                    {
                        tracing::debug!(
                            "[agent] forced_memory_settle: 跳过低质量条目（{}，key={}）",
                            reason,
                            key
                        );
                        skipped += 1;
                        continue;
                    }
                    match crate::agent::knowledge::memory::anchor_memory(
                        app,
                        Some(&cfg.agent_id),
                        cfg.session_id.as_deref(),
                        key,
                        body,
                        category,
                        false,
                        // 引擎强制沉淀属自动路径，走质量护栏（去噪合并 + 强校验）。
                        true,
                    )
                    .await
                    {
                        Ok(_) => count += 1,
                        Err(e) => tracing::warn!(
                            "[agent] forced_memory_settle: 锚定失败（key={}）：{e}",
                            key
                        ),
                    }
                }
                tracing::info!(
                    "[agent] forced_memory_settle: 强制沉淀 {} 条记忆（跳过 {} 条低质量）",
                    count,
                    skipped
                );
            }
            Err(e) => tracing::warn!("[agent] forced_memory_settle: 总结 LLM 调用失败：{e}"),
        }
    }

    /// 分支 A（SIMPLE_CHAT）：单次流式输出 + 可选知识库检索，毫秒级终态推送。
    /// 简单对话需要延续会话上下文（含历史轮次与滚动摘要），因此走 build_context_messages；
    /// 20260922 #1：KB 绑定时携带 native__kb_search（ReadSafe 免审批），纯问答走
    /// 「检索→综合」快路径（有界 2 轮工具循环，跳过规划），kb 未绑定时工具集仍为空、行为不变。
    async fn run_simple_chat(
        &self,
        app: &AppHandle,
        cfg: &AgentRuntimeConfig,
        prompt: &str,
        cancel: &Arc<AtomicBool>,
        kb_tool: Option<std::sync::Arc<crate::agent::engine::native::KbSearchTool>>,
    ) {
        let mut messages = match crate::agent::engine::context::build_context_messages(app, cfg, prompt).await {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("[agent] run_simple_chat: 上下文组装失败：{e}");
                events::emit_task_error(app, &format!("上下文组装失败：{e}"));
                return;
            }
        };
        let round_base = messages.len().saturating_sub(1);
        let mut task_usage: (u64, u64) = (0, 0);

        // 裁剪 + 配对自检（历史轮次可能很长）。
        let mut trimmed = trim_history(&messages);
        sanitize_message_sequence(&mut trimmed);

        let tool_defs = kb_tool.as_ref().map(|t| vec![t.tool_definition()]).unwrap_or_default();
        tracing::info!(
            "[agent] run_simple_chat: 单次流式调用（上下文={}条消息[裁剪前{}条]，kb工具={}个）",
            trimmed.len(),
            messages.len(),
            tool_defs.len(),
        );
        // 终态正文留存：循环以带值 break 退出（Err 臂直接 return）。
        let mut llm_messages = trimmed.clone();
        let mut tool_rounds = 0usize;
        let simple_final_text: String = 'chat: loop {
            match call_llm_stream(
                app,
                cfg,
                &llm_messages,
                &tool_defs,
                cancel,
                // 增量推流：每个 SSE 正文 delta 立即作为 text_chunk 下发，前端逐字渲染为流式回复。
                Some(&|delta: &str| {
                    if !delta.is_empty() {
                        events::emit_text_chunk(app, delta, false);
                    }
                }),
                // reasoning 思考流式（#20260918011）：chat 层逐批推送（节流在 call_llm_stream 内）。
                Some(&|delta: &str| {
                    if !delta.is_empty() {
                        events::emit_thinking_chunk(app, delta, false, "chat");
                    }
                }),
            )
            .await
            {
                Ok(outcome) => {
                    task_usage.0 += outcome.usage.0;
                    task_usage.1 += outcome.usage.1;
                    // 流式过程中用户可能已点击取消：已推送片段保留，仅补取消提示并收尾。
                    if cancel.load(Ordering::SeqCst) {
                        tracing::info!("[agent] run_simple_chat: 流式返回后检测到取消信号，终止任务");
                        events::emit_status(app, "⛔ 任务已被用户取消");
                        events::emit_task_done(app, task_usage.0, task_usage.1);
                        return;
                    }
                    // 终态：无工具调用 / KB 工具不可用 / 达到有界轮次上限。
                    if outcome.tool_calls.is_empty() || kb_tool.is_none() || tool_rounds >= 2 {
                        let content = outcome.content;
                        tracing::info!(
                            "[agent] run_simple_chat: 终态文本 {} 字符：{}",
                            content.chars().count(),
                            clip(content.trim(), 200),
                        );
                        // 增量推流已在 call_llm_stream 内部逐片下发；此处仅补一个 done 标记收尾。
                        events::emit_text_chunk(app, "", true);
                        messages.push(json!({ "role": "assistant", "content": content }));
                        break 'chat content;
                    }
                    // 工具轮：执行 native__kb_search（ReadSafe 免审批），结果回灌后再来一轮。
                    tool_rounds += 1;
                    llm_messages.push(json!({
                        "role": "assistant",
                        "content": outcome.content,
                        "tool_calls": outcome.tool_calls.clone(),
                    }));
                    for tc in &outcome.tool_calls {
                        let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let args_str = tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}").to_string();
                        let args: Value = serde_json::from_str(&args_str).unwrap_or_else(|_| json!({}));
                        let started_at = std::time::Instant::now();
                        let mk_step = |status: &str, result: Option<String>, dur: Option<u64>| crate::agent::types::ToolStep {
                            call_id: call_id.clone(),
                            tool_name: name.clone(),
                            status: status.into(),
                            sensitive: false,
                            args: Some(args_str.clone()),
                            result,
                            duration_ms: dur,
                            created_at: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as i64)
                                .unwrap_or(0),
                            step: Some(1),
                            op: Some("search".into()),
                            path: None,
                            lines_added: None,
                            lines_removed: None,
                        };
                        events::emit_tool_started(app, &mk_step("running", None, None));
                        let result = if name == "native__kb_search" {
                            let ctx = crate::agent::engine::tools::ToolContext {
                                agent_id: cfg.agent_id.clone(),
                                session_id: cfg.session_id.clone(),
                                ..Default::default()
                            };
                            match crate::agent::engine::tools::AgentTool::execute(kb_tool.as_deref().unwrap(), args, &ctx).await {
                                Ok(r) => r,
                                Err(e) => format!("kb_search 执行失败：{e:?}"),
                            }
                        } else {
                            format!("当前简单对话路径仅支持知识库检索（native__kb_search），{name} 不可用；请基于已有信息直接作答。")
                        };
                        let ok = !result.starts_with("kb_search 执行失败");
                        events::emit_tool_finished(app, &mk_step(
                            if ok { "success" } else { "failed" },
                            Some(clip(&result, 2000)),
                            Some(started_at.elapsed().as_millis() as u64),
                        ));
                        llm_messages.push(json!({ "role": "tool", "tool_call_id": call_id, "content": result }));
                    }
                }
                Err(e) => {
                    tracing::error!("[agent] run_simple_chat: LLM 调用失败：{e}");
                    events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                    return;
                }
            }
        };
        events::emit_task_done(app, task_usage.0, task_usage.1);
        if let Some(sid) = &cfg.session_id {
            crate::agent::engine::round_compactor::persist_session_tokens(app, sid, task_usage.0, task_usage.1).await;
        }
        if let Some(round_id) = &cfg.round_id {
            let round_messages = &messages[round_base..];
            match serde_json::to_string(round_messages) {
                Ok(raw_json) => {
                    crate::agent::engine::round_compactor::persist_round_raw(app, round_id, &raw_json).await;
                    crate::agent::engine::round_compactor::persist_round_answer_if_empty(app, round_id, &simple_final_text).await;
                    // #8 per-run：取当前 run 的桶（task_local 注入的 run_id）。
                    let rid = crate::agent::events::current_run_id();
                    let trace_thinking = crate::agent::events::trace_thinking_snapshot(&rid);
                    let trace_tools = crate::agent::events::trace_tool_calls_summary_json(&rid);
                    crate::agent::engine::round_compactor::persist_round_process_if_empty(app, round_id, &trace_thinking, &trace_tools).await;
                }
                Err(e) => tracing::error!("[agent] run_simple_chat: 序列化 raw_messages_json 失败：{e}"),
            }
            if let Some(sid) = &cfg.session_id {
                crate::agent::engine::round_compactor::bump_session_turns(app, sid).await;
                crate::agent::engine::round_compactor::trigger_background_compaction(app, cfg, sid).await;
            }
        }
    }
}

/// 组装一次任务的完整工具注册表（台账 S6 收敛点）。
///
/// 原生 + 知识库 + MCP + 本地插件 + Host 五路统一在此注册——`run_task` /
/// 分支规划（commands）/ squad 成员规划（orchestrator）三处共用，注册链单一事实源：
/// 新增工具族只改这里，注册结果经 `ToolRegistry::planner_digest()` 自动进入规划器
/// 能力大纲（提示与能力同源，不再人工双维护）。
/// 每次调用产出全新 `ToolRegistry`，per-run 隔离语义不变。
pub fn build_full_registry(app: &AppHandle, cfg: &AgentRuntimeConfig) -> ToolRegistry {
    let mut base = ToolRegistry::new();
    // 沙箱模式下不注册 execute_command（宿主 shell），能力层与提示层保持一致
    native::register_native_tools(&mut base, app, cfg.allow_sandbox, &cfg.memory_mode);
    // 知识库检索工具（K2）：仅在绑定了知识库时注册（提示与能力同源）
    native::register_kb_search_tool(&mut base, app, cfg.kb_ids.clone());
    // MCP：按 mcp_id 分组，逐 server 注册（复用现有 mcp::call_mcp_tool 透传）
    let mut by_server: std::collections::BTreeMap<
        String,
        Vec<crate::agent::plugins::mcp_adapter::MountedMcpTool>,
    > = Default::default();
    for t in &cfg.mcp_tools {
        by_server.entry(t.mcp_id.clone()).or_default().push(t.clone());
    }
    for (server, tools) in by_server {
        crate::agent::plugins::mcp_adapter::register_mcp_into(&mut base, &server, tools);
    }
    // 本地插件（P2）：cfg.plugin_tools 非空时注册为 custom__<identifier> 工具；
    // 为空时零影响（register_plugins_into 对空切片不做事）。
    crate::agent::plugins::plugin_adapter::register_plugins_into(&mut base, app, &cfg.plugin_tools);
    // 服务器托管（Host）：绑定非空时注册 host__* 工具族（12 个，HostAuthz 独立授权域）。
    crate::host::register_host_tools(&mut base, app, Arc::new(cfg.server_bindings.clone()));
    base
}

/// 单轮工具执行结果统计（供连续错误熔断判定）。
pub(crate) struct ToolRoundStats {
    pub had_success: bool,
    pub had_error: bool,
    /// 本轮最后一个失败工具的错误文本（供恢复面板回显真实受阻原因）。
    pub last_error: Option<String>,
    /// 本轮最后一个失败工具的命令文本（沙箱 code / execute_command 的 command / 路径类字段），
    /// 供 `classify_tier` 风险词匹配（命中 package-lock.json / /etc/ 等升档 B）。
    pub last_failed_command: Option<String>,
    /// 本轮文件变更类工具实际触碰过的路径（write/edit/delete/move 的 path 去重），
    /// 供 `run_subtask` 聚合为 `SubTaskOutput.changed_files`，驱动接管面板「已改文件」区（2b-2）。
    pub changed_files: std::collections::HashSet<String>,
    /// 本轮文件读取类工具实际读过的路径（read_file 的 path 去重），
    /// 供 `run_subtask` 聚合为 `SubTaskOutput.read_files`，阶段二图驱动写 `Read` 边（记录「哪步读了哪些文件」）。
    pub read_files: std::collections::HashSet<String>,
}

/// 工具「操作类型」与文件变更/读取判定已声明式化（台账 S6 进阶 / D1 第一步）：
/// 见 `tools::ToolBehavior` 与各工具 impl 的 `behavior()` 覆写；
/// 旧 `tool_op` / `is_file_mutating` / `is_file_reading` 叶子名匹配函数已删除。

/// 从工具入参提取「目标路径 / 对象」：优先 path，其次 file/source/url/command。
fn tool_path(args: &Value) -> Option<String> {
    for k in ["path", "file", "source", "from", "url", "command"] {
        if let Some(s) = args.get(k).and_then(|v| v.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// 从失败工具入参提取「命令文本」：沙箱 `code` > `command` > 路径类字段 > 整段 args（截断），
/// 供 `classify_tier` 风险词匹配（如 `package-lock.json` / `/etc/` 命中升档 B）。
/// 优先取真正会被执行的命令体（`code` / `command`），避免把整段 JSON 参数灌进风险匹配。
fn tool_command(args: &Value) -> Option<String> {
    for k in ["code", "command"] {
        if let Some(s) = args.get(k).and_then(|v| v.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    if let Some(p) = tool_path(args) {
        return Some(p);
    }
    let full = serde_json::to_string(args).unwrap_or_default();
    // 字符安全截断（不能用字节下标：中文多字节字符切在边界内会 panic，
    // 实测 anchor_memory 的中文 args 触发 tokio worker panic → 任务静默卡死）。
    if full.chars().count() > 800 {
        Some(format!("{}…", full.chars().take(800).collect::<String>()))
    } else {
        Some(full)
    }
}

/// 精确行级 diff（LCS）：返回 (新增行数, 删除行数)。
/// 规模保护：任一侧超过 4000 行时退化为「行数差」，避免 O(n*m) DP 抖动。
fn diff_line_counts(before: Option<&str>, after: Option<&str>) -> (u32, u32) {
    let b: Vec<&str> = before.map(|s| s.lines().collect()).unwrap_or_default();
    let a: Vec<&str> = after.map(|s| s.lines().collect()).unwrap_or_default();
    if b.is_empty() && a.is_empty() {
        return (0, 0);
    }
    if b.len() > 4000 || a.len() > 4000 {
        return (
            a.len().saturating_sub(b.len()) as u32,
            b.len().saturating_sub(a.len()) as u32,
        );
    }
    let n = b.len();
    let m = a.len();
    // dp[i][j] = b[i..] 与 a[j..] 的 LCS 长度
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if b[i] == a[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let lcs = dp[0][0];
    ((m as u32).saturating_sub(lcs), (n as u32).saturating_sub(lcs))
}

/// 执行一轮 LLM 返回的全部 tool_calls：把 assistant 消息与所有工具结果按序压入 messages。
/// `run_task`（遗留全局循环）与 `pipeline`（微 ReAct 子任务）共用，避免两份逻辑漂移。
///
/// 固定环节：参数 JSON 自愈回灌（ParseError）→ 注册表查找 → 敏感工具审批挂起
/// → 执行 → `truncate_tool_output(15000)` 物理截断 → 推送 tool_started/finished 事件。
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip_all)]
pub(crate) async fn run_tool_calls_round(
    app: &AppHandle,
    registry: &ToolRegistry,
    ctx: &ToolContext,
    approval: &ApprovalManager,
    cfg: &AgentRuntimeConfig,
    grants: Option<&crate::agent::engine::policy::ApprovalGrants>,
    messages: &mut Vec<Value>,
    outcome: &StreamOutcome,
    // 当前子任务步骤序号：用于把工具调用精确归属到对应步骤卡片（前端按 step 展示工具调用列表）。
    current_step: usize,
) -> ToolRoundStats {
    messages.push(json!({
        "role": "assistant",
        "content": outcome.content,
        "tool_calls": outcome.tool_calls.clone()
    }));

    let mut iter_had_error = false;
    let mut iter_had_success = false;
    let mut last_err: Option<String> = None;
    let mut last_failed_command: Option<String> = None;
    let mut iter_changed_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut iter_read_files: std::collections::HashSet<String> = std::collections::HashSet::new();

    for tc in &outcome.tool_calls {
        let (call_id, tool_name, args) = match parse_tool_call(tc) {
            ParseOutcome::Ready { call_id, name, args } => (call_id, name, args),
            ParseOutcome::ParseError { call_id, name, error } => {
                // 幻觉自愈：把 JSON 解析错误作为 ToolResult 回传，强制模型下一轮纠错。
                tracing::error!(
                    "[agent] tool_round: 工具参数 JSON 解析失败 name={} err={}",
                    name,
                    clip(&error, 300),
                );
                iter_had_error = true;
                events::emit_error(app, &format!("工具参数 JSON 解析失败：{name}"));
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": format!("JSON parse error: {error}. Please strictly check your escape characters and output valid JSON arguments.")
                }));
                continue;
            }
            ParseOutcome::Skip => {
                tracing::warn!(
                    "[agent] tool_round: 工具调用字段缺失，跳过 raw_tool_call={}",
                    clip(&tc.to_string(), 500),
                );
                events::emit_error(app, "工具调用字段缺失，跳过");
                continue;
            }
        };

        let tool = match registry.get(&tool_name) {
            Some(t) => t,
            None => {
                tracing::error!("[agent] tool_round: 注册表找不到模型请求的工具 name={}", tool_name);
                events::emit_error(app, &format!("未知工具：{tool_name}"));
                continue;
            }
        };
        // 台账 S6 进阶：声明式行为元数据（op 动词 / 文件变更 / 文件读取），
        // 与工具实现同处一地，替代旧叶子名散落匹配。
        let beh = tool.behavior();

        tracing::info!(
            "[agent] tool_round: 执行工具 {} (call_id={}) 参数={}",
            tool_name,
            call_id,
            clip(&serde_json::to_string(&args).unwrap_or_default(), 800),
        );

        let step_id = call_id.clone();
        // Host 授权域分流（设计稿 §7.9）：host__* 走 HostAuthz（独立授权域）——
        // 绝不触碰本地 policy.rs 信号与 grants。三态：Proceed / Denied / NeedApproval。
        let mut host_denied: Option<String> = None;
        let mut host_sensitive = false;
        let mut host_approval_req: Option<ApprovalRequest> = None;
        if tool.authz_domain() == crate::agent::engine::tools::AuthzDomain::Host {
            match crate::host::authz::gate_tool_call(
                app,
                &cfg.agent_id,
                cfg.session_id.as_deref(),
                cfg.round_id.as_deref().unwrap_or(""),
                &tool_name,
                &args,
            )
            .await
            {
                crate::host::authz::GateOutcome::Proceed(_) => {}
                crate::host::authz::GateOutcome::Denied(reason) => host_denied = Some(reason),
                crate::host::authz::GateOutcome::NeedApproval(req) => {
                    host_sensitive = true;
                    host_approval_req = Some(req);
                }
            }
        }

        let static_sensitive = tool.check_permission(&args) == PermissionLevel::RequireApproval;
        // 15007 边审批策略：对一切可提取「操作 × 目标」的工具评估（含静态敏感工具）。
        // 真机教训（2026-09-17 首轮验收）：write_file 属静态敏感工具，若仅「静态未拦」才评估，
        // 纯 auto 模式（auto_exec=true）下写 .env / .github/workflows 仍会静默通过（盲区未堵），
        // 且 never 留痕、计划批准写入的 grants 对静态敏感工具全部失效。
        //  - grants 命中（计划内已授权 / 已「记住」）→ 放行（静态敏感也不再弹卡，闸 1 语义）；
        //  - never（全自动）模式 → 不弹卡，仅状态栏留痕（方案 A，零打断）；
        //  - 其余模式命中 → 硬门禁弹审批卡（无视 auto_tool_exec_mode，危险操作必须过目）。
        // 插件 custom__* 无边映射，天然不受策略影响（恒审批语义保留）。
        let mut sensitive = static_sensitive || host_sensitive;
        let mut policy_approval: Option<(String, String)> = None; // (命中原因, grant_key)
        let mut policy_granted = false; // grants 命中：本信号已授权，静态敏感亦放行
        // host__* 已走 HostAuthz（上方分流），跳过本地策略评估与本地审批分支。
        if host_denied.is_none() && host_approval_req.is_none() {
        {
            if let Some(op_str) = beh.op {
                if let Some(edge) = crate::agent::engine::policy::EdgeOp::from_op_str(op_str) {
                    let targets = crate::agent::engine::policy::edge_targets(edge, &args);
                    // grants=None（小分队等无授权集场景）→ 策略不适用，维持旧行为
                    if let Some(grants) = grants {
                        if let Some(hit) = crate::agent::engine::policy::evaluate_edge(
                            edge,
                            &targets,
                            cfg.workspace.as_deref(),
                        ) {
                            let key = hit.grant_key();
                            if grants.contains(&key) {
                                // 计划批准 / 已「记住」→ 本信号已授权，执行期不再打扰（闸 1/闸 3）
                                policy_granted = true;
                            } else {
                                let reason = format!(
                                    "命中危险信号 [{}]：{}（目标：{}）",
                                    hit.category, hit.pattern, hit.target
                                );
                                if cfg.plan_auto_approve_mode.as_str() == "never" {
                                    // 只留痕，不置 sensitive——避免 never 模式经静态门禁弹卡，破坏零打断语义
                                    tracing::info!(
                                        "[agent] tool_round: 策略命中（never 模式不打断，留痕）：{}",
                                        reason
                                    );
                                    events::emit_status(
                                        app,
                                        &format!(
                                            "⚠ 敏感操作（全自动模式不打断，已留痕）：{}",
                                            reason
                                        ),
                                    );
                                } else {
                                    tracing::info!(
                                        "[agent] tool_round: 策略命中（弹审批）：{}", reason
                                    );
                                    sensitive = true;
                                    policy_approval = Some((reason, key));
                                }
                            }
                        }
                    }
                }
            }
        }
        } // host 分流守卫闭合
        // 一行式工具行元数据：操作类型 + 目标路径（执行前即可确定；行数在执行后 diff 得出）。
        let op = beh.op;
        let path_arg = tool_path(&args);
        events::emit_tool_started(app, &ToolStep {
            call_id: step_id.clone(),
            tool_name: tool_name.clone(),
            status: "running".into(),
            sensitive,
            args: Some(serde_json::to_string(&args).unwrap_or_default()),
            result: None,
            duration_ms: None,
            created_at: now_ms(),
            step: Some(current_step),
            op: op.map(|s| s.to_string()),
            path: path_arg.clone(),
            lines_added: None,
            lines_removed: None,
        });

        // 接管补充指示（审批 Takeover 时捕获，执行后注入下一轮 user 消息）
        let mut takeover_guidance: Option<String> = None;
        tracing::info!(
            "[agent] tool_round: 审批门禁检查 agent={} tool={} sensitive={} auto_exec={}",
            cfg.agent_id, tool_name, sensitive, cfg.auto_tool_exec_mode,
        );
        // Host 拒绝：结构化原因直达 LLM（不计入熔断连续错误，属「用户/策略拒绝」语义）。
        if let Some(reason) = host_denied {
            events::emit_tool_finished(app, &ToolStep {
                call_id: step_id.clone(),
                tool_name: tool_name.clone(),
                status: "failed".into(),
                sensitive,
                args: Some(serde_json::to_string(&args).unwrap_or_default()),
                result: Some(reason.clone()),
                duration_ms: None,
                created_at: now_ms(),
                step: Some(current_step),
                op: op.map(|s| s.to_string()),
                path: path_arg.clone(),
                lines_added: None,
                lines_removed: None,
            });
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": reason
            }));
            continue;
        }

        // Host 挂起：弹 host 审批卡（ApprovalManager 同通道，前端按 domain=host 分型渲染）。
        if let Some(req) = host_approval_req.take() {
            events::emit_awaiting_approval(app, &req);
            let approval_id = req.approval_id.clone();
            let rx = approval.suspend(req).await;
            let host_outcome: ApprovalOutcome = match timeout(
                Duration::from_secs(APPROVAL_TIMEOUT_SECS),
                rx,
            )
            .await
            {
                Ok(Ok(o)) => o,
                Ok(Err(_)) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome::Skip
                }
                Err(_) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome::Skip
                }
            };
            tracing::info!("[agent] tool_round: Host 审批完成 approval_id={} outcome={:?}", approval_id, host_outcome);
            match &host_outcome {
                ApprovalOutcome::Approve => {}
                ApprovalOutcome::Takeover(g) => takeover_guidance = Some(g.clone()),
                ApprovalOutcome::Skip => {
                    events::emit_tool_finished(app, &ToolStep {
                        call_id: step_id.clone(),
                        tool_name: tool_name.clone(),
                        status: "failed".into(),
                        sensitive,
                        args: Some(serde_json::to_string(&args).unwrap_or_default()),
                        result: Some("用户跳过执行（未授权）".into()),
                        duration_ms: None,
                        created_at: now_ms(),
                        step: Some(current_step),
                        op: op.map(|s| s.to_string()),
                        path: path_arg.clone(),
                        lines_added: None,
                        lines_removed: None,
                    });
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": "用户跳过执行（未授权），按原计划继续后续步骤"
                    }));
                    continue;
                }
            }
        }

        if let Some((reason, grant_key)) = policy_approval {
            // 策略命中（非 never 模式）：硬门禁审批——无视 auto_tool_exec_mode，危险操作必须过目。
            let approval_id = format!("ap-{}-{}", cfg.agent_id, step_id);
            let req = ApprovalRequest {
                approval_id: approval_id.clone(),
                tool_name: tool_name.clone(),
                description: format!("智能体请求执行命中风险策略的操作：{}", tool_name),
                args: serde_json::to_string(&args).unwrap_or_default(),
                kind: detect_kind(&tool_name, &args),
                hint: Some("该操作命中敏感路径特征。拒绝可填写原因引导纠偏。".into()),
                reason: Some(reason),
                grant_key: Some(grant_key.clone()),
                domain: None,
                host_meta: None,
                run_id: cfg.round_id.clone(),
            };
            events::emit_awaiting_approval(app, &req);
            let rx = approval.suspend(req).await;
            // 超时/停止与既有语义一致：走 Skip 分支（详见静态敏感块注释）。
            let approval_outcome: ApprovalOutcome = match timeout(
                Duration::from_secs(APPROVAL_TIMEOUT_SECS),
                rx,
            )
            .await
            {
                Ok(Ok(o)) => o,
                Ok(Err(_)) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome::Skip
                }
                Err(_) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome::Skip
                }
            };
            tracing::info!(
                "[agent] tool_round: 策略审批完成 approval_id={} outcome={:?}",
                approval_id, approval_outcome,
            );
            match &approval_outcome {
                // grants 写入统一由 submit_approval_decision 按「记住」勾选处理（skip 不记）；
                // 此处不再无条件写，避免勾选被架空（取消勾选后同信号仍应再次询问）。
                ApprovalOutcome::Approve => {}
                ApprovalOutcome::Takeover(g) => {
                    takeover_guidance = Some(g.clone());
                }
                ApprovalOutcome::Skip => {
                    events::emit_tool_finished(app, &ToolStep {
                        call_id: step_id.clone(),
                        tool_name: tool_name.clone(),
                        status: "failed".into(),
                        sensitive,
                        args: Some(serde_json::to_string(&args).unwrap_or_default()),
                        result: Some("用户跳过执行（未授权）".into()),
                        duration_ms: None,
                        created_at: now_ms(),
                        step: Some(current_step),
                        op: op.map(|s| s.to_string()),
                        path: path_arg.clone(),
                        lines_added: None,
                        lines_removed: None,
                    });
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": "用户跳过执行（未授权），按原计划继续后续步骤"
                    }));
                    continue;
                }
            }
        } else if sensitive && !cfg.auto_tool_exec_mode && !policy_granted && host_denied.is_none() && host_approval_req.is_none() {
            let approval_id = format!("ap-{}-{}", cfg.agent_id, step_id);
            let req = ApprovalRequest {
                approval_id: approval_id.clone(),
                tool_name: tool_name.clone(),
                description: format!("智能体请求执行敏感操作：{}", tool_name),
                args: serde_json::to_string(&args).unwrap_or_default(),
                kind: detect_kind(&tool_name, &args),
                hint: Some("请在弹窗中允许或拒绝（拒绝可填写原因引导纠偏）".into()),
                reason: None,
                grant_key: None,
                domain: None,
                host_meta: None,
                run_id: cfg.round_id.clone(),
            };
            events::emit_awaiting_approval(app, &req);
            let rx = approval.suspend(req).await;
            // 审批挂起设独立超时，避免用户不点弹窗导致任务永久挂起。
            // 超时与「停止」(`cancel_all` drop Sender) 都走拒绝分支，不新增状态通路。
            // 三态：`Ok(Ok)`=前端决策；`Ok(Err)`=Sender 被 drop（停止触发，通道关闭）；
            // `Err`=超时（清理 pending 条目后自动拒绝）。
            let approval_outcome: ApprovalOutcome = match timeout(
                Duration::from_secs(APPROVAL_TIMEOUT_SECS),
                rx,
            )
            .await
            {
                Ok(Ok(o)) => o,
                Ok(Err(_)) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome::Skip
                }
                Err(_) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome::Skip
                }
            };
            tracing::info!(
                "[agent] tool_round: 审批完成 approval_id={} outcome={:?}",
                approval_id, approval_outcome,
            );
            // 审批决策分流：批准/接管→继续执行；跳过→记 skipped 并继续后续步骤。
            match &approval_outcome {
                ApprovalOutcome::Approve => {}
                ApprovalOutcome::Takeover(g) => {
                    takeover_guidance = Some(g.clone());
                }
                ApprovalOutcome::Skip => {
                    events::emit_tool_finished(app, &ToolStep {
                        call_id: step_id.clone(),
                        tool_name: tool_name.clone(),
                        status: "failed".into(),
                        sensitive,
                        args: Some(serde_json::to_string(&args).unwrap_or_default()),
                        result: Some("用户跳过执行（未授权）".into()),
                        duration_ms: None,
                        created_at: now_ms(),
                        step: Some(current_step),
                        op: op.map(|s| s.to_string()),
                        path: path_arg.clone(),
                        lines_added: None,
                        lines_removed: None,
                    });
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": "用户跳过执行（未授权），按原计划继续后续步骤"
                    }));
                    continue;
                }
            }
        }

        // 文件变更类工具：执行前快照原内容，执行后对比得出精确增删行数（前端工具行 +N/-M）。
        let before_snapshot: Option<String> = if beh.file_mutating {
            path_arg
                .as_deref()
                .and_then(|p| crate::agent::engine::tools::PathGuard::check(p, ctx).ok())
                .and_then(|abs| std::fs::read_to_string(abs).ok())
        } else {
            None
        };
        // 执行工具
        let t0 = Instant::now();
        let result = tool.execute(args.clone(), ctx).await;
        let (status, result_text) = match &result {
            Ok(s) => {
                iter_had_success = true;
                ("success".into(), truncate_tool_output(s.as_str()))
            }
            Err(ToolError::InvalidArgs(m)) => {
                // InvalidArgs 计入连续错误序列（死循环高风险）。
                iter_had_error = true;
                let t = truncate_tool_output(m.as_str());
                last_err = Some(t.clone());
                last_failed_command = tool_command(&args);
                ("failed".into(), t)
            }
            Err(ToolError::ExecutionFailed(m)) | Err(ToolError::PermissionDenied(m)) => {
                // 真实执行失败 / 权限被拒：同样计入连续错误序列，驱动 pipeline 熔断。
                // 注：审批「用户拒绝」走上方 L573 的 `continue`，不经过此分支，不会被误熔断。
                iter_had_error = true;
                let t = truncate_tool_output(m.as_str());
                last_err = Some(t.clone());
                last_failed_command = tool_command(&args);
                ("failed".into(), t)
            }
        };
        // 精确 diff：文件变更类工具对比执行前后快照，得出 +N/-M（后端 LCS，非前端估算）。
        let (lines_added, lines_removed) = if beh.file_mutating {
            let after_snapshot = path_arg
                .as_deref()
                .and_then(|p| crate::agent::engine::tools::PathGuard::check(p, ctx).ok())
                .and_then(|abs| std::fs::read_to_string(abs).ok());
            let (a, r) = diff_line_counts(before_snapshot.as_deref(), after_snapshot.as_deref());
            (Some(a), Some(r))
        } else {
            (None, None)
        };
        // 文件变更类工具：收集实际触碰过的路径，供接管面板「已改文件」区展示（2b-2）。
        if beh.file_mutating {
            if let Some(p) = &path_arg {
                iter_changed_files.insert(p.clone());
            }
        }
        // 文件读取类工具（read_file）：执行成功后收集实际读过的路径，阶段二图驱动写 `Read` 边。
        if beh.file_reading && result.is_ok() {
            if let Some(p) = &path_arg {
                iter_read_files.insert(p.clone());
            }
        }
        // 工具输出流现由 `ctx.run_outcomes`（含 stdout 与退出码）统一收集，
        // 供 `run_subtask` 传给校验器（command_succeeded / stdout_contains），此处不再重复聚合。
        events::emit_tool_finished(app, &ToolStep {
            call_id: step_id.clone(),
            tool_name: tool_name.clone(),
            status,
            sensitive,
            args: Some(serde_json::to_string(&args).unwrap_or_default()),
            result: Some(result_text.clone()),
            duration_ms: Some(t0.elapsed().as_millis() as u64),
            created_at: now_ms(),
            step: Some(current_step),
            op: op.map(|s| s.to_string()),
            path: path_arg.clone(),
            lines_added,
            lines_removed,
        });
        tracing::info!(
            "[agent] tool_round[{}]: {} ok={} 耗时={}ms step={} 结果={}",
            call_id,
            tool_name,
            result.is_ok(),
            t0.elapsed().as_millis(),
            current_step,
            clip(&result_text, 400),
        );
        messages.push(json!({
            "role": "tool",
            "tool_call_id": call_id,
            "content": result_text
        }));
        // 接管并继续：把用户补充指示注入下一轮 user 消息，引导子任务重跑方向。
        if let Some(g) = &takeover_guidance {
            messages.push(json!({
                "role": "user",
                "content": format!("（用户接管并补充指示：{}）", g)
            }));
        }
    }

    ToolRoundStats {
        had_success: iter_had_success,
        had_error: iter_had_error,
        last_error: last_err,
        last_failed_command,
        changed_files: iter_changed_files,
        read_files: iter_read_files,
    }
}

/* ----------------------------- LLM 调用 ----------------------------- */

/// 提取响应字段的规范化文本：字符串直接用；OpenAI 多模态数组（[{type:"text",text:...}]）拼接全部 text；
/// 对象壳（{content:...}/{text:...}）取内部文本。解决 gemma4 网关 content/reasoning 非标准形态解析为空。
fn extract_message_text(v: Option<&Value>) -> String {
    let Some(v) = v else {
        return String::new();
    };
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .filter_map(|p| {
                p.get("text")
                    .and_then(|t| t.as_str())
                    .or_else(|| p.get("content").and_then(|t| t.as_str()))
            })
            .collect::<Vec<_>>()
            .join("");
    }
    if let Some(obj) = v.as_object() {
        for key in ["content", "text", "summary"] {
            if let Some(s) = obj.get(key).and_then(|t| t.as_str()) {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// 描述 JSON 值形态（诊断日志用）：类型 + 文本长度 / 键名。
fn describe_value_shape(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(s) => format!("string({}字符)", s.chars().count()),
        Value::Array(a) => format!("array({}项)", a.len()),
        Value::Object(o) => format!("object(keys={:?})", o.keys().collect::<Vec<_>>()),
        other => format!("其他={other}"),
    }
}

/// 非流式 LLM 调用超时上限（筑基支柱① 终态铁律）。
///
/// 背景（2026-09-22 定位）：`call_llm` 原**无任何超时**——模型/网关不返回时 future 永不 resolve，
/// 导致 `run_task` 永不结束、`RunningGuard` 永不 drop、**运行锁永占**。这正是历史「3 run 永久挂死」
/// 的机制性根因（经实测复核：并非 COMPOSITE 逻辑缺陷，而是单纯缺少兜底）。
/// 上层 `planner.rs:148` / `pipeline.rs:1306` 的 Err 分支本已正确容错（降级 / 标记步骤失败），
/// 却因无限等待而永远触发不到——本超时让**既有容错真正生效**，属最小精准修复。
///
/// 默认超时秒数：实测最坏单次静默 105s（本地部署模型资源紧张时），留约 1.7x 余量。
/// 判据按「无产出静默时长」而非总耗时（慢 ≠ 死，见筑基清单超时阈值铁律）。
const DEFAULT_LLM_TIMEOUT_SECS: u64 = 180;
/// 默认打点间隔秒数。
const DEFAULT_LLM_TICK_SECS: u64 = 30;

/// 实际超时上限：可用环境变量 `WD_LLM_TIMEOUT_SECS` 覆盖（>0 生效）。
/// 用途：① 本地部署的慢模型（如 ollama 资源紧张）可调大；② 自测故障注入时调小（如 5s）以快速验证超时分支。
fn llm_call_timeout() -> Duration {
    std::env::var("WD_LLM_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_TIMEOUT_SECS))
}

/// 实际打点间隔：可用环境变量 `WD_LLM_TICK_SECS` 覆盖（>0 生效）。自测时调小以便快速观测。
fn llm_wait_tick() -> Duration {
    std::env::var("WD_LLM_TICK_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_TICK_SECS))
}

/// 流式调用默认总墙钟上限（10 分钟）：生成超长内容时总时长也必须有上限，防止失控。
const DEFAULT_LLM_STREAM_TOTAL_SECS: u64 = 600;
/// 流式调用默认单 chunk 静默上限（120s）：SSE 流中途这么久没有任何新数据即判定断流。
/// 需大于本地大模型的 prefill（长 prompt 预填充）耗时，否则会误杀正常调用。
const DEFAULT_LLM_CHUNK_TIMEOUT_SECS: u64 = 120;

/// 流式总墙钟上限：可用环境变量 `WD_LLM_STREAM_TOTAL_SECS` 覆盖（>0 生效）。
fn llm_stream_total_timeout() -> Duration {
    std::env::var("WD_LLM_STREAM_TOTAL_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_STREAM_TOTAL_SECS))
}

/// 流式单 chunk 静默上限：可用环境变量 `WD_LLM_CHUNK_TIMEOUT_SECS` 覆盖（>0 生效）。
/// 2026-09-22 实测暴露：本地模型大生成量任务下，SSE 在收到 HTTP 200 后**流静默 226s+ 无任何 chunk**，
/// 而原 `stream.next().await` 裸等待 → run 永不终止、锁永占。本超时是其兜底。
fn llm_stream_chunk_timeout() -> Duration {
    std::env::var("WD_LLM_CHUNK_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_CHUNK_TIMEOUT_SECS))
}

/// run 级总墙钟上限（默认 30 分钟）：**任何一次 run 都必须在此时间内到达终态**。
///
/// 这是「失败收尾」验收口径的第③层。调用级超时（call_llm / call_llm_stream）只堵住单点，
/// 本层兜住「多步累积过长」或「某条未被调用级超时覆盖的路径挂起」。超时后强制 emit_task_error，
/// 且 `RunningGuard` 随作用域结束 drop → **锁必然释放**。
///
/// 2026-09-23 L2 生态测评（34 用例）实证：600s 预算误杀 12/34 用例——多文件项目 / 多源数据 /
/// Skill+KB 全链路在并发 ≥2 时「正常多步累积」即撞墙（A-M2 串行都要 473s）。本层是**防挂死
/// 兜底**，不应兼做业务 SLA：默认上调 1800s。SIMPLE_CHAT 天然被调用级超时（180s × 有界轮次）
/// 约束，无需更紧的 run 预算——否则层级倒挂（run 预算 < 调用级超时）会先杀合法调用。
const DEFAULT_RUN_MAX_SECS: u64 = 1800;

/// 预算软窗口：run 预算到期前该时长先置位取消标志，复用既有取消基建让流水线
/// 「停止发起新步骤、等在途调用收尾」；到点才由 timeout 硬兜底（内层 future 被 drop）。
pub(crate) const RUN_SOFT_WINDOW: Duration = Duration::from_secs(30);

/// 可用环境变量 `WD_RUN_MAX_SECS` 覆盖（>0 生效）。慢模型环境可调大。
pub(crate) fn run_wall_clock_limit() -> Duration {
    std::env::var("WD_RUN_MAX_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_RUN_MAX_SECS))
}

/// 心跳停止守卫：函数任意出口（正常返回 / Err / `?` 提前返回）自动终止打点协程，不留悬挂任务。
struct HeartbeatGuard(Arc<AtomicBool>);
impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// LLM 调用限流（D' 限流，2026-09-24）：`WD_LLM_RPM` 设每分钟请求上限（按模型名分别
/// 计数；0/未设置 = 不限流）。实现为最小调用间隔节流：调用前等待至距上次同模型调用
/// ≥ 60/RPM 秒。锁不跨 await（等待在锁外 sleep）。桌面单用户场景足够。
static LLM_RATE_LIMIT: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::Mutex::new(None);

async fn llm_rate_limit_wait(model: &str) {
    let rpm: u64 = std::env::var("WD_LLM_RPM")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if rpm == 0 {
        return;
    }
    let min_interval = std::time::Duration::from_millis(60_000 / rpm.max(1));
    loop {
        let wait = {
            let mut guard = LLM_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
            let map = guard.get_or_insert_with(std::collections::HashMap::new);
            let now = std::time::Instant::now();
            let earliest = match map.get(model) {
                Some(t) => *t + min_interval,
                None => now,
            };
            if earliest <= now {
                map.insert(model.to_string(), now);
                None
            } else {
                Some(earliest.duration_since(now))
            }
        };
        match wait {
            Some(d) => {
                tracing::info!("[agent] LLM 限流：model={} 距下次调用还需 {:?}（WD_LLM_RPM={rpm}）", model, d);
                tokio::time::sleep(d).await;
            }
            None => return,
        }
    }
}

/// 用户取消哨兵错误（P0-4 洞一）：与流式侧 `call_llm_stream_once` 同串（含「取消」），
/// 上层重试逻辑 `e.contains("取消")` 可识别为不可重试、直接透传。
fn user_cancelled_err() -> String {
    "任务已被用户取消".to_string()
}

/// 与取消标志竞争执行 future（P0-4 洞一）：取消置位即短路返回，不再等待底层 I/O。
/// 轮询粒度 200ms——LLM 调用为秒级时长，粒度足够且开销可忽略；`None` 语义直接 await（零开销），
/// 兼容无取消语义的调用方（squad / 后台提炼）。
async fn race_cancel<F, T>(cancel: Option<&Arc<AtomicBool>>, fut: F) -> Result<T, ()>
where
    F: Future<Output = T>,
{
    match cancel {
        None => Ok(fut.await),
        Some(flag) => {
            tokio::pin!(fut);
            loop {
                if flag.load(Ordering::SeqCst) {
                    return Err(());
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                    out = &mut fut => return Ok(out),
                }
            }
        }
    }
}

pub(crate) async fn call_llm(
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(Value, (u64, u64)), String> {
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }
    // 限流等待可取消：限流窗最长 60s/rpm，取消时立即短路（此前白等且占用等待窗）。
    race_cancel(cancel, llm_rate_limit_wait(&cfg.llm_model_name))
        .await
        .map_err(|_| {
            tracing::info!("[agent] call_llm: 用户取消（限流等待中）——立即终止");
            user_cancelled_err()
        })?;

    tracing::info!(
        "[agent] call_llm: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let request_started = Instant::now();
    let client = crate::net::apply_proxy(reqwest::Client::builder(), &cfg.network_proxy)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = normalize_chat_url(&cfg.llm_base_url);

    // 观测打点（支柱③）：等待期间每 LLM_WAIT_TICK 输出一条「仍在进行中」。
    // 非流式调用在等待期间原是零输出，长静默会被误判为挂死——打点后慢与死在日志上可区分。
    // `_hb_guard` 借 Drop 在任意出口终止协程（含 `?` 提前返回），不留悬挂任务。
    let call_timeout = llm_call_timeout();
    let wait_tick = llm_wait_tick();
    let hb_stop = Arc::new(AtomicBool::new(false));
    let _hb_guard = {
        let flag = hb_stop.clone();
        let hb_model = cfg.llm_model_name.clone();
        let hb_url = url.clone();
        tokio::spawn(async move {
            let mut waited = 0u64;
            loop {
                tokio::time::sleep(wait_tick).await;
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                waited += wait_tick.as_secs();
                tracing::info!(
                    "[agent] call_llm: 等待响应已 {}s（model={} url={}）——仍在进行中，非挂死",
                    waited,
                    hb_model,
                    hb_url
                );
            }
        });
        HeartbeatGuard(hb_stop)
    };

    let mut body = json!({
        "model": cfg.llm_model_name,
        "messages": messages,
        "stream": false,
    });
    // 注入智能体私有参数副本（temperature / max_tokens ...）
    if let Some(obj) = cfg.llm_config.as_object() {
        for (k, v) in obj {
            if k != "model" && k != "messages" && k != "stream" {
                body[k] = v.clone();
            }
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    // 兼容多后端网关（如 gmi-serving）：部分网关的 OpenAI Chat 模型要求
    // `reasoning` 为字典而非布尔。用户在前端把 reasoning 配成 true/false 时，
    // 这里归一化为网关可接受的形态（true→{} 开启默认推理；false→移除该字段）。
    if let Some(obj) = body.as_object_mut() {
        let action = match obj.get("reasoning") {
            Some(v) if v.is_boolean() => Some(v.as_bool() == Some(true)),
            _ => None,
        };
        if let Some(enabled) = action {
            if enabled {
                obj.insert("reasoning".into(), json!({}));
                tracing::info!("[agent] call_llm: reasoning=true 归一化为 {{}}（网关要求字典）");
            } else {
                obj.remove("reasoning");
                tracing::info!("[agent] call_llm: reasoning=false 已移除");
            }
        }
    }

    let body_preview = serde_json::to_string(&sanitize_for_log(&body)).unwrap_or_default();
    tracing::info!(
        "[agent] call_llm: 请求体预览（已脱敏/截断）={} ",
        clip(&body_preview, 1000)
    );

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }

    // 超时兜底（支柱① 终态铁律）：模型/网关不返回时强制结束等待。
    // 无此超时时 future 永不 resolve → run_task 永不结束 → RunningGuard 永不 drop → 运行锁永占。
    // 加超时后返回 Err，上层 planner.rs / pipeline.rs 的既有 Err 容错（降级 / 标记失败）得以真正生效。
    let resp = race_cancel(cancel, timeout(call_timeout, req.send()))
        .await
        .map_err(|_| {
            tracing::info!("[agent] call_llm: 用户取消——终止等待响应（不产生计费尾单）");
            user_cancelled_err()
        })?
        .map_err(|_| {
            tracing::warn!(
                "[agent] call_llm: 等待响应超时（{}s，model={}）——终止等待，防止任务永不结束",
                call_timeout.as_secs(),
                cfg.llm_model_name
            );
            format!(
                "LLM 调用超时：{}s 内未收到响应（model={}）",
                call_timeout.as_secs(),
                cfg.llm_model_name
            )
        })?
        .map_err(|e| {
            tracing::info!(
                "[agent] call_llm: 请求失败（耗时={}ms）：{}",
                request_started.elapsed().as_millis(),
                e
            );
            format!("请求失败：{e}")
        })?;
    // send 完成后立即复查取消（竞态窗口）：响应已到但未读 body，取消则丢弃（不再产生读取计费）。
    if let Some(f) = cancel {
        if f.load(Ordering::SeqCst) {
            tracing::info!("[agent] call_llm: 用户取消（响应已到、body 未读）——丢弃响应");
            return Err(user_cancelled_err());
        }
    }
    let status = resp.status();
    tracing::info!(
        "[agent] call_llm: 收到 HTTP {}（耗时={}ms）",
        status,
        request_started.elapsed().as_millis()
    );
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let safe_text = clip(&sanitize_for_log(&Value::String(text.clone())).to_string(), 5000);
        tracing::info!("[agent] call_llm: HTTP {} 错误体（已脱敏/截断）={}", status, safe_text);
        return Err(format!("HTTP {}：{}", status, clip(&text, 2000)));
    }
    // 响应体读取同样需要超时：大响应或网关慢速吐流时，读 body 阶段也可能长时间挂起。
    let data: Value = race_cancel(cancel, timeout(call_timeout, resp.json()))
        .await
        .map_err(|_| {
            tracing::info!("[agent] call_llm: 用户取消（读取响应体中）——终止");
            user_cancelled_err()
        })?
        .map_err(|_| {
            tracing::warn!(
                "[agent] call_llm: 响应体读取超时（{}s，model={}）",
                call_timeout.as_secs(),
                cfg.llm_model_name
            );
            format!(
                "LLM 响应读取超时：{}s 内未读完响应体（model={}）",
                call_timeout.as_secs(),
                cfg.llm_model_name
            )
        })?
        .map_err(|e| format!("响应解析失败：{e}"))?;
    tracing::info!(
        "[agent] call_llm: 非流式响应 JSON 大小={}字符 choices={} ",
        data.to_string().chars().count(),
        data.get("choices").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0)
    );
    // 提取真实 token 用量（prompt / completion），供会话累计展示，替代前端估算。
    let usage = data
        .get("usage")
        .and_then(|u| u.as_object())
        .and_then(|u| {
            let p = u.get("prompt_tokens").and_then(|v| v.as_u64());
            let c = u.get("completion_tokens").and_then(|v| v.as_u64());
            match (p, c) {
                (Some(p), Some(c)) => Some((p, c)),
                _ => None,
            }
        })
        .unwrap_or((0, 0));
    tracing::info!(
        "[agent] call_llm: 非流式 usage prompt={} completion={}",
        usage.0, usage.1
    );
    // 注：非流式通道（规划/提炼）不推送窗口占用——无 app 句柄且 input 量小（~1.4K），
    // 窗口压力指标以执行期流式调用为准（agent-llm-usage）。
    let mut message = data
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or_else(|| "LLM 响应缺少 choices[0].message".to_string())?;

    // reasoning 模型返空兼容（gemma4 等）：非流式响应可能把实际内容放非标准位置——
    // content 为多模态数组（[{type:"text",text:...}]）、或全落 `reasoning`/`reasoning_content`
    // 字段（字符串或对象）。统一回退：规范化提取文本，content 空时逐级回填（打 WARN 便于观察）。
    {
        let content_text = extract_message_text(message.get("content"));
        if content_text.trim().is_empty() {
            // 诊断：打印 message 字段名与 reasoning 字段形态，一次性揭示网关真实结构。
            let keys: Vec<String> = message
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let reason_ty = message.get("reasoning").map(describe_value_shape);
            let reason_c_ty = message.get("reasoning_content").map(describe_value_shape);
            tracing::warn!(
                "[agent] call_llm: content 规范化提取为空，message 字段={:?} reasoning形态={:?} reasoning_content形态={:?} message原始（截断）={}",
                keys,
                reason_ty,
                reason_c_ty,
                clip(&message.to_string(), 800)
            );
            let alt = extract_message_text(message.get("reasoning_content"))
                .trim()
                .to_string();
            let alt = if alt.is_empty() {
                extract_message_text(message.get("reasoning")).trim().to_string()
            } else {
                alt
            };
            if !alt.is_empty() {
                tracing::warn!(
                    "[agent] call_llm: 回退用 reasoning 文本作为响应内容（{}字符，reasoning 模型返空兼容）",
                    alt.chars().count()
                );
                if let Some(obj) = message.as_object_mut() {
                    obj.insert("content".into(), json!(alt));
                }
            }
        } else {
            // content 为数组等非字符串形态：规范化为字符串，避免下游 as_str() 解析为空。
            let raw = message.get("content").map(|v| v.to_string()).unwrap_or_default();
            if raw != format!("\"{}\"", content_text) {
                if let Some(obj) = message.as_object_mut() {
                    obj.insert("content".into(), json!(content_text));
                }
            }
        }
    }

    Ok((message, usage))
}

/// 流式调用的聚合结果（一轮 ReAct 的 LLM 输出）。
pub(crate) struct StreamOutcome {
    /// 模型输出正文（终态轮为回答；工具轮多为规划/分析短文，可空）。
    pub(crate) content: String,
    /// 模型推理字段（DeepSeek 风格 `reasoning` / `reasoning_content`）。
    pub(crate) reasoning: String,
    /// 标准 OpenAI 格式的 tool_calls（流式增量已按 index 归并完整）。
    pub(crate) tool_calls: Vec<Value>,
    /// 本轮 LLM 真实 token 用量（prompt / completion），取自 OpenAI 响应的 `usage`。
    /// 跨所有 ReAct 轮累计即为整轮任务的真实消耗，替代前端基于「仅首尾文本」的估算
    /// （旧估算会把 system prompt / 工具定义 / 中间工具往返全部漏掉，导致 token 严重低估）。
    pub(crate) usage: (u64, u64),
}

/// 流式调用 LLM（SSE）：聚合本轮的正文、推理与 tool_calls，返回给 ReAct 循环决策。
///
/// 每轮仅这一次 HTTP 调用（替代旧架构「非流式判断 + 流式输出」的双调用）：
///  - 正文 / 推理先缓冲，不边收边 emit —— 因为此时还不确定本轮是「终态回答」
///    还是「工具轮规划」，二者去向不同（回答气泡 vs 思考面板），由调用方决定；
///  - `delta.tool_calls` 是增量格式（首 chunk 带 id/name，后续仅带 arguments 片段），
///    按 `index` 归并为完整的标准 tool_calls；
///  - 调用方拿到空响应（正文与 tool_calls 皆空）时应回退非流式 `call_llm` 兜底。
#[tracing::instrument(skip_all)]
pub(crate) async fn call_llm_stream(
    _app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: &Arc<AtomicBool>,
    on_text: Option<&(dyn Fn(&str) + Send + Sync)>,
    on_reasoning: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> Result<StreamOutcome, String> {
    const MAX_RETRY: usize = 1;
    llm_rate_limit_wait(cfg.llm_model_name.as_str()).await;
    let mut last: Option<Result<StreamOutcome, String>> = None;
    for attempt in 0..=MAX_RETRY {
        let outcome =
            call_llm_stream_once(_app, cfg, messages, tools, cancel, on_text, on_reasoning).await;
        match outcome {
            // 用户主动取消：绝不重试，直接透传错误（「停止 / 接管」路径依赖此行为）。
            Err(e) if e.contains("取消") => return Err(e),
            // 网络 / HTTP 错误：重试一次，到上限则透传。
            Err(e) => {
                tracing::info!(
                    "[agent] call_llm_stream: 第{}次请求失败，{}",
                    attempt + 1,
                    if attempt < MAX_RETRY { "重试一次" } else { "已达上限" }
                );
                last = Some(Err(e));
                if attempt < MAX_RETRY {
                    continue;
                }
                return last.unwrap();
            }
            Ok(o) => {
                // 单次请求的真实窗口占用（2026-09-18 修正口径）：每次 LLM 请求完成即推送
                // 该次的 prompt/completion——前端「窗口占用」环据此展示（此前误用任务级
                // 累计，5 步任务的 91 万被显示成 713% 窗口）。
                if o.usage.0 > 0 {
                    events::emit_llm_usage(_app, o.usage.0, o.usage.1);
                }
                // 零输出（正文与 tool_calls 皆空）且非取消：疑似网关流式断流，
                // 重试一次避免浪费已喂的 prompt 却拿不到任何 token。
                let is_empty = o.content.trim().is_empty() && o.tool_calls.is_empty();
                if is_empty {
                    tracing::warn!(
                        "[agent] call_llm_stream: 第{}次流式返回空响应（疑似网关断流），{}",
                        attempt + 1,
                        if attempt < MAX_RETRY { "重试一次" } else { "已达上限，按空响应返回" }
                    );
                    last = Some(Ok(o));
                    if attempt < MAX_RETRY {
                        continue;
                    }
                    return last.unwrap();
                }
                return Ok(o);
            }
        }
    }
    last.unwrap_or(Err("流式调用失败".into()))
}

/// 单次流式请求 + SSE 聚合（不含重试）。空响应以 `Ok(空 StreamOutcome)` 返回，
/// 由 `call_llm_stream` 判断是否需要重试；用户取消以 `Err("任务已被用户取消")`
/// 返回，保证重试包装层不会对其重试。
#[tracing::instrument(skip_all)]
async fn call_llm_stream_once(
    _app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: &Arc<AtomicBool>,
    on_text: Option<&(dyn Fn(&str) + Send + Sync)>,
    on_reasoning: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> Result<StreamOutcome, String> {
    let _ = _app; // 事件推送已上移到 ReAct 循环，本函数只做拉流聚合
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }

    tracing::info!(
        "[agent] call_llm_stream: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let request_started = Instant::now();
    let client = crate::net::apply_proxy(reqwest::Client::builder(), &cfg.network_proxy)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = normalize_chat_url(&cfg.llm_base_url);

    let mut body = json!({
        "model": cfg.llm_model_name,
        "messages": messages,
        "stream": true,
        // 显式要求网关在流的最后一个 chunk 返回 usage（OpenAI 风格），
        // 否则部分网关默认不下发，导致前端拿不到真实 token 用量。
        "stream_options": { "include_usage": true },
    });
    // 注入智能体私有参数副本
    if let Some(obj) = cfg.llm_config.as_object() {
        for (k, v) in obj {
            if k != "model" && k != "messages" && k != "stream" {
                body[k] = v.clone();
            }
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    // reasoning 归一化（同 call_llm）
    if let Some(obj) = body.as_object_mut() {
        let action = match obj.get("reasoning") {
            Some(v) if v.is_boolean() => Some(v.as_bool() == Some(true)),
            _ => None,
        };
        if let Some(enabled) = action {
            if enabled {
                obj.insert("reasoning".into(), json!({}));
                tracing::info!("[agent] call_llm_stream: reasoning=true 归一化为 {{}}");
            } else {
                obj.remove("reasoning");
                tracing::info!("[agent] call_llm_stream: reasoning=false 已移除");
            }
        }
    }

    let body_preview = serde_json::to_string(&sanitize_for_log(&body)).unwrap_or_default();
    tracing::info!(
        "[agent] call_llm_stream: 请求体预览（已脱敏/截断）={} ",
        clip(&body_preview, 1000)
    );

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }
    // 部分网关需要显式声明 Accept: text/event-stream
    req = req.header("Accept", "text/event-stream");

    // 取消优先（请求级兜底）：若已收到取消信号，绝不发起本次 HTTP 请求——
    // 否则会把整段 prompt 发给网关计费后立刻作废。轮次级取消检查见 run_subtask 主循环。
    if cancel.load(Ordering::SeqCst) {
        tracing::info!("[agent] call_llm_stream: 取消信号已置位，跳过 HTTP 请求（不重复计费）");
        return Err("任务已被用户取消".into());
    }

    let resp = req.send().await.map_err(|e| {
        tracing::info!(
            "[agent] call_llm_stream: 请求失败（耗时={}ms）：{}",
            request_started.elapsed().as_millis(),
            e
        );
        format!("请求失败：{e}")
    })?;
    let status = resp.status();
    tracing::info!(
        "[agent] call_llm_stream: 收到 HTTP {}（耗时={}ms）",
        status,
        request_started.elapsed().as_millis()
    );
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let safe_text = clip(&sanitize_for_log(&Value::String(text.clone())).to_string(), 5000);
        tracing::info!(
            "[agent] call_llm_stream: HTTP {} 错误体（已脱敏/截断）={}",
            status, safe_text
        );
        return Err(format!("HTTP {}：{}", status, clip(&text, 2000)));
    }

    let mut stream = resp.bytes_stream();
    // 跨 chunk 字节缓冲：SSE 的 `data:` 行可能被 TCP 分片切到不同 chunk，
    // 这里累积原始字节，仅处理以 `\n` 结尾的完整行；多字节 UTF-8 字符也只在整行
    // 转换时解析，避免被分片截断成乱码（如中文 content 被切坏）。
    let mut buf: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    // reasoning 增量节流（#20260918011）：reasoning delta 很碎且量大（reasoning 模型单轮
    // 可烧 18K 思考 tokens），逐 delta emit 会造成 Tauri 事件风暴卡 UI。按「累计 ≥80 字符
    // 或距上次推送 ≥150ms」合并推送；流结束时 flush 余量。
    let mut r_throttle_buf = String::new();
    let mut r_last_flush = Instant::now();
    let mut chunk_count = 0usize;
    let mut line_count = 0usize;
    let mut parse_error_count = 0usize;
    // tool_calls 增量归并：index -> (id, name, arguments 片段拼接)
    let mut tc_acc: std::collections::BTreeMap<u64, (String, String, String)> = Default::default();
    // 真实 token 用量累计（OpenAI 把 usage 放在最后一个 chunk 之前；不同网关位置略有差异，每片都取最新非空值）。
    let mut usage: (u64, u64) = (0, 0);
    // 流式两道超时（支柱① 终态铁律）：
    // ① 整体墙钟（stream_total）——生成超长内容时总时长也必须有上限；
    // ② 单 chunk 静默（chunk_timeout）——SSE 流中途长时间无任何数据即判定断流。
    // 判据用「无产出静默时长」而非总耗时（慢 ≠ 死，但静默够久就是死）。
    let stream_total = llm_stream_total_timeout();
    let chunk_timeout = llm_stream_chunk_timeout();
    loop {
        // ① 整体墙钟兜底
        if request_started.elapsed() > stream_total {
            tracing::warn!(
                "[agent] call_llm_stream_once: 流式总时长超时（{}s，model={}）——终止，防止任务永不结束",
                stream_total.as_secs(),
                cfg.llm_model_name
            );
            return Err(format!(
                "流式响应总时长超时：{}s（model={}）",
                stream_total.as_secs(),
                cfg.llm_model_name
            ));
        }
        // 用户中途取消：立即终止拉流（连接随函数返回被丢弃），让本轮回合在
        // 调用方处检测到取消标志后提前结束。这是"停止按钮即时生效"的核心断流点。
        if cancel.load(Ordering::SeqCst) {
            tracing::info!(
                "[agent] call_llm_stream_once: 检测到取消信号，立即断流（已耗时={}ms）",
                request_started.elapsed().as_millis()
            );
            return Err("任务已被用户取消".into());
        }
        // ② 单 chunk 静默超时 + 取消并发检查。
        //
        // 取消必须**与拉流并发**检查：原实现把取消检查放在 `stream.next().await` 之前，
        // 流一旦静默（无 chunk 推送），取消信号要等满 chunk_timeout 才轮到检查 →
        // 「停止按钮」最长延迟 = chunk_timeout。2026-09-23 套件实测证实：快模型 5/5 秒响应，
        // 慢模型 5/5 在 90s 内未终态且**锁未释放**（流静默 → 取消迟迟不被检查）。
        // 改为 select 并发等待后，取消信号在 ~100ms 内生效。
        let cancel_wait = async {
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        };
        let next_opt: Option<Result<Vec<u8>, String>> = tokio::select! {
            _ = cancel_wait => {
                tracing::info!(
                    "[agent] call_llm_stream_once: 拉取下一片时检测到取消信号，立即断流（已耗时={}ms）",
                    request_started.elapsed().as_millis()
                );
                return Err("任务已被用户取消".into());
            }
            r = timeout(chunk_timeout, stream.next()) => match r {
                Ok(Some(res)) => Some(res.map(|b| b.to_vec()).map_err(|e| format!("流读取失败：{e}"))),
                Ok(None) => None, // 流正常结束
                Err(_) => {
                    tracing::warn!(
                        "[agent] call_llm_stream_once: SSE 静默超时（{}s 内无新数据，已耗时={}ms，model={}）——判定断流",
                        chunk_timeout.as_secs(),
                        request_started.elapsed().as_millis(),
                        cfg.llm_model_name
                    );
                    return Err(format!(
                        "流式响应静默超时：{}s 内未收到新数据（model={}）——判定为网关/模型断流",
                        chunk_timeout.as_secs(),
                        cfg.llm_model_name
                    ));
                }
            },
        };
        let chunk = match next_opt {
            Some(Ok(b)) => b,
            Some(Err(msg)) => {
                tracing::info!("[agent] call_llm_stream: SSE 流读取失败（已耗时={}ms）：{}", request_started.elapsed().as_millis(), msg);
                return Err(msg);
            }
            None => break, // 流正常结束
        };
        chunk_count += 1;
        buf.extend_from_slice(&chunk);
        // 处理缓冲区中所有以 \n 结尾的完整行
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let mut line_bytes = buf[..pos].to_vec();
            buf.drain(..=pos); // 移除该行及换行符
            if line_bytes.last() == Some(&b'\r') {
                line_bytes.pop(); // 去掉可能的 \r
            }
            line_count += 1;
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data == "[DONE]" {
                continue;
            }
            match serde_json::from_str::<Value>(data) {
                Ok(json) => {
                    let (content_delta, reasoning_piece) =
                        absorb_stream_delta(&json, &mut content, &mut reasoning, &mut tc_acc);
                    // 增量推流：每收到一片正文 delta 立即经回调向前端 emit 一个 text_chunk，
                    // 实现 SIMPLE_CHAT 等路径的逐字流式输出；ReAct 内部请求传 None 关闭。
                    if let Some(cb) = on_text {
                        if !content_delta.is_empty() {
                            cb(&content_delta);
                        }
                    }
                    // reasoning 增量（#20260918011）：累积节流后推送（见 r_throttle_buf 注释）。
                    if let Some(cb) = on_reasoning {
                        if !reasoning_piece.is_empty() {
                            r_throttle_buf.push_str(&reasoning_piece);
                            if r_throttle_buf.chars().count() >= 80
                                || r_last_flush.elapsed().as_millis() >= 150
                            {
                                cb(&r_throttle_buf);
                                r_throttle_buf.clear();
                                r_last_flush = Instant::now();
                            }
                        }
                    }
                    // 累计真实 token 用量（prompt / completion）
                    if let Some(u) = json.get("usage").and_then(|v| v.as_object()) {
                        if let (Some(p), Some(c)) = (
                            u.get("prompt_tokens").and_then(|v| v.as_u64()),
                            u.get("completion_tokens").and_then(|v| v.as_u64()),
                        ) {
                            usage = (p, c);
                        }
                    }
                }
                Err(e) => {
                    parse_error_count += 1;
                    // 整行已缓冲完整，正常不应再出现半截 JSON；若仍出现仅记录，不中断流。
                    tracing::info!(
                        "[agent] call_llm_stream: SSE JSON 解析失败 #{}：{}，data={}",
                        parse_error_count,
                        e,
                        clip(data, 500),
                    );
                }
            }
        }
    }
    // 处理流结束时缓冲区残留的尾行（极少数服务端不以换行结尾）
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if line.starts_with("data:") {
            let data = line.trim_start_matches("data:").trim();
            if data != "[DONE]" {
                if let Ok(json) = serde_json::from_str::<Value>(data) {
                    let (content_delta, reasoning_piece) =
                        absorb_stream_delta(&json, &mut content, &mut reasoning, &mut tc_acc);
                    if let Some(cb) = on_text {
                        if !content_delta.is_empty() {
                            cb(&content_delta);
                        }
                    }
                    // reasoning 增量只入节流缓冲，flush 交给下方流结束的统一兜底（此处不再单独推送）。
                    if !reasoning_piece.is_empty() {
                        r_throttle_buf.push_str(&reasoning_piece);
                    }
                    if let Some(u) = json.get("usage").and_then(|v| v.as_object()) {
                        if let (Some(p), Some(c)) = (
                            u.get("prompt_tokens").and_then(|v| v.as_u64()),
                            u.get("completion_tokens").and_then(|v| v.as_u64()),
                        ) {
                            usage = (p, c);
                        }
                    }
                }
            }
        }
    }

    // 流结束：flush reasoning 节流余量（#20260918011）。
    if let Some(cb) = on_reasoning {
        if !r_throttle_buf.is_empty() {
            cb(&r_throttle_buf);
            r_throttle_buf.clear();
        }
    }

    // 归并后的增量 tool_calls → 标准 OpenAI 格式（与 parse_tool_call 期望一致）
    let tool_calls: Vec<Value> = tc_acc
        .into_iter()
        .map(|(idx, (id, name, args))| {
            json!({
                "id": if id.is_empty() { format!("call_stream_{idx}") } else { id },
                "type": "function",
                "function": { "name": name, "arguments": args }
            })
        })
        .collect();

    tracing::info!(
        "[agent] call_llm_stream: SSE 聚合完成 chunks={} lines={} parse_errors={} content={}字符 reasoning={}字符 tool_calls={} 总耗时={}ms",
        chunk_count,
        line_count,
        parse_error_count,
        content.chars().count(),
        reasoning.chars().count(),
        tool_calls.len(),
        request_started.elapsed().as_millis(),
    );
    Ok(StreamOutcome {
        content,
        reasoning,
        tool_calls,
        usage,
    })
}

/// 吸收一个 SSE `chat.completion.chunk`：聚合 `delta.content`、`delta.reasoning`（含
/// `reasoning_content` 别名）与 `delta.tool_calls` 增量（按 index 归并 id/name/arguments）。
fn absorb_stream_delta(
    json: &Value,
    content: &mut String,
    reasoning: &mut String,
    tc_acc: &mut std::collections::BTreeMap<u64, (String, String, String)>,
) -> (String, String) {
    let mut content_delta = String::new();
    let mut reasoning_delta = String::new();
    let delta = json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("delta"));
    let Some(delta) = delta else {
        return (content_delta, reasoning_delta);
    };

    if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
        content.push_str(c);
        content_delta.push_str(c);
    }
    // DeepSeek 等风格的推理字段（两种命名兼容）
    for key in ["reasoning", "reasoning_content"] {
        if let Some(r) = delta.get(key).and_then(|v| v.as_str()) {
            reasoning.push_str(r);
            reasoning_delta.push_str(r);
        }
    }
    if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tcs {
            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let entry = tc_acc.entry(idx).or_default();
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                entry.0 = id.to_string();
            }
            if let Some(f) = tc.get("function") {
                if let Some(n) = f.get("name").and_then(|v| v.as_str()) {
                    entry.1.push_str(n);
                }
                if let Some(a) = f.get("arguments").and_then(|v| v.as_str()) {
                    entry.2.push_str(a);
                }
            }
        }
    }
    (content_delta, reasoning_delta)
}

/// 把 base_url 规整为 `/chat/completions` 端点（兼容用户填 `/v1` 或完整地址）。
fn normalize_chat_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else if trimmed.ends_with("/v1/") {
        format!("{trimmed}chat/completions")
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/* ----------------------------- 工具辅助 ----------------------------- */

/// 工具调用解析结果。
enum ParseOutcome {
    /// 字段缺失（无 id / 无 function / 无 name）：无法回传 ToolResult，直接跳过。
    Skip,
    /// 字段齐全但 `arguments` 不是合法 JSON：把解析错误作为 ToolResult 回传，强制模型自我纠错。
    ParseError {
        call_id: String,
        name: String,
        error: String,
    },
    /// 正常解析。
    Ready {
        call_id: String,
        name: String,
        args: Value,
    },
}

fn parse_tool_call(tc: &Value) -> ParseOutcome {
    let id = match tc.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return ParseOutcome::Skip,
    };
    let func = match tc.get("function") {
        Some(f) => f,
        None => return ParseOutcome::Skip,
    };
    let name = match func.get("name").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return ParseOutcome::Skip,
    };
    let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
    match serde_json::from_str::<Value>(args_str) {
        Ok(args) => ParseOutcome::Ready {
            call_id: id,
            name,
            args,
        },
        Err(e) => ParseOutcome::ParseError {
            call_id: id,
            name,
            error: e.to_string(),
        },
    }
}

/// 工具返回结果物理硬截断：超出 `MAX_TOOL_OUTPUT_LENGTH` 字符时截断并追加系统后缀，
/// 防止超大输出撑爆上下文、无谓消耗 Token。
fn truncate_tool_output(s: &str) -> String {
    if s.chars().count() <= MAX_TOOL_OUTPUT_LENGTH {
        return s.to_string();
    }
    let mut t: String = s.chars().take(MAX_TOOL_OUTPUT_LENGTH).collect();
    t.push_str(
        "...[Output Truncated: Exceeded 15000 characters. Please use tools like 'grep' or 'head' to filter specific information]",
    );
    t
}

fn detect_kind(tool_name: &str, args: &Value) -> String {
    if tool_name.contains("edit_file") {
        "edit_file".into()
    } else if tool_name.contains("execute_command") {
        "execute_command".into()
    } else {
        // 把 path/command 等字段透传给前端做友好展示
        let _ = args;
        "other".into()
    }
}

/// 裁剪历史（滑动窗口）：保留 system + 最近若干条消息。
///
/// **关键不变量**：绝不允许切开 `tool_calls ↔ tool result` 的配对。
/// 一旦被保留的 assistant(tool_calls) 丢失了它的任一 tool 结果（或保留了
/// tool 结果却丢掉发出它的 assistant），网关会直接拒绝整个请求：
/// `invalid params, tool result's tool id(...) not found`（HTTP 400 / code 2013）。
/// 因此切点必须从"按条数算出的理想位置"逐条向前（更早）推进，
/// 直到落在一个配对安全的边界上——宁可多丢一点历史，也不能产生半截配对。
/// 消息序列自检 + 自愈：确保发给 LLM（以及落库）的 messages 满足工具配对不变量。
///
/// 覆盖：
/// - I2：每个含 `tool_calls` 的 assistant，其**全部** `tool_call.id` 都必须有对应 tool 结果；
/// - I3：每条 tool 消息的 `tool_call_id` 必须能追溯到发起它的 assistant（否则为孤儿，直接丢弃）；
/// - I5：序列末尾不得是悬空的 assistant(tool_calls)。
///
/// 为什么必须在发送前做：并行工具调用会产生「1 条 assistant + N 条 tool 结果」，
/// 只要其中任意一条结果缺失（被裁剪切掉、工具被跳过、任务取消、熔断 break），
/// 网关就会拒绝整个请求：
/// `invalid params, tool result's tool id(...) not found`（HTTP 400 / code 2013）。
/// 补一条占位结果远优于让整个任务崩溃——模型读到占位后会自行改道，而不是反复重试。
pub(crate) fn sanitize_message_sequence(messages: &mut Vec<Value>) {
    // ① 收集每个 assistant 声明的 tool_call id
    let mut declared: Vec<(usize, Vec<String>)> = Vec::new();
    let mut all_declared: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (i, m) in messages.iter().enumerate() {
        if m.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
            let ids: Vec<String> = calls
                .iter()
                .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            for id in &ids {
                all_declared.insert(id.clone());
            }
            if !ids.is_empty() {
                declared.push((i, ids));
            }
        }
    }

    // ② 已存在结果的 tool_call_id
    let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in messages.iter() {
        if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
            if let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) {
                answered.insert(id.to_string());
            }
        }
    }

    // ③ 为缺失结果的 tool_call 补占位（紧随其 assistant 之后）
    let mut patches: Vec<(usize, Value)> = Vec::new();
    for (ai, ids) in &declared {
        let mut offset = 1usize;
        for id in ids {
            if !answered.contains(id) {
                patches.push((
                    ai + offset,
                    json!({
                        "role": "tool",
                        "tool_call_id": id,
                        "content": "[Tool result missing] This tool call has no recorded result \
(it may have been interrupted, cancelled, or dropped while trimming history). \
Do NOT blindly retry the same call — re-evaluate your plan and either try a different \
approach or report the situation to the user."
                    }),
                ));
                offset += 1;
            }
        }
    }
    // 倒序插入，避免下标偏移
    patches.sort_by(|a, b| b.0.cmp(&a.0));
    let patched = patches.len();
    for (pos, msg) in patches {
        let at = pos.min(messages.len());
        messages.insert(at, msg);
    }
    if patched > 0 {
        tracing::info!(
            "[agent] sanitize_message_sequence: 补齐 {} 条缺失的 tool 结果占位（防止 tool_call 悬空触发 HTTP 400）",
            patched
        );
    }

    // ④ 丢弃孤儿 tool 消息（找不到发起它的 assistant）
    let before = messages.len();
    messages.retain(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return true;
        }
        match m.get("tool_call_id").and_then(|v| v.as_str()) {
            Some(id) => all_declared.contains(id),
            None => false, // 连 id 都没有的 tool 消息必然是脏数据
        }
    });
    let dropped = before - messages.len();
    if dropped > 0 {
        tracing::info!(
            "[agent] sanitize_message_sequence: 丢弃 {} 条孤儿 tool 结果（其发起者 assistant 已不在上下文中）",
            dropped
        );
    }
}

fn trim_history(messages: &[Value]) -> Vec<Value> {
    let budget = MAX_HISTORY_TURNS * 2; // 不含 system 的保留额度
    if messages.len() <= budget + 1 {
        return messages.to_vec();
    }
    let system = messages.first().cloned();
    let rest = &messages[1..];

    // 理想起点（纯按条数），随后向前推进直到配对安全
    let mut start = rest.len().saturating_sub(budget);
    while start < rest.len() {
        if is_safe_start(rest, start) && !has_orphan_tool_result(&rest[start..]) {
            break;
        }
        start += 1;
    }
    // 兜底：极端情况下所有候选切点都不安全（例如历史几乎全是被打断的破碎配对），
    // 绝不能退化成「只剩 system、一条 user/tool 都不剩」——那会让本次调用失去用户输入。
    // 此时回退到「最后一条非 tool 消息」作为起点：宁可超出预算，也要保证上下文可用。
    if start >= rest.len() {
        start = rest
            .iter()
            .rposition(|m| m.get("role").and_then(|v| v.as_str()) != Some("tool"))
            .unwrap_or(0);
        tracing::info!(
            "[agent] trim_history: 所有候选切点均不安全，退化保留最后一条非 tool 消息（start={}）",
            start
        );
    }

    let mut out = Vec::new();
    if let Some(s) = system {
        out.push(s);
    }
    out.extend_from_slice(&rest[start..]);
    out
}

/// 切点自身不得破坏配对：
/// ① 切点不能是 tool 结果本身（否则发出它的 assistant 被留在了前一段）；
/// ② 切点若是带 tool_calls 的 assistant，则它**全部** tool_call 的结果都必须落在本段内
///    （并行工具调用时一轮会产生多条 tool 结果，只留一半必然 400）。
fn is_safe_start(rest: &[Value], start: usize) -> bool {
    let Some(first) = rest.get(start) else {
        return true;
    };
    let role = first.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if role == "tool" {
        return false;
    }
    if role == "assistant" {
        if let Some(calls) = first.get("tool_calls").and_then(|v| v.as_array()) {
            for c in calls {
                let Some(id) = c.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let result_in_segment = rest[start + 1..].iter().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("tool")
                        && m.get("tool_call_id").and_then(|v| v.as_str()) == Some(id)
                });
                if !result_in_segment {
                    return false;
                }
            }
        }
    }
    true
}

/// 段内不得存在"孤儿 tool 结果"：某条 tool 消息的 tool_call_id，
/// 在本段内找不到任何发出它的 assistant。
fn has_orphan_tool_result(seg: &[Value]) -> bool {
    seg.iter().any(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return false;
        }
        let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) else {
            return true;
        };
        !seg.iter().any(|a| {
            a.get("role").and_then(|v| v.as_str()) == Some("assistant")
                && a.get("tool_calls")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .any(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
                    })
                    .unwrap_or(false)
        })
    })
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 递归生成安全日志视图：保留请求结构，但不输出密钥、鉴权信息或图片 base64。
fn sanitize_for_log(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace('-', "_");
                let sensitive = matches!(
                    normalized.as_str(),
                    "api_key"
                        | "apikey"
                        | "api_secret"
                        | "apisecret"
                        | "access_token"
                        | "accesstoken"
                        | "authorization"
                        | "cookie"
                        | "client_secret"
                        | "clientsecret"
                ) || normalized == "token"
                    || normalized.ends_with("_secret")
                    || normalized.ends_with("_token")
                    || normalized == "data_url"
                    || normalized == "dataurl"
                    || normalized == "image_url"
                    || child
                        .as_str()
                        .map(|s| s.starts_with("data:image/") || s.len() > 20000)
                        .unwrap_or(false);
                if sensitive {
                    let size = child
                        .as_str()
                        .map(|s| s.chars().count())
                        .unwrap_or_else(|| child.to_string().chars().count());
                    out.insert(key.clone(), json!(format!("<已脱敏，原长度{}字符>", size)));
                } else {
                    out.insert(key.clone(), sanitize_for_log(child));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_for_log).collect()),
        other => other.clone(),
    }
}

/// 日志截断：超长内容截取前 `max` 个字符并附原始长度（避免大段工具结果刷屏）。
pub(crate) fn clip(s: &str, max: usize) -> String {
    let total = s.chars().count();
    if total <= max {
        s.to_string()
    } else {
        format!("{}…(共{}字符)", s.chars().take(max).collect::<String>(), total)
    }
}

/// 用户可见正文截断：与 `clip` 不同，不带「…(共N字符)」注记——注记混进回复正文
/// 观感差且会随回填落库（2026-09-21 轮 9 实锤：assistant_answer 存的是 530 字
/// 带注记截断版）。仅用于面向用户的正文；日志/调试仍用 `clip`。
pub(crate) fn clip_plain(s: &str, max: usize) -> String {
    let total = s.chars().count();
    if total <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P0-4 洞一：race_cancel 三态——None 直通 / Some 未取消放行 / Some 已取消短路。
    #[tokio::test]
    async fn race_cancel_semantics() {
        // None：直通 await，不做取消检查
        let out = race_cancel(None, async { 42 }).await;
        assert!(out.is_ok());

        // Some + 未取消：正常放行
        let flag = Arc::new(AtomicBool::new(false));
        let out = race_cancel(Some(&flag), async { 7 }).await;
        assert_eq!(out.unwrap(), 7);

        // Some + 已预先取消：立即 Err（不等待 future）
        let flag = Arc::new(AtomicBool::new(true));
        let started = std::time::Instant::now();
        let out = race_cancel(
            Some(&flag),
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                1
            },
        )
        .await;
        assert!(out.is_err());
        assert!(started.elapsed().as_millis() < 3000, "已取消时不得等待 future");
    }

    /// P0-4 洞一：future 在途时取消置位，轮询应在短窗内发现并短路。
    #[tokio::test]
    async fn race_cancel_short_circuits_mid_flight() {
        let flag = Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        // 300ms 后置位取消（模拟用户点停止）
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            f2.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let out = race_cancel(
            Some(&flag),
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                1
            },
        )
        .await;
        assert!(out.is_err());
        // 300ms 置位 + 最多一轮 200ms 轮询 → 远小于 30s 的 future 时长
        assert!(
            started.elapsed().as_millis() < 5000,
            "取消置位后应在轮询粒度级延迟内短路"
        );
    }


    /// 20260919002 per-agent 锁语义：不同 Agent 互不阻塞；同一 Agent 互斥；
    /// RunningGuard Drop（含提前 return / panic 路径）后锁自动复位且回收状态束。
    #[test]
    fn run_lock_is_per_agent() {
        let rt = AgentRuntime::new();

        // A 抢到锁；B 是另一个 Agent，照样能抢到（旧全局锁下这里会 None）
        let (a, _ga) = rt.try_acquire_run_lock("agent-a").expect("A 首次抢锁应成功");
        let (b, _gb) = rt.try_acquire_run_lock("agent-b").expect("B 与 A 不同，应可并行抢锁");

        // 同一 Agent 重复抢锁失败（互斥）
        assert!(rt.try_acquire_run_lock("agent-a").is_none(), "A 已在跑，重复抢锁应被拒");

        // 状态束互不串台：各自独立的 cancel_flag
        a.cancel_flag.store(true, Ordering::SeqCst);
        assert!(a.cancel_flag.load(Ordering::SeqCst));
        assert!(!b.cancel_flag.load(Ordering::SeqCst), "B 的取消标志不应被 A 污染");

        // 显式路由：resolve 按 agent_id 精确找到
        assert!(rt.resolve_task_state(Some("agent-a")).is_ok());
        assert!(rt.resolve_task_state(Some("agent-c")).is_err());

        // drop A 的 guard：A 的锁复位 + 状态束回收；B 不受影响
        drop(_ga);
        assert!(rt.resolve_task_state(Some("agent-a")).is_err(), "A 的状态束应随 guard 回收");
        assert!(rt.resolve_task_state(Some("agent-b")).is_ok(), "B 不受影响");

        // A 可再次抢锁（新一轮任务）
        assert!(rt.try_acquire_run_lock("agent-a").is_some());
        drop(_gb);
    }

    /// 缺省路由：单任务在跑时不传 agent_id 也能路由（平滑兼容），多任务时必须显式传。
    #[test]
    fn resolve_task_state_defaults() {
        let rt = AgentRuntime::new();
        // 无任务：Err
        assert!(rt.resolve_task_state(None).is_err());

        let (_a, ga) = rt.try_acquire_run_lock("agent-a").expect("抢锁");
        // 唯一在跑：缺省路由成功
        assert!(rt.resolve_task_state(None).is_ok());

        let (_b, _gb) = rt.try_acquire_run_lock("agent-b").expect("B 并行");
        // 多任务在跑：缺省路由必须报错（歧义）
        match rt.resolve_task_state(None) {
            Err(msg) => assert!(msg.contains("agent_id"), "错误信息应提示指定 agent_id: {msg}"),
            Ok(_) => panic!("多任务缺省路由应报错"),
        }
        drop(ga);
        drop(_gb);
    }
}
