import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button } from '@appica/ui-react/button'
import { MinimizeIcon, MaximizeIcon, CloseIcon } from '@/components/ui/icons'
import { isTauri } from '@/core/config'

/**
 * 窗口控制三键（最小化 / 最大化 / 关闭）。
 * 视觉对齐参考稿 .window-controls-icons .control-icon-btn：
 *  - 圆形按钮；
 *  - hover 时圆形背景 rgba(0,0,0,0.06)；
 *  - 关闭键 hover 变红（#ff4d4f）。
 * 交互逻辑沿用现有实现，仅补充 class 让 layout.css 接管视觉。
 */

async function minimize() {
  if (!isTauri) return
  await getCurrentWindow().minimize()
}

async function toggleMaximize() {
  if (!isTauri) return
  const win = getCurrentWindow()
  await win.toggleMaximize()
}

async function close() {
  if (!isTauri) return
  await getCurrentWindow().close()
}

export function WindowControls() {
  if (!isTauri) return null

  return (
    <div className="window-controls-icons">
      <Button
        variant="ghost"
        size="icon-sm"
        className="win-ctrl-btn"
        aria-label="最小化"
        onClick={minimize}
      >
        <MinimizeIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="win-ctrl-btn"
        aria-label="最大化或还原"
        onClick={toggleMaximize}
      >
        <MaximizeIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="win-ctrl-btn win-ctrl-btn--close"
        aria-label="关闭窗口"
        onClick={close}
      >
        <CloseIcon />
      </Button>
    </div>
  )
}
