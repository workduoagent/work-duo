import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type ThemeMode = 'light' | 'dark' | 'system'

/** 主品牌色调；仅影响 --color-brand-* 主品牌色，语义色 success/danger 不变。
 *  - sky / mint / lilac：对应新 Logo「深海蓝绿 Ocean」三色环；
 *  - minimal：简约中性色系（slate），为出厂默认。 */
export type AccentTheme = 'minimal' | 'sky' | 'mint' | 'lilac'

export interface ThemeState {
  mode: ThemeMode
  accent: AccentTheme
}

const initialState: ThemeState = { mode: 'system', accent: 'minimal' }

const themeSlice = createSlice({
  name: 'theme',
  initialState,
  reducers: {
    setTheme(state, action: PayloadAction<ThemeMode>) {
      state.mode = action.payload
    },
    setAccent(state, action: PayloadAction<AccentTheme>) {
      state.accent = action.payload
    },
  },
})

export const { setTheme, setAccent } = themeSlice.actions
export default themeSlice.reducer
