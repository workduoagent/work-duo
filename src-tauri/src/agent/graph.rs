//! 单 Agent 统一实体图（Knowledge Graph）。
//!
//! 设计定位（见《单 Agent 统一实体图 · 完整设计方案》）：
//!  - 图是 Agent 的**运行时数据模型**，不是事后索引；
//!  - Planner 写图，流水线在图上调度，工具执行写图，恢复改图；
//!  - 图即持久化——内存 HashMap 为主存储，JSONL 追加为持久化层，不再有「内存状态 + 另存一份」双轨。
//!
//! 本模块是地基：不依赖任何其它 agent 模块（除 `types` 的产物引用类型），
//! 被 pipeline / planner / runtime / artifacts / context 消费。
//!
//! 并发安全：单 Agent 路径下 pipeline 是单线程 `join_all`，所有图变更发生在主循环（同一 task 内串行），
//! 无需锁。JSONL 追加语义提供崩溃恢复：同一节点 id 多次出现，后行覆盖前行（加载时按行序合并）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use serde_json::Value;

use crate::agent::types::ArtifactRef;
use crate::agent::types::PlanDAG;
use crate::agent::types::PlanSubTask;
use crate::agent::types::SuccessCriterion;

/// `.wd_mem` 下的图目录。
const GRAPH_DIR: &str = "graph";
const NODES_FILE: &str = "nodes.jsonl";
const EDGES_FILE: &str = "edges.jsonl";
const INDEX_FILE: &str = "_index.json";
const SESSIONS_SUBDIR: &str = "sessions";

/// 节点种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Session,
    Task,
    Artifact,
    FileRef,
    Memory,
    Prompt,
}

/// 边关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeRelation {
    /// Session ← Prompt
    TriggeredBy,
    /// Task ← Task（父子）
    Contains,
    /// Task → Task（DAG 依赖）
    DependsOn,
    /// Task → Artifact
    Produced,
    /// Task → FileRef（读）
    Read,
    /// Task → FileRef（写）
    Wrote,
    /// Task → Memory
    Learned,
    /// Task → Session
    BelongsTo,
}

/// 图节点。各 kind 的领域字段全部放在 `props`（扁平序列化，加载时归并）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: NodeKind,
    #[serde(flatten)]
    pub props: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 图边。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relation: EdgeRelation,
    pub created_at: i64,
}

/// 任务上下文聚合结果（替代旧的 `pipeline_context_summary` 字符串）。
#[derive(Debug, Clone, Default)]
pub struct TaskContext {
    /// 前序步骤已交付产物摘要（含会话 initial_context 作为基底），
    /// 供本轮子任务 prompt 注入「前序步骤已交付产物」。
    pub prior_summary: String,
    /// 本任务经恢复「接管/重试」写入的补充指示（guidance）。
    pub guidance: String,
}

/// 统一实体图。
pub struct KnowledgeGraph {
    /// 持久化根目录（`.wd_mem/graph/`）。`None` 表示纯内存态（无工作空间，不落盘）。
    base_dir: Option<PathBuf>,
    nodes: HashMap<String, GraphNode>,
    edges: HashMap<String, GraphEdge>,
    /// 邻接索引：node_id → 出边 id 列表（from 方向）。
    adj_from: HashMap<String, Vec<String>>,
    /// 邻接索引：node_id → 入边 id 列表（to 方向）。
    adj_to: HashMap<String, Vec<String>>,
    /// id 生成序列。
    seq: AtomicU64,
}

impl KnowledgeGraph {
    /// 打开（或新建）某工作空间下的实体图。
    ///
    /// `workspace_root` 为 `None` 时返回**纯内存态**图（不落盘，进程结束即弃），
    /// 用于无工作空间的复合任务（极少路径，保证不崩）。
    /// 否则在 `{workspace_root}/.wd_mem/graph/` 下加载已有 JSONL（崩溃恢复：后行覆盖前行），
    /// 并构建内存索引。
    pub fn open(workspace_root: Option<&str>) -> Result<KnowledgeGraph, String> {
        let mut g = KnowledgeGraph {
            base_dir: None,
            nodes: HashMap::new(),
            edges: HashMap::new(),
            adj_from: HashMap::new(),
            adj_to: HashMap::new(),
            seq: AtomicU64::new(0),
        };
        let base = match workspace_root {
            Some(w) => {
                let b = Path::new(w).join(".wd_mem").join(GRAPH_DIR);
                std::fs::create_dir_all(&b)
                    .map_err(|e| format!("创建 .wd_mem/graph 目录失败: {}", e))?;
                // 子目录：会话快照
                let _ = std::fs::create_dir_all(b.join(SESSIONS_SUBDIR));
                Some(b)
            }
            None => None,
        };

        if let Some(ref b) = base {
            g.load_nodes(b)?;
            g.load_edges(b)?;
            // seq 续接：避免与已存在 id 碰撞（n_{epoch}_{seq} 中 seq 取现有最大 +1）。
            let max_seq = g
                .nodes
                .keys()
                .filter_map(|k| k.rsplit('_').next())
                .filter_map(|s| s.parse::<u64>().ok())
                .max()
                .unwrap_or(0);
            g.seq = AtomicU64::new(max_seq + 1);
        }
        g.base_dir = base;
        Ok(g)
    }

    fn load_nodes(&mut self, base: &Path) -> Result<(), String> {
        let path = base.join(NODES_FILE);
        if !path.exists() {
            return Ok(());
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 nodes.jsonl 失败: {}", e))?;
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<GraphNode>(line) {
                Ok(node) => {
                    self.nodes.insert(node.id.clone(), node);
                }
                Err(e) => {
                    tracing::warn!("[graph] nodes.jsonl 存在无法解析的行，跳过：{e}");
                }
            }
        }
        Ok(())
    }

    fn load_edges(&mut self, base: &Path) -> Result<(), String> {
        let path = base.join(EDGES_FILE);
        if !path.exists() {
            return Ok(());
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 edges.jsonl 失败: {}", e))?;
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<GraphEdge>(line) {
                Ok(edge) => {
                    self.insert_adj(&edge);
                    self.edges.insert(edge.id.clone(), edge);
                }
                Err(e) => {
                    tracing::warn!("[graph] edges.jsonl 存在无法解析的行，跳过：{e}");
                }
            }
        }
        Ok(())
    }

    fn insert_adj(&mut self, edge: &GraphEdge) {
        self.adj_from
            .entry(edge.from.clone())
            .or_default()
            .push(edge.id.clone());
        self.adj_to
            .entry(edge.to.clone())
            .or_default()
            .push(edge.id.clone());
    }

    /// 生成唯一 id（`{prefix}_{epochMs}_{seq}`）。
    fn next_id(&self, prefix: &str) -> String {
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        format!("{}_{}_{}", prefix, now_ms(), n)
    }

    /// 创建节点，写入内存并追加一行 JSONL，更新索引。返回节点 id。
    pub fn create_node(&mut self, kind: NodeKind, props: Value) -> String {
        let id = self.next_id("n");
        let now = now_ms();
        let node = GraphNode {
            id: id.clone(),
            kind,
            props,
            created_at: now,
            updated_at: now,
        };
        self.nodes.insert(id.clone(), node);
        self.persist_node(&id);
        self.write_index();
        id
    }

    /// 更新节点 props（浅合并补丁），追加一行 JSONL（覆盖语义），更新索引。
    pub fn update_node(&mut self, id: &str, patch: Value) {
        let changed = if let Some(node) = self.nodes.get_mut(id) {
            if let (Some(obj), Some(patch_obj)) = (node.props.as_object_mut(), patch.as_object()) {
                for (k, v) in patch_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
            node.updated_at = now_ms();
            true
        } else {
            false
        };
        if changed {
            self.persist_node(id);
            self.write_index();
        }
    }

    /// 设置任务节点状态（便捷方法）。
    pub fn set_task_status(&mut self, id: &str, status: &str) {
        self.update_node(id, json!({ "status": status }));
    }

    /// 创建边，写入内存并追加 JSONL。
    pub fn create_edge(&mut self, from: &str, to: &str, relation: EdgeRelation) -> String {
        let id = self.next_id("e");
        let edge = GraphEdge {
            id: id.clone(),
            from: from.to_string(),
            to: to.to_string(),
            relation,
            created_at: now_ms(),
        };
        self.insert_adj(&edge);
        self.edges.insert(id.clone(), edge);
        self.persist_edge(&id);
        id
    }

    fn persist_node(&self, id: &str) {
        if let Some(base) = &self.base_dir {
            if let Some(node) = self.nodes.get(id) {
                let line = match serde_json::to_string(node) {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::warn!("[graph] 序列化节点失败（{}）：{}", id, e);
                        return;
                    }
                };
                append_line(&base.join(NODES_FILE), &line);
            }
        }
    }

    fn persist_edge(&self, id: &str) {
        if let Some(base) = &self.base_dir {
            if let Some(edge) = self.edges.get(id) {
                if let Ok(line) = serde_json::to_string(edge) {
                    append_line(&base.join(EDGES_FILE), &line);
                }
            }
        }
    }

    /// 写 `_index.json`（轻量摘要，可全量注入 system prompt）。
    fn write_index(&self) {
        if let Some(base) = &self.base_dir {
            let mut nodes_idx = serde_json::Map::new();
            for (id, node) in &self.nodes {
                let mut entry = serde_json::Map::new();
                entry.insert(
                    "kind".into(),
                    json!(match node.kind {
                        NodeKind::Session => "session",
                        NodeKind::Task => "task",
                        NodeKind::Artifact => "artifact",
                        NodeKind::FileRef => "file_ref",
                        NodeKind::Memory => "memory",
                        NodeKind::Prompt => "prompt",
                    }),
                );
                if let Some(v) = node.props.get("title").or_else(|| node.props.get("path")) {
                    entry.insert("title".into(), v.clone());
                }
                if let Some(v) = node.props.get("status") {
                    entry.insert("status".into(), v.clone());
                }
                if let Some(v) = node.props.get("step") {
                    entry.insert("step".into(), v.clone());
                }
                if let Some(v) = node.props.get("sessionId") {
                    entry.insert("sessionId".into(), v.clone());
                }
                nodes_idx.insert(id.clone(), Value::Object(entry));
            }
            let sessions = self
                .nodes
                .values()
                .filter(|n| n.kind == NodeKind::Session)
                .count();
            let index = json!({
                "version": 1,
                "updatedAt": now_ms(),
                "nodes": Value::Object(nodes_idx),
                "stats": {
                    "totalNodes": self.nodes.len(),
                    "totalEdges": self.edges.len(),
                    "sessions": sessions,
                }
            });
            if let Ok(s) = serde_json::to_string_pretty(&index) {
                let _ = std::fs::write(base.join(INDEX_FILE), s);
            }
        }
    }

    /// 生成「仅可见、不负责约束」的图摘要，供注入 system prompt（体积受控）。
    ///
    /// 设计铁律（图驱动约束）：图摘要只让模型「看到」工作区已有哪些文件/步骤，
    /// **不作为执行约束**——是否写文件、写到哪一律以用户指令 + 工具返回 + pipeline 硬校验为准。
    /// 故此处绝不全量注入 `_index.json`（会随历史膨胀），只含：
    ///   1. 全局 stats（节点/边/会话计数，恒定小）；
    ///   2. 当前 session 任务链（该会话的 Task 节点 + 其 Wrote/Read/Produced 文件），按会话隔离、天然有界。
    pub fn system_prompt_digest(&self, session_id: Option<&str>) -> String {
        let sessions = self
            .nodes
            .values()
            .filter(|n| n.kind == NodeKind::Session)
            .count();
        let mut body = String::from(
            "### 工作区实体图摘要（仅可见参考，非约束指令）\n\
             以下是当前工作区统一实体图的精简视图，仅供你了解「已有哪些文件 / 步骤」。\n\
             它不构成执行约束：是否创建 / 修改文件、写到哪一路径，一律以用户指令与工具实际返回为准。",
        );
        body.push_str(&format!(
            "\n全局图统计：节点数={}，边数={}，会话数={}",
            self.nodes.len(),
            self.edges.len(),
            sessions,
        ));
        if let Some(sid) = session_id {
            let tasks: Vec<&GraphNode> = self
                .nodes
                .values()
                .filter(|n| n.kind == NodeKind::Task)
                .filter(|n| n.props.get("sessionId").and_then(|v| v.as_str()) == Some(sid))
                .collect();
            if !tasks.is_empty() {
                body.push_str(&format!("\n\n当前会话任务链（{} 个步骤）：", tasks.len()));
                for t in tasks.iter().take(16) {
                    let title = t.props.get("title").and_then(|v| v.as_str()).unwrap_or("(无标题)");
                    let status = t.props.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                    let step = t.props.get("step").and_then(|v| v.as_i64()).unwrap_or(0);
                    body.push_str(&format!("\n  - 步骤{} [{}] {}：", step, status, title));
                    let mut files: Vec<String> = Vec::new();
                    if let Some(outs) = self.adj_from.get(&t.id) {
                        for eid in outs {
                            if let Some(e) = self.edges.get(eid) {
                                let rel = match e.relation {
                                    EdgeRelation::Wrote => "写",
                                    EdgeRelation::Read => "读",
                                    EdgeRelation::Produced => "产物",
                                    _ => continue,
                                };
                                if let Some(target) = self.nodes.get(&e.to) {
                                    let path = target
                                        .props
                                        .get("path")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| target.props.get("title").and_then(|v| v.as_str()))
                                        .unwrap_or("?");
                                    files.push(format!("{}{}", rel, path));
                                }
                            }
                        }
                    }
                    if files.is_empty() {
                        body.push_str("（暂无文件记录）");
                    } else {
                        body.push_str(&files.join("，"));
                    }
                }
            }
        }
        // 体积保护：超长截断（历史非本会话节点不入，正常不会触发；兜底防异常膨胀）。
        let cap = 1500usize;
        if body.chars().count() > cap {
            let truncated: String = body.chars().take(cap).collect();
            format!("{}\n...（摘要已截断，完整图见 .wd_mem/graph/）", truncated)
        } else {
            body
        }
    }

    /// 读取节点（纯内存，不读盘）。
    pub fn get_node(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.get(id)
    }

    /// 取任务节点 props（仅 Task 节点）。
    fn task_props(&self, id: &str) -> Option<&Value> {
        self.nodes
            .get(id)
            .filter(|n| n.kind == NodeKind::Task)
            .map(|n| &n.props)
    }

    /// 某会话下的全部任务节点 id（按 step 升序）。
    fn session_task_ids(&self, session_id: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                n.kind == NodeKind::Task
                    && n.props.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort_by_key(|id| {
            self.nodes
                .get(id)
                .and_then(|n| n.props.get("step").and_then(|v| v.as_u64()))
                .unwrap_or(0)
        });
        ids
    }

    /// 某会话下的全部任务节点（按 step 升序）。
    pub fn session_tasks(&self, session_id: &str) -> Vec<&GraphNode> {
        self.session_task_ids(session_id)
            .iter()
            .filter_map(|id| self.nodes.get(id))
            .collect()
    }

    /// 会话是否全部闭环（所有任务 status ∈ completed/skipped）。
    pub fn session_all_completed(&self, session_id: &str) -> bool {
        let ids = self.session_task_ids(session_id);
        if ids.is_empty() {
            return false;
        }
        ids.iter().all(|id| {
            let s = self
                .nodes
                .get(id)
                .and_then(|n| n.props.get("status").and_then(|v| v.as_str()))
                .unwrap_or("");
            // obsolete 是二次规划/分支重跑时把上一轮节点置为「已被取代」的终态，
            // 视为已解决，否则会污染「全部闭环」判定（详见 pipeline.rs 死锁分支）。
            s == "completed" || s == "skipped" || s == "obsolete"
        })
    }

    /// 拓扑就绪：status ∈ {pending, retrying} 且全部 depends_on 源节点 status ∈ {completed, skipped}。
    /// 注意 `retrying` 也视为就绪：恢复/自动接管重试把节点置 `retrying` 后回到主循环，
    /// 必须能被重新拾起执行（其前置依赖必然已闭环）；否则会被死锁分支误判为卡死。
    pub fn topo_ready(&self, session_id: &str) -> Vec<String> {
        let mut ready = Vec::new();
        for id in self.session_task_ids(session_id) {
            let node = &self.nodes[&id];
            let st = node.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if st != "pending" && st != "retrying" {
                continue;
            }
            let deps: Vec<String> = node
                .props
                .get("depends_on")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let ok = deps.iter().all(|d| {
                self.nodes
                    .get(d)
                    .map(|n| {
                        let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
                        s == "completed" || s == "skipped"
                    })
                    .unwrap_or(false)
            });
            if ok {
                ready.push(id);
            }
        }
        ready
    }

    /// 任务上下文聚合：prior_summary = 会话 initial_context + 前序（step 更小）已完成/跳过任务的产物摘要；
    /// guidance = 本任务节点 guidance 字段。
    pub fn task_context(&self, task_id: &str) -> TaskContext {
        let mut ctx = TaskContext::default();
        let Some(node) = self.nodes.get(task_id) else {
            return ctx;
        };
        let session_id = node
            .props
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let step = node
            .props
            .get("step")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let initial = self.session_initial_context(&session_id);
        let mut parts: Vec<String> = Vec::new();
        if !initial.is_empty() {
            parts.push(initial);
        }
        for id in self.session_task_ids(&session_id) {
            let n = &self.nodes[&id];
            let s = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if s != "completed" && s != "skipped" {
                continue;
            }
            let st = n.props.get("step").and_then(|v| v.as_u64()).unwrap_or(0);
            if st >= step {
                continue;
            }
            if let Some(sum) = n.props.get("summary").and_then(|v| v.as_str()) {
                if !sum.is_empty() {
                    let title = n
                        .props
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    parts.push(format!("步骤 {}「{}」产物：{}", st, title, sum));
                }
            }
        }
        ctx.prior_summary = parts.join("\n");
        ctx.guidance = node
            .props
            .get("guidance")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        ctx
    }

    /// 某任务的直接产物（Artifact 节点，经 Produced 边）。
    pub fn task_artifacts(&self, task_id: &str) -> Vec<&GraphNode> {
        let mut out = Vec::new();
        if let Some(edge_ids) = self.adj_from.get(task_id) {
            for eid in edge_ids {
                if let Some(edge) = self.edges.get(eid) {
                    if edge.relation == EdgeRelation::Produced {
                        if let Some(n) = self.nodes.get(&edge.to) {
                            out.push(n);
                        }
                    }
                }
            }
        }
        out
    }

    /// 把成功闭环产物写图：每个 ArtifactRef → ArtifactNode + Produced 边。
    /// 去冗余：若产物路径已是 `FileRef` 节点（即本步 `add_wrote_files` 已登记 Wrote 边，代码/数据文件归 Wrote），
    /// 则跳过 Produced 边 + Artifact 节点——同一文件只挂 Wrote，避免双节点。画廊产物由
    /// `agent-artifact-created` 事件驱动（与图节点无关），`read_artifact` 按路径读文件，均不受此跳过影响。
    pub fn add_produced_artifacts(
        &mut self,
        task_node_id: &str,
        artifacts: &[ArtifactRef],
        workspace: Option<&Path>,
    ) {
        for ar in artifacts {
            let abs = Self::resolve_abs_path(&ar.path, workspace);
            if self.has_file_ref(&abs) {
                tracing::debug!(
                    "[agent] graph: 产物 {abs} 已是 FileRef（Wrote 边），跳过 Produced 边（去冗余）"
                );
                continue;
            }
            let session_id = self
                .nodes
                .get(task_node_id)
                .and_then(|n| n.props.get("sessionId").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            let props = json!({
                "path": ar.path,
                "artifactType": ar.artifact_type,
                "mimeType": ar.mime_type,
                "description": ar.description,
                "size": ar.size,
                "sessionId": session_id,
            });
            let art_id = self.create_node(NodeKind::Artifact, props);
            self.create_edge(task_node_id, &art_id, EdgeRelation::Produced);
        }
    }

    /// 把路径归一化为绝对字符串（相对路径按 workspace 拼接），供 `FileRef` / 产物去重比较。
    fn resolve_abs_path(raw: &str, workspace: Option<&Path>) -> String {
        let p = Path::new(raw.trim());
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            match workspace {
                Some(w) => w.join(p),
                None => p.to_path_buf(),
            }
        };
        abs.to_string_lossy().to_string()
    }

    /// 该绝对路径是否已是 `FileRef` 节点（写文件已登记 Wrote 边）。
    fn has_file_ref(&self, abs: &str) -> bool {
        self.nodes.values().any(|n| {
            n.kind == NodeKind::FileRef && n.props.get("path").and_then(|v| v.as_str()) == Some(abs)
        })
    }

    /// 抽取：为某路径确保一个 `FileRef` 节点存在（同路径复用同一节点，避免重复建点），返回节点 id。
    /// 阶段二图驱动：读/写文件都登记到同一 `FileRef` 节点，便于后续查询「某文件被哪些步骤读/写」。
    fn ensure_file_ref(&mut self, raw: &str, session_id: &str, workspace: Option<&Path>) -> String {
        let abs_str = Self::resolve_abs_path(raw, workspace);
        for n in self.nodes.values() {
            if n.kind == NodeKind::FileRef
                && n.props.get("path").and_then(|v| v.as_str()) == Some(&abs_str)
            {
                return n.id.clone();
            }
        }
        let props = json!({ "path": abs_str, "sessionId": session_id });
        self.create_node(NodeKind::FileRef, props)
    }

    /// 把本步工具实际写出的文件（write_file/edit_file 的真实落盘路径）写图：
    /// 每个路径 → FileRef 节点（复用 ensure_file_ref）+ Wrote 边。
    /// 与 `add_produced_artifacts`（画廊产物，Produced 边）区分：代码/数据文件归 Wrote，画廊产物归 Produced。
    /// 此处用的是工具执行层的真实产出，是「图驱动约束」的权威来源（非模型 summary 文本抽取）。
    pub fn add_wrote_files(&mut self, task_node_id: &str, files: &[String], workspace: Option<&Path>) {
        let session_id = self
            .nodes
            .get(task_node_id)
            .and_then(|n| n.props.get("sessionId").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        for raw in files {
            let fid = self.ensure_file_ref(raw, &session_id, workspace);
            self.create_edge(task_node_id, &fid, EdgeRelation::Wrote);
        }
    }

    /// 把本步工具实际读取的文件（read_file 的真实路径）写图：
    /// 每个路径 → FileRef 节点（复用 ensure_file_ref）+ Read 边。
    /// 记录「哪一步读了哪些文件」，为阶段二 `native__query_graph` 检索与跨步上下文提供真实数据。
    pub fn add_read_files(&mut self, task_node_id: &str, files: &[String], workspace: Option<&Path>) {
        let session_id = self
            .nodes
            .get(task_node_id)
            .and_then(|n| n.props.get("sessionId").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        for raw in files {
            let fid = self.ensure_file_ref(raw, &session_id, workspace);
            self.create_edge(task_node_id, &fid, EdgeRelation::Read);
        }
    }

    /// 按关键词搜索节点（标题/描述/路径模糊匹配），可选 kind 过滤。
    /// 设计内查询 API（供前端图浏览/检索使用），当前流水线主干尚未接调用方，标记 allow。
    #[allow(dead_code)]
    pub fn search(&self, keyword: &str, kind: Option<NodeKind>, limit: usize) -> Vec<&GraphNode> {
        let kw = keyword.to_lowercase();
        let mut out: Vec<&GraphNode> = self
            .nodes
            .values()
            .filter(|n| kind.map(|k| k == n.kind).unwrap_or(true))
            .filter(|n| {
                if kw.is_empty() {
                    return true;
                }
                let hay = match n.kind {
                    NodeKind::Task => n
                        .props
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase(),
                    NodeKind::Artifact | NodeKind::FileRef => n
                        .props
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase(),
                    _ => n
                        .props
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase(),
                };
                hay.contains(&kw)
            })
            .take(limit)
            .collect();
        out.sort_by_key(|n| n.created_at);
        out
    }

    /// 反查某会话下指定 task_id（PlanSubTask.task_id）对应的图节点 id。
    pub fn find_task_node(&self, session_id: &str, task_id: &str) -> Option<String> {
        self.session_task_ids(session_id)
            .into_iter()
            .find(|id| {
                self.nodes
                    .get(id)
                    .and_then(|n| n.props.get("taskId").and_then(|v| v.as_str()))
                    == Some(task_id)
            })
    }

    /// 读取会话目标摘要（goal_summary）。
    /// 注：最终答复已不再前置该摘要（去用户问题重复），此方法保留供后续检索/调试使用。
    #[allow(dead_code)]
    pub fn session_goal(&self, session_id: &str) -> String {
        self.nodes
            .values()
            .find(|n| {
                n.kind == NodeKind::Session
                    && n.props.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
            })
            .and_then(|n| n.props.get("goalSummary").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string()
    }

    /// 读取会话 initial_context（分支重跑基底）。
    fn session_initial_context(&self, session_id: &str) -> String {
        self.nodes
            .values()
            .find(|n| {
                n.kind == NodeKind::Session
                    && n.props.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
            })
            .and_then(|n| n.props.get("initialContext").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string()
    }

    /// 设置会话 initial_context（分支重跑：run_task 在 plan_to_graph 后写入）。
    pub fn set_session_initial_context(&mut self, session_id: &str, initial_context: &str) {
        if let Some(id) = self
            .nodes
            .values()
            .find(|n| {
                n.kind == NodeKind::Session
                    && n.props.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
            })
            .map(|n| n.id.clone())
        {
            self.update_node(&id, json!({ "initialContext": initial_context }));
        }
    }

    /// 将 PlanDAG 写入图：每个 step → TaskNode（含 depends_on 边、BelongsTo 边），
    /// SessionNode 承载 goal_summary/initialContext。同 sessionId 旧节点置 obsolete（支持分支重跑）。
    pub fn plan_to_graph(&mut self, plan: &PlanDAG, session_id: &str) {
        // 分支重跑/二次规划：把同会话旧节点置 obsolete，避免 topo_ready 混入上一轮任务。
        for id in self.session_task_ids(session_id) {
            self.set_task_status(&id, "obsolete");
        }
        let session_node_ids: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                n.kind == NodeKind::Session
                    && n.props.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in session_node_ids {
            self.set_task_status(&id, "obsolete");
        }

        let session_id_node = self.create_node(
            NodeKind::Session,
            json!({
                "title": plan.goal_summary,
                "status": "running",
                "intent": "COMPOSITE_TASK",
                "riskLevel": "low",
                "sessionId": session_id,
                "goalSummary": plan.goal_summary,
                "initialContext": "",
            }),
        );

        let mut node_ids: HashMap<String, String> = HashMap::new();
        for t in &plan.tasks {
            let node_id = self.create_node(
                NodeKind::Task,
                json!({
                    "title": t.title,
                    "description": t.description,
                    "status": "pending",
                    "step": t.step,
                    "sessionId": session_id,
                    "taskId": t.task_id,
                    "dependsOn": t.depends_on,
                    "successCriteria": t.success_criteria,
                    "guidance": null,
                    "retryCount": 0,
                    "summary": null,
                    "failureReason": null,
                    "tokenInput": 0,
                    "tokenOutput": 0,
                    "durationMs": null,
                    "startedAt": null,
                    "completedAt": null,
                }),
            );
            node_ids.insert(t.task_id.clone(), node_id.clone());
            self.create_edge(&session_id_node, &node_id, EdgeRelation::BelongsTo);
        }
        for t in &plan.tasks {
            if let Some(nid) = node_ids.get(&t.task_id) {
                for dep in &t.depends_on {
                    if let Some(dnid) = node_ids.get(dep) {
                        self.create_edge(dnid, nid, EdgeRelation::DependsOn);
                    }
                }
            }
        }
    }

    /// 从任务节点 props 重建 PlanSubTask（供 run_subtask 调度）。
    pub fn task_to_plan(&self, id: &str) -> Option<PlanSubTask> {
        let props = self.task_props(id)?;
        let step = props.get("step").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let task_id = props
            .get("taskId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = props
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let description = props
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let success_criteria: Vec<SuccessCriterion> = props
            .get("successCriteria")
            .and_then(|v| serde_json::from_value::<Vec<SuccessCriterion>>(v.clone()).ok())
            .unwrap_or_default();
        let depends_on: Vec<String> = props
            .get("dependsOn")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        Some(PlanSubTask {
            step,
            task_id,
            title,
            description,
            success_criteria,
            depends_on,
        })
    }

    /// 保存会话子图快照（`graph/sessions/{session_id}.json`）：会话节点 + 其任务 + 产物 + 相关边。
    pub fn snapshot(&self, session_id: &str) {
        if let Some(base) = &self.base_dir {
            let session_nodes: Vec<&GraphNode> = self
                .nodes
                .values()
                .filter(|n| {
                    n.kind == NodeKind::Session
                        && n.props.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
                })
                .collect();
            if session_nodes.is_empty() {
                return;
            }
            let task_ids: Vec<String> = self.session_task_ids(session_id);
            let mut artifact_ids: Vec<String> = Vec::new();
            for tid in &task_ids {
                for a in self.task_artifacts(tid) {
                    artifact_ids.push(a.id.clone());
                }
            }
            let keep: std::collections::HashSet<&String> = session_nodes
                .iter()
                .map(|n| &n.id)
                .chain(task_ids.iter())
                .chain(artifact_ids.iter())
                .collect();
            let nodes: Vec<&GraphNode> = self.nodes.values().filter(|n| keep.contains(&n.id)).collect();
            let edges: Vec<&GraphEdge> = self
                .edges
                .values()
                .filter(|e| keep.contains(&e.from) && keep.contains(&e.to))
                .collect();
            let snap = json!({
                "sessionId": session_id,
                "nodes": nodes,
                "edges": edges,
            });
            if let Ok(s) = serde_json::to_string_pretty(&snap) {
                let _ = std::fs::write(
                    base.join(SESSIONS_SUBDIR).join(format!("{}.json", session_id)),
                    s,
                );
            }
        }
    }
}

/// 追加一行到文件（无则创建）。
fn append_line(path: &Path, line: &str) {
    use std::io::Write;
    match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut f) => {
            let _ = f.write_all(line.as_bytes());
            let _ = f.write_all(b"\n");
        }
        Err(e) => {
            tracing::warn!("[graph] 追加写 {} 失败：{}", path.display(), e);
        }
    }
}

/// 极简时间戳（毫秒）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
