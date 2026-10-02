import { useCallback, useEffect, useState } from 'react'
import { Database, RotateCcw, Globe, Plus, Trash2, ShieldAlert, RefreshCw, Pencil, Check, X, Link2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Input, Popconfirm, Alert, Modal, Select, Switch } from '@/components/ui'
import { SettingItem } from './SettingItem'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/file/settings-file'

interface Props {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}

/** 沙箱审计条目（对应 Rust read_sandbox_audit_logs 返回的 JSON Lines）。 */
interface SandboxAuditEntry {
  ts: string
  type: string
  tool?: string
  script?: string
  env?: string
  packages?: string[]
  ok?: boolean
  features?: { net?: string[]; fs_out?: string[]; proc?: string[] }
  policy?: string
}

/** 拉取沙箱审计日志（最新在前，Rust 侧截断 500 条）。 */
async function fetchAuditLogs(): Promise<SandboxAuditEntry[]> {
  try {
    const list = await invoke<SandboxAuditEntry[]>('read_sandbox_audit_logs')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 单条审计 → 一行日志文本（日志形式纯文本，用户偏好）。 */
function formatAuditLine(e: SandboxAuditEntry): string {
  const ts = (e.ts || '').slice(0, 19)
  if (e.type === 'dep_install') {
    return `[${ts}] 依赖安装 · ${e.tool || '-'}/${e.env || '-'} · packages: ${(e.packages || []).join(', ') || '-'} · ok=${String(e.ok ?? '-')}`
  }
  const f = e.features
  return `[${ts}] 脚本特征 · ${e.tool || '-'} · net: ${(f?.net || []).join(',') || '-'} · 外部路径: ${(f?.fs_out || []).join(',') || '-'} · 派生: ${(f?.proc || []).join(',') || '-'}`
}

/** 沙箱守卫状态快照（对应 Rust sandbox_guard_status）。 */
interface SandboxGuardStatus {
  fsGuard: boolean
  netGuard: boolean
  escapeNetOn: boolean
  escapeFsOff: boolean
  /** Bun 侧网络隔离口径：false = 不承诺（观测层兜底） */
  bunNetworkIsolated: boolean
}

async function fetchGuardStatus(): Promise<SandboxGuardStatus | null> {
  try {
    return await invoke<SandboxGuardStatus>('sandbox_guard_status')
  } catch {
    return null
  }
}

/** 已配对设备（对应 Rust mcp_pairing_devices 返回行，无任何凭证字段）。 */
interface PairedDevice {
  id: string
  name: string
  fingerprint: string
  createdAt: number
  lastSeen: number
}

/** 安全中心分区：本地数据存储位置说明 + 沙箱审计回显 + 重置所有设置为默认。 */
export function SecurityPanel({ settings, onChange }: Props) {
  const [auditLogs, setAuditLogs] = useState<SandboxAuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [guardStatus, setGuardStatus] = useState<SandboxGuardStatus | null>(null)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [pairOpen, setPairOpen] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [pairExpiresAt, setPairExpiresAt] = useState(0)
  const [pairLeft, setPairLeft] = useState(0)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)

  const loadDevices = useCallback(() => {
    void invoke<PairedDevice[]>('mcp_pairing_devices')
      .then((list) => setDevices(Array.isArray(list) ? list : []))
      .catch(() => setDevices([]))
  }, [])

  useEffect(() => {
    loadDevices()
  }, [loadDevices])

  // 配对码倒计时
  useEffect(() => {
    if (!pairOpen || !pairExpiresAt) return
    const tick = () => setPairLeft(Math.max(0, Math.ceil((pairExpiresAt - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [pairOpen, pairExpiresAt])

  const startPairing = useCallback(() => {
    void invoke<{ code: string; expiresInMs: number }>('mcp_pairing_start')
      .then((r) => {
        setPairCode(r.code)
        setPairExpiresAt(Date.now() + (r.expiresInMs || 120_000))
        setPairOpen(true)
      })
      .catch(() => setPairOpen(false))
  }, [])

  const revokeDevice = useCallback(
    (id: string) => {
      void invoke<boolean>('mcp_pairing_revoke', { id }).then(loadDevices)
    },
    [loadDevices],
  )

  const renameDevice = useCallback(() => {
    if (!renaming) return
    const name = renaming.value.trim()
    if (!name) return
    void invoke<boolean>('mcp_pairing_rename', { id: renaming.id, name }).then(() => {
      setRenaming(null)
      loadDevices()
    })
  }, [renaming, loadDevices])

  // 拉取审计日志（挂载时一次；刷新按钮手动触发——依赖数组必须为空，
  // 否则 setAuditLoading(true) → 依赖变化 → effect 重跑 → 死循环闪屏（实测踩坑）。
  const loadAudit = useCallback(() => {
    setAuditLoading(true)
    fetchAuditLogs().then((list) => {
      setAuditLogs(list)
      setAuditLoading(false)
    })
  }, [])

  useEffect(() => {
    loadAudit()
  }, [loadAudit])

  useEffect(() => {
    void fetchGuardStatus().then(setGuardStatus)
  }, [])

  return (
    <div className="set-section">
      <h3 className="set-section__title">数据安全</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Database size={15} /></span>本地数据存储位置</span>}
        description="Work Duo 的全部配置、模型、Skill、MCP 与记忆均保存在本机，不上传云端。"
      >
        <div className="set-sec-path">
          <code>{settings.workspacePath}</code>
          <span className="set-sec-path__note">工作空间文件默认存放于此处（可在「系统设置」修改）。</span>
        </div>
      </SettingItem>

      <Alert
        className="set-sec-alert"
        type="info"
        showIcon
        message="数据隔离"
        description="所有密钥（如模型 API Key、MCP 认证配置）仅以本地数据库存储，应用卸载或清除数据后将被一并删除。"
      />

      <h3 className="set-section__title">沙箱安全</h3>

      {guardStatus && (
        <SettingItem
          title={<span className="set-item__title-inline"><span className="set-item__title-icon"><ShieldAlert size={15} /></span>沙箱守卫状态（Python / Bun 运行时）</span>}
          description="用户脚本运行时的隔离边界快照。逃生阀仅在启动前经环境变量设置，改动会在启动日志与沙箱审计中留痕。"
        >
          <div className="set-sec-path">
            <code>
              Python 文件守卫：{guardStatus.fsGuard ? '启用（仅工作空间与系统临时目录可写）' : '已关闭（WD_SANDBOX_FS=off）'}
              <br />
              Python 网络守卫：{guardStatus.netGuard ? '启用（默认离线）' : '已关闭（WD_SANDBOX_NET=on）'}
              <br />
              Bun 网络隔离：{guardStatus.bunNetworkIsolated ? '启用' : '不承诺（观测层兜底）'}
            </code>
            <span className="set-sec-path__note">
              Bun 侧守卫仅覆盖文件系统入口，网络隔离暂不承诺——不受信任脚本请勿用 Bun 运行时执行。
            </span>
          </div>
        </SettingItem>
      )}

      {guardStatus && (guardStatus.escapeNetOn || guardStatus.escapeFsOff) && (
        <Alert
          className="set-sec-alert"
          type="warning"
          showIcon
          message="沙箱逃生阀处于开启状态"
          description={`检测到 ${[
            guardStatus.escapeNetOn ? 'WD_SANDBOX_NET=on（脚本联网放行）' : null,
            guardStatus.escapeFsOff ? 'WD_SANDBOX_FS=off（文件系统有界关闭）' : null,
          ]
            .filter(Boolean)
            .join('；')}。该状态会记入沙箱审计（escape-valve 事件）；仅在你完全信任将运行的脚本时使用。`}
        />
      )}

      <h3 className="set-section__title">对外网络请求</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Globe size={15} /></span>HTTP 请求主机白名单</span>}
        description="发起 HTTP 请求的原生工具仅允许访问列表中的主机（含其子域）。留空表示不限制任何主机；填写后不在列表中的主机将被拒绝。保存后下一次发起请求时生效。"
      >
        <div className="set-hosts">
          {settings.httpAllowedHosts.length === 0 && (
            <div className="set-mem-empty">暂未配置，将允许访问任何主机</div>
          )}
          {settings.httpAllowedHosts.map((host, idx) => (
            <div className="set-hosts__row" key={idx}>
              <Input
                autoComplete="off"
                defaultValue={host}
                placeholder="example.com"
                onBlur={(e) => {
                  const val = e.target.value.trim().toLowerCase()
                  if (val === host) return
                  const next = [...settings.httpAllowedHosts]
                  if (val === '') {
                    next.splice(idx, 1)
                  } else {
                    next[idx] = val
                  }
                  onChange({ httpAllowedHosts: next })
                }}
              />
              <button
                type="button"
                className="set-mem-item__del"
                title="删除"
                onClick={() =>
                  onChange({
                    httpAllowedHosts: settings.httpAllowedHosts.filter((_, i) => i !== idx),
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <Button
            className="set-hosts__add"
            variant="soft"
            size="sm"
            onClick={() => onChange({ httpAllowedHosts: [...settings.httpAllowedHosts, ''] })}
          >
            <Plus size={14} />
            添加主机
          </Button>
        </div>
      </SettingItem>

      <h3 className="set-section__title">沙箱审计</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><ShieldAlert size={15} /></span>沙箱脚本行为审计</span>}
        description="Python / Bun 沙箱脚本的网络访问、工作空间外路径写入、进程派生与依赖安装均记录在案（只观测不拦截）。日志文件位于安装目录 logs/ 下，按天分文件。"
        control={
          <Button variant="soft" size="sm" onClick={loadAudit}>
            <RefreshCw size={14} className={auditLoading ? 'animate-spin' : undefined} />
            刷新
          </Button>
        }
      >
        <div className="set-sec-path">
          {auditLoading && <div className="set-mem-empty">加载中…</div>}
          {!auditLoading && auditLogs.length === 0 && (
            <div className="set-mem-empty">暂无审计记录（沙箱脚本无可疑特征或尚未使用沙箱）</div>
          )}
          {!auditLoading && auditLogs.length > 0 && (
            <div
              style={{
                maxHeight: 280,
                overflowY: 'auto',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--color-bg-muted, rgba(127,127,127,0.08))',
              }}
            >
              {auditLogs.map(formatAuditLine).join('\n')}
              {auditLogs.length > 50 ? '\n… 仅展示最近 50 条（完整内容见 logs/ 下审计文件）' : ''}
            </div>
          )}
        </div>
      </SettingItem>

      <h3 className="set-section__title">内建 MCP Server</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Globe size={15} /></span>监听地址</span>}
        description="默认仅本机访问（127.0.0.1）。切换为 0.0.0.0 后局域网设备可经「设备配对」接入，外部请求必须持有效设备凭证；修改后需重启应用生效。"
      >
        <Select
          value={settings.mcpBindAddr}
          style={{ width: 220 }}
          onChange={(v) => onChange({ mcpBindAddr: String(v) })}
          options={[
            { value: '127.0.0.1', label: '仅本机（127.0.0.1）' },
            { value: '0.0.0.0', label: '局域网（0.0.0.0）' },
          ]}
        />
      </SettingItem>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><ShieldAlert size={15} /></span>本机信任</span>}
        description="开启时，本机发起的无凭证请求放行（既有本机编码工具零改造；浏览器网页除外——带 Origin 的无凭证请求一律拒绝）。关闭后本机调用也必须携带设备凭证。"
        control={
          <Switch checked={settings.mcpLocalTrust} onChange={(v) => onChange({ mcpLocalTrust: v })} />
        }
      />

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Link2 size={15} /></span>已配对设备</span>}
        description="外接设备凭配对获得的专属令牌访问内建 MCP Server（服务端只存令牌哈希，吊销即时生效）。「本机默认」设备的令牌文件位于应用数据目录 mcp-token.txt。"
        control={
          <Button variant="soft" size="sm" onClick={startPairing}>
            <Plus size={14} />
            配对新设备
          </Button>
        }
      >
        <div className="set-hosts">
          {devices.length === 0 && <div className="set-mem-empty">暂无已配对设备</div>}
          {devices.map((d) => (
            <div className="set-hosts__row" key={d.id}>
              {renaming?.id === d.id ? (
                <>
                  <Input
                    autoFocus
                    defaultValue={renaming.value}
                    onChange={(e) => setRenaming({ id: d.id, value: e.target.value })}
                    onPressEnter={renameDevice}
                  />
                  <button type="button" className="set-mem-item__del" title="确认" onClick={renameDevice}>
                    <Check size={15} />
                  </button>
                  <button
                    type="button"
                    className="set-mem-item__del"
                    title="取消"
                    onClick={() => setRenaming(null)}
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <>
                  <span className="set-sec-path" style={{ flex: 1, minWidth: 0 }}>
                    <code>
                      {d.name}（指纹 {d.fingerprint}）· 最近活跃{' '}
                      {d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '从未'}
                    </code>
                  </span>
                  <button
                    type="button"
                    className="set-mem-item__del"
                    title="重命名"
                    onClick={() => setRenaming({ id: d.id, value: d.name })}
                  >
                    <Pencil size={15} />
                  </button>
                  <Popconfirm
                    title={`吊销设备「${d.name}」？`}
                    description="吊销后该设备令牌立即失效，需重新配对才能访问。"
                    okText="吊销"
                    cancelText="取消"
                    onConfirm={() => revokeDevice(d.id)}
                  >
                    <button type="button" className="set-mem-item__del" title="吊销">
                      <Trash2 size={15} />
                    </button>
                  </Popconfirm>
                </>
              )}
            </div>
          ))}
        </div>
      </SettingItem>

      <Modal
        open={pairOpen}
        title="配对新设备"
        width={520}
        centered
        footer={null}
        onOpenChange={(o) => {
          if (!o) {
            setPairOpen(false)
            loadDevices()
          }
        }}
        onCancel={() => {
          setPairOpen(false)
          loadDevices()
        }}
      >
        <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
          <div style={{ fontSize: 40, letterSpacing: 12, fontWeight: 700, fontFamily: 'ui-monospace, Consolas, monospace' }}>
            {pairCode}
          </div>
          <div style={{ color: 'var(--color-foreground-muted)', marginTop: 8 }}>
            剩余 {Math.floor(pairLeft / 60)}:{String(pairLeft % 60).padStart(2, '0')}
            （过期后请重新发起）
          </div>
        </div>
        <Alert
          type="info"
          showIcon
          message="在新设备上执行配对请求"
          description={
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {`POST http://<本机IP>:18755/pair
Content-Type: application/json

{"name": "设备名", "code": "${pairCode}"}`}
            </pre>
          }
        />
        <div style={{ color: 'var(--color-foreground-muted)', fontSize: 12, marginTop: 12 }}>
          配对成功后设备获得专属令牌（仅此一次返回明文），在客户端 mcpServers 配置中以
          <code> headers: {'{ Authorization: "Bearer <token>" }'}</code> 携带访问。配对成功后本弹窗可直接关闭。
        </div>
      </Modal>

      <h3 className="set-section__title">恢复</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><RotateCcw size={15} /></span>重置所有设置</span>}
        description="将所有设置项恢复为出厂默认值（不影响模型、Skill、MCP 等业务数据）。"
        control={
          <Popconfirm
            title="确认重置所有设置？"
            description="此操作仅重置设置项，业务数据不受影响。"
            okText="重置"
            cancelText="取消"
            onConfirm={() => onChange({ ...DEFAULT_SETTINGS })}
          >
            <Button variant="soft" size="sm">
              <RotateCcw size={14} />
              重置为默认
            </Button>
          </Popconfirm>
        }
      />
    </div>
  )
}
