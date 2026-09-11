/**
 * 一行式工具调用行（ToolStepLine）。
 *
 * 替代原「步骤 → 工具卡片」嵌套轨迹（PlanToolTimeline + ToolStepCard）：每个工具调用
 * 在对话流里只占**一行**，直接罗列「操作动词 + 文件名 + 修改行数」，阅读时像日志一样顺滑，
 * 不再用一张张大卡片把对话撑高（仿 WorkBuddy 风格）。
 *
 * 数据来源：后端 ToolStep 事件已带 op（操作类型）/ path（目标文件）/ linesAdded / linesRemoved
 * （文件变更类工具由 Rust 精确 LCS diff 得出）。缺失时前端按 toolName 兜底推导动词。
 *
 * 交互：默认单行；点击展开查看入参与结果摘要（长内容截断），再次点击折叠。
 */
import { useState } from 'react'
import {
  Archive,
  Brain,
  Check,
  FileCheck,
  FilePen,
  FilePlus,
  FileText,
  Folder,
  Globe,
  Loader2,
  MoveRight,
  Plug,
  Replace,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import type { ToolStep } from './types'
import { baseName, opOf, opVerb } from './toolNarrate'
import './ToolStepLine.scss'

function OpIcon({ op }: { op: string }) {
  switch (op) {
    case 'read':
      return <FileText size={13} />
    case 'write':
    case 'create':
      return <FilePlus size={13} />
    case 'edit':
      return <FilePen size={13} />
    case 'delete':
      return <Trash2 size={13} />
    case 'move':
      return <MoveRight size={13} />
    case 'list':
      return <Folder size={13} />
    case 'search':
      return <Search size={13} />
    case 'replace':
      return <Replace size={13} />
    case 'zip':
    case 'unzip':
      return <Archive size={13} />
    case 'check':
      return <FileCheck size={13} />
    case 'exec':
      return <Terminal size={13} />
    case 'http':
      return <Globe size={13} />
    case 'memory':
      return <Brain size={13} />
    case 'mcp':
      return <Plug size={13} />
    default:
      return <Terminal size={13} />
  }
}

/** 截断长文本用于展开区展示。 */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function ToolStepLine({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  const op = step.op ?? opOf(step.toolName)
  const label = opVerb(op)
  const name = baseName(step.path)

  const hasDelta =
    (step.linesAdded ?? 0) > 0 || (step.linesRemoved ?? 0) > 0

  return (
    <div className={`tool-line tool-line--${step.status}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="tool-line__row"
        onClick={() => setOpen((v) => !v)}
        title={step.path ? `${label} ${step.path}` : label}
      >
        <span className="tool-line__status">
          {step.status === 'running' ? (
            <Loader2 size={13} className="tool-line__spin" />
          ) : step.status === 'failed' ? (
            <X size={13} />
          ) : (
            <Check size={13} />
          )}
        </span>
        <span className="tool-line__op">
          <OpIcon op={op} />
        </span>
        <span className="tool-line__verb">{label}</span>
        {name && <span className="tool-line__name">{name}</span>}
        {hasDelta && (
          <span className="tool-line__delta">
            {(step.linesAdded ?? 0) > 0 && (
              <span className="tool-line__add">+{step.linesAdded}</span>
            )}
            {(step.linesRemoved ?? 0) > 0 && (
              <span className="tool-line__del">-{step.linesRemoved}</span>
            )}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-line__detail">
          {step.args && (
            <div className="tool-line__detail-block">
              <span className="tool-line__detail-label">参数</span>
              <code className="tool-line__detail-value">{clip(step.args, 600)}</code>
            </div>
          )}
          {step.result && (
            <div className="tool-line__detail-block">
              <span className="tool-line__detail-label">结果</span>
              <code className="tool-line__detail-value">{clip(step.result, 600)}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
