import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Field, FieldLabel } from './Field'
import { Input } from './Input'

/**
 * F044 回归：Field 的 label↔控件自动关联（可访问性）。
 *
 * 背景：全项目 95 个 `FieldLabel` 中只有 24 个写了 `htmlFor`，而**0 个 `Input`
 * 带 `id`** —— 那 24 个 `htmlFor` 全是死链，读屏用户点标签无法聚焦控件，
 * 也不知道该输入框叫什么。
 *
 * 修法：`Field` 用 React 19 `useId()` 生成稳定 id，**渲染期克隆**注入到直接子元素
 * （`FieldLabel` → `htmlFor`，可聚焦控件 → `id`），调用方零改动。
 *
 * ⚠️ 用真实 DOM 渲染（createRoot + act）而非 `renderToStaticMarkup`——后者无
 * 渲染器上下文，`useId()` 会返回空。**且不能用 Context 下传**：children 作为
 * prop 传入 Provider 时 React 不会为其重渲染以注入 Context（实测返回 null），
 * 克隆注入是这里唯一可靠路径。
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(ui: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('Field label↔控件关联（F044）', () => {
  it('FieldLabel 缺省 htmlFor 时自动生成', () => {
    const el = render(
      <Field>
        <FieldLabel>名称</FieldLabel>
        <input />
      </Field>,
    )
    const labelFor = el.querySelector('label')?.getAttribute('for')
    expect(labelFor, 'FieldLabel 应自动获得 htmlFor').toBeTruthy()
    expect(labelFor!.length).toBeGreaterThan(0)
  })

  it('原生控件与 label 共享同一 id（useId 贯通两端）', () => {
    const el = render(
      <Field>
        <FieldLabel>姓名</FieldLabel>
        <input />
      </Field>,
    )
    const labelFor = el.querySelector('label')?.getAttribute('for')
    const inputId = el.querySelector('input')?.getAttribute('id')
    expect(labelFor).toBeTruthy()
    expect(inputId, '原生 input 应被注入 id').toBeTruthy()
    expect(inputId, '两端应共享同一 id').toBe(labelFor)
  })

  it('antd Input 同样被注入 id', () => {
    const el = render(
      <Field>
        <FieldLabel>模型</FieldLabel>
        <Input />
      </Field>,
    )
    const labelFor = el.querySelector('label')?.getAttribute('for')
    const inputId = el.querySelector('input')?.getAttribute('id')
    expect(labelFor).toBeTruthy()
    expect(inputId, 'antd Input 应被注入 id').toBe(labelFor)
  })

  it('显式 htmlFor / id 优先于自动生成（尊重调用方意图）', () => {
    const el = render(
      <Field>
        <FieldLabel htmlFor="my-explicit">名称</FieldLabel>
        <input id="also-explicit" />
      </Field>,
    )
    expect(el.querySelector('label')?.getAttribute('for')).toBe('my-explicit')
    expect(el.querySelector('input')?.getAttribute('id')).toBe('also-explicit')
  })

  it('不同 Field 生成不同 id（不会串号）', () => {
    const el = render(
      <div>
        <Field>
          <FieldLabel>A</FieldLabel>
          <input />
        </Field>
        <Field>
          <FieldLabel>B</FieldLabel>
          <input />
        </Field>
      </div>,
    )
    const ids = [...el.querySelectorAll('label')].map((l) => l.getAttribute('for'))
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size, '两个 Field 的 id 应不同').toBe(2)
  })

  it('无 id 时 label 不带 for 属性（不渲染空 for=""）', () => {
    const el = render(<FieldLabel>裸标签</FieldLabel>)
    expect(el.querySelector('label')?.hasAttribute('for')).toBe(false)
  })

  it('F041 的 error/hint 渲染不受影响，且仍有自动 htmlFor', () => {
    const el = render(
      <Field error="必填">
        <FieldLabel>名称</FieldLabel>
      </Field>,
    )
    expect(el.textContent).toContain('必填')
    expect(el.querySelector('[role="alert"]')).toBeTruthy()
    expect(el.querySelector('.app-field')?.getAttribute('data-invalid')).toBe('true')
    expect(el.querySelector('label')?.getAttribute('for')).toBeTruthy()
  })
})
