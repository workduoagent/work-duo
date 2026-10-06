/**
 * 新建 / 编辑技能弹窗（仿 nexus-web skill-hub 的设计，但落盘到本地 $APPDATA/.skills）。
 *
 * 四个 Tab：
 *  1) 基础信息：头像（点击上传）/ 标识符 / 名称 / 分类 / 标签 / 描述；
 *  2) Agent 指令：instruction 字段（独立字段，仅存数据库，可选，供智能体注入使用）；
 *  3) 文件资源：SKILL.md 正文（独立字段，落盘为 <identifier>/SKILL.md）
 *     + 脚本编辑（可选语言）+ 资源文件上传（scripts / references / assets / templates / 自定义目录）；
 *  4) 目录结构：编辑态只读展示磁盘文件树。
 *
 * ★ 关键约定：instruction（Agent 指令）与 skillMarkdown（SKILL.md 正文）是**两个独立字段**：
 *  - skillMarkdown → 落盘为 <identifier>/SKILL.md，是标准的技能说明文档；
 *  - instruction   → 仅存入数据库（skill_info.instruction 列），不写文件，可选；
 *  二者请勿混用。历史上曾错误地把 SKILL.md 内容复制进 instruction（见 SkillImportModal），
 *  已在导入链路修正：导入只填 skillMarkdown，instruction 保持为空、留待用户显式填写。
 *
 * 编辑态从磁盘目录回显：脚本（scripts/ 下可识别扩展名）、资源、头像、SKILL.md 一并载入表单，
 * 保证导入带脚本的技能再次打开时能正确显示。
 */
import { useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  FilePlus2,
  Upload as UploadIcon,
  FileCode2,
  Bot,
  X,
} from 'lucide-react'
import { Button, Input, Field, FieldLabel, Modal, Select, Tabs, Upload, Radio, Divider, Alert } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { MonacoJsonEditor } from '@/components/code-editor'
import {
  SCRIPT_LANGUAGE_OPTIONS,
  createEmptySkill,
  extToLang,
  isScriptExt,
  type SkillInfo,
  type ScriptFile,
  type ResourceFile,
  type SkillFormData,
} from '@/core/file/skill-file'
import {
  readSkillFileTree,
  readSkillDirFlat,
  removeSkillLogos,
  uint8ToBase64,
  LOGO_EXTS,
  type SkillFileTreeNode,
} from '@/core/file/skillFs'
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
    // 编辑已有技能时，异步读取磁盘目录结构用于展示与表单回显
    if (skill) {
      void readSkillFileTree(skill.identifier, skill.path)
        .then(setFileTree)
        .catch(() => setFileTree(null))
      void loadFromDisk(skill)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, skill])

  /** 从磁盘目录回显：脚本 / 资源 / 头像 / SKILL.md */
  async function loadFromDisk(s: SkillInfo) {
    const files = await readSkillDirFlat(s.identifier, s.path)
    if (!files || files.length === 0) return
    const decoder = new TextDecoder()
    const loadedScripts: ScriptFile[] = []
    const loadedResources: ResourceFile[] = []
    let md = ''
    let mdFound = false
    // 头像候选：技能根目录下的 logo.*（任意扩展名，如 logo.svg / logo.png / logo.ico）。
    // 同一技能目录可能存在多个 logo 文件，先全部收集，循环结束后再按固定优先级择优，
    // 避免被目录遍历顺序随机覆盖。
    const logoCandidates = new Map<string, { data: Uint8Array; url: string }>()
    for (const f of files) {
      const norm = f.relPath.replace(/\\/g, '/')
      const base = norm.split('/').pop() || ''
      const lower = base.toLowerCase()
      // 头像：logo.* —— 直接读取磁盘文件字节并编码为 data URL，
      // 与 SkillAvatar 的 readSkillLogoBase64 行为一致（非 blob 临时链接）。
      if (/^logo\.[^/]+$/i.test(lower)) {
        const ext = lower.split('.').pop() as string
        const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
        const url = `data:image/${mime};base64,${uint8ToBase64(f.data)}`
        logoCandidates.set(ext, { data: f.data, url })
        continue
      }
      // SKILL.md 正文（若有则优先用磁盘内容）
      if (lower === 'skill.md') {
        md = decoder.decode(f.data)
        mdFound = true
        continue
      }
      const slash = norm.lastIndexOf('/')
      const dir = slash >= 0 ? norm.slice(0, slash) : ''
      // scripts/ 下、可识别扩展名的文件归类为「脚本」
      if (dir === 'scripts') {
        const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
        if (isScriptExt(ext)) {
          loadedScripts.push({
            id: uid(),
            name: base.replace(/\.[^.]+$/, ''),
            language: extToLang(ext),
            content: decoder.decode(f.data),
          })
          continue
        }
      }
      // 其余文件作为「资源」，保留相对目录
      loadedResources.push({ id: uid(), name: base, dir, data: f.data })
    }
    setScripts(loadedScripts)
    setResources(loadedResources)
    // 按固定优先级（png > jpg > jpeg > gif > webp > svg）择优，
    // 其余非标准扩展名（如 logo.ico）作为兜底也纳入候选。
    // 这样位图头像永远优先于模板遗留的 svg，且不会被目录遍历顺序随机覆盖。
    let logoState: { file: ResourceFile; url: string } | null = null
    const logoPriority = [
      ...LOGO_EXTS,
      ...[...logoCandidates.keys()].filter((e) => !LOGO_EXTS.includes(e)),
    ]
    for (const ext of logoPriority) {
      const found = logoCandidates.get(ext)
      if (found) {
        logoState = {
          file: { id: uid(), name: `logo.${ext}`, dir: '', data: found.data },
          url: found.url,
        }
        break
      }
    }
    if (logoState) setLogo(logoState)
    if (mdFound) patch({ skillMarkdown: md })
  }

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
    const bytes = new Uint8Array(buf)
    const ext = file.name.split('.').pop()!.toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
    const url = `data:image/${mime};base64,${uint8ToBase64(bytes)}`
    setLogo({
      file: { id: uid(), name: `logo.${ext}`, dir: '', data: bytes },
      url,
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
      // 编辑态且头像有变更时，先清理磁盘上的旧头像：
      //  - 用户移除了头像：确保旧 logo 文件被删除，避免再次编辑时回显；
      //  - 用户更换了头像/扩展名：删除旧扩展名文件，避免读取到错误的旧头像。
      if (skill) await removeSkillLogos(skill.identifier, skill.path)
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
      width={920}
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
              <div className="sk__tab-panel">
                <div className="sk__grid">
                {/* 头像：顶部独立区块，点击即可上传 / 更换，无独立按钮 */}
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
                    maxTagCount="responsive"
                    value={draft.tags ?? []}
                    placeholder="输入后回车，如 文档润色"
                    tokenSeparators={[',']}
                    onChange={(v) => patch({ tags: v as string[] })}
                  />
                </Field>

                {/* 描述放最底，行高更高 */}
                <Field className="sk__span-2">
                  <FieldLabel>技能描述</FieldLabel>
                  <Input.TextArea
                    rows={8}
                    value={draft.description ?? ''}
                    placeholder="一句话描述这个技能的能力"
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </Field>
              </div>
              </div>
            ),
          },

          /* ============ Tab 2：Agent 指令（独立字段，与 SKILL.md 区分） ============ */
          {
            key: 'instruction',
            label: 'Agent 指令',
            children: (
              <div className="sk__tab-panel">
                <div className="sk__instruction-wrap">
                <Alert
                  type="warning"
                  showIcon
                  className="sk__instruction-alert"
                  message="Agent 指令 与 SKILL.md 正文是两个完全独立的字段"
                  description={
                    <span>
                      左侧「文件资源」里的 <code>SKILL.md 正文</code> 会落盘为技能目录下的标准说明文档，供阅读与引擎载入；
                      本处的 <b>Agent 指令（instruction）</b> 是可选的、直接注入给智能体的补充指令，
                      仅存于数据库、<b>不写入任何文件</b>。两者请分别维护，切勿当作同一份内容。
                    </span>
                  }
                />
                <Field className="sk__span-2 sk__instruction-field">
                  <FieldLabel>
                    <Bot size={14} className="sk__inline-icon" />
                    Agent 指令（instruction）
                    <span className="sk__optional">可选</span>
                  </FieldLabel>
                  <MarkdownEditor
                    value={draft.instruction ?? ''}
                    height={420}
                    placeholder="填写希望智能体在调用本技能时额外遵循的指令（可选）。留空则引擎仅使用 SKILL.md 正文。"
                    onChange={(v) => patch({ instruction: v })}
                  />
                </Field>
              </div>
              </div>
            ),
          },

          /* ============ Tab 3：文件资源（SKILL.md + 脚本 + 资源） ============ */
          {
            key: 'files',
            label: '文件资源',
            children: (
              <div className="sk__tab-panel">
                {/* SKILL.md 正文（独立字段，落盘为 <identifier>/SKILL.md） */}
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
                        {/* F040：脚本移除属表单草稿编辑，整体「保存 / 取消」已有明确
                            语义与提示，单项删除无需二次确认——与「删除技能本体」
                            （连带删磁盘目录、不可恢复）区别对待。 */}
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
              </div>
            ),
          },

          /* ============ Tab 4：目录结构（编辑态展示磁盘文件树） ============ */
          {
            key: 'tree',
            label: '目录结构',
            children: (
              <div className="sk__tab-panel sk__tab-panel--tree">
                <p className="sk__tree-tip">
                  当前技能在磁盘上的目录与文件（只读预览，修改请通过上方「文件资源」或编辑脚本）。
                </p>
                <div className="sk__tree-body">
                  <SkillFileTree tree={fileTree} />
                </div>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}
