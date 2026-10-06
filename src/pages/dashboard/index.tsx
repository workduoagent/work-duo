import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Spin, Empty, Alert } from '@/components/ui'
import { BookOpen, Bot, Users, Sparkles, ArrowRight, Plug, Wand2, Puzzle, Server } from 'lucide-react'
import { APP_NAME } from '@/core/config'
import { ROUTES } from '@/core/router/paths'
import { listKnowledgeBases } from '@/core/mapper/knowledge-mapper'
import { listAgents } from '@/core/mapper/agent-mapper'
import { listSquads } from '@/core/mapper/squad-mapper'
import { listModels } from '@/core/mapper/model-mapper'
import { fe } from '@/core/logBridge'
import './index.scss'

/**
 * 首页概览（F042）。
 *
 * 背景：此前是 45 行脚手架占位页——4 个统计硬编码为 '0'、「查看文档」按钮
 * 无 onClick、且未进顶栏 MENUS（首页虽已注册为 index route，但用户只能手输
 * hash 进入）。现接真实数据 + 补菜单入口。
 *
 * 设计取舍：
 *  - 四个计数**并行**请求（`Promise.allSettled`）而非串行 —— 互不依赖，串行会
 *    把首屏耗时累加；且用 `allSettled` 而非 `all`，任一模块失败不影响其余。
 *  - 统计卡**可点击跳转**到对应模块，让首页成为真正的导航入口而非数字墙。
 *  - 加载/空/失败三态齐备（此前连 loading 都没有）。
 */

interface StatItem {
  key: string
  label: string
  icon: typeof BookOpen
  path: string
  /** 加载完成前的占位；失败时为 null（显示「—」并置 failed） */
  value: number | null
  failed: boolean
}

const STAT_DEFS: Array<{ key: string; label: string; icon: typeof BookOpen; path: string }> = [
  { key: 'kb', label: '知识库', icon: BookOpen, path: ROUTES.knowledge },
  { key: 'agent', label: '智能体', icon: Bot, path: ROUTES.agentStudio },
  { key: 'squad', label: '协作小组', icon: Users, path: ROUTES.squadsWorkspace },
  { key: 'model', label: '模型配置', icon: Sparkles, path: ROUTES.modelSettings },
]

const ENTRY_POINTS = [
  { label: '知识库', icon: BookOpen, path: ROUTES.knowledge, desc: '文档入库、向量化与检索' },
  { label: '智能体', icon: Bot, path: ROUTES.agentStudio, desc: '编排智能体与调试会话' },
  { label: 'MCP', icon: Plug, path: ROUTES.mcpHub, desc: '接入外部工具服务' },
  { label: 'Skill', icon: Wand2, path: ROUTES.skillHub, desc: '可复用的技能包' },
  { label: '插件', icon: Puzzle, path: ROUTES.pluginHub, desc: '本地插件与运行日志' },
  { label: '服务器', icon: Server, path: ROUTES.serverHub, desc: '远程主机与凭证管理' },
  { label: '小分队', icon: Users, path: ROUTES.squadsWorkspace, desc: '多智能体协作编排' },
  { label: 'LLM', icon: Sparkles, path: ROUTES.modelSettings, desc: '模型接入与参数配置' },
]

export default function DashboardPage() {
  const nav = useNavigate()
  const [stats, setStats] = useState<StatItem[]>(() =>
    STAT_DEFS.map((s) => ({ ...s, value: null, failed: false })),
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    // 四路并行 + 各自成败独立：任一模块失败不应让首页整块报错
    const tasks: Array<[string, () => Promise<unknown[]>]> = [
      ['kb', () => listKnowledgeBases()],
      ['agent', () => listAgents()],
      ['squad', () => listSquads()],
      ['model', () => listModels()],
    ]
    void (async () => {
      const results = await Promise.allSettled(tasks.map(([, fn]) => fn()))
      if (!alive) return
      setStats((prev) =>
        prev.map((s) => {
          const idx = tasks.findIndex(([k]) => k === s.key)
          const r = results[idx]
          if (r.status === 'fulfilled') return { ...s, value: r.value.length, failed: false }
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
          fe.warn('dashboard', `统计「${s.label}」加载失败：${msg}`)
          return { ...s, value: null, failed: true }
        }),
      )
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  const allFailed = stats.every((s) => s.failed)
  const allEmpty = !loading && !allFailed && stats.every((s) => s.value === 0)

  return (
    <div className="dash">
      <section>
        <h2 className="dash__title">欢迎使用 {APP_NAME}</h2>
        <p className="dash__subtitle">本地运行的智能体工作台 —— 数据与配置均在本机，不出网。</p>
      </section>

      {allFailed && (
        <Alert
          type="error"
          showIcon
          message="统计数据加载失败"
          description="请确认数据库连接正常（设置 → 数据目录），或查看日志了解详情。"
        />
      )}

      <Spin spinning={loading} wrapperClassName="dash__spin">
        <section className="dash__stats">
          {stats.map((s) => (
            <Card
              key={s.key}
              frame="solid"
              className="dash__stat"
              // 统计卡即导航入口：点击直达对应模块
              onClick={() => nav(s.path)}
            >
              <div className="dash__stat-head">
                <s.icon size={16} className="dash__stat-ico" />
                <div className="dash__stat-label">{s.label}</div>
              </div>
              <div className={`dash__stat-value${s.failed ? ' is-failed' : ''}`}>
                {s.failed ? '—' : (s.value ?? '—')}
              </div>
            </Card>
          ))}
        </section>
      </Spin>

      <section>
        <div className="dash__card-title">功能入口</div>
        <div className="dash__entries">
          {ENTRY_POINTS.map((e) => (
            <button key={e.label} type="button" className="dash__entry" onClick={() => nav(e.path)}>
              <e.icon size={16} className="dash__entry-ico" />
              <div className="dash__entry-text">
                <div className="dash__entry-label">{e.label}</div>
                <div className="dash__entry-desc">{e.desc}</div>
              </div>
              <ArrowRight size={14} className="dash__entry-arrow" />
            </button>
          ))}
        </div>
      </section>

      {allEmpty && (
        <section>
          <Empty description="还没有任何配置 —— 从上方入口开始创建你的第一个智能体" />
        </section>
      )}
    </div>
  )
}
