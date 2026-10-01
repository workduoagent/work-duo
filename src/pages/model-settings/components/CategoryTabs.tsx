import type { ReactNode } from 'react'
import {
  MessageSquare,
  Image,
  AudioLines,
  Volume2,
  FunctionSquare,
  Filter,
  Layers,
  Palette,
} from 'lucide-react'
import './CategoryTabs.scss'

/** 模型大类对应的图标（按 value 匹配，未知分类回退 Filter）。 */
const ICON_BY_VALUE: Record<string, ReactNode> = {
  all: <Layers size={18} />,
  text: <MessageSquare size={18} />,
  multimodal: <Image size={18} />,
  stt: <AudioLines size={18} />,
  tts: <Volume2 size={18} />,
  embedding: <FunctionSquare size={18} />,
  rerank: <Filter size={18} />,
  image: <Palette size={18} />,
}
const DEFAULT_ICON: ReactNode = <Filter size={18} />

export interface CategoryOption {
  value: string
  label: string
}

export interface CategoryTabsProps {
  options: CategoryOption[]
  value: string
  onChange: (value: string) => void
  counts?: Partial<Record<string, number>>
}

/** 左侧悬浮纵向分类导航（图标 + 文字 + 数量徽章；悬停 / 选中均有过渡动画）。 */
export function CategoryTabs({ options, value, onChange, counts }: CategoryTabsProps) {
  /** 合并「全部模型」+ 各分类选项 */
  const allOptions: { value: string; label: string }[] = [
    { value: 'all', label: '全部模型' },
    ...options,
  ]
  /** 全部模型的总数 */
  const totalCount = Object.values(counts ?? {}).reduce<number>(
    (sum, n) => sum + (n ?? 0),
    0,
  )

  return (
    <nav className="cat-nav" aria-label="模型分类">
      <div className="cat-nav__title">模型分类</div>
      {allOptions.map((opt) => {
        const isActive = opt.value === value
        const count = opt.value === 'all' ? totalCount : (counts?.[opt.value] ?? 0)
        return (
          <button
            key={opt.value}
            type="button"
            className={`cat-nav__item${isActive ? ' is-active' : ''}`}
            onClick={() => onChange(opt.value)}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="cat-nav__icon">{ICON_BY_VALUE[opt.value] ?? DEFAULT_ICON}</span>
            <span className="cat-nav__label">{opt.label}</span>
            {count > 0 && <span className="cat-nav__badge">{count}</span>}
          </button>
        )
      })}
    </nav>
  )
}
