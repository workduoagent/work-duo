# work-duo 长期约定（单一事实源 · 校准 2026-09-23）

> 逐日细节留 `2026-*.md`；需求跟踪=仓库根《需求与问题跟踪-汇总.md》。**🔴 红线：`.wd_mem/**` 与 `.workbuddy/memory/**` 绝不进用户可见 UI / present_files。**

## 技术栈 / 构建铁律
- React19+TS+Vite+Tauri2；antd v5 经 `@/components/ui` 封装禁裸用；Sass 只 `var(--color-*)`；lucide-react；HashRouter；执行图=@xyflow/react v12。**只跑 `node node_modules/typescript/bin/tsc --noEmit`**，禁 vite build；勿改 vite.config.ts。前端铁律：UI 令牌只 var(--color-*)；hover 禁位移缩放；表单 autoComplete=off；useNotify 禁静态 message；HITL 决策在 DecisionCenter；fixed 弹层 createPortal。
- **🔴 Rust 改动必须重启 App 才生效**：dev 自动重编译只重建产物，运行进程仍是旧二进制；改完 *.rs 的验证一律排在重启之后。
- 依赖：AI 只写 package.json 不装；重型前端库动态 import()+shims.d.ts。
- SQLite workduo.db；TS 访问层 src/core/mapper/*（禁组件直写 SQL）；DDL 单一事实源 src/assets/sql/init.sql+updater.sql；**DDL 变更必查 mapper 三要素**（列/?/参数数）。Rust 读库：DbInstances→sqlx，key=sqlite:workduo.db。**Agent 配置表=`agent_info`**（模型经 llm_id 外键），Rust 侧只 SELECT，写入唯一路径=前端 agent-mapper.ts；MCP `agent_ui_create/list/update/get/delete` 走前端真实 handler 可自助建 Agent（无人值守必须显式 isActive=true/autoToolExecMode=true/allowSandbox=true/memoryMode/planAutoApproveMode='never'）。
- cargo 沙箱自验：source ~/.workbuddy/msvc-env.sh && CARGO_TARGET_DIR=target-sb cargo test/check。

## 内建 MCP（70 工具）
- mcp_server.rs 监听 127.0.0.1:18755/mcp（Streamable HTTP）：引擎 9+发现 7+UI 意图 54（Agent12/插件8/KB15/记忆9/技能10）。**每个模块必须有 *_list 枚举入口**。
- UI 级工具回包 {ok,data} 信封；agent_get_run_trace 有 {"trace":{…}} 外包裹层（驱动先剥）。**#8 per-run trace 已落地**（with_run_id_scope 并发不串台，get 必传 run_id）。
- 前端零侵入桥 mcpBridge.ts；连接器 ~/.workbuddy/mcp.json→workduo-mcp(type:http)。前端日志透传 logging::log_frontend→同一 workduo.log.YYYY-MM-DD（logBridge fe.*）。

## 反复踩坑铁律（必背）
- Rust 截断一律 chars()；多行注入 Edit 逐点做禁脚本批替换；风险分级必配误伤回归；消费端追到 JSX props；打字机常速、终态一次性下发；定时器 cleanup 两步；Lance 幂等「表不存在」；熔断必过客观校验；**机制正确≠结果正确，验收必须核对业务产物**；跨链路落库引擎终态统一兜底；日志 clip 禁入用户正文。
- **Glob 工具坑**：绝对路径当 pattern 一律假阴性，必须 path 参数+相对 pattern。
- get_run_logs：since_ts 用本地空格串（ISO 全剔）；**跨天只读当天文件**（跨零点直读磁盘）；agent-event 洪流捞关键字须 limit:8000。本机 bash 缺部分 coreutils（head/cp/ls 缺时走 node 替代）。

## L2 生态测评（2026-09-23 收口，外部执行方执行）
- 规模：34 用例/8 故障/12 并发组；证据 `docs/eval-results/2026-09-23/`（60 文件：scorecard/findings/env/各 JSON）；复测驱动 `l2_eval_harness.mjs`（已入 scripts/）。改进指导意见=同目录《改进指导意见.md》（P0→P1→P2）。
- 结论：**三支柱地基好**（无永久挂死/并发不崩/锁放/可清）。卡点：①P0-1 **600s run 预算杀 12/34 用例**（多文件/多源/并发≥2 必撞，A-M2 串行已 473s）②P0-2 失败后 reply 空（emit_task_error 不写 trace.reply 不扫 workspace，events.rs:473）③P1-1 xlsx 稳定缺口（native 无 write_xlsx，A-M2 产物 0%；png 靠运气）④P1-2 取消无 cancelled 三态（registry 只 timed_out?error:done，commands.rs:330）+ submit_* 状态束回收后 Err 而非结构化 no_pending（commands.rs:642，F-4 实证）。
- **评审修正（8/8 代码锚点已核实）**：a) 分层预算必须>调用级 180s——SIMPLE_CHAT 120s 层级倒挂，建议≥300s；b) 软超时复用 cancel_flag 两阶段（tokio timeout 到点硬 drop 内层 future，「等收尾≤30s」须到点前置位实现；reply/文件表回写只能在外层超时分支做）；c) 超时分支补写 rec.error=error_code；d) finalize 文件表过滤 .wd_mem/。
- 执行进度：**Rust 批次已落地（2026-09-23 13:5x，target-sb cargo check 0E）**——P0-1（DEFAULT_RUN_MAX_SECS 600→1800 + `RUN_SOFT_WINDOW=30s` 两阶段软超时 `spawn_budget_watchdog`，watchdog 用完即 abort 防跨任务泄漏；**intent 分级未做**——意图在 run_task 内部才分类、包装层拿不到，SIMPLE_CHAT 由调用级超时兜底）+ P0-2（`events::finalize_run_summary` 写 reply+文件表，过滤 .wd_mem/；rec.error 补 `run_budget_exhausted`/`cancelled_by_user`）+ P1-2（`AgentTaskState.cancel_requested` 三态 registry done/error/cancelled + 6 处 submit_* 状态束回收→Ok(false) no_pending）；P1-1 `plugin.xlsx_writer/chart_png.template.py` + SKILL 流程2.1 产物契约已落且同步客户端（**18 文件一致**）。**待用户重启后** l2_eval_harness 回归 12 个 600s 用例+F-1/F-4（通过线：done≥9/12、reply 非空 100%、cancelled 100%、A-M2 xlsx+png 3/3）。
- 可用 chat 模型：DeepSeek-V4.1-Flash（主力）/GLM-5.3-Flash/MiniMax-M3；gpt-5.6-luna 嫌疑不用；Qwen3.6 已移除。

## 战略 / 长期约定
- **筑基战略（用户定调）**：先打牢单 Agent（可控/可观测/可兜底三支柱），多 Agent（小分队）=组合运用推迟验收；对标只用共同地基不追 SWE-bench。
- **Harness 位置=L2 边界防御**：多样化边界用例真机实测；自测一律走 workduo-mcp，缺口回流 SKILL+MCP 层，**严禁绕过 MCP 写一次性脚本**。孤儿清扫仅启动触发，拟补 agent_sweep_orphan_rounds（Rust+重启，待准）。
- **超时阈值铁律**：判据用「无产出静默时长」绝不用总耗时；慢≠死（同任务模型间 15 倍差）；三层=调用级 180s+收尾 30s+run 级兜底；env 可调 WD_LLM_TIMEOUT_SECS/WD_LLM_CHUNK_TIMEOUT_SECS/WD_LLM_STREAM_TOTAL_SECS/WD_RUN_MAX_SECS，改后重启。
- **Skill 同步铁律**：docs/skills/<name>/SKILL.md 单一事实源，客户端 ~/.workbuddy 同步一致；SKILL 禁第三方产品路径，资源只指 skill 内相对路径；定位=外部客户端对接指南，不叫 selftest。**待同步：docs 16 文件（新增 tool_contract_probe/l2_eval_harness）尚未全量同步客户端。**
- 历史：第三期记忆知识检索 ✅；K 系列 ✅；E2E 审计 100/100（2026-09-22）；20260919002 多任务隔离 ✅；20260919001 小分队打磨推迟。
