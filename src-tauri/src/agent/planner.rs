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
#[tracing::instrument(skip_all)]
pub async fn build_plan(
    cfg: &AgentRuntimeConfig,
    prompt: &str,
    workspace: Option<&str>,
) -> (PlanDAG, (u64, u64), String) {
    let outline = capability_outline(cfg);
    let ws_line = workspace
        .map(|w| format!("\n当前工作空间目录：{w}（所有文件产物都必须落在该目录内）"))
        .unwrap_or_default();
    // JSON 输出示例（独立普通字符串，避免 format! 内花括号转义负担）。
    let json_example = "{\"goal_summary\":\"一句话目标\",\"tasks\":[{\"step\":1,\"task_id\":\"t1\",\"title\":\"短标题\",\"description\":\"这一步具体做什么、产出什么文件或结果\",\"success_criteria\":[{\"type\":\"file_nonempty\",\"target\":\"output/data.csv\"}],\"depends_on\":[]},{\"step\":2,\"task_id\":\"t2\",\"title\":\"运行校验脚本验证\",\"description\":\"读取 t1 的 data.csv 跑校验脚本，确认数据处理正确（进程退出码 0 即成功）\",\"success_criteria\":[{\"type\":\"command_succeeded\"}],\"depends_on\":[\"t1\"]}]}";
    let sys = format!(
        "你是一名任务规划架构师。把用户的宏观目标拆解为可顺序执行的原子步骤。\
\n\n当前系统具备以下原子能力：\
\n{0}\
\n{1}\
\n\n拆解规则：\
\n1. 每个步骤必须能用上述能力独立完成，严禁编造不存在的能力（如调用宿主 shell、直接控制外部桌面应用）；\
\n2. 步骤按执行顺序排列，前一步的产出供后一步使用；\
\n3. 步骤数量控制在 1~{MAX_PLAN_STEPS} 个，能少不多——简单目标只拆 1~2 步；**同时单步骤体量要小**：一个步骤产出/修改的文件数建议不超过 5 个，超过就按模块/层次拆成多步（如「初始化工程骨架」「实现核心模块」「编写测试套件」）——单步过大时执行器会在工具轮预算内写不完文件、被迫熔断后靠客观校验收尾，既浪费轮次也让执行图难看；\
\n4. **同类目标必须保持一致的拆分粒度**：对于结构相同的任务（例如「采集数据→生成报表→分析预测」），\
无论查询主体如何变化，都应采用相同的步骤划分，不要因措辞或主体微调而改变步数与边界；\
\n5. 每个步骤可附带 `success_criteria` 数组声明「成功判定标准」（确定性、可由文件/内容客观核验，\
不依赖主观判断）；**仅当该步骤确实产出可核验文件/结果时才声明**，纯分析或无产物的步骤不要声明。\
可选 check 类型：\
file_exists / file_nonempty / directory_exists / json_valid / text_contains / text_min_lines / excel_row_count（暂以文件存在+非空代理）；command_succeeded（运行类工具**退出码为 0 即成功**，通用、与输出措辞/语言/emoji 无关，专门用于「运行脚本/测试是否成功」判定）。\
stdout_contains / tool_output_contains（校验**工具运行输出流**是否包含某段指定文字，如沙箱 stdout 是否出现「报表生成成功」）——仅用于「输出必须出现某具体文字」的显式内容断言，**不用于**判定运行是否成功（那请用 command_succeeded）。\
text_contains 需带 value，text_min_lines / excel_row_count 需带 threshold（行数）；\
stdout_contains / tool_output_contains 只需带 value（期望在工具输出流中匹配的关键词），target 可留空——它校验的是运行类工具的 stdout，**不是文件**，禁止为了「输出须包含 X」去 text_contains 一个名叫 `stdout` 的文件（那文件不存在会永久判失败、陷入恢复死循环）。；特别地，「运行测试脚本 / 跑命令是否成功」这类判定**不要**用 stdout_contains 去 stdout 里猜（易受输出措辞、语言、emoji 影响而误判），应直接用 `command_succeeded`：它由执行器读取进程**退出码**（0=成功），与语言/框架/输出文字/emoji 完全无关，通用且零误判；stdout_contains 仅保留给「输出必须出现某段具体文字」的显式内容断言（如 `报表生成成功`），此时 value 可用 `|` 容错（如 `报表生成成功|报表已生成`）。\
text_contains 的 value 建议用 `|` 分隔多个同义措辞（例如「风险提示|主要风险|风险」），执行器与校验器任一命中即通过，\
避免只写单一死板字面（如只写「风险提示」）而被散文措辞卡死、误判步骤未闭环。\
\n注意：success_criteria 一旦声明必须字段完整：text_contains 须同时带 target 与 value；\
file*/directory_exists/json_valid/excel_row_count 须带 target；stdout_contains / tool_output_contains 须带 value（target 可省）；command_succeeded 无需额外字段（直接读退出码）。\
字段不完整的残缺条件执行器会直接忽略、等于没声明，所以残缺条件不要写——要么写完整的，要么干脆不声明。
\n6. `depends_on`：本步骤开始前必须已完成的步骤 task_id 列表（仅可引用编号更小的步骤；无依赖填空数组）。\
存在依赖的步骤会**等待其前置步骤成功后才执行**，无共同依赖的步骤**可并行**；严禁出现循环依赖（A 依赖 B 且 B 依赖 A）。\
\n记忆沉淀约定：当用户要求「记住 / 沉淀」长期约定、偏好或决策时，负责该步骤的执行器应**同时**做两件事：\
① 调用原生工具 `native__anchor_memory`（key 简短、content 完整、category 按规范）把要点逐条沉淀为结构化记忆——\
记忆宫殿是独立于文件系统的语义召回库，只写 .wd_mem 文件不调 anchor 会导致记忆缺条目、语义召回失效；\
② 需要完整长文档时另写 .wd_mem/ 下的 md 文件，两轨并存。请在 description 里明确写出「调用 native__anchor_memory 沉淀以下要点：…」。\
\n验收绑定行为（2026-09-18 外部评审；2026-09-24 P-5 强化）：**改代码 / 修复 / 对齐约定类步骤，success_criteria 必须含行为级断言**——\
修复类步骤（标题/描述含 修复/fix/bug/CVE/报错 等）**必须用 tests_passed**（解析步骤内 pytest 输出，要求 ≥1 passed 且 failed=0 且 errors=0），\
禁止对修复类步骤只声明 command_succeeded：退出码 0 无法区分「验证脚本跑通」与「缺陷已修复」（S-J6 实测：agent 写检查脚本即闭环，修复代码一行未动）；\
tests_passed 无需额外字段，但该步骤 description 里必须明确「运行 pytest（验收测试文件）」以便执行器真的把 pytest 输出留在运行流里；\
非修复类的运行验证可用 command_succeeded（跑 pytest / 目标命令退出码 0）、text_contains（目标文件包含新符号、常量或关键改动），\
禁止只声明 file_exists / file_nonempty 这类「存在性验收」——文件存在不代表行为达标，弱验收会让未完成的步骤被误判成功。\
侦察 / 勘查类步骤：必须产出唯一结论文件（如 .wd_mem/recon.md，target 指向它 + file_nonempty），\
后续步骤的 description 里明确写「先读取 <recon 文件> 的结论，禁止重复全目录浏览 / 重复读取已分析文件」，\
避免每个步骤各自重复侦察同一批文件（实测这是 token 燃烧主因之一）。\
\n知识问答降耗约定（#20260918010-#1）：**纯知识问答 / 事实检索 / 咨询解释类目标**\
（如「根据知识库…是什么 / 为什么 / 有哪些 / 讲讲 X」——用户要的是答案，不是文档），\
必须只拆 1 个「调用知识库检索工具查询后直接作答」的步骤：**禁止安排写文件 / 落盘步骤**、\
不要声明 file* 类 success_criteria，检索到内容后在回复中直接给出答案即可；\
真机实证：事实问答被规划成「写决策记录文件」+多轮执行，单次白烧约 5 万 tokens 还向工作空间写入用户未要求的文件。\
\n7. 只输出如下结构的 JSON，不要任何多余文本或 markdown 代码块：\
\n{2}",
        outline,
        ws_line,
        json_example,
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
                    // 方案 B：用户显式指定输出路径（如「写到 src/views/Profile.tsx」）→ 强制覆盖规划的写文件路径，
                    // 消除小模型路径漂移（用户要 Profile.tsx 却写到 Login/index.tsx）。确定性提取，不依赖模型自律。
                    if let Some(explicit) = extract_user_write_path(prompt) {
                        apply_user_explicit_output_path(&mut plan, &explicit);
                        tracing::info!("[agent] planner: 检测到用户显式输出路径 {explicit}，已强制覆盖规划写文件路径");
                    }
                    // 方案 C（图驱动收尾）：用户要求「读取/修改/编辑已有文件」时，确保规划含对应显式步骤，
                    // 避免小模型把「读+改现有文件」吞成不可见步骤（TC-1 实测：读 runtime.rs 改注释被丢）。确定性注入。
                    ensure_existing_file_edit_steps(&mut plan, prompt);
                    if plan.tasks.is_empty() {
                        tracing::info!("[agent] planner: 规划结果为空，降级 Single-Task Fallback");
                        return (single_task_fallback(prompt), usage, content.clone());
                    }
                    tracing::info!(
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
                    (plan, usage, content.clone())
                }
                None => {
                    tracing::info!(
                        "[agent] planner: 规划 JSON 解析失败，降级 Single-Task Fallback content={}",
                        runtime::clip(&content, 400),
                    );
                    (single_task_fallback(prompt), usage, content.clone())
                }
            }
        }
        Err(e) => {
            tracing::warn!("[agent] planner: 规划调用失败：{e}，降级 Single-Task Fallback");
            (single_task_fallback(prompt), (0, 0), String::new())
        }
    }
}

/// 系统能力大纲（概括，不含 JSON Schema）。
/// 与能力层注册表保持同源：原生收敛工具 + 全局注入的 MCP/Skill。
fn capability_outline(cfg: &AgentRuntimeConfig) -> String {
    // 能力清单（按先后顺序排列，不含编号），最后统一编号，保证「沙箱条目被条件跳过」时编号仍连续。
    let mut caps: Vec<String> = vec![
        "本地文件系统操作：读 / 写 / 改 / 删 / 移 / 列目录 / 检索 / 压缩解压 / 正则替换（限于授权工作空间内）；HTTP 请求（native__http_request，需用户审批）；".to_string(),
    ];
    // 方案 A：沙箱运行时仅在 allow_sandbox=true 时列入能力大纲，与工具注册表同源
    //（allow_sandbox=false 时沙箱工具未注册，此处也不应谎称「你有沙箱能力」，否则又一处提示/能力不一致）。
    if cfg.allow_sandbox {
        caps.push(
            "沙箱 Python 执行（run_python_sandbox，直接传 code 参数）：数据抓取、报表生成、数学建模；沙箱为纯净 Python 3.11，脚本运行时会自动按需安装缺失的常用数据科学库（pandas/numpy/openpyxl/scipy 等），你只需正常 import 即可，无需手动安装；".to_string(),
        );
    }
    caps.push("工作空间记忆管理：沉淀或提取 .wd_mem/ 历史工件与长期记忆；".to_string());
    // 知识库检索（K2）：仅在绑定了知识库时列入能力大纲（与工具注册同源）。
    // 明确「优先检索而非臆测」，避免规划员把「查资料」规划成凭记忆编造。
    if !cfg.kb_ids.is_empty() {
        caps.push(
            "知识库检索（native__kb_search(query, kb_ids?, tags?)：默认检索**全部已绑定知识库**中的文档片段，返回源文件与层级位置可溯源；按库收窄传 kb_ids（库 id 或 identifier，须已绑定）；tags 仅用于**文档级标签**过滤（meta_data.tags，不是库名/identifier））；\
             涉及事实、配置、领域知识的问题应**优先检索知识库核对**，而非凭记忆臆测；"
                .to_string(),
        );
    }
    let mut lines: Vec<String> = Vec::with_capacity(caps.len() + 2);
    for (i, c) in caps.iter().enumerate() {
        lines.push(format!("{}. {}", i + 1, c));
    }
    let mut idx = caps.len() + 1;
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
        idx += 1;
    }
    // 本地插件（P2 纯增量，与 MCP/Skill 同款模式）：plugin_tools 为空时不出现该行。
    // 存在插件时明确「优先直接调用」，避免规划员把任务规划成手写脚本重复实现插件功能
    // （设计稿 §13 预判风险；真机 2026-09-16 首测暴露：planner 不知插件存在 → 规划成写 Python 脚本）。
    if !cfg.plugin_tools.is_empty() {
        let names: Vec<String> = cfg
            .plugin_tools
            .iter()
            .map(|p| format!("custom__{}（{}）", p.identifier, p.description))
            .collect();
        lines.push(format!(
            "{idx}. 本地插件工具（用户自定义函数，任务与其描述匹配时**必须优先直接调用对应 custom__ 工具**，\
严禁手写脚本重复实现插件已有功能）：{}；",
            names.join("、")
        ));
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
            success_criteria: vec![],
            depends_on: vec![],
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

/// 方案 B：从用户提示中**确定性**提取其显式指定的输出文件路径。
///
/// 仅匹配高精度的「动作关键词 + 路径」结构（写到 / 写入 / 保存到 / 输出到 …），
/// 不靠模型自律，也不对提示里任何路径都下手（避免误伤「读取某现有文件」这类引用路径）。
/// 例如「…写到 src/views/Profile.tsx，含表单」→ `src/views/Profile.tsx`。
fn extract_user_write_path(prompt: &str) -> Option<String> {
    const KW: &[&str] = &["写到", "写入", "保存到", "保存至", "输出到", "落地到"];
    for &k in KW {
        if let Some(pos) = prompt.find(k) {
            let rest = &prompt[pos + k.len()..];
            // 截到空白或常见中英文标点为止，即为该路径 token
            let token = rest
                .split(|c: char| {
                    c.is_whitespace()
                        || matches!(
                            c,
                            '，' | ',' | '。' | '；' | ';' | '：' | ':' | '（' | '(' | '）' | ')' | '”'
                                | '"' | '\'' | '`'
                        )
                })
                .find(|t| !t.is_empty())
                .unwrap_or("")
                .trim()
                .trim_matches(|c| matches!(c, '`' | '"' | '\'' | '“' | '”'));
            if !token.is_empty() && looks_like_path(token) {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// 路径形态判定：含分隔符，或含 ≤5 字符的扩展名。
fn looks_like_path(s: &str) -> bool {
    if s.contains('/') || s.contains('\\') {
        return true;
    }
    if let Some(dot) = s.rfind('.') {
        let ext = &s[dot + 1..];
        return !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric());
    }
    false
}

/// 方案 B：把用户显式路径覆盖进规划的写文件步骤（`success_criteria.target` + 描述），
/// 使 planner 的「垃圾占位名 / 路径漂移」目标被确定性纠正，而非依赖模型自律。
fn apply_user_explicit_output_path(plan: &mut PlanDAG, explicit: &str) {
    const FILE_TYPES: &[&str] = &[
        "file_exists",
        "file_nonempty",
        "directory_exists",
        "json_valid",
        "text_contains",
        "text_min_lines",
        "excel_row_count",
    ];
    let is_file = |ct: &str| FILE_TYPES.contains(&ct.to_lowercase().as_str());
    let fp: Vec<usize> = plan
        .tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.success_criteria.iter().any(|c| is_file(&c.check_type)))
        .map(|(i, _)| i)
        .collect();
    if fp.is_empty() {
        return;
    }
    let apply = |t: &mut PlanSubTask| {
        for c in t.success_criteria.iter_mut() {
            if is_file(&c.check_type) {
                c.target = Some(explicit.to_string());
            }
        }
        if !t.description.contains(explicit) {
            t.description = format!("{}（必须写到 {}）", t.description, explicit);
        }
    };
    if fp.len() == 1 {
        // 单文件产出（最常见：生成单页）→ 直接覆盖该步
        apply(&mut plan.tasks[fp[0]]);
    } else {
        // 多文件步骤：仅覆盖占位名/缺失的 target；若都合法则覆盖最后一步（最终交付物假设）
        let mut patched = false;
        for &i in &fp {
            let needs = plan.tasks[i]
                .success_criteria
                .iter()
                .any(|c| c.target.as_deref().map(is_placeholder_target).unwrap_or(true));
            if needs {
                apply(&mut plan.tasks[i]);
                patched = true;
            }
        }
        if !patched {
            apply(&mut plan.tasks[*fp.last().unwrap()]);
            tracing::warn!(
                "[agent] planner: 多文件步骤存在，已把用户显式路径 {} 覆盖到最后一步产出（多交付物场景请人工核对）",
                explicit
            );
        }
    }
}

/// 占位名判定（精准，避免误伤 `output/data.csv` 等合法目标）。
fn is_placeholder_target(s: &str) -> bool {
    let low = s.to_lowercase();
    low.contains("generated_code") || low.contains("placeholder") || low.trim().is_empty()
}

/// 提取用户要求「读取/修改/编辑已有文件」的路径（方案 C 显式步骤注入用）。
/// 与 `extract_user_write_path` 互补：后者抓「创建新文件」的**写**路径，本函数抓「读/改现有文件」。
/// 确定性字符串提取（不引 regex，与现有风格一致）：动作词 + 其后首个路径 token。
fn extract_user_edit_paths(prompt: &str) -> Vec<String> {
    const KW: &[&str] = &["读取", "修改", "编辑", "改动", "更新", "修正", "改", "读"];
    let mut out: Vec<String> = Vec::new();
    for &k in KW {
        let mut start = 0;
        while let Some(pos) = prompt[start..].find(k) {
            let abs = start + pos;
            let rest = &prompt[abs + k.len()..];
            let token = rest
                .split(|c: char| {
                    c.is_whitespace()
                        || matches!(
                            c,
                            '，' | ',' | '。' | '；' | ';' | '：' | ':' | '（' | '(' | '）' | ')' | '”'
                                | '"' | '\'' | '`'
                        )
                })
                .find(|t| !t.is_empty())
                .unwrap_or("")
                .trim()
                .trim_matches(|c| matches!(c, '`' | '"' | '\'' | '“' | '”'));
            if !token.is_empty() && looks_like_path(token) && !out.iter().any(|e| e == token) {
                out.push(token.to_string());
            }
            start = abs + k.len();
        }
    }
    out
}

/// 方案 C（图驱动收尾）：用户要求「读取/修改/编辑已有文件」时，确保规划含对应显式步骤，
/// 避免小模型把「读+改现有文件」吞成不可见步骤（TC-1 实测：读 runtime.rs 改注释被丢）。
/// 确定性提取 + 注入，不依赖模型自律：把未被任何步骤覆盖的编辑路径补成末尾显式步骤
/// `teN`（依赖最后一步），不重排已有步骤以保持 `depends_on` 引用安全；空 `success_criteria`
/// 避免纯修改步骤被客观校验误判未闭环。已超 `MAX_PLAN_STEPS` 则跳过（不破坏既有规划上限）。
fn ensure_existing_file_edit_steps(plan: &mut PlanDAG, prompt: &str) {
    if plan.tasks.is_empty() || plan.tasks.len() >= MAX_PLAN_STEPS {
        return;
    }
    let edit_paths = extract_user_edit_paths(prompt);
    if edit_paths.is_empty() {
        return;
    }
    for ep in edit_paths {
        // 已存在覆盖该路径的步骤（标题/描述含该路径，含创建类步骤）→ 跳过，避免重复注入。
        let covered = plan
            .tasks
            .iter()
            .any(|t| t.title.contains(&ep) || t.description.contains(&ep));
        if covered {
            continue;
        }
        let new_step = plan.tasks.len() + 1;
        let depends_on = plan
            .tasks
            .last()
            .map(|t| vec![t.task_id.clone()])
            .unwrap_or_default();
        plan.tasks.push(PlanSubTask {
            step: new_step,
            task_id: format!("te{new_step}"),
            title: format!("读取并修改 {ep}"),
            description: format!(
                "读取 {ep} 并按用户要求修改其内容（如改注释/微调），不新建其它文件"
            ),
            success_criteria: vec![],
            depends_on,
        });
        tracing::warn!(
            "[agent] planner: 检测到用户要求修改已有文件 {ep}，已补显式步骤 te{new_step}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_user_write_path_detects_explicit() {
        assert_eq!(
            extract_user_write_path("帮我新建登录页，写到 src/views/Profile.tsx，含表单"),
            Some("src/views/Profile.tsx".to_string())
        );
        assert_eq!(
            extract_user_write_path("保存到 src/pages/Login.tsx 即可"),
            Some("src/pages/Login.tsx".to_string())
        );
        assert_eq!(
            extract_user_write_path("输出到 `output/report.csv` 中"),
            Some("output/report.csv".to_string())
        );
        // 无显式写路径关键词 -> None（不误伤引用现有文件路径）
        assert_eq!(
            extract_user_write_path("请读取 src/utils/foo.ts 并修复其中的 bug"),
            None
        );
    }

    #[test]
    fn extract_user_edit_paths_detects_existing_file() {
        let p = extract_user_edit_paths(
            "读取 src/agent/runtime.rs 改一处注释，再新建 src/views/demo.tsx",
        );
        assert!(p.contains(&"src/agent/runtime.rs".to_string()));
        // 创建类「写到」路径不应被当作编辑路径提取
        assert!(extract_user_edit_paths("帮我新建页面，写到 src/views/a.tsx 即可").is_empty());
        // 无路径的动作词不误提
        assert!(extract_user_edit_paths("改进代码质量").is_empty());
    }

    #[test]
    fn ensure_existing_file_edit_steps_injects() {
        let mut plan = PlanDAG {
            goal_summary: "x".into(),
            tasks: vec![PlanSubTask {
                step: 1,
                task_id: "t1".into(),
                title: "新建 demo".into(),
                description: "写到 src/views/demo.tsx".into(),
                success_criteria: vec![],
                depends_on: vec![],
            }],
        };
        ensure_existing_file_edit_steps(
            &mut plan,
            "读取 src-tauri/src/agent/runtime.rs 改一处注释，再新建 src/views/demo.tsx",
        );
        assert_eq!(plan.tasks.len(), 2);
        let injected = plan
            .tasks
            .iter()
            .find(|t| t.title.contains("runtime.rs"))
            .expect("应注入 runtime.rs 步骤");
        assert_eq!(injected.task_id, "te2");
        assert_eq!(injected.depends_on, vec!["t1".to_string()]);
        assert!(injected.success_criteria.is_empty());
    }
}
