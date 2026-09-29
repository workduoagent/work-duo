/**
 * 「接入服务」弹窗（MCP 接入，不含构建能力）。
 * 字段：基础信息（别名 / 标识 / 协议 / 地址 / 认证 / 场景 / 描述）+ 启用开关。
 * headers / authConfig 以 JSON 文本录入，保存时解析；非法 JSON 给出提示。
 * 采用与 model-settings / skill-hub 一致的「draft + patch」受控模式。
 */
import { useEffect, useState } from 'react'
import { Copy, KeyRound, Plug } from 'lucide-react'
import { Button, Input, Field, FieldLabel, Modal, Select, Switch, InputNumber, Tag } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  MCP_PROTOCOL_OPTIONS,
  MCP_AUTH_OPTIONS,
  createEmptyMcp,
  getOauthTokens,
  withOauthTokens,
  type McpInfo,
  type McpOauthTokens,
} from '@/core/file/mcp-file'
import { loginMcpOauth } from '@/core/mapper/mcp-connection'
import type { McpProtocolType, McpAuthType } from '@/types/core'
import { ScenarioSelect } from '@/components/scenario'

export interface McpFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑时传入原服务；新增时传 null */
  mcp: McpInfo | null
  onSave: (mcp: McpInfo) => Promise<void> | void
}

/** 示例：API_KEY authConfig */
const AUTH_EXAMPLE = JSON.stringify(
  { key_name: 'Authorization', key_value: 'Bearer sk-xxxxxxxx' },
  null,
  2,
)
/** 示例：headers */
const HEADERS_EXAMPLE = JSON.stringify(
  {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  null,
  2,
)

function parseJsonObject(text: string, field: string): Record<string, unknown> | undefined {
  const t = text.trim()
  if (!t) return undefined
  const obj = JSON.parse(t)
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`${field} 必须是 JSON 对象`)
  }
  return obj as Record<string, unknown>
}

export function McpFormModal({ open, onOpenChange, mcp, onSave }: McpFormModalProps) {
  const { message } = useNotify()
  const [draft, setDraft] = useState<McpInfo>(() =>
    mcp ? structuredClone(mcp) : createEmptyMcp(),
  )
  const [headersText, setHeadersText] = useState('')
  const [authText, setAuthText] = useState('')
  const [errors, setErrors] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(mcp ? structuredClone(mcp) : createEmptyMcp())
    setHeadersText(mcp?.headers ? JSON.stringify(mcp.headers, null, 2) : '')
    setAuthText(mcp?.authConfig ? JSON.stringify(mcp.authConfig, null, 2) : '')
    setErrors(new Set())
    setOauthLoading(false)
  }, [open, mcp])

  const oauthTokens: McpOauthTokens | null = (() => {
    try {
      return getOauthTokens(parseJsonObject(authText, 'authConfig') as Record<string, unknown> | undefined)
    } catch {
      return null
    }
  })()
  const oauthExpired =
    !!oauthTokens?.expiresAt && oauthTokens.expiresAt > 0 && Date.now() >= oauthTokens.expiresAt

  function patch(part: Partial<McpInfo>) {
    setDraft((prev) => ({ ...prev, ...part }))
  }

  async function handleOauthLogin() {
    const url = draft.endpointUrl?.trim()
    if (!url) {
      message.error('请先填写访问地址')
      return
    }
    setOauthLoading(true)
    try {
      const tokens = await loginMcpOauth(url, {
        clientName: draft.aliasName?.trim() || draft.mcpName || 'WorkDuo',
      })
      // 合并进 authConfig 文本（保留用户已有字段）
      let base: Record<string, unknown> | undefined
      try {
        base = parseJsonObject(authText, 'authConfig') as Record<string, unknown> | undefined
      } catch {
        base = undefined
      }
      const merged = withOauthTokens(base, tokens)
      setAuthText(JSON.stringify(merged, null, 2))
      message.success('OAuth 授权成功，token 已写入 authConfig')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setOauthLoading(false)
    }
  }

  async function handleSave() {
    const errs = new Set<string>()
    if (!draft.aliasName?.trim()) errs.add('aliasName')
    if (!draft.mcpName.trim()) errs.add('mcpName')
    else if (!/^[A-Za-z][A-Za-z0-9_-]{1,49}$/.test(draft.mcpName))
      errs.add('mcpName-format')
    if (!draft.protocolType) errs.add('protocolType')
    if (draft.protocolType !== 'STDIO' && !draft.endpointUrl?.trim())
      errs.add('endpointUrl')
    if (!draft.authType) errs.add('authType')
    setErrors(errs)
    if (errs.size > 0) return

    let headers: Record<string, string> | undefined
    let authConfig: Record<string, unknown> | undefined
    try {
      headers = parseJsonObject(headersText, 'headers') as Record<string, string> | undefined
    } catch (e) {
      message.error((e as Error).message)
      return
    }
    try {
      authConfig = parseJsonObject(authText, 'authConfig')
    } catch (e) {
      message.error((e as Error).message)
      return
    }

    setSaving(true)
    try {
      await onSave({
        ...draft,
        aliasName: draft.aliasName?.trim() || undefined,
        mcpName: draft.mcpName.trim(),
        endpointUrl:
          draft.protocolType === 'STDIO'
            ? undefined
            : draft.endpointUrl?.trim() || undefined,
        headers,
        authConfig,
        updatedAt: new Date().toISOString(),
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const hasError = (key: string) => (errors.has(key) ? 'error' : undefined)

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={720}
      title={mcp ? '编辑 MCP 服务' : '接入 MCP 服务'}
      description={
        mcp
          ? '修改该服务的连接信息与认证配置。'
          : '填写服务标识与连接信息；工具将在「连通性测试 / 同步」时自动发现。'
      }
      footer={
        <div className="mcphub__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={saving} onClick={handleSave}>
            保存
          </Button>
        </div>
      }
    >
      <div className="mcphub__form">
        <section className="mcphub__section">
          <h4 className="mcphub__section-title">
            <Plug size={14} className="mcphub__inline-icon" />
            基础信息
          </h4>
          <div className="mcphub__grid">
            <Field>
              <FieldLabel>
                服务别名<span className="mcphub__required">*</span>
              </FieldLabel>
              <Input
                value={draft.aliasName ?? ''}
                status={hasError('aliasName')}
                placeholder="如 文件系统服务（卡片展示用）"
                onChange={(e) => patch({ aliasName: e.target.value })}
              />
            </Field>

            <Field>
              <FieldLabel>
                服务标识<span className="mcphub__required">*</span>
              </FieldLabel>
              <Input
                value={draft.mcpName}
                disabled={!!mcp}
                status={hasError('mcpName') || hasError('mcpName-format') ? 'error' : undefined}
                placeholder="如 file-system（字母开头）"
                onChange={(e) => patch({ mcpName: e.target.value })}
              />
              {errors.has('mcpName-format') && (
                <div className="mcphub__field-error">
                  标识仅允许字母开头，含字母 / 数字 / 下划线 / 中划线，长度 2-50
                </div>
              )}
            </Field>

            <Field>
              <FieldLabel>
                协议类型<span className="mcphub__required">*</span>
              </FieldLabel>
              <Select
                value={draft.protocolType}
                options={MCP_PROTOCOL_OPTIONS as never}
                onChange={(v) => patch({ protocolType: v as McpProtocolType })}
              />
            </Field>

            <Field>
              <FieldLabel>
                访问地址
                {draft.protocolType !== 'STDIO' && (
                  <span className="mcphub__required">*</span>
                )}
              </FieldLabel>
              <Input
                value={draft.endpointUrl ?? ''}
                status={hasError('endpointUrl')}
                disabled={draft.protocolType === 'STDIO'}
                placeholder="如 https://example.com/mcp"
                onChange={(e) => patch({ endpointUrl: e.target.value })}
              />
            </Field>

            <Field>
              <FieldLabel>
                认证类型<span className="mcphub__required">*</span>
              </FieldLabel>
              <Select
                value={draft.authType}
                options={MCP_AUTH_OPTIONS as never}
                onChange={(v) => patch({ authType: v as McpAuthType })}
              />
            </Field>

            {draft.authType === 'OAUTH2' && (
              <Field className="mcphub__span-2">
                <FieldLabel>OAuth2 授权</FieldLabel>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <Button
                    variant="soft"
                    icon={<KeyRound size={14} />}
                    loading={oauthLoading}
                    disabled={draft.protocolType === 'STDIO'}
                    onClick={handleOauthLogin}
                  >
                    OAuth 授权登录
                  </Button>
                  {oauthTokens ? (
                    oauthExpired ? (
                      <Tag color="warning">授权已过期（可重新登录）</Tag>
                    ) : (
                      <Tag color="success">
                        已授权
                        {oauthTokens.expiresAt
                          ? ` · 过期 ${new Date(oauthTokens.expiresAt).toLocaleString()}`
                          : ''}
                      </Tag>
                    )
                  ) : (
                    <Tag>未授权</Tag>
                  )}
                  <span className="mcphub__field-error" style={{ flexBasis: '100%' }}>
                    使用系统浏览器完成 OAuth2 授权
                  </span>
                </div>
              </Field>
            )}

            <Field>
              <FieldLabel>使用场景</FieldLabel>
              <ScenarioSelect
                scope="MCP"
                value={draft.scenario ?? null}
                onChange={(v) => patch({ scenario: v ?? undefined })}
                placeholder="选择或搜索场景，可回车新建"
              />
            </Field>

            <Field>
              <FieldLabel>超时（秒）</FieldLabel>
              <InputNumber
                value={draft.timeoutSec ?? 120}
                min={5}
                max={600}
                step={5}
                style={{ width: '100%' }}
                onChange={(v) => patch({ timeoutSec: typeof v === 'number' ? v : 120 })}
              />
            </Field>

            <Field className="mcphub__span-2">
              <FieldLabel>服务描述</FieldLabel>
              <Input.TextArea
                rows={2}
                value={draft.description ?? ''}
                placeholder="简要描述该 MCP 服务的功能和用途"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>

            <Field className="mcphub__span-2">
              <FieldLabel>启用</FieldLabel>
              <Switch
                checked={draft.isActive}
                onChange={(v) => patch({ isActive: v })}
              />
            </Field>
          </div>
        </section>

        <section className="mcphub__section">
          <h4 className="mcphub__section-title">认证与请求头（JSON）</h4>
          <div className="mcphub__json-block">
            <div className="mcphub__json-head">
              <span>authConfig</span>
              <Button
                variant="link"
                size="sm"
                icon={<Copy size={13} />}
                onClick={() => {
                  setAuthText(AUTH_EXAMPLE)
                  message.success('已填入示例')
                }}
              >
                示例
              </Button>
            </div>
            <Input.TextArea
              rows={4}
              value={authText}
              placeholder='如 { "key_name": "Authorization", "key_value": "Bearer ..." }'
              onChange={(e) => setAuthText(e.target.value)}
            />
          </div>

          <div className="mcphub__json-block">
            <div className="mcphub__json-head">
              <span>headers</span>
              <Button
                variant="link"
                size="sm"
                icon={<Copy size={13} />}
                onClick={() => {
                  setHeadersText(HEADERS_EXAMPLE)
                  message.success('已填入示例')
                }}
              >
                示例
              </Button>
            </div>
            <Input.TextArea
              rows={4}
              value={headersText}
              placeholder='如 { "Content-Type": "application/json" }'
              onChange={(e) => setHeadersText(e.target.value)}
            />
          </div>
        </section>
      </div>
    </Modal>
  )
}
