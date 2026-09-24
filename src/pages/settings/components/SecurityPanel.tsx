import { useEffect, useState } from 'react'
import { Database, RotateCcw, Globe, Plus, Trash2, ShieldAlert, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Input } from '@/components/ui'
import { Popconfirm, Alert } from 'antd'
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

/** 安全中心分区：本地数据存储位置说明 + 沙箱审计回显 + 重置所有设置为默认。 */
export function SecurityPanel({ settings, onChange }: Props) {
  const [auditLogs, setAuditLogs] = useState<SandboxAuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)

  // 挂载时拉一次；「刷新」按钮通过置 auditLoading 重新触发。
  useEffect(() => {
    let alive = true
    setAuditLoading(true)
    fetchAuditLogs().then((list) => {
      if (alive) {
        setAuditLogs(list)
        setAuditLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [auditLoading])

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
          <Button variant="soft" size="sm" onClick={() => setAuditLoading(true)}>
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
            <div className="set-hosts">
              {auditLogs.slice(0, 50).map((e, idx) => {
                const isDep = e.type === 'dep_install'
                return (
                  <div className="set-hosts__row" key={idx} style={{ alignItems: 'flex-start' }}>
                    <code style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {`[${(e.ts || '').slice(0, 19)}] ${isDep ? '依赖安装' : '脚本特征'} · ${e.tool || '-'}${isDep ? ` · ${e.env || '-'}` : ''}\n`}
                      {isDep
                        ? `  packages: ${(e.packages || []).join(', ') || '-'} · ok=${String(e.ok ?? '-')}`
                        : (e.features
                            ? `  net: ${(e.features.net || []).join(',') || '-'} | 外部路径: ${(e.features.fs_out || []).join(',') || '-'} | 派生: ${(e.features.proc || []).join(',') || '-'}`
                            : '')}
                    </code>
                  </div>
                )
              })}
              {auditLogs.length > 50 && (
                <div className="set-mem-empty">仅展示最近 50 条（完整内容见 logs/ 下审计文件）</div>
              )}
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
