import {useEffect, useState} from 'react'
import {useNavigate, useParams, useSearchParams} from 'react-router-dom'
import {ArrowLeft} from 'lucide-react'
import {Button, Spin, Tag, Tabs} from '@/components/ui'
import {getSquad} from '@/core/mapper/squad-mapper'
import {listAgents} from '@/core/mapper/agent-mapper'
import type {AgentInfo, SquadInfo} from '@/types/core'
import {SquadRunConsole, SquadHistoryPanel, SquadMemoryPanel} from './index'

const MODE_LABEL: Record<string, string> = {orchestrator: '编排式', pipeline: '流水线', chat: '群聊'}

/** 小分队子页（§7.6 运行工作台）：运行 / 运行历史 / 团队记忆 三 Tab，替代原弹窗入口。 */
export default function SquadDetailPage() {
    const nav = useNavigate()
    const {id} = useParams()
    const [params, setParams] = useSearchParams()
    const tab = params.get('tab') ?? 'run'

    const [squad, setSquad] = useState<SquadInfo | undefined>(undefined)
    const [agents, setAgents] = useState<AgentInfo[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let alive = true
        ;(async () => {
            setLoading(true)
            try {
                const [s, ags] = await Promise.all([id ? getSquad(id) : Promise.resolve(undefined), listAgents()])
                if (!alive) return
                setSquad(s)
                setAgents(ags)
            } finally {
                if (alive) setLoading(false)
            }
        })()
        return () => {
            alive = false
        }
    }, [id])

    if (loading) {
        return <div className="squads squads--detail"><Spin spinning wrapperClassName="squads__spin"/></div>
    }

    if (!squad) {
        return (
            <div className="squads squads--detail">
                <div className="squad-detail__bar">
                    <Button variant="ghost" size="sm" onClick={() => nav('/squads-workspace')}>
                        <ArrowLeft size={14}/> 返回列表
                    </Button>
                </div>
                <div className="squad-detail__missing">未找到该小分队（可能已被删除）。</div>
            </div>
        )
    }

    return (
        <div className="squads squads--detail">
            <div className="squad-detail__bar">
                <Button variant="ghost" size="sm" onClick={() => nav('/squads-workspace')}>
                    <ArrowLeft size={14}/> 返回列表
                </Button>
                <h2 className="squad-detail__title">{squad.name}</h2>
                <Tag color={squad.mode === 'orchestrator' ? 'blue' : squad.mode === 'pipeline' ? 'purple' : 'cyan'}>
                    {MODE_LABEL[squad.mode] ?? squad.mode}
                </Tag>
            </div>

            <Tabs
                activeKey={tab}
                onChange={(k) => setParams(k === 'run' ? {} : {tab: k}, {replace: true})}
                items={[
                    {key: 'run', label: '运行', children: <SquadRunConsole embedded squad={squad} agents={agents} onClose={() => {}} open/>},
                    {key: 'history', label: '运行历史', children: <SquadHistoryPanel embedded squad={squad} agents={agents} onClose={() => {}} open/>},
                    {key: 'memory', label: '团队记忆', children: <SquadMemoryPanel embedded squad={squad} onClose={() => {}} open/>},
                ]}
            />
        </div>
    )
}
