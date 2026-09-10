# Agent 真机测试问题排查报告（2026-09-10）

> 来源：用户真机日志 `workduo.log.2026-09-10` + 前端执行轨迹截图 + `E:\WorkDuoTest` 现场产物。
> 排查范围：`.wd_mem` 图/记忆结构、react-demo 项目依赖、160 个工具调用中 4 处失败根因。

## 一、总体结论（TL;DR）

本次失败不是单一 bug，而是 **「代码级路径规范遗漏」+「模型/技能级依赖配置错误」+「模型编辑上下文健忘」** 叠加：

1. **代码 bug（高确定性）**：`native__run_node_sandbox` 生成脚本仍落到旧路径 `.wd_mem/scripts/`，且执行时 `cwd` 是脚本所在目录（`.wd_mem/[runtime/]scripts/`），不是工作空间根。脚本内相对路径 `react-demo/package.json` 实际解析到 `.wd_mem/scripts/react-demo/package.json`，所以文件明明存在却报 `ENOENT`。这是用户觉得「理由摸不清头脑」的核心。
2. **代码/规范遗漏（高确定性）**：`.wd_mem/.gitignore` 仍按旧目录结构写规则（`sessions/`/`data/`/`outputs/`），未随 `runtime/` 新结构更新；新产生的 `runtime/scripts/` 未忽略，运行碎片会被误纳入版本控制。
3. **模型/技能错误（高确定性）**：`package.json` 把 `@vitejs/plugin-react` 放进 `dependencies` 且写 `"latest"`，导致 `npm i` ERESOLVE（`latest`→6.1.1 要求 `vite@^8.0.0`，但项目 `vite@^6.1.0`）。
4. **模型编辑错误（高确定性）**：`edit_file` 的 `old_str` 与文件实际内容不匹配（缺 `typecheck`/`lint` 脚本、或 `typecheck` 值写错），触发 `old_str 在文件中未找到`，进入恢复循环，最终 step 3 因达最大恢复次数被跳过。

---

## 二、`.wd_mem` 是否符合理想规范？

### 2.1 符合规范的项 ✅

| 检查项 | 现场结果 | 结论 |
|---|---|---|
| `graph/` 目录存在 | ✅ `E:\WorkDuoTest\.wd_mem\graph\` | 符合 |
| `nodes.jsonl` / `edges.jsonl` / `_index.json` | ✅ 存在，JSONL 追加写，后行覆盖前行 | 符合 |
| `graph/sessions/{session_id}.json` 快照 | ✅ `4981f74c-...7ea.json` 存在 | 符合 |
| `knowledge/` 目录 + `MEMORY.md` | ✅ 已迁移 | 符合 |
| `runtime/` 目录 + `scripts/data/outputs` | ✅ 目录已创建 | 符合 |
| Task/Session/Artifact 节点 + 边关系 | ✅ `_index.json` 中可见 | 符合 |

### 2.2 不符合规范的项 ⚠️

| 检查项 | 现场结果 | 问题 |
|---|---|---|
| **运行时脚本落盘位置** | ❌ `.wd_mem/scripts/` 仍产生 `auto_run_*.mjs`；`.wd_mem/runtime/scripts/` 为空 | `native.rs:1246/1397` 仍写旧路径 `.wd_mem/scripts`，没随 `wd_mem.rs` 的新结构改到 `runtime/scripts` |
| **`.wd_mem/.gitignore`** | ❌ 规则仍是 `sessions/`/`data/`/`outputs/`，未加 `runtime/` | 新 `runtime/scripts/data/outputs` 不会被忽略；`sessions/` 却被忽略，与 `wd_mem.rs` 注释「sessions summary 随 Git 走」矛盾 |
| **Session 状态语义** | ⚠️ 原 session 节点状态为 `obsolete` | 这是 **replan/recovery 设计行为**，不是 bug。用户后续又发起「修复依赖冲突」会话，旧会话被置 `obsolete`，新会话 `running` + step 1 `failed` |

---

## 三、react-demo `npm i` 为什么失败？

### 3.1 错误信息

```
npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
...
npm error Found: vite@6.4.3
npm error Could not resolve dependency:
npm error peer vite@"^8.0.0" from @vitejs/plugin-react@6.1.1
```

### 3.2 根因

当前 `E:\WorkDuoTest\react-demo\package.json`（由 Agent 生成）关键片段：

```json
{
  "dependencies": {
    "@vitejs/plugin-react": "latest",   // ❌ 1) 不该在 dependencies；2) "latest" 太危险
    "antd": "^5.24.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^7.1.5"
  },
  "devDependencies": {
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "typescript": "~5.7.2",
    "vite": "^6.1.0"                       // ❌ 与 @vitejs/plugin-react@latest 不兼容
  }
}
```

问题三点：

1. **@vitejs/plugin-react 是构建工具插件，应放在 `devDependencies`**，而不是运行时 `dependencies`。
2. **不应使用 `"latest"`**。2026-09-10 的 latest 是 6.1.1，其 `peerDependencies` 要求 `vite@^8.0.0`，与项目 `vite@^6.1.0` 冲突。
3. **版本未对齐**。vite 6.x 应搭配 `@vitejs/plugin-react` 的兼容版本（如 `^4.3.4` 或专门匹配 vite 6 的版本），而不是直接上 latest。

### 3.3 修复建议

将 `package.json` 改为：

```json
{
  "dependencies": {
    "@ant-design/icons": "^5.6.1",
    "antd": "^5.24.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^7.1.5"
  },
  "devDependencies": {
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@typescript-eslint/eslint-plugin": "^8.24.0",
    "@typescript-eslint/parser": "^8.24.0",
    "@vitejs/plugin-react": "^4.3.4",   // 与 vite ^6 兼容；如需 vite 6 官方推荐版，用对应 plugin 5.x
    "eslint": "^9.20.1",
    "eslint-plugin-react-hooks": "^5.1.0",
    "eslint-plugin-react-refresh": "^0.4.18",
    "typescript": "~5.7.2",
    "vite": "^6.1.0"
  }
}
```

同时，Agent 挂载的 `react-developer` Skill 应在系统提示或技能正文中 **显式加三条铁律**：

- 构建工具（vite、eslint、vitest、typescript、vite plugin）必须进 `devDependencies`；
- 禁止写 `"latest"`，必须指定兼容的大版本；
- 修改 `package.json` 前必须先用 `native__read_file` 读全文，避免 `edit_file` 的 `old_str` 不匹配。

---

## 四、基础工具报错根因（步骤三 / 四截图）

### 4.1 `run_node_sandbox`：`ENOENT: no such file or directory, open 'react-demo/package.json'`

**表面**：`react-demo/package.json` 明明存在，脚本却找不到。  
**实际**：脚本落盘在 `.wd_mem/scripts/auto_run_xxx.mjs`，Bun 执行时 `cwd` 是脚本父目录（`.wd_mem/scripts/`），脚本内相对路径解析为 `.wd_mem/scripts/react-demo/package.json`，不存在。

**代码位置**：
- 落盘目录：`src-tauri/src/agent/native.rs:1246`（Python）、`:1397`（Node）仍写 `.wd_mem/scripts`（旧路径）。
- 执行 cwd：`src-tauri/src/bun_manager.rs:533` 的 `run_node_in_sandbox` 把 `original_parent`（脚本所在目录）传给 `run_script_with_selfheal` 作为 `cwd`。

**为什么用户觉得奇怪**：日志里 `native__write_file` 已经成功写了 `E:\WorkDuoTest\react-demo\package.json`，但 `run_node_sandbox` 的 cwd 不是工作空间根，相对路径走偏。

### 4.2 `edit_file`：`old_str 在文件中未找到`

日志中 2 次失败：

1. **20:41:01 step 4**：想给 `package.json` 加 `test`/`test:watch` 脚本，但 `old_str` 只写了 `dev`/`build`/`preview`，没包含实际已存在的 `typecheck`/`lint`。
2. **20:47:17 step 4**：`old_str` 写 `"typecheck": "tsc -b"`，但文件实际是 `"typecheck": "tsc --noEmit"`。

**根因**：Agent 凭记忆构造 `old_str`，而不是基于文件当前真实内容。`edit_file` 是精确字符串替换，模型记错即失败。

---

## 五、代码修复清单（建议立即修）

### P1：修复沙箱脚本路径与 cwd

| 文件 | 位置 | 改动 |
|---|---|---|
| `src-tauri/src/agent/native.rs` | L1246 | `let dir = ws.join(".wd_mem").join("scripts");` → `ws.join(".wd_mem").join("runtime").join("scripts");` |
| `src-tauri/src/agent/native.rs` | L1397 | 同上（Node 沙箱） |
| `src-tauri/src/agent/native.rs` | 工具 description | `.wd_mem/scripts/` → `.wd_mem/runtime/scripts/`，并提示「脚本内相对路径以工作空间根为基准」 | **（✅ 已落地，见 §七 第 9 项）** |
| `src-tauri/src/bun_manager.rs` | `run_node_in_sandbox` | 新增 `cwd: Option<&Path>` 参数，Agent 调用时传工作空间根；UI 调用 `run_node_script` 保持脚本父目录 |
| `src-tauri/src/mamba_manager.rs` | `run_python_in_sandbox` | 同上 |
| `src-tauri/src/agent/native.rs` | 调用点 | `run_node_in_sandbox`/`run_python_in_sandbox` 调用时传入 `ctx.workspace` 根路径作为 cwd |
| `src-tauri/src/agent/wd_mem.rs` | `.gitignore` 模板 | 忽略 `runtime/`（或 `runtime/scripts/`、`runtime/data/`、`runtime/outputs/`）；修正 `sessions/` 语义 |

### P2：Skill / Prompt 层修正

- `react-developer` Skill 增加依赖写入规范：
  - 构建工具一律 `devDependencies`；
  - 禁止 `"latest"`；
  - 改 `package.json` 前必须 `read_file` 全文。
- `edit_file` 工具描述中强调：调用前应先 `read_file` 确认目标片段当前文本，严禁凭记忆构造 `old_str`。

---

## 六、下一步建议

1. **先修 P1 代码 bug**（沙箱路径 + cwd），这是导致工具报错和恢复循环浪费钱的主因。修完跑 `cargo check` + 一次真机复合任务回归。
2. **再修 P2 Skill/Prompt**，避免再次生成 `@vitejs/plugin-react: latest` 这种冲突配置。
3. **回归验证**：复跑同一个 prompt，确认：
   - `npm install` 成功；
   - step 3（测试配置）不再被跳过；
   - `.wd_mem/runtime/scripts/` 产生 `auto_run_*.mjs`，`.wd_mem/scripts/` 不再新增文件；
   - `edit_file` 失败率明显下降。

---

## 七、P1 已落地（2026-09-10 用户拍板实施）

### 改动清单（4 文件 / 8 处，逐条 Edit + Read 复核，防既往批量虚报）

| # | 文件 | 位置 | 改动 |
|---|---|---|---|
| 1 | `src-tauri/src/agent/native.rs` | L1246 | Python 沙箱落盘 `ws.join(".wd_mem").join("scripts")` → `ws.join(".wd_mem").join("runtime").join("scripts")` |
| 2 | `src-tauri/src/agent/native.rs` | L1397 | Node 沙箱落盘同上 |
| 3 | `src-tauri/src/agent/native.rs` | L1278 | `run_python_in_sandbox(...)` 追加第 5 参 `ctx.workspace.as_deref()`（=工作空间根 cwd，`Option<&Path>`） |
| 4 | `src-tauri/src/agent/native.rs` | L1426 | `run_node_in_sandbox(...)` 追加第 5 参同上 |
| 5 | `src-tauri/src/bun_manager.rs` | `run_node_in_sandbox` 签名 | 加 `cwd: Option<&Path>`；内部 `run_script_with_selfheal(..., cwd.or(original_parent.as_deref()))` |
| 6 | `src-tauri/src/mamba_manager.rs` | `run_python_in_sandbox` 签名 | 同上（`cwd.or(original_parent.as_deref())`） |
| 7 | `src-tauri/src/agent/wd_mem.rs` | `.gitignore` 模板 | 删过时 `data/`/`outputs/`，加 `runtime/data/`/`runtime/outputs/`；纳入版本控制注释 `scripts/`→`runtime/scripts/` |
| 8 | — | — | UI 入口 `run_node_script`/`run_python_script` **未改**，保持脚本父目录 cwd（行为不变） |
| 9 | `src-tauri/src/agent/native.rs` | 沙箱工具 description（L1170/L1182/L1212/L1322/L1332） | **原 §五 P1 第 4 行此处漏列，本次补全**：5 处`.wd_mem/scripts/`→`.wd_mem/runtime/scripts/`；Python/Node 主提示补「脚本内相对路径以工作空间根为基准」。⚠️ 注：首次并行 Edit 同文件发生丢失更新，仅 L1332 生效，已逐条串行补回其余 4 处 |

### 设计要点
- **cwd 优先级**：Agent 注入的 `ctx.workspace`（工作空间根）优先；UI 不传 cwd，回退 `original_parent`（脚本父目录），与迁移前行为一致。
- **node_modules 解析不受影响**：Bun/Mamba 仍把脚本复制到 `bun_root/run_tmp/`（或 `mamba_root/run_tmp/`），`node_modules` 沿脚本目录向上回溯命中 `bun_root/node_modules`；cwd 仅改变脚本内相对文件操作（如 `fs.readFile('react-demo/package.json')`）的基准，正好修正 ENOENT。
- **SCRIPTS_DIR 常量**：`wd_mem.rs:21` 的 `"scripts"` 仅作 `runtime/` 下子目录名（`ensure_wd_mem` 已 `base.join("runtime").join(sub)` 创建 `runtime/scripts/`），与本次落盘路径一致；迁移逻辑仍搬旧根 `scripts/`→`runtime/scripts/`。

### 验证状态
- ✅ 人工编译复核：类型（`Option<PathBuf>.as_deref()→Option<&Path>`）、两 manager `run_script_with_selfheal` 末参 `cwd: Option<&Path>` 签名/调用点、仅 native.rs 两处调用方已同步、UI 入口未破坏——全部一致。
- ⏳ **`cargo check` 未在本沙箱执行**：当前环境仅 `rustup` 无安装工具链、盘上无 `cargo.exe`，无法编译。需在用户真机 `cd src-tauri && cargo check` 终验。
- ⏳ **真机复合任务回归**：待用户复跑（每次花钱），重点看 `.wd_mem/runtime/scripts/` 是否产出、ENOENT 与 edit_file 恢复循环是否消失。
- ⚠️ **遗留 doc 矛盾**：`wd_mem.rs:5` 模块注释「sessions summary 随 Git 走」与 `.gitignore` 仍忽略 `sessions/`（及 L146 一致）矛盾；本次保守保留 `sessions/` 忽略（不引入仓库膨胀行为变更），该矛盾留待用户拍板。
- ⚠️ **存量 `.gitignore` 不覆盖**：`ensure_wd_mem` 仅在 `.gitignore` 不存在时写入，已有工作空间（如 `E:\WorkDuoTest`）保留旧规则；新工作空间才用新模板。若需即时生效，手动删旧 `.gitignore` 让其重建。
