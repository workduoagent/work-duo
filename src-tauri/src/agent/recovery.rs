//! 步骤级恢复中枢（Phase 2 #8）。
//!
//! 流水线在子任务「自动重试耗尽」后仍失败时不再整体中止，而是把受阻步骤登记为
//! `RecoveryRequest` 并 emit `agent-recovery-needed`，随后在 `wait()` 上异步挂起，
//! 直到前端经 `retry_subtask` / `skip_subtask` / `resolve_subtask` 命令回传决策唤醒。
//!
//! 三种决策：
//!  - `Retry`：从头重跑当前受阻子任务；
//!  - `Skip`：标记该步骤为「已跳过」并继续后续步骤；
//!  - `Takeover(guidance)`：把用户补充指示注入当前子任务提示，引导式重跑（空指引等价于 Retry）；
//!  - `Cancel`：用户在等待期间点击了取消（取消标志优先）。

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tokio::sync::Notify;

/// 步骤级恢复决策（由前端回传，经 `commands::resolve_subtask` 的 decision 字段映射）。
///
/// `ChangeApproach` 为 Phase 2b-1 启用：前端档 B 恢复面板第 4 键「改方案」回传，
/// 要求 Agent 换思路重规划（见 `pipeline.rs` 中对应 match 臂）。
#[derive(Debug, Clone)]
pub enum RecoveryDecision {
    /// 重试当前受阻子任务（从头再跑一遍）。
    Retry,
    /// 跳过当前子任务，标记为已跳过并继续后续步骤。
    Skip,
    /// 接管：注入用户补充指示，作为「引导式重试」重跑当前子任务（空指引等价于 Retry）。
    Takeover(String),
    /// 改方案：把错误摘要 + 已试路径回灌，要求 Agent 换思路重规划（Phase 2b-1 启用）。
    ChangeApproach(String),
    /// 取消（用户在等待期间点击了取消）。
    Cancel,
}

/// 接管面板展示用的工具栈快照（Phase 2b-2）。
///
/// 让用户在接管决策前清楚「当前 Agent 手里有哪些能力可调用」，覆盖原生工具 / MCP 工具 / 技能 / 沙箱开关。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolStack {
    /// 原生工具（叶子名，如 write_file / native__run_python_sandbox）。
    pub native_tools: Vec<String>,
    /// 已启用 MCP 服务器的工具（tool_code 列表）。
    pub mcp_tools: Vec<String>,
    /// 已加载技能名（驱动领域能力的关键闸门）。
    pub skills: Vec<String>,
    /// 沙箱执行是否开启。
    pub sandbox_enabled: bool,
}

/// 子任务受阻时记录的可恢复请求（推前端渲染恢复面板）。
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryRequest {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    /// 受阻原因（最后一次失败摘要）。
    pub reason: String,
    /// 受阻子任务已产出的摘要（可能为空）。
    pub summary: String,
    /// 异常分档：A=可恢复（3 键：跳过|重试|接管）/ B=高风险歧义（4 键，含改方案）。
    /// Phase 2a 恒为 "A"，档 B 与自动升档留 2b。
    pub tier: String,
    /// 失败命令（接管面板展示用，2b-1 起从真实失败工具调用采集）。
    pub failed_command: Option<String>,
    /// 已改动文件（接管面板展示用，2b-2 起从工具轮真实采集）。
    pub changed_files: Option<Vec<String>>,
    /// 工具栈快照（接管面板展示用，2b-2 新增）。
    pub tool_stack: Option<AgentToolStack>,
}

/// 异常分档分类器（Phase 2b-1）。
///
/// 返回 `"A"`（可恢复，3 键：跳过|重试|接管）或 `"B"`（高风险歧义，4 键，含改方案）。
/// 升档为 B 的条件（任一命中即 B）：
///  - `attempts >= 2`：同一子任务已至少经历过一次恢复（即用户已重试 ≥1 次仍失败），
///    触发「自动升档」——默认引导用户换思路而非继续无脑重试；
///  - 失败文本命中高风险关键词：写系统路径 / 改 CI·配置文件 / 改依赖锁文件等，
///    这类操作即便首次失败也值得让用户确认是否要换方案。
pub fn classify_tier(attempts: usize, reason: &str, failed_command: &Option<String>) -> &'static str {
    if attempts >= 2 {
        return "B";
    }
    let cmd = failed_command.as_deref().unwrap_or("");
    let hay = format!("{}\n{}", reason, cmd).to_lowercase();
    const RISKY: &[&str] = &[
        // 系统路径
        "c:\\windows",
        "c:\\program files",
        "c:\\programdata",
        "/etc/",
        "/system/",
        "/usr/",
        "/proc/",
        "/sys/",
        "appdata",
        "localappdata",
        // CI / 配置
        ".github/workflows",
        ".gitlab-ci",
        "jenkinsfile",
        "azure-pipelines",
        "tsconfig",
        "vite.config",
        "webpack.config",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        ".env",
        "cargo.toml",
        "pyproject.toml",
        ".npmrc",
        "/.git/",
        ".git/",
    ];
    if RISKY.iter().any(|k| hay.contains(k)) {
        return "B";
    }
    "A"
}

/// 步骤级恢复挂起中枢（托管于 `AgentRuntime` 共享状态，后端任务与命令跨任务访问）。
pub struct RecoveryHub {
    pending: Mutex<Option<RecoveryRequest>>,
    decision: Mutex<Option<RecoveryDecision>>,
    notify: Notify,
}

impl RecoveryHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(None),
            decision: Mutex::new(None),
            notify: Notify::new(),
        })
    }

    /// 登记一个受阻子任务，触发前端恢复面板（同时唤醒可能的监听者，幂等）。
    pub fn request(&self, req: RecoveryRequest) {
        *self.pending.lock().unwrap() = Some(req);
        self.notify.notify_one();
        tracing::info!("[agent] recovery: 子任务 step 进入等待恢复（emit agent-recovery-needed）");
    }

    /// 当前是否有子任务在等待恢复（前端可用以禁用按钮 / 显示面板）。
    pub fn is_blocked(&self) -> bool {
        self.pending.lock().unwrap().is_some()
    }

    /// 当前挂起的恢复请求快照（供 `get_status_detail` 透出给外部 Agent；无挂起为 None）。
    /// 20260922：MCP 侧此前完全观测不到恢复等待（get_status 只透审批/计划），外部驱动
    /// 遇步骤失败重试耗尽即永久卡死——本快照 + `agent_submit_recovery_decision` 补齐闭环。
    pub fn snapshot(&self) -> Option<RecoveryRequest> {
        self.pending.lock().unwrap().clone()
    }

    /// 回传恢复决策并唤醒挂起的流水线。
    pub fn resolve(&self, d: RecoveryDecision) {
        let decision_label = match &d {
            RecoveryDecision::Retry => "Retry".into(),
            RecoveryDecision::Skip => "Skip".into(),
            RecoveryDecision::Takeover(g) => format!("Takeover(len={})", g.chars().count()),
            RecoveryDecision::ChangeApproach(g) => {
                format!("ChangeApproach(len={})", g.chars().count())
            }
            RecoveryDecision::Cancel => "Cancel".into(),
        };
        // 改动 3D：读取挂起的 step / title，排查时直接定位是哪一个受阻子任务。
        let (step, title) = self
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map_or((0usize, String::new()), |r| (r.step, r.title.clone()));
        tracing::info!(
            "[agent] recovery: 收到恢复决策 {}（step={}「{}」）",
            decision_label,
            step,
            title,
        );
        *self.decision.lock().unwrap() = Some(d);
        self.notify.notify_one();
    }

    /// 取消：标记决策为 Cancel 并唤醒（与 `wait` 同生命周期；取消标志优先）。
    pub fn cancel(&self) {
        *self.decision.lock().unwrap() = Some(RecoveryDecision::Cancel);
        self.notify.notify_one();
    }

    /// 任务整体启动时清空前一轮残留（新一轮开始即重置）。
    pub fn reset(&self) {
        *self.pending.lock().unwrap() = None;
        *self.decision.lock().unwrap() = None;
    }

    /// 挂起直到收到恢复决策或用户取消。决策被消费时同步清除挂起态（前端面板收起）。
    pub async fn wait(&self, cancel: &AtomicBool) -> RecoveryDecision {
        loop {
            if cancel.load(Ordering::SeqCst) {
                *self.pending.lock().unwrap() = None;
                return RecoveryDecision::Cancel;
            }
            if let Some(d) = self.decision.lock().unwrap().take() {
                *self.pending.lock().unwrap() = None;
                return d;
            }
            self.notify.notified().await;
        }
    }
}
