import { useEffect, useState } from 'react'
import { Info, Mail, BookOpen, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui'
import { message } from 'antd'
import { SettingItem } from './SettingItem'
import { APP_VERSION } from '@/core/config'

// TODO: 接入真实地址后替换（留空则在点击时提示「敬请期待」，不跳转死链）。
const FEEDBACK_URL = ''
const HELP_URL = ''

function openExternal(url: string, label: string) {
  if (!url) {
    message.info(`${label}：敬请期待`)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 关于我们分区：当前版本 / 意见反馈 / 帮助文档。 */
export function AboutPanel() {
  const [version, setVersion] = useState(APP_VERSION)

  useEffect(() => {
    let alive = true
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => alive && setVersion(v))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="set-section">
      <h3 className="set-section__title">产品信息</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Info size={15} /></span>当前版本</span>}
        description="Work Duo 本地客户端。"
        control={<code className="set-about-version">v{version}</code>}
      />

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Mail size={15} /></span>意见反馈</span>}
        description="遇到问题时，欢迎提交反馈帮助我们改进。"
        control={
          <Button variant="soft" size="sm" onClick={() => openExternal(FEEDBACK_URL, '意见反馈')}>
            <Mail size={14} />
            提交反馈
          </Button>
        }
      />

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><BookOpen size={15} /></span>帮助文档</span>}
        description="查看使用指南、常见问题与最佳实践。"
        control={
          <Button variant="soft" size="sm" onClick={() => openExternal(HELP_URL, '帮助文档')}>
            <BookOpen size={14} />
            查看文档
          </Button>
        }
      />

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><GitBranch size={15} /></span>开源仓库</span>}
        description="了解项目动态与更新日志。"
        control={
          <Button variant="soft" size="sm" onClick={() => openExternal('', '开源仓库')}>
            <GitBranch size={14} />
            前往仓库
          </Button>
        }
      />
    </div>
  )
}
