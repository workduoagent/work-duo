import { useParams, Link } from 'react-router-dom'
import { Card, Button } from '@/components/ui'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { ROUTES } from '@/core/router/paths'
import './index.scss'

const SAMPLE_MD = `# 知识库详情

这是 **Markdown** 渲染示例：

- 支持列表
- 支持 \`代码\`
- 支持 [链接](https://example.com)

> 后续可从 SQLite 读取真实内容。
`

export default function KnowledgeDetailPage() {
  const { id } = useParams<{ id: string }>()

  return (
    <div className="kb-detail">
      <Link to={ROUTES.knowledge}>
        <Button variant="ghost" size="sm">
          ← 返回列表
        </Button>
      </Link>
      <Card>
        <div className="kb-detail__title">知识库 {id}</div>
        <div className="kb-detail__desc">以下为示例内容（Markdown 渲染）。</div>
      </Card>
      <Card frame="solid">
        <MarkdownRenderer content={SAMPLE_MD} />
      </Card>
    </div>
  )
}
