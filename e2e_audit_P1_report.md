# P1 详细报告：SIMPLE_CHAT 完成但 `agent_get_run_trace` 的 `reply=0`

> 背景：E2E 审计 diag4（GLM-5.3-Flash，无 KB，极简自由会话）→ `status=done`、`intent=SIMPLE_CHAT`，但 `agent_get_run_trace().reply` 字符数为 0。
> 本报告基于**代码研读**定位根因，澄清「这是观测缓冲缺口，而非数据丢失缺陷」，并给出改进指导。
>
> **⚡ 2026-09-22 11:3x 真机复测已进一步翻案（见第七节）：`reply=0` 是审计驱动自身的两处 bug（trace 解包遗漏 + roundId 未接线）造成的假阳性；引擎与 GLM 全部健康、数据全部正确落库。第二~四节的根因分析作为过程记录保留，第四节「改动 1」已撤回。**

---

## 一、现象与歧义点（为何原表述不明确）

原审计把 `trace.reply=0` 当作「回复正文可能未落库」的信号，这是**不严谨**的：

- `agent_get_run_trace` 返回的 `reply` 字段 = `events::get_trace().reply`（events.rs:84-107），来自进程级单缓冲 `TRACE_REPLY`（`static` + `Mutex<String>`）。
- 这个缓冲**只**由 `events::append_reply(text)` 写入，而 `append_reply` **只**被 `emit_text_chunk`（events.rs:273,77）调用。
- 因此 `reply=0` 只证明一件事：**本次 run 的流式文本增量回调没有把正文喂进 `TRACE_REPLY`**。它**完全不反映** `assistant_answer` 这一真正的 UI 落库列。

→ 原结论「核实回复正文是否正确落库」需要从「读 trace.reply」改为「读 `agent_conversation_round.assistant_answer`」。

---

## 二、代码级根因：两条相互独立的数据通路

### 通路 A（权威落库列）：`assistant_answer`

`run_simple_chat`（runtime.rs:770-870，SIMPLE_CHAT 分支）：

```rust
// runtime.rs:800  call_llm_stream(..., Some(&|delta| { if !delta.is_empty() { events::emit_text_chunk(app, delta, false); } }), ...)
// runtime.rs:832  simple_final_text = content.clone();   // outcome.content 即完整终态正文
// runtime.rs:858  crate::agent::round_compactor::persist_round_answer_if_empty(app, round_id, &simple_final_text).await;
```

`persist_round_answer_if_empty`（round_compactor.rs:311-332）：

```rust
pub(crate) async fn persist_round_answer_if_empty(app, round_id, answer) {
    if answer.trim().is_empty() { return; }                 // 空才跳过
    UPDATE agent_conversation_round
      SET assistant_answer = ? WHERE id = ? AND (assistant_answer IS NULL OR assistant_answer = '');
}
```

**结论（确定性）**：只要 `call_llm_stream` 返回的 `outcome.content` 非空、且 `cfg.round_id` 存在，`assistant_answer` 就被引擎无条件写入（与前端链路、与流式 delta 是否回传**无关**）。这正是「跨链路数据落库引擎终态统一兜底」的既定设计（MEMORY 铁律）。

### 通路 B（观测缓冲）：`TRACE_REPLY` / `trace.reply`

`run_simple_chat` 里 `emit_text_chunk` 的调用点只有两处：
1. `call_llm_stream` 的 per-delta 回调（runtime.rs:809）——**依赖 provider 真正按 SSE delta 回传文本增量**；
2. 终态 done 标记 `emit_text_chunk(app, "", true)`（runtime.rs:839）——空串，不追加内容。

若所选模型/provider 在 `call_llm_stream` 中**不以增量 delta 形式回传正文**（仅终态 `outcome.content` 一次性返回），则 `append_reply` 从未被喂入真实文本 → `TRACE_REPLY` 恒为空 → `trace.reply` 字符数 = 0。

> 对照 COMPOSITE 分支：其终态走 `stream_final_text`（runtime.rs:641-660），逐片 `emit_text_chunk` 强制喂 `TRACE_REPLY`，故 COMPOSITE 的 `trace.reply` 始终可靠；**SIMPLE_CHAT 没有这层兜底，于是出现「通路 A 有、通路 B 空」的不对称**。

---

## 三、根因结论（明确回答用户疑问）

**`reply=0` 是「观测缓冲缺口」，不是「数据丢失缺陷」。**

- `assistant_answer`（UI 真正展示的列）几乎可以肯定已正确落库（由 `simple_final_text` 无条件写入）。
- `trace.reply` 空，是因为 GLM provider 的流式 delta 未回传，而 SIMPLE_CHAT 路径缺一层对 `TRACE_REPLY` 的兜底填充。
- 我此前把 `trace.reply=0` 当成验收不通过（扣「真实验收」分）属于**误判/测量口径错误**，应在复测中更正。

### 仍需一次性确认（消除 1% 不确定）

若 `outcome.content` 本身为空、或 diag4 的 `agent_run_task` 未传 `round_id`，`assistant_answer` 才会真的为空。请用 diag4 的 round_id 跑一条 SQL 闭环确认：

```sql
SELECT id, length(assistant_answer) AS ans_len,
       length(thinking_content)     AS think_len,
       length(tool_calls_summary)   AS tool_len
FROM agent_conversation_round
WHERE id = '<diag4 的 round_id>';   -- agent_run_task 返回值
```

- 若 `ans_len > 0` → 确诊「数据已落库、仅 trace 观测缺口」，P1 降为健壮性改进项（见第四节）。
- 若 `ans_len = 0` → 才是真缺陷，需查 `call_llm_stream` 对该 provider 是否返回空 `content`、或 `round_id` 是否传入（需另立 issue）。

---

## 四、改进指导（代码级，建议改动）

### 改动 1（P1 主修复）：让 `trace.reply` 在 SIMPLE_CHAT 也权威化

与 COMPOSITE 的 `stream_final_text` 对齐，给 `TRACE_REPLY` 加一次性兜底，使其与 `assistant_answer` 一致，消除自测误判。

`src-tauri/src/agent/events.rs` 新增 getter：

```rust
/// 自测闭环：当前 trace reply 字符数（供 run_simple_chat 兜底判断，避免重复追加）。
pub fn trace_reply_len() -> usize {
    trace_reply().lock().map(|s| s.chars().count()).unwrap_or(0)
}
```

`src-tauri/src/agent/runtime.rs` 在 `simple_final_text = content.clone();` 之后（runtime.rs:832 附近）补：

```rust
// 兜底：部分 provider/模型在 call_llm_stream 中不回传增量 delta（仅 outcome.content 终态返回），
// 导致 trace.reply 为空；引擎已用 simple_final_text 落库 assistant_answer。为保证 agent_get_run_trace
// 的 reply 与 assistant_answer 一致（自测验收口径），对 trace 做一次性兜底填充（仅当为空时）。
if events::trace_reply_len() == 0 && !simple_final_text.trim().is_empty() {
    events::append_reply(&simple_final_text);
}
```

> 注：此处用 `trace_reply_len()==0` 守卫，避免「流式已追 + 兜底再追」造成正文翻倍。助手 `assistant_answer` 仍由 `persist_round_answer_if_empty` 单一权威写入，不受此改动影响。

### 改动 2（验收口径纠正）：自测「真实验收」读 `assistant_answer` 而非 `trace.reply`

- **短期（改动 1 落地后）**：`agent_get_run_trace().reply` 已与 `assistant_answer` 对齐，可直接作为验收信号。
- **长期（推荐）**：新增 MCP 工具 `agent_get_round {roundId}` 直接回 `agent_conversation_round` 的 `assistant_answer/thinking_content/tool_calls_summary/raw_messages_json`，使自测/外部驱动能直接核对权威落库列，不再依赖调试缓冲。mcp_server.rs 当前仅暴露 `agent_get_run_trace`（观测缓冲）与 `agent_get_run_logs`（tracing 日志），无 round 直读工具。

### 改动 3（回归护栏，可选）

在 agent 模块集成测试加一条断言：SIMPLE_CHAT run 完成后 `trace.reply.chars()>0` **或** `assistant_answer` 非空。捕获「某 provider 不回传增量 delta 导致 trace 空」的回归（本次误判的根）。

---

## 五、对原 E2E 评分的影响

- 原「真实验收 0/30」中，SIMPLE_CHAT 部分应**更正为通过**（数据已落库，误判来自 `trace.reply` 口径）。
- 但需注意：**Phase 3/4 的 0 分主因仍是 P0（COMPOSITE 路径挂死）**，P1 仅影响 SIMPLE_CHAT 子项。修正 P1 不会抬高总分的大头——COMPOSITE 挂死不解决，复合任务验收仍为 0。
- 建议复测时：SIMPLE_CHAT 用例以 `assistant_answer` 非空为通过标准；COMPOSITE/KB 绑定用例待 P0 修复后再评。

---

## 六、一句话小结

`reply=0` = 观测缓冲没被流式增量喂到，不是回复没存；引擎侧 `assistant_answer` 已无条件兜底落库。修复 = SIMPLE_CHAT 给 `trace.reply` 加一次性兜底（对齐 COMPOSITE）+ 自测改读 `assistant_answer`。属于**健壮性/可观测性改进**，非数据丢失缺陷。

---

## 七、真机复测（2026-09-22 11:3x，客户端重启后）——结论修正 ⚡

客户端重启后以 `p1_verify.mjs` 真机复测（全新 GLM-5.3-Flash Agent，无 KB，roundId 正确接线，run-1790048513576-0）：

| 检查项 | 结果 |
|---|---|
| `agent_get_run_trace` 原始结构 | `{"trace":{counts,events,reply,thinking}}` —— **外层有 `trace` 包裹** |
| run 结果 | `status=done`、`intent=SIMPLE_CHAT`（≤10s） |
| `trace.reply`（正确路径 `r.trace.reply`） | **`"你好"`（2 字符，非空）** —— GLM 流式 delta 正常回传，`append_reply` 链路健康 |
| DB `agent_conversation_round`（roundId 已接线） | `assistant_answer="你好"`、`end_time=set`、`raw_messages_json=75` 字符 —— **引擎落库 100% 正确** |

### 结论修正（推翻第二~四节的两处推断）
1. **「GLM 不回传流式 delta」假设不成立**：`trace.reply` 非空。原审计 `replyLen=0` 的真因 = **审计脚本少剥 `{"trace":{...}}` 包裹层**（`e2e_audit_v2.mjs` 读 `t.reply` 而非 `t.trace.reply`）——纯驱动解析 bug。而 intent/kbSearch 用的是对 `JSON.stringify` 的正则匹配，穿透了包裹层，所以「意图误判」等结论不受此 bug 影响。
2. **diag4/audit-P3 轮次 `assistant_answer` 为空的真因**：审计脚本 P3 调 `agent_run_task` 时**只传了 `agentId`+`prompt`，未传 `sessionId`/`roundId`**（`e2e_audit_v2.mjs` 92 行；对照 119 行 P4 正确传了）→ `cfg.round_id=None` → 引擎按设计跳过轮次回填（该字段本就是「前端建好的本轮 id」可选项，不传不回填）。DB 佐证：已接线且完成的轮次 `assistant_answer=91/398/482/1086` 字符全部非空；未接线的 P3/diag4 轮次 `end_time=NULL, ans=0`。
3. **第四节「改动 1」（events.rs 兜底 `append_reply`）不再必要——撤回**。引擎无需任何改动。

### P1 最终定论
**引擎无缺陷、GLM 无问题、数据全部正确落库；P1 是审计驱动自身的两处 bug（trace 解包遗漏 + roundId 未接线）造成的假阳性。** 原评分中「真实验收」的 SIMPLE_CHAT 子项应更正为通过。

### 真正需要的动作
- [x] **SKILL.md 补丁（已落地，2026-09-22 11:4x）**：`agent_get_run_trace` 返回结构补写 `{"trace":{...}}` 包裹层说明（工具表 + 流程 6 两处）；已按「Skill 同步铁律」复制到客户端并校验 MD5 一致（`b8ec6012…`）。
- [ ] （可选，随下次 Rust 重建顺带，避免与用户正在写的 P0 改动冲突）`mcp_server.rs` 内 `agent_get_run_trace` 工具 description 同步补包裹层说明（当前只描述了内层字段名）。
- [ ] 审计脚本修正：`agent_get_run_trace` 结果统一 `r.trace` 取内层；`agent_run_task` 一律接线 `sessionId`/`roundId`（照 v2 P4 的正确写法）。
- [ ] **微缺陷（顺带发现，随 P0 重建一并修）**：`events.rs` `push_event` 的跳过判据查 `payload.eventType`，但 `AgentEventPayload` 经 `#[serde(rename="type")]` 实际序列化为 `type` → text_chunk/thinking_chunk 从未被跳过，长回复会向 trace 缓冲塞几百条事件（内存噪声，非致命）。修复 = 判据改 `"type"` 一词。
- [ ] **P0 挂死 DB 残留**：`agent_conversation_round` 有 **9 条 `end_time=NULL` 孤儿轮次**（重启不清除，UI 会永远显示进行中）——建议在 P0 修复中加「启动时孤儿 running 轮次清扫（标记 failed）」。

### 复测产物
`p1_verify.mjs`（真机复测脚本，含 trace 原始结构打印）/ `p1_verify_db.py`（DB 只读核查脚本）留存于仓库根，可重复执行；留痕资产：Agent `454768cc`（p1v_1790048513536）、session `fa9a3d9d`、round `e928004e`。
