//! 统一日志基础设施（L0/L1 通用，领域无关，不染任何业务分支）。
//!
//! 标准格式：`[时间][包/模块][函数][代码位置]-[日志等级]-[日志内容]`
//! 例：`[2026-09-09 14:40:12.345][workduo::agent::native][native__read_file][src/agent/native.rs:87]-INFO-[agent] native__read_file: 路径校验失败 ...`
//!
//! 落盘策略（健壮降级）：
//!   1. `$RESOURCES/logs`（即 `app.path().resource_dir()/logs`，符合用户约定）
//!   2. `app.path().app_log_dir()/logs`（打包后 resource_dir 只读时的可写兜底）
//!   3. `app.path().app_config_dir()/logs`
//!   4. 进程当前工作目录 `./logs`（最终兜底）
//!
//! 输出目标：单条日志经自定义 `MakeWriter`（Tee）同时写入「每日滚动文件」与「stdout」
//! （stdout 便于 `npm run tauri` 开发期观察，文件层关闭 ANSI 保证明文可分析）。
//! 采用 `fmt()` 订阅器构建器（内部自带 Registry，span 上下文自洽），规避 tracing 0.3
//! `registry()+fmt::layer()` 链路中 `Layered<EnvFilter,Registry>` 不满足 `LookupSpan<Self>` 的编译陷阱。
//!
//! 实现要点：`[函数]` 取自当前 span 名（`#[tracing::instrument]` 注入的 span 名即函数名，
//! 经 `Span::current().metadata().name()` 取），从而无需在 `event_format` 里依赖 `FmtContext`
//! 的泛型推断。`FormatEvent` 以具名 struct + `Writer<'_>` 实现（避免闭包参数推断失败：
//! trait 实参类型是带生命周期的 `Writer<'_>` 而非裸 `&mut dyn Write`，闭包推断对不上）。

use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use tauri::Manager;
use tracing::field::{Field, Visit};
use tracing::Event;
use tracing_subscriber::fmt::format::{DefaultFields, FormatEvent, Writer};
use tracing_subscriber::fmt::FmtContext;
use tracing_subscriber::registry::Registry;
use tracing_subscriber::EnvFilter;

/// 初始化全局日志订阅器。必须在任何其他 `tracing::*` 宏调用之前调用。
/// 返回最终选用的日志目录（便于排查看板）。
pub fn init_logging(app: &tauri::AppHandle) -> std::path::PathBuf {
    let logs_dir = choose_logs_dir(app);

    // Daily 滚动文件 appender（如 workduo.log.2026-09-09）。
    let file_appender = tracing_appender::rolling::RollingFileAppender::new(
        tracing_appender::rolling::Rotation::DAILY,
        &logs_dir,
        "workduo.log",
    );
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // 保活 worker 线程至进程结束，避免缓冲区未刷盘导致日志丢失。
    std::mem::forget(guard);

    // 默认 info；可用环境变量 RUST_LOG（如 RUST_LOG=debug）覆盖。
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    // 单 `fmt::Subscriber` 订阅器：内部自带 Registry（span 上下文自洽），规避
    // `registry()+.with(EnvFilter)+.with(fmt::layer())` 链中 `Layered<EnvFilter,Registry>`
    // 不满足 `fmt::Layer` 所要求 `LookupSpan<Self>` 的编译陷阱。
    // 同一条日志经 `TeeWriter` 同时落文件 + 镜像 stdout；文件层关 ANSI 保证明文。
    // 用具名 `WorkduoFormat` 实现 `FormatEvent`，避免闭包参数推断失败。
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(TeeWriter { file: non_blocking })
        .with_target(false)
        .with_level(false)
        .with_ansi(false)
        .event_format(WorkduoFormat)
        .init();

    tracing::info!("日志初始化完成，目录 = {}", logs_dir.display());
    logs_dir
}

/// 渲染单行：`[时间][模块][函数][文件:行]-[等级]-[内容]`。
/// `FormatEvent` 的 writer 为 `Writer<'_>`（即 `&'a mut (dyn io::Write + 'a)`），本函数直接吃该类型。
fn write_line<'a>(mut writer: Writer<'a>, event: &Event) -> std::fmt::Result {
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let module = event.metadata().target();
    let file = event.metadata().file().unwrap_or("-");
    let line = event.metadata().line().unwrap_or(0);
    // [函数]：当前 span 名（#[tracing::instrument] 注入为函数名）；无 span 时为 "-"。
    let span = tracing::Span::current()
        .metadata()
        .map(|m| m.name())
        .unwrap_or("-");
    write!(
        writer,
        "[{}][{}][{}][{}:{}]-{}-",
        ts, module, span, file, line, event.metadata().level()
    )
    .map_err(|_| std::fmt::Error)?;
    // [内容]：event 的 message 字段（tracing 把格式串存入名为 "message" 的字段）。
    let mut v = FieldWriter { w: writer };
    event.record(&mut v);
    writeln!(v.w).map_err(|_| std::fmt::Error)?;
    Ok(())
}

/// 仅提取 event 的 `message` 字段作为日志正文（忽略其余结构化字段）。
struct FieldWriter<'a> {
    w: Writer<'a>,
}

impl<'a> Visit for FieldWriter<'a> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            let _ = write!(self.w, "{}", value);
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.w, "{:?}", value);
        }
    }
}

/// 标准格式渲染器：实现 `FormatEvent`，供 `fmt()` 订阅器 `event_format` 调用。
/// 用具名类型（而非闭包）可消除 `event_format` 闭包参数（trait object + &Event）的推断歧义。
struct WorkduoFormat;

impl FormatEvent<Registry, DefaultFields> for WorkduoFormat {
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, Registry, DefaultFields>,
        writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        write_line(writer, event)
    }
}

/// 自定义 `MakeWriter`：每次 `make_writer` 返回一对「文件 NonBlocking + stdout」的扇出写入器。
/// `NonBlocking` 可 `Clone`，stdout 每次现取，故 Tee 完全持有所有权、无生命周期纠缠。
#[derive(Clone)]
struct TeeWriter {
    file: tracing_appender::non_blocking::NonBlocking,
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TeeWriter {
    type Writer = Tee<tracing_appender::non_blocking::NonBlocking, std::io::Stdout>;
    fn make_writer(&'a self) -> Self::Writer {
        Tee {
            a: self.file.clone(),
            b: std::io::stdout(),
        }
    }
}

/// 同时写两份的扇出写入器（文件为主，stdout 尽力而为）。
struct Tee<A: IoWrite, B: IoWrite> {
    a: A,
    b: B,
}

impl<A: IoWrite, B: IoWrite> IoWrite for Tee<A, B> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.a.write(buf)?;
        let _ = self.b.write_all(buf);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.a.flush()?;
        let _ = self.b.flush();
        Ok(())
    }
}

/// 按优先级选出第一个可创建且可写入的日志目录。
fn choose_logs_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let candidates: Vec<std::path::PathBuf> = vec![
        app.path().resource_dir().ok().map(|p| p.join("logs")),
        app.path().app_log_dir().ok().map(|p| p.join("logs")),
        app.path().app_config_dir().ok().map(|p| p.join("logs")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for dir in &candidates {
        if std::fs::create_dir_all(dir).is_ok() && is_writable(dir) {
            return dir.clone();
        }
    }

    // 最终兜底：进程当前工作目录下的 logs（极少触发）。
    let fallback = std::path::PathBuf::from("logs");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// 探测目录是否可写（建一个临时文件再删）。
fn is_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".workduo_writetest");
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 自测闭环专用：读取当日 Rust 运行日志（每日滚动文件 `workduo.log.YYYY-MM-DD`）。
///
/// - `cursor`：起始行索引（从 0 计），仅返回该索引之后的行；用于「增量 tail」。
/// - `since_ts`：ISO 时间前缀过滤，行首 `[YYYY-MM-DD HH:MM:SS.mmm]`，只返回该时间之后的日志。
/// - `level`：可选等级过滤（INFO/WARN/ERROR/DEBUG），按 `]-LEVEL-` 匹配。
/// - `limit`：最多返回行数（从末尾截取）。
///
/// 纯读命令，不改动任何产品逻辑；落盘路径复用 `choose_logs_dir` 的优先级策略。
#[tauri::command]
pub fn get_run_logs(
    app: tauri::AppHandle,
    cursor: Option<usize>,
    since_ts: Option<String>,
    level: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let dir = choose_logs_dir(&app);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let path = dir.join(format!("workduo.log.{today}"));
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取日志失败: {e}"))?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    if let Some(ts) = since_ts.as_ref() {
        // 行首形如 `[2026-09-09 14:40:12.345]`，取 [1..24) 与时间戳比较（含方括号）。
        lines.retain(|l| l.get(1..24).map(|t| t >= ts.as_str()).unwrap_or(false));
    }
    if let Some(lv) = level.as_ref() {
        let up = lv.to_uppercase();
        let needle = format!("]-{up}-");
        lines.retain(|l| l.contains(&needle));
    }
    if let Some(c) = cursor {
        let skip = c.min(lines.len());
        lines = lines.split_off(skip);
    }
    if let Some(lim) = limit {
        if lines.len() > lim {
            lines = lines.split_off(lines.len() - lim);
        }
    }
    Ok(lines)
}

/// 前端日志转发：把前端（TS/Webview）的关键操作日志也落到同一份每日滚动文件
///（`workduo.log.YYYY-MM-DD`），使后端 `get_run_logs` 能一并回看「前端 KB 操作 / 索引钩子」
/// 等链路，便于跨端排错。
///
/// 写入格式与 Rust `tracing` 完全一致（`[时间][模块][fe][web:0]-LEVEL-内容`），
/// 因此 `get_run_logs` 的 `since_ts` / `level` 过滤对前端日志同样生效；
/// 同时镜像一行到 stdout（开发期观察）。fire-and-forget 语义由前端调用方保证，本命令只管落盘。
#[tauri::command]
pub fn log_frontend(
    app: tauri::AppHandle,
    level: String,
    module: String,
    message: String,
) {
    let lvl = match level.to_uppercase().as_str() {
        "ERROR" | "ERR" => "ERROR",
        "WARN" | "WARNING" => "WARN",
        "DEBUG" => "DEBUG",
        _ => "INFO",
    };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let line = format!("[{}][{}][fe][web:0]-{}-{}", ts, module, lvl, message);
    // 复用 choose_logs_dir 的优先级策略，确保与 tracing_appender 写同一文件。
    let dir = choose_logs_dir(&app);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let path = dir.join(format!("workduo.log.{today}"));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
    println!("{}", line);
}
