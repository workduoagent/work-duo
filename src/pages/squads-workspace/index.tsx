import { Card, CardHeader, CardTitle, CardDescription } from '@appica/ui-react/card'
import { Button } from '@appica/ui-react/button'
import { PlusIcon } from '@/components/ui/icons'

export default function SquadsWorkspacePage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-foreground-muted">多智能体协作车间。</p>
        <Button>
          <PlusIcon data-icon="start" />
          新建协作
        </Button>
      </div>
      <Card frame="solid">
        <CardHeader>
          <CardTitle className="text-base">尚未创建协作小组</CardTitle>
          <CardDescription>在这里组合多个智能体，协同完成复杂任务。</CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
