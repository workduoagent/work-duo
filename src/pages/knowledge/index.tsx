import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardDescription } from '@appica/ui-react/card'
import { knowledgeDetailPath } from '@/core/router/paths'
import { formatRelativeTime } from '@/utils/format'

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
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <p className="text-foreground-muted">管理知识库，点击卡片查看详情。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {MOCK.map((kb) => (
          <Link
            key={kb.id}
            to={knowledgeDetailPath(kb.id)}
            className="block rounded-xl outline-ring focus-visible:ring-2"
          >
            <Card frame="solid" className="h-full">
              <CardHeader>
                <CardTitle className="text-base">{kb.name}</CardTitle>
                <CardDescription>{kb.description}</CardDescription>
                <CardDescription className="mt-2 text-xs">
                  更新于 {formatRelativeTime(kb.updated_at)}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
