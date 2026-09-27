/**
 * 向导步骤 7：绑定服务器（服务器托管，设计稿 docs/server-hosting-design.md）。
 *
 * 从 ServerHub 已录入的 server_host 取候选，勾选即写入 agent_server_ref
 * （第一个选中的为 primary / 默认 Host）。绑定后智能体获得 12 个 host__* 工具
 * （终端命令 + SFTP 文件同步，统一走 HostAuthz 独立授权域）；未绑定时工具不注册。
 * 布局/类名完全复用步骤 6 的 picker--two 双栏 + skill 卡片体系（样式同源，零新增 SCSS）。
 */
import { useEffect, useState } from 'react'
import { BookOpen, Trash2, Check } from 'lucide-react'
import { Button, Checkbox, Spin } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { listServerHosts } from '@/core/mapper/server-mapper'
import type { ServerHost } from '@/types/core'
import type { AgentDraft } from '../draft'

export interface StepServerProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
}

/** 提权模式文案。 */
function sudoText(mode: string): string {
  if (mode === 'sudo_cmd') return '白名单命令'
  if (mode === 'sudo_full') return '允许'
  return '禁止'
}

export function StepServer({ draft, patch }: StepServerProps) {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [servers, setServers] = useState<ServerHost[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await listServerHosts()
        if (alive) setServers(list)
      } catch (e) {
        message.error(`加载服务器失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [message])

  const selected = new Set(draft.serverIds)

  function toggle(serverId: string) {
    patch({
      serverIds: selected.has(serverId)
        ? draft.serverIds.filter((id) => id !== serverId)
        : [...draft.serverIds, serverId],
    })
  }

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? id

  if (loading) {
    return (
      <div className="agent-wizard__loading">
        <Spin />
      </div>
    )
  }

  if (servers.length === 0) {
    return (
      <div className="agent-wizard__placeholder">
        <BookOpen size={28} />
        <p>还没有已录入的服务器</p>
        <span>
          请先到「百宝箱 → 服务器」新建服务器并测试连接成功，再回到本步骤绑定。
        </span>
      </div>
    )
  }

  return (
    <div className="agent-wizard__picker agent-wizard__picker--two">
      <section className="agent-wizard__picker-main">
        <div className="agent-wizard__picker-head">
          <div>
            <div className="agent-wizard__picker-head-title">服务器</div>
            <div className="agent-wizard__picker-head-desc">
              勾选要绑定给该智能体的服务器（共 {servers.length} 台）；绑定后获得远程终端与文件同步能力
            </div>
          </div>
          <Checkbox
            checked={servers.length > 0 && servers.every((s) => selected.has(s.id))}
            indeterminate={
              servers.some((s) => selected.has(s.id)) && !servers.every((s) => selected.has(s.id))
            }
            onChange={(e) => {
              patch({ serverIds: e.target.checked ? servers.map((s) => s.id) : [] })
            }}
          >
            全选
          </Checkbox>
        </div>

        <div className="agent-wizard__skill-grid">
          {servers.map((s) => {
            const checked = selected.has(s.id)
            return (
              <label key={s.id} className={`agent-wizard__skill${checked ? ' is-checked' : ''}`}>
                <div className="agent-wizard__skill-head">
                  <Checkbox checked={checked} onChange={() => toggle(s.id)} />
                  <span className="agent-wizard__skill-name">{s.name}</span>
                  {checked && draft.serverIds[0] === s.id && (
                    <span className="agent-wizard__picker-badge">默认</span>
                  )}
                </div>
                <code className="agent-wizard__skill-identifier">
                  {s.user}@{s.host}:{s.port}
                </code>
                <p className="agent-wizard__skill-desc">
                  提权：{sudoText(s.sudoMode)} · 路径白名单：
                  {s.pathAllow.length ? s.pathAllow.join('、') : '未限制'}
                </p>
              </label>
            )
          })}
        </div>
      </section>

      <aside className="agent-wizard__picker-aside agent-wizard__picker-aside--right">
        <div className="agent-wizard__picker-title">
          <span>已绑定服务器（{draft.serverIds.length}）</span>
          {draft.serverIds.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => patch({ serverIds: [] })}>
              清空
            </Button>
          )}
        </div>
        <div className="agent-wizard__picker-list">
          {draft.serverIds.length === 0 && (
            <div className="agent-wizard__empty-hint">尚未绑定服务器</div>
          )}
          {draft.serverIds.map((id) => (
            <div key={id} className="agent-wizard__selected-item">
              <Check size={13} className="agent-wizard__selected-check" />
              <span className="agent-wizard__selected-label">{serverName(id)}</span>
              {draft.serverIds[0] === id && <span className="agent-wizard__picker-badge">默认</span>}
              <button
                type="button"
                className="agent-wizard__selected-del"
                onClick={() => patch({ serverIds: draft.serverIds.filter((s) => s !== id) })}
                aria-label="移除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {draft.serverIds.length > 0 && (
            <p className="agent-wizard__empty-hint">
              绑定后获得 host__* 工具族（终端 / 文件同步），远程操作一律走 HostAuthz 独立审批域。
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}
