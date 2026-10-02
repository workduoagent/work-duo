"""
name: cargo-check
description: 宿主 Rust 工具链包装（非 Rust 沙箱），在工作空间执行 cargo check/test/clippy/metadata 并返回结构化结果
dependencies: []
parameters:
  workspace:
    type: string
    description: Cargo 工程根目录（含 Cargo.toml），默认当前工作空间
    required: false
  action:
    type: string
    description: 固定子命令，仅允许 check|test|clippy|metadata
    required: true
  package:
    type: string
    description: 可选 -p 包名（workspace 成员）
    required: false
  release:
    type: boolean
    description: 是否 --release（仅 check/test）
    required: false
  timeoutSec:
    type: integer
    description: 超时秒数，默认 120，上限 300
    required: false
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

_ALLOWED_ACTIONS = {"check", "test", "clippy", "metadata"}
_MAX_TIMEOUT = 300
_DEFAULT_TIMEOUT = 120


def _find_cargo() -> str:
    explicit = os.environ.get("WD_CARGO_BIN") or os.environ.get("CARGO_BIN")
    if explicit and Path(explicit).is_file():
        return explicit

    cargo_home = os.environ.get("CARGO_HOME") or str(Path.home() / ".cargo")
    for cand in (
        Path(cargo_home) / "bin" / ("cargo.exe" if os.name == "nt" else "cargo"),
        Path.home() / ".cargo" / "bin" / ("cargo.exe" if os.name == "nt" else "cargo"),
    ):
        if cand.is_file():
            return str(cand)

    which = shutil.which("cargo")
    if which:
        return which
    raise RuntimeError(
        "cargo not found. Set WD_CARGO_BIN to cargo.exe absolute path, "
        "or ensure %USERPROFILE%\\.cargo\\bin is on PATH."
    )


def _parse_cargo_diag(text: str) -> dict:
    errors, warnings = [], []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("reason") != "compiler-message":
            continue
        m = msg.get("message") or {}
        level = m.get("level")
        rendered = (m.get("message") or "").strip()
        if level == "error" and rendered:
            errors.append(rendered)
        elif level == "warning" and rendered:
            warnings.append(rendered)

    if not errors and not warnings:
        for line in text.splitlines():
            if re.search(r"^error(\[|:)", line):
                errors.append(line.strip())
            elif re.search(r"^warning(\[|:)", line):
                warnings.append(line.strip())

    return {
        "errorCount": len(errors),
        "warningCount": len(warnings),
        "firstErrors": errors[:5],
        "firstWarnings": warnings[:3],
    }


def run(params):
    params = params or {}
    action = (params.get("action") or "").strip().lower()
    if action not in _ALLOWED_ACTIONS:
        raise ValueError(f"action must be one of {sorted(_ALLOWED_ACTIONS)}, got: {action!r}")

    ws_raw = params.get("workspace") or os.environ.get("WORKSPACE") or os.getcwd()
    ws = Path(ws_raw).resolve()
    if not (ws / "Cargo.toml").is_file():
        raise FileNotFoundError(f"Cargo.toml not found under: {ws}")

    package = (params.get("package") or "").strip()
    if package and not re.fullmatch(r"[A-Za-z0-9_-]+", package):
        raise ValueError("package name must match [A-Za-z0-9_-]+")

    timeout = int(params.get("timeoutSec") or _DEFAULT_TIMEOUT)
    timeout = max(1, min(timeout, _MAX_TIMEOUT))

    cargo = _find_cargo()
    if action == "metadata":
        argv = [cargo, "metadata", "--no-deps", "--format-version", "1"]
    elif action == "clippy":
        argv = [cargo, "clippy", "--message-format=json", "--", "-D", "warnings"]
    elif action == "test":
        argv = [cargo, "test", "--message-format=json"]
    else:
        argv = [cargo, "check", "--message-format=json"]

    if package and action in {"check", "test", "clippy"}:
        argv.extend(["-p", package])
    if params.get("release") and action in {"check", "test"}:
        argv.append("--release")

    env = os.environ.copy()
    cargo_bin_dir = str(Path(cargo).parent)
    env["PATH"] = cargo_bin_dir + os.pathsep + env.get("PATH", "")
    env.setdefault("CARGO_TERM_COLOR", "never")

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
    except subprocess.TimeoutExpired as e:
        return {
            "ok": False,
            "action": action,
            "errorType": "timeout",
            "timeoutSec": timeout,
            "stdoutTail": (e.stdout or "")[-2000:] if isinstance(e.stdout, str) else "",
            "stderrTail": (e.stderr or "")[-2000:] if isinstance(e.stderr, str) else "",
        }

    out = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    diag = (
        _parse_cargo_diag(out)
        if action in {"check", "test", "clippy"}
        else {
            "errorCount": 0 if proc.returncode == 0 else 1,
            "warningCount": 0,
            "firstErrors": [] if proc.returncode == 0 else ["cargo metadata failed"],
            "firstWarnings": [],
        }
    )

    ok = proc.returncode == 0 and diag.get("errorCount", 0) == 0
    result = {
        "ok": ok,
        "action": action,
        "cargo": cargo,
        "workspace": str(ws),
        "package": package or None,
        "exitCode": proc.returncode,
        "timeoutSec": timeout,
        **diag,
        "stdoutTail": (proc.stdout or "")[-4000:],
        "stderrTail": (proc.stderr or "")[-2000:],
    }
    if action == "metadata" and proc.returncode == 0:
        try:
            meta = json.loads(proc.stdout or "{}")
            result["packages"] = [
                {"name": p.get("name"), "version": p.get("version")}
                for p in meta.get("packages", [])[:20]
            ]
        except json.JSONDecodeError:
            pass
    return result
