// 文件系统辅助命令：路径规范化（智能工作空间绑定用）+ 存储目录迁移。
use std::path::{Component, Path, PathBuf};
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
async fn config_root(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let pool = match guard.get("sqlite:workduo.db")? {
        tauri_plugin_sql::DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);
    let row = sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key)
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten()?;
    let raw = row
        .try_get::<Option<String>, _>("value")
        .ok()
        .flatten()?;
    // 占位符解析：$APPDATA/$RESOURCE（与前端 settings-file 的默认值写法一致）；
    // 数据迁移后这些键多为绝对自定义路径（如 E:\MySkills），原样即是绝对路径。
    let appdata = app.path().app_data_dir().ok()?.to_string_lossy().to_string();
    let resource = app.path().resource_dir().ok()?.to_string_lossy().to_string();
    let expanded = raw
        .replace("$APPDATA", &appdata)
        .replace("$RESOURCE", &resource);
    let p = PathBuf::from(expanded);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

/// 脚本命令允许的根目录：应用数据目录 + 资源目录（mamba/bun 管理资产）
/// + 用户可配置的五个数据目录（工作空间 / Skill / 知识库 / 向量库 / 插件）——
/// 含「数据迁移」后指向的自定义绝对目录（如 E:\MySkills），迁移脚本仍可运行。
pub async fn allowed_script_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        roots.push(dir);
    }
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir);
    }
    for key in [
        "workspace_path",
        "skill_path",
        "knowledge_base_path",
        "vector_path",
        "plugin_path",
    ] {
        if let Some(dir) = config_root(app, key).await {
            roots.push(dir);
        }
    }
    roots
}

/// 校验脚本路径必须落在允许根内（canonicalize 后组件级 `Path::starts_with` 比对——
/// 字符串前缀比对会被 `base` vs `base_secret` 这类兄弟目录绕过，必须走组件级）。
pub fn ensure_script_path_in_roots(script: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let canon = fs::canonicalize(script).map_err(|e| format!("解析脚本真实路径失败：{e}"))?;
    ensure_path_in_roots(&canon, roots)
        .map(|_| ())
        .map_err(|_| {
            format!(
                "脚本路径越界（安全边界）：仅允许运行「工作空间 / 应用数据目录 / 资源目录」内的脚本，当前：{}",
                script.display()
            )
        })
}

/* ============================ F008：本地路径边界原语（host__* 与 F002 共用） ============================ */
//
// 背景：host__upload/download/sync 的 local_guard 用「斜杠替换后的字符串 starts_with」
// 做白名单比对且从不 canonicalize——(a) 白名单 D:/proj 会放行兄弟目录 D:/proj_secret/x；
// (b) `..` 不折叠，sftp 按原始路径读/写真实文件，穿越成立。本节提供组件级边界原语：
// 折叠 + 规范化 + 组件级比对，F002 的脚本边界同样迁移到该原语上。

/// 剥离 Windows verbatim 前缀（`\\?\` 与 `\\?\UNC\`），便于跨形态组件比对
/// （canonicalize 产出 verbatim 形态，而用户输入/配置多为普通形态）。
fn simplify_verbatim_string(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.to_string()
}

/// 逻辑折叠 `..` / `.` 为真实路径形态，再对**最深已存在祖先** canonicalize
/// （解析符号链接 / 大小写 / verbatim）并接回不存在的尾部。
///
/// 折叠语义：根处（Prefix/RootDir 之上）的 `..` 按 OS 语义 clamp（盘符根的父目录是它自己）；
/// 逃逸与否交给后续的边界比对裁决——调用方必须传入**绝对路径**（local_guard 已先 join 工作区），
/// 裸相对路径折叠结果无法命中任何绝对根，天然被拒。
pub fn canonicalize_boundary(p: &Path) -> Result<PathBuf, String> {
    let mut stack: Vec<std::path::Component> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => match stack.last() {
                // 仅弹出普通组件；根/前缀之上 clamp（等同 OS 对盘符根 `..` 的处理），
                // 逃逸与否交给后续的组件级边界比对裁决。
                Some(std::path::Component::Normal(_)) => {
                    stack.pop();
                }
                _ => {}
            },
            Component::CurDir => {}
            other => stack.push(other),
        }
    }
    let folded: PathBuf = stack.iter().collect();

    // 最深已存在祖先 canonicalize + 接回尾部（下载落盘新文件等目标尚不存在场景）。
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = folded.clone();
    let canon = loop {
        match fs::canonicalize(&cur) {
            Ok(c) => break c,
            Err(_) => match (cur.parent(), cur.file_name()) {
                (Some(parent), Some(name)) => {
                    tail.push(name.to_os_string());
                    cur = parent.to_path_buf();
                }
                // 整条链都无法 canonicalize（如盘符不存在）：退回折叠结果。
                _ => return Ok(folded),
            },
        }
    };
    let mut out = canon;
    for seg in tail.into_iter().rev() {
        out.push(seg);
    }
    Ok(out)
}

/// 组件序列（比对用）：剥 verbatim 前缀后按组件拆分；Windows 侧大小写折叠
/// （NTFS 不区分大小写；POSIX 保持大小写敏感，避免 `D:/Proj` 误放行）。
fn boundary_components(p: &Path) -> Vec<String> {
    let s = simplify_verbatim_string(&p.to_string_lossy());
    Path::new(&s)
        .components()
        .map(|c| {
            let part = c.as_os_str().to_string_lossy().to_string();
            #[cfg(windows)]
            {
                part.to_lowercase()
            }
            #[cfg(not(windows))]
            {
                part
            }
        })
        .collect()
}

/// 组件级边界比对：`path` 折叠规范化后必须命中 `roots` 中任一根（含其子树）。
/// 命中返回规范化路径（供调用方以真实路径执行 IO，即使比对层有漏也不再把
/// 带 `..` 的原始串交给下游）；未命中报错。
///
/// 要求 `path` 为绝对路径（local_guard / F002 两侧调用前均已保证）。
pub fn ensure_path_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canon = canonicalize_boundary(path)?;
    let path_comps = boundary_components(&canon);
    for root in roots {
        let root_canon = canonicalize_boundary(root).unwrap_or_else(|_| root.to_path_buf());
        let root_comps = boundary_components(&root_canon);
        if !root_comps.is_empty() && path_comps.starts_with(&root_comps) {
            return Ok(canon);
        }
    }
    Err(format!("本地路径越出允许根：{}", canon.display()))
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

#[cfg(test)]
mod f008_tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("f008_{tag}_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sibling_prefix_rejected() {
        // 白名单 D:/proj 不应放行兄弟目录 D:/proj_secret/x（字符串前缀绕过）
        let base = tmp_base("sib");
        let sib = base.with_file_name(format!(
            "{}_secret",
            base.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&sib).unwrap();
        let f = sib.join("x.txt");
        fs::write(&f, "x").unwrap();
        assert!(ensure_path_in_roots(&f, &[base.clone()]).is_err());
        fs::remove_dir_all(&sib).ok();
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn dotdot_relative_escape_rejected() {
        // 相对路径 .. join 到工作区后折叠 = 逃出工作区
        let ws = tmp_base("ws");
        let p = ws.join("..").join("..").join("elsewhere.txt");
        assert!(ensure_path_in_roots(&p, &[ws.clone()]).is_err());
        fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn dotdot_absolute_traversal_rejected() {
        // 绝对路径夹带 .. 折叠后落到边界外（报告场景：D:/proj/../../Windows/...）
        let base = tmp_base("trav");
        let p = base.join("sub").join("..").join("..").join("escape.txt");
        assert!(ensure_path_in_roots(&p, &[base.clone()]).is_err());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn legit_subpath_and_exact_root_allowed() {
        let base = tmp_base("legit");
        let sub = base.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let f = sub.join("a.txt");
        fs::write(&f, "x").unwrap();
        assert!(ensure_path_in_roots(&f, &[base.clone()]).is_ok());
        // 根本身精确命中（sync 整目录场景）
        assert!(ensure_path_in_roots(&base, &[base.clone()]).is_ok());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn nonexistent_download_target_allowed() {
        let base = tmp_base("dl");
        // 下载落盘目标尚不存在：最深已存在祖先 canonicalize + 接回尾部 → 根内放行
        let target = base.join("newdir").join("file.txt");
        assert!(ensure_path_in_roots(&target, &[base.clone()]).is_ok());
        // 逃逸到边界外的不存在路径同样拒绝
        let evil = base.join("..").join("outside").join("file.txt");
        assert!(ensure_path_in_roots(&evil, &[base.clone()]).is_err());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn boundary_folds_dotdot_to_real_path() {
        let base = tmp_base("fold");
        let sub = base.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let p = sub.join("..").join("real.txt");
        let out = canonicalize_boundary(&p).unwrap();
        let base_canon = fs::canonicalize(&base).unwrap();
        assert!(out.starts_with(&base_canon) && out.ends_with("real.txt"));
        fs::remove_dir_all(&base).ok();
    }

    #[cfg(windows)]
    #[test]
    fn case_insensitive_on_windows() {
        // NTFS 不区分大小写：根用大写书写也应命中（canonicalize 折回磁盘真实大小写）
        let base = tmp_base("case");
        let upper = PathBuf::from(base.to_string_lossy().to_uppercase());
        assert!(ensure_path_in_roots(&base, &[upper]).is_ok());
        fs::remove_dir_all(&base).ok();
    }
}
