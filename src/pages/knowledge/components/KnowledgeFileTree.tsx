/**
 * 知识库目录结构树（复用技能目录树交互）。
 *
 * 数据源为 kbFs.readKbFileTree 返回的 KbFileTreeNode（目录优先、同类按名称排序）。
 * 可点击选择文件（onSelectFile 回传 relPath），目录行可收叠 / 展开，默认全部收起；
 * 选中文件时自动展开其祖先目录。
 */
import { useEffect, useRef, useState } from 'react'
import { Popconfirm } from 'antd'
import {
  Folder,
  FolderOpen,
  FileText,
  FileImage,
  FileCode,
  FileJson,
  FileSpreadsheet,
  Presentation,
  FileAudio,
  FileVideo,
  FileArchive,
  ChevronRight,
  ChevronDown,
  Trash2,
} from 'lucide-react'
import type { KbFileTreeNode } from '@/core/file/kbFs'

/** 扩展名 -> lucide 图标组件（按文件大类区分；后续可替换为用户提供的静态资源）。 */
function fileIconForExt(ext: string | null): React.ComponentType<{ size?: number; className?: string }> {
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'bmp':
    case 'ico':
    case 'avif':
      return FileImage
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'oga':
    case 'flac':
    case 'aac':
    case 'm4a':
      return FileAudio
    case 'mp4':
    case 'webm':
    case 'ogv':
    case 'mov':
    case 'mkv':
    case 'avi':
      return FileVideo
    case 'xls':
    case 'xlsx':
    case 'csv':
      return FileSpreadsheet
    case 'ppt':
    case 'pptx':
      return Presentation
    case 'json':
      return FileJson
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'html':
    case 'htm':
    case 'css':
    case 'scss':
    case 'less':
    case 'py':
    case 'java':
    case 'go':
    case 'rs':
    case 'c':
    case 'cpp':
    case 'sh':
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'xml':
    case 'sql':
      return FileCode
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      return FileArchive
    // 文本 / 文档 / 日志 / PDF 等统一走文档图标
    case 'txt':
    case 'md':
    case 'markdown':
    case 'log':
    case 'doc':
    case 'docx':
    case 'pdf':
    default:
      return FileText
  }
}

function extOf(name: string): string | null {
  const i = name.lastIndexOf('.')
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : null
}

export interface KnowledgeFileTreeProps {
  tree?: KbFileTreeNode | null
  /** 传入即启用「点击文件」交互；回传该文件的 relPath */
  onSelectFile?: (relPath: string) => void
  /** 当前选中的 relPath（与 onSelectFile 配合使用） */
  selectedPath?: string | null
  /** 当前上传 / 新建目标目录（相对知识库根目录，'' 表示根目录）；由详情页维护 */
  activeDir?: string
  /** 点击文件夹时回传其 relPath，作为上传 / 新建目标目录 */
  onSelectFolder?: (relPath: string) => void
  /** 删除条目（文件或目录）的回调，传入 relPath；由父页负责二次确认与实际删除 */
  onDeletePath?: (relPath: string) => void
  /** 拖拽移动条目：把 fromRel 移动到 toDirRel 目录下（toDirRel 为空串表示根目录） */
  onMoveEntry?: (fromRel: string, toDirRel: string) => void
  /** 定位信号：自增时展开选中文件的祖先目录并滚动到该行（由「定位」按钮驱动） */
  locateNonce?: number
}

/** 收集整棵树所有目录的 relPath（用于「默认全部收起」） */
function collectDirRelPaths(node: KbFileTreeNode, set: Set<string>) {
  if (node.isDir) {
    if (node.relPath) set.add(node.relPath)
    for (const c of node.children) collectDirRelPaths(c, set)
  }
}

export function KnowledgeFileTree({
  tree,
  onSelectFile,
  selectedPath,
  activeDir = '',
  onSelectFolder,
  onDeletePath,
  onMoveEntry,
  locateNonce = 0,
}: KnowledgeFileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** 当前正在拖拽的条目 relPath（同组件内可靠传递，比 dataTransfer 跨渲染更稳） */
  const draggedRel = useRef<string | null>(null)
  /** 目录树根 <ul>，用于「定位」时查找并滚动到选中行 */
  const rootRef = useRef<HTMLUListElement>(null)

  // 目录树首次 / 重新加载时，默认所有文件夹收起
  useEffect(() => {
    if (!tree) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      collectDirRelPaths(tree, next)
      return next
    })
  }, [tree])

  // 定位信号变化：展开选中文件的祖先目录并滚动到其所在行
  useEffect(() => {
    if (locateNonce <= 0 || !selectedPath || !tree) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      const segs = selectedPath.split('/')
      let acc = ''
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i]
        next.delete(acc)
      }
      return next
    })
    requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector('[data-selected="true"]')
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [locateNonce, selectedPath, tree])

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
    return <div className="kb-tree__empty">无法读取目录（非桌面端或暂无磁盘文件）</div>
  }
  if (!tree.children.length) {
    return <div className="kb-tree__empty">目录为空</div>
  }
  return (
    <ul
      className="kb-tree"
      ref={rootRef}
      onDragOver={(e) => {
        // 允许拖到根目录空白区域时放入根目录（光标显示 move）
        if (onMoveEntry) e.preventDefault()
      }}
      onDrop={(e) => {
        const src = e.dataTransfer.getData('text/plain') || draggedRel.current || ''
        if (src && onMoveEntry) {
          e.preventDefault()
          onMoveEntry(src, '')
        }
        draggedRel.current = null
      }}
    >
      {tree.children.map((n) => (
        <TreeNode
          key={n.relPath || n.name}
          node={n}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
          activeDir={activeDir}
          onSelectFolder={onSelectFolder}
          onDeletePath={onDeletePath}
          onMoveEntry={onMoveEntry}
          draggedRel={draggedRel}
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
  activeDir,
  onSelectFolder,
  onDeletePath,
  onMoveEntry,
  draggedRel,
}: {
  node: KbFileTreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (relPath: string) => void
  onSelectFile?: (relPath: string) => void
  selectedPath?: string | null
  activeDir?: string
  onSelectFolder?: (relPath: string) => void
  onDeletePath?: (relPath: string) => void
  onMoveEntry?: (fromRel: string, toDirRel: string) => void
  draggedRel?: React.MutableRefObject<string | null>
}) {
  const clickable = !!onSelectFile && !node.isDir
  const isSelected = clickable && selectedPath === node.relPath
  const isDir = node.isDir
  const isCollapsed = isDir && collapsed.has(node.relPath)
  const isActiveFolder = isDir && node.relPath === activeDir
  const [dragOver, setDragOver] = useState(false)
  /** 按扩展名选择文件图标（图片 / 音频 / 视频 / 表格 / 演示 / 代码 / 文档等） */
  const FileIconComp = fileIconForExt(extOf(node.name))

  const handleRowClick = () => {
    if (isDir) {
      onToggle(node.relPath)
      // 点击文件夹即将其设为上传 / 新建目标目录
      onSelectFolder?.(node.relPath)
    } else if (clickable) {
      onSelectFile?.(node.relPath)
    }
  }

  /** 拖拽放置到本文件夹：把被拖拽条目移入本目录 */
  const handleDrop = (e: React.DragEvent) => {
    const src = e.dataTransfer.getData('text/plain') || draggedRel?.current || ''
    setDragOver(false)
    if (src && onMoveEntry) {
      e.preventDefault()
      e.stopPropagation()
      onMoveEntry(src, node.relPath)
    }
    if (draggedRel) draggedRel.current = null
  }

  const row = (
    <div
      className={
        clickable
          ? `kb-tree__row kb-tree__row--file${isSelected ? ' is-selected' : ''}`
          : `kb-tree__row kb-tree__row--folder${isActiveFolder ? ' is-active' : ''}${
              isDir && dragOver ? ' is-drop-target' : ''
            }`
      }
      style={{ paddingLeft: depth * 16 + 8 }}
      draggable
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
      onDragStart={(e) => {
        if (draggedRel) draggedRel.current = node.relPath
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', node.relPath)
      }}
      onDragEnd={() => {
        if (draggedRel) draggedRel.current = null
        setDragOver(false)
      }}
      onDragOver={
        isDir
          ? (e) => {
              // 始终允许放入（光标显示 move）；移动到自身 / 子目录的非法操作在 drop 时拦截
              if (onMoveEntry) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (!dragOver) setDragOver(true)
              }
            }
          : undefined
      }
      onDragLeave={isDir ? () => setDragOver(false) : undefined}
      onDrop={isDir ? handleDrop : undefined}
      data-selected={isSelected ? 'true' : undefined}
    >
      {isDir ? (
        <>
          <span className="kb-tree__caret">
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
          {isCollapsed ? (
            <Folder size={14} className="kb-tree__icon kb-tree__icon--folder" />
          ) : (
            <FolderOpen size={14} className="kb-tree__icon kb-tree__icon--folder" />
          )}
        </>
      ) : (
        <>
          <span className="kb-tree__caret kb-tree__caret--placeholder" />
          {/* 当前在右侧展示的文件：左侧色点标记，不做整行反色 */}
          {isSelected && <span className="kb-tree__dot" aria-hidden />}
          <FileIconComp size={14} className="kb-tree__icon kb-tree__icon--file" />
        </>
      )}
      <span className="kb-tree__name">{node.name}</span>
      {node.relPath && onDeletePath && (
        <Popconfirm
          title={node.isDir ? '删除该目录及其全部内容？' : '删除该文件？'}
          description="删除后不可恢复"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDeletePath(node.relPath)}
        >
          <button
            type="button"
            className="kb-tree__del"
            title="删除"
            aria-label="删除"
            onClick={(e) => e.stopPropagation()}
          >
            <Trash2 size={13} />
          </button>
        </Popconfirm>
      )}
    </div>
  )

  return (
    <li className="kb-tree__node">
      {row}
      {isDir && !isCollapsed && node.children.length > 0 && (
        <ul
          className="kb-tree"
          onDragOver={(e) => {
            // 拖到文件夹的子区域时，目标仍是本文件夹
            if (onMoveEntry) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }
          }}
          onDrop={(e) => {
            const src = e.dataTransfer.getData('text/plain') || draggedRel?.current || ''
            if (src && onMoveEntry) {
              e.preventDefault()
              e.stopPropagation()
              onMoveEntry(src, node.relPath)
            }
            if (draggedRel) draggedRel.current = null
          }}
        >
          {node.children.map((c) => (
            <TreeNode
              key={c.relPath || c.name}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
              activeDir={activeDir}
              onSelectFolder={onSelectFolder}
              onDeletePath={onDeletePath}
              onMoveEntry={onMoveEntry}
              draggedRel={draggedRel}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
