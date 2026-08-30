-- ============================================================
-- Work Duo 本地数据库初始化脚本（DDL 单一事实源）
-- 由 InitContext 在「每次启动」时幂等执行：
--   - CREATE TABLE IF NOT EXISTS：表已存在则跳过，不会重建/丢数据；
--   - INSERT OR IGNORE：种子已存在则跳过，不会重复插入。
-- 因此即便首启前 app_config / models 不存在，先跑本脚本即可保证表就绪，
-- 再读取 first_load 标记，彻底避免「no such table」问题。
-- 表结构需与 src/types/database.d.ts 的行实体保持同步。
-- ============================================================

-- ============ 系统配置表（首启标记等键值对） ============
CREATE TABLE IF NOT EXISTS app_config
(
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- 首启标记：true 表示需要执行初始化建表；InitContext 执行后置为 'false'
INSERT OR IGNORE INTO app_config (key, value) VALUES ('first_load', 'true');

-- ============ 模型接入配置表（models） ============
-- 行映射见 src/types/database.d.ts 的 ModelConfigRow。
-- config：分类专属参数（text/multimodal/...）序列化后的 JSON 字符串；
-- tags：标签数组序列化后的 JSON 字符串；
-- created_at / updated_at：epoch 毫秒（整型）。
CREATE TABLE IF NOT EXISTS models
(
    id          TEXT    PRIMARY KEY,
    provider    TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    model_name  TEXT    NOT NULL,
    base_url    TEXT,
    api_key     TEXT,
    category    TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    tool_calls  INTEGER NOT NULL DEFAULT 0,
    config      TEXT    NOT NULL DEFAULT '{}',
    description TEXT,
    tags        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- ============ 技能能力单元表（skill_info） ============
-- 行映射见 src/types/database.d.ts 的 SkillInfoRow。
-- 由 PostgreSQL 设计转 SQLite（详见用户给出的 DDL）：
--   id：本地生成的 UUID（文本主键），与 work-duo「模型/知识库」约定一致
--       （原 PG BIGINT 在此转为 TEXT 主键，避免自增 id 与导入/外部 id 冲突）；
--   identifier：唯一标识 slug（同时是磁盘目录名），大小写敏感的唯一约束由 UNIQUE 保证；
--   tags：标签数组序列化后的 JSON 字符串；
--   instruction：指令内容（与 SKILL.md 是不同字段）；
--   skill_markdown：SKILL.md 正文（落盘到 <identifier>/SKILL.md）；
--   scenario：技能分类 key（对应 SkillCategory 枚举）；
--   status：启用状态 1 / 0（卡片右上角 Switch 控制）；
--   path：本地存储目录，默认取 app_config.skill_path + '/' + identifier；
--   created_at / updated_at：epoch 毫秒（整型）。
CREATE TABLE IF NOT EXISTS skill_info
(
    id            TEXT    PRIMARY KEY,
    identifier    TEXT    NOT NULL,
    name          TEXT,
    description   TEXT,
    instruction   TEXT,
    skill_markdown TEXT,
    tags          TEXT,
    scenario      TEXT,
    status        INTEGER NOT NULL DEFAULT 1,
    path          TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    CONSTRAINT uk_skill_identifier UNIQUE (identifier)
);

-- 技能存储根路径：默认 $APPDATA/.skills，后续可在「设置」页修改（覆盖此值）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('skill_path', '$APPDATA/.skills');

-- ============ 设置页配置项（全部注册进 app_config） ============
-- 开机自启（布尔，JSON 字符串 'true'/'false'），默认关闭。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('auto_launch', 'false');
-- 网络代理：{ mode: 'direct' | 'system' | 'manual', http?, https?, socks5? }
INSERT OR IGNORE INTO app_config (key, value) VALUES ('network_proxy', '{"mode":"direct"}');
-- 默认工作空间存储路径，$APPDATA 由客户端运行时解析（SQLite 下为字面量占位）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('workspace_path', '$APPDATA/.workspace');
-- 客户端通知开关，默认开启。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('client_notify', 'true');
-- 生成对话记忆开关，默认关闭。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('memory_enabled', 'false');
-- 会话管理：超过设定小时数未对话自动开启新会话（开关 + 小时数）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('session_auto_new', 'false');
INSERT OR IGNORE INTO app_config (key, value) VALUES ('session_idle_hours', '24');
-- 导入的记忆列表（JSON 数组，见 ImportedMemory）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('imported_memories', '[]');
-- 知识库存储根路径（默认 $APPDATA/.knowledge_base，可在「设置」页修改）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('knowledge_base_path', '$APPDATA/.knowledge_base');

-- ============ MCP 服务接入表（mcp_info） ============
-- 行映射见 src/types/database.d.ts 的 McpInfoRow。
-- 由 PostgreSQL 设计（llm_mcp_info）转 SQLite：
--   id：本地 UUID（文本主键），与 work-duo「模型/技能」约定一致（原 PG int8 转 TEXT）；
--   headers / auth_config / capabilities / properties：JSON 对象序列化后的文本；
--   protocol_type：STDIO / SSE / HTTP；
--   auth_type：NONE / API_KEY / OAUTH2；
--   status：0 未测试 / 1 正常 / 2 异常（INTEGER）；
--   is_active：启用开关（INTEGER 0/1，默认 1）；
--   scenario：使用场景 key（对应 McpScenario 枚举）；
--   created_at / updated_at：epoch 毫秒（整型）。
CREATE TABLE IF NOT EXISTS mcp_info
(
    id           TEXT    PRIMARY KEY,
    alias_name   TEXT,
    mcp_name     TEXT,
    protocol_type TEXT   NOT NULL,
    endpoint_url TEXT,
    headers      TEXT,
    auth_type    TEXT   NOT NULL,
    auth_config  TEXT,
    is_active    INTEGER NOT NULL DEFAULT 1,
    status       INTEGER NOT NULL DEFAULT 1,
    capabilities TEXT,
    properties   TEXT,
    description  TEXT,
    scenario     TEXT,
    timeout_sec  INTEGER NOT NULL DEFAULT 120,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- ============ MCP 工具定义表（mcp_tool_definition） ============
-- 行映射见 src/types/database.d.ts 的 McpToolDefinitionRow。
-- 由 PostgreSQL 设计（llm_mcp_tool_definition）转 SQLite：
--   id：本地 UUID（文本主键）；
--   mcp_id：外键，引用 mcp_info.id；
--   input_schema / output_schema / test_params：JSON 对象序列化后的文本；
--   is_active：启用开关（INTEGER 0/1，默认 1）；
--   timeout：延时毫秒（INTEGER 默认 0）；
--   created_at / updated_at：epoch 毫秒（整型）。
CREATE TABLE IF NOT EXISTS mcp_tool_definition
(
    id            TEXT    PRIMARY KEY,
    mcp_id       TEXT    NOT NULL,
    tool_code     TEXT,
    display_name  TEXT,
    description   TEXT,
    input_schema  TEXT,
    output_schema TEXT,
    endpoint      TEXT,
    method_type   TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1,
    timeout       INTEGER NOT NULL DEFAULT 0,
    test_params   TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- ============ 场景分类字典表（scenario_category） ============
-- 统一管理 MCP / Skill / KB 的「域(scope) - 选项(value) - 显示名(label)」枚举，
-- 替代两处前端硬编码。业务表（mcp_info.scenario / skill_info.scenario / knowledge_base.scenario）
-- 存的是 value；label 可在此行内编辑，删除某选项时会置空对应业务表引用。
-- 注：LLM 模型分类不纳入本字典（模型大类直接驱动动态表单，须与代码严格对应）；
--     KB 知识库分类接入本字典（scope='KB'，对应 knowledge_base.scenario）。
-- 时间戳为 epoch 毫秒（整型），与既有表一致。
CREATE TABLE IF NOT EXISTS scenario_category
(
    id          TEXT    PRIMARY KEY,
    scope       TEXT    NOT NULL,   -- 域：MCP / SKILL / KB
    value       TEXT    NOT NULL,   -- 业务引用 key（如 file-system / pay-skill）
    label       TEXT    NOT NULL,   -- 可编辑显示名
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CONSTRAINT uk_scenario_scope_value UNIQUE (scope, value)
);

-- 种子：录入既有硬编码（value 与旧业务数据一致，零迁移）。
-- INSERT OR IGNORE：手动改过的 label 不会被覆盖；新增自定义项不会冲突。
INSERT OR IGNORE INTO scenario_category (id, scope, value, label, created_at, updated_at) VALUES
  -- MCP 使用场景（原 mcp_info.scenario 的 6 个值）
  ('sc-mcp-file-system',    'MCP', 'file-system',  '文件系统',   1700000000000, 1700000000000),
  ('sc-mcp-web-search',     'MCP', 'web-search',    '网络搜索',   1700000000000, 1700000000000),
  ('sc-mcp-database',       'MCP', 'database',      '数据库',     1700000000000, 1700000000000),
  ('sc-mcp-dev-tools',      'MCP', 'dev-tools',     '开发工具',   1700000000000, 1700000000000),
  ('sc-mcp-communication',  'MCP', 'communication', '通信协作',   1700000000000, 1700000000000),
  ('sc-mcp-productivity',   'MCP', 'productivity',  '生产力',     1700000000000, 1700000000000),
  -- Skill 技能分类（原 skill_info.scenario 的 13 个值）
  ('sc-skill-pay-skill',          'SKILL', 'pay-skill',           'Pay Skill',     1700000000000, 1700000000000),
  ('sc-skill-office-efficiency',  'SKILL', 'office-efficiency',   '办公效率',      1700000000000, 1700000000000),
  ('sc-skill-content-creation',   'SKILL', 'content-creation',    '内容创作',      1700000000000, 1700000000000),
  ('sc-skill-dev-programming',    'SKILL', 'dev-programming',     '开发编程',      1700000000000, 1700000000000),
  ('sc-skill-data-analysis',      'SKILL', 'data-analysis',       '数据分析',      1700000000000, 1700000000000),
  ('sc-skill-design-media',       'SKILL', 'design-media',        '设计多媒体',    1700000000000, 1700000000000),
  ('sc-skill-ai-agent',           'SKILL', 'ai-agent',           'AI Agent',     1700000000000, 1700000000000),
  ('sc-skill-knowledge-mgmt',     'SKILL', 'knowledge-management','知识管理',      1700000000000, 1700000000000),
  ('sc-skill-business-ops',        'SKILL', 'business-ops',       '商业运营',      1700000000000, 1700000000000),
  ('sc-skill-education',           'SKILL', 'education',          '教育学习',      1700000000000, 1700000000000),
  ('sc-skill-professional',        'SKILL', 'professional',        '行业专业',      1700000000000, 1700000000000),
  ('sc-skill-it-ops-security',     'SKILL', 'it-ops-security',     'IT 运维与安全', 1700000000000, 1700000000000),
  ('sc-skill-life-service',        'SKILL', 'life-service',        '生活服务',      1700000000000, 1700000000000);

-- ============ 知识库表（knowledge_base） ============
-- 行映射见 src/types/database.d.ts 的 KnowledgeBaseRow。
-- 严格适配用户给出的 PostgreSQL 设计（public.knowledge_base）转 SQLite：
--   id         本地 UUID（文本主键），与 work-duo「模型/技能」约定一致（原 PG int8 转 TEXT）；
--   logo       知识库 Logo（存相对 KB 目录的路径或 data URL，可空）；
--   identifier 唯一标识 slug（同时是磁盘目录名），$APPDATA/.knowledge_base/<identifier>/；
--   name       知识库名称；description 简介；
--   scenario   场景分类 key（对应 scenario_category scope='KB' 的 value，可空）；
--   created_at / updated_at：epoch 毫秒（整型，原 PG timestamp(6) 转 INTEGER）。
--   file_count / file_size：冗余聚合字段（总文件数 / 总字节数），由资产扫描后回写 knowledge_base，
--   列表/详情页直读这两列，不再 LEFT JOIN knowledge_asset 聚合。
CREATE TABLE IF NOT EXISTS knowledge_base
(
    id          TEXT    PRIMARY KEY,
    logo        TEXT,
    identifier  TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT,
    scenario    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    file_count  INTEGER NOT NULL DEFAULT 0,
    file_size   INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uk_knowledge_base_identifier UNIQUE (identifier)
);

-- ============ 知识库资产表（knowledge_asset） ============
-- 行映射见 src/types/database.d.ts 的 KnowledgeAssetRow。
-- 严格适配用户给出的 PostgreSQL 设计（public.knowledge_asset）转 SQLite：
--   id         本地 UUID（文本主键）；
--   kb_id      外键，引用 knowledge_base.id（原 PG int8 转 TEXT）；
--   name       数字资产名称（文件名，含扩展名）；
--   type       资产大类：1-文档 2-图片 3-音频 4-视频 5-网页（原 PG int4）；
--   file_ext   文件扩展名（不含点、小写，原 PG file_ext）；
--   file_size  文件大小（字节，原 PG int8 转 INTEGER）；
--   file_path  存储路径（相对知识库根目录，如 'docs/a.txt'，原 PG file_path）；
--   created_at / updated_at：epoch 毫秒（整型，原 PG timestamp(6) 转 INTEGER）。
-- 唯一约束：kb_id + file_path（同一知识库内路径唯一确定一个文件）。
CREATE TABLE IF NOT EXISTS knowledge_asset
(
    id          TEXT    PRIMARY KEY,
    kb_id       TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    type        INTEGER NOT NULL DEFAULT 1,
    file_ext    TEXT,
    file_size   INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CONSTRAINT uk_kb_asset UNIQUE (kb_id, file_path)
);
