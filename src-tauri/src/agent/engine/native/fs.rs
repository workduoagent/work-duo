//! 文件域工具：read/write/edit/list/exists/delete/move/grep/zip/regex（S1 拆分自 native.rs，台账 §2.1）。

//! 系统原生工具（对应方案步骤 2）。
//!
//! 提供一组最小可用的本地工具，全部纳入 `native__` 命名空间：
//!  - `native__read_file`：读取工作空间内文本文件（ReadSafe）；
//!  - `native__write_file`：写入/覆盖文件（RequireApproval，sensitive）；
//!  - `native__edit_file`：字符串替换式改文件（RequireApproval，sensitive，审批弹窗走 Diff）；
//!  - `native__list_directory`：列出目录内容（ReadSafe）；
//!  - `native__path_exists`：判断路径（文件/目录）是否存在及类型（ReadSafe，list/edit/read/write 的强制前置闭环）；
//!  - `native__execute_command`：执行系统命令（RequireApproval，sensitive）；
//!  - `native__run_python_sandbox`：在 micromamba 沙箱环境运行 Python 脚本（RequireApproval）。
//!
//! 所有文件操作都经 `PathGuard` 校验，约束在 workspace 内；沙箱执行复用 `mamba_manager`
//! 的 `run_python_script` 命令（不新建运行时）。

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::io::Write;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;

use crate::agent::engine::tools::AgentTool;
use crate::agent::engine::tools::ToolBehavior;
use crate::agent::engine::tools::PathGuard;
use crate::agent::engine::tools::PermissionLevel;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolError;

use std::path::Path;
use std::path::PathBuf;

// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipArchive;
use zip::ZipWriter;

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
use regex::Regex;
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。

/// read_file 体积上限（问题 6 修复）：超过该值的文件不读入内存，直接拒绝并引导改用沙箱分段处理。
/// 2MB 读入内存可接受（返回值再由 truncate_tool_output 截到约 15KB）；再大则为截断而全读不值得。
const MAX_READ_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// zip 打包总大小上限（与 zip_extract 的 500MB 解体对称）：待打包源文件累计超过该值直接拒绝，防磁盘写满。
const MAX_ZIP_TOTAL_BYTES: u64 = 1024 * 1024 * 1024; // 1GB
/// grep_files 遍历深度上限：防符号链接环 / 极端嵌套导致的无限递归。
const MAX_GREP_DEPTH: usize = 20;

/// zip 解压防御上限（防 zip 炸弹）：单包条目数 / 解压后总大小。
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ZIP_EXTRACT_BYTES: u64 = 500 * 1024 * 1024;

/// 构造标准 function-calling 定义骨架。

use super::*;


/// 用正则表达式在文件中做模式替换（与 `native__edit_file` 的字面唯一替换互补）。
/// 全程与 edit_file 同构的 PathGuard + probe + TOCTOU 读写；正则语法错误返回 InvalidArgs 让模型自纠。
pub struct RegexReplaceTool;

#[async_trait]
impl AgentTool for RegexReplaceTool {
    fn name(&self) -> String {
        "native__regex_replace".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("replace"),
            file_mutating: true,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__regex_replace",
            "用正则表达式在文件中做模式替换（支持 $1 / $2 捕获组），与 native__edit_file（字面唯一替换）互补。需用户审批。\
             执行前应先调用 native__path_exists 确认目标文件存在且为文件。正则语法错误会返回明确提示供模型自行纠正；\
             替换结果超过 2MB 拒绝写回。",
            json!({
                "path": { "type": "string", "description": "目标文件路径（须在工作空间内）" },
                "pattern": { "type": "string", "description": "Rust 正则语法（regex crate），如 (?s)<div>.*?</div>" },
                "replacement": { "type": "string", "description": "替换文本，支持 $1 / $2 等捕获组引用" },
                "all": { "type": "boolean", "description": "true=替换全部匹配（默认）；false=仅替换第一个" }
            }),
            &["path", "pattern", "replacement"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("regex_replace 缺少 path 参数".into()))?;
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("regex_replace 缺少 pattern 参数".into()))?;
        let replacement = args
            .get("replacement")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let all = args.get("all").and_then(|v| v.as_bool()).unwrap_or(true);

        let abs = PathGuard::check(path, ctx)?;
        tracing::info!(
            "[agent] native__regex_replace: 开始 path={} resolved={} pattern={}",
            path,
            abs.display(),
            crate::agent::engine::runtime::clip(pattern, 300)
        );
        let started = Instant::now();
        // 闭环前置检查（统一复用 probe_path）。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "文件不存在：{}（请先用 native__path_exists 确认）",
                abs.display()
            )));
        }
        if probe.is_dir {
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（无法编辑目录）",
                abs.display()
            )));
        }
        // TOCTOU：先开句柄 → 校验真实物理路径 → 再读内容（与 edit_file 对齐）。
        let mut file = File::open(&abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取失败：{e}")))?;
        PathGuard::verify_opened(&abs, &file, ctx)?;
        // 体积预检（P1 #5）：与 read_file 同阈值，避免超大文件整读入内存 OOM。
        let meta_len = file
            .metadata()
            .map_err(|e| ToolError::ExecutionFailed(format!("读取文件元信息失败：{e}")))?
            .len();
        if meta_len > MAX_READ_FILE_BYTES {
            return Err(ToolError::ExecutionFailed(format!(
                "文件 {} 字节超过 {} 上限，拒绝读取（请改用沙箱分段处理或缩小范围）",
                meta_len, MAX_READ_FILE_BYTES
            )));
        }
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取失败：{e}")))?;

        let re = match Regex::new(pattern) {
            Ok(re) => re,
            Err(e) => return Err(ToolError::InvalidArgs(format!("正则表达式语法错误：{e}"))),
        };
        let count = re.find_iter(&content).count();
        if count == 0 {
            return Ok(format!("未匹配到任何内容（pattern={}），文件未改动", pattern));
        }
        let updated: String = if all {
            re.replace_all(&content, replacement.as_str()).into_owned()
        } else {
            re.replace(&content, replacement.as_str()).into_owned()
        };
        // 2MB 阈值：替换结果过大拒绝写回（与 read_file 阈值对齐）。
        if (updated.len() as u64) > MAX_READ_FILE_BYTES {
            return Err(ToolError::ExecutionFailed(format!(
                "替换后内容超过 {} 字节上限，拒绝写回（请缩小范围或分批处理）",
                MAX_READ_FILE_BYTES
            )));
        }
        // 写回：打开不截断 → verify_opened → set_len(0) → write_all（与 edit_file 同构 TOCTOU）。
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(false)
            .open(&abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
        PathGuard::verify_opened(&abs, &file, ctx)?;
        file.set_len(0)
            .map_err(|e| ToolError::ExecutionFailed(format!("清空原文件失败：{e}")))?;
        file.write_all(updated.as_bytes())
            .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
        tracing::info!(
            "[agent] native__regex_replace: 成功 path={} 替换数={} 耗时={}ms",
            abs.display(),
            count,
            started.elapsed().as_millis()
        );
        Ok(format!("已在 {} 完成 {} 处替换", abs.display(), count))
    }
}


pub struct ZipExtractTool;

#[async_trait]
impl AgentTool for ZipExtractTool {
    fn name(&self) -> String {
        "native__zip_extract".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("unzip"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__zip_extract",
            "解压 zip 到工作空间内目标目录（防 zip-slip）。需用户审批。\
             默认解压到 zip 同名目录（去掉 .zip）；zip_path 必须是 .zip 文件。\
             含越界条目（../ 或绝对路径）的 zip 整体拒绝；符号链接条目跳过；条目数上限 10000，解压总大小上限 500MB。",
            json!({
                "zip_path": { "type": "string", "description": "zip 文件路径（须在工作空间内，扩展名 .zip）" },
                "dest": { "type": "string", "description": "解压目标目录（须在工作空间内），默认 zip 同名目录（去掉 .zip）" }
            }),
            &["zip_path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let zip_path = args
            .get("zip_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("zip_extract 缺少 zip_path 参数".into()))?;
        let zip_abs = PathGuard::check(zip_path, ctx)?;
        let zip_probe = probe_path(&zip_abs);
        if let Some(err) = zip_probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问 zip：{}（{}）",
                zip_abs.display(),
                err
            )));
        }
        if !zip_probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 不存在：{}",
                zip_abs.display()
            )));
        }
        if zip_probe.is_dir {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 路径是目录而非文件：{}",
                zip_abs.display()
            )));
        }
        if zip_abs.extension().and_then(|e| e.to_str()) != Some("zip") {
            return Err(ToolError::ExecutionFailed(format!(
                "不是 .zip 文件：{}（仅支持 zip 解压）",
                zip_abs.display()
            )));
        }
        // 目标目录
        let dest_abs = match args.get("dest").and_then(|v| v.as_str()) {
            Some(d) if !d.is_empty() => PathGuard::check(d, ctx)?,
            _ => {
                let stem = zip_abs
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let parent = zip_abs.parent().unwrap_or_else(|| Path::new("."));
                let default_dest = parent.join(stem);
                PathGuard::check(&default_dest.to_string_lossy(), ctx)?
            }
        };
        let ws = ctx
            .workspace
            .clone()
            .expect("PathGuard::check 已保证 workspace 存在");
        if norm_for_cmp(&dest_abs) == norm_for_cmp(&ws) {
            return Err(ToolError::PermissionDenied("禁止解压到工作空间根目录".into()));
        }
        if path_has_segment(&dest_abs, ".wd_mem") || path_has_segment(&dest_abs, ".attachments") {
            return Err(ToolError::PermissionDenied(format!(
                "目标不能落入系统目录：{}",
                dest_abs.display()
            )));
        }
        let dest_pre_existed = probe_path(&dest_abs).exists;
        // 预检：条目数与总大小上限（防 zip 炸弹）
        let file = File::open(&zip_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("打开 zip 失败：{e}")))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取 zip 失败：{e}")))?;
        if archive.len() as usize > MAX_ZIP_ENTRIES {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 条目数 {} 超过上限 {}（疑似 zip 炸弹）",
                archive.len(),
                MAX_ZIP_ENTRIES
            )));
        }
        let mut total_size: u64 = 0;
        for i in 0..archive.len() {
            let ent = archive
                .by_index(i)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取 zip 条目失败：{e}")))?;
            if !ent.is_dir() {
                total_size = total_size.saturating_add(ent.size());
            }
        }
        if total_size > MAX_ZIP_EXTRACT_BYTES {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 解压总大小 {} 字节超过上限 {} 字节（疑似 zip 炸弹）",
                total_size, MAX_ZIP_EXTRACT_BYTES
            )));
        }
        // 解压
        std::fs::create_dir_all(&dest_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("创建目标目录失败：{e}")))?;
        let mut file_count: u64 = 0;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取 zip 条目失败：{e}")))?;
            let name = entry.name().to_string().replace('\\', "/");
            // 消毒 + zip-slip 防御：含绝对路径或 .. 的条目整体拒绝
            if name.starts_with('/') || name.contains("..") {
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(ToolError::ExecutionFailed(
                    "zip 含越界条目（绝对路径或 ..），拒绝解压（zip-slip 防御）".into(),
                ));
            }
            // 逐段拼装目标路径（避免分隔符歧义），并再确认在 dest 内
            let mut target = dest_abs.to_path_buf();
            for part in name.split('/') {
                if part.is_empty() || part == "." {
                    continue;
                }
                target.push(part);
            }
            if !within_parent(&target, &dest_abs) {
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(ToolError::ExecutionFailed(
                    "zip 条目逃逸目标目录，拒绝解压（zip-slip 防御）".into(),
                ));
            }
            if entry.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|e| ToolError::ExecutionFailed(format!("创建目录失败：{e}")))?;
                continue;
            }
            if entry.is_symlink() {
                // 跳过符号链接条目（攻击面）
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
            }
            let mut out = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&target)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建解压文件失败：{e}")))?;
            if let Err(e) = PathGuard::verify_opened(&target, &out, ctx) {
                let _ = out.set_len(0);
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(e);
            }
            if let Err(e) = out.set_len(0) {
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(ToolError::ExecutionFailed(format!("清空目标文件失败：{e}")));
            }
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| ToolError::ExecutionFailed(format!("解压写入失败：{e}")))?;
            file_count += 1;
        }
        let size = dir_size(&dest_abs);
        Ok(format!(
            "已解压 {} 到 {}（{} 个文件，共 {} 字节）",
            zip_abs.display(),
            dest_abs.display(),
            file_count,
            size
        ))
    }
}


pub struct ZipCreateTool;

#[async_trait]
impl AgentTool for ZipCreateTool {
    fn name(&self) -> String {
        "native__zip_create".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("zip"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__zip_create",
            "将工作空间内的一个或多个目录 / 文件打包为 zip（deflate 压缩）。需用户审批。\
             source 可为单个路径或路径数组；目录会递归收集内部文件（跳过 .git / node_modules 等）。\
             输出路径不能落在 source 目录内（避免自包含越滚越大）。",
            json!({
                "source": { "type": "array", "description": "要打包的路径：单一字符串或字符串数组（每项须在工作空间内），如 \"src/\" 或 [\"data/\", \"report.md\"]" },
                "output": { "type": "string", "description": "输出 zip 路径（须在工作空间内），如 output/pkg.zip" }
            }),
            &["source", "output"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        // source：兼容字符串或数组
        let sources: Vec<String> = match args.get("source") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => {
                return Err(ToolError::InvalidArgs(
                    "zip_create 缺少 source 参数（字符串或数组）".into(),
                ))
            }
        };
        if sources.is_empty() {
            return Err(ToolError::InvalidArgs("zip_create 的 source 为空".into()));
        }
        let output = args
            .get("output")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("zip_create 缺少 output 参数".into()))?;
        let output_abs = PathGuard::check(output, ctx)?;
        // 输出已存在且为目录 → 拒绝
        let out_probe = probe_path(&output_abs);
        if out_probe.exists && out_probe.is_dir {
            return Err(ToolError::ExecutionFailed(format!(
                "输出路径已存在且为目录：{}（请换一个输出文件名）",
                output_abs.display()
            )));
        }
        if let Some(parent) = output_abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建输出父目录失败：{e}")))?;
        }
        // 收集 (entry 名, 绝对路径)
        let mut entries: Vec<(String, PathBuf)> = Vec::new();
        for src in &sources {
            let src_abs = PathGuard::check(src, ctx)?;
            let src_probe = probe_path(&src_abs);
            if let Some(err) = src_probe.access_err {
                return Err(ToolError::ExecutionFailed(format!(
                    "无法访问源路径：{}（{}）",
                    src_abs.display(),
                    err
                )));
            }
            if !src_probe.exists {
                return Err(ToolError::ExecutionFailed(format!(
                    "源路径不存在：{}",
                    src_abs.display()
                )));
            }
            // 自包含防御：输出不能落在目录型 source 之内
            if src_probe.is_dir && within_parent(&output_abs, &src_abs) {
                return Err(ToolError::ExecutionFailed(format!(
                    "输出路径不能在源目录内：{} 位于 {} 之内",
                    output_abs.display(),
                    src_abs.display()
                )));
            }
            let src_rel = src.trim().trim_matches('/').trim_start_matches("./").to_string();
            if src_probe.is_dir {
                collect_dir(&src_abs, &src_rel, &mut entries)?;
            } else {
                let name = src_abs
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| ToolError::ExecutionFailed("无法解析源文件名".into()))?
                    .to_string();
                entries.push((sanitize_entry(&name), src_abs.clone()));
            }
        }
        if entries.is_empty() {
            return Err(ToolError::ExecutionFailed(
                "未收集到任何可打包的文件（源目录可能为空或仅含被跳过项）".into(),
            ));
        }
        // 总大小上限（P1 #7，与 zip_extract 的 500MB 解体对称）：累加源文件体积，超限直接拒绝，防磁盘写满。
        let mut total_bytes: u64 = 0;
        for (_, p) in &entries {
            if let Ok(m) = std::fs::metadata(p) {
                total_bytes += m.len();
            }
            if total_bytes > MAX_ZIP_TOTAL_BYTES {
                return Err(ToolError::ExecutionFailed(format!(
                    "待打包文件总大小 {} 字节超过 {} 上限，拒绝打包（请缩小范围或分批）",
                    total_bytes, MAX_ZIP_TOTAL_BYTES
                )));
            }
        }
        let file = File::create(&output_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("创建 zip 失败：{e}")))?;
        let mut zip = ZipWriter::new(file);
        // P3 #14：Unix 下显式设置归档条目权限位（0644），避免权限丢失；Windows 无意义故跳过。
        #[cfg(unix)]
        let options: FileOptions<'_, ()> = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        #[cfg(not(unix))]
        let options: FileOptions<'_, ()> =
            FileOptions::default().compression_method(CompressionMethod::Deflated);
        for (entry_name, abs_path) in &entries {
            zip.start_file(entry_name, options)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入 zip 条目失败：{e}")))?;
            let mut f = File::open(abs_path)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取源文件失败：{e}")))?;
            std::io::copy(&mut f, &mut zip)
                .map_err(|e| ToolError::ExecutionFailed(format!("压缩写入失败：{e}")))?;
        }
        zip.finish()
            .map_err(|e| ToolError::ExecutionFailed(format!("关闭 zip 失败：{e}")))?;
        let size = std::fs::metadata(&output_abs).map(|m| m.len()).unwrap_or(0);
        Ok(format!(
            "已创建 {}（{} 个文件，共 {} 字节）",
            output_abs.display(),
            entries.len(),
            size
        ))
    }
}


pub struct GrepFilesTool;

#[async_trait]
impl AgentTool for GrepFilesTool {
    fn name(&self) -> String {
        "native__grep_files".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("search"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__grep_files",
            "在工作空间内递归检索子串（区分大小写，不支持正则），返回命中行的 path:line:text。\
             仅读取文本文件，自动跳过 .git / node_modules / target / __pycache__ / .wd_mem / .attachments 与二进制文件；\
             单文件超过 2MB 跳过，结果上限由 max_results 控制（硬上限 200）。不触发审批。",
            json!({
                "keyword": { "type": "string", "description": "检索关键词（子串匹配，区分大小写）" },
                "path": { "type": "string", "description": "检索起始目录（相对工作空间），默认工作空间根" },
                "max_results": { "type": "integer", "description": "最大返回条数，默认 50，上限 200" },
                "file_glob": { "type": "string", "description": "文件名通配（如 *.rs），支持 * 与 ?，默认全部文本文件" }
            }),
            &["keyword"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let keyword = args
            .get("keyword")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("grep_files 缺少 keyword 参数".into()))?;
        if keyword.is_empty() {
            return Err(ToolError::InvalidArgs("grep_files 的 keyword 为空".into()));
        }
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(50)
            .min(200) as usize;
        let file_glob = args
            .get("file_glob")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let root = PathGuard::check(path, ctx)?;
        // 遍历深度上限（P1 #8）：防符号链接环 / 极端嵌套导致的无限递归。
        let mut stack: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];
        let mut results: Vec<String> = Vec::new();
        let mut scanned: u32 = 0;
        let mut non_utf8: u32 = 0;
        'walk: while let Some((dir, depth)) = stack.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let p = entry.path();
                let is_dir = match entry.file_type() {
                    Ok(ft) => ft.is_dir(),
                    Err(_) => continue,
                };
                if is_dir {
                    if is_skipped_dir(&entry.file_name().to_string_lossy()) {
                        continue;
                    }
                    if depth + 1 <= MAX_GREP_DEPTH {
                        stack.push((p, depth + 1));
                    }
                } else {
                    scanned += 1;
                    if let Some(glob) = &file_glob {
                        if !glob.is_empty() && !glob_match(glob, &entry.file_name().to_string_lossy()) {
                            continue;
                        }
                    }
                    let meta = match entry.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if meta.len() > MAX_READ_FILE_BYTES {
                        continue;
                    }
                    // 二进制探测：前 8KB 含 \0 则跳过
                    let head = {
                        let mut f = match File::open(&p) {
                            Ok(f) => f,
                            Err(_) => continue,
                        };
                        let mut buf = [0u8; 8192];
                        match f.read(&mut buf) {
                            Ok(n) => buf[..n].to_vec(),
                            Err(_) => continue,
                        }
                    };
                    if head.contains(&0) {
                        continue;
                    }
                    let content = match std::fs::read_to_string(&p) {
                        Ok(c) => c,
                        Err(_) => {
                            non_utf8 += 1; // P2 #12：非 UTF-8 / 不可读文本文件，统计后跳过并在结果中报告
                            continue;
                        }
                    };
                    for (i, line) in content.lines().enumerate() {
                        if line.contains(keyword) {
                            let trimmed = if line.chars().count() > 200 {
                                format!("{}…", line.chars().take(200).collect::<String>())
                            } else {
                                line.to_string()
                            };
                            let rel = p.strip_prefix(&root).unwrap_or(&p);
                            results.push(format!("{}:{}:{}", rel.display(), i + 1, trimmed));
                            if results.len() >= max_results {
                                break 'walk;
                            }
                        }
                    }
                }
            }
        }
        if results.is_empty() {
            Ok(format!(
                "未找到包含「{}」的内容（扫描了 {} 个文件）",
                keyword, scanned
            ))
        } else {
            let joined = results.join("\n");
            // 达 max_results 时无法区分「恰好命中这么多」与「被截断」：保守标注截断提示，
            // 引导用户收窄关键词或 file_glob 以确认是否还有更多命中。
            let truncated_note = if results.len() >= max_results {
                format!(
                    "\n（结果已达上限 {}，可能还有更多命中；请收窄关键词或 file_glob 继续检索）",
                    max_results
                )
            } else {
                String::new()
            };
            // P2 #12：非 UTF-8 / 不可读文本文件被静默跳过，此处汇总报告，避免用户误以为「扫描完整」。
            let non_utf8_note = if non_utf8 > 0 {
                format!("\n（另有 {} 个文件因非 UTF-8 / 不可读文本被跳过）", non_utf8)
            } else {
                String::new()
            };
            Ok(format!(
                "命中 {} 条（上限 {}）：\n{}{}{}",
                results.len(),
                max_results,
                joined,
                truncated_note,
                non_utf8_note
            ))
        }
    }
}


pub struct MovePathTool;

#[async_trait]
impl AgentTool for MovePathTool {
    fn name(&self) -> String {
        "native__move_path".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("move"),
            file_mutating: true,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__move_path",
            "移动 / 重命名工作空间内的文件或目录。需用户审批。\
             目标已存在时默认报错，传 overwrite=true 可覆盖文件（不会静默替换目录）。\
             src 与 dst 都须在工作空间内；.wd_mem / .attachments 受保护，dst 不能落入其中。",
            json!({
                "src": { "type": "string", "description": "源路径（须在工作空间内）" },
                "dst": { "type": "string", "description": "目标路径（须在工作空间内）" },
                "overwrite": { "type": "boolean", "description": "目标已存在时是否覆盖，默认 false" }
            }),
            &["src", "dst"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let src = args.get("src").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("move_path 缺少 src 参数".into())
        })?;
        let dst = args.get("dst").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("move_path 缺少 dst 参数".into())
        })?;
        let overwrite = args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
        let ws = ctx
            .workspace
            .clone()
            .expect("PathGuard::check 已保证 workspace 存在");
        let src_abs = PathGuard::check(src, ctx)?;
        let dst_abs = PathGuard::check(dst, ctx)?;
        // 安全边界
        if norm_for_cmp(&src_abs) == norm_for_cmp(&ws) {
            return Err(ToolError::PermissionDenied("禁止移动工作空间根目录".into()));
        }
        if path_has_segment(&dst_abs, ".wd_mem") || path_has_segment(&dst_abs, ".attachments") {
            return Err(ToolError::PermissionDenied(format!(
                "目标不能落入系统目录：{}（.wd_mem / .attachments 受保护）",
                dst_abs.display()
            )));
        }
        let src_probe = probe_path(&src_abs);
        if let Some(err) = src_probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问源路径：{}（{}）",
                src_abs.display(),
                err
            )));
        }
        if !src_probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "源路径不存在：{}",
                src_abs.display()
            )));
        }
        let dst_probe = probe_path(&dst_abs);
        if let Some(err) = dst_probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问目标路径：{}（{}）",
                dst_abs.display(),
                err
            )));
        }
        if dst_probe.exists {
            if !overwrite {
                return Err(ToolError::ExecutionFailed(format!(
                    "目标已存在：{}（传 overwrite=true 可覆盖文件）",
                    dst_abs.display()
                )));
            }
            if dst_probe.is_dir {
                return Err(ToolError::ExecutionFailed(format!(
                    "目标是目录，无法覆盖：{}（不要静默递归替换目录）",
                    dst_abs.display()
                )));
            }
            // 原子覆盖（P1 #6）：先把目标备份到临时名，再 rename 源→目标；
            // 若 rename 失败则回滚备份，保证原目标内容不丢失（尤其跨设备失败场景）。
            let bak = dst_abs.with_added_extension("wbak");
            std::fs::rename(&dst_abs, &bak)
                .map_err(|e| ToolError::ExecutionFailed(format!("覆盖前备份目标失败：{e}")))?;
            match std::fs::rename(&src_abs, &dst_abs) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&bak); // 成功：删备份
                    let kind = if src_probe.is_dir { "目录" } else { "文件" };
                    return Ok(format!(
                        "已将{} {} 移动到 {}（覆盖原目标）",
                        kind,
                        src_abs.display(),
                        dst_abs.display()
                    ));
                }
                Err(e) => {
                    let _ = std::fs::rename(&bak, &dst_abs); // 回滚：恢复原目标
                    if e.kind() == std::io::ErrorKind::CrossesDevices {
                        return Err(ToolError::ExecutionFailed(
                            "跨文件系统移动暂不支持（rename 跨设备失败），请改用 read + write + delete 分步完成".into(),
                        ));
                    }
                    return Err(ToolError::ExecutionFailed(format!("移动失败：{e}")));
                }
            }
        }
        // 目标不存在：常规重命名。
        if let Some(parent) = dst_abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建目标父目录失败：{e}")))?;
        }
        match std::fs::rename(&src_abs, &dst_abs) {
            Ok(()) => {
                let kind = if src_probe.is_dir { "目录" } else { "文件" };
                Ok(format!(
                    "已将{} {} 移动到 {}",
                    kind,
                    src_abs.display(),
                    dst_abs.display()
                ))
            }
            Err(e) => {
                // 跨设备等 rename 失败：首版直接报错提示，不做 copy + remove 降级。
                if e.kind() == std::io::ErrorKind::CrossesDevices {
                    Err(ToolError::ExecutionFailed(
                        "跨文件系统移动暂不支持（rename 跨设备失败），请改用 read + write + delete 分步完成".into(),
                    ))
                } else {
                    Err(ToolError::ExecutionFailed(format!("移动失败：{e}")))
                }
            }
        }
    }
}


pub struct DeletePathTool;

#[async_trait]
impl AgentTool for DeletePathTool {
    fn name(&self) -> String {
        "native__delete_path".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("delete"),
            file_mutating: true,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__delete_path",
            "删除工作空间内的文件或目录（CRUD 的 D）。需用户审批。删除非空目录需传 recursive=true。\
             .wd_mem / .attachments 系统目录与工作空间根目录受保护不可删；执行前可先调用 native__path_exists 确认路径类型。",
            json!({
                "path": { "type": "string", "description": "要删除的文件或目录路径（须在工作空间内）" },
                "recursive": { "type": "boolean", "description": "目录是否递归删除，默认 false（仅删空目录；非空目录需传 true）" }
            }),
            &["path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("delete_path 缺少 path 参数".into())
        })?;
        let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
        let abs = PathGuard::check(path, ctx)?;
        // 安全边界：保护系统目录与 workspace 根（与 PathGuard 越界拦截互补）。
        let ws = ctx
            .workspace
            .clone()
            .expect("PathGuard::check 已保证 workspace 存在");
        if norm_for_cmp(&abs) == norm_for_cmp(&ws) {
            return Err(ToolError::PermissionDenied("禁止删除工作空间根目录".into()));
        }
        if path_has_segment(&abs, ".wd_mem") {
            return Err(ToolError::PermissionDenied(format!(
                "禁止删除系统目录：{}（.wd_mem 受保护）",
                abs.display()
            )));
        }
        if path_has_segment(&abs, ".attachments") {
            return Err(ToolError::PermissionDenied(format!(
                "禁止删除系统目录：{}（.attachments 受保护）",
                abs.display()
            )));
        }
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "路径不存在：{}（请先用 native__path_exists 确认）",
                abs.display()
            )));
        }
        if probe.is_dir {
            let empty = std::fs::read_dir(&abs)
                .map(|mut rd| rd.next().is_none())
                .unwrap_or(false);
            if !recursive {
                if !empty {
                    return Err(ToolError::ExecutionFailed(format!(
                        "目标是非空目录：{}（传 recursive=true 可递归删除，或先用 native__list_directory 查看）",
                        abs.display()
                    )));
                }
                std::fs::remove_dir(&abs)
                    .map_err(|e| ToolError::ExecutionFailed(format!("删除目录失败：{e}")))?;
                Ok(format!("已删除空目录 {}", abs.display()))
            } else {
                let n = count_descendants(&abs);
                std::fs::remove_dir_all(&abs)
                    .map_err(|e| ToolError::ExecutionFailed(format!("递归删除失败：{e}")))?;
                Ok(format!("已删除目录 {}（含 {} 个子项）", abs.display(), n))
            }
        } else {
            let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            std::fs::remove_file(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("删除文件失败：{e}")))?;
            Ok(format!("已删除文件 {}（{} 字节）", abs.display(), size))
        }
    }
}


/// 判断工作空间内某路径（文件或目录）是否存在及其真实类型。
///
/// 这是 `native__read_file` / `native__write_file` / `native__edit_file` / `native__list_directory`
/// 的**强制前置闭环**：这些工具在执行实际读/写/列之前都会先经 `probe_path` 做存在性与类型校验
/// （运行时层面保证「永远在之前执行」，不依赖模型自觉）。本工具同时暴露给模型用于显式规划/诊断，
/// 仅读取元信息（`metadata`），不读写文件内容，属 ReadSafe，不触发审批。
pub struct PathExistsTool;

#[async_trait]
impl AgentTool for PathExistsTool {
    fn name(&self) -> String {
        "native__path_exists".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("check"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__path_exists",
            "判断工作空间内某个路径（文件或目录）是否存在，并返回它的真实类型（文件/目录）。\
             文件还会额外返回 size（字节）与 modified_ms（最后修改时间，UNIX 毫秒）。\
             在调用 native__list_directory / native__edit_file / native__read_file / native__write_file 之前应先调用本工具确认路径存在且类型正确，\
             避免「文件不存在 / 目标是目录」类错误。仅读取元信息，不读写文件内容，不触发审批。\
             注意：native__write_file / edit_file / read_file / list_directory 内部已自动探测路径存在性与类型，无需在调用它们之前预先调用本工具；\
             仅在需要显式确认路径状态（如决策分支）时才使用本工具。",
            json!({ "path": { "type": "string", "description": "相对或绝对路径（须在工作空间内），如 src/utils 或 src/App.tsx" } }),
            &["path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("path_exists 缺少 path 参数".into())
        })?;
        // 经 PathGuard 校验，约束在 workspace 内（路径不合法时直接透传错误）。
        let abs = match PathGuard::check(path, ctx) {
            Ok(abs) => abs,
            Err(e) => return Err(e),
        };
        // 复用统一的存在性探测，保证与 read/write/edit/list 的前置校验语义一致。
        let probe = probe_path(&abs);
        let result = if !probe.exists {
            json!({
                "exists": false,
                "is_file": false,
                "is_dir": false,
                "message": format!(
                    "路径不存在：{}（如需创建请使用 native__write_file 或 native__edit_file 新建）",
                    abs.display()
                )
            })
        } else if probe.is_dir {
            json!({
                "exists": true,
                "is_file": false,
                "is_dir": true,
                "message": format!("存在，是目录：{}", abs.display())
            })
        } else {
            // 文件：额外返回大小（字节）与最后修改时间（UNIX 毫秒）。
            // 用 Map 条件插入，metadata 取不到时省略字段（不报错），语义等同 skip_serializing。
            let mut obj = serde_json::Map::new();
            obj.insert("exists".into(), json!(true));
            obj.insert("is_file".into(), json!(true));
            obj.insert("is_dir".into(), json!(false));
            if let Ok(meta) = std::fs::metadata(&abs) {
                obj.insert("size".into(), json!(meta.len()));
                if let Ok(modified) = meta.modified() {
                    if let Ok(elapsed) = modified.duration_since(std::time::UNIX_EPOCH) {
                        obj.insert("modified_ms".into(), json!(elapsed.as_millis() as u64));
                    }
                }
            }
            obj.insert(
                "message".into(),
                json!(format!("存在，是文件：{}", abs.display())),
            );
            json!(obj)
        };
        Ok(serde_json::to_string(&result).unwrap_or_else(|_| "{}".into()))
    }
}


pub struct ListDirectoryTool;

#[async_trait]
impl AgentTool for ListDirectoryTool {
    fn name(&self) -> String {
        "native__list_directory".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("list"),
            file_mutating: false,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__list_directory",
            "列出工作空间内指定目录的内容（文件与子目录名）。注意：执行前应先调用 native__path_exists 确认目录存在，避免「目录不存在 / 路径是文件」类错误。",
            json!({ "path": { "type": "string", "description": "目录路径（须在工作空间内），默认根" } }),
            &[],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let abs = PathGuard::check(path, ctx)?;
        // 闭环前置检查（统一复用 probe_path）：先确认路径存在且为目录，把裸 os error 翻译成
        // 清晰中文，落实「列目录前先看路径有没有，不能上来就列」。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__list_directory: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            tracing::info!("[agent] native__list_directory: 目录不存在 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目录不存在：{}（请先用 native__path_exists 确认路径是否正确）",
                abs.display()
            )));
        }
        if !probe.is_dir {
            tracing::info!("[agent] native__list_directory: 路径是文件而非目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "路径是文件而非目录：{}（请用 native__read_file 读取文件内容）",
                abs.display()
            )));
        }
        tracing::info!("[agent] native__list_directory: 开始 path={} resolved={}", path, abs.display());
        let started = Instant::now();
        let mut entries: Vec<String> = Vec::new();
        for e in std::fs::read_dir(&abs).map_err(|e| {
            ToolError::ExecutionFailed(format!("读取目录失败：{e}"))
        })? {
            if let Ok(entry) = e {
                let mut name = entry.file_name().to_string_lossy().to_string();
                if entry.path().is_dir() {
                    name.push('/');
                }
                entries.push(name);
            }
        }
        let result = serde_json::to_string(&json!({ "entries": entries }))
            .unwrap_or_else(|_| "{}".into());
        tracing::info!(
            "[agent] native__list_directory: 成功 entries={} result={}字符 耗时={}ms",
            result.matches("\"").count() / 2,
            result.chars().count(),
            started.elapsed().as_millis(),
        );
        Ok(result)
    }
}


#[async_trait]
impl AgentTool for EditFileTool {
    fn name(&self) -> String {
        "native__edit_file".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("edit"),
            file_mutating: true,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__edit_file",
            "在文件中做字符串替换（old_str → new_str）。需用户审批，前端以 Diff 展示。注意：执行前应先调用 native__path_exists 确认目标文件存在且为文件，避免「文件不存在 / 目标是目录」类错误。",
            json!({
                "path": { "type": "string", "description": "目标文件路径（须在工作空间内）" },
                "old_str": { "type": "string", "description": "要被替换的原片段（须唯一存在）" },
                "new_str": { "type": "string", "description": "替换后的新片段" }
            }),
            &["path", "old_str", "new_str"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("edit_file 缺少 path 参数".into())
        })?;
        let old_str = args.get("old_str").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("edit_file 缺少 old_str 参数".into())
        })?;
        let new_str = args.get("new_str").and_then(|v| v.as_str()).unwrap_or("");

        let abs = PathGuard::check(path, ctx)?;
        tracing::info!(
            "[agent] native__edit_file: 开始 path={} resolved={} old_str={} new_str={}",
            path,
            abs.display(),
            crate::agent::engine::runtime::clip(old_str, 300),
            crate::agent::engine::runtime::clip(new_str, 300),
        );
        let started = Instant::now();
        // 闭环前置检查（统一复用 probe_path）：先确认路径存在且为文件，把裸 os error 翻译成
        // 清晰中文，落实「编辑文件前先看文件有没有，不能上来就改」。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__edit_file: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            tracing::info!("[agent] native__edit_file: 文件不存在 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "文件不存在：{}（请先用 native__path_exists 确认，或用 native__write_file 创建）",
                abs.display()
            )));
        }
        if probe.is_dir {
            tracing::info!("[agent] native__edit_file: 目标是目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（无法编辑目录，请先用 native__list_directory 查看其内容）",
                abs.display()
            )));
        }
        // 问题 2 修复：补 TOCTOU 二次确认（read/write 均已做，edit 原漏了）。
        // 先打开句柄 → 基于句柄校验真实物理路径未逃逸工作空间 → 再读内容，防御「check 与 open 之间 symlink 替换」。
        let mut file = match File::open(&abs) {
            Ok(f) => f,
            Err(e) => {
                tracing::info!("[agent] native__edit_file: 读取失败 path={} error={}", abs.display(), e);
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__edit_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        let mut original = String::new();
        match file.read_to_string(&mut original) {
            Ok(_) => {}
            Err(e) => {
                tracing::info!("[agent] native__edit_file: 读取失败 path={} error={}", abs.display(), e);
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        }
        let count = original.matches(old_str).count();
        // 改动 1：old_str 不匹配时，把文件前 800 字符回灌给模型，让它据此自行修正，
        // 避免「未找到 → 凭记忆再猜 → 再次失败」的死循环。
        let snippet = original.chars().take(800).collect::<String>();
        if count == 0 {
            return Err(ToolError::InvalidArgs(format!(
                "old_str 在文件中未找到。当前文件实际内容前 800 字符如下，请据此修正 old_str 后重试：\n---\n{}\n---\n提示：old_str 必须与文件中的文本完全一致（含缩进、空格、换行）。建议先用 native__read_file 读取完整文件内容。",
                snippet
            )));
        }
        if count > 1 {
            return Err(ToolError::InvalidArgs(format!(
                "old_str 在文件中出现 {} 次，无法确定替换位置。当前文件实际内容前 800 字符如下，请据此修正 old_str 使其唯一后重试：\n---\n{}\n---\n提示：old_str 必须与文件中的文本完全一致（含缩进、空格、换行），且应只出现一次。",
                count, snippet
            )));
        }
        let updated = original.replace(old_str, new_str);
        let updated_bytes = updated.len();
        // 问题 2 修复：写回同样补 TOCTOU 二次确认（防御「读写窗口间路径再被替换」）。
        // 与 write_file 一致：打开不截断 → verify_opened → set_len(0) 清空 → write_all。
        let mut file = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&abs)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__edit_file: 写回失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("写回失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__edit_file: 写回 TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        if let Err(e) = file.set_len(0) {
            tracing::info!(
                "[agent] native__edit_file: 清空失败 path={} 耗时={}ms error={}",
                abs.display(),
                started.elapsed().as_millis(),
                e
            );
            return Err(ToolError::ExecutionFailed(format!("清空原文件失败：{e}")));
        }
        match file.write_all(updated.as_bytes()) {
            Ok(()) => {
                tracing::info!(
                    "[agent] native__edit_file: 成功 path={} 原始bytes={} 新bytes={} 耗时={}ms",
                    abs.display(),
                    original.len(),
                    updated_bytes,
                    started.elapsed().as_millis()
                );
                // #20260918006：编辑 .wd_mem/artifacts/*.md 同样触发异步索引（与 write_file
                // 同管道；digest 未变自动跳过，变了删旧分节重写）。fire-and-forget。
                if let Some(ws) = &ctx.workspace {
                    let ws_lossy = ws.to_string_lossy().to_string();
                    if is_artifacts_md_rel(path) {
                        crate::agent::artifact::artifact_index::spawn_artifact_index_sync(
                            self.app.clone(),
                            ws_lossy,
                            path.to_string(),
                            updated,
                        );
                    }
                }
                Ok(format!("已在 {} 完成 1 处替换", abs.display()))
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__edit_file: 写回失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(format!("写回失败：{e}")))
            }
        }
    }
}


#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> String {
        "native__write_file".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("write"),
            file_mutating: true,
            file_reading: false,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__write_file",
            "将内容写入指定文件（覆盖已存在文件）。需用户审批。注意：若目标已是目录会直接报错，执行前可先调用 native__path_exists 确认路径类型。",
            json!({
                "path": { "type": "string", "description": "目标文件路径（须在工作空间内）" },
                "content": { "type": "string", "description": "要写入的完整文本" }
            }),
            &["path", "content"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("write_file 缺少 path 参数".into())
        })?;
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let abs = match PathGuard::check(path, ctx) {
            Ok(abs) => abs,
            Err(e) => {
                tracing::info!("[agent] native__write_file: 路径校验失败 path={} error={:?}", path, e);
                return Err(e);
            }
        };
        // 闭环前置检查（统一复用 probe_path）：若目标已存在且为目录，不能作为文件写入
        // （否则裸 os error）。不存在 / 是文件均按「没有就去创建 / 覆盖」的闭环继续。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__write_file: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if probe.exists && probe.is_dir {
            tracing::info!("[agent] native__write_file: 目标是目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（无法写入，请改用 native__list_directory 查看目录内容）",
                abs.display()
            )));
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::ExecutionFailed(format!("创建父目录失败：{e}"))
            })?;
        }
        tracing::info!(
            "[agent] native__write_file: 开始 path={} resolved={} content_bytes={} content_preview={}",
            path,
            abs.display(),
            content.len(),
            crate::agent::engine::runtime::clip(content, 500),
        );
        let started = Instant::now();
        // 问题 3 修复：打开时不截断（truncate(false)），待 TOCTOU 校验通过后再 set_len(0) 清空。
        // 若 verify_opened 失败（如 symlink 逃逸），原文件内容完好可恢复，不丢数据。
        let mut file = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&abs)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__write_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("创建文件失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__write_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        // 校验通过：清空原内容（真正的截断点，置于 verify 之后），再写入新内容。
        if let Err(e) = file.set_len(0) {
            tracing::info!(
                "[agent] native__write_file: 清空失败 path={} 耗时={}ms error={}",
                abs.display(),
                started.elapsed().as_millis(),
                e
            );
            return Err(ToolError::ExecutionFailed(format!("清空原文件失败：{e}")));
        }
        match file.write_all(content.as_bytes()) {
            Ok(()) => {
                tracing::info!(
                    "[agent] native__write_file: 成功 path={} bytes={} 耗时={}ms",
                    abs.display(),
                    content.len(),
                    started.elapsed().as_millis()
                );
                // #20260918006：写 .wd_mem/artifacts/*.md 视为知识归档，异步索引进 LanceDB
                // （与 archive_artifact 同管道；digest 未变自动跳过）。fire-and-forget。
                if let Some(ws) = &ctx.workspace {
                    let ws_lossy = ws.to_string_lossy().to_string();
                    if is_artifacts_md_rel(path) {
                        crate::agent::artifact::artifact_index::spawn_artifact_index_sync(
                            self.app.clone(),
                            ws_lossy,
                            path.to_string(),
                            content.to_string(),
                        );
                    }
                }
                Ok(format!("已写入 {} 字节到 {}", content.len(), abs.display()))
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__write_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(format!("写入失败：{e}")))
            }
        }
    }
}


pub struct ReadFileTool;

#[async_trait]
impl AgentTool for ReadFileTool {
    fn name(&self) -> String {
        "native__read_file".into()
    }
    fn behavior(&self) -> ToolBehavior {
        ToolBehavior {
            op: Some("read"),
            file_mutating: false,
            file_reading: true,
        }
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__read_file",
            "读取工作空间内指定文本文件的内容。注意：执行前应先调用 native__path_exists 确认文件存在且为文件，避免「文件不存在 / 目标是目录」类错误。",
            json!({ "path": { "type": "string", "description": "文件相对或绝对路径（须在工作空间内）" } }),
            &["path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("read_file 缺少 path 参数".into())
        })?;
        let abs = match PathGuard::check(path, ctx) {
            Ok(abs) => abs,
            Err(e) => {
                tracing::info!("[agent] native__read_file: 路径校验失败 path={} error={:?}", path, e);
                return Err(e);
            }
        };
        tracing::info!("[agent] native__read_file: 开始 path={} resolved={}", path, abs.display());
        let started = Instant::now();
        // 闭环前置检查（统一复用 probe_path）：先确认「存在性 + 是否目录」，把裸 os error
        // 翻译成清晰中文，落实「读取文件内容前先看文件有没有，不能上来就读」。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__read_file: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            tracing::info!("[agent] native__read_file: 文件不存在 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "文件不存在：{}（请先用 native__path_exists 确认，或用 native__write_file 创建）",
                abs.display()
            )));
        }
        if probe.is_dir {
            tracing::info!("[agent] native__read_file: 目标是目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（目录无法作为文件读取，请先用 native__list_directory 查看其内容）",
                abs.display()
            )));
        }
        // TOCTOU 二次确认：先打开文件句柄，再基于句柄校验真实物理路径未逃逸工作空间，
        // 防御「check 与 open 之间符号链接被替换」的竞态窗口。
        let mut file = match File::open(&abs) {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__read_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__read_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        // 问题 6 修复：体积预检，避免「先读整个大文件进内存撑爆」再截断返回值。
        // 超过上限不读全文，明确拒绝并引导改用沙箱分段处理（不要「只读前 N 字节」误导模型以为是全文）。
        let meta = file
            .metadata()
            .map_err(|e| ToolError::ExecutionFailed(format!("读取文件元信息失败：{e}")))?;
        if meta.len() > MAX_READ_FILE_BYTES {
            tracing::info!(
                "[agent] native__read_file: 文件过大 path={} bytes={} 拒绝读取（上限 {}）",
                abs.display(),
                meta.len(),
                MAX_READ_FILE_BYTES
            );
            return Err(ToolError::ExecutionFailed(format!(
                "文件过大（{} 字节，上限 {} 字节）：请改用 native__run_python_sandbox 分段读取/处理，或指定更小的文件",
                meta.len(), MAX_READ_FILE_BYTES
            )));
        }
        let mut content = String::new();
        match file.read_to_string(&mut content) {
            Ok(_) => {
                tracing::info!(
                    "[agent] native__read_file: 成功 bytes={} chars={} 耗时={}ms 内容={}",
                    content.len(),
                    content.chars().count(),
                    started.elapsed().as_millis(),
                    crate::agent::engine::runtime::clip(&content, 500),
                );
                Ok(content)
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__read_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(format!("读取失败：{e}")))
            }
        }
    }
}

