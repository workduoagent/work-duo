import { Button as AntdButton, type ButtonProps as AntdButtonProps } from 'antd'
import type { ReactNode } from 'react'

// 兼容旧调用：把项目里用过的 variant / size 取值映射到 antd Button。
type LegacyVariant =
  | 'solid'
  | 'soft'
  | 'ghost'
  | 'outline'
  | 'dashed'
  | 'link'
  | 'text'
  | 'filled'
type LegacySize = 'sm' | 'md' | 'lg' | 'icon-sm' | 'icon-md'

export interface ButtonProps extends Omit<AntdButtonProps, 'variant' | 'size'> {
  variant?: LegacyVariant
  size?: LegacySize
  children?: ReactNode
}

function mapVariant(v?: LegacyVariant): Pick<AntdButtonProps, 'type' | 'variant'> {
  switch (v) {
    case 'soft':
      return { type: 'primary', variant: 'filled' }
    case 'ghost':
      return { type: 'text' }
    case 'outline':
      return { variant: 'outlined' }
    case 'link':
      return { type: 'link' }
    case 'text':
      return { type: 'text' }
    case 'dashed':
      return { variant: 'dashed' }
    case 'filled':
      return { variant: 'filled' }
    default:
      // 不传 variant 视为主要操作（蓝色实心）
      return { type: 'primary' }
  }
}

function mapSize(s?: LegacySize): AntdButtonProps['size'] {
  if (s === 'sm' || s === 'icon-sm') return 'small'
  if (s === 'lg') return 'large'
  return 'middle'
}

export function Button({ variant, size, type, ...rest }: ButtonProps) {
  const mapped = mapVariant(variant)
  return (
    <AntdButton
      {...rest}
      type={type ?? mapped.type}
      variant={mapped.variant}
      size={mapSize(size)}
    />
  )
}
