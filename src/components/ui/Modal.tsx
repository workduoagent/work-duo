import { Modal as AntdModal } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import './Modal.scss'

export interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  closeLabel?: string
  /** 弹窗宽度（px 或 CSS 长度），长表单建议 640~720 */
  width?: number | string
  /** 透传 antd Modal 的 style，用于大表单定位（如 { maxWidth }） */
  style?: CSSProperties
  /** 是否垂直水平居中（默认 true）；设 false 则回退 antd 顶部定位 */
  centered?: boolean
}

// 受控封装 antd Modal：open/onOpenChange 与旧 Modal 一致。
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 640,
  style,
  centered = true,
}: ModalProps) {
  const titleNode = description ? (
    <div className="app-modal__title-wrap">
      {title && <div className="app-modal__title">{title}</div>}
      <div className="app-modal__desc">{description}</div>
    </div>
  ) : (
    title
  )

  return (
    <AntdModal
      open={open}
      title={titleNode}
      onCancel={() => onOpenChange(false)}
      footer={footer ?? null}
      width={width}
      style={style}
      centered={centered}
      destroyOnHidden
      maskClosable={false}
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
    >
      {children}
    </AntdModal>
  )
}
