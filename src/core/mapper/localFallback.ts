/**
 * mapper 层公共工具（F024）。
 *
 * 背景：此前 `safeParse` 在 7 个 mapper 里各写一遍（实现逐字相同，仅参数类型
 * 略有差异：有的收`string | null`，有的收 `string | null | undefined`）；
 * `lsRead` / `lsWrite` 同样散落 5 处。改一处漏N 处——实测已出现签名漂移
 * （squad-mapper 多收 `| undefined`），且 `bulkUpsert`（sqlUtils）写好了却零
 * 调用，同一份 upsert 列清单在 model-mapper 里手工维护两遍。
 *
 * 本模块只放「无业务语义」的纯函数；各mapper 的行转换（xxxToRow）仍留在原地。
 */

/**
 * 安全 JSON 解析：空值或解析失败一律回退 `fallback`。
 *
 * 统一签名接受 `string | null | undefined` —— 7 处原实现里两种参数类型并存，
 * 统一后调用方无需再关心差异。
 */
export function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** 读 localStorage 数组（JSON 解析失败或非数组时返回空数组）。 */
export function lsList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

/**
 * 写 localStorage 数组。
 *
 * 刻意**不**包try/catch —— 与原 5 处实现保持一致：配额超限等异常向上抛，
 * 让调用方能感知「配置未落盘」。静默失败会让 UI 显示「已保存」而实际没写，
 * 这类静默吞错在别处（store/persistence.ts）已被列为待修项，不应再引入。
 */
export function lsSave<T>(key: string, list: T[]): void {
  localStorage.setItem(key, JSON.stringify(list))
}
