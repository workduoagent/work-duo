/**
 * 技能详情页（路由 /skill-hub/:id）。
 *
 * 结构（技能详情与目录结构合并在同一页，不再分 Tab）：
 *  - 顶部返回导航 + 头部（头像 / 名称 / 状态 / 分类 / 描述 / 导出）；
 *  - 「技能详情」表格（Descriptions）；
 *  - 「技能文件」浏览器：左侧目录树、右侧文件内容 —— 点哪个文件就展示哪个文件，
 *    图片直接渲染，文本 / 代码走封装的 MonacoJsonEditor，指令内容走 Markdown 渲染。
 *
 * 技能编辑也在这里完成，两种入口：
 *  - 头部「编辑」：打开 SkillFormModal，改元数据 / 指令内容 / SKILL.md 正文 / 脚本 / 资源并落盘入库；
 *  - 文件浏览器「编辑」：对选中的文本文件就地编辑并保存回磁盘。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  XCircle,
  Download,
  Pencil,
  Save,
  X,
} from 'lucide-react'
import { Tag, Descriptions, Empty, Spin } from 'antd'
import { useNotify } from '@/components/ui/notify'
import { Button } from '@/components/ui'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { MonacoJsonEditor } from '@/components/code-editor'
import { getSkill, upsertSkill, resolveSkillBasePath } from '@/core/mapper/skill-mapper'
import {
  readSkillFileTree,
  readSkillFileContent,
  writeSkillFileContent,
  zipSkillDir,
  persistSkillFiles,
  type SkillFileTreeNode,
  type SkillFileContent,
} from '@/core/file/skillFs'
import { saveBinaryFile } from '@/core/file/export-file'
import {
  getSkillCategoryLabel,
  type SkillInfo,
  type SkillFormData,
} from '@/core/file/skill-file'
import { SkillAvatar } from './components/SkillAvatar'
import { SkillFileTree } from './components/SkillFileTree'
import { SkillFormModal } from './components/SkillFormModal'
import './index.scss'
import './detail.scss'

/** 「指令内容」是库里的 instruction 字段、不是磁盘文件，用哨兵路径挂在目录树首位。 */
const INSTRUCTION_KEY = '__instruction__'

/** 图片扩展名 -> MIME（用于直接展示图片）。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/** 扩展名 -> Monaco 语言 id。 */
const EXT_LANG: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  lua: 'lua',
  sql: 'sql',
  xml: 'xml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
}

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}
function isImageFile(name: string): boolean {
  return extOf(name) in IMAGE_MIME
}
function langOf(name: string): string {
  return EXT_LANG[extOf(name)] ?? 'plaintext'
}

/** 递归收集树里的全部文件节点（用于默认选中）。 */
function flattenFiles(
  node: SkillFileTreeNode | null,
  out: SkillFileTreeNode[] = [],
): SkillFileTreeNode[] {
  if (!node) return out
  for (const c of node.children) {
    if (c.isDir) flattenFiles(c, out)
    else out.push(c)
  }
  return out
}

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function StatusTag({ status }: { status: number | undefined }) {
  if (status === 1)
    return (
      <Tag color="success">
        <CheckCircle2 size={12} /> 已启用
      </Tag>
    )
  return (
    <Tag>
      <XCircle size={12} /> 已禁用
    </Tag>
  )
}

export default function SkillDetailPage() {
  const { message } = useNotify()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [skill, setSkill] = useState<SkillInfo | null>(null)
  const [tree, setTree] = useState<SkillFileTreeNode | null>(null)
  const [loadingTree, setLoadingTree] = useState(false)

  // 文件浏览器：当前选中项 / 文件内容
  const [selected, setSelected] = useState<string>(INSTRUCTION_KEY)
  const [content, setContent] = useState<SkillFileContent | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // 编辑态：editOpen = 元数据编辑弹窗；editing = 文件就地编辑
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [savingFile, setSavingFile] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  // 拉取技能 + 目录树（保存后复用它刷新页面）
  const loadSkill = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const record = await getSkill(id)
      setSkill(record ?? null)
      if (record) {
        setLoadingTree(true)
        try {
          setTree(await readSkillFileTree(record.identifier))
        } catch (e) {
          message.error(
            `读取目录结构失败：${e instanceof Error ? e.message : String(e)}`,
          )
        } finally {
          setLoadingTree(false)
        }
      }
    } finally {
      setLoading(false)
    }
  }, [id, message])

  useEffect(() => {
    void loadSkill()
  }, [loadSkill])

  /** 目录树 + 首位的「指令内容」哨兵节点。 */
  const explorerTree = useMemo<SkillFileTreeNode | null>(() => {
    if (!tree) return null
    return {
      ...tree,
      children: [
        { name: '指令内容', relPath: INSTRUCTION_KEY, isDir: false, children: [] },
        ...tree.children,
      ],
    }
  }, [tree])

  // 目录加载完成后默认选中 SKILL.md（没有则第一个文件，都没有则指令内容）
  useEffect(() => {
    if (!tree) return
    const files = flattenFiles(tree)
    const skillMd = files.find((f) => f.name.toLowerCase() === 'skill.md')
    setSelected(skillMd?.relPath ?? files[0]?.relPath ?? INSTRUCTION_KEY)
  }, [tree])

  // 切换选中文件时退出就地编辑，避免编辑器内容与新文件不同步
  useEffect(() => {
    setEditing(false)
    setDraftText('')
  }, [selected])

  // 选中文件变化时读取内容（指令内容不是磁盘文件，直接跳过）
  useEffect(() => {
    if (!skill || selected === INSTRUCTION_KEY) {
      setContent(null)
      setContentError(null)
      return
    }
    let active = true
    setLoadingContent(true)
    setContentError(null)
    void (async () => {
      const c = await readSkillFileContent(skill.identifier, selected)
      if (!active) return
      if (!c) setContentError('无法读取该文件（可能已被删除或无权限）')
      setContent(c)
      setLoadingContent(false)
    })()
    return () => {
      active = false
    }
  }, [skill, selected, reloadTick])

  // 图片文件生成 blob URL 供直出展示
  useEffect(() => {
    if (!content || !isImageFile(content.name)) {
      setImgUrl(null)
      return
    }
    const url = URL.createObjectURL(
      new Blob([content.data as BlobPart], {
        type: IMAGE_MIME[extOf(content.name)],
      }),
    )
    setImgUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [content])

  const text = useMemo(() => {
    if (!content || isImageFile(content.name)) return ''
    return new TextDecoder('utf-8').decode(content.data)
  }, [content])

  /** 当前选中是否为「指令内容」哨兵节点 */
  const isInstruction = selected === INSTRUCTION_KEY

  /**
   * 头部「编辑」保存：落盘先行，成功再入库，最后刷新详情页（含目录树）。
   * 注意：这里是编辑已有技能，失败时**不做**删目录 / 删库回滚（否则会毁掉原数据），
   * 只把异常抛给弹窗提示并保持弹窗打开。
   */
  async function handleSaveEdit(data: SkillFormData) {
    const rawBase = await resolveSkillBasePath()
    try {
      const res = await persistSkillFiles(
        rawBase,
        data.skill,
        data.scripts,
        data.resources,
      )
      await upsertSkill(data.skill)
      if (res) {
        const parts = [
          res.written.skillMd ? 'SKILL.md' : '',
          `${res.written.scripts} 个脚本`,
          `${res.written.resources} 个资源`,
        ].filter(Boolean)
        message.success(`技能已更新，已落盘 ${parts.join('、')}`)
      } else {
        message.success('技能已更新')
      }
      setEditing(false)
      setDraftText('')
      await loadSkill()
      setReloadTick((t) => t + 1)
    } catch (e) {
      // 不在这里弹提示：SkillFormModal 会捕获并展示错误，同时保持弹窗打开
      throw e
    }
  }

  /** 文件就地编辑：保存回磁盘 */
  async function handleSaveFile() {
    if (!skill || isInstruction || !content) return
    setSavingFile(true)
    try {
      const ok = await writeSkillFileContent(skill.identifier, selected, draftText)
      if (!ok) {
        message.error('保存失败：无法写入该文件')
        return
      }
      message.success(`已保存 ${content.name}`)
      setEditing(false)
      setDraftText('')
      setReloadTick((t) => t + 1)
    } finally {
      setSavingFile(false)
    }
  }

  // 单技能导出：把技能目录打包为 ZIP 并由用户选择保存位置
  async function handleExport() {
    if (!skill) return
    setExporting(true)
    try {
      const bytes = await zipSkillDir(skill.identifier)
      if (!bytes) {
        message.warning('当前环境不支持导出，或技能目录不可读')
        return
      }
      const ok = await saveBinaryFile(`${skill.identifier}.zip`, bytes)
      if (ok) message.success(`技能「${skill.name || skill.identifier}」已导出为 ZIP`)
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  if (loading) {
    return (
      <div className="skillhub-detail-page">
        <div className="skillhub-detail-page__loading">
          <Spin size="large" tip="正在加载技能详情..." />
        </div>
      </div>
    )
  }

  const viewerName = isInstruction
    ? '指令内容'
    : (content?.name ?? selected.split('/').pop() ?? '')

  function renderViewer() {
    if (isInstruction) {
      return skill?.instruction?.trim() ? (
        <MarkdownRenderer content={skill.instruction} />
      ) : (
        <span className="skillhub-detail-page__muted">暂无指令内容</span>
      )
    }
    if (loadingContent) {
      return (
        <div className="skillhub-detail-page__loading">
          <Spin tip="正在读取文件..." />
        </div>
      )
    }
    if (contentError) {
      return <span className="skillhub-detail-page__muted">{contentError}</span>
    }
    if (!content) {
      return <span className="skillhub-detail-page__muted">请从左侧选择一个文件</span>
    }
    if (isImageFile(content.name)) {
      return imgUrl ? (
        <div className="skillhub-detail-page__image-wrap">
          <img src={imgUrl} alt={content.name} className="skillhub-detail-page__image" />
        </div>
      ) : (
        <Spin tip="正在加载图片..." />
      )
    }
    return (
      <MonacoJsonEditor
        mode="code"
        readOnly={!editing}
        value={editing ? draftText : text}
        onChange={editing ? (v) => setDraftText(typeof v === 'string' ? v : '') : undefined}
        language={langOf(content.name)}
        height="100%"
      />
    )
  }

  return (
    <div className="skillhub-detail-page">
      <div className="skillhub-detail-page__nav">
        <Button variant="ghost" size="sm" onClick={() => navigate('/skill-hub')}>
          <ArrowLeft size={16} />
          返回技能列表
        </Button>
      </div>

      {skill ? (
        <>
          <div className="skillhub-detail-page__header">
            <SkillAvatar skill={skill} size={56} />
            <div className="skillhub-detail-page__header-info">
              <div className="skillhub-detail-page__title-row">
                <h1 className="skillhub-detail-page__title">{skill.name || skill.identifier}</h1>
                <StatusTag status={skill.status} />
                {skill.scenario && (
                  <Tag color="blue">{getSkillCategoryLabel(skill.scenario)}</Tag>
                )}
                <div className="skillhub-detail-page__header-actions">
                  <Button variant="soft" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil size={14} />
                    编辑
                  </Button>
                  <Button
                    variant="soft"
                    size="sm"
                    loading={exporting}
                    onClick={handleExport}
                  >
                    <Download size={14} />
                    导出
                  </Button>
                </div>
              </div>
              <p className="skillhub-detail-page__desc">{skill.description || '暂无详细描述'}</p>
            </div>
          </div>

          {/* 技能详情：表格展示 */}
          <div className="skillhub-detail-page__block">
            <h4 className="skillhub-detail-page__block-title">技能详情</h4>
            <Descriptions column={2} size="middle" bordered>
              <Descriptions.Item label="技能标识">
                <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{skill.identifier}</code>
              </Descriptions.Item>
              <Descriptions.Item label="技能名称">{skill.name || '-'}</Descriptions.Item>
              <Descriptions.Item label="分类">
                {getSkillCategoryLabel(skill.scenario) || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <StatusTag status={skill.status} />
              </Descriptions.Item>
              <Descriptions.Item label="存储路径" span={2}>
                <span className="skillhub-detail-page__url">
                  {skill.path || '-'}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                <Calendar size={13} /> {formatDate(skill.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">
                <Calendar size={13} /> {formatDate(skill.updatedAt)}
              </Descriptions.Item>
            </Descriptions>
          </div>

          {/* 技能文件：左侧目录 + 右侧内容（点文件即看内容） */}
          <div className="skillhub-detail-page__block skillhub-detail-page__block--fill">
            <h4 className="skillhub-detail-page__block-title">技能文件</h4>
            <div className="skillhub-detail-page__explorer">
              <aside className="skillhub-detail-page__explorer-tree">
                <div className="skillhub-detail-page__explorer-tree-title">目录</div>
                <div className="skillhub-detail-page__explorer-tree-body">
                  {loadingTree ? (
                    <div className="skillhub-detail-page__loading">
                      <Spin size="small" tip="正在读取目录..." />
                    </div>
                  ) : (
                    <SkillFileTree
                      tree={explorerTree}
                      selectedPath={selected}
                      onSelectFile={setSelected}
                    />
                  )}
                </div>
              </aside>

              <div className="skillhub-detail-page__explorer-view">
                <div className="skillhub-detail-page__explorer-view-head">
                  <span className="skillhub-detail-page__explorer-view-name">
                    {viewerName}
                  </span>
                  {!isInstruction && content && !isImageFile(content.name) && (
                    <Tag>{langOf(content.name)}</Tag>
                  )}
                  {!isInstruction && content && isImageFile(content.name) && (
                    <Tag color="purple">图片</Tag>
                  )}
                  {isInstruction && <Tag color="blue">指令内容</Tag>}
                  {editing && <Tag color="orange">编辑中</Tag>}

                  {/* 文本文件支持就地编辑；图片与指令内容只读 */}
                  {!isInstruction && content && !isImageFile(content.name) && (
                    <div className="skillhub-detail-page__explorer-view-actions">
                      {editing ? (
                        <>
                          <Button size="sm" loading={savingFile} onClick={handleSaveFile}>
                            <Save size={14} />
                            保存
                          </Button>
                          <Button
                            variant="soft"
                            size="sm"
                            onClick={() => {
                              setEditing(false)
                              setDraftText('')
                            }}
                          >
                            <X size={14} />
                            取消
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="soft"
                          size="sm"
                          onClick={() => {
                            setDraftText(text)
                            setEditing(true)
                          }}
                        >
                          <Pencil size={14} />
                          编辑
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="skillhub-detail-page__explorer-view-body">
                  {renderViewer()}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="skillhub-detail-page__empty">
          <Empty description="未找到相关的技能" />
        </div>
      )}

      <SkillFormModal
        open={editOpen}
        onOpenChange={setEditOpen}
        skill={skill}
        onSave={handleSaveEdit}
      />
    </div>
  )
}
