//! 内嵌 Bun 的纯绿色便携 Node 运行时管理。
//!
//! 设计目标：与 Python（micromamba）完全对齐——所有运行时文件（依赖包、下载缓存）
//! 严格落在 Tauri 资源目录（`$RESOURCES`，即 `app.path().resource_dir()`）下的 `bun_root`，
//! 绝不向系统目录（AppData / 用户目录）写入任何数据，软件文件夹整体拷走即可在另一台电脑直接运行。
//!
//! 与 Python 的关键差异：Node/Bun **只需单一运行时版本**——Bun 二进制本身即运行时，
//! 依赖统一安装在 `bun_root/node_modules`（单一环境，不存在多版本 / 多套环境的概念），
//! 因此本模块不提供「创建 / 删除环境」的多环境能力，`list_bun_envs` 始终只返回受管的 `default`
//! 单一环境，reset 仅清空 `node_modules`（不会删除运行时本身）。
//!
//! 二进制位置：`binaries/bun`（经 `tauri_plugin_shell` 的 `sidecar("bun")` 调用，已配置
//! `externalBin` 与 `capabilities`），与 `binaries/micromamba` 同级。
//! 依赖存储位置：`$RESOURCES/bun_root/node_modules`（与 mamba_root/envs 同级绿便携思路一致）。
//!
//! 对外暴露命令（均 `async fn`，不阻塞 UI）：
//! - `init_bun_env`：确保默认环境就绪（创建 `bun_root` + `package.json` + 空 `node_modules`）
//! - `list_bun_envs`：列出环境元信息（仅 `default`，驱动卡片展示）
//! - `list_bun_packages`：查询当前已安装的依赖（名称 + 版本）
//! - `install_bun_packages`：向 `default` 环境追加安装依赖（支持 `lodash`、`axios@1.x` 等规格）
//! - `uninstall_bun_packages`：从 `default` 环境移除指定依赖
//! - `reset_bun_env`：清空 `node_modules`（清空全部依赖，运行时本身保留）
//! - `delete_bun_env`：保留接口，**单一环境不允许删除**（运行时即 Bun 本身，删除无意义）
//! - `run_node_script`：在 `default` 环境中执行指定 JS/TS 脚本，返回 stdout / stderr
//!
//! 缺失依赖「自愈」：脚本因 `Cannot find package 'X'` / `Could not resolve "X"` 失败时，
//! 仅当缺失模块命中白名单才会自动 `bun add` 并重试一次（与 Python 的 `ModuleNotFoundError` 自愈一致）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use crate::agent::tools::ScriptRunResult;

/// 默认受管环境名：Node 仅此一个，调用方未指定 `env_name` 时使用。
const DEFAULT_ENV: &str = "default";
/// 安装依赖时使用的国内镜像源（npmmirror），与 Python 的清华镜像源思路一致，避免直连 npm 官方源超时。
const NPM_MIRROR: &str = "https://registry.npmmirror.com";
/// 默认本地缓存目录（Bun 下载依赖的 cache 落在此处，保持绿便携、不落用户 HOME）。
const BUN_CACHE_DIR: &str = ".bun";

/// 沙箱依赖安装：不做白名单限制。任何检测到的缺失包都交由 selfheal 自动安装
/// （`bun add`），用户明确：沙箱就该自由装依赖，限白名单等于阉割沙箱。

/// 单个已安装依赖的元信息（供 `list_bun_packages` 结构化返回）。
#[derive(Serialize)]
pub struct PackageInfo {
    /// 包名（如 `lodash`、`@scope/pkg`）。
    pub name: String,
    /// 版本号（如 `4.17.21`）。
    pub version: String,
}

/// 单个 Node 运行环境的元信息（供 `list_bun_envs` 结构化返回，驱动卡片展示）。
#[derive(Serialize)]
pub struct EnvInfo {
    /// 环境名（固定 `default`）。
    pub name: String,
    /// 是否为受管默认环境（恒为 true，单一环境）。
    pub is_default: bool,
    /// 环境目录是否存在（Bun 运行时 + 依赖根是否已就绪）。
    pub exists: bool,
    /// Bun 运行时版本（仅 `exists=true` 时有值，如 `1.1.30`）。
    pub bun_version: Option<String>,
    /// 已安装依赖数量（仅 `exists=true` 时有意义）。
    pub package_count: usize,
}

/// 绿色便携运行时管理器（与 `MambaManager` 同构：不持有路径字段，根目录每次动态推导）。
pub struct BunManager {}

impl BunManager {
    pub fn new() -> Self {
        Self {}
    }

    /// 解析根目录：优先 Tauri 资源目录（`$RESOURCES`），失败回退到 exe 父目录。
    fn base_dir(app: &AppHandle) -> PathBuf {
        if let Ok(res) = app.path().resource_dir() {
            return res;
        }
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    /// 步骤一 + 步骤二：在 `$RESOURCES/bun_root` 创建运行时目录、初始化 `package.json`
    /// 与本地 `.bun` 缓存目录，保证绿便携 + 国内镜像。返回 `(bun_root, package_json)`。
    /// 权限被拒时返回友好提示。
    fn setup(&self, app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
        let base_dir = Self::base_dir(app);
        let bun_root = base_dir.join("bun_root");

        if let Err(e) = std::fs::create_dir_all(&bun_root) {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                return Err(
                    "当前安装目录无写入权限，请将软件移动到 D 盘或其他非系统目录".into(),
                );
            }
            return Err(format!("创建运行时目录失败：{e}"));
        }

        // 初始化 package.json（Bun 安装依赖需要项目根，沿用 Bun 约定的单环境工程）。
        let pkg = bun_root.join("package.json");
        if !pkg.exists() {
            std::fs::write(
                &pkg,
                "{\n  \"name\": \"workduo-bun-runtime\",\n  \"version\": \"1.0.0\",\n  \"private\": true\n}\n",
            )
            .map_err(|e| format!("写入 package.json 失败：{e}"))?;
        }

        // 本地缓存目录（Bun 下载 cache 落在此处，不污染用户 HOME/.bun）。
        let _ = std::fs::create_dir_all(bun_root.join(BUN_CACHE_DIR));

        Ok((bun_root, pkg))
    }
}

/// 通用：spawn bun sidecar，异步收集 stdout / stderr，进程结束后返回三元组。
///
/// 全程 `spawn()` + `CommandEvent` 异步流，不阻塞调用线程。
/// 关键点：强制注入 `BUN_INSTALL`（cache 落 `bun_root/.bun`）与 `BUN_CONFIG_REGISTRY`
/// （npmmirror 镜像），保证绿便携 + 国内可达，不依赖用户本机 ~/.bun / npm 配置。
async fn run_bun_sidecar(
    app: &AppHandle,
    bun_root: &Path,
    args: Vec<String>,
    cwd: Option<&Path>,
) -> Result<(String, String, Option<i32>), String> {
    let mut cmd = app
        .shell()
        .sidecar("bun")
        .map_err(|e| format!("准备 bun sidecar 失败：{e}"))?
        .args(args)
        .env("BUN_INSTALL", bun_root.join(BUN_CACHE_DIR).to_string_lossy().to_string())
        .env("BUN_CONFIG_REGISTRY", NPM_MIRROR)
        // NODE_PATH 指向 bun_root/node_modules：运行时自动安装的依赖（bun add 落入此处）
        // 才能被任意位置的脚本 `import` 命中——脚本原地执行后不再沿自身目录向上回溯到 run_tmp，
        // 必须靠 NODE_PATH 兜底包解析（Bun 兼容 Node 的 NODE_PATH 回退解析）。
        .env("NODE_PATH", bun_root.join("node_modules").to_string_lossy().to_string());
    if let Some(dir) = cwd {
        cmd = cmd.current_dir(dir);
    }
    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| format!("启动 bun 进程失败：{e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Error(err) => stderr.push_str(&err),
            CommandEvent::Terminated(payload) => code = payload.code,
            _ => {}
        }
    }

    Ok((stdout, stderr, code))
}

/// 读出 bun 的版本号（经 `bun --version`）。
async fn get_bun_version(app: &AppHandle, bun_root: &Path) -> Option<String> {
    let (stdout, _stderr, code) = run_bun_sidecar(app, bun_root, vec!["--version".into()], None).await.ok()?;
    if code != Some(0) {
        return None;
    }
    let v = stdout.trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// 读取 `bun_root/node_modules` 下已安装的全部依赖（名称 + 版本）。
///
/// 处理普通包与 scoped 包（`@scope/name`）；跳过 `.bin` 等辅助目录。
/// 读取每个包的 `package.json` 的 `version` 字段，缺字段/解析失败则跳过。
fn read_installed_packages(bun_root: &Path) -> Vec<PackageInfo> {
    let mut pkgs: Vec<PackageInfo> = Vec::new();
    let nm = bun_root.join("node_modules");
    let entries = match std::fs::read_dir(&nm) {
        Ok(e) => e,
        Err(_) => return pkgs,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if name == ".bin" {
            continue;
        }
        if name.starts_with('@') {
            // scoped 包：node_modules/@scope/<pkg>
            if let Ok(sub) = std::fs::read_dir(&path) {
                for se in sub.flatten() {
                    let subname = se.file_name().to_string_lossy().to_string();
                    let subpath = se.path();
                    if !subpath.is_dir() {
                        continue;
                    }
                    if let Some(v) = read_pkg_version(&subpath) {
                        pkgs.push(PackageInfo {
                            name: format!("{}/{}", name, subname),
                            version: v,
                        });
                    }
                }
            }
            continue;
        }
        if let Some(v) = read_pkg_version(&path) {
            pkgs.push(PackageInfo { name, version: v });
        }
    }
    pkgs.sort_by(|a, b| a.name.cmp(&b.name));
    pkgs
}

/// 读取某包目录 `package.json` 的 `version` 字段。
fn read_pkg_version(dir: &Path) -> Option<String> {
    let pj = dir.join("package.json");
    let content = std::fs::read_to_string(&pj).ok()?;
    let v: JsonValue = serde_json::from_str(&content).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 步骤三：确保默认环境就绪（幂等）。
#[tauri::command]
pub async fn init_bun_env(app: AppHandle, mgr: State<'_, BunManager>) -> Result<String, String> {
    let (bun_root, _pkg) = mgr.setup(&app)?;
    // 确保 node_modules 目录存在（依赖安装根）。
    std::fs::create_dir_all(bun_root.join("node_modules"))
        .map_err(|e| format!("创建 node_modules 失败：{e}"))?;
    Ok("Node 沙箱环境（default）已就绪。".into())
}

/// 查询某环境当前已安装的依赖。
#[tauri::command]
pub async fn list_bun_packages(
    app: AppHandle,
    mgr: State<'_, BunManager>,
    env_name: Option<String>,
) -> Result<Vec<PackageInfo>, String> {
    let (bun_root, _pkg) = mgr.setup(&app)?;
    let _env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());
    let nm = bun_root.join("node_modules");
    if !nm.exists() {
        return Ok(vec![]);
    }
    Ok(read_installed_packages(&bun_root))
}

/// 向 `default` 环境追加安装依赖。
#[tauri::command]
pub async fn install_bun_packages(
    app: AppHandle,
    mgr: State<'_, BunManager>,
    env_name: Option<String>,
    packages: Vec<String>,
) -> Result<String, String> {
    let (bun_root, _pkg) = mgr.setup(&app)?;
    if packages.is_empty() {
        return Err("未指定任何要安装的依赖。".into());
    }
    let _env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // cwd = bun_root 使 `bun add` 将依赖写入该工程根。
    let mut args = vec!["add".into()];
    for p in &packages {
        args.push(p.clone());
    }
    let (stdout, stderr, code) =
        run_bun_sidecar(&app, &bun_root, args, Some(&bun_root)).await?;
    match code {
        Some(0) => Ok(format!("依赖安装完成：{}\n{}", packages.join(", "), stdout)),
        Some(c) => Err(format!("依赖安装失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖安装进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 从 `default` 环境移除指定依赖。
#[tauri::command]
pub async fn uninstall_bun_packages(
    app: AppHandle,
    mgr: State<'_, BunManager>,
    env_name: Option<String>,
    packages: Vec<String>,
) -> Result<String, String> {
    let (bun_root, _pkg) = mgr.setup(&app)?;
    if packages.is_empty() {
        return Err("未指定任何要移除的依赖。".into());
    }
    let _env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    let mut args = vec!["remove".into()];
    for p in &packages {
        args.push(p.clone());
    }
    let (stdout, stderr, code) =
        run_bun_sidecar(&app, &bun_root, args, Some(&bun_root)).await?;
    match code {
        Some(0) => Ok(format!("依赖移除完成：{}\n{}", packages.join(", "), stdout)),
        Some(c) => Err(format!("依赖移除失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖移除进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 清空 `default` 环境的全部依赖（删除 node_modules + 清空 package.json 依赖项）。
/// 单一环境允许此操作——它只清依赖，不删 Bun 运行时本身。
#[tauri::command]
pub async fn reset_bun_env(
    app: AppHandle,
    mgr: State<'_, BunManager>,
    env_name: Option<String>,
) -> Result<String, String> {
    let (bun_root, pkg) = mgr.setup(&app)?;
    let _env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    let nm = bun_root.join("node_modules");
    if nm.exists() {
        std::fs::remove_dir_all(&nm).map_err(|e| format!("清理 node_modules 失败：{e}"))?;
    }
    // 重置 package.json 的依赖字段（保留 name/version 结构）。
    let new_pkg = "{\n  \"name\": \"workduo-bun-runtime\",\n  \"version\": \"1.0.0\",\n  \"private\": true,\n  \"dependencies\": {}\n}\n";
    std::fs::write(&pkg, new_pkg).map_err(|e| format!("重置 package.json 失败：{e}"))?;
    std::fs::create_dir_all(&nm).map_err(|e| format!("重建 node_modules 失败：{e}"))?;
    Ok("Node 环境依赖已清空（运行时保留）。".into())
}

/// 删除环境接口：Node 为单一运行时环境，删除无意义，直接拒绝以保持与「单一环境」设计一致。
#[tauri::command]
pub async fn delete_bun_env(
    _app: AppHandle,
    _mgr: State<'_, BunManager>,
    _env_name: String,
) -> Result<String, String> {
    Err("Node 沙箱为单一运行时环境（Bun 二进制即运行时），不可删除。如需清空依赖请使用「重置」。".into())
}

/// 从脚本 stderr 中解析缺失包名（任何检测到的缺失包都返回，不做白名单过滤），支持 Bun 常见报错格式。
fn missing_modules(stderr: &str) -> Option<Vec<String>> {
    let mut found: BTreeSet<String> = Default::default();
    for line in stderr.lines() {
        let line = line.trim();
        for pat in [
            "Cannot find package \"",
            "Could not resolve \"",
            "Module not found: \"",
        ] {
            if let Some(rest) = line.strip_prefix(pat) {
                if let Some(name) = rest.split('"').next() {
                    let name = name.trim();
                    if !name.is_empty() {
                        found.insert(name.to_string());
                    }
                }
            }
        }
    }
    if found.is_empty() {
        None
    } else {
        Some(found.into_iter().collect())
    }
}

/// 静默向 default 环境安装依赖（复用 `bun add`，不暴露 Tauri 命令通道）。
async fn install_packages_silent(
    app: &AppHandle,
    bun_root: &Path,
    packages: &[String],
) -> Result<String, String> {
    let mut args = vec!["add".into()];
    for s in packages {
        args.push(s.clone());
    }
    let (_stdout, stderr, code) =
        run_bun_sidecar(app, bun_root, args, Some(bun_root)).await?;
    match code {
        Some(0) => Ok(packages.join(", ")),
        Some(c) => Err(format!("依赖安装失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖安装进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 在某环境中执行脚本，并在因缺失依赖失败时**自动按需安装并重试一次**（不限白名单）。
async fn run_script_with_selfheal(
    app: &AppHandle,
    bun_root: &Path,
    tmp_path: &Path,
    cwd: Option<&Path>,
) -> Result<ScriptRunResult, String> {
    let args = vec![tmp_path.to_string_lossy().to_string()];
    let (stdout, stderr, code) = run_bun_sidecar(app, bun_root, args, cwd).await?;
    if code != Some(0) {
        if let Some(mods) = missing_modules(&stderr) {
            tracing::info!(
                "[agent] run_node: 检测到缺失依赖 {:?}，尝试自动安装后重试一次",
                mods
            );
            match install_packages_silent(app, bun_root, &mods).await {
                Ok(specs) => {
                    tracing::info!("[agent] run_node: 已自动安装依赖（{}），重试执行", specs);
                    let args2 = vec![tmp_path.to_string_lossy().to_string()];
                    let (o2, e2, c2) = run_bun_sidecar(app, bun_root, args2, cwd).await?;
                    return match c2 {
                        Some(0) => Ok(ScriptRunResult { stdout: o2, exit_code: c2 }),
                        Some(c) => Err(format!("脚本执行失败（退出码 {c}）：\n{e2}")),
                        None => Err(format!("脚本进程异常终止，未收到退出码：\n{e2}")),
                    };
                }
                Err(e) => tracing::info!("[agent] run_node: 自动安装缺失依赖失败：{e}"),
            }
        }
    }
    match code {
        Some(0) => Ok(ScriptRunResult { stdout, exit_code: code }),
        Some(c) => Err(format!("脚本执行失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("脚本进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 在某环境中调度并执行指定 JS/TS 脚本（Tauri 命令入口，供「设置→Node」页面调用）。
#[tauri::command]
pub async fn run_node_script(
    app: AppHandle,
    mgr: State<'_, BunManager>,
    env_name: Option<String>,
    script_path: String,
) -> Result<String, String> {
    let (bun_root, _pkg) = mgr.setup(&app)?;
    let _env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    let script = PathBuf::from(&script_path);
    if !script.exists() {
        return Err(format!("脚本文件不存在：{script_path}"));
    }
    let original_parent = script.parent().map(|p| p.to_path_buf());

    // 关键修复：改为「原地执行」脚本，不再复制到 run_tmp。
    // 旧实现把脚本复制到 bun_root/run_tmp/ 后运行，导致 ESM 相对导入
    // （如 `import { add } from './calc.js'`）按临时目录解析，同目录兄弟模块永远找不到。
    // 原地执行后，相对导入按脚本真实所在目录解析，恢复「同目录 import」语义；
    // 已安装依赖（bun_root/node_modules）的解析由 run_bun_sidecar 注入的 NODE_PATH 兜底。
    // cwd 设为原脚本所在目录，便于脚本内相对路径文件操作仍按原位置解析。
    let result = run_script_with_selfheal(&app, &bun_root, &script, original_parent.as_deref()).await;
    // 用户侧 Tauri 命令保持「返回 stdout 字符串」契约不变（前端 invoke 依赖），
    // 退出码/结构化结果仅供 agent 运行时（run_node_in_sandbox）使用。
    result.map(|r| r.stdout)
}

/// 供智能体运行时直接调用的沙箱执行入口（**非 Tauri 命令**，供 `agent::native` 复用）。
pub async fn run_node_in_sandbox(
    app: &AppHandle,
    mgr: &BunManager,
    env_name: Option<String>,
    script_path: String,
    cwd: Option<&Path>,
) -> Result<ScriptRunResult, String> {
    let (bun_root, _pkg) = mgr.setup(app)?;
    let _env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    let script = PathBuf::from(&script_path);
    if !script.exists() {
        return Err(format!("脚本文件不存在：{script_path}"));
    }
    let original_parent = script.parent().map(|p| p.to_path_buf());

    // 关键修复：与原地执行一致（见 run_node_script）。不再复制到 run_tmp，
    // 否则同目录相对导入（./calc.js）会按临时目录解析而失败；已安装依赖解析由 NODE_PATH 兜底。
    // 有效工作目录：Agent 注入的 cwd（通常为工作空间根）优先；未提供时回退到脚本所在目录（UI 行为）。
    let result = run_script_with_selfheal(app, &bun_root, &script, cwd.or(original_parent.as_deref())).await;
    result
}

/// 查询单个环境元信息（是否存在 / Bun 版本 / 依赖数）。
async fn build_env_info(app: &AppHandle, bun_root: &Path, is_default: bool) -> EnvInfo {
    let exists = bun_root.exists();
    let bun_version = if exists {
        get_bun_version(app, bun_root).await
    } else {
        None
    };
    let package_count = if exists {
        read_installed_packages(bun_root).len()
    } else {
        0
    };
    EnvInfo {
        name: DEFAULT_ENV.to_string(),
        is_default,
        exists,
        bun_version,
        package_count,
    }
}

/// 列出全部 Node 运行环境（始终仅 `default`，驱动「沙箱环境 / Node」卡片）。
#[tauri::command]
pub async fn list_bun_envs(app: AppHandle, mgr: State<'_, BunManager>) -> Result<Vec<EnvInfo>, String> {
    let (bun_root, _pkg) = mgr.setup(&app)?;
    let envs = vec![build_env_info(&app, &bun_root, true).await];
    Ok(envs)
}

/// 应用启动时在后台确保 `default` 默认环境根就绪（不阻塞启动，失败仅日志）。
pub async fn ensure_default_bun(app: &AppHandle) -> Result<(), String> {
    let mgr = BunManager::new();
    let (bun_root, _pkg) = mgr.setup(app)?;
    std::fs::create_dir_all(bun_root.join("node_modules"))
        .map_err(|e| format!("创建 node_modules 失败：{e}"))?;
    Ok(())
}
