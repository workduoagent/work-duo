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
}

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
                "description": format!("[Skill] {}", self.skill_description),
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
        // 当前为只读包装：返回技能说明，真实执行后续接入业务核心。
        Ok(format!(
            "技能『{}』（id={}）已接收任务：{}\n（只读包装模式：真实业务执行待接入）",
            self.skill_name, self.skill_id, task
        ))
    }
}

/// 便捷：把若干 Skill 包装器直接注册进原生注册表（不做 Provider 区分时）。
pub fn register_skills_into(registry: &mut ToolRegistry, skills: Vec<SkillToolWrapper>) {
    for s in skills {
        registry.register(Arc::new(s));
    }
}
