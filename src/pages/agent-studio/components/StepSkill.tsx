/**
 * 向导步骤 4：编排 Skill。
 *
 * 从 Skill 模块已录入的 skill_info 取候选，勾选即写入 agent_skill_ref（skills_id → skill_info.id）。
 * 布局与步骤 3 对齐：左侧候选卡片网格 + 右侧已编排汇总（可单个移除）。
 */
import { useEffect, useState } from 'react'
import { Puzzle, Trash2, Check } from 'lucide-react'
import { Spin } from 'antd'
import { Button, Checkbox } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { listSkills } from '@/core/mapper/skill-mapper'
import type { SkillInfo } from '@/core/file/skill-file'
import type { AgentDraft } from '../draft'
import { MAX_SKILLS } from '../draft'

export interface StepSkillProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
}

export function StepSkill({ draft, patch }: StepSkillProps) {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [skills, setSkills] = useState<SkillInfo[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await listSkills()
        if (alive) setSkills(list)
      } catch (e) {
        message.error(`加载技能失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [message])

  const selected = new Set(draft.skillIds)

  function toggle(skillId: string) {
    if (!selected.has(skillId) && draft.skillIds.length >= MAX_SKILLS) {
      message.warning(`编排的 Skill 最多 ${MAX_SKILLS} 个`)
      return
    }
    patch({
      skillIds: selected.has(skillId)
        ? draft.skillIds.filter((id) => id !== skillId)
        : [...draft.skillIds, skillId],
    })
  }

  const skillName = (id: string) => skills.find((s) => s.id === id)?.name ?? id

  if (loading) {
    return (
      <div className="agent-wizard__loading">
        <Spin />
      </div>
    )
  }

  if (skills.length === 0) {
    return (
      <div className="agent-wizard__placeholder">
        <Puzzle size={28} />
        <p>还没有任何技能</p>
        <span>请先在「百宝箱 → Skill」中导入或创建技能，再来为智能体编排。</span>
      </div>
    )
  }

  return (
    <div className="agent-wizard__picker agent-wizard__picker--two">
      <section className="agent-wizard__picker-main">
        <div className="agent-wizard__picker-head">
          <div>
            <div className="agent-wizard__picker-head-title">技能库</div>
            <div className="agent-wizard__picker-head-desc">
              勾选要编排进该智能体的技能（共 {skills.length} 个）
            </div>
          </div>
          <Checkbox
            checked={skills.length > 0 && skills.every((s) => selected.has(s.id))}
            indeterminate={
              skills.some((s) => selected.has(s.id)) && !skills.every((s) => selected.has(s.id))
            }
            onChange={(e) => {
              if (e.target.checked && skills.length > MAX_SKILLS) {
                message.warning(`编排的 Skill 最多 ${MAX_SKILLS} 个`)
                return
              }
              patch({ skillIds: e.target.checked ? skills.map((s) => s.id) : [] })
            }}
          >
            全选
          </Checkbox>
        </div>

        <div className="agent-wizard__skill-grid">
          {skills.map((skill) => {
            const checked = selected.has(skill.id)
            return (
              <label
                key={skill.id}
                className={`agent-wizard__skill${checked ? ' is-checked' : ''}`}
              >
                <div className="agent-wizard__skill-head">
                  <Checkbox checked={checked} onChange={() => toggle(skill.id)} />
                  <span className="agent-wizard__skill-name">{skill.name}</span>
                  {skill.status === 0 && <span className="agent-wizard__skill-tag">已禁用</span>}
                </div>
                <code className="agent-wizard__skill-identifier">{skill.identifier}</code>
                <p className="agent-wizard__skill-desc">{skill.description || '暂无简介'}</p>
              </label>
            )
          })}
        </div>
      </section>

      <aside className="agent-wizard__picker-aside agent-wizard__picker-aside--right">
        <div className="agent-wizard__picker-title">
          <span>已编排技能（{draft.skillIds.length}/{MAX_SKILLS}）</span>
          {draft.skillIds.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => patch({ skillIds: [] })}>
              清空
            </Button>
          )}
        </div>
        <div className="agent-wizard__picker-list">
          {draft.skillIds.length === 0 && (
            <div className="agent-wizard__empty-hint">尚未编排任何技能</div>
          )}
          {draft.skillIds.map((id) => (
            <div key={id} className="agent-wizard__selected-item">
              <Check size={13} className="agent-wizard__selected-check" />
              <span className="agent-wizard__selected-label">{skillName(id)}</span>
              <button
                type="button"
                className="agent-wizard__selected-del"
                onClick={() => patch({ skillIds: draft.skillIds.filter((s) => s !== id) })}
                aria-label="移除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
