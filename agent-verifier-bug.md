# Agent 校验器（verifier.rs）「| 多候选路径」不一致 BUG · 待修复清单

> 状态：**仅记录，未改代码**。原因：当前在跑整流程测试，改一处就要重跑 Agent 浪费 token。
> 等全流程日志到后，与本文件合并做一次统一分析（优化点 + BUG）。
> 记录时间：2026-09-09 · 代码 HEAD = `96fe050`

---

## 1. 问题现象（用户实测）

输入的 Agent 指令（React 前端开发工程师 / react-developer skill）：

> 在 `E:\WorkDuoTest` 工作目录创建项目 `oa-web`，用 react-developer 搭 Vite + TS + 路由 + zustand + tanstack-query + tailwind + vitest 的 `shop` 项目。

Agent 实际**已把全部产物正确生成**（实测 `E:\WorkDuoTest\oa-web\tailwind.config.js` 存在、170 字节、非空，10 个文件齐全）。但运行中途**频繁弹授权卡死**：

```
步骤受阻 · 需要你的决策
智能体 React软件开发工程师 在步骤 1「创建 Vite + TypeScript 项目并配置依赖」
自动重试后仍失败，请选择如何处理。
受阻原因：校验未通过（文件应存在且非空：
\\?\E:\WorkDuoTest\oa-web\tailwind.config.js|oa-web\tailwind.config.ts）
```

本质：Agent 自报成功，但 verifier 判其未闭环 → 反复重试 → 卡授权。

---

## 2. 根因（一句话）

`verifier.rs` 的**文件类校验（`file_exists` / `file_nonempty` / `directory_exists` / `json_valid` / `excel_row_count`）不支持 `|` 多候选路径**，而 planner 生成的 `success_criteria.target` 里带了 `|` 候选（`.js | .ts`）。
verifier 把整串 `...tailwind.config.js|oa-web\tailwind.config.ts` 当成一个**含 `|` 的非法路径**去 `metadata()`，必然失败 —— 即使文件真实存在且非空。

这与 `text_contains` 分支（已对 `value` 做 `|` 分割容错）**不对称**。

---

## 3. 证据链

| 位置 | 内容 | 性质 |
|---|---|---|
| `verifier.rs:99-106` | `text_contains` 的 `value` 做了 `split('|')` 多候选容错 | ✅ 唯一有容错的分支 |
| `verifier.rs:48-50` | `file_exists`：`resolve_path(target, workspace)` 直接 `Path::new(target.trim())`，**未 split** | ❌ 主因 |
| `verifier.rs:57-62` | `file_nonempty`：同上，对含 `|` 的串 `metadata()` 恒 `None` → `unwrap_or(false)` | ❌ 主因（本次触发点） |
| `verifier.rs:69-71` | `directory_exists`：同上 | ❌ 同类 |
| `verifier.rs:78` / `148` | `json_valid` / `excel_row_count`：`resolve_path(target, …)` 同样未 split | ❌ 同类 |
| `pipeline.rs:355` | 注入执行 prompt 时**已按 `split('|')`** 渲染「任一即可」 | ⚠️ 系统预期 target 可含 `|`，与 verifier 不一致 |
| 用户贴的报错串 | `\\?\E:\WorkDuoTest\oa-web\tailwind.config.js\|oa-web\tailwind.config.ts` 中 `\|` 即单条 target 整串 | 🔍 直接证据 |

`resolve_path`（`verifier.rs:28-37`）实现：绝对路径 `is_absolute()` 原样保留、不依赖 workspace；相对路径才以 workspace 为基准。

---

## 4. 已排除的干扰项（避免误改）

1. **工作目录错配（非主因）**：`pipeline.rs:548` 传 `ctx.workspace`，但绝对路径在 `resolve_path` 内原样保留，不依赖 workspace；即便相对候选 `oa-web\tailwind.config.ts` 被解析也因扩展名不符而失败。根因是 `|` 未分割，不是目录基准错。
2. **`\\?\` 长路径前缀（非主因）**：Windows 下 `\\?\` 前缀对 `metadata()` 透明可读；`tools.rs:197` 仅在工具**输出**时 `replace("\\?\\","")` 去掉前缀，verifier 的 `display()` 保留了它，属表面现象。
3. **Agent 没写文件（已证伪）**：实测 `oa-web/` 下 10 个文件齐全，`tailwind.config.js` 170 字节非空。

---

## 5. 推荐修复方案（待一起改，未应用）

在 `verifier.rs::check_one` 中，将所有**文件类分支的 `target` 统一按 `|` 分割为多候选**，遍历解析后**任一满足即通过**（`.js` 候选命中即过），与 `text_contains` 的容错对称。

### 5.1 新增辅助（放在 `resolve_path` 之后）

```rust
/// 把 target 按 `|` 拆成多个候选路径（与 text_contains 的 value 容错对称）。
/// 单一路径（无 `|`）时退化为单元素向量，完全向后兼容。
fn resolve_candidates(target: &str, workspace: Option<&Path>) -> Vec<PathBuf> {
    target
        .split('|')
        .map(|x| resolve_path(x.trim(), workspace))
        .collect()
}

/// 在候选中找第一个满足谓词的文件/目录；找不到返回 None。
fn first_hit<F>(cands: &[PathBuf], pred: F) -> Option<PathBuf>
where
    F: Fn(&std::fs::Metadata) -> bool,
{
    cands
        .iter()
        .find(|p| p.metadata().map(|m| pred(&m)).unwrap_or(false))
        .cloned()
}

/// 候选路径的人类可读拼接（用于失败明细）。
fn cands_disp(cands: &[PathBuf]) -> String {
    cands
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(" | ")
}
```

### 5.2 受影响的 5 个分支改写为「任一命中」

```rust
"file_exists" => {
    let target = match &c.target {
        Some(t) => t,
        None => return (false, "file_exists 缺 target".into()),
    };
    let cands = resolve_candidates(target, workspace);
    match first_hit(&cands, |m| m.is_file()) {
        Some(p) => (true, format!("文件应存在：{}", p.display())),
        None => (false, format!("文件应存在（任一）：{}", cands_disp(&cands))),
    }
}
"file_nonempty" => {
    let target = match &c.target {
        Some(t) => t,
        None => return (false, "file_nonempty 缺 target".into()),
    };
    let cands = resolve_candidates(target, workspace);
    match first_hit(&cands, |m| m.is_file() && m.len() > 0) {
        Some(p) => (true, format!("文件应存在且非空：{}", p.display())),
        None => (false, format!("文件应存在且非空（任一）：{}", cands_disp(&cands))),
    }
}
"directory_exists" => {
    let target = match &c.target {
        Some(t) => t,
        None => return (false, "directory_exists 缺 target".into()),
    };
    let cands = resolve_candidates(target, workspace);
    match first_hit(&cands, |m| m.is_dir()) {
        Some(p) => (true, format!("目录应存在：{}", p.display())),
        None => (false, format!("目录应存在（任一）：{}", cands_disp(&cands))),
    }
}
"json_valid" => {
    let target = match &c.target {
        Some(t) => t,
        None => return (false, "json_valid 缺 target".into()),
    };
    let cands = resolve_candidates(target, workspace);
    // 任一候选可读且 JSON 可解析即通过
    let mut last_err = String::new();
    for p in &cands {
        match std::fs::read_to_string(p) {
            Ok(s) if serde_json::from_str::<serde_json::Value>(&s).is_ok() => {
                return (true, format!("JSON 应可解析：{}", p.display()));
            }
            Ok(_) => last_err = format!("JSON 解析失败：{}", p.display()),
            Err(e) => last_err = format!("读取失败 {}：{}", p.display(), e),
        }
    }
    (false, if last_err.is_empty() {
        format!("JSON 应可解析（任一）：{}", cands_disp(&cands))
    } else {
        last_err
    })
}
"excel_row_count" => {
    let target = match &c.target {
        Some(t) => t,
        None => return (false, "excel_row_count 缺 target".into()),
    };
    let n = c.threshold.unwrap_or(1);
    let cands = resolve_candidates(target, workspace);
    match first_hit(&cands, |m| m.is_file() && m.len() > 0) {
        Some(p) => (true, format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在：{}", p.display())),
        None => (false, format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在（任一）：{}", cands_disp(&cands))),
    }
}
```

> 注：`text_contains` / `text_min_lines` 的 `target` 是单文件路径（内容读取），按当前设计保持单路径即可；只有 `|` 出现在 `value` 上做关键词容错。若实际 planner 也在文件类 `target` 上产出多候选，则本次统一修 5 个分支已覆盖。

---

## 6. 影响 / 风险范围

- 直接影响：所有 success_criteria 中出现 `|` 多候选的**文件类任务**都会误判未闭环 → 重试 / 卡授权（本次就是）。
- 向后兼容：无 `|` 时 `resolve_candidates` 退化为单元素，行为与现状一致。
- 不改 `pipeline.rs`、`types.rs`、prompt 模板，仅改 verifier 内部解析，风险可控。
- 验证方式（修复后）：`cargo check`（src-tauri 目录），构造含 `|` 的 target 单测或重跑 `oa-web` 用例，应不再卡授权。

---

## 7. 待办（汇总，等全流程日志到后统一处理）

- [ ] 收到全流程运行日志后，与本文件合并二次分析：**是否还有除 `|` 与「授权误超时」之外的 BUG / 优化点**。
- [ ] 确认 planner 在 `success_criteria.target` 上产出 `|` 的其它形态（相对/绝对混合、更多扩展名），补齐边界。
- [ ] 应用第 5 节修复，`cargo check` 通过后让用户重跑 `oa-web` 用例验证授权不再卡死。
- [ ] 应用第 9 节前端修复：授权挂起时暂停安全定时器、决策后重启；核对「停止」按钮在授权期能干净释放 parked 的 oneshot（避免 pending 泄漏）。

---

## 8. 问题 2：授权等待期间被 20 分钟兜底定时器误判为「后端超时」

> 现象来源：用户实测——任务弹出授权弹窗后，因去讨论方案未及时点击，底部出现
> 「长时间未收到后端结束信号，任务可能仍在后台运行，可点击「停止」后重新发起」，
> 疑似导致任务被误杀重发。

### 8.1 现象

任务执行到需用户授权的高危操作时弹出审批弹窗（`pendingApproval` 置位，后端 parked 等决策）。
用户去讨论方案、未立即点击。底部出现提示：

```
长时间未收到后端结束信号，任务可能仍在后台运行，可点击「停止」后重新发起
```

且该提示出现的同时 `setRunning(false)`（`useAgentSession.ts:298-299`）→ 输入框解禁、可再次发起；
但后端其实仍 parked 在 `oneshot` 上等授权 → **误导用户点「停止」杀掉健康任务并重发，浪费 token**。

### 8.2 根因（一句话）

前端安全兜底定时器 `taskTimeoutRef`（20 分钟）本意是「Rust panic 导致终态事件丢失」的极端兜底，
但它**全程不感知「awaiting approval」暂停态**；后端 `approval.rs::suspend` 用 `oneshot` 无限等待、无超时，
用户未决策期间后端正确 parked、不会发 `agent-task-done`，于是 20 分钟一到定时器必然触发，弹出误导提示。

**更根本的设计缺陷（用户结论，2026-09-09 讨论确认）：** 定时器回调里 `setRunning(false)`
（`:298`）等于「前端单方面宣布任务结束」，但 Rust 后端可能仍在运行 / parked。
这会让**发送按钮回到可点状态**，用户可往一个未真正结束的任务里再发消息 —— 既不合理也会制造并发乱局。
**`isRunning`（发送按钮可用态）只能由后端终态事件（`agent-task-done` / `agent-task-error`）或用户主动「停止」翻转，绝不该由前端定时器翻转。**

### 8.3 证据链

| 位置 | 内容 | 性质 |
|---|---|---|
| `useAgentSession.ts:337` | `run` 内 `startTaskTimeout()` 启动 20 分钟兜底 | ⚠️ 起始点 |
| `useAgentSession.ts:293-303` | 定时器回调：`setRunning(false)` + `setStatusText('长时间未收到后端结束信号...')` + `finalizeStuckSteps` | ❌ 误导提示来源 |
| `useAgentSession.ts:146-148` | 注释明确：该定时**仅作极端兜底**，避免把仍在运行的后端误判为超时 | 🔍 设计意图 |
| `useAgentSession.ts:561-564` | `agent-awaiting-approval` → `setPendingApproval`，**未联动定时器/未区分状态** | ❌ 缺口 |
| `approval.rs:55-70` | `suspend` 用 `oneshot::channel()` 无限等待，**无 timeout** | ✅ 后端正确 parked |
| `src-tauri/src/agent` grep | 后端 `timeout` 仅用于 native 命令执行 / squad 调度 / round_compactor 探针，**无授权超时** | ✅ 已排除后端授权超时 |

### 8.4 已排除

- **后端授权超时导致任务中断**：已证伪。后端无授权 timeout，`suspend` 永久 parked。
- **真的是后端崩溃**：若是 panic，oneshot 发送端被 drop → 命令 reject/error → 会发 `agent-task-error`，而非静默 parked 20 分钟。

### 8.5 推荐修复方案（待一起改，未应用）

**A. 前端为主（优先，不改后端即可消除误导提示）：**

1. **授权挂起时暂停安全定时器**：在 `agent-awaiting-approval` 监听（`:561-564`）里 `clearTaskTimeout()`，
   并把状态设为「等待授权」而非错误态，例如：
   ```ts
   setPendingApproval(ev.payload)
   clearTaskTimeout()                       // 暂停 20 分钟兜底，授权等待是合法暂停、非后端异常
   setStatusText('⏸ 等待授权：请在弹窗中选择允许 / 拒绝，任务已暂停')
   ```
2. **决策回传后重启安全定时器**：`submitDecision`（`:375`）在 `setPendingApproval(null)` 后调用
   `startTaskTimeout()`（建议抽成 `pauseTaskTimeout` / `resumeTaskTimeout` 用 ref 防闭包陈旧）：
   ```ts
   const submitDecision = useCallback(async (decision) => {
     setPendingApproval(null)
     startTaskTimeout()                     // 决策后恢复兜底，覆盖后续可能耗时的步骤
     if (!isTauri) return
     ...
   }, [isTauri, startTaskTimeout])
   ```
3. **定时器回调护栏（关键，落实用户结论）**：定时器触发时**绝不再 `setRunning(false)`**，
   只保留 `isRunning=true`（发送按钮保持禁用 / 停止态）并展示**非破坏性**提示；是否真的异常由用户决定。
   ```ts
   taskTimeoutRef.current = setTimeout(() => {
     if (pendingApprovalRef.current) return          // 仍在等授权 → 继续等，不当后端异常
     // 仅作告警，不翻转运行态：后端可能仍健康运行，发送按钮保持禁用，由用户主动「停止」结束
     setStatusText('⏳ 任务已运行超过 20 分钟仍未收到结束信号，可能仍在后台执行；如需中断请点「停止」')
     // 不调 setRunning(false) / 不调 finalizeStuckSteps（避免输入框解禁、误杀在跑的任务）
   }, 20 * 60_000)
   ```
   （需新增 `pendingApprovalRef` 镜像，与 `isRunningRef` 同模式。）
   **设计原则：`isRunning` 只能由 `agent-task-done` / `agent-task-error` 事件或用户「停止」翻转；
   定时器、授权等待、任何前端计时都不具备翻转权限。**

**B. 后端可选增强（优先级低于 A）：**

4. 给授权加一个「温和超时」：默认较长（如 30–60 分钟，或读配置）。超时后 emit 明确的
   `agent-approval-timeout` 事件，让前端展示「授权等待超时，可选择继续等待或跳过」，
   而非复用通用后端超时提示。这样即使用户真走开很久，也有清晰语义而非误导。

### 8.7 用户结论（设计原则，2026-09-09 讨论）

> 「设置整体流程的超时不可取。一旦超时但 Rust 后端还在运行，前端发送按钮就回到可点状态，这不合理。」

据此锁定两条硬约束，改代码时必须遵守：

1. **`isRunning`（发送按钮可用态）的唯一真值源是后端终态或用户主动停止** ——
   `agent-task-done` / `agent-task-error` 事件复位，或用户点「停止」(`cancel_agent_task`) 复位。
   **任何前端定时器（含本 20 分钟兜底）都无权翻转它。**
2. **兜底定时器只告警、不结束** —— 触发时仅展示非破坏性提示（仍在后台、可点停止），
   绝不 `setRunning(false)`、绝不 `finalizeStuckSteps`、绝不解禁输入框。
3. **授权等待是合法暂停，不是异常** —— 定时器应在 `agent-awaiting-approval` 时暂停，决策后恢复；
   即便竞态触发也不应误判。

⇒ 这意味着「整流程超时自动结束」这条路**直接否决**；超时只作为可观测的告警信号，任务生命周期仍由后端事件驱动。

### 8.6 影响 / 风险

- A 方案仅动前端状态机，后端 parked 行为保持正确，**零后端风险**。
- 需一并核对：「停止」按钮在授权等待期能否干净释放 parked 的 `oneshot`
  （`cancel_agent_task` → `approval.cancel`），避免 pending 项泄漏（见第 7 节待办最后一项）。
- `setRunning` 在授权期间必须保持 `true`（输入框禁用），仅定时器暂停；不能因提示出现而解禁。

---

## 9. 修复落地顺序建议（待全流程日志到后执行）

1. **问题 1（verifier `|` 容错）**：改 `src-tauri/src/agent/verifier.rs`，`cargo check` 验证。
2. **问题 2（授权误超时）**：改 `src/pages/agent-studio/session/useAgentSession.ts`
   （A 方案 1-3，约 ~15 行），`npm run typecheck` 验证；后端 B 方案按需后补。
3. 收到全流程日志后，合并排查是否有新增 BUG / 优化点，统一补入本报告。

---

## 10. 修复记录（2026-09-09 已应用）

> 用户确认「整流程超时不可取」后，已实施两处修复并验证通过。

### 10.1 问题 1 — verifier.rs（已改 + cargo check 通过）

- 新增辅助 `resolve_candidates` / `first_hit` / `cands_disp`（`verifier.rs` `resolve_path` 之后）。
- 改写 5 个文件类分支 `file_exists` / `file_nonempty` / `directory_exists` / `json_valid` / `excel_row_count`：
  `target` 按 `|` 分割为多候选，遍历解析后**任一命中即通过**（`.js` 候选命中即过），
  失败明细展示「（任一）：cand1 | cand2」。与 `text_contains` 的 `|` 容错对称，无 `|` 时向后兼容。
- 验证：`cargo check` → `Finished dev profile in 9.36s`，EXIT=0。

### 10.2 问题 2 — useAgentSession.ts（已改 + typecheck 通过）

- 新增 `pendingApprovalRef` 镜像 + 统一 `applyPendingApproval()`（同步 ref，替代散落的 `setPendingApproval`）。
- 定时器回调（`startTaskTimeout`）：**移除 `setRunning(false)` / `setIsStreaming(false)` / `finalizeStuckSteps`**，
  仅留非破坏性提示「⏳ 任务已运行超过 20 分钟…如需中断请点停止」；加 `pendingApprovalRef` 护栏
  （仍在等授权则直接 return）。落实「定时器只告警、不结束」。
- `agent-awaiting-approval` 监听：挂起时 `clearTaskTimeout()` + 状态改为「⏸ 等待授权…」。
- `submitDecision`：决策后 `applyPendingApproval(null)` + `setStatusText('')` + `startTaskTimeout()` 恢复定时器。
- 验证：`npm run typecheck` → EXIT=0。
- 注：`finalizeStuckSteps` 在 `agent-task-done` / `agent-task-error` 终态处理器仍保留，从定时器移除安全。

### 10.3 验证结论

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 编译 | `cd src-tauri && CARGO_HOME=/d/Rust/cargo RUSTUP_HOME=/d/Rust/rustup RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/Rust/cargo/bin/cargo check` | EXIT=0（9.36s） |
| 前端类型 | `npm run typecheck` | EXIT=0 |

### 10.4 待用户后续

- [ ] 实机重跑 `oa-web` 用例：确认 verifier 不再因 `tailwind.config.js|ts` 卡授权、授权弹窗长等不再误报超时。
- [ ] 如仍有全流程日志中的其它 BUG / 优化点，单独补入本报告继续修。

---

## 11. 全流程实测（Agent.log + Skill 内容）二次分析：Skill 到底有没有用？

> 用户提供：`SkillHub/react-developer/SKILL.md`（及 scripts/references/assets）+ `Agent.log`（1385 行）。
> 结论：**Skill 的"人设/铁律"被用了，但 Skill 的"程序性流程"完全没用**——项目建烂的根因在 Skill 执行机制，不在 Skill 内容本身。

### 11.1 直接结论

| 维度 | 是否被用 | 证据 |
|---|---|---|
| 角色定义 + 核心编码铁律（注入 system prompt） | ✅ 用了 | 每条 `call_llm_stream` 请求体都带「你已挂载专业级技能 `react-developer`…必须无条件遵循…铁律」（日志 L49/73/87/… 重复出现），且产物代码风格确实符合（严格类型/不可变/autoComplete=off/CSS 变量） |
| **Workflow A 脚手架流程** | ❌ 没用 | 日志 0 次出现 `Workflow A` / `npm create vite` |
| **`scripts/setup_project.py`**（固定版本+按选项装依赖+建结构） | ❌ 没用 | 日志 0 次出现 `setup_project` / `scripts/`（grep 全空） |
| **`references/*.md`**（scaffolding/styling/state/data-fetching） | ❌ 没用 | 日志 0 次出现 `references/` / `质量门禁` |
| **真正跑 `npm install` / `npm run build`** | ❌ 没用 | 工具分布：18 write_file / 18 read_file / 11 list_directory / 4 skill(回声) / 2 run_node_sandbox；**无任何 `npm install`/`build` 执行**，只有把 `build` 脚本字符串写进 package.json |

### 11.2 杀手锏证据：`skill__xxx` 工具是"回声壳"

`skill__a6dbe94e-...` 被调用 4 次，每次返回都是把入参 task 原样回显（L78-84 / L319 / L578-584 / L822-828）：

```
skill__...: 完成 result=513字符 内容=技能『React开发技能』（id=...）已接收任务：<原任务文本>
```

→ 它**不读 SKILL.md、不跑脚本、不执行 Workflow**，只是把任务又抛回给 LLM。于是 Agent 退化成「裸 LLM + 注入的铁律片段」在现写文件。

### 11.3 三层根因（比 §1-§10 的 oa-web 三缺陷更根本）

1. **Skill 程序性内容未进入上下文 / skill 工具是回声壳**
   → Agent 不知道要固定版本、不知道要 `npm create vite`、不知道 `build 通过` 是硬门禁。
2. **验收机制过浅（文件存在 ≠ 可构建）**
   → Agent 自检只跑 `native__run_node_sandbox` 的 `existsSync` 文件存在性检查（L496-516，**首次还因 src 未落盘而失败**），从没真装真构建 → 假成功。
   这与 §1 的 verifier `|` 误判是**同类问题**（浅校验放行），也暴露 agent 自检本身的缺陷。
3. **需求在 planner 层被丢弃**
   → planner goal（L41）=「集成路由、Zustand、Axios、Tailwind CSS 与 Vite」，**整份日志 `tanstack` 出现 0 次**——用户"数据请求用 tanstack-query"被理解成 axios，漏库。

### 11.4 对"优化 Agent"的关键含义

- 仅修 verifier `|` 容错、或只改 oa-web 三个文件，**都不能防止下次再发生**。
- 要真正发挥 Skill：必须改 **Skill 接入/执行机制**——
  (a) 把 SKILL.md 的「Workflow + references 概要 + setup_project.py 调用指引」整段注入 agent 上下文（而非只注入角色+铁律）；或
  (b) 让 `skill__xxx` 工具**真正执行 SKILL.md 里的脚本/步骤**而非回声。
- success_criteria 必须加硬检查：**真跑 `npm install` + `npm run build`（或 typecheck）0 错误**，而非仅文件存在。

### 11.5 已验证的事实清单（留痕）

- Skill 内容本身质量过关：明确写 `tailwindcss v4`、`@tanstack/react-query v5`、`npm create vite` 脚手架、`build 通过` 门禁。
- 因此"项目建烂"不是 Skill 写错，而是 **Skill 没被真正执行**。
- Agent.log 1385 行中，Skill 程序性关键词出现次数均为 0；tanstack 出现次数 0。

### 11.6 本问题已移出 → 独立 md（2026-09-09 已修复）

「Skill 程序性内容未落地」已按 (b) 思路修复并单独成文：**`agent-skill-injection.md`**（问题+证据链+根因+已落地代码方案+验证+下一个问题指路）。
遵循用户约定「一个问题一个 md 专门讨论」，本 §11 仅留原始分析，修复与后续推进以 `agent-skill-injection.md` 为准。
关联待突破（建议再开独立 md）：**真构建硬验收** `agent-build-acceptance.md` —— success_criteria 加「`npm install`+`npm run build` 0 错误」「点名库确实在依赖清单」硬检查。
