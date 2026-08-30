/**
 * 路由页面「MCP」：MCP 服务接入管理（仅「接入」，不提供「构建」）。
 * 布局与配色对齐 LLM 模块（model-settings）：
 * - 顶部 Header（标题 / 描述 + 搜索框 + 接入服务按钮，整行横跨，位于侧栏上方）；
 * - 下方 SideBar（场景过滤）| MainOut（卡片网格 + 分页）两栏；
 * - 卡片为浅灰实底（frame="solid"），状态 tag 右上角绝对定位，操作区为 ghost 图标按钮。
 *
 * 数据持久化走 src/core/mapper/mcp-mapper.ts（SQLite：workduo.db）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  Plus,
  Plug,
  Pencil,
  Eye,
  Trash2,
  Server,
  LayoutGrid,
  FolderOpen,
  Globe,
  Database,
  Wrench,
  MessagesSquare,
  Briefcase,
  Download,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { Button, Input, Card, Switch } from '@/components/ui'
import {
  Popconfirm,
  Empty,
  Spin,
  Pagination,
  Tooltip,
} from 'antd'
import { useNotify } from '@/components/ui/notify'
import {
  listMcps,
  upsertMcp,
  deleteMcp,
  setMcpActive,
  getMcpToolCountMap,
  type McpToolCount,
} from '@/core/mapper/mcp-mapper'
import {
  getMcpScenarioLabel,
  getMcpProtocolLabel,
  buildMcpServersJson,
  type McpInfo,
} from '@/core/file/mcp-file'
import { listByScope } from '@/core/mapper/scenario-mapper'
import type { ScenarioCategory } from '@/types/core'
import { saveTextFile } from '@/core/file/export-file'
import { BatchExportModal } from '@/components/export'
import { McpFormModal } from './components/McpFormModal'
import { McpImportModal } from './components/McpImportModal'
import './index.scss'

const PAGE_SIZE = 12

/** 场景分类 -> 图标（侧栏展示，与卡片风格统一）。 */
const SCENARIO_ICON: Record<string, LucideIcon> = {
  all: LayoutGrid,
  'file-system': FolderOpen,
  'web-search': Globe,
  database: Database,
  'dev-tools': Wrench,
  communication: MessagesSquare,
  productivity: Briefcase,
}

/** 右上角状态徽标（仿 LLM model-card__status：绝对定位 + 圆点）。 */
function StatusPill({ mcp }: { mcp: McpInfo }) {
  if (!mcp.isActive)
    return (
      <span className="mcphub-grid-item__status mcphub-grid-item__status--off">
        <i className="mcphub-grid-item__dot" />
        已禁用
      </span>
    )
  if (mcp.status === 1)
    return (
      <span className="mcphub-grid-item__status mcphub-grid-item__status--on">
        <i className="mcphub-grid-item__dot" />
        已连接
      </span>
    )
  if (mcp.status === 2)
    return (
      <span className="mcphub-grid-item__status mcphub-grid-item__status--err">
        <i className="mcphub-grid-item__dot" />
        连接失败
      </span>
    )
  return (
    <span className="mcphub-grid-item__status mcphub-grid-item__status--idle">
      <i className="mcphub-grid-item__dot" />
      未测试
    </span>
  )
}

/** 右上角状态区：状态徽标 + 工具计数徽标（{已激活}/{总数}），绝对定位在卡片右上角。 */
function StatusArea({
  mcp,
  count,
}: {
  mcp: McpInfo
  count: McpToolCount
}) {
  return (
    <div className="mcphub-grid-item__status-wrap">
      <StatusPill mcp={mcp} />
      <span
        className="mcphub-grid-item__tools"
        title={`已激活 ${count.active} / 工具总数 ${count.total}`}
      >
        <b>{count.active}</b>/{count.total}
      </span>
    </div>
  )
}

export default function McpHubPage() {
  const { message } = useNotify()
  const [scenarioFilter, setScenarioFilter] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<McpInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<McpInfo | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [toolCounts, setToolCounts] = useState<Record<string, McpToolCount>>({})
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [scenarios, setScenarios] = useState<ScenarioCategory[]>([])
  const [scenarioLabels, setScenarioLabels] = useState<Record<string, string>>({})
  const navigate = useNavigate()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [recs, map] = await Promise.all([listMcps(), getMcpToolCountMap()])
      setRecords(recs)
      setToolCounts(map)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadScenarios = useCallback(async () => {
    const list = await listByScope('MCP')
    setScenarios(list)
    setScenarioLabels(Object.fromEntries(list.map((s) => [s.value, s.label])))
  }, [])

  useEffect(() => {
    void reload()
    void loadScenarios()
  }, [reload, loadScenarios])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return records.filter((m) => {
      if (scenarioFilter !== 'all' && m.scenario !== scenarioFilter) return false
      if (
        kw &&
        !`${m.aliasName ?? ''} ${m.mcpName} ${m.description ?? ''}`
          .toLowerCase()
          .includes(kw)
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
    for (const m of records) {
      const k = m.scenario ?? 'uncategorized'
      acc[k] = (acc[k] ?? 0) + 1
    }
    return acc
  }, [records])

  const categories = useMemo(
    () => [
      { value: 'all', label: '全部 MCP' },
      ...scenarios.map((s) => ({ value: s.value, label: s.label })),
    ],
    [scenarios],
  )

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }
  function openEdit(m: McpInfo) {
    setEditing(m)
    setModalOpen(true)
  }

  async function handleSave(m: McpInfo) {
    setRecords(await upsertMcp(m))
    message.success(editing ? 'MCP 服务已更新' : 'MCP 服务已接入')
  }

  async function handleDelete(m: McpInfo) {
    setRecords(await deleteMcp(m.id))
    message.success('服务已移除')
  }

  async function handleToggle(m: McpInfo) {
    setRecords(await setMcpActive(m.id, !m.isActive))
    message.success(!m.isActive ? '服务已启用' : '服务已禁用')
  }

  // 批量导出：选中 MCP 转为标准 mcpServers.json，由用户选择保存位置
  const exportItems = useMemo(
    () =>
      records.map((m) => ({
        id: m.id,
        label: m.aliasName || m.mcpName || '(未命名)',
        sub: m.mcpName,
      })),
    [records],
  )

  async function handleExport(ids: string[]) {
    const picked = records.filter((m) => ids.includes(m.id))
    const json = JSON.stringify(buildMcpServersJson(picked), null, 2)
    const ok = await saveTextFile('mcpServers.json', json)
    if (ok) message.success(`已导出 ${picked.length} 个 MCP 服务到 mcpServers.json`)
  }

  // 批量导入：解析草稿逐个落库（同名服务按 id 覆盖，保证幂等）
  async function handleImport(items: McpInfo[]) {
    let current = records
    for (const it of items) {
      const exist = current.find((r) => r.mcpName === it.mcpName)
      current = await upsertMcp(exist ? { ...it, id: exist.id } : it)
    }
    setRecords(current)
    message.success(`已导入 ${items.length} 个 MCP 服务`)
  }

  return (
    <div className="mcphub">
      {/* 顶部 Header：标题 / 描述 + 搜索框 + 接入服务按钮（整行横跨，位于侧栏上方） */}
      <header className="mcphub__head">
        <div>
          <h2 className="mcphub__title">MCP 服务接入</h2>
          <p className="mcphub__lead">
            接入本地或第三方的 Model Context Protocol 服务，自动发现并管理其工具能力。
          </p>
        </div>
        <div className="mcphub__actions">
          <Input
            allowClear
            placeholder="搜索服务名称 / 标识 / 描述"
            prefix={<Search size={14} color="var(--color-foreground-muted)" />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => setCurrentPage(1)}
            style={{ width: 280 }}
          />
          <Button
            variant="soft"
            size="sm"
            onClick={() => setImportOpen(true)}
          >
            <Upload size={14} />
            导入
          </Button>
          <Button
            variant="soft"
            size="sm"
            disabled={records.length === 0}
            onClick={() => setExportOpen(true)}
          >
            <Download size={14} />
            批量导出
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} />
            接入服务
          </Button>
        </div>
      </header>

      {/* 侧栏 + 主内容 两栏 */}
      <div className="mcphub__layout">
        <aside className="mcphub__sidebar">
          <div className="mcphub__sidebar-title">
            <Server size={15} />
            <span>场景分类</span>
          </div>
          <div className="mcphub__cat-list">
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
                  className={`mcphub__cat-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setScenarioFilter(cat.value)}
                >
                  {(() => {
                    const Icon = SCENARIO_ICON[cat.value] ?? LayoutGrid
                    return <Icon size={15} className="mcphub__cat-icon" />
                  })()}
                  <span className="mcphub__cat-label">{cat.label}</span>
                  {count > 0 && (
                    <span className="mcphub__cat-count">{count}</span>
                  )}
                </button>
              )
            })}
          </div>
        </aside>

        <div className="mcphub__main">
          <Spin spinning={loading} wrapperClassName="mcphub__spin">
            {pageRecords.length > 0 ? (
              <div className="mcphub-grid">
                {pageRecords.map((mcp) => (
                  <Card
                    key={mcp.id}
                    frame="solid"
                    className="mcphub-grid-item"
                    onClick={() => navigate(`/mcp-hub/${mcp.id}`)}
                  >
                    <StatusArea
                      mcp={mcp}
                      count={toolCounts[mcp.id] ?? { total: 0, active: 0 }}
                    />

                    <div className="mcphub-grid-item__head">
                      <div className="mcphub-grid-item__avatar">
                        <Plug size={18} />
                      </div>
                      <div className="mcphub-grid-item__titles">
                        <Tooltip title={mcp.aliasName || mcp.mcpName}>
                          <h3 className="mcphub-grid-item__name">
                            {mcp.aliasName || mcp.mcpName}
                          </h3>
                        </Tooltip>
                        <code className="mcphub-grid-item__identifier">
                          {mcp.mcpName}
                        </code>
                      </div>
                    </div>

                    <div className="mcphub-grid-item__tags">
                      <span className="mcphub-grid-item__chip">
                        {getMcpProtocolLabel(mcp.protocolType)}
                      </span>
                      <span className="mcphub-grid-item__chip mcphub-grid-item__chip--muted">
                        {scenarioLabels[mcp.scenario ?? ''] ?? getMcpScenarioLabel(mcp.scenario)}
                      </span>
                    </div>

                    <p
                      className="mcphub-grid-item__desc"
                      title={mcp.description}
                    >
                      {mcp.description || '暂无描述'}
                    </p>

                    <div
                      className="mcphub-grid-item__actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip title="编辑">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="编辑"
                          onClick={() => openEdit(mcp)}
                        >
                          <Pencil size={16} />
                        </Button>
                      </Tooltip>
                      <Tooltip title="详情">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="详情"
                          onClick={() => navigate(`/mcp-hub/${mcp.id}`)}
                        >
                          <Eye size={16} />
                        </Button>
                      </Tooltip>
                      <Popconfirm
                        title="确定移除该服务吗？"
                        okText="确定"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleDelete(mcp)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="mcphub-grid-item__del"
                          aria-label="删除"
                          title="删除"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </Popconfirm>
                      <Switch
                        size="small"
                        checked={mcp.isActive}
                        onChange={() => handleToggle(mcp)}
                        aria-label="启用开关"
                        title={mcp.isActive ? '点击禁用' : '点击启用'}
                      />
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              !loading && (
                <div className="mcphub-grid-empty">
                  <Empty description="暂无 MCP 服务，点击右上角「接入服务」" />
                </div>
              )
            )}
          </Spin>

          {total > 0 && (
            <div className="mcphub__pagination">
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

      <McpFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        mcp={editing}
        onSave={handleSave}
      />

      <BatchExportModal
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="批量导出 MCP 服务"
        description="勾选要导出的服务（可单选、多选或全选），导出为标准 mcpServers.json，便于备份或迁移。"
        items={exportItems}
        onConfirm={handleExport}
      />

      <McpImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onConfirm={handleImport}
      />
    </div>
  )
}
