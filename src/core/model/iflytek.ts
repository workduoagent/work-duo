/**
 * 科大讯飞（iflytek）TTS / STT 调用适配器。
 *
 * 讯飞的鉴权与 OpenAI 兼容服务不同：不是 Bearer，而是 **WebSocket（wss）动态签名 URL** ——
 * 用 HMAC-SHA256 对 "host / date / request-line" 签名，拼成 authorization 查询参数。
 * 算法与报文结构平移自 ai-explaner-server 的 TtsService / SttService（getAuthUrl / buildRequestJson）。
 *
 * 运行环境：浏览器 / Tauri WebView。依赖 Web Crypto（crypto.subtle，HMAC-SHA256）与 WebSocket，
 * 二者在 WebView 与原生浏览器中均可用，故本适配器纯前端实现、可走 typecheck、无需改 Rust。
 */
import type { ModelTestResult } from '@/utils/modelTest'

const DEFAULT_TTS_HOST = 'https://tts-api.xfyun.cn/v2/tts'
const DEFAULT_STT_HOST = 'https://iat-api.xfyun.cn/v2/iat'

/* ----------------------------- 基础工具 ----------------------------- */

/** 字节数组 → 标准 Base64（与讯飞服务端解码一致，不可用 URL-safe 变体） */
function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** 标准 Base64 字符串 → 字节数组 */
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** HMAC-SHA256（Web Crypto） */
async function hmacSha256(key: string, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data)))
}

/** 讯飞要求 GMT 时间，形如 "Thu, 03 Sep 2026 04:15:35 GMT" */
function rfc1123Date(): string {
  return new Date().toUTCString()
}

/**
 * 生成签名后的 wss 连接地址（平移 Java getAuthUrl）。
 * 关键点：base64 签名用标准 Base64，随后 encodeURIComponent 并 %20 替换，
 * 与 Java URLEncoder.encode(...).replace("+", "%20") 等价（base64 无空格，故等价）。
 */
export async function signXfyunUrl(
  hostUrl: string,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const url = new URL(hostUrl)
  const date = rfc1123Date()
  const preStr = `host: ${url.host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`
  const sha = await hmacSha256(apiSecret, preStr)
  const signature = b64(sha)
  const authorization = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authBase64 = b64(new TextEncoder().encode(authorization))
  // 讯飞对空格敏感：+ 必须编码为 %20
  const a = encodeURIComponent(authBase64).replace(/\+/g, '%20')
  const d = encodeURIComponent(date).replace(/\+/g, '%20')
  return `wss://${url.host}${url.pathname}?authorization=${a}&date=${d}&host=${url.host}`
}

/* ----------------------------- TTS ----------------------------- */

export interface IflytekTtsOptions {
  /** Host 地址（缺省用讯飞 TTS 默认）；表单里即 baseUrl */
  hostUrl?: string
  appId: string
  apiKey: string
  apiSecret: string
  text: string
  /** 音色 id，默认 x4_yezi */
  vcn?: string
}

/** 文字转语音：返回合成后的音频字节（lame/mp3）。 */
export async function iflytekTts(opts: IflytekTtsOptions): Promise<Uint8Array> {
  const host = opts.hostUrl?.trim() || DEFAULT_TTS_HOST
  const wsUrl = await signXfyunUrl(host, opts.apiKey, opts.apiSecret)
  const vcn = opts.vcn || 'x4_yezi'
  const base64Text = b64(new TextEncoder().encode(opts.text))
  const requestJson = JSON.stringify({
    common: { app_id: opts.appId },
    business: { aue: 'lame', sfl: 1, tte: 'UTF8', vcn, pitch: 50, speed: 50 },
    data: { status: 2, text: base64Text },
  })

  return new Promise<Uint8Array>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const chunks: Uint8Array[] = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('TTS 超时（60s）'))
    }, 60000)

    ws.onopen = () => ws.send(requestJson)
    ws.onmessage = (ev) => {
      try {
        const root = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        const code = root.code as number
        if (code !== 0) {
          clearTimeout(timer)
          ws.close()
          reject(new Error(`TTS 合成失败，错误码 ${code}：${root.message}`))
          return
        }
        const dataNode = root.data
        if (dataNode && dataNode.audio) chunks.push(b64ToBytes(dataNode.audio))
        if (dataNode && dataNode.status === 2) {
          clearTimeout(timer)
          ws.close()
          resolve(concatBytes(chunks))
        }
      } catch (e) {
        clearTimeout(timer)
        ws.close()
        reject(e instanceof Error ? e : new Error('TTS 响应解析失败'))
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('TTS WebSocket 连接失败（请检查 Host / 凭证）'))
    }
  })
}

/* ----------------------------- STT ----------------------------- */

export interface IflytekSttOptions {
  /** Host 地址（缺省用讯飞 STT 默认）；表单里即 baseUrl */
  hostUrl?: string
  appId: string
  apiKey: string
  apiSecret: string
  /** 16kHz / 16bit / 单声道 PCM 字节 */
  pcm: Uint8Array
}

/** 讯飞官方动态纠错解码器（移植自 Java SttService.Decoder） */
class XfyunDecoder {
  private texts = new Map<number, { text: string; deleted: boolean }>()

  decode(resultNode: { sn?: number; pgs?: string; rg?: number[]; ws?: Array<{ cw?: Array<{ w?: string }> }> }): void {
    const sn = resultNode.sn ?? 0
    const pgs = resultNode.pgs ?? ''
    const rg = resultNode.rg
    if (pgs === 'rpl' && Array.isArray(rg) && rg.length === 2) {
      for (let i = rg[0]; i <= rg[1]; i++) {
        const t = this.texts.get(i)
        if (t) t.deleted = true
      }
    }
    const sb: string[] = []
    const wsArr = resultNode.ws
    if (Array.isArray(wsArr)) {
      for (const ws of wsArr) {
        const cw = ws.cw
        if (Array.isArray(cw) && cw.length > 0) sb.push(cw[0].w ?? '')
      }
    }
    this.texts.set(sn, { text: sb.join(''), deleted: false })
  }

  toString(): string {
    const keys = [...this.texts.keys()]
    if (keys.length === 0) return ''
    const max = Math.max(...keys)
    let out = ''
    for (let i = 1; i <= max; i++) {
      const t = this.texts.get(i)
      if (t && !t.deleted) out += t.text
    }
    return out
  }
}

function buildSttFrame(appId: string, chunk: Uint8Array, status: number): string {
  const frame: Record<string, unknown> = {
    data: {
      status,
      format: 'audio/L16;rate=16000',
      encoding: 'raw',
      audio: b64(chunk),
    },
  }
  if (status === 0) {
    frame.common = { app_id: appId }
    frame.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs' }
  }
  return JSON.stringify(frame)
}

/** 语音转文字：返回识别出的文本。 */
export async function iflytekStt(opts: IflytekSttOptions): Promise<string> {
  const host = opts.hostUrl?.trim() || DEFAULT_STT_HOST
  const wsUrl = await signXfyunUrl(host, opts.apiKey, opts.apiSecret)

  // 切成 1280 字节帧（讯飞要求）
  const frameSize = 1280
  const pcm = opts.pcm
  const frames: string[] = []
  let offset = 0
  while (offset < pcm.length) {
    const len = Math.min(frameSize, pcm.length - offset)
    const chunk = pcm.subarray(offset, offset + len)
    const status = offset + len >= pcm.length ? 2 : frames.length === 0 ? 0 : 1
    frames.push(buildSttFrame(opts.appId, chunk, status))
    offset += len
  }
  if (frames.length === 0) frames.push(buildSttFrame(opts.appId, new Uint8Array(0), 2))

  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const decoder = new XfyunDecoder()
    let i = 0
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('STT 超时（30s）'))
    }, 30000)

    function sendNext() {
      if (i >= frames.length) return
      const f = frames[i++]
      try {
        ws.send(f)
      } catch (e) {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error('STT 发送失败'))
        return
      }
      if (i < frames.length) setTimeout(sendNext, 10)
    }

    ws.onopen = () => sendNext()
    ws.onmessage = (ev) => {
      try {
        const root = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        const code = root.code as number
        if (code !== 0) {
          clearTimeout(timer)
          ws.close()
          reject(new Error(`STT 识别失败，错误码 ${code}：${root.message}`))
          return
        }
        const data = root.data
        if (data && data.result) decoder.decode(data.result)
        if (data && data.status === 2) {
          clearTimeout(timer)
          ws.close()
          resolve(decoder.toString())
        }
      } catch (e) {
        clearTimeout(timer)
        ws.close()
        reject(e instanceof Error ? e : new Error('STT 响应解析失败'))
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('STT WebSocket 连接失败（请检查 Host / 凭证）'))
    }
  })
}

/* ----------------------------- 连通性测试 ----------------------------- */

export interface IflytekTestInput {
  category: 'tts' | 'stt'
  hostUrl?: string
  appId: string
  apiKey: string
  apiSecret: string
}

/**
 * 讯飞连通性测试：建立签名 WebSocket 并发送最小合法请求，
 * 据首条响应判定：code 0 → 连通成功；code != 0 → 网络可达但鉴权/参数有误（warn）；
 * 连接失败 / 超时 → error。TTS 用极短文本，STT 用 1 帧静音 PCM。
 */
export async function testXfyun(input: IflytekTestInput): Promise<ModelTestResult> {
  if (!input.appId.trim() || !input.apiKey.trim() || !input.apiSecret.trim()) {
    return { ok: false, level: 'error', message: '讯飞凭证不完整（需 AppId + APIKey + APISecret）' }
  }
  const host =
    input.hostUrl?.trim() ||
    (input.category === 'tts' ? DEFAULT_TTS_HOST : DEFAULT_STT_HOST)
  const wsUrl = await signXfyunUrl(host, input.apiKey, input.apiSecret)
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)

  const requestJson =
    input.category === 'tts'
      ? JSON.stringify({
          common: { app_id: input.appId },
          business: { aue: 'lame', sfl: 1, tte: 'UTF8', vcn: 'x4_yezi', pitch: 50, speed: 50 },
          data: { status: 2, text: b64(new TextEncoder().encode('你好')) },
        })
      : // STT：1 帧静音 PCM（1280 字节 0）
        buildSttFrame(input.appId, new Uint8Array(1280), 2)

  return new Promise<ModelTestResult>((resolve) => {
    let settled = false
    const finish = (r: ModelTestResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* noop */
      }
      resolve(r)
    }
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => finish({ ok: false, level: 'error', message: '连接超时（15s）', elapsedMs: elapsed() }), 15000)

    ws.onopen = () => ws.send(requestJson)
    ws.onmessage = (ev) => {
      try {
        const root = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        const code = root.code as number
        if (code === 0) {
          finish({ ok: true, level: 'success', message: `讯飞${input.category === 'tts' ? 'TTS' : 'STT'}连通成功`, elapsedMs: elapsed() })
        } else {
          finish({ ok: false, level: 'warn', message: `网络可达，但讯飞返回错误（code ${code}：${root.message}）`, elapsedMs: elapsed() })
        }
      } catch {
        finish({ ok: false, level: 'error', message: '响应解析失败', elapsedMs: elapsed() })
      }
    }
    ws.onerror = () => finish({ ok: false, level: 'error', message: 'WebSocket 连接失败（请检查 Host / 凭证 / 网络）', elapsedMs: elapsed() })
  })
}
