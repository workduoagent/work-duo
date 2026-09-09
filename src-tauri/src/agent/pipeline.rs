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

use serde_json::json;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use futures_util::future::join_all;

use crate::agent::approval::ApprovalManager;
use crate::agent::events;
use crate::agent::recovery::RecoveryDecision;
use crate::agent::recovery::RecoveryHub;
use crate::agent::recovery::RecoveryRequest;
use crate::agent::runtime;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::PlanDAG;
use crate::agent::types::PlanSubTask;
use crate::agent::types::SubTaskOutput;

/// 微 ReAct 局部熔断：单个子任务「工具轮」上限（正常子任务 1~2 轮即可闭环）。
/// 注意：仅「调用了工具的轮」计入此预算；模型只发文本汇报的终态轮不计入，
/// 确保「产物已生成、但预算都花在工具上、没机会发汇报」的子任务不会被误判未闭环。
const MAX_SUBTASK_ITERATIONS: usize = 8;
/// 子任务内连续工具错误即时拦截阈值。
const MAX_SUBTASK_CONSECUTIVE_ERRORS: usize = 2;
/// 同一批次内最大并发子任务数（无依赖的步骤并行执行；受 LLM 并发/审批交互约束不宜过大）。
const MAX_PARALLEL_SUBTASKS: usize = 3;

/// 流水线执行结果。
pub struct PipelineResult {
    pub final_text: String,
    pub usage: (u64, u64),
    #[allow(dead_code)]
    pub success: bool,
    /// 是否被用户中途取消（cancel_agent_task 触发）：取消时流水线提前整体收尾，
    /// run_task 据此跳过正常 round 持久化并推送取消提示。
    pub cancelled: bool,
}

/// DAG 拓扑调度 PlanDAG 中的全部原子子任务（#10）。
///
/// 依据 `depends_on` 做拓扑就绪判定：某步骤仅在其全部前置步骤成功后进入 READY；
/// 一批 READY 的步骤并发执行（`join_all`，受 `MAX_PARALLEL_SUBTASKS` 上限约束）。
/// 子任务失败经自动重试（MAX_SUBTASK_RETRIES）后仍不闭环 → 步骤级恢复挂起（#8）。
#[tracing::instrument(skip_all)]
pub async fn run_pipeline(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    registry: &ToolRegistry,
    ctx: &ToolContext,
    approval: &ApprovalManager,
    plan: &PlanDAG,
    cancel: &Arc<AtomicBool>,
    recovery: &Arc<RecoveryHub>,
    pre_completed: &std::collections::HashSet<String>,
    initial_context: &str,
) -> PipelineResult {
    let total = plan.tasks.len();
    let mut pipeline_context_summary = String::new();
    let mut total_usage: (u64, u64) = (0, 0);
    let mut outputs: Vec<SubTaskOutput> = Vec::new();
    // 拓扑状态：started=已开始（含进行中/失败待恢复）；completed=已成功或跳过（依赖方可解除阻塞）。
    let mut started: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut completed: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 接管补充指示：task_id → guidance（引导式重跑时注入该步骤）。
    let mut guidance_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // §3.2 分支重跑：head 步骤（分支起点之前）标记为已完成，流水线跳过执行（不重新调用工具），
    // 仅执行 tail 新分支；initial_context 作为产物管道初始摘要，供 tail 步骤续接 head 成果。
    // 只接纳确实存在于 plan 中的 task_id，避免脏 id 造成误判。
    for id in pre_completed {
        if plan.tasks.iter().any(|t| &t.task_id == id) {
            completed.insert(id.clone());
        }
    }
    if !initial_context.is_empty() {
        pipeline_context_summary = initial_context.to_string();
    }

    // §3.2 分支重跑：为预完成的 head 步骤补发 step_finished(success)，
    // 使前端画布将其标记为「已完成」（否则会一直停在 pending，被 finalizeStuckSteps 误判为失败）。
    // 此刻 completed 仅含预完成步骤，故安全遍历 plan 命中即发。
    for t in &plan.tasks {
        if completed.contains(&t.task_id) {
            events::emit_step_finished(
                app,
                t.step,
                total,
                &t.title,
                true,
                "（沿用已完成结果，分支重跑跳过）",
            );
        }
    }

    loop {
        if cancel.load(Ordering::SeqCst) {
            return PipelineResult {
                final_text: "任务已被用户取消。".to_string(),
                usage: total_usage,
                success: false,
                cancelled: true,
            };
        }
        // 收集 READY 步骤：未开始，且全部依赖已 completed。
        let ready: Vec<&PlanSubTask> = plan
            .tasks
            .iter()
            .filter(|t| !started.contains(&t.task_id) && t.depends_on.iter().all(|d| completed.contains(d)))
            .collect();
        if ready.is_empty() {
            // 全完成 → 退出；否则存在死锁（循环依赖 / 引用了不存在的步骤）。
            if completed.len() == total {
                break;
            }
            let stuck = plan
                .tasks
                .iter()
                .filter(|t| !completed.contains(&t.task_id))
                .map(|t| format!("{}「{}」(依赖 {:?})", t.step, t.title, t.depends_on))
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
            };
        }
        // 并发上限：本批最多取 MAX_PARALLEL_SUBTASKS 个，其余下轮（依赖解除后）再拾起。
        let batch: Vec<&PlanSubTask> = ready.into_iter().take(MAX_PARALLEL_SUBTASKS).collect();
        for t in &batch {
            started.insert(t.task_id.clone());
            events::emit_step_started(app, t.step, total, &t.title);
        }
        // 并发执行本批（join_all 在同一任务内并发轮询，复用共享工具注册表/沙箱/工作区）。
        let futures = batch.iter().map(|t| {
            let g = guidance_map.get(&t.task_id).map(|s| s.as_str()).unwrap_or("");
            run_subtask(
                app,
                cfg,
                registry,
                ctx,
                approval,
                t,
                total,
                &pipeline_context_summary,
                cancel,
                g,
            )
        });
        let results = join_all(futures).await;

        // 先累加用量，再按结果分类（成功→completed；失败→移出 started 待后续重跑/恢复）。
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
                };
            }
            if out.success {
                completed.insert(batch[i].task_id.clone());
                pipeline_context_summary.push_str(&format!(
                    "步骤 {}「{}」产物：{}\n",
                    batch[i].step, batch[i].title, out.summary
                ));
                // 成功闭环：补发 step_finished(ok=true)。否则前端步骤状态停在 running，
                // 任务结束时会被 useAgentSession.finalizeStuckSteps 兜底误判为失败
                // （日志中「未收到完成信号，已自动标记为失败」即此误判）。
                // 必须在 out 被 outputs.push 移动前取用 out.summary。
                events::emit_step_finished(app, batch[i].step, total, &batch[i].title, true, &out.summary);
                outputs.push(out);
            } else {
                // 失败：移出 started（下一轮作为 READY 重新被拾起），并标记 failed 供 UI 高亮。
                started.remove(&batch[i].task_id);
                events::emit_step_finished(app, batch[i].step, total, &batch[i].title, false, &out.summary);
                failures.push((i, out));
            }
        }

        // 本批有失败 → 取第一个进入步骤级恢复（其余失败步留待后续轮重跑）。
        if let Some((i, out)) = failures.into_iter().next() {
            let task_id = batch[i].task_id.clone();
            let req = RecoveryRequest {
                step: out.step,
                task_id: task_id.clone(),
                title: out.title.clone(),
                reason: out.summary.clone(),
                summary: String::new(),
            };
            events::emit_recovery_needed(app, &req);
            recovery.request(req);
            let decision = recovery.wait(cancel).await;
            match decision {
                RecoveryDecision::Retry => {
                    events::emit_step_started(app, out.step, total, &out.title);
                    events::emit_status(app, &format!("步骤 {}/{}：用户选择重试", out.step, total));
                }
                RecoveryDecision::Skip => {
                    let skipped = SubTaskOutput {
                        step: out.step,
                        title: out.title.clone(),
                        summary: "（已跳过：用户选择跳过该步骤）".to_string(),
                        success: true,
                        cancelled: false,
                        artifacts: vec![],
                    };
                    events::emit_step_finished(app, out.step, total, &out.title, true, "（已跳过）");
                    completed.insert(task_id);
                    outputs.push(skipped);
                }
                RecoveryDecision::Takeover(g) => {
                    guidance_map.insert(task_id.clone(), g);
                    events::emit_step_started(app, out.step, total, &out.title);
                    events::emit_status(
                        app,
                        &format!("步骤 {}/{}：用户接管并补充指示后重试", out.step, total),
                    );
                }
                RecoveryDecision::Cancel => {
                    return PipelineResult {
                        final_text: "任务已被用户取消。".to_string(),
                        usage: total_usage,
                        success: false,
                        cancelled: true,
                    };
                }
            }
            // 循环回到就绪判定：被恢复的步骤（started 已移除/或 skip 已 completed）将重新被拾起执行。
            continue;
        }
    }

    // 全部子任务闭环：自检验证（基于真实产物合成 selfcheck 层思考，供轨迹视图按层着色）。
    // 注意：outputs 仅含成功闭环/跳过的步骤（失败步经恢复链路处理，取消/死锁已提前 return），
    // 故此处统计即「最终交付的自检结论」，不臆造未发生的校验。
    {
        let ok_count = outputs.iter().filter(|o| o.success).count();
        let art_count: usize = outputs.iter().map(|o| o.artifacts.len()).sum();
        let mut sc = format!(
            "自检验证：共 {} 个规划步骤，{} 个成功闭环，产出 {} 个文件产物。",
            total, ok_count, art_count
        );
        if art_count > 0 {
            let names: Vec<String> = outputs
                .iter()
                .flat_map(|o| o.artifacts.iter().map(|a| a.description.clone()))
                .collect();
            sc.push_str(&format!(" 产物：{}。", names.join("、")));
        }
        events::emit_thinking_chunk(app, &sc, true, "selfcheck");
    }

    // 全部子任务闭环：合并全局执行视图。
    let final_text = format!(
        "{}\n\n———\n执行过程回顾（共 {} 步）：\n{}",
        plan.goal_summary,
        total,
        outputs
            .iter()
            .map(|o| format!("✅ 步骤 {}「{}」：{}", o.step, o.title, o.summary))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    tracing::info!(
        "[agent] pipeline: 全部 {} 个子任务闭环，总 usage=({},{})",
        total, total_usage.0, total_usage.1,
    );
    PipelineResult {
        final_text,
        usage: total_usage,
        success: true,
        cancelled: false,
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
    task: &PlanSubTask,
    total: usize,
    pipeline_context_summary: &str,
    cancel: &Arc<AtomicBool>,
    guidance: &str,
) -> (SubTaskOutput, (u64, u64)) {
    // 认知上下文绝对隔离：崭新的 messages，0 历史包袱。
    let prior = if pipeline_context_summary.trim().is_empty() {
        "（无，你是第一个步骤）".to_string()
    } else {
        pipeline_context_summary.to_string()
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
    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": &cfg.system_prompt }),
        json!({
            "role": "user",
            "content": format!(
                "【当前任务目标（步骤 {}/{}）】：{}\n任务详述：{}\n\n【前序步骤已交付产物】：\n{}{}\n\n请直接使用对应工具执行当前步骤；确认产物已成功生成后，立即给出简明结果汇报（包含产出文件的完整路径）。不要反复读取你已经掌握的数据，也不要重复验证已生成的产物——每步只做一次即可。{}",
                task.step, total, task.title, task.description, prior, criteria_hint,
                if guidance.trim().is_empty() {
                    String::new()
                } else {
                    format!(
                        "\n\n【用户手动补充指示（接管/重试时提供）】：{}\n请结合该指示重新执行本步骤。",
                        guidance.trim()
                    )
                }
            )
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
                    artifacts: vec![],
                },
                usage,
            );
        }
        round += 1;
        // 协议安全过滤：每次调用前无条件执行配对自检（彻底防 400）。
        runtime::sanitize_message_sequence(&mut messages);

        let mut outcome = match runtime::call_llm_stream(app, cfg, &messages, &tools, cancel).await {
            Ok(o) => o,
            Err(e) => {
                tracing::info!(
                    "[agent] pipeline: 子任务 step={} 第 {} 轮 LLM 调用失败：{e}",
                    task.step, round
                );
                return (
                    SubTaskOutput {
                        step: task.step,
                        title: task.title.clone(),
                        summary: format!("LLM 调用失败：{e}"),
                        success: false,
                        cancelled: false,
                        artifacts: vec![],
                    },
                    usage,
                );
            }
        };

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
            "[agent] pipeline: 子任务 step={} 第 {} 轮 LLM 返回 | 正文={}字符 tool_calls={}个",
            task.step,
            round,
            outcome.content.chars().count(),
            outcome.tool_calls.len(),
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
                let result = crate::agent::verifier::verify_task(task, ctx.workspace.as_deref());
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
                "[agent] pipeline: 子任务 step={} 闭环（总轮 {}，工具轮 {}）success={} summary={}",
                task.step,
                round,
                tool_iterations,
                success,
                runtime::clip(&summary, 200),
            );
            // 成功闭环 → 从产物摘要抽取并登记文件产物（L1 文件存在校验后写库 + 推前端画廊）。
            let artifacts = if success {
                crate::agent::artifacts::register_artifacts(app, cfg, task, &summary).await
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
                    summary: format!("子任务超过 {} 轮工具调用仍未闭环", MAX_SUBTASK_ITERATIONS),
                    success: false,
                    cancelled: false,
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
        )
        .await;

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
                    summary: format!("连续 {} 轮工具调用全部失败，子任务受阻", consecutive_errors),
                    success: false,
                    cancelled: false,
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
