//! 已有 Skill 系统的适配器（对应方案步骤 6 · 生态 A）。
//!
//! 不推翻现有 Skill 模块，仅把 `skill_info` 表里的技能包装成 `AgentTool` 贡献给 `ExtensionHub`。
//! 当前实现为「只读描述型」包装：调用时返回技能说明（真实执行需接入业务执行核心，依项目约定
//! 后续按需扩展），满足「统一抽象、零侵入热插拔」目标。

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::tools::AgentTool;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;

/// 单个 Skill 包装成的 AgentTool。
#[derive(Debug, Clone)]
pub struct SkillToolWrapper {
    pub skill_id: String,
    pub skill_name: String,
    pub skill_description: String,
    /// SKILL.md 正文（落库于 `skill_info.skill_markdown`）。调用技能时返回给模型，
    /// 使其真正遵循工作流 / 脚手架脚本 / 质量门禁，而非仅依赖 `instruction` 铁律。
    pub skill_markdown: String,
    /// 技能本地资源目录（落库于 `skill_info.path`），含 `references/` 与 `scripts/`。
    pub skill_path: String,
}

// Skill 不再注册为工具（改为 prompt 注入），`AgentTool` impl 与 `register_skills_into` 暂未调用，标记 dead_code 保留复用。
#[allow(dead_code)]
#[async_trait]
impl AgentTool for SkillToolWrapper {
    fn name(&self) -> String {
        format!("skill__{}", self.skill_id)
    }

    fn tool_definition(&self) -> serde_json::Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": format!(
                    "[Skill] {}（调用本工具获取该技能完整 SKILL.md 工作流与脚手架脚本指引，须严格遵循返回内容执行）",
                    self.skill_description
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": { "type": "string", "description": "交给该技能处理的任务描述" }
                    },
                    "required": ["task"]
                }
            }
        })
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        // 技能为只读描述型包装（真实执行业务核心待接入），调用即"思考过程"的一环，
        // 不视为本地高危操作，默认放行（与 MCP 工具一致）。
        PermissionLevel::ReadSafe
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        let task = args
            .get("task")
            .and_then(|v| v.as_str())
            .unwrap_or("<未提供任务>");
        tracing::info!(
            "[agent] skill__{}: 调用 skill_name={} task={}",
            self.skill_id,
            self.skill_name,
            crate::agent::runtime::clip(task, 500),
        );

        // 真实返回 SKILL.md 正文（落库于 skill_info.skill_markdown），使模型真正遵循
        // 工作流 / 脚手架脚本 / 质量门禁，而非仅依赖 instruction 铁律或凭通用经验现写文件。
        let mut parts: Vec<String> = Vec::new();
        parts.push(format!(
            "## 技能『{}』完整指引（id={}）\n\n你已调用该技能来处理任务：{}\n",
            self.skill_name, self.skill_id, task
        ));

        if !self.skill_markdown.trim().is_empty() {
            parts.push(self.skill_markdown.clone());
        } else if !self.skill_description.trim().is_empty() {
            parts.push(format!(
                "> 该技能未配置 SKILL.md 正文，回退说明：{}\n",
                self.skill_description
            ));
        } else {
            parts.push("> 该技能未配置 SKILL.md 正文与说明。\n".to_string());
        }

        if !self.skill_path.trim().is_empty() {
            parts.push(format!(
                "## 本地资源目录\n- 技能根目录：`{}`\n- `references/` 含规范文档；`scripts/` 含脚手架/工具脚本（如 `setup_project.py`）。\n- 若工作流要求执行脚手架脚本，请先用 read_file 读取对应脚本内容，再通过沙箱（python/node）运行，禁止凭记忆臆造命令。\n",
                self.skill_path
            ));
        }

        parts.push(
            "## 执行要求\n你必须严格遵循上方 SKILL.md 的工作流（Workflow）与质量门禁（如：依赖版本固定、build 通过、测试通过）完成任务，不得仅凭通用经验现写文件。\n"
                .to_string(),
        );

        let result = parts.concat();
        tracing::info!(
            "[agent] skill__{}: 完成 result={}字符",
            self.skill_id,
            result.chars().count(),
        );
        Ok(result)
    }
}

/// 便捷：把若干 Skill 包装器直接注册进原生注册表（不做 Provider 区分时）。
/// **已废弃**：Skill 现改由 `pipeline::build_skill_guidance` 注入子任务 user 消息，不再注册为工具。
#[allow(dead_code)]
pub fn register_skills_into(registry: &mut ToolRegistry, skills: Vec<SkillToolWrapper>) {
    for s in skills {
        registry.register(Arc::new(s));
    }
}
