//! 工作空间快照与回滚（D' 产物回滚，2026-09-24）。
//!
//! - run 前对工作空间**业务文件**做目录级快照（排除 `.wd_mem` / `.attachments` 等
//!   引擎内部结构——回滚只回滚业务产物，不动记忆与会话轨）；
//! - 快照落 `appDataDir/ws-snapshots/<agentId>/<本地时间戳>/`，每 agent 保留最近
//!   `MAX_SNAPSHOTS_PER_AGENT` 份；
//! - 回滚前自动对当前状态再做一次快照（防误回滚丢当前工作），再清空业务文件并拷回；
//! - 尽力而为：快照失败只告警不阻塞任务（`snapshot_workspace` 由调用方 catch）。

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri::Manager;

const MAX_SNAPSHOTS_PER_AGENT: usize = 5;
const MAX_FILES: usize = 2000;

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 失败：{e}"))?;
    Ok(dir.join("ws-snapshots"))
}

/// 引擎内部结构不进快照（回滚只回滚业务产物）。
fn is_internal(name: &str) -> bool {
    name == ".wd_mem"
        || name == ".attachments"
        || name == ".gitkeep"
        || name == ".pytest_cache"
        || name == "__pycache__"
        || name == "node_modules"
}

fn copy_dir(src: &Path, dst: &Path, counter: &mut usize) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("create_dir {} 失败：{e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {} 失败：{e}", src.display()))? {
        let entry = entry.map_err(|e| format!("遍历失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let sp = entry.path();
        let dp = dst.join(&name);
        if sp.is_dir() {
            if is_internal(&name) {
                continue;
            }
            copy_dir(&sp, &dp, counter)?;
        } else {
            *counter += 1;
            if *counter > MAX_FILES {
                return Err(format!("快照文件数超上限 {MAX_FILES}，本次快照中止"));
            }
            std::fs::copy(&sp, &dp).map_err(|e| format!("copy {} 失败：{e}", sp.display()))?;
        }
    }
    Ok(())
}

/// run 前快照工作空间业务文件。调用方 catch（失败仅告警不阻塞任务）。
pub fn snapshot_workspace(app: &AppHandle, agent_id: &str, ws: &Path) -> Result<PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
    let dst = base_dir(app)?.join(agent_id).join(stamp.to_string());
    let mut counter = 0usize;
    copy_dir(ws, &dst, &mut counter)?;
    prune_old(app, agent_id)?;
    Ok(dst)
}

fn prune_old(app: &AppHandle, agent_id: &str) -> Result<(), String> {
    let agent_dir = base_dir(app)?.join(agent_id);
    if !agent_dir.exists() {
        return Ok(());
    }
    let mut snaps: Vec<PathBuf> = std::fs::read_dir(&agent_dir)
        .map_err(|e| format!("read_dir {} 失败：{e}", agent_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    snaps.sort();
    while snaps.len() > MAX_SNAPSHOTS_PER_AGENT {
        let oldest = snaps.remove(0);
        let _ = std::fs::remove_dir_all(&oldest);
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SnapshotInfo {
    pub stamp: String,
    pub path: String,
    pub files: usize,
}

/// 列出某 agent 的可用快照（时间升序）。
pub fn list_snapshots(app: &AppHandle, agent_id: &str) -> Result<Vec<SnapshotInfo>, String> {
    let agent_dir = base_dir(app)?.join(agent_id);
    if !agent_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in std::fs::read_dir(&agent_dir).map_err(|e| format!("read_dir 失败：{e}"))? {
        let entry = entry.map_err(|e| format!("遍历失败：{e}"))?;
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let stamp = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let files = count_files(&p);
        out.push(SnapshotInfo { stamp, path: p.to_string_lossy().to_string(), files });
    }
    out.sort_by(|a, b| a.stamp.cmp(&b.stamp));
    Ok(out)
}

fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                n += count_files(&p);
            } else {
                n += 1;
            }
        }
    }
    n
}

/// 回滚工作空间到指定快照。恢复前自动对当前状态再做一次快照（防误回滚丢当前工作）。
pub fn rollback_workspace(
    app: &AppHandle,
    agent_id: &str,
    ws: &Path,
    stamp: &str,
) -> Result<String, String> {
    let snap_dir = base_dir(app)?.join(agent_id).join(stamp);
    if !snap_dir.is_dir() {
        return Err(format!("快照不存在：{stamp}"));
    }
    // 恢复前先快照当前状态（回滚也可撤销）
    let safety = snapshot_workspace(app, agent_id, ws)
        .map_err(|e| format!("回滚前安全快照失败（已中止回滚）：{e}"))?;
    // 清空 ws 内业务条目（保留引擎内部结构）
    for entry in std::fs::read_dir(ws).map_err(|e| format!("read_dir ws 失败：{e}"))? {
        let entry = entry.map_err(|e| format!("遍历失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_internal(&name) {
            continue;
        }
        let p = entry.path();
        let res = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        res.map_err(|e| format!("清理 {} 失败：{e}", p.display()))?;
    }
    // 拷回快照
    let mut counter = 0usize;
    copy_dir(&snap_dir, ws, &mut counter)?;
    Ok(format!(
        "已回滚到快照 {stamp}（恢复 {} 个文件）；回滚前状态已另存快照 {}",
        counter,
        safety.display()
    ))
}
