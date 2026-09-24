"""WWW-Authenticate 头解析（等效复刻 CVE-2020-8492 / bpo-39503 修复前的真实正则）。

溯源：CVE-2020-8492 —— CPython urllib.request.AbstractBasicAuthHandler 的
rx 正则对形如 'x,'*N（大量逗号、无 realm 尾巴）的恶意头产生灾难性回溯，
单请求即可挂死线程。下方正则即修复前的真实形态。
"""
import re

rx = re.compile('(?:.*,)*[ \t]*([^ \t]+)[ \t]+realm="([^"]*)"', re.I)


def parse_www_authenticate(header):
    """解析 'Basic realm="x"' → {'scheme': 'Basic', 'realm': 'x'}；无法解析返回 None。"""
    m = rx.match(header)
    if not m:
        return None
    return {'scheme': m.group(1), 'realm': m.group(2)}
