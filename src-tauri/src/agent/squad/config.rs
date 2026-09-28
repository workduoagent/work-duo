//! 小分队运行配置装配（台账 S3，自 `commands.rs` 抽出）。
//!
//! 职责：读取 squad 定义 + 成员任职 + 群聊配置，对每个成员调用
//! `engine::config_loader::load_config` 组装 base `AgentRuntimeConfig`
//! （复用全部现有能力层装配），再注入成员人设与团队黑板记忆。
//!
//! `commands.rs` 的 `run_squad_task` / `squad_api_server` / `squad_scheduler`
//! 是本模块的三个消费入口（接口层）。

use tauri::AppHandle;
use tauri::Manager;

use sqlx::Row;
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::agent::engine::config_loader::load_config;
use crate::agent::types::{
    SquadChatConfig, SquadMemberConfig, SquadRunStrategy, SquadRuntimeConfig,
};

/// 加载一个小分队的完整运行配置：读取 squad 定义 + 成员任职 + 群聊配置，
/// 对每个成员调用 `load_config` 组装 base AgentRuntimeConfig（复用全部现有能力层装配），
/// 再把 `persona_override` 追加到该成员的 `system_prompt` 末尾（人设注入，不污染 base agent 库），
/// 并由 `global_mcp_ids` 强制并入成员的 MCP 工具集。
///
/// 返回的 `SquadRuntimeConfig` 供 Phase 3-5 的协作引擎（orchestrator / pipeline / chat）消费。
/// `workspace` 读取自 agent_squad.workspace_dir（用户自选产物根目录，可空）：
/// 运行期据此派生成员私有 workspace（{workspace}/{agent_id}，有值）或回退默认
/// `.wd_mem/squads/{squad_id}/{agent_id}/`。详见 squad_orchestrator::squad_member_workspace。
pub async fn load_squad(app: &AppHandle, squad_id: &str) -> Result<SquadRuntimeConfig, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db），请先在前端 load".to_string())?;
    let pool = match db_pool {
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);

    let squad = sqlx::query("SELECT * FROM agent_squad WHERE id = ?")
        .bind(squad_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("查询小分队失败：{e}"))?
        .ok_or_else(|| format!("小分队不存在：{squad_id}"))?;

    let get_str = |row: &sqlx::sqlite::SqliteRow, col: &str| -> String {
        row.try_get::<Option<String>, _>(col).ok().flatten().unwrap_or_default()
    };
    let get_i64 = |row: &sqlx::sqlite::SqliteRow, col: &str| -> i64 {
        row.try_get::<Option<i64>, _>(col).ok().flatten().unwrap_or(0)
    };

    let name = get_str(&squad, "name");
    let mode = get_str(&squad, "mode");
    let leader_agent_id = {
        let l = get_str(&squad, "leader_agent_id");
        if l.is_empty() {
            None
        } else {
            Some(l)
        }
    };
    let global_mcp_ids: Vec<String> =
        serde_json::from_str(&get_str(&squad, "global_mcp_ids")).unwrap_or_default();
    // 全局 MCP 工具级开关：{ [mcpId]: 被禁用工具 id[] }，合并为运行期禁用集合。
    let global_mcp_tools: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(&get_str(&squad, "global_mcp_tools")).unwrap_or_default();
    let disabled_mcp_tool_ids: Vec<String> = global_mcp_tools.values().flatten().cloned().collect();
    let workspace_dir = {
        let w = get_str(&squad, "workspace_dir");
        if w.trim().is_empty() {
            None
        } else {
            Some(w)
        }
    };
    let run_strategy: SquadRunStrategy = serde_json::from_str(&get_str(&squad, "run_strategy"))
        .unwrap_or_else(|_| SquadRunStrategy {
            execution_mode: "manual".to_string(),
            schedule_cron: None,
            retry_count: 3,
            schedule_prompt: None,
            budget_tokens: 0,
        });

    // 成员任职：按 pipeline_order 升序（无序号者排前），保证流水线模式工序顺序稳定。
    let member_rows = sqlx::query(
        "SELECT * FROM agent_squad_member WHERE squad_id = ? ORDER BY \
         CASE WHEN pipeline_order IS NULL THEN 0 ELSE 1 END, pipeline_order ASC, created_at ASC",
    )
    .bind(squad_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询小分队成员失败：{e}"))?;

    let mut members: Vec<SquadMemberConfig> = Vec::new();
    for m in &member_rows {
        let agent_id = get_str(m, "agent_id");
        if agent_id.is_empty() {
            continue;
        }
        // 复用 load_config 组装 base AgentRuntimeConfig（全局 MCP 强制并入成员工具集）。
        let mut base = load_config(
            app,
            &agent_id,
            None, // workspace：运行期派生私有 workspace 后覆盖
            None, // session_id
            None, // round_id
            None, // disabled_skill_ids
            None, // disabled_mcp_ids
            if disabled_mcp_tool_ids.is_empty() {
                None
            } else {
                Some(disabled_mcp_tool_ids.clone())
            }, // disabled_mcp_tool_ids
            None, // enabled_skill_ids
            if global_mcp_ids.is_empty() {
                None
            } else {
                Some(global_mcp_ids.clone())
            },
            None, // disabled_plugin_ids
            None, // enabled_plugin_ids
            None, // attachments
            None, // prompt：squad 装配无 session，记忆召回保持 ref_count 序
            None, // expected_artifacts：squad 装配无产物核对
        )
        .await?;

        // 人设注入：追加到 system_prompt 末尾（不污染 base agent 库）。
        let persona_override = get_str(m, "persona_override");
        if !persona_override.trim().is_empty() {
            base.system_prompt
                .push_str("\n\n### 你的角色设定（Squad 定制）\n");
            base.system_prompt.push_str(persona_override.trim());
        }

        // 团队黑板记忆召回：注入本小分队共享 + 该成员个人的历史记忆（top-K，按引用热度）。
        let mem_block = load_squad_memory_block(&pool, squad_id, &agent_id).await;
        if !mem_block.is_empty() {
            base.system_prompt.push_str("\n\n");
            base.system_prompt.push_str(&mem_block);
        }

        let role = get_str(m, "role");
        let is_leader = get_i64(m, "is_leader") == 1;
        let pipeline_order = {
            let po = get_i64(m, "pipeline_order");
            if po <= 0 {
                None
            } else {
                Some(po as usize)
            }
        };
        let depends_on: Vec<String> = serde_json::from_str(&get_str(m, "depends_on"))
            .unwrap_or_default();
        members.push(SquadMemberConfig {
            agent: base,
            role,
            persona_override,
            pipeline_order,
            depends_on,
            is_leader,
        });
    }

    if members.is_empty() {
        return Err(format!("小分队 {squad_id} 未配置任何成员智能体"));
    }

    // 群聊配置（可选；缺省 max_rounds=8、无单独汇总主笔）。
    let chat_config =
        match sqlx::query("SELECT * FROM agent_squad_chat_config WHERE squad_id = ?")
            .bind(squad_id)
            .fetch_optional(&pool)
            .await
        {
            Ok(Some(c)) => SquadChatConfig {
                max_rounds: {
                    let n = get_i64(&c, "max_rounds");
                    if n <= 0 {
                        8
                    } else {
                        n as usize
                    }
                },
                summarizer_agent_id: {
                    let s = get_str(&c, "summarizer_agent_id");
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                },
            },
            _ => SquadChatConfig {
                max_rounds: 8,
                summarizer_agent_id: None,
            },
        };

    tracing::info!(
        "[agent] load_squad: 已加载小分队 {} 模式={} 成员数={} 全局MCP={}",
        squad_id,
        mode,
        members.len(),
        global_mcp_ids.len()
    );

    Ok(SquadRuntimeConfig {
        squad_id: squad_id.to_string(),
        name,
        mode,
        leader_agent_id,
        global_mcp_ids,
        run_strategy,
        members,
        chat_config,
        workspace: workspace_dir,
    })
}

/// 召回小分队级共享记忆（agent_squad_memory 中 agent_id IS NULL）与指定成员个人记忆
/// （agent_id = 该成员），拼成系统提示注入块；同时累加 ref_count + 更新 last_recalled
/// （驱动记忆热力图）。无记忆时返回空串（调用方据此跳过注入）。
async fn load_squad_memory_block(
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    agent_id: &str,
) -> String {
    let rows = sqlx::query(
        "SELECT id, key, content, category FROM agent_squad_memory \
         WHERE squad_id = ? AND (agent_id IS NULL OR agent_id = ?) \
         ORDER BY ref_count DESC LIMIT 5",
    )
    .bind(squad_id)
    .bind(agent_id)
    .fetch_all(pool)
    .await;

    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[agent] load_squad_memory_block: 查询失败：{e}");
            return String::new();
        }
    };
    if rows.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for r in &rows {
        let key: String = r.try_get("key").unwrap_or_default();
        let content: String = r.try_get("content").unwrap_or_default();
        let category: String = r.try_get("category").unwrap_or_default();
        let id: String = r.try_get("id").unwrap_or_default();
        lines.push(format!("- [{}] {}: {}", category, key, content));
        ids.push(id);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    for id in &ids {
        let _ = sqlx::query(
            "UPDATE agent_squad_memory SET ref_count = ref_count + 1, last_recalled = ? WHERE id = ?",
        )
        .bind(now)
        .bind(id)
        .execute(pool)
        .await;
    }

    format!(
        "## 团队记忆（Squad 黑板召回）\n以下是本小分队共享及你的个人历史记忆，供你参考：\n{}\n",
        lines.join("\n")
    )
}
