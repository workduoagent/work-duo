"""极简 HTTP 请求行构造器（模块 B）。

缺陷（CVE-2019-9740 同型）：未拒绝 URL 中的 CR/LF，攻击者可在请求行
注入额外头甚至额外请求（proxy 场景经典 SSRF/缓存投毒链）。
"""
from validate import is_allowed_url


def build_request(method, url, host):
    """构造 HTTP/1.1 请求行 + Host 头；仅允许白名单 scheme。"""
    if not is_allowed_url(url):
        raise ValueError('URL 未通过白名单校验: %r' % (url,))
    return '%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' % (method, url, host)
