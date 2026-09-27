/**
 * 智能体档案加载（台账 S1：自 chat.tsx 原样迁出 hook 化，行为零改动）。
 *
 * 覆盖：按路由 id 加载智能体 + 工具/技能计数 + 多模态 / STT 能力判定 + 上下文窗口、
 * MCP 服务（含绑定工具解析）/ 技能 / 插件绑定清单与全量 @提及 候选缓存、
 * 默认工作空间解析（resolveWorkspaceDir，见 terminal-bridge）、会话与工程列表首载。
 * 智能体不存在时导航回列表页。sessions / projects state 留在组件（TDZ），传 setter 首载。
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { listSkills } from '@/core/mapper/skill-mapper'
import { listPlugins, listAgentPlugins } from '@/core/mapper/plugin-mapper'
import type { UserPluginTool } from '@/core/file/plugin-file'
import { listMcps, listMcpTools } from '@/core/mapper/mcp-mapper'
import { getModel } from '@/core/mapper/model-mapper'
import { resolveWorkspaceDir } from './terminal-bridge'
import { listSessions } from '@/core/mapper/agent-session-mapper'
import { listProjects } from '@/core/mapper/agent-project-mapper'
import type { McpToolDefinition } from '@/core/file/mcp-file'
import type { SkillInfo } from '@/core/file/skill-file'
import type { BoundMcpServer } from './types'
import type { AgentInfo } from '@/types/core'
import type { useNotify } from '@/components/ui/notify'
import type { Dispatch, SetStateAction } from 'react'
import type { AgentConversationSession, AgentProject } from '@/types/core'

export function useAgentProfile(opts: {
  id: string
  message: ReturnType<typeof useNotify>['message']
  setSessions: Dispatch<SetStateAction<AgentConversationSession[]>>
  setProjects: Dispatch<SetStateAction<AgentProject[]>>
}) {
  const { id, message, setSessions, setProjects } = opts
  const navigate = useNavigate()

  const [agent, setAgent] = useState<AgentInfo | undefined>()
  const [loading, setLoading] = useState(true)
  const [toolCount, setToolCount] = useState(0)
  const [skillCount, setSkillCount] = useState(0)

  // 能力：多模态 / STT
  const [isMultimodal, setIsMultimodal] = useState(false)
  const [hasStt, setHasStt] = useState(false)

  // 底部工具条展示用：MCP 服务（含其工具）/ 技能 / 已挂载插件
  const [boundMcps, setBoundMcps] = useState<BoundMcpServer[]>([])
  const [boundSkills, setBoundSkills] = useState<SkillInfo[]>([])
  const [boundPlugins, setBoundPlugins] = useState<UserPluginTool[]>([])
  // @提及 候选全集（全量技能 / MCP 服务 / 插件，不限于本智能体绑定），供输入框随时引用
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [allMcps, setAllMcps] = useState<Awaited<ReturnType<typeof listMcps>>>([])
  const [allPlugins, setAllPlugins] = useState<Awaited<ReturnType<typeof listPlugins>>>([])
  // 绑定 LLM 的上下文窗口（token），用于环形图占比分母
  const [contextLength, setContextLength] = useState<number | undefined>()
  // 工作空间：默认解析路径（单人调试）
  const [defaultWorkspaceDir, setDefaultWorkspaceDir] = useState<string | null>(null)

  // 加载智能体 + 工具/技能计数 + 能力判定 + 工作空间 + 会话列表
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [a, mcp, skills, plugins] = await Promise.all([
          getAgent(id),
          listAgentMcpTools(id),
          listAgentSkills(id),
          listAgentPlugins(id),
        ])
        if (!alive) return
        if (!a) {
          message.error('智能体不存在或已被删除')
          navigate('/agent-studio', { replace: true })
          return
        }
        setToolCount(mcp.length)
        setSkillCount(skills.length)
        setAgent(a)

        // 多模态判定：绑定 LLM 的 category === 'multimodal'
        if (a.llmId) {
          const m = await getModel(a.llmId)
          if (alive) setIsMultimodal(m?.category === 'multimodal')
          if (alive) {
            const cl = m ? (m.text?.contextLength ?? m.multimodal?.contextLength) : undefined
            setContextLength(typeof cl === 'number' ? cl : undefined)
          }
        } else if (alive) {
          setIsMultimodal(false)
          setContextLength(undefined)
        }
        if (alive) setHasStt(!!a.sttId)

        // MCP 服务（含其绑定工具）+ 技能（底部工具条展示）
        const [allMcps, allSkills, allPlugins] = await Promise.all([listMcps(), listSkills(), listPlugins()])
        // 智能体绑定的 MCP 工具引用：每个 ref 对应一个 mcp_tool_definition
        const serverIds = [...new Set(mcp.map((r) => r.mcpId))]
        // 逐个 MCP 拉取其全部工具定义，按 ref 匹配出「本智能体实际绑定」的工具
        const toolsByMcp: Record<string, McpToolDefinition[]> = {}
        await Promise.all(
          serverIds.map(async (mid) => {
            toolsByMcp[mid] = await listMcpTools(mid)
          }),
        )
        const bound: BoundMcpServer[] = serverIds
          .map((mid) => {
            const info = allMcps.find((m) => m.id === mid)
            const tools = mcp
              .filter((r) => r.mcpId === mid)
              .map((r) => {
                const def = (toolsByMcp[mid] ?? []).find((t) => t.id === r.toolId)
                return {
                  toolId: r.toolId,
                  toolCode: def?.toolCode ?? '',
                  displayName: def?.displayName,
                  description: def?.description,
                }
              })
            return {
              mcpId: mid,
              name: info?.aliasName || info?.mcpName || mid,
              tools,
            }
          })
          .filter((m) => m.tools.length > 0)
        const matched = skills
          .map((s) => allSkills.find((x) => x.id === s.skillId))
          .filter((s): s is NonNullable<typeof s> => !!s)
        if (alive) {
          setBoundMcps(bound)
          setBoundSkills(matched)
          // 已挂载插件（P2 新增）：底部工具条罗列
          setBoundPlugins(plugins)
          // 全量技能 / MCP 服务 / 插件缓存，供输入框 @提及 候选（不局限于本智能体绑定项）
          setAllSkills(allSkills)
          setAllMcps(allMcps)
          setAllPlugins(allPlugins)
        }

        // 工作空间：解析默认路径（单人调试不自定义）
        const ws = await resolveWorkspaceDir(a)
        if (alive) setDefaultWorkspaceDir(ws)

        // 会话列表
        const list = await listSessions(a.identifier)
        if (alive) setSessions(list)
        // 工程列表（智能工作空间绑定：新建向导 / 树状分组 / 目录回显）
        if (alive) setProjects(await listProjects())
      } catch (e) {
        message.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return {
    agent,
    loading,
    toolCount,
    skillCount,
    isMultimodal,
    hasStt,
    contextLength,
    boundMcps,
    boundSkills,
    boundPlugins,
    allSkills,
    allMcps,
    allPlugins,
    defaultWorkspaceDir,
  }
}
