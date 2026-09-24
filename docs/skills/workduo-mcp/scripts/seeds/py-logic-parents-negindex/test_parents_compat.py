"""回归测试：gh-93156 修复判分（真实缺陷的修复后语义）。

修复语义（以 pathlib.PurePath.parents 为基准）：
- parents_of('/a/b/c') == ['/a/b', '/a', '/']（绝对路径以根结尾）
- parents_of('a/b/c') == ['a/b', 'a', '.']（相对路径剥到当前目录级）
- 负索引 -1 恒为最顶层祖先（绝对路径时为根）；-2 为次末；不得错位。
"""
import pytest

from parents_compat import parent_at, parents_of


def test_parents_abs_positive():
    assert parents_of("/a/b/c") == ["/a/b", "/a", "/"]


def test_parents_rel_positive():
    assert parents_of("a/b/c") == ["a/b", "a", "."]


def test_abs_negative_index_fixed():
    # gh-93156：绝对路径负索引错位——修复后必须正确
    assert parent_at("/a/b/c", -1) == "/"
    assert parent_at("/a/b/c", -2) == "/a"
    assert parent_at("/a/b/c", -3) == "/a/b"


def test_rel_negative_index_fixed():
    assert parent_at("a/b/c", -1) == "."
    assert parent_at("a/b/c", -2) == "a"
    assert parent_at("a/b/c", -3) == "a/b"


def test_positive_index_unchanged():
    assert parent_at("/a/b/c", 0) == "/a/b"
    assert parent_at("/a/b/c", 2) == "/"


def test_single_component():
    assert parents_of("/x") == ["/"]
    assert parent_at("/x", -1) == "/"
