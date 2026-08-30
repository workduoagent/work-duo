/**
 * 新建 / 编辑技能弹窗（仿 nexus-web skill-hub 的设计，但落盘到本地 $APPDATA/.skills）。
 *
 * 三个 Tab：
 *  1) 基础信息：标识符 / 名称 / 描述 / 分类 / 标签；
 *  2) 指令内容：instruction（技能级指令，与 SKILL.md 是**不同字段**）；
 *  3) 文件资源：SKILL.md 正文（独立字段，落盘为 <identifier>/SKILL.md）+ 脚本编辑（可选语言）
 *     + 资源文件上传（scripts / references / assets / templates / 自定义目录）。
 *
 * 保存时回传 SkillFormData（元数据 + 脚本 + 资源），由页面负责入库并落盘。
 */
import { useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  FilePlus2,
  Upload as UploadIcon,
  FileCode2,
  Code2,
} from 'lucide-react'
import { Button, Input, Field, FieldLabel, Modal, Select } from '@/components/ui'
import { Tabs, Upload, Alert, Radio, Divider } from 'antd'
import { useNotify } from '@/components/ui/notify'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { MonacoJsonEditor } from '@/components/code-editor'
import {
  SCRIPT_LANGUAGE_OPTIONS,
  createEmptySkill,
  type SkillInfo,
  type ScriptFile,
  type ResourceFile,
  type SkillFormData,
} from '@/core/file/skill-file'
import { readSkillFileTree, type SkillFileTreeNode } from '@/core/file/skillFs'
import { ScenarioSelect } from '@/components/scenario'
import { SkillFileTree } from './SkillFileTree'

export interface SkillFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑时传入原技能；新增时传 null */
  skill: SkillInfo | null
  onSave: (data: SkillFormData) => Promise<void> | void
}

/** 必填 / 格式校验 */
function validate(draft: SkillInfo): Set<string> {
  const errors = new Set<string>()
  if (!draft.identifier.trim()) errors.add('identifier')
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(draft.identifier))
    errors.add('identifier-format')
  if (!draft.name.trim()) errors.add('name')
  return errors
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10)

export function SkillFormModal({
  open,
  onOpenChange,
  skill,
  onSave,
}: SkillFormModalProps) {
  const { message } = useNotify()
  const [draft, setDraft] = useState<SkillInfo>(() =>
    skill ? structuredClone(skill) : createEmptySkill(),
  )
  const [scripts, setScripts] = useState<ScriptFile[]>([])
  const [resources, setResources] = useState<ResourceFile[]>([])
  const [errors, setErrors] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  // 资源上传目标目录
  const [resDir, setResDir] = useState<string>('')
  const [resCustom, setResCustom] = useState<string>('')

  // 头像（固定落盘为技能根目录 logo.<ext>，不单独入库字段）
  const [logo, setLogo] = useState<{ file: ResourceFile; url: string } | null>(null)

  // 当前展开编辑内容的脚本 id
  const [expandedScriptId, setExpandedScriptId] = useState<string | null>(null)

  // 编辑态：技能根目录下的文件树（只读展示）
  const [fileTree, setFileTree] = useState<SkillFileTreeNode | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(skill ? structuredClone(skill) : createEmptySkill())
    setScripts([])
    setResources([])
    setErrors(new Set())
    setResDir('')
    setResCustom('')
    setLogo(null)
    setExpandedScriptId(null)
    setFileTree(null)
    // 编辑已有技能时，异步读取磁盘目录结构用于展示
    if (skill) {
      void readSkillFileTree(skill.identifier)
        .then(setFileTree)
        .catch(() => setFileTree(null))
    }
  }, [open, skill])

  function patch(part: Partial<SkillInfo>) {
    setDraft((prev) => ({ ...prev, ...part }))
  }

  function updateScript(id: string, part: Partial<ScriptFile>) {
    setScripts((prev) => prev.map((s) => (s.id === id ? { ...s, ...part } : s)))
  }

  function addScript() {
    const s: ScriptFile = { id: uid(), name: 'script', language: 'python', content: '' }
    setScripts((prev) => [...prev, s])
    setExpandedScriptId(s.id)
  }

  function removeScript(id: string) {
    setScripts((prev) => prev.filter((s) => s.id !== id))
    if (expandedScriptId === id) setExpandedScriptId(null)
  }

  async function handleSkillMdUpload(file: File) {
    const text = await file.text()
    patch({ skillMarkdown: text })
    message.success('已载入 SKILL.md 内容到编辑器')
  }

  async function handleResourceUpload(file: File) {
    const buf = await file.arrayBuffer()
    const dir = resDir === 'custom' ? resCustom.trim() : resDir
    setResources((prev) => [
      ...prev,
      { id: uid(), name: file.name, dir, data: new Uint8Array(buf) },
    ])
    message.success(`已加入资源队列：${(dir ? dir + '/' : '') + file.name}`)
  }

  async function handleLogoUpload(file: File) {
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
      message.warning('头像仅支持 png / jpg / gif / webp / svg 图片')
      return false
    }
    const buf = await file.arrayBuffer()
    const ext = file.name.split('.').pop()!.toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
    const url = URL.createObjectURL(new Blob([buf], { type: `image/${mime}` }))
    setLogo((prev) => {
      if (prev) URL.revokeObjectURL(prev.url) // 释放上一张预览，避免泄漏
      return {
        file: { id: uid(), name: `logo.${ext}`, dir: '', data: new Uint8Array(buf) },
        url,
      }
    })
    message.success(`已选择头像（将落盘为 logo.${ext}）`)
  }

  async function handleSave() {
    const errs = validate(draft)
    setErrors(errs)
    if (errs.size > 0) {
      message.warning('请完善必填项（标识符、技能名称）')
      return
    }
    setSaving(true)
    try {
      await onSave({
        skill: { ...draft, updatedAt: new Date().toISOString() },
        scripts,
        // 头像作为根目录资源合并进去（无则不含）
        resources: [...resources, ...(logo ? [logo.file] : [])],
      })
      onOpenChange(false)
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const hasError = (key: string) => (errors.has(key) ? 'error' : undefined)

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={860}
      title={skill ? '编辑技能' : '新建技能'}
      style={{ maxWidth: '94vw' }}
      footer={
        <div className="sk__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button loading={saving} onClick={handleSave}>
            保存
          </Button>
        </div>
      }
    >
      <Tabs
        defaultActiveKey="base"
        items={[
          /* ============ Tab 1：基础信息 ============ */
          {
            key: 'base',
            label: '基础信息',
            children: (
              <div className="sk__grid">
                <Field>
                  <FieldLabel>
                    标识符<span className="sk__required">*</span>
                  </FieldLabel>
                  <Input
                    value={draft.identifier}
                    disabled={!!skill}
                    status={
                      hasError('identifier') || hasError('identifier-format')
                        ? 'error'
                        : undefined
                    }
                    placeholder="如 doc-polish（仅小写字母、数字、连字符，即目录名）"
                    onChange={(e) => patch({ identifier: e.target.value })}
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
                    value={draft.name}
                    status={hasError('name')}
                    placeholder="如 文档润色"
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </Field>

                <Field className="sk__span-2">
                  <FieldLabel>描述</FieldLabel>
                  <Input.TextArea
                    rows={2}
                    value={draft.description ?? ''}
                    placeholder="一句话描述这个技能的能力"
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </Field>

                <Field>
                  <FieldLabel>技能分类</FieldLabel>
                  <ScenarioSelect
                    scope="SKILL"
                    value={draft.scenario ?? null}
                    onChange={(v) => patch({ scenario: v ?? undefined })}
                    placeholder="选择或搜索分类，可回车新建"
                  />
                </Field>

        <Field>
          <FieldLabel>标签</FieldLabel>
          <Select
            mode="tags"
            value={draft.tags ?? []}
            placeholder="输入后回车，如 文档润色"
            tokenSeparators={[',']}
            onChange={(v) => patch({ tags: v as string[] })}
          />
        </Field>

        <Field className="sk__span-2">
          <FieldLabel>技能头像</FieldLabel>
          <div className="sk__logo-row">
            <div className="sk__logo-preview">
              {logo ? (
                <img src={logo.url} alt="logo" className="sk__logo-img" />
              ) : (
                <span className="sk__logo-placeholder">
                  <UploadIcon size={20} />
                </span>
              )}
            </div>
            <div className="sk__logo-actions">
              <Upload
                accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(file) => {
                  void handleLogoUpload(file as unknown as File)
                  return false
                }}
              >
                <Button icon={<UploadIcon size={14} />}>
                  {logo ? '更换头像' : '上传头像'}
                </Button>
              </Upload>
              {logo && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={() => setLogo(null)}
                >
                  移除
                </Button>
              )}
            </div>
          </div>
        </Field>
      </div>
            ),
          },

          /* ============ Tab 2：指令内容（与 SKILL.md 不同字段） ============ */
          {
            key: 'instruction',
            label: '指令内容',
            children: (
              <Field>
                <FieldLabel>
                  <Code2 size={14} className="sk__inline-icon" />
                  指令内容
                </FieldLabel>
                <MarkdownEditor
                  value={draft.instruction ?? ''}
                  height={300}
                  placeholder="编写技能的主体指令 / 工作流（支持 Markdown）"
                  onChange={(v) => patch({ instruction: v })}
                />
              </Field>
            ),
          },

          /* ============ Tab 3：文件资源（SKILL.md + 脚本 + 资源） ============ */
          {
            key: 'files',
            label: '文件资源',
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 14 }}
                  message={
                    <>
                      资源将存放于{' '}
                      <code>{`{skill_path}/{identifier}/`}</code> 下：SKILL.md /
                      脚本 scripts / 参考资料 references / 静态资源 assets /
                      模板 templates / 自定义目录。
                    </>
                  }
                />

                {/* SKILL.md 正文（独立字段） */}
                <Field>
                  <FieldLabel>
                    <FileCode2 size={14} className="sk__inline-icon" />
                    SKILL.md 正文
                  </FieldLabel>
                  <MarkdownEditor
                    value={draft.skillMarkdown ?? ''}
                    height={260}
                    placeholder="编写标准 SKILL.md 正文（落盘为 <identifier>/SKILL.md）"
                    onChange={(v) => patch({ skillMarkdown: v })}
                  />
                </Field>

                <div style={{ marginTop: 10 }}>
                  <Upload
                    accept=".md,.markdown,.txt"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(file) => {
                      void handleSkillMdUpload(file as unknown as File)
                      return false
                    }}
                  >
                    <Button icon={<FilePlus2 size={14} />}>上传 SKILL.md 文件（填充上方）</Button>
                  </Upload>
                </div>

                <Divider plain>脚本文件</Divider>

                <div className="sk__script-list">
                  {scripts.map((s) => (
                    <div key={s.id} className="sk__script-item">
                      <div className="sk__script-row">
                        <Input
                          value={s.name}
                          placeholder="脚本名"
                          style={{ maxWidth: 200 }}
                          onChange={(e) => updateScript(s.id, { name: e.target.value })}
                        />
                        <Select
                          value={s.language}
                          options={SCRIPT_LANGUAGE_OPTIONS as never}
                          style={{ width: 200 }}
                          onChange={(v) => updateScript(s.id, { language: String(v) })}
                        />
                        <Button
                          variant="soft"
                          size="sm"
                          onClick={() =>
                            setExpandedScriptId((cur) => (cur === s.id ? null : s.id))
                          }
                        >
                          {expandedScriptId === s.id ? '收起' : '编辑内容'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeScript(s.id)}
                          aria-label="删除脚本"
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                      {expandedScriptId === s.id && (
                        <div className="sk__script-editor">
                          <MonacoJsonEditor
                            mode="code"
                            language={s.language}
                            value={s.content}
                            height={220}
                            onChange={(v) =>
                              updateScript(s.id, {
                                content: typeof v === 'string' ? v : '',
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  ))}
                  {scripts.length === 0 && (
                    <div className="sk__script-empty">尚未添加脚本文件</div>
                  )}
                </div>

                <Button icon={<Plus size={14} />} onClick={addScript} style={{ marginTop: 8 }}>
                  添加脚本
                </Button>

                <Divider plain>资源文件上传</Divider>

                <div className="sk__uploader">
                  <div className="sk__uploader-row">
                    <span className="sk__uploader-label">目标目录</span>
                    <Radio.Group
                      value={resDir}
                      onChange={(e) => setResDir(e.target.value)}
                      optionType="button"
                      buttonStyle="solid"
                    >
                      <Radio value="">根目录 /</Radio>
                      <Radio value="scripts">脚本 scripts/</Radio>
                      <Radio value="references">参考资料 references/</Radio>
                      <Radio value="assets">静态资源 assets/</Radio>
                      <Radio value="templates">模板 templates/</Radio>
                      <Radio value="custom">自定义</Radio>
                    </Radio.Group>
                  </div>

                  {resDir === 'custom' && (
                    <div className="sk__uploader-row">
                      <span className="sk__uploader-label">自定义路径</span>
                      <Input
                        addonBefore="/"
                        addonAfter="/"
                        placeholder="如 tests 或 prompts"
                        value={resCustom}
                        onChange={(e) => setResCustom(e.target.value)}
                        style={{ maxWidth: 320 }}
                      />
                    </div>
                  )}

                  <div className="sk__uploader-row">
                    <span className="sk__uploader-label">选择文件</span>
                    <Upload
                      multiple
                      showUploadList={false}
                      beforeUpload={(file) => {
                        if (resDir === 'custom' && !resCustom.trim()) {
                          message.warning('请先在上方填写自定义目录')
                          return Upload.LIST_IGNORE
                        }
                        void handleResourceUpload(file as unknown as File)
                        return false
                      }}
                    >
                      <Button icon={<UploadIcon size={14} />}>
                        选择并上传文件（可批量）
                      </Button>
                    </Upload>
                  </div>
                </div>

                {resources.length > 0 && (
                  <div className="sk__res-list">
                    {resources.map((r) => (
                      <div key={r.id} className="sk__res-item">
                        <code>
                          {(r.dir ? r.dir + '/' : '') + r.name}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="移除资源"
                          onClick={() =>
                            setResources((prev) => prev.filter((x) => x.id !== r.id))
                          }
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ),
          },

          /* ============ Tab 4：目录结构（编辑态展示磁盘文件树） ============ */
          {
            key: 'tree',
            label: '目录结构',
            children: (
              <div className="sk__tree-wrap">
                <p className="sk__tree-tip">
                  当前技能在磁盘上的目录与文件（只读预览，修改请通过上方「文件资源」或编辑脚本）。
                </p>
                <SkillFileTree tree={fileTree} />
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}
