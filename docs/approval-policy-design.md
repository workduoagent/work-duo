# 边审批策略引擎（15007）最终设计方案

> 版本：v1.0（2026-09-17 定稿，待批准开工）
> 前置讨论：用户两次修正——①拒绝「安全路径白名单」硬编码（`src/**` 猜测不可移植）；②警惕审批疲劳（连环弹卡）。本方案据此定形。
> 一句话：**在审批门禁处加一道「操作 × 危险信号」外层风险校验；硬编码只保留跨项目普适的危险信号极小集；策略评估前移到计划审批实现「一次授权整计划」；执行期只拦计划外变更；全自动模式零打断、轨迹高亮留痕。**

---

## 1. 设计原则（用户拍板记录）

1. **黑名单最小化**：硬编码只保留「跨项目普适的危险信号」（凭据/CI 供应链/依赖锁/系统边界，15 条级），绝不维护「安全路径白名单」——放行走原则判定（工作空间内 && 未命中信号），与项目目录结构无关。
2. **规则数据化**：信号表是数据常量，不是散落的 if；预留 `app_config` / 智能体级 `custom_risky_patterns` 注入口（首版做接口，设置页 UI 不做）。
3. **防疲劳三闸**：① 策略评估前移到计划审批（一次授权整计划）；② 执行期只拦计划外变更；③ 同类授权记忆（「本任务内记住」默认勾选）。
4. **never（全自动）模式 = 零打断**（维持 20260914013/14 拍板）：策略命中不弹卡，照常执行，但轨迹/状态栏高亮留痕可见。

---

## 2. 策略模型

### 2.1 边类型（从工具名 + 参数提取，只读操作不评估）

| 边类型 | 来源工具 | 评估目标 |
| --- | --- | --- |
| Wrote | `native__write_file` | 目标路径 |
| Delete | `native__delete_path` | 目标路径 |
| Move | `native__move_path` | from 与 to **都评估** |
| Exec | `native__run_python_sandbox` / `run_node_sandbox` | 脚本路径（代码内容不静态评） |
| Network | `native__http_request` | URL host |
| 只读（read/list/grep） | — | 不评估，恒放行 |
| MCP / 插件 | — | 静态 RequireApproval 已覆盖，策略不重复评 |

### 2.2 危险信号表（`RISKY_SIGNALS`，共享常量）

| 类别 category | 模式（小写包含匹配） | 说明 |
| --- | --- | --- |
| `credential` | `.env`、`id_rsa`、`.pem`、`credentials` | 凭据泄露 |
| `ci` | `.github/workflows`、`.gitlab-ci`、`jenkinsfile`、`azure-pipelines` | CI/CD 供应链 |
| `lock` | `package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`cargo.lock`、`poetry.lock` | 依赖锁投毒 |
| `sys` | 工作空间外（PathGuard 判定）、`c:\windows`、`/etc/`、`/usr/`、`/proc/`、`/sys/`、`appdata` | 系统边界 |

刻意不收录 `password` / `token` / `secret` 等过泛词（沿用 recovery 表的既有结论）。

### 2.3 评估函数

```rust
pub struct PolicyHit {
    pub category: &'static str,   // credential | ci | lock | sys
    pub pattern: &'static str,    // 命中的信号
    pub target: String,           // 命中的路径/URL
}

/// 命中任一信号 → Some(hit)（弹审批）；全部未命中 → None（放行）。
pub fn evaluate(op: EdgeOp, workspace: Option<&Path>, targets: &[String]) -> Option<PolicyHit>
```

- 工作空间外判定复用既有 `PathGuard` 语义（canonicalize 后前缀比较）；
- 大小写不敏感（Windows 路径）；
- `Move` 对 from/to 分别评估，任一命中即算。

### 2.4 授权记忆（grants）

```rust
// runtime 上的共享状态，随任务启动 reset（与 plan_approval.reset() 同一批）
approval_grants: Mutex<HashSet<String>>   // key = "{op}:{pattern}"
```

- 计划批准 / 「记住」勾选 → 插入 key；
- 执行期门禁：命中信号但 key 已在 grants → 放行；
- 任务结束 / 取消 → 随启动重置区清空。

---

## 3. 决策流（三道闸落地）

### 3.1 闸 1：计划审批 = 一次授权整计划

```text
规划完成 → 门禁处对整个 DAG 逐步评估 → 敏感操作清单
  ├─ 清单为空 → 计划审批卡维持现状（零变化）
  └─ 清单非空 → PlanApprovalRequest.sensitive_ops 携带清单
        → 计划审批卡新增「⚠ 本计划包含 N 处敏感操作」区块（step/操作/目标/类别）
        → 用户点「批准执行」= 批准计划 + 全部清单写入 grants
        → 「修改意见」→ 重规划 → 重新评估重新列
        → 「拒绝」→ 终止（grants 随任务清空）
```

### 3.2 闸 2：执行期门禁 = 只拦计划外变更

```text
工具轮审批门禁处（现有 sensitive 判定之后追加）：
  静态 RequireApproval（插件等）→ 走既有审批（不变）
  否则 policy::evaluate(op, targets)
    ├─ None → 放行（常态，零开销）
    ├─ 命中且 key ∈ grants → 放行（计划内已授权 / 已记住）
    └─ 命中且 key ∉ grants → 弹审批卡（description 附命中原因）
          + 「本任务内记住该授权」checkbox（默认勾选）
          → 决策回传时勾选则写入 grants
```

- 弹卡时机即「模型跑偏」的信号——打断本身有信息量；
- never 模式跳过本闸（见 3.3）。

### 3.3 never（全自动）模式 = 零打断 + 高亮留痕（方案 A）

- 命中信号**不弹卡**，操作照常执行；
- 工具步骤事件追加 `sensitive: true, sensitive_reason: "写入 CI 配置"`；
- 前端：执行图 ToolStep / 过程面板对该步渲染警示角标；状态栏过一条「⚠ 敏感操作：…」；
- 语义：维持 20260914013/14「零人工打断」拍板，安全靠「可见性」而非「打断」。

---

## 4. 与既有机制的关系

| 机制 | 关系 |
| --- | --- |
| 静态 RequireApproval（插件/http_request 恒审批） | **优先级最高**，策略不重复评、不改语义 |
| `effective_auto_exec`（auto_exec × 意图风险） | 保持不变；策略门禁在其**之后**追加评估 |
| `plan_auto_approve_mode` | never → 方案 A（3.3）；always/sensitive → 走完整三道闸 |
| `recovery.rs::classify_tier` 的 RISKY 表 | **去重**：改为引用本引擎共享常量（分类别），行为不变 |
| PathGuard（工作空间边界） | `sys` 类信号复用其判定，不重写 |
| 处置中心（20260917001） | 弹出的审批卡自然落在处置 Tab，UI 零改动 |

---

## 5. 类型与接口变更（前后端）

**Rust：**

```rust
// types.rs / plan_approval.rs
pub struct SensitiveOp { pub step: u32, pub op: String, pub target: String,
                         pub category: String, pub pattern: String }
pub struct PlanApprovalRequest { ..., pub sensitive_ops: Vec<SensitiveOp> }   // 新增字段

// approval 请求（门禁弹卡时注入）
pub struct ApprovalRequest { ..., pub reason: Option<String>, pub grant_key: Option<String> } // 新增

// commands.rs SubmitApprovalDecision / SubmitPlanDecision
pub remember: bool   // 新增（默认 false；勾选「记住」时 true）
// → 决策回传时 remember=true 且带 grant_key → runtime.approval_grants 插入
```

**TS：** `types.ts` 的 `ApprovalRequest` / `PlanApprovalRequest` 同步新增字段；`DecisionCenter` 两卡渲染新区块与勾选框。

**前端小改清单：**

| 文件 | 改动 |
| --- | --- |
| `session/types.ts` | ApprovalRequest/PlanApprovalRequest 新字段；AgentStep 加 `sensitive?` |
| `DecisionCenter.tsx` | PlanApprovalContent 渲染敏感清单；ApprovalContent 渲染命中原因 + 「记住」勾选 |
| `chat/message-ui.tsx`（ToolStep） | `sensitive` 步骤渲染警示角标 |
| `chat.scss` | 清单/角标样式（复用 warning 令牌） |

---

## 6. 任务拆解（依赖序）

| 序 | 任务 | 验收 |
| --- | --- | --- |
| T1 | `policy.rs`：RISKY_SIGNALS + EdgeOp 提取 + evaluate + grants 结构 | 单测矩阵绿（操作×路径→期望） |
| T2 | 计划门禁接入：DAG 全量评估 + `sensitive_ops` 附带 + 批准写 grants | 计划审批卡出现敏感清单；批准后执行期同操作不弹 |
| T3 | 执行期门禁接入：runtime 工具轮 + 计划外弹卡（reason/grant_key）+ remember 回传写 grants | 计划外写 `.env` 弹卡；勾记住后本任务再写不弹 |
| T4 | recovery RISKY 表去重引用共享常量 | 行为不变（classify_tier 单测绿） |
| T5 | 前端：计划审批卡敏感清单 / 授权卡原因+记住 / 轨迹敏感角标 | 三处渲染正确 |
| T6 | 真机验收路径（见 §8） | 全过翻 ✅ |

预估体量：中等（Rust 一个新模块 ~300 行 + 三处接线 + 前端小改），一个工作日内可完成含自测。

---

## 7. 单测矩阵（T1 必须）

| 用例 | 期望 |
| --- | --- |
| Wrote `src/views/Login.tsx`（工作空间内） | None（放行） |
| Wrote `.github/workflows/deploy.yml` | ci 命中 |
| Wrote `.env` | credential 命中 |
| Wrote `pnpm-lock.yaml` | lock 命中 |
| Delete 工作空间外 `E:\other\x` | sys 命中 |
| Delete 工作空间内 `old/a.txt` | None |
| Move 工作空间内→工作空间内 | None |
| Move to `C:\Windows\x` | sys 命中 |
| Exec 沙箱脚本（工作空间内） | None |
| Network `https://api.github.com` | None（域名不评估，v1 只看是否外联行为本身由静态规则管） |
| 大小写：`.ENV` / `C:\WINDOWS` | 命中（大小写不敏感） |

---

## 8. 真机验收路径

1. **盲区关闭**：auto 模式智能体发「创建 `.github/workflows/deploy.yml` 内容为 …」→ 批准计划时看到敏感清单 → 批准 → 执行期不再弹；
2. **计划外拦截**：批准一个普通计划后，追加消息「再写一个 `.env` 文件」→ 执行期弹授权卡（原因=credential）→ 勾「本任务内记住」授权 → 同任务再写 `.env` 不弹；
3. **普通放行回归**：写 `src/**` / 工作空间内普通文件全程零弹卡；
4. **never 模式**：切「从不审批」→ 同样任务零打断，但过程面板/状态栏出现「⚠ 敏感操作」高亮留痕；
5. **回归**：插件审批、recovery 四键、处置中心均不受影响。

---

## 9. 不做（Phase 2+）

- 自定义模式设置页 UI（首版只留配置注入口）；
- 域名/URL 深度评估（Network 只登记行为，不做 DLP）；
- 决策历史持久化（「记住」仅任务级；跨会话记忆待用户需求）；
- Exec 代码内容静态审计（依赖沙箱自身的既有安全边界）。

## 10. 回滚

策略层以 feature 开关常量（`POLICY_ENABLED: bool = true`）包裹，异常时一行改 false 即回退到现有门禁行为，不回滚代码结构。
