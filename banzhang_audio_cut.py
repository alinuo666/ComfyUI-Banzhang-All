"""音频切片：按采样点精确截取纯净长，绝不补头尾静音。

20261111 用户定：「末段音源不够时按剩余音频的实际时长，不补静音凑满设定秒数」。
分层落地：轨级仍用 apad 让多轨等长（amix duration=first 的硬要求），但
reslice_drivers 算出本段「有效秒」后，最终驱动 wav 一定裁到 eff_secs ——
轨级那条静音尾巴根本不进声音流。声音流不足的格由导演台用真静音 latent
填，不循环重放本段旋律。

为什么不用 -ss 快切：mp3 的帧是 1152 个采样点，-ss 只能对齐到帧，切片起点会漂移最多半帧；
atrim 按样本索引截取，输出样本数确定等于 终点样本 - 起点样本。
为什么中间先落一份 pcm wav：源格式有帧填充，无法靠 ffprobe 的 duration 精确数样本；
先解码成 pcm 才能得到真实总样本数，也才能对"源音频不够长"给出准确判断而不是静默截断。
"""

import functools
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import wave

# 音频重切专用锁（20261112 根因修复）：reslice_drivers 对 bzsa.driver 要么「读旧→
# 合并→写回」（局部 only=），要么「整份替换」（全量）。两者并发会互相覆盖（lost-update：
# 一边拖音频一边点接缝，某段声音被切错或归零）。用独立锁串行化所有重切，**不占**
# csglide_chain._chain_lock —— 否则切音频的几十次 ffmpeg 会把点接缝/切阶段一起堵死。
# reslice_drivers 内只调 film_summary（不带 chain 锁），无 _chain_lock↔_reslice_lock 嵌套死锁。
_reslice_lock = threading.RLock()


def reslicelocked(fn):
    @functools.wraps(fn)
    def _w(*a, **k):
        with _reslice_lock:
            return fn(*a, **k)
    return _w


CUT_DIRNAME = "班长音频切片"
def _bin(name):
    """全插件共用一份查找：PATH / 便携版自带 / 自动安装落点 / 包内 tools/ffmpeg。
    以前这里写死作者本机两个绝对路径，别的用户没有就报「找不到 ffprobe」。"""
    from .banzhang_ffmpeg import find_binary
    p = find_binary(name)
    if not p:
        raise RuntimeError(
            "找不到 %s：把 ffmpeg.exe / ffprobe.exe 放进插件包 tools/ffmpeg/bin，"
            "或加进系统 PATH（也可用环境变量 BANZHANG_FFMPEG_DIR 指定目录）" % name)
    return p


def _run(args, what):
    p = subprocess.run(args, capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        # 编码器提示是英文，终端留着给排查；抛给界面的必须是中文
        print("[班长音频切片] %s 失败，编码器原始提示：\n%s" % (what, (p.stderr or "").strip()))
        raise RuntimeError("%s失败：文件可能损坏、被别的程序占用，或格式不受支持" % what)
    return p


def _peaks_of(raw, bins=256):
    """波形只在这里算一次，前端只负责画；重画走内存数据，不再解一遍音频。"""
    import array
    a = array.array("h")
    try:
        a.frombytes(raw)
    except Exception:
        return []
    n = len(a)
    if n <= 0:
        return []
    per = max(1, n // bins)
    out = []
    for i in range(bins):
        seg = a[i * per:(i + 1) * per]
        if not seg:
            break
        out.append(round(max(max(seg), -min(seg)) / 32768.0, 3))
    return out


def probe(path):
    """真实值一律走 ffprobe：编码、采样率、声道数、时长、文件大小。"""
    if not os.path.isfile(path):
        raise RuntimeError("找不到音频文件：%s" % path)
    out = _run([_bin("ffprobe"), "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=codec_name,sample_rate,channels,channel_layout,duration",
                "-show_entries", "format=duration,size",
                "-of", "json", path], "读取音频信息")
    d = json.loads(out.stdout or "{}")
    st = (d.get("streams") or [{}])[0]
    fmt = d.get("format") or {}
    dur = st.get("duration") or fmt.get("duration")
    if not dur:
        raise RuntimeError("读不到音频时长，这个文件可能没有音轨：%s" % os.path.basename(path))
    sr = int(st.get("sample_rate") or 0)
    ch = int(st.get("channels") or 0)
    if sr <= 0 or ch <= 0:
        raise RuntimeError("音频参数异常（采样率 %s / 声道 %s），这个文件可能没有音轨" % (sr, ch))
    return {
        "时长秒": round(float(dur), 6),
        "采样率": sr,
        "声道数": ch,
        "声道布局": st.get("channel_layout") or "",
        "编码": st.get("codec_name") or "",
        "文件大小": int(fmt.get("size") or os.path.getsize(path)),
    }


def _decode_pcm(src, sr, ch, dst):
    _run([_bin("ffmpeg"), "-v", "error", "-y", "-i", src, "-vn",
          "-acodec", "pcm_s16le", "-ar", str(sr), "-ac", str(ch), dst], "解码音频")
    with wave.open(dst, "rb") as w:
        return w.getnframes()


def cut(src, start_sec, end_sec, out_dir, name_prefix=""):
    """切 [start_sec, end_sec) 的纯净长；起点终点按采样点就近取整。

    返回里带完整实测值，调用方（前端/自检）直接显示，不再自己算。
    """
    info = probe(src)
    sr, ch = info["采样率"], info["声道数"]
    start_sec = float(start_sec)
    end_sec = float(end_sec)
    if start_sec < 0:
        raise RuntimeError("起点不能是负数")
    s = int(round(start_sec * sr))
    e = int(round(end_sec * sr))
    if e <= s:
        raise RuntimeError("终点必须大于起点（当前 %0.6f → %0.6f 秒）" % (start_sec, end_sec))
    want = e - s

    os.makedirs(out_dir, exist_ok=True)
    stem = name_prefix or os.path.splitext(os.path.basename(src))[0]
    out = os.path.join(out_dir, "%s_%0.6f-%0.6f.wav" % (stem, s / sr, e / sr))

    tmp = tempfile.mkdtemp(prefix="bz_audio_cut_")
    try:
        full = os.path.join(tmp, "full.wav")
        total = _decode_pcm(src, sr, ch, full)
        if e > total:
            raise RuntimeError("这段音频不够长：只到 %0.6f 秒，你要到 %0.6f 秒。"
                               "切纯净长不会自动补静音，请缩短区间或换更长的音频"
                               % (round(total / sr, 6), round(end_sec, 6)))
        _run([_bin("ffmpeg"), "-v", "error", "-y", "-i", full,
              "-af", "atrim=start_sample=%d:end_sample=%d,asetpts=PTS-STARTPTS" % (s, e),
              "-acodec", "pcm_s16le", out], "切音频")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    with wave.open(out, "rb") as w:
        got = w.getnframes()
        out_ch = w.getnchannels()
        out_sr = w.getframerate()
        raw = w.readframes(got)
    if got != want:
        raise RuntimeError("切出来的样本数和请求不一致（请求 %d，实际 %d），已停下不交付" % (want, got))

    return {
        "峰值": _peaks_of(raw),
        "源文件": src,
        "源时长秒": info["时长秒"],
        "源采样率": sr,
        "源声道数": ch,
        "源编码": info["编码"],
        "起点秒": round(s / sr, 6),
        "终点秒": round(e / sr, 6),
        "请求时长秒": round(want / sr, 6),
        "输出文件": out,
        "输出时长秒": round(got / out_sr, 6),
        "输出样本数": got,
        "输出采样率": out_sr,
        "输出声道数": out_ch,
        "输出文件大小": os.path.getsize(out),
        "取整方式": "按 %d Hz 采样点就近：起点→第 %d 点，终点→第 %d 点" % (sr, s, e),
        "单点取整误差上限毫秒": round(1000.0 / (2 * sr), 6),
    }


def _mute_norm(v):
    """轨静音标记归一化：True/'all' = 整轨；段 id 列表 = 只静音这些段。

    20261111 方案 B：静音从「试听用的内存态」升级成档案级真值，存在
    bzsa.tracks[i]['静音']。这里只做归一化，不碰数据库 —— 自检可以直接
    拿这个真函数跑，不用 ComfyUI / 工程库。
    """
    if v is True or v == "all" or v == 1:
        return True
    if isinstance(v, (list, tuple, set)):
        # 空清单归一化成 False，否则「没静音」会在每次点击时被误判成变更。
        return sorted({str(x) for x in v if x}) or False
    return False


def is_track_muted(flag, cid):
    """这一轨在这一段是否静音（flag 已经过 _mute_norm）。"""
    if flag is True:
        return True
    return bool(flag) and str(cid) in flag


def inherit_mute(old_tracks, files):
    """重切会重写 bzsa.tracks —— 静音标记必须按**源文件路径**继承过来。

    按轨序号继承会串位：删掉第 1 轨后，旧第 1 轨的静音会落到新第 1 轨上。
    匹配不到的（新拖进来的轨）一律不静音，绝不猜。
    """
    by_file = {}
    for t in (old_tracks or []):
        if isinstance(t, dict) and t.get("文件"):
            by_file[str(t["文件"])] = _mute_norm(t.get("静音"))
    return [by_file.get(str(rel), False) for rel in (files or [])]


def _silence_driver(out_dir, cid, seconds, sr=48000):
    """本段所有轨都被静音时，仍要给声音流一条**真静音**驱动 wav。

    不给驱动 ≠ 静音：H3 的 AV latent 声音流会自己出声，用户听到的是模型
    随口编的环境音。用 anullsrc 生成 PCM 静音，audio VAE 编码后就是真静音。
    """
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "%s_silent.wav" % cid)
    secs = max(0.05, float(seconds or 0.0))
    sr = int(sr or 0) or 48000
    _run([_bin("ffmpeg"), "-v", "error", "-y",
          "-f", "lavfi", "-i", "anullsrc=r=%d:cl=stereo" % sr,
          "-t", "%.6f" % secs, "-acodec", "pcm_s16le", out],
         "生成静音驱动音频")
    return out


def mix_drivers(paths, out_dir, name_prefix, seconds=None):
    """同一段的多条轨混成**一条驱动音频**。

    H3 的 AV latent 只有一个声音流 [B,32,2,T]，物理上不可能让 3 条轨并列
    驱动。所以时间轴上所有轨先按段混音：既是送进声音流的驱动，也是成片音轨。
    单轨直接返回原切片，不复制、不重编码（零额外开销）。

    amix 的 normalize=1 按输入数缩放防削波；duration=first 以主轨为准，
    副轨短的部分补静音；再用 -t 截到 **本段实际有音频的秒数**（20261111 起，
    以前截到段净长 = 把末段假静音凑满设定秒数）。单轨同样裁这一刀。
    """
    paths = [p for p in paths if p]
    if len(paths) <= 1:
        p = paths[0] if paths else ""
        # 20261111 用户定：末段音源不够时**绝不补静音凑满「每段 N 秒」**。
        # segment_track 为了让多轨等长（amix duration=first）仍会 apad 出一条
        # 静音尾巴，单轨以前直接把这条带假静音的切片原样返回 —— 它进了声音流
        # 就是「最后一段被静音凑满 10 秒」。统一按本段实际有音频的秒数裁一刀。
        if p and seconds and float(seconds) > 0:
            os.makedirs(out_dir, exist_ok=True)
            out = os.path.join(out_dir, "%s_drv1.wav" % name_prefix)
            _run([_bin("ffmpeg"), "-v", "error", "-y", "-i", p,
                  "-t", "%.6f" % float(seconds),
                  "-acodec", "pcm_s16le", out], "裁驱动音频到实际音源长度")
            return out
        return p
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "%s_drv_%d.wav" % (name_prefix, len(paths)))
    args = [_bin("ffmpeg"), "-v", "error", "-y"]
    for p in paths:
        args += ["-i", p]
    filt = "".join("[%d:a]" % i for i in range(len(paths)))
    filt += "amix=inputs=%d:duration=first:normalize=1[a]" % len(paths)
    args += ["-filter_complex", filt, "-map", "[a]"]
    if seconds and float(seconds) > 0:
        args += ["-t", "%.6f" % float(seconds)]
    args += ["-acodec", "pcm_s16le", out]
    _run(args, "混音驱动音频")
    return out


def _segments_of(lay, cf, ct):
    """布局 → 覆盖整段的有序片段列表 [(起帧, 止帧, 是否静音)]。

    切点与 clip_from/clip_to 同为连播坐标，不再做段自身帧换算。左右把手
    裁掉的两侧也算静音片段，因此片段总长恒等于段长 —— 删中间既不改段长
    也不波纹前移。
    """
    cf, ct = int(round(float(cf))), int(round(float(ct)))
    if ct <= cf:
        return []
    if not isinstance(lay, dict):
        return [(cf, ct, False)]
    f = max(cf, min(ct, int(round(float(lay.get("f") or cf)))))
    t = max(f, min(ct, int(round(float(lay.get("t") or ct)))))
    cuts = []
    for x in (lay.get("cuts") or []):
        try:
            v = int(round(float(x)))
        except (TypeError, ValueError):
            continue
        if f < v < t and v not in cuts:
            cuts.append(v)
    cuts.sort()
    dead = set()
    for x in (lay.get("del") or []):
        try:
            dead.add(int(x))
        except (TypeError, ValueError):
            pass
    # del 存片段**起点帧**而不是序号：再插一刀时序号会整体漂移，起点不会。
    pts = sorted(set([cf, f, t, ct] + cuts))
    out = []
    for a, b in zip(pts, pts[1:]):
        out.append((a, b, (a < f or b > t or a in dead)))
    return [(a, b, d) for a, b, d in out if b > a]


def _seg_ffmpeg_args(full, sr, segs, fps, shift, total_sec):
    """一次解码整曲后的 filter_complex：逐片段 atrim / 静音 → concat。"""
    live_n = sum(1 for a, b, dead in segs
                 if not dead and b / fps + shift > 0
                 and a / fps + shift < total_sec
                 and (b - a) / fps >= 1.0 / fps)
    args = [_bin("ffmpeg"), "-v", "error", "-y", "-i", full]
    filters, labels, lavfi, live_i = [], [], 0, 0
    if live_n > 1:
        filters.append("[0:a]asplit=%d%s" %
                       (live_n, "".join("[s%d]" % k for k in range(live_n))))
    for i, (a, b, dead) in enumerate(segs):
        s, e, dur = a / fps + shift, b / fps + shift, (b - a) / fps
        ok = (not dead and e > 0 and s < total_sec and e - s >= 1.0 / fps)
        if ok:
            src = "[s%d]" % live_i if live_n > 1 else "[0:a]"
            live_i += 1
            # 轨级必须输出 == 显示时长（多轨 amix duration=first 的硬要求），
            # 源音频比片段短就在这里补静音；这条静音尾巴会在 mix_drivers 的
            # -t 裁到「有效秒」时被丢掉，不会进声音流（20261111）。
            filters.append("%satrim=start=%.6f:end=%.6f,asetpts=PTS-STARTPTS,"
                           "apad=whole_dur=%.6f,atrim=duration=%.6f,"
                           "aformat=sample_rates=%d:channel_layouts=stereo[p%d]"
                           % (src, max(0.0, s), min(total_sec, e), dur, dur, sr, i))
        else:
            idx = 1 + lavfi
            lavfi += 1
            args += ["-f", "lavfi", "-t", "%.6f" % dur,
                     "-i", "anullsrc=r=%d:cl=stereo" % sr]
            filters.append("[%d:a]aformat=sample_rates=%d:channel_layouts=stereo[p%d]"
                           % (idx, sr, i))
        labels.append("[p%d]" % i)
    args += ["-filter_complex",
             ";".join(filters) + ";" + "".join(labels) +
             "concat=n=%d:v=0:a=1[out]" % len(labels),
             "-map", "[out]", "-acodec", "pcm_s16le"]
    return args


def segment_track(src, lay, cf, ct, fps, out_dir, prefix, total_sec):
    """按片段列表合成这一轨这一段，返回 (wav 绝对路径, 峰值)。

    恒输出**整段长度**：有声片段按 layout 的 f/t 摆在原位，块外与源音频
    不够长的部分补静音。所有轨长度一致，混音才不会被 amix duration=first
    截短，也不会出现「成片里只有一小段有声音」。
    """
    segs = _segments_of(lay, cf, ct)
    if not segs:
        return "", []
    shift = 0.0
    if isinstance(lay, dict) and lay.get("sf") is not None:
        # sf 是「块起点 f 对应的源帧」，不是「段起点 cf 对应的源帧」。
        # 以前拿 cf 减，块被拖到段中间时源区间整体多偏了一个块起点，
        # 短音频直接全落到文件之外 → 整条轨全是静音（20261109 工程26实测）。
        f0 = float(lay.get("f") if lay.get("f") is not None else cf)
        shift = (float(lay["sf"]) - f0) / fps
    info = probe(src)
    sr = info["采样率"]
    tmp = tempfile.mkdtemp(prefix="bz_seg_")
    try:
        full = os.path.join(tmp, "full.wav")
        total = _decode_pcm(src, sr, info["声道数"], full)
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, "%s_seg.wav" % prefix)
        _run(_seg_ffmpeg_args(full, sr, segs, fps, shift, total / sr) + [out],
             "合成音频片段")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    with wave.open(out, "rb") as w:
        raw = w.readframes(w.getnframes())
    return out, _peaks_of(raw)


@reslicelocked
def reslice_drivers(name, files, only=None):
    """按**当前段档案**重切全部驱动音频，写回 bzsa.driver / bzsa.tracks。

    only 非空 = 只重切这些段（手动分割 / 裁剪后的精准重切），保留其它段
    的驱动与波形峰值，避免每次松手都把 18 段全解码一遍。

    段长派生数据的唯一入口。以前只有「拖入音频 / 改每段秒数」会调，其它改段长
    的路径（时间轴拖动、段菜单、冲突消解）写完 frames 就走人，切片还停在旧边界：
    生成时声音流按新段长铺、驱动音频只有旧长度，尾部零 latent 解码出底噪。
    现在 csglide_chain.resize_clip / resize_many 与 auto_slice 路由都落到这里，
    frames 与切片不可能再分开写。

    20261111 方案 B：静音是档案级真值（bzsa.tracks[i]['静音']），这里
    混音时跳过被静音的轨。波形 / 试听仍按全部轨切，只是不进驱动。
    全轨静音时生成真静音 wav —— 不给驱动 H3 会自己出声，那不叫静音。
    """
    import re as _re
    from folder_paths import get_input_directory
    from . import csglide_chain as _chain
    from . import csglide_store as _st

    files = [str(x).strip() for x in (files or []) if x]
    if not files:
        raise RuntimeError("没有音频轨，不重切")
    fs = _chain.film_summary(name)
    rows = fs.get("clips") or []
    if not rows:
        raise RuntimeError("读不到段清单：先在导演台把段排好，再拖音频")
    fps = float(fs.get("fps") or 24) or 24
    d = _st.chain_dir(name)
    if _st.ensure_db(d) != "db":
        raise RuntimeError("老工程（JSON 档案）不支持自动分发：先升到状态库工程")
    safe = _re.sub(r'[\\/:*?"<>|]', "_", name)[:60] or "工程"
    sub = "cglide/" + safe
    out_dir = os.path.join(get_input_directory(), "cglide", safe)
    conn0 = _st._connect(d, create=False)
    if conn0 is None:
        raise RuntimeError("工程库打不开")
    layout = _st._meta_get(conn0, "bzsa.layout", {}) or {}
    old_drv = _st._meta_get(conn0, "bzsa.driver", {}) or {}
    # 本函数会重写 bzsa.tracks，静音标记必须先继承下来，否则一切重切
    # （拖音频 / 改段长 / 删轨 / 滑动）都会把用户点的静音悄悄冲掉。
    old_tracks = _st._meta_get(conn0, "bzsa.tracks", []) or []
    mute_flags = inherit_mute(old_tracks, files)
    wanted = set(str(x) for x in (only or [])) or None
    # 源音频只探一次：段数 × 轨数 次 ffprobe，18 段工程会白等十几秒。
    srcs = []
    for rel in files:
        p = _input_path(rel)
        _pi = probe(p)
        srcs.append((p, float(_pi["时长秒"]), int(_pi["采样率"])))
    detail, driver = [], (dict(old_drv) if wanted else {})
    mix_cnt = 0
    short_cnt = 0
    mute_seg_cnt = 0
    blocks_by_file = [[] for _ in srcs]
    for r in rows:
        cid = str(r.get("id") or "")
        if not cid.startswith("clip_"):
            continue
        if wanted and cid not in wanted:
            continue
        cf = int(r.get("clip_from") or 0)
        ct = int(r.get("clip_to") or 0)
        # 20261111 二次修正：**断链段绝不能把 trim 补回切片终点**。
        # 上一轮为让断链段声音流铺满全长，在这里写过 ct += trim，但
        # clip_from / clip_to 是「净长累积」坐标：cf + (ct - cf) 恰好等于
        # 下一段的 clip_from。多取的 trim 帧就是下一段开头的音频 —— 它同时
        # 出现在断链段的**尾部**和下一段的**头部**，用户报的「取消接续后
        # 有的段头和尾的音频重复」正是这一处。
        # 断链段「全长帧 vs 净长」的差额交给
        # csglide_cast.driver_stream_latents() 用**真静音 latent** 填：
        # 不循环重放本段、不侵占邻段，也不会把零 latent 交给 VAE。
        # clip_from / clip_to 一律不动 —— 那是已生成成片的拼接坐标。
        want_secs = max(0.0, (ct - cf) / fps)
        # 20261111 用户定：末段音源不够就按**剩余音频的实际时长**，绝不补
        # 静音凑满设定秒数。轨级仍要等长（多轨 amix duration=first 需要），
        # 但最终驱动 wav 只裁到 eff_secs —— 后面那段假静音根本不进声音流，
        # 也就不会被尾部循环补齐成「又唱了一遍」。
        max_src = max((s[1] for s in srcs), default=0.0)
        eff_secs = min(want_secs, max(0.0, max_src - cf / fps))
        short = bool(eff_secs < want_secs - 1e-3)
        # 波形 / 试听数据照常按「所有轨」切 —— 静音不该让波形消失。
        # 但送进声音流的驱动只从**未静音轨**里取，这才是成片里真正听到的。
        all_parts = []
        for i, (src, total, _sr) in enumerate(srcs):
            lay = (layout.get(str(i + 1)) or {}).get(cid)
            j_abs, pk = segment_track(src, lay, cf, ct, fps, out_dir,
                                      "%s_a%d" % (cid, i + 1), total)
            if not j_abs:
                continue
            rel_out = sub + "/" + os.path.basename(j_abs)
            all_parts.append((i + 1, rel_out, j_abs))
            blocks_by_file[i].append({
                "段": cid, "起帧": cf, "止帧": ct,
                "峰值": pk, "文件": rel_out,
            })
        muted_here = [no for (no, _r, _a) in all_parts
                      if is_track_muted(mute_flags[no - 1], cid)]
        live = [x for x in all_parts if x[0] not in muted_here]
        parts = [x[1] for x in live]
        parts_abs = [x[2] for x in live]
        if muted_here:
            mute_seg_cnt += 1
        if short:
            short_cnt += 1
        # 有效音频不足 2 格（0.05 秒）就别给这一段驱动：空 wav 编码会撞穿
        # audio VAE 开头的卷积，让整轮渲染报错。该段交给模型自行出声。
        # 全轨静音是例外：必须给一条真静音驱动，否则模型会自己出声。
        if (parts_abs or all_parts) and eff_secs >= 0.05:
            if parts_abs:
                drv_abs = mix_drivers(parts_abs, out_dir, cid, seconds=eff_secs)
            else:
                drv_abs = _silence_driver(out_dir, cid, eff_secs,
                                          srcs[0][2] if srcs else 48000)
            driver[cid] = {
                "v": 1,
                "file": sub + "/" + os.path.basename(drv_abs),
                "parts": parts,
                "from": cf, "to": ct,
                "fps": fps,
                "tracks": len(parts),
                "mix": 1 if len(parts) > 1 else 0,
                # 本段被跳过的轨号（1-based）—— 诊断与导出提示的真值。
                "静音轨": muted_here,
                # 本段真正有声音的秒数 —— 声音流对齐、诊断日志、前端提示的真值。
                "有效秒": round(eff_secs, 6),
                "段长秒": round(want_secs, 6),
                "音源被裁短": short,
            }
            if len(parts) > 1:
                mix_cnt += 1
        else:
            # 本段音源一点都不剩：老驱动必须清掉，否则部分重切（only=）
            # 会留着上一次的切片，全部渲染照样把旧音频生成出来。
            driver.pop(cid, None)
        detail.append({"段": cid, "轨数": len(parts),
                       "静音轨": muted_here,
                       "起点秒": round(cf / fps, 3), "终点秒": round(ct / fps, 3),
                       "有效秒": round(eff_secs, 6),
                       "段长秒": round(want_secs, 6),
                       "音源被裁短": short})
    if not detail:
        raise RuntimeError("段清单里没有可切的段：段 id 不是 clip_ 开头？")
    tracks_meta = [{
        "文件": files[i],
        "名称": os.path.basename(files[i]),
        "时长秒": srcs[i][1],
        "采样率": srcs[i][2],
        # 方案 B：静音跟轨走，重写档案时必须原样带回去。
        "静音": mute_flags[i],
        "块": blocks_by_file[i],
    } for i in range(len(srcs))]
    # 写库失败必须如实抛错（20261112 根因修复）：以前 except: pass 吞掉异常仍返回
    # 成功，路由照报「已重切」，但切片其实没落库 → 渲染读旧/缺驱动（假绿，最难查）。
    # 调用方（auto_slice / slip / layout / chain reslice 路由）外层都有 try/except，
    # 抛上去即回 done:False / 中文错误提示，不再假成功。
    _c = _st._connect(d, create=False)
    if _c is None:
        raise RuntimeError("工程库打不开，驱动音频没写进档案")
    if not wanted:
        _st._meta_set(_c, "bzsa.tracks", tracks_meta)
    # 全量替换：本次没切出音频的段自然没有驱动。
    _st._meta_set(_c, "bzsa.driver", driver)
    _c.commit()
    # 绝不 close：_connect 返回的是缓存的共享连接。
    return {"成功": True, "段数": len(detail),
            "驱动段数": len(driver), "混音段数": mix_cnt,
            "缩短段数": short_cnt,
            "静音轨数": sum(1 for f in mute_flags if f),
            "静音段数": mute_seg_cnt,
            "明细": detail,
            "轨": [{"文件": files[i], "块": blocks_by_file[i]}
                   for i in range(len(srcs))]}


def cut_strip(src, spans, out_dir, name_prefix="配乐"):
    """配乐轨连续铺：spans 是**整曲绝对坐标**的 [起点, 终点] 序列。

    为什么用绝对坐标：配乐是一条连续时间轴，第 2 块的内容必须紧跟第 1 块；
    若按"段内从 0 开始"切，每段都会从歌头重来，听感上就是反复重播。
    块间首尾必须严丝合缝——差一个采样点就是缝或重叠，这里直接停下报错。
    """
    info = probe(src)
    sr, ch = info["采样率"], info["声道数"]
    tmp = tempfile.mkdtemp(prefix="bz_strip_")
    try:
        total = _decode_pcm(src, sr, ch, os.path.join(tmp, "full.wav"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    pts = [(int(round(float(s) * sr)), int(round(float(e) * sr))) for s, e in spans]
    for i in range(len(pts) - 1):
        if pts[i][1] != pts[i + 1][0]:
            raise RuntimeError(
                "配乐切片必须首尾相接：第 %d 块切到 %0.6f 秒，第 %d 块却从 %0.6f 秒开始（差 %d 个采样点）"
                % (i + 1, pts[i][1] / sr, i + 2, pts[i + 1][0] / sr,
                   pts[i + 1][0] - pts[i][1]))

    blocks, tail_cut = [], 0
    for i, (s, e) in enumerate(pts, 1):
        if s >= total:
            raise RuntimeError("配乐在 %0.6f 秒就播完了，第 %d 段没有音乐可铺；"
                               "配乐不循环、不补静音，请换更长的曲子" % (total / sr, i))
        e2 = min(e, total)
        r = cut(src, s / sr, e2 / sr, out_dir, "%s%02d" % (name_prefix, i))
        r["到曲尾"] = "是" if e2 < e else "否"
        tail_cut += e - e2
        blocks.append(r)

    used = sum(b["输出样本数"] for b in blocks)
    return {"源文件": src, "源时长秒": info["时长秒"], "源采样率": sr, "源声道数": ch,
            "块": blocks, "合计秒": round(used / sr, 6),
            "曲尾被截掉的样本数": tail_cut,
            "说明": "按整曲绝对坐标逐块切，块间首尾相接；不循环、不补静音、不变速"}


def peaks(path, bins=512):
    """整曲峰值：配乐轨要一条长条铺满整轴，需要整首的包络。只算一次给前端画。"""
    info = probe(path)
    sr, ch = info["采样率"], info["声道数"]
    tmp = tempfile.mkdtemp(prefix="bz_peaks_")
    try:
        p = os.path.join(tmp, "full.wav")
        _decode_pcm(path, sr, ch, p)
        with wave.open(p, "rb") as w:
            raw = w.readframes(w.getnframes())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"峰值": _peaks_of(raw, bins), "时长秒": info["时长秒"]}


# --------------------------------------------------------------------------
# HTTP 路由：本轮不接 __init__.py，import 时若没有 ComfyUI 环境就静默跳过
# --------------------------------------------------------------------------
def _input_path(file):
    """只允许 input 目录内的相对路径，挡住绝对路径与 ..。"""
    import folder_paths
    rel = str(file or "").replace("\\", "/").strip()
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        raise RuntimeError("文件名不合法，只接受 input 目录里的相对路径")
    p = os.path.join(folder_paths.get_input_directory(), rel)
    if not os.path.isfile(p):
        raise RuntimeError("input 目录里没有这个文件：%s" % rel)
    return p


def _register_routes():
    try:
        from server import PromptServer
        from aiohttp import web
        from folder_paths import get_output_directory
    except Exception:
        return
    ps = getattr(PromptServer, "instance", None)
    if ps is None:
        return
    routes = ps.routes

    def _zh(e):
        return web.json_response({"错误": str(e)}, status=400)

    @routes.get("/banzhang/audio/probe")
    async def _r_probe(request):
        try:
            return web.json_response(probe(_input_path(request.query.get("file"))))
        except Exception as e:
            return _zh(e)

    @routes.post("/banzhang/audio/cut")
    async def _r_cut(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"错误": "请求体不是 JSON"}, status=400)
        try:
            src = _input_path(body.get("file"))
            out_dir = os.path.join(get_output_directory(), CUT_DIRNAME)
            return web.json_response(cut(src, body.get("start"), body.get("end"), out_dir))
        except Exception as e:
            return _zh(e)

    @routes.post("/banzhang/audio/auto_slice")
    async def _r_auto_slice(request):
        """按现有段清单把时间轴音频裁成**每段一条驱动音频**（多轨先混音）。

        20261107 用户定：时间轴上的音频**只做驱动、不做参考**。所以它不再写
        媒体架 audios 槽、不再写文案台 @音频N 自动句、不再广播界面同步 ——
        需要参考素材由用户手动摆进媒体架/文案台，两条链路互不污染。

        驱动片段的路径写进 meta["bzsa.driver"][cid]，由导演台按当前段直读，
        编码进 H3 的 AV latent 声音流并锁噪。不改段数、不碰续接。

        20261111 用户选 B：带 shrink_frames=1 时（拖入主音轨 / 改「每段 N 秒」），
        末段音源不够就**连画面段长一起缩短**到剩余音频实际时长。缩短必须在
        reslice_drivers 之前改完档案，随后那一次重切才会按新 clip_to 裁 ——
        改档案与重切是同一事务，音频只切一次，两者不可能分叉。
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"错误": "请求体不是 JSON"}, status=400)
        name = str(body.get("name") or "").strip()
        files = [str(x).strip() for x in (body.get("files") or []) if x]
        shrink = bool(body.get("shrink_frames"))
        if not name:
            return web.json_response({"错误": "缺少片名"}, status=400)
        # 换音频 / 重排段 / 删轨时轨号变了，旧布局按旧轨号与旧段存，必须作废：
        # 否则换成长音频后第 1 段仍被旧 f/t 裁成 4 秒，波形与声音一起错位。
        try:
            from . import csglide_store as _st
            d0 = _st.chain_dir(name)
            if _st.ensure_db(d0) == "db":
                conn0 = _st._connect(d0, create=False)
                if conn0 is not None:
                    _st._meta_set(conn0, "bzsa.layout", {})
                    if not files:
                        # 删光音轨：旧驱动必须一起清掉，否则全部渲染还会把
                        # 删掉的音频生成出来（20261110 用户实测）。
                        _st._meta_set(conn0, "bzsa.tracks", [])
                        _st._meta_set(conn0, "bzsa.driver", {})
                    conn0.commit()
        except Exception:
            pass
        if not files:
            return web.json_response({"成功": True, "段数": 0, "驱动段数": 0, "轨数": 0})

        def _work():
            """全在这条线程里跑：几十次 ffmpeg 占着事件循环会把整个界面冻住。"""
            pre = {}
            if shrink:
                # 只改档案 frames，不重切；紧接着 reslice_drivers 读新 clip_to
                # 一次切完。返回的新帧数清单交给前端写齐面板预设。
                from . import csglide_chain as _chain
                pre = _chain.shrink_tail_to_audio(name, files) or {}
            res = reslice_drivers(name, files)
            if shrink:
                res = dict(res)
                res["末段缩短"] = pre
            return res

        try:
            import asyncio
            res = await asyncio.get_event_loop().run_in_executor(None, _work)
        except Exception as e:
            return _zh(e)
        # 刻意不广播：驱动音频不进媒体架 / 文案台，那边是用户手动摆参考素材
        # 的地方，不该被时间轴的拖入动作刷新或覆盖。
        return web.json_response(res)

    @routes.post("/banzhang/audio/mute")
    async def _r_mute(request):
        """时间轴轨静音 → 写进 bzsa.tracks → 全量重切驱动 → 新成片才真没这条轨。

        20261111 方案 B：以前轨头 🔊 只改内存态，导出拼的是已渲染好的 mp4，
        静音根本进不了片子。现在静音是**档案级真值**：reslice_drivers 混音时
        跳过静音轨；已生成的旧成片由 export_film_plan 按静音变更时间提示重跑。

        body.muted 是与「轨序号」同序的数组：true=整轨、[cid,...]=只静音这些段、
        false/空=不静音。用数组而不是对象，前端与后端都按同一顺序对齐，
        不会因为多拖一条轨就串位。
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"错误": "请求体不是 JSON"}, status=400)
        name = str(body.get("name") or "").strip()
        muted = body.get("muted")
        if not name:
            return web.json_response({"错误": "缺少片名"}, status=400)
        if not isinstance(muted, list):
            return web.json_response({"错误": "静音清单格式不对（应为数组）"}, status=400)
        try:
            import asyncio
            from . import csglide_store as _st
        except Exception as e:
            return web.json_response({"错误": "工程模块没读到：%s" % e}, status=500)

        def _work():
            d = _st.chain_dir(name)
            if _st.ensure_db(d) != "db":
                raise RuntimeError("老工程（JSON 档案）不支持轨静音落库")
            conn = _st._connect(d, create=False)
            if conn is None:
                raise RuntimeError("工程库打不开")
            tracks = _st._meta_get(conn, "bzsa.tracks", []) or []
            if not isinstance(tracks, list) or not tracks:
                raise RuntimeError("还没有音轨，先拖入音频再静音")
            changed = False
            new_flags = []
            for i, t in enumerate(tracks):
                raw = muted[i] if i < len(muted) else None
                flag = _mute_norm(raw)
                old = _mute_norm((t or {}).get("静音") if isinstance(t, dict) else None)
                if flag != old:
                    changed = True
                if isinstance(t, dict):
                    if flag:
                        t["静音"] = flag
                    else:
                        t.pop("静音", None)
                new_flags.append(flag)
            if not changed:
                # 重复点同一个状态不该把「静音变更时间」往前推 —— 否则导出的
                # 旧成片明明已经是新混音，却被误报成要重跑。
                return {"成功": True, "未变化": True,
                        "静音轨数": sum(1 for f in new_flags if f)}
            _st._meta_set(conn, "bzsa.tracks", tracks)
            conn.commit()
            files = [str(t.get("文件") or "") for t in tracks
                     if isinstance(t, dict) and t.get("文件")]
            if not files:
                raise RuntimeError("音轨清单里没有源文件，无法重切")
            # 只有重切真的成功才记时间戳：导出的「旧成片」判据不能假阳性。
            res = reslice_drivers(name, files)
            rev = int(_st._meta_get(conn, "bzsa.mute_rev", 0) or 0) + 1
            _st._meta_set(conn, "bzsa.mute_rev", rev)
            _st._meta_set(conn, "bzsa.mute_at", time.time())
            conn.commit()
            return {"成功": True,
                    "静音轨数": sum(1 for f in new_flags if f),
                    "静音段数": int(res.get("静音段数") or 0),
                    "重切段数": int(res.get("段数") or 0),
                    "mute_rev": rev}

        try:
            res = await asyncio.get_event_loop().run_in_executor(None, _work)
        except Exception as e:
            return _zh(e)
        return web.json_response(res)

    @routes.post("/banzhang/audio/slip")
    async def _r_slip(request):
        """滑动剪辑落库：把新源入点写进布局，交给 reslice_drivers 重切本段。

        合成入口只有 reslice_drivers 一条，滑动与分割/删除共用同一份片段
        真值，不会出现「滑完把切好的片段又盖回整段」。
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"错误": "请求体不是 JSON"}, status=400)
        name = str(body.get("name") or "").strip()
        cid = str(body.get("cid") or "").strip()
        rel = str(body.get("file") or "").strip()
        try:
            track = int(body.get("track") or 0)
            start = float(body.get("start") or 0)
            end = float(body.get("end") or 0)
        except (TypeError, ValueError):
            return web.json_response({"错误": "轨序号 / 起止秒不是数字"}, status=400)
        if not (name and cid.startswith("clip_") and rel and track >= 1):
            return web.json_response({"错误": "缺少片名 / 段 / 源音频 / 轨序号"}, status=400)
        try:
            import asyncio
            from . import csglide_store as _st
        except Exception as e:
            return web.json_response({"错误": "工程模块没读到：%s" % e}, status=500)

        def _work():
            """滑动只改布局的源入点，合成统一交给 reslice_drivers。

            以前这里自己 cut + mix 一份驱动，会盖掉 layout 里已保存的分割 /
            删除片段 —— 两条合成路径并存必然互相覆盖，现在只剩一条。
            """
            d = _st.chain_dir(name)
            if _st.ensure_db(d) != "db":
                raise RuntimeError("老工程（JSON 档案）不支持滑动剪辑")
            conn = _st._connect(d, create=False)
            if conn is None:
                raise RuntimeError("工程库打不开")
            all_drv = _st._meta_get(conn, "bzsa.driver", {}) or {}
            info = all_drv.get(cid) or {}
            if int(info.get("v") or 0) != 1:
                raise RuntimeError("这一段没有驱动音频，先拖入音频再滑动")
            fps = float(info.get("fps") or 24) or 24
            layout = _st._meta_get(conn, "bzsa.layout", {}) or {}
            per = dict(layout.get(str(track)) or {})
            cur = dict(per.get(cid) or {})
            cur["sf"] = int(round(start * fps))
            cur["st"] = int(round(end * fps))
            cur["sl"] = 1
            per[cid] = cur
            layout[str(track)] = per
            _st._meta_set(conn, "bzsa.layout", layout)
            conn.commit()
            tracks = _st._meta_get(conn, "bzsa.tracks", []) or []
            files = [str(t.get("文件") or "") for t in tracks
                     if isinstance(t, dict) and t.get("文件")]
            if not files:
                raise RuntimeError("读不到音轨清单，滑动后无法重切")
            reslice_drivers(name, files, only=[cid])
            return {"成功": True, "起点秒": round(start, 6),
                    "终点秒": round(end, 6), "混音": int(info.get("mix") or 0)}

        try:
            res = await asyncio.get_event_loop().run_in_executor(None, _work)
        except Exception as e:
            return _zh(e)
        # 驱动片段变了，不需要通知媒体架 / 文案台（那条桥接已砍）。
        return web.json_response(res)

    @routes.get("/banzhang/audio/peaks")
    async def _r_peaks(request):
        try:
            return web.json_response(peaks(_input_path(request.query.get("file"))))
        except Exception as e:
            return _zh(e)

    @routes.get("/banzhang/audio/tracks")
    async def _r_tracks(request):
        """读回本工程已分发的音轨清单（刷新页面后重建轨 + 波形用）。"""
        name = str(request.query.get("name") or "").strip()
        if not name:
            return web.json_response({"错误": "缺少片名"}, status=400)
        try:
            from . import csglide_store as _st
        except Exception as e:
            return web.json_response({"错误": "工程模块没读到：%s" % e}, status=500)
        try:
            d = _st.chain_dir(name)
            if _st.ensure_db(d) != "db":
                return web.json_response({"轨": []})
            conn = _st._connect(d, create=False)
            if conn is None:
                return web.json_response({"轨": []})
            val = _st._meta_get(conn, "bzsa.tracks", []) or []
            lay = _st._meta_get(conn, "bzsa.layout", {}) or {}
            drv = _st._meta_get(conn, "bzsa.driver", {}) or {}
            # 同样不 close：共享连接由 csglide_store 自己管理。
            return web.json_response({
                "轨": val if isinstance(val, list) else [],
                "布局": lay if isinstance(lay, dict) else {},
                # 试听要听按布局合成后的片段，不是整条源音频；parts 每次编辑
                # 都会被 reslice_drivers 重写，与送模型 / 成片是同一份真值。
                "驱动": drv if isinstance(drv, dict) else {},
            })
        except Exception as e:
            return _zh(e)

    @routes.post("/banzhang/audio/layout")
    async def _r_layout(request):
        """存音频块布局（轨序号 → 段键）：f/t 边界、sf/st 源入出点、
        cuts 分割点、del 删除片段。

        存完立刻只重切 changed 里的段：以前布局只管显示，送模型的切片仍按
        整段切，用户裁了/删了却听不出变化。现在显示与驱动共用同一份真值。
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"错误": "请求体不是 JSON"}, status=400)
        name = str(body.get("name") or "").strip()
        if not name:
            return web.json_response({"错误": "缺少片名"}, status=400)
        layout = body.get("layout")
        if not isinstance(layout, dict):
            layout = {}
        try:
            from . import csglide_store as _st
        except Exception as e:
            return web.json_response({"错误": "工程模块没读到：%s" % e}, status=500)
        # 整段（存布局 + 重切）丢线程池（20261112 根因修复）：reslice_drivers 内含
        # 几十次 ffmpeg，同步跑在事件循环里会冻住整条 HTTP（连同在途的渲染收口）。
        # 与 auto_slice / slip / mute 同一写法。错误状态码用 _status 带回，不丢 409/500。
        def _work():
            d = _st.chain_dir(name)
            if _st.ensure_db(d) != "db":
                return {"错误": "老工程（JSON 档案）不支持手动布局", "_status": 409}
            conn = _st._connect(d, create=True)
            if conn is None:
                return {"错误": "工程库打不开", "_status": 500}
            _st._meta_set(conn, "bzsa.layout", layout)
            conn.commit()
            # 受影响段由刚落库的 layout 自己决定，不信任前端的 changed：
            # 前端漏传 / 清空「本次改动」时，layout 已存、驱动却没重切，
            # 运行时就读到旧位置的声音（20261109 工程26 实测 WAL 更新
            # 20:48:07 > wav 生成 20:47:51，两轨声音全部归到 0）。
            # layout 与 driver 必须在同一次事务里一起落地。
            changed = sorted({str(k) for per in layout.values()
                              if isinstance(per, dict) for k in per})
            n = 0
            if changed:
                tracks = _st._meta_get(conn, "bzsa.tracks", []) or []
                files = [str(t.get("文件") or "") for t in tracks
                         if isinstance(t, dict) and t.get("文件")]
                if files:
                    n = int(reslice_drivers(name, files, only=changed).get("驱动段数") or 0)
            return {"成功": True, "轨数": len(layout), "重切段数": n}

        try:
            import asyncio
            out = await asyncio.get_event_loop().run_in_executor(None, _work)
        except Exception as e:
            return _zh(e)
        status = out.pop("_status", 200)
        return web.json_response(out, status=status)

    # 这行是「新代码到底加载没有」的判据：终端看不到它 = 还是旧的进程。
    # 拖音频报 405 时先看这行，别去翻前端。
    print("[班长音频切片] 路由已注册：probe / cut / auto_slice / mute / peaks / tracks")


_register_routes()
