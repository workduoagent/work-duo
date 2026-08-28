-- ============================================================
-- Work Duo 本地数据库版本更新脚本
-- 仅在「非首启」（app_config.first_load = 'false'）时执行。
-- 后续软件版本更新、附带表 / 字段变更时，在此集中追加 SQL。
-- InitContext 会安全跳过已存在的表 / 字段（重复执行不报错）。
-- 当前为初始版本，暂无变更（以下为已落地的历史变更，按时间顺序追加即可）。

-- ---------- v1：模型新增 Tool/Function Calling 能力标记字段 ----------
-- 存量库（已建表但无该列）通过本语句补齐；updateTables 已安全忽略「duplicate column name」，
-- 故重复执行不会报错。新装库在 init.sql 建表时即包含该列。
ALTER TABLE models ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;

-- ---------- v2：技能表新增 SKILL.md / 启用状态 字段 ----------
-- instruction 与 SKILL.md 是两个独立字段：前者是技能级指令，后者是落盘的 SKILL.md 文件内容。
-- 存量库（已建表但无这些列）通过本语句补齐；重复执行会被安全跳过。
ALTER TABLE skill_info ADD COLUMN skill_markdown TEXT;
ALTER TABLE skill_info ADD COLUMN status INTEGER NOT NULL DEFAULT 1;
-- ============================================================
