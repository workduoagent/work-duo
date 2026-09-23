# work-duo 长期约定（单一事实源 · 校准 2026-09-23 晚）

> 逐日细节留 `2026-*.md`；需求跟踪=仓库根《需求与问题跟踪-汇总.md》。**🔴 红线：`.wd_mem/**` 与 `.workbuddy/memory/**` 绝不进用户可见 UI / present_files。**## 技术栈 / 构建铁律
- React19+TS+Vite+Tauri2；antd v5 经 `@/components/ui` 封装禁裸用；Sass 只 `var(--color-*)`；lucide-react；HashRouter；执行图=@xyflow/react v12。**只跑 `node node_modules/typescript/bin/tsc --noEmit`**，禁 vite build。前端铁律：hover 禁位移缩放；表单 autoComplete=off；useNotify 禁静态 message；HITL 决策在 DecisionCenter；fixed 弹层 createPortal。
- **🔴 Rust 改动必须重启 App 才生效**；改完 *.rs 的验证排在重启后。
- 依赖：AI 只写 package.json 不装；重型前端库动态 import()+shims.d.ts。
- SQLite workduo.db；TS 访问层 src/core/mapper/*（禁组件直写 SQL）；DDL 单一事实源 src/assets/sql/{init,updater}.sql，**DDL 变更必查 mapper 三要素**。**Agent 表=`agent_info`**（llm_id 外键），Rust 只 SELECT，写入=前端 agent-mapper.ts；MCP `agent_ui_*` 可自助建 Agent（无人值守须 isActive/autoToolExecMode/allowSandbox=true+planAutoApproveMode='never'+memoryMode）。
- cargo 沙箱自验：source ~/.workbuddy/msvc-env.sh && CARGO_TARGET_DIR=target-sb cargo test/check。

## 内建 MCP（72 工具）
- 127.0.0.1:18755/mcp（Streamable HTTP）：引擎 11+发现 7+UI 意图 54。**每模块必有 *_list**；UI 回包 {ok,data} 信封；agent_get_run_trace 外层 {"trace":{…}} 须先剥；#8 per-run（get 必传 run_id）。前端桥 mcpBridge.ts；连接器 ~/.workbuddy/mcp.json→workduo-mcp(type:http)。

## 反复踩坑铁律（必背）
- Rust 截断 chars()；多行注入 Edit 逐点禁批替换；风险分级必配误伤回归；消费端追到 JSX props；定时器 cleanup 两步；熔断必过客观校验；**机制正确≠结果正确，验收核对业务产物**；日志 clip 禁入用户正文。
- **Glob 坑**：绝对路径当 pattern 假阴性，须 path+相对 pattern。get_run_logs：since_ts 本地空格串；跨天只读当天文件；event 洪流 limit:8000。bash 缺 head/cp/ls 走 node 替代。**agent 沙箱禁 node 派生进程**（EBUSY）——判分类「dump→外层 bash→merge」三段式。

## L2 生态测评（2026-09-23 全线闭环，18 commit：61da2bc…778c952）
- 证据 `docs/eval-results/2026-09-23/`（scorecard.md 含 Batch C 判分区）；驱动 `l2_eval_harness.mjs`（CLI：run/inject/judge-dump/judge-merge/score；槽位感知=caseId 前缀最新 JSON）。
- **改进报告全清**：P0-1 预算 1800s+软窗口；P0-2 失败写 reply+文件表；P1-2 取消三态+no_pending；P1-1 xlsx/png 模板+产物契约；P2 五项（expectedArtifacts/HTTP 重试+错误分类/进度工具/skill_upsert 冲突/并行=多 Agent）。
- **回归战绩**：12 个原失败用例 12/12 done、产物 100%；A-M2 3/3；F-1/F-4 全过。方法论：**「堆中间品不交最终件」收尾清单无效，改落盘时机才有效**（骨架先行+增量回写）。
- **Batch C（SWE-bench-lite 雏形）**：C1 seeds/ 种子包体系（manifest：tier/targetDir/testCmd/prompt/artifacts），7 包三级；C2 客观判分（venv pytest，resolved=全绿）；C3 首张评分卡 **resolved 6/6=100%**。C-H1 挖出引擎真根因：**熔断强制总结「暂定完成」吞掉修复型重试**（有文件写入→转失败回灌）+ 工具轮分级（基线 8/修复+8，WD_SUBTASK_MAX_ITERATIONS）。
- 自愈实证：B-H5 step_retrying×4 → 技术栈锁定后 371s 全绿。
- chat 模型：DeepSeek-V4.1-Flash（主力）/GLM-5.3-Flash/MiniMax-M3；gpt-5.6-luna 嫌疑不用；Qwen3.6 已移除。

## 战略 / 长期约定
- **筑基战略（用户定调）**：先打牢单 Agent（可控/可观测/可兜底），多 Agent（小分队）推迟验收；对标只用共同地基不追 SWE-bench。
- **Harness=L2 边界防御**：真机实测；缺口回流 SKILL+MCP 层，**严禁绕过 MCP 写一次性脚本**。孤儿清扫已上线（agent_sweep_orphan_rounds）。
- **超时铁律**：判据用「无产出静默时长」非总耗时；慢≠死（模型间 15 倍差）；三层=调用级 180s+收尾 30s+run 级兜底；env 可调（WD_LLM_*/WD_RUN_MAX_SECS/WD_SUBTASK_*），改后重启。
- **Skill 同步铁律**：docs/skills/<name>/ 单一事实源，客户端 ~/.workbuddy 同步一致（node cpdir+MD5 校验）；SKILL 禁第三方产品路径，资源只指 skill 内相对路径。
- 历史里程碑（细节见日志）：第三期记忆检索 ✅；K 系列 ✅；E2E 审计 100/100；多任务隔离 ✅；小分队打磨推迟。
