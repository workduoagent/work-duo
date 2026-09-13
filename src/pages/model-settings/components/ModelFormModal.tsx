/**
 * 接入 / 编辑模型的表单弹窗。
 * 结构：基础信息（名称、服务商、Base URL、密钥、模型标识、备注）
 *      + 分类参数（由 paramFields.ts 的字段描述动态渲染，随分类切换）。
 * 新增分类时只需扩展 paramFields.ts 与 model-file.ts 的默认值。
 * 分类参数区复用公共组件 ParamFieldsForm（智能体向导「步骤2 选择模型」用的是同一个）。
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
    Switch,
    SpinnerIcon
} from '@/components/ui'
import {ParamFieldsForm} from '@/components/model/ParamFieldsForm'
import {
    PROVIDER_OPTIONS,
    createEmptyModel,
    MODEL_CATEGORY_OPTIONS,
    type ModelConfig,
} from '@/core/file/model-file'
import {testModelConnection, type ModelTestResult} from '@/utils/modelTest'
import './ModelFormModal.scss'

export interface ModelFormModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** 编辑时传入原模型；新增时传 null */
    model: ModelConfig | null
    /** 新增时使用的分类（编辑时以 model.category 为准） */
    category: string
    onSave: (model: ModelConfig) => Promise<void> | void
}

/** 必填基础字段的校验（通用厂商与讯飞三件套分支） */
function validate(draft: ModelConfig): Set<string> {
    const errors = new Set<string>()
    if (!draft.name.trim()) errors.add('name')
    if (!draft.modelName.trim()) errors.add('modelName')
    if (!draft.baseUrl.trim()) errors.add('baseUrl')
    if (!draft.apiKey.trim()) errors.add('apiKey')
    // 讯飞（iflytek）三件套：AppId + APISecret 同样必填
    if (draft.provider === 'iflytek') {
        if (!draft.appId?.trim()) errors.add('appId')
        if (!draft.apiSecret?.trim()) errors.add('apiSecret')
    }
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
        model ? structuredClone(model) : createEmptyModel(category === 'all' ? 'text' : category),
    )
    const [errors, setErrors] = useState<Set<string>>(new Set())
    const [saving, setSaving] = useState(false)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<ModelTestResult | null>(null)

    // 每次打开时重置草稿（编辑 → 深拷贝原值；新增 → 该分类的默认参数）
    useEffect(() => {
        if (!open) return
        setDraft(model ? structuredClone(model) : createEmptyModel(category === 'all' ? 'text' : category))
        setErrors(new Set())
        setTestResult(null)
    }, [open, model, category])

    const activeCategory = draft.category
    // 讯飞（iflytek）走三件套鉴权（AppId + APIKey + APISecret），凭证块与通用厂商不同
    const isXfyun = draft.provider === 'iflytek'
    // Tool/Function Calling 仅对 LLM 类（纯文本 / 多模态）有意义，故仅这两类展示开关
    const showToolCalls = activeCategory === 'text' || activeCategory === 'multimodal'
    // 分类参数挂在 draft[category] 上；类型上为按需可选，这里统一当记录用
    const paramValues = ((draft as unknown as Record<string, unknown>)[activeCategory] ?? {}) as unknown as Record<string, unknown>

    function patch(part: Partial<ModelConfig>) {
        setDraft((prev) => ({...prev, ...part}))
    }

    // 表单内切换「模型分类」：保留通用字段，新分类参数取「已有值 || 默认」，
    // 旧分类参数保留备用（不删），从而由表单自身控制分类、不再依赖左侧栏。
    function changeCategory(next: string) {
        setDraft((prev) => {
            const base = createEmptyModel(next)
            const merged = {...prev} as unknown as Record<string, unknown>
            const existing = merged[next]
            merged.category = next
            merged[next] = existing ?? (base as unknown as Record<string, unknown>)[next]
            return merged as unknown as ModelConfig
        })
    }

    function setParam(key: string, value: unknown) {
        setDraft((prev) => ({
            ...prev,
            [prev.category]: {
                ...((prev as unknown as Record<string, unknown>)[prev.category] as unknown as Record<string, unknown>),
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
            width={"50%"}
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
                                className={`mfm__test-result mfm__test-result--${testResult.level}`}
                            >
                <span className="mfm__test-dot" />
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
                        <Field className="mfm__span-2">
                            <FieldLabel>模型分类<span className="mfm__required">*</span></FieldLabel>
                            <Select
                                value={draft.category}
                                options={MODEL_CATEGORY_OPTIONS as never}
                                onChange={(v) => changeCategory(v ?? 'text')}
                                placeholder="选择模型分类"
                            />
                        </Field>

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

                        {isXfyun ? (
                            <>
                                <Field className="mfm__span-2">
                                    <FieldLabel>Host URL<span className="mfm__required">*</span></FieldLabel>
                                    <Input
                                        value={draft.baseUrl}
                                        status={errStatus('baseUrl')}
                                        placeholder="讯飞开放平台地址，如 https://tts-api.xfyun.cn/v2/tts 或 https://iat-api.xfyun.cn/v2/iat"
                                        onChange={(e) => patch({baseUrl: e.target.value})}
                                    />
                                    <span className="mfm__hint">TTS 用 tts-api.xfyun.cn/v2/tts；STT 用 iat-api.xfyun.cn/v2/iat。调用走签名 WebSocket，不以 Bearer 传 Key。</span>
                                </Field>

                                <Field>
                                    <FieldLabel>AppId<span className="mfm__required">*</span></FieldLabel>
                                    <Input
                                        value={draft.appId ?? ''}
                                        status={errStatus('appId')}
                                        placeholder="讯飞开放平台 AppId"
                                        onChange={(e) => patch({appId: e.target.value})}
                                    />
                                </Field>

                                <Field>
                                    <FieldLabel>API Key<span className="mfm__required">*</span></FieldLabel>
                                    <Input.Password
                                        value={draft.apiKey}
                                        status={errStatus('apiKey')}
                                        placeholder="讯飞 APIKey"
                                        onChange={(e) => patch({apiKey: e.target.value})}
                                    />
                                </Field>

                                <Field className="mfm__span-2">
                                    <FieldLabel>API Secret<span className="mfm__required">*</span></FieldLabel>
                                    <Input.Password
                                        value={draft.apiSecret ?? ''}
                                        status={errStatus('apiSecret')}
                                        placeholder="讯飞 APISecret"
                                        onChange={(e) => patch({apiSecret: e.target.value})}
                                    />
                                </Field>
                            </>
                        ) : (
                            <>
                                <Field className="mfm__span-2">
                                    <FieldLabel>API Base URL<span className="mfm__required">*</span></FieldLabel>
                                    <Input
                                        value={draft.baseUrl}
                                        status={errStatus('baseUrl')}
                                        placeholder="完整接口地址，如 https://api.openai.com/v1/chat/completions"
                                        onChange={(e) => patch({baseUrl: e.target.value})}
                                    />
                                    <span className="mfm__hint">填写可直接调用的完整地址（含端点路径），不做拼接</span>
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
                            </>
                        )}

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
                    <ParamFieldsForm
                        category={activeCategory}
                        values={paramValues}
                        onChange={setParam}
                        className="mfm__param-grid"
                        fullWidthClassName="mfm__span-2"
                    />
                </section>
            </div>
        </Modal>
    )
}
