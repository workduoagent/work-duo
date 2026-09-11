/**
 * 通用 Monaco JSON / 代码编辑器（本地加载，不依赖 CDN）。
 *
 * 设计要点：
 *  - 通过 loader.config 传入本地 monaco 实例，不走 CDN，断网 / 弱网也能打开；
 *  - web worker 由 Vite 的 ?worker 导入显式打包并通过 MonacoEnvironment 注册
 *    （ESM 构建默认的 new URL(..., import.meta.url) 在 Vite 下会取不到 worker）；
 *  - 兼容原 JsonView 的调用方式：value / onChange / readOnly / height，
 *    并额外支持 language（默认 json）、主题跟随应用明暗；
 *  - 受控：传入对象/数组/原始值会自动 JSON.stringify 展示；编辑时解析回
 *    原始 JSON 值通过 onChange 回传（非法 JSON 时回传 undefined，由调用方决定）；
 *  - 可随处复用（详情页只读展示 authConfig / headers / 调用结果，工具测试参数编辑等）。
 */
import { useEffect, useRef, useState } from 'react'
import { Editor, loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { Copy, Wand2 } from 'lucide-react'
// Vite 的 ?worker 后缀：让打包器显式产出 worker 产物（配合下方 MonacoEnvironment 使用）。
// 注意：monaco-editor 0.56 的 package.json exports 已把子路径前缀写死为 esm/vs/
// （"./*": "./esm/vs/*.js"），所以这里不能写成 monaco-editor/esm/vs/... ，
// 否则会被拼成 esm/vs/esm/vs/... 而解析失败。
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import './MonacoJsonEditor.scss'

// 本地加载：直接传入本地 monaco 实例，不走 CDN。
// 这样即使内网 / 弱网环境，编辑器也能正常打开。
loader.config({
  monaco,
  paths: { vs: '/node_modules/monaco-editor/min/vs' },
})

// --- Monaco web worker（Vite 必配）---
// monaco 的 ESM 构建用 new URL('...', import.meta.url) 定位 worker，
// Vite 不会自动打包这些路径，运行时就会报
// "Failed to load worker script for label: editorWorkerService"。
// 这里改用 Vite 的 ?worker 导入显式注册，按 label 分发。
// 后续若要支持其他语言，在此补上对应 worker 即可（如 ts / css / html）。
type WorkerCtor = new () => Worker
const LANGUAGE_WORKERS: Record<string, WorkerCtor> = {
  json: JsonWorker,
}
;(self as unknown as {
  MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker }
}).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    new (LANGUAGE_WORKERS[label] ?? EditorWorker)(),
}

export interface MonacoJsonEditorProps {
  /** 任意 JSON 值（对象 / 数组 / 原始值 / 字符串均可）；mode='code' 时直接传字符串 */
  value: unknown
  /** 值变化回调（可编辑时） */
  onChange?: (value: unknown) => void
  /** 只读展示（详情页 authConfig / headers / 调用结果用） */
  readOnly?: boolean
  /** 高度（CSS 值或像素数），默认 320 */
  height?: number | string
  /** 语言，默认 json；可传 yaml / jsonc / python / javascript 等 */
  language?: string
  /** 是否显示右上角工具条（格式化 / 复制），默认 true */
  showToolbar?: boolean
  /**
   * 解析模式：
   *  - 'json'（默认）：编辑内容按 JSON 解析后通过 onChange 回传 unknown；
   *  - 'code'：原始文本模式，直接把字符串通过 onChange 回传，适用于脚本 / Markdown 等
   *    非 JSON 内容的编辑（如技能脚本 Python / Node）。
   */
  mode?: 'json' | 'code'
  className?: string
}

function toText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return ''
  }
}

function safeParse(t: string): unknown {
  const s = t.trim()
  if (s === '') return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export function MonacoJsonEditor({
  value,
  onChange,
  readOnly = false,
  height = 320,
  language = 'json',
  showToolbar = true,
  mode = 'json',
  className,
}: MonacoJsonEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [text, setText] = useState<string>(() => toText(value))
  const [theme, setTheme] = useState<'light' | 'vs-dark'>(() =>
    document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light',
  )

  // 只读态：外部 value 变化直接同步展示
  useEffect(() => {
    if (readOnly) setText(toText(value))
  }, [value, readOnly])

  // 主题跟随应用明暗切换（<html> 上的 .light / .dark）
  useEffect(() => {
    const sync = () =>
      setTheme(document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
  }

  const handleChange = (next?: string) => {
    const t = next ?? ''
    setText(t)
    if (!onChange) return
    onChange(mode === 'code' ? t : safeParse(t))
  }

  const handleFormat = () => {
    editorRef.current?.getAction('editor.action.formatDocument')?.run()
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* 忽略：剪贴板不可用时静默 */
    }
  }

  return (
    <div
      className={`mcphub-monaco${className ? ` ${className}` : ''}`}
      data-readonly={readOnly ? 'true' : undefined}
    >
      {showToolbar && (
        <div className="mcphub-monaco__toolbar">
          <span className="mcphub-monaco__lang">{language}</span>
          <div className="mcphub-monaco__actions">
            {!readOnly && (
              <button
                type="button"
                className="mcphub-monaco__btn"
                onClick={handleFormat}
                title="格式化 JSON"
              >
                <Wand2 size={14} />
                <span>格式化</span>
              </button>
            )}
            <button
              type="button"
              className="mcphub-monaco__btn"
              onClick={handleCopy}
              title="复制内容"
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="mcphub-monaco__body">
        <Editor
          height={height}
          language={language}
          theme={theme}
          value={text}
          onChange={handleChange}
          onMount={handleMount}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily:
              "'AppMono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Consolas, monospace",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            lineNumbers: 'on',
            folding: true,
            renderLineHighlight: readOnly ? 'none' : 'line',
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            padding: { top: 10, bottom: 10 },
            formatOnPaste: !readOnly,
          }}
        />
      </div>
    </div>
  )
}
