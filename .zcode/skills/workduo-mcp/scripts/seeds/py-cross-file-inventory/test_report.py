from report import build_report


def test_report_lines_in_pieces():
    out = build_report(["A100", "B200"])
    assert "A100: 36 件" in out
    assert "B200: 144 件" in out


def test_report_total_in_pieces():
    out = build_report(["A100", "B200", "C300"])
    assert "TOTAL: 264 件" in out  # (3 + 12 + 7) * 12 = 264
