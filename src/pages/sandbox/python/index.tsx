/**
 * 路由页面「沙箱环境 / Python」：内嵌 Micromamba 绿色便携 Python 运行时管理。
 *
 * 布局（对齐 MCP 模块风格）：
 * - 顶部 Header（标题 / 描述 + 刷新 / 新建环境按钮，整行横跨）；
 * - 环境卡片网格：上（系统名称 + 状态「就绪」）/ 中（Python 版本 + 依赖数量）/
 *   下（图标按钮组：运行 / 详情 / 重置 / 删除），default 环境受保护（禁重置 / 禁删除）；
 * - 新建环境弹窗：环境名实时重名校验、Python 版本可下拉可新建、预装包字段；
 *   提交后弹出全屏百分比进度遮罩，创建完成自动安装预装包；
 * - 详情弹窗融合「依赖列表 + 卸载 + 安装新依赖」三件事于一体。
 *
 * 数据走 src/core/mapper/sandbox-mapper.ts（封装 Tauri invoke）。
 * 样式仅用设计令牌 var(--color-*)，tsx/scss 分离，图标用 lucide-react。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Terminal,
  Trash2,
  RefreshCw,
  Play,
  Package,
  PackagePlus,
  Eye,
  Cpu,
  FolderOpen,
  AlertCircle,
  CheckCircle2,
  Search, Square } from 'lucide-react'
import {
  Button,
  Card,
  Input,
  Modal,
  Field,
  FieldLabel,
  AutoComplete,
  Empty,
  Popconfirm,
  Spin,
  Tooltip,
} from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { open } from '@tauri-apps/plugin-dialog'
import {
  listEnvs,
  createEnv,
  listPackages,
  installPackages,
  uninstallPackages,
  resetEnv,
  deleteEnv,
  runScript,
  lastScriptRunId,
  cancelScript,
  isScriptCancelled,
  stripCancelledPrefix,
  type EnvInfo,
  type PackageInfo,
} from '@/core/mapper/sandbox-mapper'
import './index.scss'

/** 系统保留环境名（Agent 默认环境，自动创建，不可手动建 / 删 / 重置）。 */
const RESERVED = 'default'
/** 建议版本（下拉兜底选项，用户仍可输入任意新版本）。 */
const SUGGESTED_VERSIONS = ['3.11', '3.10', '3.9', '3.12', '3.8']
/** 核心解释器，禁止从依赖列表卸载（卸载会破坏环境）。 */
const PROTECTED_PKGS = new Set(['python'])

/** 把依赖规格文本解析为去重数组（支持逗号 / 空格 / 中英文逗号分隔，可带版本约束）。 */
function parsePackages(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
}

/** 把 "3.11.9" 这类完整版本压成次版本号 "3.11"，用于下拉去重展示。 */
function toMinor(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export default function SandboxPythonPage() {
  const { message, result } = useNotify()
  const [envs, setEnvs] = useState<EnvInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  // 新建环境弹窗
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createPy, setCreatePy] = useState('3.11')
  const [createPre, setCreatePre] = useState('')
  const [nameError, setNameError] = useState('')

  // 全屏创建进度
  const [creating, setCreating] = useState(false)
  const [progress, setProgress] = useState({ pct: 0, msg: '', error: '' })
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 详情弹窗（依赖列表 + 安装 + 卸载）
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailEnv, setDetailEnv] = useState('')
  const [detailList, setDetailList] = useState<PackageInfo[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailInput, setDetailInput] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  /** 依赖列表搜索关键字（实时过滤已安装依赖，便于确认某包是否已安装）。 */
  const [detailQuery, setDetailQuery] = useState('')

  // 运行脚本弹窗
  const [runOpen, setRunOpen] = useState(false)
  const [runEnv, setRunEnv] = useState('')
  const [runPath, setRunPath] = useState('')
  // F049：当前运行的 run_id（用于「停止」按钮）
  const [runId, setRunId] = useState<string | null>(null)
  const [runOutput, setRunOutput] = useState('')

  /** 下拉候选版本：已存在环境的次版本号 + 建议版本，去重排序。 */
  const versionOptions = useMemo(() => {
    const set = new Set<string>()
    for (const e of envs) {
      if (e.exists && e.python_version) set.add(toMinor(e.python_version))
    }
    for (const v of SUGGESTED_VERSIONS) set.add(v)
    return Array.from(set)
      .sort()
      .map((v) => ({ value: v }))
  }, [envs])

  /** 依赖列表按搜索关键字实时过滤（不区分大小写），空关键字返回全量。 */
  const shownDeps = useMemo(() => {
    const q = detailQuery.trim().toLowerCase()
    if (!q) return detailList
    return detailList.filter((p) => p.name.toLowerCase().includes(q))
  }, [detailList, detailQuery])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEnvs(await listEnvs())
    } catch (e) {
      message.error(`加载环境列表失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 默认环境（default）自动创建兜底：应用启动已在后台静默创建它，但若那次创建
   *  未完成或失败，进入本页即静默补齐，避免用户手动点击「创建环境」。
   *  仅在列表加载完成、且无其它操作进行、且 default 确实缺失时尝试一次。 */
  const autoInitRef = useRef(false)
  useEffect(() => {
    if (autoInitRef.current) return
    if (envs.length === 0) return // 列表尚未加载完成，等 refresh 返回后再判定
    if (busy !== null) return // 有其它操作进行中，稍后由 busy 变化再次判定
    const def = envs.find((e) => e.name === RESERVED)
    if (!def || def.exists) {
      autoInitRef.current = true
      return
    }
    autoInitRef.current = true
    setBusy(`init:${RESERVED}`)
    createEnv(RESERVED, '3.11')
      .then((res) => {
        if (res.ok) message.success('默认 Python 环境已就绪')
        else message.warning(res.error || '默认 Python 环境创建失败')
      })
      .catch(() => {})
      .finally(() => {
        setBusy(null)
        void refresh()
      })
  }, [envs, busy, message, refresh])

  /** 统一「带忙等 + 结果提示 + 成功后刷新」的操作执行器（用于重置 / 删除等非创建操作）。 */
  const runOp = useCallback(
    async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
      setBusy(key)
      try {
        const res = await fn()
        result(res, okText)
        if (res.ok) await refresh()
      } finally {
        setBusy(null)
      }
    },
    [result, refresh],
  )

  // ---------- 新建环境：校验 + 进度创建 ----------

  /** 环境名实时校验：空 / 保留名 / 重名。 */
  const validateName = useCallback(
    (raw: string) => {
      const name = raw.trim()
      if (!name) return setNameError('')
      if (name === RESERVED) {
        return setNameError(`「${RESERVED}」为系统保留环境名，不可手动创建`)
      }
      if (envs.some((e) => e.name === name)) {
        return setNameError(`环境「${name}」已存在，请更换名称`)
      }
      return setNameError('')
    },
    [envs],
  )

  /** 打开新建弹窗并重置表单。 */
  const openCreate = () => {
    setCreateName('')
    setCreatePy('3.11')
    setCreatePre('')
    setNameError('')
    setCreateOpen(true)
  }

  /** 启动进度条缓动：在等待真实异步结果时，百分比缓慢向 cap 爬升，制造明显 loading 反馈。 */
  const startTick = (cap: number) => {
    stopTick()
    tickRef.current = setInterval(() => {
      setProgress((p) => {
        if (p.error || p.pct >= cap) return p
        const next = Math.min(cap, p.pct + Math.max(1, Math.round((cap - p.pct) / 14)))
        return { ...p, pct: next }
      })
    }, 220)
  }
  const stopTick = () => {
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = null
  }

  /** 提交新建：先校验，关闭表单弹窗，再走「创建环境 → 安装预装包」两阶段进度。 */
  const handleCreate = () => {
    const name = createName.trim()
    if (!name) {
      setNameError('请填写环境名称')
      return
    }
    if (name === RESERVED) {
      setNameError(`「${RESERVED}」为系统保留环境名，不可手动创建`)
      return
    }
    if (envs.some((e) => e.name === name)) {
      setNameError(`环境「${name}」已存在，请更换名称`)
      return
    }
    const py = createPy.trim() || '3.11'
    const specs = parsePackages(createPre)
    setCreateOpen(false)
    void createWithProgress(name, py, specs)
  }

  const createWithProgress = async (name: string, py: string, specs: string[]) => {
    setCreating(true)
    setProgress({ pct: 6, msg: '正在初始化运行环境…', error: '' })
    startTick(55)
    try {
      const r1 = await createEnv(name, py)
      if (!r1.ok) throw new Error(r1.error || '创建失败')
      setProgress((p) => ({ ...p, pct: 60, msg: `Python 环境「${name}」创建完成` }))
      stopTick()

      if (specs.length) {
        startTick(95)
        setProgress((p) => ({
          ...p,
          pct: 72,
          msg: `正在安装预装包（${specs.length} 个）…`,
        }))
        const r2 = await installPackages(name, specs)
        if (!r2.ok) throw new Error(r2.error || '预装包安装失败')
      }

      setProgress({ pct: 100, msg: '全部完成', error: '' })
      stopTick()
      await delay(450)
      setCreating(false)
      message.success(
        `环境「${name}」创建成功${specs.length ? `，已预装 ${specs.length} 个依赖` : ''}`,
      )
      await refresh()
    } catch (e) {
      stopTick()
      setProgress((p) => ({ ...p, error: String(e) }))
    }
  }

  const closeCreating = () => {
    stopTick()
    setCreating(false)
    setProgress({ pct: 0, msg: '', error: '' })
  }

  // ---------- 详情弹窗：依赖列表 + 安装 + 卸载 ----------

  const handleShowDetail = async (env: EnvInfo) => {
    setDetailEnv(env.name)
    setDetailOpen(true)
    setDetailInput('')
    setDetailQuery('')
    setDetailBusy(false)
    setUninstalling(null)
    await loadDeps(env.name)
  }

  const loadDeps = useCallback(async (name: string) => {
    setDetailLoading(true)
    try {
      setDetailList(await listPackages(name))
    } catch (e) {
      message.error(`读取依赖失败：${String(e)}`)
      setDetailList([])
    } finally {
      setDetailLoading(false)
    }
  }, [message])

  const handleDetailInstall = async () => {
    const specs = parsePackages(detailInput)
    if (!specs.length) {
      message.warning('请填写至少一个依赖（如 numpy、pandas=2.2）')
      return
    }
    setDetailBusy(true)
    const res = await installPackages(detailEnv, specs)
    result(res, '依赖安装完成')
    if (res.ok) {
      setDetailInput('')
      await loadDeps(detailEnv)
    }
    setDetailBusy(false)
  }

  const handleDetailUninstall = async (pkgName: string) => {
    if (PROTECTED_PKGS.has(pkgName)) return
    setUninstalling(pkgName)
    const res = await uninstallPackages(detailEnv, [pkgName])
    result(res, `已卸载 ${pkgName}`)
    if (res.ok) await loadDeps(detailEnv)
    setUninstalling(null)
  }

  // ---------- 重置 / 删除 / 运行脚本 ----------

  const handleReset = (env: EnvInfo) =>
    runOp(`reset:${env.name}`, () => resetEnv(env.name, '3.11'), `环境「${env.name}」已重置`)

  const handleDelete = (env: EnvInfo) =>
    runOp(`del:${env.name}`, () => deleteEnv(env.name), `环境「${env.name}」已删除`)

  const handleInit = (env: EnvInfo) =>
    runOp(`init:${env.name}`, () => createEnv(env.name, '3.11'), `环境「${env.name}」创建成功`)

  const handlePickScript = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Python 脚本', extensions: ['py'] }],
      })
      // tauri-plugin-dialog 对手选文件自动 allow_file；F002 Rust 边界仍独立校验能否执行。
      if (typeof selected === 'string') setRunPath(selected)
    } catch (e) {
      message.error(`选择文件失败：${String(e)}`)
    }
  }

  const handleRun = () => {
    if (!runPath.trim()) {
      message.warning('请先选择要运行的 Python 脚本')
      return
    }
    setBusy(`run:${runEnv}`)
    setRunOutput('运行中…')
    // 🔴 F049 收尾修复（时序）：必须**串行**——先等register 完成再取 run_id。
    //
    // 故障链：原实现 `void lastScriptRunId()` 与 `runScript()` 并发发起，
    // Rust 的 register_script_run() 未必赶在查询之前完成 → 读到上一次运行
    // 遗留的陈旧 id（注销只清注册表、未清 LAST_ID）→ 用户第二次点「停止」
    // 实际发给了已结束的旧 run，新脚本照跑到底。
    // 真机日志实证：两次取消的 run_id 完全相同（`sbr_1791374237784_0`）。
    //
    // 注意：不能只把 `runScript` 改成 `await` 就完事——`invoke` 只有在
    // Rust 真正开始处理时才注册，故必须等 runScript 这个 promise **发起**
    // 之后再查。写成串行链是唯一可靠解。
    void (async () => {
      // 第1 步：发起运行（不 await 结果，只等它被 Rust 接收并完成 register）
      const running = runScript(runEnv, runPath.trim())
      // 第 2 步：register 已完成，此刻查到的必然是本次运行
      void lastScriptRunId()
        .then((id) => setRunId(id))
        .catch(() => setRunId(null))
      // 第 3 步：等运行结果并渲染
      try {
        const res = await running
        if (res.ok) {
          setRunOutput(res.data || '（无输出）')
          message.success('脚本执行完成')
        } else if (isScriptCancelled(res.error)) {
          // 按机器可读前缀判定，不再匹配中文文案 —— 详见 script-cancel.ts 注释。
          setRunOutput(stripCancelledPrefix(res.error!))
          message.info('脚本已取消')
        } else {
          setRunOutput(res.error || '执行失败')
          message.error('脚本执行失败')
        }
      } finally {
        setBusy(null)
        setRunId(null)
      }
    })()
  }

  /** F049：停止正在运行的脚本。 */
  const handleStop = async () => {
    const id = runId ?? (await lastScriptRunId())
    if (!id) {
      message.info('没有正在运行的脚本')
      return
    }
    setRunOutput('正在停止…')
    const ok = await cancelScript(id)
    if (ok) {
      message.info('已请求停止，进程树正在终止')
    } else {
      // run 已结束（竞态）：交由 runScript 的 finally 收尾
      message.info('脚本已结束，无需停止')
    }
  }

  const createDisabled = !!nameError || !createName.trim()

  return (
    <div className="sandbox-py">
      {/* 顶部 Header */}
      <div className="sandbox-py__head">
        <div>
          <h2 className="sandbox-py__title">Python 沙箱环境</h2>
          <p className="sandbox-py__lead">
            管理内嵌 Micromamba 的绿色便携 Python 运行时；
            <b>default</b> 为 Agent 默认环境（启动时自动创建，不可删除 / 重置）。
          </p>
        </div>
        <div className="sandbox-py__actions">
          <Button icon={<RefreshCw size={15} />} onClick={refresh} disabled={loading}>
            刷新
          </Button>
          <Button variant="soft" icon={<Plus size={15} />} onClick={openCreate}>
            新建环境
          </Button>
        </div>
      </div>

      {/* 环境卡片网格 */}
      {loading ? (
        <div className="sandbox-py__loading">
          <Spin />
        </div>
      ) : envs.length === 0 ? (
        <Empty description="暂无 Python 环境" />
      ) : (
        <div className="sandbox-py__grid">
          {envs.map((env) => (
            <EnvCard
              key={env.name}
              env={env}
              busy={busy}
              onRun={() => {
                setRunEnv(env.name)
                setRunPath('')
                setRunOutput('')
                setRunOpen(true)
              }}
              onDetail={() => handleShowDetail(env)}
              onReset={() => handleReset(env)}
              onDelete={() => handleDelete(env)}
              onInit={() => handleInit(env)}
            />
          ))}
        </div>
      )}

      {/* 新建环境弹窗 */}
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建 Python 环境"
        description="创建最纯净的 Python 环境（仅解释器本身），可选预装依赖，创建后自动安装。"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              variant="soft"
              icon={<Plus size={15} />}
              onClick={handleCreate}
              disabled={createDisabled}
            >
              创建
            </Button>
          </>
        }
      >
        <Field>
          <FieldLabel htmlFor="env-name">
            环境名称<span className="sandbox-py__required">*</span>
          </FieldLabel>
          <Input
            id="env-name"
            autoComplete="off"
            placeholder="如 py39、data-science"
            value={createName}
            status={nameError ? 'error' : undefined}
            onChange={(e) => {
              setCreateName(e.target.value)
              validateName(e.target.value)
            }}
          />
          {nameError && <span className="sandbox-py__field-error">{nameError}</span>}
        </Field>

        <Field>
          <FieldLabel htmlFor="env-py">Python 版本</FieldLabel>
          <AutoComplete
            id="env-py"
            className="sandbox-py__autocomplete"
            value={createPy}
            options={versionOptions}
            placeholder="如 3.11"
            filterOption={(input, option) =>
              String(option?.value ?? '')
                .toLowerCase()
                .includes(input.toLowerCase())
            }
            onChange={(v) => setCreatePy(v)}
          />
          <span className="sandbox-py__hint">
            下拉选择已有版本；输入新版本（如 3.12）将创建新系统。
          </span>
        </Field>

        <Field>
          <FieldLabel htmlFor="env-pre">预装包</FieldLabel>
          <Input.TextArea
            id="env-pre"
            autoComplete="off"
            rows={3}
            placeholder={'numpy, pandas=2.2, requests>=2.31'}
            value={createPre}
            onChange={(e) => setCreatePre(e.target.value)}
          />
          <span className="sandbox-py__hint">
            多个依赖用逗号或空格分隔，可带版本约束；留空则仅创建纯净环境。
          </span>
        </Field>
      </Modal>

      {/* 详情弹窗：依赖列表 + 安装 + 卸载 */}
      <Modal
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={`依赖管理 · ${detailEnv}`}
        description="查看已安装依赖，可安装新依赖或卸载指定依赖。"
        width={560}
        footer={<Button onClick={() => setDetailOpen(false)}>关闭</Button>}
      >
        <div className="sandbox-py__detail">
          <div className="sandbox-py__detail-install">
            <Input.TextArea
              autoComplete="off"
              rows={2}
              placeholder={'安装新依赖：numpy, pandas=2.2'}
              value={detailInput}
              disabled={detailBusy}
              onChange={(e) => setDetailInput(e.target.value)}
            />
            <Button
              variant="soft"
              icon={<PackagePlus size={15} />}
              onClick={handleDetailInstall}
              loading={detailBusy}
              disabled={detailBusy}
            >
              安装依赖
            </Button>
          </div>

          <div className="sandbox-py__detail-list">
            <Input
              className="sandbox-py__detail-search"
              prefix={<Search size={14} />}
              allowClear
              placeholder="搜索已安装依赖，确认是否已安装…"
              value={detailQuery}
              disabled={detailBusy}
              onChange={(e) => setDetailQuery(e.target.value)}
            />
            {detailLoading ? (
              <div className="sandbox-py__loading">
                <Spin />
              </div>
            ) : detailList.length === 0 ? (
              <Empty description="该环境暂无依赖" />
            ) : shownDeps.length === 0 ? (
              <Empty description={`未找到包含「${detailQuery.trim()}」的依赖`} />
            ) : (
              <ul className="sandbox-py__deps">
                <li className="sandbox-py__dep-head" aria-hidden="true">
                  <span className="sandbox-py__dep-head-name">包名</span>
                  <span className="sandbox-py__dep-head-ver">版本号</span>
                  <span className="sandbox-py__dep-head-op">操作</span>
                </li>
                {shownDeps.map((p) => {
                  const locked = PROTECTED_PKGS.has(p.name)
                  return (
                    <li key={p.name} className="sandbox-py__dep">
                      <span className="sandbox-py__dep-name">{p.name}</span>
                      <span className="sandbox-py__dep-ver">{p.version}</span>
                      <Tooltip title={locked ? '核心解释器不可卸载' : `卸载 ${p.name}`}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`卸载 ${p.name}`}
                          className="sandbox-py__dep-del"
                          disabled={locked || uninstalling !== null}
                          loading={uninstalling === p.name}
                          onClick={() => handleDetailUninstall(p.name)}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </Tooltip>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </Modal>

      {/* 运行脚本弹窗 */}
      <Modal
        open={runOpen}
        onOpenChange={setRunOpen}
        title={`运行脚本 · ${runEnv}`}
        description="选择本地 .py 脚本，在所选环境中执行并查看输出。"
        width={680}
        footer={
          <>
            <Button onClick={() => setRunOpen(false)}>关闭</Button>
            <Button
              variant="soft"
              icon={<Play size={15} />}
              onClick={handleRun}
              disabled={busy === `run:${runEnv}`}
            >
              运行
            </Button>
            {/* F049：运行中时可停止（终止进程树连带子进程） */}
            {busy === `run:${runEnv}` && (
              <Button
                variant="ghost"
                danger
                icon={<Square size={15} />}
                onClick={() => void handleStop()}
                title="停止运行（会终止脚本及其子进程）"
              >
                停止
              </Button>
            )}
          </>
        }
      >
        <Field>
          <FieldLabel htmlFor="run-path">脚本路径</FieldLabel>
          <div className="sandbox-py__path-row">
            <Input
              id="run-path"
              autoComplete="off"
              placeholder="选择或粘贴 .py 脚本路径"
              value={runPath}
              onChange={(e) => setRunPath(e.target.value)}
            />
            <Button icon={<FolderOpen size={15} />} onClick={handlePickScript}>
              浏览
            </Button>
          </div>
        </Field>
        <div className="sandbox-py__output">
          <div className="sandbox-py__output-label">输出</div>
          <pre className="sandbox-py__output-pre">{runOutput || '（尚未运行）'}</pre>
        </div>
      </Modal>

      {/* 全屏创建进度遮罩 */}
      {creating && (
        <div className="sandbox-py__creating" role="alertdialog" aria-busy="true">
          <div className="sandbox-py__creating-card">
            <div className="sandbox-py__creating-title">
              {progress.error ? (
                <AlertCircle size={18} className="sandbox-py__creating-icon--err" />
              ) : (
                <CheckCircle2 size={18} className="sandbox-py__creating-icon--ok" />
              )}
              正在创建 Python 环境
            </div>
            <div className="sandbox-py__creating-msg">{progress.msg || '请稍候…'}</div>

            <div className="sandbox-py__creating-bar">
              <div
                className={`sandbox-py__creating-fill${
                  progress.error ? ' is-error' : progress.pct >= 100 ? ' is-done' : ''
                }`}
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <div className="sandbox-py__creating-pct">{progress.pct}%</div>

            {progress.error && (
              <>
                <div className="sandbox-py__creating-error">{progress.error}</div>
                <Button variant="soft" onClick={closeCreating}>
                  关闭
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 右上角状态徽标（圆点 + 文案，对齐 MCP 风格）。 */
function StatusPill({ exists }: { exists: boolean }) {
  return (
    <span className={`sandbox-py__status ${exists ? 'is-ready' : 'is-idle'}`}>
      <i className="sandbox-py__dot" />
      {exists ? '就绪' : '未创建'}
    </span>
  )
}

/** 卡片中部的一条元信息（图标 + 标签 + 值）。 */
function MetaItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu
  label: string
  value: string
}) {
  return (
    <div className="sandbox-py__meta-item">
      <Icon size={14} />
      <span className="sandbox-py__meta-label">{label}</span>
      <b>{value}</b>
    </div>
  )
}

/** 单个环境卡片（上：名称 + 状态 / 中：版本 + 依赖数 / 下：图标按钮组）。 */
function EnvCard({
  env,
  busy,
  onRun,
  onDetail,
  onReset,
  onDelete,
  onInit,
}: {
  env: EnvInfo
  busy: string | null
  onRun: () => void
  onDetail: () => void
  onReset: () => void
  onDelete: () => void
  onInit: () => void
}) {
  const isBusy = busy !== null
  const protectedEnv = env.is_default

  return (
    <Card frame="solid" className="sandbox-py__card">
      {/* 上：系统名称 + 状态 */}
      <div className="sandbox-py__card-top">
        <div className="sandbox-py__card-name">
          <Terminal size={16} />
          <span>{env.name}</span>
          {protectedEnv && <span className="sandbox-py__badge">Agent 默认</span>}
        </div>
        <StatusPill exists={env.exists} />
      </div>

      {/* 中：Python 版本 + 依赖数量 */}
      <div className="sandbox-py__card-mid">
        <MetaItem
          icon={Cpu}
          label="Python"
          value={env.exists ? env.python_version ?? '—' : '—'}
        />
        <MetaItem
          icon={Package}
          label="依赖"
          value={env.exists ? String(env.package_count) : '0'}
        />
      </div>

      {/* 下：图标按钮组 */}
      <div className="sandbox-py__card-actions">
        {!env.exists ? (
          <Button
            variant="soft"
            style={{ width: '100%' }}
            icon={<Plus size={15} />}
            onClick={onInit}
            loading={isBusy}
            disabled={isBusy}
          >
            创建环境
          </Button>
        ) : (
          <>
            <Tooltip title="运行脚本">
              <Button variant="ghost" size="icon-sm" aria-label="运行脚本" onClick={onRun} disabled={isBusy}>
                <Play size={16} />
              </Button>
            </Tooltip>
            <Tooltip title="详情">
              <Button variant="ghost" size="icon-sm" aria-label="详情" onClick={onDetail} disabled={isBusy}>
                <Eye size={16} />
              </Button>
            </Tooltip>
            <Popconfirm
              title="重置环境"
              description="将清空该环境全部依赖并重建纯净 Python 环境，此操作不可恢复。"
              onConfirm={onReset}
              okText="重置"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Tooltip title={protectedEnv ? '默认环境不可重置' : '清空所有依赖并重建'}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="重置"
                  className="sandbox-py__act-reset"
                  disabled={isBusy || protectedEnv}
                  loading={busy === `reset:${env.name}`}
                >
                  <RefreshCw size={16} />
                </Button>
              </Tooltip>
            </Popconfirm>
            <Popconfirm
              title="删除环境"
              description={`确认删除环境「${env.name}」？此操作不可恢复。`}
              onConfirm={onDelete}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Tooltip title={protectedEnv ? '默认环境不可删除' : '删除该环境'}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除"
                  className="sandbox-py__act-del"
                  disabled={isBusy || protectedEnv}
                  loading={busy === `del:${env.name}`}
                >
                  <Trash2 size={16} />
                </Button>
              </Tooltip>
            </Popconfirm>
          </>
        )}
      </div>
    </Card>
  )
}
