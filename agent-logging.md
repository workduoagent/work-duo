# 统一日志输出标准化（WorkDuo 日志框架引入）

> 日期：2026-09-09 ｜ 模块：Rust 全仓（`src-tauri/src`）+ 新增 `src/logging.rs`
> 世界观定位：L0 底层基座 / L1 通用接口的**领域无关通用基础设施**，不染任何 Agent 业务分支。

## 问题现象

用户在 Rust 代码里看到大量 `[agent] xxxxxx` 形式的 `println!`/`eprintln!` 裸打印：
1. 没有统一格式，时间/模块/函数/代码位置缺失，难以定位问题；
2. 日志只在 stdout 闪过，进程退出即丢失，无法留存分析；
3. 用户明确希望日志落盘到安装目录（`$RESOURCES/logs`，符合主流桌面软件惯例）。

## 用户要求（三条硬指标）

1. 标准格式 `[时间][包/模块][函数][代码位置]-[日志等级]-[日志内容]`；Rust 若有对标 Java Logback/slf4j 的框架（即 `tracing` 生态）可直接用。
2. 取消所有 `print` 裸打印，日志必须留存到文件。
3. 日志文件存放位置优先 `$RESOURCES`（即 Tauri `resource_dir` 下 `logs`），打包后只读则降级。

## Root Cause

- 之前没有统一日志框架，各模块直接 `println!`/`eprintln!` 约 218 处，分布在 23 个文件。
- 需要一套「门面 + 订阅器 + 落盘」的体系，对标 slf4j：`tracing`（门面宏） + `tracing-subscriber`（订阅器/`env-filter`） + `tracing-appender`（滚动文件）。

## 解决方案

### 依赖（`Cargo.toml`，`src-tauri/`）
```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-appender = "0.2"
chrono = "0.4"          # 本地时间格式化
```

### 新增 `src/logging.rs`（统一日志模块）
- **格式**：`[2026-09-09 14:40:12.345][workduo::agent::native][native__read_file][src/agent/native.rs:87]-INFO-[agent] 内容`
  - `[时间]`：`chrono::Local` 本地时间，毫秒精度；
  - `[包/模块]`：`event.metadata().target()`（如 `workduo::agent::native`）；
  - `[函数]`：`tracing::Span::current().metadata().name()`（由 `#[tracing::instrument]` 注入为函数名）；
  - `[文件:行]`：`event.metadata().file()`+`line()`（真实源码位置）；
  - `[等级]`：`event.metadata().level()`（INFO/WARN/ERROR/DEBUG）；
  - `[内容]`：event 的 `message` 字段（仅提取 message，忽略其余结构化字段）。
- **落盘**：`tracing_appender::rolling::RollingFileAppender::new(DAILY, &logs_dir, "workduo.log")` + `non_blocking()` + `std::mem::forget(guard)`（保活 worker 线程至进程结束，防丢日志）。
- **目录选择（健壮降级）**：`resource_dir()/logs` → `app_log_dir()/logs` → `app_config_dir()/logs` → `./logs`，逐个 `create_dir_all`+写探针，取第一个可写。
- **输出双写**：单 `fmt()` 订阅器 + 自定义 `MakeWriter`（`Tee`）同时写「滚动文件（关 ANSI 保证明文）」+「stdout（开发期观察）」。
- **过滤**：默认 `info`，环境变量 `RUST_LOG`（如 `RUST_LOG=debug`）可覆盖。

### `src/lib.rs` 接入
- `mod logging;`
- `.setup()` 第一行 `crate::logging::init_logging(app.handle());`
- 启动期 3 处 `eprintln!`（DB 就绪 / mamba / bun）改为 `tracing::error!`。

### 调用点改造（23 文件）
- 全部 `println!` → `tracing::info!`；`eprintln!` → `tracing::error!`。
- 关键函数加 `#[tracing::instrument(skip_all)]`（见下），使 `[函数]` 列有值：
  `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`/`run_squad_task`(commands)、`run_tool_calls_round`/`call_llm_stream`/`call_llm_stream_once`(runtime)、`run_pipeline`/`run_subtask`(pipeline)、`build_plan`(planner)、`suspend`(approval)、`verify_task`(verifier)、`sync_mcp_tools`/`call_mcp_tool`(mcp)、`run_squad_pipeline`/`run_squad_chat`(squad_orchestrator)、`start_scheduler`/`run_due_squads`(squad_scheduler)、`wait_db_ready`/`trigger_background_compaction`(round_compactor)。

## tracing 0.3 编译三坑（已趟平，可复用）

1. **无 `boxed` 特性**：`tracing-subscriber` 0.3 的 feature 列表里**没有 `boxed`**。两个 `fmt::Layer`（文件 NonBlocking + stdout）类型不同（writer/closure 各异），链式 `.with(file_layer).with(stdout_layer)` 报「`Layered<...>: Subscriber` 不满足」。
   → 改单 `fmt()` 订阅器构建器（内部自带 Registry，span 上下文自洽），配合自定义 `MakeWriter`(Tee) 扇出到文件+stdout，彻底绕开多 layer 组合。
2. **`FormatEvent` 用具名 struct 实现**：`event_format(|ctx, w, e| ...)` 闭包实测报「closure doesn't satisfy `FormatEvent<Registry, DefaultFields>`」——trait 实参类型不是裸 `&mut dyn Write` 而是带生命周期的类型别名 `Writer<'_>`，闭包参数推断对不上。
   → 定义 `struct WorkduoFormat; impl FormatEvent<Registry, DefaultFields> for WorkduoFormat { fn format_event(&self, _ctx: &FmtContext, writer: Writer<'_>, event: &Event) -> fmt::Result { write_line(writer, event) } }`，签名显式、零推断歧义。
3. **`Writer<'_>` ≠ `&mut dyn io::Write`**：`Writer<'a> = &'a mut (dyn io::Write + 'a)`，与 `&mut dyn io::Write`（即 `+ 'static`）因生命周期参数不兼容，直接当 `&mut dyn Write` 用会报类型不匹配 / 移动后复用。
   → `write_line<'a>(mut writer: Writer<'a>, ...)`，`FieldWriter<'a> { w: Writer<'a> }`；`event.record(&mut v)` 后换行走 `writeln!(v.w)` 而非已 move 的 `writer`。

> 附：`FmtContext` 在该版本是 crate 私有，外部只能从公开 re-export `tracing_subscriber::fmt::FmtContext` 引入（不能从 `fmt::format` 直接 import）。`FormatEvent`/`Writer`/`DefaultFields` 从 `tracing_subscriber::fmt::format` 引入。

## 验证

- `cargo check`（src-tauri，stable-x86_64-pc-windows-msvc）→ EXIT=0 ✅
- `grep -rnE "(println|eprintln)!" src-tauri/src` → NONE ✅（218 处裸打印全清零）
- `tracing::*` 宏覆盖 23 文件确认 ✅
- 前端 `npm run typecheck` 不受影响（仅改 Rust）→ EXIT=0 ✅

## 已知限制 / 待办

- stdout 镜像因文件层关 ANSI 而同为纯文本（开发期无颜色）；如需彩色 stdout 需拆双 writer 分别设 ANSI（当前为简洁牺牲）。
- `RUST_LOG` 是全局过滤，暂未做按模块分级；如需可后续扩展 `EnvFilter` directive（如 `workduo::agent::mcp=debug`）。
- 日志文件无自动清理上限（仅 DAILY 滚动按文件名分片），长期运行如需容量上限可加 `tracing_appender::rolling` 配合外部轮换或限制保留天数。
