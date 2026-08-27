/**
 * 技能能力单元 —— 领域类型 / 运行期选项 / 草稿工厂 / 导入解析。
 *
 * 说明：持久化由 `src/core/mapper/skill-mapper.ts` 负责（SQLite：workduo.db）。
 * 这里只保留与 UI / 表单无关的纯领域定义，供页面、组件与 mapper 复用。
 */
import type { SkillCategory } from '@/types/core'

/* ------------------------------------------------------------------ *
 * 1. 领域模型（运行时使用）
 * ------------------------------------------------------------------ */

export interface SkillInfo {
  id: string // 本地 UUID（文本主键）
  identifier: string // 唯一标识 slug，如 doc-polish
  name: string // 展示名
  description?: string
  /** 技能正文（SKILL.md 内容，Markdown 兼容） */
  instruction?: string
  tags?: string[]
  scenario?: SkillCategory // 技能分类 key
  /** 本地存储目录（app_config.skill_path + '/' + identifier） */
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

/* ------------------------------------------------------------------ *
 * 3. 草稿工厂
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
    tags: [],
    scenario: undefined,
    path: undefined,
    createdAt: now,
    updatedAt: now,
  }
}

/* ------------------------------------------------------------------ *
 * 4. 导入解析（JSON -> SkillInfo[]）
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
    const now = new Date().toISOString()
    skills.push({
      id: typeof obj.id === 'string' && obj.id ? obj.id : crypto.randomUUID(),
      identifier,
      name: typeof obj.name === 'string' ? obj.name : identifier,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      instruction: typeof obj.instruction === 'string' ? obj.instruction : undefined,
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
      scenario,
      path: typeof obj.path === 'string' ? obj.path : undefined,
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : now,
    })
  })

  return { skills, errors, total: arr.length }
}
