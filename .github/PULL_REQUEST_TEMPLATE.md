<!--
感谢提交 PR！请先阅读 CONTRIBUTING.md 与 docs/ARCHITECTURE.md。
标题遵循仓库既有风格：<type>(<scope>): <中文主题>
例如：
  feat(memory): 记忆宫殿支持按标签筛选
  fix(squad): 修复成员状态映射漏speaking 字段
  docs(readme): 补充 Linux 构建依赖说明
-->

## 变更类型

- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] 📝 文档更新
- [ ] ♻️ 重构（不改变行为）
- [ ] ⚡ 性能优化
- [ ] 🔧 构建 / 依赖 / CI
- [ ] 🧪 测试
- [ ] 其他：

## 关联 Issue

<!-- 例如：Closes #12, Fixes #34 -->

## 变更说明

<!-- 说明你做了什么，为什么这么做 -->

## 如何测试

<!-- 复现或验证这次改动效果的步骤 -->

1.
2.

## 截图 / 录屏（UI 改动必填）

<!-- 拖拽图片到这里 -->

## 检查清单

- [ ] 我已经阅读并遵守 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- [ ] 我的改动落在正确的模块内，未破坏分层依赖（表现层 → 桥接层 → 引擎层 → 能力层）
- [ ] 前端改动：Ant Design 经 `src/components/ui` 封装、样式只用 `var(--color-*)` 令牌、无静态 `import { message }`、表单设 `autoComplete="off"`
- [ ] 后端改动：Rust 截断用 `chars()`、跨进程状态用机器可读标识（如 `CANCELLED:` 前缀）
- [ ] 改动文件通过 `pnpm typecheck`（EXIT 0）
- [ ] 前端改动已跑 `pnpm test` 与 `pnpm lint`
- [ ] Rust 改动已跑 `cargo check --manifest-path src-tauri/Cargo.toml` 与 `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] 未手动跑 `vite build` / `pnpm build`（会污染 `dist`，应由 `pnpm tauri build` 触发）
- [ ] 变更表结构时：DDL 已同步 `init.sql` + `updater.sql`，并已 grep 所有 `INSERT INTO <表>` 核对三要素（列清单 / `VALUES` 占位符 / 参数数组）
- [ ] 我更新了相关文档
- [ ] 我的改动不包含任何敏感信息（密钥、Token、内网地址、真实用户名）
- [ ] 新增依赖只登记进 `package.json` / `Cargo.toml`，未提交 `node_modules/` 或 `target/`

## 其他说明

<!-- 任何需要 reviewer 注意的地方 -->
