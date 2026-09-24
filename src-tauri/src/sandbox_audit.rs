//! 沙箱审计日志（2026-09-24 安全增强批次 · 观测优先不拦截）。
//!
//! 用户决策：网络/包依赖「只记审计日志不拦截」——一味拦截或白名单会伤害用户体验；
//! 审计独立成文件便于单独 IO 与查阅，落位 `$RESOURCES/logs/sandbox-audit.YYYY-MM-DD.log`
//! （与 mamba_root/bun_root 同级统一管理，按本地日期分文件，每行一条 JSON）。
//!
//! 覆盖观测：
//! 1. `script_features`：沙箱脚本执行前的静态特征扫描（网络调用 / 工作空间外路径 / 进程派生）
//! 2. `dep_install`：依赖安装（缺库自愈或显式安装的包名清单）
//!
//! ⚠️ 本模块**只记录不拦截**：审计是安全观测面，执行行为保持原样（用户体验优先）。

use std::io::Write;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// 审计事件类型：脚本静态特征。
pub const TYPE_SCRIPT_FEATURES: &str = "script_features";
/// 审计事件类型：依赖安装。
pub const TYPE_DEP_INSTALL: &str = "dep_install";

/// 解析审计日志目录：`$RESOURCES/logs`（与 mamba_root/bun_root 同级，回退 exe 父目录/logs）。
/// 与 `MambaManager::base_dir` 同款推导，保证「随应用打包、随应用迁移」。
fn audit_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .resource_dir()
        .ok()
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("logs")
}

/// 追加一条审计事件（JSON Lines；目录/文件自动创建，失败静默——审计不可阻塞主流程）。
fn write_event(app: &AppHandle, event: serde_json::Value) {
    let dir = audit_dir(app);
    let day = chrono::Local::now().format("%Y-%m-%d");
    let path = dir.join(format!("sandbox-audit.{day}.log"));
    // 静默失败：审计是观测面，磁盘异常不应打断沙箱执行。
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let mut line = event;
        line["ts"] = serde_json::json!(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string());
        if let Ok(mut s) = serde_json::to_string(&line) {
            s.push('\n');
            let _ = f.write_all(s.as_bytes());
        }
    }
}

/// 沙箱脚本静态特征扫描结果。
pub struct ScriptFeatures {
    /// 网络调用特征（urllib/requests/socket/fetch/http/axios 等）。
    pub net: Vec<String>,
    /// 工作空间外路径特征（盘符绝对路径、../、/home /tmp 等字面量；排除 WORKSPACE 注入行）。
    pub fs_out: Vec<String>,
    /// 进程派生特征（subprocess/os.system/child_process/Bun.spawn 等）。
    pub proc: Vec<String>,
}

impl ScriptFeatures {
    pub fn is_clean(&self) -> bool {
        self.net.is_empty() && self.fs_out.is_empty() && self.proc.is_empty()
    }
}

/// 对脚本源码做静态特征扫描（纯文本关键词级，非 AST；观测面足够，零依赖零误杀）。
pub fn scan_script(lang: &str, code: &str) -> ScriptFeatures {
    let mut f = ScriptFeatures {
        net: Vec::new(),
        fs_out: Vec::new(),
        proc: Vec::new(),
    };
    // 逐行扫描并排除 WORKSPACE 注入行（注入行本身含盘符绝对路径，会造成恒误报）。
    for line in code.lines() {
        if line.contains("WORKSPACE = r\"") || line.trim_start().starts_with("//") || line.trim_start().starts_with('#') && line.contains("注入") {
            continue;
        }
        let lower = line.to_lowercase();
        let net_pats: &[&str] = if lang == "bun" {
            &["fetch(", "axios", "http.request", "http.get", "import http", "net.connect", "xmlhttprequest"]
        } else {
            &["import requests", "requests.get", "requests.post", "import urllib", "urllib.request", "import socket", "socket.socket", "import http", "http.client", "import aiohttp", "import httpx"]
        };
        for p in net_pats {
            if lower.contains(p) && !f.net.iter().any(|x| x == p) {
                f.net.push((*p).to_string());
            }
        }
        let proc_pats: &[&str] = if lang == "bun" {
            &["child_process", "bun.spawn", "node:child_process", "exec(", "execsync("]
        } else {
            &["import subprocess", "subprocess.", "os.system", "os.popen", "import multiprocessing", "pty.spawn"]
        };
        for p in proc_pats {
            if lower.contains(p) && !f.proc.iter().any(|x| x == p) {
                f.proc.push((*p).to_string());
            }
        }
        // 工作空间外路径特征：盘符绝对路径 / POSIX 根目录 / 父目录穿越（仅命中字面量，控制流分析留待后续）。
        for p in ["c:\\", "c:/", "d:\\", "d:/", "e:\\", "e:/", "f:\\", "f:/", "/home/", "/tmp/", "/etc/", "/usr/", "../"] {
            if lower.contains(p) && !f.fs_out.iter().any(|x| x == p) {
                f.fs_out.push((*p).to_string());
            }
        }
    }
    f
}

/// 记录一次沙箱脚本执行的静态特征审计。
pub fn audit_script_features(
    app: &AppHandle,
    tool: &str,
    script_name: &str,
    workspace: Option<&std::path::Path>,
    features: &ScriptFeatures,
) {
    if features.is_clean() {
        return; // 无可疑特征不产生噪音
    }
    write_event(
        app,
        serde_json::json!({
            "type": TYPE_SCRIPT_FEATURES,
            "tool": tool,
            "script": script_name,
            "workspace": workspace.map(|p| p.to_string_lossy().to_string()),
            "features": {
                "net": features.net,
                "fs_out": features.fs_out,
                "proc": features.proc,
            },
            "policy": "observe-only",
        }),
    );
}

/// 记录一次依赖安装（缺库自愈或显式安装）。
pub fn audit_dep_install(app: &AppHandle, tool: &str, env: &str, packages: &[String], ok: bool) {
    write_event(
        app,
        serde_json::json!({
            "type": TYPE_DEP_INSTALL,
            "tool": tool,
            "env": env,
            "packages": packages,
            "ok": ok,
            "policy": "observe-only",
        }),
    );
}
