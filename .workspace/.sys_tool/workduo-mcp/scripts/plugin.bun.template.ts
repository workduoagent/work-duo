/**
 * name: 示例插件(Bun/TypeScript)
 * description: 演示 WorkDuo 本地插件的 run(params) 标准写法。接收 params（JSON 对象），返回 JSON 可序列化结果。
 * dependencies:
 *   - lodash
 * parameters:
 *   type: object
 *   properties:
 *     url:
 *       type: string
 *       description: 目标 URL
 *     repeat:
 *       type: integer
 *       description: 重复次数
 *   required:
 *     - url
 */
export async function run(params: Record<string, unknown>): Promise<unknown> {
  const url = (params.url as string) ?? ''
  const repeat = Number(params.repeat ?? 1) || 1

  // —— 在此实现业务逻辑；例如 fetch 请求、文件处理、调用本地命令等 ——
  // 缺依赖时直接 import 即可，Runner 会在 ERR_MODULE_NOT_FOUND 下自动安装并重试一次。
  const items = Array.from({ length: repeat }, (_, i) => ({ index: i, url }))

  // 返回值必须是 JSON 可序列化对象；Runner 负责 JSON.stringify 到 stdout。
  return {
    ok: true,
    url,
    count: items.length,
    items,
    received: params,
  }
}
