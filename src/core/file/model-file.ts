/**
 * 模型接入配置 —— 领域类型 / 运行期选项 / 草稿工厂。
 *
 * 说明：本文件**不再承担持久化**。数据已迁移到 SQLite，由
 * `src/core/mapper/model-mapper.ts` 负责增删改查（@tauri-apps/plugin-sql）。
 * 这里只保留与 UI / 表单无关的纯领域定义，供页面、组件与 mapper 复用。
 */
import type { ModelProvider } from '@/types/core'

/* ------------------------------------------------------------------ *
 * 1. 分类参数结构（异构，按 category 选其一挂载到 ModelConfig）
 * ------------------------------------------------------------------ */

/** 文本 / 对话模型参数 */
export interface TextModelParams {
  temperature: number // 0~2，越高越随机
  topP: number // 0~1，核采样
  topK: number // 候选词截断数
  frequencyPenalty: number // -2~2，频率惩罚
  presencePenalty: number // -2~2，存在惩罚
  contextLength: number // 上下文窗口（token）
  maxTokens: number // 单次最大输出（token）
  reasoning: boolean // 是否启用深度推理（推理模型思考模式）
  stream: boolean // 流式输出
  stop: string // 停止序列，逗号分隔
  systemPrompt: string // 系统提示词
}

/** 多模态模型参数（在文本能力基础上增加视觉/输入相关项） */
export interface MultimodalModelParams {
  temperature: number
  topP: number
  maxTokens: number
  contextLength: number
  reasoning: boolean
  visionDetail: 'auto' | 'low' | 'high' // 视觉细节级别
  supportedInputs: Array<'image' | 'video' | 'audio'> // 支持的输入模态
  maxImages: number // 单次最大图片数
  stream: boolean
}

/** 语音转文字（ASR）参数 */
export interface SttModelParams {
  language: string // ISO-639-1，'auto' 表示自动检测
  prompt: string // 引导词，提升专有名词 / 格式识别
  responseFormat: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json'
  temperature: number // 0~1
  timestampGranularities: 'none' | 'segment' | 'word' // 时间戳粒度（verbose_json 时有效）
  translate: boolean // 转写为英文
  diarize: boolean // 说话人分离
  stream: boolean // 流式识别
}

/** 文字转语音（TTS）参数 */
export interface TtsModelParams {
  voice: string // 音色 id，如 alloy / coral，或自定义 id
  speed: number // 0.25~4，默认 1
  responseFormat: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
  instructions: string // 风格指令（gpt-4o-mini-tts 等支持）
  stream: boolean
}

/** 向量（Embedding）模型参数 */
export interface EmbeddingModelParams {
  dimensions: number // 输出向量维度（v3 系列模型可调）
  encodingFormat: 'float' | 'base64'
  normalize: boolean // 是否归一化
  maxInputTokens: number // 单条最大输入 token
}

/** 重排序（Rerank）模型参数 */
export interface RerankModelParams {
  topN: number // 返回 Top-N 结果
  returnDocuments: boolean // 结果是否携带原文
  maxTokensPerDoc: number // 单文档截断 token 数
  scoreThreshold: number // 相关性分数阈值（0~1），低于则丢弃
}

/* ------------------------------------------------------------------ *
 * 2. 统一模型配置结构（领域模型，运行时使用）
 * ------------------------------------------------------------------ */

export interface ModelConfig {
  id: string
  name: string // 展示名
  category: string // 模型大类（文本/多模态/语音转文字/...，驱动动态表单 paramFields）
  provider: ModelProvider
  baseUrl: string // API Base，如 https://api.openai.com/v1
  apiKey: string
  modelName: string // 服务商侧的模型标识
  enabled: boolean
  /** Tool/Function Calling 能力标记：默认 false（不支持），由用户接入时显式开启；对 Agent 集成至关重要 */
  toolCalls: boolean
  description?: string
  tags?: string[]
  // 按分类挂载的参数对象（仅挂载与 category 对应的一项）
  text?: TextModelParams
  multimodal?: MultimodalModelParams
  stt?: SttModelParams
  tts?: TtsModelParams
  embedding?: EmbeddingModelParams
  rerank?: RerankModelParams
  createdAt: string // ISO 时间字符串（与 SQLite 的 epoch 毫秒在 mapper 层互转）
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * 3. 运行期常量 / 选项（枚举值在此，而非 core.d.ts）
 * ------------------------------------------------------------------ */

const MODEL_CATEGORY_LABELS: Record<string, string> = {
  text: '文本模型',
  multimodal: '多模态模型',
  stt: '语音转文字',
  tts: '文字转语音',
  embedding: '向量模型',
  rerank: '重排序',
}

/** 模型大类展示名（兜底回退原 value）。分类固定、与代码参数结构严格对应，不进 scenario_category 字典。 */
export function getModelCategoryLabel(s?: string | null): string {
  if (!s) return '未分类'
  return MODEL_CATEGORY_LABELS[s] ?? s
}

/** 模型大类固定选项（用于分类导航 / 表单下拉）。
 *  注意：模型分类直接决定 paramFields 动态表单结构，必须与 model-file.ts 的参数接口、createEmptyModel 分支严格对应，
 *  因此作为代码内固定枚举，不交由 scenario_category 字典托管（避免改名/排序导致与表单脱节）。 */
export const MODEL_CATEGORY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.entries(
  MODEL_CATEGORY_LABELS,
).map(([value, label]) => ({ value, label }))

export const PROVIDER_OPTIONS: ReadonlyArray<{
  value: ModelProvider
  label: string
}> = [
  // ----- 国际主流 -----
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'meta', label: 'Meta (Llama)' },
  { value: 'microsoft', label: 'Microsoft (Copilot)' },
  { value: 'amazon', label: 'Amazon (Bedrock)' },
  { value: 'grok', label: 'xAI (Grok)' },

  // ----- 中国科技巨头 -----
  { value: 'qwen', label: '通义千问 (阿里)' },
  { value: 'baidu', label: '文心一言 (百度)' },
  { value: 'tencent', label: '混元 (腾讯)' },
  { value: 'bytedance', label: '豆包 (字节)' },
  { value: 'iflytek', label: '讯飞星火' },

  // ----- 中国AI新锐（“六小虎”等） -----
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'zhipu', label: '智谱 GLM' },
  { value: 'moonshot', label: 'Kimi (月之暗面)' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'baichuan', label: '百川智能' },

  // ----- 本地工具 / 自定义 -----
  { value: 'ollama', label: 'Ollama (本地运行)' },
  { value: 'custom', label: '自定义 / 兼容 OpenAI' },
];

/** 创建一个带默认参数的新模型草稿（用于"新增"） */
export function createEmptyModel(category: string): ModelConfig {
  const now = new Date().toISOString()
  const base: ModelConfig = {
    id: crypto.randomUUID(),
    name: '',
    category,
    provider: 'openai',
    baseUrl: '',
    apiKey: '',
    modelName: '',
    enabled: true,
    toolCalls: false,
    createdAt: now,
    updatedAt: now,
  }

  switch (category) {
    case 'text':
      return {
        ...base,
        text: {
          temperature: 0.7,
          topP: 1,
          topK: 40,
          frequencyPenalty: 0,
          presencePenalty: 0,
          contextLength: 128000,
          maxTokens: 4096,
          reasoning: false,
          stream: true,
          stop: '',
          systemPrompt: '',
        },
      }
    case 'multimodal':
      return {
        ...base,
        multimodal: {
          temperature: 0.7,
          topP: 1,
          maxTokens: 4096,
          contextLength: 128000,
          reasoning: false,
          visionDetail: 'auto',
          supportedInputs: ['image'],
          maxImages: 5,
          stream: true,
        },
      }
    case 'stt':
      return {
        ...base,
        stt: {
          language: 'auto',
          prompt: '',
          responseFormat: 'verbose_json',
          temperature: 0,
          timestampGranularities: 'none',
          translate: false,
          diarize: false,
          stream: false,
        },
      }
    case 'tts':
      return {
        ...base,
        tts: {
          voice: 'alloy',
          speed: 1,
          responseFormat: 'mp3',
          instructions: '',
          stream: false,
        },
      }
    case 'embedding':
      return {
        ...base,
        embedding: {
          dimensions: 1536,
          encodingFormat: 'float',
          normalize: false,
          maxInputTokens: 8192,
        },
      }
    case 'rerank':
      return {
        ...base,
        rerank: {
          topN: 5,
          returnDocuments: true,
          maxTokensPerDoc: 4096,
          scoreThreshold: 0,
        },
      }
    default:
      // 自定义分类：无预置参数结构，由表单自身控制（paramFields 返回空）
      return base
  }
}

/* ------------------------------------------------------------------ *
 * 4. 导入配置（JSON -> ModelConfig[]）
 * ------------------------------------------------------------------ */

export interface ModelImportResult {
  /** 校验通过、可入库的模型列表 */
  models: ModelConfig[]
  /** 校验失败的原因（逐项） */
  errors: string[]
  /** 总条目数（含非法项），用于「N 条中 M 条有效」提示 */
  total: number
}

/**
 * 解析导入的 JSON 文本，归一化为 ModelConfig[] 并做基础校验。
 * 兼容「单个对象」或「对象数组」两种格式；缺失字段用 createEmptyModel 默认值补齐；
 * 传入的分类专属参数（与 category 同键的对象）会覆盖默认值。
 */
export function parseModelImport(text: string): ModelImportResult {
  const errors: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { models: [], errors: [`JSON 解析失败：${(e as Error).message}`], total: 0 }
  }

  const arr = Array.isArray(data) ? data : [data]
  const models: ModelConfig[] = []

  arr.forEach((item, i) => {
    const idx = i + 1
    if (typeof item !== 'object' || item === null) {
      errors.push(`第 ${idx} 项不是对象，已跳过`)
      return
    }
    const obj = item as Record<string, unknown>
  const category = obj.category as string
  if (typeof category !== 'string' || !category) {
    errors.push(`第 ${idx} 项 category 缺失或非法`)
    return
  }

    const base = createEmptyModel(category)
    const merged: ModelConfig = {
      ...base,
      id: typeof obj.id === 'string' && obj.id ? obj.id : base.id,
      name: typeof obj.name === 'string' ? obj.name : base.name,
      provider: typeof obj.provider === 'string' ? (obj.provider as ModelProvider) : base.provider,
      baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : base.baseUrl,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : base.apiKey,
      modelName: typeof obj.modelName === 'string' ? obj.modelName : base.modelName,
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : base.enabled,
      toolCalls: typeof obj.toolCalls === 'boolean' ? obj.toolCalls : base.toolCalls,
      description: typeof obj.description === 'string' ? obj.description : base.description,
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : base.tags,
    }

    // 分类专属参数：传入了与 category 同键的对象则覆盖默认
    const param = obj[category]
    if (param && typeof param === 'object') {
      ;(merged as unknown as Record<string, unknown>)[category] = {
        ...((base as unknown as Record<string, unknown>)[category] as object),
        ...(param as object),
      }
    }
    models.push(merged)
  })

  return { models, errors, total: arr.length }
}
