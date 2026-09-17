/**
 * 向导步骤 1：基本信息。
 *
 * 字段对应 agent_info 的主干列：
 *  - 名称 / 唯一标识（留空或点「重新生成」由系统随机生成）/ 场景分类（scope='AGENT'）；
 *  - 智能体描述（纯文本简介）；
 *  - 人设与指令（system_prompt，走 Markdown 编辑器，编辑 / 预览双模式）；
 *  - 欢迎消息（welcome_message）；
 *  - 形象设计（Pixel Agent）：点击打开设计弹窗，保存时生成 PNG 快照写 logo
 *    （展示源）+ 结构化配置写 appearance（再编辑源）；未设计过时预览按场景预设渲染；
 *  - 行为策略卡片：启用 / 自动执行 / 沙箱 / 记忆模式 / 计划审批。
 *
 * 必填项（名称、唯一标识）标 *，并提供内联校验错误（errors / clearError 由向导下发）。
 */
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, Field, FieldLabel, Input, Segmented, Switch } from '@/components/ui'
import { AppearanceModal, PixelAgent, generateAvatarByScenario } from '@/components/ui/pixel-agent'
import type { MemoryMode, PlanApprovalMode } from '@/types/core'
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
  const [designerOpen, setDesignerOpen] = useState(false)
  // 预览 / 弹窗初始配置：优先草稿已保存的 appearance（再编辑源），
  // 否则按场景预设 + identifier 稳定生成（同一智能体可复现）
  const previewAppearance = draft.appearance ?? generateAvatarByScenario(draft.scenario, draft.identifier)
  // 仅历史 logo（从未用形象设计生成过）：保存形象将覆盖原头像，需提示
  const overrideHint = Boolean(draft.logo) && !draft.appearance

  return (
    <div className="agent-wizard__form">
      {/* 身份：头像 + 名称 / 标识，宽屏并排，窄屏堆叠 */}
      <section className="agent-wizard__identity">
        <Field className="agent-wizard__identity-avatar">
          <FieldLabel>形象</FieldLabel>
          <div
            className="agent-wizard__logo-preview"
            role="button"
            tabIndex={0}
            title="点击进入形象设计"
            onClick={() => setDesignerOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setDesignerOpen(true)
              }
            }}
          >
            {draft.logo ? (
              <img src={draft.logo} alt="形象预览" className="agent-wizard__logo-img" />
            ) : (
              <PixelAgent appearance={previewAppearance} size={96} motion={false} />
            )}
          </div>
          <span className="agent-wizard__hint">
            {overrideHint
              ? '当前为历史头像；保存形象后将生成像素快照替换它'
              : '点击进入形象设计，捏一个专属像素小人'}
          </span>
          <AppearanceModal
            open={designerOpen}
            initial={previewAppearance}
            scenario={draft.scenario}
            seed={draft.identifier}
            onCancel={() => setDesignerOpen(false)}
            onSave={(cfg, logo) => {
              patch({ logo, appearance: cfg })
              setDesignerOpen(false)
            }}
          />
        </Field>

        <div className="agent-wizard__identity-fields">
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
        </div>
      </section>

      {/* 行为策略：开关 / 分段统一成选项卡片，标题横排、永不竖挤 */}
      <section className="agent-wizard__options">
        <div className="agent-wizard__option-card">
          <div className="agent-wizard__option-head">
            <Switch
              size="small"
              checked={draft.isActive}
              onChange={(v) => patch({ isActive: v })}
            />
            <span className="agent-wizard__option-title">启用该智能体</span>
          </div>
          <p className="agent-wizard__option-hint">关闭后不可调试、不可被调度</p>
        </div>

        <div className="agent-wizard__option-card">
          <div className="agent-wizard__option-head">
            <Switch
              size="small"
              checked={draft.autoToolExecMode}
              onChange={(v) => patch({ autoToolExecMode: v })}
            />
            <span className="agent-wizard__option-title">外部资源自动执行</span>
          </div>
          <p className="agent-wizard__option-hint">
            开启后调用已挂载工具时自动执行，不再逐次征求确认（是否调用仍由模型判断）
          </p>
        </div>

        <div className="agent-wizard__option-card">
          <div className="agent-wizard__option-head">
            <Switch
              size="small"
              checked={draft.allowSandbox}
              onChange={(v) => patch({ allowSandbox: v })}
            />
            <span className="agent-wizard__option-title">允许使用沙箱环境</span>
          </div>
          <p className="agent-wizard__option-hint">
            开启后可在对话中调用沙箱运行代码 / 脚本（默认开启）
          </p>
        </div>

        <div className="agent-wizard__option-card agent-wizard__option-card--wide">
          <div className="agent-wizard__option-head">
            <span className="agent-wizard__option-title">记忆模式</span>
          </div>
          <Segmented
            size="small"
            block
            value={draft.memoryMode}
            onChange={(v) => patch({ memoryMode: v as MemoryMode })}
            options={[
              { label: '关闭', value: 'off' },
              { label: '主动', value: 'active' },
              { label: '强制', value: 'forced' },
            ]}
          />
          <p className="agent-wizard__option-hint">
            关闭＝不记忆；主动＝模型在对话中自主沉淀可复用信息；强制＝每次任务结束引擎必沉淀（确定性，不依赖模型是否主动调用）
          </p>
        </div>

        <div className="agent-wizard__option-card agent-wizard__option-card--wide">
          <div className="agent-wizard__option-head">
            <span className="agent-wizard__option-title">计划审批</span>
          </div>
          <Segmented
            size="small"
            block
            value={draft.planAutoApproveMode}
            onChange={(v) => patch({ planAutoApproveMode: v as PlanApprovalMode })}
            options={[
              { label: '总是审批', value: 'always' },
              { label: '仅敏感任务', value: 'sensitive' },
              { label: '从不审批', value: 'never' },
            ]}
          />
          <p className="agent-wizard__option-hint">
            总是审批＝复合任务规划后都需确认；仅敏感任务＝含命令执行 / 删除 / 部署等危险操作才审批，纯文件创建自动放行；从不审批＝规划后直接执行（默认总是审批）
          </p>
        </div>
      </section>

      <Field className="agent-wizard__span-full">
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

      <Field className="agent-wizard__span-full">
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
