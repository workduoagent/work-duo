/**
 * 智能体新建 / 编辑向导（路由 /agent-studio/new 与 /agent-studio/:id/edit 共用）。
 *
 * 按用户设计：新建与编辑都不再用弹窗表单，而是「像详情页一样的整页向导」，共 4 步：
 *   1 基本信息 → 2 选择模型 → 3 配置 MCP → 4 编排 Skill
 * 四个步骤只改同一份草稿（draft.ts），点保存时一次性写主表 + 两张关联表。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, Save, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  getAgent,
  listAgentMcpTools,
  listAgentSkills,
  upsertAgent,
  generateAgentIdentifier,
} from '@/core/mapper/agent-mapper'
import { listModels } from '@/core/mapper/model-mapper'
import type { ModelConfig } from '@/core/file/model-file'
import { StepBasic } from './components/StepBasic'
import { StepModel } from './components/StepModel'
import { StepMcp } from './components/StepMcp'
import { StepSkill } from './components/StepSkill'
import { createEmptyDraft, draftFromAgent, draftToInput, type AgentDraft } from './draft'
import './wizard.scss'

const STEPS = [
  { key: 'basic', title: '基本信息', desc: '名称、人设、头像' },
  { key: 'model', title: '选择模型', desc: '大脑 / 嘴巴 / 耳朵' },
  { key: 'mcp', title: '配置 MCP', desc: '按工具粒度挂载' },
  { key: 'skill', title: '编排 Skill', desc: '技能编排' },
] as const

const IDENTIFIER_RE = /^[a-zA-Z0-9_-]+$/

export default function AgentWizardPage() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { message } = useNotify()
  const isEdit = Boolean(id)

  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [models, setModels] = useState<ModelConfig[]>([])
  const [draft, setDraft] = useState<AgentDraft>(() =>
    createEmptyDraft(generateAgentIdentifier()),
  )
  /** 字段级校验错误（key: name / identifier / llm），由步骤组件内联展示 */
  const [errors, setErrors] = useState<Record<string, string>>({})

  const patch = useCallback((part: Partial<AgentDraft>) => {
    setDraft((prev) => ({ ...prev, ...part }))
  }, [])

  const clearError = useCallback((key: string) => {
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [modelList] = await Promise.all([listModels()])
        if (!alive) return
        setModels(modelList)

        if (id) {
          const [agent, mcpRefs, skillRefs] = await Promise.all([
            getAgent(id),
            listAgentMcpTools(id),
            listAgentSkills(id),
          ])
          if (!alive) return
          if (!agent) {
            message.error('智能体不存在或已被删除')
            navigate('/agent-studio', { replace: true })
            return
          }
          setDraft(draftFromAgent(agent, mcpRefs, skillRefs))
        }
      } catch (e) {
        message.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [id, message, navigate])

  /** 步骤级校验：把错误写入 errors（内联展示），返回 false 时阻止进入下一步 */
  function validateStep(target: number): boolean {
    const errs: Record<string, string> = {}
    if (target > 0) {
      if (!draft.name.trim()) errs.name = '请填写智能体名称'
      const identifier = draft.identifier.trim() || generateAgentIdentifier()
      if (!IDENTIFIER_RE.test(identifier)) errs.identifier = '唯一标识仅允许字母、数字、- 和 _'
      if (identifier !== draft.identifier) patch({ identifier })
    }
    if (target > 1 && !draft.llmId) errs.llm = '请先选择大脑（LLM 模型）'
    setErrors(errs)
    const ok = Object.keys(errs).length === 0
    if (!ok) message.warning(errs.name || errs.identifier || errs.llm)
    return ok
  }

  function goNext() {
    if (step >= STEPS.length - 1) return
    if (!validateStep(step + 1)) return
    setStep(step + 1)
  }

  function goPrev() {
    setStep((s) => Math.max(0, s - 1))
  }

  async function handleSave() {
    if (!validateStep(STEPS.length)) return
    setSaving(true)
    try {
      await upsertAgent(draftToInput(draft, id))
      message.success(isEdit ? '智能体已更新' : `已创建智能体「${draft.name.trim()}」`)
      navigate('/agent-studio')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      message.error(
        msg.toLowerCase().includes('unique')
          ? `唯一标识「${draft.identifier}」已被占用，请换一个`
          : `保存失败：${msg}`,
      )
    } finally {
      setSaving(false)
    }
  }

  const stepper = useMemo(
    () => (
      <ol className="agent-wizard__steps">
        {STEPS.map((s, i) => {
          const state = i === step ? 'is-current' : i < step ? 'is-done' : ''
          return (
            <li
              key={s.key}
              className={`agent-wizard__step ${state}`}
              onClick={() => i < step && setStep(i)}
            >
              <span className="agent-wizard__step-index">
                {i < step ? <Check size={13} /> : i + 1}
              </span>
              <span className="agent-wizard__step-text">
                <strong>{s.title}</strong>
                <em>{s.desc}</em>
              </span>
            </li>
          )
        })}
      </ol>
    ),
    [step],
  )

  if (loading && isEdit) {
    return <div className="agent-wizard agent-wizard--loading">加载中…</div>
  }

  return (
    <div className="agent-wizard">
      <header className="agent-wizard__head">
        <div className="agent-wizard__head-top">
          <div className="agent-wizard__head-left">
            <Button variant="ghost" size="sm" onClick={() => navigate('/agent-studio')}>
              <ArrowLeft size={15} />
              返回列表
            </Button>
            <h2 className="agent-wizard__title">{isEdit ? '编辑智能体' : '新建智能体'}</h2>
            {isEdit && <code className="agent-wizard__identifier-tag">{draft.identifier}</code>}
          </div>
          <div className="agent-wizard__head-actions">
            <Button variant="soft" size="sm" onClick={() => navigate('/agent-studio')}>
              取消
            </Button>
            <Button variant="solid" size="sm" loading={saving} onClick={handleSave}>
              <Save size={14} />
              保存
            </Button>
          </div>
        </div>
        {stepper}
      </header>

      <div className="agent-wizard__body">
        {step === 0 && (
          <StepBasic draft={draft} patch={patch} errors={errors} clearError={clearError} />
        )}
        {step === 1 && (
          <StepModel
            draft={draft}
            patch={patch}
            models={models}
            errors={errors}
            clearError={clearError}
          />
        )}
        {step === 2 && <StepMcp draft={draft} patch={patch} />}
        {step === 3 && <StepSkill draft={draft} patch={patch} />}
      </div>

      <button
        type="button"
        className="agent-wizard__nav agent-wizard__nav--prev"
        aria-label="上一步"
        disabled={step === 0}
        onClick={goPrev}
      >
        <ChevronLeft size={20} />
      </button>
      <button
        type="button"
        className="agent-wizard__nav agent-wizard__nav--next"
        aria-label="下一步"
        disabled={step >= STEPS.length - 1}
        onClick={goNext}
      >
        <ChevronRight size={20} />
      </button>
    </div>
  )
}
