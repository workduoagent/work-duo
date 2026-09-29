/**
 * 小分队内置角色包（§4.2 五个预设）与官方编队模板（§12）。
 *
 * 角色预设 = id + label + personaTemplate + toolProfile + expectedOutput（§4.2 interface）。
 * 本批只落 toolProfile + persona 两维（expectedOutput 供 UI 展示，不落库）。
 * 工具面直接引用 Rust 侧 tool_family_members 已就位的工具族（write/execute/network/destructive/read）：
 *  - CRITIC = deny write+destructive 族（09-29 真机教训：逐个列工具名会被 run_node_sandbox 绕过）；
 *  - MODERATOR = allowlist read+network 族（read 族：read_file/list_directory/path_exists/grep_files/kb_search/query_graph）。
 *
 * 模板 JSON 存 src/assets/squad-templates/（?raw 导入 + JSON.parse，成员 agentId 留空由用户选择），
 * 导入 = templateToEditorMembers / resolveTemplateMember；导出 = 编辑器「导出 JSON」（页面组装 SquadTemplateJson）。
 */
import type { SquadExecutionMode, SquadMode, SquadToolProfile } from '@/types/core'
import type { SquadMemberInput } from '@/core/mapper/squad-mapper'
import researchTpl from '@/assets/squad-templates/research-squad.json?raw'
import dataPipelineTpl from '@/assets/squad-templates/data-pipeline-squad.json?raw'
import fullstackTpl from '@/assets/squad-templates/fullstack-delivery-squad.json?raw'

/* ------------------------------------------------------------------ *
 * 内置角色包（§4.2 首发五个预设）
 * ------------------------------------------------------------------ */

export type SquadRolePresetId = 'RESEARCHER' | 'WORKER' | 'CRITIC' | 'INTEGRATOR' | 'MODERATOR'

export interface SquadRolePreset {
  id: SquadRolePresetId
  label: string
  /** 一键套用时写入成员 personaOverride（注入 system_prompt 末尾）。 */
  personaTemplate: string
  /** undefined = inherit 不裁剪（WORKER 全量工具面）。 */
  toolProfile?: SquadToolProfile
  /** §4.2 期望产出维度（本批仅展示，不落库）。 */
  expectedOutput: 'artifact' | 'review' | 'decision' | 'summary'
}

export const SQUAD_ROLE_PRESETS: SquadRolePreset[] = [
  {
    id: 'RESEARCHER',
    label: '调研员 RESEARCHER',
    personaTemplate:
      '你是调研专家，擅长资料检索、信息比对与来源交叉验证。产出为结构化调研笔记（含来源引用），不臆测未经证实的信息。',
    toolProfile: { mode: 'denylist', families: ['execute', 'destructive'] },
    expectedOutput: 'artifact',
  },
  {
    id: 'WORKER',
    label: '执行员 WORKER',
    personaTemplate:
      '你是执行专家，负责把任务转化为可交付产物（代码/数据/文档），注重质量与完整性，产出真实落盘的文件。',
    expectedOutput: 'artifact',
  },
  {
    id: 'CRITIC',
    label: '评审员 CRITIC',
    personaTemplate:
      '你是评审专家，负责挑刺与风险识别：只评审、不修改工作区（你的工具面已裁掉全部写路径与删移路径）。给出具体、可执行的修改意见与风险清单。',
    toolProfile: { mode: 'denylist', families: ['write', 'destructive'] },
    expectedOutput: 'review',
  },
  {
    id: 'INTEGRATOR',
    label: '整合交付 INTEGRATOR',
    personaTemplate:
      '你是整合交付专家，负责把各成员产出汇总、去重、对齐为最终交付物，保证口径一致、结构完整、可直接验收。',
    toolProfile: { mode: 'denylist', families: ['destructive'] },
    expectedOutput: 'artifact',
  },
  {
    id: 'MODERATOR',
    label: '主持人 MODERATOR',
    personaTemplate:
      '你是圆桌讨论主持人，负责推进讨论聚焦议题、归纳共识与分歧、控制节奏；不执行具体生产任务。',
    toolProfile: { mode: 'allowlist', families: ['read', 'network'] },
    expectedOutput: 'decision',
  },
]

/** 深拷贝预设工具面（避免多个成员共享同一对象引用）。 */
function cloneToolProfile(tp?: SquadToolProfile): SquadToolProfile | undefined {
  if (!tp) return undefined
  return {
    ...tp,
    nativeTools: tp.nativeTools ? [...tp.nativeTools] : undefined,
    mcpTools: tp.mcpTools ? [...tp.mcpTools] : undefined,
    families: tp.families ? [...tp.families] : undefined,
    skillIds: tp.skillIds ? [...tp.skillIds] : undefined,
  }
}

/** 编辑器「成员行一键套用角色」：只落 toolProfile + persona 两维（§4.2）。 */
export function applyRolePreset(
  preset: SquadRolePreset,
): Pick<SquadMemberInput, 'role' | 'personaOverride' | 'toolProfile'> {
  return {
    role: preset.id,
    personaOverride: preset.personaTemplate,
    toolProfile: cloneToolProfile(preset.toolProfile),
  }
}

/* ------------------------------------------------------------------ *
 * 官方编队模板（§12）
 * ------------------------------------------------------------------ */

export interface SquadTemplateMemberJson {
  /** 引用内置角色预设：导入时解析出 role/persona/toolProfile（可被下列字段覆盖/追加）。 */
  rolePreset?: SquadRolePresetId
  /** 自定义角色名（缺省用预设 id）。 */
  role?: string
  /** 有 rolePreset 时 = 追加到预设人设之后的工序补充；无 rolePreset 时 = 完整人设。 */
  personaOverride?: string
  /** 覆盖预设工具面。 */
  toolProfile?: SquadToolProfile
  pipelineOrder?: number | null
  dependsOn?: string[]
  isLeader?: boolean
}

export interface SquadTemplateJson {
  templateId: string
  name: string
  description?: string
  mode: SquadMode
  chatConfig?: { maxRounds?: number; executeActions?: boolean }
  runStrategy?: {
    executionMode?: SquadExecutionMode
    retryCount?: number
    schedulePrompt?: string | null
  }
  members: SquadTemplateMemberJson[]
}

function parseTemplate(raw: string): SquadTemplateJson {
  return JSON.parse(raw) as SquadTemplateJson
}

/** 内置官方模板（§12 首发三个）。 */
export const SQUAD_TEMPLATES: SquadTemplateJson[] = [
  parseTemplate(researchTpl),
  parseTemplate(dataPipelineTpl),
  parseTemplate(fullstackTpl),
]

/**
 * 模板成员 → 编辑器成员输入（agentId 留空由用户选择）。
 * 有 rolePreset 时：role=预设 id（可被 role 覆盖）、persona=预设人设+追加、toolProfile=预设（可覆盖）。
 */
export function resolveTemplateMember(m: SquadTemplateMemberJson): SquadMemberInput {
  const preset = m.rolePreset ? SQUAD_ROLE_PRESETS.find((p) => p.id === m.rolePreset) : undefined
  const basePersona = preset ? preset.personaTemplate : ''
  const persona = m.personaOverride
    ? preset
      ? `${basePersona}\n${m.personaOverride}`
      : m.personaOverride
    : basePersona
  return {
    agentId: '',
    role: m.role ?? preset?.id ?? '',
    personaOverride: persona || '',
    toolProfile: m.toolProfile ? cloneToolProfile(m.toolProfile) : cloneToolProfile(preset?.toolProfile),
    pipelineOrder: m.pipelineOrder ?? null,
    dependsOn: m.dependsOn ? [...m.dependsOn] : [],
    isLeader: m.isLeader ?? false,
  }
}
