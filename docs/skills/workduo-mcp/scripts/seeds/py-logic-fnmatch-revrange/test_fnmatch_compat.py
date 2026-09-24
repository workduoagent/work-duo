"""回归测试：gh-89973 修复判分（真实缺陷的修复后语义）。

修复语义：模式含「上界<下界」的字符范围（如 [c-a]）时——
- 绝不抛 re.error；
- [c-a] 解释为空集（不匹配任何字符）；
- [!c-a] = 非空集 = 匹配任意字符；
- 正常模式行为不变（正向用例）。
"""
import re

import pytest

from fnmatch_compat import match


def test_normal_globs_unchanged():
    assert match("hello.py", "*.py")
    assert match("a/b/c.txt", "a/*/*.txt")
    assert match("abc", "a?c")
    assert not match("abd", "a?c")
    assert match("b", "[abc]")
    assert not match("d", "[abc]")
    assert match("d", "[!abc]")


def test_reversed_range_does_not_raise():
    # 旧实现：re.error: bad character range c-a at position N
    try:
        r = match("a", "[c-a]")
    except re.error:
        pytest.fail("gh-89973 未修复：[c-a] 仍抛 re.error")
    assert r is False  # 空集：不匹配任何字符


def test_reversed_range_negation_matches_anything():
    import re
    try:
        r = match("a", "[!c-a]")
        r2 = match("zzz", "[!c-a]")
    except re.error:
        pytest.fail("gh-89973 未修复：[!c-a] 仍抛 re.error")
    assert r is True  # 非(c-a 空集) = 任意字符
    assert r2 is True


def test_literal_bracket_still_works():
    # 未闭合的 [ 按字面量处理（正典行为）
    assert match("a[", "a[")
    assert not match("ab", "a[")
