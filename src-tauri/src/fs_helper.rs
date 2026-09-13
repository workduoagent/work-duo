// 文件系统辅助命令：路径规范化（智能工作空间绑定用）+ 存储目录迁移。
use std::path::{Path, PathBuf};
use std::fs;
use serde::Serialize;

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
