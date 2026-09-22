# work-duo 长期约定（单一事实源 · 校准 2026-09-21）

> 逐日细节留 `2026-*.md`；需求单一事实源=仓库根 `需求与问题跟踪-第三期.md` + `docs/memory-system-design.md`(v2) + `docs/knowledge-rag-design.md`(v1)。前端规范见《前端开发规范.md》。**🔴 红线：`.wd_mem/**` 与 `.workbuddy/memory/**` 绝不进用户可见 UI / present_files。**

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；Sass 只用 `var(--color-*)`；lucide-react；HashRouter；Squad/执行图=`@xyflow/react` v12。**只跑 `node node_modules/typescript/bin/tsc --noEmit`**（bash 缺 coreutils），禁 `vite build`；调试 `npm run tauri`（dev 模式 Rust 改动自动重编译）；勿改 `vite.config.ts`。

## 依赖 / 沙箱 / DDL
- AI 只写 `package.json` 不自己装；重型前端库动态 `import()`+`shims.d.ts`。
- SQLite `workduo.db`；TS 访问层 `src/core/mapper/*`（禁组件直写 SQL）；DDL 单一事实源 `src/assets/sql/init.sql`+`updater.sql`（当前 v29）。**DDL 变更必查 mapper 三要素**（列/`?`/参数数对齐）。
- Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→sqlx(0.8)，key=`sqlite:workduo.db`。
- **cargo 沙箱自验**：`source ~/.workbuddy/msvc-env.sh && CARGO_TARGET_DIR=target-sb cargo test/check`（target-sb 已 gitignore；与 dev 的 target/ 隔离防锁冲突）。

## 架构 / MCP 自测闭环
- L0 `src-tauri/src/agent/**`=ReAct 引擎；L2 领域区分唯一通道=Skill+MCP+Plugin+Agent 人设。
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`；`try_acquire_run_lock()` 多任务隔离已落地（20260919002 ✅，commit 3919c0a，旧「全局互斥」记载作废，锁形态以代码为准）。
- **内建 MCP Server** `src-tauri/src/mcp_server.rs` 监听 `127.0.0.1:18755/mcp`（Streamable HTTP，**69 工具**，覆盖 Agent/插件/KB/记忆/技能 五大模块 + Agent HITL 闭环 tool/plan/recovery 三类挂起）。前端零侵入桥 `src/core/mcpBridge.ts`：`listen('mcp:intent')`→真实 handler→`invoke('mcp_resolve_result')`；**UI 级工具回包统一 `{ok,data}` 信封**（驱动需拆 `data`）；`agent_get_run_trace` 回包有 `{"trace":{…}}` 外包裹层（驱动必须剥）。连接器 `~/.workbuddy/mcp.json`→`workduo-mcp`(`"type":"http"`)。
- **前端日志透传（2026-09-21 新增）**：Rust 命令 `logging::log_frontend(level,module,message)` 把前端日志以与 tracing 同格式 `[时间][模块][fe][web:0]-LEVEL-内容` 落同一份 `workduo.log.YYYY-MM-DD`（复用 `choose_logs_dir`）。前端 `src/core/logBridge.ts` 暴露 `fe.info/warn/error/debug(module,msg)`，fire-and-forget（失败静默）。已埋点：kbFs / kb-index-hooks / knowledge-mapper / mcpBridge(kb:*)，经 `agent_get_run_logs` 可一并回看前端链路。

## 前端铁律
UI 令牌只 `var(--color-*)`；hover 禁位移/缩放；表单 `autoComplete="off"`；`useNotify()` 禁静态 message；HITL 四类决策在 DecisionCenter；fixed 弹层 createPortal 到 body。

## 反复踩坑铁律（必背）
- Rust 字符串截断一律 `chars()`，`&s[..n]` 仅纯 ASCII。
- 多行代码注入一律 Edit 工具逐点做，禁 node 脚本批量替换。
- 关键词子串风险分级必须配误伤回归测试。
- 消费端必须追到 JSX props 实参。
- 打字机常速；终态文本一次性下发绕过打字机。
- 定时器/订阅 cleanup=清除+复位两步。
- Lance 原语全部幂等处理「表不存在」。
- 熔断判定必须过客观校验；criteria 空严禁直接判失败重试。
- **机制正确≠结果正确**，验收必须核对业务产物。
- **跨链路数据落库引擎终态统一兜底**（persist_round_answer/process_if_empty，仅空时写不覆盖前端），不依赖调用方自觉；日志 clip（带注记）禁入用户可见正文（#20260921001）。

## 进度快照
- 第三期（记忆与知识统一检索）✅ 收官（cargo 72 passed / tsc CLEAN）。
- 第四期 K 系列：K1a 引擎/K1b 前端/K2 检索+绑定 ✅；**K3 全部收官（2026-09-21）**：K3-1 命中卡片 ✅（三渲染位）/ K3-2 引用汇总 ✅（反馈改版：正文 `[N]` 内联引标悬浮溯源（Rust cite 编号+remarkKbCites+KbCiteMark）+ 底部按源分组 + 中文思考约束 + 流式滚动 stick-to-bottom + 30ms/字正文打字机）/ K3-3 标签云 ✅（tags 圈定 Rust 内存交集 + 详情页标签云/打标签入口）/ K3-4 上下文成本 ✅（六项优化）。cargo 86 passed / tsc 0E。
- **Q1 顺带 4 问题 ✅ 全修（2026-09-20）**：#3 切块噪声（`is_noise_chunk` 收口 push_chunk，ⓘ 生效需重建 KB 索引）/ #2 幽灵产物去重（`resolve_artifact_entries`+`physical_key` 物理去重）/ #1 intent 空响应（重试一次+`fallback()` 信号定向降级+planner 知识问答降耗约定）/ #4=K3-4（同上）。
- 内建 MCP 自测闭环 ✅；**五大模块（插件/KB/记忆/技能/Agent HITL 闭环）UI 级工具已全部接入（69 工具）**，含 KB 标签 add/remove/rename/get、技能中心 9 个 `skill_*` 工具、Agent 审批三件套 + `agent_submit_recovery_decision`（retry/skip/takeover/change-approach）+ `get_status` 透出 `recoveryWaiting`/`pending{kind:tool|plan|recovery}`；前端日志透传 ✅。
- **E2E 审计收官（2026-09-22，100/100 满分，基线 45 分）**：① P-04 kb_search tags 语义错位修复（kb_scope 收窄+结构化诊断+tags-as-kb 捷径，R1-R5 真机 5/5）；② #1 意图回归 = **KB 事实问答走 SIMPLE_CHAT 快路径携带 native__kb_search**（撤旧「强制转 COMPOSITE」块，有界 2 轮检索→综合，跳过规划；分类器补 KB 规则）；③ #4 孤儿轮次启动清扫 / #5 push_event 判据 type / #6 trace 包裹层描述；④ `planAutoApproveMode` 语义 = always 最严格门禁 / never 全自动（无人值守用 never+autoToolExecMode）；⑤ 今日共 11 commit（ad1a6ed…eed59a9）+ 测试资产清理 45 项（KB×11/Agent×21/插件×10/磁盘 workspace×3，保留 wd_design 与 approval-loop-agent）。**标准驱动已收编 `docs/skills/workduo-mcp/scripts/`**：agent_task_driver（库）/agent_e2e_audit（评分审计）/agent_intent_probe（意图探针，exit 0=PASS），回归两命令即可。唯一遗留：#8 trace per-run 缓冲（emit 缺 run 上下文，**未实现**——events.rs 仍为全局单缓冲 `TRACE_EVENTS/THINKING/REPLY` + `reset_trace()` 清空，并行多 Agent 仍会串台）；**跨客户端同步**：2026-09-22 核查发现三处曾漂移（docs=10 / ~/.workbuddy=7 / .mimocode=9，SKILL.md 工具数 69/65/68 三版不一），已按 docs 为源重对齐为三处各 12 文件逐字节一致；**站立待办**：20260919001 小分队打磨 🔲。

## 待办 / 长期约定
- **🔴 筑基战略（2026-09-22 用户定调）**：当前处于**筑基阶段**，资源（人力/物力）有限，先打牢单 Agent 再追 Codex 类专业工具。**地基 = 单 Agent 一次运行「可控 / 可观测 / 可兜底」**，拆为三根支柱：① 终态铁律（任何运行有限时内到终态，不挂死/不丢锁/不残留孤儿）；② 工具契约（参数严格校验 + 结构化错误返回绝不停默空 + 执行限时）；③ 观测闭环（trace+日志可完整还原，含 #8 per-run 缓冲）。**打牢方式**：不铺广度、堆异常路径深度覆盖，循环 = 异构任务集反复跑 → 暴露 bug 归柱 → 修代码 + 必加回归断言 → 优先填缺口最多的柱；一次只打一个缺口不并行铺线。**多 Agent（小分队）= 单 Agent 能力的组合运用**：设计/接口可保留，但验收与打磨**推迟到三根支柱全绿之后**（失败模式是单 Agent 超集）；不限定时间暂停它，是让它等地基。对标只用其"共同地基"（终态/契约/观测），不追 SWE-bench 分数；差异只在各产品往上叠的关注点（Codex=自愈、Claude Code=编辑安全、WorkBuddy=工具生态）。
- 20260919002 单 Agent 多任务隔离 ✅（2026-09-21，3919c0a）；20260919001 小分队打磨 🔲（筑基期内推迟验收）。
- KB 删除级联清理向量段已修（f78701b，防 Lance 孤儿残留）；`agent_run_task` 的 workspace 字段已标注「=绑定工作空间绝对路径，不传则自由对话」（e98df0f）。
- **🔴 Skill 同步铁律**：仓库 `docs/skills/<name>/SKILL.md` 为单一事实源；客户端必须同步一致。**workduo-mcp 客户端1 已对齐 ✅（2026-09-22 实测曾漂移 docs=10/~.workbuddy=7 且 SKILL.md 计数 69/65 两版不一；已按 docs 为源重同步 `~/.workbuddy`，现两端各 10 文件逐字节一致：SKILL.md + scripts{README + agent_task_driver/agent_e2e_audit/agent_intent_probe + kb_driver/kb_tag_driver/memory_driver/plugin.bun/plugin.python}；`.mimocode` 由用户删除，不纳入）**。
- **🔴 Skill 内容红线（2026-09-21 确立）**：SKILL.md **不得出现任何第三方产品目录路径**（如 `~/.workbuddy/...`、特定 IDE/客户端路径、安装步骤指向某产品配置目录）；需引用资源只指向 **skill 内部相对路径**（如 `scripts/`）。该 skill 定位 = **给外部编程工具（任意支持 MCP 的客户端）对接 WorkDuo 内建 MCP Server 的集成指南**，不叫「自测/selftest/测试」，命名即 `workduo-mcp`（无 selftest 字眼）。
- **用户长期约定（2026-09-22 强化）**：测试/使用中发现 MCP/SKILL 封装缺口（缺工具、语义不清、文档缺失、观测不到状态）时，**第一动作是补 `workduo-mcp` 本体**——加/改 MCP 工具（mcp_server.rs）、更新 SKILL.md、把标准驱动沉淀进 `docs/skills/workduo-mcp/scripts/`——**严禁绕过 MCP 自写一次性脚本替代**；驱动脚本只做参数编排，缺口一律回流到 SKILL+MCP 层。SKILL+MCP 拿不到有效信息时第一时间报告做更新/补丁。
- **`get_run_logs` since_ts 坑**：行首 `[YYYY-MM-DD HH:MM:SS.mmm]` 子串字典序比较；传 ISO(`T`/`Z`) 会被全剔返回 0 行，须传**本地空格分隔**同形串或仅用 `limit`。
