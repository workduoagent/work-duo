/**
 * 路由页面「LLM」：模型接入中心。
 * - 左侧悬浮纵向分类导航（文本 / 多模态 / 语音转文字 / 文字转语音 / 向量 / 重排序）；
 * - 各分类下模型卡片的增删改、启用停用、连通性测试；
 * - 支持「导入配置」批量入库（JSON）；
 * - 数据持久化走 src/core/mapper/model-mapper.ts（SQLite：workduo.db）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SquarePlus, Import, Download } from 'lucide-react'
import { Button } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  bulkUpsertModels,
  deleteModel,
  listModels,
  setModelEnabled,
  upsertModel,
} from '@/core/mapper/model-mapper'
import { type ModelConfig, MODEL_CATEGORY_OPTIONS } from '@/core/file/model-file'
import { saveTextFile } from '@/core/file/export-file'
import { BatchExportModal } from '@/components/export'
import { CategoryTabs } from './components/CategoryTabs'
import { ModelList } from './components/ModelList'
import { ModelFormModal } from './components/ModelFormModal'
import { ImportModal } from './components/ImportModal'
import './index.scss'

export default function ModelSettingsPage() {
  const { message } = useNotify()
  const [category, setCategory] = useState<string>('all')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [loading, setLoading] = useState(true)
  // F046：此前 try/finally 无 catch —— 加载失败后 models 保持空数组，
  // 页面显示「暂无模型配置」，用户误判为「没有数据」而非「加载失败」
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  // null = 新增；非 null = 编辑该模型
  const [editing, setEditing] = useState<ModelConfig | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setModels(await listModels())
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 各分类数量徽章
  const counts = useMemo(() => {
    const acc = {} as Partial<Record<string, number>>
    for (const m of models) {
      acc[m.category] = (acc[m.category] ?? 0) + 1
    }
    return acc
  }, [models])

  const categoryOptions = [...MODEL_CATEGORY_OPTIONS]

  const visibleModels = useMemo(
    () => (category === 'all' ? models : models.filter((m) => m.category === category)),
    [models, category],
  )

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(model: ModelConfig) {
    setEditing(model)
    setModalOpen(true)
  }

  async function handleSave(model: ModelConfig) {
    setModels(await upsertModel(model))
  }

  async function handleDelete(id: string) {
    setModels(await deleteModel(id))
  }

  async function handleToggle(id: string, enabled: boolean) {
    setModels(await setModelEnabled(id, enabled))
  }

  async function handleImport(models: ModelConfig[]) {
    setModels(await bulkUpsertModels(models))
  }

  // 批量导出：弹窗选中的模型序列化为 models.json（结构同导入），由用户选择保存位置
  const exportItems = useMemo(
    () =>
      models.map((m) => ({
        id: m.id,
        label: m.name || '(未命名)',
        sub: m.modelName || m.id,
      })),
    [models],
  )

  async function handleExport(ids: string[]) {
    const picked = models.filter((m) => ids.includes(m.id))
    const json = JSON.stringify(picked, null, 2)
    const ok = await saveTextFile('models.json', json)
    if (ok) message.success(`已导出 ${picked.length} 个模型到 models.json`)
  }

  return (
    <div className="ms">
      <header className="ms__head">
        <div>
          <h2 className="ms__title">LLM 模型接入</h2>
          <p className="ms__lead">
            管理本地与云端模型，为智能体和向量检索提供基础算力。
          </p>
        </div>
        <div className="ms__actions">
          <Button variant="soft" size="sm" onClick={() => setImportOpen(true)}>
            <Import size={14} />
            导入配置
          </Button>
          <Button
            variant="soft"
            size="sm"
            disabled={models.length === 0}
            onClick={() => setExportOpen(true)}
          >
            <Download size={14} />
            批量导出
          </Button>
          <Button size="sm" onClick={openCreate}>
            <SquarePlus size={14} />
            接入模型
          </Button>
        </div>
      </header>

      <div className="ms__layout">
        <CategoryTabs
          options={categoryOptions}
          value={category}
          onChange={setCategory}
          counts={counts}
        />

        <ModelList
          category={category}
          models={visibleModels}
          loading={loading}
          error={loadError}
          onRetry={() => void reload()}
          onEdit={openEdit}
          onDelete={handleDelete}
          onToggleEnabled={handleToggle}
        />
      </div>

      <ModelFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        model={editing}
        category={category}
        onSave={handleSave}
      />

      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={handleImport}
      />

      <BatchExportModal
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="批量导出模型"
        description="勾选要导出的模型（可单选、多选或全选），导出为 models.json，便于备份或迁移。"
        items={exportItems}
        onConfirm={handleExport}
      />
    </div>
  )
}
