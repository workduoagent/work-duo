"""导出侧（坏种子：本地覆盖了一个与 converter 都不一样的错值）"""
from converter import FEN_PER_YUAN

FEN_PER_YUAN = 10000  # 缺陷：本地覆盖，且与 converter 的 1000、契约的 100 都不同


def export_row(row):
    return {
        "order_no": row["order_no"],
        "amount_yuan": row["amount_fen"] / FEN_PER_YUAN,
        "currency": "CNY",
    }
