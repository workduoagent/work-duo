# ADR-001: 沙箱语义与宿主工具链

| 项 | 内容 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-28 |

## 背景

产品提供 Python（micromamba）/ Bun 沙箱，**不提供 Rust/JVM 沙箱**。  
源码审计与 G-M1：沙箱=环境隔离，非 OS 安全边界；`subprocess` 可派生宿主进程。

## 决策

1. 文档与工具描述不再称「安全沙箱」，改「环境隔离」。  
2. Rust/Java 检查一律走**宿主工具链包装插件**（`plugin-cargo-check` / `plugin-java-build`）或 `execute_command` 白名单。  
3. 插件禁止 `shell=True` 拼任意命令；子命令白名单。  
4. 无人值守场景对宿主构建命令保持 `sensitive` 审批或显式 allowlist。

## 备选

- 自建 Rust 沙箱：成本高，暂不做。  
- 只允许人工本地跑 cargo：丢失自动化验收能力。

## 后果

- 正：覆盖 Java/Rust 团队；可测可审计。  
- 负：存在调用宿主工具链的攻击面，需靠白名单与审批收束。

## 落地

- `plugin-cargo-check.py` / `plugin-java-build.py`  
- 案例文档 §4.5 宿主工具链
