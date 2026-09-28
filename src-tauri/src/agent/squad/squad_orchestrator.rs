//! 小分队协作引擎（Phase 3-5 共用）。
//!
//! 编排式（orchestrator）：主管智能体（leader）把任务拆解成子任务、委派给成员智能体，
//! 每个成员以独立 `AgentRuntimeConfig` 运行（各自 LLM / MCP / Skill / 记忆 / 沙箱），
//! 成员间靠「产物文本」单向传递上下文，最后由 leader 汇总。
//! 流水线 / 群聊模式在 Phase 4 / Phase 5 复用并扩展本文件的运行骨架。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

/// S0-4a：squad 会话 id 进程内序号（叠加纳秒时间戳，进程内严格唯一）。
static SQUAD_SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

/// S0-4d（2026-09-28）：per-session metrics 累加器（tokens/wall/memberStats 最小集）。
/// 注册表模式同 SQUAD_CANCELS：run_squad_task 注册（session_id 键），终态落 metrics round
/// 后移除；编排侧 call_llm 与成员 pipeline 双源累加。落库形态：round 表 kind='metrics' 行，
/// content = JSON（零 DDL 变更，前端按 kind 过滤或忽略）。
#[derive(serde::Serialize)]
struct SquadMemberStat {
    agent_id: String,
    role: String,
    prompt_tokens: u64,
    completion_tokens: u64,
    wall_ms: u64,
}
#[derive(Default, serde::Serialize)]
struct SquadMetricsAcc {
    prompt_tokens: u64,
    completion_tokens: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    members: Vec<SquadMemberStat>,
}
static SQUAD_METRICS: std::sync::Mutex<Option<std::collections::HashMap<String, SquadMetricsAcc>>> =
    std::sync::Mutex::new(None);

fn squad_metrics_add_usage(session_id: &str, usage: (u64, u64)) {
    if usage.0 == 0 && usage.1 == 0 {
        return;
    }
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        let acc = map.entry(session_id.to_string()).or_default();
        acc.prompt_tokens += usage.0;
        acc.completion_tokens += usage.1;
    }
}
fn squad_metrics_add_member(session_id: &str, stat: SquadMemberStat) {
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        map.entry(session_id.to_string()).or_default().members.push(stat);
    }
}
async fn write_metrics_round(app: &AppHandle, pool: &sqlx::SqlitePool, squad_id: &str, session_id: &str) {
    let Some(acc) = squad_metrics_take(session_id) else { return };
    if acc.prompt_tokens == 0 && acc.completion_tokens == 0 && acc.members.is_empty() {
        return;
    }
    let payload = serde_json::to_string(&acc).unwrap_or_default();
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '系统', ?, 'metrics', ?)")
    .bind(format!("sqr_{}", now_ms()))
    .bind(squad_id)
    .bind(session_id)
    .bind(&payload)
    .bind(now_ms())
    .execute(pool)
    .await;
    tracing::info!("[squad] 会话 {session_id} metrics 已落盘（prompt={} completion={} members={}）", acc.prompt_tokens, acc.completion_tokens, acc.members.len());
}

fn squad_metrics_take(session_id: &str) -> Option<SquadMetricsAcc> {
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    g.as_mut().and_then(|map| map.remove(session_id))
}

use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;

use crate::agent::hitl::approval::ApprovalManager;
use crate::agent::events;
use crate::agent::plugins::mcp_adapter;
use crate::agent::engine::native;
use crate::agent::engine::planner;
use crate::agent::engine::pipeline;
use crate::agent::engine::graph::KnowledgeGraph;
use crate::agent::engine::llm::extract_llm_content;
use crate::agent::hitl::recovery::RecoveryHub;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::SquadMemberConfig;
use crate::agent::types::SquadRuntimeConfig;

/// squad 级取消注册表：session_id → (squad_id, 取消标志)。
///
/// run_squad_task 建会话后注册（SquadCancelGuard Drop 时回收），cancel_squad_sessions
/// 按 squad_id 置位——成员 pipeline / build_plan / 编排侧 call_llm 三层共用同一标志，
/// 取消在调用级（≤180s）与节点级（检测点即时）生效。
static SQUAD_CANCELS: std::sync::Mutex<Option<std::collections::HashMap<String, (String, std::sync::Arc<AtomicBool>)>>> =
    std::sync::Mutex::new(None);

/// Drop 守卫：任务任意出口（正常 / 取消 / 失败）自动从注册表移除，不残留孤儿标志。
struct SquadCancelGuard(String);
impl Drop for SquadCancelGuard {
    fn drop(&mut self) {
        let mut g = SQUAD_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = g.as_mut() {
            {
                map.remove(&self.0);
            }
        }
        // S0-4d 兜底：正常路径终态已 take 并落 metrics round；异常路径（panic/提前 return）
        // 残留的累加器在此清理，防跨 run 串账。
        let mut m = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = m.as_mut() {
            map.remove(&self.0);
        }
    }
}

/// 取消指定小分队的全部活跃会话（S0-3 取消穿线对外入口，cancel_squad_task 命令调用）。
/// 返回置位的活跃会话数。
pub fn cancel_squad_sessions(squad_id: &str) -> usize {
    let mut cancelled = 0usize;
    let mut g = SQUAD_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        {
            for (sid, (sq, flag)) in map.iter() {
                if sq == squad_id {
                    flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    tracing::info!("[squad] 取消信号已置位：session={sid} squad={squad_id}");
                    cancelled += 1;
                }
            }
        }
    }
    cancelled
}

/// 统一收尾：会话状态落库（done/cancelled/failed）+ 系统 round + done 事件。
/// S0-3 新路径（取消 / 失败 / 早退）使用；既有 done 收尾保持原样（最小 diff）。
async fn finish_squad_session(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    status: &str,
    summary: &str,
) {
    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status=?, snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(status)
    .bind(summary)
    .bind(now_ms())
    .bind(session_id)
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(squad_id)
    .bind(session_id)
    .bind(summary)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "系统".into(),
            kind: "summary".into(),
            content: summary.to_string(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            summary: summary.to_string(),
        },
    );
    tracing::info!("[squad] 会话 {} 终态：{}", session_id, status);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn get_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?;
    match db_pool {
        DbPool::Sqlite(p) => Ok(p.clone()),
    }
}

struct DelegatedTask {
    title: String,
    assignee: String,
    instruction: String,
}

/// 计算某成员的运行工作目录。
///
/// - 若 squad 配置了用户自选根目录（`workspace`，非空），成员工作区为 `{root}/{agent_id}`；
/// - 否则回退默认隔离目录 `.wd_mem/squads/{squad_id}/{agent_id}`。
fn squad_member_workspace(workspace: &Option<String>, squad_id: &str, agent_id: &str) -> String {
    match workspace {
        Some(root) if !root.trim().is_empty() => {
            let trimmed = root.trim().trim_end_matches(['/', '\\']);
            format!("{}/{}", trimmed, agent_id)
        }
        _ => format!(".wd_mem/squads/{}/{}", squad_id, agent_id),
    }
}

/// 运行一次小分队协作任务（编排式）。
///
/// 流程：建会话 → 选主管 → 主管规划委派 → 逐子任务派成员执行（带重试）→ leader 汇总。
/// 每个成员运行在独立私有的 `.wd_mem/squads/{squad_id}/{agent_id}/` 工作区，互不干扰。
#[tracing::instrument(skip_all)]
pub async fn run_squad_task(app: &AppHandle, squad: SquadRuntimeConfig, prompt: String) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[squad] run_squad_task: 获取数据库失败：{e}");
            return;
        }
    };

    // S0-4a（2026-09-28）：会话 id 去时戳化——纳秒精度 + 进程内序号，消除「同毫秒并发建队」
    // 的 session_id 碰撞面（v1.4 §11：原 format!("sqs_{now_ms}") 同毫秒即撞）。
    let session_id = format!(
        "sqs_{}_{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(now_ms()),
        SQUAD_SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    // S0-3 取消穿线：注册 squad 级取消标志（guard Drop 回收；cancel_squad_sessions 置位）。
    let squad_cancel = Arc::new(AtomicBool::new(false));
    {
        let mut g = SQUAD_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = g.as_mut() {
            map.insert(session_id.clone(), (squad.squad_id.clone(), squad_cancel.clone()));
        }
    }
    let _cancel_guard = SquadCancelGuard(session_id.clone());
    let title = prompt.chars().take(120).collect::<String>();
    let mode = squad.mode.clone();
    let _ = sqlx::query(
        "INSERT INTO agent_squad_session (id, squad_id, title, mode, status, snapshot, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
    )
    .bind(&session_id)
    .bind(&squad.squad_id)
    .bind(&title)
    .bind(&mode)
    .bind(now_ms())
    .bind(now_ms())
    .execute(&pool)
    .await;

    events::emit_squad_session_started(
        app,
        &events::SquadSessionStartedPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.clone(),
            mode: mode.clone(),
        },
    );

    // 按协作模式分派：pipeline / chat 走专用路径，其余默认编排式（orchestrator）。
    match squad.mode.as_str() {
        "pipeline" => {
            run_squad_pipeline(app, &squad, &prompt, &pool, &session_id, &squad_cancel).await;
            return;
        }
        "chat" => {
            run_squad_chat(app, &squad, &prompt, &pool, &session_id, &squad_cancel).await;
            return;
        }
        _ => {}
    }

    // 选出主管：is_leader > leader_agent_id 匹配 > 首个成员（兜底）。
    let leader = squad
        .members
        .iter()
        .find(|m| m.is_leader)
        .or_else(|| {
            squad
                .leader_agent_id
                .as_ref()
                .and_then(|lid| squad.members.iter().find(|m| m.agent.agent_id == *lid))
        })
        .or_else(|| squad.members.first())
        .cloned();

    let leader = match leader {
        Some(l) => l,
        None => {
            tracing::warn!("[squad] run_squad_task: 无可用主管成员，会话按失败收尾");
            finish_squad_session(app, &pool, &squad.squad_id, &session_id, "failed", "无可用主管成员，任务无法执行").await;
            return;
        }
    };

    // 主管规划委派。
    let delegated = plan_squad_delegation(&leader.agent, &prompt, &squad.members, &squad_cancel, &session_id).await;
    if !delegated.is_empty() {
        let plan_text = delegated
            .iter()
            .enumerate()
            .map(|(i, t)| format!("{}. [{}] {}", i + 1, t.assignee, t.title))
            .collect::<Vec<_>>()
            .join("\n");
        events::emit_squad_round(
            app,
            &events::SquadRoundPayload {
                squad_id: squad.squad_id.clone(),
                session_id: session_id.clone(),
                speaker_agent_id: Some(leader.agent.agent_id.clone()),
                role: leader.role.clone(),
                kind: "delegation".into(),
                content: format!("任务委派规划：\n{plan_text}"),
            },
        );
    }

    let mut context = String::new();
    let retry = squad.run_strategy.retry_count.max(1) as usize;
    // P2-3 模式感知恢复（与 run_squad_pipeline 同源）：schedule/api 视为无人值守。
    let unattended = matches!(squad.run_strategy.execution_mode.as_str(), "schedule" | "api");
    for task in &delegated {
        // S0-3 取消检测点：squad 级取消 → 立即收尾（status=cancelled，成员 pipeline 自身也会被同一标志中断）。
        if squad_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            finish_squad_session(app, &pool, &squad.squad_id, &session_id, "cancelled", "任务已被用户取消").await;
            return;
        }
        // 按角色 / agent_id 匹配成员；匹配不到则退回主管。
        let member = match_member(&squad.members, &task.assignee).unwrap_or(&leader);
        let ws =
            squad_member_workspace(&squad.workspace, &squad.squad_id, &member.agent.agent_id);
        let subtask_prompt = if context.is_empty() {
            task.instruction.clone()
        } else {
            format!(
                "{}\n\n## 前序成员产出（仅供参考，可引用其结论）\n{}",
                task.instruction, context
            )
        };

        let mut output = String::new();
        let mut last_err: Option<String> = None;
        for attempt in 0..retry {
            match run_member_subtask(app, &member.agent, &member.role, &session_id, &subtask_prompt, &ws, unattended, Some(&squad_cancel)).await {
                Ok(t) => {
                    output = t;
                    break;
                }
                Err(e) => {
                    last_err = Some(e.clone());
                    tracing::info!(
                        "[squad] 成员 {} 子任务第 {} 次失败：{}",
                        member.agent.agent_id,
                        attempt + 1,
                        e
                    );
                }
            }
        }
        if output.is_empty() {
            output = format!(
                "（成员 {} 子任务执行失败：{}）",
                member.agent.agent_id,
                last_err.unwrap_or_default()
            );
        }

        let _ = sqlx::query(
            "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, 'subtask', ?)",
        )
        .bind(format!("sqr_{}", now_ms()))
        .bind(&squad.squad_id)
        .bind(&session_id)
        .bind(&member.agent.agent_id)
        .bind(&member.role)
        .bind(&output)
        .bind(now_ms())
        .execute(&pool)
        .await;

        events::emit_squad_round(
            app,
            &events::SquadRoundPayload {
                squad_id: squad.squad_id.clone(),
                session_id: session_id.clone(),
                speaker_agent_id: Some(member.agent.agent_id.clone()),
                role: member.role.clone(),
                kind: "subtask".into(),
                content: output.clone(),
            },
        );

        context.push_str(&format!("\n\n[{}] {}\n", member.role, output));
    }

    // 汇总：交给主管总结（若无产出则取最后上下文）。
    let summary = summarize(&leader.agent, &prompt, &context, &squad_cancel, &session_id)
        .await
        .unwrap_or_else(|| context.clone());

    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '汇总', ?, 'summary', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(&squad.squad_id)
    .bind(&session_id)
    .bind(&summary)
    .bind(now_ms())
    .execute(&pool)
    .await;

    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(&summary)
    .bind(now_ms())
    .bind(&session_id)
    .execute(&pool)
    .await;
    write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘

    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.clone(),
            speaker_agent_id: None,
            role: "汇总".into(),
            kind: "summary".into(),
            content: summary.clone(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.clone(),
            summary,
        },
    );
    tracing::info!(
        "[squad] run_squad_task: 会话 {} 完成，模式={}，子任务数={}",
        session_id,
        mode,
        delegated.len()
    );
}

/// 按角色名或 agent_id 匹配成员；大小写不敏感、支持子串包含。
fn match_member<'a>(
    members: &'a [SquadMemberConfig],
    assignee: &str,
) -> Option<&'a SquadMemberConfig> {
    let a = assignee.trim();
    members
        .iter()
        .find(|m| m.role == a || m.agent.agent_id == a)
        .or_else(|| {
            let lower = a.to_lowercase();
            members
                .iter()
                .find(|m| m.role.to_lowercase().contains(&lower))
        })
}

/// 主管把任务拆解成委派子任务（纯 JSON 数组）。
async fn plan_squad_delegation(
    leader_cfg: &AgentRuntimeConfig,
    prompt: &str,
    members: &[SquadMemberConfig],
    cancel: &Arc<AtomicBool>,
    metrics_session: &str,
) -> Vec<DelegatedTask> {
    let roster = members
        .iter()
        .map(|m| format!("- 角色「{}」（智能体 {}）", m.role, m.agent.agent_id))
        .collect::<Vec<_>>()
        .join("\n");
    let sys = "你是小分队的主管智能体，负责把用户的任务拆解成若干子任务，并委派给合适的成员。\
每个子任务必须指定一个 assignee（填成员的角色名，如「后端开发」），并给出清晰的 instruction。\
只输出一个 JSON 数组，不要任何额外解释，格式严格为：\
[{\"title\":\"子任务标题\",\"assignee\":\"成员角色\",\"instruction\":\"交给该成员的具体指令\"}]";
    let user = format!(
        "用户任务：\n{}\n\n可用成员：\n{}\n\n请拆解并委派。",
        prompt, roster
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": user }),
    ];
    match crate::agent::engine::runtime::call_llm(leader_cfg, &messages, &[], Some(cancel)).await {
        Ok((resp, usage)) => {
            squad_metrics_add_usage(metrics_session, usage);
            // 台账 G10：call_llm 返回归一化层（顶层 content），必须走唯一事实源取文本——
            // 原地钻信封 choices[0].message.content 永远取空，委派 JSON 解析必败。
            let content = extract_llm_content(&resp);
            parse_delegation(&content)
        }
        Err(e) => {
            tracing::warn!("[squad] plan_squad_delegation: LLM 调用失败：{e}");
            Vec::new()
        }
    }
}

fn parse_delegation(content: &str) -> Vec<DelegatedTask> {
    let trimmed = content.trim();
    // 去掉 ```json 围栏（模型偶尔会包裹）。
    let json_str = if let Some(s) = trimmed.strip_prefix("```json") {
        s.strip_suffix("```").unwrap_or(s).trim()
    } else if let Some(s) = trimmed.strip_prefix("```") {
        s.strip_suffix("```").unwrap_or(s).trim()
    } else {
        trimmed
    };
    let v: Value = match serde_json::from_str::<Value>(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|item| {
            let title = item.get("title")?.as_str()?.to_string();
            let assignee = item.get("assignee")?.as_str()?.to_string();
            let instruction = item
                .get("instruction")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            if title.is_empty() || assignee.is_empty() {
                return None;
            }
            Some(DelegatedTask {
                title,
                assignee,
                instruction,
            })
        })
        .collect()
}

/// 主管汇总各成员产出为最终结论。
async fn summarize(leader_cfg: &AgentRuntimeConfig, prompt: &str, context: &str, cancel: &Arc<AtomicBool>, metrics_session: &str) -> Option<String> {
    if context.trim().is_empty() {
        return None;
    }
    let sys = "你是小分队主管，请基于各成员的产出，给出本次协作任务的最终汇总结论（简明、可交付）。";
    let user = format!(
        "原始任务：\n{}\n\n各成员产出：\n{}\n\n请给出最终汇总。",
        prompt, context
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": user }),
    ];
    match crate::agent::engine::runtime::call_llm(leader_cfg, &messages, &[], Some(cancel)).await {
        Ok((resp, usage)) => {
            squad_metrics_add_usage(metrics_session, usage);
            let c = extract_llm_content(&resp);
            if c.is_empty() {
                None
            } else {
                Some(c)
            }
        }
        Err(e) => {
            tracing::warn!("[squad] summarize: LLM 调用失败：{e}");
            None
        }
    }
}

/// 以独立 `AgentRuntimeConfig` 运行单个成员的子任务，复用现有 planner + pipeline 路径。
async fn run_member_subtask(
    app: &AppHandle,
    member_cfg: &AgentRuntimeConfig,
    member_role: &str,
    // S0-4d：metrics 归属的 squad 会话 id（成员自身的 graph session 与此不同）。
    metrics_session: &str,
    prompt: &str,
    workspace: &str,
    // P2-3 无人值守模式（schedule/api）：子任务恢复等待超时自动取消整条流水线，防止卡死；
    // manual 模式恒为 false，恢复等待保持永久阻塞（行为不变）。
    unattended: bool,
    // S0-3 取消穿线：squad 级取消标志（编排式主循环传 Some；直接调用方可传 None 保持旧行为）。
    squad_cancel: Option<&Arc<AtomicBool>>,
) -> Result<String, String> {
    let mut cfg = member_cfg.clone();
    cfg.workspace = Some(workspace.to_string());
    cfg.session_id = None;
    cfg.round_id = None;
    let member_wall = std::time::Instant::now(); // S0-4d：成员墙钟

    // S0-4c（2026-09-28）：成员 run_id 贯穿 + member 事件透出——与单 Agent 同源 next_run_id，
    // 成员 pipeline 包 with_run_id_scope（事件/轨迹落自己的 run 桶，agent_get_run_trace 可查）；
    // member-started/finished 广播给 UI 运行控制台（v1.4 §7 状态映射）。
    let run_id = crate::agent::commands::next_run_id();
    let member_event = |phase: &str, ok: bool, summary: &str| {
        let payload = json!({
            "kind": "squad-member",
            "phase": phase,
            "memberAgentId": cfg.agent_id,
            "memberRole": member_role,
            "runId": run_id,
            "ok": ok,
            "summary": summary,
        });
        crate::agent::events::push_event("squad-member-event", &payload);
        if let Err(e) = app.emit("squad-member-event", &payload) {
            tracing::warn!("[squad] member 事件广播失败：{e}");
        }
    };
    member_event("started", true, prompt);

    // 台账 S6：注册链与能力大纲同源——成员子任务规划与单 Agent run_task 共用 build_full_registry。
    let registry = crate::agent::engine::runtime::build_full_registry(app, &cfg);
    let (plan, _, _) = planner::build_plan(&cfg, prompt, Some(workspace), squad_cancel, &registry, None).await;

    // 图驱动：为每个成员子任务打开独立实体图（按 workspace + 成员 id 区分会话），
    // 规划写入图，运行时状态由图承载，与单 Agent 路径一致。
    let session_id = format!("squad_{}", cfg.agent_id);
    let mut graph = match KnowledgeGraph::open(Some(workspace)) {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("[squad] 打开成员实体图失败：{e}");
            return Err(format!("成员子任务图初始化失败：{e}"));
        }
    };
    graph.plan_to_graph(&plan, &session_id);

    // 工具注册表（镜像 run_task 分支 B：原生 + MCP；Skill 不再注册为工具，改由 run_subtask 注入 prompt）。
    let mut base = ToolRegistry::new();
    native::register_native_tools(&mut base, app, cfg.allow_sandbox, &cfg.memory_mode);
    let mut by_server: BTreeMap<String, Vec<mcp_adapter::MountedMcpTool>> = Default::default();
    for t in &cfg.mcp_tools {
        by_server.entry(t.mcp_id.clone()).or_default().push(t.clone());
    }
    for (server, tools) in by_server {
        mcp_adapter::register_mcp_into(&mut base, &server, tools);
    }
    let registry = base;

    let ctx = ToolContext {
        workspace: Some(std::path::PathBuf::from(workspace)),
        sandbox_enabled: cfg.allow_sandbox,
        agent_id: cfg.agent_id.clone(),
        session_id: None,
        run_id: Some(run_id.clone()),
        http_allowed_hosts: cfg.http_allowed_hosts.clone(),
        run_outcomes: Default::default(),
        call_id: None,
    };

    let approval = ApprovalManager::new();
    let recovery = RecoveryHub::new();

    // S0-4b（2026-09-28）：成员执行过 per-agent 锁（v1.4 §11/§9）——此前成员 pipeline 完全
    // 绕锁，成员 agent 若同时被单 Agent 任务占用会并发互踩（tasks 图/审批/恢复）。
    // 语义：占用等待（每 2s 重试，默认最多 30s，`WD_SQUAD_MEMBER_LOCK_WAIT_SECS` 可调），
    // 取消感知（squad 取消立即放弃等待），超时报「成员忙」——**超时改派**需任务重分配
    // 基础设施，落 S1 Wave 并行调度（那里有 assignee 重分配）。
    let _run_guard = {
        let runtime = app.state::<crate::agent::engine::runtime::AgentRuntime>();
        let wait_cap = std::env::var("WD_SQUAD_MEMBER_LOCK_WAIT_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(30);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait_cap);
        let mut guard = None;
        loop {
            if let Some(c) = squad_cancel {
                if c.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("子任务被取消：等待成员锁期间 squad 已取消".into());
                }
            }
            match runtime.try_acquire_run_lock(&cfg.agent_id) {
                Some(pair) => {
                    guard = Some(pair.1);
                    break;
                }
                None => {
                    if std::time::Instant::now() >= deadline {
                        return Err(format!(
                            "成员 agent {} 忙（运行锁占用超过 {wait_cap}s）——请稍后重试或停止该成员的当前任务",
                            cfg.agent_id
                        ));
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
        guard
    };

    // S0-3 取消穿线：pipeline 直接监听 squad 级取消标志（squad 取消 = 成员子任务取消，
    // 单一标志三层贯通；此前局部标志不接 squad 信号，squad 取消时成员 pipeline 继续烧 token）。
    let cancel = squad_cancel.cloned().unwrap_or_else(|| Arc::new(AtomicBool::new(false)));

    // S0-4e（2026-09-28）：成员子任务 run 级墙钟——与单 Agent 对齐（WD_RUN_MAX_SECS 同源，
    // 成员可用 WD_SQUAD_MEMBER_RUN_MAX_SECS 单独覆盖；默认 1800s）。超时强制终止（硬杀），
    // 与单 Agent「软窗口协作收尾 + 墙钟强杀」的最外层兜底等价；graph.snapshot 在超时分支
    // 跳过（pipeline 内部每步已落库，图快照损失可接受）。
    let member_run_limit: u64 = std::env::var("WD_SQUAD_MEMBER_RUN_MAX_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .or_else(|| std::env::var("WD_RUN_MAX_SECS").ok().and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|v| *v > 0)
        .unwrap_or(1800);
    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(member_run_limit),
        crate::agent::events::with_run_id_scope(
            run_id.clone(),
            pipeline::run_pipeline(
                app,
                &cfg,
                &registry,
                &ctx,
                &approval,
                &mut graph,
                &session_id,
                &cancel,
                &recovery,
                unattended,
                // 小分队无授权集（15007）：策略不适用，维持旧行为
                None,
            ),
        ),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            let err = format!(
                "成员子任务运行超时（{member_run_limit}s），已强制终止——可加大 WD_SQUAD_MEMBER_RUN_MAX_SECS / WD_RUN_MAX_SECS 或拆分任务"
            );
            member_event("finished", false, &err);
            tracing::warn!("[squad] 成员 {} {err}", cfg.agent_id);
            return Err(err);
        }
    };
    graph.snapshot(&session_id);

    // S0-4c：member-finished（success 由 pipeline 客观校验给出；summary 取终文截断）
    let summary = result.final_text.chars().take(200).collect::<String>();
    member_event("finished", result.success, &summary);

    if result.cancelled {
        // 问题 1 配套：若取消带系统原因（无人值守超时），一并带入错误串，便于 squad 上层区分。
        let err = match &result.cancel_reason {
            Some(r) => format!("子任务被取消：{r}"),
            None => "子任务被取消".to_string(),
        };
        return Err(err.into());
    }
    // S0-4d：成员 token/墙钟入 per-session 累加器（返回类型保持 String，调用方只消费文本）
    let member_wall_ms = member_wall.elapsed().as_millis() as u64;
    squad_metrics_add_usage(metrics_session, result.usage);
    squad_metrics_add_member(
        metrics_session,
        SquadMemberStat {
            agent_id: cfg.agent_id.clone(),
            role: member_role.to_string(),
            prompt_tokens: result.usage.0,
            completion_tokens: result.usage.1,
            wall_ms: member_wall_ms,
        },
    );
    Ok(result.final_text)}

/// 流水线执行计划：拓扑顺序 + 每个节点的上游输入（成员下标）。
struct DagPlan {
    order: Vec<usize>,
    inputs: Vec<Vec<usize>>,
}

/// 由成员的 `depends_on` 构建 DAG 执行计划（Kahn 拓扑排序）。检测到环则返回错误。
/// 未指向任何已知成员的依赖被忽略（防御脏数据）；同一条上游依赖去重，避免重复注入。
fn build_dag_plan(members: &[SquadMemberConfig]) -> Result<DagPlan, String> {
    use std::collections::{HashMap, VecDeque};
    let id_to_idx: HashMap<&str, usize> = members
        .iter()
        .enumerate()
        .map(|(i, m)| (m.agent.agent_id.as_str(), i))
        .collect();
    let mut deps: Vec<Vec<usize>> = Vec::with_capacity(members.len());
    for m in members {
        let mut d: Vec<usize> = m
            .depends_on
            .iter()
            .filter_map(|dep| id_to_idx.get(dep.as_str()).copied())
            .collect();
        d.sort_unstable();
        d.dedup();
        deps.push(d);
    }
    let mut indeg: Vec<usize> = deps.iter().map(|d| d.len()).collect();
    let mut queue: VecDeque<usize> = (0..members.len()).filter(|&i| indeg[i] == 0).collect();
    let mut order = Vec::new();
    let mut inputs: Vec<Vec<usize>> = Vec::new();
    while let Some(n) = queue.pop_front() {
        order.push(n);
        inputs.push(deps[n].clone());
        for (i, d) in deps.iter().enumerate() {
            if d.contains(&n) {
                indeg[i] -= 1;
                if indeg[i] == 0 {
                    queue.push_back(i);
                }
            }
        }
    }
    if order.len() != members.len() {
        return Err("流水线存在循环依赖（DAG 检测到环），无法执行".into());
    }
    Ok(DagPlan { order, inputs })
}

/// 执行单个流水线节点（带重试），落库并推送 round 事件，返回该成员最终产出文本。
/// 上游成员产出由调用方已折叠进 `prompt`（实现「前步产出→后步输入」的自动串联）。
async fn run_pipeline_node(
    app: &AppHandle,
    squad_id: &str,
    workspace: &Option<String>,
    member: &SquadMemberConfig,
    prompt: &str,
    retry: usize,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    // P2-3 无人值守模式透传。
    unattended: bool,
    cancel: &Arc<AtomicBool>,
) -> String {
    let ws = squad_member_workspace(workspace, squad_id, &member.agent.agent_id);
    let mut output = String::new();
    let mut last_err: Option<String> = None;
    for attempt in 0..retry {
        match run_member_subtask(app, &member.agent, &member.role, session_id, &prompt.to_string(), &ws, unattended, Some(cancel)).await {
            Ok(t) => {
                output = t;
                break;
            }
            Err(e) => {
                last_err = Some(e.clone());
                tracing::info!(
                    "[squad] 流水线成员 {} 第 {} 次失败：{}",
                    member.agent.agent_id,
                    attempt + 1,
                    e
                );
            }
        }
    }
    if output.is_empty() {
        output = format!(
            "（成员 {} 子任务执行失败：{}）",
            member.agent.agent_id,
            last_err.unwrap_or_default()
        );
    }
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 'subtask', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(squad_id)
    .bind(session_id)
    .bind(&member.agent.agent_id)
    .bind(&member.role)
    .bind(&output)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: Some(member.agent.agent_id.clone()),
            role: member.role.clone(),
            kind: "subtask".into(),
            content: output.clone(),
        },
    );
    output
}

/// 流水线（pipeline）：成员按 `pipeline_order` 线性串流，前序工序的 `final_text` 作为后序工序的
/// 上游上下文，折叠进后序成员的 prompt（实现「前步产出→后步输入」的链式传递，等价于原 run_pipeline 的 initial_context）。
///
/// 各成员运行在独立私有工作区，互不干扰；末工序输出即最终交付物（本模式不额外调用汇总 LLM，降本）。
/// 若任一成员设置了 `depends_on`，则升级为 DAG 拓扑执行：每个节点以所有上游成员产出为上游上下文，
/// 最终汇总取所有「汇点」（无下游依赖的节点）产出。
#[tracing::instrument(skip_all)]
async fn run_squad_pipeline(
    app: &AppHandle,
    squad: &SquadRuntimeConfig,
    prompt: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    cancel: &Arc<AtomicBool>,
) {
    let retry = squad.run_strategy.retry_count.max(1) as usize;
    // P2-3 模式感知恢复：schedule / api 模式视为无人值守 → 子任务失败恢复超时自动取消；
    // manual 模式保持永久等待用户决策。execution_mode 取值即 SquadRunStrategy 既有字段。
    let unattended = matches!(squad.run_strategy.execution_mode.as_str(), "schedule" | "api");
    let use_dag = squad.members.iter().any(|m| !m.depends_on.is_empty());

    // 执行计划：执行顺序 + 每个节点的上游输入来源（成员下标）。
    let plan: DagPlan = if use_dag {
        match build_dag_plan(&squad.members) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("[squad] pipeline: DAG 构建失败，会话 {}：{e}", session_id);
                let _ = sqlx::query(
                    "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
                     VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
                )
                .bind(format!("sqr_{}", now_ms()))
                .bind(&squad.squad_id)
                .bind(session_id)
                .bind(format!("流水线 DAG 存在循环依赖，无法执行：{e}"))
                .bind(now_ms())
                .execute(pool)
                .await;
                let _ = sqlx::query(
                    "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
                )
                .bind(&e)
                .bind(now_ms())
                .bind(session_id)
                .execute(pool)
                .await;
                write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘
                events::emit_squad_session_done(
                    app,
                    &events::SquadSessionDonePayload {
                        squad_id: squad.squad_id.clone(),
                        session_id: session_id.to_string(),
                        summary: e,
                    },
                );
                return;
            }
        }
    } else {
        // 线性模式：按 pipeline_order 排序，每节点输入 = 之前所有节点产出。
        let mut order: Vec<usize> = (0..squad.members.len()).collect();
        order.sort_by_key(|&i| squad.members[i].pipeline_order.unwrap_or(usize::MAX));
        let inputs: Vec<Vec<usize>> = order
            .iter()
            .enumerate()
            .map(|(pos, _)| order[..pos].to_vec())
            .collect();
        DagPlan { order, inputs }
    };

    // 各成员产出缓存（按下标索引）。
    let mut outputs: Vec<String> = vec![String::new(); squad.members.len()];

    for (pos, &mi) in plan.order.iter().enumerate() {
        // S0-3 取消检测点：squad 级取消 → 立即收尾。
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "任务已被用户取消").await;
            return;
        }
        let member = &squad.members[mi];
        let upstream = plan.inputs[pos]
            .iter()
            .map(|&up| outputs[up].clone())
            .collect::<Vec<_>>()
            .join("\n\n");
        // 上游成员产出折叠进本节点 prompt：实现「前步产出→后步输入」的自动串联
        // （原 run_pipeline 的 initial_context 已移除，改为在 prompt 层串联，行为等价）。
        let node_prompt = if upstream.trim().is_empty() {
            prompt.to_string()
        } else {
            format!(
                "{}\n\n[上游成员已交付产物]\n{}\n\n请基于上述上游产出继续完成本节点任务。",
                prompt, upstream
            )
        };
        let out = run_pipeline_node(app, &squad.squad_id, &squad.workspace, member, &node_prompt, retry, pool, session_id, unattended, cancel).await;
        outputs[mi] = out;
    }

    // 最终汇总：DAG 取所有「汇点」（无任何下游依赖的节点）产出；线性取末序节点产出。
    let summary = if use_dag {
        let sinks: Vec<usize> = plan
            .order
            .iter()
            .copied()
            .filter(|&mi| {
                let id = &squad.members[mi].agent.agent_id;
                !squad.members.iter().any(|m| m.depends_on.iter().any(|d| d == id))
            })
            .collect();
        if sinks.is_empty() {
            outputs
                .iter()
                .enumerate()
                .map(|(i, o)| format!("[{}] {}", squad.members[i].role, o))
                .collect::<Vec<_>>()
                .join("\n\n")
        } else if sinks.len() == 1 {
            outputs[sinks[0]].clone()
        } else {
            sinks
                .iter()
                .map(|&mi| format!("[{}] {}", squad.members[mi].role, outputs[mi]))
                .collect::<Vec<_>>()
                .join("\n\n")
        }
    } else {
        outputs[*plan.order.last().unwrap()].clone()
    };

    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '汇总', ?, 'summary', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(&squad.squad_id)
    .bind(session_id)
    .bind(&summary)
    .bind(now_ms())
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(&summary)
    .bind(now_ms())
    .bind(session_id)
    .execute(pool)
    .await;
    write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘

    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "汇总".into(),
            kind: "summary".into(),
            content: summary.clone(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            summary,
        },
    );
    tracing::info!(
        "[squad] pipeline: 会话 {} 完成，模式={}{}",
        session_id,
        if use_dag { "DAG" } else { "线性" },
        plan.order.len()
    );
}

/// 群聊协商（chat）：成员在共享讨论黑板上轮流发言，由 Moderator / 汇总主笔收口。
///
/// 与编排式（Leader 拆解委派）和流水线（线性串流）不同，群聊强调「多向讨论」：
/// 每轮各参与者基于讨论目标 + 共享黑板（所有人历史发言）给出见解，最后由汇总主笔产出结论。
/// 每轮发言为单次 `call_llm`（轻量、偏对话），不跑完整 pipeline，契合圆桌语义。
#[tracing::instrument(skip_all)]
async fn run_squad_chat(
    app: &AppHandle,
    squad: &SquadRuntimeConfig,
    prompt: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    cancel: &Arc<AtomicBool>,
) {
    let max_rounds = if squad.chat_config.max_rounds == 0 {
        8
    } else {
        squad.chat_config.max_rounds
    };

    // 汇总主笔：chat_config.summarizer_agent_id > leader_agent_id > 首个成员。
    let summarizer_id: Option<String> = squad
        .chat_config
        .summarizer_agent_id
        .clone()
        .or_else(|| squad.leader_agent_id.clone())
        .or_else(|| squad.members.first().map(|m| m.agent.agent_id.clone()));

    // 参与者 = 除汇总主笔外的成员；若无其他成员则全员参与。
    let participants: Vec<&SquadMemberConfig> = squad
        .members
        .iter()
        .filter(|m| Some(&m.agent.agent_id) != summarizer_id.as_ref())
        .collect();
    let speakers: Vec<&SquadMemberConfig> = if participants.is_empty() {
        squad.members.iter().collect()
    } else {
        participants
    };

    let mut blackboard = String::new();
    for r in 0..max_rounds {
        // S0-3 取消检测点：squad 级取消 → 立即收尾。
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "任务已被用户取消").await;
            return;
        }
        for member in speakers.clone() {
            let sys = format!(
                "你是小分队「{}」圆桌讨论的参与者，角色为「{}」。请基于讨论目标与其他成员的发言，给出你的专业见解（简洁、针对目标、可回应他人观点）。",
                squad.name, member.role
            );
            let history = if blackboard.is_empty() {
                "（暂无，等待你的开场发言）".to_string()
            } else {
                blackboard.clone()
            };
            let user = format!(
                "讨论目标：\n{}\n\n## 当前讨论黑板（所有成员历史发言）\n{}\n\n请给出你第 {} 轮发言。",
                prompt, history, r + 1
            );
            let messages = vec![
                json!({ "role": "system", "content": sys }),
                json!({ "role": "user", "content": user }),
            ];
            let content = match crate::agent::engine::runtime::call_llm(&member.agent, &messages, &[], Some(cancel)).await {
                Ok((resp, usage)) => { squad_metrics_add_usage(session_id, usage); extract_llm_content(&resp) }
                Err(e) => {
                    tracing::warn!("[squad] chat 成员 {} 第 {} 轮发言失败：{e}", member.agent.agent_id, r + 1);
                    format!("（成员 {} 发言失败：{e}）", member.agent.agent_id)
                }
            };

            let _ = sqlx::query(
                "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 'message', ?)",
            )
            .bind(format!("sqr_{}", now_ms()))
            .bind(&squad.squad_id)
            .bind(session_id)
            .bind(&member.agent.agent_id)
            .bind(&member.role)
            .bind(&content)
            .bind(now_ms())
            .execute(pool)
            .await;

            events::emit_squad_round(
                app,
                &events::SquadRoundPayload {
                    squad_id: squad.squad_id.clone(),
                    session_id: session_id.to_string(),
                    speaker_agent_id: Some(member.agent.agent_id.clone()),
                    role: member.role.clone(),
                    kind: "message".into(),
                    content: content.clone(),
                },
            );

            blackboard.push_str(&format!("\n\n[{}·{}] {}", r + 1, member.role, content));
        }
    }

    // 汇总主笔收口：基于完整讨论黑板产出最终结论。
    let summarizer = summarizer_id
        .as_ref()
        .and_then(|id| squad.members.iter().find(|m| &m.agent.agent_id == id))
        .or_else(|| squad.members.first());
    let sum_cfg = match summarizer {
        Some(m) => &m.agent,
        None => {
            tracing::warn!("[squad] chat: 无可用汇总主笔");
            events::emit_squad_session_done(
                app,
                &events::SquadSessionDonePayload {
                    squad_id: squad.squad_id.clone(),
                    session_id: session_id.to_string(),
                    summary: blackboard.clone(),
                },
            );
            return;
        }
    };

    let sys = "你是小分队圆桌讨论的主持人 / 汇总主笔。请基于讨论黑板，给出本次协作任务的最终汇总结论（可交付、简明、归纳各方共识与待决点）。";
    let user = format!(
        "讨论目标：\n{}\n\n## 讨论黑板\n{}\n\n请给出最终汇总。",
        prompt, blackboard
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": user }),
    ];
    let summary = match crate::agent::engine::runtime::call_llm(sum_cfg, &messages, &[], Some(cancel)).await {
        Ok((resp, usage)) => {
            squad_metrics_add_usage(session_id, usage);
            let s = extract_llm_content(&resp);
            if s.is_empty() {
                blackboard.clone()
            } else {
                s
            }
        }
        Err(e) => {
            tracing::warn!("[squad] chat: 汇总主笔调用失败：{e}");
            blackboard.clone()
        }
    };

    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '汇总', ?, 'summary', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(&squad.squad_id)
    .bind(session_id)
    .bind(&summary)
    .bind(now_ms())
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(&summary)
    .bind(now_ms())
    .bind(session_id)
    .execute(pool)
    .await;
    write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘

    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "汇总".into(),
            kind: "summary".into(),
            content: summary.clone(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            summary,
        },
    );
    tracing::info!(
        "[squad] chat: 会话 {} 完成，轮次={}，参与成员数={}",
        session_id,
        max_rounds,
        speakers.len()
    );
}
// 台账 G10：本地 extract_llm_text（钻信封层，永远取空）已删除——统一走
// llm::extract_llm_content（归一化层优先 + 信封兜底，见 engine/llm.rs）。
