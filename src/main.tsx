import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@/styles/root.scss'

import { store } from '@/core/store'
import { Provider } from 'react-redux'
import { ThemeProvider } from '@/core/contexts'
import { THEME_STORAGE_KEY } from '@/core/config/theme'
import { setTheme } from '@/core/store/slices/themeSlice'
import type { ThemeMode } from '@/core/store/slices/themeSlice'

// 启动即把持久化的主题模式注入 Redux（旧值键名保持 work-duo-theme 不变）。
try {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null
  if (saved === 'light' || saved === 'dark' || saved === 'system') {
    store.dispatch(setTheme(saved))
  }
} catch {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </Provider>
  </React.StrictMode>,
)
