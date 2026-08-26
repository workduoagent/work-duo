import type { ReactNode } from 'react'
import type { ModelCategory } from '@/types/core'
import {
  AudioOutlined,
  FilterOutlined,
  FunctionOutlined,
  MessageOutlined,
  PictureOutlined,
  SoundOutlined,
} from '@ant-design/icons'
import { MODEL_CATEGORY_OPTIONS } from '@/core/file/model-file'
import './CategoryTabs.scss'

const ICONS: Record<ModelCategory, ReactNode> = {
  text: <MessageOutlined />,
  multimodal: <PictureOutlined />,
  stt: <AudioOutlined />,
  tts: <SoundOutlined />,
  embedding: <FunctionOutlined />,
  rerank: <FilterOutlined />,
}

export interface CategoryTabsProps {
  value: ModelCategory
  onChange: (value: ModelCategory) => void
  counts?: Partial<Record<ModelCategory, number>>
}

export function CategoryTabs({ value, onChange, counts }: CategoryTabsProps) {
  return (
    <div className="cat-tabs" role="tablist" aria-label="模型分类">
      {MODEL_CATEGORY_OPTIONS.map((opt) => {
        const isActive = opt.value === value
        const count = counts?.[opt.value] ?? 0
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`cat-tabs__item${isActive ? ' is-active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <span className="cat-tabs__icon">{ICONS[opt.value]}</span>
            <span className="cat-tabs__label">{opt.label}</span>
            {count > 0 && <span className="cat-tabs__badge">{count}</span>}
          </button>
        )
      })}
    </div>
  )
}
