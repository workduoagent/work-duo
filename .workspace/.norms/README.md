# .norms —— 开发与协作规范

> 编码工具（AI / 人）在仓库内干活前必读本目录；规范与代码冲突时，**先改规范再改代码**（规范也要走提交）。

| 文件 | 范围 |
|---|---|
| [frontend.md](./frontend.md) | 前端开发规范（React 19 + TS + Vite + Tauri 插件面） |
| [backend.md](./backend.md) | 后端开发规范（Rust / Tauri2 引擎、DB 与命令契约） |
| [git-commit.md](./git-commit.md) | 提交协作规范（**编码工具只 commit、由用户本人 push**） |

## 通用总则（前后端共同）

1. **事实源优先**：工具可用性以注册表为准（前端 mapper / Rust ToolRegistry），禁止只靠 prompt「宣称能做」。
2. **注释只写 WHY**：约束、反直觉、workaround；禁止叙述型注释（`// 获取用户`）。
3. **契约先行**：接口/事件/命令变更先改契约文档与类型，再改实现；事件只增不改，破坏性变更升版本。
4. **依赖入清单**：只在 `package.json` / `Cargo.toml` 增依赖；大依赖需说明理由。
5. **密钥红线**：密钥不进代码、不进聊天记录、不进提交。
6. **完成定义**：对应检查命令 0 error（前端 `npm run typecheck`，Rust `cargo check`，涉测改动跑测试）。
7. **死代码即删**：确认无用就删，不留兼容空壳。
