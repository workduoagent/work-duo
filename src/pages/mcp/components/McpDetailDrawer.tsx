/**
 * MCP 服务详情抽屉（只读 + 工具 Tab + 连通性测试 / 同步）。
 * - 基础信息 / 认证配置以 Descriptions 展示；
 * - 工具 Tab 列出该服务下发现的工具（mcp_tool_definition）；
 * - 「测试连接 / 同步工具」执行真实连通性测试，发现工具后写回库并刷新状态。
 * 本抽屉仅做「接入」侧查看与同步，不提供工具构建 / 编辑源码能力。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Drawer,
  Descriptions,
  Tag,
  Typography,
  Divider,
  Empty,
  Space,
  Button as AntButton,
  Spin,
  Tabs,
  Tooltip,
  Popconfirm,
  message,
} from 'antd'
import {
  Calendar,
  Pencil,
  Plug,
  RefreshCw,
  Trash2,
  CheckCircle2,
  XCircle,
  CircleDashed,
} from 'lucide-react'
import { Button } from '@/components/ui'
import {
  listMcpTools,
  syncMcpTools,
  updateMcpStatus,
  deleteMcpTool,
} from '@/core/mapper/mcp-mapper'
import { testMcpConnection } from '@/core/mapper/mcp-connection'
import {
  getMcpScenarioLabel,
  getMcpProtocolLabel,
  getMcpAuthLabel,
  getMcpStatusLabel,
  type McpInfo,
  type McpToolDefinition,
} from '@/core/file/mcp-file'
import type { McpStatus } from '@/types/core'

const { Title, Text } = Typography

export interface McpDetailDrawerProps {
  open: boolean
  mcp: McpInfo | null
  onClose: () => void
  onEdit: (mcp: McpInfo) => void
  /** 状态 / 工具变化后通知父页面刷新列表 */
  onChanged: () => void
}

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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

export function McpDetailDrawer({
  open,
  mcp,
  onClose,
  onEdit,
  onChanged,
}: McpDetailDrawerProps) {
  const [tools, setTools] = useState<McpToolDefinition[]>([])
  const [loadingTools, setLoadingTools] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const loadTools = useCallback(
    async (mcpId: string) => {
      setLoadingTools(true)
      try {
        setTools(await listMcpTools(mcpId))
      } finally {
        setLoadingTools(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (open && mcp) void loadTools(mcp.id)
    else setTools([])
  }, [open, mcp, loadTools])

  async function handleSync() {
    if (!mcp) return
    setSyncing(true)
    try {
      const res = await testMcpConnection(mcp)
      if (res.ok) {
        const mapped: McpToolDefinition[] = res.tools.map((t) => ({ ...t, mcpId: mcp.id }))
        await syncMcpTools(mcp.id, mapped)
        setTools(mapped)
      }
      await updateMcpStatus(mcp.id, res.status)
      onChanged()
      if (res.ok) {
        message.success(
          `连接成功，耗时 ${res.latencyMs}ms，已同步 ${res.tools.length} 个工具`,
        )
      } else {
        message.error(`连接失败：${res.error}`)
      }
    } finally {
      setSyncing(false)
    }
  }

  async function handleDeleteTool(tool: McpToolDefinition) {
    await deleteMcpTool(tool.id)
    if (mcp) await loadTools(mcp.id)
    message.success('工具已移除')
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={680}
      title={
        <Space>
          <span>MCP 服务详情</span>
          {mcp?.mcpName && (
            <Text type="secondary" style={{ fontSize: 13, fontFamily: 'monospace' }}>
              {mcp.mcpName}
            </Text>
          )}
        </Space>
      }
      extra={
        mcp && (
          <Space>
            <Button onClick={() => onEdit(mcp)}>
              <Pencil size={14} />
              编辑
            </Button>
            <Button variant="soft" onClick={handleSync} loading={syncing}>
              <RefreshCw size={14} />
              测试 / 同步
            </Button>
          </Space>
        )
      }
    >
      {!mcp ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Empty description="未选择服务" />
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div className="mcphub-detail__logo">
              <Plug size={22} />
            </div>
            <div>
              <Title level={4} style={{ margin: 0 }}>
                {mcp.aliasName || mcp.mcpName}
              </Title>
              <Space size={6} style={{ marginTop: 6 }} wrap>
                <Tag color="blue">{getMcpProtocolLabel(mcp.protocolType)}</Tag>
                <Tag>{getMcpScenarioLabel(mcp.scenario)}</Tag>
                <StatusTag status={mcp.status} />
                {!mcp.isActive && <Tag color="default">已禁用</Tag>}
              </Space>
            </div>
          </div>

          <Tabs
            defaultActiveKey="detail"
            items={[
              {
                key: 'detail',
                label: '服务详情',
                children: (
                  <div>
                    <Descriptions column={2} size="small" bordered>
                      <Descriptions.Item label="服务别名">
                        {mcp.aliasName || '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="服务标识">
                        <code style={{ fontFamily: 'monospace' }}>{mcp.mcpName}</code>
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
                        <Text copyable style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {mcp.endpointUrl || '-'}
                        </Text>
                      </Descriptions.Item>
                      <Descriptions.Item label="服务描述" span={2}>
                        {mcp.description || <Text type="secondary">暂无描述</Text>}
                      </Descriptions.Item>
                      <Descriptions.Item label="创建时间">
                        <Space size={4}>
                          <Calendar size={13} />
                          {formatDate(mcp.createdAt)}
                        </Space>
                      </Descriptions.Item>
                      <Descriptions.Item label="更新时间">
                        <Space size={4}>
                          <Calendar size={13} />
                          {formatDate(mcp.updatedAt)}
                        </Space>
                      </Descriptions.Item>
                    </Descriptions>

                    {(mcp.authConfig || mcp.headers) && (
                      <>
                        <Divider>认证 / 请求头</Divider>
                        {mcp.authConfig && (
                          <div className="mcphub-detail__config">
                            <div className="mcphub-detail__config-label">authConfig</div>
                            <pre className="mcphub-detail__code">
                              {JSON.stringify(mcp.authConfig, null, 2)}
                            </pre>
                          </div>
                        )}
                        {mcp.headers && (
                          <div className="mcphub-detail__config">
                            <div className="mcphub-detail__config-label">headers</div>
                            <pre className="mcphub-detail__code">
                              {JSON.stringify(mcp.headers, null, 2)}
                            </pre>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ),
              },
              {
                key: 'tools',
                label: `工具 (${tools.length})`,
                children: (
                  <div>
                    <div className="mcphub-detail__tools-bar">
                      <Button variant="soft" size="sm" onClick={handleSync} loading={syncing}>
                        <RefreshCw size={14} />
                        同步工具
                      </Button>
                    </div>
                    <Spin spinning={loadingTools}>
                      {tools.length > 0 ? (
                        <div className="mcphub-tools">
                          {tools.map((t) => (
                            <div
                              key={t.id}
                              className={`mcphub-tool-card ${
                                !t.isActive ? 'mcphub-tool-card--disabled' : ''
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
                                <code className="mcphub-tool-card__code">
                                  {t.toolCode}
                                </code>
                              </div>
                              <p className="mcphub-tool-card__desc">
                                {t.description || '暂无该工具的详细描述。'}
                              </p>
                              <div className="mcphub-tool-card__footer">
                                <Tooltip title="移除该工具（不影响服务端）">
                                  <Popconfirm
                                    title="确定移除该工具吗？"
                                    okText="确定"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                    onConfirm={() => handleDeleteTool(t)}
                                  >
                                    <AntButton type="text" danger size="small" icon={<Trash2 size={14} />} />
                                  </Popconfirm>
                                </Tooltip>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mcphub-tools-empty">
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="暂无工具，点击「同步工具」从服务发现"
                          />
                        </div>
                      )}
                    </Spin>
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}
    </Drawer>
  )
}
