//! 嵌入 / 重排提供者（设计稿 v2.0 §4，外接 LLM 模块，不捆绑本地模型）。
//!
//! - 配置来源：`models` 表 `category='embedding'` 启用项（无独立默认标记时取首个启用）；
//!   `category='rerank'` 同理。`config` JSON 为前端 `EmbeddingModelParams`（camelCase）。
//! - 协议：OpenAI `/embeddings`（`{model, input:[..]}` → `data[i].embedding`）与
//!   TEI `/embed`（`{inputs:[..]}` → `[[f32]]`）双协议，按 base_url 形态自动判定；
//! - 失败语义：任何嵌入失败 = 降级信号（上层走关键词重排），**不抛断任务**；
//! - 统计：调用次数 / 文本条数 best-effort 记 `app_config`（`embedding_call_count` /
//!   `embedding_text_count`），设置页展示（M1 #20260918004 消费）。

use std::time::Duration;

use serde::Serialize;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tauri::AppHandle;

use crate::net;

/// 嵌入协议（按 base_url 形态判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingProtocol {
    /// OpenAI 兼容 `POST {base}/embeddings`
    OpenAi,
    /// HuggingFace TEI 原生 `POST {base}/embed`
    Tei,
}

/// 默认嵌入模型配置（来自 `models` 表一行 + config 参数）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    pub id: String,
    pub name: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub protocol: EmbeddingProtocol,
    /// 期望维度（config.dimensions，可空；真实维度以首次返回为准）
    pub dims_hint: Option<usize>,
    /// 是否 L2 归一化（config.normalize）
    pub normalize: bool,
}

/// 嵌入探测结果（设置页「测试连通」）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProbe {
    pub model_name: String,
    pub base_url: String,
    pub dims: usize,
    pub sample_ms: u64,
}

/// 判定嵌入协议：`/embed` 结尾（且非 `/embeddings`）→ TEI；其余默认 OpenAI
/// （裸 `/v1` 时调用处自动补 `/embeddings`）。
pub fn detect_protocol(base_url: &str) -> EmbeddingProtocol {
    let lower = base_url.trim_end_matches('/').to_lowercase();
    if lower.ends_with("/embed") {
        EmbeddingProtocol::Tei
    } else {
        EmbeddingProtocol::OpenAi
    }
}

/// 规范化请求 URL：OpenAI 协议确保以 `/embeddings` 结尾；TEI 确保以 `/embed` 结尾。
pub fn normalize_endpoint(base_url: &str, protocol: EmbeddingProtocol) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let lower = trimmed.to_lowercase();
    let suffix = match protocol {
        EmbeddingProtocol::OpenAi => "/embeddings",
        EmbeddingProtocol::Tei => "/embed",
    };
    if lower.ends_with(suffix) {
        trimmed.to_string()
    } else {
        format!("{trimmed}{suffix}")
    }
}

/// 从 `models` 表读取默认嵌入模型：`category='embedding' AND enabled=1`，
/// 无独立默认标记时取最早创建的启用项（前端可自行排序管理）。
pub async fn load_default_embedding(pool: &SqlitePool) -> Result<Option<EmbeddingConfig>, String> {
    let rows = sqlx::query(
        "SELECT id, name, model_name, base_url, api_key, config FROM models \
         WHERE category = 'embedding' AND enabled = 1 ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取嵌入模型配置失败：{e}"))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let base_url: String = row.try_get::<Option<String>, _>("base_url").ok().flatten().unwrap_or_default();
    if base_url.trim().is_empty() {
        return Ok(None);
    }
    let config_raw: String = row.try_get("config").unwrap_or_else(|_| "{}".into());
    let cfg_json: serde_json::Value = serde_json::from_str(&config_raw).unwrap_or(serde_json::json!({}));
    let dims_hint = cfg_json
        .get("dimensions")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    let normalize = cfg_json.get("normalize").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(Some(EmbeddingConfig {
        id: row.try_get("id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        model_name: row.try_get("model_name").unwrap_or_default(),
        api_key: row.try_get::<Option<String>, _>("api_key").ok().flatten(),
        protocol: detect_protocol(&base_url),
        base_url,
        dims_hint,
        normalize,
    }))
}

/// L2 归一化（config.normalize=true 时调用）。
fn normalize_vec(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// 统计埋点（best-effort）：调用次数 +1、文本条数 +n，供设置页展示成本。
/// 嵌入与重排共用（键区分：embedding_* / rerank_*）。
async fn bump_stats(pool: &SqlitePool, call_key: &str, text_key: &str, texts: usize) {
    let _ = sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?, '1') \
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
    )
    .bind(call_key)
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)",
    )
    .bind(text_key)
    .bind(texts.to_string())
    .bind(texts.to_string())
    .execute(pool)
    .await;
}

/// 批量嵌入：按 cfg.protocol 调用远端，返回与 `texts` 等长的向量数组。
/// 失败时返回 Err（上层降级关键词模式），绝不 panic / 阻塞主路径。
pub async fn embed_texts(
    app: &AppHandle,
    pool: &SqlitePool,
    cfg: &EmbeddingConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = net::platform_client(app).await;
    let url = normalize_endpoint(&cfg.base_url, cfg.protocol);
    let mut req = client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .header("Content-Type", "application/json");
    if let Some(key) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }

    let body = match cfg.protocol {
        EmbeddingProtocol::OpenAi => serde_json::json!({
            "model": cfg.model_name,
            "input": texts,
            "encoding_format": "float",
        }),
        EmbeddingProtocol::Tei => serde_json::json!({ "inputs": texts }),
    };
    req = req.body(serde_json::to_string(&body).map_err(|e| e.to_string())?);

    let started = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| format!("嵌入请求失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "嵌入接口返回 {status}（{}ms）：{}",
            started.elapsed().as_millis(),
            text.chars().take(300).collect::<String>()
        ));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("嵌入响应非 JSON：{e}"))?;

    // OpenAI: { data: [ { embedding: [f32], index: n } ] }（按 index 排序保险）
    let mut vectors: Vec<Vec<f32>> = match cfg.protocol {
        EmbeddingProtocol::OpenAi => {
            let mut data: Vec<(usize, Vec<f32>)> = json
                .get("data")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            let index = item.get("index").and_then(|v| v.as_u64())? as usize;
                            let embedding = item
                                .get("embedding")
                                .and_then(|v| v.as_array())
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_f64().map(|f| f as f32))
                                        .collect::<Vec<f32>>()
                                })?;
                            Some((index, embedding))
                        })
                        .collect()
                })
                .unwrap_or_default();
            data.sort_by_key(|(i, _)| *i);
            data.into_iter().map(|(_, v)| v).collect()
        }
        EmbeddingProtocol::Tei => json
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|v| {
                        v.as_array()
                            .map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default(),
    };

    if vectors.len() != texts.len() {
        return Err(format!(
            "嵌入返回条数不匹配：期望 {}，实际 {}",
            texts.len(),
            vectors.len()
        ));
    }
    if cfg.normalize {
        for v in vectors.iter_mut() {
            normalize_vec(v);
        }
    }
    bump_stats(pool, "embedding_call_count", "embedding_text_count", texts.len()).await;
    Ok(vectors)
}

/// 探测嵌入连通性（设置页「测试」/ Step1 验收）：嵌入一条样例，返回维度与耗时。
pub async fn probe_embedding_inner(
    app: &AppHandle,
    pool: &SqlitePool,
) -> Result<EmbeddingProbe, String> {
    let cfg = load_default_embedding(pool)
        .await?
        .ok_or_else(|| "未配置嵌入模型（LLM 模块 → 向量 分类）".to_string())?;
    let started = std::time::Instant::now();
    let vectors = embed_texts(app, pool, &cfg, &["workduo-probe".to_string()]).await?;
    let dims = vectors.first().map(|v| v.len()).unwrap_or(0);
    Ok(EmbeddingProbe {
        model_name: cfg.model_name.clone(),
        base_url: normalize_endpoint(&cfg.base_url, cfg.protocol),
        dims,
        sample_ms: started.elapsed().as_millis() as u64,
    })
}

/// Tauri 命令：探测嵌入连通性（设置页「测试连通」按钮 / Step1 验收）。
#[tauri::command]
pub async fn probe_embedding(app: AppHandle) -> Result<EmbeddingProbe, String> {
    let pool = crate::agent::engine::round_compactor::get_pool(&app).await?;
    probe_embedding_inner(&app, &pool).await
}

/* ------------------------------------------------------------------ *
 * Rerank（TEI /rerank）——M2 #20260918005 消费，此处提供骨架
 * ------------------------------------------------------------------ */

/// 重排配置（models 表 `category='rerank'`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankConfig {
    pub id: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: Option<String>,
}

pub async fn load_default_rerank(pool: &SqlitePool) -> Result<Option<RerankConfig>, String> {
    let rows = sqlx::query(
        "SELECT id, model_name, base_url, api_key FROM models \
         WHERE category = 'rerank' AND enabled = 1 ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取重排模型配置失败：{e}"))?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let base_url: String = row.try_get::<Option<String>, _>("base_url").ok().flatten().unwrap_or_default();
    Ok(Some(RerankConfig {
        id: row.try_get("id").unwrap_or_default(),
        model_name: row.try_get("model_name").unwrap_or_default(),
        api_key: row.try_get::<Option<String>, _>("api_key").ok().flatten(),
        base_url,
    }))
}

/// TEI `/rerank` 精排：返回 (原文下标, 分数) 按 score 降序。
pub async fn rerank(
    app: &AppHandle,
    pool: &SqlitePool,
    cfg: &RerankConfig,
    query: &str,
    docs: &[String],
    top_n: usize,
) -> Result<Vec<(usize, f32)>, String> {
    if docs.is_empty() {
        return Ok(Vec::new());
    }
    let client = net::platform_client(app).await;
    let mut url = cfg.base_url.trim_end_matches('/').to_string();
    if !url.to_lowercase().ends_with("/rerank") {
        url.push_str("/rerank");
    }
    let mut req = client
        .post(&url)
        .timeout(Duration::from_secs(30))
        .header("Content-Type", "application/json");
    if let Some(key) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let body = serde_json::json!({ "query": query, "texts": docs });
    req = req.body(serde_json::to_string(&body).map_err(|e| e.to_string())?);
    let resp = req.send().await.map_err(|e| format!("重排请求失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("重排接口返回 {status}：{}", text.chars().take(200).collect::<String>()));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("重排响应非 JSON：{e}"))?;
    let mut pairs: Vec<(usize, f32)> = json
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let index = item.get("index").and_then(|v| v.as_u64())? as usize;
                    let score = item.get("score").and_then(|v| v.as_f64())? as f32;
                    Some((index, score))
                })
                .collect()
        })
        .unwrap_or_default();
    pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    pairs.truncate(top_n);
    // 成功埋点（best-effort）：调用次数 +1、参与精排的文本条数
    bump_stats(pool, "rerank_call_count", "rerank_text_count", docs.len()).await;
    Ok(pairs)
}

/* ---------------- 单测：协议判定 / 端点归一 / 响应解析 ---------------- */
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_detection() {
        assert_eq!(detect_protocol("http://x/v1/embeddings"), EmbeddingProtocol::OpenAi);
        assert_eq!(detect_protocol("http://x/embed"), EmbeddingProtocol::Tei);
        assert_eq!(detect_protocol("http://x/v1"), EmbeddingProtocol::OpenAi);
        assert_eq!(detect_protocol("http://x/"), EmbeddingProtocol::OpenAi);
    }

    #[test]
    fn endpoint_normalization() {
        assert_eq!(
            normalize_endpoint("http://x/v1", EmbeddingProtocol::OpenAi),
            "http://x/v1/embeddings"
        );
        assert_eq!(
            normalize_endpoint("http://x/v1/embeddings/", EmbeddingProtocol::OpenAi),
            "http://x/v1/embeddings"
        );
        assert_eq!(
            normalize_endpoint("http://tei", EmbeddingProtocol::Tei),
            "http://tei/embed"
        );
        assert_eq!(
            normalize_endpoint("http://tei/embed", EmbeddingProtocol::Tei),
            "http://tei/embed"
        );
    }

    #[test]
    fn openai_response_parse_sorted_by_index() {
        let json = serde_json::json!({
            "data": [
                { "index": 1, "embedding": [0.4, 0.5] },
                { "index": 0, "embedding": [0.1, 0.2] }
            ]
        });
        let mut data: Vec<(usize, Vec<f32>)> = json["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["index"].as_u64().unwrap() as usize,
                    item["embedding"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_f64().unwrap() as f32)
                        .collect(),
                )
            })
            .collect();
        data.sort_by_key(|(i, _)| *i);
        let out: Vec<Vec<f32>> = data.into_iter().map(|(_, v)| v).collect();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0][0], 0.1);
        assert_eq!(out[1][0], 0.4);
    }

    #[test]
    fn tei_response_parse() {
        let json = serde_json::json!([[0.1, 0.2], [0.3, 0.4]]);
        let out: Vec<Vec<f32>> = json
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect())
            .collect();
        assert_eq!(out.len(), 2);
        assert_eq!(out[1][1], 0.4);
    }

    #[test]
    fn l2_normalize() {
        let mut v = vec![3.0f32, 4.0f32];
        normalize_vec(&mut v);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }
}
