//! SFTP 文件族实现（对标 Xftp；协议 SFTP over SSH，不做明文 FTP）。
//!
//! 提供 list / mkdir_p / upload / download / remove / sync 六组原语，
//! 供 `host__*` 工具调用（调用方已过 HostAuthz 路径白/黑名单）。
//! 递归遍历：远端走 SFTP read_dir，本地走 std::fs；同步按「相对路径 + 大小 + mtime」判异。
//!
//! S9（2026-09-26）：传输一律 `tokio::io::copy` 流式（旧 `read_to_end` 整文件进内存，
//! 大文件 OOM 风险）；上传后回写远端 mtime=本地、下载后回写本地 mtime=远端——
//! 否则 mtime 判异会让每次 sync 都重传（传输完成时间 ≠ 源 mtime，经典坑）。

use std::path::Path;

use russh::client::Handle;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use russh_sftp::client::SftpSession;
use tokio::io::AsyncWriteExt;

use super::pool::PoolHandler;

/// mtime 判异容差（秒）：本地毫秒→秒截断与远端 stat 粒度误差，≤2s 视为相同。
pub const MTIME_TOLERANCE_SECS: i64 = 2;

/// 远端目录条目。
#[derive(Debug, Clone)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

async fn open_sftp(handle: &mut Handle<PoolHandler>) -> Result<SftpSession, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP 通道失败：{e}"))?;
    // 必须先请求 sftp 子系统：否则服务端在该通道上起的是 shell，SFTP 初始化包
    // 永远无响应 → SftpSession::new 10s 超时（2026-09-27 真机复测实锤，47.100.74.23）。
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 sftp 子系统失败：{e}"))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP 会话建立失败：{e}"))
}

/// 列远端目录（不含 `.` / `..`）。
pub async fn list_dir(handle: &mut Handle<PoolHandler>, dir: &str) -> Result<Vec<RemoteEntry>, String> {
    let sftp = open_sftp(handle).await?;
    let entries = sftp
        .read_dir(dir)
        .await
        .map_err(|e| format!("列目录失败：{e}"))?;
    Ok(entries
        .map(|e| RemoteEntry {
            name: e.file_name(),
            is_dir: e.file_type().is_dir(),
            size: e.metadata().size.unwrap_or(0),
        })
        .collect())
}

/// 递归建目录（逐段创建，已存在跳过）。
pub async fn mkdir_p(handle: &mut Handle<PoolHandler>, path: &str) -> Result<(), String> {
    let sftp = open_sftp(handle).await?;
    mkdir_p_sess(&sftp, path).await
}

async fn mkdir_p_sess(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let norm = path.trim_end_matches('/');
    let mut cur = String::new();
    for seg in norm.split('/') {
        if seg.is_empty() {
            cur.push('/');
            continue;
        }
        cur = format!("{}/{}", cur.trim_end_matches('/'), seg);
        if cur.is_empty() {
            continue;
        }
        if sftp.metadata(&cur).await.map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        sftp.create_dir(&cur)
            .await
            .map_err(|e| format!("创建目录失败（{cur}）：{e}"))?;
    }
    Ok(())
}

async fn is_remote_dir(sftp: &SftpSession, path: &str) -> bool {
    sftp.metadata(path).await.map(|m| m.is_dir()).unwrap_or(false)
}

/// 上传：本地文件/目录 → 远端（可递归）。
pub async fn upload(
    handle: &mut Handle<PoolHandler>,
    local: &Path,
    remote: &str,
    recursive: bool,
) -> Result<(u64, u64), String> {
    // (文件数, 字节数)
    let sftp = open_sftp(handle).await?;
    if local.is_file() {
        let bytes = upload_file(&sftp, local, remote).await?;
        return Ok((1, bytes));
    }
    if !recursive {
        return Err("本地路径是目录，需 recursive=true 才能递归上传".into());
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![local.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("读本地目录失败：{e}"))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(local)
                    .map_err(|_| "本地路径前缀异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let remote_file = format!("{}/{}", remote.trim_end_matches('/'), rel);
                if let Some(parent) = remote_parent(&remote_file) {
                    mkdir_p_sess(&sftp, &parent).await?;
                }
                bytes += upload_file(&sftp, &p, &remote_file).await?;
                count += 1;
            }
        }
    }
    Ok((count, bytes))
}

fn remote_parent(p: &str) -> Option<String> {
    let idx = p.rfind('/')?;
    Some(p[..idx].to_string())
}

/// 本地 mtime → unix 秒（失败/无文件返回 0，调用方退化为 size-only 判异）。
pub fn local_mtime_secs(p: &Path) -> i64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 上传单个文件：流式 copy（64KB 块，不整读进内存），完成后回写远端 mtime=本地。
/// 返回传输字节数。setstat 失败仅告警不致命（该服务器不支持时判异退化为 size-only）。
async fn upload_file(sftp: &SftpSession, local: &Path, remote: &str) -> Result<u64, String> {
    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("读本地文件失败（{}）：{e}", local.display()))?;
    let mut remote_file = sftp
        .open_with_flags(remote, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .map_err(|e| format!("写远端文件失败（{remote}）：{e}"))?;
    let bytes = tokio::io::copy(&mut local_file, &mut remote_file)
        .await
        .map_err(|e| format!("传输失败（{remote}）：{e}"))?;
    remote_file
        .shutdown()
        .await
        .map_err(|e| format!("关闭远端文件失败：{e}"))?;
    // 回写远端 mtime = 本地源 mtime（mtime 判异的前提：同步后两侧一致，下次 sync 不重传）。
    let mtime = local_mtime_secs(local);
    if mtime > 0 {
        let attrs = FileAttributes {
            mtime: Some(mtime as u32),
            atime: Some(mtime as u32),
            ..Default::default()
        };
        if let Err(e) = sftp.set_metadata(remote, attrs).await {
            tracing::warn!("[sftp] 回写远端 mtime 失败（{remote}）：{e}——该文件下次 sync 将按 size-only 判异");
        }
    }
    Ok(bytes)
}

/// 下载：远端文件/目录 → 本地（可递归）。
pub async fn download(
    handle: &mut Handle<PoolHandler>,
    remote: &str,
    local: &Path,
    recursive: bool,
) -> Result<(u64, u64), String> {
    let sftp = open_sftp(handle).await?;
    if !is_remote_dir(&sftp, remote).await {
        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建本地目录失败：{e}"))?;
        }
        let size = download_file(&sftp, remote, local).await?;
        return Ok((1, size));
    }
    if !recursive {
        return Err("远端路径是目录，需 recursive=true 才能递归下载".into());
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![remote.to_string()];
    while let Some(dir) = stack.pop() {
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("列远端目录失败：{e}"))?;
        for entry in entries {
            let p = entry.path();
            if entry.file_type().is_dir() {
                stack.push(p);
                continue;
            }
            let rel = p.trim_start_matches(remote.trim_end_matches('/'));
            let local_file = local.join(rel.trim_start_matches('/'));
            if let Some(parent) = local_file.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("创建本地目录失败：{e}"))?;
            }
            bytes += download_file(&sftp, &p, &local_file).await?;
            count += 1;
        }
    }
    Ok((count, bytes))
}

/// 下载单个文件：流式 copy，完成后回写本地 mtime = 远端源 mtime。返回传输字节数。
async fn download_file(sftp: &SftpSession, remote: &str, local: &Path) -> Result<u64, String> {
    // 先取远端 mtime（写完再 set_modified；stat 失败不致命，退化为系统时间）。
    let remote_mtime = sftp
        .metadata(remote)
        .await
        .ok()
        .and_then(|m| m.mtime)
        .map(|v| v as i64)
        .unwrap_or(0);
    let mut remote_file = sftp
        .open(remote)
        .await
        .map_err(|e| format!("读远端文件失败（{remote}）：{e}"))?;
    let mut local_file = tokio::fs::File::create(local)
        .await
        .map_err(|e| format!("写本地文件失败（{}）：{e}", local.display()))?;
    let bytes = tokio::io::copy(&mut remote_file, &mut local_file)
        .await
        .map_err(|e| format!("传输失败（{remote}）：{e}"))?;
    local_file
        .sync_all()
        .await
        .map_err(|e| format!("落盘失败（{}）：{e}", local.display()))?;
    drop(local_file);
    if remote_mtime > 0 {
        if let Some(t) = std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(remote_mtime as u64)) {
            // File::set_modified（1.75+）：打开句柄回写；失败仅影响下次判异精度，不致命
            if let Ok(f) = std::fs::OpenOptions::new().append(true).open(local) {
                let _ = f.set_modified(t);
            }
        }
    }
    Ok(bytes)
}

/// 删除远端文件 / 目录（recursive=true 时递归删除）。
pub async fn remove(handle: &mut Handle<PoolHandler>, remote: &str, recursive: bool) -> Result<(u64, u64), String> {
    // (删除文件数, 删除目录数)
    let sftp = open_sftp(handle).await?;
    remove_inner(&sftp, remote, recursive).await
}

async fn remove_inner(sftp: &SftpSession, remote: &str, recursive: bool) -> Result<(u64, u64), String> {
    let (mut files, mut dirs) = (0u64, 0u64);
    if is_remote_dir(sftp, remote).await {
        if !recursive {
            return Err("远端路径是目录，需 recursive=true 才能递归删除".into());
        }
        let entries = sftp
            .read_dir(remote)
            .await
            .map_err(|e| format!("列远端目录失败：{e}"))?;
        for entry in entries {
            let p = entry.path();
            let (f, d) = Box::pin(remove_inner(sftp, &p, true)).await?;
            files += f;
            dirs += d;
        }
        sftp.remove_dir(remote)
            .await
            .map_err(|e| format!("删除远端目录失败：{e}"))?;
        dirs += 1;
    } else {
        sftp.remove_file(remote)
            .await
            .map_err(|e| format!("删除远端文件失败：{e}"))?;
        files += 1;
    }
    Ok((files, dirs))
}

/// 同步条目（相对路径 + 大小 + mtime，unix 秒；未知为 0 → 判异退化为 size-only）。
#[derive(Debug, Clone)]
pub struct SyncEntry {
    pub rel: String,
    pub size: u64,
    pub mtime: i64,
}

/// 判异：size 不同必异；双方 mtime 均已知（>0）且相差超容差判异。
/// 任一侧 mtime 未知（0）时退化为 size-only（旧语义，向后兼容）。
pub fn entries_differ(a: &SyncEntry, b: &SyncEntry) -> bool {
    if a.size != b.size {
        return true;
    }
    if a.mtime > 0 && b.mtime > 0 {
        return (a.mtime - b.mtime).abs() > MTIME_TOLERANCE_SECS;
    }
    false
}

/// exclude 模式匹配（S9：取代旧的 `rel.contains(pat)` 子串匹配——`exclude:["log"]`
/// 曾误伤 `catalog.txt`）。语义：
/// - 含 `/`：相对路径前缀匹配（`build/` 排除 build 目录整棵）；
/// - 含 `*` / `?`：通配匹配（`*.log` 对 basename、`a/*/tmp` 对 rel）；
/// - 纯名：任意**路径段**精确等于该名（`node_modules` 排除任意层级的同名目录）。
pub fn is_excluded(rel: &str, pattern: &str) -> bool {
    let pattern = pattern.trim().trim_end_matches('/');
    if pattern.is_empty() {
        return false;
    }
    if pattern.contains('/') {
        // 前缀（目录树）或全路径通配
        if rel.starts_with(pattern) && rel.as_bytes().get(pattern.len()) == Some(&b'/') {
            return true;
        }
        return glob_match(rel, pattern);
    }
    if pattern.contains('*') || pattern.contains('?') {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        return glob_match(name, pattern) || glob_match(rel, pattern);
    }
    // 纯名：任意路径段精确匹配
    rel.split('/').any(|seg| seg == pattern)
}

/// 极简 glob：`*` 跨零或多字符、`?` 单字符（递归双指针，无依赖）。
pub fn glob_match(text: &str, pattern: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    fn inner(t: &[char], p: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some('*'), _) => inner(t, &p[1..]) || (!t.is_empty() && inner(&t[1..], p)),
            (Some('?'), Some(_)) => inner(&t[1..], &p[1..]),
            (Some(&pc), Some(&tc)) if pc == tc => inner(&t[1..], &p[1..]),
            _ => false,
        }
    }
    inner(&t, &p)
}

/// 列远端目录树（相对 rel 前缀，含 size + mtime）。
pub async fn list_tree(
    handle: &mut Handle<PoolHandler>,
    root: &str,
) -> Result<Vec<SyncEntry>, String> {
    let sftp = open_sftp(handle).await?;
    let mut out = Vec::new();
    let mut stack = vec![root.to_string()];
    while let Some(dir) = stack.pop() {
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("列远端目录失败：{e}"))?;
        for entry in entries {
            let p = entry.path();
            if entry.file_type().is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .trim_start_matches(root.trim_end_matches('/'))
                    .trim_start_matches('/')
                    .to_string();
                out.push(SyncEntry {
                    rel,
                    size: entry.metadata().size.unwrap_or(0),
                    mtime: entry.metadata().mtime.map(|v| v as i64).unwrap_or(0),
                });
            }
        }
    }
    Ok(out)
}

/// 列本地目录树（相对 rel 前缀，含 size + mtime）。
pub fn list_local_tree(root: &Path) -> Result<Vec<SyncEntry>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("读本地目录失败：{e}"))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .map_err(|_| "本地路径前缀异常".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(SyncEntry {
                    rel,
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                    mtime: local_mtime_secs(&p),
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(rel: &str, size: u64, mtime: i64) -> SyncEntry {
        SyncEntry { rel: rel.into(), size, mtime }
    }

    /// 判异：size 异必异；mtime 容差内视为同；任一侧未知退化为 size-only。
    #[test]
    fn entries_differ_semantics() {
        assert!(entries_differ(&e("a", 10, 100), &e("a", 20, 100)), "size 不同必异");
        assert!(!entries_differ(&e("a", 10, 100), &e("a", 10, 101)), "mtime 差 1s 容差内");
        assert!(entries_differ(&e("a", 10, 100), &e("a", 10, 200)), "mtime 差 100s 判异");
        assert!(!entries_differ(&e("a", 10, 0), &e("a", 10, 999999)), "一侧 mtime 未知 → size-only");
        assert!(!entries_differ(&e("a", 10, 100), &e("a", 10, 100)), "全同不判异");
    }

    /// exclude：前缀 / 路径段 / 通配；子串误伤回归（旧 rel.contains 实锤）。
    #[test]
    fn is_excluded_path_segment_semantics() {
        assert!(is_excluded("build/out.js", "build"), "纯名匹配路径段");
        assert!(is_excluded("a/node_modules/x.js", "node_modules"));
        assert!(!is_excluded("catalog.txt", "log"), "子串误伤回归：log 不得命中 catalog");
        assert!(is_excluded("logs/a.txt", "logs"), "目录名精确命中");
        assert!(is_excluded("logs/a.txt", "logs/"), "带斜杠前缀归一");
        assert!(is_excluded("tmp/x.log", "*.log"), "basename 通配");
        assert!(!is_excluded("tmp/logx.txt", "*.log"), "通配不误伤");
        assert!(is_excluded("src/a/b.rs", "src/"), "目录树前缀");
        assert!(!is_excluded("a.txt", ""), "空模式不排除");
    }

    /// 极简 glob：* 跨零或多字符、? 单字符。
    #[test]
    fn glob_match_basics() {
        assert!(glob_match("a.txt", "*.txt"));
        assert!(glob_match("a.txt", "*"));
        assert!(glob_match("", "*"));
        assert!(glob_match("a", "?"));
        assert!(!glob_match("ab", "?"));
        assert!(glob_match("2026-09-26.log", "2026-*.log"));
        assert!(!glob_match("b.txt", "a*"));
    }
}
