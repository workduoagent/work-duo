//! 智能体运行时模块（Agent Runtime）。
//!
//! 对应方案《Tauri2 客户端 Agent 设计方案》步骤 1~6 的 Rust 后端：
//!  - `tools`：工具契约（AgentTool / ToolError / PermissionLevel / ToolRegistry）+ PathGuard 沙箱守卫；
//!  - `native`：系统原生工具（read_file / edit_file / write_file / list_directory / execute_command / 沙箱）；
//!  - `runtime`：ReAct while 循环调度引擎（含 Token 滑动窗口裁剪、熔断、事件推送）；
//!  - `approval`：高危操作人机审批（oneshot 通道零死锁挂起）；
//!  - `provider`：统一扩展工具中枢（Registry-Provider 模式，聚合 Native/Skill/MCP）；
//!  - `skill_adapter` / `mcp_adapter`：已有生态的适配封装；
//!  - `events` / `types`：前后端事件契约类型。
//!
//! 设计原则（与项目约定一致）：
//!  1. 客户端不做本地重推理：LLM 一律走云端 OpenAI 兼容 API（plugin-http 绕 CORS）；
//!  2. 重型原生依赖谨慎引入：MCP 适配器复用现有 `mcp::call_mcp_tool` 的 HTTP/SSE 通路，
//!     不引入 stdio 子进程管理库（沙箱不可端到端验证，先做小增量）；
//!  3. 沙箱执行（Python）复用 `mamba_manager` 的 micromamba sidecar，不新建运行时。

pub mod approval;
pub mod artifacts;
pub mod choice;
pub mod commands;
pub mod context;
pub mod round_compactor;
pub mod events;
pub mod graph;
pub mod intent;
pub mod memory;
pub mod native;
pub mod pipeline;
pub mod planner;
pub mod plan_approval;
pub mod recovery;
pub mod runtime;
pub mod squad_api_server;
pub mod squad_orchestrator;
pub mod squad_scheduler;
pub mod skill_adapter;
pub mod mcp_adapter;
pub mod plugin_adapter;
pub mod plugin_commands;
pub mod plugin_runner;
pub mod tools;
pub mod types;
pub mod verifier;
pub mod wd_mem;
