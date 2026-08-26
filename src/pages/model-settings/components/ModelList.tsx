/**
 * 当前分类下的模型列表。
 * 每张卡片：名称 / 服务商 / 模型标识 / Base URL + 启用开关 + 编辑 / 删除。
 * 删除走二次确认弹窗（复用 ui/Modal）。
 */
import { useState } from 'react'
import { EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { Card, Button, Switch, Modal } from '@/components/ui'
import {
  MODEL_CATEGORY_OPTIONS,
  PROVIDER_OPTIONS,
  type ModelConfig,
} from '@/core/file/model-file'
import type { ModelCategory } from '@/types/core'
import './ModelList.scss'

export interface ModelListProps {
  category: ModelCategory
  models: ModelConfig[]
  loading?: boolean
  onEdit: (model: ModelConfig) => void
  onDelete: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
}

function providerLabel(value: string): string {
  return PROVIDER_OPTIONS.find((p) => p.value === value)?.label ?? value
}

function categoryLabel(value: ModelCategory): string {
  return MODEL_CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value
}

export function ModelList({
  category,
  models,
  loading,
  onEdit,
  onDelete,
  onToggleEnabled,
}: ModelListProps) {
  // 待删除确认的模型（null = 弹窗关闭）
  const [pendingDelete, setPendingDelete] = useState<ModelConfig | null>(null)

  if (loading) {
    return <p className="model-list model-list--loading">正在加载模型配置…</p>
  }

  if (models.length === 0) {
    return (
      <div className="model-list model-list--empty">
        <p className="model-list__empty-title">
          暂无{categoryLabel(category)}配置
        </p>
        <p className="model-list__empty-desc">
          点击右上角「接入模型」，填写服务商与参数即可完成接入。
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="model-list">
        {models.map((m) => (
          <Card key={m.id} frame="solid" className="model-card">
            <div className="model-card__main">
              <div className="model-card__head">
                <span className="model-card__name" title={m.name}>
                  {m.name || '(未命名)'}
                </span>
                <span
                  className={`model-card__status${
                    m.enabled ? ' is-on' : ''
                  }`}
                >
                  {m.enabled ? '已启用' : '已停用'}
                </span>
              </div>

              <dl className="model-card__meta">
                <div className="model-card__meta-row">
                  <dt>服务商</dt>
                  <dd>{providerLabel(m.provider)}</dd>
                </div>
                <div className="model-card__meta-row">
                  <dt>模型标识</dt>
                  <dd className="model-card__mono">{m.modelName || '—'}</dd>
                </div>
                <div className="model-card__meta-row">
                  <dt>Base URL</dt>
                  <dd className="model-card__mono model-card__ellipsis">
                    {m.baseUrl || '—'}
                  </dd>
                </div>
              </dl>

              {m.description && (
                <p className="model-card__desc" title={m.description}>
                  {m.description}
                </p>
              )}
            </div>

            <div className="model-card__actions">
              <Switch
                size="small"
                checked={m.enabled}
                onChange={(v) => onToggleEnabled(m.id, v)}
                aria-label="启用开关"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="编辑"
                onClick={() => onEdit(m)}
              >
                <EditOutlined />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="model-card__del"
                aria-label="删除"
                onClick={() => setPendingDelete(m)}
              >
                <DeleteOutlined />
              </Button>
            </div>
          </Card>
        ))}
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
          确定删除「{pendingDelete?.name || '(未命名)'}」吗？该操作会从
          models.json 中移除此条配置，不可撤销。
        </p>
      </Modal>
    </>
  )
}
