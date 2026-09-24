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
import { appDataDir, resourceDir, join, dirname } from '@tauri-apps/api/path'
import { mkdir, writeTextFile, writeFile, remove, readFile, readDir } from '@tauri-apps/plugin-fs'
import {
  SKILL_SUBDIRS,
  withLangExt,
  type ResourceFile,
  type ScriptFile,
  type SkillInfo,
} from './skill-file'
import { resolveSkillBasePath } from '@/core/mapper/skill-mapper'

/** 头像支持的扩展名（固定前缀 logo，落盘于技能根目录）。 */
export const LOGO_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']

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

/**
 * 解析技能目录的绝对路径（最终把占位符解析为真实目录）。
 *
 * 优先使用 DB 记录的 skill.path（技能本地物理路径，可能含 $APPDATA/$RESOURCE 占位），
 * 它是落盘时写入的权威路径；仅在缺失时按约定用 skill_path 配置 + identifier 拼接兜底。
 * 编辑态回显头像 / 脚本 / 资源时必须走这里，才能正确处理「用户改过存储路径」或
 * 「导入技能 path 与当前 base 不一致」的情况。
 */
async function resolveSkillDir(
  identifier: string,
  skillPath?: string | null,
): Promise<string> {
  const raw =
    skillPath && skillPath.trim()
      ? skillPath
      : `${await resolveSkillBasePath()}/${identifier}`
  return resolveRealSkillBasePath(raw)
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
  // 确保 scripts 父目录存在（自定义目录也能写）
  await mkdir(await join(dir, 'scripts'), { recursive: true })
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
  // 关键：确保目标父目录存在（导入技能可能含任意子目录，如 hooks/tests/references/sub），
  // 否则在写入嵌套文件时会因父目录不存在而报 os error 3。
  const parent = subDir ? await join(dir, subDir) : dir
  await mkdir(parent, { recursive: true })
  const target = subDir ? await join(dir, subDir, name) : await join(dir, name)
  await writeFile(target, data)
}

/** Uint8Array -> base64（分块避免大文件调用栈溢出）。 */
export function uint8ToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/**
 * 读取技能头像（固定为技能根目录下的 logo.<ext>）。
 * 依次尝试 LOGO_EXTS，找到即返回 data URL；都不存在或出错返回 null（由 UI 回退为名称首字）。
 */
export async function readSkillLogoBase64(
  identifier: string,
  skillPath?: string | null,
): Promise<string | null> {
  if (!isTauri) return null
  try {
    const dir = await resolveSkillDir(identifier, skillPath)
    for (const ext of LOGO_EXTS) {
      try {
        const data = (await readFile(await join(dir, `logo.${ext}`))) as Uint8Array
        const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
        return `data:image/${mime};base64,${uint8ToBase64(data)}`
      } catch {
        /* 尝试下一个扩展名 */
      }
    }
  } catch {
    /* 路径解析失败等，统一回退 */
  }
  return null
}

/**
 * 删除技能根目录下所有 logo.<ext> 头像文件。
 * 用于：用户移除头像、或上传新头像前清理旧扩展名文件，避免磁盘残留导致回显混乱。
 * 非 Tauri 或文件不存在则静默。
 */
export async function removeSkillLogos(
  identifier: string,
  skillPath?: string | null,
): Promise<void> {
  if (!isTauri) return
  try {
    const dir = await resolveSkillDir(identifier, skillPath)
    for (const ext of LOGO_EXTS) {
      try {
        await remove(await join(dir, `logo.${ext}`))
      } catch {
        /* 文件不存在或删除失败，继续尝试下一个扩展名 */
      }
    }
  } catch {
    /* 路径解析失败等，统一静默 */
  }
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

/** 目录树节点（用于编辑/详情页展示技能根目录下的全部文件结构）。 */
export interface SkillFileTreeNode {
  /** 文件 / 目录名 */
  name: string
  /** 相对技能根目录的路径（不含根目录名），根节点为空串 */
  relPath: string
  isDir: boolean
  children: SkillFileTreeNode[]
}

/**
 * 递归读取技能根目录的文件树（目录优先、同类型按名称排序）。
 * 非 Tauri 或路径不可读返回 null（由 UI 回退空提示）。
 */
export async function readSkillFileTree(
  identifier: string,
  skillPath?: string | null,
): Promise<SkillFileTreeNode | null> {
  if (!isTauri) return null
  try {
    const dir = await resolveSkillDir(identifier, skillPath)
    const root: SkillFileTreeNode = {
      name: identifier,
      relPath: '',
      isDir: true,
      children: [],
    }
    const walk = async (
      d: string,
      parent: SkillFileTreeNode,
      relBase: string,
    ): Promise<void> => {
      let entries
      try {
        entries = await readDir(d)
      } catch {
        return
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name
        const node: SkillFileTreeNode = {
          name: e.name,
          relPath: rel,
          isDir: !!e.isDirectory,
          children: [],
        }
        parent.children.push(node)
        if (e.isDirectory) await walk(await join(d, e.name), node, rel)
      }
    }
    await walk(dir, root, '')
    return root
  } catch {
    return null
  }
}

/** 技能目录下的单个扁平文件（相对技能根目录的路径 + 原始字节）。 */
export interface SkillFlatFile {
  /** 相对技能根目录的路径（不含根目录名），如 scripts/main.py / references/a.md */
  relPath: string
  /** 原始字节 */
  data: Uint8Array
}

/**
 * 递归读取技能根目录下的全部文件（扁平列表，含相对路径与字节内容）。
 * 用于「编辑技能」时把磁盘上已落盘的脚本 / 资源 / 头像 / SKILL.md 回显到表单。
 * 非 Tauri 或路径不可读返回 null（由 UI 回退为空白表单）。
 */
export async function readSkillDirFlat(
  identifier: string,
  skillPath?: string | null,
): Promise<SkillFlatFile[] | null> {
  if (!isTauri) return null
  try {
    const dir = await resolveSkillDir(identifier, skillPath)
    const out: SkillFlatFile[] = []
    const walk = async (d: string, relBase: string): Promise<void> => {
      let entries
      try {
        entries = await readDir(d)
      } catch {
        return
      }
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name
        if (e.isDirectory) {
          await walk(await join(d, e.name), rel)
        } else {
          const data = (await readFile(await join(d, e.name))) as Uint8Array
          out.push({ relPath: rel, data })
        }
      }
    }
    await walk(dir, '')
    return out
  } catch {
    return null
  }
}

/** 单个技能文件的字节内容（供详情页查看文件内容用）。 */
export interface SkillFileContent {
  /** 相对技能根目录的路径 */
  relPath: string
  /** 文件名（basename） */
  name: string
  /** 原始字节 */
  data: Uint8Array
}

/**
 * 读取技能目录下某个文件的字节内容（详情页「点击文件查看内容」用）。
 * relPath 为相对技能根目录的路径（与 readSkillFileTree 的 SkillFileTreeNode.relPath 一致）。
 * 读取失败（文件不存在 / 非 Tauri）返回 null。
 */
export async function readSkillFileContent(
  identifier: string,
  relPath: string,
  skillPath?: string | null,
): Promise<SkillFileContent | null> {
  if (!isTauri) return null
  try {
    assertSafeRelPath(relPath)
    const dir = await resolveSkillDir(identifier, skillPath)
    const target = await join(dir, relPath)
    const data = (await readFile(target)) as Uint8Array
    return { relPath, name: relPath.split('/').pop() || relPath, data }
  } catch {
    return null
  }
}

/**
 * 校验 relPath 不逃逸技能根目录（SK-3 防护：禁 .. 穿越 / 绝对路径 / 盘符 / 反斜杠写法）。
 * 非法直接抛错，由调用方转为失败提示；正常相对路径（scripts/x.py、notes/README.md）不受影响。
 */
function assertSafeRelPath(relPath: string): void {
  const norm = relPath.replace(/\\/g, '/')
  const segs = norm.split('/')
  if (
    !norm ||
    norm.startsWith('/') ||
    segs.some((s) => s === '..' || s === '') ||
    segs.some((s) => /^[a-zA-Z]:/.test(s))
  ) {
    throw new Error(`skill: 非法相对路径 ${relPath}`)
  }
}

/**
 * 覆盖写入技能目录下某个文件的文本内容（详情页「就地编辑文件」用）。
 * 父目录不存在时递归创建（如 references/、notes/ 等新子目录——SKILL 布局允许）。
 * 成功返回 true；非 Tauri / 写入失败返回 false（由调用方提示）。
 */
export async function writeSkillFileContent(
  identifier: string,
  relPath: string,
  content: string,
  skillPath?: string | null,
): Promise<boolean> {
  if (!isTauri) return false
  try {
    assertSafeRelPath(relPath)
    const dir = await resolveSkillDir(identifier, skillPath)
    const target = await join(dir, relPath)
    await mkdir(await dirname(target), { recursive: true })
    await writeTextFile(target, content)
    return true
  } catch {
    return false
  }
}

/**
 * 把技能根目录打包为 ZIP（Uint8Array），供「导出技能」使用。
 * 目录内文件以相对技能根目录的路径写入压缩包（不含技能根目录名本身），
 * 与导入时「按公共顶层目录剥离」的逻辑一致，便于再次导入还原。
 * 非 Tauri 或读取失败返回 null（由调用方提示）。
 */
export async function zipSkillDir(
  identifier: string,
  skillPath?: string | null,
): Promise<Uint8Array | null> {
  if (!isTauri) return null
  try {
    const dir = await resolveSkillDir(identifier, skillPath)
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    const walk = async (d: string, relBase: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof readDir>>
      try {
        entries = await readDir(d)
      } catch {
        return
      }
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name
        if (e.isDirectory) {
          await walk(await join(d, e.name), rel)
        } else {
          const data = (await readFile(await join(d, e.name))) as Uint8Array
          zip.file(rel, data)
        }
      }
    }
    await walk(dir, '')
    return await zip.generateAsync({ type: 'uint8array' })
  } catch {
    return null
  }
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
