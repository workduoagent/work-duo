import { Card as AntdCard } from 'antd'
import type { CardProps as AntdCardProps } from 'antd'
import type { ReactNode } from 'react'
import './Card.scss'

// 兼容旧 Compound API（CardHeader/CardTitle/CardDescription/CardFooter），
// 内部渲染为语义 div，由 Card.scss 接管视觉；底层仍是 antd Card。
export interface CardProps extends Omit<AntdCardProps, 'variant'> {
  /** 视觉形态：'solid' = 浅底描边卡片（替代旧 filled），'ghost' = 无边框 */
  frame?: 'solid' | 'ghost'
  /** 可选覆盖 antd variant（仅 'outlined' | 'borderless'） */
  variant?: 'outlined' | 'borderless'
  className?: string
}

function cx(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(' ')
}

export function Card({ frame, className, variant, children, ...rest }: CardProps) {
  // 当前 antd 版本（5.29）Card.variant 仅支持 outlined / borderless，
  // 'solid' 用 className 实现浅底，避免依赖尚未支持的 'filled'。
  const resolvedVariant =
    variant ?? (frame === 'ghost' ? 'borderless' : 'outlined')
  const cls = cx(
    'app-card',
    frame === 'solid' && 'app-card--solid',
    className,
  )
  return (
    <AntdCard {...rest} variant={resolvedVariant} className={cls}>
      {children}
    </AntdCard>
  )
}

export function CardHeader({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return <div className={cx('app-card__header', className)}>{children}</div>
}

export function CardTitle({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return <div className={cx('app-card__title', className)}>{children}</div>
}

export function CardDescription({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('app-card__description', className)}>{children}</div>
  )
}

export function CardFooter({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return <div className={cx('app-card__footer', className)}>{children}</div>
}

export function CardMedia({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return <div className={cx('app-card__media', className)}>{children}</div>
}
