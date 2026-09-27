/**
 * MCP 服务详情页（路由 /mcp-hub/:id）。
 * 布局参考 nexus-web 的 model-config/mcp/detail.tsx：
 *  - 顶部返回导航 + 头部（Logo / 别名 / 状态 / 描述）；
 *  - 选项卡：服务详情（Descriptions + 工具计数统计条）/ 工具（同步 MCP 工具 + 卡片网格）。
 * 由于所有接入的 MCP 均为外部服务，不提供「新增工具」表单与按钮，
 * 工具只能经「同步 MCP 工具」从服务端自动发现。
 * 同步调用走 Rust 后端（connectMcp -> invoke('sync_mcp_tools')），避免跨域。
 *
 * 工具卡片：与列表卡片保持同一套风格（frame="solid" 浅灰实底、状态点、标题组、描述缩略、
 *          底部操作栏 ghost 图标按钮 + 右侧 Switch 启用开关）；编辑仅允许修改测试案例内容。
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Plug,
  RefreshCw,
  Trash2,
  Pencil,
  Calendar,
  CheckCircle2,
  XCircle,
  CircleDashed,
} from 'lucide-react'
import { useNotify } from '@/components/ui/notify'
import { Button, Card, Switch, Tag, Descriptions, Tabs, Empty, Spin, Popconfirm, Tooltip } from '@/components/ui'
import {
  getMcp,
  listMcpTools,
  syncMcpTools,
  updateMcpStatus,
  deleteMcpTool,
  setMcpToolActive,
  upsertMcpTool,
  getMcpToolCount,
} from '@/core/mapper/mcp-mapper'
import { connectMcp } from '@/core/mapper/mcp-connection'
import {
  getMcpScenarioLabel,
  getMcpProtocolLabel,
  getMcpAuthLabel,
  getMcpStatusLabel,
  type McpInfo,
  type McpToolDefinition,
} from '@/core/file/mcp-file'
import type { McpStatus } from '@/types/core'
import { ToolTestModal } from './components/ToolTestModal'
import { MonacoJsonEditor } from '@/components/code-editor'
import './index.scss'
import './detail.scss'

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function StatusTag({ status }: { status: McpStatus | number }) {
  if (status === 1)
    return (
      <Tag color="success">
        <CheckCircle2 size={12} /> {getMcpStatusLabel(1)}
      </Tag>
    )
  if (status === 2)
    return (
      <Tag color="error">
        <XCircle size={12} /> {getMcpStatusLabel(2)}
      </Tag>
    )
  return (
    <Tag>
      <CircleDashed size={12} /> {getMcpStatusLabel(0)}
    </Tag>
  )
}

export default function McpDetailPage() {
  const { message, result } = useNotify()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [mcp, setMcp] = useState<McpInfo | null>(null)
  const [tools, setTools] = useState<McpToolDefinition[]>([])
  const [counts, setCounts] = useState<{ total: number; active: number }>({
    total: 0,
    active: 0,
  })
  const [loadingTools, setLoadingTools] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [editingTool, setEditingTool] = useState<McpToolDefinition | null>(null)

  const loadTools = useCallback(async (mcpId: string) => {
    setLoadingTools(true)
    try {
      setTools(await listMcpTools(mcpId))
    } finally {
      setLoadingTools(false)
    }
  }, [])

  const loadCounts = useCallback(async (mcpId: string) => {
    setCounts(await getMcpToolCount(mcpId))
  }, [])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    void (async () => {
      const record = await getMcp(id)
      setMcp(record ?? null)
      setLoading(false)
      if (record) {
        await loadTools(id)
        await loadCounts(id)
      }
    })()
  }, [id, loadTools, loadCounts])

  async function handleSync() {
    if (!mcp) return
    setSyncing(true)
    try {
      const res = await connectMcp(mcp)
      if (res.ok) {
        const mapped: McpToolDefinition[] = res.tools.map((t) => ({ ...t, mcpId: mcp.id }))
        await syncMcpTools(mcp.id, mapped)
        setTools(mapped)
      }
      result(
        res,
        `连接成功，耗时 ${res.latencyMs}ms，已同步 ${res.tools.length} 个工具`,
        '连接失败',
      )
      // 状态/计数刷新独立于「连接结果」提示：即便写库失败也不掩盖上面的提示
      try {
        await updateMcpStatus(mcp.id, res.status)
        await loadCounts(mcp.id)
      } catch {
        /* 状态/计数写入失败不影响结果提示 */
      }
    } catch (e) {
      message.error(`同步工具异常：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  async function handleDeleteTool(tool: McpToolDefinition) {
    await deleteMcpTool(tool.id)
    if (mcp) {
      await loadTools(mcp.id)
      await loadCounts(mcp.id)
    }
    message.success('工具已移除')
  }

  async function handleToggleTool(tool: McpToolDefinition, active: boolean) {
    await setMcpToolActive(tool.id, active)
    if (mcp) {
      await loadTools(mcp.id)
      await loadCounts(mcp.id)
    }
  }

  async function handleSaveTool(tool: McpToolDefinition) {
    await upsertMcpTool(tool)
    if (mcp) {
      await loadTools(mcp.id)
      await loadCounts(mcp.id)
    }
    message.success('测试参数已更新')
  }

  if (loading) {
    return (
      <div className="mcphub-detail-page">
        <div className="mcphub-detail-page__loading">
          <Spin size="large" tip="正在加载服务详情..." />
        </div>
      </div>
    )
  }

  return (
    <div className="mcphub-detail-page">
      <div className="mcphub-detail-page__nav">
        <Button variant="ghost" size="sm" onClick={() => navigate('/mcp-hub')}>
          <ArrowLeft size={16} />
          返回服务列表
        </Button>
      </div>

      {mcp ? (
        <>
          <div className="mcphub-detail-page__header">
            <div className="mcphub-detail-page__header-logo">
              <Plug size={26} />
            </div>
            <div className="mcphub-detail-page__header-info">
              <div className="mcphub-detail-page__title-row">
                <h1 className="mcphub-detail-page__title">{mcp.aliasName || mcp.mcpName}</h1>
                <StatusTag status={mcp.status} />
                {!mcp.isActive && <Tag color="default">已禁用</Tag>}
              </div>
              <p className="mcphub-detail-page__desc">{mcp.description || '暂无详细描述'}</p>
            </div>
          </div>

          <Tabs
            defaultActiveKey="detail"
            items={[
              {
                key: 'detail',
                label: '服务详情',
                children: (
                  <div className="mcphub-detail-page__section">
                    <Descriptions column={2} size="middle" bordered>
                      <Descriptions.Item label="服务别名">{mcp.aliasName || '-'}</Descriptions.Item>
                      <Descriptions.Item label="服务标识">
                        <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{mcp.mcpName}</code>
                      </Descriptions.Item>
                      <Descriptions.Item label="协议类型">
                        <Tag color="blue">{getMcpProtocolLabel(mcp.protocolType)}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="认证类型">
                        <Tag>{getMcpAuthLabel(mcp.authType)}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="使用场景">
                        {getMcpScenarioLabel(mcp.scenario)}
                      </Descriptions.Item>
                      <Descriptions.Item label="连通状态">
                        <StatusTag status={mcp.status} />
                      </Descriptions.Item>
                      <Descriptions.Item label="访问地址" span={2}>
                        <span className="mcphub-detail-page__url">{mcp.endpointUrl || '-'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label="服务描述" span={2}>
                        {mcp.description || '暂无描述'}
                      </Descriptions.Item>
                      <Descriptions.Item label="工具总数">
                        {counts.total}
                      </Descriptions.Item>
                      <Descriptions.Item label="已激活">
                        {counts.active}
                      </Descriptions.Item>
                      <Descriptions.Item label="创建时间">
                        <Calendar size={13} /> {formatDate(mcp.createdAt)}
                      </Descriptions.Item>
                      <Descriptions.Item label="更新时间">
                        <Calendar size={13} /> {formatDate(mcp.updatedAt)}
                      </Descriptions.Item>
                    </Descriptions>

                    {(mcp.authConfig || mcp.headers) && (
                      <div className="mcphub-detail-page__configs">
                        {mcp.authConfig && (
                          <div className="mcphub-detail__config">
                            <div className="mcphub-detail__config-label">authConfig</div>
                            <MonacoJsonEditor value={mcp.authConfig} readOnly height={200} />
                          </div>
                        )}
                        {mcp.headers && (
                          <div className="mcphub-detail__config">
                            <div className="mcphub-detail__config-label">headers</div>
                            <MonacoJsonEditor value={mcp.headers} readOnly height={160} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'tools',
                label: `工具 (${counts.total})`,
                children: (
                  <div className="mcphub-tools-content">
                    <div className="mcphub-detail__tools-bar">
                      <Button variant="soft" size="sm" onClick={handleSync} loading={syncing}>
                        <RefreshCw size={14} />
                        同步 MCP 工具
                      </Button>
                    </div>
                    <Spin spinning={loadingTools}>
                      {tools.length > 0 ? (
                        <div className="mcphub-tools">
                          {tools.map((t) => (
                            <Card
                              key={t.id}
                              frame="solid"
                              className={`mcphub-tool-card${
                                !t.isActive ? ' mcphub-tool-card--disabled' : ''
                              }`}
                            >
                              <div className="mcphub-tool-card__head">
                                <span
                                  className={`mcphub-tool-status-dot ${
                                    t.isActive ? 'active' : 'inactive'
                                  }`}
                                />
                                <h4 className="mcphub-tool-card__title">
                                  {t.displayName || t.toolCode}
                                </h4>
                                {t.toolCode && (
                                  <code className="mcphub-tool-card__code">{t.toolCode}</code>
                                )}
                              </div>
                              <p className="mcphub-tool-card__desc" title={t.description}>
                                {t.description || '暂无该工具的详细描述。'}
                              </p>
                              <div
                                className="mcphub-tool-card__footer"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Tooltip title="编辑测试参数">
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="编辑"
                                    onClick={() => setEditingTool(t)}
                                  >
                                    <Pencil size={14} />
                                  </Button>
                                </Tooltip>
                                <Popconfirm
                                  title="确定移除该工具吗？"
                                  okText="确定"
                                  cancelText="取消"
                                  okButtonProps={{ danger: true }}
                                  onConfirm={() => handleDeleteTool(t)}
                                >
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="mcphub-tool-card__del"
                                    aria-label="移除工具"
                                    title="移除工具"
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                </Popconfirm>
                                <Switch
                                  size="small"
                                  checked={t.isActive}
                                  onChange={(v) => handleToggleTool(t, v)}
                                  aria-label="启用开关"
                                  title={t.isActive ? '点击禁用' : '点击启用'}
                                />
                              </div>
                            </Card>
                          ))}
                        </div>
                      ) : (
                        <div className="mcphub-tools-empty">
                          <Empty description="暂无工具，点击「同步 MCP 工具」从服务发现" />
                        </div>
                      )}
                    </Spin>
                  </div>
                ),
              },
            ]}
          />

          <ToolTestModal
            open={editingTool !== null}
            tool={editingTool}
            mcp={mcp}
            onOpenChange={(o) => {
              if (!o) setEditingTool(null)
            }}
            onSave={handleSaveTool}
          />
        </>
      ) : (
        <div className="mcphub-tools-empty">
          <Empty description="未找到相关的 MCP 服务" />
        </div>
      )}
    </div>
  )
}
