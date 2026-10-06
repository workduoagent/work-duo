import { Tag } from '@/components/ui'

interface SquadMetricsAccView {
    prompt_tokens?: number
    completion_tokens?: number
    budget?: number
    members?: Array<{
        agent_id?: string
        role?: string
        prompt_tokens?: number
        completion_tokens?: number
        wall_ms?: number
    }>
}

/** 花费账目渲染（F038 从 squads-workspace/index.tsx 抽出）。
 *
 * 解析 JSON 后展示「总用量 + 预算水位 + 成员级明细」，解析失败降级为纯文本。
 * 原样搬运，未改逻辑。
 */
export function MetricsRoundView({content}: { content: string }) {
    let acc: SquadMetricsAccView | null
    try {
        // 同 DecisionCenter.contentLines：非对象 JSON 收敛为 null，走下方纯文本降级分支
        const parsed: unknown = JSON.parse(content)
        acc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SquadMetricsAccView) : null
    } catch {
        acc = null
    }
    if (!acc || (acc.prompt_tokens === undefined && acc.completion_tokens === undefined)) {
        return <div className="squad-round__content">{content}</div>
    }
    const prompt = acc.prompt_tokens ?? 0
    const completion = acc.completion_tokens ?? 0
    const total = prompt + completion
    const budget = acc.budget ?? 0
    const pct = budget > 0 ? Math.min(100, Math.round((total / budget) * 100)) : null
    return (
        <div className="squad-round__content">
            <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center'}}>
                <Tag color="geekblue" style={{marginInlineEnd: 0}}>总 tokens {total.toLocaleString()}</Tag>
                <Tag style={{marginInlineEnd: 0}}>输入 {prompt.toLocaleString()}</Tag>
                <Tag style={{marginInlineEnd: 0}}>输出 {completion.toLocaleString()}</Tag>
                {budget > 0 && (
                    <Tag color={pct && pct >= 100 ? 'red' : pct && pct >= 80 ? 'orange' : 'green'} style={{marginInlineEnd: 0}}>
                        预算 {total.toLocaleString()} / {budget.toLocaleString()}（{pct}%）
                    </Tag>
                )}
            </div>
            {acc.members && acc.members.length > 0 && (
                <div style={{marginTop: 6, borderTop: '1px dashed var(--color-border, #eee)', paddingTop: 6}}>
                    {acc.members.map((m, i) => (
                        <div key={i} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12}}>
                            <span style={{minWidth: 90}}>{m.role || m.agent_id || '成员'}</span>
                            <span style={{color: 'var(--color-text-tertiary, #999)'}}>
                                tokens {(m.prompt_tokens ?? 0) + (m.completion_tokens ?? 0)} · 用时 {Math.round((m.wall_ms ?? 0) / 1000)}s
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}