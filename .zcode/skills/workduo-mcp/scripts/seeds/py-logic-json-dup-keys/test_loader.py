"""判分测试：JSON 重复键检测（初始 3 红 2 绿=缺陷在位；修复后全绿）。禁止修改本文件。"""
from loader import load_config, find_duplicate_keys, has_duplicate_keys


def test_top_level_dup_detected():
    assert find_duplicate_keys('{"a": 1, "b": 2, "a": 3}') == ["a"]


def test_nested_dup_detected():
    # 嵌套对象里的重复键也要检出
    assert find_duplicate_keys('{"db": {"host": "x", "port": 1, "host": "y"}}') == ["host"]


def test_dedup_and_order():
    # 同一键重复 3 次只报一次；多个重复键按首次出现保序
    assert find_duplicate_keys('{"z": 1, "z": 2, "a": 1, "a": 2, "z": 3}') == ["z", "a"]


def test_no_dup_returns_empty():
    assert find_duplicate_keys('{"a": 1, "b": {"c": 2}}') == []


def test_load_config_standard_semantics():
    cfg = load_config('{"port": 5432, "retries": 3}')
    assert cfg == {"port": 5432, "retries": 3}


def test_has_duplicate_keys():
    assert has_duplicate_keys('{"a":1,"a":2}') is True
    assert has_duplicate_keys('{"a":1,"b":2}') is False
