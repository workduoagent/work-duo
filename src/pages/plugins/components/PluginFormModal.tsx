/**
 * 新建 / 编辑插件弹窗（表单镜像 skill-hub / mcp-hub 的「draft + patch」受控模式）。
 *
 * 三个 Tab：
 *  1) 基础信息：名称 / 标识符（identifier，禁保留前缀）/ 运行时 / 场景 / 超时 / 描述 / 启用；
 *  2) 脚本代码：Monaco（language 随 runtime 切换 python | typescript）+ 「插入模板」按钮；
 *  3) 依赖与参数：dependencies（标签输入）/ parametersSchema（JSON 编辑）/ sampleParams（JSON 编辑）。
 *
 * ★ 元数据自动同步（ADR #4 按用户决策改版，2026-09-16）：
 *   切到「依赖与参数」Tab 时自动解析脚本头注释，把 dependencies / parametersSchema
 *   同步进表单（参数 Schema = 模型输入数据结构）；头注释缺省或解析不规范 → 跳过
 *   自动同步、保持现状，由用户手写。保存动作本身不做任何自动提取。
 */
import { useEffect, useState } from 'react'
import { Braces, CheckCircle2, AlertTriangle } from 'lucide-react'
import {
  Button,
  Input,
  Field,
  FieldLabel,
  Modal,
  Select,
  Switch,
  InputNumber,
} from '@/components/ui'
import { Tabs, Tooltip } from 'antd'
import { useNotify } from '@/components/ui/notify'
import { MonacoJsonEditor } from '@/components/code-editor'
import { ScenarioSelect } from '@/components/scenario'
import {
  createEmptyPlugin,
  validatePluginIdentifier,
  PLUGIN_RUNTIME_OPTIONS,
  type UserPluginTool,
  type UpsertUserPluginInput,
  type PluginRuntime,
} from '@/core/file/plugin-file'
import { extractPluginMeta } from '@/core/mapper/plugin-connection'

export interface PluginFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑时传入原插件；新增时传 null */
  plugin: UserPluginTool | null
  onSave: (input: UpsertUserPluginInput) => Promise<void> | void
}

/** 按运行时生成带头注释的 run(params) 骨架模板。 */
function scriptTemplate(runtime: PluginRuntime): string {
  if (runtime === 'python') {
    return `"""
name: my_plugin
description: 一句话描述该插件的能力（给模型看）
dependencies:
  - requests
parameters:
  text:
    type: string
    description: 示例参数
    required: true
"""
import requests

def run(params):
    text = params.get("text", "")
    return {"echo": text}
`
  }
  return `/**
 * @name my_plugin
 * @description 一句话描述该插件的能力（给模型看）
 * @dependencies
 *   - gpt-tokenizer
 * @parameters
 *   text:
 *     type: string
 *     description: 示例参数
 *     required: true
 */
export default async function run(params: { text?: string }) {
  return { echo: params.text ?? '' }
}
`
}

export function PluginFormModal({
  open,
  onOpenChange,
  plugin,
  onSave,
}: PluginFormModalProps) {
  const { message } = useNotify()
  const [draft, setDraft] = useState<UserPluginTool>(() =>
    plugin ? structuredClone(plugin) : createEmptyPlugin(),
  )
  const [depsText, setDepsText] = useState<string[]>([])
  const [errors, setErrors] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  /** 头注释自动同步状态：null 未判定；ok 识别成功；warn 未识别（悬浮看原因）。 */
  const [schemaSync, setSchemaSync] = useState<{ ok: boolean; tip: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(plugin ? structuredClone(plugin) : createEmptyPlugin())
    setDepsText(plugin?.dependencies ?? [])
    setErrors(new Set())
    setSchemaSync(null)
  }, [open, plugin])

  function patch(part: Partial<UserPluginTool>) {
    setDraft((prev) => ({ ...prev, ...part }))
  }

  /**
   * 切到「依赖与参数」Tab 时自动同步头注释元数据（全程静默，不弹 toast）：
   *  - 解析成功且有内容 → 回填 dependencies / parametersSchema，Schema 标签旁显示 ✓；
   *  - 头注释缺省 / 不规范 / 解析失败 → 不动表单，显示 ⚠（悬浮看原因），由用户手写。
   */
  async function autoSyncMetaOnParamsTab() {
    if (!draft.scriptContent.trim()) {
      setSchemaSync(null)
      return
    }
    try {
      const meta = await extractPluginMeta(draft.runtime, draft.scriptContent)
      const warnings = meta.warnings ?? []
      const propCount = Object.keys(
        (meta.parametersSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {},
      ).length
      const hasDeps = meta.dependencies.length > 0
      if (warnings.length > 0) {
        setSchemaSync({
          ok: false,
          tip: `头注释未能规范识别，未自动填充，请在下方手写参数 Schema（${warnings[0]}）`,
        })
        return
      }
      if (propCount === 0 && !hasDeps) {
        setSchemaSync({
          ok: false,
          tip: '头注释中没有 parameters 段，未自动识别；可在下方手写参数 Schema',
        })
        return
      }
      setDraft((prev) => ({
        ...prev,
        parametersSchema:
          propCount > 0 ? meta.parametersSchema ?? prev.parametersSchema : prev.parametersSchema,
      }))
      if (hasDeps) setDepsText(meta.dependencies)
      const parts: string[] = []
      if (propCount > 0) parts.push(`参数 Schema（${propCount} 个参数）`)
      if (hasDeps) parts.push(`依赖（${meta.dependencies.join('、')}）`)
      setSchemaSync({
        ok: true,
        tip: `已从头注释自动同步：${parts.join('、')}；如需调整可直接编辑，保存以当前值为准`,
      })
    } catch {
      setSchemaSync({ ok: false, tip: '头注释解析失败，未自动填充；请手写参数 Schema' })
    }
  }

  function handleTabChange(key: string) {
    if (key === 'params') void autoSyncMetaOnParamsTab()
  }

  async function handleSave() {
    const errs = new Set<string>()
    if (!draft.name.trim()) errs.add('name')
    if (!draft.identifier.trim()) errs.add('identifier')
    else if (!validatePluginIdentifier(draft.identifier).ok) errs.add('identifier-format')
    if (!draft.description.trim()) errs.add('description')
    if (!draft.scriptContent.trim()) errs.add('scriptContent')
    const schemaOk = (() => {
      try {
        const v = draft.parametersSchema
        return typeof v === 'object' && v !== null && !Array.isArray(v)
      } catch {
        return false
      }
    })()
    if (!schemaOk) errs.add('parametersSchema')
    setErrors(errs)
    if (errs.size > 0) {
      message.warning('请完善必填项（名称 / 标识符 / 描述 / 脚本代码）')
      return
    }

    setSaving(true)
    try {
      await onSave({
        id: plugin?.id,
        name: draft.name.trim(),
        identifier: draft.identifier.trim(),
        description: draft.description.trim(),
        runtime: draft.runtime,
        scriptContent: draft.scriptContent,
        parametersSchema: draft.parametersSchema,
        dependencies: depsText.map((d) => d.trim()).filter(Boolean),
        sampleParams: draft.sampleParams ?? null,
        enabled: draft.enabled,
        timeoutSec: draft.timeoutSec,
        scenario: draft.scenario ?? null,
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const hasError = (key: string) => (errors.has(key) ? 'error' : undefined)
  const scriptLang = draft.runtime === 'python' ? 'python' : 'typescript'

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={920}
      style={{ maxWidth: '94vw' }}
      title={plugin ? '编辑插件' : '新建插件'}
      footer={
        <div className="pluginhub__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={saving} onClick={handleSave}>
            保存
          </Button>
        </div>
      }
    >
      <Tabs
        defaultActiveKey="base"
        onChange={handleTabChange}
        items={[
          /* ============ Tab 1：基础信息 ============ */
          {
            key: 'base',
            label: '基础信息',
            children: (
              <div className="pluginhub__form">
                <div className="pluginhub__grid">
                  <Field>
                    <FieldLabel>
                      插件名称<span className="pluginhub__required">*</span>
                    </FieldLabel>
                    <Input
                      value={draft.name}
                      status={hasError('name')}
                      placeholder="如 汇率换算（卡片展示用）"
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel>
                      标识符<span className="pluginhub__required">*</span>
                    </FieldLabel>
                    <Input
                      value={draft.identifier}
                      disabled={!!plugin}
                      status={
                        hasError('identifier') || hasError('identifier-format')
                          ? 'error'
                          : undefined
                      }
                      placeholder="如 convert_currency（小写字母/数字开头）"
                      onChange={(e) => patch({ identifier: e.target.value })}
                    />
                    {errors.has('identifier-format') && (
                      <div className="pluginhub__field-error">
                        以小写字母/数字开头，仅含小写字母/数字/_/-，长度 2-48；
                        不得以 native__ / mcp__ / skill__ / custom__ 开头
                      </div>
                    )}
                  </Field>

                  <Field>
                    <FieldLabel>
                      运行时<span className="pluginhub__required">*</span>
                    </FieldLabel>
                    <Select
                      value={draft.runtime}
                      options={PLUGIN_RUNTIME_OPTIONS as never}
                      onChange={(v) => patch({ runtime: v as PluginRuntime })}
                    />
                  </Field>

                  <Field>
                    <FieldLabel>使用场景</FieldLabel>
                    <ScenarioSelect
                      scope="PLUGIN"
                      value={draft.scenario ?? null}
                      onChange={(v) => patch({ scenario: v ?? undefined })}
                      placeholder="选择或搜索场景，可回车新建"
                    />
                  </Field>

                  <Field>
                    <FieldLabel>
                      超时（秒，1-300）
                      <span className="pluginhub__required">*</span>
                    </FieldLabel>
                    <InputNumber
                      value={draft.timeoutSec}
                      min={1}
                      max={300}
                      step={5}
                      style={{ width: '100%' }}
                      onChange={(v) =>
                        patch({ timeoutSec: typeof v === 'number' ? v : 60 })
                      }
                    />
                  </Field>

                  <Field>
                    <FieldLabel>启用</FieldLabel>
                    <Switch
                      checked={draft.enabled}
                      onChange={(v) => patch({ enabled: v })}
                    />
                  </Field>

                  <Field className="pluginhub__span-2">
                    <FieldLabel>
                      插件描述<span className="pluginhub__required">*</span>
                    </FieldLabel>
                    <Input.TextArea
                      rows={2}
                      value={draft.description}
                      status={hasError('description')}
                      placeholder="一句话描述该插件的能力（给人与模型看，模型据此决定是否调用）"
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </Field>
                </div>
              </div>
            ),
          },

          /* ============ Tab 2：脚本代码 ============ */
          {
            key: 'script',
            label: '脚本代码',
            children: (
              <div className="pluginhub__form">
                <div className="pluginhub__script-actions">
                  <Tooltip title="填入带头注释的 run(params) 骨架（替换当前内容）；头注释会在切到「依赖与参数」Tab 时自动同步为参数 Schema">
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() =>
                        patch({ scriptContent: scriptTemplate(draft.runtime) })
                      }
                    >
                      <Braces size={14} />
                      插入模板
                    </Button>
                  </Tooltip>
                </div>
                <MonacoJsonEditor
                  mode="code"
                  language={scriptLang}
                  value={draft.scriptContent}
                  height={520}
                  onChange={(v) =>
                    patch({ scriptContent: typeof v === 'string' ? v : '' })
                  }
                />
              </div>
            ),
          },

          /* ============ Tab 3：依赖与参数 ============ */
          {
            key: 'params',
            label: '依赖与参数',
            children: (
              <div className="pluginhub__form">
                <Field>
                  <FieldLabel>
                    声明依赖（Python 包名 / npm 包名，回车添加；留空 = 仅标准库 / 零 npm 包）
                  </FieldLabel>
                  <Select
                    mode="tags"
                    maxTagCount="responsive"
                    value={depsText}
                    placeholder="如 requests、gpt-tokenizer@^2.1.2"
                    tokenSeparators={[',']}
                    onChange={(v) => setDepsText(v as string[])}
                  />
                </Field>
                <Field>
                  <FieldLabel>
                    参数 Schema（OpenAI function parameters）
                    {schemaSync && (
                      <Tooltip title={schemaSync.tip}>
                        {schemaSync.ok ? (
                          <CheckCircle2
                            size={13}
                            className="pluginhub__sync-icon pluginhub__sync-icon--ok"
                          />
                        ) : (
                          <AlertTriangle
                            size={13}
                            className="pluginhub__sync-icon pluginhub__sync-icon--warn"
                          />
                        )}
                      </Tooltip>
                    )}
                  </FieldLabel>
                  <MonacoJsonEditor
                    value={draft.parametersSchema}
                    height={260}
                    onChange={(v) => {
                      if (v && typeof v === 'object' && !Array.isArray(v)) {
                        patch({ parametersSchema: v as Record<string, unknown> })
                      }
                    }}
                  />
                  <p className="pluginhub__hint">
                    需为 JSON Schema 对象（type=object）；切到本 Tab 会自动从脚本头注释识别填充，识别不了可手写。
                  </p>
                </Field>
                <Field>
                  <FieldLabel>示例参数（试跑一键填充，可空）</FieldLabel>
                  <MonacoJsonEditor
                    value={draft.sampleParams ?? {}}
                    height={200}
                    onChange={(v) => {
                      if (v && typeof v === 'object' && !Array.isArray(v)) {
                        patch({ sampleParams: v as Record<string, unknown> })
                      }
                    }}
                  />
                </Field>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}
