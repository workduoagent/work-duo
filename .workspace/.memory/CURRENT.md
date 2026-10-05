# CURRENT —— 当前进行中（跨工具接续入口）

> 每次收工刷新本文件；详细脉络见 `.memory/` 按日文件。

## 当前状态（2026-10-04）

- **走查摘要 P0 已全部完成 ✅**：F001（MCP 信任协议）/ F002（脚本路径边界）/ F003（CSP + fs 收敛）/ F004（DAG 双层断裂）/ F005（kbFs 越界）/ F006（MCP 桥载荷校验）/ F007（事件归属）。完成状态与 commit 固化在 `.workspace/.fix/20261002-走查报告原文.md` 的各节 ✅ 横幅；完成 F 单按约定已从 `.fix/` 删除。
- **F053 已完成 ✅**（`376fd15`）：Node 沙箱页运行工作空间 `.js` 报 `Error occurred loading entry point: JSError`，根因是 Windows `resource_dir()` 返回 `\\?\` verbatim 路径，Bun 1.4 无法加载带此前缀的 `--preload guard.js`。`bun_manager::base_dir` 已统一归一化盘符/UNC 前缀；真实 UIA 测试输出 `hello node from workspace`，桌面脚本仍被 F002 越界边界拒绝。
- **F003 fs 手选路径闭环已凭据化收口 ✅**（2026-10-04）：审查指出渲染层可经 plugin-sql 直改 app_config/agent_project/agent_squad，「直信 SQLite 路径恢复 scope」构成提权链。现架构：dialog 手选自动 allow（目录选择加 `recursive: true`）；跨重启目录由 `record_fs_scope_grant` 签发 HMAC-SHA256 凭据（密钥在 keyring）落 `fs_scope_grant` 表（schema v40），启动 `restore_fs_scope` 验签 + 来源字段二次比对后恢复；签发门禁 = 运行时 fs scope（dialog 授予）或 $HOME 静态可信根，越权路径一律拒。CDP 真实渲染层 E2E 三用例全过（越权拒/非法 key 拒/签发→重启恢复），217 Rust 测试 + tsc 通过。
- F003 的 CSP 严格策略与 fs 读权限收敛已在运行实例回归：MCP KB/Skill/插件全过，知识库/智能体/编辑向导 UIA 截图正常。

- **F008 已完成 ✅**（2026-10-05）：host 本地路径闸门 `local_guard` 前缀绕过 + `..` 穿越——重构为 `fs_helper::ensure_path_in_roots` 共享边界原语（折叠 + 最深已存在祖先 canonicalize + 组件级比对 + Windows 大小写折叠），sftp 拿规范化路径双保险；无边界场景从放行收紧为拒绝；F002 迁移共用原语；224 Rust 测试通过。远端闸门 `policy::check_path` 复核正确未动。

- **F010 已完成 ✅**（2026-10-05）：Bun/Node 沙箱网络隔离——`SANDBOX_GUARD_JS` 增加 net 段（fetch/WebSocket/http(s)/net/tls/dgram/dns/Bun 原生 connect·listen·udpSocket·serve 全拦），注入条件改 fs/net 两段独立启用；真实 bun CLI E2E 封网 16 通道全拒 + 放行场景无误伤；226 Rust 测试通过。

- **F009 已完成 ✅**（2026-10-05）：`native__execute_command` 的 `cmd /C` 整串透传——`ensure_command_in_boundary` 前置护栏拦 `..` 路径段（git 区间语法不误伤）、盘符/UNC 绝对路径、段首嵌套 shell（python/node 项目运行时保留），审批卡原文兜底残留；230 Rust 测试通过。

- **F011 已完成 ✅**（2026-10-05）：squad 启动清扫误杀——schema v41 加 `agent_squad_session.owner_pid`（INSERT/Resume 接管写入），清扫按「无主（NULL/异 PID/本进程无协程登记）才收敛 + CAS 单条 UPDATE」重构，活跃会话绝不触碰；内存库单测 4 项，234 Rust 测试通过，运行时冒烟 v41 落库正常。

- **F012 已完成 ✅**（2026-10-05）：squad 状态机 CAS 化——报告处方两条落地（resume 仅 paused→running、finish 带终态否定守卫），并扫全 11 处状态写点统一守卫（awaiting_*/paused 写半终态守卫、批准回写等值守卫、done/failed 收尾终态否定守卫）；终态不可回退，僵尸 running 不再可能；内存库单测 3 项，237 Rust 测试通过。

## 下一步候选

1. **F013**：squad 路径缺失 run 级墙钟超时（commands.rs:1359 UI 入口 vs 单 Agent 有 timeout；对齐即可）。
2. **F014-F017**：squad 可靠性批次剩余（pipeline expect panic / 成员超时半行 JSON / board_json 读改写丢更新 / events.rs 锁）。
3. **F018**：前端测试基建（零测试 + 无 Lint，结构性债）。

## 环境事实（跨设备必读）

- WorkDuo MCP：`127.0.0.1:18755/mcp`；驱动脚本：`.workspace/.sys_tool/workduo-mcp/scripts/`。
- `target/debug/work-duo.exe` 是 dev 构建，依赖 Vite `localhost:1420`；本机当前 Vite 需双栈监听（`npm run dev -- --host ::`），否则 Windows localhost 优先走 IPv6 时可能出现 WebView 空白/网络错误。
- 用户约定：工具只执行本地 commit，**push 永远由用户本人执行**。
