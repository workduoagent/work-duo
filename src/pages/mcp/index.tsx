/**
 * 路由页面「MCP」：MCP 服务接入管理（仅「接入」，不提供「构建」）。
 * - 左侧场景侧栏（对应 scenario / McpScenario）；
 * - 顶部关键词搜索 + 工具栏（接入服务）；
 * - 卡片网格（含连通状态徽标、协议标签）+ 分页；
 * - 接入弹窗、详情抽屉（含工具 Tab 与连通性测试 / 同步）。
 *
 * 数据持久化走 src/core/mapper/mcp-mapper.ts（SQLite：workduo.db）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Search,
  Plus,
  Plug,
  Pencil,
  Eye,
  Trash2,
  RefreshCw,
  Power,
  Calendar,
  CircleDashed,
  CheckCircle2,
  XCircle,
  Server,
} from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { Tag, Popconfirm, message, Empty, Spin, Pagination, Tooltip } from 'antd'
import {
  listMcps,
  upsertMcp,
  deleteMcp,
  updateMcpStatus,
  setMcpActive,
  syncMcpTools,
} from '@/core/mapper/mcp-mapper'
import { testMcpConnection } from '@/core/mapper/mcp-connection'
import {
  MCP_SCENARIO_OPTIONS,
  getMcpScenarioLabel,
  getMcpStatusLabel,
  getMcpProtocolLabel,
  type McpInfo,
  type McpToolDefinition,
} from '@/core/file/mcp-file'
import type { McpStatus } from '@/types/core'
import { McpFormModal } from './components/McpFormModal'
import { McpDetailDrawer } from './components/McpDetailDrawer'
import './index.scss'

const PAGE_SIZE = 12

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function StatusBadge({ status }: { status: McpStatus | number }) {
  if (status === 1)
    return (
      <Tag color="success" className="mcphub-grid-item__badge">
        <CheckCircle2 size={12} /> {getMcpStatusLabel(1)}
      </Tag>
    )
  if (status === 2)
    return (
      <Tag color="error" className="mcphub-grid-item__badge">
        <XCircle size={12} /> {getMcpStatusLabel(2)}
      </Tag>
    )
  return (
    <Tag className="mcphub-grid-item__badge">
      <CircleDashed size={12} /> {getMcpStatusLabel(0)}
    </Tag>
  )
}

export default function McpHubPage() {
  const [scenarioFilter, setScenarioFilter] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<McpInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<McpInfo | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [viewing, setViewing] = useState<McpInfo | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [testingId, setTestingId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setRecords(await listMcps())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return records.filter((m) => {
      if (scenarioFilter !== 'all' && m.scenario !== scenarioFilter) return false
      if (
        kw &&
        !`${m.aliasName ?? ''} ${m.mcpName} ${m.description ?? ''}`.toLowerCase().includes(kw)
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
    () => [{ value: 'all', label: '全部 MCP' }, ...MCP_SCENARIO_OPTIONS],
    [],
  )

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }
  function openEdit(m: McpInfo) {
    setEditing(m)
    setModalOpen(true)
  }
  function openView(m: McpInfo) {
    setViewing(m)
    setDrawerOpen(true)
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

  // 列表卡片上的「测试连接」
  async function handleTest(m: McpInfo) {
    setTestingId(m.id)
    try {
      const res = await testMcpConnection(m)
      if (res.ok) {
        const tools: McpToolDefinition[] = res.tools.map((t) => ({
          ...t,
          mcpId: m.id,
        }))
        await syncMcpTools(m.id, tools)
      }
      setRecords(await updateMcpStatus(m.id, res.status))
      if (res.ok) {
        message.success(
          `连接成功，耗时 ${res.latencyMs}ms，发现 ${res.tools.length} 个工具`,
        )
      } else {
        message.error(`连接失败：${res.error}`)
      }
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="mcphub">
      {/* 左侧场景侧栏 */}
      <aside className="mcphub__sidebar">
        <div className="mcphub__sidebar-title">
          <Server size={15} />
          <span>MCP 场景</span>
        </div>
        <div className="mcphub__cat-list">
          {categories.map((cat) => {
            const isActive = scenarioFilter === cat.value
            const count =
              cat.value === 'all'
                ? records.length
                : counts[cat.value as string] ?? 0
            return (
              <div
                key={cat.value}
                className={`mcphub__cat-item ${isActive ? 'active' : ''}`}
                onClick={() => setScenarioFilter(cat.value)}
              >
                <span className="mcphub__cat-label">{cat.label}</span>
                <span className="mcphub__cat-count">{count}</span>
              </div>
            )
          })}
        </div>
      </aside>

      {/* 右侧内容 */}
      <div className="mcphub__content">
        <header className="mcphub__head">
          <div>
            <h2 className="mcphub__title">MCP 服务接入</h2>
            <p className="mcphub__lead">
              接入本地或第三方的 Model Context Protocol 服务，自动发现并管理其工具能力。
            </p>
          </div>
          <div className="mcphub__actions">
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} />
              接入服务
            </Button>
          </div>
        </header>

        <div className="mcphub__toolbar">
          <Input
            allowClear
            placeholder="搜索服务名称 / 标识 / 描述"
            prefix={<Search size={14} color="var(--color-foreground-muted)" />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => setCurrentPage(1)}
            style={{ width: 280 }}
          />
        </div>

        <Spin spinning={loading} wrapperClassName="mcphub__spin">
          {pageRecords.length > 0 ? (
            <div className="mcphub-grid">
              {pageRecords.map((mcp) => (
                <div
                  key={mcp.id}
                  className={`mcphub-grid-item ${
                    mcp.status === 2 ? 'mcphub-grid-item--error' : ''
                  }`}
                  onClick={() => openView(mcp)}
                >
                  <div className="mcphub-grid-item__header">
                    <div className="mcphub-grid-item__logo">
                      <Plug size={20} />
                    </div>
                    <div className="mcphub-grid-item__title-box">
                      <Tooltip title={mcp.aliasName || mcp.mcpName}>
                        <h3 className="mcphub-grid-item__title">
                          {mcp.aliasName || mcp.mcpName}
                        </h3>
                      </Tooltip>
                      <span className="mcphub-grid-item__identifier">
                        {mcp.mcpName}
                      </span>
                    </div>
                  </div>

                  <p className="mcphub-grid-item__desc" title={mcp.description}>
                    {mcp.description || '暂无描述'}
                  </p>

                  <div className="mcphub-grid-item__meta">
                    <div className="mcphub-grid-item__meta-tags">
                      <Tag color="blue">{getMcpProtocolLabel(mcp.protocolType)}</Tag>
                      <span className="mcphub-grid-item__category">
                        {getMcpScenarioLabel(mcp.scenario)}
                      </span>
                    </div>
                    <span className="mcphub-grid-item__meta-info">
                      <Calendar size={12} />
                      {formatDate(mcp.createdAt)}
                    </span>
                  </div>

                  <div className="mcphub-grid-item__status-row">
                    <StatusBadge status={mcp.status} />
                    {!mcp.isActive && (
                      <Tag color="default" className="mcphub-grid-item__badge">
                        已禁用
                      </Tag>
                    )}
                  </div>

                  <div
                    className="mcphub-grid-item__actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="action-btn test"
                      disabled={testingId === mcp.id}
                      onClick={() => handleTest(mcp)}
                    >
                      <RefreshCw
                        size={13}
                        className={testingId === mcp.id ? 'spin' : ''}
                      />
                      {testingId === mcp.id ? '测试中' : '测试'}
                    </button>
                    <button
                      className="action-btn edit"
                      onClick={() => openEdit(mcp)}
                    >
                      <Pencil size={13} /> 编辑
                    </button>
                    <button
                      className="action-btn view"
                      onClick={() => openView(mcp)}
                    >
                      <Eye size={13} /> 详情
                    </button>
                    <Popconfirm
                      title={mcp.isActive ? '确定禁用该服务吗？' : '确定启用该服务吗？'}
                      okText="确定"
                      cancelText="取消"
                      onConfirm={() => handleToggle(mcp)}
                    >
                      <button className="action-btn toggle">
                        <Power size={13} /> {mcp.isActive ? '禁用' : '启用'}
                      </button>
                    </Popconfirm>
                    <Popconfirm
                      title="确定移除该服务吗？"
                      okText="确定"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDelete(mcp)}
                    >
                      <button className="action-btn delete">
                        <Trash2 size={13} /> 删除
                      </button>
                    </Popconfirm>
                  </div>
                </div>
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

      <McpFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        mcp={editing}
        onSave={handleSave}
      />

      <McpDetailDrawer
        open={drawerOpen}
        mcp={viewing}
        onClose={() => setDrawerOpen(false)}
        onEdit={(m) => {
          setDrawerOpen(false)
          openEdit(m)
        }}
        onChanged={reload}
      />
    </div>
  )
}
