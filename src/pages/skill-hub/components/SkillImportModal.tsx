/**
 * 导入技能弹窗（对齐 E:/Codes/JT/nexus-web/src/views/skill-hub/components/SkillImportModal.tsx）。
 *
 * 三段式结构：
 *  1) 导入包拖拽 / 选择区：拖入标准 SKILL 文件夹（或点选文件夹），保留相对路径，
 *     自动解析 SKILL.md 与目录结构；Tauri 桌面端额外提供原生「选择文件夹」按钮做可靠回退；
 *  2) 导入包摘要：文件数 / 总大小 / 是否包含 SKILL.md / 是否超限；
 *  3) 基础信息表单：标识符 / 名称 / 描述 / 分类 / 标签（均由用户填写，不自动推导）。
 *
 * 提交时回传 SkillFormData（元数据 + 资源文件），由页面负责入库并落盘到
 *   skill_path/<identifier>/{scripts,references,assets,templates,SKILL.md}。
 */
import { useEffect, useState } from 'react'
import { Inbox, FolderUp } from 'lucide-react'
import { Button, Modal, Input, Field, FieldLabel, Select } from '@/components/ui'
import { Upload, Tag, Divider, Alert, message } from 'antd'
import {
  createEmptySkill,
  SKILL_CATEGORY_OPTIONS,
  type SkillInfo,
  type SkillFormData,
  type ResourceFile,
} from '@/core/file/skill-file'
import type { SkillCategory } from '@/types/core'
import { isTauri } from '@/core/config'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readDir, readFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'

export interface SkillImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (data: SkillFormData) => Promise<void> | void
}

/** 已捕获的文件：name = basename；relPath = 相对技能根目录的路径（不含顶层文件夹），'/' 分隔。 */
interface CapturedFile {
  name: string
  relPath: string
  data: Uint8Array
  size: number
}

const MAX_FILES = 200
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 // 10.00 MB

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
}

/** 递归读取文件夹（Tauri 原生选择），relPath 从文件夹根开始。 */
async function readFolderTree(dir: string): Promise<CapturedFile[]> {
  const out: CapturedFile[] = []
  const walk = async (d: string, base: string): Promise<void> => {
    const entries = await readDir(d)
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isFile) {
        const data = (await readFile(await join(d, e.name))) as Uint8Array
        out.push({ name: e.name, relPath: rel, data, size: data.byteLength })
      } else if (e.isDirectory) {
        await walk(await join(d, e.name), rel)
      }
    }
  }
  await walk(dir, '')
  return out
}

/** 求一组目录的最长公共前缀（以 '/' 分隔）；无公共前缀返回 ''。 */
function commonDirPrefix(dirs: string[]): string {
  if (!dirs.length) return ''
  let prefix = dirs[0].split('/')
  for (const d of dirs.slice(1)) {
    const s = d.split('/')
    let i = 0
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix.length) break
  }
  return prefix.join('/')
}

/** 解压 ZIP 压缩包（Uint8Array）为 CapturedFile[]：按公共顶层目录剥离，父目录作为资源相对路径。 */
async function unzipCaptured(bytes: Uint8Array): Promise<CapturedFile[]> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  const dirs = entries.map((f) =>
    f.name.replace(/\\/g, '/').split('/').slice(0, -1).join('/'),
  )
  const common = commonDirPrefix(dirs)
  const out: CapturedFile[] = []
  for (const f of entries) {
    const full = f.name.replace(/\\/g, '/')
    const rel = common ? full.slice(common.length + 1) : full
    if (!rel) continue
    const data = new Uint8Array(await f.async('arraybuffer'))
    out.push({
      name: rel.split('/').pop() as string,
      relPath: rel,
      data,
      size: data.byteLength,
    })
  }
  return out
}

export function SkillImportModal({
  open,
  onOpenChange,
  onImported,
}: SkillImportModalProps) {
  const [captured, setCaptured] = useState<CapturedFile[]>([])
  const [kind, setKind] = useState<'folder' | 'zip' | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 基础信息表单（由用户填写，不自动推导）
  const [identifier, setIdentifier] = useState('')
  const [name, setGroupName] = useState('')
  const [description, setDescription] = useState('')
  const [scenario, setScenario] = useState<SkillCategory | undefined>()
  const [tags, setTags] = useState<string[]>([])
  const [errors, setErrors] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) {
      setCaptured([])
      setKind(null)
      setIdentifier('')
      setGroupName('')
      setDescription('')
      setScenario(undefined)
      setTags([])
      setErrors(new Set())
      setSubmitting(false)
    }
  }, [open])

  /** 合并捕获文件（同 relPath 覆盖）。 */
  const appendCaptured = (files: CapturedFile[]) => {
    setCaptured((prev) => {
      const map = new Map(prev.map((f) => [f.relPath, f]))
      for (const f of files) map.set(f.relPath, f)
      return [...map.values()]
    })
  }

  /** antd Upload 捕获的文件（浏览器/Tauri webview 上传，含 webkitRelativePath 的文件夹或 .zip 包）。 */
  const handleDragFile = (file: File): boolean => {
    const isZip = file.name.toLowerCase().endsWith('.zip')
    void (async () => {
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        if (isZip) {
          const files = await unzipCaptured(data)
          setKind('zip')
          appendCaptured(files)
          if (!files.length) message.warning('ZIP 压缩包为空或无法解析')
        } else {
          const relRaw = (file as unknown as { webkitRelativePath?: string })
            .webkitRelativePath
          const rel = relRaw ? relRaw.replace(/\\/g, '/').trim() : ''
          // webkitRelativePath 以顶层文件夹名开头，去掉它，保留技能根目录内的相对结构
          const stripped = rel ? rel.split('/').slice(1).join('/') : file.name
          setKind('folder')
          appendCaptured([
            {
              name: file.name,
              relPath: stripped || file.name,
              data,
              size: file.size,
            },
          ])
        }
      } catch (e) {
        message.error(`解析失败：${e instanceof Error ? e.message : String(e)}`)
      }
    })()
    return false
  }

  /** Tauri 原生选择文件夹（桌面端可靠回退，返回真实字节）。 */
  async function handleFolderDialog() {
    if (!isTauri) return
    try {
      const selected = await openDialog({ directory: true, multiple: false })
      if (!selected) return
      const tree = await readFolderTree(selected as string)
      setKind('folder')
      appendCaptured(tree)
      message.success(`已读取文件夹：${tree.length} 个文件`)
    } catch (e) {
      message.error(`读取文件夹失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Tauri 原生选择 ZIP 压缩包（桌面端可靠回退，返回真实字节）。 */
  async function handleZipDialog() {
    if (!isTauri) return
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      })
      if (!selected) return
      const bytes = (await readFile(selected as string)) as Uint8Array
      const files = await unzipCaptured(bytes)
      setKind('zip')
      appendCaptured(files)
      message.success(`已读取 ZIP 压缩包：${files.length} 个文件`)
    } catch (e) {
      message.error(`读取 ZIP 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 导入包摘要
  const packageKind: 'folder' | 'zip' | null = kind
  const packageCount = captured.length
  const packageBytes = captured.reduce((s, f) => s + f.size, 0)
  const hasSkillMd = captured.some((f) => f.name.toLowerCase() === 'skill.md')
  const overLimit = packageCount > MAX_FILES || packageBytes > MAX_TOTAL_BYTES

  function validate(): boolean {
    const errs = new Set<string>()
    if (!identifier.trim()) errs.add('identifier')
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(identifier))
      errs.add('identifier-format')
    if (!name.trim()) errs.add('name')
    setErrors(errs)
    return errs.size === 0
  }

  const hasError = (key: string) => (errors.has(key) ? 'error' : undefined)

  async function handleOk() {
    if (!validate()) {
      message.warning('请完善必填项（标识符、技能名称）')
      return
    }
    if (!packageKind) {
      message.warning('请先选择文件夹或 ZIP 压缩包')
      return
    }
    if (overLimit) {
      message.error(
        `导入包超过限制：最多 ${MAX_FILES} 个文件、总大小 10.00 MB（当前 ${packageCount} 个 / ${formatSize(packageBytes)}）`,
      )
      return
    }
    setSubmitting(true)
    try {
      const skillMd = captured.find((f) => f.name.toLowerCase() === 'skill.md')
      const skillMarkdown = skillMd
        ? new TextDecoder().decode(skillMd.data)
        : ''
      const resources: ResourceFile[] = captured
        .filter((f) => f.name.toLowerCase() !== 'skill.md')
        .map((f) => {
          const idx = f.relPath.lastIndexOf('/')
          const dir = idx >= 0 ? f.relPath.slice(0, idx) : ''
          const fname = idx >= 0 ? f.relPath.slice(idx + 1) : f.relPath
          return { id: crypto.randomUUID(), name: fname, dir, data: f.data }
        })
      const skill: SkillInfo = {
        ...createEmptySkill(),
        identifier: identifier.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        scenario,
        tags: tags.length ? tags : undefined,
        // 导入时 SKILL.md 即作为正文；instruction 一并初始化（两字段独立，可后续分别编辑）
        instruction: skillMarkdown,
        skillMarkdown,
      }
      await onImported({ skill, scripts: [], resources })
      onOpenChange(false)
    } catch (e) {
      message.error(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      title="导入技能"
      description="拖入文件夹或选择 ZIP 压缩包，并填写基础信息后提交；系统会自动解析 SKILL.md、入库并落盘。"
      style={{ top: 24, maxWidth: '92vw' }}
      footer={
        <div className="sk__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={submitting} onClick={handleOk}>
            保存
          </Button>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="导入的文件夹 / ZIP 压缩包结构会原样落盘到 skill_path/<标识符>/ 下（scripts / references / assets / templates / SKILL.md）。"
      />

      {/* 1) 导入包拖拽 / 选择区 */}
      <div className="sk-import__dropzone">
        <Upload.Dragger
          multiple
          directory
          showUploadList={false}
          beforeUpload={(f) => handleDragFile(f as unknown as File)}
        >
          <p className="sk-import__dropzone-icon">
            <Inbox size={40} color="var(--color-foreground-muted)" />
          </p>
          <p className="sk-import__dropzone-title">拖拽文件夹到此处</p>
          <p className="sk-import__dropzone-hint">
            也可直接拖入 .zip 压缩包（最多 {MAX_FILES} 个文件，总大小不超过 10.00 MB）
          </p>
        </Upload.Dragger>

        <div className="sk-import__dropzone-actions">
          <span className="sk-import__dropzone-label">选择文件夹</span>
          <Upload
            directory
            multiple
            showUploadList={false}
            beforeUpload={(f) => handleDragFile(f as unknown as File)}
          >
            <Button icon={<FolderUp size={14} />}>选择文件夹</Button>
          </Upload>
          {isTauri && (
            <Button icon={<FolderUp size={14} />} onClick={handleFolderDialog}>
              选择文件夹（本地）
            </Button>
          )}
        </div>

        <Divider plain style={{ margin: '12px 0' }}>或</Divider>

        <div className="sk-import__dropzone-actions">
          <span className="sk-import__dropzone-label">选择 ZIP 压缩包</span>
          <Upload
            accept=".zip"
            multiple={false}
            showUploadList={false}
            beforeUpload={(f) => handleDragFile(f as unknown as File)}
          >
            <Button icon={<Inbox size={14} />}>选择 ZIP 压缩包</Button>
          </Upload>
          {isTauri && (
            <Button icon={<Inbox size={14} />} onClick={handleZipDialog}>
              选择 ZIP 压缩包（本地）
            </Button>
          )}
        </div>
      </div>

      {/* 2) 导入包摘要 */}
      {packageKind && (
        <div className="sk-import__summary">
          <Divider plain style={{ margin: '12px 0' }}>
            已选择导入包
          </Divider>
          <div className="sk-import__summary-row">
            <Tag color="blue">{kind === 'zip' ? 'ZIP 压缩包' : '文件夹'}</Tag>
            <span>
              文件数：<b>{packageCount}</b>
            </span>
            <span>
              总大小：<b>{formatSize(packageBytes)}</b>
            </span>
            {hasSkillMd ? (
              <Tag color="success">已包含 SKILL.md</Tag>
            ) : (
              <Tag color="warning">未检测到 SKILL.md</Tag>
            )}
            {overLimit && <Tag color="error">超出限制</Tag>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            style={{ paddingLeft: 0 }}
            onClick={() => setCaptured([])}
          >
            重新选择
          </Button>
        </div>
      )}

      <Divider plain>基础信息</Divider>

      {/* 3) 基础信息表单（由用户填写） */}
      <div className="sk__grid">
        <Field>
          <FieldLabel>
            标识符 (identifier)<span className="sk__required">*</span>
          </FieldLabel>
          <Input
            value={identifier}
            status={
              hasError('identifier') || hasError('identifier-format')
                ? 'error'
                : undefined
            }
            placeholder="如 doc-polish（仅小写字母、数字、连字符，即目录名）"
            onChange={(e) => setIdentifier(e.target.value)}
          />
          {errors.has('identifier-format') && (
            <div className="sk__field-error">
              标识符仅允许小写字母、数字与连字符，且不能以连字符开头
            </div>
          )}
        </Field>

        <Field>
          <FieldLabel>
            技能名称<span className="sk__required">*</span>
          </FieldLabel>
          <Input
            value={name}
            status={hasError('name')}
            placeholder="如 文档润色"
            onChange={(e) => setGroupName(e.target.value)}
          />
        </Field>

        <Field className="sk__span-2">
          <FieldLabel>描述</FieldLabel>
          <Input.TextArea
            rows={2}
            value={description}
            placeholder="一句话描述这个技能的能力"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel>技能分类 (scenario)</FieldLabel>
          <Select
            value={scenario}
            options={SKILL_CATEGORY_OPTIONS as never}
            allowClear
            placeholder="选择分类"
            onChange={(v) => setScenario((v as SkillCategory) ?? undefined)}
          />
        </Field>

        <Field>
          <FieldLabel>标签</FieldLabel>
          <Select
            mode="tags"
            value={tags}
            placeholder="输入后回车，如 文档润色"
            tokenSeparators={[',']}
            onChange={(v) => setTags(v as string[])}
          />
        </Field>
      </div>
    </Modal>
  )
}
