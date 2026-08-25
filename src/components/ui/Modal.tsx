import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
} from '@appica/ui-react/dialog'
import { Button } from '@appica/ui-react/button'

export interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  closeLabel?: string
}

// Thin, controlled wrapper over Appica's Dialog so pages don't repeat the
// compound boilerplate.
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel = '关闭',
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {(title || description) && (
          <DialogHeader>
            {title && <DialogTitle>{title}</DialogTitle>}
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
        )}
        {children && <DialogBody>{children}</DialogBody>}
        {footer ? (
          <DialogFooter>{footer}</DialogFooter>
        ) : (
          <DialogFooter>
            <DialogClose render={<Button variant="soft">{closeLabel}</Button>} />
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
