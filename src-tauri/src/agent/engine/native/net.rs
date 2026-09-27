//! 网络域工具：http_request（SSRF 防护 + DNS pin）（S1 拆分自 native.rs，台账 §2.1）。

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

use std::fs::OpenOptions;
use std::io::Write;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;
use tokio::time::Duration;

use crate::agent::engine::tools::AgentTool;
use crate::agent::engine::tools::ToolBehavior;
use crate::agent::engine::tools::PathGuard;
use crate::agent::engine::tools::PermissionLevel;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolError;


// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
use reqwest::redirect::Policy as RedirectPolicy;
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。

/// read_file 体积上限：net 域单测断言超长响应拒收时复用同一阈值（与 fs 域口径一致）。
const MAX_READ_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 构造标准 function-calling 定义骨架。

use super::*;


pub struct HttpRequestTool;

#[async_trait]
impl AgentTool for HttpRequestTool {
    fn name(&self) -> String {
        "native__http_request".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("http"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__http_request",
            "发起 HTTP 请求（GET / POST / PUT / DELETE / PATCH），需用户审批。仅允许 http/https。\
             可指定 headers 与请求体 body；save_to 指定工作空间内落盘路径时响应体写盘并返回大小，\
             否则读入内存（超过 2MB 拒绝）并返回截断文本。超时 30s、重定向上限 5。\
             支持配置主机白名单（app_config.http_allowed_hosts）：配置后仅允许命中域（含子域）及其解析到的公网地址；\
             白名单为空时不限制主机名，但始终拦截环回/私有/链路本地等内网与云元数据地址（SSRF 防护）；审批作为最后一道门。",
            json!({
                "method": { "type": "string", "description": "HTTP 方法：GET / POST / PUT / DELETE / PATCH" },
                "url": { "type": "string", "description": "目标 URL（仅 http/https）" },
                "headers": { "type": "object", "description": "可选请求头键值对" },
                "body": { "type": "string", "description": "可选请求体（POST/PUT/PATCH 使用）" },
                "save_to": { "type": "string", "description": "可选响应体落盘路径（工作空间内），不传则返回截断文本" }
            }),
            &["method", "url"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let method = args
            .get("method")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("http_request 缺少 method 参数".into()))?;
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("http_request 缺少 url 参数".into()))?;
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let save_to = args
            .get("save_to")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 协议白名单：仅 http/https（拒绝 file:// / ftp:// 等）。
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(ToolError::InvalidArgs(
                "仅支持 http/https 协议（拒绝 file://、ftp:// 等）".into(),
            ));
        }
        // 解析 URL 以可靠提取 host（P0 #1：初始请求也必须过白名单，否则攻击可直接发往非白名单主机）。
        let parsed = match reqwest::Url::parse(url) {
            Ok(u) => u,
            Err(e) => {
                return Err(ToolError::InvalidArgs(format!(
                    "URL 解析失败：{}（{}）",
                    url, e
                )))
            }
        };
        // HTTP 方法白名单（P0 #3）：仅允许安全方法，拒绝 TRACE / CONNECT 等可滥用方法。
        let method = match method.to_uppercase().as_str() {
            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" => {
                reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
                    .map_err(|e| ToolError::InvalidArgs(format!("非法 HTTP 方法：{}（{e}）", method)))?
            }
            other => {
                return Err(ToolError::InvalidArgs(format!(
                    "不支持的 HTTP 方法：{}（仅允许 GET / POST / PUT / DELETE / PATCH）",
                    other
                )))
            }
        };

        // 主机白名单（P0 #1）：配置后初始 URL 主机必须命中，否则直接拒绝，请求根本不发。
        let allowed = ctx.http_allowed_hosts.clone();
        if !allowed.is_empty() {
            match parsed.host_str() {
                Some(h) if allowed.iter().any(|e| host_matches(h, e)) => {}
                _ => {
                    return Err(ToolError::InvalidArgs(format!(
                        "目标主机不在白名单内：{}（配置 http_allowed_hosts 后可放宽；或留空不限制主机名）",
                        parsed.host_str().unwrap_or(url)
                    )))
                }
            }
        }

        let call_id = next_call_id();
        tracing::info!(
            "[agent][{}] native__http_request: method={} url={} host_mode={}",
            call_id,
            method,
            crate::agent::engine::runtime::clip(url, 300),
            if allowed.is_empty() {
                "任意(SSRF IP 拦截)"
            } else {
                "白名单"
            }
        );

        // 客户端：始终挂载自定义 DNS 解析器做 SSRF IP 级防御（P0 #2，连接前拦截环回/私有/链路本地等）；
        // 白名单非空时再叠加每个重定向跃点的主机校验（防开放重定向绕过白名单），否则沿用默认上限 5 次跟随。
        let mut client_builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .dns_resolver(std::sync::Arc::new(SsrfSafeResolver));
        client_builder = if allowed.is_empty() {
            client_builder.redirect(RedirectPolicy::limited(5))
        } else {
            client_builder.redirect(RedirectPolicy::custom(move |attempt| {
                match attempt.url().host_str() {
                    Some(h) if allowed.iter().any(|e| host_matches(h, e)) => attempt.follow(),
                    _ => attempt.stop(),
                }
            }))
        };
        let client = client_builder
            .build()
            .map_err(|e| ToolError::ExecutionFailed(format!("创建 HTTP 客户端失败：{e}")))?;

        let mut req = client.request(method.clone(), url);
        let mut has_content_type = false;
        let mut has_user_agent = false;
        if let Some(headers) = args.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in headers {
                let hv = match v.as_str() {
                    Some(s) => s,
                    None => continue, // 非字符串 header 值跳过
                };
                match (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(hv),
                ) {
                    (Ok(name), Ok(val)) => {
                        if name == reqwest::header::CONTENT_TYPE {
                            has_content_type = true;
                        }
                        if name == reqwest::header::USER_AGENT {
                            has_user_agent = true;
                        }
                        req = req.header(name, val);
                    }
                    _ => {
                        return Err(ToolError::InvalidArgs(format!("非法请求头：{}", k)));
                    }
                }
            }
        }
        // P2 #10：带 body 且未显式设置 Content-Type 时，默认 application/json。
        if body.is_some() && !has_content_type {
            req = req.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        // P3 #15：未显式设置 User-Agent 时，默认带标识，便于服务端审计。
        if !has_user_agent {
            req = req.header(reqwest::header::USER_AGENT, "WorkDuo-Agent/1.0");
        }
        if let Some(b) = &body {
            req = req.body(b.clone());
        }

        let start = Instant::now();
        // P2-4（2026-09-23）：瞬态网络错误（连接/DNS/超时）自动重试 ≤2 次（退避 1s/2s）——
        // L2 实测外部源偶发 `error sending request` 一败即整步挂。非瞬态（协议/参数/白名单/SSRF）不重试；
        // 失败统一带 error_code= 前缀供上层结构化判读（DNS/SSRF/超时不再是难分辨的裸串）。
        const HTTP_ATTEMPTS: usize = 3; // 首次 + 2 次重试
        let mut resp: Option<reqwest::Response> = None;
        let mut last_err: Option<reqwest::Error> = None;
        for attempt in 1..=HTTP_ATTEMPTS {
            let this_req = req.try_clone().ok_or_else(|| {
                ToolError::ExecutionFailed("请求构建失败（body 不可克隆，无法重试）".into())
            })?;
            match this_req.send().await {
                Ok(r) => {
                    resp = Some(r);
                    break;
                }
                Err(e) => {
                    if !(e.is_connect() || e.is_timeout()) || attempt == HTTP_ATTEMPTS {
                        last_err = Some(e);
                        break;
                    }
                    let wait = Duration::from_millis(1000 * attempt as u64);
                    tracing::warn!(
                        "[agent][{}] http_request 第 {attempt} 次瞬态失败（{e}），{}ms 后重试",
                        call_id,
                        wait.as_millis()
                    );
                    tokio::time::sleep(wait).await;
                }
            }
        }
        if let Some(e) = last_err {
            let code = classify_http_error(&e);
            return Err(ToolError::ExecutionFailed(format!(
                "请求失败（error_code={code}）：{e}"
            )));
        }
        let resp = resp.ok_or_else(|| ToolError::ExecutionFailed("请求未返回（内部错误）".into()))?;
        let status = resp.status();
        let headers_summary: Vec<String> = resp
            .headers()
            .iter()
            .take(20)
            .map(|(k, v)| format!("{}: {}", k, v.to_str().unwrap_or("<binary>")))
            .collect();
        let elapsed_ms = start.elapsed().as_millis();

        // 无 save_to 时按 content-length 预先拦截超 2MB（避免全量读入内存）。
        if save_to.is_none() {
            if let Some(cl) = resp.content_length() {
                if cl > MAX_READ_FILE_BYTES {
                    return Err(ToolError::ExecutionFailed(format!(
                        "响应体 {} 字节超过 2MB 上限，请改用 save_to 落盘",
                        cl
                    )));
                }
            }
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("读取响应体失败：{e}")))?;

        let mut out = format!("HTTP {}（耗时 {}ms）\n", status.as_u16(), elapsed_ms);
        if !headers_summary.is_empty() {
            out.push_str(&headers_summary.join("\n"));
            out.push('\n');
        }

        if let Some(save_path) = &save_to {
            // 落盘：过 PathGuard + 闭环前置检查 + TOCTOU 写回（与 write_file 同构）。
            let abs = PathGuard::check(save_path, ctx)?;
            let probe = probe_path(&abs);
            if probe.exists && probe.is_dir {
                return Err(ToolError::ExecutionFailed(format!(
                    "save_to 目标是目录：{}",
                    abs.display()
                )));
            }
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建文件失败：{e}")))?;
            PathGuard::verify_opened(&abs, &file, ctx)?;
            file.set_len(0)
                .map_err(|e| ToolError::ExecutionFailed(format!("清空失败：{e}")))?;
            file.write_all(&bytes)
                .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
            out.push_str(&format!("已保存到 {}（{} 字节）", abs.display(), bytes.len()));
        } else {
            // 无 save_to：内存截断返回。
            if (bytes.len() as u64) > MAX_READ_FILE_BYTES {
                return Err(ToolError::ExecutionFailed(format!(
                    "响应体 {} 字节超过 2MB 上限，请改用 save_to 落盘",
                    bytes.len()
                )));
            }
            let text = String::from_utf8_lossy(&bytes);
            let clipped = if text.chars().count() > 1000 {
                format!(
                    "{}…（已截断，完整内容请用 save_to 落盘）",
                    text.chars().take(1000).collect::<String>()
                )
            } else {
                text.to_string()
            };
            out.push_str(&format!("Body（截断）：\n{}", clipped));
        }
        Ok(out)
    }
}

