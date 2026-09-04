//! 阶段二：任务拆解规划链（DAG Planner）。
//!
//! 大模型在此阶段只扮演「系统架构师」：出蓝图，不碰代码。
//! 提示中**不注入具体工具的 JSON Schema**（节约数千 Token），只注入高度概括的能力大纲，
//! 防止模型意淫出系统不具备的能力（如调用宿主 shell）。
//!
//! 容错铁律：规划 JSON 解析失败时**绝不让流水线崩溃**——降级为 Single-Task Fallback，
//! 把用户原始输入封装为唯一原子任务，直接下发阶段三。

use serde_json::json;
use serde_json::Value;

use crate::agent::runtime;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::PlanDAG;
use crate::agent::types::PlanSubTask;

/// 规划步数上限：超出截断（防止模型拆出十几步导致流水线冗长、Token 失控）。
const MAX_PLAN_STEPS: usize = 5;

/// 生成任务规划。返回 (PlanDAG, 本次规划的真实 token 用量)。
pub async fn build_plan(
    cfg: &AgentRuntimeConfig,
    prompt: &str,
    workspace: Option<&str>,
) -> (PlanDAG, (u64, u64)) {
    let outline = capability_outline(cfg);
    let ws_line = workspace
        .map(|w| format!("\n当前工作空间目录：{w}（所有文件产物都必须落在该目录内）"))
        .unwrap_or_default();
    let sys = format!(
        "你是一名任务规划架构师。把用户的宏观目标拆解为可顺序执行的原子步骤。\
\n\n当前系统具备以下原子能力：\
\n{outline}\
\n{ws_line}\
\n\n拆解规则：\
\n1. 每个步骤必须能用上述能力独立完成，严禁编造不存在的能力（如调用宿主 shell、直接控制外部桌面应用）；\
\n2. 步骤按执行顺序排列，前一步的产出供后一步使用；\
\n3. 步骤数量控制在 1~{MAX_PLAN_STEPS} 个，能少不多——简单目标只拆 1~2 步；\
\n4. **同类目标必须保持一致的拆分粒度**：对于结构相同的任务（例如「采集数据→生成报表→分析预测」），\
无论查询主体如何变化，都应采用相同的步骤划分，不要因措辞或主体微调而改变步数与边界；\
\n5. 只输出 JSON，不要任何多余文本或 markdown 代码块：\
\n{{\"goal_summary\":\"一句话目标\",\"tasks\":[{{\"step\":1,\"task_id\":\"t1\",\"title\":\"短标题\",\"description\":\"这一步具体做什么、产出什么文件或结果\"}}]}}"
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": prompt }),
    ];

    // 规划是「确定性架构决策」，必须可复现：强制 temperature=0，不受智能体默认温度影响。
    // 否则同类任务（如「采集+报表+预测」）在两次不同主体查询下会被拆成不同粒度（采样随机），
    // 既难以排查对比，也会让流水线步数与每步预算不可预期。
    let mut plan_cfg = cfg.clone();
    match plan_cfg.llm_config.as_object_mut() {
        Some(obj) => {
            obj.insert("temperature".into(), json!(0));
        }
        None => {
            plan_cfg.llm_config = json!({ "temperature": 0 });
        }
    }

    let started = std::time::Instant::now();
    match runtime::call_llm(&plan_cfg, &messages, &[]).await {
        Ok((resp, usage)) => {
            let content = extract_content(&resp);
            match parse_plan_json(&content) {
                Some(mut plan) => {
                    // 归一化：按 step 排序 + 截断上限 + 重排 step 序号
                    plan.tasks.sort_by_key(|t| t.step);
                    plan.tasks.truncate(MAX_PLAN_STEPS);
                    for (i, t) in plan.tasks.iter_mut().enumerate() {
                        t.step = i + 1;
                        if t.task_id.is_empty() {
                            t.task_id = format!("t{}", i + 1);
                        }
                    }
                    if plan.tasks.is_empty() {
                        println!("[agent] planner: 规划结果为空，降级 Single-Task Fallback");
                        return (single_task_fallback(prompt), usage);
                    }
                    println!(
                        "[agent] planner: 规划完成（{}ms）goal={} 步骤数={}：{}",
                        started.elapsed().as_millis(),
                        runtime::clip(&plan.goal_summary, 100),
                        plan.tasks.len(),
                        plan.tasks
                            .iter()
                            .map(|t| format!("{}:{}", t.step, t.title))
                            .collect::<Vec<_>>()
                            .join(" → "),
                    );
                    (plan, usage)
                }
                None => {
                    println!(
                        "[agent] planner: 规划 JSON 解析失败，降级 Single-Task Fallback content={}",
                        runtime::clip(&content, 400),
                    );
                    (single_task_fallback(prompt), usage)
                }
            }
        }
        Err(e) => {
            println!("[agent] planner: 规划调用失败：{e}，降级 Single-Task Fallback");
            (single_task_fallback(prompt), (0, 0))
        }
    }
}

/// 系统能力大纲（概括，不含 JSON Schema）。
/// 与能力层注册表保持同源：原生收敛工具 + 全局注入的 MCP/Skill。
fn capability_outline(cfg: &AgentRuntimeConfig) -> String {
    let mut lines = vec![
        "1. 本地文件系统操作：读 / 写 / 改 / 列目录（限于授权工作空间内）；".to_string(),
        "2. 沙箱 Python 执行（run_python_sandbox，直接传 code 参数）：数据抓取、报表生成、数学建模；沙箱为纯净 Python 3.11，脚本运行时会自动按需安装缺失的常用数据科学库（pandas/numpy/openpyxl/scipy 等），你只需正常 import 即可，无需手动安装；".to_string(),
        "3. 工作空间记忆管理：沉淀或提取 .wd_mem/ 历史工件与长期记忆；".to_string(),
    ];
    let mut idx = 4;
    if !cfg.mcp_tools.is_empty() {
        let names: Vec<&str> = cfg
            .mcp_tools
            .iter()
            .map(|t| t.tool_name.as_str())
            .collect();
        lines.push(format!("{idx}. MCP 外部工具：{}；", names.join("、")));
        idx += 1;
    }
    if !cfg.skill_tools.is_empty() {
        let names: Vec<&str> = cfg
            .skill_tools
            .iter()
            .map(|t| t.skill_name.as_str())
            .collect();
        lines.push(format!("{idx}. 技能工具：{}；", names.join("、")));
    }
    lines.join("\n")
}

/// JSON 解析失败 / 调用失败时的降级：整个原始输入封装为唯一原子任务。
fn single_task_fallback(prompt: &str) -> PlanDAG {
    PlanDAG {
        goal_summary: runtime::clip(prompt, 100).to_string(),
        tasks: vec![PlanSubTask {
            step: 1,
            task_id: "t1".into(),
            title: "完成用户任务".into(),
            description: prompt.to_string(),
        }],
    }
}

fn extract_content(resp: &Value) -> String {
    // 优先正文 content；推理模型（MiniMax-M3 / DeepSeek-R1）在开启 reasoning 时，
    // 可能把规划 JSON 整体放进 reasoning_content 而 content 为空——本测试日志正是因此
    // 误判"解析失败"并降级为单任务巨块（"完成用户任务"），导致 5 轮预算不足而失败。
    // 故 content 为空时回落 reasoning 通道，最大化还原模型真实输出。
    if let Some(c) = resp.get("content").and_then(|c| c.as_str()) {
        if !c.trim().is_empty() {
            return c.to_string();
        }
    }
    for key in ["reasoning_content", "reasoning"] {
        if let Some(r) = resp.get(key).and_then(|v| v.as_str()) {
            if !r.trim().is_empty() {
                return r.to_string();
            }
        }
    }
    String::new()
}

/// 剥离可能的 markdown 代码围栏（```json ... ``` 或 ``` ... ```），返回围栏内纯文本。
fn strip_code_fence(s: &str) -> String {
    let t = s.trim();
    if t.starts_with("```") {
        // 去掉首行 ```lang\n
        let body = match t.find('\n') {
            Some(p) => t[p + 1..].trim_end(),
            None => &t[3..],
        };
        if let Some(end) = body.rfind("```") {
            return body[..end].to_string();
        }
        return body.to_string();
    }
    s.to_string()
}

/// 截取出首个 `{` 到最后一个 `}` 之间的 JSON（兼容模型在 JSON 前后附带说明文字，
/// 或把 JSON 包在 markdown 代码围栏里的情况）。
fn extract_json_str(s: &str) -> String {
    let t = strip_code_fence(s.trim());
    match (t.find('{'), t.rfind('}')) {
        (Some(start), Some(end)) if end >= start => t[start..=end].to_string(),
        _ => t.to_string(),
    }
}

fn parse_plan_json(s: &str) -> Option<PlanDAG> {
    serde_json::from_str(extract_json_str(s).as_str()).ok()
}
