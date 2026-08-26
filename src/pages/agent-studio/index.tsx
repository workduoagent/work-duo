import { NodeCard } from '@/components/flow'
import { AgentIcon, KnowledgeIcon, ModelIcon } from '@/components/ui/icons'
import { Card } from '@/components/ui'
import './index.scss'

export default function AgentStudioPage() {
  return (
    <div className="agent-studio">
      <p className="agent-studio__lead">通过编排节点构建智能体工作流。</p>
      <div className="agent-studio__nodes">
        <NodeCard
          node={{ id: 'n1', title: '知识检索', description: '从知识库取上下文', status: 'done', icon: <KnowledgeIcon /> }}
        />
        <NodeCard
          node={{ id: 'n2', title: '模型推理', description: '调用大模型', status: 'running', icon: <ModelIcon /> }}
        />
        <NodeCard
          node={{ id: 'n3', title: '智能体决策', description: '编排下一步', status: 'idle', icon: <AgentIcon /> }}
        />
      </div>
      <Card frame="solid">
        <div className="agent-studio__card-title">提示</div>
        <div className="agent-studio__card-desc">
          后续可接入 React Flow 实现可拖拽的连线编排画布。
        </div>
      </Card>
    </div>
  )
}
