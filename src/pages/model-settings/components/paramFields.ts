/**
 * 各分类模型的「参数表单字段描述」。
 * ModelFormModal 据此动态渲染分类专属参数区，新增分类时只需在此补充，
 * 无需改动弹窗组件本身。
 */
export type ParamControl =
  | 'number'
  | 'slider'
  | 'switch'
  | 'select'
  | 'checkbox' // 多选（数组值）
  | 'text'
  | 'textarea'

export interface ParamFieldDef {
  /** 对应 ModelConfig[category] 上的字段名 */
  key: string
  label: string
  hint?: string
  control: ParamControl
  min?: number
  max?: number
  step?: number
  options?: ReadonlyArray<{ label: string; value: string }>
}

const YES_NO = [
  { label: '自动', value: 'auto' },
  { label: '低', value: 'low' },
  { label: '高', value: 'high' },
] as const

const STT_FORMATS = [
  { label: 'json', value: 'json' },
  { label: 'text', value: 'text' },
  { label: 'srt', value: 'srt' },
  { label: 'verbose_json', value: 'verbose_json' },
  { label: 'vtt', value: 'vtt' },
  { label: 'diarized_json', value: 'diarized_json' },
] as const

const TTS_FORMATS = [
  { label: 'mp3', value: 'mp3' },
  { label: 'opus', value: 'opus' },
  { label: 'aac', value: 'aac' },
  { label: 'flac', value: 'flac' },
  { label: 'wav', value: 'wav' },
  { label: 'pcm', value: 'pcm' },
] as const

const TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
].map((v) => ({ label: v, value: v }))

const MODALITY_OPTIONS = [
  { label: '图片', value: 'image' },
  { label: '视频', value: 'video' },
  { label: '音频', value: 'audio' },
] as const

const LANG_OPTIONS = [
  { label: '自动检测', value: 'auto' },
  { label: '中文', value: 'zh' },
  { label: '英文', value: 'en' },
  { label: '日文', value: 'ja' },
  { label: '韩文', value: 'ko' },
  { label: '法文', value: 'fr' },
  { label: '德文', value: 'de' },
  { label: '西班牙文', value: 'es' },
] as const

export function getParamFields(category: string): ParamFieldDef[] {
  switch (category) {
    case 'text':
      return [
        { key: 'temperature', label: '温度', hint: '0~2，越高越随机', control: 'slider', min: 0, max: 2, step: 0.01 },
        { key: 'topP', label: 'Top P', hint: '0~1，核采样', control: 'slider', min: 0, max: 1, step: 0.01 },
        { key: 'topK', label: 'Top K', control: 'number', min: 0, max: 200, step: 1 },
        { key: 'frequencyPenalty', label: '频率惩罚', hint: '-2~2', control: 'slider', min: -2, max: 2, step: 0.01 },
        { key: 'presencePenalty', label: '存在惩罚', hint: '-2~2', control: 'slider', min: -2, max: 2, step: 0.01 },
        { key: 'contextLength', label: '上下文大小', hint: '最大上下文 token 数', control: 'number', min: 1, step: 1 },
        { key: 'maxTokens', label: '最大输出', control: 'number', min: 1, step: 1 },
        { key: 'reasoning', label: '支持深度推理', hint: '启用推理模型思考模式', control: 'switch' },
        { key: 'stream', label: '流式输出', control: 'switch' },
        { key: 'stop', label: '停止序列', hint: '多个用逗号分隔', control: 'text' },
        { key: 'systemPrompt', label: '系统提示词', control: 'textarea' },
      ]
    case 'multimodal':
      return [
        { key: 'temperature', label: '温度', control: 'slider', min: 0, max: 2, step: 0.01 },
        { key: 'topP', label: 'Top P', control: 'slider', min: 0, max: 1, step: 0.01 },
        { key: 'maxTokens', label: '最大输出', control: 'number', min: 1, step: 1 },
        { key: 'contextLength', label: '上下文大小', control: 'number', min: 1, step: 1 },
        { key: 'reasoning', label: '支持深度推理', control: 'switch' },
        { key: 'visionDetail', label: '视觉细节', control: 'select', options: YES_NO },
        { key: 'supportedInputs', label: '支持的输入模态', control: 'checkbox', options: MODALITY_OPTIONS },
        { key: 'maxImages', label: '单次最大图片数', control: 'number', min: 1, step: 1 },
        { key: 'stream', label: '流式输出', control: 'switch' },
      ]
    case 'stt':
      return [
        { key: 'language', label: '识别语言', hint: 'ISO-639-1，auto 自动检测', control: 'select', options: LANG_OPTIONS },
        { key: 'prompt', label: '引导词', hint: '提升专有名词 / 格式识别', control: 'textarea' },
        { key: 'responseFormat', label: '返回格式', control: 'select', options: STT_FORMATS },
        { key: 'temperature', label: 'Temperature', hint: '0~1', control: 'slider', min: 0, max: 1, step: 0.01 },
        { key: 'timestampGranularities', label: '时间戳粒度', hint: 'verbose_json 时有效', control: 'select', options: [
          { label: '无', value: 'none' },
          { label: '段落', value: 'segment' },
          { label: '词级', value: 'word' },
        ] },
        { key: 'translate', label: '转写为英文', control: 'switch' },
        { key: 'diarize', label: '说话人分离', control: 'switch' },
        { key: 'stream', label: '流式识别', control: 'switch' },
      ]
    case 'tts':
      return [
        { key: 'voice', label: '音色', control: 'select', options: TTS_VOICES },
        { key: 'speed', label: '语速', hint: '0.25~4，默认 1', control: 'slider', min: 0.25, max: 4, step: 0.05 },
        { key: 'responseFormat', label: '音频格式', control: 'select', options: TTS_FORMATS },
        { key: 'instructions', label: '风格指令', hint: '部分模型支持（如 gpt-4o-mini-tts）', control: 'textarea' },
        { key: 'stream', label: '流式合成', control: 'switch' },
      ]
    case 'embedding':
      return [
        { key: 'dimensions', label: '向量维度', hint: 'v3 模型可调，如 256/1024/1536', control: 'number', min: 1, step: 1 },
        { key: 'encodingFormat', label: '编码格式', control: 'select', options: [
          { label: 'float', value: 'float' },
          { label: 'base64', value: 'base64' },
        ] },
        { key: 'normalize', label: '归一化', control: 'switch' },
        { key: 'maxInputTokens', label: '单条最大输入 Token', control: 'number', min: 1, step: 1 },
      ]
    case 'rerank':
      return [
        { key: 'topN', label: '返回数量', hint: '返回相关性最高的 N 条', control: 'number', min: 1, step: 1 },
        { key: 'returnDocuments', label: '结果携带原文', control: 'switch' },
        { key: 'maxTokensPerDoc', label: '单文档截断 Token', control: 'number', min: 1, step: 1 },
        { key: 'scoreThreshold', label: '分数阈值', hint: '低于该相关性分数(0~1)的结果丢弃', control: 'slider', min: 0, max: 1, step: 0.01 },
      ]
    default:
      // 自定义分类（DB 字典中存在但无预置参数）：返回空，由表单提示用户手动补充
      return []
  }
}
