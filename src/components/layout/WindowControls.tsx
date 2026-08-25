import { getCurrentWindow } from '@tauri-apps/api/window'
import { Button } from '@appica/ui-react/button'
import { MinimizeIcon, MaximizeIcon, CloseIcon } from '@/components/ui/icons'
import { isTauri } from '@/core/config'

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
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="最小化" onClick={minimize}>
        <MinimizeIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="最大化" onClick={toggleMaximize}>
        <MaximizeIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={close}>
        <CloseIcon />
      </Button>
    </div>
  )
}
