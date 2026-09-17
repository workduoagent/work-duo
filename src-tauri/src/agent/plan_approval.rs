//! 计划审批门禁（Phase 2b-3）。
//!
//! 复合任务完成 DAG 规划后、流水线执行前，把计划登记为 `PlanApprovalRequest` 并经
//! `emit_plan_approval_needed` 推前端渲染「计划确认」弹窗，随后在 `wait()` 上异步挂起，
//! 直到前端经 `submit_plan_decision` 回传决策唤醒：
//!  - `Approve`：按当前计划进入流水线执行；
//!  - `Reject`：整体放弃任务（不执行任何步骤）；
//!  - `Revise(guidance)`：把用户修改意见回灌，重新规划（再走一次门禁）；
//!  - `Cancel`：等待期间用户点击取消。
//!
//! 结构镜像 `recovery.rs` 的 `RecoveryHub`（pending + decision + Notify 三件套），
//! 但决策语义不同（确认/拒绝/修改而非重试/跳过/接管）。

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use tokio::sync::Notify;

use crate::agent::types::PlanDAG;

/// 计划审批决策（由前端经 `commands::submit_plan_decision` 的 decision 字段映射）。
#[derive(Debug, Clone)]
pub enum PlanApprovalDecision {
    /// 批准原计划，进入流水线执行。
    Approve,
    /// 拒绝：整体放弃任务。
    Reject,
    /// 修改：把用户修改意见回灌，触发重新规划（空指引等价于 Approve）。
    Revise(String),
    /// 取消（等待期间用户点击了取消）。
    Cancel,
}

/// 计划审批请求（推前端渲染计划确认弹窗）。
#[derive(Debug, Clone)]
pub struct PlanApprovalRequest {
    /// 任务一句话目标。
    pub goal_summary: String,
    /// DAG 计划（步骤清单）。
    pub plan: PlanDAG,
    /// 15007 边审批策略：计划内敏感操作清单（批准=一次授权整清单，写入 grants）。
    pub sensitive_ops: Vec<crate::agent::policy::PlanSensitiveOp>,
}

/// 计划审批挂起中枢（托管于 `AgentRuntime` 共享状态，后端任务与命令跨任务访问）。
pub struct PlanApprovalHub {
    pending: Mutex<Option<PlanApprovalRequest>>,
    decision: Mutex<Option<PlanApprovalDecision>>,
    notify: Notify,
}

impl PlanApprovalHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(None),
            decision: Mutex::new(None),
            notify: Notify::new(),
        })
    }

    /// 登记一个待确认计划，触发前端计划确认弹窗（同时唤醒可能的监听者，幂等）。
    pub fn request(&self, req: PlanApprovalRequest) {
        *self.pending.lock().unwrap() = Some(req);
        self.notify.notify_one();
        tracing::info!("[agent] plan_approval: 进入等待计划审批（emit agent-plan-approval-needed）");
    }

    /// 当前是否有计划在等待审批（前端可用以禁用按钮 / 显示面板）。
    pub fn is_blocked(&self) -> bool {
        self.pending.lock().unwrap().is_some()
    }

    /// 回传审批决策并唤醒挂起的流水线。
    pub fn resolve(&self, d: PlanApprovalDecision) {
        let label = match &d {
            PlanApprovalDecision::Approve => "Approve".into(),
            PlanApprovalDecision::Reject => "Reject".into(),
            PlanApprovalDecision::Revise(g) => format!("Revise(len={})", g.chars().count()),
            PlanApprovalDecision::Cancel => "Cancel".into(),
        };
        tracing::info!("[agent] plan_approval: 收到审批决策 {}", label);
        *self.decision.lock().unwrap() = Some(d);
        self.notify.notify_one();
    }

    /// 取消：标记决策为 Cancel 并唤醒（与 `wait` 同生命周期；取消标志优先）。
    pub fn cancel(&self) {
        *self.decision.lock().unwrap() = Some(PlanApprovalDecision::Cancel);
        self.notify.notify_one();
    }

    /// 任务整体启动时清空前一轮残留（新一轮开始即重置）。
    pub fn reset(&self) {
        *self.pending.lock().unwrap() = None;
        *self.decision.lock().unwrap() = None;
    }

    /// 挂起直到收到审批决策或用户取消。决策被消费时同步清除挂起态（前端面板收起）。
    pub async fn wait(&self, cancel: &AtomicBool) -> PlanApprovalDecision {
        loop {
            if cancel.load(Ordering::SeqCst) {
                *self.pending.lock().unwrap() = None;
                return PlanApprovalDecision::Cancel;
            }
            if let Some(d) = self.decision.lock().unwrap().take() {
                *self.pending.lock().unwrap() = None;
                return d;
            }
            self.notify.notified().await;
        }
    }
}

/// 计划审批策略判定（Phase 2b-3 `allow` 规则层）。
///
/// 返回 `true` 表示该计划含「敏感操作」，应当走人工审批门禁；返回 `false` 表示计划
/// 仅含低风险操作（纯文件创建/编辑/读取、UI 组件、文案、内部规划等），可被策略层自动放行。
///
/// 判定依据：把每个步骤的标题 + 描述拼接成小写文本，命中任一敏感词即判为敏感。
/// 敏感词聚焦「危险/不可逆/越界」类操作，刻意**不**收录 `password`/`token`/`secret` 等
/// 过泛词，以免误伤「创建登录页」这类纯前端 UI 任务（仅含密码输入框的组件生成不算危险）。
pub fn plan_requires_approval(plan: &PlanDAG) -> bool {
    const RISK_TOKENS: &[&str] = &[
        // 命令执行
        "执行命令",
        "exec",
        "execute_command",
        "run_command",
        "终端",
        "terminal",
        "shell",
        "命令行",
        "command line",
        "cmd.exe",
        // 文件删除 / 移动出界
        "删除",
        "delete",
        "remove",
        "rm -rf",
        "rm -r",
        "del ",
        "unlink",
        "move_path",
        "重命名",
        "rename",
        "移动文件",
        // 系统 / 危险路径
        "/etc/",
        "/usr/",
        "/system/",
        "/proc/",
        "/sys/",
        "c:\\windows",
        "appdata",
        // 网络发布 / 外部副作用
        "上传",
        "upload",
        "提交到",
        "部署",
        "deploy",
        "发布",
        "release",
        "迁移数据库",
        "migrate",
        "curl ",
        "wget",
        "下载并执行",
        "download and run",
        "发送邮件",
        "send email",
        // 数据库写
        "drop table",
        "truncate",
        "insert into",
        "delete from",
        "update 表",
        "数据库写",
    ];
    for t in &plan.tasks {
        let hay = format!("{} {}", t.title, t.description).to_lowercase();
        for tok in RISK_TOKENS {
            if hay.contains(tok) {
                return true;
            }
        }
    }
    false
}
