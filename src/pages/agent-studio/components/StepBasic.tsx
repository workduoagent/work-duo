/**
 * 向导步骤 1：基本信息。
 *
 * 字段对应 agent_info 的主干列：
 *  - 名称 / 唯一标识（留空或点「重新生成」由系统随机生成）/ 场景分类（scope='AGENT'）；
 *  - 智能体描述（纯文本简介）；
 *  - 人设与指令（system_prompt，走 Markdown 编辑器，编辑 / 预览双模式）；
 *  - 欢迎消息（welcome_message）；
 *  - 头像（选图后以 Base64 data URL 直存 logo 列，未设置时前端回退 lucide 图标）；
 *  - 三个开关：启用状态 / 外部资源自动执行模式 / 是否允许使用沙箱环境。
 *
 * 必填项（名称、唯一标识）标 *，并提供内联校验错误（errors / clearError 由向导下发）。
 */
import { useRef } from 'react'
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Field, FieldLabel, Input, Segmented, Switch } from '@/components/ui'
import type { MemoryMode } from '@/types/core'
import { ScenarioSelect } from '@/components/scenario'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { generateAgentIdentifier } from '@/core/mapper/agent-mapper'
import type { AgentDraft } from '../draft'

export interface StepBasicProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
  /** 字段级校验错误（key: name / identifier），由向导下发 */
  errors?: Record<string, string>
  /** 清除某个字段的校验错误，输入时调用 */
  clearError?: (key: string) => void
}

export function StepBasic({ draft, patch, errors, clearError }: StepBasicProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  function pickLogo(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') patch({ logo: reader.result })
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="agent-wizard__form">
      <Field>
        <FieldLabel>头像</FieldLabel>
        <div className="agent-wizard__logo">
          <div
            className="agent-wizard__logo-preview agent-wizard__logo-upload"
            role="button"
            tabIndex={0}
            title="点击上传 / 更换头像"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileRef.current?.click()
              }
            }}
          >
            {draft.logo ? (
              <img src={draft.logo} alt="头像" className="agent-wizard__logo-img" />
            ) : (
              <div className="agent-wizard__logo-empty">
                <ImagePlus size={22} />
                <span className="agent-wizard__logo-tip">点击上传</span>
              </div>
            )}
            {draft.logo && (
              <button
                type="button"
                className="agent-wizard__logo-clear"
                title="移除头像"
                onClick={(e) => {
                  e.stopPropagation()
                  patch({ logo: undefined })
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => pickLogo(e.target.files?.[0])}
          />
        </div>
        <span className="agent-wizard__hint">点击头像方块即可上传或替换（可选，留空使用默认图标）</span>
      </Field>

      <div className="agent-wizard__grid">
        <Field>
          <FieldLabel htmlFor="agent-name">
            智能体名称<span className="mfm__required">*</span>
          </FieldLabel>
          <Input
            id="agent-name"
            value={draft.name}
            placeholder="如：合同审查助手"
            autoComplete="off"
            status={errors?.name ? 'error' : undefined}
            onChange={(e) => {
              patch({ name: e.target.value })
              clearError?.('name')
            }}
          />
          {errors?.name && <div className="agent-wizard__error">{errors.name}</div>}
        </Field>

        <Field>
          <FieldLabel htmlFor="agent-identifier">
            唯一标识<span className="mfm__required">*</span>
          </FieldLabel>
          <div className="agent-wizard__identifier">
            <Input
              id="agent-identifier"
              value={draft.identifier}
              placeholder="留空将随机生成"
              autoComplete="off"
              status={errors?.identifier ? 'error' : undefined}
              suffix={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw size={14} />}
                  title="重新生成"
                  onClick={() => patch({ identifier: generateAgentIdentifier() })}
                />
              }
              onChange={(e) => {
                patch({ identifier: e.target.value })
                clearError?.('identifier')
              }}
            />
          </div>
          {errors?.identifier && <div className="agent-wizard__error">{errors.identifier}</div>}
        </Field>

        <div className="agent-wizard__switches agent-wizard__span-2">
          <label className="agent-wizard__switch-row">
            <Switch
              size="small"
              checked={draft.isActive}
              onChange={(v) => patch({ isActive: v })}
            />
            <span>
              启用该智能体
              <em className="agent-wizard__hint">关闭后不可调试、不可被调度</em>
            </span>
          </label>
          <label className="agent-wizard__switch-row">
            <Switch
              size="small"
              checked={draft.autoToolExecMode}
              onChange={(v) => patch({ autoToolExecMode: v })}
            />
            <span>
              外部资源自动执行模式
              <em className="agent-wizard__hint">
                开启后，智能体调用已挂载工具时自动执行、不再逐次征求你的确认（是否调用仍由模型自行判断）
              </em>
            </span>
          </label>
          <label className="agent-wizard__switch-row">
            <Switch
              size="small"
              checked={draft.allowSandbox}
              onChange={(v) => patch({ allowSandbox: v })}
            />
            <span>
              允许使用沙箱环境
              <em className="agent-wizard__hint">
                开启后，该智能体在对话中可调用沙箱环境运行代码 / 脚本（默认开启）
              </em>
            </span>
          </label>
          <label className="agent-wizard__switch-row">
            <span className="agent-wizard__switch-label">记忆模式</span>
            <Segmented
              size="small"
              value={draft.memoryMode}
              onChange={(v) => patch({ memoryMode: v as MemoryMode })}
              options={[
                { label: '关闭', value: 'off' },
                { label: '主动', value: 'active' },
                { label: '强制', value: 'forced' },
              ]}
            />
            <em className="agent-wizard__hint">
              关闭=不记忆；主动=模型在对话中自主沉淀可复用信息；强制=每次任务结束引擎必沉淀（确定性，不依赖模型是否主动调用工具）
            </em>
          </label>
        </div>

        <Field>
          <FieldLabel>应用场景</FieldLabel>
          <ScenarioSelect
            scope="AGENT"
            value={draft.scenario}
            onChange={(v) => patch({ scenario: v ?? undefined })}
            placeholder="选择或搜索分类，可回车新建"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="agent-welcome">欢迎消息</FieldLabel>
          <Input
            id="agent-welcome"
            value={draft.welcomeMessage ?? ''}
            placeholder="会话开始时智能体说的第一句话"
            autoComplete="off"
            onChange={(e) => patch({ welcomeMessage: e.target.value })}
          />
        </Field>

        <Field className="agent-wizard__span-2">
          <FieldLabel htmlFor="agent-desc">智能体描述</FieldLabel>
          <Input.TextArea
            id="agent-desc"
            value={draft.description ?? ''}
            placeholder="一句话说明这个智能体是做什么的"
            autoComplete="off"
            rows={2}
            autoSize={{ minRows: 2, maxRows: 5 }}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </Field>
      </div>

        <Field>
          <FieldLabel>人设与指令（system_prompt）</FieldLabel>
          <MarkdownEditor
            value={draft.systemPrompt ?? ''}
            onChange={(v) => patch({ systemPrompt: v })}
            height={300}
            placeholder="用 Markdown 描述智能体的人设、职责边界与回答规范…"
          />
        </Field>
    </div>
  )
}
