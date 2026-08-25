import type { ComponentProps, ReactNode } from 'react'
import { Card, CardHeader, CardTitle, CardDescription } from '@appica/ui-react/card'
import { Badge } from '@appica/ui-react/badge'

export type FlowNodeStatus = 'idle' | 'running' | 'done' | 'error'

export interface FlowNode {
  id: string
  title: string
  description?: string
  status?: FlowNodeStatus
  icon?: ReactNode
}

type BadgeVariant = ComponentProps<typeof Badge>['variant']

const STATUS_LABEL: Record<FlowNodeStatus, string> = {
  idle: '等待中',
  running: '运行中',
  done: '已完成',
  error: '出错',
}

const STATUS_VARIANT: Record<FlowNodeStatus, BadgeVariant> = {
  idle: 'outline',
  running: 'secondary',
  done: 'success',
  error: 'error',
}

// Reusable pipeline / orchestrator node. Drop it onto a canvas (e.g. React Flow)
// or render it standalone as a status card.
export function NodeCard({ node }: { node: FlowNode }) {
  const status = node.status ?? 'idle'
  return (
    <Card className="w-60">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {node.icon}
            <CardTitle className="text-base">{node.title}</CardTitle>
          </div>
          <Badge variant={STATUS_VARIANT[status]} size="sm">
            {STATUS_LABEL[status]}
          </Badge>
        </div>
        {node.description && <CardDescription>{node.description}</CardDescription>}
      </CardHeader>
    </Card>
  )
}
