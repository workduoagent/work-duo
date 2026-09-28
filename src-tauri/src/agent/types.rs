//! 智能体运行时共享类型（与前端 `session/types.ts` 事件契约对应）。
//!
//! 这些类型经 Tauri `app.emit` 推送给前端，命名与字段保持前后端一致。

use serde::Serialize;

use crate::agent::plugins::mcp_adapter::MountedMcpTool;
use crate::agent::plugins::skill_adapter::SkillToolWrapper;

/// 工具调用步骤的实时状态（对应前端 ToolStep）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStep {
    pub call_id: String,
    pub tool_name: String,
    pub status: String, // running | success | failed
    pub sensitive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub created_at: i64,
    /// 该工具调用所属的子任务步骤序号（从 1 起）。串行化后同一时刻仅一个步骤在跑，
    /// 但保留此字段可让前端精确归属工具调用到对应步骤卡片，未来若恢复并行也不会错乱。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<usize>,
    /// 操作类型（read/write/edit/create/delete/move/list/search/exec/http/mcp…），
    /// 供前端「一行式工具行」展示动词（读取/编辑/新增/删除…）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    /// 目标文件 / 路径（相对工作空间原文，前端取文件名展示）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 本次变更新增行数（仅文件变更类工具，后端精确 diff 得出）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<u32>,
    /// 本次变更删除行数（仅文件变更类工具，后端精确 diff 得出）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<u32>,
}

/// 审批请求（高危操作挂起，对应前端 ApprovalRequest）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub tool_name: String,
    pub description: String,
    /// 结构化入参（JSON 字符串）。
    pub args: String,
    /// 工具类别：edit_file / execute_command / other。
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// 边审批策略命中原因（15007；非策略命中时为 None）。例：「命中危险信号 [ci]：.github/workflows（目标：…）」
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 策略授权 key（15007；「本任务内记住」勾选后由 submit_approval_decision 写入 grants）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_key: Option<String>,
    /// 授权域（HostAuthz 独立授权域）："host" = 走 HostAuthz 卡片与 host_grant；
    /// None/其它 = 本地域（local grants）。serde 向后兼容：旧载荷无此字段按 local。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// Host 审批卡片 / host_grant 写入所需的上下文（仅 domain=host 时携带）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_meta: Option<serde_json::Value>,
    /// 本轮 run id（host_grant 生命周期与审计关联）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// 方案推荐：单个可选项（Agent 调 `native__ask_user_choice` 时给出；前端渲染为 chip）。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    /// 选项唯一 id（前端回传时用）。
    pub id: String,
    /// 展示文案。
    pub label: String,
    /// 补充说明（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 机器语义值（可选，如具体路径/模型名；回传时一并带回）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// 方案推荐请求载荷（事件 `agent-choice-needed` 携带，渲染选项列表弹窗）。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceRequest {
    /// 本次询问唯一标识（oneshot 通道 key）。
    pub choice_id: String,
    /// 向用户提出的问题。
    pub question: String,
    /// 可选项列表（2–5 个）。
    pub options: Vec<ChoiceOption>,
}

/// 方案推荐：用户选择「其他 / 自定义」时前端回传的 option_id 哨兵值。
/// 前端渲染自由文本输入框，用户提交自定义方案时以该 id 唤醒挂起，
/// 真实文案经 `ChoiceOutcome::custom_text` 带回。
pub const CHOICE_CUSTOM_ID: &str = "__custom__";

/// 方案推荐结果（用户点选后回传，作为 `native__ask_user_choice` 工具结果注入 Agent 上下文）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChoiceOutcome {
    pub option_id: String,
    pub label: String,
    pub value: Option<String>,
    /// 用户自定义方案文本（仅当用户选择「其他 / 自定义」时填充）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
}

/// 聊天附件，由前端随 `run_agent_task` 传入，注入当前轮 user 消息。
///
/// 三类路由（与前端 `ChatAttachmentInput` 对应）：
/// - `image`：多模态图片，`data_url` 注入 OpenAI 多模态数组（仅多模态模型可用）。
/// - `text`：已提取文本（代码/配置/数据/md/json/csv/log 等，≤200KB），`content` 直接内联进 prompt（任意模型可用）。
/// - `file`：二进制/超大文件（pdf/docx/xlsx/zip 等），`content` 为 base64，`kind=file` 时由 `inject_attachments` 落盘到 `workspace/.attachments/`，注入路径提示，由 agent 用 `native__read_file`/沙箱按需解析（任意模型可用）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    /// 附件类型：`image` / `text` / `file`。
    #[serde(rename = "type")]
    pub kind: String,
    /// 多模态图片的 data URL（`data:image/<ext>;base64,...`）；仅 `kind=image` 使用。
    /// （2026-09-27 改为可选：text/file 型载荷不携带 dataUrl，必填曾致 C1-2/E9-4 类
    /// 调用被 400 拒收——capability-v2 F3。）
    #[serde(default)]
    pub data_url: String,
    /// 文本内容（`kind=text`）或 base64 数据（`kind=file`）。
    #[serde(default)]
    pub content: Option<String>,
    /// MIME 类型（如 `application/pdf`、`text/plain`），用于落盘附件提示 agent 选择解析方式。
    #[serde(default)]
    pub mime: Option<String>,
    /// 字节大小，用于阈值判断与提示。
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    /// 已分片落盘的本地绝对路径（`kind=file`，由前端 `stage_attachment` 命令返回）。
    /// 存在时 `inject_attachments` 直接复用该路径，不再 base64 解码写盘。
    #[serde(default)]
    pub path: Option<String>,
}

/// 网络代理配置（对应 app_config.network_proxy：direct / system / manual）。
///
/// - `direct`：不使用代理（`.no_proxy()`，无视系统代理——开 VPN 时也能直连 LAN / 本机模型）；
/// - `system`：沿用 reqwest 默认（读取系统代理）；
/// - `manual`：按 `http` / `https` / `socks5` 字段显式设置代理。
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct NetworkProxy {
    #[serde(default = "default_proxy_mode")]
    pub mode: String,
    #[serde(default)]
    pub http: Option<String>,
    #[serde(default)]
    pub https: Option<String>,
    #[serde(default)]
    pub socks5: Option<String>,
}

fn default_proxy_mode() -> String {
    "direct".to_string()
}

/// 已挂载到运行时（待注册为 `custom__<identifier>` 工具）的本地插件元信息。
///
/// 由 `load_config` 经 `agent_plugin_ref` JOIN `user_plugin_tool` 装配（P2 起），
/// 过滤条件 `ref.is_active=1 AND tool.enabled=1 AND agent.allow_sandbox=1`。
/// 此处仅携带「执行所需」的最小字段，脚本内容内联进 Runner 壳，不落用户目录。
#[derive(Debug, Clone)]
pub struct MountedUserPlugin {
    pub plugin_id: String,
    /// 工具 slug（无 `custom__` 前缀）。
    pub identifier: String,
    pub name: String,
    pub description: String,
    /// 运行时：`python` | `bun`。
    pub runtime: String,
    /// 用户核心代码（仅 `run` + 头注释，不含 Runner 壳）。
    pub script_content: String,
    /// OpenAI function 可用的 JSON Schema（已解析对象）。
    pub parameters_schema: serde_json::Value,
    /// 单次执行超时（秒，硬上限 300）。
    pub timeout_sec: u64,
}

/// 单个 agent 运行配置（由前端 run_agent_task 传入，或从 agent_info 读取）。
#[derive(Debug, Clone, Default)]
pub struct AgentRuntimeConfig {
    pub agent_id: String,
    pub system_prompt: String,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model_name: String,
    pub llm_config: serde_json::Value, // 智能体私有参数副本（temperature / max_tokens ...）
    pub auto_tool_exec_mode: bool, // 外部资源自动执行：true 时敏感工具跳过逐次审批
    pub allow_sandbox: bool,
    /// 记忆模式：off=关闭 / active=主动 / forced=强制。驱动能力层是否注册 anchor 工具、提示层是否注入沉淀引导、流水线末是否强制总结沉淀。
    pub memory_mode: String,
    /// 计划审批策略模式（Phase 2b-3 `allow` 规则层）：
    /// - "always"：所有复合任务规划后都走人工审批门禁（默认，保持最严格）；
    /// - "sensitive"：仅含敏感操作的计划走审批，纯低风险计划（文件创建/编辑/UI 等）自动放行；
    /// - "never"：复合任务一律不审批，规划后直接执行。
    pub plan_auto_approve_mode: String,
    pub workspace: Option<String>,
    pub mcp_tools: Vec<MountedMcpTool>, // 已挂载 MCP 工具（含真实 tool_code 与描述）
    pub skill_tools: Vec<SkillToolWrapper>, // 已绑定技能包装
    pub session_id: Option<String>, // 前端建好的会话 id（用于累计 input_token 与上下文压缩）
    pub round_id: Option<String>, // 前端建好的本轮 id（ReAct 循环结束后回填 raw_messages_json）
    /// 当前轮用户消息附件（多模态图片；仅注入当轮，历史轮由 raw_messages_json 原样保留）。
    pub attachments: Vec<AttachmentInput>,
    /// HTTP 请求主机白名单（由 app_config.http_allowed_hosts 解析）：空 = 不限制；
    /// 非空 = 仅允许命中列表中的主机（含其子域），native__http_request 据此拒绝越界主机。
    pub http_allowed_hosts: Vec<String>,
    /// 网络代理模式（direct / system / manual），由 app_config.network_proxy 解析。
    /// 智能体所有 LLM 出站请求据此建客户端：direct 无视系统代理（兼容开 VPN 时直连 LAN 模型）。
    pub network_proxy: NetworkProxy,
    /// 已挂载的本地插件（含真实 script_content 与 schema），注册为 `custom__<identifier>` 工具。
    /// P1 起暂由 `load_config` 置空（装配延 P2），但字段与结构体先行落地以免后续改动面扩散。
    #[allow(dead_code)] // P2 runtime.rs 读取；P1 仅置空
    pub plugin_tools: Vec<MountedUserPlugin>,
    /// 已绑定的知识库 id（K2，agent_kb_ref）：非空时注册 `native__kb_search` 工具并在
    /// planner 能力大纲中列出（提示与能力同源——未绑定时两者都不出现）。
    pub kb_ids: Vec<String>,
    /// 已绑定的服务器档案（服务器托管，agent_server_ref JOIN server_host）：
    /// 非空时注册 `host__*` 工具族并走 HostAuthz 独立授权域。
    pub server_bindings: Vec<crate::host::types::ServerBinding>,
}

/* ================= 三层流水线架构（意图分流 → DAG 规划 → 微 ReAct 执行） ================= */

/// 阶段一产物：意图分类 + 执行策略（Runtime Policy）。
///
/// 意图不再只是「是不是复杂任务」的二分类，而是告诉 Runtime「该用什么执行策略」：
/// - `requires_planning` / `requires_tool`：是否进入规划链、是否需要工具（驱动 Planner，不让 Planner 自判）；
/// - `risk_level`：LOW / MEDIUM / HIGH / CRITICAL，高风险任务强制走审批（即使开启 auto_tool_exec_mode）；
/// - `requires_approval` / `requires_artifact`：本次任务是否必须经过人工审批、是否应沉淀产物。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct IntentProfile {
    /// "SIMPLE_CHAT" | "COMPOSITE_TASK"（向后兼容既有意图值）。
    pub intent_type: String,
    #[serde(default)]
    pub reason: String,
    /// 是否需要进入阶段二规划链（SIMPLE_CHAT=false，COMPOSITE_TASK=true）。
    #[serde(default)]
    pub requires_planning: bool,
    /// 是否涉及工具调用（驱动能力层是否挂载工具、Planner 是否输出工具型子任务）。
    #[serde(default)]
    pub requires_tool: bool,
    /// 风险等级：low | medium | high | critical。high/critical 会强制走人工审批。
    #[serde(default = "default_risk")]
    pub risk_level: String,
    /// 是否必须人工审批（即便 auto_tool_exec_mode=true）。
    #[serde(default)]
    pub requires_approval: bool,
    /// 是否应沉淀产物（影响 Artifact 注册表是否写入）。
    #[serde(default)]
    pub requires_artifact: bool,
}

fn default_risk() -> String {
    "low".to_string()
}

impl IntentProfile {
    pub fn is_simple_chat(&self) -> bool {
        self.intent_type.eq_ignore_ascii_case("SIMPLE_CHAT")
    }

    /// 风险等级数值（low=0, medium=1, high=2, critical=3），用于比较与升级决策。
    pub fn risk_rank(&self) -> u8 {
        match self.risk_level.to_lowercase().as_str() {
            "critical" => 3,
            "high" => 2,
            "medium" => 1,
            _ => 0,
        }
    }

    /// 是否命中高风险（high / critical）：强制人工审批。
    pub fn is_high_risk(&self) -> bool {
        self.risk_rank() >= 2
    }
}

/// 阶段二产物：单个原子子任务（DAG 节点；当前按 step 顺序串行执行）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PlanSubTask {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    pub description: String,
    /// 成功判定标准（L0/L1 确定性校验，#9）：声明了则子任务终态须经客观校验，
    /// 不通过即判未闭环进入恢复链路。模型不总是产出，故默认空。
    #[serde(default)]
    pub success_criteria: Vec<SuccessCriterion>,
    /// DAG 依赖：本步骤开始执行前必须已成功完成的步骤 task_id 列表（空=无依赖，可并行）。
    /// planner 只引用前文步骤的 task_id，形成有向无环图；调度器据此拓扑排序 + 并行。
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// 单个成功判定标准（确定性、可由文件/内容客观核验，不依赖主观判断）。
///
/// 校验类型（type）：
///  - `file_exists`：目标路径文件存在；
///  - `file_nonempty`：目标路径文件存在且大小 > 0；
///  - `directory_exists`：目标路径目录存在；
///  - `json_valid`：目标路径文件可被解析为合法 JSON；
///  - `text_contains`：目标路径文件内容包含 `value`；
///  - `text_min_lines`：目标路径文件行数 ≥ `threshold`；
///  - `excel_row_count`：xlsx 行数 ≥ `threshold`（暂以「文件存在且非空」代理，不引入 Excel 解析依赖）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessCriterion {
    /// 校验类型（见上）。
    #[serde(rename = "type")]
    pub check_type: String,
    /// 校验目标路径（相对工作空间；L0/L1 之外的检查类型可空）。
    #[serde(default)]
    pub target: Option<String>,
    /// 匹配文本（text_contains 使用）。
    #[serde(default)]
    pub value: Option<String>,
    /// 阈值（text_min_lines / excel_row_count 的行数）。
    #[serde(default)]
    pub threshold: Option<usize>,
}

/// 阶段二产物：任务拆解规划（宏观目标 + 有序子任务列表）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PlanDAG {
    pub goal_summary: String,
    pub tasks: Vec<PlanSubTask>,
}

/// 子任务产物引用（注册进 `artifacts` 表 + 经 `artifact_created` 事件推前端「产物画廊」）。
///
/// 产物是「逻辑实体」，文件只是其一种实现；同一（task_id, path）重跑覆盖时 version 自增。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    /// 产物唯一标识（art_<epochMs>_<step>_<idx>）。
    pub artifact_id: String,
    /// 产生该产物的子任务 id（PlanSubTask.task_id）。
    pub task_id: String,
    /// 子任务序号（1-based）。
    pub step: usize,
    /// 产物类型：file / image / document / spreadsheet / code / json / report / directory …
    pub artifact_type: String,
    /// 产物绝对路径（已规范化、落于工作空间内）。
    pub path: String,
    /// MIME 类型（由扩展名推导）。
    pub mime_type: String,
    /// 描述（文件名或摘要片段）。
    pub description: String,
    /// 字节大小。
    pub size: u64,
    /// 创建时间（epoch 毫秒）。
    pub created_at: i64,
}

/// 产物预览读取结果（供前端画布「点击产物预览」调用 `read_artifact` 命令）。
///
/// 按扩展名/文件类型返回不同载荷：
///  - `text`：纯文本（超长截断，truncated=true），content 为预览正文；
///  - `image`：图片，data_url 为 `data:<mime>;base64,...`，前端直接 `<img>` 渲染；
///  - `directory`：目录，entries 为子项名称列表；
///  - `binary`：二进制（pdf/docx/xlsx/zip 等），暂不支持内联预览，content 提示路径；
///  - `not_found` / `error`：读取失败，content 含原因。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactResult {
    pub path: String,
    pub name: String,
    /// text | image | directory | binary | not_found | error
    pub kind: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<String>>,
    #[serde(default)]
    pub truncated: bool,
}

/// 分支重规划的单步（from_step 之后的替代方案，已重编号续接原步骤序号）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStep {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// 分支重规划结果（从 from_step 起的「原尾段 vs 新分支」双分支对比）。
///
/// 经 `agent-plan-branch` 事件推前端，供画布「从此步骤分支」菜单渲染对比横幅 + 应用按钮。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanBranchGenerated {
    /// 分支起点步骤序号（从此步骤之后重新规划）。
    pub from_step: usize,
    /// 原方案的尾部步骤（step > from_step），供对比。
    pub original_tail: Vec<BranchStep>,
    /// 新生成的替代分支步骤（已从 from_step+1 起重编号）。
    pub branch_tasks: Vec<BranchStep>,
    /// 用户触发分支时的目标/原因摘要。
    pub goal_summary: String,
}

/// 阶段三产物：单个子任务的结算输出。
/// 投入「产物管道」，作为后续子任务的**唯一**前置输入；
/// 子任务内部几万字的工具报文与报错重试记录全部物理销毁，绝不流入下一环。
#[derive(Debug, Clone)]
pub struct SubTaskOutput {
    // 以下 step/title/skipped 为子任务产出契约字段，与统一实体图节点（step/title/status）冗余；
    // 当前 run_pipeline 仅消费 summary/success/cancelled/artifacts，故标记 allow（图驱动后图节点为唯一事实源）。
    #[allow(dead_code)]
    pub step: usize,
    #[allow(dead_code)]
    pub title: String,
    /// 纯文本产物摘要，如："已拉取 SOL 近 7 天数据共 168 条，写入 .wd_mem/data/sol_raw.json"
    pub summary: String,
    pub success: bool,
    /// 是否被用户中途取消（cancel_agent_task 触发）：取消的子任务不计入失败重试，
    /// 流水线据此提前整体收尾。
    pub cancelled: bool,
    /// 是否被「跳过」（用户选择 Skip，或单步恢复次数达上限被自动跳过）。
    /// 与 `success` 正交：跳过步虽放行后续依赖、流水线可正常收尾，但**不计入「成功闭环」**，
    /// 否则会污染最终回顾与自检（P1-4 修复：原先 `Skip` 把 `success` 置 true 导致跳过=成功）。
    #[allow(dead_code)]
    pub skipped: bool,
    /// 本子任务成功闭环后登记的文件产物（注册进 artifacts 表，驱动前端「产物画廊」）。
    #[allow(dead_code)]
    pub artifacts: Vec<ArtifactRef>,
    /// 最近一次失败工具的命令文本（沙箱 code / execute_command 的 command / 路径类字段），
    /// 供 `run_pipeline` 恢复块传给 `classify_tier` 做风险词匹配（决定档 A/B）。
    /// 仅在子任务以失败收场时才有意义；取消 / LLM 失败等无工具错误的路径为 `None`。
    pub failed_command: Option<String>,
    /// 本子任务执行期间实际改动过的文件路径（write/edit/delete/move 的 path 参数去重聚合），
    /// 供 `run_pipeline` 恢复块填 `RecoveryRequest.changed_files`，驱动接管面板「已改文件」区。
    pub changed_files: Option<Vec<String>>,
    /// 本子任务执行期间实际读取过的文件路径（read_file 的 path 参数去重聚合），
    /// 供 `run_pipeline` 成功闭环写图（FileRef + Read 边），记录「哪一步读了哪些文件」（阶段二图驱动）。
    pub read_files: Option<Vec<String>>,
    /// 步骤闭环是否具备客观可核验证据（Phase E 验证优先）：true=已验证 / false=暂定（无 criteria 或仅模型自报）。
    pub verified: bool,
    /// 客观证据说明（首个客观通过项详情 / 暂定原因），供前端/回复展示「暂定完成」时提示用户。
    pub evidence: String,
}

impl SubTaskOutput {
    /// 统一构造基座（台账 S2）：此前 10 处字段级复制块——改字段漏一处=编译过但行为分叉。
    /// step/title 从任务派生，skipped/cancelled/failed_command/verified/evidence/artifacts/
    /// changed/read_files 取保守默认；各构造点用 struct update（`..Self::base(..)`）只写差异字段。
    /// `changed`/`read` 统一 empty→None 归一化（消灭 8 份 if/else 各写各的）。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn base(
        task: &PlanSubTask,
        summary: impl Into<String>,
        success: bool,
        changed_files: &[String],
        read_files: &[String],
    ) -> Self {
        Self {
            step: task.step,
            title: task.title.clone(),
            summary: summary.into(),
            success,
            cancelled: false,
            skipped: false,
            artifacts: vec![],
            failed_command: None,
            changed_files: if changed_files.is_empty() { None } else { Some(changed_files.to_vec()) },
            read_files: if read_files.is_empty() { None } else { Some(read_files.to_vec()) },
            verified: false,
            evidence: String::new(),
        }
    }
}

/* ================= 小分队（Squad）协作引擎类型 ================= */

/// 小分队运行策略（三模式通用；JSON 存于 agent_squad.run_strategy）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadRunStrategy {
    /// 执行方式：manual（UI 点启动）/ schedule（定时）/ api（外部调用）。
    #[serde(default = "default_execution_mode", alias = "execution_mode")]
    pub execution_mode: String,
    /// 定时表达式（execution_mode=schedule 时使用）。
    #[serde(default)]
    pub schedule_cron: Option<String>,
    /// 节点失败重试次数（包裹每次成员 run_task 调用，默认 3）。
    #[serde(default = "default_retry_count", alias = "retry_count")]
    pub retry_count: u32,
    /// 定时 / API 模式触发时使用的默认任务指令（执行模式非 manual 时由调度器 / API 服务读取，
    /// UI 点启动 manual 运行时仍用用户即时输入）。
    /// alias 兼容 snake_case 写法（2026-09-28 真机实证：rename_all=camelCase 下写入
    /// schedule_prompt 会静默丢字段 → API 触发的任务内容为空，成员全部在「澄清目标」空转）。
    #[serde(default, alias = "schedule_prompt")]
    pub schedule_prompt: Option<String>,
    /// S2：本次协作的 token 总预算（prompt+completion；0=不限）。
    /// 累计用量 ≥80% 发告警轮，≥100% 软熔断（不再启动新子任务，当前跑完即收尾）。
    #[serde(default, alias = "budget_tokens")]
    pub budget_tokens: u64,
}

/// 群聊协商专属配置（agent_squad_chat_config）。
#[derive(Debug, Clone, Default)]
pub struct SquadChatConfig {
    /// 发言轮次上限（默认 8）。
    pub max_rounds: usize,
    /// 汇总主笔（最终产物结论负责人）；可为 leader_agent_id 或单独指定。
    pub summarizer_agent_id: Option<String>,
}

/// S2（§4.2）成员角色工具面：能力层裁剪配置（非 prompt 空谈）。
/// 存于 agent_squad_member.tool_profile_json；裁剪发生在成员规划之前，
/// planner_digest 从裁剪后 registry 派生（S6）——能力大纲与实际工具自动同源。
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SquadToolProfile {
    /// inherit（跟随智能体默认，不裁剪）| allowlist（仅允许列出工具）| denylist（禁用列出工具）。
    /// 空列表的 allowlist 视为 inherit（防「白名单没配=零工具」误伤）。
    pub mode: String,
    /// 原生工具名全名清单（native__read_file / native__write_file / ...）。
    #[serde(default, alias = "native_tools", skip_serializing_if = "Vec::is_empty")]
    pub native_tools: Vec<String>,
    /// MCP 工具名全名清单（mcp__{server}__{tool}）。
    #[serde(default, alias = "mcp_tools", skip_serializing_if = "Vec::is_empty")]
    pub mcp_tools: Vec<String>,
    /// Skill 过滤（Skill 经 prompt 注入无独立能力层，本批仅落库透传，过滤归 S3）。
    #[serde(default, alias = "skill_ids", skip_serializing_if = "Vec::is_empty")]
    pub skill_ids: Vec<String>,
}

impl SquadToolProfile {
    /// 是否不裁剪（inherit，或空列表的 allowlist 降级防「白名单没配=零工具」误伤）。
    pub fn is_inherit(&self) -> bool {
        match self.mode.as_str() {
            "allowlist" => self.native_tools.is_empty() && self.mcp_tools.is_empty(),
            "denylist" => false,
            _ => true,
        }
    }
}

/// 小分队单个成员的运行配置：在 base agent 的 AgentRuntimeConfig 之上叠加 Squad 定制。
///
/// `agent` 已由 `load_squad` 经 `load_config` 组装（含 LLM / MCP / Skill / 记忆 / 沙箱），
/// `persona_override` 已追加到其 `system_prompt` 末尾（人设注入，不污染 base agent 库）。
#[derive(Debug, Clone)]
pub struct SquadMemberConfig {
    pub agent: AgentRuntimeConfig,
    /// 承担角色，如「后端开发」「UI 设计」。
    pub role: String,
    /// 人设定制（已注入 system_prompt 末尾）。
    #[allow(dead_code)]
    pub persona_override: String,
    /// 流水线工序序号（pipeline 模式用，其余模式为 None）。
    pub pipeline_order: Option<usize>,
    /// 流水线 DAG 依赖：上游成员 agent_id 列表（空 = 按 pipeline_order 线性串流）。
    pub depends_on: Vec<String>,
    /// 是否为主管智能体（编排式 leader）。
    pub is_leader: bool,
    /// S2（§4.2）角色工具面（能力层裁剪配置）。
    pub tool_profile: SquadToolProfile,
}

/// 小分队运行配置：`load_squad` 的产物，供 orchestrator / pipeline / chat 三种协作引擎消费。
#[derive(Debug, Clone)]
pub struct SquadRuntimeConfig {
    pub squad_id: String,
    pub name: String,
    /// 协作模式：orchestrator / pipeline / chat。
    pub mode: String,
    /// 编排式主管智能体 id（群聊可复用为 moderator 默认）。
    pub leader_agent_id: Option<String>,
    /// 全局挂载的 MCP 服务 id（成员运行时强制并入工具集）。
    #[allow(dead_code)]
    pub global_mcp_ids: Vec<String>,
    pub run_strategy: SquadRunStrategy,
    pub members: Vec<SquadMemberConfig>,
    pub chat_config: SquadChatConfig,
    /// 小分队工作区（可选；用户自选产物输出根目录）。
    /// 运行期据此派生成员私有 workspace：有值则为 `{workspace}/{agent_id}`，否则回退 `.wd_mem/squads/{squad_id}/{agent_id}`。
    pub workspace: Option<String>,
}

fn default_execution_mode() -> String {
    "manual".to_string()
}

fn default_retry_count() -> u32 {
    3
}
