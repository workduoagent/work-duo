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

/** 检索命中（仅取前端渲染所需字段，缺失容错）。 */
interface KbHit {
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
function parseKbResult(result?: string): { hits: KbHit[]; notice?: string } | null {
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

  const openSource = async (hit: KbHit) => {
    if (!isTauri) {
      message.warning('当前为浏览器环境，无法打开本地文件')
      return
    }
    if (!hit.kbId || !hit.originFilePath) {
      message.warning('该命中缺少溯源信息（kbId / 源文件路径）')
      return
    }
    try {
      const kb = await getKnowledgeBase(hit.kbId)
      if (!kb?.path) {
        message.warning('未找到对应知识库目录，无法定位源文件')
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
      message.error(`打开源文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
