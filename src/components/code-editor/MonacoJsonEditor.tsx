import { Suspense, lazy } from 'react'
import { Spin } from '@/components/ui'
import type { MonacoJsonEditorProps } from './MonacoJsonEditorInner'

/**
 * 通用 Monaco JSON / 代码编辑器 —— **懒加载包装层**（F043）。
 *
 * 背景：此前 `MonacoJsonEditor` 直接静态 import `monaco-editor` 及其 4 个 worker
 * 与 TS 贡献模块，经 9 个页面传导进首屏 chunk —— 实测 `dist/assets/index-*.js`
 * 达 6.5MB。项目其余重量依赖（pdf / docx / xlsx / ag-grid / jszip / video.js /
 * wavesurfer / mermaid / echarts）**全部已动态 import**，Monaco 是唯一漏网。
 *
 * 做法：实现体拆到 `MonacoJsonEditorInner.tsx`，本文件用 `React.lazy` 异步加载。
 * 由于 `loader.config` / `?worker` / TS 贡献的静态导入都在 Inner 的**模块顶层**，
 * 它们只在真正打开编辑器时才求值 —— 这是把 monaco 移出首屏的关键。
 *
 * 同时在 `vite.config.ts` 配 `manualChunks: { monaco: [...] }`，让 monaco 及其
 * worker 独立成 chunk 而非被并进按需块（否则体积虽延后但仍与业务代码同 chunk 下载）。
 *
 * 类型走 `import type` —— 类型擦除，不引入运行时依赖。
 */
const MonacoJsonEditorInner = lazy(() =>
  import('./MonacoJsonEditorInner').then((m) => ({ default: m.MonacoJsonEditor })),
)

/** 加载中的占位：保持与编辑器一致的高度，避免弹窗内容跳动。 */
function EditorLoading({ height }: { height?: number | string }) {
  const h = typeof height === 'number' ? `${height}px` : (height ?? '320px')
  return (
    <div
      style={{
        height: h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 120,
      }}
    >
      <Spin wrapperClassName="mcphub-monaco__spin" />
    </div>
  )
}

export function MonacoJsonEditor(props: MonacoJsonEditorProps) {
  return (
    <Suspense fallback={<EditorLoading height={props.height} />}>
      <MonacoJsonEditorInner {...props} />
    </Suspense>
  )
}

export type { MonacoJsonEditorProps } from './MonacoJsonEditorInner'
