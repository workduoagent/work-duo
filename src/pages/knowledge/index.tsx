/**
 * 知识库首页（路由 /knowledge）。
 *
 * 布局：左侧「场景分类」导航栏（scenario_category scope='KB'，样式对齐 MCP 模块）+ 右侧卡片网格。
 * 卡片展示知识库名称、简介、场景标签、文件数、总大小、更新时间，点击进入详情；
 * 卡片右上角删除（Popconfirm 二次确认），删除同步清理磁盘目录与资产记录。
 *
 * 数据来自 knowledge-mapper（Tauri 走 SQLite，非 Tauri 回退 localStorage）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Pencil, FileText, HardDrive, LayoutGrid, BookOpen, Eye } from 'lucide-react'
import { Popconfirm, Empty, Spin, Pagination } from 'antd'
import { Button, Card } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  listKnowledgeBases,
  deleteKnowledgeBase,
} from '@/core/mapper/knowledge-mapper'
import { listByScope } from '@/core/mapper/scenario-mapper'
import { knowledgeDetailPath } from '@/core/router/paths'
import { formatBytes, formatRelativeTime } from '@/utils/format'
import type { KnowledgeBase } from '@/types/core'
import type { ScenarioCategory } from '@/types/core'
import { KnowledgeFormModal } from './components/KnowledgeFormModal'
import './index.scss'

const PAGE_SIZE = 12

export default function KnowledgeListPage() {
  const { message } = useNotify()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [list, setList] = useState<KnowledgeBase[]>([])
  const [scenarioFilter, setScenarioFilter] = useState<string>('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [scenarios, setScenarios] = useState<ScenarioCategory[]>([])
  const [scenarioLabels, setScenarioLabels] = useState<Record<string, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<KnowledgeBase | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setList(await listKnowledgeBases())
    } finally {
      setLoading(false)
    }
  }, [])

  const loadScenarios = useCallback(async () => {
    const sc = await listByScope('KB')
    setScenarios(sc)
    setScenarioLabels(Object.fromEntries(sc.map((s) => [s.value, s.label])))
  }, [])

  useEffect(() => {
    void reload()
    void loadScenarios()
  }, [reload, loadScenarios])

  const filtered = useMemo(() => {
    return list.filter((k) => {
      if (scenarioFilter !== 'all' && k.scenario !== scenarioFilter) return false
      return true
    })
  }, [list, scenarioFilter])

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => {
    setCurrentPage(1)
  }, [scenarioFilter])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pageRecords = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  const counts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const k of list) {
      const key = k.scenario ?? 'uncategorized'
      acc[key] = (acc[key] ?? 0) + 1
    }
    return acc
  }, [list])

  const categories = useMemo(
    () => [{ value: 'all', label: '全部知识库' }, ...scenarios.map((s) => ({ value: s.value, label: s.label }))],
    [scenarios],
  )

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }
  function openEdit(kb: KnowledgeBase) {
    setEditing(kb)
    setModalOpen(true)
  }

  async function handleDelete(kb: KnowledgeBase) {
    try {
      const next = await deleteKnowledgeBase(kb)
      setList(next)
      message.success(`已删除知识库「${kb.name}」`)
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="kb">
      <header className="kb__head">
        <div>
          <h2 className="kb__title">知识库</h2>
          <p className="kb__lead">管理本地知识库，按场景分类组织，点击卡片查看文件与内容。</p>
        </div>
        <div className="kb__actions">
          <Button variant="soft" size="sm" onClick={openCreate}>
            <Plus size={14} />
            新建知识库
          </Button>
        </div>
      </header>

      <div className="kb__layout">
        <aside className="kb__sidebar">
          <div className="kb__sidebar-title">
            <LayoutGrid size={15} />
            <span>场景分类</span>
          </div>
          <div className="kb__cat-list">
            {categories.map((cat) => {
              const isActive = scenarioFilter === cat.value
              const count =
                cat.value === 'all' ? list.length : counts[cat.value as string] ?? 0
              const Icon = cat.value === 'all' ? LayoutGrid : BookOpen
              return (
                <button
                  key={cat.value}
                  type="button"
                  className={`kb__cat-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setScenarioFilter(cat.value)}
                >
                  <Icon size={15} className="kb__cat-icon" />
                  <span className="kb__cat-label">{cat.label}</span>
                  {count > 0 && <span className="kb__cat-count">{count}</span>}
                </button>
              )
            })}
          </div>
        </aside>

        <div className="kb__main">
          <Spin spinning={loading} wrapperClassName="kb__spin">
            {pageRecords.length > 0 ? (
              <div className="kb__grid">
                {pageRecords.map((kb) => (
                  <Card
                    frame="solid"
                    key={kb.id}
                    className="kb__card"
                    onClick={() => navigate(knowledgeDetailPath(kb.id))}
                  >
                    <div className="kb__card-head">
                      <div className="kb__card-avatar">
                        {kb.logo ? (
                          <img src={kb.logo} alt={kb.name} className="kb__card-logo" />
                        ) : (
                          <BookOpen size={20} />
                        )}
                      </div>
                      <div className="kb__card-titles">
                        <h3 className="kb__card-title">{kb.name}</h3>
                        <code className="kb__card-identifier">{kb.identifier}</code>
                      </div>
                    </div>

                    <div className="kb__card-tags">
                      {kb.scenario && (
                        <span className="kb__card-chip kb__card-chip--muted">
                          {scenarioLabels[kb.scenario] ?? kb.scenario}
                        </span>
                      )}
                    </div>

                    <p className="kb__card-desc">{kb.description || '暂无简介'}</p>

                    <div className="kb__card-meta">
                      <span className="kb__card-meta-item">
                        <FileText size={13} /> {kb.fileCount ?? 0} 个文件
                      </span>
                      <span className="kb__card-meta-item">
                        <HardDrive size={13} /> {formatBytes(kb.fileSize ?? 0)}
                      </span>
                    </div>

                    <div className="kb__card-actions" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="查看"
                        onClick={() => navigate(knowledgeDetailPath(kb.id))}
                      >
                        <Eye size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="编辑"
                        onClick={() => openEdit(kb)}
                      >
                        <Pencil size={16} />
                      </Button>
                      <Popconfirm
                        title="删除知识库"
                        description="将同时删除磁盘目录与全部资产记录，不可恢复。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleDelete(kb)}
                      >
                        <Button variant="ghost" size="icon-sm" className="kb__card-del" aria-label="删除">
                          <Trash2 size={16} />
                        </Button>
                      </Popconfirm>
                      <span className="kb__card-time">更新于 {formatRelativeTime(kb.updatedAt)}</span>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              !loading && (
                <div className="kb__grid-empty">
                  <Empty description="暂无知识库，点击「新建知识库」开始" />
                </div>
              )
            )}
          </Spin>

          {total > 0 && (
            <div className="kb__pagination">
              {/* 分页器固定底部（对齐 MCP 模块） */}
              <Pagination
                total={total}
                current={currentPage}
                pageSize={PAGE_SIZE}
                showSizeChanger={false}
                onChange={(page) => setCurrentPage(page)}
              />
            </div>
          )}
        </div>
      </div>

      <KnowledgeFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        editing={editing}
        onSaved={setList}
      />
    </div>
  )
}
