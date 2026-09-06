# Work Duo

> 一个基于 **Tauri 2 + React 19** 的桌面端「智能体（Agent）工作台」。把 LLM 模型管理、智能体编排、MCP / Skill 生态、知识库、Python 沙箱与长期记忆沉淀整合在同一个本地优先（local-first）的客户端里——**所有推理走云端 API，所有数据与产物留在本机**。

---

## 一、项目架构与技术栈

### 1.1 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  表现层（React 19 + TypeScript + Vite + antd v5）                    │
│  - 页面（pages/*）、组件（components/ui 封装层）、状态（Redux Toolkit）│
│  - 通过 @tauri-apps/api invoke 调用后端命令；listen 订阅引擎事件流   │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  Tauri IPC（命令 + 事件，二进制通道）
┌───────────────────────────────┴─────────────────────────────────────┐
│  桌面壳（Rust / Tauri 2）                                            │
│  - lib.rs：应用入口、命令注册（generate_handler!）、Capability 校验  │
│  - agent/*：智能体分层执行引擎（意图 → 规划 → 流水线）               │
│  - mcp.rs / mamba_manager.rs / fs_helper.rs：生态适配与系统桥接      │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │
        ┌────────────────────────┼───────────────────────────────┐
        ▼                        ▼                                ▼
  云端 LLM API            本地 SQLite（workduo.db）       本机文件系统（.wd_mem/）
  （OpenAI 兼容 /            （app_config / models /        （产物、记忆、会话摘要，
   讯飞 WS 签名）             mcp_info / agent_* /            PathGuard 沙箱边界）
                               knowledge_base /               ┌──────────────┐
                               agent_memories …）             │ micromamba   │
                                                             │ Python 沙箱   │
                                                             └──────────────┘
```

### 1.2 技术栈总览

| 层 | 技术 | 说明 |
|---|---|---|
| 前端框架 | React 19 + TypeScript + Vite 7 | UI = antd v5（经 `@/components/ui` 封装，禁裸用）；样式 = Sass（仅用 `var(--color-*)` 设计令牌） |
| 图标 | lucide-react | 全量图标；模型厂商 logo 在 `src/assets/images` |
| 状态管理 | Redux Toolkit + react-redux | 全局主题/配置/记忆等切片 |
| 路由 | react-router-dom v7（HashRouter） | 见 `src/core/router/paths.ts` |
| 编辑器 | Monaco（本地 AMD 加载） | 代码编辑、JSON 配置 |
| 文档阅读 | pdfjs + @react-pdf-viewer、docx-preview、react-reader(EPUB)、video.js + wavesurfer、xlsx + ag-grid、react-markdown + katex + mermaid | 多格式内容查看器 |
| 桌面壳 | Tauri 2 | Rust 二进制 IPC；窗口/对话框/文件系统/SQL/Shell 插件 |
| 后端语言 | Rust 2021 + tokio | 异步运行时 |
| 数据访问 | sqlx 0.8（sqlite + runtime-tokio）+ tauri-plugin-sql | 经 `tauri_plugin_sql::DbInstances` 取连接池 |
| HTTP/CORS | tauri-plugin-http + reqwest | 云端 LLM 调用（绕浏览器 CORS） |
| 沙箱 | micromamba（sidecar 子进程） | Python 运行环境，白名单包管理 |
| 构建 | pnpm（前端）/ cargo（后端） | 前端只跑 `npm run typecheck`，不手动 `vite build` |

### 1.3 关键架构决策（红线）

1. **客户端不做本地重推理**：LLM / embedding / 重排一律走云端 API；本地只做编排、调用、持久化。
2. **能力层单一事实源**：工具是否可用由 `register_native_tools` 的集合决定，并同时驱动 system_prompt 分支；仅写在 prompt 里的约束会被模型绕过。
3. **沙箱隔离**：原生命令（文件读写、命令执行）受 `PathGuard` 沙箱边界约束；沙箱开启时宿主命令（git/npm/curl）不可注册，避免模型逃逸到系统。
4. **事件驱动**：引擎每轮只发 1 次流式 `call_llm_stream`，聚合为 `StreamOutcome` 经 Tauri 事件推给前端；无 tool_calls 即终态，有则进入「思考面板」。
5. **消息序列不变量**：每条 `tool_call.id` 必有对应结果；发送前与落库前各调一次 `sanitize_message_sequence` 自检自愈，否则网关 400「tool id not found」。

---

## 二、项目目录设计

### 2.1 顶层目录

| 路径 | 说明 |
|---|---|
| `src/` | 前端源码（React/TS） |
| `src-tauri/` | Rust 后端（Tauri 2 应用） |
| `docs/` | 架构与方案文档（`Agent引擎架构与执行逻辑.md`、`Work_Duo_Agent_Runtime_2.0_架构优化方案.md`、`WorkDuo_Agent_UI_优化与创新方案（K3）.md`） |
| `前端开发规范.md` | 前端 UI/工程铁律（设计令牌、表单、命名等），新页面必读 |
| `Agent流程设计.md` | Agent 流程早期设计稿 |
| `vite.config.ts` / `tsconfig.json` | 前端构建与类型配置 |
| `package.json` / `pnpm-lock.yaml` | 前端依赖（依赖只写此处，安装由你 `pnpm i`） |

### 2.2 前端 `src/` 结构（按职责）

| 目录 | 说明 |
|---|---|
| `src/App.tsx` `main.tsx` | 应用根、Redux Provider、路由挂载 |
| `src/pages/` | **业务页面**（每个功能一个目录，见 §三） |
| `src/components/` | 共享组件：`ui`（antd 封装层）、`layout`（TopBar/AppLayout）、`markdown`、`code-editor`(Monaco)、`MultiFileViewer`、`flow`、`export`、`model`、`scenario`、`icons` |
| `src/core/` | 核心层：`router`（路由/paths）、`db`（SqlService）、`mapper`（14 张表的 TS 访问层，禁组件直写 SQL）、`ipc`（commands 封装）、`file`（各配置序列化）、`agent`（chat.ts 会话桥接）、`config`、`contexts`、`store`（Redux） |
| `src/hooks/` | 公共 hooks（主题、`useTauriEvent`） |
| `src/utils/` | 工具（格式化、日志、模型测试、滚动条） |
| `src/types/` | `core.d.ts`（领域类型）、`database.d.ts`（DB Row 类型） |
| `src/assets/` | `sql/`（init.sql + updater.sql，DDL 双轨幂等）、`images/`（厂商 logo）、`animations/` |

### 2.3 后端 `src-tauri/src/agent/` 模块（引擎分层）

| 文件 | 职责 |
|---|---|
| `commands.rs` | 所有 `#[tauri::command]` 入口（run_agent_task / 审批 / 取消 / 记忆 6 命令 / 附件分片 / 归档）；`load_config` 组装运行时配置并注入召回记忆与沉淀引导 |
| `runtime.rs` | 调度引擎：组装 ToolRegistry（原生+Skill+MCP）、驱动三段式链路、Token 窗口裁剪、取消信号链、**记忆模式「强制」档的引擎级后置沉淀 `forced_memory_settle`** |
| `intent.rs` | 意图分流（规则短路 + LLM 轻量分类，失败降级 COMPOSITE），发射 `intent_classified` 事件 |
| `planner.rs` | DAG 规划（`temperature=0` 确定性，≤5 步，失败降级单任务） |
| `pipeline.rs` | 微 ReAct 执行（`MAX_SUBTASK_ITERATIONS=8`，无进展熔断，子任务独立上下文）；支持 `plan_override` / `pre_completed` / `initial_context` 续跑分支 |
| `native.rs` | 原生工具（read/edit/write file、list_dir、execute_command、run_python_sandbox、archive_artifact、**anchor_memory**）+ `ToolRegistry` |
| `tools.rs` | 工具契约（AgentTool / ToolError / PermissionLevel / ToolContext + PathGuard 沙箱） |
| `skill_adapter.rs` `mcp_adapter.rs` | Skill / MCP 生态适配封装 |
| `approval.rs` | 高危操作人机审批（oneshot 通道零死锁） |
| `recovery.rs` | 失败自愈/恢复建议 |
| `verifier.rs` | 产物/结果校验 |
| `artifacts.rs` | 产物归档与读取（`read_artifact` 内容读取 API） |
| `round_compactor.rs` | 上下文压缩（长会话摘要，省 token） |
| `memory.rs` | 记忆读写（list/heatmap/anchor/update/delete/recall + top-K 自动召回 + 分支收敛后发射 `agent-memory-anchored`） |
| `wd_mem.rs` | 工作区记忆双轨（`.wd_mem/` 磁盘态 + 会话摘要） |
| `events.rs` | 前后端事件契约与推送（`intent_classified`、`tool_started/finished`、`plan_generated`、`plan_branch_generated`、`step_*`、`thinking_chunk`、`token_update`、`artifact_created`、`agent-task-done/error`、`memory_recalled`、`memory_anchored`、`context_compacted`） |
| `types.rs` `context.rs` `mod.rs` | 类型定义、上下文、模块装配 |

其余后端：`lib.rs`（入口/命令注册）、`mcp.rs`（MCP 同步与调用）、`mamba_manager.rs`（micromamba 环境/包/脚本执行）、`fs_helper.rs`（路径规范化）、`main.rs`、`build.rs`。

---

## 三、导航与核心功能

> 状态图例：**【已落地】** 可用 / **【占位】** UI 骨架未实现。

### 3.0 导航地图

**顶栏（一级标签栏 + 百宝箱下拉）**

| 顶栏项 | 类型 | 跳转到 |
|---|---|---|
| 百宝箱 | 分组（下拉） | LLM（`/model-settings`）、MCP（`/mcp-hub`）、Skill（`/skill-hub`） |
| 知识库 | 一级 | `/knowledge` |
| 智能体 | 一级 | `/agent-studio` |
| 小分队 | 一级 | `/squads-workspace`（占位） |
| 设置 | 一级 | `/settings` |

**设置页左侧栏（分区切换）**：系统设置 / **记忆宫殿** / 安全中心 / 关于我们 /（沙箱环境 → Python）。

> 顶栏为纯 HTML 实现（不依赖 UI 库），选中滑块令牌化、明暗主题均可读；百宝箱用顶部下拉而非原地钻取变形，避免窄空间内剧烈闪动。

### 3.1 模型管理（LLM，`/model-settings`）【已落地】
- **功能**：配置 LLM 接入（OpenAI 兼容 API + 讯飞 iflytek WS 签名三件套），管理厂商、密钥、默认模型与参数。
- **技术**：`@tauri-apps/plugin-http` 绕 CORS 调云端；`src/core/model/iflytek.ts` 签名；`model-mapper.ts` 持久化到 `models` 表（含 `category` 固定枚举，不进 scenario_category）。

### 3.2 MCP 中心（`/mcp-hub`）【已落地】
- **功能**：管理 MCP 服务器连接，浏览其工具定义（`mcp_tool_definition`），同步并在智能体中调用。
- **技术**：`mcp.rs` 的 `sync_mcp_tools` / `call_mcp_tool`（HTTP/SSE 通路，不引 stdio 子进程）；`mcp-mapper.ts` 持久化。

### 3.3 Skill 中心（`/skill-hub`）【已落地】
- **功能**：管理可复用 Skill（含 `skill_markdown` 文档），挂载到智能体。
- **技术**：`skill_adapter.rs` 适配；列表卡片 + 详情目录树 UI。

### 3.4 知识库（`/knowledge`）【已落地】
- **功能**：知识库条目 + 文件树，多格式内容查看（PDF/图片/Word/EPUB/音视频/表格）。
- **技术**：`MultiFileViewer` 聚合 pdfjs/docx-preview/react-reader/video.js+wavesurfer/xlsx+ag-grid；`knowledge-mapper.ts` 持久化到 `knowledge_base` + `knowledge_asset`。
- **说明**：向量化已移除，客户端不跑本地重推理；检索走云端。

### 3.5 智能体工作室（`/agent-studio`）【已落地 · 核心】
- **功能**：4 步向导创建智能体（基础/模型/MCP/Skill）→ 进入会话运行。运行期支持工具轨迹、规划 DAG、产物画布、分支重跑、审批通知、失败恢复面板。
- **引擎（后端）**：意图分流 → DAG 规划 → 微 ReAct 流水线（`run_agent_task` → `runtime::run_task`）。每轮单流式 LLM、事件推送、无进展熔断、取消信号贯穿。
- **技术**：`useAgentSession.ts` 桥接命令与事件；`TracePanel` / `PlanToolTimeline` / `ToolStepCard` / `ArtifactCanvas` / `ApprovalNotify` / `RecoveryPanel` 渲染引擎事件；会话落 `agent_conversation_session` / `agent_conversation_round`（含 `raw_messages_json`）。
- **使用**：创建智能体 → 「进入会话」→ 输入任务 → 看工具轨迹与产物；高危工具弹审批。

#### 记忆模式开关（创建/编辑智能体时设置，`agent_info.memory_mode`）
三级开关，默认 **关闭**——粒度落在智能体，兼容老数据（存量列缺省回落 `off`）。差异均落在**能力层**（遵循 §1.3 红线），不是纯提示：

| 档位 | 行为 | 能力层 | 提示层 | 流水线末 |
|---|---|---|---|---|
| **关闭（off，默认）** | 完全不记忆 | 不注册 anchor 工具 | 不注入沉淀引导 | 不沉淀 |
| **主动（active）** | 模型自主决定 | 注册 `native__anchor_memory` 工具 | 注入「用原生工具沉淀可复用信息」引导 | 不强制 |
| **强制（forced）** | 每次任务必沉淀 | 注册工具 + 引导 | 同主动 | 引擎级 `forced_memory_settle` 直接落库（确定性，不依赖模型听话） |

### 3.6 智能体编队（`/squads-workspace`）【占位】
- 多智能体协作空间，目前仅骨架，未实现。

### 3.7 Python 沙箱（`/sandbox/python`）【已落地】
- **功能**：在隔离 micromamba 环境运行 Python 脚本，白名单装包、失败自愈（ModuleNotFoundError → `micromamba install` 重试）。
- **技术**：`mamba_manager.rs` sidecar（`shell:allow-execute` 仅放行 `binaries/micromamba`）；`native__run_python_sandbox` 支持 `code` 直传（内部落盘 `.wd_mem/scripts/`，过 PathGuard）。

### 3.8 记忆宫殿（设置 → 记忆宫殿 Tab）【已落地】
- **功能**：智能体「长期记忆」管理台。卡片网格 + GitHub 式召回热力图 + 搜索/分类过滤 + 锚定/编辑/删除 + 详情抽屉；并支持智能体在对话中自动锚定（`native__anchor_memory` 原生工具，ReadSafe 无感沉淀）。
- **技术**：`agent_memories` + `agent_memory_events` 双表；`memory.rs` 含 top-5 自动召回注入 `load_config` 系统提示；`agent-memory-recalled` / `agent-context-compacted` / `agent-memory-anchored` 事件驱动 UI 刷新；非 Tauri 走 mock 回退。
- **实时刷新（已落地）**：锚定（手动按钮或智能体自动沉淀）经 `memory::anchor_memory` 汇流后发射 `agent-memory-anchored`，记忆宫殿页面订阅后**实时 upsert 卡片，无需重开页面**。
- **区分**：「手动锚定」`anchored=true`（钉住）；「自动/强制沉淀」`anchored=false`（仅参与 ref_count 排序）。

### 3.9 运行期可视化能力【已落地】
- **轨迹视图（§3.1）**：智能体会话内完整渲染「意图分类 → 分层思考 → 规划 DAG → 工具时间轴」（`TracePanel` + `useAgentSession` 已接 `intent_classified` / `thinking_chunk` / `plan_branch_generated`）。
- **产物画布（§3.2）**：`ArtifactCanvas` 支持节点拖拽/缩放、点击看产物、`read_artifact` 预览；右键「从此步骤分支」→ 对比横幅 → 「应用分支」**实际重跑**（`run_agent_task` 带 `plan_override` + `pre_completed` + `initial_context`，head 步骤标记完成、仅跑 tail 新分支）。
- **上下文压缩**：`round_compactor.rs` 长会话摘要，发 `agent-context-compacted` 事件（记忆宫殿侧栏呈现轮数/省下 token）。
- **产物归档**：`artifacts.rs` + `native__archive_artifact` → `.wd_mem/artifacts/`。

### 3.10 审批与恢复【已落地】
- **功能**：高危原生工具（如 execute_command）触发 `approval.rs` 人机审批；`recovery.rs` 给出失败恢复建议，前端 `ApprovalNotify` / `RecoveryPanel` 交互。
- **技术**：oneshot 通道零死锁挂起；`submit_approval_decision` / `resolve_subtask` 等命令。

### 3.11 设置（`/settings`）【已落地】
- 左侧分区：系统设置 / **记忆宫殿** / 安全中心 / 关于我们；「沙箱环境」分组含「Python」子项。
- 记忆宫殿 Tab 已完全接管原「记忆存储」（旧休眠功能已清除，记忆能力由 §3.8 的 `agent_memories` 表提供）。

---

## 四、开发与构建（铁律）

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | 前端类型检查（**唯一允许的前端校验**，禁手动 `vite build`） |
| `npm run tauri` | 启动 Tauri 开发（前端 + Rust 联调，invoke 才连后端） |
| `npm run dev` | 仅前端 Vite（非 Tauri 回退，记忆/智能体走 mock） |
| cargo check（指定工具链） | 后端类型检查：`RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/envs/Rust/.cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/envs/Rust/.cargo/bin/cargo check` |

**强制约定**（详见 `前端开发规范.md`）：
- 依赖只写 `package.json`，安装由你 `pnpm i`（AI 不自己装）。
- `src/` 删除/改名通常被沙箱 EPERM 拦截，只能新建合规位置 + 改 import，旧文件你手动删。
- DDL 双轨：`init.sql`（首启幂等）+ `updater.sql`（存量库 ALTER 补齐），二者同步。
- 前端只用 `var(--color-*)`，禁 hex/px 字面量；表单 `autoComplete="off"`；文案禁「中文(English)」混排。
- 全局消息统一 `useNotify()`，禁静态 `import { message }`。

---

## 五、路线图与下一步（供规划参考）

**已完成（前端 + 后端可用）**
- 模型接入、智能体三层引擎、MCP、Skill、知识库多格式查看、Python 沙箱、产物归档、上下文压缩、审批/恢复。
- 记忆宫殿（含自动锚定 + `agent-memory-anchored` 实时刷新）、记忆模式开关三档。
- Phase 3 三视图：轨迹视图（§3.1）、产物画布分支重跑（§3.2）、记忆实时刷新（§3.3）——**均已落地**。

**占位（需从骨架起步）**
- 仪表盘（`/`）、智能体编队（`/squads-workspace`）。

**建议下一步切入方向**
1. 仪表盘从占位到可用（运行概览 / 快捷入口 / 记忆热力总览）。
2. 智能体编队（多智能体协作）从骨架起步。
3. 记忆质量增强：强制档沉淀的「总结非空才落库」护栏细化、自动锚定去噪。

---

> 本文档依据当前代码实际状态梳理（2026-09-06），用于下一步任务规划。具体实现细节以 `src/`、`src-tauri/`、`docs/`、`前端开发规范.md` 为准。
