# 修复：SOL 价格采集任务「子任务超过 5 轮仍未闭环」

## 现象
`Agent.log` 显示任务在「步骤 1/1 完成用户任务」卡死，重试 3 次均失败：子任务超过 5 轮仍未闭环，且无任何已完成步骤产物。

## 根因（两处叠加）
1. **规划器提取通道 bug（直接根因）**：`planner.rs::extract_content` 仅读取 `message.content`。MiniMax-M3 开 `reasoning=true` 时把规划 JSON 整体放入 `reasoning_content`/`reasoning`，`content` 为空 → JSON 解析失败 → 降级为「单任务巨块」(Single-Task Fallback)，整条多步任务被压进 1 个子任务，5 轮预算必然不够。
2. **沙箱能力描述与实现不符（放大因素）**：`default` 沙箱是纯净 Python 3.11（不预装第三方库），但提示谎称「内置常用数据科学库」。模型每轮 `check_env` 探测 pandas/numpy/openpyxl 全部 MISS，白白耗轮；日志第 3 次重试第 5 轮其实已用 stdlib urllib 取到 8 个数据点，但已无轮次做 Excel/预测。

## 修复（cargo check 通过）
- `src-tauri/src/agent/planner.rs`：`extract_content` 在 content 为空时回落 `reasoning_content`/`reasoning`；`extract_json_str` 增强去 markdown 代码围栏。
- `src-tauri/src/mamba_manager.rs`：新增 `run_script_with_selfheal` —— 脚本因 `ModuleNotFoundError` 失败时解析缺失模块，命中白名单（`AUTO_INSTALL_ALLOW`）则 `micromamba install` 后重试一次；`run_python_script` / `run_python_in_sandbox` 改走该 helper（纯净环境 + 按需追加依赖的最终闭环）。
- `src-tauri/src/agent/planner.rs` 能力描述 + `src-tauri/src/agent/native.rs` 工具描述：如实描述「纯净 Python + 运行时自动按需安装，不要逐个探测库」。

## 生效方式
用户需 `npm run tauri` 重编 Rust 后端。首次真实任务运行沙箱会自动安装所需库（走 `.mambarc` 清华镜像），首次较慢属正常。
