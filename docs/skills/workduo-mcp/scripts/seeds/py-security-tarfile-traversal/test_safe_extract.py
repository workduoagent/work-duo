"""回归测试：CVE-2007-4559 修复判分（真实 CVE 的修复后语义）。

判分标准 = Python 3.12 filter='data' 的语义：
- 恶意成员（../ 穿越后逃逸出 dest_dir / 绝对路径）必须被拒绝（跳过或抛错），
  且**磁盘上不得出现逃逸文件**；
- 合法 tar 仍能正常解包（正向用例）。
"""
import io
import os
import tarfile

from legacy_extract import legacy_extract


def make_tar(files: dict) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


MALICIOUS = make_tar({
    "ok.txt": b"fine",
    "../escaped.txt": b"ESCAPED",
    "../../deep/escape2.txt": b"ESCAPED2",
})
BENIGN = make_tar({
    "sub/a.txt": b"alpha",
    "b.txt": b"beta",
})


def test_benign_tar_extracts(tmp_path):
    p = tmp_path / "benign.tar"
    p.write_bytes(BENIGN)
    names = legacy_extract(str(p), str(tmp_path / "dest"))
    assert set(names) == {"sub/a.txt", "b.txt"}
    assert (tmp_path / "dest" / "sub" / "a.txt").read_bytes() == b"alpha"
    assert (tmp_path / "dest" / "b.txt").read_bytes() == b"beta"


def test_malicious_tar_cannot_escape(tmp_path):
    p = tmp_path / "evil.tar"
    p.write_bytes(MALICIOUS)
    dest = tmp_path / "dest"
    # 修复语义：拒绝逃逸成员（跳过或抛错均可接受），但磁盘上不得出现逃逸文件。
    try:
        legacy_extract(str(p), str(dest))
    except Exception:
        pass  # 拒绝式修复允许抛 tarfile.FilterError/ValueError 等
    assert not (tmp_path / "escaped.txt").exists(), \
        "恶意成员逃逸到了目标目录之外（CVE-2007-4559 未修复）"
    assert not (tmp_path / "escape2.txt").exists(), \
        "恶意成员逃逸到了目标目录之外"
    # 合法成员仍应解出（拒绝恶意、不误伤全部）
    assert (dest / "ok.txt").read_bytes() == b"fine"
