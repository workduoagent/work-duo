/**
 * 分类参数动态表单（受控组件，两处共用）。
 *
 * 依据 src/components/model/paramFields.ts 的字段描述渲染控件，
 * 消费方：
 *  - LLM 模块 ModelFormModal（className 沿用 mfm__param-grid）；
 *  - 智能体向导「步骤2 选择模型」（className 用 agent-wizard 自己的网格类）。
 *
 * 用法：
 *   <ParamFieldsForm
 *     category="text"
 *     values={llmConfig}
 *     onChange={(key, v) => setParam(key, v)}
 *     className="xxx__param-grid"
 *     fullWidthClassName="xxx__span-2"
 *   />
 */
import { Field, FieldLabel, Input, InputNumber, Select, Slider, Switch } from '@/components/ui'
import { getParamFields } from './paramFields'
import './ParamFieldsForm.scss'

export interface ParamFieldsFormProps {
  /** 模型大类（text / multimodal / stt / tts / embedding / rerank） */
  category: string
  /** 当前参数值（对应 ModelConfig[category] 或 agent_info 的 *_config 副本） */
  values: Record<string, unknown>
  /** 单个字段变更回调 */
  onChange: (key: string, value: unknown) => void
  /** 网格容器附加类名（沿用调用方 scss，保证两处视觉各自对齐） */
  className?: string
  /** 跨整行字段（textarea）附加类名 */
  fullWidthClassName?: string
}

function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ')
}

export function ParamFieldsForm({
  category,
  values,
  onChange,
  className,
  fullWidthClassName,
}: ParamFieldsFormProps) {
  const fields = getParamFields(category)
  if (fields.length === 0) return null

  return (
    <div className={cx('param-fields', className)}>
      {fields.map((def) => {
        const value = values[def.key]
        return (
          <Field
            key={def.key}
            className={def.control === 'textarea' ? fullWidthClassName : undefined}
          >
            <FieldLabel>
              {def.label}
              {def.hint && <span className="param-fields__hint">（{def.hint}）</span>}
            </FieldLabel>

            {def.control === 'slider' && typeof value === 'number' && (
              <div className="param-fields__slider">
                <Slider
                  value={value}
                  min={def.min}
                  max={def.max}
                  step={def.step ?? 0.01}
                  onChange={(v) => onChange(def.key, v)}
                />
                <span className="param-fields__slider-value">{value}</span>
              </div>
            )}

            {def.control === 'number' && (
              <InputNumber
                className="param-fields__input-number"
                value={typeof value === 'number' ? value : undefined}
                min={def.min}
                max={def.max}
                step={def.step ?? 1}
                onChange={(v) => onChange(def.key, v ?? 0)}
              />
            )}

            {def.control === 'switch' && (
              <div className="param-fields__control-wrapper">
                <Switch checked={value === true} onChange={(v) => onChange(def.key, v)} />
              </div>
            )}

            {def.control === 'select' && (
              <Select
                value={value as string}
                options={def.options as never}
                onChange={(v) => onChange(def.key, v)}
              />
            )}

            {def.control === 'checkbox' && (
              <Select
                mode="multiple"
                value={(value as string[]) ?? []}
                options={def.options as never}
                placeholder="选择支持的输入模态"
                onChange={(v) => onChange(def.key, v)}
              />
            )}

            {def.control === 'text' && (
              <Input
                value={(value as string) ?? ''}
                placeholder={def.hint}
                autoComplete="off"
                onChange={(e) => onChange(def.key, e.target.value)}
              />
            )}

            {def.control === 'textarea' && (
              <Input.TextArea
                rows={2}
                value={(value as string) ?? ''}
                autoComplete="off"
                onChange={(e) => onChange(def.key, e.target.value)}
              />
            )}
          </Field>
        )
      })}
    </div>
  )
}
