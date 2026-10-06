import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Field, FieldLabel } from './Field'

/**
 * F041 回归：Field 的字段级校验反馈能力。
 *
 * 背景：此前校验失败只能弹顶部 toast（`message.error`），用户在 1400 行的
 * SquadEditorModal 里填 10 个字段，不知道是哪一栏出错、也不知道还差几处。
 * `Field` 补 `error` / `hint` 两个 prop 后，错误就地显示在控件下方。
 *
 * 用 `react-dom/server` 的静态渲染而非 @testing-library/react——
 * 项目未装后者（且约定 AI 只写 package.json 不装依赖），本用例只验证
 * 渲染出的 HTML 结构，不需要 DOM 交互。
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

describe('Field 字段级校验反馈（F041）', () => {
  it('无 error 时不渲染错误/提示节点', () => {
    const out = html(
      <Field>
        <FieldLabel>名称</FieldLabel>
        <input />
      </Field>,
    )
    expect(out).not.toContain('app-field__error')
    expect(out).not.toContain('app-field__hint')
    expect(out).not.toContain('data-invalid')
  })

  it('传 error 时就地渲染文案', () => {
    const out = html(
      <Field error="请填写小分队名称">
        <FieldLabel>名称</FieldLabel>
        <input />
      </Field>,
    )
    expect(out).toContain('app-field__error')
    expect(out).toContain('请填写小分队名称')
  })

  it('error 时置 role=alert（读屏可播报）与 data-invalid（样式钩子）', () => {
    const out = html(
      <Field error="必填">
        <input />
      </Field>,
    )
    expect(out).toContain('role="alert"')
    expect(out).toContain('data-invalid="true"')
  })

  it('hint 与 error 同时存在时以 error 优先（不并列两条）', () => {
    const out = html(
      <Field error="格式不对" hint="建议用小写字母">
        <input />
      </Field>,
    )
    expect(out).toContain('格式不对')
    expect(out).toContain('app-field__error')
    expect(out).not.toContain('app-field__hint')
  })

  it('仅传 hint 时渲染为辅助说明（非错误样式）', () => {
    const out = html(
      <Field hint="仅小写字母、数字与连字符">
        <input />
      </Field>,
    )
    expect(out).toContain('app-field__hint')
    expect(out).toContain('仅小写字母、数字与连字符')
    expect(out).not.toContain('app-field__error')
  })

  it('保留 className 合并能力（既有 16 个调用方依赖）', () => {
    const out = html(
      <Field className="squad-editor__row" error="x">
        <input />
      </Field>,
    )
    expect(out).toContain('squad-editor__row')
    expect(out).toContain('app-field')
  })
})
