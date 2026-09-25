//! 凭证加密保管（server_credential）。
//!
//! - 密文：AES-256-GCM，`base64(nonce || ciphertext)`；
//! - 主密钥：32 字节随机值，存 OS 凭据管理器（keyring → Windows Credential Manager），
//!   首次使用时生成并落库，之后读取复用；应用卸载/清除凭证时一并删除；
//! - 明文边界：仅在加密与解密瞬间存在于内存，任何返回值都不含明文。
//!
//! 明文负载结构（按 secret_type 解释，密文本身不透明）：
//!  - `password`                 → JSON `{ "password": "..." }`
//!  - `private_key`              → JSON `{ "pem": "..." }`
//!  - `private_key_passphrase`   → JSON `{ "pem": "...", "passphrase": "..." }`

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use md5::{Digest, Md5};

const KEYRING_SERVICE: &str = "WorkDuo";
const KEYRING_USER: &str = "host-master-key";

/// 凭证种类（与 server_host.auth_type 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    Password,
    PrivateKey,
    PrivateKeyPassphrase,
}

impl SecretKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::PrivateKey => "private_key",
            SecretKind::PrivateKeyPassphrase => "private_key_passphrase",
        }
    }

    pub fn parse(s: &str) -> SecretKind {
        match s {
            "private_key" => SecretKind::PrivateKey,
            "private_key_passphrase" => SecretKind::PrivateKeyPassphrase,
            _ => SecretKind::Password,
        }
    }
}

/// 解密后的凭证明文负载（即用即弃，禁止落日志 / 落库 / 回传）。
#[derive(Debug, Clone)]
pub enum SecretPayload {
    Password(String),
    Pem { pem: String, passphrase: Option<String> },
}

fn load_or_create_master_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("凭证管理器不可用：{e}"))?;
    match entry.get_password() {
        Ok(hex_key) => {
            let key = hex::decode(hex_key.trim()).map_err(|e| format!("主密钥格式异常：{e}"))?;
            let mut out = [0u8; 32];
            if key.len() != 32 {
                return Err("主密钥长度异常（应为 32 字节）".into());
            }
            out.copy_from_slice(&key);
            Ok(out)
        }
        Err(keyring::Error::NoEntry) => {
            // 首次：生成 32 字节随机主密钥并写入凭据管理器
            let key = Aes256Gcm::generate_key(&mut OsRng);
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| format!("主密钥写入凭据管理器失败：{e}"))?;
            Ok(key.into())
        }
        Err(e) => Err(format!("读取主密钥失败：{e}")),
    }
}

fn cipher() -> Result<Aes256Gcm, String> {
    let key = load_or_create_master_key()?;
    Aes256Gcm::new_from_slice(&key).map_err(|e| format!("加密器初始化失败：{e}"))
}

/// 加密明文负载（JSON 序列化后 AES-256-GCM），返回 base64(nonce || ciphertext)。
pub fn encrypt_payload(payload: &str) -> Result<String, String> {
    let cipher = cipher()?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 字节
    let ct = cipher
        .encrypt(&nonce, payload.as_bytes())
        .map_err(|e| format!("凭证加密失败：{e}"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

/// 解密密文，返回明文负载 JSON 字符串。
pub fn decrypt_payload(enc: &str) -> Result<String, String> {
    let cipher = cipher()?;
    let data = B64.decode(enc).map_err(|e| format!("凭证密文格式异常：{e}"))?;
    if data.len() < 13 {
        return Err("凭证密文长度异常".into());
    }
    let (nonce, ct) = data.split_at(12);
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|e| format!("凭证解密失败：{e}"))?;
    String::from_utf8(pt).map_err(|e| format!("凭证明文编码异常：{e}"))
}

/// 按种类把明文负载 JSON 解析为结构化凭证。
pub fn parse_payload(secret_type: &str, payload: &str) -> Result<SecretPayload, String> {
    let v: serde_json::Value = serde_json::from_str(payload).map_err(|e| format!("凭证负载解析失败：{e}"))?;
    match SecretKind::parse(secret_type) {
        SecretKind::Password => Ok(SecretPayload::Password(
            v.get("password").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        )),
        SecretKind::PrivateKey => Ok(SecretPayload::Pem {
            pem: v.get("pem").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            passphrase: None,
        }),
        SecretKind::PrivateKeyPassphrase => Ok(SecretPayload::Pem {
            pem: v.get("pem").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            passphrase: v.get("passphrase").and_then(|x| x.as_str()).map(|s| s.to_string()),
        }),
    }
}

/// 把表单输入序列化为明文负载 JSON（加密前调用）。
pub fn build_payload(secret_type: &str, secret: &str, key_passphrase: Option<&str>) -> Result<String, String> {
    let json = match SecretKind::parse(secret_type) {
        SecretKind::Password => serde_json::json!({ "password": secret }),
        SecretKind::PrivateKey => serde_json::json!({ "pem": secret }),
        SecretKind::PrivateKeyPassphrase => serde_json::json!({
            "pem": secret,
            "passphrase": key_passphrase.unwrap_or(""),
        }),
    };
    Ok(json.to_string())
}

/// 指纹展示：密码 `****` + 末 2 位；密钥 MD5 前 8 位。
pub fn secret_hint(secret_type: &str, secret: &str) -> String {
    match SecretKind::parse(secret_type) {
        SecretKind::Password => {
            let chars: Vec<char> = secret.chars().collect();
            if chars.len() >= 2 {
                format!("****{}", chars[chars.len() - 2..].iter().collect::<String>())
            } else {
                "****".to_string()
            }
        }
        SecretKind::PrivateKey | SecretKind::PrivateKeyPassphrase => {
            let mut h = Md5::new();
            h.update(secret.as_bytes());
            let digest = hex::encode(h.finalize());
            format!("密钥指纹 {}…", &digest[..8.min(digest.len())])
        }
    }
}

/// 凭证记录 id：`cred_` + MD5(种类 + 明文 + 毫秒时间戳) 前 16 位。
/// 同一毫秒内同内容同 id（幂等）；不同内容必不同。
pub fn new_credential_id(secret_type: &str, secret: &str) -> String {
    let mut h = Md5::new();
    h.update(secret_type.as_bytes());
    h.update(secret.as_bytes());
    h.update(crate::agent::engine::runtime::now_ms().to_string().as_bytes());
    format!("cred_{}", &hex::encode(h.finalize())[..16])
}
