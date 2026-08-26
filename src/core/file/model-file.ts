/**
 * 模型接入配置的数据层。
 *
 * 职责：
 *  - 定义 6 大类模型的参数结构与统一的 ModelConfig 数据结构；
 *  - 提供对 $APPDATA/models.json 的读写接口（基于 @tauri-apps/plugin-fs）；
 *  - 在非 Tauri 环境（vite dev / preview）自动回退到 localStorage，便于开发期调试。
 *
 * 该文件被 model-settings 页面及各"接入模型"相关页面复用。
 */
import { appDataDir, join } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { isTauri } from '@/core/config'
import type { ModelCategory, ModelProvider } from '@/types/core'

/* ------------------------------------------------------------------ *
 * 1. 分类参数结构
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
 * 2. 统一模型配置结构
 * ------------------------------------------------------------------ */

export interface ModelConfig {
  id: string
  name: string // 展示名
  category: ModelCategory
  provider: ModelProvider
  baseUrl: string // API Base，如 https://api.openai.com/v1
  apiKey: string
  modelName: string // 服务商侧的模型标识
  enabled: boolean
  description?: string
  tags?: string[]
  // 按分类挂载的参数对象（仅挂载与 category 对应的一项）
  text?: TextModelParams
  multimodal?: MultimodalModelParams
  stt?: SttModelParams
  tts?: TtsModelParams
  embedding?: EmbeddingModelParams
  rerank?: RerankModelParams
  createdAt: string
  updatedAt: string
}

/** models.json 文件结构 */
export interface ModelFile {
  version: number
  models: ModelConfig[]
}

/* ------------------------------------------------------------------ *
 * 3. 运行期常量 / 选项（枚举值在此，而非 core.d.ts）
 * ------------------------------------------------------------------ */

export const MODELS_FILE_NAME = 'models.json'
export const MODELS_FILE_VERSION = 1

export const MODEL_CATEGORY_OPTIONS: ReadonlyArray<{
  value: ModelCategory
  label: string
}> = [
  { value: 'text', label: '文本模型' },
  { value: 'multimodal', label: '多模态模型' },
  { value: 'stt', label: '语音转文字' },
  { value: 'tts', label: '文字转语音' },
  { value: 'embedding', label: '向量模型' },
  { value: 'rerank', label: '重排序' },
]

export const PROVIDER_OPTIONS: ReadonlyArray<{
  value: ModelProvider
  label: string
}> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'qwen', label: '通义千问' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'zhipu', label: '智谱 GLM' },
  { value: 'moonshot', label: 'Kimi' },
  { value: 'baichuan', label: '百川' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'custom', label: '自定义 / 兼容 OpenAI' },
]

/** 创建一个带默认参数的新模型草稿（用于"新增"） */
export function createEmptyModel(category: ModelCategory): ModelConfig {
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
  }
}

/* ------------------------------------------------------------------ *
 * 4. 持久化（Tauri fs，回退 localStorage）
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'work-duo:models'

async function readRaw(): Promise<string | null> {
  if (isTauri) {
    const filePath = await join(await appDataDir(), MODELS_FILE_NAME)
    if (!(await exists(filePath))) return null
    return readTextFile(filePath)
  }
  return localStorage.getItem(STORAGE_KEY)
}

async function writeRaw(content: string): Promise<void> {
  if (isTauri) {
    const dir = await appDataDir()
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(await join(dir, MODELS_FILE_NAME), content)
    return
  }
  localStorage.setItem(STORAGE_KEY, content)
}

function normalize(raw: string | null): ModelFile {
  if (!raw) return { version: MODELS_FILE_VERSION, models: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.models)) return parsed as ModelFile
    if (Array.isArray(parsed)) {
      return { version: MODELS_FILE_VERSION, models: parsed }
    }
  } catch {
    /* 损坏的 JSON：回退到空列表，避免整页崩溃 */
  }
  return { version: MODELS_FILE_VERSION, models: [] }
}

async function persist(models: ModelConfig[]): Promise<ModelConfig[]> {
  const file: ModelFile = { version: MODELS_FILE_VERSION, models }
  await writeRaw(JSON.stringify(file, null, 2))
  return models
}

/* ------------------------------------------------------------------ *
 * 5. 对外操作接口
 * ------------------------------------------------------------------ */

export async function readModelsFile(): Promise<ModelFile> {
  return normalize(await readRaw())
}

export async function listModels(): Promise<ModelConfig[]> {
  return (await readModelsFile()).models
}

export async function getModel(id: string): Promise<ModelConfig | undefined> {
  return (await readModelsFile()).models.find((m) => m.id === id)
}

/** 新增或更新（按 id 幂等）。返回最新列表。 */
export async function upsertModel(model: ModelConfig): Promise<ModelConfig[]> {
  const models = (await readModelsFile()).models
  const idx = models.findIndex((m) => m.id === model.id)
  const next: ModelConfig = { ...model, updatedAt: new Date().toISOString() }
  if (idx >= 0) models[idx] = next
  else models.push(next)
  return persist(models)
}

export async function deleteModel(id: string): Promise<ModelConfig[]> {
  const models = (await readModelsFile()).models.filter((m) => m.id !== id)
  return persist(models)
}

/** 仅切换启用状态。返回最新列表。 */
export async function setModelEnabled(
  id: string,
  enabled: boolean,
): Promise<ModelConfig[]> {
  const models = await readModelsFile()
  const idx = models.models.findIndex((m) => m.id === id)
  if (idx < 0) return models.models
  models.models[idx] = {
    ...models.models[idx],
    enabled,
    updatedAt: new Date().toISOString(),
  }
  return persist(models.models)
}
