import { Modal as AntdModal } from 'antd'
import type { ReactNode } from 'react'
import './Modal.scss'

export interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  closeLabel?: string
}

// 受控封装 antd Modal：open/onOpenChange 与旧 Modal 一致。
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
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
      destroyOnClose
      maskClosable={false}
    >
      {children}
    </AntdModal>
  )
}
