//! `host_exec` 核心实现：非交互执行 + `as_user` 提权包装 + 超时强杀。
//!
//! - Shell：远端 `bash -lc '<cmd>'`（无 bash 退化由远端用户环境决定，文档约定 /bin/sh -c）；
//! - `as_user=login`：原样执行（不提权）；
//! - `as_user=root/其他`：`sudo -n -u <as_user> -- bash -lc '<cmd>'`（须主机 sudo 策略允许，
//!   且已被 HostAuthz 升级审批）；
//! - `cwd`：`cd '<cwd>' &&` 前缀（HostAuthz 已校验落在 path_allow）；
//! - 超时：默认 60s、上限 300s；超时丢弃通道（远端会话随之终止），返回结构化错误。

use russh::client::Handle;

use super::pool::PoolHandler;

#[derive(Debug)]
pub struct ExecOutcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: i64,
}

/// shell 单引号安全包裹：`'` → `'\''`。
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 组装远端最终命令（cwd 前缀 + as_user 提权包装）。
pub fn build_remote_command(command: &str, cwd: Option<&str>, as_user: &str, login_user: &str) -> String {
    let body = match cwd {
        Some(c) if !c.trim().is_empty() => format!("cd {} && {}", sq(c.trim()), command),
        _ => command.to_string(),
    };
    let base = format!("bash -lc {}", sq(&body));
    if as_user != "login" && !as_user.is_empty() && as_user != login_user {
        format!("sudo -n -u {} -- {}", as_user, base)
    } else {
        base
    }
}

/// 流式推送封顶：单命令累计推送上限（台账 D5）——tail -f 类高频流防刷屏，
/// 超出后静默丢弃（终态 ExecOutcome 仍含完整输出，不受影响）。
const STREAM_CAP_BYTES: usize = 64 * 1024;

/// 执行命令并收集输出（调用方已过 HostAuthz）。
///
/// `on_output`：可选增量回调 `(is_stderr, chunk)`——台账 D5 流式传输，长命令
/// 执行期间逐块推送 stdout/stderr；None 时行为与旧版完全一致（静默收集）。
pub async fn exec_command(
    handle: &mut Handle<PoolHandler>,
    command: &str,
    cwd: Option<&str>,
    as_user: &str,
    login_user: &str,
    timeout_sec: u64,
    on_output: Option<&(dyn Fn(bool, &str) + Send + Sync)>,
) -> Result<ExecOutcome, String> {
    let timeout_sec = timeout_sec.clamp(1, 300);
    let remote = build_remote_command(command, cwd, as_user, login_user);
    let started = std::time::Instant::now();

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败：{e}"))?;
    channel
        .exec(false, remote.as_str())
        .await
        .map_err(|e| format!("命令发送失败：{e}"))?;

    let collect = async {
        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut exit_code: Option<u32> = None;
        let mut streamed: usize = 0usize;
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => {
                    // 流式推送（封顶前）：终态完整输出不受封顶影响
                    if let Some(cb) = on_output {
                        if streamed < STREAM_CAP_BYTES {
                            cb(false, &String::from_utf8_lossy(&data));
                            streamed += data.len();
                        }
                    }
                    stdout.extend_from_slice(&data);
                }
                Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                    if let Some(cb) = on_output {
                        if streamed < STREAM_CAP_BYTES {
                            cb(true, &String::from_utf8_lossy(&data));
                            streamed += data.len();
                        }
                    }
                    stderr.extend_from_slice(&data);
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                Some(russh::ChannelMsg::Eof) => {}
                Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        (stdout, stderr, exit_code)
    };

    let (stdout, stderr, exit_code) = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_sec),
        collect,
    )
    .await
    {
        Ok(v) => v,
        Err(_) => {
            // 超时强杀：丢弃通道（通道关闭即远端会话终止），结构化报错给 LLM 纠偏。
            return Err(format!(
                "命令超时（{}s）已强制终止：可调大 timeout_sec（上限 300）或拆分命令",
                timeout_sec
            ));
        }
    };

    Ok(ExecOutcome {
        exit_code: exit_code.map(|c| c as i32),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        elapsed_ms: started.elapsed().as_millis() as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_command_in_bash_lc() {
        assert_eq!(build_remote_command("ls -la", None, "login", "root"), "bash -lc 'ls -la'");
    }

    #[test]
    fn prefixes_cwd_with_safe_quoting() {
        let cmd = build_remote_command("ls", Some("/var/www"), "login", "root");
        // body（cd '/var/www' && ls）整体再被 sq 包裹 → cwd 引号双重转义，属正确行为
        assert!(cmd.starts_with("bash -lc 'cd "), "{}", cmd);
        assert!(cmd.contains("'\\''"), "cwd 引号应被 POSIX 转义：{}", cmd);
        assert!(cmd.ends_with(" && ls'"), "{}", cmd);
        // 未双重转义的形态（裸 cd '/var/www'）不得出现
        assert!(!cmd.contains("cd '/var/www'"), "{}", cmd);
    }

    #[test]
    fn escapes_single_quote_in_command() {
        // 单引号注入防护：`'` → `'\''`
        let cmd = build_remote_command("echo 'a b'", None, "login", "root");
        assert!(cmd.contains("'\\''"), "应含 POSIX 单引号转义：{}", cmd);
        assert!(!cmd.contains("''a b''"), "{}", cmd);
    }

    #[test]
    fn escapes_single_quote_in_cwd() {
        let cmd = build_remote_command("ls", Some("/o'flag"), "login", "root");
        // 裸 cwd 不得出现（未转义的 ' 会破坏外层包裹）
        assert!(!cmd.contains("/o'flag"), "{}", cmd);
        // 且含 POSIX 转义序列
        assert!(cmd.contains("'\\''"), "{}", cmd);
    }

    #[test]
    fn prepends_sudo_for_other_user() {
        let cmd = build_remote_command("ls", None, "deploy", "root");
        assert!(cmd.starts_with("sudo -n -u deploy -- "), "{}", cmd);
    }

    #[test]
    fn no_sudo_when_as_user_equals_login() {
        assert!(!build_remote_command("ls", None, "root", "root").starts_with("sudo"));
        // "login" 语义 = 登录用户本身
        assert!(!build_remote_command("ls", None, "login", "root").starts_with("sudo"));
        // 空串按 login 处理
        assert!(!build_remote_command("ls", None, "", "root").starts_with("sudo"));
    }
}
