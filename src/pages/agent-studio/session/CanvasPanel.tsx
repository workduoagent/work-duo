/**
 * 规划 DAG 画布（Phase 3 §3.2 垂直切片）。
 *
 * 数据来源：右栏「画布」Tab——`session.planSteps`（规划步骤，含 dependsOn 依赖）
 * 与 `session.artifacts`（各步骤产出的文件产物）。
 *
 * 渲染策略：单张 SVG（节点 + 连线均绘于 SVG 内），通过 `viewBox` + `preserveAspectRatio="xMidYMid meet"`
 * 让整图等比缩放填满右栏容器，**永不出现 XY 滚动条**（容器 `overflow:hidden` 兜底）。
 *  - 节点 = 规划步骤；按 `dependsOn` 计算拓扑深度（depth = 1 + max(依赖深度)）分**行**；
 *  - 同一深度的节点并排成一行（从左到右）；整图自顶向下流式排列，符合「步骤递进」直觉；
 *  - 边 = 依赖连线（贝塞尔曲线 + 箭头），从依赖节点底部中点指向下游节点顶部中点；
 *  - 节点边框按状态着色（pending/running/success/failed），底部展示产物数量徽标。
 * 依赖关系以 task_id 字符串存储，渲染前先建 taskId→step 索引。
 */
import { useMemo } from 'react'
import type { ArtifactRef, PlanStep, PlanStepStatus } from './types'

interface CanvasPanelProps {
  planSteps: PlanStep[]
  artifacts: ArtifactRef[]
}

const NODE_W = 180
const NODE_H = 64
const COL_GAP = 72
const ROW_GAP = 24
const PAD = 18

const STATUS_COLOR: Record<PlanStepStatus, string> = {
  pending: 'var(--color-border, #d0d5dd)',
  running: 'var(--color-info, #3B82F6)',
  success: 'var(--color-success, #10B981)',
  failed: 'var(--color-error, #EF4444)',
}

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: '待运行',
  running: '进行中',
  success: '已完成',
  failed: '失败',
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

interface LayoutNode {
  step: number
  x: number
  y: number
  node: PlanStep
}

interface LayoutEdge {
  sx: number
  sy: number
  tx: number
  ty: number
}

interface Layout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
}

function computeLayout(steps: PlanStep[]): Layout {
  const taskIdMap = new Map<string, number>()
  steps.forEach((s) => {
    if (s.taskId) taskIdMap.set(s.taskId, s.step)
  })

  // 拓扑深度（带防环上限），驱动分行布局。
  const depthOf = (step: number, guard: number): number => {
    if (guard > 32) return 0
    const s = steps.find((x) => x.step === step)
    const deps = (s?.dependsOn ?? [])
      .map((d) => taskIdMap.get(d))
      .filter((x): x is number => x !== undefined)
    if (deps.length === 0) return 0
    return 1 + Math.max(...deps.map((d) => depthOf(d, guard + 1)))
  }

  const withDepth = steps.map((s) => ({ s, depth: depthOf(s.step, 0) }))

  // 按深度分行（depth 越大越靠下），同行内顺序排列；整图自顶向下流式排布。
  const rows = new Map<number, typeof withDepth>()
  withDepth.forEach((d) => {
    const arr = rows.get(d.depth) ?? []
    arr.push(d)
    rows.set(d.depth, arr)
  })

  let maxCols = 0
  let maxDepth = 0
  rows.forEach((arr, depth) => {
    maxCols = Math.max(maxCols, arr.length)
    maxDepth = Math.max(maxDepth, depth)
  })

  const stepToPos = new Map<number, { x: number; y: number }>()
  const nodes: LayoutNode[] = withDepth.map(({ s, depth }) => {
    const row = rows.get(depth)!
    const colIndex = row.findIndex((c) => c.s.step === s.step)
    // 纵向：depth → 行（y），colIndex → 列（x）
    const x = PAD + colIndex * (NODE_W + COL_GAP)
    const y = PAD + depth * (NODE_H + ROW_GAP)
    stepToPos.set(s.step, { x, y })
    return { step: s.step, x, y, node: s }
  })

  const edges: LayoutEdge[] = []
  withDepth.forEach(({ s }) => {
    const from = stepToPos.get(s.step)
    if (!from) return
    ;(s.dependsOn ?? []).forEach((d) => {
      const depStep = taskIdMap.get(d)
      if (depStep === undefined) return
      const to = stepToPos.get(depStep)
      if (!to) return
      // 纵向连线：依赖节点底部中点 → 下游节点顶部中点
      edges.push({
        sx: to.x + NODE_W / 2,
        sy: to.y + NODE_H,
        tx: from.x + NODE_W / 2,
        ty: from.y,
      })
    })
  })

  const width = Math.max(PAD * 2 + maxCols * NODE_W + (maxCols - 1) * COL_GAP, 240)
  const height = Math.max(PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * ROW_GAP, 150)
  return { nodes, edges, width, height }
}

export function CanvasPanel({ planSteps, artifacts }: CanvasPanelProps) {
  const layout = useMemo(() => computeLayout(planSteps), [planSteps])
  const artifactsByStep = useMemo(() => {
    const m = new Map<number, ArtifactRef[]>()
    artifacts.forEach((a) => {
      const arr = m.get(a.step) ?? []
      arr.push(a)
      m.set(a.step, arr)
    })
    return m
  }, [artifacts])

  if (planSteps.length === 0) {
    return (
      <div className="agent-canvas">
        <div className="agent-canvas__empty">
          运行一次复合任务后，这里会展示规划 DAG：步骤节点 + 依赖连线 + 产物标记。
        </div>
      </div>
    )
  }

  return (
    <div className="agent-canvas">
      {/* 整图等比缩放填满容器，永不出现滚动条 */}
      <svg
        className="agent-canvas__svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id="ac-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-border, #c4c9d4)" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => {
          const midY = (e.sy + e.ty) / 2
          const d = `M ${e.sx},${e.sy} C ${e.sx},${midY} ${e.tx},${midY} ${e.tx},${e.ty}`
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke="var(--color-border, #c4c9d4)"
              strokeWidth={1.5}
              markerEnd="url(#ac-arrow)"
            />
          )
        })}
        {layout.nodes.map((n) => {
          const arts = artifactsByStep.get(n.step) ?? []
          const color = STATUS_COLOR[n.node.status]
          return (
            <g key={n.step} transform={`translate(${n.x},${n.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={10}
                ry={10}
                fill="var(--color-background, #fff)"
                stroke={color}
                strokeWidth={1.5}
              />
              <circle cx={16} cy={16} r={10} fill={color} />
              <text x={16} y={20} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">
                {n.node.step}
              </text>
              <text
                x={34}
                y={20}
                fontSize={12.5}
                fontWeight={600}
                fill="var(--color-foreground, #222)"
              >
                {truncate(n.node.title, 11)}
              </text>
              {arts.length > 0 && (
                <text x={10} y={54} fontSize={11} fill="var(--color-foreground-muted, #999)">
                  产物 {arts.length}
                </text>
              )}
              <text
                x={NODE_W - 10}
                y={54}
                textAnchor="end"
                fontSize={11}
                fontWeight={600}
                fill={color}
              >
                {STATUS_LABEL[n.node.status]}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
