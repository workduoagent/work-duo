import { useEffect, useState, useCallback, type ReactNode } from 'react'
import {
  Power,
  Globe,
  FolderOpen,
  Boxes,
  Bell,
  MessagesSquare,
  BookOpen,
  Database,
} from 'lucide-react'
import { Input, Switch, InputNumber, Radio } from '@/components/ui'
import { SettingItem } from './SettingItem'
import { useNotify } from '@/components/ui/notify'
import {
  PROXY_MODE_OPTIONS,
  type AppSettings,
  type ProxyConfig,
} from '@/core/file/settings-file'
import { open } from '@tauri-apps/plugin-dialog'
import { basename, join } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'
import { resolveStorageBasePath } from '@/core/file/storage-path'
import { rewriteSkillPaths } from '@/core/mapper/skill-mapper'

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

type StorageKey = 'workspacePath' | 'skillPath' | 'knowledgeBasePath' | 'vectorPath'

/** 存储目录选择行：展示当前真实路径 + 「选择目录」按钮（迁移中显示转圈并禁用）。 */
function StorageDirRow({
  icon,
  title,
  description,
  value,
  migrating,
  onPick,
}: {
  icon: ReactNode
  title: ReactNode
  description: ReactNode
  value: string
  migrating: boolean
  onPick: () => void
}) {
  const [real, setReal] = useState(value)
  useEffect(() => {
    let alive = true
    void resolveStorageBasePath(value).then((p) => {
      if (alive) setReal(p)
    })
    return () => {
      alive = false
    }
  }, [value])

  return (
    <SettingItem
      title={<Title icon={icon}>{title}</Title>}
      description={description}
      control={
        <div className="set-dir">
          <code className="set-dir__path" title={real}>
            {real || value}
          </code>
          <button type="button" className="set-dir__btn" onClick={onPick} disabled={migrating}>
            {migrating && <span className="set-dir__spinner" aria-hidden />}
            {migrating ? '迁移中…' : '选择目录'}
          </button>
        </div>
      }
    />
  )
}

/** 系统设置分区：开机自启 / 网络代理 / 工作空间 / Skill 目录 / 客户端通知 / 会话管理。 */
export function SystemSettingsPanel({ settings, onChange }: Props) {
  const { message } = useNotify()
  const [migrating, setMigrating] = useState<StorageKey | null>(null)

  const setProxy = (patch: Partial<ProxyConfig>) =>
    onChange({ networkProxy: { ...settings.networkProxy, ...patch } })

  const proxyManual = settings.networkProxy.mode === 'manual'

  const pickDir = useCallback(
    async (key: StorageKey, expectedSeg: string) => {
      if (migrating) return
      const selected = await open({ directory: true, multiple: false })
      if (!selected || typeof selected !== 'string') return
      const trimmed = selected.replace(/[\\/]+$/, '')
      const base =
        (await basename(trimmed)) === expectedSeg ? trimmed : await join(trimmed, expectedSeg)

      const oldReal = await resolveStorageBasePath(settings[key])
      if (base === oldReal) return // 未变化，无需迁移

      const oldRaw = settings[key]
      setMigrating(key)
      try {
        // 向量库目录迁移有专属语义：close → move → 更新配置 → reopen（LanceDB 连接常驻，
        // 不能沿用通用 migrate_storage_dir，否则迁移后 Rust 侧仍持有旧目录句柄）。
        if (key === 'vectorPath') {
          await invoke<{ moved: number; skipped: boolean }>('set_vector_path', { newPath: base })
          message.success('已更新向量库目录并重连')
        } else {
          const report = await invoke<{ moved: number; skipped: boolean }>('migrate_storage_dir', {
            oldPath: oldReal,
            newPath: base,
          })
          if (report.skipped || report.moved === 0) {
            message.success('已更新存储目录')
          } else {
            message.success(`已将 ${report.moved} 个项目迁移至新目录`)
          }
        }
        // Skill 存储目录变更：skill_info.path 落库为旧基址/<identifier>，需整列改写为新基址，
        // 否则前端 skillFs 与 Rust skill_adapter 仍读旧目录（知识库 path 现算不落库，无需处理）。
        if (key === 'skillPath') {
          await rewriteSkillPaths(oldRaw, base)
        }
      } catch (e) {
        message.error(`迁移失败：${typeof e === 'string' ? e : String(e)}`)
        return
      } finally {
        setMigrating(null)
      }
      onChange({ [key]: base })
    },
    [migrating, settings, onChange, message],
  )

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

      <StorageDirRow
        icon={<FolderOpen size={15} />}
        title="默认工作空间存储路径"
        description="新建任务、工作空间时将自动存放在该路径下；修改后不影响已有数据。选择父目录会自动补 .workspace 子目录。"
        value={settings.workspacePath}
        migrating={migrating === 'workspacePath'}
        onPick={() => void pickDir('workspacePath', '.workspace')}
      />

      <StorageDirRow
        icon={<Boxes size={15} />}
        title="Skill 存储目录"
        description="本地自建或导入的 Skill 存放的根目录（对应 app_config.skill_path）；选择父目录会自动补 .skills 子目录。"
        value={settings.skillPath}
        migrating={migrating === 'skillPath'}
        onPick={() => void pickDir('skillPath', '.skills')}
      />

      <StorageDirRow
        icon={<BookOpen size={15} />}
        title="知识库存储目录"
        description="知识库文件存放的根目录（对应 app_config.knowledge_base_path）；每个知识库对应其下一个子目录。选择父目录会自动补 .knowledge_base 子目录。"
        value={settings.knowledgeBasePath}
        migrating={migrating === 'knowledgeBasePath'}
        onPick={() => void pickDir('knowledgeBasePath', '.knowledge_base')}
      />

      <StorageDirRow
        icon={<Database size={15} />}
        title="向量库存储目录"
        description="LanceDB 向量数据根目录（对应 app_config.vector_path），承载记忆 / 项目蓝图 / 知识库切片的语义检索。修改后自动迁移数据并重连。"
        value={settings.vectorPath}
        migrating={migrating === 'vectorPath'}
        onPick={() => void pickDir('vectorPath', '.vectors')}
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
