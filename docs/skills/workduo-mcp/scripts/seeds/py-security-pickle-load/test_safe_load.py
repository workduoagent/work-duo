"""判分测试：受限反序列化（初始 2 红 1 绿=缺陷在位；修复后全绿）。禁止修改本文件。"""
import pickle

import pytest

from session import load_session, save_session

_hits = {"exploit": 0}


def _exploit():
    # 若被 unpickler 执行：哨兵 +1，并抛出带 RCE_EXECUTED 标记的异常
    _hits["exploit"] += 1
    raise RuntimeError("RCE_EXECUTED")


class _Evil:
    def __reduce__(self):
        return (_exploit, ())


def _evil_payload() -> bytes:
    return pickle.dumps({"s": _Evil()})


def test_normal_session_roundtrip():
    st = {"user": "ali", "cart": [1, 2, 3], "vip": True, "memo": None}
    assert load_session(save_session(st)) == st


def test_malicious_payload_rejected():
    # 恶意 payload 必须被拒绝；拒绝异常消息不得包含 RCE_EXECUTED（那是执行成功的痕迹）
    with pytest.raises(Exception) as ei:
        load_session(_evil_payload())
    assert "RCE_EXECUTED" not in str(ei.value), f"反序列化执行了攻击载荷: {ei.value}"


def test_malicious_payload_not_executed():
    try:
        load_session(_evil_payload())
    except Exception:
        pass
    assert _hits["exploit"] == 0, "攻击函数被实际执行（哨兵被置位）"
