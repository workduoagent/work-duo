//! 阶段三：流水线隔离执行链（Pipeline Execution / Micro-ReAct）。
//!
//! 彻底废弃全局大 ReAct 循环，由管道驱动器顺序调度原子子任务：
//! - 每个子任务拥有**完全独立的 messages**（0 历史包袱）；
//! - 子任务间仅靠「产物管道」（前序步骤的纯文本摘要）单向传递信息；
//! - 子任务内部几万字工具报文随作用域结束**物理销毁**，绝不流入下一环；
//! - 全局物理基建共享：同一工具注册表、同一 Micromamba 沙箱、同一 `.wd_mem` 工作区。
//!
//! 失败策略（用户确认）：子任务失败自动重试，重试 3 次仍败则中止整个流水线并向用户报告。

use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;

use crate::agent::approval::ApprovalManager;
use crate::agent::events;
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
/// 子任务失败自动重试上限：重试 3 次仍败则中止流水线并报告。
const MAX_SUBTASK_RETRIES: usize = 3;

/// 流水线执行结果。
pub struct PipelineResult {
    pub final_text: String,
    pub usage: (u64, u64),
    #[allow(dead_code)]
    pub success: bool,
}

/// 顺序调度 PlanDAG 中的全部原子子任务。
pub async fn run_pipeline(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    registry: &ToolRegistry,
    ctx: &ToolContext,
    approval: &ApprovalManager,
    plan: &PlanDAG,
) -> PipelineResult {
    let total = plan.tasks.len();
    let mut pipeline_context_summary = String::new();
    let mut total_usage: (u64, u64) = (0, 0);
    let mut outputs: Vec<SubTaskOutput> = Vec::new();

    for task in &plan.tasks {
        events::emit_step_started(app, task.step, total, &task.title);

        // 子任务失败重试：最多 MAX_SUBTASK_RETRIES 次。
        let mut last: Option<SubTaskOutput> = None;
        for attempt in 1..=MAX_SUBTASK_RETRIES {
            let (out, usage) = run_subtask(
                app,
                cfg,
                registry,
                ctx,
                approval,
                task,
                total,
                &pipeline_context_summary,
            )
            .await;
            total_usage.0 += usage.0;
            total_usage.1 += usage.1;
            let ok = out.success;
            if !ok {
                println!(
                    "[agent] pipeline: 步骤 {}/{} 第 {} 次尝试未闭环：{}",
                    task.step,
                    total,
                    attempt,
                    runtime::clip(&out.summary, 200),
                );
                if attempt < MAX_SUBTASK_RETRIES {
                    events::emit_status(
                        app,
                        &format!(
                            "步骤 {}/{} 第 {} 次尝试未达预期，正在重试…",
                            task.step, total, attempt
                        ),
                    );
                }
            }
            last = Some(out);
            if ok {
                break;
            }
        }
        let output = last.expect("重试循环必然产出 output");

        events::emit_step_finished(app, task.step, total, &task.title, output.success, &output.summary);

        if !output.success {
            // 重试 3 次仍败 → 中止整个流水线，向用户报告失败原因与已完成产物。
            let report = format!(
                "任务在步骤 {}/{}「{}」处受阻（已自动重试 {} 次仍失败）：\n\n{}\n\n———\n已完成的步骤产物：\n{}",
                task.step,
                total,
                task.title,
                MAX_SUBTASK_RETRIES,
                output.summary,
                if pipeline_context_summary.is_empty() {
                    "（尚无已完成步骤）".to_string()
                } else {
                    pipeline_context_summary.clone()
                },
            );
            println!(
                "[agent] pipeline: 步骤 {}/{} 重试 {} 次仍失败，中止流水线",
                task.step, total, MAX_SUBTASK_RETRIES,
            );
            return PipelineResult {
                final_text: report,
                usage: total_usage,
                success: false,
            };
        }

        // 产物管道前移：只把纯文本摘要传给下一环（中间报文已随 run_subtask 作用域销毁）。
        pipeline_context_summary.push_str(&format!(
            "步骤 {}「{}」产物：{}\n",
            task.step, task.title, output.summary
        ));
        outputs.push(output);
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
    println!(
        "[agent] pipeline: 全部 {} 个子任务闭环，总 usage=({},{})",
        total, total_usage.0, total_usage.1,
    );
    PipelineResult {
        final_text,
        usage: total_usage,
        success: true,
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
) -> (SubTaskOutput, (u64, u64)) {
    // 认知上下文绝对隔离：崭新的 messages，0 历史包袱。
    let prior = if pipeline_context_summary.trim().is_empty() {
        "（无，你是第一个步骤）".to_string()
    } else {
        pipeline_context_summary.to_string()
    };
    let mut messages: Vec<Value> = vec![
        json!({ "role": "system", "content": &cfg.system_prompt }),
        json!({
            "role": "user",
            "content": format!(
                "【当前任务目标（步骤 {}/{}）】：{}\n任务详述：{}\n\n【前序步骤已交付产物】：\n{}\n\n请直接使用对应工具执行当前步骤；确认产物已成功生成后，立即给出简明结果汇报（包含产出文件的完整路径）。不要反复读取你已经掌握的数据，也不要重复验证已生成的产物——每步只做一次即可。",
                task.step, total, task.title, task.description, prior
            )
        }),
    ];

    let tools = registry.get_tools_for_llm();
    let mut usage: (u64, u64) = (0, 0);
    let mut consecutive_errors = 0usize;

    println!(
        "[agent] pipeline: 子任务开始 step={}/{} title={} 工具数={}",
        task.step,
        total,
        task.title,
        tools.len(),
    );

    let mut round = 0usize; // 总 LLM 轮次（仅日志用）
    let mut tool_iterations = 0usize; // 工具轮次（计入预算；终态汇报轮不计入）

    loop {
        round += 1;
        // 协议安全过滤：每次调用前无条件执行配对自检（彻底防 400）。
        runtime::sanitize_message_sequence(&mut messages);

        let mut outcome = match runtime::call_llm_stream(app, cfg, &messages, &tools).await {
            Ok(o) => o,
            Err(e) => {
                println!(
                    "[agent] pipeline: 子任务 step={} 第 {} 轮 LLM 调用失败：{e}",
                    task.step, round
                );
                return (
                    SubTaskOutput {
                        step: task.step,
                        title: task.title.clone(),
                        summary: format!("LLM 调用失败：{e}"),
                        success: false,
                    },
                    usage,
                );
            }
        };
        // 流式空响应兜底：个别网关不支持流式 tool_calls，回退一次非流式拿真实决策。
        if outcome.content.trim().is_empty() && outcome.tool_calls.is_empty() {
            println!(
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
                        },
                        usage,
                    );
                }
            }
        }
        usage.0 += outcome.usage.0;
        usage.1 += outcome.usage.1;

        println!(
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
            let success = !summary.is_empty();
            println!(
                "[agent] pipeline: 子任务 step={} 闭环（总轮 {}，工具轮 {}）summary={}",
                task.step,
                round,
                tool_iterations,
                runtime::clip(&summary, 200),
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: if summary.is_empty() {
                        "子任务未产出有效结果（空响应）".to_string()
                    } else {
                        summary
                    },
                    success,
                },
                usage,
            );
        }

        // 工具轮：计入预算；超过上限且仍要调用工具 → 判定受阻
        // （产物可能已生成，但模型未能自行收敛）。终态汇报轮在上面的分支单独放行。
        tool_iterations += 1;
        if tool_iterations > MAX_SUBTASK_ITERATIONS {
            println!(
                "[agent] pipeline: 子任务 step={} 超过 {} 个工具轮仍未收敛（总轮 {}）",
                task.step, MAX_SUBTASK_ITERATIONS, round,
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: format!("子任务超过 {} 轮工具调用仍未闭环", MAX_SUBTASK_ITERATIONS),
                    success: false,
                },
                usage,
            );
        }

        // 把模型在决定调用工具之前的「真实推理/规划」推送给前端思考面板
        // （reasoning 为 DeepSeek 风格独立思考字段；content 多为规划/分析短文）。
        let reasoning_trim = outcome.reasoning.trim().to_string();
        if !reasoning_trim.is_empty() {
            events::emit_status(app, &reasoning_trim);
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

        // 连续错误即时拦截：连续 2 轮工具全失败即判定子任务受阻。
        if stats.had_success {
            consecutive_errors = 0;
        } else if stats.had_error {
            consecutive_errors += 1;
        }
        if consecutive_errors >= MAX_SUBTASK_CONSECUTIVE_ERRORS {
            println!(
                "[agent] pipeline: 子任务 step={} 连续 {} 轮工具全失败，判定受阻",
                task.step, consecutive_errors,
            );
            return (
                SubTaskOutput {
                    step: task.step,
                    title: task.title.clone(),
                    summary: format!("连续 {} 轮工具调用全部失败，子任务受阻", consecutive_errors),
                    success: false,
                },
                usage,
            );
        }
    }
}
