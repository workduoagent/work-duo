# 后端开发规范（Rust / Tauri2 引擎 + 数据面）

## 模块分层（src-tauri/src/）

| 位置 | 职责 |
|---|---|
| `lib.rs` / `main.rs` | 入口、命令注册（集中、命名稳定）、setup 钩子 |
| `agent/engine/` | 调度核心：runtime / config_loader / intent / planner / pipeline / tools / llm / 压缩 |
| `agent/plugins/` | Skill / 本地插件 / MCP 适配与脚本沙箱 |
| `agent/hitl/` | 审批、计划门禁、恢复门禁（oneshot 通道零死锁） |
| `agent/knowledge/` | 记忆、`.wd_mem` 双轨、知识库检索、向量 |
| `agent/squad/` `host/` | 小分队编排、服务器托管 |
| `mcp_server.rs` | 内建 MCP Server（98 工具契约面，变更需同步 SKILL 文档） |

## 架构纪律（不变量）

1. **消息序列闭环**：每条 `tool_call.id` 必有结果；事件契约只增不改，破坏性变更升版本。
2. **终态铁律**：不挂死、不丢锁、不残留孤儿 run；长任务异步 + 可取消。
3. **能力事实源**：工具可用性由 ToolRegistry 注册决定，prompt 不能替代注册。
4. **安全边界**：路径走 PathGuard 工作区边界；高危命令过审批门、白名单优先；沙箱=Python/Bun 环境隔离，**无 Rust 沙箱**（cargo 检查走宿主工具链）。
5. **SQL 双轨**：表结构变更改 `src/assets/sql/init.sql`（前端 SqlService 启动执行）；存量库用幂等 ALTER，DDL 必须可重跑。
6. **命令与契约变更**必须同步前端类型与文档（`.workspace/.sys_tool/workduo-mcp/SKILL.md` 是 MCP 工具面的契约事实源）。
7. 日志用 `tracing`，带关键 id 可排障；前端关键链路经 `logBridge`（`log_frontend`）透传到同一份日志。

## 数据访问分工

- **SQL 全部在前端 mapper 层**（`src/core/mapper/*.ts` 经 tauri-plugin-sql）；Rust 侧直读 DB 仅限引擎内部（sqlx 只读/引擎表）。
- 新表：init.sql 建表 + mapper 封装 + 类型进 `src/types/database.d.ts`；禁止组件绕过 mapper。

## 工具链与自检

- 检查命令：`cargo check`（改动必过）；涉逻辑跑 `cargo test`。
- 环境定位：`WD_CARGO_BIN` / `CARGO_HOME`；禁止插件拼任意 shell（子命令白名单 + `shell=false`）。
- 自检清单：

```text
- [ ] cargo check / test 通过
- [ ] 命令与事件契约文档已同步
- [ ] 无新增高危无审批命令
- [ ] 取消/超时路径有效、无孤儿 run
- [ ] SQL 变更幂等可重跑
```
