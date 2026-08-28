/**
 * 路由页面「Skill」：技能能力单元管理。
 * 卡片风格、分页布局整体对齐 MCP 模块（header + 侧栏 + 主区两栏 + Card 卡片网格 + 分页），
 * 仅展示内容不同。数据持久化走 src/core/mapper/skill-mapper.ts（SQLite：workduo.db），
 * 文件落盘走 src/core/file/skillFs.ts（<skill_path>/<identifier>/ 目录骨架）。
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
  type LucideIcon,
  CreditCard,
  Briefcase,
  PenLine,
  Code2,
  BarChart3,
  Palette,
  Bot,
  BookOpen,
  Building2,
  GraduationCap,
  ShieldCheck,
  Coffee,
} from 'lucide-react'
import { Button, Card, Input, Switch } from '@/components/ui'
import { Popconfirm, message, Empty, Spin, Pagination, Tooltip } from 'antd'
import {
  listSkills,
  upsertSkill,
  deleteSkill,
  setSkillStatus,
  resolveSkillBasePath,
} from '@/core/mapper/skill-mapper'
import {
  getSkillCategoryLabel,
  SKILL_CATEGORY_OPTIONS,
  type SkillInfo,
  type SkillFormData,
} from '@/core/file/skill-file'
import { persistSkillFiles, removeSkillDir } from '@/core/file/skillFs'
import { SkillFormModal } from './components/SkillFormModal'
import { SkillDetailDrawer } from './components/SkillDetailDrawer'
import { SkillImportModal } from './components/SkillImportModal'
import './index.scss'

const PAGE_SIZE = 12

/** 分类 -> 图标（侧栏展示，与卡片风格统一）。 */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  all: LayoutGrid,
  'pay-skill': CreditCard,
  'office-efficiency': Briefcase,
  'content-creation': PenLine,
  'dev-programming': Code2,
  'data-analysis': BarChart3,
  'design-media': Palette,
  'ai-agent': Bot,
  'knowledge-management': BookOpen,
  'business-ops': Building2,
  education: GraduationCap,
  professional: Briefcase,
  'it-ops-security': ShieldCheck,
  'life-service': Coffee,
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

  async function handleSave(data: SkillFormData) {
    const rawBase = await resolveSkillBasePath()
    const list = await upsertSkill(data.skill)
    setRecords(list)
    const res = await persistSkillFiles(rawBase, data.skill, data.scripts, data.resources)
    if (res) {
      const parts = [
        res.written.skillMd ? 'SKILL.md' : '',
        `${res.written.scripts} 个脚本`,
        `${res.written.resources} 个资源`,
      ].filter(Boolean)
      message.success(`技能已${editing ? '更新' : '创建'}，已落盘 ${parts.join('、')}`)
    } else {
      message.success(editing ? '技能已更新' : '技能已创建')
    }
  }

  async function handleDelete(s: SkillInfo) {
    const rawBase = await resolveSkillBasePath()
    setRecords(await deleteSkill(s.id))
    await removeSkillDir(rawBase, s.identifier).catch(() => {})
    message.success('技能已删除')
  }

  async function handleImport(data: SkillFormData) {
    const rawBase = await resolveSkillBasePath()
    const list = await upsertSkill(data.skill)
    setRecords(list)
    await persistSkillFiles(rawBase, data.skill, data.scripts, data.resources)
    message.success('导入完成')
  }

  async function handleToggle(s: SkillInfo) {
    const next = s.status === 1 ? 0 : 1
    setRecords(await setSkillStatus(s.id, next))
    message.success(next === 1 ? '已启用' : '已禁用')
  }

  return (
    <div className="skillhub">
      {/* 顶部 Header：标题 / 描述 + 搜索框 + 操作按钮（整行横跨，位于侧栏上方） */}
      <header className="skillhub__head">
        <div>
          <h2 className="skillhub__title">技能中心</h2>
          <p className="skillhub__lead">
            管理本地自建与导入的技能能力单元，为智能体与工作流提供可复用能力。
          </p>
        </div>
        <div className="skillhub__actions">
          <Input
            allowClear
            placeholder="搜索技能名称 / 标识 / 描述"
            prefix={<Search size={14} color="var(--color-foreground-muted)" />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => setCurrentPage(1)}
            style={{ width: 280 }}
          />
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

      {/* 侧栏 + 主内容 两栏 */}
      <div className="skillhub__layout">
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
              const Icon = CATEGORY_ICON[cat.value] ?? LayoutGrid
              return (
                <button
                  key={cat.value}
                  type="button"
                  className={`skillhub__cat-item${isActive ? ' is-active' : ''}`}
                  onClick={() => setScenarioFilter(cat.value)}
                >
                  <Icon size={15} className="skillhub__cat-icon" />
                  <span className="skillhub__cat-label">{cat.label}</span>
                  {count > 0 && <span className="skillhub__cat-count">{count}</span>}
                </button>
              )
            })}
          </div>
        </aside>

        <div className="skillhub__main">
          <Spin spinning={loading} wrapperClassName="skillhub__spin">
            {pageRecords.length > 0 ? (
              <div className="skillhub-grid">
                {pageRecords.map((skill) => (
                  <Card
                    key={skill.id}
                    frame="solid"
                    className="skillhub-grid-item"
                    onClick={() => openView(skill)}
                  >
                    <div className="skillhub-grid-item__status-wrap">
                      <span
                        className={`skillhub-grid-item__status${
                          skill.status === 1
                            ? ' skillhub-grid-item__status--on'
                            : ' skillhub-grid-item__status--off'
                        }`}
                      >
                        {skill.status === 1 ? '已启用' : '已禁用'}
                      </span>
                    </div>

                    <div className="skillhub-grid-item__head">
                      <div className="skillhub-grid-item__avatar">
                        <Zap size={18} />
                      </div>
                      <div className="skillhub-grid-item__titles">
                        <Tooltip title={skill.name}>
                          <h3 className="skillhub-grid-item__name">{skill.name}</h3>
                        </Tooltip>
                        <code className="skillhub-grid-item__identifier">
                          {skill.identifier}
                        </code>
                      </div>
                    </div>

                    <div className="skillhub-grid-item__tags">
                      <span className="skillhub-grid-item__chip">
                        {getSkillCategoryLabel(skill.scenario)}
                      </span>
                      {(skill.tags ?? []).slice(0, 2).map((t, i) => (
                        <span key={`${t}-${i}`} className="skillhub-grid-item__chip skillhub-grid-item__chip--muted">
                          {t}
                        </span>
                      ))}
                    </div>

                    <p className="skillhub-grid-item__desc" title={skill.description}>
                      {skill.description || '暂无描述'}
                    </p>

                    <div
                      className="skillhub-grid-item__actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip title="编辑">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="编辑"
                          onClick={() => openEdit(skill)}
                        >
                          <Pencil size={16} />
                        </Button>
                      </Tooltip>
                      <Tooltip title="详情">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="详情"
                          onClick={() => openView(skill)}
                        >
                          <Eye size={16} />
                        </Button>
                      </Tooltip>
                      <Popconfirm
                        title="确定删除该技能吗？"
                        okText="确定"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleDelete(skill)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="skillhub-grid-item__del"
                          aria-label="删除"
                          title="删除"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </Popconfirm>
                      <Switch
                        size="small"
                        checked={skill.status === 1}
                        onChange={() => handleToggle(skill)}
                        aria-label="启用开关"
                        title={skill.status === 1 ? '点击禁用' : '点击启用'}
                      />
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              !loading && (
                <div className="skillhub-grid-empty">
                  <Empty description="暂无技能，点击右上角「创建技能」" />
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
