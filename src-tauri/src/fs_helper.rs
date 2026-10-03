// 文件系统辅助命令：路径规范化（智能工作空间绑定用）+ 存储目录迁移。
use std::path::{Path, PathBuf};
use std::fs;
use serde::Serialize;
use sqlx::Row;

/// 将传入路径规范化为全局唯一绝对路径。
/// - 目录不存在或无法解析时返回 Err（前端据此熔断，禁止为不存在的目录建档）；
/// - 成功时返回 `canonicalize()` 后的原生字符串（Windows 上为 `\\?\` 前缀的标准绝对路径）。
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("指定的工作空间目录在物理磁盘上不存在: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("指定路径不是目录: {}", path));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("路径规范化失败: {}", e))?;
    Ok(canonical.to_string_lossy().to_string())
}

/// 存储目录迁移结果。
#[derive(Serialize)]
pub struct MigrateReport {
    /// 实际复制的文件数量
    pub moved: u64,
    /// 原目录不存在，无需迁移（目标目录仍会被创建）
    pub skipped: bool,
}

/// 递归复制目录内容（合并，重名覆盖）。
fn copy_tree(from: &Path, to: &Path, counter: &mut u64) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst, counter)?;
        } else {
            fs::copy(&src, &dst)?;
            *counter += 1;
        }
    }
    Ok(())
}

/// 迁移存储目录：将 `old_path` 下的全部内容复制到 `new_path`（合并，重名覆盖），
/// 复制成功后再删除 `old_path`。复制阶段任何失败都会中止且不删除原目录，保证数据不丢。
///
/// 行为约定：
/// - 始终 `create_dir_all(new_path)`：用户仅选择父目录时，由这里补建 `.workspace`/`.skills`/`.knowledge_base` 子目录；
/// - `old_path` 不存在时返回 `skipped=true`（仅建目标目录，不报错）；
/// - 目标目录等于原目录时直接跳过（防自复制导致删除自身）；
/// - 目标目录位于原目录之内（或反之）时报错取消，避免复制无限循环 / 父移入子。
#[tauri::command]
pub fn migrate_storage_dir(old_path: String, new_path: String) -> Result<MigrateReport, String> {
    let old = PathBuf::from(&old_path);
    let new = PathBuf::from(&new_path);

    // 始终确保目标目录存在（含用户未手动创建的 .workspace 等子目录）。
    fs::create_dir_all(&new).map_err(|e| format!("创建目标目录失败: {e}"))?;

    let old_canon = old.canonicalize().unwrap_or_else(|_| old.clone());
    let new_canon = new.canonicalize().unwrap_or_else(|_| new.clone());

    // 目标 == 原目录：无需任何操作，直接返回，绝不允许自复制。
    if new_canon == old_canon {
        return Ok(MigrateReport { moved: 0, skipped: true });
    }
    // 防止复制无限循环 / 父目录移入子目录。
    if new_canon.starts_with(&old_canon) {
        return Err("目标目录不能是原目录的子目录，迁移已取消（避免数据循环）".into());
    }
    if old_canon.starts_with(&new_canon) {
        return Err("原目录位于目标目录之内，迁移已取消".into());
    }

    if !old.exists() {
        return Ok(MigrateReport { moved: 0, skipped: true });
    }

    let mut moved = 0u64;
    copy_tree(&old_canon, &new_canon, &mut moved)
        .map_err(|e| format!("迁移复制失败（原数据已保留，未删除）：{e}"))?;
    // 仅在整个复制成功后清理原目录，确保中途失败不丢数据。
    fs::remove_dir_all(&old_canon)
        .map_err(|e| format!("文件已复制至新目录，但清理原目录失败（请手动删除原目录）：{e}"))?;
    Ok(MigrateReport { moved, skipped: false })
}

/* ============================ F002：脚本命令路径安全边界 ============================ */
//
// 背景：`run_python_script` / `run_node_script` 作为 Tauri 命令被渲染层直达，
// 修复前 script_path 仅做 exists() 校验——被注入的渲染层可指向全盘任意脚本执行。
// 本边界把脚本路径收敛到「应用数据目录 + 资源目录 + 全局工作空间」内；
// 运行时沙箱守卫（网络默认关+文件有界）由 run_script_with_selfheal 统一注入，两条通道均已覆盖。

use tauri::{AppHandle, Manager};
use tauri_plugin_sql::DbInstances;

/// 读取全局工作空间根（settings `workspace_path`，支持 $APPDATA 占位符；非绝对路径忽略）。
async fn workspace_root(app: &AppHandle) -> Option<PathBuf> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let pool = match guard.get("sqlite:workduo.db")? {
        tauri_plugin_sql::DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);
    let row = sqlx::query("SELECT value FROM app_config WHERE key = 'workspace_path'")
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten()?;
    let raw = row
        .try_get::<Option<String>, _>("value")
        .ok()
        .flatten()?;
    let appdata = app.path().app_data_dir().ok()?.to_string_lossy().to_string();
    let expanded = raw.replace("$APPDATA", &appdata);
    let p = PathBuf::from(expanded);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

/// 脚本命令允许的根目录：应用数据目录 + 资源目录（mamba/bun 管理资产）+ 全局工作空间。
pub async fn allowed_script_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        roots.push(dir);
    }
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir);
    }
    if let Some(ws) = workspace_root(app).await {
        roots.push(ws);
    }
    roots
}

/// 校验脚本路径必须落在允许根内（canonicalize 后组件级 `Path::starts_with` 比对——
/// 字符串前缀比对会被 `base` vs `base_secret` 这类兄弟目录绕过，必须走组件级）。
pub fn ensure_script_path_in_roots(script: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let canon = fs::canonicalize(script).map_err(|e| format!("解析脚本真实路径失败：{e}"))?;
    for root in roots {
        let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if canon.starts_with(&root_canon) {
            return Ok(());
        }
    }
    Err(format!(
        "脚本路径越界（安全边界）：仅允许运行「工作空间 / 应用数据目录 / 资源目录」内的脚本，当前：{}",
        script.display()
    ))
}

#[cfg(test)]
mod f002_tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("f002_{tag}_{}", std::process::id()))
    }

    #[test]
    fn inside_root_allowed() {
        let base = tmp_base("in");
        let dir = base.join("sub");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.py");
        fs::write(&f, "print(1)").unwrap();
        assert!(ensure_script_path_in_roots(&f, &[base.clone()]).is_ok());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn outside_root_rejected() {
        let base = tmp_base("root");
        let other = tmp_base("other");
        fs::create_dir_all(&other).unwrap();
        let f = other.join("s.py");
        fs::write(&f, "x").unwrap();
        assert!(ensure_script_path_in_roots(&f, &[base]).is_err());
        fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn prefix_sibling_dir_rejected() {
        // 组件级比对的回归锚：字符串 starts_with 会被 base vs base__secret 兄弟目录绕过
        let base = tmp_base("pre");
        let sib = tmp_base("pre__secret");
        fs::create_dir_all(&sib).unwrap();
        let f = sib.join("s.py");
        fs::write(&f, "x").unwrap();
        assert!(ensure_script_path_in_roots(&f, &[base]).is_err());
        fs::remove_dir_all(&sib).ok();
    }
}
