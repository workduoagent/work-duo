//! 第二轨物理记忆：项目根目录下的 `.wd_mem/` 专属记忆维护区。
//!
//! 对应《桌面级智能体「双轨持久化与分层记忆」系统规范》第二轨：
//!  - `project_memory.md`：项目长期记忆（架构/拓扑/避坑法则），智能体大任务后自动沉淀，用户可直接编辑；
//!  - `sessions/{session_id}.summary.md`：单会话滚动压缩产物（随 Git 走，减轻 DB 压力）。
//!
//! 设计约定（与项目既有铁律一致）：
//!  - 纯 FS 操作：入参统一为「已规范化」的工程绝对根路径，DB→root_path 的解析由调用方（context / round_compactor）完成；
//!  - 直接 `std::fs` 写用户已绑定的工程目录，绕过 tauri-plugin-fs 的 scope 限制，无需额外 capability；
//!  - 普通日常会话（project_id 为空）不落地任何项目文件，完全走全局默认沙箱。

use std::path::{Path, PathBuf};

const WD_MEM_DIR: &str = ".wd_mem";
const GLOBAL_MEMORY_FILE: &str = "project_memory.md";
const SESSIONS_DIR: &str = "sessions";

/// 返回 `.wd_mem/` 根目录路径（不创建）。
fn wd_mem_base(project_root: &str) -> PathBuf {
    Path::new(project_root).join(WD_MEM_DIR)
}

/// 确保 `.wd_mem/` 目录结构与 `project_memory.md` 基础模板就绪（幂等，可重复调用）。
pub(crate) fn ensure_wd_mem(project_root: &str) -> Result<PathBuf, String> {
    let base = wd_mem_base(project_root);
    let sessions = base.join(SESSIONS_DIR);
    std::fs::create_dir_all(&sessions)
        .map_err(|e| format!("创建 .wd_mem 目录失败: {}", e))?;

    let global = base.join(GLOBAL_MEMORY_FILE);
    if !global.exists() {
        let tpl = format!(
            "# Work Duo - Project Memory & Architecture Context\nInitialized: {}\n\n## 1. Project Rules\n\n## 2. Key Architecture & File Notes\n",
            now_stamp()
        );
        std::fs::write(&global, tpl)
            .map_err(|e| format!("写入 project_memory.md 模板失败: {}", e))?;
    }
    Ok(base)
}

/// 抓取项目级长期记忆（文件不存在返回 None）。
pub(crate) fn read_project_memory(project_root: &str) -> Option<String> {
    let global = wd_mem_base(project_root).join(GLOBAL_MEMORY_FILE);
    std::fs::read_to_string(global).ok()
}

/// 写入项目级长期记忆（自动确保目录结构）。
pub(crate) fn write_project_memory(project_root: &str, content: &str) -> Result<(), String> {
    let base = ensure_wd_mem(project_root)?;
    let global = base.join(GLOBAL_MEMORY_FILE);
    std::fs::write(&global, content)
        .map_err(|e| format!("写入 project_memory.md 失败: {}", e))
}

/// 写入会话级滚动压缩结果到独立 Markdown 文件（双轨落盘之一）。
pub(crate) fn write_session_summary(
    project_root: &str,
    session_id: &str,
    summary: &str,
) -> Result<PathBuf, String> {
    let base = ensure_wd_mem(project_root)?;
    let target = base
        .join(SESSIONS_DIR)
        .join(format!("{}.summary.md", session_id));
    std::fs::write(&target, summary)
        .map_err(|e| format!("写入会话压缩摘要文件失败: {}", e))?;
    Ok(target)
}

/// 读取会话级滚动压缩内容（文件不存在返回 None）。
pub(crate) fn read_session_summary(project_root: &str, session_id: &str) -> Option<String> {
    let target = wd_mem_base(project_root)
        .join(SESSIONS_DIR)
        .join(format!("{}.summary.md", session_id));
    std::fs::read_to_string(target).ok()
}

/// 极简时间戳（避免引入 chrono 依赖；仅用于初始模板头，用户/智能体可改写）。
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

/* ----------------------------- UI 命令（供前端读写项目记忆） ----------------------------- */

/// 读取指定工程根目录下的 `project_memory.md`，不存在返回 None。
#[tauri::command]
pub fn wd_mem_read_project_memory(project_root: String) -> Result<Option<String>, String> {
    Ok(read_project_memory(&project_root))
}

/// 写入（覆盖）指定工程根目录下的 `project_memory.md`。
#[tauri::command]
pub fn wd_mem_write_project_memory(project_root: String, content: String) -> Result<(), String> {
    write_project_memory(&project_root, &content)
}
