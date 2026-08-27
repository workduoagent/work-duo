/**
 * 模型连通性探测（纯前端，无 Rust 依赖）。
 *
 * 语义：对 baseUrl 发起一次 GET 探测，仅验证「网络是否可达」：
 *  - 返回 2xx / 3xx / 4xx → 服务端可达（4xx 多为鉴权缺失，仍说明网络通）；
 *  - 网络错误 / 超时（8s）→ 不可达。
 *
 * 注意：浏览器同源策略下，部分云厂商 API（如 OpenAI）会因 CORS 拦截导致探测失败，
 * 从而误报「不可达」。如需绕过 CORS 做完整鉴权校验，建议在 Tauri 侧用
 * @tauri-apps/plugin-http 实现 test_model 命令（前端经 core/ipc 调用），此处仅做可达性探测。
 */

export interface ModelTestInput {
  baseUrl: string
  apiKey?: string
  modelName?: string
  category?: string
}

export interface ModelTestResult {
  ok: boolean
  message: string
  status?: number
  elapsedMs?: number
}

export async function testModelConnection(
  input: ModelTestInput,
): Promise<ModelTestResult> {
  const url = input.baseUrl?.trim()
  if (!url) return { ok: false, message: '缺少 Base URL' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  const start = performance.now()

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined,
      signal: controller.signal,
    })
    const elapsedMs = Math.round(performance.now() - start)
    if (res.status < 500) {
      return {
        ok: true,
        message: `连通成功（HTTP ${res.status}）`,
        status: res.status,
        elapsedMs,
      }
    }
    return {
      ok: false,
      message: `服务错误（HTTP ${res.status}）`,
      status: res.status,
      elapsedMs,
    }
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start)
    const e = err as { name?: string; message?: string }
    if (e?.name === 'AbortError') {
      return { ok: false, message: '连接超时（8 秒）', elapsedMs }
    }
    return { ok: false, message: `连接失败：${e?.message ?? '未知错误'}`, elapsedMs }
  } finally {
    clearTimeout(timer)
  }
}
