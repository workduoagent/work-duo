//! 复合任务工具轮执行（S1 拆分自 runtime.rs，台账 §2.1）。
//!
//! run_tool_calls_round：模型返回 tool_calls 后的执行回路（审批分流 / host 域门禁 /
//! 结果回灌 / 连续错误熔断 / ToolRoundStats 统计）。pipeline.rs 经 runtime re-export 调用。

use tokio::time::timeout;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::agent::events;
use crate::agent::engine::llm::StreamOutcome;
use crate::agent::engine::tools::{PermissionLevel, ToolContext, ToolError, ToolRegistry};
use crate::agent::hitl::approval::{ApprovalManager, ApprovalOutcome};
use crate::agent::types::{ApprovalRequest, AgentRuntimeConfig, ToolStep};
use crate::agent::engine::protocol::{parse_tool_call, ParseOutcome};
use crate::agent::engine::runtime::{clip, now_ms};

/// 工具返回结果物理截断阈值（字符）。防止超大输出撑爆上下文、无谓消耗 Token。
const MAX_TOOL_OUTPUT_LENGTH: usize = 15000;
/// 敏感工具审批挂起超时（秒）。超时与「停止」都收敛到拒绝分支，不新增状态通路。
const APPROVAL_TIMEOUT_SECS: u64 = 300;

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
        // 执行工具（台账 D5：注入本次调用的 call_id——host__exec 流式输出事件据此
        // 关联前端工具步骤卡片；其余工具忽略该字段，零影响）
        let call_ctx = ToolContext {
            call_id: Some(call_id.clone()),
            ..ctx.clone()
        };
        let t0 = Instant::now();
        let result = tool.execute(args.clone(), &call_ctx).await;
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

