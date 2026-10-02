"""应用配置（坏种子：DEFAULTS 字典缺逗号 → import 即炸）"""
DEFAULTS = {
    "host": "127.0.0.1"
    "port": 8080,
    "debug": False,
}


def get(key):
    return DEFAULTS.get(key)
