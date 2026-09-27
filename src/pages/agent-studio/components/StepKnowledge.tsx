/**
 * 向导步骤 6：绑定知识库（第四期 K2）。
 *
 * 从知识库模块已录入的 knowledge_base 取候选，勾选即写入 agent_kb_ref（kb_id → knowledge_base.id）。
 * 绑定后智能体获得 native__kb_search 检索工具（planner 能力大纲同步列出）；未绑定时工具不注册。
 * 布局对齐步骤 4/5：左侧候选卡片网格 + 右侧已绑定汇总（可单个移除）。
 */
import { useEffect, useState } from 'react'
import { BookOpen, Trash2, Check } from 'lucide-react'
import { Button, Checkbox, Spin } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { listKnowledgeBases } from '@/core/mapper/knowledge-mapper'
import type { KnowledgeBase } from '@/types/core'
import type { AgentDraft } from '../draft'

export interface StepKnowledgeProps {
  draft: AgentDraft
  patch: (part: Partial<AgentDraft>) => void
}

export function StepKnowledge({ draft, patch }: StepKnowledgeProps) {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await listKnowledgeBases()
        if (alive) setKbs(list)
      } catch (e) {
        message.error(`加载知识库失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [message])

  const selected = new Set(draft.kbIds)

  function toggle(kbId: string) {
    patch({
      kbIds: selected.has(kbId)
        ? draft.kbIds.filter((id) => id !== kbId)
        : [...draft.kbIds, kbId],
    })
  }

  const kbName = (id: string) => kbs.find((k) => k.id === id)?.name ?? id

  if (loading) {
    return (
      <div className="agent-wizard__loading">
        <Spin />
      </div>
    )
  }

  if (kbs.length === 0) {
    return (
      <div className="agent-wizard__placeholder">
        <BookOpen size={28} />
        <p>还没有任何知识库</p>
        <span>请先在「百宝箱 → 知识库」中创建知识库并导入 md / txt 文档，再来绑定。</span>
      </div>
    )
  }

  return (
    <div className="agent-wizard__picker agent-wizard__picker--two">
      <section className="agent-wizard__picker-main">
        <div className="agent-wizard__picker-head">
          <div>
            <div className="agent-wizard__picker-head-title">知识库</div>
            <div className="agent-wizard__picker-head-desc">
              勾选要绑定给该智能体的知识库（共 {kbs.length} 个）；绑定后智能体获得知识库检索能力
            </div>
          </div>
          <Checkbox
            checked={kbs.length > 0 && kbs.every((k) => selected.has(k.id))}
            indeterminate={
              kbs.some((k) => selected.has(k.id)) && !kbs.every((k) => selected.has(k.id))
            }
            onChange={(e) => {
              patch({ kbIds: e.target.checked ? kbs.map((k) => k.id) : [] })
            }}
          >
            全选
          </Checkbox>
        </div>

        <div className="agent-wizard__skill-grid">
          {kbs.map((kb) => {
            const checked = selected.has(kb.id)
            return (
              <label
                key={kb.id}
                className={`agent-wizard__skill${checked ? ' is-checked' : ''}`}
              >
                <div className="agent-wizard__skill-head">
                  <Checkbox checked={checked} onChange={() => toggle(kb.id)} />
                  <span className="agent-wizard__skill-name">{kb.name}</span>
                </div>
                <code className="agent-wizard__skill-identifier">{kb.identifier}</code>
                <p className="agent-wizard__skill-desc">{kb.description || '暂无简介'}</p>
              </label>
            )
          })}
        </div>
      </section>

      <aside className="agent-wizard__picker-aside agent-wizard__picker-aside--right">
        <div className="agent-wizard__picker-title">
          <span>已绑定知识库（{draft.kbIds.length}）</span>
          {draft.kbIds.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => patch({ kbIds: [] })}>
              清空
            </Button>
          )}
        </div>
        <div className="agent-wizard__picker-list">
          {draft.kbIds.length === 0 && (
            <div className="agent-wizard__empty-hint">尚未绑定任何知识库</div>
          )}
          {draft.kbIds.map((id) => (
            <div key={id} className="agent-wizard__selected-item">
              <Check size={13} className="agent-wizard__selected-check" />
              <span className="agent-wizard__selected-label">{kbName(id)}</span>
              <button
                type="button"
                className="agent-wizard__selected-del"
                onClick={() => patch({ kbIds: draft.kbIds.filter((s) => s !== id) })}
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
