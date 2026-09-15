# work-duo 长期约定（单一事实源 · 校准 2026-09-15）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`；需求/问题单一事实源 = 仓库根 `需求与问题跟踪-第二期.md`（2026-09-12 起）。前端规范见《前端开发规范.md》。**🔴 内部私有数据红线：`.wd_mem/**` 与 `.workbuddy/memory/**` 绝不可进用户可见 UI / 经 `present_files` 展示。**

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter。Squad/执行图 UI 用 `@xyflow/react` v12。**只跑 `npm run typecheck`**（用 `node node_modules/typescript/bin/tsc --noEmit`，本 bash 缺 coreutils、npm 生命周期脚本报 `/usr/bin/env: bash`），禁 `vite build`；调试 `npm run tauri`；勿改 `vite.config.ts`。

## 依赖 / 沙箱 EPERM
- AI 只写 `package.json`，绝不自己装；重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。
- `src/` 删除/改名 EPERM→新建合规位置+改 import+typecheck，旧文件用户手动删。

## 数据持久化 / DDL
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。DDL 单一事实源：`src/assets/sql/init.sql`+`updater.sql`。Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→`sqlx`(0.8)；key=`sqlite:workduo.db`，前端须先 `load()`。
- **DDL 变更必查 mapper**：`ALTER TABLE ADD COLUMN` 后 `grep "INSERT INTO <表>"` 全项目，核对列清单/占位符`?`数/参数数组长度三者对齐（`tsc` 不查 SQL 占位符）。

## 架构分层铁律（L0 基座领域无关 + L2 外部因素定专业）
- L0 `src-tauri/src/agent/**`=ReAct 引擎（意图→规划→执行→校验），禁内置领域能力。
- L1 通用接口：沙箱(python/node)、Global Tool、文件/网络。L2 领域区分唯一通道=Skill+MCP+Agent 人设。
- 能力层优先：约束落 `register_native_tools`；仅写 system_prompt 必被绕过。

## 智能体引擎红线（架构不变量）
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（invoke 须包 `input`/`decision`）。流水线：意图分流→SIMPLE_CHAT/COMPOSITE→DAG 规划(`planner.rs` JSON 失败降级单任务、`temperature=0`)→执行(`pipeline.rs`，`MAX_SUBTASK_RECOVERY_ATTEMPTS`、连续2错拦截)。取消 `cancel_flag:Arc<AtomicBool>` 贯穿。
- LLM 铁律：每轮仅1次流式 `call_llm_stream`；无 tool_calls→终态。
- 并发互斥：`try_acquire_run_lock()` 唯一闸门在 `run_agent_task`（spawn 前）；抢占失败 `Err("已有任务正在运行…")`。
- 消息序列配对：每 assistant `tool_call.id` 须有对应结果；发送前+落库前各调 `sanitize_message_sequence`，违反→网关 400。步骤成功必 emit `step_finished(true)`；`finalizeStuckSteps()` 兜底误标失败。
- 审批流：`approval.rs::cancel_all()` 清空 pending；`runtime.rs` `rx.await` 包 `timeout(300s)`。

## 单 Agent 统一实体图（graph.rs）
图=运行时数据模型=持久化：Planner 写图、流水线在图上调度、工具写图、恢复改图。存储 `.wd_mem/graph/`。pipeline 图驱动：原 HashMap 收编进 TaskNode(status/guidance/retryCount/summary)。`run_simple_chat` 不走图。

## 图驱动约束铁律
模型行为约束**必须读图的真实数据**，禁 prompt 软约束。回复聚合只读本轮 TaskNode `success_criteria.target`，**绝不读模型 `summary`**。会话背景只注入历史 TaskNode `title`（不含文件名）。验收由图数据(target/Produced 边/真实工具返回)决定，而非模型自律。

## Skill 注入 / 强制串行
Skill 不再注册为工具；`pipeline.rs::build_skill_guidance` 在 `run_subtask` user 消息注入（空→不注；多技能→摘要；单技能→`skill_markdown` 截断 2000 字符）。`pipeline.rs` `let max_parallel:usize=1;`（无条件串行）。

## native 工具链闭环（已根治项见跟踪文件 20260914011/13/14/15/16/18）
- 首梯队工具（沙箱开/关均注册）：`delete_path`/`move_path`/`grep_files`/`zip_create`/`zip_extract`/`regex_replace`/`http_request`。HTTP 硬防护：仅 http/https、方法白名单、30s、`SsrfSafeResolver` 禁私有/环回/云元数据；host 白名单 `app_config.http_allowed_hosts`。
- 沙箱同目录 import：Python 注入 `PYTHONPATH=原始目录[;工作空间根]`；Bun 原地执行 + `NODE_PATH=bun_root/node_modules`。
- 校验器运行成功=退出码 0 为唯一真相源（`command_succeeded`），禁从 stdout 猜（20260914018）。
- 计划审批=never：失败步自动接管重试（带诊断回灌），达 `MAX_TASK_RECOVERY_ATTEMPTS` 才 skipped，不弹 recovery（20260914013/14）。
- 任务完成后推荐：追加进最终回复文本，禁弹 `ask_user_choice`（20260914015）。

## 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks 须 early-return 前无条件执行。chat 右栏三投影 Tab（图/过程/产物，图默认）。执行图=RunDagCanvas 复合 DAG（PlanStep 节点 + ToolStep 子节点；L 形鱼骨布局）。交互态 hover 禁用位移/缩放，只做背景/颜色过渡。
- antd `Notification` 弹窗**硬规矩**：整卡 `max-height:700px;overflow:hidden` + `.ant-notification-notice-description{max-height:540px;overflow-y:auto}`（仅文本区内部滚动，按钮第一眼可见）。正文走 `MarkdownRenderer`。**禁**字符截断+复制图标版（已废弃）。

## 全局消息 / Rust 工具链
- `useNotify()`（`App.useApp()`），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏。
- Rust：`$CARGO_HOME/bin/cargo.exe` 或裸 `cargo`（用户已配 PATH，禁硬编码路径）。重编前停 `npm run tauri` 防 `target/` 锁。bash 缺 coreutils：日志重定向后 Read，勿管道 `| tail`。

## 当前冲刺（2026-09-15 起）
下一波任务 = `需求与问题跟踪-第二期.md` 总览 `20260915001~012`（全 🔲）。Week1 可信地基：20260915001(provisional 完成态)→20260915002(产物图驱动)→20260915003(图中间态)→20260915004(前端4确定性bug)。收口标准：`cargo check`+`npm run typecheck`+真机一条验收路径写回跟踪文件。
