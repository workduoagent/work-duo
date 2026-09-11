import { useEffect, useMemo, useState } from 'react'
import { App, ConfigProvider, theme as antdTheme } from 'antd'
import { useAppSelector } from '@/core/store'
import { THEME_STORAGE_KEY } from '@/core/config/theme'
import type { ThemeMode } from '@/core/store/slices/themeSlice'

function resolve(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

/**
 * 全局主题 Provider（取代 Appica ThemeProvider）。
 * - 以 Redux themeSlice.mode 为真源（持久化由 main.tsx 启动时注入）；
 * - 将解析后的 light/dark 反映到 <html> 的 .light / .dark 类，供自定义 scss 使用；
 * - 同步驱动 antd ConfigProvider 的算法（defaultAlgorithm / darkAlgorithm）。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
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

  const resolved = resolve(mode, systemDark)

  // 反映到 <html> 类，供 variables.scss 的 .light / .dark 令牌切换
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    root.classList.toggle('light', resolved === 'light')
  }, [resolved])

  // 持久化到 localStorage（storageKey 与旧 Appica 保持一致，避免旧值失效）
  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  const antdThemeConfig = useMemo(
    () => ({
      algorithm:
        resolved === 'dark'
          ? antdTheme.darkAlgorithm
          : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#3b6fff',
        borderRadius: 8,
        fontFamily:
          'AppSans, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      },
    }),
    [resolved],
  )

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {/* message.top=72：顶栏高 56px + 16px 间距，避免消息提示遮挡顶部菜单栏 */}
      <App component={false} message={{ top: 72 }}>
        {children}
      </App>
    </ConfigProvider>
  )
}
