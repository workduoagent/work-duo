/**
 * 智能体向导的「草稿模型」。
 *
 * 新建 / 编辑共用同一份草稿，4 个步骤只改这一份对象，最后一次性提交：
 *   agent_info（主表）+ agent_mcp_ref / agent_skill_ref（两张关联表）。
 *
 * 与落库实体的差异：
 *  - 关联表在草稿里是「勾选结果」（mcpTools / skillIds 数组），保存时再展开成行；
 *  - *_config 在这里是对象，落库时由 mapper 序列化成 JSON 文本。
 */
import type {
  AgentInfo,
  AgentMcpToolRef,
  AgentSkillRef,
  AgentUpsertInput,
  MemoryMode,
  PlanApprovalMode,
} from '@/types/core'
import type { PixelAgentAppearance } from '@/components/ui/pixel-agent'

/** 智能体配置上限（新建 / 编辑统一校验，选择时实时拦截 + 保存时硬校验共用） */
export const MAX_MCP_SERVERS = 3
/** 已绑定 MCP 服务的总工具数量上限 */
export const MAX_MCP_TOOLS = 10
/** 编排 Skill 数量上限 */
export const MAX_SKILLS = 3
/** 挂载本地插件数量上限（P2 新增） */
export const MAX_PLUGINS = 10

export interface AgentDraft {
  name: string
  identifier: string
  logo?: string
  /** 拟人化像素形象配置（形象设计弹窗再编辑源；undefined=尚未用形象设计生成过） */
  appearance?: PixelAgentAppearance
  scenario?: string
  description?: string
  /** 人设与指令（Markdown） */
  systemPrompt?: string
  welcomeMessage?: string
  llmId?: string
  llmConfig?: Record<string, unknown>
  ttsId?: string
  ttsConfig?: Record<string, unknown>
  sttId?: string
  sttConfig?: Record<string, unknown>
  isActive: boolean
  autoToolExecMode: boolean
  /** 是否允许该智能体使用沙箱环境 */
  allowSandbox: boolean
  /** 记忆模式：off=关闭 / active=主动 / forced=强制每次任务末沉淀（默认 off，兼容旧数据） */
  memoryMode: MemoryMode
  /** 计划审批策略：always=每次复合任务都走人工审批 / sensitive=仅敏感任务审批（纯低风险自动放行）/ never=从不审批（默认 always） */
  planAutoApproveMode: PlanApprovalMode
  /** 已勾选的 MCP 工具（最小单元 = toolId，mcpId 仅作分组冗余） */
  mcpTools: Array<{ mcpId: string; toolId: string }>
  /** 已编排的技能 id */
  skillIds: string[]
  /** 已挂载的本地插件 id（P2 新增，保存写入 agent_plugin_ref） */
  pluginIds: string[]
  /** 已绑定的知识库 id（第四期 K2，保存写入 agent_kb_ref） */
  kbIds: string[]
}

/** 新建时的空草稿（identifier 由调用方预先随机生成，便于用户直接看到可改） */
export function createEmptyDraft(identifier: string): AgentDraft {
  return {
    name: '',
    identifier,
    isActive: true,
    autoToolExecMode: false,
    allowSandbox: true,
    memoryMode: 'off',
    planAutoApproveMode: 'always',
    mcpTools: [],
    skillIds: [],
    pluginIds: [],
    kbIds: [],
  }
}

/** 编辑时：把主表 + 关联表的行还原成草稿（pluginIds / kbIds 为 id 列表，P2 / K2 新增） */
export function draftFromAgent(
  agent: AgentInfo,
  mcpRefs: AgentMcpToolRef[],
  skillRefs: AgentSkillRef[],
  pluginIds: string[] = [],
  kbIds: string[] = [],
): AgentDraft {
  return {
    name: agent.name,
    identifier: agent.identifier,
    logo: agent.logo,
    appearance: agent.appearance,
    scenario: agent.scenario,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    welcomeMessage: agent.welcomeMessage,
    llmId: agent.llmId,
    llmConfig: agent.llmConfig,
    ttsId: agent.ttsId,
    ttsConfig: agent.ttsConfig,
    sttId: agent.sttId,
    sttConfig: agent.sttConfig,
    isActive: agent.isActive,
    autoToolExecMode: agent.autoToolExecMode,
    allowSandbox: agent.allowSandbox,
    memoryMode: agent.memoryMode ?? 'off',
    planAutoApproveMode: agent.planAutoApproveMode ?? 'always',
    mcpTools: mcpRefs.map((r) => ({ mcpId: r.mcpId, toolId: r.toolId })),
    skillIds: skillRefs.map((r) => r.skillId),
    pluginIds,
    kbIds,
  }
}

/** 提交前：草稿 → mapper 入参（补齐必填项的兜底） */
export function draftToInput(draft: AgentDraft, id?: string): AgentUpsertInput {
  return {
    id,
    name: draft.name.trim(),
    identifier: draft.identifier.trim(),
    logo: draft.logo,
    appearance: draft.appearance,
    scenario: draft.scenario,
    description: draft.description?.trim() || undefined,
    systemPrompt: draft.systemPrompt,
    welcomeMessage: draft.welcomeMessage?.trim() || undefined,
    llmId: draft.llmId,
    llmConfig: draft.llmConfig,
    ttsId: draft.ttsId,
    ttsConfig: draft.ttsConfig,
    sttId: draft.sttId,
    sttConfig: draft.sttConfig,
    isActive: draft.isActive,
    autoToolExecMode: draft.autoToolExecMode,
    allowSandbox: draft.allowSandbox,
    // 记忆模式必须随草稿提交，否则提交对象丢失该字段、落库恒为默认 'off'（新建/编辑都受影响）。
    memoryMode: draft.memoryMode,
    // 计划审批策略同上：必须随草稿提交，否则落库恒为默认 'always'。
    planAutoApproveMode: draft.planAutoApproveMode,
    mcpTools: draft.mcpTools,
    skillIds: draft.skillIds,
    pluginIds: draft.pluginIds,
    kbIds: draft.kbIds,
  }
}
