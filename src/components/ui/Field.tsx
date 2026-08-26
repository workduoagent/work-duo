import type { ReactNode } from 'react'
import './Field.scss'

// 轻量表单字段容器（取代 Appica Field / FieldLabel）。
export function Field({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) {
  return <div className={`app-field${className ? ` ${className}` : ''}`}>{children}</div>
}

export function FieldLabel({
  children,
  className,
  htmlFor,
}: {
  children?: ReactNode
  className?: string
  htmlFor?: string
}) {
  return (
    <label
      className={`app-field__label${className ? ` ${className}` : ''}`}
      htmlFor={htmlFor}
    >
      {children}
    </label>
  )
}
