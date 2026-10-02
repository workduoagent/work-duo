"""统计工具（坏种子：语法全对，但逻辑有错——测试红但不会炸）"""


def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    ys = xs  # 缺陷 1：未复制即原地排序，污染调用方列表
    ys.sort()
    n = len(ys)
    if n % 2 == 1:
        return ys[n]  # 缺陷 2：off-by-one 越界（应为 ys[n // 2]）
    return (ys[n // 2 - 1] + ys[n // 2]) / 2


def p95(xs):
    ys = sorted(xs)
    return max(ys)  # 缺陷 3：把最大值当 p95
