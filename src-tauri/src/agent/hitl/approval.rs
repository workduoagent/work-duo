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
    /// 15007 边审批策略：「本任务内记住该授权」勾选（默认 false）。
    /// 勾选时由 `submit_approval_decision` 把 `grant_key` 写入 runtime 授权集，
    /// 同信号后续操作本任务内不再询问。
    #[serde(default)]
    pub remember: bool,
    /// 策略授权 key（与 ApprovalRequest.grant_key 回传配对；remember 时必带）。
    #[serde(default)]
    pub grant_key: Option<String>,
}

/// 单个挂起的审批：发送端（运行时持有，接收决策）。
struct Pending {
    tx: oneshot::Sender<ApprovalOutcome>,
    /// 原始请求快照（供 `current_request` 向外部 Agent 暴露「正在等什么审批」）。
    request: ApprovalRequest,
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
    /// 成员所属小分队：审批梯度判定键（工作台观看中挂起等决策 / 不在通知 120s×2 后低危自动批）。
    squad_id: Option<String>,
}

impl ApprovalManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            squad_id: None,
        }
    }

    /// 成员上下文：审批梯度降级（工作台观看中=挂起等决策；不在=通知 120s×2 后低危自动批；L3 一律挂起）。
    pub fn for_member(squad_id: String) -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            squad_id: Some(squad_id),
        }
    }

    /// 挂起等待决策：注册 pending 并立即返回接收端，由调用方 `await`。
    /// 返回 (request, rx)：request 用于推前端，rx 用于阻塞等待用户决策。
    #[tracing::instrument(skip_all)]
    pub async fn suspend(&self, request: ApprovalRequest) -> oneshot::Receiver<ApprovalOutcome> {
        // 成员上下文梯度降级（用户设计）：工作台观看中 → 挂起等界面决策；不在 → 通知 120s×2 后
        // 低危自动批（推荐方案）；L3 高危一律保持挂起（tool_round 300s 超时兜底）。
        if let Some(sid) = &self.squad_id {
            let (watched, unattended) = crate::agent::squad::squad_orchestrator::approval_gradeline(sid);
            let l3 = request
                .host_meta
                .as_ref()
                .and_then(|m| m.get("l3"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            tracing::info!(
                "[agent] approval: 成员审批梯度 watched={} unattended={} l3={} tool={} approval_id={}",
                watched, unattended, l3, request.tool_name, request.approval_id,
            );
            if unattended && !l3 {
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(ApprovalOutcome::Approve);
                return rx;
            }
            if !watched && !l3 {
                let pending = self.pending.clone();
                let approval_id = request.approval_id.clone();
                tokio::spawn(async move {
                    for _ in 0..2 {
                        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                        if !pending.lock().await.contains_key(&approval_id) { return }
                    }
                    let mut p = pending.lock().await;
                    if let Some(pr) = p.remove(&approval_id) {
                        tracing::info!("[agent] approval: 宽限两轮（240s）无响应，低危自动批准 approval_id={} tool={}", approval_id, pr.request.tool_name);
                        let _ = pr.tx.send(ApprovalOutcome::Approve);
                    }
                });
            }
        }
        let (tx, rx) = oneshot::channel();
        let approval_id = request.approval_id.clone();
        let tool_name = request.tool_name.clone();
        self.pending
            .lock()
            .await
            .insert(approval_id.clone(), Pending { tx, request });
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

    /// 读取挂起中的原始请求（host_grant 写入需要其中的 host_meta / run_id 上下文）。
    pub async fn pending_request(&self, approval_id: &str) -> Option<ApprovalRequest> {
        self.pending.lock().await.get(approval_id).map(|p| p.request.clone())
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

    /// 是否有审批在挂起（供 `agent_get_status` 暴露 `waiting_approval`）。
    pub async fn has_pending(&self) -> bool {
        !self.pending.lock().await.is_empty()
    }

    /// 取当前挂起的审批请求快照（同一时刻通常仅一个）。供 MCP 状态详情向外部 Agent
    /// 透出「正在等哪条高危操作审批」。无挂起时返回 None。
    pub async fn current_request(&self) -> Option<ApprovalRequest> {
        let pending = self.pending.lock().await;
        pending.values().next().map(|p| p.request.clone())
    }
}
