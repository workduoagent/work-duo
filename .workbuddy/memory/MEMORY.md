# work-duo 长期约定（单一事实源 · 校准 2026-10-04）

> 逐日细节留 `2026-*.md`。**🔴 红线：`.wd_mem/**`、`.workspace/.memory/**` 与 `.workbuddy/memory/**` 绝不进用户可见 UI / present_files。**

## 🔴 目录重组（2026-10-02 完成，60+ 文件引用已批量更新）
`docs/` 资产已迁入 `.workspace/`（初名 `.workbranchs`，当日按用户定名更正）。**`docs/` 下现在只剩走查报告，记忆里旧 `docs/xxx` 路径一律失效。**
- `.workspace/.sys_tool/` = 工具与 skill（原 `docs/skills/`）：`workduo-mcp/`（MCP skill + scripts）、`single-agent-capability/`、`single-agent-capability-v2/`
- `.workspace/.eval-results/` = 测评证据（原 `docs/eval-results/`）
- `.workspace/.fix/` = 修复单（**完成即删**，状态固化在各单 ✅ 横幅与 commit）
- `.workspace/.norms/` = 前后端开发规范 + `git-commit.md`
- `.workspace/.memory/` = **项目自己的记忆入口**（`CURRENT.md` 跨工具接续 + 按日文件；`CURRENT.md` 与本文件同源，跨工具时读它）
- `.workspace/.agents/软件开发类/` = Agent 市场资产（导入脚本 `.agents/软件开发类/scripts/import_workduo.py`，幂等可重跑，真实 id 落 `generated-agent-setup-ids.json`）
- `.workspace/.future/` = 后续规划（原生工具/小分队/服务器托管）
- `.zcode/skills/` 与 `.workspace/.sys_tool/` 内容重复，改动需两侧同步
- **MCP skill 单一事实源 = `.workspace/.sys_tool/workduo-mcp/`**，客户端 `~/.workbuddy` 用 `scripts/sync_client.mjs` 逐字节 MD5 同步（SYNC_OK）

## 技术栈 / 构建铁律
- React19+TS+Vite+Tauri2；antd v5 经 `@/components/ui` 封装禁裸用；Sass 只 `var(--color-*)`；HashRouter；执行图=@xyflow/react v12。**只跑 `node node_modules/typescript/bin/tsc --noEmit`**，禁 vite build。前端铁律：hover 禁位移缩放；表单 autoComplete=off；useNotify 禁静态 message；HITL 决策在 DecisionCenter；fixed 弹层 createPortal。
- **🔴 Rust 改动必须重启 App 才生效**；改完 *.rs 的验证排在重启后。
- 依赖：AI 只写 package.json 不装；重型前端库动态 import()+shims.d.ts。
- SQLite workduo.db；TS 访问层 src/core/mapper/*（禁组件直写 SQL）；DDL 单一事实源 src/assets/sql/{init,updater}.sql，**DDL 变更必查 mapper 三要素**。**Agent 表=`agent_info`**（llm_id 外键），Rust 只 SELECT，写入=前端 agent-mapper.ts；MCP `agent_ui_*` 可自助建 Agent（无人值守须 isActive/autoToolExecMode/allowSandbox=true+planAutoApproveMode='never'+memoryMode）。
- cargo 沙箱自验：`source ~/.workbuddy/msvc-env.sh && cargo test/check`（**用默认 `target/`**）。**`target-sb` 已于 2026-10-07 删除**——内含不兼容的旧依赖缓存（`schemars` E0107 泛型缺失），冷编必失败；记忆里「target-sb 可用于沙箱自验」的旧记载已作废。默认 `target/` 增量 check 约 10 秒~5 分钟。**若 `tauri dev` 正在编译，并发跑 cargo 会报 `failed to open .cargo-build-lock / 拒绝访问 os error 5`** —— 等残留 cargo/rustc 进程结束再跑，或直接让 dev 侧编完。
- **Python 运行时镜像源（2026-10-01）**：`.mambarc` **禁止写死单一镜像**——清华 TUNA anaconda 已对 micromamba UA 返 403，中科大可用、官方源兜底，阿里/腾讯该路径 404 下线。`mamba_manager.rs` 现为「探活选源 + 失败换源重试一次」，逃生阀 `WD_MAMBA_MIRROR=ustc|tuna|official`。

## 内建 MCP（77 工具，2026-09-24）
- 127.0.0.1:18755/mcp（Streamable HTTP）：引擎+发现+UI 意图共 **77**。**每模块必有 *_list**；UI 回包 {ok,data} 信封；agent_get_run_trace 外层 {"trace":{…}} 须先剥；#8 per-run（get 必传 run_id）。前端桥 mcpBridge.ts；连接器 ~/.workbuddy/mcp.json→workduo-mcp(type:http)。
- **F001 信任协议（2026-10-04）**：`Authorization: Bearer <device_token>` 命中已配对设备放行（**服务端只存 SHA-256 哈希**）；无凭证时带 `Origin`（浏览器）一律拒 → 回环+`mcp_local_trust` 放行 → 其余 401；**带凭证但不匹配直接拒不回退本机信任**。`/pair` 端点 2 分钟窗口 + 5 次上限，设置页发起。监听 `mcp_bind_addr` 默认 `0.0.0.0`（内网互通），设 `127.0.0.1` 回环。`is_loopback` 取 `stream.peer_addr()` 不可伪造。
- **F002 路径边界范式（可复用）**：`fs_helper::ensure_script_path_in_roots` = `fs::canonicalize` + **组件级 `Path::starts_with`**（禁字符串前缀比对——`base` 会放行 `base_secret`）。允许根 = appData + resource + `app_config` 四键（workspace/skill/knowledge_base/vector_path，**迁移后多为任意绝对自定义路径如 `E:\MySkills`**，故不能用静态 scope 覆盖）。前端 plugin-fs 另需 `grant_fs_scope` 动态 ACL。
- **F004 DAG 双层断裂教训（2026-10-04）**：`graph.rs` 依赖门控曾两处同源断裂——① 字段名读写不一致（`dependsOn` vs `depends_on`）；② **id 命名空间错配（deps 存 planner 层 task_id「t1」，却直接查内部节点 id 表「n_…」恒 miss）**。凡「按 id 查状态」必先确认两侧 id 同一命名空间。修后 5 个回归测试覆盖依赖门控/环检测/前向引用/skip。


## 反复踩坑铁律（必背）
- Rust 截断 chars()；多行注入 Edit 逐点禁批替换；风险分级必配误伤回归；消费端追到 JSX props；定时器 cleanup 两步；熔断必过客观校验；**机制正确≠结果正确，验收核对业务产物**；日志 clip 禁入用户正文。
- 🔴 **评审「权限范围宽」前先验证它是否等于产品能力本身**（2026-10-04 用户纠正）。`fs:allow-read-file: **` 是**刻意设计**——Tauri 2 靠权限 scope 授权，不设通配就无法让 Agent 在用户选定目录工作（导出/工程目录/四数据目录均为任意绝对路径）。**把能力直接当漏洞是误判**；真正该修的是边界不一致（plugin-fs 绕过 Rust PathGuard、host 路径字符串比对）。**CSP 与 fs scope 是两件事**，前者与权限无关、该收。
- 🔴 **多路并行走查的结论必须抽样人工复核**（2026-10-04）：5 路 agent 同时跑，误报率不低（本次「门禁脚本未入库」为误报，实际 117 文件已入库）。凡标「致命/严重」的必须回读代码确认。
- **Glob 坑**：绝对路径当 pattern 假阴性，须 path+相对 pattern。get_run_logs：since_ts 本地空格串；跨天只读当天文件；event 洪流 limit:8000。bash 缺 head/cp/ls 走 node 替代。**agent 沙箱禁 node 派生进程**（EBUSY）——判分类「dump→外层 bash→merge」三段式。
- **日志滚动必按本地日期**：`logging.rs::LocalDailyWriter`（自实现 Write，写入前按 `chrono::Local` 校验切文件）。**禁改回 `tracing_appender::Rotation::DAILY`——它按 UTC 命名，与本地时间戳/读取侧错位 8h，导致每日本地 00:00~08:00 日志读不到**（2026-09-24 F-5 实测暴露并修复）。

## L2 生态测评（2026-09-23 全线闭环 18 commit；2026-09-24 收口：capability 39 用例满贯 25/25+SK/PL 14/14、工具轮基线 8→16、题库 13→19、D' 成本/回滚/限流 agent_snapshot_*、A' release 门禁运营化）
- 证据 `.workspace/.eval-results/2026-09-23/`；驱动 `l2_eval_harness.mjs`（CLI：run/inject/judge-dump/judge-merge/score）。
- **改进报告全清**：P0-1 预算 1800s+软窗口；P0-2 失败写 reply+文件表；P1-2 取消三态+no_pending；P1-1 xlsx/png 模板+产物契约；P2 五项（expectedArtifacts/HTTP 重试+错误分类/进度工具/skill_upsert 冲突/并行=多 Agent）。
- **回归与方法论**：12 个原失败用例 12/12 done、产物 100%；**「堆中间品不交最终件」收尾清单无效，改落盘时机才有效**（骨架先行+增量回写）。
- **Batch C（SWE-bench-lite 雏形）**：C1 seeds/ 种子包体系（manifest：tier/targetDir/testCmd/prompt/artifacts），7 包三级；C2 客观判分（venv pytest，resolved=全绿）；C3 首张评分卡 **resolved 6/6=100%**。C-H1 挖出引擎真根因：**熔断强制总结「暂定完成」吞掉修复型重试**（有文件写入→转失败回灌）+ 工具轮分级（基线 8/修复+8，WD_SUBTASK_MAX_ITERATIONS）。
- **2026-09-24 收口**：capability 全量 39 用例 100%（D3-1 intent 扩展名修复重启验证）；工具轮基线 8→16 转正（十六轮对照）；题库 13→19 包（双语言 bun/pytest 判分）；D' 成本/回滚/限流三件套（agent_snapshot_list/rollback 新工具 75→77；WD_LLM_RPM 限流）；A' release 门禁运营化（release_gate.mjs + `npm run release:gate`，基线 v20260924）；沙箱安全双层定型（网络默认关 + 文件系统有界 + 审计日志回显）；MCP 工具 72→77，SKILL.md 同步 + 客户端 sync_client.mjs 逐字节对齐。

- chat 模型：DeepSeek-V4.1-Flash（主力）/GLM-5.3-Flash/MiniMax-M3；gpt-5.6-luna 嫌疑不用。

## 战略 / 长期约定
- **筑基战略（用户定调）**：先打牢单 Agent（可控/可观测/可兜底），多 Agent（小分队）推迟验收；对标只用共同地基不追 SWE-bench。
- **✅ 小分队已解禁（2026-09-27 用户亲自点名启动）**：按 `.workspace/.future/小分队/小分队完整设计方案-20260925.md`（v1.4）实施。**✅ Phase S0–S3 全部收官（2026-09-30）**：S0 硬化/S1 交接并行/S2 门禁交付/S3 群聊2.0+角色包+模板+chat_then_execute+生命周期+MCP 工具面（98）+像素运行态，最后一项=squad_eval_harness（17 用例回归+release gate 第②b 步+`npm run squad:eval/squad:gate`；夹具=正式生态 4 套编队，临时改配置自动还原）。其后仅 §18 增值池。**✅ 当前阶段定调（2026-09-29 用户明确）：小分队功能开发全部完结，进入「小修小改做兼容」阶段**——不再开新功能线，只做兼容修补与体验微调；前端 UI 已九轮迭代至工作台 v3（像素舞台+气泡渲染，设计稿 `.workspace/.future/小分队/UI设计稿/`）。**squad harness 机制铁律**：checkpoint 挂起不改 status（观测=最新轮 kind='checkpoint'）；成员 run 裁剪 ask_user_choice（无人值守死锁）；board_json.tasks 键=t1/t2 非 title；交接箱=下游成员区 inbox/{task_id}/；squad 记忆专属表 agent_squad_memory；agent_run_trace 仅归档落盘（并行断言用 rounds handoff 轮同窗）；mcp_server fetch_rows 返回 {rows} 包装且 column_value 对表达式列（COUNT）按值试取；MCP 工具对 error JSON 会 throw（驱动一律 soft 包装）。
- **Harness=L2 边界防御**：真机实测；缺口回流 SKILL+MCP 层，**严禁绕过 MCP 写一次性脚本**。孤儿清扫已上线（agent_sweep_orphan_rounds）。
- **超时铁律**：判据用「无产出静默时长」非总耗时；慢≠死（模型间 15 倍差）；三层=调用级 180s+收尾 30s+run 级兜底；env 可调（WD_LLM_*/WD_RUN_MAX_SECS/WD_SUBTASK_*），改后重启。
- **Skill 同步铁律**：`.workspace/.sys_tool/<name>/` 单一事实源，客户端 ~/.workbuddy 同步一致（node cpdir+MD5 校验；注意 `.zcode/skills/` 有重复副本需两侧同改）；SKILL 禁第三方产品路径，资源只指 skill 内相对路径。
- **提交协作铁律（`.workspace/.norms/git-commit.md`）**：工具只执行本地 commit，**push 永远由用户本人执行**。
- **F053 Windows 坑**：Tauri `resource_dir()` 在 Windows 返回 `\\?\` verbatim 路径，Bun 1.4 无法加载带此前缀的 `--preload guard.js`（报 `Error occurred loading entry point: JSError`）。**凡把路径传给 Bun/Node 子进程，必须先归一化盘符与 UNC 前缀**（`bun_manager::base_dir` 已做）。
- **dev 环境事实**：`target/debug/work-duo.exe` 依赖 Vite `localhost:1420`；**本机 Vite 需双栈监听**（`npm run dev -- --host ::`），否则 Windows localhost 优先走 IPv6 时 WebView 空白/网络错误。

- **🚫 Java 沙箱：用户拍板永久放弃（2026-09-24），以后任何待办清单/规划/讨论中不再提及此任务。**沙箱多语言止步于 Python+JS/Bun。
- **沙箱守卫双层（2026-09-24 定型）**：默认离线（代理 env+sitecustomize 禁 socket）+ 文件系统有界（sitecustomize/guard.js patch 写删移，白名单=工作空间+%TEMP%）；运行用户脚本一律注入，install/环境管理走 Allow；逃生开关 WD_SANDBOX_NET=on / WD_SANDBOX_FS=off。**Bun/Node 侧无网络守卫（F010 待补）**——原生 fetch 不读 `HTTP_PROXY`，sandbox_audit 是 observe-only 不拦截。
- **汇报用语的硬要求（2026-09-28 用户明确）**：禁止用内部代号（S-CANCEL-1 / S0-4 这类编号）向用户汇报；直接说「做了什么功能、需要用户验证什么操作」。代号只允许存在于代码注释/文档/记忆文件内部。**注意：用户在修复单语境下自己会用 F001 这类编号提问，此时可沿用其编号作答。**
- **🔴 首页菜单已移除（2026-10-08 用户决定）**：顶栏「首页」菜单项删除，**但首页仍是默认落地页**（hash 为空 → index route → DashboardPage）。原因：用户尚未设计好首页内容，不愿在正式菜单暴露半成品入口。**加回时必须同步三处**（已写进 `TopBar.tsx` 注释）：① `MENUS` 的 `{key:'home', label:'首页', icon:Home, path:ROUTES.dashboard}` ② `lucide` import 补回 `Home,`（否则 ts6133 未使用）③ `routeToTopKey` 补回首页分支 —— **且必须返回 null 而非悬空 key**，否则 `measure()` 的 querySelector 找不到 `[data-nav-value="home"]` → 滑块静默不定位。`dashboard.test.ts` 已锁「菜单不含首页」。
- **🔴 测不出来的 UI 改动别硬测（2026-10-08 用户纠正）**：用户明确「我不用你测，你只要负责修改」。此前我在无浏览器环境下试图装 playwright 做点击实测，属绕路 —— **静态改动（菜单/路由/常量）用既有自动化验证即可**（tsc + vitest + eslint 足够覆盖），真机交互交用户点。**不要为验证而引入新依赖或起浏览器。**
- **🔴 首页改名「工作台」，设计稿已定（2026-10-08）**：用户判断「首页只是入口页叫首页不准确，工作台才是每天驻留的那一屏」。设计稿 `.workspace/.future/工作台/工作台设计稿.html`（commit `a3ef186`）。布局：左列 活跃热力图→进行中的任务（拉高填空白）｜右列 工作日历→小纸条（幻灯片堆叠式）｜通栏 最近活动｜右下角 悬浮拨号盘（老式电话旋转+回弹）。**指标已实测真实数据**（会话 304、Token 13.17M、轮次 399、小分队 4/智能体 10），后续接代码无需重做数据层。
- **🔴 两条 HTML/CSS 铁律（2026-10-08 两次返工换来）**：① **批量正则删 CSS 必须带 `^` 行首锚点** —— 漏了锚点会跨行匹配到 JS 绑定，**整块 `<script>` 被误删**且当时无 git 备份，只能重写。改 HTML 前先入 git 或备份。② **改 HTML 稿前必查 div 开闭平衡 + script/style 配对 + `</body></html>`** —— 浏览器容错，肉眼看不出，但中途补了两次 `</div>` 才平衡（141/141）。③ **设计稿不要用 v1/v2/v3 分文件迭代**（用户明确「就在这一个文件里改」）—— 多版本会在备份丢失时无法回退。
- **🔴「让 A 卡填 B 卡的空间」必须先确认同列（2026-10-08）**：任务卡拉高填热力图下方的空白，第一版只加 `height:100%` 完全没生效 —— 因为两者**不在同一列**。正确做法是引入 `.col-stack` 让每列纵向成栈，下方卡片 flex 吃掉上方留白。
- **工程基建现状（2026-10-07 实测校准）**：Rust **268** 个 `#[test]`；前端 **205 项 / 27 文件 Vitest 全绿**（`vitest.config.ts` happy-dom + `eslint.config.js` 平面配置，scripts `test`/`lint`）；**ESLint 0 error / 59 warning**（exhaustive-deps + shims 第三方 any，属可接受债）；`tsc --noEmit` 0 error；首屏 1.08MB（Monaco 懒加载）。`squads-workspace/index.tsx` 已 2670→2268 行（F038 一阶段），但 **`SquadEditorModal` 仍内嵌其中 1170 行 / 10 个 useState 未拆**；SquadDetailPage 1402 行。表单 `Field` 已具error/hint 能力（仅 squads 试点）。
- **🔴 走查 47 项的真实口径（2026-10-07 逐节回读代码校准）**：**43 项闭环，3 项未闭环 + 1 项误判已推翻**。**残项权威口径 = `.workspace/.fix/残项台账.md`（优先于 README 与报告各节）**：
  - **F038 第二阶段**（唯一真技术债）：`SquadEditorModal` 未拆，仍内嵌 `index.tsx` 531-1700 行 = **1170 行 / 10 个 useState**；4 个 Pane 与 `useSquadEditor` 从未创建。拆分前须先定状态归属，且必须真机验布局。
  - **F041 尾项**：表单就地校验仅 squads 编辑器一处试点。能力已就位，随各表单下次改动顺带迁移。
  - **F028 子项**：symlink TOCTOU 未做（Windows 无 `GetFinalPathNameByHandleW`）。**需用户决策**是否可接受该窗口。
  - **F024 ✅ 实际已完成**（2026-10-07 复核推翻此前「10 处未接线」的判断）：那10 处全部已在调用 `lsList`/`lsSave`，每处函数体仅 1 行；**是必要的类型标注 + storage key 封装，不该拆**（拆了 key 会散落到业务代码）。全项目仅 `config-mapper.ts:73/77` 直调 localStorage，属正确保留（存 `Record<string,string>` 字典非数组）。
  - **刻意保留 ≠ 缺口**：F050 不引入虚拟化库、F051/F052/F046 存量渐进迁移。
- **🔴 判定残项必须回读函数体，不能只数定义处（2026-10-07 铁律级误判）**：我曾 grep 到 `function lsRead` 有 10 处就下结论「未接线、值得收敛」，报告写「主动放弃」我就信了—— 实际打开一看**全部已接共享实现**。**报告/文档对「已做/未做」的陈述本身也可能是错的**（本项目已多次出现：各节横幅写「部分完成」而汇总处宣称全清）。核实一律以代码为准。
- **🔴 真机 UIA 回归从未跑过（2026-10-07 最大遗留缺口）**：连续多轮改动集中在 UI 层，单测+tsc+ESLint 测不出「组件拆完页面还歪不歪」。F049「停止」按钮与 F052 向导 1280px 断点**只做了静态与单测验证**。
  - **2026-10-07 第一轮（自动部分已过）**：Rust 当日 ERROR 0 条；MCP 经前端真实 handler 返回 10 智能体 + 5 KB + 2 MCP + 4 编队 + 6 技能全通（证 F005/F006/F011-F016/F020前端与引擎改造未断链）；**F049 进程树终止真机实测通过**（父子树 2/2 零残留）。DB schema v41 正常（exe 19:02 新构建，非旧包）。
  - **🔴 盲区（制度性缺口）**：`logBridge.fe.*` 只在业务代码**手动**调用，不捕获 console/未捕获异常；全项目**无 `window.onerror`/`unhandledrejection` 全局监听、无全局 ErrorBoundary**（仅 MultiFileViewer 局部有）⇒ **JS 崩溃白屏在日志里完全看不到**，只能人眼发现。这是建议加 UI 冒烟测试（挂载不白屏 + 无 console error）的直接理由。
  - **沙箱环境踩坑**（复现验证）：① 沙箱禁 node 派生进程（`execSync tasklist` → `spawnSync cmd.exe EBUSY`），必须走「node dump → 外层 bash 执行 → 读结果」三段式；② **Git Bash 会把 `/NH` `/T` `/F` `/PID` 当路径转换**（`MSYS_NO_PATHCONV=1` 无效），taskkill/tasklist 必须走 PowerShell 工具；③ PowerShell 工具**不回显 stdout**，需写结果文件再读，嵌套 cmd 串会被安全策略拦；④ `wmic` 已移除，查父子关系用 `Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"`。
- **前端基建三大铁律（2026-10-06 立）**：① `target: ES2020`——`new Error(msg, {cause})` 需 ES2022 lib，禁直接用，改为手工挂 `(err as Error & {cause?: unknown}).cause = e`（直接删会撞 ESLint `preserve-caught-error`）；② **Git Bash 会吃掉 `\\`→`\`**——源码/测试含反斜杠一律用 `String.fromCharCode(92)` 构造，且**文件是 CRLF**，`Edit` 用 LF 会匹配失败、改文件优先 `node` 按行替换；③ **写测试前必须先实测**——临时探针文件 + `console.log` 确认真实返回值，禁凭想象写断言。
- **测试基建三条补充铁律（2026-10-07 立）**：① **断言源码位置不能用 `indexOf(fnName())`**——会匹配到**注释里**提到的旧写法导致**假通过**，必须用行级正则 `^(const\s+\w+\s*=\s*|void\s+)?fn\(`；且源码是 CRLF，`trim()` 不去 `\r`，字符串 endsWith 判断会失效。**源码断言一律先 `codeOnly()` 剔除注释行**（`//`/`*`/`/*` 开头）——本会话已因此**两次假失败**（一次 indexOf 匹配注释、一次 toContain 匹配自己写的修复说明）。② **写完断言必须做变异测试**（用 node splice 注入缺陷，确认测试**准确失败**再还原）——第一版断言就因正则 `{` 被当量词而全程假通过。③ **Rust 进程级静态状态的测试必须有全局锁**：`RUNS`/`LAST_ID` 这类 `OnceLock<Mutex<_>>` + `#[test]` 多线程并行会互相污染（`unregister_prevents_leak` 本就有此隐患）；加 `static TEST_LOCK: Mutex<()>`，且**锁绝不能跨 `.await`**（同步 MutexGuard跨 await 必死锁），async 用例要分段加锁。
- **🔴 修 bug 前先确认「既定语义」，别把实现细节当产品语义去问用户（2026-10-07 用户两次纠正）**：① 呼吸灯——我列了「结束后定格/全部静止/静态亮相」三选项，用户直接纠正「是轮到谁发言，就谁呼吸灯才对」。语义只有一个（当前发言者），与运行状态无关。② 交付门禁——我先疑「后端没置状态」、再疑「status 轮询太慢」，用户两次纠正：**问题不是延迟，是舞台模式压根没有这个入口**。**教训：用户报「某功能没有/不显示」时，先确认「该功能在目标视图里到底存不存在」，而不是先论证「它为什么慢」。** 把状态机实现细节包装成产品决策去问 = 把简单事复杂化，会误导用户决策。
- **🔴「同源不同果」是本项目高频缺陷模式（2026-10-07 两次踩中）**：共享同一函数/数据源，但下游各有一层映射/守卫，导致一处正常一处失效。已遇：① `memberState` 被舞台与右栏共用，但右栏 `bub` 映射漏了 `speaking` → 落到idle 兜底；② 成员授权请求在 `StageView` 有、交付门禁只在 `TimelineView` 有。**凡修「某处不显示/不生效」，必须把所有消费该共享源的视图/组件逐个核对，别只改用户点的那一处。**
- **🔴 跨进程错误判定禁用文案字符串匹配（2026-10-07 血泪）**：前端 `error.includes('已取消')` 判取消，Tauri 包一层后形态不保证一致 ⇒ 真机上「取消」被判成「执行错误」弹红 toast。已改为机器可读前缀 `script_cancel::CANCELLED_PREFIX = "CANCELLED:"`（Rust 常量 + TS 常量逐字对齐，测试比对源码防漂移）。**凡跨 Rust/JS 边界传状态，必须有稳定机器可读标识，不能靠中文文案。**
- **🔴 不写无调用方的 pub 函数（2026-10-07 dead_code 教训）**：修 F049 时顺手写了 `is_cancelled_message()`「供 Rust 侧自测与前端语义对齐参考」，实际只有测试调用、生产无调用方 → `cargo check` 报 dead_code 告警。**根因是先写了"将来可能有用"的辅助函数再找用途**（本项目里 agent 运行路径 `run_python_in_sandbox` 其实**没有取消入口**，不存在第二个消费方，已 grep 确认）。正确顺序：**先确认消费方存在再写函数**；测试需要的判定直接在测试里用常量表达（`msg.contains(CANCELLED_PREFIX)`），不必在生产代码留API。**告警不是噪音，是它在告诉你设计超出了需求。**
