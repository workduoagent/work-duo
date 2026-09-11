//! 阶段三：流水线隔离执行链（Pipeline Execution / Micro-ReAct）。
//!
//! 彻底废弃全局大 ReAct 循环，由管道驱动器顺序调度原子子任务：
//! - 每个子任务拥有**完全独立的 messages**（0 历史包袱）；
//! - 子任务间仅靠「产物管道」（前序步骤的纯文本摘要）单向传递信息；
//! - 子任务内部几万字工具报文随作用域结束**物理销毁**，绝不流入下一环；
//! - 全局物理基建共享：同一工具注册表、同一 Micromamba 沙箱、同一 `.wd_mem` 工作区。
//!
//! 失败策略（用户确认）：子任务失败立即进入步骤级恢复挂起（RecoveryHub），由用户决定重试 / 跳过 / 接管；
//! 不再做自动重试循环——恢复决策权交还用户，避免无人值守下反复重跑同一失败步骤。
//!
//! 图驱动（见《单 Agent 统一实体图》）：pipeline 的运行时状态**唯一载体是 `KnowledgeGraph`**——
//! 旧的 `started` / `completed` / `guidance_map` / `retry_counts` 四个 HashMap 与 `outputs` 全部收编进图节点，
//! 调度从 `graph.topo_ready` 取就绪任务，产物写图（`add_produced_artifacts`），恢复改图节点状态。

use serde_json::json;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use futures_util::future::join_all;

use crate::agent::approval::ApprovalManager;
use crate::agent::context;
use crate::agent::events;
use crate::agent::graph::KnowledgeGraph;
use crate::agent::recovery::RecoveryDecision;
use crate::agent::recovery::RecoveryHub;
use crate::agent::recovery::RecoveryRequest;
use crate::agent::runtime;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::PlanSubTask;
use crate::agent::types::SubTaskOutput;

/// 微 ReAct 局部熔断：单个子任务「工具轮」上限（正常子任务 1~2 轮即可闭环）。
/// 注意：仅「调用了工具的轮」计入此预算；模型只发文本汇报的终态轮不计入，
/// 确保「产物已生成、但预算都花在工具上、没机会发汇报」的子任务不会被误判未闭环。
const MAX_SUBTASK_ITERATIONS: usize = 8;
/// 子任务内连续工具错误即时拦截阈值。
const MAX_SUBTASK_CONSECUTIVE_ERRORS: usize = 2;
/// 自动执行模式下同一批次内最大并发子任务数。
/// **已废弃**：单 Agent 已强制串行（max_parallel=1），保留常量仅作占位，避免引用点大规模改动。
/// 并行副作用（文件写入冲突 / 上下文黑域 / 恢复面板弹窗风暴 / 工具调用步骤归属错乱）在并行下无法根除，
/// 串行化后这些问题自然消失。
#[allow(dead_code)]
const MAX_PARALLEL_SUBTASKS: usize = 3;
/// 单步恢复次数上限（P1-5）：同一步骤进入步骤级恢复的次数超过该值后，自动跳过该步，
/// 以打破无人值守 / 同因持续失败场景下的「弹窗→处理→再失败」无限重试循环。
const MAX_TASK_RECOVERY_ATTEMPTS: usize = 3;

/// 流水线执行结果。
pub struct PipelineResult {
    pub final_text: String,
    pub usage: (u64, u64),
    #[allow(dead_code)]
    pub success: bool,
    /// 是否被用户中途取消（cancel_agent_task 触发）：取消时流水线提前整体收尾，
    /// run_task 据此跳过正常 round 持久化并推送取消提示。
    pub cancelled: bool,
    /// 取消来源说明（问题 1 修复）：`None`=用户主动点击停止（文案「任务已被用户取消」）；
    /// `Some(reason)`=系统自动取消（当前仅无人值守恢复超时一种来源），run_task 据此分流文案，
    /// 避免 schedule/api 模式下把超时自动取消误报成「用户取消」。
    pub cancel_reason: Option<String>,
}

/// DAG 拓扑调度图中全部原子子任务（#10）。
///
/// 依据 `depends_on` 做拓扑就绪判定（`graph.topo_ready`）：某步骤仅在其全部前置步骤成功后进入 READY；
/// 步骤按拓扑就绪顺序逐个串行执行（`max_parallel=1`，`join_all` 中仅一个 future）。
/// 子任务失败经自动重试（MAX_SUBTASK_RETRIES）后仍不闭环 → 步骤级恢复挂起（#8）。
///
/// 图驱动：所有运行时状态存于 `graph`（任务节点 status / guidance / retryCount / summary），
/// 不再使用 `started` / `completed` / `guidance_map` / `retry_counts` HashMap。

/// 构建技能指引段：把已绑定技能的工作流说明注入子任务 user 消息，
/// 替代「模型调用 skill__xxx 工具拿指引再干活」的反模式（每个子任务省 1~2 轮 LLM 调用）。
/// 多技能仅注入 name + description 摘要（全文靠模型按需 read_file）；整体控制在 2000 字符内截断。
fn build_skill_guidance(skills: &[crate::agent::skill_adapter::SkillToolWrapper]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "【可用技能指引】\n若任务涉及以下领域，请严格遵循对应技能的工作流直接执行，不要调用任何 skill__ 前缀的工具：\n",
    );
    const BUDGET: usize = 2000;
    for s in skills {
        out.push_str(&format!("\n### 技能：{}\n{}\n", s.skill_name, s.skill_description));
    }
    // 单个技能时附 SKILL.md 全文（截断到预算余量），多技能仅保留摘要，避免 prompt 膨胀。
    if skills.len() == 1 {
        let md = &skills[0].skill_markdown;
        if !md.trim().is_empty() {
            let used = out.chars().count();
            if used < BUDGET {
                let remaining = BUDGET - used;
                let snippet: String = md.chars().take(remaining).collect();
                out.push_str(&format!("\n---\n{}\n", snippet));
            }
        }
    }
    if out.chars().count() > BUDGET {
        out = out.chars().take(BUDGET).collect();
    }
    out
}

#[tracing::instrument(skip_all)]
pub async fn run_pipeline(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    registry: &ToolRegistry,
    ctx: &ToolContext,
    approval: &ApprovalManager,
    graph: &mut KnowledgeGraph,
    session_id: &str,
    cancel: &Arc<AtomicBool>,
    recovery: &Arc<RecoveryHub>,
    // P2-3 模式感知恢复：无人值守模式（schedule/api）下，子任务恢复等待超时后自动取消整条流水线，
    // 防止无人值守死锁；手动模式（manual）恒为 false，恢复等待保持永久阻塞（行为完全不变）。
    unattended: bool,
) -> PipelineResult {
    // 步数只统计「本轮」任务：二次规划会把上一轮节点置 obsolete（已被取代），
    // 不计入本轮步数，否则同会话多轮会显示「步骤 1/N（N 含历史）」且回复聚合所有历史步骤。
    let total = graph
        .session_tasks(session_id)
        .iter()
        .filter(|n| {
            let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
            s != "obsolete"
        })
        .count();
    let mut total_usage: (u64, u64) = (0, 0);

    // 单 Agent 强制串行（问题修复）：同一时刻仅执行一个子任务，消除多步并行导致的
    // 文件写入冲突、上下文黑域、恢复面板弹窗风暴、工具调用步骤归属错乱等问题。
    // 不再按 auto_tool_exec_mode 区分并行度（MAX_PARALLEL_SUBTASKS 已废弃，仅保留常量占位）。
    let max_parallel: usize = 1;

    // P2-1 滚动摘要注入：流水线开始一次性读取会话背景（只读一次，不每子任务各查一遍 DB），
    // 作为可选背景段注入每个子任务的 user 消息；session_id 为 None（squad 成员路径）时返回 None。
    let background = match context::load_session_background(app, cfg).await {
        Some(b) if !b.trim().is_empty() => b,
        _ => String::new(),
    };

    loop {
        if cancel.load(Ordering::SeqCst) {
            return PipelineResult {
                final_text: "任务已被用户取消。".to_string(),
                usage: total_usage,
                success: false,
                cancelled: true,
                cancel_reason: None,
            };
        }
        // 拓扑就绪：status=pending 且全部 depends_on 源节点 status ∈ {completed, skipped}。
        let ready = graph.topo_ready(session_id);
        if ready.is_empty() {
            // 全完成 → 退出；否则存在死锁（循环依赖 / 引用了不存在的步骤）。
            if graph.session_all_completed(session_id) {
                break;
            }
            let stuck = graph
                .session_tasks(session_id)
                .iter()
                .filter(|n| {
                    let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    // obsolete 是二次规划/分支重跑产生的「已被取代」终态，不算受阻步骤，
                    // 否则会把上一轮被取代的节点误报为死锁（与 graph.rs::session_all_completed 一致）。
                    s != "completed" && s != "skipped" && s != "obsolete"
                })
                .map(|n| {
                    format!(
                        "{}「{}」(status={})",
                        n.props.get("step").and_then(|v| v.as_u64()).unwrap_or(0),
                        n.props.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                        n.props.get("status").and_then(|v| v.as_str()).unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("、");
            let report = format!(
                "任务存在无法解决的步骤依赖（疑似循环依赖或引用了不存在的步骤），受阻步骤：{}",
                stuck,
            );
            tracing::info!("[agent] pipeline: 依赖死锁，中止：{}", report);
            return PipelineResult {
                final_text: report,
                usage: total_usage,
                success: false,
                cancelled: false,
                cancel_reason: None,
            };
        }
        // 串行：本批仅取 1 个（max_parallel=1），其余下轮（依赖解除后）再拾起。
        let batch: Vec<String> = ready.into_iter().take(max_parallel).collect();
        // 标记 running + 推送 step_started
        for id in &batch {
            graph.set_task_status(id, "running");
            graph.update_node(id, json!({ "startedAt": now_ms() }));
            let (step, title) = node_step_title(graph, id);
            events::emit_step_started(app, step, total, &title);
        }
        // 并发执行本批（join_all 在同一任务内并发轮询，复用共享工具注册表/沙箱/工作区）。
        // 单 Agent 路径下 join_all 并发但图变更在 join_all 之后统一在主循环串行处理，无需锁。
        let futures = batch.iter().map(|id| {
            let pst = graph.task_to_plan(id).expect("task node 必存在");
            let tc = graph.task_context(id);
            let prior = if tc.prior_summary.trim().is_empty() {
                "(无，你是第一个步骤)".to_string()
            } else {
                tc.prior_summary.clone()
            };
            run_subtask(
                app,
                cfg,
                registry,
                ctx,
                approval,
                pst,
                total,
                prior,
                cancel,
                tc.guidance.clone(),
                &background,
            )
        });
        let results = join_all(futures).await;

        // 先累加用量，再按结果分类（成功→completed；失败→failed 待恢复）。
        let mut failures: Vec<(usize, SubTaskOutput)> = Vec::new();
        for (i, (out, usage)) in results.into_iter().enumerate() {
            total_usage.0 += usage.0;
            total_usage.1 += usage.1;
            events::emit_token_update(app, total_usage.0, total_usage.1);
            if out.cancelled {
                return PipelineResult {
                    final_text: "任务已被用户取消。".to_string(),
                    usage: total_usage,
                    success: false,
                    cancelled: true,
                    cancel_reason: None,
                };
            }
            let task_node_id = &batch[i];
            let (step, title) = node_step_title(graph, task_node_id);
            if out.success {
                graph.update_node(
                    task_node_id,
                    json!({
                        "status": "completed",
                        "summary": out.summary,
                        "tokenInput": usage.0,
                        "tokenOutput": usage.1,
                        "completedAt": now_ms(),
                    }),
                );
                // 成功闭环：产物写图（ArtifactNode + Produced 边）。
                graph.add_produced_artifacts(task_node_id, &out.artifacts);
                // 成功闭环：补发 step_finished(ok=true)。否则前端步骤状态停在 running，
                // 任务结束时会被 useAgentSession.finalizeStuckSteps 兜底误判为失败。
                events::emit_step_finished(app, step, total, &title, true, &out.summary);
            } else {
                // 失败：标记 failed（下一轮 topo_ready 不再拾起），并标记 failed 供 UI 高亮；
                // 恢复决策（Retry/Skip/Takeover）会把状态改回 pending/skipped。
                graph.set_task_status(task_node_id, "failed");
                graph.update_node(task_node_id, json!({ "summary": out.summary, "failureReason": out.summary }));
                events::emit_step_finished(app, step, total, &title, false, &out.summary);
                failures.push((i, out));
            }
        }

        // 本批有失败 → 逐个进入步骤级恢复（修复 P1-5：原先只取第一个失败步，
        // 其余失败步被静默重跑，同因失败时会形成「弹窗→处理→再失败」死循环）。
        // 现对批内每个失败步都呈现恢复决策（逐一弹窗，前端依次处理），并对单步恢复次数
        // 设上限，防止无人值守 / 同因持续失败场景下的无限重试循环。
        if !failures.is_empty() {
            for (i, out) in failures.into_iter() {
                let task_node_id = batch[i].clone();
                let (step, title) = node_step_title(graph, &task_node_id);
                // 单步恢复次数上限：进入恢复块的累计次数。超过上限则自动跳过该步，
                // 打破可能的无限重试循环（用户仍能在前端看到「自动跳过」状态）。
                let attempts = graph
                    .get_node(&task_node_id)
                    .and_then(|n| n.props.get("retryCount").and_then(|v| v.as_u64()))
                    .unwrap_or(0) as usize
                    + 1;
                if attempts > MAX_TASK_RECOVERY_ATTEMPTS {
                    tracing::warn!(
                        "[agent] pipeline: 步骤 {}「{}」恢复次数已达上限 {}，自动跳过以打破重试循环",
                        step, title, MAX_TASK_RECOVERY_ATTEMPTS
                    );
                    events::emit_status(
                        app,
                        &format!(
                            "步骤 {}/{}：恢复次数已达上限 {}，自动跳过该步骤",
                            step, total, MAX_TASK_RECOVERY_ATTEMPTS
                        ),
                    );
                    graph.update_node(
                        &task_node_id,
                        json!({
                            "status": "skipped",
                            "summary": format!("（已达最大恢复次数 {}，自动跳过）", MAX_TASK_RECOVERY_ATTEMPTS),
                        }),
                    );
                    events::emit_step_finished(app, step, total, &title, true, "（自动跳过：恢复次数达上限）");
                    continue;
                }
                let req = RecoveryRequest {
                    step,
                    task_id: task_node_id.clone(),
                    title: title.clone(),
                    reason: out.summary.clone(),
                    summary: String::new(),
                    tier: "A".into(),
                    failed_command: None,
                    changed_files: None,
                };
                events::emit_recovery_needed(app, &req);
                // 提前克隆失败原因：下面 `recovery.request(req)` 会 move 走 `req`，
                // 而「继续并托管」自愈分支需要用到该原因回灌 guidance。
                let blocked_reason = req.reason.clone();
                recovery.request(req);
                // P2-3 模式感知恢复：手动模式（unattended=false）保持永久阻塞等待用户决策，
                // 行为完全不变；无人值守模式（schedule/api）下若 120s 内无响应则自动取消整条流水线，
                // 避免无人值守下因恢复面板无人处理而卡死。超时包的是 `recovery.wait()`，非子任务执行。
                let decision = if unattended {
                    match tokio::time::timeout(Duration::from_secs(120), recovery.wait(cancel)).await {
                        Ok(d) => d,
                        Err(_) => {
                            tracing::warn!(
                                "[agent] pipeline: 无人值守模式步骤 {}「{}」恢复等待超时（120s），自动取消整条流水线",
                                step, title
                            );
                            events::emit_status(
                                app,
                                &format!(
                                    "步骤 {}/{}：无人值守模式恢复超时，自动取消任务",
                                    step, total
                                ),
                            );
                            // 问题 2 修复：timeout drop 掉 wait() Future 时 pending 仍为 Some，
                            // 前端恢复面板不会自动收起。此处显式清挂起态，面板可正常收起。
                            recovery.reset();
                            return PipelineResult {
                                final_text: format!(
                                    "无人值守模式步骤 {}「{}」恢复等待超时，已自动取消任务。",
                                    step, title
                                ),
                                usage: total_usage,
                                success: false,
                                cancelled: true,
                                cancel_reason: Some(format!(
                                    "无人值守模式步骤 {}「{}」恢复等待超时，已自动取消任务",
                                    step, title
                                )),
                            };
                        }
                    }
                } else {
                    recovery.wait(cancel).await
                };
                match decision {
                    RecoveryDecision::Retry => {
                        graph.update_node(
                            &task_node_id,
                            json!({ "status": "pending", "retryCount": attempts }),
                        );
                        events::emit_step_started(app, step, total, &title);
                        events::emit_status(app, &format!("步骤 {}/{}：用户选择重试", step, total));
                    }
                    RecoveryDecision::Skip => {
                        graph.update_node(
                            &task_node_id,
                            json!({
                                "status": "skipped",
                                "summary": "（已跳过：用户选择跳过该步骤）".to_string(),
                            }),
                        );
                        events::emit_step_finished(app, step, total, &title, true, "（已跳过）");
                    }
                    RecoveryDecision::Takeover(g) => {
                        // 「继续并托管」= 让用户把决策权交回 Agent 自愈。若用户未手写补充指示，
                        // 不能原样重跑（否则同一破碎的 success_criteria → 同一校验失败 → 又弹同一窗，
                        // 死循环且「根本不管用」）。改为自动把上次校验失败原因回灌为 guidance，
                        // 让 Agent 带着诊断自主修复后重试。
                        let guidance = if g.trim().is_empty() {
                            let reason = blocked_reason.trim();
                            if reason.is_empty() {
                                "上次执行未闭环，请自主诊断根因并修复后重试。".to_string()
                            } else {
                                format!(
                                    "上次执行未闭环，失败原因如下，请基于该诊断自主修复后重试（不要重复同样的做法）：\n{reason}"
                                )
                            }
                        } else {
                            g
                        };
                        graph.update_node(
                            &task_node_id,
                            json!({ "status": "pending", "retryCount": attempts, "guidance": guidance }),
                        );
                        events::emit_step_started(app, step, total, &title);
                        events::emit_status(
                            app,
                            &format!("步骤 {}/{}：用户接管并补充指示后重试", step, total),
                        );
                    }
                    RecoveryDecision::ChangeApproach(g) => {
                        // 改方案（Phase 2b 启用）：回灌错误摘要 + 已试路径，要求 Agent 换思路重规划。
                        // 2a 尚未接前端「改方案」按钮，此臂为穷尽匹配占位，行为与 Takeover 一致（带诊断重试）。
                        let guidance = if g.trim().is_empty() {
                            let reason = blocked_reason.trim();
                            if reason.is_empty() {
                                "上次执行未闭环，请换一种思路重规划后重试（不要重复同样的做法）。".to_string()
                            } else {
                                format!(
                                    "上次执行未闭环，失败原因如下，请换一种思路重规划后重试（不要重复同样的做法）：\n{reason}"
                                )
                            }
                        } else {
                            g
                        };
                        graph.update_node(
                            &task_node_id,
                            json!({ "status": "pending", "retryCount": attempts, "guidance": guidance }),
                        );
                        events::emit_step_started(app, step, total, &title);
                        events::emit_status(
                            app,
                            &format!("步骤 {}/{}：用户要求改方案后重试", step, total),
                        );
                    }
                    RecoveryDecision::Cancel => {
                        return PipelineResult {
                            final_text: "任务已被用户取消。".to_string(),
                            usage: total_usage,
                            success: false,
                            cancelled: true,
                            cancel_reason: None,
                        };
                    }
                }
            }
            // 循环回到就绪判定：被恢复的步骤（status 已改回 pending）将重新被拾起执行。
            continue;
        }
    }

    // 全部子任务闭环：自检验证（基于真实产物合成 selfcheck 层思考，供轨迹视图按层着色）。
    // 遍历图会话任务节点统计（成功闭环 / 跳过 / 产物），不臆造未发生的校验。
    {
        // 自检验证只统计本轮（非 obsolete）任务，排除上一轮被取代的历史节点。
        let tasks: Vec<_> = graph
            .session_tasks(session_id)
            .into_iter()
            .filter(|n| {
                let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
                s != "obsolete"
            })
            .collect();
        let real_ok = tasks
            .iter()
            .filter(|n| {
                let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let skipped = n.props.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false);
                s == "completed" && !skipped
            })
            .count();
        let skip_count = tasks
            .iter()
            .filter(|n| n.props.get("status").and_then(|v| v.as_str()) == Some("skipped"))
            .count();
        let mut art_count: usize = 0;
        let mut art_names: Vec<String> = Vec::new();
        for n in &tasks {
            for a in graph.task_artifacts(&n.id) {
                art_count += 1;
                if let Some(d) = a.props.get("description").and_then(|v| v.as_str()) {
                    art_names.push(d.to_string());
                }
            }
        }
        let skip_note = if skip_count > 0 {
            format!("（{skip_count} 个被跳过）")
        } else {
            String::new()
        };
        let mut sc = format!(
            "自检验证：共 {} 个规划步骤，{} 个成功闭环{}，产出 {} 个文件产物。",
            total, real_ok, skip_note, art_count
        );
        if art_count > 0 {
            sc.push_str(&format!(" 产物：{}。", art_names.join("、")));
        }
        events::emit_thinking_chunk(app, &sc, true, "selfcheck");
    }

    // 全部子任务闭环：合并全局执行视图（从图会话任务节点读取，跳过步用 ⏭️ 单独标注）。
    // 最终答复：直接给出各步骤的实际产出摘要，不再前置用户问题、不再加「执行过程回顾」脚手架
    // 与 ✅/⏭️ 步骤标题（用户明确要求简洁、去 AI 味）。多步以空行分隔，单步即为该步摘要。
    // 最终答复只聚合本轮（非 obsolete）任务的摘要：排除上一轮被 `plan_to_graph` 置为
    // `obsolete` 的历史步骤，否则同会话多轮会把 phase5/phase6/phase7/phase8 等历史 summary
    // 全拼进回复（用户实测「回复文字复述所有历史步骤」的根因）。
    // 图驱动回复：仅聚合本轮（非 obsolete）TaskNode 的真实数据，杜绝「模型 summary 复述历史文件名」。
    // 产物文件名优先取自本步 TaskNode 的 success_criteria.target —— 这是 planner 从用户当轮 prompt
    // 解析的真实目标文件（写进图，不含任何历史文件名污染）；无文件任务（target 为空）才降级用模型
    // summary（纯对话/读取类，无历史文件名污染风险）。失败/跳过步用图节点 status 与 summary（图真实错误）。
    let tasks: Vec<_> = graph
        .session_tasks(session_id)
        .into_iter()
        .filter(|n| {
            let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
            s != "obsolete"
        })
        .collect();
    let review_lines: Vec<String> = tasks
        .iter()
        .filter_map(|n| {
            let step = n.props.get("step").and_then(|v| v.as_u64()).unwrap_or(0);
            let status = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let summary = n
                .props
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            // 从图读取本步真实目标文件（planner 写入的 success_criteria.target），代码层约束，非 prompt。
            let mut names: Vec<String> = Vec::new();
            if let Some(plan) = graph.task_to_plan(&n.id) {
                for t in plan.success_criteria.iter().filter_map(|c| c.target.clone()) {
                    let t = t.trim();
                    if t.is_empty() {
                        continue;
                    }
                    let name = std::path::Path::new(t)
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or(t)
                        .to_string();
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
            // 日志保留「步骤 N」便于定位（用户回复中不展示，去 AI 味、简洁）。
            tracing::info!(
                "[agent] pipeline: 回复聚合 步骤 {} status={} 产物={:?} summary_len={}",
                step,
                status,
                names,
                summary.len()
            );
            // 回复面向用户，不展示「步骤 N」这类内部调度术语（用户明确要求去 AI 味、简洁）。
            let content = match status {
                "completed" => {
                    if !names.is_empty() {
                        format!("已生成/更新 {}", names.join("、"))
                    } else if !summary.is_empty() {
                        summary // 无文件任务：纯对话/读取，降级模型 summary（无污染风险）
                    } else {
                        "已完成".to_string()
                    }
                }
                "failed" => {
                    if !summary.is_empty() {
                        format!("执行失败 - {}", summary)
                    } else {
                        "执行失败".to_string()
                    }
                }
                "skipped" => "已跳过".to_string(),
                _ => {
                    if !summary.is_empty() {
                        summary
                    } else {
                        return None;
                    }
                }
            };
            Some(content)
        })
        .collect();
    let final_text = if review_lines.is_empty() {
        "任务已完成。".to_string()
    } else {
        review_lines.join("\n\n")
    };
    tracing::info!(
        "[agent] pipeline: 全部 {} 个子任务闭环，总 usage=({},{})",
        total, total_usage.0, total_usage.1,
    );
    PipelineResult {
        final_text,
        usage: total_usage,
        success: true,
        cancelled: false,
        cancel_reason: None,
    }
}

/// 从任务节点读取 (step, title)，供事件推送。
fn node_step_title(graph: &KnowledgeGraph, id: &str) -> (usize, String) {
    match graph.get_node(id) {
        Some(n) => (
            n.props.get("step").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
            n.props
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        None => (0, String::new()),
    }
}

/// 执行单个原子子任务（微 ReAct 循环，独立上下文）。
/// 返回 (子任务结算输出, 本次真实 token 用量)。
#[allow(clippy::too_many_arguments)]
async fn run_subtask(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    registry: &ToolRegistry,
    ctx: &ToolContext,
    approval: &ApprovalManager,
    task: PlanSubTask,
    total: usize,
    prior_summary: String,
    cancel: &Arc<AtomicBool>,
    guidance: String,
    // P2-1 滚动会话背景（来自 load_session_background）：非空时作为「会话背景摘要」段注入 user 消息，
    // 让工具型子任务感知「用户说过什么 / 已确认什么结论」，但不感知工具报文。空则不注入（保持现状）。
    background: &str,
) -> (SubTaskOutput, (u64, u64)) {
    // 认知上下文绝对隔离：崭新的 messages，0 历史包袱。
    let t0 = Instant::now(); // 子任务级耗时基准（闭环日志用）
    let prior = if prior_summary.trim().is_empty() {
        "（无，你是第一个步骤）".to_string()
    } else {
        prior_summary
    };
    // 把本步骤声明的 success_criteria 转成「硬性产出要求」注入执行 prompt，
    // 让执行器写出的文件名/路径与校验器检查的前置条件严格一致。
    // 修复 LLM「计划端命名」与「执行端命名」自相矛盾导致客观校验误判未闭环的问题
    // （例如 planner 声明产出 bnb_weekly_summary_forecast.md，执行端却写成 bnb_weekly_report.md）。
    let criteria_hint = if task.success_criteria.is_empty() {
        String::new()
    } else {
        let mut lines: Vec<String> = vec![
            "【本步骤成功判定的硬性产出要求（必须严格满足；文件名/路径须与之一致，不要自行改名或合并到其他文件）】："
                .to_string(),
        ];
        for c in &task.success_criteria {
            let ct = c.check_type.to_lowercase();
            match ct.as_str() {
                "file_nonempty" | "file_exists" | "directory_exists" | "excel_row_count" => {
                    if let Some(t) = &c.target {
                        lines.push(format!(
                            "  - 必须生成并保留{}{}",
                            if ct == "directory_exists" { "目录：" } else { "文件：" },
                            t
                        ));
                    }
                }
                "json_valid" => {
                    if let Some(t) = &c.target {
                        lines.push(format!("  - 文件 {t} 必须是合法 JSON"));
                    }
                }
                "text_contains" => {
                    if let Some(t) = &c.target {
                        let v = c.value.clone().unwrap_or_default();
                        // 多关键词（| 分隔）渲染为「任一即可」清单，与 verifier 的多候选容错一致。
                        let cands: Vec<&str> = v
                            .split('|')
                            .map(|x| x.trim())
                            .filter(|x| !x.is_empty())
                            .collect();
                        let req = if cands.len() > 1 {
                            format!(
                                "  - 文件 {t} 内容须包含以下任一关键词即可：{}",
                                cands.join(" / ")
                            )
                        } else {
                            format!("  - 文件 {t} 内容须包含：{v}")
                        };
                        lines.push(req);
                    }
                }
                "text_min_lines" => {
                    if let Some(t) = &c.target {
                        let n = c.threshold.unwrap_or(1);
                        lines.push(format!("  - 文件 {t} 行数须 ≥ {n}"));
                    }
                }
                other => {
                    if let Some(t) = &c.target {
                        lines.push(format!("  - 校验 {other}：{t}"));
                    }
                }
            }
        }
        if lines.len() > 1 {
            format!("\n\n{}\n", lines.join("\n"))
        } else {
            String::new()
        }
    };
    // 本步骤核心任务内容（独立于会话背景，便于 background 段按需前置拼接）。
    // 注：文件名/回复准确性约束已改为图驱动（见上方 run_pipeline 最终回复从 success_criteria.target
    // 聚合真实产物；context.rs §5.9 背景只注入历史步骤 title 而非文件名），此处不再用 prompt 软约束
    // （小模型易忽略且不可靠）。
    let task_content = format!(
        "【当前任务目标（步骤 {}/{}）】：{}\n任务详述：{}\n\n【前序步骤已交付产物】：\n{}{}\n\n请直接使用对应工具执行当前步骤；确认产物已成功生成后，立即给出简明结果汇报（包含产出文件的完整路径）。{}",
        task.step, total, task.title, task.description, prior, criteria_hint,
        if guidance.trim().is_empty() {
            String::new()
        } else {
            format!(
                "\n\n【用户手动补充指示（接管/重试时提供）】：{}\n请结合该指示重新执行本步骤。",
                guidance.trim()
            )
        }
    );
    // 技能指引段：把已绑定技能的工作流注入 user 消息（替代「模型先调 skill__xxx 拿指引再干活」的浪费轮次）。
    // 空（未绑定技能）则不插入。
    let skill_guidance = build_skill_guidance(&cfg.skill_tools);
    // P2-1 会话背景摘要段：仅进当前轮 user 消息（不污染 system_prompt，避免影响其他会话），
    // 为空（无滚动摘要 / squad session_id=None）则不插入，子任务 prompt 与现状完全一致。
    let user_content = if background.trim().is_empty() {
        if skill_guidance.is_empty() {
            task_content
        } else {
            format!("{}\n\n{}", skill_guidance, task_content)
        }
    } else {
        let bg = format!("【会话背景摘要】\n{}\n\n{}", background.trim(), task_content);
        if skill_guidance.is_empty() {
            bg
        } else {
            format!("{}\n\n{}", skill_guidance, bg)
        }
    };
    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": &cfg.system_prompt }),
        json!({
            "role": "user",
            "content": user_content
        }),
    ];

    let tools = registry.get_tools_for_llm();
    let mut usage: (u64, u64) = (0, 0);
    let mut consecutive_errors = 0usize;

    tracing::info!(
        "[agent] pipeline: 子任务开始 step={}/{} title={} 工具数={}",
        task.step,
        total,
        task.title,
        tools.len(),
    );

    let mut round = 0usize; // 总 LLM 轮次（仅日志用）
    let mut tool_iterations = 0usize; // 工具轮次（计入预算；终态汇报轮不计入）
    let mut last_tool_error: Option<String> = None; // 最近一次工具失败的错误（回显到恢复面板原因）

    loop {
        // 每轮开始前检查取消：用户点击「停止」后，下一轮边界立即终止本子任务，
        // 不再发起新的 LLM 调用（正在进行的流会在 call_llm_stream 内部断流）。
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            tracing::info!(
                "[agent] pipeline: 子任务 step={} 第 {} 轮前检测到取消信号，终止",
                task.step, round,
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: "任务已被用户取消".to_string(),
                    success: false,
                    cancelled: true,
                    skipped: false,
                    artifacts: vec![],
                },
                usage,
            );
        }
        round += 1;
        // 协议安全过滤：每次调用前无条件执行配对自检（彻底防 400）。
        runtime::sanitize_message_sequence(&mut messages);

        // LLM 调用（含瞬态错误自动重试 + 指数退避）：429/网络抖动/超时等瞬态故障
        // 不再直接抛给用户恢复面板，避免把可自愈的临时故障变成人工阻塞（问题二根因）。
        let mut outcome: runtime::StreamOutcome;
        let max_llm_retry = 3u32;
        let mut llm_attempt = 0u32;
        let mut llm_err: String;
        loop {
            match runtime::call_llm_stream(app, cfg, &messages, &tools, cancel, None).await {
                Ok(o) => {
                    outcome = o;
                    break;
                }
                Err(e) => {
                    llm_err = e.to_string();
                    // 取消优先：已取消不再重试，直接终止。
                    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                        return (
                            SubTaskOutput {
                                step: task.step,
                                title: task.title.clone(),
                                summary: "任务已被用户取消".to_string(),
                                success: false,
                                cancelled: true,
                                skipped: false,
                                artifacts: vec![],
                            },
                            usage,
                        );
                    }
                    llm_attempt += 1;
                    if llm_attempt > max_llm_retry {
                        tracing::info!(
                            "[agent] pipeline: 子任务 step={} 第 {} 轮 LLM 调用重试 {} 次仍失败：{}",
                            task.step, round, max_llm_retry, llm_err
                        );
                        return (
                            SubTaskOutput {
                                step: task.step,
                                title: task.title.clone(),
                                summary: format!("LLM 调用失败：{llm_err}"),
                                success: false,
                                cancelled: false,
                                skipped: false,
                                artifacts: vec![],
                            },
                            usage,
                        );
                    }
                    let backoff = 1000u64 * llm_attempt as u64; // 1s, 2s, 3s
                    tracing::info!(
                        "[agent] pipeline: 子任务 step={} 第 {} 轮 LLM 调用失败（瞬态），第 {}/{} 次重试，退避 {}ms：{}",
                        task.step, round, llm_attempt, max_llm_retry, backoff, llm_err
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
                }
            }
        }

        // 取消优先：流式返回后若已取消，立即终止子任务并标记取消，绝不进入下方
        // 「流式空响应回退」非流式调用——否则会把整段 prompt 再发给网关一遍（重复计费），
        // 且回退得到的决策本就作废。这是「停止按钮即时生效、不重复计费」的关键。
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            tracing::info!(
                "[agent] pipeline: 子任务 step={} 流式返回后检测到取消信号，终止",
                task.step,
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: "任务已被用户取消".to_string(),
                    success: false,
                    cancelled: true,
                    skipped: false,
                    artifacts: vec![],
                },
                usage,
            );
        }
        // 流式空响应兜底：个别网关不支持流式 tool_calls，回退一次非流式拿真实决策。
        // 仅在未取消时执行（取消已在上方面退出），避免重复计费。
        if outcome.content.trim().is_empty() && outcome.tool_calls.is_empty() {
            tracing::info!(
                "[agent] pipeline: 子任务 step={} 第 {} 轮流式空响应，回退非流式兜底",
                task.step, round
            );
            match runtime::call_llm(cfg, &messages, &tools).await {
                Ok((choice, u)) => {
                    outcome = runtime::StreamOutcome {
                        content: choice
                            .get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        reasoning: String::new(),
                        tool_calls: choice
                            .get("tool_calls")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default(),
                        usage: u,
                    };
                }
                Err(e) => {
                    return (
                        SubTaskOutput {
                            step: task.step,
                            title: task.title.clone(),
                            summary: format!("LLM 兜底调用失败：{e}"),
                            success: false,
                            cancelled: false,
                            skipped: false,
                            artifacts: vec![],
                        },
                        usage,
                    );
                }
            }
        }
        usage.0 += outcome.usage.0;
        usage.1 += outcome.usage.1;

        tracing::info!(
            "[agent] pipeline: 子任务 step={} 第 {} 轮 LLM 返回 | 正文={}字符 tool_calls={}个 usage=({},{})",
            task.step,
            round,
            outcome.content.chars().count(),
            outcome.tool_calls.len(),
            outcome.usage.0,
            outcome.usage.1,
        );

        // 终态：无工具调用 → 产物摘要结算。
        // 关键修复：汇报轮（tool_calls 为空）不计入工具预算，确保「产物已生成、
        // 但模型把全部预算花在工具调用上、没机会发终态汇报」的子任务不会被误判未闭环。
        if outcome.tool_calls.is_empty() {
            let summary = outcome.content.trim().to_string();
            let mut success = !summary.is_empty();
            // L0/L1 确定性校验（#9）：子任务声明了 success_criteria 时，无论模型是否自报成功，
            // 都必须通过文件/内容层面的客观校验，否则判为未闭环（进入恢复链路）。
            let mut verify_detail = String::new();
            if success && !task.success_criteria.is_empty() {
                let result = crate::agent::verifier::verify_task(&task, ctx.workspace.as_deref());
                if !result.met {
                    success = false;
                    verify_detail = result.details;
                    tracing::info!(
                        "[agent] pipeline: 子任务 step={} 客观校验未通过：{}",
                        task.step,
                        runtime::clip(&verify_detail, 200),
                    );
                }
            }
            tracing::info!(
                "[agent] pipeline: 子任务 step={} 闭环（总轮 {}，工具轮 {}）success={} 耗时={}ms summary={}",
                task.step,
                round,
                tool_iterations,
                success,
                t0.elapsed().as_millis(),
                runtime::clip(&summary, 200),
            );
            // 成功闭环 → 从产物摘要抽取并登记文件产物（L1 文件存在校验后写库 + 推前端画廊）。
            let artifacts = if success {
                crate::agent::artifacts::register_artifacts(app, cfg, &task, &summary).await
            } else {
                Vec::new()
            };
            let final_summary = if !summary.is_empty() {
                if !success && !verify_detail.is_empty() {
                    format!("校验未通过（{verify_detail}）：{summary}")
                } else {
                    summary
                }
            } else {
                "子任务未产出有效结果（空响应）".to_string()
            };
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: final_summary,
                    success,
                    cancelled: false,
                    skipped: false,
                    artifacts,
                },
                usage,
            );
        }

        // 工具轮：计入预算；超过上限且仍要调用工具 → 判定受阻
        // （产物可能已生成，但模型未能自行收敛）。终态汇报轮在上面的分支单独放行。
        tool_iterations += 1;
        if tool_iterations > MAX_SUBTASK_ITERATIONS {
            tracing::info!(
                "[agent] pipeline: 子任务 step={} 超过 {} 个工具轮仍未收敛（总轮 {}）",
                task.step, MAX_SUBTASK_ITERATIONS, round,
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: format!(
                        "子任务超过 {} 轮工具调用仍未闭环{}",
                        MAX_SUBTASK_ITERATIONS,
                        last_tool_error
                            .as_ref()
                            .map(|e| format!("；最近错误：{}", e.chars().take(300).collect::<String>()))
                            .unwrap_or_default(),
                    ),
                    success: false,
                    cancelled: false,
                    skipped: false,
                    artifacts: vec![],
                },
                usage,
            );
        }

        // 把模型在决定调用工具之前的「真实推理/规划」推送给前端思考面板
        // （reasoning 为 DeepSeek 风格独立思考字段；content 多为规划/分析短文）。
        // 以分层 thinking_chunk（layer=exec）推送，供轨迹视图按层着色区分（规划层 plan 由 planner 推送）。
        let reasoning_trim = outcome.reasoning.trim().to_string();
        if !reasoning_trim.is_empty() {
            events::emit_thinking_chunk(app, &reasoning_trim, true, "exec");
        }
        let content_trim = outcome.content.trim().to_string();
        if !content_trim.is_empty() {
            events::emit_status(app, &content_trim);
        }

        // 执行本轮全部工具调用（复用与全局循环同源的工具执行轮）。
        let stats = runtime::run_tool_calls_round(
            app,
            registry,
            ctx,
            approval,
            cfg,
            &mut messages,
            &outcome,
            task.step,
        )
        .await;
        // 采集本轮最后的工具错误，供恢复面板回显真实受阻原因（问题一：弹窗给原因）。
        if let Some(e) = stats.last_error.clone() {
            last_tool_error = Some(e);
        }

        // 在-flight 上下文压缩：保留最近 2 条 tool 结果完整，更早的压缩为单行摘要，
        // 抑制微 ReAct 长链路上每轮回填的全量工具报文持续撑大 input token。
        // 短任务（≤2 条 tool 结果）不触发，零影响；仅长链路受益。
        compress_in_flight_tool_results(&mut messages, 2);

        // 连续错误即时拦截：连续 2 轮工具全失败即判定子任务受阻。
        if stats.had_success {
            consecutive_errors = 0;
        } else if stats.had_error {
            consecutive_errors += 1;
        }
        if consecutive_errors >= MAX_SUBTASK_CONSECUTIVE_ERRORS {
            tracing::info!(
                "[agent] pipeline: 子任务 step={} 连续 {} 轮工具全失败，判定受阻",
                task.step, consecutive_errors,
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: format!(
                        "连续 {} 轮工具调用全部失败，子任务受阻{}",
                        consecutive_errors,
                        last_tool_error
                            .as_ref()
                            .map(|e| format!("；最近错误：{}", e.chars().take(300).collect::<String>()))
                            .unwrap_or_default(),
                    ),
                    success: false,
                    cancelled: false,
                    skipped: false,
                    artifacts: vec![],
                },
                usage,
            );
        }
    }
}

/// 在-flight 上下文压缩：保留最近 `keep_recent_full` 条 tool 结果完整，
/// 更早的 tool 结果内容替换为单行摘要（仍保留 `tool_call_id` 以维持配对不变量），
/// 避免微 ReAct 长链路上每轮回填的全量工具报文持续撑大 input token。
///
/// 设计要点：只压缩「内容」，绝不删除 tool 消息本身——否则会破坏
/// assistant(tool_calls) ↔ tool result 的配对（网关拒绝 HTTP 400）。
/// 配对完整性仍由 `runtime::sanitize_message_sequence` 在发送前兜底。
fn compress_in_flight_tool_results(messages: &mut Vec<Value>, keep_recent_full: usize) {
    let mut tool_idxs: Vec<usize> = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
            tool_idxs.push(i);
        }
    }
    if tool_idxs.len() <= keep_recent_full {
        return;
    }
    let to_compress: Vec<usize> = tool_idxs[..tool_idxs.len() - keep_recent_full].to_vec();
    for i in to_compress {
        let content = match messages[i].get("content").and_then(|v| v.as_str()) {
            Some(c) if c.chars().count() > 240 => c.to_string(),
            _ => continue,
        };
        let summary = content.chars().take(200).collect::<String>();
        let call_id = messages[i]
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        messages[i] = json!({
            "role": "tool",
            "tool_call_id": call_id,
            "content": format!(
                "[工具结果已压缩为摘要，原长 {} 字符] {}…",
                content.chars().count(),
                summary
            )
        });
    }
}

/// 极简时间戳（毫秒）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
