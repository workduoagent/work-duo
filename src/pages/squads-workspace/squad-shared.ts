/**
 * squads-workspace 共享工具（F038 抽出）。
 *
 * 为什么单独成文件：`agentAppearanceOf` / `memberLabel` / `MODE_OPTIONS` 被
 * 列表卡片（SquadCard）、运行控制台（SquadRunConsole）、详情页与编辑器共用。
 * 原先都定义在 `index.tsx` 里，而那些子组件又要 import index —— 会形成**循环
 * 依赖**（index → SquadCard → index）。抽出后依赖方向单向：
 * 子组件 → squad-shared → （仅 types 与纯函数），index 亦从此处取用。
 */
import { generateAvatarByScenario } from '@/components/ui/pixel-agent'
import type { PixelAgentAppearance } from '@/components/ui/pixel-agent'
import type { AgentInfo, SquadMode } from '@/types/core'

/** 取智能体的像素小人外观：优先用其自带 appearance，否则按场景生成。 */
export function agentAppearanceOf(agents: AgentInfo[], agentId?: string): PixelAgentAppearance {
  const a = agents.find((x) => x.id === agentId)
  if (a?.appearance) return a.appearance
  return generateAvatarByScenario(a?.scenario, agentId)
}

/** 列表卡成员显示名：role 为空（如流水线工序位）回退智能体名，杜绝裸 agentId。 */
export function memberLabel(m: { role?: string; agentId: string }, agents: AgentInfo[]): string {
  if (m.role && m.role.trim()) return m.role
  return agents.find((a) => a.id === m.agentId)?.name || '未命名成员'
}

/** 协作模式选项（编辑器下拉 + 运行控制台筛选用）。 */
export const MODE_OPTIONS: { label: string; value: SquadMode; desc: string }[] = [
  { label: '编排式', value: 'orchestrator', desc: '主管拆解委派成员，逐子任务执行后汇总' },
  { label: '流水线', value: 'pipeline', desc: '成员线性串流，前步产出喂后步输入' },
  { label: '群聊', value: 'chat', desc: '共享黑板轮流发言，Moderator 收口' },
]
