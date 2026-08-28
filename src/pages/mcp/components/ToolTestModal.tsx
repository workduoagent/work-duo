/**
 * 工具「编辑测试参数」弹窗。
 * 约束：仅允许编辑工具的测试案例内容（testParams，JSON 对象），
 * 其余字段（toolCode / displayName）以只读表格展示，避免误改自动发现出的定义。
 *
 * 底部「测试」按钮：以当前 testParams 作为 arguments 调用该工具的 tools/call，
 * 结果以 JSON 编辑器（只读）回显。真实调用走 Rust 后端 call_mcp_tool（避免 CORS）。
 */
import { useEffect, useState } from 'react'
import { Button, Field, FieldLabel, Modal } from '@/components/ui'
import { Descriptions, message } from 'antd'
import {
  callMcpTool,
  type McpToolCallResult,
} from '@/core/mapper/mcp-connection'
import type { McpInfo, McpToolDefinition } from '@/core/file/mcp-file'
import { MonacoJsonEditor } from '@/components/code-editor'

export interface ToolTestModalProps {
  open: boolean
  /** 当前编辑的工具；关闭时传 null */
  tool: McpToolDefinition | null
  /** 所属 MCP 服务连接信息（测试调用工具时需要其地址 / 认证头） */
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
  const [json, setJson] = useState<unknown>(undefined)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpToolCallResult | null>(null)

  useEffect(() => {
    if (!open) return
    setJson(tool?.testParams ? structuredClone(tool.testParams) : {})
    setTestResult(null)
  }, [open, tool])

  async function handleSave() {
    if (!tool) return
    setSaving(true)
    try {
      const next: McpToolDefinition = {
        ...tool,
        testParams: isPlainObject(json) ? json : undefined,
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
    const args = isPlainObject(json) ? json : undefined
    setTesting(true)
    setTestResult(null)
    try {
      const res = await callMcpTool(mcp, tool.toolCode ?? '', args)
      setTestResult(res)
      if (res.ok) message.success('工具调用成功')
      else message.error(`调用失败：${res.error}`)
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
      description="仅可编辑该工具的测试案例（testParams），用于连通性测试时携带的请求参数；其余字段由服务自动发现，不可修改。"
      footer={
        <div className="mcphub__form-footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="soft"
            loading={testing}
            disabled={saving}
            onClick={handleTest}
          >
            测试
          </Button>
          <Button loading={saving} onClick={handleSave}>
            保存
          </Button>
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
          <Descriptions.Item label="工具标识 (tool_code)">
            <code className="mcphub-tool-modal__code">{tool?.toolCode || '-'}</code>
          </Descriptions.Item>
          <Descriptions.Item label="展示名称">
            <code className="mcphub-tool-modal__code">{tool?.displayName || '-'}</code>
          </Descriptions.Item>
        </Descriptions>

        {/* 入参结构 | 出参结构：左右并排，高度加大 */}
        <div className="mcphub__schema-grid">
          <Field>
            <FieldLabel>入参结构 (input_schema)</FieldLabel>
            <MonacoJsonEditor
              value={tool?.inputSchema ?? {}}
              readOnly
              height={360}
              showToolbar={false}
            />
            <p className="mcphub-tool-modal__hint">
              以下为服务自动发现的入参结构，请据此填写下方的「测试参数」字段。
            </p>
          </Field>

          <Field>
            <FieldLabel>出参结构 (output_schema)</FieldLabel>
            <MonacoJsonEditor
              value={tool?.outputSchema ?? {}}
              readOnly
              height={360}
              showToolbar={false}
            />
          </Field>
        </div>

        {/* 测试参数：底部，保持当前高度 */}
        <Field>
          <FieldLabel>测试参数 (testParams · JSON)</FieldLabel>
          <MonacoJsonEditor
            key={tool?.id ?? 'new'}
            value={json}
            onChange={setJson}
            height={300}
          />
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
