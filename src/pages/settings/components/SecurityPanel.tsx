import { Database, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'
import { Popconfirm, Alert } from 'antd'
import { SettingItem } from './SettingItem'
import { DEFAULT_SETTINGS, type AppSettings } from '@/core/file/settings-file'

interface Props {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}

/** 安全中心分区：本地数据存储位置说明 + 重置所有设置为默认。 */
export function SecurityPanel({ settings, onChange }: Props) {
  return (
    <div className="set-section">
      <h3 className="set-section__title">数据安全</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><Database size={15} /></span>本地数据存储位置</span>}
        description="Work Duo 的全部配置、模型、Skill、MCP 与记忆均保存在本机，不上传云端。"
      >
        <div className="set-sec-path">
          <code>{settings.workspacePath}</code>
          <span className="set-sec-path__note">工作空间文件默认存放于此处（可在「系统设置」修改）。</span>
        </div>
      </SettingItem>

      <Alert
        className="set-sec-alert"
        type="info"
        showIcon
        message="数据隔离"
        description="所有密钥（如模型 API Key、MCP 认证配置）仅以本地数据库存储，应用卸载或清除数据后将被一并删除。"
      />

      <h3 className="set-section__title">恢复</h3>

      <SettingItem
        title={<span className="set-item__title-inline"><span className="set-item__title-icon"><RotateCcw size={15} /></span>重置所有设置</span>}
        description="将所有设置项恢复为出厂默认值（不影响模型、Skill、MCP 等业务数据）。"
        control={
          <Popconfirm
            title="确认重置所有设置？"
            description="此操作仅重置设置项，业务数据不受影响。"
            okText="重置"
            cancelText="取消"
            onConfirm={() => onChange({ ...DEFAULT_SETTINGS })}
          >
            <Button variant="soft" size="sm">
              <RotateCcw size={14} />
              重置为默认
            </Button>
          </Popconfirm>
        }
      />
    </div>
  )
}
