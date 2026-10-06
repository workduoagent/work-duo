import type { ReactNode } from 'react'
import { Alert, Button, Empty, Spin } from './index'
import './ListState.scss'

/**
 * 列表页三态容器（F046）。
 *
 * 背景：此前各列表页自行处理「加载中 / 空/ 加载失败」，导致三种退化形态：
 *  1. 加载失败时`message.error` 后 `list` 保持空数组 → 页面显示「空列表」，
 *     **用户以为「没有数据」而不是「加载失败」**，排查方向从一开始就跑偏；
 *  2. 有的页面只有 loading、有的只有 Empty，各写一套（`settings` / `model-settings`
 *    / `mcp-hub` 三处连 Empty 都没有，空数据时是白屏）；
 *  3. 失败后没有重试入口，只能刷新页面。
 *
 * 本组件统一三态，并**保持既有布局**（`className` / `style` 透传给容器），
 * 因此接入方只需把原来的条件渲染换成 `<ListState>`，视觉零变化。
 */
export interface ListStateProps {
  /** 是否正在加载 */
  loading?: boolean
  /** 加载错误（传 Error 或字符串）；非空时优先于空态展示 */
  error?: Error | string | null
  /** 数据是否为空（`loading` 为 false 且无错误时生效） */
  empty?: boolean
  /** 空态描述 */
  emptyText?: string
  /** 加载中 / 空态的自定义文案（可选） */
  loadingText?: string
  /** 重试回调；提供时错误态显示「重试」按钮 */
  onRetry?: () => void
  /** 容器类名（沿用调用方原有布局类，避免接入后样式变化） */
  className?: string
  /** 内容区高度（空态/错误态时撑开布局，避免跳动） */
  minHeight?: number | string
  children?: ReactNode
}

export function ListState({
  loading,
  error,
  empty,
  emptyText = '暂无数据',
  loadingText,
  onRetry,
  className,
  minHeight = 160,
  children,
}: ListStateProps) {
  const style = minHeight != null ? { minHeight } : undefined

  // 错误优先：即使数据为空也要先告诉用户「是加载失败」，否则会被误读为「没有数据」
  if (error) {
    const msg = typeof error === 'string' ? error : error.message
    return (
      <div className={`app-list-state${className ? ` ${className}` : ''}`} style={style}>
        <Alert
          type="error"
          showIcon
          message="加载失败"
          description={
            <div className="app-list-state__err">
              <span>{msg}</span>
              {onRetry && (
                <Button size="sm" variant="soft" onClick={onRetry}>
                  重试
                </Button>
              )}
            </div>
          }
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div className={`app-list-state${className ? ` ${className}` : ''}`} style={style}>
        <Spin spinning wrapperClassName="app-list-state__spin">
          {/* 保留 children 占位，避免 loading→内容 切换时布局塌陷 */}
          <div className="app-list-state__loading-text">{loadingText ?? ''}</div>
        </Spin>
        {children}
      </div>
    )
  }

  if (empty) {
    return (
      <div className={`app-list-state${className ? ` ${className}` : ''}`} style={style}>
        <Empty description={emptyText} />
        {children}
      </div>
    )
  }

  // 正常态也保留容器（而非Fragment）：这样 className / minHeight 在三态下一致生效，
  // 接入方只需写一次布局类，不必为三态各写一遍。
  return (
    <div
      className={`app-list-state${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </div>
  )
}
