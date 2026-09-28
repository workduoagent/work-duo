# 自动化目录与命名

```text
tests/
  cases/<module>/TC-<module>-<id>.md   # 用例说明（可选）
  e2e/<module>/
  api/<module>/
  reports/
```

## 命名

- 用例 ID：`TC-<module>-<seq>`
- 脚本：`test_<domain>_<behavior>.py` 或 `*.spec.ts`
- 报告：`YYYYMMDD-<feature>.md`

## 原则

1. 脚本与用例 ID 可互相检索。  
2. 测试数据自造自清，不依赖脏环境。  
3. 断言明确：状态码、错误码、关键字段。  
4. 禁止无断言冒烟当「已测」。
