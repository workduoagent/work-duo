import { useParams, Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardDescription } from '@appica/ui-react/card'
import { Button } from '@appica/ui-react/button'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { ROUTES } from '@/core/router/paths'

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
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link to={ROUTES.knowledge}>
        <Button variant="ghost" size="sm">
          ← 返回列表
        </Button>
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">知识库 {id}</CardTitle>
          <CardDescription>以下为示例内容（Markdown 渲染）。</CardDescription>
        </CardHeader>
      </Card>
      <Card frame="solid">
        <CardHeader>
          <MarkdownRenderer content={SAMPLE_MD} />
        </CardHeader>
      </Card>
    </div>
  )
}
