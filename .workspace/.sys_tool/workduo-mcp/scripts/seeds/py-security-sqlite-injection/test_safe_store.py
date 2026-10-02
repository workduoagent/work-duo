"""判分测试：SQL 注入防护（初始全红=缺陷在位；修复后全绿）。禁止修改本文件。"""
import pytest

from store import authenticate, get_user, user_count, _conn


@pytest.fixture()
def conn():
    c = _conn()
    yield c
    c.close()


def test_auth_bypass_rejected(conn):
    # 经典注入：恒真条件绕过密码校验
    assert authenticate(conn, "admin", "wrongpwd") is None
    assert authenticate(conn, "' OR '1'='1' --", "anything") is None
    assert authenticate(conn, "admin' --", "x") is None


def test_quoted_name_lookup(conn):
    # 含引号的名字：拼接实现会破坏 SQL 语法（OperationalError）
    row = get_user(conn, "O'Brien")
    assert row is not None and row[1] == "O'Brien"


def test_drop_table_resisted(conn):
    # DROP 注入：恶意名字不得删表、不得抛错
    malicious = "x'; DROP TABLE users; --"
    assert get_user(conn, malicious) is None
    assert user_count(conn) == 3  # 表与数据完好


def test_normal_lookup(conn):
    assert get_user(conn, "admin") is not None
    assert get_user(conn, "nobody") is None


def test_normal_auth(conn):
    assert authenticate(conn, "admin", "s3cret") is not None
    assert authenticate(conn, "admin", "bad") is None
