// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod mcp;
mod mamba_manager;

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
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            // 后台静默确保 Agent 默认环境（default）存在；失败仅日志，不阻塞启动。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
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
            mamba_manager::run_python_script
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
