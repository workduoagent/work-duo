import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import path from "path";


const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
    plugins: [
        react(),
    ],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },

    // F043：Monaco 独立分块。
    // 此前 monaco 静态 import 进首屏 chunk（实测 index-*.js 达 6.5MB）。现其
    // 实现体已改为 React.lazy 异步加载，这里再显式分块，让 monaco 及其 worker
    // 独立成 chunk 而非被并入按需块——否则体积虽延后加载，但仍与业务代码同包。
    // 注意：函数式 worker（ts.worker 等）由 ?worker 后缀产出，Vite 会自动分块。
    build: {
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            output: {
                manualChunks: {
                    monaco: [
                        "monaco-editor",
                        "@monaco-editor/react",
                    ],
                },
            },
        },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
            }
            : undefined,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },
}));
