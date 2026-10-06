/**
 * antd 通用组件透传层（展示 / 布局 / 反馈）：统一从 @/components/ui 取，
 * 避免页面里散用裸 antd 组件（台账 S12 ①）。表单控件见 ./controls，行为包装见 ./Button 等。
 */
export { Spin } from 'antd'
export { Empty } from 'antd'
// F051：改用主题感知包装（新增 variant 语义色；antd 预设 color仍向后兼容）
export { Tag, type TagProps, type TagVariant } from './Tag'
export { Tooltip } from 'antd'
export { Pagination } from 'antd'
export { Tabs } from 'antd'
export { Drawer } from 'antd'
export { Descriptions } from 'antd'
export { Typography } from 'antd'
export { Divider } from 'antd'
export { Alert } from 'antd'
export { Space } from 'antd'
export { Progress } from 'antd'
export { Upload } from 'antd'
