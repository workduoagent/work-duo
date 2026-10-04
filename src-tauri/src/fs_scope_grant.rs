//! 持久目录 fs scope 的可信凭据层（F003 follow-up）。
//!
//! 威胁模型：渲染层（含被注入脚本）可经 plugin-sql 直接改写 app_config /
//! agent_project / agent_squad 的路径字段，因此「SQLite 里的路径」本身不可作为
//! 恢复 scope 的信任来源。本模块把裁决权从数据库移到签名上：
//!
//!  - 授权凭据 = HMAC-SHA256(scope_key || path)，密钥 32 字节随机值存 OS 凭据
//!    管理器（keyring → Windows Credential Manager），永不经 IPC 暴露给渲染层；
//!  - 仅 `record_fs_scope_grant` 命令能签发/更新凭据，签发受来源门禁约束：
//!    路径须在运行时 fs scope（原生 dialog 手选自动 allow）或 $HOME 静态可信根之下；
//!  - 启动恢复（`restore_fs_scope`）逐条验证签名 + 与 SQLite 来源字段二次比对 +
//!    目录存在性 / 非盘符根，任一不符即跳过该条。
//!
//! 因此被注入脚本即使改库也无法伪造凭据；能签发的路径不会超出其本次会话
//! 已有的可见范围——恢复机制不构成渲染层到任意目录的提权原语。

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::Row;
use std::collections::HashMap;
use std::path::{Component, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;
use tauri_plugin_sql::{DbInstances, DbPool};

type HmacSha256 = Hmac<Sha256>;

const KEYRING_SERVICE: &str = "WorkDuo";
const KEYRING_USER: &str = "fs-scope-grant-key";

/// app_config 中允许签发凭据的数据目录键（与 restore 的来源清单一致）。
const CONFIG_DIR_KEYS: [&str; 5] = [
    "workspace_path",
    "skill_path",
    "knowledge_base_path",
    "vector_path",
    "plugin_path",
];

/// scope_key 白名单：`config:<数据目录键>` / `project:<工程 id>` / `squad:<小分队 id>`。
fn valid_scope_key(key: &str) -> bool {
    if let Some(rest) = key.strip_prefix("config:") {
        return CONFIG_DIR_KEYS.contains(&rest);
    }
    for prefix in ["project:", "squad:"] {
        if let Some(id) = key.strip_prefix(prefix) {
            return !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        }
    }
    false
}

fn load_or_create_grant_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("凭证管理器不可用：{e}"))?;
    match entry.get_password() {
        Ok(hex_key) => {
            let key = hex::decode(hex_key.trim()).map_err(|e| format!("fs scope 密钥格式异常：{e}"))?;
            let mut out = [0u8; 32];
            if key.len() != 32 {
                return Err("fs scope 密钥长度异常（应为 32 字节）".into());
            }
            out.copy_from_slice(&key);
            Ok(out)
        }
        Err(keyring::Error::NoEntry) => {
            use rand::RngCore;
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| format!("fs scope 密钥写入凭据管理器失败：{e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("读取 fs scope 密钥失败：{e}")),
    }
}

/// HMAC-SHA256(scope_key \0 path)，hex 编码。
fn sign(scope_key: &str, path: &str, key: &[u8; 32]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(scope_key.as_bytes());
    mac.update(b"\0");
    mac.update(path.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn verify(scope_key: &str, path: &str, key: &[u8; 32], mac_hex: &str) -> bool {
    let expected = match hex::decode(mac_hex) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(scope_key.as_bytes());
    mac.update(b"\0");
    mac.update(path.as_bytes());
    mac.verify_slice(&expected).is_ok()
}

/// 规范化为可授权目录：必须绝对路径、无相对组件、真实存在且为目录、非盘符/网络根。
fn normalize_directory(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径为空".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(format!("非绝对路径：{trimmed}"));
    }
    for comp in p.components() {
        if matches!(comp, Component::CurDir | Component::ParentDir) {
            return Err(format!("路径含相对组件，已拒绝：{trimmed}"));
        }
    }
    let canon =
        std::fs::canonicalize(&p).map_err(|e| format!("路径不存在或无法解析：{trimmed}（{e}）"))?;
    if !canon.is_dir() {
        return Err(format!("路径不是目录：{trimmed}"));
    }
    // 盘符根（C:\）与 UNC 共享根的 parent() 为 None——整盘授权一律拒绝。
    if canon.parent().is_none() {
        return Err(format!("盘符/网络根目录不允许授权：{trimmed}"));
    }
    Ok(canon)
}

async fn workduo_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    match guard.get("sqlite:workduo.db") {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("sqlite:workduo.db 尚未就绪".into()),
    }
}

/// 签发/更新一条持久目录授权凭据（渲染层经 Tauri 命令调用）。
///
/// 来源门禁二选一：
///  - path 已处于运行时 fs scope（原生 dialog 手选后由 dialog 插件自动 allow）；
///  - path 位于 $HOME 之下（本应用静态 capability 的全部用户目录根：
///    $DOCUMENT/$DOWNLOAD/$APPDATA/$TEMP 等均在其下）——这些路径本就静态放行，
///    凭据对它们是惰性记录，不构成任何提权。
/// 其余任意路径（如 D:\ 下非 dialog 手选目录）一律拒绝——被注入脚本无法
/// 借此获得超出本次会话已有的访问范围。
#[tauri::command]
pub async fn record_fs_scope_grant(
    window: tauri::WebviewWindow,
    scope_key: String,
    path: String,
) -> Result<(), String> {
    if !valid_scope_key(&scope_key) {
        return Err(format!("非法的 scope_key：{scope_key}"));
    }
    let canon = normalize_directory(&path)?;
    let app = window.app_handle().clone();
    let runtime_allowed = window
        .try_fs_scope()
        .map(|s| s.is_allowed(&canon))
        .unwrap_or(false)
        || app.fs_scope().is_allowed(&canon);
    let under_home = app
        .path()
        .home_dir()
        .ok()
        .and_then(|home| std::fs::canonicalize(&home).ok())
        // canonicalize 统一为 verbatim 前缀，与 canon 的组件级比对才一致
        .map(|home| canon.starts_with(&home))
        .unwrap_or(false);
    if !runtime_allowed && !under_home {
        return Err("路径未经过原生目录选择授权，拒绝签发持久凭据".into());
    }
    let key = load_or_create_grant_key()?;
    let mac = sign(&scope_key, &canon.to_string_lossy(), &key);
    let pool = workduo_pool(&app).await?;
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO fs_scope_grant (scope_key, path, mac, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(scope_key) DO UPDATE SET \
           path = excluded.path, mac = excluded.mac, updated_at = excluded.updated_at",
    )
    .bind(&scope_key)
    .bind(canon.to_string_lossy().to_string())
    .bind(&mac)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .map_err(|e| format!("写入 fs_scope_grant 失败：{e}"))?;
    Ok(())
}

/// 从 SQLite 恢复已签名的持久目录 fs scope（启动期由前端引导调用）。
///
/// 逐条校验：scope_key 合法 + HMAC 与 keyring 密钥匹配 + path 与 SQLite 来源字段
/// （app_config 键值 / agent_project.root_path / agent_squad.workspace_dir）当前值一致
/// + 目录真实存在。数据库被篡改（伪造路径 / 伪造凭据）只会导致该条被跳过。
pub async fn restore_grants(app: &AppHandle) -> Result<usize, String> {
    let pool = workduo_pool(app).await?;

    // 来源字段：scope_key -> 期望目录（规范化后）。
    let mut expected: HashMap<String, PathBuf> = HashMap::new();

    let cfg_rows = sqlx::query(
        "SELECT key, value FROM app_config WHERE key IN \
         ('workspace_path', 'skill_path', 'knowledge_base_path', 'vector_path', 'plugin_path')",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取持久数据目录失败：{e}"))?;
    let appdata = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析 app_data_dir 失败：{e}"))?
        .to_string_lossy()
        .to_string();
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| format!("解析 resource_dir 失败：{e}"))?
        .to_string_lossy()
        .to_string();
    for row in cfg_rows {
        let Ok(key) = row.try_get::<String, _>("key") else {
            continue;
        };
        let Some(raw) = row.try_get::<Option<String>, _>("value").ok().flatten() else {
            continue;
        };
        let expanded = raw
            .trim()
            .replace("$APPDATA", &appdata)
            .replace("$RESOURCE", &resource);
        if let Ok(dir) = normalize_directory(&expanded) {
            expected.insert(format!("config:{key}"), dir);
        }
    }

    let project_rows = sqlx::query(
        "SELECT id, root_path FROM agent_project WHERE root_path IS NOT NULL AND TRIM(root_path) != ''",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取工程工作区失败：{e}"))?;
    for row in project_rows {
        let (Ok(id), Some(root)) = (
            row.try_get::<String, _>("id"),
            row.try_get::<Option<String>, _>("root_path").ok().flatten(),
        ) else {
            continue;
        };
        if let Ok(dir) = normalize_directory(&root) {
            expected.insert(format!("project:{id}"), dir);
        }
    }

    let squad_rows = sqlx::query(
        "SELECT id, workspace_dir FROM agent_squad WHERE workspace_dir IS NOT NULL AND TRIM(workspace_dir) != ''",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取小分队工作区失败：{e}"))?;
    for row in squad_rows {
        let (Ok(id), Some(dir_raw)) = (
            row.try_get::<String, _>("id"),
            row.try_get::<Option<String>, _>("workspace_dir").ok().flatten(),
        ) else {
            continue;
        };
        if let Ok(dir) = normalize_directory(&dir_raw) {
            expected.insert(format!("squad:{id}"), dir);
        }
    }

    let grant_rows = match sqlx::query("SELECT scope_key, path, mac FROM fs_scope_grant")
        .fetch_all(&pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            // 升级后首次启动且 InitContext 建表未跑完 → 本轮无凭据可恢复，下轮重试。
            tracing::warn!("restore_fs_scope: fs_scope_grant 尚不可读：{e}");
            return Ok(0);
        }
    };

    let key = load_or_create_grant_key()?;
    let scope = app.fs_scope();
    let mut granted = 0usize;
    for row in grant_rows {
        let scope_key: String = row.try_get("scope_key").unwrap_or_default();
        let path_raw: String = row.try_get("path").unwrap_or_default();
        let mac: String = row.try_get("mac").unwrap_or_default();
        if !valid_scope_key(&scope_key) {
            continue;
        }
        // 凭据必须命中当前来源字段；来源已删除 / 已改址 → 凭据自然失效。
        let Some(expected_dir) = expected.get(&scope_key) else {
            continue;
        };
        let path_str = expected_dir.to_string_lossy().to_string();
        if path_str != path_raw || !verify(&scope_key, &path_str, &key, &mac) {
            tracing::warn!("restore_fs_scope: 凭据校验失败，跳过 scope_key={}", scope_key);
            continue;
        }
        match scope.allow_directory(expected_dir, true) {
            Ok(()) => granted += 1,
            Err(e) => tracing::warn!(
                "restore_fs_scope: 开放目录 scope 失败 path={} err={}",
                expected_dir.display(),
                e
            ),
        }
    }
    tracing::info!("restore_fs_scope: 已恢复 {granted} 个持久目录的运行时 fs scope");
    Ok(granted)
}

/// 启动期恢复命令：前端 main 引导调用（fsScopeBootstrap）。
#[tauri::command]
pub async fn restore_fs_scope(app: AppHandle) -> Result<usize, String> {
    restore_grants(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("f003_scope_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scope_key_whitelist() {
        assert!(valid_scope_key("config:workspace_path"));
        assert!(valid_scope_key("config:plugin_path"));
        assert!(valid_scope_key("project:proj_ab12-_3"));
        assert!(valid_scope_key("squad:9f2c8b1a"));
        assert!(!valid_scope_key("config:arbitrary_key"));
        assert!(!valid_scope_key("project:"));
        assert!(!valid_scope_key("project:bad/id"));
        assert!(!valid_scope_key("anything:else"));
        assert!(!valid_scope_key(""));
    }

    #[test]
    fn hmac_roundtrip_and_tamper() {
        let key = [7u8; 32];
        let mac = sign("config:skill_path", r"\\?\D:\MySkills", &key);
        assert!(verify("config:skill_path", r"\\?\D:\MySkills", &key, &mac));
        // 换路径 / 换 scope_key / 篡改 mac 任一即失配
        assert!(!verify("config:skill_path", r"\\?\C:\Windows", &key, &mac));
        assert!(!verify("config:vector_path", r"\\?\D:\MySkills", &key, &mac));
        assert!(!verify("config:skill_path", r"\\?\D:\MySkills", &key, "00"));
        assert!(!verify("config:skill_path", r"\\?\D:\MySkills", &key, "zz"));
    }

    #[test]
    fn normalize_rejects_bad_paths() {
        assert!(normalize_directory("").is_err());
        assert!(normalize_directory("relative/dir").is_err());
        assert!(normalize_directory("D:\\definitely_not_exists_f003").is_err());
        let file = tmp_dir("file");
        let f = file.join("x.txt");
        std::fs::write(&f, "x").unwrap();
        // 文件不是目录
        assert!(normalize_directory(&f.to_string_lossy()).is_err());
        std::fs::remove_dir_all(&file).ok();
    }

    #[cfg(windows)]
    #[test]
    fn normalize_rejects_drive_root() {
        assert!(normalize_directory("C:\\").is_err());
    }

    #[test]
    fn normalize_accepts_existing_dir() {
        let dir = tmp_dir("ok");
        let canon = normalize_directory(&dir.to_string_lossy()).unwrap();
        assert!(canon.is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }
}
