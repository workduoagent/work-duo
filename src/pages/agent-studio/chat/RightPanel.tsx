/**
 * 右侧投影面板（S1 拆分自 chat.tsx，台账 §2.2）。
 *
 * 图（本轮 DAG）/ 过程 / 产物 / 处置（四类 HITL 决策）四 Tab + 宽度拖柄 +
 * 收起/展开按钮 + 接管详情条。纯展示组件：全部状态与回调经 props 传入，
 * 组件自身零状态（rightTab/rightOpen 归 chat.tsx 所有）。
 */
import type { RefObject } from 'react'
import { Box, ChevronRight, GitBranch, TriangleAlert, Workflow } from 'lucide-react'
import type { AgentSessionState } from '../session/useAgentSession'
import { TracePanel } from '../session/TracePanel'
import { RunDagCanvas } from '../session/RunDagCanvas'
import { DecisionCenter } from '../session/DecisionCenter'
import { TakeoverPanel } from '../session/TakeoverPanel'
import { ArtifactGallery } from './artifact-ui'

/** 会话运行态切片（工具轮/挂起对象/产物等经 useAgentSession 下发）。 */
type SessionSlice = Pick<
  AgentSessionState,
  | 'planSteps'
  | 'toolSteps'
  | 'artifacts'
  | 'planning'
  | 'isRunning'
  | 'pendingApproval'
  | 'recovery'
  | 'pendingChoice'
  | 'planApproval'
  | 'trace'
  | 'planBranch'
  | 'resolveRecovery'
  | 'submitChoice'
  | 'resolvePlanApproval'
>

export interface RightPanelProps extends SessionSlice {
  rightOpen: boolean
  rightTab: 'graph' | 'process' | 'artifacts' | 'actions'
  setRightTab: (t: 'graph' | 'process' | 'artifacts' | 'actions') => void
  setRightOpen: (v: boolean) => void
  rightWidth: number
  resizeElRef: RefObject<HTMLDivElement | null>
  startResize: (e: React.MouseEvent) => void
  agentName: string
  isTauri: boolean
  activeSessionId: string | null
  onPreviewArtifact: (path: string) => Promise<void> | void
  onBranchFromStep: (step: number) => void
  /** 台账 D4 收官：事件级分叉——由 TracePanel 历史回放发起，chat 层合成轮次并 run。 */
  onForkFromEvent: (req: { prompt: string; initialContext: string }) => void | Promise<void>
  onApplyBranch: () => void
  onDismissBranch: () => void
  onApproval: (decision: 'approve' | 'skip' | 'takeover', guidance?: string, remember?: boolean) => void
}

export function RightPanel(props: RightPanelProps) {
  const {
    rightOpen,
    rightTab,
    setRightTab,
    setRightOpen,
    rightWidth,
    resizeElRef,
    startResize,
    artifacts,
    planSteps,
    toolSteps,
    planning,
    isRunning,
    pendingApproval,
    recovery,
    pendingChoice,
    planApproval,
    trace,
    planBranch,
    resolveRecovery,
    submitChoice,
    resolvePlanApproval,
    agentName,
    isTauri,
    activeSessionId,
    onPreviewArtifact,
    onBranchFromStep,
    onForkFromEvent,
    onApplyBranch,
    onDismissBranch,
    onApproval,
  } = props

  if (!rightOpen) {
    return (
      <button
        type="button"
        className={[
          'agent-chat__right-reopen',
          isRunning && (planning || planSteps.length > 0 || toolSteps.length > 0)
            ? 'agent-chat__right-reopen--pulse'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title="展开执行图"
        onClick={() => setRightOpen(true)}
      >
        <Workflow size={18} />
      </button>
    )
  }

  return (
    <>
      <div className="agent-chat__resize" ref={resizeElRef} onMouseDown={startResize} title="拖拽调节宽度" />
      <aside className="agent-chat__right" style={{ width: rightWidth }}>
        <div className="agent-chat__right-tabs">
          <button
            type="button"
            className={`agent-chat__right-tab ${rightTab === 'graph' ? 'is-active' : ''}`}
            onClick={() => setRightTab('graph')}
          >
            <Workflow size={13} />
            图
          </button>
          <button
            type="button"
            className={`agent-chat__right-tab ${rightTab === 'process' ? 'is-active' : ''}`}
            onClick={() => setRightTab('process')}
          >
            <GitBranch size={13} />
            过程
          </button>
          <button
            type="button"
            className={`agent-chat__right-tab ${rightTab === 'artifacts' ? 'is-active' : ''}`}
            onClick={() => setRightTab('artifacts')}
          >
            <Box size={13} />
            产物（{artifacts.length}）
          </button>
          {/* 处置 Tab（弹窗改版 Phase 1）：授权/恢复决策迁移入口；角标=待处置数量 */}
          <button
            type="button"
            className={`agent-chat__right-tab ${rightTab === 'actions' ? 'is-active' : ''}`}
            onClick={() => setRightTab('actions')}
          >
            <TriangleAlert size={13} />
            处置
            {(pendingApproval || recovery || pendingChoice || planApproval) && (
              <span className="agent-chat__right-tab-badge">
                {(pendingApproval ? 1 : 0) +
                  (recovery ? 1 : 0) +
                  (pendingChoice ? 1 : 0) +
                  (planApproval ? 1 : 0)}
              </span>
            )}
          </button>
          <button
            type="button"
            className="agent-chat__right-collapse"
            title="收起面板"
            onClick={() => setRightOpen(false)}
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="agent-chat__right-body">
          {rightTab === 'graph' ? (
            <RunDagCanvas
              planSteps={planSteps}
              toolSteps={toolSteps}
              artifacts={artifacts}
              planBranch={planBranch}
              planning={planning}
              onPreviewArtifact={onPreviewArtifact}
              onBranchFromStep={onBranchFromStep}
              onApplyBranch={onApplyBranch}
              onDismissBranch={onDismissBranch}
            />
          ) : rightTab === 'process' ? (
            <TracePanel
              intent={trace.intent}
              thinking={trace.thinking}
              planSteps={planSteps}
              toolSteps={toolSteps}
              planning={planning}
              sessionId={activeSessionId ?? undefined}
              onForkFromEvent={onForkFromEvent}
            />
          ) : rightTab === 'actions' ? (
            <DecisionCenter
              approval={pendingApproval}
              recovery={recovery}
              choice={pendingChoice}
              planApproval={planApproval}
              agentName={agentName}
              onApproval={onApproval}
              onResolve={resolveRecovery}
              onSubmitChoice={submitChoice}
              onResolvePlanApproval={resolvePlanApproval}
            />
          ) : (
            <ArtifactGallery artifacts={artifacts} isTauri={isTauri} />
          )}
        </div>
        {/* 接管详情条：工具栈 / 已改动文件 / 失败命令（决策键已迁至「处置」Tab） */}
        {recovery && (
          <div className="agent-chat__right-recovery">
            <TakeoverPanel recovery={recovery} onPreviewArtifact={onPreviewArtifact} />
          </div>
        )}
      </aside>
    </>
  )
}
