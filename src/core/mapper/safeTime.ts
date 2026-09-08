/**
 * 安全地把数据库时间值转成 ISO 字符串。
 *
 * 背景：本仓时间列以 epoch 毫秒（INTEGER）存储，但 Tauri SQL 插件在部分环境下
 * 会把整数列按字符串返回，导致 `new Date("1700000000000")` 被判定为非法日期格式，
 * 进而 `.toISOString()` 抛 `RangeError: Invalid time value`，让整页列表读取崩溃。
 * 存量库里若混入空串 / 非法值也会触发同样问题。
 *
 * 策略：兼容 number、纯数字字符串（epoch 毫秒）、ISO 日期字符串；
 * 对任意非法值兜底为「当前时间」，保证读取永不在脏数据上抛错。
 */
export function safeIso(v: unknown): string {
  if (v === null || v === undefined || v === '') return new Date().toISOString()
  let d: Date
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    // 纯数字字符串按 epoch 毫秒解析（new Date("1700000000000") 会被判为非法格式）
    d = new Date(Number(v))
  } else {
    d = new Date(v as string | number)
  }
  if (Number.isNaN(d.getTime())) return new Date().toISOString()
  return d.toISOString()
}
