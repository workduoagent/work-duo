//! SFTP 文件族实现（对标 Xftp；协议 SFTP over SSH，不做明文 FTP）。
//!
//! 提供 list / mkdir_p / upload / download / remove / sync 六组原语，
//! 供 `host__*` 工具调用（调用方已过 HostAuthz 路径白/黑名单）。
//! 递归遍历：远端走 SFTP read_dir，本地走 std::fs；同步按「相对路径 + 大小」判异。

use std::path::Path;

use russh::client::Handle;
use russh_sftp::protocol::OpenFlags;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::pool::PoolHandler;

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
        upload_file(&sftp, local, remote).await?;
        let size = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
        return Ok((1, size));
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
                upload_file(&sftp, &p, &remote_file).await?;
                count += 1;
                bytes += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok((count, bytes))
}

fn remote_parent(p: &str) -> Option<String> {
    let idx = p.rfind('/')?;
    Some(p[..idx].to_string())
}

async fn upload_file(sftp: &SftpSession, local: &Path, remote: &str) -> Result<(), String> {
    let mut data = Vec::new();
    tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("读本地文件失败（{}）：{e}", local.display()))?
        .read_to_end(&mut data)
        .await
        .map_err(|e| format!("读本地文件失败：{e}"))?;
    let mut remote_file = sftp
        .open_with_flags(remote, OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .map_err(|e| format!("写远端文件失败（{remote}）：{e}"))?;
    remote_file
        .write_all(&data)
        .await
        .map_err(|e| format!("写远端文件失败：{e}"))?;
    remote_file
        .shutdown()
        .await
        .map_err(|e| format!("关闭远端文件失败：{e}"))?;
    Ok(())
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

async fn download_file(sftp: &SftpSession, remote: &str, local: &Path) -> Result<u64, String> {
    let mut remote_file = sftp
        .open(remote)
        .await
        .map_err(|e| format!("读远端文件失败（{remote}）：{e}"))?;
    let mut data = Vec::new();
    remote_file
        .read_to_end(&mut data)
        .await
        .map_err(|e| format!("读远端文件失败：{e}"))?;
    tokio::fs::write(local, &data)
        .await
        .map_err(|e| format!("写本地文件失败：{e}"))?;
    Ok(data.len() as u64)
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

/// 同步条目（相对路径 + 大小）。
#[derive(Debug, Clone)]
pub struct SyncEntry {
    pub rel: String,
    pub size: u64,
}

/// 列远端目录树（相对 rel 前缀，含 size）。
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
                });
            }
        }
    }
    Ok(out)
}

/// 列本地目录树（相对 rel 前缀，含 size）。
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
                });
            }
        }
    }
    Ok(out)
}
