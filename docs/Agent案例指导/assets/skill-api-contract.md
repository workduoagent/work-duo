# skill-api-contract · 接口契约写作

> 适用：架构、前后端、Java/Python 服务。用途：把接口说清楚，可被前后端与测试直接消费。

---

## 何时使用

- 新增/变更 HTTP、IPC、事件、消息总线接口
- 前后端并行开工前（契约先冻结）
- 评审接口变更

## 契约最小字段

| 字段 | 说明 |
|---|---|
| method / type | GET/POST… 或 event/command 名 |
| path / channel | `/api/users`、`ipc://xxx`、事件名 |
| summary | 一句话职责 |
| request | 字段、类型、必填、约束 |
| response | 成功结构与示例 |
| errors | 错误码、HTTP 状态、可重试性 |
| auth | 是否需要登录/权限 |
| idempotent | 是否幂等 |
| version / since | 从哪版开始 |

## 命名约定

- HTTP 路径：小写 kebab-case，资源名词复数，`/api/` 前缀按项目定。
- JSON 字段：**全项目统一 snake_case 或 camelCase**（跟主工程），禁止混用。
- 事件名：`domain-entity-action`（如 `agent-task-done`）。
- 操作必须可从名字看出副作用（`create_user` 而非 `handle`）。

## REST 参考

```http
GET /api/v1/users?page=1&size=20
Authorization: Bearer <token>

200
{
  "items": [{ "id": "u1", "name": "Ada" }],
  "total": 123,
  "page": 1,
  "size": 20
}

4xx/5xx
{
  "code": "USER_NOT_FOUND",
  "message": "user not found",
  "requestId": "..."
}
```

## 事件/命令契约

```json
{
  "name": "agent-step-finished",
  "payload": {
    "runId": "string",
    "taskId": "string",
    "status": "done|failed|cancelled",
    "durationMs": 0
  },
  "invariants": ["tool_call.id 必有对应结果", "终态必达"]
}
```

## 变更纪律

1. **只增不改**优先；破坏性变更必须升版本或双写过渡。
2. 删除字段先标 deprecated，再删。
3. 契约文件路径固定（如 `docs/contracts/<feature>-api.md`），进交付包。
4. 测试用例 ID 映射到契约接口。

## 禁止

- 在聊天里口头定接口却不落契约文件
- 返回 200 + 错误语义（该 4xx 就 4xx）
- 无限制分页/无大小上限的数组字段

## 输出模板

```markdown
# <feature> 接口契约
## 背景
## 接口列表（表格）
## 变更说明
## 兼容性 / 迁移
## 验收映射（AC-id → 接口）
```
