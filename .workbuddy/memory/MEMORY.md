# work-duo 长期约定（单一事实源 · 校准 2026-09-17）

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
- 审批流：`approval.rs::cancel_all()` 清空 pending；`runtime.rs` `rx.await` 包 `timeout(300s)`。**run_task 启动重置清单必须含 `plan_approval.reset()`**（漏了会让 cancel() 残留的过期 Cancel 误杀下一个任务，20260917002）。
- 边审批策略引擎（15007）：`policy.rs` 5 类危险信号（credential/ci/lock/sys/buildcfg ~20 条）× 操作判定；三闸防疲劳=①计划批准一次授权整计划敏感清单（grants，Mutex HashSet 上限 64，run_task 启动重置）②执行期只拦计划外变更③「本任务内记住」勾选；**策略评估无条件化**（不被静态敏感短路，否则 auto 模式有盲区）；Exec 边按 code/command/script 内容行扫描（与计划文本同 grant_key 同源）；never=留痕不弹卡零打断。沙箱内部文件操作策略不可见（v1 边界，只评估工具入参）。

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
- **沙箱脚本落盘路径 + 执行 cwd（2026-09-10 真机 P1，已提交）**：脚本落 `.wd_mem/runtime/scripts/`（旧 `.wd_mem/scripts`）、执行 cwd=工作空间根（`ctx.workspace`），消除 `run_node_sandbox` ENOENT；见 `bun_manager.rs`/`mamba_manager.rs` `run_*_in_sandbox` 的 `cwd:Option<&Path>`。`wd_mem.rs` `.gitignore` 模板同步 `runtime/`。**P2（react-developer Skill 依赖三铁律 + edit_file 先 read_file）未做**。

## 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks 须 early-return 前无条件执行。chat 右栏三投影 Tab（图/过程/产物，图默认）。执行图=RunDagCanvas 复合 DAG（PlanStep 节点 + ToolStep 子节点；L 形鱼骨布局）。交互态 hover 禁用位移/缩放，只做背景/颜色过渡。
- antd `Notification` 弹窗**硬规矩**：整卡 `max-height:700px;overflow:hidden` + `.ant-notification-notice-description{max-height:540px;overflow-y:auto}`（仅文本区内部滚动，按钮第一眼可见）。正文走 `MarkdownRenderer`。**禁**字符截断+复制图标版（已废弃）。
- **HITL 四类弹窗已迁右栏「处置」DecisionCenter（20260917001，antd Notification 对 HITL 退役，OS 原生通知保留）**：授权/恢复/方案推荐/计划审批四张决策卡；角标计数 + 输入框上方轻横幅；挂起自动开右栏聚焦处置 Tab；决策点击乐观清空。antd Notification 硬规矩仍适用残余使用处。
- 表单自动行为**宁可静默无提示**（用户 9-16 决策）：自动同步/回填类动作不弹 toast/Alert，状态用**字段级 icon + 悬浮 Tooltip** 表达（如插件参数 Schema 同步 ✓绿/⚠琥珀，悬浮列内容/原因）。

## 全局消息 / Rust 工具链
- `useNotify()`（`App.useApp()`），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏。
- Rust：`$CARGO_HOME/bin/cargo.exe` 或裸 `cargo`（用户已配 PATH，禁硬编码路径）。重编前停 `npm run tauri` 防 `target/` 锁。bash 缺 coreutils：日志重定向后 Read，勿管道 `| tail`。

## 当前冲刺（2026-09-15 起）
单一事实源 = `需求与问题跟踪-第二期.md`（总览 `20260915001~012` + 3 周冲刺「排期建议」章节）。记忆只留进度快照，不复制排期。
- **Week1 可信地基（已收口/收口中）**：`20260915001`(provisional 完成态 ✅ 真机过)→`20260915002`(产物图驱动 ✅ 真机过)→`20260915003`(图中间态 ✅ 真机过，含死锁回归修复)→`20260915015`(校验降级误标已验证 ✅ 真机过)；`20260915004`(前端4确定性 bug ✅ 真机点验全通过：B1/B2/B3/B4；另硬化 @提及匹配 name→identifier)。
- **Week2/3 待办**：`15005`(chat 拆分 ✅ 2026-09-17 核验)/`15006`(错误面板可操作化 ✅ 2026-09-17 真机验收：重试本轮+查看恢复面板)/`15007`(边审批引擎 ✅ 2026-09-17 真机验收 A/B/C 全绿：never 留痕/计划一次授权/计划外策略卡+记住；policy.rs 信号表+grants，Exec 按 code 内容行扫描，沙箱内部操作仍属 v1 边界)/`15008`(Dashboard)/`15009`(小队)/`15010`(记忆护栏)/`15011`(TTS/STT)/`15012`(DB 路径 ⚠️ 待定)。另 `[20260917001]` HITL 处置中心（Phase1 真机✅/Phase2 待点验）与 `[20260917002]` plan_approval 残留 Cancel 修复（✅）见跟踪文件。**候选新任务**：gemma4 意图分类连续返空（内容全落 reasoning）→ 降级 risk=high 滥弹静态卡，待修（关 reasoning 或解析 reasoning 字段）。
- **#20260916001 用户自定义脚本插件（9-16 新建，✅ 已完结并入库）**：P0 数据契约 / P1 Rust 执行闭环 / P2 Agent 装配 / P3 插件中心 UI 全部真机验收通过（9-16 全天推进：基础点验→Bun 自愈修复→P2 Agent 调用→@提及插件→对话工具条胶囊）；**代码已由用户自行提交（9-16 晚）**。残留可选项：P4 打磨（运行日志清理策略/导出导入 JSON/审批文案），按需插队做。详见下方「用户自定义脚本插件」段。`15005`(chat 拆分) v1 已回退；**v2 安全优先拆分 9-16 晚六步落地**（3839→2600 行 -32%，物理搬运零结构改动，commit 504f8e5…682b5b8 + tag pre-chat-split，方案 docs/chat-split-plan.md，**2026-09-17 用户核验通过 ✅**）。
- **Pixel Agent 拟人化像素智能体（9-17 全天推进，✅ 已完结，代码已提交 c2faa66，真机点验 2026-09-17 晚全部通过）**：设计演进 v1.0（AgentFace 三处接入）→ **v1.2**（形象设计弹窗→PNG 快照写 logo，列表/聊天零改造）→ **v2 重制**（16→32×32 游戏级；性别级联 男/女发型池 5+5、上衣池 4+4；帽子/下装/鞋子独立配色；配饰 7 种；**表情改状态驱动不手动选**；动效全 opacity 两帧交替不糊边：idle 静止/working 笔记本敲键+代码行/thinking 托腮+思考点/error X眼+感叹号+汗滴）→ **弹窗 v3**（游戏角色创建器式三栏 920 宽：预览/大分类竖导航/选项面板，选项卡片直渲像素小人）。实现：DDL `agent_info.appearance`（init.sql + updater **v24** 双写）+ `src/components/ui/pixel-agent/*`（types/constants/parse 兼容旧 JSON 迁移/layers buildPixelRects 唯一几何事实源/PixelAgent/snapshot SVG→canvas PNG/AppearancePicker/AppearanceModal/index）+ mapper `upsertAgent` 22/22/22+ON CONFLICT 含 appearance + StepBasic 移除 file 上传换形象预览+弹窗。坑：AppearanceModal 忘 import scss 致样式全缺——新建组件带 scss 时 import 必须同轮落。任务规划文档 `docs/pixel-agent-task-plan.md` 已全勾 ✅（DoD 9/9，Phase 2 项明确不做）。
- **第三期已立项（2026-09-17）· M0 已完成 ✅**：单一事实源 = `需求与问题跟踪-第三期.md`（记忆与知识统一检索，编号 20260918001-010：M0 护栏→M1 嵌入+LanceDB 基建与召回→M2 rerank+artifacts→M3 会话蒸馏→K1/K2 知识库→K3 统一检索）。设计稿 `docs/memory-system-design.md` **v2.0 已拍板**：向量库=统一 LanceDB（否决 SQLite BLOB；SQLite 只存业务元数据/ref_count，不存 embedding）；数据目录 `vector_path` 默认 `$APPDATA/.vectors` 可迁移（否决 `$RESOURCES`）；嵌入/重排外接 LLM 模块；降级链=向量→关键词→ref_count；表 memories/artifacts/kb_chunks/session_summaries。**M0 护栏（#20260918001 ✅ 真机验收通过 via MiniMax M3）**：`validate_forced_entry`(key≥2/content≥10/模板黑名单/category强校验丢弃)+`anchor_memory.auto_merge`(去噪合并 find_similar_memory)+`recall_top_memories`加prompt+char_bigrams/overlap_score 字符2-gram重排降级链；9单测全过(42全绿)；排查顺带根治 call_llm reasoning 返空兼容（content空→reasoning字段回填，gemma4 意图返空同源）+ forced 提炼 temperature=0；**gemma4:e4b 提炼能力不足=已知限制**（小模型不宜当执行模型）。下一步 M1（#20260918002 嵌入+LanceDB 基建）。KB 现状：UI/表/目录齐但 Rust 侧零消费（RAG 0%）。
- 收口标准：`cargo check`+`npm run typecheck`+真机一条验收路径写回跟踪文件。

## 用户自定义脚本插件（#20260916001 · ✅ 已完结入库 2026-09-16，P4 打磨可选）
本地 FaaS：用户脚本（Python/Bun）= Agent 工具 `custom__<identifier>`（语义对齐 Skill/MCP）。设计稿 `docs/user-plugin-design.md` v1.0。
- Rust：`plugin_runner.rs`（Runner 壳 + **exit 42 依赖自愈优先协议** + 超时 `taskkill /T /F` 杀树 + 写 `plugin_run_log` + 回写 `last_run_*`）/ `plugin_adapter.rs`（`PluginTool`+`register_plugins_into`）/ `plugin_commands.rs`（`test_user_plugin` + `extract_plugin_meta` 头注释解析→JSON Schema）；`lib.rs` 注册两命令。
- TS：`src/core/file/plugin-file.ts`（领域模型+校验+草稿）+ `src/core/mapper/plugin-mapper.ts`（CRUD+bind/unbind+localStorage 回退）+ `plugin-connection.ts`（桥，对齐 mcp-connection）；`pages/plugins/`（卡片网格+detail Tabs+Form/Test Modal）；TopBar 百宝箱「插件」(Puzzle)；paths/router 接线。
- DDL：`init.sql`+`updater.sql` 三表 `user_plugin_tool`/`agent_plugin_ref`/`plugin_run_log`（双源同步）；`database.d.ts` 对应 Row。
- 装配（P2）：`load_config` 拼 `user_plugin_tool JOIN agent_plugin_ref` 注册；`RunAgentTaskInput` 加 `enabled/disabled_plugin_ids`（@提及临时并入，对齐 Skill）；`planner.rs capability_outline` 追加插件条目（明确「匹配时必须优先直接调 custom__，禁手写脚本重复实现」）；系统提示仅 plugin_tools 非空时追加「本地插件工具」段。
- @提及：chat.tsx 加插件候选（group='插件'，token=identifier，label=name）；`resolveMentionTags` 插件匹配（identifier 优先/name 兜底）；send/regenerate 透传；底部 PluginPill（Puzzle 图标胶囊 + hover Pop 列详情/临时移除恢复，**Pop createPortal 到 body 避 transform 祖先致 fixed 漂移**，胶囊用专用 `__plugin-pill` 对称 padding 居中）。
- 铁律：① 插件=工具，**先做完单模块再跑 Agent**；② 受管 `bun_root/node_modules` 自愈（设置页依赖管理可见、跨运行复用），`ensure_node_modules_link`（Windows junction / Unix symlink），失败回退装运行目录；③ Runner 壳用 raw string 常量（禁 `\n\` 续接吞缩进）；顶层 import 缺包走 exit 42（`_USER_SRC` 直接 `py_safe_json_literal` 赋值，非 json.loads 二次解码）。
- 状态：**✅ 已完结**（9-16 真机全链路：Python/Bun×成功/自愈、向导挂载、Agent 调用 custom__、@提及、临时取消挂载），用户已提交。当日顺手修复：Bun 自愈两层 bug（整句报错当包名 + 单引号正则）、Monaco ts.worker 注册/关语义校验/外部值同步、Field.scss Switch 拉满、planner 能力大纲补插件条目（否则规划员不知插件存在，规划成手写脚本）。
