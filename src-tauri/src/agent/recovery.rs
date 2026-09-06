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

use tokio::sync::Notify;

/// 步骤级恢复决策（由前端回传）。
#[derive(Debug, Clone)]
pub enum RecoveryDecision {
    /// 重试当前受阻子任务（从头再跑一遍）。
    Retry,
    /// 跳过当前子任务，标记为已跳过并继续后续步骤。
    Skip,
    /// 接管：注入用户补充指示，作为「引导式重试」重跑当前子任务（空指引等价于 Retry）。
    Takeover(String),
    /// 取消（用户在等待期间点击了取消）。
    Cancel,
}

/// 子任务受阻时记录的可恢复请求（推前端渲染恢复面板）。
#[derive(Debug, Clone)]
pub struct RecoveryRequest {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    /// 受阻原因（最后一次失败摘要）。
    pub reason: String,
    /// 受阻子任务已产出的摘要（可能为空）。
    pub summary: String,
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
        println!("[agent] recovery: 子任务 step 进入等待恢复（emit agent-recovery-needed）");
    }

    /// 当前是否有子任务在等待恢复（前端可用以禁用按钮 / 显示面板）。
    pub fn is_blocked(&self) -> bool {
        self.pending.lock().unwrap().is_some()
    }

    /// 回传恢复决策并唤醒挂起的流水线。
    pub fn resolve(&self, d: RecoveryDecision) {
        println!(
            "[agent] recovery: 收到恢复决策 {}",
            match &d {
                RecoveryDecision::Retry => "Retry".into(),
                RecoveryDecision::Skip => "Skip".into(),
                RecoveryDecision::Takeover(g) => format!("Takeover(len={})", g.chars().count()),
                RecoveryDecision::Cancel => "Cancel".into(),
            }
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
