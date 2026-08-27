/**
 * 技能详情抽屉（只读）。
 * 展示基础信息 + 标签 + 存储路径 + 时间，以及技能正文（SKILL.md 原文）。
 */
import { Drawer, Descriptions, Tag, Typography, Divider, Empty, Space } from 'antd'
import { Calendar, Pencil } from 'lucide-react'
import { Button } from '@/components/ui'
import { getSkillCategoryLabel, type SkillInfo } from '@/core/file/skill-file'

const { Title, Text } = Typography

export interface SkillDetailDrawerProps {
  open: boolean
  skill: SkillInfo | null
  onClose: () => void
  onEdit: (skill: SkillInfo) => void
}

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function SkillDetailDrawer({
  open,
  skill,
  onClose,
  onEdit,
}: SkillDetailDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={640}
      title={
        <Space>
          <span>技能详情</span>
          {skill?.identifier && (
            <Text type="secondary" style={{ fontSize: 13, fontFamily: 'monospace' }}>
              {skill.identifier}
            </Text>
          )}
        </Space>
      }
      extra={
        skill && (
          <Button onClick={() => onEdit(skill)}>
            <Pencil size={14} />
            编辑
          </Button>
        )
      }
    >
      {!skill ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <Empty description="未选择技能" />
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div className="sk-detail__logo">⚡</div>
            <div>
              <Title level={4} style={{ margin: 0 }}>
                {skill.name}
              </Title>
              <Space size={6} style={{ marginTop: 6 }} wrap>
                <Tag>{getSkillCategoryLabel(skill.scenario)}</Tag>
                {(skill.tags ?? []).map((t, i) => (
                  <Tag key={`${t}-${i}`} color="blue">
                    {t}
                  </Tag>
                ))}
              </Space>
            </div>
          </div>

          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="描述">
              {skill.description || <Text type="secondary">暂无描述</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="存储路径">
              <Text copyable style={{ fontFamily: 'monospace', fontSize: 12 }}>
                {skill.path || '-'}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              <Space size={4}>
                <Calendar size={13} />
                {formatDate(skill.createdAt)}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">
              <Space size={4}>
                <Calendar size={13} />
                {formatDate(skill.updatedAt)}
              </Space>
            </Descriptions.Item>
          </Descriptions>

          <Divider>技能正文 (SKILL.md)</Divider>
          <pre className="sk-detail__md">{skill.instruction || '暂无正文'}</pre>
        </div>
      )}
    </Drawer>
  )
}
