/**
 * 当前分类下的模型列表（卡片网格）。
 * 卡片：状态徽标 / 厂商 Logo（src/assets/images/{provider}.svg）/ 名称 + 模型标识 /
 *      服务商 + 分类标签（含工具调用标识）/ 描述 /
 *      连通性测试结果 / 悬浮操作栏（测试 / 编辑 / 删除 / 启用开关）。
 * 删除走二次确认弹窗（复用 ui/Modal）。
 */
import {useState} from 'react'
import {Pencil, Trash2, Zap, Wrench, Copy, Check} from 'lucide-react'
import {Card, Button, Switch, Modal, SpinnerIcon} from '@/components/ui'
import {
    PROVIDER_OPTIONS,
    getModelCategoryLabel,
    type ModelConfig,
} from '@/core/file/model-file'
import {testModelConnection, shortTestMessage, type ModelTestResult} from '@/utils/modelTest'
import './ModelList.scss'

/**
 * 1. 直接使用 @ 别名，避免相对路径地狱
 * 2. 采用 Vite 4/5 推荐的 ?url 语法获取静态资源地址
 */
const logoModules = import.meta.glob('@/assets/images/*.svg', {
    eager: true,
    query: '?url',
    import: 'default',
})

/**
 * 归一化查表：键 = 小写文件名（去扩展名），值 = URL 字符串。
 * 这样按 provider value（小写）查表即可命中，避免大小写不一致导致的 404。
 */
const logoMap: Record<string, string> = {}
for (const [path, url] of Object.entries(logoModules)) {
    // 因为使用了别名，path 变成了 '@/assets/images/xxx.svg'
    const name = path.split('/').pop()?.replace(/\.svg$/i, '').toLowerCase()
    if (name) {
        logoMap[name] = url as string
    }
}

/**
 * 根据服务商 provider 值返回 Logo URL；找不到时返回空字符串（触发 onError 回退首字母）。
 */
function providerLogoUrl(provider: string): string | undefined {
    return logoMap[provider.toLowerCase()]
}

export interface ModelListProps {
    category: string
    models: ModelConfig[]
    loading?: boolean
    /** F046：加载失败（此前 try/finally 无 catch，失败后列表空→ 被误读为「没有数据」）*/
    error?: Error | string | null
    onRetry?: () => void
    onEdit: (model: ModelConfig) => void
    onDelete: (id: string) => void
    onToggleEnabled: (id: string, enabled: boolean) => void
}

function providerLabel(value: string): string {
    return PROVIDER_OPTIONS.find((p) => p.value === value)?.label ?? value
}

function categoryLabel(value: string): string {
    return getModelCategoryLabel(value)
}

export function ModelList({
                              category,
                              models,
                              loading,
                              error,
                              onRetry,
                              onEdit,
                              onDelete,
                              onToggleEnabled,
                          }: ModelListProps) {
    const [pendingDelete, setPendingDelete] = useState<ModelConfig | null>(null)
    const [testingId, setTestingId] = useState<string | null>(null)
    const [results, setResults] = useState<Record<string, ModelTestResult>>({})
    const [copiedId, setCopiedId] = useState<string | null>(null)

    async function handleTest(m: ModelConfig) {
        if (testingId === m.id) return
        setTestingId(m.id)
        const r = await testModelConnection(m)
        setResults((prev) => ({...prev, [m.id]: r}))
        setTestingId(null)
    }

    // 复制完整报错到剪贴板（摘要只显示状态码，详情由用户自行粘贴查看）
    async function copyTestResult(id: string, text: string) {
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            const ta = document.createElement('textarea')
            ta.value = text
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            ta.remove()
        }
        setCopiedId(id)
        window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    }

    // F046：错误优先于 loading —— 否则加载失败会落进下面的空态分支，
    // 用户把「加载失败」误读为「没有数据」，排查方向从一开始就错。
    if (error) {
        return (
            <div className="model-list">
                <div className="model-list--empty">
                    <p className="model-list__empty-title">模型配置加载失败</p>
                    <p className="model-list__empty-desc">
                        {typeof error === 'string' ? error : error.message}
                    </p>
                    {onRetry && (
                        <Button size="sm" variant="soft" onClick={onRetry} style={{marginTop: 8}}>
                            重试
                        </Button>
                    )}
                </div>
            </div>
        )
    }

    if (loading) {
        return (
            <div className="model-list">
                <p className="model-list--loading">正在加载模型配置…</p>
            </div>
        )
    }

    if (models.length === 0) {
        return (
            <div className="model-list">
                {/* 将空状态作为内部元素，此时 grid-column: 1 / -1 只会在右侧内容区内部生效 */}
                <div className="model-list--empty">
                    <p className="model-list__empty-title">暂无{categoryLabel(category)}配置</p>
                    <p className="model-list__empty-desc">
                        点击右上角「接入模型」，填写服务商与参数即可完成接入。
                    </p>
                </div>
            </div>
        )
    }

    return (
        <>
            <div className="model-list">
                {models.map((m) => {
                    const result = results[m.id]
                    const testing = testingId === m.id
                    const initial = providerLabel(m.provider).charAt(0)
                    const logoUrl = providerLogoUrl(m.provider)
                    return (
                        <Card key={m.id} frame="solid" className="model-card">
              <span
                  className={`model-card__status model-card__status--${
                      m.enabled ? 'on' : 'off'
                  }`}
              >
                <i className="model-card__dot"/>
                  {m.enabled ? '已启用' : '已停用'}
              </span>

                            <div className="model-card__body">
                                <div className="model-card__head">
                                    <div className="model-card__avatar" aria-hidden="true">
                                        {logoUrl && (
                                            <img
                                                className="model-card__logo"
                                                src={logoUrl}
                                                alt={providerLabel(m.provider)}
                                                onError={(e) => {
                                                    // 保留 onError：防范图片由于网络或跨域加载失败的情况
                                                    ;(e.target as HTMLImageElement).style.display = 'none'
                                                    const parent = (e.target as HTMLImageElement).parentElement
                                                    if (parent) {
                                                        const fb = parent.querySelector('.model-card__avatar-fallback')
                                                        if (fb) (fb as HTMLElement).style.display = ''
                                                    }
                                                }}
                                            />
                                        )}
                                        <span className="model-card__avatar-fallback" style={{display: 'none'}}>
                    {initial}
                  </span>
                                    </div>
                                    <div className="model-card__titles">
                                        <h3 className="model-card__name" title={m.name}>
                                            {m.name || '(未命名)'}
                                        </h3>
                                        <code className="model-card__model" title={m.modelName}>
                                            {m.modelName || '—'}
                                        </code>
                                    </div>
                                </div>

                                <div className="model-card__tags">
                                    <span className="model-card__chip">{providerLabel(m.provider)}</span>
                                    <span className="model-card__chip model-card__chip--muted">
                  {categoryLabel(m.category)}
                </span>
                                    {m.toolCalls && (
                                        <span className="model-card__chip model-card__chip--tool"
                                              title="支持 Tool / Function Calling">
                    <Wrench size={11}/>
                    工具调用
                  </span>
                                    )}
                                </div>

                                <p className="model-card__desc" title={m.description ?? ''}>
                                    {m.description || '\u00A0'}
                                </p>
                            </div>

                            {result && (
                                <div
                                    className={`model-card__test model-card__test--${result.level}`}
                                    title={result.message}
                                >
                                    <span className="model-card__test-dot"/>
                                    {/* 摘要只显示级别 + 状态码；完整报错经复制图标获取（防长报错撑爆卡片） */}
                                    {shortTestMessage(result)}
                                    {typeof result.elapsedMs === 'number' && (
                                        <span className="model-card__test-ms">· {result.elapsedMs}ms</span>
                                    )}
                                    {!result.ok && (
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label="复制完整报错信息"
                                            title="复制完整报错信息"
                                            onClick={() => void copyTestResult(m.id, result.message)}
                                        >
                                            {copiedId === m.id ? <Check size={13}/> : <Copy size={13}/>}
                                        </Button>
                                    )}
                                </div>
                            )}

                            <div className="model-card__actions">
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="测试连通性"
                                    title="测试连通性"
                                    disabled={testing}
                                    onClick={() => handleTest(m)}
                                >
                                    {testing ? <SpinnerIcon width={16} height={16}/> : <Zap size={16}/>}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="编辑"
                                    title="编辑"
                                    onClick={() => onEdit(m)}
                                >
                                    <Pencil size={16}/>
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="model-card__del"
                                    aria-label="删除"
                                    title="删除"
                                    onClick={() => setPendingDelete(m)}
                                >
                                    <Trash2 size={16}/>
                                </Button>
                                <Switch
                                    size="small"
                                    checked={m.enabled}
                                    onChange={(v) => onToggleEnabled(m.id, v)}
                                    aria-label="启用开关"
                                />
                            </div>
                        </Card>
                    )
                })}
            </div>

            <Modal
                open={pendingDelete !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingDelete(null)
                }}
                title="删除模型配置"
                width={420}
                footer={
                    <>
                        <Button variant="soft" onClick={() => setPendingDelete(null)}>
                            取消
                        </Button>
                        <Button
                            danger
                            onClick={() => {
                                if (pendingDelete) {
                                    onDelete(pendingDelete.id)
                                    setPendingDelete(null)
                                }
                            }}
                        >
                            删除
                        </Button>
                    </>
                }
            >
                <p className="model-list__confirm-text">
                    确定删除「{pendingDelete?.name || '(未命名)'}」吗？该操作会将其从本地数据库中移除，不可撤销。
                </p>
            </Modal>
        </>
    )
}
