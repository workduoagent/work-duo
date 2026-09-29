"""
name: sql-migrate-check
description: 检查 SQL 迁移约定：风险语句与 ADD COLUMN 幂等性
dependencies: []
parameters:
  workspace:
    type: string
    description: 工程根目录
    required: true
  sqlPaths:
    type: array
    description: 相对路径列表，默认扫描 init.sql 与 updater.sql
    required: false
"""
from __future__ import annotations

import re
from pathlib import Path

_RISK = [
    (re.compile(r"\bDROP\s+(TABLE|DATABASE)\b", re.I), "DROP TABLE/DATABASE"),
    (re.compile(r"\bTRUNCATE\b", re.I), "TRUNCATE"),
    (re.compile(r"\bDELETE\s+FROM\b(?![^\n]*WHERE)", re.I), "DELETE without WHERE"),
]


def _find_sql(ws: Path, sql_paths) -> list:
    if sql_paths:
        return [ws / p for p in sql_paths if (ws / p).is_file()]
    found = []
    for name in ("init.sql", "updater.sql"):
        found.extend(ws.rglob(name))
    return found


def run(params):
    params = params or {}
    ws = Path(params.get("workspace") or ".").resolve()
    files = _find_sql(ws, params.get("sqlPaths"))
    if not files:
        return {"ok": False, "errorType": "no_sql_files", "workspace": str(ws)}

    findings = []
    checked = []
    for p in files:
        rel = str(p.relative_to(ws)).replace("\\", "/")
        text = p.read_text(encoding="utf-8", errors="ignore")
        checked.append(rel)
        for pat, label in _RISK:
            for m in pat.finditer(text):
                findings.append(
                    {"file": rel, "level": "risk", "rule": label, "snippet": m.group(0)[:80]}
                )
        for m in re.finditer(r"ALTER\s+TABLE[\s\S]{0,200}?ADD\s+COLUMN[\s\S]{0,80};", text, re.I):
            block = m.group(0)
            if "IF NOT EXISTS" not in block.upper():
                findings.append(
                    {
                        "file": rel,
                        "level": "warn",
                        "rule": "ADD COLUMN without IF NOT EXISTS",
                        "snippet": " ".join(block.split())[:100],
                    }
                )

    risks = [f for f in findings if f["level"] == "risk"]
    return {
        "ok": len(risks) == 0,
        "workspace": str(ws),
        "checkedFiles": checked,
        "riskCount": len(risks),
        "warnCount": len(findings) - len(risks),
        "findings": findings[:30],
    }
