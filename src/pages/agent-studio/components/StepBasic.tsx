/**
 * 向导步骤 1：基本信息。
 *
 * 字段对应 agent_info 的主干列：
 *  - 名称 / 唯一标识（留空或点「重新生成」由系统随机生成）/ 场景分类（scope='AGENT'）；
 *  - 智能体描述（纯文本简介）；
 *  - 人设与指令（system_prompt，走 Markdown 编辑器，编辑 / 预览双模式）；
 *  - 欢迎消息（welcome_message）；
 *  - 头像（Base64 data URL 直存 logo 列，未设置时前端回退 lucide 图标，不落盘文件）；
 *  - 启用状态 / 外部资源自动执行模式 两个开关。
 */
import { useRef } from 'react'
import { Bot, ImagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Field, FieldLabel, Input, Switch } from '@/components/ui'
import { ScenarioSelect } from '@/components/scenario'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { generateAgentIdentifier } from '@/core/mapper/agent-mapper'
import type { AgentDraft } from '../draft'

export interface StepBasicProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
}

export function StepBasic({ draft, patch }: StepBasicProps) {
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
      <div className="agent-wizard__grid">
        <Field>
          <FieldLabel htmlFor="agent-name">智能体名称</FieldLabel>
          <Input
            id="agent-name"
            value={draft.name}
            placeholder="如：合同审查助手"
            autoComplete="off"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="agent-identifier">唯一标识</FieldLabel>
          <div className="agent-wizard__identifier">
            <Input
              id="agent-identifier"
              value={draft.identifier}
              placeholder="留空将随机生成"
              autoComplete="off"
              onChange={(e) => patch({ identifier: e.target.value })}
            />
            <Button
              variant="soft"
              size="sm"
              title="重新生成"
              onClick={() => patch({ identifier: generateAgentIdentifier() })}
            >
              <RefreshCw size={14} />
              重新生成
            </Button>
          </div>
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

      <div className="agent-wizard__row">
        <Field>
          <FieldLabel>头像</FieldLabel>
          <div className="agent-wizard__logo">
            <div className="agent-wizard__logo-preview">
              {draft.logo ? (
                <img src={draft.logo} alt="头像" className="agent-wizard__logo-img" />
              ) : (
                <div className="agent-wizard__logo-empty">
                  <Bot size={20} />
                </div>
              )}
            </div>
            <div className="agent-wizard__logo-actions">
              <Button variant="soft" size="sm" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={14} />
                选择图片
              </Button>
              {draft.logo && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="agent-wizard__logo-del"
                  onClick={() => patch({ logo: undefined })}
                >
                  <Trash2 size={14} />
                  移除
                </Button>
              )}
              <span className="agent-wizard__hint">以 Base64 存入 logo 列，未设置时显示默认图标</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => pickLogo(e.target.files?.[0])}
            />
          </div>
        </Field>
      </div>

      <div className="agent-wizard__switches">
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
            <em className="agent-wizard__hint">开启后调用已挂载的 MCP 工具不再逐次确认</em>
          </span>
        </label>
      </div>
    </div>
  )
}
