// 文件系统辅助命令：路径规范化（智能工作空间绑定用）。
// canonicalize_path 校验物理目录存在性，并抹平软链 / Windows 盘符大小写 / 冗余斜杠，
// 产出全局唯一绝对路径，供前端据此查重 / 自动建档工程档案。
use std::path::PathBuf;

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
