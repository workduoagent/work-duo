/**
 * 新建 / 编辑技能的表单弹窗。
 * 结构：基础信息（标识符、名称、描述、分类、标签）+ 技能正文（SKILL.md）。
 * 采用与 model-settings 一致的「draft + patch」受控模式，未使用 antd Form。
 */
import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button, Input, Field, FieldLabel, Modal, Select } from '@/components/ui'
import { SKILL_CATEGORY_OPTIONS, createEmptySkill, type SkillInfo } from '@/core/file/skill-file'
import type { SkillCategory } from '@/types/core'

export interface SkillFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑时传入原技能；新增时传 null */
  skill: SkillInfo | null
  onSave: (skill: SkillInfo) => Promise<void> | void
}

/** 必填 / 格式校验 */
function validate(draft: SkillInfo): Set<string> {
  const errors = new Set<string>()
  if (!draft.identifier.trim()) errors.add('identifier')
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(draft.identifier))
    errors.add('identifier-format')
  if (!draft.name.trim()) errors.add('name')
  return errors
}

export function SkillFormModal({
  open,
  onOpenChange,
  skill,
  onSave,
}: SkillFormModalProps) {
  const [draft, setDraft] = useState<SkillInfo>(() =>
    skill ? structuredClone(skill) : createEmptySkill(),
  )
  const [errors, setErrors] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  // 每次打开时重置草稿
  useEffect(() => {
    if (!open) return
    setDraft(skill ? structuredClone(skill) : createEmptySkill())
    setErrors(new Set())
  }, [open, skill])

  function patch(part: Partial<SkillInfo>) {
    setDraft((prev) => ({ ...prev, ...part }))
  }

  async function handleSave() {
    const errs = validate(draft)
    setErrors(errs)
    if (errs.size > 0) return
    setSaving(true)
    try {
      await onSave({ ...draft, updatedAt: new Date().toISOString() })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const hasError = (key: string) =>
    errors.has(key) ? 'error' : undefined

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={720}
      title={skill ? '编辑技能' : '新建技能'}
      description={
        skill
          ? '修改该技能的基础信息与正文。'
          : '填写技能标识与信息；技能正文即 SKILL.md 内容。'
      }
      footer={
        <div className="sk__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={saving} onClick={handleSave}>
            保存
          </Button>
        </div>
      }
    >
      <div className="sk__form">
        <section className="sk__section">
          <h4 className="sk__section-title">基础信息</h4>
          <div className="sk__grid">
            <Field>
              <FieldLabel>
                标识符 (identifier)<span className="sk__required">*</span>
              </FieldLabel>
              <Input
                value={draft.identifier}
                disabled={!!skill}
                status={
                  hasError('identifier') || hasError('identifier-format')
                    ? 'error'
                    : undefined
                }
                placeholder="如 doc-polish（仅小写字母、数字、连字符）"
                onChange={(e) => patch({ identifier: e.target.value })}
              />
              {errors.has('identifier-format') && (
                <div className="sk__field-error">
                  标识符仅允许小写字母、数字与连字符，且不能以连字符开头
                </div>
              )}
            </Field>

            <Field>
              <FieldLabel>
                技能名称<span className="sk__required">*</span>
              </FieldLabel>
              <Input
                value={draft.name}
                status={hasError('name')}
                placeholder="如 文档润色"
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>

            <Field className="sk__span-2">
              <FieldLabel>描述</FieldLabel>
              <Input.TextArea
                rows={2}
                value={draft.description ?? ''}
                placeholder="一句话描述这个技能的能力"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>

            <Field>
              <FieldLabel>技能分类 (scenario)</FieldLabel>
              <Select
                value={draft.scenario}
                options={SKILL_CATEGORY_OPTIONS as never}
                allowClear
                placeholder="选择分类"
                onChange={(v) => patch({ scenario: (v as SkillCategory) ?? undefined })}
              />
            </Field>

            <Field>
              <FieldLabel>标签</FieldLabel>
              <Select
                mode="tags"
                value={draft.tags ?? []}
                placeholder="输入后回车，如 文档润色"
                tokenSeparators={[',']}
                onChange={(v) => patch({ tags: v as string[] })}
              />
            </Field>
          </div>
        </section>

        <section className="sk__section">
          <h4 className="sk__section-title">技能正文 (SKILL.md)</h4>
          <Field>
            <FieldLabel>
              <BookOpen size={14} className="sk__inline-icon" />
              指令内容
            </FieldLabel>
            <Input.TextArea
              rows={12}
              value={draft.instruction ?? ''}
              placeholder="编写技能的主体指令 / 工作流（Markdown 兼容）"
              onChange={(e) => patch({ instruction: e.target.value })}
            />
          </Field>
        </section>
      </div>
    </Modal>
  )
}
