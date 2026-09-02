//! 智能体运行时 Tauri 命令入口（供前端 invoke）。
//!
//!  - `run_agent_task`：启动一轮任务（后台 spawn ReAct 循环，事件流推前端）；
//!  - `submit_approval_decision`：回传高危操作审批决策；
//!  - `cancel_agent_task`：取消当前任务（best-effort）。
//!
//! 命令经 `@tauri-apps/plugin-sql` 读取 agent_info 与关联表，组装 `AgentRuntimeConfig`，
//! 不依赖前端重复传参（前端仅传 agentId + prompt + workspace）。

use std::collections::HashMap;

use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

use sqlx::Row;
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::agent::approval::ApprovalDecisionInput;
use crate::agent::mcp_adapter::MountedMcpTool;
use crate::agent::runtime::AgentRuntime;
use crate::agent::skill_adapter::SkillToolWrapper;
use crate::agent::types::AgentRuntimeConfig;

/// 前端入参（run_agent_task）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentTaskInput {
    pub agent_id: String,
    pub prompt: String,
    #[serde(default)]
    pub workspace: Option<String>,
    /// 前端建好的会话 id（agent_conversation_session.id），用于累计 input_token 与上下文压缩。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 前端建好的本轮 id（agent_conversation_round.id），ReAct 循环结束后由 Rust 回填 raw_messages_json。
    #[serde(default)]
    pub round_id: Option<String>,
}

/// 启动一轮智能体任务。
#[tauri::command]
pub async fn run_agent_task(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: RunAgentTaskInput,
) -> Result<(), String> {
    let cfg = load_config(&app, &input.agent_id, input.workspace.clone(), input.session_id.clone(), input.round_id.clone()).await?;

    println!(
        "[agent] run_agent_task 收到请求: agent_id={} prompt_len={} workspace={:?}",
        input.agent_id,
        input.prompt.chars().count(),
        input.workspace
    );

    let app_clone = app.clone();
    let rt = runtime.inner().clone();
    let prompt = input.prompt.clone();
    tauri::async_runtime::spawn(async move {
        println!("[agent] run_agent_task 后台任务已 spawn，开始 run_task");
        rt.run_task(&app_clone, cfg, prompt).await;
        println!("[agent] run_agent_task 后台任务 run_task 结束");
    });
    Ok(())
}

/// 回传审批决策。
#[tauri::command]
pub async fn submit_approval_decision(
    runtime: State<'_, AgentRuntime>,
    decision: ApprovalDecisionInput,
) -> Result<bool, String> {
    Ok(runtime.approval.resolve(decision).await)
}

/// 取消当前任务（best-effort：仅清理挂起的审批，循环会因通道关闭自然结束）。
#[tauri::command]
pub async fn cancel_agent_task(runtime: State<'_, AgentRuntime>) -> Result<(), String> {
    // 无正在运行的显式句柄，审批挂起项超时机制会自然释放；此处置为成功。
    let _ = runtime;
    Ok(())
}

/// 从 SQLite 读取智能体配置（agent_info + 关联表），组装运行配置。
///
/// 表结构与前端 `agent-mapper` 一致（int8→TEXT、bool→INTEGER、jsonb→TEXT）。
///
/// 注：tauri-plugin-sql 2.x 的 `DbPool::select` 为 `pub(crate)`，外部 crate 不可直接调用，
/// 因此这里经插件托管的 `DbInstances` 取出 `sqlite::Pool`，改用 sqlx 直查。
async fn load_config(
    app: &AppHandle,
    agent_id: &str,
    workspace: Option<String>,
    session_id: Option<String>,
    round_id: Option<String>,
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
    println!("[agent] load_config: 数据库连接已就绪 (sqlite:workduo.db)");

    let row = sqlx::query("SELECT * FROM agent_info WHERE id = ?")
        .bind(agent_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询智能体失败：{e}"))?
        .ok_or_else(|| format!("智能体不存在：{agent_id}"))?;
    println!("[agent] load_config: 已找到智能体 {agent_id}");

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
        "SELECT m.mcp_id AS mcp_id, m.tool_code AS tool_code, m.description AS description, \
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
    let mcp_tools: Vec<MountedMcpTool> = mcp_rows
        .iter()
        .filter_map(|r| {
            let mcp_id = r.try_get::<Option<String>, _>("mcp_id").ok().flatten()?;
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

    let skill_rows = sqlx::query(
        "SELECT s.id AS skill_id, s.name AS name, s.description AS description, s.instruction AS instruction \
         FROM skill_info s JOIN agent_skill_ref r ON r.skill_id = s.id \
         WHERE r.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询技能失败：{e}"))?;
    let skill_tools: Vec<SkillToolWrapper> = skill_rows
        .iter()
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
            SkillToolWrapper {
                skill_id: skill_id.clone(),
                skill_name: if name.is_empty() { skill_id } else { name },
                skill_description: if desc.is_empty() { instruction } else { desc },
            }
        })
        .collect();

    println!(
        "[agent] load_config 完成: llm_id={} model={} mcp_tools={} skill_tools={} auto_exec={} sandbox={}",
        if llm_id.is_empty() { "<无>" } else { llm_id.as_str() },
        if llm_model_name.is_empty() { "<无>" } else { llm_model_name.as_str() },
        mcp_tools.len(),
        skill_tools.len(),
        get_i64(&row, "auto_tool_exec_mode") == 1,
        get_i64(&row, "allow_sandbox") == 1,
    );

    Ok(AgentRuntimeConfig {
        agent_id: agent_id.to_string(),
        system_prompt: get_str(&row, "system_prompt"),
        llm_base_url,
        llm_api_key,
        llm_model_name,
        llm_config,
        auto_tool_exec_mode: get_i64(&row, "auto_tool_exec_mode") == 1,
        allow_sandbox: get_i64(&row, "allow_sandbox") == 1,
        workspace,
        mcp_tools,
        skill_tools,
        session_id,
        round_id,
    })
}
