import { useEffect, useMemo, useState } from 'react'
import { App, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useAppSelector } from '@/core/store'
import { THEME_STORAGE_KEY } from '@/core/config/theme'
import type { ThemeMode, AccentTheme } from '@/core/store/slices/themeSlice'

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
  const accent = useAppSelector((s) => s.theme.accent)

  // 反映到 <html> 类，供 variables.scss 的 .light / .dark 令牌切换
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    root.classList.toggle('light', resolved === 'light')
  }, [resolved])

  // 反映色调到 <html> 的 .accent-* 类，供 variables.scss 重映射 --color-brand-*
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('accent-sky', 'accent-mint', 'accent-lilac', 'accent-minimal')
    root.classList.add(`accent-${accent}`)
  }, [accent])

  // 持久化到 localStorage（storageKey 与旧 Appica 保持一致，避免旧值失效）
  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  // 主品牌色 + 语义色随色调切换。
  // minimal = 原始主题（晴空蓝主色 + 原绿/红/琥珀语义），其余三档为 Logo 三色环配色。
  const ACCENT_COLORS: Record<
    AccentTheme,
    {
      primary: { light: string; dark: string }
      success: { light: string; dark: string }
      error: { light: string; dark: string }
      warning: { light: string; dark: string }
    }
  > = {
    minimal: {
      primary: { light: '#0284c7', dark: '#38bdf8' }, // 原始主色（品牌 600）
      success: { light: '#16a34a', dark: '#4ade80' }, // 原始绿
      error: { light: '#ef4444', dark: '#f87171' }, // 原始红
      warning: { light: '#d97706', dark: '#fbbf24' }, // 琥珀
    },
    sky: {
      primary: { light: '#0ea5e9', dark: '#38bdf8' },
      success: { light: '#34d399', dark: '#5cdfb5' },
      error: { light: '#f87171', dark: '#fca5a5' },
      warning: { light: '#d97706', dark: '#fbbf24' },
    },
    mint: {
      primary: { light: '#059669', dark: '#34d399' },
      success: { light: '#34d399', dark: '#5cdfb5' },
      error: { light: '#f87171', dark: '#fca5a5' },
      warning: { light: '#d97706', dark: '#fbbf24' },
    },
    lilac: {
      primary: { light: '#7c3aed', dark: '#a78bfa' },
      success: { light: '#34d399', dark: '#5cdfb5' },
      error: { light: '#f87171', dark: '#fca5a5' },
      warning: { light: '#d97706', dark: '#fbbf24' },
    },
  }

  const antdThemeConfig = useMemo(
    () => ({
      algorithm:
        resolved === 'dark'
          ? antdTheme.darkAlgorithm
          : antdTheme.defaultAlgorithm,
      token: {
        // 主品牌色跟随所选色调（accent）
        colorPrimary: ACCENT_COLORS[accent].primary[resolved],
        // 成功态：原始绿 / 三色环 Mint，依色调而定
        colorSuccess: ACCENT_COLORS[accent].success[resolved],
        // 危险态：原始红 / 柔和红
        colorError: ACCENT_COLORS[accent].error[resolved],
        // 警告：暖琥珀，避免与 Mint 混淆
        colorWarning: ACCENT_COLORS[accent].warning[resolved],
        // Info 与主品牌色保持一致
        colorInfo: ACCENT_COLORS[accent].primary[resolved],
        borderRadius: 8,
        fontFamily:
          'AppSans, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      },
    }),
    [resolved, accent],
  )

  return (
    <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
      {/* message.top=72：顶栏高 56px + 16px 间距，避免消息提示遮挡顶部菜单栏 */}
      <App component={false} message={{ top: 72 }}>
        {children}
      </App>
    </ConfigProvider>
  )
}
