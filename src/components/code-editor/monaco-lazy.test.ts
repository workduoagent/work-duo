import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F043 回归：Monaco 不得静态进入首屏。
 *
 * 背景：`MonacoJsonEditor` 原先直接静态 import `monaco-editor` + 4 个 worker +
 * TS 贡献模块，经 9 个页面传导进首屏 chunk（实测 `dist/assets/index-*.js`
 * 达 6.5MB）。修复为「实现体拆到 Inner + 包装层 React.lazy 异步加载 +
 * vite manualChunks 独立分块」，实测首屏块降到 1.08MB、monaco 出现 0 次。
 *
 * 本测试锁住两个不变量（纯文本断言，无需跑构建）：
 *  1. 除实现体外，任何 src 文件都不得静态 import `monaco-editor`；
 *  2. 包装层必须用 React.lazy 加载，且导出层不暴露实现体。
 */

// 本文件位于 src/components/code-editor/，故 __dirname 即该目录
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '..', '..') // → src
const REPO_ROOT = resolve(SRC_ROOT, '..') // → 仓库根
const INNER = join(HERE, 'MonacoJsonEditorInner.tsx')
const WRAPPER = join(HERE, 'MonacoJsonEditor.tsx')

function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collect(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const files = collect(SRC_ROOT)

describe('Monaco 懒加载（F043）', () => {
  it('源码扫描器有效（避免空扫描假绿）', () => {
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain(INNER)
    expect(files).toContain(WRAPPER)
  })

  it('除实现体外，无任何文件静态（值）import monaco-editor', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (f === INNER) continue
      const text = readFileSync(f, 'utf8')
      // 静态**值** import 形态；`import type` 是类型擦除不算；动态 import(...) 允许
      const staticValueImport =
        /^[ \t]*import\s+(?!type\b)[^\n]*from\s+['"](monaco-editor|@monaco-editor\/react)/m
      if (staticValueImport.test(text)) offenders.push(f.replace(REPO_ROOT + '\\', ''))
    }
    expect(
      offenders,
      `以下文件静态引入了 monaco（应改为经 @/components/code-editor 走 lazy 包装层）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('包装层用 React.lazy 加载实现体（而非静态 import）', () => {
    const w = readFileSync(WRAPPER, 'utf8')
    expect(w, '包装层必须用 lazy() 异步加载').toMatch(/lazy\(/)
    expect(w, '必须用动态 import() 加载实现体').toMatch(/import\(['"]\.\/MonacoJsonEditorInner['"]\)/)
    expect(w, '必须有 Suspense 兜底').toMatch(/Suspense/)
    // 包装层不得有**值导入**的实现体（否则 lazy 失效、monaco 又回首屏）。
    // 注意 `import type {...}` / `export type {...}` 是类型擦除、不产生运行时
    // 依赖，是正确写法——只排除非 type 的静态 import。
    const valueImport = /^[ \t]*import\s+(?!type\b)[^\n]*from\s+['"]\.\/MonacoJsonEditorInner['"]/m
    expect(w, '包装层不得静态（值）import 实现体').not.toMatch(valueImport)
  })

  it('vite 配置了 monaco 独立分块', () => {
    const vite = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8')
    expect(vite, 'vite.config.ts 应配 manualChunks').toMatch(/manualChunks/)
    expect(vite).toMatch(/monaco/)
  })

  it('导出层只暴露包装组件（外部无需感知 lazy）', () => {
    const index = readFileSync(join(HERE, 'index.ts'), 'utf8')
    expect(index).toMatch(/from '\.\/MonacoJsonEditor'/)
    expect(index, '不应从 Inner 直接导出，避免调用方绕过 lazy').not.toMatch(/MonacoJsonEditorInner/)
  })
})
