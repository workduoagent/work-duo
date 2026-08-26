/**
 * 路由页面「LLM」：线上模型接入中心。
 * - 6 大分类（文本 / 多模态 / 语音转文字 / 文字转语音 / 向量 / 重排序）切换；
 * - 各分类下模型配置的增删改、启用停用；
 * - 数据持久化走 src/core/file/model-file.ts（$APPDATA/models.json）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui'
import { PlusIcon } from '@/components/ui/icons'
import {
  deleteModel,
  listModels,
  setModelEnabled,
  upsertModel,
  type ModelConfig,
} from '@/core/file/model-file'
import type { ModelCategory } from '@/types/core'
import { isTauri } from '@/core/config'
import { CategoryTabs } from './components/CategoryTabs'
import { ModelList } from './components/ModelList'
import { ModelFormModal } from './components/ModelFormModal'
import './index.scss'

export default function ModelSettingsPage() {
  const [category, setCategory] = useState<ModelCategory>('text')
  const [models, setModels] = useState<ModelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
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

  return (
    <div className="ms">
      <header className="ms__head">
        <div>
          <h2 className="ms__title">LLM 模型接入</h2>
          <p className="ms__lead">
            接入线上模型服务，配置保存在{' '}
            {isTauri ? (
              <code className="ms__code">$APPDATA/models.json</code>
            ) : (
              <code className="ms__code">localStorage（开发模式回退）</code>
            )}
            。
          </p>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon data-icon="start" />
          接入模型
        </Button>
      </header>

      <CategoryTabs value={category} onChange={setCategory} counts={counts} />

      <ModelList
        category={category}
        models={visibleModels}
        loading={loading}
        onEdit={openEdit}
        onDelete={handleDelete}
        onToggleEnabled={handleToggle}
      />

      <ModelFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        model={editing}
        category={category}
        onSave={handleSave}
      />
    </div>
  )
}
