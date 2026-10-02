from stats import mean, median, p95


def test_mean():
    assert mean([1, 2, 3, 4]) == 2.5


def test_median_odd():
    assert median([3, 1, 2]) == 2


def test_median_even():
    assert median([4, 1, 3, 2]) == 2.5


def test_p95():
    xs = list(range(1, 101))
    assert p95(xs) == 95
