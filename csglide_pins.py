# -*- coding: utf-8 -*-
"""承接窗口（pins）的算术核 —— 四种接法，一套算术。

20261108：导演台「接缝接法 → 特殊接法」折叠区（往后接 / 往前接 / 补桥 /
循环）连同它们的 UI 与写入口已删除，接法只剩「自动接续」。本模块保留下来
只作**老档案兼容**：新工程 pins 恒为空，走 csglide_chain.head_parent 的段序
回退，不会进这份算术；老档案 / 外部工具写入的 pins 仍按下面的规则解释。

为什么要有这个模块
------------------
导演台原来的潜空间续写只能「往后接」：钉住上一段的尾巴，钉在本段的开头，
渲染完把开头那截剪掉。这是 `_continuation_latent` 里写死的一条路
（`prev_clip_id = order[k-1]` + `_MC_Node().apply(context_length=n)`）。

用户要的另外三种接法其实不是新算术，只是**把钉子放在别的地方**：

    往后接   新片头部 ← 上一段的尾巴      （已实现，唯一的一条路）
    往前接   新片尾部 ← 后一段的头        （钉子挪到尾部）
    补  桥   头部 ← A 的尾，尾部 ← B 的头  （两根钉子）
    无缝循环 头部 ← 最后一段的尾，
             尾部 ← 第一段的头            （补桥的一种，源片换了而已）

关键事实（已验证，不是猜的）：

1. 条件的每个钉帧块带 `resolved_frame_index`，它是**像素帧下标**，ComfyUI
   原样接受任意值（含小数与负数）—— `_h3mc/layout_contract.py` 的第 3 项
   检查就是在测小数负下标。所以「钉在任意位置」不需要重写采样算术。
2. 钉在头部时源片取**尾巴**（源片的内容必须**结束**在接缝上）；
   钉在尾部时源片取**头**（源片的内容必须**开始**在接缝上）。
   这一条把四种接法统一了，`at` 决定取源片的哪一头。
3. 尾钉能落在网格上：片长是 5g+2 步，窗口是 5m+2 步，两者之差 ≡ 0 (mod 5)，
   所以 `frame_count - n` 一定是目标自己的一个整步起点，且相位为 0，
   与切出来的窗口相位一致。`tail_base()` 把这个不变量变成断言，
   不成立就报错，绝不静默渲染一个错位的接缝。

依赖：`_h3mc` 的张量切片与音频窗口。栅格常量在这里也写了一份，是为了让
纯算术部分（plan / tail_base / snap）能在没有 torch 的环境里单测；
`check_grid_agrees()` 在有 `_h3mc` 时校对两份常量，不一致立刻炸。
"""

import os

# ---------------------------------------------------------------- 栅格

# 与 _h3mc/nodes.py 同一组数。H3 视频 VAE 的步长是 1,4,4,4,4 循环，
# 所以只有这些帧数是整步：1 帧不是（最后一步跨 4 帧），5/22/39/56 是。
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
FPS = 24
FRAME_RESCALE = 5.0 / 3.0          # 音频 40Hz / 画面 24fps
AUDIO_HZ = 40.0

# 可钉的窗口（整步且实用）。124 及以上的点也能用，但那已经不是「窗口」
# 而是「半条片子」，钉上去等于让模型照抄，所以不提供。
PIN_GRID = (5, 22, 39, 56)


def _h3mc_nodes():
    """取 _h3mc/nodes 模块。两种导入方式都试：包内相对导入，以及自检里把插件
    目录直接放进 sys.path 后的绝对导入。"""
    try:
        from ._h3mc import nodes as _n
        return _n
    except Exception:
        pass
    try:
        from _h3mc import nodes as _n
        return _n
    except Exception:
        return None


def check_grid_agrees():
    """校对这里与 _h3mc 的常量。栅格一改就必须同步，静默漂移会让接缝错位。"""
    _n = _h3mc_nodes()
    if _n is None:
        return None
    _PT, _G, _F, _R, _A = (_n.FRAME_PER_TOKEN, _n.VIDEO_RUN_GRID,
                           _n.FPS, _n.FRAME_RESCALE, _n.AUDIO_HZ)
    bad = []
    if tuple(_PT) != FRAME_PER_TOKEN:
        bad.append("FRAME_PER_TOKEN %s != %s" % (_PT, FRAME_PER_TOKEN))
    if int(_F) != FPS:
        bad.append("FPS %s != %s" % (_F, FPS))
    if abs(float(_R) - FRAME_RESCALE) > 1e-9:
        bad.append("FRAME_RESCALE %s != %s" % (_R, FRAME_RESCALE))
    if abs(float(_A) - AUDIO_HZ) > 1e-9:
        bad.append("AUDIO_HZ %s != %s" % (_A, AUDIO_HZ))
    for g in PIN_GRID:
        if g not in _G:
            bad.append("窗口 %d 不在 _h3mc 的 VIDEO_RUN_GRID %s 里" % (g, _G))
    if bad:
        raise RuntimeError("csglide_pins 与 _h3mc 的栅格不一致：%s" % "；".join(bad))
    return True


def pixel_frames(t):
    """t 个潜空间步覆盖多少像素帧。"""
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(int(t)))


def step_offsets(t):
    """每个潜空间步起始于第几像素帧。"""
    out, acc = [], 0
    for k in range(int(t)):
        out.append(acc)
        acc += FRAME_PER_TOKEN[k % 5]
    return out


def steps_for_frames(n):
    """正好覆盖 n 帧需要几步；覆盖不了（不在栅格上）返回 None。"""
    k, covered = 0, 0
    while covered < int(n):
        covered += FRAME_PER_TOKEN[k % 5]
        k += 1
    return k if covered == int(n) else None


def snap(n, grid=PIN_GRID):
    """把窗口向下吸附到栅格。向下而不是最近：钉住的内容要**整步**，
    多出来的零头会让窗口末端停在错的时刻。"""
    n = int(n or 0)
    good = [g for g in grid if g <= n]
    return max(good) if good else 0


# ---------------------------------------------------------------- 放置（纯算术）

def tail_base(frame_count, n):
    """尾钉的起始帧。放不下（相位对不上 / 窗口比片子还长）返回 None。

    片长 T 步 → frame_count = pixel_frames(T)；窗口 m 步 → n = pixel_frames(m)。
    两者都是 5x+2 步，差是 5 的倍数步，故 base = pixel_frames(5k)，
    相位为 0，与切出来的窗口（从 0 号步起）相位一致。
    """
    base = int(frame_count) - int(n)
    if base < 0:
        return None
    k = steps_for_frames(base)
    if k is None or k % 5 != 0:
        return None
    return base


def plan(at, n, frame_count, latent_t):
    """一根钉子放在哪。纯算术，返回 dict 或抛 ValueError。

    at='head' → 钉在本片开头，源片取尾巴；at='tail' → 钉在末尾，源片取头。
    """
    if at not in ("head", "tail"):
        raise ValueError("pins: at 只能是 head 或 tail，收到 %r" % (at,))
    n = snap(n)
    if n <= 0:
        raise ValueError("pins: 窗口 %s 帧吸附后为空，最小是 %d 帧"
                         % (n, min(PIN_GRID)))
    steps = steps_for_frames(n)
    if steps is None:
        raise ValueError("pins: %d 帧不是整步，不能从潜空间切（可用 %s）"
                         % (n, "/".join(str(g) for g in PIN_GRID)))
    frame_count = int(frame_count)
    if n >= frame_count:
        raise ValueError("pins: 要钉 %d 帧进一条 %d 帧的片子——钉住的窗口"
                         "只能是时间轴的一小段" % (n, frame_count))
    if at == "head":
        base = 0
    else:
        base = tail_base(frame_count, n)
        if base is None:
            raise ValueError(
                "pins: 尾钉 %d 帧落在 %d 帧的片子上会错开潜空间步的相位"
                "（片长 %d 步）。把片长改成 17g+5 帧，或换一个窗口（%s）。"
                % (n, frame_count, int(latent_t),
                   "/".join(str(g) for g in PIN_GRID)))
    return {
        "at": at, "window": n, "steps": steps,
        "offsets": step_offsets(steps), "covered": pixel_frames(steps),
        "base": base, "src_end": "tail" if at == "head" else "head",
    }


def plan_all(pins, frame_count, latent_t):
    """多根钉子一起排。桥接时两根不能撞上。返回 (plans, head_trim, tail_trim)。"""
    plans = [plan(p.get("at"), p.get("window"), frame_count, latent_t)
             for p in pins]
    heads = [p for p in plans if p["at"] == "head"]
    tails = [p for p in plans if p["at"] == "tail"]
    if len(heads) > 1 or len(tails) > 1:
        raise ValueError("pins: 一头最多一根钉子（收到 %d 头 %d 尾）"
                         % (len(heads), len(tails)))
    head_trim = heads[0]["covered"] if heads else 0
    tail_trim = tails[0]["covered"] if tails else 0
    if head_trim + tail_trim >= frame_count:
        raise ValueError(
            "pins: 头钉 %d 帧 + 尾钉 %d 帧 ≥ 片长 %d 帧——中间没有留给模型"
            "画的了。加长这一段，或把窗口调小。" % (head_trim, tail_trim, frame_count))
    return plans, head_trim, tail_trim


# ---------------------------------------------------------------- 张量切片

def _h3():
    _n = _h3mc_nodes()
    if _n is None:
        raise RuntimeError(
            "pins: 读不到 _h3mc（Motion Context）。请查看启动日志里的报错。")
    return _n


def video_head_from_latent(latent, n):
    """切源片**头部** n 帧。与 _h3mc 的 _video_tail_from_latent 对称。

    头部切片比尾部更干净：起点恒为 0 号步，相位必然是 0，没有
    「total - steps 必须 %5==0」那个约束。
    """
    _n = _h3()
    video = _n._video_from_latent(latent)
    steps = steps_for_frames(n)
    if steps is None:
        raise ValueError("pins: %d 帧不是整步，切不出来" % n)
    total = int(video.shape[2])
    if steps > total:
        raise ValueError("pins: 要切 %d 步，源片只有 %d 步" % (steps, total))
    covered = pixel_frames(steps)
    if covered != n:
        raise RuntimeError("pins: %d 步覆盖 %d 帧，期望 %d" % (steps, covered, n))
    blocks = [video[:1, :, k:k + 1].clone() for k in range(steps)]
    return blocks, step_offsets(steps), covered


def video_from_latent_end(latent, n, end):
    """按 end（'head' 取源片头 / 'tail' 取源片尾）切 n 帧。"""
    if end == "head":
        return video_head_from_latent(latent, n)
    return _h3()._video_tail_from_latent(latent, n)


def audio_head_from_latent(latent, a_frames):
    """切源片**头部**音频。返回 (张量 [1,C,2,rt], rt)。

    没有 overhang：从头切，音频栅格与第 0 帧对齐，不像尾部那样会因为
    H3 把音频栅格四舍五入到最近步而多出/少掉三分之一。
    """
    _n = _h3()
    parts = _n._streams_from_latent(latent)
    if len(parts) < 2:
        raise ValueError("pins: 源片潜空间里没有音轨——要接 H3 采样器"
                         "输出的 AV 潜空间，不是纯视频的")
    audio = parts[1]
    if audio.ndim == 3:
        audio = audio.unsqueeze(0)
    if audio.ndim != 4:
        raise ValueError("pins: 音轨形状 %s，期望 [B,C,2,T]"
                         % (tuple(audio.shape),))
    total_t = int(audio.shape[-1])
    rt = int(round(float(a_frames) / FPS * AUDIO_HZ))
    if rt < 1:
        raise ValueError("pins: 音频窗口为空（%s 帧）" % a_frames)
    if rt > total_t:
        rt = total_t
    return audio[:1, ..., :rt].clone(), rt


def audio_from_latent_end(latent, a_frames, end):
    """按 end 切音频。尾部走 _h3mc 的（它要处理 overhang），头部走这里的。"""
    if end == "head":
        return audio_head_from_latent(latent, a_frames)[0], \
            audio_head_from_latent(latent, a_frames)[1], 0.0
    z, rt, overhang = _h3()._audio_tail_from_latent(latent, a_frames)
    return z, rt, overhang


# ---------------------------------------------------------------- 组装条件

def _audio_kf_index(at, pl, rt, overhang):
    """音频钉在条件里的下标（像素帧，可小数可为负）。

    头钉：窗口必须**结束**在接缝（第 covered 帧）上 →
        end = covered + overhang/FRAME_RESCALE，再吸附到目标的音频栅格；
        下标 = end - rt/FRAME_RESCALE（窗口往回铺 rt 步）。
    尾钉：窗口必须**开始**在接缝（第 base 帧）上 →
        下标 = base（从头切，没有 overhang）。
    """
    if at == "tail":
        coord = round(FRAME_RESCALE * float(pl["base"]))
        return coord / FRAME_RESCALE
    end_frame = float(pl["covered"]) + overhang / FRAME_RESCALE
    end_coord = round(FRAME_RESCALE * end_frame)
    end_frame = end_coord / FRAME_RESCALE
    return end_frame - rt / FRAME_RESCALE


def build(cond, latent, pins, frame_count, audio_frames=24, log=None):
    """把若干根钉子挂进条件。

    pins: [{"latent": <源片 AV 潜空间>, "window": 帧数, "at": "head"|"tail",
            "label": 用于日志的名字}]
    返回 (条件, 剪头帧数, 剪尾帧数)。条件已组装完毕，调用方直接替换。
    """
    def _log(*a):
        if log:
            log(*a)

    _n = _h3()
    video = _n._video_from_latent(latent)
    latent_t = int(video.shape[2])
    width = int(video.shape[4]) * 16
    height = int(video.shape[3]) * 16
    frame_count = int(frame_count)

    plans, head_trim, tail_trim = plan_all(pins, frame_count, latent_t)
    head_end = head_trim if head_trim else 0
    tail_start = frame_count - tail_trim if tail_trim else frame_count

    kfs = []
    for pl, pin in zip(plans, pins):
        src = pin.get("latent")
        if src is None:
            raise ValueError("pins: 钉子 %s 没有源片潜空间" % pin.get("label"))
        sv = _n._video_from_latent(src)
        sw, sh = int(sv.shape[4]) * 16, int(sv.shape[3]) * 16
        if (sw, sh) != (width, height):
            raise ValueError(
                "pins: 源片「%s」是 %dx%d，本段是 %dx%d。潜空间不能缩放——"
                "要么把源片按 %dx%d 重跑一次，要么改用文件档续写（走像素，"
                "允许缩放）。" % (pin.get("label") or "?", sw, sh,
                                 width, height, width, height))
        if int(sv.shape[1]) != int(video.shape[1]):
            raise ValueError(
                "pins: 源片「%s」有 %d 通道，本段有 %d——不是同一颗 H3 模型"
                "出的潜空间。" % (pin.get("label") or "?",
                                 int(sv.shape[1]), int(video.shape[1])))
        blocks, offsets, covered = video_from_latent_end(src, pl["window"],
                                                         pl["src_end"])
        for o, blk in zip(offsets, blocks):
            kfs.append({"resolved_frame_index": pl["base"] + o, "latent": blk})

        # 音频：跟着画面走，头钉取源片尾音，尾钉取源片头音。
        try:
            z, rt, overhang = audio_from_latent_end(src, audio_frames,
                                                    pl["src_end"])
        except Exception as e:
            _log("⚠ 钉子「%s」的音轨没接上（%s）——本次只钉画面"
                 % (pin.get("label") or "?", e))
            z, rt = None, 0
        if rt > 0:
            kfs.append({"resolved_frame_index": _audio_kf_index(
                pl["at"], pl, rt, overhang), "audio_latent": z})

        _log("🧷 承接窗口：%s 钉在本片%s第 %d..%d 帧（源片%s %d 帧 + %.2f 秒音轨）"
             % (pin.get("label") or "源片",
                "开头" if pl["at"] == "head" else "末尾",
                pl["base"], pl["base"] + covered - 1,
                "尾巴" if pl["src_end"] == "tail" else "开头",
                covered, rt / AUDIO_HZ))

    out = []
    dropped = []
    for emb, extra in cond:
        d = extra.copy()
        kept = []
        for kf in (d.get("minimax_keyframes") or []):
            p = kf.get("resolved_frame_index", 0)
            if p >= frame_count:
                raise ValueError(
                    "pins: 条件上已有一枚钉在第 %s 帧的锚，但本段只有 %d 帧。"
                    "条件和潜空间必须来自同一个节点。" % (p, frame_count))
            if p < head_end or (tail_trim and p >= tail_start):
                dropped.append(p)
                continue
            kept.append(dict(kf))
        d["minimax_keyframes"] = kept + kfs
        out.append([emb, d])
    if dropped:
        _log("· 承接窗口已占用 %d 枚既有锚点（第 %s 帧）——那几帧由钉住的"
             "内容决定，锚点不再参与。"
             % (len(dropped), sorted(set(dropped))))
    return out, head_trim, tail_trim


# ---------------------------------------------------------------- 找源片

def resolve_sources(name, cid, log=None, drop_head=False):
    """按档案里的 pins 把源片潜空间读出来。

    pins 形如 [{"from": 段id, "take": 版号, "window": 帧数, "at": "head"|"tail"}]。
    源片路径优先取续拍存档的归位路径（clip_cont），拿不到再退回档案里
    记的 cont_saved。返回可直接喂给 build() 的 pins（多带 latent / label）。

    drop_head=True：跳过所有头钉（左接缝断链时用 —— 头部不接续，连头钉源段
    的存档都不必去读，否则源段没渲染会在这一步无谓报错）。
    """
    from . import csglide_chain as _chain
    try:
        from .csglide_cast import _MC_Load
    except Exception:
        _MC_Load = None
    if _MC_Load is None:
        raise RuntimeError(
            "pins: _h3mc 没加载成功，读不了续拍存档。请查看启动日志。")

    pins = _chain.pins_of(name, cid) or []
    out = []
    for p in pins:
        if drop_head and str(p.get("at")) == "head":
            continue
        src_id = str(p.get("from") or "")
        # take 记 0（或没记）= 取源段**当前版**。换版本不必改 pins —— 重抽
        # 一次上一段，下一段自动跟着接新版。
        take = int(p.get("take") or 0)
        if take <= 0:
            try:
                take = max(1, int((_chain.load_clip(name, src_id) or {})
                                  .get("current_take") or 1))
            except Exception:
                take = 1
        path = ""
        try:
            cand = _chain.clip_cont(name, src_id, take)
            if cand and os.path.isfile(cand):
                path = cand
        except Exception:
            path = ""
        if not path:
            try:
                pm = _chain.load_clip(name, src_id) or {}
                tp = (pm.get("take_params") or {}).get(str(take)) or {}
                ps = str(tp.get("cont_saved") or "")
                if ps and os.path.isfile(ps):
                    path = ps
            except Exception:
                path = ""
        # 20261104：不再有「同版 .latent.safetensors」这个第二份文件可兜底。
        # 💾 续拍存档写的 .cont.safetensors 就是唯一真值，缺了就是缺了 ——
        # 静默拿别的文件顶替只会把「这一段其实没存档」藏起来。
        if not path:
            raise RuntimeError(
                "pins: 源段「%s」第 %d 版没有续拍存档——它得先跑完一次"
                "（工作流里要接「H3 续拍存档」节点），才能拿来当承接窗口。"
                % (src_id, take))
        lat = _MC_Load().load(path, 1)[0]
        out.append({
            "latent": lat,
            "window": int(p.get("window") or 22),
            "at": p.get("at") or "head",
            "label": "%s·第%d版" % (src_id, take),
        })
        if log:
            log("🧷 承接窗口源片：%s"
                % os.path.basename(path))
    return out
