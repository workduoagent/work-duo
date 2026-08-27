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
