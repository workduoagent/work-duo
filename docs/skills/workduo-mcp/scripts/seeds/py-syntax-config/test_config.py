import config


def test_defaults():
    assert config.get("host") == "127.0.0.1"
    assert config.get("port") == 8080


def test_get_missing():
    assert config.get("nope") is None
