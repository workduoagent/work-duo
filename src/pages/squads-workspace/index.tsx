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
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Plus, Trash2, Pencil, Play, Users, History, Brain, Settings2, FileUp, Inbox } from 'lucide-react'
import { Empty, Spin, Popconfirm, Tag } from 'antd'
import { Button, Card, Modal, Field, FieldLabel, Input, Select, Segmented, Switch, InputNumber } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { listAgents } from '@/core/mapper/agent-mapper'
import {
  listSquads,
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
import { listMcps } from '@/core/mapper/mcp-mapper'
import type { McpInfo } from '@/core/file/mcp-file'
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
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
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
  { label: '编排式', value: 'orchestrator', desc: '主管拆解委派成员，逐子任务执行后汇总' },
  { label: '流水线', value: 'pipeline', desc: '成员线性串流，前步产出喂后步输入' },
  { label: '群聊', value: 'chat', desc: '共享黑板轮流发言，Moderator 收口' },
]

const EXEC_OPTIONS: { label: string; value: SquadExecutionMode }[] = [
  { label: '手动', value: 'manual' },
  { label: '定时', value: 'schedule' },
  { label: 'API', value: 'api' },
]

// 角色为固定枚举，按协作模式开放不同选项；流水线模式不提供角色选择（角色由工序固定）。
const SQUAD_ROLE_OPTIONS: Record<SquadMode, { label: string; value: string }[]> = {
  orchestrator: [
    { label: '执行 WORKER', value: 'WORKER' },
    { label: '评审 CRITIC', value: 'CRITIC' },
  ],
  pipeline: [{ label: '执行 WORKER', value: 'WORKER' }],
  chat: [
    { label: '执行 WORKER', value: 'WORKER' },
    { label: '评审 CRITIC', value: 'CRITIC' },
    { label: '主持人 ORCHESTRATOR', value: 'ORCHESTRATOR' },
  ],
}

function genUniqueId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 8)
  return `sqd-${ymd}-${rand}`
}

/** 成员 / 下拉选项中「名字 + Logo」的统一渲染（创建 Agent 时支持了 Logo）。 */
function AgentOptionNode({ a }: { a: AgentInfo }) {
  return (
    <span className="squad-agent-opt">
      {a.logo ? (
        <img src={a.logo} alt="" className="squad-agent-opt__logo" />
      ) : (
        <span className="squad-agent-opt__logo squad-agent-opt__logo--empty">
          <Users size={13} />
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
  supportsFileInput: boolean
  executionMode: SquadExecutionMode
  retryCount: number
  scheduleCron: string
  schedulePrompt: string
  maxRounds: number
  summarizerAgentId: string
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
    supportsFileInput: false,
    executionMode: 'manual',
    retryCount: 3,
    scheduleCron: '',
    schedulePrompt: '',
    maxRounds: 8,
    summarizerAgentId: '',
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
    supportsFileInput: s.supportsFileInput ?? false,
    executionMode: s.runStrategy.executionMode,
    retryCount: s.runStrategy.retryCount,
    scheduleCron: s.runStrategy.scheduleCron ?? '',
    schedulePrompt: s.runStrategy.schedulePrompt ?? '',
    maxRounds: s.chatConfig.maxRounds,
    summarizerAgentId: s.chatConfig.summarizerAgentId ?? '',
    members: s.members.map((m) => ({
      agentId: m.agentId,
      role: m.role,
      personaOverride: m.personaOverride ?? '',
      pipelineOrder: m.pipelineOrder ?? null,
      dependsOn: m.dependsOn ?? [],
      isLeader: m.isLeader,
    })),
  }
}

/* ------------------------------------------------------------------ *
 * 编排画布（ReactFlow）：流水线模式独有。默认「输入节点」+ 成员节点（名字 + Logo）。
 * 成员间「连线」即依赖（dependsOn），决定执行先后；群聊 / 编排式不展示画布。
 * 未装 @xyflow/react 时由 shims.d.ts 兜底。
 * ------------------------------------------------------------------ */

const INPUT_NODE_ID = '__squad_input__'

interface SquadNodeData {
  agentId: string
  agentName: string
  agentLogo?: string
  role: string
  isLeader: boolean
}

function SquadInputNode({ data }: { data: { supportsFile: boolean } }) {
  return (
    <div className="squad-dag__node squad-dag__node--input">
      <Handle type="source" position={Position.Right} id="out" />
      <div className="squad-dag__node-ico">
        {data.supportsFile ? <FileUp size={18} /> : <Inbox size={18} />}
      </div>
      <div className="squad-dag__node-title">输入节点</div>
      <div className="squad-dag__node-sub">{data.supportsFile ? '允许文件输入' : '文本指令'}</div>
    </div>
  )
}

function SquadFlowNode({ data }: { data: SquadNodeData }) {
  return (
    <div className={`squad-dag__node squad-dag__node--member${data.isLeader ? ' is-leader' : ''}`}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="squad-dag__node-avatar">
        {data.agentLogo ? <img src={data.agentLogo} alt="" /> : <Users size={16} />}
      </div>
      <div className="squad-dag__node-body">
        <div className="squad-dag__node-name">{data.agentName}</div>
        {data.role ? <div className="squad-dag__node-role">{data.role}</div> : null}
      </div>
      {data.isLeader && <span className="squad-dag__node-badge">主管</span>}
      <Handle type="source" position={Position.Right} id="out" />
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
    () => ({ inputNode: SquadInputNode, squadMember: SquadFlowNode }),
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
        position: { x: 24, y: 150 },
        data: { supportsFile: supportsFileInput },
        draggable: false,
        selectable: false,
      }
      const ms: Node[] = members.map((m, i) => {
        const a = agentOf(m.agentId)
        const existing = prev.find((p) => p.id === m.agentId)
        return {
          id: m.agentId,
          type: 'squadMember',
          position: posRef.current[m.agentId] ?? existing?.position ?? { x: 360, y: 30 + i * 130 },
          data: {
            agentId: m.agentId,
            agentName: a?.name ?? m.agentId,
            agentLogo: a?.logo,
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
          ? { ...m, dependsOn: Array.from(new Set([...(m.dependsOn ?? []), c.source as string])) }
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
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

/** 小分队 API 触发服务配置弹窗。 */
function SquadApiConfigModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = useNotify()
  const [cfg, setCfg] = useState<SquadApiConfig>({ enabled: false, port: 3939, token: '' })
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
      const next = await setSquadApiConfig({ enabled: cfg.enabled, port: cfg.port, token: cfg.token })
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
          <Switch checked={cfg.enabled} onChange={(v) => setCfg((c) => ({ ...c, enabled: v }))} />
        </div>
        <Field className="squad-api__row">
          <FieldLabel htmlFor="api-port">监听端口</FieldLabel>
          <InputNumber min={1} max={65535} value={cfg.port} onChange={(v) => setCfg((c) => ({ ...c, port: v ?? 3939 }))} />
        </Field>
        <Field className="squad-api__row">
          <FieldLabel htmlFor="api-token">访问令牌</FieldLabel>
          <Input
            id="api-token"
            autoComplete="off"
            placeholder="触发时须携带此令牌"
            value={cfg.token}
            onChange={(e) => setCfg((c) => ({ ...c, token: e.target.value }))}
          />
        </Field>
        <p className="squad-api__hint">
          说明：开关 / 令牌实时生效；端口变更需重启应用。触发示例：
          <br />
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
  agents,
  onClose,
  onSaved,
}: {
  open: boolean
  initial?: SquadInfo
  agents: AgentInfo[]
  onClose: () => void
  onSaved: (list: SquadInfo[]) => void
}) {
  const { message } = useNotify()
  const [state, setState] = useState<EditorState>(blankState())
  const [saving, setSaving] = useState(false)
  const [apiOpen, setApiOpen] = useState(false)
  const [mcps, setMcps] = useState<McpInfo[]>([])
  const logoInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setState(initial ? fromSquad(initial) : blankState())
      void listMcps()
        .then(setMcps)
        .catch(() => setMcps([]))
    }
  }, [open, initial])

  const allAgentOptions = useMemo(
    () => agents.map((a) => ({ value: a.id, label: <AgentOptionNode a={a} /> })),
    [agents],
  )

  const mcpOptions = useMemo(
    () => mcps.map((m) => ({ label: m.aliasName || m.mcpName, value: m.id })),
    [mcps],
  )

  const [addSel, setAddSel] = useState<string | undefined>(undefined)

  const setMembers = (members: SquadMemberInput[]) => setState((s) => ({ ...s, members }))

  // 模式切换：清理非法角色；主管 / 汇总主笔随模式切换清理（流水线无主管概念）。
  const changeMode = (next: SquadMode) => {
    setState((s) => {
      const roleOpts = SQUAD_ROLE_OPTIONS[next].map((o) => o.value)
      const members = s.members.map((m) =>
        next === 'pipeline'
          ? { ...m, role: '' }
          : { ...m, role: roleOpts.includes(m.role) ? m.role : roleOpts[0] ?? '' },
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
      if (typeof reader.result === 'string') setState((s) => ({ ...s, logo: reader.result as string }))
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => message.success('已复制'),
      () => message.error('复制失败'),
    )
  }

  const addMember = (agentId?: string) => {
    const aid = agentId ?? agents[0]?.id
    if (!aid) {
      message.warning('请先创建至少一个智能体')
      return
    }
    if (state.members.some((m) => m.agentId === aid)) {
      message.warning('该智能体已在成员列表中')
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
    const next = state.members.map((m, i) => (i === idx ? { ...m, ...patch } : m))
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
      // 主管 / 汇总主笔按模式各自分立（均不占成员名额）；流水线无主管概念。
      const leaderAgentId = state.mode === 'orchestrator' ? (state.leaderAgentId || null) : null
      const summarizerAgentId = state.mode === 'chat' ? (state.summarizerAgentId || null) : null
      const members = state.members.map((m) => ({
        ...m,
        // 主管 / 汇总主笔独立设定，不标记任何成员为 isLeader
        isLeader: false,
        role: state.mode === 'pipeline' ? '' : m.role,
        pipelineOrder: null,
      }))
      const list = await upsertSquad({
        id: state.id,
        name: state.name.trim(),
        description: state.description.trim() || null,
        logo: state.logo.trim() || null,
        mode: state.mode,
        leaderAgentId,
        globalMcpIds: state.globalMcpIds,
        supportsFileInput: state.supportsFileInput,
        runStrategy: {
          executionMode: state.executionMode,
          retryCount: state.retryCount,
          scheduleCron: state.scheduleCron.trim() || null,
          schedulePrompt: state.schedulePrompt.trim() || null,
        },
        members,
        chatConfig: { maxRounds: state.maxRounds, summarizerAgentId },
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

  return (
    <>
    <Modal
      open={open}
      onOpenChange={onClose}
      title={state.id ? '编辑小分队' : '新建小分队'}
      description="组合多个智能体，按不同协作模式协同完成复杂任务。"
      width={920}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="solid" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="squad-editor">
        <div className="squad-editor__basic">
          <Field className="squad-editor__row">
            <FieldLabel htmlFor="squad-name">名称</FieldLabel>
            <Input
              id="squad-name"
              autoComplete="off"
              placeholder="例如：SUI 投研小队"
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
            />
          </Field>

          <Field className="squad-editor__row">
            <FieldLabel>团队头像</FieldLabel>
            <div className="squad-editor__logo">
              <div className="squad-editor__logo-preview">
                {state.logo ? (
                  <img src={state.logo} alt="头像预览" />
                ) : (
                  <span className="squad-editor__logo-empty">未设置</span>
                )}
              </div>
              <div className="squad-editor__logo-actions">
                <Button variant="soft" size="sm" onClick={() => logoInputRef.current?.click()}>
                  选择图片
                </Button>
                {state.logo && (
                  <Button variant="ghost" size="sm" onClick={() => setState((s) => ({ ...s, logo: '' }))}>
                    清除
                  </Button>
                )}
                <input ref={logoInputRef} type="file" accept="image/*" hidden onChange={onLogoPick} />
              </div>
            </div>
          </Field>

          <Field className="squad-editor__row">
            <FieldLabel htmlFor="squad-uid">唯一标识（外部调用用）</FieldLabel>
            <div className="squad-editor__uid">
              <Input
                id="squad-uid"
                autoComplete="off"
                value={state.uniqueId}
                onChange={(e) => setState((s) => ({ ...s, uniqueId: e.target.value }))}
              />
              <Button variant="ghost" size="sm" onClick={() => setState((s) => ({ ...s, uniqueId: genUniqueId() }))}>
                重新生成
              </Button>
              <Button variant="ghost" size="sm" onClick={() => copyText(state.uniqueId)}>
                复制
              </Button>
            </div>
            <p className="squad-editor__hint">
              保存后该标识固定不变；外部系统（如 API 触发、脚本）可凭此标识引用本小分队，无需关心内部 id。
            </p>
          </Field>

          <Field className="squad-editor__row">
            <FieldLabel>协作模式</FieldLabel>
            <Segmented
              className="squad-editor__mode"
              value={state.mode}
              onChange={(v) => changeMode(v as SquadMode)}
              options={MODE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
            />
            <p className="squad-editor__mode-desc">
              {MODE_OPTIONS.find((o) => o.value === state.mode)?.desc}
            </p>
          </Field>

          <Field className="squad-editor__row squad-editor__span2">
            <FieldLabel htmlFor="squad-desc">描述</FieldLabel>
            <Input.TextArea
              id="squad-desc"
              autoComplete="off"
              rows={2}
              placeholder="一句话说明这个协作小组的用途"
              value={state.description}
              onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
            />
          </Field>
        </div>

        <Field className="squad-editor__row">
          <FieldLabel htmlFor="squad-mcp">全局 MCP 服务（可选）</FieldLabel>
          <Select
            id="squad-mcp"
            className="squad-editor__mcp"
            mode="multiple"
            allowClear
            placeholder="选择要全局挂载的 MCP 服务（成员运行时强制并入工具集）"
            value={state.globalMcpIds}
            options={mcpOptions}
            onChange={(v) => setState((s) => ({ ...s, globalMcpIds: (v as string[]) ?? [] }))}
          />
          {mcpOptions.length === 0 && (
            <p className="squad-editor__hint">暂无可用 MCP 服务，请先到「MCP 中心」添加。</p>
          )}
        </Field>

        {state.mode === 'pipeline' && (
          <Field className="squad-editor__row">
            <FieldLabel>编排画布</FieldLabel>
            <p className="squad-editor__hint">
              从默认「输入节点」出发，拖拽成员右侧圆点连到下游成员即建立依赖，决定执行先后；无依赖的成员由输入节点直接喂入。
            </p>
            <SquadDagEditor
              members={state.members}
              agents={agents}
              supportsFileInput={state.supportsFileInput}
              onChange={setMembers}
            />
          </Field>
        )}

        <div className="squad-editor__members">
          <div className="squad-editor__members-head">
            <span>
              成员（{state.members.length}）
            </span>
            <Select
              className="squad-editor__add-member"
              placeholder="选择智能体加入…"
              value={addSel}
              options={agents
                .filter((a) => !state.members.some((m) => m.agentId === a.id))
                .map((a) => ({ value: a.id, label: <AgentOptionNode a={a} /> }))}
              onChange={(v) => {
                addMember(v as string)
                setAddSel(undefined)
              }}
            />
          </div>

          {state.members.length === 0 && (
            <div className="squad-editor__members-empty">尚未添加成员</div>
          )}

          {state.members.map((m, idx) => (
            <div className="squad-editor__member" key={idx}>
              <div className="squad-editor__member-line">
                <Select
                  className="squad-editor__member-agent"
                  placeholder="选择智能体"
                  value={m.agentId || undefined}
                  options={allAgentOptions}
                  onChange={(v) => patchMember(idx, { agentId: v as string })}
                />
                {state.mode !== 'pipeline' && (
                  <Select
                    className="squad-editor__member-role"
                    placeholder="角色"
                    value={m.role || undefined}
                    options={SQUAD_ROLE_OPTIONS[state.mode]}
                    onChange={(v) => patchMember(idx, { role: (v as string) ?? '' })}
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="移除"
                  onClick={() => removeMember(idx)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
              <Input.TextArea
                autoComplete="off"
                rows={2}
                placeholder="人设定制（可选，追加到该成员 system_prompt 末尾）"
                value={m.personaOverride}
                onChange={(e) => patchMember(idx, { personaOverride: e.target.value })}
              />
            </div>
          ))}
        </div>

        {state.mode === 'orchestrator' && (
          <Field className="squad-editor__row">
            <FieldLabel htmlFor="squad-leader">主管智能体（单独设定）</FieldLabel>
            <Select
              id="squad-leader"
              className="squad-editor__leader"
              allowClear
              placeholder="选择主管（不占成员名额，负责拆解任务 / 汇总）"
              value={state.leaderAgentId || undefined}
              options={allAgentOptions}
              onChange={(v) => setState((s) => ({ ...s, leaderAgentId: (v as string) ?? '' }))}
            />
            <p className="squad-editor__hint">
              主管独立于成员列表单独设定；编排式下主管负责拆解任务并汇总各成员交付。
            </p>
          </Field>
        )}

        {state.mode === 'chat' && (
          <Field className="squad-editor__row">
            <FieldLabel htmlFor="squad-summarizer">汇总主笔（单独设定）</FieldLabel>
            <Select
              id="squad-summarizer"
              className="squad-editor__leader"
              allowClear
              placeholder="选择汇总主笔（不占成员名额，负责产出最终结论）"
              value={state.summarizerAgentId || undefined}
              options={allAgentOptions}
              onChange={(v) => setState((s) => ({ ...s, summarizerAgentId: (v as string) ?? '' }))}
            />
            <p className="squad-editor__hint">
              汇总主笔独立于成员列表单独设定，负责在群聊收口时产出最终结论。
            </p>
          </Field>
        )}

        <Field className="squad-editor__row squad-editor__file-input">
          <div className="squad-editor__file-input-line">
            <Switch
              checked={state.supportsFileInput}
              onChange={(v) => setState((s) => ({ ...s, supportsFileInput: v }))}
            />
            <span>支持文件输入</span>
          </div>
          <p className="squad-editor__hint">
            开启后，运行该小分队时允许附带文件（{state.mode === 'pipeline' ? '在画布「输入节点」挂载' : '随任务指令一并提交'}），成员可读取文件内容参与协作。
          </p>
        </Field>

        <div className="squad-editor__strategy">
          <Field className="squad-editor__row">
            <FieldLabel>运行策略</FieldLabel>
            <div className="squad-editor__strategy-line">
              <Segmented
                value={state.executionMode}
                onChange={(v) => setState((s) => ({ ...s, executionMode: v as SquadExecutionMode }))}
                options={EXEC_OPTIONS}
              />
              <span className="squad-editor__retry">
                节点失败重试
                <InputNumber
                  min={0}
                  max={10}
                  value={state.retryCount}
                  onChange={(v) => setState((s) => ({ ...s, retryCount: v ?? 3 }))}
                />
                次
              </span>
            </div>

            {state.executionMode === 'schedule' && (
              <>
                <div className="squad-editor__cron">
                  <FieldLabel htmlFor="squad-cron">定时表达式（cron，5 字段）</FieldLabel>
                  <Input
                    id="squad-cron"
                    autoComplete="off"
                    placeholder="例如：0 */2 * * *（每 2 小时）"
                    value={state.scheduleCron}
                    onChange={(e) => setState((s) => ({ ...s, scheduleCron: e.target.value }))}
                  />
                  <p className="squad-editor__hint">
                    格式：分 时 日 月 星期，支持 <code>*</code> / <code>*/n</code> / <code>a-b</code> / <code>a,b</code>。
                    到点后自动用下方指令运行。
                  </p>
                </div>
                <div className="squad-editor__cron-prompt">
                  <FieldLabel htmlFor="squad-sprompt">定时触发时的任务指令</FieldLabel>
                  <Input.TextArea
                    id="squad-sprompt"
                    autoComplete="off"
                    rows={2}
                    placeholder="到点后自动执行的任务描述（手动运行时仍用即时输入）"
                    value={state.schedulePrompt}
                    onChange={(e) => setState((s) => ({ ...s, schedulePrompt: e.target.value }))}
                  />
                </div>
              </>
            )}

            {state.executionMode === 'api' && (
              <div className="squad-editor__api">
                <FieldLabel>API 触发</FieldLabel>
                <p className="squad-editor__hint">
                  启用后，外部系统可通过本地 HTTP 触发本小分队运行（需先在下方配置 API 服务）：
                </p>
                <pre className="squad-editor__curl">{`POST http://127.0.0.1:3939/api/squads/{squadId}/run
Authorization: Bearer <token>`}</pre>
                <Button variant="soft" size="sm" onClick={() => setApiOpen(true)}>
                  <Settings2 size={14} /> 配置 API 服务
                </Button>
              </div>
            )}
          </Field>

          {state.mode === 'chat' && (
            <Field className="squad-editor__row">
              <FieldLabel htmlFor="squad-sum">群聊配置</FieldLabel>
              <div className="squad-editor__strategy-line">
                <span>发言轮次上限</span>
                <InputNumber
                  min={1}
                  max={30}
                  value={state.maxRounds}
                  onChange={(v) => setState((s) => ({ ...s, maxRounds: v ?? 8 }))}
                />
                <span className="squad-editor__member-order-hint">（由「汇总主笔」收口最终结论）</span>
              </div>
            </Field>
          )}

          {state.mode === 'pipeline' && state.members.length > 0 && (
            <Field className="squad-editor__row">
              <FieldLabel>流水线执行顺序</FieldLabel>
              <p className="squad-editor__hint">
                在上方「编排画布」中拖拽成员右侧圆点连到下游成员即建立依赖；无依赖的成员由输入节点直接喂入。执行先后完全由连线顺序决定（上游产物喂下游），无需手工填工序号。
              </p>
            </Field>
          )}
        </div>
      </div>
    </Modal>

    <SquadApiConfigModal open={apiOpen} onClose={() => setApiOpen(false)} />
    </>
  )
}

interface SquadRoundView {
  role: string
  kind: string
  content: string
  speakerAgentId?: string | null
}

function SquadRunConsole({
  open,
  squad,
  onClose,
}: {
  open: boolean
  squad: SquadInfo
  onClose: () => void
}) {
  const { message } = useNotify()
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [rounds, setRounds] = useState<SquadRoundView[]>([])
  const [summary, setSummary] = useState('')
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
        setRounds((r) => [...r, { role: pl.role, kind: pl.kind, content: pl.content, speakerAgentId: pl.speakerAgentId }])
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
      unlistenRef.current = [offStart, offRound, offDone]
      await invoke('run_squad_task', { squadId: squad.id, prompt: p })
    } catch (e) {
      message.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
      setRunning(false)
      cleanup()
    }
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
            <Play size={14} /> {running ? '协作进行中…' : '运行协作'}
          </Button>
        </div>

        <div className="squad-console__board">
          {rounds.length === 0 && !running && !summary && (
            <div className="squad-console__empty">运行后将在此显示成员讨论 / 子任务交付与最终汇总</div>
          )}
          <Spin spinning={running && rounds.length === 0}>
            {rounds.map((r, i) => (
              <div className={`squad-round squad-round--${r.kind}`} key={i}>
                <div className="squad-round__head">
                  <Tag
                    color={
                      r.kind === 'summary'
                        ? 'gold'
                        : r.kind === 'delegation'
                          ? 'blue'
                          : r.kind === 'system'
                            ? 'default'
                            : 'green'
                    }
                  >
                    {r.kind === 'summary'
                      ? '汇总'
                      : r.kind === 'delegation'
                        ? '委派规划'
                        : r.kind === 'system'
                          ? '系统'
                          : r.kind === 'message'
                            ? '发言'
                            : '交付'}
                  </Tag>
                  <span className="squad-round__role">{r.role}</span>
                </div>
                <div className="squad-round__content">{r.content}</div>
              </div>
            ))}
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
      </div>
    </Modal>
  )
}

const CAT_OPTIONS: { label: string; value: SquadMemoryCategory }[] = [
  { label: '通用', value: 'general' },
  { label: '决策', value: 'decision' },
  { label: '代码范式', value: 'code_pattern' },
  { label: '用户偏好', value: 'user_pref' },
  { label: '架构', value: 'architecture' },
  { label: '修复', value: 'fix' },
  { label: '其他', value: 'other' },
]

interface BoardRound {
  role: string
  kind: string
  content: string
  speakerAgentId?: string | null
}

function roundTagMeta(kind: string): { label: string; color: string } {
  switch (kind) {
    case 'summary':
      return { label: '汇总', color: 'gold' }
    case 'delegation':
      return { label: '委派规划', color: 'blue' }
    case 'message':
      return { label: '发言', color: 'green' }
    case 'system':
      return { label: '系统', color: 'default' }
    default:
      return { label: '交付', color: 'green' }
  }
}

/** 复用的讨论黑板渲染（运行控制台实时流 / 历史回显共用）。 */
function RoundBoard({ rounds, summary }: { rounds: BoardRound[]; summary?: string }) {
  return (
    <div className="squad-console__board">
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
            <div className="squad-round__content">{r.content}</div>
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
function SquadMemoryPanel({
  open,
  squad,
  onClose,
}: {
  open: boolean
  squad: SquadInfo
  onClose: () => void
}) {
  const { message } = useNotify()
  const [memories, setMemories] = useState<SquadMemory[]>([])
  const [key, setKey] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<SquadMemoryCategory>('general')
  const [scope, setScope] = useState<'team' | 'member'>('team')
  const [agentId, setAgentId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const unlistenRef = useRef<UnlistenFn | null>(null)

  const reload = useCallback(async () => {
    try {
      setMemories(await listSquadMemories(squad.id))
    } catch (e) {
      message.error(`读取记忆失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [squad.id, message])

  useEffect(() => {
    if (!open) {
      unlistenRef.current?.()
      unlistenRef.current = null
      return
    }
    void reload()
    void (async () => {
      const off = await listen<{ item: SquadMemory }>('agent-squad-memory-anchored', (e) => {
        if (e.payload.item.squadId === squad.id) void reload()
      })
      unlistenRef.current = off
    })()
    return () => {
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }, [open, squad.id, reload])

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
              options={CAT_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              onChange={(v) => setCategory(v as SquadMemoryCategory)}
            />
            <Segmented
              value={scope}
              onChange={(v) => setScope(v as 'team' | 'member')}
              options={[
                { label: '团队共享', value: 'team' },
                { label: '成员个人', value: 'member' },
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
                  <Trash2 size={14} />
                </Button>
              </div>
              <div className="squad-mem__content">{m.content}</div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/** 运行历史面板：列出历次协作会话，点开查看其讨论黑板与最终汇总。 */
function SquadHistoryPanel({
  open,
  squad,
  onClose,
}: {
  open: boolean
  squad: SquadInfo
  onClose: () => void
}) {
  const { message } = useNotify()
  const [sessions, setSessions] = useState<SquadSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [rounds, setRounds] = useState<BoardRound[]>([])
  const [summary, setSummary] = useState('')

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
      setSummary('')
    }
  }, [open, reloadSessions])

  async function openSession(s: SquadSession) {
    setActiveId(s.id)
    try {
      const rs = await listSquadRounds(s.id)
      setRounds(
        rs.map((r) => ({ role: r.role, kind: r.kind, content: r.content, speakerAgentId: r.speakerAgentId })),
      )
      setSummary(s.snapshot ?? '')
    } catch (e) {
      message.error(`读取轮次失败：${e instanceof Error ? e.message : String(e)}`)
    }
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
        <div className="squad-hist__board">
          {activeId ? (
            <RoundBoard rounds={rounds} summary={summary} />
          ) : (
            <div className="squad-console__empty">选择左侧会话查看讨论黑板。</div>
          )}
        </div>
      </div>
    </Modal>
  )
}

export default function SquadsWorkspacePage() {
  const { message } = useNotify()
  const [loading, setLoading] = useState(true)
  const [list, setList] = useState<SquadInfo[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<SquadInfo | undefined>(undefined)
  const [runningSquad, setRunningSquad] = useState<SquadInfo | undefined>(undefined)
  const [memSquad, setMemSquad] = useState<SquadInfo | undefined>(undefined)
  const [histSquad, setHistSquad] = useState<SquadInfo | undefined>(undefined)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [squads, ags] = await Promise.all([listSquads(), listAgents()])
      setList(squads)
      setAgents(ags)
    } finally {
      setLoading(false)
    }
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
          <Button variant="soft" size="sm" onClick={openCreate}>
            <Plus size={14} /> 新建小分队
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
                      <img src={squad.logo} alt={squad.name} className="squads__card-logo" />
                    ) : (
                      <Users size={20} />
                    )}
                  </div>
                  <div className="squads__card-titles">
                    <h3 className="squads__card-title">{squad.name}</h3>
                    <Tag
                      color={
                        squad.mode === 'orchestrator'
                          ? 'blue'
                          : squad.mode === 'pipeline'
                            ? 'purple'
                            : 'cyan'
                      }
                    >
                      {MODE_OPTIONS.find((o) => o.value === squad.mode)?.label ?? squad.mode}
                    </Tag>
                  </div>
                </div>

                <p className="squads__card-desc">{squad.description || '暂无描述'}</p>

                <div className="squads__card-members">
                  <Users size={13} />
                  <span>
                    {squad.members.length} 名成员：
                    {squad.members.map((m) => m.role || m.agentId).join('、')}
                  </span>
                </div>

                <div className="squads__card-actions">
                  <Button
                    variant="solid"
                    size="sm"
                    onClick={() => setRunningSquad(squad)}
                    aria-label="运行"
                  >
                    <Play size={14} /> 运行
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setHistSquad(squad)}
                    aria-label="运行历史"
                  >
                    <History size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMemSquad(squad)}
                    aria-label="团队记忆"
                  >
                    <Brain size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(squad)}
                    aria-label="编辑"
                  >
                    <Pencil size={15} />
                  </Button>
                  <Popconfirm
                    title="删除小分队"
                    description="将同时清理其成员、群聊配置与运行历史，不可恢复。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(squad)}
                  >
                    <Button variant="ghost" size="sm" className="squads__card-del" aria-label="删除">
                      <Trash2 size={15} />
                    </Button>
                  </Popconfirm>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          !loading && (
            <div className="squads__empty">
              <Empty description="暂无小分队，点击「新建小分队」开始" />
            </div>
          )
        )}
      </Spin>

      <SquadEditorModal
        open={editorOpen}
        initial={editing}
        agents={agents}
        onClose={() => setEditorOpen(false)}
        onSaved={(next) => setList(next)}
      />

      {runningSquad && (
        <SquadRunConsole
          open={Boolean(runningSquad)}
          squad={runningSquad}
          onClose={() => setRunningSquad(undefined)}
        />
      )}

      {histSquad && (
        <SquadHistoryPanel
          open={Boolean(histSquad)}
          squad={histSquad}
          onClose={() => setHistSquad(undefined)}
        />
      )}

      {memSquad && (
        <SquadMemoryPanel
          open={Boolean(memSquad)}
          squad={memSquad}
          onClose={() => setMemSquad(undefined)}
        />
      )}
    </div>
  )
}
