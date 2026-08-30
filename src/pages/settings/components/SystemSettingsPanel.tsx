import type { ChangeEvent, ReactNode } from 'react'
import { Power, Globe, FolderOpen, Boxes, Bell, MessagesSquare, BookOpen } from 'lucide-react'
import { Input, Switch, InputNumber } from '@/components/ui'
import { Radio } from 'antd'
import { SettingItem } from './SettingItem'
import {
  PROXY_MODE_OPTIONS,
  type AppSettings,
  type ProxyConfig,
} from '@/core/file/settings-file'

interface Props {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}

function Title({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="set-item__title-inline">
      <span className="set-item__title-icon">{icon}</span>
      {children}
    </span>
  )
}

/** 系统设置分区：开机自启 / 网络代理 / 工作空间 / Skill 目录 / 客户端通知 / 会话管理。 */
export function SystemSettingsPanel({ settings, onChange }: Props) {
  const commitText =
    (key: 'workspacePath' | 'skillPath' | 'knowledgeBasePath') =>
    (e: ChangeEvent<HTMLInputElement>) =>
      onChange({ [key]: e.target.value } as Partial<AppSettings>)

  const setProxy = (patch: Partial<ProxyConfig>) =>
    onChange({ networkProxy: { ...settings.networkProxy, ...patch } })

  const proxyManual = settings.networkProxy.mode === 'manual'

  return (
    <div className="set-section">
      <h3 className="set-section__title">基础</h3>

      <SettingItem
        title={<Title icon={<Power size={15} />}>开机自启</Title>}
        description="开启后，系统登录时自动启动 Work Duo（重启后生效）。"
        control={<Switch checked={settings.autoLaunch} onChange={(v) => onChange({ autoLaunch: v })} />}
      />

      <SettingItem
        title={<Title icon={<Bell size={15} />}>客户端通知</Title>}
        description="允许 Work Duo 在桌面端弹出任务完成、会话提醒等通知。"
        control={
          <Switch checked={settings.clientNotify} onChange={(v) => onChange({ clientNotify: v })} />
        }
      />

      <h3 className="set-section__title">网络</h3>

      <SettingItem
        title={<Title icon={<Globe size={15} />}>网络代理</Title>}
        description="配置访问外部服务（如模型 API、MCP 服务）的出站代理方式。"
        control={
          <Radio.Group
            value={settings.networkProxy.mode}
            onChange={(e) => setProxy({ mode: e.target.value })}
            optionType="button"
            buttonStyle="solid"
            options={PROXY_MODE_OPTIONS}
          />
        }
      >
        {proxyManual && (
          <div className="set-proxy">
            <div className="set-proxy__row">
              <label className="set-proxy__label">HTTP</label>
              <Input
                placeholder="http://127.0.0.1:7890"
                defaultValue={settings.networkProxy.http}
                onBlur={(e) => setProxy({ http: e.target.value })}
              />
            </div>
            <div className="set-proxy__row">
              <label className="set-proxy__label">HTTPS</label>
              <Input
                placeholder="https://127.0.0.1:7890"
                defaultValue={settings.networkProxy.https}
                onBlur={(e) => setProxy({ https: e.target.value })}
              />
            </div>
            <div className="set-proxy__row">
              <label className="set-proxy__label">SOCKS5</label>
              <Input
                placeholder="socks5://127.0.0.1:7891"
                defaultValue={settings.networkProxy.socks5}
                onBlur={(e) => setProxy({ socks5: e.target.value })}
              />
            </div>
          </div>
        )}
      </SettingItem>

      <h3 className="set-section__title">存储</h3>

      <SettingItem
        title={<Title icon={<FolderOpen size={15} />}>默认工作空间存储路径</Title>}
        description="新建任务、工作空间时将自动存放在该路径下；修改后不影响已有数据。"
        control={
          <Input
            className="set-item__input"
            defaultValue={settings.workspacePath}
            onBlur={commitText('workspacePath')}
          />
        }
      />

      <SettingItem
        title={<Title icon={<Boxes size={15} />}>Skill 存储目录</Title>}
        description="本地自建或导入的 Skill 存放的根目录（对应 app_config.skill_path）。"
        control={
          <Input
            className="set-item__input"
            defaultValue={settings.skillPath}
            onBlur={commitText('skillPath')}
          />
        }
      />

      <SettingItem
        title={<Title icon={<BookOpen size={15} />}>知识库存储目录</Title>}
        description="知识库文件存放的根目录（对应 app_config.knowledge_base_path）；每个知识库对应其下一个子目录。"
        control={
          <Input
            className="set-item__input"
            defaultValue={settings.knowledgeBasePath}
            onBlur={commitText('knowledgeBasePath')}
          />
        }
      />

      <h3 className="set-section__title">会话</h3>

      <SettingItem
        title={<Title icon={<MessagesSquare size={15} />}>自动新起会话</Title>}
        description="超过设定时间未对话，自动开启新会话。💡 开启后，长时间未活跃的历史上下文将不再发送给模型，有效降低 Token 消耗并提升响应速度。"
        control={
          <Switch
            checked={settings.sessionAutoNew}
            onChange={(v) => onChange({ sessionAutoNew: v })}
          />
        }
      >
        {settings.sessionAutoNew && (
          <div className="set-session">
            <span>超过</span>
            <InputNumber
              min={1}
              max={720}
              value={settings.sessionIdleHours}
              onChange={(v) => onChange({ sessionIdleHours: Number(v ?? 24) })}
            />
            <span>小时未对话，自动开启新会话</span>
          </div>
        )}
      </SettingItem>
    </div>
  )
}
