"""
name: 图表渲染器(PNG)
description: 把序列数据渲染为 PNG 图（line/bar/scatter）。用户要求走势图/分布图时禁止手写二进制，必须用本插件生成。
dependencies:
  - matplotlib
parameters:
  type: object
  properties:
    outPath:
      type: string
      description: 输出 PNG 路径（工作空间相对路径，文件名须与用户要求逐字一致，如 price_trend.png）
    kind:
      type: string
      description: '图型：line | bar | scatter（默认 line）'
    ys:
      type: array
      description: Y 轴数值序列（必填）
    xs:
      type: array
      description: X 轴序列（可省略，省略则用 0..n）
    title:
      type: string
      description: 图表标题
    xLabel:
      type: string
      description: X 轴标签（可省略）
    yLabel:
      type: string
      description: Y 轴标签（可省略）
  required:
    - outPath
    - ys
"""


def run(params):
    import os

    # 无显示环境必须先切 Agg 后端，再 import pyplot（顺序不可颠倒）。
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_path = str(params.get("outPath", "") or "")
    ys_raw = params.get("ys")
    if not out_path:
        return {"ok": False, "error": "缺少必填参数 outPath"}
    if not isinstance(ys_raw, list) or not ys_raw:
        return {"ok": False, "error": "ys 须为非空数值数组"}

    try:
        ys = [float(v) for v in ys_raw]
    except (TypeError, ValueError):
        return {"ok": False, "error": "ys 含非数值元素，无法绘图"}

    xs_raw = params.get("xs")
    if isinstance(xs_raw, list) and len(xs_raw) == len(ys):
        xs = xs_raw
    else:
        xs = list(range(len(ys)))

    kind = str(params.get("kind", "line") or "line").lower()
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=120)
    if kind == "bar":
        ax.bar(range(len(xs)), ys)
        ax.set_xticks(range(len(xs)))
        ax.set_xticklabels([str(x) for x in xs], rotation=30, ha="right", fontsize=7)
    elif kind == "scatter":
        ax.scatter(range(len(xs)), ys, s=14)
        ax.set_xticks(range(len(xs)))
        ax.set_xticklabels([str(x) for x in xs], rotation=30, ha="right", fontsize=7)
    else:
        ax.plot(range(len(xs)), ys, linewidth=1.6, marker="o", markersize=2.5)
        ax.set_xticks(range(len(xs)))
        ax.set_xticklabels([str(x) for x in xs], rotation=30, ha="right", fontsize=7)

    if params.get("title"):
        ax.set_title(str(params["title"]))
    if params.get("xLabel"):
        ax.set_xlabel(str(params["xLabel"]))
    if params.get("yLabel"):
        ax.set_ylabel(str(params["yLabel"]))
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    fig.savefig(out_path)
    plt.close(fig)
    return {"ok": True, "outPath": out_path, "kind": kind, "points": len(ys)}
