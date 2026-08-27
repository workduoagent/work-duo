/**
 * 接入 / 编辑模型的表单弹窗。
 * 结构：基础信息（名称、服务商、Base URL、密钥、模型标识、备注）
 *      + 分类参数（由 paramFields.ts 的字段描述动态渲染，随分类切换）。
 * 新增分类时只需扩展 paramFields.ts 与 model-file.ts 的默认值。
 */
import {useEffect, useState} from 'react'
import {Zap, Wrench} from 'lucide-react'
import {
    Button,
    Input,
    Field,
    FieldLabel,
    Modal,
    Select,
    Slider,
    Switch,
    InputNumber,
    SpinnerIcon
} from '@/components/ui'
import {
    PROVIDER_OPTIONS,
    createEmptyModel,
    type ModelConfig,
} from '@/core/file/model-file'
import type {ModelCategory} from '@/types/core'
import {testModelConnection, type ModelTestResult} from '@/utils/modelTest'
import {getParamFields} from './paramFields'
import './ModelFormModal.scss'

export interface ModelFormModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** 编辑时传入原模型；新增时传 null */
    model: ModelConfig | null
    /** 新增时使用的分类（编辑时以 model.category 为准） */
    category: ModelCategory
    onSave: (model: ModelConfig) => Promise<void> | void
}

/** 必填基础字段的校验 */
function validate(draft: ModelConfig): Set<string> {
    const errors = new Set<string>()
    if (!draft.name.trim()) errors.add('name')
    if (!draft.modelName.trim()) errors.add('modelName')
    if (!draft.baseUrl.trim()) errors.add('baseUrl')
    if (!draft.apiKey.trim()) errors.add('apiKey')
    return errors
}

export function ModelFormModal({
                                   open,
                                   onOpenChange,
                                   model,
                                   category,
                                   onSave,
                               }: ModelFormModalProps) {
    const [draft, setDraft] = useState<ModelConfig>(() =>
        model ? structuredClone(model) : createEmptyModel(category),
    )
    const [errors, setErrors] = useState<Set<string>>(new Set())
    const [saving, setSaving] = useState(false)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<ModelTestResult | null>(null)

    // 每次打开时重置草稿（编辑 → 深拷贝原值；新增 → 该分类的默认参数）
    useEffect(() => {
        if (!open) return
        setDraft(model ? structuredClone(model) : createEmptyModel(category))
        setErrors(new Set())
        setTestResult(null)
    }, [open, model, category])

    const activeCategory = draft.category
    const paramFields = getParamFields(activeCategory)
    // Tool/Function Calling 仅对 LLM 类（纯文本 / 多模态）有意义，故仅这两类展示开关
    const showToolCalls = activeCategory === 'text' || activeCategory === 'multimodal'
    // 分类参数挂在 draft[category] 上；类型上为按需可选，这里统一当记录用
    const paramValues = (draft[activeCategory] ?? {}) as unknown as Record<string, unknown>

    function patch(part: Partial<ModelConfig>) {
        setDraft((prev) => ({...prev, ...part}))
    }

    function setParam(key: string, value: unknown) {
        setDraft((prev) => ({
            ...prev,
            [prev.category]: {
                ...(prev[prev.category] as unknown as Record<string, unknown>),
                [key]: value,
            },
        }))
    }

    async function handleSave() {
        const errs = validate(draft)
        setErrors(errs)
        if (errs.size > 0) return
        setSaving(true)
        try {
            await onSave(draft)
            onOpenChange(false)
        } finally {
            setSaving(false)
        }
    }

    async function handleTest() {
        if (testing) return
        setTesting(true)
        setTestResult(null)
        const r = await testModelConnection(draft)
        setTestResult(r)
        setTesting(false)
    }

    const errStatus = (key: string) => (errors.has(key) ? 'error' : undefined)

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            width={680}
            title={model ? '编辑模型' : '接入模型'}
            description={
                model
                    ? '调整该模型的基础信息与分类参数。'
                    : '填写服务商信息；不同分类的模型参数各不相同。'
            }
            footer={
                <div className="mfm__footer">
                    <div className="mfm__test">
                        <Button
                            variant="soft"
                            onClick={handleTest}
                            disabled={testing || !draft.baseUrl.trim()}
                        >
                            {testing ? <SpinnerIcon width={16} height={16}/> : <Zap size={16} data-icon="start"/>}
                            测试连通性
                        </Button>
                        {testResult && (
                            <span
                                className={`mfm__test-result mfm__test-result--${
                                    testResult.ok ? 'ok' : 'fail'
                                }`}
                            >
                {testResult.message}
              </span>
                        )}
                    </div>
                    <div className="mfm__footer-actions">
                        <Button variant="soft" onClick={() => onOpenChange(false)}>
                            取消
                        </Button>
                        <Button loading={saving} onClick={handleSave}>
                            保存
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="mfm">
                {/* ---------- 基础信息 ---------- */}
                <section className="mfm__section">
                    <h4 className="mfm__section-title">基础信息</h4>
                    <div className="mfm__grid">
                        <Field>
                            <FieldLabel>展示名称<span className="mfm__required">*</span></FieldLabel>
                            <Input
                                value={draft.name}
                                status={errStatus('name')}
                                placeholder="例如 GPT-4o / Qwen-Max"
                                onChange={(e) => patch({name: e.target.value})}
                            />
                        </Field>

                        <Field>
                            <FieldLabel>服务商<span className="mfm__required">*</span></FieldLabel>
                            <Select
                                value={draft.provider}
                                options={PROVIDER_OPTIONS as never}
                                onChange={(v) => patch({provider: v})}
                            />
                        </Field>

                        <Field className="mfm__span-2">
                            <FieldLabel>API Base URL<span className="mfm__required">*</span></FieldLabel>
                            <Input
                                value={draft.baseUrl}
                                status={errStatus('baseUrl')}
                                placeholder="https://api.openai.com/v1"
                                onChange={(e) => patch({baseUrl: e.target.value})}
                            />
                        </Field>

                        <Field className="mfm__span-2">
                            <FieldLabel>API Key<span className="mfm__required">*</span></FieldLabel>
                            <Input.Password
                                value={draft.apiKey}
                                status={errStatus('apiKey')}
                                placeholder="sk-…"
                                onChange={(e) => patch({apiKey: e.target.value})}
                            />
                        </Field>

                        <Field>
                            <FieldLabel>模型标识<span className="mfm__required">*</span></FieldLabel>
                            <Input
                                value={draft.modelName}
                                status={errStatus('modelName')}
                                placeholder="例如 gpt-4o / qwen-max"
                                onChange={(e) => patch({modelName: e.target.value})}
                            />
                        </Field>

                        <Field>
                            <FieldLabel>备注</FieldLabel>
                            <Input
                                value={draft.description ?? ''}
                                placeholder="用途说明（可选）"
                                onChange={(e) => patch({description: e.target.value})}
                            />
                        </Field>

                        {showToolCalls && (
                            <Field className="mfm__span-2">
                                {/* 将 Tool / Function Calling 的提示调整为 */}
                                <FieldLabel>
                                    <Wrench size={14} className="mfm__inline-icon"/>
                                    Tool / Function Calling
                                    <span className="mfm__hint">是否支持工具调用，对 Agent 集成至关重要</span>
                                </FieldLabel>
                                <div className="mfm__toolcalls">
                                    <Switch
                                        checked={draft.toolCalls}
                                        onChange={(v) => patch({toolCalls: v})}
                                    />
                                    <span className="mfm__toolcalls-text">
                    {draft.toolCalls ? '已启用工具调用' : '默认不支持，启用后该模型可被 Agent 调用外部工具'}
                  </span>
                                </div>
                            </Field>
                        )}
                    </div>
                </section>

                {/* ---------- 分类参数 ---------- */}
                <section className="mfm__section">
                    <h4 className="mfm__section-title">分类参数</h4>
                    <div className="mfm__grid">
                        {paramFields.map((def) => {
                            const value = paramValues[def.key]
                            return (
                                <Field
                                    key={def.key}
                                    className={
                                        def.control === 'textarea' || def.control === 'slider'
                                            ? 'mfm__span-2'
                                            : undefined
                                    }
                                >
                                    <FieldLabel>
                                        {def.label}
                                        {def.hint && (
                                            <span className="mfm__hint">（{def.hint}）</span>
                                        )}
                                    </FieldLabel>

                                    {def.control === 'slider' && typeof value === 'number' && (
                                        <div className="mfm__slider">
                                            <Slider
                                                value={value}
                                                min={def.min}
                                                max={def.max}
                                                step={def.step ?? 0.01}
                                                onChange={(v) => setParam(def.key, v)}
                                            />
                                            <span className="mfm__slider-value">{value}</span>
                                        </div>
                                    )}

                                    {def.control === 'number' && (
                                        <InputNumber
                                            className="mfm__input-number"
                                            value={typeof value === 'number' ? value : undefined}
                                            min={def.min}
                                            max={def.max}
                                            step={def.step ?? 1}
                                            onChange={(v) => setParam(def.key, v ?? 0)}
                                        />
                                    )}

                                    {def.control === 'switch' && (
                                        <div className="mfm__control-wrapper">
                                            <Switch
                                                checked={value === true}
                                                onChange={(v) => setParam(def.key, v)}
                                            />
                                        </div>
                                    )}

                                    {def.control === 'select' && (
                                        <Select
                                            value={value as string}
                                            options={def.options as never}
                                            onChange={(v) => setParam(def.key, v)}
                                        />
                                    )}

                                    {def.control === 'checkbox' && (
                                        <Select
                                            mode="multiple"
                                            value={(value as string[]) ?? []}
                                            options={def.options as never}
                                            placeholder="选择支持的输入模态"
                                            onChange={(v) => setParam(def.key, v)}
                                        />
                                    )}

                                    {def.control === 'text' && (
                                        <Input
                                            value={(value as string) ?? ''}
                                            placeholder={def.hint}
                                            onChange={(e) => setParam(def.key, e.target.value)}
                                        />
                                    )}

                                    {def.control === 'textarea' && (
                                        <Input.TextArea
                                            rows={2}
                                            value={(value as string) ?? ''}
                                            onChange={(e) => setParam(def.key, e.target.value)}
                                        />
                                    )}
                                </Field>
                            )
                        })}
                    </div>
                </section>
            </div>
        </Modal>
    )
}
