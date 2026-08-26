import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button } from 'antd'
import { MinimizeIcon, MaximizeIcon, CloseIcon } from '@/components/ui/icons'
import { isTauri } from '@/core/config'

/**
 * 窗口控制三键（最小化 / 最大化 / 关闭）。
 * 圆形按钮；hover 圆形背景；关闭键 hover 变红（由 layout.scss 接管视觉）。
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
        type="text"
        className="win-ctrl-btn"
        aria-label="最小化"
        onClick={minimize}
        icon={<MinimizeIcon />}
      />
      <Button
        type="text"
        className="win-ctrl-btn"
        aria-label="最大化或还原"
        onClick={toggleMaximize}
        icon={<MaximizeIcon />}
      />
      <Button
        type="text"
        className="win-ctrl-btn win-ctrl-btn--close"
        aria-label="关闭窗口"
        onClick={close}
        icon={<CloseIcon />}
      />
    </div>
  )
}
