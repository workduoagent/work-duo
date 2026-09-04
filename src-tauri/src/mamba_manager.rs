//! 内嵌 Micromamba 的纯绿色便携 Python 运行时管理。
//!
//! 设计目标：所有运行时文件（环境、依赖包、配置）严格落在 Tauri 资源目录
//! （`$RESOURCES`，即 `app.path().resource_dir()`）下的 `mamba_root`，
//! 绝不向系统目录（AppData / 用户目录）写入任何数据，
//! 软件文件夹整体拷走即可在另一台电脑直接运行。
//!
//! 对外暴露命令（均 `async fn`，不阻塞 UI）：
//! - `init_mamba_env`：创建最纯净的 Python 环境（默认 `default` + `python=3.11`，不预装第三方库）
//! - `list_mamba_envs`：列出全部环境元信息（名称 / 是否默认 / 是否存在 / Python 版本 / 依赖数），驱动卡片展示
//! - `list_mamba_packages`：查询某环境当前已安装的依赖（名称 + 版本）
//! - `install_mamba_packages`：向某环境追加安装依赖（支持 `numpy`、`pandas=2.2` 等规格）
//! - `uninstall_mamba_packages`：从某环境移除指定依赖
//! - `reset_mamba_env`：重置某环境（删除后重建为纯净 python，清空所有依赖）
//! - `run_python_script`：在某环境中执行指定 Python 脚本，返回 stdout / stderr
//! - `delete_mamba_env`：删除指定环境（受保护的 `default` 除外）
//!
//! 所有命令均支持可选 `env_name`（默认 `default`）与（init / reset 专用的）可选 `python_version`
//! （默认 `3.11`）；不传则等价于默认行为，调用方按需覆盖即可创建多版本 / 多套独立环境。
//!
//! `default` 是 Agent 默认环境：应用启动时自动静默创建（见 [`ensure_default_env`]），
//! 且**禁止删除 / 禁止重置**，仅允许在其上安装 / 卸载依赖，供 Agent 稳定复用。
//!
//! 通过 Tauri Sidecar 调用 `binaries/micromamba`，所有命令强制附加 `--root-prefix` 与
//! `--rc-file`（**必须位于子命令之前**，否则会被 `run` 的 `python` 当作目标程序参数而失效，
//! 回退到内置默认根前缀 `AppData`），确保环境与镜像源完全受控、且不影响用户本机已有配置。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// 默认受管环境名：调用方未指定 `env_name` 时使用。
const DEFAULT_ENV: &str = "default";
/// 默认 Python 版本：调用方未指定 `python_version` 时使用。
const DEFAULT_PYTHON: &str = "3.11";

/// 允许运行时自动按需安装的常用数据科学库白名单（防止任意 pip 安装失控）。
/// Agent 脚本因 `ModuleNotFoundError` 失败时，仅当缺失模块命中此表才会自动安装并重试，
/// 这与 `init_mamba_env`「纯净环境、按需追加依赖」的设计初衷一致（见模块注释）。
const AUTO_INSTALL_ALLOW: &[&str] = &[
    "requests",
    "numpy",
    "pandas",
    "openpyxl",
    "xlsxwriter",
    "scipy",
    "statsmodels",
    "matplotlib",
    "seaborn",
    "yfinance",
    "ccxt",
    "scikit-learn",
    "sklearn",
    "pyyaml",
    "yaml",
    "json5",
    "tqdm",
];

/// 单个已安装依赖的元信息（供 `list_mamba_packages` 结构化返回）。
#[derive(Serialize)]
pub struct PackageInfo {
    /// 包名（如 `python`、`numpy`）。
    pub name: String,
    /// 版本号（如 `3.11.9`、`2.2.0`）。
    pub version: String,
}

/// 单个 Python 运行环境的元信息（供 `list_mamba_envs` 结构化返回，驱动卡片展示）。
#[derive(Serialize)]
pub struct EnvInfo {
    /// 环境名（如 `default`、`py39`）。
    pub name: String,
    /// 是否为 Agent 默认环境（受保护：不可删除 / 不可重置）。
    pub is_default: bool,
    /// 环境目录是否存在（是否已创建）。
    pub exists: bool,
    /// Python 版本（仅 `exists=true` 时有值，如 `3.11.9`）。
    pub python_version: Option<String>,
    /// 已安装依赖数量（仅 `exists=true` 时有意义）。
    pub package_count: usize,
}

/// 绿色便携运行时管理器。
///
/// 不持有任何路径字段——根目录在每次命令执行时根据 Tauri 的 `resource_dir()`
/// 动态推导（回退到 exe 父目录），保证「随应用打包、随应用迁移」，绝不会落到 AppData。
/// 实例在 `lib.rs` 启动时构造并交由 Tauri 托管（`manage`），命令通过 `State` 注入。
pub struct MambaManager {}

impl MambaManager {
    pub fn new() -> Self {
        Self {}
    }

    /// 解析根目录：优先 Tauri 资源目录（即 `$RESOURCES`，随应用打包迁移），
    /// 获取失败则回退到当前 exe 的父目录。二者均不会落到 AppData / 用户目录，
    /// 满足「纯绿色便携」要求。
    fn base_dir(app: &AppHandle) -> PathBuf {
        if let Ok(res) = app.path().resource_dir() {
            return res;
        }
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    /// 步骤一 + 步骤二：在 `$RESOURCES/mamba_root` 下创建运行时目录并校验写入权限；
    /// 若缺失则生成 `.mambarc`。返回 `(mamba_root, rc_file)` 两个已就绪的路径。
    /// 权限被拒时返回友好提示，引导用户将软件移动到非系统盘（如 D 盘）。
    fn setup(&self, app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
        let base_dir = Self::base_dir(app);
        let mamba_root = base_dir.join("mamba_root");

        // 步骤一：尝试在资源目录创建 mamba_root，校验写入权限。
        if let Err(e) = std::fs::create_dir_all(&mamba_root) {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                return Err(
                    "当前安装目录无写入权限，请将软件移动到 D 盘或其他非系统目录".into(),
                );
            }
            return Err(format!("创建运行时目录失败：{e}"));
        }

        // 步骤二：若 .mambarc 不存在，动态写入国内镜像源配置。
        let rc = base_dir.join(".mambarc");
        if !rc.exists() {
            let content = r#"channels:
  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/
  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/
  - defaults
show_channel_urls: true
ssl_verify: true
"#;
            std::fs::write(&rc, content).map_err(|e| format!("写入 .mambarc 失败：{e}"))?;
        }
        Ok((mamba_root, rc))
    }
}

/// 通用：spawn micromamba sidecar，异步收集 stdout / stderr，进程结束后返回三元组。
///
/// 全程使用 `spawn()` + `CommandEvent` 异步流，不阻塞调用线程；中文路径经
/// `to_string_lossy()` 转换，避免非法 UTF-8 导致 panic。
///
/// `cwd` 为可选工作目录（经由 `CreateProcess` 传入，原生支持 Unicode，不进入
/// micromamba 的 `cmd` 命令行，因此即使含中文也安全）。
async fn run_sidecar(
    app: &AppHandle,
    args: Vec<String>,
    cwd: Option<&Path>,
) -> Result<(String, String, Option<i32>), String> {
    let mut cmd = app
        .shell()
        .sidecar("micromamba")
        .map_err(|e| format!("准备 micromamba sidecar 失败：{e}"))?
        .args(args);
    if let Some(dir) = cwd {
        cmd = cmd.current_dir(dir);
    }
    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| format!("启动 micromamba 进程失败：{e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None; // 未收到 Terminated 时记为 None（异常）

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

/// 构造 micromamba **全局选项**，必须位于子命令之前：
/// `--root-prefix <mamba_root>` 与 `--rc-file <.mambarc>`。
///
/// 关键陷阱：micromamba 的全局选项若写在子命令之后（尤其 `run` 的 `python <脚本>` 之后），
/// 会被当作目标程序的参数而完全失效，进而回退到内置默认根前缀（AppData），
/// 导致「环境找不到 / 落到 AppData」。因此这里统一前置，所有命令都先拼全局选项再拼子命令。
fn global_args(mamba_root: &Path, rc: &Path) -> Vec<String> {
    vec![
        "--root-prefix".into(),
        mamba_root.to_string_lossy().to_string(),
        "--rc-file".into(),
        rc.to_string_lossy().to_string(),
    ]
}

/// 步骤三：最纯净 Python 环境的静默创建。
///
/// 设计原则：**只创建最小可用环境**（仅解释器本身），不预装任何第三方库。
/// 具体业务需要哪些依赖，由 Agent 或用户后续通过 [`install_mamba_packages`] 按需追加。
///
/// - `env_name`：目标环境名，**可选**，缺省为 `default`。
/// - `python_version`：Python 版本规格（如 `3.11` / `3.9`），**可选**，缺省为 `3.11`。
///
/// 若 `mamba_root/envs/<env_name>` 已存在则直接返回成功（幂等）；
/// 否则通过 sidecar 异步执行 `micromamba create -n <env> python=<ver> -y`，
/// 强制携带 `--root-prefix` 与 `--rc-file`。非 0 退出码收集 stderr 返回。
#[tauri::command]
pub async fn init_mamba_env(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: Option<String>,
    python_version: Option<String>,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());
    let py = python_version.unwrap_or_else(|| DEFAULT_PYTHON.to_string());

    let env_path = mamba_root.join("envs").join(&env);
    if env_path.exists() {
        return Ok(format!("{env} 环境已存在，无需重复创建。"));
    }

    // 全局选项（root-prefix + rc-file）必须前置；仅安装解释器本身，
    // 第三方依赖交给后续的 install_mamba_packages。
    let mut args = global_args(&mamba_root, &rc);
    args.extend([
        "create".into(),
        "-n".into(),
        env.clone(),
        format!("python={py}"),
        "-y".into(),
    ]);

    let (stdout, stderr, code) = run_sidecar(&app, args, None).await?;
    match code {
        Some(0) => Ok(format!(
            "Python 环境（{env}）创建完成（纯净环境，仅含 python={py}）。\n{stdout}"
        )),
        Some(c) => Err(format!("创建 Python 环境失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("创建 Python 环境进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 步骤三·补：查询某环境当前已安装的全部依赖。
///
/// - `env_name`：目标环境名，**可选**，缺省为 `default`。
///
/// 通过 `micromamba list -n <env>` 解析出「包名 + 版本」列表。
/// 环境尚未创建时明确报错，避免无意义的 list 调用。
#[tauri::command]
pub async fn list_mamba_packages(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: Option<String>,
) -> Result<Vec<PackageInfo>, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 环境不存在时明确提示，引导先 init。
    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    let mut args = global_args(&mamba_root, &rc);
    args.extend(["list".into(), "-n".into(), env.clone()]);

    let (stdout, stderr, code) = run_sidecar(&app, args, None).await?;
    match code {
        Some(0) => parse_package_list(&stdout),
        Some(c) => Err(format!("查询依赖列表失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("查询依赖列表进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 步骤三·补：向某环境追加安装依赖。
///
/// - `env_name`：目标环境名，**可选**，缺省为 `default`。
/// - `packages`：依赖规格数组，支持 `numpy`、`pandas=2.2`、`requests>=2.31` 等形式，
///   由 Agent 或用户按需传入。
///
/// 通过 `micromamba install -n <env> <pkgs> -y` 执行。
/// 环境尚未创建 / 列表为空时分别给出明确错误。
#[tauri::command]
pub async fn install_mamba_packages(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: Option<String>,
    packages: Vec<String>,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    if packages.is_empty() {
        return Err("未指定任何要安装的依赖。".into());
    }

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 环境不存在时明确提示，避免 install 落到未知位置。
    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    let mut args = global_args(&mamba_root, &rc);
    args.extend(["install".into(), "-n".into(), env.clone(), "-y".into()]);
    for p in &packages {
        args.push(p.clone());
    }

    let (stdout, stderr, code) = run_sidecar(&app, args, None).await?;
    match code {
        Some(0) => Ok(format!(
            "依赖安装完成：{}\n{}",
            packages.join(", "),
            stdout
        )),
        Some(c) => Err(format!("依赖安装失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖安装进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 步骤三·补：从某环境移除指定依赖。
///
/// - `env_name`：目标环境名，**可选**，缺省为 `default`。
/// - `packages`：待移除的包名/规格数组。
///
/// 经 `micromamba remove -n <env> <pkgs> -y` 执行。
/// 空数组 / 环境未建时分别给出明确错误。
#[tauri::command]
pub async fn uninstall_mamba_packages(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: Option<String>,
    packages: Vec<String>,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    if packages.is_empty() {
        return Err("未指定任何要移除的依赖。".into());
    }

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 环境不存在时明确提示，避免 remove 落到未知位置。
    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    let mut args = global_args(&mamba_root, &rc);
    args.extend(["remove".into(), "-n".into(), env.clone(), "-y".into()]);
    for p in &packages {
        args.push(p.clone());
    }

    let (stdout, stderr, code) = run_sidecar(&app, args, None).await?;
    match code {
        Some(0) => Ok(format!("依赖移除完成：{}\n{}", packages.join(", "), stdout)),
        Some(c) => Err(format!("依赖移除失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖移除进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 步骤三·补：重置某环境 —— 清空所有依赖。
///
/// - `env_name`：目标环境名，**可选**，缺省为 `default`。
/// - `python_version`：重建时使用的 Python 版本，**可选**，缺省为 `3.11`。
///
/// 实现为「删除整个环境 → 重建为最纯净的 python」，与 [`init_mamba_env`] 终态完全一致。
/// 若环境不存在则直接进入重建阶段；两段命令经 `run_sidecar` 依次异步执行。
#[tauri::command]
pub async fn reset_mamba_env(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: Option<String>,
    python_version: Option<String>,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());
    let py = python_version.unwrap_or_else(|| DEFAULT_PYTHON.to_string());

    // 受保护默认环境不允许重置，避免 Agent 默认环境被整体清空。
    if env == DEFAULT_ENV {
        return Err(format!(
            "「{}」是 Agent 默认环境，不允许重置；如需清理依赖请使用「卸载依赖」。",
            DEFAULT_ENV
        ));
    }

    // 阶段一：若环境已存在，先整体移除（不存在则跳过，不报错）。
    // 注意全局选项必须前置。
    let env_path = mamba_root.join("envs").join(&env);
    if env_path.exists() {
        let mut rm_args = global_args(&mamba_root, &rc);
        rm_args.extend([
            "env".into(),
            "remove".into(),
            "-n".into(),
            env.clone(),
            "-y".into(),
        ]);
        let (_, stderr, code) = run_sidecar(&app, rm_args, None).await?;
        match code {
            Some(0) => {}
            Some(c) => {
                return Err(format!("移除旧环境失败（退出码 {c}）：\n{stderr}"))
            }
            None => {
                return Err(format!("移除旧环境进程异常终止，未收到退出码：\n{stderr}"))
            }
        }
    }

    // 阶段二：重建最纯净环境。
    let mut create_args = global_args(&mamba_root, &rc);
    create_args.extend([
        "create".into(),
        "-n".into(),
        env.clone(),
        format!("python={py}"),
        "-y".into(),
    ]);
    let (stdout, stderr, code) = run_sidecar(&app, create_args, None).await?;
    match code {
        Some(0) => Ok(format!(
            "{env} 已重置为纯净环境（仅 python={py}），所有旧依赖已清空。\n{stdout}"
        )),
        Some(c) => Err(format!("重建环境失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("重建环境进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 解析 `micromamba list` 的文本表格输出，提取每行的前两列（Name / Version）。
///
/// 跳过空行与以 `#` 开头的表头/分隔行；列不足两项的残缺行直接忽略，
/// 保证返回结构稳定可序列化。
fn parse_package_list(stdout: &str) -> Result<Vec<PackageInfo>, String> {
    let mut pkgs = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // 有效包行至少含 Name + Version 两列。
        if tokens.len() < 2 {
            continue;
        }
        pkgs.push(PackageInfo {
            name: tokens[0].to_string(),
            version: tokens[1].to_string(),
        });
    }
    Ok(pkgs)
}

/// 把 import 名归一化为可被 micromamba 安装的包名（处理常见别名）。
fn normalize_pkg(name: &str) -> String {
    match name {
        "sklearn" => "scikit-learn",
        "yaml" => "pyyaml",
        "crypto" => "pycryptodome",
        "PIL" => "pillow",
        _ => name,
    }
    .to_string()
}

/// 从脚本 stderr 中解析 `ModuleNotFoundError: No module named 'X'`，返回命中自动安装
/// 白名单的顶层模块名集合（如 `sklearn.linear_model` → `sklearn`）。无命中则返回 None。
fn missing_modules(stderr: &str) -> Option<Vec<String>> {
    let mut found: std::collections::BTreeSet<String> = Default::default();
    for line in stderr.lines() {
        let line = line.trim();
        let rest = line
            .strip_prefix("ModuleNotFoundError: No module named")
            .or_else(|| line.strip_prefix("ImportError: No module named"))
            .or_else(|| line.strip_prefix("ModuleNotFoundError: No module named '"))
            .or_else(|| line.strip_prefix("ImportError: cannot import name"));
        if let Some(rest) = rest {
            let name = rest
                .trim()
                .trim_matches('\'')
                .trim_matches('"')
                .trim();
            // 处理子模块（sklearn.linear_model → sklearn）
            let top = name.split('.').next().unwrap_or(name).trim();
            if top.is_empty() {
                continue;
            }
            if AUTO_INSTALL_ALLOW.contains(&top) {
                found.insert(normalize_pkg(top));
            }
        }
    }
    if found.is_empty() {
        None
    } else {
        Some(found.into_iter().collect())
    }
}

/// 构造 `micromamba run -n <env> python <tmp>` 的参数列表（全局选项前置）。
fn build_run_args(mamba_root: &Path, rc: &Path, env: &str, tmp_path: &Path) -> Vec<String> {
    let mut args = global_args(mamba_root, rc);
    args.extend([
        "run".into(),
        "-n".into(),
        env.to_string(),
        "python".into(),
        tmp_path.to_string_lossy().to_string(),
    ]);
    args
}

/// 静默向指定环境安装依赖（复用 micromamba install，不暴露 Tauri 命令通道）。
async fn install_packages_silent(
    app: &AppHandle,
    mgr: &MambaManager,
    env: &str,
    packages: &[String],
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(app)?;
    let env_path = mamba_root.join("envs").join(env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，无法安装依赖。"));
    }
    let specs: Vec<String> = packages.iter().map(|p| normalize_pkg(p)).collect();
    let mut args = global_args(&mamba_root, &rc);
    args.extend(["install".into(), "-n".into(), env.to_string(), "-y".into()]);
    for s in &specs {
        args.push(s.clone());
    }
    let (_stdout, stderr, code) = run_sidecar(app, args, None).await?;
    match code {
        Some(0) => Ok(specs.join(", ")),
        Some(c) => Err(format!("依赖安装失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖安装进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 在某环境中执行脚本，并在因缺失白名单内第三方库失败时**自动按需安装并重试一次**。
///
/// 这是「纯净环境 + 按需追加依赖」设计的最终闭环：Agent 直接 `import pandas` 即可，
/// 运行时首次缺失时透明安装（仅限白名单），无需用户或模型手动安装系统包。
/// 非库缺失类错误（语法错 / 逻辑错 / 网络错）不触发安装，原样返回。
async fn run_script_with_selfheal(
    app: &AppHandle,
    mgr: &MambaManager,
    mamba_root: &Path,
    rc: &Path,
    env: &str,
    tmp_path: &Path,
    cwd: Option<&Path>,
) -> Result<String, String> {
    let args = build_run_args(mamba_root, rc, env, tmp_path);
    let (stdout, stderr, code) = run_sidecar(app, args, cwd).await?;
    if code != Some(0) {
        if let Some(mods) = missing_modules(&stderr) {
            println!(
                "[agent] run_python: 检测到缺失库 {:?}，尝试自动安装后重试一次",
                mods
            );
            match install_packages_silent(app, mgr, env, &mods).await {
                Ok(specs) => {
                    println!("[agent] run_python: 已自动安装依赖（{}），重试执行", specs);
                    let args2 = build_run_args(mamba_root, rc, env, tmp_path);
                    let (o2, e2, c2) = run_sidecar(app, args2, cwd).await?;
                    return match c2 {
                        Some(0) => Ok(o2),
                        Some(c) => Err(format!("脚本执行失败（退出码 {c}）：\n{e2}")),
                        None => Err(format!("脚本进程异常终止，未收到退出码：\n{e2}")),
                    };
                }
                Err(e) => println!("[agent] run_python: 自动安装缺失库失败：{e}"),
            }
        }
    }
    match code {
        Some(0) => Ok(stdout),
        Some(c) => Err(format!("脚本执行失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("脚本进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 步骤四：在某环境中调度并执行指定 Python 脚本。
///
/// - `env_name`：目标环境名，**可选**，缺省为 `default`。
/// - `script_path`：脚本绝对路径。
///
/// 构建 `micromamba run -n <env> python <script_path>`（同样携带 `--root-prefix` 与 `--rc-file`），
/// 异步捕获输出。成功返回完整 stdout；失败（含非 0 退出码）返回完整 stderr。
#[tauri::command]
pub async fn run_python_script(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: Option<String>,
    script_path: String,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 脚本文件存在性校验，并记住其所在目录（作为运行工作目录，保证脚本内相对路径生效）。
    let script = PathBuf::from(&script_path);
    if !script.exists() {
        return Err(format!("脚本文件不存在：{script_path}"));
    }
    let original_parent = script.parent().map(|p| p.to_path_buf());

    // 目标环境存在性校验，避免 run 落到未知/损坏的环境。
    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    // Windows 兼容性关键修复：micromamba `run` 在 Windows 上经由 `cmd /C` 外壳执行命令，
    // 当脚本路径含中文等非 ASCII 字符时，路径被拼入 cmd 命令行后会因编码问题被拆坏，
    // 导致激活阶段设置环境变量的命令碎片被当成命令执行（典型报错
    // `'okens' is not recognized ...` / `'OENCODING' ...`）。
    // 解决办法：把脚本复制到一个纯 ASCII 临时文件（位于 $RESOURCES 下的
    // `mamba_root/run_tmp/`，保证 ASCII），用临时路径喂给 micromamba；同时把工作目录设为
    // 原脚本所在目录（经 CreateProcess 传入，原生 Unicode 安全），使脚本内相对文件操作
    // 仍按原路径解析。运行结束（无论成败）清理该临时文件。
    let run_tmp = mamba_root.join("run_tmp");
    std::fs::create_dir_all(&run_tmp)
        .map_err(|e| format!("创建脚本运行临时目录失败：{e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = run_tmp.join(format!("__sandbox_run_{stamp}.py"));
    std::fs::copy(&script, &tmp_path)
        .map_err(|e| format!("复制脚本到临时文件失败：{e}"))?;

    // 关键：全局选项（root-prefix / rc-file）必须位于 `run` 子命令及 `python` 之前，
    // 否则会被当作传给 python 的参数而失效，micromamba 回退到 AppData 默认前缀。
    // 执行与缺失库自愈统一走 run_script_with_selfheal（含临时脚本清理）。
    let result = run_script_with_selfheal(
        &app,
        mgr.inner(),
        &mamba_root,
        &rc,
        &env,
        &tmp_path,
        original_parent.as_deref(),
    )
    .await;
    let _ = std::fs::remove_file(&tmp_path);
    result
}

/// 供智能体运行时直接调用的沙箱执行入口（**非 Tauri 命令**，供 `agent::native` 模块复用）。
///
/// 逻辑与 `run_python_script` 命令完全一致，但签名去掉 `AppHandle`/`State`，由调用方注入
/// `app` 与 `mgr`，避免在原生工具 trait 里走命令通道（跨 `async` 调用更简洁、可单测）。
pub async fn run_python_in_sandbox(
    app: &AppHandle,
    mgr: &MambaManager,
    env_name: Option<String>,
    script_path: String,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(app)?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    let script = PathBuf::from(&script_path);
    if !script.exists() {
        return Err(format!("脚本文件不存在：{script_path}"));
    }
    let original_parent = script.parent().map(|p| p.to_path_buf());

    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    let run_tmp = mamba_root.join("run_tmp");
    std::fs::create_dir_all(&run_tmp).map_err(|e| format!("创建脚本运行临时目录失败：{e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = run_tmp.join(format!("__sandbox_run_{stamp}.py"));
    std::fs::copy(&script, &tmp_path).map_err(|e| format!("复制脚本到临时文件失败：{e}"))?;

    // 执行与缺失库自愈统一走 run_script_with_selfheal（含临时脚本清理）。
    let result = run_script_with_selfheal(
        app,
        mgr,
        &mamba_root,
        &rc,
        &env,
        &tmp_path,
        original_parent.as_deref(),
    )
    .await;
    let _ = std::fs::remove_file(&tmp_path);
    result
}

/// 查询单个环境的元信息（是否存在 / Python 版本 / 依赖数）。
///
/// 环境目录不存在时直接返回 `exists=false`（无需调用 micromamba）；
/// 存在时经 `micromamba list -n <env>` 解析出 python 版本与依赖总数。
async fn build_env_info(
    app: &AppHandle,
    mamba_root: &Path,
    rc: &Path,
    name: &str,
    is_default: bool,
) -> Result<EnvInfo, String> {
    let env_path = mamba_root.join("envs").join(name);
    if !env_path.exists() {
        return Ok(EnvInfo {
            name: name.to_string(),
            is_default,
            exists: false,
            python_version: None,
            package_count: 0,
        });
    }

    let mut args = global_args(mamba_root, rc);
    args.extend(["list".into(), "-n".into(), name.to_string()]);
    let (stdout, _stderr, code) = run_sidecar(app, args, None).await?;
    if code != Some(0) {
        // list 失败（极少）时退化为「存在但信息未知」，避免卡片整体缺失。
        return Ok(EnvInfo {
            name: name.to_string(),
            is_default,
            exists: true,
            python_version: None,
            package_count: 0,
        });
    }

    let pkgs = parse_package_list(&stdout).unwrap_or_default();
    let python_version = pkgs
        .iter()
        .find(|p| p.name == "python")
        .map(|p| p.version.clone());
    Ok(EnvInfo {
        name: name.to_string(),
        is_default,
        exists: true,
        python_version,
        package_count: pkgs.len(),
    })
}

/// 列出全部 Python 运行环境，驱动「沙箱环境」页面的卡片网格展示。
///
/// 始终包含受保护的 `default` 环境（即使尚未创建，也以 `exists=false` 呈现，
/// 引导用户在卡片上点击「创建」）；其余环境取 `mamba_root/envs` 下的子目录。
#[tauri::command]
pub async fn list_mamba_envs(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
) -> Result<Vec<EnvInfo>, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;
    let mut envs: Vec<EnvInfo> = Vec::new();

    // 受保护默认环境始终在列首。
    envs.push(build_env_info(&app, &mamba_root, &rc, DEFAULT_ENV, true).await?);

    // 其余已存在的环境目录。
    let envs_dir = mamba_root.join("envs");
    if let Ok(entries) = std::fs::read_dir(&envs_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == DEFAULT_ENV {
                continue;
            }
            if entry.path().is_dir() {
                envs.push(build_env_info(&app, &mamba_root, &rc, &name, false).await?);
            }
        }
    }

    Ok(envs)
}

/// 删除指定 Python 运行环境（整体移除其目录）。
///
/// - `env_name`：**必填**，目标环境名。
/// - 受保护的 `default` 环境拒绝删除；不存在的环境给出明确错误。
#[tauri::command]
pub async fn delete_mamba_env(
    app: AppHandle,
    mgr: State<'_, MambaManager>,
    env_name: String,
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(&app)?;

    // 受保护默认环境不允许删除。
    if env_name == DEFAULT_ENV {
        return Err(format!("「{}」是 Agent 默认环境，不允许删除。", DEFAULT_ENV));
    }

    let env_path = mamba_root.join("envs").join(&env_name);
    if !env_path.exists() {
        return Err(format!("环境「{}」不存在，无法删除。", env_name));
    }

    let mut args = global_args(&mamba_root, &rc);
    args.extend([
        "env".into(),
        "remove".into(),
        "-n".into(),
        env_name.clone(),
        "-y".into(),
    ]);
    let (_, stderr, code) = run_sidecar(&app, args, None).await?;
    match code {
        Some(0) => Ok(format!("环境「{}」已删除。", env_name)),
        Some(c) => Err(format!("删除环境失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("删除环境进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 应用启动时在后台确保 `default` 默认环境存在。
///
/// 若 `mamba_root/envs/default` 已存在则直接返回；否则静默创建纯净
/// `python=3.11` 环境（与 [`init_mamba_env`] 终态一致）。任何失败仅返回 Err，
/// 由调用方（setup 钩子）记录日志，不阻塞应用启动。
pub async fn ensure_default_env(app: &AppHandle) -> Result<(), String> {
    let mgr = MambaManager::new();
    let (mamba_root, rc) = mgr.setup(app)?;

    let env_path = mamba_root.join("envs").join(DEFAULT_ENV);
    if env_path.exists() {
        return Ok(());
    }

    let mut args = global_args(&mamba_root, &rc);
    args.extend([
        "create".into(),
        "-n".into(),
        DEFAULT_ENV.to_string(),
        format!("python={}", DEFAULT_PYTHON),
        "-y".into(),
    ]);
    let (_, stderr, code) = run_sidecar(app, args, None).await?;
    match code {
        Some(0) => Ok(()),
        Some(c) => Err(format!("创建默认环境失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("创建默认环境进程异常终止，未收到退出码：\n{stderr}")),
    }
}
