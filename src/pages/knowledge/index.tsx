import { Link } from 'react-router-dom'
import { Card } from '@/components/ui'
import { knowledgeDetailPath } from '@/core/router/paths'
import { formatRelativeTime } from '@/utils/format'
import './index.scss'

const MOCK = [
  {
    id: 'kb_1',
    name: '产品文档',
    description: '内部产品与 API 文档',
    updated_at: Date.now() - 3_600_000,
  },
  {
    id: 'kb_2',
    name: '行业研究',
    description: '市场与竞品分析',
    updated_at: Date.now() - 86_400_000,
  },
]

export default function KnowledgeListPage() {
  return (
    <div className="kb">
      <p className="kb__lead">管理知识库，点击卡片查看详情。</p>
      <div className="kb__grid">
        {MOCK.map((kb) => (
          <Link
            key={kb.id}
            to={knowledgeDetailPath(kb.id)}
            className="kb__card-link"
          >
            <Card frame="solid" className="kb__card">
              <div className="kb__card-title">{kb.name}</div>
              <div className="kb__card-desc">{kb.description}</div>
              <div className="kb__card-time">
                更新于 {formatRelativeTime(kb.updated_at)}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
