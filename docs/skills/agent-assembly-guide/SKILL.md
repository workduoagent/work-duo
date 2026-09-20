---
name: 智能体装配指南（Agent Assembly Guide）
description: 给定一句话需求，如何查询 WorkDuo 真实模块可选集，并智能判断应挂载的模型 / MCP / Skill / 本地插件 / 知识库，组装出完整 AgentUpsertInput 落库。供自测闭环与「自然语言建智能体」场景复用。
identifier: agent-assembly-guide
type: reference
scope: AGENT
---

# 智能体装配指南（Agent Assembly Guide）

本 Skill 是「工具语义的补充说明」：当驱动方（人或自测循环）拿到一句话需求（例如「创建合同审计助手智能体」），
应先通过 WorkDuo 内建 MCP Server 的 `agent_list_*` 工具拉取**真实可选集**，再做判断，最后用 `agent_ui_create` 落库。
**绝不要凭空编造 id** —— 一切 id 必须来自 `agent_list_*` 的真实返回。

## 一、装配总流程

1. 调用 `agent_list_models` → 选大脑（llmId）；**选出后必须把该行的 `config`（JSON 字符串）解析为对象、原样写入 `llmConfig`**（等价于 UI 步骤2「复制默认参数」；ttsId/sttId 同理写 ttsConfig/sttConfig）。`agent_list_models` 现已返回 `config` 列，即该模型所属 category 的默认参数对象。
2. 调用 `agent_list_mcps` → 锁定目标 MCP 服务 id
3. 调用 `agent_list_mcp_tools({mcp_id})` → 挑工具，得到 `{mcpId, toolId}`
4. 调用 `agent_list_skills` → 选技能 id
5. 调用 `agent_list_plugins` → 选本地插件 id（可选）
6. 调用 `agent_list_kbs` → 选知识库 id（可选但强烈推荐）
7. 调用 `agent_list_scenarios` → 取 scenario 的 `value`
8. 组装 `AgentUpsertInput`，调用 `agent_ui_create({payload})`

## 二、字段 → 模块映射

| AgentUpsertInput 字段 | 来自哪个工具 | 约束 |
|---|---|---|
| `llmId`（必填，大脑） | `agent_list_models` | `category∈{text,multimodal}` 且 `enabled=1`；需工具调用优先 `tool_calls=1` |
| `llmConfig`（必填副本） | `agent_list_models` 的 `config` 列 | **选中 llmId 后必须把对应行 `config` 解析为对象、原样写入 `llmConfig`**；漏写=UI 未展开参数卡=模型无参调用（漏配）。ttsId/sttId 同理写 ttsConfig/sttConfig |
| `ttsId` / `sttId`（可选） | `agent_list_models` | 分别对应 `category=tts` / `stt` |
| `mcpTools` | `agent_list_mcps` + `agent_list_mcp_tools` | 元素 `{mcpId, toolId}`；服务≤3，工具总数≤10 |
| `skillIds` | `agent_list_skills` | 数组，≤3 |
| `pluginIds` | `agent_list_plugins` | 数组，≤10 |
| `kbIds` | `agent_list_kbs` | 数组，无上限；绑定后获得 `native__kb_search` |
| `scenario` | `agent_list_scenarios` | 取 `value`（如 `office-efficiency`） |
| `name` / `identifier` | — | `identifier` 须匹配 `^[a-zA-Z0-9_-]+$` 且唯一 |
| `systemPrompt` | — | 人设与指令（markdown），应写明角色/职责/输出格式 |
| `isActive` / `autoToolExecMode` / `allowSandbox` / `memoryMode` / `planAutoApproveMode` | — | **必须显式赋值，不要省略**（省略会落到 `upsertAgent` 兜底默认，可能与 UI 向导默认值不一致：UI 向导默认 `allowSandbox=true`，而 `upsertAgent` 兜底默认 `false`）。不确定时采用 UI 向导默认：`isActive=true`、`autoToolExecMode=false`、`allowSandbox=true`、`memoryMode='off'`、`planAutoApproveMode='always'` |

## 三、按需求类型给的选值启发（判断依据）

- **合同/文档审计类**（如「合同审计助手」）：大脑选 `tool_calls=1` 的强推理模型；MCP 选文件系统/文档类并挑 `read`/`write`/`search`/`extract` 工具；Skill 选文档分析/合规类；KB 绑定合同语料库；`scenario=office-efficiency` 或 `data-analysis`；`memoryMode` 建议 `active`（跨轮沉淀合同要点）。
- **研发编程类**：大脑选代码能力强的 `text` 模型；MCP 选 git/终端/文件系统；Skill 选代码审查类；`scenario=dev-programming`。
- **数据分析类**：大脑选推理模型；MCP 选数据库/表格/HTTP；KB 绑定数据集说明；`scenario=data-analysis`。
- **客服类**：大脑选对话模型；Skill 选话术/工单类；`scenario=customer-service`。

## 四、systemPrompt 模板（合同审计助手示例）

```
你是「合同审计助手」，一名严谨的合同审查法律顾问。

职责：
1. 接收用户上传/检索的合同文本，识别主体、标的、付款、违约、争议解决、保密、知识产权等关键条款；
2. 标注高风险条款（单方免责、显失公平、模糊义务）并给出修改建议；
3. 基于已绑定知识库中的合同范本与法规做比对；
4. 输出结构化审查报告（风险等级 + 条款定位 + 建议）。

约束：只依据合同原文与绑定知识库作答；不确定时明确说明，不编造条款。
```

## 五、常见坑

- `mcpTools` 的 `toolId` 必须是 `agent_list_mcp_tools` 返回的**工具 id**，不是服务 id。
- `identifier` 一旦与既有 Agent 冲突会触发 UNIQUE 约束报错；自测用例建议带唯一后缀（如 `_selftest`）。
- 选模型时不要选 `enabled=0` 或 `category` 不匹配的；否则运行时不可用。
- KB 绑定的是知识库 id；若知识库尚未索引（LanceDB 无向量），检索会空回，需先在 UI 触发索引。
- **`llmConfig` 必须复制模型 `config`**：`agent_list_models` 返回每行带 `config`（JSON 字符串，内容即该模型所属 category 的参数对象）。选中模型后须解析并原样写入 `llmConfig`。**绝对不能省略**——省略后模型以无参方式调用，等价于 UI 步骤2从未点开参数卡，属漏配（这是自检最容易漏的一步）。
- **行为策略四字段必须显式赋值**：`isActive`/`autoToolExecMode`/`allowSandbox`/`memoryMode`/`planAutoApproveMode` 要在 payload 里写死。注意 **UI 向导默认 `allowSandbox=true`，但 `upsertAgent` 的兜底默认是 `false`**——省略会让落库值与 UI 表现不一致。
- **MCP 挂载必须落到具体工具**：凡 `mcpTools` 挂了 MCP 服务，必须再经 `agent_list_mcp_tools({mcp_id})` 选出具体工具，以 `{mcpId, toolId}` 写入；只挂服务不勾工具=该服务对智能体实际不可用。
