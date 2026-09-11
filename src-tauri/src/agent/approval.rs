//! 高危操作人机审批管理器（对应方案步骤 3）。
//!
//! 当运行时准备执行 `RequireApproval` 级工具时，构造一个 `ApprovalRequest` 并经
//! `events::emit_awaiting_approval` 推给前端，同时通过 `tokio::sync::oneshot` 通道挂起当前
//! 循环（异步零死锁），直到前端调用 `submit_approval_decision` 回传决策。
//!
//! `ApprovalManager` 以 `Arc<Mutex<...>>` 托管于 Tauri State，支持并发多任务（按 approval_id 区分）。

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::Mutex;
use tokio::sync::oneshot;

use crate::agent::types::ApprovalRequest;

/// 前端回传的审批决策。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionInput {
    pub approval_id: String,
    /// 决策：approve | skip | takeover。
    pub decision: String,
    /// 接管时携带的用户补充指示（takeover 时有效，空等价于 approve）。
    #[serde(default)]
    pub guidance: Option<String>,
}

/// 单个挂起的审批：发送端（运行时持有，接收决策）。
struct Pending {
    tx: oneshot::Sender<ApprovalOutcome>,
}

/// 审批结果（发回运行时）。
///
/// - `Approve`：授权执行；
/// - `Skip`：跳过本次调用（不执行、不重试，按原计划继续下一步，记 skipped）；
/// - `Takeover(guidance)`：授权执行 + 注入用户补充指示引导重跑（Mixed-initiative）。
#[derive(Debug, Clone)]
pub enum ApprovalOutcome {
    Approve,
    Skip,
    Takeover(String),
}

/// 审批管理器（托管于 Tauri State）。
#[derive(Clone, Default)]
pub struct ApprovalManager {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
}

impl ApprovalManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 挂起等待决策：注册 pending 并立即返回接收端，由调用方 `await`。
    /// 返回 (request, rx)：request 用于推前端，rx 用于阻塞等待用户决策。
    #[tracing::instrument(skip_all)]
    pub async fn suspend(&self, request: ApprovalRequest) -> oneshot::Receiver<ApprovalOutcome> {
        let (tx, rx) = oneshot::channel();
        let approval_id = request.approval_id.clone();
        let tool_name = request.tool_name.clone();
        self.pending
            .lock()
            .await
            .insert(approval_id.clone(), Pending { tx });
        tracing::info!(
            "[agent] approval: 已挂起 approval_id={} tool={} 当前pending={}个",
            approval_id,
            tool_name,
            self.pending.lock().await.len(),
        );
        rx
    }

    /// 前端回传决策：唤醒对应挂起的任务。无匹配 id 时返回 false（已超时/不存在）。
    pub async fn resolve(&self, decision: ApprovalDecisionInput) -> bool {
        let approval_id = decision.approval_id.clone();
        let outcome = match decision.decision.to_lowercase().as_str() {
            "approve" => ApprovalOutcome::Approve,
            "skip" => ApprovalOutcome::Skip,
            "takeover" => ApprovalOutcome::Takeover(decision.guidance.unwrap_or_default()),
            other => {
                tracing::info!("[agent] approval: 未知决策 {}，按跳过处理", other);
                ApprovalOutcome::Skip
            }
        };
        let mut pending = self.pending.lock().await;
        if let Some(p) = pending.remove(&approval_id) {
            // 通道已关闭（接收方被 drop）则忽略。
            let sent = p.tx.send(outcome).is_ok();
            tracing::info!(
                "[agent] approval: 收到决策 approval_id={} sent={} 剩余pending={}个",
                approval_id, sent, pending.len(),
            );
            sent
        } else {
            tracing::info!(
                "[agent] approval: 未找到挂起项 approval_id={}（可能已超时/取消）",
                approval_id
            );
            false
        }
    }

    /// 超时/取消时清理挂起项（避免内存泄漏）。
    pub async fn cancel(&self, approval_id: &str) {
        let removed = self.pending.lock().await.remove(approval_id).is_some();
        tracing::info!("[agent] approval: 清理 approval_id={} removed={}", approval_id, removed);
    }

    /// 全局停止时清空所有挂起审批：drop 全部 Sender → 对应 `rx.await` 走拒绝分支，
    /// 唤醒被审批挂起的流水线（否则「停止」无法跳出 `rx.await` 挂起）。
    /// 幂等：已 `resolve` 的条目不在 Map 中，`clear` 无副作用。
    pub async fn cancel_all(&self) {
        let count = {
            let mut pending = self.pending.lock().await;
            let n = pending.len();
            pending.clear();
            n
        };
        if count > 0 {
            tracing::info!("[agent] approval: cancel_all 清空 {} 个挂起审批", count);
        }
    }
}
