"""
name: 示例插件(Python)
description: 演示 WorkDuo 本地插件的 run(params) 标准写法。接收 params（JSON 对象），返回 JSON 可序列化结果。
dependencies:
  - requests
parameters:
  type: object
  properties:
    url:
      type: string
      description: 目标 URL
    repeat:
      type: integer
      description: 重复次数
  required:
    - url
"""
import sys, json


def run(params):
    # params 为调用方传入的 JSON 对象：
    #   - 试跑：plugin_test 的 params / sampleParams
    #   - Agent 调用：挂载为 custom__<identifier> 工具时的入参
    url = params.get("url", "")
    repeat = int(params.get("repeat", 1) or 1)

    # —— 在此实现业务逻辑；例如发起 HTTP 请求、做文本处理、调用本地命令等 ——
    # 缺依赖时直接 import 即可，Runner 会在 exit 42 协议下自动安装并重试一次。
    items = [{"index": i, "url": url} for i in range(repeat)]

    # 返回值必须是 JSON 可序列化对象；Runner 负责 json.dumps 到 stdout。
    return {
        "ok": True,
        "url": url,
        "count": len(items),
        "items": items,
        "received": params,
    }
