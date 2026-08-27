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
