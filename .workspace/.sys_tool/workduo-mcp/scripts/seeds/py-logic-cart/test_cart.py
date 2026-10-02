from cart import total, discount


def test_total_multiplies_price():
    assert total([("apple", 3), ("book", 2)]) == 300 * 3 + 4500 * 2


def test_discount_boundary():
    assert discount(10000) == 9500  # 满 100 元即减


def test_discount_below():
    assert discount(9999) == 9999
