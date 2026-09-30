//! 图片生成原生工具（image 模型大类的能力层出口）。
//!
//! `native__generate_image`：prompt → 已启用的 image 大类模型（OpenAI Images 兼容，
//! POST 用户填写的完整端点 URL）→ b64_json 解码 / url 下载 → PathGuard 落盘到工作空间。
//!
//! 设计要点：
//! - 模型选择 = 全局最新启用的 `category='image'` 模型（第一批不做智能体级绑定，
//!   后续如需按智能体换装再加列）；未配置时工具**不注册**（提示与能力同源红线，
//!   防止 planner 大纲列出必然失败的能力）。
//! - 产物落盘走 PathGuard（与 write_file 同构的沙箱边界），文件名缺省按时间戳生成。
//! - 审批：RequireApproval（按张计费成本高 + 写文件，与 execute 同档）。
//! - 工具族：归 write 族（types.rs tool_family_members）——禁写角色（CRITIC 等）天然禁用。
//!
//! 超时 180s（图像生成典型 5~30s，留足网关排队余量）；响应只接受 data[0]
//! （一次一张，n 由模型配置固定为 1，避免批量刷成本）。

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::Manager;

use super::def;
use crate::agent::engine::tools::{AgentTool, PathGuard, PermissionLevel, ToolBehavior, ToolContext, ToolError};

/// 查询是否已配置启用的图片生成模型（注册条件 + 工具内报错文案共用）。
pub async fn image_model_available(app: &AppHandle) -> bool {
    load_image_model(app).await.is_ok()
}

/// 加载最新启用的 image 大类模型（base_url / api_key / model_name / 默认 size）。
async fn load_image_model(
    app: &AppHandle,
) -> Result<(String, String, String, Option<String>), String> {
    let instances = app.state::<tauri_plugin_sql::DbInstances>();
    let guard = instances.0.read().await;
    let pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?;
    let pool = match pool {
        tauri_plugin_sql::DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);

    let row = sqlx::query(
        "SELECT base_url, api_key, model_name, config FROM models \
         WHERE category = 'image' AND enabled = 1 ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("查询图片生成模型失败：{e}"))?
    .ok_or_else(|| {
        "未配置图片生成模型：请到「模型设置」新增分类为「图片生成」的模型并启用（OpenAI Images 兼容端点）".to_string()
    })?;

    use sqlx::Row;
    let base_url: String = row
        .try_get::<Option<String>, _>("base_url")
        .ok()
        .flatten()
        .unwrap_or_default();
    let api_key: String = row
        .try_get::<Option<String>, _>("api_key")
        .ok()
        .flatten()
        .unwrap_or_default();
    let model_name: String = row
        .try_get::<Option<String>, _>("model_name")
        .ok()
        .flatten()
        .unwrap_or_default();
    let config_raw: String = row
        .try_get::<Option<String>, _>("config")
        .ok()
        .flatten()
        .unwrap_or_default();
    let size = serde_json::from_str::<Value>(&config_raw)
        .ok()
        .and_then(|c| c.get("image").cloned())
        .and_then(|i| i.get("size").cloned())
        .and_then(|s| s.as_str().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty());

    if base_url.trim().is_empty() || model_name.trim().is_empty() {
        return Err("图片生成模型配置不完整：接口地址（完整 URL）与模型标识均为必填".into());
    }
    Ok((base_url, api_key, model_name, size))
}

/// 从 Images API 响应取 data[0] 与 revised_prompt。
fn first_data_item(resp: &Value) -> Result<(&Value, Option<String>), String> {
    let item = resp
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "响应缺少 data 数组（非 OpenAI Images 兼容格式？）".to_string())?;
    let revised = item
        .get("revised_prompt")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string());
    Ok((item, revised))
}

/// b64_json 解码（纯函数，单测覆盖）。
fn decode_b64(b64: &str) -> Result<Vec<u8>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("b64_json 解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("b64_json 解码结果为空".into());
    }
    Ok(bytes)
}

/// 提取图片字节：优先 b64_json 解码；url 形态异步下载（25MB 上限防滥用）。
async fn fetch_image_bytes(
    resp: &Value,
    client: &reqwest::Client,
) -> Result<(Vec<u8>, Option<String>), String> {
    let (item, revised) = first_data_item(resp)?;
    if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
        return Ok((decode_b64(b64)?, revised));
    }
    if let Some(url) = item.get("url").and_then(|u| u.as_str()) {
        let r = client
            .get(url)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("图片下载失败：{e}"))?
            .error_for_status()
            .map_err(|e| format!("图片下载失败：{e}"))?;
        let bytes = r
            .bytes()
            .await
            .map_err(|e| format!("读取图片失败：{e}"))?
            .to_vec();
        if bytes.len() > 25 * 1024 * 1024 {
            return Err("图片超过 25MB 上限，拒绝保存".into());
        }
        if bytes.is_empty() {
            return Err("图片下载结果为空".into());
        }
        return Ok((bytes, revised));
    }
    Err("响应既无 b64_json 也无 url（不支持的返回格式）".into())
}

pub struct GenerateImageTool {
    pub app: AppHandle,
}

#[async_trait::async_trait]
impl AgentTool for GenerateImageTool {
    fn name(&self) -> String {
        "native__generate_image".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("write"),
            file_mutating: true,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__generate_image",
            "调用图片生成模型（OpenAI Images 兼容端点）按文字描述生成一张图片，并保存到工作空间。\
             需用户审批。file_name 缺省自动命名（image-{时间戳}.png）；size 缺省取模型配置（1024x1024）。\
             返回保存路径与字节数（及模型改写后的提示词，如有）。未配置图片生成模型时本工具不可用。",
            json!({
                "prompt": { "type": "string", "description": "图片描述（建议具体：主体/风格/构图/光线）" },
                "file_name": { "type": "string", "description": "可选，保存文件名（工作空间内相对路径，建议 .png）" },
                "size": { "type": "string", "description": "可选，图片尺寸，如 1024x1024 / 1536x1024 / 1024x1536（以服务商支持为准）" }
            }),
            &["prompt"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let prompt = args
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ToolError::InvalidArgs("generate_image 缺少 prompt 参数".into()))?;
        let size = args
            .get("size")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let file_name = args
            .get("file_name")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("image-{}.png", now_ts()));

        let (base_url, api_key, model_name, cfg_size) = load_image_model(&self.app)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let size = size.or(cfg_size).unwrap_or_else(|| "1024x1024".to_string());

        let body = json!({ "model": model_name, "prompt": prompt, "n": 1, "size": size });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|e| ToolError::ExecutionFailed(format!("HTTP 客户端构建失败：{e}")))?;
        let resp = client
            .post(base_url.trim())
            .bearer_auth(api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("图片生成请求失败：{e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("读取响应失败：{e}")))?;
        if !status.is_success() {
            return Err(ToolError::ExecutionFailed(format!(
                "图片生成端点返回 {status}：{}",
                crate::agent::engine::runtime::clip(&text, 400)
            )));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| ToolError::ExecutionFailed(format!("响应非 JSON：{e}（{}）", crate::agent::engine::runtime::clip(&text, 200))))?;

        let (bytes, revised) = fetch_image_bytes(&v, &client)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        // 落盘（与 write_file 同构：PathGuard 沙箱边界 + TOCTOU 校验）。
        let abs = PathGuard::check(&file_name, ctx)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
        }
        {
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建文件失败：{e}")))?;
            PathGuard::verify_opened(&abs, &f, ctx)?;
            f.set_len(0)
                .map_err(|e| ToolError::ExecutionFailed(format!("清空文件失败：{e}")))?;
            f.write_all(&bytes)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入图片失败：{e}")))?;
        }

        tracing::info!(
            "[agent] native__generate_image: saved={} bytes={} model={model_name} size={size}",
            abs.display(),
            bytes.len()
        );
        let revised_note = revised
            .map(|r| format!("\n模型改写后的提示词：{}", crate::agent::engine::runtime::clip(&r, 300)))
            .unwrap_or_default();
        Ok(format!(
            "图片已生成并保存：{}（{} 字节，模型 {}，尺寸 {size}）{revised_note}",
            abs.display(),
            bytes.len(),
            model_name
        ))
    }
}

fn now_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// image 大类：write 族必须包含 generate_image（禁写角色一并禁用）。
    #[test]
    fn generate_image_in_write_family() {
        assert!(crate::agent::types::tool_family_members("write")
            .contains(&"native__generate_image"));
    }

    /// b64_json 解码：正常 / 非法 base64 / 空结果。
    #[test]
    fn decode_b64_tolerant() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"PNGDATA");
        assert_eq!(decode_b64(&b64).unwrap(), b"PNGDATA");
        assert!(decode_b64("!!!不是base64!!!").is_err());
        let empty = base64::engine::general_purpose::STANDARD.encode(b"");
        assert!(decode_b64(&empty).is_err());
    }

    /// data[0] 提取：b64 优先、url 回退、revised_prompt 透传、缺 data 报错。
    #[test]
    fn first_data_item_and_fetch() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"IMG");
        let v = json!({"data": [{"b64_json": b64, "revised_prompt": "a red circle, digital art"}]});
        let (item, revised) = first_data_item(&v).unwrap();
        assert_eq!(decode_b64(item.get("b64_json").unwrap().as_str().unwrap()).unwrap(), b"IMG");
        assert_eq!(revised.as_deref(), Some("a red circle, digital art"));
        let v2 = json!({"data": [{"url": "https://example.com/x.png"}]});
        assert!(first_data_item(&v2).unwrap().0.get("url").is_some());
        assert!(first_data_item(&json!({"error": "no data"})).is_err());
    }
}
