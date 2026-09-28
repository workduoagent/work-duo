# skill-task-breakdown · 任务拆解与验收

> 适用：PM、架构、主笔、集成。用途：把目标拆成可执行、可验收、可交接的子任务。

---

## 何时使用

- 从 PRD/议题生成开发任务包
- 编排式主管做委派 JSON
- 流水线 S1 产出任务清单
- 群聊收口生成 actionItems

## 拆解原则

1. **结果导向**：每个任务写清「完成时多出什么文件/行为」。  
2. **可独立验收**：避免任务之间只能靠口头串联。  
3. **大小合适**：单任务 ≈ 一次专注工作（约 0.5–2 天人活，或 Agent 单轮可完成的交付）。  
4. **依赖显式**：`dependsOn` 画清楚，禁止隐含顺序。  
5. **含测试/文档**：不把测试甩给「以后再说」。

## 任务卡字段

| 字段 | 说明 |
|---|---|
| id | `t-fe-1` 等 |
| title | 动词开头：实现/修复/补充 |
| ownerRole | pm / arch / dev-* / qa / review / int |
| inputs | 契约/PRD 路径 |
| outputs / artifactPaths | 期望落盘文件 |
| acceptance / DoD | 可测验收条目 |
| dependsOn | 上游任务 id |
| risks | 主要风险 |
| estimate | 粗估（S/M/L） |

## DoD 模板

- [ ] 产物文件存在且路径正确  
- [ ] 对应 AC 有测试或演示  
- [ ] typecheck/build/test 相关命令通过  
- [ ] 契约/文档已同步  
- [ ] 自测报告或摘要已交接  

## 委派 JSON（编排式）

```json
{
  "tasks": [
    {
      "id": "t-be-1",
      "title": "实现导出统计 API",
      "ownerRole": "dev-python-backend",
      "inputs": ["docs/prd/export-stat.md", "docs/contracts/export-api.md"],
      "artifactPaths": ["src/api/export.py", "tests/test_export.py"],
      "dependsOn": [],
      "acceptance": ["AC-1", "AC-2"],
      "estimate": "M"
    }
  ]
}
```

## 行动项（群聊收口）

```json
{
  "actionItems": [
    {
      "id": "A1",
      "ownerRole": "arch-tech-lead",
      "task": "补队列契约到 docs/contracts/",
      "doneWhen": "契约文件存在且含失败重试语义"
    }
  ]
}
```

## 反模式

- 「优化系统」级无法验证的口号任务  
- 一个任务里混 UI+后端+发布  
- 无 artifactPaths，完成后靠描述交接  
- 依赖靠「大家都知道」  
- 验收写「差不多能用」
