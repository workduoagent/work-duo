# work-duo 长期约定（单一事实源 · 校准 2026-09-18）

> 与每日日志冲突以本文件为准；逐日细节留 `2026-*.md`。需求单一事实源=仓库根 `需求与问题跟踪-第二期.md`（✅已收口）与 `需求与问题跟踪-第三期.md`（当前主战场）。前端规范见《前端开发规范.md》。**🔴 红线：`.wd_mem/**` 与 `.workbuddy/memory/**` 绝不进用户可见 UI / present_files。**

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；Sass 只用 `var(--color-*)`；lucide-react 图标；路由=HashRouter；Squad/执行图=`@xyflow/react` v12。**只跑 `node node_modules/typescript/bin/tsc --noEmit`**（bash 缺 coreutils，npm 生命周期脚本报错），禁 `vite build`；调试 `npm run tauri`；勿改 `vite.config.ts`。

## 依赖 / 沙箱 / DDL
- AI 只写 `package.json` 不自己装；重型前端库动态 `import()`+`shims.d.ts` 兜底；`src/` 删除/改名 EPERM→新建+改 import，旧文件用户手动删。
- SQLite `workduo.db`；TS 访问层 `src/core/mapper/*`（禁组件直写 SQL）；DDL 单一事实源 `src/assets/sql/init.sql`+`updater.sql`（当前版本 **v26**：v25=vector_path 种子，v26=agent_conversation_round.segments_json 交错时间线持久化）。**DDL 变更必查 mapper 三要素**（列/`?`/参数数对齐）。
- Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→sqlx(0.8)，key=`sqlite:workduo.db`。
- **cargo 沙箱自验**：`source ~/.workbuddy/msvc-env.sh && CARGO_TARGET_DIR=target-sb cargo test/check`（target-sb 已 gitignore；与用户 dev 的 target/ 隔离防锁冲突）。

## 架构分层铁律
- L0 `src-tauri/src/agent/**`=ReAct 引擎（意图→规划→执行→校验），禁内置领域能力；L2 领域区分唯一通道=Skill+MCP+Plugin+Agent 人设；约束落 `register_native_tools`，仅写 prompt 必被绕过。
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（invoke 包 `input`/`decision`）；流水线意图分流→SIMPLE_CHAT/COMPOSITE→DAG 规划→执行；`try_acquire_run_lock()` 唯一互斥闸门；消息序列配对 sanitize（否则网关 400）；**run_task 启动重置清单必须含 plan_approval.reset()+approval_grants.reset()**。
- 边审批策略（15007）：`policy.rs` 5 类危险信号×操作；三闸防疲劳=计划批准一次授权 grants/执行期只拦计划外/「本任务内记住」；**策略评估无条件化**（Exec 边按 code 内容行扫描）；never=留痕不弹卡。沙箱内部操作策略不可见（v1 边界）。
- 统一实体图（graph.rs，`.wd_mem/graph/`）：图=运行时模型=持久化；回复聚合只读 TaskNode `success_criteria.target` 禁读模型 summary。

## 前端铁律
UI 令牌只 `var(--color-*)`；hover 禁位移/缩放；表单 `autoComplete="off"`；`useNotify()`（@/components/ui/notify）禁静态 message；**新建组件带 scss 时 import 必须同轮落**（AppearanceModal 坑）；表单自动行为宁静默，状态用字段级 icon+Tooltip；HITL 四类决策在右栏「处置」DecisionCenter（Notification 已退役）；fixed 弹层 createPortal 到 body（transform 祖先致漂移）；**多行代码注入一律 Edit 工具逐点做，禁 node 脚本批量替换**（续行符失效/声明挤进 // 注释两次事故，setSegments 从未执行致渲染吞工具行）；**关键词子串做风险分级必须配误伤回归测试**（RISK_HINTS 坑）。

## 进度快照（2026-09-18）
- **第二期 ✅ 全部收口**（15001-15015+20260917001/002，含 15007 边审批、15005 拆分核验、HITL 处置中心），细节见跟踪文件。
- **#20260916001 插件 ✅ 完结入库**（custom__ 工具/exit42 自愈/@提及/工具条胶囊）。
- **Pixel Agent ✅ 完结入库（commit c2faa66）**：32×32 游戏级形象设计器（性别级联外观模型 v2/表情状态驱动/opacity 两帧动效/快照写 logo/外观弹窗 v3 三栏）；DDL `agent_info.appearance`（updater v24）；parse 层做 schema 迁移。
- **意图分类 reasoning 返空已根治**（content 空→reasoning 字段回填，M0 顺带）。

## 当前主战场：第三期 记忆与知识统一检索
单一事实源=`需求与问题跟踪-第三期.md`；设计稿=`docs/memory-system-design.md` v2.0（已拍板）。
- **已拍板架构**：向量库=**统一 LanceDB**（否决 SQLite BLOB；SQLite 只存业务元数据/ref_count）；数据目录 `vector_path` 默认 `$APPDATA/.vectors` 可迁移；嵌入/重排外接 LLM 模块（models 表 embedding/rerank 分类，协议探测见 modelTest.ts）；降级链=**向量→关键词(2-gram)→ref_count**；向量域表 memories/artifacts/kb_chunks/session_summaries。
- **M0 护栏 ✅（#20260918001 真机验收 via MiniMax M3）**：`validate_forced_entry`（key≥2/content≥10/模板黑名单/category 强校验）+`anchor_memory.auto_merge`（find_similar_memory 去噪）+`recall_top_memories` 加 prompt+char_bigrams/overlap_score 重排；9 单测（42 全绿）。gemma4:e4b 提炼能力不足=已知限制。
- **M1 #20260918002 嵌入+LanceDB 基建 ✅（2026-09-18，49 单测全绿）**：`agent/embedding.rs`（双协议+探测+埋点+rerank 骨架）+ `agent/vector_store.rs`（LanceDB 四表/upsert merge/search only_if 过滤/全局懒连接降级）+ `vector_path` 设置行（专用迁移重连命令）。**上游坑：lancedb 0.38/0.39 默认 features 编不过（Error::Http 在 remote 门内），必须 features=["remote"]**。
- **M1 #20260918003 召回管道化 ✅（2026-09-18，51 单测全绿，真机闭环验证）**：写路径收口 `memory::anchor_memory`（spawn 异步嵌入 upsert，三出口零改动）；召回三级链=向量（scope+agent 谓词）→关键词 2-gram 兜底补齐→ref_count；`load_config` 加 `prompt: Option<String>`；delete 双删。向量文本=key\n+content，scope="agent"。
- **M1 #20260918004 语义召回状态/统计/回填 ✅（2026-09-18，51 单测全绿，真机验收通过）**：MemoryPalace 顶部状态条（能力/连接/统计/回填按钮+进度）；`vector_status` 扩展 stats；`backfill_memory_vectors` 命令（批量 16 条嵌入+逐批 upsert 幂等=存量补齐+换模型重算双场景，agent-memory-backfill 进度事件，重入保护）。
- **🔴 #20260918002B 三轮真机五连热修 ✅（2026-09-18，51 单测全绿）**：①超轮兜底 summary 术语外泄→友好化（有文件拼「已生成/更新 X」）；②轨迹面板挤压→agent-chat__right 悬浮化（absolute + --right-w 变量 + rightWidth 自适应 clamp）；③TokenRing 1101% 误报→双口径（环=最近一轮输入/窗口，累计单列；压缩正常=阈值 5 轮未达）；④图闪失→换幕延迟 plan_generated（run 不清轨迹数据）；⑤锚定缺条（模型只写 .wd_mem 文件 0 次 anchor 调用）→planner 记忆沉淀约定 + 提炼器补料（PipelineResult.wd_mem_notes）。教训：内部机制术语绝不进用户文案；换幕/清空时机必须对齐用户心理模型；记忆双轨（wd_mem 文件 + anchor 结构化）需显式引导。
- **🔴 P0 panic 热修 ✅（2026-09-18 17:22）**：`tool_command()`（runtime.rs:813）对超 800 **字节**的 args JSON 做 `&full[..800]` 字节切片，中文多字节字符边界 panic → tokio worker 死亡 → 任务静默卡死（anchor_memory 超长中文 content 首次触发阈值）。修复=chars() 字符安全截断 + 全模块扫描零残留。**铁律：Rust 字符串截断一律 chars()，&s[..n] 仅纯 ASCII 可用**。教训：机制正确≠结果正确，验收必须核对业务产物。
- **M2 #20260918005 rerank 精排 ✅（2026-09-18，51 单测全绿）**：`recall_top_memories` 管道=向量粗排 k×4→关键词补齐→rerank 精排取 k（可选级未配置/失败跳过）→bump；`bump_stats` 泛化键（embedding_*/rerank_*）；精排生效打 info 顺序对比（key 明文）。**#20260918011 reasoning 流式打字机展示已登记待办**（emit_thinking_chunk 链路已齐，缺 SSE 增量推送+节流）。→ 下一步 M2 #20260918006 artifacts 入 Lance。
- **M2 #20260918006 artifacts 入 Lance ✅（2026-09-18/19，59 单测全绿，真机验收闭环）**：新模块 `agent/artifact_index.rs`（md 标题分节切块 6 单测/DefaultHasher 文件级 digest 增量/同步管道）+ vector_store 泛化三能力（upsert_artifacts/search_artifacts 带内容列/query_artifact_file_digest 无向量条件查询）+ **三写钩子全覆盖**（archive_artifact/write_file/edit_file 均改持 AppHandle + is_artifacts_md_rel 前缀判断）+ load_config top-3 片段注入（filter=workspace，与记忆宫殿解耦 off 仍注入）。真机闭环：edit 追加 → artifacts 表 dim=512 建表 → 13 分节索引 → 新会话问设计决策 → `已注入 .wd_mem/artifacts 相关知识片段`（rerank 005 同场验证）。真机揪出两 bug：①query_artifact_file_digest 表不存在返回 Err（实现与「Ok(None) 走全量写入」设计不符，新库首归档必断）→ 先 table_names 查存在性；②edit_file 漏钩子 → 补齐。**教训：lazy 建表基建「先查后写」前置查询必须把表不存在当空结果；写入类工具全覆盖 write/edit/archive 三兄弟都要钩**。隔离键=workspace 路径；删除钩子不适用（.wd_mem 受保护）。
- **M3 #20260918007 会话压缩蒸馏 ✅（2026-09-19 凌晨，cargo 63 passed + tsc 0E，待真机验收）**：DDL **v27** `agent_memory_candidates`（pending/confirmed/rejected）+ 压缩 prompt 追加「### Memory Candidates」第二产出段 + `parse_compaction_output` 纯函数（摘要剥离候选段，4 单测）+ 落库分流（off 不产 / forced 直接 anchor auto_merge 转入 / active 落 pending 防 key 重复堆积）+ 命令三件套 list/confirm/reject（confirm 走 auto_merge）+ MemoryPalace「待确认」区（agent-context-compacted 事件顺带刷新）。settle 管任务级、蒸馏管会话级互补。下一步 K1 #20260918008 知识库 RAG。
- **🔴 #20260918001B 真机热修 + 烧钱审计 ✅（2026-09-18，二轮回归 ¥0.5/-77% 验证通过）**：超轮(8)熔断误判→never 重试风暴烧 210 万 token。修复=pipeline 熔断先跑 verifier 客观校验通过即闭环；run_python_sandbox script_path 路径同款注入 WORKSPACE；RunDagCanvas fitView 信号改 planSteps.length。二次审计五连修：LLM 重试 4xx 不重试（仅 408/429/5xx/网络）、prior_summary 尾部裁 6000、同因失败 failSig 止损、诊断回灌 clip 800、forced_settle 输入裁剪。二轮回归新增：planner 规则「单步 ≤5 文件」粒度约束（大步骤撞轮预算根因）、Node 沙箱 script_path 同款注入（缺口已闭合）。**M1 003 真机全链路闭环确认**（向量检索→召回注入→锚定去重→向量回写）。教训：熔断判定必须过客观校验；沙箱双路径行为必须一致；reasoning 模型跑工具任务 output 大头是思考 tokens（用户可关）。
- **🔴 #20260918003B 外部评审批次 ✅（2026-09-18，53 单测）**：外部评审（缺陷 D01-D13）核心差距=只验证机制链路未验证交付质量（pytest 实败=弱 criteria 假绿）。落地：verifier evidence 可回放（passed_notes 明细）；熔断验收分级（存在性→verified=false 暂定+人工复核提示，行为级才 true）；future-safe 注入 helper `inject_workspace_line`（四通道全切，治 __future__ SyntaxError=此前 WORKSPACE 修复引入的缺陷）；planner 行为级验收必选+recon 契约+禁重复侦察+单步≤5 文件粒度约束；沙箱语法错误附落盘脚本头预览。挂起：D06 真因（unmatched-)）、D08 skill 全文注入膨胀（24-45K/轮）结构优化排期。教训：机制正确≠结果正确，验收必须核对业务产物。
- **🔴 #20260918004B 审批风暴根因修复 ✅（2026-09-18）**：merge_json 用例弹卡 13 次，根因=**intent.rs RISK_HINTS 子串误伤**（「override 整体覆盖」命中「覆盖」→risk=high→强制人工审批压过 auto_exec；用户是对的，UI 全开，我错误归因到用户开关）。修复=词表收窄为低误伤高置信破坏词（删除文件/rm -rf/drop table/清空数据库/付款转账等）+新增误伤/命中双回归测试（53 单测）。教训：关键词子串做风险分级必须配误伤回归测试；归因错误前必须先核对代码链路（effective_auto_exec 覆盖逻辑）。
- **消息流时间线重构 ✅（2026-09-18，DDL v26）**：交错时间线 `ChatSegment[]`（text|tool|thought 按**到达顺序**，tool_started 占位段经 callId 回查 toolSteps，旁白+工具段同批相邻入列）；运行中全展开，任务结束收进「思考与执行过程」ProcessCollapse（live 区去独立 ThoughtPanel）；MessageActions 加复制完整记录（单条 Markdown 导出 thought/tool 穿插）；终态聚合改「产物行+summary clip500」双段+skipped 带标题建议；**TokenRing 二次修正=新事件 `agent-llm-usage`**（单次请求 prompt/completion，流式发非流式不发）作真实窗口口径（上轮任务级累计口径仍错，用户抓包抓出 713%）；旧消息无 segments 走旧渲染兼容。教训：ChatSegment kind 枚举扩展同步渲染/导出两处 switch；AgentSessionState 显式接口加字段必须同步（三次踩）。
- 收口标准：cargo test + tsc + 真机验收路径写回跟踪文件。
