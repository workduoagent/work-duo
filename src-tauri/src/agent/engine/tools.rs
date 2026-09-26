//! 工具契约与注册表（对应方案步骤 1）。
//!
//! `AgentTool`：所有工具（原生 / Skill / MCP）统一实现的 trait；调度器只认它。
//! `PermissionLevel`：敏感度分级，决定是否需要用户审批（ApprovalManager 据此挂起）。
//! `ToolRegistry`：name → Arc<dyn AgentTool> 的注册表；运行时向 LLM 暴露其 `get_tools_for_llm()`。
//! `PathGuard`：绝对沙箱守卫，归一化路径、拦截 `..` 越界与符号链接逃逸，约束工具只能
//!   在用户授权的工作空间（workspace）内活动。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

/// 工具执行敏感度分级。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionLevel {
    /// 只读安全（如读取文件、列出目录）：自动执行，无需审批。
    ReadSafe,
    /// 需用户审批（如修改文件、执行命令、沙箱运行）：触发 ApprovalManager 挂起。
    RequireApproval,
}

/// 工具执行上下文（运行时在每次调用时注入）。
#[derive(Debug, Clone, Default)]
pub struct ToolContext {
    /// 用户授权的工作空间根目录（PathGuard 以此为沙箱边界）。
    pub workspace: Option<PathBuf>,
    /// 是否允许该智能体使用沙箱环境（agent.allow_sandbox）。
    pub sandbox_enabled: bool,
    /// 当前智能体 ID（原生工具据此把产出归属到具体智能体，如记忆沉淀）。
    pub agent_id: String,
    /// 当前会话 ID（原生工具据此把跨会话记忆归属到会话；空闲/非运行态为 None）。
    pub session_id: Option<String>,
    /// 当前 run id（服务器托管审计 server_exec_log 关联；无 run 场景为 None）。
    pub run_id: Option<String>,
    /// HTTP 请求主机白名单（由 app_config.http_allowed_hosts 解析后透传）：空 = 不限制；
    /// 非空 = native__http_request 仅放行命中列表中的主机（含其子域）。
    pub http_allowed_hosts: Vec<String>,
    /// 本子任务运行类工具（`native__run_python_sandbox` / `native__run_node_sandbox`）的
    /// 执行结果（含退出码），供 verifier 的 `command_succeeded` 通用判定。仅运行工具写入，
    /// 串行执行下安全累积；流水线每轮结束后统一 drain 进 `session_tool_outputs`。
    pub run_outcomes: std::sync::Arc<std::sync::Mutex<Vec<RunOutcome>>>,
}

/// 工具执行错误。
#[derive(Debug)]
pub enum ToolError {
    /// 入参非法（如路径越界、缺必填字段）。
    InvalidArgs(String),
    /// 执行失败（含底层 IO / 进程错误）。
    ExecutionFailed(String),
    /// 权限不足（如未授权沙箱却请求 run_sandbox）。
    PermissionDenied(String),
}

/// 一次「运行类」工具执行的结构化结果（退出码为通用判定真相源）。
///
/// 替代原先只回 stdout 裸字符串的做法：进程退出码 0 = 运行成功，与语言 / 框架 /
/// 输出措辞 / emoji 完全无关（同 `cargo check` 退出 0 即通过的契约）。verifier 的
/// `command_succeeded` 直接读 `exit_code`，不再去 stdout 文本里猜「过了没」。
/// 失败信息（含 stderr）由 `run_script_with_selfheal` 以 `Err(String)` 返回，故此处只留成功路径字段。
#[derive(Debug, Clone, Default)]
pub struct ScriptRunResult {
    pub stdout: String,
    pub exit_code: Option<i32>,
}

/// 单个工具（运行类）在本子任务内的执行结果摘要，供 verifier 通用判定使用。
/// - `output`：工具 stdout（供 `stdout_contains` 精确子串匹配）；
/// - `exit_code`：进程退出码（`Some(0)` = 成功），供 `command_succeeded` 判定；
///   非运行类工具不写入此列表，故其 `exit_code` 恒为 `None`。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunOutcome {
    pub output: String,
    pub exit_code: Option<i32>,
}

/// 授权域（HostAuthz 独立授权域分流，设计稿 docs/server-hosting-design.md §7.9）。
/// 调度器按域分流：Local → ApprovalManager（policy.rs 信号/grants）；
/// Host → HostAuthz（host_policy 信号 / host_grant 分表）。类型级杜绝串域。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthzDomain {
    Local,
    Host,
}

/// 工具行为元数据（台账 S6 进阶 / D1 第一步：**声明式**取代 runtime 侧按叶子名
/// 散落匹配的 `tool_op` / `is_file_mutating` / `is_file_reading` 三函数）。
///
/// 旧方案的坑：新增工具要记得去 runtime.rs 三个函数（+policy 映射）各补叶子名，
/// 漏配静默生效——文件变更工具漏标 = 不做快照 diff、不进 changed_files；
/// 危险工具漏标 op = policy 危险信号评估整段跳过。声明式后元数据与工具实现
/// 同处一地（写工具时自然看到），漏配面收敛为「写 impl 时漏一行」。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ToolBehavior {
    /// 操作动词：前端工具行展示 + policy `EdgeOp::from_op_str` 危险信号评估入口。
    /// **会产生策略边的工具（write/edit/replace/delete/move/exec/http）必须声明**，
    /// 否则危险信号检测对该工具失效（静态 check_permission 主闸仍在，但边审批
    /// 策略/grants 失效）。None = 无专属性动词（通用展示、策略跳过）。
    pub op: Option<&'static str>,
    /// 文件变更类：执行前后快照 diff + `changed_files` 聚合（接管面板「已改文件」）。
    pub file_mutating: bool,
    /// 文件读取类：执行成功后登记知识图 `Read` 边（记录哪步读了哪些文件）。
    pub file_reading: bool,
}

/// 统一工具契约。
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// 工具名（含命名空间，如 `native__edit_file`、`mcp__mineru__parse`）。
    fn name(&self) -> String;

    /// 对外暴露给 LLM 的 OpenAI function-calling 定义（name / description / parameters）。
    fn tool_definition(&self) -> serde_json::Value;

    /// 敏感度分级（决定是否需要审批）。
    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel;

    /// 授权域（默认 Local=本地审批边界；`host__*` 工具返回 Host 走 HostAuthz）。
    fn authz_domain(&self) -> AuthzDomain {
        AuthzDomain::Local
    }

    /// 行为元数据（声明式，默认「无动词 / 非变更 / 非读取」）。
    /// 语义见 [`ToolBehavior`]；危险操作类工具必须覆写 op 字段。
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior::default()
    }

    /// 执行工具（args 为 LLM 传入的 JSON 参数）。
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext)
        -> Result<String, ToolError>;
}

/// 工具注册表：name → 工具实例。
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// 注册一个工具（重名将被覆盖）。
    pub fn register(&mut self, tool: Arc<dyn AgentTool>) {
        self.tools.insert(tool.name(), tool);
    }

    /// 按 name 取工具（供调度器派发）。
    pub fn get(&self, name: &str) -> Option<Arc<dyn AgentTool>> {
        self.tools.get(name).cloned()
    }

    /// 列出已注册工具名（接管面板展示原生工具栈用，2b-2）。
    pub fn tool_names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }

    /// 生成给 LLM 的 tools 数组（OpenAI function-calling 格式）。
    pub fn get_tools_for_llm(&self) -> Vec<serde_json::Value> {
        self.tools
            .values()
            .map(|t| t.tool_definition())
            .collect()
    }

    /// 规划器能力摘要（台账 S6：工具「提示与能力同源」自动化）。
    ///
    /// 从全部已注册工具的 `tool_definition()` 自动派生 `(工具名, 一句话摘要)` 清单，
    /// `planner::capability_outline` 的工具清单以此为准——**未注册的工具不会出现在
    /// 大纲，新增/删除工具无需改 planner**，消灭「注册表与能力大纲双维护」
    /// （漏写=规划器判任务不可执行，2026-09-25 E2E 实锤）。
    /// 按工具名排序保证输出稳定（HashMap 遍历序随机，大纲文案需确定性）。
    pub fn planner_digest(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .tools
            .values()
            .map(|t| {
                let def = t.tool_definition();
                let desc = def
                    .get("function")
                    .and_then(|f| f.get("description"))
                    .and_then(|d| d.as_str())
                    .unwrap_or("");
                (t.name(), first_sentence(desc))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}

/// 取工具描述首句作规划摘要（台账 S6）：按 `。`/`；`/`;`/换行 切第一段，
/// 超长截断到 48 字符（规划大纲只需「这是干什么的」，细则由执行模型的 tools
/// 数组全量 description 承载）。
fn first_sentence(desc: &str) -> String {
    let head = desc
        .split(['。', '；', ';', '\n', '\r'])
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("");
    head.chars().take(48).collect()
}

#[cfg(test)]
mod digest_tests {
    use super::first_sentence;

    #[test]
    fn first_sentence_takes_first_clause() {
        assert_eq!(
            first_sentence("读取工作空间内指定路径的文件。支持文本与图片。第二句"),
            "读取工作空间内指定路径的文件"
        );
    }

    #[test]
    fn first_sentence_splits_on_semicolon_and_newline() {
        assert_eq!(first_sentence("执行命令；第二个分句\n第二行"), "执行命令");
        assert_eq!(first_sentence("a; b; c"), "a");
    }

    #[test]
    fn first_sentence_truncates_long_head() {
        let long = "这是一个没有任何句读的超长描述".repeat(10);
        let out = first_sentence(&long);
        assert_eq!(out.chars().count(), 48);
    }

    #[test]
    fn first_sentence_handles_empty_and_whitespace() {
        assert_eq!(first_sentence(""), "");
        assert_eq!(first_sentence("   \n  x。y"), "x");
    }
}

/// 绝对沙箱守卫。
///
/// 所有涉及文件系统的原生工具都必须先经 `PathGuard::check` 归一化并校验，
/// 确保解析后的最终路径仍在 `ctx.workspace` 内，防止 `../` 越界或符号链接逃逸。
pub struct PathGuard;

impl PathGuard {
    /// 校验并归一化相对/绝对路径，返回绝对路径。
    ///
    /// - `workspace` 为 None 时拒绝一切文件操作（未授权工作空间）；
    /// - 解析后路径必须仍位于 workspace 之下（含 workspace 自身），否则返回 InvalidArgs。
    pub fn check(path: &str, ctx: &ToolContext) -> Result<PathBuf, ToolError> {
        let ws = ctx
            .workspace
            .as_ref()
            .ok_or_else(|| ToolError::PermissionDenied("未设置工作空间，文件操作被拒绝".into()))?;

        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            ws.join(path)
        };

        // 两级归一化：
        // ① 文件存在 → canonicalize 拿到真实物理路径（解析 symlink），边界比对最准；
        // ② 文件不存在（如「要新建的文件」）→ canonicalize 失败，回退纯组件级的逻辑归一化，
        //    解析 `..`/`.` 后做边界比对。注意：不能把 canonicalize 失败的原样路径直接比，
        //    否则 `../../etc/passwd` 这类含 `..` 的路径会被 starts_with 按组件前缀误判「在工作空间内」（越界漏洞）。
        let normalized = match std::fs::canonicalize(&candidate) {
            Ok(real) => real,
            Err(_) => logical_normalize(&candidate)?,
        };

        let ws_norm = match std::fs::canonicalize(ws) {
            Ok(real) => real,
            Err(_) => logical_normalize(ws)?,
        };

        // 比较前统一剥离 Windows 的 `\\?\` 前缀（verbatim 前缀）并（Windows 下）忽略大小写：
        // 文件存在时 canonicalize 返回带 `\\?\` 前缀的绝对路径，不存在时回退到不带前缀的原样
        // 路径，二者混用会导致 starts_with 误判「越界」（同在工作空间内却报失败）。
        let n = normalize_for_guard(&normalized);
        let w = normalize_for_guard(&ws_norm);
        if n != w && !n.starts_with(&w) {
            return Err(ToolError::InvalidArgs(format!(
                "路径越界：{} 不在工作空间 {} 之内",
                normalized.display(),
                ws_norm.display()
            )));
        }
        Ok(normalized)
    }

    /// TOCTOU 二次确认：文件句柄已打开后，确认其真实物理路径未逃逸出 workspace。
    ///
    /// - Unix：基于文件描述符解析 `/proc/self/fd/<fd>` 的真实路径（强保证，可捕获 symlink 替换）；
    /// - Windows：无 `/proc/self/fd`，退化为对 abs 重新 canonicalize 并与 workspace 比对
    ///   （仍优于单次 `check` 校验，能捕获 open 前的 symlink 替换窗口）。
    pub fn verify_opened(
        abs: &Path,
        file: &std::fs::File,
        ctx: &ToolContext,
    ) -> Result<(), ToolError> {
        let ws = ctx
            .workspace
            .as_ref()
            .ok_or_else(|| ToolError::PermissionDenied("未设置工作空间，文件操作被拒绝".into()))?;
        let real = resolve_real_path(abs, file)?;
        let ws_norm = std::fs::canonicalize(ws).unwrap_or_else(|_| ws.clone());
        let r = normalize_for_guard(&real);
        let w = normalize_for_guard(&ws_norm);
        if r != w && !r.starts_with(&w) {
            return Err(ToolError::PermissionDenied(format!(
                "TOCTOU 检测：文件真实路径 {:?} 逃逸工作空间 {:?}",
                real, ws_norm
            )));
        }
        Ok(())
    }
}

/// 解析已打开文件句柄的真实物理路径（平台相关），供 `verify_opened` 做边界比对。
#[cfg(unix)]
fn resolve_real_path(abs: &Path, file: &std::fs::File) -> Result<PathBuf, ToolError> {
    let _ = abs;
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    std::fs::canonicalize(format!("/proc/self/fd/{}", fd))
        .map_err(|e| ToolError::PermissionDenied(format!("TOCTOU：无法解析 fd 真实路径：{e}")))
}

#[cfg(windows)]
fn resolve_real_path(abs: &Path, _file: &std::fs::File) -> Result<PathBuf, ToolError> {
    let _ = abs;
    std::fs::canonicalize(abs)
        .map_err(|e| ToolError::PermissionDenied(format!("TOCTOU：无法确认文件真实路径：{e}")))
}

#[cfg(not(any(unix, windows)))]
fn resolve_real_path(abs: &Path, _file: &std::fs::File) -> Result<PathBuf, ToolError> {
    let _ = abs;
    Err(ToolError::PermissionDenied(
        "当前平台不支持文件描述符级 TOCTOU 校验".into(),
    ))
}

/// 路径比较前的归一化：剥离 Windows 的 `\\?\` 前缀（verbatim 前缀），Windows 下转小写，
/// 使「文件存在（带前缀）」与「文件不存在（无前缀）」两种情形下的路径可一致比较。
fn normalize_for_guard(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace("\\\\?\\", "");
    let s = if cfg!(windows) { s.to_lowercase() } else { s };
    PathBuf::from(s)
}

/// 纯逻辑路径归一化（不依赖文件是否存在，不做任何 IO）。
///
/// 逐个组件处理：遇 `..` 弹出上一段；遇 `.` 跳过；其余压栈。用于 `canonicalize`
/// 失败（目标不存在）时的边界比对——把 `a/../b.txt` 解析为 `ws/b.txt`、把
/// `../../etc/passwd` 解析为 `etc/passwd`（明显越界）。
///
/// **逃逸判定**：若 `..` 弹出导致栈空（已到文件系统根仍上溯，或相对路径回退越过起点），
/// 视为路径逃逸工作空间边界，返回 `InvalidArgs` 拒绝，而非「尽力而为」继续比对。
fn logical_normalize(p: &Path) -> Result<PathBuf, ToolError> {
    let mut stack: Vec<Component> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                // 弹出上一段；若已到根或相对起点（栈空）则视为逃逸。
                match stack.last() {
                    None => {
                        return Err(ToolError::InvalidArgs(format!(
                            "路径逃逸工作空间边界：{}",
                            p.display()
                        )))
                    }
                    Some(c) if matches!(c, Component::RootDir | Component::Prefix(_)) => {
                        return Err(ToolError::InvalidArgs(format!(
                            "路径逃逸工作空间边界：{}",
                            p.display()
                        )))
                    }
                    Some(_) => {
                        stack.pop();
                    }
                }
            }
            Component::CurDir => { /* 跳过 `.` */ }
            other => stack.push(other),
        }
    }
    let mut result = PathBuf::new();
    for comp in stack {
        result.push(comp.as_os_str());
    }
    Ok(result)
}

