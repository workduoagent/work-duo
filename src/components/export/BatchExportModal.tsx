/**
 * 通用批量导出选择弹窗。
 *
 * 设计：一个弹窗统一覆盖「单选 / 多选 / 全部导出」——
 * 列表项带复选框，顶部「全选」一次勾选全部即等于「全部导出」；
 * 勾选 1 项即「单选」，勾选多项即「多选」。确认时把选中的 id 列表回传给调用方。
 *
 * 调用方负责把选中项序列化成具体文件并保存（models.json / mcpServers.json 等）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { Button, Modal, Checkbox } from '@/components/ui'
import './BatchExportModal.scss'

export interface BatchExportItem {
  /** 唯一标识（模型 id / MCP id 等） */
  id: string
  /** 主标题（如名称） */
  label: string
  /** 次要信息（如标识 / modelName），可选 */
  sub?: string
}

export interface BatchExportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** 可选项列表（全量，调用方一次性传入） */
  items: BatchExportItem[]
  /** 确认导出：回传选中的 id 列表 */
  onConfirm: (ids: string[]) => void | Promise<void>
}

export function BatchExportModal({
  open,
  onOpenChange,
  title,
  description,
  items,
  onConfirm,
}: BatchExportModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)

  // 每次打开重置选择
  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setExporting(false)
    }
  }, [open])

  const allChecked = items.length > 0 && selected.size === items.length
  const indeterminate = selected.size > 0 && selected.size < items.length

  const selectedIds = useMemo(
    () => items.filter((it) => selected.has(it.id)).map((it) => it.id),
    [items, selected],
  )

  function toggleAll(next: boolean) {
    setSelected(next ? new Set(items.map((it) => it.id)) : new Set())
  }

  function toggleOne(id: string, next: boolean) {
    setSelected((prev) => {
      const nextSet = new Set(prev)
      if (next) nextSet.add(id)
      else nextSet.delete(id)
      return nextSet
    })
  }

  async function handleConfirm() {
    if (selectedIds.length === 0) return
    setExporting(true)
    try {
      await onConfirm(selectedIds)
      onOpenChange(false)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={520}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            loading={exporting}
            disabled={selectedIds.length === 0}
            onClick={handleConfirm}
          >
            <Download size={14} />
            导出{selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}
          </Button>
        </>
      }
    >
      <div className="batch-export">
        <div className="batch-export__bar">
          <Checkbox
            checked={allChecked}
            indeterminate={indeterminate}
            onChange={(e) => toggleAll(e.target.checked)}
          >
            全选
          </Checkbox>
          <span className="batch-export__count">
            已选 <b>{selected.size}</b> / 共 {items.length}
          </span>
        </div>

        <div className="batch-export__list">
          {items.length === 0 ? (
            <div className="batch-export__empty">暂无可导出的项目</div>
          ) : (
            items.map((it) => (
              <label key={it.id} className="batch-export__item">
                <Checkbox
                  checked={selected.has(it.id)}
                  onChange={(e) => toggleOne(it.id, e.target.checked)}
                />
                <span className="batch-export__item-text">
                  <span className="batch-export__item-label">{it.label}</span>
                  {it.sub && <code className="batch-export__item-sub">{it.sub}</code>}
                </span>
              </label>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}
