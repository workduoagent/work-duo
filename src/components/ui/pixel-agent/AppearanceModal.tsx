/**
 * 形象设计弹窗 v3（游戏角色创建器式三栏布局）：
 *
 *   ┌───────────┬──────────┬────────────────────┐
 *   │  预览区    │ 大分类    │ 选项面板            │
 *   │  像素小人  │ 形象基础  │  选项卡片（含预览）  │
 *   │  + 动作试玩 │ 发型发色  │  色块网格            │
 *   │           │ 服饰(级联) │                     │
 *   │           │ 配饰/道具  │                     │
 *   └───────────┴──────────┴────────────────────┘
 *
 * 保存语义不变：快照成功才调 onSave(next, logoDataUrl)；失败 message.error 保持打开。
 */
import { useEffect, useState } from 'react'
import { Briefcase, Glasses, Scissors, Shirt, UserRound } from 'lucide-react'
import { Button, Modal, Segmented } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { normalizeAppearance } from './parse'
import { snapshotAppearanceToLogo } from './snapshot'
import { PixelAgent } from './PixelAgent'
import { AppearancePicker, type DesignerSection } from './AppearancePicker'
import type { AgentMotionState, PixelAgentAppearance } from './types'
import './AppearanceModal.scss'

export interface AppearanceModalProps {
  open: boolean
  /** 打开时的初始配置（调用方已按 draft.appearance ?? 场景预设 备好） */
  initial: PixelAgentAppearance
  scenario?: string
  /** 稳定种子（建议 identifier），供「按场景推荐」复现 */
  seed?: string
  onCancel: () => void
  /** 仅当快照成功后调用 */
  onSave: (next: PixelAgentAppearance, logoDataUrl: string) => void
}

const SECTIONS: Array<{ key: DesignerSection; label: string; icon: typeof UserRound }> = [
  { key: 'base', label: '形象基础', icon: UserRound },
  { key: 'hair', label: '发型发色', icon: Scissors },
  { key: 'outfit', label: '服饰', icon: Shirt },
  { key: 'accessory', label: '配饰', icon: Glasses },
  { key: 'prop', label: '道具', icon: Briefcase },
]

export function AppearanceModal({
  open,
  initial,
  scenario,
  seed,
  onCancel,
  onSave,
}: AppearanceModalProps) {
  const { message } = useNotify()
  const [draft, setDraft] = useState<PixelAgentAppearance>(() => normalizeAppearance(initial))
  const [state, setState] = useState<AgentMotionState>('idle')
  const [saving, setSaving] = useState(false)
  const [section, setSection] = useState<DesignerSection>('base')

  // 每次打开以调用方给的 initial 重置（外部 initial 引用变化不覆盖编辑中的草稿）
  useEffect(() => {
    if (open) {
      setDraft(normalizeAppearance(initial))
      setState('idle')
      setSaving(false)
      setSection('base')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSave = async () => {
    setSaving(true)
    try {
      const logo = await snapshotAppearanceToLogo(draft, { outSize: 128 })
      onSave(draft, logo)
    } catch (e) {
      message.error(`生成形象快照失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) onCancel()
      }}
      title="形象设计"
      description="捏一个专属像素小人：保存后生成 PNG 快照写入头像，配置可反复回来改"
      width={920}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button variant="solid" loading={saving} onClick={() => void handleSave()}>
            保存形象
          </Button>
        </>
      }
    >
      <div className="pixel-modal">
        {/* 预览区 */}
        <div className="pixel-modal__preview">
          <div className="pixel-modal__stage">
            <PixelAgent appearance={draft} state={state} size={192} motion />
          </div>
          <div className="pixel-modal__play">
            <span className="pixel-modal__play-label">动作试玩（不影响保存）</span>
            <Segmented
              size="small"
              value={state}
              onChange={(v) => setState(v as AgentMotionState)}
              options={[
                { label: '待机', value: 'idle' },
                { label: '工作', value: 'working' },
                { label: '思考', value: 'thinking' },
                { label: '出错', value: 'error' },
              ]}
            />
          </div>
        </div>

        {/* 大分类导航 */}
        <nav className="pixel-modal__nav">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            return (
              <button
                key={s.key}
                type="button"
                className={`pixel-modal__nav-item${section === s.key ? ' is-active' : ''}`}
                onClick={() => setSection(s.key)}
              >
                <Icon size={15} />
                <span>{s.label}</span>
              </button>
            )
          })}
        </nav>

        {/* 选项面板 */}
        <div className="pixel-modal__panel">
          <AppearancePicker
            section={section}
            value={draft}
            onChange={setDraft}
            scenario={scenario}
            seed={seed}
          />
        </div>
      </div>
    </Modal>
  )
}
