//! 本地脚本插件执行器（对应设计方案 §4：Runner 壳 / stdin 注入 / exit 42 自愈 / 超时杀树 / 写日志）。
//!
//! 设计要点（与现有 mamba/bun sandbox 对齐，但有三点关键差异）：
//! 1. **参数走 stdin 不 argv**（ADR #3）：`run_sidecar_with_stdin` 把 JSON 参数作为 stdin 首行注入；
//!    但 `tauri-plugin-shell` 的 sidecar 永远 piped 且 Rust 侧无法关闭 EOF，故 Runner 壳**只读取
//!    stdin 首行**（`sys.stdin.readline()` / `process.stdin` 首行），否则会永久阻塞。
//! 2. **优先 exit 42 协议**：脚本缺依赖时 `exit 42` + stderr JSON 携带 `missing_package`；
//!    stderr 正则（`ModuleNotFoundError` / `Cannot find package`）作为兜底，兼容现 sandbox 行为。
//! 3. **超时杀进程树**：异步 `tokio::select!` 等待 + `taskkill /T /F /PID`（Windows）清理
//!    micromamba/bun 派生的解释器子进程，避免挂死。
//!
//! 临时目录落在 `resource_dir/plugin_runs/{call_id}/`（绿便携、随应用打包迁移，不依赖工作空间）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool};
use tokio::io::AsyncWriteExt;
use tokio::process::Command as AsyncCommand;

use crate::bun_manager::BunManager;
use crate::mamba_manager::MambaManager;

/// 单次插件执行所需的最小规格（由 `test_user_plugin` 从 DB 读取，或由 P2 适配器从
/// `MountedUserPlugin` 映射而来）。
#[derive(Debug, Clone)]
pub struct PluginExecSpec {
    pub plugin_id: String,
    /// 插件 identifier（如 text_analyzer），仅用于运行期日志展示，便于 Agent 关联具体插件。
    pub identifier: String,
    /// 运行时：`python` | `bun`。
    pub runtime: String,
    /// 用户核心代码（仅 `run` + 头注释，不含 Runner 壳）。
    pub script_content: String,
    /// 单次执行超时（秒，硬上限 300）。
    pub timeout_sec: u64,
    /// 声明式依赖（自heal 时的兜底安装清单）。
    pub dependencies: Vec<String>,
}

/// 一次插件执行的完整结果（同时作为 `test_user_plugin` 命令的返回结构，对齐前端
/// `PluginTestResult`：`camelCase` 序列化）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunResult {
    pub ok: bool,
    pub call_id: String,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    /// 成功时 `run()` 的返回值（已 JSON.parse；失败为 null）。
    pub result: Option<JsonValue>,
    pub stdout: String,
    pub stderr: String,
    /// 自愈时实际安装的依赖（spec 名列表）。
    pub deps_installed: Vec<String>,
    pub error_type: Option<String>,
    pub missing_package: Option<String>,
    pub error_message: Option<String>,
    pub traceback: Option<String>,
}

/// `run_sidecar_with_stdin` 的内部结果。
struct SidecarOutcome {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

/// Bun Runner 壳（与 Python 不同：用户代码独立为 `user_script.ts`，由本壳**动态 import**）。
///
/// 关键点：
/// 1. 只读 stdin 首行（见 `readStdinFirstLine`），绝不等 EOF；
/// 2. 用 `await import('./user_script.ts')` 而非静态 import —— 静态 import 的模块解析失败
///    会发生在 `main()` 之前，catch 不到、走不到 exit 42 优先协议（ADR #2）；
///    动态 import 的 ERR_MODULE_NOT_FOUND 会落进 try/catch，统一从 exit 42 上报。
const BUN_RUNNER: &str = r#"// 只读 stdin 首行：tauri shell sidecar 的 stdin 永远 piped 且无法关闭 EOF，
// Bun.stdin.text() 会等 EOF 永久阻塞；首行 JSON 由平台注入（见 ADR #3 参数走 stdin 不 argv）。
function readStdinFirstLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      buf += chunk
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        process.stdin.pause()
        resolve(buf.slice(0, idx))
      }
    })
    process.stdin.on('end', () => resolve(buf.trim()))
  })
}

async function main() {
  try {
    const raw = await readStdinFirstLine()
    const params = raw.trim() ? JSON.parse(raw) : {}
    const userModule = await import('./user_script.ts')
    const handler =
      typeof userModule === 'function'
        ? userModule
        : (userModule && (userModule.default || userModule.run))
    if (typeof handler !== 'function') {
      throw new TypeError('用户脚本未导出 default/run 函数')
    }
    const result = await handler(params)
    process.stdout.write(JSON.stringify(result ?? null))
  } catch (err: any) {
    const msg = String(err && err.message ? err.message : err)
    if (
      err &&
      (err.code === 'ERR_MODULE_NOT_FOUND' ||
        err.code === 'MODULE_NOT_FOUND' ||
        /Cannot find (package|module)/i.test(msg))
    ) {
      process.stderr.write(JSON.stringify({ error_type: 'DependencyMissing', missing_package: msg }))
      process.exit(42)
    }
    process.stderr.write(JSON.stringify({ error: msg, stack: err && err.stack ? err.stack : '' }))
    process.exit(1)
  }
}

main()
"#;

/// 把任意用户代码转成可安全内嵌进 Python 源码的 JSON 字符串字面量（纯 ASCII）。
///
/// 比 `serde_json::to_string` 更严：非 ASCII 与控制符全部转 `\uXXXX`，双引号转义，
/// 保证产物只含 ASCII 且不含任何会破坏 Python 字符串字面量的原始字符。
fn py_safe_json_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 拼装 Python Runner 壳：用户代码以 JSON 字符串内嵌、运行时 `exec` 进 try 块。
///
/// 为什么不用「直接内联源码」：内联用户代码的顶层 `import requests` 会在进入
/// `if __name__ == "__main__"` 之前抛 ModuleNotFoundError，catch 不到、走不到 exit 42
/// 优先协议（ADR #2），只能靠 stderr 正则兜底。改为 exec 后，**顶层 import 缺包同样
/// 落进 try/except**，统一从 exit 42 上报 `missing_package`；traceback 经
/// `compile(..., "user_script", ...)` 仍能对上用户代码行号。
/// Runner 壳尾部（`_load_params` + `__main__` 执行块）。
///
/// ★ 必须用 raw string 保留真实缩进：Rust 字符串的 `\` 行续接会**吞掉下一行的前导空格**，
///   用 `\n\` 拼出的 runner.py 缩进全丢，`def _load_params():` 后无缩进块直接
///   `IndentationError: expected an indented block after function definition on line 5`
///   （2026-09-16 真机用例一暴露）。
const PY_RUNNER_TAIL: &str = r#"def _load_params():
    # 只读 stdin 首行：tauri shell sidecar 的 stdin 永远 piped 且无法关闭 EOF，
    # 若用 read() 会永久阻塞；首行 JSON 由平台注入（见 ADR #3 参数走 stdin 不 argv）。
    raw = (sys.stdin.readline() or "").strip()
    return json.loads(raw) if raw else {}

if __name__ == "__main__":
    try:
        exec(compile(_USER_SRC, "user_script", "exec"))
        if not callable(run):
            raise TypeError("用户脚本未定义可调用的 run(params)")
        params = _load_params()
        result = run(params)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str) + "\n")
    except ModuleNotFoundError as e:
        sys.stderr.write(json.dumps({
            "error_type": "DependencyMissing",
            "missing_package": e.name or ""
        }, ensure_ascii=False))
        sys.exit(42)
    except Exception as e:
        sys.stderr.write(json.dumps({
            "error": str(e),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))
        sys.exit(1)
"#;

/// 拼装 Python Runner 壳：头 + 用户代码内嵌 + 尾部（raw string，缩进原样保留）。
fn build_python_runner(user_code: &str) -> String {
    let mut s = String::new();
    s.push_str("import sys, json, traceback\n\n");
    // py_safe_json_literal 的转义（\" \\ \n \uXXXX）同时是合法的 Python 字符串字面量转义，
    // 直接赋值即可；**不能**再包一层 json.loads —— 字面量层已解码一次，loads 会拿到
    // 原始用户代码而非 JSON 文本，报 JSONDecodeError（真机自检 2026-09-16 暴露）。
    s.push_str(&format!("_USER_SRC = {}\n\n", py_safe_json_literal(user_code)));
    s.push_str(PY_RUNNER_TAIL);
    s
}

/// 插件运行临时根目录：`resource_dir/plugin_runs`（绿便携，随应用迁移，不依赖工作空间）。
fn plugin_runs_dir(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
        });
    base.join("plugin_runs")
}

/// 把以 `\n` 分隔的行按 UTF-8 字符边界安全截断到 max_bytes（避免拆坏多字节字符）。
fn truncate(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// 在超时/失败时杀进程树（Windows 用 `taskkill /T /F`，确保 micromamba/bun 派生的解释器被清掉）。
fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

/// 经插件托管的 `DbInstances` 取出 `sqlite:workduo.db` 连接池（与 commands.rs `load_config` 同款）。
async fn get_sqlite_pool(app: &tauri::AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db），请先在前端 load".to_string())?;
    let pool = match db_pool {
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);
    Ok(pool)
}

/// 收集本次失败应安装的缺失依赖清单：
/// - exit 42 显式 JSON `missing_package` 优先；
/// - stderr 正则兜底（Python `ModuleNotFoundError` / Bun `Cannot find package`）；
/// - 仅当存在依赖信号（exit 42 或正则命中）才并入声明依赖 `dependencies`，避免对非依赖错误无意义安装。
fn collect_missing_packages(
    stderr: &str,
    exit_code: Option<i32>,
    declared: &[String],
    runtime: &str,
) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    if exit_code == Some(42) {
        if let Ok(v) = serde_json::from_str::<JsonValue>(stderr) {
            if let Some(mp) = v.get("missing_package").and_then(|x| x.as_str()) {
                let mp = mp.trim().trim_matches('\'').trim_matches('"').trim().to_string();
                if !mp.is_empty() {
                    if runtime == "bun" {
                        // Bun 壳上报的 missing_package 是整句报错（"Cannot find package 'ms'
                        // imported from ..."），不能整句当包名喂给 bun add（真机用例暴露，
                        // 用户观测：bun 环境始终未见安装任何包）。用 missing_modules 从报错
                        // 行提取干净包名（已兼容单/双引号）；提取失败才原样保留。
                        match crate::bun_manager::missing_modules(&mp) {
                            Some(mods) => {
                                for m in mods {
                                    set.insert(m);
                                }
                            }
                            None => {
                                set.insert(mp);
                            }
                        }
                    } else {
                        // Python 的 missing_package = e.name，本身就是干净包名。
                        set.insert(mp);
                    }
                }
            }
        }
    }
    let regex_missing = if runtime == "python" {
        crate::mamba_manager::missing_modules(stderr)
    } else {
        crate::bun_manager::missing_modules(stderr)
    };
    if let Some(mods) = regex_missing {
        for m in mods {
            set.insert(m);
        }
    }
    if exit_code == Some(42) || !set.is_empty() {
        for d in declared {
            let d = d.trim().to_string();
            if !d.is_empty() {
                set.insert(d);
            }
        }
    }
    // 兜底过滤：包规格不允许含空白/反斜杠（防止整句报错混入导致 bun add 必败）。
    set.retain(|s| !s.contains(char::is_whitespace) && !s.contains('\\'));
    set.into_iter().collect()
}

/// 安装缺失依赖（单独 120s 超时，不计入插件 `timeout_sec`）。
///
/// Bun 依赖统一装进受管 default 沙箱环境（`bun_root/node_modules`），与 Python 的
/// mamba env 行为对齐：设置页「依赖管理」可见、跨运行复用。运行目录经
/// `ensure_node_modules_link` 建立的联接解析到包；联接建立失败时回退
/// 「装进运行目录」的隔离策略（保证功能可用，只是不可见/不持久）。
async fn install_deps(
    app: &tauri::AppHandle,
    mamba: &MambaManager,
    bun: &BunManager,
    call_dir: &Path,
    runtime: &str,
    pkgs: &[String],
) -> Result<Vec<String>, String> {
    let install_timeout = Duration::from_secs(120);
    let specs = if runtime == "python" {
        let fut = crate::mamba_manager::install_packages_silent(app, mamba, "default", pkgs);
        match tokio::time::timeout(install_timeout, fut).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("依赖安装超时（>120s）".into()),
        }
    } else {
        let (bun_root, _pkg) = bun.setup(app)?;
        if call_dir.join("node_modules").exists() {
            // 联接已就绪 → 装进受管 default 环境（设置页可见、跨运行复用）
            let fut = crate::bun_manager::install_packages_silent(app, &bun_root, pkgs);
            match tokio::time::timeout(install_timeout, fut).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(e),
                Err(_) => return Err("依赖安装超时（>120s）".into()),
            }
        } else {
            // 联接建立失败的兜底：装进运行目录本身（隔离但功能可用）
            let fut = crate::bun_manager::install_packages_in_dir(app, &bun_root, call_dir, pkgs);
            match tokio::time::timeout(install_timeout, fut).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(e),
                Err(_) => return Err("依赖安装超时（>120s）".into()),
            }
        }
    };
    Ok(specs
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect())
}

/// 从 stderr 解析错误明细（优先 JSON `error`/`traceback`，否则取末行）。
fn parse_error_detail(result: &mut PluginRunResult, stderr: &str) {
    if let Ok(v) = serde_json::from_str::<JsonValue>(stderr) {
        if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
            result.error_message = Some(err.to_string());
        }
        if let Some(tb) = v.get("traceback").and_then(|x| x.as_str()) {
            result.traceback = Some(tb.to_string());
        }
        if let Some(mp) = v.get("missing_package").and_then(|x| x.as_str()) {
            result.missing_package = Some(mp.to_string());
        }
    }
    if result.error_message.is_none() {
        let last = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .last()
            .unwrap_or("脚本执行失败")
            .to_string();
        result.error_message = Some(last);
    }
}

/// 把成功输出（exit 0）解析为 `result`；stdout 非合法 JSON 则标记 `InvalidJson`（脚本已跑完）。
fn set_success(result: &mut PluginRunResult, out: &SidecarOutcome) {
    result.ok = true;
    result.exit_code = out.exit_code;
    result.stdout = out.stdout.clone();
    result.stderr = out.stderr.clone();
    match serde_json::from_str::<JsonValue>(&out.stdout) {
        Ok(v) => result.result = Some(v),
        Err(_) => {
            result.error_type = Some("InvalidJson".into());
            result.error_message =
                Some("脚本 stdout 不是合法 JSON，无法作为 result 返回（脚本已执行完成）".into());
        }
    }
}

/// 把失败输出标记到 `result`（error_type 由调用方给定，如 RuntimeError / DependencyMissing）。
fn set_failure(result: &mut PluginRunResult, out: &SidecarOutcome, error_type: &str) {
    result.ok = false;
    result.exit_code = out.exit_code;
    result.stdout = out.stdout.clone();
    result.stderr = out.stderr.clone();
    result.error_type = Some(error_type.to_string());
    parse_error_detail(result, &out.stderr);
}

/// Sidecar 执行（支持写 stdin 首行 + 超时杀树）。
///
/// 不另起收集任务，直接在当前 async 任务里 `tokio::select!` 驱动 `rx.recv()` 与超时；
/// 超时后 `child.kill()` + `kill_process_tree(pid)`，再排空剩余输出后返回。
/// 原生子进程执行（参数走 stdin 首行 + 超时杀树）。
///
/// 改用 `tokio::process::Command` 而非 `tauri-plugin-shell` 的 sidecar：
/// 端到端复测发现后者 `CommandChild::write()` 注入的 stdin **无法可靠送达**
/// micromamba/python 子进程，导致 Python Runner 壳永久阻塞在 `sys.stdin.readline()`，
/// 被 60s 硬超时杀树（零依赖 `print` 脚本都如此）。原生 `Command` 显式 `.stdin(piped)`
/// 写完即关管道，与 `native.rs` 沙箱执行同源可靠。
async fn run_sidecar_with_stdin(
    _app: &tauri::AppHandle,
    sidecar: &str,
    args: Vec<String>,
    cwd: Option<&Path>,
    extra_envs: &[(String, String)],
    stdin_data: Option<&str>,
    timeout: Duration,
) -> Result<SidecarOutcome, String> {
    let bin = resolve_sidecar_path(sidecar)?;
    let mut cmd = AsyncCommand::new(&bin);
    cmd.args(&args);
    for (k, v) in extra_envs {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.kill_on_drop(false)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 {sidecar} 进程失败：{e}"))?;

    // 注入 stdin 首行 JSON（参数走 stdin 不 argv，见 ADR #3）。写完即关闭管道，
    // Runner 壳只读首行、不等待 EOF，进程不阻塞。
    if let Some(data) = stdin_data {
        let line = if data.ends_with('\n') {
            data.to_string()
        } else {
            format!("{data}\n")
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.flush().await;
            drop(stdin);
        }
    }

    let pid = child.id().unwrap_or(0);

    // child 在此 move 进 collect 闭包；超时分支（Err）会让 collect 被丢弃并释放 child，
    // 故超时分支只杀进程树、不再引用 child。
    let collect = async {
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("收集 {sidecar} 输出失败：{e}"))
    };
    match tokio::time::timeout(timeout, collect).await {
        Ok(Ok(out)) => Ok(SidecarOutcome {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code(),
            timed_out: false,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // 超时：杀进程树（覆盖 micromamba 派生的 python 子进程）。
            kill_process_tree(pid);
            Ok(SidecarOutcome {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: Some(1),
                timed_out: true,
            })
        }
    }
}

/// 解析 externalBin sidecar 二进制路径。
///
/// Tauri 在 dev/打包时把 `binaries/<triple>` 改名为 `<name>` 放在主程序同目录，
/// 故优先取「当前 exe 目录/<name>」；回退原始 `binaries/<name>` 目录，最后回退 PATH。
fn resolve_sidecar_path(sidecar: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("获取当前 exe 路径失败：{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "当前 exe 无父目录".to_string())?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        candidates.push(dir.join(format!("{sidecar}.exe")));
        candidates.push(dir.join("binaries").join(format!("{sidecar}.exe")));
    } else {
        candidates.push(dir.join(sidecar));
        candidates.push(dir.join("binaries").join(sidecar));
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    // 最后回退 PATH（含 .exe 再试一次）
    Ok(PathBuf::from(sidecar))
}

/// 写 `plugin_run_log`（stdout/stderr 各 ≤64KB；params ≤8KB，见 §5.1）。
async fn write_plugin_run_log(
    app: &tauri::AppHandle,
    spec: &PluginExecSpec,
    result: &PluginRunResult,
    params: &JsonValue,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    source: &str,
) {
    let pool = match get_sqlite_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("[plugin] 获取 DB 失败，跳过运行日志写入：{e}");
            return;
        }
    };
    let id = format!("plr_{}", crate::agent::engine::runtime::now_ms());
    let created = crate::agent::engine::runtime::now_ms();
    let stdout = truncate(&result.stdout, 64 * 1024);
    let stderr = truncate(&result.stderr, 64 * 1024);
    let params_str = serde_json::to_string(params).unwrap_or_else(|_| "{}".to_string());
    let params_log = truncate(&params_str, 8 * 1024);

    let q = "INSERT INTO plugin_run_log \
        (id, plugin_id, agent_id, session_id, source, params, ok, exit_code, duration_ms, stdout, stderr, error_type, missing_package, created_at) \
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    if let Err(e) = sqlx::query(q)
        .bind(&id)
        .bind(&spec.plugin_id)
        .bind(agent_id.map(|s| s.to_string()))
        .bind(session_id.map(|s| s.to_string()))
        .bind(source)
        .bind(&params_log)
        .bind(if result.ok { 1i64 } else { 0i64 })
        .bind(result.exit_code)
        .bind(result.duration_ms as i64)
        .bind(&stdout)
        .bind(&stderr)
        .bind(&result.error_type)
        .bind(&result.missing_package)
        .bind(created)
        .execute(&pool)
        .await
    {
        tracing::error!("[plugin] 写入 plugin_run_log 失败：{e}");
    }
}

/// 回写 `user_plugin_tool.last_run_at` / `last_run_status`（0 未知 / 1 成功 / 2 失败）。
async fn update_last_run(app: &tauri::AppHandle, spec: &PluginExecSpec, ok: bool) {
    let pool = match get_sqlite_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("[plugin] 获取 DB 失败，跳过 last_run 回写：{e}");
            return;
        }
    };
    let ts = crate::agent::engine::runtime::now_ms();
    let status = if ok { 1i64 } else { 2i64 };
    if let Err(e) = sqlx::query(
        "UPDATE user_plugin_tool SET last_run_at = ?, last_run_status = ? WHERE id = ?",
    )
    .bind(ts)
    .bind(status)
    .bind(&spec.plugin_id)
    .execute(&pool)
    .await
    {
        tracing::error!("[plugin] 回写 user_plugin_tool.last_run_* 失败：{e}");
    }
}

/// 收尾：写入日志 + 回写 last_run，并填入耗时。
async fn finalize(
    result: &mut PluginRunResult,
    app: &tauri::AppHandle,
    spec: &PluginExecSpec,
    params: &JsonValue,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    source: &str,
    start: std::time::Instant,
) {
    result.duration_ms = start.elapsed().as_millis() as u64;
    // 运行结束汇总日志：一条 outcome + 成功时附截断后的返回值预览（便于 Agent 抽查结果）。
    let outcome = if result.ok {
        "SUCCESS"
    } else {
        result.error_type.as_deref().unwrap_or("FAILURE")
    };
    let err_preview = truncate(result.error_message.as_deref().unwrap_or("-"), 256);
    tracing::info!(
        "[plugin] ◀ 执行结束 plugin={} id={} source={} result={} duration_ms={} exit_code={:?} error={} deps_installed={:?}",
        spec.identifier,
        spec.plugin_id,
        source,
        outcome,
        result.duration_ms,
        result.exit_code,
        err_preview,
        result.deps_installed
    );
    if result.ok {
        match &result.result {
            Some(v) => {
                let rp = truncate(
                    &serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()),
                    512,
                );
                tracing::info!(
                    "[plugin]   ↳ 返回值(截断512B) plugin={} result={}",
                    spec.identifier,
                    rp
                );
            }
            None => {
                tracing::info!(
                    "[plugin]   ↳ 返回值 plugin={} (stdout 非合法 JSON，已置 error_type=InvalidJson)",
                    spec.identifier
                );
            }
        }
    }
    write_plugin_run_log(app, spec, result, params, agent_id, session_id, source).await;
    update_last_run(app, spec, result.ok).await;
}

/// 插件执行主入口：拼装 Runner 壳 → sidecar 执行 → exit 42 依赖自愈 → 写日志回写。
///
/// - `call_id`：本次运行唯一 id（用作临时目录名，通常由调用方用 `now_ms()` 生成）。
/// - `params`：注入 stdin 的 JSON 参数对象。
/// - `source`：`test`（试跑）| `agent`（Agent 调用）；`agent_id`/`session_id` 仅 Agent 调用填写。
pub async fn run_plugin(
    app: &tauri::AppHandle,
    mamba: &MambaManager,
    bun: &BunManager,
    spec: &PluginExecSpec,
    params: &JsonValue,
    call_id: &str,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    source: &str,
) -> PluginRunResult {
    let start = std::time::Instant::now();
    let mut result = PluginRunResult {
        ok: false,
        call_id: call_id.to_string(),
        duration_ms: 0,
        exit_code: None,
        result: None,
        stdout: String::new(),
        stderr: String::new(),
        deps_installed: Vec::new(),
        error_type: None,
        missing_package: None,
        error_message: None,
        traceback: None,
    };

    // 运行生命周期日志：供 Agent 运行插件时观察状态；入参与返回值过长均截断，避免日志膨胀。
    let params_preview = truncate(
        &serde_json::to_string(params).unwrap_or_else(|_| "{}".to_string()),
        256,
    );
    tracing::info!(
        "[plugin] ▶ 启动执行 plugin={} id={} runtime={} source={} agent={} session={} call_id={} params={}",
        spec.identifier,
        spec.plugin_id,
        spec.runtime,
        source,
        agent_id.unwrap_or("-"),
        session_id.unwrap_or("-"),
        call_id,
        params_preview
    );

    // 1. 临时目录 + 写 Runner 壳，决定 sidecar / args / envs。
    let runs_dir = plugin_runs_dir(app);
    let call_dir = runs_dir.join(call_id);
    if let Err(e) = std::fs::create_dir_all(&call_dir) {
        result.error_type = Some("Internal".into());
        result.error_message = Some(format!("创建插件运行目录失败：{e}"));
        finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
        return result;
    }

    enum RunPlan {
        Python { args: Vec<String> },
        Bun { args: Vec<String>, envs: Vec<(String, String)> },
    }

    let plan = match spec.runtime.as_str() {
        "python" => {
            let runner = build_python_runner(&spec.script_content);
            let p = call_dir.join("runner.py");
            if let Err(e) = std::fs::write(&p, runner) {
                result.error_type = Some("Internal".into());
                result.error_message = Some(format!("写入 Runner 脚本失败：{e}"));
                finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
                return result;
            }
            let (mamba_root, rc) = match mamba.setup(app) {
                Ok(x) => x,
                Err(e) => {
                    result.error_type = Some("Internal".into());
                    result.error_message = Some(format!("初始化 Python 运行时失败：{e}"));
                    finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
                    return result;
                }
            };
            RunPlan::Python {
                args: crate::mamba_manager::build_run_args(&mamba_root, &rc, "default", &p),
            }
        }
        "bun" => {
            let rp = call_dir.join("runner.ts");
            let up = call_dir.join("user_script.ts");
            if let Err(e) = std::fs::write(&rp, BUN_RUNNER) {
                result.error_type = Some("Internal".into());
                result.error_message = Some(format!("写入 Runner 脚本失败：{e}"));
                finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
                return result;
            }
            if let Err(e) = std::fs::write(&up, &spec.script_content) {
                result.error_type = Some("Internal".into());
                result.error_message = Some(format!("写入用户脚本失败：{e}"));
                finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
                return result;
            }
            let (bun_root, _pkg) = match bun.setup(app) {
                Ok(x) => x,
                Err(e) => {
                    result.error_type = Some("Internal".into());
                    result.error_message = Some(format!("初始化 Node 运行时失败：{e}"));
                    finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
                    return result;
                }
            };
            // 建立运行目录 → 受管 default 环境的依赖联接：脚本可解析 bun_root/node_modules
            // 里的包（自愈安装进 default 环境，设置页依赖管理可见、跨运行复用）。
            if !crate::bun_manager::ensure_node_modules_link(&call_dir, &bun_root) {
                tracing::warn!(
                    "[plugin] 依赖联接未建立，本次运行回退「装进运行目录」的自愈策略"
                );
            }
            let cache = bun_root.join(crate::bun_manager::BUN_CACHE_DIR);
            let node_modules = bun_root.join("node_modules");
            let envs = vec![
                (
                    "BUN_INSTALL".to_string(),
                    cache.to_string_lossy().to_string(),
                ),
                (
                    "BUN_CONFIG_REGISTRY".to_string(),
                    crate::bun_manager::NPM_MIRROR.to_string(),
                ),
                (
                    "NODE_PATH".to_string(),
                    node_modules.to_string_lossy().to_string(),
                ),
            ];
            RunPlan::Bun {
                args: vec![rp.to_string_lossy().to_string()],
                envs,
            }
        }
        other => {
            result.error_type = Some("Internal".into());
            result.error_message = Some(format!("不支持的运行时：{other}"));
            finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
            return result;
        }
    };

    let (sidecar, args, envs): (&str, Vec<String>, Vec<(String, String)>) = match &plan {
        RunPlan::Python { args } => ("micromamba", args.clone(), Vec::new()),
        RunPlan::Bun { args, envs } => ("bun", args.clone(), envs.clone()),
    };
    let timeout = Duration::from_secs(spec.timeout_sec.clamp(1, 300));
    let params_json = serde_json::to_string(params).unwrap_or_else(|_| "{}".to_string());

    // 2. 首次执行。
    let attempt = match run_sidecar_with_stdin(
        app,
        sidecar,
        args.clone(),
        Some(&call_dir),
        &envs,
        Some(&params_json),
        timeout,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            result.error_type = Some("Internal".into());
            result.error_message = Some(e);
            finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
            return result;
        }
    };

    // 3. 超时：杀树已发生，直接记录。
    if attempt.timed_out {
        result.exit_code = attempt.exit_code;
        result.stdout = attempt.stdout.clone();
        result.stderr = attempt.stderr.clone();
        result.error_type = Some("Timeout".into());
        result.error_message = Some(format!(
            "插件执行超过 {}s 仍未结束，已终止进程树",
            timeout.as_secs()
        ));
        finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
        return result;
    }

    // 4. 成功（exit 0）：解析 stdout 为 result。
    if attempt.exit_code == Some(0) {
        set_success(&mut result, &attempt);
        finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
        return result;
    }

    // 5. 失败路径：计算缺失依赖。
    let missing =
        collect_missing_packages(&attempt.stderr, attempt.exit_code, &spec.dependencies, &spec.runtime);

    // exit 42 但未能解析出缺失包名：确属依赖缺失但包名未知。
    if attempt.exit_code == Some(42) && missing.is_empty() {
        result.exit_code = Some(42);
        result.stdout = attempt.stdout.clone();
        result.stderr = attempt.stderr.clone();
        result.error_type = Some("DependencyMissing".into());
        result.error_message = Some("脚本以 exit 42 报告依赖缺失，但无法解析具体包名".into());
        finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
        return result;
    }

    // 非依赖类错误：直接记录，不重试。
    if missing.is_empty() {
        set_failure(&mut result, &attempt, "RuntimeError");
        if result.error_message.is_none() {
            result.error_message =
                Some(attempt.stderr.lines().last().unwrap_or("脚本执行失败").to_string());
        }
        finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
        return result;
    }

    // 6. 依赖自愈：安装 + 重试一次（仅一次，与现 sandbox 一致）。
    tracing::info!(
        "[plugin] 检测到缺失依赖，准备自愈 plugin={} runtime={} missing={:?}",
        spec.identifier,
        spec.runtime,
        missing
    );
    match install_deps(app, mamba, bun, &call_dir, &spec.runtime, &missing).await {
        Ok(specs) => {
            result.deps_installed = specs.clone();
            tracing::info!(
                "[plugin] 依赖自愈安装完成 plugin={} 已安装={:?}",
                spec.identifier,
                specs
            );
        }
        Err(e) => tracing::warn!("[plugin] 依赖安装失败（将直接重试并透传错误）：{e}"),
    }
    let retry = match run_sidecar_with_stdin(
        app,
        sidecar,
        args,
        Some(&call_dir),
        &envs,
        Some(&params_json),
        timeout,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            result.error_type = Some("Internal".into());
            result.error_message = Some(e);
            finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
            return result;
        }
    };
    if retry.exit_code == Some(0) {
        set_success(&mut result, &retry);
    } else if retry.exit_code == Some(42) {
        set_failure(&mut result, &retry, "DependencyMissing");
    } else {
        set_failure(&mut result, &retry, "RuntimeError");
    }

    finalize(&mut result, app, spec, params, agent_id, session_id, source, start).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机用例（2026-09-16 Bun 自愈）：exit 42 的 missing_package 是整句报错
    /// （Bun 新版用单引号），必须提取干净包名 `ms`，否则 bun add 拿到整句必败。
    #[test]
    fn bun_missing_package_sentence_extracts_clean_name() {
        let stderr = serde_json::json!({
            "error_type": "DependencyMissing",
            "missing_package": "Cannot find package 'ms' imported from E:\\Codes\\x\\plugin_runs\\call_1\\user_script.ts"
        })
        .to_string();
        let got = collect_missing_packages(&stderr, Some(42), &[], "bun");
        assert_eq!(got, vec!["ms".to_string()]);
    }

    /// Python 侧回归：missing_package = e.name（干净包名），声明依赖在 42 时并入。
    #[test]
    fn python_missing_package_and_declared_deps_merge() {
        let stderr = serde_json::json!({
            "error_type": "DependencyMissing",
            "missing_package": "humanize"
        })
        .to_string();
        let got = collect_missing_packages(
            &stderr,
            Some(42),
            &["requests".to_string()],
            "python",
        );
        assert!(got.contains(&"humanize".to_string()));
        assert!(got.contains(&"requests".to_string()));
    }
}
