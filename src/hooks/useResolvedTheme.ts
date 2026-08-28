import { useEffect, useState } from 'react'
import { useAppSelector } from '@/core/store'
import type { ThemeMode } from '@/core/store/slices/themeSlice'

/**
 * 解析后的明暗主题（'light' | 'dark'）。
 * 与 ThemeProvider 同源：以 Redux themeSlice.mode 为真源，
 * mode==='system' 时跟随系统 prefers-color-scheme。
 * 用于把解析结果传给需要显式明暗值的第三方组件
 * （如 JSON 编辑器），使其随应用主题切换。
 * 注：@visual-json/react 这类靠 CSS 变量换肤的组件，直接映射项目
 * --color-* 令牌即可自动跟随，无需在组件内调用本 hook。
 */
function resolve(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode === 'dark' ? 'dark' : 'light'
}

export function useResolvedTheme(): 'light' | 'dark' {
  const mode = useAppSelector((s) => s.theme.mode)
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return resolve(mode, systemDark)
}
