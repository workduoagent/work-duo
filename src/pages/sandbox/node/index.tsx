/**
 * 路由页面「沙箱环境 / NodeJs」：Node.js 运行时占位页。
 *
 * 当前仅占位，待 Node.js 运行时方案（sidecar / 内嵌）落地后，
 * 按 Python 页面同构补齐：环境卡片网格 + 创建 / 安装依赖 / 运行脚本 等操作。
 */
import { Server } from 'lucide-react'
import { Empty } from 'antd'

export default function SandboxNodePage() {
  return (
    <div className="sandbox-node">
      <div className="sandbox-node__inner">
        <div className="sandbox-node__icon">
          <Server size={40} />
        </div>
        <h2 className="sandbox-node__title">NodeJs 沙箱环境</h2>
        <p className="sandbox-node__lead">
          Node.js 运行时正在接入中。后续将在此提供与 Python 同构的环境管理
          （创建 / 安装依赖 / 运行脚本），接口已预留。
        </p>
        <Empty description="暂无可用运行时" />
      </div>
    </div>
  )
}
