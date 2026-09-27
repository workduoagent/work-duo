"""库存报表（坏种子：import 名与 stock.py 实际导出错位）"""
from inventory import get_stock  # 缺陷：模块名错位（应为 stock）


def build_report(skus):
    lines = []
    total = 0
    for sku in skus:
        n = get_stock(sku)
        total += n
        lines.append(f"{sku}: {n} 件")
    lines.append(f"TOTAL: {total} 件")
    return "\n".join(lines)
