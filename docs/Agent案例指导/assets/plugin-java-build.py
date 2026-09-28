"""
name: java-build
description: 宿主 JDK/Maven 或 Gradle 包装（无 JVM 沙箱）：compile/test，解析失败摘要。子命令白名单。
dependencies: []
parameters:
  type: object
  properties:
    workspace:
      type: string
      description: 含 pom.xml 或 build.gradle 的工程根
    action:
      type: string
      description: "固定枚举: compile | test"
      enum: [compile, test]
    tool:
      type: string
      description: "构建工具，默认 auto：maven|gradle|auto"
      enum: [maven, gradle, auto]
    module:
      type: string
      description: 可选 -pl 模块名
    timeoutSec:
      type: integer
      description: 超时秒数，默认 180，上限 600
  required:
    - workspace
    - action
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

_ALLOWED = {"compile", "test"}


def _find_tool(prefer: str, ws: Path):
    if prefer in {"maven", "auto"} and (ws / "pom.xml").is_file():
        mvn = os.environ.get("WD_MVN_BIN") or shutil.which("mvn") or shutil.which("mvn.cmd")
        if mvn:
            return "maven", mvn
    if prefer in {"gradle", "auto"} and any((ws / n).exists() for n in ("build.gradle", "build.gradle.kts", "gradlew", "gradlew.bat")):
        gw = ws / ("gradlew.bat" if os.name == "nt" else "gradlew")
        if gw.exists():
            return "gradle", str(gw)
        g = shutil.which("gradle") or shutil.which("gradle.bat")
        if g:
            return "gradle", g
    raise RuntimeError("maven/gradle not found (set WD_MVN_BIN or install JDK+Maven/Gradle)")


def run(params):
    params = params or {}
    action = (params.get("action") or "").lower()
    if action not in _ALLOWED:
        raise ValueError(f"action must be one of {sorted(_ALLOWED)}")

    ws = Path(params.get("workspace") or ".").resolve()
    if not ws.is_dir():
        raise FileNotFoundError(f"workspace not found: {ws}")

    timeout = int(params.get("timeoutSec") or 180)
    timeout = max(1, min(timeout, 600))
    tool_kind, bin_path = _find_tool((params.get("tool") or "auto").lower(), ws)

    if tool_kind == "maven":
        argv = [bin_path, "-B", "-q"]
        argv += ["test" if action == "test" else "compile"]
        module = params.get("module")
        if module:
            if not re.fullmatch(r"[A-Za-z0-9_.:-]+", module):
                raise ValueError("invalid module name")
            argv += ["-pl", module]
    else:
        argv = [bin_path, "--console=plain"]
        argv += ["test" if action == "test" else "compileJava"]

    env = os.environ.copy()
    java_home = os.environ.get("JAVA_HOME")
    if java_home:
        env["PATH"] = str(Path(java_home) / "bin") + os.pathsep + env.get("PATH", "")

    try:
        proc = subprocess.run(
            argv,
            cwd=str(ws),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "errorType": "timeout", "timeoutSec": timeout, "tool": tool_kind}

    out = (proc.stdout or "") + "\n" + (proc.stderr or "")
    failures = re.findall(r"^\s*(?:\[ERROR\]|FAILURE!|.*FAILED)\s*(.+)$", out, flags=re.M)
    tests = re.search(r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)", out)
    summary = {
        "testsRun": int(tests.group(1)) if tests else None,
        "failures": int(tests.group(2)) if tests else None,
        "errors": int(tests.group(3)) if tests else None,
        "skipped": int(tests.group(4)) if tests else None,
    }

    return {
        "ok": proc.returncode == 0,
        "action": action,
        "tool": tool_kind,
        "command": " ".join(argv),
        "exitCode": proc.returncode,
        **summary,
        "failureSnippets": [f.strip() for f in failures[:15]],
        "stdoutTail": (proc.stdout or "")[-4000:],
        "stderrTail": (proc.stderr or "")[-1500:],
    }
