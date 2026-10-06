-- ============================================================
-- Work Duo 本地数据库初始化脚本（DDL 单一事实源）
-- 当前 schema 版本（台账 S11）：每次 DDL 变更时同步递增（与 updater.sql 末段版本号一致），
-- SqlService.updateTables 读取此标记作为 user_version 封存目标。
-- SCHEMA_VERSION: 41
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
    -- 讯飞（iflytek）等厂商的三件套鉴权：appId + apiKey + apiSecret（通用厂商仅用 api_key）
    app_id      TEXT,
    api_secret  TEXT,
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
-- 会话管理：超过设定小时数未对话自动开启新会话（开关 + 小时数）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('session_auto_new', 'false');
INSERT OR IGNORE INTO app_config (key, value) VALUES ('session_idle_hours', '24');
-- 知识库存储根路径（默认 $APPDATA/.knowledge_base，可在「设置」页修改）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('knowledge_base_path', '$APPDATA/.knowledge_base');
-- 知识库嵌入向量维度（表级，LanceDB kb_chunks 向量列建表即固定）；空串=尚未索引过，首次成功索引时回填。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('kb_embed_dim', '');

-- 向量库（LanceDB）数据根路径（默认 $APPDATA/.vectors，可在「设置」页修改）。
-- 记忆 / artifacts / 知识库切块的向量全部存 LanceDB；SQLite 只存业务元数据（设计稿 v2.0 §3.1）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('vector_path', '$APPDATA/.vectors');
-- HTTP 请求主机白名单（http_request 硬防护）：逗号 / 分号 / 空白分隔的域名列表，小写存储。
-- 空字符串 = 不限制（允许任意 http/https 主机）；非空 = 仅允许命中列表中的主机（含其子域），其余拒绝。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('http_allowed_hosts', '');

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
    -- F020：语义为 0 未测试 / 1 正常 / 2 异常（见上方注释），代码侧 mcp-mapper 读回时
    -- 用 `?? 0`（未测）。原 DEFAULT 1 会让任何绕过 mapper 的 INSERT 把新 MCP 直接标成
    -- 「已连通」，UI 亮绿灯误导用户——故对齐为 0。
    status       INTEGER NOT NULL DEFAULT 0,
    capabilities TEXT,
    properties   TEXT,
    description  TEXT,
    scenario     TEXT,
    timeout_sec  INTEGER NOT NULL DEFAULT 120,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);


-- MCP 内建 Server 配对设备（F001 信任协议）：token 只存 SHA-256 哈希，明文仅配对时一次性返回
CREATE TABLE IF NOT EXISTS mcp_paired_device
(
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    fingerprint  TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL
);

-- 持久目录 fs scope 授权凭据（F003 follow-up）：
-- path 本身不可信（渲染层可经 plugin-sql 改写业务表），跨重启恢复 scope 以
-- HMAC-SHA256(scope_key || path) 签名为准，密钥存 OS 凭据管理器、不经 IPC 暴露。
-- scope_key：config:<数据目录键> | project:<工程 id> | squad:<小分队 id>；
-- 签发仅经 Rust record_fs_scope_grant（校验 fs_scope 来源），本表对渲染层只读无效。
CREATE TABLE IF NOT EXISTS fs_scope_grant
(
    scope_key  TEXT    PRIMARY KEY,
    path       TEXT    NOT NULL,
    mac        TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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

-- ============ 智能体表（agent_info） ============
-- 行映射见 src/types/database.d.ts 的 AgentInfoRow。
-- 由 PostgreSQL 设计（public.agent_info）转 SQLite：
--   id           本地 UUID（文本主键），与 work-duo「模型/技能/知识库」约定一致（原 PG int8 转 TEXT）；
--   identifier   智能体唯一标识：系统随机生成（用户可自定义），UNIQUE；
--   logo         头像：Base64 data URL（未设置时前端回退 lucide 图标，不落盘文件）；
--   scenario     场景分类 key（对应 scenario_category scope='AGENT' 的 value，可空）；
--   llm_id / tts_id / stt_id            外键，引用 models.id；
--   llm_config / tts_config / stt_config JSON 文本，是对应 models.config 的「私有副本」：
--       models.config 只作为初始默认值，智能体向导里可自由调参，改的是本列（原 PG jsonb 转 TEXT）；
--   is_active            启用开关（INTEGER 0/1，默认 1，原 PG bool）；
--   auto_tool_exec_mode  外部资源自动执行模式（INTEGER 0/1，默认 0）；
--   allow_sandbox        是否允许该智能体使用沙箱环境（INTEGER 0/1，默认 0）；
--   created_at / updated_at：epoch 毫秒（原 PG timestamp(6) 转 INTEGER）。
CREATE TABLE IF NOT EXISTS agent_info
(
    id                  TEXT    PRIMARY KEY,
    logo                TEXT,
    appearance          TEXT,   -- 拟人化像素形象配置 JSON（形象设计弹窗的再编辑源；NULL=从未生成/仅历史上传头像）
    scenario            TEXT,
    name                TEXT    NOT NULL,
    identifier          TEXT    NOT NULL,
    description         TEXT,
    system_prompt       TEXT,
    welcome_message     TEXT,
    llm_id              TEXT,
    llm_config          TEXT,
    tts_id              TEXT,
    tts_config          TEXT,
    stt_id              TEXT,
    stt_config          TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    auto_tool_exec_mode INTEGER NOT NULL DEFAULT 0,
    allow_sandbox       INTEGER NOT NULL DEFAULT 0,
    memory_mode         TEXT    NOT NULL DEFAULT 'off',  -- 记忆模式：off=关闭 / active=主动 / forced=强制每次任务末沉淀
    plan_auto_approve_mode TEXT NOT NULL DEFAULT 'always',  -- 计划审批策略：always=每次都审批 / sensitive=仅敏感任务审批 / never=从不审批
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    CONSTRAINT uk_agent_identifier UNIQUE (identifier)
);

-- ============ 智能体 × MCP 工具关联表（agent_mcp_ref） ============
-- 行映射见 src/types/database.d.ts 的 AgentMcpRefRow。
-- 最小关联单元是「工具」而不是「服务」：tool_id 引用 mcp_tool_definition.id；
-- mcp_id 是冗余列（工具所属 MCP 服务），仅用于按服务分组展示与级联清理，不参与唯一约束。
CREATE TABLE IF NOT EXISTS agent_mcp_ref
(
    id         TEXT    PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    mcp_id     TEXT    NOT NULL,
    tool_id    TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT uk_agent_mcp_tool UNIQUE (agent_id, tool_id)
);

-- ============ 智能体 × Skill 关联表（agent_skill_ref） ============
-- 行映射见 src/types/database.d.ts 的 AgentSkillRefRow。
-- skill_id 引用 skill_info.id；一个智能体可编排多个技能。
CREATE TABLE IF NOT EXISTS agent_skill_ref
(
    id         TEXT    PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    skill_id   TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT uk_agent_skill UNIQUE (agent_id, skill_id)
);

-- ============ 智能体 × 知识库关联表（agent_kb_ref，第四期 K2） ============
-- kb_id 引用 knowledge_base.id；智能体绑定的知识库决定 native__kb_search 的检索范围
-- （未绑定的智能体不注册该工具，提示与能力同源）。
CREATE TABLE IF NOT EXISTS agent_kb_ref
(
    id         TEXT    PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    kb_id      TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT uk_agent_kb UNIQUE (agent_id, kb_id)
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
  ('sc-skill-life-service',        'SKILL', 'life-service',        '生活服务',      1700000000000, 1700000000000),
  -- 智能体应用场景（对应 agent_info.scenario）
  ('sc-agent-customer-service',   'AGENT', 'customer-service',  '客服助手',   1700000000000, 1700000000000),
  ('sc-agent-office-efficiency',  'AGENT', 'office-efficiency', '办公效率',   1700000000000, 1700000000000),
  ('sc-agent-dev-programming',    'AGENT', 'dev-programming',   '开发编程',   1700000000000, 1700000000000),
  ('sc-agent-content-creation',   'AGENT', 'content-creation',  '内容创作',   1700000000000, 1700000000000),
  ('sc-agent-data-analysis',      'AGENT', 'data-analysis',     '数据分析',   1700000000000, 1700000000000),
  ('sc-agent-education',          'AGENT', 'education',         '教育学习',   1700000000000, 1700000000000),
  ('sc-agent-life-service',       'AGENT', 'life-service',      '生活服务',   1700000000000, 1700000000000);

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
-- v28（K1' 知识库 RAG）：digest=文件内容 hash（增量索引判据）；indexed_at=最近成功索引时间
-- （NULL=未索引/不支持格式）；meta_data=资产级 JSON（标签云 tags 等业务元数据；
-- chunk 级正文与向量权威在 LanceDB kb_chunks，SQLite 不存 embedding）。
CREATE TABLE IF NOT EXISTS knowledge_asset
(
    id          TEXT    PRIMARY KEY,
    kb_id       TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    type        INTEGER NOT NULL DEFAULT 1,
    file_ext    TEXT,
    file_size   INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT    NOT NULL,
    digest      TEXT,
    indexed_at  INTEGER,
    meta_data   TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CONSTRAINT uk_kb_asset UNIQUE (kb_id, file_path)
);

-- ============ 工程表（agent_project） ============
-- 绑定本地真实目录的「工程档案」。一个物理目录（规范化绝对路径）唯一对应一条记录，
-- 通过 root_path 唯一索引保证物理工程单例；同一目录不论盘符大小写/斜杠差异都归属同一工程。
-- custom_rules：项目专属 System Prompt 注入规则（继承到该工程下新建的会话）。
-- is_pinned / is_archived：置顶 / 归档（INTEGER 0/1）。
-- last_active_at：最后活跃时间戳，每次新建/追加轮次都刷新，用于工程级排序。
CREATE TABLE IF NOT EXISTS agent_project
(
    id             TEXT    PRIMARY KEY,            -- 工程 UUID（如 "proj_xxx"）
    name           TEXT    NOT NULL,               -- 工程名（默认取目录名，支持重命名）
    root_path      TEXT    NOT NULL UNIQUE,        -- 规范化物理绝对路径（唯一索引保证物理工程单例）
    description    TEXT,                           -- 工程说明
    icon           TEXT,                           -- 工程图标/徽标
    is_pinned      INTEGER NOT NULL DEFAULT 0,     -- 是否置顶（0: 否, 1: 是）
    is_archived    INTEGER NOT NULL DEFAULT 0,     -- 是否归档（0: 否, 1: 是）
    custom_rules   TEXT,                           -- 项目专属 System Prompt 注入规则
    last_active_at INTEGER NOT NULL,               -- 最后活跃时间戳（用于排序，每次新建/追加轮次都刷新）
    created_at     INTEGER NOT NULL,               -- 创建时间戳（Unix ms）
    updated_at     INTEGER NOT NULL               -- 更新时间戳（Unix ms）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_project_root ON agent_project(root_path);
CREATE INDEX IF NOT EXISTS idx_agent_project_active ON agent_project(is_pinned DESC, last_active_at DESC);

-- ============ 智能体会话表（agent_conversation_session） ============
-- 对应 PostgreSQL public.agent_conversation_session 转 SQLite：
--   id 本地 UUID（文本主键）；agent_code 对应 agent_info.identifier；
--   start_time / end_time / create_at / update_at 用 epoch 毫秒；
--   is_collection / is_top / is_archive 用 INTEGER 0/1；
--   from_site 默认 'DEBUG_CHAT'（单个智能体调试/对话页）。
CREATE TABLE IF NOT EXISTS agent_conversation_session
(
    id             TEXT    PRIMARY KEY,
    session_name   TEXT,
    agent_code     TEXT    NOT NULL,
    start_time     INTEGER,
    end_time       INTEGER,
    status         TEXT    NOT NULL DEFAULT 'RUNNING',
    error_message  TEXT,
    is_collection  INTEGER NOT NULL DEFAULT 0,
    is_top         INTEGER NOT NULL DEFAULT 0,
    is_archive     INTEGER NOT NULL DEFAULT 0,
    from_site      TEXT    NOT NULL DEFAULT 'DEBUG_CHAT',
    project_id     TEXT,                           -- 所属工程 ID（NULL 代表通用日常任务/无项目模式）
    summary        TEXT,
    total_prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    total_completion_tokens INTEGER NOT NULL DEFAULT 0,
    tools_tokens  INTEGER NOT NULL DEFAULT 0,
    summary_round_count INTEGER NOT NULL DEFAULT 0,
    total_turns   INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES agent_project(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_session_agent ON agent_conversation_session(agent_code, created_at DESC);
-- 注：idx_agent_session_lookup（含 project_id）移到 updater.sql，在 ALTER 补齐 project_id 后再建，
--     避免现有库（agent_conversation_session 已存在、无 project_id 列）建索引时整段 init.sql 失败。

-- ============ 智能体对话轮次表（agent_conversation_round） ============
-- 对应 PostgreSQL public.agent_conversation_round 转 SQLite：
--   id / session_id 本地 UUID 文本；input_tokens / output_tokens 用 INTEGER；
--   tool_calls_summary JSON 数组/对象序列化文本；
--   start_time / end_time / create_at / update_at 用 epoch 毫秒。
CREATE TABLE IF NOT EXISTS agent_conversation_round
(
    id                 TEXT    PRIMARY KEY,
    session_id         TEXT    NOT NULL,
    llm_code           TEXT,
    round_index        INTEGER NOT NULL,
    user_question      TEXT,
    thinking_content   TEXT,
    assistant_answer    TEXT,
    tool_calls_summary TEXT,
    plan_steps         TEXT,
    raw_messages_json  TEXT NOT NULL DEFAULT '',
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    start_time         INTEGER,
    end_time           INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    -- F019：交错时间线（ChatSegment[]：旁白/工具/正文按真实时序）。NULL = 旧 round 走旧渲染路径。
    -- 原先只存在于 updater.sql v26，破坏「init.sql 为 DDL 单一事实源」约定：新库建表即缺列，
    -- 须靠 updater 补齐，mapper 读 r.segments_json 恒为 undefined。updater.sql 的同名列保留
    -- （新库执行 ALTER 时会命中 duplicate column name 分支被安全跳过，幂等）。
    segments_json      TEXT,
    FOREIGN KEY(session_id) REFERENCES agent_conversation_session(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_round_session ON agent_conversation_round(session_id, round_index);

-- ============ 产物注册表（artifacts） ============
-- 子任务成功闭环后，把本次任务生成的文件产物登记进此表，形成「任务 → 产物」索引，
-- 支持前端「产物画廊」按步骤浏览、打开/定位/复制路径。产物是「逻辑实体」，文件只是其一种实现。
-- 同一（task_id, path）再次出现时以 version 自增覆盖，不以 path 做唯一约束（允许重跑覆盖）。
CREATE TABLE IF NOT EXISTS artifacts
(
    id            TEXT    PRIMARY KEY,        -- 产物唯一标识（art_<epochMs>_<step>_<idx>）
    session_id    TEXT,                       -- 所属会话（agent_conversation_session.id）
    round_id      TEXT,                       -- 所属轮次（agent_conversation_round.id）
    task_id       TEXT,                       -- 产生该产物的子任务 id（PlanSubTask.task_id）
    step          INTEGER NOT NULL DEFAULT 0,-- 子任务序号（1-based）
    artifact_type TEXT,                       -- 产物类型：file/image/document/spreadsheet/code/json/report/directory…
    path          TEXT    NOT NULL,           -- 产物绝对路径（已规范化、落于工作空间内）
    mime_type     TEXT,                       -- MIME 类型（由扩展名推导）
    description   TEXT,                       -- 产物描述（文件名或摘要片段）
    version       INTEGER NOT NULL DEFAULT 1, -- 同路径覆盖版本号（每次重跑自增）
    checksum      TEXT,                       -- 摘要校验（可选，当前留空，预留）
    size          INTEGER NOT NULL DEFAULT 0, -- 字节大小
    created_at    INTEGER NOT NULL DEFAULT 0  -- epoch 毫秒
);
CREATE INDEX IF NOT EXISTS idx_artifacts_round ON artifacts(round_id, step);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);

-- ============ 记忆宫殿表（agent_memories） ============
-- 智能体的长期可召回记忆单元（§3.3 记忆宫殿）。既可由用户/智能体显式「锚定」，
-- 也可在每次任务运行时由 runtime 自动召回 top-K 注入系统提示，召回即累计 ref_count（引用计数）。
--   id            本地 UUID（文本主键）；
--   agent_id      关联智能体（可空，空代表全局共享记忆）；
--   session_id    触发锚定的会话（可空）；
--   key           短标题 / 关键词（同一 agent_id 下唯一锚定键，重复锚定则更新内容）；
--   content       记忆正文；
--   category      分类：decision / code_pattern / user_pref / architecture / fix / other；
--   ref_count     引用次数（召回埋点累计，驱动热力图与权重排序）；
--   anchored      是否显式锚定（1 用户/智能体刻意沉淀，0 自动沉淀/历史）；
--   last_recalled 最近一次召回时间（epoch 毫秒，可空）；
--   created_at / updated_at：epoch 毫秒。
CREATE TABLE IF NOT EXISTS agent_memories
(
    id            TEXT    PRIMARY KEY,
    agent_id      TEXT,
    session_id    TEXT,
    key           TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    category      TEXT    NOT NULL DEFAULT 'general',
    ref_count     INTEGER NOT NULL DEFAULT 0,
    anchored      INTEGER NOT NULL DEFAULT 0,
    last_recalled INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_ref ON agent_memories(agent_id, ref_count DESC);

-- ============ 记忆事件日志表（agent_memory_events） ============
-- 每次召回（recall）/ 锚定（anchor）/ 压缩（compact）写一行，按日聚合驱动「记忆热力图」。
-- 由 memory.rs 的 recall_memory / anchor_memory 与 round_compactor 的压缩完成钩子写入。
CREATE TABLE IF NOT EXISTS agent_memory_events
(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id   TEXT    NOT NULL,
    event_type  TEXT    NOT NULL,   -- 'recall' | 'anchor' | 'compact'
    created_at  INTEGER NOT NULL,
    CONSTRAINT fk_memory_event FOREIGN KEY(memory_id) REFERENCES agent_memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_events_mem ON agent_memory_events(memory_id, created_at);

-- ============ 记忆蒸馏候选表（agent_memory_candidates） ============
-- M3 会话压缩蒸馏（#20260918007）：压缩 LLM 提炼的「值得升入长期记忆的候选」先落此表，
-- 记忆宫殿出「待确认」区：active 模式等用户采纳（confirm → anchor_memory 转入正表 +
-- 向量回写）/ 忽略（reject，不再出现）；forced 模式不落此表（引擎直接自动转入，走 M0 护栏）。
--   source   候选来源：distill（会话压缩蒸馏）/ settle（任务级提炼，预留）；
--   status   pending → confirmed / rejected（decided_at 记录处置时间）。
CREATE TABLE IF NOT EXISTS agent_memory_candidates
(
    id         TEXT    PRIMARY KEY,
    agent_id   TEXT,
    session_id TEXT,
    key        TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT 'other',
    source     TEXT    NOT NULL DEFAULT 'distill',
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_candidates_agent ON agent_memory_candidates(agent_id, status);

-- ============ 小分队定义表（agent_squad） ============
-- 一群「人」(Agent) 按协作模式处理同一事务（项目/任务）的团队定义。
--   id             本地 UUID（文本主键）；
--   name           团队名；logo 团队头像（Base64 字符串，可空）；description 简介；
--   mode           协作模式：orchestrator（编排）/ pipeline（流水线）/ chat（群聊协商）；
--   leader_agent_id 编排式主管 / 群聊汇总主笔默认（引用 agent_info.id，可空）；
--   global_mcp_ids 全局挂载的 MCP 服务 id 数组（JSON 文本，成员运行时强制并入工具集，可空）；
--   run_strategy   运行策略 JSON：{ execution_mode: 'manual'|'schedule'|'api',
--                   schedule_cron?: string, retry_count?: number }（可空，默认 manual/重试 3）；
--   created_at / updated_at：epoch 毫秒。
CREATE TABLE IF NOT EXISTS agent_squad
(
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    logo            TEXT,
    description     TEXT,
    mode            TEXT    NOT NULL DEFAULT 'orchestrator',
    leader_agent_id TEXT,
    unique_id       TEXT,
    global_mcp_ids  TEXT,
    global_mcp_tools TEXT,           -- 全局 MCP 工具级开关：JSON 对象 { [mcpId]: 被禁用工具 id[] }
    run_strategy    TEXT,
    supports_file_input INTEGER NOT NULL DEFAULT 0,
    workspace_dir   TEXT,
    -- F019：定时调度上次触发时刻（epoch 毫秒），防同一分钟重复触发。
    -- 原先只存在于 updater.sql v24；squad_scheduler.rs 以 Option<i64> 读取。
    last_scheduled_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_squad_mode ON agent_squad(mode);

-- ============ 小分队成员任职表（agent_squad_member） ============
-- 承载「成员智能体 + 在此团队中的定制」：角色、人设定制、流水线工序序号。
--   squad_id / agent_id：FK（级联清理）；同一 squad 内 agent 唯一；
--   role           承担角色（如「后端开发」「UI 设计」）；
--   persona_override 人设定制（拼到该成员 system_prompt 末尾，不污染 base agent）；
--   pipeline_order 流水线工序序号（pipeline 模式用，其余为 NULL）；
--   is_leader     编排式主管标记（0/1，默认 0）；
--   depends_on    流水线 DAG 依赖（JSON 数组，存上游成员 agent_id；空=按 pipeline_order 线性）；
--   tool_profile_json 角色工具面（S2 §4.2：{mode: inherit|allowlist|denylist, nativeTools, mcpTools}，能力层裁剪）。
CREATE TABLE IF NOT EXISTS agent_squad_member
(
    id              TEXT    PRIMARY KEY,
    squad_id        TEXT    NOT NULL,
    agent_id        TEXT    NOT NULL,
    role            TEXT,
    persona_override TEXT,
    pipeline_order  INTEGER,
    is_leader       INTEGER NOT NULL DEFAULT 0,
    depends_on      TEXT,
    tool_profile_json TEXT,
    created_at      INTEGER NOT NULL,
    CONSTRAINT uk_squad_member UNIQUE (squad_id, agent_id),
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE,
    FOREIGN KEY(agent_id) REFERENCES agent_info(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_member_squad ON agent_squad_member(squad_id, pipeline_order);

-- ============ 小分队群聊配置表（agent_squad_chat_config） ============
-- 仅 chat（群聊协商）模式使用的专属配置：
--   max_rounds        发言轮次上限（默认 8，达到后由 summarizer 收口）；
--   summarizer_agent_id 汇总主笔（最终产物结论负责人，可 = leader_agent_id 或单独指定，可空）；
--   execute_actions   S3 批次2（§7.1）：汇总行动项自动转 Wave 续跑（0=关，默认）。
CREATE TABLE IF NOT EXISTS agent_squad_chat_config
(
    squad_id          TEXT    PRIMARY KEY,
    max_rounds        INTEGER NOT NULL DEFAULT 8,
    summarizer_agent_id TEXT,
    execute_actions   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE
);

-- ============ 小分队协作运行表（agent_squad_session） ============
-- 一次协作运行的实例（点击「启动协作」生成）：
--   squad_id 所属团队；title 运行标题；mode 协作模式快照；status 运行状态；
--   snapshot 运行态快照（JSON，可空）；created_at / updated_at：epoch 毫秒。
CREATE TABLE IF NOT EXISTS agent_squad_session
(
    id          TEXT    PRIMARY KEY,
    squad_id    TEXT    NOT NULL,
    title       TEXT,
    mode        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'RUNNING',
    snapshot    TEXT,
    board_json  TEXT,
    contract_json TEXT,
    pack_json   TEXT,
    -- F011：会话归属进程 PID——启动清扫只收敛「无主」半终态会话（NULL/异 PID/本进程但无存活协程），
    -- 本进程活跃会话（SQUAD_CANCELS 有登记）绝不清扫，防误杀在跑协作。
    owner_pid   INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_session_squad ON agent_squad_session(squad_id, created_at DESC);

-- ============ 小分队交接箱（agent_squad_handoff，S1 设计方案 v1.4 §5） ============
-- HandoffBundle 的唯一 source of truth（§5 单源约定）：成员子任务终态强制产出，
-- board_json 只存 handoff id 引用，防双源漂移。artifacts 明细在 bundle_json 内。
CREATE TABLE IF NOT EXISTS agent_squad_handoff
(
    id            TEXT    PRIMARY KEY,
    squad_id      TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    task_id       TEXT    NOT NULL,
    from_agent_id TEXT    NOT NULL,
    status        TEXT    NOT NULL,              -- ok | partial | failed
    bundle_json   TEXT    NOT NULL,              -- 完整 HandoffBundle JSON
    created_at    INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES agent_squad_session(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_handoff_session ON agent_squad_handoff(session_id, created_at);

-- ============ 小分队黑板决策卡（agent_squad_decision，S1 §4.4.5） ============
CREATE TABLE IF NOT EXISTS agent_squad_decision
(
    id         TEXT    PRIMARY KEY,
    squad_id   TEXT    NOT NULL,
    session_id TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES agent_squad_session(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_decision_session ON agent_squad_decision(session_id, created_at);

-- ============ 小分队打断说话信箱（agent_squad_inject，S2 §4.11） ============
-- 插话审计唯一事实源：运行中打断（Live inject）/ 等待中搭话（pre_talk）统一落表。
--   task_id  目标键：编排式任务 id（t1/t2…）/ 流水线节点 id（n1/n2…）/ 群聊成员 agent_id；
--   mode     soft | hard | pre_talk（MVP 中 soft/hard 均在下一安全点注入，hard 仅 UI 强调）；
--   status   queued → delivered | dropped（会话终态未消费即 dropped）。
CREATE TABLE IF NOT EXISTS agent_squad_inject
(
    id           TEXT    PRIMARY KEY,
    squad_id     TEXT    NOT NULL,
    session_id   TEXT    NOT NULL,
    task_id      TEXT    NOT NULL,
    run_id       TEXT,
    source       TEXT    NOT NULL,           -- user | leader | system
    mode         TEXT    NOT NULL,           -- soft | hard | pre_talk
    content      TEXT    NOT NULL,
    status       TEXT    NOT NULL,           -- queued | delivered | dropped
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES agent_squad_session(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_inject_session ON agent_squad_inject(session_id, created_at);

-- ============ 小分队协作轮次表（agent_squad_round） ============
-- 协作过程中每一条发言/产物（讨论黑板）：
--   squad_id / session_id：FK（级联清理）；
--   speaker_agent_id 发言者智能体（可空，系统消息为 NULL）；
--   role           发言者角色（可空）；content 正文；kind 类型（user/assistant/summary/system…）；
--   created_at     epoch 毫秒。
CREATE TABLE IF NOT EXISTS agent_squad_round
(
    id              TEXT    PRIMARY KEY,
    squad_id        TEXT    NOT NULL,
    session_id      TEXT    NOT NULL,
    speaker_agent_id TEXT,
    role            TEXT,
    content         TEXT    NOT NULL,
    kind            TEXT,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE,
    FOREIGN KEY(session_id) REFERENCES agent_squad_session(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_round_session ON agent_squad_round(session_id, created_at);

-- ============ 小分队记忆表（agent_squad_memory） ============
-- 团队黑板 / 共享记忆（结构照搬 agent_memories，归属维度换 squad_id + 可选 agent_id）。
--   squad_id        所属团队（必填）；
--   agent_id        可空：NULL = 团队共享记忆，非 NULL = 某成员个人记忆；
--   session_id      触发锚定的协作运行（可空）；
--   key / content / category / ref_count / anchored / last_recalled / created_at / updated_at
--   语义与 agent_memories 一致（§3.3）。
CREATE TABLE IF NOT EXISTS agent_squad_memory
(
    id            TEXT    PRIMARY KEY,
    squad_id      TEXT    NOT NULL,
    agent_id      TEXT,
    session_id    TEXT,
    key           TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    category      TEXT    NOT NULL DEFAULT 'general',
    ref_count     INTEGER NOT NULL DEFAULT 0,
    anchored      INTEGER NOT NULL DEFAULT 0,
    last_recalled INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_memories_squad ON agent_squad_memory(squad_id, category);
CREATE INDEX IF NOT EXISTS idx_squad_memories_ref ON agent_squad_memory(squad_id, ref_count DESC);

-- ============ 自定义脚本插件主表（user_plugin_tool） ============
-- 行映射见 src/types/database.d.ts 的 UserPluginToolRow。
-- 本地可执行函数（FaaS）：用户在界面写 run(params)，平台沙箱执行并以 custom__<identifier> 注册为智能体工具。
--   id：本地 UUID（文本主键）；
--   identifier：工具唯一 slug（不含 custom__ 前缀），UNIQUE 约束兜底命名空间；
--   runtime：'python' | 'bun'；
--   script_content：用户核心代码（仅 run + 头注释，不含 Runner 壳）；
--   parameters_schema：OpenAI function 可用的 JSON Schema 字符串（{"type":"object",...}）；
--   dependencies：声明式依赖 JSON 数组文本（如 '["requests"]'），可空；
--   sample_params：试跑示例参数 JSON 对象文本，可空；
--   enabled：启用开关（INTEGER 0/1，默认 1）；
--   timeout_sec：单次执行超时（秒，默认 60，上限 300）；
--   scenario：场景分类 key（与 MCP/Skill 对齐），可空；
--   last_run_at / last_run_status：列表态冗余（0 未知 / 1 成功 / 2 失败），由试跑与 Agent 执行回写；
--   created_at / updated_at：epoch 毫秒（整型）。
CREATE TABLE IF NOT EXISTS user_plugin_tool
(
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    identifier        TEXT    NOT NULL,
    description       TEXT    NOT NULL,
    runtime           TEXT    NOT NULL,
    script_content    TEXT    NOT NULL,
    parameters_schema TEXT    NOT NULL,
    dependencies      TEXT,
    sample_params     TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    timeout_sec       INTEGER NOT NULL DEFAULT 60,
    scenario          TEXT,
    last_run_at       INTEGER,
    last_run_status   INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CONSTRAINT uk_user_plugin_identifier UNIQUE (identifier)
);

-- ============ 智能体 × 本地插件关联表（agent_plugin_ref） ============
-- 行映射见 src/types/database.d.ts 的 AgentPluginRefRow。
-- 对齐 agent_mcp_ref / agent_skill_ref 习惯：最小关联单元是「插件」，is_active 支持绑定级启停。
CREATE TABLE IF NOT EXISTS agent_plugin_ref
(
    id         TEXT    PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    plugin_id  TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT uk_agent_plugin UNIQUE (agent_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_plugin_agent ON agent_plugin_ref (agent_id);

-- ============ 插件执行日志表（plugin_run_log） ============
-- 行映射见 src/types/database.d.ts 的 PluginRunLogRow。
-- 试跑与 Agent 调用共用，支撑排障与列表态（滚动保留，按 plugin_id + created_at 清理）。
CREATE TABLE IF NOT EXISTS plugin_run_log
(
    id             TEXT    PRIMARY KEY,
    plugin_id      TEXT    NOT NULL,
    agent_id       TEXT,
    session_id     TEXT,
    source         TEXT    NOT NULL,
    params         TEXT,
    ok             INTEGER NOT NULL,
    exit_code      INTEGER,
    duration_ms    INTEGER,
    stdout         TEXT,
    stderr         TEXT,
    error_type     TEXT,
    missing_package TEXT,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_run_log_plugin ON plugin_run_log (plugin_id, created_at DESC);


-- ============================================================
-- ---------- 服务器托管（Host）管理面（设计稿 docs/server-hosting-design.md） ----------
-- 独立授权域（domain=host），与本地审批硬隔离；Agent 只见 server_id，凭证永不入授权链。

-- 服务器主表（管理面录入；user=SSH 登录用户，不必是 root）
CREATE TABLE IF NOT EXISTS server_host
(
    id                  TEXT    PRIMARY KEY,
    name                TEXT    NOT NULL,
    host                TEXT    NOT NULL,
    port                INTEGER NOT NULL DEFAULT 22,
    user                TEXT    NOT NULL,
    auth_type           TEXT    NOT NULL DEFAULT 'password',   -- password | private_key | private_key_passphrase
    credential_id       TEXT,                                  -- 指向 server_credential（密文，不落明文）
    path_allow          TEXT,                                  -- JSON 数组，如 ["/var/www"]
    path_deny           TEXT,                                  -- JSON 数组，优先于白名单
    local_path_allow    TEXT,                                  -- JSON 数组；空=绑定工作空间
    default_cwd         TEXT,                                  -- 须落在 path_allow
    login_note          TEXT,
    sudo_mode           TEXT    NOT NULL DEFAULT 'none',       -- none | sudo_cmd | sudo_full
    sudo_user           TEXT    NOT NULL DEFAULT 'root',
    host_auto_mode      TEXT    NOT NULL DEFAULT 'strict',     -- strict | balanced | auto
    allow_grant_memory  INTEGER NOT NULL DEFAULT 0,            -- false=永远只允许单次批准
    l3_policy           TEXT    NOT NULL DEFAULT 'single_shot',-- reject | single_shot
    grant_bind_as_user  INTEGER NOT NULL DEFAULT 1,            -- grant 精确匹配 as_user
    tags                TEXT,                                  -- JSON 数组
    note                TEXT,
    known_key_fingerprint TEXT,                                -- TOFU：首次连接记录的 SSH 主机键指纹（SHA-256），换键即拒
    last_used_at        INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_host_updated ON server_host (updated_at DESC);

-- 凭证密文（AES-256-GCM；主密钥在 OS 凭据管理器，UI/Agent 均不可读出明文）
CREATE TABLE IF NOT EXISTS server_credential
(
    id          TEXT    PRIMARY KEY,
    secret_type TEXT    NOT NULL,   -- password | private_key | private_key_passphrase
    secret_enc  TEXT    NOT NULL,   -- base64(nonce || ciphertext)
    hint        TEXT    NOT NULL,   -- 指纹展示（密钥 MD5 后 8 位 / 密码 ****+末 2 位）
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- 智能体 × 服务器绑定（装配向导多选；primary=默认 Host）
CREATE TABLE IF NOT EXISTS agent_server_ref
(
    id           TEXT    PRIMARY KEY,
    agent_id     TEXT    NOT NULL,
    server_id    TEXT    NOT NULL,
    role         TEXT    NOT NULL DEFAULT 'secondary', -- primary | secondary
    cwd_override TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CONSTRAINT uk_agent_server UNIQUE (agent_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_server_agent ON agent_server_ref (agent_id);

-- 执行审计（只记做了什么、结果如何；不含凭证）
CREATE TABLE IF NOT EXISTS server_exec_log
(
    id          TEXT    PRIMARY KEY,
    server_id   TEXT    NOT NULL,
    agent_id    TEXT,
    session_id  TEXT,
    run_id      TEXT,
    tool_name   TEXT    NOT NULL,
    argv        TEXT,
    as_user     TEXT,
    cwd         TEXT,
    started_at  INTEGER NOT NULL,
    duration_ms INTEGER,
    exit_code   INTEGER,
    bytes_in    INTEGER,
    bytes_out   INTEGER,
    approved    TEXT,               -- allow_auto | allow_grant | allow_user | allow_single | deny
    error       TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_exec_log_server ON server_exec_log (server_id, created_at DESC);

-- Host 专用免弹授权（与本地 grants 物理分表；domain 写死 host 防串域；run 结束强制过期）
CREATE TABLE IF NOT EXISTS host_grant
(
    grant_id     TEXT    PRIMARY KEY,
    domain       TEXT    NOT NULL DEFAULT 'host',
    run_id       TEXT    NOT NULL,
    agent_id     TEXT    NOT NULL,
    server_id    TEXT    NOT NULL,
    action       TEXT    NOT NULL,   -- Connect | RemoteRead | RemoteWrite | RemoteDelete | RemoteExec | Disconnect
    as_user      TEXT    NOT NULL,
    risk_key     TEXT    NOT NULL,   -- 如 host:rm_rf
    scope_digest TEXT,
    granted_by   TEXT    NOT NULL,   -- user | plan
    granted_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    max_uses     INTEGER NOT NULL DEFAULT 1,
    uses         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_host_grant_lookup ON host_grant (run_id, agent_id, server_id, action, as_user, risk_key);

-- 授权审计（与执行日志分表，可追责「这条生产变更谁批的、范围是什么」）
CREATE TABLE IF NOT EXISTS host_authz_log
(
    id             TEXT    PRIMARY KEY,
    run_id         TEXT,
    session_id     TEXT,
    agent_id       TEXT,
    server_id      TEXT,
    action         TEXT,
    as_user        TEXT,
    risk_level     TEXT,            -- L0 | L1 | L2 | L3
    risk_key       TEXT,
    signals_json   TEXT,
    decision       TEXT,            -- allow_auto | allow_grant | allow_user | allow_single | deny
    grant_id       TEXT,
    request_digest TEXT,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_authz_log_server ON host_authz_log (server_id, created_at DESC);


-- ---------- v32：run 轨迹持久化（台账 D4：Trajectory 回放数据底座） ----------
-- RUN_TRACES 内存桶（CAP=128、重启即丢）的落盘归档：run 终态时全量事件流写入；
-- agent_get_run_trace 内存 miss 时回退查本表 → 历史回放/交付包导出有据可查。
CREATE TABLE IF NOT EXISTS agent_run_trace
(
    run_id            TEXT    PRIMARY KEY,
    agent_id          TEXT,
    session_id        TEXT,
    started_at        INTEGER,
    finished_at       INTEGER NOT NULL,
    events_json       TEXT    NOT NULL,   -- 全事件流（按 ts 升序的 JSON 数组）
    thinking          TEXT,
    reply             TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_run_trace_session ON agent_run_trace (session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_trace_agent ON agent_run_trace (agent_id, started_at DESC);
