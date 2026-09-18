/**
 * 记忆宫殿（Memory Palace，§3.3）。
 *
 * 智能体的长期可召回记忆管理台：记忆由用户/智能体显式「锚定」，或运行时自动召回 top-K 注入系统提示，
 * 每次召回累计引用计数（ref_count）并写事件日志，驱动本页的「卡片网格 + 热力图 + 搜索过滤 + 锚定/删除」。
 *
 * 数据链路：
 *  - 后端 `memory.rs` + 命令 `list_memories` / `get_memory_heatmap` / `anchor_memory` / `update_memory` /
 *    `delete_memory` / `recall_memory`，以及运行时 `load_config` 的自动召回注入；
 *  - 事件 `agent-memory-recalled`（引用计数实时刷新）与 `agent-context-compacted`（压缩结构化事件，侧栏展示）。
 *  - 非 Tauri 环境回退到内置 mock 数据，便于浏览器 dev 演示完整 UI。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  Search,
  Plus,
  Pin,
  Flame,
  Clock,
  Trash2,
  Pencil,
  RefreshCw,
  Brain,
  CalendarDays,
  Layers,
  Quote,
  Sparkles,
  Loader2,
  DatabaseZap,
} from 'lucide-react'
import { Button, Card, Input, Modal } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  Drawer,
  Popconfirm,
  Empty,
  Select,
  Tag,
  Tooltip,
  Spin,
  Segmented,
  Input as AntInput,
} from 'antd'
import { isTauri } from '@/core/config'

/** 语义召回状态（vector_status 命令返回，camelCase）。 */
interface VectorEmbeddingCfg {
  modelName: string
  dimsHint?: number | null
  protocol: string
}
interface VectorStatus {
  path: string
  connected: boolean
  tables: string[]
  embedding: VectorEmbeddingCfg | null
  stats: { calls: number; texts: number }
}
/** 向量回填进度事件载荷（agent-memory-backfill）。 */
interface BackfillProgress {
  done: number
  total: number
  ok: number
  failed: number
  finished: boolean
}
import type {
  MemoryItem,
  MemoryCategory,
  HeatmapPoint,
  AnchorMemoryInput,
  UpdateMemoryInput,
  MemoryRecalledPayload,
  MemoryAnchoredPayload,
  ContextCompactedPayload,
} from '@/pages/agent-studio/session/types'
import './memory-palace.scss'

/** 分类元信息（label + Tag 配色，与 Rust `MEMORY_CATEGORIES` 对齐）。 */
const CATEGORIES: { value: MemoryCategory | 'all'; label: string; color: string }[] = [
  { value: 'all', label: '全部', color: 'default' },
  { value: 'decision', label: '决策', color: 'magenta' },
  { value: 'code_pattern', label: '代码模式', color: 'blue' },
  { value: 'user_pref', label: '用户偏好', color: 'orange' },
  { value: 'architecture', label: '架构', color: 'purple' },
  { value: 'fix', label: '修复', color: 'red' },
  { value: 'other', label: '其他', color: 'cyan' },
]

const CAT_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label]),
)

/** 热力图周数（约 18 周 ≈ 4 个月）。 */
const HEATMAP_WEEKS = 18

// ── dev / 非 Tauri 回退 mock 数据 ──
const MOCK_MEMORIES: MemoryItem[] = [
  {
    id: 'mem_mock_1',
    key: '分页统一用 cursor 游标',
    content:
      '所有列表接口的分页统一采用 cursor 游标而非 offset，避免深翻页性能劣化；前端对应封装 useCursorPage。',
    category: 'code_pattern',
    refCount: 12,
    anchored: true,
    lastRecalledAt: Date.now() - 3600_000 * 5,
    createdAt: Date.now() - 86400_000 * 30,
    updatedAt: Date.now() - 3600_000 * 5,
  },
  {
    id: 'mem_mock_2',
    key: '用户偏好：证书页用纸张样式',
    content: '证书预览页必须用正式纸张证书视觉（三栏表头：左照片、右二维码），不要套用普通卡片。',
    category: 'user_pref',
    refCount: 8,
    anchored: true,
    lastRecalledAt: Date.now() - 86400_000 * 2,
    createdAt: Date.now() - 86400_000 * 20,
    updatedAt: Date.now() - 86400_000 * 2,
  },
  {
    id: 'mem_mock_3',
    key: '关键决策：会话与轮次双表持久化',
    content:
      '智能体会话采用 agent_conversation_session + agent_conversation_round 双表；round 存 raw_messages_json 无损回放。',
    category: 'decision',
    refCount: 5,
    anchored: false,
    lastRecalledAt: Date.now() - 86400_000 * 6,
    createdAt: Date.now() - 86400_000 * 40,
    updatedAt: Date.now() - 86400_000 * 6,
  },
  {
    id: 'mem_mock_4',
    key: 'Tauri 命令入参须包 input 键',
    content: 'run_agent_task / branch_from_step 等命令的入参是结构体，前端 invoke 必须把字段包在 input 键下。',
    category: 'architecture',
    refCount: 3,
    anchored: false,
    lastRecalledAt: null,
    createdAt: Date.now() - 86400_000 * 12,
    updatedAt: Date.now() - 86400_000 * 12,
  },
  {
    id: 'mem_mock_5',
    key: '全局 overflow:hidden 导致滚动异常',
    content: '项目全局 html/body/#root 设了 overflow:hidden，部分页面需自行管理内部滚动容器。',
    category: 'fix',
    refCount: 1,
    anchored: false,
    lastRecalledAt: null,
    createdAt: Date.now() - 86400_000 * 4,
    updatedAt: Date.now() - 86400_000 * 4,
  },
]

function mockHeatmap(): HeatmapPoint[] {
  const pts: HeatmapPoint[] = []
  const today = new Date()
  for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    // 制造一些随机但稳定的召回点
    const r = (i * 7 + 3) % 11
    if (r < 6) pts.push({ date: ds, count: r })
  }
  return pts
}

/** 相对时间（中文简短）。 */
function formatRelative(ts?: number | null): string {
  if (!ts) return '从未召回'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return `${Math.floor(day / 30)} 个月前`
}

/** 把热力图点聚合成 N 周的日历网格（每列 7 天，末列以今天结尾）。 */
function buildHeatmapGrid(points: HeatmapPoint[]): { date: string; count: number }[][] {
  const map = new Map(points.map((p) => [p.date, p.count]))
  const today = new Date()
  const total = HEATMAP_WEEKS * 7
  const cells: { date: string; count: number }[] = []
  for (let i = total - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    cells.push({ date: ds, count: map.get(ds) ?? 0 })
  }
  const weeks: { date: string; count: number }[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

function levelClass(count: number): string {
  if (count <= 0) return 'is-l0'
  if (count <= 2) return 'is-l1'
  if (count <= 5) return 'is-l2'
  if (count <= 9) return 'is-l3'
  return 'is-l4'
}

export default function MemoryPalace() {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [heatmap, setHeatmap] = useState<HeatmapPoint[]>([])
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<MemoryCategory | 'all'>('all')
  const [detail, setDetail] = useState<MemoryItem | null>(null)
  const [anchorOpen, setAnchorOpen] = useState(false)
  const [anchorForm, setAnchorForm] = useState<{ key: string; content: string; category: MemoryCategory }>({
    key: '',
    content: '',
    category: 'other',
  })
  const [compactions, setCompactions] = useState<ContextCompactedPayload[]>([])
  // 语义召回状态（#20260918004）：vector_status 快照 + 回填进度
  const [vecStatus, setVecStatus] = useState<VectorStatus | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [progress, setProgress] = useState<BackfillProgress | null>(null)

  const loadVectorStatus = useCallback(async () => {
    if (!isTauri) return
    try {
      setVecStatus(await invoke<VectorStatus>('vector_status', {}))
    } catch {
      /* 状态条非关键路径，失败静默（保持上次快照） */
    }
  }, [])

  const runBackfill = useCallback(async () => {
    if (!isTauri || backfilling) return
    setBackfilling(true)
    setProgress(null)
    try {
      const r = await invoke<{ total: number; ok: number; failed: number; finished: boolean }>(
        'backfill_memory_vectors',
        {},
      )
      if (r.total === 0) message.info('暂无存量记忆需要回填')
      else if (r.failed > 0) message.warning(`回填完成：成功 ${r.ok} 条，失败 ${r.failed} 条（详见日志）`)
      else message.success(`回填完成：${r.ok} 条记忆已全部向量化`)
    } catch (e) {
      message.error(`回填失败：${typeof e === 'string' ? e : '未知错误'}`)
    } finally {
      setBackfilling(false)
      void loadVectorStatus()
    }
  }, [backfilling, isTauri, loadVectorStatus, message])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      if (isTauri) {
        const [mems, heat] = await Promise.all([
          invoke<MemoryItem[]>('list_memories', {}),
          invoke<HeatmapPoint[]>('get_memory_heatmap', {}),
        ])
        setMemories(mems)
        setHeatmap(heat)
      } else {
        setMemories(MOCK_MEMORIES)
        setHeatmap(mockHeatmap())
      }
    } catch (e) {
      message.error(`加载记忆失败：${typeof e === 'string' ? e : '未知错误'}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  // 订阅记忆召回 / 锚定 / 上下文压缩事件，实时刷新（仅页面存活期间）。
  useEffect(() => {
    if (!isTauri) return
    let offRecall: UnlistenFn | undefined
    let offAnchored: UnlistenFn | undefined
    let offCompact: UnlistenFn | undefined
    let offBackfill: UnlistenFn | undefined
    let alive = true
    void (async () => {
      offRecall = await listen<MemoryRecalledPayload>('agent-memory-recalled', (ev) => {
        const item = ev.payload.item
        setMemories((prev) => prev.map((m) => (m.id === item.id ? item : m)))
      })
      // 记忆被锚定（手动或智能体自动沉淀）后实时新增/更新卡片，无需重开页面。
      offAnchored = await listen<MemoryAnchoredPayload>('agent-memory-anchored', (ev) => {
        const item = ev.payload.item
        setMemories((prev) => {
          const exists = prev.some((m) => m.id === item.id)
          return exists
            ? prev.map((m) => (m.id === item.id ? item : m))
            : [item, ...prev]
        })
      })
      offCompact = await listen<ContextCompactedPayload>('agent-context-compacted', (ev) => {
        setCompactions((prev) => [ev.payload, ...prev].slice(0, 8))
      })
      // 向量回填进度（逐批推送，finished=true 收尾）
      offBackfill = await listen<BackfillProgress>('agent-memory-backfill', (ev) => {
        setProgress(ev.payload)
      })
    })()
    return () => {
      alive = false
      offRecall?.()
      offAnchored?.()
      offCompact?.()
      offBackfill?.()
      void alive
    }
  }, [isTauri])

  useEffect(() => {
    void loadAll()
    void loadVectorStatus()
  }, [loadAll, loadVectorStatus])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return memories.filter((m) => {
      if (category !== 'all' && m.category !== category) return false
      if (kw && !`${m.key} ${m.content}`.toLowerCase().includes(kw)) return false
      return true
    })
  }, [memories, category, keyword])

  const grid = useMemo(() => buildHeatmapGrid(heatmap), [heatmap])
  const totalRecalls = useMemo(
    () => heatmap.reduce((acc, p) => acc + p.count, 0),
    [heatmap],
  )
  const counts = useMemo(() => {
    const acc: Record<string, number> = { all: memories.length }
    for (const m of memories) acc[m.category] = (acc[m.category] ?? 0) + 1
    return acc
  }, [memories])

  const handleAnchor = useCallback(async () => {
    const key = anchorForm.key.trim()
    const content = anchorForm.content.trim()
    if (!key || !content) {
      message.warning('请填写关键词与记忆内容')
      return
    }
    const input: AnchorMemoryInput = {
      key,
      content,
      category: anchorForm.category,
      // 手动「锚定」按钮语义为「钉住」（anchored=true）；原生自动沉淀工具传 false 仅做沉淀。
      anchored: true,
    }
    try {
      if (isTauri) {
        await invoke('anchor_memory', { input })
      }
      setAnchorOpen(false)
      setAnchorForm({ key: '', content: '', category: 'other' })
      message.success('已锚定记忆')
      await loadAll()
    } catch (e) {
      message.error(`锚定失败：${typeof e === 'string' ? e : '未知错误'}`)
    }
  }, [anchorForm, isTauri, loadAll, message])

  const handleUpdate = useCallback(
    async (m: MemoryItem, patch: { key?: string; content?: string; category?: MemoryCategory }) => {
      const input: UpdateMemoryInput = { id: m.id, ...patch }
      try {
        if (isTauri) await invoke('update_memory', { input })
        message.success('已更新记忆')
        setDetail(null)
        await loadAll()
      } catch (e) {
        message.error(`更新失败：${typeof e === 'string' ? e : '未知错误'}`)
      }
    },
    [isTauri, loadAll, message],
  )

  const handleDelete = useCallback(
    async (m: MemoryItem) => {
      try {
        if (isTauri) await invoke('delete_memory', { id: m.id })
        message.success('已删除记忆')
        setDetail(null)
        await loadAll()
      } catch (e) {
        message.error(`删除失败：${typeof e === 'string' ? e : '未知错误'}`)
      }
    },
    [isTauri, loadAll, message],
  )

  const handleRecall = useCallback(
    async (m: MemoryItem) => {
      try {
        if (isTauri) {
          const item = await invoke<MemoryItem>('recall_memory', { id: m.id })
          setMemories((prev) => prev.map((x) => (x.id === item.id ? item : x)))
        } else {
          setMemories((prev) =>
            prev.map((x) => (x.id === m.id ? { ...x, refCount: x.refCount + 1, lastRecalledAt: Date.now() } : x)),
          )
        }
        message.success('已召回一次（+1 引用）')
      } catch (e) {
        message.error(`召回失败：${typeof e === 'string' ? e : '未知错误'}`)
      }
    },
    [isTauri, message],
  )

  return (
    <div className="memory-palace">
      <header className="mp__head">
        <div>
          <h2 className="mp__title">
            <Brain size={20} />
            记忆宫殿
          </h2>
          <p className="mp__lead">
            智能体的长期可召回记忆中枢：锚定关键知识，运行时自动召回注入上下文；
            引用热力图反映知识被复用的频次。
          </p>
        </div>
        <div className="mp__actions">
          <Button variant="soft" size="sm" onClick={() => void loadAll()}>
            <RefreshCw size={14} />
            刷新
          </Button>
          <Button size="sm" onClick={() => setAnchorOpen(true)}>
            <Plus size={14} />
            锚定记忆
          </Button>
        </div>
      </header>

      {/* 语义召回状态条（#20260918004）：能力状态 + 向量库健康 + 嵌入统计 + 存量回填 */}
      <div className="mp__recall" data-on={vecStatus?.embedding ? '1' : '0'}>
        <div className="mp__recall-cell">
          {vecStatus?.embedding ? (
            <Tag color="green">语义召回已启用</Tag>
          ) : (
            <Tag>未配置 · 关键词召回模式</Tag>
          )}
          {vecStatus?.embedding && (
            <span className="mp__recall-meta">
              {vecStatus.embedding.modelName}
              {vecStatus.embedding.dimsHint ? ` · ${vecStatus.embedding.dimsHint} 维` : ''}
            </span>
          )}
        </div>
        <div className="mp__recall-cell">
          <span
            className={`mp__recall-dot${vecStatus?.connected ? ' is-ok' : ''}`}
            title={vecStatus?.connected ? 'LanceDB 已连接' : 'LanceDB 未连接（检索降级关键词）'}
          />
          <span className="mp__recall-meta" title={vecStatus?.path}>
            向量库{vecStatus?.connected ? '已连接' : '未连接'}（{vecStatus?.tables.length ?? 0} 表）
          </span>
          <span className="mp__recall-meta">
            嵌入 {vecStatus?.stats.calls ?? 0} 次 / {vecStatus?.stats.texts ?? 0} 条
          </span>
        </div>
        <div className="mp__recall-cell mp__recall-cell--end">
          {backfilling && progress && progress.total > 0 && (
            <span className="mp__recall-bar">
              <span
                className="mp__recall-bar__fill"
                style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }}
              />
            </span>
          )}
          <span className="mp__recall-meta">
            {backfilling
              ? progress?.total
                ? `回填中 ${progress.done}/${progress.total}`
                : '回填中…'
              : `存量 ${memories.length} 条`}
          </span>
          <Tooltip title={vecStatus?.embedding ? '把全部存量记忆批量向量化（换模型后重算也用此按钮）' : '先在 LLM 模块配置「向量模型」后再回填'}>
            <Button
              variant="soft"
              size="sm"
              disabled={!vecStatus?.embedding || backfilling}
              onClick={() => void runBackfill()}
            >
              {backfilling ? <Loader2 size={14} className="mp-spin" /> : <DatabaseZap size={14} />}
              回填向量
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="mp__layout">
        {/* 主区：搜索 + 卡片网格 */}
        <div className="mp__main">
          <div className="mp__toolbar">
            <Input
              allowClear
              placeholder="搜索关键词 / 记忆内容"
              prefix={<Search size={14} color="var(--color-foreground-muted)" />}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: 320 }}
            />
            <Segmented
              className="mp__seg"
              value={category}
              onChange={(v) => setCategory(v as MemoryCategory | 'all')}
              options={CATEGORIES.map((c) => ({ label: `${c.label}${counts[c.value] ? ` ${counts[c.value]}` : ''}`, value: c.value }))}
            />
          </div>

          <Spin spinning={loading} wrapperClassName="mp__spin">
            {filtered.length > 0 ? (
              <div className="mp-grid">
                {filtered.map((m) => (
                  <Card key={m.id} frame="solid" className="mp-grid-item" onClick={() => setDetail(m)}>
                    <div className="mp-grid-item__head">
                      {m.anchored ? (
                        <Tooltip title="已锚定">
                          <Pin size={14} className="mp-grid-item__pin" />
                        </Tooltip>
                      ) : (
                        <Quote size={14} className="mp-grid-item__pin mp-grid-item__pin--soft" />
                      )}
                      <Tag color={CAT_LABEL[m.category] === '其他' ? 'default' : CATEGORIES.find((c) => c.value === m.category)?.color}>
                        {CAT_LABEL[m.category] ?? m.category}
                      </Tag>
                    </div>

                    <h3 className="mp-grid-item__title" title={m.key}>
                      {m.key}
                    </h3>
                    {/* 换行折叠为空格再交给 line-clamp 截断：原文含「路径。\n1) 列表」时，
                        直接截断会把路径+编号切成半行，视觉上像渲染报错（真机 2026-09-18 反馈）。 */}
                    <p className="mp-grid-item__content" title={m.content}>
                      {m.content.replace(/\s*\n+\s*/g, ' ')}
                    </p>

                    <div className="mp-grid-item__footer">
                      <Tooltip title="引用次数">
                        <span className="mp-grid-item__stat">
                          <Flame size={13} />
                          {m.refCount}
                        </span>
                      </Tooltip>
                      <Tooltip title="最近召回时间">
                        <span className="mp-grid-item__stat">
                          <Clock size={13} />
                          {formatRelative(m.lastRecalledAt)}
                        </span>
                      </Tooltip>
                    </div>

                    <div
                      className="mp-grid-item__actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip title="引用一次（引用计数 +1）">
                        <Button variant="ghost" size="icon-sm" aria-label="引用" onClick={() => void handleRecall(m)}>
                          <RefreshCw size={15} />
                        </Button>
                      </Tooltip>
                      <Tooltip title="编辑">
                        <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setDetail(m)}>
                          <Pencil size={15} />
                        </Button>
                      </Tooltip>
                      <Popconfirm
                        title="确定删除该记忆吗？"
                        okText="确定"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void handleDelete(m)}
                      >
                        <Button variant="ghost" size="icon-sm" className="mp-grid-item__del" aria-label="删除">
                          <Trash2 size={15} />
                        </Button>
                      </Popconfirm>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              !loading && (
                <div className="mp-grid-empty">
                  <Empty description="暂无记忆，点击右上角「锚定记忆」沉淀第一条" />
                </div>
              )
            )}
          </Spin>
        </div>

        {/* 侧栏：热力图 + 压缩事件 */}
        <aside className="mp__sidebar">
          <div className="mp-side-card">
            <div className="mp-side-card__title">
              <CalendarDays size={15} />
              召回热力图
              <span className="mp-side-card__sub">累计 {totalRecalls} 次召回</span>
            </div>
            <div className="mp-heatmap">
              <div className="mp-heatmap__grid">
                {grid.map((week, wi) => (
                  <div className="mp-heatmap__week" key={wi}>
                    {week.map((cell) => (
                      <Tooltip
                        key={cell.date}
                        title={`${cell.date} · 召回 ${cell.count} 次`}
                        mouseEnterDelay={0.2}
                      >
                        <span className={`mp-heatmap__cell ${levelClass(cell.count)}`} />
                      </Tooltip>
                    ))}
                  </div>
                ))}
              </div>
              <div className="mp-heatmap__legend">
                <span>少</span>
                <span className="mp-heatmap__cell is-l0" />
                <span className="mp-heatmap__cell is-l1" />
                <span className="mp-heatmap__cell is-l2" />
                <span className="mp-heatmap__cell is-l3" />
                <span className="mp-heatmap__cell is-l4" />
                <span>多</span>
              </div>
            </div>
          </div>

          <div className="mp-side-card">
            <div className="mp-side-card__title">
              <Layers size={15} />
              上下文压缩
              <span className="mp-side-card__sub">最近 {compactions.length} 次</span>
            </div>
            {compactions.length === 0 ? (
              <p className="mp-side-empty">暂无压缩事件（长会话运行后自动产生）</p>
            ) : (
              <ul className="mp-compact-list">
                {compactions.map((c, i) => (
                  <li key={i} className="mp-compact-item">
                    <Sparkles size={13} />
                    <span>
                      合并 {c.compactedRounds} 轮 · 节省约 {c.tokensSaved} token
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {/* 锚定记忆弹窗 */}
      <Modal
        open={anchorOpen}
        title="锚定新记忆"
        onOpenChange={setAnchorOpen}
        width={520}
        footer={
          <div className="mp-form__footer">
            <Button variant="soft" onClick={() => setAnchorOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleAnchor()}>锚定</Button>
          </div>
        }
      >
        <div className="mp-form">
          <label className="mp-form__label">关键词 *</label>
          <Input
            autoComplete="off"
            placeholder="如：分页统一用 cursor 游标"
            value={anchorForm.key}
            onChange={(e) => setAnchorForm((f) => ({ ...f, key: e.target.value }))}
          />
          <label className="mp-form__label">分类</label>
          <Select
            style={{ width: '100%' }}
            value={anchorForm.category}
            onChange={(v) => setAnchorForm((f) => ({ ...f, category: v as MemoryCategory }))}
            options={CATEGORIES.filter((c) => c.value !== 'all').map((c) => ({
              label: c.label,
              value: c.value,
            }))}
          />
          <label className="mp-form__label">记忆内容 *</label>
          <AntInput.TextArea
            rows={5}
            placeholder="沉淀这条记忆的具体内容与适用场景…"
            value={anchorForm.content}
            onChange={(e) => setAnchorForm((f) => ({ ...f, content: e.target.value }))}
          />
        </div>
      </Modal>

      {/* 记忆详情 / 编辑抽屉 */}
      <Drawer
        title="记忆详情"
        placement="right"
        width={460}
        open={!!detail}
        onClose={() => setDetail(null)}
        extra={
          detail && (
            <Popconfirm
              title="确定删除该记忆吗？"
              okText="确定"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => detail && void handleDelete(detail)}
            >
              <Button variant="ghost" size="sm" className="mp-grid-item__del">
                <Trash2 size={14} />
                删除
              </Button>
            </Popconfirm>
          )
        }
      >
        {detail && <MemoryDetail item={detail} onUpdate={handleUpdate} onRecall={handleRecall} />}
      </Drawer>
    </div>
  )
}

/** 记忆详情 / 编辑面板（抽屉内）。 */
function MemoryDetail({
  item,
  onUpdate,
  onRecall,
}: {
  item: MemoryItem
  onUpdate: (m: MemoryItem, patch: { key?: string; content?: string; category?: MemoryCategory }) => void
  onRecall: (m: MemoryItem) => void
}) {
  const [key, setKey] = useState(item.key)
  const [content, setContent] = useState(item.content)
  const [cat, setCat] = useState<MemoryCategory>(item.category)

  // item 切换时同步本地编辑态
  useEffect(() => {
    setKey(item.key)
    setContent(item.content)
    setCat(item.category)
  }, [item])

  return (
    <div className="mp-detail">
      <div className="mp-detail__meta">
        <Tag color={CAT_LABEL[item.category] === '其他' ? 'default' : CATEGORIES.find((c) => c.value === item.category)?.color}>
          {CAT_LABEL[item.category] ?? item.category}
        </Tag>
        {item.anchored && (
          <span className="mp-detail__anchored">
            <Pin size={12} /> 已锚定
          </span>
        )}
        <span className="mp-detail__stat">
          <Flame size={13} /> {item.refCount} 次引用
        </span>
        <span className="mp-detail__stat">
          <Clock size={13} /> {formatRelative(item.lastRecalledAt)}
        </span>
      </div>

      <label className="mp-form__label">关键词</label>
      <Input autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />

      <label className="mp-form__label">分类</label>
      <Select
        style={{ width: '100%' }}
        value={cat}
        onChange={(v) => setCat(v as MemoryCategory)}
        options={CATEGORIES.filter((c) => c.value !== 'all').map((c) => ({ label: c.label, value: c.value }))}
      />

      <label className="mp-form__label">记忆内容</label>
      <AntInput.TextArea autoComplete="off" rows={8} value={content} onChange={(e) => setContent(e.target.value)} />

      <div className="mp-detail__actions">
        <Button size="sm" onClick={() => void onRecall(item)}>
          <RefreshCw size={14} />
          引用一次
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void onUpdate(item, {
              key: key.trim() || item.key,
              content: content.trim() || item.content,
              category: cat,
            })
          }
        >
          <Pencil size={14} />
          保存修改
        </Button>
      </div>
    </div>
  )
}
