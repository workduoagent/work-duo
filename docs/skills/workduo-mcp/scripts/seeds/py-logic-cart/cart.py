"""购物车（坏种子：语法全对，逻辑有错——合计漏乘单价、满减边界写错）"""
CATALOG = {"apple": 300, "book": 4500}  # 单位：分


def total(items):
    # items: [(name, qty)]；缺陷 1：漏乘单价，只加了数量
    return sum(qty for _, qty in items)


def discount(total_fen):
    # 缺陷 2：满 100 元（10000 分）减 500 分，边界写成 >（应为 >=）
    if total_fen > 10000:
        return total_fen - 500
    return total_fen
