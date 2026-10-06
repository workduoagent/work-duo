import { memo, useCallback } from 'react'
import { Card, Tag, Button, Popconfirm } from '@/components/ui'
import { FolderOpen, Pencil, Play, Trash2, Users } from 'lucide-react'
import { PixelAgent } from '@/components/ui/pixel-agent'
import { agentAppearanceOf, memberLabel } from './squad-shared'
import type { AgentInfo, SquadInfo, SquadMode } from '@/types/core'

/**
 * 小分队列表卡片（F045）。
 *
 * 背景：`SquadsWorkspacePage` 是 2700+ 行的巨型组件，卡片 JSX 内联在页面里，
 * 且**零 `memo`**。这导致两类高频 state 变化会重绘整棵组件树：
 *  1. `liveStatus` —— 30s 轮询刷新（后台协作实时徽标）；
 *  2. `hoverCrew` —— **鼠标划过任意成员小人**（全局 state，每划过一次就
 *     触发整页重渲染 + 全部卡片内 PixelAgent 的 canvas 重绘）。
 *
 * 抽成 memo 组件后，`React.memo` 的浅比较会让「只有一张卡片的某个成员
 * 被 hover」这类局部变化不再牵连其他卡片。
 *
 * 注意 props 均为**稳定引用**才能让 memo 生效：
 *  - `squad` 来自 `list`，仅在 reload 时整体替换 → 引用稳定；
 *  - `live` 传的是**该卡片自己的状态字符串**（不是整个 map）→ 其他卡片
 *    状态变化不会导致本卡片重渲染，这是本次优化的关键；
 *  - 回调用 `useCallback` 且不捕获变化的值。
 *
 * 常量（模式标签 / 运行态文案）在此就地定义而非从 index.tsx 导入：index 会
 * import 本组件，反向 import 会形成循环依赖；这两张映射表是纯展示常量，
 * 就地定义比抽共享模块更轻。`agentAppearanceOf` / `memberLabel` 是函数且
 * index 已 export，单向引用无环。
 */

/** 协作模式 → 中文标签（与编辑器下拉选项文案一致）。 */
const MODE_LABELS: Record<SquadMode, string> = {
  orchestrator: '编排式',
  pipeline: '流水线',
  chat: '群聊',
}

/** 运行态 → 徽标文案；未列出的状态不渲染徽标。 */
const LIVE_LABELS: Record<string, string> = {
  running: '协作中',
  paused: '已暂停',
  awaiting_plan: '计划待批准',
  awaiting_checkpoint: '待检查点决议',
  awaiting_delivery: '待确认交付',
}

export interface SquadCardProps {
  squad: SquadInfo
  /** 该小分队当前运行态（而非整个 liveStatus map）——保证只有状态变化的卡片重渲染 */
  live: string | undefined
  agents: AgentInfo[]
  /** 当前 hover 的成员槽位 key（`${squadId}-${i}`），由父级持有以支持跨卡共享 hover */
  hoverCrew: string | null
  onHoverCrew: (key: string | null) => void
  /** 打开工作台（路由跳转） */
  onOpen: (s: SquadInfo) => void
  /** 在系统文件管理器中打开该编队的工作空间目录 */
  onOpenPath: (dir: string) => void
  onEdit: (s: SquadInfo) => void
  onDelete: (s: SquadInfo) => void
}

export const SquadCard = memo(function SquadCard({
  squad,
  live,
  agents,
  hoverCrew,
  onHoverCrew,
  onOpen,
  onEdit,
  onDelete,
  onOpenPath,
}: SquadCardProps) {
  // hover 回调统一在此生成，避免每次渲染新建箭头函数（会让 memo 失效）
  const enter = useCallback((i: number) => () => onHoverCrew(`${squad.id}-${i}`), [squad.id, onHoverCrew])
  const leave = useCallback(() => onHoverCrew(null), [onHoverCrew])

  const liveLabel = live ? LIVE_LABELS[live] : undefined

  return (
    <Card frame="solid" className="squads__card">
      <div className="squads__card-head">
        <div className="squads__card-avatar">
          {squad.logo ? <img src={squad.logo} alt={squad.name} className="squads__card-logo" /> : <Users size={20} />}
        </div>
        <div className="squads__card-titles">
          <h3 className="squads__card-title">{squad.name}</h3>
          <div className="squads__card-tags">
            <Tag
              color={squad.mode === 'orchestrator' ? 'blue' : squad.mode === 'pipeline' ? 'purple' : 'cyan'}
              bordered={false}
              style={{ borderRadius: 999, marginInlineEnd: 0 }}
            >
              {MODE_LABELS[squad.mode as SquadMode] ?? squad.mode}
            </Tag>
            {liveLabel && (
              <span className={`squads__live squads__live--${live}`}>
                <i className="squads__live-dot" />
                {liveLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="squads__card-desc">{squad.description || '暂无描述'}</p>

      <div
        className="squads__card-crew"
        title={squad.members.map((m) => memberLabel(m, agents)).join('、')}
      >
        {squad.members.slice(0, 8).map((m, i) => {
          const crewKey = `${squad.id}-${i}`
          return (
            <span
              key={m.id || crewKey}
              className="squads__crew-slot"
              onMouseEnter={enter(i)}
              onMouseLeave={leave}
            >
              <PixelAgent
                appearance={agentAppearanceOf(agents, m.agentId)}
                size={24}
                motion={live === 'running' || hoverCrew === crewKey}
                state="working"
                className="squads__crew-avatar"
              />
            </span>
          )
        })}
        {squad.members.length > 8 && (
          <span className="squads__crew-more">+{squad.members.length - 8}</span>
        )}
      </div>

      <div className="squads__card-actions">
        <Button
          variant="soft"
          size="sm"
          className="squads__card-main"
          onClick={() => onOpen(squad)}
          aria-label="打开协作工作台"
          title="打开协作工作台（运行 / 历史 / 记忆）"
        >
          <Play size={14} /> 工作台
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onEdit(squad)} aria-label="编辑">
          <Pencil size={15} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="打开空间目录"
          title={squad.workspaceDir ? `打开空间目录：${squad.workspaceDir}` : '该编队未配置空间目录'}
          disabled={!squad.workspaceDir}
          onClick={() => {
            if (squad.workspaceDir) void onOpenPath(squad.workspaceDir)
          }}
        >
          <FolderOpen size={15} />
        </Button>
        <Popconfirm
          title="删除小分队"
          description="将同时清理其成员、群聊配置与运行历史，不可恢复。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(squad)}
        >
          <Button variant="ghost" size="sm" className="squads__card-del" aria-label="删除">
            <Trash2 size={15} />
          </Button>
        </Popconfirm>
      </div>
    </Card>
  )
})
