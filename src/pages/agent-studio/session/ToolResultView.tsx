/**
 * 工具返回结果统一渲染分发（解耦核心 · K3-1 收口）。
 *
 * 设计意图：工具结果的「特殊格式渲染」只此一处负责，新增/修改渲染位（对话时间线、
 * 规划时间线、执行图节点详情）无需各自硬编码 `toolName==='native__kb_search'` 判断，
 * 全部经本组件 → 命中 kb_search 则下沉 `KbSearchCitations`，其余按 `variant` 走通用回退。
 * 单一事实源：kb_search 的卡片渲染只存在于 `KbSearchCitations`，本组件仅做路由。
 *
 * `variant`：
 *  - 'inline'  对话时间线（ToolStepLine）：`code` 单行截断
 *  - 'block'   规划时间线（ToolStepCard）：`pre` 美化 JSON
 *  - 'compact' 执行图节点详情（RunDagCanvas）：单行截断，避免大结果撑爆详情框
 */
import { KbSearchCitations } from './KbSearchCitations'
import { stripWinVerbatimInText } from '@/utils/pathDisplay'

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function tryPretty(json?: string): string {
  if (!json) return ''
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

/**
 * 展示净化：工具结果里常带 Rust canonicalize 产生的 Windows 逐字前缀 `\\?\`
 * （如「已写入 12 字节到 \\?\E:\a\b.py」），统一在此收口去掉，各渲染位无需各自处理。
 */
function clean(text: string): string {
  return stripWinVerbatimInText(text)
}

export function ToolResultView({
  toolName,
  result,
  variant = 'block',
  failed,
}: {
  toolName?: string
  result?: string
  variant?: 'inline' | 'block' | 'compact'
  failed?: boolean
}) {
  // 单一路由点：kb_search 一律走引用卡片（解耦——不在各渲染位重复判断）。
  if (toolName === 'native__kb_search') {
    return <KbSearchCitations result={result} />
  }

  if (!result) return null

  const text = clean(result)
  switch (variant) {
    case 'inline':
      return <code className="tool-line__detail-value">{clip(text, 600)}</code>
    case 'compact':
      return <span className="agent-dag__detail-result">{clip(text.replace(/\s+/g, ' '), 160)}</span>
    case 'block':
    default:
      return <pre className={`tool-step__code${failed ? ' is-error' : ''}`}>{tryPretty(text)}</pre>
  }
}
