/**
 * MCP 导入弹窗：粘贴 / 上传标准 mcpServers.json，解析为标准 MCP 服务草稿，
 * 勾选后回传给调用方落库。
 *
 * 与导出（buildMcpServersJson）对称：支持 type stdio / sse / streamableHttp / http，
 * 远程服务的 env 自动转请求头（*_TOKEN / *API_KEY → Authorization: Bearer）。
 */
import { useEffect, useMemo, useState } from 'react'
import { FileJson, Globe, KeyRound, Plug } from 'lucide-react'
import { Button, Modal, Input, Alert, Checkbox, Tag, Upload as AntUpload } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import {
  getMcpProtocolLabel,
  parseMcpServersJson,
  type McpInfo,
} from '@/core/file/mcp-file'
import './McpImportModal.scss'

export interface McpImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 确认导入：回传选中的 MCP 草稿列表。 */
  onConfirm: (items: McpInfo[]) => void | Promise<void>
}

export function McpImportModal({
  open,
  onOpenChange,
  onConfirm,
}: McpImportModalProps) {
  const { message } = useNotify()
  const [rawText, setRawText] = useState('')
  const [parsed, setParsed] = useState<McpInfo[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (open) {
      setRawText('')
      setParsed(null)
      setWarnings([])
      setError(null)
      setSelected(new Set())
      setImporting(false)
    }
  }, [open])

  function doParse(text: string) {
    const t = text.trim()
    if (!t) {
      setError('请粘贴或上传 mcpServers.json 内容')
      return
    }
    try {
      const { items, warnings: ws } = parseMcpServersJson(t)
      if (items.length === 0) {
        setError('未解析到任何 MCP 服务')
        setParsed(null)
        return
      }
      setParsed(items)
      setWarnings(ws)
      setSelected(new Set(items.map((i) => i.id)))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setParsed(null)
    }
  }

  function handleFile(file: File): boolean {
    if (!/\.json$/i.test(file.name)) {
      message.error('仅支持 .json 文件')
      return false
    }
    void file.text().then((txt) => {
      setRawText(txt)
      doParse(txt)
    })
    return false
  }

  const allChecked = !!parsed && parsed.length > 0 && selected.size === parsed.length
  const indeterminate = selected.size > 0 && selected.size < (parsed?.length ?? 0)

  const selectedItems = useMemo(
    () => (parsed ?? []).filter((i) => selected.has(i.id)),
    [parsed, selected],
  )

  function toggleAll(next: boolean) {
    setSelected(next ? new Set((parsed ?? []).map((i) => i.id)) : new Set())
  }
  function toggleOne(id: string, next: boolean) {
    setSelected((prev) => {
      const s = new Set(prev)
      if (next) s.add(id)
      else s.delete(id)
      return s
    })
  }

  async function handleConfirm() {
    if (selectedItems.length === 0) return
    setImporting(true)
    try {
      await onConfirm(selectedItems)
      onOpenChange(false)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={720}
      title="导入 MCP 服务"
      description="粘贴或上传标准 mcpServers.json（Claude Desktop / 官方 SDK 格式），解析后可勾选要接入的服务。"
      style={{ maxWidth: '92vw' }}
      footer={
        <div className="mcp-import__footer">
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            loading={importing}
            disabled={selectedItems.length === 0}
            onClick={handleConfirm}
          >
            导入{selectedItems.length > 0 ? `（${selectedItems.length}）` : ''}
          </Button>
        </div>
      }
    >
      <div className="mcp-import">
        {/* 配置输入区 */}
        <div className="mcp-import__editor">
          <div className="mcp-import__toolbar">
            <span className="mcp-import__editor-title">
              <FileJson size={14} />
              mcpServers.json
            </span>
            <div className="mcp-import__toolbar-actions">
              <AntUpload accept=".json" showUploadList={false} beforeUpload={handleFile}>
                <Button variant="soft" size="sm">
                  上传 .json
                </Button>
              </AntUpload>
              <Button size="sm" onClick={() => doParse(rawText)}>
                解析
              </Button>
            </div>
          </div>
          <Input.TextArea
            rows={8}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={'{\n  "mcpServers": {\n    "mineru": {\n      "type": "streamableHttp",\n      "url": "https://mcp.mineru.net/mcp",\n      "env": { "MINERU_API_TOKEN": "your token" }\n    }\n  }\n}'}
            spellCheck={false}
          />
        </div>

        {error && (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />
        )}

        {/* 解析结果列表 */}
        {parsed && (
          <div className="mcp-import__result">
            <div className="mcp-import__bar">
              <Checkbox
                checked={allChecked}
                indeterminate={indeterminate}
                onChange={(e) => toggleAll(e.target.checked)}
              >
                全选
              </Checkbox>
              <span className="mcp-import__count">
                已选 <b>{selected.size}</b> / 共 {parsed.length}
              </span>
            </div>

            {warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`解析完成，但有 ${warnings.length} 条提示`}
                description={
                  <ul className="mcp-import__warnings">
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                }
              />
            )}

            <div className="mcp-import__list">
              {parsed.map((mcp) => {
                const hasAuth = mcp.authType !== 'NONE' || !!mcp.headers
                return (
                  <label key={mcp.id} className="mcp-import__item">
                    <Checkbox
                      checked={selected.has(mcp.id)}
                      onChange={(e) => toggleOne(mcp.id, e.target.checked)}
                    />
                    <span className="mcp-import__item-icon">
                      <Plug size={16} />
                    </span>
                    <span className="mcp-import__item-text">
                      <span className="mcp-import__item-head">
                        <span className="mcp-import__item-name">
                          {mcp.aliasName || mcp.mcpName}
                        </span>
                        <code className="mcp-import__item-id">{mcp.mcpName}</code>
                      </span>
                      <span className="mcp-import__item-meta">
                        <span className="mcp-import__chip">
                          {getMcpProtocolLabel(mcp.protocolType)}
                        </span>
                        {mcp.endpointUrl && (
                          <span className="mcp-import__url">
                            <Globe size={12} />
                            {mcp.endpointUrl}
                          </span>
                        )}
                        {hasAuth && (
                          <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                            <KeyRound size={11} style={{ verticalAlign: '-1px' }} />
                            含认证
                          </Tag>
                        )}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
