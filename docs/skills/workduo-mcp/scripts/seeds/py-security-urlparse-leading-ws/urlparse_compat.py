"""URL scheme/netloc 解析（等效复刻 CVE-2023-24329 修复前的 urlparse 关键行为）。

溯源：CVE-2023-24329 —— CPython 3.11.4 前的 urllib.parse.urlparse 对以空白
（空格等）开头的 URL 不剥离前导空白，scheme 解析为空串，攻击者可借此绕过
仅校验 scheme 的 SSRF 防护。本文件为「真实 bug 模式复刻」，非原仓库文件。
"""
import re

_SCHEME_RE = re.compile(r'[a-zA-Z][a-zA-Z0-9+.\-]*:')


def parse(url):
    """解析 URL，返回 (scheme, netloc, path)。

    旧版行为：仅剥离 \\t\\r\\n（unsafe characters），不剥离空格等其余空白。
    """
    if not isinstance(url, str):
        raise TypeError('parse() argument must be str')
    for ch in ('\t', '\r', '\n'):
        url = url.replace(ch, '')
    m = _SCHEME_RE.match(url)
    if m:
        scheme = m.group(0)[:-1].lower()
        rest = url[m.end():]
        if rest.startswith('//'):
            i = rest.find('/', 2)
            if i < 0:
                netloc, path = rest[2:], ''
            else:
                netloc, path = rest[2:i], rest[i:]
        else:
            netloc, path = '', rest
        return scheme, netloc, path
    return '', '', url
