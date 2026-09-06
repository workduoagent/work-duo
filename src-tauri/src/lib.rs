// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod agent;
mod mcp;
mod mamba_manager;
mod fs_helper;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 绿色便携运行时管理器：落在 Tauri 资源目录（$RESOURCES）下的 mamba_root，交由 Tauri 托管。
    let mamba = mamba_manager::MambaManager::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build()) // store 插件的初始化稍有不同
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(mamba)
        .manage(agent::runtime::AgentRuntime::new())
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            // 后台静默确保 Agent 默认环境（default）存在；失败仅日志，不阻塞启动。
            // 严格延后：先 await DB 连接池就绪闸门，杜绝启动早期组件未就绪导致的空指针 / 连接断裂。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = agent::round_compactor::wait_db_ready(&handle).await {
                    eprintln!("[startup] DB 就绪等待失败，后台初始化跳过：{e}");
                    return;
                }
                // 拉起小分队定时调度器与 API 触发服务（二者均依赖数据库就绪）。
                agent::squad_scheduler::start_scheduler(handle.clone());
                agent::squad_api_server::start_api_server(handle.clone());
                if let Err(e) = mamba_manager::ensure_default_env(&handle).await {
                    eprintln!("[mamba] 默认环境初始化失败：{e}");
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
            agent::commands::run_agent_task,
            agent::commands::run_squad_task,
            agent::commands::anchor_squad_memory,
            agent::commands::list_squad_memories,
            agent::commands::delete_squad_memory,
            agent::commands::get_squad_api_config,
            agent::commands::set_squad_api_config,
            agent::commands::submit_approval_decision,
            agent::commands::cancel_agent_task,
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
            agent::commands::update_memory,
            agent::commands::delete_memory,
            agent::commands::recall_memory,
            agent::wd_mem::wd_mem_read_project_memory,
            agent::wd_mem::wd_mem_write_project_memory,
            fs_helper::canonicalize_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
