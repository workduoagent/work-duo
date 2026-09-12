/**
 * 技能头像组件。
 *
 * 约定（与用户要求一致）：
 *  - 头像文件固定位于技能根目录下的 logo.<ext>（前缀必为 logo，常见图片格式）；
 *  - 不新增任何数据库字段，UI 直接按默认位置读取；
 *  - 读取不到（未上传 / 文件损坏）时回退为「名称首字」，再不行用 ⚡ 图标。
 *
 * 读取走 src/core/file/skillFs.ts 的 readSkillLogoBase64（异步、Tauri 下从磁盘读）。
 */
import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import type { SkillInfo } from '@/core/file/skill-file'
import { readSkillLogoBase64 } from '@/core/file/skillFs'

export interface SkillAvatarProps {
  skill: SkillInfo
  /** 头像容器尺寸（px），默认 36（卡片）；详情抽屉用 56 */
  size?: number
}

export function SkillAvatar({ skill, size = 36 }: SkillAvatarProps) {
  const [logo, setLogo] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void readSkillLogoBase64(skill.identifier, skill.path)
      .then((url) => {
        if (active) setLogo(url)
      })
      .catch(() => {
        if (active) setLogo(null)
      })
    return () => {
      active = false
    }
    // 依赖 skill 整体引用：编辑/保存后父层 setRecords 会产出新的 SkillInfo 对象，
    // 引用变化即触发重新读盘，使更新后的头像及时刷新（仅依赖 identifier 时编辑不触发）。
  }, [skill.identifier, skill])

  const firstChar = (skill.name || skill.identifier || '').trim().charAt(0).toUpperCase()

  if (logo) {
    return (
      <img
        className="sk-avatar__img"
        src={logo}
        alt={skill.name}
        style={{ width: size, height: size, borderRadius: Math.max(8, size * 0.22) }}
      />
    )
  }

  return (
    <div
      className="sk-avatar__fallback"
      style={{ width: size, height: size, borderRadius: Math.max(8, size * 0.22) }}
    >
      {firstChar || <Zap size={size * 0.5} />}
    </div>
  )
}
