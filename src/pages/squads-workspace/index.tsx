/**
 * 小分队协作车间（路由 /squads-workspace）。
 *
 * 三块能力：
 *  1. 列表：卡片网格展示已创建的小分队（模式徽标 / 成员数 / 描述 / 更新时间）。
 *  2. 编辑：新建 / 编辑小分队（成员人设 + 角色、协作模式、运行策略、群聊配置）。
 *  3. 运行控制台：发起协作任务，实时订阅 squad 事件流（session-started / round / session-done），
 *     以「讨论黑板」形式呈现各成员发言与最终汇总。
 *
 * 数据来自 squad-mapper（Tauri 走 SQLite，非 Tauri 回退 localStorage）；运行走 Tauri 命令
 * `run_squad_task`，事件经 @tauri-apps/api/event 订阅。
 */
import {useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent} from 'react'
import { openPath } from '@tauri-apps/plugin-opener'
import { useNavigate } from 'react-router-dom'
import {
    Plus,
    Trash2,
    Pencil,
    Play,
    Users,
    Settings2,
    FileUp,
    Inbox,
    FolderOpen,
    Info,
    RefreshCw,
    X,
    Server,
    ImagePlus,
    Puzzle,
    SlidersHorizontal,
    ChevronRight,
} from 'lucide-react'
import {Button, Card, Modal, Field, FieldLabel, Input, Select, Segmented, Switch, InputNumber, Empty, Spin, Popconfirm, Tag, Tooltip, Alert} from '@/components/ui'
import { PixelAgent } from '@/components/ui/pixel-agent'
import { generateAvatarByScenario } from '@/components/ui/pixel-agent'
import type { AgentMotionState, PixelAgentAppearance } from '@/components/ui/pixel-agent'
import {useNotify} from '@/components/ui/notify'
import {listAgents} from '@/core/mapper/agent-mapper'
import {
    listSquads,
    latestSquadStatuses,
    upsertSquad,
    deleteSquad,
    listSquadSessions,
    listSquadRounds,
    anchorSquadMemory,
    listSquadMemories,
    deleteSquadMemory,
    getSquadApiConfig,
    setSquadApiConfig,
    type SquadMemberInput,
} from '@/core/mapper/squad-mapper'
import {
    SQUAD_ROLE_PRESETS,
    SQUAD_TEMPLATES,
    applyRolePreset,
    resolveTemplateMember,
    type SquadRolePreset,
    type SquadTemplateJson,
} from '@/core/mapper/squad-templates'
import {listMcps, listMcpTools} from '@/core/mapper/mcp-mapper'
import type {McpInfo, McpToolDefinition} from '@/core/file/mcp-file'
import type {
    AgentInfo,
    SquadInfo,
    SquadMode,
    SquadExecutionMode,
    SquadSession,
    SquadMemory,
    SquadMemoryCategory,
    SquadApiConfig,
} from '@/types/core'
import {listen, type UnlistenFn} from '@tauri-apps/api/event'
import { useTauriEvent } from '@/hooks/useTauriEvent'
import {invoke} from '@tauri-apps/api/core'
import {saveTextFile} from '@/core/file/export-file'
import {open as openDialog} from '@tauri-apps/plugin-dialog'
import {
    ReactFlow,
    Background,
    Controls,
    Handle,
    Position,
    useNodesState,
    useEdgesState,
    type Node,
    type Edge,
    type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './index.scss'

const MODE_OPTIONS: { label: string; value: SquadMode; desc: string }[] = [
    {label: '编排式', value: 'orchestrator', desc: '主管拆解委派成员，逐子任务执行后汇总'},
    {label: '流水线', value: 'pipeline', desc: '成员线性串流，前步产出喂后步输入'},
    {label: '群聊', value: 'chat', desc: '共享黑板轮流发言，Moderator 收口'},
]

const EXEC_OPTIONS: { label: string; value: SquadExecutionMode }[] = [
    {label: '手动', value: 'manual'},
    {label: '定时', value: 'schedule'},
    {label: 'API', value: 'api'},
]

// 角色为固定枚举，按协作模式开放不同选项；流水线模式不提供角色选择（角色由工序固定）。
// S3 批次2（§4.2）：内置角色包五预设进入选项（一键套用人设+工具面见成员行「套用角色预设」）。
const SQUAD_ROLE_OPTIONS: Record<SquadMode, { label: string; value: string }[]> = {
    orchestrator: [
        {label: '执行 WORKER', value: 'WORKER'},
        {label: '调研 RESEARCHER', value: 'RESEARCHER'},
        {label: '评审 CRITIC', value: 'CRITIC'},
        {label: '整合 INTEGRATOR', value: 'INTEGRATOR'},
    ],
    pipeline: [{label: '执行 WORKER', value: 'WORKER'}],
    chat: [
        {label: '执行 WORKER', value: 'WORKER'},
        {label: '调研 RESEARCHER', value: 'RESEARCHER'},
        {label: '评审 CRITIC', value: 'CRITIC'},
        {label: '整合 INTEGRATOR', value: 'INTEGRATOR'},
        {label: '主持人 MODERATOR', value: 'MODERATOR'},
    ],
}

function genUniqueId(): string {
    const d = new Date()
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const rand = Math.random().toString(36).slice(2, 8)
    return `sqd-${ymd}-${rand}`
}

/** 成员 / 下拉选项中「名字 + Logo」的统一渲染（创建 Agent 时支持了 Logo）。 */
function AgentOptionNode({a}: { a: AgentInfo }) {
    return (
        <span className="squad-agent-opt">
      {a.logo ? (
          <img src={a.logo} alt="" className="squad-agent-opt__logo"/>
      ) : (
          <span className="squad-agent-opt__logo squad-agent-opt__logo--empty">
          <Users size={13}/>
        </span>
      )}
            <span className="squad-agent-opt__name">{a.name}</span>
      <span className="squad-agent-opt__id">（{a.identifier}）</span>
    </span>
    )
}

interface EditorState {
    id?: string
    name: string
    description: string
    logo: string
    uniqueId: string
    mode: SquadMode
    leaderAgentId: string
    globalMcpIds: string[]
    globalMcpTools: Record<string, string[]>
    supportsFileInput: boolean
    workspaceDir: string
    executionMode: SquadExecutionMode
    retryCount: number
    scheduleCron: string
    schedulePrompt: string
    maxRounds: number
    summarizerAgentId: string
    /** S3 批次2（§7.1 chat_then_execute）：群聊结论转执行（行动项自动转 Wave 续跑）。 */
    executeActions: boolean
    /** S2：协作 token 总预算（prompt+completion；0=不限），读写 run_strategy.budget_tokens。 */
    budgetTokens: number
    members: SquadMemberInput[]
}

function blankState(): EditorState {
    return {
        name: '',
        description: '',
        logo: '',
        uniqueId: genUniqueId(),
        mode: 'orchestrator',
        leaderAgentId: '',
        globalMcpIds: [],
        globalMcpTools: {},
        supportsFileInput: false,
        workspaceDir: '',
        executionMode: 'manual',
        retryCount: 3,
        scheduleCron: '',
        schedulePrompt: '',
        maxRounds: 8,
        summarizerAgentId: '',
        executeActions: false,
        budgetTokens: 0,
        members: [],
    }
}

function fromSquad(s: SquadInfo): EditorState {
    return {
        id: s.id,
        name: s.name,
        description: s.description ?? '',
        logo: s.logo ?? '',
        uniqueId: s.uniqueId ?? genUniqueId(),
        mode: s.mode,
        leaderAgentId: s.leaderAgentId ?? '',
        globalMcpIds: s.globalMcpIds ?? [],
        globalMcpTools: s.globalMcpTools ?? {},
        supportsFileInput: s.supportsFileInput ?? false,
        workspaceDir: s.workspaceDir ?? '',
        executionMode: s.runStrategy.executionMode,
        retryCount: s.runStrategy.retryCount,
        scheduleCron: s.runStrategy.scheduleCron ?? '',
        schedulePrompt: s.runStrategy.schedulePrompt ?? '',
        maxRounds: s.chatConfig.maxRounds,
        summarizerAgentId: s.chatConfig.summarizerAgentId ?? '',
        executeActions: s.chatConfig.executeActions ?? false,
        budgetTokens: s.runStrategy.budgetTokens ?? 0,
        members: s.members.map((m) => ({
            agentId: m.agentId,
            role: m.role,
            personaOverride: m.personaOverride ?? '',
            pipelineOrder: m.pipelineOrder ?? null,
            dependsOn: m.dependsOn ?? [],
            isLeader: m.isLeader,
            toolProfile: m.toolProfile,
        })),
    }
}

/** 官方模板（§12）→ 编辑器初始状态：成员 agentId 留空由用户挑选；pipelineOrder 保留（线性串流）。 */
function fromTemplate(t: SquadTemplateJson): EditorState {
    const s = blankState()
    return {
        ...s,
        name: t.name,
        description: t.description ?? '',
        mode: t.mode,
        executionMode: t.runStrategy?.executionMode ?? 'manual',
        retryCount: t.runStrategy?.retryCount ?? 3,
        schedulePrompt: t.runStrategy?.schedulePrompt ?? '',
        maxRounds: t.chatConfig?.maxRounds ?? 8,
        executeActions: t.chatConfig?.executeActions ?? false,
        members: t.members.map(resolveTemplateMember),
    }
}

/* ------------------------------------------------------------------ *
 * 编排画布（ReactFlow）：流水线模式独有。默认「输入节点」+ 成员节点（名字 + Logo）。
 * 成员间「连线」即依赖（dependsOn），决定执行先后；群聊 / 编排式不展示画布。
 * 未装 @xyflow/react 时由 shims.d.ts 兜底。
 * ------------------------------------------------------------------ */

/** §4.12.5：成员外观解析——有 appearance 用之；从未设计过则按场景+agentId 稳定生成兜底。 */
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

/** 卡片实时徽标文案（最新会话非终态才显示；终态无标记）。 */
const LIVE_LABELS: Record<string, string> = {
    running: '协作中',
    paused: '已暂停',
    awaiting_plan: '计划待批准',
    awaiting_checkpoint: '待检查点决议',
    awaiting_delivery: '待确认交付',
}
const INPUT_NODE_ID = '__squad_input__'

interface SquadNodeData {
    agentId: string
    agentName: string
    agentLogo?: string
    role: string
    isLeader: boolean
    appearance?: PixelAgentAppearance
}

function SquadInputNode({data}: { data: { supportsFile: boolean } }) {
    return (
        <div className="squad-dag__node squad-dag__node--input">
            <Handle type="source" position={Position.Right} id="out"/>
            <div className="squad-dag__node-ico">
                {data.supportsFile ? <FileUp size={18}/> : <Inbox size={18}/>}
            </div>
            <div className="squad-dag__node-title">输入节点</div>
            <div className="squad-dag__node-sub">{data.supportsFile ? '允许文件输入' : '文本指令'}</div>
        </div>
    )
}

function SquadFlowNode({data}: { data: SquadNodeData }) {
    return (
        <div className={`squad-dag__node squad-dag__node--member${data.isLeader ? ' is-leader' : ''}`}>
            <Handle type="target" position={Position.Left} id="in"/>
            <div className="squad-dag__node-avatar">
                {data.appearance ? <PixelAgent appearance={data.appearance} size={40} motion={false}/> : data.agentLogo ? <img src={data.agentLogo} alt=""/> : <Users size={16}/>}
            </div>
            <div className="squad-dag__node-body">
                <div className="squad-dag__node-name">{data.agentName}</div>
                {data.role ? <div className="squad-dag__node-role">{data.role}</div> : null}
            </div>
            {data.isLeader && <span className="squad-dag__node-badge">主管</span>}
            <Handle type="source" position={Position.Right} id="out"/>
        </div>
    )
}

function SquadDagEditor({
                            members,
                            agents,
                            supportsFileInput,
                            onChange,
                        }: {
    members: SquadMemberInput[]
    agents: AgentInfo[]
    supportsFileInput: boolean
    onChange: (m: SquadMemberInput[]) => void
}) {
    const nodeTypes = useMemo(
        () => ({inputNode: SquadInputNode, squadMember: SquadFlowNode}),
        [],
    )
    const posRef = useRef<Record<string, { x: number; y: number }>>({})

    const memberSig = members
        .map((m) => `${m.agentId}:${(m.dependsOn ?? []).join(',')}`)
        .join('|')

    const agentOf = (id: string) => agents.find((a) => a.id === id)

    const buildNodes = useCallback(
        (prev: Node[]): Node[] => {
            const input: Node = {
                id: INPUT_NODE_ID,
                type: 'inputNode',
                position: {x: 24, y: 150},
                data: {supportsFile: supportsFileInput},
                draggable: false,
                selectable: false,
            }
            const ms: Node[] = members.map((m, i) => {
                const a = agentOf(m.agentId)
                const existing = prev.find((p) => p.id === m.agentId)
                return {
                    id: m.agentId,
                    type: 'squadMember',
                    position: posRef.current[m.agentId] ?? existing?.position ?? {x: 360, y: 30 + i * 130},
                    data: {
                        agentId: m.agentId,
                        agentName: a?.name ?? m.agentId,
                        agentLogo: a?.logo,
                        appearance: a?.appearance,
                        role: m.role,
                        isLeader: m.isLeader,
                    },
                }
            })
            return [input, ...ms]
        },
        [members, agents, supportsFileInput],
    )

    const buildEdges = useCallback((): Edge[] => {
        const es: Edge[] = []
        members.forEach((m) => {
            const deps = m.dependsOn ?? []
            if (deps.length === 0) {
                es.push({
                    id: `e-in-${m.agentId}`,
                    source: INPUT_NODE_ID,
                    target: m.agentId,
                    type: 'smoothstep',
                })
            } else {
                deps.forEach((dep) => {
                    if (members.some((x) => x.agentId === dep)) {
                        es.push({
                            id: `e-${dep}-${m.agentId}`,
                            source: dep,
                            target: m.agentId,
                            type: 'smoothstep',
                        })
                    }
                })
            }
        })
        return es
    }, [members])

    const [nodes, setNodes, onNodesChangeRaw] = useNodesState<Node>(buildNodes([]))
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(buildEdges())

    const onNodesChange = useCallback(
        (changes: any) => {
            onNodesChangeRaw(changes)
            for (const ch of changes) {
                if (ch?.id && ch.id !== INPUT_NODE_ID && ch?.type === 'position' && ch?.position) {
                    posRef.current[ch.id] = ch.position
                }
            }
        },
        [onNodesChangeRaw],
    )

    // 外部 members 变化（增删成员 / 改依赖）时重建图，保留拖拽位置。
    useEffect(() => {
        setNodes((prev) => buildNodes(prev))
        setEdges(buildEdges())
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [memberSig, supportsFileInput])

    const onConnect = useCallback(
        (c: Connection) => {
            if (!c.source || !c.target || c.source === c.target) return
            if (c.source === INPUT_NODE_ID) return // 输入→成员为自动派生，不允许手动连
            setEdges((eds) => {
                if (eds.some((e) => e.source === c.source && e.target === c.target)) return eds
                return [
                    ...eds,
                    {
                        id: `e-${c.source}-${c.target}`,
                        source: c.source as string,
                        target: c.target as string,
                        type: 'smoothstep',
                    },
                ]
            })
            const next = members.map((m) =>
                m.agentId === c.target
                    ? {...m, dependsOn: Array.from(new Set([...(m.dependsOn ?? []), c.source as string]))}
                    : m,
            )
            onChange(next)
        },
        [members, onChange],
    )

    return (
        <div className="squad-dag">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                fitView
            >
                <Background/>
                <Controls/>
            </ReactFlow>
        </div>
    )
}

/** 小分队 API 触发服务配置弹窗。 */
function SquadApiConfigModal({open, onClose}: { open: boolean; onClose: () => void }) {
    const {message} = useNotify()
    const [cfg, setCfg] = useState<SquadApiConfig>({enabled: false, port: 3939, token: ''})
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        try {
            setCfg(await getSquadApiConfig())
        } catch (e) {
            message.error(`读取配置失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }, [message])

    useEffect(() => {
        if (open) void load()
    }, [open, load])

    async function save() {
        setSaving(true)
        try {
            const next = await setSquadApiConfig({enabled: cfg.enabled, port: cfg.port, token: cfg.token})
            setCfg(next)
            message.success('已保存 API 配置')
        } catch (e) {
            message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={onClose}
            title="小分队 API 服务配置"
            description="本地 HTTP 服务，允许外部系统触发小分队运行。需先启用。"
            width={640}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        取消
                    </Button>
                    <Button variant="solid" onClick={save} disabled={saving}>
                        {saving ? '保存中…' : '保存'}
                    </Button>
                </>
            }
        >
            <div className="squad-api">
                <div className="squad-api__row">
                    <span>启用服务</span>
                    <Switch checked={cfg.enabled} onChange={(v) => setCfg((c) => ({...c, enabled: v}))}/>
                </div>
                <Field className="squad-api__row">
                    <FieldLabel htmlFor="api-port">监听端口</FieldLabel>
                    <InputNumber min={1} max={65535} value={cfg.port}
                                 onChange={(v) => setCfg((c) => ({...c, port: v ?? 3939}))}/>
                </Field>
                <Field className="squad-api__row">
                    <FieldLabel htmlFor="api-token">访问令牌</FieldLabel>
                    <Input
                        id="api-token"
                        autoComplete="off"
                        placeholder="触发时须携带此令牌"
                        value={cfg.token}
                        onChange={(e) => setCfg((c) => ({...c, token: e.target.value}))}
                    />
                </Field>
                <p className="squad-api__hint">
                    说明：开关 / 令牌实时生效；端口变更需重启应用。触发示例：
                    <br/>
                    <code>POST http://127.0.0.1:{cfg.port}/api/squads/{'{squadId}'}/run</code>
                    {' + '}
                    <code>Authorization: Bearer {cfg.token || '<token>'}</code>
                </p>
            </div>
        </Modal>
    )
}

function SquadEditorModal({
                              open,
                              initial,
                              template,
                              agents,
                              onClose,
                              onSaved,
                          }: {
    open: boolean
    initial?: SquadInfo
    /** S3 批次2（§12）：从官方模板新建（成员 agentId 留空，由用户在编辑器内挑选）。 */
    template?: SquadTemplateJson
    agents: AgentInfo[]
    onClose: () => void
    onSaved: (list: SquadInfo[]) => void
}) {
    const {message} = useNotify()
    const [state, setState] = useState<EditorState>(blankState())
    const [saving, setSaving] = useState(false)
    const [apiOpen, setApiOpen] = useState(false)
    // 左侧导航当前面板（UI 改版：侧栏导航替代顶部 Tabs）
    const [pane, setPane] = useState<'basic' | 'resource' | 'members' | 'strategy'>('basic')
    // MCP 卡片折叠态（启用服务时自动展开）
    const [openMcpIds, setOpenMcpIds] = useState<Set<string>>(new Set())
    const [mcps, setMcps] = useState<McpInfo[]>([])
    const [mcpToolsMap, setMcpToolsMap] = useState<Record<string, McpToolDefinition[]>>({})
    // S2（§4.2）：成员工具面目录缓存（agentId → 原生/MCP 工具全名；能力层实时真相）
    const [toolCatalogs, setToolCatalogs] = useState<Record<string, {nativeTools: string[]; mcpTools: string[]}>>({})
    const logoInputRef = useRef<HTMLInputElement>(null)

    const ensureToolCatalog = useCallback(async (agentId: string) => {
        if (!agentId || toolCatalogs[agentId]) return
        try {
            const cat = await invoke<{nativeTools: string[]; mcpTools: string[]}>('list_squad_tool_catalog', {agentId})
            setToolCatalogs((c) => ({...c, [agentId]: cat}))
        } catch {
            /* 目录拉取失败不阻塞编辑（chips 显示为空可选） */
        }
    }, [toolCatalogs])

    useEffect(() => {
        if (open) {
            setState(initial ? fromSquad(initial) : template ? fromTemplate(template) : blankState())
            setPane('basic')
            setOpenMcpIds(new Set())
            void listMcps()
                .then(async (list) => {
                    setMcps(list)
                    try {
                        const map: Record<string, McpToolDefinition[]> = {}
                        await Promise.all(
                            list.map(async (m) => {
                                map[m.id] = await listMcpTools(m.id)
                            }),
                        )
                        setMcpToolsMap(map)
                    } catch {
                        setMcpToolsMap({})
                    }
                })
                .catch(() => setMcps([]))
        }
    }, [open, initial, template])

    // S2：编辑器打开时，为已配置工具面的成员拉取工具目录
    useEffect(() => {
        if (!open) return
        for (const m of state.members) {
            if (m.toolProfile && m.toolProfile.mode !== 'inherit' && m.agentId) {
                void ensureToolCatalog(m.agentId)
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])

    const allAgentOptions = useMemo(
        () => agents.map((a) => ({value: a.id, label: <AgentOptionNode a={a}/>})),
        [agents],
    )

    // id -> AgentInfo，用于 labelInValue 始终取到名字（即便该智能体已被占用/不在可选列表）
    const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

    // 已占用（被任一角色选走的）智能体 id 集合：成员 + 主管 + 主笔
    const usedAgentIds = useMemo(() => {
        const set = new Set<string>()
        state.members.forEach((m) => m.agentId && set.add(m.agentId))
        if (state.leaderAgentId) set.add(state.leaderAgentId)
        if (state.summarizerAgentId) set.add(state.summarizerAgentId)
        return set
    }, [state.members, state.leaderAgentId, state.summarizerAgentId])

    // labelInValue 取值：触发框显示名字（不带光标），下拉里已选中的会被剔除
    const agentValue = (id?: string) =>
        id ? {value: id, label: agentMap.get(id)?.name ?? id} : undefined

    const [addSel, setAddSel] = useState<string | undefined>(undefined)

    const setMembers = (members: SquadMemberInput[]) => setState((s) => ({...s, members}))

    const changeMode = (next: SquadMode) => {
        setState((s) => {
            const roleOpts = SQUAD_ROLE_OPTIONS[next].map((o) => o.value)
            const members = s.members.map((m) =>
                next === 'pipeline'
                    ? {...m, role: ''}
                    : {...m, role: roleOpts.includes(m.role) ? m.role : roleOpts[0] ?? ''},
            )
            return {
                ...s,
                mode: next,
                members,
                leaderAgentId: next === 'orchestrator' ? s.leaderAgentId : '',
                summarizerAgentId: next === 'chat' ? s.summarizerAgentId : '',
            }
        })
    }

    const onLogoPick = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            if (typeof reader.result === 'string') setState((s) => ({...s, logo: reader.result as string}))
        }
        reader.readAsDataURL(file)
        e.target.value = ''
    }

    const onPickWorkspace = async () => {
        try {
            const picked = await openDialog({directory: true, multiple: false})
            if (typeof picked === 'string') setState((s) => ({...s, workspaceDir: picked}))
        } catch {
            /* 非 Tauri 环境忽略 */
        }
    }

    const regenerateUid = () => setState((s) => ({...s, uniqueId: genUniqueId()}))

    const clearLogo = () => setState((s) => ({...s, logo: ''}))

    const clearWorkspace = () => setState((s) => ({...s, workspaceDir: ''}))

    const toggleMcp = (mcpId: string, on: boolean) => {
        if (on) setOpenMcpIds((s) => new Set(s).add(mcpId))
        setState((s) => {
            const ids = new Set(s.globalMcpIds)
            if (on) ids.add(mcpId)
            else ids.delete(mcpId)
            const tools = {...s.globalMcpTools}
            if (on) {
                if (!tools[mcpId]) tools[mcpId] = []
            } else {
                delete tools[mcpId]
            }
            return {...s, globalMcpIds: [...ids], globalMcpTools: tools}
        })
    }

    /** 工具批量启停（卡片内「全选 / 清空」）：on=true 全选，false 清空（全部禁用）。 */
    const toggleAllTools = (mcpId: string, on: boolean) =>
        setState((s) => ({
            ...s,
            globalMcpTools: {...s.globalMcpTools, [mcpId]: on ? [] : (mcpToolsMap[mcpId] ?? []).map((t) => t.id)},
        }))

    const toggleTool = (mcpId: string, toolId: string, on: boolean) =>
        setState((s) => {
            const cur = new Set(s.globalMcpTools[mcpId] ?? [])
            if (on) cur.delete(toolId)
            else cur.add(toolId)
            return {...s, globalMcpTools: {...s.globalMcpTools, [mcpId]: [...cur]}}
        })

    const addMember = (agentId?: string) => {
        const aid = agentId ?? agents[0]?.id
        if (!aid) {
            message.warning('请先创建至少一个智能体')
            return
        }
        if (
            state.members.some((m) => m.agentId === aid) ||
            aid === state.leaderAgentId ||
            aid === state.summarizerAgentId
        ) {
            message.warning('该智能体已被其他角色占用')
            return
        }
        const roleOpts = SQUAD_ROLE_OPTIONS[state.mode].map((o) => o.value)
        setMembers([
            ...state.members,
            {
                agentId: aid,
                role: state.mode === 'pipeline' ? '' : (roleOpts[0] ?? ''),
                personaOverride: '',
                pipelineOrder: null,
                dependsOn: [],
                isLeader: false,
            },
        ])
    }

    const removeMember = (idx: number) => {
        const removed = state.members[idx]
        const next = state.members.filter((_, i) => i !== idx)
        setState((s) => ({
            ...s,
            members: next,
            leaderAgentId: removed && removed.agentId === s.leaderAgentId ? '' : s.leaderAgentId,
            summarizerAgentId:
                removed && removed.agentId === s.summarizerAgentId ? '' : s.summarizerAgentId,
        }))
    }

    const patchMember = (idx: number, patch: Partial<SquadMemberInput>) => {
        const next = state.members.map((m, i) => (i === idx ? {...m, ...patch} : m))
        setMembers(next)
    }

    async function handleSave() {
        if (!state.name.trim()) {
            message.error('请填写小分队名称')
            return
        }
        if (state.members.length === 0) {
            message.error('请至少添加一个成员智能体')
            return
        }
        for (const m of state.members) {
            if (!m.agentId) {
                message.error('每个成员都需选择智能体')
                return
            }
            if (state.mode !== 'pipeline' && !m.role.trim()) {
                message.error('每个成员都需指定角色（执行 WORKER / 评审 CRITIC）')
                return
            }
        }
        setSaving(true)
        try {
            const leaderAgentId = state.mode === 'orchestrator' ? (state.leaderAgentId || null) : null
            const summarizerAgentId = state.mode === 'chat' ? (state.summarizerAgentId || null) : null
            const members = state.members.map((m) => ({
                ...m,
                // S3 批次2：编排式保留模板/编辑器的主管标记（leaderAgentId 未选时自动推导）。
                isLeader: state.mode === 'orchestrator' && m.isLeader,
                role: state.mode === 'pipeline' ? '' : m.role,
                // S3 批次2：保留模板/编辑器的工序序号（流水线无 dependsOn 时按 pipeline_order 线性串流）。
                pipelineOrder: m.pipelineOrder ?? null,
            }))
            const list = await upsertSquad({
                id: state.id,
                name: state.name.trim(),
                description: state.description.trim() || null,
                logo: state.logo.trim() || null,
                mode: state.mode,
                leaderAgentId,
                globalMcpIds: state.globalMcpIds,
                globalMcpTools: state.globalMcpTools,
                supportsFileInput: state.supportsFileInput,
                workspaceDir: state.workspaceDir.trim() || null,
                runStrategy: {
                    executionMode: state.executionMode,
                    retryCount: state.retryCount,
                    scheduleCron: state.scheduleCron.trim() || null,
                    schedulePrompt: state.schedulePrompt.trim() || null,
                    // S2：0=不限（后端 budget_tokens: u64，0 走「无预算闸门」分支）
                    budgetTokens: state.budgetTokens > 0 ? state.budgetTokens : 0,
                },
                members,
                chatConfig: {
                    maxRounds: state.maxRounds,
                    summarizerAgentId,
                    // S3 批次2（§7.1）：结论转执行仅 chat 模式有意义。
                    executeActions: state.mode === 'chat' && state.executeActions,
                },
            })
            onSaved(list)
            message.success(state.id ? '已更新小分队' : '已创建小分队')
            onClose()
        } catch (e) {
            message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setSaving(false)
        }
    }

    // S3 批次2（§12）：导出编队模板 JSON——成员 agentId 留空（可移植分享），其余配置全保真。
    async function handleExportTemplate() {
        const tpl: SquadTemplateJson = {
            templateId: `custom-${genUniqueId()}`,
            name: state.name.trim() || '未命名编队',
            description: state.description.trim() || undefined,
            mode: state.mode,
            chatConfig: {
                maxRounds: state.maxRounds,
                executeActions: state.mode === 'chat' ? state.executeActions : undefined,
            },
            runStrategy: {
                executionMode: state.executionMode,
                retryCount: state.retryCount,
                schedulePrompt: state.schedulePrompt.trim() || null,
            },
            members: state.members.map((m) => ({
                rolePreset: SQUAD_ROLE_PRESETS.some((p) => p.id === m.role)
                    ? (m.role as SquadRolePreset['id'])
                    : undefined,
                role: m.role || undefined,
                personaOverride: m.personaOverride || undefined,
                toolProfile: m.toolProfile,
                pipelineOrder: m.pipelineOrder ?? undefined,
                dependsOn: m.dependsOn?.length ? m.dependsOn : undefined,
                isLeader: m.isLeader || undefined,
            })),
        }
        try {
            const ok = await saveTextFile(
                `${tpl.name}-编队模板.json`,
                JSON.stringify(tpl, null, 2),
            )
            if (ok) message.success('编队模板已导出（成员留空，可直接分享导入）')
        } catch (e) {
            message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    return (
        <>
            <Modal
                open={open}
                onOpenChange={onClose}
                title={state.id ? '编辑小分队' : '新建小分队'}
                description="组合多个智能体，按不同协作模式协同完成复杂任务。"
                width={940}
                footer={
                    <div style={{display: 'flex', justifyContent: 'flex-end', gap: 12}}>
                        <Button variant="ghost" onClick={handleExportTemplate}>
                            导出 JSON
                        </Button>
                        <Button variant="ghost" onClick={onClose}>
                            取消
                        </Button>
                        <Button variant="solid" onClick={handleSave} disabled={saving}>
                            {saving ? '保存中…' : '保存配置'}
                        </Button>
                    </div>
                }
            >
                <div className="squad-editor">
                    {/* 左侧栏导航（UI 改版：分组导航替代顶部 Tabs） */}
                    <nav className="squad-editor__nav">
                        <div className="squad-editor__nav-sep">配置</div>
                        <button
                            type="button"
                            className={`squad-editor__nav-item${pane === 'basic' ? ' is-on' : ''}`}
                            onClick={() => setPane('basic')}
                        >
                            <Settings2 size={15}/> 基本配置
                        </button>
                        <button
                            type="button"
                            className={`squad-editor__nav-item${pane === 'resource' ? ' is-on' : ''}`}
                            onClick={() => setPane('resource')}
                        >
                            <Puzzle size={15}/> 资源挂载
                        </button>
                        <div className="squad-editor__nav-sep">编制</div>
                        <button
                            type="button"
                            className={`squad-editor__nav-item${pane === 'members' ? ' is-on' : ''}`}
                            onClick={() => setPane('members')}
                        >
                            <Users size={15}/> 成员编排
                            <small>{state.members.length}</small>
                        </button>
                        <div className="squad-editor__nav-sep">运行</div>
                        <button
                            type="button"
                            className={`squad-editor__nav-item${pane === 'strategy' ? ' is-on' : ''}`}
                            onClick={() => setPane('strategy')}
                        >
                            <SlidersHorizontal size={15}/> 运行策略
                        </button>
                    </nav>
                    <div className="squad-editor__body">
                        {/* ── 基本配置 ── */}
                        <div className="squad-editor__pane" hidden={pane !== 'basic'}>
                            <div className="squad-editor__basic">
                                        {/* 团队头像：点击头像上传（首行整行，对齐设计稿） */}
                                        <Field className="squad-editor__row squad-editor__span2">
                                            <FieldLabel>团队头像</FieldLabel>
                                            <div
                                                className="squad-editor__logo-pick"
                                                onClick={() => logoInputRef.current?.click()}
                                                role="button"
                                                tabIndex={0}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' || e.key === ' ') logoInputRef.current?.click()
                                                }}
                                            >
                                                <div className="squad-editor__logo-preview">
                                                    {state.logo ? (
                                                        <img src={state.logo} alt="头像预览"/>
                                                    ) : (
                                                        <ImagePlus size={20} className="squad-editor__logo-empty"/>
                                                    )}
                                                </div>
                                                {state.logo && (
                                                    <button
                                                        type="button"
                                                        className="squad-editor__logo-clear"
                                                        aria-label="移除头像"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            clearLogo()
                                                        }}
                                                    >
                                                        <X size={12}/>
                                                    </button>
                                                )}
                                                <span className="squad-editor__logo-tip">
                                                    {state.logo ? '点击更换头像' : '点击上传头像'}
                                                </span>
                                                <input ref={logoInputRef} type="file" accept="image/*" hidden
                                                       onChange={onLogoPick}/>
                                            </div>
                                        </Field>

                                        {/* 名称 */}
                                        <Field className="squad-editor__row">
                                            <FieldLabel htmlFor="squad-name">名称</FieldLabel>
                                            <Input
                                                id="squad-name"
                                                autoComplete="off"
                                                placeholder="例如：大A 投研小队"
                                                value={state.name}
                                                onChange={(e) => setState((s) => ({...s, name: e.target.value}))}
                                            />
                                        </Field>

                                        {/* 调用标识（唯一标识）：输入框内刷新图标，移除复制 */}
                                        <Field className="squad-editor__row">
                                            <FieldLabel htmlFor="squad-uid">
                                                调用标识
                                                <Tooltip
                                                    title="保存后该标识固定不变。外部系统（如 API 触发）可凭此标识直接引用并调度该小队，无需关心底层数据 ID。">
                                                    <Info size={14} style={{
                                                        marginLeft: 6,
                                                        cursor: 'help',
                                                        color: 'var(--color-foreground-muted)'
                                                    }}/>
                                                </Tooltip>
                                            </FieldLabel>
                                            <Input
                                                id="squad-uid"
                                                autoComplete="off"
                                                value={state.uniqueId}
                                                onChange={(e) => setState((s) => ({...s, uniqueId: e.target.value}))}
                                                suffix={
                                                    <Button
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        aria-label="重新生成调用标识"
                                                        title="重新生成"
                                                        onClick={regenerateUid}
                                                    >
                                                        <RefreshCw size={15}/>
                                                    </Button>
                                                }
                                            />
                                        </Field>

                                        {/* 工作区：目录选择（图标 + 输入组合），更名自「自定义物理工作区」 */}
                                        <Field className="squad-editor__row">
                                            <FieldLabel htmlFor="squad-workspace">工作区</FieldLabel>
                                            <Input
                                                id="squad-workspace"
                                                autoComplete="off"
                                                placeholder="未设置时回退默认隐藏目录：.wd_mem/squads/{squad_id}/"
                                                value={state.workspaceDir}
                                                onChange={(e) => setState((s) => ({
                                                    ...s,
                                                    workspaceDir: e.target.value
                                                }))}
                                                suffix={
                                                    <span className="squad-editor__ws-suffix">
                                                        {state.workspaceDir && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon-sm"
                                                                aria-label="清除工作区"
                                                                title="清除"
                                                                onClick={(e) => {
                                                                    e.stopPropagation()
                                                                    clearWorkspace()
                                                                }}
                                                            >
                                                                <X size={15}/>
                                                            </Button>
                                                        )}
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            aria-label="选择本地目录"
                                                            title="选择本地目录"
                                                            onClick={(e) => {
                                                                e.stopPropagation()
                                                                onPickWorkspace()
                                                            }}
                                                        >
                                                            <FolderOpen size={15}/>
                                                        </Button>
                                                    </span>
                                                }
                                            />
                                        </Field>

                                        {/* 支持文件输入 */}
                                        <Field className="squad-editor__row squad-editor__file-input">
                                            <div className="squad-editor__file-input-line">
                                                <Switch
                                                    checked={state.supportsFileInput}
                                                    onChange={(v) => setState((s) => ({...s, supportsFileInput: v}))}
                                                />
                                                <span>运行前允许人类上传文档/附件喂入上下文</span>
                                            </div>
                                        </Field>

                                        {/* 描述，跨整行 */}
                                        <Field className="squad-editor__row squad-editor__span2">
                                            <FieldLabel htmlFor="squad-desc">描述 (可选)</FieldLabel>
                                            <Input.TextArea
                                                id="squad-desc"
                                                autoComplete="off"
                                                rows={2}
                                                placeholder="一句话说明这个协作小组的用途..."
                                                value={state.description}
                                                onChange={(e) => setState((s) => ({...s, description: e.target.value}))}
                                            />
                                        </Field>
                                    </div>
                                </div>

                                {/* ── 资源挂载：全局 MCP（可折叠卡片，UI 改版自基本配置移入） ── */}
                                <div className="squad-editor__pane" hidden={pane !== 'resource'}>
                                    <Field className="squad-editor__row">
                                        <FieldLabel>全局 MCP 服务扩展</FieldLabel>
                                        <p className="squad-editor__hint">
                                            启用服务并展开卡片勾选工具子集；计数为「已启用 / 全部」工具数，未启用的服务不会注入任何成员。
                                        </p>
                                        {mcps.length === 0 ? (
                                            <p className="squad-editor__hint">暂无可用 MCP 服务，请先到「MCP 中心」添加。</p>
                                        ) : (
                                            <div className="squad-editor__mcp-cards">
                                                {mcps.map((mcp) => {
                                                    const enabled = state.globalMcpIds.includes(mcp.id)
                                                    const disabledTools = new Set(state.globalMcpTools[mcp.id] ?? [])
                                                    const tools = mcpToolsMap[mcp.id] ?? []
                                                    const enabledCount = enabled ? tools.length - disabledTools.size : 0
                                                    const isOpen = openMcpIds.has(mcp.id)
                                                    return (
                                                        <div className={`squad-editor__mcp-card${isOpen ? ' is-open' : ''}`} key={mcp.id}>
                                                            <div
                                                                className="squad-editor__mcp-card-head"
                                                                role="button"
                                                                tabIndex={0}
                                                                aria-expanded={isOpen}
                                                                onClick={() =>
                                                                    setOpenMcpIds((prev) => {
                                                                        const next = new Set(prev)
                                                                        if (next.has(mcp.id)) next.delete(mcp.id)
                                                                        else next.add(mcp.id)
                                                                        return next
                                                                    })
                                                                }
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                                        e.preventDefault()
                                                                        ;(e.currentTarget as HTMLElement).click()
                                                                    }
                                                                }}
                                                            >
                                                                <div className="squad-editor__mcp-card-title">
                                                                    <Server size={16} className="squad-editor__mcp-card-ico"/>
                                                                    <span className="squad-editor__mcp-card-label">
                                                                        {mcp.aliasName || mcp.mcpName}
                                                                    </span>
                                                                </div>
                                                                <span
                                                                    className={`squad-editor__mcp-card-count${
                                                                        enabled && tools.length > 0 && enabledCount === tools.length ? ' is-on' : ''
                                                                    }`}
                                                                >
                                                                    {enabledCount}/{tools.length}
                                                                </span>
                                                                <Switch
                                                                    checked={enabled}
                                                                    onClick={(_, e) => e.stopPropagation()}
                                                                    onChange={(v) => toggleMcp(mcp.id, v)}
                                                                />
                                                                <ChevronRight size={15} className="squad-editor__mcp-card-chev"/>
                                                            </div>
                                                            {isOpen && (
                                                                <div className="squad-editor__mcp-card-tools">
                                                                    {!enabled ? (
                                                                        <span className="squad-editor__mcp-card-hint">
                                                                            关闭后不会向成员注入该服务
                                                                        </span>
                                                                    ) : tools.length === 0 ? (
                                                                        <span className="squad-editor__mcp-card-hint">
                                                                            暂无工具，请先在 MCP 中心同步
                                                                        </span>
                                                                    ) : (
                                                                        <>
                                                                            <div className="squad-editor__mcp-card-toolbar">
                                                                                <button type="button" onClick={() => toggleAllTools(mcp.id, true)}>
                                                                                    全选
                                                                                </button>
                                                                                <button type="button" onClick={() => toggleAllTools(mcp.id, false)}>
                                                                                    清空
                                                                                </button>
                                                                            </div>
                                                                            {tools.map((tool) => (
                                                                                <label className="squad-editor__tool-row" key={tool.id}>
                                                                                    <span className="squad-editor__tool-name">
                                                                                        {tool.displayName || tool.toolCode}
                                                                                    </span>
                                                                                    <Switch
                                                                                        size="small"
                                                                                        checked={!disabledTools.has(tool.id)}
                                                                                        onChange={(v) => toggleTool(mcp.id, tool.id, v)}
                                                                                    />
                                                                                </label>
                                                                            ))}
                                                                        </>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </Field>
                                </div>

                                {/* ── 成员编排 ── */}
                                <div className="squad-editor__pane" hidden={pane !== 'members'}>
                                    {/* 协作模式（UI 改版：自基本配置移入成员编排顶部） */}
                                    <Field className="squad-editor__row">
                                        <FieldLabel>协作模式</FieldLabel>
                                        <Segmented
                                            className="squad-editor__mode"
                                            value={state.mode}
                                            onChange={(v) => changeMode(v as SquadMode)}
                                            options={MODE_OPTIONS.map((o) => ({label: o.label, value: o.value}))}
                                        />
                                    </Field>
                                    <div className="squad-editor__mode-note">
                                        <Info size={14} className="squad-editor__mode-note-ico"/>
                                        <span>
                                            已开启模式：<b>{MODE_OPTIONS.find(o => o.value === state.mode)?.label}</b>
                                            <span className="squad-editor__mode-note-sub">
                                                {MODE_OPTIONS.find(o => o.value === state.mode)?.desc}
                                            </span>
                                        </span>
                                    </div>

                                    <div className="squad-editor__roles-config">
                                        {state.mode === 'orchestrator' && (
                                            <Field className="squad-editor__row">
                                                <FieldLabel htmlFor="squad-leader">大脑节点：主管智能体
                                                    (Orchestrator)</FieldLabel>
                                                <Select
                                                    id="squad-leader"
                                                    className="squad-editor__leader"
                                                    allowClear
                                                    labelInValue
                                                    placeholder="选择主导者（独立于下方名单外，纯负责拆解任务规划）"
                                                    value={agentValue(state.leaderAgentId || undefined)}
                                                    options={allAgentOptions.filter((o) => !usedAgentIds.has(o.value))}
                                                    onChange={(v) => setState((s) => ({
                                                        ...s,
                                                        leaderAgentId: (v as { value: string } | undefined)?.value ?? ''
                                                    }))}
                                                />
                                            </Field>
                                        )}

                                        {state.mode === 'chat' && (
                                            <Field className="squad-editor__row">
                                                <FieldLabel htmlFor="squad-summarizer">仲裁收口：汇总主笔
                                                    (Moderator)</FieldLabel>
                                                <Select
                                                    id="squad-summarizer"
                                                    className="squad-editor__leader"
                                                    allowClear
                                                    labelInValue
                                                    placeholder="选择主笔（不参与群聊辩论，负责在轮次结束时提炼共识）"
                                                    value={agentValue(state.summarizerAgentId || undefined)}
                                                    options={allAgentOptions.filter((o) => !usedAgentIds.has(o.value))}
                                                    onChange={(v) => setState((s) => ({
                                                        ...s,
                                                        summarizerAgentId: (v as { value: string } | undefined)?.value ?? ''
                                                    }))}
                                                />
                                            </Field>
                                        )}
                                    </div>

                                    <div className="squad-editor__members">
                                        <div className="squad-editor__members-head">
                                            <span className="squad-editor__members-title">
                                                小分队成员编制
                                                <Tag color="blue" bordered={false}
                                                     style={{borderRadius: 999, marginInlineEnd: 0}}>{state.members.length}</Tag>
                                            </span>
                                        </div>

                                        {state.members.length === 0 && (
                                            <Empty
                                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                                description="编制暂为空，请在下方挑选本地智能体入列"
                                                className="squad-editor__members-empty"
                                            />
                                        )}

                                        <div className="squad-editor__members-list">
                                            {state.members.map((m, idx) => (
                                                <div className="squad-editor__member" key={m.agentId || `m-${idx}`}>
                                                    <div className="squad-editor__member-line">
                                                        {(() => {
                                                            return <PixelAgent appearance={agentAppearanceOf(agents, m.agentId)} size={48} motion={false} className="squad-editor__member-avatar"/>
                                                        })()}
                                                        <Select
                                                            className="squad-editor__member-agent"
                                                            allowClear
                                                            labelInValue
                                                            placeholder="选择具体智能体"
                                                            value={agentValue(m.agentId || undefined)}
                                                            options={allAgentOptions.filter((o) => !usedAgentIds.has(o.value))}
                                                            onChange={(v) => patchMember(idx, {
                                                                agentId: (v as { value: string } | undefined)?.value ?? ''
                                                            })}
                                                        />
                                                        {state.mode !== 'pipeline' && (
                                                            <Select
                                                                className="squad-editor__member-role"
                                                                placeholder="赋予角色职责"
                                                                value={m.role || undefined}
                                                                options={SQUAD_ROLE_OPTIONS[state.mode]}
                                                                onChange={(v) => patchMember(idx, {role: (v as string) ?? ''})}
                                                            />
                                                        )}
                                                        {/* S3 批次2（§4.2）：一键套用内置角色包——只落 toolProfile + persona 两维 */}
                                                        {state.mode !== 'pipeline' && (
                                                            <Select
                                                                className="squad-editor__member-preset"
                                                                placeholder="套用角色预设"
                                                                allowClear
                                                                value={undefined}
                                                                options={SQUAD_ROLE_PRESETS.map((p) => ({
                                                                    value: p.id,
                                                                    label: p.label,
                                                                }))}
                                                                onChange={(v) => {
                                                                    const preset = SQUAD_ROLE_PRESETS.find((p) => p.id === v)
                                                                    if (preset) patchMember(idx, applyRolePreset(preset))
                                                                }}
                                                            />
                                                        )}
                                                        {/* S2（§4.2）：工具面摘要 chips */}
                                                        {m.toolProfile && m.toolProfile.mode !== 'inherit' && (
                                                            <Tooltip title={(m.toolProfile.nativeTools ?? []).concat(m.toolProfile.mcpTools ?? []).join('\n')}>
                                                                <Tag color="purple" style={{marginInlineEnd: 0, cursor: 'default'}}>
                                                                    {m.toolProfile.mode === 'allowlist' ? '允许' : '禁用'}{' '}
                                                                    {(m.toolProfile.nativeTools?.length ?? 0) + (m.toolProfile.mcpTools?.length ?? 0)} 项
                                                                </Tag>
                                                            </Tooltip>
                                                        )}
                                                        <Button
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            aria-label="移除出列"
                                                            onClick={() => removeMember(idx)}
                                                        >
                                                            <Trash2 size={16} color="var(--color-danger)"/>
                                                        </Button>
                                                    </div>
                                                    <Input.TextArea
                                                        autoComplete="off"
                                                        rows={2}
                                                        placeholder="[高级] 定制该岗位的人设覆盖 Prompt（将强注入到其原生 System Prompt 末尾）"
                                                        value={m.personaOverride}
                                                        onChange={(e) => patchMember(idx, {personaOverride: e.target.value})}
                                                        className="squad-editor__member-prompt"
                                                    />
                                                    {/* S2（§4.2）：角色工具面——能力层裁剪（CRITIC 禁写这类约束由这里保证） */}
                                                    <div className="squad-editor__toolface">
                                                        <div className="squad-editor__toolface-head">
                                                            <span>工具面</span>
                                                            <Segmented
                                                                value={m.toolProfile?.mode ?? 'inherit'}
                                                                onChange={(v) => {
                                                                    const mode = v as 'inherit' | 'allowlist' | 'denylist'
                                                                    if (mode !== 'inherit' && m.agentId) void ensureToolCatalog(m.agentId)
                                                                    patchMember(idx, {
                                                                        toolProfile: mode === 'inherit'
                                                                            ? undefined
                                                                            : {
                                                                                mode,
                                                                                nativeTools: m.toolProfile?.nativeTools ?? [],
                                                                                mcpTools: m.toolProfile?.mcpTools ?? [],
                                                                            },
                                                                    })
                                                                }}
                                                                options={[
                                                                    {value: 'inherit', label: '继承'},
                                                                    {value: 'allowlist', label: '白名单'},
                                                                    {value: 'denylist', label: '黑名单'},
                                                                ]}
                                                            />
                                                        </div>
                                                        {m.toolProfile && m.toolProfile.mode !== 'inherit' && (
                                                            <div className="squad-editor__toolface-body">
                                                                <Select
                                                                    mode="multiple"
                                                                    allowClear
                                                                    placeholder="工具族（write=全部写路径含沙箱代码执行 / execute / network / destructive）"
                                                                    value={m.toolProfile.families}
                                                                    options={[
                                                                        {value: 'write', label: 'write 写族（含沙箱代码执行）'},
                                                                        {value: 'execute', label: 'execute 执行族'},
                                                                        {value: 'network', label: 'network 网络族'},
                                                                        {value: 'destructive', label: 'destructive 破坏族'},
                                                                    ]}
                                                                    onChange={(vs) => patchMember(idx, {
                                                                        toolProfile: {...m.toolProfile!, families: vs as string[]},
                                                                    })}
                                                                />
                                                                <Select
                                                                    mode="multiple"
                                                                    allowClear
                                                                    placeholder="原生工具（native__*）"
                                                                    value={m.toolProfile.nativeTools}
                                                                    options={(toolCatalogs[m.agentId]?.nativeTools ?? []).map((n) => ({value: n, label: n}))}
                                                                    onChange={(vs) => patchMember(idx, {
                                                                        toolProfile: {...m.toolProfile!, nativeTools: vs as string[]},
                                                                    })}
                                                                />
                                                                <Select
                                                                    mode="multiple"
                                                                    allowClear
                                                                    placeholder="MCP 工具（mcp__服务__工具）"
                                                                    value={m.toolProfile.mcpTools}
                                                                    options={(toolCatalogs[m.agentId]?.mcpTools ?? []).map((n) => ({value: n, label: n}))}
                                                                    onChange={(vs) => patchMember(idx, {
                                                                        toolProfile: {...m.toolProfile!, mcpTools: vs as string[]},
                                                                    })}
                                                                />
                                                                {(!toolCatalogs[m.agentId] || toolCatalogs[m.agentId].mcpTools.length === 0) && (
                                                                    <span className="squad-editor__toolface-hint">该智能体未挂载 MCP 工具或目录未就绪</span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* 添加成员：虚线行（选择即入列，即用即清） */}
                                        <div className="squad-editor__add-member">
                                            <Select
                                                className="squad-editor__add-select"
                                                labelInValue
                                                placeholder="➕ 挑选本地智能体入列..."
                                                value={agentValue(addSel)}
                                                options={allAgentOptions.filter((o) => !usedAgentIds.has(o.value))}
                                                onChange={(v) => {
                                                    addMember((v as { value: string } | undefined)?.value)
                                                    setAddSel(undefined)
                                                }}
                                            />
                                        </div>
                                    </div>

                                    {state.mode === 'pipeline' && (
                                        <div className="squad-editor__dag-section">
                                            <div className="squad-editor__dag-hint">
                                                <Info size={14} className="squad-editor__dag-hint-ico"/>
                                                <span>
                                                    连线规则：拖拽节点上的『句柄圆点』连接下游目标，流水线按依赖关系依次执行。
                                                </span>
                                            </div>
                                            <SquadDagEditor
                                                members={state.members}
                                                agents={agents}
                                                supportsFileInput={state.supportsFileInput}
                                                onChange={setMembers}
                                            />
                                        </div>
                                    )}
                                </div>

                                {/* ── 运行策略 ── */}
                                <div className="squad-editor__pane" hidden={pane !== 'strategy'}>
                                    <div className="squad-editor__basic">
                                        <Field className="squad-editor__row">
                                            <FieldLabel>工作流触发机制</FieldLabel>
                                            <Segmented
                                                value={state.executionMode}
                                                onChange={(v) => setState((s) => ({
                                                    ...s,
                                                    executionMode: v as SquadExecutionMode
                                                }))}
                                                options={EXEC_OPTIONS}
                                            />
                                        </Field>

                                        <Field className="squad-editor__row">
                                            <FieldLabel>引擎容错保护</FieldLabel>
                                            <div className="squad-editor__strategy-line">
                                                <span>单一任务节点硬熔断前允许重试：</span>
                                                <InputNumber
                                                    min={0}
                                                    max={10}
                                                    value={state.retryCount}
                                                    onChange={(v) => setState((s) => ({...s, retryCount: v ?? 3}))}
                                                />
                                                <span>次</span>
                                            </div>
                                        </Field>

                                        <Field className="squad-editor__row">
                                            <FieldLabel>
                                                Token 总预算
                                                <Tooltip title="整个协作过程（含编排侧与全部成员）的 token 消耗上限；达到 80% 告警一次，达到 100% 停止启动新任务并收尾保留产物。0 表示不限。">
                                                    <Info size={13} style={{marginLeft: 4, cursor: 'help'}}/>
                                                </Tooltip>
                                            </FieldLabel>
                                            <div className="squad-editor__strategy-line">
                                                <InputNumber
                                                    min={0}
                                                    step={1000}
                                                    value={state.budgetTokens}
                                                    onChange={(v) => setState((s) => ({...s, budgetTokens: v ?? 0}))}
                                                />
                                                <span>{state.budgetTokens > 0 ? 'tokens（80% 告警 / 100% 软熔断）' : '（0 = 不限制）'}</span>
                                            </div>
                                        </Field>

                                        {state.mode === 'chat' && (
                                            <Field className="squad-editor__row">
                                                <FieldLabel>Token 防洪堤</FieldLabel>
                                                <div className="squad-editor__strategy-line">
                                                    <span>阻止滚雪球无限争论，最高允许发言：</span>
                                                    <InputNumber
                                                        min={1}
                                                        max={30}
                                                        value={state.maxRounds}
                                                        onChange={(v) => setState((s) => ({...s, maxRounds: v ?? 8}))}
                                                    />
                                                    <span>轮次</span>
                                                </div>
                                            </Field>
                                        )}

                                        {/* S3 批次2（§7.1）：chat_then_execute——讨论收口后行动项自动转 Wave 执行 */}
                                        {state.mode === 'chat' && (
                                            <Field className="squad-editor__row">
                                                <FieldLabel>
                                                    结论转执行
                                                    <Tooltip title="chat_then_execute：群聊汇总产出行动项（【squad-actions】）后，自动把行动项转为委派任务续跑编排式 Wave（复用波次循环，上游上下文=讨论结论），执行完毕重建交付包并走交付确认。">
                                                        <Info size={13} style={{marginLeft: 4, cursor: 'help'}}/>
                                                    </Tooltip>
                                                </FieldLabel>
                                                <div className="squad-editor__strategy-line">
                                                    <Switch
                                                        checked={state.executeActions}
                                                        onChange={(v) => setState((s) => ({...s, executeActions: !!v}))}
                                                    />
                                                    <span>{state.executeActions ? '行动项自动转入 Wave 执行' : '仅讨论收口，不执行行动项'}</span>
                                                </div>
                                            </Field>
                                        )}

                                        {state.executionMode === 'schedule' && (
                                            <div className="squad-editor__cron-box squad-editor__span2">
                                                <Field className="squad-editor__row">
                                                    <FieldLabel htmlFor="squad-cron">Cron 时间戳表达式</FieldLabel>
                                                    <Input
                                                        id="squad-cron"
                                                        autoComplete="off"
                                                        placeholder="例如：0 */2 * * * （每两小时触发）"
                                                        value={state.scheduleCron}
                                                        onChange={(e) => setState((s) => ({
                                                            ...s,
                                                            scheduleCron: e.target.value
                                                        }))}
                                                    />
                                                    <p className="squad-editor__hint">遵循分、时、日、月、星期规则。当守护进程挂载时，按此频率在后台自启运行。</p>
                                                </Field>
                                                <Field className="squad-editor__row squad-editor__row--mt12">
                                                    <FieldLabel htmlFor="squad-sprompt">自动触发伴随指令</FieldLabel>
                                                    <Input.TextArea
                                                        id="squad-sprompt"
                                                        autoComplete="off"
                                                        rows={3}
                                                        placeholder="定时激活时，向大脑/小分队灌入的初始指令集（如：'拉取今天最新的行情数据并生成报告'）..."
                                                        value={state.schedulePrompt}
                                                        onChange={(e) => setState((s) => ({
                                                            ...s,
                                                            schedulePrompt: e.target.value
                                                        }))}
                                                    />
                                                </Field>
                                            </div>
                                        )}

                                        {state.executionMode === 'api' && (
                                            <div className="squad-editor__api-box squad-editor__span2">
                                                <Alert
                                                    message="Webhooks & API Call"
                                                    description={
                                                        <div style={{marginTop: 8}}>
                                                            <p style={{
                                                                margin: '0 0 8px 0',
                                                                fontSize: 13,
                                                                color: 'var(--color-foreground-muted)'
                                                            }}>
                                                                你可以将此小分队的调用嵌入到 Jenkins CI/CD 或外部爬虫的
                                                                Python 脚本中：
                                                            </p>
                                                            <pre
                                                                className="squad-editor__curl">{`POST http://127.0.0.1:3939/api/squads/${state.uniqueId || '<唯一标识>'}/run\nAuthorization: Bearer <Your_Global_Token>`}</pre>
                                                        </div>
                                                    }
                                                    type="success"
                                                />
                                                <Button variant="soft" onClick={() => setApiOpen(true)}
                                                        style={{marginTop: 16}}>
                                                    <Settings2 size={14}/> 调起全局 API 服务器网关设置
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                    </div>
                </div>
            </Modal>

            <SquadApiConfigModal open={apiOpen} onClose={() => setApiOpen(false)}/>
        </>
    )
}

interface SquadRoundView {
    role: string
    kind: string
    content: string
    speakerAgentId?: string | null
}

export function SquadRunConsole({
                            open,
                            squad,
                               agents,
                            onClose,
                            embedded = false,
                        }: {
    open: boolean
    agents: AgentInfo[]
    squad: SquadInfo
    onClose: () => void
    embedded?: boolean
}) {
    const {message} = useNotify()
    const [prompt, setPrompt] = useState('')
    const [running, setRunning] = useState(false)
    const [rounds, setRounds] = useState<SquadRoundView[]>([])
    const [summary, setSummary] = useState('')
    const [memberMotion, setMemberMotion] = useState<Record<string, AgentMotionState>>({})
    const [planPending, setPlanPending] = useState(false)
    const [checkpointPending, setCheckpointPending] = useState(false)
    const [deliveryPending, setDeliveryPending] = useState(false)
    // S2：插话输入（打断 / 预嘱）
    const [injectTarget, setInjectTarget] = useState('')
    const [injectMode, setInjectMode] = useState<'soft' | 'hard' | 'pre_talk'>('soft')
    const [injectText, setInjectText] = useState('')
    const [injectBusy, setInjectBusy] = useState(false)
    const sessionIdRef = useRef<string | null>(null)
    const unlistenRef = useRef<UnlistenFn[]>([])

    const cleanup = useCallback(() => {
        for (const off of unlistenRef.current) off()
        unlistenRef.current = []
    }, [])

    useEffect(() => {
        if (!open) {
            cleanup()
            setRounds([])
            setSummary('')
            setRunning(false)
            setMemberMotion({})
            setPlanPending(false)
            setCheckpointPending(false)
            setDeliveryPending(false)
            setInjectTarget('')
            setInjectText('')
            sessionIdRef.current = null
        }
    }, [open, cleanup])

    useEffect(() => () => cleanup(), [cleanup])

    async function handleRun() {
        const p = prompt.trim()
        if (!p) {
            message.error('请描述协作任务')
            return
        }
        setRounds([])
        setSummary('')
        setRunning(true)
        sessionIdRef.current = null
        try {
            const offStart = await listen<{ squadId: string; sessionId: string; mode: string }>(
                'agent-squad-session-started',
                (e) => {
                    if (e.payload.squadId === squad.id) sessionIdRef.current = e.payload.sessionId
                },
            )
            const offRound = await listen<{
                squadId: string
                sessionId: string
                speakerAgentId: string | null
                role: string
                kind: string
                content: string
            }>('agent-squad-round', (e) => {
                const pl = e.payload
                if (pl.squadId !== squad.id) return
                if (sessionIdRef.current && pl.sessionId !== sessionIdRef.current) return
                if (pl.kind === 'plan') setPlanPending(true)
                if (pl.kind === 'checkpoint') setCheckpointPending(true)
                if (pl.kind === 'delivery') setDeliveryPending(true)
                setRounds((r) => [...r, {
                    role: pl.role,
                    kind: pl.kind,
                    content: pl.content,
                    speakerAgentId: pl.speakerAgentId
                }])
            })
            const offDone = await listen<{ squadId: string; sessionId: string; summary: string }>(
                'agent-squad-session-done',
                (e) => {
                    if (e.payload.squadId !== squad.id) return
                    setSummary(e.payload.summary)
                    setRunning(false)
                    cleanup()
                },
            )
            const offMember = await listen<{ squadId: string; memberRole: string; phase: string; ok: boolean }>('squad-member-event', (e) => {
                if (e.payload.squadId !== squad.id) return
                const role = e.payload.memberRole
                const state: AgentMotionState = e.payload.phase === 'started' ? 'working' : e.payload.ok ? 'cheer' : 'error'
                setMemberMotion((m) => ({...m, [role]: state}))
                if (e.payload.phase !== 'started') setTimeout(() => setMemberMotion((m) => ({...m, [role]: 'idle'})), 3000)
            })
            unlistenRef.current = [offStart, offRound, offDone, offMember]
            await invoke('run_squad_task', { input: { squad_id: squad.id, prompt: p } })
        } catch (e) {
            message.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
            setRunning(false)
            cleanup()
        }
    }

    async function handleInject() {
        const text = injectText.trim()
        if (!text) {
            message.error('请输入要补充的内容')
            return
        }
        if (!injectTarget) {
            message.error('请选择插话目标（成员）')
            return
        }
        if (!sessionIdRef.current) {
            message.error('协作尚未开始，无法插话')
            return
        }
        const targetMember = squad.members.find((m) => m.agentId === injectTarget)
        setInjectBusy(true)
        try {
            await invoke<string>('squad_inject_send', {
                squadId: squad.id,
                sessionId: sessionIdRef.current,
                taskId: injectTarget,
                content: text,
                mode: injectMode,
            })
            const modeLabel = injectMode === 'pre_talk' ? '预嘱已入队，将在其任务启动时生效' : '已打断，将在该成员下一轮生效'
            message.success(`已送达 ${targetMember?.role || injectTarget}：${modeLabel}`)
            setInjectText('')
        } catch (e) {
            message.error(`插话失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setInjectBusy(false)
        }
    }

    const panelContent = (
        <>
            <div className="squad-console">
                <div className="squad-console__input">
                    <Input.TextArea
                        autoComplete="off"
                        rows={3}
                        placeholder="描述这次要协作完成的任务…"
                        value={prompt}
                        disabled={running}
                        onChange={(e) => setPrompt(e.target.value)}
                    />
                    <Button variant="solid" onClick={handleRun} disabled={running}>
                        <Play size={14}/> {running ? '协作进行中…' : '运行协作'}
                    </Button>
                </div>

                <div className="squad-console__board">
                    {rounds.length === 0 && !running && !summary && (
                        <div className="squad-console__empty">运行后将在此显示成员讨论 / 子任务交付与最终汇总</div>
                    )}
                    <Spin spinning={running && rounds.length === 0}>
                        {rounds.map((r, i) => {
                            const meta = roundTagMeta(r.kind)
                            return (
                                <div className={`squad-round squad-round--${r.kind}`} key={i}>
                                    <div className="squad-round__head">
                                        {(() => {
                                            const member = squad.members.find((m) => m.role === r.role)
                                            if (!member) return null
                                            const st: AgentMotionState = r.kind === 'handoff' ? 'handoff' : memberMotion[member.role] ?? 'idle'
                                            return <PixelAgent appearance={agentAppearanceOf(agents, member.agentId)} state={st} size={24} className="squad-round__avatar"/>
                                        })()}
                                        <Tag color={meta.color}>{meta.label}</Tag>
                                        <span className="squad-round__role">{r.role}</span>
                                    </div>
                                    {r.kind === 'metrics' ? (
                                        <MetricsRoundView content={r.content}/>
                                    ) : (
                                        <div className="squad-round__content">{r.content}</div>
                                    )}
                                </div>
                            )
                        })}
                    {planPending && (
                        <div className="squad-round squad-round--system" style={{border: '1px solid var(--color-warning, #faad14)'}}>
                            <div className="squad-round__head"><Tag color="orange">L1 计划门禁</Tag></div>
                            <div className="squad-round__content">委派计划已生成，等待你的批准。</div>
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" onClick={() => {
                                    setPlanPending(false)
                                    void invoke<{ok: boolean}>('squad_plan_approve', { sessionId: sessionIdRef.current, approved: true })
                                }}>
                                    批准执行
                                </Button>
                                <Button variant="ghost" onClick={() => {
                                    setPlanPending(false)
                                    void invoke('squad_plan_approve', { sessionId: sessionIdRef.current, approved: false })
                                }}>
                                    拒绝
                                </Button>
                            </div>
                        </div>
                    )}
                    {checkpointPending && (
                        <div className="squad-round squad-round--system" style={{border: '1px solid var(--color-warning, #faad14)'}}>
                            <div className="squad-round__head"><Tag color="orange">L2 检查点</Tag></div>
                            <div className="squad-round__content">本波任务已完成，等待你的决议。返工将重跑本波全部任务（其上游交接保留）。</div>
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" onClick={() => {
                                    setCheckpointPending(false)
                                    void invoke<{ok: boolean}>('squad_checkpoint_resolve', { sessionId: sessionIdRef.current, decision: 'continue' })
                                }}>
                                    继续
                                </Button>
                                <Button variant="ghost" onClick={() => {
                                    setCheckpointPending(false)
                                    void invoke('squad_checkpoint_resolve', { sessionId: sessionIdRef.current, decision: 'rework' })
                                }}>
                                    返工本波
                                </Button>
                            </div>
                        </div>
                    )}
                    {deliveryPending && (
                        <div className="squad-round squad-round--system" style={{border: '1px solid var(--color-primary, #1677ff)'}}>
                            <div className="squad-round__head"><Tag color="gold">L4 交付确认</Tag></div>
                            <div className="squad-round__content">Delivery Pack 已生成（含成员执行证据与成本账目）。确认后协作收尾；要求修订将按取消收尾（产物保留在交接箱）。</div>
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" onClick={() => {
                                    setDeliveryPending(false)
                                    void invoke<{ok: boolean}>('squad_delivery_resolve', { sessionId: sessionIdRef.current, approved: true })
                                }}>
                                    确认交付
                                </Button>
                                <Button variant="ghost" onClick={() => {
                                    setDeliveryPending(false)
                                    void invoke('squad_delivery_resolve', { sessionId: sessionIdRef.current, approved: false })
                                }}>
                                    要求修订
                                </Button>
                            </div>
                        </div>
                    )}
                    </Spin>
                    {summary && (
                        <div className="squad-round squad-round--summary squad-round--final">
                            <div className="squad-round__head">
                                <Tag color="gold">最终汇总</Tag>
                            </div>
                            <div className="squad-round__content">{summary}</div>
                        </div>
                    )}
                </div>

                {/* S2（§4.11）：插话输入——运行中打断 / 未启动预嘱；目标为小分队成员 */}
                <div className="squad-console__inject">
                    <Select
                        style={{minWidth: 150}}
                        placeholder="插话目标"
                        value={injectTarget || undefined}
                        onChange={(v) => setInjectTarget(v)}
                        options={squad.members.map((m) => ({value: m.agentId, label: m.role || m.agentId}))}
                    />
                    <Segmented
                        value={injectMode}
                        onChange={(v) => setInjectMode(v as 'soft' | 'hard' | 'pre_talk')}
                        options={[
                            {value: 'soft', label: '打断'},
                            {value: 'hard', label: '强打断'},
                            {value: 'pre_talk', label: '预嘱'},
                        ]}
                    />
                    <Input
                        autoComplete="off"
                        placeholder={injectMode === 'pre_talk' ? '任务启动前要交代的要求…' : '运行中要补充 / 纠偏的话…'}
                        value={injectText}
                        maxLength={2000}
                        onChange={(e) => setInjectText(e.target.value)}
                        onPressEnter={() => void handleInject()}
                    />
                    <Button variant="soft" onClick={() => void handleInject()} disabled={injectBusy || !running}>
                        送达
                    </Button>
                </div>
            </div>
        </>
    )

    if (embedded) {
        return <div className="squad-page-panel">{panelContent}</div>
    }

    return (
        <Modal
            open={open}
            onOpenChange={onClose}
            title={`运行 · ${squad.name}`}
            description={`协作模式：${MODE_OPTIONS.find((o) => o.value === squad.mode)?.label ?? squad.mode}`}
            width={760}
            footer={
                <Button variant="ghost" onClick={onClose}>
                    关闭
                </Button>
            }
        >
            {panelContent}
        </Modal>
    )
}

const CAT_OPTIONS: { label: string; value: SquadMemoryCategory }[] = [
    {label: '通用', value: 'general'},
    {label: '决策', value: 'decision'},
    {label: '代码范式', value: 'code_pattern'},
    {label: '用户偏好', value: 'user_pref'},
    {label: '架构', value: 'architecture'},
    {label: '修复', value: 'fix'},
    {label: '其他', value: 'other'},
]

export interface BoardRound {
    role: string
    kind: string
    content: string
    speakerAgentId?: string | null
    /** 运行中由事件实时推来的新轮（区别于历史回放）——前端据此做打字机流式。 */
    fresh?: boolean
}

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

/** S2：metrics round 的 content（后端 SquadMetricsAcc JSON，snake_case 字段）。 */
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

/** S2：花费账目渲染——总用量 + 预算水位 + 成员级明细（解析失败降级纯文本）。 */
function MetricsRoundView({content}: { content: string }) {
    let acc: SquadMetricsAccView | null = null
    try {
        acc = JSON.parse(content) as SquadMetricsAccView
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

/** 复用的讨论黑板渲染（运行控制台实时流 / 历史回显共用）。 */
/** S1：黑板 L2 状态板视图（board_json 解析后的展示形态）。 */
export interface SquadBoardView {
    tasks: Array<{taskId: string; title: string; assignee: string; status: string}>
    artifactsIndex?: string[]
    decisions?: Array<{kind: string; text: string}>
    /** S3（§4.9）Chat 2.0：行动项（汇总主笔产出，可转 Wave 执行）。 */
    actions?: Array<{title: string; assignee?: string; detail?: string}>
}

/** 决策卡 kind → 中文标签/颜色（S3 增补 disagreement/action）。 */
const DECISION_KIND_META: Record<string, {label: string; color: string}> = {
    plan: {label: '计划', color: 'purple'},
    risk: {label: '风险', color: 'orange'},
    scope: {label: '范围', color: 'purple'},
    disagreement: {label: '分歧', color: 'red'},
    action: {label: '行动项', color: 'volcano'},
}

/** 任务状态 → Tag 颜色。 */
const BOARD_STATUS_META: Record<string, {color: string; label: string}> = {
    pending: {color: 'default', label: '待执行'},
    running: {color: 'processing', label: '进行中'},
    done: {color: 'success', label: '已完成'},
    failed: {color: 'error', label: '受阻'},
    skipped: {color: 'warning', label: '已跳过'},
}

export function RoundBoard({rounds, summary, board}: { rounds: BoardRound[]; summary?: string; board?: SquadBoardView | null }) {
    // board_json.tasks 实际是对象（键=t1/t2…，serde BTreeMap）；类型声明为数组——这里统一规范化，防 .map 崩溃
    const rawTasks = (board?.tasks ?? []) as unknown
    const taskList: Array<{taskId: string; title: string; assignee: string; status: string}> = Array.isArray(rawTasks)
        ? (rawTasks as Array<{taskId: string; title: string; assignee: string; status: string}>)
        : rawTasks && typeof rawTasks === 'object'
            ? Object.entries(rawTasks as Record<string, {title: string; assignee: string; status: string}>).map(([taskId, t]) => ({taskId, title: t.title, assignee: t.assignee, status: t.status}))
            : []
    return (
        <div className="squad-console__board">
            {board && (taskList.length > 0 || (board.decisions && board.decisions.length > 0) || (board.actions && board.actions.length > 0)) && (
                <div className="squad-round squad-round--board">
                    <div className="squad-round__head">
                        <Tag color="geekblue">任务状态板</Tag>
                    </div>
                    <div className="squad-round__content">
                        {taskList.map((t) => {
                            const meta = BOARD_STATUS_META[t.status] ?? {color: 'default', label: t.status}
                            return (
                                <div key={t.taskId} style={{display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0'}}>
                                    <Tag color={meta.color} style={{marginInlineEnd: 0}}>{meta.label}</Tag>
                                    <span>{t.title}</span>
                                    <span style={{color: 'var(--color-text-tertiary, #999)'}}>· {t.assignee}</span>
                                </div>
                            )
                        })}
                        {board.decisions && board.decisions.length > 0 && (
                            <div style={{marginTop: 6, borderTop: '1px dashed var(--color-border, #eee)', paddingTop: 6}}>
                                {board.decisions.map((d, i) => {
                                    const dm = DECISION_KIND_META[d.kind] ?? {label: d.kind, color: 'purple'}
                                    return (
                                        <div key={i} style={{display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0'}}>
                                            <Tag color={dm.color} style={{marginInlineEnd: 0}}>{dm.label}</Tag>
                                            <span>{d.text}</span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                        {/* S3（§4.9）Chat 2.0：行动项 */}
                        {board.actions && board.actions.length > 0 && (
                            <div style={{marginTop: 6, borderTop: '1px dashed var(--color-border, #eee)', paddingTop: 6}}>
                                <div style={{fontSize: 12, color: 'var(--color-text-tertiary, #999)', marginBottom: 2}}>行动项（可转 Wave 执行）</div>
                                {board.actions.map((a, i) => (
                                    <div key={i} style={{display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0'}}>
                                        <Tag color="volcano" style={{marginInlineEnd: 0}}>{i + 1}</Tag>
                                        <span>{a.title}</span>
                                        {a.assignee && <span style={{color: 'var(--color-text-tertiary, #999)'}}>→ {a.assignee}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
            {rounds.length === 0 && !summary && (
                <div className="squad-console__empty">暂无内容</div>
            )}
            {rounds.map((r, i) => {
                const meta = roundTagMeta(r.kind)
                return (
                    <div className={`squad-round squad-round--${r.kind}`} key={i}>
                        <div className="squad-round__head">
                            <Tag color={meta.color}>{meta.label}</Tag>
                            <span className="squad-round__role">{r.role}</span>
                        </div>
                        {r.kind === 'metrics' ? (
                            <MetricsRoundView content={r.content}/>
                        ) : (
                            <div className="squad-round__content">{r.content}</div>
                        )}
                    </div>
                )
            })}
            {summary && (
                <div className="squad-round squad-round--summary squad-round--final">
                    <div className="squad-round__head">
                        <Tag color="gold">最终汇总</Tag>
                    </div>
                    <div className="squad-round__content">{summary}</div>
                </div>
            )}
        </div>
    )
}

/** 团队记忆面板：列出 / 新增 / 删除小分队的黑板记忆（共享 + 成员个人）。 */
export function SquadMemoryPanel({
                              open,
                              squad,
                              onClose,
                              embedded = false,
                          }: {
    open: boolean
    squad: SquadInfo
    onClose: () => void
    embedded?: boolean
}) {
    const {message} = useNotify()
    const [memories, setMemories] = useState<SquadMemory[]>([])
    const [key, setKey] = useState('')
    const [content, setContent] = useState('')
    const [category, setCategory] = useState<SquadMemoryCategory>('general')
    const [scope, setScope] = useState<'team' | 'member'>('team')
    const [agentId, setAgentId] = useState<string>('')
    const [saving, setSaving] = useState(false)
    const reload = useCallback(async () => {
        try {
            setMemories(await listSquadMemories(squad.id))
        } catch (e) {
            message.error(`读取记忆失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }, [squad.id, message])

    // 弹窗打开期间订阅锚定事件实时刷新（台账 S12 ③：统一走 useTauriEvent 的 enabled；
    // 原手写版存在「关闭后在途注册 resolve 才挂回」的泄漏，hook 的 cancelled 语义已修）
    useTauriEvent<{ item: SquadMemory }>('agent-squad-memory-anchored', (payload) => {
        if (payload.item.squadId === squad.id) void reload()
    }, open)
    useEffect(() => {
        if (open) void reload()
    }, [open, reload])

    async function handleAdd() {
        if (!key.trim() || !content.trim()) {
            message.error('请填写键名与内容')
            return
        }
        setSaving(true)
        try {
            await anchorSquadMemory({
                squadId: squad.id,
                agentId: scope === 'member' && agentId ? agentId : null,
                key: key.trim(),
                content: content.trim(),
                category,
            })
            message.success('已锚定记忆')
            setKey('')
            setContent('')
            await reload()
        } catch (e) {
            message.error(`锚定失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setSaving(false)
        }
    }

    async function handleDelete(m: SquadMemory) {
        try {
            setMemories(await deleteSquadMemory(m.id, squad.id))
            message.success('已删除记忆')
        } catch (e) {
            message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    const panelContent = (
        <>
            <div className="squad-mem">
                <div className="squad-mem__add">
                    <Field>
                        <FieldLabel htmlFor="mem-key">键名</FieldLabel>
                        <Input
                            id="mem-key"
                            autoComplete="off"
                            placeholder="如：统一返回结构 / 数据库命名规范"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                        />
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="mem-content">内容</FieldLabel>
                        <Input.TextArea
                            id="mem-content"
                            autoComplete="off"
                            rows={2}
                            placeholder="记忆内容…"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                        />
                    </Field>
                    <div className="squad-mem__add-row">
                        <Select
                            className="squad-mem__cat"
                            placeholder="分类"
                            value={category}
                            options={CAT_OPTIONS.map((o) => ({label: o.label, value: o.value}))}
                            onChange={(v) => setCategory(v as SquadMemoryCategory)}
                        />
                        <Segmented
                            value={scope}
                            onChange={(v) => setScope(v as 'team' | 'member')}
                            options={[
                                {label: '团队共享', value: 'team'},
                                {label: '成员个人', value: 'member'},
                            ]}
                        />
                        {scope === 'member' && (
                            <Select
                                className="squad-mem__agent"
                                placeholder="选择成员"
                                value={agentId || undefined}
                                options={squad.members.map((m) => ({
                                    label: `${m.role || '成员'}（${m.agentId}）`,
                                    value: m.agentId,
                                }))}
                                onChange={(v) => setAgentId(v as string)}
                            />
                        )}
                        <Button variant="solid" onClick={handleAdd} disabled={saving}>
                            {saving ? '保存中…' : '锚定'}
                        </Button>
                    </div>
                </div>

                <div className="squad-mem__list">
                    {memories.length === 0 && (
                        <div className="squad-console__empty">暂无记忆，添加后运行小分队即可被召回。</div>
                    )}
                    {memories.map((m) => (
                        <div className="squad-mem__item" key={m.id}>
                            <div className="squad-mem__item-head">
                                <Tag color={m.agentId ? 'cyan' : 'purple'}>{m.agentId ? '成员' : '团队'}</Tag>
                                <span className="squad-mem__key">{m.key}</span>
                                <Tag>{m.category}</Tag>
                                <span className="squad-mem__ref">引用 {m.refCount}</span>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="squad-mem__del"
                                    aria-label="删除"
                                    onClick={() => handleDelete(m)}
                                >
                                    <Trash2 size={14}/>
                                </Button>
                            </div>
                            <div className="squad-mem__content">{m.content}</div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    )

    if (embedded) {
        return <div className="squad-page-panel">{panelContent}</div>
    }

    return (
        <Modal
            open={open}
            onOpenChange={onClose}
            title={`团队记忆 · ${squad.name}`}
            description="团队黑板的知识点。运行小分队时按引用热度注入成员系统提示。"
            width={720}
            footer={
                <Button variant="ghost" onClick={onClose}>
                    关闭
                </Button>
            }
        >
            {panelContent}
        </Modal>
    )
}

/** 运行历史面板：列出历次协作会话，点开查看其讨论黑板与最终汇总。 */
export function SquadHistoryPanel({
                               open,
                               squad,
                               agents,
                               onClose,
                               embedded = false,
                           }: {
    open: boolean
    agents: AgentInfo[]
    squad: SquadInfo
    onClose: () => void
    embedded?: boolean
}) {
    const {message} = useNotify()
    const [sessions, setSessions] = useState<SquadSession[]>([])
    const [activeId, setActiveId] = useState<string | null>(null)
    const [rounds, setRounds] = useState<BoardRound[]>([])
    const [board, setBoard] = useState<SquadBoardView | null>(null)
    const [summary, setSummary] = useState('')
    const [packJson, setPackJson] = useState<string | null>(null)

    const reloadSessions = useCallback(async () => {
        try {
            setSessions(await listSquadSessions(squad.id))
        } catch (e) {
            message.error(`读取历史失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }, [squad.id, message])

    useEffect(() => {
        if (open) void reloadSessions()
        else {
            setActiveId(null)
            setRounds([])
            setBoard(null)
            setSummary('')
            setPackJson(null)
        }
    }, [open, reloadSessions])

    async function openSession(s: SquadSession) {
        setActiveId(s.id)
        try {
            const rs = await listSquadRounds(s.id)
            setRounds(
                rs.map((r) => ({role: r.role, kind: r.kind, content: r.content, speakerAgentId: r.speakerAgentId})),
            )
            setSummary(s.snapshot ?? '')
            // S1：解析黑板状态板（任务进度 + 决策卡）；解析失败静默降级为不显示。
            try {
                setBoard(s.boardJson ? (JSON.parse(s.boardJson) as SquadBoardView) : null)
            } catch {
                setBoard(null)
            }
            // S2：Delivery Pack（有则亮出导出按钮）。
            setPackJson(s.packJson ?? null)
        } catch (e) {
            message.error(`读取轮次失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    async function handleExportPack() {
        if (!packJson) return
        try {
            const pretty = JSON.stringify(JSON.parse(packJson), null, 2)
            const sid8 = (activeId ?? 'session').replace(/[^a-zA-Z0-9]/g, '').slice(-8)
            const ok = await saveTextFile(
                `delivery-pack-${sid8}.json`,
                pretty,
                [{name: 'JSON', extensions: ['json']}],
            )
            if (ok) message.success('交付包已导出')
        } catch (e) {
            message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    const panelContent = (
        <>
            <div className="squad-hist">
                <div className="squad-hist__list">
                    {sessions.length === 0 && <div className="squad-console__empty">暂无运行记录。</div>}
                    {sessions.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className={`squad-hist__item${activeId === s.id ? ' is-active' : ''}`}
                            onClick={() => void openSession(s)}
                        >
                            <div className="squad-hist__item-title">
                                {s.title || MODE_OPTIONS.find((o) => o.value === s.mode)?.label || s.mode}
                            </div>
                            <div className="squad-hist__item-meta">
                                {s.status} · {new Date(s.createdAt).toLocaleString()}
                            </div>
                        </button>
                    ))}
                </div>
                {squad.members.length > 0 && (
                    <div className="squad-hist__crew">
                        {squad.members.map((m) => (
                            <div key={m.agentId} className="squad-hist__crew-item" title={m.role}>
                                <PixelAgent appearance={agentAppearanceOf(agents, m.agentId)} state={summary ? 'cheer' : 'idle'} size={40} motion={!!summary}/>
                                <span>{m.role}</span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="squad-hist__board">
                    {activeId ? (
                        <>
                            {packJson && (
                                <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 8}}>
                                    <Button variant="soft" size="sm" onClick={() => void handleExportPack()}>
                                        <FolderOpen size={14}/> 导出交付包
                                    </Button>
                                </div>
                            )}
                            <RoundBoard rounds={rounds} summary={summary} board={board}/>
                        </>
                    ) : (
                        <div className="squad-console__empty">选择左侧会话查看讨论黑板。</div>
                    )}
                </div>
            </div>
        </>
    )

    if (embedded) {
        return <div className="squad-page-panel">{panelContent}</div>
    }

    return (
        <Modal
            open={open}
            onOpenChange={onClose}
            title={`运行历史 · ${squad.name}`}
            description="查看历次协作的讨论黑板与最终汇总。"
            width={760}
            footer={
                <Button variant="ghost" onClick={onClose}>
                    关闭
                </Button>
            }
        >
            {panelContent}
        </Modal>
    )
}

export default function SquadsWorkspacePage() {
    const {message} = useNotify()
    const nav = useNavigate()
    const [loading, setLoading] = useState(true)
    const [list, setList] = useState<SquadInfo[]>([])
    const [agents, setAgents] = useState<AgentInfo[]>([])
    // 卡片实时徽标：各编队最新会话状态（30s 轻量轮询）
    const [liveStatus, setLiveStatus] = useState<Record<string, string>>({})
    // 悬浮像素小人：key=`${squadId}-${idx}`，悬浮时该小人播放 idle 动画
    const [hoverCrew, setHoverCrew] = useState<string | null>(null)
    const [editorOpen, setEditorOpen] = useState(false)
    const [editing, setEditing] = useState<SquadInfo | undefined>(undefined)
    // UI 改版：API 服务入口提升至列表页头（复用既有配置弹窗）
    const [apiOpen, setApiOpen] = useState(false)
    // S3 批次2（§12）：从官方模板新建（编辑器内补选成员智能体后保存）。
    const [tplEditing, setTplEditing] = useState<SquadTemplateJson | undefined>(undefined)
    const [tplSel, setTplSel] = useState<string | undefined>(undefined)

    const reload = useCallback(async () => {
        setLoading(true)
        try {
            const [squads, ags, sts] = await Promise.all([listSquads(), listAgents(), latestSquadStatuses()])
            setList(squads)
            setAgents(ags)
            setLiveStatus(sts)
        } finally {
            setLoading(false)
        }
    }, [])

    // 后台协作实时徽标：轻量 SQL 轮询（不动列表 loading）
    useEffect(() => {
        const t = setInterval(() => {
            latestSquadStatuses().then(setLiveStatus).catch(() => {})
        }, 30000)
        return () => clearInterval(t)
    }, [])

    useEffect(() => {
        void reload()
    }, [reload])

    async function handleDelete(squad: SquadInfo) {
        try {
            const next = await deleteSquad(squad.id)
            setList(next)
            message.success(`已删除小分队「${squad.name}」`)
        } catch (e) {
            message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    function openCreate() {
        setEditing(undefined)
        setEditorOpen(true)
    }

    function openEdit(squad: SquadInfo) {
        setEditing(squad)
        setEditorOpen(true)
    }

    return (
        <div className="squads">
            <header className="squads__head">
                <div>
                    <h2 className="squads__title">小分队协作</h2>
                    <p className="squads__lead">
                        把多个智能体编成协作小组，按需选择编排式 / 流水线 / 群聊，协同攻克复杂任务。
                    </p>
                </div>
                <div className="squads__actions">
                    {/* S3 批次2（§12）：从官方模板新建——选模板进编辑器，补选成员智能体后保存 */}
                    <Select
                        className="squads__tpl-select"
                        placeholder="⭐ 从模板新建"
                        value={tplSel}
                        options={SQUAD_TEMPLATES.map((t) => ({value: t.templateId, label: `⭐ ${t.name}`}))}
                        onChange={(v) => {
                            const t = SQUAD_TEMPLATES.find((x) => x.templateId === v)
                            if (t) {
                                setEditing(undefined)
                                setTplEditing(t)
                                setEditorOpen(true)
                            }
                            setTplSel(undefined)
                        }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setApiOpen(true)}>
                        <Server size={14}/> API 服务
                    </Button>
                    <Button variant="solid" size="sm" onClick={openCreate}>
                        <Plus size={14}/> 新建小分队
                    </Button>
                </div>
            </header>

            <Spin spinning={loading} wrapperClassName="squads__spin">
                {list.length > 0 ? (
                    <div className="squads__grid">
                        {list.map((squad) => (
                            <Card frame="solid" key={squad.id} className="squads__card">
                                <div className="squads__card-head">
                                    <div className="squads__card-avatar">
                                        {squad.logo ? (
                                            <img src={squad.logo} alt={squad.name} className="squads__card-logo"/>
                                        ) : (
                                            <Users size={20}/>
                                        )}
                                    </div>
                                    <div className="squads__card-titles">
                                        <h3 className="squads__card-title">{squad.name}</h3>
                                        <div className="squads__card-tags">
                                            <Tag
                                                color={
                                                    squad.mode === 'orchestrator'
                                                        ? 'blue'
                                                        : squad.mode === 'pipeline'
                                                            ? 'purple'
                                                            : 'cyan'
                                                }
                                                bordered={false}
                                                style={{borderRadius: 999, marginInlineEnd: 0}}
                                            >
                                                {MODE_OPTIONS.find((o) => o.value === squad.mode)?.label ?? squad.mode}
                                            </Tag>
                                            {LIVE_LABELS[liveStatus[squad.id]] && (
                                                <span className={`squads__live squads__live--${liveStatus[squad.id]}`}>
                                                    <i className="squads__live-dot"/>
                                                    {LIVE_LABELS[liveStatus[squad.id]]}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <p className="squads__card-desc">{squad.description || '暂无描述'}</p>

                                <div className="squads__card-crew" title={squad.members.map((m) => memberLabel(m, agents)).join('、')}>
                                    {squad.members.slice(0, 8).map((m, i) => {
                                        const crewKey = `${squad.id}-${i}`
                                        return (
                                            <span
                                                key={m.id || crewKey}
                                                className="squads__crew-slot"
                                                onMouseEnter={() => setHoverCrew(crewKey)}
                                                onMouseLeave={() => setHoverCrew((k) => (k === crewKey ? null : k))}
                                            >
                                                <PixelAgent
                                                    appearance={agentAppearanceOf(agents, m.agentId)}
                                                    size={24}
                                                    motion={liveStatus[squad.id] === 'running' || hoverCrew === crewKey}
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
                                        onClick={() => nav(`/squads-workspace/${squad.id}?tab=run`)}
                                        aria-label="打开协作工作台"
                                        title="打开协作工作台（运行 / 历史 / 记忆）"
                                    >
                                        <Play size={14}/> 工作台
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => openEdit(squad)}
                                        aria-label="编辑"
                                    >
                                        <Pencil size={15}/>
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label="打开空间目录"
                                        title={squad.workspaceDir ? `打开空间目录：${squad.workspaceDir}` : '该编队未配置空间目录'}
                                        disabled={!squad.workspaceDir}
                                        onClick={() => {
                                            if (squad.workspaceDir) void openPath(squad.workspaceDir)
                                        }}
                                    >
                                        <FolderOpen size={15}/>
                                    </Button>
                                    <Popconfirm
                                        title="删除小分队"
                                        description="将同时清理其成员、群聊配置与运行历史，不可恢复。"
                                        okText="删除"
                                        cancelText="取消"
                                        okButtonProps={{danger: true}}
                                        onConfirm={() => handleDelete(squad)}
                                    >
                                        <Button variant="ghost" size="sm" className="squads__card-del"
                                                aria-label="删除">
                                            <Trash2 size={15}/>
                                        </Button>
                                    </Popconfirm>
                                </div>
                            </Card>
                        ))}
                    </div>
                ) : (
                    !loading && (
                        <div className="squads__empty">
                            <Empty description="暂无小分队，点击「新建小分队」开始"/>
                        </div>
                    )
                )}
            </Spin>

            <SquadEditorModal
                open={editorOpen}
                initial={editing}
                template={tplEditing}
                agents={agents}
                onClose={() => {
                    setEditorOpen(false)
                    setTplEditing(undefined)
                }}
                onSaved={(next) => setList(next)}
            />

            <SquadApiConfigModal open={apiOpen} onClose={() => setApiOpen(false)}/>
        </div>
    )
}
