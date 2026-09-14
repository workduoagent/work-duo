/**
 * 本轮执行 DAG 画布（第二期 · 方案 C Graph-first 升级版 · ReactFlow 重写）。
 *
 * 相对旧 SVG 版的关键升级（用户二期反馈）：
 *  - **鱼骨图布局（自上而下）**：顶层规划步骤节点（PlanStep）排成左侧纵向「脊柱」，
 *    每个步骤内部实际执行的工具调用（ToolStep）向右展开成「L 形骨刺」：先水平向右
 *    延伸，再在第 `tailCol` 列向下垂直堆叠。越靠上的步骤「尾巴」越长，自动避让下方
 *    步骤的垂直骨刺，整体呈自上而下鱼骨图（步骤脊柱 → L 形工具骨刺两级结构）。
 *  - **边由指向它的节点控制**：每条边的颜色 = 其 target 节点状态色；
 *    running/pending → 虚线，success/failed/skipped → 实线；失败节点入边自动红色。
 *  - 数据全部来自 `useAgentSession` 实时前端状态（`planSteps`/`toolSteps`），无后端依赖。
 *  - 自定义节点（plan / tool）带状态色描边、状态图标，选中高亮。
 *  - 点选节点 → 底部详情框（**渲染在 ReactFlow 画布之外**，滚轮只滚详情、不会缩放图）。
 *  - 保留：分支横幅（planBranch）+ 右键「从此步骤分支」+ 工具条（ReactFlow 自带 Controls）。
 *  - 三态：COMPOSITE（完整 DAG）/ SIMPLE_CHAT（无 plan → 单点任务卡）/ 空（未运行）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GitBranch, X, FileText, Loader2, CheckCircle2, XCircle, Wrench } from 'lucide-react'
import type {
  ArtifactRef,
  BranchStep,
  PlanBranchGenerated,
  PlanStep,
  ToolStep,
} from './types'

interface RunDagCanvasProps {
  planSteps: PlanStep[]
  toolSteps: ToolStep[]
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
const STEP_W = 208
const STEP_H = 66
const ROW_PITCH = 112 // 步骤脊柱纵向行距
const TOOL_W = 176
const TOOL_H = 34
const TOOL_GAP = 40 // 相邻工具列之间的横向净间距
const COL_PITCH = TOOL_W + TOOL_GAP // 相邻工具列的横向中心距
const VERTICAL_PITCH = 72 // 同一列内工具垂直堆叠的纵向间距
const STEP_TOOL_GAP = 64 // 步骤节点右缘 → 首个工具子节点的横向间距

// ── 状态色（CSS 变量，跟随主题） ──
const PLAN_COLOR: Record<string, string> = {
  pending: 'var(--color-border-strong, #98a2b3)',
  running: 'var(--color-info, #3B82F6)',
  success: 'var(--color-success, #10B981)',
  failed: 'var(--color-error, #EF4444)',
  skipped: 'var(--color-muted, #9ca3af)',
}
const TOOL_COLOR: Record<string, string> = {
  pending: 'var(--color-border-strong, #98a2b3)',
  running: 'var(--color-info, #3B82F6)',
  success: 'var(--color-success, #10B981)',
  failed: 'var(--color-error, #EF4444)',
  skipped: 'var(--color-muted, #9ca3af)',
}
const planColor = (s: string) => PLAN_COLOR[s] ?? PLAN_COLOR.pending
const toolColor = (s: string) => TOOL_COLOR[s] ?? TOOL_COLOR.running

const PLAN_LABEL: Record<string, string> = {
  pending: '待运行',
  running: '进行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
}
const TOOL_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '执行中',
  success: '成功',
  failed: '失败',
  skipped: '已跳过',
}

// 工具中文展示名（优先按完整 toolName，再按去前缀的 toolLabel；MCP 工具降级为「服务·工具」）。
const TOOL_DISPLAY: Record<string, string> = {
  'native__run_python_sandbox': 'Python 沙箱执行',
  run_python_sandbox: 'Python 沙箱执行',
  'native__run_node_sandbox': 'Node 沙箱执行',
  run_node_sandbox: 'Node 沙箱执行',
  'native__read_file': '读取文件',
  read_file: '读取文件',
  'native__write_file': '写入文件',
  write_file: '写入文件',
  'native__edit_file': '编辑文件',
  edit_file: '编辑文件',
  'native__delete_path': '删除文件/目录',
  delete_path: '删除文件/目录',
  'native__move_path': '移动/重命名',
  move_path: '移动/重命名',
  'native__list_files': '列出文件',
  list_files: '列出文件',
  'native__list_directory': '列出文件',
  list_directory: '列出文件',
  'native__grep_files': '搜索文件内容',
  grep_files: '搜索文件内容',
  'native__zip_create': '创建压缩包',
  zip_create: '创建压缩包',
  'native__zip_extract': '解压文件',
  zip_extract: '解压文件',
  'native__regex_replace': '正则替换',
  regex_replace: '正则替换',
  'native__http_request': 'HTTP 请求',
  http_request: 'HTTP 请求',
  'native__ask_user_choice': '询问用户选择',
  ask_user_choice: '询问用户选择',
  'native__anchor_memory': '锚定记忆',
  anchor_memory: '锚定记忆',
}
function toolDisplay(t: ToolStep): string {
  if (TOOL_DISPLAY[t.toolName]) return TOOL_DISPLAY[t.toolName]
  if (TOOL_DISPLAY[t.toolLabel]) return TOOL_DISPLAY[t.toolLabel]
  if (t.toolName.startsWith('mcp__')) {
    const parts = t.toolName.split('__')
    const svc = parts[1] ?? ''
    const tool = parts[2] ?? t.toolLabel
    return `${svc}·${tool}`
  }
  return t.toolLabel
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ── 自定义节点数据形状 ──
interface PlanNodeData {
  kind: 'plan'
  step: number
  title: string
  status: string
  summary?: string
  subCount: number
  artifactCount: number
  selected: boolean
  [key: string]: unknown
}
interface ToolNodeData {
  kind: 'tool'
  callId: string
  display: string
  status: string
  op?: string
  selected: boolean
  [key: string]: unknown
}

// ── 规划步骤节点（大节点，左侧脊柱） ──
function PlanNode({ data }: NodeProps) {
  const d = data as PlanNodeData
  const color = planColor(d.status)
  const running = d.status === 'running'
  const failed = d.status === 'failed'
  return (
    <div
      className={`rf-plan${d.selected ? ' is-selected' : ''}${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}
      style={{ borderColor: color, ['--accent' as string]: color }}
    >
      <Handle type="target" position={Position.Top} id="t" className="rf-handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="rf-handle" />
      <Handle type="source" position={Position.Right} id="r" className="rf-handle" />

      <span className="rf-plan__badge" style={{ background: color }}>
        {running ? <Loader2 size={12} className="rf-spin" /> : failed ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
      </span>
      <div className="rf-plan__main">
        <div className="rf-plan__title">
          <span className="rf-plan__step">步骤 {d.step}</span>
          <span className="rf-plan__name" title={d.title}>{d.title}</span>
        </div>
        <div className="rf-plan__meta">
          <span className="rf-plan__status" style={{ color }}>
            {PLAN_LABEL[d.status] ?? d.status}
          </span>
          {d.subCount > 0 && <span className="rf-plan__sub">{d.subCount} 个动作</span>}
          {d.artifactCount > 0 && (
            <span className="rf-plan__art">
              <FileText size={11} /> {d.artifactCount} 产物
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 工具子节点（小节点，向右递进） ──
function ToolNode({ data }: NodeProps) {
  const d = data as ToolNodeData
  const color = toolColor(d.status)
  const running = d.status === 'running'
  const failed = d.status === 'failed'
  return (
    <div
      className={`rf-tool${d.selected ? ' is-selected' : ''}${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}
      style={{ borderColor: color, ['--accent' as string]: color }}
      title={d.display}
    >
      <Handle type="target" position={Position.Left} id="l" className="rf-handle" />
      <Handle type="source" position={Position.Right} id="r" className="rf-handle" />
      <Handle type="target" position={Position.Top} id="t" className="rf-handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="rf-handle" />

      <span className="rf-tool__icon" style={{ background: color }}>
        {running ? <Loader2 size={11} className="rf-spin" /> : failed ? <XCircle size={11} /> : <CheckCircle2 size={11} />}
      </span>
      <span className="rf-tool__name">{truncate(d.display, 10)}</span>
      <span className="rf-tool__status" style={{ color }}>
        {TOOL_LABEL[d.status] ?? d.status}
      </span>
    </div>
  )
}

const nodeTypes = { plan: PlanNode, tool: ToolNode }

type SelectedNode =
  | { kind: 'plan'; step: number }
  | { kind: 'tool'; callId: string }
  | null

export function RunDagCanvas(props: RunDagCanvasProps) {
  const { planSteps, toolSteps, artifacts, planBranch } = props
  const isComposite = planSteps.length > 0
  const hasAny = planSteps.length > 0 || toolSteps.length > 0

  const [selected, setSelected] = useState<SelectedNode>(null)

  const artifactsByStep = useMemo(() => {
    const m = new Map<number, ArtifactRef[]>()
    artifacts.forEach((a) => {
      const arr = m.get(a.step) ?? []
      arr.push(a)
      m.set(a.step, arr)
    })
    return m
  }, [artifacts])

  // 工具按步骤归组（保持事件到达顺序）
  const toolsByStep = useMemo(() => {
    const m = new Map<number, ToolStep[]>()
    toolSteps.forEach((t) => {
      if (typeof t.step !== 'number') return
      const arr = m.get(t.step) ?? []
      arr.push(t)
      m.set(t.step, arr)
    })
    return m
  }, [toolSteps])

  const taskIdMap = useMemo(() => {
    const m = new Map<string, number>()
    planSteps.forEach((s) => s.taskId && m.set(s.taskId, s.step))
    return m
  }, [planSteps])

  // ── 构建节点 / 边 ──
    const { nodes, edges } = useMemo(() => {
      const ns: Node[] = []
      const statusOf = new Map<string, string>() // nodeId -> status（用于边着色）

      // 自底向上计算每步的「垂直下落列」tailCol：最后一步落在第 1 列，
      // 上方步骤依次向右多借一列，避免垂直骨刺互相遮挡。
      const tailColByIndex: number[] = new Array(planSteps.length).fill(0)
      let maxColBelow = 0
      for (let idx = planSteps.length - 1; idx >= 0; idx--) {
        const step = planSteps[idx]
        const toolCount = toolsByStep.get(step.step)?.length ?? 0
        if (toolCount > 0) {
          tailColByIndex[idx] = maxColBelow + 1
          maxColBelow = Math.max(maxColBelow, tailColByIndex[idx])
        }
      }

      planSteps.forEach((s, i) => {
      const sel = selected?.kind === 'plan' && selected.step === s.step
      statusOf.set(`plan-${s.step}`, s.status)
      ns.push({
        id: `plan-${s.step}`,
        type: 'plan',
        // 步骤脊柱：左侧纵向排布，第 i 个步骤落在第 i 行
        position: { x: 0, y: i * ROW_PITCH },
        draggable: false,
        data: {
          kind: 'plan',
          step: s.step,
          title: s.title,
          status: s.status,
          summary: s.summary,
          subCount: toolsByStep.get(s.step)?.length ?? 0,
          artifactCount: artifactsByStep.get(s.step)?.length ?? 0,
          selected: sel,
        } satisfies PlanNodeData,
      })

      const subs = toolsByStep.get(s.step) ?? []
      const tailCol = tailColByIndex[i] // 0 表示该步骤没有工具
      const horizontalCount = Math.min(subs.length, tailCol)
      const baseX = STEP_W + STEP_TOOL_GAP
      const baseY = i * ROW_PITCH + (STEP_H - TOOL_H) / 2
      subs.forEach((t, j) => {
        const tsel = selected?.kind === 'tool' && selected.callId === t.callId
        statusOf.set(`tool-${t.callId}`, t.status)
        // L 形骨刺：前 tailCol 个工具水平向右，剩余工具在 tailCol 列垂直向下堆叠
        const isHorizontal = j < horizontalCount
        ns.push({
          id: `tool-${t.callId}`,
          type: 'tool',
          position: isHorizontal
            ? { x: baseX + j * COL_PITCH, y: baseY }
            : {
                x: baseX + (horizontalCount - 1) * COL_PITCH,
                y: baseY + (j - horizontalCount + 1) * VERTICAL_PITCH,
              },
          draggable: false,
          data: {
            kind: 'tool',
            callId: t.callId,
            display: toolDisplay(t),
            status: t.status,
            op: t.op,
            selected: tsel,
          } satisfies ToolNodeData,
        })
      })
    })

    // 边颜色/虚线由「指向它的节点」决定
    const edgeFor = (targetId: string, source: string, sourceHandle: string, targetHandle: string): Edge => {
      const st = statusOf.get(targetId) ?? 'pending'
      const color = targetId.startsWith('plan-') ? planColor(st) : toolColor(st)
      const dashed = st === 'running' || st === 'pending'
      return {
        id: `e-${source}-${targetId}`,
        source,
        sourceHandle,
        target: targetId,
        targetHandle,
        type: 'smoothstep',
        animated: st === 'running',
        style: {
          stroke: color,
          strokeWidth: st === 'failed' ? 2.6 : 1.9,
          strokeDasharray: dashed ? '6 5' : undefined,
        },
        markerEnd: { type: 'arrowclosed', color, width: 14, height: 14 } as NonNullable<Edge['markerEnd']>,
      }
    }

    const es: Edge[] = []
    // ① 步骤间依赖边（脊柱纵向连）
    planSteps.forEach((s) => {
      ;(s.dependsOn ?? []).forEach((dep) => {
        const depStep = taskIdMap.get(dep)
        if (depStep === undefined) return
        es.push(edgeFor(`plan-${s.step}`, `plan-${depStep}`, 'b', 't'))
      })
    })
    // ② 父子边（步骤 → 首个工具）+ ③ 链式边（工具 → 工具）
    planSteps.forEach((s, i) => {
      const subs = toolsByStep.get(s.step) ?? []
      const tailCol = tailColByIndex[i]
      const horizontalCount = Math.min(subs.length, tailCol)
      subs.forEach((t, j) => {
        if (j === 0) {
          es.push(edgeFor(`tool-${t.callId}`, `plan-${s.step}`, 'r', 'l'))
          return
        }
        const prev = subs[j - 1]
        if (j < horizontalCount) {
          // 水平链：右 → 左
          es.push(edgeFor(`tool-${t.callId}`, `tool-${prev.callId}`, 'r', 'l'))
        } else {
          // 从水平末节点垂直下落：下 → 上
          es.push(edgeFor(`tool-${t.callId}`, `tool-${prev.callId}`, 'b', 't'))
        }
      })
    })

    return { nodes: ns, edges: es }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planSteps, toolSteps, selected, taskIdMap, toolsByStep, artifactsByStep])

  // 空态
  if (!hasAny) {
    return (
      <div className="agent-dag">
        <div className="agent-dag__empty">
          发送一次任务后，这里会展示本轮执行 DAG：
          <br />
          规划步骤（左侧脊柱）+ 每步内部实际调用的工具（向右展开再垂直下落，呈 L 形鱼骨骨刺），拖拽平移 · 滚轮缩放 · 点击节点看详情。
        </div>
      </div>
    )
  }

  // SIMPLE_CHAT 单点任务卡（无 plan → 不造假 DAG）
  if (!isComposite) {
    return (
      <div className="agent-dag agent-dag--simple">
        <div className="agent-dag__simple-head">
          <Wrench size={13} />
          <span>单点任务（无规划 DAG）</span>
        </div>
        <div className="agent-dag__simple-flow">
          {toolSteps.map((t) => {
            const color = toolColor(t.status)
            const sel = selected?.kind === 'tool' && selected.callId === t.callId
            return (
              <div
                key={t.callId}
                className={`agent-dag__simple-item${sel ? ' is-selected' : ''}`}
                onClick={() => setSelected((p) => (p?.kind === 'tool' && p.callId === t.callId ? null : { kind: 'tool', callId: t.callId }))}
                style={{ borderLeftColor: color }}
              >
                <span className="agent-dag__simple-dot" style={{ background: color }} />
                <span className="agent-dag__simple-name">{toolDisplay(t)}</span>
                {t.op && <span className="agent-dag__simple-op">{t.op}</span>}
                {t.path && <span className="agent-dag__simple-path" title={t.path}>→ {truncate(t.path, 28)}</span>}
              </div>
            )
          })}
        </div>
        {selected?.kind === 'tool' && (
          <div className="agent-dag__detail">
            <ToolDetail
              tool={toolSteps.find((x) => x.callId === selected.callId)!}
              onPreviewArtifact={props.onPreviewArtifact}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <DagFlow
        nodes={nodes}
        edges={edges}
        selected={selected}
        setSelected={setSelected}
        planSteps={planSteps}
        toolSteps={toolSteps}
        artifactsByStep={artifactsByStep}
        planBranch={planBranch}
        onPreviewArtifact={props.onPreviewArtifact}
        onBranchFromStep={props.onBranchFromStep}
        onApplyBranch={props.onApplyBranch}
        onDismissBranch={props.onDismissBranch}
      />
    </ReactFlowProvider>
  )
}

interface DagFlowProps {
  nodes: Node[]
  edges: Edge[]
  selected: SelectedNode
  setSelected: Dispatch<SetStateAction<SelectedNode>>
  planSteps: PlanStep[]
  toolSteps: ToolStep[]
  artifactsByStep: Map<number, ArtifactRef[]>
  planBranch: PlanBranchGenerated | null
  onPreviewArtifact: (path: string) => void
  onBranchFromStep: (step: number) => void
  onApplyBranch: () => void
  onDismissBranch: () => void
}

function DagFlow({
  nodes,
  edges,
  selected,
  setSelected,
  planSteps,
  toolSteps,
  artifactsByStep,
  planBranch,
  onPreviewArtifact,
  onBranchFromStep,
  onApplyBranch,
  onDismissBranch,
}: DagFlowProps) {
  const { fitView } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; step: number } | null>(null)

  // 仅在「节点/边数量」变化时自动 fit（运行中状态变化不重置视图）；结构稳定则保留用户平移/缩放
  const structSig = `${nodes.length}x${edges.length}`
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.18, duration: 280 }), 80)
    return () => clearTimeout(t)
  }, [structSig, fitView])

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const d = node.data as { kind: string }
      if (d.kind === 'plan') {
        const step = (node.data as PlanNodeData).step
        setSelected((prev) => (prev?.kind === 'plan' && prev.step === step ? null : { kind: 'plan', step }))
      } else {
        const callId = (node.data as ToolNodeData).callId
        setSelected((prev) => (prev?.kind === 'tool' && prev.callId === callId ? null : { kind: 'tool', callId }))
      }
      setContextMenu(null)
    },
    [setSelected],
  )

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: Node) => {
      e.preventDefault()
      const d = node.data as { kind: string }
      if (d.kind !== 'plan') return
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect) return
      setContextMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, step: (node.data as PlanNodeData).step })
    },
    [],
  )

  // 选中详情（从 props 真实数据取，避免把节点对象塞进 data）
  const detailPlan = selected?.kind === 'plan' ? planSteps.find((p) => p.step === selected.step) : undefined
  const detailTool = selected?.kind === 'tool' ? toolSteps.find((x) => x.callId === selected.callId) : undefined
  const detailArts = detailPlan ? artifactsByStep.get(detailPlan.step) ?? [] : []

  return (
    <div className="agent-dag agent-dag--interactive" ref={wrapRef}>
      {planBranch && (
        <div className="agent-dag__branch-banner">
          <div className="agent-dag__branch-head">
            <GitBranch size={14} />
            <span>分支重规划（从步骤 {planBranch.fromStep + 1} 起）</span>
            <span className="agent-dag__branch-goal">{planBranch.goalSummary}</span>
          </div>
          <div className="agent-dag__branch-body">
            <div className="agent-dag__branch-col">
              <div className="agent-dag__branch-label">原方案（{planBranch.originalTail.length} 步）</div>
              {planBranch.originalTail.map((t: BranchStep) => (
                <div key={t.step} className="agent-dag__branch-item agent-dag__branch-item--old">
                  <span className="agent-dag__branch-step">{t.step}</span>
                  <span>{truncate(t.title, 16)}</span>
                </div>
              ))}
            </div>
            <div className="agent-dag__branch-col">
              <div className="agent-dag__branch-label">新分支（{planBranch.branchTasks.length} 步）</div>
              {planBranch.branchTasks.map((t: BranchStep) => (
                <div key={t.step} className="agent-dag__branch-item agent-dag__branch-item--new">
                  <span className="agent-dag__branch-step">{t.step}</span>
                  <span>{truncate(t.title, 16)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="agent-dag__branch-actions">
            <button type="button" className="agent-dag__branch-btn agent-dag__branch-btn--apply" onClick={onApplyBranch}>
              应用分支
            </button>
            <button type="button" className="agent-dag__branch-btn agent-dag__branch-btn--dismiss" onClick={onDismissBranch}>
              放弃
            </button>
          </div>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => {
          setSelected(null)
          setContextMenu(null)
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        maxZoom={2.5}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} color="var(--color-border, #e3e8ef)" />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* 选中节点详情框：渲染在 ReactFlow 之外 → 滚轮只滚详情，不会缩放图 */}
      {(detailPlan || detailTool) && (
        <div className="agent-dag__detail" onWheel={(e) => e.stopPropagation()}>
          <button type="button" className="agent-dag__detail-close" onClick={() => setSelected(null)}>
            <X size={13} />
          </button>
          {detailPlan && (
            <div className="agent-dag__detail-body">
              <div className="agent-dag__detail-title">
                步骤 {detailPlan.step} · {detailPlan.title}
                <span className="agent-dag__detail-status" style={{ color: planColor(detailPlan.status) }}>
                  {PLAN_LABEL[detailPlan.status]}
                </span>
              </div>
              {detailPlan.summary && <div className="agent-dag__detail-sum">{detailPlan.summary}</div>}
              {detailArts.length > 0 && (
                <div className="agent-dag__detail-arts">
                  {detailArts.map((a) => (
                    <button key={a.artifactId} type="button" className="agent-dag__detail-art" onClick={() => onPreviewArtifact(a.path)} title={a.path}>
                      <FileText size={13} />
                      <span>{truncate(a.description || a.path, 22)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {detailTool && (
            <ToolDetail tool={detailTool} onPreviewArtifact={onPreviewArtifact} onClose={() => setSelected(null)} />
          )}
        </div>
      )}

      {/* 右键菜单（仅步骤节点触发） */}
      {contextMenu && (
        <div className="agent-dag__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
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

// ── 工具节点详情（复用渲染） ──
function ToolDetail({
  tool,
  onPreviewArtifact,
  onClose,
}: {
  tool: ToolStep
  onPreviewArtifact: (path: string) => void
  onClose: () => void
}) {
  void onClose
  const color = toolColor(tool.status)
  return (
    <div className="agent-dag__detail-body">
      <div className="agent-dag__detail-title">
        {toolDisplay(tool)}
        <span className="agent-dag__detail-status" style={{ color }}>
          {TOOL_LABEL[tool.status]}
        </span>
      </div>
      {tool.op && (
        <div className="agent-dag__detail-row">
          <span className="agent-dag__detail-k">操作</span>
          <span>{tool.op}</span>
        </div>
      )}
      {tool.path && (
        <div className="agent-dag__detail-row">
          <span className="agent-dag__detail-k">路径</span>
          <span className="agent-dag__detail-path" title={tool.path}>{tool.path}</span>
        </div>
      )}
      {(typeof tool.linesAdded === 'number' || typeof tool.linesRemoved === 'number') && (
        <div className="agent-dag__detail-row">
          <span className="agent-dag__detail-k">变更</span>
          <span className="agent-dag__detail-diff">
            {typeof tool.linesAdded === 'number' && <span className="agent-dag__diff-add">+{tool.linesAdded}</span>}
            {typeof tool.linesRemoved === 'number' && <span className="agent-dag__diff-del">-{tool.linesRemoved}</span>}
          </span>
        </div>
      )}
      {tool.result && (
        <div className="agent-dag__detail-row">
          <span className="agent-dag__detail-k">结果</span>
          <span className="agent-dag__detail-result">{truncate(tool.result.replace(/\s+/g, ' '), 120)}</span>
        </div>
      )}
      {tool.path && (
        <button type="button" className="agent-dag__detail-preview" onClick={() => onPreviewArtifact(tool.path!)}>
          <FileText size={12} /> 预览产物
        </button>
      )}
    </div>
  )
}
