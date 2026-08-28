/**
 * Markdown 编辑器：编辑 / 预览 双模式切换。
 * - 编辑：纯文本 textarea（等宽字体，便于编写 SKILL.md / 指令内容）；
 * - 预览：复用项目已有的 MarkdownRenderer（react-markdown + remark-gfm）。
 *
 * 受控：value / onChange。
 */
import { useState } from 'react'
import { Eye, Pencil } from 'lucide-react'
import { Input } from '@/components/ui'
import { MarkdownRenderer } from './MarkdownRenderer'
import './MarkdownEditor.scss'

export interface MarkdownEditorProps {
  value?: string
  onChange?: (v: string) => void
  height?: number | string
  placeholder?: string
  readOnly?: boolean
}

export function MarkdownEditor({
  value = '',
  onChange,
  height = 260,
  placeholder,
  readOnly = false,
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')

  return (
    <div className="md-editor" data-readonly={readOnly ? 'true' : undefined}>
      <div className="md-editor__toolbar">
        <div className="md-editor__tabs">
          <button
            type="button"
            className={mode === 'edit' ? 'is-active' : ''}
            onClick={() => setMode('edit')}
            disabled={readOnly}
          >
            <Pencil size={13} />
            编辑
          </button>
          <button
            type="button"
            className={mode === 'preview' ? 'is-active' : ''}
            onClick={() => setMode('preview')}
          >
            <Eye size={13} />
            预览
          </button>
        </div>
      </div>

      <div className="md-editor__body" style={{ height }}>
        {mode === 'edit' ? (
          <Input.TextArea
            value={value}
            readOnly={readOnly}
            placeholder={placeholder}
            onChange={(e) => onChange?.(e.target.value)}
            className="md-editor__textarea"
          />
        ) : (
          <div className="md-editor__preview">
            {value?.trim() ? (
              <MarkdownRenderer content={value} />
            ) : (
              <span className="md-editor__empty">暂无内容可预览</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
