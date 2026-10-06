import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Tag } from './Tag'

/**
 * F051 回归：Tag 主题感知。
 *
 * 背景：Tag 原是 antd 直接 re-export，业务侧用**预设色名**（`gold` / `orange` /
 * `geekblue` …）—— 那是 antd 写死的固定 RGB，**不随应用 5 套色调变化**。在 Mint /
 * Lilac 主题下，一个 antd 纯金标签会与整体青紫调冲突（报告称「突兀」）。
 *
 * 本测试锁住：① 无 `variant` 时行为与 antd 完全一致（向后兼容，存量44 处调用不受影响）；
 * ② 有 `variant` 时走令牌化样式类；③ squads 侧的两张映射表已不再用预设色。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_DIR = join(HERE, '..', '..')

describe('Tag 主题感知（F051）', () => {
  it('未传 variant 时原样透传 antd（向后兼容）', () => {
    const html = renderToStaticMarkup(<Tag color="gold">汇总</Tag>)
    expect(html).toContain('ant-tag')
    expect(html).toContain('汇总')
    // 不应加我们的主题类
    expect(html).not.toContain('app-tag')
  })

  it('传 variant 时输出令牌化的语义类', () => {
    const html = renderToStaticMarkup(<Tag variant="success">完成</Tag>)
    expect(html).toContain('app-tag')
    expect(html).toContain('app-tag--success')
  })

  it('六种语义 variant 各自映射到独立类名', () => {
    for (const v of ['brand', 'info', 'success', 'warn', 'danger', 'neutral'] as const) {
      const html = renderToStaticMarkup(<Tag variant={v}>x</Tag>)
      expect(html, `variant=${v} 应有对应类`).toContain(`app-tag--${v}`)
    }
  })

  it('className 与业务自定义类可叠加', () => {
    const html = renderToStaticMarkup(
      <Tag variant="brand" className="my-extra">
        x
      </Tag>,
    )
    expect(html).toContain('app-tag')
    expect(html).toContain('my-extra')
  })

  it('Tag.scss 全部走 CSS 令牌（不硬编码色值）', () => {
    const scss = readFileSync(join(HERE, 'Tag.scss'), 'utf8')
    // 允许「令牌 + 十六进制字面量」形式的 fallback，但不应有裸 hex 声明
    const lines = scss.split(/\r?\n/)
    const offenders = lines.filter(
      (l) => /#[0-9a-fA-F]{3,8}/.test(l) && !/var\(--[a-z-]+,\s*#/.test(l),
    )
    expect(offenders, `Tag.scss 不应有裸色值：${offenders.join('; ')}`).toEqual([])
  })

  it('Tag 已从 display 出口透出（业务侧统一从 @/components/ui 取）', () => {
    const display = readFileSync(join(UI_DIR, 'components', 'ui', 'display.tsx'), 'utf8')
    expect(display).toMatch(/export \{ Tag, type TagProps, type TagVariant \} from '\.\/Tag'/)
  })

  it('squads 两张映射表已改用语义 variant（不再用 antd 预设色名）', () => {
    const roundTags = readFileSync(join(UI_DIR, 'pages', 'squads-workspace', 'roundTags.ts'), 'utf8')
    expect(roundTags, 'roundTags 不应再有 color: 预设色').not.toMatch(/color:\s*'/)
    expect(roundTags).toMatch(/variant:/)

    const page = readFileSync(join(UI_DIR, 'pages', 'squads-workspace', 'index.tsx'), 'utf8')
    expect(page, 'BOARD_STATUS_META 不应再有 color:').not.toMatch(/BOARD_STATUS_META[\s\S]{0,300}color:/)
    expect(page).toMatch(/BOARD_STATUS_META[\s\S]{0,200}variant:/)
  })
})
