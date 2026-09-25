//! Host 路径与命令策略（HOST_RISKY_SIGNALS + 路径白/黑名单）。
//!
//! **与本地 `agent/engine/policy.rs` 硬隔离**：本文件不得调用 `policy::evaluate_edge` /
//! 读写 local grants；同字面信号（如 `.env`）也以 `host:` 前缀独立声明。

use crate::host::types::{HostAction, ServerBinding};

/// 单条风险命中。
#[derive(Debug, Clone)]
pub struct RiskSignal {
    pub risk_key: &'static str,
    pub level: u8, // 0~3
    pub detail: String,
}

/// 归一化 POSIX 绝对路径：折叠 `.` / `..`、统一分隔符、去重复斜杠。
pub fn normalize_posix(p: &str) -> String {
    let normalized = p.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for seg in normalized.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    format!("/{}", out.join("/"))
}

/// 路径闸：`允许 ⇔ (命中 allow 或 allow 为空) ∧ 未命中 deny（deny 优先）∧ 归一化后仍在 allow 前缀内`。
pub fn check_path(path: &str, allow: &[String], deny: &[String]) -> Result<(), String> {
    let norm = normalize_posix(path);
    for d in deny {
        let d = normalize_posix(d);
        if norm == d || norm.starts_with(&format!("{}/", d.trim_end_matches('/'))) {
            return Err(format!("路径命中黑名单（{}）：{}", d, norm));
        }
    }
    if !allow.is_empty() {
        let hit = allow.iter().any(|a| {
            let a = normalize_posix(a);
            norm == a || norm.starts_with(&format!("{}/", a.trim_end_matches('/')))
        });
        if !hit {
            return Err(format!(
                "路径不在白名单内：{}（合法根：{}）",
                norm,
                allow.join(", ")
            ));
        }
        // `..` 逃逸在 normalize 已折叠；归一化后仍在 allow 前缀内即通过。
    }
    Ok(())
}

/// 默认黑名单（§5.1），叠加在用户配置之前。
pub const DEFAULT_DENY: &[&str] = &["/etc", "/root/.ssh", "/boot", "/proc", "/sys", "/dev"];

/// HOST_RISKY_SIGNALS 评估（§7.4）。返回全部命中（取最高级决定门禁）。
pub fn evaluate(
    binding: &ServerBinding,
    action: HostAction,
    as_user: &str,
    command: Option<&str>,
    remote_path: Option<&str>,
    extra_delete: bool,
) -> Vec<RiskSignal> {
    let mut out: Vec<RiskSignal> = Vec::new();
    let cmd = command.unwrap_or("").to_lowercase();
    let path = remote_path.unwrap_or("").to_lowercase();
    let norm_path = normalize_posix(&path);

    fn push_sig(out: &mut Vec<RiskSignal>, key: &'static str, level: u8, detail: String) {
        out.push(RiskSignal { risk_key: key, level, detail });
    }

    // 路径类（文件工具与命令cwd共用）
    if norm_path.contains("authorized_keys") || norm_path.contains("id_rsa")
        || norm_path.contains("id_ed25519") || norm_path.contains(".ssh/") {
        push_sig(&mut out, "host:sys_ssh", 2, format!("涉 SSH 密钥/授权文件：{}", norm_path));
    }
    for p in ["/etc", "/boot", "/proc", "/sys", "/dev"] {
        if norm_path == p || norm_path.starts_with(&format!("{}/", p)) {
            push_sig(&mut out, "host:sys_etc", 2, format!("系统路径：{}", norm_path));
            break;
        }
    }
    if norm_path == "/root" || norm_path.starts_with("/root/") {
        push_sig(&mut out, "host:sys_root", 2, format!("root 目录：{}", norm_path));
    }
    if norm_path.contains("credential") || norm_path.contains(".env") || norm_path.contains(".pem") {
        push_sig(&mut out, "host:cred_path", 2, format!("疑似凭证/环境文件：{}", norm_path));
    }

    // 命令类
    if !cmd.is_empty() {
        if cmd.contains("rm -rf") || cmd.contains("rm -fr") || cmd.contains("mkfs") || cmd.contains("dd if=") || cmd.contains("> /dev/sd") {
            push_sig(&mut out, "host:destruct", 3, format!("毁灭性命令：{}", cmd));
        }
        if cmd.contains("shutdown") || cmd.contains("reboot") || cmd.contains("systemctl stop") || cmd.contains("kill -9 1") {
            push_sig(&mut out, "host:service", 2, format!("服务/系统控制命令：{}", cmd));
        }
        if (cmd.contains("curl") || cmd.contains("wget")) && (cmd.contains("| sh") || cmd.contains("| bash"))
            || cmd.contains("| bash") {
            push_sig(&mut out, "host:pipe_shell", 3, "管道执行远程脚本（curl|sh 类）".into());
        }
        if cmd.contains("chmod 777") || cmd.contains("chown -r") {
            push_sig(&mut out, "host:perm", 2, format!("权限变更：{}", cmd));
        }
        if cmd.contains("bash -i") || cmd.contains("nc -e") {
            push_sig(&mut out, "host:net_out", 3, "反弹 shell 特征".into());
        }
        if cmd.contains("sudo ") || cmd.contains("sudo\t") || cmd.starts_with("sudo") || cmd.contains("su ") {
            push_sig(&mut out, "host:sudo", 2, "手拼 sudo/su（应改用 as_user 参数）".into());
        }
    }

    // 提权类
    if as_user != "login" && !as_user.is_empty() {
        push_sig(&mut out, "host:sudo", 2, format!("提权执行 as_user={}", as_user));
        if as_user == "root" {
            push_sig(&mut out, "host:sudo_root", 2, "提权目标为 root".into());
        }
        // sudo 目标须为档案声明的 sudo_user（§4.1 sudo_user 语义）：其余目标视为未授权提权（L3）
        if as_user != binding.sudo_user {
            push_sig(
                &mut out,
                "host:sudo_user_mismatch",
                3,
                format!("提权目标 {as_user} 不是服务器档案允许的 sudo 用户（{}）", binding.sudo_user),
            );
        }
    }

    // 同步删除
    if extra_delete {
        push_sig(&mut out, "host:sync_del", 2, "同步开启 delete_extraneous（删除远端多余文件）".into());
    }

    // 动作基线：exec/write 恒 L1+，delete 恒 L2
    let base = action.base_level();
    if base > 0 && out.is_empty() {
        push_sig(
            &mut out,
            "host:base",
            base,
            format!("{} 属敏感操作（无附加信号）", action.as_str()),
        );
    }
    out
}

/// 取最高风险级别。
pub fn max_level(signals: &[RiskSignal]) -> u8 {
    signals.iter().map(|s| s.level).max().unwrap_or(0)
}

/// 合成 risk_key（授权绑定维度之一；同会话同信号集合共享 grant）。
pub fn risk_key_of(signals: &[RiskSignal]) -> String {
    let mut keys: Vec<&str> = signals.iter().map(|s| s.risk_key).collect();
    keys.sort_unstable();
    keys.dedup();
    if keys.is_empty() {
        "host:base".to_string()
    } else {
        keys.join("+")
    }
}

/// 路径/提权前置闸（authorize 步骤 3~5）。Err = 结构化拒绝。
pub fn precheck(
    binding: &ServerBinding,
    action: HostAction,
    as_user: &str,
    command: Option<&str>,
    remote_path: Option<&str>,
    cwd: Option<&str>,
) -> Result<(), String> {
    let mut deny: Vec<String> = DEFAULT_DENY.iter().map(|s| s.to_string()).collect();
    deny.extend(binding.path_deny.iter().cloned());

    // cwd 闸（exec）
    if let Some(c) = cwd {
        if !c.trim().is_empty() {
            check_path(c, &binding.path_allow, &deny).map_err(|e| format!("CwdDenied：{e}"))?;
        }
    }
    // 远端路径闸（文件工具；exec 的命令内路径不做静态解析——由信号表覆盖）
    if let Some(p) = remote_path {
        if action != HostAction::RemoteExec {
            check_path(p, &binding.path_allow, &deny).map_err(|e| format!("PathDenied：{e}"))?;
        }
    }
    // 提权闸
    if as_user != "login" && !as_user.is_empty() {
        if binding.sudo_mode == "none" {
            return Err("SudoDenied：该主机禁止提权（sudo_mode=none），请以登录用户身份执行".into());
        }
        if let Some(cmd) = command {
            let low = cmd.to_lowercase();
            if low.contains("sudo") || low.starts_with("su ") || low.contains("; su ") {
                return Err("SudoDenied：禁止手拼 sudo/su，请改用 as_user 参数由系统包装提权".into());
            }
        }
    }
    // 命令内系统路径信号（exec 无显式路径参数，靠信号表 L2/L3 拦）
    let _ = command;
    Ok(())
}
