#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkDuo Agent 市场 · 软件开发类 → workduo-mcp 全量导入驱动。

阶段：kb → skill → plugin → agent → squad → verify（可 --phase 单跑，默认 all）
- KB/Skill/插件/Agent 全链经 workduo-mcp（127.0.0.1:18755/mcp）落库；
- 小分队（MCP 无 create 工具）经 SQLite 直写三表（agent_squad / agent_squad_member /
  agent_squad_chat_config），字段与前端 squad-mapper upsert 格式一致；
- 全部 id 映射回写 generated-agent-setup-ids.json（幂等：按 identifier 先查后建）。

用法：python import_workduo.py [--phase kb,skill,plugin,agent,squad,verify]
"""
import argparse
import json
import sqlite3
import sys
import time
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / 'assets'
ID_MAP_PATH = HERE.parent / 'generated-agent-setup-ids.json'
MCP = 'http://127.0.0.1:18755/mcp'
LLM_NAME = 'GPT-5.6-Luna'
DB = Path.home() / 'AppData' / 'Roaming' / 'com.workduo' / 'workduo.db'

_now = lambda: int(time.time() * 1000)


def mcp(name, args, quiet=False):
    """调用 workduo-mcp 工具，返回解析后的 JSON（尽力）或原始文本。失败抛 RuntimeError。"""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": args}}).encode('utf-8')
    req = urllib.request.Request(MCP, data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        raise RuntimeError(f'MCP {name} 请求失败: {e}')
    if 'error' in payload:
        raise RuntimeError(f'MCP {name} 错误: {json.dumps(payload["error"], ensure_ascii=False)[:300]}')
    text = ''.join(c.get('text', '') for c in payload['result'].get('content', []))
    try:
        data = json.loads(text)
    except Exception:
        data = text
    if isinstance(data, dict) and data.get('ok') is False:
        raise RuntimeError(f'MCP {name} 业务失败: {text[:300]}')
    if not quiet:
        print(f'  ✓ {name}')
    return data


def unwrap(data):
    """剥 MCP 的 {ok,data}/{rows} 包装，取业务主体。"""
    if isinstance(data, dict):
        if 'data' in data and isinstance(data['data'], (dict, list)):
            return data['data']
        if 'rows' in data:
            return data['rows']
    return data


def load_id_map():
    with open(ID_MAP_PATH, encoding='utf-8') as f:
        return json.load(f)


def save_id_map(m):
    with open(ID_MAP_PATH, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    print(f'  💾 id 映射已更新: {ID_MAP_PATH.name}')


# ============================================================ KB ×5
KB_DEFS = [
    ('kb-eng-standards', '团队工程规范', '前端规范、API 规范、Git 规范、目录约定', 'dev-programming'),
    ('kb-product-prd', '产品需求与验收', 'PRD、用户故事、验收清单、变更记录', 'office-efficiency'),
    ('kb-adr', '架构决策记录', 'ADR、接口契约、时序、数据模型', 'dev-programming'),
    ('kb-test-assets', '测试资产库', '用例、自动化脚本模板、缺陷模式', 'dev-programming'),
    ('kb-pitfalls', '历史缺陷与踩坑', '已知坑、回归清单、事故复盘', 'dev-programming'),
]


def phase_kb(ids):
    existing = {r.get('identifier'): r.get('id') for r in unwrap(mcp('kb_list', '{}', quiet=True)) or []}
    kbs = ids.setdefault('kbs', {})
    for ident, name, desc, scenario in KB_DEFS:
        if existing.get(ident):
            kbs[ident] = existing[ident]
            print(f'  ↷ KB {ident} 已存在 ({existing[ident][:8]})')
            continue
        r = unwrap(mcp('kb_create', {'identifier': ident, 'name': name,
                                     'description': desc, 'scenario': scenario}))
        kb_id = r.get('id') if isinstance(r, dict) else None
        assert kb_id, f'kb_create {ident} 未返回 id: {str(r)[:200]}'
        kbs[ident] = kb_id
        content = (ASSETS / f'{ident}.md').read_text(encoding='utf-8')
        mcp('kb_add_file', {'kbId': kb_id, 'relPath': f'{name}.md', 'content': content}, quiet=True)
        print(f'  ✓ KB {ident} 建库+语料导入 ({kb_id[:8]})')
    save_id_map(ids)


# ============================================================ Skill ×6
SKILL_DEFS = [
    ('skill-eng-standards', '工程规范守卫', '目录、命名、依赖、禁止项检查清单；新代码与文档落盘前自检', 'dev-programming'),
    ('skill-api-contract', '接口契约写作', 'REST/JSON Schema/OpenAPI 片段规范与契约写作', 'dev-programming'),
    ('skill-test-case-design', '测试用例设计', '等价类/边界/场景/失败路径模板', 'dev-programming'),
    ('skill-code-review-checklist', '代码评审清单', '正确性/安全/可维护/性能四维评审清单', 'dev-programming'),
    ('skill-delivery-pack', '交付包组装', '变更说明 + 证据链 + 风险说明结构', 'dev-programming'),
    ('skill-task-breakdown', '任务拆解与验收', '从需求拆到可执行任务与 DoD', 'office-efficiency'),
]


def phase_skill(ids):
    existing = {r.get('identifier'): r.get('id')
                for r in (unwrap(mcp('skill_list', '{}', quiet=True)) or {}).get('rows', [])
                if isinstance(r, dict)}
    skills = ids.setdefault('skills', {})
    for ident, name, desc, scenario in SKILL_DEFS:
        if existing.get(ident):
            skills[ident] = existing[ident]
            print(f'  ↷ Skill {ident} 已存在 ({existing[ident][:8]})')
            continue
        full = (ASSETS / f'{ident}.md').read_text(encoding='utf-8')
        lines = full.splitlines()
        # instruction = 首段引言（> 开头的行拼接），skillMarkdown = 全文
        instruction = ' '.join(l.lstrip('> ').strip() for l in lines if l.startswith('>') and l.strip() != '>')
        payload = {'skill': {'identifier': ident, 'name': name, 'description': desc,
                             'instruction': instruction, 'skillMarkdown': full,
                             'scenario': scenario, 'status': 'enabled'}}
        r = mcp('skill_upsert', payload)
        sid = None
        if isinstance(r, dict):
            d = unwrap(r)
            sid = (d or {}).get('id') if isinstance(d, dict) else None
            if not sid and isinstance(d, list) and d:
                sid = d[0].get('id')
        if not sid:  # 兜底回查
            lst = unwrap(mcp('skill_list', '{}', quiet=True)) or {}
            for row in lst.get('rows', []):
                if row.get('identifier') == ident:
                    sid = row.get('id')
        assert sid, f'skill_upsert {ident} 未获得 id'
        skills[ident] = sid
        print(f'  ✓ Skill {ident} ({sid[:8]})')
    save_id_map(ids)


# ============================================================ 插件 ×13
PLUGIN_DEFS = [
    ('plugin-diff-summary', '差异摘要', 'bun', '扫描 git/diff 文本，输出变更摘要与风险点'),
    ('plugin-ts-typecheck', '类型检查', 'bun', '调项目 typecheck，解析错误成结构化列表'),
    ('plugin-pytest-runner', '测试执行', 'python', '跑 pytest/单测，解析 pass/fail 与失败堆栈'),
    ('plugin-coverage-report', '覆盖率汇总', 'python', '解析 coverage 输出，生成缺口清单'),
    ('plugin-code-stats', '代码规模粗评', 'python', '行数、文件分布、简单热点'),
    ('plugin-md-toc', 'Markdown 目录', 'bun', '生成/校验文档 TOC'),
    ('plugin-changelog-draft', '变更日志草稿', 'bun', '从任务/提交说明拼 changelog 草稿'),
    ('plugin-sql-migrate-check', 'SQL DDL 幂等检查', 'python', '检查 init/updater 双轨与幂等 ALTER 约定'),
    ('plugin-openapi-lint', 'OpenAPI 片段校验', 'python', '校验接口片段字段/命名'),
    ('plugin-test-report-md', '测试报告渲染', 'python', '把 JSON 结果渲染为 Markdown 报告'),
    ('plugin-cargo-check', 'Cargo 检查', 'python', '宿主 Rust 工具链包装：check/test/clippy/metadata'),
    ('plugin-java-build', 'Maven/Gradle 测试', 'python', '宿主 JDK/Maven 包装：compile/test，解析 surefire 失败'),
    ('plugin-vue-build', 'Vue 构建自检', 'bun', '调 vue-tsc/vite build，解析错误（Vue3 管理端）'),
]
LOOSE_SCHEMA = {'type': 'object', 'properties': {}}


def phase_plugin(ids):
    existing = {r.get('identifier'): r.get('id')
                for r in (unwrap(mcp('plugin_list', '{}', quiet=True)) or {}).get('rows', [])
                if isinstance(r, dict)}
    plugins = ids.setdefault('plugins', {})
    for ident, name, runtime, desc in PLUGIN_DEFS:
        if existing.get(ident):
            plugins[ident] = existing[ident]
            print(f'  ↷ Plugin {ident} 已存在 ({existing[ident][:8]})')
            continue
        ext = 'ts' if runtime == 'bun' else 'py'
        script = (ASSETS / f'{ident}.{ext}').read_text(encoding='utf-8')
        # 先 extract_meta 校验脚本元信息（失败不阻断，用宽松 schema 兜底）
        schema = LOOSE_SCHEMA
        try:
            meta = unwrap(mcp('plugin_extract_meta', {'runtime': runtime, 'script': script}, quiet=True))
            if isinstance(meta, dict) and isinstance(meta.get('parametersSchema'), dict):
                schema = meta['parametersSchema']
        except Exception as e:
            print(f'  ⚠ {ident} extract_meta 失败（用宽松 schema）: {str(e)[:120]}')
        r = unwrap(mcp('plugin_upsert', {
            'name': name, 'identifier': ident, 'description': desc, 'runtime': runtime,
            'scriptContent': script, 'parametersSchema': schema, 'enabled': True,
            'timeoutSec': 120, 'scenario': 'dev-programming',
        }))
        pid = r.get('id') if isinstance(r, dict) else None
        if not pid:
            lst = unwrap(mcp('plugin_list', '{}', quiet=True)) or {}
            for row in lst.get('rows', []):
                if row.get('identifier') == ident:
                    pid = row.get('id')
        assert pid, f'plugin_upsert {ident} 未获得 id'
        plugins[ident] = pid
        print(f'  ✓ Plugin {ident} ({pid[:8]})')
    save_id_map(ids)


# ============================================================ Agent ×10
LLM_CFG = None  # 运行时从 agent_list_models 拷贝


def sp(*points):
    """把角色卡「系统提示要点」组装为 markdown。"""
    return '\n'.join(f'- {p}' for p in points)


AGENT_DEFS = [
    dict(identifier='pm-product', name='产品经理', scenario='office-efficiency',
         autoToolExecMode=False, planAutoApproveMode='sensitive', memoryMode='active',
         skills=['skill-task-breakdown', 'skill-test-case-design', 'skill-eng-standards'],
         plugins=['plugin-md-toc', 'plugin-changelog-draft', 'plugin-code-stats'],
         kbs=['kb-product-prd', 'kb-eng-standards', 'kb-pitfalls'],
         description='澄清目标与范围 → PRD/用户故事/验收标准 → 优先级与变更说明。不写业务代码。',
         system_prompt=sp(
             '你是产品经理（pm-product）：澄清目标与范围，产出 PRD/用户故事/验收标准，给出优先级与变更说明。你不写业务代码、不改测试代码、不部署。',
             '输出必须包含：背景、目标、非目标、用户故事、验收标准（Given/When/Then 或清单）、优先级、风险。',
             '不确定处显式标注「待确认」，禁止臆造业务事实。',
             '验收标准必须可被 QA 直接转成测试用例。',
             '交接给架构师：{prdPath, userStories[], acceptance[], constraints[]}；交接给 QA：{acceptance[], outOfScope[]}。')),
    dict(identifier='arch-tech-lead', name='技术架构师', scenario='dev-programming',
         autoToolExecMode=False, planAutoApproveMode='sensitive', memoryMode='active',
         skills=['skill-api-contract', 'skill-task-breakdown', 'skill-code-review-checklist'],
         plugins=['plugin-openapi-lint', 'plugin-sql-migrate-check', 'plugin-code-stats', 'plugin-md-toc'],
         kbs=['kb-adr', 'kb-eng-standards', 'kb-product-prd', 'kb-pitfalls'],
         description='技术方案、模块边界、API/数据契约、任务拆分与依赖、技术风险。不做大段业务实现。',
         system_prompt=sp(
             '你是技术架构师（arch-tech-lead）：负责技术方案、模块边界、API/数据契约、任务拆分与依赖、技术风险。可写骨架/接口定义，不做大段业务实现。',
             '先给方案对比与取舍，再定契约；契约字段命名前后端统一。',
             '拆任务必须带依赖边、预计产物文件、DoD（完成定义）。',
             '涉及前端时遵守团队前端规范（UI 组件封装统一、样式设计令牌、数据访问走 mapper 禁直写 SQL）。',
             '交接给开发：{apiContract, dataModel, taskList[], fileTargets[], risks[]}；交接给评审：{designDoc, contractPaths[]}。')),
    dict(identifier='dev-python-backend', name='Python 后端开发工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='never', memoryMode='active',
         skills=['skill-eng-standards', 'skill-api-contract', 'skill-test-case-design'],
         plugins=['plugin-pytest-runner', 'plugin-coverage-report', 'plugin-code-stats',
                  'plugin-openapi-lint', 'plugin-sql-migrate-check', 'plugin-diff-summary', 'plugin-test-report-md'],
         kbs=['kb-eng-standards', 'kb-adr', 'kb-test-assets', 'kb-pitfalls'],
         description='API/服务、数据处理、脚本、Python 插件、单测自证。不做前端 UI 与需求裁决。',
         system_prompt=sp(
             '你是 Python 后端开发工程师（dev-python-backend）：API/服务、数据处理、脚本开发与单测自证。不做前端 UI、不裁决产品需求。',
             '改动后必须跑最小自测并落报告（pytest 沙箱或插件）。',
             '接口变更同步契约片段；禁止私自改全局规范。',
             '错误处理只在系统边界做；内部信任引擎约束。',
             '交接：{changedFiles[], apiDiff, testSummary, knownLimits[]}。')),
    dict(identifier='dev-java-backend', name='Java 后端开发工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='never', memoryMode='active',
         skills=['skill-eng-standards', 'skill-api-contract', 'skill-test-case-design'],
         plugins=['plugin-java-build', 'plugin-diff-summary', 'plugin-code-stats',
                  'plugin-openapi-lint', 'plugin-test-report-md'],
         kbs=['kb-eng-standards', 'kb-adr', 'kb-test-assets', 'kb-pitfalls'],
         description='Java/Spring 业务服务、中台 API、领域逻辑、单测与集成测试。',
         system_prompt=sp(
             '你是 Java 后端开发工程师（dev-java-backend）：Spring 业务服务、中台 API、领域逻辑、MyBatis/JPA、单测与集成测试。',
             '接口与契约（OpenAPI）保持一致；DTO/异常码有文档。',
             '改动后跑 mvn -q test 或 gradle test，结构化上报失败用例。',
             '事务、空值、并发边界按评审清单自检。',
             '无 JVM 沙箱：构建检查走宿主 JDK/Maven（插件或白名单命令），禁止拼任意命令行。',
             '交接：{changedFiles[], apiDiff, testSummary, knownLimits[]}。')),
    dict(identifier='dev-react-frontend', name='React 前端开发工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='never', memoryMode='active',
         skills=['skill-eng-standards', 'skill-api-contract', 'skill-test-case-design'],
         plugins=['plugin-ts-typecheck', 'plugin-diff-summary', 'plugin-code-stats',
                  'plugin-md-toc', 'plugin-test-report-md'],
         kbs=['kb-eng-standards', 'kb-adr', 'kb-product-prd', 'kb-pitfalls'],
         description='页面/组件/状态/样式/交互，typecheck 与基础自测。不做后端逻辑。',
         system_prompt=sp(
             '你是 React 前端开发工程师（dev-react-frontend）：页面/组件/状态/样式/交互开发与 typecheck 自测。',
             'UI 一律使用团队封装组件库，禁裸用底层组件；图标用 lucide-react。',
             '样式 .scss 且只用 var(--color-*) 设计令牌；与 tsx 分离。',
             '数据访问走 mapper 层，组件禁止直写 SQL；完成后跑 npm run typecheck，0 error 才算完成。',
             '交接：{changedFiles[], uiAcceptanceMap, typecheckResult}。')),
    dict(identifier='dev-vue-frontend', name='Vue 前端开发工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='never', memoryMode='active',
         skills=['skill-eng-standards', 'skill-api-contract', 'skill-test-case-design'],
         plugins=['plugin-vue-build', 'plugin-ts-typecheck', 'plugin-diff-summary',
                  'plugin-code-stats', 'plugin-md-toc', 'plugin-test-report-md'],
         kbs=['kb-eng-standards', 'kb-adr', 'kb-product-prd', 'kb-pitfalls'],
         description='Vue 3 管理端/中台 UI：SFC、Pinia/Vuex、路由、组件库封装、构建自检。',
         system_prompt=sp(
             '你是 Vue 前端开发工程师（dev-vue-frontend）：Vue3 管理端/中台 UI（SFC、Pinia/Vuex、路由、组件封装、构建自检）。',
             'SFC 模板/脚本/样式分层清晰；组合式 API 优先，逻辑抽 composables。',
             'UI 组件库统一封装后再用，禁页面内散装样式全局污染。',
             '状态：跨页面才上 Pinia；接口统一 request 封装 + 错误码处理。',
             '完成后跑 vue-tsc --noEmit 或项目 typecheck/vite build，0 error 才算完成。',
             '交接：{changedFiles[], uiAcceptanceMap, buildResult}。')),
    dict(identifier='dev-tauri-rust', name='Tauri/Rust 客户端开发工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='never', memoryMode='active',
         skills=['skill-eng-standards', 'skill-api-contract', 'skill-code-review-checklist'],
         plugins=['plugin-cargo-check', 'plugin-diff-summary', 'plugin-code-stats',
                  'plugin-sql-migrate-check', 'plugin-test-report-md'],
         kbs=['kb-adr', 'kb-eng-standards', 'kb-pitfalls'],
         description='Tauri 命令、Rust 引擎、IPC/事件、沙箱/插件桥。',
         system_prompt=sp(
             '你是 Tauri/Rust 客户端开发工程师（dev-tauri-rust）：Tauri 命令、Rust 引擎、IPC/事件、沙箱/插件桥开发。',
             '命令注册、事件名、消息序列不变量（tool_call.id 闭环）不可破坏。',
             '能力层单一事实源：工具可用性以 registry 为准；变更需说明对前端事件契约的影响。',
             '无 Rust 沙箱：cargo check/test/clippy 经宿主工具链（插件或白名单命令），不要假设存在 run_rust_sandbox。',
             '交接：{changedFiles[], checkResult, contractImpact}。')),
    dict(identifier='qa-test-engineer', name='软件测试工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='sensitive', memoryMode='active',
         skills=['skill-test-case-design', 'skill-eng-standards', 'skill-delivery-pack'],
         plugins=['plugin-pytest-runner', 'plugin-coverage-report', 'plugin-test-report-md',
                  'plugin-ts-typecheck', 'plugin-diff-summary', 'plugin-code-stats'],
         kbs=['kb-test-assets', 'kb-product-prd', 'kb-pitfalls', 'kb-eng-standards'],
         description='用例设计、自动化、回归、缺陷报告、发布门禁建议。不实现业务功能。',
         system_prompt=sp(
             '你是软件测试工程师（qa-test-engineer）：用例设计、自动化、回归、缺陷报告、发布门禁建议。不做业务功能实现（测试代码与工具除外）。',
             '用例必须映射到验收标准 ID；每个需求至少含 1 条失败/边界路径用例。',
             '报告格式：范围、通过/失败、失败详情、风险、是否可发布。',
             '断言看结果与工具调用证据，不靠转述「应该没问题」。',
             '交接给集成：{testReport, blockers[], residualRisks[]}。')),
    dict(identifier='review-code-critic', name='代码评审员', scenario='dev-programming',
         autoToolExecMode=False, planAutoApproveMode='sensitive', memoryMode='off',
         skills=['skill-code-review-checklist', 'skill-eng-standards', 'skill-api-contract'],
         plugins=['plugin-diff-summary', 'plugin-code-stats'],
         kbs=['kb-eng-standards', 'kb-pitfalls', 'kb-adr'],
         description='正确性、安全、可维护性、性能、规范符合性评审。禁改代码（工具面硬禁写/执行）。',
         system_prompt=sp(
             '你是代码评审员（review-code-critic）：正确性、安全、可维护性、性能、规范符合性评审。你绝对不改代码——工具面已硬禁写与执行。',
             '输出分级：Blocker / Major / Minor / Nit；每条给 file:line 与修复建议。',
             '无问题也要说明检查过哪些维度（防「假通过」）。',
             '安全重点：注入、路径穿越、密钥、越权、不安全反序列化。',
             '交接：{reviewFindings[], blockerCount, verdict}。')),
    dict(identifier='int-delivery', name='集成交付工程师', scenario='dev-programming',
         autoToolExecMode=True, planAutoApproveMode='sensitive', memoryMode='active',
         skills=['skill-delivery-pack', 'skill-task-breakdown', 'skill-eng-standards'],
         plugins=['plugin-diff-summary', 'plugin-changelog-draft', 'plugin-test-report-md',
                  'plugin-md-toc', 'plugin-code-stats'],
         kbs=['kb-product-prd', 'kb-adr', 'kb-eng-standards'],
         description='汇总多角色产物、冲突消解建议、变更说明、交付包、发布清单。',
         system_prompt=sp(
             '你是集成交付工程师（int-delivery）：汇总多角色产物、消解冲突建议、写变更说明、组装交付包与发布清单。不重写业务（小修补需标注）。',
             '交付包最小结构：manifest.json（任务/成员/产物清单/校验）、report.md（变更说明/验收对照/风险）、changes/、tests/、reviews/、sources/。',
             '验收对照 PRD 逐项 Pass/Explicit Skip；缺口如实列出。',
             '交接：{packPath, manifest, changelog, notReadyGaps[]}。')),
]


def phase_agent(ids):
    global LLM_CFG
    models = unwrap(mcp('agent_list_models', '{}', quiet=True)) or []
    rows = models.get('rows', models) if isinstance(models, dict) else models
    llm = next((r for r in rows if r.get('name') == LLM_NAME), None)
    assert llm, f'未找到模型 {LLM_NAME}'
    llm_id = llm['id']
    LLM_CFG = json.loads(llm['config']) if isinstance(llm.get('config'), str) else llm.get('config')

    existing = {r.get('identifier'): r.get('id')
                for r in (unwrap(mcp('agent_ui_list', '{}', quiet=True)) or {}).get('data', [])
                if isinstance(r, dict)}
    agents = ids.setdefault('agents', [])
    have = {a['identifier'] for a in agents}
    for d in AGENT_DEFS:
        ident = d['identifier']
        if existing.get(ident):
            if ident not in have:
                agents.append({'identifier': ident, 'id': existing[ident]})
            print(f'  ↷ Agent {ident} 已存在 ({existing[ident][:8]})')
            continue
        payload = {
            'name': d['name'], 'identifier': ident, 'scenario': d['scenario'],
            'description': d['description'], 'systemPrompt': d['system_prompt'],
            'llmId': llm_id, 'llmConfig': LLM_CFG,
            'skillIds': [ids['skills'][s] for s in d['skills']],
            'pluginIds': [ids['plugins'][p] for p in d['plugins']],
            'kbIds': [ids['kbs'][k] for k in d['kbs']],
            'isActive': True, 'autoToolExecMode': d['autoToolExecMode'],
            'allowSandbox': True, 'memoryMode': d['memoryMode'],
            'planAutoApproveMode': d['planAutoApproveMode'],
        }
        r = unwrap(mcp('agent_ui_create', {'payload': payload}))
        aid = r.get('id') if isinstance(r, dict) else None
        if not aid:
            lst = (unwrap(mcp('agent_ui_list', '{}', quiet=True)) or {}).get('data', [])
            for row in lst:
                if row.get('identifier') == ident:
                    aid = row.get('id')
        assert aid, f'agent_ui_create {ident} 未获得 id: {str(r)[:200]}'
        # 原地更新（重绑定 agents 会断开与 ids['agents'] 的引用，导致映射文件存旧 id）
        ids['agents'][:] = [a for a in ids['agents'] if a.get('identifier') != ident]
        ids['agents'].append({'identifier': ident, 'id': aid})
        print(f'  ✓ Agent {ident} ({aid[:8]})')
    ids['llm'] = llm_id
    save_id_map(ids)


# ============================================================ 小分队 ×4（SQLite 直写）
def aid(ids, ident):
    m = next(a for a in ids['agents'] if a['identifier'] == ident)
    return m['id']


DENY_WRITE_EXEC = json.dumps({'mode': 'denylist', 'families': ['write', 'execute', 'destructive']}, ensure_ascii=False)
DENY_DESTRUCTIVE = json.dumps({'mode': 'denylist', 'families': ['destructive']}, ensure_ascii=False)
DENY_EXEC = json.dumps({'mode': 'denylist', 'families': ['execute', 'destructive']}, ensure_ascii=False)

SQUAD_DEFS = [
    dict(name='全栈迭代组', mode='orchestrator', leader='arch-tech-lead',
         description='复杂功能/迭代：主管拆解 → 多角色并行生产 → QA/评审 → 汇总交付（W0 PM → W1 架构 → W2 前后端并行 → W3 测试∥评审 → W4 集成）',
         run_strategy={'executionMode': 'manual', 'retryCount': 3, 'budgetTokens': 0},
         members=[
             ('pm-product', '产品经理', None, DENY_EXEC),
             ('arch-tech-lead', '技术主管', 1, None),
             ('dev-react-frontend', '前端开发', None, None),
             ('dev-vue-frontend', 'Vue 前端开发', None, None),
             ('dev-python-backend', 'Python 后端开发', None, None),
             ('dev-java-backend', 'Java 后端开发', None, None),
             ('dev-tauri-rust', '客户端开发', None, None),
             ('qa-test-engineer', '测试工程师', None, DENY_DESTRUCTIVE),
             ('review-code-critic', '代码评审', None, DENY_WRITE_EXEC),
             ('int-delivery', '集成交付', None, None),
         ],
         chat=None),
    dict(name='缺陷修复组', mode='orchestrator', leader='pm-product',
         description='单缺陷 hotfix：PM 澄清问题 → 前端/后端修复 → QA 回归 → 集成交付（有契约变更时手动拉入架构师）',
         run_strategy={'executionMode': 'manual', 'retryCount': 3, 'budgetTokens': 0},
         members=[
             ('pm-product', '问题澄清与验收标准', None, DENY_EXEC),
             ('dev-react-frontend', '前端修复', None, None),
             ('dev-python-backend', '后端修复', None, None),
             ('qa-test-engineer', '回归测试', None, DENY_DESTRUCTIVE),
             ('int-delivery', '集成交付', None, None),
         ],
         chat=None),
    dict(name='需求发布流水线', mode='pipeline', leader='pm-product',
         description='固定工序线性串流：S0 需求闸门 → S1 契约闸门 → S2 后端工序 → S3 测试工序 → S5 交付工序；前步产出喂后步，可无人值守',
         run_strategy={'executionMode': 'manual', 'retryCount': 3, 'budgetTokens': 0},
         members=[
             ('pm-product', 'S0 需求闸门', 1, DENY_EXEC),
             ('arch-tech-lead', 'S1 契约闸门', 2, None),
             ('dev-python-backend', 'S2 后端工序', 3, None),
             ('qa-test-engineer', 'S3 测试工序', 4, DENY_DESTRUCTIVE),
             ('int-delivery', 'S5 交付工序', 5, None),
         ],
         chat=None),
    dict(name='技术评审圆桌', mode='chat', leader='arch-tech-lead',
         description='共享黑板辩论：架构/评审/集成三席圆桌，显式主笔收口，输出决议+行动项+风险清单',
         run_strategy={'executionMode': 'manual', 'retryCount': 3, 'budgetTokens': 0},
         members=[
             ('arch-tech-lead', '方案陈述', None, None),
             ('review-code-critic', '挑刺评审', None, DENY_WRITE_EXEC),
             ('int-delivery', '主笔收敛', None, None),
         ],
         chat={'maxRounds': 6, 'summarizer': 'int-delivery', 'executeActions': 1}),
]


def phase_squad(ids):
    conn = sqlite3.connect(str(DB))
    cur = conn.cursor()
    cur.execute('SELECT name FROM agent_squad')
    existing = {r[0] for r in cur.fetchall()}
    for sd in SQUAD_DEFS:
        if sd['name'] in existing:
            print(f'  ↷ Squad {sd["name"]} 已存在，跳过')
            continue
        sid = str(uuid.uuid4())
        leader_id = aid(ids, sd['leader'])
        cur.execute(
            'INSERT INTO agent_squad (id,name,description,mode,leader_agent_id,unique_id,'
            'global_mcp_ids,global_mcp_tools,run_strategy,supports_file_input,workspace_dir,created_at,updated_at) '
            'VALUES (?,?,?,?,?,?,NULL,NULL,?,?,NULL,?,?)',
            (sid, sd['name'], sd['description'], sd['mode'], leader_id, sid,
             json.dumps(sd['run_strategy'], ensure_ascii=False), 1, _now(), _now()))
        for ident, role, order, profile in sd['members']:
            cur.execute(
                'INSERT INTO agent_squad_member (id,squad_id,agent_id,role,persona_override,'
                'pipeline_order,is_leader,depends_on,tool_profile_json,created_at) '
                'VALUES (?,?,?,?,NULL,?,?,\'[]\',?,?)',
                (str(uuid.uuid4()), sid, aid(ids, ident), role, order,
                 1 if ident == sd['leader'] else 0, profile, _now()))
        if sd['chat']:
            cur.execute(
                'INSERT OR REPLACE INTO agent_squad_chat_config '
                '(squad_id,max_rounds,summarizer_agent_id,execute_actions) '
                'VALUES (?,?,?,?)',
                (sid, sd['chat']['maxRounds'], aid(ids, sd['chat']['summarizer']),
                 sd['chat']['executeActions']))
        print(f'  ✓ Squad {sd["name"]} ({sd["mode"]}, {len(sd["members"])} 成员, {sid[:8]})')
    conn.commit()
    conn.close()


# ============================================================ verify
def rows_of(data):
    """从任意 list 工具返回中提取行数组。"""
    if isinstance(data, dict):
        return data.get('rows', data.get('data', [])) or []
    return data or []


def phase_verify(ids):
    print('=== 库存核对 ===')
    squads = rows_of(unwrap(mcp('squad_list', '{}', quiet=True)))
    print(f'小分队: {len(squads)} 套')
    for r in squads:
        if isinstance(r, dict):
            print(f'  - {r.get("name")} [{r.get("mode")}] 成员 {r.get("member_count", "?")}')
    skills = rows_of(unwrap(mcp('skill_list', '{}', quiet=True)))
    print(f'技能: {len(skills)} 个 ->', sorted(r.get('identifier') for r in skills))
    plugins = rows_of(unwrap(mcp('plugin_list', '{}', quiet=True)))
    print(f'插件: {len(plugins)} 个 ->', sorted(r.get('identifier') for r in plugins))
    kbs = rows_of(unwrap(mcp('kb_list', '{}', quiet=True)))
    print(f'知识库: {len(kbs)} 个 ->', sorted(r.get('identifier') for r in kbs))
    agents = rows_of(unwrap(mcp('agent_ui_list', '{}', quiet=True)))
    print(f'Agent: {len(agents)} 个 ->', sorted(r.get('identifier') for r in agents))


PHASES = {'kb': phase_kb, 'skill': phase_skill, 'plugin': phase_plugin,
          'agent': phase_agent, 'squad': phase_squad, 'verify': phase_verify}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--phase', default='all',
                    help='kb,skill,plugin,agent,squad,verify 或 all（逗号分隔）')
    args = ap.parse_args()
    ids = load_id_map()
    order = ['kb', 'skill', 'plugin', 'agent', 'squad', 'verify']
    todo = order if args.phase == 'all' else [p.strip() for p in args.phase.split(',')]
    for p in todo:
        print(f'\n===== Phase {p} =====')
        PHASES[p](ids)
    print('\n✅ 全部完成')
