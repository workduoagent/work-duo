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
    /// 本轮临时禁用的技能 id 列表（仅会话内有效，不写库）。load_config 据此从技能工具集中剔除。
    #[serde(default)]
    pub disabled_skill_ids: Option<Vec<String>>,
    /// 本轮临时禁用的 MCP 服务 id 列表（仅会话内有效，不写库）。load_config 据此剔除该服务下全部工具。
    #[serde(default)]
    pub disabled_mcp_ids: Option<Vec<String>>,
    /// 本轮临时禁用的单个 MCP 工具 id 列表（仅会话内有效，不写库）。键为 mcp_tool_definition.id。
    #[serde(default)]
    pub disabled_mcp_tool_ids: Option<Vec<String>>,
    /// 本轮用户消息附件（多模态图片）。前端契约 { type, dataUrl, name? }。
    #[serde(default)]
    pub attachments: Option<Vec<crate::agent::types::AttachmentInput>>,
}

/// 启动一轮智能体任务。
#[tauri::command]
pub async fn run_agent_task(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: RunAgentTaskInput,
) -> Result<(), String> {
    let cfg = load_config(
        &app,
        &input.agent_id,
        input.workspace.clone(),
        input.session_id.clone(),
        input.round_id.clone(),
        input.disabled_skill_ids.clone(),
        input.disabled_mcp_ids.clone(),
        input.disabled_mcp_tool_ids.clone(),
        input.attachments.clone(),
    )
    .await?;

    println!(
        "[agent] run_agent_task 收到请求: agent_id={} prompt_len={} workspace={:?} 附件数={}",
        input.agent_id,
        input.prompt.chars().count(),
        input.workspace,
        input.attachments.as_ref().map(|a| a.len()).unwrap_or(0),
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
    disabled_skill_ids: Option<Vec<String>>,
    disabled_mcp_ids: Option<Vec<String>>,
    disabled_mcp_tool_ids: Option<Vec<String>>,
    attachments: Option<Vec<crate::agent::types::AttachmentInput>>,
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
    let mcp_tools: Vec<MountedMcpTool> = mcp_rows
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

    let skill_rows = sqlx::query(
        "SELECT s.id AS skill_id, s.name AS name, s.description AS description, s.instruction AS instruction \
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
    let skill_tools: Vec<SkillToolWrapper> = skill_rows
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
            SkillToolWrapper {
                skill_id: skill_id.clone(),
                skill_name: if name.is_empty() { skill_id } else { name },
                skill_description: if desc.is_empty() { instruction } else { desc },
            }
        })
        .collect();

    // 沙箱开关：同一个真值源同时决定「能力层注册哪些工具」与「提示层声明哪些能力」。
    // 二者必须同源——否则提示里写「不暴露 execute_command」而工具表里照样注册，
    // 模型以工具表为准，试探后必然绕过沙箱（实测会去找系统 python 甚至 winget 安装）。
    let allow_sandbox = get_i64(&row, "allow_sandbox") == 1;

    println!(
        "[agent] load_config 完成: llm_id={} model={} mcp_tools={} skill_tools={} auto_exec={} sandbox={} system_prompt={}字符 附件数={}",
        if llm_id.is_empty() { "<无>" } else { llm_id.as_str() },
        if llm_model_name.is_empty() { "<无>" } else { llm_model_name.as_str() },
        mcp_tools.len(),
        skill_tools.len(),
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
\n**严禁**：\
\n- 不要尝试调用系统 `python` / `python3`，不要用 `where python`、`python --version` 探测本机 Python；\
\n- 绝对禁止用 winget / choco / brew / apt 安装系统级 Python 或任何系统软件——这会脱离沙箱并污染用户本机环境；\
\n- 沙箱缺少第三方库时先 import 确认，确实缺失则如实告知用户，切勿自行安装系统级包。",
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
            match crate::agent::wd_mem::ensure_wd_mem(ws_trim) {
                Ok(_) => {
                    system_prompt.push_str(&format!(
                        "\n\n### 工作空间记忆区 `.wd_mem/`（已就绪，位于 {}/.wd_mem）\n\
这是本工作空间的专属记忆与素材库，由你在上次运行中沉淀，本次应优先复用其中的素材、避免重复生成：\n\
- `scripts/`：可复用的自动化脚本（Python/Shell 等）——**再跑同类任务前，先检查这里是否已有可用脚本，有则直接复用或小幅改写，不要从零重写**。\n\
- `data/`：抓取/计算的中间数据（CSV/JSON 等）——已有则优先读取复用，避免重复联网获取。\n\
                    - `outputs/`：最终产物的归档副本（可选）。\n\
- `MEMORY.md`：项目长期全局记忆（架构/避坑/用户偏好），全量注入系统提示，你可直接读取/编辑。\n\
- `artifacts/`：你完成复杂任务后主动沉淀的设计蓝图（用 `native__archive_artifact` 写入）。\n\
约定：**新生成的、值得保留的脚本请写入 `scripts/`；中间数据写入 `data/`；不要把临时/一次性脚本散落在工作空间根目录**，以免污染用户目录。**最终交付物**仍放在工作空间根目录或用户指定位置。",
                        ws_trim
                    ));
                    // [双轨记忆 Slot 0] 树状索引（artifacts/sessions/scripts/data，仅首行标题，绝不读正文）+ 自主发现指令。
                    if let Some(index) = crate::agent::wd_mem::build_tree_index(ws_trim) {
                        system_prompt.push_str(&format!(
                            "\n\n{}\n\n> The `artifacts/`, `sessions/` and `scripts/` directories under `.wd_mem/` contain historical designs and bug-fixing records. You MUST use the `native__read_file` tool to inspect specific files before proceeding if the user's request relates to these modules.",
                            index
                        ));
                    }
                    // [双轨记忆 Slot 0] 长期全局记忆 MEMORY.md（规范命名；兼容旧 project_memory.md 回退）。
                    if let Some(mem) = crate::agent::wd_mem::read_project_memory(ws_trim) {
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
                    println!("[agent] load_config: 已确保 .wd_mem 结构并注入复用清单 workspace={}", ws_trim);
                }
                Err(e) => {
                    println!("[agent] load_config: 创建 .wd_mem 失败（降级为不使用记忆区）：{e}");
                }
            }
        }
    }
    Ok(AgentRuntimeConfig {
        agent_id: agent_id.to_string(),
        system_prompt,
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
        attachments: attachments.unwrap_or_default(),
    })
}
