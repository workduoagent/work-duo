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

/** 知识库表（knowledge_bases）行映射（预留，尚未接入 mapper）。 */
export interface KnowledgeBaseRow {
  id: string
  name: string
  description: string | null
  doc_count: number
  created_at: number
  updated_at: number
}

/** 智能体表（agents）行映射（预留，尚未接入 mapper）。
 * model_id 为外键，引用 models.id。
 */
export interface AgentRow {
  id: string
  name: string
  role: string
  model_id: string | null
  system_prompt: string | null
  created_at: number
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
