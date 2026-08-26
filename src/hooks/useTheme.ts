import {useCallback} from 'react'
import {useTheme as useAppicaTheme} from '@appica/ui-react/hooks/use-theme'
import {useAppDispatch, useAppSelector} from '@/core/store'
import {setTheme as setThemeAction, type ThemeMode} from '@/core/store/slices/themeSlice'

/**
 * App-wide theme hook. Redux is the source of truth for app logic; Appica's
 * ThemeProvider owns the actual <html> class + persistence. This hook keeps
 * both in sync on every change.
 */
export function useTheme() {
    const dispatch = useAppDispatch()
    const mode = useAppSelector((state) => state.theme.mode)
    const {setTheme: setAppicaTheme} = useAppicaTheme()

    const setTheme = useCallback(
        (next: ThemeMode) => {
            dispatch(setThemeAction(next))
            setAppicaTheme(next)
        },
        [dispatch, setAppicaTheme],
    )

    return {theme: mode, setTheme}
}
