/**
 * 向导步骤 2：选择模型（大脑 / 嘴巴 / 耳朵）。
 *
 * 从 LLM 模块已录入的 models 表取候选：
 *  - 大脑 LLM：纯文本 text + 多模态 multimodal（必选，对应 agent_info.llm_id / llm_config）；
 *  - 嘴巴 TTS：tts（可选，对应 tts_id / tts_config）；
 *  - 耳朵 STT：stt（可选，对应 stt_id / stt_config）。
 *
 * 参数语义（与用户设计一致）：models.config 只是「初始默认值」，
 * 这里选中模型后把它的分类参数复制一份到智能体的 *_config，之后改的是智能体私有副本。
 */
import type { ReactNode } from 'react'
import { Cpu, Ear, Mic, RotateCcw } from 'lucide-react'
import { Button, Card, Field, FieldLabel, Select } from '@/components/ui'
import { ParamFieldsForm } from '@/components/model/ParamFieldsForm'
import type { ModelConfig } from '@/core/file/model-file'
import type { AgentDraft } from '../draft'

export interface StepModelProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
  /** 候选模型（由向导一次性加载，步骤内不再查库） */
  models: ModelConfig[]
}

type SlotKey = 'llm' | 'tts' | 'stt'

interface SlotDef {
  key: SlotKey
  title: string
  desc: string
  categories: string[]
  icon: ReactNode
  required?: boolean
}

const SLOTS: SlotDef[] = [
  {
    key: 'llm',
    title: '大脑',
    desc: '决定智能体的理解与推理能力（纯文本 / 多模态）',
    categories: ['text', 'multimodal'],
    icon: <Cpu size={16} />,
    required: true,
  },
  {
    key: 'tts',
    title: '嘴巴',
    desc: '把回答合成为语音（不选则只能文字输出）',
    categories: ['tts'],
    icon: <Mic size={16} />,
  },
  {
    key: 'stt',
    title: '耳朵',
    desc: '把语音转写成文字（不选则只能文字输入）',
    categories: ['stt'],
    icon: <Ear size={16} />,
  },
]

/** 取模型在该分类下的参数对象（models.config 反序列化后挂在 model[category] 上） */
function modelParams(model: ModelConfig): Record<string, unknown> {
  const raw = (model as unknown as Record<string, unknown>)[model.category]
  if (raw && typeof raw === 'object') return { ...(raw as Record<string, unknown>) }
  return {}
}

/** 读取某槽位当前的「模型 id / 参数副本」 */
function readSlot(
  draft: AgentDraft,
  slot: SlotKey,
): { modelId?: string; config?: Record<string, unknown> } {
  if (slot === 'llm') return { modelId: draft.llmId, config: draft.llmConfig }
  if (slot === 'tts') return { modelId: draft.ttsId, config: draft.ttsConfig }
  return { modelId: draft.sttId, config: draft.sttConfig }
}

/** 写入某槽位（模型 id 与参数副本一次写入，保证两者不脱节） */
function patchSlot(
  patch: (part: Partial<AgentDraft>) => void,
  slot: SlotKey,
  modelId: string | undefined,
  config: Record<string, unknown> | undefined,
): void {
  if (slot === 'llm') patch({ llmId: modelId, llmConfig: config })
  else if (slot === 'tts') patch({ ttsId: modelId, ttsConfig: config })
  else patch({ sttId: modelId, sttConfig: config })
}

export function StepModel({ draft, patch, models }: StepModelProps) {
  function handleSelect(slot: SlotKey, modelId: string | undefined) {
    if (!modelId) {
      patchSlot(patch, slot, undefined, undefined)
      return
    }
    const model = models.find((m) => m.id === modelId)
    const current = readSlot(draft, slot).config
    // 切换模型：该槽位还没有参数副本时，复制模型默认参数；已有副本则保留用户调过的值
    const nextConfig =
      model && (!current || Object.keys(current).length === 0) ? modelParams(model) : current
    patchSlot(patch, slot, modelId, nextConfig)
  }

  function resetParams(slot: SlotKey) {
    const { modelId } = readSlot(draft, slot)
    const model = models.find((m) => m.id === modelId)
    if (!model) return
    patch({ ...emptySlotPatch(slot, modelParams(model)) })
  }

  function setParam(slot: SlotKey, key: string, value: unknown) {
    const { config } = readSlot(draft, slot)
    patch({ ...emptySlotPatch(slot, { ...(config ?? {}), [key]: value }) })
  }

  /** 只改参数副本、不动模型 id 的补丁 */
  function emptySlotPatch(
    slot: SlotKey,
    config: Record<string, unknown>,
  ): Partial<AgentDraft> {
    if (slot === 'llm') return { llmConfig: config }
    if (slot === 'tts') return { ttsConfig: config }
    return { sttConfig: config }
  }

  return (
    <div className="agent-wizard__slots">
      {SLOTS.map((slot) => {
        const options = models
          .filter((m) => slot.categories.includes(m.category))
          .map((m) => ({
            value: m.id,
            label: m.enabled
              ? `${m.name} · ${m.modelName}`
              : `${m.name} · ${m.modelName}（已禁用）`,
          }))
        const { modelId, config } = readSlot(draft, slot.key)
        const model = models.find((m) => m.id === modelId)
        return (
          <Card frame="solid" key={slot.key} className="agent-wizard__slot">
            <div className="agent-wizard__slot-head">
              <div className="agent-wizard__slot-icon">{slot.icon}</div>
              <div className="agent-wizard__slot-titles">
                <div className="agent-wizard__slot-title">
                  {slot.title}
                  {slot.required && <span className="agent-wizard__required">必选</span>}
                </div>
                <div className="agent-wizard__slot-desc">{slot.desc}</div>
              </div>
            </div>

            <Field>
              <FieldLabel>选择模型</FieldLabel>
              <Select
                value={modelId}
                allowClear
                placeholder={
                  options.length ? '选择已录入的模型' : '暂无该类型模型，请先到 LLM 模块录入'
                }
                options={options}
                onChange={(v) => handleSelect(slot.key, v)}
              />
            </Field>

            {model && (
              <>
                <div className="agent-wizard__param-head">
                  <span>模型参数（改的是智能体私有副本，不影响 LLM 模块的默认值）</span>
                  <Button variant="ghost" size="sm" onClick={() => resetParams(slot.key)}>
                    <RotateCcw size={13} />
                    恢复默认
                  </Button>
                </div>
                <ParamFieldsForm
                  category={model.category}
                  values={config ?? {}}
                  onChange={(key, v) => setParam(slot.key, key, v)}
                  className="agent-wizard__param-grid"
                  fullWidthClassName="agent-wizard__span-2"
                />
              </>
            )}
          </Card>
        )
      })}
    </div>
  )
}
