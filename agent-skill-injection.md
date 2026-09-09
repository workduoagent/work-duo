# 问题：Skill 注入/执行机制（程序性内容未落地）

> 一个问题一个 md。本文件只聚焦「Skill 的程序性内容（SKILL.md / references / scripts / 质量门禁）为什么没进 Agent 上下文、如何修」。
> 关联问题（单独 md，勿混）：见文末「下一个问题」。

---

## 1. 问题现象

用户给 Agent 挂载了 `react-developer` 技能（SKILL.md 明确要求 `tailwindcss v4`、`@tanstack/react-query v5`、`npm create vite` 脚手架、`build 通过` 质量门禁），
并下达任务「用 react-developer 搭一个叫 shop 的项目，Vite+TS+路由+zustand+tanstack-query+tailwind+vitest」。

结果（实际产物 `E:\WorkDuoTest\oa-web`）：
- 构建 **`npm run build` 直接失败**（TS7 移除 `baseUrl`）；
- **Tailwind 样式实际不生效**（装了 v4 却用 v3 写法、无 postcss 配置）；
- 用户点名的 **`@tanstack/react-query` 完全缺失**（只装了 axios）；
- 依赖全 `latest`，不可复现。

即：**Skill 被「挂了」，但没真正「用上」**——产物风格合规（说明 `instruction` 铁律生效），但工作流/版本约束/质量门禁全失效。

---

## 2. 证据链

| 位置 | 内容 | 结论 |
|---|---|---|
| `skill_info` 表（init.sql:60-75） | 设计上就有 `skill_markdown`（SKILL.md 正文）、`path`（磁盘目录）两列，与 `instruction`（铁律）**分离** | 数据层本就为「程序性内容落地」准备好字段 |
| `commands.rs:855` 查询 | 只 `SELECT s.id, s.name, s.description, s.instruction` —— **从不取 `skill_markdown` / `path`** | SKILL.md 正文从库读出前就被丢弃 |
| `skill_adapter.rs:20-24` 结构体 | `SkillToolWrapper` 仅含 `skill_id/name/description` | 结构里根本没有 SKILL.md 的立足之地 |
| `skill_adapter.rs:71-74`（修复前） | `execute()` 返回 `"技能『{}』已接收任务：{}\n（只读包装模式：真实业务执行待接入）"` | **回声壳**：不读 SKILL.md、不跑脚本、不执行工作流 |
| Agent.log L78-84 / 319 / 578 / 822 | `技能『React开发技能』（id=…）已接收任务：<原任务>\n（只读包装模式…）` | 日志实锤：skill 工具每次都是原样回显 |
| Agent.log 工具分布 | 18 write_file / 18 read_file / 11 list_directory / **4 skill(回声)** / 2 sandbox；**0 次 `npm install`/`npm run build`/`npm create vite`** | Agent 退化成「裸 LLM + 一段铁律」在现写文件，从未触发脚手架 |
| Agent.log `tanstack` 出现次数 | **0 次** | 需求在 planner 层被理解成 axios，工作流未被执行故未纠正 |

**一句话根因**：Skill 的「角色+铁律」(`instruction`) 进了上下文，但「工作流+版本约束+质量门禁」(SKILL.md 正文) 既没被查询取出、也没被工具返回——`skill__xxx` 是个回声壳，程序性价值零落地。

---

## 3. 根因（深入）

1. **查询层漏字段**：`commands.rs` 取技能时遗漏 `skill_markdown`/`path`，SKILL.md 正文躺库里被忽略。
2. **工具层是回声壳**：`skill_adapter.rs::execute()` 只回显任务文本，不返回 SKILL.md、不读 `references/`、不指引 `scripts/`。
3. **验收层太浅**（同类病，见 `agent-verifier-bug.md`）：自检只查「文件存在」，**从没真跑 `npm install`+`build`**，假成功放行。
4. ✅ 与「instruction 与 SKILL.md 分离」铁律**不冲突**——本修复保持两者分离：`instruction` 仍作工具描述/角色，`skill_markdown` 仅在 `execute()` 返回时作为「完整指引」注入，未合并。

---

## 4. 已落地修复（2026-09-09 二次修复 · 第一刀）

**目标**：让 Skill 的程序性内容在 Agent 调用技能时真实返回，使其遵循工作流/脚手架/质量门禁。

### 4.1 `src-tauri/src/agent/commands.rs`
- 两处查询（绑定技能 `:855`、临时 `@` 启用 `:914`）均补取 `skill_markdown AS skill_markdown, s.path AS skill_path`。
- 两处 `SkillToolWrapper` 构造（`:899`、`:937`）补填 `skill_markdown`、`skill_path` 字段。

### 4.2 `src-tauri/src/agent/skill_adapter.rs`
- 结构体新增 `skill_markdown: String`、`skill_path: String`。
- 工具描述改为：`"[Skill] <desc>（调用本工具获取该技能完整 SKILL.md 工作流与脚手架脚本指引，须严格遵循返回内容执行）"` ——**主动提示模型去取完整指引**。
- `execute()` 不再是回声，而是拼接返回：
  1. `## 技能『x』完整指引` + 任务；
  2. **完整 `skill_markdown`（SKILL.md 正文）**；若无则回退 `description`；
  3. `## 本地资源目录`：给出 `skill_path`，提示 `references/` 与 `scripts/`（如 `setup_project.py`）位置，要求先 read_file 再沙箱运行；
  4. `## 执行要求`：强制遵循工作流与质量门禁（版本固定、build/test 通过），不得凭通用经验现写文件。

### 4.3 验证
- `cargo check` → EXIT=0（5.28s）
- `npm run typecheck` → EXIT=0
- 行为预期：Agent 调用 `skill__xxx` 后拿到真实 SKILL.md，planner/执行阶段会按 Workflow A 跑 `npm create vite`、按 `setup_project.py` 固定版本、按质量门禁跑 build——从源头消除「缺 tanstack / 版本错配 / 构建失败」。

---

## 5. 影响 / 风险

- ✅ 低风险、自包含：仅改技能查询与工具返回，不影响其它能力层（MCP/沙箱/审批）。
- ⚠️ `skill_markdown` 若为空（用户只填了 `instruction` 没写 SKILL.md），自动回退到 `description`，不致空白。
- ⚠️ SKILL.md 正文较长会增大单次工具返回 token；但仅在 Agent 主动调用技能时返回，非每条请求都带，可控。
- ⚠️ 仍依赖 Agent「主动调用 `skill__xxx`」：当前日志显示它会调（4 次），修复后这 4 次将拿到真内容。若某些 planner 不调技能，需另在系统提示层主动注入（见下个问题的备选方案）。

---

## 6. 下一个问题（单独 md，勿在本文件改）

本刀只解决了「调用技能时返回真内容」。仍有两个待突破点，建议各自成 md：

1. **真构建硬验收（建议文件名 `agent-build-acceptance.md`）**
   - 现状：verifier 只查文件存在（`agent-verifier-bug.md` 问题 1 已修 `|` 容错，但仍未跑 build）。
   - 目标：success_criteria 增加「`npm install` + `npm run build`(或 typecheck) 0 错误」「点名库确实在依赖清单」两类硬检查，与 `text_contains` 容错对称。
   - 这是防「假完成」的最后一道闸，优先级高于改 oa-web 三个文件。

2. **（可选）系统提示层主动注入 SKILL.md 概要**
   - 若 planner 不主动调 `skill__xxx`，可在 `load_config`/system prompt 构建处，把 SKILL.md 的「Workflow + 质量门禁」摘要前置，确保不依赖「调用才拿到」。
   - 当前先不实现，观察实跑日志再决定。

---

## 7. 待办

- [x] 修复 `commands.rs` 漏取 `skill_markdown`/`path` + `skill_adapter.rs` 回声壳 → 已落地，`cargo check`/`typecheck` 通过。
- [ ] 等用户重跑 `oa-web` 用例日志，确认 Skill 工作流真被遵循（tanstack 进依赖、build 通过、tailwind 生效）。
- [ ] 开新 md `agent-build-acceptance.md`：补「真构建 + 点名库存在」硬验收。
- [ ] （视日志）决定是否做系统提示层主动注入 SKILL.md 概要。
