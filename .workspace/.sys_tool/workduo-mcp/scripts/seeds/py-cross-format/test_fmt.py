from converter import FEN_PER_YUAN
from exporter import export_row


def test_contract_constant():
    assert FEN_PER_YUAN == 100  # 契约：1 元 = 100 分


def test_export_row_yuan():
    r = export_row({"order_no": "A1", "amount_fen": 250})
    assert r["amount_yuan"] == 2.5
    assert r["order_no"] == "A1"
    assert r["currency"] == "CNY"
