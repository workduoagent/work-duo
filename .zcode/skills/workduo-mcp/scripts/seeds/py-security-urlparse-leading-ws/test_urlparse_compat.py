"""CVE-2023-24329 修复验收测试：前导空白不再导致 scheme 解析为空。"""
from urlparse_compat import parse


def test_normal_urls():
    assert parse('https://example.com/a') == ('https', 'example.com', '/a')
    assert parse('http://a.b:8080/x') == ('http', 'a.b:8080', '/x')
    assert parse('ftp://files/x') == ('ftp', 'files', '/x')


def test_control_chars_stripped():
    # \t\r\n 在旧版即会被剥离，保持该行为
    assert parse('ht\ttps://example.com') == ('https', 'example.com', '')
    assert parse('\nhttps://example.com') == ('https', 'example.com', '')


def test_leading_space_bypass_fixed():
    # CVE-2023-24329：前导空格导致 scheme 解析为空 → SSRF 白名单绕过
    scheme, netloc, path = parse(' https://example.com')
    assert scheme == 'https', '修复前 scheme=%r（空）→ 绕过 scheme 白名单校验' % (scheme,)
    assert netloc == 'example.com'
    assert path == ''


def test_leading_mixed_ws_fixed():
    scheme, _, _ = parse('  \t https://example.com')
    assert scheme == 'https'
