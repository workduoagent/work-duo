"""legacy_extract.py（坏种子：真实 CVE 复刻）

复刻 CVE-2007-4559 的缺陷模式：tar 成员路径未做穿越校验。
攻击向量：恶意 tar 内含 `../../../../etc/evil` 等成员路径，
extractall/extract 时把文件写到目标目录之外（任意文件写入）。
Python 3.12 的官方修复是给 tarfile.extractall 加 filter='data'
（拒绝绝对路径/父目录穿越/设备文件），本包要求实现等效防护。
"""
import os
import tarfile


def legacy_extract(tar_path: str, dest_dir: str) -> list:
    """解包 tar 到 dest_dir，返回解出的成员相对路径列表。

    缺陷：直接信任 tar 成员的路径，未校验解析后的绝对路径是否仍在
    dest_dir 内——恶意成员 `../evil.txt` 或绝对路径成员即可逃逸。
    （与 2007~2023 年间 CPython tarfile.extractall 的行为一致）
    """
    extracted = []
    with tarfile.open(tar_path, "r:*") as tf:
        for member in tf.getmembers():
            target = os.path.join(dest_dir, member.name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tf.extractfile(member) as src, open(target, "wb") as dst:
                dst.write(src.read())
            extracted.append(member.name)
    return extracted
