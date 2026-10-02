# Agent 原生工具（native__*）清单

> 事实源：`src-tauri/src/agent/engine/native/`（原 native.rs 已按职责拆分：`fs.rs` / `exec.rs` / `net.rs` / `image.rs` / `memory.rs` / `kb.rs`，注册聚合在 `mod.rs::register_native_tools`）。
> 本文档为速查契约；改工具面时**先改注册表与本清单，再改实现**（提示与能力同源红线）。

## 总览

- **21 个工具**，全部挂 `native__` 命名空间；另有 4 类非原生工具族并存于注册表：`skill__*`（技能随包）、插件工具、`mcp__*`（外部 MCP）、`host__*`（服务器托管 12 个，绑定后注册）。
- 权限两级：**ReadSafe**（免审批）/ **RequireApproval**（走人机审批通道，前端弹卡）。
- 全部文件操作经 **PathGuard** 约束在工作空间内；`.wd_mem` / `.attachments` 系统目录受保护。

## 文件系统（fs.rs）

| 工具 | 用途 | 关键入参（粗体必填） | 权限 |
|---|---|---|---|
| `native__read_file` | 读工作空间内文本文件 | **path** | 只读 |
| `native__write_file` | 写入/覆盖文件 | **path**、**content** | 审批 |
| `native__edit_file` | 字符串替换式改文件（前端 Diff 审批） | **path**、**old_str**、**new_str** | 审批 |
| `native__list_directory` | 列目录内容 | path | 只读 |
| `native__path_exists` | 判断路径存在性与类型（附 size/modified_ms；读/写/改/列的推荐前置，工具内部另有强制前置双保险） | **path** | 只读 |
| `native__delete_path` | 删除文件/目录（非空目录需 `recursive=true`；系统目录与工作空间根受保护） | **path**、recursive | 审批 |
| `native__move_path` | 移动/重命名（`overwrite=true` 可覆盖文件；dst 不得落入系统目录） | **src**、**dst**、overwrite | 审批 |
| `native__grep_files` | 递归子串检索（非正则、区分大小写；自动跳过 .git/node_modules/target 及二进制；单文件 2MB 上限） | **keyword**、path、max_results、file_glob | 只读 |
| `native__zip_create` | 打包 zip（deflate；跳过 .git/node_modules；输出不得在 source 内） | **source**、**output** | 审批 |
| `native__zip_extract` | 解压（防 zip-slip：越界条目整体拒绝、符号链接跳过、1 万条/500MB 上限） | **zip_path**、dest | 审批 |
| `native__regex_replace` | 正则替换文件内容（支持 $1 捕获组；结果超 2MB 拒绝写回；与 edit_file 字面替换互补） | **path**、**pattern**、**replacement**、all | 审批 |
| `native__archive_artifact` | 任务知识归档为 Markdown 到 `.wd_mem/artifacts/`（目标路径自动生成） | **name**、**content** | 审批 |

## 执行（exec.rs，按沙箱开关二选一，互斥注册）

| 工具 | 注册条件 | 用途 | 关键入参 | 权限 |
|---|---|---|---|---|
| `native__execute_command` | 非沙箱模式 | 宿主 shell 执行单条命令 | **command**、fail_on_nonzero（默认 true，合法非 0 可关） | 审批 |
| `native__run_python_sandbox` | 沙箱模式 | micromamba 隔离环境跑 Python（600s 超时强杀；依赖隔离非 OS 级沙箱） | **command** 或 code、env_name、script_path | 审批 |
| `native__run_node_sandbox` | 沙箱模式 | Bun 隔离环境跑 JS/TS（600s 超时） | code、env_name、script_path | 审批 |

> 沙箱守卫：默认离线（代理指向 127.0.0.1:9 + sitecustomize 禁 socket）、文件系统有界（工作空间+临时目录）；逃生开关 `WD_SANDBOX_NET=on` / `WD_SANDBOX_FS=off`。

## 网络（net.rs）

| 工具 | 用途 | 关键入参 | 权限 |
|---|---|---|---|
| `native__http_request` | HTTP 请求（GET/POST/PUT/DELETE/PATCH）；SSRF 防御（连接前拦环回/私有/链路本地）、重定向上限 5；`save_to` 落盘否则内存（2MB 拒绝） | **method**、**url**、headers、body、save_to | 审批 |

## 图像生成（image.rs）

| 工具 | 注册条件 | 用途 | 关键入参 | 权限 |
|---|---|---|---|---|
| `native__generate_image` | 存在 `enabled=1` 的 image 大类模型（每 run 查询，增删即时生效） | 调 OpenAI Images 兼容端点生图并落工作空间（全局取最新启用的 image 模型；write 工具族——禁写角色一并禁用） | **prompt**、file_name、size | 审批 |

## 记忆与实体图（memory.rs）

| 工具 | 注册条件 | 用途 | 关键入参 | 权限 |
|---|---|---|---|---|
| `native__anchor_memory` | 记忆模式 ≠ off | 沉淀跨会话长期记忆（按 agent_id+key 去重更新） | **key**、**content**、category | 审批 |
| `native__query_graph` | 始终 | 检索工作区实体图（任务/文件/产物/记忆节点；查「某步产出哪些文件」「历史任务链」） | **keyword**、kind、limit | 只读 |

## 交互与知识检索

| 工具 | 注册条件 | 用途 | 关键入参 | 权限 |
|---|---|---|---|---|
| `native__ask_user_choice` | 始终 | 多方案选择时向用户提问（HITL Choice Chip，挂起等点选；弹窗附自由文本入口） | **question**、**options**(2-5) | 特殊（本身即挂起） |
| `native__kb_search` | 绑定了知识库时（`register_kb_search_tool` 单独注册） | 检索已绑定 KB（向量+重排，默认全部绑定库，kb_ids 可收窄；片段带 cite 可溯源） | **query**、top_k、kb_ids、tags | 只读 |

## 设计不变量（改工具面必读）

1. **提示与能力同源**：条件不满足就不注册（image/记忆/sandbox/kb 四处条件注册），planner 能力大纲（`ToolRegistry::planner_digest()`）自动同源——大纲里绝不会出现调不了的工具。
2. **写操作全审批**：只读 6 个免审批（read_file / list_directory / path_exists / grep_files / query_graph / kb_search），其余全部 RequireApproval；工具族归属见 `types.rs::tool_family_members`（如 generate_image 属 write 族，禁写角色一并禁用）。
3. **工作空间边界**：PathGuard 校验所有路径；`.wd_mem` / `.attachments` 受保护；zip/regex/http 各自带额度与越界防御。
4. **执行互斥**：沙箱开 → 只有 Python/Node 沙箱；沙箱关 → 只有宿主 execute_command，绝不并存。

> 变更流程：新增工具 → 实现 AgentTool（`tools.rs` trait）→ `native/mod.rs::register_native_tools` 注册（含条件与工具族归属）→ 同步本清单与 `RunDagCanvas.tsx::TOOL_DISPLAY` 显示名 → `npm run tauri` 重启生效。
