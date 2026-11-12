"""Glide Join — assemble a continuation onto the clip it continued from.

The anchored frames come back at the HEAD of the new clip, so the same span of
time exists twice: once in the source, once re-rendered by the model. This node
drops one copy and hands the result to Glide Video as a single stream.

Which copy it drops is the whole question, and H3 answers it differently from
LTX. On the LTX chunk render the guide pinned the next chunk's frame 0
PIXEL-IDENTICAL to the previous chunk's overlapped frame, so cutting at the
start of the overlap cost nothing. H3 pins nothing: the anchored frames are
conditioning, and the model re-renders that span in its own colour.

  early_cut  keeps the continuation's version and corrects its colour against
             the source frame by frame. The overlap is then one continuous
             model trajectory, so motion carries better - verified.
  hard_cut   keeps the source's own frames and drops the re-rendered head.
             Nothing to correct, but the join lands at the END of the overlap
             where the two renders have diverged most.

(上面这两个名字是选项在画布上显示的「提前切 / 硬切」。内部判别一律通过
_seam_mode() 归一，见下方 SEAM_MODES 那一段。)

Colour correction is affine and per-frame, because for the length of the
overlap both clips render the SAME INSTANTS and that is ground truth. A single
mean offset assumes the two differ by a constant lift, which is not how
exposure works; fitting gain and offset against the matching frame catches
level, contrast and colour together. Measured against a synthetic
gain-plus-lift flicker: mean matching left 0.021 pixel error, affine left
0.000.
"""

import os
from fractions import Fraction

import numpy as np
import torch
# 模块级：最近一次真正进到 join() 的源视频。源视频不再有画布端口（源片由
# 面板「引用上次片段 / 手填路径」写入控件，或由 H3 供值），前端面板要画哪条
# 片，只能从执行侧取——这里是唯一可信的记录点，路由 /last_source 读的就是它。
# 必须挂在模块上：面板路由 getattr(模块, "LAST_SOURCE")，挂类上永远取不到。
LAST_SOURCE = {"value": ""}


try:
    import folder_paths
except Exception:  # pragma: no cover
    folder_paths = None

try:
    import av
except Exception:  # pragma: no cover
    av = None


# 拼接方式。选项值、控件名、提示一律中文，与导演台 / 媒体架面板同一语言——
# 本节点曾经是全插件里唯一把英文标识符（early_cut / overlap_frames /
# match_levels …）直接摆在画布上的节点，用户要在英文控件名与 tooltip 里的
# 中文解释之间来回对照才能操作。语言统一的标准就是本文件这段常量。
SEAM_MODES = ["提前切", "S 渐变切", "硬切"]

# 旧工程写的是英文标识符（MiniMax-H3.json 里就存着 'early_cut'）。选项值换成
# 中文之后，那些工程一加载就会是一个不在 SEAM_MODES 里的值——前端会把它显示成
# 空白，后端因为比对的是中文字面量，会静默落进「既不是硬切也不是提前切」的
# 分支。所以别名在这里收口：所有比对都先过 _seam_mode()，它把两种写法归一到
# 同一个中文值。收口点只有这一个函数，不散落判断。
_SEAM_ALIASES = {
    "early_cut": "提前切",
    "early_scurve": "S 渐变切",
    "hard_cut": "硬切",
}


def _seam_mode(value):
    """拼接方式归一化；无法识别一律「提前切」（= 接入前的默认行为）。"""
    text = "" if value is None else str(value).strip()
    if text in SEAM_MODES:
        return text
    return _SEAM_ALIASES.get(text.lower(), SEAM_MODES[0])


def _chain_mod():
    """取段落档案模块。两种加载形态都支持（插件包 / 顶层模块）。"""
    try:
        from . import csglide_chain as m            # noqa: F401  作为插件包加载
        return m
    except Exception:
        try:
            import csglide_chain as m               # noqa: F401  自检里这么跑
            return m
        except Exception:
            return None


def _current_ctx():
    """当前「片名 / 段号」，认不出就返回 (None, None)。

    Join 自己不知道这些 —— 它只看见一个源视频路径。片名与段落只能从导演台
    留下的痕迹里取（`last_name()` + `current`）。顺序是安全的：Join 依赖
    VAE Decode ← KSampler ← 导演台，导演台必然先跑完并登记过。
    """
    m = _chain_mod()
    if m is None:
        return None, None
    try:
        name = m.last_name()
        if not name:
            return None, None
        cid = (m.load_chain(name) or {}).get("current") or ""
        if not cid or m.load_clip(name, cid) is None:
            return None, None
        return name, cid
    except Exception:
        return None, None


def _film_path_for(ctx):
    """这一段该把成片写到哪。ctx 为 (None, None) 时返回空串（调用方退回根目录）。"""
    name, cid = ctx or (None, None)
    if not name or not cid:
        return ""
    m = _chain_mod()
    if m is None:
        return ""
    try:
        meta = m.load_clip(name, cid)
        # 段不存在（current 指向一个已被删掉的段）时不能照样返回归档路径 ——
        # 那会往一个谁也不会去找的孤儿位置写文件，成片就此失踪。
        if meta is None:
            return ""
        take = int(meta.get("current_take") or 1)
        return m.clip_film(name, cid, max(1, take))
    except Exception:
        return ""


def _register_film(path, frames, seam=None, score=None):
    """把刚写出的成片登记到「当前片 / 当前段」上。

    Join 本身不知道片名和段号 —— 它只看见一个源视频路径。片名与段落只能从
    导演台留下的痕迹里取（`last_name()` + `current`）。顺序是安全的：Join
    依赖 VAE Decode ← KSampler ← 导演台，导演台必然先跑完并登记过。

    `seam` 是拼接方式（"提前切" 之类），`score` 是接缝评分（`_seam_grade()`
    的产物，可能是 None）。缝记在这一段的 **左边**：Join 做的是「源片 + 续接
    段」，接出来的缝在本段与上一段之间。

    取不到就静默跳过。**登记失败绝不能影响出片** —— 成片已经在盘上了，
    缺的只是面板索引而已。
    """
    _chain = _chain_mod()
    if _chain is None:
        print("[Glide Join] 段落档案模块未就绪，本次不登记成片。")
        return None
    try:
        name, cid = _current_ctx()
        if not name:
            print("[Glide Join] 还没有登记过任何片子，本次不登记成片。")
            return None
        if not cid:
            print("[Glide Join] 片「%s」里没有当前段，本次不登记成片。" % name)
            return None
        _chain.set_film(name, cid, path, frames, seam)
        # 缝记在本段左边（本段与上一段之间）。写评分失败不影响成片登记，
        # 所以单独兜一层：少一个分数可以，丢掉整条索引不行。
        if score:
            try:
                _chain.set_seam(name, cid, "left", score.get("score"),
                                "%s · %s" % (score.get("tag"), score.get("note")))
                print("[Glide Join] 接缝评分 %s（%s）已登记到 %s / %s"
                      % (score.get("score"), score.get("tag"), name, cid))
            except Exception as e:
                print("[Glide Join] 接缝评分登记失败（不影响其余）: %s: %s"
                      % (type(e).__name__, e))
        else:
            print("[Glide Join] 成片已登记到 %s / %s（本次没算出接缝评分）"
                  % (name, cid))
        return cid
    except Exception as e:
        print("[Glide Join] 成片登记失败（不影响出片）: %s: %s"
              % (type(e).__name__, e))
        return None


FIT_SIZE = 48          # frames are averaged to this before fitting
ALIGN_SEARCH = 2       # frames either way when checking correspondence

# 成片输出的文件名前缀。走 folder_paths.get_save_image_path 的计数器口径，
# 与官方保存节点一致：每次执行落一个带新编号的文件。旧实现固定写
# BZ_join_output.mp4，画布上有两个 Join 节点、或同一节点被强制重跑时，
# 后写的会把先写的整条盖掉——下游「视频文件」拿到的就成了别人的成片。
OUT_PREFIX = "BZ_join"

# 成片音轨码率。续接一段就要把前面所有声音重新压一遍 AAC——第 1 段的音频在
# 六段成片里被压了六次。实测（20 秒真实音乐，对齐音量后按波形失真计信噪比）：
# 编码器默认的 128k 五段之后 30.7 dB，设成 320k 之后 34.9 dB。
# 便携版只有 FFmpeg 原生 AAC（没有 libfdk_aac），它把 bit_rate 当软目标，
# 32 kHz 立体声下实际约 176 kbps 就到顶；再往上到 320k 只多 1.6 dB。这里按
# 上限给，编码器能吃多少算多少，设低了才是白丢质量。
AUDIO_BITRATE = 320000

# 转 int16 前的峰值余量。AAC 编码会过冲：实测同一条音轨压一代峰值涨约 13%
# （0.767 → 0.869），而续接时读回的就是上一次编码的结果，峰值会一代代往上
# 顶。硬 clamp 到 1.0 等于把冒出来的峰削平，那正是几段之后人声发毛发破的
# 来源。先按峰值整体缩到 -1.4 dBFS 再转，clamp 只作兜底，正常不再触发。
AUDIO_HEADROOM = 0.85


# --------------------------------------------------------------------------
# source loading
# --------------------------------------------------------------------------

def _open_source(path):
    if av is None:
        raise RuntimeError("Glide Join: PyAV is required to read the source clip.")
    p = (path or "").strip().strip('"').strip("'")
    # 全路径直接用；相对路径（「引用上次片段」给的就是相对 output 的文件名）
    # 依次到 input / output 目录找，找不到才报错——和面板路由的 _resolve 同一套口径。
    if p and not os.path.isfile(p) and folder_paths is not None:
        for root in (folder_paths.get_input_directory(),
                     folder_paths.get_output_directory()):
            cand = os.path.join(root, p)
            if os.path.isfile(cand):
                p = cand
                break
    if not p or not os.path.isfile(p):
        raise FileNotFoundError(
            "Glide Join: source clip not found: %r. Wire H3 Studio's source_video "
            "output, or give a full path." % path)
    return p


def _load_audio(path):
    with av.open(path) as container:
        if not container.streams.audio:
            return None
        stream = container.streams.audio[0]
        stream.thread_type = "AUTO"
        rate = int(stream.rate or 48000)
        chunks = []
        for frame in container.decode(audio=0):
            a = frame.to_ndarray()
            if a.ndim == 1:
                a = a[None, :]
            chunks.append(a.astype(np.float32))
    if not chunks:
        return None
    wf = np.concatenate(chunks, axis=-1)
    if wf.max() > 1.5:
        wf = wf / 32768.0
    if wf.shape[0] == 1:
        wf = np.repeat(wf, 2, axis=0)
    return {"waveform": torch.from_numpy(wf)[None, :2], "sample_rate": rate}


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------

def _pool_flat(frames):
    """[N, H, W, C] -> [N, C, P] 连续：降采样后摊平，尚未转置。

    Averaging down before fitting is what makes the fit robust: a highlight the
    model moved lands in one cell instead of skewing the regression, while the
    tone relationship - the thing being measured - survives untouched.
    """
    x = frames.movedim(-1, -3)                       # [N, C, H, W]
    x = torch.nn.functional.adaptive_avg_pool2d(x, FIT_SIZE)
    # 池化结果在内存里是 channels-last，reshape 拿到的是它的视图。这里必须
    # 显式转回标准 [N, C, P] 布局：拟合的 mean(0) 沿 P 归约，求和顺序取决于
    # 布局，布局不对就会在 gain/offset 上留下 ~1e-7 级偏差。
    return x.reshape(x.shape[0], x.shape[1], -1).contiguous()


def _small_batch(frames):
    """[N, H, W, C] -> [N, P, C]，给拟合用的归约。

    批量是安全的：adaptive_avg_pool2d 逐样本独立，N 帧一次调用与逐帧调用
    归约结果逐元素相同。拟合只吃这个归约，这正是「源片尾部窗口不必整段常驻」
    的前提——全分辨率帧边解码边归约边丢。

    保留「先摊平再转置」这个次序不是风格问题：转置出来的 [P, C] 走的是
    stride (1, P)，与旧的单帧 movedim 视图完全一致，mean(0) 的求和顺序也就
    一致。若在这里补一次 .contiguous()，求和顺序会变、留下 ~1e-7 级误差，
    足以把个别像素的 8bit 四舍五入翻一格。逐帧攒 _pool_flat 再统一转置，
    得到的就是逐位相同的结果。
    """
    return _pool_flat(frames).transpose(1, 2)


def _affine_fit_small(A, B, gain_limit=2.0):
    """Per-channel (gain, offset) carrying B onto A, by least squares.

    A / B 已经是 [P, 3] 归约——拟合从头到尾不碰全分辨率，全分辨率帧因此
    没有留在内存里的理由。

    Degenerate frames - a flat plate with nothing to regress against, or two
    frames that do not actually correspond - fall back to gain 1 and a plain
    mean offset rather than dividing by nothing.
    """
    ma, mb = A.mean(0), B.mean(0)
    vb = ((B - mb) ** 2).mean(0)
    cov = ((A - ma) * (B - mb)).mean(0)
    g = torch.where(vb > 1e-8, cov / vb.clamp(min=1e-8), torch.ones_like(vb))
    g = g.clamp(1.0 / gain_limit, gain_limit)
    return g, ma - g * mb


def _fit_error_small(A, B):
    """拟合残差。入参走归约：同一帧只降一次（旧 _fit_error 会把一帧降 4 次）。"""
    g, o = _affine_fit_small(A, B)
    return float((A - (B * g + o)).abs().mean())


def _best_shift(S, E, ov):
    """Which ext frame really is src[-ov + k], within +/- ALIGN_SEARCH.

    The per-frame correction rests on ext[k] being the model's version of
    src[-ov + k]. Off by one and every frame is corrected with its neighbour's
    numbers, which reads as flicker rather than as a shift. Cheap to measure:
    fit each candidate alignment and keep the one leaving the least residual.

    S / E 是归约后的 [N, P, 3]，下标与全分辨率帧一一对应。

    返回 `(shift, err)`。err 是选中对齐下 probe 帧的平均拟合残差 —— 接缝
    评分就取它，所以这里顺手带出来，免得外面再算一遍拟合。对应关系不足
    （重叠太短）时 err 为 None：宁可没分，也不给一个看着像分数的假数。
    """
    n = min(ov, E.shape[0])
    if n < 3:
        return 0, None
    probe = [0, n // 2, n - 1]
    best, best_err = 0, None
    for s in range(-ALIGN_SEARCH, ALIGN_SEARCH + 1):
        errs = [_fit_error_small(S[-ov + k], E[k + s])
                for k in probe if 0 <= k + s < E.shape[0]]
        if not errs:
            continue
        err = sum(errs) / len(errs)
        if best_err is None or err < best_err - 1e-6:
            best, best_err = s, err
    return best, best_err


# 接缝评分的分级阈值。
#
# 量的是什么：0-1 值域下、池化到 FIT_SIZE 之后、按通道做仿射拟合的平均绝对
# 残差。它测的是「模型把上一段尾部的同一时刻重新渲染一遍，差多少」——这是
# 接缝质量的真正指标：残差小说明续接忠实延续了上一段，缝自然就顺；残差大
# 说明模型自己跑偏了，缝必然跳。
#
# 刻意**不去**直接比较接缝左右两帧的画面差：右边那帧本来就是下一时刻，正常
# 运动也会有差，量出来的是运动量不是缝。
#
# ⚠️ 阈值是经验值，**还没有真机标定过**。第一批真机数据回来后要按实测分布
# 重设。标定方法写在 caches/_seam_selftest.py 末尾。
SEAM_GRADES = [
    (0.010, "顺", "接缝几乎看不出来"),
    (0.025, "还行", "能对上，可能有轻微色偏"),
    (0.050, "看得出来", "接缝处有可察觉的跳变，可以加大重叠或换拼接方式"),
    (float("inf"), "跳", "这一段和上一段对不上，检查一下是不是接错了"),
]


def _seam_grade(err):
    """残差 → 面板能直接显示的东西。err 为 None 就返回 None（没分，不造假数）。"""
    if err is None:
        return None
    err = float(err)
    for top, tag, note in SEAM_GRADES:
        if err < top:
            return {"score": round(err, 6), "tag": tag, "note": note}
    return {"score": round(err, 6), "tag": "跳", "note": SEAM_GRADES[-1][2]}


def _tracked_affine(S, E, ov, total):
    """Per-frame gain and offset across the overlap, held constant after it.

    ext[k] and src[-ov + k] are the same instant rendered twice, so for the
    length of the overlap there is ground truth to fit against. Past it there
    is no reference left, so the last fit is held - a fixed correction, never
    an extrapolated one.

    Inside the overlap the continuation ends up reproducing the source's own
    exposure, including any breathing in it. That is correct: it IS that
    moment, and the source is what the film shows either side of it.

    S / E 是归约后的 [N, P, 3]。E 只需覆盖 [0, ov + ALIGN_SEARCH)——对应
    关系最多错 ALIGN_SEARCH 帧——整段 ext 不必再降一遍。total 是续接片段的
    完整帧数：增益/偏移要一直铺到最后一帧。

    返回 `(gains, offs, shift, err)`，err 是从 `_best_shift` 带出来的接缝残差。
    """
    n = min(ov, E.shape[0])
    shift, err = _best_shift(S, E, ov)
    gains = torch.ones(total, 3, dtype=E.dtype)
    offs = torch.zeros(total, 3, dtype=E.dtype)

    done = []
    for k in range(n):
        j = k + shift
        if 0 <= j < E.shape[0]:
            # the fit belongs to the frame it was measured ON, not to the
            # source frame's index - backwards applies every correction one
            # frame out, which is the flicker it exists to remove
            gains[j], offs[j] = _affine_fit_small(S[-ov + k], E[j])
            done.append(j)

    if not done:
        return None, None, shift, err
    lo, hi = done[0], done[-1]
    for i in range(0, lo):
        gains[i], offs[i] = gains[lo], offs[lo]
    for i in range(hi + 1, total):
        gains[i], offs[i] = gains[hi], offs[hi]
    return gains, offs, shift, err


def _scurve(n):
    """Weights 0..1 for the continuation's side of a ramped join.

    tanh k=4: soft at both ends, crosses 50/50 fast, so it spends about two
    frames in the 30-70% ghost zone instead of four. Ramps a velocity
    difference rather than stepping it.
    """
    if n <= 1:
        return torch.ones(max(1, n))
    t = torch.linspace(0.0, 1.0, n)
    w = torch.tanh(4.0 * (t - 0.5))
    return (w - float(w[0])) / (float(w[-1]) - float(w[0]))


class CSGlideJoin:

    @classmethod
    def INPUT_TYPES(cls):
        # 控件中文名走 options 里的 "label"。这是 V1 节点唯一可行的途径：
        # 前端槽位显示名的优先级链是 label ?? localized_name ?? name
        # （comfyui_frontend_package 的 SlotBase.renderingLabel），而官方那套
        # nodeDefs.<类名>.inputs.<id>.name 语言包是编译期静态打进前端包的
        # （messages = buildLocale(...)），第三方插件无从注入。V1 的
        # INPUT_TYPES 又是由 server.py 原样透传给前端、不过 schema 层，所以
        # V3 API 那个 display_name 在这里不会被读到——只有 label 生效。
        return {
            "required": {
                "source_video": ("STRING", {
                    "default": "",
                    "label": "源视频",
                    "tooltip": "本片段所承接的上一个片段。接上导演台的「源视频」输出，"
                               "或直接填文件完整路径。"}),
                "images": ("IMAGE", {
                    "label": "续接片段",
                    "tooltip": "续接片段解码后的未裁剪帧——对齐的头部仍应保留在帧上。"}),
            },
            # 槽位在画布上的顺序就是这里的定义顺序：音频在前、重叠帧在后——
            # 「重叠帧」端口排在「音频」下面。拼接方式等其余参数只作值载体
            # （前端折叠隐藏、由剪辑面板的设置行代管），不再摆上画布。
            "optional": {
                "audio": ("AUDIO", {
                    "label": "音频",
                    "tooltip": "续接片段的未裁剪音频。按画面裁剪后追加到源片段的音轨。"}),
                "overlap_frames": ("INT", {
                    "default": 22, "min": 0, "max": 4096,
                    "label": "重叠帧数",
                    "tooltip": "从源片段对齐出来的帧数。接上导演台的「重叠帧」输出，"
                               "确保与实际对齐帧数始终一致。"}),
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001,
                    "label": "帧率",
                    "tooltip": "必须与源片段的帧率一致，「对齐音频尾部」才能正确裁剪音频。"}),
                "match_tail": ("BOOLEAN", {
                    "default": True,
                    "label": "对齐音频尾部",
                    "tooltip": "把音频裁剪为恰好 帧数/帧率。H3 会把音频网格向上取整，"
                               "所以每个片段都比画面多约 8ms 声音，每次续接都会累积。"}),
                "seam_mode": (SEAM_MODES, {
                    "default": SEAM_MODES[0],
                    "label": "拼接方式",
                    "tooltip": "提前切：保留续接片段的重叠并按源片段着色——一条连续的"
                               "模型轨迹，运动衔接更好。S 渐变切：同样的拼接但跨几帧"
                               "渐变，用于速度变化可见的情况。硬切：改用源片段自身帧，"
                               "丢弃重新渲染的头部。"}),
                "seam_blend_frames": ("INT", {
                    "default": 6, "min": 1, "max": 64,
                    "label": "渐变帧数",
                    "tooltip": "「S 渐变切」的渐变帧数。其他方式忽略。"}),
                "match_levels": ("BOOLEAN", {
                    "default": True,
                    "label": "对齐亮度",
                    "tooltip": "逐帧把续接片段的亮度增益与偏移对齐到源片段，跨越重叠区"
                               "并在其后保持。会先检查帧对应关系，偏移时报告。"}),
            },
        }

    # 输出端口顺序：图像 → 成片文件 → 音频
    RETURN_TYPES = ("IMAGE", "VIDEO", "AUDIO")
    RETURN_NAMES = ("🖼️ 图像", "🎬 成片文件", "🎵 音频")
    FUNCTION = "join"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = ("将续接片段接到它承接的片段上，把重新渲染的重叠区"
                   "匹配回原片段的颜色。")

    # ---------------- sound ----------------

    @staticmethod
    def _resample(wf, sr_from, sr_to):
        """Linear-interpolation resample of a [ch, n] waveform.

        拼接只要求两段波形长度口径一致，线性插值的音质代价对环境声/音效完全
        可接受，好过整轮生成直接失败。"""
        if sr_from == sr_to or wf.numel() == 0:
            return wf
        n = max(1, int(round(wf.shape[-1] * sr_to / sr_from)))
        return torch.nn.functional.interpolate(
            wf[None], size=n, mode="linear", align_corners=False)[0]

    def _join_audio(self, src_audio, ext_audio, cut_frames, ext_skip_frames,
                    total_frames, fps, match_tail):
        if src_audio is None and ext_audio is None:
            return None

        rate = int((src_audio or ext_audio)["sample_rate"])

        def wave(a):
            if a is None:
                return None
            wf = a["waveform"]
            wf = wf[0] if wf.dim() == 3 else wf
            sr = int(a["sample_rate"])
            if sr != rate:
                # 采样率不一致不再直接报错：重采样到源片的采样率。
                print("[Glide Join] resampling audio %d Hz -> %d Hz" % (sr, rate))
                wf = self._resample(wf, sr, rate)
            return wf

        head, tail = wave(src_audio), wave(ext_audio)
        parts = []

        if head is not None:
            cut = int(round(cut_frames / fps * rate))
            if cut > head.shape[-1]:
                head = torch.cat(
                    [head, torch.zeros(head.shape[0], cut - head.shape[-1],
                                       dtype=head.dtype)], dim=-1)
            parts.append(head[..., :cut])

        if tail is not None:
            # whatever picture came off the continuation's head comes off its
            # sound too, or the track runs a full overlap long and match_tail
            # then cuts that from the END - doubling sound at the join and
            # losing the same span from the finish
            skip = int(round(max(0, ext_skip_frames) / fps * rate))
            if skip < tail.shape[-1]:
                parts.append(tail[..., skip:] if skip else tail)

        if not parts:
            return None
        if len(parts) == 2 and parts[0].shape[0] != parts[1].shape[0]:
            ch = min(parts[0].shape[0], parts[1].shape[0])
            parts = [p[:ch] for p in parts]
        wf = torch.cat(parts, dim=-1)

        if match_tail:
            want = int(round(total_frames / fps * rate))
            have = int(wf.shape[-1])
            if have > want:
                print("[Glide Join] tail trimmed %d samples (%.2f ms)"
                      % (have - want, (have - want) / rate * 1000.0))
                wf = wf[..., :want]
            elif have < want:
                wf = torch.cat(
                    [wf, torch.zeros(wf.shape[0], want - have, dtype=wf.dtype)],
                    dim=-1)

        return {"waveform": wf[None], "sample_rate": rate}

    # ---------------- streamed render ----------------

    @staticmethod
    def _mux_video(out_vs, out_cont, rgb, idx):
        frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
        frame.pts = idx
        for pkt in out_vs.encode(frame):
            out_cont.mux(pkt)

    @staticmethod
    def _mux_audio(out_cont, out_as, audio_out):
        wf = audio_out["waveform"]
        x = wf[0] if wf.dim() == 3 else wf
        ch = x.shape[0]
        sr = int(audio_out["sample_rate"])
        # 留余量而不是硬切：见 AUDIO_HEADROOM。缩的是整条音轨的增益，不是
        # 逐样本削平，所以波形形状、动态一点不变，只是整体低了不到 1.5 dB。
        peak = float(x.abs().max()) if x.numel() else 0.0
        if peak > AUDIO_HEADROOM:
            x = x * (AUDIO_HEADROOM / peak)
        x = (x.clamp(-1.0, 1.0) * 32767.0).to(torch.int16).numpy()
        inter = np.ascontiguousarray(x.T)          # [n, ch]
        frame_size = 1024
        pts = 0
        for off in range(0, inter.shape[0], frame_size):
            chunk = inter[off:off + frame_size]
            if chunk.shape[0] < frame_size:
                pad = np.zeros((frame_size - chunk.shape[0], ch), dtype=np.int16)
                chunk = np.vstack([chunk, pad])
            # packed（交织）单行：[1, ch * frame_size]
            packed = np.ascontiguousarray(chunk.T).reshape(1, -1)
            af = av.AudioFrame.from_ndarray(packed, format="s16", layout=out_as.layout)
            af.sample_rate = sr
            af.pts = pts
            pts += frame_size
            for pkt in out_as.encode(af):
                out_cont.mux(pkt)
        for pkt in out_as.encode(None):
            out_cont.mux(pkt)

    @staticmethod
    def _chain_ctx():
        """当前「片名 / 段号」——写盘选落点与登记成片用的是同一份，避免两处各
        查一次、查到不同结果（比如登记时段已经被人切走了）。"""
        return _current_ctx()

    def _render_join_to_file(self, src_path, ext, ov, mode, blend, match,
                             audio, fps, match_tail):
        """续接成片直写：边读源片边写盘，返回成片路径。

        旧实现把源片整条解码成 float32、再 cat 出整条 float32——内存随片长
        线性涨，段一多必爆。这里改成流式：源片逐帧解码逐帧写，只有尾部重叠
        窗口留在内存里给亮度匹配当参考，新段写完即成片。峰值恒定，与片长无关。
        """
        with av.open(src_path) as probe:
            pvs = probe.streams.video[0]
            W, H = pvs.width, pvs.height
            src_len = pvs.frames or 0

        # 尺寸不一致：续接帧适配到源片画布（成片锚定源片尺寸）
        if ext.shape[1] != H or ext.shape[2] != W:
            print("[Glide Join] continuation is %dx%d, rescaling to source %dx%d"
                  % (ext.shape[2], ext.shape[1], W, H))
            ext = torch.nn.functional.interpolate(
                ext.permute(0, 3, 1, 2), size=(H, W), mode="bilinear",
                align_corners=False).permute(0, 2, 3, 1).clamp(0.0, 1.0)

        # 打开源片；帧数拿不到就先数一遍（只计数，不占内存）
        in_cont = av.open(src_path)
        in_vs = in_cont.streams.video[0]
        in_vs.thread_type = "AUTO"
        if not src_len:
            src_len = sum(1 for _ in in_cont.decode(video=0))
            in_cont.close()
            in_cont = av.open(src_path)
            in_vs = in_cont.streams.video[0]
            in_vs.thread_type = "AUTO"

        if ov > src_len:
            raise ValueError("Glide Join: overlap is %d frames but the source only "
                             "has %d." % (ov, src_len))
        if ov >= ext.shape[0]:
            raise ValueError("Glide Join: overlap is %d frames but the continuation "
                             "only has %d. Are these frames already trimmed?"
                             % (ov, ext.shape[0]))

        # 成片总帧数：音频据此对齐尾部（硬切丢新段头部 ov 帧，其余丢源片尾部 ov 帧）
        if mode == "硬切":
            total_frames = src_len + max(0, ext.shape[0] - ov)
            cut_frames, ext_skip = src_len, ov
        else:
            total_frames = (src_len - ov) + ext.shape[0]
            cut_frames, ext_skip = src_len - ov, 0
        out_audio = self._join_audio(_load_audio(src_path), audio,
                                     cut_frames, ext_skip, total_frames,
                                     float(fps), bool(match_tail))

        # 成片落点：能认出「哪一片 / 哪一段」就归档进段落档案目录，跟潜空间
        # 待在一起；认不出（没接导演台、或这段还没登记）才退回 output 根目录
        # 的计数器命名，保证单独用 Join 也照样出片。
        out_path = _film_path_for(self._chain_ctx())
        if not out_path:
            out_dir = folder_paths.get_output_directory()
            # 计数器式文件名（见 OUT_PREFIX）：每次执行一个新编号，不覆盖旧成片
            out_folder, out_base, out_count, _, _ = folder_paths.get_save_image_path(
                OUT_PREFIX, out_dir)
            out_path = os.path.join(out_folder, "%s_%05d_.mp4" % (out_base, out_count))
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        out_cont = av.open(out_path, "w")
        out_vs = out_cont.add_stream("libx264", rate=Fraction(fps).limit_denominator())
        out_vs.width, out_vs.height = W, H
        out_vs.pix_fmt = "yuv420p"
        out_vs.options = {"crf": "18", "preset": "fast"}
        out_as = None
        if out_audio is not None:
            ch = out_audio["waveform"].shape[1] if out_audio["waveform"].dim() == 3 else 2
            out_as = out_cont.add_stream("aac", rate=int(out_audio["sample_rate"]))
            out_as.layout = "stereo" if ch == 2 else "mono"
            out_as.bit_rate = AUDIO_BITRATE

        # 逐帧解码源片：前部直接写；尾部窗口只留「拟合用的归约」和「渐变真正
        # 会混进成片的那几帧」，其余解完即弃。
        #
        # 旧实现把整个尾部窗口以 float32 常驻：np.stack → astype(float32) →
        # /255 是三次全量拷贝，ov=22 @1080p 时瞬时约 1.2GB。而拟合只需要
        # 48×48 归约（约 27KB/帧），S 渐变切只用到前 n 帧——为它们留住整段
        # 全分辨率没有任何道理。
        head_len = src_len if mode == "硬切" else src_len - ov
        tail_start = src_len - ov
        # 只有 S 渐变切把源片尾部帧混进成片；其余两种一张全分辨率都不需要
        keep_full = (min(max(1, int(blend)), ov, ext.shape[0])
                     if mode == "S 渐变切" else 0)
        tail_small = []   # 每帧一条归约，27KB/帧
        tail_full = []    # 只留前 keep_full 帧的 uint8，混合前才转 float32
        vframe = 0
        for idx, frame in enumerate(in_cont.decode(video=0)):
            arr = frame.to_ndarray(format="rgb24")
            if idx < head_len:
                self._mux_video(out_vs, out_cont, arr, vframe)
                vframe += 1
            if idx >= tail_start:
                # 转成 float32 只为归约这一次，用完即弃（每帧约 25MB 瞬时）
                f32 = arr.astype(np.float32)
                np.divide(f32, 255.0, out=f32)
                tail_small.append(_pool_flat(torch.from_numpy(f32).unsqueeze(0))[0])
                if idx - tail_start < keep_full:
                    tail_full.append(arr)
                del f32
        in_cont.close()

        # 攒齐再统一转置：这样每帧归约的内存布局与旧的单帧 movedim 视图一致，
        # 求和顺序一致 → 拟合结果逐位相同（而不是只差 1e-7）
        S = torch.stack(tail_small, 0).transpose(1, 2) if tail_small else None
        tail_full_t = None
        if tail_full:
            tail_full_t = torch.from_numpy(
                np.stack(tail_full).astype(np.float32) / 255.0)

        # 归约好的新段头部：亮度匹配与接缝评分吃同一份，只降一次
        E = None
        if S is not None and S.shape[0] > 0 and ov > 0:
            # E 只需覆盖到 ov + ALIGN_SEARCH：对应关系最多错这么多帧
            E = _small_batch(ext[:min(ext.shape[0], ov + ALIGN_SEARCH)])

        # 接缝评分与 match 开关无关：关掉亮度匹配时量到的是「不校正有多差」，
        # 同样是用户想知道的。三种拼接方式都从同一个残差来，口径一致。
        seam = _seam_grade(_best_shift(S, E, ov)[1]) if E is not None else None

        # 亮度匹配：只用尾部 ov 帧的归约当参考，对新段逐帧校正
        if match and S is not None and S.shape[0] > 0:
            if mode == "硬切":
                j = ov - 1 if ov > 0 else ext.shape[0] - 1
                g, o = _affine_fit_small(S[-1],
                                         _small_batch(ext[j:j + 1])[0])
                ext = (ext * g + o).clamp(0.0, 1.0)
            else:
                gains, offs, shift, _ = _tracked_affine(S, E, ov, ext.shape[0])
                if shift:
                    print("[Glide Join] frame correspondence was off by %+d - corrected." % shift)
                if gains is not None:
                    ext = (ext * gains.view(-1, 1, 1, 3)
                           + offs.view(-1, 1, 1, 3)).clamp(0.0, 1.0)

        # 组装要写出的新段帧序列
        if mode == "硬切":
            ext_out = ext[ov:]
        elif mode == "提前切":
            ext_out = ext
        else:  # S 渐变切
            have = tail_full_t.shape[0] if tail_full_t is not None else 0
            n = min(max(1, int(blend)), ov, ext.shape[0], have)
            if n <= 0:
                ext_out = ext
            else:
                w = _scurve(n).view(-1, 1, 1, 1).to(ext.dtype)
                mixed = tail_full_t[:n] * (1.0 - w) + ext[:n] * w
                ext_out = torch.cat([mixed, ext[n:]], dim=0)

        for i in range(ext_out.shape[0]):
            arr = (ext_out[i] * 255.0).clamp(0, 255).round().byte().numpy()
            self._mux_video(out_vs, out_cont, arr, vframe)
            vframe += 1

        for pkt in out_vs.encode(None):
            out_cont.mux(pkt)

        if out_as is not None:
            self._mux_audio(out_cont, out_as, out_audio)
        out_cont.close()

        print("[Glide Join] %s: %d + %d frames, overlap %d -> %d frames (%.3fs), streamed to %s"
              % (mode, src_len, ext.shape[0], ov, total_frames,
                 total_frames / float(fps), out_path))
        _register_film(out_path, total_frames, mode, seam)
        return out_path

    # ---------------- main ----------------

    def join(self, source_video, images, overlap_frames, seam_mode,
             seam_blend_frames, match_levels, audio=None, fps=24.0, match_tail=True):
        # 归一化只做一次，这之后的每一处比对都拿这个值。硬切与其他方式的差别
        # 不只是画面裁剪点，还牵连音频裁在哪里（见下方 cut_frames/ext_skip），
        # 所以两处必须看到同一个判定结果。
        seam_mode = _seam_mode(seam_mode)
        LAST_SOURCE["value"] = (source_video or "").strip()
        # No source clip means this is not a continuation at all - the CONTINUE
        # FROM slot is empty, so H3 Studio sends "" and 0 - and the graph is
        # making an ordinary clip. Pass the frames straight through instead of
        # failing, so ONE workflow does both jobs and nothing has to be rewired
        # or bypassed between a normal generation and a chained one.
        if not (source_video or "").strip():
            print("[Glide Join] no source clip - passing %d frames through "
                  "unchanged (not a continuation)" % images.shape[0])
            return (images, None, audio)

        path = _open_source(source_video)
        ov = max(0, int(overlap_frames))

        # 续接：边读边写直接落盘成片，返回文件路径给视频合并的「视频文件」
        # 输入收养。内存峰值恒定，与片长无关。
        out_path = self._render_join_to_file(
            path, images, ov, seam_mode, int(seam_blend_frames),
            bool(match_levels), audio, float(fps), bool(match_tail))
        return (None, out_path, None)

    @classmethod
    def IS_CHANGED(cls, source_video, **kwargs):
        try:
            p = _open_source(source_video)
            return "%s:%d" % (p, os.stat(p).st_mtime_ns)
        except Exception:
            return ""


NODE_CLASS_MAPPINGS = {"CSGlideJoinCS": CSGlideJoin}
NODE_DISPLAY_NAME_MAPPINGS = {"CSGlideJoinCS": "🔗 H3 续接合成 (H3 Join)"}
