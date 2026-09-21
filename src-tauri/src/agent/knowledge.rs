//! 知识库 RAG 索引（第四期 K1'，设计稿 `docs/knowledge-rag-design.md`）。
//!
//! - **表**：LanceDB `kb_chunks` v2 通用 chunk 表（asset_id / meta_data / type / path /
//!   breadcrumbs / page_idx / bbox 占位 / digest / embedding）；SQLite `knowledge_asset`
//!   只存业务元数据（digest / indexed_at / meta_data 标签）；
//! - **解析器接缝**：`FileTextExtractor` trait，v1 唯一实现 `Utf8TextExtractor`
//!   （.md/.markdown/.txt 白名单直读）；将来接入 MinerU 等解析器只需新增 trait 实现，
//!   chunk 表与检索链路零改动；
//! - **切块**：md 标题层级分节（path/breadcrumbs）→ 节内表格/代码块整块保留、
//!   文本滑窗（~800 字符 / 10% 重叠）；txt 纯滑窗；单资产 chunk 数上限保护；
//! - **增量**：文件 digest（DefaultHasher）+ origin_file_path 双判定——未变跳过、
//!   改名/移动重写元数据、内容变化重切重嵌；
//! - **维度**：表级 `app_config.kb_embed_dim`；嵌入未配置时 chunks 以 null 向量入库
//!   （表已存在时）或仅记 SQLite 状态（表尚无法建——维度未知）；换模型维度变化 →
//!   drop 表按新维重建；
//! - **失败语义**：LanceDB / 嵌入任何失败 = Err 上抛（命令层记日志），绝不阻塞
//!   KB 文件管理主流程（前端钩子 fire-and-forget）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use sqlx::Row;
use sqlx::SqlitePool;

use super::artifact_index::content_digest;
use super::embedding;
use super::events;
use super::round_compactor::get_pool;
use super::vector_store::{self, KbChunkVectorRow};

/* ---------------- 常量 ---------------- */

/// kb_chunks schema 版本标记（app_config）：M1 旧表零消费，首次触碰时 drop 重建。
const KB_CHUNKS_SCHEMA_KEY: &str = "kb_chunks_schema";
const KB_CHUNKS_SCHEMA_VERSION: &str = "v2";
/// 嵌入维度表级记录键。
const KB_EMBED_DIM_KEY: &str = "kb_embed_dim";
/// 知识库存储根路径配置键（与前端 settings-file.ts 同键）。
const KB_ROOT_KEY: &str = "knowledge_base_path";

/// 滑窗目标大小（字符）与重叠（设计稿拍板值 ~800 字符 / 10%）。
const CHUNK_WINDOW: usize = 800;
const CHUNK_OVERLAP: usize = 80;
/// 单资产 chunk 数上限（超长文件截断保护）。
const MAX_CHUNKS_PER_ASSET: usize = 2000;
/// v1 支持的纯文本扩展名白名单（小写、不含点）。
const TEXT_EXTS: &[&str] = &["md", "markdown", "txt"];
/// 单批嵌入条数（平移 backfill 批量）。
const EMBED_BATCH: usize = 16;

/* ---------------- 提取器接缝 ---------------- */

/// 提取产物：统一后的纯文本（供切块）。
pub(crate) struct ExtractedText {
    pub text: String,
}

/// 文件文本提取器接缝（设计稿 §3.1）：v1 唯一实现为 UTF-8 直读；
/// 将来接入 MinerU / PDF 解析器时实现同 trait，chunk 表与检索链路零改动。
pub(crate) trait FileTextExtractor: Send + Sync {
    fn supports(&self, ext: &str) -> bool;
    /// 字节 → 纯文本。失败 = Err（调用方记日志跳过该资产）。
    fn extract(&self, bytes: &[u8]) -> Result<ExtractedText, String>;
}

/// UTF-8 文本直读（md / txt 白名单）。
struct Utf8TextExtractor;

const UTF8_EXTRACTOR: Utf8TextExtractor = Utf8TextExtractor;

impl FileTextExtractor for Utf8TextExtractor {
    fn supports(&self, ext: &str) -> bool {
        TEXT_EXTS.contains(&ext.to_lowercase().as_str())
    }
    fn extract(&self, bytes: &[u8]) -> Result<ExtractedText, String> {
        // lossy：非法 UTF-8 字节替换为 U+FFFD 而非整体失败（用户文件容错）
        Ok(ExtractedText {
            text: String::from_utf8_lossy(bytes).to_string(),
        })
    }
}

/// 按扩展名选提取器；不支持 = None。
fn extractor_for(ext: &str) -> Option<&'static dyn FileTextExtractor> {
    if UTF8_EXTRACTOR.supports(ext) {
        Some(&UTF8_EXTRACTOR)
    } else {
        None
    }
}

/* ---------------- 切块（纯函数，可单测） ---------------- */

/// 一个待入库的 chunk 元数据（无向量；向量在 sync 时批量嵌入后组装）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct KbChunkMeta {
    pub chunk_index: usize,
    /// text / table / code
    pub chunk_type: &'static str,
    /// 标题前缀 + 原文切片（溯源与嵌入文本）
    pub raw_text: String,
    /// 清洗后纯文本（检索主体）
    pub content: String,
    /// 层级路径（"第十一章/三、…"；无层级 = 空串）
    pub path: String,
    /// 面包屑（"第十一章 > 三、…"；无层级 = None）
    pub breadcrumbs: Option<String>,
}

/// 字符滑窗：window 大小、overlap 重叠（chars() 切分，中文多字节安全）。
fn sliding_windows(text: &str, window: usize, overlap: usize) -> Vec<String> {
    debug_assert!(overlap < window, "overlap 必须小于 window，否则死循环");
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= window {
        return vec![text.to_string()];
    }
    let step = window - overlap;
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + window).min(chars.len());
        out.push(chars[start..end].iter().collect::<String>());
        if end == chars.len() {
            break;
        }
        start += step;
    }
    out
}

/// 行分组：超长表格/代码块按行分组（每组 ≤ max_chars，至少一行；不重叠——
/// 表格/代码按行重切语义完整，文本才用字符滑窗）。
fn line_groups(lines: &[&str], max_chars: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut cur_len = 0usize;
    for line in lines {
        let l = line.chars().count();
        if !cur.is_empty() && cur_len + l + 1 > max_chars {
            out.push(cur.join("\n"));
            cur.clear();
            cur_len = 0;
        }
        cur.push(line);
        cur_len += l + 1;
    }
    if !cur.is_empty() {
        out.push(cur.join("\n"));
    }
    out
}

/// md 标题层级链分节（区别于 artifact_index 的扁平版：K 系列需要 path/breadcrumbs）：
/// - `#`（1-3 级，前导空格 ≤3）开启新节，维护 (level, title) 链；
/// - 节体含标题行本身（切片自含上下文语义）；
/// - 首个标题前的前言 = 无层级节（path=""，breadcrumbs=None）；
/// - 全文无标题 = 单节。
struct MdSection {
    path: String,
    breadcrumbs: Option<String>,
    body: String,
}

fn is_heading_line(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    if leading > 3 {
        return None;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=3).contains(&hashes) {
        return None;
    }
    // # 之后必须紧跟空白或行尾（排除 #hashtag / #... 代码式误判）
    let next_ok = trimmed[hashes..]
        .chars()
        .next()
        .map(|c| c.is_whitespace())
        .unwrap_or(true);
    if !next_ok {
        return None;
    }
    Some(hashes)
}

fn heading_text(line: &str) -> String {
    let trimmed = line.trim_start();
    let stripped = trimmed.trim_start_matches('#');
    stripped.trim().to_string()
}

fn split_md_leveled(content: &str) -> Vec<MdSection> {
    let mut sections: Vec<MdSection> = Vec::new();
    let mut chain: Vec<(usize, String)> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();

    let flush = |sections: &mut Vec<MdSection>,
                 chain: &[(usize, String)],
                 buf: &mut Vec<&str>| {
        let body = buf.join("\n");
        buf.clear();
        if body.trim().chars().count() < 2 {
            return;
        }
        // 「仅标题行无正文」= 空节：heading 单独进检索文本无增益（对齐 artifact_index 约定）。
        // chain 非空时该节由标题行开启，buf 首行即标题行。
        if !chain.is_empty() && body.lines().skip(1).all(|l| l.trim().is_empty()) {
            return;
        }
        let (path, breadcrumbs) = if chain.is_empty() {
            (String::new(), None)
        } else {
            (
                chain.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join("/"),
                Some(chain.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" > ")),
            )
        };
        sections.push(MdSection { path, breadcrumbs, body });
    };

    for line in content.lines() {
        if let Some(level) = is_heading_line(line) {
            flush(&mut sections, &chain, &mut cur);
            // 弹出同级及更深标题，保持层级链单调
            chain.truncate(chain.iter().take_while(|(l, _)| *l < level).count());
            chain.push((level, heading_text(line)));
        }
        cur.push(line);
    }
    flush(&mut sections, &chain, &mut cur);
    sections
}

/// 节体 → 语义块序列：表格（连续 | 行 ≥2）/ 代码围栏整块，其余合并为 text。
fn split_blocks(body: &str) -> Vec<(&'static str, String)> {
    let mut blocks: Vec<(&'static str, String)> = Vec::new();
    let mut text_buf: Vec<&str> = Vec::new();
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0usize;

    let flush_text = |blocks: &mut Vec<(&'static str, String)>, buf: &mut Vec<&str>| {
        if !buf.is_empty() {
            let t = buf.join("\n");
            buf.clear();
            if t.trim().chars().count() >= 2 {
                blocks.push(("text", t));
            }
        }
    };

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        // 代码围栏：``` 开（允许缩进/语言后缀），到配对 ``` 或文末
        if trimmed.starts_with("```") {
            flush_text(&mut blocks, &mut text_buf);
            let mut fence: Vec<&str> = vec![line];
            i += 1;
            while i < lines.len() {
                fence.push(lines[i]);
                if lines[i].trim_start().starts_with("```") && fence.len() > 1 {
                    i += 1;
                    break;
                }
                i += 1;
            }
            blocks.push(("code", fence.join("\n")));
            continue;
        }
        // 表格：连续 | 开头行 ≥2
        if trimmed.starts_with('|') {
            let start = i;
            while i < lines.len() && lines[i].trim_start().starts_with('|') {
                i += 1;
            }
            if i - start >= 2 {
                flush_text(&mut blocks, &mut text_buf);
                blocks.push(("table", lines[start..i].join("\n")));
            } else {
                text_buf.push(line);
                i += 1;
            }
            continue;
        }
        text_buf.push(line);
        i += 1;
    }
    flush_text(&mut blocks, &mut text_buf);
    blocks
}

/// 节体切块：**语义块即 chunk**（表格/代码/文本段各自独立，类型不合并——
/// 检索粒度即语义粒度）；超长 text 块字符滑窗、超长 table/code 块按行分组。
fn chunk_section(
    section_path: &str,
    breadcrumbs: Option<&str>,
    body: &str,
    next_index: &mut usize,
    out: &mut Vec<KbChunkMeta>,
) {
    for (btype, btext) in split_blocks(body) {
        let blen = btext.chars().count();
        if blen > CHUNK_WINDOW {
            match btype {
                "text" => {
                    for w in sliding_windows(&btext, CHUNK_WINDOW, CHUNK_OVERLAP) {
                        push_chunk(out, next_index, section_path, breadcrumbs, "text", &w);
                    }
                }
                _ => {
                    let lines: Vec<&str> = btext.lines().collect();
                    for g in line_groups(&lines, CHUNK_WINDOW) {
                        push_chunk(out, next_index, section_path, breadcrumbs, btype, &g);
                    }
                }
            }
            continue;
        }
        push_chunk(out, next_index, section_path, breadcrumbs, btype, &btext);
    }
}

/// 噪声 chunk 判定（纯函数，可单测）。规则：
/// ① 各类型通用：剔除字母/数字后不含实质字符（分隔线/纯符号行）——CJK 属 Unicode
///    Letter，`is_alphanumeric()` 已覆盖（K3-1 真机实证 `---` 独立成块占 top_k · #3）。
/// ② 仅 text：剔除 markdown 标题行后有效字数 < 6。轮 6 复测实证：「内部：」（2 字碎片
///    score 0.48 排 top1）与「### 2.3 调色板」类纯标题块占 top_k 名额、嵌入不可靠，
///    且标题信息已在 breadcrumbs/path 中；heading 黏进首块时由正文行兜底。
///    table/code 不受 ② 约束——2 行小表、单行脚本有结构价值。
const MIN_EFFECTIVE_CHUNK_CHARS: usize = 6;

fn is_noise_chunk(content: &str, chunk_type: &str) -> bool {
    if !content.chars().any(|c| c.is_alphanumeric()) {
        return true;
    }
    if chunk_type != "text" {
        return false;
    }
    let effective: usize = content
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .map(|l| l.chars().filter(|c| c.is_alphanumeric()).count())
        .sum();
    effective < MIN_EFFECTIVE_CHUNK_CHARS
}

/// 组装单 chunk（标题前缀进 raw_text；type 单块保留语义）。
fn push_chunk(
    out: &mut Vec<KbChunkMeta>,
    next_index: &mut usize,
    section_path: &str,
    breadcrumbs: Option<&str>,
    chunk_type: &'static str,
    content: &str,
) {
    let content = content.trim().to_string();
    if content.chars().count() < 2 || is_noise_chunk(&content, chunk_type) {
        return;
    }
    let raw_text = match breadcrumbs {
        Some(bc) if !bc.is_empty() => format!("{bc}\n{content}"),
        _ => content.clone(),
    };
    out.push(KbChunkMeta {
        chunk_index: *next_index,
        chunk_type,
        raw_text,
        content,
        path: section_path.to_string(),
        breadcrumbs: breadcrumbs.map(|s| s.to_string()),
    });
    *next_index += 1;
}

/// 资产文本 → chunk 序列（md 走层级分节 + 语义块，txt 走纯滑窗）。
pub(crate) fn chunk_asset(text: &str, is_md: bool) -> Vec<KbChunkMeta> {
    let mut out: Vec<KbChunkMeta> = Vec::new();
    let mut next_index = 0usize;
    if is_md {
        for section in split_md_leveled(text) {
            chunk_section(
                &section.path,
                section.breadcrumbs.as_deref(),
                &section.body,
                &mut next_index,
                &mut out,
            );
        }
    } else {
        chunk_section("", None, text, &mut next_index, &mut out);
    }
    // 上限保护：超出截断（超长文件降级，日志由调用方给出）
    if out.len() > MAX_CHUNKS_PER_ASSET {
        out.truncate(MAX_CHUNKS_PER_ASSET);
    }
    out
}

/* ---------------- SQLite / 配置辅助 ---------------- */

/// LanceDB 标量谓词值转义（单引号双写，防谓词注入）。
fn esc(s: &str) -> String {
    s.replace('\'', "''")
}

async fn get_config_value(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取 app_config[{key}] 失败：{e}"))?;
    Ok(row.and_then(|r| r.try_get::<Option<String>, _>("value").ok().flatten()))
}

async fn set_config_value(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map_err(|e| format!("写入 app_config[{key}] 失败：{e}"))?;
    Ok(())
}

/// 解析知识库物理根目录：`knowledge_base_path` + identifier，占位符同 vector_store 语义。
async fn resolve_kb_root(app: &AppHandle, identifier: &str) -> Result<PathBuf, String> {
    let pool = get_pool(app).await?;
    let raw: Option<String> =
        sqlx::query("SELECT value FROM app_config WHERE key = ?")
            .bind(KB_ROOT_KEY)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("读取 knowledge_base_path 失败：{e}"))?
            .and_then(|r| r.try_get::<Option<String>, _>("value").ok().flatten());
    let raw = raw.unwrap_or_else(|| "$APPDATA/.knowledge_base".to_string());
    let mut base = if raw.contains("$APPDATA") {
        let b = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("解析应用数据目录失败：{e}"))?;
        PathBuf::from(raw.replace("$APPDATA", &b.to_string_lossy()))
    } else if raw.contains("$RESOURCE") {
        let b = app
            .path()
            .resource_dir()
            .map_err(|e| format!("解析资源目录失败：{e}"))?;
        PathBuf::from(raw.replace("$RESOURCE", &b.to_string_lossy()))
    } else {
        PathBuf::from(raw)
    };
    base.push(identifier);
    Ok(base)
}

/// kb_chunks schema 迁移（一次性）：app_config 标记 ≠ v2 时 drop 旧 M1 表（零消费）并写标记。
/// 旧表无任何写入方（K1 从未实现），drop 无数据损失。
async fn ensure_kb_chunks_schema(vs: &vector_store::LanceDbVectorStore, pool: &SqlitePool) {
    let marker = get_config_value(pool, KB_CHUNKS_SCHEMA_KEY)
        .await
        .unwrap_or(None);
    if marker.as_deref() == Some(KB_CHUNKS_SCHEMA_VERSION) {
        return;
    }
    match vs.drop_table(vector_store::VectorTable::KbChunks.name()).await {
        Ok(()) => {
            tracing::info!("[kb-index] kb_chunks 旧 schema 已清除，写入时按 v2 惰性重建");
        }
        Err(e) => {
            tracing::warn!("[kb-index] kb_chunks 旧表清除失败（可能本就不存在）：{e}");
        }
    }
    if let Err(e) = set_config_value(pool, KB_CHUNKS_SCHEMA_KEY, KB_CHUNKS_SCHEMA_VERSION).await {
        tracing::warn!("[kb-index] schema 标记写入失败（下次仍会尝试迁移）：{e}");
    }
}

/* ---------------- 同步 / 删除 / 重建 ---------------- */

/// 单资产同步结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSyncReport {
    /// skipped（digest+路径未变） / reindexed / unsupported（格式不支持）
    pub result: String,
    /// 本次写入的 chunk 数（skipped = 0）
    pub chunks: u32,
    /// 是否已写入向量（嵌入未配置 = false，chunks 以 null 向量或仅 SQLite 状态存在）
    pub embedded: bool,
}

/// 单资产增量同步（幂等；force=true 时跳过 digest 短路，重建路径使用）。
/// 失败 = Err（调用方记日志；前端钩子 fire-and-forget 不阻塞文件管理）。
pub(crate) async fn sync_asset_index(
    app: &AppHandle,
    kb_id: &str,
    asset_id: &str,
    force: bool,
) -> Result<KbSyncReport, String> {
    let pool = get_pool(app).await?;
    let Some(vs) = vector_store::get_shared(app).await else {
        return Err("向量库不可用（请检查设置页「向量库存储目录」）".into());
    };
    ensure_kb_chunks_schema(&vs, &pool).await;

    // 1. 资产行 + 所属知识库 identifier
    let row = sqlx::query(
        "SELECT ka.file_path, ka.file_ext, ka.meta_data, kb.identifier \
         FROM knowledge_asset ka JOIN knowledge_base kb ON kb.id = ka.kb_id \
         WHERE ka.id = ? AND ka.kb_id = ?",
    )
    .bind(asset_id)
    .bind(kb_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("读取知识库资产失败：{e}"))?;
    let Some(row) = row else {
        return Err("知识库资产不存在".into());
    };
    let file_path: String = row.try_get("file_path").map_err(|e| e.to_string())?;
    let file_ext: Option<String> = row.try_get("file_ext").ok().flatten();
    let asset_meta: Option<String> = row.try_get("meta_data").ok().flatten();
    let identifier: String = row.try_get("identifier").map_err(|e| e.to_string())?;

    // 2. 格式支持判定（解析器接缝）
    let ext = file_ext.unwrap_or_default();
    let Some(extractor) = extractor_for(&ext) else {
        return Ok(KbSyncReport { result: "unsupported".into(), chunks: 0, embedded: false });
    };

    // 3. 读文件 → 提取文本 → digest
    let root = resolve_kb_root(app, &identifier).await?;
    let full = root.join(&file_path);
    let bytes = std::fs::read(&full).map_err(|e| format!("读取资产文件失败 {}：{e}", full.display()))?;
    let text = extractor.extract(&bytes)?.text;
    let digest = content_digest(&text);
    let is_md = ext.to_lowercase().ends_with("md");

    // 4. 增量判定：digest 未变且路径未变 → 跳过（改名/移动会改 file_path → 重写元数据）
    let filter = format!("kb_id = '{}' AND asset_id = '{}'", esc(kb_id), esc(asset_id));
    if !force {
        if let Some(info) = vs.query_kb_asset_digest(&filter).await? {
            if info.digest == digest && info.origin_file_path == file_path {
                return Ok(KbSyncReport { result: "skipped".into(), chunks: 0, embedded: false });
            }
        }
    }

    // 5. 切块（先清旧段：节索引可能减少，清空重写最稳）
    vs.delete_by_filter(vector_store::VectorTable::KbChunks, &filter)
        .await?;
    let chunks = chunk_asset(&text, is_md);
    if chunks.is_empty() {
        sqlx::query("UPDATE knowledge_asset SET digest = ?, indexed_at = ? WHERE id = ?")
            .bind(&digest)
            .bind(chrono::Utc::now().timestamp_millis())
            .bind(asset_id)
            .execute(&pool)
            .await
            .map_err(|e| format!("回写资产索引状态失败：{e}"))?;
        return Ok(KbSyncReport { result: "reindexed".into(), chunks: 0, embedded: false });
    }

    // 6. 组装行（meta_data：资产 tags 继承 + prev/next 链）
    let asset_tags = asset_meta
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("tags").cloned())
        .unwrap_or(serde_json::Value::Null);
    let now = chrono::Utc::now().timestamp_millis();
    let build_row = |c: &KbChunkMeta, embedding: Option<Vec<f32>>| {
        let prev = if c.chunk_index > 0 {
            Some(format!("{asset_id}#{}", c.chunk_index - 1))
        } else {
            None
        };
        let next = Some(format!("{asset_id}#{}", c.chunk_index + 1));
        let meta = serde_json::json!({
            "tags": asset_tags,
            "prev_id": prev,
            "next_id": next,
            "char_count": c.content.chars().count(),
        });
        KbChunkVectorRow {
            id: format!("{asset_id}#{}", c.chunk_index),
            kb_id: kb_id.to_string(),
            asset_id: asset_id.to_string(),
            chunk_index: c.chunk_index as i32,
            chunk_type: c.chunk_type.to_string(),
            raw_text: c.raw_text.clone(),
            content: c.content.clone(),
            path: c.path.clone(),
            breadcrumbs: c.breadcrumbs.clone(),
            page_idx: None,
            bbox: None,
            origin_file_path: file_path.clone(),
            meta_data: Some(meta.to_string()),
            content_digest: digest.clone(),
            embedding,
            embedding_model: None,
            updated_at: now,
        }
    };

    // 7. 嵌入（批量）与维度管理
    let cfg = embedding::load_default_embedding(&pool).await?;
    let mut embedded = false;
    match &cfg {
        Some(cfg) => {
            let mut first_dim: Option<usize> = None;
            for batch in chunks.chunks(EMBED_BATCH) {
                let texts: Vec<String> = batch.iter().map(|c| c.raw_text.clone()).collect();
                let vecs = embedding::embed_texts(app, &pool, cfg, &texts).await?;
                let dim = vecs
                    .first()
                    .map(|v| v.len())
                    .ok_or("嵌入返回空向量数组")?;
                if let Some(d) = first_dim {
                    if d != dim {
                        return Err(format!("嵌入返回维度不一致（{d} vs {dim}），中止本次同步"));
                    }
                } else {
                    first_dim = Some(dim);
                    // 维度迁移判定：表级记录变化 → drop 旧表（重建路径也会走到这里）
                    let stored = get_config_value(&pool, KB_EMBED_DIM_KEY).await?.and_then(|s| s.parse::<usize>().ok());
                    if stored != Some(dim) {
                        if stored.is_some() {
                            vs.drop_table(vector_store::VectorTable::KbChunks.name()).await?;
                            tracing::warn!("[kb-index] 嵌入维度变化（{stored:?} → {dim}），kb_chunks 已重建（其他资产请执行重建索引）");
                        }
                        set_config_value(&pool, KB_EMBED_DIM_KEY, &dim.to_string()).await?;
                    }
                }
                let rows: Vec<KbChunkVectorRow> = batch
                    .iter()
                    .zip(vecs.iter())
                    .map(|(c, v)| {
                        let mut r = build_row(c, Some(v.clone()));
                        r.embedding_model = Some(cfg.model_name.clone());
                        r
                    })
                    .collect();
                vs.upsert_kb_chunks(&rows, dim).await?;
            }
            embedded = true;
        }
        None => {
            // 未配置嵌入：维度已知（曾索引过）→ null 向量占位入库；维度未知 → 仅记 SQLite 状态
            if let Some(dim) = get_config_value(&pool, KB_EMBED_DIM_KEY)
                .await?
                .and_then(|s| s.parse::<usize>().ok())
            {
                for batch in chunks.chunks(EMBED_BATCH) {
                    let rows: Vec<KbChunkVectorRow> =
                        batch.iter().map(|c| build_row(c, None)).collect();
                    vs.upsert_kb_chunks(&rows, dim).await?;
                }
            }
        }
    }

    // 8. 回写资产索引状态
    sqlx::query("UPDATE knowledge_asset SET digest = ?, indexed_at = ? WHERE id = ?")
        .bind(&digest)
        .bind(now)
        .bind(asset_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("回写资产索引状态失败：{e}"))?;

    tracing::info!(
        "[kb-index] 资产已索引 chunks={} embedded={} kb={} asset={} path={}",
        chunks.len(), embedded, kb_id, asset_id, file_path
    );
    Ok(KbSyncReport {
        result: "reindexed".into(),
        chunks: chunks.len() as u32,
        embedded,
    })
}

/// 级联清理资产向量段（前端删除资产/文件后调用；SQLite 行可能已不存在，幂等）。
pub(crate) async fn remove_asset_index(app: &AppHandle, kb_id: &str, asset_id: &str) -> Result<(), String> {
    let Some(vs) = vector_store::get_shared(app).await else {
        return Err("向量库不可用".into());
    };
    let filter = format!("kb_id = '{}' AND asset_id = '{}'", esc(kb_id), esc(asset_id));
    vs.delete_by_filter(vector_store::VectorTable::KbChunks, &filter)
        .await?;
    // 行仍在时清索引状态（行已删则 UPDATE 空匹配，幂等）
    if let Ok(pool) = get_pool(app).await {
        let _ = sqlx::query("UPDATE knowledge_asset SET digest = NULL, indexed_at = NULL WHERE id = ? AND kb_id = ?")
            .bind(asset_id)
            .bind(kb_id)
            .execute(&pool)
            .await;
    }
    Ok(())
}

/// 级联清理**整个知识库**的向量段（删除知识库前调用；幂等）。
/// 2026-09-21 缺口修复：此前 deleteKnowledgeBase 只删 SQLite 两表 + 磁盘目录，
/// Lance 向量段（存于全局 .vectors 库）残留为孤儿——磁盘目录删除不影响 .vectors。
pub(crate) async fn remove_kb_index(app: &AppHandle, kb_id: &str) -> Result<(), String> {
    let Some(vs) = vector_store::get_shared(app).await else {
        return Err("向量库不可用".into());
    };
    let filter = format!("kb_id = '{}'", esc(kb_id));
    vs.delete_by_filter(vector_store::VectorTable::KbChunks, &filter)
        .await?;
    tracing::info!("[agent] remove_kb_index: 已清理知识库 {kb_id} 的全部向量段");
    Ok(())
}

/* ---------------- 全量重建 ---------------- */

static KB_REBUILD_RUNNING: AtomicBool = AtomicBool::new(false);

/// 重建已受理（立即返回，进度走 `agent-kb-index-progress` 事件）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbRebuildAccepted {
    pub started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 全量重建（设计稿 §5.2）：遍历资产逐个 force 同步，逐资产推进度事件；
/// 重入保护（全局单飞）；失败资产跳过不中断，最终汇总。
pub(crate) async fn spawn_rebuild_kb_index(app: AppHandle, kb_id: String) -> Result<KbRebuildAccepted, String> {
    if KB_REBUILD_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(KbRebuildAccepted {
            started: false,
            reason: Some("已有重建任务在进行中".into()),
        });
    }
    tauri::async_runtime::spawn(async move {
        let _guard = KbRebuildGuard;
        let result = run_rebuild(&app, &kb_id).await;
        if let Err(e) = result {
            tracing::error!("[kb-index] 知识库 {kb_id} 重建失败：{e}");
            events::emit_kb_index_progress(
                &app,
                &events::KbIndexProgress {
                    kb_id: kb_id.clone(),
                    phase: "done".into(),
                    done: 0,
                    total: 0,
                    asset_id: None,
                    message: Some(format!("重建失败：{e}")),
                    finished: true,
                },
            );
        }
    });
    Ok(KbRebuildAccepted { started: true, reason: None })
}

struct KbRebuildGuard;
impl Drop for KbRebuildGuard {
    fn drop(&mut self) {
        KB_REBUILD_RUNNING.store(false, Ordering::SeqCst);
    }
}

async fn run_rebuild(app: &AppHandle, kb_id: &str) -> Result<(), String> {
    let pool = get_pool(app).await?;
    // 重扫资产清单（前端 refreshAssets 已保证行与磁盘一致；此处直接消费）
    let rows = sqlx::query(
        "SELECT id, file_ext FROM knowledge_asset WHERE kb_id = ? ORDER BY file_path ASC",
    )
    .bind(kb_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取知识库资产清单失败：{e}"))?;
    let total = rows.len() as u32;
    let mut done = 0u32;
    let mut ok = 0u32;
    let mut failed = 0u32;
    for row in rows {
        let asset_id: String = row.try_get("id").map_err(|e| e.to_string())?;
        let ext: Option<String> = row.try_get("file_ext").ok().flatten();
        let supported = ext
            .as_deref()
            .map(|e| extractor_for(e).is_some())
            .unwrap_or(false);
        let result = if supported {
            sync_asset_index(app, kb_id, &asset_id, true).await
        } else {
            Ok(KbSyncReport {
                result: "unsupported".into(),
                chunks: 0,
                embedded: false,
            })
        };
        done += 1;
        match result {
            Ok(r) if r.result == "unsupported" => {
                events::emit_kb_index_progress(
                    app,
                    &events::KbIndexProgress {
                        kb_id: kb_id.to_string(),
                        phase: "skip".into(),
                        done,
                        total,
                        asset_id: Some(asset_id),
                        message: Some("格式暂不支持检索".into()),
                        finished: done >= total,
                    },
                );
            }
            Ok(r) => {
                ok += 1;
                events::emit_kb_index_progress(
                    app,
                    &events::KbIndexProgress {
                        kb_id: kb_id.to_string(),
                        phase: "upsert".into(),
                        done,
                        total,
                        asset_id: Some(asset_id),
                        message: Some(format!("{} chunks（{}）", r.chunks, if r.embedded { "已向量化" } else { "未向量化" })),
                        finished: done >= total,
                    },
                );
            }
            Err(e) => {
                failed += 1;
                tracing::warn!("[kb-index] 资产 {asset_id} 重建失败（跳过）：{e}");
                events::emit_kb_index_progress(
                    app,
                    &events::KbIndexProgress {
                        kb_id: kb_id.to_string(),
                        phase: "error".into(),
                        done,
                        total,
                        asset_id: Some(asset_id),
                        message: Some(e),
                        finished: done >= total,
                    },
                );
            }
        }
    }
    tracing::info!("[kb-index] 知识库 {kb_id} 重建完成：总 {total}，成功 {ok}，失败 {failed}");
    events::emit_kb_index_progress(
        app,
        &events::KbIndexProgress {
            kb_id: kb_id.to_string(),
            phase: "done".into(),
            done: total,
            total,
            asset_id: None,
            message: Some(format!("重建完成：成功 {ok}，失败 {failed}")),
            finished: true,
        },
    );
    Ok(())
}

/* ---------------- 检索（K2：native__kb_search 消费） ---------------- */

/// 知识库检索命中（工具出参；来源信息齐备可溯源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSearchHit {
    pub id: String,
    pub kb_id: String,
    pub asset_id: String,
    /// 源文件相对路径
    pub origin_file_path: String,
    /// 层级路径 / 面包屑（可空）
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breadcrumbs: Option<String>,
    /// chunk 类型（text/table/code）
    pub chunk_type: String,
    /// 命中内容（已裁剪）
    pub content: String,
    /// 相关度得分（Lance L2 距离，越小越相似；关键词降级路径 = -1.0）
    pub score: f32,
    /// 检索通道：vector / keyword
    pub channel: String,
}

/// 检索内容裁剪上限（工具出参防超长）。K3-4 分级裁剪：首条（最优命中）保全景。
/// 修订（2026-09-20 轮 3 复测）：code/table 属枚举/字段表类结构化内容，300 字截断会
/// 腰斩色值表/分区表导致模型误判「结果不足」——与首条同限。
/// 修订（2026-09-20 轮 7 复测）：调色板 chunk 实际 ~700 字被 600 腰斩（outfit 差 1 行），
/// 模型重检又被 seen 去重挡住 → 首检即拿全比依赖重取通路可靠，code/table 提到 1200。
const SEARCH_CONTENT_CLIP_FIRST: usize = 1200;
const SEARCH_CONTENT_CLIP_REST: usize = 300;

/// 按命中序位与 chunk 类型决定裁剪上限。
fn clip_limit_for(idx: usize, chunk_type: &str) -> usize {
    if idx == 0 {
        return SEARCH_CONTENT_CLIP_FIRST;
    }
    match chunk_type {
        "code" | "table" => SEARCH_CONTENT_CLIP_FIRST,
        _ => SEARCH_CONTENT_CLIP_REST,
    }
}

/// 相关性距离阈值（Lance L2，score 越小越相似）。2026-09-20 实测标定（bge-small-zh-v1.5）：
/// 相关查询命中 score<0.95、无关查询最近邻 score>1.0，分布天然分离——超过该阈值的命中
/// 直接过滤（视作「无相关内容」）。⚠️ 换嵌入模型后此值需重新标定。
const KB_SCORE_RELEVANCE_MAX: f32 = 1.0;

/// 相关性判定（K3-4）：score ≤ 阈值视为相关；关键词降级路径 score=-1.0 恒相关（LIKE 已是字面匹配）。
fn is_relevant_score(score: f32) -> bool {
    score < 0.0 || score <= KB_SCORE_RELEVANCE_MAX
}

/// K3-3 标签匹配（纯函数）：资产 `meta_data` JSON 的 `tags` 数组与给定标签是否有交集。
/// 容忍脏数据：meta_data 缺失 / 非 JSON / tags 非数组 → 一律不命中（不 panic）。
fn asset_matches_tags(meta_data: Option<&str>, tags: &[String]) -> bool {
    let Some(raw) = meta_data else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(arr) = v.get("tags").and_then(|t| t.as_array()) else {
        return false;
    };
    arr.iter().any(|t| {
        t.as_str()
            .is_some_and(|s| tags.iter().any(|q| q == s))
    })
}

/// 知识库检索管道（K2 设计稿 §5.3）：向量近邻 → 关键词 LIKE 降级 → 空清单。
/// `kb_ids` 为空 = 未绑定，返回空（工具层不应注册，此处兜底防呆）。
/// `full` = 返回未裁剪正文（上限 4000 字防极端）：用于「重检命中已全部见过」时
/// 恢复完整原文——裁剪分级 + 去重叠加曾导致超长 chunk（如调色板 ~700 字）永远拿不回
/// 完整版（2026-09-20 轮 4 实锤）。
/// `tags`（K3-3）= 资产标签圈定：非空时先查 SQLite `knowledge_asset.meta_data.tags`
/// 命中的 asset_id 集（设计稿 §2.4：SQLite 管标签过滤、Lance 管语义），无命中直接返回空。
pub(crate) async fn kb_search(
    app: &AppHandle,
    kb_ids: &[String],
    query: &str,
    top_k: usize,
    full: bool,
    tags: Option<&[String]>,
) -> Result<Vec<KbSearchHit>, String> {
    let query = query.trim();
    if kb_ids.is_empty() || query.is_empty() {
        return Ok(Vec::new());
    }
    let pool = get_pool(app).await?;
    let Some(vs) = vector_store::get_shared(app).await else {
        return Err("向量库不可用".into());
    };
    let kb_filter = format!(
        "kb_id IN ({})",
        kb_ids.iter().map(|id| format!("'{}'", esc(id))).collect::<Vec<_>>().join(", ")
    );
    // K3-3 标签圈定：资产量级小（每 KB 几十~几百），拉到 Rust 内存按 JSON tags 交集匹配，
    // 不依赖 SQLite JSON1 扩展、容忍脏 meta_data（通用性）。无命中资产 → 直接空结果。
    let asset_filter = if let Some(tags) = tags.filter(|t| !t.is_empty()) {
        let kb_in = kb_ids.iter().map(|id| format!("'{}'", esc(id))).collect::<Vec<_>>().join(", ");
        let rows = sqlx::query(&format!(
            "SELECT id, meta_data FROM knowledge_asset WHERE kb_id IN ({kb_in})"
        ))
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("查询资产标签失败：{e}"))?;
        let matched: Vec<String> = rows
            .into_iter()
            .filter_map(|r| {
                let id: String = r.try_get("id").ok()?;
                let meta: Option<String> = r.try_get("meta_data").ok()?;
                asset_matches_tags(meta.as_deref(), tags).then_some(id)
            })
            .collect();
        if matched.is_empty() {
            tracing::info!("[agent] kb_search: 标签圈定无命中资产 tags={:?} → 返回空", tags);
            return Ok(Vec::new());
        }
        tracing::info!(
            "[agent] kb_search: 标签圈定 tags={:?} 命中 {} 个资产",
            tags,
            matched.len()
        );
        format!(
            " AND asset_id IN ({})",
            matched.iter().map(|id| format!("'{}'", esc(id))).collect::<Vec<_>>().join(", ")
        )
    } else {
        String::new()
    };
    let vector_filter = format!("{kb_filter}{asset_filter}");
    let top_k = top_k.clamp(1, 8);

    // 通道一：向量检索
    if let Some(cfg) = embedding::load_default_embedding(&pool).await? {
        let qvec = embedding::embed_texts(app, &pool, &cfg, &[query.to_string()])
            .await?
            .into_iter()
            .next()
            .ok_or("嵌入返回空向量")?;
        let hits = vs.search_kb_chunks(&qvec, Some(&vector_filter), top_k).await?;
        // K3-4：score 阈值过滤——无关查询的最近邻（distance>1.0）直接丢弃；
        // 全部被滤掉时落到关键词通道做最后一次字面匹配，仍空则由上层返回「未找到」。
        let hits: Vec<_> = hits.into_iter().filter(|h| is_relevant_score(h.score)).collect();
        if !hits.is_empty() {
            // K3-4 分级裁剪：首条（最优命中）保 600 字全景，其余 300 字要点。
            return Ok(hits
                .into_iter()
                .enumerate()
                .map(|(idx, h)| KbSearchHit {
                    content: if full {
                        clip_chars(&h.content, 4000)
                    } else {
                        clip_chars(&h.content, clip_limit_for(idx, &h.chunk_type))
                    },
                    channel: "vector".into(),
                    score: h.score,
                    id: h.id,
                    kb_id: h.kb_id,
                    asset_id: h.asset_id,
                    origin_file_path: h.origin_file_path,
                    path: h.path,
                    breadcrumbs: h.breadcrumbs,
                    chunk_type: h.chunk_type,
                })
                .collect());
        }
    }

    // 通道二：关键词 LIKE 降级（嵌入未配置 / 向量无命中）。取查询词空格分词（≤5 个）OR 匹配。
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(5)
        .collect();
    let terms = if terms.is_empty() { vec![query.to_string()] } else { terms };
    let like_clause = terms
        .iter()
        .map(|t| format!("(content LIKE '%{}%' OR raw_text LIKE '%{}%')", esc(t), esc(t)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let kw_filter = format!("{kb_filter}{asset_filter} AND ({like_clause})");
    let rows = vs.query_kb_chunks_by_keyword(&kw_filter, top_k).await?;
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(idx, h)| KbSearchHit {
            content: if full {
                clip_chars(&h.content, 4000)
            } else {
                clip_chars(&h.content, clip_limit_for(idx, &h.chunk_type))
            },
            channel: "keyword".into(),
            score: -1.0,
            id: h.id,
            kb_id: h.kb_id,
            asset_id: h.asset_id,
            origin_file_path: h.origin_file_path,
            path: h.path,
            breadcrumbs: h.breadcrumbs,
            chunk_type: h.chunk_type,
        })
        .collect())
}

/// 字符安全裁剪（超长加省略号）。
fn clip_chars(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

/* ---------------- 单测 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// K3-3 标签匹配：meta_data JSON tags 交集判定 + 脏数据容忍。
    #[test]
    fn asset_tags_matching_tolerates_dirty_meta() {
        let tags = ["设计".to_string(), "架构".to_string()];
        // 正常命中（顺序/子集无关）
        assert!(asset_matches_tags(Some(r#"{"tags":["设计","RAG"]}"#), &tags));
        assert!(asset_matches_tags(Some(r#"{"tags":["架构"]}"#), &tags));
        // 保留其它字段不受影响
        assert!(asset_matches_tags(
            Some(r#"{"digest":"abc","tags":["设计"]}"#),
            &tags
        ));
        // 不命中
        assert!(!asset_matches_tags(Some(r#"{"tags":["RAG"]}"#), &tags));
        // 脏数据：缺失 meta_data / 非 JSON / tags 非数组 / 空查询
        assert!(!asset_matches_tags(None, &tags));
        assert!(!asset_matches_tags(Some("not-json"), &tags));
        assert!(!asset_matches_tags(Some(r#"{"tags":"设计"}"#), &tags));
        assert!(!asset_matches_tags(Some(r#"{}"#), &tags));
        assert!(!asset_matches_tags(Some(r#"{"tags":["设计"]}"#), &[]));
    }

    #[test]
    fn extractor_supports_md_txt_only() {
        assert!(extractor_for("md").is_some());
        assert!(extractor_for("MD").is_some());
        assert!(extractor_for("markdown").is_some());
        assert!(extractor_for("txt").is_some());
        assert!(extractor_for("pdf").is_none());
        assert!(extractor_for("docx").is_none());
        assert!(extractor_for("").is_none());
    }

    #[test]
    fn relevance_score_threshold_matches_calibration() {
        // 2026-09-20 标定：相关命中 <0.95，无关最近邻 >1.0（bge-small-zh L2 距离）
        assert!(is_relevant_score(0.55));
        assert!(is_relevant_score(0.85));
        assert!(is_relevant_score(0.95));
        assert!(is_relevant_score(1.0)); // 边界：恰在阈值内保留（保守，宁多勿漏）
        assert!(!is_relevant_score(1.05));
        assert!(!is_relevant_score(1.08));
        // 关键词降级路径恒相关
        assert!(is_relevant_score(-1.0));
    }

    #[test]
    fn clip_limit_tiers_by_chunk_type() {
        // 首条一律全景（轮 7 修订：调色板 ~700 字 chunk 曾被 600 腰斩且重检被
        // seen 去重挡住 → code/table 提到 1200，首检即拿全优先于依赖重取通路）
        assert_eq!(clip_limit_for(0, "text"), 1200);
        assert_eq!(clip_limit_for(0, "code"), 1200);
        // 结构化内容（枚举/字段表）截断伤害大，与首条同限
        assert_eq!(clip_limit_for(1, "code"), 1200);
        assert_eq!(clip_limit_for(3, "table"), 1200);
        // 叙述类压缩
        assert_eq!(clip_limit_for(1, "text"), 300);
    }

    #[test]
    fn windows_overlap_and_cover() {
        let text = "a".repeat(1000);
        let ws = sliding_windows(&text, 800, 80);
        assert!(ws.len() >= 2);
        // 首窗满 800，尾窗必须覆盖到末尾
        assert_eq!(ws[0].chars().count(), 800);
        let last = ws.last().unwrap();
        assert_eq!(last.chars().rev().take(1).next(), Some('a'));
        // 短文本单窗
        assert_eq!(sliding_windows("短的", 800, 80).len(), 1);
    }

    #[test]
    fn line_groups_split_and_keep_all_lines() {
        let lines: Vec<&str> = (0..30).map(|_| "row").collect();
        let groups = line_groups(&lines, 10);
        assert!(groups.len() >= 5);
        let total: usize = groups.iter().map(|g| g.lines().count()).sum();
        assert_eq!(total, 30, "分组不得丢行");
    }

    #[test]
    fn md_level_chain_builds_path_and_breadcrumbs() {
        let md = "# 第一章\n内容一。\n## 第一节\n内容二。\n# 第二章\n内容三。";
        let secs = split_md_leveled(md);
        assert_eq!(secs.len(), 3);
        assert_eq!(secs[0].path, "第一章");
        assert_eq!(secs[1].path, "第一章/第一节");
        assert_eq!(secs[1].breadcrumbs.as_deref(), Some("第一章 > 第一节"));
        // # 弹出更深层级
        assert_eq!(secs[2].path, "第二章");
    }

    #[test]
    fn md_table_and_code_blocks_typed() {
        let md = "# 数据\n| a | b |\n|---|---|\n| 1 | 2 |\n正文段落内容较长，确保文本块不被噪声门槛过滤。\n```python\nprint(1)\n```\n结尾内容同样足够长，保证保留为独立文本块。";
        let chunks = chunk_asset(md, true);
        assert!(chunks.iter().any(|c| c.chunk_type == "table"), "应有 table 块");
        assert!(chunks.iter().any(|c| c.chunk_type == "code"), "应有 code 块");
        assert!(chunks.iter().any(|c| c.chunk_type == "text"));
        // 表格块内容完整（不被滑窗拦腰切断）
        let table = chunks.iter().find(|c| c.chunk_type == "table").unwrap();
        assert!(table.content.contains("| a | b |"));
        assert!(table.content.contains("| 1 | 2 |"));
    }

    #[test]
    fn noise_chunks_filtered_md_and_txt() {
        // 纯函数：分隔线/纯符号/碎片/纯标题 = 噪声；有实质内容 = 保留（text 场景）
        assert!(is_noise_chunk("---", "text"));
        assert!(is_noise_chunk("***", "text"));
        assert!(is_noise_chunk("___", "text"));
        assert!(is_noise_chunk("| --- | --- |", "text")); // 表格分隔行漏判进 text
        assert!(is_noise_chunk("。！？", "text"));
        // 轮 6 真机实证的碎片/纯标题噪声（占 top_k 名额、嵌入不可靠）
        assert!(is_noise_chunk("内部：", "text"));
        assert!(is_noise_chunk("### 6.1 结构", "text"));
        assert!(is_noise_chunk("## 8. 决策记录", "text"));
        assert!(is_noise_chunk("### 2.3 调色板", "text"));
        assert!(is_noise_chunk("### 0.2 信息流", "text"));
        // 真实内容必须保留（防误伤回归）
        assert!(!is_noise_chunk("记忆系统 v2 选型 LanceDB", "text"));
        assert!(!is_noise_chunk(
            "阴影：容器 `::after` 硬边椭圆色块，不用 blur。",
            "text"
        ));
        assert!(!is_noise_chunk(
            "分段/页签：发型 | 眼 | 嘴 | 配饰 | 服装 | 道具",
            "text"
        ));
        // table/code 不受 text 短内容规则约束（防误伤：小表格/单行脚本有结构价值）
        assert!(!is_noise_chunk("| a | b |\n|---|---|\n| 1 | 2 |", "table"));
        assert!(!is_noise_chunk("print(1)", "code"));
        // 纯符号规则对 table/code 仍生效
        assert!(is_noise_chunk("---", "table"));
        assert!(is_noise_chunk("---", "code"));

        // md（贴近真机形态：heading+空行）：纯标题块滤除，实质内容保留
        let md = "# 甲\n\n正文甲内容足够长，不会被噪声规则过滤。\n\n---\n## 乙\n\n正文乙内容同样足够长，确保保留。\n\n| a | b |\n|---|---|\n| 1 | 2 |";
        let chunks = chunk_asset(md, true);
        assert!(!chunks.is_empty(), "实质内容不得被误杀");
        for c in &chunks {
            assert!(
                !is_noise_chunk(&c.content, &c.chunk_type),
                "噪声块入库: {:?}",
                c.content
            );
        }
        assert!(chunks.iter().any(|c| c.content.contains("正文甲")), "分隔线两侧实质内容保留");
        assert!(chunks.iter().any(|c| c.chunk_type == "table"), "表格不受影响");

        // heading 黏进首块时由正文兜底（剔除标题行后仍有有效内容）
        let md3 = "# 丙节\n实质内容足够长，保留为有效块。";
        let c3 = chunk_asset(md3, true);
        assert!(c3.iter().any(|c| c.content.contains("实质内容足够长")), "黏合块正文兜底保留");

        // txt 纯滑窗路径同样过滤（分隔线行混入）
        let txt = "实质内容第一段。\n---\n实质内容第二段。";
        let tchunks = chunk_asset(txt, false);
        assert!(tchunks.iter().all(|c| !is_noise_chunk(&c.content, &c.chunk_type)));

        // 真机案例复现（chunk #33）：标题下仅分隔线 → 该节只产出 `---` 块，必须整体滤除
        let md2 = "# 丙\n---\n# 丁\n实质内容比较丰富，足够保留为有效块。";
        let c2 = chunk_asset(md2, true);
        assert!(
            c2.iter().all(|c| !is_noise_chunk(&c.content, &c.chunk_type)),
            "仅分隔线的节不得成块"
        );
        assert!(c2.iter().any(|c| c.content.contains("实质内容")), "相邻实质节保留");
    }

    #[test]
    fn txt_long_text_windows_with_index_order() {
        let text = "字".repeat(2000);
        let chunks = chunk_asset(&text, false);
        assert!(chunks.len() >= 2);
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.chunk_index, i, "chunk_index 必须连续");
            assert_eq!(c.chunk_type, "text");
            assert_eq!(c.path, "");
        }
        // 重叠：第二块开头应包含第一块结尾的 overlap 字符
        assert_eq!(chunks[0].content, "字".repeat(CHUNK_WINDOW));
        let second_head: String = chunks[1].content.chars().take(CHUNK_OVERLAP).collect();
        assert_eq!(second_head, "字".repeat(CHUNK_OVERLAP));
    }

    #[test]
    fn md_single_section_no_heading() {
        let md = "纯文本说明一。\n纯文本说明二。";
        let chunks = chunk_asset(md, true);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].path, "");
        assert!(chunks[0].breadcrumbs.is_none());
    }

    #[test]
    fn max_chunks_cap() {
        // 每节 ~900 字符 → 每节 2 chunks；400 节 ≈ 800 chunks，不触顶；
        // 用超长单节构造 >2000 的场景（2000*800 字符）
        let text = "字".repeat(MAX_CHUNKS_PER_ASSET * CHUNK_WINDOW + 100);
        let chunks = chunk_asset(&text, false);
        assert_eq!(chunks.len(), MAX_CHUNKS_PER_ASSET, "必须按上限截断");
    }

    #[test]
    fn empty_and_tiny_text_produce_no_chunks() {
        assert!(chunk_asset("", false).is_empty());
        assert!(chunk_asset("   \n\n  ", false).is_empty());
        assert!(chunk_asset("# 只有标题\n", true).is_empty());
    }
}
