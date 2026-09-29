"""
name: code-stats
description: 统计目录代码行数、扩展名分布与最大文件热点
dependencies: []
parameters:
  workspace:
    type: string
    description: 工程根目录
    required: true
  maxHot:
    type: integer
    description: 热点文件数量，默认 10
    required: false
"""
from __future__ import annotations

import os
from collections import Counter
from pathlib import Path

_DEFAULT_EXT = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".java", ".rs", ".go",
    ".sql", ".scss", ".css", ".md", ".json", ".yaml", ".yml", ".toml",
}
_SKIP_DIRS = {
    "node_modules", ".git", "dist", "build", "target", "target-sb",
    ".venv", "__pycache__", ".wd_mem", "coverage", ".next", "out",
}


def run(params):
    params = params or {}
    ws = Path(params.get("workspace") or ".").resolve()
    if not ws.is_dir():
        raise FileNotFoundError(f"workspace not found: {ws}")

    include = set(_DEFAULT_EXT)
    max_hot = int(params.get("maxHot") or 10)

    by_ext = Counter()
    files = []
    for root, dirs, names in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for name in names:
            p = Path(root) / name
            ext = p.suffix.lower()
            if ext not in include:
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
            by_ext[ext] += lines
            files.append(
                {
                    "path": str(p.relative_to(ws)).replace("\\", "/"),
                    "lines": lines,
                    "ext": ext,
                }
            )

    files.sort(key=lambda x: x["lines"], reverse=True)
    total = sum(f["lines"] for f in files)
    return {
        "ok": True,
        "workspace": str(ws),
        "totalFiles": len(files),
        "totalLines": total,
        "linesByExt": dict(by_ext.most_common()),
        "hotspots": files[:max_hot],
    }
