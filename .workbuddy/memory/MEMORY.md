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
  - **Q1 顺带 4 问题**：**#3 切块噪声 ✅**（`is_noise_chunk` 纯函数收口 `push_chunk`，cargo 73 passed；生效需对 KB **重建索引**）；**#2 幽灵产物去重 ✅**（`resolve_artifact_entries`+`physical_key` 按物理文件去重、真实来源优先，cargo 78 passed）→ **#1 intent 空响应 ✅**（解析失败重试一次 + `fallback()` 信号定向降级（强工具信号→COMPOSITE / 无→SIMPLE_CHAT）+ planner 知识问答降耗约定（纯问答单步检索作答禁写文件），cargo 80 passed）→ **#4 = K3-4 ✅（已收官，见下）**
  - **K3-2 任务级引用汇总 ⬜** / **K3-3 标签云+标签筛选 ⬜** / **K3-4 上下文成本优化 ✅ 收官（2026-09-21 凌晨，8 轮真机复测全绿，cargo 85 passed）**
  - 六项：#1 score 阈值过滤 / #2 seen-chunk 去重+top_k clamp 8 / #3 is_noise_chunk 补强（text「剔除 # 行后有效字数<6」，chunk 90→62 实证，重建索引已做）/ #4 分级裁剪 code-table 1200 / text 300（首检即拿全）/ #5 硬上限 10 blocked（两次实战）/ #6 历史压缩 compact_history_kb_hits（跨轮首调稳定 2.1K）
  - full 重取通路：触发从「fresh 全空」放宽到「存在 score 优于 fresh 的重复命中」（f32）附带 ≤2 完整原文；notice 显式「未截断以此为准」；调色板 18 色值首检即完整、弹窗结构/Picker 分段首次完整作答=三重修复复合效果
  - 模型个别尾注保守（验收/风险「未核对完整原文」但内容已给出）= LLM 注意力边界，工程侧数据通路全通不再追

## WorkDuo 自测闭环（内建 MCP Server）✅ MVP1 跑通
- 架构：WorkDuo 自身即标准 MCP Server（`src-tauri/src/mcp_server.rs`，监听 `127.0.0.1:18755/mcp`，Streamable HTTP）；9 工具=引擎层 4（`agent_run_task`/`agent_get_status`/`agent_wait_task`/`agent_get_run_logs`）+ UI 意图层 5（`agent_ui_create/update/delete/get/list`）。
- 前端零侵入桥 `src/core/mcpBridge.ts`：`listen('mcp:intent')`→真实 `upsertAgent/deleteAgent/getAgent/listAgents`→`invoke('mcp_resolve_result')`；UI 工具回包已瘦身为单条（`slim`），不再透传整表。
- 连接器：`~/.workbuddy/mcp.json`→`workduo-mcp`（HTTP URL）。
- MVP1 验收：sample-case.agent-crud-001 端到端 CRUD 全绿（真实 workduo.db、自清理）；曾发现回包过大（create/update/delete 透传整表 ~100K）→ 已修复为瘦身单条。

## 待办主线（非 K 系列）
- 20260919002 单 Agent 后台运行/多任务隔离（run lock 全局→per-agent+并发上限+TaskManager）🔲
- 20260919001 小分队整体打磨（依赖 002 底座）🔲
- 第三期收尾挂起：D06 沙箱 unmatched ')' 真因 / D08 skill 全文注入 24-45K/轮结构优化
- **客户端生态接入（2026-09-20）**：agent-assembly-guide 装配指南已装 WorkBuddy 客户端用户级 skills；workduo-mcp 已加回 ~/.workbuddy/mcp.json（streamableHttp 127.0.0.1:18755/mcp，需 WorkDuo 运行中+连接器「信任」激活）；内建 MCP 工具面已扩 agent_list_*（models 带 config 列/mcps/mcp_tools/skills/plugins/kbs/scenarios）——自然语言装配智能体走「agent_list_* 拉真实可选集 → agent_ui_create 落库」，llmConfig 必须复制模型 config、行为策略四字段显式赋值（UI 向导 allowSandbox=true vs upsertAgent 兜底 false）、mcpTools 必须落具体 toolId。代码已全部提交入库。
- **K3 引擎侧 MCP 自测闭环 ✅（2026-09-20 晚，三用例全绿）**：首次 agent_list_*→agent_ui_create→agent_run_task→wait→get_run_trace 全链自主驱动。坑：mcpTools 必传空数组、identifier UNIQUE（自测带后缀）。实证：kb_search 溯源字段完整（K3-1 引用卡数据源通）、收敛护栏 14 次检索自然收敛不熔断、否定测试零编造。K3a 候选：无关查询最近邻 score>1.0 vs 相关<0.95，可加阈值过滤助判「无相关」。
- **K3-4 优化包 1-4 ✅（2026-09-20 晚，cargo 81 passed）**：kb_search score 阈值 1.0 过滤（bge-small-zh 标定，换嵌入模型需重标）、top_k clamp 8、seen-chunk 任务内去重（全重复→收敛 notice）、裁剪分级 600/300。**用户长期约定：SKILL+MCP 拿不到有效信息时第一时间报告做更新/补丁**。
- **K3-4 复验通过 + 半写入修复 ✅（2026-09-20 深夜）**：去重/clamp/裁剪/token(-55%) 全实证；混合长查询距离收缩致 score 阈值对长查询失效（观察项）。#20260920001 upsertAgent 半写入修复（数组归一化前置）。硬删实证：delete 后同 identifier 可重建。留档：kb-selftest-r2 + 会话 109333a6 供抽查，勿删。
- **K3-4 #5+#6 ✅（2026-09-20 深夜，cargo 84 passed）**：护栏硬化（硬上限 10 次短路拒绝执行）+ 历史 hits 压缩（round_compactor compact_history_kb_hits，只压 SIMPLE_CHAT 历史轮的 kb_search tool 结果为 id+位置+score 摘要，COMPOSITE 跨轮回填本就精简；最近一轮保留）。**K3-4 六项优化全部完成**。
- **轮 4 复测 + full 通路修复 ✅（2026-09-20 深夜）**：#5 blocked 实战（durationMs=0）、#6 历史压缩实证（跨轮首调 prompt 不涨）；新死角=超长 chunk（~700 字）被 600 裁剪腰斩且去重/硬上限堵死重取 → kb_search 加 full 参数，全重复重检返回完整原文（4000 上限）。**教训：裁剪上限<chunk 实际长度+去重叠加=信息永久不可达，组合优化必须留「重取原文」通路**。
- **轮 5 终验 ✅（2026-09-20 深夜）**：#5/#6/full 通路机制全绿；「检索结果不足」根因升级为模型被「重复检索」标签带偏（数据已送达但模型不转录）→ full 通路 notice 改为显式声明「未截断完整原文，以此为准」。**遗留：KB 索引未重建，#3 噪声过滤未生效（「内部：」类碎片仍占命中位）——下次会话建议先重建 KB 索引再复测一轮**。
- **轮 6 复测：K3-4 主验收 PASS ✅（2026-09-20 深夜）**：18 色值完整转录（检索结果不足消失）、full notice 生效且模型采纳、blocked 二次实战、跨轮压缩稳定 2.1K。#3 规则盲区补强=is_noise_chunk(text)「剔除 # 标题行后有效字数<6」，table/code 豁免；**生效需重启+再次重建 KB 索引**。模型对部分章节（弹窗结构/风险）仍保守属 LLM 注意力边界，数据已全量送达不再追。
- **轮 7：#3 生效实证 + full 通路死角闭合 ✅（2026-09-21 凌晨，cargo 85 passed）**：噪声块全消失（chunk 90→62）；full 通路触发条件从「fresh 全空」放宽到「存在 score 优于 fresh 的重复命中」（f32）附带 ≤2 个完整原文；code/table 裁剪 600→1200 首检即拿全。**生效只需重启**。
- **轮 8 终验：K3-4 全链路验收 PASS ✅（2026-09-21 凌晨）**：调色板 18 色值首检即完整（1200 裁剪）、score 判据 full 附带实战 3 次、弹窗结构/Picker 分段两个历史难点章节首次完整作答（噪声过滤+裁剪+附带三重修复复合效果）。K3-4 收官；模型个别尾注保守属 LLM 边界不再追。下一步：K3-2（任务级引用汇总）/ K3-3（标签云）/ 20260919002（多任务隔离）。
