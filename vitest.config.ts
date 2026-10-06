import { defineConfig } from 'vitest/config'
import path from 'path'

// F018：前端测试基建。与 vite.config.ts 保持同款 @ 别名；独立成文件避免
// Tauri 专属 server 配置（固定端口 1420）影响测试进程。
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // happy-dom：runtimeStore / mapper 依赖 localStorage 等浏览器全局
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
