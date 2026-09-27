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
import { Inbox, FolderUp, Upload as UploadIcon, X } from 'lucide-react'
import { Button, Modal, Input, Field, FieldLabel, Select, Upload, Tag, Divider, Alert } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  createEmptySkill,
  type SkillInfo,
  type SkillFormData,
  type ResourceFile,
} from '@/core/file/skill-file'
import { uint8ToBase64 } from '@/core/file/skillFs'
import { ScenarioSelect } from '@/components/scenario'
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
  const { message } = useNotify()
  const [captured, setCaptured] = useState<CapturedFile[]>([])
  const [kind, setKind] = useState<'folder' | 'zip' | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 基础信息表单（由用户填写，不自动推导）
  const [identifier, setIdentifier] = useState('')
  const [name, setGroupName] = useState('')
  const [description, setDescription] = useState('')
  const [scenario, setScenario] = useState<string | undefined>()
  const [tags, setTags] = useState<string[]>([])
  const [errors, setErrors] = useState<Set<string>>(new Set())

  // 头像（可选）：固定落盘为技能根目录 logo.<ext>，不单独入库字段
  const [logo, setLogo] = useState<{ file: ResourceFile; url: string } | null>(null)

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
      setLogo(null)
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

  async function handleLogoUpload(file: File) {
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
      message.warning('头像仅支持 png / jpg / gif / webp / svg 图片')
      return false
    }
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const ext = file.name.split('.').pop()!.toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
    const url = `data:image/${mime};base64,${uint8ToBase64(bytes)}`
    setLogo({
      file: { id: crypto.randomUUID(), name: `logo.${ext}`, dir: '', data: bytes },
      url,
    })
    message.success(`已选择头像（将落盘为 logo.${ext}）`)
  }

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
          let fname = idx >= 0 ? f.relPath.slice(idx + 1) : f.relPath
          // 头像文件统一归一化：无论原在何处，强制落到技能根目录并命名为 logo.<ext>
          const logoMatch = fname.match(/^logo\.(png|jpe?g|gif|webp|svg)$/i)
          if (logoMatch) {
            fname = `logo.${logoMatch[1].toLowerCase()}`
            return { id: crypto.randomUUID(), name: fname, dir: '', data: f.data }
          }
          return { id: crypto.randomUUID(), name: fname, dir, data: f.data }
        })
      // 表单单独上传的头像（若有）同样归一化为根目录 logo.<ext>
      if (logo) resources.push(logo.file)
      const skill: SkillInfo = {
        ...createEmptySkill(),
        identifier: identifier.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        scenario,
        tags: tags.length ? tags : undefined,
        // 导入时只把 SKILL.md 内容落为 skillMarkdown 正文。
        // 注意：instruction（Agent 指令）是与 SKILL.md 完全独立的字段，
        // 绝不要用 SKILL.md 内容去填充它（历史上曾错误地把两者画等号）。
        instruction: undefined,
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
      style={{ maxWidth: '92vw' }}
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

        {/* 两种导入来源：并排选项卡片（图标 + 标题 + 描述，悬浮高亮） */}
        <div className="sk-import__pick">
          {isTauri ? (
            <div
              className="sk-import__pick-item"
              onClick={handleFolderDialog}
              role="button"
              tabIndex={0}
            >
              <span className="sk-import__pick-icon sk-import__pick-icon--folder">
                <FolderUp size={20} />
              </span>
              <span className="sk-import__pick-text">
                <span className="sk-import__pick-title">选择文件夹</span>
                <span className="sk-import__pick-desc">本地目录，含 SKILL.md 与资源</span>
              </span>
            </div>
          ) : (
            <Upload
              directory
              multiple
              showUploadList={false}
              beforeUpload={(f) => handleDragFile(f as unknown as File)}
              style={{ display: 'block' }}
            >
              <div className="sk-import__pick-item">
                <span className="sk-import__pick-icon sk-import__pick-icon--folder">
                  <FolderUp size={20} />
                </span>
                <span className="sk-import__pick-text">
                  <span className="sk-import__pick-title">选择文件夹</span>
                  <span className="sk-import__pick-desc">本地目录，含 SKILL.md 与资源</span>
                </span>
              </div>
            </Upload>
          )}

          {isTauri ? (
            <div
              className="sk-import__pick-item"
              onClick={handleZipDialog}
              role="button"
              tabIndex={0}
            >
              <span className="sk-import__pick-icon sk-import__pick-icon--zip">
                <Inbox size={20} />
              </span>
              <span className="sk-import__pick-text">
                <span className="sk-import__pick-title">选择 ZIP 压缩包</span>
                <span className="sk-import__pick-desc">.zip 归档，自动解压解析</span>
              </span>
            </div>
          ) : (
            <Upload
              accept=".zip"
              multiple={false}
              showUploadList={false}
              beforeUpload={(f) => handleDragFile(f as unknown as File)}
              style={{ display: 'block' }}
            >
              <div className="sk-import__pick-item">
                <span className="sk-import__pick-icon sk-import__pick-icon--zip">
                  <Inbox size={20} />
                </span>
                <span className="sk-import__pick-text">
                  <span className="sk-import__pick-title">选择 ZIP 压缩包</span>
                  <span className="sk-import__pick-desc">.zip 归档，自动解压解析</span>
                </span>
              </div>
            </Upload>
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
            <Button
              variant="soft"
              size="sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setCaptured([])}
            >
              重新选择
            </Button>
          </div>
        </div>
      )}

      <Divider plain>基础信息</Divider>

      {/* 3) 基础信息表单（由用户填写） */}
      <div className="sk__grid">
        {/* 技能头像：置于基础信息最前 */}
        <Field className="sk__span-2">
          <FieldLabel>技能头像</FieldLabel>
          <div className="sk__logo-block">
            <div className="sk__logo-thumb">
              <Upload
                accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(file) => {
                  void handleLogoUpload(file as unknown as File)
                  return false
                }}
              >
                <div
                  className={`sk__logo-preview sk__logo-click${
                    logo ? ' is-set' : ''
                  }`}
                >
                  {logo ? (
                    <img src={logo.url} alt="logo" className="sk__logo-img" />
                  ) : (
                    <UploadIcon size={22} className="sk__logo-empty-icon" />
                  )}
                  <span className="sk__logo-mask">
                    {logo ? '更换头像' : '点击上传'}
                  </span>
                </div>
              </Upload>
              {logo && (
                <button
                  type="button"
                  className="sk__logo-remove"
                  aria-label="移除头像"
                  onClick={() => setLogo(null)}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        </Field>

        <Field>
          <FieldLabel>
            标识符<span className="sk__required">*</span>
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

        <Field>
          <FieldLabel>技能分类</FieldLabel>
          <ScenarioSelect
            scope="SKILL"
            value={scenario ?? null}
            onChange={(v) => setScenario(v ?? undefined)}
            placeholder="选择或搜索分类，可回车新建"
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

        {/* 技能描述：置于基础信息最底部 */}
        <Field className="sk__span-2">
          <FieldLabel>技能描述</FieldLabel>
          <Input.TextArea
            rows={8}
            value={description}
            placeholder="一句话描述这个技能的能力"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

      </div>
    </Modal>
  )
}
