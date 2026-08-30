/**
 * 场景分类下拉选择（受控组件，三模块共用）。
 *
 * 能力：
 *  - 从 scenario_category 表按 scope 加载选项；
 *  - 支持搜索（showSearch）；
 *  - 无匹配项时显示「新建『输入值』」，选中即创建（value 由 label 自动 slug，唯一冲突自动加后缀）；
 *  - 每个选项右侧提供「编辑（仅改 label，行内输入，回车确认）」与「删除（强提示引用数，确认后置空业务引用）」。
 *
 * 用法：<ScenarioSelect scope="SKILL" value={skill.scenario} onChange={...} />
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Pencil, Trash2, Plus } from 'lucide-react'
import { Select, Input, Popconfirm, type InputRef } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  listByScope,
  createScenario,
  updateScenarioLabel,
  deleteScenario,
  countReferences,
} from '@/core/mapper/scenario-mapper'
import type { ScenarioCategory, ScenarioScope } from '@/types/core'
import './ScenarioSelect.scss'

interface ScenarioSelectProps {
  scope: ScenarioScope
  value?: string | null
  onChange: (value: string | null) => void
  placeholder?: string
  allowClear?: boolean
}

const NEW_SENTINEL = '__new__'

export function ScenarioSelect({
  scope,
  value,
  onChange,
  placeholder,
  allowClear = true,
}: ScenarioSelectProps) {
  const { message } = useNotify()
  const [options, setOptions] = useState<ScenarioCategory[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [refCount, setRefCount] = useState(0)
  const editRef = useRef<InputRef>(null)

  const map = useMemo(
    () => new Map(options.map((o) => [o.value, o])),
    [options],
  )

  const reload = async () => {
    setLoading(true)
    try {
      setOptions(await listByScope(scope))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // scope 变化时重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  const hasExact = useMemo(() => {
    const q = norm(search)
    if (!q) return false
    return options.some((o) => norm(o.label) === q || o.value === q)
  }, [search, options])

  const showCreate = search.trim().length > 0 && !hasExact

  const selectOptions = useMemo(() => {
    const base = options.map((o) => ({ value: o.value, label: o.label }))
    if (showCreate) {
      base.unshift({ value: NEW_SENTINEL, label: `新建「${search.trim()}」` })
    }
    return base
  }, [options, showCreate, search])

  async function handleChange(v: string | null) {
    if (v === NEW_SENTINEL) {
      try {
        const created = await createScenario(scope, search.trim())
        await reload()
        onChange(created.value)
        message.success(`已新建分类「${created.label}」`)
      } catch (e) {
        message.error(`新建失败：${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    onChange(v ?? null)
  }

  function startEdit(o: ScenarioCategory) {
    setEditingId(o.id)
    setEditText(o.label)
    // 等待输入框渲染后聚焦
    window.setTimeout(() => editRef.current?.focus(), 0)
  }

  async function commitEdit(o: ScenarioCategory) {
    const label = editText.trim()
    if (!label) {
      setEditingId(null)
      return
    }
    if (label === o.label) {
      setEditingId(null)
      return
    }
    try {
      await updateScenarioLabel(o.id, label)
      await reload()
      message.success('已更新分类名称')
    } catch (e) {
      message.error(`更新失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setEditingId(null)
    }
  }

  async function startDelete(o: ScenarioCategory) {
    setConfirmId(o.id)
    setRefCount(await countReferences(scope, o.value))
  }

  async function confirmDelete(o: ScenarioCategory) {
    try {
      await deleteScenario(o.id)
      await reload()
      if (value === o.value) onChange(null)
      message.success(`已删除分类「${o.label}」`)
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setConfirmId(null)
    }
  }

  function renderOption(opt: { value: string; label: ReactNode }) {
    if (opt.value === NEW_SENTINEL) {
      return (
        <span className="scn-opt scn-opt--create">
          <Plus size={13} /> {opt.label}
        </span>
      )
    }
    const o = map.get(opt.value)
    if (!o) return <span className="scn-opt">{String(opt.label)}</span>

    if (editingId === o.id) {
      return (
        <span
          className="scn-opt scn-opt--edit"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Input
            ref={editRef}
            size="small"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onPressEnter={() => void commitEdit(o)}
            onBlur={() => void commitEdit(o)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingId(null)
            }}
          />
        </span>
      )
    }

    const isConfirm = confirmId === o.id
    return (
      <span className="scn-opt">
        <span className="scn-opt__label">{o.label}</span>
        <span
          className="scn-opt__actions"
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="scn-opt__btn"
            title="编辑名称"
            onClick={(e) => {
              e.stopPropagation()
              startEdit(o)
            }}
          >
            <Pencil size={13} />
          </button>
          {isConfirm ? (
            <Popconfirm
              title={`删除「${o.label}」`}
              description={
                refCount > 0
                  ? `将清空 ${refCount} 条业务引用（置空）`
                  : '确认删除该分类？'
              }
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              open
              onConfirm={() => void confirmDelete(o)}
              onCancel={() => setConfirmId(null)}
            >
              <button
                type="button"
                className="scn-opt__btn scn-opt__btn--danger"
                title="删除"
                onClick={(e) => e.stopPropagation()}
              >
                <Trash2 size={13} />
              </button>
            </Popconfirm>
          ) : (
            <button
              type="button"
              className="scn-opt__btn scn-opt__btn--danger"
              title="删除"
              onClick={(e) => {
                e.stopPropagation()
                void startDelete(o)
              }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </span>
    )
  }

  return (
    <Select
      showSearch
      allowClear={allowClear}
      value={value ?? undefined}
      placeholder={placeholder}
      loading={loading}
      options={selectOptions}
      onSearch={setSearch}
      onChange={(v) => handleChange(v as string | null)}
      filterOption={false}
      optionRender={(opt) =>
        renderOption(opt as unknown as { value: string; label: ReactNode })
      }
      notFoundContent={loading ? '加载中…' : '无匹配项，可输入后回车新建'}
    />
  )
}
