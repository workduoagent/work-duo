"""fnmatch_compat.py（坏种子：真实缺陷复刻 gh-89973）

简化版 fnmatch（支持 * ? [seq] [!seq]）。
缺陷：字符类 [seq] 直接原样拼进正则——当 seq 含「上界小于下界」的范围
（如 [c-a]）时，re 编译抛 re.error: bad character range。
2022-06 的 CPython 修复（gh-89973）：这类范围解释为空集，不再抛错。
"""
import re


def _translate(pattern: str) -> str:
    i, n = 0, len(pattern)
    res = []
    while i < n:
        c = pattern[i]
        i += 1
        if c == "*":
            res.append(".*")
        elif c == "?":
            res.append(".")
        elif c == "[":
            j = i
            if j < n and pattern[j] == "!":
                j += 1
            if j < n and pattern[j] == "]":
                j += 1
            while j < n and pattern[j] != "]":
                j += 1
            if j >= n:
                res.append("\\[")
            else:
                stuff = pattern[i:j].replace("\\", "\\\\")
                i = j + 1
                if stuff[0] == "!":
                    # glob 否定语义 [!seq] → 正则 [^seq]
                    stuff = "^" + stuff[1:]
                # 缺陷：未处理反转/非法范围——[c-a] 原样进正则，re.compile 抛
                # re.error: bad character range。gh-89973 修复：上界<下界的范围
                # 解释为空集（该类不匹配任何字符）。
                res.append("[%s]" % stuff)
        else:
            res.append(re.escape(c))
    return "(?s:%s)\\Z" % "".join(res)


def match(name: str, pattern: str) -> bool:
    """按 glob 语义判断 name 是否匹配 pattern。含 [c-a] 类模式时应不抛错。"""
    return re.match(_translate(pattern), name) is not None
