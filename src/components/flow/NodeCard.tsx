import type { ReactNode } from 'react'
import { Tag } from 'antd'
import { Card } from '@/components/ui'
import './NodeCard.scss'

export type FlowNodeStatus = 'idle' | 'running' | 'done' | 'error'

export interface FlowNode {
  id: string
  title: string
  description?: string
  status?: FlowNodeStatus
  icon?: ReactNode
}

const STATUS_LABEL: Record<FlowNodeStatus, string> = {
  idle: '等待中',
  running: '运行中',
  done: '已完成',
  error: '出错',
}

const STATUS_COLOR: Record<FlowNodeStatus, string> = {
  idle: 'default',
  running: 'processing',
  done: 'success',
  error: 'error',
}

// 流水线 / 编排节点。可挂到画布（如 React Flow），也可独立作为状态卡片。
export function NodeCard({ node }: { node: FlowNode }) {
  const status = node.status ?? 'idle'
  return (
    <Card className="flow-node" frame="solid">
      <div className="flow-node__header">
        <div className="flow-node__title-group">
          {node.icon}
          <span className="flow-node__title">{node.title}</span>
        </div>
        <Tag color={STATUS_COLOR[status]}>{STATUS_LABEL[status]}</Tag>
      </div>
      {node.description && (
        <div className="flow-node__desc">{node.description}</div>
      )}
    </Card>
  )
}
