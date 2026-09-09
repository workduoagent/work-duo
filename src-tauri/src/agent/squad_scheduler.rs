//! 小分队定时调度器（schedule 模式真触发）。
//!
//! 在 app 启动时由 lib.rs 的 setup() 调用 `start_scheduler(app)` 拉起后台循环：
//! 每 30s 扫描所有 `execution_mode='schedule'` 且配置了 `schedule_cron` 的小分队，
//! 用标准 5 字段 cron 表达式判断是否到点，到点则经 `load_squad` + `run_squad_task` 触发执行，
//! 并写入 `last_scheduled_at` 防止同一分钟重复触发。
//!
//! cron 解析与匹配为手写零依赖实现（引入 chrono 仅用于本地时间拆解），支持 `*` / `*/n` / `a-b` / `a,b`。

use std::time::Duration;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, Timelike};
use sqlx::Row;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;

use crate::agent::commands::load_squad;
use crate::agent::squad_orchestrator::run_squad_task;
use crate::agent::types::SquadRunStrategy;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn get_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?;
    match db_pool {
        DbPool::Sqlite(p) => Ok(p.clone()),
    }
}

/// 启动定时调度循环（在 app setup 中调用，后台独立异步任务）。
#[tracing::instrument(skip_all)]
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tracing::info!("[scheduler] 小分队定时调度器已启动（每 30s 扫描一次）");
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            run_due_squads(&app).await;
        }
    });
}

/// 扫描并触发所有到点的定时小分队。
#[tracing::instrument(skip_all)]
async fn run_due_squads(app: &AppHandle) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("[scheduler] 获取数据库失败：{e}");
            return;
        }
    };

    let rows = match sqlx::query("SELECT id, run_strategy, last_scheduled_at FROM agent_squad")
        .fetch_all(&pool)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::info!("[scheduler] 查询小分队失败：{e}");
            return;
        }
    };

    let now = Local::now();
    for row in &rows {
        let id: String = row.try_get("id").unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let rs_json: Option<String> = row.try_get("run_strategy").ok().flatten();
        let last: i64 = row
            .try_get::<Option<i64>, _>("last_scheduled_at")
            .ok()
            .flatten()
            .unwrap_or(0);
        let rs: SquadRunStrategy = rs_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<SquadRunStrategy>(s).ok())
            .unwrap_or_else(|| SquadRunStrategy {
                execution_mode: "manual".to_string(),
                schedule_cron: None,
                schedule_prompt: None,
                retry_count: 3,
            });

        if rs.execution_mode != "schedule" {
            continue;
        }
        let cron = match rs.schedule_cron.as_ref().filter(|c| !c.trim().is_empty()) {
            Some(c) => c.trim().to_string(),
            None => continue,
        };
        let schedule = match CronSchedule::parse(&cron) {
            Some(s) => s,
            None => {
                tracing::info!("[scheduler] 小分队 {} 的 cron 解析失败，跳过：{}", id, cron);
                continue;
            }
        };

        // 最近一次匹配时刻（<= now）；若无（近 8 天无匹配，如极端日期）则跳过。
        let fire = match schedule.last_fire_before(&now) {
            Some(t) => t,
            None => {
                tracing::info!("[scheduler] 小分队 {} 近 8 天内无匹配时刻，跳过", id);
                continue;
            }
        };
        // 已在此匹配时刻触发过则跳过（防同分钟重触发）。
        if last >= fire.timestamp_millis() {
            continue;
        }

        let fire_ms = fire.timestamp_millis();
        let prompt = rs.schedule_prompt.clone().unwrap_or_default();
        let app2 = app.clone();
        let pool2 = pool.clone();
        let sid = id.clone();
        tauri::async_runtime::spawn(async move {
            match load_squad(&app2, &sid).await {
                Ok(cfg) => {
                    let _ = sqlx::query(
                        "UPDATE agent_squad SET last_scheduled_at=?, updated_at=? WHERE id=?",
                    )
                    .bind(fire_ms)
                    .bind(now_ms())
                    .bind(&sid)
                    .execute(&pool2)
                    .await;
                    tracing::info!("[scheduler] 触发小分队 {}（cron={}）", sid, cron);
                    run_squad_task(&app2, cfg, prompt).await;
                }
                Err(e) => tracing::info!("[scheduler] load_squad 失败 {}: {e}", sid),
            }
        });
    }
}

/* ------------------------------------------------------------------ *
 * 手写 5 字段 cron：分 时 日 月 星期（星号=每单位，步长=星号斜杠n，
 * 区间=a减b，列表=a逗号b）
 * ------------------------------------------------------------------ */

struct CronSchedule {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    doms: Vec<u32>,
    months: Vec<u32>,
    dows: Vec<u32>,
    dom_is_star: bool,
    dow_is_star: bool,
}

impl CronSchedule {
    fn parse(spec: &str) -> Option<CronSchedule> {
        let parts: Vec<&str> = spec.split_whitespace().collect();
        if parts.len() != 5 {
            return None;
        }
        let minutes = parse_field(parts[0], 0, 59)?;
        let hours = parse_field(parts[1], 0, 23)?;
        let (doms, dom_is_star) = parse_field_star(parts[2], 1, 31)?;
        let months = parse_field(parts[3], 1, 12)?;
        let (mut dows, dow_is_star) = parse_field_star(parts[4], 0, 7)?;
        // 星期 7 归一为 0（周日）。
        dows = dows.into_iter().map(|d| if d == 7 { 0 } else { d }).collect();
        Some(CronSchedule {
            minutes,
            hours,
            doms,
            months,
            dows,
            dom_is_star,
            dow_is_star,
        })
    }

    /// 匹配给定本地时刻（按分钟粒度）。dom 与 dow 同时受限时采用「或」语义（Vixie cron）。
    fn matches(&self, dt: &DateTime<Local>) -> bool {
        if !self.minutes.contains(&dt.minute()) {
            return false;
        }
        if !self.hours.contains(&dt.hour()) {
            return false;
        }
        if !self.months.contains(&dt.month()) {
            return false;
        }
        let dom_ok = self.doms.contains(&dt.day());
        let dow_ok = self.dows.contains(&dt.weekday().num_days_from_sunday());
        if self.dom_is_star {
            dow_ok
        } else if self.dow_is_star {
            dom_ok
        } else {
            // 两者均受限：或语义。
            dom_ok || dow_ok
        }
    }

    /// 最近一次 <= now 的匹配时刻（至多回溯 8 天，覆盖周/日粒度；极端日期场景超出则跳过）。
    fn last_fire_before(&self, now: &DateTime<Local>) -> Option<DateTime<Local>> {
        let mut t = *now;
        // 截到整分钟，避免秒级抖动。
        t = t - ChronoDuration::seconds(t.second() as i64)
            - ChronoDuration::nanoseconds(t.timestamp_subsec_nanos() as i64);
        for _ in 0..(8 * 24 * 60) {
            if self.matches(&t) {
                return Some(t);
            }
            t = t - ChronoDuration::minutes(1);
        }
        None
    }
}

/// 解析单个 cron 字段为允许值集合。返回 (集合, 是否为 `*`) 便于 dom/dow 的或语义判断。
fn parse_field_star(spec: &str, min: u32, max: u32) -> Option<(Vec<u32>, bool)> {
    if spec.trim() == "*" {
        let set: Vec<u32> = (min..=max).collect();
        return Some((set, true));
    }
    let set = parse_field(spec, min, max)?;
    Some((set, false))
}

fn parse_field(spec: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut out: Vec<u32> = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        if let Some(step_part) = part.strip_prefix("*/") {
            // */n：全区间内按步长取。
            let step: u32 = step_part.parse().ok()?;
            if step == 0 {
                return None;
            }
            let mut v = min;
            while v <= max {
                out.push(v);
                v += step;
            }
        } else if part.contains('-') {
            // a-b 或 a-b/n：区间。
            let (lo, hi_part) = part.split_once('-')?;
            let lo: u32 = lo.trim().parse().ok()?;
            let (hi, step) = if let Some((h, s)) = hi_part.split_once('/') {
                (h.trim().parse().ok()?, s.trim().parse().ok()?)
            } else {
                (hi_part.trim().parse().ok()?, 1u32)
            };
            if lo > hi || hi > max || lo < min || step == 0 {
                return None;
            }
            let mut v = lo;
            while v <= hi {
                out.push(v);
                v += step;
            }
        } else if let Some((val, step)) = part.split_once('/') {
            // n/step：从 n 到 max 按步长。
            let val: u32 = val.trim().parse().ok()?;
            let step: u32 = step.trim().parse().ok()?;
            if step == 0 || val < min || val > max {
                return None;
            }
            let mut v = val;
            while v <= max {
                out.push(v);
                v += step;
            }
        } else {
            // 单值。
            let v: u32 = part.parse().ok()?;
            if v < min || v > max {
                return None;
            }
            out.push(v);
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
