import { useRef, type ChangeEvent } from 'react'
import { Brain, Upload, Trash2, FileText } from 'lucide-react'
import { Button, Switch } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { SettingItem } from './SettingItem'
import type { AppSettings, ImportedMemory } from '@/core/file/settings-file'

interface Props {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}

/** 把导入文件解析为 ImportedMemory 列表（支持 .json / .md / .txt）。 */
function parseMemoryFile(filename: string, text: string): ImportedMemory[] {
  const base = {
    id: crypto.randomUUID(),
    importedAt: Date.now(),
    source: filename,
  }
  const isJson = filename.toLowerCase().endsWith('.json')
  if (isJson) {
    try {
      const data: unknown = JSON.parse(text)
      if (Array.isArray(data)) {
        return data.map((item, i) => {
          if (typeof item === 'string') return { ...base, id: crypto.randomUUID(), title: `记忆 ${i + 1}`, content: item }
          const obj = item as Record<string, unknown>
          return {
            ...base,
            id: crypto.randomUUID(),
            title: (obj.title as string) || `记忆 ${i + 1}`,
            content: (obj.content as string) || (obj.text as string) || JSON.stringify(obj),
          }
        })
      }
      if (data && typeof data === 'object' && Array.isArray((data as { memories?: unknown[] }).memories)) {
        return ((data as { memories: unknown[] }).memories).map((item, i) => {
          const obj = item as Record<string, unknown>
          return {
            ...base,
            id: crypto.randomUUID(),
            title: (obj.title as string) || `记忆 ${i + 1}`,
            content: (obj.content as string) || (obj.text as string) || JSON.stringify(obj),
          }
        })
      }
      const obj = data as Record<string, unknown>
      return [{ ...base, title: (obj.title as string) || filename, content: (obj.content as string) || (obj.text as string) || text }]
    } catch {
      return [{ ...base, title: filename, content: text }]
    }
  }
  return [{ ...base, title: filename.replace(/\.(md|txt)$/i, ''), content: text }]
}

/** 记忆存储分区：生成对话记忆开关 + 记忆导入。 */
export function MemoryPanel({ settings, onChange }: Props) {
  const { message } = useNotify()
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const parsed = parseMemoryFile(file.name, text)
      onChange({ importedMemories: [...settings.importedMemories, ...parsed] })
      message.success(`已导入 ${parsed.length} 条记忆`)
    }
    reader.onerror = () => message.error('文件读取失败')
    reader.readAsText(file)
    e.target.value = '' // 允许重复选择同一文件
  }

  const removeMemory = (id: string) =>
    onChange({ importedMemories: settings.importedMemories.filter((m) => m.id !== id) })

  return (
    <div className="set-section">
      <h3 className="set-section__title">对话记忆</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Brain size={15} /></span>生成对话记忆</span>}
        description="允许 Work Duo 从对话中提取并记住相关上下文，以便在未来对话中提供更连贯、个性化的回应。"
        control={<Switch checked={settings.memoryEnabled} onChange={(v) => onChange({ memoryEnabled: v })} />}
      />

      <div className="set-mem-import">
        <div className="set-mem-import__head">
          <span>记忆导入</span>
          <Button variant="soft" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            导入记忆
          </Button>
        </div>
        <p className="set-mem-import__hint">支持 .json（数组或 {`{ memories: [] }`}）/ .md / .txt 文件，导入后参与对话上下文。</p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.md,.txt"
          style={{ display: 'none' }}
          onChange={handleFile}
        />

        {settings.importedMemories.length === 0 ? (
          <div className="set-mem-empty">暂无导入的记忆</div>
        ) : (
          <ul className="set-mem-list">
            {settings.importedMemories.map((m) => (
              <li key={m.id} className="set-mem-item">
                <span className="set-mem-item__icon"><FileText size={15} /></span>
                <div className="set-mem-item__text">
                  <div className="set-mem-item__title">{m.title}</div>
                  <div className="set-mem-item__preview">{m.content.slice(0, 80)}</div>
                </div>
                <button
                  type="button"
                  className="set-mem-item__del"
                  onClick={() => removeMemory(m.id)}
                  aria-label="删除记忆"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
