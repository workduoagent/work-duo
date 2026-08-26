import { Card } from '@/components/ui'
import { Button } from '@/components/ui'
import { APP_NAME } from '@/core/config'
import './index.scss'

const STATS = [
  { label: '知识库', value: '0' },
  { label: '智能体', value: '0' },
  { label: '协作小组', value: '0' },
  { label: '模型配置', value: '0' },
]

export default function DashboardPage() {
  return (
    <div className="dash">
      <section>
        <h2 className="dash__title">欢迎使用 {APP_NAME}</h2>
        <p className="dash__subtitle">
          这是一个基于 Tauri 2 + React 19 + Ant Design 的桌面端基础框架。
        </p>
      </section>

      <section className="dash__stats">
        {STATS.map((s) => (
          <Card key={s.label} frame="solid">
            <div className="dash__stat-value">{s.value}</div>
            <div className="dash__stat-label">{s.label}</div>
          </Card>
        ))}
      </section>

      <section>
        <Card>
          <div className="dash__card-title">快速开始</div>
          <div className="dash__card-desc">
            从顶部胶囊菜单进入各模块，逐步接入真实数据与 Rust 命令。
          </div>
          <div className="dash__card-footer">
            <Button variant="soft">查看文档</Button>
          </div>
        </Card>
      </section>
    </div>
  )
}
