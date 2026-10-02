// SQLite 表 -> TypeScript 行映射（SQL 实体）。
// 约定：所有 SQL 行实体集中在此文件定义；SQL 增删改查业务写在 src/core/mapper。
// DDL（建表语句）见 src/assets/sql/init.sql（首启）与 updater.sql（版本变更），二者需保持同步。

/** 模型接入配置表（models）行映射。
 * - 基础信息 + 启用状态；
 * - category 决定模型大类（text / multimimodal / image / stt / tts / embedding / rerank，对应 types/core 的 ModelCategory）；
 * - provider 对应 ModelProvider；
 * - config：该类别专属参数（对应 ModelConfig 的 category 子对象，如 text/multimodal/...）序列化后的 JSON 字符串；
 *   异构参数不拆列，统一以 JSON 落库，后续新增参数只需改 ModelConfig 子结构，无需改表。
 * - tags：标签数组序列化后的 JSON 字符串；
 * - created_at / updated_at：epoch 毫秒（整型），便于排序与索引。
 */
export interface ModelConfigRow {
  id: string
  provider: string // 对应 ModelProvider
  name: string // 展示名
  model_name: string // 服务商侧模型标识
  base_url: string | null // 完整接口地址，如 https://api.openai.com/v1/chat/completions
  api_key: string | null // 密钥（本地明文，安全方案后续统一处理）
  app_id: string | null // 讯飞（iflytek）三件套鉴权：AppId（通用厂商为空）
  api_secret: string | null // 讯飞（iflytek）三件套鉴权：APISecret（通用厂商为空）
  category: string // 对应 ModelCategory
  enabled: number // SQLite 布尔：0 / 1
  tool_calls: number // SQLite 布尔：0 / 1（是否支持 Tool/Function Calling，默认 0=不支持，由用户显式开启）
  config: string // 类别专属参数 JSON 字符串（对应 ModelConfig[category]）
  description: string | null
  tags: string | null // 标签数组 JSON 字符串
  created_at: number // 创建时间，epoch 毫秒
  updated_at: number // 更新时间，epoch 毫秒
}

/** 知识库表（knowledge_base）行映射。
 * - id：本地 UUID（文本主键）；
 * - logo：知识库 Logo（相对 KB 目录路径或 data URL，可空）；
 * - identifier：唯一标识 slug（同时是磁盘目录名）；
 * - name：知识库名称；description：简介；
 * - scenario：场景分类 key（对应 scenario_category scope='KB' 的 value，可空）；
 * - created_at / updated_at：epoch 毫秒（整型）；
 * - file_count / file_size：冗余的聚合字段（该知识库文件总数 / 总字节数），
 *   由 refreshAssets / createKnowledgeBase 写 knowledge_asset 后回写，避免详情页与列表页
 *   每次都 LEFT JOIN knowledge_asset 聚合（反范式化，提升读取性能且消除聚合漂移）。
 */
export interface KnowledgeBaseRow {
  id: string
  logo: string | null
  identifier: string
  name: string
  description: string | null
  scenario: string | null
  created_at: number
  updated_at: number
  file_count: number
  file_size: number
}

/** 知识库资产表（knowledge_asset）行映射。
 * - kb_id：外键，引用 knowledge_base.id；
 * - name：文件名（含扩展名）；
 * - type：资产大类（1-文档 2-图片 3-音频 4-视频 5-网页）；
 * - file_ext：扩展名（不含点、小写）；file_size：文件字节数；
 * - file_path：相对知识库根目录的路径（如 'docs/a.txt'）；
 * - digest：文件内容 hash（Rust 侧增量索引判据，NULL=未索引；v28 K1'）；
 * - indexed_at：最近成功索引时间 epoch 毫秒（NULL=待索引/不支持格式）；
 * - meta_data：资产级 JSON 字符串（标签云 tags 等业务元数据）；
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface KnowledgeAssetRow {
  id: string
  kb_id: string
  name: string
  type: number
  file_ext: string | null
  file_size: number
  file_path: string
  digest: string | null
  indexed_at: number | null
  meta_data: string | null
  created_at: number
  updated_at: number
}

/** 智能体表（agent_info）行映射（对应 PostgreSQL public.agent_info）。
 * - id：本地 UUID（文本主键）；
 * - identifier：智能体唯一标识（系统随机生成，用户可自定义），UNIQUE；
 * - logo：Base64 data URL 头像（未设置时前端回退 lucide 图标）；
 * - scenario：场景分类 key（对应 scenario_category scope='AGENT' 的 value，可空）；
 * - llm_id / tts_id / stt_id：外键，引用 models.id；
 * - llm_config / tts_config / stt_config：JSON 文本，是对应 models.config 的「私有副本」
 *   （models 表仅作初始默认，智能体向导里可自由调参，改的是本列）；
 * - is_active：启用开关（0/1）；auto_tool_exec_mode：外部资源自动执行模式（0/1）；
 *   allow_sandbox：是否允许该智能体使用沙箱环境（0/1）；
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface AgentInfoRow {
  id: string
  logo: string | null
  /** 拟人化像素形象配置 JSON（形象设计弹窗再编辑源；NULL=从未生成/仅历史上传） */
  appearance: string | null
  scenario: string | null
  name: string
  identifier: string
  description: string | null
  system_prompt: string | null
  welcome_message: string | null
  llm_id: string | null
  llm_config: string | null
  tts_id: string | null
  tts_config: string | null
  stt_id: string | null
  stt_config: string | null
  is_active: number // SQLite 布尔：0 / 1
  auto_tool_exec_mode: number // SQLite 布尔：0 / 1
  allow_sandbox: number // SQLite 布尔：0 / 1
  memory_mode: string // 记忆模式：off / active / forced
  plan_auto_approve_mode: string // 计划审批策略：always / sensitive / never
  created_at: number
  updated_at: number
}

/** 智能体 × MCP 工具关联表（agent_mcp_ref）行映射。
 * 关联的最小单元是「工具」：tool_id 引用 mcp_tool_definition.id；
 * mcp_id 为冗余列（工具所属 MCP 服务），仅用于按服务分组展示与级联清理，不参与唯一约束。
 */
export interface AgentMcpRefRow {
  id: string
  agent_id: string
  mcp_id: string
  tool_id: string
  is_active: number // SQLite 布尔：0 / 1
  created_at: number
  updated_at: number
}

/** 智能体 × Skill 关联表（agent_skill_ref）行映射。
 * skill_id 引用 skill_info.id；一个智能体可编排多个技能。
 */
export interface AgentSkillRefRow {
  id: string
  agent_id: string
  skill_id: string
  is_active: number // SQLite 布尔：0 / 1
  created_at: number
  updated_at: number
}

/** 智能体 × 知识库关联表（agent_kb_ref，第四期 K2）行映射。
 * kb_id 引用 knowledge_base.id；绑定关系决定 native__kb_search 的检索范围与注册与否。
 */
export interface AgentKbRefRow {
  id: string
  agent_id: string
  kb_id: string
  is_active: number // SQLite 布尔：0 / 1
  created_at: number
  updated_at: number
}

/** 小分队定义表（agent_squad）行映射。
 * - logo：团队头像 Base64 字符串（可空）；
 * - mode：协作模式 orchestrator / pipeline / chat；
 * - leader_agent_id：编排式主管 / 群聊汇总主笔默认（引用 agent_info.id，可空）；
 * - global_mcp_ids：全局挂载 MCP 服务 id 数组（JSON 文本，可空）；
 * - run_strategy：运行策略 JSON（{ execution_mode, schedule_cron?, retry_count? }，可空）；
 * - created_at / updated_at：epoch 毫秒。
 */
export interface AgentSquadRow {
  id: string
  name: string
  logo: string | null
  description: string | null
  mode: string
  leader_agent_id: string | null
  unique_id: string | null
  global_mcp_ids: string | null // JSON 数组文本
  global_mcp_tools?: string | null // JSON 对象文本：{ [mcpId]: 被禁用工具 id[] }
  run_strategy: string | null // JSON 文本
  supports_file_input: number // 0 / 1
  workspace_dir?: string | null // 用户自选产物输出根目录（可空）
  created_at: number
  updated_at: number
}

/** 小分队成员任职表（agent_squad_member）行映射。
 * - role：承担角色；persona_override：人设定制（拼到成员 system_prompt 末尾）；
 * - pipeline_order：流水线工序序号（pipeline 模式用，其余 NULL）；
 * - is_leader：编排式主管标记（0/1）。
 */
export interface AgentSquadMemberRow {
  id: string
  squad_id: string
  agent_id: string
  role: string | null
  persona_override: string | null
  pipeline_order: number | null
  depends_on: string | null // JSON 数组：上游成员 agent_id 列表（流水线 DAG 依赖）
  /** S2 §4.2 角色工具面（JSON：{mode, nativeTools, mcpTools, skillIds}，能力层裁剪） */
  tool_profile_json: string | null
  is_leader: number // SQLite 布尔：0 / 1
  created_at: number
}

/** 小分队群聊配置表（agent_squad_chat_config）行映射。
 * - max_rounds：发言轮次上限（默认 8）；
 * - summarizer_agent_id：汇总主笔（最终产物结论负责人，可空）；
 * - execute_actions：S3 批次2 §7.1 结论转执行（行动项自动转 Wave 续跑，0/1）。
 */
export interface AgentSquadChatConfigRow {
  squad_id: string
  max_rounds: number
  summarizer_agent_id: string | null
  execute_actions: number | null
}

/** 小分队协作运行表（agent_squad_session）行映射。
 * - squad_id：所属团队；mode：协作模式快照；status：运行状态（running/awaiting_plan/awaiting_checkpoint/awaiting_delivery/paused/done/cancelled/failed）；
 * - snapshot：运行态快照（JSON，可空）；
 * - board_json / contract_json / pack_json：S1/S2 增量列（黑板状态板 / Mission Contract / Delivery Pack）。
 */
export interface AgentSquadSessionRow {
  id: string
  squad_id: string
  title: string | null
  mode: string
  status: string
  snapshot: string | null
  board_json: string | null
  contract_json: string | null
  pack_json: string | null
  created_at: number
  updated_at: number
}

/** 小分队打断说话信箱表（agent_squad_inject，S2 §4.11）行映射。
 * - task_id：目标键（编排式任务 id / 流水线节点 id / 群聊成员 agent_id）；
 * - mode：soft | hard | pre_talk；status：queued → delivered | dropped。
 */
export interface AgentSquadInjectRow {
  id: string
  squad_id: string
  session_id: string
  task_id: string
  run_id: string | null
  source: string
  mode: string
  content: string
  status: string
  created_at: number
  delivered_at: number | null
}

/** 小分队协作轮次表（agent_squad_round）行映射（讨论黑板）。
 * - speaker_agent_id：发言者智能体（系统消息为 NULL）；role：发言者角色；
 * - content：正文；kind：类型（user/assistant/summary/system…）。
 */
export interface AgentSquadRoundRow {
  id: string
  squad_id: string
  session_id: string
  speaker_agent_id: string | null
  role: string | null
  content: string
  kind: string | null
  created_at: number
}

/** 小分队记忆表（agent_squad_memory）行映射。
 * 结构照搬 AgentMemoryRow，归属维度换 squad_id + 可选 agent_id
 * （agent_id 为 NULL = 团队共享记忆，非 NULL = 某成员个人记忆）。
 */
export interface AgentSquadMemoryRow {
  id: string
  squad_id: string
  agent_id: string | null
  session_id: string | null
  key: string
  content: string
  category: string
  ref_count: number // SQLite 整型
  anchored: number // SQLite 布尔：0 / 1
  last_recalled: number | null
  created_at: number
  updated_at: number
}

/** 技能能力单元表（skill_info）行映射。
 * - identifier：唯一标识 slug（同时是磁盘目录名）；
 * - tags：标签数组序列化后的 JSON 字符串；
 * - instruction：指令内容（与 SKILL.md 是不同字段）；
 * - skill_markdown：SKILL.md 正文（落盘到 <identifier>/SKILL.md）；
 * - scenario：技能分类 key（对应 SkillCategory）；
 * - status：启用状态 1 / 0；
 * - path：本地存储目录（默认 app_config.skill_path + '/' + identifier，可能含 $APPDATA/$RESOURCE 占位）；
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface SkillInfoRow {
  id: string
  identifier: string
  name: string | null
  description: string | null
  instruction: string | null
  skill_markdown: string | null
  tags: string | null // JSON 数组文本
  scenario: string | null // 对应 SkillCategory
  status: number // 1 启用 / 0 禁用
  path: string | null
  created_at: number
  updated_at: number
}

/** MCP 服务接入表（mcp_info）行映射。
 * - id：本地 UUID（文本主键）；
 * - protocol_type：STDIO / SSE / HTTP；
 * - auth_type：NONE / API_KEY / OAUTH2；
 * - status：0 未测试 / 1 正常 / 2 异常（INTEGER）；
 * - is_active：启用开关（INTEGER 0/1）；
 * - headers / auth_config / capabilities / properties：JSON 对象序列化文本；
 * - scenario：使用场景 key（对应 McpScenario）；
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface McpInfoRow {
  id: string
  alias_name: string | null
  mcp_name: string | null
  protocol_type: string // 对应 McpProtocolType
  endpoint_url: string | null
  headers: string | null // JSON 对象文本
  auth_type: string // 对应 McpAuthType
  auth_config: string | null // JSON 对象文本
  is_active: number // SQLite 布尔：0 / 1
  status: number // 0 / 1 / 2
  capabilities: string | null // JSON 数组文本
  properties: string | null // JSON 对象文本
  description: string | null
  scenario: string | null // 对应 McpScenario
  timeout_sec: number // 请求超时（秒），默认 120
  created_at: number
  updated_at: number
}

/** 智能体会话表（agent_conversation_session）行映射。 */
export interface AgentConversationSessionRow {
  id: string
  session_name: string | null
  agent_code: string
  start_time: number | null
  end_time: number | null
  status: string
  error_message: string | null
  is_collection: number
  is_top: number
  is_archive: number
  from_site: string
  summary: string | null
  project_id: string | null
  total_prompt_tokens: number
  total_completion_tokens: number
  tools_tokens: number
  summary_round_count: number
  total_turns: number
  created_at: number
  updated_at: number
}

/** 工程档案表（agent_project）行映射。 */
export interface AgentProjectRow {
  id: string
  name: string
  root_path: string
  description: string | null
  icon: string | null
  is_pinned: number
  is_archived: number
  custom_rules: string | null
  last_active_at: number
  created_at: number
  updated_at: number
}

/** 智能体对话轮次表（agent_conversation_round）行映射。 */
export interface AgentConversationRoundRow {
  id: string
  session_id: string
  llm_code: string | null
  round_index: number
  user_question: string | null
  thinking_content: string | null
  assistant_answer: string | null
  tool_calls_summary: string | null
  plan_steps: string | null
  input_tokens: number | null
  output_tokens: number | null
  start_time: number | null
  end_time: number | null
  created_at: number
  updated_at: number
  /** 原始消息序列（含多模态图片 dataUrl），历史回显附件卡片用。 */
  raw_messages_json: string | null
  /** 交错时间线 JSON（v26，ChatSegment[]）：旁白/工具/正文按真实时序；NULL=旧 round 回退旧渲染。 */
  segments_json: string | null
}

/** MCP 工具定义表（mcp_tool_definition）行映射。
 * - id：本地 UUID（文本主键）；
 * - mcp_id：外键，引用 mcp_info.id；
 * - input_schema / output_schema / test_params：JSON 对象序列化文本；
 * - is_active：启用开关（INTEGER 0/1）；
 * - timeout：延时毫秒（INTEGER 默认 0）；
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface McpToolDefinitionRow {
  id: string
  mcp_id: string
  tool_code: string | null
  display_name: string | null
  description: string | null
  input_schema: string | null // JSON 对象文本
  output_schema: string | null // JSON 对象文本
  endpoint: string | null
  method_type: string | null
  is_active: number // SQLite 布尔：0 / 1
  timeout: number
  test_params: string | null // JSON 对象文本
  created_at: number
  updated_at: number
}

/** 记忆宫殿主表（agent_memories）行映射（§3.3 记忆宫殿）。
 * - id：本地 UUID（文本主键）；
 * - agent_id：关联智能体（可空，空代表全局共享记忆）；
 * - session_id：触发锚定的会话（可空）；
 * - key：短标题 / 关键词（同一 agent_id 下唯一锚定键，重复锚定则更新内容）；
 * - content：记忆正文；
 * - category：分类（decision / code_pattern / user_pref / architecture / fix / other）；
 * - ref_count：引用次数（召回埋点累计）；
 * - anchored：是否显式锚定（1 刻意沉淀，0 自动沉淀）；
 * - last_recalled：最近一次召回时间（epoch 毫秒，可空）；
 * - created_at / updated_at：epoch 毫秒。
 */
export interface AgentMemoryRow {
  id: string
  agent_id: string | null
  session_id: string | null
  key: string
  content: string
  category: string
  ref_count: number
  anchored: number // SQLite 布尔：0 / 1
  last_recalled: number | null
  created_at: number
  updated_at: number
}

/** 记忆事件日志表（agent_memory_events）行映射。
 * - id：自增主键；
 * - memory_id：外键，引用 agent_memories.id（级联删除）；
 * - event_type：'recall' | 'anchor' | 'compact'；
 * - created_at：epoch 毫秒；按日聚合驱动热力图。
 */
export interface AgentMemoryEventRow {
  id: number
  memory_id: string
  event_type: string
  created_at: number
}

/** 自定义脚本插件主表（user_plugin_tool）行映射。
 * - identifier：工具唯一 slug（不含 custom__ 前缀），UNIQUE 约束兜底命名空间；
 * - runtime：'python' | 'bun'；
 * - script_content：用户核心代码（仅 run + 头注释，不含 Runner 壳）；
 * - parameters_schema：OpenAI function 可用的 JSON Schema 字符串（{"type":"object",...}）；
 * - dependencies：声明式依赖 JSON 数组文本（如 '["requests"]'），可空；
 * - sample_params：试跑示例参数 JSON 对象文本，可空；
 * - enabled：启用开关（INTEGER 0/1，默认 1）；
 * - timeout_sec：单次执行超时（秒，默认 60，上限 300）；
 * - scenario：场景分类 key（与 MCP/Skill 对齐），可空；
 * - last_run_at / last_run_status：列表态冗余（0 未知 / 1 成功 / 2 失败），由试跑与 Agent 执行回写；
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface UserPluginToolRow {
  id: string
  name: string
  identifier: string
  description: string
  runtime: string // 'python' | 'bun'
  script_content: string
  parameters_schema: string // JSON Schema 文本
  dependencies: string | null // JSON 数组文本，可空
  sample_params: string | null // JSON 对象文本，可空
  enabled: number // SQLite 布尔：0 / 1
  timeout_sec: number // 执行超时（秒），默认 60
  scenario: string | null
  last_run_at: number | null
  last_run_status: number | null // 0 未知 / 1 成功 / 2 失败
  created_at: number
  updated_at: number
}

/** 智能体 × 本地插件关联表（agent_plugin_ref）行映射。
 * - plugin_id：外键，引用 user_plugin_tool.id；
 * - is_active：绑定级启停（INTEGER 0/1，默认 1）。
 */
export interface AgentPluginRefRow {
  id: string
  agent_id: string
  plugin_id: string
  is_active: number // SQLite 布尔：0 / 1
  created_at: number
  updated_at: number
}

/** 插件执行日志表（plugin_run_log）行映射。
 * - source：'test' | 'agent'；
 * - params：入参 JSON 文本（注意脱敏策略），可空；
 * - ok：0/1；exit_code / duration_ms / stdout / stderr / error_type / missing_package：可空；
 * - created_at：epoch 毫秒。
 */
export interface PluginRunLogRow {
  id: string
  plugin_id: string
  agent_id: string | null
  session_id: string | null
  source: string // 'test' | 'agent'
  params: string | null
  ok: number // SQLite 布尔：0 / 1
  exit_code: number | null
  duration_ms: number | null
  stdout: string | null
  stderr: string | null
  error_type: string | null
  missing_package: string | null
  created_at: number
}

/** 服务器托管主表（server_host）行映射。字段语义见 .workspace/.design/server-hosting-design.md §4.1。 */
export interface ServerHostRow {
  id: string
  name: string
  host: string
  port: number
  user: string
  auth_type: string
  credential_id: string | null
  path_allow: string | null
  path_deny: string | null
  local_path_allow: string | null
  default_cwd: string | null
  login_note: string | null
  sudo_mode: string
  sudo_user: string
  host_auto_mode: string
  allow_grant_memory: number
  l3_policy: string
  grant_bind_as_user: number
  tags: string | null
  note: string | null
  last_used_at: number | null
  created_at: number
  updated_at: number
}
