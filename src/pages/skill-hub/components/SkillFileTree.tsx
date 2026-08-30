/**
 * 技能目录结构树。
 *
 * 数据源为 skillFs.readSkillFileTree 返回的 SkillFileTreeNode（目录优先、同类按名称排序）。
 *
 * 两种用法：
 *  - 只读展示（编辑表单）：直接传 tree；
 *  - 可点击选择（详情页文件浏览器）：额外传 onSelectFile + selectedPath，
 *    此时「文件」行变为可点击条目并高亮选中项，点击回传该文件的 relPath。
 *
 * 交互：目录行可点击收叠 / 展开，默认全部收起；选中文件时自动展开其祖先目录。
 */
import { useEffect, useState } from 'react'
import {
  Folder,
  FolderOpen,
  FileText,
  ChevronRight,
  ChevronDown,
} from 'lucide-react'
import type { SkillFileTreeNode } from '@/core/file/skillFs'

export interface SkillFileTreeProps {
  tree?: SkillFileTreeNode | null
  /** 传入即启用「点击文件」交互；回传该文件的 relPath */
  onSelectFile?: (relPath: string) => void
  /** 当前选中的 relPath（与 onSelectFile 配合使用） */
  selectedPath?: string | null
}

/** 收集整棵树所有目录的 relPath（用于「默认全部收起」） */
function collectDirRelPaths(node: SkillFileTreeNode, set: Set<string>) {
  if (node.isDir) {
    if (node.relPath) set.add(node.relPath)
    for (const c of node.children) collectDirRelPaths(c, set)
  }
}

export function SkillFileTree({
  tree,
  onSelectFile,
  selectedPath,
}: SkillFileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // 目录树首次 / 重新加载时，默认所有文件夹收起
  useEffect(() => {
    if (!tree) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      collectDirRelPaths(tree, next)
      return next
    })
  }, [tree])

  // 选中文件变化时，展开其祖先目录，确保当前打开的文件始终可见
  useEffect(() => {
    if (!selectedPath || !tree) return
    setCollapsed((prev) => {
      if (!prev.size) return prev
      const next = new Set(prev)
      const segs = selectedPath.split('/')
      let acc = ''
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i]
        next.delete(acc)
      }
      return next
    })
  }, [selectedPath, tree])

  const toggle = (relPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })

  if (!tree) {
    return (
      <div className="sk-tree__empty">无法读取目录（非桌面端或暂无磁盘文件）</div>
    )
  }
  if (!tree.children.length) {
    return <div className="sk-tree__empty">目录为空</div>
  }
  return (
    <ul className="sk-tree">
      {tree.children.map((n) => (
        <TreeNode
          key={n.relPath || n.name}
          node={n}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
        />
      ))}
    </ul>
  )
}

function TreeNode({
  node,
  depth,
  collapsed,
  onToggle,
  onSelectFile,
  selectedPath,
}: {
  node: SkillFileTreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (relPath: string) => void
  onSelectFile?: (relPath: string) => void
  selectedPath?: string | null
}) {
  const isLogo = !node.isDir && /^logo\./i.test(node.name)
  const isSkillMd = !node.isDir && node.name.toLowerCase() === 'skill.md'
  const clickable = !!onSelectFile && !node.isDir
  const isSelected = clickable && selectedPath === node.relPath
  const isDir = node.isDir
  const isCollapsed = isDir && collapsed.has(node.relPath)

  const handleRowClick = () => {
    if (isDir) onToggle(node.relPath)
    else if (clickable) onSelectFile?.(node.relPath)
  }

  const row = (
    <div
      className={
        clickable
          ? `sk-tree__row sk-tree__row--file${isSelected ? ' is-selected' : ''}`
          : `sk-tree__row${isDir ? ' sk-tree__row--folder' : ''}`
      }
      style={{ paddingLeft: depth * 16 + 8 }}
      onClick={handleRowClick}
      role={isDir || clickable ? 'button' : undefined}
      tabIndex={isDir || clickable ? 0 : undefined}
      onKeyDown={
        isDir || clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleRowClick()
              }
            }
          : undefined
      }
    >
      {isDir ? (
        <>
          <span className="sk-tree__caret">
            {isCollapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </span>
          {isCollapsed ? (
            <Folder size={14} className="sk-tree__icon sk-tree__icon--folder" />
          ) : (
            <FolderOpen size={14} className="sk-tree__icon sk-tree__icon--folder" />
          )}
        </>
      ) : (
        <>
          <span className="sk-tree__caret sk-tree__caret--placeholder" />
          <FileText size={14} className="sk-tree__icon sk-tree__icon--file" />
        </>
      )}
      <span className="sk-tree__name">{node.name}</span>
      {isSkillMd && <span className="sk-tree__badge">SKILL.md</span>}
      {isLogo && <span className="sk-tree__badge sk-tree__badge--logo">logo</span>}
    </div>
  )

  return (
    <li className="sk-tree__node">
      {row}
      {isDir && !isCollapsed && node.children.length > 0 && (
        <ul className="sk-tree">
          {node.children.map((c) => (
            <TreeNode
              key={c.relPath || c.name}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
