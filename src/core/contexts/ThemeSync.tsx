import { useEffect } from 'react'
import { useTheme as useAppicaTheme } from '@appica/ui-react/hooks/use-theme'
import { useAppDispatch } from '@/core/store'
import { setTheme, type ThemeMode } from '@/core/store/slices/themeSlice'

// Keep Redux as the single source of truth: mirror Appica 's resolved theme
// (which owns persistence + the <html> class) back into the store on change.
export function ThemeSync() {
  const dispatch = useAppDispatch()
  const { theme } = useAppicaTheme()

  useEffect(() => {
    if (theme) dispatch(setTheme(theme as ThemeMode))
  }, [theme, dispatch])

  return null
}
