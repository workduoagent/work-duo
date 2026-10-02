"""判分测试：金额分摊守恒（初始大面积红=缺陷在位；修复后全绿）。禁止修改本文件。"""
import pytest

from split import split_amount


@pytest.mark.parametrize(
    "total,n",
    [(100, 3), (10, 4), (7, 7), (999, 7), (1, 3), (2, 4), (12345, 13), (50, 8)],
)
def test_sum_conserved(total, n):
    parts = split_amount(total, n)
    assert len(parts) == n
    assert sum(parts) == total, f"分摊不平: sum={sum(parts)} != {total}"


def test_fairness_max_min_le_1():
    parts = split_amount(101, 3)
    assert max(parts) - min(parts) <= 1


def test_each_part_nonnegative():
    assert all(p >= 0 for p in split_amount(2, 4))


def test_exact_division():
    assert split_amount(90, 3) == [30, 30, 30]


def test_zero_total():
    assert split_amount(0, 5) == [0, 0, 0, 0, 0]
