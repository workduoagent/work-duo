import type { ReactNode } from 'react'
import type { ModelCategory } from '@/types/core'
import {
  MessageSquare,
  Image,
  AudioLines,
  Volume2,
  FunctionSquare,
  Filter,
} from 'lucide-react'
import { MODEL_CATEGORY_OPTIONS } from '@/core/file/model-file'
import './CategoryTabs.scss'

const ICONS: Record<ModelCategory, ReactNode> = {
  text: <MessageSquare size={18} />,
  multimodal: <Image size={18} />,
  stt: <AudioLines size={18} />,
  tts: <Volume2 size={18} />,
  embedding: <FunctionSquare size={18} />,
  rerank: <Filter size={18} />,
}

export interface CategoryTabsProps {
  value: ModelCategory
  onChange: (value: ModelCategory) => void
  counts?: Partial<Record<ModelCategory, number>>
}

/** 左侧悬浮纵向分类导航（图标 + 文字 + 数量徽章；悬停 / 选中均有过渡动画）。 */
export function CategoryTabs({ value, onChange, counts }: CategoryTabsProps) {
  return (
    <nav className="cat-nav" aria-label="模型分类">
      <div className="cat-nav__title">模型分类</div>
      {MODEL_CATEGORY_OPTIONS.map((opt) => {
        const isActive = opt.value === value
        const count = counts?.[opt.value] ?? 0
        return (
          <button
            key={opt.value}
            type="button"
            className={`cat-nav__item${isActive ? ' is-active' : ''}`}
            onClick={() => onChange(opt.value)}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="cat-nav__icon">{ICONS[opt.value]}</span>
            <span className="cat-nav__label">{opt.label}</span>
            {count > 0 && <span className="cat-nav__badge">{count}</span>}
          </button>
        )
      })}
    </nav>
  )
}
