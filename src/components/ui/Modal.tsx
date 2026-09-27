import { Modal as AntdModal } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from './Button'
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
  /** 确认式底栏（台账 S12 ①）：提供 onOk 时渲染「取消 | 确定」标准底栏（footer 显式提供时优先于本组） */
  onOk?: () => void
  okText?: ReactNode
  cancelText?: ReactNode
  /** 确定按钮加载态（受控：确认动作完成后由调用方关闭弹窗） */
  confirmLoading?: boolean
  /** 危险动作（确定按钮红色） */
  okDanger?: boolean
  /** 取消动作（底栏取消按钮与右上 X / Esc / 遮罩共用）；未提供时走 onOpenChange(false) */
  onCancel?: () => void
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
  onOk,
  okText = '确定',
  cancelText = '取消',
  confirmLoading = false,
  okDanger = false,
  onCancel,
}: ModalProps) {
  const titleNode = description ? (
    <div className="app-modal__title-wrap">
      {title && <div className="app-modal__title">{title}</div>}
      <div className="app-modal__desc">{description}</div>
    </div>
  ) : (
    title
  )

  const handleCancel = () => {
    if (onCancel) onCancel()
    else onOpenChange(false)
  }

  // 确认式底栏：仅当未显式传 footer 且提供 onOk 时渲染。
  const confirmFooter =
    footer !== undefined || onOk === undefined ? undefined : (
      <div className="app-modal__confirm-footer">
        <Button variant="outline" onClick={handleCancel}>
          {cancelText}
        </Button>
        <Button variant="solid" loading={confirmLoading} danger={okDanger} onClick={onOk}>
          {okText}
        </Button>
      </div>
    )

  return (
    <AntdModal
      open={open}
      title={titleNode}
      onCancel={handleCancel}
      footer={confirmFooter ?? footer ?? null}
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
