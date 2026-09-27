//! 智能体运行时模块（Agent Runtime）——按业务域分层。
//!
//! 目录约定（对齐 Java/前端分域习惯，两层封顶）：
//!  - `engine/`   执行引擎主链路：runtime（ReAct 调度）/ pipeline（DAG 流水线）/ planner（规划）
//!                / intent（意图）/ context（上下文）/ tools + native（工具契约与原生工具）
//!                / policy（风险策略）/ verifier（客观校验）/ graph（执行图）/ round_compactor（会话压缩）；
//!  - `hitl/`     人机门禁：approval（高危审批）/ plan_approval（计划审批）/ choice（方案选择）
//!                / recovery（步骤恢复）；
//!  - `knowledge/` 知识与记忆：knowledge（KB 检索）/ vector_store / embedding / memory（记忆宫殿）
//!                / wd_mem（工作空间记忆）；
//!  - `artifact/`  产物：artifacts（登记与展示）/ artifact_index（索引检索）；
//!  - `plugins/`   扩展生态：plugin_runner / plugin_commands / plugin_adapter
//!                / mcp_adapter / skill_adapter；
//!  - `squad/`     小分队（多智能体）：squad_orchestrator / squad_scheduler / squad_api_server；
//!  - `host/`（与 agent 平级）服务器托管：host__* 工具 + HostAuthz 独立授权域。
//!
//! 横切共享（保持在本层直下，不进子域）：
//!  - `types`：前后端事件契约与共享类型（全域引用）；
//!  - `events`：事件发射总线（全域引用）；
//!  - `commands`：Tauri 接口层（lib.rs generate_handler 注册入口）。
//!
//! 设计原则（与项目约定一致）：
//!  1. 客户端不做本地重推理：LLM 一律走云端 OpenAI 兼容 API（plugin-http 绕 CORS）；
//!  2. 重型原生依赖谨慎引入：MCP 适配器复用现有 `mcp::call_mcp_tool` 的 HTTP/SSE 通路，
//!     不引入 stdio 子进程管理库（沙箱不可端到端验证，先做小增量）；
//!  3. 沙箱执行（Python）复用 `mamba_manager` 的 micromamba sidecar，不新建运行时。

pub mod artifact;
pub mod commands;
pub mod delivery;
pub mod engine;
pub mod events;
pub mod hitl;
pub mod knowledge;
pub mod plugins;
pub mod squad;
pub mod types;
