/**
 * 导入配置弹窗：从 JSON 文件或文本框导入模型配置，解析校验后批量入库。
 * 支持「单个对象」或「对象数组」格式；缺失字段用默认值补齐；按 id 幂等覆盖。
 * 内置「复制 JSON 模板」按钮，方便用户基于模板编辑后粘贴。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button, Modal , LongTaskProgress, useLongTask } from '@/components/ui'
import { MonacoJsonEditor } from '@/components/code-editor'
import { parseModelImport, type ModelConfig } from '@/core/file/model-file'
import './ImportModal.scss'

/** 复制到剪贴板的 JSON 模板（含 toolCalls 字段，覆盖主流 LLM 场景） */
const JSON_TEMPLATE = JSON.stringify(
  [
    {
      name: 'GPT-4o',
      category: 'text',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-...',
      modelName: 'gpt-4o',
      enabled: true,
      toolCalls: true,
      description: '示例：支持工具调用的文本模型',
    },
    {
      name: 'Qwen-VL-Max',
      category: 'multimodal',
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-...',
      modelName: 'qwen-vl-max-latest',
      enabled: true,
      toolCalls: false,
      description: '示例：多模态视觉模型',
    },
  ],
  null,
  2,
)

export interface ImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 解析并校验通过后，拿到可入库的模型列表回调（由父层执行批量写入） */
  onImported: (models: ModelConfig[]) => void | Promise<void>
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  // F048：批量导入 N 个模型时界面此前完全静止，给出阶段与进度
  const task = useLongTask()
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 每次打开重置
  useEffect(() => {
    if (open) {
      setText('')
      setImporting(false)
      setCopied(false)
    }
  }, [open])

  async function handleCopyTemplate() {
    try {
      await navigator.clipboard.writeText(JSON_TEMPLATE)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API 不可用时静默失败（非 Tauri 环境可能受限）
    }
  }

  const parsed = useMemo(() => {
    if (!text.trim()) return { models: [], errors: [], total: 0 }
    return parseModelImport(text)
  }, [text])

  const canImport = parsed.models.length > 0 && !importing

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result ?? ''))
    reader.readAsText(file)
    e.target.value = ''
  }

  async function handleImport() {
    if (!canImport) return
    setImporting(true)
    task.start(`正在准备 ${parsed.models.length} 个模型配置…`)
    try {
      task.step(40, '正在写入配置…')
      await onImported(parsed.models)
      task.finish(`已导入 ${parsed.models.length} 个模型配置`)
      onOpenChange(false)
    } catch (e) {
      task.fail(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width="68%"
      title="导入模型配置"
      description="支持 JSON 文件或粘贴文本；可为单个对象或对象数组，缺失字段将用默认值补齐。"
      footer={
        <>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={importing} disabled={!canImport} onClick={handleImport}>
            导入{parsed.models.length > 0 ? `（${parsed.models.length}）` : ''}
          </Button>
        </>
      }
    >
      <div className="import-modal">
      {/* F048：长耗时导入进度 */}
      {task.running || task.error ? (
        <LongTaskProgress pct={task.pct} msg={task.msg} error={task.error} />
      ) : null}
        <div className="import-modal__toolbar">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={handleFile}
          />
          <Button variant="soft" size="sm" onClick={() => fileRef.current?.click()}>
            选择文件
          </Button>
          <Button variant="soft" size="sm" onClick={handleCopyTemplate}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制模板'}
          </Button>
          <span className="import-modal__hint">或直接在下方编辑器中粘贴 JSON 文本</span>
        </div>

        <MonacoJsonEditor
          className="import-modal__editor"
          mode="code"
          language="json"
          height={480}
          value={text}
          onChange={(v) => setText(typeof v === 'string' ? v : '')}
        />

        {text.trim() !== '' && (
          <div className="import-modal__result">
            <div className="import-modal__summary">
              共解析 {parsed.total} 条 · 有效{' '}
              <b className="is-ok">{parsed.models.length}</b> 条
              {parsed.errors.length > 0 && (
                <>
                  {' '}
                  · 错误 <b className="is-fail">{parsed.errors.length}</b> 条
                </>
              )}
            </div>
            {parsed.errors.length > 0 && (
              <ul className="import-modal__errors">
                {parsed.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
            {parsed.models.length > 0 && (
              <ul className="import-modal__preview">
                {parsed.models.map((m) => (
                  <li key={m.id}>
                    <span className="import-modal__name">{m.name || '(未命名)'}</span>
                    <span className="import-modal__meta">
                      {m.category} · {m.modelName || '—'}
                      {m.toolCalls && <b className="import-modal__tool">· 工具调用</b>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
