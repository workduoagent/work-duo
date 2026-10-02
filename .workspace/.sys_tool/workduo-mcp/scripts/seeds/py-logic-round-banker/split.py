"""金额分摊（单位：分）——缺陷：round() 银行家舍入 + float 误差导致分摊不平。"""


def split_amount(total: int, n: int) -> list[int]:
    """把 total 分平摊给 n 人，返回每人金额（分）。

    缺陷：人均「四舍五入」后逐项复制，总和不再等于 total。
    例：total=1, n=3 → round(1/3)=0 → [0,0,0]，丢了 1 分。
    """
    share = round(total / n)
    return [share] * n
