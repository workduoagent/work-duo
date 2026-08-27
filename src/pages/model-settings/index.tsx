/**
 * 路由页面「LLM」：模型接入中心。
 * - 左侧悬浮纵向分类导航（文本 / 多模态 / 语音转文字 / 文字转语音 / 向量 / 重排序）；
 * - 各分类下模型卡片的增删改、启用停用、连通性测试；
 * - 支持「导入配置」批量入库（JSON）；
 * - 数据持久化走 src/core/mapper/model-mapper.ts（SQLite：workduo.db）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SquarePlus, Import } from 'lucide-react'
import { Button } from '@/components/ui'
import {
  bulkUpsertModels,
  deleteModel,
  listModels,
  setModelEnabled,
  upsertModel,
} from '@/core/mapper/model-mapper'
import type { ModelConfig } from '@/core/file/model-file'
import type { ModelCategory } from '@/types/core'
import { CategoryTabs } from './components/CategoryTabs'
import { ModelList } from './components/ModelList'
import { ModelFormModal } from './components/ModelFormModal'
import { ImportModal } from './components/ImportModal'
import './index.scss'

export default function ModelSettingsPage() {
  const [category, setCategory] = useState<ModelCategory>('text')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // null = 新增；非 null = 编辑该模型
  const [editing, setEditing] = useState<ModelConfig | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setModels(await listModels())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 各分类数量徽章
  const counts = useMemo(() => {
    const acc = {} as Partial<Record<ModelCategory, number>>
    for (const m of models) {
      acc[m.category] = (acc[m.category] ?? 0) + 1
    }
    return acc
  }, [models])

  const visibleModels = useMemo(
    () => models.filter((m) => m.category === category),
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
          <Button size="sm" onClick={openCreate}>
            <SquarePlus size={14} />
            接入模型
          </Button>
        </div>
      </header>

      <div className="ms__layout">
        <CategoryTabs value={category} onChange={setCategory} counts={counts} />

        <ModelList
          category={category}
          models={visibleModels}
          loading={loading}
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
    </div>
  )
}
