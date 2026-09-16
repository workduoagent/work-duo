/**
 * 插件「试跑」弹窗：编辑 JSON 参数 → invoke test_user_plugin 沙箱执行 → 全字段结果面板。
 *
 * - 参数默认取 sample_params，否则按 schema 生成空壳 {}；
 * - 结果展示 PluginTestResult：ok / durationMs / exitCode / result / stdout / stderr /
 *   depsInstalled（自愈提示）/ errorType / missingPackage / errorMessage / traceback；
 * - 成功后可「保存为示例参数」（saveSampleParams 落库）。
 * 试跑是用户主动执行（设计稿 §5.2），无需再走审批。
 */
import { useEffect, useState } from 'react'
import { Play, Save } from 'lucide-react'
import { Button, Field, FieldLabel, Modal } from '@/components/ui'
import { Alert, Descriptions, Tabs } from 'antd'
import { useNotify } from '@/components/ui/notify'
import { MonacoJsonEditor } from '@/components/code-editor'
import type { UserPluginTool, PluginTestResult } from '@/core/file/plugin-file'
import { saveSampleParams } from '@/core/mapper/plugin-mapper'
import { testPlugin } from '@/core/mapper/plugin-connection'

export interface PluginTestModalProps {
  open: boolean
  plugin: UserPluginTool | null
  onOpenChange: (open: boolean) => void
  /** 试跑后通知父级刷新（last_run 状态可能变化） */
  onTested?: () => void
}

/** 按 schema 生成空壳参数对象（仅顶层属性，值为空串/0/false 的保守默认）。 */
function emptyParamsFromSchema(schema: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try {
    const props = (schema as { properties?: Record<string, unknown> }).properties
    if (props && typeof props === 'object') {
      for (const [k, def] of Object.entries(props)) {
        const t = (def as { type?: string }).type
        if (t === 'number' || t === 'integer') out[k] = 0
        else if (t === 'boolean') out[k] = false
        else if (t === 'array') out[k] = []
        else if (t === 'object') out[k] = {}
        else out[k] = ''
      }
    }
  } catch {
    /* 忽略：schema 非法时给空对象 */
  }
  return out
}

const ERROR_TYPE_LABEL: Record<string, string> = {
  DependencyMissing: '依赖缺失',
  Timeout: '执行超时',
  RuntimeError: '运行错误',
  InvalidJson: '返回值非 JSON',
  Internal: '平台内部错误',
}

export function PluginTestModal({
  open,
  plugin,
  onOpenChange,
  onTested,
}: PluginTestModalProps) {
  const { message } = useNotify()
  const [paramsText, setParamsText] = useState('{}')
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<PluginTestResult | null>(null)

  useEffect(() => {
    if (!open) return
    const init =
      plugin?.sampleParams && Object.keys(plugin.sampleParams).length > 0
        ? plugin.sampleParams
        : emptyParamsFromSchema(plugin?.parametersSchema)
    setParams(init)
    setParamsText(JSON.stringify(init, null, 2))
    setTestResult(null)
  }, [open, plugin])

  async function handleTest() {
    if (!plugin) return
    let args: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(paramsText)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象')
      }
      args = parsed as Record<string, unknown>
    } catch (e) {
      message.error(`参数 JSON 非法：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testPlugin(plugin.id, args)
      setTestResult(res)
      if (res.ok) {
        message.success(
          res.depsInstalled.length > 0
            ? `试跑成功（已自动安装依赖：${res.depsInstalled.join('、')}）`
            : '试跑成功',
        )
      } else {
        message.error(
          `试跑失败：${ERROR_TYPE_LABEL[res.errorType ?? ''] ?? res.errorType ?? '未知错误'}`,
        )
      }
      onTested?.()
    } catch (e) {
      message.error(`试跑异常：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  async function handleSaveSample() {
    if (!plugin || !testResult?.ok) return
    await saveSampleParams(plugin.id, params)
    // 通知父级刷新列表：否则编辑弹窗回显的还是刷新前的旧 sampleParams
    onTested?.()
    message.success('已保存为示例参数')
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width="92%"
      title={`试跑插件：${plugin?.name || ''}`}
      description="在沙箱内执行 run(params)；依赖缺失会自动安装并重试一次（安装单独计时 120s，不计入插件超时）。"
      footer={
        <div className="pluginhub__test-footer">
          <Button
            variant="soft"
            loading={testing}
            onClick={handleTest}
          >
            <Play size={14} />
            试跑
          </Button>
          <div className="pluginhub__test-footer-right">
            <Button variant="soft" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button
              variant="soft"
              disabled={!testResult?.ok}
              onClick={handleSaveSample}
            >
              <Save size={14} />
              保存为示例参数
            </Button>
          </div>
        </div>
      }
    >
      <div className="pluginhub__form">
        <Field>
          <FieldLabel>试跑参数（JSON 对象）</FieldLabel>
          <MonacoJsonEditor
            mode="code"
            language="json"
            value={paramsText}
            height={200}
            onChange={(v) => {
              if (typeof v === 'string') {
                setParamsText(v)
                try {
                  const parsed = JSON.parse(v)
                  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    setParams(parsed)
                  }
                } catch {
                  /* 非法 JSON 暂不回写，保留上一份有效值 */
                }
              }
            }}
          />
        </Field>

        {testResult && (
          <>
            {testResult.ok ? (
              testResult.depsInstalled.length > 0 && (
                <Alert
                  type="success"
                  showIcon
                  message={`依赖自愈生效：已自动安装 ${testResult.depsInstalled.join('、')} 并重试成功`}
                />
              )
            ) : (
              <Alert
                type="error"
                showIcon
                message={`执行失败：${ERROR_TYPE_LABEL[testResult.errorType ?? ''] ?? testResult.errorType ?? '未知错误'}`}
                description={
                  testResult.missingPackage || testResult.errorMessage || undefined
                }
              />
            )}

            <Descriptions
              column={3}
              size="small"
              bordered
              className="pluginhub__meta"
            >
              <Descriptions.Item label="结果">
                {testResult.ok ? '成功' : '失败'}
              </Descriptions.Item>
              <Descriptions.Item label="耗时">
                {testResult.durationMs} ms
              </Descriptions.Item>
              <Descriptions.Item label="退出码">
                {testResult.exitCode ?? '-'}
              </Descriptions.Item>
            </Descriptions>

            <Tabs
              defaultActiveKey="result"
              items={[
                {
                  key: 'result',
                  label: '返回值',
                  children: (
                    <MonacoJsonEditor
                      value={
                        testResult.result ?? {
                          error: testResult.errorMessage ?? '无返回内容',
                        }
                      }
                      readOnly
                      height={260}
                      showToolbar={false}
                    />
                  ),
                },
                {
                  key: 'stdout',
                  label: 'stdout',
                  children: (
                    <MonacoJsonEditor
                      mode="code"
                      language="text"
                      value={testResult.stdout || '（空）'}
                      readOnly
                      height={260}
                      showToolbar={false}
                    />
                  ),
                },
                {
                  key: 'stderr',
                  label: 'stderr',
                  children: (
                    <MonacoJsonEditor
                      mode="code"
                      language="text"
                      value={
                        (testResult.stderr || '（空）') +
                        (testResult.traceback
                          ? `\n\n--- traceback ---\n${testResult.traceback}`
                          : '')
                      }
                      readOnly
                      height={260}
                      showToolbar={false}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
