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
 * 网络代理模式（对应 app_config.network_proxy.mode）。
 *  - direct：直连（不使用代理）；
 *  - system：跟随系统代理；
 *  - manual：手动配置（提供 http(s) / socks5 地址输入框）。
 */
export type ProxyMode = 'direct' | 'system' | 'manual'
