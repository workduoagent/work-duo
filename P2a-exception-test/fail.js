// P2a 异常档A 弹窗 · 确定性测试脚本
// 用途：让智能体在沙箱里运行本脚本，脚本立即抛错，
// 使 native__run_node_sandbox 返回 Err(ToolError::ExecutionFailed)（native.rs:1476）。
// 流水线在「连续 2 轮工具调用全部失败」时判 out.success=false → 触发档A 弹窗。
//
// 关键点（来自 pipeline.rs:1053-1083）：
//   单次工具失败不会立刻弹窗——错误会回灌给模型，模型可重试或"汇报后收尾"。
//   只有连续 2 轮工具全失败（consecutive_errors >= MAX_SUBTASK_CONSECUTIVE_ERRORS）
//   或迭代耗尽，才会进入恢复链路弹窗。
//   因此提示词要让模型"必须成功、失败就重试"，逼出第 2 次失败。

throw new Error(
  "HITL_EXCEPTION_TEST: 故意抛错，用于触发异常档A 恢复弹窗（跳过/重试/接管）"
);
