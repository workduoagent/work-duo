import type { ThemeMode } from '@/core/store/slices/themeSlice'

export const THEME_STORAGE_KEY = 'work-duo-theme'

export const THEME_OPTIONS: ReadonlyArray<{ label: string; value: ThemeMode }> = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
]
