/**
 * Vitest 全局前置（F018 基建 / F044 补充）。
 *
 * 目前只做一件事：声明 React 18+ 的 act 环境。
 *
 * 背景：F044 的 a11y 测试用 `createRoot` + `act` 做**真实 DOM 渲染**（验证
 * `useId()` 生成与注入行为——`renderToStaticMarkup` 无渲染器上下文，`useId()`
 * 会返回空）。React 19 检测不到该标志时会打印
 * "The current testing environment is not configured to support act(...)" 警告。
 */
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export {}
