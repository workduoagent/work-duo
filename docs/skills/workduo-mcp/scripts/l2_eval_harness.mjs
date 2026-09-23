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
    artifacts: ['shop-api/README.md', 'shop-api/selftest.sh'],
    prompt: `请在工作空间子目录 shop-api/ 构建：
1) SQLite schema + 迁移脚本 + seed 数据
2) 商品 CRUD API
3) selftest.sh：用 curl/自测脚本验证增删改查，退出码 0 为过
4) README.md：接口说明 + 启动方式 + schema 概览；**在写第一行代码前先建骨架，完成后补全**（禁止最后一次性补）
完成后列出文件。
⚠️ 最终交付物核对（收尾前逐项核对，缺一不可）：
- shop-api/README.md / shop-api/selftest.sh（相对 shop-api/，文件名逐字一致）
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

export async function createEvalAgent({ tag, modelId, kbIds = [], pluginIds = [], skillIds = [] }) {
  const models = asRows(await callTool('agent_list_models', {}))
  const model = models.find((m) => m.id === modelId) || models.find((m) => m.id === MODELS.fast)
  if (!model) throw new Error('找不到可用模型 ' + modelId)
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
    kbIds, pluginIds, skillIds,
    mcpTools: [],
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
    const wsDir = path.join(wsOf(id, 0), manifest.targetDir).replace(/\\/g, '/')
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
    const caseFile = resultPath(p.caseId, 0)
    const j = JSON.parse(fs.readFileSync(caseFile, 'utf8'))
    j.judge = { cmd: p.testCmd, passed, failed, errors, resolved, execBy: 'outer-bash' }
    j.resolved = resolved
    fs.writeFileSync(caseFile, JSON.stringify(j, null, 2))
    console.log(`[merge] ${p.caseId}: resolved=${resolved} passed=${passed} failed=${failed} errors=${errors}`)
  }
  console.log(`-- 重新出评分卡: node l2_eval_harness.mjs score`)
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
  const maxMs = waitMs || (kind === 'H' ? WAIT.H : WAIT.M)
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
    const sid = sessionId || await mkSession(ag.identifier, caseId)
    rec.sessionId = sid
    const arts = seedManifest?.artifacts || spec?.artifacts || []
    const p = prompt || seedManifest?.prompt || spec.prompt
    console.log(`\n>>>> ${caseId}${slot ? '#' + slot : ''} model=${ag.modelName} ws=${ws}`)
    const t0 = Date.now()
    // P2-2（2026-09-23）：期望产物透传 expectedArtifacts → 引擎注入系统提示做收尾核对。
    const { runId, status } = await startRun(ag.id, p, sid, { workspace: ws, expectedArtifacts: arts, ...extraRun }, { maxMs })
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
    note(true, '跨零点长跑需排期人工观察，本轮跳过（记录为观测项）')
    rec.ok = null
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
      note(tools.length === 70, `工具面稳定 tools=${tools.length}`)
      rec.ok = ['done', 'error'].includes(r.status) && tools.length === 70
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
  if (cmd === 'lock') return checkLockRelease()
  if (cmd === 'run') {
    const phase = get('phase')
    const model = get('model', 'fast')
    let ids = (get('cases') || '').split(',').map((s) => s.trim()).filter(Boolean)
    const conc = parseInt(get('concurrency', '1'), 10)
    if (!ids.length && phase === '1') ids = ['A-M1', 'A-M2', 'A-M3', 'A-M4', 'A-M5', 'A-M6', 'A-M7', 'A-M8', 'B-M1', 'B-M2', 'B-M3', 'B-M4', 'B-M5', 'B-M6']
    if (!ids.length && phase === '2') ids = ['A-H1', 'A-H2', 'A-H3', 'A-H5', 'A-H6', 'A-H7', 'B-H1', 'B-H2', 'B-H4', 'B-H5', 'B-H6', 'B-H7']
    if (!ids.length && phase === '3') ids = ['C-M1', 'C-M2', 'C-H1', 'C-H2', 'C-H3']
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
