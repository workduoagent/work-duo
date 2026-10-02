from calculator import add, subtract, divide


def test_add():
    assert add(2, 3) == 6


def test_subtract():
    assert subtract(5, 2) == 3


def test_divide():
    assert divide(10, 2) == 5
