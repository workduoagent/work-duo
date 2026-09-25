/**
 * 右栏「处置」中心（弹窗改版，方案 A+B 轻量）。
 *
 * Phase 1（2026-09-17）：授权 / 恢复两类迁入；Phase 2（2026-09-17 晚）：choice / planApproval 迁入，
 * Notification 形态全面退役。四类 HITL 决策卡统一在右栏「处置」Tab 呈现：
 *  - 与执行图 / 过程同屏，长内容走 HitlClamp 内滚机制（flex 链由 decision-center 容器贯通，
 *    按钮⻣定可见——复刻 Notification 65vh 安全网的语义）；
 *  - 引擎单 Agent 串行，同一时刻至多一类挂起；多卡并存时纵向堆叠、均分高度（各自内滚）；
 *  - OS 原生通知保留（窗口最小化时仍提醒）。
 *
 * 决策语义（零变化）：
 *  - approval: approve=放行 / skip=跳过 / takeover=放行+补充指示；15007 策略命中时
 *    卡片渲染命中原因 + 「本任务内记住」勾选（remember+grantKey 回传写入 grants）
 *  - recovery: retry / skip / takeover / change-approach（后两者携带 guidance）
 *  - choice: optionId（或 __custom__ + customText）
 *  - planApproval: approve=批准 / reject=拒绝 / revise=按意见重规划（携带 guidance）；
 *    15007 起渲染计划内敏感操作清单（批准=一次授权整清单）
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Hand,
  Inbox,
  RotateCcw,
  ShieldAlert,
  SkipForward,
  X,
} from 'lucide-react'
import { Button, Checkbox, Input } from '@/components/ui'
import { notifyOSWhenHidden } from '@/utils/osNotify'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import type {
  ApprovalRequest,
  ChoiceRequest,
  PlanApprovalRequest,
  RecoveryRequest,
} from './types'

export interface DecisionCenterProps {
  approval: ApprovalRequest | null
  recovery: RecoveryRequest | null
  choice: ChoiceRequest | null
  planApproval: PlanApprovalRequest | null
  agentName: string
  /** 授权决策回调：approve=授权执行 / skip=跳过 / takeover=授权+补充指示；remember=「本任务内记住」。 */
  onApproval: (
    decision: 'approve' | 'skip' | 'takeover',
    guidance?: string,
    remember?: boolean,
  ) => void
  /** 恢复决策回调：retry / skip / takeover / change-approach（后两者携带 guidance）。 */
  onResolve: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => void
  /** 方案推荐回调：用户点选的 optionId；走「其他 / 自定义」时携带 customText。 */
  onSubmitChoice: (optionId: string, customText?: string) => void
  /** 计划审批回调：approve / reject / revise（携带意见）。 */
  onResolvePlanApproval: (decision: 'approve' | 'reject' | 'revise', guidance?: string) => void
}

/* ------------------------------------------------------------------ *
 * HITL 弹窗长文案夹层（唯一滚动点）
 * ---------------------------------------------------------------- */

/**
 * HITL 弹窗长文案夹层（唯一滚动点）。
 *
 * 规则：
 * 1. 弹窗整卡不滚、按钮钉底 —— 滚动只发生在本组件 body；
 * 2. 内容放得下收起高度 → 不渲染展开按钮、不限高（无滚动条）；
 * 3. 内容超高 → 收起态限高可滚；展开后撑满弹窗剩余高度（仍只有这一处滚）。
 */
export function HitlClamp({
  children,
  className = '',
  collapsedHeight = 120,
  expandable = false,
  expandLabel = '展开详情',
}: {
  children: ReactNode
  className?: string
  /** 收起态最大高度（px）。 */
  collapsedHeight?: number
  expandable?: boolean
  expandLabel?: string
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => {
      // max-height 不影响 scrollHeight，这里读的是内容真实高度
      setOverflowing(el.scrollHeight > collapsedHeight + 2)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [collapsedHeight, children])

  const showToggle = expandable && (overflowing || open)
  // 收起且超高才限高；放得下或已展开都不设 inline max-height（展开靠 flex 撑满）
  const bodyStyle = !open && overflowing ? { maxHeight: collapsedHeight } : undefined

  return (
    <div className={`hitl-clamp${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <div ref={bodyRef} className="hitl-clamp__body" style={bodyStyle}>
        {children}
      </div>
      {showToggle && (
        <button
          type="button"
          className="hitl-clamp__toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : expandLabel}
          <ChevronDown size={12} className={`hitl-clamp__caret${open ? ' is-open' : ''}`} />
        </button>
      )}
    </div>
  )
}

/** 从入参中提取最关键的授权内容行（避免把整段 JSON 堆进通知）。 */
export function contentLines(req: ApprovalRequest): Array<{ label: string; value: string }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(req.args || '{}')
  } catch {
    args = {}
  }
  const lines: Array<{ label: string; value: string }> = []
  if (typeof args.path === 'string') lines.push({ label: '目标路径', value: args.path })
  if (typeof args.command === 'string') lines.push({ label: '执行命令', value: args.command })
  if (typeof args.content === 'string') {
    const c = args.content as string
    lines.push({ label: '写入内容', value: c.length > 160 ? `${c.slice(0, 160)}…` : c })
  }
  if (lines.length === 0) {
    lines.push({ label: '请求参数', value: req.args || '—' })
  }
  return lines
}

/* ------------------------------------------------------------------ *
 * 四类决策内容组件（自持输入 state；key 变化即重挂载复位）
 * ---------------------------------------------------------------- */

/**
 * 授权决策内容：工具名 / 描述 / 参数清单 / 补充指示输入框 + 三键。
 * 交互语义：跳过=拒绝本轮；授权执行=放行；接管并继续=放行 + 把补充指示注入下一轮。
 */
export function ApprovalContent({
  approval,
  agentName,
  onResolve,
}: {
  approval: ApprovalRequest
  agentName: string
  onResolve: (
    decision: 'approve' | 'skip' | 'takeover',
    guidance?: string,
    remember?: boolean,
  ) => void
}) {
  const [guidance, setGuidance] = useState('')
  const [remember, setRemember] = useState(true)
  const [prodAck, setProdAck] = useState(false)
  const hostMeta = approval.domain === 'host' ? (approval.hostMeta ?? null) : null
  const lines = contentLines(approval)
  const allow = () => {
    // 补充说明非空时，授权执行等价于「接管并继续」：把补充指示一并注入下一轮，
    // 否则后端按 Approve 处理会静默丢弃 guidance（用户备注不生效）。
    const g = guidance.trim()
    const rememberEffective = !!hostMeta && hostMeta.riskLevel === 'L2' ? remember && prodAck : remember
    onResolve(g ? 'takeover' : 'approve', g || undefined, rememberEffective)
  }
  return (
    <div className="agent-approval-note">
      <p className="agent-approval-note__line">
        智能体 <b>{agentName || '未知智能体'}</b> 请求调用工具{' '}
        <b className="agent-approval-note__tool">{approval.toolName}</b>，需要你的授权。
      </p>
      {approval.reason && (
        <p className="agent-approval-note__reason">
          <ShieldAlert size={13} />
          <span>{approval.reason}</span>
        </p>
      )}
      {hostMeta && (
        <ul className="agent-approval-note__args">
          <li>
            <span className="agent-approval-note__label">主机：</span>
            <code className="agent-approval-note__value">
              {hostMeta.serverLabel}（{hostMeta.serverName}）
            </code>
          </li>
          <li>
            <span className="agent-approval-note__label">身份：</span>
            <code className="agent-approval-note__value">
              login={hostMeta.loginUser} → as_user={hostMeta.asUser}
            </code>
          </li>
          <li>
            <span className="agent-approval-note__label">操作：</span>
            <code className="agent-approval-note__value">
              {hostMeta.action} · {hostMeta.riskLevel}
            </code>
          </li>
          {hostMeta.cwd && (
            <li>
              <span className="agent-approval-note__label">CWD：</span>
              <code className="agent-approval-note__value">{hostMeta.cwd}</code>
            </li>
          )}
          {hostMeta.remotePath && (
            <li>
              <span className="agent-approval-note__label">远端路径：</span>
              <code className="agent-approval-note__value">{hostMeta.remotePath}</code>
            </li>
          )}
          {hostMeta.localPath && (
            <li>
              <span className="agent-approval-note__label">本地路径：</span>
              <code className="agent-approval-note__value">{hostMeta.localPath}</code>
            </li>
          )}
          <li>
            <span className="agent-approval-note__label">路径白名单：</span>
            <code className="agent-approval-note__value">{hostMeta.pathAllow.join('、') || '未限制'}</code>
          </li>
        </ul>
      )}
      <HitlClamp collapsedHeight={120} expandable expandLabel="展开描述">
        <div className="agent-approval-note__desc agent-approval-note__desc--md">
          <MarkdownRenderer
            content={approval.description || '该操作可能影响你的文件或系统，请确认是否放行。'}
          />
        </div>
      </HitlClamp>
      <ul className="agent-approval-note__args">
        {lines.map((l, i) => (
          <li key={i}>
            <span className="agent-approval-note__label">{l.label}：</span>
            <code className="agent-approval-note__value">{l.value}</code>
          </li>
        ))}
      </ul>
      <Input
        autoComplete="off"
        className="agent-approval-note__input"
        placeholder="（可选）接管并继续时填写补充指示"
        value={guidance}
        onChange={(e) => setGuidance((e.target as HTMLInputElement).value)}
      />
      {/* 「记住」依赖策略授权 key（同信号放行）：静态门禁卡没有 grantKey，勾选无从生效，不渲染；
          host 域：L3 禁止记住（设计稿 §7.3）；L2 记住需勾选「确认知悉生产影响」二级确认 */}
      {approval.grantKey && (!hostMeta || !hostMeta.l3) && (
        <Checkbox
          className="agent-approval-note__remember"
          checked={remember}
          disabled={!!hostMeta && hostMeta.riskLevel === 'L2' && !prodAck}
          onChange={(e) => setRemember(e.target.checked)}
        >
          本任务内记住该授权（同信号操作不再询问）
        </Checkbox>
      )}
      {hostMeta && hostMeta.riskLevel === 'L2' && (
        <Checkbox
          className="agent-approval-note__remember"
          checked={prodAck}
          onChange={(e) => setProdAck(e.target.checked)}
        >
          我确认知悉：该操作作用于生产服务器，可能产生不可逆影响（L2 记住需二次确认）
        </Checkbox>
      )}
      <div className="agent-approval-note__actions">
        <Button
          variant="ghost"
          size="sm"
          className="agent-approval-note__skip"
          onClick={() => onResolve('skip', undefined, false)}
        >
          <X size={14} />
          跳过
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="agent-approval-note__takeover"
          onClick={() => onResolve('takeover', guidance, !!hostMeta && hostMeta.riskLevel === 'L2' ? remember && prodAck : remember)}
        >
          <Hand size={14} />
          接管并继续
        </Button>
        <Button variant="solid" size="sm" className="agent-approval-note__allow" onClick={allow}>
          <Check size={14} />
          授权执行
        </Button>
      </div>
    </div>
  )
}

/**
 * 异常恢复决策内容：受阻原因 / 已产出，按 `tier` 渲染决策按钮。
 *  - 档 A（可恢复）：跳过 | 重试 | 接管并继续（接管带补充指示输入框）。
 *  - 档 B（高风险歧义，失败≥2次或命中敏感路径）：跳过 | 重试 | 改方案 | 接管并继续，
 *    「改方案」为默认高亮（solid），带新方案输入框，引导用户换思路而非无脑重试。
 */
export function RecoveryContent({
  recovery,
  onResolve,
  agentName,
  compact = false,
}: {
  recovery: RecoveryRequest
  onResolve: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => void
  agentName: string
  compact?: boolean
}) {
  const [takeoverText, setTakeoverText] = useState('')
  const [approachText, setApproachText] = useState('')
  const isB = recovery.tier === 'B'
  const reason = recovery.reason || '（无）'
  const summary = recovery.summary || '（无）'

  // 新的挂起请求（对象身份变化）到达时清空上一次输入：同一 step 的两次挂起没有唯一 id
  // 可作 key，不重置会让上一轮的补充指示/改方案文本残留到本轮（真机 2026-09-17 反馈）。
  useEffect(() => {
    setTakeoverText('')
    setApproachText('')
  }, [recovery])

  // 紧凑模式：一行原因 + 操作按钮（不含输入框/改方案）
  if (compact) {
    return (
      <div className="agent-recovery-note agent-recovery-note--compact">
        <span className="agent-recovery-note__compact-reason" title={reason}>
          <AlertTriangle size={14} />
          <span className="agent-recovery-note__compact-text">{reason}</span>
        </span>
        <div className="agent-recovery-note__actions">
          <Button variant="ghost" size="sm" className="agent-recovery-note__skip" onClick={() => onResolve('skip')}>
            跳过
          </Button>
          <Button variant="outline" size="sm" className="agent-recovery-note__retry" onClick={() => onResolve('retry')}>
            重试
          </Button>
          {isB && (
            <Button
              variant="solid"
              size="sm"
              className="agent-recovery-note__change-btn"
              onClick={() => onResolve('change-approach')}
            >
              改方案
            </Button>
          )}
          <Button
            variant={isB ? 'outline' : 'solid'}
            size="sm"
            className="agent-recovery-note__takeover"
            onClick={() => onResolve('takeover')}
          >
            接管并继续
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-recovery-note">
      <p className="agent-recovery-note__line">
        智能体 <b>{agentName || '未知智能体'}</b> 在步骤{' '}
        <b className="agent-recovery-note__step">
          {recovery.step}「{recovery.title}」
        </b>{' '}
        {isB ? '已多次重试仍失败（高风险歧义），请选择如何处理。' : '自动重试后仍失败，请选择如何处理。'}
      </p>
      <div className="agent-recovery-note__reason">
        <span className="agent-recovery-note__label">受阻原因：</span>
        <HitlClamp className="agent-recovery-note__clamp" collapsedHeight={120} expandable expandLabel="展开完整原因">
          <div className="agent-recovery-note__value agent-recovery-note__value--md">
            <MarkdownRenderer content={reason} />
          </div>
        </HitlClamp>
      </div>
      <div className="agent-recovery-note__tip">工具栈 / 已改动文件 / 失败命令详情见右侧「接管」面板</div>
      {summary !== '（无）' && (
        <div className="agent-recovery-note__summary">
          <span className="agent-recovery-note__label">已产出：</span>
          <HitlClamp className="agent-recovery-note__clamp" collapsedHeight={88} expandable expandLabel="展开产出">
            <div className="agent-recovery-note__value agent-recovery-note__value--md">
              <MarkdownRenderer content={summary} />
            </div>
          </HitlClamp>
        </div>
      )}
      {isB && (
        <div className="agent-recovery-note__change">
          <span className="agent-recovery-note__label">改方案（推荐）：描述新思路 / 新方案</span>
          <Input.TextArea
            className="agent-recovery-note__change-input"
            value={approachText}
            onChange={(e) => setApproachText(e.target.value)}
            placeholder="例如：换用另一种实现方式 / 跳过该外部依赖 / 改用 mock 数据…"
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={500}
          />
        </div>
      )}
      <Input
        autoComplete="off"
        className="agent-recovery-note__input"
        value={takeoverText}
        onChange={(e) => setTakeoverText(e.target.value)}
        placeholder="（可选）接管并继续时填写补充指示"
      />
      <div className="agent-recovery-note__actions">
        <Button variant="ghost" size="sm" className="agent-recovery-note__skip" onClick={() => onResolve('skip')}>
          <SkipForward size={14} />
          跳过
        </Button>
        <Button variant="outline" size="sm" className="agent-recovery-note__retry" onClick={() => onResolve('retry')}>
          <RotateCcw size={14} />
          重试
        </Button>
        {isB && (
          <Button
            variant="solid"
            size="sm"
            className="agent-recovery-note__change-btn"
            onClick={() => onResolve('change-approach', approachText.trim() || undefined)}
          >
            <Hand size={14} />
            改方案
          </Button>
        )}
        <Button
          variant={isB ? 'outline' : 'solid'}
          size="sm"
          className="agent-recovery-note__takeover"
          onClick={() => onResolve('takeover', takeoverText.trim() || undefined)}
        >
          <Hand size={14} />
          接管并继续
        </Button>
      </div>
    </div>
  )
}

/** 方案推荐决策内容：预设选项 chip + 「其他 / 自定义」自由文本入口。 */
export function ChoiceContent({
  choice,
  onSubmit,
}: {
  choice: ChoiceRequest
  onSubmit: (optionId: string, customText?: string) => void
}) {
  const [customText, setCustomText] = useState('')
  const trimmed = customText.trim()
  return (
    <div className="agent-choice-note">
      <HitlClamp collapsedHeight={96} expandable expandLabel="展开问题">
        <div className="agent-choice-note__question agent-choice-note__question--md">
          <MarkdownRenderer content={choice.question} />
        </div>
      </HitlClamp>
      <div className="agent-choice-note__options">
        {choice.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="agent-choice-note__chip"
            onClick={() => onSubmit(o.id)}
          >
            <span className="agent-choice-note__label">{o.label}</span>
            {o.description && <span className="agent-choice-note__desc">{o.description}</span>}
          </button>
        ))}
      </div>
      <div className="agent-choice-note__custom">
        <div className="agent-choice-note__custom-divider">
          <span>或填写自定义方案</span>
        </div>
        <Input.TextArea
          className="agent-choice-note__custom-input"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="如果以上选项都不合适，在此填写你的方案…"
          autoSize={{ minRows: 2, maxRows: 4 }}
          maxLength={500}
        />
        <Button
          className="agent-choice-note__custom-submit"
          type="primary"
          size="sm"
          disabled={!trimmed}
          onClick={() => onSubmit('__custom__', trimmed)}
        >
          提交自定义方案
        </Button>
      </div>
    </div>
  )
}

/** 计划审批决策内容：步骤清单（序号/标题/描述/依赖）+ 批准 / 拒绝 / 修改意见。 */
export function PlanApprovalContent({
  planApproval,
  onResolve,
}: {
  planApproval: PlanApprovalRequest
  onResolve: (decision: 'approve' | 'reject' | 'revise', guidance?: string) => void
}) {
  const [reviseText, setReviseText] = useState('')
  const trimmed = reviseText.trim()
  // 新计划请求（对象身份变化）到达时清空上一次的修改意见（同 09:47 真机反馈的残留 bug）。
  useEffect(() => {
    setReviseText('')
  }, [planApproval])
  // depends_on 存的是 task_id，列表按 step 编号渲染；映射成 step 编号展示依赖。
  const stepByTaskId = new Map<number, number>()
  planApproval.tasks.forEach((t) => {
    if (t.taskId) stepByTaskId.set(Number(t.taskId) || t.step, t.step)
  })
  return (
    <div className="agent-plan-note">
      <div className="agent-plan-note__summary agent-plan-note__summary--md">
        <MarkdownRenderer content={planApproval.goalSummary || '（无目标描述）'} />
      </div>
      {/* 15007 边审批策略：敏感操作清单——批准计划即一次性授权整清单（执行期不再逐次询问） */}
      {planApproval.sensitiveOps && planApproval.sensitiveOps.length > 0 && (
        <div className="agent-plan-note__sensitive">
          <p className="agent-plan-note__sensitive-head">
            <ShieldAlert size={13} />
            本计划包含 {planApproval.sensitiveOps.length} 处敏感操作，批准后随计划一次性授权：
          </p>
          <ul className="agent-plan-note__sensitive-list">
            {planApproval.sensitiveOps.map((s, i) => (
              <li key={`${s.step}-${s.pattern}-${i}`} className="agent-plan-note__sensitive-item">
                <code className="agent-plan-note__sensitive-pattern">{s.pattern}</code>
                <span>
                  步骤 {s.step}「{s.title}」（{s.category}）
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <HitlClamp collapsedHeight={168} expandable expandLabel="展开全部步骤">
        <ul className="agent-plan-note__steps">
          {planApproval.tasks.map((t) => (
            <li key={t.step} className="agent-plan-note__step">
              <span className="agent-plan-note__step-idx">{t.step}</span>
              <div className="agent-plan-note__step-body">
                <span className="agent-plan-note__step-title">{t.title}</span>
                {t.description && <span className="agent-plan-note__step-desc">{t.description}</span>}
                {t.dependsOn && t.dependsOn.length > 0 && (
                  <span className="agent-plan-note__step-dep">
                    依赖：步骤{' '}
                    {t.dependsOn.map((id) => stepByTaskId.get(Number(id)) ?? id).join('、')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </HitlClamp>
      <Input.TextArea
        className="agent-plan-note__revise-input"
        value={reviseText}
        onChange={(e) => setReviseText(e.target.value)}
        placeholder="（可选）点「修改意见」时填写调整要求，例如：第 3 步改为优先用 mock 数据、合并第 2/4 步…"
        autoSize={{ minRows: 2, maxRows: 4 }}
        maxLength={500}
      />
      <div className="agent-plan-note__actions">
        <Button variant="ghost" size="sm" className="agent-plan-note__reject" onClick={() => onResolve('reject')}>
          <X size={14} />
          拒绝
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="agent-plan-note__revise"
          disabled={!trimmed}
          onClick={() => onResolve('revise', trimmed)}
        >
          修改意见
        </Button>
        <Button variant="solid" size="sm" className="agent-plan-note__approve" onClick={() => onResolve('approve')}>
          <Check size={14} />
          批准执行
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 决策卡（标题头 + 内容）与处置中心主体
 * ---------------------------------------------------------------- */

function CardHead({ title }: { title: string }) {
  return (
    <header className="agent-chat__decision-head">
      <span className="agent-chat__decision-title">{title}</span>
    </header>
  )
}

function ApprovalDecisionCard({
  approval,
  agentName,
  onApproval,
}: {
  approval: ApprovalRequest
  agentName: string
  onApproval: DecisionCenterProps['onApproval']
}) {
  // 主窗口未在桌面最前时，弹系统原生通知提醒（保留既有体验）。
  useEffect(() => {
    notifyOSWhenHidden(
      '安全拦截 · 敏感操作需要授权',
      `智能体 ${agentName || '未知智能体'} 请求调用工具 ${approval.toolName}，需要你的授权`,
    ).catch(() => {})
  }, [approval.approvalId, agentName])

  return (
    <section className="agent-approval-note">
      <CardHead title="安全拦截 · 敏感操作需要授权" />
      <ApprovalContent approval={approval} agentName={agentName} onResolve={onApproval} />
    </section>
  )
}

function RecoveryDecisionCard({
  recovery,
  agentName,
  onResolve,
}: {
  recovery: RecoveryRequest
  agentName: string
  onResolve: DecisionCenterProps['onResolve']
}) {
  useEffect(() => {
    notifyOSWhenHidden(
      '步骤受阻 · 需要你的决策',
      `智能体 ${agentName || '未知智能体'} 在步骤 ${recovery.step}「${recovery.title}」重试后仍失败，请选择如何处理`,
    ).catch(() => {})
  }, [recovery.step, agentName])

  return (
    <section className="agent-recovery-note">
      <CardHead title="步骤受阻 · 需要你的决策" />
      <RecoveryContent recovery={recovery} onResolve={onResolve} agentName={agentName} />
    </section>
  )
}

function ChoiceDecisionCard({
  choice,
  agentName,
  onSubmitChoice,
}: {
  choice: ChoiceRequest
  agentName: string
  onSubmitChoice: DecisionCenterProps['onSubmitChoice']
}) {
  useEffect(() => {
    notifyOSWhenHidden(
      '需要你选择',
      `智能体 ${agentName || '未知智能体'}：${choice.question}`,
    ).catch(() => {})
  }, [choice.choiceId, agentName])

  return (
    <section className="agent-choice-note">
      <CardHead title="需要你选择" />
      <ChoiceContent choice={choice} onSubmit={onSubmitChoice} />
    </section>
  )
}

function PlanApprovalDecisionCard({
  planApproval,
  agentName,
  onResolvePlanApproval,
}: {
  planApproval: PlanApprovalRequest
  agentName: string
  onResolvePlanApproval: DecisionCenterProps['onResolvePlanApproval']
}) {
  useEffect(() => {
    notifyOSWhenHidden(
      '计划已生成 · 请审批',
      `智能体 ${agentName || '未知智能体'} 已完成任务拆解（${planApproval.tasks.length} 步），等待你批准执行`,
    ).catch(() => {})
  }, [planApproval.tasks.length, agentName])

  return (
    <section className="agent-plan-note">
      <CardHead title="计划已生成 · 请审批" />
      <PlanApprovalContent planApproval={planApproval} onResolve={onResolvePlanApproval} />
    </section>
  )
}

export function DecisionCenter({
  approval,
  recovery,
  choice,
  planApproval,
  agentName,
  onApproval,
  onResolve,
  onSubmitChoice,
  onResolvePlanApproval,
}: DecisionCenterProps) {
  if (!approval && !recovery && !choice && !planApproval) {
    return (
      <div className="agent-chat__decision-empty">
        <Inbox size={28} />
        <p>暂无待处置项</p>
        <span>任务执行中需要授权 / 步骤受阻需要决策时，会出现在这里。</span>
      </div>
    )
  }
  return (
    <div className="agent-chat__decision-center">
      {planApproval && (
        <PlanApprovalDecisionCard
          planApproval={planApproval}
          agentName={agentName}
          onResolvePlanApproval={onResolvePlanApproval}
        />
      )}
      {approval && (
        <ApprovalDecisionCard
          key={approval.approvalId}
          approval={approval}
          agentName={agentName}
          onApproval={onApproval}
        />
      )}
      {recovery && (
        <RecoveryDecisionCard
          key={recovery.step}
          recovery={recovery}
          agentName={agentName}
          onResolve={onResolve}
        />
      )}
      {choice && (
        <ChoiceDecisionCard
          key={choice.choiceId}
          choice={choice}
          agentName={agentName}
          onSubmitChoice={onSubmitChoice}
        />
      )}
    </div>
  )
}
