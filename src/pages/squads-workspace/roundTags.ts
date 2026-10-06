/**
 * 协作轮次类型 → 展示标签映射（F038 从 squads-workspace/index.tsx 抽出）。
 *
 * 被运行控制台（SquadRunConsole）与详情页时间线共用，故独立成文件避免循环引用。
 * 注：色值沿用 antd 预设名（原样搬运，F051 记录的「Tag 用预设色不随主题切换」
 * 问题依然存在，未在本次抽离中改动）。
 */
function roundTagMeta(kind: string): { label: string; color: string } {
    switch (kind) {
        case 'summary':
            return {label: '汇总', color: 'gold'}
        case 'delegation':
            return {label: '委派规划', color: 'blue'}
        case 'message':
            return {label: '发言', color: 'green'}
        case 'system':
            return {label: '系统', color: 'default'}
        case 'plan':
            return {label: '计划门禁', color: 'orange'}
        case 'handoff':
            return {label: '交接', color: 'cyan'}
        case 'metrics':
            return {label: '花费账目', color: 'geekblue'}
        case 'checkpoint':
            return {label: '检查点', color: 'orange'}
        case 'delivery':
            return {label: '交付确认', color: 'gold'}
        case 'inject':
            return {label: '用户插话', color: 'purple'}
        default:
            return {label: '交付', color: 'green'}
    }
}

export { roundTagMeta }
