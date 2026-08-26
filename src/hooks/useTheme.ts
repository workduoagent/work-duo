import { useCallback } from 'react'
import { useAppDispatch, useAppSelector } from '@/core/store'
import {
  setTheme as setThemeAction,
  type ThemeMode,
} from '@/core/store/slices/themeSlice'

/**
 * 全局主题 hook。Redux themeSlice 为唯一真源；
 * <html> 的 .light/.dark 类与 antd 算法由 ThemeProvider 负责同步。
 */
export function useTheme() {
  const dispatch = useAppDispatch()
  const mode = useAppSelector((state) => state.theme.mode)

  const setTheme = useCallback(
    (next: ThemeMode) => {
      dispatch(setThemeAction(next))
    },
    [dispatch],
  )

  return { theme: mode, setTheme }
}
