/**
 * 沙箱环境（Node / Bun 运行时）数据访问层。
 *
 * 直接封装 Tauri invoke 调用 `bun_manager` 暴露的命令，并把 Rust 侧
 * `Result<String, String>` 统一转换为前端友好的 `{ ok, error?, data? }`，
 * 供页面用 `useNotify().result()` 统一提示。
 *
 * 与 Python 的 sandbox-mapper 同构；Node 仅有单一环境（default），故无「创建多环境」能力，
 * delete 由 Rust 侧直接拒绝（单一运行时不可删）。
 *
 * 注意：Rust 命令的 snake_case 入参在 JS 侧为 camelCase（如 `env_name`→`envName`）。
 */
import { invoke } from '@tauri-apps/api/core'

/** 单个 Node 运行环境的元信息（对应 Rust `EnvInfo`）。 */
export interface BunEnvInfo {
  name: string
  is_default: boolean
  exists: boolean
  bun_version: string | null
  package_count: number
}

/** 单个已安装依赖（对应 Rust `PackageInfo`）。 */
export interface PackageInfo {
  name: string
  version: string
}

/** 统一操作结果：成功含 data，失败含 error。 */
export interface OpResult {
  ok: boolean
  error?: string
  data?: string
}

/** 将 invoke 的 `Result<String, String>` 归一成 `OpResult`。 */
async function toResult(p: Promise<string>): Promise<OpResult> {
  try {
    const data = await p
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: fmtErr(e) }
  }
}

/** 把 Tauri 抛出的错误统一为可读字符串。 */
function fmtErr(e: unknown): string {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

/** 列出环境（仅 default 单一环境，含 Bun 版本与依赖数）。 */
export async function listEnvs(): Promise<BunEnvInfo[]> {
  return invoke<BunEnvInfo[]>('list_bun_envs')
}

/** 确保默认环境就绪（创建 bun_root + package.json + 空 node_modules）。 */
export function initEnv(): Promise<OpResult> {
  return toResult(invoke('init_bun_env'))
}

/** 查询已安装的依赖列表。 */
export async function listPackages(envName: string): Promise<PackageInfo[]> {
  return invoke<PackageInfo[]>('list_bun_packages', { envName })
}

/** 追加安装依赖（如 `lodash`、`axios@1.x`）。 */
export function installPackages(envName: string, packages: string[]): Promise<OpResult> {
  return toResult(invoke('install_bun_packages', { envName, packages }))
}

/** 移除依赖。 */
export function uninstallPackages(envName: string, packages: string[]): Promise<OpResult> {
  return toResult(invoke('uninstall_bun_packages', { envName, packages }))
}

/** 清空该环境的全部依赖（node_modules + package.json 依赖项）。 */
export function resetEnv(envName: string): Promise<OpResult> {
  return toResult(invoke('reset_bun_env', { envName }))
}

/**
 * 删除环境：Node 单一运行时不可删，Rust 侧会直接拒绝。
 * 保留该接口仅为与 Python 页同构；调用方不应在前端暴露此按钮。
 */
export function deleteEnv(_envName: string): Promise<OpResult> {
  return toResult(invoke('delete_bun_env', { envName: _envName }))
}

/** 在 default 环境中运行 JS/TS 脚本，成功返回脚本 stdout。 */
export function runScript(envName: string, scriptPath: string): Promise<OpResult> {
  return toResult(invoke('run_node_script', { envName, scriptPath }))
}
