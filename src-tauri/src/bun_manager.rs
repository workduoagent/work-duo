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
use crate::agent::engine::tools::ScriptRunResult;

/// 默认受管环境名：Node 仅此一个，调用方未指定 `env_name` 时使用。
const DEFAULT_ENV: &str = "default";
/// 安装依赖时使用的国内镜像源（npmmirror），与 Python 的清华镜像源思路一致，避免直连 npm 官方源超时。
pub(crate) const NPM_MIRROR: &str = "https://registry.npmmirror.com";
/// 默认本地缓存目录（Bun 下载依赖的 cache 落在此处，保持绿便携、不落用户 HOME）。
pub(crate) const BUN_CACHE_DIR: &str = ".bun";

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


/// F053：去除 Windows verbatim 前缀——`\\?\D:\x` → `D:\x`，`\\?\UNC\srv\share` → `\\srv\share`。
/// Bun 1.4 无法加载带该前缀的 --preload / 脚本路径。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

impl BunManager {
    pub fn new() -> Self {
        Self {}
    }

    /// 解析根目录：优先 Tauri 资源目录（`$RESOURCES`），失败回退到 exe 父目录。
    fn base_dir(app: &AppHandle) -> PathBuf {
        if let Ok(res) = app.path().resource_dir() {
            // F053：resource_dir 在 Windows 带 verbatim 前缀（\\?\D:\...），
            // Bun 无法加载该前缀的 --preload 路径（报 JSError）——统一剥掉。
            return strip_verbatim(res);
        }
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    /// 步骤一 + 步骤二：在 `$RESOURCES/bun_root` 创建运行时目录、初始化 `package.json`
    /// 与本地 `.bun` 缓存目录，保证绿便携 + 国内镜像。返回 `(bun_root, package_json)`。
    /// 权限被拒时返回友好提示。
    pub(crate) fn setup(&self, app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
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

/// Bun 沙箱守卫（`bun --preload` 注入）：
/// - 文件系统有界（`WD_SANDBOX_FS_GUARD=1`）：patch node:fs 的写/删/移入口
///   （同步 + 回调 + promises 三形态），白名单 = `WD_SANDBOX_WS`（工作空间）+ 系统临时目录，
///   越界 throw。fd（数字）跳过。
/// - 网络默认关（`WD_SANDBOX_NET_GUARD=1`，F010）：patch 全局 fetch / WebSocket、
///   node:http(s)/net/tls/dgram/dns 与 Bun 原生 connect/listen/udpSocket/serve——
///   与 Python 侧 sitecustomize 的 socket 补丁同口径（不遵守代理 env 的通道同样拦截），
///   逃生阀同为 `WD_SANDBOX_NET=on`（平台侧不注入 NET_GUARD 即放行）。
const SANDBOX_GUARD_JS: &str = r#"// WorkDuo 沙箱守卫（bun --preload）
if (process.env.WD_SANDBOX_FS_GUARD === "1") {
  const _path = require("path")
  const _os = require("os")
  const _fs = require("fs")

  const allows = []
  for (const p of [process.env.WD_SANDBOX_WS, _os.tmpdir()]) {
    if (p) { try { allows.push(_path.resolve(p).toLowerCase()) } catch {} }
  }

  function guarded(...paths) {
    for (let p of paths) {
      if (p == null || typeof p === "number") continue
      let r
      try { r = _path.resolve(String(p)).toLowerCase() } catch { continue }
      if (!allows.some(a => r === a || r.startsWith(a + _path.sep))) {
        throw new Error(
          `沙箱文件系统有界：写入/删除 ${r} 超出允许范围（仅工作空间与系统临时目录可写）。`
        )
      }
    }
  }

  const oneArg = ["mkdir", "rmdir", "unlink", "rm", "appendFile", "appendFileSync", "mkdirSync", "rmdirSync", "unlinkSync", "rmSync"]
  const twoArg = ["rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "writeFile", "writeFileSync", "truncate", "truncateSync"]
  function wrap(mod, name, mode) {
    const orig = mod[name]
    if (typeof orig !== "function") return
    if (mode === 2) {
      mod[name] = function (a, b, ...rest) { guarded(a, b); return orig.call(this, a, b, ...rest) }
    } else {
      mod[name] = function (a, ...rest) { guarded(a); return orig.call(this, a, ...rest) }
    }
  }
  for (const n of oneArg) wrap(_fs, n, 1)
  for (const n of twoArg) wrap(_fs, n, 2)
  if (_fs.promises) {
    for (const n of ["writeFile", "appendFile", "mkdir", "rmdir", "rm", "unlink", "rename", "copyFile", "cp"]) {
      const orig = _fs.promises[n]
      if (typeof orig !== "function") continue
      if (n === "rename" || n === "cp" || n === "copyFile") {
        _fs.promises[n] = async function (a, b, ...rest) { guarded(a, b); return orig.call(this, a, b, ...rest) }
      } else {
        _fs.promises[n] = async function (a, ...rest) { guarded(a); return orig.call(this, a, ...rest) }
      }
    }
  }
  for (const n of ["open", "openSync"]) {
    const orig = _fs[n]
    if (typeof orig === "function") {
      _fs[n] = function (p, flags, ...rest) {
        const f = String(flags || "r")
        if (f[0] && "wax+".includes(f[0])) guarded(p)
        return orig.call(this, p, flags, ...rest)
      }
    }
  }
}

// ---- 网络默认关（F010，与 Python 侧 sitecustomize socket 补丁同口径）----
// 拦截面：全局 fetch / WebSocket、node:http(s) request·get（客户端库入口）、
// node:net/tls/dgram（raw 连接）、node:dns（DNS 外带通道）、Bun 原生
// connect/listen/udpSocket/serve。preload 先于用户代码执行，改写导出对象
// 后续 require/import 均命中同一实例。
if (process.env.WD_SANDBOX_NET_GUARD === "1") {
  const NET_MSG = "沙箱默认离线：脚本网络访问已被禁用（平台侧 WD_SANDBOX_NET=on 可放行）。需要外部数据请改用 http_request 工具（带 SSRF 防护）。"
  const netBlocked = function () { throw new Error(NET_MSG) }
  const block = (obj, name) => {
    if (obj && typeof obj[name] === "function") { try { obj[name] = netBlocked } catch {} }
  }

  try { globalThis.fetch = netBlocked } catch {}
  try { globalThis.WebSocket = netBlocked } catch {}
  if (typeof Bun !== "undefined") {
    try { Bun.fetch = netBlocked } catch {}
    try { Bun.WebSocket = netBlocked } catch {}
    block(Bun, "connect")
    block(Bun, "listen")
    block(Bun, "udpSocket")
    block(Bun, "serve")
  }

  for (const spec of ["node:http", "node:https"]) {
    try {
      const mod = require(spec)
      block(mod, "request")
      block(mod, "get")
    } catch {}
  }

  const patchNet = (net) => {
    if (!net) return
    block(net, "connect")
    block(net, "createConnection")
    if (net.Socket && net.Socket.prototype) {
      try { net.Socket.prototype.connect = netBlocked } catch {}
    }
  }
  for (const spec of ["net", "node:net"]) {
    try { patchNet(require(spec)) } catch {}
  }
  for (const spec of ["tls", "node:tls"]) {
    try { block(require(spec), "connect") } catch {}
  }
  for (const spec of ["dgram", "node:dgram"]) {
    try { block(require(spec), "createSocket") } catch {}
  }
  for (const spec of ["dns", "node:dns"]) {
    try {
      const dns = require(spec)
      block(dns, "lookup")
      for (const n of ["resolve", "resolve4", "resolve6", "resolveSrv", "resolveTxt", "resolveMx", "resolveNs", "resolveCname", "reverse"]) block(dns, n)
      if (dns.promises) {
        try { dns.promises.lookup = netBlocked } catch {}
        for (const n of ["resolve", "resolve4", "resolve6", "reverse"]) block(dns.promises, n)
      }
    } catch {}
  }
}
"#;

/// 确保 Bun 守卫脚本在位（幂等，内容漂移时重写），返回 guard.js 路径字符串。
fn ensure_bun_sandbox_guard(bun_root: &Path) -> Result<String, String> {
    let dir = bun_root.join("net-guard");
    let file = dir.join("guard.js");
    let stale = match std::fs::read_to_string(&file) {
        Ok(cur) => cur != SANDBOX_GUARD_JS,
        Err(_) => true,
    };
    if stale {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建 bun net-guard 目录失败：{e}"))?;
        std::fs::write(&file, SANDBOX_GUARD_JS)
            .map_err(|e| format!("写入 guard.js 失败：{e}"))?;
    }
    Ok(file.to_string_lossy().to_string())
}

/// 通用：spawn bun sidecar，异步收集 stdout / stderr，进程结束后返回三元组。
///
/// 全程 `spawn()` + `CommandEvent` 异步流，不阻塞调用线程。
/// 关键点：强制注入 `BUN_INSTALL`（cache 落 `bun_root/.bun`）与 `BUN_CONFIG_REGISTRY`
/// （npmmirror 镜像），保证绿便携 + 国内可达，不依赖用户本机 ~/.bun / npm 配置。
///
/// 网络策略默认 `Allow`（平台自身操作保持联网）；运行用户脚本请用
/// `run_bun_sidecar_policy(..., NetPolicy::Blocked)`（preload 断网守卫 + 尸端口代理，
/// F010 起与 Python 侧 sitecustomize 同口径）。
async fn run_bun_sidecar(
    app: &AppHandle,
    bun_root: &Path,
    args: Vec<String>,
    cwd: Option<&Path>,
) -> Result<(String, String, Option<i32>), String> {
    run_bun_sidecar_policy(app, bun_root, args, cwd, crate::mamba_manager::NetPolicy::Allow, "").await
}

async fn run_bun_sidecar_policy(
    app: &AppHandle,
    bun_root: &Path,
    args: Vec<String>,
    cwd: Option<&Path>,
    net: crate::mamba_manager::NetPolicy,
    // F049：本次运行的取消 id（空串 = 不参与取消，如依赖安装通道）
    run_id: &str,
) -> Result<(String, String, Option<i32>), String> {
    // 沙箱守卫（文件系统有界 + 网络默认关）：运行用户脚本时 --preload guard.js（依赖安装通道不注入）。
    // fs / net 两段独立启用（逃生阀 WD_SANDBOX_FS=off / WD_SANDBOX_NET=on 分别放行）；
    // 仅 net 段生效（WD_SANDBOX_FS=off）时同样需要 preload 注入 NET_GUARD。
    let mut args = args;
    let mut preload_guard: Option<String> = None;
    if net == crate::mamba_manager::NetPolicy::Blocked
        && (crate::mamba_manager::fs_block_enabled() || crate::mamba_manager::net_block_enabled())
    {
        preload_guard = Some(ensure_bun_sandbox_guard(bun_root)?);
        args.insert(0, preload_guard.clone().unwrap());
        args.insert(0, "--preload".to_string());
    }
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
    if net == crate::mamba_manager::NetPolicy::Blocked && crate::mamba_manager::net_block_enabled() {
        for (k, v) in crate::mamba_manager::net_block_envs() {
            cmd = cmd.env(k, v);
        }
    }
    if preload_guard.is_some() {
        if crate::mamba_manager::fs_block_enabled() {
            cmd = cmd.env("WD_SANDBOX_FS_GUARD", "1");
            if let Some(ws) = cwd {
                cmd = cmd.env("WD_SANDBOX_WS", ws.to_string_lossy().to_string());
            }
        }
        if net == crate::mamba_manager::NetPolicy::Blocked && crate::mamba_manager::net_block_enabled() {
            cmd = cmd.env("WD_SANDBOX_NET_GUARD", "1");
        }
    }
    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("启动 bun 进程失败：{e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code: Option<i32> = None;

    // 沙箱执行硬超时（2026-09-24 沙箱审计，与 mamba run_sidecar 同款）：
    // 此前 while rx.recv() 永等且无 Kill 路径，长循环脚本会挂死工具调用。
    // 可配 WD_SANDBOX_TIMEOUT_SECS（默认 600s，与 python 沙箱一致）。
    let sandbox_timeout: u64 = std::env::var("WD_SANDBOX_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(600);
    let mut cancel_rx = crate::script_cancel::subscribe_cancel(run_id);
    // F049：超时与取消共用一个 select（与 mamba run_sidecar_policy 同款）。
    // 三态：None=自然结束 / Some(Err)=超时 / Some(Ok)=用户取消。
    let interrupted: Option<Result<(), ()>> = tokio::select! {
        res = tokio::time::timeout(
            std::time::Duration::from_secs(sandbox_timeout),
            async {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
                        CommandEvent::Stderr(bytes) => stderr.push_str(&String::from_utf8_lossy(&bytes)),
                        CommandEvent::Error(err) => stderr.push_str(&err),
                        CommandEvent::Terminated(payload) => code = payload.code,
                        _ => {}
                    }
                }
            },
        ) => res.err().map(|_| Err(())),
        _ = crate::mamba_manager::recv_cancel(&mut cancel_rx) => Some(Ok(())),
    };
    if let Some(res) = interrupted {
        // 取舍 1：先杀整组（连带 npm 的子进程），再 kill 兜底
        crate::script_cancel::kill_process_tree(child.pid());
        let _ = child.kill();
        return match res {
            Err(()) => Err(format!(
                "沙箱脚本执行超时（{}s），已强制终止进程。长任务请拆分或分段落盘中间结果。",
                sandbox_timeout
            )),
            Ok(()) => Err("沙箱脚本已被用户取消，进程已终止。".into()),
        };
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

/// 从脚本 stderr 中解析缺失包名（任何检测到的缺失包都返回，不做白名单过滤）。
/// 支持 Bun 常见报错格式，单/双引号均可（Bun 新版报错为 `Cannot find package 'x'`）。
pub(crate) fn missing_modules(stderr: &str) -> Option<Vec<String>> {
    let mut found: BTreeSet<String> = Default::default();
    for line in stderr.lines() {
        let line = line.trim();
        for pat in ["Cannot find package", "Could not resolve", "Module not found"] {
            if let Some(rest) = line.strip_prefix(pat) {
                let rest = rest.trim_start();
                let quote = match rest.chars().next() {
                    Some(q) if q == '\'' || q == '"' => q,
                    _ => continue,
                };
                if let Some(name) = rest[1..].split(quote).next() {
                    let name = name.trim();
                    if !name.is_empty() && !name.contains(char::is_whitespace) {
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
pub(crate) async fn install_packages_silent(
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
    // 依赖安装审计（2026-09-24 安全增强批次）：与 python 同款，只记录不拦截。
    crate::sandbox_audit::audit_dep_install(app, "bun", "default", packages, code == Some(0));
    match code {
        Some(0) => Ok(packages.join(", ")),
        Some(c) => Err(format!("依赖安装失败（退出码 {c}）：\n{stderr}")),
        None => Err(format!("依赖安装进程异常终止，未收到退出码：\n{stderr}")),
    }
}

/// 在插件运行目录建立指向 `bun_root/node_modules` 的目录联接，使插件脚本与受管
/// default 沙箱环境共享依赖：自愈装进 default 环境（设置页「依赖管理」可见、跨运行
/// 复用、与 Python 的 mamba env 行为对齐），插件目录经联接解析到包。
/// Windows 用 junction（`mklink /J`，无需管理员权限）；Unix 用符号链接。
/// 返回是否就绪（联接已存在视为成功）。失败时调用方应回退「装进运行目录」策略。
/// 注意：未来清理 call_dir 时只删联接本身，不会波及 bun_root 内的真实依赖。
pub(crate) fn ensure_node_modules_link(call_dir: &Path, bun_root: &Path) -> bool {
    let link = call_dir.join("node_modules");
    if link.exists() {
        return true;
    }
    let target = bun_root.join("node_modules");
    if let Err(e) = std::fs::create_dir_all(&target) {
        tracing::warn!("[plugin] 创建 bun_root/node_modules 失败：{e}");
        return false;
    }
    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output();
        match out {
            Ok(o) if o.status.success() => true,
            Ok(o) => {
                tracing::warn!(
                    "[plugin] 建立依赖联接失败：{}",
                    String::from_utf8_lossy(&o.stderr).trim()
                );
                false
            }
            Err(e) => {
                tracing::warn!("[plugin] 建立依赖联接异常：{e}");
                false
            }
        }
    }
    #[cfg(not(windows))]
    {
        match std::os::unix::fs::symlink(&target, &link) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("[plugin] 建立依赖符号链接失败：{e}");
                false
            }
        }
    }
}

/// 在指定目录内安装依赖（`bun add`，cwd=dir）——插件自愈的**兜底**安装路径。
///
/// 仅当 `ensure_node_modules_link` 建立联接失败时使用：把包装进插件运行目录本身
/// （脚本旁边解析天然成立），代价是不可见、不跨运行复用。目录内无 package.json
/// 时先写一个最小清单（bun add 需要）。
pub(crate) async fn install_packages_in_dir(
    app: &AppHandle,
    bun_root: &Path,
    dir: &Path,
    packages: &[String],
) -> Result<String, String> {
    let pkg_json = dir.join("package.json");
    if !pkg_json.exists() {
        std::fs::write(
            &pkg_json,
            "{\n  \"name\": \"workduo-plugin-run\",\n  \"private\": true\n}\n",
        )
        .map_err(|e| format!("写入插件运行 package.json 失败：{e}"))?;
    }
    let mut args = vec!["add".into()];
    for s in packages {
        args.push(s.clone());
    }
    let (_stdout, stderr, code) = run_bun_sidecar(app, bun_root, args, Some(dir)).await?;
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
    // F049：本次运行的取消 id（空串 = 不参与取消）
    run_id: &str,
) -> Result<ScriptRunResult, String> {
    let args = vec![tmp_path.to_string_lossy().to_string()];
    // 网络默认关（2026-09-24）：运行用户 JS 一律注入断网 env；F010 起 preload 守卫
    // 同时 patch fetch/WebSocket/node 网络模块/Bun 原生连接（与 Python 侧同口径），
    // 不遵守代理 env 的通道不再穿透。依赖安装走 install_packages_silent 的 Allow 通道不受影响。
    let net = crate::mamba_manager::NetPolicy::Blocked;
    let (stdout, stderr, code) =
        run_bun_sidecar_policy(app, bun_root, args, cwd, net, run_id).await?;
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
                    let (o2, e2, c2) =
                        run_bun_sidecar_policy(app, bun_root, args2, cwd, net, run_id).await?;
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
    // F002 安全边界：渲染层可直达本命令——脚本路径必须落在允许根内（工作空间/应用数据/资源目录）。
    let roots = crate::fs_helper::allowed_script_roots(&app).await;
    crate::fs_helper::ensure_script_path_in_roots(&script, &roots)?;
    let original_parent = script.parent().map(|p| p.to_path_buf());

    // 关键修复：改为「原地执行」脚本，不再复制到 run_tmp。
    // 旧实现把脚本复制到 bun_root/run_tmp/ 后运行，导致 ESM 相对导入
    // （如 `import { add } from './calc.js'`）按临时目录解析，同目录兄弟模块永远找不到。
    // 原地执行后，相对导入按脚本真实所在目录解析，恢复「同目录 import」语义；
    // 已安装依赖（bun_root/node_modules）的解析由 run_bun_sidecar 注入的 NODE_PATH 兜底。
    // cwd 设为原脚本所在目录，便于脚本内相对路径文件操作仍按原位置解析。
    // F049：注册可取消的运行（UI 直跑入口）
    let (run_id, _cancel_rx) = crate::script_cancel::register_script_run();
    let result =
        run_script_with_selfheal(&app, &bun_root, &script, original_parent.as_deref(), &run_id).await;
    crate::script_cancel::unregister_script_run(&run_id);
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
    // F049：注册可取消的运行（Agent 调用入口）
    let (run_id, _cancel_rx) = crate::script_cancel::register_script_run();
    let result =
        run_script_with_selfheal(app, &bun_root, &script, cwd.or(original_parent.as_deref()), &run_id).await;
    crate::script_cancel::unregister_script_run(&run_id);
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

#[cfg(test)]
mod f053_tests {
    use super::strip_verbatim;
    use std::path::PathBuf;

    #[test]
    fn strips_windows_drive_verbatim_prefix() {
        let got = strip_verbatim(PathBuf::from(r"\\?\D:\WorkDuo\bun_root"));
        assert_eq!(got, PathBuf::from(r"D:\WorkDuo\bun_root"));
    }

    #[test]
    fn strips_windows_unc_verbatim_prefix() {
        let got = strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\bun_root"));
        assert_eq!(got, PathBuf::from(r"\\server\share\bun_root"));
    }

    #[test]
    fn preserves_plain_path() {
        let plain = PathBuf::from(r"D:\WorkDuo\bun_root");
        assert_eq!(strip_verbatim(plain.clone()), plain);
    }
}

#[cfg(test)]
mod f010_tests {
    use super::SANDBOX_GUARD_JS;

    /// 防回归锚：守卫 JS 必须包含网络默认关段（F010）——
    /// 覆盖全局 fetch/WebSocket、node 客户端库入口、raw 连接、DNS 通道与 Bun 原生面。
    #[test]
    fn guard_contains_net_section() {
        for marker in [
            "WD_SANDBOX_NET_GUARD",
            "globalThis.fetch",
            "globalThis.WebSocket",
            "\"node:http\"",
            "\"node:https\"",
            "\"node:net\"",
            "Socket.prototype.connect",
            "\"node:tls\"",
            "\"node:dgram\"",
            "\"node:dns\"",
            "Bun.fetch",
            "\"connect\"",
            "\"listen\"",
            "\"udpSocket\"",
            "\"serve\"",
            "WD_SANDBOX_NET=on",
        ] {
            assert!(SANDBOX_GUARD_JS.contains(marker), "守卫缺少标记：{marker}");
        }
    }

    /// fs 段与 net 段各自独立启用（互不绑定），逃生阀文案与 Python 侧一致。
    #[test]
    fn guard_sections_are_independent() {
        assert!(SANDBOX_GUARD_JS.contains("WD_SANDBOX_FS_GUARD === \"1\""));
        assert!(SANDBOX_GUARD_JS.contains("WD_SANDBOX_NET_GUARD === \"1\""));
        // fs 段先闭合，net 段独立 if，不嵌套
        let fs_pos = SANDBOX_GUARD_JS.find("WD_SANDBOX_FS_GUARD === \"1\"").unwrap();
        let net_pos = SANDBOX_GUARD_JS.find("WD_SANDBOX_NET_GUARD === \"1\"").unwrap();
        assert!(fs_pos < net_pos);
    }
}

