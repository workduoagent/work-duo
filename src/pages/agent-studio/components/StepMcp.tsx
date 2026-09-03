/**
 * 向导步骤 3：配置 MCP。
 *
 * 关键点（按用户设计）：关联表 agent_mcp_ref 的最小单元是「工具」而不是「服务」，
 * 所以这里左列选 MCP 服务、中列勾选该服务下的具体工具（tool_id → mcp_tool_definition.id），
 * 右列按服务分组展示已选工具并可单个移除。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Server, Wrench, Trash2, Check } from 'lucide-react'
import { Spin } from 'antd'
import { Button, Checkbox } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { listMcps, listMcpTools } from '@/core/mapper/mcp-mapper'
import type { McpInfo, McpToolDefinition } from '@/core/file/mcp-file'
import type { AgentDraft } from '../draft'
import { MAX_MCP_SERVERS, MAX_MCP_TOOLS } from '../draft'

export interface StepMcpProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
}

/** MCP 连通状态文案（0 未测试 / 1 正常 / 2 异常） */
const STATUS_TEXT: Record<number, string> = { 0: '未测试', 1: '正常', 2: '异常' }

export function StepMcp({ draft, patch }: StepMcpProps) {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [mcps, setMcps] = useState<McpInfo[]>([])
  const [toolsByMcp, setToolsByMcp] = useState<Record<string, McpToolDefinition[]>>({})
  const [activeMcpId, setActiveMcpId] = useState<string | undefined>(undefined)
  /** 已发起过请求的 mcpId，避免重复拉取造成死循环 */
  const requested = useRef<Set<string>>(new Set())

  const ensureTools = useCallback(async (mcpId: string) => {
    if (requested.current.has(mcpId)) return
    requested.current.add(mcpId)
    try {
      const tools = await listMcpTools(mcpId)
      setToolsByMcp((prev) => ({ ...prev, [mcpId]: tools }))
    } catch {
      // 拉取失败时移出集合，允许重试
      requested.current.delete(mcpId)
      setToolsByMcp((prev) => ({ ...prev, [mcpId]: [] }))
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await listMcps()
        if (!alive) return
        setMcps(list)
        if (list.length > 0) setActiveMcpId(list[0].id)
      } catch (e) {
        message.error(`加载 MCP 服务失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [message])

  // 编辑态：草稿里已绑定的工具所属服务，需要把工具拉回来才能显示名称
  useEffect(() => {
    for (const mcpId of new Set(draft.mcpTools.map((t) => t.mcpId))) void ensureTools(mcpId)
  }, [draft.mcpTools, ensureTools])

  // 切换左侧服务时预取该服务的工具
  useEffect(() => {
    if (activeMcpId) void ensureTools(activeMcpId)
  }, [activeMcpId, ensureTools])

  const selectedIds = new Set(draft.mcpTools.map((t) => t.toolId))

  const boundServers = new Set(draft.mcpTools.map((t) => t.mcpId)).size

  function toggleTool(mcpId: string, toolId: string) {
    const exists = selectedIds.has(toolId)
    if (!exists) {
      // 实时拦截：超过上限不给勾选（保存时还有兜底校验）
      const alreadyBound = draft.mcpTools.some((t) => t.mcpId === mcpId)
      if (!alreadyBound && boundServers >= MAX_MCP_SERVERS) {
        message.warning(`最多绑定 ${MAX_MCP_SERVERS} 个 MCP 服务`)
        return
      }
      if (draft.mcpTools.length >= MAX_MCP_TOOLS) {
        message.warning(`MCP 工具总数量不能超过 ${MAX_MCP_TOOLS} 个`)
        return
      }
    }
    patch({
      mcpTools: exists
        ? draft.mcpTools.filter((t) => t.toolId !== toolId)
        : [...draft.mcpTools, { mcpId, toolId }],
    })
  }

  function clearAll() {
    patch({ mcpTools: [] })
  }

  const activeTools = activeMcpId ? toolsByMcp[activeMcpId] ?? [] : []
  const boundCountByMcp = draft.mcpTools.reduce<Record<string, number>>((acc, t) => {
    acc[t.mcpId] = (acc[t.mcpId] ?? 0) + 1
    return acc
  }, {})

  const mcpName = (id: string) => mcps.find((m) => m.id === id)?.aliasName ?? '未知服务'
  const toolName = (mcpId: string, toolId: string) => {
    const tool = (toolsByMcp[mcpId] ?? []).find((t) => t.id === toolId)
    return tool?.displayName ?? tool?.toolCode ?? toolId
  }

  if (loading) {
    return (
      <div className="agent-wizard__loading">
        <Spin />
      </div>
    )
  }

  if (mcps.length === 0) {
    return (
      <div className="agent-wizard__placeholder">
        <Server size={28} />
        <p>还没有挂载任何 MCP 服务</p>
        <span>请先在「百宝箱 → MCP」中接入服务并同步工具，再来为智能体挑选工具。</span>
      </div>
    )
  }

  return (
    <div className="agent-wizard__picker">
      <aside className="agent-wizard__picker-aside">
        <div className="agent-wizard__picker-title">MCP 服务</div>
        <div className="agent-wizard__picker-list">
          {mcps.map((m) => {
            const isActive = m.id === activeMcpId
            return (
              <button
                key={m.id}
                type="button"
                className={`agent-wizard__picker-item${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveMcpId(m.id)}
              >
                <Server size={14} className="agent-wizard__picker-icon" />
                <span className="agent-wizard__picker-label">
                  {m.aliasName || m.mcpName}
                </span>
                {boundCountByMcp[m.id] ? (
                  <span className="agent-wizard__picker-badge">{boundCountByMcp[m.id]}</span>
                ) : null}
              </button>
            )
          })}
        </div>
      </aside>

      <section className="agent-wizard__picker-main">
        <div className="agent-wizard__picker-head">
          <div>
            <div className="agent-wizard__picker-head-title">
              {activeMcpId ? mcpName(activeMcpId) : '未选择服务'}
            </div>
            <div className="agent-wizard__picker-head-desc">
              {activeMcpId
                ? `${STATUS_TEXT[mcps.find((m) => m.id === activeMcpId)?.status ?? 0]} · 已选 ${boundServers}/${MAX_MCP_SERVERS} 服务 · 勾选需要开放给智能体的工具`
                : '从左侧选择一个 MCP 服务'}
            </div>
          </div>
          <Checkbox
            checked={activeTools.length > 0 && activeTools.every((t) => selectedIds.has(t.id))}
            indeterminate={
              activeTools.some((t) => selectedIds.has(t.id)) &&
              !activeTools.every((t) => selectedIds.has(t.id))
            }
            onChange={(e) => {
              const checked = e.target.checked
              const rest = draft.mcpTools.filter((t) => t.mcpId !== activeMcpId)
              if (checked) {
                // 实时拦截：全选本服务不得突破绑定服务数 / 总工具数上限
                const restServers = new Set(rest.map((t) => t.mcpId)).size
                if (!draft.mcpTools.some((t) => t.mcpId === activeMcpId) && restServers >= MAX_MCP_SERVERS) {
                  message.warning(`最多绑定 ${MAX_MCP_SERVERS} 个 MCP 服务`)
                  return
                }
                if (rest.length + activeTools.length > MAX_MCP_TOOLS) {
                  message.warning(`MCP 工具总数量不能超过 ${MAX_MCP_TOOLS} 个`)
                  return
                }
                patch({
                  mcpTools: [...rest, ...activeTools.map((t) => ({ mcpId: activeMcpId as string, toolId: t.id }))],
                })
              } else {
                patch({ mcpTools: rest })
              }
            }}
          >
            全选本服务
          </Checkbox>
        </div>

        <div className="agent-wizard__tool-list">
          {activeTools.length === 0 ? (
            <div className="agent-wizard__placeholder agent-wizard__placeholder--inline">
              <Wrench size={22} />
              <span>该服务还没有同步到工具，可到 MCP 详情页做一次连通性测试以自动发现工具。</span>
            </div>
          ) : (
            activeTools.map((tool) => {
              const checked = selectedIds.has(tool.id)
              return (
                <label
                  key={tool.id}
                  className={`agent-wizard__tool${checked ? ' is-checked' : ''}`}
                >
                  <Checkbox
                    checked={checked}
                    onChange={() => activeMcpId && toggleTool(activeMcpId, tool.id)}
                  />
                  <div className="agent-wizard__tool-body">
                    <div className="agent-wizard__tool-title">
                      {tool.displayName || tool.toolCode || '未命名工具'}
                      {tool.toolCode && (
                        <code className="agent-wizard__tool-code">{tool.toolCode}</code>
                      )}
                    </div>
                    {tool.description && (
                      <div className="agent-wizard__tool-desc" title={tool.description}>
                        {tool.description}
                      </div>
                    )}
                  </div>
                </label>
              )
            })
          )}
        </div>
      </section>

      <aside className="agent-wizard__picker-aside agent-wizard__picker-aside--right">
        <div className="agent-wizard__picker-title">
          <span>已选工具（{draft.mcpTools.length}/{MAX_MCP_TOOLS}）</span>
          {draft.mcpTools.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              清空
            </Button>
          )}
        </div>
        <div className="agent-wizard__picker-list">
          {draft.mcpTools.length === 0 && (
            <div className="agent-wizard__empty-hint">尚未选择任何工具</div>
          )}
          {Object.entries(
            draft.mcpTools.reduce<Record<string, string[]>>((acc, t) => {
              acc[t.mcpId] = [...(acc[t.mcpId] ?? []), t.toolId]
              return acc
            }, {}),
          ).map(([mcpId, toolIds]) => (
            <div key={mcpId} className="agent-wizard__selected-group">
              <div className="agent-wizard__selected-group-title">{mcpName(mcpId)}</div>
              {toolIds.map((toolId) => (
                <div key={toolId} className="agent-wizard__selected-item">
                  <Check size={13} className="agent-wizard__selected-check" />
                  <span className="agent-wizard__selected-label">{toolName(mcpId, toolId)}</span>
                  <button
                    type="button"
                    className="agent-wizard__selected-del"
                    onClick={() =>
                      patch({ mcpTools: draft.mcpTools.filter((t) => t.toolId !== toolId) })
                    }
                    aria-label="移除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
