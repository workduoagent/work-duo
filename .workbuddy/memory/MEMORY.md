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
- cargo 沙箱自验：source ~/.workbuddy/msvc-env.sh && CARGO_TARGET_DIR=target-sb cargo test/check。**target-sb 冷编缺 protoc（lance-encoding 构建脚本）会失败**，本机自验改用默认 `target/` 增量 `cargo check`（约 5 分钟）；偶发 `invoked.timestamp 拒绝访问` 多因有残留 cargo 进程，重跑即可。
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
- **工程基建现状（2026-10-06）**：Rust 191 个 `#[test]`；**前端 29 个 Vitest（4 文件）已上线**（`vitest.config.ts` happy-dom + `eslint.config.js` 平面配置，scripts `test`/`lint`）；**ESLint error 已清零**（remaining 58 warning 以 exhaustive-deps + shims 第三方 any 为主，属可接受债）。squads-workspace/index.tsx 2716 行（SquadEditorModal 单组件 1404 行、memo 计数 0）；SquadDetailPage 与 index 运行控制台双份重复约 400 行；表单 `validateStatus` 全项目 0 命中（Field.tsx 缺 error prop）。走查报告见 `docs/代码走查评审报告-20261002.md`；**P0+F001~F017+F018 已全部完成**。
- **前端基建三大铁律（2026-10-06 立）**：① `target: ES2020`——`new Error(msg, {cause})` 需 ES2022 lib，禁直接用，改为手工挂 `(err as Error & {cause?: unknown}).cause = e`（直接删会撞 ESLint `preserve-caught-error`）；② **Git Bash 会吃掉 `\\`→`\`**——源码/测试含反斜杠一律用 `String.fromCharCode(92)` 构造，且**文件是 CRLF**，`Edit` 用 LF 会匹配失败、改文件优先 `node` 按行替换；③ **写测试前必须先实测**——临时探针文件 + `console.log` 确认真实返回值，禁凭想象写断言。
