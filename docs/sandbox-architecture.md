# Python 沙箱环境：创建 / 接入 / Agent 与 Squad 使用 全链路梳理

> 目的：完整还原当前 Python 沙箱的业务链路，为后续接入 **Node 沙箱（Bun）** 提供可直接映射的架构基线。  
> 涉及代码：`src-tauri/src/mamba_manager.rs`、`src-tauri/src/agent/native.rs`、`runtime.rs`、`squad_orchestrator.rs`、`commands.rs`、`tools.rs`；前端 `src/core/mapper/sandbox-mapper.ts`、`src/pages/sandbox/python/`、`src/pages/agent-studio/draft.ts`。

---

## 0. 全局架构（四层）

```
┌─ 运行时管理层 ───────────────────────────────┐
│  MambaManager  (micromamba sidecar 封装)       │  $RESOURCES/mamba_root，绿色便携
│  init/list/install/uninstall/reset/delete/run  │  启动时 ensure_default_env() 静默建 default
└───────────────────────────────────────────────┘
                    ▲ 被调用
┌─ 原生工具层 ──────────────────────────────────┐
│  RunPythonSandboxTool (native.rs)              │  名称 native__run_python_sandbox
│  register_native_tools() 控制注册与否           │  RequireApproval（需用户审批）
└───────────────────────────────────────────────┘
        ▲ 由编排层注册            ▲ ToolContext 注入
┌─ 编排接入层 ──────────────────────────────────┐
│  runtime.rs::run_task（单体 Agent）            │  cfg.allow_sandbox → ToolContext.sandbox_enabled
│  squad_orchestrator.rs::run_member_subtask     │  二者都调 register_native_tools + 建 ctx
└───────────────────────────────────────────────┘
                    ▲ 读取 agent_info.allow_sandbox
┌─ 配置真值源 ──────────────────────────────────┐
│  agent_info.allow_sandbox (0/1)               │  单一真值源：同时驱动能力层 + 提示层
└───────────────────────────────────────────────┘
```

**关键原则**：`allow_sandbox` 是**唯一真值源**，同时决定「能力层注册哪些工具」与「提示层声明哪些能力」。二者必须同源——只写进 system_prompt 而工具表里照样注册 `execute_command`，模型以工具表为准，试探后必然绕过沙箱（实测会去找系统 python、甚至 `winget` 安装系统级 Python，脱离沙箱并污染本机）。

---

## 1. 沙箱环境「创建」（运行时管理层）

### 1.1 绿色便携定位（不落 AppData）

- 根目录：`$RESOURCES/mamba_root`（`$RESOURCES = app.path().resource_dir()`），软件整体搬迁即可在另一台机器直接跑。
- 首次 `setup()`：创建 `mamba_root`；若写入被拒（系统盘无权限）返回友好提示「请移到 D 盘」。
- 写入 `.mambarc`：强制国内镜像源（清华 tuna），`ssl_verify: true`。

### 1.2 micromamba sidecar

- 二进制：`binaries/micromamba`，经 `tauri_plugin_shell` 的 `sidecar("micromamba")` 调用。
- **全局选项必须前置**：`--root-prefix <mamba_root> --rc-file <.mambarc>` 必须放在子命令之前；否则被 `run python` 当成目标程序参数而失效，回退到 AppData 默认前缀。
- 中文路径坑：Windows 下 `micromamba run` 经 `cmd /C` 执行，脚本路径含中文会被拼坏。解法：`run_python_script` 把脚本 `copy` 到纯 ASCII 临时文件 `mamba_root/run_tmp/__sandbox_run_<纳秒>.py` 再喂给 micromamba；同时把工作目录用 `CreateProcess` 原生传入（Unicode 安全），使脚本内相对文件操作仍按原路径解析。运行结束清理临时文件。

### 1.3 默认环境自举

- `ensure_default_env(app)`：启动时静默调用。若 `mamba_root/envs/default` 已存在直接返回；否则建纯净 `python=3.11`（不预装第三方库）。失败仅记日志，不阻塞启动。
- `default` 是 Agent 默认环境，**禁止删除 / 禁止重置**，仅允许在其上安装/卸载依赖。

### 1.4 多环境管理（前端「Python 沙箱」页面）

| 命令                         | 说明                                               |
| -------------------------- | ------------------------------------------------ |
| `init_mamba_env`           | 建最纯净环境（仅解释器），幂等                                  |
| `list_mamba_envs`          | 列全部环境（含受保护 default，即使未建也以 exists=false 呈现）→ 驱动卡片 |
| `list_mamba_packages`      | 查某环境已装依赖（名称+版本）                                  |
| `install_mamba_packages`   | 追加依赖（支持 `pandas=2.2` 规格）                         |
| `uninstall_mamba_packages` | 移除依赖                                             |
| `reset_mamba_env`          | 删除后重建纯净环境（default 拒绝）                            |
| `delete_mamba_env`         | 删除环境（default 拒绝）                                 |

### 1.5 缺失库「自愈」（白名单 + 自动重装）

- `AUTO_INSTALL_ALLOW`：requests / numpy / pandas / openpyxl / xlsxwriter / scipy / statsmodels / matplotlib / seaborn / yfinance / ccct / scikit-learn / sklearn / pyyaml / yaml / json5 / tqdm 等。
- `missing_modules(stderr)`：从 `ModuleNotFoundError: No module named 'X'` 解析命中白名单的顶层模块名（`sklearn.linear_model` → `sklearn`）。
- `run_script_with_selfheal()`：首次运行失败 → 命中白名单 → `install_packages_silent()` 装好 → **重试一次**；非库缺失类错误（语法/逻辑/网络）不触发安装，原样返回。

---

## 2. 接入：权限与能力层

### 2.1 配置真值源

- `agent_info.allow_sandbox INTEGER NOT NULL DEFAULT 0`（`init.sql:204`，存量库经 `updater.sql:46` 补列）。
- 前端 `draft.ts` 的 `allowSandbox: boolean` → `AgentUpsertInput` → 写入列。

### 2.2 能力层：`register_native_tools(registry, app, sandbox_enabled, memory_mode)`

位置：`native.rs:804`

- 始终注册：ReadFile / WriteFile / ArchiveArtifact / EditFile / ListDirectory；（memory_mode≠off 时）AnchorMemory；**RunPythonSandboxTool**。
- **`sandbox_enabled=true` 时不注册 `ExecuteCommandTool`（宿主 shell）** —— 这是沙箱语义的硬收敛点（见 §0 原则）。

### 2.3 提示层同源（`commands.rs::load_config`）

- 注入真实 `workspace` 路径提示。
- `allow_sandbox=true` 时追加「执行环境（沙箱模式）」提示：唯一正确方式是 `native__write_file` 写脚本 + `native__run_python_sandbox` 执行；**严禁**调系统 python / `where python` / `winget` / `apt` 等；缺库如实告知用户而非自装系统包。
- `allow_sandbox=false` 时改注入宿主 shell 语法约定（Windows `cmd /C` / 类 Unix `sh -c`）。

### 2.4 工具上下文 `ToolContext`（tools.rs:26）

```rust
pub struct ToolContext {
    pub workspace: Option<PathBuf>,   // PathGuard 边界
    pub sandbox_enabled: bool,        // = agent.allow_sandbox
    pub agent_id: String,
    pub session_id: Option<String>,
}
```

### 2.5 `RunPythonSandboxTool` 执行细节（native.rs:657）

- `check_permission` → `RequireApproval`（经 ApprovalManager 挂起前端审批，`ApprovalNotify.tsx` 提及）。
- `sandbox_enabled=false` → `PermissionDenied`。
- 入参二选一（`code` 优先）：
  - `code`：需 `ctx.workspace`（否则 `PermissionDenied "未提供工作空间，无法落盘"`）；自动落盘到 `ws/.wd_mem/scripts/`，文件名消毒（剔除 `/ \ : " < > | ? *` 防 `../` 穿越），落盘后再过 `PathGuard`。
  - `script_path`：直接 `PathGuard::check`（须在工作空间内）。
- 取 `self.app.state::<MambaManager>()` → `run_python_in_sandbox(app, mgr, env_name, resolved_script)`。

---

## 3. 实际运行链路（单体 Agent）

```
run_agent_task (commands.rs)
  → AgentSession::run_task (runtime.rs:67)
      ├─ register_native_tools(&mut base, app, cfg.allow_sandbox, &cfg.memory_mode)  // 沙箱开→不注册 execute_command
      ├─ ToolContext { workspace, sandbox_enabled=cfg.allow_sandbox, agent_id, session_id }
      ├─ 意图分流(intent) → SIMPLE_CHAT / COMPOSITE
      ├─ planner::build_plan(cfg, prompt, workspace)   // 注入工作目录提示
      └─ pipeline::run_pipeline(app, cfg, &registry, &ctx)
            └─ 模型 streaming → tool_calls 含 native__run_python_sandbox
                  └─ runtime::run_tool_calls_round → tool.execute(args, ctx)
                        └─ RunPythonSandboxTool::execute
                              └─ run_python_in_sandbox → run_script_with_selfheal
                                    └─ micromamba run -n default python <tmp>.py (cwd=原脚本目录)
                                          └─ stdout/stderr 回传给模型（非 0 退出码触发自愈）
```

注意：**沙箱开启 ⇒ `execute_command` 不注册 ⇒ git/npm/curl 等宿主命令不可用**。这是设计意图（反向诱导模型绕道到系统 python 的摩擦点，已用 `code` 直传 + 自动装库消除）。

---

## 4. Squad 如何使用沙箱

`run_member_subtask`（`squad_orchestrator.rs:430`）：

- 每个成员用**独立** `AgentRuntimeConfig`；`cfg.allow_sandbox` 来自**成员自身（即该智能体）**&#x7684; `allow_sandbox`。
- 工作空间 `cfg.workspace = Some(workspace)`（即父 squad 的成员私有目录，前次任务已加可配目录 `workspace_dir`，详见 MEMORY）。
- 同 `run_task`：`register_native_tools(app, cfg.allow_sandbox, ...)` + 构建 `ToolContext { workspace, sandbox_enabled=cfg.allow_sandbox, ... }`。
- 结论：**成员能否用沙箱 = 该成员智能体自己的 `allow_sandbox`**；多个成员各自独立继承，互不共享运行时。
- chat（群聊）模式纯讨论、不落盘，不触沙箱。

---

## 5. 前端入口

| 位置                                                   | 作用                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `设置 → Python`（`/sandbox/python`，`SandboxPythonPage`） | 环境卡片网格：列/建/装/卸/重置/删/运行脚本                                                         |
| `src/core/mapper/sandbox-mapper.ts`                  | 封装 `invoke('init_mamba_env' 等)`，Rust `Result<String,String>` → `{ok,error,data}` |
| 智能体编辑表单 `allowSandbox`（`draft.ts:44`）                | 开关 → `agent_info.allow_sandbox`                                                  |
| 会话内 `ApprovalNotify`                                 | `native__run_python_sandbox` 触发审批挂起                                              |

---

## 6. 接入 Node / Bun 沙箱的改造映射（关键）

建议**完全镜像**现有四层，再加一个运行时开关维度：

### 6.1 运行时管理层 → 新增 `BunManager`

- sidecar `bun`（或 `bun.exe`），根目录 `$RESOURCES/bun_root`，绿色便携。
- `ensure_default_bun()`：启动时确保默认 runtime（如 `bun add` 基环境或全局 cache）。
- 命令：`init_bun_env / list_bun_envs / install_bun_packages / reset_bun_env / run_node_script`。
- 自愈白名单：常见 npm 包（lodash / axios / zod / chalk 等），`missing_modules` 解析 `Cannot find package 'X'` → 静默 `bun install X` → 重试。
- Bun 无 micromamba 的 `cmd /C` 中文编码坑，但 sidecar 退出码/超时处理保持一致。

### 6.2 原生工具层 → 新增 `RunNodeSandboxTool`

- 名称 `native__run_node_sandbox`；`check_permission` → `RequireApproval`。
- 入参 `code`（落盘 `ws/.wd_mem/scripts/*.mjs` + 文件名消毒 + PathGuard）/ `script_path`（PathGuard）+ `runtime_name`（默认 `default`）。
- 走 `BunManager::run_node_in_sandbox`。

### 6.3 能力层 → `register_native_tools`

- 沙箱开 ⇒ 仍**不注册 `execute_command`**。
- 是否同时注册 Python 与 Node 两个工具，取决于新增开关：
  - **方案 A（推荐，最小改动）**：复用 `allow_sandbox`，开启即同时提供 Python + Node 两个 sandbox 工具（模型按任务自选语言）。
  - **方案 B（更精细）**：`agent_info` 新增 `allow_node_sandbox`，与 `allow_sandbox` 解耦，工具注册时各自判断。Squad 成员同理读各自字段。

### 6.4 提示层

- `load_config` 沙箱模式提示补充 Node 用例：直接传 `code` 给 `native__run_node_sandbox`；缺 npm 包经自愈安装；同样严禁 `npm install -g` / 系统安装。
- `planner.rs` 沙箱提示增加 Node 数据抓取/报表场景。

### 6.5 ToolContext

- 可加 `sandbox_runtime: Option<&str>` 或在 planner 提示里声明可用语言；当前 `sandbox_enabled` 已足够驱动注册。

### 6.6 前端

- `设置` 沙箱页面加 **Node 标签页**（`/sandbox/node`），复用 `sandbox-mapper` 模式新增 `bun-mapper`。
- 智能体表单加「沙箱语言」选择（Python / Node / 两者），对应 §6.3 开关。

### 6.7 必须遵守的现有红线（移植时不要丢）

1. `allow_sandbox`（或新 `allow_node_sandbox`）同时驱动能力层 + 提示层，绝不只写提示。
2. 沙箱开 ⇒ 不注册 `execute_command`。
3. 所有脚本路径过 `PathGuard`（工作空间边界），`code` 落盘 `ws/.wd_mem/scripts/` 并做文件名消毒。
4. 工具 `RequireApproval` 审批挂起。
5. 缺失依赖走**白名单 + 自愈重装**，禁止模型/用户手动装系统级包。
6. 绿色便携（不落 AppData）+ sidecar 退出码/超时统一处理。

---

## 7. 一页速查（接 Node 时的检查清单）

- [ ] `BunManager` 模块 + sidecar `bun` + `$RESOURCES/bun_root`
- [ ] 启动 `ensure_default_bun`，`lib.rs` 注册 `bun_*` 命令并 `.manage(BunManager)`
- [ ] `RunNodeSandboxTool`（`native__run_node_sandbox`，RequireApproval，code/script_path/PathGuard）
- [ ] `register_native_tools` 按开关注册 Node 工具；沙箱开仍不注册 `execute_command`
- [ ] `load_config` / `planner` 沙箱提示补 Node 用例
- [ ] 前端 bun-mapper + 沙箱 Node 页 + 智能体表单语言开关
- [ ] `npm/pip` 自愈白名单 + 缺失解析 + 自动重装重试
- [ ] Squad `run_member_subtask` 透传成员各自沙箱开关
