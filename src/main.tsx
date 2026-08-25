import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@/styles/root.css'

import { store } from '@/core/store'
import { Provider } from 'react-redux'
import { ThemeProvider } from '@appica/ui-react/providers/theme-provider'
import { THEME_STORAGE_KEY } from '@/core/config/theme'
import { ThemeSync } from '@/core/contexts'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemeProvider
        defaultTheme="system"
        enableSystem
        storageKey={THEME_STORAGE_KEY}
        disableTransitionOnChange
      >
        <ThemeSync />
        <App />
      </ThemeProvider>
    </Provider>
  </React.StrictMode>,
)
