# work-duo 长期约定（单一事实源 · 校准 2026-09-20）

> 与每日日志冲突以本文件为准；逐日细节留 `2026-*.md`。需求单一事实源=仓库根 `需求与问题跟踪-第三期.md` + `docs/memory-system-design.md`(v2) + `docs/knowledge-rag-design.md`(v1, 第四期 K系列)。前端规范见《前端开发规范.md》。**🔴 红线：`.wd_mem/**` 与 `.workbuddy/memory/**` 绝不进用户可见 UI / present_files。**

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；Sass 只用 `var(--color-*)`；lucide-react 图标；HashRouter；Squad/执行图=`@xyflow/react` v12。**只跑 `node node_modules/typescript/bin/tsc --noEmit`**（bash 缺 coreutils），禁 `vite build`；调试 `npm run tauri`；勿改 `vite.config.ts`。

## 依赖 / 沙箱 / DDL
- AI 只写 `package.json` 不自己装；重型前端库动态 `import()`+`shims.d.ts`；`src/` 删除/改名 EPERM→新建+改 import，旧文件用户手动删。
- SQLite `workduo.db`；TS 访问层 `src/core/mapper/*`（禁组件直写 SQL）；DDL 单一事实源 `src/assets/sql/init.sql`+`updater.sql`（当前 **v29**：v26=segments_json 交错时间线 / v27=agent_memory_candidates 蒸馏 / v28=knowledge_asset digest+kb_embed_dim / v29=agent_kb_ref）。**DDL 变更必查 mapper 三要素**（列/`?`/参数数对齐）。
- Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→sqlx(0.8)，key=`sqlite:workduo.db`。
- **cargo 沙箱自验**：`source ~/.workbuddy/msvc-env.sh && CARGO_TARGET_DIR=target-sb cargo test/check`（target-sb 已 gitignore；与 dev 的 target/ 隔离防锁冲突）。

## 架构分层铁律
- L0 `src-tauri/src/agent/**`=ReAct 引擎；L2 领域区分唯一通道=Skill+MCP+Plugin+Agent 人设；约束落 `register_native_tools`。
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`；流水线意图分流→DAG 规划→执行；`try_acquire_run_lock()` 当前=**全局互斥**（多任务隔离待 20260919002）；消息配对 sanitize（否则网关 400）；run_task 启动重置清单含 plan_approval.reset()+approval_grants.reset()。
- 边审批（15007）：5 类危险信号；三闸防疲劳；策略评估无条件化（Exec 边按 code 内容行扫描）；never=留痕不弹卡。
- 统一实体图（graph.rs）：回复聚合只读 TaskNode `success_criteria.target` 禁读模型 summary。
- **第四期 K 系列**：统一 LanceDB（kb_chunks 表 M1 已建，v2 schema 16列）；KB 文件前端 kbFs.ts fs 直写 → 钩子挂 mapper 三变更点（fire-and-forget）；维度表级（`kb_embed_dim`）。

## 前端铁律
UI 令牌只 `var(--color-*)`；hover 禁位移/缩放；表单 `autoComplete="off"`；`useNotify()` 禁静态 message；HITL 四类决策在 DecisionCenter；fixed 弹层 createPortal 到 body。

## 反复踩坑铁律（必背）
- **Rust 字符串截断一律 `chars()`**，`&s[..n]` 仅纯 ASCII（中文多字节字节切片 panic 卡死）。
- **多行代码注入一律 Edit 工具逐点做**，禁 node 脚本批量替换（续行符失效/声明挤进 // 注释两次事故）。
- **关键词子串做风险分级必须配误伤回归测试**（RISK_HINTS 误伤「覆盖」→弹卡13次）。
- **消费端必须追到 JSX props 实参**（`thinking={[]}` 死数组骗过两轮调研）。
- **打字机必须常速**（追赶式=数据突发视觉突发）；终态文本一次性下发绕过所有打字机（用 stream_final_text chars 切片）。
- **定时器/订阅 cleanup=清除+复位两步**（只清不复位 StrictMode 死锁）。
- **Lance 原语（query/delete/upsert）全部幂等处理「表不存在」**（不只查询路径）。
- **防闪空用占位态不用保留旧数据**；延迟换幕必须评估窗口期时长（上一轮残留体感）。
- **熔断判定必须过客观校验**；criteria 为空严禁直接判失败重试（检索死循环）；沙箱双路径（code/script_path）行为必须一致。
- **机制正确≠结果正确**，验收必须核对业务产物（外部评审假绿教训）。

## 进度快照
### 第三期（记忆与知识统一检索）✅ 收官
M0 护栏 / M1 嵌入+LanceDB / M1 记忆召回管道 / M2 rerank / M2 artifacts 入 Lance / M3 会话压缩蒸馏 / 011 reasoning 打字机 —— 全完成+真机验收（cargo 72 passed / tsc CLEAN）。
### 第四期 K 系列（知识库 RAG 重设计）v1.0
- **K1a 引擎层 ✅**（DDL v28 + knowledge.rs + vector_store kb_chunks v2 + 命令三件套）
- **K1b 前端 ✅**（kbFs 三钩子 + 详情页重建/进度/状态徽标）
- **K2 检索工具+绑定 ✅**（native__kb_search + agent_kb_ref DDL v29 + planner 大纲；收敛护栏+四案例全绿真机验收）
- **K3 引用展示+标签云+上下文优化 🚧 逐子任务实现中**（#20260918010）
  - **K3-1 命中片段卡片 ✅ 收口**（`KbSearchCitations` + 统一分发 `ToolResultView`：对话/规划/执行图三渲染位，解耦——kb_search 渲染仅一处；Q1 双轮真机验收通过，源文件可打开）
  - **Q1 顺带 4 问题**：**#3 切块噪声 ✅**（`is_noise_chunk` 纯函数收口 `push_chunk`，cargo 73 passed；生效需对 KB **重建索引**）；**#2 幽灵产物去重 ✅**（`resolve_artifact_entries`+`physical_key` 按物理文件去重、真实来源优先，cargo 78 passed）→ 🔲 **#1 intent 空响应**（`intent.rs:97` 已两次复现，空 content 降级 COMPOSITE_TASK 误走规划+写文件）→ 🔲 **#4 = K3-4**
  - **K3-2 任务级引用汇总 ⬜** / **K3-3 标签云+标签筛选 ⬜** / **K3-4 上下文成本优化 ⬜**（Q1 实证：事实问答 5 轮 prompt 50096 tokens，历史 hits 全量回带）

## 待办主线（非 K 系列）
- 20260919002 单 Agent 后台运行/多任务隔离（run lock 全局→per-agent+并发上限+TaskManager）🔲
- 20260919001 小分队整体打磨（依赖 002 底座）🔲
- 第三期收尾挂起：D06 沙箱 unmatched ')' 真因 / D08 skill 全文注入 24-45K/轮结构优化
