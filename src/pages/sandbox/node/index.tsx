/**
 * 路由页面「沙箱环境 / Node」：内嵌 Bun 绿色便携 Node 运行时管理。
 *
 * 与 Python 页同构，但 Node（Bun）**只需单一运行时版本**：Bun 二进制即运行时，
 * 依赖统一装在 bun_root/node_modules，因此没有「创建多环境 / 删除环境」能力——
 * 列表恒为单个 default 环境；reset 仅清空依赖（保留运行时）。
 *
 * 布局（对齐 MCP / Python 模块风格）：
 * - 顶部 Header（标题 / 描述 + 刷新按钮，整行横跨）；
 * - 环境卡片：上（名称 + 状态「就绪」）/ 中（Bun 版本 + 依赖数量）/
 *   下（图标按钮组：运行 / 详情 / 清空依赖），default 受保护（禁删除）；
 * - 详情弹窗融合「依赖列表 + 卸载 + 安装新依赖」三件事于一体；
 * - 运行脚本弹窗：选本地 .mjs/.js/.ts/.cjs 在 default 环境中执行。
 *
 * 数据走 src/core/mapper/bun-mapper.ts（封装 Tauri invoke）。
 * 样式仅用设计令牌 var(--color-*)，tsx/scss 分离，图标用 lucide-react。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Terminal,
  Trash2,
  RefreshCw,
  Play,
  Package,
  PackagePlus,
  Eye,
  Cpu,
  FolderOpen,
  Search,
} from 'lucide-react'
import {
  Button,
  Card,
  Input,
  Modal,
  Field,
  FieldLabel,
  Empty,
  Popconfirm,
  Spin,
  Tooltip,
} from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { open } from '@tauri-apps/plugin-dialog'
import {
  listEnvs,
  initEnv,
  listPackages,
  installPackages,
  uninstallPackages,
  resetEnv,
  runScript,
  type BunEnvInfo,
  type PackageInfo,
} from '@/core/mapper/bun-mapper'
import './index.scss'

/** 系统保留环境名（单一运行时，自动就绪，不可删除）。 */
const RESERVED = 'default'
/** 核心项，禁止从依赖列表卸载（Node 无强制核心包，这里留空，但保留同构钩子）。 */
const PROTECTED_PKGS = new Set<string>()

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

export default function SandboxNodePage() {
  const { message, result } = useNotify()
  const [envs, setEnvs] = useState<BunEnvInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

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
  const [runOutput, setRunOutput] = useState('')

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

  /** 默认环境（default）自动就绪兜底：应用启动已在后台静默创建 bun_root，
   *  但若那次未完成或失败，进入本页即静默补齐。仅在列表加载完成、且无其它操作进行、且 default 缺失时尝试一次。 */
  const autoInitRef = useRef(false)
  useEffect(() => {
    if (autoInitRef.current) return
    if (envs.length === 0) return // 列表尚未加载完成，等 refresh 返回后再判定
    if (busy !== null) return
    const def = envs.find((e) => e.name === RESERVED)
    if (!def || def.exists) {
      autoInitRef.current = true
      return
    }
    autoInitRef.current = true
    setBusy(`init:${RESERVED}`)
    initEnv()
      .then((res) => {
        if (res.ok) message.success('Node 沙箱环境已就绪')
        else message.warning(res.error || 'Node 沙箱环境初始化失败')
      })
      .catch(() => {})
      .finally(() => {
        setBusy(null)
        void refresh()
      })
  }, [envs, busy, message, refresh])

  /** 统一「带忙等 + 结果提示 + 成功后刷新」的操作执行器（用于清空依赖等）。 */
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

  // ---------- 详情弹窗：依赖列表 + 安装 + 卸载 ----------

  const handleShowDetail = async (env: BunEnvInfo) => {
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
      message.warning('请填写至少一个依赖（如 lodash、axios@1.x）')
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

  // ---------- 清空依赖 / 初始化 / 运行脚本 ----------

  const handleReset = (env: BunEnvInfo) =>
    runOp(`reset:${env.name}`, () => resetEnv(env.name), `环境「${env.name}」依赖已清空`)

  const handleInit = (env: BunEnvInfo) =>
    runOp(`init:${env.name}`, () => initEnv(), `环境「${env.name}」创建成功`)

  const handlePickScript = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Node 脚本', extensions: ['mjs', 'cjs', 'js', 'ts'] }],
      })
      // tauri-plugin-dialog 对手选文件自动 allow_file；F002 Rust 边界仍独立校验能否执行。
      if (typeof selected === 'string') setRunPath(selected)
    } catch (e) {
      message.error(`选择文件失败：${String(e)}`)
    }
  }

  const handleRun = () => {
    if (!runPath.trim()) {
      message.warning('请先选择要运行的 Node 脚本')
      return
    }
    setBusy(`run:${runEnv}`)
    setRunOutput('运行中…')
    runScript(runEnv, runPath.trim())
      .then((res) => {
        if (res.ok) {
          setRunOutput(res.data || '（无输出）')
          message.success('脚本执行完成')
        } else {
          setRunOutput(res.error || '执行失败')
          message.error('脚本执行失败')
        }
      })
      .finally(() => setBusy(null))
  }

  return (
    <div className="sandbox-node">
      {/* 顶部 Header */}
      <div className="sandbox-node__head">
        <div>
          <h2 className="sandbox-node__title">Node 沙箱环境</h2>
          <p className="sandbox-node__lead">
            管理内嵌 Bun 的绿色便携 Node 运行时；Bun 二进制即运行时，依赖统一装在
            <b> bun_root/node_modules</b>，仅需单一环境 <b>default</b>（启动时自动就绪）。
          </p>
        </div>
        <div className="sandbox-node__actions">
          <Button icon={<RefreshCw size={15} />} onClick={refresh} disabled={loading}>
            刷新
          </Button>
        </div>
      </div>

      {/* 环境卡片网格 */}
      {loading ? (
        <div className="sandbox-node__loading">
          <Spin />
        </div>
      ) : envs.length === 0 ? (
        <Empty description="暂无 Node 环境" />
      ) : (
        <div className="sandbox-node__grid">
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
              onInit={() => handleInit(env)}
            />
          ))}
        </div>
      )}

      {/* 详情弹窗：依赖管理 */}
      <Modal
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={`依赖管理 · ${detailEnv}`}
        description="查看已安装依赖，可安装新依赖或卸载指定依赖。"
        width={560}
        footer={<Button onClick={() => setDetailOpen(false)}>关闭</Button>}
      >
        <div className="sandbox-node__detail">
          <div className="sandbox-node__detail-install">
            <Input.TextArea
              autoComplete="off"
              rows={2}
              placeholder={'安装新依赖：lodash, axios@1.x'}
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

          <div className="sandbox-node__detail-list">
            <Input
              className="sandbox-node__detail-search"
              prefix={<Search size={14} />}
              allowClear
              placeholder="搜索已安装依赖，确认是否已安装…"
              value={detailQuery}
              disabled={detailBusy}
              onChange={(e) => setDetailQuery(e.target.value)}
            />
            {detailLoading ? (
              <div className="sandbox-node__loading">
                <Spin />
              </div>
            ) : detailList.length === 0 ? (
              <Empty description="该环境暂无依赖" />
            ) : shownDeps.length === 0 ? (
              <Empty description={`未找到包含「${detailQuery.trim()}」的依赖`} />
            ) : (
              <ul className="sandbox-node__deps">
                <li className="sandbox-node__dep-head" aria-hidden="true">
                  <span className="sandbox-node__dep-head-name">包名</span>
                  <span className="sandbox-node__dep-head-ver">版本号</span>
                  <span className="sandbox-node__dep-head-op">操作</span>
                </li>
                {shownDeps.map((p) => {
                  const locked = PROTECTED_PKGS.has(p.name)
                  return (
                    <li key={p.name} className="sandbox-node__dep">
                      <span className="sandbox-node__dep-name">{p.name}</span>
                      <span className="sandbox-node__dep-ver">{p.version}</span>
                      <Tooltip title={locked ? '核心依赖不可卸载' : `卸载 ${p.name}`}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`卸载 ${p.name}`}
                          className="sandbox-node__dep-del"
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
        description="选择本地 .mjs/.js/.ts/.cjs 脚本，在 default 环境中执行并查看输出。"
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
          </>
        }
      >
        <Field>
          <FieldLabel htmlFor="run-path">脚本路径</FieldLabel>
          <div className="sandbox-node__path-row">
            <Input
              id="run-path"
              autoComplete="off"
              placeholder="选择或粘贴 .mjs/.js/.ts/.cjs 脚本路径"
              value={runPath}
              onChange={(e) => setRunPath(e.target.value)}
            />
            <Button icon={<FolderOpen size={15} />} onClick={handlePickScript}>
              浏览
            </Button>
          </div>
        </Field>
        <div className="sandbox-node__output">
          <div className="sandbox-node__output-label">输出</div>
          <pre className="sandbox-node__output-pre">{runOutput || '（尚未运行）'}</pre>
        </div>
      </Modal>
    </div>
  )
}

/** 右上角状态徽标（圆点 + 文案，对齐 MCP 风格）。 */
function StatusPill({ exists }: { exists: boolean }) {
  return (
    <span className={`sandbox-node__status ${exists ? 'is-ready' : 'is-idle'}`}>
      <i className="sandbox-node__dot" />
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
    <div className="sandbox-node__meta-item">
      <Icon size={14} />
      <span className="sandbox-node__meta-label">{label}</span>
      <b>{value}</b>
    </div>
  )
}

/** 单个环境卡片（上：名称 + 状态 / 中：Bun 版本 + 依赖数 / 下：图标按钮组）。 */
function EnvCard({
  env,
  busy,
  onRun,
  onDetail,
  onReset,
  onInit,
}: {
  env: BunEnvInfo
  busy: string | null
  onRun: () => void
  onDetail: () => void
  onReset: () => void
  onInit: () => void
}) {
  const isBusy = busy !== null
  const protectedEnv = env.is_default

  return (
    <Card frame="solid" className="sandbox-node__card">
      {/* 上：系统名称 + 状态 */}
      <div className="sandbox-node__card-top">
        <div className="sandbox-node__card-name">
          <Terminal size={16} />
          <span>{env.name}</span>
          {protectedEnv && <span className="sandbox-node__badge">默认运行时</span>}
        </div>
        <StatusPill exists={env.exists} />
      </div>

      {/* 中：Bun 版本 + 依赖数量 */}
      <div className="sandbox-node__card-mid">
        <MetaItem
          icon={Cpu}
          label="Bun"
          value={env.exists ? env.bun_version ?? '—' : '—'}
        />
        <MetaItem
          icon={Package}
          label="依赖"
          value={env.exists ? String(env.package_count) : '0'}
        />
      </div>

      {/* 下：图标按钮组 */}
      <div className="sandbox-node__card-actions">
        {!env.exists ? (
          <Button
            variant="soft"
            style={{ width: '100%' }}
            icon={<RefreshCw size={15} />}
            onClick={onInit}
            loading={isBusy}
            disabled={isBusy}
          >
            初始化环境
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
              title="清空依赖"
              description="将删除该环境的全部依赖（node_modules），但不会删除 Bun 运行时本身，此操作不可恢复。"
              onConfirm={onReset}
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Tooltip title="清空所有依赖（保留运行时）">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="清空依赖"
                  className="sandbox-node__act-reset"
                  disabled={isBusy}
                  loading={busy === `reset:${env.name}`}
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
