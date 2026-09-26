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
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;

use crate::agent::hitl::approval::ApprovalManager;
use crate::agent::hitl::choice::ChoiceHub;
use crate::agent::events;
use crate::agent::engine::graph::KnowledgeGraph;
use crate::agent::engine::native;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::PlanDAG;

// S1 拆分（台账 §2.1）：协议纯函数迁至 engine/protocol.rs，此处 re-export 保持调用路径不变。
pub(crate) use crate::agent::engine::protocol::sanitize_message_sequence;
// S1 拆分（台账 §2.1）：LLM 网关层迁至 engine/llm.rs，re-export 保持调用路径不变。
pub(crate) use crate::agent::engine::llm::{call_llm, call_llm_stream};
pub(crate) use crate::agent::engine::llm::StreamOutcome;
// S1 拆分（台账 §2.1）：简单对话路径与工具轮执行迁出，re-export 保持 pipeline 调用路径。
pub(crate) use crate::agent::engine::tool_round::run_tool_calls_round;
use crate::agent::engine::simple_chat::{collect_simple_chat_tools, run_simple_chat};

// ── run 级墙钟兜底（commands.rs 引用；run 预算两阶段软超时，P0-1）──
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

/// 工具返回结果物理截断阈值（字符）。防止超大输出撑爆上下文、无谓消耗 Token。
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
            call_id: None,
        };

        // ────────────────────────────────────────────────────────────────────
        // 三层流水线调度（新架构）：意图分流 → DAG 规划 → 微 ReAct 流水线执行。
        // 下方旧的全局大 ReAct 循环已废弃（if false 留档，验证后删除）。
        // ────────────────────────────────────────────────────────────────────

        // 会话背景（2026-09-26 指代断链修复）：意图分类器与规划器此前只看得到当前一句话，
        // 「搜索这个国家的详细信息」这类含指代的输入被误判/误规划。加载一次（滚动摘要 +
        // 最近用户原话，已排除本轮），两处共用；无会话或 DB 未就绪时为 None，链路照常。
        let session_background = crate::agent::engine::context::load_session_background(app, &cfg).await;

        // 阶段一：意图分流（规则短路优先，灰色地带走轻量 LLM 分类）。
        let mut intent = crate::agent::engine::intent::classify_intent(&cfg, &prompt, Some(&task.cancel_flag), session_background.as_deref()).await;
        // KB 已绑定 + SIMPLE_CHAT → 简单对话快路径（20260922 #1）：run_simple_chat 现已携带
        // native__kb_search 工具（kb_ids 非空时构造实例），纯 KB 问答跳过规划直接「检索→综合」，
        // 不再强制转 COMPOSITE（旧设计因空工具集导致 KB 不可检索而强制转换；网关慢时规划调用
        // 纯属开销，实测可达 1~3 分钟）。requires_tool 保留为语义标记，requires_planning=false。
        // 台账 S1 回归修复：SIMPLE_CHAT 工具面 = registry 中全部「ReadSafe + Local 域」工具——
        // 旧实现只挂 native__kb_search，@ 提及临时启用的 MCP（如 AnySearch）在简单对话路径
        // 被静默丢弃，模型无搜索工具可用。过滤规则：ReadSafe（写/执行/审批类工具不进简单路径，
        // 风险面不扩大）+ Local 域（host__ 的 HostAuthz 门禁在复合路径调度层，简单路径没有
        // 该门，绝不挂载）。kb 未绑定时 MCP/只读工具同样可用。
        let simple_tools = collect_simple_chat_tools(&registry);
        if !simple_tools.is_empty() && intent.is_simple_chat() {
            tracing::info!(
                "[agent] run_task: 意图=SIMPLE_CHAT → 简单对话路径携带 {} 个 ReadSafe 工具（kb/MCP/只读 native；跳过规划）",
                simple_tools.len()
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
            run_simple_chat(app, &cfg, &prompt, &task.cancel_flag, &simple_tools).await;
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
            crate::agent::engine::planner::build_plan(&cfg, &prompt, cfg.workspace.as_deref(), Some(&task.cancel_flag), &registry, session_background.as_deref()).await
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
                            crate::agent::engine::planner::build_plan(&cfg, &revised_prompt, cfg.workspace.as_deref(), Some(&task.cancel_flag), &registry, session_background.as_deref()).await;
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
    // Skill 随包工具（台账 D1 第三步）：绑定的 Skill 包内 tools.json 声明的工具
    // 注册为 skill__{identifier}__{slug}——与插件同规则，allow_sandbox=1 才注册
    // （脚本执行前置条件）；无 tools.json 的纯知识包零影响。
    if cfg.allow_sandbox {
        crate::agent::plugins::skill_tools::register_skill_tools(&mut base, app, &cfg.skill_tools);
    }
    // 服务器托管（Host）：绑定非空时注册 host__* 工具族（12 个，HostAuthz 独立授权域）。
    crate::host::register_host_tools(&mut base, app, Arc::new(cfg.server_bindings.clone()));
    base
}



/* ----------------------------- 工具辅助 ----------------------------- */




/// 从消息对象提取文本（llm.rs 与 tool_round.rs 共用）。
/// 提取响应字段的规范化文本：字符串直接用；OpenAI 多模态数组（[{type:"text",text:...}]）拼接全部 text；
/// 对象壳（{content:...}/{text:...}）取内部文本。解决 gemma4 网关 content/reasoning 非标准形态解析为空。
pub(crate) fn extract_message_text(v: Option<&Value>) -> String {
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
pub(crate) fn describe_value_shape(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(s) => format!("string({}字符)", s.chars().count()),
        Value::Array(a) => format!("array({}项)", a.len()),
        Value::Object(o) => format!("object(keys={:?})", o.keys().collect::<Vec<_>>()),
        other => format!("其他={other}"),
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 递归生成安全日志视图：保留请求结构，但不输出密钥、鉴权信息或图片 base64。
pub(crate) fn sanitize_for_log(value: &Value) -> Value {
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
