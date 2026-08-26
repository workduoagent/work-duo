import { Card, Button } from '@/components/ui'
import { PlusIcon } from '@/components/ui/icons'
import './index.scss'

export default function SquadsWorkspacePage() {
  return (
    <div className="squads">
      <div className="squads__head">
        <p className="squads__lead">多智能体协作车间。</p>
        <Button>
          <PlusIcon data-icon="start" />
          新建协作
        </Button>
      </div>
      <Card frame="solid">
        <div className="squads__card-title">尚未创建协作小组</div>
        <div className="squads__card-desc">
          在这里组合多个智能体，协同完成复杂任务。
        </div>
      </Card>
    </div>
  )
}
