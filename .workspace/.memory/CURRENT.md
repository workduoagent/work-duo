# CURRENT —— 当前进行中（跨工具接续入口）

> 每次收工刷新本文件；详细脉络见 `.memory/` 按日文件。

## 当前状态（2026-10-07 刷新）

### 代码走查修复：47 项全部开工，43 项闭环，4 项残项

**P0 致命 7 项（F001-F007）全部完成 ✅** —— MCP 信任协议（配对制）/ 脚本路径边界 / CSP + fs 收敛（凭据化签发，schema v40）/ DAG 双层断裂（字段名 + taskId 命名空间）/ kbFs 越界 / MCP 桥载荷校验 / 事件归属。均在 2026-10-02~10-04 完成。

**P1 严重 11 项（F008-F018）全部完成 ✅**（2026-10-05~10-06）—— F008 路径边界原语 `fs_helper::ensure_path_in_roots` / F009 命令边界 / F010 沙箱封网 / F011-F016 squad 状态机 CAS 化、owner_pid 清扫、run 级墙钟、panic 安全网、成员图原子写、board 读改写门 / F017 events 裸锁 / F018 前端测试基建 + ESLint。

**UI 致命 2 项（F036/F037）完成 ✅** —— CSS 令牌半失效（补 42 项真实缺失）+ .dark 块 163 处旧深色字面量令牌化。

**P2 与工程债主体完成 ✅** —— F019-F035 全清（含 F028 经 Rust 实测**证伪为误判**并补 4 项回归）；F042/F047 首页 + 顶栏、F043 Monaco 懒加载（6.5MB→1.08MB）、F044 Field 自动关联、F045 列表 memo、F046 列表三态、F048 导入进度、F049 沙箱脚本可取消（进程组 kill）、F050 长列表、F051 Tag variant、F052 间距刻度。

**🔴 4 项已开工未闭环（2026-10-07 逐节回读代码确认，README 原写「全部完成」属表述失真，已修正）**：

| 项 | 残缺内容 | 证据 |
|---|---|---|
| **F038 第二阶段** | `SquadEditorModal` 未拆，仍内嵌 `index.tsx` 531-1700 行（1170 行 / 10 个 useState）；4 个 Pane 与 `useSquadEditor` 未创建 | `ls squads-workspace/` 无 Pane 文件 |
| **F024 尾项** | `lsRead`/`lsWrite` 10 处本地副本未收敛到 `localFallback.ts`（safeParse 与 bulkUpsert 已完成） | agent-project 6 / server 2 / squad 2 |
| **F041 尾项** | 表单就地校验仅 squads 编辑器一处试点，其余未迁移到 `Field.error` | `grep -rl error=` 仅 6 个业务文件 |
| **F028 子项** | symlink TOCTOU 未做（Windows 缺 `GetFinalPathNameByHandleW`） | `tools.rs:306-307` 注释自认 |

**刻意保留 ≠ 缺口**（理由写在报告原文各节）：F050 不引入虚拟化库（流式动态高度风险高）；F051/F052/F046 存量走渐进迁移。

### 基线状态（2026-10-07 实测）

- 前端测试 **161 项 / 24 文件全绿**；Rust `#[test]` **265 项**（F049 时 265）。
- `tsc --noEmit` **0 error**；ESLint **0 error / 59 warning**（exhaustive-deps + shims 第三方 any，属可接受债）。
- 工作区干净，HEAD = `827da67`，`.fix/` 无待修单文件。
- 首屏体积 1.08MB（Monaco 懒加载 + manualChunks）。

### 🔴 最大遗留缺口：真机 UIA 回归从未跑过

连续多轮改动集中在 UI 层（组件拆分 / 令牌体系 / Field error / Tag variant / 表单校验 / 删除确认 / 长列表 / 导入进度 / Monaco 懒加载），单测 + tsc + ESLint **测不出「组件拆完页面还歪不歪」**。优先验：
1. **squads-workspace**（改动最集中）
2. **agent-studio 向导 1280px 断点**（`minWidth: 1200`，笔记本最常见宽度）
3. **沙箱「停止」按钮**（F049 只验了信号链路 + 代码路径，**未验真实进程树中断**）
4. 首页 dashboard 统计与入口跳转
5. chat 页 Field 自动 id + 令牌明暗切换
6. 列表三态在断网/断库下是否显示「加载失败 + 重试」

## 环境事实（跨设备必读）

- WorkDuo MCP：`127.0.0.1:18755/mcp`；驱动脚本：`.workspace/.sys_tool/workduo-mcp/scripts/`。
- `target/debug/work-duo.exe` 是 dev 构建，依赖 Vite `localhost:1420`；本机当前 Vite 需双栈监听（`npm run dev -- --host ::`），否则 Windows localhost 优先走 IPv6 时可能出现 WebView 空白/网络错误。
- 用户约定：工具只执行本地 commit，**push 永远由用户本人执行**。
