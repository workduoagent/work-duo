/**
 * 全局公共类型 / 枚举（跨页面共享）。
 *
 * 约定：
 *  - 本文件只承载「类型」(type / interface / 字符串字面量联合)，
 *    编译期消费，不产生运行时代码。
 *  - 运行期需要的「枚举值 / 选项列表 / 文案」放在
 *    src/core/file/model-file.ts（例如 MODEL_CATEGORY_OPTIONS）。
 */

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
export type ScenarioScope = 'MCP' | 'SKILL' | 'KB' | 'AGENT'

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
  createdAt: string
  updatedAt: string
}

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
  /** 绑定的 MCP 工具（最小单元 = toolId；mcpId 为冗余分组信息） */
  mcpTools: Array<{ mcpId: string; toolId: string }>
  /** 编排的技能 id */
  skillIds: string[]
}

/**
 * 网络代理模式（对应 app_config.network_proxy.mode）。
 *  - direct：直连（不使用代理）；
 *  - system：跟随系统代理；
 *  - manual：手动配置（提供 http(s) / socks5 地址输入框）。
 */
export type ProxyMode = 'direct' | 'system' | 'manual'
