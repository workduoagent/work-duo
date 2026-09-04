# Work Duo Agent 执行链路：乱在哪 → 正确流程设计 → 修复清单

> 基于 `Agent.log`（SOL 价格采集任务，25 轮后 HTTP 400 崩溃）与源码逐段比对产出。
> 目标：把"能跑但会失控"的链路，改造成"每一层都有不变量约束"的链路。

---

## 一、现状执行链路（按时间顺序）

```
┌─ 阶段 1：load_config（commands.rs）───────────────────────────────┐
│ 读库：llm 配置 / agent 配置（system_prompt、allow_sandbox、        │
│       auto_tool_exec_mode、mcp_tools、skill_tools）                │
│ 拼装 system_prompt（按顺序 push_str）：                            │
│   ① 用户库里手写的 system_prompt                                   │
│   ② 工作环境（真实工作空间路径）                                    │
│   ③ 执行环境（cmd.exe /C 语法约定）  ← 【断点 1】无条件注入         │
│   ④ .wd_mem 记忆区说明 + 树状索引 + MEMORY.md + 固化闭环指令        │
└───────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 2：run_agent_task → spawn → run_task（runtime.rs）──────────┐
│ 工具注册：register_native_tools(registry, app, allow_sandbox)      │
│   ReadFile / WriteFile / ArchiveArtifact / EditFile / ListDirectory│
│   ExecuteCommand（← 【断点 1】历史上无条件注册）                    │
│   RunPythonSandbox（native__run_python_sandbox）                   │
│ 再注册 Skill 工具、MCP 工具（按 server 分组）                      │
└───────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 3：上下文装配（context.rs build_context_messages）──────────┐
│ [Slot 0] system_prompt（含 custom_rules / MEMORY.md / 树状索引）    │
│ [Slot 1] 会话滚动摘要（DB summary 或 .wd_mem/sessions/{id}.md）     │
│ [Slot 2..N] 活跃轮次（raw_messages_json 反序列化，无损还原         │
│              tool_calls 与工具结果）                                │
│ [Slot N+1] 用户本轮提问                                            │
└───────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 4：ReAct 主循环（runtime.rs run_task）──────────────────────┐
│ 每轮：                                                              │
│   call_llm_stream（流式，stream_options.include_usage=true）        │
│     → SSE 聚合：content / reasoning / tool_calls（按 index 归并）   │
│   无 tool_calls → 终态，emit 文本，跳出                             │
│   有 tool_calls → 逐条执行：                                        │
│     parse_tool_call → ParseOutcome::Ok / ParseError（自愈回灌）      │
│     权限判定：ReadSafe 自动放行 / RequireApproval 挂起等审批         │
│     执行工具 → truncate_tool_output(15000) 物理截断                 │
│     push { role:"tool", tool_call_id, content }                     │
│   统计连续错误（3 轮全失败 → 熔断 break）                            │
│   trim_history 滑动窗口裁剪  ← 【断点 2】按条数硬切                 │
│   达到 MAX_TOOL_ITERATIONS(30) → 兜底熔断                           │
└───────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 5：收尾 ────────────────────────────────────────────────────┐
│ persist_session_tokens（真实 usage 落库）                           │
│ 持久化 round（raw_messages_json）→ 后台 round_compactor 滚动压缩     │
└───────────────────────────────────────────────────────────────────┘
```

---

## 二、日志实证：这次到底怎么崩的

| 轮次 | 事件 | 证据 |
|---|---|---|
| 1 | LLM 返回 **2 个并行 tool_calls**（两个 `native__list_directory`） | 日志 L16：`tool_calls=2个` |
| 1 | 两个 call_id：`...588e6fa`、`...588e700`，均执行成功 | L18 / L24 |
| 1→2 | 消息数 2 → 5（system + user + assistant + tool + tool） | L30：`上下文=5条` |
| 2 | HTTP 200，正常 | L34 |
| 3 | **Agent 开始用 `execute_command` 找 Python** | L88：`python --version && pip show ...` |
| 3~24 | 反复探测系统 Python：`where python`、`python3 --version`、`cmd /C python --version` | L106 / L145 / L164 |
| 9 | **`winget install Python.Python.3.12`** —— 往宿主系统真装了 Python | L205~L220：`已成功安装` |
| 10~24 | 继续探测路径、PowerShell 兜底，全部空转 | L230~L390 |
| 25 | 上下文 51 条 → **裁剪为 49 条** | L518：`上下文=49条消息[裁剪前51条]` |
| 25 | **HTTP 400**：`tool result's tool id(call_01a06b0206047051a588e6fa) not found` | L522~L524 |

**注意那个报错的 call_id `...6fa` 是第 1 轮的**。也就是说：裁剪把第 1 轮那条带 2 个 tool_calls 的 assistant 保留了，却切掉了它的 tool 结果 → 配对残缺 → 网关拒绝。

---

## 三、五大断点诊断（这就是"乱"的根源）

### 断点 1：能力层与提示层不同源 —— 最严重

- **提示层**：你在 agent 的 `system_prompt`（数据库字段）里手写"沙箱模式已开启、**不暴露任何宿主机 shell 命令**"。
  经全局检索确认：**`commands.rs` 源码里根本没有这段文案**，它完全来自你手写的配置。
- **能力层**：`register_native_tools` **无条件执行** `registry.register(Arc::new(ExecuteCommandTool))`。
- **加剧矛盾**：`commands.rs` 还无条件注入"命令执行环境 / `cmd.exe /C` 语法约定"——等于主动教模型用 shell。

> 结论：**提示是软的，工具表是硬的。** 模型以工具表为准，试探一下就拿到了 shell，
> 于是去系统里翻 python，最后 `winget install`。沙箱形同虚设。

### 断点 2：上下文裁剪破坏 tool 配对 → HTTP 400

原实现 `trim_history` 纯按条数切：

```rust
let keep = rest.len().saturating_sub(MAX_HISTORY_TURNS * 2);
out.extend_from_slice(&rest[keep..]);   // 切点落在哪算哪
```

并行工具调用时一轮会产生 **1 条 assistant + N 条 tool 结果**，切点极易落在中间：
保留 assistant（含 2 个 tool_call id）却只留 1 条结果 → 网关 400。
**这是纯粹的实现缺陷，与模型、网关都无关。**

### 断点 3：沙箱工具摩擦过大，反向诱导绕道

`native__run_python_sandbox` 一直存在并已注册，但模型不用它，因为：

| 摩擦点 | 后果 |
|---|---|
| 参数是 `script_path`（已存在脚本的绝对路径），**不能直接传代码** | 必须先 write_file 再调用，两步 |
| `PermissionLevel::RequireApproval` | 每次都要用户点批准 |
| 描述仅一句"在 micromamba 沙箱中运行脚本。需用户审批" | 模型不知道这是跑 Python 的正道 |

相比之下 `execute_command` 一步就能跑 `python xxx.py`，模型当然选后者。

### 断点 4：裁剪发生在错误的时机与位置

裁剪在 **ReAct 循环内逐轮** 对运行时 `messages` 就地执行，且裁剪后**没有任何完整性自检**。
正确做法应是：装配阶段一次性裁剪 + 发送前统一断言校验。

### 断点 5：异常/熔断路径没有兜底

熔断 break、用户取消、工具执行抛错时，`messages` 里可能残留**悬空的 assistant(tool_calls)**（有 tool_call_id 却没有对应结果）。
这段残缺序列一旦被 `raw_messages_json` 持久化，下一轮重建上下文会**再次触发 400**，且难以复现。

---

## 四、正确设计：分层不变量

> 核心原则：**每一层只做一件事，并把"必须成立的条件"写成不变量，由下一层断言。**

### A. 配置层（commands.rs load_config）

- **不变量 A1**：`allow_sandbox` 是**唯一真值源**，提升为局部变量，
  同时驱动「能力层注册哪些工具」与「提示层声明哪些能力」。
- **不变量 A2**：提示中出现的每个工具名，必须在能力层已注册；反之亦然。**禁止出现"提示说有、表里没有"或"提示说没、表里有"。**

### B. 能力层（runtime.rs 工具注册）

- **不变量 B1**：`allow_sandbox == true` ⇒ **不注册** `ExecuteCommandTool`。
- **不变量 B2**：`allow_sandbox == true` ⇒ **必须注册** `RunPythonSandboxTool`（否则 Agent 无执行能力，直接瘫痪）。
- **不变量 B3**：所有写操作必须过 `PathGuard` + 句柄级 TOCTOU 复核。

### C. 提示层（commands.rs 注入）

- **不变量 C1**：执行环境段按 `allow_sandbox` 二选一注入：
  - 沙箱开启 → 注入「沙箱模式：只能用 `native__run_python_sandbox`，严禁系统 python / 严禁 winget 安装」
  - 沙箱关闭 → 才注入 `cmd.exe /C` 或 `sh -c` 语法约定
- **不变量 C2**：提示中必须**显式给出正道的操作步骤**（先 write_file 写脚本 → 再 run_python_sandbox 传绝对路径），
  而不只是禁止什么。只讲禁令不讲出路的提示，模型必然自行其是。

### D. 消息序列不变量（发给 LLM 前必须全部成立）

| 编号 | 不变量 |
|---|---|
| I1 | `messages[0].role == "system"` |
| I2 | 每个含 `tool_calls` 的 assistant，其**全部** `tool_call.id` 都必须有对应 `role:"tool"` 消息 |
| I3 | 每条 `role:"tool"` 消息的 `tool_call_id`，必须能追溯到前序 assistant 的 `tool_calls` |
| I4 | tool 结果必须**紧跟**其所属 assistant（中间不得插入其他 assistant） |
| I5 | 序列末尾不得是悬空的 assistant(tool_calls) |
| I6 | 裁剪只能发生在**轮次边界**，且裁剪后 I2~I5 依然成立 |
| I7 | 不得存在 `content` 为空且无 `tool_calls` 的 assistant 消息 |

### E. 执行层（ReAct 循环）

- **不变量 E1**：工具输出一律 `truncate_tool_output(15000)` 后入列。
- **不变量 E2**：JSON 解析失败不静默吞掉，回灌 `ParseError` 让模型自愈。
- **不变量 E3**：连续 3 轮全失败 ⇒ 熔断（护栏靠"无进展"判定，不靠砍总轮数）。
- **不变量 E4**：`MAX_TOOL_ITERATIONS=30` 仅作**极端兜底**，不应成为正常任务的瓶颈。

### F. 收尾层

- **不变量 F1**：熔断 / 取消 / 异常退出前，必须为所有悬空 tool_call 补一条占位结果，保证落库的 `raw_messages_json` 满足 I2/I3。

---

## 五、修复清单

### ✅ 已修复（本轮，`cargo check` 通过）

| # | 问题 | 文件 | 修复 |
|---|---|---|---|
| 1 | 断点 2：裁剪切碎 tool 配对 | `runtime.rs` | 重写 `trim_history`：切点从理想位置逐条前移，直到配对安全；新增 `is_safe_start`（切点非 tool 结果；若是带 tool_calls 的 assistant，必须其**全部**结果都在保留段内）+ `has_orphan_tool_result`（段内不得有孤儿 tool 结果）双重校验 |
| 2 | 断点 1：沙箱下仍注册 shell | `native.rs` | `register_native_tools(registry, app, sandbox_enabled)`；`sandbox_enabled == true` 时**不注册** `ExecuteCommandTool` |
| 3 | 配套调用方 | `runtime.rs` | `register_native_tools(&mut base, app, cfg.allow_sandbox)` |
| 4 | 断点 3：工具描述无引导力 | `native.rs` | 重写 `native__run_python_sandbox` 的 description：明确"运行 Python 的唯一正确方式"（两步法）+ 三条严禁（不用系统 python、不探测本机 Python、**绝对禁止 winget/choco 安装**） |
| 5 | 断点 1：`allow_sandbox` 无真值源 | `commands.rs` | 提升为局部变量 `let allow_sandbox = get_i64(&row,"allow_sandbox")==1;`，打印与注入共用 |
| 6 | 断点 1：执行环境提示与能力打架 | `commands.rs` | 改为三分支：`allow_sandbox` → 沙箱段；否则 Windows → cmd 段；否则 Unix → sh 段 |

### ✅ 后续追加修复（同样 `cargo check` 通过）

| # | 问题 | 文件 | 修复 |
|---|---|---|---|
| 7 | 断点 3 | `native.rs` | `native__run_python_sandbox` 支持**直接传 `code`**（内部落盘到 `.wd_mem/scripts/auto_run_{ts}.py`，落盘后仍过 `PathGuard`），`script_path` 降为可选兼容参数 | 
| 8 | 断点 4 / D | `runtime.rs` | 新增 `sanitize_message_sequence`：为缺失结果的 tool_call 补占位、丢弃孤儿 tool 消息；在**每次 `call_llm_stream` 前**调用 | 
| 9 | 断点 5 / F1 | `runtime.rs` | 落库前对 `messages[round_base..]` 做 `sanitize_message_sequence` 后再序列化 `raw_messages_json` | 
| 11 | 自审发现的边界隐患 | `runtime.rs` | `trim_history` 增加回退：若所有候选切点都不安全导致 `start` 越界，退化为保留「最后一条非 tool 消息」，避免裁剪后**只剩 system、丢失用户输入** | 

### ❌ 经评估不做

| # | 原计划 | 不做的理由 |
|---|---|---|
| 10 | 把裁剪从 ReAct 循环内移到装配阶段 | 当前实现本就是「**发送前**裁剪 + 立即自检」，裁剪与自检成对出现，功能已正确；挪到装配阶段需要跨模块调用且每轮仍要执行一次，收益仅为命名上的职责清晰，属过度工程 | 

---

## 五之二、⚠️ 沙箱模式的重要副作用（必须知晓）

修复 #2 让 `allow_sandbox == true` 时**不再注册 `execute_command`**。这意味着沙箱开启后，
Agent 可用的工具只剩：

```
read_file / write_file / edit_file / list_directory / archive_artifact / run_python_sandbox
```

**任何非 Python 的宿主命令都将无法执行**，`git`、`npm`、`pnpm`、`cargo`、`curl`、文件压缩解压等一律不可用。

这个行为严格符合你自己在 `system_prompt` 里写的"不暴露任何宿主机 shell 命令"，
但如果你的任务需要用到上述命令，就需要二选一：

| 方案 | 做法 | 适用 |
|---|---|---|
| A（当前实现） | 沙箱开启 ⇒ 彻底无 shell，Python 强制走沙箱 | 任务只需要读写文件 + 跑 Python（如本次数据采集、生成 Excel） |
| B（折中） | 沙箱开启 ⇒ **保留** `execute_command`，但在执行层**拦截 `python` / `pip` / `winget` / `choco` 等命令**，强制重定向到沙箱或拒绝 | 任务还需要 git / npm / 其他命令行工具 |

若选 B，改动点集中在 `ExecuteCommandTool::execute` 内加一层命令白/黑名单判断，约 30 行。
**告诉我你的选择，我立刻调整。**

---

---

## 六、验证方式

1. **编译**：`RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/Rust/cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/Rust/cargo/bin/cargo check`（已通过）
2. **运行回归**（需 `npm run tauri` 重编译后实测）：
   - 绑定工程 + 开启沙箱 → 日志应出现 `sandbox=true`，且**工具注册数从 7 降为 6**（`execute_command` 消失）
   - 让 Agent 跑 Python 任务 → 应看到 `native__run_python_sandbox` 被调用，**不再出现** `where python` / `winget install`
   - 长任务跑到 25 轮以上 → 不再出现 HTTP 400（`trim_history` 裁剪应保持配对完整）
3. **日志关键字自检**：
   - 出现 `native__execute_command` 且 `sandbox=true` ⇒ 能力层收敛失效，需回查
   - 出现 `HTTP 400 ... tool id(...) not found` ⇒ 配对不变量被破坏，需回查裁剪与异常路径
