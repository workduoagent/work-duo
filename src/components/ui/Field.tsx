import type { ReactNode } from 'react'
import './Field.scss'

/**
 * 轻量表单字段容器（取代 Appica Field / FieldLabel）。
 *
 * F041：新增 `error` / `hint` —— 此前校验失败只能弹顶部 toast（`message.error`），
 * 用户在 1404 行的 SquadEditorModal 里填 10 个字段，错误信息却只在顶部飘一下，
 * 不知道是哪一栏出错。现在错误就地显示在字段下方。
 *
 * 配套：`Input` 系为 antd 直接 re-export（自带 `status` prop），调用方把
 * `!!error` 透传给 Input 即可获得红色边框。
 */
export function Field({
  children,
  className,
  error,
  hint,
}: {
  children?: ReactNode
  className?: string
  /** 校验错误文案；非空时下方渲染 `.app-field__error` 并置 `data-invalid`。 */
  error?: string
  /** 辅助说明（非错误），与 error 同时存在时以 error 优先。 */
  hint?: string
}) {
  return (
    <div
      className={`app-field${className ? ` ${className}` : ''}`}
      data-invalid={error ? 'true' : undefined}
    >
      {children}
      {error ? (
        <span className="app-field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="app-field__hint">{hint}</span>
      ) : null}
    </div>
  )
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
