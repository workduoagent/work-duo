import { isTauri } from '@/core/config'
import { fe } from '@/core/logBridge'

const STORE_FILE = 'work-duo.dat'
// 台账 S5：挂 globalThis 跨 HMR 存活（热更后 Map 重建会丢非 Tauri 模式的内存持久化数据）。
const memoryFallback = ((globalThis as { __wdMemoryFallback?: Map<string, unknown> })
  .__wdMemoryFallback ??= new Map<string, unknown>())

/** 错误对象转字符串（fe 的签名只接受 message 字符串）。 */
function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

async function getStore() {
  if (!isTauri) return null
  // Dynamic import so the plugin is only pulled in inside a real Tauri runtime.
  const { load } = await import('@tauri-apps/plugin-store')
  return load(STORE_FILE)
}

/**
 * F025：读写失败不再静默。
 *
 * 原实现两处 `catch {}`：读取失败静默回落内存/默认值、写入失败静默忽略。
 * 后果是**UI 显示「已保存」而磁盘上什么都没有**，且事后无任何线索可查。
 *
 * 现状语义（保持不变的部分）：内存 Map 始终先写，作为 Tauri 不可用时的降级。
 * 新增：磁盘写失败时**抛出**（不再静默成功），让调用方能提示用户；
 * 读取失败仍回落内存/默认值（这是合理的降级），但**记 warn**留痕。
 */
export async function loadConfig<T>(key: string, fallback: T): Promise<T> {
  try {
    const store = await getStore()
    if (store) {
      const value = await store.get<T>(key)
      if (value !== null && value !== undefined) return value
    }
  } catch (e) {
    // 读取失败回落内存/默认值是合理降级（配置可能尚未落盘），但必须留痕：
    // 否则「用户改过配置但重启后丢失」这类问题无从追溯。
    fe.warn('persistence', `读取配置 ${key} 失败，回落到内存/默认值：${errText(e)}`)
  }
  const raw = memoryFallback.get(key)
  return raw !== undefined ? (raw as T) : fallback
}

/**
 * 保存配置到磁盘。
 *
 * @throws 当 Tauri 可用但 `store.set` / `store.save` 失败时抛出，
 *         使调用方能提示「保存失败」而非误报成功。
 */
export async function saveConfig<T>(key: string, value: T): Promise<void> {
  memoryFallback.set(key, value)
  const store = await getStore()
  if (!store) return // 非 Tauri 环境：内存 Map 即最终存储，无需报错
  try {
    await store.set(key, value)
    await store.save()
  } catch (e) {
    fe.error('persistence', `保存配置 ${key} 失败（内存副本已更新但未落盘）：${errText(e)}`)
    throw e
  }
}
