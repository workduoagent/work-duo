//! 边审批策略引擎（15007）。
//!
//! **与 `host/policy.rs`（host 域）硬隔离**：本地信号表与 grants 不适用于 host__* 工具，
//! host 侧同样独立声明 `host:` 前缀信号——两侧勿混用（调度层按 authz_domain 分流）。
//!
//! 在审批门禁处追加一道「操作 × 危险信号」外层风险校验，补静态按工具审批的权限盲区
//! （如 auto 模式下静默写 `.env` / `.github/workflows` / 依赖锁）。
//!
//! 设计原则（用户拍板，见 docs/approval-policy-design.md）：
//! 1. **黑名单最小化**：硬编码仅保留「跨项目普适的危险信号」极小集（credential/ci/lock/sys），
//!    绝不维护「安全路径白名单」——放行走原则判定（工作空间内 && 未命中信号），与项目目录结构无关；
//! 2. **规则数据化**：信号表是数据常量，预留 `custom_risky_patterns` 配置注入口（首版接口）；
//! 3. **防疲劳**：策略评估前移到计划审批（批准=一次授权整计划敏感清单，写入 grants）；
//!    执行期只拦「计划外变更」；命中但已授权（grants 命中）→ 放行；
//! 4. **never 全自动 = 零打断**：命中不弹卡，调用方以 `sensitive=true` 高亮轨迹留痕。
//!
//! 层级：静态 RequireApproval（插件/http_request 恒审批）优先于本策略；策略不重复评静态已拦项。

use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

/// 策略总开关（异常时一行改 false 即回退到既有门禁行为）。
pub const POLICY_ENABLED: bool = true;

/// 执行期「本任务内记住」等授权的持有上限（防无限增长；任务级生命周期）。
const GRANTS_MAX: usize = 64;

/// 危险信号表（跨项目普适，小写包含匹配）。
///
/// 分类：credential=凭据 / ci=CI-CD 供应链 / lock=依赖锁 / sys=系统边界。
/// 刻意**不**收录 `password` / `token` / `secret` 等过泛词（沿用 recovery 表既有结论）。
pub const RISKY_SIGNALS: &[(&str, &str)] = &[
    // credential：凭据泄露
    ("credential", ".env"),
    ("credential", "id_rsa"),
    ("credential", ".pem"),
    ("credential", "credentials"),
    // ci：CI/CD 供应链
    ("ci", ".github/workflows"),
    ("ci", ".gitlab-ci"),
    ("ci", "jenkinsfile"),
    ("ci", "azure-pipelines"),
    // lock：依赖锁投毒
    ("lock", "package-lock.json"),
    ("lock", "yarn.lock"),
    ("lock", "pnpm-lock.yaml"),
    ("lock", "cargo.lock"),
    ("lock", "poetry.lock"),
    ("lock", "composer.lock"),
    // sys：系统目录（工作空间外由 PathGuard 同源判定单独处理）
    ("sys", "c:\\windows"),
    ("sys", "/etc/"),
    ("sys", "/usr/"),
    ("sys", "/proc/"),
    ("sys", "/sys/"),
    ("sys", "appdata"),
];

/// 边/操作类型（从工具名映射；只读操作不产生边，恒放行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeOp {
    /// write_file / edit_file / regex_replace：内容写入
    Wrote,
    /// delete_path
    Deleted,
    /// move_path
    Moved,
    /// run_python_sandbox / run_node_sandbox / execute_command
    Exec,
    /// http_request
    Network,
}

impl EdgeOp {
    /// 从工具声明式元数据 `ToolBehavior.op`（tools.rs）映射（台账 S6 进阶：
    /// 旧实现经 runtime::tool_op 叶子名匹配，已随声明式改造移除）。
    pub fn from_op_str(op: &str) -> Option<Self> {
        match op {
            "write" | "edit" | "replace" => Some(Self::Wrote),
            "delete" => Some(Self::Deleted),
            "move" => Some(Self::Moved),
            "exec" => Some(Self::Exec),
            "http" => Some(Self::Network),
            _ => None,
        }
    }
}

/// 从工具入参提取策略评估目标（与 `tool_path` 字段约定一致，Move 评估双端）。
pub fn edge_targets(op: EdgeOp, args: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |v: Option<&str>| {
        if let Some(s) = v {
            let s = s.trim();
            if !s.is_empty() {
                out.push(s.to_string());
            }
        }
    };
    match op {
        EdgeOp::Moved => {
            push(args.get("source").and_then(|v| v.as_str()));
            push(args.get("from").and_then(|v| v.as_str()));
            push(args.get("to").and_then(|v| v.as_str()));
            push(args.get("destination").and_then(|v| v.as_str()));
        }
        EdgeOp::Network => {
            push(args.get("url").and_then(|v| v.as_str()));
        }
        EdgeOp::Exec => {
            // 沙箱/命令类工具的脚本路径在运行时才生成（.wd_mem/runtime/scripts/...），
            // 入参里没有目标路径 → 计划审批写入的 grants（按信号 key）对沙箱步骤永不命中，
            // 「批准=一次授权整计划」被静态卡截胡（真机 2026-09-17 场景 B：步骤 1 沙箱建目录
            // 仍弹卡）。修复：按行扫描 code/command 内容本身——既让计划文本扫描与执行期
            // 命中同源（同 grant_key，计划授权可覆盖沙箱步骤），也使脚本中的敏感路径
            // 字面量（如脚本里写 .env）可被策略看见。命中 target=具体行，便于卡片展示。
            push(args.get("path").and_then(|v| v.as_str()));
            push(args.get("file").and_then(|v| v.as_str()));
            for key in ["code", "command", "script"] {
                if let Some(content) = args.get(key).and_then(|v| v.as_str()) {
                    for line in content.lines() {
                        let line = line.trim();
                        if !line.is_empty() {
                            out.push(line.to_string());
                        }
                    }
                }
            }
        }
        _ => {
            push(args.get("path").and_then(|v| v.as_str()));
            push(args.get("file").and_then(|v| v.as_str()));
        }
    }
    out
}

/// 策略命中（一次评估至多返回一条：按信号表顺序首个命中）。
#[derive(Debug, Clone)]
pub struct PolicyHit {
    pub category: &'static str,
    pub pattern: &'static str,
    pub target: String,
}

impl PolicyHit {
    /// grants / 计划授权使用的 key：信号粒度（同信号不同操作共享授权）。
    pub fn grant_key(&self) -> String {
        format!("{}:{}", self.category, self.pattern)
    }
}

/// 目标是否在工作空间之外。相对路径视为工作空间内（执行器 PathGuard 仍会强制拦截）。
fn is_outside_workspace(target: &str, workspace: Option<&str>) -> bool {
    let Some(ws) = workspace else {
        return false;
    };
    let p = Path::new(target);
    if p.is_relative() {
        return false;
    }
    // 统一去 `\\?\` 前缀并小写比较（Windows 大小写不敏感）
    let norm = |s: &str| s.replace(r"\\?\", "").replace('/', "\\").to_lowercase();
    !norm(target).starts_with(&norm(ws))
}

/// 执行期评估：对给定边与目标做信号匹配。
/// `workspace` 用于「工作空间外」判定（sys 类）；相对目标视为工作空间内。
/// v1 信号表全部为路径/文件名特征，`op` 仅作语义占位（未来 Network 域名评估时启用）。
pub fn evaluate_edge(
    op: EdgeOp,
    targets: &[String],
    workspace: Option<&str>,
) -> Option<PolicyHit> {
    let _ = op; // v1 未用；保留参数位
    if !POLICY_ENABLED {
        return None;
    }
    for target in targets {
        let hay = target.to_lowercase();
        // Windows 路径分隔符归一化：模式统一用 `/`，匹配时同时对照原始与 `\`→`/` 形式
        let hay_norm = hay.replace('\\', "/");
        for (category, pattern) in RISKY_SIGNALS {
            let pat_norm = pattern.replace('\\', "/");
            // sys 目录特征与「工作空间外」分开判定
            let hit = if *category == "sys" {
                is_outside_workspace(target, workspace)
                    || hay.contains(pattern)
                    || hay_norm.contains(&pat_norm)
            } else {
                hay.contains(pattern) || hay_norm.contains(&pat_norm)
            };
            if hit {
                return Some(PolicyHit {
                    category,
                    pattern,
                    target: target.clone(),
                });
            }
        }
    }
    None
}

/// 计划级评估（闸 1：计划审批前对 DAG 文本扫描）。sys 类无法从文本判定，不在计划级评估。
pub struct PlanHit {
    pub step: u32,
    pub title: String,
    pub category: &'static str,
    pub pattern: &'static str,
}

/// 对单个计划步骤的标题+描述做信号扫描（title/description 小写包含匹配）。
pub fn evaluate_plan_step(step: u32, title: &str, description: &str) -> Vec<PlanHit> {
    if !POLICY_ENABLED {
        return Vec::new();
    }
    let hay = format!("{} {}", title, description).to_lowercase();
    let mut out = Vec::new();
    for (category, pattern) in RISKY_SIGNALS {
        if *category == "sys" {
            continue; // 系统边界只能在执行期按真实路径判定
        }
        if hay.contains(pattern) {
            out.push(PlanHit {
                step,
                title: title.to_string(),
                category,
                pattern,
            });
        }
    }
    out
}

/// 计划级敏感操作（闸 1：随计划审批卡下发，批准时整单写入 grants）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSensitiveOp {
    pub step: usize,
    pub title: String,
    pub category: String,
    pub pattern: String,
}

/// 计划级评估（闸 1）：对 DAG 全部步骤的标题+描述做信号扫描（sys 类需真实路径，不在计划级评估）。
pub fn evaluate_plan(plan: &crate::agent::types::PlanDAG) -> Vec<PlanSensitiveOp> {
    let mut out = Vec::new();
    for t in &plan.tasks {
        for hit in evaluate_plan_step(t.step as u32, &t.title, &t.description) {
            out.push(PlanSensitiveOp {
                step: hit.step as usize,
                title: hit.title,
                category: hit.category.to_string(),
                pattern: hit.pattern.to_string(),
            });
        }
    }
    out
}

/// 「本任务内记住」授权集合（信号粒度：命中同 category+pattern 的后续操作放行）。
/// 任务级生命周期：run_task 启动重置、结束随进程态自然废弃。
#[derive(Default)]
pub struct ApprovalGrants {
    inner: Mutex<HashSet<String>>,
}

impl ApprovalGrants {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashSet::new()),
        }
    }

    /// 写入授权（计划批准批量写入 / 「记住」单条写入）。超上限丢弃最旧语义由容量兜底。
    pub fn grant(&self, key: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.len() >= GRANTS_MAX {
            return;
        }
        g.insert(key.to_string());
    }

    pub fn contains(&self, key: &str) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).contains(key)
    }

    pub fn reset(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "E:\\WorkDuoTest";

    #[test]
    fn normal_workspace_write_passes() {
        let hit = evaluate_edge(EdgeOp::Wrote, &[format!("{WS}\\src\\views\\Login.tsx")], Some(WS));
        assert!(hit.is_none());
    }

    #[test]
    fn ci_workflow_hits() {
        let hit = evaluate_edge(
            EdgeOp::Wrote,
            &[format!("{WS}\\.github\\workflows\\deploy.yml")],
            Some(WS),
        );
        let hit = hit.expect("应命中 ci");
        assert_eq!(hit.category, "ci");
        assert_eq!(hit.pattern, ".github/workflows");
    }

    #[test]
    fn env_file_hits_credential() {
        let hit = evaluate_edge(EdgeOp::Wrote, &[format!("{WS}\\.env")], Some(WS));
        assert_eq!(hit.expect("应命中").category, "credential");
    }

    #[test]
    fn lock_file_hits() {
        let hit = evaluate_edge(EdgeOp::Wrote, &[format!("{WS}\\pnpm-lock.yaml")], Some(WS));
        assert_eq!(hit.expect("应命中").category, "lock");
    }

    #[test]
    fn outside_workspace_hits_sys() {
        let hit = evaluate_edge(
            EdgeOp::Deleted,
            &["D:\\Other\\project\\x.txt".into()],
            Some(WS),
        );
        assert_eq!(hit.expect("工作空间外应命中 sys").category, "sys");
    }

    #[test]
    fn relative_path_is_inside() {
        let hit = evaluate_edge(EdgeOp::Deleted, &["old/a.txt".into()], Some(WS));
        assert!(hit.is_none());
    }

    #[test]
    fn move_evaluates_both_ends() {
        let hit = evaluate_edge(
            EdgeOp::Moved,
            &[format!("{WS}\\a.txt"), "C:\\Windows\\a.txt".into()],
            Some(WS),
        );
        assert_eq!(hit.expect("to 端系统目录应命中").category, "sys");
    }

    #[test]
    fn exec_inside_passes() {
        let hit = evaluate_edge(
            EdgeOp::Exec,
            &[format!("{WS}\\.wd_mem\\runtime\\scripts\\x.py")],
            Some(WS),
        );
        assert!(hit.is_none());
    }

    #[test]
    fn network_v1_not_evaluated() {
        let hit = evaluate_edge(EdgeOp::Network, &["https://api.github.com".into()], None);
        assert!(hit.is_none());
    }

    #[test]
    fn case_insensitive_windows_paths() {
        let hit = evaluate_edge(EdgeOp::Wrote, &[format!("{WS}\\.ENV")], Some(WS));
        assert!(hit.is_some(), "大小写不敏感：.ENV 应命中 credential");
    }

    #[test]
    fn grants_roundtrip() {
        let g = ApprovalGrants::new();
        let hit = PolicyHit {
            category: "ci",
            pattern: ".github/workflows",
            target: String::new(),
        };
        assert!(!g.contains(&hit.grant_key()));
        g.grant(&hit.grant_key());
        assert!(g.contains(&hit.grant_key()));
        g.reset();
        assert!(!g.contains(&hit.grant_key()));
    }

    #[test]
    fn plan_step_text_scan_hits() {
        let hits = evaluate_plan_step(1, "更新 CI 配置", "修改 .github/workflows/deploy.yml");
        assert!(hits.iter().any(|h| h.category == "ci"));
        // 纯普通任务不命中
        assert!(evaluate_plan_step(2, "创建问候文件", "写入 a.txt 内容 hello").is_empty());
    }

    #[test]
    fn exec_code_content_scanned_same_grant_key_as_plan() {
        // 真机场景 B 回归：沙箱脚本内容含 .github/workflows → 执行期命中 ci，
        // grant_key 必须与计划文本扫描同源，计划批准写入的 grants 才能覆盖沙箱步骤。
        let args = serde_json::json!({
            "code": "import os\ntarget_dir = \".github/workflows\"\nos.makedirs(target_dir, exist_ok=True)"
        });
        let targets = edge_targets(EdgeOp::Exec, &args);
        let hit = evaluate_edge(EdgeOp::Exec, &targets, Some("E:\\WorkDuoTest"))
            .expect("code 含 ci 路径应命中");
        assert_eq!(hit.category, "ci");
        assert_eq!(hit.grant_key(), "ci:.github/workflows");
        // 命中目标应为具体行（非整段脚本），便于卡片展示
        assert!(hit.target.contains(".github/workflows"));
        assert!(hit.target.len() < 200);
        // 无敏感内容的普通脚本不命中
        let plain = serde_json::json!({"code": "print('hello')\n"});
        assert!(evaluate_edge(
            EdgeOp::Exec,
            &edge_targets(EdgeOp::Exec, &plain),
            Some("E:\\WorkDuoTest")
        )
        .is_none());
    }
}
