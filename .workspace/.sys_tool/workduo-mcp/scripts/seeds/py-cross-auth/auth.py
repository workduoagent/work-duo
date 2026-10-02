"""签发侧（坏种子：签名算法与校验侧约定不一致——用了 SHA1 且拼接方式偏离契约）"""
import hashlib
import hmac

SECRET = b"dev-secret-2026"


def issue_token(user_id):
    # 契约（见 verify.py 顶部 docstring 与 test_auth.py）：token = "<user_id>:<expire>.<sig>"，
    # 其中 sig = HMAC_SHA256(SECRET, payload)，payload = "<user_id>:<expire>"
    payload = f"{user_id}:{1690000000 + 3600}"
    sig = hashlib.sha1(SECRET + payload.encode()).hexdigest()  # 缺陷：算法与拼接方式都偏离契约
    return f"{payload}.{sig}"
