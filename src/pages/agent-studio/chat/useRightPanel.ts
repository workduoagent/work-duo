/**
 * 右侧投影面板 UI 态（台账 S1：自 chat.tsx 原样迁出 hook 化，行为零改动）。
 *
 * 覆盖：面板开合 / Tab / 宽度拖拽（含窗口 resize clamp）、图片放大预览、
 * §3.2 产物预览（read_artifact 拉取）、四类 HITL 挂起时自动升起「处置」Tab。
 * 分支联动 handler（handleBranchFromStep / handleApplyBranch，执行图域）与
 * send/ensureRound 运行链路耦合，留待 useChatRun 批次迁移。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import type { ReadArtifactResult } from '../session/types'

export function useRightPanel(opts: {
  /** 四类 HITL 挂起态（仅判真值）：任一挂起自动展开右栏并切「处置」Tab。 */
  pendingApproval: unknown
  recovery: unknown
  pendingChoice: unknown
  planApproval: unknown
  workspaceDir: string | null
}) {
  const { pendingApproval, recovery, pendingChoice, planApproval, workspaceDir } = opts
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<'graph' | 'process' | 'artifacts' | 'actions'>('graph')
  // 右栏宽度（可鼠标拖拽调节）：悬浮面板宽度。上限动态 clamp（窗口宽 - 左侧栏 - 主区最小 420px），
  // 窄窗口自动收窄，避免悬浮面板盖满对话区。
  const [rightWidth, setRightWidth] = useState(() => {
    const max = Math.max(340, Math.min(680, window.innerWidth - 220 - 420))
    return Math.min(680, max)
  })
  // 窗口尺寸变化时 clamp 右栏宽度（悬浮面板不再参与 flex 分配，需自行约束）
  useEffect(() => {
    const onResize = () => {
      const max = Math.max(340, Math.min(680, window.innerWidth - 220 - 420))
      setRightWidth((w) => Math.min(w, max))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const resizingRef = useRef(false)
  const resizeElRef = useRef<HTMLDivElement>(null)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    resizeElRef.current?.classList.add('is-dragging')
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      // 右栏右侧留 14px margin；按指针位置反推右栏宽度；上限随窗口动态 clamp
      const w = window.innerWidth - ev.clientX - 14
      const max = Math.max(340, Math.min(680, window.innerWidth - 220 - 420))
      setRightWidth(Math.min(max, Math.max(300, w)))
    }
    const onUp = () => {
      resizingRef.current = false
      resizeElRef.current?.classList.remove('is-dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  // 图片放大预览：点击气泡/待发区缩略图打开
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // §3.2 产物预览：点击画布节点产物调 read_artifact 命令获取内容，在 Modal 里展示
  const [artifactPreview, setArtifactPreview] = useState<ReadArtifactResult | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)

  // §3.2 画布交互回调
  // 点击产物文件 → 调 read_artifact 命令获取内容（文本/图片/目录列表），在 Modal 展示
  const handlePreviewArtifact = useCallback(
    async (path: string) => {
      if (!isTauri) return
      setArtifactLoading(true)
      setArtifactPreview(null)
      try {
        const result = await invoke<ReadArtifactResult>('read_artifact', {
          path,
          workspace: workspaceDir ?? null,
        })
        setArtifactPreview(result)
      } catch (e) {
        setArtifactPreview({
          path,
          name: path,
          kind: 'error',
          size: 0,
          content: `读取产物失败：${e}`,
          truncated: false,
        })
      } finally {
        setArtifactLoading(false)
      }
    },
    [isTauri, workspaceDir],
  )

  // 挂起自动聚焦（处置中心版）：四类 HITL 任一挂起时自动展开右栏并切到「处置」Tab。
  useEffect(() => {
    if (pendingApproval || recovery || pendingChoice || planApproval) {
      setRightOpen(true)
      setRightTab('actions')
    }
  }, [pendingApproval, recovery, pendingChoice, planApproval])

  return {
    rightOpen,
    setRightOpen,
    rightTab,
    setRightTab,
    rightWidth,
    resizeElRef,
    startResize,
    previewSrc,
    setPreviewSrc,
    artifactPreview,
    setArtifactPreview,
    artifactLoading,
    setArtifactLoading,
    handlePreviewArtifact,
  }
}
