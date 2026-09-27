/**
 * 路由页面「插件」：自定义脚本插件中心（本地 FaaS）。
 * 布局严格对齐 MCP 模块（pages/mcp）：
 *  - 顶部 Header（标题 / 描述 + 搜索框 + 新建插件按钮，整行横跨，位于侧栏上方）；
 *  - 下方 SideBar（场景过滤）| MainOut（卡片网格 + 分页）两栏；
 *  - 卡片为浅灰实底（frame="solid"），状态 tag 右上角绝对定位，操作区为 ghost 图标按钮
 *    （编辑 / 详情 / 删除 + Switch 启用）。
 *
 * 文案定位（设计稿 §0.2）：Skill 教流程，MCP 连外部，Plugin 跑函数。
 * 数据持久化走 src/core/mapper/plugin-mapper.ts（SQLite：workduo.db）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  Plus,
  Puzzle,
  Pencil,
  Eye,
  Play,
  Trash2,
  FileCode2,
  LayoutGrid,
  FolderOpen,
  Globe,
  Database,
  Wrench,
  MessagesSquare,
  Briefcase,
  type LucideIcon,
} from 'lucide-react'
import { Button, Input, Card, Switch, Empty, Pagination, Popconfirm, Spin, Tooltip } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  listPlugins,
  upsertPlugin,
  deletePlugin,
  setPluginEnabled,
} from '@/core/mapper/plugin-mapper'
import {
  PLUGIN_RUNTIME_OPTIONS,
  type UserPluginTool,
  type UpsertUserPluginInput,
} from '@/core/file/plugin-file'
import { listByScope } from '@/core/mapper/scenario-mapper'
import type { ScenarioCategory } from '@/types/core'
import { PluginFormModal } from './components/PluginFormModal'
import { PluginTestModal } from './components/PluginTestModal'
import './index.scss'

const PAGE_SIZE = 12

/** 场景分类 -> 图标（侧栏展示，与 MCP 卡片风格统一）。 */
const SCENARIO_ICON: Record<string, LucideIcon> = {
  all: LayoutGrid,
  'file-system': FolderOpen,
  'web-search': Globe,
  database: Database,
  'dev-tools': Wrench,
  communication: MessagesSquare,
  productivity: Briefcase,
}

/** runtime -> 展示名。 */
const RUNTIME_LABEL: Record<string, string> = Object.fromEntries(
  PLUGIN_RUNTIME_OPTIONS.map((o) => [o.value, o.label]),
)

/** 右上角状态徽标（最近运行状态：成功 / 失败 / 未测试；禁用态优先）。 */
function StatusPill({ p }: { p: UserPluginTool }) {
  if (!p.enabled)
    return (
      <span className="pluginhub-grid-item__status pluginhub-grid-item__status--off">
        <i className="pluginhub-grid-item__dot" />
        已禁用
      </span>
    )
  if (p.lastRunStatus === 'success')
    return (
      <span className="pluginhub-grid-item__status pluginhub-grid-item__status--on">
        <i className="pluginhub-grid-item__dot" />
        最近成功
      </span>
    )
  if (p.lastRunStatus === 'failed')
    return (
      <span className="pluginhub-grid-item__status pluginhub-grid-item__status--err">
        <i className="pluginhub-grid-item__dot" />
        最近失败
      </span>
    )
  return (
    <span className="pluginhub-grid-item__status pluginhub-grid-item__status--idle">
      <i className="pluginhub-grid-item__dot" />
      未测试
    </span>
  )
}

export default function PluginHubPage() {
  const { message } = useNotify()
  const [scenarioFilter, setScenarioFilter] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<UserPluginTool[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<UserPluginTool | null>(null)
  const [testing, setTesting] = useState<UserPluginTool | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [scenarios, setScenarios] = useState<ScenarioCategory[]>([])
  const [scenarioLabels, setScenarioLabels] = useState<Record<string, string>>({})
  const navigate = useNavigate()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setRecords(await listPlugins())
    } finally {
      setLoading(false)
    }
  }, [])

  const loadScenarios = useCallback(async () => {
    const list = await listByScope('PLUGIN')
    setScenarios(list)
    setScenarioLabels(Object.fromEntries(list.map((s) => [s.value, s.label])))
  }, [])

  useEffect(() => {
    void reload()
    void loadScenarios()
  }, [reload, loadScenarios])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return records.filter((p) => {
      if (scenarioFilter !== 'all' && p.scenario !== scenarioFilter) return false
      if (
        kw &&
        !`${p.name} ${p.identifier} ${p.description ?? ''}`.toLowerCase().includes(kw)
      )
        return false
      return true
    })
  }, [records, scenarioFilter, keyword])

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  useEffect(() => {
    setCurrentPage(1)
  }, [scenarioFilter, keyword])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pageRecords = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  const counts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const p of records) {
      const k = p.scenario ?? 'uncategorized'
      acc[k] = (acc[k] ?? 0) + 1
    }
    return acc
  }, [records])

  const categories = useMemo(
    () => [
      { value: 'all', label: '全部插件' },
      ...scenarios.map((s) => ({ value: s.value, label: s.label })),
    ],
    [scenarios],
  )

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }
  function openEdit(p: UserPluginTool) {
    setEditing(p)
    setModalOpen(true)
  }
  function openTest(p: UserPluginTool) {
    setTesting(p)
  }

  async function handleSave(input: UpsertUserPluginInput) {
    await upsertPlugin(input)
    await reload()
    message.success(editing ? '插件已更新' : '插件已创建')
  }

  async function handleDelete(p: UserPluginTool) {
    await deletePlugin(p.id)
    await reload()
    message.success('插件已移除')
  }

  async function handleToggle(p: UserPluginTool) {
    const list = await setPluginEnabled(p.id, !p.enabled)
    setRecords(list)
    message.success(!p.enabled ? '插件已启用' : '插件已禁用')
  }

  return (
    <div className="pluginhub">
      {/* 顶部 Header：标题 / 描述 + 搜索框 + 新建插件按钮（整行横跨，位于侧栏上方） */}
      <header className="pluginhub__head">
        <div>
          <h2 className="pluginhub__title">插件中心</h2>
          <p className="pluginhub__lead">
            本地可执行函数（FaaS）：编写 run(params)，平台沙箱执行、依赖自愈，
            并以 custom__&lt;标识符&gt; 注册为智能体工具。Skill 教流程，MCP 连外部，Plugin 跑函数。
          </p>
        </div>
        <div className="pluginhub__actions">
          <Input
            allowClear
            placeholder="搜索插件名称 / 标识 / 描述"
            prefix={<Search size={14} color="var(--color-foreground-muted)" />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => setCurrentPage(1)}
            style={{ width: 280 }}
          />
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} />
            新建插件
          </Button>
        </div>
      </header>

      {/* 侧栏 + 主内容 两栏 */}
      <div className="pluginhub__layout">
        <aside className="pluginhub__sidebar">
          <div className="pluginhub__sidebar-title">
            <FileCode2 size={15} />
            <span>场景分类</span>
          </div>
          <div className="pluginhub__cat-list">
            {categories.map((cat) => {
              const isActive = scenarioFilter === cat.value
              const count =
                cat.value === 'all'
                  ? records.length
                  : counts[cat.value as string] ?? 0
              return (
                <button
                  key={cat.value}
                  type="button"
                  className={`pluginhub__cat-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setScenarioFilter(cat.value)}
                >
                  {(() => {
                    const Icon = SCENARIO_ICON[cat.value] ?? LayoutGrid
                    return <Icon size={15} className="pluginhub__cat-icon" />
                  })()}
                  <span className="pluginhub__cat-label">{cat.label}</span>
                  {count > 0 && (
                    <span className="pluginhub__cat-count">{count}</span>
                  )}
                </button>
              )
            })}
          </div>
        </aside>

        <div className="pluginhub__main">
          <Spin spinning={loading} wrapperClassName="pluginhub__spin">
            {pageRecords.length > 0 ? (
              <div className="pluginhub-grid">
                {pageRecords.map((p) => (
                  <Card
                    key={p.id}
                    frame="solid"
                    className="pluginhub-grid-item"
                    onClick={() => navigate(`/plugin-hub/${p.id}`)}
                  >
                    <div className="pluginhub-grid-item__status-wrap">
                      <StatusPill p={p} />
                    </div>

                    <div className="pluginhub-grid-item__head">
                      <div className="pluginhub-grid-item__avatar">
                        <Puzzle size={18} />
                      </div>
                      <div className="pluginhub-grid-item__titles">
                        <Tooltip title={p.name}>
                          <h3 className="pluginhub-grid-item__name">{p.name}</h3>
                        </Tooltip>
                        <code className="pluginhub-grid-item__identifier">
                          custom__{p.identifier}
                        </code>
                      </div>
                    </div>

                    <div className="pluginhub-grid-item__tags">
                      <span className="pluginhub-grid-item__chip">
                        {RUNTIME_LABEL[p.runtime] ?? p.runtime}
                      </span>
                      <span className="pluginhub-grid-item__chip pluginhub-grid-item__chip--muted">
                        {p.scenario
                          ? scenarioLabels[p.scenario] ?? p.scenario
                          : '未分类'}
                      </span>
                      <span className="pluginhub-grid-item__chip pluginhub-grid-item__chip--muted">
                        超时 {p.timeoutSec}s
                      </span>
                    </div>

                    <p className="pluginhub-grid-item__desc" title={p.description}>
                      {p.description || '暂无描述'}
                    </p>

                    <div
                      className="pluginhub-grid-item__actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip title="试跑">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="试跑"
                          onClick={() => openTest(p)}
                        >
                          <Play size={16} />
                        </Button>
                      </Tooltip>
                      <Tooltip title="编辑">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="编辑"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil size={16} />
                        </Button>
                      </Tooltip>
                      <Tooltip title="详情">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="详情"
                          onClick={() => navigate(`/plugin-hub/${p.id}`)}
                        >
                          <Eye size={16} />
                        </Button>
                      </Tooltip>
                      <Popconfirm
                        title="确定移除该插件吗？"
                        okText="确定"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleDelete(p)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="pluginhub-grid-item__del"
                          aria-label="删除"
                          title="删除"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </Popconfirm>
                      <Switch
                        size="small"
                        checked={p.enabled}
                        onChange={() => handleToggle(p)}
                        aria-label="启用开关"
                        title={p.enabled ? '点击禁用' : '点击启用'}
                      />
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              !loading && (
                <div className="pluginhub-grid-empty">
                  <Empty description="暂无插件，点击右上角「新建插件」" />
                </div>
              )
            )}
          </Spin>

          {total > 0 && (
            <div className="pluginhub__pagination">
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

      <PluginFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        plugin={editing}
        onSave={handleSave}
      />

      <PluginTestModal
        open={testing !== null}
        plugin={testing}
        onOpenChange={(o) => {
          if (!o) setTesting(null)
        }}
        onTested={reload}
      />
    </div>
  )
}
