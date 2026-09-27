"""parents_compat.py（坏种子：真实缺陷复刻 gh-93156）

路径祖先序列：parents_of('/a/b/c') 应返回 ['/a/b', '/a', '/']（纯逻辑版，
不依赖 pathlib 内部）。语义基准 = pathlib.PurePath.parents：
- 正索引 0 = 紧邻父级；末位 = 最顶层祖先（绝对路径为根 '/'，相对路径剥到最頂）
- 负索引 -1 = 末位（最顶层祖先），-2 = 次末……
缺陷（gh-93156 同型）：负索引计算用 `len - 1 + idx` 的错位公式，绝对路径时
尾部是根 '/'，负索引取到的元素错位（[-1] 返回 '/a' 而非 '/'）。
"""


def parents_of(path: str) -> list:
    """返回 path 的全部祖先（从紧邻父级到最顶层）。"""
    p = path.rstrip("/")
    parts = [x for x in p.split("/") if x]
    is_abs = path.startswith("/")
    out = []
    for i in range(len(parts) - 1, 0, -1):
        prefix = "/" + "/".join(parts[:i]) if is_abs else "/".join(parts[:i])
        out.append(prefix if is_abs else (prefix or "."))
    if is_abs:
        out.append("/")
    else:
        out.append(".")
    return out


def parent_at(path: str, idx: int) -> str:
    """按索引取祖先：支持负索引。缺陷：负索引公式错位（gh-93156 同型）。"""
    seq = parents_of(path)
    n = len(seq)
    # 缺陷公式：对绝对路径，错把根当作序列外元素处理，负索引整体偏移一位
    if idx < 0:
        return seq[n + idx - 1] if n + idx - 1 >= 0 else seq[0]
    return seq[idx] if idx < n else seq[-1]
