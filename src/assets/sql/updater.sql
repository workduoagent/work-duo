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

-- ---------- v8：新增智能体会话表与对话轮次表 ----------
-- 对应 Web 端 PostgreSQL 设计转本地 SQLite，用于在单个智能体调试页持久化会话/轮次。
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
    summary        TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_session_agent ON agent_conversation_session(agent_code, created_at DESC);

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
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    start_time         INTEGER,
    end_time           INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_round_session ON agent_conversation_round(session_id, round_index);

-- ---------- v9：智能体会话表新增 token 累计字段 ----------
-- total_prompt_tokens：累计提示词（输入）token，total_completion_tokens：累计对话（输出）token。
-- 二者之和近似「已占用的上下文总量」，用于底部环形图回显「已消耗 / 上下文限制」占比，
-- 以及超出限制时触发后端上下文压缩。
-- 存量库（在这两个字段加入建表语句之前已创建）实际表结构缺少该列，
-- 新建/更新会话时 UPDATE 含该列会报 "table agent_conversation_session has no column named ..."。
-- 存量库通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_conversation_session ADD COLUMN total_prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_conversation_session ADD COLUMN total_completion_tokens INTEGER NOT NULL DEFAULT 0;

-- ---------- v9（续）：智能体会话表新增 tools_tokens 字段 ----------
-- 工具/Skill 定义占用的上下文 token 数。理论固定，除非用户中途移除 Skill / 停用 MCP
-- （此时应在前端相应下调该值）。用于环形图悬浮明细的「工具占比」。
ALTER TABLE agent_conversation_session ADD COLUMN tools_tokens INTEGER NOT NULL DEFAULT 0;

-- ---------- v10：智能体会话表新增摘要覆盖轮数（滑动窗口压缩用） ----------
-- summary_round_count：已被压缩摘要覆盖的轮次数，用于上下文滑动窗口增量合并，
-- 避免每轮都重新压缩全部历史（节省 LLM 调用、保留既有摘要质量）。
-- 存量库通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_conversation_session ADD COLUMN summary_round_count INTEGER NOT NULL DEFAULT 0;

-- ---------- v11：后台滚动压缩（Rolling Compaction）所需字段 ----------
-- total_turns：会话累计执行的轮次数，用于判断「未压缩轮数 = total_turns - summary_round_count
--   是否达到触发阈值（通常为 5）」，驱动后台 Tokio 异步任务向前滚动合并旧轮次进 summary。
-- 存量库通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_conversation_session ADD COLUMN total_turns INTEGER NOT NULL DEFAULT 0;
-- raw_messages_json：当前轮次产生的完整 ChatMessage 数组 JSON（含 tool_calls / tool_call_id /
-- 工具结果），即「协议执行视图」。多轮上下文恢复时原样反序列化展开，保证无损、零格式损耗。
-- 非空默认 ''（前端建轮时不写，由 Rust 在 ReAct 循环结束后回填真实 JSON）。
ALTER TABLE agent_conversation_round ADD COLUMN raw_messages_json TEXT NOT NULL DEFAULT '';

-- ---------- v12：模型表新增讯飞三件套鉴权字段（app_id / api_secret） ----------
-- 通用厂商（OpenAI 兼容）仅用 api_key；科大讯飞（iflytek）需 appId + apiKey + apiSecret 三件套，
-- 其 TTS/STT 鉴权方式为 WebSocket 动态签名（HMAC-SHA256），与标准 Bearer 不同，表单按 provider 分支渲染。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE models ADD COLUMN app_id TEXT;
ALTER TABLE models ADD COLUMN api_secret TEXT;

-- ---------- v13：新增工程表（agent_project）与会话 project_id 绑定 ----------
-- 智能体工作空间智能绑定：用户选目录新建会话时，系统按规范化绝对路径自动建档/复用工程，
-- 会话通过 project_id 绑定到该工程（NULL 代表通用日常任务）。删除工程级联清除其下会话与轮次。
-- 1) agent_project 表（init.sql 已含 CREATE TABLE IF NOT EXISTS，此处再补一次以保证存量库在
--    仅执行 updater 的路径下也能拿到表；重复执行 CREATE TABLE IF NOT EXISTS 幂等无副作用）。
-- 2) 存量 agent_conversation_session（在 project_id 加入建表语句之前已创建）补齐该列；
--    重复执行会被 updateTables 安全跳过（duplicate column name）。
CREATE TABLE IF NOT EXISTS agent_project
(
    id             TEXT    PRIMARY KEY,
    name           TEXT    NOT NULL,
    root_path      TEXT    NOT NULL UNIQUE,
    description    TEXT,
    icon           TEXT,
    is_pinned      INTEGER NOT NULL DEFAULT 0,
    is_archived    INTEGER NOT NULL DEFAULT 0,
    custom_rules   TEXT,
    last_active_at INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_project_root ON agent_project(root_path);
CREATE INDEX IF NOT EXISTS idx_agent_project_active ON agent_project(is_pinned DESC, last_active_at DESC);

ALTER TABLE agent_conversation_session ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_session_lookup ON agent_conversation_session(project_id, is_top DESC, updated_at DESC);
-- ============================================================
