/**
 * 智能体首页（路由 /agent-studio）。
 *
 * 布局与知识库首页保持一致：左侧「场景分类」导航栏（scenario_category scope='AGENT'）
 * + 右侧卡片网格 + 底部分页器。
 *
 * 卡片展示：头像（Base64 / 默认 lucide 图标）、名称、唯一标识、场景标签、简介、
 * 绑定的 LLM 模型、已挂载工具数与技能数、启用开关；底部操作栏为 编辑 / 调试 / 删除。
 * 数据来自 agent-mapper（Tauri 走 SQLite，非 Tauri 回退 localStorage）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  Trash2,
  Pencil,
  MessageSquare,
  Wrench,
  Puzzle,
  Cpu,
  LayoutGrid,
  Bot,
} from 'lucide-react'
import { Popconfirm, Empty, Spin, Pagination } from 'antd'
import { Button, Card, Switch } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  listAgents,
  deleteAgent,
  setAgentActive,
  getAgentRefCounts,
} from '@/core/mapper/agent-mapper'
import { listByScope } from '@/core/mapper/scenario-mapper'
import { listModels } from '@/core/mapper/model-mapper'
import {
  agentNewPath,
  agentEditPath,
  agentChatPath,
} from '@/core/router/paths'
import { formatRelativeTime } from '@/utils/format'
import type { AgentInfo, AgentRefCounts, ScenarioCategory } from '@/types/core'
import './index.scss'

const PAGE_SIZE = 12

export default function AgentStudioPage() {
  const { message } = useNotify()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [list, setList] = useState<AgentInfo[]>([])
  const [scenarioFilter, setScenarioFilter] = useState<string>('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [scenarios, setScenarios] = useState<ScenarioCategory[]>([])
  const [scenarioLabels, setScenarioLabels] = useState<Record<string, string>>({})
  const [counts, setCounts] = useState<Record<string, AgentRefCounts>>({})
  const [modelNames, setModelNames] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [agents, refCounts] = await Promise.all([
        listAgents(),
        getAgentRefCounts(),
      ])
      setList(agents)
      setCounts(refCounts)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadScenarios = useCallback(async () => {
    const sc = await listByScope('AGENT')
    setScenarios(sc)
    setScenarioLabels(Object.fromEntries(sc.map((s) => [s.value, s.label])))
  }, [])

  /** 卡片要显示绑定的模型名，这里一次性把 models 拉成 id → 名称 的映射（模型量级很小）。 */
  const loadModels = useCallback(async () => {
    try {
      const models = await listModels()
      setModelNames(Object.fromEntries(models.map((m) => [m.id, m.name])))
    } catch {
      setModelNames({})
    }
  }, [])

  useEffect(() => {
    void reload()
    void loadScenarios()
    void loadModels()
  }, [reload, loadScenarios, loadModels])

  const filtered = useMemo(
    () => list.filter((a) => scenarioFilter === 'all' || a.scenario === scenarioFilter),
    [list, scenarioFilter],
  )

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => {
    setCurrentPage(1)
  }, [scenarioFilter])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pageRecords = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  const categoryCounts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const a of list) {
      const key = a.scenario ?? 'uncategorized'
      acc[key] = (acc[key] ?? 0) + 1
    }
    return acc
  }, [list])

  const categories = useMemo(
    () => [
      { value: 'all', label: '全部智能体' },
      ...scenarios.map((s) => ({ value: s.value, label: s.label })),
    ],
    [scenarios],
  )

  async function handleDelete(agent: AgentInfo) {
    try {
      const next = await deleteAgent(agent.id)
      setList(next)
      message.success(`已删除智能体「${agent.name}」`)
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleToggleActive(agent: AgentInfo, active: boolean) {
    try {
      const next = await setAgentActive(agent.id, active)
      setList(next)
    } catch (e) {
      message.error(`操作失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="agents">
      <header className="agents__head">
        <div>
          <h2 className="agents__title">智能体</h2>
          <p className="agents__lead">
            配置人设、模型与拓展工具（MCP 工具 / 技能），构建可对话、可调度的智能体。
          </p>
        </div>
        <div className="agents__actions">
          <Button variant="soft" size="sm" onClick={() => navigate(agentNewPath)}>
            <Plus size={14} />
            新建智能体
          </Button>
        </div>
      </header>

      <div className="agents__layout">
        <aside className="agents__sidebar">
          <div className="agents__sidebar-title">
            <LayoutGrid size={15} />
            <span>场景分类</span>
          </div>
          <div className="agents__cat-list">
            {categories.map((cat) => {
              const isActive = scenarioFilter === cat.value
              const count =
                cat.value === 'all' ? list.length : categoryCounts[cat.value as string] ?? 0
              const Icon = cat.value === 'all' ? LayoutGrid : Bot
              return (
                <button
                  key={cat.value}
                  type="button"
                  className={`agents__cat-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setScenarioFilter(cat.value)}
                >
                  <Icon size={15} className="agents__cat-icon" />
                  <span className="agents__cat-label">{cat.label}</span>
                  {count > 0 && <span className="agents__cat-count">{count}</span>}
                </button>
              )
            })}
          </div>
        </aside>

        <div className="agents__main">
          <Spin spinning={loading} wrapperClassName="agents__spin">
            {pageRecords.length > 0 ? (
              <div className="agents__grid">
                {pageRecords.map((agent) => {
                  const refCount = counts[agent.id] ?? { mcpTools: 0, skills: 0 }
                  return (
                    <Card
                      frame="solid"
                      key={agent.id}
                      className="agents__card"
                      onClick={() => navigate(agentEditPath(agent.id))}
                    >
                      <div className="agents__card-head">
                        <div className="agents__card-avatar">
                          {agent.logo ? (
                            <img src={agent.logo} alt={agent.name} className="agents__card-logo" />
                          ) : (
                            <Bot size={20} />
                          )}
                        </div>
                        <div className="agents__card-titles">
                          <h3 className="agents__card-title">{agent.name}</h3>
                          <code className="agents__card-identifier">{agent.identifier}</code>
                        </div>
                        <div className="agents__card-switch" onClick={(e) => e.stopPropagation()}>
                          <Switch
                            size="small"
                            checked={agent.isActive}
                            onChange={(v) => handleToggleActive(agent, v)}
                          />
                        </div>
                      </div>

                      <div className="agents__card-tags">
                        {agent.scenario && (
                          <span className="agents__card-chip agents__card-chip--muted">
                            {scenarioLabels[agent.scenario] ?? agent.scenario}
                          </span>
                        )}
                        {agent.autoToolExecMode && (
                          <span className="agents__card-chip agents__card-chip--auto">
                            自动执行
                          </span>
                        )}
                      </div>

                      <p className="agents__card-desc">{agent.description || '暂无描述'}</p>

                      <div className="agents__card-meta">
                        <span className="agents__card-meta-item" title="绑定的 LLM 模型">
                          <Cpu size={13} />
                          {agent.llmId ? modelNames[agent.llmId] ?? '模型已失效' : '未绑定模型'}
                        </span>
                        <span className="agents__card-meta-item" title="已挂载的 MCP 工具数">
                          <Wrench size={13} /> {refCount.mcpTools}
                        </span>
                        <span className="agents__card-meta-item" title="已编排的技能数">
                          <Puzzle size={13} /> {refCount.skills}
                        </span>
                      </div>

                      <div className="agents__card-actions" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="编辑"
                          onClick={() => navigate(agentEditPath(agent.id))}
                        >
                          <Pencil size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="调试"
                          onClick={() => navigate(agentChatPath(agent.id))}
                        >
                          <MessageSquare size={16} />
                        </Button>
                        <Popconfirm
                          title="删除智能体"
                          description="将同时解绑其 MCP 工具与技能，不可恢复。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => handleDelete(agent)}
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="agents__card-del"
                            aria-label="删除"
                          >
                            <Trash2 size={16} />
                          </Button>
                        </Popconfirm>
                        <span className="agents__card-time">
                          更新于 {formatRelativeTime(agent.updatedAt)}
                        </span>
                      </div>
                    </Card>
                  )
                })}
              </div>
            ) : (
              !loading && (
                <div className="agents__grid-empty">
                  <Empty description="暂无智能体，点击「新建智能体」开始" />
                </div>
              )
            )}
          </Spin>

          {total > 0 && (
            <div className="agents__pagination">
              <Pagination
                total={total}
                current={currentPage}
                pageSize={PAGE_SIZE}
                showSizeChanger={false}
                onChange={(page) => setCurrentPage(page)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
