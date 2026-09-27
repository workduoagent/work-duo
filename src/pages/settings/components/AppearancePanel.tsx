import { useCallback } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'
import { Radio } from '@/components/ui'
import { SettingItem } from './SettingItem'
import { useTheme } from '@/hooks/useTheme'
import { useAppDispatch } from '@/core/store'
import { setAccent } from '@/core/store/slices/themeSlice'
import type { ThemeMode, AccentTheme } from '@/core/store/slices/themeSlice'
import type { AppSettings } from '@/core/file/settings-file'

/** 四种主品牌色调；简约（默认）还原应用原始主题（晴空蓝），其余三档取 Logo 三色环起止色。 */
const ACCENTS: { value: AccentTheme; label: string; from: string; to: string; hint?: string }[] = [
  { value: 'minimal', label: '简约', from: '#0ea5e9', to: '#38bdf8', hint: '默认' },
  { value: 'sky', label: '天青蓝', from: '#38BDF8', to: '#60CFFA' },
  { value: 'mint', label: '薄荷绿', from: '#34D399', to: '#5CDFB5' },
  { value: 'lilac', label: '淡紫', from: '#A78BFA', to: '#C4A8FE' },
]

interface Props {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}

/**
 * 外观设置分区：主题色（跟随系统/浅色/深色） + 主品牌色调（简约/天青蓝/薄荷绿/淡紫）。
 * - 主题色经由 Redux themeSlice（持久化于 localStorage）；
 * - 色调同时写入 Redux（即时预览）与 app_config.accent（持久化）。
 * - 默认色调为「简约」= 应用原始主题（Zinc 灰阶 + 晴空蓝，改三色主题之前的版本）。
 */
export function AppearancePanel({ settings, onChange }: Props) {
  const { theme, setTheme } = useTheme()
  const dispatch = useAppDispatch()

  const applyAccent = useCallback(
    (next: AccentTheme) => {
      dispatch(setAccent(next)) // 即时预览
      onChange({ accent: next }) // 落库 app_config.accent
    },
    [dispatch, onChange],
  )

  return (
    <div className="set-section">
      <h3 className="set-section__title">主题</h3>

      <SettingItem
        title="主题色"
        description="跟随系统将根据操作系统的浅色 / 深色模式自动切换。"
      >
        <Radio.Group
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeMode)}
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button value="system">
            <Monitor size={14} className="set-radio-icon" /> 跟随系统
          </Radio.Button>
          <Radio.Button value="light">
            <Sun size={14} className="set-radio-icon" /> 浅色
          </Radio.Button>
          <Radio.Button value="dark">
            <Moon size={14} className="set-radio-icon" /> 深色
          </Radio.Button>
        </Radio.Group>
      </SettingItem>

      <h3 className="set-section__title">色调</h3>

      <SettingItem
        title="主品牌色调"
        description="选择应用的主品牌色 / 整体色调。简约（默认）还原应用原始主题；其余三档为 Logo 三色环配色，影响按钮、选中态、焦点环等主色表现。"
      >
        <div className="accent-swatches">
          {ACCENTS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`accent-swatch${settings.accent === a.value ? ' is-active' : ''}`}
              onClick={() => applyAccent(a.value)}
              aria-pressed={settings.accent === a.value}
            >
              <span
                className="accent-swatch__chip"
                style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}
              />
              <span className="accent-swatch__label">
                {a.label}
                {a.hint && <em className="accent-swatch__hint">（{a.hint}）</em>}
              </span>
            </button>
          ))}
        </div>
      </SettingItem>
    </div>
  )
}
