//! 智能体运行配置装配（台账 S3，自 `commands.rs` 抽出）。
//!
//! 职责三段：
//!  1. **DB 读**：agent_info / models / mcp / skill / plugin / kb / host 绑定与全局配置；
//!  2. **能力层装配**：MCP 工具、技能包装、本地插件、沙箱/记忆/审批模式；
//!  3. **提示层组装**：工作空间注入、产物契约、执行环境口径、`.wd_mem` 记忆区、
//!     记忆宫殿召回与知识片段注入。
//!
//! 本文件是业务组装层；`commands.rs` 仅保留 Tauri 接口层（参数解析 + 调用）。
//! 能力层与提示层必须同源（沙箱开关同时决定工具注册与提示声明），改动时两侧一起核对。

use std::collections::HashMap;

use tauri::AppHandle;
use tauri::Manager;

use sqlx::Row;
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::agent::plugins::mcp_adapter::MountedMcpTool;
use crate::agent::plugins::skill_adapter::SkillToolWrapper;
use crate::agent::engine::native::parse_host_allowlist;
use crate::agent::types::MountedUserPlugin;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::knowledge::memory;

/// 运行时单轮能力上限（与前端 draft.ts 创建约束一致）：技能数、MCP 服务数。
/// `@` 临时启用的能力并入后同样受此上限兜底，超出部分按"先绑定后启用"顺序截断。
const MAX_SKILLS: usize = 3;
const MAX_MCP_SERVERS: usize = 3;

/// 从 SQLite 读取智能体配置（agent_info + 关联表），组装运行配置。
///
/// 表结构与前端 `agent-mapper` 一致（int8→TEXT、bool→INTEGER、jsonb→TEXT）。
///
/// 注：tauri-plugin-sql 2.x 的 `DbPool::select` 为 `pub(crate)`，外部 crate 不可直接调用，
/// 因此这里经插件托管的 `DbInstances` 取出 `sqlite::Pool`，改用 sqlx 直查。
pub async fn load_config(
    app: &AppHandle,
    agent_id: &str,
    workspace: Option<String>,
    session_id: Option<String>,
    round_id: Option<String>,
    disabled_skill_ids: Option<Vec<String>>,
    disabled_mcp_ids: Option<Vec<String>>,
    disabled_mcp_tool_ids: Option<Vec<String>>,
    enabled_skill_ids: Option<Vec<String>>,
    enabled_mcp_ids: Option<Vec<String>>,
    disabled_plugin_ids: Option<Vec<String>>,
    enabled_plugin_ids: Option<Vec<String>>,
    attachments: Option<Vec<crate::agent::types::AttachmentInput>>,
    // 本轮用户 prompt（M1 语义召回）：Some 时记忆召回先走向量检索、失败自动落关键词链；
    // None（分支规划/squad 装配等内部调用或无 session 场景）保持 ref_count 序，行为不变。
    prompt: Option<String>,
    // P2-2（2026-09-23）：期望产物清单——非空且绑定 workspace 时注入系统提示（产物契约收尾核对）。
    expected_artifacts: Option<Vec<String>>,
) -> Result<AgentRuntimeConfig, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db），请先在前端 load".to_string())?;
    let pool = match db_pool {
        // 本 crate 仅启用 sqlite 特性，DbPool 仅有 Sqlite 变体
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);
    tracing::info!("[agent] load_config: 数据库连接已就绪 (sqlite:workduo.db)");

    let row = sqlx::query("SELECT * FROM agent_info WHERE id = ?")
        .bind(agent_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询智能体失败：{e}"))?
        .ok_or_else(|| format!("智能体不存在：{agent_id}"))?;
    tracing::info!("[agent] load_config: 已找到智能体 {agent_id}");

    let get_str = |row: &sqlx::sqlite::SqliteRow, col: &str| -> String {
        row.try_get::<Option<String>, _>(col)
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    let get_i64 = |row: &sqlx::sqlite::SqliteRow, col: &str| -> i64 {
        row.try_get::<Option<i64>, _>(col)
            .ok()
            .flatten()
            .unwrap_or(0)
    };

    let llm_id = get_str(&row, "llm_id");
    let (llm_base_url, llm_api_key, llm_model_name, llm_config) = if llm_id.is_empty() {
        (String::new(), String::new(), String::new(), serde_json::Value::Null)
    } else {
        match sqlx::query("SELECT base_url, api_key, model_name, config FROM models WHERE id = ?")
            .bind(&llm_id)
            .fetch_optional(&pool)
            .await
        {
            Ok(Some(m)) => {
                let base = get_str(&m, "base_url");
                let key = get_str(&m, "api_key");
                let name = get_str(&m, "model_name");
                let cfg = get_str(&m, "config");
                let cfg_val = serde_json::from_str::<serde_json::Value>(&cfg)
                    .unwrap_or(serde_json::Value::Null);
                (base, key, name, cfg_val)
            }
            _ => (String::new(), String::new(), String::new(), serde_json::Value::Null),
        }
    };

    let mcp_rows = sqlx::query(
        "SELECT m.id AS tool_def_id, m.mcp_id AS mcp_id, m.tool_code AS tool_code, m.description AS description, \
                i.endpoint_url AS endpoint_url, i.protocol_type AS protocol_type, \
                i.headers AS headers, i.auth_type AS auth_type, i.auth_config AS auth_config \
         FROM mcp_tool_definition m \
         JOIN agent_mcp_ref r ON r.tool_id = m.id \
         JOIN mcp_info i ON i.id = m.mcp_id \
         WHERE r.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询 MCP 工具失败：{e}"))?;
    // 临时禁用：前端按会话内移除的 MCP 服务 / 单个工具 id（均不写库），Rust 侧从工具集剔除。
    let disabled_mcp: std::collections::HashSet<String> =
        disabled_mcp_ids.unwrap_or_default().into_iter().collect();
    let disabled_mcp_tool: std::collections::HashSet<String> =
        disabled_mcp_tool_ids.unwrap_or_default().into_iter().collect();
    let mut mcp_tools: Vec<MountedMcpTool> = mcp_rows
        .iter()
        .filter_map(|r| {
            let tool_def_id = r.try_get::<Option<String>, _>("tool_def_id").ok().flatten()?;
            let mcp_id = r.try_get::<Option<String>, _>("mcp_id").ok().flatten()?;
            // 整服务被临时移除，或单个工具被临时关闭 → 跳过
            if disabled_mcp.contains(&mcp_id) || disabled_mcp_tool.contains(&tool_def_id) {
                return None;
            }
            let tool_code = r.try_get::<Option<String>, _>("tool_code").ok().flatten()?;
            let description = r
                .try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
                .unwrap_or_default();
            // 真实连接信息（来自 mcp_info），运行时透传给 call_mcp_tool。
            let endpoint_url = r
                .try_get::<Option<String>, _>("endpoint_url")
                .ok()
                .flatten()
                .unwrap_or_default();
            let protocol_type = r
                .try_get::<Option<String>, _>("protocol_type")
                .ok()
                .flatten()
                .unwrap_or_else(|| "HTTP".to_string());
            let headers = r
                .try_get::<Option<String>, _>("headers")
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok());
            let auth_type = r.try_get::<Option<String>, _>("auth_type").ok().flatten();
            let auth_config = r
                .try_get::<Option<String>, _>("auth_config")
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            Some(MountedMcpTool {
                mcp_id,
                tool_name: tool_code,
                description,
                endpoint_url,
                protocol_type,
                headers,
                auth_type,
                auth_config,
            })
        })
        .collect();

    // 临时启用（`@` 提及触发）：把「智能体未绑定」的 MCP 服务整体并入工具集。
    // 受 MAX_MCP_SERVERS 兜底；已绑定（mcp_tools 已含）或本轮回禁用的服务/工具跳过。
    if let Some(enabled_mcp) = &enabled_mcp_ids {
        let en_set: std::collections::HashSet<String> = enabled_mcp.iter().cloned().collect();
        if !en_set.is_empty() {
            let ph = en_set.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let q = format!(
                "SELECT m.id AS tool_def_id, m.mcp_id AS mcp_id, m.tool_code AS tool_code, m.description AS description, \
                        i.endpoint_url AS endpoint_url, i.protocol_type AS protocol_type, \
                        i.headers AS headers, i.auth_type AS auth_type, i.auth_config AS auth_config \
                 FROM mcp_tool_definition m JOIN mcp_info i ON i.id = m.mcp_id \
                 WHERE m.mcp_id IN ({})",
                ph
            );
            let mut qb = sqlx::query(&q);
            for id in &en_set {
                qb = qb.bind(id);
            }
            if let Ok(rows) = qb.fetch_all(&pool).await {
                let mut servers: std::collections::HashSet<String> =
                    mcp_tools.iter().map(|t| t.mcp_id.clone()).collect();
                for r in rows {
                    let tool_def_id = r.try_get::<Option<String>, _>("tool_def_id").ok().flatten();
                    let mcp_id = r.try_get::<Option<String>, _>("mcp_id").ok().flatten();
                    let (Some(tool_def_id), Some(mcp_id)) = (tool_def_id, mcp_id) else {
                        continue;
                    };
                    // 整服务被临时移除、单个工具被临时关闭、或该工具已由绑定服务纳入 → 跳过
                    if disabled_mcp.contains(&mcp_id) || disabled_mcp_tool.contains(&tool_def_id) {
                        continue;
                    }
                    if mcp_tools.iter().any(|t| t.mcp_id == mcp_id && t.tool_name == tool_def_id) {
                        continue;
                    }
                    if !servers.contains(&mcp_id) {
                        if servers.len() >= MAX_MCP_SERVERS {
                            continue; // 已达 MCP 服务上限，不再并入新服务
                        }
                        servers.insert(mcp_id.clone());
                    }
                    let tool_code = r.try_get::<Option<String>, _>("tool_code").ok().flatten().unwrap_or_default();
                    if tool_code.is_empty() {
                        continue;
                    }
                    let description = r.try_get::<Option<String>, _>("description").ok().flatten().unwrap_or_default();
                    let endpoint_url = r.try_get::<Option<String>, _>("endpoint_url").ok().flatten().unwrap_or_default();
                    let protocol_type = r.try_get::<Option<String>, _>("protocol_type").ok().flatten().unwrap_or_else(|| "HTTP".to_string());
                    let headers = r.try_get::<Option<String>, _>("headers").ok().flatten().and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok());
                    let auth_type = r.try_get::<Option<String>, _>("auth_type").ok().flatten();
                    let auth_config = r.try_get::<Option<String>, _>("auth_config").ok().flatten().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                    mcp_tools.push(MountedMcpTool {
                        mcp_id,
                        tool_name: tool_code,
                        description,
                        endpoint_url,
                        protocol_type,
                        headers,
                        auth_type,
                        auth_config,
                    });
                }
            }
        }
    }

    let skill_rows = sqlx::query(
        "SELECT s.id AS skill_id, s.name AS name, s.description AS description, s.instruction AS instruction, \
                s.skill_markdown AS skill_markdown, s.path AS skill_path \
         FROM skill_info s JOIN agent_skill_ref r ON r.skill_id = s.id \
         WHERE r.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询技能失败：{e}"))?;
    // 临时禁用：前端按会话内移除的技能 id（不写库），Rust 侧从工具集剔除。
    let disabled: std::collections::HashSet<String> = disabled_skill_ids
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut skill_tools: Vec<SkillToolWrapper> = skill_rows
        .iter()
        .filter(|r| {
            let skill_id = r
                .try_get::<Option<String>, _>("skill_id")
                .ok()
                .flatten()
                .unwrap_or_default();
            !disabled.contains(&skill_id)
        })
        .map(|r| {
            let skill_id = r
                .try_get::<Option<String>, _>("skill_id")
                .ok()
                .flatten()
                .unwrap_or_default();
            let name = r
                .try_get::<Option<String>, _>("name")
                .ok()
                .flatten()
                .unwrap_or_default();
            let desc = r
                .try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
                .unwrap_or_default();
            let instruction = r
                .try_get::<Option<String>, _>("instruction")
                .ok()
                .flatten()
                .unwrap_or_default();
            let skill_markdown = r
                .try_get::<Option<String>, _>("skill_markdown")
                .ok()
                .flatten()
                .unwrap_or_default();
            let skill_path = r
                .try_get::<Option<String>, _>("skill_path")
                .ok()
                .flatten()
                .unwrap_or_default();
            SkillToolWrapper {
                skill_id: skill_id.clone(),
                skill_name: if name.is_empty() { skill_id } else { name },
                skill_description: if desc.is_empty() { instruction } else { desc },
                skill_markdown,
                skill_path,
            }
        })
        .collect();

    // 临时启用（`@` 提及触发）：把「智能体未绑定」的技能临时并入工具集。
    // enabled 优先于 disabled（本轮显式 @ 启用即覆盖临时移除）；受 MAX_SKILLS 兜底。
    if let Some(enabled_skill) = &enabled_skill_ids {
        let en_set: std::collections::HashSet<String> = enabled_skill.iter().cloned().collect();
        if !en_set.is_empty() {
            let ph = en_set.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let q = format!(
                "SELECT id, name, description, instruction, skill_markdown, path FROM skill_info WHERE id IN ({})",
                ph
            );
            let mut qb = sqlx::query(&q);
            for id in &en_set {
                qb = qb.bind(id);
            }
            if let Ok(rows) = qb.fetch_all(&pool).await {
                for r in rows {
                    let sid = r.try_get::<Option<String>, _>("id").ok().flatten().unwrap_or_default();
                    if sid.is_empty() {
                        continue;
                    }
                    // 已绑定（skill_tools 已含）的技能跳过；enabled 覆盖 disabled，故不判 disabled
                    if skill_tools.iter().any(|s| s.skill_id == sid) {
                        continue;
                    }
                    if skill_tools.len() >= MAX_SKILLS {
                        break; // 已达技能上限，不再并入
                    }
                    let name = r.try_get::<Option<String>, _>("name").ok().flatten().unwrap_or_default();
                    let desc = r.try_get::<Option<String>, _>("description").ok().flatten().unwrap_or_default();
                    let instruction = r.try_get::<Option<String>, _>("instruction").ok().flatten().unwrap_or_default();
                    let skill_markdown = r.try_get::<Option<String>, _>("skill_markdown").ok().flatten().unwrap_or_default();
                    let skill_path = r.try_get::<Option<String>, _>("path").ok().flatten().unwrap_or_default();
                    skill_tools.push(SkillToolWrapper {
                        skill_id: sid.clone(),
                        skill_name: if name.is_empty() { sid } else { name },
                        skill_description: if desc.is_empty() { instruction } else { desc },
                        skill_markdown,
                        skill_path,
                    });
                }
            }
        }
    }

    // 沙箱开关：同一个真值源同时决定「能力层注册哪些工具」与「提示层声明哪些能力」。
    // 二者必须同源——否则提示里写「不暴露 execute_command」而工具表里照样注册，
    // 模型以工具表为准，试探后必然绕过沙箱（实测会去找系统 python 甚至 winget 安装）。
    let allow_sandbox = get_i64(&row, "allow_sandbox") == 1;
    // 记忆模式：off=关闭 / active=主动 / forced=强制。存量智能体列缺省回落 off（兼容老数据）。
    let memory_mode = {
        let m = get_str(&row, "memory_mode");
        if m.is_empty() {
            "off".to_string()
        } else {
            m
        }
    };
    let plan_auto_approve_mode = {
        let m = get_str(&row, "plan_auto_approve_mode");
        if m.is_empty() {
            "always".to_string()
        } else {
            m
        }
    };

    // ===== 本地插件装配（P2 纯增量，无插件绑定时 plugin_tools 为空、行为不变） =====
    // 过滤条件（设计稿 §6.3）：ref.is_active=1 AND tool.enabled=1 AND agent.allow_sandbox=1；
    // disabled_plugin_ids 仅会话内临时剔除（对齐 disabled_skill_ids 语义），不写库。
    let mut plugin_tools: Vec<MountedUserPlugin> = Vec::new();
    if allow_sandbox {
        let plugin_rows = sqlx::query(
            "SELECT p.id AS plugin_id, p.identifier AS identifier, p.name AS name, \
                    p.description AS description, p.runtime AS runtime, \
                    p.script_content AS script_content, p.parameters_schema AS parameters_schema, \
                    p.timeout_sec AS timeout_sec \
             FROM user_plugin_tool p JOIN agent_plugin_ref r ON r.plugin_id = p.id \
             WHERE r.agent_id = ? AND r.is_active = 1 AND p.enabled = 1",
        )
        .bind(agent_id)
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
        let disabled_plugins: std::collections::HashSet<String> = disabled_plugin_ids
            .unwrap_or_default()
            .into_iter()
            .collect();
        for r in &plugin_rows {
            let plugin_id = r
                .try_get::<Option<String>, _>("plugin_id")
                .ok()
                .flatten()
                .unwrap_or_default();
            let identifier = r
                .try_get::<Option<String>, _>("identifier")
                .ok()
                .flatten()
                .unwrap_or_default();
            if plugin_id.is_empty() || identifier.is_empty() {
                continue;
            }
            // 会话内临时禁用：插件 id 或工具标识符命中均可
            if disabled_plugins.contains(&plugin_id) || disabled_plugins.contains(&identifier) {
                continue;
            }
            let runtime = r
                .try_get::<Option<String>, _>("runtime")
                .ok()
                .flatten()
                .unwrap_or_default();
            if runtime != "python" && runtime != "bun" {
                continue; // 未知运行时兜底跳过（adapter 处还有一层防御）
            }
            let script_content = r
                .try_get::<Option<String>, _>("script_content")
                .ok()
                .flatten()
                .unwrap_or_default();
            if script_content.trim().is_empty() {
                continue; // 无脚本内容的插件无法执行
            }
            let schema_raw = r
                .try_get::<Option<String>, _>("parameters_schema")
                .ok()
                .flatten()
                .unwrap_or_default();
            let parameters_schema = serde_json::from_str::<serde_json::Value>(&schema_raw)
                .unwrap_or_else(|_| serde_json::json!({"type": "object", "properties": {}}));
            let timeout_sec = r
                .try_get::<Option<i64>, _>("timeout_sec")
                .ok()
                .flatten()
                .unwrap_or(60)
                .clamp(1, 300) as u64;
            let name = r
                .try_get::<Option<String>, _>("name")
                .ok()
                .flatten()
                .unwrap_or_else(|| identifier.clone());
            let description = r
                .try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
                .unwrap_or_default();
            plugin_tools.push(MountedUserPlugin {
                plugin_id,
                identifier,
                name,
                description,
                runtime,
                script_content,
                parameters_schema,
                timeout_sec,
            });
        }

        // `@` 提及临时并入（P2 纯增量，语义对齐 enabled_skill_ids）：把「智能体未绑定」
        // 的插件临时并入工具集；allow_sandbox 前置条件同样适用；受 10 个上限兜底
        // （与前端 draft.MAX_PLUGINS 一致）。
        if let Some(enabled_plugin) = &enabled_plugin_ids {
            let en_set: std::collections::HashSet<String> =
                enabled_plugin.iter().cloned().collect();
            if !en_set.is_empty() {
                let bound_ids: std::collections::HashSet<String> = plugin_tools
                    .iter()
                    .map(|p| p.plugin_id.clone())
                    .collect();
                let pending: Vec<String> = en_set
                    .iter()
                    .filter(|id| !bound_ids.contains(*id))
                    .cloned()
                    .collect();
                if !pending.is_empty() {
                    let ph = pending.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                    let q = format!(
                        "SELECT id, identifier, name, description, runtime, script_content, \
                         parameters_schema, timeout_sec FROM user_plugin_tool WHERE id IN ({ph})"
                    );
                    let mut qb = sqlx::query(&q);
                    for id in &pending {
                        qb = qb.bind(id);
                    }
                    if let Ok(rows) = qb.fetch_all(&pool).await {
                        for r in &rows {
                            if plugin_tools.len() >= 10 {
                                break; // MAX_PLUGINS 兜底（与前端 draft.MAX_PLUGINS 一致）
                            }
                            let plugin_id = r
                                .try_get::<Option<String>, _>("id")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            let identifier = r
                                .try_get::<Option<String>, _>("identifier")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            if plugin_id.is_empty() || identifier.is_empty() {
                                continue;
                            }
                            if plugin_tools.iter().any(|p| p.plugin_id == plugin_id) {
                                continue; // 已绑定，去重
                            }
                            let runtime = r
                                .try_get::<Option<String>, _>("runtime")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            if runtime != "python" && runtime != "bun" {
                                continue;
                            }
                            let script_content = r
                                .try_get::<Option<String>, _>("script_content")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            if script_content.trim().is_empty() {
                                continue;
                            }
                            let schema_raw = r
                                .try_get::<Option<String>, _>("parameters_schema")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            let parameters_schema =
                                serde_json::from_str::<serde_json::Value>(&schema_raw)
                                    .unwrap_or_else(|_| {
                                        serde_json::json!({"type": "object", "properties": {}})
                                    });
                            let timeout_sec = r
                                .try_get::<Option<i64>, _>("timeout_sec")
                                .ok()
                                .flatten()
                                .unwrap_or(60)
                                .clamp(1, 300) as u64;
                            let name = r
                                .try_get::<Option<String>, _>("name")
                                .ok()
                                .flatten()
                                .unwrap_or_else(|| identifier.clone());
                            let description = r
                                .try_get::<Option<String>, _>("description")
                                .ok()
                                .flatten()
                                .unwrap_or_default();
                            plugin_tools.push(MountedUserPlugin {
                                plugin_id,
                                identifier,
                                name,
                                description,
                                runtime,
                                script_content,
                                parameters_schema,
                                timeout_sec,
                            });
                        }
                    }
                }
            }
        }
    } else {
        // 沙箱未开启：设计稿 §5.1「Agent 必须 allow_sandbox=1 才注册插件工具」——
        // 保持 plugin_tools 为空（向导保存时已有前端强提示，此处运行时兜底不加载）。
        let _ = disabled_plugin_ids;
    }

    tracing::info!(
        "[agent] load_config 完成: llm_id={} model={} mcp_tools={} skill_tools={} plugins={} auto_exec={} sandbox={} system_prompt={}字符 附件数={}",
        if llm_id.is_empty() { "<无>" } else { llm_id.as_str() },
        if llm_model_name.is_empty() { "<无>" } else { llm_model_name.as_str() },
        mcp_tools.len(),
        skill_tools.len(),
        plugin_tools.len(),
        get_i64(&row, "auto_tool_exec_mode") == 1,
        allow_sandbox,
        get_str(&row, "system_prompt").chars().count(),
        attachments.as_ref().map(|a| a.len()).unwrap_or(0),
    );

    let mut system_prompt = get_str(&row, "system_prompt");
    // 把真实工作空间路径注入系统提示：避免 LLM 猜测 `/workspace` 等虚拟路径，
    // 导致原生工具（写文件 / 跑 Python / 列目录）路径越界。
    if let Some(ws) = &workspace {
        if !ws.trim().is_empty() {
            let ws_trim = ws.trim();
            system_prompt.push_str(&format!(
                "\n\n### 工作环境\n你当前的工作空间目录为：{}\n所有文件读写、Python 脚本执行、命令执行都必须在此目录或其子目录内进行。请使用相对于该目录的路径（如 `script.py`）或该目录下的绝对路径来指定文件位置，不要使用 `/workspace` 等虚拟路径。",
                ws_trim
            ));
            // P2-2（2026-09-23）：期望产物注入——L2 实测三个用例「做了 90% 的活但不落盘最终产物」。
            // 在系统提示里放一张收尾核对清单：文件名逐字一致、先落盘再总结。
            if let Some(arts) = &expected_artifacts {
                let items: Vec<&String> = arts.iter().filter(|a| !a.trim().is_empty()).collect();
                if !items.is_empty() {
                    system_prompt.push_str("\n\n### 产物契约（收尾前逐项核对，缺一不可）\n任务最终必须产出以下文件（相对工作空间路径，文件名逐字一致）：\n");
                    for a in &items {
                        system_prompt.push_str(&format!("- {}\n", a));
                    }
                    system_prompt.push_str("收尾规则：先落盘全部产物文件，再输出文字总结；只写总结不落盘 = 任务失败。中间产物（原始数据/草稿）不能替代以上清单。\n");
                }
            }
            // 执行环境提示必须与「能力层实际注册的工具」保持一致（同源）：
            // - 沙箱开启：execute_command 未注册，只能走 native__run_python_sandbox；
            //   此时若仍教模型 cmd/sh 语法，等于诱导它去调一个根本不存在的工具，
            //   模型转而自寻出路（实测：找系统 python、winget 安装 Python）脱离沙箱。
            // - 沙箱关闭：才注入宿主 shell 的语法约定。
            if allow_sandbox {
                system_prompt.push_str(
                    "\n\n### 执行环境（沙箱模式）\n本任务运行在**隔离沙箱**中，宿主 shell 命令工具（execute_command）未对你开放。\
\n运行任何 Python 代码的唯一正确方式：\
\n1. 先用 `native__write_file` 把 .py 脚本写入工作空间（建议放 `.wd_mem/scripts/`，便于复用）；\
\n2. 再调用 `native__run_python_sandbox` 并传入该脚本的绝对路径执行（默认环境 `default`）。\
\n运行任何 JavaScript / TypeScript 代码（如前端脚本、轻量数据处理、API 调用），用 `native__run_node_sandbox` 传入代码或脚本绝对路径即可（默认环境 `default`）。\
\n**严禁**：\
\n- 不要尝试调用系统 `python` / `python3` / `node` / `bun`，不要用 `where python`、`python --version`、`node -v` 探测本机运行时；\
\n- 绝对禁止用 winget / choco / brew / apt 安装系统级 Python / Node 或任何系统软件——这会脱离沙箱并污染用户本机环境；\
\n- 沙箱缺少第三方库（Python 的 pandas / Node 的 axios 等）时先 import / require 确认，确实缺失则如实告知用户，切勿自行安装系统级包。",
                );
            } else if cfg!(target_os = "windows") {
                system_prompt.push_str(
                    "\n\n### 命令执行环境\n本机为 Windows，命令经 `cmd.exe /C` 执行（**不是** bash/PowerShell）。\
请勿使用 `tail`/`cat`/`grep`/`head`/`wc` 等 Unix 专用命令，也不要依赖 `|` 管道做文本截取；\
需要文本处理请用纯 Python 脚本或 PowerShell 语法。安装 Python 依赖用 `pip install <包名>`，不要带 `| tail` 之类后缀。",
                );
            } else {
                system_prompt.push_str(
                    "\n\n### 命令执行环境\n本机为类 Unix 系统，命令经 `sh -c` 执行，可使用标准 Unix 管道与命令。",
                );
            }
            // .wd_mem 记忆与素材区：确保结构就绪，并注入复用清单与约定。
            match crate::agent::knowledge::wd_mem::ensure_wd_mem(ws_trim) {
                Ok(_) => {
                    system_prompt.push_str(&format!(
                        "\n\n### 工作空间记忆区 `.wd_mem/`（已就绪，位于 {}/.wd_mem）\n\
这是本工作空间的专属记忆与素材库，由你在上次运行中沉淀，本次应优先复用其中的素材、避免重复生成：\n\
- `scripts/`：可复用的自动化脚本（Python/Shell 等）——**再跑同类任务前，先检查这里是否已有可用脚本，有则直接复用或小幅改写，不要从零重写**。\n\
- `data/`：抓取/计算的中间数据（CSV/JSON 等）——已有则优先读取复用，避免重复联网获取。\n\
                    - `outputs/`：最终产物的归档副本（可选）。\n\
- `MEMORY.md`：项目长期全局记忆（架构/避坑/用户偏好），全量注入系统提示，你可直接读取/编辑。\n\
- `artifacts/`：你完成复杂任务后主动沉淀的设计蓝图（用 `native__archive_artifact` 写入）。\n\
约定：**新生成的、值得保留的脚本请写入 `scripts/`；中间数据写入 `data/`；不要把临时/一次性脚本散落在工作空间根目录**，以免污染用户目录。**最终交付物**仍放在工作空间根目录或用户指定位置。\n\
🔴 **红线：`.wd_mem/` 是内部记忆区，路径绝不许出现在面向用户的产物与回复中**——README/报告/代码注释等产物里需要说明脚本或数据来源时，用「记忆区/已复用脚本/内部数据」等中性表述代替 `.wd_mem/...` 字面路径（你自己在运行期可以读写该区，但用户可见的文本不得暴露它）。",
                        ws_trim
                    ));
                    // [双轨记忆 Slot 0] 树状索引（artifacts/sessions/scripts/data，仅首行标题，绝不读正文）+ 自主发现指令。
                    if let Some(index) = crate::agent::knowledge::wd_mem::build_tree_index(ws_trim) {
                        system_prompt.push_str(&format!(
                            "\n\n{}\n\n> The `artifacts/`, `sessions/` and `scripts/` directories under `.wd_mem/` contain historical designs and bug-fixing records. You MUST use the `native__read_file` tool to inspect specific files before proceeding if the user's request relates to these modules.",
                            index
                        ));
                    }
                    // [双轨记忆 Slot 0] 长期全局记忆 MEMORY.md（规范命名；兼容旧 project_memory.md 回退）。
                    if let Some(mem) = crate::agent::knowledge::wd_mem::read_project_memory(ws_trim) {
                        if !mem.trim().is_empty() {
                            system_prompt.push_str(&format!(
                                "\n\n### 项目长期记忆（.wd_mem/MEMORY.md）\n{}",
                                mem
                            ));
                        }
                    }
                    // [固化闭环] 长期记忆主动沉淀指令：完成实质性任务后主动归档 artifacts/。
                    system_prompt.push_str("\n\n### 长期记忆固化闭环（Long-term Memory Consolidation）\n\
完成一个实质性的功能模块开发或深度 Bug 修复后，若本次任务沉淀了值得长期复用的「设计蓝图 / 架构约定 / 避坑法则」，请主动调用 `native__archive_artifact` 将其写入 `.wd_mem/artifacts/`（文件名用 kebab-case，如 `auth-flow.md`）。\
若你不确定是否值得归档，请直接向用户提问：「本次任务涉及的核心设计是否需要提炼并归档至 `.wd_mem/artifacts/` 作为永久知识资产？」——得到确认后再写入。日常闲聊或微小改动无需归档。");
                    tracing::info!("[agent] load_config: 已确保 .wd_mem 结构并注入复用清单 workspace={}", ws_trim);
                }
                Err(e) => {
                    tracing::info!("[agent] load_config: 创建 .wd_mem 失败（降级为不使用记忆区）：{e}");
                }
            }
        }
    }

    // 本地插件使用规则（P2 纯增量）：仅在确有插件挂载时追加，无插件时系统提示不变。
    if !plugin_tools.is_empty() {
        let plugin_list = plugin_tools
            .iter()
            .map(|p| format!("- `custom__{}`：{}", p.identifier, p.description))
            .collect::<Vec<_>>()
            .join("\n");
        system_prompt.push_str(&format!(
            "\n\n### 本地插件工具（custom__ 前缀）\n已为你可以调用以下本地插件工具：\n{plugin_list}\n\
调用规则：\n\
1. 仅当任务与插件描述匹配时调用，传参必须严格符合该工具的 JSON Schema；\n\
2. 禁止伪造不存在的 custom__ 工具名，禁止猜测未列出的插件；\n\
3. 插件在你的沙箱内执行，缺依赖会自动安装并重试一次；调用即视为执行用户本机代码，结果以工具返回为准。"
        ));
    }

    // 记忆宫殿：自动召回 top-K 记忆注入系统提示（引用计数随运行累计，驱动热力图）。
    // 仅在真实任务运行（有 session_id）且记忆模式非 off 时召回；off 模式不读记忆库。
    // M1：传本轮 prompt——嵌入已配置时先走向量语义召回，失败/未配置自动落关键词降级链。
    if session_id.is_some() && memory_mode != "off" {
        let (recalled, block) =
            memory::recall_top_memories(app, Some(agent_id), memory::recall_top(), prompt.as_deref())
                .await;
        if !block.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&block);
            tracing::info!(
                "[agent] load_config: 已自动召回 {} 条记忆注入系统提示",
                recalled.len()
            );
        }

        // 主动 / 强制模式：在 system_prompt 注入「记忆沉淀引导」，提示模型用原生工具 native__anchor_memory
        // 沉淀可跨会话复用的信息。off 模式不注入（且 anchor 工具未注册），记忆能力整体关闭。
        // 注意：这只是提示层引导，强制档的确定性沉淀由 pipeline 末置步骤引擎级落地（见 runtime.rs）。
        if memory_mode == "active" || memory_mode == "forced" {
            system_prompt.push_str(
                "\n\n### 长期记忆锚定（原生工具 native__anchor_memory）\n\
你拥有原生工具 `native__anchor_memory(key, content, category)`。当本次对话涌现**可跨会话复用**的稳定信息时，主动调用它沉淀为长期记忆，使未来同智能体会话能自动召回：\n\
① 用户明确表达的偏好或约束；② 已确认的技术决策 / 架构约定；③ 踩过的坑与规避方式；④ 可复用代码 / 脚本模式。\n\
请勿锚定：一次性任务步骤、临时草稿、当轮琐碎状态。记忆按 (agent_id, key) 去重，可放心重复沉淀。\n\
category 取值：decision（决策）/ code_pattern（代码模式）/ user_pref（用户偏好）/ architecture（架构）/ fix（避坑）/ other（其他）。",
            );
        }
    }

    // L2 项目知识片段注入（#20260918006）：按本轮 prompt 向量检索 .wd_mem/artifacts
    // 分节片段 top-k（隔离键 = 工作空间路径，同工程多 agent 共享）。与「文件名清单 +
    // MEMORY.md 全量注入」既有通道叠加；嵌入未配置 / 无命中 / 检索失败 = 静默跳过，
    // 绝不阻断任务启动。与记忆宫殿解耦：off 模式仍注入（知识资产 ≠ agent 记忆）。
    if session_id.is_some() {
        if let Some(ws) = workspace.as_deref() {
            if let Some(pr) = prompt.as_deref() {
                if !pr.trim().is_empty() {
                    match crate::agent::artifact::artifact_index::recall_artifact_snippets(
                        app, &pool, ws, pr, crate::agent::artifact::artifact_index::RECALL_SNIPPET_TOP_K,
                    )
                    .await
                    {
                        Ok(block) if !block.is_empty() => {
                            system_prompt.push_str("\n\n");
                            system_prompt.push_str(&block);
                            tracing::info!(
                                "[agent] load_config: 已注入 .wd_mem/artifacts 相关知识片段"
                            );
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::info!("[agent] load_config: artifacts 片段检索跳过：{e}")
                        }
                    }
                }
            }
        }
    }

    // HTTP 请求主机白名单（app_config.http_allowed_hosts）：空 = 不限制；非空 = 仅允许命中主机（含子域）。
    let http_allowed_hosts = {
        let row = sqlx::query("SELECT value FROM app_config WHERE key = 'http_allowed_hosts'")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
        match row {
            Some(r) => {
                let raw = r
                    .try_get::<Option<String>, _>("value")
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                parse_host_allowlist(&raw)
            }
            None => Vec::new(),
        }
    };

    // ===== 知识库绑定装配（K2 第四期）：绑定关系驱动 native__kb_search 注册与 planner 大纲 =====
    let kb_ids: Vec<String> = sqlx::query("SELECT kb_id FROM agent_kb_ref WHERE agent_id = ? ORDER BY created_at ASC")
        .bind(agent_id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("查询知识库绑定失败：{e}"))?
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>("kb_id").ok().flatten())
        .collect();

    // 服务器托管（Host）：绑定档案 + 过期 host_grant GC（设计稿 .workspace/.future/服务器托管/server-hosting-design.md）
    let server_bindings = crate::host::types::load_bindings(app, agent_id).await?;
    if !server_bindings.is_empty() {
        crate::host::authz::gc_expired(app).await;
    }

    // 图片生成能力开关（image 模型大类）：已配置启用 → 注册 native__generate_image 并进大纲
    //（提示与能力同源）。每 run 查询一次，模型增删即时生效。
    let image_gen_enabled = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM models WHERE category = 'image' AND enabled = 1 LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("查询图片生成模型失败：{e}"))?
    .is_some();

    Ok(AgentRuntimeConfig {
        agent_id: agent_id.to_string(),
        system_prompt,
        llm_base_url,
        llm_api_key,
        llm_model_name,
        llm_config,
        auto_tool_exec_mode: get_i64(&row, "auto_tool_exec_mode") == 1,
        allow_sandbox: get_i64(&row, "allow_sandbox") == 1,
        memory_mode,
        plan_auto_approve_mode,
        workspace,
        mcp_tools,
        skill_tools,
        session_id,
        round_id,
        attachments: attachments.unwrap_or_default(),
        http_allowed_hosts,
        network_proxy: crate::net::load_network_proxy(&pool).await,
        plugin_tools,
        kb_ids,
        server_bindings,
        image_gen_enabled,
    })
}
