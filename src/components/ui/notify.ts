import { App } from 'antd'

export interface ResultLike {
  ok: boolean
  error?: string
}

/**
 * 统一消息提醒 hook（走 antd App.useApp 实例，跟随主题）。
 * - result(): 处理 {ok, error} 业务结果，统一弹成功/失败——「异常返回消息提醒」单一入口；
 *   失败带完整 error 文案，避免各调用点手写漏提示。
 * - 其余透传 antd message（success/error/warning/info/loading 等）。
 * 调用方须在 <App> 组件树内（项目已在 ThemeProvider 用 <App component={false}> 包裹）。
 */
export function useNotify() {
  const { message, notification, modal } = App.useApp()
  return {
    message,
    notification,
    modal,
    /**
     * 业务结果统一提醒。返回 ok 供调用方继续判断。
     * - silentOk=true 时成功静默（契合「仅异常场景提示」原则，写盘/删除等副作用操作成功后不弹 toast）；
     * - silentOk=false（默认）时成功弹 success(okText)，用于用户主动触发的反馈（如手动刷新）。
     * 失败一律弹 error（带完整 error 文案，避免各调用点手写漏提示）。
     */
    result(res: ResultLike, okText: string, failPrefix = '操作失败', silentOk = false): boolean {
      if (res.ok) {
        if (!silentOk) message.success(okText)
        return true
      }
      message.error(`${failPrefix}：${res.error || '未知错误（服务无返回信息）'}`)
      return false
    },
  }
}
