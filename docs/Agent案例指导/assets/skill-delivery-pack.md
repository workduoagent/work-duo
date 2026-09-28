# skill-delivery-pack · 交付包组装

> 适用：`int-delivery`、流水线 S5。用途：把代码、测试、评审、需求证据打成可审计交付包。

---

## 何时使用

- 小分队收尾 / 流水线末道工序
- 对外提交「可验收」成果
- 发布门禁需要机器可读证据时

## 交付包结构

```text
delivery/<date>-<feature>/
  manifest.json      # 清单与校验
  report.md          # 人读报告
  changes/           # 代码与文档改动
  tests/             # 用例与测试报告
  reviews/           # 评审意见
  sources/           # PRD、契约、会话摘要引用
```

## manifest.json 最小字段

```json
{
  "feature": "export-stat",
  "createdAt": "2026-09-28",
  "members": ["pm-product", "dev-python-backend", "qa-test-engineer"],
  "artifacts": [
    { "path": "changes/src/api/export.py", "type": "code", "from": "dev-python-backend" }
  ],
  "acceptance": [
    { "id": "AC-1", "result": "pass", "evidence": "tests/reports/....md" }
  ],
  "gates": {
    "typecheck": true,
    "tests": true,
    "reviewBlocker": 0
  },
  "residualRisks": []
}
```

## report.md 必含

1. **背景与目标**（来自 PRD，可摘要 + 路径）  
2. **变更说明**（按模块/接口）  
3. **验收对照表**（AC → 结果 → 证据）  
4. **测试摘要**（通过/失败/失败列表）  
5. **评审结论**（Blocker/Major 计数与结论）  
6. **风险与不支持项**  
7. **如何复现/回滚**

## 组装纪律

1. 文件名与任务 `expectedArtifacts` **逐字一致**，缺一不可。  
2. 只收**证据**，不收空话；每条结论可追溯到文件。  
3. 未完成项显式 `skip` + 理由，禁止静默丢弃。  
4. 大文件/二进制写入 `changes/` 并在 manifest 标明哈希/大小（可选）。  
5. 导出后自检：`manifest.artifacts` 与磁盘列表一致。

## 门禁（放行条件）

- 无 Blocker 测试失败  
- 无未清评审 Blocker  
- 验收表全覆盖或显式 skip  
- changelog/变更说明存在

## 输出模板（report.md 骨架）

```markdown
# 交付报告 · <feature>
## 1. 摘要
## 2. 范围与非目标
## 3. 变更清单
## 4. 验收对照
## 5. 测试
## 6. 评审
## 7. 风险与回滚
## 8. 产物索引
```
