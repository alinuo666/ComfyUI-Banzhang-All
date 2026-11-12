# -*- coding: utf-8 -*-
"""Read-only routes behind Glide Join's trim panel.

The seam is set by numbers — 重叠帧数 and 帧率 — with nothing on screen to look
at, so the cut is made blind: you cannot see which frames the overlap is about
to drop, or whether the sound lines up where the picture will be cut. These
routes let the panel draw the clip being trimmed.

Only the SOURCE clip can be drawn. The continuation is a tensor the graph has
not produced yet, so until the run finishes there is nothing on disk for it.

    GET /cglide/join/info?video=...           fps, frame count, size, duration
    GET /cglide/join/thumb?video=&frame=N     one frame, as JPEG
    GET /cglide/join/waveform?video=&bins=N   peak envelope, as JSON
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import time

import numpy as np
from aiohttp import web
from PIL import Image

import folder_paths
from server import PromptServer

try:
    import av
except Exception:      # pragma: no cover - PyAV ships with ComfyUI
    av = None

try:
    from . import csglide_join as _join_mod
except Exception:      # pragma: no cover - Join 不可用时面板没有数据源
    _join_mod = None

# 抽帧/播放共用的代理片与解码工具（与 ⏱ 参照图替换同一份）
from .core.csglide_proxy import (                          # noqa: E402
    cache_dir as _cache_dir,
    disk_path as _disk_path,
    write_disk as _write_disk,
    source_for,
    ensure_proxy,
    scaled as _scaled,
    PROXY_NABI,
)


PREFIX        = "/cglide/join"
THUMB_WIDTH   = 192      # px wide; single-frame thumbs (旧的逐张抽帧仍保留）
STEP_LIMIT    = 250      # frames decoded after a seek before giving up
CACHE_MAX     = 400
# 雪碧图：段块画面一次解码抽几张拼一张横向长图（20261010，见 sprite_jpeg）
SPRITE_COLS     = 6       # 每段抽几张拼一图；铺满段块已够读
# 20261024 晚「胶条化」：10 → 24。前端格宽改成「块高 × 16/9」（约 92px/格）后，
# 600px 的段要 7 格、900px 要 10 格 —— 封顶 10 会让长段每格被拉宽变形。
# 前端按拼图 naturalWidth 等比贴图，列数在这里只是清晰度旋钮，不是几何枷锁。
SPRITE_MAX_COLS = 24
SPRITE_GAP      = 1       # 格间缝（px）：拼进图里的井底色细缝，胶条感 + 帧边界可数
# 预热档源格宽（20261024 晚）：= 前端格宽默认值（块高 52 × 16/9 ≈ 92，DPR 1）。
# 原来预热按 THUMB_WIDTH=192 落盘，而前端按 DPR 算出来的 cw 从来不是 192 ——
# 预热写进去的键没人请求，白解码一遍。对齐后至少 cw 能命中（列数仍随段宽变，
# 只有落在 SPRITE_COLS=6 档的段能全中，见 warm_project_sprites 注释）。
SPRITE_WARM_CELL_W = 92

_info_cache:  dict = {}
_thumb_cache: dict = {}
_wave_cache:  dict = {}
_sprite_cache: dict = {}
_W_CACHE:     dict = {}     # path -> 母片宽（判断要不要转代理，只开一次容器）
_THUMB_DIR    = _cache_dir("h3_thumb_cache")   # 缩略图落盘目录（重启仍命中）
# 播放版成片（20261010av，方案③「服务端预裁」）：每段成片掐掉头部承接重叠帧
# 之后的"干净版" <name>.play.mp4。前端连播接段从它的 0 秒起播 —— **不需要任何
# seek**，跨段接缝因此没有跳变、没有闪帧（详见 _build_play_film 的注释）。
_play_cache: dict = {}
_play_jobs:  dict = {}     # key -> Future：同一部片的并发请求只生成一次
# 同时最多跑两个抽帧解码 —— 段一多时不让一堆解码线程把 CPU 抢光（吃配置的
# 根因之一）。其余排队，慢慢补上。
_sprite_sem = asyncio.Semaphore(2)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _resolve(video: str) -> str:
    """Absolute path for a full path, or a name relative to input/ or output/.

    The node receives a full path from H3 Studio, but the field is editable and
    a bare filename is the natural thing to type. Output counts too: the panel
    also draws the finished render, which lives in output/, not input/.
    """
    p = (video or "").strip().strip('"').strip("'")
    if not p:
        raise ValueError("no clip given")
    if os.path.isfile(p):
        return os.path.abspath(p)
    for root in (folder_paths.get_input_directory(),
                 folder_paths.get_output_directory()):
        cand = os.path.join(root, p)
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    p = folder_paths.get_annotated_filepath(p)
    if not os.path.isfile(p):
        raise FileNotFoundError("clip not found: %s" % p)
    return p


def _key(path: str, *extra) -> tuple:
    try:
        st = os.stat(path)
        return (path, st.st_mtime_ns, st.st_size) + extra
    except OSError:
        return (path, 0, 0) + extra


def _etag(key) -> str:
    """内容校验标签（20261101）。

    _key 里已经含源片 mtime_ns + size，所以 key 本身就是内容指纹：片源一覆盖
    写，key 变、标签变。之前这里只给 ``private, max-age=3600``，而前端请求
    URL 不带版本 —— 同一个文件名重抽后，浏览器一小时内不回来验证，时间轴/
    缩略图就一直显示旧画面。换成 no-cache + ETag：没变 304（不传图不解码），
    变了必然取新的。
    """
    return '"%s"' % hashlib.md5(repr(tuple(key)).encode("utf-8")).hexdigest()[:24]


def _not_modified(request, etag: str) -> bool:
    inm = (request.headers.get("If-None-Match") or "").replace("W/", "")
    return bool(inm) and etag in [t.strip() for t in inm.split(",")]


def _remember(cache: dict, key: tuple, value):
    if len(cache) >= CACHE_MAX:
        cache.clear()
    cache[key] = value
    return value


def _fps_of(stream) -> float:
    rate = getattr(stream, "average_rate", None)
    return float(rate) if rate else 24.0


# --------------------------------------------------------------------------
# play film —— 方案③「服务端预裁」（20261010av）
# --------------------------------------------------------------------------
# 接缝闪帧的根子：每段成片的**头部 trim 帧**是承接上一段尾帧的重绘，浏览器
# 必须先 seek 跳过它们才能从"本段新画面"播起 —— 而一切播放中的 seek 都有
# 可见的往返（换源、解码重启），遮是遮不完的（垫图/ARM 只是遮得好看些）。
# 与其在前端跟 seek 打 forever，不如在服务端把重叠帧**从文件里掐掉**：
# 播放版第 0 帧 = 本段新画面开头，连播接段从 0 秒直接播，前端不再需要任何
# 对位 seek。ARM 与 timeupdate 自愈保留，退化为手动拖动定位与兜底。
#
# 生成是**懒式**的：/info 带 trim 进来时才生成（首次 1~2s，之后缓存命中
# 秒回）；缓存键含源片 mtime/size —— 重抽覆盖写了同一路径，播放版自动失效
# 重建，不会出现"播的还是上一版"。

def _ffmpeg_exe():
    """统一走全插件共用的查找：PATH / ComfyUI 自带 / imageio / 本包 tools/ffmpeg。"""
    from .banzhang_ffmpeg import find_ffmpeg
    return find_ffmpeg()


def _play_dst(src: str) -> str:
    root, _ = os.path.splitext(src)
    return root + ".play.mp4"


def _play_sig(trim: int, take: int) -> str:
    # 末尾 cfr2：末帧时长（-r CFR）修复后强制重建，旧的末帧黑缓存不再命中。
    return "%d/%d/cfr2" % (int(trim), int(take))


def _play_is_fresh(src: str, dst: str, sig: str = "") -> bool:
    """播放版存在且不老于源片 → 有效（重抽会更新源片 mtime，旧的自动失效）。

    ``sig`` 是掐头/留存的帧数组合。同一个源片可能要掐出不同的一段（改了重叠
    帧数、拖过排序 → 本段在全片里的位置变了），只比 mtime 会拿回一条按旧参数
    切出来的片子 —— 所以参数写进旁边的小文件，对不上就重切。
    """
    try:
        if not (os.path.isfile(dst)
                and os.stat(dst).st_mtime_ns >= os.stat(src).st_mtime_ns):
            return False
    except OSError:
        return False
    if not sig:
        return True
    try:
        with open(dst + ".params", "r", encoding="utf-8") as fh:
            return fh.read().strip() == sig
    except OSError:
        return False


def _has_audio(path: str) -> bool:
    """这条片子有没有音轨（决定要不要给 ffmpeg 加 -af atrim）。"""
    if av is None:
        return False
    try:
        with av.open(path) as c:
            return bool(c.streams.audio)
    except Exception:
        return False


def _build_play_film(src: str, fps: float, trim: int, take: int = 0) -> str:
    """ffmpeg 掐出 ``[trim, trim+take)`` 这一段 → <name>.play.mp4
    （先写临时文件再原子改名，免得 ffprobe / <video> 读到半截）。
    失败抛异常，由调用方退回原片口径。

    ``take`` 是**要留下几帧**（0 = 掐完剩下多少算多少）。它不能省：第 1 段
    的成片常常比它的净长长一大截（接了外来源片、或本就是一条累积片），只掐头
    不限尾的话，播放版/成片里第一段就会多出一截不属于它的画面。

    用**重编码**而不是 -c copy：-c copy 掐头只能落在最近的关键帧上，精度
    受 GOP 摆布；这批片子每段才几百帧、576×320，veryfast 重编码 1~2 秒，
    换来逐帧精确（掐多少帧就是多少帧）。-ss 放 -i 之前 = 输入端精确定位
    （seek 到关键帧后解码丢弃到目标帧），音轨同步掐齐；输出时间戳从 0 起。
    """
    exe = _ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg not found")
    dst = _play_dst(src)
    if _play_is_fresh(src, dst, _play_sig(trim, take)):
        return dst
    tmp = "%s.%d.part" % (dst, os.getpid())
    ss = trim / (fps or 24.0)
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error",
           "-ss", "%.6f" % ss, "-i", src]
    if take and take > 0:
        # 用 **-frames:v** 而不是 -t：拼接出来的片子时长常有几毫秒的漂移（各段
        # 时间戳各舍入一次），-t 按秒截就会少给一帧（实测 68 帧只出 67 帧），
        # 一段少一帧、十几段就是十几帧的音画错位。-frames:v 数的是帧，精确。
        cmd += ["-frames:v", str(int(take))]
        # 音频得跟着一起截（不然它会一直录到源片结尾）。atrim 只作用于音频，
        # 不会像 -t 那样把视频也截短；源片没音轨时不能加（会报"匹配不到流"）。
        if _has_audio(src):
            cmd += ["-af", "atrim=0:%.6f,asetpts=N/SR/TB" % (take / (fps or 24.0))]
    # -r 强制输出恒定帧率：-frames:v 截断时末帧 PTS 可能正好顶到容器 duration、
    # 呈现时长被写成 0，Chromium 不呈现该帧、ended 时露出一帧黑（"每段最后一帧黑"）。
    # 声明 -r 让 muxer 按 CFR 给每帧（含末帧）1/fps 的时长，末帧正常停留。
    cmd += ["-r", "%.3f" % (fps or 24.0),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            # 临时文件后缀是 .part，ffmpeg 认不出容器 —— 显式点名 mp4
            "-f", "mp4", tmp]
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000       # CREATE_NO_WINDOW
    subprocess.run(cmd, check=True, timeout=120, **kwargs)
    with open(dst + ".params", "w", encoding="utf-8") as fh:
        fh.write(_play_sig(trim, take))
    os.replace(tmp, dst)
    return dst


def _count_frames(path: str) -> int:
    if av is None:
        return 0
    try:
        with av.open(path) as c:
            v = c.streams.video[0]
            n = int(getattr(v, "frames", 0) or 0)
            if not n and getattr(c, "duration", None):
                n = int(round(float(c.duration) / 1_000_000.0 * _fps_of(v)))
            return n
    except Exception:
        return 0


def _build_and_count(src: str, fps: float, trim: int, take: int = 0):
    dst = _build_play_film(src, fps, trim, take)
    return dst, _count_frames(dst)


def _ffprobe_exe():
    """ffprobe：先在与找到的 ffmpeg 同目录里找（本包自带的俩就在一起），
    再回落到统一查找。"""
    from .banzhang_ffmpeg import find_ffprobe
    exe = _ffmpeg_exe()
    if exe:
        cand = os.path.join(os.path.dirname(exe),
                            "ffprobe" + (".exe" if exe.lower().endswith(".exe") else ""))
        if os.path.isfile(cand):
            return cand
    return find_ffprobe()


def _stream_sig(probe: str, path: str):
    """一条片子的"能不能跟别人首尾相接"指纹。

    流复制拼接要求各片段的编码参数**完全一致**：视频编码器 / profile / level /
    像素格式 / 分辨率 / 帧率，音频编码器 / 采样率 / 声道数。差任何一项，
    `-c copy` 拼出来的片子要么直接报错，要么能播但时间戳错乱 —— 所以动手
    之前先比，比不过就老实退回重编码。
    """
    try:
        out = subprocess.run(
            [probe, "-v", "error", "-show_entries",
             "stream=codec_name,profile,level,pix_fmt,width,height,r_frame_rate,"
             "sample_rate,channels", "-of", "csv=p=0", path],
            capture_output=True, timeout=60)
        text = (out.stdout or b"").decode("utf-8", "replace").strip()
        return text if text else None
    except Exception:
        return None


def concat_play_films(jobs, out_path: str):
    """把各段的「本段净长」用 ffmpeg concat **流复制**拼成一条 —— 不重编码。

    jobs：``[(src, fps, trim), ...]``，trim = 本段新画面在 src 里的位置
    （掐头帧数，单段片是承接重叠、累积片是全片起点）。trim ≤ 0 的段先拿原片
    试，参数与播放版不一致时再补一份播放版。

    零重编码 = 拼接这一环**不引入任何新的画质损失**：各段内容就是它们被
    生成时的样子，只是首尾接起来。编码只发生在"生成播放版"那一次，而那一次
    是为了把掐头落点做到**逐帧精确**（流复制掐头只能落在关键帧上，受 GOP
    摆布，接缝会错开好几帧）。

    走不通（没 ffmpeg / 参数不一致 / 生成失败）一律返回 ok=False 并说清
    原因，由调用方退回重编码 —— 绝不硬拼一条看着不对的片子。
    """
    exe, probe = _ffmpeg_exe(), _ffprobe_exe()
    if not exe or not probe:
        return {"ok": False, "why": "no_ffmpeg"}

    parts, made = [], []
    for i, job in enumerate(jobs):
        src, fps, trim = job[0], float(job[1] or 24.0), int(job[2] or 0)
        take = int(job[3]) if len(job) > 3 else 0
        if trim > 0 or take > 0:
            # 掐头 / 限尾任一有要求就得切 —— 第 1 段常见「不用掐头但要限尾」
            # （成片比净长长，多出来那截不属于本段）。
            try:
                dst, _n = _build_and_count(src, fps, trim, take)
            except Exception as exc:
                return {"ok": False, "why": "play_failed", "detail": repr(exc)}
            parts.append(dst)
            made.append(i)
        else:
            parts.append(src)

    sigs = [_stream_sig(probe, p) for p in parts]
    base = next((sigs[i] for i in made), None)
    if base is None:
        return {"ok": False, "why": "nothing_to_trim"}
    for i, sig in enumerate(sigs):
        if sig == base:
            continue
        if i in made:
            return {"ok": False, "why": "param_mismatch"}
        # 这一段用的是原片（不掐不限），参数跟播放版对不上 —— 给它也补一份
        src, fps = jobs[i][0], float(jobs[i][1] or 24.0)
        try:
            dst, _n = _build_and_count(src, fps, 0, 0)
        except Exception as exc:
            return {"ok": False, "why": "play_failed", "detail": repr(exc)}
        sig2 = _stream_sig(probe, dst)
        if sig2 != base:
            return {"ok": False, "why": "param_mismatch"}
        parts[i] = dst
        sigs[i] = sig2

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    # 临时名必须本次独有：并发两次导出落到同一个 .part 上，两份 ffmpeg 同时
    # 往里写，先完成的把文件改名成成片、后一个的句柄跟过去把成片写坏。
    _fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out_path) or ".",
                                suffix=".part.mp4")
    os.close(_fd)
    lst = tmp + ".concat.txt"
    try:
        with open(lst, "w", encoding="utf-8") as fh:
            for p in parts:
                # 反斜杠在 concat 列表里是转义符：一律写成正斜杠
                fh.write("file '%s'\n" % p.replace("\\", "/").replace("'", "'\\''"))
        cmd = [exe, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", lst,
               "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp]
        kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
        subprocess.run(cmd, check=True, timeout=900, **kwargs)
        # 目标被播放器 / 缩略图 / 杀毒打开时 os.replace 会 WinError 32 ——
        # 那是"被占用"，不是"写坏了"，退避重试几次，别让整条导出白跑。
        for _i in range(4):
            try:
                os.replace(tmp, out_path)
                break
            except PermissionError:
                if _i == 3:
                    raise
                time.sleep(0.3 * (_i + 1))
    except Exception as exc:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return {"ok": False, "why": "concat_failed", "detail": repr(exc)}
    finally:
        try:
            os.remove(lst)
        except OSError:
            pass

    v_secs = a_secs = 0.0
    frames = _count_frames(out_path)
    try:
        with av.open(out_path) as c:
            v = c.streams.video[0]
            if v.duration and v.time_base:
                v_secs = float(v.duration * v.time_base)
            a = c.streams.audio[0] if c.streams.audio else None
            if a is not None and a.duration and a.time_base:
                a_secs = float(a.duration * a.time_base)
    except Exception:
        pass
    return {"ok": True, "path": out_path, "frames": frames,
            "video_seconds": v_secs, "audio_seconds": a_secs,
            "parts": list(parts)}


# 接缝平滑窗口（帧）。只作用在交界前后各 2 帧，与「下一帧」加权。
# 帧数不变：不用 xfade —— 它会吞掉过渡帧，破坏时间轴帧账。
SEAM_BLEND_FRAMES = 4
SEAM_BLEND_WEIGHT = 0.6


def concat_preview_fast(jobs, out_path: str, seam_frames: int = SEAM_BLEND_FRAMES):
    """整片预览 / 保存成片共用的拼接：一条 ffmpeg、filter_complex 逐段 trim +
    concat，全程只重编码一次（替代 N 段各跑一次 x264 + N 次 ffprobe/计数）。

    输入端 ``-ss <skip>`` 定位到本段新画面起点，filter 里 ``fps + trim`` 限到
    净长 take 帧、时间戳归零，再 concat —— 一次 libx264 输出，CFR 末帧正常。
    音频要求各段"全有 / 全无"（H3 同设置通常一致）；混合或任一步失败返回
    ok=False，由调用方回退 concat_play_films。``seam_frames`` = 每个交界做几帧
    局部时域平滑，0 关闭；预览与保存成片传同一个值，两条路才不会一个跳一个不跳。
    """
    exe = _ffmpeg_exe()
    if not exe:
        return {"ok": False, "why": "no_ffmpeg"}
    parsed = []
    for job in jobs:
        src = job[0]
        fps2 = float(job[1] or 24.0)
        skip = int(job[2] or 0)
        take = int(job[3]) if len(job) > 3 else 0
        parsed.append((src, fps2, skip, take))
    auds = [_has_audio(p[0]) for p in parsed]
    if any(auds) and not all(auds):
        return {"ok": False, "why": "mixed_audio"}
    use_audio = bool(any(auds))
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error"]
    fc = []
    for i, (src, fps2, skip, take) in enumerate(parsed):
        # 掐头**不**用 -ss：-ss 只认秒，而帧号换秒必然除不尽（22/24 =
        # 0.916666…），"%.6f" 一进位落点就偏一帧。5 段实测少 3 帧，监视器
        # 1855 / 成片 1858 —— 预览与成片从第一帧就错位。改按帧号裁。
        cmd += ["-i", src]
        fps2 = float(fps2 or 24.0)
        dur = (take / fps2) if take and take > 0 else 0.0
        if take and take > 0:
            fc.append("[%d:v]fps=%.3f,trim=start_frame=%d:end_frame=%d,"
                      "setpts=PTS-STARTPTS[v%d]" % (i, fps2, skip, skip + take, i))
        else:
            fc.append("[%d:v]fps=%.3f,trim=start_frame=%d,"
                      "setpts=PTS-STARTPTS[v%d]" % (i, fps2, skip, i))
        if use_audio:
            # 音轨仍按秒裁（样本级，进位影响不到 1 个采样）；去掉了 -ss，
            # 起点得自己在 atrim 里补上。
            a0 = skip / fps2
            if dur > 0:
                fc.append("[%d:a]atrim=start=%.6f:end=%.6f,asetpts=PTS-STARTPTS[a%d]"
                          % (i, a0, a0 + dur, i))
            else:
                fc.append("[%d:a]atrim=start=%.6f,asetpts=PTS-STARTPTS[a%d]"
                          % (i, a0, i))
    nseg = len(parsed)
    fc.append("%sconcat=n=%d:v=1:a=0[catv]"
              % ("".join("[v%d]" % i for i in range(nseg)), nseg))
    if use_audio:
        fc.append("%sconcat=n=%d:v=0:a=1[outa]"
                  % ("".join("[a%d]" % i for i in range(nseg)), nseg))
    # 接缝平滑：交界前后各 half 帧与「下一帧」按权重混合，把单帧突变摊到几帧里。
    # split + trim/tpad 得到一条错位一帧的同长流，blend 的 N 只在这些帧上生效；
    # 输出帧数与原片完全相同，段落档案一个字节都不动。
    juncs, cum = [], 0
    for _src, _fps, _skip, _take in parsed[:-1]:
        cum += int(_take or 0)
        juncs.append(cum)
    do_seam = (seam_frames > 0 and nseg > 1
               and all(int(p[3] or 0) > seam_frames for p in parsed))
    if do_seam:
        half = seam_frames // 2
        cond = "+".join("gte(N,%d)*lt(N,%d)" % (j - half, j + half)
                        for j in juncs)
        w = "%g*if(%s,1,0)" % (SEAM_BLEND_WEIGHT, cond)
        fc.append(
            "[catv]split[ov][nx];"
            "[nx]trim=start_frame=1,setpts=PTS-STARTPTS,"
            "tpad=stop_mode=clone:stop_duration=%.6f[sx];"
            "[ov]setpts=PTS-STARTPTS[oo];"
            "[oo][sx]blend=all_expr='A*(1-(%s))+B*(%s)'[outv]"
            % (1.0 / (parsed[0][1] or 24.0), w, w))
    else:
        fc.append("[catv]null[outv]")
    cmd += ["-filter_complex", ";".join(fc), "-map", "[outv]"]
    if use_audio:
        cmd += ["-map", "[outa]", "-c:a", "aac", "-b:a", "128k"]
    cmd += ["-r", "%.3f" % (parsed[0][1] or 24.0),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-f", "mp4", out_path]
    kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
    try:
        subprocess.run(cmd, check=True, timeout=300, **kwargs)
    except Exception as exc:
        return {"ok": False, "why": "fast_failed", "detail": repr(exc)}
    frames = _count_frames(out_path)
    v_secs = a_secs = 0.0
    try:
        with av.open(out_path) as c:
            v = c.streams.video[0]
            if v.duration and v.time_base:
                v_secs = float(v.duration * v.time_base)
            a = c.streams.audio[0] if c.streams.audio else None
            if a is not None and a.duration and a.time_base:
                a_secs = float(a.duration * a.time_base)
    except Exception:
        pass
    return {"ok": True, "path": out_path, "frames": frames,
            "video_seconds": v_secs, "audio_seconds": a_secs,
            "parts": [p[0] for p in parsed]}


async def ensure_play_film(src: str, fps: float, trim: int, own: int = 0,
                           take: int = 0) -> dict:
    """带缓存与并发去重的播放版入口。**从不抛** —— 失败退回原片口径，
    播放不能因为预裁失败而挂掉。

    ``trim`` 是**掐头帧数** = 本段新画面在这条成片里的位置（后端 _seg_cut
    算出来的 skip）。单段片它就是承接重叠的帧数；累积片它是本段在全片里的
    起点 clip_from —— 两种片子掐完之后**都是本段的净长**，播放版的第 0 帧
    一律等于"本段新画面的第一帧"。口径因此只有一套，不再分叉。

    ``own`` 只当安全绳：掐完之后至少要剩 1 帧。源片帧数由 av 现读（前端
    档案里的 film_frames 可能是陈旧的），读不到就照裁不误 —— 那一头还有
    _seg_cut 的帧数校验兜着。
    """
    if trim <= 0:
        return {"play_film": None, "frames": 0, "cumulative": False}
    if own:
        n_src = await _run(_count_frames, src)
        if n_src and trim >= n_src:
            # 掐头位置已经超出片子长度 —— 这条片子对不上（多半接了外来的
            # 源片 / 重抽后长度变了）。照裁会得到一个空壳，退回原片。
            print("[Banzhang] %s 掐头 %d 帧超出了片子长度 %d 帧 → 退回原片"
                  % (os.path.basename(src), trim, n_src))
            return {"play_film": None, "frames": 0, "cumulative": False}
    key = _key(src, "play", trim, take)
    hit = _play_cache.get(key)
    if hit is not None:
        return hit
    fut = _play_jobs.get(key)
    if fut is not None:
        try:
            return await fut
        except Exception:
            return {"play_film": None, "frames": 0, "cumulative": False}
    fut = asyncio.get_running_loop().create_future()
    _play_jobs[key] = fut
    try:
        try:
            dst, n = await _run(_build_and_count, src, fps, trim, take)
            out = _remember(_play_cache, key,
                            {"play_film": dst, "frames": n,
                             "cumulative": False})
            print("[Banzhang] 播放版就绪: %s（掐头 %d 帧、留 %d 帧 → %d 帧）"
                  % (os.path.basename(dst), trim, take, n))
        except Exception as exc:
            print("[Banzhang] 播放版生成失败，本次退回原片口径: %r" % (exc,))
            out = {"play_film": None, "frames": 0, "cumulative": False}
        if not fut.done():
            fut.set_result(out)
        return out
    finally:
        _play_jobs.pop(key, None)


# --------------------------------------------------------------------------
# clip info
# --------------------------------------------------------------------------

def clip_info(path: str) -> dict:
    if av is None:
        raise RuntimeError("PyAV is not installed")
    with av.open(path) as c:
        v = c.streams.video[0]
        fps = _fps_of(v)
        width = int(v.codec_context.width)
        height = int(v.codec_context.height)

        total = int(getattr(v, "frames", 0) or 0)
        duration = 0.0
        if getattr(c, "duration", None):
            # container.duration is in AV_TIME_BASE units — microseconds, an
            # FFmpeg constant rather than anything to read off av.time_base
            duration = float(c.duration) / 1_000_000.0
        if not total and duration and fps:
            total = int(round(duration * fps))
        if not duration and total and fps:
            duration = total / fps

        audio = c.streams.audio[0] if c.streams.audio else None

        return {
            "path": path,
            "mtime": os.stat(path).st_mtime_ns,
            "fps": fps,
            "total_frames": total,
            "width": width,
            "height": height,
            "duration": duration,
            "has_audio": audio is not None,
            "sample_rate": int(audio.rate) if audio is not None else 0,
        }


# --------------------------------------------------------------------------
# one frame
# --------------------------------------------------------------------------

def _width_of(path: str) -> int:
    """母片宽度（只开一次容器，带缓存）。用来判断"值不值得转代理"。"""
    key = _key(path)
    hit = _W_CACHE.get(key)
    if hit:
        return hit
    w = 0
    try:
        with av.open(path) as c:
            w = int(c.streams.video[0].width or 0)
    except Exception:
        w = 0
    _W_CACHE[key] = w
    return w


def frame_jpeg(path: str, frame: int, width: int = THUMB_WIDTH) -> bytes:
    """A single frame as JPEG bytes.

    Seeks to the keyframe at or before the target, then steps forward. Exact
    frame addressing is not possible without decoding from zero, and stepping
    from the previous keyframe is what the node itself will do at cut time, so
    the strip shows the frames the cut actually lands on.

    20261022：宽片（>PROXY_NABI）改解**代理片** —— 3072×1728 软解约 13ms/帧，
    512px 代理的像素量只有 1/36，段块缩略图一多就是几十次解码的差别。
    窄片直解母片（转代理本身要 1.5s，1080p 不划算）。
    """
    if av is None:
        raise RuntimeError("PyAV is not installed")

    target = max(0, int(frame))
    width = max(32, min(640, int(width)))
    src = source_for(path, probe_w=_width_of(path))

    with av.open(src) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        fps = _fps_of(v)
        tb = float(v.time_base)

        try:
            c.seek(int(target / fps / tb), stream=v, backward=True)
        except Exception:
            c.seek(0, stream=v, backward=True)

        # pts keeps the running frame number, so a seek that lands short of the
        # target is simply walked forward; a seek that overshoots returns the
        # frame it landed on rather than decoding from zero to catch up.
        idx, img = -1, None
        for n, f in enumerate(c.decode(video=0)):
            idx = int(round(float(f.pts * v.time_base) * fps)) if f.pts is not None else idx + 1
            img = _scaled(f, width)      # 解码管线里就缩好，不落地全尺寸 RGB
            if idx >= target or n >= STEP_LIMIT:
                break
        if img is None:
            raise RuntimeError("no frame decoded")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=72)
    return buf.getvalue()


# --------------------------------------------------------------------------
# sound
# --------------------------------------------------------------------------

# 按段缓存：一条成片一份包络，就存在那条成片旁边（<片名>/clip_0002.wave.json）。
#
# 为什么必须落盘而不只是放内存：第 k 段的成片是**前 k 段累积起来的**，所以每
# 生成一段，波形就要把整条片子重新解码一遍 —— 二十段下来是二十次全片解码，
# 段一多面板就卡住。内存缓存只能挡住"同一条片子的重复请求"，挡不住"片子变长
# 之后的那一次"；落盘之后，重开 ComfyUI 也还在。
#
# 分辨率固定存高一点，请求要多少就从高分辨率**降**到多少 —— 峰值降采样是
# 取"最大值里的最大值"，结果是精确的，所以一份缓存能喂所有调用方（面板 900、
# 监视器 800）。
WAVE_CACHE_BINS = 2000


def _wave_path(path: str) -> str:
    return os.path.splitext(path)[0] + ".wave.json"


def _read_json_file(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json_file(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _decode_peaks(path: str, bins: int):
    """解码整条音轨，返回 (包络 0..1, 时长秒, 采样率)。

    唯一真正解音频的地方 —— 别处一律读缓存。
    """
    if av is None:
        raise RuntimeError("PyAV is not installed")
    with av.open(path) as c:
        if not c.streams.audio:
            return [], 0.0, 0
        a = c.streams.audio[0]
        a.thread_type = "AUTO"
        rate = int(a.rate or 48000)
        chunks = []
        for f in c.decode(audio=0):
            arr = f.to_ndarray()
            if arr.ndim == 1:
                arr = arr[None, :]
            chunks.append(np.asarray(arr, dtype=np.float32))

    if not chunks:
        return [], 0.0, rate

    data = np.concatenate(chunks, axis=-1)
    if data.shape[0] > 1:
        data = data.mean(0)
    else:
        data = data[0]

    peak = float(np.abs(data).max())
    data = np.abs(data) if peak <= 1e-6 else np.abs(data) / peak

    n = data.shape[0]
    edges = np.linspace(0, n, bins + 1).astype(int)
    out = np.empty(bins, dtype=np.float32)
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        out[i] = float(data[lo:hi].max()) if hi > lo else 0.0
    return [round(float(x), 4) for x in out], n / float(rate), rate


def _pool_peaks(vals, bins: int):
    """把高分辨率包络降到 bins。峰值降采样是精确的：取窗口里的最大值。"""
    if bins >= len(vals):
        return list(vals)
    n = len(vals)
    edges = np.linspace(0, n, bins + 1).astype(int)
    out = []
    for i in range(bins):
        lo, hi = int(edges[i]), int(edges[i + 1])
        out.append(max(vals[lo:hi]) if hi > lo else 0.0)
    return out


def _wave_load(path: str):
    """读那段成片旁边那份包络。没有 / 片子被重新生成过 → None。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    d = _read_json_file(_wave_path(path), None)
    if not isinstance(d, dict):
        return None
    # mtime + size 一起验：同名覆盖写的新片子，只验 size 可能刚好一样
    if int(d.get("mtime", 0)) != st.st_mtime_ns or int(d.get("size", 0)) != st.st_size:
        return None
    vals = d.get("peaks")
    if not isinstance(vals, list) or not vals:
        return None
    return vals, float(d.get("duration") or 0.0), int(d.get("rate") or 0)


def _wave_save(path: str, vals, duration: float, rate: int):
    """只在输出目录里落盘 —— input/ 是用户的素材，不该被我们写缓存文件进去。"""
    try:
        out_root = os.path.abspath(folder_paths.get_output_directory())
    except Exception:
        return
    if not os.path.normcase(os.path.abspath(path)).startswith(
            os.path.normcase(out_root + os.sep)):
        return
    try:
        st = os.stat(path)
        _write_json_file(_wave_path(path), {
            "mtime": st.st_mtime_ns, "size": st.st_size, "bins": len(vals),
            "peaks": vals, "duration": duration, "rate": rate,
        })
    except Exception:
        pass      # 缓存写不进去不影响画波形，下次重算就是了


def waveform(path: str, bins: int = 900) -> dict:
    """Peak envelope of the whole track, as `bins` values in 0..1.

    Peaks rather than RMS because the panel is read for shape — an RMS envelope
    flattens exactly the transients that mark where a cut will sound wrong.
    """
    bins = max(32, min(4000, int(bins)))

    got = _wave_load(path)
    if got is None:
        # 分辨率按"要多少"和"缓存基准"里大的那个取：要得比基准还细时，这份
        # 缓存才值得以更细的粒度存下来。
        vals, dur, rate = _decode_peaks(path, max(bins, WAVE_CACHE_BINS))
        if vals:
            _wave_save(path, vals, dur, rate)
    else:
        vals, dur, rate = got

    return {"bins": _pool_peaks(vals, bins) if vals else [],
            "duration": dur, "sample_rate": rate}


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------

def sprite_jpeg(path: str, cols: int = SPRITE_COLS, cell_w: int = THUMB_WIDTH,
                f0: int | None = None, f1: int | None = None) -> tuple[bytes, int]:
    """把这一段的画面**一次顺序解码**、抽 cols 张拼成一张横向长图。

    20261010：原来段块每张缩略图都要一次「open + seek + 逐帧解码」——铺满
    一轴就是几十次请求、几十次解码，配置差直接跪。改成一次解码吐一张拼好的
    图，段块把它横向铺满即可（一条连续画面带），每段只剩 1 个请求、1 次
    解码。采样点均分（含首尾），顺序解码一遍就能全部拿到。

    f0/f1 —— **只采这一段自己的那一截**。成片可能是累积片（前 k 段拼起来的
    那一条 mp4），这时文件里有的是全片，而段块代表的只是其中一截；不传窗口
    就等于把整部片挤进一个块里看，第 1 段和第 5 段会长得一模一样。窗口按
    film_summary 的 clip_from / clip_to 给（那是这一段在全片里的位置）。
    窗口无效（缺失 / 反了 / 比一格还短）就退回整条，不当错误。

    20261024 晚：格与格之间留 SPRITE_GAP px 的井底色缝（拼图底色 13,13,13）。
    前端按拼图 naturalWidth 等比贴块，缝宽自动算进缩放里，不需要额外协议；
    末格后面不留缝。
    """
    if av is None:
        raise RuntimeError("PyAV is not installed")
    cols = max(1, min(SPRITE_MAX_COLS, int(cols or SPRITE_COLS)))
    cell_w = max(32, min(320, int(cell_w or THUMB_WIDTH)))

    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        fps = _fps_of(v)
        total = int(getattr(v, "frames", 0) or 0)
        if not total and getattr(c, "duration", None):
            total = int(round(float(c.duration) / 1_000_000.0 * fps))
        total = max(1, total)

        lo, hi = 0, total
        if f0 is not None and f1 is not None:
            a = max(0, min(total, int(f0)))
            b = max(0, min(total, int(f1)))
            if b - a >= 1:          # 窗口得至少有一帧，否则当作没给
                lo, hi = a, b
        span = max(1, hi - lo)
        cols = max(1, min(cols, span))
        # 采样点均分这一段自己的窗口（含首尾），再整体平移到文件里的真实位置
        off = [round(i * (span - 1) / max(1, cols - 1)) if cols > 1 else span // 2
               for i in range(cols)]
        want = [lo + o for o in off]

        tiles, cell_h, idx, nxt = [], 0, 0, 0
        for frame in c.decode(v):
            if idx >= want[nxt]:
                img = frame.to_image()
                h = max(1, round(img.height * cell_w / img.width))
                cell_h = max(cell_h, h)
                tiles.append(img.resize((cell_w, h), Image.BILINEAR))
                nxt += 1
                if nxt >= len(want):
                    break
            idx += 1

    if not tiles:
        raise RuntimeError("这一段没有可解码的画面")
    cell_h = max(1, cell_h)
    # 格间缝（20261024）：每格多占 SPRITE_GAP px，露出的就是拼图底色 —— 一条
    # 细缝把帧分开，胶条感、格数一眼可数。宽 = pitch*n - gap（末格后不留缝）。
    pitch = cell_w + SPRITE_GAP
    sheet = Image.new("RGB", (pitch * len(tiles) - SPRITE_GAP, cell_h), (13, 13, 13))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * pitch, 0))
    buf = io.BytesIO()
    sheet.save(buf, format="JPEG", quality=72, optimize=True)
    return buf.getvalue(), len(tiles)


async def _run(fn, *args):
    """Decode off the event loop; a long clip must not stall the UI."""
    return await asyncio.get_running_loop().run_in_executor(None, fn, *args)


# ---- T3：雪碧图落盘缓存（重启不重算，20261011）----
def _sprite_dir() -> str | None:
    """集中缓存目录 <temp>/h3_sprite_cache（不污染源片目录；temp 不随 ComfyUI
    重启清空，故重启后仍命中、零解码）。建不了就返回 None、退回纯内存路径。"""
    try:
        d = os.path.join(folder_paths.get_temp_directory(), "h3_sprite_cache")
        os.makedirs(d, exist_ok=True)
        return d
    except OSError:
        return None


def _sprite_disk_path(key: tuple) -> str | None:
    d = _sprite_dir()
    if not d:
        return None
    try:
        h = hashlib.md5(repr(tuple(key)).encode("utf-8")).hexdigest()
        return os.path.join(d, h + ".jpg")
    except Exception:
        return None


def _write_sprite_disk(disk_path: str, body: bytes) -> None:
    """原子写：先写同目录 .tmp 再 os.replace，避免半幅图被并发请求读到。"""
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(disk_path), suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        os.replace(tmp, disk_path)
    except Exception:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _sprite_headers(cols: int, etag: str = "") -> dict:
    h = {"X-Sprite-Cols": str(cols), "Cache-Control": "no-cache"}
    if etag:
        h["ETag"] = etag
    return h


def warm_segment_sprite(path, cols=SPRITE_COLS, cell_w=THUMB_WIDTH,
                        f0=None, f1=None):
    """T3：为一段生成默认档（cols/cell_w）雪碧图并落盘；落盘已存在则跳过。
    整片预热后在后台调用，让首次浏览时间轴直接命中默认档。返回是否新写。"""
    if not path:
        return False
    try:
        # sp4：20261024 晚起拼图带格间缝（SPRITE_GAP）—— 几何变了，sp3 的老
        # 缓存（无缝）不能命中，否则时间轴会一直显示旧式拼图。
        key = _key(path, "sp4", cols, cell_w, f0, f1)
    except Exception:
        return False
    disk = _sprite_disk_path(key)
    if disk and os.path.isfile(disk):
        return False
    try:
        body, _got = sprite_jpeg(path, cols, cell_w, f0, f1)
    except Exception:
        return False
    if disk:
        _write_sprite_disk(disk, body)
    return True


def warm_project_sprites(rows):
    """T3：按 film_summary 的 clip rows，为每段生成默认档雪碧图（落盘）。采样窗口
    口径与前端 spriteWin 完全一致（累积片只取 clip_from..clip_to；单段取
    trim_frames..frames）。逐段、失败静默；返回新写段数。"""
    made = 0
    for r in (rows or []):
        try:
            path = r.get("film")
            if not path or not r.get("playable"):
                continue
            own = max(1, int(r.get("frames") or 0))
            ff = int(r.get("film_frames") or 0)
            to = int(r.get("clip_to") or 0)
            frm = int(r.get("clip_from") or 0)
            cumulative = ff > own * 1.05 and to > 0 and ff >= to * 0.9
            if cumulative and to - frm >= 1:
                f0, f1 = frm, to
            else:
                trim = min(max(0, int(r.get("trim_frames") or 0)), own - 1)
                f0, f1 = trim, own
            if warm_segment_sprite(path, SPRITE_COLS, SPRITE_WARM_CELL_W, f0, f1):
                made += 1
        except Exception:
            continue
    return made


def _video_arg(request: web.Request) -> str:
    return str(request.query.get("video") or "")


@PromptServer.instance.routes.get(PREFIX + "/video")
async def _route_video(request: web.Request) -> web.Response:
    """Stream the clip itself so the panel can play and seek it live.

    FileResponse serves Range requests on its own, so scrubbing and frame
    stepping in the browser come for free — no decoding on the server side.

    play=1（20261010av）：要的是**播放版**（.play.mp4，头部承接重叠帧已被
    掐掉，见 _build_play_film）。它总是由 /info 先行生成；到这儿还没就绪
    （没走过带 trim 的 /info / 刚好在重建）就退回原片 —— 前端凭 info 里的
    play_film 有无来决定口径，这里只管给得出文件。
    """
    try:
        path = _resolve(_video_arg(request))
    except Exception as exc:
        return web.Response(status=404, text=str(exc))
    src_path = path
    if (request.query.get("play") or "") == "1":
        dst = _play_dst(path)
        if _play_is_fresh(path, dst):
            src_path = dst
    # proxy=1/auto：宽片给浏览器一份 512px 小副本。
    #
    # 低清代理曾在 20261010 被删（当时成片多是 1080p，浏览器直解够便宜）。现在
    # 成片可以是 3072×1728（530 万像素），浏览器软解这个规格是另一回事 —— 所以
    # 按**分辨率阈值**恢复：窄片照旧直播母片（零额外成本），宽片才转代理。
    # 代理片是等帧重编码，帧数与时长与母片一致，时间轴/进度不会错位。
    if (request.query.get("proxy") or "") in ("1", "auto"):
        if _width_of(src_path) > PROXY_NABI:
            px = ensure_proxy(src_path)
            if px and os.path.isfile(px):
                return web.FileResponse(px)
    return web.FileResponse(src_path)


# 代理片的实现在 core/csglide_proxy.py（与 ⏱ 参照图替换共用一套，不写两遍）。


@PromptServer.instance.routes.get(PREFIX + "/last_source")
async def _route_last_source(request: web.Request) -> web.Response:
    """The source clip the node actually used on its last run.

    源视频没有画布端口，执行侧读的是节点控件；但控件只反映面板里填过什么，
    H3 直接供值的场合（导演台一次供片）面板看不到。问执行侧最近一次真正
    用过的路径最可靠。
    """
    val = ""
    mtime = None
    if _join_mod is not None:
        val = str(getattr(_join_mod, "LAST_SOURCE", {}).get("value", ""))
        if val:
            # 带上 mtime：同名覆盖的成片 mtime 会变，自动接片靠它区分
            # 「同一条片」和「重新生成出来的同一路径」，不会漏接。
            try:
                mtime = os.stat(_join_mod._open_source(val)).st_mtime_ns
            except Exception:
                mtime = None
    return web.json_response({"source": val, "mtime": mtime})


@PromptServer.instance.routes.get(PREFIX + "/info")
async def _route_info(request: web.Request) -> web.Response:
    try:
        path = _resolve(_video_arg(request))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=404)
    try:
        trim = max(0, int(float(request.query.get("trim", 0) or 0)))
    except ValueError:
        trim = 0
    # own = 本段自己的规划帧数：后端拿它当安全绳 —— 掐头位置不能超出片子
    # 实际长度（见 ensure_play_film 里 own 的注释）。
    try:
        own = max(0, int(float(request.query.get("frames", 0) or 0)))
    except ValueError:
        own = 0
    # take = 本段要留下几帧（净长）。第 1 段的成片常常比它的净长长一大截，
    # 只掐头不限尾的话，播放版里会多出一截不属于本段的画面。
    try:
        take = max(0, int(float(request.query.get("take", 0) or 0)))
    except ValueError:
        take = 0
    # 缓存键带上 trim/take/frames：同一条片"掐多长、留多长"是不同的回答，本段
    # 帧数不同安全绳也不同；源片重抽后 mtime/size 变，键自然失效，播放版与
    # info 一起重建。
    key = _key(path, trim, take, own)
    hit = _info_cache.get(key)
    if hit is not None:
        return web.json_response(hit)
    try:
        info = await _run(clip_info, path)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
    if trim > 0:
        # 懒生成播放版（见 ensure_play_film）：首次 1~2s，之后缓存秒回。
        # 失败不挡 info —— play_film 缺席时前端自动按原片口径播。
        play = await ensure_play_film(path, float(info.get("fps") or 24.0),
                                      trim, own, take)
        info["play_film"] = play["play_film"]
        info["play_frames"] = play["frames"]
        info["cumulative"] = bool(play.get("cumulative"))
    return web.json_response(_remember(_info_cache, key, info))


@PromptServer.instance.routes.get(PREFIX + "/thumb")
async def _route_thumb(request: web.Request) -> web.Response:
    try:
        path = _resolve(_video_arg(request))
    except Exception as exc:
        return web.Response(status=404, text=str(exc))
    try:
        frame = int(request.query.get("frame", 0))
    except ValueError:
        return web.Response(status=400, text="frame must be an integer")
    try:
        width = int(request.query.get("w", THUMB_WIDTH))
    except ValueError:
        width = THUMB_WIDTH

    # th2：走代理片后口径变了（缩略图来自代理），换版本避免命中旧图
    key = _key(path, "th2", frame, width)
    etag = _etag(key)
    if _not_modified(request, etag):
        return web.Response(status=304, headers={"Cache-Control": "no-cache", "ETag": etag})
    hdr = {"Cache-Control": "no-cache", "ETag": etag}
    disk = _disk_path(_THUMB_DIR, key)
    hit = _thumb_cache.get(key)
    if hit is None and disk and os.path.isfile(disk):
        return web.FileResponse(disk, headers=hdr)
    if hit is None:
        # 与雪碧图共用同一个闸门：段块缩略图是一批一批来的，放任并发会抢光 CPU
        async with _sprite_sem:
            hit = _thumb_cache.get(key)
            if hit is None and disk and os.path.isfile(disk):
                return web.FileResponse(disk, headers=hdr)
            if hit is None:
                try:
                    hit = await _run(frame_jpeg, path, frame, width)
                except Exception as exc:
                    return web.Response(status=500, text=str(exc))
                _remember(_thumb_cache, key, hit)
                if disk:
                    _write_disk(disk, hit)
    return web.Response(body=hit, content_type="image/jpeg", headers=hdr)


@PromptServer.instance.routes.get(PREFIX + "/sprite")
async def _route_sprite(request: web.Request) -> web.Response:
    """段块画面：一张拼好的横向长图（雪碧图）。

    每段**只发一个请求、只解码一次** —— 段块把它横向铺满就是一条连续画面带。
    列数放在 X-Sprite-Cols 头里（前端按需计算格宽）。
    """
    try:
        path = _resolve(_video_arg(request))
    except Exception as exc:
        return web.Response(status=404, text=str(exc))
    try:
        cols = int(request.query.get("cols", SPRITE_COLS))
    except ValueError:
        cols = SPRITE_COLS
    # 与 sprite_jpeg 同一处 clamp：落盘命中走 FileResponse，头里的列数得是
    # **实际**生成时的列数，不然前端按请求值算几何会对不上。
    cols = max(1, min(SPRITE_MAX_COLS, cols))
    # cw：每格物理像素宽（前端按 DPR 给、决定清晰度），clamp 到安全区间
    try:
        cw = int(request.query.get("cw", THUMB_WIDTH))
    except ValueError:
        cw = THUMB_WIDTH
    cw = max(32, min(320, cw))
    # f0/f1：这一段在自己的成片里占哪一截（累积片必传，见 sprite_jpeg）
    def _fr(name):
        raw = request.query.get(name)
        if raw is None or raw == "":
            return None
        try:
            return max(0, int(float(raw)))
        except ValueError:
            return None
    f0, f1 = _fr("f0"), _fr("f1")

    # key 带版本 sp4 + cw：源片 mtime/size 变（重抽）、列档/格宽变、或拼图
    # 几何换代（sp3→sp4 格间缝）才失效。
    key = _key(path, "sp4", cols, cw, f0, f1)
    etag = _etag(key)
    if _not_modified(request, etag):
        return web.Response(status=304, headers=_sprite_headers(cols, etag))
    disk = _sprite_disk_path(key)
    hit = _sprite_cache.get(key)
    if hit is None and disk and os.path.isfile(disk):
        # 落盘命中：直接 FileResponse（零解码、零拷贝、自带 Range），重启也秒出。
        return web.FileResponse(disk, headers=_sprite_headers(cols, etag))
    if hit is None:
        async with _sprite_sem:
            hit = _sprite_cache.get(key)
            disk = _sprite_disk_path(key)
            if hit is None and disk and os.path.isfile(disk):
                return web.FileResponse(disk, headers=_sprite_headers(cols, etag))
            if hit is None:
                try:
                    hit = await _run(sprite_jpeg, path, cols, cw, f0, f1)
                except Exception as exc:
                    return web.Response(status=500, text=str(exc))
                _remember(_sprite_cache, key, hit)
                if disk:
                    _write_sprite_disk(disk, hit[0])
    body, got = hit
    return web.Response(body=body, content_type="image/jpeg",
                       headers=_sprite_headers(got, etag))


@PromptServer.instance.routes.get(PREFIX + "/waveform")
async def _route_waveform(request: web.Request) -> web.Response:
    try:
        path = _resolve(_video_arg(request))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=404)
    try:
        bins = int(request.query.get("bins", 900))
    except ValueError:
        bins = 900

    key = _key(path, bins)
    hit = _wave_cache.get(key)
    if hit is None:
        try:
            hit = await _run(waveform, path, bins)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        _remember(_wave_cache, key, hit)
    return web.json_response(hit)
