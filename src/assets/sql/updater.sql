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

-- ---------- v3：MCP 服务表新增请求超时字段（秒） ----------
-- 用于连通性测试 / 工具调用时按服务自定义超时（默认 120s，原写死 15s）。
-- 存量库（已建表但无该列）通过本语句补齐；重复执行会被安全跳过。
ALTER TABLE mcp_info ADD COLUMN timeout_sec INTEGER NOT NULL DEFAULT 120;

-- ---------- v4：撤销 LLM 场景分类字典（模型分类回归固定枚举） ----------
-- 任务一把模型大类并入 scenario_category(scope='LLM')，但模型分类直接决定动态表单结构，
-- 须与代码参数接口 / createEmptyModel 分支严格对应，不应由字典托管。
-- 此处清理存量库中的 LLM 字典行（幂等，重复执行无副作用；新装库在 init.sql 已不再播种 LLM 行）。
DELETE FROM scenario_category WHERE scope = 'LLM';

-- ---------- v5：知识库表新增 logo 字段 ----------
-- knowledge_base 在 init.sql 建表时已含 logo（TEXT，可空），但存量库（在 logo 列加入建表语句之前已创建）
-- 实际表结构缺少该列，新建知识库时 INSERT 含 logo 会报 "table knowledge_base has no column named logo"。
-- 存量库通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE knowledge_base ADD COLUMN logo TEXT;

-- ---------- v6：知识库表冗余 file_count / file_size（避免 LEFT JOIN 聚合漂移） ----------
-- 列表/详情页直读这两列，由 refreshAssets / createKnowledgeBase 写 knowledge_asset 后回写。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE knowledge_base ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0;

-- ---------- v7：智能体表新增「是否允许使用沙箱环境」开关字段 ----------
-- 对应 init.sql 已建表即含该列；存量库（在 allow_sandbox 加入建表语句之前已创建）实际表结构缺少该列，
-- 新建/更新智能体时 INSERT 含 allow_sandbox 会报 "table agent_info has no column named allow_sandbox"。
-- 存量库通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_info ADD COLUMN allow_sandbox INTEGER NOT NULL DEFAULT 0;
-- ============================================================
