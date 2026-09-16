/**
 * 自定义脚本插件 —— Rust 命令调用桥（对齐 mcp-connection.ts 的定位）。
 *
 * 职责边界：真正需要原生执行 / 头注释解析的能力走 Rust（plugin_commands.rs），
 * 纯 SQL CRUD 不在本文件（见 plugin-mapper.ts）。
 *  - extractPluginMeta → invoke('extract_plugin_meta')：纯解析头注释 → 元数据（不落库）；
 *  - testPlugin        → invoke('test_user_plugin')：端到端沙箱试跑（依赖自愈 / 超时 / 写日志）。
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import type { PluginRuntime, PluginTestResult } from '@/core/file/plugin-file'

/** extract_plugin_meta 返回结构（与 Rust ExtractPluginMetaOutput 对齐，camelCase）。 */
export interface PluginMetaOutput {
  name: string | null
  description: string | null
  dependencies: string[]
  parametersSchema: Record<string, unknown>
  warnings: string[]
}

/**
 * 解析用户脚本头注释 → 元数据（不落库）。
 * 解析宽松：未知键忽略进 warnings；缺 type 的 param 回落 string；无头注释返回空 schema + warning。
 */
export async function extractPluginMeta(
  runtime: PluginRuntime,
  script: string,
): Promise<PluginMetaOutput> {
  if (!isTauri) {
    // 浏览器 dev 回退：无法执行 Rust 解析，返回空结果由用户手填。
    return {
      name: null,
      description: null,
      dependencies: [],
      parametersSchema: { type: 'object', properties: {}, required: [] },
      warnings: ['浏览器预览环境不支持头注释解析，请手填参数 Schema'],
    }
  }
  return invoke<PluginMetaOutput>('extract_plugin_meta', { runtime, script })
}

/**
 * 端到端试跑插件：读 DB → 拼 Runner 壳 → 沙箱执行 → exit 42 依赖自愈 → 写 plugin_run_log。
 * `params` 为空 / 非法 JSON 时，Rust 侧自动回退 sample_params → {}。
 */
export async function testPlugin(
  pluginId: string,
  params?: Record<string, unknown> | null,
): Promise<PluginTestResult> {
  if (!isTauri) {
    throw new Error('浏览器预览环境不支持插件试跑，请在 Tauri 应用内使用')
  }
  const paramsText =
    params && Object.keys(params).length > 0 ? JSON.stringify(params) : undefined
  return invoke<PluginTestResult>('test_user_plugin', {
    pluginId,
    params: paramsText ?? null,
  })
}
