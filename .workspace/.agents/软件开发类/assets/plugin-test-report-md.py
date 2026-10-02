"""
name: test-report-md
description: 把测试结果 JSON 渲染为 Markdown 报告并可落盘
dependencies: []
parameters:
  resultJson:
    type: object
    description: 测试结果对象，含 passed/failed/failedTests 等
    required: true
  title:
    type: string
    description: 报告标题
    required: false
  workspace:
    type: string
    description: 输出工作空间
    required: false
  outputPath:
    type: string
    description: 相对 workspace 写出 md 路径，为空只返回内容
    required: false
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def run(params):
    params = params or {}
    result = params.get("resultJson")
    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, dict):
        raise ValueError("resultJson must be object or JSON string")

    title = params.get("title") or "测试报告"
    passed = int(result.get("passed") or 0)
    failed = int(result.get("failed") or 0)
    skipped = int(result.get("skipped") or 0)
    errors = int(result.get("errors") or 0)
    failed_tests = result.get("failedTests") or []
    release_ready = failed == 0 and errors == 0

    lines = [
        f"# {title}",
        "",
        f"> 生成时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        "## 概览",
        "",
        f"| 项 | 值 |",
        f"|---|---|",
        f"| 通过 | {passed} |",
        f"| 失败 | {failed} |",
        f"| 跳过 | {skipped} |",
        f"| 错误 | {errors} |",
        f"| 可发布 | {'✅' if release_ready else '❌'} |",
        "",
    ]
    if failed_tests:
        lines += ["## 失败用例", ""]
        for t in failed_tests[:30]:
            lines.append(f"- `{t}`")
        lines.append("")
    if result.get("stdoutTail"):
        lines += ["## 输出摘要", "", "```", str(result["stdoutTail"])[:2000], "```", ""]
    if result.get("knownLimits"):
        lines += ["## 已知限制", ""]
        for x in result["knownLimits"]:
            lines.append(f"- {x}")
        lines.append("")

    content = "\n".join(lines)
    out_path = None
    if params.get("outputPath") and params.get("workspace"):
        out_path = Path(params["workspace"]) / params["outputPath"]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(content, encoding="utf-8")

    return {
        "ok": True,
        "releaseReady": release_ready,
        "markdown": content,
        "outputPath": str(out_path) if out_path else None,
        "summary": {"passed": passed, "failed": failed, "skipped": skipped, "errors": errors},
    }
