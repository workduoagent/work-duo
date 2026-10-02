/**
 * 富代码块渲染器（对话气泡 / MD 查看器的多模态输出面）。
 *
 * 语言 → 组件映射（MarkdownRenderer 的 pre 拦截器按围栏语言分发）：
 *  - mermaid        → Mermaid SVG 图（流程 / 时序 / 甘特…）
 *  - echarts(+json) → ECharts 图表（option JSON，动态 import 按需分包）
 *
 * 流式约束：打字机逐字吐出时 fence 内容高频变化，这里统一 350ms 防抖——
 * 内容停稳后才真正调 mermaid.render / echarts 渲染，避免逐字符重渲染卡顿。
 * 失败兜底：语法错误不抛崩，降级为错误条 + 源码。
 * 主题：跟随 .dark 根类切换 mermaid / echarts 配色。
 */
import { useEffect, useRef, useState } from 'react'

/** 内容防抖：连续变化（打字机流式）期间保持旧值，停稳 delay 后才放行新值。 */
function useStableText(text: string, delay = 350): string {
  const [stable, setStable] = useState(text)
  useEffect(() => {
    const t = setTimeout(() => setStable(text), delay)
    return () => clearTimeout(t)
  }, [text, delay])
  return stable
}

function isDarkTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

// mermaid 动态引入（体积大，避免进主包）：首次用到时加载，模块级共享同一实例
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      // suppressErrorRendering：v10.5+ 默认会把「语法错误炸弹图」append 到 document.body
      //（页面底部一排炸弹的元凶）；关掉后错误只走我们自己的气泡内兜底。
      m.default.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        suppressErrorRendering: true,
      })
      return m.default
    })
  }
  return mermaidPromise
}

/** 单个 mermaid 代码块：内容停稳后调 mermaid.render 产出 SVG。 */
export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stable = useStableText(code)
  useEffect(() => {
    // 流式瞬间 fence 刚开、内容为空：直接跳过（空文本必然 Syntax error，还会触发错误图注入）
    if (!stable.trim()) return
    let active = true
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    ;(async () => {
      try {
        const mermaid = await loadMermaid()
        // initialize 幂等：每次渲染前按当前主题重设（暗色下出深色图）
        mermaid.initialize({
          startOnLoad: false,
          theme: isDarkTheme() ? 'dark' : 'default',
          securityLevel: 'loose',
          suppressErrorRendering: true,
        })
        const r = await mermaid.render(id, stable)
        if (active && ref.current) ref.current.innerHTML = r.svg
      } catch (e) {
        if (active && ref.current) {
          ref.current.innerHTML = `<pre class="md-mermaid__error">Mermaid 渲染失败：${
            e instanceof Error ? e.message : String(e)
          }</pre>`
        }
      }
    })()
    return () => {
      active = false
    }
  }, [stable])
  return <div className="md-mermaid" ref={ref} />
}

/** 单个 echarts 代码块：option JSON → ECharts 实例（动态 import，随容器尺寸自适应）。 */
export function EChartsBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const instRef = useRef<{ dispose(): void; resize(): void } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stable = useStableText(code)

  useEffect(() => {
    let alive = true
    let inst: { dispose(): void; resize(): void } | null = null
    setError(null)
    ;(async () => {
      let option: unknown
      try {
        option = JSON.parse(stable)
      } catch (e) {
        if (alive) setError(`option 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
        return
      }
      try {
        const echarts = await import('echarts')
        if (!alive || !ref.current) return
        const ec = echarts.init(ref.current, isDarkTheme() ? 'dark' : undefined)
        ec.setOption(option as never)
        inst = ec
        instRef.current = ec
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
      inst?.dispose()
      if (instRef.current === inst) instRef.current = null
    }
  }, [stable])

  // 容器尺寸变化（右栏拖宽 / 窗口缩放）时重算布局
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => instRef.current?.resize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (error) {
    return (
      <div className="md-echarts md-echarts--error">
        <pre className="md-echarts__error">ECharts 渲染失败：{error}</pre>
        <pre className="md-echarts__src">{code}</pre>
      </div>
    )
  }
  return <div className="md-echarts" ref={ref} />
}
