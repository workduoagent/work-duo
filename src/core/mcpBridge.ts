/**
 * WorkDuo 自测闭环 —— 前端「逻辑 UI 意图桥」。
 *
 * 设计原则：零侵入。本模块**不修改任何既有产品逻辑**，只「调用」真实 UI handler。
 * Rust 侧内建 MCP Server（src-tauri/src/mcp_server.rs）收到 UI 意图工具调用时，
 * 经 Tauri 事件 `mcp:intent` 派发到本桥；本桥调用与界面按钮**同一个**真实 handler，
 * 完成后经 `invoke('mcp_resolve_result', ...)` 把结果回传 Rust，Rust 再回应 MCP 调用方。
 *
 * 这样自测走的就是真实 Tauri2 全流程：前端校验 → mapper SQL → tauri-plugin-sql → SQLite，
 * 与真人点击行为、副作用完全一致。
 *
 * 激活方式：无条件监听 `mcp:intent`（main.tsx 启动时调用一次 connectMcpBridge()）。
 * 仅在 WorkDuo 真的作为 MCP Server 被驱动时才会收到事件，因此常驻监听零副作用。
 *
 * 注：引擎类工具（agent_run_task / get_status / wait_task / get_run_logs）由 Rust 侧
 * 内建 MCP Server 直接处理，不经过本桥；本桥只承接 UI 意图类工具。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

import {
  upsertAgent,
  deleteAgent,
  getAgent,
  listAgents,
} from '@/core/mapper/agent-mapper'
import {
  createSession,
  appendRound,
  updateRound,
  updateSession,
  listSessions,
  getSession,
  listRounds,
} from '@/core/mapper/agent-session-mapper'
// —— 工程模块：与工程页同款真实 handler（ensureProjectByPath 幂等按 root_path 单例）——
import { ensureProjectByPath, listProjects } from '@/core/mapper/agent-project-mapper'
import type { AgentUpsertInput, AgentInfo } from '@/types/core'

// —— 插件模块（百宝箱 → 插件）：与 PluginFormModal / index 同款真实 handler ——
import {
  listPlugins,
  getPlugin,
  upsertPlugin,
  deletePlugin,
  setPluginEnabled,
  listPluginRunLogs,
} from '@/core/mapper/plugin-mapper'
import { extractPluginMeta, testPlugin } from '@/core/mapper/plugin-connection'
import { validateIntentPayload } from '@/core/mcpBridge-validate'
import type { UpsertUserPluginInput } from '@/core/file/plugin-file'

// —— 知识库模块：与 KnowledgeFormModal / detail 同款真实 handler（落盘走 kbFs，索引联动走 mapper）——
import {
  listKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  listAssets,
  deleteAssetsUnderPath,
  refreshAssets,
  parseAssetTags,
  updateAssetTags,
} from '@/core/mapper/knowledge-mapper'
import {
  writeKbFileContent,
  writeKbFileBinary,
  createKbFolder,
  deleteKbEntry,
} from '@/core/file/kbFs'
import { fe } from '@/core/logBridge'

// —— 技能模块（设置 → 技能中心 / skill-hub）：与 SkillFormModal / detail / import 同款真实 handler ——
import {
  getSkill,
  upsertSkill,
  deleteSkill,
  setSkillStatus,
  resolveSkillBasePath,
  listSkills,
} from '@/core/mapper/skill-mapper'
import {
  persistSkillFiles,
  removeSkillDir,
  readSkillFileTree,
  readSkillFileContent,
  writeSkillFileContent,
  zipSkillDir,
  uint8ToBase64,
} from '@/core/file/skillFs'
import {
  createEmptySkill,
  type SkillInfo,
  type ScriptFile,
  type ResourceFile,
} from '@/core/file/skill-file'

// 台账 S5：模块级状态挂 globalThis（跨 Vite HMR 存活）——此前 HMR 热替换本模块时
// started 复位、旧 unlisten 丢失 → mcp:intent 监听重复注册（每个意图被处理多次）。
interface BridgeState {
  started: boolean
  unlisten: UnlistenFn | null
}
const bridgeState = ((globalThis as { __wdMcpBridge?: BridgeState }).__wdMcpBridge ??= {
  started: false,
  unlisten: null,
})

/** 在应用启动时调用一次，注册 mcp:intent 监听。幂等。 */
export async function connectMcpBridge(): Promise<void> {
  if (bridgeState.started) return
  bridgeState.started = true

  bridgeState.unlisten = await listen<McpIntent>('mcp:intent', async (event) => {
    const { id, intent, payload } = event.payload
    try {
      const data = await dispatch(intent, payload)
      await invoke('mcp_resolve_result', { id, ok: true, data })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 失败时仍回传，让评测闭环能拿到错误信号，而非超时。
      await invoke('mcp_resolve_result', { id, ok: false, data: { error: message } })
    }
  })

   
  console.log('[mcpBridge] 已注册 mcp:intent 监听（WorkDuo 内建 MCP Server 就绪后可被驱动）')
}

/** 解除监听（一般无需调用）。 */
export function disconnectMcpBridge(): void {
  if (bridgeState.unlisten) {
    bridgeState.unlisten()
    bridgeState.unlisten = null
  }
  bridgeState.started = false
}

interface McpIntent {
  id: string
  intent: string
  payload: unknown
}

/** 脱敏 + 瘦身：单条 Agent 只回传必要字段，避免回传体积撑爆 MCP 工具上下文。 */
function slim(a: AgentInfo) {
  return {
    id: a.id,
    name: a.name,
    identifier: a.identifier,
    scenario: a.scenario,
    isActive: a.isActive,
  }
}

/** base64 -> Uint8Array（用于上送资源 / 导入文件）。 */
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/**
 * 按 id 或 identifier 解析技能（identifier 是唯一稳定键，作为 id 缺失时的回退）。
 * skill_info.id 是文本 UUID 主键（调用方自带），而 identifier 由 UNIQUE 约束保证唯一，
 * 因此两键都能稳定定位一行。
 */
async function resolveSkill(key?: string): Promise<SkillInfo | undefined> {
  if (!key) return undefined
  const byId = await getSkill(key)
  if (byId) return byId
  const list = await listSkills()
  return list.find((s) => s.identifier === key)
}

/**
 * 将意图分发到真实 handler。意图必须与 UI 控件最终触发的入口一致，
 * 严禁另写一份「测试专用」逻辑。
 */
async function dispatch(intent: string, payload: unknown): Promise<unknown> {
  // F006：载荷形状运行时校验——外部客户端的畸形注入在此拒绝（throw → 信封 ok:false）
  const specErr = validateIntentPayload(intent, payload)
  if (specErr) throw new Error(specErr)
  switch (intent) {
    case 'agent:ui_create':
    case 'agent:ui_update': {
      // upsertAgent 返回全量 AgentInfo[]（含完整字段），直接透传给 MCP 工具会撑爆上下文；
      // 这里只回传本次受影响的那一条（按 id / identifier 定位），与 list 输出同构、体积可控。
      const list = await upsertAgent(payload as AgentUpsertInput)
      const p = payload as { id?: string; identifier?: string }
      const rec =
        list.find((a) => (p.id ? a.id === p.id : a.identifier === p.identifier)) ??
        list[list.length - 1]
      return rec ? slim(rec) : list
    }
    case 'agent:ui_delete': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('agent:ui_delete 缺少 id')
      await deleteAgent(id)
      return { id, deleted: true }
    }
    case 'agent:ui_get': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('agent:ui_get 缺少 id')
      return getAgent(id)
    }
    case 'agent:ui_list': {
      const data = await listAgents()
      // 脱敏 + 瘦身：列表仅返回必要字段，避免回传过大
      return (data as AgentInfo[]).map((a) => ({
        id: a.id,
        name: a.name,
        identifier: a.identifier,
        scenario: a.scenario,
        isActive: a.isActive,
      }))
    }
    // —— 会话 / 轮次：与 Agent 对话页「发送」同款真实 handler ——
    // 走 createSession / appendRound / updateRound / updateSession 真实入口，
    // 与界面点击行为、副作用完全一致，落库后 UI 可直接抽查历史。
    case 'agent:session_create': {
      const p = payload as { agentIdentifier?: string; sessionName?: string; projectId?: string | null }
      if (!p.agentIdentifier) throw new Error('agent:session_create 缺少 agentIdentifier')
      return createSession(p.agentIdentifier, p.sessionName, { projectId: p.projectId ?? null })
    }
    case 'agent:round_create': {
      const p = payload as Parameters<typeof appendRound>[0]
      if (!p?.sessionId) throw new Error('agent:round_create 缺少 sessionId')
      return appendRound(p)
    }
    // —— 工程模块：绑定工程是 sessions 文件轨（.wd_mem/sessions 摘要落盘）的前提 ——
    case 'agent:project_ensure': {
      const p = payload as { rootPath?: string }
      if (!p?.rootPath) throw new Error('agent:project_ensure 缺少 rootPath')
      // ensureProjectByPath 幂等：命中已有工程则复用，否则按叶目录名自动建档
      return ensureProjectByPath(p.rootPath)
    }
    case 'agent:project_list': {
      return listProjects()
    }
    case 'agent:round_update': {
      const p = payload as { roundId?: string; patch?: Record<string, unknown> }
      if (!p?.roundId) throw new Error('agent:round_update 缺少 roundId')
      await updateRound(p.roundId, p.patch ?? {})
      return { ok: true }
    }
    case 'agent:session_update': {
      const p = payload as { id?: string; patch?: Record<string, unknown> }
      if (!p?.id) throw new Error('agent:session_update 缺少 id')
      await updateSession(p.id, p.patch ?? {})
      return { ok: true }
    }
    case 'agent:session_list': {
      const p = payload as { agentIdentifier?: string }
      if (!p?.agentIdentifier) throw new Error('agent:session_list 缺少 agentIdentifier')
      return listSessions(p.agentIdentifier)
    }
    case 'agent:session_get': {
      const p = payload as { id?: string }
      if (!p?.id) throw new Error('agent:session_get 缺少 id')
      return getSession(p.id)
    }
    case 'agent:round_list': {
      const p = payload as { sessionId?: string }
      if (!p?.sessionId) throw new Error('agent:round_list 缺少 sessionId')
      return listRounds(p.sessionId)
    }
    // —— 插件模块（百宝箱 → 插件）：与 PluginFormModal / 列表同款真实 handler ——
    case 'plugin:list': {
      const p = payload as { scenario?: string | null }
      return listPlugins(p?.scenario ?? null)
    }
    case 'plugin:get': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('plugin:get 缺少 id')
      return getPlugin(id)
    }
    case 'plugin:upsert': {
      const p = payload as UpsertUserPluginInput
      if (
        !p?.name ||
        !p?.identifier ||
        !p?.description ||
        !p?.runtime ||
        !p?.scriptContent ||
        !p?.parametersSchema
      ) {
        throw new Error('plugin:upsert 缺少必填字段（name/identifier/description/runtime/scriptContent/parametersSchema）')
      }
      return upsertPlugin(p)
    }
    case 'plugin:delete': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('plugin:delete 缺少 id')
      await deletePlugin(id)
      return { id, deleted: true }
    }
    case 'plugin:set_enabled': {
      const p = payload as { id?: string; enabled?: boolean }
      if (!p?.id) throw new Error('plugin:set_enabled 缺少 id')
      return setPluginEnabled(p.id, !!p.enabled)
    }
    case 'plugin:test': {
      const p = payload as { pluginId?: string; params?: Record<string, unknown> | null }
      if (!p?.pluginId) throw new Error('plugin:test 缺少 pluginId')
      return testPlugin(p.pluginId, p.params ?? null)
    }
    case 'plugin:extract_meta': {
      const p = payload as { runtime?: 'python' | 'bun'; script?: string }
      if (!p?.runtime || p?.script == null) throw new Error('plugin:extract_meta 缺少 runtime/script')
      return extractPluginMeta(p.runtime, p.script)
    }
    case 'plugin:list_run_logs': {
      const p = payload as { pluginId?: string; limit?: number }
      if (!p?.pluginId) throw new Error('plugin:list_run_logs 缺少 pluginId')
      return listPluginRunLogs(p.pluginId, p.limit ?? 50)
    }
    // —— 知识库模块：与 KB 详情页/列表页同款真实 handler（落盘走 kbFs，索引联动走 mapper）——
    case 'kb:list': {
      const p = payload as { scenarioFilter?: string }
      return listKnowledgeBases(p?.scenarioFilter)
    }
    case 'kb:get': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('kb:get 缺少 id')
      return getKnowledgeBase(id)
    }
    case 'kb:create': {
      const p = payload as Parameters<typeof createKnowledgeBase>[0]
      if (!p?.identifier || !p?.name) throw new Error('kb:create 缺少 identifier/name')
      fe.info('mcpBridge.kb', `kb:create identifier=${p.identifier} name=${p.name}`)
      const list = await createKnowledgeBase(p)
      const created = list.find((k) => k.identifier === p.identifier) ?? list[list.length - 1]
      fe.info('mcpBridge.kb', `kb:create done identifier=${p.identifier}`)
      return created
    }
    case 'kb:update': {
      const p = payload as Parameters<typeof updateKnowledgeBase>[0]
      if (!p?.id || !p?.name) throw new Error('kb:update 缺少 id/name')
      fe.info('mcpBridge.kb', `kb:update id=${p.id} name=${p.name}`)
      const list = await updateKnowledgeBase(p)
      const updated = list.find((k) => k.id === p.id) ?? list[list.length - 1]
      return updated
    }
    case 'kb:delete': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('kb:delete 缺少 id')
      const kb = await getKnowledgeBase(id)
      if (!kb) throw new Error(`kb:delete 未找到知识库 ${id}`)
      fe.info('mcpBridge.kb', `kb:delete identifier=${kb.identifier} id=${id}`)
      const remaining = await deleteKnowledgeBase(kb)
      return { id, deleted: true, remaining: remaining.length }
    }
    case 'kb:list_assets': {
      const id = (payload as { kbId?: string })?.kbId
      if (!id) throw new Error('kb:list_assets 缺少 kbId')
      return listAssets(id)
    }
    case 'kb:add_file': {
      const p = payload as { kbId?: string; relPath?: string; content?: string }
      if (!p?.kbId || !p?.relPath || p?.content == null) throw new Error('kb:add_file 缺少 kbId/relPath/content')
      const kb = await getKnowledgeBase(p.kbId)
      if (!kb) throw new Error(`kb:add_file 未找到知识库 ${p.kbId}`)
      const folder = kb.path
      if (!folder) throw new Error('kb:add_file 知识库路径缺失')
      fe.info('mcpBridge.kb', `kb:add_file kbId=${p.kbId} relPath=${p.relPath} bytes=${p.content.length}`)
      const res = await writeKbFileContent(folder, p.relPath, p.content)
      if (!res.ok) throw new Error(res.error || '写入文件失败')
      const agg = await refreshAssets(kb)
      fe.info('mcpBridge.kb', `kb:add_file done kbId=${p.kbId} fileCount=${agg.fileCount} fileSize=${agg.fileSize}`)
      return { ok: true, fileCount: agg.fileCount, fileSize: agg.fileSize }
    }
    case 'kb:import_file': {
      const p = payload as { kbId?: string; relPath?: string; base64?: string }
      if (!p?.kbId || !p?.relPath || !p?.base64) throw new Error('kb:import_file 缺少 kbId/relPath/base64')
      const kb = await getKnowledgeBase(p.kbId)
      if (!kb) throw new Error(`kb:import_file 未找到知识库 ${p.kbId}`)
      const folder = kb.path
      if (!folder) throw new Error('kb:import_file 知识库路径缺失')
      const bytes = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))
      fe.info('mcpBridge.kb', `kb:import_file kbId=${p.kbId} relPath=${p.relPath} bytes=${bytes.byteLength}`)
      const res = await writeKbFileBinary(folder, p.relPath, bytes)
      if (!res.ok) throw new Error(res.error || '写入二进制文件失败')
      const agg = await refreshAssets(kb)
      fe.info('mcpBridge.kb', `kb:import_file done kbId=${p.kbId} fileCount=${agg.fileCount} fileSize=${agg.fileSize}`)
      return { ok: true, fileCount: agg.fileCount, fileSize: agg.fileSize }
    }
    case 'kb:create_folder': {
      const p = payload as { kbId?: string; relPath?: string }
      if (!p?.kbId || !p?.relPath) throw new Error('kb:create_folder 缺少 kbId/relPath')
      const kb = await getKnowledgeBase(p.kbId)
      if (!kb) throw new Error(`kb:create_folder 未找到知识库 ${p.kbId}`)
      if (!kb.path) throw new Error('kb:create_folder 知识库路径缺失')
      const res = await createKbFolder(kb.path, p.relPath)
      if (!res.ok) throw new Error(res.error || '创建文件夹失败')
      return { ok: true }
    }
    case 'kb:remove_file': {
      const p = payload as { kbId?: string; relPath?: string }
      if (!p?.kbId || !p?.relPath) throw new Error('kb:remove_file 缺少 kbId/relPath')
      const kb = await getKnowledgeBase(p.kbId)
      if (!kb) throw new Error(`kb:remove_file 未找到知识库 ${p.kbId}`)
      if (!kb.path) throw new Error('kb:remove_file 知识库路径缺失')
      fe.info('mcpBridge.kb', `kb:remove_file kbId=${p.kbId} relPath=${p.relPath}`)
      const delRes = await deleteKbEntry(kb.path, p.relPath)
      if (!delRes.ok) throw new Error(delRes.error || '删除磁盘条目失败')
      await deleteAssetsUnderPath(kb.id, p.relPath)
      fe.info('mcpBridge.kb', `kb:remove_file done kbId=${p.kbId} relPath=${p.relPath}`)
      return { ok: true }
    }
    case 'kb:rebuild_index': {
      const id = (payload as { kbId?: string })?.kbId
      if (!id) throw new Error('kb:rebuild_index 缺少 kbId')
      fe.info('mcpBridge.kb', `kb:rebuild_index kbId=${id}`)
      return invoke('kb_rebuild_index', { input: { kbId: id } })
    }
    // —— 知识库标签（资产级 meta_data.tags）：与 KB 详情页标签面板同款真实 handler ——
    // 底层统一走 updateAssetTags(assetId, tags[])：读当前 meta_data → 仅覆写 tags 键 → 写回。
    case 'kb:add_tag': {
      const p = payload as { kbId?: string; assetId?: string; tag?: string }
      if (!p?.kbId || !p?.assetId || !p?.tag?.trim()) throw new Error('kb:add_tag 缺少 kbId/assetId/tag')
      const assets = await listAssets(p.kbId)
      const asset = assets.find((a) => a.id === p.assetId)
      if (!asset) throw new Error(`kb:add_tag 未找到资产 ${p.assetId}`)
      const t = p.tag.trim()
      const cur = parseAssetTags(asset.metaData)
      if (cur.includes(t)) return { ok: true, existed: true, tags: cur }
      const next = [...cur, t]
      await updateAssetTags(p.assetId, next)
      fe.info('mcpBridge.kb', `kb:add_tag asset=${p.assetId.slice(0, 8)} tag=${t}`)
      return { ok: true, existed: false, tags: next }
    }
    case 'kb:remove_tag': {
      const p = payload as { kbId?: string; assetId?: string; tag?: string }
      if (!p?.kbId || !p?.assetId || !p?.tag?.trim()) throw new Error('kb:remove_tag 缺少 kbId/assetId/tag')
      const assets = await listAssets(p.kbId)
      const asset = assets.find((a) => a.id === p.assetId)
      if (!asset) throw new Error(`kb:remove_tag 未找到资产 ${p.assetId}`)
      const t = p.tag.trim()
      const cur = parseAssetTags(asset.metaData)
      const next = cur.filter((x) => x !== t)
      await updateAssetTags(p.assetId, next)
      fe.info('mcpBridge.kb', `kb:remove_tag asset=${p.assetId.slice(0, 8)} tag=${t}`)
      return { ok: true, removed: cur.includes(t), tags: next }
    }
    case 'kb:rename_tag': {
      const p = payload as { kbId?: string; assetId?: string; from?: string; to?: string }
      if (!p?.kbId || !p?.assetId || !p?.from?.trim() || !p?.to?.trim())
        throw new Error('kb:rename_tag 缺少 kbId/assetId/from/to')
      const assets = await listAssets(p.kbId)
      const asset = assets.find((a) => a.id === p.assetId)
      if (!asset) throw new Error(`kb:rename_tag 未找到资产 ${p.assetId}`)
      const from = p.from.trim()
      const to = p.to.trim()
      const cur = parseAssetTags(asset.metaData)
      const next = cur.map((x) => (x === from ? to : x))
      await updateAssetTags(p.assetId, next)
      fe.info('mcpBridge.kb', `kb:rename_tag asset=${p.assetId.slice(0, 8)} ${from}→${to}`)
      return { ok: true, renamed: cur.includes(from), tags: next }
    }
    // —— 知识库标签·读取：与 KB 详情页「选中文件→标签面板」同款真实读取（Agent 取某文件标签用）——
    case 'kb:get_tags': {
      const p = payload as { kbId?: string; assetId?: string }
      if (!p?.kbId || !p?.assetId) throw new Error('kb:get_tags 缺少 kbId/assetId')
      const assets = await listAssets(p.kbId)
      const asset = assets.find((a) => a.id === p.assetId)
      if (!asset) throw new Error(`kb:get_tags 未找到资产 ${p.assetId}`)
      const tags = parseAssetTags(asset.metaData)
      fe.info('mcpBridge.kb', `kb:get_tags asset=${p.assetId.slice(0, 8)} count=${tags.length}`)
      return { assetId: p.assetId, tags }
    }
    // —— 记忆宫殿模块（设置 → 记忆宫殿）：与 MemoryPalace.tsx 同款 invoke 调用 ——
    case 'memory:list': {
      const p = payload as { agentId?: string; category?: string; query?: string }
      return invoke('list_memories', { agentId: p?.agentId, category: p?.category, query: p?.query })
    }
    case 'memory:heatmap': {
      const p = payload as { agentId?: string }
      return invoke('get_memory_heatmap', { agentId: p?.agentId })
    }
    case 'memory:anchor': {
      const p = payload as Record<string, unknown>
      if (!p?.key || !p?.content) throw new Error('memory:anchor 缺少 key/content')
      return invoke('anchor_memory', { input: p })
    }
    case 'memory:update': {
      const p = payload as Record<string, unknown>
      if (!p?.id) throw new Error('memory:update 缺少 id')
      return invoke('update_memory', { input: p })
    }
    case 'memory:delete': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('memory:delete 缺少 id')
      await invoke('delete_memory', { id })
      return { id, deleted: true }
    }
    case 'memory:recall': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('memory:recall 缺少 id')
      return invoke('recall_memory', { id })
    }
    case 'memory:list_candidates': {
      return invoke('list_memory_candidates', {})
    }
    case 'memory:confirm_candidate': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('memory:confirm_candidate 缺少 id')
      return invoke('confirm_memory_candidate', { id })
    }
    case 'memory:reject_candidate': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('memory:reject_candidate 缺少 id')
      await invoke('reject_memory_candidate', { id })
      return { id, rejected: true }
    }
    // —— 技能模块（设置 → 技能中心 / skill-hub）：与 SkillFormModal / detail / import 同款真实 handler ——
    // 落盘先行（persistSkillFiles）→ 入库（upsertSkill），与 skill-hub 页面 handleSave/handleImport 完全一致。
    case 'skill:list': {
      // 枚举全部技能：本模块唯一枚举入口（此前缺失，外部客户端无法发现已有技能）。
      // 返回形状与其余 *_list 工具对齐（{count, rows}），驱动侧 asRows() 可直接解包。
      const rows = await listSkills()
      fe.info('mcpBridge.skill', `skill:list count=${rows.length}`)
      return { count: rows.length, rows }
    }
    case 'skill:get': {
      const key = (payload as { id?: string; identifier?: string })?.id
        ?? (payload as { id?: string; identifier?: string })?.identifier
      const sk = await resolveSkill(key)
      if (!sk) throw new Error(`skill:get 未找到技能 ${key ?? '(空)'}`)
      return sk
    }
    case 'skill:upsert': {
      const p = payload as {
        skill?: SkillInfo
        scripts?: Array<{ id?: string; name: string; language: string; content: string }>
        resources?: Array<{ name: string; dir?: string; base64: string }>
      }
      const sk = p?.skill
      if (!sk?.identifier?.trim() || !sk?.name?.trim())
        throw new Error('skill:upsert 缺少 skill.identifier / skill.name')
      // 新建技能时 id 由调用方（此处）自带 UUID——skill_info.id 是文本主键、非自增（见 DDL）。
      // 对齐真人 UI：SkillFormModal 创建时生成 id，避免 INSERT 把 id 列写成 NULL。
      if (!sk.id) sk.id = crypto.randomUUID()
      const scripts: ScriptFile[] = (p.scripts ?? []).map((s) => ({
        id: s.id ?? crypto.randomUUID(),
        name: s.name,
        language: s.language,
        content: s.content ?? '',
      }))
      const resources: ResourceFile[] = (p.resources ?? []).map((r) => ({
        id: crypto.randomUUID(),
        name: r.name,
        dir: r.dir ?? '',
        data: b64ToBytes(r.base64),
      }))
      const rawBase = await resolveSkillBasePath()
      fe.info('mcpBridge.skill', `skill:upsert identifier=${sk.identifier} name=${sk.name} scripts=${scripts.length} resources=${resources.length}`)
      // 落盘先行：磁盘写入成功后再入库，避免「IO 失败但 DB 已写入」的脏数据
      await persistSkillFiles(rawBase, sk, scripts, resources)
      const list = await upsertSkill(sk)
      const rec = list.find((x) => x.identifier === sk.identifier) ?? list[list.length - 1]
      fe.info('mcpBridge.skill', `skill:upsert done identifier=${sk.identifier}`)
      return rec
    }
    case 'skill:delete': {
      const key = (payload as { id?: string; identifier?: string })?.id
        ?? (payload as { id?: string; identifier?: string })?.identifier
      if (!key) throw new Error('skill:delete 缺少 id 或 identifier')
      const sk = await resolveSkill(key)
      if (!sk) throw new Error(`skill:delete 未找到技能 ${key}`)
      const id = sk.id
      const identifier = sk.identifier
      fe.info('mcpBridge.skill', `skill:delete identifier=${identifier} id=${id}`)
      await deleteSkill(id)
      const rawBase = await resolveSkillBasePath()
      // 与 skill-hub handleDelete 一致：磁盘清理失败（如目录已不存在）不阻断「库行已删」的结果
      await removeSkillDir(rawBase, identifier).catch(() => {})
      return { id, identifier, deleted: true }
    }
    case 'skill:set_status': {
      const p = payload as { id?: string; identifier?: string; status?: number }
      const key = p?.id ?? p?.identifier
      if (!key) throw new Error('skill:set_status 缺少 id 或 identifier')
      const sk = await resolveSkill(key)
      if (!sk) throw new Error(`skill:set_status 未找到技能 ${key}`)
      await setSkillStatus(sk.id, p.status ?? 1)
      return { id: sk.id, identifier: sk.identifier, status: p.status ?? 1, ok: true }
    }
    case 'skill:list_files': {
      const p = payload as { identifier?: string; skillPath?: string }
      if (!p?.identifier) throw new Error('skill:list_files 缺少 identifier')
      const tree = await readSkillFileTree(p.identifier, p.skillPath)
      return { identifier: p.identifier, tree }
    }
    case 'skill:read_file': {
      const p = payload as { identifier?: string; relPath?: string; skillPath?: string }
      if (!p?.identifier || !p?.relPath) throw new Error('skill:read_file 缺少 identifier/relPath')
      const f = await readSkillFileContent(p.identifier, p.relPath, p.skillPath)
      if (!f) throw new Error(`skill:read_file 未找到文件 ${p.relPath}`)
      return { relPath: f.relPath, name: f.name, base64: uint8ToBase64(f.data) }
    }
    case 'skill:write_file': {
      const p = payload as { identifier?: string; relPath?: string; content?: string; skillPath?: string }
      if (!p?.identifier || !p?.relPath || p?.content == null)
        throw new Error('skill:write_file 缺少 identifier/relPath/content')
      const ok = await writeSkillFileContent(p.identifier, p.relPath, p.content, p.skillPath)
      if (!ok) throw new Error('skill:write_file 写入失败')
      return { ok: true, relPath: p.relPath }
    }
    case 'skill:export': {
      const p = payload as { identifier?: string; skillPath?: string }
      if (!p?.identifier) throw new Error('skill:export 缺少 identifier')
      const bytes = await zipSkillDir(p.identifier, p.skillPath)
      if (!bytes) throw new Error(`skill:export 打包失败 identifier=${p.identifier}`)
      return { identifier: p.identifier, base64: uint8ToBase64(bytes), ok: true }
    }
    case 'skill:import': {
      // 与 SkillImportModal.handleOk 同款：zipBase64 解压 / files 扁平数组 -> 资源；
      // SKILL.md 内容作为 skillMarkdown；落盘 + 入库。
      const p = payload as {
        identifier?: string
        name?: string
        description?: string
        scenario?: string
        tags?: string[]
        skillMarkdown?: string
        zipBase64?: string
        files?: Array<{ relPath: string; base64: string }>
      }
      if (!p?.identifier?.trim() || !p?.name?.trim())
        throw new Error('skill:import 缺少 identifier / name')
      // 新建技能时 id 由调用方生成 UUID（skill_info.id 文本主键非自增，与 upsert 一致）

      const resources: ResourceFile[] = []
      if (p.zipBase64) {
        const JSZip = (await import('jszip')).default
        const zip = await JSZip.loadAsync(b64ToBytes(p.zipBase64))
        for (const f of Object.values(zip.files)) {
          if (f.dir) continue
          const full = f.name.replace(/\\/g, '/')
          const idx = full.lastIndexOf('/')
          const name = idx >= 0 ? full.slice(idx + 1) : full
          // 头像归一化（与导入弹窗一致：无论原在何处，强制落到根目录 logo.<ext>）
          const logoMatch = name.match(/^logo\.(png|jpe?g|gif|webp|svg)$/i)
          if (logoMatch) {
            resources.push({
              id: crypto.randomUUID(),
              name: `logo.${logoMatch[1].toLowerCase()}`,
              dir: '',
              data: new Uint8Array(await f.async('arraybuffer')),
            })
            continue
          }
          const rel = idx >= 0 ? full.slice(0, idx) : ''
          resources.push({
            id: crypto.randomUUID(),
            name,
            dir: rel,
            data: new Uint8Array(await f.async('arraybuffer')),
          })
        }
      } else if (p.files?.length) {
        for (const f of p.files) {
          const idx = f.relPath.lastIndexOf('/')
          const name = idx >= 0 ? f.relPath.slice(idx + 1) : f.relPath
          const dir = idx >= 0 ? f.relPath.slice(0, idx) : ''
          resources.push({ id: crypto.randomUUID(), name, dir, data: b64ToBytes(f.base64) })
        }
      }
      const skill: SkillInfo = {
        ...createEmptySkill(),
        identifier: p.identifier.trim(),
        name: p.name.trim(),
        description: p.description?.trim() || undefined,
        scenario: p.scenario || undefined,
        tags: p.tags?.length ? p.tags : undefined,
        // 导入只填 skillMarkdown；instruction 与 SKILL.md 是不同字段，保持为空（与导入弹窗一致）
        instruction: undefined,
        skillMarkdown: p.skillMarkdown || undefined,
      }
      if (!skill.id) skill.id = crypto.randomUUID()
      const rawBase = await resolveSkillBasePath()
      fe.info('mcpBridge.skill', `skill:import identifier=${skill.identifier} name=${skill.name} files=${resources.length}`)
      await persistSkillFiles(rawBase, skill, [], resources)
      const list = await upsertSkill(skill)
      const rec = list.find((x) => x.identifier === skill.identifier) ?? list[list.length - 1]
      return rec
    }
    default:
      throw new Error(`未知意图: ${intent}`)
  }
}
