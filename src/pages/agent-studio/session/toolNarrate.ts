/**
 * 工具 → 人性化旁白（工具行 + 思考过程共用）。
 *
 * 目标：界面上**不出现 `write_file` / `read_file` 这类工具名**，一律用自然语言表述
 * （「写入文件」「读取文件」…）。op 映射与 Rust `runtime.rs::tool_op` 对齐；
 * 后端已下发 `step.op` 时优先用它，缺失时前端按工具名兜底。
 */

/** 工具名 → 操作类型（与后端 tool_op 对齐）。 */
export function opOf(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'mcp'
  const leaf = toolName.split('__').pop() ?? toolName
  const map: Record<string, string> = {
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    delete_path: 'delete',
    move_path: 'move',
    list_directory: 'list',
    grep_files: 'search',
    regex_replace: 'replace',
    zip_create: 'zip',
    zip_extract: 'unzip',
    path_exists: 'check',
    run_python_sandbox: 'exec',
    run_node_sandbox: 'exec',
    execute_command: 'exec',
    http_request: 'http',
    anchor_memory: 'memory',
  }
  return map[leaf] ?? 'other'
}

/** 操作类型 → 工具行短动词（「写入 code_output.txt」）。 */
export function opVerb(op: string): string {
  const map: Record<string, string> = {
    read: '读取',
    write: '写入',
    create: '新增',
    edit: '编辑',
    delete: '删除',
    move: '移动',
    list: '浏览',
    search: '搜索',
    replace: '替换',
    zip: '压缩',
    unzip: '解压',
    check: '检查',
    exec: '执行',
    http: '请求',
    memory: '记忆',
    mcp: '调用',
  }
  return map[op] ?? '操作'
}

/** 操作类型 → 思考旁白短语（「正在写入文件」）。 */
export function opAction(op: string): string {
  const map: Record<string, string> = {
    read: '读取文件',
    write: '写入文件',
    create: '创建文件',
    edit: '编辑文件',
    delete: '删除文件',
    move: '移动文件',
    list: '查看目录',
    search: '搜索文件',
    replace: '替换文本',
    zip: '压缩文件',
    unzip: '解压文件',
    check: '检查路径',
    exec: '执行命令',
    http: '发起网络请求',
    memory: '记录记忆',
    mcp: '调用外部能力',
  }
  return map[op] ?? '处理'
}

/** 从路径取文件名（兼容 \ 与 /）。 */
export function baseName(p?: string): string {
  if (!p) return ''
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

/** 从入参 JSON 里取目标路径（后端未下发 step.path 时的兜底）。 */
export function pathFromArgs(raw?: string): string | undefined {
  if (!raw) return undefined
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    for (const k of ['path', 'file', 'source', 'from', 'url']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v
    }
  } catch {
    /* 非 JSON 入参，忽略 */
  }
  return undefined
}
