"""校验侧（坏种子：分割符与算法都偏离签发契约）。

契约：token = "<user_id>:<expire>.<sig>"，sig = HMAC_SHA256(SECRET, payload)；
校验通过返回 user_id（int），否则返回 None。
"""
import hashlib
import hmac

SECRET = b"dev-secret-2026"


def verify_token(token):
    try:
        payload, sig = token.split(":")  # 缺陷：分割符应为 "."（payload 本身含 ":"）
        expect = hashlib.sha256(payload.encode()).hexdigest()  # 缺陷：漏 SECRET 且算法偏离契约
        return int(payload.split(":")[0]) if hmac.compare_digest(sig, expect) else None
    except Exception:
        return None
