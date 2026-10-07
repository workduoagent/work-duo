//! 沙箱脚本执行的**用户主动取消**通道（F049）。
//!
//! 背景：沙箱脚本此前只有「硬超时」一条终止路径（`WD_SANDBOX_TIMEOUT_SECS`，
//! 默认 600s），用户对着一个跑飞的 `while True` 无能为力——UI 上只有
//! `disabled={running}`。本模块提供取消信号，让「停止」按钮真正能中断执行。
//!
//! 设计取舍（与用户确认的三点）：
//! 1. **取消粒度 = 进程组**：只 kill 父进程会留下它 spawn 的子进程
//!    （`pip install` 会拉子进程），故 Windows 下用 `taskkill /T /F` 杀整组；
//! 2. **超时与取消同一套 select**：两者都是「抢同一个等待分支」，无需两套机制；
//! 3. **只清临时目录、不回滚已装包**：回滚成本高且用户可能想保留已装依赖。
//!
//! 用法：
//! ```ignore
//! let run_id = register_script_run();
//! // ... 启动子进程，select! { _ = wait => ..., _ = cancel_signal(run_id) => ... }
//! unregister_script_run(&run_id);
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::broadcast;

/// 活跃脚本运行的取消信号注册表：`run_id` → 取消信号接收端。
///
/// 用 `broadcast` 而非 oneshot：同一 run 可能被多处 select 消费
/// （如「超时」与「取消」分支同时挂在一个 select 上），
/// broadcast 允许克隆出多个接收端，任一取消信号到达即全体唤醒。
static RUNS: OnceLock<Mutex<HashMap<String, broadcast::Sender<()>>>> = OnceLock::new();

fn runs() -> &'static Mutex<HashMap<String, broadcast::Sender<()>>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 「本次执行是被用户取消」的机器可读前缀（F049 收尾修复）。
///
/// **为什么需要它**：沙箱脚本命令的返回契约是「stdout 字符串」，前端 `invoke`
/// 拿不到结构化状态位，取消只能走 `Err(消息)` 通道。前端原实现用
/// `error.includes('已取消')` 判断，但 Tauri 会把 Rust 的 `Err(String)` 包一层
/// 再抛给前端，字符串形态与源码里的中文文案并不保证一致——真机实测因此
/// 把「已取消」误判为「脚本运行错误」弹了红 toast。
///
/// **契约**：前缀一旦发布不可改（前端按它判定）；只追加、不修改语义。
/// 显示文案仍放在前缀之后，由前端剥离后再展示给用户。
///
/// Rust 侧**刻意不提供** `is_cancelled_message()` 之类的判定辅助函数：
/// 唯一消费方是前端（`src/core/mapper/script-cancel.ts` 的 `isScriptCancelled`），
/// Rust 这边取消语义只用于「拼出带前缀的消息」，不需要再判断一次。
/// 真机链路里 agent 运行路径（`run_python_in_sandbox`）**没有取消入口**，
/// 故确实不存在第二个消费方——写了只会是 `dead_code`。
pub const CANCELLED_PREFIX: &str = "CANCELLED:";

/// 最近一次注册的 run_id（供前端在返回契约无法变更时查询）。
static LAST_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// 注册一次脚本执行，返回 run_id 与取消信号接收端。
///
/// 接收端需在 select 前 `let _rx = rx.subscribe()` 克隆一份后传入，
/// 否则本函数返回的 `rx` 会被立即丢弃导致信号丢失。
pub fn register_script_run() -> (String, broadcast::Receiver<()>) {
    let id = format!(
        "sbr_{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    if let Ok(mut l) = LAST_ID.get_or_init(|| Mutex::new(None)).lock() {
        *l = Some(id.clone());
    }
    let (tx, rx) = broadcast::channel(4);
    if let Ok(mut m) = runs().lock() {
        m.insert(id.clone(), tx);
    }
    (id, rx)
}

/// 注销（正常结束 / 出错后都要调，避免注册表泄漏）。
pub fn unregister_script_run(run_id: &str) {
    if let Ok(mut m) = runs().lock() {
        m.remove(run_id);
    }
    // 🔴 F049 收尾修复：`LAST_ID` 必须同步清空，否则会留下陈旧 run_id。
    //
    // 故障链（真机实测）：第二次运行时，前端在 Rust 完成 register 之前就调了
    // `last_script_run_id()`，拿到的是**上一次运行遗留的 id**（注销只清了注册表，
    // 没清 LAST_ID）。于是用户点「停止」→ `request_cancel(旧 id)` → 查不到 →
    // 返回 false，界面提示「已结束，无需停止」，而新脚本其实还在跑。
    // 日志实证：两次取消的 run_id 完全相同（`sbr_1791374237784_0`）。
    //
    // 修法：仅当 LAST_ID 指向被注销的 run 时才清（避免注销旧 run 误清新 run 的 id）。
    if let Ok(mut l) = LAST_ID.get_or_init(|| Mutex::new(None)).lock() {
        if l.as_deref() == Some(run_id) {
            *l = None;
        }
    }
}

/// 订阅某run 的取消信号。
///
/// 供 `run_sidecar_policy` 内部在 spawn 之后调用——
/// 此刻 run_id 已在注册表里，可取到 sender 克隆出一个接收端。
pub fn subscribe_cancel(run_id: &str) -> Option<broadcast::Receiver<()>> {
    runs()
        .lock()
        .ok()
        .and_then(|m| m.get(run_id).map(|tx| tx.subscribe()))
}

/// 请求取消：向该 run 的所有接收端广播。
///
/// - `true`  = 该 run 存在且已发出取消信号
/// - `false` = run 不存在（已结束 / run_id 无效 / 已注销）
pub fn request_cancel(run_id: &str) -> bool {
    let sender = {
        let m = match runs().lock() {
            Ok(m) => m,
            Err(_) => return false,
        };
        match m.get(run_id) {
            Some(tx) => tx.clone(),
            None => return false,
        }
    };
    // 无订阅者时 send 仍返回 Err（SendError），但信号已尽力发出；
    // 此处只要 run 存在即视为「已请求取消」。
    let _ = sender.send(());
    true
}

/// 当前活跃脚本运行数（供自检/测试断言）。
pub fn active_run_count() -> usize {
    runs().lock().map(|m| m.len()).unwrap_or(0)
}

/// 终止一个子进程**及其整组后代**（F049 取舍 1）。
///
/// 为什么不能只 `child.kill()`：tauri sidecar 的 `Child::kill` 只终止直接子进程。
/// 沙箱里 `pip install` / `npm i` 会 spawn 自己的子进程，只杀父进程会留下
/// 继续跑的孤儿（这正是原「硬超时」路径的老问题）。
///
/// - Windows：`taskkill /T /F`（T=树形终止，/F=强制）。用 `CREATE_NO_WINDOW`
///   避免弹窗（与项目既有约定一致，见 bun_manager 的 cmd 调用）。
/// - 其他平台：留空 —— tokio 的 `Child::kill` 由调用方兜底执行，此处不引入
///   未验证的进程组语义。
/// 调用方随后仍应执行 `child.kill()` 作为兜底（双保险，不冲突）。
/// 沙箱里 `pip install` / `npm i` 会 spawn 自己的子进程，只杀父进程会留下
/// 继续跑的孤儿（这正是原「硬超时」路径的老问题）。
///
/// - Windows：`taskkill /T /F`（T=树形终止，/F=强制）。用 `CREATE_NO_WINDOW`
///   避免弹窗（与项目既有约定一致，见 bun_manager 的 cmd 调用）。
/// -其他平台：先 `kill()` 打断主进程；子进程由各自平台的进程组机制处理
///   （POSIX 下 micromamba/bun 的子进程通常随父进程退出）。
///
/// 调用方随后仍应执行 `child.kill()` 作为兜底（双保险，不冲突）。
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // 非 Windows：仅能直接 kill（tokio 的 Child::kill 兜底调用方会做），
        // 这里不做额外处理以免引入未验证的进程组语义。
    }
}

// ============================ Tauri 命令 ============================

/// 取消一次沙箱脚本执行（F049）。
///
/// 前端在「运行中」时把按钮换成「停止」，点击即调本命令。返回：
/// - `true`  = 已发出取消信号（进程树将在下一拍被终止）
/// - `false` = run_id 不存在（已结束 / 已被取消 / 传错）
#[tauri::command]
pub fn cancel_script(run_id: String) -> Result<bool, String> {
    let ok = request_cancel(&run_id);
    if !ok {
        tracing::warn!("[script_cancel] 取消失败：run_id={} 不在活跃注册表（可能已结束）", run_id);
    } else {
        tracing::info!("[script_cancel] 已请求取消 run_id={}", run_id);
    }
    Ok(ok)
}

/// 列出当前活跃的脚本运行数（供 UI 判断「是否还有可取消的运行」/ 自检）。
#[tauri::command]
pub fn list_active_script_runs() -> Result<usize, String> {
    Ok(active_run_count())
}

/// 读取最近一次注册的 run_id。
fn last_registered_id() -> Option<String> {
    LAST_ID.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|g| g.clone())
}

/// 取最近一次注册的脚本 run_id（F049）。
///
/// 为什么需要：`run_python_script` / `run_node_script` 的返回契约是
/// 「stdout 字符串」（前端 invoke 依赖，不可改），拿不到 run_id；而
/// `cancel_script` 需要 run_id。故提供本命令让前端在启动后查询——
/// 单用户单窗口下「最近一次注册」即本次运行。
///
/// 竞态说明：若并发跑了多个脚本，本命令只返回最近一个；此时前端点「停止」
/// 可能停错。UI 侧应据此限制为「同一时刻只允许一个脚本运行」（当前实现已如此）。
#[tauri::command]
pub fn last_script_run_id() -> Result<Option<String>, String> {
    Ok(last_registered_id())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全局测试锁：`RUNS` / `LAST_ID` 是**进程级静态状态**，而 Rust 测试默认
    /// 多线程并行，`#[test]` 之间会互相污染（实测踩过：`unregister_clears_last_id`
    /// 读到别的用例刚注册的 run_id，`unregister_prevents_leak` 数出多余活跃项）。
    ///
    /// 凡测试会register / unregister / 读活跃数，都必须先 `let _g = lock();`。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 注册后应能查到，且 subscribe 拿到接收端。
    #[test]
    fn register_then_subscribe_works() {
        let _g = lock();
        let (id, _rx) = register_script_run();
        assert!(id.starts_with("sbr_"));
        assert!(subscribe_cancel(&id).is_some(), "注册后应能订阅到取消信号");
        unregister_script_run(&id);
    }

    /// 注销后 subscribe 应返回 None（run 已不存在）。
    #[test]
    fn after_unregister_subscribe_is_none() {
        let _g = lock();
        let (id, _rx) = register_script_run();
        unregister_script_run(&id);
        assert!(subscribe_cancel(&id).is_none(), "注销后不应再能订阅");
    }

    /// 核心：请求取消应让订阅端收到信号。
    ///
    /// ⚠️ **锁必须分段持有，不能跨 `.await`**：`lock()` 是同步 `MutexGuard`，
    /// 跨 await 持有会让 tokio 当前线程被阻塞（同线程其它用例要等锁）而 await
    /// 又在等 timer —— 经典死锁。故只在纯同步段加锁。
    #[tokio::test]
    async fn request_cancel_delivers_signal() {
        let (id, rx, mut sub) = {
            let _g = lock();
            let (id, rx) = register_script_run();
            let sub = subscribe_cancel(&id).expect("应可订阅");
            assert!(request_cancel(&id), "活跃 run 应返回 true");
            (id, rx, sub)
        };
        // 订阅端应收到一个信号（此时已不持锁）
        let got = tokio::time::timeout(std::time::Duration::from_millis(500), sub.recv()).await;
        assert!(got.is_ok(), "取消信号应送达订阅端");
        drop(rx);
        let _g = lock();
        unregister_script_run(&id);
    }

    /// 不存在的 run_id 请求取消应返回 false（不panic）。
    #[test]
    fn request_unknown_run_returns_false() {
        let _g = lock();
        assert!(!request_cancel("sbr_not_exist"));
    }

    /// 🔴 F049 收尾回归：注销必须同步清空 `LAST_ID`，否则前端会拿到陈旧 run_id
    /// （真机故障：第二次运行点「停止」无效，日志实证两次取消拿到同一个旧 id）。
    #[test]
    fn unregister_clears_last_id() {
        let _g = lock();
        let before = last_registered_id();
        let (id, _rx) = register_script_run();
        assert_eq!(
            last_registered_id().as_deref(),
            Some(id.as_str()),
            "注册后 LAST_ID 应指向本次 run"
        );
        unregister_script_run(&id);
        assert!(
            last_registered_id().is_none(),
            "注销后 LAST_ID 应被清空（否则下次运行会读到陈旧 run_id）"
        );
        // 复原全局状态，避免影响其它测试
        if let Ok(mut l) = LAST_ID.get_or_init(|| Mutex::new(None)).lock() {
            *l = before;
        }
    }

    /// 注销旧 run 不得误清新 run 的 LAST_ID（清空需带 run_id 比对）。
    #[test]
    fn unregister_old_run_keeps_new_last_id() {
        let _g = lock();
        let before = last_registered_id();
        let (id_a, _a) = register_script_run();
        let (id_b, _b) = register_script_run(); // B 是最新
        assert_eq!(last_registered_id().as_deref(), Some(id_b.as_str()));
        unregister_script_run(&id_a); // 注销的是**旧**的 A
        assert_eq!(
            last_registered_id().as_deref(),
            Some(id_b.as_str()),
            "注销旧 run 不应清掉新 run 的 LAST_ID"
        );
        unregister_script_run(&id_b);
        if let Ok(mut l) = LAST_ID.get_or_init(|| Mutex::new(None)).lock() {
            *l = before;
        }
    }

    /// 取消消息的前缀契约（与前端 `isScriptCancelled` 对称）。
    ///
    /// 真机故障：前端原先靠中文文案 `includes('已取消')` 判定，Tauri 包一层后
    /// 匹配失效，取消被当成执行错误。故改用稳定前缀，两侧都需认这个契约。
    ///
    /// 前端同样的三组断言在 `script-cancel.test.ts`（TS 侧）—— 两边都留，
    /// 任一侧改动前缀都会立刻失败。
    #[test]
    fn cancelled_prefix_contract() {
        // 前缀本身不可变（前端按它判定，改动即破坏跨端契约）
        assert_eq!(CANCELLED_PREFIX, "CANCELLED:");
        // 取消消息以此前缀开头
        let cancelled = format!("{CANCELLED_PREFIX}沙箱脚本已被用户取消，进程已终止。");
        assert!(cancelled.starts_with(CANCELLED_PREFIX));
        assert!(cancelled.contains(CANCELLED_PREFIX));
        // 反例：只有中文文案、无前缀 ⇒ 前端判定为「非取消」（旧缺陷的由来）
        let legacy = "沙箱脚本已被用户取消，进程已终止。";
        assert!(!legacy.contains(CANCELLED_PREFIX));
        // 反例：真实失败不得被误判为取消
        assert!(!"脚本文件不存在：E:\\x.py".contains(CANCELLED_PREFIX));
        assert!(!"沙箱脚本执行超时（600s），已强制终止进程。".contains(CANCELLED_PREFIX));
    }

    /// 注册表不应泄漏：注销后活跃数归零。
    #[test]
    fn unregister_prevents_leak() {
        let _g = lock();
        let before = active_run_count();
        let (id, _rx) = register_script_run();
        assert_eq!(active_run_count(), before + 1);
        unregister_script_run(&id);
        assert_eq!(active_run_count(), before, "注销后活跃数应回到原值");
    }

    /// 两个 run 相互独立：取消 A 不应影响 B。
    ///
    /// 同上，锁**分段持有**，不跨 `.await`。
    #[tokio::test]
    async fn runs_are_isolated() {
        let (id_a, id_b, mut sub_a, mut sub_b) = {
            let _g = lock();
            let (id_a, _a) = register_script_run();
            let (id_b, _b) = register_script_run();
            let sub_a = subscribe_cancel(&id_a).unwrap();
            let sub_b = subscribe_cancel(&id_b).unwrap();
            assert!(request_cancel(&id_a));
            (id_a, id_b, sub_a, sub_b)
        };
        // A 收到
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), sub_a.recv())
                .await
                .is_ok(),
            "A 应收到取消"
        );
        // B 不应收到（超时即正确）
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), sub_b.recv())
                .await
                .is_err(),
            "B 不应收到 A 的取消"
        );
        let _g = lock();
        unregister_script_run(&id_a);
        unregister_script_run(&id_b);
    }

    /// kill_process_tree 对 pid=0 应安全返回（不执行系统调用）。
    #[test]
    fn kill_process_tree_zero_pid_is_noop() {
        kill_process_tree(0); // 不应 panic
    }
}
