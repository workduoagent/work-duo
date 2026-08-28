// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod mcp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build()) // store 插件的初始化稍有不同
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![mcp::sync_mcp_tools, mcp::call_mcp_tool])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
