import stock


def test_get_stock_returns_pieces():
    # 契约：get_stock 返回件数（1 箱 = 12 件）
    assert stock.get_stock("A100") == 36
    assert stock.get_stock("B200") == 144


def test_get_stock_unknown_sku():
    assert stock.get_stock("ZZZ") == 0
