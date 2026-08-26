import { useState } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, Button, Input, Field, FieldLabel, Modal } from '@/components/ui'
import { PlusIcon, TrashIcon } from '@/components/ui/icons'
import './index.scss'

interface ModelItem {
  id: string
  name: string
  provider: string
}

export default function ModelSettingsPage() {
  const [models, setModels] = useState<ModelItem[]>([
    { id: crypto.randomUUID(), name: 'GPT-4o', provider: 'openai' },
  ])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')

  function add() {
    if (!name.trim()) return
    setModels((list) => [
      ...list,
      { id: crypto.randomUUID(), name: name.trim(), provider: provider.trim() || 'custom' },
    ])
    setName('')
    setProvider('')
    setOpen(false)
  }

  function remove(id: string) {
    setModels((list) => list.filter((m) => m.id !== id))
  }

  return (
    <div className="ms">
      <div className="ms__head">
        <p className="ms__lead">管理可用的模型配置。</p>
        <Button onClick={() => setOpen(true)}>
          <PlusIcon data-icon="start" />
          新增模型
        </Button>
      </div>

      <div className="ms__grid">
        {models.map((m) => (
          <Card key={m.id} frame="solid">
            <CardHeader>
              <div className="ms__card-row">
                <div>
                  <CardTitle className="ms__card-title">{m.name}</CardTitle>
                  <CardDescription>Provider: {m.provider}</CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="icon-md"
                  className="ms__card-del"
                  aria-label="删除"
                  onClick={() => remove(m.id)}
                >
                  <TrashIcon />
                </Button>
              </div>
            </CardHeader>
          </Card>
        ))}
        {models.length === 0 && (
          <p className="ms__empty">暂无模型配置，点击右上角新增。</p>
        )}
      </div>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="新增模型"
        description="填写模型的名称与提供方。"
        footer={
          <>
            <Button variant="soft" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={add}>保存</Button>
          </>
        }
      >
        <div className="ms__form">
          <Field>
            <FieldLabel>模型名称</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 GPT-4o"
            />
          </Field>
          <Field>
            <FieldLabel>提供方</FieldLabel>
            <Input
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="例如 openai"
            />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
