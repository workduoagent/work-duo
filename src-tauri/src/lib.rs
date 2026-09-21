// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod agent;
mod mcp;
mod mamba_manager;
mod bun_manager;
mod fs_helper;
mod logging;
mod mcp_server;
mod net;

/// 数据迁移后动态授予 fs 权限：把用户迁移到的任意绝对数据目录加入 fs scope。
///
/// 背景：设置里的「数据迁移」会把 skill_path / knowledge_base_path / vector_path 等
/// 改写到默认 Tauri 路径（$APPDATA/$RESOURCE）之外的绝对目录（如 E:\WorkDuo\.skills）。
/// 静态 capability 的 $APPDATA/$RESOURCE 变量无法覆盖这些自定义目录，
/// 导致前端经 @tauri-apps/plugin-fs 写盘（mkdir/write）被 ACL 拒绝。
///
/// 修复：权限授予（fs:allow-mkdir 等）已由静态 default.json 给出，scope 只决定「哪些路径允许」。
/// 本命令在启动时由前端收集实际目录后，调用 tauri-plugin-fs 公开 API
/// `FsExt::fs_scope().allow_directory()` 把目录（含递归子目录）直接加进运行时 scope。
/// 该方法走插件内部 RwLock，运行期调用即可生效，无需 dynamic-acl / 重编 capability。
///
/// 仅接受绝对路径（Windows 盘符或 unix 根），避免把相对/占位路径误注入 scope。
#[tauri::command]
fn grant_fs_scope(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    let mut granted = Vec::new();
    for p in paths {
        let norm = p.replace('\\', "/").trim().trim_end_matches('/').to_string();
        if norm.is_empty() {
            continue;
        }
        let is_abs = norm.starts_with('/')
            || (norm.len() >= 3
                && norm.as_bytes()[1] == b':'
                && (norm.as_bytes()[2] == b'/' || norm.as_bytes()[2] == b'\\'));
        if !is_abs {
            continue;
        }
        if let Err(e) = scope.allow_directory(&norm, true) {
            tracing::warn!(
                "grant_fs_scope: 开放目录 scope 失败 path={} err={}",
                norm,
                e
            );
            continue;
        }
        granted.push(norm);
    }
    if granted.is_empty() {
        return Ok(());
    }
    tracing::info!(
        "grant_fs_scope: 已为 {} 个迁移目录开放 fs scope",
        granted.len()
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 绿色便携运行时管理器：落在 Tauri 资源目录（$RESOURCES）下的 mamba_root / bun_root，交由 Tauri 托管。
    let mamba = mamba_manager::MambaManager::new();
    let bun = bun_manager::BunManager::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build()) // store 插件的初始化稍有不同
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(mamba)
        .manage(bun)
        .manage(agent::runtime::AgentRuntime::new())
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            // 统一日志初始化（必须在任何 tracing 宏调用之前）。
            crate::logging::init_logging(app.handle());
            // 后台静默确保 Agent 默认环境（default）存在；失败仅日志，不阻塞启动。
            // 严格延后：先 await DB 连接池就绪闸门，杜绝启动早期组件未就绪导致的空指针 / 连接断裂。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = agent::round_compactor::wait_db_ready(&handle).await {
                    tracing::error!("[startup] DB 就绪等待失败，后台初始化跳过：{e}");
                    return;
                }
                // 拉起小分队定时调度器与 API 触发服务（二者均依赖数据库就绪）。
                agent::squad_scheduler::start_scheduler(handle.clone());
                agent::squad_api_server::start_api_server(handle.clone());
                mcp_server::start_mcp_server(handle.clone());
                if let Err(e) = mamba_manager::ensure_default_env(&handle).await {
                    tracing::error!("[mamba] 默认环境初始化失败：{e}");
                }
                if let Err(e) = bun_manager::ensure_default_bun(&handle).await {
                    tracing::error!("[bun] 默认环境初始化失败：{e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp::sync_mcp_tools,
            mcp::call_mcp_tool,
            mamba_manager::init_mamba_env,
            mamba_manager::list_mamba_envs,
            mamba_manager::list_mamba_packages,
            mamba_manager::install_mamba_packages,
            mamba_manager::uninstall_mamba_packages,
            mamba_manager::reset_mamba_env,
            mamba_manager::delete_mamba_env,
            mamba_manager::run_python_script,
            bun_manager::init_bun_env,
            bun_manager::list_bun_envs,
            bun_manager::list_bun_packages,
            bun_manager::install_bun_packages,
            bun_manager::uninstall_bun_packages,
            bun_manager::reset_bun_env,
            bun_manager::delete_bun_env,
            bun_manager::run_node_script,
            agent::commands::run_agent_task,
            agent::commands::run_task_ex,
            agent::commands::get_status,
            agent::commands::wait_task,
            agent::commands::run_squad_task,
            agent::commands::anchor_squad_memory,
            agent::commands::list_squad_memories,
            agent::commands::delete_squad_memory,
            agent::commands::get_squad_api_config,
            agent::commands::set_squad_api_config,
            agent::commands::submit_approval_decision,
            agent::commands::submit_choice_decision,
            agent::commands::submit_plan_decision,
            agent::commands::cancel_agent_task,
            agent::plugin_commands::extract_plugin_meta,
            agent::plugin_commands::test_user_plugin,
            net::http_probe,
            agent::commands::retry_subtask,
            agent::commands::skip_subtask,
            agent::commands::resolve_subtask,
            agent::commands::begin_stage_attachment,
            agent::commands::append_stage_chunk,
            agent::commands::commit_stage_attachment,
            agent::commands::abort_stage_attachment,
            agent::commands::read_artifact,
            agent::commands::branch_from_step,
            agent::commands::list_memories,
            agent::commands::get_memory_heatmap,
            agent::commands::anchor_memory,
            agent::commands::list_memory_candidates,
            agent::commands::confirm_memory_candidate,
            agent::commands::reject_memory_candidate,
            agent::commands::update_memory,
            agent::commands::delete_memory,
            agent::commands::recall_memory,
            agent::wd_mem::wd_mem_read_project_memory,
            agent::wd_mem::wd_mem_write_project_memory,
            fs_helper::canonicalize_path,
            fs_helper::migrate_storage_dir,
            logging::get_run_logs,
            logging::log_frontend,
            mcp_server::mcp_resolve_result,
            agent::embedding::probe_embedding,
            agent::memory::backfill_memory_vectors,
            agent::vector_store::vector_status,
            agent::vector_store::set_vector_path,
            agent::commands::kb_sync_asset,
            agent::commands::kb_remove_asset,
            agent::commands::kb_remove_kb_index,
            agent::commands::kb_rebuild_index,
            grant_fs_scope,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
