"""CVE-2019-9740 修复验收测试：URL 内嵌 CRLF 必须在构造层被拒绝。"""
import pytest

from client import build_request
from validate import is_allowed_url


def test_normal_request():
    req = build_request('GET', '/a/b?x=1', 'api.example.com')
    assert req.startswith('GET /a/b?x=1 HTTP/1.1\r\n')
    assert 'Host: api.example.com' in req


def test_whitelist_still_works():
    assert not is_allowed_url('ftp://x/y')
    assert is_allowed_url('https://x/y')


def test_rejects_crlf_injection():
    # 恶意 URL：白名单内 scheme，但内嵌 \r\n 注入额外头
    evil = 'http://good.example/ HTTP/1.1\r\nHost: evil\r\nX-Inj: 1'
    with pytest.raises(ValueError):
        build_request('GET', evil, 'good.example')


def test_rejects_bare_cr_or_lf():
    # 单独的 \r 或 \n 同样必须拒绝
    with pytest.raises(ValueError):
        build_request('GET', 'http://good.example/\rX: 1', 'good.example')
    with pytest.raises(ValueError):
        build_request('GET', 'http://good.example/\nX: 1', 'good.example')
