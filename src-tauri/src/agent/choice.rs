//! 方案推荐挂起中枢（Phase 2a）。
//!
//! Agent 调用 `native__ask_user_choice` 工具时，构造 `ChoiceRequest` 并经
//! `events::emit_choice_needed` 推给前端，同时通过 `tokio::sync::oneshot` 通道挂起当前
//! 工具调用，直到前端经 `submit_choice_decision` 回传所选 option_id 唤醒。
//!
//! 与 `ApprovalManager` 对称：以 `Arc<Mutex<...>>` 托管于 `AgentRuntime` State，支持并发
//! 多任务（按 choice_id 区分）。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::sync::oneshot;

use crate::agent::types::ChoiceOutcome;
use crate::agent::types::ChoiceRequest;

struct Pending {
    req: ChoiceRequest,
    tx: oneshot::Sender<ChoiceOutcome>,
}

/// 方案推荐挂起中枢（托管于 `AgentRuntime` State）。
#[derive(Clone, Default)]
pub struct ChoiceHub {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
}

impl ChoiceHub {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 挂起等待用户选择：注册 pending 并立即返回接收端，由调用方 `await`。
    pub async fn suspend(&self, req: ChoiceRequest) -> oneshot::Receiver<ChoiceOutcome> {
        let (tx, rx) = oneshot::channel();
        let choice_id = req.choice_id.clone();
        let n = req.options.len();
        self.pending.lock().await.insert(choice_id.clone(), Pending { req, tx });
        tracing::info!("[agent] choice: 已挂起 choice_id={} 选项数={}", choice_id, n);
        rx
    }

    /// 前端回传所选 option_id：按 id 找回 label/value 后唤醒对应挂起的工具调用。
    /// 找不到 id 时回退为「以 option_id 作为 label」的结果，保证工具调用不挂死。
    pub async fn resolve(&self, choice_id: &str, option_id: &str) -> bool {
        let mut pending = self.pending.lock().await;
        if let Some(p) = pending.remove(choice_id) {
            let outcome = p
                .req
                .options
                .iter()
                .find(|o| o.id == option_id)
                .map(|o| ChoiceOutcome {
                    option_id: o.id.clone(),
                    label: o.label.clone(),
                    value: o.value.clone(),
                })
                .unwrap_or_else(|| ChoiceOutcome {
                    option_id: option_id.to_string(),
                    label: option_id.to_string(),
                    value: None,
                });
            let sent = p.tx.send(outcome).is_ok();
            tracing::info!(
                "[agent] choice: 收到选择 choice_id={} option_id={} sent={}",
                choice_id, option_id, sent
            );
            sent
        } else {
            tracing::info!(
                "[agent] choice: 未找到挂起项 choice_id={}（可能已超时/取消）",
                choice_id
            );
            false
        }
    }

    /// 超时/取消时清理挂起项（避免内存泄漏）。
    pub async fn cancel(&self, choice_id: &str) {
        let removed = self.pending.lock().await.remove(choice_id).is_some();
        tracing::info!("[agent] choice: 清理 choice_id={} removed={}", choice_id, removed);
    }

    /// 全局停止时清空所有挂起选择：drop 全部 Sender → 对应 `rx.await` 走取消分支。
    /// 幂等：已 `resolve` 的条目不在 Map 中，`clear` 无副作用。
    pub async fn cancel_all(&self) {
        let count = {
            let mut pending = self.pending.lock().await;
            let n = pending.len();
            pending.clear();
            n
        };
        if count > 0 {
            tracing::info!("[agent] choice: cancel_all 清空 {} 个挂起选择", count);
        }
    }
}
