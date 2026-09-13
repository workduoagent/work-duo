/**
 * 操作系统级原生通知兜底。
 *
 * 场景：当主窗口不在桌面最前（未聚焦）时，三类「需要用户操作」的 HITL 弹窗
 * （授权 / 异常恢复 / 方案推荐）除了应用内 antd 通知，还应额外弹一条系统原生
 * 通知（Windows Toast / macOS 横幅 / Linux 通知），提醒用户「客户端需要你操作」。
 *
 * 设计要点：
 *  - 复用全局 `isTauri` 常量；纯浏览器环境静默跳过。
 *  - 仅在主窗口未聚焦时发送，窗口聚焦时不打扰。
 *  - 首次调用惰性初始化聚焦追踪（isFocused + onFocusChanged），之后实时同步。
 *  - 权限申请做了兜底（首次请求一次，失败则跳过），不阻塞主流程。
 *  - 受「设置 → 系统设置 → 客户端通知」开关控制（clientNotify），关闭时不发送。
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  sendNotification,
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { isTauri } from '@/core/config'
import { loadSettings } from '@/core/file/settings-file'

// 主窗口当前是否聚焦（在桌面最前）。默认 true，避免启动早期误发。
let focused = true
let trackerInitialized = false
let permissionAsked = false

/** 惰性初始化主窗口聚焦追踪；幂等。 */
async function initWindowFocusTracker(): Promise<void> {
  if (!isTauri || trackerInitialized) return
  trackerInitialized = true
  try {
    focused = await getCurrentWindow().isFocused()
  } catch {
    focused = true
  }
  try {
    await getCurrentWindow().onFocusChanged(({ payload }) => {
      focused = payload
    })
  } catch {
    // 聚焦事件监听失败不影响主流程，保持 focused 上次值即可。
  }
}

/** 当前主窗口是否聚焦（在桌面最前）。 */
export function isWindowFocused(): boolean {
  return focused
}

/** 申请通知权限（仅首次真正弹系统授权框，之后复用结果）。 */
async function ensurePermission(): Promise<boolean> {
  if (!isTauri) return false
  try {
    const granted = await isPermissionGranted()
    if (granted) return true
    if (!permissionAsked) {
      permissionAsked = true
      const res = await requestPermission()
      return res === 'granted'
    }
    return granted
  } catch {
    return false
  }
}

/**
 * 当主窗口未聚焦时，发送一条操作系统原生通知提醒用户。
 * 窗口聚焦 / 非 Tauri 环境 / 无权限时静默返回。
 *
 * @param title 通知标题（建议与 HITL 应用内通知 message 一致）
 * @param body  通知正文（简述需要用户操作什么）
 */
export async function notifyOSWhenHidden(title: string, body?: string): Promise<void> {
  if (!isTauri) return
  await initWindowFocusTracker()
  // 窗口就在最前：应用内通知已足够，不发系统通知避免打扰。
  if (focused) return
  // 受「设置 → 客户端通知」开关控制，关闭时不发系统通知（每次直读库，确保实时）。
  try {
    const s = await loadSettings()
    if (!s.clientNotify) return
  } catch {
    /* 读失败默认开启，不阻断 */
  }
  if (!(await ensurePermission())) return
  try {
    sendNotification({ title, body: body ?? '' })
  } catch (e) {
    console.error('[osNotify] 发送系统通知失败', e)
  }
}
