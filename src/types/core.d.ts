/**
 * 全局公共类型 / 枚举（跨页面共享）。
 *
 * 约定：
 *  - 本文件只承载「类型」(type / interface / 字符串字面量联合)，
 *    编译期消费，不产生运行时代码。
 *  - 运行期需要的「枚举值 / 选项列表 / 文案」放在
 *    src/core/file/model-file.ts（例如 MODEL_CATEGORY_OPTIONS）。
 */

import type { PixelAgentAppearance } from '@/components/ui/pixel-agent'

/**
 * 模型接入能力分类（一级菜单「LLM」下的六大类）。
 *  - text       文本模型：对话 / 补全
 *  - multimodal 多模态模型：图文 / 音视频理解
 *  - stt        语音转文字（ASR / 语音识别）
 *  - tts        文字转语音（TTS / 语音合成）
 *  - embedding  向量模型（文本向量化，用于检索 / RAG）
 *  - rerank     重排序（对检索结果按相关度重排）
 */
export type ModelCategory =
  | 'text'
  | 'multimodal'
  | 'image'
  | 'stt'
  | 'tts'
  | 'embedding'
  | 'rerank'

/**
 * 常用服务商标识。自由文本字段，可随生态扩展；
 * 'custom' 表示自建服务或兼容 OpenAI 协议的中转网关。
 */
export type ModelProvider =
    | 'openai'
    | 'azure'
    | 'anthropic'
    | 'google'
    | 'meta'
    | 'microsoft'
    | 'amazon'
    | 'grok'
    | 'deepseek'
    | 'zhipu'
    | 'moonshot'
    | 'minimax'
    | 'baichuan'
    | 'qwen'          // 通义千问（阿里）
    | 'baidu'
    | 'tencent'
    | 'bytedance'     // 豆包
    | 'iflytek'       // 讯飞星火
    | 'ollama'
    | 'custom';

/**
 * 技能分类（对应 skill_info.scenario 字段）。
 * 用户在「新建/编辑」表单中从下拉选择，写入 scenario（存 key）。
 * 文案与用户给出的枚举保持一致。
 */
export type SkillCategory =
  | 'pay-skill'
  | 'office-efficiency'
  | 'content-creation'
  | 'dev-programming'
  | 'data-analysis'
  | 'design-media'
  | 'ai-agent'
  | 'knowledge-management'
  | 'business-ops'
  | 'education'
  | 'professional'
  | 'it-ops-security'
  | 'life-service'

/**
 * MCP 服务协议类型（对应 mcp_info.protocol_type 字段）。
 *  - STDIO：本地子进程（命令行启动，需本地运行时，网页端无法做连通性测试）；
 *  - SSE：Server-Sent Events 传输（POST 消息到 endpoint）；
 *  - HTTP：Streamable HTTP（JSON-RPC over HTTP）。
 */
export type McpProtocolType = 'STDIO' | 'SSE' | 'HTTP'

/**
 * MCP 服务认证类型（对应 mcp_info.auth_type 字段）。
 *  - NONE：无认证；
 *  - API_KEY：API Key（通常在 headers 中携带）；
 *  - OAUTH2：OAuth2 授权。
 */
export type McpAuthType = 'NONE' | 'API_KEY' | 'OAUTH2'

/**
 * MCP 服务连通状态（对应 mcp_info.status 字段，INTEGER）。
 *  - 0：未测试（初始 / 编辑后待测试）；
 *  - 1：正常（最近一次连通性测试通过）；
 *  - 2：异常（最近一次连通性测试失败）。
 */
export type McpStatus = 0 | 1 | 2

/**
 * MCP 使用场景（对应 mcp_info.scenario 字段）。
 * 用户在「接入服务」表单中从下拉选择，写入 scenario（存 key）。
 * 先写入常用场景，后续可继续扩充。
 */
export type McpScenario =
  | 'file-system'
  | 'web-search'
  | 'database'
  | 'dev-tools'
  | 'communication'
  | 'productivity'

/**
 * 场景分类字典的「域」标识（对应 scenario_category.scope）。
 *  - MCP：MCP 使用场景（原 mcp_info.scenario）；
 *  - SKILL：技能分类（原 skill_info.scenario）；
 *  - KB：知识库分类（对应 knowledge_base.scenario，用户设计明确要求 KB 接入场景字典）；
 *  - AGENT：智能体应用场景（对应 agent_info.scenario）。
 *  注：LLM 模型分类不纳入本字典——模型大类直接驱动 paramFields 动态表单，须与代码参数结构严格对应。
 */
export type ScenarioScope = 'MCP' | 'SKILL' | 'KB' | 'AGENT' | 'PLUGIN'

/**
 * 场景分类字典行（对应 scenario_category 表）。
 *  - scope + value 唯一确定一个枚举项（业务表存 value）；
 *  - label 为可编辑显示名；createdAt / updatedAt 为 epoch 毫秒。
 */
export interface ScenarioCategory {
  id: string
  scope: ScenarioScope
  value: string
  label: string
  createdAt: number
  updatedAt: number
}

/**
 * 知识库资产大类（对应 knowledge_asset.type，INTEGER）。
 *  - 1：文档（md/doc/docx/pdf/txt/xls/xlsx/csv/ppt/pptx/epub/json/代码 等）
 *  - 2：图片（png/jpg/gif/webp/svg/bmp/ico/avif）
 *  - 3：音频（mp3/wav/ogg/flac/aac/m4a）
 *  - 4：视频（mp4/webm/ogv/mov/mkv/avi）
 *  - 5：网页（html/htm/xhtml/url）
 */
export type KnowledgeAssetType = 1 | 2 | 3 | 4 | 5

/**
 * 知识库（对应 knowledge_base 表）。
 * - identifier：唯一标识 slug（同时是磁盘目录名），创建后作为物理路径一部分；
 * - logo：Logo 路径 / data URL（可空）；
 * - scenario：场景分类 key（对应 scenario_category scope='KB'，可空）；
 * - fileCount / fileSize：由 knowledge_asset 聚合得到的文件数 / 总字节数（列表展示用，单条查询时为 undefined）；
 * - createdAt / updatedAt：ISO 字符串。
 */
export interface KnowledgeBase {
  id: string
  logo?: string
  identifier: string
  name: string
  description?: string
  scenario?: string
  createdAt: string
  updatedAt: string
  /** 物理目录（运行时派生：knowledge_base_path + '/' + identifier，不落库） */
  path?: string
  /** 资产文件数（列表聚合，详情页按需刷新） */
  fileCount?: number
  /** 资产总字节数（列表聚合） */
  fileSize?: number
}

/**
 * 知识库资产（对应 knowledge_asset 表），即知识库目录下的单个文件。
 * - filePath：相对知识库根目录的路径（如 'docs/a.txt'，用于定位与分发渲染）；
 * - fileExt：扩展名（不含点、小写）；type：资产大类（KnowledgeAssetType）。
 */
export interface KnowledgeAsset {
  id: string
  kbId: string
  name: string
  type: KnowledgeAssetType
  fileExt?: string
  fileSize: number
  filePath: string
  /** 文件内容 hash（Rust 侧增量索引判据，NULL=未索引；v28 K1'） */
  digest?: string | null
  /** 最近成功索引时间 epoch 毫秒（NULL=待索引/不支持格式） */
  indexedAt?: number | null
  /** 资产级 JSON 字符串（标签云 tags 等业务元数据） */
  metaData?: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 智能体（对应 agent_info 表）。
 * - identifier：唯一标识，系统随机生成（用户可自定义）；
 * - logo：Base64 data URL 头像；为空时前端回退 lucide 图标（不落盘文件）；
 * - scenario：场景分类 key（对应 scenario_category scope='AGENT'，可空）；
 * - llmId / ttsId / sttId：绑定的模型 id（引用 models.id）；
 * - llmConfig / ttsConfig / sttConfig：模型参数的「智能体私有副本」
 *   （models.config 只作为初始默认值，向导里改的是这里）；
 * - isActive：启用开关；autoToolExecMode：外部资源自动执行模式；
 *   allowSandbox：是否允许该智能体使用沙箱环境。
 */
export interface AgentInfo {
  id: string
  logo?: string
  /** 拟人化像素形象配置（形象设计弹窗再编辑源；undefined=从未生成/仅历史上传） */
  appearance?: PixelAgentAppearance
  scenario?: string
  name: string
  identifier: string
  description?: string
  systemPrompt?: string
  welcomeMessage?: string
  llmId?: string
  llmConfig?: Record<string, unknown>
  ttsId?: string
  ttsConfig?: Record<string, unknown>
  sttId?: string
  sttConfig?: Record<string, unknown>
  isActive: boolean
  autoToolExecMode: boolean
  allowSandbox: boolean
  /** 记忆模式：off=关闭 / active=主动 / forced=强制每次任务末沉淀 */
  memoryMode: MemoryMode
  /** 计划审批策略：always=每次复合任务都走人工审批 / sensitive=仅含敏感操作的计划才审批（纯低风险任务自动放行）/ never=从不审批 */
  planAutoApproveMode: PlanApprovalMode
  createdAt: string
  updatedAt: string
}

/** 智能体记忆模式（对应 agent_info.memory_mode）。 */
export type MemoryMode = 'off' | 'active' | 'forced'

/** 计划审批策略模式（对应 agent_info.plan_auto_approve_mode，Phase 2b-3 allow 规则层）。 */
export type PlanApprovalMode = 'always' | 'sensitive' | 'never'

/**
 * 智能体绑定的 MCP 工具（对应 agent_mcp_ref 表）。
 * 关联的最小单元是工具（toolId → mcp_tool_definition.id），
 * mcpId 仅用于按服务分组展示与级联清理。
 */
export interface AgentMcpToolRef {
  id: string
  agentId: string
  mcpId: string
  toolId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 智能体编排的技能（对应 agent_skill_ref 表）。 */
export interface AgentSkillRef {
  id: string
  agentId: string
  skillId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 智能体绑定的知识库（对应 agent_kb_ref 表，第四期 K2）。 */
export interface AgentKbRef {
  id: string
  agentId: string
  kbId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 智能体的工具计数（列表卡片展示用，不落库）。 */
export interface AgentRefCounts {
  /** 已绑定的 MCP 工具数 */
  mcpTools: number
  /** 已编排的技能数 */
  skills: number
}

/** 新建 / 编辑智能体的入参（向导一次性提交：主表 + 两张关联表）。 */
export interface AgentUpsertInput {
  /** 传入则为更新；为空为新建 */
  id?: string
  name: string
  identifier: string
  logo?: string
  /** 拟人化像素形象配置（形象设计弹窗再编辑源，JSON 序列化落 agent_info.appearance） */
  appearance?: PixelAgentAppearance
  scenario?: string
  description?: string
  systemPrompt?: string
  welcomeMessage?: string
  llmId?: string
  llmConfig?: Record<string, unknown>
  ttsId?: string
  ttsConfig?: Record<string, unknown>
  sttId?: string
  sttConfig?: Record<string, unknown>
  isActive?: boolean
  autoToolExecMode?: boolean
  /** 是否允许该智能体使用沙箱环境 */
  allowSandbox?: boolean
  /** 记忆模式：off=关闭 / active=主动 / forced=强制每次任务末沉淀 */
  memoryMode?: MemoryMode
  /** 计划审批策略：always=每次复合任务都走人工审批 / sensitive=仅敏感任务审批（纯低风险自动放行）/ never=从不审批 */
  planAutoApproveMode?: PlanApprovalMode
  /** 绑定的 MCP 工具（最小单元 = toolId；mcpId 为冗余分组信息） */
  mcpTools: Array<{ mcpId: string; toolId: string }>
  /** 编排的技能 id */
  skillIds: string[]
  /** 挂载的本地插件 id（P2 新增；写入 agent_plugin_ref） */
  pluginIds?: string[]
  /** 绑定的知识库 id（第四期 K2；写入 agent_kb_ref，决定 native__kb_search 检索范围） */
  kbIds?: string[]
  /** 绑定的服务器（agent_server_ref；第一个为 primary/默认 Host） */
  serverIds?: string[]
}

/**
 * 网络代理模式（对应 app_config.network_proxy.mode）。
 *  - direct：直连（不使用代理）；
 *  - system：跟随系统代理；
 *  - manual：手动配置（提供 http(s) / socks5 地址输入框）。
 */
export type ProxyMode = 'direct' | 'system' | 'manual'

/**
 * 智能体会话来源（对应 agent_conversation_session.from_site）。
 *  - DEBUG_CHAT：单个智能体调试/对话页；
 *  - AGENT_GROUP：多 Agent 协作会话（预留）。
 */
export type AgentConversationFromSite = 'DEBUG_CHAT' | 'AGENT_GROUP'

/**
 * 智能体会话状态（对应 agent_conversation_session.status）。
 */
export type AgentConversationStatus = 'RUNNING' | 'COMPLETED' | 'ERROR'

/**
 * 智能体会话（对应 agent_conversation_session 表）。
 * - id：本地 UUID（文本主键）；
 * - sessionName：会话名称，默认取首轮第一个问题；
 * - agentCode：智能体 identifier；
 * - status：RUNNING / COMPLETED / ERROR；
 * - fromSite：DEBUG_CHAT（当前页面）。
 */
export interface AgentConversationSession {
  id: string
  sessionName?: string
  agentCode: string
  startTime?: number
  endTime?: number
  status: AgentConversationStatus
  errorMessage?: string
  isCollection: boolean
  isTop: boolean
  isArchive: boolean
  fromSite: AgentConversationFromSite
  summary?: string
  /** 累计提示词（输入）token 数。 */
  totalPromptTokens?: number
  /** 累计对话（输出）token 数。 */
  totalCompletionTokens?: number
  /** 工具 / Skill 定义占用的上下文 token 数（理论固定，移除 Skill / 停用 MCP 时下调）。 */
  toolsTokens?: number
  /** 已被压缩摘要覆盖的轮次数（滑动窗口增量合并用）。 */
  summaryRoundCount?: number
  /** 会话累计轮次数（total_turns）。 */
  totalTurns?: number
  /** 绑定的工程 ID（NULL 代表通用日常任务 / 无项目模式）。 */
  projectId?: string
  createdAt: string
  updatedAt: string
}

/**
 * 工程档案（对应 agent_project 表）。
 * - id：工程 UUID（"proj_xxx"）；
 * - name：工程名（默认取目录名，可重命名）；
 * - rootPath：规范化物理绝对路径，唯一；同一目录不论盘符大小写/斜杠差异都归属同一工程；
 * - customRules：项目专属 System Prompt 注入规则，继承到该工程下新建的会话。
 */
export interface AgentProject {
  id: string
  name: string
  rootPath: string
  description?: string
  icon?: string
  isPinned: boolean
  isArchived: boolean
  customRules?: string
  lastActiveAt: number
  createdAt: number
  updatedAt: number
}

/**
 * 单条对话轮次（对应 agent_conversation_round 表）。
 * - roundIndex：会话内序号，从 0 开始；
 * - userQuestion：用户提问（可能含图片附件序列化 JSON）；
 * - assistantAnswer：AI 最终回答；
 * - thinkingContent：AI 思考过程文本；
 * - toolCallsSummary：工具调用汇总 JSON；
 * - inputTokens / outputTokens：消耗 token 数。
 */
export interface AgentConversationRound {
  id: string
  sessionId: string
  llmCode?: string
  roundIndex: number
  userQuestion?: string
  thinkingContent?: string
  assistantAnswer?: string
  toolCallsSummary?: Record<string, unknown>[]
  /** 规划步骤结构（标题/状态/产物摘要），与 toolCallsSummary 对称落库；历史回看时重建「步骤 → 工具」嵌套视图。 */
  planStepsSummary?: Record<string, unknown>[]
  /** 交错时间线（2026-09-18）：思考旁白/工具调用/正文按真实时序的 JSON（ChatSegment[]）；
   * 历史加载时据此重建穿插渲染。旧 round 无此列 = undefined，回退旧渲染。
   * K3-2：kb-sources 段带 hits（本次引用来源命中列表），JSON 往返原样保留。 */
  segments?: Array<{ kind: string; text?: string; callId?: string; hits?: unknown[] }>
  inputTokens?: number
  outputTokens?: number
  startTime?: number
  endTime?: number
  createdAt: string
  updatedAt: string
  /** 原始消息序列 JSON（含多模态图片 dataUrl），历史回显附件卡片用。 */
  rawMessagesJson?: string
}

/** 用户消息中的附件（图片等）。前端以 base64 data URL 形式携带。 */
export interface ChatAttachment {
  type: 'image'
  dataUrl: string
  name?: string
}

/** 创建 / 追加轮次时需要的输入项。 */
export interface AppendRoundInput {
  sessionId: string
  llmCode?: string
  roundIndex: number
  userQuestion?: string
  startTime?: number
}

/* ============================ 小分队（Squad）协作 ============================ */

/** 协作模式：编排式 / 流水线 / 群聊。 */
export type SquadMode = 'orchestrator' | 'pipeline' | 'chat'

/** 运行策略执行方式。 */
export type SquadExecutionMode = 'manual' | 'schedule' | 'api'

/** 小分队运行策略（JSON 存于 agent_squad.run_strategy）。 */
export interface SquadRunStrategy {
  executionMode: SquadExecutionMode
  scheduleCron?: string | null
  retryCount: number
  /** 定时 / API 模式触发时使用的默认任务指令。 */
  schedulePrompt?: string | null
  /** S2：本次协作的 token 总预算（prompt+completion；0=不限）。 */
  budgetTokens?: number
}

/** 群聊专属配置（agent_squad_chat_config）。 */
export interface SquadChatConfig {
  maxRounds: number
  summarizerAgentId?: string | null
  /** S3 批次2（§7.1 chat_then_execute）：汇总行动项自动转 Wave 续跑。 */
  executeActions?: boolean
}

/** 小分队 API 触发服务配置（存于 app_config：squad_api_enabled / squad_api_port / squad_api_token）。 */
export interface SquadApiConfig {
  enabled: boolean
  port: number
  token: string
}

/** S2（§4.2）成员角色工具面（能力层裁剪，存 agent_squad_member.tool_profile_json）。 */
export interface SquadToolProfile {
  /** inherit=跟随智能体默认 / allowlist=仅允许列出工具 / denylist=禁用列出工具。 */
  mode: 'inherit' | 'allowlist' | 'denylist'
  /** 原生工具全名（native__read_file / native__write_file / ...）。 */
  nativeTools?: string[]
  /** MCP 工具全名（mcp__{server}__{tool}）。 */
  mcpTools?: string[]
  /** S3：工具族（write=全部写路径含沙箱代码执行 / execute / network / destructive）。 */
  families?: string[]
  /** Skill 过滤（本批仅落库透传，过滤归 S3）。 */
  skillIds?: string[]
}

/** 成员任职输入（新建 / 更新时提交）。 */
export interface SquadMemberInput {
  agentId: string
  role: string
  personaOverride?: string
  pipelineOrder?: number | null
  /** 流水线 DAG 依赖：上游成员 agentId 列表（空 = 按 pipelineOrder 线性串流）。 */
  dependsOn?: string[]
  isLeader: boolean
  /** S2：角色工具面（undefined=inherit 不裁剪）。 */
  toolProfile?: SquadToolProfile
}

/** 新建 / 更新小分队的入参。 */
export interface SquadUpsertInput {
  id?: string
  name: string
  logo?: string | null
  description?: string | null
  uniqueId?: string | null
  mode: SquadMode
  leaderAgentId?: string | null
  globalMcpIds?: string[]
  /** 全局 MCP 工具级开关：按 mcpId 记录被禁用的工具 id 列表（未列出的工具即启用）。 */
  globalMcpTools?: Record<string, string[]>
  supportsFileInput?: boolean | null
  workspaceDir?: string | null
  runStrategy: SquadRunStrategy
  members: SquadMemberInput[]
  chatConfig: SquadChatConfig
}

/** 已落库的小分队成员任职。 */
export interface SquadMember extends SquadMemberInput {
  id: string
  squadId: string
  createdAt: string
}

/** 小分队完整领域模型（列表 / 详情通用）。 */
export interface SquadInfo {
  id: string
  name: string
  logo?: string | null
  description?: string | null
  mode: SquadMode
  leaderAgentId?: string | null
  uniqueId?: string | null
  globalMcpIds: string[]
  /** 全局 MCP 工具级开关：按 mcpId 记录被禁用的工具 id 列表（未列出的工具即启用）。 */
  globalMcpTools?: Record<string, string[]>
  supportsFileInput?: boolean | null
  workspaceDir?: string | null
  runStrategy: SquadRunStrategy
  members: SquadMember[]
  chatConfig: SquadChatConfig
  createdAt: string
  updatedAt: string
}

/** 协作运行会话。 */
export interface SquadSession {
  id: string
  squadId: string
  title?: string | null
  mode: SquadMode
  status: string
  snapshot?: string | null
  /** S1：黑板 L2 状态板快照（任务状态机 + 产物索引 + 决策卡），JSON 串。 */
  boardJson?: string
  /** S2：Mission Contract 快照（任务分工/依赖/期望产物），JSON 串。 */
  contractJson?: string
  /** S2：Delivery Pack 证据包（合同 + 成员证据 + 产物索引 + 成本），JSON 串。 */
  packJson?: string
  createdAt: string
  updatedAt: string
}

/** 协作轮次（讨论黑板的一条发言 / 子任务交付 / 汇总）。 */
export type SquadRoundKind =
  | 'delegation'
  | 'subtask'
  | 'message'
  | 'summary'
  | 'system'
  | 'plan'
  | 'handoff'
  | 'metrics'
  | 'checkpoint'
  | 'delivery'
  | 'inject'

export interface SquadRound {
  id?: string
  squadId: string
  sessionId: string
  speakerAgentId?: string | null
  role: string
  kind: SquadRoundKind
  content: string
  createdAt?: string
}

/** 小分队记忆分类（与后端 MEMORY_CATEGORIES 对齐，并兼容 squad 默认 general）。 */
export type SquadMemoryCategory =
  | 'decision'
  | 'code_pattern'
  | 'user_pref'
  | 'architecture'
  | 'fix'
  | 'general'
  | 'other'

/** 小分队记忆（团队黑板的一条知识点，对应 agent_squad_memory 行）。 */
export interface SquadMemory {
  id: string
  squadId: string
  agentId?: string | null
  sessionId?: string | null
  key: string
  content: string
  category: SquadMemoryCategory
  refCount: number
  anchored: boolean
  lastRecalledAt?: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 服务器档案（server_host）领域模型（服务器托管，设计稿 .workspace/.design/server-hosting-design.md）。
 * 凭证只读出指纹 hint，任何接口不含明文。
 */
export interface ServerHost {
  id: string
  name: string
  host: string
  port: number
  /** SSH 登录用户（不必是 root） */
  user: string
  authType: 'password' | 'private_key' | 'private_key_passphrase'
  credentialId: string | null
  /** 凭证指纹（密码 ****xx / 密钥 MD5 前 8 位） */
  credentialHint: string | null
  /** 远端路径白名单；空 = 不限制（不推荐） */
  pathAllow: string[]
  /** 远端路径黑名单，优先于白名单 */
  pathDeny: string[]
  /** 本地侧路径白名单；空 = 绑定工作空间 */
  localPathAllow: string[]
  defaultCwd?: string
  loginNote?: string
  sudoMode: 'none' | 'sudo_cmd' | 'sudo_full'
  sudoUser: string
  hostAutoMode: 'strict' | 'balanced' | 'auto'
  allowGrantMemory: boolean
  l3Policy: 'reject' | 'single_shot'
  grantBindAsUser: boolean
  tags: string[]
  note?: string
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

/** 保存/测试连接入参（secret 明文仅写入瞬间经内存传入，永不回传）。 */
export interface ServerHostInput {
  id: string
  name: string
  host: string
  port?: number
  user: string
  authType?: ServerHost['authType']
  /** 为空 = 编辑时不改动已存凭证 */
  secret?: string
  /** private_key_passphrase 时的密钥口令 */
  keyPassphrase?: string
  pathAllow?: string[]
  pathDeny?: string[]
  localPathAllow?: string[]
  defaultCwd?: string
  loginNote?: string
  sudoMode?: ServerHost['sudoMode']
  sudoUser?: string
  hostAutoMode?: ServerHost['hostAutoMode']
  allowGrantMemory?: boolean
  l3Policy?: ServerHost['l3Policy']
  grantBindAsUser?: boolean
  tags?: string[]
  note?: string
  /** 重置 TOFU 主机键指纹（known_key_fingerprint 置 NULL）：服务器重装/换键经人工确认后使用 */
  resetKnownKey?: boolean
}

/** 测试连接报告。 */
export interface ServerTestReport {
  ok: boolean
  loginUser?: string
  osHint?: string
  home?: string
  latencyMs: number
  error?: string
}
