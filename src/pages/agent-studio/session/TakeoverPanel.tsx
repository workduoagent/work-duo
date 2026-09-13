/**
 * 接管上下文侧栏（Phase 2b-2）。
 *
 * 步骤受阻（恢复弹窗出现）时，右栏自动切到「接管」Tab，展示接管决策所需的完整上下文：
 *  - 工具栈：原生工具 / MCP 工具 / 技能 / 沙箱开关（让用户清楚手里有哪些能力可调用）；
 *  - 已改动文件：本步骤真实触碰过的路径，点项调 read_artifact 预览；
 *  - 失败命令：最近一次失败工具的命令原文 + 受阻原因。
 *
 * 弹窗（UserPromptPanel 的 RecoveryContent）只承载「受阻原因 + 决策按钮」，详细上下文收敛到本面板，
 * 避免弹窗内联过挤、信息重复。
 */
import { useState, type ReactNode } from 'react'
import { FileText, Wrench, Boxes, Sparkles, Terminal, ChevronDown } from 'lucide-react'
import type { RecoveryRequest } from './types'

function Section({
  title,
  icon,
  count,
  defaultOpen = true,
  children,
}: {
  title: string
  icon: ReactNode
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="agent-takeover__section">
      <button
        className="agent-takeover__section-head"
        type="button"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agent-takeover__section-icon">{icon}</span>
        <span className="agent-takeover__section-title">
          {title}
          {count != null ? `（${count}）` : ''}
        </span>
        <ChevronDown size={14} className={`agent-takeover__chevron ${open ? 'is-open' : ''}`} />
      </button>
      {open && <div className="agent-takeover__section-body">{children}</div>}
    </div>
  )
}

export function TakeoverPanel({
  recovery,
  onPreviewArtifact,
}: {
  recovery: RecoveryRequest | null
  onPreviewArtifact: (path: string) => void
}) {
  if (!recovery) {
    return (
      <div className="agent-takeover__empty">
        暂无接管上下文。步骤受阻时会在此展示工具栈、已改文件与失败命令。
      </div>
    )
  }
  const ts = recovery.toolStack
  const files = recovery.changedFiles ?? []
  return (
    <div className="agent-takeover">
      <div className="agent-takeover__head">
        <div className="agent-takeover__head-title">接管上下文</div>
        <div className="agent-takeover__head-sub">
          步骤 {recovery.step}「{recovery.title}」· 档 {recovery.tier ?? 'A'}
        </div>
      </div>

      {/* 工具栈 */}
      <Section title="工具栈" icon={<Wrench size={14} />} defaultOpen>
        {!ts ? (
          <div className="agent-takeover__hint">（未提供工具栈信息）</div>
        ) : (
          <div className="agent-takeover__stack">
            <div className="agent-takeover__stack-row">
              <span className="agent-takeover__stack-label">
                <Boxes size={13} /> 原生工具
              </span>
              <div className="agent-takeover__tags">
                {(ts.nativeTools ?? []).map((t) => (
                  <span key={t} className="agent-takeover__tag">
                    {t}
                  </span>
                ))}
                {(ts.nativeTools ?? []).length === 0 && <span className="agent-takeover__hint">无</span>}
              </div>
            </div>
            <div className="agent-takeover__stack-row">
              <span className="agent-takeover__stack-label">MCP 工具</span>
              <div className="agent-takeover__tags">
                {(ts.mcpTools ?? []).map((t) => (
                  <span key={t} className="agent-takeover__tag agent-takeover__tag--mcp">
                    {t}
                  </span>
                ))}
                {(ts.mcpTools ?? []).length === 0 && <span className="agent-takeover__hint">无</span>}
              </div>
            </div>
            <div className="agent-takeover__stack-row">
              <span className="agent-takeover__stack-label">
                <Sparkles size={13} /> 技能
              </span>
              <div className="agent-takeover__tags">
                {(ts.skills ?? []).map((t) => (
                  <span key={t} className="agent-takeover__tag agent-takeover__tag--skill">
                    {t}
                  </span>
                ))}
                {(ts.skills ?? []).length === 0 && <span className="agent-takeover__hint">无</span>}
              </div>
            </div>
            <div className="agent-takeover__stack-row">
              <span className="agent-takeover__stack-label">沙箱执行</span>
              <span
                className={`agent-takeover__badge ${ts.sandboxEnabled ? 'is-on' : 'is-off'}`}
              >
                {ts.sandboxEnabled ? '已开启' : '已关闭'}
              </span>
            </div>
          </div>
        )}
      </Section>

      {/* 已改文件 */}
      <Section title="已改动文件" icon={<FileText size={14} />} count={files.length} defaultOpen>
        {files.length === 0 ? (
          <div className="agent-takeover__hint">本步骤尚未改动任何文件。</div>
        ) : (
          <ul className="agent-takeover__files">
            {files.map((f) => (
              <li key={f} className="agent-takeover__file">
                <button
                  className="agent-takeover__file-btn"
                  type="button"
                  onClick={() => onPreviewArtifact(f)}
                  title="预览 / 定位文件"
                >
                  <FileText size={13} />
                  <span className="agent-takeover__file-path">{f}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 失败命令 */}
      <Section title="失败命令" icon={<Terminal size={14} />} defaultOpen>
        {recovery.failedCommand ? (
          <pre className="agent-takeover__cmd">{recovery.failedCommand}</pre>
        ) : (
          <div className="agent-takeover__hint">（无失败命令信息）</div>
        )}
        {recovery.reason && (
          <div className="agent-takeover__reason">
            <span className="agent-takeover__reason-label">受阻原因：</span>
            <span className="agent-takeover__reason-text">{recovery.reason}</span>
          </div>
        )}
      </Section>
    </div>
  )
}
