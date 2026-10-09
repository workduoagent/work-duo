# 贡献指南

感谢你考虑为 WorkDuo 贡献代码。

## 开始之前

请先阅读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 了解模块边界。**本项目是模块化的**：改动前先确认代码该落在哪个模块，以及是否会破坏依赖方向。

核心原则（改动时必须遵守）：

| 原则 | 说明 |
|---|---|
| **能力层是工具的唯一事实源** | 工具能否使用由注册集合决定，并同时驱动提示词分支。仅写在提示词里的约束会被模型绕过 |
| **单向依赖** | 表现层 → 桥接层 → 引擎层 → 能力层 / 资源层，反向禁止 |
| **Rust 只读业务表** | 业务写入统一走前端 `src/core/mapper/*`，避免双写通道 |
| **组件不直写 SQL** | 一律经 mapper 层 |
| **DDL 单一事实源** | 改表结构必须同步 `src/assets/sql/init.sql` 与 `updater.sql`，并检查 mapper 三要素（查询 / 写入 / 类型） |

## 环境准备

```bash
git clone https://github.com/workduoagent/work-duo.git
cd work-duo
pnpm install
pnpm tauri dev
```

平台依赖见 [README.md](README.md#环境要求)。

> **注意**：仓库含约 370 MB 预编译运行时，强烈建议浅克隆 `git clone --depth 1`。

## 开发流程

1. **先探索后修改** —— 改动前先读相关代码，列出关注点清单。探索阶段严格只读。
2. **小步快跑** —— 一个功能模块完成后立即验证，不堆积未验证的代码。
3. **写后自检** —— 见下节验证要求。
4. **确定性优先** —— 判定「已完成/未完成」必须以代码与客观产物为准，不能只信文档陈述。

## 提交前必须跑的检查

| 改动范围 | 检查 |
|---|---|
| 前端（`src/`） | `pnpm typecheck` && `pnpm test` && `pnpm lint` |
| Rust（`src-tauri/`） | `cargo check --manifest-path src-tauri/Cargo.toml` && `cargo test --manifest-path src-tauri/Cargo.toml` |
| 数据库 DDL | 必须同时更新 `init.sql` + `updater.sql`，并跑相关 mapper 测试 |
| 依赖变更 | 只改 `package.json` / `Cargo.toml`，**不要提交 `node_modules/` 或 `target/`** |

**Rust 改动必须重启应用才生效**。开发模式下若 `tauri dev` 正在编译，并发跑 cargo 会因构建锁冲突报错——等编译结束再跑。

## Commit 规范

对齐仓库既有历史：

```text
<type>(<scope>): <中文主题——一句话说清做了什么>

- 要点 1（改了什么、为什么）
- 要点 2
- 验证：过了哪些检查（tsc / cargo check / 单测 N 项 / 构建分包确认）
```

- `type`：`feat` / `fix` / `refactor` / `docs` / `test` / `chore`
- `scope`：模块短名，如 `chat-image`、`md-rich`、`squad-approval`、`memory`
- **正文必须写验证结论**（过了什么检查、有哪些硬证据，如单测数量）
- **一个语义一个提交**：大改动按功能拆成多个 commit

示例：

```text
feat(memory): 记忆宫殿支持按标签筛选

- MemoryPalace 卡片网格接入标签筛选，筛选态写入 URL query
- 后端 mapper 新增 listByTags，避免全量捞出后在应用层过滤
- 验证：tsc 0 error；mapper 单测 12 项全绿；真机点选确认筛选生效
```

## 代码风格

完整前端规范见 [`.workspace/.norms/frontend.md`](.workspace/.norms/frontend.md)（含目录职责、数据层、布局、检查流程），以下是高频红线摘要。

**前端**

- Ant Design **必须**经 `src/components/ui` 封装调用，禁止裸用
- 消息提示必须走 `useNotify()`，禁止静态 `import { message }`
- Sass **只用 `var(--color-*)` 设计令牌**，禁止 hex 与 px 字面量
- 表单控件设 `autoComplete="off"`
- hover 效果禁止位移或缩放
- Tauri 事件订阅统一走 `useTauriEvent`（避免重渲染重建监听导致泄漏）
- 页面根容器必须 `width: 100%`，禁止 `max-width` + `margin: 0 auto` 居中限制
- UI 文案禁止「中文（English）」混排（如 `唯一标识（identifier）`）

**Rust**

- 字符串截断注意 `chars()` 而非字节
- 多行代码注入时逐点编辑，禁止跨行批量正则替换
- 跨进程传递状态必须有稳定的机器可读标识（如 `CANCELLED:` 前缀），**不能靠中文文案匹配**
- 不写没有调用方的 `pub` 函数

## 安全相关改动

本项目对安全边界有明确设计，改动前请理解：

| 领域 | 位置 | 要点 |
|---|---|---|
| 路径边界 | `fs_helper.rs` | `canonicalize` + **组件级** `Path::starts_with`（禁字符串前缀比对） |
| 沙箱守卫 | Python `sitecustomize` / JS `guard.js` | 默认断网 + 文件系统有界 |
| 人机门禁 | `agent/hitl/` | 审批 / 计划门禁 / 方案选择 / 失败恢复 |
| 凭证 | `host/credential.rs` | AES-256-GCM，主密钥存 OS 凭据管理器 |
| SSRF 防御 | `native/mod.rs` + `net.rs` | DNS 解析层拦截内网与云元数据 |

**若发现安全缺陷，请勿公开披露细节**，先私下联系维护者。

## Issue 反馈

带上：操作系统、版本、复现步骤、相关日志（`logs/workduo.log.YYYY-MM-DD.log`）。日志已做脱敏，但提交前仍请自行确认无敏感信息。

## 许可

贡献即表示你同意你的贡献以 [MIT](LICENSE) 许可证发布。
