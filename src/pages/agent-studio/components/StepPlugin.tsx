/**
 * 向导步骤 5（P2 新增）：挂载本地插件。
 *
 * 从插件中心已录入的 user_plugin_tool 取候选，勾选即写入 agent_plugin_ref（保存时落库）。
 * 布局与步骤 4（编排 Skill）完全对齐：左侧候选卡片网格 + 右侧已挂载汇总（可单个移除）。
 * ★ 约定（设计稿 §5.1）：智能体 allow_sandbox=false 时插件工具不会被注册（运行时不加载），
 *   此处仅做 UI 强提示引导打开沙箱，不阻止保存。
 */
import { useEffect, useState } from 'react'
import { Puzzle, Trash2, Check, ShieldAlert } from 'lucide-react'
import { Button, Checkbox, Spin } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { listPlugins } from '@/core/mapper/plugin-mapper'
import { PLUGIN_RUNTIME_OPTIONS, type UserPluginTool } from '@/core/file/plugin-file'
import type { AgentDraft } from '../draft'
import { MAX_PLUGINS } from '../draft'

export interface StepPluginProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
}

/** runtime -> 展示名。 */
const RUNTIME_LABEL: Record<string, string> = Object.fromEntries(
  PLUGIN_RUNTIME_OPTIONS.map((o) => [o.value, o.label]),
)

export function StepPlugin({ draft, patch }: StepPluginProps) {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [plugins, setPlugins] = useState<UserPluginTool[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await listPlugins()
        if (alive) setPlugins(list)
      } catch (e) {
        message.error(`加载插件失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [message])

  const selected = new Set(draft.pluginIds)

  function toggle(pluginId: string) {
    if (!selected.has(pluginId) && draft.pluginIds.length >= MAX_PLUGINS) {
      message.warning(`挂载的插件最多 ${MAX_PLUGINS} 个`)
      return
    }
    patch({
      pluginIds: selected.has(pluginId)
        ? draft.pluginIds.filter((id) => id !== pluginId)
        : [...draft.pluginIds, pluginId],
    })
  }

  const pluginName = (id: string) => plugins.find((p) => p.id === id)?.name ?? id

  if (loading) {
    return (
      <div className="agent-wizard__loading">
        <Spin />
      </div>
    )
  }

  if (plugins.length === 0) {
    return (
      <div className="agent-wizard__placeholder">
        <Puzzle size={28} />
        <p>还没有任何插件</p>
        <span>请先在「百宝箱 → 插件」中新建插件（写一个 run(params) 函数），再来为智能体挂载。</span>
      </div>
    )
  }

  return (
    <div className="agent-wizard__picker agent-wizard__picker--two">
      <section className="agent-wizard__picker-main">
        <div className="agent-wizard__picker-head">
          <div>
            <div className="agent-wizard__picker-head-title">插件库</div>
            <div className="agent-wizard__picker-head-desc">
              勾选要挂载到该智能体的插件（共 {plugins.length} 个）；挂载后注册为 custom__&lt;标识符&gt; 工具
            </div>
          </div>
          <Checkbox
            checked={plugins.length > 0 && plugins.every((p) => selected.has(p.id))}
            indeterminate={
              plugins.some((p) => selected.has(p.id)) && !plugins.every((p) => selected.has(p.id))
            }
            onChange={(e) => {
              if (e.target.checked && plugins.length > MAX_PLUGINS) {
                message.warning(`挂载的插件最多 ${MAX_PLUGINS} 个`)
                return
              }
              patch({ pluginIds: e.target.checked ? plugins.map((p) => p.id) : [] })
            }}
          >
            全选
          </Checkbox>
        </div>

        <div className="agent-wizard__skill-grid">
          {plugins.map((plugin) => {
            const checked = selected.has(plugin.id)
            return (
              <label
                key={plugin.id}
                className={`agent-wizard__skill${checked ? ' is-checked' : ''}`}
              >
                <div className="agent-wizard__skill-head">
                  <Checkbox checked={checked} onChange={() => toggle(plugin.id)} />
                  <span className="agent-wizard__skill-name">{plugin.name}</span>
                  {!plugin.enabled && <span className="agent-wizard__skill-tag">已禁用</span>}
                </div>
                <code className="agent-wizard__skill-identifier">
                  custom__{plugin.identifier}
                </code>
                <p className="agent-wizard__skill-desc">{plugin.description || '暂无简介'}</p>
                <div className="agent-wizard__skill-tag" style={{ alignSelf: 'flex-start' }}>
                  {RUNTIME_LABEL[plugin.runtime] ?? plugin.runtime} · 超时 {plugin.timeoutSec}s
                </div>
              </label>
            )
          })}
        </div>
      </section>

      <aside className="agent-wizard__picker-aside agent-wizard__picker-aside--right">
        <div className="agent-wizard__picker-title">
          <span>已挂载插件（{draft.pluginIds.length}/{MAX_PLUGINS}）</span>
          {draft.pluginIds.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => patch({ pluginIds: [] })}>
              清空
            </Button>
          )}
        </div>
        {!draft.allowSandbox && draft.pluginIds.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
              padding: '8px 10px',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--color-warning, #d97706)',
              background: 'var(--color-background-muted)',
            }}
          >
            <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              该智能体未开启沙箱：本地插件属于本机代码执行，运行时不会注册插件工具。
              请在「基本信息」步骤打开「允许沙箱」后插件才会生效。
            </span>
          </div>
        )}
        <div className="agent-wizard__picker-list">
          {draft.pluginIds.length === 0 && (
            <div className="agent-wizard__empty-hint">尚未挂载任何插件</div>
          )}
          {draft.pluginIds.map((id) => (
            <div key={id} className="agent-wizard__selected-item">
              <Check size={13} className="agent-wizard__selected-check" />
              <span className="agent-wizard__selected-label">{pluginName(id)}</span>
              <button
                type="button"
                className="agent-wizard__selected-del"
                onClick={() => patch({ pluginIds: draft.pluginIds.filter((s) => s !== id) })}
                aria-label="移除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
