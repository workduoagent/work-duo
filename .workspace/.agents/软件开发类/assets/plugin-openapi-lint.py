"""
name: openapi-lint
description: 校验 OpenAPI/接口契约片段的路径、方法与必填字段并输出问题列表
dependencies: []
parameters:
  workspace:
    type: string
    description: 工程根目录
    required: true
  specPath:
    type: string
    description: OpenAPI 或契约文件相对路径
    required: true
"""
from __future__ import annotations

import json
import re
from pathlib import Path


def run(params):
    params = params or {}
    ws = Path(params.get("workspace") or ".").resolve()
    spec_path = params.get("specPath")
    if not spec_path:
        raise ValueError("specPath is required")
    path = (ws / spec_path).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"spec not found: {path}")

    text = path.read_text(encoding="utf-8", errors="ignore")
    findings = []

    if path.suffix.lower() == ".json":
        try:
            spec = json.loads(text)
            paths = spec.get("paths") or {}
            for p, item in paths.items():
                if not p.startswith("/"):
                    findings.append({"level": "error", "rule": "path must start with /", "where": p})
                if re.search(r"[A-Z]", p):
                    findings.append({"level": "warn", "rule": "path prefer kebab-case", "where": p})
                if not item:
                    findings.append({"level": "error", "rule": "empty path item", "where": p})
                for method, op in (item or {}).items():
                    if method.lower() not in {
                        "get", "post", "put", "patch", "delete", "head", "options"
                    }:
                        continue
                    if not op.get("summary") and not op.get("operationId"):
                        findings.append(
                            {"level": "warn", "rule": "missing summary/operationId", "where": f"{method.upper()} {p}"}
                        )
                    responses = op.get("responses") or {}
                    if not responses:
                        findings.append(
                            {"level": "error", "rule": "missing responses", "where": f"{method.upper()} {p}"}
                        )
                    if method.upper() in {"POST", "PUT", "PATCH"} and not (
                        op.get("requestBody") or op.get("parameters")
                    ):
                        findings.append(
                            {
                                "level": "warn",
                                "rule": "write method without requestBody/parameters",
                                "where": f"{method.upper()} {p}",
                            }
                        )
        except json.JSONDecodeError as e:
            findings.append({"level": "error", "rule": "invalid JSON", "where": str(e)})
    else:
        apis = re.findall(r"(?i)\b(GET|POST|PUT|PATCH|DELETE)\s+(/[^\s`]+)", text)
        if not apis:
            findings.append({"level": "warn", "rule": "no METHOD /path pairs found", "where": spec_path})
        for method, p in apis:
            if re.search(r"[A-Z]", p):
                findings.append({"level": "warn", "rule": "path prefer lowercase", "where": f"{method} {p}"})

    errors = [f for f in findings if f["level"] == "error"]
    return {
        "ok": len(errors) == 0,
        "workspace": str(ws),
        "specPath": spec_path,
        "errorCount": len(errors),
        "warnCount": len(findings) - len(errors),
        "findings": findings[:40],
    }
