import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import './Field.scss'

/**
 * 轻量表单字段容器（取代 Appica Field / FieldLabel）。
 *
 * F041：新增 `error` / `hint` —— 此前校验失败只能弹顶部 toast（`message.error`），
 * 用户在 1400 行的 SquadEditorModal 里填 10 个字段，错误信息却只在顶部飘一下，
 * 不知道是哪一栏出错。现在错误就地显示在字段下方。
 *
 * F044：自动关联 label 与控件 —— 此前 95 个 `FieldLabel` 中只有 24 个写了
 * `htmlFor`，而**全项目 0 个 `Input` 带 `id`**，故那 24 个 `htmlFor` 全是死链：
 * 读屏用户点标签无法聚焦控件，也不知道该输入框叫什么。
 *
 * 修法：`Field` 用 React 19 `useId()` 生成稳定 id，通过**渲染期克隆直接注入**到
 * 直接子元素（`FieldLabel` 拿 `htmlFor`、原生控件与antd 控件拿 `id`）。
 *
 * 为什么不用 Context：children 作为 prop 传入 Provider 时，React **不会**为
 * 了 Context 而重新渲染它们——实测 `useFieldId()` 在 children 内返回 null。
 * 克隆直接改 props 是这里唯一可靠的路径（代价：只处理直接子元素，嵌套结构
 * 需调用方自行处理——实测 96 个 Field 中 94 个的直接子元素就是 FieldLabel，
 * 覆盖度足够）。
 */

/** 可安全接收自动 id 的组件白名单：原生可聚焦元素 + 已知的 antd/自定义封装。 */
const AUTO_ID_TAGS = new Set([
  'input',
  'select',
  'textarea',
  'Input',
  'InputNumber',
  'Select',
  'AutoComplete',
  'ScenarioSelect',
])

/** 映射直接子元素 → 自动 id 注入方式。
 *  注意两处易错：
 *  1. `FieldLabel` 与 antd `Input` 都是**函数组件**，`element.type` 是函数/对象
 *     引用而非字符串，故不能只按字符串比对（早期版本按 `'FieldLabel'` 比对导致
 *     label 拿不到 htmlFor，实测「label 无 for 而 input 有 id」）。
 *  2. antd 组件经项目再导出后，函数名可能被改写，故同时用 displayName /
 *     函数名做兜底匹配。 */
function matchesComponent(type: unknown, name: string): boolean {
  if (type === name) return true
  // React.memo / forwardRef 包装：antd 组件即属此类（typeof object，
  // 真正的名字在 displayName 上，inner .type 常为 undefined）
  if (typeof type === 'object' && type !== null) {
    const t = type as { displayName?: string; name?: string; type?: unknown }
    if (t.displayName === name || t.name === name) return true
    if (typeof t.type !== 'undefined' && t.type !== name) {
      return typeof t.type === 'string' && t.type === name
    }
    return false
  }
  // 普通函数组件
  if (typeof type === 'function') {
    const fn = type as { name?: string; displayName?: string }
    return fn.displayName === name || fn.name === name
  }
  return false
}

function injectId(children: ReactNode, autoId: string): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    const el = child as ReactElement<{ id?: string; htmlFor?: string }>
    const type = el.type

    if (matchesComponent(type, 'FieldLabel')) {
      // 显式 htmlFor 优先，不覆盖调用方意图
      return el.props.htmlFor ? el : cloneElement(el, { htmlFor: autoId })
    }
    const tag = typeof type === 'string' ? type : undefined
    const injectable =
      (tag && AUTO_ID_TAGS.has(tag)) ||
      // antd Input / Select / InputNumber / AutoComplete 等
      matchesComponent(type, 'Input') ||
      matchesComponent(type, 'Select') ||
      matchesComponent(type, 'InputNumber') ||
      matchesComponent(type, 'AutoComplete') ||
      matchesComponent(type, 'ScenarioSelect')
    if (injectable && !el.props.id) {
      return cloneElement(el, { id: autoId })
    }
    return child
  })
}

export function Field({
  children,
  className,
  error,
  hint,
}: {
  children?: ReactNode
  className?: string
  /** 校验错误文案；非空时下方渲染 `.app-field__error` 并置 `data-invalid`。 */
  error?: string
  /** 辅助说明（非错误），与 error 同时存在时以 error 优先。 */
  hint?: string
}) {
  // F044：每个 Field 一个稳定 id，供 FieldLabel / 控件共享
  const autoId = useId()
  return (
    <div
      className={`app-field${className ? ` ${className}` : ''}`}
      data-invalid={error ? 'true' : undefined}
    >
      {injectId(children, autoId)}
      {error ? (
        <span className="app-field__error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="app-field__hint">{hint}</span>
      ) : null}
    </div>
  )
}

export function FieldLabel({
  children,
  className,
  htmlFor,
}: {
  children?: ReactNode
  className?: string
  /** 显式指定；缺省时由所在 `Field` 自动注入（F044）。 */
  htmlFor?: string
}) {
  return (
    <label
      className={`app-field__label${className ? ` ${className}` : ''}`}
      htmlFor={htmlFor}
    >
      {children}
    </label>
  )
}
