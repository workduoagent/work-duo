/**
 * 知识库索引钩子（K1' 第四期，设计稿 docs/knowledge-rag-design.md §3.5）。
 *
 * 知识库文件由前端 fs 插件直写（kbFs），Rust 侧无命令可挂钩——文件增删改后的
 * 索引联动在 mapper 数据变更点 fire-and-forget 调用 Rust 命令：
 *  - 文件新增/修改/改名/移动 → `kb_sync_asset`（digest 未变幂等跳过，Rust 侧判）；
 *  - 文件/资产删除 → `kb_remove_asset`（级联清理 Lance 段）；
 *  - 全量重建 → 详情页按钮显式调 `kb_rebuild_index`（不走本钩子）。
 *
 * 失败语义：任何失败仅 console 记录，绝不阻塞文件管理主流程（设计稿 §6 降级原则）。
 */
import { isTauri } from '@/core/config'
import { fe } from '@/core/logBridge'
import { invoke } from '@tauri-apps/api/core'

/** 单资产增量同步（digest 未变时 Rust 侧幂等跳过）。 */
export function fireKbSyncAsset(kbId: string, assetId: string): void {
  if (!isTauri || !kbId || !assetId) return
  fe.info('kb-index', `sync asset kbId=${kbId} assetId=${assetId}`)
  void invoke('kb_sync_asset', { input: { kbId, assetId } }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kb-index', `sync fail asset=${assetId} err=${msg}`)
    console.warn(`[kb-index] 资产同步失败（文件管理不受影响）asset=${assetId}：`, e)
  })
}

/** 级联清理资产向量段（资产行删除前/后调用皆可，Rust 侧幂等）。 */
export function fireKbRemoveAsset(kbId: string, assetId: string): void {
  if (!isTauri || !kbId || !assetId) return
  fe.info('kb-index', `remove asset kbId=${kbId} assetId=${assetId}`)
  void invoke('kb_remove_asset', { input: { kbId, assetId } }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    fe.warn('kb-index', `remove fail asset=${assetId} err=${msg}`)
    console.warn(`[kb-index] 资产向量清理失败（文件管理不受影响）asset=${assetId}：`, e)
  })
}
