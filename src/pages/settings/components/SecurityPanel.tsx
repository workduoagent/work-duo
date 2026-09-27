import { useCallback, useEffect, useState } from 'react'
import { Database, RotateCcw, Globe, Plus, Trash2, ShieldAlert, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Input, Popconfirm, Alert } from '@/components/ui'
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

/** 安全中心分区：本地数据存储位置说明 + 沙箱审计回显 + 重置所有设置为默认。 */
export function SecurityPanel({ settings, onChange }: Props) {
  const [auditLogs, setAuditLogs] = useState<SandboxAuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [guardStatus, setGuardStatus] = useState<SandboxGuardStatus | null>(null)

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
