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
--   identifier：唯一标识 slug，大小写敏感的唯一约束由 UNIQUE 保证；
--   tags：标签数组序列化后的 JSON 字符串；
--   instruction：技能正文（SKILL.md 内容）；
--   scenario：技能分类 key（对应 SkillCategory 枚举）；
--   path：本地存储目录，默认取 app_config.skill_path + '/' + identifier；
--   created_at / updated_at：epoch 毫秒（整型）。
CREATE TABLE IF NOT EXISTS skill_info
(
    id          TEXT    PRIMARY KEY,
    identifier  TEXT    NOT NULL,
    name        TEXT,
    description TEXT,
    instruction TEXT,
    tags        TEXT,
    scenario    TEXT,
    path        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CONSTRAINT uk_skill_identifier UNIQUE (identifier)
);

-- 技能存储根路径：默认 $RESOURCE/.skills，后续可在「设置」页修改（覆盖此值）。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('skill_path', '$RESOURCE/.skills');

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
    auth_type    TEXT    NOT NULL,
    auth_config  TEXT,
    is_active    INTEGER NOT NULL DEFAULT 1,
    status       INTEGER NOT NULL DEFAULT 1,
    capabilities TEXT,
    properties   TEXT,
    description  TEXT,
    scenario     TEXT,
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
