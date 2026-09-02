/**
 * 头像组封装：统一从 antd Avatar.Group 透出，避免页面散用裸 antd。
 */
import type { ComponentProps } from 'react'
import { Avatar, type AvatarProps } from 'antd'

type AvatarGroupProps = ComponentProps<typeof Avatar.Group>

export function AvatarGroup(props: AvatarGroupProps) {
  return <Avatar.Group {...props} />
}

export { Avatar, type AvatarProps }
