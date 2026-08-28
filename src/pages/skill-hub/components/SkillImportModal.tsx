/**
 * 导入技能弹窗（仿 nexus-web skill-hub 的导入表单）。
 *
 * 支持三种来源：
 *  - 选择文件夹（Tauri）：递归读取目录内所有文件，从 SKILL.md 生成技能元数据，
 *    其余文件作为资源落盘到 <identifier>/ 对应子目录；
 *  - 单个 .md / .txt 文件：按文件名生成技能，内容作为 SKILL.md 与指令内容；
 *  - 单个 .json 文件：经 parseSkillImport 归一化（兼容单个对象或数组）。
 *
 * 导入时回传 SkillFormData，由页面负责入库并落盘。
 */
import { useEffect, useState } from 'react'
import { Inbox, FolderUp } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { Upload, message, Alert } from 'antd'
import {
  parseSkillImport,
  createEmptySkill,
  type SkillInfo,
  type SkillFormData,
  type ResourceFile,
} from '@/core/file/skill-file'
import { isTauri } from '@/core/config'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readDir, readFile } from '@tauri-apps/plugin-fs'
import { join, basename } from '@tauri-apps/api/path'

export interface SkillImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (data: SkillFormData) => Promise<void> | void
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${Date.now()}`
  )
}

/** 递归收集文件夹内所有文件：{ 相对路径, 二进制内容 }。 */
async function readFolderTree(
  dir: string,
): Promise<{ rel: string; data: Uint8Array }[]> {
  const out: { rel: string; data: Uint8Array }[] = []
  const walk = async (d: string, base: string): Promise<void> => {
    const entries = await readDir(d)
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isFile) {
        const data = (await readFile(await join(d, e.name))) as Uint8Array
        out.push({ rel, data })
      } else if (e.isDirectory) {
        await walk(await join(d, e.name), rel)
      }
    }
  }
  await walk(dir, '')
  return out
}

export function SkillImportModal({
  open,
  onOpenChange,
  onImported,
}: SkillImportModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [folderImporting, setFolderImporting] = useState(false)

  useEffect(() => {
    if (!open) {
      setFile(null)
      setImporting(false)
      setFolderImporting(false)
    }
  }, [open])

  const beforeUpload = (f: File) => {
    setFile(f)
    return false // 阻止 antd 默认上传
  }

  /** 选择文件夹导入（仅 Tauri 可用）。 */
  async function handleFolderImport() {
    if (!isTauri) return
    setFolderImporting(true)
    try {
      const selected = await openDialog({ directory: true, multiple: false })
      if (!selected) return
      const dir = selected as string
      const folderName = await basename(dir)
      const files = await readFolderTree(dir)

      const skillMdEntry = files.find(
        (f) =>
          f.rel.toLowerCase() === 'skill.md' ||
          f.rel.toLowerCase().endsWith('/skill.md'),
      )
      const skillMarkdown = skillMdEntry
        ? new TextDecoder().decode(skillMdEntry.data)
        : ''

      const identifier = slugify(folderName)
      const name = folderName.replace(/[-_]+/g, ' ').trim() || folderName
      const skill: SkillInfo = {
        ...createEmptySkill(),
        identifier,
        name,
        instruction: skillMarkdown,
        skillMarkdown,
      }

      const resources: ResourceFile[] = files
        .filter((f) => f.rel.toLowerCase() !== 'skill.md')
        .map((f) => {
          const idx = f.rel.lastIndexOf('/')
          const relDir = idx >= 0 ? f.rel.slice(0, idx) : ''
          const fname = idx >= 0 ? f.rel.slice(idx + 1) : f.rel
          return { id: crypto.randomUUID(), name: fname, dir: relDir, data: f.data }
        })

      await onImported({ skill, scripts: [], resources })
      onOpenChange(false)
    } catch (e: unknown) {
      message.error(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setFolderImporting(false)
    }
  }

  async function handleOk() {
    if (!file) {
      message.warning('请先选择要导入的文件')
      return
    }
    setImporting(true)
    try {
      const text = await file.text()
      let skills: SkillInfo[] = []
      if (file.name.toLowerCase().endsWith('.json')) {
        const res = parseSkillImport(text)
        if (res.errors.length) {
          message.warning(
            `已导入 ${res.skills.length}/${res.total} 条：${res.errors[0]}`,
          )
        }
        skills = res.skills
      } else {
        // 视为 SKILL.md / 文本：单条技能
        const name = file.name.replace(/\.(md|markdown|txt)$/i, '')
        skills = [
          {
            ...createEmptySkill(),
            identifier: slugify(name),
            name,
            instruction: text,
            skillMarkdown: text,
          },
        ]
      }
      if (!skills.length) {
        message.error('未解析到可导入的技能')
        return
      }
      for (const s of skills) {
        await onImported({ skill: s, scripts: [], resources: [] })
      }
      onOpenChange(false)
    } catch (e: unknown) {
      message.error(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={640}
      title="导入技能"
      description="支持选择文件夹、单个 SKILL.md / 文本文件或 JSON 导入。"
      footer={
        <div className="sk__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={importing} onClick={handleOk}>
            导入文件
          </Button>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="文件夹导入会递归读取目录并落盘到 skill_path/<identifier>/；文本 / Markdown 文件将按文件名生成技能，内容作为 SKILL.md；JSON 需含 identifier、name 等字段。"
      />

      <Upload.Dragger multiple={false} showUploadList beforeUpload={beforeUpload}>
        <p className="ant-upload-drag-icon">
          <Inbox size={40} color="var(--color-foreground-muted)" />
        </p>
        <p className="ant-upload-text">点击或拖拽文件到此处（.json / .md / .txt）</p>
        <p className="ant-upload-hint">支持单个文件导入</p>
      </Upload.Dragger>

      {file && (
        <div className="sk-import__file">
          已选择：{file.name}（{(file.size / 1024).toFixed(1)} KB）
        </div>
      )}

      {isTauri && (
        <>
          <DividerStyle />
          <Button
            icon={<FolderUp size={14} />}
            loading={folderImporting}
            onClick={handleFolderImport}
            block
          >
            选择文件夹导入（递归落盘）
          </Button>
        </>
      )}
    </Modal>
  )
}

/** 小分隔（避免额外引 antd Divider 命名冲突）。 */
function DividerStyle() {
  return <div style={{ margin: '16px 0', borderTop: '1px solid var(--color-border)' }} />
}
