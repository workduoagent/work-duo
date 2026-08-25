import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@appica/ui-react/card'
import { Button } from '@appica/ui-react/button'
import { APP_NAME } from '@/core/config'

const STATS = [
  { label: '知识库', value: '0' },
  { label: '智能体', value: '0' },
  { label: '协作小组', value: '0' },
  { label: '模型配置', value: '0' },
]

export default function DashboardPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <section>
        <h2 className="text-2xl font-semibold text-foreground-intense">欢迎使用 {APP_NAME}</h2>
        <p className="mt-1 text-foreground-muted">
          这是一个基于 Tauri 2 + React 19 + Appica UI 的桌面端基础框架。
        </p>
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {STATS.map((s) => (
          <Card key={s.label} frame="solid">
            <CardHeader>
              <CardTitle className="text-3xl">{s.value}</CardTitle>
              <CardDescription>{s.label}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle>快速开始</CardTitle>
            <CardDescription>从左侧导航进入各模块，逐步接入真实数据与 Rust 命令。</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="soft">查看文档</Button>
          </CardFooter>
        </Card>
      </section>
    </div>
  )
}
