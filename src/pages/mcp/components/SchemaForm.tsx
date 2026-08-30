/**
 * SchemaForm：根据 MCP 工具的 inputSchema（JSON Schema）自动渲染表单。
 *
 * 目标：让「测试参数」不再需要手敲 JSON，而是按字段填。覆盖 MCP 工具常见形态：
 *  - string / number / integer / boolean 基础类型；
 *  - enum → 下拉选择；
 *  - array（元素为 string）→ 逗号分隔输入，结果转为字符串数组；
 *    其它 array → JSON 文本框；
 *  - object → 递归渲染（嵌套字段集）；
 *  - anyOf 含 null（如 MinerU 的 model / output_dir / page_ranges）→ 视为「可空」，
 *    解包为非 null 类型，空值省略（兼容 additionalProperties:false）。
 *
 * 受控约定：value 为「完整工作对象」（含空值，便于输入中途切换 JSON 不丢状态）；
 * 调用方在发送 tools/call 前用 pruneEmpty() 去除空值，避免向服务端多传键。
 */
import { Fragment, type ReactNode } from 'react'
import {
  Field,
  FieldLabel,
  Input,
  InputNumber,
  Select,
  Switch,
} from '@/components/ui'
import './SchemaForm.scss'

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown'

interface PropDef {
  type: JsonType
  nullable: boolean
}

/** 从 property 定义解析「有效类型」（处理 anyOf 含 null 的可空写法）。 */
function effectiveType(prop: Record<string, unknown>): PropDef {
  const t = prop.type
  if (typeof t === 'string') return { type: t as JsonType, nullable: false }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const list = prop[key]
    if (Array.isArray(list) && list.length > 0) {
      let nullable = false
      let type: JsonType = 'unknown'
      for (const sub of list as Record<string, unknown>[]) {
        if (sub.type === 'null') {
          nullable = true
          continue
        }
        if (typeof sub.type === 'string') type = sub.type as JsonType
      }
      return { type, nullable }
    }
  }
  return { type: 'unknown', nullable: false }
}

/** 取 property 的 items 元素类型（用于判定 array 是否为 string 数组）。 */
function arrayItemType(prop: Record<string, unknown>): JsonType {
  const items = prop.items as Record<string, unknown> | undefined
  if (items && typeof items.type === 'string') return items.type as JsonType
  return 'unknown'
}

/** 构造表单初始值：带 default 的字段填 default；其余按类型给占位空值。 */
export function schemaDefaultValue(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = (schema?.properties as Record<string, Record<string, unknown>>) ?? {}
  for (const [key, prop] of Object.entries(props)) {
    if (prop == null || typeof prop !== 'object') continue
    const { type } = effectiveType(prop)
    if (Object.prototype.hasOwnProperty.call(prop, 'default')) {
      out[key] = prop.default
    } else if (type === 'boolean') {
      out[key] = false
    } else if (type === 'array') {
      out[key] = []
    } else if (type === 'object') {
      out[key] = schemaDefaultValue(prop as Record<string, unknown>)
    } else {
      out[key] = ''
    }
  }
  return out
}

/** 去除空值（空字符串 / 空数组 / null / undefined / 空对象），避免向服务端多传键。 */
export function pruneEmpty(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!value) return out
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
      continue
    }
    out[k] = v
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface SchemaFormProps {
  schema: Record<string, unknown> | undefined
  value: Record<string, unknown>
  onChange: (value: Record<string, unknown>) => void
  /** 嵌套层级（仅用于缩进样式，0 为顶层）。 */
  depth?: number
}

export function SchemaForm({ schema, value, onChange, depth = 0 }: SchemaFormProps) {
  const props = (schema?.properties as Record<string, Record<string, unknown>>) ?? {}
  const required = (schema?.required as string[]) ?? []

  if (Object.keys(props).length === 0) {
    return <p className="mcphub-schema-form__empty">该工具无入参，可直接测试（无需填写）。</p>
  }

  return (
    <div className={`mcphub-schema-form${depth > 0 ? ' mcphub-schema-form--nested' : ''}`}>
      {Object.entries(props).map(([key, prop]) => {
        if (prop == null || typeof prop !== 'object') return null
        const p = prop as Record<string, unknown>
        const { type, nullable } = effectiveType(p)
        const isRequired = required.includes(key)
        const desc = typeof p.description === 'string' ? p.description : undefined
        const cur = value[key]

        const setVal = (next: unknown) => onChange({ ...value, [key]: next })

        // 渲染不同控件
        let control: ReactNode
        if (Array.isArray(p.enum)) {
          control = (
            <Select
              value={typeof cur === 'string' ? cur : undefined}
              allowClear
              placeholder="请选择"
              options={(p.enum as unknown[]).map((o) => ({
                value: String(o),
                label: String(o),
              }))}
              onChange={(v) => setVal(v ?? '')}
            />
          )
        } else if (type === 'boolean') {
          control = (
            <Switch
              checked={cur === true}
              onChange={(v) => setVal(v)}
            />
          )
        } else if (type === 'number' || type === 'integer') {
          control = (
            <InputNumber
              value={typeof cur === 'number' ? cur : null}
              style={{ width: '100%' }}
              onChange={(v) => setVal(typeof v === 'number' ? v : '')}
            />
          )
        } else if (type === 'array') {
          if (arrayItemType(p) === 'string') {
            const arr = Array.isArray(cur) ? (cur as unknown[]).map(String) : []
            control = (
              <Input
                value={arr.join(', ')}
                placeholder="多个值用逗号分隔，如 https://a.pdf, https://b.pdf"
                onChange={(e) =>
                  setVal(
                    e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  )
                }
              />
            )
          } else {
            control = (
              <Input.TextArea
                rows={3}
                value={typeof cur === 'string' ? cur : JSON.stringify(cur ?? [], null, 2)}
                placeholder='JSON 数组，如 ["a", "b"]'
                onChange={(e) => {
                  try {
                    setVal(JSON.parse(e.target.value))
                  } catch {
                    setVal(e.target.value)
                  }
                }}
              />
            )
          }
        } else if (type === 'object') {
          control = (
            <SchemaForm
              schema={p}
              depth={depth + 1}
              value={isPlainObject(cur) ? cur : {}}
              onChange={(sub) => setVal(sub)}
            />
          )
        } else {
          // string 或 unknown → 文本输入；unknown 给 JSON 文本框兜底
          control = (
            <Input
              value={typeof cur === 'string' ? cur : cur == null ? '' : JSON.stringify(cur)}
              placeholder={type === 'unknown' ? 'JSON 或文本' : undefined}
              onChange={(e) => setVal(e.target.value)}
            />
          )
        }

        return (
          <Fragment key={key}>
            <Field className="mcphub-schema-form__field">
              <FieldLabel>
                <code className="mcphub-schema-form__key">{key}</code>
                {isRequired && <span className="mcphub__required">*</span>}
                {nullable && <span className="mcphub-schema-form__opt">可选</span>}
              </FieldLabel>
              {control}
              {desc && <p className="mcphub-schema-form__desc">{desc}</p>}
            </Field>
          </Fragment>
        )
      })}
    </div>
  )
}
