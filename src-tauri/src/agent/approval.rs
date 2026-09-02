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
    pub approved: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 单个挂起的审批：发送端（运行时持有，接收决策）。
struct Pending {
    tx: oneshot::Sender<ApprovalOutcome>,
}

/// 审批结果（发回运行时）。
#[derive(Debug, Clone)]
pub struct ApprovalOutcome {
    pub approved: bool,
    pub reason: Option<String>,
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
    pub async fn suspend(&self, request: ApprovalRequest) -> oneshot::Receiver<ApprovalOutcome> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(request.approval_id.clone(), Pending { tx });
        rx
    }

    /// 前端回传决策：唤醒对应挂起的任务。无匹配 id 时返回 false（已超时/不存在）。
    pub async fn resolve(&self, decision: ApprovalDecisionInput) -> bool {
        if let Some(p) = self.pending.lock().await.remove(&decision.approval_id) {
            // 通道已关闭（接收方被 drop）则忽略。
            let _ = p.tx.send(ApprovalOutcome {
                approved: decision.approved,
                reason: decision.reason,
            });
            true
        } else {
            false
        }
    }

    /// 超时/取消时清理挂起项（避免内存泄漏）。
    pub async fn cancel(&self, approval_id: &str) {
        self.pending.lock().await.remove(approval_id);
    }
}
