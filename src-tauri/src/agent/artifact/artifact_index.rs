//! L2 `.wd_mem/artifacts` 向量索引（#20260918006，设计稿 §3.2 表 artifacts / Step4）。
//!
//! - **写路径**：`native__archive_artifact` / `native__write_file` 写 `.wd_mem/artifacts/*.md`
//!   成功后 fire-and-forget：文件级 digest 增量判定（未变跳过）→ 变了按 path 删旧 →
//!   md 标题分节切块 → embed → upsert `artifacts`（id=`{path}#{section_index}`）；
//! - **读路径**：`load_config` 按本轮 prompt 向量检索 top-k 分节片段注入系统提示
//!   （隔离键 = 工程绑定的工作空间路径，同 workspace 多 agent 共享知识资产；
//!   「文件名清单 + MEMORY.md 全量注入」既有通道保留不变）；
//! - **失败语义**：嵌入未配置 / 向量库不可用 / 网络失败 = 降级跳过（无索引也能靠
//!   清单+MEMORY.md 工作），绝不阻塞归档主流程。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use tauri::AppHandle;

use sqlx::SqlitePool;

use crate::agent::knowledge::embedding;
use crate::agent::knowledge::vector_store::{self, ArtifactVectorRow};

/// 注入片段数（top-k；分节片段信息密度高于记忆条目，少而精）。
pub(crate) const RECALL_SNIPPET_TOP_K: usize = 3;
/// 注入片段正文的单节字符上限（防超长节撑爆系统提示）。
const SNIPPET_CONTENT_CLIP: usize = 600;

/* ---------------- 切块（纯函数，可单测） ---------------- */

/// 文件级内容摘要：DefaultHasher::new() 固定 key（SipHash13），跨进程稳定。
/// 仅用于「内容是否变更」的增量判定，不承担安全职责。
pub(crate) fn content_digest(content: &str) -> String {
    let mut h = DefaultHasher::new();
    content.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 判定标题行：md ATX 标题（允许前导至多 3 空格），级别 1-3 算分节边界
/// （#### 及更深视为小节细节，不拆分——归档文档的顶层结构以 #/##/### 组织）。
fn is_heading_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    if leading > 3 {
        return false;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=3).contains(&hashes) {
        return false;
    }
    // # 之后必须紧跟空格或行尾（排除 #hashtag 式误判）
    trimmed[hashes..]
        .chars()
        .next()
        .map(|c| c.is_whitespace())
        .unwrap_or(true)
}

/// 从标题行提取标题文本（去掉 # 前缀与空白）。
fn heading_text(line: &str) -> String {
    let trimmed = line.trim_start();
    let stripped = trimmed.trim_start_matches('#');
    stripped.trim().to_string()
}

/// md 按标题分节：
/// - 每个标题行开启一节（heading=标题文本，content=标题行至下一标题行前，含标题行本身——
///   片段自含上下文语义，嵌入与注入都不丢层级信息）；
/// - 第一标题之前的前言（非空）作为无标题节；
/// - 全文无标题 → 整文件单节（heading=None）；
/// - 空白节（仅标题行无正文）保留——标题本身也是检索信号，但 content 过短（<2 字符）跳过。
pub(crate) fn split_markdown_sections(content: &str) -> Vec<(Option<String>, String)> {
    let lines: Vec<&str> = content.lines().collect();
    let mut sections: Vec<(Option<String>, String)> = Vec::new();
    let mut cur_heading: Option<String> = None;
    let mut cur_buf: Vec<&str> = Vec::new();

    let flush = |sections: &mut Vec<(Option<String>, String)>,
                 heading: &Option<String>,
                 buf: &mut Vec<&str>| {
        let body = buf.join("\n");
        buf.clear();
        // 过滤纯空白节（如文件以连续标题行开头 / 末尾空行堆积）
        if body.trim().chars().count() < 2 {
            return;
        }
        // 「仅标题行无正文」= 空节：heading Some 时 buf 首行即标题行本身，
        // 其后无实质内容则整节跳过（heading 已单独进检索文本，重复无增益）。
        if heading.is_some() && body.lines().skip(1).all(|l| l.trim().is_empty()) {
            return;
        }
        sections.push((heading.clone(), body));
    };

    for line in &lines {
        if is_heading_line(line) {
            flush(&mut sections, &cur_heading, &mut cur_buf);
            cur_heading = Some(heading_text(line));
        }
        cur_buf.push(line);
    }
    flush(&mut sections, &cur_heading, &mut cur_buf);

    // 全文无任何标题：上面会把整文件聚成一个无标题节（cur_heading 一直为 None）✓
    sections
}

/* ---------------- 写路径：digest 增量同步 ---------------- */

/// LanceDB 标量谓词值转义（单引号双写；防谓词注入——值多为系统内生成的路径）。
fn esc(s: &str) -> String {
    s.replace('\'', "''")
}

/// 同步一个 artifacts 文件的向量索引：
/// 1. 算文件级 digest，查 Lance 现有 digest——相同 = 未变更，跳过（增量核心）；
/// 2. 变更：按 path 删旧分节 → md 分节 → embed（heading\n+content）→ upsert。
/// 嵌入未配置 / 向量库不可用 = Ok 跳过（降级：清单通道兜底）；网络/写入失败 = Err。
pub(crate) async fn sync_artifact_file(
    app: &AppHandle,
    pool: &SqlitePool,
    workspace: &str,
    rel_path: &str,
    content: &str,
) -> Result<(), String> {
    let digest = content_digest(content);
    let Some(vs) = vector_store::get_shared(app).await else {
        return Ok(()); // 向量库不可用：降级（清单 + MEMORY.md 通道仍工作）
    };
    let filter = format!(
        "project_id = '{}' AND path = '{}'",
        esc(workspace),
        esc(rel_path)
    );
    if let Some(existing) = vs.query_artifact_file_digest(&filter).await? {
        if existing == digest {
            return Ok(()); // digest 未变：跳过重嵌
        }
        // 变更：先删旧分节（节索引可能减少，直接清 path 重写最稳）
        vs.delete_by_filter(vector_store::VectorTable::Artifacts, &filter)
            .await?;
    }

    let Some(cfg) = embedding::load_default_embedding(pool).await? else {
        return Ok(()); // 未配置嵌入模型：静默跳过
    };
    let sections = split_markdown_sections(content);
    if sections.is_empty() {
        return Ok(()); // 空文件：无可索引内容
    }
    let texts: Vec<String> = sections
        .iter()
        .map(|(h, body)| match h {
            Some(h) if !h.is_empty() => format!("{h}\n{body}"),
            _ => body.clone(),
        })
        .collect();
    let vecs = embedding::embed_texts(app, pool, &cfg, &texts).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let rows: Vec<ArtifactVectorRow> = sections
        .iter()
        .zip(vecs.iter())
        .enumerate()
        .map(|(i, ((heading, body), vec))| ArtifactVectorRow {
            id: format!("{rel_path}#{i}"),
            project_id: workspace.to_string(),
            path: rel_path.to_string(),
            heading: heading.clone(),
            content: body.clone(),
            content_digest: digest.clone(),
            embedding: Some(vec.clone()),
            embedding_model: Some(cfg.model_name.clone()),
            updated_at: now,
        })
        .collect();
    vs.upsert_artifacts(&rows).await?;
    tracing::info!(
        "[artifact-index] 已索引 {} 个分节 path={} workspace={}",
        rows.len(),
        rel_path,
        workspace
    );
    Ok(())
}

/// fire-and-forget 写钩子：失败仅日志，绝不阻塞归档/写文件主流程。
pub(crate) fn spawn_artifact_index_sync(
    app: AppHandle,
    workspace: String,
    rel_path: String,
    content: String,
) {
    tauri::async_runtime::spawn(async move {
        let result = async {
            let pool = crate::agent::engine::round_compactor::get_pool(&app).await?;
            sync_artifact_file(&app, &pool, &workspace, &rel_path, &content).await
        }
        .await;
        if let Err(e) = result {
            tracing::warn!(
                "[artifact-index] 索引失败（该文件暂缺向量，清单通道兜底）rel={rel_path}：{e}"
            );
        }
    });
}

/* ---------------- 读路径：prompt 相关片段注入 ---------------- */

/// 检索与 prompt 相关的分节片段，组装注入块（空串 = 无可注入内容，调用方跳过）。
/// 失败 = Err（load_config 打日志后继续，绝不因检索失败阻断任务启动）。
pub(crate) async fn recall_artifact_snippets(
    app: &AppHandle,
    pool: &SqlitePool,
    workspace: &str,
    prompt: &str,
    k: usize,
) -> Result<String, String> {
    let Some(cfg) = embedding::load_default_embedding(pool).await? else {
        return Ok(String::new());
    };
    let Some(vs) = vector_store::get_shared(app).await else {
        return Ok(String::new());
    };
    let query_vec = embedding::embed_texts(app, pool, &cfg, &[prompt.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or("嵌入返回空向量")?;
    let filter = format!("project_id = '{}'", esc(workspace));
    let hits = vs.search_artifacts(&query_vec, Some(&filter), k).await?;
    if hits.is_empty() {
        return Ok(String::new());
    }
    let mut block = String::from(
        "### 项目知识片段（语义检索自 .wd_mem/artifacts，按相关度排序）\n以下是本工程历史沉淀的设计蓝图/约定/避坑记录中与本次任务最相关的片段，处理相关模块时应优先参考：\n",
    );
    for h in &hits {
        let title = h
            .heading
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                // 无标题节：用文件名兜底做展示标题
                Path::new(&h.path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| h.path.clone())
            });
        let mut content: String = h.content.chars().take(SNIPPET_CONTENT_CLIP).collect();
        if h.content.chars().count() > SNIPPET_CONTENT_CLIP {
            content.push('…');
        }
        block.push_str(&format!("\n- 【{title}】({})\n  {}", h.path, content));
    }
    Ok(block)
}

/* ---------------- 单测 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_stable_and_sensitive() {
        let a = content_digest("hello 世界");
        let b = content_digest("hello 世界");
        let c = content_digest("hello 世界！");
        assert_eq!(a, b, "同内容 digest 必须稳定");
        assert_ne!(a, c, "内容变化 digest 必须变化");
    }

    #[test]
    fn split_by_headings() {
        let md = "# 架构\n正文一。\n\n## 避坑\n坑一描述。\n正文续。\n### 细节\n细节内容。";
        let secs = split_markdown_sections(md);
        assert_eq!(secs.len(), 3, "3 个标题 → 3 节，实得：{secs:?}");
        assert_eq!(secs[0].0.as_deref(), Some("架构"));
        assert!(secs[0].1.contains("# 架构"));
        assert!(secs[0].1.contains("正文一"));
        assert_eq!(secs[1].0.as_deref(), Some("避坑"));
        assert!(secs[1].1.contains("坑一描述"));
        assert_eq!(secs[2].0.as_deref(), Some("细节"));
    }

    #[test]
    fn split_no_heading_single_section() {
        let md = "没有标题的普通文档。\n第二行内容。";
        let secs = split_markdown_sections(md);
        assert_eq!(secs.len(), 1);
        assert!(secs[0].0.is_none(), "无标题 → heading=None");
        assert!(secs[0].1.contains("第二行内容"));
    }

    #[test]
    fn split_keeps_front_matter_as_unheaded_section() {
        let md = "前言说明。\n\n# 正文标题\n正文内容。";
        let secs = split_markdown_sections(md);
        assert_eq!(secs.len(), 2);
        assert!(secs[0].0.is_none(), "第一标题前的前言 = 无标题节");
        assert!(secs[0].1.contains("前言说明"));
        assert_eq!(secs[1].0.as_deref(), Some("正文标题"));
    }

    #[test]
    fn split_ignores_deep_headings_and_hash_tags() {
        let md = "## 二级\n内容 A\n#### 四级不算分节\n仍是内容 A\n#tag 不是标题\n继续内容 A";
        let secs = split_markdown_sections(md);
        assert_eq!(secs.len(), 1, "#### 与 #tag 都不开新节，实得：{secs:?}");
        assert!(secs[0].1.contains("#### 四级不算分节"));
        assert!(secs[0].1.contains("#tag"));
    }

    #[test]
    fn split_skips_blank_sections() {
        let md = "## 空节\n## 下一节\n有内容。";
        let secs = split_markdown_sections(md);
        assert_eq!(secs.len(), 1, "「## 空节」后紧跟标题无正文被跳过，实得：{secs:?}");
        assert_eq!(secs[0].0.as_deref(), Some("下一节"));
    }
}
