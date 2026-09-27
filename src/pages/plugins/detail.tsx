/**
 * 插件详情页（路由 /plugin-hub/:id）。布局对齐 mcp/detail.tsx：
 *  - 顶部返回导航 + 头部（Logo / 名称 / 运行状态 / 描述）+ 右侧「试跑」动作；
 *  - 选项卡：插件详情（Descriptions）/ 脚本代码（只读 Monaco，language 随 runtime）/
 *    执行日志（plugin_run_log 最近 50 条，写入在 Rust 侧，此处只读）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Puzzle,
  Trash2,
  Play,
  Calendar,
  CheckCircle2,
  XCircle,
  CircleDashed,
} from 'lucide-react'
import { useNotify } from '@/components/ui/notify'
import { Button, Tag, Descriptions, Tabs, Empty, Spin, Popconfirm } from '@/components/ui'
import {
  getPlugin,
  listPluginRunLogs,
  deletePlugin,
} from '@/core/mapper/plugin-mapper'
import {
  PLUGIN_RUNTIME_OPTIONS,
  type UserPluginTool,
  type PluginRunLog,
} from '@/core/file/plugin-file'
import { MonacoJsonEditor } from '@/components/code-editor'
import { PluginTestModal } from './components/PluginTestModal'
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

function formatDateTime(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${formatDate(iso)} ${hh}:${mm}`
}

/** 运行状态徽标（对齐 detail 页 StatusTag 风格）。 */
function RunStatusTag({ status }: { status: UserPluginTool['lastRunStatus'] }) {
  if (status === 'success')
    return (
      <Tag color="success">
        <CheckCircle2 size={12} /> 最近成功
      </Tag>
    )
  if (status === 'failed')
    return (
      <Tag color="error">
        <XCircle size={12} /> 最近失败
      </Tag>
    )
  return (
    <Tag>
      <CircleDashed size={12} /> 未测试
    </Tag>
  )
}

export default function PluginDetailPage() {
  const { message } = useNotify()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [plugin, setPlugin] = useState<UserPluginTool | null>(null)
  const [logs, setLogs] = useState<PluginRunLog[]>([])
  const [testOpen, setTestOpen] = useState(false)

  const reload = useCallback(async (pid: string) => {
    const [record, runLogs] = await Promise.all([
      getPlugin(pid),
      listPluginRunLogs(pid, 50),
    ])
    setPlugin(record ?? null)
    setLogs(runLogs)
  }, [])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    void reload(id).finally(() => setLoading(false))
  }, [id, reload])

  async function handleDelete() {
    if (!plugin) return
    await deletePlugin(plugin.id)
    message.success('插件已移除')
    navigate('/plugin-hub')
  }

  if (loading) {
    return (
      <div className="pluginhub-detail-page">
        <div className="pluginhub-detail-page__loading">
          <Spin size="large" tip="正在加载插件详情..." />
        </div>
      </div>
    )
  }

  return (
    <div className="pluginhub-detail-page">
      <div className="pluginhub-detail-page__nav">
        <Button variant="ghost" size="sm" onClick={() => navigate('/plugin-hub')}>
          <ArrowLeft size={16} />
          返回插件列表
        </Button>
      </div>

      {plugin ? (
        <>
          <div className="pluginhub-detail-page__header">
            <div className="pluginhub-detail-page__header-logo">
              <Puzzle size={26} />
            </div>
            <div className="pluginhub-detail-page__header-info">
              <div className="pluginhub-detail-page__title-row">
                <h1 className="pluginhub-detail-page__title">{plugin.name}</h1>
                <RunStatusTag status={plugin.lastRunStatus} />
                {!plugin.enabled && <Tag color="default">已禁用</Tag>}
              </div>
              <p className="pluginhub-detail-page__desc">
                {plugin.description || '暂无详细描述'}
              </p>
            </div>
            <div className="pluginhub-detail-page__header-actions">
              <Button size="sm" onClick={() => setTestOpen(true)}>
                <Play size={14} />
                试跑
              </Button>
              <Popconfirm
                title="确定移除该插件吗？"
                okText="确定"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={handleDelete}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pluginhub-detail-page__del"
                  aria-label="删除"
                  title="删除"
                >
                  <Trash2 size={16} />
                </Button>
              </Popconfirm>
            </div>
          </div>

          <Tabs
            defaultActiveKey="detail"
            items={[
              {
                key: 'detail',
                label: '插件详情',
                children: (
                  <div className="pluginhub-detail-page__section">
                    <Descriptions column={2} size="middle" bordered>
                      <Descriptions.Item label="插件名称">{plugin.name}</Descriptions.Item>
                      <Descriptions.Item label="工具名">
                        <code className="pluginhub-detail-page__code">
                          custom__{plugin.identifier}
                        </code>
                      </Descriptions.Item>
                      <Descriptions.Item label="运行时">
                        <Tag color="blue">
                          {PLUGIN_RUNTIME_OPTIONS.find((o) => o.value === plugin.runtime)
                            ?.label ?? plugin.runtime}
                        </Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="超时">
                        {plugin.timeoutSec}s（硬上限 300）
                      </Descriptions.Item>
                      <Descriptions.Item label="使用场景">
                        {plugin.scenario || '未分类'}
                      </Descriptions.Item>
                      <Descriptions.Item label="最近运行">
                        <RunStatusTag status={plugin.lastRunStatus} />
                        {plugin.lastRunAt ? ` ${formatDateTime(plugin.lastRunAt)}` : ''}
                      </Descriptions.Item>
                      <Descriptions.Item label="声明依赖" span={2}>
                        {plugin.dependencies.length > 0 ? (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {plugin.dependencies.map((d) => (
                              <Tag key={d}>{d}</Tag>
                            ))}
                          </div>
                        ) : (
                          '（空 = 仅标准库 / 零 npm 包）'
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="插件描述" span={2}>
                        {plugin.description || '暂无描述'}
                      </Descriptions.Item>
                      <Descriptions.Item label="创建时间">
                        <Calendar size={13} /> {formatDate(plugin.createdAt)}
                      </Descriptions.Item>
                      <Descriptions.Item label="更新时间">
                        <Calendar size={13} /> {formatDate(plugin.updatedAt)}
                      </Descriptions.Item>
                    </Descriptions>

                    <div className="pluginhub-detail-page__configs">
                      <div className="pluginhub-detail__config">
                        <div className="pluginhub-detail__config-label">
                          参数 Schema（OpenAI function parameters）
                        </div>
                        <MonacoJsonEditor
                          value={plugin.parametersSchema}
                          readOnly
                          height={220}
                        />
                      </div>
                      {plugin.sampleParams && (
                        <div className="pluginhub-detail__config">
                          <div className="pluginhub-detail__config-label">示例参数</div>
                          <MonacoJsonEditor
                            value={plugin.sampleParams}
                            readOnly
                            height={180}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: 'script',
                label: '脚本代码',
                children: (
                  <div className="pluginhub-detail-page__section">
                    <MonacoJsonEditor
                      mode="code"
                      language={plugin.runtime === 'python' ? 'python' : 'typescript'}
                      value={plugin.scriptContent}
                      readOnly
                      height={520}
                    />
                  </div>
                ),
              },
              {
                key: 'logs',
                label: `执行日志 (${logs.length})`,
                children: (
                  <div className="pluginhub-detail-page__section">
                    {logs.length > 0 ? (
                      <div className="pluginhub-logs">
                        {logs.map((log) => (
                          <div
                            key={log.id}
                            className={`pluginhub-log-item${
                              log.ok ? '' : ' pluginhub-log-item--fail'
                            }`}
                          >
                            <div className="pluginhub-log-item__head">
                              {log.ok ? (
                                <Tag color="success">成功</Tag>
                              ) : (
                                <Tag color="error">
                                  {log.errorType || '失败'}
                                  {log.missingPackage ? `：${log.missingPackage}` : ''}
                                </Tag>
                              )}
                              <span className="pluginhub-log-item__meta">
                                {log.source === 'test' ? '试跑' : 'Agent 调用'} ·{' '}
                                {log.durationMs ?? '-'}ms · 退出码 {log.exitCode ?? '-'} ·{' '}
                                {formatDateTime(log.createdAt)}
                              </span>
                            </div>
                            <MonacoJsonEditor
                              mode="code"
                              language="text"
                              value={
                                (log.ok
                                  ? log.stdout || '（无输出）'
                                  : log.stderr || '（无 stderr）') || '（空）'
                              }
                              readOnly
                              height={120}
                              showToolbar={false}
                            />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="pluginhub-logs-empty">
                        <Empty description="暂无执行日志，点上方「试跑」跑一次" />
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />

          <PluginTestModal
            open={testOpen}
            plugin={plugin}
            onOpenChange={setTestOpen}
            onTested={() => id && void reload(id)}
          />
        </>
      ) : (
        <div className="pluginhub-logs-empty">
          <Empty description="未找到相关插件" />
        </div>
      )}
    </div>
  )
}
