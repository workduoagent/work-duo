// SQLite 表 -> TypeScript 行映射（SQL 实体）。
// 约定：所有 SQL 行实体集中在此文件定义；SQL 增删改查业务写在 src/core/mapper。
// DDL（建表语句）见 src/assets/sql/init.sql（首启）与 updater.sql（版本变更），二者需保持同步。

/** 模型接入配置表（models）行映射。
 * - 基础信息 + 启用状态；
 * - category 决定模型大类（text / multimimodal / stt / tts / embedding / rerank，对应 types/core 的 ModelCategory）；
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
  base_url: string | null // API Base，如 https://api.openai.com/v1
  api_key: string | null // 密钥（本地明文，安全方案后续统一处理）
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
 * - created_at / updated_at：epoch 毫秒（整型）。
 */
export interface AgentInfoRow {
  id: string
  logo: string | null
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

/** 小分队表（squads）行映射（预留，尚未接入 mapper）。
 * member_ids 为成员 id 数组的 JSON 文本。
 */
export interface SquadRow {
  id: string
  name: string
  description: string | null
  member_ids: string // JSON 数组存储为文本
  created_at: number
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
