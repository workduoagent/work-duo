# Work Duo Agent Runtime 2.0 ------ 分阶段架构优化方案与问题清单

> 项目形态：Windows 优先的 Tauri 2 桌面应用，后续扩展 macOS / Linux\
> 前端：React + Vite + TypeScript\
> 后端：Rust\
> 当前 Agent：Intent → PlanDAG → Micro-ReAct Pipeline\
> 当前能力：Native Tools + Skill + MCP + Python Sandbox + SQLite +
> Approval + Event Stream + Memory\
> 文档目的：在不推翻现有架构的前提下，把当前 Agent Runtime 从"可执行的
> LLM Agent"逐步演进为"可靠、可恢复、可验证、可扩展的桌面 Agent
> Runtime"。

------------------------------------------------------------------------

# 0. 文档定位

本文不是单纯的代码重构清单，而是一份**架构演进设计方案 +
分环节问题清单 + 验收标准**。

核心原则：

1.  **不推翻现有 Intent → Planner → Pipeline 主链路。**
2.  LLM 负责推理、规划和局部决策；Rust Runtime
    负责状态、权限、调度、恢复和一致性。
3.  Message 不再作为 Agent 的唯一事实来源。
4.  Tool 不再等于能力；能力、工具实现、Agent、Skill、MCP 分层。
5.  "模型说完成"不能作为唯一成功标准，必须引入 Artifact + Verifier。
6.  失败不应该只有 Retry，而应该进入 Recovery Policy。
7.  当前线性 Pipeline 逐步升级为真正 DAG。
8.  SQLite 作为桌面端核心持久化层，Vector DB
    只承担语义记忆，不作为全部状态数据库。
9.  所有长耗时任务都必须具备取消、恢复、审计和可观测性。
10. Windows 优先设计，同时避免把 Windows 行为硬编码进 Runtime
    核心，保证未来 macOS/Linux 可扩展。

------------------------------------------------------------------------

# 1. 当前架构基线

当前系统已经具备以下三阶段：

``` text
User
  │
  ▼
run_agent_task
  │
  ▼
Intent Classification
  │
  ├── SIMPLE_CHAT
  │      └── simple chat
  │
  └── COMPOSITE_TASK
          │
          ▼
       Planner
          │
          ▼
       PlanDAG
          │
          ▼
       Pipeline
          │
          ├── SubTask 1 → Micro ReAct
          ├── SubTask 2 → Micro ReAct
          └── SubTask 3 → Micro ReAct
```

当前系统的优点：

-   已经避免旧版全局无限 ReAct。
-   Planner 与 Executor 已经分离。
-   子任务上下文隔离。
-   工具轮与最终汇报轮已经分开计数。
-   ToolRegistry 已经成为能力层的重要事实源。
-   沙箱 Python 已经具备自动依赖恢复。
-   MCP / Skill / Native 已经统一进入工具注册层。
-   Approval、Event、SQLite 已经形成桌面 Agent 的基础设施。
-   Tool Call / Tool Result 消息配对已经有自愈机制。

当前主要架构债务：

``` text
PlanDAG
  ↓
实际上仍以顺序 Pipeline 为主

SubTaskOutput
  ↓
主要通过 summary 传递状态

messages
  ↓
仍承担过多 Runtime State 职责

success
  ↓
主要由模型终态汇报判断

retry
  ↓
主要是固定次数

memory
  ↓
需要进一步区分结构化状态与语义记忆

tool
  ↓
还需要进一步抽象为 capability

multi-agent
  ↓
需要 Scheduler，而不是简单 Agent → Agent 调用
```

------------------------------------------------------------------------

# 2. 总体目标架构

最终建议演进为：

``` text
                         ┌──────────────┐
                         │    User      │
                         └──────┬───────┘
                                │
                                ▼
                     ┌────────────────────┐
                     │ Intent + Policy    │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │ Task Compiler      │
                     │ Goal → Task Graph  │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │ Plan Validator     │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │ Task Scheduler     │
                     └─────────┬──────────┘
                               │
               ┌───────────────┼────────────────┐
               ▼               ▼                ▼
             Task A          Task B            Task C
               │               │                │
               ▼               ▼                ▼
          Worker Agent     Worker Agent     Worker Agent
               │               │                │
               └───────────────┼────────────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │ Artifact Registry  │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │ Verifier Engine    │
                     └───────┬───────┬────┘
                             │       │
                           PASS     FAIL
                             │       │
                             ▼       ▼
                         Next Task Recovery
                                     │
                         ┌───────────┼───────────┐
                         ▼           ▼           ▼
                       Retry       Repair      Replan
                         │           │           │
                         └───────────┼───────────┘
                                     ▼
                                  Scheduler
```

横向基础设施：

``` text
┌──────────────────────────────────────────────────────────┐
│                      Agent Runtime                       │
│                                                          │
│  State Store     Event Store     Memory     Risk Engine  │
│      │                │             │            │       │
│      └────────────────┼─────────────┼────────────┘       │
│                       │             │                    │
│                    Context Builder / Policy             │
└──────────────────────────────────────────────────────────┘
```

------------------------------------------------------------------------

# 3. 第一阶段：Intent / 意图分流

## 3.1 当前设计

当前主要是：

``` text
短消息 + 无复杂关键词
        ↓
SIMPLE_CHAT

复杂关键词 + 足够长度
        ↓
COMPOSITE_TASK

灰色区域
        ↓
LLM 分类
```

这个设计适合当前版本，但不建议长期把"消息长度"和"关键词"作为核心判断。

------------------------------------------------------------------------

## 3.2 优化目标

建议将 Intent 从二分类升级为：

``` text
CHAT
KNOWLEDGE
TOOL_TASK
FILE_TASK
CODE_TASK
MULTI_STEP_TASK
HIGH_RISK_TASK
```

同时输出 Runtime Policy：

``` json
{
  "intent": "FILE_TASK",
  "requires_planning": true,
  "requires_tool": true,
  "requires_approval": true,
  "requires_artifact": true,
  "risk_level": "medium"
}
```

Intent 的作用从：

> "判断是不是复杂任务"

升级为：

> "告诉 Runtime 应该用什么执行策略"。

------------------------------------------------------------------------

## 3.3 本阶段需要回答的问题

### Q1：Intent 是分类结果，还是执行策略？

建议：

``` text
Intent
+
Policy
```

不要让 Planner 自己重新判断权限和风险。

### Q2：短消息是否一定是简单任务？

例如：

``` text
删除这个文件
执行一下这个脚本
打开这个程序
```

都可能很短，但具有工具操作性质。

### Q3：是否应该加入 Risk Classification？

建议加入：

``` text
LOW
MEDIUM
HIGH
CRITICAL
```

### Q4：Intent 分类失败应该怎么处理？

建议：

``` text
无法确定
  ↓
默认进入安全的规划路径
  ↓
禁止高风险自动执行
```

而不是简单地把所有失败都当 COMPOSITE_TASK。

------------------------------------------------------------------------

## 3.4 验收标准

必须测试：

-   "你好"
-   "帮我看看这个文件"
-   "删除这个文件"
-   "运行一下 Python"
-   "分析这个 Excel"
-   "给我讲讲 Rust"
-   "修改项目里的配置文件"
-   "帮我安装一个依赖"

每类任务都应该得到合理的：

``` text
intent
requires_planning
requires_tool
risk
approval_policy
```

------------------------------------------------------------------------

# 4. 第二阶段：Task Compiler / Planner

## 4.1 当前问题

当前 Planner 已经能生成 1\~5 个任务，但：

``` text
PlanDAG
```

实际上主要按顺序执行。

同时 Planner 主要输出：

``` text
task_id
title
description
```

缺少：

``` text
dependencies
inputs
outputs
success criteria
risk
required capability
```

------------------------------------------------------------------------

## 4.2 新 Plan Contract

建议：

``` json
{
  "goal": "分析 BTC 数据并生成预测报告",

  "tasks": [
    {
      "task_id": "t1",
      "title": "获取数据",
      "depends_on": [],
      "required_capabilities": ["market_data"],
      "outputs": ["btc_raw_data"],
      "success_criteria": [
        "数据存在",
        "时间范围满足要求"
      ]
    },
    {
      "task_id": "t2",
      "title": "清洗数据",
      "depends_on": ["t1"],
      "required_capabilities": ["python_data_analysis"],
      "inputs": ["btc_raw_data"],
      "outputs": ["btc_dataset"],
      "success_criteria": [
        "数据可解析",
        "缺失率低于阈值"
      ]
    },
    {
      "task_id": "t3",
      "title": "生成预测",
      "depends_on": ["t2"],
      "required_capabilities": ["python_ml"],
      "inputs": ["btc_dataset"],
      "outputs": ["forecast_report"]
    }
  ]
}
```

------------------------------------------------------------------------

## 4.3 Plan Validator

Planner 输出后不要直接执行：

``` text
Planner
  ↓
Plan Validator
  ↓
Valid?
  ├── YES → Scheduler
  └── NO  → Plan Repair / Fallback
```

Validator 检查：

### 依赖

``` text
depends_on 是否存在
```

### 环

``` text
A → B → C → A
```

### 能力

``` text
required_capabilities
```

是否存在可用实现。

### Artifact

``` text
Task B input
```

是否由前序 Task 产生。

### 粒度

检查是否出现：

``` text
完成整个项目
```

这种巨型任务。

### 风险

检查是否存在：

``` text
删除文件
执行命令
修改系统
```

等高风险操作。

------------------------------------------------------------------------

## 4.4 本阶段问题

### Q1：Planner 是否允许自己决定工具？

建议：

**不允许直接决定具体 Tool。**

Planner 决定：

``` text
Capability
```

Runtime 再映射：

``` text
Capability → Tool
```

### Q2：Planner 是否允许并行？

应该允许。

例如：

``` text
         ┌→ 获取市场数据
用户目标 ┤
         └→ 获取新闻数据
                ↓
             综合分析
```

### Q3：Planner 最大步骤是否应该固定 5？

建议：

当前可以保留 5 作为 UI/成本保护，但长期应该：

``` text
MAX_PLAN_STEPS
+
复杂度预算
+
动态合并
```

而不是永远固定 5。

------------------------------------------------------------------------

# 5. 第三阶段：真正的 DAG Scheduler

## 5.1 当前 Pipeline

当前：

``` text
for task in tasks
```

属于：

``` text
Linear Pipeline
```

建议升级：

``` text
Task Graph
     │
     ▼
Scheduler
     │
 ┌───┼────┐
 ▼   ▼    ▼
 A   B    C
 └───┼────┘
     ▼
     D
```

------------------------------------------------------------------------

## 5.2 Task 状态机

建议统一：

``` text
PENDING
READY
RUNNING
WAITING_APPROVAL
WAITING_DEPENDENCY
SUCCESS
FAILED
BLOCKED
CANCELLED
SKIPPED
```

状态只能按照合法迁移：

``` text
PENDING
  ↓
READY
  ↓
RUNNING
  ├── SUCCESS
  ├── FAILED
  ├── WAITING_APPROVAL
  └── CANCELLED
```

------------------------------------------------------------------------

## 5.3 Scheduler 核心原则

Scheduler 不关心：

``` text
LLM 怎么想
```

只关心：

``` text
Task 是否 READY
依赖是否满足
能力是否可用
是否允许执行
资源是否足够
```

------------------------------------------------------------------------

## 5.4 本阶段问题

### Q1：两个无依赖任务是否允许并行？

建议允许。

### Q2：并行是否需要限制？

需要：

``` text
max_parallel_tasks
max_python_jobs
max_network_jobs
```

### Q3：一个 Task 失败是否影响所有任务？

不应该。

根据 DAG：

``` text
强依赖 → BLOCKED
无依赖 → CONTINUE
```

------------------------------------------------------------------------

# 6. 第四阶段：Artifact System

这是整个系统最值得优先升级的部分之一。

## 6.1 为什么不能只传 summary

当前：

``` text
Task1
 ↓
summary
 ↓
Task2
```

建议：

``` text
Task1
 ↓
Artifact + Fact + Metric + Summary
 ↓
Task2
```

------------------------------------------------------------------------

## 6.2 Artifact 数据结构

建议：

``` rust
struct Artifact {
    artifact_id: String,
    artifact_type: String,
    path: String,
    mime_type: String,
    description: String,
    created_by_task: String,
    version: u32,
    checksum: Option<String>,
    size: u64,
    created_at: String,
}
```

------------------------------------------------------------------------

## 6.3 Artifact 类型

建议至少支持：

``` text
file
directory
dataset
image
document
spreadsheet
code
json
report
model
environment
```

------------------------------------------------------------------------

## 6.4 Artifact Registry

SQLite：

``` text
artifacts
```

建立：

``` text
task → artifacts
artifact → task
artifact → version
artifact → checksum
```

关系。

------------------------------------------------------------------------

## 6.5 本阶段问题

### Q1：Artifact 是文件还是逻辑实体？

建议：

**逻辑实体。**

文件只是 Artifact 的一种实现。

### Q2：同一路径覆盖怎么办？

使用：

``` text
artifact_id
version
checksum
```

而不是单纯依赖 path。

### Q3：Artifact 是否允许跨 Task 使用？

允许。

### Q4：是否允许用户直接查看 Artifact？

必须。

前端可以从：

``` text
Step
 ↓
Artifacts
 ↓
Open / Preview / Locate
```

进入。

------------------------------------------------------------------------

# 7. 第五阶段：Verifier Engine

## 7.1 核心原则

不能：

``` text
LLM：
“已经完成。”
 ↓
SUCCESS
```

必须：

``` text
Executor
 ↓
Artifact
 ↓
Verifier
 ↓
PASS / FAIL
```

------------------------------------------------------------------------

## 7.2 Verifier Registry

建议：

``` text
FileExistsVerifier
DirectoryVerifier
JsonSchemaVerifier
CsvVerifier
ExcelVerifier
ImageVerifier
CodeCompileVerifier
HttpVerifier
ArtifactHashVerifier
PythonVerifier
CustomScriptVerifier
LLMVerifier
```

------------------------------------------------------------------------

## 7.3 Success Criteria

Planner 输出：

``` json
{
  "success_criteria": [
    {
      "type": "file_exists",
      "path": "result.xlsx"
    },
    {
      "type": "excel",
      "min_rows": 100
    }
  ]
}
```

Runtime：

``` text
Task Completed
       ↓
Verifier
       ↓
ALL PASS?
   ├── YES → SUCCESS
   └── NO → RECOVERY
```

------------------------------------------------------------------------

## 7.4 Verifier 层级

建议：

``` text
L0：Process
    exit code

L1：Artifact
    文件存在

L2：Structural
    Excel/JSON/CSV schema

L3：Semantic
    内容是否符合要求

L4：LLM Review
    复杂语义判断
```

原则：

> 能用确定性验证，就不要用 LLM 验证。

------------------------------------------------------------------------

## 7.5 本阶段问题

### Q1：Verifier 是否必须每次执行？

对于有明确 Success Criteria 的 Task：

**必须。**

### Q2：Verifier 自己是否可以调用 Tool？

可以，但必须受到权限限制。

### Q3：Verifier 失败是否直接重做？

不一定，进入 Recovery Engine。

------------------------------------------------------------------------

# 8. 第六阶段：Recovery Engine

## 8.1 当前

当前：

``` text
失败
 ↓
Retry 3 次
 ↓
失败
```

建议：

``` text
FAILED
 │
 ├── transient?
 │      └── RETRY
 │
 ├── bad arguments?
 │      └── REPAIR
 │
 ├── missing dependency?
 │      └── ENV RECOVERY
 │
 ├── tool unavailable?
 │      └── ALTERNATIVE TOOL
 │
 ├── artifact invalid?
 │      └── REBUILD
 │
 ├── plan invalid?
 │      └── REPLAN
 │
 └── impossible?
        └── ESCALATE
```

------------------------------------------------------------------------

## 8.2 Recovery Action

建议：

``` text
RETRY
REPAIR
REBUILD
ALTERNATIVE
REPLAN
ROLLBACK
ESCALATE
ABORT
```

------------------------------------------------------------------------

## 8.3 Recovery Policy

例如：

``` json
{
  "error_type": "ModuleNotFoundError",
  "strategy": "INSTALL_AND_RETRY",
  "max_attempts": 1
}
```

例如：

``` json
{
  "error_type": "network_timeout",
  "strategy": "RETRY",
  "max_attempts": 3
}
```

例如：

``` json
{
  "error_type": "permission_denied",
  "strategy": "REQUEST_APPROVAL"
}
```

------------------------------------------------------------------------

# 9. 第七阶段：Tool → Capability Architecture

## 9.1 当前

当前：

``` text
Native
Skill
MCP
 ↓
ToolRegistry
```

已经很好，但还可以抽象：

``` text
Capability
     ↓
Implementation
 ┌───┼────┐
Tool Skill MCP
```

------------------------------------------------------------------------

## 9.2 Capability Graph

例如：

``` text
filesystem
├── read
├── write
└── edit

data_analysis
├── python
├── dataframe
└── visualization

web
├── search
└── fetch

office
├── excel
├── word
└── ppt
```

Planner 只需要：

``` text
required_capabilities:
["data_analysis", "spreadsheet"]
```

Runtime 负责寻找：

``` text
Native Tool
MCP Tool
Skill
Agent
```

------------------------------------------------------------------------

## 9.3 本阶段问题

### Q1：一个 Capability 是否允许多个实现？

必须允许。

### Q2：怎么选择实现？

可以综合：

``` text
availability
permission
cost
latency
reliability
platform
```

### Q3：Windows / macOS / Linux 如何处理？

不要：

``` text
if windows { ... }
```

散落在业务代码里。

建议：

``` text
Platform Capability Provider
```

统一抽象：

``` text
FilesystemProvider
ProcessProvider
ShellProvider
ApplicationProvider
```

Windows、macOS、Linux 各自实现。

------------------------------------------------------------------------

# 10. 第八阶段：State Engine

这是从"Chat Agent"走向"Agent Runtime"的关键。

## 10.1 当前问题

目前 messages 承担了：

``` text
LLM Context
Tool History
Execution State
```

这些职责应该分开。

------------------------------------------------------------------------

## 10.2 建议 Agent State

``` text
AgentState
├── Goal
├── Intent
├── Policy
├── Plan
├── Tasks
├── Artifacts
├── Facts
├── Metrics
├── Approvals
├── Errors
├── Environment
└── Runtime Status
```

------------------------------------------------------------------------

## 10.3 Messages 的新定位

Messages 不再是事实来源。

变成：

``` text
State
 ↓
Context Builder
 ↓
Messages
 ↓
LLM
```

所以：

> Message 是 View，不是 Database。

------------------------------------------------------------------------

# 11. 第九阶段：Event Store

当前已经有：

``` text
agent-event
tool_started
tool_finished
step_started
step_finished
```

建议升级成完整事件模型：

``` text
TaskCreated
IntentClassified
PlanCreated
PlanValidated
TaskReady
TaskStarted
ToolCalled
ToolFinished
ArtifactCreated
ArtifactUpdated
VerifierStarted
VerifierFinished
RecoveryStarted
TaskRetried
ApprovalRequested
ApprovalGranted
TaskCompleted
TaskFailed
TaskCancelled
```

------------------------------------------------------------------------

## 11.1 Event Store 的用途

### Debug

``` text
为什么任务失败？
```

### Replay

``` text
从事件重新构建 State。
```

### Audit

``` text
Agent 做过什么？
```

### UI

``` text
前端实时订阅。
```

### Recovery

``` text
程序崩溃后恢复状态。
```

------------------------------------------------------------------------

# 12. 第十阶段：Checkpoint / Resume

桌面 Agent 特别需要这个。

因为：

``` text
Windows 睡眠
程序关闭
电脑重启
Tauri 崩溃
LLM 网络断开
```

都可能发生。

------------------------------------------------------------------------

## 12.1 Checkpoint

每个重要状态变化：

``` text
Task Started
Tool Finished
Artifact Created
Task Finished
```

写入 SQLite。

------------------------------------------------------------------------

## 12.2 Resume

重新启动：

``` text
Load Task
 ↓
Load Event
 ↓
Rebuild State
 ↓
Find RUNNING Task
 ↓
Determine last safe checkpoint
 ↓
Resume / Recover
```

------------------------------------------------------------------------

## 12.3 本阶段问题

### Q1：是否允许自动恢复？

建议允许，但必须有策略。

### Q2：正在执行 Python 时崩溃怎么办？

需要记录：

``` text
process_id
script
environment
working_directory
attempt
```

重启后判断进程是否仍存在。

### Q3：重复执行是否安全？

必须配合：

``` text
idempotency_key
artifact version
```

------------------------------------------------------------------------

# 13. 第十一阶段：Idempotency / 幂等性

Agent 的 Retry / Resume 必须解决重复执行。

例如：

``` text
Task2
 ↓
生成 result.xlsx
 ↓
程序崩溃
 ↓
Retry
 ↓
再次生成
```

最终可能：

``` text
result.xlsx
result_1.xlsx
result_2.xlsx
```

建议：

``` text
task_id
+
attempt
+
idempotency_key
```

形成稳定执行标识。

------------------------------------------------------------------------

# 14. 第十二阶段：Environment Manager

当前已经有：

``` text
micromamba
Python Sandbox
AUTO_INSTALL_ALLOW
```

建议进一步抽象：

``` text
Environment Manager
```

负责：

``` text
Environment Create
Environment Resolve
Package Install
Environment Snapshot
Environment Reuse
Environment Cleanup
```

------------------------------------------------------------------------

## 14.1 Environment Identity

``` text
env_id
python_version
packages
platform
architecture
environment_hash
```

------------------------------------------------------------------------

## 14.2 环境缓存

例如：

``` text
data-analysis-python
    pandas
    numpy
    openpyxl
    scipy
```

可以复用。

而不是每个 Task 都重新安装。

------------------------------------------------------------------------

## 14.3 本阶段问题

### Q1：依赖安装是否需要审批？

建议：

``` text
trusted package → configurable auto
unknown package → approval
```

### Q2：网络不可用怎么办？

应该允许：

``` text
offline cache
```

### Q3：环境是否应该和 Agent 绑定？

建议：

``` text
Agent Profile
  ↓
Environment Profile
```

但 Task 可以临时扩展。

------------------------------------------------------------------------

# 15. 第十三阶段：Risk Engine + Approval

当前已经有 Approval，这是很好的基础。

建议升级：

``` text
Tool
 ↓
Risk Evaluation
 ↓
Policy
 ↓
Execute / Approval
```

------------------------------------------------------------------------

## 15.1 风险等级

``` text
LOW
MEDIUM
HIGH
CRITICAL
```

示例：

``` text
read file           LOW
write workspace     MEDIUM
network request     MEDIUM
install package     MEDIUM
delete file         HIGH
execute command     HIGH
modify system       CRITICAL
```

------------------------------------------------------------------------

## 15.2 批量授权

不要每次：

``` text
write file
→ approval
write file
→ approval
write file
→ approval
```

可以：

``` text
允许 Agent：

workspace/project/**
write + python

有效期：
30 minutes
```

------------------------------------------------------------------------

## 15.3 本阶段问题

### Q1：Approval 是 Tool 级还是 Policy 级？

建议 Policy 级。

### Q2：用户授权后是否永久有效？

不建议。

建议：

``` text
scope
duration
capability
workspace
```

### Q3：Agent 能否自己降低风险等级？

不能。

Risk Engine 必须由 Runtime 控制。

------------------------------------------------------------------------

# 16. 第十四阶段：Memory Architecture

建议：

``` text
Memory
├── Structured Memory
│
└── Semantic Memory
```

------------------------------------------------------------------------

## 16.1 Structured Memory

SQLite：

``` text
user preferences
project configuration
task state
agent configuration
artifact metadata
environment
permissions
```

------------------------------------------------------------------------

## 16.2 Semantic Memory

用于：

``` text
历史经验
过去解决方案
长文本
项目知识
语义检索
```

不要把所有聊天全部 Embedding。

------------------------------------------------------------------------

## 16.3 Memory Scope

建议：

``` text
Global
Project
Agent
Task
Artifact
```

------------------------------------------------------------------------

## 16.4 本阶段问题

### Q1：什么东西值得长期记忆？

必须建立 Memory Policy。

### Q2：Memory 是否允许自动写入？

建议：

``` text
低风险事实 → 自动
用户偏好 → 可询问
重要决策 → 需要确认
```

### Q3：Memory 是否允许被修改？

必须允许。

Memory 应该具备：

``` text
create
update
delete
version
source
confidence
```

------------------------------------------------------------------------

# 17. 第十五阶段：Context Builder

Context Builder 是整个 Memory / State / Artifact / Message 的连接层。

``` text
Task State
+
Relevant Memory
+
Input Artifacts
+
Previous Task Facts
+
Current Goal
+
Policy
        ↓
Context Builder
        ↓
LLM Context
```

------------------------------------------------------------------------

## 17.1 Context 不应该全部塞进去

建议分层：

``` text
L0：Task Contract
L1：Current State
L2：Required Artifacts
L3：Relevant Facts
L4：Relevant Memory
L5：Recent Tool History
L6：Long History
```

根据任务动态取。

------------------------------------------------------------------------

# 18. 第十六阶段：Micro-ReAct 的定位

当前 Micro-ReAct 不需要废掉。

反而建议保留。

最终结构：

``` text
Task
 ↓
Micro-ReAct
 ├── Think
 ├── Tool
 ├── Observe
 ├── Verify
 └── Finish
```

但要注意：

> Micro-ReAct 是 Task Executor，不是整个 Agent Runtime。

Runtime 负责：

``` text
什么时候执行
执行哪个 Task
是否允许 Tool
失败怎么办
什么时候结束
```

LLM 只负责：

``` text
当前 Task 怎么做
```

------------------------------------------------------------------------

# 19. 第十七阶段：多 Agent / Worker Architecture

未来如果出现：

``` text
PM Agent
Python Agent
Research Agent
Frontend Agent
Office Agent
```

不建议：

``` text
PM Agent
 ↓
直接调用 Python Agent
```

建议：

``` text
PM Agent
 ↓
Task Graph
 ↓
Capability Requirement
 ↓
Scheduler
 ↓
Worker Agent
```

例如：

``` text
Task:
分析 Excel

Capability:
data_analysis

Candidate:
Python Agent
Data Agent

Scheduler:
选择最合适 Worker
```

这样 Agent 之间不会产生强耦合。

------------------------------------------------------------------------

# 20. 第十八阶段：Worker Agent Contract

Worker Agent 应该具有：

``` text
Agent Identity
Capabilities
Permissions
Environment
Model
Toolset
Cost
Reliability
```

例如：

``` json
{
  "agent_id": "python_worker",
  "capabilities": [
    "data_analysis",
    "python",
    "spreadsheet"
  ],
  "permissions": [
    "workspace_read",
    "workspace_write"
  ],
  "environment": "python-data-analysis"
}
```

------------------------------------------------------------------------

# 21. 第十九阶段：Cancellation

桌面应用必须优先解决。

建议：

``` text
CancellationToken
```

贯穿：

``` text
Runtime
 ↓
Scheduler
 ↓
Task
 ↓
LLM
 ↓
Tool
 ↓
Python
 ↓
MCP
```

------------------------------------------------------------------------

## 21.1 取消级别

``` text
Cancel Current Tool
Cancel Current Task
Cancel Remaining Tasks
Cancel Entire Run
```

------------------------------------------------------------------------

## 21.2 UI

前端应该明确：

``` text
运行中
暂停
停止
取消中
已取消
```

不要只有一个"停止按钮"。

------------------------------------------------------------------------

# 22. 第二十阶段：Frontend Event Model

当前前端已经有：

``` text
plan_generated
step_started
step_finished
tool_started
tool_finished
text_chunk
```

建议进一步：

``` text
task_state_changed
artifact_created
artifact_updated
verification_started
verification_finished
recovery_started
approval_requested
approval_resolved
agent_paused
agent_resumed
agent_cancelled
```

------------------------------------------------------------------------

# 23. 前端 UI 建议

建议将 Agent UI 从：

``` text
Chat
+
Thinking
+
Steps
```

升级为：

``` text
┌────────────────────────────────────────────┐
│ Goal                                       │
├────────────────────────────────────────────┤
│ Plan                                       │
│   ✓ 获取数据                               │
│   ● 清洗数据                               │
│   ○ 预测                                   │
├────────────────────────────────────────────┤
│ Current Task                               │
│   Python Worker                            │
│   ███████████░░░ 78%                      │
├────────────────────────────────────────────┤
│ Artifacts                                  │
│   📊 btc.xlsx                              │
│   📄 report.md                             │
├────────────────────────────────────────────┤
│ Verification                               │
│   ✓ File exists                            │
│   ✓ Excel valid                            │
├────────────────────────────────────────────┤
│ Runtime                                    │
│   12 tools · 3 retries · 2m31s             │
└────────────────────────────────────────────┘
```

用户看到的重点应该从：

> "AI 想了什么"

逐渐转向：

> "AI 正在完成什么、产生了什么、验证了吗、为什么失败"。

------------------------------------------------------------------------

# 24. 第二十一阶段：SQLite 数据模型建议

建议逐步建立：

``` text
agents
agent_capabilities
agent_tools

runs
tasks
task_dependencies

artifacts
artifact_versions

tool_executions

verifications

recoveries

approvals

environments

memories
memory_links

events

checkpoints
```

核心关系：

``` text
Run
 ├── Tasks
 │    ├── ToolExecutions
 │    ├── Artifacts
 │    ├── Verifications
 │    └── Recoveries
 │
 ├── Approvals
 ├── Events
 └── Checkpoints
```

------------------------------------------------------------------------

# 25. 第二十二阶段：Rust 模块建议

当前：

``` text
agent/
├── runtime.rs
├── intent.rs
├── planner.rs
├── pipeline.rs
├── native.rs
├── tools.rs
├── context.rs
├── approval.rs
├── events.rs
└── ...
```

未来可以逐步演进：

``` text
agent/
├── runtime/
│   ├── mod.rs
│   ├── state.rs
│   ├── scheduler.rs
│   ├── cancellation.rs
│   └── lifecycle.rs
│
├── planning/
│   ├── intent.rs
│   ├── planner.rs
│   ├── validator.rs
│   └── compiler.rs
│
├── execution/
│   ├── executor.rs
│   ├── react.rs
│   ├── recovery.rs
│   └── worker.rs
│
├── capability/
│   ├── registry.rs
│   ├── native.rs
│   ├── mcp.rs
│   └── skill.rs
│
├── artifact/
│   ├── registry.rs
│   ├── storage.rs
│   └── versioning.rs
│
├── verification/
│   ├── engine.rs
│   ├── file.rs
│   ├── spreadsheet.rs
│   └── code.rs
│
├── memory/
│   ├── structured.rs
│   ├── semantic.rs
│   └── retrieval.rs
│
├── policy/
│   ├── risk.rs
│   └── approval.rs
│
├── environment/
│   ├── manager.rs
│   └── python.rs
│
└── events/
    ├── event.rs
    └── store.rs
```

不要求一次重构完成。

------------------------------------------------------------------------

# 26. 第二十三阶段：Windows / macOS / Linux 跨平台策略

核心 Runtime 必须平台无关。

避免：

``` rust
if cfg!(windows) {
    ...
}
```

大量散落。

建议：

``` text
Agent Runtime
      │
      ▼
Platform Abstraction
      │
 ┌────┼────┐
 ▼    ▼    ▼
Win  Mac  Linux
```

抽象：

``` text
ProcessProvider
FilesystemProvider
ShellProvider
ApplicationProvider
NotificationProvider
PathProvider
EnvironmentProvider
```

Windows 是第一个实现。

------------------------------------------------------------------------

# 27. 第二十四阶段：可靠性指标

以后测试 Agent 不应该只看：

``` text
LLM response
```

建议建立：

``` text
Task Success Rate
Plan Validity Rate
Verifier Pass Rate
Recovery Success Rate
Tool Error Rate
Average Tool Calls
Average Task Duration
Token Cost
Artifact Validity Rate
Resume Success Rate
Cancellation Latency
Approval Latency
```

------------------------------------------------------------------------

# 28. 第二十五阶段：测试体系

建议建立五级测试。

## L1 Unit Test

测试：

``` text
Intent
Plan Parser
DAG
State Transition
Artifact
Verifier
Risk
```

## L2 Integration Test

测试：

``` text
Rust Runtime
SQLite
Python Sandbox
MCP
Skill
```

## L3 Scenario Test

例如：

``` text
CSV → Excel → Prediction → Report
```

## L4 Failure Test

主动制造：

``` text
LLM timeout
tool failure
invalid JSON
missing package
network failure
permission denied
process crash
application restart
```

## L5 Chaos Test

随机：

``` text
kill process
断网
删除 artifact
中断 tool
LLM 返回错误
```

然后测试：

``` text
是否能恢复
是否会产生脏状态
是否会重复执行
```

------------------------------------------------------------------------

# 29. 第二十六阶段：最重要的端到端测试矩阵

  场景              Intent   Plan   DAG   Artifact   Verify   Recovery   Resume
  ----------------- -------- ------ ----- ---------- -------- ---------- --------
  闲聊              ✓        \-     \-    \-         \-       \-         \-
  单文件读取        ✓        可选   \-    ✓          ✓        \-         \-
  Excel 分析        ✓        ✓      ✓     ✓          ✓        ✓          ✓
  Python 数据分析   ✓        ✓      ✓     ✓          ✓        ✓          ✓
  MCP 网络任务      ✓        ✓      ✓     ✓          ✓        ✓          ✓
  多任务并行        ✓        ✓      ✓     ✓          ✓        ✓          ✓
  高风险操作        ✓        ✓      ✓     ✓          ✓        ✓          ✓
  依赖缺失          ✓        ✓      ✓     ✓          ✓        ✓          \-
  程序崩溃          ✓        ✓      ✓     ✓          ✓        ✓          ✓
  用户取消          ✓        ✓      ✓     ✓          ✓        ✓          ✓

------------------------------------------------------------------------

# 30. 第二十七阶段：建议新增的核心 Rust 类型

``` rust
struct AgentRun {
    run_id: String,
    goal: String,
    status: RunStatus,
}

struct TaskNode {
    task_id: String,
    depends_on: Vec<String>,
    required_capabilities: Vec<String>,
    inputs: Vec<String>,
    outputs: Vec<String>,
    success_criteria: Vec<SuccessCriterion>,
}

struct Artifact {
    artifact_id: String,
    artifact_type: ArtifactType,
    path: Option<String>,
    checksum: Option<String>,
    version: u32,
}

struct TaskResult {
    task_id: String,
    status: TaskStatus,
    summary: String,
    artifacts: Vec<Artifact>,
    facts: Vec<Fact>,
    metrics: Vec<Metric>,
}

struct VerificationResult {
    passed: bool,
    checks: Vec<VerificationCheck>,
}

struct RecoveryDecision {
    strategy: RecoveryStrategy,
    reason: String,
}
```

------------------------------------------------------------------------

# 31. 第二十八阶段：一个完整任务应该如何运行

用户：

``` text
帮我抓取 BTC 最近 30 天数据，
生成 Excel，
做预测，
最后生成一份报告。
```

Runtime：

``` text
1. Intent
   ↓
MULTI_STEP_TASK

2. Policy
   ↓
requires_planning = true
requires_artifact = true

3. Planner
   ↓
Task Graph

   T1 获取数据
      ↓
   T2 清洗
      ↓
   T3 Excel + Prediction
      ↓
   T4 Report

4. Plan Validator
   ↓
PASS

5. Scheduler
   ↓
T1 READY

6. Worker
   ↓
Tool / MCP / Python

7. Artifact
   ↓
btc_raw.json

8. Verifier
   ↓
PASS

9. T2
   ↓
btc_dataset.csv

10. Verifier
   ↓
PASS

11. T3
   ↓
btc.xlsx
forecast.json

12. Verifier
   ↓
PASS

13. T4
   ↓
report.md

14. Final Verification
   ↓
PASS

15. Runtime
   ↓
SUCCESS
```

最终用户看到的不是一堆：

``` text
Tool call...
Tool call...
Thinking...
Thinking...
```

而是：

``` text
✓ 数据获取
✓ 数据清洗
✓ Excel + 预测
✓ 报告生成

产物：
btc.xlsx
forecast.json
report.md

验证：
✓ 文件存在
✓ 数据完整
✓ Excel 可读取
✓ 预测结果存在
✓ 报告生成成功
```

------------------------------------------------------------------------

# 32. 第二十九阶段：创新方向一 ------ Task Contract

建议把每个 Task 看成一个"契约"。

``` text
Task Contract
├── Input
├── Capability
├── Action
├── Output
├── Success Criteria
├── Risk
└── Recovery Policy
```

这会让 Agent 从：

> "努力完成任务"

变成：

> "满足一个可验证的执行契约"。

------------------------------------------------------------------------

# 33. 第三十阶段：创新方向二 ------ Artifact Graph

不要只有 Task DAG。

可以同时存在：

``` text
Task Graph
Artifact Graph
```

例如：

``` text
Task A
  │
  └── Artifact X
          │
          ├── Task B
          └── Task C

Task B
  │
  └── Artifact Y
          │
          └── Task D
```

这会让复杂项目的数据流非常清晰。

------------------------------------------------------------------------

# 34. 第三十一阶段：创新方向三 ------ Capability Routing

未来不是：

``` text
Planner → Tool
```

而是：

``` text
Task
 ↓
Capability
 ↓
Capability Router
 ↓
Candidate Providers
 ↓
最佳实现
```

选择依据：

``` text
platform
permission
latency
cost
reliability
availability
```

这会让 MCP / Skill / Native / Worker Agent 真正成为可替换实现。

------------------------------------------------------------------------

# 35. 第三十二阶段：创新方向四 ------ Verifiable Agent

这是非常值得作为 Work Duo 核心理念的方向：

``` text
Agent
=
Plan
+
Execute
+
Verify
+
Recover
```

而不是：

``` text
Agent
=
LLM
+
Tool
```

可以把整个 Runtime 的核心指标从：

> "模型回答得好不好"

升级为：

> "任务最终是否被验证完成"。

------------------------------------------------------------------------

# 36. 第三十三阶段：创新方向五 ------ Agent Replay

基于 Event Store：

``` text
Run
 ↓
Event Stream
 ↓
State Reconstruction
```

可以实现：

``` text
Replay
Debug
Audit
Failure Analysis
Performance Analysis
```

甚至未来可以在 UI 中提供：

``` text
查看本次 Agent 执行时间线
```

------------------------------------------------------------------------

# 37. 第三十四阶段：创新方向六 ------ Agent Snapshot

可以保存：

``` text
Agent Snapshot
├── Model
├── Tools
├── Skills
├── MCP
├── Permissions
├── Environment
├── Memory
└── Policies
```

这样一个 Agent 可以：

``` text
Export
Import
Clone
Version
Rollback
```

这对于桌面 Agent 产品非常有价值。

------------------------------------------------------------------------

# 38. 第三十五阶段：创新方向七 ------ Local-First Agent Runtime

因为你的产品是 Tauri 桌面端，非常适合：

``` text
Local State
Local SQLite
Local Sandbox
Local Artifact
Local Memory
```

云端主要提供：

``` text
LLM
Optional MCP
Optional Sync
```

这可以形成：

> **Local-first Agent Runtime**

尤其适合用户文件、代码、Excel、PPT、Word 等本地工作场景。

------------------------------------------------------------------------

# 39. 第三十六阶段：最终架构边界

最终建议明确：

``` text
LLM
负责：
- reasoning
- planning
- local decision
- repair suggestion

Runtime
负责：
- state
- scheduling
- permissions
- cancellation
- recovery
- consistency

Tool
负责：
- capability implementation

Artifact
负责：
- output state

Verifier
负责：
- correctness

Memory
负责：
- long-term knowledge

Event Store
负责：
- history / replay / audit
```

这几个边界不要混。

------------------------------------------------------------------------

# 40. 最终推荐实施优先级

不要一次性重构。

## Phase 1 ------ 可靠执行基础

优先：

``` text
Artifact
Task Contract
Verifier
State
```

目标：

> Agent 不再靠"自己说完成"判断成功。

------------------------------------------------------------------------

## Phase 2 ------ DAG 与恢复

然后：

``` text
Real DAG
Scheduler
Recovery Engine
Idempotency
Checkpoint
Resume
```

目标：

> Agent 能处理复杂任务、失败和程序重启。

------------------------------------------------------------------------

## Phase 3 ------ 能力与多 Agent

然后：

``` text
Capability Graph
Capability Router
Worker Agent
Environment Manager
```

目标：

> Agent 数量增加后不会失控。

------------------------------------------------------------------------

## Phase 4 ------ Memory / Context

然后：

``` text
Structured Memory
Semantic Memory
Context Builder
Artifact Memory
```

目标：

> Agent 越用越懂项目，但不会把上下文塞爆。

------------------------------------------------------------------------

## Phase 5 ------ Productization

最后：

``` text
Risk Engine
Approval Policy
Replay
Snapshot
Metrics
Cross-platform Provider
```

目标：

> 从一个 Agent 功能，变成一个完整 Agent Runtime 产品。

------------------------------------------------------------------------

# 41. 最终建议的 Runtime 核心原则

整个系统最终可以浓缩成下面这句话：

``` text
              Goal
               ↓
             Intent
               ↓
              Plan
               ↓
          Plan Contract
               ↓
          Plan Validation
               ↓
          Task Scheduler
               ↓
           Micro-ReAct
               ↓
            Artifact
               ↓
             Verify
               ↓
       ┌───────┴────────┐
      PASS              FAIL
       │                 │
       ▼                 ▼
    Next Task         Recovery
                         │
               ┌─────────┼─────────┐
               ▼         ▼         ▼
             Retry     Repair     Replan
               │         │         │
               └─────────┼─────────┘
                         ▼
                     Scheduler
```

旁边始终存在：

``` text
State
Memory
Policy
Event Store
Environment
```

------------------------------------------------------------------------

# 42. 最终架构评审问题清单

在正式进入下一轮开发前，建议逐条回答下面的问题。

## A. Intent

1.  什么情况下必须进入 Planner？
2.  什么情况下可以直接 Tool？
3.  什么情况下必须 Approval？
4.  短消息是否可能是高风险操作？
5.  Intent 失败后的默认策略是什么？

## B. Planner

6.  Planner 是否只负责 Task，而不是 Tool？
7.  Task 是否具有明确 Input / Output？
8.  是否定义 Success Criteria？
9.  是否允许并行？
10. 如何检测错误依赖？
11. 如何检测循环依赖？
12. 如何修复错误 Plan？

## C. Scheduler

13. Task 状态有哪些？
14. 哪些状态允许互相转换？
15. 并行数量如何限制？
16. Task 失败后哪些 Task 应继续？
17. 如何处理 BLOCKED？

## D. Artifact

18. 什么算 Artifact？
19. Artifact 是否有版本？
20. 是否记录 checksum？
21. Task 如何声明输入 Artifact？
22. Artifact 是否允许被多个 Task 使用？
23. 用户如何查看 Artifact？

## E. Verifier

24. 什么条件代表 Task 真正完成？
25. 哪些条件可以确定性验证？
26. 哪些情况才需要 LLM 验证？
27. Verifier 失败后怎么办？
28. Final Run 是否必须再验证一次？

## F. Recovery

29. 什么错误应该 Retry？
30. 什么错误应该 Repair？
31. 什么错误应该 Replan？
32. 什么错误应该请求用户？
33. 什么错误必须立即停止？
34. Recovery 是否会造成重复副作用？

## G. State

35. Agent 的唯一事实来源是什么？
36. Messages 是否只是 View？
37. Task State 是否持久化？
38. Tool Execution 是否持久化？
39. 程序崩溃后如何恢复？

## H. Memory

40. 什么信息进入长期 Memory？
41. 什么信息只存在 Task Memory？
42. Structured Memory 与 Vector Memory 如何分工？
43. Memory 如何更新？
44. Memory 如何删除？
45. Memory 如何追溯来源？

## I. Tool / Capability

46. Planner 是否知道具体 Tool？
47. Capability 如何映射 Tool？
48. 多个 Provider 如何竞争？
49. MCP 不可用怎么办？
50. Skill 不可用怎么办？

## J. Security

51. 风险等级如何定义？
52. Approval 是 Tool 级还是 Policy 级？
53. 用户授权有效多久？
54. Agent 是否可以扩大自己的权限？
55. Sandbox 边界在哪里？

## K. Cross Platform

56. 哪些能力是 Windows 特有的？
57. 哪些能力应该抽象？
58. macOS/Linux 是否可以只替换 Provider？
59. 路径、进程、Shell、应用打开是否全部经过 Platform Layer？

## L. Product

60. 用户真正需要看到的是 Thinking 还是 Progress？
61. Artifact 是否应该成为 UI 一级对象？
62. 用户是否能查看完整执行时间线？
63. 用户是否可以暂停/恢复？
64. 用户是否可以回滚？
65. 用户是否可以复制一个 Agent？
66. 用户是否可以导出 Agent Snapshot？

------------------------------------------------------------------------

# 43. 推荐的最终目录结构

``` text
src-tauri/src/agent/

agent/
├── runtime/
│   ├── mod.rs
│   ├── state.rs
│   ├── lifecycle.rs
│   ├── scheduler.rs
│   └── cancellation.rs
│
├── planning/
│   ├── intent.rs
│   ├── planner.rs
│   ├── compiler.rs
│   └── validator.rs
│
├── execution/
│   ├── executor.rs
│   ├── react.rs
│   ├── worker.rs
│   └── recovery.rs
│
├── capability/
│   ├── registry.rs
│   ├── router.rs
│   ├── native.rs
│   ├── skill.rs
│   └── mcp.rs
│
├── artifact/
│   ├── model.rs
│   ├── registry.rs
│   ├── storage.rs
│   └── versioning.rs
│
├── verification/
│   ├── engine.rs
│   ├── file.rs
│   ├── data.rs
│   ├── office.rs
│   └── code.rs
│
├── memory/
│   ├── structured.rs
│   ├── semantic.rs
│   └── retrieval.rs
│
├── policy/
│   ├── risk.rs
│   └── approval.rs
│
├── environment/
│   ├── manager.rs
│   └── python.rs
│
├── events/
│   ├── model.rs
│   └── store.rs
│
└── types.rs
```

------------------------------------------------------------------------

# 44. 最终结论

当前 Work Duo 已经具备一个不错的 Agent Runtime 雏形：

``` text
Intent
+
Planner
+
Micro-ReAct
+
ToolRegistry
+
Sandbox
+
Approval
+
Events
```

下一阶段不应该继续把重点放在：

``` text
让 LLM 多思考几轮
增加 MAX_ITERATIONS
增加更多 Tool
增加更长 Context
```

而应该转向：

``` text
State
+
Task Contract
+
Real DAG
+
Artifact
+
Verifier
+
Recovery
+
Checkpoint
+
Capability
+
Policy
```

其中优先级最高的是：

``` text
P0
├── Artifact
├── Task Contract
├── Verifier
└── State

P1
├── Real DAG
├── Scheduler
├── Recovery
├── Idempotency
└── Checkpoint / Resume

P2
├── Capability Graph
├── Capability Router
├── Environment Manager
└── Worker Agent

P3
├── Structured Memory
├── Semantic Memory
├── Context Builder
└── Replay / Snapshot
```

最终目标不是构建一个：

> "会调用工具的聊天机器人"。

而是构建一个：

> **以 Rust Runtime 为核心、以 LLM 为推理器、以 Task Graph
> 为执行骨架、以 Artifact 为状态载体、以 Verifier 保证正确性、以
> Recovery 保证韧性的 Local-first Agent Runtime。**

这会更适合 Tauri 2 桌面应用，也更适合后续从 Windows 扩展到 macOS /
Linux。
