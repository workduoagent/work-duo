"""
name: pytest-runner
description: 在指定目录跑 pytest（宿主/沙箱 Python），解析通过/失败与失败堆栈摘要，供 QA 与后端自检。
dependencies: []
parameters:
  type: object
  properties:
    workspace:
      type: string
      description: 测试工程根目录（含 tests 或 pytest.ini/pyproject.toml）
    target:
      type: string
      description: 相对 workspace 的测试路径或文件，默认 tests
    keyword:
      type: string
      description: -k 过滤表达式
    timeoutSec:
      type: integer
      description: 超时秒数，默认 120，上限 300
  required:
    - workspace
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def run(params):
    params = params or {}
    ws = Path(params.get("workspace") or os.getcwd()).resolve()
    if not ws.is_dir():
        raise FileNotFoundError(f"workspace not found: {ws}")

    target = (params.get("target") or "tests").strip()
    if any(ch in target for ch in [";", "|", "&", "`", "$(", "\n"]):
        raise ValueError("target must be a plain relative path")

    timeout = int(params.get("timeoutSec") or 120)
    timeout = max(1, min(timeout, 300))

    pytest_bin = shutil.which("pytest")
    argv = [pytest_bin or sys.executable, "-m" if not pytest_bin else "", "pytest"]
    if not pytest_bin:
        argv = [sys.executable, "-m", "pytest"]
    else:
        argv = [pytest_bin]

    argv += ["-q", "--tb=short", target]
    keyword = (params.get("keyword") or "").strip()
    if keyword:
        argv += ["-k", keyword]

    try:
        proc = subprocess.run(
            argv,
            cwd=str(ws),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "errorType": "timeout", "timeoutSec": timeout}

    out = (proc.stdout or "") + ("\n" + (proc.stderr or ""))
    # 典型摘要: 12 passed, 1 failed in 3.2s / 5 passed
    m = re.search(
        r"(?:(\d+) failed|)(?:(?:, )?(\d+) passed|)(?:(?:, )?(\d+) skipped|)(?:(?:, )?(\d+) error|)",
        out.splitlines()[-1] if out else "",
    )
    failed = int(m.group(1) or 0) if m else 0
    passed = int(m.group(2) or 0) if m else 0
    skipped = int(m.group(3) or 0) if m else 0
    errors = int(m.group(4) or 0) if m else 0

    # 失败用例名
    fails = re.findall(r"^FAILED\s+(\S+)", out, flags=re.M)
    if not fails:
        fails = re.findall(r"^(?:FAILED|ERROR)\s+(\S+)", out, flags=re.M)

    return {
        "ok": proc.returncode == 0 and failed == 0 and errors == 0,
        "exitCode": proc.returncode,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
        "failedTests": fails[:20],
        "workspace": str(ws),
        "target": target,
        "stdoutTail": (proc.stdout or "")[-4000:],
        "stderrTail": (proc.stderr or "")[-1500:],
    }
