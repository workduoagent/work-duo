//! 本地脚本插件 IPC 命令（对应设计方案 §6）。
//!
//! P1 仅落地两个走 Rust 的命令：
//! - `test_user_plugin`：端到端试跑（读 DB → 拼 Runner → 沙箱执行 → 依赖自愈 → 写日志 + 回写 last_run）。
//! - `extract_plugin_meta`：纯头注释解析 → JSON Schema（不落库）。
//! 其余 CRUD / 绑定命令由前端 TS mapper（`plugin-mapper.ts`）直接走 SQL，不进 Rust。

use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sqlx::Row;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::agent::plugin_runner::{run_plugin, PluginExecSpec, PluginRunResult};
use crate::bun_manager::BunManager;
use crate::mamba_manager::MambaManager;

/// 试跑本地插件：读 `user_plugin_tool` → 执行 → 返回与前端 `PluginTestResult` 对齐的结果。
#[tauri::command]
pub async fn test_user_plugin(
    app: AppHandle,
    mamba: State<'_, MambaManager>,
    bun: State<'_, BunManager>,
    plugin_id: String,
    params: Option<String>,
) -> Result<PluginRunResult, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db），请先在前端 load".to_string())?;
    let pool = match db_pool {
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);

    let row = sqlx::query("SELECT * FROM user_plugin_tool WHERE id = ?")
        .bind(&plugin_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询插件失败：{e}"))?;
    let row = row.ok_or_else(|| format!("插件不存在：{plugin_id}"))?;

    let get_str = |row: &sqlx::sqlite::SqliteRow, col: &str| -> String {
        row.try_get::<Option<String>, _>(col)
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    let get_i64 = |row: &sqlx::sqlite::SqliteRow, col: &str| -> i64 {
        row.try_get::<Option<i64>, _>(col).ok().flatten().unwrap_or(0)
    };

    let runtime = get_str(&row, "runtime");
    if runtime != "python" && runtime != "bun" {
        return Err(format!("插件运行时非法：{runtime}（仅支持 python / bun）"));
    }
    let script_content = get_str(&row, "script_content");
    if script_content.trim().is_empty() {
        return Err("插件脚本内容为空".to_string());
    }
    let timeout_sec = get_i64(&row, "timeout_sec") as u64;
    let deps_raw = get_str(&row, "dependencies");
    let dependencies: Vec<String> = if deps_raw.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str::<Vec<String>>(&deps_raw).unwrap_or_default()
    };

    // 入参：优先调用方传入 params；为空用 sample_params；再为空用 {}。
    let params_val: JsonValue = match params {
        Some(p) if !p.trim().is_empty() => {
            serde_json::from_str(&p).unwrap_or_else(|_| JsonValue::Object(Default::default()))
        }
        _ => {
            let sp = get_str(&row, "sample_params");
            if sp.trim().is_empty() {
                JsonValue::Object(Default::default())
            } else {
                serde_json::from_str(&sp).unwrap_or_else(|_| JsonValue::Object(Default::default()))
            }
        }
    };

    let spec = PluginExecSpec {
        plugin_id: plugin_id.clone(),
        runtime,
        script_content,
        timeout_sec: if timeout_sec == 0 { 60 } else { timeout_sec },
        dependencies,
    };

    let call_id = format!("call_{}", crate::agent::runtime::now_ms());
    let result =
        run_plugin(&app, &mamba, &bun, &spec, &params_val, &call_id, None, None, "test").await;
    Ok(result)
}

/// `extract_plugin_meta` 的返回结构（对齐 §3.4）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPluginMetaOutput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub dependencies: Vec<String>,
    pub parameters_schema: JsonValue,
    pub warnings: Vec<String>,
}

/// 纯解析用户脚本头注释 → 元数据（不落库）。runtime 暂预留，python/bun 头注释格式通用。
#[tauri::command]
pub async fn extract_plugin_meta(
    runtime: String,
    script: String,
) -> Result<ExtractPluginMetaOutput, String> {
    let _ = runtime;
    let mut warnings = Vec::new();
    let (name, description, dependencies, schema) = match extract_header(&script) {
        Some(h) => parse_meta(&h, &mut warnings),
        None => {
            warnings.push(
                "未检测到头注释元数据（Python 用 \"\"\"...\"\"\"，Bun 用 /** ... */）".into(),
            );
            let mut schema = serde_json::Map::new();
            schema.insert("type".into(), json!("object"));
            schema.insert("properties".into(), json!({}));
            (None, None, Vec::new(), JsonValue::Object(schema))
        }
    };
    Ok(ExtractPluginMetaOutput {
        name,
        description,
        dependencies,
        parameters_schema: schema,
        warnings,
    })
}

/// 提取脚本顶部的头注释块（Python `"""..."""` 或 Bun `/** ... */`）。
fn extract_header(script: &str) -> Option<String> {
    let t = script.trim_start();
    if let Some(rest) = t.strip_prefix("\"\"\"") {
        if let Some(end) = rest.find("\"\"\"") {
            return Some(rest[..end].to_string());
        }
        return None;
    }
    if let Some(rest) = t.strip_prefix("/**") {
        if let Some(end) = rest.find("*/") {
            let block = &rest[..end];
            // 逐行清洗 JSDoc 前缀，但**保留行内相对缩进**（只去「行首空白 + '*' + 一个空格」）：
            // 此前 trim_start 连缩进一起剥掉，parameters 的嵌套子字段（type/required）塌平成
            // 0 缩进，parse_meta 的缩进比较直接 break，Bun 头注释永远解析不出参数。
            let cleaned = block
                .lines()
                .map(|l| {
                    let s = l.trim_start();
                    let s = s.strip_prefix('*').unwrap_or(s);
                    let s = s.strip_prefix(' ').unwrap_or(s);
                    s.to_string()
                })
                .collect::<Vec<_>>()
                .join("\n");
            return Some(cleaned);
        }
    }
    None
}

/// 标量键取值：`name: x` / `name x`（冒号可省，JSDoc 惯例 `@name value`）→ 返回去空白后的值。
/// 仅完整命中键名（后跟冒号或空白），避免 `nameX` 误匹配。
fn scalar_value<'a>(t: &'a str, key: &str) -> Option<&'a str> {
    let rest = t.strip_prefix(key)?;
    if let Some(v) = rest.strip_prefix(':') {
        return Some(v.trim());
    }
    if rest.starts_with(' ') || rest.starts_with('\t') {
        return Some(rest.trim());
    }
    None
}

/// 段键判断：`parameters:` / `@parameters` / `dependencies`（冒号可省，后跟列表）。
fn is_section(t: &str, key: &str) -> bool {
    match t.strip_prefix(key) {
        None => false,
        Some(rest) => {
            rest.is_empty()
                || rest.starts_with(':')
                || rest.starts_with(' ')
                || rest.starts_with('\t')
        }
    }
}

/// 解析头注释：提取 name / description / dependencies（yaml 列表）/ parameters（→ JSON Schema）。
///
/// 解析宽松：未知键忽略并记入 warnings；缺 type 的 param 回落 string 并警告；不抛错，
/// 保证「提取失败也不阻塞保存，用户可手填 schema」（见 §3.4）。
fn parse_meta(
    header: &str,
    warnings: &mut Vec<String>,
) -> (Option<String>, Option<String>, Vec<String>, JsonValue) {
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut dependencies: Vec<String> = Vec::new();
    let mut props = serde_json::Map::new();
    let mut required: Vec<String> = Vec::new();

    let lines: Vec<&str> = header.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        // 去掉 JSDoc 的 @ 前缀，统一为 `name:` / `description:` 形式解析。
        let t = trimmed.strip_prefix('@').unwrap_or(trimmed);

        if let Some(v) = scalar_value(t, "name") {
            if !v.is_empty() {
                name = Some(v.to_string());
            }
        } else if let Some(v) = scalar_value(t, "description") {
            if !v.is_empty() {
                description = Some(v.to_string());
            }
        } else if is_section(t, "dependencies") {
            i += 1;
            while i < lines.len() {
                let dl = lines[i].trim();
                if dl.is_empty() {
                    i += 1;
                } else if let Some(dep) = dl.strip_prefix('-') {
                    let dep = dep.trim();
                    if !dep.is_empty() {
                        dependencies.push(dep.to_string());
                    }
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        } else if is_section(t, "parameters") {
            i += 1;
            while i < lines.len() {
                let pl = lines[i];
                let pt = pl.trim();
                if pt.is_empty() {
                    i += 1;
                    continue;
                }
                if let Some((key, _)) = pt.split_once(':') {
                    let key = key.trim();
                    if key.is_empty() || key.contains(' ') {
                        i += 1;
                        continue;
                    }
                    let indent = pl.len() - pl.trim_start().len();
                    if indent > 2 {
                        // 嵌套子字段不该出现在 param key 行，跳过。
                        i += 1;
                        continue;
                    }
                    // 收集该 param 的子字段（type / description / required）。
                    let mut ptype = String::new();
                    let mut pdesc = String::new();
                    let mut preq = false;
                    i += 1;
                    while i < lines.len() {
                        let sl = lines[i];
                        let st = sl.trim();
                        let sindent = sl.len() - sl.trim_start().len();
                        if st.is_empty() || sindent <= indent {
                            break;
                        }
                        if let Some(v) = st.strip_prefix("type:") {
                            ptype = v.trim().to_string();
                        } else if let Some(v) = st.strip_prefix("description:") {
                            pdesc = v.trim().to_string();
                        } else if let Some(v) = st.strip_prefix("required:") {
                            preq = v.trim() == "true";
                        }
                        i += 1;
                    }
                    let mut pm = serde_json::Map::new();
                    if ptype.is_empty() {
                        warnings.push(format!("参数 {key} 缺少 type，默认 string"));
                        pm.insert("type".into(), json!("string"));
                    } else {
                        pm.insert("type".into(), json!(ptype));
                    }
                    if !pdesc.is_empty() {
                        pm.insert("description".into(), json!(pdesc));
                    }
                    props.insert(key.to_string(), JsonValue::Object(pm));
                    if preq {
                        required.push(key.to_string());
                    }
                    continue;
                }
                // 非 param key 行（如 `-` 列表或空），结束参数块。
                break;
            }
            continue;
        }
        i += 1;
    }

    let mut schema = serde_json::Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), JsonValue::Object(props));
    if !required.is_empty() {
        schema.insert("required".into(), json!(required));
    }
    (name, description, dependencies, JsonValue::Object(schema))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用户真机用例（2026-09-16）：JSDoc 段键无冒号（@parameters）+ 缩进子字段。
    /// 曾因「清洗时剥掉缩进」+「强制要求冒号」两层 bug 识别失败。
    #[test]
    fn jsdoc_header_without_colon_sections_parses() {
        let script = r#"/**
 * @name password_gen
 * @description 生成随机安全密码（长度 8-64，含大小写/数字/符号；内置 crypto，零依赖）
 * @dependencies
 * @parameters
 *   length:
 *     type: number
 *     description: 密码长度，默认 16
 *     required: true
 */
import { randomInt } from 'node:crypto'
"#;
        let header = extract_header(script).expect("应提取到 JSDoc 头");
        let mut warnings = Vec::new();
        let (name, description, _deps, schema) = parse_meta(&header, &mut warnings);
        assert_eq!(name.as_deref(), Some("password_gen"));
        assert!(description.is_some());
        let length = schema
            .get("properties")
            .and_then(|p| p.get("length"))
            .expect("length 参数应被识别");
        assert_eq!(length.get("type").and_then(|t| t.as_str()), Some("number"));
        let required = schema.get("required").and_then(|r| r.as_array()).unwrap();
        assert_eq!(required, &["length".to_string()]);
        assert!(warnings.is_empty());
    }

    /// Python 风格（带冒号、原始缩进）回归：新解析逻辑不得破坏旧格式。
    #[test]
    fn python_header_with_colons_still_parses() {
        let script = "\"\"\"\nname: t\ndescription: d\ndependencies:\n  - requests\nparameters:\n  text:\n    type: string\n    required: true\n\"\"\"\ndef run(params):\n    return {}\n";
        let header = extract_header(script).unwrap();
        let mut warnings = Vec::new();
        let (name, desc, deps, schema) = parse_meta(&header, &mut warnings);
        assert_eq!(name.as_deref(), Some("t"));
        assert_eq!(desc.as_deref(), Some("d"));
        assert_eq!(deps, vec!["requests".to_string()]);
        assert!(schema
            .get("properties")
            .and_then(|p| p.get("text"))
            .is_some());
        assert!(warnings.is_empty());
    }
}
