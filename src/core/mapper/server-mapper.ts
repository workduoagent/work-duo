/**
 * 服务器档案（server_host）数据访问层（mapper）。
 *
 * 与 agent-project-mapper 一致：DB 访问集中在本目录。区别于普通表——
 * 凭证密文（AES-256-GCM）与测试连接（russh SSH 探测）必须经 Rust 完成，
 * 因此 CRUD 走 Tauri 命令（host::commands），mapper 只是薄封装。
 * 非 Tauri（浏览器 dev）回退 localStorage（仅配置态，测试连接不可用）。
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import type { ServerHost, ServerHostInput, ServerTestReport } from '@/types/core'

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage（无凭证加密与 SSH 能力）
 * ---------------------------------------------------------------- */
const LS_SERVERS = 'work-duo:server-hosts'

function lsRead(): ServerHost[] {
  try {
    const raw = localStorage.getItem(LS_SERVERS)
    return raw ? (JSON.parse(raw) as ServerHost[]) : []
  } catch {
    return []
  }
}

function lsWrite(list: ServerHost[]): void {
  localStorage.setItem(LS_SERVERS, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ---------------------------------------------------------------- */

/** 列出全部服务器（最近更新倒序）。 */
export async function listServerHosts(): Promise<ServerHost[]> {
  if (!isTauri) {
    return lsRead().sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return invoke<ServerHost[]>('server_host_list')
}

/** 按 id 查询单个服务器。 */
export async function getServerHost(id: string): Promise<ServerHost | undefined> {
  if (!isTauri) return lsRead().find((s) => s.id === id)
  const r = await invoke<ServerHost | null>('server_host_get', { id })
  return r ?? undefined
}

/** 新建 / 更新（upsert）。secret 为空 = 编辑时保留已存凭证。 */
export async function saveServerHost(input: ServerHostInput): Promise<ServerHost> {
  if (!isTauri) {
    const list = lsRead()
    const now = Date.now()
    const existing = list.find((s) => s.id === input.id)
    const next: ServerHost = {
      ...(existing ?? {
        id: input.id,
        user: input.user,
        authType: input.authType ?? 'password',
        credentialId: null,
        credentialHint: null,
        pathAllow: [],
        pathDeny: [],
        localPathAllow: [],
        sudoMode: 'none' as const,
        sudoUser: 'root',
        hostAutoMode: 'strict' as const,
        allowGrantMemory: false,
        l3Policy: 'single_shot' as const,
        grantBindAsUser: true,
        tags: [],
        createdAt: now,
      }),
      name: input.name,
      host: input.host,
      port: input.port ?? 22,
      user: input.user,
      authType: input.authType ?? 'password',
      pathAllow: input.pathAllow ?? existing?.pathAllow ?? [],
      pathDeny: input.pathDeny ?? existing?.pathDeny ?? [],
      localPathAllow: input.localPathAllow ?? existing?.localPathAllow ?? [],
      defaultCwd: input.defaultCwd ?? existing?.defaultCwd,
      loginNote: input.loginNote ?? existing?.loginNote,
      sudoMode: input.sudoMode ?? 'none',
      sudoUser: input.sudoUser ?? 'root',
      hostAutoMode: input.hostAutoMode ?? 'strict',
      allowGrantMemory: input.allowGrantMemory ?? false,
      l3Policy: input.l3Policy ?? 'single_shot',
      grantBindAsUser: input.grantBindAsUser ?? true,
      tags: input.tags ?? existing?.tags ?? [],
      note: input.note ?? existing?.note,
      updatedAt: now,
    }
    const others = list.filter((s) => s.id !== input.id)
    lsWrite([...others, next])
    return next
  }
  return invoke<ServerHost>('server_host_save', { input })
}

/** 删除服务器（级联清理凭证与绑定引用）。 */
export async function deleteServerHost(id: string): Promise<void> {
  if (!isTauri) {
    lsWrite(lsRead().filter((s) => s.id !== id))
    return
  }
  await invoke<void>('server_host_delete', { id })
}

/**
 * 测试连接（管理面）：connect + whoami + uname + $HOME。
 * 未保存的表单也可直接测试（secret 随入参一次性传入）。
 */
export async function testServerConnection(input: ServerHostInput): Promise<ServerTestReport> {
  if (!isTauri) {
    return {
      ok: false,
      latencyMs: 0,
      error: '浏览器 dev 环境无 SSH 能力，请在 Tauri 客户端中测试',
    }
  }
  return invoke<ServerTestReport>('server_host_test_connection', { input })
}

/** 解析文本域输入为数组（一行一条，去空白行）。 */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
