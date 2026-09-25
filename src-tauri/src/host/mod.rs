//! 服务器托管（Host）管理面（设计稿 docs/server-hosting-design.md）。
//!
//! 本模块只承担**管理面**职责：服务器档案 CRUD、凭证加密保管、测试连接。
//! Agent 工具面（`host__*` 工具 + HostAuthz + 连接池）在后续切片接入，
//! 接入点为 `register_host_tools`（零改动 `native.rs`）。
//!
//! 凭证边界：明文仅在「用户输入 → 加密入库」与「解密后即用即弃」两个瞬间存在于内存，
//! 任何列表 / 详情 / 审批 / 日志均只返回指纹 hint，不回传明文。

pub mod authz;
pub mod commands;
pub mod credential;
pub mod exec;
pub mod policy;
pub mod pool;
pub mod sftp;
pub mod tools;
pub mod transport;
pub mod types;

use std::sync::Arc;
use tauri::AppHandle;
use crate::agent::engine::tools::ToolRegistry;

/// 注册 `host__*` 工具族（12 个）：仅当智能体绑定了服务器时调用（提示与能力同源）。
/// 内部持有 Arc<HostPool>（连接池托管）并统一走 HostAuthz 独立授权域。零改动 native.rs。
pub fn register_host_tools(registry: &mut ToolRegistry, app: &AppHandle, bindings: Arc<Vec<types::ServerBinding>>) {
    if bindings.is_empty() {
        return;
    }
    let _ = pool::global(); // 初始化连接池（含空闲 reaper）
    tools::register_host_tools_into(registry, app, bindings);
}
