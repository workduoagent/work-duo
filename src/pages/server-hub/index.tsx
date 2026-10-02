/**
 * 路由页面「服务器」：服务器托管管理面（设计稿 .workspace/.design/server-hosting-design.md）。
 *
 * 卡片风格对齐 skill-hub / mcp-hub（header + 卡片网格）；凭证只展示指纹 hint，
 * 明文仅在新填 / 重填时经内存一次性传给 Rust 加密入库。
 * 数据持久化走 src/core/mapper/server-mapper.ts（Rust server_host_* 命令）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  Server as ServerIcon,
  ShieldCheck,
  KeyRound,
  PlugZap,
} from 'lucide-react'
import { Button, Card, Input, Modal, Select, Switch, InputNumber, Empty, Popconfirm, Spin, Tag, Tooltip } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  listServerHosts,
  saveServerHost,
  deleteServerHost,
  testServerConnection,
  parseLines,
} from '@/core/mapper/server-mapper'
import type { ServerHost, ServerHostInput, ServerTestReport } from '@/types/core'
import './index.scss'

type AuthType = ServerHost['authType']

const AUTH_LABEL: Record<AuthType, string> = {
  password: '密码',
  private_key: '私钥',
  private_key_passphrase: '私钥 + 口令',
}

const SUDO_LABEL: Record<ServerHost['sudoMode'], string> = {
  none: '禁止提权',
  sudo_cmd: '白名单提权',
  sudo_full: '允许提权',
}

/** 表单态（文本域字段以换行分隔的原始文本承载，保存时 parseLines）。 */
interface FormState {
  id: string
  name: string
  host: string
  port: number
  user: string
  authType: AuthType
  secret: string
  keyPassphrase: string
  pathAllowText: string
  pathDenyText: string
  localAllowText: string
  defaultCwd: string
  loginNote: string
  sudoMode: ServerHost['sudoMode']
  sudoUser: string
  hostAutoMode: ServerHost['hostAutoMode']
  allowGrantMemory: boolean
  l3Policy: ServerHost['l3Policy']
  grantBindAsUser: boolean
  tagsText: string
  note: string
  resetKnownKey: boolean
}

function emptyForm(): FormState {
  return {
    id: `srv_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: '',
    host: '',
    port: 22,
    user: '',
    authType: 'password',
    secret: '',
    keyPassphrase: '',
    pathAllowText: '',
    pathDenyText: '/etc\n/root/.ssh\n/boot\n/proc\n/sys\n/dev',
    localAllowText: '',
    defaultCwd: '',
    loginNote: '',
    sudoMode: 'none',
    sudoUser: 'root',
    hostAutoMode: 'strict',
    allowGrantMemory: false,
    l3Policy: 'single_shot',
    grantBindAsUser: true,
    tagsText: '',
    note: '',
    resetKnownKey: false,
  }
}

function formFromHost(h: ServerHost): FormState {
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    user: h.user,
    authType: h.authType,
    secret: '',
    keyPassphrase: '',
    pathAllowText: h.pathAllow.join('\n'),
    pathDenyText: h.pathDeny.join('\n'),
    localAllowText: h.localPathAllow.join('\n'),
    defaultCwd: h.defaultCwd ?? '',
    loginNote: h.loginNote ?? '',
    sudoMode: h.sudoMode,
    sudoUser: h.sudoUser,
    hostAutoMode: h.hostAutoMode,
    allowGrantMemory: h.allowGrantMemory,
    l3Policy: h.l3Policy,
    grantBindAsUser: h.grantBindAsUser,
    tagsText: h.tags.join(', '),
    note: h.note ?? '',
    resetKnownKey: false,
  }
}

function formToInput(f: FormState): ServerHostInput {
  return {
    id: f.id,
    name: f.name.trim(),
    host: f.host.trim(),
    port: f.port,
    user: f.user.trim(),
    authType: f.authType,
    secret: f.secret.trim() ? f.secret : undefined,
    keyPassphrase: f.authType === 'private_key_passphrase' && f.keyPassphrase ? f.keyPassphrase : undefined,
    pathAllow: parseLines(f.pathAllowText),
    pathDeny: parseLines(f.pathDenyText),
    localPathAllow: parseLines(f.localAllowText),
    defaultCwd: f.defaultCwd.trim() || undefined,
    loginNote: f.loginNote.trim() || undefined,
    sudoMode: f.sudoMode,
    sudoUser: f.sudoUser.trim() || 'root',
    hostAutoMode: f.hostAutoMode,
    allowGrantMemory: f.allowGrantMemory,
    l3Policy: f.l3Policy,
    grantBindAsUser: f.grantBindAsUser,
    tags: f.tagsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    note: f.note.trim() || undefined,
    resetKnownKey: f.resetKnownKey,
  }
}

export default function ServerHubPage() {
  const { message } = useNotify()
  const [list, setList] = useState<ServerHost[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testReport, setTestReport] = useState<ServerTestReport | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setList(await listServerHosts())
    } catch (e) {
      message.error(`读取服务器列表失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        `${s.user}@${s.host}`.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }, [list, search])

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setTestReport(null)
    setFormOpen(true)
  }

  const openEdit = (h: ServerHost) => {
    setEditingId(h.id)
    setForm(formFromHost(h))
    setTestReport(null)
    setFormOpen(true)
  }

  /** 表单校验：新建（或换认证方式）必须重填凭证；编辑未重填 = 保留旧凭证。 */
  const validate = (): string | null => {
    if (!form.name.trim()) return '名称不能为空'
    if (!form.host.trim()) return '主机地址不能为空'
    if (!form.user.trim()) return '登录用户不能为空'
    if (!form.port || form.port < 1 || form.port > 65535) return '端口需在 1~65535'
    if (form.authType === 'private_key_passphrase' && form.secret.trim() && !form.keyPassphrase) {
      return '带口令私钥需要填写口令'
    }
    const hadCredential = editingId !== null && list.some((h) => h.id === editingId && h.credentialId)
    if (!hadCredential && !form.secret.trim()) return '请填写密码或私钥'
    return null
  }

  const handleSave = useCallback(async () => {
    const err = validate()
    if (err) {
      message.warning(err)
      return
    }
    setSaving(true)
    try {
      await saveServerHost(formToInput(form))
      message.success('已保存')
      setFormOpen(false)
      await refresh()
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, editingId, list, message, refresh])

  const handleTest = useCallback(async () => {
    const err = validate()
    if (err) {
      message.warning(err)
      return
    }
    setTesting(true)
    setTestReport(null)
    try {
      const report = await testServerConnection(formToInput(form))
      setTestReport(report)
      if (report.ok) {
        message.success(`连接成功：${report.loginUser ?? ''}（${report.latencyMs}ms）`)
      } else {
        message.error(report.error ?? '连接失败')
      }
    } catch (e) {
      message.error(`测试失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTesting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, editingId, list, message])

  const handleDelete = useCallback(
    async (h: ServerHost) => {
      try {
        await deleteServerHost(h.id)
        message.success('已删除')
        await refresh()
      } catch (e) {
        message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [message, refresh],
  )

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="server-hub">
      <header className="server-hub__header">
        <div>
          <h2>服务器</h2>
          <p className="server-hub__sub">为智能体提供远程 Linux 运维能力（终端 + 文件同步），凭证加密保管、操作全程审批与审计</p>
        </div>
        <div className="server-hub__actions">
          <Input
            prefix={<Search size={14} />}
            placeholder="搜索名称 / 地址 / 标签"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
            style={{ width: 220 }}
          />
          <Button variant="solid" onClick={openCreate}>
            <Plus size={14} /> 新建服务器
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="server-hub__loading">
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={search ? '没有匹配的服务器' : '还没有服务器，点击右上角「新建服务器」开始'} />
      ) : (
        <div className="server-hub__grid">
          {filtered.map((h) => (
            <Card key={h.id} className="server-hub__card">
              <div className="server-hub__card-head">
                <span className="server-hub__card-icon">
                  <ServerIcon size={18} />
                </span>
                <div className="server-hub__card-title">
                  <span className="server-hub__card-name">{h.name}</span>
                  <span className="server-hub__card-addr">
                    {h.user}@{h.host}:{h.port}
                  </span>
                </div>
                <div className="server-hub__card-ops">
                  <Tooltip title="编辑">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(h)}>
                      <Pencil size={14} />
                    </Button>
                  </Tooltip>
                  <Popconfirm title={`删除「${h.name}」？凭证与绑定将一并清理`} onConfirm={() => void handleDelete(h)}>
                    <Button variant="ghost" size="sm" danger>
                      <Trash2 size={14} />
                    </Button>
                  </Popconfirm>
                </div>
              </div>
              <div className="server-hub__card-meta">
                <Tag icon={<KeyRound size={11} />}>{AUTH_LABEL[h.authType]}</Tag>
                {h.credentialHint && <Tag>{h.credentialHint}</Tag>}
                <Tag icon={<ShieldCheck size={11} />} color={h.sudoMode === 'none' ? 'default' : 'gold'}>
                  {SUDO_LABEL[h.sudoMode]}
                </Tag>
                {h.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
              {h.pathAllow.length > 0 && (
                <div className="server-hub__card-paths">
                  白名单：{h.pathAllow.join('、')}
                </div>
              )}
              <div className="server-hub__card-foot">
                <span>更新于 {new Date(h.updatedAt).toLocaleString()}</span>
                <span className="server-hub__card-id">{h.id}</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={formOpen}
        title={editingId ? '编辑服务器' : '新建服务器'}
        width={720}
        onOpenChange={(o) => !o && setFormOpen(false)}
        footer={
          <div className="server-hub__form-footer">
            <div className="server-hub__form-footer-left">
              <Button variant="ghost" onClick={() => void handleTest()} disabled={testing}>
                <PlugZap size={14} /> {testing ? '测试中…' : '测试连接'}
              </Button>
            </div>
            <div>
              <Button onClick={() => setFormOpen(false)}>取消</Button>
              <Button variant="solid" onClick={() => void handleSave()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="server-hub__form">
          <section>
            <h4>连接信息</h4>
            <div className="server-hub__form-grid">
              <label>
                名称 *
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如 生产 Web-01" autoComplete="off" />
              </label>
              <label>
                主机 *
                <Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="IP 或域名" autoComplete="off" />
              </label>
              <label>
                端口
                <InputNumber min={1} max={65535} value={form.port} onChange={(v) => set('port', Number(v) || 22)} />
              </label>
              <label>
                登录用户 *
                <Input value={form.user} onChange={(e) => set('user', e.target.value)} placeholder="如 deploy（不必是 root）" autoComplete="off" />
              </label>
            </div>
          </section>

          <section>
            <h4>凭证</h4>
            <div className="server-hub__form-grid">
              <label>
                认证方式
                <Select
                  value={form.authType}
                  onChange={(v) => set('authType', v as AuthType)}
                  options={[
                    { value: 'password', label: '密码' },
                    { value: 'private_key', label: '私钥' },
                    { value: 'private_key_passphrase', label: '私钥 + 口令' },
                  ]}
                />
              </label>
              {editingId && (
                <label>
                  已存凭证
                  <Input value={list.find((h) => h.id === editingId)?.credentialHint ?? '—'} disabled />
                </label>
              )}
            </div>
            {form.authType === 'password' ? (
              <label className="server-hub__form-wide">
                {editingId ? '密码（留空 = 保留已存）' : '密码 *'}
                <Input.Password
                  value={form.secret}
                  onChange={(e) => set('secret', e.target.value)}
                  placeholder="服务器登录密码"
                  autoComplete="new-password"
                />
              </label>
            ) : (
              <>
                <label className="server-hub__form-wide">
                  {editingId ? `私钥 PEM（留空 = 保留已存）${form.authType === 'private_key_passphrase' ? '，含口令则需填口令' : ''}` : '私钥 PEM *'}
                  <Input.TextArea
                    value={form.secret}
                    onChange={(e) => set('secret', e.target.value)}
                    rows={5}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    style={{ fontFamily: 'monospace' }}
                  />
                </label>
                {form.authType === 'private_key_passphrase' && (
                  <label className="server-hub__form-wide">
                    密钥口令
                    <Input.Password
                      value={form.keyPassphrase}
                      onChange={(e) => set('keyPassphrase', e.target.value)}
                      placeholder="私钥口令（无口令可留空）"
                      autoComplete="new-password"
                    />
                  </label>
                )}
              </>
            )}
          </section>

          <section>
            <h4>路径与提权策略</h4>
            <div className="server-hub__form-grid">
              <label>
                远端路径白名单（一行一条，空 = 不限制·不推荐）
                <Input.TextArea value={form.pathAllowText} onChange={(e) => set('pathAllowText', e.target.value)} rows={3} placeholder={'/var/www\n/data/app'} />
              </label>
              <label>
                远端路径黑名单（优先于白名单）
                <Input.TextArea value={form.pathDenyText} onChange={(e) => set('pathDenyText', e.target.value)} rows={3} />
              </label>
              <label>
                默认工作目录（须在白名单内）
                <Input value={form.defaultCwd} onChange={(e) => set('defaultCwd', e.target.value)} placeholder="/var/www/app" autoComplete="off" />
              </label>
              <label>
                提权策略
                <Select
                  value={form.sudoMode}
                  onChange={(v) => set('sudoMode', v as ServerHost['sudoMode'])}
                  options={[
                    { value: 'none', label: '禁止提权（none）' },
                    { value: 'sudo_cmd', label: '白名单提权（sudo_cmd）' },
                    { value: 'sudo_full', label: '允许提权（sudo_full）' },
                  ]}
                />
              </label>
              {form.sudoMode !== 'none' && (
                <label>
                  提权目标用户
                  <Input value={form.sudoUser} onChange={(e) => set('sudoUser', e.target.value)} autoComplete="off" />
                </label>
              )}
              <label>
                自动执行模式
                <Select
                  value={form.hostAutoMode}
                  onChange={(v) => set('hostAutoMode', v as ServerHost['hostAutoMode'])}
                  options={[
                    { value: 'strict', label: '严格（默认弹窗）' },
                    { value: 'balanced', label: '均衡' },
                    { value: 'auto', label: '自动（仅 L0）' },
                  ]}
                />
              </label>
              <label>
                L3 策略
                <Select
                  value={form.l3Policy}
                  onChange={(v) => set('l3Policy', v as ServerHost['l3Policy'])}
                  options={[
                    { value: 'single_shot', label: '仅单次批准' },
                    { value: 'reject', label: '直接拒绝' },
                  ]}
                />
              </label>
              <label className="server-hub__form-switch">
                本任务内记住（L1 免弹）
                <Switch checked={form.allowGrantMemory} onChange={(v) => set('allowGrantMemory', v)} />
              </label>
              <label className="server-hub__form-switch">
                grant 精确匹配 as_user
                <Switch checked={form.grantBindAsUser} onChange={(v) => set('grantBindAsUser', v)} />
              </label>
            </div>
          </section>
          {editingId && (
            <section className="server-hub__form-section">
              <label className="server-hub__form-switch server-hub__form-switch--danger">
                重置主机键指纹（TOFU）
                <Switch
                  checked={form.resetKnownKey}
                  onChange={(v) => set('resetKnownKey', v)}
                />
              </label>
              <p className="server-hub__form-hint">
                仅在服务器重装/换键且你确认其合法后使用：重置后下次连接将按首次使用重新记录指纹。
              </p>
            </section>
          )}

          <section>
            <h4>备注</h4>
            <div className="server-hub__form-grid">
              <label>
                标签（逗号分隔）
                <Input value={form.tagsText} onChange={(e) => set('tagsText', e.target.value)} placeholder="生产, web" autoComplete="off" />
              </label>
              <label>
                登录身份备注
                <Input value={form.loginNote} onChange={(e) => set('loginNote', e.target.value)} autoComplete="off" />
              </label>
            </div>
          </section>

          {testReport && (
            <div className={`server-hub__test-report ${testReport.ok ? 'is-ok' : 'is-err'}`}>
              {testReport.ok ? (
                <>
                  连接成功 · 登录用户 {testReport.loginUser} · {testReport.osHint} · 主目录 {testReport.home} · {testReport.latencyMs}ms
                </>
              ) : (
                <>连接失败：{testReport.error}</>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
