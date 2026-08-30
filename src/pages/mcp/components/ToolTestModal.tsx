/**
 * 工具「编辑测试参数」弹窗。
 * 约束：仅允许编辑工具的测试案例内容（testParams，JSON 对象），
 * 其余字段（toolCode / displayName）以只读表格展示，避免误改自动发现出的定义。
 *
 * 交互：
 *  - 「测试参数」支持两种模式：
 *      · 表单模式（默认）：按工具的 inputSchema 自动渲染字段，免手敲 JSON；
 *      · JSON 模式：直接编辑原始 JSON；
 *    两者共享同一份值，切换时互相同步（JSON 非法时保留上一份有效值）。
 *  - 底部「测试」按钮：以裁剪空值后的参数作为 arguments 调用 tools/call；
 *  - 结果以 JSON 编辑器（只读）回显。真实调用走 Rust 后端 call_mcp_tool（避免 CORS）。
 */
import { useEffect, useState } from 'react'
import { Button, Field, FieldLabel, Modal } from '@/components/ui'
import { Descriptions } from 'antd'
import { useNotify } from '@/components/ui/notify'
import {
  callMcpTool,
  type McpToolCallResult,
} from '@/core/mapper/mcp-connection'
import type { McpInfo, McpToolDefinition } from '@/core/file/mcp-file'
import { MonacoJsonEditor } from '@/components/code-editor'
import { SchemaForm, schemaDefaultValue, pruneEmpty } from './SchemaForm'

export interface ToolTestModalProps {
  open: boolean
  /** 当前编辑的工具；关闭时传 null */
  tool: McpToolDefinition | null
  /** 所属 MCP 服务连接信息（测试调用工具时需要其地址 / 认证头 / 超时） */
  mcp: McpInfo | null
  onOpenChange: (open: boolean) => void
  onSave: (tool: McpToolDefinition) => Promise<void> | void
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v)
  )
}

export function ToolTestModal({
  open,
  tool,
  mcp,
  onOpenChange,
  onSave,
}: ToolTestModalProps) {
  const { message, result } = useNotify()
  const [formValue, setFormValue] = useState<Record<string, unknown>>({})
  const [jsonText, setJsonText] = useState('{}')
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpToolCallResult | null>(null)

  useEffect(() => {
    if (!open) return
    const init = isPlainObject(tool?.testParams)
      ? structuredClone(tool!.testParams)
      : schemaDefaultValue(tool?.inputSchema)
    setFormValue(init)
    setJsonText(JSON.stringify(init, null, 2))
    setMode('form')
    setTestResult(null)
  }, [open, tool])

  function switchMode(next: 'form' | 'json') {
    if (next === 'json') setJsonText(JSON.stringify(formValue, null, 2))
    setMode(next)
  }

  async function handleSave() {
    if (!tool) return
    setSaving(true)
    try {
      const next: McpToolDefinition = {
        ...tool,
        testParams: isPlainObject(formValue) ? pruneEmpty(formValue) : undefined,
      }
      await onSave(next)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    if (!tool) return
    if (!mcp) {
      message.warning('缺少服务连接信息，无法测试')
      return
    }
    const args = pruneEmpty(isPlainObject(formValue) ? formValue : {})
    setTesting(true)
    setTestResult(null)
    try {
      const res = await callMcpTool(mcp, tool.toolCode ?? '', args)
      setTestResult(res)
      result(res, '工具调用成功', '调用失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width="92%"
      title="编辑工具测试参数"
      description="仅可编辑该工具的测试参数，用于连通性测试时携带的请求参数；其余字段由服务自动发现，不可修改。"
      footer={
        <div className="mcphub__form-footer mcphub__test-footer">
          <Button
            variant="soft"
            loading={testing}
            disabled={saving}
            onClick={handleTest}
          >
            测试
          </Button>
          <div className="mcphub__test-footer-right">
            <Button variant="soft" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button loading={saving} onClick={handleSave}>
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className="mcphub__form">
        {/* 工具标识 / 展示名称：位置保持不变（顶部只读） */}
        <Descriptions
          column={2}
          size="small"
          bordered
          className="mcphub-tool-modal__meta"
        >
          <Descriptions.Item label="工具标识">
            <code className="mcphub-tool-modal__code">{tool?.toolCode || '-'}</code>
          </Descriptions.Item>
          <Descriptions.Item label="展示名称">
            <code className="mcphub-tool-modal__code">{tool?.displayName || '-'}</code>
          </Descriptions.Item>
        </Descriptions>

        {/* 入参结构 | 出参结构：左右并排，高度加大 */}
        <div className="mcphub__schema-grid">
          <Field>
            <FieldLabel>入参结构</FieldLabel>
            <MonacoJsonEditor
              value={tool?.inputSchema ?? {}}
              readOnly
              height={360}
              showToolbar={false}
            />
            <p className="mcphub-tool-modal__hint">
              以下为服务自动发现的入参结构；可在下方「表单」中按字段填写，无需手敲 JSON。
            </p>
          </Field>

          <Field>
            <FieldLabel>出参结构</FieldLabel>
            <MonacoJsonEditor
              value={tool?.outputSchema ?? {}}
              readOnly
              height={360}
              showToolbar={false}
            />
          </Field>
        </div>

        {/* 测试参数：表单 / JSON 双模式 */}
        <Field>
          <FieldLabel>
            <span style={{ marginRight: 12 }}>测试参数 (testParams)</span>
            <span className="mcphub-tool-modal__mode">
              <button
                type="button"
                className={mode === 'form' ? 'is-active' : ''}
                onClick={() => switchMode('form')}
              >
                表单
              </button>
              <button
                type="button"
                className={mode === 'json' ? 'is-active' : ''}
                onClick={() => switchMode('json')}
              >
                JSON
              </button>
            </span>
          </FieldLabel>

          {mode === 'form' ? (
            <SchemaForm
              key={tool?.id ?? 'new'}
              schema={tool?.inputSchema}
              value={formValue}
              onChange={setFormValue}
            />
          ) : (
            <MonacoJsonEditor
              key={tool?.id ?? 'new'}
              mode="code"
              value={jsonText}
              onChange={(v) => {
                const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
                setJsonText(text)
                try {
                  const parsed = JSON.parse(text)
                  if (isPlainObject(parsed)) setFormValue(parsed)
                } catch {
                  /* 非法 JSON 暂不回写，保留上一份有效值 */
                }
              }}
              height={300}
            />
          )}
        </Field>

        {testResult && (
          <Field>
            <FieldLabel>
              调用结果{testResult.ok ? '（成功）' : '（失败）'}
            </FieldLabel>
            <MonacoJsonEditor
              value={
                testResult.value ?? { error: testResult.error ?? '无返回内容' }
              }
              readOnly
              height={240}
              showToolbar={false}
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}
