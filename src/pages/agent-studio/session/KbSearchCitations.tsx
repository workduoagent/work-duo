/**
 * 知识库检索命中片段卡片（K3-1 引用展示核心）。
 *
 * 挂载点：工具步骤结果区（`ToolStepLine` 对话时间线 / `ToolStepCard` 规划时间线），
 * 当 `toolName === 'native__kb_search'` 时替换裸 JSON 展示。
 *
 * 数据契约（与 Rust `KbSearchHit` 对齐，`knowledge.rs:836`，camelCase 序列化）：
 *  - 常规返回：`KbSearchHit[]`（JSON 数组）；
 *  - 超软上限（>6 次/任务）返回：`{ notice: string, hits: KbSearchHit[] }` 包装。
 * 解析失败（非预期结构）兜底渲染原始文本，确保不影响其它工具。
 *
 * 可溯源（跳源）：点击源文件路径 → 经 `knowledge_base.path` 解析真实目录 → Tauri opener
 * 打开源文件（无默认应用则退化为在文件管理器中定位）。浏览器非 Tauri 环境给出提示。
 */
import { ExternalLink, FileText } from 'lucide-react'
import { getKnowledgeBase } from '@/core/mapper/knowledge-mapper'
import { resolveRealKnowledgeBasePath } from '@/core/file/kbFs'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { join } from '@tauri-apps/api/path'
import { isTauri } from '@/core/config'
import { useNotify } from '@/components/ui/notify'
import './KbSearchCitations.scss'

/** 检索命中（仅取前端渲染所需字段，缺失容错）。
 *  `cite` = Rust 工具层注入的任务内全局引用编号（K3-2），旧数据缺失时按列表序回退。 */
export interface KbHit {
  id?: string
  kbId?: string
  assetId?: string
  originFilePath?: string
  path?: string
  breadcrumbs?: string | null
  chunkType?: string
  content?: string
  score?: number
  channel?: string
  cite?: number
}

function typeLabel(t?: string): string {
  switch (t) {
    case 'text':
      return '文本'
    case 'table':
      return '表格'
    case 'code':
      return '代码'
    default:
      return t || '片段'
  }
}

function channelLabel(c?: string): string {
  if (c === 'vector') return '向量'
  if (c === 'keyword') return '关键词'
  return c || '未知'
}

/** 解析工具返回 JSON 为命中数组 + 收敛提示。返回 null 表示非 kb_search 结构。 */
export function parseKbResult(result?: string): { hits: KbHit[]; notice?: string } | null {
  if (!result) return null
  try {
    const parsed = JSON.parse(result)
    if (Array.isArray(parsed)) return { hits: parsed as KbHit[] }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.hits)) {
      return { hits: parsed.hits as KbHit[], notice: parsed.notice }
    }
  } catch {
    /* 非 JSON 或结构不符，返回 null 由调用方兜底 */
  }
  return null
}

/** 任务内跨调用去重（K3-2，纯函数）：同 chunk 只保留一条。
 *  key 优先 `id`（Rust 端必给）；缺失时按 kbId+assetId+源路径+层级 合成兜底键。
 *  同键重复出现（K3-4 full 通路会回传同 chunk 的未截断完整版）时保留 content 更长者。
 *  排序：命中带 Rust 工具层 `cite` 引用编号（与正文 [N] 引标一一对应）时按编号升序，
 *  旧数据无编号保持首次命中序。 */
export function dedupeKbHits(hits: KbHit[]): KbHit[] {
  const byKey = new Map<string, KbHit>()
  for (const h of hits) {
    const key =
      h.id ||
      `${h.kbId ?? ''}|${h.assetId ?? ''}|${h.originFilePath ?? ''}|${h.path ?? ''}|${h.breadcrumbs ?? ''}`
    const prev = byKey.get(key)
    if (!prev || (h.content?.length ?? 0) > (prev.content?.length ?? 0)) byKey.set(key, h)
  }
  const out = [...byKey.values()]
  if (out.length > 1 && out.every((h) => typeof h.cite === 'number')) {
    out.sort((a, b) => (a.cite ?? 0) - (b.cite ?? 0))
  }
  return out
}

/** 跳源共享实现（卡片与 K3-2 引用来源列表共用）：解析 KB 目录 → openPath，失败退化 revealItemInDir。 */
async function openKbSource(hit: KbHit, notify: ReturnType<typeof useNotify>['message']) {
  if (!isTauri) {
    notify.warning('当前为浏览器环境，无法打开本地文件')
    return
  }
  if (!hit.kbId || !hit.originFilePath) {
    notify.warning('该命中缺少溯源信息（kbId / 源文件路径）')
    return
  }
  try {
    const kb = await getKnowledgeBase(hit.kbId)
    if (!kb?.path) {
      notify.warning('未找到对应知识库目录，无法定位源文件')
      return
    }
    const realBase = await resolveRealKnowledgeBasePath(kb.path)
    const abs = await join(realBase, hit.originFilePath)
    try {
      await openPath(abs)
    } catch {
      // 无默认应用打开时，退化到在文件管理器中定位。
      await revealItemInDir(abs)
    }
  } catch (e) {
    notify.error(`打开源文件失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

export function KbSearchCitations({ result }: { result?: string }) {
  const { message } = useNotify()
  const parsed = parseKbResult(result)

  // 解析失败或空命中：兜底渲染原始文本，避免破坏其它工具结果展示。
  if (!parsed || parsed.hits.length === 0) {
    return (
      <pre className="kb-cite__raw">{result || '（无返回内容）'}</pre>
    )
  }

  const { hits, notice } = parsed

  const openSource = (hit: KbHit) => openKbSource(hit, message)

  return (
    <div className="kb-cite">
      {notice && <div className="kb-cite__notice">{notice}</div>}
      {hits.map((h, i) => (
        <div className="kb-cite__card" key={h.id ?? `${h.kbId}-${h.assetId}-${i}`}>
          <div className="kb-cite__head">
            <span className={`kb-cite__chan kb-cite__chan--${h.channel ?? 'unknown'}`}>
              {channelLabel(h.channel)}
            </span>
            {h.chunkType && <span className="kb-cite__type">{typeLabel(h.chunkType)}</span>}
            {h.channel === 'vector' && typeof h.score === 'number' && h.score >= 0 && (
              <span className="kb-cite__score" title="Lance L2 距离，越小越相似">
                距离 {h.score.toFixed(3)}
              </span>
            )}
          </div>
          <button
            type="button"
            className="kb-cite__src"
            onClick={() => openSource(h)}
            title="打开源文件"
          >
            <FileText size={12} className="kb-cite__src-icon" />
            <span className="kb-cite__src-path">{h.originFilePath || '（未知源文件）'}</span>
            <ExternalLink size={11} className="kb-cite__src-go" />
          </button>
          {h.breadcrumbs && <div className="kb-cite__crumbs">{h.breadcrumbs}</div>}
          {h.content && <pre className="kb-cite__content">{h.content}</pre>}
        </div>
      ))}
    </div>
  )
}

/** 正文内联引用引标（K3-2）：渲染 `[N]` 小引标，鼠标悬浮展示对应召回片段
 *  （内容 + 源文件 + 层级）。悬浮卡为纯 CSS（hover/focus-within），absolute 定位
 *  于引标上方，非 fixed 全局弹层（无需 portal）。编号无对应命中时退化为普通上标。 */
export function KbCiteMark({ cite, hits }: { cite?: string | number; hits?: KbHit[] }) {
  const n = typeof cite === 'string' ? Number(cite) : cite
  const hit = typeof n === 'number' ? (hits ?? []).find((h) => h.cite === n) : undefined
  if (!hit) return <sup className="kb-cite-mark">[{Number.isFinite(n) ? n : '?'}]</sup>
  return (
    <span className="kb-cite-wrap">
      <sup className="kb-cite-mark" tabIndex={0}>
        [{n}]
      </sup>
      <span className="kb-cite-pop">
        <span className="kb-cite-pop__src">{hit.originFilePath || '（未知源文件）'}</span>
        {hit.breadcrumbs && <span className="kb-cite-pop__crumbs">{hit.breadcrumbs}</span>}
        {/* 台账 S4 复查修复：此处曾用 <pre>，随引标嵌进 markdown 段落 <p> 时触发
            React validateDOMNesting 警告（<p> 不允许嵌套块级 <pre>，任务结束聚合出
            kbSources 后才渲染弹层，故报错时机总在回答结束时）。改用 <span> +
            display:block + 既有 pre-wrap 样式，视觉与换行行为完全一致且 DOM 合法。 */}
        <span className="kb-cite-pop__content">{hit.content}</span>
      </span>
    </span>
  )
}

/** 任务级引用来源区（K3-2）：task_done 后渲染在消息气泡底部——本轮全部 kb_search 命中
 *  经 `dedupeKbHits` 去重后**按源文件分组**展示：`[1][2][5] memory-system-design.md`，
 *  引标悬浮展示片段内容、点击文件名跳源。渲染入口只有 KbSearchCitations（完整卡片）、
 *  KbCiteMark（正文引标）、KbSourceList（底部来源区）三处，同域内聚。 */
export function KbSourceList({ hits }: { hits?: KbHit[] }) {
  const { message } = useNotify()
  if (!hits || hits.length === 0) return null
  // 按源文件分组（保持 cite 升序——dedupeKbHits 已排序，Map 保插入序）
  const groups = new Map<string, KbHit[]>()
  for (const h of hits) {
    const key = h.originFilePath || '（未知源文件）'
    const arr = groups.get(key)
    if (arr) arr.push(h)
    else groups.set(key, [h])
  }
  return (
    <div className="kb-src">
      <div className="kb-src__head">
        <span>参考来源</span>
        <span className="kb-src__n">{hits.length}</span>
      </div>
      <div className="kb-src__list">
        {[...groups.entries()].map(([file, hs]) => (
          <div className="kb-src__row" key={file}>
            <span className="kb-src__marks">
              {hs.map((h, i) => (
                <KbCiteMark key={h.id ?? `${file}-${i}`} cite={h.cite} hits={hits} />
              ))}
            </span>
            <button
              type="button"
              className="kb-src__file"
              onClick={() => openKbSource(hs[0], message)}
              title="打开源文件"
            >
              {file}
              <ExternalLink size={11} className="kb-src__go" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
