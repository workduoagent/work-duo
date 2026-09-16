/**
 * 产物画廊 UI（#20260915005 Step 3 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：JSX、className、实现、注释一律原样，仅加 export；
 * 渲染层 DOM 结构零改动。
 */
import { Copy, File, FileCode, FileImage, FileSpreadsheet, FileText, Folder } from 'lucide-react'
import { openPath } from '@tauri-apps/plugin-opener'
import { useNotify } from '@/components/ui/notify'
import type { ArtifactRef } from '../session/types'
import { formatSize } from './file-helpers'

/** 产物画廊：把本次任务各子任务成功闭环登记的文件产物横向展示，支持打开/定位与复制路径（K3 §2.3）。 */
export function ArtifactIcon({ type }: { type: string }) {
  switch (type) {
    case 'image':
      return <FileImage size={16} />
    case 'spreadsheet':
      return <FileSpreadsheet size={16} />
    case 'code':
      return <FileCode size={16} />
    case 'directory':
      return <Folder size={16} />
    case 'document':
    case 'json':
    case 'report':
      return <FileText size={16} />
    default:
      return <File size={16} />
  }
}

export function ArtifactGallery({ artifacts, isTauri }: { artifacts: ArtifactRef[]; isTauri: boolean }) {
  const { message } = useNotify()
  if (!artifacts.length) return null
  const copyPath = (p: string) => {
    navigator.clipboard
      ?.writeText(p)
      .then(() => message.success('路径已复制'), () => message.error('复制失败'))
  }
  const open = (p: string) => {
    if (!isTauri) return
    openPath(p).catch(() => message.error('打开失败'))
  }
  return (
    <div className="agent-chat__gallery">
      <div className="agent-chat__gallery-title">📦 本次产物（{artifacts.length}）</div>
      <div className="agent-chat__gallery-list">
        {artifacts.map((a) => (
          <div key={a.artifactId} className="agent-chat__gallery-item" title={a.path}>
            <span className="agent-chat__gallery-icon">
              <ArtifactIcon type={a.artifactType} />
            </span>
            <div className="agent-chat__gallery-meta">
              <div className="agent-chat__gallery-name">{a.description || a.path}</div>
              <div className="agent-chat__gallery-sub">{formatSize(a.size)}</div>
            </div>
            <button
              type="button"
              className="agent-chat__gallery-open"
              title="在文件夹中打开"
              disabled={!isTauri}
              onClick={() => open(a.path)}
            >
              打开
            </button>
            <button
              type="button"
              className="agent-chat__gallery-copy"
              title="复制绝对路径"
              onClick={() => copyPath(a.path)}
            >
              <Copy size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
