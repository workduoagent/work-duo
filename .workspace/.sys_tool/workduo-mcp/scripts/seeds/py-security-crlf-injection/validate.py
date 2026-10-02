"""URL 白名单校验（模块 A）。"""

ALLOWED_SCHEMES = ('http', 'https')


def is_allowed_url(url):
    """白名单校验：仅允许 http/https 绝对 URL；origin-form（/ 开头相对路径）放行。"""
    if url.startswith('/'):
        return True
    if ':' not in url:
        return False
    scheme = url.split(':', 1)[0].lower()
    return scheme in ALLOWED_SCHEMES
