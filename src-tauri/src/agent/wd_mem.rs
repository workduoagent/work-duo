//! 第二轨物理记忆：项目根目录下的 `.wd_mem/` 专属记忆维护区。
//!
//! 对应《桌面级智能体「双轨持久化与分层记忆」系统规范》第二轨：
//!  - `MEMORY.md`：项目长期全局记忆（架构/拓扑/避坑法则/用户偏好），全量注入系统提示 Slot 0，用户可直接编辑；
//!  - `sessions/{session_id}.summary.md`：单会话滚动压缩产物（随 Git 走，减轻 DB 压力）。
//!
//! 设计约定（与项目既有铁律一致）：
//!  - 纯 FS 操作：入参统一为「已规范化」的工程绝对根路径，DB→root_path 的解析由调用方（context / round_compactor）完成；
//!  - 直接 `std::fs` 写用户已绑定的工程目录，绕过 tauri-plugin-fs 的 scope 限制，无需额外 capability；
//!  - 普通日常会话（project_id 为空）不落地任何项目文件，完全走全局默认沙箱。

use std::path::{Path, PathBuf};

const WD_MEM_DIR: &str = ".wd_mem";
/// 长期全局记忆文件（规范命名，全量注入系统提示 Slot 0）。
const GLOBAL_MEMORY_FILE: &str = "MEMORY.md";
/// 旧部署兼容：早期版本使用 `project_memory.md`，读取时回退兼容（避免已落盘工程记忆丢失）。
const GLOBAL_MEMORY_OLD_FILE: &str = "project_memory.md";
const ARTIFACTS_DIR: &str = "artifacts";
const SESSIONS_DIR: &str = "sessions";
const SCRIPTS_DIR: &str = "scripts";
const DATA_DIR: &str = "data";
const OUTPUTS_DIR: &str = "outputs";
const README_FILE: &str = "README.md";
const GITIGNORE_FILE: &str = ".gitignore";

/// 返回 `.wd_mem/` 根目录路径（不创建）。
fn wd_mem_base(workspace_root: &str) -> PathBuf {
    Path::new(workspace_root).join(WD_MEM_DIR)
}

/// 确保 `.wd_mem/` 目录结构与基础模板就绪（幂等，可重复调用）。
///
/// `workspace_root` 为「已规范化」的工作空间绝对根路径——既可是绑定的工程根，
/// 也可是自由对话设定的工作空间。每次运行（只要设定了工作空间）都会确保该结构存在，
/// 使运行期产生的可复用脚本 / 中间数据 / 长期记忆有统一归宿，避免散落污染用户目录。
pub(crate) fn ensure_wd_mem(workspace_root: &str) -> Result<PathBuf, String> {
    let base = wd_mem_base(workspace_root);
    for sub in [SCRIPTS_DIR, DATA_DIR, OUTPUTS_DIR, SESSIONS_DIR, ARTIFACTS_DIR] {
        std::fs::create_dir_all(base.join(sub))
            .map_err(|e| format!("创建 .wd_mem/{} 目录失败: {}", sub, e))?;
    }

    let global = base.join(GLOBAL_MEMORY_FILE);
    if !global.exists() {
        let tpl = format!(
            "# Work Duo - Project Memory & Architecture Context\nInitialized: {}\n\n## 1. Project Rules\n\n## 2. Key Architecture & File Notes\n",
            now_stamp()
        );
        std::fs::write(&global, tpl)
            .map_err(|e| format!("写入 MEMORY.md 模板失败: {}", e))?;
    }

    let readme = base.join(README_FILE);
    if !readme.exists() {
        std::fs::write(&readme, wd_mem_readme())
            .map_err(|e| format!("写入 .wd_mem/README.md 失败: {}", e))?;
    }

    // 自动生成 .gitignore：高频碎片（sessions/data/outputs）忽略，长期资产（MEMORY.md/artifacts/scripts）纳入版本控制。
    let gitignore = base.join(GITIGNORE_FILE);
    if !gitignore.exists() {
        std::fs::write(
            &gitignore,
            "# Work Duo 运行时记忆区：高频碎片忽略，长期资产纳入版本控制\n\
# 忽略（随运行高频变化，不入库）\n\
sessions/\n\
data/\n\
outputs/\n\
# 纳入版本控制（长期知识资产）：MEMORY.md / artifacts/ / scripts/ / README.md\n",
        )
        .map_err(|e| format!("写入 .wd_mem/.gitignore 失败: {}", e))?;
    }
    Ok(base)
}

/// `.wd_mem/README.md` 内容：说明目录用途与分类规则（用户/智能体可读）。
fn wd_mem_readme() -> &'static str {
    "# .wd_mem — Work Duo 运行时记忆与素材区\n\
\n\
本目录由智能体在每次运行（只要设定了工作空间）自动创建与维护，用于沉淀运行期产生的\
可复用素材与长期记忆。\n\
\n\
## 目录结构\n\
- `MEMORY.md`：项目长期全局记忆（架构 / 避坑法则 / 用户偏好），全量注入系统提示，用户可直接编辑。\n\
- `artifacts/` ：智能体完成复杂任务后主动沉淀的设计蓝图 / 架构约定（Markdown），随工程长期留存。\n\
- `scripts/`  ：生成的自动化脚本（Python / Shell 等），跨任务可复用。再跑同类任务时优先复用。\n\
- `data/`     ：抓取/计算的中间数据（CSV / JSON 等），供脚本复用（已被 .gitignore 忽略）。\n\
- `outputs/`  ：最终产物的归档副本（可选，已被 .gitignore 忽略）。\n\
- `sessions/` ：单会话滚动压缩摘要 `{session_id}.summary.md`（已被 .gitignore 忽略）。\n\
\n\
> 注意：`sessions/` `data/` `outputs/` 已在 `.gitignore` 中忽略（高频碎片）；`MEMORY.md` `artifacts/` `scripts/` 建议纳入版本控制。运行产生的临时文件不在此目录。\n"
}

/// 生成 `.wd_mem/` 的「树状索引」：扫描 `artifacts/` `sessions/` `scripts/` `data/` 子目录，
/// 深度 ≤2 层、总文件数上限 50，仅提取相对路径与首行标题/注释（**绝不读取正文**），
/// 供注入系统提示，引导模型「先发现、后按需 `native__read_file` 拉细节」，避免全量加载爆上下文。
///
/// 返回形如 `- `artifacts/foo.md`：<首行标题>` 的索引文本；目录为空或无工作空间时返回 None。
pub(crate) fn build_tree_index(workspace_root: &str) -> Option<String> {
    let base = ensure_wd_mem(workspace_root).ok()?;
    const MAX_INDEX_FILES: usize = 50;
    const MAX_DEPTH: usize = 2;
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut count = 0usize;
    for sub in [ARTIFACTS_DIR, SESSIONS_DIR, SCRIPTS_DIR, DATA_DIR] {
        let root = base.join(sub);
        if root.is_dir() {
            walk_tree_index(&root, &base, 0, MAX_DEPTH, &mut count, MAX_INDEX_FILES, &mut entries);
        }
        if count >= MAX_INDEX_FILES {
            break;
        }
    }
    if entries.is_empty() {
        return None;
    }
    let mut out = String::from("### 记忆树状索引（.wd_mem 仅目录结构，正文请按需 `native__read_file`）\n");
    for (rel, title) in entries {
        out.push_str(&format!("- `{}`：{}\n", rel, title));
    }
    Some(out)
}

/// 受限深度优先扫描：收集文件「相对路径 + 首行标题」，深度不超过 `max_depth`，总数不超过 `max_files`。
fn walk_tree_index(
    dir: &Path,
    base: &Path,
    depth: usize,
    max_depth: usize,
    count: &mut usize,
    max_files: usize,
    out: &mut Vec<(String, String)>,
) {
    if *count >= max_files {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        if *count >= max_files {
            return;
        }
        let p = ent.path();
        if p.is_dir() {
            if depth + 1 <= max_depth {
                walk_tree_index(&p, base, depth + 1, max_depth, count, max_files, out);
            }
            continue;
        }
        if !p.is_file() {
            continue;
        }
        let rel = p
            .strip_prefix(base)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        let title = extract_title(&p);
        out.push((rel, title));
        *count += 1;
    }
}

/// 提取文件「首行标题/注释」用于索引展示（仅读前 4KB，避免大文件爆 IO）：
/// - Markdown：首个非空行（去 `#` 前缀）；
/// - 脚本（py/sh/...）：首个注释行（复用 `read_first_comment`）；
/// - 其他/读不到：回退文件名。
fn extract_title(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(ext.as_str(), "md" | "markdown") {
        if let Some(line) = read_first_line(path) {
            let t = line.trim();
            if !t.is_empty() {
                return t.trim_start_matches('#').trim().to_string();
            }
        }
        return path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }
    read_first_comment(path).unwrap_or_else(|| {
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string()
    })
}

/// 仅读取文件前 4KB 的首个非空行（用于 Markdown 标题提取，避免大文件整体读入）。
fn read_first_line(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = f.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines() {
        let t = line.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

/// 读取脚本前若干行的首条注释作为用途摘要（支持 # // /// 与 Python docstring 首行）。
fn read_first_comment(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().take(5) {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(rest) = t.strip_prefix("///") {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = t.strip_prefix("//") {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = t.strip_prefix('#') {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = t.strip_prefix("\"\"\"") {
            let inner = rest.trim();
            if !inner.is_empty() {
                return Some(inner.to_string());
            }
        }
        // 前 5 行若出现非注释代码行，停止（避免误抓函数体）
        break;
    }
    None
}

/// 读取项目级长期记忆（文件不存在返回 None）。
/// 优先读规范命名的 `MEMORY.md`；兼容旧部署回退读 `project_memory.md`。
pub(crate) fn read_project_memory(project_root: &str) -> Option<String> {
    let base = wd_mem_base(project_root);
    let mem = base.join(GLOBAL_MEMORY_FILE);
    if let Ok(c) = std::fs::read_to_string(&mem) {
        if !c.trim().is_empty() {
            return Some(c);
        }
    }
    // 兼容旧部署：早期版本使用 project_memory.md
    std::fs::read_to_string(base.join(GLOBAL_MEMORY_OLD_FILE))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// 写入项目级长期记忆（自动确保目录结构）。
pub(crate) fn write_project_memory(project_root: &str, content: &str) -> Result<(), String> {
    let base = ensure_wd_mem(project_root)?;
    let global = base.join(GLOBAL_MEMORY_FILE);
    std::fs::write(&global, content)
        .map_err(|e| format!("写入 MEMORY.md 失败: {}", e))
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

/// 读取指定工程根目录下的 `MEMORY.md`（兼容旧 project_memory.md），不存在返回 None。
#[tauri::command]
pub fn wd_mem_read_project_memory(project_root: String) -> Result<Option<String>, String> {
    Ok(read_project_memory(&project_root))
}

/// 写入（覆盖）指定工程根目录下的 `MEMORY.md`（兼容旧 project_memory.md）。
#[tauri::command]
pub fn wd_mem_write_project_memory(project_root: String, content: String) -> Result<(), String> {
    write_project_memory(&project_root, &content)
}
