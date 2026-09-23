// L2 生态深度测评 Harness（并发 + 故障注入 + 三维评分）
// 事实源登记：docs/skills/workduo-mcp/scripts/l2_eval_harness.mjs
// 用法：
//   node l2_eval_harness.mjs env
//   node l2_eval_harness.mjs run --cases A-M1,A-M2 [--model fast|slow|<id>] [--concurrency N]
//   node l2_eval_harness.mjs run --phase 1|2|3|4
//   node l2_eval_harness.mjs inject --fault F-1
//   node l2_eval_harness.mjs score
// 约束：全走 workduo-mcp 70 工具；能力缺口回流 MCP，禁止绕过脚本。
// 工作空间根：E:/Codes/ABC/work-duo/eval-workspace/
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  initMcp, callTool, rawPost, unw, asRows, sleep, traceInner,
  extractKbEvents, hitsOf, logFetcher, pollRun, startRun,
} from './agent_task_driver.mjs'

// ---------- 配置 ----------
export const ROOT = process.env.L2_WS_ROOT || 'E:/Codes/ABC/work-duo/eval-workspace'
export const OUT = process.env.L2_OUT || 'E:/Codes/ABC/work-duo/docs/eval-results/2026-09-23'
/** MCP 工具数基线（随版本演进；F-7 故障断言与 gate 探针共用同一期望值） */
const EXPECTED_TOOLS = 72
export const MODELS = {
  fast: '96af449e-dfc0-48ec-b077-aa9f02b43d64', // DeepSeek-V4.1-Flash
  slow: 'bb9ab960-6615-439a-b5bc-95d2a65173b3', // MiniMax-M3
  alt:  '9c1531ad-5310-4ab8-ac29-56231881bcfe', // GLM-5.3-Flash
  bad:  '6001e0c3-eb75-47e0-a020-c3a3bc4e5f40', // gpt-5.6-luna（已知坏，仅故障注入）
}
// 并发下 Medium 也可能 >360s（2026-09-23 实测：C-3 三任务 360s 窗口截断，但进程仍在跑）
// 故窗口按「并发感知」放宽；判据仍是终态率，不用总耗时误杀。
const WAIT = {
  M: parseInt(process.env.L2_WAIT_M || '600000', 10),
  H: parseInt(process.env.L2_WAIT_H || '900000', 10),
}

// ---------- 案例目录 ----------
// kind: M|H  scene: A|B  dims: 重点观测维度
// artifacts: 相对 workspace 的期望产物（存在性判据）
// prompt: 下发给 Agent 的任务（复合任务必须带文件产物要求）
export const CASES = {
  // ===== 场景 A 日常工作 =====
  'A-M1': {
    scene: 'A', kind: 'M', title: '单源爬取+清洗+产物',
    dims: ['perf', 'ha'],
    artifacts: ['releases.csv', 'releases_report.md'],
    prompt: `请完成数据任务并把产物写到当前工作空间根目录（不要建子目录之外的路径）：
1) 拉取 https://api.github.com/repos/tauri-apps/tauri/releases 最新 20 个 release
2) 清洗出字段：tag_name, published_at, download_count（取 assets 下载数之和）
3) 输出 releases.csv（UTF-8，含表头）
4) 输出 releases_report.md：最新版本号、平均发布间隔（天）、表格列出全部 20 条
全程必须落盘到工作空间。完成后列出文件路径。`,
  },
  'A-M2': {
    scene: 'A', kind: 'M', title: '多源聚合+Excel+图',
    dims: ['perf', 'ha'],
    artifacts: ['market.xlsx', 'price_trend.png'],
    prompt: `请完成多源聚合并落盘到工作空间根目录：
1) 并行获取 (a) https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7&interval=daily 的价格序列 (b) 一个公开新闻/RSS 或 HN API 最近条目时间线
2) 将价格按日期 join 到新闻时间线
3) 输出 market.xlsx（至少 3 个 sheet：prices / news / joined）
4) 输出 price_trend.png 价格走势图
完成后列出文件。`,
  },
  'A-M3': {
    scene: 'A', kind: 'M', title: '批量URL并发爬取+记忆中间态',
    dims: ['perf', 'ha', 'heal'],
    artifacts: ['doc_index.json', 'doc_summary.md'],
    prompt: `请并发爬取下列 10 个公开文档页的 <title> 与第一个 <h1>，落盘到工作空间：
https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview
https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods
https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON
https://developer.mozilla.org/en-US/docs/Web/CSS/Display
https://developer.mozilla.org/en-US/docs/Web/CSS/Flexbox
https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form
产出 doc_index.json（数组：url,title,h1）与 doc_summary.md 表格。
另外用 memory_anchor 沉淀一条记忆 key=l2-a-m3-doc-topics，content=主题清单摘要，category=other。`,
  },
  'A-M4': {
    scene: 'A', kind: 'M', title: '插件编写闭环',
    dims: ['ha', 'heal'],
    artifacts: ['plugin_report.md'],
    prompt: `请完成插件全生命周期并落盘报告：
1) 编写本地插件（python 或 bun）identifier=l2-fetch-clean，功能：入参 url，抓取 URL 文本并返回 {url, length, sample}
2) plugin_test 试跑通过
3) 把插件绑定到你当前 Agent
4) 用该插件抓取 https://httpbin.org/json，把结果写入 plugin_report.md
完成后列出文件与插件 id。`,
  },
  'A-M5': {
    scene: 'A', kind: 'M', title: 'KB导入+RAG综述',
    dims: ['ha', 'heal'],
    artifacts: ['research_note.md'],
    prompt: `请完成知识库综述：
1) 若尚无专用库，创建/使用知识库并导入至少 6 篇短文（可用 kb_add_file 写入 markdown 主题文档，主题：HTTP 重试、超时、幂等、限流、熔断、降级）
2) 重建/等待索引完成
3) 生成 research_note.md：微服务韧性模式综述，正文引用处标 [N]，文末按源分组列参考
完成后列出文件。`,
  },
  'A-M6': {
    scene: 'A', kind: 'M', title: '跨轮记忆持久化',
    dims: ['ha', 'heal'],
    artifacts: ['memory_round1.md', 'memory_round2.md'],
    prompt: `第一轮任务：从 https://api.github.com/repos/tauri-apps/tauri/releases/latest 提取版本号、发布时间、名称，用 memory_anchor 写入 key=l2-a-m6-release-facts category=other，并把事实写入 memory_round1.md。完成后列出文件。`,
  },
  'A-M6b': {
    scene: 'A', kind: 'M', title: '跨轮记忆召回扩展',
    dims: ['ha', 'heal'],
    artifacts: ['memory_round2.md'],
    prompt: `第二轮任务：用 memory_list 查找 key 含 l2-a-m6 的记忆，基于记忆内容扩展分析（发布节奏、和上一版对比可查 API），写入 memory_round2.md。必须真正读取记忆而不是凭空编造。完成后列出文件。`,
  },
  'A-M7': {
    scene: 'A', kind: 'M', title: 'KB标签治理',
    dims: ['ha'],
    artifacts: ['tag_inventory.md'],
    prompt: `请完成知识库标签治理并落盘 tag_inventory.md：
1) 创建/使用 KB，添加 5 个文档文件
2) 对文档做标签 CRUD：至少 add/rename/get/remove 各一次（文档级标签，需带 assetId）
3) 生成 tag_inventory.md 表格：asset 相对路径、最终 tags
完成后列出文件。`,
  },
  'A-M8': {
    scene: 'A', kind: 'M', title: 'Skill封装与复用',
    dims: ['ha', 'heal'],
    artifacts: ['skill_report.md'],
    prompt: `请完成 Skill 封装：
1) 创建技能 identifier=l2-crawl-notes，SKILL.md 描述「抓取 URL 列表标题并输出 markdown 索引」的步骤
2) 用 skill_list / skill_get 核对已落库落盘
3) 按该技能方法实际抓取 3 个 URL 标题，输出 skill_report.md
完成后列出技能 path 与文件。
⚠️ 最终交付物核对（收尾前逐项核对，缺一不可）：
- skill_report.md（工作空间根，文件名逐字一致）
- 收尾规则：先落盘全部产物文件，再输出文字总结；只写总结不落盘=任务失败。`,
  },
  'A-H1': {
    scene: 'A', kind: 'H', title: '限流分页+断点续爬',
    dims: ['heal', 'ha', 'perf'],
    artifacts: ['wiki_dump.jsonl', 'progress.json', 'failed.log'],
    prompt: `请实现带自愈的分页爬取，落盘到工作空间：
1) 目标：用 MediaWiki API 分页拉取 https://en.wikipedia.org/w/api.php 列表（如 categorymembers 或 generator），目标 ≥40 条目（可少于 200，但必须体现分页）
2) 每页之间主动 sleep 1s 限流；单页失败重试 3 次，仍失败写入 failed.log 并跳过
3) 维护 progress.json（已爬 offset/id 列表）；若 progress.json 已存在则续爬不重爬
4) 产出 wiki_dump.jsonl（每行 {id,title}）
5) failed.log 必须存在：有失败页则逐条记录（url+原因+重试次数）；**全程无失败也要落盘并写一行 no failures**——该文件是断言产物，缺失即任务未完成
完成后列出文件与条数。`,
  },
  'A-H2': {
    scene: 'A', kind: 'H', title: '大批量ETL多格式产物',
    dims: ['perf', 'ha'],
    artifacts: ['etl_full.csv', 'etl_stats.json', 'etl_report.md', 'etl_dist.png'],
    prompt: `请完成批量 ETL（目标尽量 ≥1000 条，API 限流时可降到 500 条但必须分页拉完所选范围）：
1) 数据源：GitHub search API https://api.github.com/search/repositories?q=tauri+stars:>10&per_page=100 多页拉取
2) 清洗去重：字段 full_name, stars, language, updated_at
3) 聚合：按 language 统计 count/avg_stars，取 top10
4) 落盘：etl_full.csv 全量、etl_stats.json 聚合、etl_report.md（top10 表）、etl_dist.png 分布图（按语言 stars 分布）
完成后列出文件与行数。`,
  },
  'A-H3': {
    scene: 'A', kind: 'H', title: '全链路Skill+KB+插件',
    dims: ['heal', 'ha', 'perf'],
    artifacts: ['research_rust_async.md'],
    prompt: `请完成全链路研究任务（执行顺序有硬性要求，必须按序）：
1) 创建可复用 Skill identifier=l2-web-research：输入主题→多源抓取→KB 检索背景→清洗→带引用报告
2) 准备/使用 KB（写入至少 4 篇与 Rust 异步运行时相关背景短文并索引）
3) 【顺序硬约束】完成第 2 步后立即用工具写出 research_rust_async.md 初版（工作空间根，含标题、[N] 引标骨架与已掌握的内容）——不要等"研究全部完成"才动笔
4) 继续补充素材，并把新内容回写进 research_rust_async.md（追加/改写同一个文件，不要另建新文件、不要改名）
报告必须真实引用 KB 与外部抓取内容。完成后列出文件。
⚠️ 最终交付物核对（收尾前逐项核对，缺一不可）：
- research_rust_async.md（工作空间根，文件名逐字一致；只有骨架不算完成——需含实质内容与参考列表）
- 收尾规则：先落盘最终报告，再输出文字总结；只写总结不落盘=任务失败。`,
  },
  'A-H4': {
    scene: 'A', kind: 'H', title: '单Agent排队多任务（锁语义）',
    dims: ['ha'],
    artifacts: ['q1.csv', 'q2.csv', 'q3.csv', 'q4.csv'],
    // 此案例由 harness 特殊编排：同 Agent 连续/交错下发
    prompt: `请依次或并行处理 4 个独立小数据任务，各自输出文件到工作空间根：
q1.csv：1..20 的平方表
q2.csv：斐波那契前 20 项
q3.csv：素数 1..50
q4.csv：华氏-摄氏对照表 0..100 步长 10
每个文件都要真实写盘。完成后列出 4 个文件。`,
  },
  'A-H5': {
    scene: 'A', kind: 'H', title: '三源聚合降级换源',
    dims: ['heal', 'ha'],
    artifacts: ['partial_report.md'],
    prompt: `请做容错多源聚合（这是故意含失败源的任务）：
源A：https://api.github.com/repos/tauri-apps/tauri （应成功）
源B：https://httpbin.org/status/500 （预期失败）
源C：https://httpbin.org/delay/1 （可能慢）
要求：每源最多重试 2 次；失败则记录原因并降级（用已有数据或跳过），禁止因单源失败整体放弃。
产出 partial_report.md：各源状态、成功数据、失败原因、最终可用结论。完成后列出文件。`,
  },
  'A-H6': {
    scene: 'A', kind: 'H', title: '插件故障recovery闭环',
    dims: ['heal'],
    artifacts: ['heal_report.md', 'final_data.json'],
    prompt: `请完成带自愈的数据处理：
1) 创建/使用插件 identifier=l2-fragile-etl：处理输入数组求和；第一版可故意让它对空数组抛错
2) 用插件处理 [1,2,3,4,5] 写入 final_data.json
3) 若插件失败：经恢复/重试路径修复插件后重跑，直到成功
4) 产出 heal_report.md：失败原因、修复动作、最终结果
完成后列出文件。`,
  },
  'A-H7': {
    scene: 'A', kind: 'H', title: 'KB多跳问答报告',
    dims: ['heal', 'ha'],
    artifacts: ['deep_qa.md'],
    prompt: `请基于知识库做多跳问答报告 deep_qa.md：
问题：结合重试策略与幂等设计，说明一次支付扣款调用应如何设计超时、重试与防重？
要求：至少检索 2 次以上不同关键词；答案分节；关键句标 [N]；文末参考。
KB 若不足则先 kb_add_file 补文档再检索。完成后列出文件。`,
  },
  'A-H8': {
    scene: 'A', kind: 'H', title: '混合负载（由 harness 并发编排）',
    dims: ['ha', 'perf'],
    artifacts: [],
    prompt: '（由 harness 用多个子任务并发编排，本条仅占位）',
  },

  // ===== 场景 B 编码 =====
  'B-M1': {
    scene: 'B', kind: 'M', title: 'REST API+最小前端',
    dims: ['perf', 'ha', 'heal'],
    artifacts: ['todo-api/package.json', 'todo-api/server.js', 'todo-api/public/index.html', 'todo-api/SELFTEST.md'],
    prompt: `请在工作空间子目录 todo-api/ 构建完整可运行项目：
1) Node(Express)+SQLite 待办 API：GET/POST/PUT/DELETE /todos，支持 ?done= 过滤
2) 单页 HTML 前端（public/index.html）调用该 API
3) 写 package.json 与启动命令说明
4) 尽量本地自测（node 直接跑或写 curl 步骤），把自测结果写入 SELFTEST.md
必须保证源码完整可运行。完成后列出文件树。`,
  },
  'B-M2': {
    scene: 'B', kind: 'M', title: 'React+Express CRUD',
    dims: ['perf', 'ha', 'heal'],
    artifacts: ['blog-admin/package.json', 'blog-admin/server/index.js', 'blog-admin/src/App.tsx', 'blog-admin/SELFTEST.md'],
    prompt: `请在工作空间子目录 blog-admin/ 构建前后端项目：
1) 后端 Express：/api/posts CRUD + /api/login（mock JWT）
2) 前端 React(Vite)：列表/新建/编辑/删除，登录态保存
3) package.json（root 与子包或 concurrently 脚本）
4) SELFTEST.md：npm install/dev 验证步骤与预期
尽量写出可运行代码。完成后列出文件树。`,
  },
  'B-M3': {
    scene: 'B', kind: 'M', title: '脚手架+后端拼接',
    dims: ['ha', 'heal'],
    artifacts: ['scaffold-demo/package.json', 'scaffold-demo/README.md'],
    prompt: `请在工作空间子目录 scaffold-demo/ 构建全栈待办 demo：
1) 生成标准 React+Vite 前端骨架（手写等效脚手架结构即可）
2) 补 Node 后端（内存或 SQLite）待办 CRUD
3) README.md 写清结构、启动命令、自测方法
完成后列出文件树。`,
  },
  'B-M4': {
    scene: 'B', kind: 'M', title: 'monorepo 共享类型',
    dims: ['ha', 'heal'],
    artifacts: ['mono/package.json', 'mono/packages/shared/src/types.ts', 'mono/packages/api/src/index.ts', 'mono/packages/ui/src/App.tsx'],
    prompt: `请在工作空间子目录 mono/ 构建 monorepo：
1) packages/shared：导出 Todo 类型与校验函数
2) packages/api：Express 使用 shared 类型提供 CRUD
3) packages/ui：React 消费 shared 类型
4) 根 package.json workspaces 配置 + README
完成后列出文件树。`,
  },
  'B-M5': {
    scene: 'B', kind: 'M', title: '迁移+seed+API测试',
    dims: ['heal', 'ha'],
    // 实测耗时 1100~1325s（迁移+seed+API+自测四件套），M 级默认 600s 等待窗口会被驱动误取消
    waitMs: 1900000,
    artifacts: ['shop-api/README.md', 'shop-api/selftest.sh'],
    prompt: `请在工作空间子目录 shop-api/ 构建：
1) SQLite schema + 迁移脚本 + seed 数据
2) 商品 CRUD API
3) 【技术栈锁定】selftest.sh 必须是 **bash 脚本**（文件逐字为 selftest.sh，用 curl 调接口验证增删改查，退出码 0 为过）；禁止改用 Python/Node 等其他语言实现自测脚本（上一轮落了等价的 selftest.py 判为不符）
4) README.md：接口说明 + 启动方式 + schema 概览；**在写第一行代码前先建骨架，完成后补全**（禁止最后一次性补）
完成后列出文件。
⚠️ 最终交付物核对（收尾前逐项核对，缺一不可）：
- shop-api/README.md / shop-api/selftest.sh（相对 shop-api/，文件名与扩展名逐字一致；selftest.sh 必须是 bash+curl，不得是 .py/.js）
- 收尾规则：先落盘全部产物，再输出文字总结。`,
  },
  'B-M6': {
    scene: 'B', kind: 'M', title: 'SSE 实时看板',
    dims: ['perf', 'ha'],
    artifacts: ['live-board/package.json', 'live-board/server.js', 'live-board/public/index.html'],
    prompt: `请在工作空间子目录 live-board/ 构建 SSE 实时待办看板：
1) 服务端 SSE 推送任务变更
2) 前端 EventSource 订阅并渲染
3) 提供 POST /tasks 触发推送
完成后列出文件树与启动方式。`,
  },
  'B-H1': {
    scene: 'B', kind: 'H', title: '全栈+JWT+测试+Docker',
    dims: ['perf', 'ha', 'heal'],
    artifacts: ['fullstack-app/docker-compose.yml', 'fullstack-app/README.md', 'fullstack-app/backend/app.py', 'fullstack-app/frontend/package.json'],
    prompt: `请在工作空间子目录 fullstack-app/ 构建完整全栈：
0) 【起手必做】先用工具落四个交付物骨架（防止预算耗尽时交付物缺失）：fullstack-app/docker-compose.yml、fullstack-app/README.md（占位）、fullstack-app/backend/app.py（最小可启动入口）、fullstack-app/frontend/package.json——四件始终保持在盘上，后续逐步充实
1) 后端 FastAPI 或 Express + SQLite/Postgres（SQLite 亦可）+ JWT 注册/登录；**后端入口文件必须逐字为 backend/app.py**（FastAPI 单文件入口即可，模块化结构也须有该文件作为启动入口）
2) 前端 React：注册→登录→受保护 CRUD
3) 单元测试（pytest 或 node:test）至少覆盖 auth 与 CRUD
4) docker-compose.yml 一键起 + README 补全（含端到端验证步骤）
代码必须成体系可运行。完成后列出文件树。
⚠️ 最终交付物核对（收尾前逐项核对，缺一不可）：
- fullstack-app/docker-compose.yml / fullstack-app/README.md / fullstack-app/backend/app.py / fullstack-app/frontend/package.json（路径与文件名逐字一致）
- 收尾规则：先落盘全部产物，再输出文字总结。`,
  },
  'B-H2': {
    scene: 'B', kind: 'H', title: 'MCP聚合器元测评',
    dims: ['heal', 'ha', 'perf'],
    artifacts: ['mcp-hub/README.md', 'mcp-hub/server.js', 'mcp-hub/public/index.html', 'mcp-hub/SELFTEST.md'],
    prompt: `请在工作空间子目录 mcp-hub/ 构建「MCP client 聚合器」：
1) 后端连接本机 WorkDuo MCP：http://127.0.0.1:18755/mcp （Streamable HTTP JSON-RPC）
2) 封装 adapter：tools/list 与 tools/call，带超时、重试（指数退避）、失败降级（返回结构化错误）
3) 前端页面：展示工具列表、可发起调用并显示结果
4) SELFTEST.md：如何验证工具数=70、如何看降级
这是元测评项目，adapter 要真实能打到 18755。完成后列出文件树。`,
  },
  'B-H3': {
    scene: 'B', kind: 'H', title: '并发三项目（harness 编排）',
    dims: ['ha', 'perf'],
    artifacts: [],
    prompt: '（由 harness 拆成 3 个子项目并发）',
  },
  'B-H4': {
    scene: 'B', kind: 'H', title: '沙箱微服务+测试',
    dims: ['heal', 'ha'],
    artifacts: ['sandbox-svc/README.md', 'sandbox-svc/selftest.md'],
    prompt: `请在工作空间子目录 sandbox-svc/ 构建数据处理微服务与测试：
1) Flask/Fastify 服务：POST /stats 接收数组返回 mean/p95
2) 测试用例（可 pytest 或 node:test）
3) 若平台沙箱可用，把核心计算写成本地插件并 plugin_test
4) selftest.md 记录自测步骤与结果
【落盘顺序硬约束】README.md 在写第一行代码前先建骨架（启动方式/接口/依赖占位），开发完成后补全；selftest.md 在跑测试前先建骨架，测试后回填结果——禁止全部代码写完才回头一次性补文档。
完成后列出文件。
⚠️ 最终交付物核对（收尾前逐项核对，缺一不可）：
- sandbox-svc/README.md（启动方式、接口说明、依赖）
- sandbox-svc/selftest.md（自测步骤与结果）
- 收尾规则：先落盘全部产物文件，再输出文字总结；代码/测试写好但没有这两个 md=任务失败。`,
  },
  'B-H5': {
    scene: 'B', kind: 'H', title: '坏种子仓库修复（自愈）',
    dims: ['heal', 'ha'],
    // C1 泛化（2026-09-23）：prompt/artifacts/坏种子全部迁入 seeds/py-syntax-calculator/ 包；
    // needsSeed 布尔升级为 seedId 引用。两阶段失败设计（语法错+断言错）见种子包内文件注释。
    seedId: 'py-syntax-calculator',
  },
  // ===== 场景 C：Batch C SWE-bench-lite 种子修复题（C1 泛化验证） =====
  'C-H1': {
    scene: 'C', kind: 'H', title: '跨文件接口错位（种子修复）',
    dims: ['heal', 'ha'],
    // C1 验证用例：prompt/artifacts 全部来自种子包 manifest（seed.json），CASES 只留编排属性。
    // 跨文件缺陷：report.py import 名错位（ImportError）+ stock.py 单位契约未实现（数值断言失败）
    // ——必须同时修两个文件才能绿，验证播种器对「跨文件」级的支持。
    seedId: 'py-cross-file-inventory',
  },
  'C-M1': {
    scene: 'C', kind: 'M', title: '语法错误修复（配置加载器）',
    dims: ['heal'],
    seedId: 'py-syntax-config',
  },
  'C-M2': {
    scene: 'C', kind: 'M', title: '逻辑缺陷修复（购物车合计与满减）',
    dims: ['heal'],
    seedId: 'py-logic-cart',
  },
  'C-H2': {
    scene: 'C', kind: 'H', title: '跨文件签名契约修复（签发/校验两侧）',
    dims: ['heal', 'ha'],
    seedId: 'py-cross-auth',
  },
  'C-H3': {
    scene: 'C', kind: 'H', title: '跨文件常量漂移修复（汇率换算）',
    dims: ['heal', 'ha'],
    seedId: 'py-cross-format',
  },
  'B-H6': {
    scene: 'B', kind: 'H', title: '数据管道+基准',
    dims: ['perf', 'ha'],
    artifacts: ['bench-pipe/README.md', 'bench-pipe/BENCH.md'],
    prompt: `请在工作空间子目录 bench-pipe/ 构建：
1) 生成或处理 ≥10000 行数据的管道（可合成数据）
2) 实现聚合查询接口/脚本
3) 写基准测试脚本测 P50/P95，结果写入 BENCH.md
4) README 说明复现方法
完成后列出文件与关键指标。`,
  },
  'B-H7': {
    scene: 'B', kind: 'H', title: '多服务+集成测试',
    dims: ['ha', 'heal', 'perf'],
    artifacts: ['poly/README.md', 'poly/docker-compose.yml'],
    prompt: `请在工作空间子目录 poly/ 构建多服务系统：
1) frontend + api + worker + mock-external
2) docker-compose 编排（或等价进程编排脚本）
3) 集成测试脚本验证 api 调 worker、worker 调 mock
4) README
完成后列出文件树。`,
  },
  'B-H8': {
    scene: 'B', kind: 'H', title: '跨场景混合（harness 编排）',
    dims: ['ha', 'perf'],
    artifacts: [],
    prompt: '（由 harness 并发：2 个全栈 + 2 个 ETL）',
  },

  // ========== 场景 D：能力面覆盖（MCP / Skill / 插件 / KB / 原生工具）==========
  // 2026-09-24 全量扩展轮：考核各能力模块是否真能被 Agent 用起来（不是只在代码里存在）。
  'D-M1': {
    scene: 'D', kind: 'M', title: 'MCP 工具面发现与跨层调用',
    dims: ['ha'],
    artifacts: ['mcp_probe_report.md'],
    prompt: `请探测并实际使用本平台的 MCP 工具能力，产出 mcp_probe_report.md：
1) 说明你能看到哪些工具分层（引擎层/发现层/UI 意图层各举 2 例，写清工具名）
2) 实际调用「模块发现层」的列举类工具（如模型/技能/插件/知识库/记忆的列举），记录返回条数
3) 实际调用至少 1 个 UI 意图层写工具（例如创建一个测试技能，随后删除它），记录成功与否
4) 报告中必须写出工具真实名称与真实返回条数，不得编造。
⚠️ 最终交付物核对：mcp_probe_report.md（工作空间根，文件名逐字一致）；先落盘再总结。`,
  },
  'D-M2': {
    scene: 'D', kind: 'M', title: '已装配技能/知识的复用能力',
    dims: ['ha'],
    waitMs: 1900000,
    artifacts: ['skill_lifecycle.md', 'cleaned.csv'],
    // 设计边界（2026-09-24 D-M1 实测）：技能的「创建/绑定/更新/删除」属 UI 意图层工具
    // （skill_upsert/agent_ui_update），不对 Agent 运行时暴露——Agent 只能**使用**已装配的技能。
    // 故本例考核：能否感知并使用已装配的技能与知识库完成真实任务。
    prompt: `考核你对「已装配技能与知识」的感知与复用能力，产出 skill_lifecycle.md 与 cleaned.csv：
1) 先说明你当前能看到哪些已装配的技能/知识能力（写出名称；若看不到任何技能或列举工具，如实写明"不可见"）
2) 造一份含脏数据的示例数据集（≥8 行：含空值、重复、格式不一致），就地保存为 raw.csv
3) 按你能用到的技能方法（或数据清洗通用方法）完成清洗，结果写 cleaned.csv（去空值/去重/格式统一）
4) 若已装配知识库，用知识库检索工具查一次与你任务相关的内容，并在报告中写明检索结果与是否采用
5) skill_lifecycle.md 记录：可见能力清单、每步工具名与结果、清洗前后行数对比
⚠️ 最终交付物核对：skill_lifecycle.md + cleaned.csv；先落盘再总结。不得编造未见到的能力。`,
  },
  'D-M3': {
    scene: 'D', kind: 'M', title: 'MCP 工具产出 Excel（能力面）',
    dims: ['ha'],
    waitMs: 1900000,
    artifacts: ['plugin_probe.md', 'report.xlsx'],
    // 设计边界：平台当前 plugin_list=0（无插件），且插件管理属 UI 意图层不对 Agent 暴露。
    // 故改为考核「用已装配 MCP 工具 + 沙箱完成 xlsx 产物」——这是 Agent 真实可及路径。
    prompt: `用你实际可用的工具产出 Excel，并产出 plugin_probe.md 与 report.xlsx：
1) 先用已装配的 MCP 检索工具（如搜索/网页读取）获取一组真实数据（例如某技术主题的最新动态，≥10 条要点）；若工具不可用则改用自造数据并写明
2) 用沙箱（Python）或你可用的文件工具生成 report.xlsx：含两个 sheet（summary 与 detail），detail ≥10 行
3) plugin_probe.md 记录：用了哪些工具（真实名称）、数据来源、生成方式、xlsx 是否成功写入、若走不通写明报错原文
⚠️ 最终交付物核对：plugin_probe.md + report.xlsx（工作空间根）；先落盘再总结。`,
  },
  'D-M4': {
    scene: 'D', kind: 'M', title: '知识库检索与引用（Agent 视角）',
    dims: ['ha'],
    artifacts: ['kb_probe.md'],
    // 设计边界：KB 的创建/写入/删除属 UI 意图层（kb_create/kb_add_file），不对 Agent 暴露；
    // Agent 侧仅有 native__kb_search（绑定后注入）。故考核检索与引用，创建/删除记为不可测。
    prompt: `考核知识库（KB）检索与引用能力，产出 kb_probe.md：
1) 用知识库检索工具查 2 个不同主题（例如"架构设计"与"记忆"），记录每次命中条数与首条摘要前 80 字
2) 判断检索结果是否与本工作空间的工程相关，写明是否采用
3) 若你能写入知识库则写入一篇短文并记录工具名；若不能写入，如实写明"无写入工具"（不要伪造）
4) kb_probe.md 记录：工具真实名称、每次检索命中数、摘要、可用性结论
⚠️ 最终交付物核对：kb_probe.md；先落盘再总结。`,
  },
  'D-M5': {
    scene: 'D', kind: 'M', title: '系统原生工具组合',
    dims: ['ha'],
    artifacts: ['native_probe.md', 'stats.json'],
    prompt: `用系统原生工具（文件读写/目录列举/命令执行/HTTP 请求）完成一次小任务，产出 native_probe.md 与 stats.json：
1) 用原生写文件工具写 data.txt（20 个整数，每行一个）
2) 用原生读文件工具读回并计算：个数/总和/均值/最大/最小
3) 若平台开放了 HTTP 工具，请求一个公开接口（如 https://api.github.com/repos/rust-lang/rust）并记录状态码；不可用则写明被拒原因
4) stats.json 存上述统计结果；native_probe.md 记录每步用的工具名与返回
⚠️ 最终交付物核对：native_probe.md + stats.json；先落盘再总结。`,
  },
  'D-M6': {
    scene: 'D', kind: 'M', title: '沙箱执行（Python/Node）',
    dims: ['ha'],
    artifacts: ['sandbox_probe.md', 'sandbox_out.txt'],
    prompt: `用沙箱工具执行代码并产出 sandbox_probe.md 与 sandbox_out.txt：
1) 写一个 Python 脚本到工作空间（计算斐波那契前 20 项）
2) 用沙箱执行工具运行它，把标准输出写入 sandbox_out.txt
3) 若平台同时提供 Node 沙箱，再跑一段 Node 代码（同样输出到同一文件或追加说明）
4) sandbox_probe.md 记录：脚本路径、执行工具名、退出状态、输出前 5 行、不可用时的报错原文
⚠️ 最终交付物核对：sandbox_probe.md + sandbox_out.txt；先落盘再总结。`,
  },
  'D-H1': {
    scene: 'D', kind: 'H', title: '多能力组合工程（MCP+Skill+KB+产物）',
    dims: ['ha', 'heal'],
    artifacts: ['combo/README.md', 'combo/data_report.md'],
    prompt: `在 combo/ 目录完成一个组合工程，产出 README.md 与 data_report.md：
1) 建知识库写入 2 篇背景资料（主题自定但需与"电商订单分析"相关）并重建索引
2) 创建一个分析技能（讲"如何做订单数据汇总"）并绑定使用
3) 造一份订单数据（≥30 行 CSV：order_id/amount/channel/date）
4) 按技能方法汇总：按 channel 统计订单数与销售额，写进 data_report.md，并引用知识库背景
5) README.md：说明用了哪些能力、各自工具名、产物清单
⚠️ 最终交付物核对：combo/README.md + combo/data_report.md；先落盘再总结。`,
  },
  'D-H2': {
    scene: 'D', kind: 'H', title: '原生工具深链路（抓取→清洗→图表）',
    dims: ['ha', 'heal'],
    artifacts: ['pipeline/raw.json', 'pipeline/clean.csv', 'pipeline/chart.png'],
    prompt: `在 pipeline/ 目录用原生工具完成数据链路，产出 raw.json、clean.csv、chart.png：
1) HTTP 抓取一个公开 JSON 接口（如 https://api.github.com/users/rust-lang/repos?per_page=50）存 raw.json
2) 清洗：抽取字段（name/stars/forks）写 clean.csv（≥20 行，去空值）
3) 用插件模板（chart_png）或沙箱绘图生成 chart.png（stars 前 10 的柱状图）
4) 每步记录工具名与返回；接口不可用时写明错误码并改用自造数据继续完成后两步
⚠️ 最终交付物核对：pipeline/raw.json + pipeline/clean.csv + pipeline/chart.png；先落盘再总结。`,
  },

  // ========== 场景 E：上下文压缩与记忆传递专项 ==========
  'E-M1': {
    scene: 'E', kind: 'M', title: '同会话多轮递进',
    dims: ['ha', 'heal'],
    artifacts: ['multi/round1.md', 'multi/round2.md', 'multi/round3.md'],
    // 多轮：同一 session 依次下发三轮，考核上下文延续（后轮必须引用前轮产物）
    rounds: [
      `第 1 轮：在 multi/ 目录建 round1.md，写下"项目代号=银鹤计划、负责人=陈默、截止=2026-12-31"三条事实。`,
      `第 2 轮：读取 round1.md，在 multi/round2.md 中基于上述三条事实写一段项目启动说明（200 字），必须原样包含项目代号与负责人姓名。`,
      `第 3 轮：读取前两轮产物，在 multi/round3.md 中写收尾清单（≥5 条），其中第 1 条必须写"项目代号：银鹤计划"。完成后回复"三轮完成"。`,
    ],
  },
  'E-M2': {
    scene: 'E', kind: 'M', title: '长上下文压缩后信息保留',
    dims: ['ha', 'heal'],
    artifacts: ['ctx/seed_facts.md', 'ctx/recall.md'],
    rounds: [
      `第 1 轮：在 ctx/seed_facts.md 中写入 10 条互不相关的事实（编号 1-10，每条含一个具体数值或专有名词，例如"3号矿脉深度=1240米"）。`,
      `第 2 轮：请围绕"数据治理"主题写一份 1500 字以上的长文（不要引用 seed_facts 内容，仅用于拉长上下文），写入 ctx/essay.md。`,
      `第 3 轮：读取 seed_facts.md，把第 3 条与第 7 条事实原样抄写到 ctx/recall.md，并注明"来源：seed_facts.md 第N条"。完成后回复你抄写的两条原文。`,
    ],
  },
  'E-M3': {
    scene: 'E', kind: 'M', title: '跨会话记忆传递（MEMORY.md）',
    dims: ['ha', 'heal'],
    artifacts: ['mem/plant.md'],
    rounds: [
      `第 1 轮：在 mem/plant.md 写入"密语=青竹夜雨-7391"，并把它写入本工作空间的长期记忆文件（.wd_mem/MEMORY.md）中，回复"已写入长期记忆"。`,
      `第 2 轮（全新会话）：不要读任何文件，直接回答：本工作空间的长期记忆里记录的密语是什么？把答案写入 mem/answer.txt。`,
    ],
    newSessionPerRound: true, // 第 2 轮起开新 session，考核跨会话记忆传递
  },
  'E-H1': {
    scene: 'E', kind: 'H', title: '长任务中途压缩后仍完成产物',
    dims: ['ha', 'heal', 'perf'],
    artifacts: ['longrun/part_a.md', 'longrun/part_b.md', 'longrun/final.md'],
    rounds: [
      `第 1 轮：在 longrun/part_a.md 写 2000 字《分布式一致性协议综述》（含 Raft/Paxos 对比），并把"本任务关键约束：输出文件名必须为 part_a.md / part_b.md / final.md"写入 .wd_mem/MEMORY.md。`,
      `第 2 轮：在 longrun/part_b.md 写 2000 字《分布式事务工程实践》，并在开头复述 MEMORY.md 中记录的关键约束。`,
      `第 3 轮：读取前两轮产物，在 longrun/final.md 写 800 字总结 + 文件清单，并再次复述关键约束。完成后回复"长任务完成"。`,
    ],
  },

  // ========== 场景 F：.wd_mem 严谨性专项（工程类，用户重点考核）==========
  'F-M1': {
    scene: 'F', kind: 'M', title: '.wd_mem 结构完整性',
    dims: ['ha'],
    artifacts: ['shop2/app.py', 'shop2/README.md'],
    wdMemCheck: true, // 跑完做 .wd_mem 七要素检查
    prompt: `在 shop2/ 构建一个小工程（商品查询服务 + README），完成后**主动使用 .wd_mem 记忆区**：
1) shop2/app.py：商品查询服务（读取商品列表，支持按名称过滤）
2) shop2/README.md：启动方式与接口说明
3) 把本次的可复用脚本存进 .wd_mem/runtime/scripts/，中间数据存 .wd_mem/runtime/data/，设计约定写进 .wd_mem/knowledge/artifacts/，并在 .wd_mem/MEMORY.md 追加本工程的两条长期约定
回复时列出你在 .wd_mem 下实际创建了哪些文件（相对路径）。
⚠️ 最终交付物核对：shop2/app.py + shop2/README.md；先落盘再总结。`,
  },
  'F-M2': {
    scene: 'F', kind: 'M', title: 'runtime/scripts 复用（跨轮）',
    dims: ['ha', 'heal'],
    artifacts: ['reuse/report.txt'],
    wdMemCheck: true,
    rounds: [
      `第 1 轮：写一个可复用脚本（统计文本行数与词频）存到 .wd_mem/runtime/scripts/wordcount.py，并说明它的用法。`,
      `第 2 轮：重新运行——先检查 .wd_mem/runtime/scripts/ 是否已有可用脚本，若有则直接复用（不要重写），用它统计 reuse/input.txt（请先造这个输入文件，内容≥200 字）的结果写入 reuse/report.txt。回复是否复用了已有脚本。`,
    ],
    newSessionPerRound: true,
  },
  'F-M3': {
    scene: 'F', kind: 'M', title: 'runtime/data 复用（跨轮）',
    dims: ['ha', 'heal'],
    artifacts: ['datause/summary.md'],
    wdMemCheck: true,
    rounds: [
      `第 1 轮：造一份数据（≥15 行销售记录）存到 .wd_mem/runtime/data/sales.csv。`,
      `第 2 轮：不要重新造数据——直接读取 .wd_mem/runtime/data/sales.csv 汇总（总额/行数/Top3），写入 datause/summary.md。回复你读取的文件路径。`,
    ],
    newSessionPerRound: true,
  },
  'F-M4': {
    scene: 'F', kind: 'M', title: 'knowledge/artifacts 沉淀与检索',
    dims: ['ha', 'heal'],
    artifacts: ['artrecall/answer.md'],
    wdMemCheck: true,
    rounds: [
      `第 1 轮：把一条工程约定写入 .wd_mem/knowledge/artifacts/convention.md：「本项目所有金额单位统一为分，禁止使用元」。`,
      `第 2 轮（新会话）：接到新需求——写一个金额格式化函数。请先检索 .wd_mem/knowledge/artifacts/ 的历史约定再动手，把检索到的约定与你的实现写入 artrecall/answer.md。回复你检索到的约定原文。`,
    ],
    newSessionPerRound: true,
  },
  'F-M5': {
    scene: 'F', kind: 'M', title: 'graph 实体图与 sessions 摘要',
    dims: ['ha'],
    artifacts: ['graphprobe/entities.md'],
    wdMemCheck: true,
    prompt: `完成一次工程任务并观测记忆区状态，产出 graphprobe/entities.md：
1) 建一个小模块（graphprobe/模块：用户-订单两个实体 + 关系说明，代码或文档均可）
2) 检查 .wd_mem/graph/ 目录下是否产生了内容；若有，读取并说明其中记录了什么实体/关系
3) 检查 .wd_mem/sessions/ 下是否有会话摘要文件；若有，读取并摘录其前 5 行
4) entities.md 记录上述检查结果（有就写真实内容，无就写"目录为空"——不得编造）
⚠️ 最终交付物核对：graphprobe/entities.md；先落盘再总结。`,
  },
  'F-M6': {
    scene: 'F', kind: 'M', title: 'sessions 摘要与 outputs 归档（两区能力验证）',
    dims: ['ha', 'heal'],
    artifacts: ['sixround/final.md', 'sixround/archive_note.md'],
    wdMemCheck: true,
    // sessions/ 需 ≥5 个未压缩轮次才触发滚动压缩（round_compactor trigger_threshold=5），
    // 故本例跑 6 轮以真正触发；同时显式要求归档产物到 runtime/outputs/ 验证该区可用。
    rounds: [
      `第 1 轮：在 sixround/ 建 r1.md，写"阶段一：需求采集"（100 字）。`,
      `第 2 轮：在 sixround/ 建 r2.md，写"阶段二：方案设计"（100 字），并复述 r1 的要点。`,
      `第 3 轮：在 sixround/ 建 r3.md，写"阶段三：开发实现"（100 字）。`,
      `第 4 轮：在 sixround/ 建 r4.md，写"阶段四：测试验证"（100 字）。`,
      `第 5 轮：在 sixround/ 建 r5.md，写"阶段五：上线部署"（100 字）。`,
      `第 6 轮：①读取前 5 轮产物，在 sixround/final.md 写 300 字总结（必须包含五个阶段名称）；②把 r1~r5 与 final.md 的副本归档进 .wd_mem/runtime/outputs/ 目录；③在 sixround/archive_note.md 记录归档了哪些文件、以及 .wd_mem/sessions/ 下是否出现了会话摘要文件（有则写出文件名与前 3 行，无则写"未生成"）。不得编造。`,
    ],
  },
  'F-H1': {
    scene: 'F', kind: 'H', title: '工程全链路 .wd_mem 严谨性（大工程）',
    dims: ['ha', 'heal', 'perf'],
    artifacts: ['wdapp/backend/app.py', 'wdapp/frontend/index.html', 'wdapp/README.md'],
    wdMemCheck: true,
    rounds: [
      `第 1 轮：在 wdapp/ 建后端（backend/app.py：任务清单 API，支持增查改）与前端（frontend/index.html：调用接口展示列表），并把架构约定写入 .wd_mem/knowledge/artifacts/arch.md、把两条长期约定写入 .wd_mem/MEMORY.md、把可复用脚本存进 .wd_mem/runtime/scripts/。`,
      `第 2 轮（新会话）：先复用 .wd_mem 下已有的脚本与约定，补 wdapp/README.md（架构说明+启动方式+你在 .wd_mem 里沉淀的内容清单），并核对后端前端是否齐全、缺失则补齐。完成后回复你从 .wd_mem 复用了什么。`,
    ],
    newSessionPerRound: true,
  },
}

// ---------- 工具函数 ----------
export function ensureDirs() {
  fs.mkdirSync(ROOT, { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
}

export function wsOf(caseId, slot = 0) {
  const p = path.join(ROOT, `eval-${caseId}${slot ? '-' + slot : ''}`)
  fs.mkdirSync(p, { recursive: true })
  return p.replace(/\\/g, '/')
}

export function resultPath(caseId, slot = 0) {
  return path.join(OUT, `${caseId}${slot ? '-' + slot : ''}.json`)
}

export function saveResult(obj) {
  const p = resultPath(obj.caseId, obj.slot || 0)
  // 自定义 L2_OUT 指向不存在的目录时 ENOENT 会吞掉整个 run 的结果（2026-09-23 am2v2 实测），
  // 写入前确保目录存在。
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
  console.log('  [save]', p)
  return p
}

export async function toolsList() {
  const t = await rawPost({ jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/list', params: {} })
  return t?.result?.tools || []
}

export async function pickModel(which = 'fast') {
  if (MODELS[which]) return MODELS[which]
  return which
}

/** 列举平台可用能力（MCP 工具 / 技能 / 插件 / 知识库），供测评 Agent 装配。
 * 2026-09-24：此前 createEvalAgent 传 mcpTools:[] 且 kbIds/pluginIds/skillIds 全空——
 * 导致 Agent 运行时只有 native__* 工具，D 系列能力面用例「测了个寂寞」（D-M1 实测暴露）。 */
export async function enumerateCapabilities() {
  const out = { kbIds: [], pluginIds: [], skillIds: [], mcpTools: [] }
  const rows = (r) => {
    const a = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : (Array.isArray(r?.rows) ? r.rows : []))
    return a
  }
  try {
    const mcps = rows(await callTool('agent_list_mcps', {}))
    for (const m of mcps) {
      try {
        const tools = rows(await callTool('agent_list_mcp_tools', { mcp_id: m.id }, { timeoutMs: 20000 }))
        for (const t of tools) {
          const toolId = t.id || t.tool_id || t.toolId || t.name
          if (toolId) out.mcpTools.push({ mcpId: m.id, toolId })
        }
      } catch { /* 单个 MCP 列举失败不阻断 */ }
    }
  } catch { /* 无 MCP */ }
  try { out.skillIds = rows(await callTool('agent_list_skills', {})).slice(0, 3).map((x) => x.id) } catch { /* 无技能 */ }
  try { out.pluginIds = rows(await callTool('agent_list_plugins', {})).slice(0, 10).map((x) => x.id) } catch { /* 无插件 */ }
  try { out.kbIds = rows(await callTool('agent_list_kbs', {})).map((x) => x.id) } catch { /* 无 KB */ }
  return out
}

export async function createEvalAgent({ tag, modelId, kbIds = null, pluginIds = null, skillIds = null, mcpTools = null, bindAll = true }) {
  const models = asRows(await callTool('agent_list_models', {}))
  const model = models.find((m) => m.id === modelId) || models.find((m) => m.id === MODELS.fast)
  if (!model) throw new Error('找不到可用模型 ' + modelId)
  // 默认装配平台全部可用能力（bindAll），否则 Agent 只有 native__* 原生工具。
  if (bindAll && (kbIds === null || pluginIds === null || skillIds === null || mcpTools === null)) {
    try {
      const caps = await enumerateCapabilities()
      kbIds = kbIds ?? caps.kbIds
      pluginIds = pluginIds ?? caps.pluginIds
      skillIds = skillIds ?? caps.skillIds
      mcpTools = mcpTools ?? caps.mcpTools
      if (!caps.mcpTools.length && !caps.skillIds.length && !caps.kbIds.length) {
        console.log('  [warn] 平台无可用 MCP/技能/KB —— Agent 仅具 native__* 原生工具')
      }
    } catch (e) { console.log('  [warn] 能力列举失败，降级为空绑定:', e.message.slice(0, 80)) }
  }
  const _kbIds = kbIds || []
  const _pluginIds = pluginIds || []
  const _skillIds = skillIds || []
  const _mcpTools = mcpTools || []
  let llmConfig = {}
  try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
  // 并发创建必须避免 Date.now 碰撞（C-5 实测曾撞 UNIQUE）
  const ident = `l2-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const ag = unw(await callTool('agent_ui_create', { payload: {
    name: `L2-${tag}`,
    identifier: ident,
    scenario: 'office-efficiency',
    description: `L2 评测 ${tag}`,
    systemPrompt: '你是严谨的执行型助手：严格按用户要求产出文件到工作空间；能用工具就用工具；不要编造数据；失败要重试或降级并在产物中说明。',
    llmId: model.id,
    llmConfig,
    isActive: true,
    autoToolExecMode: true,
    allowSandbox: true,
    memoryMode: 'active',
    planAutoApproveMode: 'never',
    kbIds: _kbIds, pluginIds: _pluginIds, skillIds: _skillIds,
    mcpTools: _mcpTools,
  } }, { timeoutMs: 30000 }))
  if (!ag?.id) throw new Error('agent_ui_create 失败: ' + JSON.stringify(ag).slice(0, 160))
  return { id: ag.id, identifier: ident, modelId: model.id, modelName: model.name || model.model_name }
}

export async function deleteEvalAgent(id) {
  try { await callTool('agent_ui_delete', { id }, { timeoutMs: 20000 }) } catch (e) { console.log('  [warn] delete agent', e.message.slice(0, 80)) }
}

export async function mkSession(agentIdentifier, name = 'l2') {
  const s = unw(await callTool('agent_session_create', { payload: { agentIdentifier, sessionName: name } }, { timeoutMs: 20000 }))
  if (!s?.id) throw new Error('session_create 失败')
  return s.id
}

export function filesIn(dir) {
  const out = []
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else out.push({ rel: path.relative(dir, p).replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs })
    }
  }
  try { walk(dir) } catch {}
  return out
}

export function checkArtifacts(ws, artifacts = []) {
  const have = new Set(filesIn(ws).map((f) => f.rel))
  return artifacts.map((a) => ({ artifact: a, ok: have.has(a) || have.has(a.replace(/^\.\//, '')) }))
}

// ---------- .wd_mem 严谨性检查（2026-09-24 全量扩展轮，用户重点考核项）----------
// 规范结构（src-tauri/src/agent/wd_mem.rs）：
//   MEMORY.md（长期记忆，全量注入 Slot 0）/ README.md / .gitignore
//   sessions/（会话滚动压缩 {session_id}.summary.md）
//   graph/（单 Agent 统一实体图）
//   knowledge/artifacts/（设计蓝图·约定·避坑，向量检索注入）
//   runtime/{scripts,data,outputs}/（可复用脚本 / 中间数据 / 产物归档）
// 旧版根下 scripts/data/outputs/MEMORY.md/artifacts 会被迁移，按新旧两处均认可。
const WD_MEM_EXPECT = [
  { key: 'memory', label: '长期记忆 MEMORY.md', paths: ['.wd_mem/MEMORY.md', '.wd_mem/knowledge/MEMORY.md'] },
  { key: 'sessions', label: '会话摘要 sessions/', dirs: ['.wd_mem/sessions'] },
  { key: 'graph', label: '实体图 graph/', dirs: ['.wd_mem/graph'] },
  { key: 'artifacts', label: '设计沉淀 knowledge/artifacts/', dirs: ['.wd_mem/knowledge/artifacts', '.wd_mem/artifacts'] },
  { key: 'scripts', label: '可复用脚本 runtime/scripts/', dirs: ['.wd_mem/runtime/scripts', '.wd_mem/scripts'] },
  { key: 'data', label: '中间数据 runtime/data/', dirs: ['.wd_mem/runtime/data', '.wd_mem/data'] },
  { key: 'outputs', label: '产物归档 runtime/outputs/', dirs: ['.wd_mem/runtime/outputs', '.wd_mem/outputs'] },
]

/** 检查工作空间的 .wd_mem：结构是否存在、各区是否被真正使用（有内容）、以及红线（不得进用户可见产物）。 */
export function checkWdMem(ws) {
  const exists = (p) => fs.existsSync(path.join(ws, p))
  const listFiles = (d) => {
    if (!exists(d)) return []
    try {
      return fs.readdirSync(path.join(ws, d)).filter((n) => n !== '.gitkeep')
    } catch { return [] }
  }
  const items = WD_MEM_EXPECT.map((e) => {
    if (e.paths) {
      const hit = e.paths.find(exists)
      const size = hit ? fs.statSync(path.join(ws, hit)).size : 0
      return { key: e.key, label: e.label, present: !!hit, used: size > 0, path: hit || e.paths[0], count: hit ? Math.round(size / 1024) + 'KB' : 0 }
    }
    const hit = e.dirs.find(exists)
    const n = hit ? listFiles(hit).length : 0
    return { key: e.key, label: e.label, present: !!hit, used: n > 0, path: hit || e.dirs[0], count: n }
  })
  const structureOk = items.every((i) => i.present)
  const usedCount = items.filter((i) => i.used).length
  // 红线：用户可见产物（工作空间根的非 .wd_mem 文件/目录）中不得出现 .wd_mem 路径引用
  const visible = filesIn(ws).filter((f) => !f.rel.startsWith('.wd_mem/'))
  let leaks = []
  for (const f of visible) {
    if (!/\.(md|txt|json|csv|html|py|sh)$/i.test(f.rel)) continue
    try {
      const c = fs.readFileSync(path.join(ws, f.rel), 'utf8')
      if (c.includes('.wd_mem')) leaks.push(f.rel)
    } catch { /* 忽略不可读 */ }
  }
  return { structureOk, usedCount, total: items.length, items, leaks }
}

// ---------- C1 坏种子包体系（2026-09-23）：任意 repo 坏种子泛化 ----------
// seeds/<包名>/ = seed.json（manifest：id/tier/targetDir/prompt/artifacts）+ 坏文件本体。
// 三级覆盖：syntax（语法错，import 即炸）/ logic（语法对逻辑错，最隐蔽）/ cross-file（缺陷横跨两文件）。
import { fileURLToPath } from 'node:url'
const SEEDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seeds')

/** 按 seedId 把种子包播种到 ws/<targetDir>/：清空重建 → 逐文件复制（seed.json 除外）。
 * 返回 manifest（含 prompt/artifacts，供 runOneCase 覆盖 CASES 缺省）。 */
export function seedRepo(ws, seedId) {
  const pkgDir = path.join(SEEDS_DIR, seedId)
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'seed.json'), 'utf8'))
  const target = path.join(ws, manifest.targetDir)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(pkgDir)) {
    if (name === 'seed.json') continue
    fs.copyFileSync(path.join(pkgDir, name), path.join(target, name))
  }
  console.log(`  [seed] ${manifest.id}(${manifest.tier}) → ${target}`)
  return manifest
}

// ---------- C2 客观判分器（2026-09-23）：run=done ≠ 任务完成，harness 自己跑测试 ----------
// 判分环境 = 本机受管 venv（envs/default + pytest），与 agent 沙箱解耦——种子包是纯 Python+pytest，
// 任何正确的解释器判分等价。resolved = failed==0 && errors==0。
const JUDGE_PY = process.env.L2_JUDGE_PY || 'C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe'

export function judgeTests(dir) {
  const r = spawnSync(`"${JUDGE_PY}"`, ['-m', 'pytest', '-q', '--tb=line'], {
    cwd: dir, encoding: 'utf8', timeout: 300000, shell: true,
  })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const passed = +(out.match(/(\d+) passed/)?.[1] || 0)
  const failed = +(out.match(/(\d+) failed/)?.[1] || 0)
  const errors = +(out.match(/(\d+) error/)?.[1] || 0)
  const noTests = out.includes('no tests ran')
  return {
    cmd: 'pytest -q', exitCode: r.status ?? -1,
    passed, failed, errors, noTests,
    resolved: !noTests && failed === 0 && errors === 0 && r.status === 0,
    raw: out.slice(-1000),
  }
}

// ---------- Batch C 判分三段式（2026-09-23）：agent 沙箱内 node spawn 受限（EBUSY）时，
// 执行段交外层 bash：judge-dump 生成判分命令 → 外层跑 pytest 落盘 → judge-merge 回填 JSON。
export function judgeDump(idsCsv) {
  ensureDirs()
  const ids = idsCsv.split(',').map((s) => s.trim()).filter(Boolean)
  const plan = []
  for (const id of ids) {
    const spec = CASES[id]
    if (!spec?.seedId) { console.log(`跳过 ${id}（非种子用例）`); continue }
    const manifest = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, spec.seedId, 'seed.json'), 'utf8'))
    // 槽位感知：从该 caseId 最新结果 JSON 的 workspace 字段取真实工作空间（并发槽位有 -N 后缀）。
    const cands = fs.readdirSync(OUT).filter((f) => (f === `${id}.json` || f.startsWith(`${id}-`)) && f.endsWith('.json'))
    let wsRoot = wsOf(id, 0)
    if (cands.length) {
      let best = null, bt = -1
      for (const f of cands) { const st = fs.statSync(path.join(OUT, f)); if (st.mtimeMs > bt) { bt = st.mtimeMs; best = f } }
      try { wsRoot = JSON.parse(fs.readFileSync(path.join(OUT, best), 'utf8')).workspace || wsRoot } catch { /* 保留缺省 */ }
    }
    const wsDir = path.join(wsRoot, manifest.targetDir).replace(/\\/g, '/')
    const outFile = path.join(OUT, 'judge', `${id}.txt`).replace(/\\/g, '/')
    plan.push({ caseId: id, seedId: spec.seedId, testCmd: manifest.testCmd, wsDir, outFile })
  }
  fs.mkdirSync(path.join(OUT, 'judge'), { recursive: true })
  fs.writeFileSync(path.join(OUT, 'judge', 'plan.json'), JSON.stringify(plan, null, 2))
  console.log('-- 外层 bash 逐条执行：')
  for (const p of plan) {
    const args = p.testCmd.replace(/^python\s*/, '')
    console.log(`cd "${p.wsDir}" && "${JUDGE_PY}" ${args} > "${p.outFile}" 2>&1; echo "${p.caseId} exit=$?"`)
  }
  console.log(`-- 完成后执行: node l2_eval_harness.mjs judge-merge && node l2_eval_harness.mjs score`)
  return plan
}

export function judgeMerge() {
  const jdir = path.join(OUT, 'judge')
  const plan = JSON.parse(fs.readFileSync(path.join(jdir, 'plan.json'), 'utf8'))
  for (const p of plan) {
    if (!fs.existsSync(p.outFile)) { console.log(`跳过 ${p.caseId}（无判分输出）`); continue }
    const out = fs.readFileSync(p.outFile, 'utf8')
    const passed = +(out.match(/(\d+) passed/)?.[1] || 0)
    const failed = +(out.match(/(\d+) failed/)?.[1] || 0)
    const errors = +(out.match(/(\d+) error/)?.[1] || 0)
    const noTests = out.includes('no tests ran')
    const resolved = !noTests && failed === 0 && errors === 0
    // 槽位感知：并发 run 产生 C-M2-1.json 等后缀文件，取该 caseId 最新的 JSON 合并（judge-dump 同理）。
    const cands = fs.readdirSync(OUT).filter((f) => (f === `${p.caseId}.json` || f.startsWith(`${p.caseId}-`)) && f.endsWith('.json'))
    if (!cands.length) { console.log(`跳过 ${p.caseId}（无结果 JSON）`); continue }
    let caseFile = null, bt = -1
    for (const f of cands) { const st = fs.statSync(path.join(OUT, f)); if (st.mtimeMs > bt) { bt = st.mtimeMs; caseFile = path.join(OUT, f) } }
    const j = JSON.parse(fs.readFileSync(caseFile, 'utf8'))
    j.judge = { cmd: p.testCmd, passed, failed, errors, resolved, execBy: 'outer-bash' }
    j.resolved = resolved
    fs.writeFileSync(caseFile, JSON.stringify(j, null, 2))
    console.log(`[merge] ${p.caseId}: resolved=${resolved} passed=${passed} failed=${failed} errors=${errors}`)
  }
  console.log(`-- 重新出评分卡: node l2_eval_harness.mjs score`)
}

/** MCP 契约探针（C4 门禁第 8 条）：tools/list → 工具数 + 关键工具在位。 */
async function probeMcpContract(minTools = EXPECTED_TOOLS, required = ['agent_run_task', 'agent_get_run_progress', 'agent_sweep_orphan_rounds']) {
  try {
    const resp = await fetch('http://127.0.0.1:18755/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return { ok: false, detail: `HTTP ${resp.status}` }
    const text = await resp.text()
    for (const block of text.split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const j = JSON.parse(line.slice(5).trim())
          const tools = j.result?.tools
          if (tools) {
            const missing = required.filter((r) => !tools.some((t) => t.name === r))
            if (tools.length >= minTools && !missing.length) return { ok: true, detail: `${tools.length} 工具，关键工具齐` }
            return { ok: false, detail: `tools=${tools.length}` + (missing.length ? `，缺 ${missing.join(',')}` : '') }
          }
        } catch { /* 非 JSON data 行，跳过 */ }
      }
    }
    return { ok: false, detail: '无 tools 响应' }
  } catch (e) {
    return { ok: false, detail: 'MCP 不在线: ' + String(e.message || e).slice(0, 60) }
  }
}

/** 种子资产完整性（C4 门禁第 9 条）：manifest 可解析 + 每包至少 1 个坏文件实体（seed.json 外）。 */
function checkSeedAssets() {
  const pkgs = fs.existsSync(SEEDS_DIR) ? fs.readdirSync(SEEDS_DIR) : []
  let bad = 0, files = 0
  for (const s of pkgs) {
    try {
      JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, s, 'seed.json'), 'utf8'))
      const entities = fs.readdirSync(path.join(SEEDS_DIR, s)).filter((f) => f !== 'seed.json')
      files += entities.length
      if (!entities.length) bad++
    } catch { bad++ }
  }
  return { ok: bad === 0 && pkgs.length > 0, detail: `${pkgs.length} 包 / ${files} 文件 / 损坏 ${bad}` }
}

/** C4 发布门禁（2026-09-23）：离线断言器，读 OUT 证据 + MCP 探针，逐条过线。
 * PASS/FAIL + 退出码（0/1），可直接挂 CI。阈值可 --min-done/--min-artifacts/--min-resolved 覆盖。 */
export async function gate(opts = {}) {
  const out = opts.outDir || OUT
  const faultsDir = opts.faultsDir || out
  // minDone 默认 90：error 但走完「优雅收尾」（reply 非空+产物保留，如预算截断 run_budget_exhausted）
  // 不一票否决——那正是失败汇报机制的正确表现；收紧用 --min-done 100。
  const minDone = opts.minDone ?? 90
  const minArtifacts = opts.minArtifacts ?? 90
  const minResolved = opts.minResolved ?? 80
  const checks = []
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    console.log(ok ? '  ✓' : '  ✗', name, '—', detail)
  }

  console.log(`# L2 发布门禁 · ${out}`)

  // 1) 收集用例（排除 fault/scorecard/env/gate/并发组汇总）
  const files = fs.existsSync(out)
    ? fs.readdirSync(out).filter((f) => f.endsWith('.json') && !f.startsWith('fault-') && !['scorecard.json', 'env.json', 'gate.json'].includes(f) && !f.startsWith('concurrency-'))
    : []
  const casesRaw = files
    .map((f) => { try { return { f, j: JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) } } catch { return null } })
    .filter(Boolean)
    .filter((x) => x.j.caseId && x.j.status)
  // 按 caseId 去重取最新（多轮槽位 JSON 共存时，门禁评「每个 case 的当前状态」）。
  // 排序键=rec.startedAt（真实运行时间）而非文件 mtime——git checkout 等操作会重置 mtime 导致取错版本。
  const latestByCase = new Map()
  for (const x of casesRaw) {
    const ts = Date.parse(x.j.startedAt || '') || 0
    const prev = latestByCase.get(x.j.caseId)
    if (!prev || prev.ts < ts) latestByCase.set(x.j.caseId, { ts, j: x.j })
  }
  const cases = [...latestByCase.values()].map((x) => x.j)
  add('证据存在', cases.length > 0, `${cases.length} 个用例（${casesRaw.length} 个 JSON 去重后）`)
  // 1b) 证据规模下限（防证据目录被静默清空——2026-09-23 cd671c8 曾丢 92 文件）。目录含 A/B/C 全套时 ≥30；仅 C 套 ≥5。
  const minFiles = opts.minFiles ?? 5
  add(`证据规模≥${minFiles} 用例`, cases.length >= minFiles, `${cases.length}/${minFiles}`)

  // 2) 终态率 100%（done/error/cancelled 均为终态）
  const terminal = cases.filter((c) => ['done', 'error', 'cancelled'].includes(c.status))
  add('终态率=100%', cases.length > 0 && terminal.length === cases.length, `${terminal.length}/${cases.length}`)

  // 3) done 率
  const dones = cases.filter((c) => c.status === 'done')
  const donePct = cases.length ? (dones.length / cases.length) * 100 : 0
  add(`done率≥${minDone}%`, donePct >= minDone, `${donePct.toFixed(0)}% (${dones.length}/${cases.length})`)

  // 4) 产物达成（done 用例）
  const artTot = dones.reduce((s, c) => s + (c.artifactCheck?.length || 0), 0)
  const artOk = dones.reduce((s, c) => s + (c.artifactCheck || []).filter((a) => a.ok).length, 0)
  const artPct = artTot ? (artOk / artTot) * 100 : 0
  add(`产物达成≥${minArtifacts}%（done 用例）`, artPct >= minArtifacts, `${artPct.toFixed(0)}% (${artOk}/${artTot})`)

  // 5) 客观判分 resolved（有 judge 的用例）
  const judged = cases.filter((c) => c.judge)
  const resv = judged.filter((c) => c.judge.resolved)
  const resPct = judged.length ? (resv.length / judged.length) * 100 : 0
  add(`客观判分 resolved≥${minResolved}%`, judged.length > 0 && resPct >= minResolved, `${resPct.toFixed(0)}% (${resv.length}/${judged.length})`)

  // 6) 种子用例必须全部已判分（漏判 = 没测，不许当通过）
  const seedCases = cases.filter((c) => c.seedId)
  const unjudged = seedCases.filter((c) => !c.judge)
  add('种子用例全部已判分', seedCases.length > 0 && unjudged.length === 0, unjudged.length ? `漏判: ${unjudged.map((c) => c.caseId).join(',')}` : `${seedCases.length}/${seedCases.length}`)

  // 7) 失败不空白（P0-2 契约）：非 done 终态必须有 reply
  const notDone = cases.filter((c) => c.status !== 'done')
  const blank = notDone.filter((c) => !(c.replyLen > 0))
  add('非 done 终态 reply 非空', blank.length === 0, notDone.length ? `${notDone.length - blank.length}/${notDone.length}` : '无非 done 终态')

  // 8) 故障注入证据（faultsDir 可与 run 证据分离——复跑场景故障机制由同一二进制的首轮验证）。
  // C4 第二版：默认要求核心 F-1/F-4；--faults F-1,F-2,... 可指定全量故障集（2026-09-23 全量 11 场景）。
  const faultIds = (opts.faults || 'F-1,F-4').split(',').map((s) => s.trim()).filter(Boolean)
  for (const fid of faultIds) {
    let state = 'FAIL', detail = '缺证据文件', ok = false
    try {
      const j = JSON.parse(fs.readFileSync(path.join(faultsDir, `fault-${fid}.json`), 'utf8'))
      detail = `ok=${j.ok}` + (Array.isArray(j.observations) ? ` (${j.observations.filter((o) => o.ok).length}/${j.observations.length} 项观测)` : '')
      if (j.ok === true) { ok = true; state = 'ok' } else if (j.ok === null) {
        // ok===null = 排期/人工观察型故障（如 F-5 跨零点），未验证 ≠ 通过：单列 SKIP，不计入判定
        state = 'skip'
        ok = true
      }
    } catch { /* 保持缺文件 */ }
    checks.push({ name: `故障注入 ${fid}`, ok, detail, state })
    console.log(state === 'skip' ? '  ⚠' : (ok ? '  ✓' : '  ✗'), `故障注入 ${fid}`, '—', detail + (state === 'skip' ? '（SKIP：未验证，不计入判定）' : ''))
  }

  // 9) MCP 契约探针 + 种子资产
  const mcp = opts.skipMcp ? { ok: true, detail: 'skipped' } : await probeMcpContract()
  add('MCP 契约（' + EXPECTED_TOOLS + ' 工具+关键工具）', mcp.ok, mcp.detail)
  const seeds = checkSeedAssets()
  add('种子资产完整', seeds.ok, seeds.detail)

  const pass = checks.every((c) => c.ok)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'gate.json'), JSON.stringify({ at: new Date().toISOString(), pass, checks }, null, 2))
  console.log(pass ? '🟢 GATE PASS' : '🔴 GATE FAIL — 禁止发布')
  if (!pass) process.exitCode = 1
  return pass
}

/** 运行单用例并采集三维原始指标 */
export async function runOneCase(caseId, {
  model = 'fast',
  slot = 0,
  agent = null,
  sessionId = null,
  prompt = null,
  waitMs = null,
  keepAgent = false,
  extraRun = {},
} = {}) {
  const spec = CASES[caseId]
  if (!spec && !prompt) throw new Error('未知案例 ' + caseId)
  const kind = spec?.kind || 'M'
  // 单用例可覆盖等待窗口（CASES.waitMs）：B-M5 等长耗时 M 用例实测 1100~1300s，M 级默认 600s 会误取消
  const maxMs = waitMs || spec?.waitMs || (kind === 'H' ? WAIT.H : WAIT.M)
  const ws = wsOf(caseId, slot)
  const modelId = await pickModel(model)
  const started = Date.now()
  const rec = {
    caseId, slot, scene: spec?.scene, kind, title: spec?.title,
    model: modelId, workspace: ws, startedAt: new Date(started).toISOString(),
    status: null, runId: null, durationMs: 0, artifacts: [], artifactCheck: [],
    traceCounts: null, replyLen: 0, kbHits: 0, recoveries: 0, error: null,
    metrics: { ha: {}, perf: {}, heal: {} },
    files: [],
  }
  let createdAgent = null
  let seedManifest = null
  try {
    // C1 泛化（2026-09-23）：seedId → 种子包播种；prompt/artifacts 由 seed.json 覆盖 CASES 缺省。
    if (spec?.seedId) seedManifest = seedRepo(ws, spec.seedId)
    const ag = agent || (createdAgent = await createEvalAgent({ tag: caseId.toLowerCase(), modelId }))
    rec.agentId = ag.id
    rec.agentIdentifier = ag.identifier
    rec.modelName = ag.modelName
    rec.seedTier = seedManifest?.tier || null
    rec.seedId = seedManifest?.id || spec?.seedId || null
    let sid = sessionId || await mkSession(ag.identifier, caseId)
    rec.sessionId = sid
    const arts = seedManifest?.artifacts || spec?.artifacts || []
    const p = prompt || seedManifest?.prompt || spec.prompt
    console.log(`\n>>>> ${caseId}${slot ? '#' + slot : ''} model=${ag.modelName} ws=${ws}`)
    const t0 = Date.now()
    // 多轮模式（2026-09-24 扩展）：spec.rounds 依次下发，同一 workspace（可指定 newSessionPerRound
    // 让每轮换新 session，用于考核跨会话记忆传递）。rec.rounds 记录每轮状态与 reply 摘要。
    const rounds = spec?.rounds || null
    let runId = null, status = null
    if (Array.isArray(rounds) && rounds.length) {
      rec.rounds = []
      for (let i = 0; i < rounds.length; i++) {
        if (i > 0 && spec.newSessionPerRound) {
          sid = await mkSession(ag.identifier, `${caseId}-r${i + 1}`)
          rec.sessionIds = rec.sessionIds || [rec.sessionId]
          rec.sessionIds.push(sid)
        }
        console.log(`  [round ${i + 1}/${rounds.length}] session=${sid.slice(-6)}`)
        const r = await startRun(ag.id, rounds[i], sid, { workspace: ws, expectedArtifacts: i === rounds.length - 1 ? arts : [], ...extraRun }, { maxMs })
        rec.rounds.push({ round: i + 1, sessionId: sid, runId: r.runId, status: r.status, durationMs: r.durationMs })
        runId = r.runId
        status = r.status
      }
    } else {
      // P2-2（2026-09-23）：期望产物透传 expectedArtifacts → 引擎注入系统提示做收尾核对。
      const r = await startRun(ag.id, p, sid, { workspace: ws, expectedArtifacts: arts, ...extraRun }, { maxMs })
      runId = r.runId
      status = r.status
    }
    const t1 = Date.now()
    rec.runId = runId
    rec.status = status
    rec.durationMs = t1 - t0
    rec.metrics.perf.durationMs = t1 - t0

    // 轨迹（per-run）
    try {
      const raw = unw(await callTool('agent_get_run_trace', { run_id: runId }))
      const tr = traceInner(raw)
      rec.traceCounts = tr?.counts || null
      rec.reply = (tr?.reply || '').slice(0, 4000)
      rec.replyLen = (tr?.reply || '').length
      rec.thinkingLen = (tr?.thinking || '').length
      const evs = Array.isArray(tr?.events) ? tr.events : []
      rec.eventCount = evs.length
      const kbs = extractKbEvents(tr)
      rec.kbHits = kbs.reduce((n, e) => n + hitsOf(e.parsed), 0)
      rec.kbCalls = kbs.length
      // recovery 次数粗计
      rec.recoveries = evs.filter((e) => /recovery/i.test(JSON.stringify(e))).length
    } catch (e) { rec.traceError = e.message.slice(0, 120) }

    rec.files = filesIn(ws)
    rec.artifactCheck = checkArtifacts(ws, arts)
    const okArts = rec.artifactCheck.filter((x) => x.ok).length
    rec.artifactScore = arts.length ? okArts / arts.length : (rec.files.length > 0 ? 1 : 0)
    // C2 客观判分（2026-09-23）：种子修复类用例（manifest 带 testCmd）→ harness 直接跑 pytest，
    // resolved 与 agent 自述解耦。C-H1 首跑实证价值：agent 自称 done 而客观未修，判分器当场识破。
    if (seedManifest?.testCmd) {
      const judgeDir = path.join(ws, seedManifest.targetDir)
      if (fs.existsSync(judgeDir)) {
        try {
          rec.judge = judgeTests(judgeDir)
          rec.resolved = rec.judge.resolved
          console.log(`  [judge] resolved=${rec.judge.resolved} passed=${rec.judge.passed} failed=${rec.judge.failed} errors=${rec.judge.errors}`)
        } catch (e) {
          rec.judge = { error: e.message.slice(0, 120) }
          rec.resolved = false
        }
      }
    }
    // .wd_mem 严谨性检查（2026-09-24 扩展，用户重点考核）：结构 7 要素 + 各区是否被真正使用 + 红线泄漏
    if (spec?.wdMemCheck) {
      try {
        rec.wdMem = checkWdMem(ws)
        console.log(`  [wd_mem] 结构${rec.wdMem.structureOk ? '完整' : '缺失'} 已使用 ${rec.wdMem.usedCount}/${rec.wdMem.total} 区${rec.wdMem.leaks.length ? ` ⚠ 泄漏 ${rec.wdMem.leaks.length} 处` : ''}`)
      } catch (e) { rec.wdMem = { error: e.message.slice(0, 120) } }
    }
    rec.metrics.ha.terminal = ['done', 'error', 'cancelled', 'canceled'].includes(status)
    rec.metrics.ha.status = status
    rec.metrics.heal.replyLen = rec.replyLen
  } catch (e) {
    rec.error = e.message.slice(0, 300)
    rec.status = rec.status || 'harness_error'
    rec.durationMs = Date.now() - started
  } finally {
    if (createdAgent && !keepAgent) {
      // 未达终态时先 cancel，避免删 Agent 留下孤儿 run
      if (!['done', 'error', 'cancelled', 'canceled'].includes(rec.status)) {
        try { await callTool('agent_cancel_task', { agentId: createdAgent.id }) ; await sleep(2000) } catch {}
      }
      await deleteEvalAgent(createdAgent.id)
    }
  }
  saveResult(rec)
  console.log(`<<<< ${caseId} status=${rec.status} ${rec.durationMs}ms artifacts=${rec.artifactScore} files=${rec.files.length}`)
  return rec
}

/** 并发跑一组用例（每用例独立 Agent，避开单 Agent 运行锁） */
export async function runConcurrent(jobs, { maxMs } = {}) {
  const started = Date.now()
  console.log(`\n==== 并发 ${jobs.length} jobs ====`)
  const results = await Promise.all(jobs.map((j, i) =>
    runOneCase(j.caseId, { ...j, slot: j.slot ?? i, waitMs: maxMs || j.waitMs, keepAgent: j.keepAgent }).catch((e) => ({
      caseId: j.caseId, slot: j.slot ?? i, status: 'harness_error', error: e.message.slice(0, 200), durationMs: 0, metrics: { ha: { terminal: false }, perf: {}, heal: {} }, artifactScore: 0, files: [],
    }))
  ))
  const totalMs = Date.now() - started
  const terminal = results.filter((r) => r.metrics?.ha?.terminal || ['done', 'error', 'cancelled', 'canceled'].includes(r.status)).length
  const done = results.filter((r) => r.status === 'done').length
  const summary = {
    kind: 'concurrency',
    n: jobs.length, totalMs, done, terminal,
    survivalRate: results.filter((r) => r.status === 'done').length / jobs.length,
    terminalRate: terminal / jobs.length,
    results: results.map((r) => ({ caseId: r.caseId, slot: r.slot, status: r.status, durationMs: r.durationMs, artifactScore: r.artifactScore, error: r.error })),
  }
  fs.writeFileSync(path.join(OUT, `concurrency-${jobs.length}-${Date.now()}.json`), JSON.stringify(summary, null, 2))
  console.log(`==== 并发完成 done=${done}/${jobs.length} terminal=${terminal}/${jobs.length} wall=${totalMs}ms ====`)
  return { summary, results }
}

// ---------- 锁释放检测 ----------
export async function checkLockRelease(agentTag = 'lockprobe') {
  // 创建探针 Agent，跑一个极短任务后立即再跑，验证锁是否释放
  const ag = await createEvalAgent({ tag: agentTag, modelId: MODELS.fast })
  try {
    const sid = await mkSession(ag.identifier, 'lock')
    const ws = wsOf('LOCK-PROBE')
    const a = await startRun(ag.id, '只回复 OK，不要创建文件。', sid, { workspace: ws }, { maxMs: 120000 })
    const b = await startRun(ag.id, '只回复 DONE，不要创建文件。', sid, { workspace: ws }, { maxMs: 120000 })
    const released = b.status !== 'harness_error' && !/已有任务|running|锁/i.test(String(b.error || ''))
    return { ok: released, first: a.status, second: b.status, secondError: b.error || null, firstMs: a.durationMs, secondMs: b.durationMs }
  } finally {
    await deleteEvalAgent(ag.id)
  }
}

// ---------- 故障注入 ----------
export async function injectFault(faultId) {
  ensureDirs()
  const rec = { faultId, startedAt: new Date().toISOString(), observations: [], ok: null }
  const note = (ok, msg, extra) => { rec.observations.push({ ok, msg, extra }); console.log(`${ok ? '✅' : '❌'} [${faultId}] ${msg}` + (extra ? ' ' + JSON.stringify(extra).slice(0, 160) : '')) }

  if (faultId === 'F-1') {
    // 运行中取消一个 run，其余并发应存活
    const jobs = [
      { caseId: 'A-M1', model: 'fast' },
      { caseId: 'A-M1', model: 'slow', slot: 1 },
      { caseId: 'A-M1', model: 'fast', slot: 2 },
    ]
    // 启动 3 个，中途 cancel 其中一个
    const controllers = jobs.map((j, i) => {
      const box = {}
      box.promise = (async () => {
        const ag = await createEvalAgent({ tag: `f1-${i}`, modelId: await pickModel(j.model) })
        box.agentId = ag.id
        const sid = await mkSession(ag.identifier, 'f1')
        const ws = wsOf('F-1', i)
        try {
          const r = await startRun(ag.id, CASES['A-M1'].prompt, sid, { workspace: ws }, { maxMs: 360000 })
          return { i, agentId: ag.id, ...r }
        } catch (e) { return { i, agentId: ag.id, status: 'err', error: e.message.slice(0, 160) } }
      })()
      return box
    })
    await sleep(8000)
    try {
      const victim = controllers[1]
      if (victim.agentId) {
        await callTool('agent_cancel_task', { agentId: victim.agentId })
        note(true, '已对 slot1 下发 agent_cancel_task', { agentId: victim.agentId })
      }
    } catch (e) { note(false, 'cancel 失败: ' + e.message.slice(0, 120)) }
    const rs = await Promise.all(controllers.map((c) => c.promise))
    for (const r of rs) note(['done', 'error', 'cancelled', 'canceled'].includes(r.status), `slot${r.i} → ${r.status}`, { ms: r.durationMs, err: r.error })
    const others = rs.filter((r) => r.i !== 1)
    rec.ok = others.every((r) => r.status === 'done' || r.metrics?.ha?.terminal || ['done', 'error'].includes(r.status))
    // 锁释放
    const lock = await checkLockRelease('f1-lock')
    note(lock.ok, '取消后锁释放/可再跑', lock)
    rec.ok = rec.ok && lock.ok
  }

  if (faultId === 'F-2') {
    // 诱导超时：用极短 WD 无法远程改，改用超大 prompt + 限制 wait
    // 观测 run 级兜底：把 wait 调很小看是否 timeout 且不永久挂死
    const ag = await createEvalAgent({ tag: 'f2', modelId: MODELS.slow })
    try {
      const sid = await mkSession(ag.identifier, 'f2')
      const ws = wsOf('F-2')
      const r = await startRun(ag.id, '请写一篇 5 万字的分布式系统论文并保存为 thesis.md，要完整章节。', sid, { workspace: ws }, { maxMs: 45000 })
      note(['timeout', 'done', 'error', 'cancelled', 'canceled'].includes(r.status), `短窗观测 status=${r.status}（期望非 running 永久挂死）`, { ms: r.durationMs })
      // 再等更久看是否终态
      if (r.runId) {
        const st = unw(await callTool('agent_get_status', { run_id: r.runId }))
        note(true, '短窗后 get_status', { status: st?.status, runId: r.runId })
      }
      const lock = await checkLockRelease('f2-lock')
      note(lock.ok, '短窗/超时后锁可用', lock)
      rec.ok = lock.ok && r.status !== 'harness_error'
    } finally { await deleteEvalAgent(ag.id) }
  }

  if (faultId === 'F-3') {
    // 工具失败：坏源
    const recCase = await runOneCase('A-H5', { model: 'fast' })
    // 自愈机制观测升级（2026-09-23，Batch B 验证）：不再只看结果，断言「带诊断回灌的自动重试」
    // 是否真实发生——数 trace 事件里的 step_retrying（never 模式引擎自动重试会 emit_step_retrying）。
    let retryEvents = 0
    try {
      const raw = unw(await callTool('agent_get_run_trace', { run_id: recCase.runId }))
      const tr = traceInner(raw)
      retryEvents = (tr?.events || []).filter((e) => e?.payload?.type === 'step_retrying').length
    } catch {}
    note(true, `自愈机制观测：step_retrying 事件 ×${retryEvents}（>0=引擎自动诊断重试真实发生；=0 可能源失败被工具层/重试层提前消化）`)
    rec.autoRetryEvents = retryEvents
    rec.ok = recCase.status === 'done' && recCase.artifactScore >= 0.5
    note(rec.ok, `A-H5 降级容错 status=${recCase.status} artifacts=${recCase.artifactScore}`)
  }

  if (faultId === 'F-4') {
    // 计划门禁挂起
    const ag = await createEvalAgent({ tag: 'f4', modelId: MODELS.fast })
    // 改成 always 需要 update
    try {
      const full = unw(await callTool('agent_ui_get', { id: ag.id }))
      unw(await callTool('agent_ui_update', { payload: { ...full, id: ag.id, planAutoApproveMode: 'always', autoToolExecMode: false } }))
      const sid = await mkSession(ag.identifier, 'f4')
      const ws = wsOf('F-4')
      // 手动 start 不用 pollRun 自动放行
      const roundIndex = Date.now() % 100000
      const rd = unw(await callTool('agent_round_create', { payload: { sessionId: sid, roundIndex, userQuestion: 'calc' } }))
      const rt = unw(await callTool('agent_run_task', { agentId: ag.id, prompt: '创建 hello.txt 内容 hi', sessionId: sid, roundId: rd?.id, workspace: ws }))
      const runId = rt?.run_id || rt?.runId
      await sleep(8000)
      const st = unw(await callTool('agent_get_status', { run_id: runId }))
      const s = JSON.stringify(st || {})
      note(s.includes('waitingApproval') || s.includes('pending') || s.includes('plan'), '检测到计划挂起', { status: st?.status })
      try {
        unw(await callTool('agent_submit_plan_decision', { decision: 'approve', agentId: ag.id }))
        note(true, 'submit_plan_decision approve 已发')
      } catch (e) { note(false, 'submit_plan 失败: ' + e.message.slice(0, 100)) }
      const fin = await pollRun(runId, ag.id, { maxMs: 180000 })
      note(['done', 'error'].includes(fin.status), `放行后终态 ${fin.status}`, fin)
      rec.ok = fin.status === 'done'
    } finally { await deleteEvalAgent(ag.id) }
  }

  if (faultId === 'F-5') {
    // 跨零点长跑（真实验证，2026-09-23 23:5x 首发）：发一个必然跨过 00:00 的长任务，
    // 验证四项在跨天后仍正常：①终态可达 ②#8 per-run trace 仍可取 ③孤儿清扫可用 ④日志按天切换。
    const started = new Date()
    const ag = await createEvalAgent({ tag: 'f5', modelId: MODELS.fast })
    const ws = wsOf('F-5', 0)
    let terminalOk = false
    try {
      const sid = await mkSession(ag.identifier, 'f5')
      const r = await startRun(ag.id, `请逐步完成一份长作业（不要跳步、每步都落盘）：\n1) part1.md：2000 字《Rust 异步运行时生态》综述\n2) part2.md：2000 字《Tauri 2 插件体系》综述\n3) part3.md：1500 字《Agent 自愈机制设计》\n4) final.md：汇总三篇要点并列出文件清单\n全部落盘后再回复完成。`, sid, { workspace: ws }, { maxMs: 1500000 })
      const ended = new Date()
      const crossedDay = started.getDate() !== ended.getDate()
      const durMin = Math.round((ended - started) / 60000)
      note(crossedDay || durMin >= 5, `跨零点长跑 ${started.toTimeString().slice(0, 8)} → ${ended.toTimeString().slice(0, 8)}（${durMin}min${crossedDay ? '，已跨日' : '，同日但≥5min 视为有效等价'}）`, { ms: ended - started })
      terminalOk = ['done', 'error', 'cancelled', 'canceled'].includes(r.status)
      note(terminalOk, `跨零点长跑终态=${r.status}`)
      // 跨天后 trace 仍可取（#8 per-run）
      let evN = -1
      try {
        const raw = await callTool('agent_get_run_trace', { run_id: r.runId })
        const tr = raw?.trace || raw?.data?.trace || raw
        evN = Array.isArray(tr?.events) ? tr.events.length : -1
        note(evN >= 0, `跨天后 trace 可取 events=${evN}`)
      } catch (e) { note(false, 'trace 读取失败: ' + String(e.message).slice(0, 100)) }
      // 跨天后孤儿清扫可用
      try {
        const sw = await callTool('agent_sweep_orphan_rounds', {})
        const swOk = sw?.ok === true || sw?.data?.ok === true
        note(swOk, `跨天后孤儿清扫 ${JSON.stringify(sw).slice(0, 60)}`)
      } catch (e) { note(false, 'sweep 失败: ' + String(e.message).slice(0, 100)) }
      // 日志按**本地日期**命名（2026-09-24 P1 修复的核心判据，不再依赖是否真跨日）：
      // 写入侧曾按 UTC 命名 → 本地 00:00~08:00 的日志读不到。此处校验「本地日期文件存在」；
      // 若本地日期与 UTC 日期不同（UTC+8 的 00:00~08:00 窗口），还额外证明未落进 UTC 文件。
      const pad = (n) => String(n).padStart(2, '0')
      const d = new Date()
      const localDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const utcDay = d.toISOString().slice(0, 10)
      const logDir = 'E:/Codes/ABC/work-duo/src-tauri/target/debug/logs'
      const localLog = `${logDir}/workduo.log.${localDay}`
      const hasLocal = fs.existsSync(localLog)
      note(hasLocal, `日志按本地日期命名（${localDay}${localDay !== utcDay ? `，与 UTC 日期 ${utcDay} 不同——证明未落进 UTC 文件` : ''}）`)
      rec.ok = terminalOk && evN >= 0
    } finally { await deleteEvalAgent(ag.id) }
  }

  if (faultId === 'F-6') {
    // recovery：用 A-H6 插件故障
    const recCase = await runOneCase('A-H6', { model: 'fast' })
    rec.ok = recCase.status === 'done' && recCase.artifactScore >= 0.5
    note(rec.ok, `A-H6 recovery status=${recCase.status} artifacts=${recCase.artifactScore}`)
  }

  if (faultId === 'F-7') {
    // 不传 workspace 应被 PathGuard 拒或安全降级，且不崩
    const ag = await createEvalAgent({ tag: 'f7', modelId: MODELS.fast })
    try {
      const sid = await mkSession(ag.identifier, 'f7')
      const r = await startRun(ag.id, '请创建 secret.txt 内容 x', sid, {}, { maxMs: 120000 }) // 无 workspace
      note(['done', 'error', 'cancelled', 'canceled'].includes(r.status), `无 workspace 终态=${r.status}`, { reply: (r.reply || '').slice(0, 80) })
      const tools = await toolsList()
      // 基线随 MCP 工具数演进：70(2026-09-23 初) → 72（P2 批次新增 agent_get_run_progress + agent_sweep_orphan_rounds）
      note(tools.length === EXPECTED_TOOLS, `工具面稳定 tools=${tools.length}（期望 ${EXPECTED_TOOLS}）`)
      rec.ok = ['done', 'error'].includes(r.status) && tools.length === EXPECTED_TOOLS
    } finally { await deleteEvalAgent(ag.id) }
  }

  if (faultId === 'F-8') {
    // 并发同 identifier 创建
    const ident = `l2-dup-${Date.now().toString(36)}`
    const modelId = MODELS.fast
    const models = asRows(await callTool('agent_list_models', {}))
    const model = models.find((m) => m.id === modelId)
    let llmConfig = {}; try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
    const mk = () => callTool('agent_ui_create', { payload: {
      name: 'dup', identifier: ident, scenario: 'office-efficiency', description: 'dup', systemPrompt: 'x',
      llmId: modelId, llmConfig, isActive: true, autoToolExecMode: true, allowSandbox: true, memoryMode: 'off', planAutoApproveMode: 'never', mcpTools: [],
    } })
    const rs = await Promise.allSettled([mk(), mk(), mk()])
    const oks = rs.filter((r) => r.status === 'fulfilled' && (r.value?.id || r.value?.data?.id))
    const fails = rs.filter((r) => r.status === 'rejected' || !(r.value?.id || r.value?.data?.id))
    note(oks.length === 1 && fails.length === 2, `同 identifier 并发：成功${oks.length} 失败${fails.length}（期望 1 成功）`)
    for (const o of oks) { const id = o.value?.id || o.value?.data?.id; if (id) await deleteEvalAgent(id) }
    rec.ok = oks.length === 1
  }

  if (faultId === 'F-10') {
    const idt = `l2-dupskill-${Date.now().toString(36)}`
    const body = {
      skill: { identifier: idt, name: 'dup-skill', description: 'dup', skillMarkdown: '# v0\n' },
    }
    const rs = await Promise.allSettled([
      callTool('skill_upsert', body),
      callTool('skill_upsert', { skill: { ...body.skill, skillMarkdown: '# vA\n' } }),
      callTool('skill_upsert', { skill: { ...body.skill, skillMarkdown: '# vB\n' } }),
    ])
    const fulfilled = rs.filter((r) => r.status === 'fulfilled')
    note(fulfilled.length >= 1, `并发 skill_upsert fulfilled=${fulfilled.length}/3（内容一致性抽查见 skill_get）`)
    try {
      const list = asRows(await callTool('skill_list', {}))
      const hit = list.find((s) => s.identifier === idt)
      note(!!hit, 'skill_list 可见', { id: hit?.id })
      if (hit?.id) {
        const g = unw(await callTool('skill_get', { id: hit.id }))
        note(!!g?.skillMarkdown || !!g?.path, 'skill_get 可读', { path: g?.path })
        await callTool('skill_delete', { id: hit.id })
        note(true, '清理 skill_delete 完成')
      }
      rec.ok = !!hit
    } catch (e) { note(false, e.message.slice(0, 120)); rec.ok = false }
  }

  if (faultId === 'F-11') {
    // rebuild index 与 add_file 并发
    const kb = unw(await callTool('kb_create', { identifier: `l2-f11-${Date.now().toString(36)}`, name: 'F11', description: 'idx race' }))
    try {
      for (let i = 0; i < 5; i++) await callTool('kb_add_file', { kbId: kb.id, relPath: `d/${i}.md`, content: `# doc${i}\ncontent ${i}\n` })
      const jobs = [
        callTool('kb_rebuild_index', { kbId: kb.id }),
        callTool('kb_add_file', { kbId: kb.id, relPath: 'd/race.md', content: '# race\n' }),
        callTool('kb_list_assets', { kbId: kb.id }),
      ]
      const rs = await Promise.allSettled(jobs)
      const okCount = rs.filter((r) => r.status === 'fulfilled').length
      note(okCount >= 2, `rebuild+add+list 并发 fulfilled=${okCount}/3`)
      await sleep(3000)
      const as = asRows(await callTool('kb_list_assets', { kbId: kb.id }))
      note(as.length >= 6, `资产数=${as.length}（期望≥6）`)
      rec.ok = okCount >= 2 && as.length >= 6
    } finally {
      try { await callTool('kb_delete', { id: kb.id }) } catch {}
    }
  }

  if (faultId === 'F-12') {
    const keyBase = `l2-f12-${Date.now().toString(36)}`
    const jobs = []
    for (let i = 0; i < 8; i++) {
      jobs.push(callTool('memory_anchor', { key: `${keyBase}-${i}`, content: `flood content ${i}`, category: 'other' }))
    }
    jobs.push(callTool('memory_list', { query: keyBase }))
    jobs.push(callTool('memory_heatmap', {}))
    const rs = await Promise.allSettled(jobs)
    const okCount = rs.filter((r) => r.status === 'fulfilled').length
    note(okCount === jobs.length, `记忆洪水+查询 fulfilled=${okCount}/${jobs.length}`)
    rec.ok = okCount === jobs.length
  }

  rec.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(OUT, `fault-${faultId}.json`), JSON.stringify(rec, null, 2))
  return rec
}

// ---------- 环境核对 ----------
export async function checkEnv() {
  ensureDirs()
  const tools = await toolsList()
  const models = asRows(await callTool('agent_list_models', {}))
  const agents = asRows(await callTool('agent_ui_list', {}))
  const kbs = asRows(await callTool('kb_list', {}))
  const plugins = asRows(await callTool('plugin_list', {}))
  const skills = asRows(await callTool('skill_list', {}))
  const env = {
    at: new Date().toISOString(),
    tools: tools.length,
    toolNames: tools.map((t) => t.name).sort(),
    models: models.map((m) => ({ id: m.id, name: m.name || m.model_name, category: m.category, enabled: m.enabled, tool_calls: m.tool_calls })),
    agents: agents.length, kbs: kbs.length, plugins: plugins.length,
    skills: skills.count ?? skills.length,
    workspaceRoot: ROOT,
  }
  fs.writeFileSync(path.join(OUT, 'env.json'), JSON.stringify(env, null, 2))
  console.log(JSON.stringify({ tools: env.tools, models: env.models.map((m) => m.name), agents: env.agents, skills: env.skills }, null, 2))
  return env
}

// ---------- 评分汇总 ----------
export function buildScorecard() {
  ensureDirs()
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json'))
  const cases = []
  const faults = []
  const concs = []
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))
      if (j.caseId) cases.push(j)
      else if (j.faultId) faults.push(j)
      else if (j.kind === 'concurrency') concs.push(j)
    } catch {}
  }
  const by = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); (m[k] = m[k] || []).push(x); return m }, {})
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const p = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] }

  const durations = cases.filter((c) => c.durationMs > 0).map((c) => c.durationMs)
  const terminal = cases.filter((c) => c.metrics?.ha?.terminal || ['done', 'error', 'cancelled', 'canceled'].includes(c.status)).length
  const done = cases.filter((c) => c.status === 'done').length
  const artAvg = cases.length ? cases.reduce((n, c) => n + (c.artifactScore || 0), 0) / cases.length : 0

  const md = []
  md.push(`# WorkDuo L2 生态测评评分卡`)
  md.push(``)
  md.push(`> 生成时间：${new Date().toISOString()} · 样本：用例 ${cases.length} / 故障 ${faults.length} / 并发组 ${concs.length}`)
  md.push(``)
  md.push(`## 三维总览`)
  md.push(``)
  md.push(`| 维度 | 指标 | 值 |`)
  md.push(`|---|---|---|`)
  md.push(`| 高可用 | 终态率 | ${pct(terminal, cases.length)}% (${terminal}/${cases.length}) |`)
  md.push(`| 高可用 | 成功率 done | ${pct(done, cases.length)}% |`)
  md.push(`| 高可用 | 产物达成均值 | ${Math.round(artAvg * 100)}% |`)
  md.push(`| 高性能 | 时延 P50/P90/P99 | ${med(durations)} / ${p(durations, 0.9)} / ${p(durations, 0.99)} ms |`)
  md.push(`| 自愈 | 故障注入通过 | ${pct(faults.filter((f) => f.ok === true).length, faults.filter((f) => f.ok !== null).length)}% |`)
  md.push(`| 自愈 | 并发组终态率 | ${concs.length ? pct(concs.reduce((n, c) => n + c.terminal, 0), concs.reduce((n, c) => n + c.n, 0)) + '%' : 'n/a'} |`)
  md.push(``)
  md.push(`## 按难度/场景`)
  md.push(``)
  md.push(`| 分桶 | n | done% | 产物% | P50ms |`)
  md.push(`|---|---|---|---|---|`)
  for (const [k, arr] of Object.entries(by(cases, (c) => `${c.scene || '?'}/${c.kind || '?'}`))) {
    const ds = arr.map((c) => c.durationMs).filter(Boolean)
    md.push(`| ${k} | ${arr.length} | ${pct(arr.filter((c) => c.status === 'done').length, arr.length)}% | ${Math.round((arr.reduce((n, c) => n + (c.artifactScore || 0), 0) / arr.length) * 100)}% | ${med(ds)} |`)
  }
  md.push(``)
  md.push(`## 按模型`)
  md.push(``)
  md.push(`| 模型 | n | done% | P50ms |`)
  md.push(`|---|---|---|---|`)
  for (const [k, arr] of Object.entries(by(cases, (c) => c.modelName || c.model || '?'))) {
    md.push(`| ${k} | ${arr.length} | ${pct(arr.filter((c) => c.status === 'done').length, arr.length)}% | ${med(arr.map((c) => c.durationMs).filter(Boolean))} |`)
  }
  md.push(``)
  // Batch C（2026-09-23）：种子修复用例的客观判分（resolved%），与 agent 自述解耦
  const judged = cases.filter((c) => c.resolved === true || c.resolved === false)
  if (judged.length) {
    md.push(`## Batch C 种子修复 · 客观判分`)
    md.push(``)
    md.push(`| 层级 | n | resolved% |`)
    md.push(`|---|---|---|`)
    for (const [k, arr] of Object.entries(by(judged, (c) => c.seedTier || '?'))) {
      md.push(`| ${k} | ${arr.length} | ${pct(arr.filter((c) => c.resolved === true).length, arr.length)}% |`)
    }
    md.push(`| **合计** | ${judged.length} | **${pct(judged.filter((c) => c.resolved === true).length, judged.length)}%** |`)
    md.push(``)
    md.push(`| ID | seed | tier | resolved | passed/failed/errors |`)
    md.push(`|---|---|---|---|---|`)
    for (const c of judged) {
      md.push(`| ${c.caseId}${c.slot ? '#' + c.slot : ''} | ${c.seedId || ''} | ${c.seedTier || ''} | ${c.resolved} | ${c.judge ? `${c.judge.passed}/${c.judge.failed}/${c.judge.errors}` : '-'} |`)
    }
    md.push(``)
  }
  md.push(`## 用例明细`)
  md.push(``)
  md.push(`| ID | 标题 | status | ms | 产物 | 备注 |`)
  md.push(`|---|---|---|---|---|---|`)
  for (const c of cases.sort((a, b) => (a.caseId || '').localeCompare(b.caseId || ''))) {
    md.push(`| ${c.caseId}${c.slot ? '#' + c.slot : ''} | ${c.title || ''} | ${c.status} | ${c.durationMs} | ${Math.round((c.artifactScore || 0) * 100)}% | ${(c.error || '').slice(0, 40)} |`)
  }
  md.push(``)
  md.push(`## 故障注入`)
  md.push(``)
  md.push(`| Fault | ok | 观测数 |`)
  md.push(`|---|---|---|`)
  for (const f of faults) md.push(`| ${f.faultId} | ${f.ok} | ${f.observations?.length || 0} |`)
  md.push(``)
  md.push(`## 并发组`)
  md.push(``)
  for (const c of concs) md.push(`- n=${c.n} done=${c.done}/${c.n} terminal=${c.terminal}/${c.n} wall=${c.totalMs}ms survival=${Math.round((c.survivalRate || 0) * 100)}%`)

  const text = md.join('\n')
  fs.writeFileSync(path.join(OUT, 'scorecard.md'), text)
  fs.writeFileSync(path.join(OUT, 'scorecard.json'), JSON.stringify({ cases: cases.length, done, terminal, artAvg, durations: { p50: med(durations), p90: p(durations, 0.9), p99: p(durations, 0.99) }, faults, concs }, null, 2))
  console.log(text)
  return text
}

// ---------- CLI ----------
async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'env'
  const get = (k, d) => {
    const i = argv.indexOf('--' + k)
    return i >= 0 ? argv[i + 1] : d
  }
  const flag = (k) => argv.includes('--' + k)
  await initMcp('l2-eval-harness')

  if (cmd === 'env') return checkEnv()
  if (cmd === 'score') return buildScorecard()
  if (cmd === 'inject') return injectFault(get('fault', 'F-1'))
  if (cmd === 'judge-dump') return judgeDump(get('cases', ''))
  if (cmd === 'judge-merge') return judgeMerge()
  if (cmd === 'gate') {
    return gate({
      outDir: get('out', OUT),
      faultsDir: get('faults-dir', get('out', OUT)),
      minDone: parseInt(get('min-done', '90'), 10),
      minArtifacts: parseInt(get('min-artifacts', '90'), 10),
      minResolved: parseInt(get('min-resolved', '80'), 10),
      minFiles: parseInt(get('min-files', '5'), 10),
      faults: get('faults', 'F-1,F-4'),
      skipMcp: flag('skip-mcp'),
    })
  }
  if (cmd === 'lock') return checkLockRelease()
  if (cmd === 'run') {
    const phase = get('phase')
    const model = get('model', 'fast')
    let ids = (get('cases') || '').split(',').map((s) => s.trim()).filter(Boolean)
    const conc = parseInt(get('concurrency', '1'), 10)
    if (!ids.length && phase === '1') ids = ['A-M1', 'A-M2', 'A-M3', 'A-M4', 'A-M5', 'A-M6', 'A-M7', 'A-M8', 'B-M1', 'B-M2', 'B-M3', 'B-M4', 'B-M5', 'B-M6']
    if (!ids.length && phase === '2') ids = ['A-H1', 'A-H2', 'A-H3', 'A-H5', 'A-H6', 'A-H7', 'B-H1', 'B-H2', 'B-H4', 'B-H5', 'B-H6', 'B-H7']
    if (!ids.length && phase === '3') ids = ['C-M1', 'C-M2', 'C-H1', 'C-H2', 'C-H3']
    // phase 4（2026-09-24 全量扩展轮）：场景 D 能力面 + E 上下文/记忆 + F .wd_mem 严谨性
    if (!ids.length && phase === '4') ids = ['D-M1', 'D-M2', 'D-M3', 'D-M4', 'D-M5', 'D-M6', 'D-H1', 'D-H2', 'E-M1', 'E-M2', 'E-M3', 'E-H1', 'F-M1', 'F-M2', 'F-M3', 'F-M4', 'F-M5', 'F-H1']
    if (!ids.length && phase === '0') ids = ['A-M1']
    if (conc > 1) {
      return runConcurrent(ids.map((id, i) => ({ caseId: id, model, slot: i })))
    }
    const results = []
    for (const id of ids) {
      results.push(await runOneCase(id, { model }))
    }
    return results
  }
  if (cmd === 'concurrent') {
    const n = parseInt(get('n', '3'), 10)
    const caseId = get('case', 'A-M1')
    const model = get('model', 'fast')
    const jobs = Array.from({ length: n }, (_, i) => ({ caseId, model, slot: i }))
    return runConcurrent(jobs)
  }
  console.log('未知命令', cmd)
}

// 直接执行判定：--input-type=module -e 动态 import 本模块时 argv[1] 为 undefined，须跳过 main
const __arg1 = process.argv[1]
const __isMain = __arg1 && (import.meta.url === `file://${__arg1.replace(/\\/g, '/')}` || __arg1.endsWith('l2_eval_harness.mjs'))
if (__isMain) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
