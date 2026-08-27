/**
 * 路由页面「Skill」：技能能力单元管理。
 * - 左侧分类侧栏（对应 scenario / SkillCategory）；
 * - 顶部关键词搜索 + 工具栏（导入 / 创建）；
 * - 卡片网格 + 分页；
 * - 新建/编辑弹窗、详情抽屉、导入弹窗。
 *
 * 参考 nexus-web 的 skill-hub 布局，但按本地 SQLite schema 裁剪字段
 * （去掉 avatar / version / scope / status / fileList 等无对应列的项）。
 * 数据持久化走 src/core/mapper/skill-mapper.ts（SQLite：workduo.db）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Search,
  Plus,
  Upload,
  Pencil,
  Eye,
  Trash2,
  Zap,
  LayoutGrid,
  Calendar,
} from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { Tag, Popconfirm, message, Empty, Spin, Pagination, Tooltip } from 'antd'
import {
  listSkills,
  upsertSkill,
  deleteSkill,
} from '@/core/mapper/skill-mapper'
import {
  getSkillCategoryLabel,
  SKILL_CATEGORY_OPTIONS,
  type SkillInfo,
} from '@/core/file/skill-file'
import { SkillFormModal } from './components/SkillFormModal'
import { SkillDetailDrawer } from './components/SkillDetailDrawer'
import { SkillImportModal } from './components/SkillImportModal'
import './index.scss'

const PAGE_SIZE = 12

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function SkillHubPage() {
  const [scenarioFilter, setScenarioFilter] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [records, setRecords] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SkillInfo | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [viewing, setViewing] = useState<SkillInfo | null>(null)
  const [currentPage, setCurrentPage] = useState(1)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setRecords(await listSkills())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return records.filter((s) => {
      if (scenarioFilter !== 'all' && s.scenario !== scenarioFilter) return false
      if (
        kw &&
        !`${s.name} ${s.identifier} ${s.description ?? ''}`.toLowerCase().includes(kw)
      )
        return false
      return true
    })
  }, [records, scenarioFilter, keyword])

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 过滤条件变化或越界时回到第一页
  useEffect(() => {
    setCurrentPage(1)
  }, [scenarioFilter, keyword])
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const pageRecords = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  // 各分类数量徽章
  const counts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const s of records) {
      const k = s.scenario ?? 'uncategorized'
      acc[k] = (acc[k] ?? 0) + 1
    }
    return acc
  }, [records])

  const categories = useMemo(
    () => [{ value: 'all', label: '全部技能' }, ...SKILL_CATEGORY_OPTIONS],
    [],
  )

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(s: SkillInfo) {
    setEditing(s)
    setModalOpen(true)
  }

  function openView(s: SkillInfo) {
    setViewing(s)
    setDrawerOpen(true)
  }

  async function handleSave(s: SkillInfo) {
    setRecords(await upsertSkill(s))
    message.success(editing ? '技能已更新' : '技能已创建')
  }

  async function handleDelete(s: SkillInfo) {
    setRecords(await deleteSkill(s.id))
    message.success('技能已删除')
  }

  async function handleImport(skills: SkillInfo[]) {
    let list = records
    for (const sk of skills) list = await upsertSkill(sk)
    setRecords(list)
    message.success(`已导入 ${skills.length} 个技能`)
  }

  return (
    <div className="skillhub">
      {/* 左侧分类侧栏 */}
      <aside className="skillhub__sidebar">
        <div className="skillhub__sidebar-title">
          <LayoutGrid size={15} />
          <span>技能分类</span>
        </div>
        <div className="skillhub__cat-list">
          {categories.map((cat) => {
            const isActive = scenarioFilter === cat.value
            const count =
              cat.value === 'all'
                ? records.length
                : counts[cat.value as string] ?? 0
            return (
              <div
                key={cat.value}
                className={`skillhub__cat-item ${isActive ? 'active' : ''}`}
                onClick={() => setScenarioFilter(cat.value)}
              >
                <span className="skillhub__cat-label">{cat.label}</span>
                <span className="skillhub__cat-count">{count}</span>
              </div>
            )
          })}
        </div>
      </aside>

      {/* 右侧内容 */}
      <div className="skillhub__content">
        <header className="skillhub__head">
          <div>
            <h2 className="skillhub__title">技能中心</h2>
            <p className="skillhub__lead">
              管理本地自建与导入的技能能力单元，为智能体与工作流提供可复用能力。
            </p>
          </div>
          <div className="skillhub__actions">
            <Button variant="soft" size="sm" onClick={() => setImportOpen(true)}>
              <Upload size={14} />
              导入技能
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} />
              创建技能
            </Button>
          </div>
        </header>

        <div className="skillhub__toolbar">
          <Input
            allowClear
            placeholder="搜索技能名称 / 标识 / 描述"
            prefix={<Search size={14} color="var(--color-foreground-muted)" />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => setCurrentPage(1)}
            style={{ width: 280 }}
          />
        </div>

        <Spin spinning={loading} wrapperClassName="skillhub__spin">
          {pageRecords.length > 0 ? (
            <div className="skillhub-grid">
              {pageRecords.map((skill) => (
                <div
                  key={skill.id}
                  className="skillhub-grid-item"
                  onClick={() => openView(skill)}
                >
                  <div className="skillhub-grid-item__header">
                    <div className="skillhub-grid-item__logo">
                      <Zap size={20} />
                    </div>
                    <div className="skillhub-grid-item__title-box">
                      <Tooltip title={skill.name}>
                        <h3 className="skillhub-grid-item__title">{skill.name}</h3>
                      </Tooltip>
                      <span className="skillhub-grid-item__identifier">
                        {skill.identifier}
                      </span>
                    </div>
                  </div>

                  <p className="skillhub-grid-item__desc" title={skill.description}>
                    {skill.description || '暂无描述'}
                  </p>

                  {skill.tags && skill.tags.length > 0 && (
                    <div className="skillhub-grid-item__tags">
                      {skill.tags.slice(0, 4).map((t, i) => (
                        <Tag key={`${t}-${i}`} className="skillhub-grid-item__tag">
                          {t}
                        </Tag>
                      ))}
                    </div>
                  )}

                  <div className="skillhub-grid-item__meta">
                    <span className="skillhub-grid-item__category">
                      {getSkillCategoryLabel(skill.scenario)}
                    </span>
                    <span className="skillhub-grid-item__meta-info">
                      <Calendar size={12} />
                      {formatDate(skill.createdAt)}
                    </span>
                  </div>

                  <div
                    className="skillhub-grid-item__actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="action-btn edit"
                      onClick={() => openEdit(skill)}
                    >
                      <Pencil size={13} /> 编辑
                    </button>
                    <button
                      className="action-btn view"
                      onClick={() => openView(skill)}
                    >
                      <Eye size={13} /> 详情
                    </button>
                    <Popconfirm
                      title="确定删除该技能吗？"
                      okText="确定"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDelete(skill)}
                    >
                      <button className="action-btn delete">
                        <Trash2 size={13} /> 删除
                      </button>
                    </Popconfirm>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            !loading && (
              <div className="skillhub-grid-empty">
                <Empty description="暂无技能" />
              </div>
            )
          )}
        </Spin>

        {total > 0 && (
          <div className="skillhub__pagination">
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

      <SkillFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        skill={editing}
        onSave={handleSave}
      />

      <SkillImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={handleImport}
      />

      <SkillDetailDrawer
        open={drawerOpen}
        skill={viewing}
        onClose={() => setDrawerOpen(false)}
        onEdit={(s) => {
          setDrawerOpen(false)
          openEdit(s)
        }}
      />
    </div>
  )
}
