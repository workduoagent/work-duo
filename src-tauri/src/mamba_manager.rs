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
use crate::agent::engine::tools::ScriptRunResult;

/// 默认受管环境名：调用方未指定 `env_name` 时使用。
const DEFAULT_ENV: &str = "default";
/// 默认 Python 版本：调用方未指定 `python_version` 时使用。
const DEFAULT_PYTHON: &str = "3.11";

/// 镜像源逃生开关：`WD_MAMBA_MIRROR=ustc|tuna|official` 强制指定镜像；
/// 缺省（或 `auto`）按 [`MIRRORS`] 顺序探活自动选择。
const MIRROR_ENV: &str = "WD_MAMBA_MIRROR";

/// 单个镜像源档案。
///
/// - `id`：稳定标识，写入 `.mambarc` 注释行（`# workduo-mamba-mirror: <id>`）用于识别与黑名单。
/// - `channels`：写入 `.mambarc` 的 channel 列表，顺序即优先级。
/// - `probe`：探活样本 URL（各镜像都有的 `noarch/repodata.json`，体量小、命中率高）。
struct MirrorProfile {
    id: &'static str,
    label: &'static str,
    channels: &'static [&'static str],
    probe: &'static str,
}

/// 镜像源候选（**按优先级排列**）。
///
/// 背景（2026-10-01 实测）：清华 TUNA 的 anaconda 镜像对 micromamba 这类非浏览器 UA
/// 直接返回 **403**（HTML 提示「您访问使用的软件带有非常用软件的特征」），导致
/// `micromamba create` 全部 subdir 加载失败。故默认改为中科大（实测 200），
/// 清华降为次选（仅在其恢复时命中），最后用官方源兜底（境外，慢但最稳）。
/// 阿里云 / 腾讯云已下线 `/anaconda/...` 路径（实测 404），不再纳入候选。
const MIRRORS: &[MirrorProfile] = &[
    MirrorProfile {
        id: "ustc",
        label: "中科大",
        channels: &[
            "https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge/",
            "https://mirrors.ustc.edu.cn/anaconda/pkgs/main/",
            "https://mirrors.ustc.edu.cn/anaconda/pkgs/msys2/",
        ],
        probe: "https://mirrors.ustc.edu.cn/anaconda/pkgs/main/noarch/repodata.json",
    },
    MirrorProfile {
        id: "tuna",
        label: "清华",
        channels: &[
            "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/",
            "https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/",
            "https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/msys2/",
        ],
        probe: "https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/noarch/repodata.json",
    },
    MirrorProfile {
        id: "official",
        label: "官方源",
        channels: &[
            "https://conda.anaconda.org/conda-forge/",
            "https://repo.anaconda.com/pkgs/main/",
            "https://repo.anaconda.com/pkgs/msys2/",
        ],
        probe: "https://repo.anaconda.com/pkgs/main/noarch/repodata.json",
    },
];

/// 本进程已选定的镜像源 id（避免每次 setup 都发起探活请求）。
static CHOSEN_MIRROR: std::sync::OnceLock<std::sync::Mutex<Option<String>>> = std::sync::OnceLock::new();
/// 本次进程内已判定不可用的镜像源 id（换源重试时不再选中）。
static DEAD_MIRRORS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();

fn chosen_slot() -> &'static std::sync::Mutex<Option<String>> {
    CHOSEN_MIRROR.get_or_init(|| std::sync::Mutex::new(None))
}

fn dead_slot() -> &'static std::sync::Mutex<Vec<String>> {
    DEAD_MIRRORS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

fn chosen_mirror_id() -> Option<String> {
    chosen_slot().lock().ok().and_then(|g| g.clone())
}

fn set_chosen_mirror(id: &str) {
    if let Ok(mut g) = chosen_slot().lock() {
        *g = Some(id.to_string());
    }
}

fn clear_chosen_mirror() {
    if let Ok(mut g) = chosen_slot().lock() {
        *g = None;
    }
}

fn is_dead_mirror(id: &str) -> bool {
    dead_slot()
        .lock()
        .map(|g| g.iter().any(|d| d == id))
        .unwrap_or(false)
}

/// 标记某镜像源不可用（换源重试前调用，保证下一次选择不会再次命中它）。
fn mark_mirror_dead(id: &str) {
    if let Ok(mut g) = dead_slot().lock() {
        if !g.iter().any(|d| d == id) {
            g.push(id.to_string());
        }
    }
}

/// 生成 `.mambarc` 内容：首行注释写明「自动生成、手改会被覆盖」，第二行为镜像标识
/// （`# workduo-mamba-mirror: <id>`），供 [`rc_mirror_id`] 反解，实现「已生成则复用、失效则换源」。
fn rc_content(m: &MirrorProfile) -> String {
    let mut s = String::from("# 由 WorkDuo 自动生成：镜像源由启动探活选择，手动修改会被覆盖。\n");
    s.push_str(&format!("# workduo-mamba-mirror: {}\n", m.id));
    s.push_str("channels:\n");
    for c in m.channels {
        s.push_str(&format!("  - {c}\n"));
    }
    s.push_str("show_channel_urls: true\n");
    s.push_str("ssl_verify: true\n");
    s
}

/// 从 `.mambarc` 内容反解镜像源 id（无法识别返回 None，如用户手写的旧文件）。
fn rc_mirror_id(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|l| l.trim().strip_prefix("# workduo-mamba-mirror:"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 写入 `.mambarc`（内容一致时跳过，避免无意义的文件 mtime 抖动）。
fn write_rc(rc: &Path, m: &MirrorProfile) -> Result<(), String> {
    let content = rc_content(m);
    if std::fs::read_to_string(rc).map(|c| c == content).unwrap_or(false) {
        return Ok(());
    }
    std::fs::write(rc, content).map_err(|e| format!("写入 .mambarc 失败：{e}"))
}

/// 探活：GET 该镜像的 repodata 样本，2xx 视为可用。
///
/// 平台自身操作（环境管理 / 依赖安装）不受沙箱断网策略影响，此处为 Rust 侧直连，
/// 未注入任何代理阻断 env。单次 8s 超时，网络异常一律按「不可用」处理（不阻塞启动）。
async fn mirror_alive(m: &MirrorProfile) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client
        .get(m.probe)
        .header(reqwest::header::USER_AGENT, "WorkDuo/1.0")
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// 确保 `.mambarc` 指向一个**当前可用**的镜像源，返回该镜像档案。
///
/// 选择顺序：
/// 1. `WD_MAMBA_MIRROR` 强制指定（跳过探活，尊重用户显式选择）；
/// 2. 本进程已选定过（缓存在 [`CHOSEN_MIRROR`]，同一进程内只探活一次）；
/// 3. 已存在的 `.mambarc`：反解其镜像 id 并探活，仍可用则**原样复用**（零网络开销的稳态路径）；
/// 4. 按 [`MIRRORS`] 顺序探活，取第一个可用者写入（已标记为 dead 的源跳过）；
/// 5. 全部不可用（离线场景）：已有配置则保留，否则写入首选镜像，把错误交给 micromamba 报出。
async fn ensure_mambarc(rc: &Path) -> Result<&'static MirrorProfile, String> {
    // 1) 环境变量强制指定
    if let Ok(v) = std::env::var(MIRROR_ENV) {
        let v = v.trim().to_ascii_lowercase();
        if matches!(v.as_str(), "auto" | "") {
            // 显式 auto：走自动流程
        } else if let Some(m) = MIRRORS.iter().find(|m| m.id == v) {
            write_rc(rc, m)?;
            set_chosen_mirror(m.id);
            return Ok(m);
        } else {
            tracing::warn!("[mamba] {MIRROR_ENV}={v} 无法识别（可选 ustc/tuna/official），回退自动选择");
        }
    }

    // 2) 本进程已选定
    if let Some(id) = chosen_mirror_id() {
        if let Some(m) = MIRRORS.iter().find(|m| m.id == id) {
            write_rc(rc, m)?;
            return Ok(m);
        }
    }

    // 3) 已有配置：反解镜像 id 后探活复用
    let existing_id = std::fs::read_to_string(rc)
        .ok()
        .and_then(|c| rc_mirror_id(&c));
    if let Some(id) = existing_id {
        if let Some(m) = MIRRORS.iter().find(|m| m.id == id) {
            if !is_dead_mirror(m.id) && mirror_alive(m).await {
                set_chosen_mirror(m.id);
                return Ok(m);
            }
            tracing::warn!("[mamba] 镜像源 {}（{}）探活失败，尝试切换其他镜像", m.id, m.label);
        }
    }

    // 4) 顺序探活，取第一个可用者
    for m in MIRRORS.iter() {
        if is_dead_mirror(m.id) {
            continue;
        }
        if mirror_alive(m).await {
            write_rc(rc, m)?;
            set_chosen_mirror(m.id);
            tracing::info!("[mamba] 已选择镜像源：{}（{}）", m.id, m.label);
            return Ok(m);
        }
    }

    // 5) 全不可用（离线）：保留原配置，否则写首选
    let fallback = &MIRRORS[0];
    if !rc.exists() {
        write_rc(rc, fallback)?;
    }
    Ok(fallback)
}

/// 判定 stderr 是否属于「镜像源故障」——只有这类失败才值得换源重试，
/// 语法错 / 依赖冲突 etc. 换源无意义（避免无谓的二次探活与等待）。
fn is_mirror_failure(stderr: &str) -> bool {
    let s = stderr;
    s.contains("403")
        || s.contains("404")
        || s.contains("repodata")
        || s.contains("Subdir")
        || s.contains("not loaded")
        || s.contains("Transfer finalized")
        || s.contains("Connection")
        || s.contains("timed out")
}

/// 换源：把当前镜像标记为 dead、清空进程内选择，重新走 [`ensure_mambarc`]。
/// 返回切换后的新镜像（与旧镜像不同才算切换成功）。
async fn rotate_mirror(rc: &Path) -> Option<&'static MirrorProfile> {
    let old = chosen_mirror_id().or_else(|| {
        std::fs::read_to_string(rc)
            .ok()
            .and_then(|c| rc_mirror_id(&c))
    });
    if let Some(id) = &old {
        mark_mirror_dead(id);
    }
    clear_chosen_mirror();
    match ensure_mambarc(rc).await {
        Ok(m) if Some(m.id.to_string()) != old => {
            tracing::warn!("[mamba] 镜像源切换：{:?} → {}（{}），重试一次", old, m.id, m.label);
            Some(m)
        }
        _ => None,
    }
}

/// 执行一条 micromamba 命令；若失败且判定为镜像源故障，自动换源后**重试一次**。
///
/// `make_args` 由调用方给出（依赖 `mamba_root` / `rc` 构造参数），保证换源后用新
/// `--rc-file` 重新执行同一语义的命令。
pub(crate) async fn run_mamba_with_mirror_fallback<F>(
    app: &AppHandle,
    mamba_root: &Path,
    rc: &Path,
    make_args: F,
) -> Result<(String, String, Option<i32>), String>
where
    F: Fn(&Path, &Path) -> Vec<String>,
{
    let (stdout, stderr, code) = run_sidecar(app, make_args(mamba_root, rc), None, &[]).await?;
    if code == Some(0) {
        return Ok((stdout, stderr, code));
    }
    if !is_mirror_failure(&stderr) {
        return Ok((stdout, stderr, code));
    }
    match rotate_mirror(rc).await {
        Some(_) => run_sidecar(app, make_args(mamba_root, rc), None, &[]).await,
        None => Ok((stdout, stderr, code)),
    }
}

/// 沙箱依赖安装：不做白名单限制。任何检测到的缺失模块都交由 selfheal 自动安装
/// （`micromamba install`），用户明确：沙箱就该自由装依赖，限白名单等于阉割沙箱。


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
    /// 并确保 `.mambarc` 指向一个**当前可用**的镜像源（见 [`ensure_mambarc`]）。
    /// 返回 `(mamba_root, rc_file)` 两个已就绪的路径。
    /// 权限被拒时返回友好提示，引导用户将软件移动到非系统盘（如 D 盘）。
    ///
    /// 说明：此函数为 `async` —— 首次调用（或已选镜像失效时）需要对候选镜像发起
    /// 一次轻量探活，避免写死单一镜像后「镜像挂了就永久建不了环境」。
    pub(crate) async fn setup(&self, app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
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

        // 步骤二：确保 .mambarc 指向可用镜像源（探活结果在本进程内缓存，稳态不产生网络开销）。
        let rc = base_dir.join(".mambarc");
        ensure_mambarc(&rc).await?;
        Ok((mamba_root, rc))
    }
}

/// 沙箱网络策略（2026-09-24 网络默认关批次，G 系列审计无界实证的拦截层）。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NetPolicy {
    /// 运行用户脚本：注入无效代理 + sitecustomize 禁 socket（进程级默认离线）。
    Blocked,
    /// 平台自身操作（依赖安装 / 环境管理 / 版本探测）：保持联网，行为不变。
    Allow,
}

/// 逃生开关：`WD_SANDBOX_NET=on` 时全程不注入断网 env（放行脚本联网，用于用户显式要求
/// 沙箱联网的任务）。缺省 off = 断网生效。
pub(crate) fn net_block_enabled() -> bool {
    std::env::var("WD_SANDBOX_NET")
        .map(|v| !v.trim().eq_ignore_ascii_case("on"))
        .unwrap_or(true)
}

/// 逃生开关（文件系统有界）：`WD_SANDBOX_FS=off` 时全程不注入 fs-guard。
/// 缺省启用 = 仅工作空间与系统临时目录可写。
pub(crate) fn fs_block_enabled() -> bool {
    std::env::var("WD_SANDBOX_FS")
        .map(|v| !v.trim().eq_ignore_ascii_case("off"))
        .unwrap_or(true)
}

/// 断网注入 env：代理指向 discard 端口 127.0.0.1:9——所有遵守代理环境变量的
/// HTTP 库（requests/urllib/httpx/axios/fetch）连接立即失败。raw socket 由
/// Python 侧 sitecustomize 守卫兜底（Bun 侧无同款机制，由观测层兜底）。
pub(crate) fn net_block_envs() -> Vec<(String, String)> {
    const DEAD: &str = "http://127.0.0.1:9";
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
        .iter()
        .map(|k| (k.to_string(), DEAD.to_string()))
        .chain([
            ("NO_PROXY".to_string(), String::new()),
            ("no_proxy".to_string(), String::new()),
        ])
        .collect()
}

/// Python 沙箱守卫：`sitecustomize.py` 由解释器启动时自动 import（早于一切用户 import）。
/// 两段独立启用：
/// - `WD_SANDBOX_NET_GUARD=1`：monkey-patch socket 层——raw socket / create_connection /
///   getaddrinfo（含 DNS）全禁（网络默认关）。
/// - `WD_SANDBOX_FS_GUARD=1`：patch builtins.open（写模式）/ os / shutil / pathlib /
///   tarfile / zipfile 的写/删/移/解压入口——白名单（工作空间 + 系统临时目录）之外
///   直接 PermissionError（文件系统有界）。运行时拦截，exec/eval 动态构造同样被覆盖。
const SANDBOX_GUARD_SITECUSTOMIZE: &str = r#"# WorkDuo 沙箱守卫（mamba_manager 注入 PYTHONPATH + 标记 env 启用）
import os as _os

# ---- 网络默认关 ----
if _os.environ.get("WD_SANDBOX_NET_GUARD") == "1":
    def _net_blocked(*_args, **_kwargs):
        raise RuntimeError(
            "沙箱默认离线：脚本网络访问已被禁用（平台侧 WD_SANDBOX_NET=on 可放行）。"
            "需要外部数据请改用 http_request 工具（带 SSRF 防护）。"
        )

    import socket as _socket

    # 必须用「可继承的类」替换 socket.socket：ssl.py 等标准库会 `class SSLSocket(socket)`
    # 继承——替换成普通函数会让 import 期直接 TypeError（G-M1 实证）。实例化时才 raise。
    class _BlockedSocket:
        def __init__(self, *args, **kwargs):
            raise RuntimeError(
                "沙箱默认离线：脚本网络访问已被禁用（平台侧 WD_SANDBOX_NET=on 可放行）。"
                "需要外部数据请改用 http_request 工具（带 SSRF 防护）。"
            )

    _socket.socket = _BlockedSocket
    _socket.create_connection = _net_blocked
    _socket.getaddrinfo = _net_blocked

# ---- 文件系统有界 ----
if _os.environ.get("WD_SANDBOX_FS_GUARD") == "1":
    import builtins as _builtins
    import tempfile as _tempfile

    def _norm(p):
        return _os.path.abspath(_os.fspath(p)).replace("/", "\\").rstrip("\\").lower()

    _allows = []
    for _p in (_os.environ.get("WD_SANDBOX_WS", ""), _tempfile.gettempdir()):
        if _p:
            try:
                _allows.append(_norm(_p))
            except Exception:
                pass

    def _fs_guarded(*paths):
        for path in paths:
            try:
                p = _norm(path)
            except Exception:
                continue
            if not any(p == a or p.startswith(a + "\\") for a in _allows):
                raise PermissionError(
                    "沙箱文件系统有界：写入/删除 %s 超出允许范围（仅工作空间与系统临时目录可写）。" % p
                )

    _WRITE_MODE = ("w", "a", "x", "+")

    # builtins.open / Path.open：写模式才校验（读不限）
    _orig_open = _builtins.open

    def _guarded_open(file, mode="r", *a, **k):
        if isinstance(file, (str, bytes)) or hasattr(file, "__fspath__"):
            m = mode if isinstance(mode, str) else ""
            if any(c in m for c in _WRITE_MODE):
                _fs_guarded(file)
        return _orig_open(file, mode, *a, **k)

    _builtins.open = _guarded_open

    # os：删除 / 建目录（单路径）+ 改名 / 替换（src+dst 双查）
    for _name in ("remove", "unlink", "rmdir", "removedirs", "mkdir", "makedirs"):
        _orig = getattr(_os, _name, None)
        if _orig:
            def _mk1(fn):
                def _g(path, *a, **k):
                    _fs_guarded(path)
                    return fn(path, *a, **k)
                return _g
            setattr(_os, _name, _mk1(_orig))
    for _name in ("rename", "replace"):
        _orig = getattr(_os, _name, None)
        if _orig:
            def _mk2(fn):
                def _g(src, dst, *a, **k):
                    _fs_guarded(src, dst)
                    return fn(src, dst, *a, **k)
                return _g
            setattr(_os, _name, _mk2(_orig))

    # shutil：删除 / 移动 / 拷贝（写端校验）
    try:
        import shutil as _shutil
        for _name in ("rmtree", "unlink", "copytree"):
            _orig = getattr(_shutil, _name, None)
            if _orig:
                def _mk1s(fn):
                    def _g(path, *a, **k):
                        _fs_guarded(path)
                        return fn(path, *a, **k)
                    return _g
                setattr(_shutil, _name, _mk1s(_orig))
        for _name in ("copy", "copy2", "move"):
            _orig = getattr(_shutil, _name, None)
            if _orig:
                def _mkd(fn):
                    def _g(src, dst, *a, **k):
                        _fs_guarded(src, dst)
                        return fn(src, dst, *a, **k)
                    return _g
                setattr(_shutil, _name, _mkd(_orig))
    except Exception:
        pass

    # pathlib.Path：写方法 + 写模式 open + 改名
    try:
        import pathlib as _pathlib
        _P = _pathlib.Path
        for _name in ("write_text", "write_bytes", "touch", "mkdir", "unlink", "rmdir"):
            _orig = getattr(_P, _name, None)
            if _orig:
                def _mkp(fn):
                    def _g(self, *a, **k):
                        _fs_guarded(self)
                        return fn(self, *a, **k)
                    return _g
                setattr(_P, _name, _mkp(_orig))
        _orig_popen = _P.open

        def _guarded_popen(self, mode="r", *a, **k):
            m = mode if isinstance(mode, str) else ""
            if any(c in m for c in _WRITE_MODE):
                _fs_guarded(self)
            return _orig_popen(self, mode, *a, **k)

        _P.open = _guarded_popen
        for _name in ("rename", "replace"):
            _orig = getattr(_P, _name, None)
            if _orig:
                def _mkp2(fn):
                    def _g(self, dst, *a, **k):
                        _fs_guarded(self, dst)
                        return fn(self, dst, *a, **k)
                    return _g
                setattr(_P, _name, _mkp2(_orig))
    except Exception:
        pass

    # 解压类：tarfile / zipfile 的落盘目录校验
    try:
        import tarfile as _tarfile
        _orig_tex = _tarfile.TarFile.extractall

        def _tar_ex(self, path=".", *a, **k):
            _fs_guarded(path)
            return _orig_tex(self, path, *a, **k)

        _tarfile.TarFile.extractall = _tar_ex
        _tarfile.TarFile.extract = _tar_ex
    except Exception:
        pass
    try:
        import zipfile as _zipfile
        _orig_zex = _zipfile.ZipFile.extractall

        def _zip_ex(self, path=".", *a, **k):
            _fs_guarded(path)
            return _orig_zex(self, path, *a, **k)

        _zipfile.ZipFile.extractall = _zip_ex
        _zipfile.ZipFile.extract = _zip_ex
    except Exception:
        pass
"#;

/// 确保沙箱守卫目录与 sitecustomize.py 在位（幂等，内容漂移时重写），返回 guard 目录字符串。
/// 沙箱守卫状态快照（供设置页展示；台账 P0-3）。
/// `bun_network_isolated: false` 为**产品口径明示**：Bun 侧无 socket patch，
/// 网络隔离不承诺（观测层 sandbox_audit 兜底），见 SANDBOX_GUARD_JS 头注。
pub fn guard_status_snapshot() -> serde_json::Value {
    let fs_blocked = fs_block_enabled();
    let net_blocked = net_block_enabled();
    serde_json::json!({
        "fsGuard": fs_blocked,
        "netGuard": net_blocked,
        "escapeNetOn": !net_blocked,
        "escapeFsOff": !fs_blocked,
        "bunNetworkIsolated": false,
    })
}

pub(crate) fn ensure_sandbox_guard(mamba_root: &Path) -> Result<String, String> {
    let dir = mamba_root.join("net-guard");
    let file = dir.join("sitecustomize.py");
    let stale = match std::fs::read_to_string(&file) {
        Ok(cur) => cur != SANDBOX_GUARD_SITECUSTOMIZE,
        Err(_) => true,
    };
    if stale {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建 net-guard 目录失败：{e}"))?;
        std::fs::write(&file, SANDBOX_GUARD_SITECUSTOMIZE)
            .map_err(|e| format!("写入 sitecustomize.py 失败：{e}"))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

/// 为「运行用户脚本」组装沙箱守卫版 extra_envs：
/// - 网络默认关：代理阻断 env + net-guard 标记（`WD_SANDBOX_NET=on` 放行）；
/// - 文件系统有界：fs-guard 标记 + `WD_SANDBOX_WS=<cwd>` 白名单 + `PYTHONDONTWRITEBYTECODE=1`
///   （防 run_tmp 下 pycache 写入被误拦；`WD_SANDBOX_FS=off` 放行）；
/// - PYTHONPATH 前置合并 guard 目录（Windows 分号分隔；不覆盖调用方已有的
///   PYTHONPATH 修复 import 语义）。
fn with_sandbox_guards(
    mamba_root: &Path,
    extra_envs: &[(String, String)],
    cwd: Option<&Path>,
) -> Result<Vec<(String, String)>, String> {
    let mut envs: Vec<(String, String)> = extra_envs.to_vec();
    let guard = ensure_sandbox_guard(mamba_root)?;
    // net 段
    if net_block_enabled() {
        for (k, v) in net_block_envs() {
            envs.push((k, v));
        }
        envs.push(("WD_SANDBOX_NET_GUARD".to_string(), "1".to_string()));
    }
    // fs 段
    if fs_block_enabled() {
        envs.push(("WD_SANDBOX_FS_GUARD".to_string(), "1".to_string()));
        if let Some(ws) = cwd {
            envs.push(("WD_SANDBOX_WS".to_string(), ws.to_string_lossy().to_string()));
        }
        envs.push(("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string()));
    }
    // PYTHONPATH 前置合并 guard 目录
    match envs.iter_mut().find(|(k, _)| k == "PYTHONPATH") {
        Some((_, v)) if !v.is_empty() => *v = format!("{};{}", guard, v),
        Some((_, v)) => *v = guard,
        None => envs.push(("PYTHONPATH".to_string(), guard)),
    }
    Ok(envs)
}

/// 通用：spawn micromamba sidecar，异步收集 stdout / stderr，进程结束后返回三元组。
///
/// 全程使用 `spawn()` + `CommandEvent` 异步流，不阻塞调用线程；中文路径经
/// `to_string_lossy()` 转换，避免非法 UTF-8 导致 panic。
///
/// `cwd` 为可选工作目录（经由 `CreateProcess` 传入，原生支持 Unicode，不进入
/// micromamba 的 `cmd` 命令行，因此即使含中文也安全）。
/// `extra_envs` 为附加环境变量（如 `PYTHONPATH`），透传给被执行的 python 进程，
/// 用于修复「脚本被复制到临时目录后同目录 import 失效」等问题。
///
/// 网络策略默认 `Allow`（平台自身操作保持联网）；运行用户脚本请用
/// `run_sidecar_policy(..., NetPolicy::Blocked)`。
async fn run_sidecar(
    app: &AppHandle,
    args: Vec<String>,
    cwd: Option<&Path>,
    extra_envs: &[(String, String)],
) -> Result<(String, String, Option<i32>), String> {
    run_sidecar_policy(app, args, cwd, extra_envs, NetPolicy::Allow, "").await
}

/// 执行一条沙箱侧命令并收集输出。
///
/// F049：新增 `run_id` 支持**用户主动取消**——与硬超时共用同一个
/// `select!`（取舍2：超时与取消是同一个等待分支的两条竞速路径）。
/// 取消时先杀进程组（子进程也会被终止），再 kill 兜底。
///
/// 返回 `(stdout, stderr, exit_code)`；`exit_code` 为 `None` 表示未收到
/// `Terminated` 事件（异常终止，或本次是被超时/取消打断的）。
async fn run_sidecar_policy(
    app: &AppHandle,
    args: Vec<String>,
    cwd: Option<&Path>,
    extra_envs: &[(String, String)],
    net: NetPolicy,
    run_id: &str,
) -> Result<(String, String, Option<i32>), String> {
    let mut cmd = app
        .shell()
        .sidecar("micromamba")
        .map_err(|e| format!("准备 micromamba sidecar 失败：{e}"))?
        .args(args);
    if let Some(dir) = cwd {
        cmd = cmd.current_dir(dir);
    }
    for (k, v) in extra_envs {
        cmd = cmd.env(k, v);
    }
    if net == NetPolicy::Blocked && net_block_enabled() {
        for (k, v) in net_block_envs() {
            cmd = cmd.env(k, v);
        }
    }
    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("启动 micromamba 进程失败：{e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None; // 未收到 Terminated 时记为 None（异常）

    // 沙箱执行硬超时（2026-09-24 沙箱审计）：此前 while rx.recv() 永等且无 Kill 路径，
    // `while True` 类脚本会挂死工具调用直至 run 级兜底（子进程成孤儿继续跑）。
    // 可配 WD_SANDBOX_TIMEOUT_SECS（默认 600s，覆盖常见 ETL/测试场景）。
    let sandbox_timeout: u64 = std::env::var("WD_SANDBOX_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(600);
    // F049：订阅本run 的取消信号（spawn 之后订阅，此时 run_id 已在注册表里）。
    let mut cancel_rx = crate::script_cancel::subscribe_cancel(run_id);

    // F049：超时与取消共用一个 select（取舍 2）—— 两者都是「抢同一个等待」。
    // Interrupted 三态：None=自然结束 / Some("timeout") / Some("cancelled")。
    // 注意 timeout 分支须把「是否超时」透出，故用 Option<Result<..>> 包一层。
    let interrupted: Option<Result<(), ()>> = tokio::select! {
        res = tokio::time::timeout(std::time::Duration::from_secs(sandbox_timeout), async {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
                    CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
                    CommandEvent::Error(err) => stderr.push_str(&err),
                    CommandEvent::Terminated(payload) => code = payload.code,
                    _ => {}
                }
            }
        // timeout 分支：Err(Elapsed) = 超时，Ok = 进程自然结束（后者整体返回 None）。
        // 统一收敛成 Option<Result<(), ()>>：Some(Err)=超时 / Some(Ok)=取消 / None=自然结束。
        }) => res.err().map(|_| Err(())),
        _ = recv_cancel(&mut cancel_rx) => Some(Ok(())),  // 取消
    };

    if let Some(res) = interrupted {
        // 取舍 1：先杀整组（连带 pip/npm 的子进程），再 kill 兜底
        crate::script_cancel::kill_process_tree(child.pid());
        let _ = child.kill();
        return match res {
            Err(()) => Err(format!(
                "沙箱脚本执行超时（{}s），已强制终止进程。长任务请拆分或分段落盘中间结果。",
                sandbox_timeout
            )),
            // 🔴 F049 收尾修复：取消不是「错误」，但契约限制下必须走 Err 通道
            // （前端 invoke 拿的是 stdout 字符串，没有结构化返回位）。
            // 故在消息前加机器可读的稳定前缀 `CANCELLED:`，前端据此判定状态，
            // 不再靠 `includes('已取消')` 匹配中文——文案一改就失效（真机实测已失效）。
            Ok(()) => Err(format!(
                "{}沙箱脚本已被用户取消，进程已终止。",
                crate::script_cancel::CANCELLED_PREFIX
            )),
        };
    }

    Ok((stdout, stderr, code))
}

/// 等待取消信号；返回端已关闭（run 已注销）时视为「无取消」并挂起，
/// 避免 `rx.recv()` 返回 `Err(Lagged/Closed)` 造成 select 分支误触发。
pub(crate) async fn recv_cancel(rx: &mut Option<tokio::sync::broadcast::Receiver<()>>) {
    match rx {
        Some(r) => {
            // 循环直到真收到信号：Closed/Lagged 都继续等
            loop {
                match r.recv().await {
                    Ok(()) => return,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // 注册表已清理且无其他订阅者：视为不再会收到取消，
                        // 挂起等待直到外层 timeout 分支兜底。
                        std::future::pending::<()>().await
                    }
                }
            }
        }
        None => std::future::pending::<()>().await,
    }
}

/// 构造 micromamba **全局选项**，必须位于子命令之前：
/// `--root-prefix <mamba_root>` 与 `--rc-file <.mambarc>`。
///
/// 关键陷阱：micromamba 的全局选项若写在子命令之后（尤其 `run` 的 `python <脚本>` 之后），
/// 会被当作目标程序的参数而完全失效，进而回退到内置默认根前缀（AppData），
/// 导致「环境找不到 / 落到 AppData」。因此这里统一前置，所有命令都先拼全局选项再拼子命令。
pub(crate) fn global_args(mamba_root: &Path, rc: &Path) -> Vec<String> {
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());
    let py = python_version.unwrap_or_else(|| DEFAULT_PYTHON.to_string());

    let env_path = mamba_root.join("envs").join(&env);
    if env_path.exists() {
        return Ok(format!("{env} 环境已存在，无需重复创建。"));
    }

    // 全局选项（root-prefix + rc-file）必须前置；仅安装解释器本身，
    // 第三方依赖交给后续的 install_mamba_packages。
    // 镜像源故障（403 / repodata 加载失败）自动换源重试一次。
    let env_c = env.clone();
    let py_c = py.clone();
    let (stdout, stderr, code) = run_mamba_with_mirror_fallback(
        &app,
        &mamba_root,
        &rc,
        |root, rc| {
            let mut a = global_args(root, rc);
            a.extend([
                "create".into(),
                "-n".into(),
                env_c.clone(),
                format!("python={py_c}"),
                "-y".into(),
            ]);
            a
        },
    )
    .await?;
    match code {
        Some(0) => Ok(format!(
            "Python 环境（{env}）创建完成（纯净环境，仅含 python={py}）。\n{stdout}"
        )),
        Some(c) => Err(format!(
            "创建 Python 环境失败（退出码 {c}）：\n{stderr}\n（已自动尝试切换镜像源；仍失败可用环境变量 {MIRROR_ENV}=official 强制官方源）"
        )),
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 环境不存在时明确提示，引导先 init。
    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    let mut args = global_args(&mamba_root, &rc);
    args.extend(["list".into(), "-n".into(), env.clone()]);

    let (stdout, stderr, code) = run_sidecar(&app, args, None, &[]).await?;
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

    if packages.is_empty() {
        return Err("未指定任何要安装的依赖。".into());
    }

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 环境不存在时明确提示，避免 install 落到未知位置。
    let env_path = mamba_root.join("envs").join(&env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，请先调用 init_mamba_env。"));
    }

    // 安装同样走换源重试：镜像 repodata 403 是安装失败的高频原因。
    let env_c = env.clone();
    let pkgs_c = packages.clone();
    let (stdout, stderr, code) = run_mamba_with_mirror_fallback(
        &app,
        &mamba_root,
        &rc,
        |root, rc| {
            let mut a = global_args(root, rc);
            a.extend(["install".into(), "-n".into(), env_c.clone(), "-y".into()]);
            for p in &pkgs_c {
                a.push(p.clone());
            }
            a
        },
    )
    .await?;
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

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

    let (stdout, stderr, code) = run_sidecar(&app, args, None, &[]).await?;
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

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
        let (_, stderr, code) = run_sidecar(&app, rm_args, None, &[]).await?;
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

    // 阶段二：重建最纯净环境（镜像源故障自动换源重试一次）。
    let env_c = env.clone();
    let py_c = py.clone();
    let (stdout, stderr, code) = run_mamba_with_mirror_fallback(
        &app,
        &mamba_root,
        &rc,
        |root, rc| {
            let mut a = global_args(root, rc);
            a.extend([
                "create".into(),
                "-n".into(),
                env_c.clone(),
                format!("python={py_c}"),
                "-y".into(),
            ]);
            a
        },
    )
    .await?;
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

/// 从脚本 stderr 中解析 `ModuleNotFoundError: No module named 'X'`，返回检测到的缺失
/// 顶层模块名集合（如 `sklearn.linear_model` → `sklearn`）。沙箱对依赖安装不做白名单限制，
/// 任何检测到的缺失模块都会交由 selfheal 自动安装。
pub(crate) fn missing_modules(stderr: &str) -> Option<Vec<String>> {
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
            found.insert(normalize_pkg(top));
        }
    }
    if found.is_empty() {
        None
    } else {
        Some(found.into_iter().collect())
    }
}

/// 构造 `micromamba run -n <env> python <tmp>` 的参数列表（全局选项前置）。
pub(crate) fn build_run_args(mamba_root: &Path, rc: &Path, env: &str, tmp_path: &Path) -> Vec<String> {
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

/// 构造注入 python 运行的 `PYTHONPATH` 环境变量。
///
/// 背景：脚本被复制到 `run_tmp` 后由 `python <tmp>` 执行，Python 的 `sys.path[0]`
/// 指向临时目录而非原始目录，导致「同目录 `import calc`」这类兄弟模块导入失效
/// （`ModuleNotFoundError: No module named 'calc'`）。
///
/// 修复：把「脚本原始所在目录」与「有效工作目录（通常为工作空间根）」追加进模块搜索路径，
/// 等价于「在原始位置直接运行脚本」的语义，使 `import` 同目录/工作空间级模块恢复可用。
fn pythonpath_env(
    original_parent: Option<&Path>,
    cwd: Option<&Path>,
) -> Result<Vec<(String, String)>, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(p) = original_parent {
        if !dirs.iter().any(|d| d == p) {
            dirs.push(p.to_path_buf());
        }
    }
    if let Some(c) = cwd {
        if !dirs.iter().any(|d| d == c) {
            dirs.push(c.to_path_buf());
        }
    }
    if dirs.is_empty() {
        return Ok(Vec::new());
    }
    let joined = std::env::join_paths(&dirs)
        .map_err(|e| format!("构造 PYTHONPATH 失败：{e}"))?
        .to_string_lossy()
        .to_string();
    Ok(vec![("PYTHONPATH".to_string(), joined)])
}

/// 静默向指定环境安装依赖（复用 micromamba install，不暴露 Tauri 命令通道）。
pub(crate) async fn install_packages_silent(
    app: &AppHandle,
    mgr: &MambaManager,
    env: &str,
    packages: &[String],
) -> Result<String, String> {
    let (mamba_root, rc) = mgr.setup(app).await?;
    let env_path = mamba_root.join("envs").join(env);
    if !env_path.exists() {
        return Err(format!("{env} 环境尚未创建，无法安装依赖。"));
    }
    let specs: Vec<String> = packages.iter().map(|p| normalize_pkg(p)).collect();
    let env_c = env.to_string();
    let specs_c = specs.clone();
    let (_stdout, stderr, code) = run_mamba_with_mirror_fallback(app, &mamba_root, &rc, |root, rc| {
        let mut a = global_args(root, rc);
        a.extend(["install".into(), "-n".into(), env_c.clone(), "-y".into()]);
        for s in &specs_c {
            a.push(s.clone());
        }
        a
    })
    .await?;
    // 依赖安装审计（2026-09-24 安全增强批次）：只记录不拦截（用户决策）。
    crate::sandbox_audit::audit_dep_install(app, "python", env, &specs, code == Some(0));
    match code {
        Some(0) => Ok(specs.join(", ")),
        Some(c) => Err(format!("依赖安装失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖安装进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 在某环境中执行脚本，并在因缺失第三方库失败时**自动按需安装并重试一次**。
///
/// 这是「纯净环境 + 按需追加依赖」设计的最终闭环：Agent 直接 `import pandas` 即可，
/// 运行时首次缺失时透明安装（不限白名单，任何缺失模块都装），无需用户或模型手动安装系统包。
/// 非库缺失类错误（语法错 / 逻辑错 / 网络错）不触发安装，原样返回。
async fn run_script_with_selfheal(
    app: &AppHandle,
    mgr: &MambaManager,
    mamba_root: &Path,
    rc: &Path,
    env: &str,
    tmp_path: &Path,
    cwd: Option<&Path>,
    extra_envs: &[(String, String)],
    run_id: &str,
) -> Result<ScriptRunResult, String> {
    let args = build_run_args(mamba_root, rc, env, tmp_path);
    // 沙箱双守卫（2026-09-24）：运行用户脚本一律注入网络默认关 + 文件系统有界
    // （依赖安装走 install_packages_silent 的 Allow 通道，不受影响）；组装一次供首跑+自愈重试共用。
    let net_envs = with_sandbox_guards(mamba_root, extra_envs, cwd)?;
    let (stdout, stderr, code) =
        run_sidecar_policy(app, args, cwd, &net_envs, NetPolicy::Blocked, run_id).await?;
    if code != Some(0) {
        if let Some(mods) = missing_modules(&stderr) {
            tracing::info!(
                "[agent] run_python: 检测到缺失库 {:?}，尝试自动安装后重试一次",
                mods
            );
            match install_packages_silent(app, mgr, env, &mods).await {
                Ok(specs) => {
                    tracing::info!("[agent] run_python: 已自动安装依赖（{}），重试执行", specs);
                    let args2 = build_run_args(mamba_root, rc, env, tmp_path);
                    let (o2, e2, c2) =
                        run_sidecar_policy(app, args2, cwd, &net_envs, NetPolicy::Blocked, run_id).await?;
                    return match c2 {
                        Some(0) => Ok(ScriptRunResult { stdout: o2, exit_code: c2 }),
                        Some(c) => Err(format!("脚本执行失败（退出码 {c}）：\n{e2}")),
                        None => Err(format!("脚本进程异常终止，未收到退出码：\n{e2}")),
                    };
                }
                Err(e) => tracing::info!("[agent] run_python: 自动安装缺失库失败：{e}"),
            }
        }
    }
    match code {
        Some(0) => Ok(ScriptRunResult { stdout, exit_code: code }),
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

    let env = env_name.unwrap_or_else(|| DEFAULT_ENV.to_string());

    // 脚本文件存在性校验，并记住其所在目录（作为运行工作目录，保证脚本内相对路径生效）。
    let script = PathBuf::from(&script_path);
    if !script.exists() {
        return Err(format!("脚本文件不存在：{script_path}"));
    }
    // F002 安全边界：渲染层可直达本命令——脚本路径必须落在允许根内（工作空间/应用数据/资源目录）。
    let roots = crate::fs_helper::allowed_script_roots(&app).await;
    crate::fs_helper::ensure_script_path_in_roots(&script, &roots)?;
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
    // 注入 PYTHONPATH：脚本被复制到 run_tmp 后，同目录 `import` 会失效，需把原始目录加回搜索路径。
    let extra_envs = pythonpath_env(original_parent.as_deref(), None)?;
    // F049：注册可取消的运行（UI 直跑的入口，用户可点「停止」）
    let (run_id, _cancel_rx) = crate::script_cancel::register_script_run();
    let result = run_script_with_selfheal(
        &app,
        mgr.inner(),
        &mamba_root,
        &rc,
        &env,
        &tmp_path,
        original_parent.as_deref(),
        &extra_envs,
        &run_id,
    )
    .await;
    crate::script_cancel::unregister_script_run(&run_id);
    let _ = std::fs::remove_file(&tmp_path);
    // 用户侧 Tauri 命令保持「返回 stdout 字符串」契约不变（前端 invoke 依赖），
    // 退出码/结构化结果仅供 agent 运行时（run_python_in_sandbox）使用。
    result.map(|r| r.stdout)
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
    cwd: Option<&Path>,
) -> Result<ScriptRunResult, String> {
    let (mamba_root, rc) = mgr.setup(app).await?;

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
    // 有效工作目录：Agent 注入的 cwd（通常为工作空间根）优先；未提供时回退到脚本所在目录（UI 行为）。
    // 注入 PYTHONPATH：脚本被复制到 run_tmp 后，同目录 `import` 会失效，需把原始目录与
    // 有效工作目录一并加回模块搜索路径，恢复「同目录 import」语义。
    let extra_envs = pythonpath_env(original_parent.as_deref(), cwd)?;
    // F049：注册可取消的运行（Agent 调用入口同样可被 stop 打断）
    let (run_id, _cancel_rx) = crate::script_cancel::register_script_run();
    let result = run_script_with_selfheal(
        app,
        mgr,
        &mamba_root,
        &rc,
        &env,
        &tmp_path,
        cwd.or(original_parent.as_deref()),
        &extra_envs,
        &run_id,
    )
    .await;
    crate::script_cancel::unregister_script_run(&run_id);
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
    let (stdout, _stderr, code) = run_sidecar(app, args, None, &[]).await?;
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
    let (mamba_root, rc) = mgr.setup(&app).await?;
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
    let (mamba_root, rc) = mgr.setup(&app).await?;

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
    let (_, stderr, code) = run_sidecar(&app, args, None, &[]).await?;
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
    let (mamba_root, rc) = mgr.setup(app).await?;

    let env_path = mamba_root.join("envs").join(DEFAULT_ENV);
    if env_path.exists() {
        return Ok(());
    }

    // 镜像源故障自动换源重试一次（清华 403 场景：切到中科大 / 官方源后即可成功）。
    let (_, stderr, code) =
        run_mamba_with_mirror_fallback(app, &mamba_root, &rc, |root, rc| {
            let mut a = global_args(root, rc);
            a.extend([
                "create".into(),
                "-n".into(),
                DEFAULT_ENV.to_string(),
                format!("python={}", DEFAULT_PYTHON),
                "-y".into(),
            ]);
            a
        })
        .await?;
    match code {
        Some(0) => Ok(()),
        Some(c) => Err(format!("创建默认环境失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("创建默认环境进程异常终止，未收到退出码：\n{stderr}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pythonpath_env_includes_original_parent_and_cwd_without_duplicates() {
        let parent = Path::new("E:/WorkDuoTest");
        let cwd = Path::new("E:/WorkDuoTest");
        // 原始目录与 cwd 相同 → 只出现一次，且键为 PYTHONPATH。
        let envs = pythonpath_env(Some(parent), Some(cwd)).unwrap();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].0, "PYTHONPATH");
        assert_eq!(envs[0].1, "E:/WorkDuoTest");

        // 原始目录与 cwd 不同 → 两者都进入，顺序为 原始目录在前。
        let cwd2 = Path::new("E:/ws");
        let envs2 = pythonpath_env(Some(parent), Some(cwd2)).unwrap();
        assert_eq!(envs2.len(), 1);
        assert_eq!(envs2[0].1, "E:/WorkDuoTest;E:/ws");

        // 两者皆无 → 空列表（调用方据此跳过注入）。
        let none = pythonpath_env(None, None).unwrap();
        assert!(none.is_empty());
    }

    /// 镜像源标识写入后可被反解（保证「已生成的 .mambarc 可复用 / 可识别失效」）。
    #[test]
    fn rc_content_roundtrip_mirror_id() {
        let m = &MIRRORS[0];
        let content = rc_content(m);
        assert_eq!(rc_mirror_id(&content), Some(m.id.to_string()));
        // 用户手写（无标记）的旧文件：反解为 None → 走探活重写流程。
        assert_eq!(rc_mirror_id("channels:\n  - defaults\n"), None);
    }

    /// 不再写死清华源：默认候选首选必须是中科大（清华实测 403）。
    #[test]
    fn default_mirror_is_not_tuna() {
        assert_eq!(MIRRORS[0].id, "ustc");
        assert!(MIRRORS.iter().any(|m| m.id == "tuna"));
        assert!(MIRRORS.iter().any(|m| m.id == "official"));
    }

    /// 只有镜像源类故障才触发换源重试；脚本/依赖类错误不得误判。
    #[test]
    fn mirror_failure_detection() {
        assert!(is_mirror_failure(
            "Transfer finalized, status: 403 [https://mirrors.tuna.../repodata.json]"
        ));
        assert!(is_mirror_failure("Subdir pkgs/main/noarch not loaded!"));
        assert!(!is_mirror_failure(
            "ModuleNotFoundError: No module named 'pandas'"
        ));
        assert!(!is_mirror_failure("SyntaxError: invalid syntax"));
    }
}
