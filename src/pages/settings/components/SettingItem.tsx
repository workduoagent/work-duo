import type { ReactNode } from 'react'

interface SettingItemProps {
  /** 标题（必填） */
  title: ReactNode
  /** 描述 / 补充说明（可选） */
  description?: ReactNode
  /** 右侧控件（开关 / 输入 / 下拉等）；无右侧控件时省略 */
  control?: ReactNode
  /** 标题下方额外铺满的内容（如手动代理的输入组），与 control 互斥时通常省略 control */
  children?: ReactNode
}

/**
 * 设置项统一排版：左文案 + 右控件，移动端自动堆叠。
 * 仅承载布局，状态由调用方通过 control / children 注入。
 */
export function SettingItem({ title, description, control, children }: SettingItemProps) {
  return (
    <div className="set-item">
      <div className="set-item__head">
        <div className="set-item__text">
          <div className="set-item__title">{title}</div>
          {description && <div className="set-item__desc">{description}</div>}
        </div>
        {control != null && <div className="set-item__control">{control}</div>}
      </div>
      {children && <div className="set-item__body">{children}</div>}
    </div>
  )
}
