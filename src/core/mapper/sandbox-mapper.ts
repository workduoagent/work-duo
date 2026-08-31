/**
 * 沙箱环境（Python 运行时）数据访问层。
 *
 * 直接封装 Tauri invoke 调用 `mamba_manager` 暴露的命令，并把 Rust 侧
 * `Result<String, String>` 统一转换为前端友好的 `{ ok, error?, data? }`，
 * 供页面用 `useNotify().result()` 统一提示。
 *
 * 注意：Rust 命令的 snake_case 入参在 JS 侧为 camelCase（如 `env_name`→`envName`）。
 */
import { invoke } from '@tauri-apps/api/core'

/** 单个 Python 运行环境的元信息（对应 Rust `EnvInfo`）。 */
export interface EnvInfo {
  name: string
  is_default: boolean
  exists: boolean
  python_version: string | null
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

/** 列出全部环境（含受保护的 default，即使尚未创建也以 exists=false 呈现）。 */
export async function listEnvs(): Promise<EnvInfo[]> {
  return invoke<EnvInfo[]>('list_mamba_envs')
}

/** 创建最纯净的 Python 环境（仅解释器，不预装第三方库）。 */
export function createEnv(envName: string, pythonVersion: string): Promise<OpResult> {
  return toResult(
    invoke('init_mamba_env', { envName, pythonVersion }),
  )
}

/** 查询某环境已安装的依赖列表。 */
export async function listPackages(envName: string): Promise<PackageInfo[]> {
  return invoke<PackageInfo[]>('list_mamba_packages', { envName })
}

/** 向某环境追加安装依赖。 */
export function installPackages(envName: string, packages: string[]): Promise<OpResult> {
  return toResult(invoke('install_mamba_packages', { envName, packages }))
}

/** 从某环境移除依赖。 */
export function uninstallPackages(envName: string, packages: string[]): Promise<OpResult> {
  return toResult(invoke('uninstall_mamba_packages', { envName, packages }))
}

/** 重置某环境（清空所有依赖后重建）。default 会被 Rust 侧拒绝。 */
export function resetEnv(envName: string, pythonVersion: string): Promise<OpResult> {
  return toResult(invoke('reset_mamba_env', { envName, pythonVersion }))
}

/** 删除某环境。default 会被 Rust 侧拒绝。 */
export function deleteEnv(envName: string): Promise<OpResult> {
  return toResult(invoke('delete_mamba_env', { envName }))
}

/** 在某环境中运行 Python 脚本，成功返回脚本 stdout。 */
export function runScript(envName: string, scriptPath: string): Promise<OpResult> {
  return toResult(invoke('run_python_script', { envName, scriptPath }))
}
