"""抽帧 / 播放共用的代理片与解码小工具（20261022）。

**为什么需要代理片**：本插件的成片可以是 3072×1728（530 万像素）。软解这种规格
约 13ms/帧，抽一次全片胶片条 2.4 秒、浏览器里播一条也要把 CPU 顶上去。转成
512px 的小副本后像素量只剩 **1/36**，抽同样的帧只要 125ms、单帧 26ms，而代理片
全片才 ~395KB。

**用在哪些地方**：胶片条（sprite）、段块缩略图（thumb）、单帧预览（preview）、
监视器播放（video）。**母片只在"要落盘 / 要出成品"时才解**，预览可以省，成品不能糊。

**历史**：低清代理曾在 20261010 被删（当时成片多是 1080p，浏览器直接播就够）。
现在按**分辨率阈值**自动恢复：窄片照旧直播母片，宽片才转代理 —— 不做一刀切。
"""

import hashlib
import os
import subprocess
import tempfile

try:
    import folder_paths
except Exception:                                    # pragma: no cover
    folder_paths = None

PROXY_W    = 512      # 代理片宽度
PROXY_NABI = 1600     # 母片宽超过它才值得转代理（以下是 1080p 级，直解就够便宜）


def cache_dir(sub: str) -> str | None:
    """<temp>/<sub> —— temp 不随 ComfyUI 重启清空，故重启后缓存仍命中。

    建不了就返回 None：调用方一律要能退回"不缓存"的纯内存路径。
    """
    try:
        if folder_paths is None:
            return None
        d = os.path.join(folder_paths.get_temp_directory(), sub)
        os.makedirs(d, exist_ok=True)
        return d
    except Exception:
        return None


def sig(path: str) -> tuple:
    """文件身份 = 修改时间 + 大小。

    成片会被反复覆盖（重抽 / 取最新成片），只按路径做 key 会命中旧画面。
    """
    try:
        st = os.stat(path)
        return (int(st.st_mtime), int(st.st_size))
    except Exception:
        return (0, 0)


def disk_path(d: str | None, key) -> str | None:
    """缓存目录下的文件名，由 key 哈希而来。"""
    if not d:
        return None
    try:
        h = hashlib.md5(repr(tuple(key)).encode("utf-8")).hexdigest()
        return os.path.join(d, h + ".jpg")
    except Exception:
        return None


def write_disk(dst: str, body: bytes) -> None:
    """原子写：先写同目录 .tmp 再 os.replace，避免半幅图被并发请求读到。"""
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dst), suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        os.replace(tmp, dst)
    except Exception:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def find_ffmpeg() -> str | None:
    try:
        from ..banzhang_ffmpeg import find_ffmpeg as _find
        return _find()
    except Exception:
        return None


def proxy_path(path: str, width: int = PROXY_W) -> str | None:
    d = cache_dir("h3_proxy")
    if not d:
        return None
    mt, sz = sig(path)
    base = os.path.splitext(os.path.basename(path))[0]
    # mtime/size 进文件名：片源一被覆盖就自动另起一份，不会命中旧代理
    return os.path.join(d, "%s.%d.%d.p%d.mp4" % (base, mt, sz, width))


def ensure_proxy(path: str, width: int = PROXY_W) -> str | None:
    """没有代理片就用 ffmpeg 生成一份；失败一律返回 None。

    代理片是**加速手段**，不能变成"没有它就抽不了帧" —— 调用方拿到 None 要
    能退回母片。
    """
    out = proxy_path(path, width)
    if not out:
        return None
    if os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    ff = find_ffmpeg()
    if not ff:
        return None
    tmp = out + ".tmp.mp4"
    try:
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
               "-vf", "scale=%d:-2" % width, "-c:v", "libx264", "-crf", "30",
               "-preset", "veryfast", "-an", tmp]
        subprocess.run(cmd, timeout=180, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            os.replace(tmp, out)
            return out
    except Exception:
        pass
    try:
        if os.path.isfile(tmp):
            os.unlink(tmp)
    except Exception:
        pass
    return None


def source_for(path: str, width: int = PROXY_W, need_full: bool = False,
               probe_w: int | None = None) -> str:
    """抽帧该解哪个文件。

    need_full —— 要落盘/出成品的那一帧必须解母片。
    probe_w   —— 母片宽度（已知就传）。窄片（≤PROXY_NABI）直解母片更划算：
                 转代理本身要 1.5 秒，1080p 直解并不比代理慢多少，没必要多一层。
    """
    if need_full:
        return path
    if probe_w is not None and 0 < probe_w <= PROXY_NABI:
        return path
    return ensure_proxy(path, width) or path


def seek_to(c, s, seconds: float) -> None:
    """seek 到 seconds（落在目标之前的关键帧上）。

    ⚠ PyAV 18 的 Container.seek **只收 int**，单位是 stream.time_base。传 float
    秒会抛 TypeError —— 老写法被 except 吞掉后回退 c.seek(0)，于是每次都从
    第 0 帧解到目标帧（实测取第 357 帧要解 358 帧 / 618ms；正确写法只解
    112 帧 / 252ms）。
    """
    try:
        tb = float(s.time_base)
        if tb > 0:
            c.seek(int(max(0.0, seconds) / tb), stream=s, backward=True)
            return
    except Exception:
        pass
    try:
        c.seek(0)
    except Exception:
        pass


def scaled(frame, width: int):
    """解码管线内缩到 width 再转 PIL —— 不要在 Python 里接全尺寸 RGB。

    3072×1728 的 to_image() 是 15.9MB/帧、45~96ms；先 reformat 再转只要 5ms、
    几 KB。抽 9 帧的实测差：210ms → 86ms，内存峰值 525MB → <50MB。
    """
    h = max(1, int(round(width * frame.height / max(1, frame.width))))
    return frame.reformat(width=width, height=h, format="rgb24").to_image()
