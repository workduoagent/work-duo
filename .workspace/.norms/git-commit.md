# 提交协作规范（编码工具 × 用户）

> 核心约定：**编码工具（AI）负责改代码、写 commit 信息、执行 commit；push 一律由用户本人完成。**

## 分工

| 动作 | 谁 | 说明 |
|---|---|---|
| 改代码 / 自检 | 编码工具 | typecheck / cargo check / 相关测试先过 |
| 写 commit 信息 | 编码工具 | 风格见下 |
| `git commit` | 编码工具 | **只提交本次工作相关文件**，用 pathspec/显式 add 圈定范围 |
| `git push` | **用户本人** | 工具永远不执行 push / force push / 远端写操作 |

## 提交纪律

1. **范围圈定**：只提交本次工作产生的文件；用户自己的遗留改动（README、依赖锁、暂存区的清理等）**不混入**。无法拆分的同文件混合改动，在 commit 正文注明。
2. **先自检后提交**：前端改动过 `npm run typecheck`（涉打包再过 `npm run build`）；Rust 改动过 `cargo check`；测试代码跑对应测试。
3. **不碰**：密钥/`.env`、巨型二进制、node_modules、他人未提交的工作区改动。
4. 新文件先 `git add` 再用 pathspec 提交；未跟踪文件不能直接进 `git commit -- <path>`。

## Commit 信息风格（对齐仓库既有历史）

```text
<type>(<scope>): <中文主题——一句话说清做了什么>

- 要点 1（改了什么、为什么）
- 要点 2
- 验证：过了哪些检查（tsc / cargo check / 单测 N 项 / 构建分包确认）
```

- `type`：`feat` / `fix` / `refactor` / `chore` / `docs` / `test`；`scope` 用模块短名（如 `chat-image`、`md-rich`、`squad-approval`、`model-ui`）。
- 主题行：中文、一句话、可独立看懂；`——` 后补充效果。
- 正文：无序列表写要点；**验证结论必须写**（过了什么检查、实测结果）；引用单测数量/构建产物等硬证据。
- 一个语义一个提交：大改动按功能拆多个 commit（参考 2026-10-02：`feat(chat-image)` 与 `feat(md-rich)` 分开）。

## 回滚与红线

- 禁止 `git reset --hard` 到远端未同步状态、禁止改写已推送历史（rebase 已 push 分支）。
- 提交后向用户报告：commit hash + 主题 + 「可以推送了」；遗留未提交改动逐项列明归属。
