/**
 * 设置中心的领域层。
 *
 * 约定：
 *  - 所有「运行期选项 / 文案 / 默认值」集中在此（types/core.d.ts 只放编译期类型，如 ProxyMode）；
 *  - 配置最终全部落库到 app_config 表（key-value），读写经 src/core/mapper/config-mapper.ts；
 *  - 结构化配置以 JSON 字符串落库，skill_path 作为历史兼容键保留原始字符串（不 JSON 包裹）；
 *  - 页面只调用 loadSettings / saveSettings，不直接操作 app_config。
 */

import type { ProxyMode } from '@/types/core'
import { getAllRawConfig, setRawConfig } from '@/core/mapper/config-mapper'

/** 网络代理配置（对应 app_config.network_proxy，JSON 序列化）。 */
export interface ProxyConfig {
  mode: ProxyMode
  /** 手动模式下可选填写；对应 http:// 代理地址 */
  http?: string
  /** 手动模式下可选填写；对应 https:// 代理地址 */
  https?: string
  /** 手动模式下可选填写；对应 socks5:// 代理地址 */
  socks5?: string
}

/** 单条导入的记忆（对应 app_config.imported_memories 数组元素）。 */
export interface ImportedMemory {
  id: string
  title: string
  content: string
  source?: string
  importedAt: number
}

/** 设置中心聚合模型（一次读取 / 一次落库）。 */
export interface AppSettings {
  /** 开机自启，默认关闭 */
  autoLaunch: boolean
  /** 网络代理 */
  networkProxy: ProxyConfig
  /** 默认工作空间存储路径，默认 $APPDATA/.workspace */
  workspacePath: string
  /** Skill 存储目录，默认 $RESOURCE/.skills（与 app_config.skill_path 同键） */
  skillPath: string
  /** 客户端通知，默认开启 */
  clientNotify: boolean
  /** 生成对话记忆，默认关闭 */
  memoryEnabled: boolean
  /** 会话管理：超过设定小时数未对话自动开启新会话，默认关闭 */
  sessionAutoNew: boolean
  /** 自动新会话的空闲小时数阈值，默认 24 */
  sessionIdleHours: number
  /** 导入的记忆列表 */
  importedMemories: ImportedMemory[]
}

/** app_config 中各设置项的 key（与 init.sql 种子、config-mapper 保持一致）。 */
export const CONFIG_KEYS = {
  autoLaunch: 'auto_launch',
  networkProxy: 'network_proxy',
  workspacePath: 'workspace_path',
  skillPath: 'skill_path',
  clientNotify: 'client_notify',
  memoryEnabled: 'memory_enabled',
  sessionAutoNew: 'session_auto_new',
  sessionIdleHours: 'session_idle_hours',
  importedMemories: 'imported_memories',
} as const

/** 各设置的出厂默认值（缺失时回退）。 */
export const DEFAULT_SETTINGS: AppSettings = {
  autoLaunch: false,
  networkProxy: { mode: 'direct' },
  workspacePath: '$APPDATA/.workspace',
  skillPath: '$RESOURCE/.skills',
  clientNotify: true,
  memoryEnabled: false,
  sessionAutoNew: false,
  sessionIdleHours: 24,
  importedMemories: [],
}

/** 网络代理模式下拉选项（运行期）。 */
export const PROXY_MODE_OPTIONS: { value: ProxyMode; label: string }[] = [
  { value: 'direct', label: '直连（不使用代理）' },
  { value: 'system', label: '跟随系统' },
  { value: 'manual', label: '手动配置' },
]

/* ------------------------------------------------------------------ *
 * 解析：区分「原始字符串键」与「JSON 序列化键」
 * ------------------------------------------------------------------ */

/** 原始字符串存储的 key（不 JSON 包裹，保持与历史种子一致）。 */
const RAW_STRING_KEYS = new Set<string>([CONFIG_KEYS.skillPath])

function parseValue<T>(raw: string | undefined, fallback: T): T {
  if (raw == null) return fallback
  if (typeof fallback === 'string') {
    // 字符串类默认值：先尝试 JSON 解析，避免把 '"xxx"' 当成值；
    // 解析失败（如 '$RESOURCE/.skills'）则原文返回。
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed as T
    } catch {
      /* 非 JSON → 原文返回 */
    }
    return raw as unknown as T
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function serializeValue(key: string, value: unknown): string {
  if (RAW_STRING_KEYS.has(key)) return String(value)
  return JSON.stringify(value)
}

/* ------------------------------------------------------------------ *
 * 对外读取 / 落库
 * ------------------------------------------------------------------ */

/** 载入全部设置（缺失项回退默认值）。 */
export async function loadSettings(): Promise<AppSettings> {
  const all = await getAllRawConfig()
  const k = CONFIG_KEYS
  return {
    autoLaunch: parseValue<boolean>(all[k.autoLaunch], DEFAULT_SETTINGS.autoLaunch),
    networkProxy: parseValue<ProxyConfig>(
      all[k.networkProxy],
      DEFAULT_SETTINGS.networkProxy,
    ),
    workspacePath: parseValue<string>(
      all[k.workspacePath],
      DEFAULT_SETTINGS.workspacePath,
    ),
    skillPath: parseValue<string>(all[k.skillPath], DEFAULT_SETTINGS.skillPath),
    clientNotify: parseValue<boolean>(
      all[k.clientNotify],
      DEFAULT_SETTINGS.clientNotify,
    ),
    memoryEnabled: parseValue<boolean>(
      all[k.memoryEnabled],
      DEFAULT_SETTINGS.memoryEnabled,
    ),
    sessionAutoNew: parseValue<boolean>(
      all[k.sessionAutoNew],
      DEFAULT_SETTINGS.sessionAutoNew,
    ),
    sessionIdleHours: parseValue<number>(
      all[k.sessionIdleHours],
      DEFAULT_SETTINGS.sessionIdleHours,
    ),
    importedMemories: parseValue<ImportedMemory[]>(
      all[k.importedMemories],
      DEFAULT_SETTINGS.importedMemories,
    ),
  }
}

/** 落库全部设置（差异无关，整组写入；skill_path 保持原始字符串）。 */
export async function saveSettings(next: AppSettings): Promise<void> {
  const k = CONFIG_KEYS
  await Promise.all([
    setRawConfig(k.autoLaunch, serializeValue(k.autoLaunch, next.autoLaunch)),
    setRawConfig(k.networkProxy, serializeValue(k.networkProxy, next.networkProxy)),
    setRawConfig(k.workspacePath, serializeValue(k.workspacePath, next.workspacePath)),
    setRawConfig(k.skillPath, serializeValue(k.skillPath, next.skillPath)),
    setRawConfig(k.clientNotify, serializeValue(k.clientNotify, next.clientNotify)),
    setRawConfig(k.memoryEnabled, serializeValue(k.memoryEnabled, next.memoryEnabled)),
    setRawConfig(
      k.sessionAutoNew,
      serializeValue(k.sessionAutoNew, next.sessionAutoNew),
    ),
    setRawConfig(
      k.sessionIdleHours,
      serializeValue(k.sessionIdleHours, next.sessionIdleHours),
    ),
    setRawConfig(
      k.importedMemories,
      serializeValue(k.importedMemories, next.importedMemories),
    ),
  ])
}

/** 仅落库被修改的若干字段（基于已有设置做浅合并）。 */
export async function patchSettings(
  current: AppSettings,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const next = { ...current, ...patch }
  await saveSettings(next)
  return next
}
