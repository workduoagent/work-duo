/**
 * 知识库详情页（路由 /knowledge/:id）。
 *
 * 结构：
 *  - 顶部返回导航 + 头部（Logo / 名称 / 简介 / 场景 / 文件数 / 总大小 / 更新时间 / 操作）；
 *  - 操作：新建文件夹 / 新建 Markdown / 导入文件（见文件浏览器工具栏）；元数据编辑、刷新资产清单、导出按钮已移除（暂不需要）。
 *  - 主体：左侧目录树 + 工具栏（新建文件夹 / 新建 Markdown / 导入文件）+ 右侧 MultiFileViewer 按扩展名分发渲染。
 *
 * 文件内容由 MultiFileViewer 自行读取（kb.path + relPath），本页只负责编排与元数据。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  FolderPlus,
  FilePlus,
  Upload,
  FileText,
  HardDrive,
  BookOpen,
  Locate,
  DatabaseZap,
  Tags,
} from 'lucide-react'
// 台账 S12 ① 收官：原 antd Modal（onOk/confirmLoading 体系）已迁 ui Modal
// 确认式底栏（confirm-footer 能力扩展，见 ui/Modal.tsx），页面域 antd 直用至此清零。
import { Button, Input, Field, FieldLabel, Empty, Modal, Progress, Spin } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { isTauri } from '@/core/config'
import { invoke } from '@tauri-apps/api/core'
import { useTauriEvent } from '@/hooks/useTauriEvent'
import {
  getKnowledgeBase,
  refreshAssets,
  deleteAssetsUnderPath,
  listAssets,
  parseAssetTags,
  updateAssetTags,
} from '@/core/mapper/knowledge-mapper.ts'
import type { KnowledgeAsset } from '@/types/core'
import {
  readKbFileTree,
  writeKbFileContent,
  writeKbFileBinary,
  createKbFolder,
  deleteKbEntry,
  moveKbEntry,
} from '@/core/file/kbFs.ts'
import { ROUTES } from '@/core/router/paths.ts'
import { formatBytes, formatRelativeTime } from '@/utils/format.ts'
import type { KnowledgeBase } from '@/types/core'
import type { KbFileTreeNode } from '@/core/file/kbFs.ts'
import { KnowledgeFileTree } from './KnowledgeFileTree.tsx'
import { MultiFileViewer } from '@/components/MultiFileViewer'
import '../index.scss'
import './detail.scss'

export default function KnowledgeDetailPage() {
  const { message, result } = useNotify()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [kb, setKb] = useState<KnowledgeBase | null>(null)
  const [tree, setTree] = useState<KbFileTreeNode | null>(null)
  const [loadingTree, setLoadingTree] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** 当前上传 / 新建的目标目录（相对知识库根目录，'' 表示根目录）；点击文件夹或文件时更新 */
  const [activeDir, setActiveDir] = useState('')
  /** 定位信号：自增时触发目录树展开祖先并滚动到当前选中文件 */
  const [locateNonce, setLocateNonce] = useState(0)

  // 新建文件夹 / 新建 Markdown 的弹窗状态
  const [folderOpen, setFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [mdOpen, setMdOpen] = useState(false)
  const [mdName, setMdName] = useState('')
  const [busy, setBusy] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  /** 重新扫描目录树（保存 / 刷新后复用）。 */
  const loadTree = useCallback(
    async (folder: string) => {
      setLoadingTree(true)
      try {
        setTree(await readKbFileTree(folder))
      } catch (e) {
        message.error(`读取目录结构失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setLoadingTree(false)
      }
    },
    [message],
  )

  const loadKb = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const record = await getKnowledgeBase(id)
      setKb(record ?? null)
      if (record?.path) {
        await loadTree(record.path)
      }
    } finally {
      setLoading(false)
    }
  }, [id, loadTree])

  useEffect(() => {
    void loadKb()
  }, [loadKb])

  // 默认选中第一个文件
  useEffect(() => {
    if (!tree) return
    const firstFile = findFirstFile(tree)
    setSelected(firstFile)
  }, [tree])

  const handleRefresh = async (silent = false) => {
    if (!kb) return
    try {
      const stat = await refreshAssets(kb)
      setKb((prev) => (prev ? { ...prev, fileCount: stat.fileCount, fileSize: stat.fileSize } : prev))
      if (kb.path) await loadTree(kb.path)
      if (!silent) message.success(`已刷新：共 ${stat.fileCount} 个文件，${formatBytes(stat.fileSize)}`)
    } catch (e) {
      message.error(`刷新失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /* ----------------------------- 目录树工具栏操作 ----------------------------- */

  async function afterFsChange() {
    if (kb?.path) {
      await loadTree(kb.path)
      // 文件变更后静默刷新聚合（创建/删除成功不弹提示，仅失败时由调用方提示）
      await handleRefresh(true)
    }
  }

  async function doCreateFolder() {
    const name = folderName.trim().replace(/[\\/]/g, '')
    if (!name || !kb?.path) return
    setBusy(true)
    try {
      const rel = activeDir ? `${activeDir}/${name}` : name
      const r = await createKbFolder(kb.path, rel)
      if (!result(r, '', '新建文件夹失败', true)) return
      setFolderOpen(false)
      setFolderName('')
      await afterFsChange()
    } finally {
      setBusy(false)
    }
  }

  async function doCreateMarkdown() {
    let name = mdName.trim()
    if (!name || !kb?.path) return
    if (!/\.md$/i.test(name)) name += '.md'
    setBusy(true)
    try {
      const rel = activeDir ? `${activeDir}/${name}` : name
      const r = await writeKbFileContent(kb.path, rel, '# 新文档\n\n')
      if (!result(r, '', '新建 Markdown 失败', true)) return
      setMdOpen(false)
      setMdName('')
      await afterFsChange()
      setSelected(rel)
    } finally {
      setBusy(false)
    }
  }

  async function doImport(files: FileList | null) {
    if (!files || files.length === 0 || !kb?.path) return
    setBusy(true)
    try {
      let anyOk = false
      let lastErr: string | undefined
      for (const file of Array.from(files)) {
        // 写入当前选中的目标目录（activeDir 为空表示根目录）
        const rel = activeDir ? `${activeDir}/${file.name}` : file.name
        const buf = await file.arrayBuffer()
        const r = await writeKbFileBinary(kb.path, rel, new Uint8Array(buf))
        if (r.ok) anyOk = true
        else lastErr = r.error
      }
      if (anyOk) {
        await afterFsChange()
      } else if (lastErr) {
        message.error(lastErr)
      }
    } catch (e) {
      message.error(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 删除文件或目录：同步清理物理存储与数据库资产记录，再静默刷新聚合；仅异常时提示。 */
  async function handleDeleteEntry(relPath: string) {
    if (!kb?.path) return
    try {
      const r = await deleteKbEntry(kb.path, relPath)
      if (!result(r, '', '删除失败', true)) return
      // 清除该目录（含子目录）在 knowledge_asset 中的资产记录，确保数据库与磁盘一致
      await deleteAssetsUnderPath(kb.id, relPath)
      if (selected === relPath) setSelected(null)
      // 删掉的恰好是当前目标目录（或其父级），重置回根目录，避免继续写入已不存在的路径
      if (relPath === activeDir || (activeDir && activeDir.startsWith(relPath + '/'))) {
        setActiveDir('')
      }
      await afterFsChange()
      // 删除成功不弹提示（用户要求仅异常场景提示）
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 选中文件：高亮该文件，并把上传 / 新建目标目录定位到它所在的文件夹。 */
  function handleSelectFile(rel: string) {
    setSelected(rel)
    const i = rel.lastIndexOf('/')
    setActiveDir(i < 0 ? '' : rel.slice(0, i))
  }

  /** 拖拽移动条目：把 fromRel 移动到 toDirRel 目录下（toDirRel 为空串表示根目录）。 */
  async function handleMoveEntry(fromRel: string, toDirRel: string) {
    if (!kb?.path) return
    // 不能移动到自身或自己的子目录内
    if (toDirRel === fromRel || (toDirRel !== '' && toDirRel.startsWith(fromRel + '/'))) {
      message.warning('不能移动到自身或子目录内')
      return
    }
    const r = await moveKbEntry(kb.path, fromRel, toDirRel)
    if (!result(r, '', '移动失败', true)) return
    // 若移动的是当前选中文件，更新其选中路径与上传目标目录
    if (selected === fromRel) {
      const base = fromRel.split('/').pop() || fromRel
      const newRel = toDirRel ? `${toDirRel}/${base}` : base
      setSelected(newRel)
      setActiveDir(toDirRel)
    } else if (activeDir === fromRel || (activeDir !== '' && activeDir.startsWith(fromRel + '/'))) {
      // 上传目标目录被移动，同步到新位置
      const base = fromRel.split('/').pop() || fromRel
      setActiveDir(toDirRel ? `${toDirRel}/${base}` : base)
    }
    await afterFsChange()
  }

  /** 定位：展开当前选中文件的祖先目录并滚动到其所在行，同时高亮其所在目录。 */
  function handleLocate() {
    if (!selected) {
      message.warning('请先在右侧选择一个文件')
      return
    }
    const parent = selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : ''
    setActiveDir(parent)
    setLocateNonce((n) => n + 1)
  }

  /* ----------------------------- 知识库索引（K1' 第四期） ----------------------------- */

  /** 索引进度事件载荷（Rust agent-kb-index-progress）。 */
  interface KbIndexProgressPayload {
    kbId: string
    phase: string
    done: number
    total: number
    assetId?: string
    message?: string
    finished: boolean
  }

  /** 索引状态摘要（indexedAt 非空视为已索引）。 */
  const [indexStat, setIndexStat] = useState<{ indexed: number; total: number } | null>(null)
  /** 重建运行态（null = 空闲）。 */
  const [rebuild, setRebuild] = useState<{ running: boolean; done: number; total: number; message?: string } | null>(null)
  // K3-3 标签：资产清单（含 meta_data.tags）+ 悬浮标签面板（右侧固定 icon 展开）
  const [assets, setAssets] = useState<KnowledgeAsset[]>([])
  const [tagPanelOpen, setTagPanelOpen] = useState(false)
  /** 面板内改名态：正在编辑的标签名 + 输入值（null = 非编辑态）。 */
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  /** 面板底部注入输入框。 */
  const [tagInput, setTagInput] = useState('')
  /** 牙齿标签条点击跳转：每个标签的命中文件循环游标（per-tag 记忆上次定位到第几个）。 */
  const tagJumpIdxRef = useRef<Map<string, number>>(new Map())
  const kbIdRef = useRef<string | null>(null)
  useEffect(() => {
    kbIdRef.current = kb?.id ?? null
  }, [kb?.id])

  const loadIndexStat = useCallback(async () => {
    if (!id || !isTauri) return
    try {
      const assets = await listAssets(id)
      const indexed = assets.filter((a) => !!a.indexedAt).length
      setIndexStat({ indexed, total: assets.length })
      setAssets(assets)
    } catch {
      /* 状态摘要失败静默（不影响文件管理） */
    }
  }, [id])

  useEffect(() => {
    void loadIndexStat()
  }, [loadIndexStat])

  // 监听索引进度事件：按 kbId 过滤（其他知识库的重建不串台）
  // （台账 S12 ③：订阅统一走 useTauriEvent；非 Tauri 环境由其内部 catch 兜底）
  useTauriEvent<KbIndexProgressPayload>('agent-kb-index-progress', (p) => {
    if (p.kbId !== kbIdRef.current) return
    setRebuild({ running: !p.finished, done: p.done, total: p.total, message: p.message })
    if (p.finished) {
      if (p.phase === 'done' && p.message) message.success(p.message)
      void loadIndexStat()
    }
  })

  async function handleRebuild() {
    if (!kb || !isTauri) return
    try {
      const r = await invoke<{ started: boolean; reason?: string }>('kb_rebuild_index', {
        input: { kbId: kb.id },
      })
      if (!r.started) {
        setRebuild({ running: true, done: 0, total: 0 })
        message.warning(r.reason || '重建任务进行中')
        return
      }
      setRebuild({ running: true, done: 0, total: 0 })
    } catch (e) {
      message.error(`重建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /* --------------------- K3-3 标签悬浮面板（右侧固定入口） --------------------- */

  /** 标签聚合：本库全部资产的 meta_data.tags → { 标签: 资产数 }（按数量降序）。 */
  const tagCloud = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of assets) {
      for (const t of parseAssetTags(a.metaData)) {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [assets])

  /** 选中文件对应的资产（面板标签操作的绑定对象）。 */
  const selectedAsset = useMemo(
    () => assets.find((a) => a.filePath === selected),
    [assets, selected],
  )
  const selectedTags = useMemo(
    () => (selectedAsset ? parseAssetTags(selectedAsset.metaData) : []),
    [selectedAsset],
  )

  /** 彩虹随机色（同标签恒色）：标签名 hash → HSL 色相，浅底深字。 */
  const tagStyle = (tag: string): React.CSSProperties => {
    let h = 0
    for (const ch of tag) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360
    return {
      background: `hsl(${h} 72% 90%)`,
      color: `hsl(${h} 65% 30%)`,
      borderColor: `hsl(${h} 55% 76%)`,
    }
  }

  const refreshAfterTagChange = async () => {
    await loadIndexStat()
  }

  /** 注入：把标签加到当前文件（已存在则忽略）。 */
  const addTagToFile = async (tag: string) => {
    if (!selectedAsset || !tag.trim()) return
    const t = tag.trim()
    const cur = parseAssetTags(selectedAsset.metaData)
    if (cur.includes(t)) {
      message.warning(`当前文件已有标签「${t}」`)
      return
    }
    await updateAssetTags(selectedAsset.id, [...cur, t])
    await refreshAfterTagChange()
  }

  /** 删除：从当前文件移除标签。 */
  const removeTagFromFile = async (tag: string) => {
    if (!selectedAsset) return
    await updateAssetTags(
      selectedAsset.id,
      parseAssetTags(selectedAsset.metaData).filter((t) => t !== tag),
    )
    await refreshAfterTagChange()
  }

  /** 编辑：在当前文件内把标签改名（保持原顺序）。 */
  const renameTagInFile = async (from: string, to: string) => {
    if (!selectedAsset || !to.trim() || to === from) return
    await updateAssetTags(
      selectedAsset.id,
      parseAssetTags(selectedAsset.metaData).map((t) => (t === from ? to.trim() : t)),
    )
    await refreshAfterTagChange()
  }

  if (loading) {
    return (
      <div className="kb-detail">
        <div className="kb-detail__loading">
          <Spin size="large" tip="正在加载知识库..." />
        </div>
      </div>
    )
  }

  return (
    <div className="kb-detail">
      <div className="kb-detail__topbar">
        <div className="kb-detail__nav">
          <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.knowledge)}>
            <ArrowLeft size={16} />
            返回知识库列表
          </Button>
        </div>

        {kb ? (
          <div className="kb-detail__header">
            <div className="kb-detail__header-info">
                <div className="kb-detail__title-row">
                  <div className="kb-detail__logo">
                    {kb.logo ? <img src={kb.logo} alt={kb.name} /> : <BookOpen size={22} />}
                  </div>
                  <h1 className="kb-detail__title">{kb.name}</h1>
                </div>
              <p className="kb-detail__desc" title={kb.description || undefined}>
                {kb.description || '暂无简介'}
              </p>
              <div className="kb-detail__meta">
                <span className="kb-detail__meta-item">
                  <FileText size={13} /> {kb.fileCount ?? 0} 个文件
                </span>
                <span className="kb-detail__meta-item">
                  <HardDrive size={13} /> {formatBytes(kb.fileSize ?? 0)}
                </span>
                <span className="kb-detail__meta-item">更新于 {formatRelativeTime(kb.updatedAt)}</span>
              </div>
              {/* K1' 索引行：进度提示（重建入口在目录树工具栏，索引量经按钮底色体现，不再展示文字统计） */}
              {isTauri && (
                <div className="kb-detail__index-row">
                  {rebuild?.running && (
                    <div className="kb-detail__index-progress">
                      <Progress
                        percent={rebuild.total ? Math.round((rebuild.done / rebuild.total) * 100) : 0}
                        size="small"
                      />
                      <span className="kb-detail__index-progress-msg" title={rebuild.message}>
                        {rebuild.message || '正在重建…'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {kb ? (
        <div className="kb-detail__block kb-detail__block--fill">
            <h4 className="kb-detail__block-title">文件树</h4>
            <div className="kb-detail__explorer">
              <aside className="kb-detail__explorer-tree">
                <div className="kb-detail__explorer-tree-title">
                  <span className="kb-detail__tree-title-left">
                    目录
                    {activeDir && <span className="kb-tree__active-dir">{activeDir}</span>}
                  </span>
                <div className="kb-detail__tree-tools">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={
                      indexStat
                        ? `重建索引（已索引 ${indexStat.indexed} 个资产，越多底色越红）`
                        : '重建索引'
                    }
                    disabled={!!rebuild?.running}
                    onClick={handleRebuild}
                    style={
                      indexStat && indexStat.indexed > 0
                        ? (() => {
                            // K3-3 用户方案：索引越多背景越红（20 个封顶全红）
                            const i = Math.min(indexStat.indexed / 20, 1)
                            return {
                              background: `hsl(4 ${30 + 50 * i}% ${94 - 46 * i}%)`,
                              borderColor: `hsl(4 60% ${80 - 30 * i}%)`,
                              color: `hsl(4 70% ${30 - 10 * i}%)`,
                            }
                          })()
                        : undefined
                    }
                  >
                    <DatabaseZap size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="定位当前文件所在目录"
                    disabled={!selected}
                    onClick={handleLocate}
                  >
                    <Locate size={15} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" title="新建文件夹" onClick={() => setFolderOpen(true)}>
                    <FolderPlus size={15} />
                  </Button>
                    <Button variant="ghost" size="icon-sm" title="新建 Markdown 文件" onClick={() => setMdOpen(true)}>
                      <FilePlus size={15} />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="导入文件" onClick={() => importRef.current?.click()}>
                      <Upload size={15} />
                    </Button>
                    <input
                      ref={importRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        void doImport(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </div>
                </div>
                <div className="kb-detail__explorer-tree-body">
                  {loadingTree ? (
                    <div className="kb-detail__loading">
                      <Spin size="small" tip="正在读取目录..." />
                    </div>
                  ) : (
                    <KnowledgeFileTree
                      tree={tree}
                      selectedPath={selected}
                      activeDir={activeDir}
                      onSelectFile={handleSelectFile}
                      onSelectFolder={setActiveDir}
                      onDeletePath={handleDeleteEntry}
                      onMoveEntry={handleMoveEntry}
                      locateNonce={locateNonce}
                    />
                  )}
                </div>
              </aside>

              <div className="kb-detail__explorer-view">
                {selected ? (
                  <MultiFileViewer
                    kb={kb}
                    relPath={selected}
                    onFileChanged={() => {
                      // 编辑保存后静默刷新：digest 变化 → 增量索引重切该文件进向量库
                      void refreshAssets(kb).catch(() => {})
                    }}
                  />
                ) : (
                  <div className="kb-detail__muted">请从左侧选择一个文件</div>
                )}
              </div>
            </div>
          </div>
      ) : (
        <div className="kb-detail__empty">
          <Empty description="未找到该知识库" />
        </div>
      )}

      {/* K3-3 标签悬浮栈：右缘 icon（管理入口，恒显）+ 牙齿式标签条竖排
          （彩虹随机色、hover 向左抽出展开、点击循环定位命中文件）。 */}
      {isTauri && kb && (
        <div className="kb-detail__tagstack">
          <button
            type="button"
            className={`kb-detail__float-tag${tagPanelOpen ? ' kb-detail__float-tag--open' : ''}`}
            title={
              tagCloud.length > 0
                ? `标签管理（全库 ${tagCloud.length} 个标签）`
                : '标签管理（暂无标签，选中文件后注入）'
            }
            disabled={!selectedAsset && tagCloud.length === 0}
            onClick={() => setTagPanelOpen((v) => !v)}
          >
            <Tags size={17} />
          </button>
          {tagCloud.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              className="kb-detail__tagdrawer"
              style={tagStyle(tag)}
              title={`${tag} · ${count} 个文件（点击定位）`}
              onClick={() => {
                const paths = assets
                  .filter((a) => parseAssetTags(a.metaData).includes(tag))
                  .map((a) => a.filePath)
                  .sort()
                if (paths.length === 0) return
                // 同一标签多次点击：在命中文件间循环切换
                const idx = (tagJumpIdxRef.current.get(tag) ?? 0) % paths.length
                tagJumpIdxRef.current.set(tag, idx + 1)
                setSelected(paths[idx])
                setLocateNonce((n) => n + 1)
              }}
            >
              <span className="kb-detail__tagdrawer-name">{tag}</span>
              <span className="kb-detail__tagdrawer-n">{count}</span>
            </button>
          ))}
        </div>
      )}
      {tagPanelOpen && (
        <div className="kb-detail__tagpanel">
          <div className="kb-detail__tagpanel-chips">
            {!selected && (
              <span className="kb-detail__tagpanel-empty">请先在左侧选择一个文件</span>
            )}
            {selected && selectedTags.length === 0 && (
              <span className="kb-detail__tagpanel-empty">未打标签，输入后回车注入</span>
            )}
            {selectedTags.map((t) =>
              editingTag === t ? (
                <Input
                  key={t}
                  value={editingValue}
                  autoFocus
                  onChange={(e) => setEditingValue(e.target.value)}
                  onBlur={() => {
                    void renameTagInFile(t, editingValue)
                    setEditingTag(null)
                  }}
                  onPressEnter={() => {
                    void renameTagInFile(t, editingValue)
                    setEditingTag(null)
                  }}
                  style={{ width: 110 }}
                />
              ) : (
                <span key={t} className="kb-detail__tagchip" style={tagStyle(t)}>
                  <button
                    type="button"
                    className="kb-detail__tagchip-name"
                    title={`点击改名：${t}`}
                    onClick={() => {
                      setEditingTag(t)
                      setEditingValue(t)
                    }}
                  >
                    {t}
                  </button>
                  <button
                    type="button"
                    className="kb-detail__tagchip-x"
                    title="从当前文件删除"
                    onClick={() => void removeTagFromFile(t)}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
          </div>
          <Input
            value={tagInput}
            placeholder="输入标签，回车注入当前文件"
            disabled={!selectedAsset}
            onChange={(e) => setTagInput(e.target.value)}
            onPressEnter={() => {
              void addTagToFile(tagInput)
              setTagInput('')
            }}
          />
        </div>
      )}

      <Modal
        open={folderOpen}
        onOk={doCreateFolder}
        confirmLoading={busy}
        onOpenChange={(o) => {
          if (!o) setFolderOpen(false)
        }}
        title="新建文件夹"
        okText="创建"
        cancelText="取消"
      >
        <Field>
          <FieldLabel>文件夹名称</FieldLabel>
          <Input value={folderName} placeholder="如 docs / images" onChange={(e) => setFolderName(e.target.value)} onPressEnter={doCreateFolder} />
        </Field>
      </Modal>

      <Modal
        open={mdOpen}
        onOk={doCreateMarkdown}
        confirmLoading={busy}
        onOpenChange={(o) => {
          if (!o) setMdOpen(false)
        }}
        title="新建 Markdown 文件"
        okText="创建"
        cancelText="取消"
      >
        <Field>
          <FieldLabel>文件名（.md 结尾）</FieldLabel>
          <Input value={mdName} placeholder="如 README.md" onChange={(e) => setMdName(e.target.value)} onPressEnter={doCreateMarkdown} />
        </Field>
      </Modal>
    </div>
  )
}

/** 递归找到目录树中第一个文件节点的 relPath。 */
function findFirstFile(node: KbFileTreeNode): string | null {
  for (const c of node.children) {
    if (!c.isDir) return c.relPath
    const r = findFirstFile(c)
    if (r) return r
  }
  return null
}
