/**
 * 相对路径安全校验（F005）：以「根目录 + 相对路径」落盘的文件域（kbFs / skillFs 等）共用。
 *
 * 规则（SK-3 同款，抽公共防双份漂移）：禁止 .. 穿越 / 绝对路径（/ 或盘符）/ 空段 /
 * 反斜杠写法（统一按 / 归一后校验）。合法相对路径（docs/a.txt、scripts/x.py）不受影响。
 */
export function assertSafeRelPath(relPath: string, label: string): void {
  const norm = relPath.replace(/\\/g, '/')
  const segs = norm.split('/')
  if (
    !norm ||
    norm.startsWith('/') ||
    segs.some((s) => s === '..' || s === '') ||
    segs.some((s) => /^[a-zA-Z]:/.test(s))
  ) {
    throw new Error(`${label}: 非法相对路径 ${relPath}`)
  }
}
