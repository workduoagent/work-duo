/**
 * 技能能力单元 —— 领域类型 / 运行期选项 / 草稿工厂 / 导入解析。
 *
 * 说明：持久化由 `src/core/mapper/skill-mapper.ts` 负责（SQLite：workduo.db）。
 * 这里只保留与 UI / 表单无关的纯领域定义，供页面、组件与 mapper 复用。
 *
 * 关键约定（与用户设计对齐）：
 *  - `instruction`（指令内容）与 `skillMarkdown`（SKILL.md 正文）是两个**独立字段**，
 *    绝不可混为一谈：前者是技能级的指令/工作流描述，后者是落盘到磁盘的 SKILL.md 文件内容；
 *  - 创建技能时会在 skill_path 下生成 `<identifier>/` 目录，内含 scripts / references /
 *    assets / templates 子目录与 SKILL.md 文件（见 src/core/file/skillFs.ts）。
 */
import type { SkillCategory } from '@/types/core'

/* ------------------------------------------------------------------ *
 * 1. 领域模型（运行时使用）
 * ------------------------------------------------------------------ */

/** 技能可见域（对应 nexus-web 的 scope）。 */
export type SkillScope = 'PUBLIC' | 'PRIVATE'

export interface SkillInfo {
  id: string // 本地 UUID（文本主键）
  identifier: string // 唯一标识 slug，如 doc-polish（同时是磁盘目录名）
  name: string // 展示名
  description?: string
  /** 指令内容：技能级指令 / 工作流描述（与 SKILL.md 是不同字段）。 */
  instruction?: string
  /** SKILL.md 正文：落盘到 <identifier>/SKILL.md 的内容（与 instruction 不同字段）。 */
  skillMarkdown?: string
  tags?: string[]
  scenario?: SkillCategory // 技能分类 key
  /** 可见域：PUBLIC / PRIVATE。 */
  scope?: SkillScope
  /** 版本号，如 v1.0.0。 */
  version?: string
  /** 启用状态：1 启用 / 0 禁用（卡片右上角 Switch 控制）。 */
  status?: number
  /** 本地存储目录（app_config.skill_path + '/' + identifier，可能含 $APPDATA/$RESOURCE 占位）。 */
  path?: string
  createdAt: string // ISO 时间字符串（与 SQLite 的 epoch 毫秒在 mapper 层互转）
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * 2. 运行期选项（枚举文案在此，而非 core.d.ts）
 * ------------------------------------------------------------------ */

/** 技能分类下拉选项（value = SkillCategory，label = 展示文案）。 */
export const SKILL_CATEGORY_OPTIONS = [
  { value: 'pay-skill', label: 'Pay Skill' },
  { value: 'office-efficiency', label: '办公效率' },
  { value: 'content-creation', label: '内容创作' },
  { value: 'dev-programming', label: '开发编程' },
  { value: 'data-analysis', label: '数据分析' },
  { value: 'design-media', label: '设计多媒体' },
  { value: 'ai-agent', label: 'AI Agent' },
  { value: 'knowledge-management', label: '知识管理' },
  { value: 'business-ops', label: '商业运营' },
  { value: 'education', label: '教育学习' },
  { value: 'professional', label: '行业专业' },
  { value: 'it-ops-security', label: 'IT 运维与安全' },
  { value: 'life-service', label: '生活服务' },
] as const

const CATEGORY_LABEL_MAP: Record<string, string> = Object.fromEntries(
  SKILL_CATEGORY_OPTIONS.map((o) => [o.value, o.label]),
)

/** scenario key -> 展示文案；空值返回「未分类」。 */
export function getSkillCategoryLabel(
  scenario?: SkillCategory | string | null,
): string {
  if (!scenario) return '未分类'
  return CATEGORY_LABEL_MAP[scenario] ?? scenario
}

/** 可见域下拉选项。 */
export const SKILL_SCOPE_OPTIONS = [
  { value: 'PUBLIC', label: '公开 (PUBLIC)' },
  { value: 'PRIVATE', label: '私有 (PRIVATE)' },
] as const

/* ------------------------------------------------------------------ *
 * 3. 脚本 / 资源文件（表单内编辑，落盘到技能目录）
 * ------------------------------------------------------------------ */

/** 表单内可编辑的脚本文件（落盘到 <identifier>/scripts/）。 */
export interface ScriptFile {
  id: string
  name: string // 文件名（可含扩展名，缺省按语言补）
  language: string // 语言 key（见 SCRIPT_LANGUAGE_OPTIONS）
  content: string
}

/** 表单内可上传的任意资源文件（落盘到 <identifier>/<dir>/）。 */
export interface ResourceFile {
  id: string
  name: string
  dir: string // 目标子目录：'' / scripts / references / assets / templates / 自定义
  data: Uint8Array // 文件二进制内容
}

/** 技能目录下的标准子目录（创建时一并生成骨架）。 */
export const SKILL_SUBDIRS = [
  'scripts',
  'references',
  'assets',
  'templates',
] as const

/** 表单完整提交载荷：基础元数据 + 脚本文件 + 资源文件（落盘用）。 */
export interface SkillFormData {
  skill: SkillInfo
  scripts: ScriptFile[]
  resources: ResourceFile[]
}

/** 可编写脚本的语言选项（用户可在表单内选择，用于 code-editor 高亮 + 落盘扩展名）。 */
export const SCRIPT_LANGUAGE_OPTIONS = [
  { value: 'python', label: 'Python', ext: 'py' },
  { value: 'javascript', label: 'Node.js (JavaScript)', ext: 'js' },
  { value: 'typescript', label: 'TypeScript', ext: 'ts' },
  { value: 'bash', label: 'Shell / Bash', ext: 'sh' },
  { value: 'go', label: 'Go', ext: 'go' },
  { value: 'rust', label: 'Rust', ext: 'rs' },
  { value: 'java', label: 'Java', ext: 'java' },
  { value: 'ruby', label: 'Ruby', ext: 'rb' },
  { value: 'powershell', label: 'PowerShell', ext: 'ps1' },
  { value: 'lua', label: 'Lua', ext: 'lua' },
] as const

/** 语言 key -> 扩展名。 */
export function langExt(language: string): string {
  const hit = SCRIPT_LANGUAGE_OPTIONS.find((o) => o.value === language)
  return hit?.ext ?? 'txt'
}

/** 给脚本文件名补上语言对应的扩展名（若缺失）。 */
export function withLangExt(name: string, language: string): string {
  const ext = langExt(language)
  if (name.toLowerCase().endsWith(`.${ext}`)) return name
  return `${name.replace(/\.+$/, '')}.${ext}`
}

/* ------------------------------------------------------------------ *
 * 4. 草稿工厂
 * ------------------------------------------------------------------ */

/** 创建一个空白技能草稿（用于「新建」）。 */
export function createEmptySkill(): SkillInfo {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    identifier: '',
    name: '',
    description: '',
    instruction: '',
    skillMarkdown: '',
    tags: [],
    scenario: undefined,
    scope: 'PUBLIC',
    version: 'v1.0.0',
    status: 1,
    path: undefined,
    createdAt: now,
    updatedAt: now,
  }
}

/* ------------------------------------------------------------------ *
 * 5. 导入解析（JSON -> SkillInfo[]）
 * ------------------------------------------------------------------ */

export interface SkillImportResult {
  /** 校验通过、可入库的技能列表 */
  skills: SkillInfo[]
  /** 校验失败的原因（逐项） */
  errors: string[]
  /** 总条目数（含非法项） */
  total: number
}

/**
 * 解析导入的 JSON 文本，归一化为 SkillInfo[] 并做基础校验。
 * 兼容「单个对象」或「对象数组」；缺失字段用默认值补齐。
 */
export function parseSkillImport(text: string): SkillImportResult {
  const errors: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { skills: [], errors: [`JSON 解析失败：${(e as Error).message}`], total: 0 }
  }

  const arr = Array.isArray(data) ? data : [data]
  const skills: SkillInfo[] = []

  arr.forEach((item, i) => {
    const idx = i + 1
    if (typeof item !== 'object' || item === null) {
      errors.push(`第 ${idx} 项不是对象，已跳过`)
      return
    }
    const obj = item as Record<string, unknown>
    const identifier = typeof obj.identifier === 'string' ? obj.identifier.trim() : ''
    if (!identifier) {
      errors.push(`第 ${idx} 项 identifier 为空，已跳过`)
      return
    }
    const scenarioRaw = obj.scenario as string | undefined
    const scenario = SKILL_CATEGORY_OPTIONS.some((o) => o.value === scenarioRaw)
      ? (scenarioRaw as SkillCategory)
      : undefined
    const scopeRaw = obj.scope as string | undefined
    const scope: SkillScope | undefined =
      scopeRaw === 'PUBLIC' || scopeRaw === 'PRIVATE' ? scopeRaw : undefined
    const now = new Date().toISOString()
    skills.push({
      id: typeof obj.id === 'string' && obj.id ? obj.id : crypto.randomUUID(),
      identifier,
      name: typeof obj.name === 'string' ? obj.name : identifier,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      instruction: typeof obj.instruction === 'string' ? obj.instruction : undefined,
      skillMarkdown: typeof obj.skillMarkdown === 'string' ? obj.skillMarkdown : undefined,
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
      scenario,
      scope,
      version: typeof obj.version === 'string' ? obj.version : 'v1.0.0',
      status: typeof obj.status === 'number' ? obj.status : 1,
      path: typeof obj.path === 'string' ? obj.path : undefined,
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : now,
    })
  })

  return { skills, errors, total: arr.length }
}
