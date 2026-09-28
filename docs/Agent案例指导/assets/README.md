# assets · 可导入资产说明

> 本目录是 `Agent案例指导` 的**可落地资产包**：Skill 设计稿 + 本地插件（FaaS）脚本 + 知识库种子语料。  
> 可复制到 WorkDuo「技能中心 / 插件 / 知识库」导入。

## 知识库（按 identifier 建目录）

| 目录 | identifier | 用途 | 挂载建议 |
|---|---|---|---|
| `kb-eng-standards/` | `kb-eng-standards` | 工程规范（目录/前后端/Rust/Git） | 全员 |
| `kb-product-prd/` | `kb-product-prd` | PRD、用户故事、验收、变更 | PM、架构、QA |
| `kb-adr/` | `kb-adr` | ADR、契约组织、数据建模 | 架构、开发、评审 |
| `kb-test-assets/` | `kb-test-assets` | 用例模式、自动化、门禁 | QA、开发 |
| `kb-pitfalls/` | `kb-pitfalls` | 踩坑、回归、RCA | 全员（优先召回） |

每个目录内 `README.md` 是导入说明，`0*.md` 是可直接入库的语料。

## Skill（按 identifier 命名）

| 文件 | identifier | 用途 |
|---|---|---|
| `skill-eng-standards.md` | `skill-eng-standards` | 工程规范守卫 |
| `skill-api-contract.md` | `skill-api-contract` | 接口契约写作 |
| `skill-test-case-design.md` | `skill-test-case-design` | 测试用例设计 |
| `skill-code-review-checklist.md` | `skill-code-review-checklist` | 代码评审清单 |
| `skill-delivery-pack.md` | `skill-delivery-pack` | 交付包组装 |
| `skill-task-breakdown.md` | `skill-task-breakdown` | 任务拆解与验收 |

导入建议：`name` 用中文名（工程规范守卫等），`identifier` 与文件名一致；`skillMarkdown` 取本文件正文。

## 插件（Python / Bun）

| 文件 | identifier | runtime | 说明 |
|---|---|---|---|
| `plugin-diff-summary.ts` | `plugin-diff-summary` | bun | git diff 摘要与风险 |
| `plugin-ts-typecheck.ts` | `plugin-ts-typecheck` | bun | TS typecheck |
| `plugin-md-toc.ts` | `plugin-md-toc` | bun | Markdown TOC |
| `plugin-changelog-draft.ts` | `plugin-changelog-draft` | bun | 变更日志草稿 |
| `plugin-vue-build.ts` | `plugin-vue-build` | bun | Vue typecheck/build |
| `plugin-pytest-runner.py` | `plugin-pytest-runner` | python | pytest 执行解析 |
| `plugin-coverage-report.py` | `plugin-coverage-report` | python | coverage 缺口 |
| `plugin-code-stats.py` | `plugin-code-stats` | python | 行数/热点 |
| `plugin-sql-migrate-check.py` | `plugin-sql-migrate-check` | python | SQL 双轨/幂等 |
| `plugin-openapi-lint.py` | `plugin-openapi-lint` | python | 契约片段检查 |
| `plugin-test-report-md.py` | `plugin-test-report-md` | python | 测试报告 MD |
| `plugin-java-build.py` | `plugin-java-build` | python | 宿主 Maven/Gradle |
| `plugin-cargo-check.py` | `plugin-cargo-check` | python | 宿主 cargo（无 Rust 沙箱） |

## 导入要点

1. 头注释元数据已按 WorkDuo 范式写好（`name/description/dependencies/parameters`）。  
2. 函数签名固定：Python `def run(params)` / Bun `export async function run(params)`。  
3. `timeoutSec` 建议：构建类 180–300；检查类 60–120。  
4. **宿主工具链**（java/cargo）需本机已装 JDK/Maven 或 Rust；可用 `WD_CARGO_BIN`、`WD_MVN_BIN`、`JAVA_HOME` 定位。  
5. 试跑：`plugin_test` 用 `sampleParams`；缺依赖 Python/Bun 走 exit 42 / 模块未找到自愈。

## 与案例文档关系

- 角色挂载表见 `../01-编排式-*.md`
- 流水线工序见 `../02-流水线-*.md`
- 群聊不挂执行类插件，仅只读分析类
