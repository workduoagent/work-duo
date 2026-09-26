//! Skill 包携带工具 → AgentTool 动态注册（台账 D1 第三步：能力分发）。
//!
//! **包契约**：Skill 目录根可选 `tools.json`（单一事实源在包内，与 SKILL.md 同级同源）：
//! ```json
//! {
//!   "tools": [
//!     {
//!       "name": "setup_project",
//!       "description": "初始化项目脚手架",
//!       "runtime": "python",
//!       "script": "tools/setup_project.py",
//!       "parameters": { "type": "object", "properties": {}, "required": [] },
//!       "timeout_sec": 60,
//!       "sensitive": false
//!     }
//!   ]
//! }
//! ```
//! 脚本遵循**插件脚本契约**（定义 `run(args)`，Runner 壳由 plugin_runner 拼装），
//! 执行复用 `plugin_runner::run_plugin` 沙箱核心（fs/net 守卫自动注入）——
//! Skill 与 Plugin 共享同一执行底线，仅分发载体不同。
//!
//! **安全默认**：Skill 包可能来自第三方（市场/导入），脚本 = 本机代码 →
//! `check_permission` 默认 `RequireApproval`；包作者显式声明 `"sensitive": false`
//! 才降级 `ReadSafe`（由沙箱守卫兜底）。**注册前置条件：agent `allow_sandbox=1`**
//! （与插件装配同规则，调用方保证）。
//!
//! 解析容错：tools.json 缺失/非法/单项校验失败 → 跳过并 warn，**绝不阻断任务启动**；
//! 未声明工具的 Skill 行为与现状完全一致（纯知识包）。

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use tauri::AppHandle;
use tauri::Manager;

use crate::agent::engine::tools::{AgentTool, PermissionLevel, ToolBehavior, ToolContext, ToolError, ToolRegistry};
use crate::agent::plugins::plugin_runner::{run_plugin, PluginExecSpec};
use crate::agent::plugins::skill_adapter::SkillToolWrapper;
use crate::bun_manager::BunManager;
use crate::mamba_manager::MambaManager;

/// 单包工具数上限（防恶意包灌爆注册表；与技能上限 MAX_SKILLS=3 相乘 ≤ 24 个）。
const MAX_TOOLS_PER_SKILL: usize = 8;
/// 单工具执行超时硬上限（秒），与插件一致。
const MAX_TIMEOUT_SEC: u64 = 300;

/// tools.json 单项（解析后）。
#[derive(Debug, Clone)]
pub struct SkillToolDecl {
    /// 工具 slug（`[a-z0-9_-]+`，最终名 `skill__{identifier}__{slug}`）。
    pub name: String,
    pub description: String,
    /// `python` | `bun`。
    pub runtime: String,
    /// 相对 Skill 包根的脚本路径（禁 `..` / 绝对路径 / 反斜杠）。
    pub script: String,
    /// 对外暴露的 JSON Schema。
    pub parameters: Value,
    pub timeout_sec: u64,
    /// true = RequireApproval（默认）；false = ReadSafe（包作者明示低风险）。
    pub sensitive: bool,
    /// 声明式依赖（自愈安装清单，透传插件执行器）。
    pub dependencies: Vec<String>,
}

/// 解析 Skill 包根的 tools.json；缺失 → Ok(vec![])，非法 → 逐项跳过并 warn。
pub fn parse_skill_tools(skill_path: &str, identifier: &str) -> Vec<SkillToolDecl> {
    let manifest_path = std::path::Path::new(skill_path).join("tools.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(r) => r,
        Err(_) => return Vec::new(), // 无 tools.json = 纯知识包，静默
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[skill_tools] {identifier}: tools.json 解析失败，忽略随包工具：{e}");
            return Vec::new();
        }
    };
    let Some(list) = parsed.get("tools").and_then(|v| v.as_array()) else {
        tracing::warn!("[skill_tools] {identifier}: tools.json 缺少 tools 数组，忽略");
        return Vec::new();
    };

    let mut out = Vec::new();
    for (i, item) in list.iter().enumerate() {
        match parse_tool_decl(item) {
            Ok(d) => {
                if out.iter().any(|x: &SkillToolDecl| x.name == d.name) {
                    tracing::warn!("[skill_tools] {identifier}: 工具 #{} 重名 {}，跳过", i, d.name);
                    continue;
                }
                out.push(d);
                if out.len() >= MAX_TOOLS_PER_SKILL {
                    tracing::warn!(
                        "[skill_tools] {identifier}: 达到单包工具上限 {MAX_TOOLS_PER_SKILL}，剩余忽略"
                    );
                    break;
                }
            }
            Err(e) => tracing::warn!("[skill_tools] {identifier}: 工具 #{} 校验失败跳过：{e}", i),
        }
    }
    out
}

/// 单项校验：name / runtime / script / parameters。
fn parse_tool_decl(item: &Value) -> Result<SkillToolDecl, String> {
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(format!("name 非法：{name:?}（须 [a-z0-9_-]+）"));
    }
    let description = item
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if description.is_empty() {
        return Err("description 不能为空（规划器与执行模型都依赖它决策）".into());
    }
    let runtime = item
        .get("runtime")
        .and_then(|v| v.as_str())
        .unwrap_or("python")
        .trim()
        .to_string();
    if runtime != "python" && runtime != "bun" {
        return Err(format!("runtime 非法：{runtime}（仅 python | bun）"));
    }
    let script = item
        .get("script")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if script.is_empty()
        || script.contains('\\')
        || script.starts_with('/')
        || script.split('/').any(|seg| seg == "..")
    {
        return Err(format!("script 非法：{script:?}（相对包根的正斜杠路径，禁 .. 与绝对路径）"));
    }
    let parameters = item.get("parameters").cloned().unwrap_or_else(|| {
        json!({"type": "object", "properties": {}})
    });
    if parameters.get("type").and_then(|v| v.as_str()) != Some("object") {
        return Err("parameters 必须是 type=object 的 JSON Schema".into());
    }
    let timeout_sec = item
        .get("timeout_sec")
        .and_then(|v| v.as_u64())
        .unwrap_or(60)
        .clamp(1, MAX_TIMEOUT_SEC);
    let sensitive = item.get("sensitive").and_then(|v| v.as_bool()).unwrap_or(true);
    let dependencies = item
        .get("dependencies")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Ok(SkillToolDecl {
        name,
        description,
        runtime,
        script,
        parameters,
        timeout_sec,
        sensitive,
        dependencies,
    })
}

/// Skill 声明工具的 AgentTool 包装：执行 = 读包内脚本 → 插件沙箱核心。
pub struct SkillDeclaredTool {
    /// 宿主 skill id（审计/日志归属）。
    pub skill_id: String,
    /// 宿主 skill identifier（工具名命名空间）。
    pub skill_identifier: String,
    /// Skill 包根目录（脚本从这里读）。
    pub skill_path: String,
    pub decl: SkillToolDecl,
    pub app: AppHandle,
}

impl SkillDeclaredTool {
    fn tool_slug(&self) -> String {
        format!("skill__{}__{}", self.skill_identifier, self.decl.name)
    }
}

#[async_trait]
impl AgentTool for SkillDeclaredTool {
    fn name(&self) -> String {
        self.tool_slug()
    }

    fn tool_definition(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": format!(
                    "[SkillTool] {} — {}",
                    self.decl.name, self.decl.description
                ),
                "parameters": self.decl.parameters,
            }
        })
    }

    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        // 安全默认：第三方包脚本 = 本机代码，默认需审批；包作者声明 sensitive:false 才降级。
        if self.decl.sensitive {
            PermissionLevel::RequireApproval
        } else {
            PermissionLevel::ReadSafe
        }
    }

    fn behavior(&self) -> ToolBehavior {
        // 声明式元数据（S6 进阶）：脚本执行属 exec 类——policy 危险信号扫描覆盖
        // 入参中的命令/路径字面量（与插件 custom__ 不同，后者旧映射无 op；
        // skill 工具是新物种，按其本质定为 exec，评估更严不更松）。
        ToolBehavior { op: Some("exec"), file_mutating: false, file_reading: false }
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let script_abs = std::path::Path::new(&self.skill_path).join(&self.decl.script);
        // 双保险：解析期已校验相对路径，这里再防符号链接/拼接逃逸（解析后必须仍在包内）。
        let canonical_root = std::fs::canonicalize(&self.skill_path)
            .map_err(|e| ToolError::ExecutionFailed(format!("Skill 包目录不可达：{e}")))?;
        let canonical_script = std::fs::canonicalize(&script_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("脚本不可达 {}：{e}", self.decl.script)))?;
        if !canonical_script.starts_with(&canonical_root) {
            return Err(ToolError::PermissionDenied(format!(
                "脚本越界：{} 不在 Skill 包内",
                self.decl.script
            )));
        }
        let script_content = std::fs::read_to_string(&canonical_script)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取脚本失败：{e}")))?;
        if script_content.trim().is_empty() {
            return Err(ToolError::InvalidArgs(format!(
                "脚本为空：{}",
                self.decl.script
            )));
        }

        let spec = PluginExecSpec {
            plugin_id: format!("skill_{}", self.skill_id),
            identifier: format!("{}__{}", self.skill_identifier, self.decl.name),
            runtime: self.decl.runtime.clone(),
            script_content,
            timeout_sec: self.decl.timeout_sec,
            dependencies: self.decl.dependencies.clone(),
        };
        let call_id = format!("call_{}", crate::agent::engine::runtime::now_ms());
        let mamba = self.app.state::<MambaManager>();
        let bun = self.app.state::<BunManager>();
        let result = run_plugin(
            &self.app,
            &*mamba,
            &*bun,
            &spec,
            &args,
            &call_id,
            Some(&ctx.agent_id),
            ctx.session_id.as_deref(),
            "skill_tool",
        )
        .await;
        if result.ok {
            match result.result {
                Some(v) => Ok(serde_json::to_string(&v).unwrap_or_else(|_| "null".to_string())),
                None => Ok("null".to_string()),
            }
        } else {
            let mut msg = result
                .error_message
                .clone()
                .unwrap_or_else(|| "Skill 工具执行失败".to_string());
            if let Some(tb) = result.traceback {
                msg.push_str(&format!("\n{tb}"));
            }
            Err(ToolError::ExecutionFailed(format!(
                "[SkillTool {}] {}",
                self.tool_slug(),
                msg
            )))
        }
    }
}

/// 把全部绑定 Skill 的随包工具注册进注册表（`build_full_registry` 调用）。
///
/// - 仅处理带 `skill_path` 的包装（MCP 动态 @ 启用的技能同样生效）；
/// - 调用方保证 `allow_sandbox=1`（与插件装配同规则——脚本执行前置条件）；
/// - 无 tools.json 的 Skill 零影响，现状行为不变。
pub fn register_skill_tools(registry: &mut ToolRegistry, app: &AppHandle, skills: &[SkillToolWrapper]) {
    for s in skills {
        if s.skill_path.trim().is_empty() {
            continue; // 无落盘目录（纯 DB 记录）→ 无包可解析
        }
        let decls = parse_skill_tools(&s.skill_path, &s.skill_id);
        if decls.is_empty() {
            continue;
        }
        // 命名空间：Skill 落盘目录名（= identifier，惯例已是 slug，唯一且可读，
        // 如 `E:\WorkDuo\.skills\mcp_selftest_x` → `mcp_selftest_x`）；
        // 目录名提取失败回退 skill_id 前 8 位（UUID 前缀，保唯一性）。
        let namespace = std::path::Path::new(&s.skill_path)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.trim().to_lowercase())
            .filter(|n| !n.is_empty() && n != "." && n != "..")
            .unwrap_or_else(|| s.skill_id.chars().take(8).collect());
        tracing::info!(
            "[skill_tools] {}（{}）: 注册随包工具 {} 个",
            s.skill_name,
            s.skill_path,
            decls.len()
        );
        for d in decls {
            let tool = SkillDeclaredTool {
                skill_id: s.skill_id.clone(),
                skill_identifier: namespace.clone(),
                skill_path: s.skill_path.clone(),
                decl: d,
                app: app.clone(),
            };
            registry.register(Arc::new(tool));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tool_decl_accepts_valid_minimal() {
        let v = json!({
            "name": "hello",
            "description": "打个招呼",
            "runtime": "python",
            "script": "tools/hello.py"
        });
        let d = parse_tool_decl(&v).unwrap();
        assert_eq!(d.name, "hello");
        assert_eq!(d.timeout_sec, 60);
        assert!(d.sensitive); // 安全默认：未声明即敏感
        assert_eq!(d.parameters["type"], "object");
    }

    #[test]
    fn parse_tool_decl_rejects_bad_name_and_escape() {
        assert!(parse_tool_decl(&json!({"name": "Bad Name", "description": "x", "script": "a.py"})).is_err());
        assert!(parse_tool_decl(&json!({"name": "ok", "description": "x", "script": "../escape.py"})).is_err());
        assert!(parse_tool_decl(&json!({"name": "ok", "description": "x", "script": "/abs.py"})).is_err());
        assert!(parse_tool_decl(&json!({"name": "ok", "description": "x", "script": "tools\\x.py"})).is_err());
        assert!(parse_tool_decl(&json!({"name": "ok", "description": "", "script": "a.py"})).is_err());
        assert!(parse_tool_decl(&json!({"name": "ok", "description": "x", "script": "a.py", "runtime": "ruby"})).is_err());
        assert!(parse_tool_decl(&json!({"name": "ok", "description": "x", "script": "a.py", "parameters": {"type": "string"}})).is_err());
    }

    #[test]
    fn parse_skill_tools_missing_file_is_empty() {
        assert!(parse_skill_tools("Z:/definitely/not/exist", "x").is_empty());
    }

    #[test]
    fn parse_skill_tools_skips_bad_items_and_dedups() {
        let dir = std::env::temp_dir().join(format!("wd_skill_tools_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = json!({
            "tools": [
                {"name": "good", "description": "ok", "script": "a.py"},
                {"name": "Bad Name", "description": "x", "script": "b.py"},
                {"name": "good", "description": "dup", "script": "c.py"},
                {"name": "good2", "description": "ok2", "script": "d.py", "sensitive": false, "timeout_sec": 999}
            ]
        });
        std::fs::write(dir.join("tools.json"), manifest.to_string()).unwrap();
        let out = parse_skill_tools(dir.to_str().unwrap(), "t");
        assert_eq!(out.len(), 2); // 坏项跳过、重名去重
        assert_eq!(out[0].name, "good");
        assert!(out[0].sensitive);
        assert_eq!(out[1].name, "good2");
        assert!(!out[1].sensitive);
        assert_eq!(out[1].timeout_sec, 300); // clamp 到硬上限
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_skill_tools_caps_per_skill() {
        let dir = std::env::temp_dir().join(format!("wd_skill_tools_cap_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut tools = Vec::new();
        for i in 0..12 {
            tools.push(json!({"name": format!("t{i}"), "description": "x", "script": "a.py"}));
        }
        std::fs::write(dir.join("tools.json"), json!({ "tools": tools }).to_string()).unwrap();
        assert_eq!(parse_skill_tools(dir.to_str().unwrap(), "t").len(), MAX_TOOLS_PER_SKILL);
        std::fs::remove_dir_all(&dir).ok();
    }
}
