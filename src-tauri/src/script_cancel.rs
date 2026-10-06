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

    /// 注册后应能查到，且 subscribe 拿到接收端。
    #[test]
    fn register_then_subscribe_works() {
        let (id, _rx) = register_script_run();
        assert!(id.starts_with("sbr_"));
        assert!(subscribe_cancel(&id).is_some(), "注册后应能订阅到取消信号");
        unregister_script_run(&id);
    }

    /// 注销后 subscribe 应返回 None（run 已不存在）。
    #[test]
    fn after_unregister_subscribe_is_none() {
        let (id, _rx) = register_script_run();
        unregister_script_run(&id);
        assert!(subscribe_cancel(&id).is_none(), "注销后不应再能订阅");
    }

    /// 核心：请求取消应让订阅端收到信号。
    #[tokio::test]
    async fn request_cancel_delivers_signal() {
        let (id, rx) = register_script_run();
        let mut sub = subscribe_cancel(&id).expect("应可订阅");
        assert!(request_cancel(&id), "活跃 run 应返回 true");
        // 订阅端应收到一个信号
        let got = tokio::time::timeout(std::time::Duration::from_millis(500), sub.recv()).await;
        assert!(got.is_ok(), "取消信号应送达订阅端");
        unregister_script_run(&id);
    }

    /// 不存在的 run_id 请求取消应返回 false（不panic）。
    #[test]
    fn request_unknown_run_returns_false() {
        assert!(!request_cancel("sbr_not_exist"));
    }

    /// 注册表不应泄漏：注销后活跃数归零。
    #[test]
    fn unregister_prevents_leak() {
        let before = active_run_count();
        let (id, _rx) = register_script_run();
        assert_eq!(active_run_count(), before + 1);
        unregister_script_run(&id);
        assert_eq!(active_run_count(), before, "注销后活跃数应回到原值");
    }

    /// 两个 run 相互独立：取消 A 不应影响 B。
    #[tokio::test]
    async fn runs_are_isolated() {
        let (id_a, _a) = register_script_run();
        let (id_b, _b) = register_script_run();
        let mut sub_a = subscribe_cancel(&id_a).unwrap();
        let mut sub_b = subscribe_cancel(&id_b).unwrap();

        assert!(request_cancel(&id_a));
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
        unregister_script_run(&id_a);
        unregister_script_run(&id_b);
    }

    /// kill_process_tree 对 pid=0 应安全返回（不执行系统调用）。
    #[test]
    fn kill_process_tree_zero_pid_is_noop() {
        kill_process_tree(0); // 不应 panic
    }
}
