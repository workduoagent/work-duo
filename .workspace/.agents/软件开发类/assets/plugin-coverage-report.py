"""
name: coverage-report
description: 解析 coverage.json 并输出覆盖率与最低覆盖文件缺口清单
dependencies: []
parameters:
  workspace:
    type: string
    description: 工程根目录
    required: true
  coverageJson:
    type: string
    description: coverage.json 相对路径，默认 coverage.json
    required: false
  minPct:
    type: number
    description: 门禁百分比，默认 70
    required: false
"""
from __future__ import annotations

import json
from pathlib import Path


def run(params):
    params = params or {}
    ws = Path(params.get("workspace") or ".").resolve()
    rel = params.get("coverageJson") or "coverage.json"
    path = (ws / rel).resolve()
    if not path.is_file():
        raise FileNotFoundError(
            f"coverage json not found: {path}. Run: coverage run -m pytest && coverage json"
        )

    data = json.loads(path.read_text(encoding="utf-8"))
    files = data.get("files") or {}
    min_pct = float(params.get("minPct") or 70)

    rows = []
    for fpath, meta in files.items():
        summary = meta.get("summary") or {}
        covered = summary.get("covered_lines") or summary.get("num_statements") or 0
        stmts = summary.get("num_statements") or 0
        pct = summary.get("percent_covered") or (100.0 * covered / stmts if stmts else 0.0)
        rows.append(
            {
                "file": fpath,
                "percentCovered": round(float(pct), 2),
                "numStatements": stmts,
                "coveredLines": covered,
                "missingLines": summary.get("missing_lines") or [],
            }
        )

    rows.sort(key=lambda r: r["percentCovered"])
    total = (data.get("totals") or {}).get("percent_covered")
    if total is None and rows:
        st = sum(r["numStatements"] for r in rows) or 1
        cv = sum(r["coveredLines"] for r in rows)
        total = 100.0 * cv / st

    return {
        "ok": float(total or 0) >= min_pct,
        "totalPercentCovered": round(float(total or 0), 2),
        "minPct": min_pct,
        "fileCount": len(rows),
        "lowestFiles": rows[:15],
        "workspace": str(ws),
    }
