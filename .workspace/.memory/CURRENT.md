# CURRENT —— 当前进行中（跨工具接续入口）

> 每次收工刷新本文件；详细脉络见 `.memory/` 按日文件。

## 当前状态（2026-10-04）

- **走查摘要 P0 已全部完成 ✅**：F001（MCP 信任协议）/ F002（脚本路径边界）/ F003（CSP + fs 收敛）/ F004（DAG 双层断裂）/ F005（kbFs 越界）/ F006（MCP 桥载荷校验）/ F007（事件归属）。完成状态与 commit 固化在 `.workspace/.fix/20261002-走查报告原文.md` 的各节 ✅ 横幅；完成 F 单按约定已从 `.fix/` 删除。
- **F053 已完成 ✅**（`376fd15`）：Node 沙箱页运行工作空间 `.js` 报 `Error occurred loading entry point: JSError`，根因是 Windows `resource_dir()` 返回 `\\?\` verbatim 路径，Bun 1.4 无法加载带此前缀的 `--preload guard.js`。`bun_manager::base_dir` 已统一归一化盘符/UNC 前缀；真实 UIA 测试输出 `hello node from workspace`，桌面脚本仍被 F002 越界边界拒绝。
- **F003 fs 手选路径闭环已凭据化收口 ✅**（2026-10-04）：审查指出渲染层可经 plugin-sql 直改 app_config/agent_project/agent_squad，「直信 SQLite 路径恢复 scope」构成提权链。现架构：dialog 手选自动 allow（目录选择加 `recursive: true`）；跨重启目录由 `record_fs_scope_grant` 签发 HMAC-SHA256 凭据（密钥在 keyring）落 `fs_scope_grant` 表（schema v40），启动 `restore_fs_scope` 验签 + 来源字段二次比对后恢复；签发门禁 = 运行时 fs scope（dialog 授予）或 $HOME 静态可信根，越权路径一律拒。CDP 真实渲染层 E2E 三用例全过（越权拒/非法 key 拒/签发→重启恢复），217 Rust 测试 + tsc 通过。
- F003 的 CSP 严格策略与 fs 读权限收敛已在运行实例回归：MCP KB/Skill/插件全过，知识库/智能体/编辑向导 UIA 截图正常。

- **F008 已完成 ✅**（2026-10-05）：host 本地路径闸门 `local_guard` 前缀绕过 + `..` 穿越——重构为 `fs_helper::ensure_path_in_roots` 共享边界原语（折叠 + 最深已存在祖先 canonicalize + 组件级比对 + Windows 大小写折叠），sftp 拿规范化路径双保险；无边界场景从放行收紧为拒绝；F002 迁移共用原语；224 Rust 测试通过。远端闸门 `policy::check_path` 复核正确未动。

## 下一步候选

1. **F010**：Bun/Node 沙箱网络隔离（P1 安全项；F053 已修复 preload 路径基础问题后，适合继续补 fetch/WebSocket/net/tls/dgram 拦截，对齐 Python 侧 socket monkey-patch）。
2. **F009**：`native__execute_command` 走 `cmd /C` 整串透传（P1；宿主模式一次诱导即可执行任意命令，改受限执行器或前置过滤）。
3. **F018 / F038 / F039**：前端测试基建、Squad 巨型组件拆分、运行控制台重复逻辑（结构性工程债）。

## 环境事实（跨设备必读）

- WorkDuo MCP：`127.0.0.1:18755/mcp`；驱动脚本：`.workspace/.sys_tool/workduo-mcp/scripts/`。
- `target/debug/work-duo.exe` 是 dev 构建，依赖 Vite `localhost:1420`；本机当前 Vite 需双栈监听（`npm run dev -- --host ::`），否则 Windows localhost 优先走 IPv6 时可能出现 WebView 空白/网络错误。
- 用户约定：工具只执行本地 commit，**push 永远由用户本人执行**。
