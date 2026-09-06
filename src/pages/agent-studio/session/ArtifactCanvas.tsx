/**
 * 产物画布（Phase 3 §3.2 完整版）。
 *
 * 在 CanvasPanel（纯 SVG DAG）基础上增强：
 *  - 拖拽平移（鼠标按住空白处拖动 viewBox）；
 *  - 滚轮缩放（以指针位置为中心缩放 viewBox）；
 *  - 节点点击选中（高亮 + 下方产物列表，点击产物调 read_artifact 预览）；
 *  - 节点右键菜单「从此步骤分支」（触发 branch_from_step 命令）；
 *  - 分支对比横幅（planBranch 到达时显示原方案 vs 新分支 + 应用/放弃按钮）。
 *
 * 布局策略与 CanvasPanel 一致：按 dependsOn 拓扑深度分行、纵向贝塞尔连线 + 箭头。
 */
import { useCallback, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import { GitBranch, X, FileText, Maximize } from 'lucide-react'
import type {
  ArtifactRef,
  BranchStep,
  PlanBranchGenerated,
  PlanStep,
  PlanStepStatus,
} from './types'

interface ArtifactCanvasProps {
  planSteps: PlanStep[]
  artifacts: ArtifactRef[]
  planBranch: PlanBranchGenerated | null
  /** 点击产物文件时触发（chat.tsx 调 read_artifact 命令预览）。 */
  onPreviewArtifact: (path: string) => void
  /** 右键「从此步骤分支」时触发（chat.tsx 调 branch_from_step 命令）。 */
  onBranchFromStep: (step: number) => void
  /** 应用分支（用新分支步骤替换原尾段）。 */
  onApplyBranch: () => void
  /** 放弃分支对比。 */
  onDismissBranch: () => void
}

// ── 布局常量 ──
const NODE_W = 180
const NODE_H = 64
const COL_GAP = 72
const ROW_GAP = 28
const PAD = 20
const MIN_SCALE = 0.3
const MAX_SCALE = 3.0

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

// ── 布局计算 ──
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
      edges.push({
        sx: to.x + NODE_W / 2,
        sy: to.y + NODE_H,
        tx: from.x + NODE_W / 2,
        ty: from.y,
      })
    })
  })

  const width = Math.max(PAD * 2 + maxCols * NODE_W + Math.max(0, maxCols - 1) * COL_GAP, 240)
  const height = Math.max(PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * ROW_GAP, 150)
  return { nodes, edges, width, height }
}

// ── viewBox 状态 ──
interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

export function ArtifactCanvas({
  planSteps,
  artifacts,
  planBranch,
  onPreviewArtifact,
  onBranchFromStep,
  onApplyBranch,
  onDismissBranch,
}: ArtifactCanvasProps) {
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

  // viewBox 平移 + 缩放状态
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewBox, setViewBox] = useState<ViewBox>({ x: 0, y: 0, w: layout.width, h: layout.height })
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; step: number } | null>(null)

  // 拖拽状态（ref 避免频繁 re-render）
  const dragRef = useRef<{ startX: number; startY: number; vbX: number; vbY: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // layout 变化时重置 viewBox
  const layoutKey = `${layout.width}x${layout.height}`
  const lastLayoutKey = useRef(layoutKey)
  if (lastLayoutKey.current !== layoutKey) {
    lastLayoutKey.current = layoutKey
    setViewBox({ x: 0, y: 0, w: layout.width, h: layout.height })
  }

  // ── 拖拽平移 ──
  const onSvgMouseDown = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      // 仅左键且非节点点击时才拖拽
      if (e.button !== 0) return
      const target = e.target as Element
      // 点到节点/产物时不拖拽
      if (target.closest('[data-node]')) return
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        vbX: viewBox.x,
        vbY: viewBox.y,
      }
      setIsDragging(true)
      setSelectedStep(null)
      setContextMenu(null)
    },
    [viewBox.x, viewBox.y],
  )

  const onSvgMouseMove = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      if (!dragRef.current) return
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      // 把屏幕像素位移换算成 viewBox 坐标位移
      const scaleX = viewBox.w / rect.width
      const scaleY = viewBox.h / rect.height
      const dx = (e.clientX - dragRef.current.startX) * scaleX
      const dy = (e.clientY - dragRef.current.startY) * scaleY
      setViewBox((vb) => ({
        ...vb,
        x: dragRef.current!.vbX - dx,
        y: dragRef.current!.vbY - dy,
      }))
    },
    [viewBox.w, viewBox.h],
  )

  const onSvgMouseUp = useCallback(() => {
    dragRef.current = null
    setIsDragging(false)
  }, [])

  // ── 滚轮缩放（以指针位置为中心） ──
  const onWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      // 指针在容器内的归一化坐标 (0~1)
      const px = (e.clientX - rect.left) / rect.width
      const py = (e.clientY - rect.top) / rect.height
      // 缩放因子
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
      const newW = Math.min(Math.max(viewBox.w * factor, layout.width * MIN_SCALE), layout.width * MAX_SCALE)
      const newH = newW * (viewBox.h / viewBox.w)
      // 以指针位置为锚点缩放：保持指针下的世界坐标不变
      const worldX = viewBox.x + px * viewBox.w
      const worldY = viewBox.y + py * viewBox.h
      setViewBox({
        x: worldX - px * newW,
        y: worldY - py * newH,
        w: newW,
        h: newH,
      })
    },
    [viewBox, layout.width],
  )

  // ── 工具栏按钮：重置缩放 ──
  const resetView = useCallback(() => {
    setViewBox({ x: 0, y: 0, w: layout.width, h: layout.height })
  }, [layout.width, layout.height])

  // ── 节点右键菜单 ──
  const onNodeContextMenu = useCallback(
    (e: MouseEvent<SVGGElement>, step: number) => {
      e.preventDefault()
      e.stopPropagation()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setContextMenu({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        step,
      })
      setSelectedStep(step)
    },
    [],
  )

  const onNodeClick = useCallback(
    (e: MouseEvent<SVGGElement>, step: number) => {
      e.stopPropagation()
      setSelectedStep((prev) => (prev === step ? null : step))
      setContextMenu(null)
    },
    [],
  )

  // ── 产物文件点击 ──
  const onArtifactClick = useCallback(
    (e: MouseEvent<SVGTextElement>, path: string) => {
      e.stopPropagation()
      onPreviewArtifact(path)
    },
    [onPreviewArtifact],
  )

  // ── 空状态 ──
  if (planSteps.length === 0) {
    return (
      <div className="agent-canvas">
        <div className="agent-canvas__empty">
          运行一次复合任务后，这里会展示可交互的规划 DAG：
          <br />
          拖拽平移 · 滚轮缩放 · 点击节点查看产物 · 右键节点触发分支重规划。
        </div>
      </div>
    )
  }

  const selectedArts = selectedStep !== null ? artifactsByStep.get(selectedStep) ?? [] : []

  return (
    <div
      className="agent-canvas agent-canvas--interactive"
      ref={containerRef}
      onWheel={onWheel}
      onMouseDown={() => setContextMenu(null)}
    >
      {/* 分支对比横幅 */}
      {planBranch && (
        <div className="agent-canvas__branch-banner">
          <div className="agent-canvas__branch-head">
            <GitBranch size={14} />
            <span>分支重规划（从步骤 {planBranch.fromStep + 1} 起）</span>
            <span className="agent-canvas__branch-goal">{planBranch.goalSummary}</span>
          </div>
          <div className="agent-canvas__branch-body">
            <div className="agent-canvas__branch-col">
              <div className="agent-canvas__branch-label">原方案（{planBranch.originalTail.length} 步）</div>
              {planBranch.originalTail.map((t) => (
                <div key={t.step} className="agent-canvas__branch-item agent-canvas__branch-item--old">
                  <span className="agent-canvas__branch-step">{t.step}</span>
                  <span>{truncate(t.title, 16)}</span>
                </div>
              ))}
            </div>
            <div className="agent-canvas__branch-col">
              <div className="agent-canvas__branch-label">新分支（{planBranch.branchTasks.length} 步）</div>
              {planBranch.branchTasks.map((t: BranchStep) => (
                <div key={t.step} className="agent-canvas__branch-item agent-canvas__branch-item--new">
                  <span className="agent-canvas__branch-step">{t.step}</span>
                  <span>{truncate(t.title, 16)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="agent-canvas__branch-actions">
            <button type="button" className="agent-canvas__branch-btn agent-canvas__branch-btn--apply" onClick={onApplyBranch}>
              应用分支
            </button>
            <button type="button" className="agent-canvas__branch-btn agent-canvas__branch-btn--dismiss" onClick={onDismissBranch}>
              放弃
            </button>
          </div>
        </div>
      )}

      {/* 工具栏 */}
      <div className="agent-canvas__toolbar">
        <button type="button" title="重置视图" onClick={resetView}>
          <Maximize size={14} />
        </button>
      </div>

      {/* SVG 画布 */}
      <svg
        className={`agent-canvas__svg${isDragging ? ' is-dragging' : ''}`}
        width="100%"
        height="100%"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onSvgMouseDown}
        onMouseMove={onSvgMouseMove}
        onMouseUp={onSvgMouseUp}
        onMouseLeave={onSvgMouseUp}
      >
        <defs>
          <marker id="ac-arrow-i" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="var(--color-border, #c4c9d4)" />
          </marker>
        </defs>
        {/* 连线 */}
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
              markerEnd="url(#ac-arrow-i)"
            />
          )
        })}
        {/* 节点 */}
        {layout.nodes.map((n) => {
          const arts = artifactsByStep.get(n.step) ?? []
          const color = STATUS_COLOR[n.node.status]
          const isSelected = selectedStep === n.step
          return (
            <g
              key={n.step}
              data-node
              transform={`translate(${n.x},${n.y})`}
              onClick={(e) => onNodeClick(e, n.step)}
              onContextMenu={(e) => onNodeContextMenu(e, n.step)}
              style={{ cursor: 'pointer' }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={10}
                ry={10}
                fill={isSelected ? 'var(--color-background-subtle, #f0f4ff)' : 'var(--color-background, #fff)'}
                stroke={color}
                strokeWidth={isSelected ? 2.5 : 1.5}
              />
              <circle cx={16} cy={16} r={10} fill={color} />
              <text x={16} y={20} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">
                {n.node.step}
              </text>
              <text x={34} y={20} fontSize={12.5} fontWeight={600} fill="var(--color-foreground, #222)">
                {truncate(n.node.title, 11)}
              </text>
              {arts.length > 0 && (
                <text
                  x={10}
                  y={54}
                  fontSize={11}
                  fill="var(--color-primary, #1677ff)"
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => onArtifactClick(e, arts[0].path)}
                  data-artifact
                >
                  产物 {arts.length} →
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

      {/* 选中节点的产物列表（侧边浮层） */}
      {selectedStep !== null && selectedArts.length > 0 && (
        <div className="agent-canvas__artifact-panel">
          <div className="agent-canvas__artifact-head">
            <FileText size={13} />
            <span>步骤 {selectedStep} 的产物（{selectedArts.length}）</span>
            <button type="button" onClick={() => setSelectedStep(null)}>
              <X size={13} />
            </button>
          </div>
          <div className="agent-canvas__artifact-list">
            {selectedArts.map((a) => (
              <button
                key={a.artifactId}
                type="button"
                className="agent-canvas__artifact-item"
                onClick={() => onPreviewArtifact(a.path)}
                title={a.path}
              >
                <FileText size={14} className="agent-canvas__artifact-icon" />
                <div className="agent-canvas__artifact-info">
                  <div className="agent-canvas__artifact-name">{truncate(a.description, 24)}</div>
                  <div className="agent-canvas__artifact-path">{truncate(a.path, 40)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="agent-canvas__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onBranchFromStep(contextMenu.step)
              setContextMenu(null)
            }}
          >
            <GitBranch size={13} />
            从步骤 {contextMenu.step} 起分支重规划
          </button>
        </div>
      )}
    </div>
  )
}
