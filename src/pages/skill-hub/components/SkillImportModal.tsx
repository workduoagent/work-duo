/**
 * 导入技能弹窗。
 * 支持两种来源：
 *  - JSON 文件（单个对象或数组），经 parseSkillImport 归一化；
 *  - 单个 .md / .txt 文件，按文件名生成技能、内容作为正文。
 */
import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { Upload, message, Alert } from 'antd'
import { parseSkillImport, type SkillInfo } from '@/core/file/skill-file'

export interface SkillImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (skills: SkillInfo[]) => Promise<void> | void
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${Date.now()}`
  )
}

export function SkillImportModal({
  open,
  onOpenChange,
  onImported,
}: SkillImportModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!open) setFile(null)
  }, [open])

  const beforeUpload = (f: File) => {
    setFile(f)
    return false // 阻止 antd 默认上传
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
            id: crypto.randomUUID(),
            identifier: slugify(name),
            name,
            instruction: text,
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]
      }
      if (!skills.length) {
        message.error('未解析到可导入的技能')
        return
      }
      await onImported(skills)
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
      description="支持导入 JSON（单个或数组）或单个 SKILL.md / 文本文件。"
      footer={
        <div className="sk__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={importing} onClick={handleOk}>
            导入
          </Button>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="JSON 需含 identifier、name 等字段；文本 / Markdown 文件将按文件名生成技能，内容作为正文。"
      />
      <Upload.Dragger multiple={false} showUploadList beforeUpload={beforeUpload}>
        <p className="ant-upload-drag-icon">
          <Inbox size={40} color="var(--color-foreground-muted)" />
        </p>
        <p className="ant-upload-text">点击或拖拽文件到此处</p>
        <p className="ant-upload-hint">支持 .json / .md / .txt</p>
      </Upload.Dragger>
      {file && (
        <div className="sk-import__file">
          已选择：{file.name}（{(file.size / 1024).toFixed(1)} KB）
        </div>
      )}
    </Modal>
  )
}
