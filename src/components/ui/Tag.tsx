import { Tag as AntTag, type TagProps as AntTagProps } from 'antd'
import './Tag.scss'

/**
 * 主题感知的标签（F051）。
 *
 * 背景：`Tag` 原是 antd 直接 re-export，业务侧普遍用**预设色名**（`gold` /
 * `blue` / `cyan` / `geekblue` …）—— 这些色值是 antd 写死的**固定 RGB**，不随
 * 应用的 5 套色调（minimal / ocean / sky / mint / lilac × 明暗）变化。在 Mint /
 * Lilac 主题下，一个 antd 的金色「汇总」标签会与整体色调冲突（突兀）。
 *
 * 本组件的取舍：**不删除 antd 的 `color`**，而是新增 `variant`（语义名）。
 * 业务侧把 `color="gold"` 改为 `variant="warn"` 即可自动跟随主题；既有
 * `color` 调用保持原样可用（渐进迁移，不阻塞存量代码）。
 *
 * 语义映射（全部走 CSS 令牌，故自动跟随明暗与色调）：
 *   brand主色 / info信息 / success成功 / warn警告 / danger危险 / neutral中性
 */
export type TagVariant =
  | 'brand'
  | 'info'
  | 'success'
  | 'warn'
  | 'danger'
  | 'neutral'

export interface TagProps extends Omit<AntTagProps, 'color'> {
  /** 语义色（跟随主题）。优先于 antd预设 `color` 的视觉效果。 */
  variant?: TagVariant
  /** 保留 antd 预设色名（向后兼容）；与 variant 同时给出时以 variant 为准。 */
  color?: AntTagProps['color']
}

export function Tag({ variant, color, className, ...rest }: TagProps) {
  if (!variant) {
    // 未用 variant：原样透传（antd 预设色行为不变）
    return <AntTag color={color} className={className} {...rest} />
  }
  return (
    <AntTag
      // 用 bordered 形态 + 令牌化底色，避免 antd 实心预设色在浅底上刺眼
      bordered
      className={`app-tag app-tag--${variant}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}

export default Tag
