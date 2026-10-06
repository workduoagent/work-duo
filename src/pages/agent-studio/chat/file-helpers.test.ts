import { describe, expect, it } from 'vitest'
import {
  extractFilePaths,
  extractImageMentions,
  estimateTokens,
} from './file-helpers'

/**
 * F018 回归：本次 ESLint 修复动过两处正则/字符类，属易回归逻辑，锁住行为。
 *
 * 1. estimateTokens：CJK 区段原先用字面 U+3000 全角空格书写正则，
 *    被 no-irregular-whitespace 报错；改为 \u 转义后语义必须完全等价
 *    （U+3000..U+303F 区间仍需被识别为 CJK 字符而非空白分隔符）。
 * 2. extractImageMentions / extractFilePaths：字符类内 '-' 原置于尾部
 *    （如 【】-），会与前一字符构成反向范围（U+3011..U+002D 恒空），
 *    ESLint 判 no-useless-escape 成立；改为首位表字面量。
 */

describe('estimateTokens —— CJK 区段识别', () => {
  it('中日韩汉字/假名/韩文均按 CJK 计 1 token', () => {
    expect(estimateTokens('中文')).toBe(2)
    expect(estimateTokens('あいう')).toBe(3)
    expect(estimateTokens('가나다')).toBe(3)
  })

  it('全角空格（U+3000）属 CJK 区段字符，不作词分隔', () => {
    // 若 U+3000 被误当空白，中间插入全角空格会被切成 2 词 + 2 字符 = ceil(2+2.6)=5
    // 用 fromCharCode 构造，避免测试源码内混入 U+3000 字面量（no-irregular-whitespace）
    const u3000 = String.fromCharCode(0x3000)
    expect(estimateTokens(['中', u3000, '文'].join(''))).toBe(3)
  })

  it('CJK 标点区段（U+3000..U+303F）计入 CJK', () => {
    expect(estimateTokens('中、文')).toBe(3)
  })

  it('纯 ASCII 按空格分词（1.3 token/词）', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil(2 * 1.3))
    expect(estimateTokens('')).toBe(0)
  })

  it('中英混排：CJK 逐字 + 英文按词', () => {
    // 2 个 CJK 字（修/复/任/务=4）+ 'run' 1 词 → ceil(4 + 1.3) = 6
    expect(estimateTokens('修复 run 任务')).toBe(6)
    expect(estimateTokens('修复run任务')).toBe(6)
  })
})

describe('extractFilePaths —— 尾部标点剥离与 URL 跳过', () => {
  it('剥离句末标点，仅保留扩展名段（FILE_PATH_RE 既定匹配范围）', () => {
    // 说明：正则只捕获到最后一个 `/` 之后的段（`\b` + 起始 `/|./` 锚点所致），
    // 这是既有行为、非本次改动引入；此处按实际行为锁定，防未来误改。
    expect(extractFilePaths('见 src/a.ts。')).toEqual(['/a.ts'])
    expect(extractFilePaths('见 src/a.ts,')).toEqual(['/a.ts'])
  })

  it('裸文件名不计入（须含分隔符或盘符）', () => {
    expect(extractFilePaths('README')).toEqual([])
    // 盘符路径：整串保留（含分隔符），仅剥离句末标点
    // 用 fromCharCode 构造反斜杠，规避测试源码里的字符串转义歧义
    const winPath = ['C:', 'proj', 'a.ts'].join(String.fromCharCode(92))
    expect(extractFilePaths(winPath)).toEqual([winPath])
  })

  it('URL 片段：负向断言只对紧邻 :// 的段生效', () => {
    // FILE_PATH_RE 有 (?<!://) 负向断言，但匹配起点在域名之后的 `/`，
    // 故 example.com/a/b.ts 仍会命中尾部段——既有行为，如实记录。
    expect(extractFilePaths('见 https://example.com/a/b.ts 结束')).toEqual(['/a/b.ts'])
  })

  it('单个路径：仅匹配扩展名段（相对/绝对/显式 ./ 皆然）', () => {
    // 已知既有缺陷（非本次引入）：路径含空格时，尾部字符类`[^...]+` 贪婪吞掉整段，
    // 导致 'x/a.ts 与 y/b.md' 被当作单个路径。真实场景（Markdown 正文含空格）易触发。
    // 此处如实锁定当前行为，后续若修贪婪匹配需同步更新本断言。
    expect(extractFilePaths('x/a.ts')).toEqual(['/a.ts'])
    expect(extractFilePaths('./src/a.ts')).toEqual(['/a.ts'])
    expect(extractFilePaths('结束\n\nx/a.ts')).toEqual(['/a.ts'])
    expect(extractFilePaths('看 x/a.ts 与 y/b.md')).toEqual(['/a.ts 与 y/b.md'])
  })
})

describe('extractImageMentions —— 字符类内连字符为字面量', () => {
  it('识别带连字符的裸图片名', () => {
    expect(extractImageMentions('见图 demo-cat.png', [])).toContain('demo-cat.png')
  })

  it('识别中文括号/方括号包裹的文件名', () => {
    expect(extractImageMentions('（图）.png', [])).toContain('（图）.png')
    expect(extractImageMentions('【图】.png', [])).toContain('【图】.png')
  })

  it('markdown 图片语法交由MarkdownRenderer，不重复出卡', () => {
    expect(extractImageMentions('![x](demo-cat.png)', [])).toEqual([])
  })

  it('已被全路径覆盖的尾段不重复出卡', () => {
    const allPaths = ['assets/logo-2.png']
    expect(extractImageMentions('见图 logo-2.png', allPaths)).toEqual(['assets/logo-2.png'])
  })

  it('allPaths 中的图片直接入列（按扩展名过滤）', () => {
    expect(extractImageMentions('', ['a/logo.png', 'b/main.ts'])).toEqual(['a/logo.png'])
  })

  it('非图片扩展名不误报', () => {
    expect(extractImageMentions('src/main.ts', [])).toEqual([])
  })
})
