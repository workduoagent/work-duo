/**
 * 知识库新建 / 编辑表单弹窗。
 *
 * 字段严格对齐 knowledge_base 表：
 *  - identifier：唯一标识 slug（同时是磁盘目录名 $APPDATA/.knowledge_base/<identifier>/）；
 *  - name：名称；description：简介；scenario：场景分类（ScenarioSelect scope='KB'）；
 *  - logo：知识库 Logo（选图后以 data URL 存入 logo 列）。
 * 创建 / 编辑共用：editing 为空表示新建；identifier 在编辑时可改（会同步重命名物理目录）。
 */
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { Button, Modal, Field, FieldLabel, Input } from '@/components/ui'
import { ScenarioSelect } from '@/components/scenario'
import { useNotify } from '@/components/ui/notify'
import {
  createKnowledgeBase,
  updateKnowledgeBase,
} from '@/core/mapper/knowledge-mapper'
import type { KnowledgeBase } from '@/types/core'

export interface KnowledgeFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传入则为编辑模式；为空为新建 */
  editing?: KnowledgeBase | null
  /** 保存成功后回传最新列表 */
  onSaved: (list: KnowledgeBase[]) => void
}

export function KnowledgeFormModal({ open, onOpenChange, editing, onSaved }: KnowledgeFormModalProps) {
  const { message } = useNotify()
  const [identifier, setIdentifier] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scenario, setScenario] = useState<string | undefined>(undefined)
  const [logo, setLogo] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setIdentifier(editing?.identifier ?? '')
    setName(editing?.name ?? '')
    setDescription(editing?.description ?? '')
    setScenario(editing?.scenario)
    setLogo(editing?.logo)
  }, [open, editing])

  function pickLogo(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setLogo(typeof reader.result === 'string' ? reader.result : undefined)
    reader.readAsDataURL(file)
  }

  async function handleSave() {
    const trimmedName = name.trim()
    const trimmedId = identifier.trim()
    if (!trimmedName) {
      message.warning('请填写知识库名称')
      return
    }
    if (!trimmedId) {
      message.warning('请填写唯一标识')
      return
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId)) {
      message.warning('唯一标识仅允许字母、数字、- 和 _')
      return
    }
    setSaving(true)
    try {
      const list = editing
        ? await updateKnowledgeBase({
            id: editing.id,
            identifier: trimmedId,
            name: trimmedName,
            description: description.trim() || undefined,
            logo,
            scenario,
          })
        : await createKnowledgeBase({
            identifier: trimmedId,
            name: trimmedName,
            description: description.trim() || undefined,
            logo,
            scenario,
          })
      onSaved(list)
      onOpenChange(false)
      message.success(editing ? '知识库已更新' : `已创建知识库「${trimmedName}」`)
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? '编辑知识库' : '新建知识库'}
      width={600}
      footer={
        <>
          <Button variant="soft" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="solid" size="sm" loading={saving} onClick={handleSave}>
            保存
          </Button>
        </>
      }
    >
      <div className="kb-form__grid">
        <Field>
          <FieldLabel htmlFor="kb-name">名称</FieldLabel>
          <Input
            id="kb-name"
            value={name}
            placeholder="如：合同文档"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onPressEnter={handleSave}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="kb-identifier">唯一标识</FieldLabel>
          <Input
            id="kb-identifier"
            value={identifier}
            placeholder="如 contract_documents（仅字母数字 - _）"
            autoComplete="off"
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>场景分类</FieldLabel>
          <ScenarioSelect
            scope="KB"
            value={scenario}
            onChange={(v) => setScenario(v ?? undefined)}
            placeholder="选择或搜索分类，可回车新建"
          />
        </Field>
        <Field>
          <FieldLabel>Logo（可选）</FieldLabel>
          <div className="kb-form__logo">
            {logo ? (
              <img src={logo} alt="logo" className="kb-form__logo-img" />
            ) : (
              <div className="kb-form__logo-empty">
                <ImagePlus size={18} />
                <span>未设置</span>
              </div>
            )}
            <div className="kb-form__logo-actions">
              <Button variant="soft" size="sm" onClick={() => fileRef.current?.click()}>
                选择图片
              </Button>
              {logo && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="kb-form__logo-del"
                  onClick={() => setLogo(undefined)}
                >
                  <Trash2 size={14} />
                  移除
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => pickLogo(e.target.files?.[0])}
            />
          </div>
        </Field>
        <Field className="kb-form__field--full">
          <FieldLabel htmlFor="kb-desc">简介（可选）</FieldLabel>
          <Input.TextArea
            id="kb-desc"
            value={description}
            placeholder="一句话描述该知识库的用途"
            autoComplete="off"
            rows={3}
            autoSize={{ minRows: 3, maxRows: 6 }}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
