/**
 * 模型连通性探测。
 *
 * 探测方式：直接使用用户填写的完整 URL（**不做任何路径拼接**，因为各家 OpenAI 兼容
 * 服务的 URL 形态不固定），仅按 URL 末尾关键字选择请求体与方法是 POST 还是 GET，发
 * 「真实可用的小请求」以验证「网络可达 + 鉴权正确 + 模型可用」：
 *  - 以 /embed 结尾（TEI 原生）→ POST { inputs:'hi' }；
 *  - 以 /embeddings 结尾（OpenAI 兼容）→ POST { model, input:'hi' }；
 *  - 以 /chat/completions 或 /completions 结尾 → POST 最小对话请求；
 *  - 以 /rerank 结尾（TEI 原生）→ POST { query, texts, raw_scores }；
 *  - 含 /audio /images /models /moderations → GET 可达性探测；
 *  - 其它 → 默认按对话端点 POST 最小对话请求。
 *
 * 状态码细分判定见 classify()。
 *
 * 跨域（CORS）处理：浏览器/WebView 原生 fetch 受同源策略约束，内网等未放开 CORS 的服务
 * 会被拦截而误报不可达。因此在 Tauri 环境下改为调用 @tauri-apps/plugin-http 提供的 fetch——
 * 它底层走 Rust 的 reqwest 发请求，不受浏览器 CORS 限制，可真正探测内网/私有部署模型。
 * （plugin-http 的依赖、注册与 http:default 权限已在 src-tauri 配好。）非 Tauri 的浏览器
 * 开发环境仍用原生 fetch 回退。
 */

import { isTauri } from '@/core/config'
import { invoke } from '@tauri-apps/api/core'
import { testXfyun } from '@/core/model/iflytek'
import type { ModelConfig } from '@/core/file/model-file'

export interface ModelTestResult {
  ok: boolean
  /** 三态：success=连通成功 / warn=网络可达但有提示（鉴权、路径、方法、请求体等） / error=不可达或服务端错误 */
  level: 'success' | 'warn' | 'error'
  message: string
  status?: number
  elapsedMs?: number
}

/**
 * 探测超时（毫秒）。Ollama 等本地模型在「冷加载」（首次拉起尚未驻留显存的模型）时，
 * 首包延迟可能远超普通云端 API；8s 过短会触发 AbortController 中断，plugin-http 把中断
 * 表现为 "Request canceled"。放宽到 30s 以容纳冷加载与首 token 延迟。
 */
const PROBE_TIMEOUT_MS = 30000

/** 直接使用用户填写的完整 URL，仅按末尾关键字选请求体与方法（不做路径拼接） */
function resolveProbe(
  url: string,
  modelName?: string,
  config?: Record<string, unknown>,
): {
  url: string
  method: 'POST' | 'GET'
  body?: string
} {
  const target = url.trim()
  const model = modelName?.trim() || 'gpt-4o'

  // TEI 原生向量端点 /embed（HuggingFace Text Embeddings Inference）：请求体 {inputs}
  if (/\/embed$/i.test(target)) {
    return { url: target, method: 'POST', body: JSON.stringify({ inputs: 'hi' }) }
  }
  // OpenAI 兼容向量端点 /embeddings：请求体 {model, input}
  if (/\/embeddings$/i.test(target)) {
    return { url: target, method: 'POST', body: JSON.stringify({ model, input: 'hi' }) }
  }
  // 对话端点：POST 最小对话请求
  if (/\/chat\/completions$|\/completions$/i.test(target)) {
    return { url: target, method: 'POST', body: chatBody(model, config) }
  }
  // TEI 原生重排序端点 /rerank：请求体 {query, texts, raw_scores}
  if (/\/rerank\b/i.test(target)) {
    return {
      url: target,
      method: 'POST',
      body: JSON.stringify({ query: 'hi', texts: ['hi'], raw_scores: false }),
    }
  }
  // 图片生成端点 /images/generations：POST 真实最小生成（1 张，size 取分类配置缺省）
  // —— 生成按张计费，测试即真实消耗一张；GET 对该端点恒 405，可达性探测无意义。
  if (/\/images\/generations$/i.test(target)) {
    const size = (typeof config?.size === 'string' && config.size) || '1024x1024'
    return {
      url: target,
      method: 'POST',
      body: JSON.stringify({ model, prompt: 'a single small red circle on white background', n: 1, size }),
    }
  }
  // 其它已知资源（audio / images / models / moderations 等）→ GET 可达性探测
  if (/\/(audio|images|models|moderations)\b/i.test(target)) {
    return { url: target, method: 'GET' }
  }
  // 其余：默认按对话端点 POST（用户填写的应是可直接调用的完整 URL）
  return { url: target, method: 'POST', body: chatBody(model, config) }
}

/**
 * 最小对话请求体——**连通性探测使用非流式最小请求，与 Java ChatTestClient#test 对齐**：
 *  - 基础体固定为 { model, messages, max_tokens }，不设 stream / stream_options，
 *    不携带 Accept: text/event-stream。
 *  - 目的仅是验证「网络可达 + 鉴权 + 模型可用」；流式 + stream_options 由智能体真实
 *    调用（call_llm_stream_once）承担，探针不应引入 SSE 相关歧义或触发服务端对
 *    stream_options 的不兼容（部分 Ollama 版本/网关对 stream_options 返回 502/400）。
 *  - 额外注入模型选中分类的参数对象（DB 的 config 列，camelCase 如 maxTokens/
 *    temperature），与智能体从 llm_config 注入一致，仅跳过基础体已固定的键
 *    （model/messages/stream/stream_options/max_tokens/maxTokens），reasoning 归一化同 runtime.rs。
 */
function chatBody(model: string, config?: Record<string, unknown>): string {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: '模型测试，请回复 OK' }],
    max_tokens: 10,
  }
  if (config) {
    for (const [k, v] of Object.entries(config)) {
      // 基础体已固定提供，配置里的同名键不覆盖；max_tokens/maxTokens 始终用探测的 10
      if (
        k === 'model' ||
        k === 'messages' ||
        k === 'stream' ||
        k === 'stream_options' ||
        k === 'max_tokens' ||
        k === 'maxTokens'
      )
        continue
      // reasoning 归一化：true → {}；false / 缺失 → 省略（对齐 runtime.rs）
      if (k === 'reasoning') {
        if (v === true) body['reasoning'] = {}
        else if (v !== false) body['reasoning'] = v
        continue
      }
      body[k] = v
    }
  }
  return JSON.stringify(body)
}

/** 构造请求头——连通性探测为非流式，仅 Content-Type + 可选鉴权（与 Java ChatTestClient 对齐） */
function buildHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
  return h
}

/**
 * 按状态码细分判定。
 * 关键语义：只要服务端「返回了任何 HTTP 状态码」，就证明请求真正到达了服务器——
 * 即「网络可达」（URL 正确、CORS 已放开或走 plugin-http）。因此对 4xx/5xx 不再笼统判为
 * 失败，而是标注为 warn（可达但有提示）/ error（不可达或服务端错误），避免把
 * "服务已响应" 误读成 "连不上"。
 */
/** 尝试从 OpenAI 标准错误响应体中提取 error.message（对齐 Java ChatTestClient 的错误解析） */
function parseOpenAIError(body?: string): string | undefined {
  if (!body) return undefined
  try {
    const json = JSON.parse(body) as { error?: { message?: string } }
    if (json?.error?.message) return json.error.message
  } catch {
    /* 非 JSON 体忽略 */
  }
  return undefined
}

function classify(code: number, elapsedMs: number, body?: string): ModelTestResult {
  // 从响应体抽取服务端真实报错，拼接到提示里（Java 侧同样会把 error.message 透出）
  const detail = parseOpenAIError(body)
  const withDetail = (msg: string) => (detail ? `${msg}（服务端：${detail}）` : msg)

  // 2xx：真正连通成功（模型可正常响应）
  if (code >= 200 && code < 300) {
    return { ok: true, level: 'success', message: `连通成功（HTTP ${code}）`, status: code, elapsedMs }
  }
  // 3xx：重定向，仍视为可达
  if (code >= 300 && code < 400) {
    return { ok: true, level: 'warn', message: withDetail(`网络可达（重定向 HTTP ${code}）`), status: code, elapsedMs }
  }
  // 401 / 403：网络通，但鉴权失败
  if (code === 401 || code === 403) {
    return { ok: false, level: 'warn', message: withDetail(`网络可达，但鉴权失败（HTTP ${code}），请检查 API Key`), status: code, elapsedMs }
  }
  // 404：接口路径不存在（URL 可能填错）
  if (code === 404) {
    return { ok: false, level: 'warn', message: withDetail(`网络可达，但接口路径不存在（HTTP 404），请检查 Base URL`), status: code, elapsedMs }
  }
  // 405：方法不被允许（探测方式与服务端要求不符，网络仍可达）
  if (code === 405) {
    return { ok: false, level: 'warn', message: withDetail(`网络可达，该接口仅支持 POST（HTTP 405）`), status: code, elapsedMs }
  }
  // 400 / 422：请求体格式不被服务端接受（服务已响应 ⇒ 网络可达、URL 正确；仅探测体的字段名不匹配）
  if (code === 400 || code === 422) {
    // 图片模型误配到对话端点：服务端会报 "requires the Images API" —— 这时 URL 恰恰是错的，给定向建议
    if (/images api|image model/i.test(detail ?? '')) {
      return { ok: false, level: 'warn', message: withDetail(`图片生成模型必须走 Images API：请把接口地址改为以 /images/generations 结尾（HTTP ${code}）`), status: code, elapsedMs }
    }
    return { ok: false, level: 'warn', message: withDetail(`网络可达，服务已响应（HTTP ${code}，探测请求体格式不被接受，URL 正确即可）`), status: code, elapsedMs }
  }
  // 429：触发限流（网络可达）
  if (code === 429) {
    return { ok: false, level: 'warn', message: withDetail(`网络可达，触发限流（HTTP 429），请稍后重试`), status: code, elapsedMs }
  }
  // 其它 4xx：客户端请求被服务端拒绝（网络通）
  if (code < 500) {
    return { ok: false, level: 'warn', message: withDetail(`网络可达，请求被拒绝（HTTP ${code}）`), status: code, elapsedMs }
  }
  // 5xx：服务端内部错误（网络可达但服务端异常）
  return { ok: false, level: 'error', message: withDetail(`服务错误（HTTP ${code}）`), status: code, elapsedMs }
}

/** 网络/超时错误归类（未拿到任何状态码 ⇒ 不可达） */
function handleErr(err: unknown, elapsedMs: number): ModelTestResult {
  const e = err as { name?: string; message?: string }
  if (e?.name === 'AbortError' || /timeout/i.test(e?.message ?? '')) {
    return { ok: false, level: 'error', message: `连接超时（${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒）`, elapsedMs }
  }
  const msg = e?.message ?? ''
  // 浏览器/WebView 跨域拦截会表现为 TypeError / Failed to fetch
  if (/TypeError|Failed to fetch|NetworkError|Cross-Origin|CORS|Not allowed/i.test(msg)) {
    return {
      ok: false,
      level: 'error',
      message: '连接失败（可能被跨域 CORS 拦截；内网请在 Tauri 环境下探测，已走 plugin-http 绕过）',
      elapsedMs,
    }
  }
  return { ok: false, level: 'error', message: `连接失败：${msg}`, elapsedMs }
}

/**
 * 发起探测：Tauri 环境统一走 Rust 命令 `http_probe`，由后端按 app_config.network_proxy
 * 三模式建客户端（direct 模式会 .no_proxy() 无视系统代理，开 VPN 也能直连 LAN / 本机模型，
 * 根治此前「开 VPN 被系统代理劫持 → 502」的问题）；浏览器 / WebView 原生 fetch 受同源策略约束，
 * 仅作为非 Tauri 开发期的回退。
 */
async function probe(
  url: string,
  method: 'POST' | 'GET',
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  // Tauri：后端已按 network_proxy 建客户端，且天然无 CORS 限制
  if (isTauri) {
    return invoke<{ status: number; body: string }>('http_probe', {
      url,
      method,
      headers,
      body: body ?? null,
    })
  }
  // 非 Tauri（浏览器开发）回退：受浏览器代理 / CORS 约束，仅开发期可用
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal })
    const text = await res.text().catch(() => '')
    return { status: res.status, body: text }
  } finally {
    clearTimeout(timer)
  }
}

export async function testModelConnection(
  model: ModelConfig,
): Promise<ModelTestResult> {
  const raw = model.baseUrl?.trim()
  if (!raw) return { ok: false, level: 'error', message: '缺少 Base URL' }

  // 讯飞（iflytek）TTS/STT：走签名 WebSocket 测试，不走通用 HTTP 探测
  if (model.provider === 'iflytek' && (model.category === 'tts' || model.category === 'stt')) {
    return testXfyun({
      category: model.category as 'tts' | 'stt',
      hostUrl: raw,
      appId: model.appId ?? '',
      apiKey: model.apiKey ?? '',
      apiSecret: model.apiSecret ?? '',
    })
  }

  // 取模型选中分类的参数对象（与 modelToRow 写入 config 列的内容一致），
  // 让探针请求与智能体 call_llm_stream_once 注入 llm_config 后的请求完全对齐。
  const params = (model as unknown as Record<string, unknown>)[model.category]
  const configObj =
    params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined

  const { url, method, body } = resolveProbe(raw, model.modelName, configObj)
  const headers = buildHeaders(model.apiKey)
  const start = performance.now()

  try {
    const { status, body: respBody } = await probe(url, method, headers, body)
    return classify(status, Math.round(performance.now() - start), respBody)
  } catch (err) {
    return handleErr(err, Math.round(performance.now() - start))
  }
}
