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
-- 记忆模式开关：off=关闭 / active=主动 / forced=强制。默认 off，兼容存量智能体（老数据无记忆能力）。
ALTER TABLE agent_info ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'off';

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

-- ---------- v14：对话轮次表新增规划步骤结构（plan_steps） ----------
-- 与 tool_calls_summary 对称：任务步骤（标题/状态/产物摘要）随轮次落库，
-- 历史回看时可完整重建「步骤 → 工具」嵌套视图，无需依赖运行时状态。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_conversation_round ADD COLUMN plan_steps TEXT;

-- ---------- v15：产物注册表（artifacts） ----------
-- 子任务成功闭环后登记本次任务生成的文件产物，供前端「产物画廊」浏览/打开/定位。
-- 全新表用 CREATE TABLE IF NOT EXISTS，存量库（仅有 agent_conversation_round 无 artifacts）执行本语句补齐；
-- 重复执行幂等无副作用。新装库在 init.sql 建表时即包含本表，此处再补一次保证存量库在仅走 updater 的路径下也能拿到。
CREATE TABLE IF NOT EXISTS artifacts
(
    id            TEXT    PRIMARY KEY,
    session_id    TEXT,
    round_id      TEXT,
    task_id       TEXT,
    step          INTEGER NOT NULL DEFAULT 0,
    artifact_type TEXT,
    path          TEXT    NOT NULL,
    mime_type     TEXT,
    description   TEXT,
    version       INTEGER NOT NULL DEFAULT 1,
    checksum      TEXT,
    size          INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_artifacts_round ON artifacts(round_id, step);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);

-- ---------- v16：记忆宫殿表（agent_memories + agent_memory_events） ----------
-- §3.3 记忆宫殿：智能体长期可召回记忆单元 + 召回/锚定/压缩事件日志（驱动热力图与引用计数）。
-- 全新表用 CREATE TABLE IF NOT EXISTS；重复执行幂等无副作用。新装库在 init.sql 建表时即包含本表，
-- 此处再补一次保证存量库在仅走 updater 的路径下也能拿到。
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

CREATE TABLE IF NOT EXISTS agent_memory_events
(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id   TEXT    NOT NULL,
    event_type  TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    CONSTRAINT fk_memory_event FOREIGN KEY(memory_id) REFERENCES agent_memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_events_mem ON agent_memory_events(memory_id, created_at);

-- ---------- v17：小分队（Squad）协作六表 ----------
-- 一群「人」(Agent) 按协作模式（编排/流水线/群聊）处理同一事务的团队能力。
-- 全新表用 CREATE TABLE IF NOT EXISTS，重复执行幂等无副作用；
-- 新装库在 init.sql 建表时即包含本批表，此处再补一次保证存量库在仅走 updater 的路径下也能拿到。
CREATE TABLE IF NOT EXISTS agent_squad
(
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    logo            TEXT,
    description     TEXT,
    mode            TEXT    NOT NULL DEFAULT 'orchestrator',
    leader_agent_id TEXT,
    global_mcp_ids  TEXT,
    run_strategy    TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_squad_mode ON agent_squad(mode);

CREATE TABLE IF NOT EXISTS agent_squad_member
(
    id              TEXT    PRIMARY KEY,
    squad_id        TEXT    NOT NULL,
    agent_id        TEXT    NOT NULL,
    role            TEXT,
    persona_override TEXT,
    pipeline_order  INTEGER,
    is_leader       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    CONSTRAINT uk_squad_member UNIQUE (squad_id, agent_id),
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE,
    FOREIGN KEY(agent_id) REFERENCES agent_info(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_member_squad ON agent_squad_member(squad_id, pipeline_order);

CREATE TABLE IF NOT EXISTS agent_squad_chat_config
(
    squad_id          TEXT    PRIMARY KEY,
    max_rounds        INTEGER NOT NULL DEFAULT 8,
    summarizer_agent_id TEXT,
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_squad_session
(
    id          TEXT    PRIMARY KEY,
    squad_id    TEXT    NOT NULL,
    title       TEXT,
    mode        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'RUNNING',
    snapshot    TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY(squad_id) REFERENCES agent_squad(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_squad_session_squad ON agent_squad_session(squad_id, created_at DESC);

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

-- ---------- v8：小分队调度与 DAG 编排字段 ----------
-- 定时模式上次触发时刻（防分钟内重复触发）；存量库（建表时无该列）通过本语句补齐，
-- 重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_squad ADD COLUMN last_scheduled_at INTEGER;
-- 流水线 DAG 依赖（JSON 数组，存上游成员 agent_id；空=按 pipeline_order 线性）；
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被安全跳过。
ALTER TABLE agent_squad_member ADD COLUMN depends_on TEXT;

-- ---------- v18：小分队唯一标识（unique_id） ----------
-- 供外部系统按唯一标识触发 / 引用小分队（API 触发既可用内部 id，也可用 unique_id）。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_squad ADD COLUMN unique_id TEXT;

-- ---------- v19：小分队「是否支持文件输入」开关 ----------
-- 控制运行该小分队时是否允许附带文件输入（如流水线的起始输入节点可挂载文件）。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_squad ADD COLUMN supports_file_input INTEGER NOT NULL DEFAULT 0;

-- ---------- v20：小分队「工作目录」 ----------
-- 用户自选的产物输出根目录（绝对路径）；为空则运行期回退默认隔离目录
-- `.wd_mem/squads/{squad_id}/`。成员实际工作区为 {workspace_dir}/{agent_id}（保留相互隔离）。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_squad ADD COLUMN workspace_dir TEXT;

-- ---------- v21：小分队「全局 MCP 工具级开关」 ----------
-- 记录各 MCP 服务下被禁用的工具 id（JSON 对象：{ [mcpId]: string[] }），
-- 与 global_mcp_ids（启用的服务列表）配合实现「按服务总开关 + 按工具子开关」。
-- 存量库（建表时无该列）通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
ALTER TABLE agent_squad ADD COLUMN global_mcp_tools TEXT;

-- ---------- v22：智能体表新增「计划审批策略模式」开关字段 ----------
-- 对应 init.sql 已建表即含该列；存量库（在 plan_auto_approve_mode 加入建表语句之前已创建）实际表结构缺少该列，
-- 新建/更新智能体时 INSERT 含 plan_auto_approve_mode 会报 "table agent_info has no column named plan_auto_approve_mode"。
-- 存量库通过本语句补齐；重复执行会被 updateTables 安全跳过（duplicate column name）。
-- 取值：always=每次复合任务都走人工审批 / sensitive=仅含敏感操作的计划才审批（纯低风险任务自动放行）/ never=从不审批。默认 always。
ALTER TABLE agent_info ADD COLUMN plan_auto_approve_mode TEXT NOT NULL DEFAULT 'always';

-- ---------- v23：自定义脚本插件三表（user_plugin_tool / agent_plugin_ref / plugin_run_log） ----------
-- 本地可执行函数（FaaS）模块后端存储。全新表用 CREATE TABLE IF NOT EXISTS，重复执行幂等无副作用；
-- 新装库在 init.sql 建表时即包含本批表，此处再补一次保证存量库在仅走 updater 的路径下也能拿到。
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
-- ---------- v24：agent_info 新增 appearance（Pixel Agent 形象设计配置 JSON） ----------
-- 形象设计弹窗的再编辑源：保存形象时生成 PNG dataURL 写 logo（展示源），结构化配置写本列。
-- NULL = 从未使用形象设计生成过（或仅历史上传头像）。
ALTER TABLE agent_info ADD COLUMN appearance TEXT;
-- ---------- v25：app_config 新增 vector_path（LanceDB 向量库数据根目录） ----------
-- 记忆 / artifacts / 知识库切块向量统一存 LanceDB（默认 $APPDATA/.vectors）；
-- SQLite 只存业务元数据，不存 embedding（设计稿 v2.0 §3.1）。INSERT OR IGNORE 幂等，存量库补默认值。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('vector_path', '$APPDATA/.vectors');

-- ============================================================
-- ---------- v26：agent_conversation_round 新增 segments_json（交错时间线持久化） ----------
-- 思考旁白 / 工具调用 / 正文按真实时序穿插的时间线 JSON（ChatSegment[]）；
-- 刷新 / 历史加载时据此重建穿插渲染；旧 round NULL = 回退旧渲染。
ALTER TABLE agent_conversation_round ADD COLUMN segments_json TEXT;

-- ============================================================
-- ---------- v27：记忆蒸馏候选表（M3 #20260918007） ----------
-- 会话压缩蒸馏的「值得升入长期记忆」候选 pending 区；active 模式等用户确认，
-- forced 模式不落此表（引擎直接自动转入）。新装库 init.sql 已含该表。
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

-- ============================================================
-- ---------- v28：知识库 RAG 索引（K1 第二期重设计，设计稿 docs/knowledge-rag-design.md） ----------
-- 资产级索引状态与增量判据；chunk 正文与向量权威在 LanceDB kb_chunks（SQLite 不存 embedding）。
-- digest=文件内容 hash（增量索引判据，NULL=未索引）；indexed_at=最近成功索引时间；
-- meta_data=资产级 JSON（标签云 tags 等业务元数据）。
ALTER TABLE knowledge_asset ADD COLUMN digest TEXT;
ALTER TABLE knowledge_asset ADD COLUMN indexed_at INTEGER;
ALTER TABLE knowledge_asset ADD COLUMN meta_data TEXT;
-- 嵌入维度表级记录（LanceDB 向量列建表即固定）；空串=尚未索引过，首次成功索引时回填实际维度。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('kb_embed_dim', '');

-- ============================================================
-- ---------- v29：智能体 × 知识库关联表（K2） ----------
-- 绑定关系决定 native__kb_search 的检索范围与工具注册与否（未绑定不注册）。新装库 init.sql 已含该表。
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

-- ============================================================
-- ---------- v30：服务器托管（Host）管理面（设计稿 docs/server-hosting-design.md） ----------
-- 独立授权域（domain=host），与本地审批硬隔离；Agent 只见 server_id，凭证永不入授权链。
-- 六表：server_host / server_credential / agent_server_ref / server_exec_log / host_grant / host_authz_log。
CREATE TABLE IF NOT EXISTS server_host
(
    id                  TEXT    PRIMARY KEY,
    name                TEXT    NOT NULL,
    host                TEXT    NOT NULL,
    port                INTEGER NOT NULL DEFAULT 22,
    user                TEXT    NOT NULL,
    auth_type           TEXT    NOT NULL DEFAULT 'password',
    credential_id       TEXT,
    path_allow          TEXT,
    path_deny           TEXT,
    local_path_allow    TEXT,
    default_cwd         TEXT,
    login_note          TEXT,
    sudo_mode           TEXT    NOT NULL DEFAULT 'none',
    sudo_user           TEXT    NOT NULL DEFAULT 'root',
    host_auto_mode      TEXT    NOT NULL DEFAULT 'strict',
    allow_grant_memory  INTEGER NOT NULL DEFAULT 0,
    l3_policy           TEXT    NOT NULL DEFAULT 'single_shot',
    grant_bind_as_user  INTEGER NOT NULL DEFAULT 1,
    tags                TEXT,
    note                TEXT,
    last_used_at        INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_host_updated ON server_host (updated_at DESC);

CREATE TABLE IF NOT EXISTS server_credential
(
    id          TEXT    PRIMARY KEY,
    secret_type TEXT    NOT NULL,
    secret_enc  TEXT    NOT NULL,
    hint        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_server_ref
(
    id           TEXT    PRIMARY KEY,
    agent_id     TEXT    NOT NULL,
    server_id    TEXT    NOT NULL,
    role         TEXT    NOT NULL DEFAULT 'secondary',
    cwd_override TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CONSTRAINT uk_agent_server UNIQUE (agent_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_server_agent ON agent_server_ref (agent_id);

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
    approved    TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_exec_log_server ON server_exec_log (server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS host_grant
(
    grant_id     TEXT    PRIMARY KEY,
    domain       TEXT    NOT NULL DEFAULT 'host',
    run_id       TEXT    NOT NULL,
    agent_id     TEXT    NOT NULL,
    server_id    TEXT    NOT NULL,
    action       TEXT    NOT NULL,
    as_user      TEXT    NOT NULL,
    risk_key     TEXT    NOT NULL,
    scope_digest TEXT,
    granted_by   TEXT    NOT NULL,
    granted_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    max_uses     INTEGER NOT NULL DEFAULT 1,
    uses         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_host_grant_lookup ON host_grant (run_id, agent_id, server_id, action, as_user, risk_key);

CREATE TABLE IF NOT EXISTS host_authz_log
(
    id             TEXT    PRIMARY KEY,
    run_id         TEXT,
    session_id     TEXT,
    agent_id       TEXT,
    server_id      TEXT,
    action         TEXT,
    as_user        TEXT,
    risk_level     TEXT,
    risk_key       TEXT,
    signals_json   TEXT,
    decision       TEXT,
    grant_id       TEXT,
    request_digest TEXT,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_authz_log_server ON host_authz_log (server_id, created_at DESC);

-- ---------- v31：TOFU 主机键指纹（服务器托管，台账 P0-1） ----------
-- 首次连接记录服务器 SSH 主机键指纹（SHA-256/base64-nopad，russh_keys::PublicKey::fingerprint）；
-- 后续连接比对：一致放行、不一致拒绝（中间人/服务器重装换键告警）。重置=置 NULL，下次连接重新记录。
ALTER TABLE server_host ADD COLUMN known_key_fingerprint TEXT;
