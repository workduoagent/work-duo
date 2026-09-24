/**
 * 路径展示净化（仅用于**显示**，不用于文件 I/O）。
 *
 * 背景：Rust 的 `std::fs::canonicalize()` 在 Windows 上按约定返回 `\\?\` 前缀的
 * 「扩展长度 / 逐字路径」（用于绕过 MAX_PATH 260 限制）。工程目录绑定时
 * `canonicalize_path` 的返回值被存进 rootPath，进而出现在产物路径与工具结果里，
 * 模型还会把工具返回的路径原样写进回答正文 —— 界面上就显示成
 * `\\?\E:\WorkDuoTest\palindrome.py`，看着很奇怪。
 *
 * 这里只做展示层去前缀；真正用于读写的路径保留原样（超长路径仍需要 verbatim 前缀）。
 */

/** 去掉 Windows 逐字路径前缀：`\\?\C:\a` → `C:\a`；`\\?\UNC\srv\sh` → `\\srv\sh`。 */
export function stripWinVerbatim(p: string): string {
  if (!p) return p
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

/**
 * 清理一段**面向展示的文本**里出现的 Windows 逐字路径前缀（如模型回答正文、工具结果）。
 * 比 stripWinVerbatim 松，适用于整段文本替换。
 */
export function stripWinVerbatimInText(text: string): string {
  if (!text) return text
  return text.replace(/\\\\\?\\UNC\\/g, '\\\\').replace(/\\\\\?\\/g, '')
}
