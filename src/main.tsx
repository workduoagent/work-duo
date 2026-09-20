import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@/styles/root.scss'

import { store } from '@/core/store'
import { Provider } from 'react-redux'
import { ThemeProvider, InitProvider } from '@/core/contexts'
import { THEME_STORAGE_KEY } from '@/core/config/theme'
import { setTheme, setAccent } from '@/core/store/slices/themeSlice'
import type { ThemeMode } from '@/core/store/slices/themeSlice'
import { loadSettings } from '@/core/file/settings-file'
import { initScrollbarAutoHide } from '@/utils/scrollbar-autohide'
import { connectMcpBridge } from '@/core/mcpBridge'

// 启动即把持久化的主题模式注入 Redux（旧值键名保持 work-duo-theme 不变）。
try {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null
  if (saved === 'light' || saved === 'dark' || saved === 'system') {
    store.dispatch(setTheme(saved))
  }
} catch {
  /* ignore */
}

// 启动即把持久化的主品牌色调（app_config.accent）注入 Redux，使 ThemeProvider 启动即生效。
void loadSettings()
  .then((s) => store.dispatch(setAccent(s.accent)))
  .catch(() => {
    /* ignore */
  })

// 全局滚动条：滚动/悬浮时出现，失焦隐藏
initScrollbarAutoHide()

// 自测闭环：注册 mcp:intent 监听（WorkDuo 内建 MCP Server 驱动时生效，常驻零副作用）
void connectMcpBridge()

// 全局禁用右键菜单（桌面客户端不允许出现浏览器默认右键）
document.addEventListener('contextmenu', (e) => e.preventDefault())

// 生产环境禁用开发者工具快捷键（开发环境保留 Ctrl+Shift+I / F12）
if (import.meta.env.PROD) {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.shiftKey && e.key === 'I') || e.key === 'F12') {
      e.preventDefault()
    }
  })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemeProvider>
        <InitProvider>
          <App />
        </InitProvider>
      </ThemeProvider>
    </Provider>
  </React.StrictMode>,
)
