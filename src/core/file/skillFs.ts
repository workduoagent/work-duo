/**
 * 技能目录落盘助手（Tauri 2 / @tauri-apps/plugin-fs）。
 *
 * 设计对齐用户要求：创建技能时在 skill_path 下生成
 *   <identifier>/
 *     scripts/
 *     references/
 *     assets/
 *     templates/
 *     SKILL.md
 * 其中 SKILL.md 来自表单的「SKILL.md 正文」字段（与 instruction 指令内容是不同字段）。
 *
 * 注意：
 *  - skill_path 在 app_config 中可能是占位字符串（$APPDATA / $RESOURCE），
 *    这里在真正落盘时解析为真实目录（appDataDir / resourceDir）；
 *  - 非 Tauri 环境（浏览器 dev）不真实写盘，调用方据此跳过/给出提示。
 */
import { isTauri } from '@/core/config'
import { appDataDir, resourceDir, join } from '@tauri-apps/api/path'
import { mkdir, writeTextFile, writeFile, remove } from '@tauri-apps/plugin-fs'
import {
  SKILL_SUBDIRS,
  withLangExt,
  type ResourceFile,
  type ScriptFile,
  type SkillInfo,
} from './skill-file'

/** 解析 skill_path 中的 $APPDATA / $RESOURCE 占位为真实目录。 */
export async function resolveRealSkillBasePath(rawBase: string): Promise<string> {
  if (!isTauri) return rawBase
  let base = rawBase.trim()
  if (base.includes('$APPDATA')) {
    base = base.replace('$APPDATA', await appDataDir())
  } else if (base.includes('$RESOURCE')) {
    base = base.replace('$RESOURCE', await resourceDir())
  }
  return base
}

/** 计算技能目录绝对路径 <base>/<identifier>。 */
export async function getSkillDir(
  basePath: string,
  identifier: string,
): Promise<string> {
  return join(basePath, identifier)
}

/**
 * 创建技能目录骨架：<base>/<identifier>/{scripts,references,assets,templates}。
 * 返回技能目录绝对路径。
 */
export async function ensureSkillDir(
  basePath: string,
  identifier: string,
): Promise<string> {
  if (!isTauri) return `${basePath}/${identifier}`
  const dir = await getSkillDir(basePath, identifier)
  await mkdir(dir, { recursive: true })
  for (const sub of SKILL_SUBDIRS) {
    await mkdir(await join(dir, sub), { recursive: true })
  }
  return dir
}

/** 写入 SKILL.md（落盘到 <identifier>/SKILL.md）。 */
export async function writeSkillMarkdown(
  dir: string,
  content: string,
): Promise<void> {
  if (!isTauri) return
  await writeTextFile(await join(dir, 'SKILL.md'), content ?? '')
}

/** 写入脚本文件（落盘到 <identifier>/scripts/<name>）。 */
export async function writeScript(
  dir: string,
  name: string,
  language: string,
  content: string,
): Promise<void> {
  if (!isTauri) return
  const fileName = withLangExt(name, language)
  await writeTextFile(await join(dir, 'scripts', fileName), content ?? '')
}

/** 写入任意资源文件（落盘到 <identifier>/<dir>/<name>，dir 为空则根目录）。 */
export async function writeResourceFile(
  dir: string,
  subDir: string,
  name: string,
  data: Uint8Array,
): Promise<void> {
  if (!isTauri) return
  const target = subDir
    ? await join(dir, subDir, name)
    : await join(dir, name)
  await writeFile(target, data)
}

/** 删除技能目录（删除技能时同步清理磁盘）。非 Tauri 或已不存在则静默。 */
export async function removeSkillDir(
  rawBase: string,
  identifier: string,
): Promise<void> {
  if (!isTauri) return
  const base = await resolveRealSkillBasePath(rawBase)
  const dir = await getSkillDir(base, identifier)
  await remove(dir, { recursive: true })
}

export interface SkillDiskResult {
  dir: string | null
  written: { skillMd: boolean; scripts: number; resources: number }
}

/**
 * 一键落盘：创建目录骨架 + 写 SKILL.md + 脚本 + 资源文件。
 * 非 Tauri 返回 null（不落盘）。已存在的同名文件会被覆盖（幂等）。
 */
export async function persistSkillFiles(
  rawBase: string,
  skill: SkillInfo,
  scripts: ScriptFile[],
  resources: ResourceFile[],
): Promise<SkillDiskResult | null> {
  if (!isTauri) return null
  const base = await resolveRealSkillBasePath(rawBase)
  const dir = await ensureSkillDir(base, skill.identifier)

  let skillMd = false
  if (skill.skillMarkdown != null && skill.skillMarkdown.length > 0) {
    await writeSkillMarkdown(dir, skill.skillMarkdown)
    skillMd = true
  }

  let scriptCount = 0
  for (const s of scripts) {
    if (!s.name.trim() && !s.content.trim()) continue
    await writeScript(dir, s.name, s.language, s.content)
    scriptCount++
  }

  let resCount = 0
  for (const r of resources) {
    if (!r.name.trim()) continue
    await writeResourceFile(dir, r.dir, r.name, r.data)
    resCount++
  }

  return { dir, written: { skillMd, scripts: scriptCount, resources: resCount } }
}
