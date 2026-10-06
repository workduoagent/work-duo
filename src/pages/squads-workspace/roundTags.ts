/**
 * 协作轮次类型 → 展示标签映射（F038 从 squads-workspace/index.tsx 抽出）。
 *
 * 被运行控制台（SquadRunConsole）与详情页时间线共用，故独立成文件避免循环引用。
 *
 * F051：原返回 antd 预设色名（`gold` / `orange` / `geekblue` …），这些是 antd
 * 写死的固定 RGB，**不随 5 套色调变化**——在 Mint / Lilac 主题下尤其突兀
 * （整个界面偏青紫，却冒出一个 antd 纯金标签）。现改为语义 `variant`，由
 * `components/ui/Tag` 映射到 CSS 令牌，自动跟随明暗与色调。
 *
 * 语义归类依据「信息性质」而非原先的色相：
 *  - 汇总 / 交付确认 → success（达成态）
 *  - 委派规划 / 交接 / 交付 → brand（协作流）
 *  - 计划 / 检查点门禁 → warn（需人工决策）
 *  - 花费账目 → info（数据）
 *  - 发言 → brand；系统 / 用户插话 → neutral
 */
import type { TagVariant } from '@/components/ui'

function roundTagMeta(kind: string): { label: string; variant: TagVariant } {
  switch (kind) {
    case 'summary':
      return { label: '汇总', variant: 'success' }
    case 'delegation':
      return { label: '委派规划', variant: 'brand' }
    case 'message':
      return { label: '发言', variant: 'brand' }
    case 'system':
      return { label: '系统', variant: 'neutral' }
    case 'plan':
      return { label: '计划门禁', variant: 'warn' }
    case 'handoff':
      return { label: '交接', variant: 'brand' }
    case 'metrics':
      return { label: '花费账目', variant: 'info' }
    case 'checkpoint':
      return { label: '检查点', variant: 'warn' }
    case 'delivery':
      return { label: '交付确认', variant: 'success' }
    case 'inject':
      return { label: '用户插话', variant: 'neutral' }
    default:
      return { label: '交付', variant: 'brand' }
  }
}

export { roundTagMeta }
