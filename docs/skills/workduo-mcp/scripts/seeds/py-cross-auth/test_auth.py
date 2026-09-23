from auth import issue_token
from verify import verify_token


def test_roundtrip():
    tok = issue_token(42)
    assert verify_token(tok) == 42


def test_tamper_rejected():
    tok = issue_token(42)
    tampered = tok[:-1] + ("0" if tok[-1] != "0" else "1")
    assert verify_token(tampered) is None
