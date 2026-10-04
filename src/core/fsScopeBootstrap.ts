/**
 * 启动期 fs scope 引导（数据迁移兼容）。
 *
 * 问题根因：设置里的「数据迁移」会把 skill_path / knowledge_base_path / vector_path 等
 * 改写到默认 Tauri 路径（$APPDATA/$RESOURCE）之外的绝对目录（如 E:\WorkDuo\.skills）。
 * 静态 capability 的 $APPDATA/$RESOURCE 变量无法覆盖这些自定义目录，导致前端经
 * @tauri-apps/plugin-fs 写盘（mkdir / write）被 ACL 以
 * "forbidden path: ..." 拒绝——技能创建、KB 落盘、插件写盘全部受影响。
 *
 * 修复：启动时读取 app_config 里记录的实际数据目录（解析 $APPDATA/$RESOURCE 占位），
 * 经 grant_fs_scope 命令把这些绝对目录按 dynamic-acl 加进运行时 fs scope。
 * 仅处理绝对路径，默认 $APPDATA 下的目录已被静态 scope 覆盖、重复授予无害。
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import { getAllRawConfig } from '@/core/mapper/config-mapper'
import { appDataDir, resourceDir } from '@tauri-apps/api/path'
import { fe } from '@/core/logBridge'

/** app_config 中凡是「物理数据目录」的键，迁移后都需纳入 fs scope。 */
const DATA_DIR_KEYS = ['workspace_path', 'skill_path', 'knowledge_base_path', 'vector_path', 'plugin_path']

async function resolveRaw(raw: string): Promise<string> {
  let s = raw.trim()
  if (s.includes('$APPDATA')) s = s.replace('$APPDATA', await appDataDir())
  else if (s.includes('$RESOURCE')) s = s.replace('$RESOURCE', await resourceDir())
  return s.trim()
}

/**
 * 收集实际数据目录并申请 fs scope。带重试，规避启动早期 DB 未就绪导致的读取失败。
 */
export async function ensureDataDirFsScope(): Promise<void> {
  if (!isTauri) return
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const cfg = await getAllRawConfig()
      const dirs = new Set<string>()
      for (const k of DATA_DIR_KEYS) {
        const v = cfg[k]
        if (v && v.trim()) {
          const abs = await resolveRaw(v)
          if (abs) dirs.add(abs)
        }
      }
      const list = Array.from(dirs)
      if (list.length === 0) return
      await invoke('grant_fs_scope', { paths: list })
      fe.info('fsScope', `已为 ${list.length} 个数据目录申请 fs scope: ${list.join(' | ')}`)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt < maxAttempts) {
        fe.warn('fsScope', `第${attempt}次申请 fs scope 失败，重试: ${msg}`)
        await new Promise((r) => setTimeout(r, 600))
        continue
      }
      fe.warn('fsScope', `申请 fs scope 失败（写盘可能受 ACL 限制）: ${msg}`)
    }
  }
}
