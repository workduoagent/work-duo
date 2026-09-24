"""CVE-2020-8492 修复验收测试：恶意头不再触发灾难性回溯，合法解析不变。"""
import os
import subprocess
import sys
import time

import pytest

from auth_compat import parse_www_authenticate


def test_normal_parse():
    r = parse_www_authenticate('Basic realm="Example"')
    assert r == {'scheme': 'Basic', 'realm': 'Example'}


def test_case_insensitive_and_spaces():
    r = parse_www_authenticate('bAsIc   realm="x"')
    assert r['scheme'] == 'bAsIc'
    assert r['realm'] == 'x'


def test_no_realm_returns_none():
    assert parse_www_authenticate('hello world') is None
    assert parse_www_authenticate('') is None


def test_no_catastrophic_backtracking():
    # CVE-2020-8492：恶意头触发指数回溯。判分方式：子进程 10s 超时即红。
    # 恶意输入经 stdin 传入（Windows 命令行 32K 限制，不能内联进 -c 参数）。
    evil = 'x,' * 20000
    here = os.path.dirname(os.path.abspath(__file__))
    code = (
        'import sys\n'
        'sys.path.insert(0, %r)\n'
        'from auth_compat import parse_www_authenticate\n'
        'parse_www_authenticate(sys.stdin.read())\n'
        "print('done')\n" % (here,)
    )
    t0 = time.perf_counter()
    try:
        p = subprocess.run(
            [sys.executable, '-c', code],
            input=evil,
            capture_output=True,
            timeout=10,
            text=True,
        )
    except subprocess.TimeoutExpired:
        pytest.fail('CVE-2020-8492 未修复：恶意头仍触发灾难性回溯（子进程 10s 超时被杀）')
    elapsed = time.perf_counter() - t0
    assert elapsed < 10
    assert p.returncode == 0, '修复后恶意头应正常解析或返回 None，不允许异常：%s' % (p.stderr[-200:],)
