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
/// 成员审批挂起注册表：approvalId → (squadId, agentId, toolName, 决策发送端)。前端工作台审批卡直达。
static SQUAD_APPROVALS: std::sync::Mutex<Option<std::collections::HashMap<String, (String, String, String, oneshot::Sender<ApprovalOutcome>)>>> =
    std::sync::Mutex::new(None);

/// 成员同工具授权短时记忆（复查修复 09-30）：用户对 (小分队, 成员, 工具) 显式批准一次后，
/// TTL 内同类调用自动放行——架构师类成员连写 N 个文件不再连弹 N 次审批。
/// 高危（L3）一律不走记忆；仅人工批准写入（240s 兜底自动批不写入，不自动续期）。
static SQUAD_MEMBER_REMEMBER: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::Mutex::new(None);
const SQUAD_MEMBER_REMEMBER_TTL: std::time::Duration = std::time::Duration::from_secs(600);

fn member_remember_key(squad_id: &str, agent_id: &str, tool: &str) -> String {
    format!("{squad_id}|{agent_id}|{tool}")
}

fn member_remember_hit(squad_id: &str, agent_id: &str, tool: &str) -> bool {
    let key = member_remember_key(squad_id, agent_id, tool);
    let mut g = SQUAD_MEMBER_REMEMBER.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    match map.get(&key) {
        Some(t) if t.elapsed() < SQUAD_MEMBER_REMEMBER_TTL => true,
        Some(_) => {
            map.remove(&key);
            false
        }
        None => false,
    }
}

fn member_remember_insert(squad_id: &str, agent_id: &str, tool: &str) {
    let key = member_remember_key(squad_id, agent_id, tool);
    let mut g = SQUAD_MEMBER_REMEMBER.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    map.retain(|_, t| t.elapsed() < SQUAD_MEMBER_REMEMBER_TTL); // 顺带清理过期项
    map.insert(key, std::time::Instant::now());
}

/// 成员 run 结束/取消时清理该成员的全局审批 sender 与短时授权记忆。
/// 防止取消后的 approvalId 残留在 SQUAD_APPROVALS，后续 UI 继续看到旧卡或误路由。
pub fn clear_member_approvals(squad_id: &str, agent_id: &str) -> usize {
    let mut removed = 0usize;
    let mut g = SQUAD_APPROVALS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, (sid, aid, _, _))| sid == squad_id && aid == agent_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some((_, _, _, tx)) = map.remove(&id) {
                let _ = tx.send(ApprovalOutcome::Skip);
                removed += 1;
            }
        }
    }
    drop(g);
    let prefix = format!("{squad_id}|{agent_id}|");
    let mut rg = SQUAD_MEMBER_REMEMBER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = rg.as_mut() {
        map.retain(|key, _| !key.starts_with(&prefix));
    }
    if removed > 0 {
        tracing::info!("[agent] 成员任务结束清理审批：squad={} agent={} removed={}", squad_id, agent_id, removed);
    }
    removed
}

/// 成员执行函数持有的 RAII 清理守卫：正常完成、取消、超时、panic 早退均清理。
pub struct MemberApprovalGuard {
    squad_id: String,
    agent_id: String,
}

impl MemberApprovalGuard {
    pub fn new(squad_id: impl Into<String>, agent_id: impl Into<String>) -> Self {
        Self { squad_id: squad_id.into(), agent_id: agent_id.into() }
    }
}

impl Drop for MemberApprovalGuard {
    fn drop(&mut self) {
        clear_member_approvals(&self.squad_id, &self.agent_id);
    }
}

/// 列出某编队的待审批项（工作台拉取渲染）。
pub fn pending_member_approvals(squad_id: &str) -> Vec<(String, String)> {
    SQUAD_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|m| {
            m.iter()
                .filter(|(_, (sid, _, _, _))| sid == squad_id)
                .map(|(id, (_, _, tool, _))| (id.clone(), tool.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// 前端审批卡回传决策（approve/skip）。成员审批表里保存的是真实挂起 sender，
/// 因此批准会直接唤醒成员 pipeline，而不是只删除一个 dummy sender。
pub fn resolve_member_approval(approval_id: &str, decision: &str) -> bool {
    let outcome = if decision.eq_ignore_ascii_case("skip") { ApprovalOutcome::Skip } else { ApprovalOutcome::Approve };
    let approved = matches!(outcome, ApprovalOutcome::Approve);
    SQUAD_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .and_then(|m| m.remove(approval_id))
        .map(|(sid, aid, tool, tx)| {
            if approved {
                member_remember_insert(&sid, &aid, &tool);
            }
            tx.send(outcome).is_ok()
        })
        .unwrap_or(false)
}

/// 无人值守低危审批的 2×120s 兜底：只唤醒真实 sender，不写「人工记住」缓存。
fn auto_resolve_member_approval(approval_id: &str) -> bool {
    let entry = SQUAD_APPROVALS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .and_then(|m| m.remove(approval_id));
    entry
        .map(|(_, _, tool, tx)| {
            tracing::info!("[agent] approval: 宽限两轮（240s）无响应，低危自动批准 approval_id={} tool={tool}", approval_id);
            tx.send(ApprovalOutcome::Approve).is_ok()
        })
        .unwrap_or(false)
}

/// 审批挂起超时兜底（单 Agent）：用户不点弹窗时任务不能永久挂死。
pub const SINGLE_AGENT_APPROVAL_TIMEOUT_SECS: u64 = 300;
/// 审批挂起超时兜底（小分队成员）：2026-10-01 复盘——此前沿用 300s 一刀切，用户
/// 打开工作台时审批常已被超时 Skip，LLM 随后原样重试同一工具 → 新 approvalId →
/// 系统通知连发而界面无卡（通知循环）。成员场景给足 15 分钟决策窗口。
pub const MEMBER_APPROVAL_TIMEOUT_SECS: u64 = 900;

/// `ApprovalManager::suspend` 的返回。`needs_emit=false` 表示审批在进入任何挂起表
/// 之前已被策略短路（同工具短时记忆命中 / 无人值守低危自动批）：调用方不得再向
/// 前端广播「等待授权」事件，否则会渲染一张永远无法决议、点掉还报「已失效」的死卡。
pub struct SuspendOutcome {
    pub rx: oneshot::Receiver<ApprovalOutcome>,
    pub needs_emit: bool,
}

/// 审批管理器（托管于 Tauri State）。
#[derive(Clone, Default)]
pub struct ApprovalManager {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    /// 成员所属小分队：审批梯度判定键（工作台观看中挂起等决策 / 不在通知 120s×2 后低危自动批）。
    squad_id: Option<String>,
    /// 成员智能体 id（成员上下文非空）：同工具授权短时记忆的主键之一。
    member_agent_id: Option<String>,
}

impl ApprovalManager {
    /// 是否处于小分队成员上下文（决定事件分流与超时策略）。
    pub fn is_member(&self) -> bool {
        self.squad_id.is_some()
    }

    /// 成员所属小分队 id（仅成员上下文非空；供成员审批事件携带，前端按队过滤）。
    pub fn member_squad_id(&self) -> Option<&str> {
        self.squad_id.as_deref()
    }

    /// 审批挂起超时兜底：成员 900s（给工作台决策留足窗口），单 Agent 维持 300s。
    pub fn approval_timeout_secs(&self) -> u64 {
        if self.squad_id.is_some() {
            MEMBER_APPROVAL_TIMEOUT_SECS
        } else {
            SINGLE_AGENT_APPROVAL_TIMEOUT_SECS
        }
    }
}

impl ApprovalManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            squad_id: None,
            member_agent_id: None,
        }
    }

    /// 成员上下文：审批梯度降级（工作台观看中=挂起等决策；不在=通知 120s×2 后低危自动批；L3 一律挂起）。
    /// 同工具授权短时记忆（复查修复）：本成员对同一工具 TTL 内已人工批准 → 自动放行。
    pub fn for_member(squad_id: String, member_agent_id: String) -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            squad_id: Some(squad_id),
            member_agent_id: Some(member_agent_id),
        }
    }

    /// 挂起等待决策：注册 pending 并立即返回接收端，由调用方 `await`。
    /// 2026-10-01 复盘：挂起注册必须先于前端事件广播（调用方在 `needs_emit=true`
    /// 时才发事件），用户秒点批准不会命中「已失效」；策略短路（记忆/无人值守）时
    /// `needs_emit=false`，前端不弹卡。
    #[tracing::instrument(skip_all)]
    pub async fn suspend(&self, request: ApprovalRequest) -> SuspendOutcome {
        // 成员上下文梯度降级（用户设计）：工作台观看中 → 挂起等决策；不在 → 通知 120s×2 后
        // 低危自动批；L3 高危一律保持挂起。成员审批使用全局表保存真实 sender，
        // squad_member_approval_resolve 才能直接唤醒当前 pipeline。
        if let Some(sid) = &self.squad_id {
            let (watched, unattended) = crate::agent::squad::squad_orchestrator::approval_gradeline(sid);
            let l3 = request
                .host_meta
                .as_ref()
                .and_then(|m| m.get("l3"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let aid = self.member_agent_id.clone().unwrap_or_default();
            tracing::info!(
                "[agent] approval: 成员审批梯度 watched={} unattended={} l3={} tool={} approval_id={}",
                watched, unattended, l3, request.tool_name, request.approval_id,
            );
            if !l3 && member_remember_hit(sid, &aid, &request.tool_name) {
                tracing::info!("[agent] approval: 同工具短时记忆命中，自动放行 tool={} agent={aid}", request.tool_name);
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(ApprovalOutcome::Approve);
                return SuspendOutcome { rx, needs_emit: false };
            }
            // 保持既有 unattended 语义：低危工具立即放行，不进入审批表；L3 仍必须挂起。
            if unattended && !l3 {
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(ApprovalOutcome::Approve);
                return SuspendOutcome { rx, needs_emit: false };
            }
            let (tx, rx) = oneshot::channel();
            let approval_id = request.approval_id.clone();
            let tool_name = request.tool_name.clone();
            SQUAD_APPROVALS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert_with(std::collections::HashMap::new)
                .insert(approval_id.clone(), (sid.clone(), aid, tool_name, tx));
            if !watched && !l3 {
                // 无人值守已在上方立即放行；这里仅覆盖「有人不在工作台」的 2×120s 低危兜底。
                tokio::spawn(async move {
                    for _ in 0..2 {
                        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                        let exists = SQUAD_APPROVALS
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .as_ref()
                            .map(|m| m.contains_key(&approval_id))
                            .unwrap_or(false);
                        if !exists { return; }
                    }
                    let _ = auto_resolve_member_approval(&approval_id);
                });
            }
            // 成员审批不再写入 self.pending；全局表保存的就是实际唤醒 sender。
            return SuspendOutcome { rx, needs_emit: true };
        }

        // 单 Agent 审批：保留原有 manager-local pending + grant_key 机制。
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
        SuspendOutcome { rx, needs_emit: true }
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

    /// 超时/取消时清理挂起项（避免内存泄漏）。成员上下文同时清理全局真实 sender，
    /// 否则 tool_round 超时后旧 approvalId 仍会留在工作台列表并继续触发通知。
    pub async fn cancel(&self, approval_id: &str) {
        let removed_local = self.pending.lock().await.remove(approval_id).is_some();
        let removed_member = if self.squad_id.is_some() {
            let entry = SQUAD_APPROVALS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
                .and_then(|m| m.remove(approval_id));
            entry
                .map(|(_, _, _, tx)| tx.send(ApprovalOutcome::Skip).is_ok())
                .unwrap_or(false)
        } else {
            false
        };
        tracing::info!(
            "[agent] approval: 清理 approval_id={} local_removed={} member_removed={}",
            approval_id, removed_local, removed_member
        );
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


#[cfg(test)]
mod member_approval_tests {
    use super::*;
    use crate::agent::types::ApprovalRequest;

    fn req(id: &str, tool: &str) -> ApprovalRequest {
        ApprovalRequest {
            approval_id: id.into(),
            tool_name: tool.into(),
            description: "test".into(),
            args: "{}".into(),
            kind: "other".into(),
            hint: None,
            reason: None,
            grant_key: None,
            domain: None,
            host_meta: None,
            run_id: None,
        }
    }

    #[tokio::test]
    async fn member_approval_resolve_wakes_real_sender_and_remembers_tool() {
        let manager = ApprovalManager::for_member("sq-test".into(), "agent-test".into());
        assert!(manager.is_member());
        assert_eq!(manager.approval_timeout_secs(), MEMBER_APPROVAL_TIMEOUT_SECS);
        let suspended = manager.suspend(req("ap-test-1", "native__write_file")).await;
        assert!(suspended.needs_emit, "真实挂起必须广播事件，否则工作台无卡");
        assert!(pending_member_approvals("sq-test").iter().any(|(id, tool)| id == "ap-test-1" && tool == "native__write_file"));
        assert!(resolve_member_approval("ap-test-1", "approve"));
        assert!(matches!(suspended.rx.await.unwrap(), ApprovalOutcome::Approve));
        // 同成员同工具在 TTL 内再次请求应自动放行（策略短路）：不新增 pending 卡，也不再广播事件。
        let suspended2 = manager.suspend(req("ap-test-2", "native__write_file")).await;
        assert!(!suspended2.needs_emit, "同工具记忆命中属策略短路，再广播会渲染无法决议的死卡");
        assert!(pending_member_approvals("sq-test").iter().all(|(id, _)| id != "ap-test-2"));
        assert!(matches!(suspended2.rx.await.unwrap(), ApprovalOutcome::Approve));
        clear_member_approvals("sq-test", "agent-test");
    }

    #[tokio::test]
    async fn member_approval_guard_cleans_pending_sender() {
        let manager = ApprovalManager::for_member("sq-guard".into(), "agent-guard".into());
        let suspended = manager.suspend(req("ap-guard-1", "native__write_file")).await;
        assert!(suspended.needs_emit);
        assert_eq!(pending_member_approvals("sq-guard").len(), 1);
        {
            let _guard = MemberApprovalGuard::new("sq-guard", "agent-guard");
        }
        assert!(pending_member_approvals("sq-guard").is_empty());
    }

    #[tokio::test]
    async fn single_agent_approval_keeps_short_timeout_and_emit() {
        let manager = ApprovalManager::new();
        assert!(!manager.is_member());
        assert_eq!(manager.approval_timeout_secs(), SINGLE_AGENT_APPROVAL_TIMEOUT_SECS);
        let suspended = manager.suspend(req("ap-single-1", "native__write_file")).await;
        assert!(suspended.needs_emit);
    }
}
