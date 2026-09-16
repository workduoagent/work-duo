/**
 * 输入框工具条胶囊族 + 通用下拉菜单（#20260915005 Step 5 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：JSX、className、实现、注释一律原样，仅加 export；
 * 渲染层 DOM 结构零改动。DropdownMenu 随本步一起抽出（WorkspaceChip 内部依赖它，
 * 分两步会产生循环 import）。PluginPill/McpPill 的悬浮 Pop 为交互重灾区
 * （createPortal 到 body 避 transform 漂移、rAF 二次校准、140ms 延迟隐藏），已逐字核对。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { createPortal } from 'react-dom'
import { Folder, FolderEdit, Puzzle, RotateCcw, Unlink, X } from 'lucide-react'
import { Switch } from '@/components/ui'
import { Avatar } from '@/components/ui/AvatarGroup'
import { readSkillLogoBase64 } from '@/core/file/skillFs'
import type { SkillInfo } from '@/core/file/skill-file'
import type { UserPluginTool } from '@/core/file/plugin-file'
import { leafDirName } from '@/core/mapper/agent-project-mapper'
import type { AgentProject } from '@/types/core'
import type { BoundMcpServer, MenuItem } from './types'

/** 技能头像 + 临时移除/恢复按钮。
 *  - Logo 优先读技能根目录 logo.<ext>（readSkillLogoBase64），读不到回退首字，与 Skill Hub 一致；
 *  - 悬停（未移除态）显示 × 可临时移除；已移除态显示 ↺ 可恢复；均为纯前端内存态，不写库。 */
export function SkillChip({
  skill,
  removed,
  onToggle,
}: {
  skill: SkillInfo
  removed: boolean
  onToggle: (id: string) => void
}) {
  const [logo, setLogo] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readSkillLogoBase64(skill.identifier)
      .then((url) => {
        if (active) setLogo(url)
      })
      .catch(() => {
        if (active) setLogo(null)
      })
    return () => {
      active = false
    }
  }, [skill.identifier])

  return (
    <span
      className={`agent-chat__skill-chip${removed ? ' is-removed' : ''}`}
      title={removed ? `已临时移除：${skill.name}（点击恢复）` : `${skill.name}（点击临时移除）`}
    >
      <Avatar
        size={24}
        src={logo ?? undefined}
        style={{ background: 'var(--color-background, #ffffff)', color: 'var(--color-foreground, #0b2030)' }}
      >
        {logo ? '' : (skill.name || skill.identifier || '').slice(0, 1)}
      </Avatar>
      <button
        type="button"
        className="agent-chat__skill-toggle"
        // 阻止点击时焦点从输入框转移，避免切换后焦点回弹导致输入框蓝色光晕闪动
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onToggle(skill.id)}
        title={removed ? '恢复此技能' : '临时移除此技能（仅当前会话）'}
        aria-label={removed ? '恢复技能' : '临时移除技能'}
      >
        {removed ? <RotateCcw size={10} /> : <X size={10} />}
      </button>
    </span>
  )
}

/** 已挂载插件的图标胶囊（P2）：icon 代替长名，悬浮 Pop 列出全部插件详情，
 *  支持临时取消挂载（会话内生效，与 Skill 临时移除同逻辑，走 disabled_plugin_ids 通道）。 */
export function PluginPill({
  plugins,
  removedIds,
  onToggleRemove,
}: {
  plugins: UserPluginTool[]
  removedIds: Set<string>
  onToggleRemove: (pluginId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 工具条在页面底部，弹层向上展开（锚定 bottom，避免溢出视口下沿）
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 })

  const computePos = useCallback(() => {
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 320))
      setPos({ bottom: window.innerHeight - r.top + 6, left })
    }
  }, [])

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    computePos()
    setOpen(true)
    // 打开后再校准一次：规避 mouseenter 瞬间的布局漂移（如异步头像/字体加载导致的位移）
    requestAnimationFrame(computePos)
  }, [computePos])

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setOpen(false), 140)
  }, [])

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  const activeCount = plugins.length - removedIds.size

  return (
    <span
      ref={ref}
      className={`agent-chat__plugin-pill${activeCount === 0 ? ' is-removed' : ''}`}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      title="已挂载插件（悬浮查看详情 / 临时取消挂载）"
    >
      <Puzzle size={13} />
      {plugins.length > 1 && <span className="agent-chat__mcp-label">×{plugins.length}</span>}

      {open &&
        createPortal(
          <div
            className="agent-chat__mcp-pop"
            style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <div className="agent-chat__mcp-pop-card">
              <div className="agent-chat__mcp-pop-head">
                <span className="agent-chat__mcp-pop-title">
                  已挂载插件（{plugins.length}）
                </span>
              </div>
              <div className="agent-chat__mcp-pop-tools">
                {plugins.map((p) => {
                  const removed = removedIds.has(p.id)
                  return (
                    <div
                      key={p.id}
                      className="agent-chat__mcp-tool"
                      style={removed ? { opacity: 0.55 } : undefined}
                    >
                      <Puzzle size={13} style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          <span>{p.name}</span>
                          <code
                            style={{
                              fontSize: 10.5,
                              fontWeight: 400,
                              color: 'var(--color-foreground-muted)',
                            }}
                          >
                            custom__{p.identifier}
                          </code>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--color-foreground-muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={p.description}
                        >
                          {p.runtime === 'python' ? 'Python' : 'Bun'} ·{' '}
                          {p.description || '暂无描述'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="agent-chat__mcp-pop-remove"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onToggleRemove(p.id)}
                        title={removed ? '恢复挂载（当前会话内生效）' : '临时取消挂载（仅当前会话）'}
                      >
                        {removed ? '恢复' : '移除'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </span>
  )
}

/** MCP 服务的文字胶囊 + 悬浮 Pop（移除整个服务 / 单个工具开关）。
 *  - 无头像，纯文字胶囊；多个 MCP 排列在 Skill 之后；
 *  - 悬浮弹出层显示该服务下全部绑定工具，可逐个开/关；
 *  - 移除整个服务或关闭工具均为会话内内存态，不写库；切换/重开会话即恢复。 */
export function McpPill({
  mcp,
  removed,
  disabledToolIds,
  onToggleRemove,
  onToggleTool,
}: {
  mcp: BoundMcpServer
  removed: boolean
  disabledToolIds: Set<string>
  onToggleRemove: (mcpId: string) => void
  onToggleTool: (toolId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 工具条在页面底部，弹层向上展开（锚定 bottom，避免溢出视口下沿）
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 })

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      // 弹层底部贴合胶囊顶部上方 6px；靠近右边界时左移避免溢出视口
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 260))
      setPos({ bottom: window.innerHeight - r.top + 6, left })
    }
    setOpen(true)
  }, [])

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setOpen(false), 140)
  }, [])

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }, [])

  return (
    <span
      ref={ref}
      className={`agent-chat__mcp-pill${removed ? ' is-removed' : ''}`}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <span className="agent-chat__mcp-label">{mcp.name}</span>
      {removed ? (
        <button
          type="button"
          className="agent-chat__mcp-toggle"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleRemove(mcp.mcpId)}
          title="恢复此 MCP 服务"
          aria-label="恢复 MCP 服务"
        >
          <RotateCcw size={10} />
        </button>
      ) : (
        <button
          type="button"
          className="agent-chat__mcp-toggle agent-chat__mcp-toggle--remove"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleRemove(mcp.mcpId)}
          title="临时移除整个 MCP 服务（仅当前会话）"
          aria-label="临时移除 MCP 服务"
        >
          <X size={10} />
        </button>
      )}

      {open && !removed && (
        <div
          className="agent-chat__mcp-pop"
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          <div className="agent-chat__mcp-pop-card">
            <div className="agent-chat__mcp-pop-head">
              <span className="agent-chat__mcp-pop-title">{mcp.name}</span>
              <button
                type="button"
                className="agent-chat__mcp-pop-remove"
                onClick={() => onToggleRemove(mcp.mcpId)}
              >
                移除服务
              </button>
            </div>
            <div className="agent-chat__mcp-pop-tools">
              {mcp.tools.map((t) => (
                <label key={t.toolId} className="agent-chat__mcp-tool">
                  <Switch
                    size="small"
                    checked={!disabledToolIds.has(t.toolId)}
                    onChange={() => onToggleTool(t.toolId)}
                  />
                  <span className="agent-chat__mcp-tool-name" title={t.description}>
                    {t.displayName || t.toolCode}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 通用点击外部关闭的下拉菜单
 * ---------------------------------------------------------------- */
export function DropdownMenu({
  trigger,
  items,
  align = 'right',
  title,
}: {
  trigger: React.ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom')
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setReady(false)
      return
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // 触发器与浮层（已 portal 到 body）都算内部，点击外部才关闭
      if (wrapRef.current && !wrapRef.current.contains(t) && menuRef.current && !menuRef.current.contains(t)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 自适应定位：打开后测量菜单真实尺寸与视口，若向下会超出视口底部（被任务栏/窗口底边挡住），
  // 则向上翻转；同时保证左右不超出视口。首次定位完成前隐藏浮层，避免一闪而过的错误位置。
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const trigger = triggerRef.current
    if (!menu || !trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuH = menu.offsetHeight
    const menuW = menu.offsetWidth
    const margin = 8
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth

    let nextTop = rect.bottom + 4
    let nextPlacement: 'bottom' | 'top' = 'bottom'
    if (nextTop + menuH > viewportH - margin) {
      nextTop = Math.max(margin, rect.top - menuH - 4)
      nextPlacement = 'top'
    }

    const rawLeft = align === 'right' ? rect.right - menuW : rect.left
    let nextLeft = Math.max(margin, rawLeft)
    if (nextLeft + menuW > viewportW - margin) {
      nextLeft = Math.max(margin, viewportW - menuW - margin)
    }

    setPos({ top: nextTop, left: nextLeft })
    setPlacement(nextPlacement)
    setReady(true)
  }, [open, align])

  // 点击触发器：用触发器实际位置 + fixed 定位。浮层 portal 到 body，
  // 彻底逃逸任何祖先 transform / overflow 裁剪，避免定位大幅偏移。
  const handleClick = () => {
    const el = triggerRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: Math.max(8, align === 'right' ? r.right - 168 : r.left) })
    }
    setOpen((o) => !o)
  }

  return (
    <div className="agent-chat__menu-wrap" ref={wrapRef}>
      <span className="agent-chat__menu-trigger" ref={triggerRef} onClick={handleClick}>
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`agent-chat__menu${align === 'right' ? ' is-right' : ''}${placement === 'top' ? ' is-top' : ''}`}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              minWidth: 168,
              visibility: ready ? 'visible' : 'hidden',
            }}
          >
            {title && <div className="agent-chat__menu-title">{title}</div>}
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                className={`agent-chat__menu-item${it.danger ? ' is-danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                {it.icon && <span className="agent-chat__menu-icon">{it.icon}</span>}
                <span className="agent-chat__menu-label">{it.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 输入框左侧的工作空间胶囊：
 *  - 未绑定目录 → 显示「选择目录」入口（任务态，可选为工程）
 *  - 已绑定目录 → 显示目录名（工程态，可更改 / 清除）
 * ---------------------------------------------------------------- */
export function WorkspaceChip({
  project,
  onPickDir,
  onChangeDir,
  onClear,
}: {
  project?: AgentProject
  onPickDir: () => void
  onChangeDir: () => void
  onClear: () => void
}) {
  // 未绑定：任务态，点击选择目录即可升级为工程
  if (!project) {
    return (
      <span
        className="agent-chat__chip agent-chat__chip--pick"
        title="选择工作目录（选中后本会话绑定为工程）"
        onClick={onPickDir}
      >
        <Folder size={12} />
        选择目录
      </span>
    )
  }
  // 已绑定：工程态，显示目录名，可更改 / 清除
  return (
    <DropdownMenu
      align="left"
      trigger={
        <span className="agent-chat__chip agent-chat__chip--workspace" title={project.rootPath}>
          <Folder size={12} />
          {leafDirName(project.rootPath)}
        </span>
      }
      items={[
        { label: '更改工作目录', icon: <FolderEdit size={13} />, onClick: onChangeDir },
        { label: '清除绑定（自由对话）', icon: <Unlink size={13} />, onClick: onClear, danger: true },
      ]}
    />
  )
}
