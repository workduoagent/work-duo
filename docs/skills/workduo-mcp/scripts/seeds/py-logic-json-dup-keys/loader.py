"""配置加载器——缺陷：重复键检测基于已合并的 dict，永远检测不到重复。"""
import json


def load_config(text: str) -> dict:
    """标准解析（后值覆盖语义，保持 json 标准行为）。"""
    return json.loads(text)


def find_duplicate_keys(text: str) -> list[str]:
    """返回文本中各层对象里重复出现的键名（去重、按首次出现保序）。

    缺陷：json.loads 已把重复键合并成一个，从结果 dict 的 keys 里找重复
    自然永远返回空——检测必须发生在解析过程中（object_pairs_hook）。
    """
    keys = list(json.loads(text).keys())
    return [k for i, k in enumerate(keys) if k in keys[:i]]


def has_duplicate_keys(text: str) -> bool:
    return bool(find_duplicate_keys(text))
