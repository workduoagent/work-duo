"""
name: Excel 写入器(xlsx)
description: 把多 sheet 表格数据写成 .xlsx 文件。用户要求 Excel 产物时禁止手写二进制，必须用本插件生成。
dependencies:
  - openpyxl
parameters:
  type: object
  properties:
    outPath:
      type: string
      description: 输出文件路径（工作空间相对路径，文件名须与用户要求逐字一致，如 market.xlsx）
    sheets:
      type: object
      description: 'sheet 名 → 行数据的映射；行数据可以是二维数组 [[cell,...],...] 或 {headers:[...], rows:[[...]]}'
  required:
    - outPath
    - sheets
"""
import os


def run(params):
    # 缺依赖时直接 import 即可，Runner 会在 exit 42 协议下自动安装并重试一次。
    from openpyxl import Workbook

    out_path = str(params.get("outPath", "") or "")
    sheets = params.get("sheets")
    if not out_path:
        return {"ok": False, "error": "缺少必填参数 outPath"}
    if not isinstance(sheets, dict) or not sheets:
        return {"ok": False, "error": 'sheets 须为非空对象，形如 {"价格": [["日期","收盘"],["2026-09-23", 1.2]]}'}

    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)

    wb = Workbook()
    wb.remove(wb.active)  # 删除默认 Sheet，全部用调用方给的 sheet 名
    written = []
    for name, rows in sheets.items():
        title = str(name)[:31] or "Sheet"  # Excel sheet 名上限 31 字符
        ws = wb.create_sheet(title=title)
        if isinstance(rows, dict):
            headers = rows.get("headers") or []
            body = rows.get("rows") or []
            if headers:
                ws.append(headers)
            for r in body:
                ws.append(r)
        else:
            for r in (rows or []):
                ws.append(r)
        written.append(ws.title)

    wb.save(out_path)
    return {"ok": True, "outPath": out_path, "sheets": written}
