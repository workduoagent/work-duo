# Rust / Tauri 客户端约定

## 能力与安全

| 项 | 约定 |
|---|---|
| 能力事实源 | ToolRegistry 注册决定可用工具，prompt 不能替代 |
| 路径 | PathGuard 工作区边界；越界拒绝 |
| 高危命令 | 审批门；白名单优先 |
| 沙箱语义 | Python/Bun 沙箱=环境隔离，**无 Rust 沙箱** |

## 架构纪律

1. 命令注册集中（`generate_handler!`），命名稳定。  
2. 事件只增不改；破坏性变更升版本。  
3. 消息序列不变量：每条 `tool_call.id` 必有结果；发送前 sanitize。  
4. 终态铁律：不挂死、不丢锁、不残留孤儿 run。  
5. 性能：避免在 IPC 热路径做大分配；长任务异步 + 可取消。

## 工具链

- 检查用宿主 `cargo`（`plugin-cargo-check` 或 `execute_command` 白名单）。
- 环境定位：`WD_CARGO_BIN` / `CARGO_HOME`。
- 禁止插件拼任意 shell；子命令白名单 + `shell=false`。

## 自检

```text
- [ ] cargo check / test 通过
- [ ] 命令与事件契约文档已更新
- [ ] 无新增高危无审批命令
- [ ] 取消/超时路径有效
```
