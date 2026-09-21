/**
 * 知识库目录落盘助手（Tauri 2 / @tauri-apps/plugin-fs）。
 *
 * 设计对齐 skillFs：创建知识库时在 knowledge_base_path 下生成
 *   <identifier>/
 *     ...（用户自行放入的文档 / 子目录）
 * 知识库以 identifier（唯一标识 slug）作为磁盘目录名，与用户 PostgreSQL 设计一致
 *（$APPDATA/.knowledge_base/<identifier>/）；identifier 稳定不变，改名时同步 rename 目录。
 *
 * 约定：
 *  - 本文件的「folder」参数均为**完整原始路径**（如 $APPDATA/.knowledge_base/<identifier>），
 *    内部统一经 resolveRealKnowledgeBasePath 解析 $APPDATA / $RESOURCE 占位；
 *  - 非 Tauri 环境（浏览器 dev）不真实写盘，调用方据此跳过/给出提示；
 *  - walkKbAssets：递归扫描目录收集文件元数据（type 大类 / file_ext / file_size / file_path），
 *    供 knowledge-mapper 写入 knowledge_asset。
 */
import { isTauri } from '@/core/config'
import { fe } from '@/core/logBridge'
import { appDataDir, resourceDir, join } from '@tauri-apps/api/path'
import {
  mkdir,
  writeTextFile,
  writeFile,
  readFile,
  rename,
  remove,
  readDir,
  stat,
} from '@tauri-apps/plugin-fs'

/** 解析 knowledge_base_path 中的 $APPDATA / $RESOURCE 占位为真实目录。 */
export async function resolveRealKnowledgeBasePath(rawFolder: string): Promise<string> {
  if (!isTauri) return rawFolder
  let base = rawFolder.trim()
  if (base.includes('$APPDATA')) {
    base = base.replace('$APPDATA', await appDataDir())
  } else if (base.includes('$RESOURCE')) {
    base = base.replace('$RESOURCE', await resourceDir())
  }
  return base
}

/** 创建知识库目录骨架（递归）。folder 为完整原始路径。 */
export async function ensureKbDir(folder: string): Promise<string> {
  if (!isTauri) return folder
  const dir = await resolveRealKnowledgeBasePath(folder)
  await mkdir(dir, { recursive: true })
  return dir
}

/** 重命名知识库目录（identifier 改名时同步物理目录）。非 Tauri 静默。 */
export async function renameKbDir(oldFolder: string, newFolder: string): Promise<void> {
  if (!isTauri) return
  const from = await resolveRealKnowledgeBasePath(oldFolder)
  const to = await resolveRealKnowledgeBasePath(newFolder)
  if (from === to) return
  await rename(from, to)
}

function extOf(name: string): string | null {
  const i = name.lastIndexOf('.')
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : null
}

/** 资产大类（1-文档 2-图片 3-音频 4-视频 5-网页），按扩展名判定。 */
export function assetTypeFromExt(ext: string | null): 1 | 2 | 3 | 4 | 5 {
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'bmp':
    case 'ico':
    case 'avif':
      return 2
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'oga':
    case 'flac':
    case 'aac':
    case 'm4a':
      return 3
    case 'mp4':
    case 'webm':
    case 'ogv':
    case 'mov':
    case 'mkv':
    case 'avi':
      return 4
    case 'html':
    case 'htm':
    case 'xhtml':
    case 'url':
      return 5
    default:
      return 1
  }
}

/** 目录树节点（用于详情页展示知识库根目录下的全部文件结构）。 */
export interface KbFileTreeNode {
  /** 文件 / 目录名 */
  name: string
  /** 相对知识库根目录的路径（不含根目录名），根节点为空串 */
  relPath: string
  isDir: boolean
  children: KbFileTreeNode[]
}

/**
 * 递归读取知识库根目录的文件树（目录优先、同类型按名称排序）。
 * 非 Tauri 或路径不可读返回 null（由 UI 回退空提示）。
 */
export async function readKbFileTree(folder: string): Promise<KbFileTreeNode | null> {
  if (!isTauri) return null
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const root: KbFileTreeNode = {
      name: folder.split('/').pop() || folder,
      relPath: '',
      isDir: true,
      children: [],
    }
    const walk = async (d: string, parent: KbFileTreeNode, relBase: string): Promise<void> => {
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
        const node: KbFileTreeNode = {
          name: e.name,
          relPath: rel,
          isDir: !!e.isDirectory,
          children: [],
        }
        parent.children.push(node)
        if (e.isDirectory) await walk(await join(d, e.name), node, rel)
      }
    }
    await walk(base, root, '')
    return root
  } catch {
    return null
  }
}

/** 单个知识库文件的字节内容（供详情页查看文件内容用）。 */
export interface KbFileContent {
  /** 相对知识库根目录的路径 */
  relPath: string
  /** 文件名（basename） */
  name: string
  /** 原始字节 */
  data: Uint8Array
}

/**
 * 读取知识库目录下某个文件的字节内容。
 * relPath 为相对知识库根目录的路径（与 readKbFileTree 的 KbFileTreeNode.relPath 一致）。
 * 读取失败（文件不存在 / 非 Tauri）返回 null。
 */
export async function readKbFileContent(
  folder: string,
  relPath: string,
): Promise<KbFileContent | null> {
  if (!isTauri) return null
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const target = await join(base, relPath)
    const data = (await readFile(target)) as Uint8Array
    return { relPath, name: relPath.split('/').pop() || relPath, data }
  } catch {
    return null
  }
}

/** 写盘操作统一返回结构：ok 表示成功，error 携带失败原因（含非 Tauri 回退）。 */
export interface KbOpResult {
  ok: boolean
  error?: string
}

/**
 * 覆盖写入某个文件的文本内容（详情页「就地编辑文件」用）。
 * 成功返回 {ok:true}；非 Tauri / 写入失败返回 {ok:false, error}。
 */
export async function writeKbFileContent(
  folder: string,
  relPath: string,
  content: string,
): Promise<KbOpResult> {
  if (!isTauri) return { ok: false, error: '当前环境不支持写盘' }
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const target = await join(base, relPath)
    await mkdir(await dirname(target), { recursive: true })
    await writeTextFile(target, content)
    fe.info('kbFs', `writeKbFileContent ok relPath=${relPath} bytes=${content.length}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kbFs', `writeKbFileContent fail relPath=${relPath} err=${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * 写入二进制文件（详情页「导入文件」用）。
 * 成功返回 true；非 Tauri / 写入失败返回 false。
 */
export async function writeKbFileBinary(
  folder: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<KbOpResult> {
  if (!isTauri) return { ok: false, error: '当前环境不支持写盘' }
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const target = await join(base, relPath)
    await mkdir(await dirname(target), { recursive: true })
    await writeFile(target, bytes)
    fe.info('kbFs', `writeKbFileBinary ok relPath=${relPath} bytes=${bytes.byteLength}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kbFs', `writeKbFileBinary fail relPath=${relPath} err=${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * 在知识库目录下新建文件夹（relPath 为相对根目录的目录路径，如 'sub' 或 'a/b'）。
 * 成功返回 true；非 Tauri / 失败返回 false。
 */
export async function createKbFolder(folder: string, relPath: string): Promise<KbOpResult> {
  if (!isTauri) return { ok: false, error: '当前环境不支持写盘' }
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const target = await join(base, relPath)
    await mkdir(target, { recursive: true })
    fe.info('kbFs', `createKbFolder ok relPath=${relPath}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kbFs', `createKbFolder fail relPath=${relPath} err=${msg}`)
    return { ok: false, error: msg }
  }
}

/** 删除知识库目录（删除知识库时同步清理磁盘）。非 Tauri 或已不存在则静默。 */
export async function removeKbDir(folder: string): Promise<void> {
  if (!isTauri) return
  const dir = await resolveRealKnowledgeBasePath(folder)
  await remove(dir, { recursive: true })
  fe.info('kbFs', `removeKbDir ok folder=${folder}`)
}

/**
 * 删除知识库目录下的某个条目（文件或子目录，relPath 为相对根目录的路径）。
 * 目录递归删除；成功返回 true；非 Tauri / 删除失败返回 false。
 */
export async function deleteKbEntry(folder: string, relPath: string): Promise<KbOpResult> {
  if (!isTauri) return { ok: false, error: '当前环境不支持写盘' }
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const target = await join(base, relPath)
    await remove(target, { recursive: true })
    fe.info('kbFs', `deleteKbEntry ok relPath=${relPath}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kbFs', `deleteKbEntry fail relPath=${relPath} err=${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * 移动知识库目录下的条目（文件或子目录）到目标目录（relPath 为相对根目录的路径）。
 * 通过 rename 实现；成功返回 true；非 Tauri / 失败返回 false。
 * 调用方需自行保证 toDirRel 不是 fromRel 自身或其后代目录（本函数不校验，避免静默吞掉）。
 */
export async function moveKbEntry(
  folder: string,
  fromRel: string,
  toDirRel: string,
): Promise<KbOpResult> {
  if (!isTauri) return { ok: false, error: '当前环境不支持写盘' }
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const name = fromRel.split('/').pop() || fromRel
    const destRel = toDirRel ? `${toDirRel}/${name}` : name
    const from = await join(base, fromRel)
    const to = await join(base, destRel)
    await rename(from, to)
    fe.info('kbFs', `moveKbEntry ok fromRel=${fromRel} toRel=${destRel}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kbFs', `moveKbEntry fail fromRel=${fromRel} err=${msg}`)
    return { ok: false, error: msg }
  }
}

/** 单文件资产元数据（用于写入 knowledge_asset）。 */
export interface KbAssetScan {
  name: string
  /** 相对知识库根目录的路径（如 'docs/a.txt'） */
  filePath: string
  /** 扩展名（不含点、小写） */
  fileExt: string | null
  /** 文件字节数 */
  sizeBytes: number
  /** 资产大类（1-文档 2-图片 3-音频 4-视频 5-网页） */
  type: 1 | 2 | 3 | 4 | 5
}

/**
 * 递归扫描知识库目录下全部文件，返回资产元数据（含大小与大类）。
 * 非 Tauri 或目录不可读返回空数组。
 */
export async function walkKbAssets(folder: string): Promise<KbAssetScan[]> {
  if (!isTauri) return []
  const out: KbAssetScan[] = []
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
    const walk = async (d: string, relBase: string): Promise<void> => {
      let entries
      try {
        entries = await readDir(d)
      } catch {
        return
      }
      for (const e of entries) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name
        const full = await join(d, e.name)
        if (e.isDirectory) {
          await walk(full, rel)
        } else {
          const ext = extOf(e.name)
          let size = 0
          try {
            size = (await stat(full)).size
          } catch {
            /* stat 失败（部分平台/权限场景）则走兜底 */
          }
          // 兜底：stat 取不到大小时，直接读取文件字节长度，杜绝 file_size 记 0
          if (!size) {
            try {
              size = (await readFile(full)).byteLength
            } catch {
              /* 读取失败则记 0 */
            }
          }
          out.push({ name: e.name, filePath: rel, fileExt: ext, sizeBytes: size, type: assetTypeFromExt(ext) })
        }
      }
    }
    await walk(base, '')
  } catch {
    /* 目录不存在等，返回已收集的部分 */
  }
  fe.info('kbFs', `walkKbAssets done folder=${folder} count=${out.length}`)
  return out
}

/**
 * 把知识库目录打包为 ZIP（Uint8Array），供「导出知识库」使用。
 * 非 Tauri 或读取失败返回 null。
 */
export async function zipKbDir(folder: string): Promise<Uint8Array | null> {
  if (!isTauri) return null
  try {
    const base = await resolveRealKnowledgeBasePath(folder)
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
    await walk(base, '')
    return await zip.generateAsync({ type: 'uint8array' })
  } catch {
    return null
  }
}

/** 取文件所在目录路径（与 node path.dirname 等价，避免额外依赖）。 */
async function dirname(p: string): Promise<string> {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i < 0 ? '' : norm.slice(0, i)
}
