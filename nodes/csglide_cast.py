"""H3 Studio — one node covering both MiniMax H3 model families.

  mode "fl2va"  -> first / last keyframes      (needs minimax_h3_fl2va_* weights)
  mode "ref2va" -> 9 images / 3 videos / 3 audio (needs minimax_h3_ref2va_* weights)

Everything the UI holds lives in the single `h3_data` JSON widget. Reference tags
are written in the prompt as @图片1 / @视频1 / @音频1 and transcribed here to
the real <Picture i> / <Video k> / <Audio j> presentation, renumbered against the
slots that are actually filled.
"""

import json
import math
import os
import re
import traceback

import numpy as np
from collections import OrderedDict, deque
import torch
from PIL import Image

import nodes
import comfy.model_management
import comfy.nested_tensor
import comfy.utils
import folder_paths
import node_helpers

# 素材定位 / 参考图读取 / 媒体架槽位合并：与 Qwen 编辑台共用同一份口径
from ..core.csglide_assets import (
    resolve_asset as _resolve_asset,
    load_image as _load_image,
    merge_rack_refs as _merge_rack_refs,
    mark_hd_upgraded as _mark_hd_upgraded,
)

class _SegBindingLost(ValueError):
    """导演台点名的段在档案里认不出（绑定断了）。

    必须穿透 _register_clip 末尾那句「登记失败…出图不受影响」的宽 except，
    把这次执行整个拦下——静默新建段就是「3 段跑完变 4 段 + 成片收不上轴」
    的根源（20261103 身份不变量：段身份只由档案签发，执行不签发）。
    """

# 潜空间续写（cont.mode == "latent"）：复用 _h3mc（Motion Context）的算术，
# 绝不复制实现——H3 布局一改只需要同步 _h3mc/ 一处。
try:
    from .._h3mc.nodes import (
        MiniMaxH3MotionContext as _MC_Node,
        MiniMaxH3MotionContextLoadLatent as _MC_Load,
        VIDEO_RUN_GRID as _MC_RUN_GRID,
        _streams_from_latent as _mc_streams,
        _video_tail_from_latent as _mc_tail_from_latent,
        _CHAIN_SLOT_FILE as _MC_SLOT_FILE,
        _under_output as _mc_under_output,
    )
except Exception:
    _MC_Node = None
    _MC_Load = None
    _MC_RUN_GRID = (124, 107, 90, 73, 56, 39, 22, 5, 1)
    _mc_streams = None
    _MC_SLOT_FILE = None
    _mc_under_output = None

try:
    import av
    from av.video.reformatter import Interpolation as _AV_INTERP
except Exception:  # pragma: no cover
    av = None
    _AV_INTERP = None

# VIDEO 成品对象（「整片」输出口）：用 comfy_api 的 VideoFromFile 包一条磁盘
# 路径，下游视频合并节点 get_stream_source() 即可拿到，不重新编码。
try:
    from comfy_api.latest import InputImpl as _InputImpl
except Exception:  # pragma: no cover
    _InputImpl = None


def _video_from_file(path):
    """把磁盘上的成片路径包成 VIDEO 对象；InputImpl 不可用或路径空时返回 None。"""
    if not path or not os.path.isfile(path) or _InputImpl is None:
        return None
    try:
        return _InputImpl.VideoFromFile(path)
    except Exception:
        return None


def _whole_film_latent(cfg, log):
    """「整片潜空间」口：把时间轴上**已归档**的段落 latent 按净长裁头拼接。

    段落枚举、剪头/尾帧数只认 csglide_chain 的 summary/_span_of（帧账唯一
    真值），这里绝不自算。导演台在采样前执行，所以本口只含**已归档**的段
    —— 首次渲染当前段时不含它；配套用法是「整片重绘」工作流（潜空间口不
    接采样器就不会重复采样）。段画布不一致或一段都没有都返回 None —— 下游
    收到 None 明确报错，好过静默出废品。

    20261104：**绝不少段**。少一段就会让后面所有段整体前移，二采出来必然
    「顺序乱 + 接缝闪」。所以档案读不出的段、没存档的段、剪裁越界的段一律
    **中止拼接并点名段号**，不再静默 continue。段落来源只有 🎬 H3 VAE 快速解码
    写的 .cont.safetensors（经 📤 段落调取读取）。

    20261111 阶段 2：**整片跟着时间轴当前选中阶段走**。读哪一份档由
    csglide_chain.current_stage(name) 单点裁决，📤 段落调取按它取 .cont /
    .s2.cont；这里不自己判阶段，只在日志和报错里点名，免得「存的是 s2、
    拼的是 s1」查不出来。s1 576×320 / s2 864×480 画布不同，禁止逐段混搭。
    """
    name = str(((cfg.get("chain") or {}).get("name")) or "").strip()
    if not name:
        return None
    from .. import csglide_chain as chain
    from .banzhang_h3_pin import _steps_covering, pin_extent_T, FRAME_PER_TOKEN
    from .csglide_clip import CSGlideClipLoadCS
    # 20261111 阶段 2：整片只认「时间轴当前选中阶段」这一个真值。
    # 📤 段落调取按它取 .cont / .s2.cont；这里绝不自己判阶段，只在日志和
    # 报错里点名 —— 否则「存的是 s2、拼的是 s1」根本查不出来。
    stage = chain.current_stage(name)
    stage_label = "一采" if stage == "s1" else "二采"
    log("【输出】「整片潜空间」口：按时间轴当前选中「%s」(%s) 取档拼接。"
        % (stage_label, stage))
    try:
        doc = chain.summary(name)
    except Exception as e:
        log("【输出】「整片潜空间」口：读工程档案失败（%s）。" % e)
        return None
    # summary() 会把读不出的段（clip_XXXX.json 丢了/写坏了）丢进 broken 并
    # **从 clips 里剔除** —— 这就是「时间轴 9 段、整片潜空间只拼 8 段」的
    # 静默少段路径。以前这里完全不看 broken，直接拼 clips，于是后面的段
    # 整体前移。现在先看 broken，有就中止。
    broken = [str(x) for x in (doc.get("broken") or [])]
    if broken:
        log("【输出】「整片潜空间」口：拼接中止 —— chain['order'] 里有 %d 段"
            "的段落档案读不出来（%s）。这些段会被 summary 从 clips 里剔除，"
            "拼出来必然少段、后面整体前移。请先修复 clip_XXXX.json。"
            % (len(broken), "、".join(broken)))
        return None
    clips = doc.get("clips") or []
    # 顺序真值只有 chain['order']：summary() 按它枚举，面板的 index 也是这个
    # 枚举的 i+1（csglide_chain.lanes），两者同源，不存在「index 与 order
    # 漂移」。把实际拼接顺序逐字写进日志，用户拿它跟轴上一一对即可定位。
    order_ids = [str(c.get("id") or "") for c in clips]
    if any(not x for x in order_ids) or len(set(order_ids)) != len(order_ids):
        log("【输出】「整片潜空间」口：拼接中止 —— chain['order'] 里有空 id "
            "或重复 id（%s）。先把工程档案顺序修好再推送。"
            % "、".join(order_ids))
        return None
    vs, as_, used, missing = [], [], [], []
    for c in clips:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        _frm, _to, trim = chain._span_of(name, cid)
        net = _to - _frm
        if net <= 0:
            missing.append("%s(净长 %d 帧，档案帧账不对)" % (cid, net))
            continue
        meta = chain.load_clip(name, cid) or {}
        take = max(1, int(meta.get("current_take") or 1))
        ref, _ri = CSGlideClipLoadCS().load(
            片名=name, 段落=cid, 版本=take,
            没有档案时="直通（不回填）", 顺序锚=-1)
        if not ref or ref.get("bz_empty") or ref.get("samples") is None:
            missing.append("%s(第 %d 版没有「%s」续拍存档 %s)"
                           % (cid, take, stage_label,
                              ".s2.cont.safetensors" if stage == "s2"
                              else ".cont.safetensors"))
            continue
        samples = ref["samples"]
        parts = (list(samples.unbind())
                 if getattr(samples, "is_nested", False) else [samples])
        v, a = parts[0], (parts[1] if len(parts) > 1 else None)
        T = int(v.shape[2])
        h, _ = _steps_covering(trim, T, from_tail=False)
        tail = max(0, int(c.get("trim_tail") or 0))
        t, _ = _steps_covering(tail, T, from_tail=True)
        if h + t >= T:
            missing.append("%s(剪头 %d 步 + 剪尾 %d 步 ≥ 本段 %d 步)"
                           % (cid, h, t, T))
            continue
        if vs and (v.shape[1], v.shape[3], v.shape[4]) != (
                vs[0].shape[1], vs[0].shape[3], vs[0].shape[4]):
            log("【输出】「整片潜空间」口：段 %s 画布与前面不一致 —— 拼接中止。"
                "整片潜空间要求全片同一画布。" % cid)
            return None
        vs.append(v[:, :, h:T - t])
        if a is not None:
            at = int(a.shape[-1])
            ah, atl = pin_extent_T(at, False, trim, tail, T)
            as_.append(a[..., ah:at - atl])
        used.append("%s(%d帧)" % (cid, net))
    # 少一段 = 后面所有段整体前移，二采出来就是「顺序乱 + 部分片段闪」。
    # 宁可整口不出，也不出一条看着能跑、其实时间轴错位的残片。
    if missing:
        log("【输出】「整片潜空间」口：拼接中止 —— %d 段不可用（%s）。"
            "其余 %d 段也不拼残片：少一段就会让后面的段整体前移。"
            "请按 chain['order'] 顺序 %s 逐段补齐续拍存档后重新推送。"
            % (len(missing), "；".join(missing), len(vs),
               " → ".join(order_ids)))
        return None
    if not vs:
        log("【输出】「整片潜空间」口：按 chain['order'] 顺序 %s 中"
            "还没有任何已归档段落 —— 先渲染段落。"
            % " → ".join(order_ids))
        return None
    video = torch.cat(vs, dim=2)
    audio = (torch.cat(as_, dim=-1) if len(as_) == len(vs) else None)
    # H3 的 VAE 因果组要求 T ≡ 2 (mod 5)。**每段各自合法不代表总长合法** ——
    # 2n mod 5 随段数变：8 段 ×107 = 856，(856-2)%5 = 4，时间分块解码直接抛错。
    # 向下对齐而不是向上补：解码器只吐 5+17*((T-2)//5) 帧，852 与 856 都落在
    # 170 组、帧数完全相同，补到 857 反而凭空多出 7 帧。
    t_raw = int(video.shape[2])
    note = ""
    if t_raw < 2:
        log("【输出】「整片潜空间」口：拼出来只有 %d 步，凑不出 17k+5 网格。" % t_raw)
        return None
    off = (t_raw - 2) % 5
    if off:
        if t_raw - off < 2:
            log("【输出】「整片潜空间」口：总长 %d 步裁掉 %d 步后不足 2 步，"
                "凑不出 17k+5 网格。" % (t_raw, off))
            return None
        keep = t_raw - off
        drop_frames = sum(FRAME_PER_TOKEN[i % 5] for i in range(keep, t_raw))
        video = video[:, :, :keep]
        if audio is not None:
            _at_T = int(audio.shape[-1])
            _, _at = pin_extent_T(_at_T, False, 0, drop_frames, t_raw)
            if _at:
                audio = audio[..., :_at_T - _at]
        note = ("；总长 %d 步不在 17k+5 网格上，末 %d 步（%d 帧）已裁 → %d 步"
                % (t_raw, off, drop_frames, keep))
    out = (comfy.nested_tensor.NestedTensor([video, audio])
           if audio is not None else video)
    log("【输出】「整片潜空间」口：按 chain['order'] 顺序 %s 拼接 %s —— "
        "共 %d 段 / %d 步%s，无缺段。"
        % (" → ".join(order_ids), "、".join(used), len(vs),
           int(video.shape[2]), note))
    return {"samples": out}


# --------------------------------------------------------------------------
# H3 constants (mirrors comfy_extras/nodes_minimax_h3.py)
# --------------------------------------------------------------------------

CANVAS_MULTIPLE = 32
BASE_SHORT_EDGE = 768
MAX_PIXELS = 768 * 1344
REF_IMAGE_MAX_LONG_EDGE = 4096    # 图片参考长边上限（视频参考不再设上限）
REF_MIN_LONG_EDGE = 32            # 参考长边下限（与画布 32 对齐一致）
# 原图档（raw）按官方 MiniMax H3 规则：参考图短边封顶 2048（官方 REF_IMAGE_SHORT_EDGE）。
# 与上面的长边上限是两套口径——raw 走官方短边，match/自定义仍走包内长边。
REF_IMAGE_SHORT_EDGE = 2048


def _fit_long(value):
    """向下对齐到 32 的倍数（下限 32）。

    向下而不是四舍五入：源素材比档位小时不该被放大，round 会把 1005 抬到 1008。
    """
    return max(CANVAS_MULTIPLE, (int(value) // CANVAS_MULTIPLE) * CANVAS_MULTIPLE)


def _round_canvas(value):
    """四舍五入对齐到 32（下限 32）——官方参考图/视频用的对齐方式。
    与 _fit_long（向下）区分：原图档按官方 round，否则会比官方少 1~31px。"""
    return max(CANVAS_MULTIPLE, round(value / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)


def _ref_size(value, cap, fallback):
    """把参考尺寸归一为 "match" 或一个整数；cap=None 时不设上限（仅保 32 下限）。

    前端已把「下拉档位」改成「数字输入 + 跟随画布」，这里同时兼容
    旧档位字符串（512/640/.../max）与纯数字两种来源，老工程不会失效。
    """
    text = "" if value is None else str(value).strip().lower()
    if text == "match":
        return "match"
    if text == "raw":
        return "raw"          # 原图档：按官方规则原样发（短边封顶），不归一成数字
    if text == "max":
        return int(cap) if cap is not None else REF_IMAGE_MAX_LONG_EDGE
    try:
        n = int(float(text))
    except (TypeError, ValueError):
        return fallback
    n = max(REF_MIN_LONG_EDGE, n)
    if cap is not None:
        n = min(int(cap), n)
    return n
FPS = 24
AUDIO_LATENT_FPS = 40

MIN_REF_FRAMES = 5          # H3 rejects a reference video shorter than this
MAX_IMAGES = 9              # 面板本地槽位（兜底用）；媒体架槽位数量动态
MAX_VIDEOS = 3
MAX_AUDIOS = 3

# 参考视频的采样帧率：24 = 不抽帧；往低调（12/8）在同一时间跨度里取更少的帧、
# 省显存，代价是参考锚定精度下降。前端 REF_FPS_MIN/REF_FPS_MAX 的镜像。
REF_FPS_MIN = 4
REF_FPS_MAX = 24

# 空输入时没有词会退化成不可控的废片；给一段中性运镜词，让默认出片可预期。
DEFAULT_SHOT_LINE = """subject_definitions:
博主像素小人：扁平像素风格男性小人，深色短发、黑框眼镜、胸前像素字"班长captain"名牌，动作逐格跳动。
导演台海报格：亮色底上的巨型像素海报版面单元，每一拍硬切重组一次，大海报像素粗体字是画面第一主体。
summary:
[reference generation] 目标视频为10秒像素波普风MV卡点快闪：亮色高对比底上，整片视频是一张不断被重排的巨型像素海报，每一拍版式硬切重组、色块翻面、博主像素小人在海报格间逐格跳动，结尾所有元素定格拼成一张完整引流封面；10个镜头、共10秒。
detailed_description:
全片为亮色像素波普风：奶白、荧光柠檬黄、正红、电光蓝、荧光粉高对比限色，偏移硬阴影与半调网点表达明暗，粗黑轮廓勾边、无渐变无抗锯齿；无摄影机，全部由海报版面硬切重组驱动，逐格跳变配块状残影；满版与极端留白交替，每次硬切同时跳换底色。
[Shot 1] 荧光柠檬黄底满版海报格A，博主像素小人居中站立，头顶巨型像素粗体"导演台"三字压场，粗黑轮廓与偏移硬阴影；小人逐格挥手，结束于居中满版构图。
[Shot 2] At 00:00.900, the camera cuts to 硬切跳色至奶白底，版面重组：巨型字"ComfyUI"横贯画面上三分之一，下方一排像素方块图标逐格翻转显形；留白占下半部，结束于上满下空的版式。
[Shot 3] At 00:01.800, the camera cuts to 硬切至正红底满版，巨型像素字"三采工作流"两行压屏，字间夹着马赛克小块飘落；博主像素小人从字缝间探头，结束于满版无留白构图。
[Shot 4] At 00:02.600, the camera cuts to 硬切回奶白底，色块翻面：电光蓝色块从左侧滑入把画面切成两半，博主像素小人逐格跳过色块边缘，块状残影拖尾；结束于对角分割构图。
[Shot 5] At 00:03.300, the camera cuts to 硬切至荧光粉底，巨型字"6G显存"居中压场，字下一台像素小主机图标逐格吞吐马赛克块；四周大面积留白，结束于居中极简版式。
[Shot 6] At 00:04.000, the camera cuts to 硬切至奶白底分屏：左半屏的模糊视频相同画面，右高清视频相同画面，中线一条正红像素箭头从左指向右；对比构图定格一拍，结束于左右对峙版式。
[Shot 7] At 00:05.200, the camera cuts to 硬切至电光蓝底，巨型字"高清视频"砸入，笔画带块状残影重影；博主像素小人在字下逐格蹦跳，像素碎屑四溅；结束于满版动态构图。
[Shot 8] At 00:06.400, the camera cuts to 硬切回奶白底，博主像素小人坐上居中的像素导演台，身后四块监视器屏幕逐格亮起，屏幕内视频正在聚合变清晰；前景台面、中景小人、背景屏幕三层平面错位，结束于导演台掌镜构图。
[Shot 9] At 00:08.000, the camera cuts to 硬切至极端留白：荧光柠檬黄底上仅一行小号像素字"原创三采工作流与导演台·从零学短剧可找我学"居中逐字打出，其余全部空白；结束于极简悬停版式。
[Shot 10] At 00:09.000, the camera cuts to 长定格封面帧：奶白底，"班长captain"巨型像素粗体居中压场，其下"三采工作流·6G也能出片"，底部正红像素条内白字"班长"；所有色块与字对齐归位，全片唯一一次长停留，结束于完整可传播的海报构图。
overall_soundscape: 每次硬切对应一记方波"咔哒"翻页音与色块碰撞声；小人的逐格动作配8-bit跳跃音，马赛克吞吐配方块摩擦短音；结尾定格处所有音效收干净，只留一声快门脆响。
non_diegetic_music: 约128BPM的8-bit电子快拍，方波主旋律配噪声镲，每个重拍对应一次版面硬切与跳色；第9镜留白段音乐抽掉打击乐只留单音旋律悬停，结尾定格收在一记重低音正拍上。"""


def _clamp_ref_fps(v):
    """参考视频采样帧率，非法/缺省一律 24。

    缺字段取 24 不只是「默认值」：它等于这个设置在接入之前后端一直用的值，
    所以老工程打开后逐帧画面不变，只有显式调低过档位的工程才会变。
    """
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return REF_FPS_MAX
    return max(REF_FPS_MIN, min(REF_FPS_MAX, n))


def _ref_hd_scale(v):
    """「放大重绘」（二采/三采共用）条件的参考档位倍数；非法值一律 1.0。

    1.0 表示跟随主档位——它同时是接入前的既有行为：不重编码、不额外计算。
    小于 1 也按 1 处理：档位只能往上加清晰度，往下不是这个开关的用法。
    """
    try:
        m = float(v)
    except (TypeError, ValueError):
        return 1.0
    return max(1.0, m)




def align_frame_count(n):
    n = max(5, int(n))
    while n % 17 != 5:
        n += 1
    return n


def video_latent_t(frame_count):
    return 2 if frame_count <= 5 else ((frame_count - 5) // 17) * 5 + 2


def temporal_shape(length):
    frame_count = align_frame_count(length)
    duration = frame_count / FPS
    return frame_count, video_latent_t(frame_count), round(duration * AUDIO_LATENT_FPS)


def driver_stream_placement(frame_count, total_grids, head_frames, slice_grids=0):
    """驱动音频在 AV latent 声音流里的**唯一坐标换算**（20261108 根因修复）。

    两个时间轴必须显式对齐，不能靠「差几格就往尾部补零」猜：
      · 采样时间轴 [0, frame_count)：
          承接头 [0, head_frames)            —— 画面逐位承上一段尾部，成片时掐掉
          净长   [head_frames, frame_count) —— 本段新画面
      · 成片时间轴 [clip_from, clip_to)：`auto_slice` 按这个净长切驱动音频。

    所以驱动音频必须落在声音流的 [head_grids, total_grids)，**不是**从第 0 格开始。
    head_frames 取自段档案 row 的 film_head / trim_frames（前端时间轴、播放落点、
    成片裁切、音频切片都读它，是项目既有的单一真值源），不在这里另算一套。

    声音流 40Hz、画面 FPS，两者线性同比例，格点用 total_grids/frame_count 换算。
    slice_grids 是驱动 wav **实际编码出来的格数**（_encode_ref_audio 返回的
    z.shape[-1]），与 body_grids 同单位、无中间字段失真，是一致性校验的唯一真值源。
    不能用 bzsa.driver 的 from/to：banzhang_audio_cut 把它直接抄自切片当时的
    clip_from/clip_to，段长一改，副本和段档案一起失真，等于自己比自己。
    只在切片**短于**净长时告警（尾部要由本段音频循环补齐，说明音源不够长）；
    超长由调用方按 body_grids 截断，属正常，不告警。slice_grids=0 = 拿不到长度，
    不校验也不误报（向后兼容）。

    返回 (head_grids, body_grids, warn)。
    """
    frames = max(1, int(frame_count))
    total = max(0, int(total_grids))
    head = max(0, min(frames - 1, int(head_frames or 0)))
    head_grids = int(round(total * head / frames))
    body_grids = max(0, total - head_grids)
    warn = ""
    if slice_grids and body_grids - int(slice_grids) > 1:
        warn = ("驱动切片只有 %d 格，比本段净长 %d 格短 %d 格；"
                "尾部按**真静音 latent** 补齐（不循环重放本段、也不会出零 latent 底噪）。"
                "多半是音源比全片短，或改过段长 / 续接帧数却没重新拖入音频 —— "
                "末段音源不够属正常，不是错误；末段画面已自动按剩余音频缩短"
                % (int(slice_grids), body_grids,
                   body_grids - int(slice_grids)))
    return head_grids, body_grids, warn


def _cyc_latent(z, count, offset=0):
    """从 z 的第 offset 格起循环取 count 格；offset 可为负（从末尾倒数）。"""
    n = int(z.shape[-1])
    if n <= 0 or count <= 0:
        return z[..., :0]
    idx = torch.arange(int(offset), int(offset) + int(count), device=z.device) % n
    return z.index_select(-1, idx)


def driver_stream_latents(z, z_prev, head_grids, body_grids, z_sil=None):
    """构造整条声音流：每一格都是有效音频 latent，绝不把零 latent 交给 VAE。

    承接头 = 上一段驱动的**末尾**（画面与声音都是上一段末尾的延续）；
    净长   = 本段驱动；
    尾部   = **真静音 latent**（20261111 起）—— 绝不循环重放本段旋律。

    20261111 二次修正（用户报「取消接续后有的段头和尾音频重复」）：承接头
    旧写法 `_cyc_latent(z_prev, head_grids, len-head_grids)` 有两个重复源 ——
      · head_grids > len(z_prev)（上一段是短末段 / 驱动缺失）时会绕回开头，
        把上一段整段旋律重放一遍；
      · 拿不到上一段驱动时调用方退化成 z_prev = z（本段自己），段头直接
        响起段尾那截音乐，单段内「头尾重复」。
    现在上一段末尾有多少取多少、绝不绕回，缺的格用真静音 latent 补在**前面**；
    连上一段都没有就整段静音。调用方也改成默认给真静音，不再退化成本段。

    零 latent 经 audio VAE 解码不是静音，是一段固定低频底噪 —— 所以不能拿
    zeros 直接填；「编码过的静音」与「零 latent」是两回事。
    """
    head = z[..., :0]
    if head_grids:
        n_prev = int(z_prev.shape[-1]) if z_prev is not None else 0
        avail = min(int(head_grids), n_prev)
        tail_of_prev = z_prev[..., -avail:] if avail else z[..., :0]
        lack = int(head_grids) - avail
        if lack > 0:
            pad_src = (z_sil if (z_sil is not None and int(z_sil.shape[-1]) > 0)
                       else z[..., -1:])
            pad = (_cyc_latent(pad_src, lack)
                   if int(pad_src.shape[-1]) > 0 else z[..., :0])
            head = torch.cat([pad, tail_of_prev], dim=-1)
        else:
            head = tail_of_prev
    n = min(int(z.shape[-1]), body_grids)
    body = z[..., :n]
    if body_grids > n:
        need = body_grids - n
        if z_sil is not None and int(z_sil.shape[-1]) > 0:
            # 静音 latent 循环多少格都还是静音，不会把旋律重放一遍。
            tail = _cyc_latent(z_sil, need)
        elif int(z.shape[-1]) > 0:
            # 兜底：末格拖尾（听感是尾音延长，不是「又唱了一遍」）。
            tail = z[..., -1:].expand(
                tuple(z.shape[:-1]) + (need,)).contiguous()
        else:
            tail = z[..., :0]
    else:
        tail = z[..., :0]
    return torch.cat([head, body, tail], dim=-1), n


def adapt_canvas(width, height):
    """768-short-edge canvas with a 768*1344 area cap, per-axis round to 32."""
    ratio = width / height
    if ratio >= 1.0:
        nom_w, nom_h = BASE_SHORT_EDGE * ratio, BASE_SHORT_EDGE
    else:
        nom_w, nom_h = BASE_SHORT_EDGE, BASE_SHORT_EDGE / ratio
    if nom_w * nom_h > MAX_PIXELS:
        s = math.sqrt(MAX_PIXELS / (nom_w * nom_h))
        nom_w, nom_h = nom_w * s, nom_h * s
    return (max(CANVAS_MULTIPLE, round(nom_w / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
            max(CANVAS_MULTIPLE, round(nom_h / CANVAS_MULTIPLE) * CANVAS_MULTIPLE))


def _resize(image, width, height, crop):
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)


def snap_guide_run(n):
    """Largest 17k+5 run not exceeding n; 0 if there is not even a minimum run.

    MiniMaxH3AddGuide does this snap itself, but it then keeps the FIRST n
    frames of what it was handed. For a continuation the run has to END at the
    previous clip's last frame, so the snap happens here and the LAST n are
    kept instead.
    """
    n = int(n)
    if n < MIN_REF_FRAMES:
        return 0
    while n % 17 != 5:
        n -= 1
    return n


def head_unlinked(cfg):
    """本段左接缝是否被标了「取消接续」（时间轴上的 unlink）。

    取消接续的语义是**这一段完全独立起头**：不承接上一段的任何尾巴、不剪头、
    不给模型喂引导帧。判据只有这一个来源 —— 接缝表 transitions。档案里的
    trim_frames 是上一次生成留下的旧账，绝不能拿来判断本次要不要接。

    历史 bug（20261029 定性）：文件档续写只问「续写来源有没有引用」，从不看
    unlink —— 用户按了「⊘ 取消接续」、也重跑了，段开头照样承接 39 帧被重绘，
    前 1.6 秒永远糊（实测清晰度只有正常帧的 1/3~1/8）。
    """
    ch = cfg.get("chain") or {}
    name = str(ch.get("name") or "")
    cid = str(ch.get("clip") or "")
    if not name or not cid:
        return False
    try:
        from .. import csglide_chain as _c
        tr = _c.transitions_of(name) or {}
        return str((tr.get(str(cid)) or {}).get("type")) == "unlink"
    except Exception:
        return False


def cont_head_frames(cfg, frame_count):
    """本次续写会钉住的头帧数（0 = 不续写）。首尾帧锚必须避开这一段。

    只算「将要钉多少帧」，不解码任何素材：潜空间档的格点是纯算术、精确；
    文件档取请求窗口的 17k+5 吸附值，源片帧数不足时实际会更短（那时首帧
    锚落在接缝之后一两帧，无害，也不会与续写块重叠）。

    为什么必须错开：续写块钉在帧 0..n-1。首帧锚若也落在 0——
      · 文件档：两个 cond 块占同一时间坐标，画面谁也不像；
      · 潜空间档：Motion Context 把「钉头内的锚」整块丢弃，首帧完全消失。
    """
    cont = cfg.get("cont")
    if not cont:
        return 0
    if head_unlinked(cfg):
        return 0                          # 取消接续 = 头部一帧都不承接
    # 承接帧数就是「要不要接」的开关：0 = 独立成段（20261029 起改为**默认**）。
    # 旧默认 22/39 让每一段一建出来就背着承接账，用户从没选过"接"却一直接。
    frames = int(cont.get("frames") or 0)
    if frames <= 0:
        return 0
    if (cont.get("mode") or "file") == "latent":
        # 潜空间档的承接档由 _continuation_latent 从上一段档案的
        # take_params[take].cont_saved 解析，从来不看 cont.latent_file。
        # 旧版把「有没有 latent_file」当成「要不要承接」，面板填了 39 却因此
        # 被判成 0 写进 trim_frames —— 导出不剪承接头，接缝重复播一截。
        # 真正没存档时由 _continuation_latent 把 trim_frames 改回 0。
        n = max((g for g in _MC_RUN_GRID if g <= frames), default=0)
    else:
        if not cont.get("file"):
            return 0
        n = snap_guide_run(frames)
    # 首帧锚必须还在片内；留一位给末帧锚，两个锚不撞同一坐标
    return max(0, min(n, max(0, frame_count - 1)))


def flatten_exposure(frames, strength=1.0):
    """Level a guide run's brightness onto its own final frame.

    Measured on real renders: the model continues from the anchor window's
    AVERAGE exposure rather than from its last frame - consistent with the run
    being encoded as one block. A window ending below its average produced a
    clip about 19% brighter; one ending above produced a clip about 17% darker,
    and the sign followed the window both times. Scaling every frame onto the
    last one removes the cause rather than correcting the result, so nothing
    accumulates down a chain of clips.

    MEAN ONLY, deliberately: per-frame std matching was tried on the LTX chunk
    assembler and made exposure worse.

    The levelled frames are conditioning only. The model renders its own
    version of this span, so nothing here reaches the finished picture.
    """
    if strength <= 0.0 or frames.shape[0] < 2:
        return frames
    lum = frames.mean(dim=(1, 2, 3))
    target = float(lum[-1])
    if target <= 1e-6:
        return frames
    gain = 1.0 + (target / lum.clamp(min=1e-6) - 1.0) * float(strength)
    return (frames * gain.view(-1, 1, 1, 1)).clamp(0.0, 1.0)


def _empty_av_latent(width, height, length, batch_size=1):
    frame_count, latent_t, audio_t = temporal_shape(length)
    video = torch.zeros([batch_size, 24, latent_t, height // 16, width // 16],
                        device=comfy.model_management.intermediate_device())
    audio = torch.zeros([batch_size, 32, 2, audio_t],
                        device=comfy.model_management.intermediate_device())
    return {"samples": comfy.nested_tensor.NestedTensor((video, audio))}, frame_count


# --------------------------------------------------------------------------
# Asset resolution + loading
# --------------------------------------------------------------------------

def _ref_target_long(size_mode, canvas_long, ref_scale=1.0):
    """参考素材的目标长边；ref_scale 是分阶段（二采/三采）的档位倍数。

    "max" 不参与放大：它是显存安全上限而不是画质档位，乘上去只会撑爆显存。
    数值档与 match（跟随画布长边）都按倍数放大；之后调用方各自的
    min(1.0, ...) 仍然保证「永不放大源素材」——源不够大时倍数不生效。
    """
    if size_mode == "max":
        return REF_IMAGE_MAX_LONG_EDGE
    if size_mode == "match":
        return float(canvas_long) * ref_scale
    return int(size_mode) * ref_scale


def _video_target_size(vw, vh, size_mode, canvas_long, ref_scale=1.0):
    """视频参考的目标分辨率：按长边像素缩放，等比且永不放大原始尺寸。

    size_mode 为 "match"（长边跟随画布）或一个正整数（不设上限，仅长边等比、
    永不放大原始尺寸）。视频多帧、成倍吃显存，数值越大占显存越高，请按需设置。
    "raw"（原图档）例外：走官方 adapt_canvas（短边 768、面积上限、round 32），
    源视频比官方目标更小则原样 round——官方对参考视频根本没有尺寸选项，固定这套。
    """
    if size_mode == "raw":
        cw, ch = adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            cw, ch = _round_canvas(vw), _round_canvas(vh)
        return cw, ch
    target = _ref_target_long(size_mode, canvas_long, ref_scale)
    scale = min(1.0, target / max(vw, vh))
    return _fit_long(vw * scale), _fit_long(vh * scale)


def _load_video_frames(ref, start, end, max_frames, scale_to_canvas=False, size_mode=None,
                       canvas_long=0, fps=FPS, ref_scale=1.0):
    """Decode [start, end) seconds and resample to `fps`. Returns [N, H, W, 3].

    `fps` 只在参考视频这一路被改成面板上的「抽帧帧率」（csglide_cast.py 的
    cfg["ref_video_fps"]）：调低它，同一时间跨度里取到的帧更少。续写引导
    必须保持 24（它按帧位取尾部，秒→帧换算只用来估范围）。

    内存有界：不再把整段解码帧一次性堆进内存再采样，而是在线做最近帧采样。
    目标采样点 (start + k/fps) 单调递增、解码帧时间也单调，因此只需一格前瞻
    窗口就能判定每一帧是否命中某采样点——一旦下一帧比当前帧更远，前帧就不会
    再被任何后续采样点选中。全程只保留最终选中的那些帧的像素。
    """
    if av is None:
        raise RuntimeError("H3 Studio: PyAV is required to read reference videos.")
    path = _resolve_asset(ref)
    if path is None:
        raise FileNotFoundError("H3 Studio: video not found on disk: %s" % ref)

    slack = 0.75                      # seconds decoded past the out point

    # 采样帧预算。有明确的 out 点时一开始就能精确算出；否则先按上限截断，
    # 解码结束后再按真实跨度修订。
    if end is not None:
        want = int(round((end - start) * fps)) + 1
        want = max(MIN_REF_FRAMES, min(want, max_frames))
    else:
        want = max_frames

    picked = []                       # 选中的帧（按采样顺序，uint8）
    first_t = None
    last_t = None
    win_t = deque()                   # 一格前瞻：(时间, rgb24 ndarray)
    win_d = deque()

    def settle(eof):
        """把当前窗口已能确定的采样点尽量结算掉。"""
        while len(picked) < want:
            if len(win_d) >= 2:
                target = start + len(picked) / fps
                if abs(win_t[1] - target) <= abs(win_t[0] - target):
                    win_t.popleft()           # 下一帧至少一样近，丢弃当前帧
                    win_d.popleft()
                    continue
                # 当前帧命中；保留它，后续采样点可能复用同一帧
                picked.append(win_d[0])
                continue
            if eof and win_d:
                picked.append(win_d[0])       # 源耗尽 — 定格最后一帧
                continue
            break

    n = 0                             # 越过 start 的帧计数，仅用于 pts 缺失时的回退
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        # 等比缩放目标在首帧解码时按实际帧宽高确定（比 stream 元数据更可靠）。
        # 关键优化：不再「解出全分辨率帧(4K) → 转 RGB → PIL Lanczos 缩小」——
        # 那三步全在 CPU、还留着一帧 4K 原始图。改在解码后立刻用 libswscale 的
        # reformat 在 C 层一步缩到目标尺寸（缩小时用 AREA=面积平均，降采样质量
        # 优于 Lanczos 且无振铃），峰值只留一帧缩后 rgb24。
        target = (0, 0)
        tb = float(stream.time_base) if stream.time_base else 1.0 / fps
        if start > 0:
            try:
                container.seek(int(max(0.0, start - 0.5) / tb), stream=stream)
            except Exception:
                pass
        for frame in container.decode(video=0):
            t = float(frame.pts * tb) if frame.pts is not None else (n / fps)
            if t < start - 1e-4:
                continue
            n += 1
            if end is not None and t > end + slack:
                break
            if first_t is None:
                first_t = t
            last_t = t
            if len(picked) < want:
                if scale_to_canvas:
                    if not target[0]:
                        target = _video_target_size(frame.width, frame.height, size_mode,
                                                    canvas_long, ref_scale)
                    # 目标尺寸与原帧一致时跳过重采样（reformat 仍要做 rgb24 转换）
                    if (frame.width, frame.height) != target:
                        frame = frame.reformat(
                            width=target[0], height=target[1], format="rgb24",
                            interpolation=_AV_INTERP.AREA,   # 面积平均，缩小时最优降采样
                        )
                        arr = np.ascontiguousarray(frame.to_ndarray())
                    else:
                        arr = np.ascontiguousarray(frame.to_ndarray(format="rgb24"))
                else:
                    arr = np.ascontiguousarray(frame.to_ndarray(format="rgb24"))
                win_d.append(arr)
                win_t.append(t)
                settle(False)
        settle(True)

    if not picked:
        raise ValueError("H3 Studio: no frames decoded from %s in that trim range." % ref)

    if end is None:
        span = (last_t - first_t) if (first_t is not None and last_t is not None) else 0.0
        want = int(round(span * fps)) + 1
        want = max(MIN_REF_FRAMES, min(want, max_frames))
        picked = picked[:want]

    if len(picked) < MIN_REF_FRAMES:  # 源确实耗尽 — 定格最后一帧补足
        picked += [picked[-1]] * (MIN_REF_FRAMES - len(picked))

    # 原地除法：`/ 255.0` 原本会再分配一份同尺寸副本，4K 多帧时峰值直接翻倍
    # （uint8 堆叠 + float32 + 除法临时 = 三份同时在内存里）。
    arr = np.stack(picked).astype(np.float32)
    arr /= 255.0
    return torch.from_numpy(arr)


def _load_video_tail(ref, n, start_hint=0.0):
    """Decode the LAST n frames of a clip, by POSITION rather than by time.

    The timestamp path samples targets at start + k/FPS, and start/end reach
    the node from the browser's video.duration - which for mkv is routinely a
    frame or more off the true last PTS. Read short, the window stops BEFORE
    the clip's final frame, and the continuation then picks up from slightly
    the wrong moment: the join reads as a small jump no colour or seam work
    can fix, because the two pieces are not adjacent in time.

    A continuation window is always the tail, so position is the honest
    measure. Only the last n frames are held, so the memory cost is the window
    and not the clip.
    """
    if av is None:
        raise RuntimeError("H3 Studio: PyAV is required to read reference videos.")
    path = _resolve_asset(ref)
    if path is None:
        raise FileNotFoundError("H3 Studio: video not found on disk: %s" % ref)

    keep = deque(maxlen=max(1, int(n)))
    total = 0
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        tb = float(stream.time_base) if stream.time_base else 1.0 / FPS
        # a clip at another frame rate would give n frames of a different
        # duration, so leave those to the timestamp path
        rate = float(stream.average_rate) if stream.average_rate else FPS
        if abs(rate - FPS) > 0.51:
            return None
        seek_to = max(0.0, float(start_hint or 0.0) - 1.0)
        if seek_to > 0:
            try:
                container.seek(int(seek_to / tb), stream=stream)
            except Exception:
                pass
        for frame in container.decode(video=0):
            keep.append(frame.to_ndarray(format="rgb24"))
            total += 1
            if total > 8192:
                break

    if not keep:
        raise ValueError("H3 Studio: no frames decoded from %s." % ref)
    arr = np.stack(list(keep)).astype(np.float32) / 255.0
    return torch.from_numpy(arr)


class _RefAudioTooShort(ValueError):
    """参考音频不足一个潜空间帧（或一个样本都没有）。

    单独成类是为了区分两种意图：视频自带音轨是「参考视频」的附属品，不可用就
    沿用既有策略按静音发（画面照常生效）；独立音频参考是用户在提示词里点名要的，
    必须硬失败，不能悄悄变成静音。
    """


# 音频解码 / 重采样：全插件共用一份（csglide_audio_io），本模块不再自带副本。
# 那里的多后端降级是「同一个文件在这台机器能读、那台不能」的根治点，别再抄一份。
from ..core.csglide_audio_io import (
    decode_audio_file,
    resample_waveform,
    stereo_channels as _stereo,
)
from ..core import csglide_audio_io as _audio_io


# 参考音频的长度上限：算法与常量都在公共层（csglide_audio_io），因为
# _h3mc 的动作上下文往同一颗音频 VAE 里送音频、会撞同一堵墙，两处必须同源。
AUDIO_VAE_MIN = _audio_io.AUDIO_VAE_MIN


def ref_audio_limit_seconds(frame_count):
    """参考音频的长度上限（秒）：目标时长与 5 秒取大、60 秒封顶。

    ⚠ 20261026：这里**不再**按显存砍。原先还有一条「显存预算一票否决」，
    撞显存时会把参考音频压到远短于片长（最狠能到 AUDIO_VAE_FLOOR 的 1 秒），
    代价是音色参考覆盖不到整段——模型在没覆盖的地方退回默认嗓音，而日志里
    那句话看起来像正常行为，用户只能得出「音色没变」。（现场就是 7.18s 的
    音色配 9.42s 片长，覆盖 76%，出了另一把嗓子。）

    现在显存紧张时改走 CPU 编码：`encode_audio_latent` 编码前按权重+激活判
    一次，放不下就撤到 CPU（实测余弦相似 0.99974，只是多花几秒），绝不缩短
    音频。理由与实测见 csglide_audio_io.audio_vae_budget_seconds 的注释。
    """
    return _audio_io.audio_vae_budget_seconds(
        float(frame_count) / FPS,
        minimum=AUDIO_VAE_MIN)


def _load_audio(ref, start, end, max_seconds=None):
    """Returns a ComfyUI AUDIO dict, trimmed to [start, end).

    max_seconds 是整条参考的长度上限（秒）。它同时起两个作用：挡住超长音频把
    音频 VAE 推爆（见 ref_audio_limit_seconds），以及只解码到需要的长度——否则
    为了截断而把几分钟的素材整条解出来，白等也白占内存。
    """
    path = _resolve_asset(ref)
    if path is None:
        raise FileNotFoundError("H3 Studio: audio not found on disk: %s" % ref)

    start = max(0.0, float(start or 0.0))
    # 本条参考的结束时刻：显式窗口优先，窗口没封口时用 max_seconds 兜底。
    # max_seconds 约束的是**修剪之后的时长**（start 往后再取多少秒），换算到
    # 文件坐标就是 start + max_seconds。
    stop = None if end is None else float(end)
    if max_seconds is not None:
        cap = start + float(max_seconds)
        stop = cap if stop is None else min(stop, cap)

    # 必须按 stop（文件坐标）解码，不能按 stop-start：下面的 a 是在文件坐标上
    # 切的，若只解出「窗口时长」，start>0 时 a 会落到波形之外，窗口越靠后剩得
    # 越少，start 一旦超过窗口时长就直接判空。按 stop 解码同时也把长素材的
    # 代价限制在「用得到的位置」而不是整条。
    waveform, sr = decode_audio_file(path, max_seconds=stop)

    a = int(start * sr)
    b = waveform.shape[-1] if stop is None else min(int(stop * sr), waveform.shape[-1])
    if b <= a:
        raise ValueError("H3 Studio: audio trim for %s is empty." % ref)
    return {"waveform": _stereo(waveform[..., a:b])[None, ...],
            "sample_rate": int(sr)}


def _load_video_soundtrack(ref, start, end, max_seconds=None):
    try:
        return _load_audio(ref, start, end, max_seconds=max_seconds)
    except Exception as e:
        print("[H3 Studio] no usable soundtrack in %s (%s) — video sent silent." % (ref, e))
        return None


def _trimmed_duration(track):
    """加载后的实际时长（秒）。waveform 是 [B, C, T]，T 除以采样率就是了。"""
    w = track.get("waveform")
    sr = float(track.get("sample_rate") or 0.0)
    if w is None or sr <= 0:
        return 0.0
    return float(w.shape[-1]) / sr


def _audio_ref_frames_for(seconds, audio_vae):
    """目标时长换算成音频 latent 帧数（1 帧 = hop 个样本）。

    只用来算「覆盖率」，不影响任何实际编码——真正切多长由 _load_audio 的
    max_seconds 决定。hop 从 VAE 自己问，问不到才退回 800（32kHz 下 1 帧
    25ms，即 40 帧/秒）。

    取整要**向下**，不能四舍五入：VAE.encode 是先取样本数、再向下裁到 hop 的
    整数倍（9.4167s → 301333 样本 → 376 帧，不是 377）。用 round 会算出 377，
    覆盖率永远差 0.3%，和日志里的实际帧数对不上。
    """
    try:
        sr = float(getattr(audio_vae, "audio_sample_rate", 32000) or 32000)
    except Exception:
        sr = 32000.0
    try:
        hop = int(audio_vae.spacial_compression_encode())
    except Exception:
        hop = 800
    if not hop or hop <= 0:
        hop = 800
    return max(1, int(max(0.0, float(seconds)) * sr) // hop)


# --------------------------------------------------------------------------
# 参考音频潜空间缓存
#
# 音频潜空间与画布无关——它不随分辨率、帧数、采样器变化，只由「这段波形的样本」
# 决定。所以键只需要「文件身份 + 裁剪窗口 + 本次长度上限」这几项：同一段参考音频
# 在多次渲染、多个分段之间可以完全复用，重复渲染时连编码这一步都不会发生，
# 那个显存峰值自然也就不存在了。
#
# 键里必须带上 max_seconds：上限是按当时的空闲显存算出来的，换了值就说明要编的
# 是另一段波形，不能复用（否则会把长音频的潜空间当成短音频的用）。
_REF_AUDIO_CACHE = OrderedDict()
_REF_AUDIO_CACHE_MAX = 16          # 一条 60 秒的潜空间约 0.6 MB，存满也就几 MB


def _ref_audio_cache_key(ref, start, end, max_seconds, loops=1):
    """None 表示没法给这段素材做键（文件不在磁盘上等），此时不缓存。

    loops 必须进键：参考音频被「循环铺满」之后，进 VAE 的波形已经不是原始
    那一段了，而 (file, start, end, max_seconds) 这四个字段完全看不出来 ——
    少了它，改片长重跑会直接命中上一版没铺满的 latent，循环等于白做。
    """
    try:
        st = os.stat(ref)
    except OSError:
        return None
    return (os.path.abspath(ref), st.st_mtime_ns, int(st.st_size),
            round(float(start or 0.0), 4),
            None if end is None else round(float(end), 4),
            None if max_seconds is None else round(float(max_seconds), 3),
            int(loops or 1))



def _ref_audio_cache_get(key):
    if key is None:
        return None
    hit = _REF_AUDIO_CACHE.get(key)
    if hit is not None:
        _REF_AUDIO_CACHE.move_to_end(key)
    return hit


def _ref_audio_cache_put(key, latent, frames):
    if key is None or latent is None:
        return
    # 一律存 CPU 版本：缓存不该占着显存。
    _REF_AUDIO_CACHE[key] = (latent.detach().to("cpu"), int(frames))
    _REF_AUDIO_CACHE.move_to_end(key)
    while len(_REF_AUDIO_CACHE) > _REF_AUDIO_CACHE_MAX:
        _REF_AUDIO_CACHE.popitem(last=False)


# --------------------------------------------------------------------------
# 参考图编码缓存（20261023 P1 性能专项）
#
# 改文案重跑 / 同图跨分段 / 二采三采时，参考图的 PIL 解码、lanczos 缩放与视频
# VAE 编码每轮都重来；VAE 编码是 GPU 活，是重跑白等的主要时间。图的两份产物
# 只由「文件身份 + 编码尺寸」决定，与提示词、采样参数无关，所以按这两项缓存：
#   · pixels：缩放后的像素张量（ref_items["data"]，喂给 Qwen 视觉编码那一路）；
#   · latent：视频 VAE 潜空间（ref_blocks["latent"]，下游 patchify 时自己 .to(device)）。
# 一律存 CPU 副本，不占显存。键必须带 tw/th：match 档位跟随画布长边，画布变了
# 编码的就是另一份潜空间。与音频缓存同口径，键不带 VAE 身份（H3 工作流的 VAE
# 固定，换了整链路跑不通；真要换模型请重启 ComfyUI，缓存随进程释放）。
_REF_IMAGE_CACHE = OrderedDict()
_REF_IMAGE_CACHE_MAX = 24   # 单条约 8MB（1024x576 像素张量约 7MB + 潜空间约 1MB）


def _ref_image_cache_key(ref, tw, th):
    """用 resolve 后的真实绝对路径取文件身份（槽位里存的是相对名）；取不到不缓存。"""
    path = _resolve_asset(ref)
    if path is None:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (os.path.abspath(path), st.st_mtime_ns, int(st.st_size), int(tw), int(th))


def _ref_image_cache_get(key):
    if key is None:
        return None
    hit = _REF_IMAGE_CACHE.get(key)
    if hit is not None:
        _REF_IMAGE_CACHE.move_to_end(key)
    return hit


def _ref_image_cache_put(key, pixels, latent):
    if key is None or pixels is None or latent is None:
        return
    _REF_IMAGE_CACHE[key] = (pixels.detach().to("cpu"), latent.detach().to("cpu"))
    _REF_IMAGE_CACHE.move_to_end(key)
    while len(_REF_IMAGE_CACHE) > _REF_IMAGE_CACHE_MAX:
        _REF_IMAGE_CACHE.popitem(last=False)


# 「实际长度 vs 上限」的容差（秒）。不能用 1e-6：_load_audio 的封口是
# min(int(stop*sr), n)，按样本向下取整，真被截断时长度必然比上限小一点
# （32kHz 下最多差 1 个样本 = 0.03ms），1e-6 的容差会把真截断当成「素材自己
# 到头了」而闭嘴。2ms 远大于任何采样率下的一个样本，又远小于有意义的截断差。
_CAP_EPS = 0.002


def _cap_note(track, start, end, audio_cap):
    """只在**真的被截短**时才吐一句日志，否则返回空串。

    判据是「用户要的长度 > 上限」**且「素材确实够这么长」**：没封口的窗口
    （end=None）只是「不设窗口终点」，不等于「素材无限长」——7.18s 的素材配
    9.4s 的上限时一个字节都没被截，说它「已按上限自动截到 7.18s」是假警报。
    所以先看解码后的实际长度：短于上限就说明是素材自己先到头了，闭嘴。
    """
    try:
        want = None if end is None else max(0.0, float(end) - float(start or 0.0))
        if want is not None and want <= audio_cap + 1e-6:
            return ""
        if _trimmed_duration(track) < audio_cap - _CAP_EPS:
            return ""
        # 上限只由「目标时长」和 60s 决定；显存不再参与（见 ref_audio_limit_seconds）。
        return ("  已按上限自动截到 %.1fs（上限 %.1fs ＝ 目标时长与 60s 取小；"
                "显存不参与截断，放不下会自动改走 CPU 编码、结果与 GPU 几乎一致）"
                % (_trimmed_duration(track), audio_cap))
    except Exception:
        return ""


# --------------------------------------------------------------------------
# 参考音频「循环铺满」片长（20261026，默认关闭）
# --------------------------------------------------------------------------
# ⚠ 这段代码保留，但它当初要解决的问题**不是**真问题。
#
# 原先的判断：音色素材比片长短时 `ref_audio_t` 覆盖不到整段目标，模型会在没被
# 覆盖的部分退回自己的默认嗓音（现场 7.18s 音色配 9.42s 片长，覆盖 76%，输出
# 基频从参考的 132.8Hz 跳到 219~238Hz，看起来像是换了一把嗓子）。
#
# 当场验证：把音色循环铺到 100% 覆盖之后重跑，基频 234→250Hz、余弦 0.849→0.896
# —— 等于没变。真变量是**参考图与音色素材冲突**：同一 124 帧、同一条男声音色，
#   有女性参考图 → 203.1Hz（+53%，图赢）；去掉参考图 → 156.2Hz（+18%，音频生效）；
#   换成女性音色配女性参考图 → 250.0Hz，与参考 250.0Hz 逐 Hz 一致、余弦 0.924。
# 所以覆盖率不是杠杆，循环拼接只剩坏处：内容重复可能被模型学成复读，音频参考行
# 还多 31%。默认关（REF_AUDIO_LOOP=False）。
#
# 留着它是因为「2 秒素材配 60 秒片长」那种极端比例下铺一遍确实太短，需要时可开。
# 三种补救的代价对比留档：
#   · 循环拼接（本函数）：内容重复 → 复读风险。
#   · 变速不变调：内容不重复，但语速被拉慢（7.18→9.42 是 ×0.76）；需要 SOLA /
#     相位声码器，本插件没有现成实现。
#   · 静音补齐：只骗过长度检查，后半段等于没有参考信息。
# 开启时接缝必须交叉淡化：硬拼接在阶跃处产生宽带瞬态，模型很容易把它学成咔哒。

# 留着这套代码是因为它对「2 秒素材配 20 秒片长」那种极端比例仍有意义，
# 需要时把这里改 True 即可，不影响其他任何逻辑。
REF_AUDIO_LOOP = False         # 总闸：置 True 才做循环补齐
REF_AUDIO_LOOP_MAX = 8         # 最多铺这么多遍（1s 素材配 60s 片长会是 60 遍，那是灾难）
REF_AUDIO_LOOP_FADE = 0.015    # 接缝交叉淡化的长度（秒）
REF_AUDIO_LOOP_MIN_GAP = 0.10  # 缺口小于这个就不折腾（几毫秒的差没有意义）


def _loop_ref_audio_to_length(track, target_seconds, log=None):
    """把参考音频循环铺到 target_seconds 长；够长就原样返回。

    返回 (track, loops, have_seconds)：
      loops      = 实际铺了几遍（1 = 没动过，缓存键靠它区分）
      have       = 循环前的原始时长（写日志用）

    只在「原始时长 < 目标时长」且缺口 ≥ REF_AUDIO_LOOP_MIN_GAP 时动手。
    铺不满（撞了 REF_AUDIO_LOOP_MAX）就铺到上限为止，并把还差多少说清楚——
    半覆盖也比不覆盖强，但用户必须知道没铺满。
    """
    w = track.get("waveform")
    sr = int(track.get("sample_rate") or 0)
    if w is None or sr <= 0 or getattr(w, "ndim", 0) != 3 or w.shape[-1] <= 0:
        return track, 1, 0.0
    have = float(w.shape[-1]) / sr
    target = max(0.0, float(target_seconds))
    if have <= 0 or target - have < REF_AUDIO_LOOP_MIN_GAP:
        return track, 1, have

    need = int(round(min(target, have * REF_AUDIO_LOOP_MAX) * sr))
    fade_n = max(1, int(REF_AUDIO_LOOP_FADE * sr))
    base = w[0]                                  # [2, N]
    if base.shape[-1] <= fade_n * 2:
        return track, 1, have                    # 素材太短，拼了也没有意义
    out = base.clone()
    loops = 1
    while out.shape[-1] < need and loops < REF_AUDIO_LOOP_MAX:
        n = out.shape[-1]
        k = min(fade_n, base.shape[-1], n)
        ramp = torch.linspace(0.0, 1.0, k + 2, dtype=base.dtype,
                              device=base.device)[1:-1]
        head = base[:, :k] * ramp + out[:, -k:] * (1.0 - ramp)
        out = torch.cat([out[:, :-k], head, base[:, k:]], dim=-1)
        loops += 1
    out = out[..., :need]
    if out.shape[-1] <= 0:
        return track, 1, have

    if log:
        covered = float(out.shape[-1]) / sr
        log("音色 %.2fs 短于片长 %.2fs —— 已循环 %d 遍铺到 %.2fs"
            "（接缝 %.0fms 交叉淡化）%s"
            % (have, target, loops, covered, REF_AUDIO_LOOP_FADE * 1000,
               "" if covered + 1e-3 >= target
               else "；已达 %d 遍上限，还差 %.2fs 没有参考"
                    % (REF_AUDIO_LOOP_MAX, target - covered)))
    return {"waveform": out[None, ...], "sample_rate": sr}, loops, have



# --------------------------------------------------------------------------
# Slot parsing + tag transcription
# --------------------------------------------------------------------------

def _slot_list(raw, count):
    out = []
    src = raw if isinstance(raw, list) else []
    for i in range(count):
        item = src[i] if i < len(src) and isinstance(src[i], dict) else {}
        out.append(item if item.get("file") else None)
    return out


def _pin_count(raw, default):
    """钉死的头 / 尾帧数：非数字或越界一律退回默认值。

    前端输入框是自由填写的，脏值直接喂给 build_pin_mask 会在采样前才炸 ——
    而那时候用户已经等了很久。这里收口，坏值当默认处理。
    """
    try:
        n = int(round(float(raw)))
    except (TypeError, ValueError):
        return int(default)
    if n < 0 or n > 4096:
        return int(default)
    return n


def _flag(raw):
    """面板开关值归一成布尔。前端写布尔，老存档可能是 0/1 或字符串。"""
    if isinstance(raw, str):
        return raw.strip().lower() in ("1", "true", "on", "yes", "开")
    return bool(raw)


_HEX8 = re.compile(r"^[0-9a-f]{8}$")


def _seg_fps_of(raw):
    """编译回执自带的段内容指纹：只收 8 位小写十六进制，其余一律当「没给」。

    为什么校验得这么严：这串东西会写进 h3_data、跟着工作流存盘，还能被人
    手改。它本身只用于对账，但一个畸形值会让对账报出**永远消不掉的漂移**，
    把真问题盖掉。所以宁可整项不认，也不认半截。

    src 决定"词"该和库里的哪一份比：接文案台时是 global+段词，没接时是
    state.prompt。两边口径不同，比错了一律是假警报。
    """
    src = raw if isinstance(raw, dict) else {}
    out = {}
    for k in ("word", "img", "vid", "aud"):
        v = src.get(k)
        out[k] = v if isinstance(v, str) and _HEX8.match(v) else ""
    out["src"] = "desk" if src.get("src") == "desk" else "state"
    return out


def _preview_cfg(raw):
    """内置动画预览参数（20261108 17:24 定案，单一路线）。

    用户定：源节点 VAE 真解码、长边 576、速率与成片 1:1。
    帧数缺省 0 = 全部时间格；帧延时一律由段长自动算，不再手填帧率——
    手填 fps 会让整段被压进 1 秒（17:10 那次 8fps 就快放了 8 倍）。
    之前这里没有进白名单，导致 cfg.get("preview") 恒为 {}，参数全部锁死。
    """
    d = raw if isinstance(raw, dict) else {}

    def _int(key, lo, hi, dflt):
        try:
            v = int(d.get(key) or dflt)
        except (TypeError, ValueError):
            v = dflt
        return max(lo, min(hi, v))

    return {
        "preview_frames": _int("preview_frames", 0, 72, 0),
        "max_resolution": _int("max_resolution", 64, 960, 576),
        "jpeg_quality": _int("jpeg_quality", 30, 100, 60),
    }


def parse_h3_data(raw):
    """Whitelisted parse — anything not listed here is dropped on purpose."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    slots = data.get("slots") if isinstance(data.get("slots"), dict) else {}

    def one(key):
        item = slots.get(key)
        return item if isinstance(item, dict) and item.get("file") else None

    # CONTINUE FROM: the previous clip's tail, anchored at frame 0 of this one.
    # Whitelisted like everything else - an older project file cannot smuggle
    # anything in through it.
    raw_cont = data.get("cont")
    cont = None
    if isinstance(raw_cont, dict):
        # 续写档位：file = 磁盘视频文件（原路径，解码→重编码）；latent = 上一片段
        # 的采样潜空间（Motion Context 算术，自动承接 output 目录最新的续拍存档）。
        # 缺省 file：老工程没有 mode 字段，行为逐帧不变。
        cont_mode = "latent" if raw_cont.get("mode") == "latent" else "file"
        if cont_mode == "latent" or raw_cont.get("file"):
            end = raw_cont.get("end")
            start = float(raw_cont.get("start") or 0.0)
            end = float(end) if end not in (None, "") else None
            # The UI states the window as start/end, and the span IS the frame
            # count - reading a separate "frames" field instead would silently cap
            # a 39f pick back to whatever that field last said.
            if end is not None:
                frames = int(round((end - start) * FPS)) + 1
            else:
                # 缺省 0 = 不接：续接是用户明确要的动作，不能靠默认值替他决定。
                frames = int(raw_cont.get("frames") or 0)
            # 源片字段按档位分开：文件档 = file（adopt 拷进 input 的那份）；
            # 潜空间档 = latent_video（前端写的相对 output 成片路径，只作
            # 「源视频」输出供 Glide 续接合成拼长片）。分开存，切档互不污染；
            # 这里统一归位到 cont["file"]，下游读取方式不变。
            src = (raw_cont.get("latent_video") if cont_mode == "latent"
                   else raw_cont.get("file"))
            cont = {
                "mode": cont_mode,
                "file": str(src or ""),
                # 潜空间档的续写开关：有存档路径才续写。这个值由「全部渲染」在
                # 逐段切换时自动写入（旧版另有面板「引用上次片段」按钮，新版已
                # 随「续写来源」卡一并撤掉，别再按那个按钮去找）。
                # 没有 = 本片段按第一段处理。
                "latent_file": str(raw_cont.get("latent_file") or ""),
                "start": start,
                "end": end,
                "frames": frames,
                "audio": bool(raw_cont.get("audio")),
                # the UI sends a checkbox; a float still works if a file carries one
                "flatten": max(0.0, min(1.0, float(raw_cont.get("flatten") or 0.0))),
                # strict 续接（2-B）：中枢续段专用，禁 mtime 兜底。
                "strict": bool(raw_cont.get("strict")),
            }

    # 段落档案归属：本段属于哪条片子、是第几段。
    # 空片名 = 不归档，导演台照旧单段工作（不产生任何档案文件）。
    raw_chain = data.get("chain")
    # 20261026：删除「重抽档位 / 锚点选法 / 骨架间隔」三件套。钉帧只保留
    # 「头尾留几帧」—— 它是续接必需的（下一段的引导头照本段尾帧重绘），
    # 且全填 0 = 整段从零重拍。中间帧一律不钉：骨架钉帧会把旧版画面按固定
    # 间隔贴回新版，落在 H3 周期首步就是单帧孤立 → 每 0.7 秒闪一下。
    chain_ref = {"name": "", "clip": "", "shot": "",
                 # 默认头尾都不留 = 点运行就是整段重拍（用户主用路径）。
                 "pin_head": 0, "pin_tail": 0}
    if isinstance(raw_chain, dict):
        chain_ref = {
            "name": str(raw_chain.get("name") or "").strip(),
            "clip": str(raw_chain.get("clip") or "").strip(),
            # 工程分段的唯一 id。后台按它认段——重抽同一分段时复用同一段档案，
            # 而不是每次都新建（clip id 前端拿不到，只能靠这个身份匹配）。
            "shot": str(raw_chain.get("shot") or "").strip(),
            # 钉帧数：前端存在 state **顶层**（pin_head / pin_tail），不在 chain
            # 兜底**必须是 0**。曾经这里是 22：模板焊死 22、老工程又没这个键，
            # 于是「面板显示 0、执行侧拿 22」，重抽时静默钉住尾帧 —— 用户
            # 完全看不见这个开关（20261027 定性）。0 = 不填就是不钉。
            # 里 —— 以前只从 chain 读，永远读到默认值，面板上填的根本没传到
            # 执行侧（20261010 修正：顶层优先，chain 里也兼容）。
            "pin_head": _pin_count(
                data.get("pin_head") if data.get("pin_head") is not None
                else raw_chain.get("pin_head"), 0),
            "pin_tail": _pin_count(
                data.get("pin_tail") if data.get("pin_tail") is not None
                else raw_chain.get("pin_tail"), 0),
        }

    return {
        "chain": chain_ref,
        "mode": "fl2va" if data.get("mode") == "fl2va" else "ref2va",
        "width": int(data.get("width") or 1344),
        "height": int(data.get("height") or 768),
        "length": int(data.get("length") or 124),
        "ref_image_size": _ref_size(
            data.get("ref_image_size"), REF_IMAGE_MAX_LONG_EDGE, "match"),
        "ref_video_size": _ref_size(
            data.get("ref_video_size"), None, "768"),
        # 参考视频采样帧率。它只作用于「参考视频」（_refs 的解码），不碰续写
        # 引导——引导按帧位取尾部、按 17k+5 吸附，跟秒→帧的换算无关。
        "ref_video_fps": _clamp_ref_fps(data.get("ref_video_fps")),
        # 「放大重绘」（二采/三采）条件的参考档位倍数。存面板 JSON 而不是原生
        # 控件：h3_data 已在 IS_CHANGED 里，改倍数走同一条失效链，且不占
        # widgets_values 的位置（旧工程回填不会被顶位）。
        "ref_scale_hd": _ref_hd_scale(data.get("ref_scale_hd")),
        "prompt": str(data.get("prompt") or ""),
        "first": one("first"),
        "last": one("last"),
        "images": _slot_list(slots.get("images"), MAX_IMAGES),
        "videos": _slot_list(slots.get("videos"), MAX_VIDEOS),
        "audios": _slot_list(slots.get("audios"), MAX_AUDIOS),
        "cont": cont,
        # 「整片」口输出开关，默认关。关 = 本次不拼整片、也不从「整片」口往外
        # 发（省掉每次几秒的拼接）；下游 RTX 超分/插帧收到空会自己安静跳过，
        # 不再抛「没有输入」把整条 prompt 打断。开着才是原来那套行为。
        "push_whole": _flag(data.get("push_whole")),
        # 「整片潜空间」口输出开关，默认关（20261101）。关 = 本次不拼整条
        # latent（省掉读全部段落档案 + cat 的几秒与内存）；开 = 拼好发给下游
        # 整片重绘。与 push_whole 不同：它是**能留在工程里的设置**（整片重绘
        # 是一个独立工作流，不是点一下就完的一次性推送）。
        "push_film_latent": _flag(data.get("push_film_latent")),
        # 中枢模板专用标记（AI 制片中枢 build_h3_data 会置 True）：据此区分
        # 「中枢模板跑出来的段」与「手工导演台段」，跳过/启用对应的互斥检查。
        "producer": bool(data.get("producer")),
        # 「别名模式」开关的真值（**三态**）：缺失 = 老工程 / 面板模式 = 开，
        # 显式 false = 只认 @图片N 写法。
        #
        # 这一项原先不在白名单里，是 20261023 查实的真 bug：前端
        # bz_project_store.js 一直在把 desk.alias 写进 h3_data.alias，而
        # 白名单把它丢掉了 —— 于是下面 `cfg.get("alias", True)` 恒为 True，
        # 文案台上开关明明关着，裸写的角色名照样被换成 @图片N 送进模型。
        # 开关失效比开关不存在更糟：用户以为关了，实际全开。
        "alias": (None if "alias" not in data else _flag(data.get("alias"))),
        # 编译回执自带的段内容指纹（方案② 对账用）。**只比对，不参与取值**。
        "seg_fps": _seg_fps_of(data.get("segFps")),
        # 内置轻量动画预览参数。20261108 前这个键没进白名单，
        # _builtin_model_chain 的 pv 恒为 {}（配置死路），已修。
        "preview": _preview_cfg(data.get("preview")),
    }


# --------------------------------------------------------------------------
# 段字段的权威归属（20261025 重做方案A）
# --------------------------------------------------------------------------
# **为什么要有这张表**：20261015 / 20261023 / 20261025 三次事故是同一个病 ——
# 一个字段要在多处同步维护，漏一处就静默退化到默认值，不报错、不打印、没人
# 知道。前两次修的是"那一处"，所以第三次必然来。修字段没用，得修"让人漏不掉"。
#
# 这张表把"哪个字段谁说了算"从散落各处的 if 收成一份声明，配两道闸：
#   · _audit_field_contract() 在**模块导入时**校验 parse_h3_data 返回的每个键
#     都归了类 —— 谁加了新字段忘了登记，当场就喊，不会静默丢掉；
#   · _merge_db_authority() 只按这张表合并，不再有"整份替换"这回事。
#
# **默认方向是反过来的**：以前"库里整份赢，漏的丢掉"；现在"提交默认赢，只有
# 表里写了 db 的才让库赢"。漏归类最坏退化成旧行为，**不会丢数据**。
SEG_KEY_OWNER = {
    # —— 段内容：只有接线才生效（20261105 用户拍板）——
    # 词与参考素材的所有者是连线上游（文案台 / 媒体架 / 任意文本节点），
    # 不是面板镜像、也不是中央库。wired = 库与面板都不许覆盖，实际值由
    # _resolve_wired_content 一处写入；断线就是空，照常渲染不拦下。
    #
    # 为什么不再用 db_nonempty：库里存的是上一次归档的旧词，断线时补回来
    # 会让「改了提示词没反应」，而素材侧又没有对称的兜底 —— 词能回来、图回不来。
    # keys 保持不变，_audit_field_contract 与 seg_field_matrix 的硬断言不受影响。
    "prompt": "wired",
    "images": "wired",
    "videos": "wired",
    "audios": "wired",
    "cont":   "db_nonempty",

    # —— fl2va 首 / 末帧锚点：由**面板槽位提交**，不归接线收口（20261108 修）——
    # _resolve_wired_content 只管词与三类参考素材，从来不写 first/last；后端
    # fl2va 分支读 cfg["first"] / ["last"]（外接 first_frame / last_frame 端口优先）。
    # 20261105 把这两项误划进 wired，前端又整块删了 slots → 没有任何路径能给
    # 它们赋值，fl2va 面板放图静默退化成 T2V（外部 BugReport 20261108）。
    # 归 submit = 保持提交值、中央库不许覆盖，既让面板槽生效，也避开
    # db_nonempty 的「断线补回旧图」老坑；端口接了图仍由后端端口优先。
    "first":  "submit",
    "last":   "submit",

    # —— 几何与采样参数：面板落库、实测与面板一致，库赢不会把值改回旧的 ——
    "mode":           "db",
    "width":          "db",
    "height":         "db",
    "length":         "db",
    "ref_image_size": "db",
    "ref_video_size": "db",
    "ref_video_fps":  "db",
    "ref_scale_hd":   "db",

    # —— 编译 / 运行上下文：**库里根本没有**（实测 61 段全缺）。
    #     以前整份替换等于把它们删掉 ——
    #       alias   被删 → 缺失按旧行为兜底成"开" → 文案台开关关不住；
    #       seg_fps 被删 → _audit_seg_fps 开头早退 → 对账静默失效。
    #     20261025 的暗病 1 / 2 就是这么来的，同一处成因。
    "alias":      "submit",
    "seg_fps":    "submit",
    # 预览是本次运行的面板偏好，段库里本来就没有；保持提交值，不让库覆盖。
    "preview":    "submit",
    "producer":   "submit",
    "push_whole": "submit",
    "push_film_latent": "submit",

    # —— 身份：跑哪一段由提交决定，不能跟着库里 state 最后停在哪一段走 ——
    "chain": "submit",
}


def _is_set(v):
    """库里这个值算不算"有值" —— **空不覆盖**是 20261015 立下的原则，别破。

    槽位 / 续写档位类（dict）只看有没有真实素材路径：光有 `{'mode':'latent'}`
    这种元数据不算有值 —— 拿它覆盖会把提交侧的续写源清掉。
    """
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, (list, tuple)):
        return any(_is_set(x) for x in v)
    if isinstance(v, dict):
        return bool(v.get("file") or v.get("latent_video"))
    return True                       # 数字 / 布尔：有就是有


def _db_has_key(db_state, key):
    """库 state 里**字面**有没有这个键 —— 与"值空不空"是两回事。

    db 档位（几何 / 采样参数）靠它判断：库里压根没这个键时，`parse_h3_data`
    会填默认值（width 默认 1344、mode 默认 ref2va…）。拿**默认值**去覆盖提交
    侧的真值 = 凭空改参数，比不改还糟。键在，库才有发言权。
    """
    if key == "chain":
        return "chain" in db_state
    if key in ("first", "last", "images", "videos", "audios"):
        slots = db_state.get("slots")
        return isinstance(slots, dict) and key in slots
    return key in db_state


def _merge_db_authority(submit_cfg, db_state, cid):
    """按 SEG_KEY_OWNER 逐字段决定谁赢 —— 取代原来的「整份替换」。

    原来的写法是 `cfg = parse_h3_data(_state)`：整份用库里的 state 重建 cfg。
    它确实修好了"提交镜像送错段"，代价是把**库里不存在的字段一起删了** ——
    那些字段随后按"缺失 = 旧行为"兜底，于是别名开关关不住、段 fps 对账恒早退。

    现在逐个字段问表：几何参数让库赢，编译上下文与段内容保留提交那份。
    段内容（wired）不在这里取值 —— 唯一写入口是 _resolve_wired_content。
    """
    db_cfg = parse_h3_data(db_state)
    out = dict(submit_cfg)
    for key, owner in SEG_KEY_OWNER.items():
        if owner == "db":
            # 库里有这个键才让库赢（没键时 parse 出的默认值不能拿去覆盖）。
            if _db_has_key(db_state, key):
                out[key] = db_cfg.get(key)
        elif owner == "db_nonempty":
            # 库里有键**且有值**才赢；库里为空一律不动提交侧（20261015 的原则）。
            v = db_cfg.get(key)
            if _is_set(v):
                out[key] = v
        # wired / submit：保持提交值不动
    # 身份单独合成（chain 归 submit，但 clip 必须是提交认到的那一段，
    # shot 优先提交侧、退而取库里的 —— 与方案A 原有语义一致）。
    sub_chain = submit_cfg.get("chain") or {}
    db_chain = db_cfg.get("chain") or {}
    out["chain"] = {
        "name": str(sub_chain.get("name") or ""),
        "clip": str(cid or ""),
        "shot": str(sub_chain.get("shot") or db_chain.get("shot") or ""),
    }
    return out


def _audit_field_contract():
    """模块导入时校验：parse_h3_data 返回的**每个键**都必须在表里归类。

    漏一个 = 将来某条路径会静默把它丢掉（20261015/1023/1025 三次都是这个）。
    只打印、**不拦出图** —— 契约违规是开发期的错，不该让用户出不了图；
    templates/seg_field_matrix.py 里对它是**硬断言**，跑测试必红。
    """
    try:
        keys = set(parse_h3_data({}).keys())
    except Exception as e:
        print("[H3 导演台] ⚠ 字段契约校验跑不起来：%s: %s"
              % (type(e).__name__, e))
        return False
    missing = sorted(keys - set(SEG_KEY_OWNER))
    extra = sorted(set(SEG_KEY_OWNER) - keys)
    if missing or extra:
        print("[H3 导演台] ⚠ 字段契约违规（段参数可能在某条路径上被静默丢弃）：")
        if missing:
            print("         未归类，必须补进 SEG_KEY_OWNER：%s" % missing)
        if extra:
            print("         表里有多余键（parse_h3_data 已不返回？）：%s" % extra)
    return not (missing or extra)


FIELD_CONTRACT_OK = _audit_field_contract()


def _seg_dir_of(cfg):
    """从提交里认出「这是哪个工程目录」；认不出返回空串（绝不自己造目录）。"""
    chain = cfg.get("chain") if isinstance(cfg.get("chain"), dict) else {}
    name = str(chain.get("name") or "")
    if not name:
        return "", ""
    try:
        from ..core import csglide_store as _st
    except Exception:
        return "", ""
    try:
        d = _st.chain_dir(name)
    except Exception:
        return "", ""
    return (d if d and _st.has_db(d) else ""), str(chain.get("clip") or "")


def _audit_seg_fps(cfg, log):
    """方案②：把「提交自称送了什么」与「库里这一段此刻是什么」对一遍。

    **只对账，不仲裁** —— 这是与最初方案的一处刻意偏离，理由值得写清楚：
    提交里的值是用户按下"运行"那一刻的意图，它是确定的；库里后来被改过的
    那份属于"下一次"。若改成"库里永远赢"，同一次批量渲染里前几段和后几段
    就会来自不同时刻，那才是更大的不一致。所以不一致时**照提交跑**，只把
    差异喊出来并记一条流水，让"这段为什么用了旧词/旧图"事后可查。

    三件事：喊一声（结果行可见）、记 rev_drift 流水、指出分歧在词还是素材。
    任何异常都吞掉 —— 对账不能把渲染搞挂。

    ⚠ 与方案A 的关系（20261025 澄清，以前这两处注释是**互相否定**的）：
    方案A 说过"中央库是段数据的唯一权威、整份覆盖"，而这里说"不一致时照
    提交跑"—— 谁按注释读都会读反。现在界线由 `SEG_KEY_OWNER` 划死：
      · **段内容**（词/槽位）只认接线，库里那份仅供对账（20261105 起）；
      · **`seg_fps` 本身归提交**（它是编译回执指纹，库里根本没有）。
    两者因此**不再矛盾**：拿提交带的指纹去比库里的段内容，正是对账该做的事。
    20261025 之前方案A 是整份替换，连带把 seg_fps 一起删了 → 这里开头
    `if not claim.get("word")` 直接早退 → 对账静默失效（暗病 2）。
    """
    claim = cfg.get("seg_fps") or {}
    if not claim.get("word"):
        return None                      # 老工作流 / 非编译提交：无从对账
    try:
        from ..core import csglide_store as _st
        d, cid = _seg_dir_of(cfg)
        if not d or not cid:
            return None                  # 没工程库：面板模式，跳过
        truth = _st.seg_fps(d, cid)
        use = "word" if claim.get("src") == "desk" else "word_prompt"
        diff = []
        if claim.get("word") and truth.get(use) and claim["word"] != truth[use]:
            diff.append("词")
        for k, zh in (("img", "图"), ("vid", "视"), ("aud", "音")):
            if claim.get(k) and truth.get(k) and claim[k] != truth[k]:
                diff.append(zh)
        if not diff:
            log("【对账】与本段在库里的记录一致（词 %s · 素材 %s/%s/%s）"
                % (claim.get("word"), claim.get("img"), claim.get("vid"),
                   claim.get("aud")))
            return {"ok": True}
        log("【对账】%s 提交副本与库里不一致：%s。库里的内容不参与本次渲染"
            "（20261105：段内容只认接线，库只管几何参数与档案）"
            % (cid, "、".join(diff) + " 不同"))
        try:
            _st.log_event(d, "rev_drift", cid,
                          {"claim": claim, "store": truth, "diff": diff,
                           "used": "wired"}, "backend")
        except Exception:
            pass
        return {"ok": False, "diff": diff, "claim": claim, "store": truth}
    except Exception as e:
        try:
            log("【对账】跳过（%s）" % type(e).__name__)
        except Exception:
            pass
        return None


def _fill_empty_words_from_store(cfg, log):
    """提交里**一个字都没有**时，从库里把这一段的词补回来。

    为什么只补空：非空的词代表"按下运行时你看到的内容"，覆盖它就是篡改。
    但空是特例 —— 空不可能是意图（没人会故意渲染一段没有提示词的片子），
    它只可能是前端那份副本没装上（切段竞态 / 刚 hydrate / 本轮没访问过该段）。
    库里既然有真源，补进来是**恢复**，不是覆盖。
    """
    if str(cfg.get("prompt") or "").strip():
        return False
    try:
        from ..core import csglide_store as _st
        d, cid = _seg_dir_of(cfg)
        if not d or not cid:
            return False
        w = _st.seg_words(d, cid)
        if not w:
            return False
        cfg["prompt"] = w
        log("【补齐】本次提交里这一段没有提示词，已从库里取回 %d 字"
            "（前端这份副本没装上这一段，不是你真的没写）" % len(w))
        try:
            _st.log_event(d, "words_filled", cid, {"chars": len(w)}, "backend")
        except Exception:
            pass
        return True
    except Exception:
        return False


def _resolve_wired_content(cfg, refs, prompt_text, log=None):
    """段内容的唯一写入口：接线才生效，断线即空。

    词与参考素材不再从面板镜像 / 中央库兜底 —— 连线是它们唯一的来源。
    判据只看这里收口后的**最终词**：上游（含文案台中央库兜底）无论从哪里
    补回旧词，只要最终非空就不套默认镜头，避免「看着空、其实有词」误判。

    ⚠ 边界（20261108）：first / last **不归本函数**。它们是 fl2va 的面板槽位
    锚点、在 SEG_KEY_OWNER 里归 submit，由 parse_h3_data 从 h3_data.slots 解析；
    这里只写词与三类参考素材，别顺手把首/末帧也清了。
    """
    _merge_rack_refs(cfg, refs)
    cfg["prompt"] = str(prompt_text) if prompt_text is not None else ""
    if not str(cfg["prompt"]).strip():
        cfg["prompt"] = DEFAULT_SHOT_LINE
        if log and str(DEFAULT_SHOT_LINE).strip():
            log("【默认镜头】空输入，已套用默认镜头词 %d 字" % len(DEFAULT_SHOT_LINE))
    if log:
        def _n(kind):
            return len([s for s in (cfg.get(kind) or [])
                        if isinstance(s, dict) and s.get("file")])

        words = str(cfg.get("prompt") or "")
        src = "接线" if (refs or prompt_text is not None) else "未接线"
        log("【本次内容】词 %d 字 / 参考图 %d 张 · 视频 %d 段 · 音频 %d 段 / 来源：%s"
            % (len(words), _n("images"), _n("videos"), _n("audios"), src))
        if words:
            log("【本次内容】实际送编码器的词开头 40 字：%s"
                % words[:40].replace("\n", " "))
        if refs is None or prompt_text is None:
            log("【本次内容】有输入口未接线 —— 本次内容已按空输入收口")
    return cfg


def build_tag_map(cfg, has_first, has_last):
    """Map @token -> real tag, using the same ordinal rules as the tokenizer.

    Presentation order is fixed by type: images, then videos (a soundtrack's
    <Audio j> is emitted immediately before its <Video k>), then standalone
    audio. Ordinals are 1-based per type and count only filled slots.
    """
    tags, presentation = {}, []

    if cfg["mode"] == "fl2va":
        i = 0
        if has_first:
            i += 1
            tags["@first"] = "<Picture %d>" % i
            presentation.append(("<Picture %d>" % i, "first frame"))
        if has_last:
            i += 1
            tags["@last"] = "<Picture %d>" % i
            presentation.append(("<Picture %d>" % i, "last frame"))
        return tags, presentation

    i = 0
    for n, slot in enumerate(cfg["images"], start=1):
        if slot is None:
            continue
        i += 1
        tags["@图片%d" % n] = "<Picture %d>" % i
        presentation.append(("<Picture %d>" % i, "image %d" % n))

    j, k = 0, 0
    for n, slot in enumerate(cfg["videos"], start=1):
        if slot is None:
            continue
        if slot.get("audio"):
            j += 1
            tags["@视频音频%d" % n] = "<Audio %d>" % j
            presentation.append(("<Audio %d>" % j, "video %d sound" % n))
        k += 1
        tags["@视频%d" % n] = "<Video %d>" % k
        presentation.append(("<Video %d>" % k, "video %d" % n))

    for n, slot in enumerate(cfg["audios"], start=1):
        if slot is None:
            continue
        j += 1
        tags["@音频%d" % n] = "<Audio %d>" % j
        presentation.append(("<Audio %d>" % j, "audio %d" % n))

    return tags, presentation


# <Audio N> 不在这张表里：它的 N 就是第 N 个独立音频，与 @音频N 同义。
# 旧做法把 N 当成「音频类的全局序号 j」（视频自带的声音与独立音频共用同一个
# 计数器），于是同一个 <Audio 1> 时而是某个视频的声音、时而是独立音频1，结果
# 随当日填充状态漂移。2026-10-23 起后端（_audio_ref）与前端
# （js/csglide_ref_text.js、js/csglide_cast_alias.js 的 audioRef）都按上面这个
# 固定语义实现；视频自带的声音一律用 @视频音频N 引用，两套编号各数各的、互不挤占。
# （送模型那一侧的 <Audio j> 仍必须是全局 j —— 那是模型自身的协议，由
# build_tag_map 根据实况现场排号，与用户怎么写无关，勿混为一谈。）
# 它由 _AUDIO_TAG / _AUDIO_WORD 单独处理，见 normalize_refs。
_REF_ALIASES = (
    (re.compile(r"<\s*Picture\s*(\d+)\s*>", re.I), r"@图片\1"),
    (re.compile(r"<\s*Video\s*(\d+)\s*>", re.I), r"@视频\1"),
    (re.compile(r"(?<!@)\bPictures?\s*(\d+)(?!\d)", re.I), r"@图片\1"),
    (re.compile(r"(?<!@)\bImages?\s*(\d+)(?!\d)", re.I), r"@图片\1"),
    (re.compile(r"(?<!@)\bVideos?\s*(\d+)(?!\d)", re.I), r"@视频\1"),
    # 中文规则只用 (?:@\s*)? 容许 @ 后的空格：写成 @?\s* 会把「与 图片1」的
    # 空格一起吃掉，变成「与@图片1」。(?<![视音频图]) 挡住「视频音频3」里
    # 的「音频3」被音频规则二次命中，否则会被拆成「@视频@音频3」。
    (re.compile(r"(?:@\s*)?视频音频\s*(\d+)(?!\d)"), r"@视频音频\1"),
    (re.compile(r"(?<![视音频图])(?:@\s*)?(?:图片|图像)\s*(\d+)(?!\d)"), r"@图片\1"),
    (re.compile(r"(?<![视音频图])(?:@\s*)?视频\s*(\d+)(?!\d)"), r"@视频\1"),
    (re.compile(r"(?<![视音频图])(?:@\s*)?音频\s*(\d+)(?!\d)"), r"@音频\1"),
)

# <Audio N> 与裸词 Audio N：N 就是第 N 个独立音频。
# 裸词的左右边界与 _REF_ALIASES 里其他英文规则一致（(?<!@) 与 (?!\d)）。
_AUDIO_TAG = re.compile(r"<\s*Audio\s*(\d+)\s*>", re.I)
_AUDIO_WORD = re.compile(r"(?<!@)\bAudios?\s*(\d+)(?!\d)", re.I)

# 相邻标签之间补空格：@音频1@音频4 这种连贴写法来自手滑或外部工具，下游目前切
# 得开、也换得对，但难读且脆——依赖「替换按长度倒序」恰好规避前缀陷阱这种巧合。
# 补一个空格就把「标签能不能挨着」这个边界问题消掉了。
# 位置必须在所有写法都收敛成规范标签之后（见 normalize_refs 里的调用顺序）；
# 幂等：已有空格的文本不再命中 (?=@)。与前端 js 的 GLUE_RE 必须一致。
_GLUE_RE = re.compile(r"(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)")


def _audio_ref(n):
    """<Audio N> / 裸词 Audio N → 第 N 个独立音频槽的规范 token @音频N。

    N 就是第 N 个音频槽，与 @音频N 同义；越界（> MAX_AUDIOS）返回 None，调用方
    保留原文。视频自带的音轨不归这里管 —— 它一律用 @视频音频N 引用，两套编号各
    数各的（见 build_tag_map 上方那段说明）。

    槽位此刻是空的也照样换成 @音频N：指向空位的标签会被 transcribe_prompt 静默
    删掉，等素材补进那一格，同一份文案一个字不改就能生效。旧做法是保留 <Audio N>
    原文，结果它作为字面文本进了编码器、永远参考不到，界面上却没有任何提示 ——
    用户只能反复怀疑「音频是不是没加载上」。
    """
    return "@音频%d" % n if 1 <= n <= MAX_AUDIOS else None


def normalize_refs(text):
    out = str(text or "")
    # 音频标签先处理：放到中文规则之后会再被「视频音频」规则碾一遍。
    # 越界时回吐原匹配串 m.group(0)（= 没改动），不能返回 None —— re 的 repl
    # 函数必须给出字符串。
    out = _AUDIO_TAG.sub(
        lambda m: _audio_ref(int(m.group(1))) or m.group(0), out)
    out = _AUDIO_WORD.sub(
        lambda m: _audio_ref(int(m.group(1))) or m.group(0), out)
    for pat, rep in _REF_ALIASES:
        out = pat.sub(rep, out)
    out = _GLUE_RE.sub(r"\1 ", out)
    return out


# ---- 别名：剧本里直接写角色名 → @图片N ----------------------------------
# 媒体架槽位可带 alias（拖入时按文件名主干自动登记，也可手动改多个称呼）。
# 提示词里出现别名即等价于写 @图片N，原文不改写——展开只发生在送模型这一路。
#
# 展开必须排在 normalize_refs 之前：normalize 认得 picture 1 / image 1 这类
# 英文写法，若先归一化，名字长得像英文标签的别名会被抢先变成 @图片N，指到
# 完全错误的槽位；反过来，展开产物 @图片N 也不该再被别名二次改写。

_ALIAS_SEP = re.compile(r"[,，、;；]+")
_ALIAS_MAX = 40       # 单个别名长度上限（与媒体架侧一致）
_ALIAS_TOTAL = 12     # 每个槽位别名个数上限


def _norm_space(text):
    """把全角空格 U+3000 换成半角 U+0020。

    中文输入法在「张三丰　剧照」这种词间位置极易产出全角空格，而用户手打
    别名时又可能是半角，两边对不上就永远命不中。归一化必须**两侧都做**：
    只改名字或只改正文，仍会有「名字半角 / 正文全角」这类组合漏掉。

    只换 U+3000，不动其他空白：制表符、NBSP 在中文输入里几乎不出现，多归一
    一类字符就多一份「我以为写的是这个、它却变成那个」的意外。分隔符本来就把
    全角逗号顿号收进了 _ALIAS_SEP，不需要在这里处理。

    口径与前端 js/csglide_cast.js 的 normSpace、js/csglide_media_rack.js 的
    normSpace 必须一致，三处各写一份迟早会飘。
    """
    return text.replace("\u3000", " ") if text else text


# 撞内置词的名字一律不注册：否则「图片1」到底算别名还是规范写法无法判定。
_BUILTIN_ALIAS = re.compile(
    r"^(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+|"
    r"pictures?\s*\d+|videos?\s*\d+|audios?\s*\d+|images?\s*\d+)$", re.I)
# 边界按「首尾是不是 ASCII 字母」分两组：
#   ASCII 组要挡紧邻的字母数字（Tom 不能命中 Tommy）；
#   中文组只能挡数字——中文没有空格分词，若连汉字一起挡，「看小明走过来」
#   这种最常见的剧本句式会整个失效，别名等于没做。
# 边界里还要挡哨兵与反斜杠：转义过的别名（\小明）不能被展开。
# \x00 是转义哨兵，见 _ESC。
_ALIAS_EDGES = {
    "ascii": (r"(?<![\x00\\A-Za-z0-9])", r"(?![A-Za-z0-9])"),
    "cjk":   (r"(?<![\x00\\0-9])",       r"(?![0-9])"),
}

# 保护区：台词标签 <d>…</d> 内部、引号内部不展开别名。台词是给 H3 念的字，
# 换成 <Picture n> 会念错或搞乱口型。规则必须与前端 PROTECT_SRC 一致。
# 末两项是「引号开了没闭」的兜底：打字打一半、台词跨行只写了一半时闭引号还没
# 出现，闭引号规则匹配不上，后半个引号里的名字照样被展开。按行兜到行尾——
# 引号本就不跨行，吞掉一整段才是更大的事故。re.M 让 $ 认行尾。
# 前端 js/csglide_cast.js 的 PROTECT_SRC / PROTECT_FLAG 必须与此一致。
_PROTECT_RE = re.compile(
    r"<d>[\s\S]*?</d>|\"[^\"\n]*\"|\u201c[^\u201d\n]*\u201d"
    r"|\"[^\"\n]*(?=$|\n)|\u201c[^\u201d\n]*(?=$|\n)", re.M)
_ESC = "\x00"          # 转义哨兵：提示词里不可能出现的字符


def _map_outside(text, fn):
    """只对保护区**外面**的片段做变换，保护区原样通过。"""
    out, pos = [], 0
    for m in _PROTECT_RE.finditer(text):
        out.append(fn(text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(fn(text[pos:]))
    return "".join(out)


def _alias_ok(name):
    """单字不注册（误伤率爆炸），含 @ 或反斜杠不行，撞内置词不行。

    注意传入的是**去掉 @ 的**名字：@ 前缀在别名里是「仅 @ 触发」的标记，
    不是名字的一部分。

    空格是允许的，且**是名字的一部分**（「张三丰 剧照」就是一个名字）。
    分隔符只有 _ALIAS_SEP 那几个，空格不在其中，所以写法上不会歧义。名字
    首尾的空格由调用方 trim 掉（_alias_of / writeAlias 都已 trim），这里
    不重复做——中间的空格必须原样保留，否则「张三丰 剧照」会被压成
    「张三丰剧照」，与用户输入对不上，正文里怎么写都命不中。
    """
    if not name or len(name) < 2 or len(name) > _ALIAS_MAX:
        return False
    # 反斜杠留给转义（\别名 = 保留文字），名字里出现会与之冲突
    if "@" in name or "\\" in name:
        return False
    return not _BUILTIN_ALIAS.match(name)


def _alias_of(slot):
    """取出槽位里登记过的别名（str 或列表都要收）。

    这里只做「取」，**不做合法性过滤**——过滤统一在 alias_table 里由
    _alias_ok 完成，两处各判一遍就会出现「取到了但没注册」的静默失效。
    去重与 _ALIAS_TOTAL 截断保留在此：它们决定的是「登记顺序」，不是合法性。
    """
    v = slot.get("alias")
    if isinstance(v, str):
        parts = _ALIAS_SEP.split(v)
    elif isinstance(v, list):
        parts = [q for p in v if isinstance(p, str) for q in _ALIAS_SEP.split(p)]
    else:
        return []
    out = []
    for p in parts:
        # strip 先剥首尾（Python 的 strip() 默认就认全角空格），再归一内部
        # 的全角空格——顺序不能反：先归一的话，首尾的全角空格会被转成半角，
        # 但结果一样会被 strip 掉，多一步无谓转换而已。真正要保的是**中间**的
        # 空格改成半角，好与正文里的半角对齐。
        a = _norm_space(p.strip())
        if a and a not in out:
            out.append(a)
    return out[:_ALIAS_TOTAL]


def alias_table(cfg):
    """别名表 → (map, strict)。

    写法即作用域，不需要额外字段：
      小明   → 自动：正文里写「小明」就引用
      @小明  → 仅 @ 触发：必须写「@小明」才引用（名字太常见时用）
      清空   → 关闭：不参与
    map: 名字（不含 @）→ 规范 token；strict: 只认 @ 的名字集合。
    先出现者优先：重名时后者静默失效，保留前一个（不覆盖、不报错）。
    """
    out, strict = {}, set()
    for kind, fmt in (("images", "@图片%d"), ("videos", "@视频%d"), ("audios", "@音频%d")):
        arr = cfg.get(kind)
        if not isinstance(arr, list):
            continue
        for i, slot in enumerate(arr, start=1):
            if not isinstance(slot, dict):
                continue
            for raw in _alias_of(slot):
                at = raw.startswith("@")
                name = raw[1:] if at else raw
                if not _alias_ok(name) or name in out:
                    continue
                out[name] = fmt % i
                if at:
                    strict.add(name)
    return out, strict


def alias_map(cfg):
    return alias_table(cfg)[0]


# 定义句的**宾语**绝不能被展开成编号（20261024 真机复盘）
# --------------------------------------------------------------------------
# `将 @图片11 定义为 KF_01-01（本段空间关系参照图…）` 一旦把 KF_01-01 换成
# @图片11，整句就成了「@图片11 定义为 @图片11」—— 模型拿到的是一串自我指涉的
# 编号，它再也不知道「第 6 号图是本段的画面基准」「第 2 号图是那个越怕越慢的人」。
# 文案台上显示的是**原文**（用户写的名字），所以看着一切正常；错在送模型的那一路。
#
# 真机复盘（未命名工程 6，5 段）：每一段的每一条定义句都被这样改写，
# `将 @图片12 定义为 KF_01-02（…）` → `将 @图片12 定义为 @图片12（…）`，
# 全片 30 处，一处不漏。用户的描述正是「提示词引用了正确素材、缩略图也对，
# 但生成结果引用错了」—— 因为送进去的那份文本里，名字已经不在了。
#
# 两种写法都要护住（与前端的 defClaimsOf / DEF_PAREN 同一套形状认知）：
#   ① `@图片11 定义为 KF_01-01` / `KF_01-01 定义为 @图片11`（宾语在后 / 在前）
#   ② `@图片28（核心帧图标准名 KF_01-05）`（名字写在括号里）
# 只护**定义位置**这一处，正文里的同名照常展开成 @图片N —— 引用集合一个不少。
_DEF_OBJ_BEFORE = re.compile(
    r"(?:定义为|定义|对应|即为|=|＝)\s*$"
    r"|@图片\s*\d+\s*[（(]\s*[^）)]{0,18}(?:标准名|名称|名字|名)\s*[:：]?\s*$")
_DEF_OBJ_AFTER = re.compile(r"^\s*(?:定义为|定义|对应|即为|=|＝)")


def expand_aliases(text, amap, strict=()):
    """把提示词里的别名替换成规范 token。

    三件事：
      1. 保护区（<d>…</d> 与引号内）整段跳过 —— 台词原样送出去；
      2. \\别名 转义：保留文字，末尾去掉反斜杠；
      3. 每组一次扫描 + 组内最长优先：逐个 str.replace 会连锁替换，一个别名
         恰好是另一个的子串时必然出错（先换「小明」会把「小明月」也吃掉）。
    组间不会连锁——替换结果是 @图片N，而「图片N」是禁用的别名。

    第 4 件：**定义句的宾语不展开**（见上面 _DEF_OBJ_BEFORE 那段）。少了这条，
    「定义为 X」会在送模型前退化成「定义为 X 的编号」，名字语义整片丢失 ——
    而文案台显示原文，于是没人看得出来。
    """
    if not text or not amap:
        return text
    strict = set(strict or ())
    names = list(amap)
    escaped = re.sub(r"\\(?=" + "|".join(re.escape(k) for k in names) + ")",
                     _ESC, text)

    # 全局按长度倒序、**逐个别名**替换。不能分 ascii/cjk 两组批量替换：
    # 短别名（ascii 组）会抢先吃掉长别名（cjk 组）里的一段——别名「小明Ab刀」
    # 加「Ab」时，「小明Ab刀」会被截成「小明@图片2刀」。逐个按长度先长后短就
    # 没这个问题；替换结果是 @图片N（不含任何别名，且「图片N」是禁用的别名），
    # 所以也不会连锁。
    ordered = sorted(names, key=len, reverse=True)

    def seg(s):
        if not s:
            return s
        # 全角空格在这里归一：seg 只收到**保护区之外**的片段，所以台词
        # <d>…</d> 与引号内一个字符都不会被动——那些字要原样送给模型去念。
        # 必须早于下面的匹配：名字在 _alias_of 里已归一成半角，正文不归一
        # 就永远对不上。
        s = _norm_space(s)
        for n in ordered:
            key = "ascii" if any(c.isascii() and c.isalpha() for c in (n[0], n[-1])) else "cjk"
            edge_l, edge_r = _ALIAS_EDGES[key]
            at = "@" if n in strict else "@?"
            pat = re.compile(edge_l + at + "(" + re.escape(n) + ")" + edge_r)

            def rep(m):
                # 定义句的宾语：原样留着，别换成编号（理由见 _DEF_OBJ_BEFORE）
                head = m.string[max(0, m.start() - 32):m.start()]
                tail = m.string[m.end():m.end() + 8]
                if _DEF_OBJ_BEFORE.search(head) or _DEF_OBJ_AFTER.match(tail):
                    return m.group(0)
                return amap[n]
            s = pat.sub(rep, s)
        return s

    return _map_outside(escaped, seg).replace(_ESC, "")


def transcribe_prompt(prompt, tags, known_tokens):
    """Replace @tokens with real tags. Tokens pointing at empty slots are dropped."""
    out = prompt
    for token in sorted(known_tokens, key=len, reverse=True):
        if token in tags:
            out = out.replace(token, tags[token])
        elif token in out:
            print("[H3 Studio] %s points at an empty slot — removed from the prompt." % token)
            out = out.replace(token, "")
    # 检测残留下来的、系统未识别的 @标签（常见于格式写错，如 @图1 应为 @图片1）
    import re
    leftover = sorted(set(re.findall(r"@\S+", out)))
    if leftover:
        print("[H3 导演台] 提示词里有未识别的 @标签（若想引用参考，请用 @图片N / @视频N / @音频N 格式）：%s"
              % ", ".join(leftover))
    return out


# --------------------------------------------------------------------------
# Node
# --------------------------------------------------------------------------

def _filter_refs_by_prompt(cfg, prompt=None):
    """严格按需：提示词里提到的 @标签 决定送哪些参考——一个都没提就一个
    都不送（方案确认项）。未提到的槽位置 None 但保留编号位置，
    <Picture i> 序号由 build_tag_map 只数已填槽位自动重排。
    返回各类型保留的编号（1 起），供日志核对。

    prompt 必须传**别名展开后**的那份文本：剧本里写的是角色名（陈九一），
    只有展开成 @图片N 之后这里才扫得到标签。不传就退回 cfg["prompt"]（未
    接别名表的老调用路径），行为与改动前一致。
    """
    prompt = prompt if prompt is not None else (cfg.get("prompt") or "")

    def nums(*pats):
        out = set()
        for pat in pats:
            out.update(int(m) - 1 for m in re.findall(pat, prompt))
        return out

    keep = {
        "images": nums(r"@图片(\d+)"),
        "videos": nums(r"@视频音频(\d+)", r"@视频(\d+)"),
        "audios": nums(r"@音频(\d+)"),
    }
    """超过各类型上限时按编号取前 cap 个，其余槽位置空——<Picture 10> / 
    <Video 4> 这类标签模型不认，送进去只会静默失效（图没生效却没报错）。
    截断规则与前端 filterUsedByPrompt 必须一致。"""
    caps = {"images": MAX_IMAGES, "videos": MAX_VIDEOS, "audios": MAX_AUDIOS}
    over = {}
    for kind, idxs in list(keep.items()):
        cap = caps[kind]
        if len(idxs) > cap:
            keep[kind] = set(sorted(idxs)[:cap])
            over[kind] = len(idxs)
    # 「一个都没提就一个都不送」是全局判定，不是逐类型判定：与前端
    # filterUsedByPrompt 的 any 同义。只提了图片时，视频侧是「位置留空的
    # 数组」还是「空数组」对下游等价（都数不出素材），但两边必须同构，
    # 否则以后任一侧加了「按空位补提示」之类的逻辑就会瞬间对不上。
    #
    # 例外：独立音频不参与按需过滤。官方 MiniMaxH3ReferenceToVideo 对 ref_audios
    # 是无条件发送的（不看提示词），导演台原先也过滤，于是「摆好了音频、提示词
    # 没写 @音频N」就静默丢弃——用户只看到音频没生效，查不出原因。
    # 音频是「配乐/音色」这类整体氛围参考，本来就不一定在剧本里被逐句提到，
    # 按需过滤对它没有省显存的意义（音频 token 占比极小），却极易误伤。
    # 音频仍受 MAX_AUDIOS 上限约束，超出的按编号取前 N 个。
    any_keep = any(keep.values())
    kept = {}
    for kind, idxs in keep.items():
        arr = cfg.get(kind)
        if not isinstance(arr, list):
            continue
        if kind == "audios":
            all_idx = set(i for i in range(len(arr)) if arr[i])
            if len(all_idx) > caps["audios"]:
                all_idx = set(sorted(all_idx)[:caps["audios"]])
            kept[kind] = sorted(i + 1 for i in all_idx)
            cfg[kind] = [arr[i] if i in all_idx else None
                         for i in range(len(arr))]
            continue
        kept[kind] = (sorted(i + 1 for i in idxs if i < len(arr) and arr[i])
                      if any_keep else [])
        cfg[kind] = ([arr[i] if i in idxs else None for i in range(len(arr))]
                     if any_keep else [])
    return kept, over


# ---------------------------------------------------------------------------
#  文本编码器用完就还
#
#  导演台是整个工作流里唯一吃 CLIP 的节点：提示词编完，它就再也不碰了。
#  可它占的显存会一直挂到工作流结束，后面的扩散模型 + LoRA 只能跟它抢。
#
#  为什么放在「节点末尾」而不是「每次编码之后」：
#    本节点内部最多要编三次 —— 主档位一次，放大重绘 1.25× / 2.0× 各一次
#    （见 cond_at）。中间丢页等于让后面每一次重编码都白花 2~11 秒。
#    放到末尾则一次都不多花：往后就是采样器，编码器确实用不上了。
#
#  为什么不怕「下次运行变慢」：
#    丢的是驻留页，权重还在原 safetensors 里。而且本节点之后马上要跑 20 GB 的
#    扩散模型，那本身就会把编码器的页挤出去 —— 丢与不丢，下次都得重新读。
# ---------------------------------------------------------------------------

def _clip_has_other_user(prompt, unique_id):
    """本轮里除了导演台，还有别的节点要拿同一个 CLIP 吗？

    看本节点的 clip 输入接的是哪个上游节点、哪个输出口，再扫一遍整张图有没有
    第二个节点也接那个口（ComfyUI 按「源节点 + 输出口」缓存同一个对象，所以
    接同一个口 = 拿到同一个 patcher）。

    拿不到图信息（老前端 / 被别处直接调用）时按「没人用」处理：代价只是几秒钟，
    不值得为它牺牲「一律回收」的确定性。
    """
    try:
        if not prompt or unique_id is None:
            return False
        mine = prompt.get(str(unique_id))
        if not isinstance(mine, dict):
            return False
        ref = (mine.get("inputs") or {}).get("clip")
        if not isinstance(ref, (list, tuple)) or len(ref) < 2:
            return False
        src, slot = str(ref[0]), ref[1]
        for nid, node in prompt.items():
            if str(nid) == str(unique_id) or not isinstance(node, dict):
                continue
            for v in (node.get("inputs") or {}).values():
                if (isinstance(v, (list, tuple)) and len(v) >= 2
                        and str(v[0]) == src and v[1] == slot):
                    return True
    except Exception:
        return False
    return False


def _release_clip_when_done(clip, prompt=None, unique_id=None):
    """导演台跑完，把文本编码器占的驻留页交还系统。失败绝不能影响出片。"""
    try:
        patcher = getattr(clip, "patcher", None)
        if patcher is None:
            return
        if _clip_has_other_user(prompt, unique_id):
            print("[H3 导演台] 文本编码器：本轮还有别的节点要用同一路 CLIP，先留着不回收。")
            return
        from .banzhang_vram_cleaner import release_model_residency
        ram_freed, vram_freed = release_model_residency(
            patcher, log=lambda m: print("[H3 导演台] " + str(m)), label="文本编码器")
        if ram_freed or vram_freed:
            print("[H3 导演台] 文本编码器：用完已交还 —— 显存 %.0f MB / 内存 %.0f MB。"
                  "权重仍在原文件里，下次要用会自动读回，不影响重复运行。"
                  % (vram_freed / 1e6, ram_freed / 1e6))
        else:
            print("[H3 导演台] 文本编码器：本轮没有可回收的驻留页（DynamicVRAM 流式加载时不常驻）。")
    except Exception as _e:
        try:
            print("[H3 导演台] 文本编码器回收跳过：%s: %s" % (type(_e).__name__, _e))
        except Exception:
            pass


class CSGlideCast:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 模型口置顶（20261106 用户定）：接上游 MODEL，从第 1 个输出口
                # 交回装好动态前缀 mask 的 MODEL 给 KSampler.model。
                # 界面中文标签由 js/csglide_cast.js 的 pinCastPortLabels 钉「模型」。
                "model": ("MODEL", {
                    "tooltip": "接上游模型；导演台内置动态前缀 mask 后从「模型」口交回。",
                }),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                # NOT multiline: the v2 frontend renders a multiline STRING as a
                # real textarea overlay, which floats over the node's own UI and
                # eats every click in that band. A single-line widget is drawn on
                # the canvas and can be hidden properly.
                "h3_data": ("STRING", {"default": ""}),
            },
            "optional": {
                "audio_vae": ("VAE",),
                "first_frame": ("IMAGE",),
                "last_frame": ("IMAGE",),
                "refs": ("H3_REFS",),
                # 外接提示词：接线即替换面板提示词（模式 A）。面板 st.prompt
                # 永不被外部数据污染——断线即恢复原文。
                "prompt_text": ("STRING", {"forceInput": True}),
                # 外接 h3_data（AI 制片中枢 P1）：接线即整体替换面板配置 JSON，
                # # 断线即恢复面板。供无头编排器逐段注入画布/片长/承接/工程身份。
                "h3_override": ("STRING", {"forceInput": True}),
            },
            # 只用来判断「这个 CLIP 本轮后面还有没有人要用」——
            # 见 _clip_has_other_user。不渲染控件，不影响既有工作流。
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    # 输出端口按「常用优先」重排，隐藏暂时用不到的宽度/高度/源视频/日志四个口：
    # 正面条件 → 正面条件·二采三采 → 潜空间 → 总帧数 → 秒数 → 重叠帧 → 引导帧。
    # ComfyUI 按端口**序号**存连线（不按名字），本次重排后旧工作流接到导演台的
    # 线会整体错位、需手动重连一次——故此处只收敛这一次，之后新增端口一律追加
    # 在末尾（前几个端口不再变动，旧工程即零影响）。
    # 「放大重绘」（正面条件·二采三采）只有一份条件——二采与三采共用
    # （同一级重绘、同一套参考口径），两个端口除了让用户多接一根线之外不带来差异。
    # 第 7 口原「引导帧」（IMAGE，64×64 占位）→「整片潜空间」（LATENT，20261031）：
    # 把时间轴上已归档段落按净长裁头拼接成整条 latent，专供下游 H3终极放大的
    # 时间分块共享轨迹重绘 —— 段间接缝只有进同一条 latent 才落得进窗口重叠区。
    # 端口序号不变（其余 7 根线零影响），但**类型变了**：老工作流里接到本口的
    # 线会类型不匹配，需重连（模板/前端核查过 0 处引用）。
    # 第 8 口「整片」（VIDEO，20261013）：把时间轴上当前整片（最后一段在磁盘上
    # 的累积成片）作为成品视频输出，直连视频合并节点的「🎬 视频文件」口，由它
    # 直接采用、不重新编码。按铁律追加在末尾，旧工作流已有的 7 根线零影响。
    # 20261106 端口重排（用户定）：模型输入/输出都置顶，名字统一「模型」。
    # 注意 ComfyUI 按端口**序号**存连线：旧工作流指向导演台的 8 根线全部
    # +1 才对得上，请用 _migrate_cast_ports.py 批量迁移，不要手工重连。
    RETURN_TYPES = ("MODEL", "CONDITIONING", "CONDITIONING", "LATENT", "INT",
                    "FLOAT", "INT", "LATENT", "VIDEO")
    RETURN_NAMES = ("模型", "正面条件", "正面条件·二采三采", "潜空间", "总帧数",
                    "秒数", "重叠帧", "整片潜空间", "整片")
    FUNCTION = "build"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = "MiniMax H3 导演节点——首/末关键帧或全参考，自动标注参考帧。"

    # ---------------- reference encoding ----------------

    @staticmethod
    def _encode_ref_audio(audio_vae, audio, label="", log=None, cache_key=None):
        if audio_vae is None:
            raise ValueError("H3 Studio: audio references need the audio VAE connected "
                             "(minimax_h3_audio_vae_fp32).")
        # 命中缓存就直接返回，连解码和编码都不发生——重复渲染/多分段渲染时，
        # 那个「音频一长就吃几 GB 显存」的峰值根本不会出现。
        hit = _ref_audio_cache_get(cache_key)
        if hit is not None:
            if log:
                log("音频 %s 复用已缓存的潜空间（%d 帧，本次跳过编码）"
                    % (os.path.basename(label) if label else "(未命名)", hit[1]))
            return hit[0], hit[1]
        waveform = audio["waveform"]
        sr = audio["sample_rate"]
        vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)
        samples_in = int(waveform.shape[-1])
        if sr != vae_sr:
            waveform = resample_waveform(waveform, sr, vae_sr)
        # 音频潜空间 1 帧 = hop = 800 样本 = 1/40 秒（32 kHz）。VAE.encode 内部会
        # 先把样本数向下裁到 hop 的整数倍，不足一帧就剩下 0 样本，撞穿编码器开头
        # k=7 的卷积（"padded input size (6)"）。这里在进 VAE 前一次拦住、报人话，
        # 与视频侧的 MIN_REF_FRAMES 同一思路。
        samples = int(waveform.shape[-1])
        hop = int(audio_vae.spacial_compression_encode()) or 800
        if samples < hop:
            raise _RefAudioTooShort(
                "H3 Studio: audio reference %s is %d samples (%.4f s @ %d Hz) after "
                "resampling from %d samples @ %d Hz; one audio latent frame needs %d "
                "samples (%.4f s). Check the file itself, or its trim window in the "
                "media rack."
                % (label or "(unnamed)", samples, samples / vae_sr, vae_sr,
                   samples_in, sr, hop, hop / vae_sr))
        # 编码执行交给公共层：GPU 优先，预判放不下或 GPU 那条路失败都自动改走
        # CPU（见 csglide_audio_io.encode_audio_latent）。这里不再直接调
        # audio_vae.encode —— 那样会绕过「放不下就先撤到 CPU」的判断，直接撞进
        # 核心那条对本颗 VAE 必然崩的分块回退。
        #
        # 波形进公共层的是 [B, 声道, 采样数] 的原始形态；里面对包装器的
        # movedim(-1, 1) 已经复原过了，不要在这里提前转 channels-last，否则
        # 「声道」会被当成要按 hop 取整的空间轴（2 // 800 = 0，声道被裁没）。
        try:
            z, where = _audio_io.encode_audio_latent(
                audio_vae, waveform, label=os.path.basename(label) if label else "",
                log=log)
        except Exception as e:
            # 两条路都失败了。把「这一步要多少显存」算给用户看——原始报错是
            # 核心退到图像版分块路径后抛出的 tuple 错误，与音频毫无关系。
            raise RuntimeError(
                "H3 Studio: 音频参考「%s」编码失败（%s）。它是 %.1f 秒（%d 样本），"
                "这一步约需 %.1f GB 显存；GPU 与 CPU 两条路都试过了。音频 VAE 的"
                "占用随音频长度线性增长，建议在媒体架上把这条音频的修剪窗口拖短"
                "（或换更短的素材）后重试。"
                % (label or "(未命名)", type(e).__name__, samples / vae_sr,
                   samples, _audio_io.audio_vae_peak_gb(samples, vae_sr))) from e
        _ref_audio_cache_put(cache_key, z, z.shape[-1])
        return z, z.shape[-1]

    def _refs(self, cfg, vae, audio_vae, width, height, frame_count, log=None, ref_scale=1.0):
        ref_items, ref_blocks = [], []
        size_mode = cfg["ref_image_size"]

        def _log(*a):
            if log:
                log(*a)

        # 参考音频的自动长度上限（秒）。刻意做成「用的时候才量」：空闲显存要
        # 在参考图/参考视频的潜空间都占进来之后再读，才是音频 VAE 真能拿到的
        # 那份。视频自带的音轨与独立音频共用同一个上限——两条路都会进音频 VAE
        # 编码，也就都会撞同一个 OOM。
        def _audio_cap():
            return ref_audio_limit_seconds(frame_count)

        for n, slot in enumerate(cfg["images"], start=1):
            if slot is None:
                continue
            img = _load_image(slot["file"])
            h, w = img.shape[1], img.shape[2]
            # 固定长边档位 / match（跟随画布长边）/ max；ref_scale 是二采/三采
            # 条件的档位倍数（1.0 = 与主档位相同）
            if size_mode == "raw":
                # 原图档：官方 max 规则——短边封顶 2048、round 32、永不放大、
                # 不乘二采/三采倍数（官方 max 是安全上限，不是画质档位）。
                scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(w, h))
                tw, th = _round_canvas(w * scale), _round_canvas(h * scale)
            else:
                target = _ref_target_long(size_mode, max(width, height), ref_scale)
                scale = min(1.0, target / max(w, h))   # never upscale, all tiers share this
                tw, th = _fit_long(w * scale), _fit_long(h * scale)
            # 参考图编码缓存（20261023 P1 性能专项）：同文件 + 同编码尺寸直接复用
            # 缩放张量与视频 VAE 潜空间，改文案重跑 / 多分段 / 二采三采不再重复
            # PIL 解码 + lanczos 缩放 + VAE 编码。缓存键与缓存策略见文件前部
            # _ref_image_cache_*。
            img_key = _ref_image_cache_key(slot["file"], tw, th)
            img_hit = _ref_image_cache_get(img_key)
            if img_hit is not None:
                # pixels 喂 Qwen 视觉那一路，clone 一份防止下游就地写污染缓存；
                # latent 下游只做 .to(float32)/.to(device) 的只读消费（与音频缓存同口径）。
                resized = img_hit[0].clone()
                img_latent = img_hit[1]
                _log("图片 @图片%d %s  原图 %dx%d → 编码 %dx%d  潜空间 %dx%d  复用缓存（跳过缩放与 VAE 编码）"
                     % (n, os.path.basename(slot["file"]), w, h, tw, th, th // 16, tw // 16))
            else:
                resized = _resize(img[:1], tw, th, "disabled")
                _log("图片 @图片%d %s  原图 %dx%d → 编码 %dx%d  潜空间 %dx%d"
                     % (n, os.path.basename(slot["file"]), w, h, tw, th, th // 16, tw // 16))
                img_latent = vae.encode(resized)
                _ref_image_cache_put(img_key, resized, img_latent)
            # 验证：resized 全程只物化一次 —— _resize 仅新建这一份张量；vae.encode 只读取它、
            # 返回 latent（非原地）；下面 ref_items["data"] 与下游 _vision_entry 均存引用而非拷贝，
            # 故不会二次物化、不额外占用一份显存。
            ref_items.append({"type": "image", "data": resized})
            ref_blocks.append({"kind": "image", "latent_h": th // 16, "latent_w": tw // 16,
                               "latent": img_latent})
            # 原始全分辨率图片在缩放+编码后不再需要，及时释放其 CPU/显存占用，
            # 避免多图参考时前一张的原始图与下一张叠加峰值。
            del img

        video_size_mode = cfg["ref_video_size"]
        # 面板「抽帧帧率」：只作用于参考视频。调低它，同一时间跨度取到的帧更少
        # （成帧数与后面的 latent_t 一起变小），代价是锚定精度。
        ref_fps = cfg["ref_video_fps"]
        for vi, slot in enumerate(cfg["videos"], start=1):
            if slot is None:
                continue
            start = float(slot.get("start") or 0.0)
            end = slot.get("end")
            end = float(end) if end not in (None, "") else None
            # 媒体架槽位的自定帧率优先（面板「帧率」输入框），未设则用面板抽帧帧率
            slot_fps = float(slot["fps"]) if slot.get("fps") else ref_fps
            frames = _load_video_frames(slot["file"], start, end, frame_count,
                                        scale_to_canvas=True, size_mode=video_size_mode,
                                        canvas_long=max(width, height), fps=slot_fps,
                                        ref_scale=ref_scale)

            # 已在解码阶段按档位等比缩小到目标分辨率，此处直接取缩后分辨率。
            vh, vw = frames.shape[1], frames.shape[2]
            cw, ch = vw, vh
            if frames.shape[0] > frame_count:
                frames = frames[:frame_count]
            n = frames.shape[0]
            if n < MIN_REF_FRAMES:
                raise ValueError(
                    "H3 Studio: %s gave only %d frames after trimming; H3 needs %d. "
                    "Widen the trim, or use the 'last 22f' quick pick."
                    % (slot["file"], n, MIN_REF_FRAMES))
            while n % 17 != 5:
                n -= 1
            frames = frames[:n]
            z = vae.encode(frames)

            # 整段 float32 全帧只在编码阶段用到；之后唯一消费者是半速预览帧。
            # 高级索引会拷贝（拥有独立 storage），因此先抽出预览帧，再释放整段
            # 全帧（约 n*H*W*3*4 字节），避免下一段视频解码时峰值显存叠加。
            # 预览保持 0.5 秒一格：抽帧后每帧的时长变成 stride/slot_fps，步长
            # 必须跟着变，否则调低帧率会把预览也一起放慢。
            stride = max(1, int(slot_fps // 2))
            sample_idx = list(range(0, frames.shape[0], stride))
            sample = frames[sample_idx]
            timestamps = [i * stride / slot_fps for i in range(len(sample_idx))]
            del frames

            audio_latent, ref_audio_t, audio_note = None, 0, ""
            if slot.get("audio"):
                cap = _audio_cap()
                track = _load_video_soundtrack(slot["file"], start, end, max_seconds=cap)
                if track is not None:
                    # 音轨是「参考视频」的附属品：与「无音轨 / 解码失败」同一策略，
                    # 不可用就按静音发，画面照常生效，只在日志里留一句。
                    try:
                        audio_latent, ref_audio_t = self._encode_ref_audio(
                            audio_vae, track, slot["file"], log=_log,
                            cache_key=_ref_audio_cache_key(slot["file"], start, end, cap))
                    except _RefAudioTooShort as e:
                        _log("视频 %s 音轨太短，按静音发送（%s）"
                             % (os.path.basename(slot["file"]), e))
                    else:
                        ref_items.append({"type": "audio"})
                        audio_note = _cap_note(track, start, end, cap)

            ref_items.append({"type": "video", "data": sample, "timestamps": timestamps})
            ref_blocks.append({"kind": "video_audio" if ref_audio_t else "video",
                               "latent_t": z.shape[2], "latent_h": ch // 16, "latent_w": cw // 16,
                               "ref_audio_t": ref_audio_t, "latent": z, "audio_latent": audio_latent})
            _log("视频 @视频%d %s  成帧 %d  抽帧 %dfps  画布 %dx%d  含音轨=%s  参考音频时间=%d%s"
                 % (vi, os.path.basename(slot["file"]), n, slot_fps, cw, ch,
                    "是" if ref_audio_t else "否", ref_audio_t, audio_note))

        for n, slot in enumerate(cfg["audios"], start=1):
            if slot is None:
                continue
            end = slot.get("end")
            a_start = float(slot.get("start") or 0.0)
            a_end = float(end) if end not in (None, "") else None
            cap = _audio_cap()
            track = _load_audio(slot["file"], a_start, a_end, max_seconds=cap)
            # 截断提示按**原始素材**判，循环之后再判会把铺满后的长度当成截断结果。
            note = _cap_note(track, a_start, a_end, cap)
            if REF_AUDIO_LOOP:
                track, loops, _have = _loop_ref_audio_to_length(
                    track, cap, log=_log)
            else:
                loops = 1
            audio_latent, ref_audio_t = self._encode_ref_audio(
                audio_vae, track, slot["file"], log=_log,
                cache_key=_ref_audio_cache_key(slot["file"], a_start, a_end,
                                               cap, loops))
            ref_items.append({"type": "audio"})
            ref_blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t,
                               "audio_latent": audio_latent})
            # 覆盖率是音色能不能克隆上的唯一分界线（20261026 实测：覆盖 100%
            # 时成片基频 +6%、音色余弦 0.98；覆盖 76% 时 +41%~+91%、余弦 0.85~0.93，
            # 等于换了一把嗓子）。所以不打马赛克地写在日志主行上，且没满就报 ⚠。
            want_t = _audio_ref_frames_for(cap, audio_vae)
            cover = 100.0 * ref_audio_t / want_t if want_t else 100.0
            # 潜空间统计只为排查：模型不吃参考时，先要排除「送进去的是一堆零」
            # 或者「量纲比目标音频大两三个数量级」这种编码事故。
            try:
                _st = audio_latent.float()
                stat = "  潜空间 %.3f±%.3f 峰%.2f" % (
                    float(_st.mean()), float(_st.std()), float(_st.abs().max()))
                del _st
            except Exception:
                stat = ""
            _log("音频 @音频%d %s  参考音频时间=%d / 目标 %d（覆盖 %.0f%%）%s%s%s"
                 % (n, os.path.basename(slot["file"]), ref_audio_t, want_t,
                    cover,
                    "" if cover >= 99.5 else
                    "  ⚠ 参考没铺满，没覆盖到的部分模型会退回自己的嗓音",
                    stat, note))

        return ref_items, ref_blocks

    # ---------------- audio driver（时间轴音频 = 驱动，不进 ref_audios）----------------

    @staticmethod
    def _driver_silence_latent(audio_vae, a, log):
        """编码一段全零波形，拿到**真静音**的音频 latent（全局缓存，只算一次）。

        零 latent 解码出来是固定低频底噪，不是静音；所以尾部不能填 zeros，
        必须让 audio VAE 亲自编码一段静音波形。20261111 用它替掉「循环本段
        旋律」，断链 / 末段音源不够时不再出现「又唱了一遍」。
        """
        try:
            sr = int(getattr(audio_vae, "audio_sample_rate", 32000) or 32000)
            hop = int(audio_vae.spacial_compression_encode()) or 800
            wav = torch.zeros(1, 1, max(hop * 2, sr // 20), dtype=torch.float32)
            z, _ = CSGlideCast._encode_ref_audio(
                audio_vae, {"waveform": wav, "sample_rate": sr},
                "驱动尾部静音", log=log,
                cache_key="driver|silence|%d|%d" % (sr, hop))
            return z.to(device=a.device, dtype=a.dtype)
        except Exception as e:
            log("⚠【驱动】真静音 latent 编码失败（%s）—— 尾部改用本段末格拖尾，"
                "不循环重放整段。" % e)
            return None

    def _driver_prev_latent(self, audio_vae, all_drv, rows, clip, a, log):
        """承接头要的是**上一段驱动的末尾**，不是静音。

        承接头画面是上一段末尾的重绘，声音同理。上一段切片覆盖成片时间轴上
        本段 clip_from 之前的连续区间，取它末尾 head 格即可，不用重切片、
        不用新增档案字段。读不到就返回 None，由调用方用**真静音 latent**
        兜底 —— 绝不退回零 latent、不退化成本段自己，也不循环重放整段。
        """
        ids = [str(r.get("id") or "") for r in rows]
        i = ids.index(clip) if clip in ids else -1
        if i <= 0:
            return None
        prev = ids[i - 1]
        pfile = str((all_drv.get(prev) or {}).get("file") or "")
        if not pfile:
            log("【驱动】%s 的承接头上一段 %s 没有驱动音频，"
                "改用真静音 latent 补齐，不重放本段。" % (clip, prev))
            return None
        try:
            zp, _ = self._encode_ref_audio(
                audio_vae, _load_audio(pfile, 0, None), pfile, log=log,
                cache_key="driver|%s|%s" % (prev, pfile))
            if tuple(zp.shape[:-1]) != tuple(a.shape[:-1]):
                raise ValueError("形状 %s 与声音流不符" % (tuple(zp.shape),))
            return zp.to(device=a.device, dtype=a.dtype)
        except Exception as e:
            log("⚠【驱动】%s 的承接头上一段音频读不到（%s），"
                "改用真静音 latent 补齐，不重放本段。" % (clip, e))
            return None

    def _apply_driver(self, cfg, audio_vae, latent, frame_count, log, prompt=None):
        """把本段的驱动音频写进 H3 的 **AV latent 声音流**并锁噪。

        20261107 用户定：时间轴上的音频只做驱动、不做参考。参考素材由用户
        手动摆进媒体架/文案台，那边走既有的 refs → @音频N → ref_audios 链路，
        与本通道完全分离。20261108 用户再定：驱动音频**绝不**复制一份进参考
        通道（不写 @音频N、不进 ref_audios），代码和日志都不给这类引导。
        后端 auto_slice 把每段（多轨混音后）的驱动切片写进
        meta["bzsa.driver"][cid]。

        20261108 根因修复：段身份与时间坐标统一读项目既有的**单一真值源**，
        不再各自定义、不再靠「差几格往尾部补零」猜：
          · 身份 `resolve_clip_id()`（显式 clip 优先，缺失时按 shot uid 反查），
            与承接档定位 / 自动收片 / 视频合并同口径；裸提交也认得出段。
          · 坐标 `film_summary` 本段 row 的 film_head / trim_frames / clip_from /
            clip_to —— auto_slice 切片、前端时间轴、播放落点、成片裁切都读它。
            驱动音频落在净长区间，承接头位于**头部**并锁噪静音。
          以前把「净长 vs 全长」的差值补在尾部，音频相对新画面提前整个承接头。

        必须在 _attach_pin 之后调用：钉帧会重建 noise_mask，早写会被盖掉。
        老工程没有 bzsa.driver（或 v != 1）→ 原样返回，仍按用户手动摆进媒体架
        的参考素材工作（时间轴始终不往参考通道送东西）。
        所有「本次不驱动」的分支都打日志，绝不静默退化。
        """
        chain_ref = cfg.get("chain") or {}
        name = str(chain_ref.get("name") or "").strip()
        if not name:
            log("【驱动】本次没填片名（导演台单段工作），时间轴驱动通道不启用。")
            return latent
        try:
            from ..core import csglide_store as _st
            from .. import csglide_chain as _chain
            from ..core.csglide_ticket import resolve_clip_id
        except Exception as e:
            log("⚠【驱动】工程模块没读到，本次不驱动：%s" % e)
            return latent
        clip = resolve_clip_id(name, chain_ref.get("clip"),
                               chain_ref.get("shot"), _chain.film_summary)
        if not clip:
            log("⚠【驱动】认不出本段 id（clip 与 shot 都没对上工程「%s」的档案），"
                "本次不驱动；请从导演台时间轴正常提交，别直接 Queue 裸工作流。" % name)
            return latent
        try:
            d = _st.chain_dir(name)
        except Exception as e:
            log("⚠【驱动】工程目录解析失败，本次不驱动：%s" % e)
            return latent
        if not d or not _st.has_db(d):
            log("【驱动】工程「%s」还不是状态库工程（老 JSON 档案），驱动通道不启用。" % name)
            return latent
        # 坐标真值源：与 auto_slice 切片、前端时间轴、成片裁切读同一份段档案。
        try:
            rows = (_chain.film_summary(name).get("clips") or [])
            row = next((r for r in rows if str(r.get("id") or "") == clip), {}) or {}
        except Exception as e:
            log("⚠【驱动】段档案读不到坐标，本次不驱动：%s" % e)
            return latent
        if not row:
            log("⚠【驱动】%s 在段档案里找不到对应行，本次不驱动（请重新拖入音频重排）。" % clip)
            return latent
        all_drv = {}
        try:
            conn = _st._connect(d, create=False)
            if conn is None:
                log("⚠【驱动】工程库打不开，本次不驱动。")
                return latent
            all_drv = _st._meta_get(conn, "bzsa.driver", {}) or {}
            info = all_drv.get(clip) or {}
        except Exception as e:
            log("【驱动】读工程库失败，本次不驱动：%s" % e)
            return latent
        if not isinstance(info, dict) or not info:
            log("【驱动】%s 没有驱动音频（时间轴没拖音频，或音频比全片短），"
                "本段按无驱动生成。" % clip)
            return latent
        if int(info.get("v") or 0) != 1:
            log("⚠【驱动】%s 的驱动数据是旧格式（v=%s），已跳过；重新拖一次音频即可。"
                % (clip, info.get("v")))
            return latent
        if not info.get("file"):
            log("⚠【驱动】%s 的驱动条目没有文件字段，本次不驱动。" % clip)
            return latent
        if audio_vae is None:
            log("⚠【驱动】%s 有驱动音频，但导演台没接 audio_vae"
                "（应接 minimax_h3_audio_vae_fp32）—— 成片仍会出，但画面不受音频驱动。"
                % clip)
            return latent
        try:
            track = _load_audio(str(info["file"]), 0, None)
            z, _zt = self._encode_ref_audio(
                audio_vae, track, str(info["file"]), log=log,
                cache_key="driver|%s|%s" % (clip, info["file"]))
        except Exception as e:
            log("⚠【驱动】读不到 / 编码不了驱动切片，本次不驱动：%s" % e)
            return latent
        try:
            parts = list(latent["samples"].unbind())
            if len(parts) < 2:
                log("⚠【驱动】这份潜空间没有声音流，写不进驱动音频。")
                return latent
            v, a = parts[0], parts[1]
            z = z.to(device=a.device, dtype=a.dtype)
            if tuple(z.shape[:-1]) != tuple(a.shape[:-1]):
                raise ValueError("驱动潜空间形状 %s 与声音流 %s 不符"
                                 % (tuple(z.shape), tuple(a.shape)))
            total = int(a.shape[-1])
            head_frames = int(row.get("film_head") or row.get("trim_frames") or 0)
            # 20261111 断链音频错位修复：档案里的 film_head / trim_frames 是
            # **上一次生成**留下的旧账（head_unlinked 的注释写得很清楚），不能
            # 拿来判「本次要不要接」。断链后画面头部独立起头、成片也不剪头，
            # 声音流若还按旧账把前 N 格让给上一段末尾，本段驱动就整体后移
            # N 格、开头还混进上一段尾音 —— 听感就是「音频不对」。
            # 与 _continuation / 承接窗口 / 动态前缀 mask 用同一个判据。
            if head_unlinked(cfg):
                if head_frames:
                    log("【驱动】本段已「取消接续」—— 头部独立起头，档案里"
                        "记录的承接头 %d 帧是上一次生成的旧账，本次音频一律"
                        "从第 0 格起（不挪走一截、不混上一段尾音）。"
                        % head_frames)
                head_frames = 0
            seg_net = int(row.get("clip_to") or 0) - int(row.get("clip_from") or 0)
            # 一致性校验的真值源是驱动 wav 编码后的**实际格数**，不是段档案，
            # 也不是 bzsa.driver 的 from/to（后者抄自切片当时的段档案，段长改过
            # 副本一起失真，等于自己比自己）。
            head_grids, body_grids, warn = driver_stream_placement(
                frame_count, total, head_frames, int(z.shape[-1]))
            if warn:
                log("⚠【驱动】" + warn)
            # 声音流每格都要有有效音频 latent：零 latent 解码出来是固定低频底噪，
            # 承接头与末段尾部以前都栽在这里。
            z_sil = self._driver_silence_latent(audio_vae, a, log)
            # 承接头默认给真静音，绝不退化成本段自己：上一段驱动读不到时，
            # 旧写法 z_prev = z 会让段头响起段尾的音乐（单段内头尾重复）。
            z_prev = (z_sil if (z_sil is not None and int(z_sil.shape[-1]) > 0)
                      else z[..., -1:])
            if head_grids > 0:
                zp = self._driver_prev_latent(audio_vae, all_drv, rows, clip, a, log)
                if zp is not None:
                    z_prev = zp
            stream, n = driver_stream_latents(
                z, z_prev, head_grids, body_grids, z_sil=z_sil)
            cut = int(z.shape[-1]) - n
            parts[1] = stream
            latent["samples"] = comfy.nested_tensor.NestedTensor(parts)
            # 锁噪：画面流 mask 原样保留（承接钉帧不能被抹掉），声音流整段 0
            # —— 承接头、驱动、尾部静音都不许模型自己另生成一段声音。
            m = latent.get("noise_mask")
            if m is not None and getattr(m, "is_nested", False):
                vm = list(m.unbind())[0]
            elif m is not None:
                vm = m
            else:
                vm = torch.ones((v.shape[0], 1) + tuple(v.shape[2:]),
                                dtype=torch.float32, device=v.device)
            am = torch.zeros((a.shape[0], 1) + tuple(a.shape[2:]),
                             dtype=torch.float32, device=a.device)
            latent["noise_mask"] = comfy.nested_tensor.NestedTensor((vm, am))
        except Exception as e:
            log("⚠【驱动】写 AV 潜空间失败，本次不驱动：%s" % e)
            return latent
        if info.get("音源被裁短"):
            log("【驱动】%s 的音源只到 %.3f 秒（本段设定 %.3f 秒）—— "
                "按剩余音频实际时长驱动，不补静音凑满设定秒数；"
                "末段画面已按剩余音频缩短，缺的那截是真静音，不会重复本段旋律。"
                % (clip, float(info.get("有效秒") or 0),
                   float(info.get("段长秒") or 0)))
        log("【驱动】%s · %d 轨%s → 声音流 %d 格 = 承接头 %d 格（上一段末尾音乐）"
            "+ 驱动 %d 格（成片净长 %d 帧）+ 尾部 %d 格（真静音，不重放本段）；"
            "整条流无零 latent，noise_mask 全 0，"
            "画面流 mask 原样保留。时间轴音频只做驱动，不进媒体架 / 文案台 / "
            "ref_audios 任何参考通道。"
            % (clip, int(info.get("tracks") or 1),
               "混音" if int(info.get("mix") or 0) else "单轨",
               total, head_grids, n, seg_net, body_grids - n))
        if cut > 1:
            log("【驱动】%s 的音频比本段净长多 %d 格，已按净长截断"
                "（末段音频富余属正常，不影响对齐）。" % (clip, cut))
        self._check_driver_downstream(prompt, log)
        return latent

    @staticmethod
    def _check_driver_downstream(prompt, log):
        """画布链路自检：只报点、不拦跑。

        核心 VAEDecode / VAEDecodeTiled 自带 `if latent.is_nested: unbind()[0]`，
        采样器也会把扁平包重新包回 NestedTensor，所以**不需要额外节点**。真正
        要留意的是采样之后、解码之前的中间 latent 节点（第三方放大/重绘类）：
        它们既要能透传 NestedTensor，也**不能重建 noise_mask** —— 声音流靠
        mask=0 锁噪，重建一次锁噪就丢，驱动会静默退化成「只是塞了段音频」。
        """
        if not isinstance(prompt, dict):
            return
        safe = {"VAEDecode", "VAEDecodeTiled", "LTXVSeparateAVLatent",
                "LTXVConcatAVLatent", "CSGlideCastCS", "SetLatentNoiseMask",
                "LatentUpscale", "LatentUpscaleBy"}
        names = set()
        for v in prompt.values():
            if not isinstance(v, dict):
                continue
            ct = str(v.get("class_type") or "")
            low = ct.lower()
            if ct in safe:
                continue
            if any(k in low for k in ("latent", "sampler", "selflift",
                                      "upscale", "redraw", "h3")):
                names.add(ct)
        if names:
            log("⚠【驱动】采样后 → 解码前若经过这些节点，请确认它们支持"
                " NestedTensor（AV 双流 latent）且不会重建 noise_mask："
                + "、".join(sorted(names)) + "。声音流靠 mask=0 锁噪，"
                "中间节点重建一次 mask 锁噪就丢。核心 VAEDecode 已自动只解画面流，"
                "无需再加分离节点。")

    # ---------------- continuation ----------------

    def _continuation(self, cfg, vae, audio_vae, latent, width, height, frame_count, log=None):
        """Anchor the previous clip's tail at frame 0 of this one.

        Writes the same conditioning MiniMaxH3AddGuide writes - one keyframe
        holding the whole run as a single encoded block at resolved_frame_index
        0 - rather than calling that node, so the tail can be taken from the
        right end and levelled before the encode.

        Returns (keyframe or None, frames anchored, the frames themselves).
        The frame count is the
        head that comes back in the output and has to come off before the clip
        is joined to its predecessor.
        """
        def _log(*a):
            if log:
                log(*a)

        cont = cfg.get("cont")
        if not cont:
            return None, 0, None
        if head_unlinked(cfg):
            _log("延续：本段与上一段**断链**（时间轴上的「取消接续」）—— 文件档也"
                 "不承接，整段从零生成、不剪头。要让这一段重新接上，先按一次"
                 "「⛓ 恢复接续」再重跑。")
            return None, 0, None
        if int(cont.get("frames") or 0) <= 0:
            # 承接帧数 0 = 独立成段（20261029 起的默认值）。想接就把时间轴上这一
            # 段的「承接帧数」调大，不用改任何开关。
            _log("延续：本段承接帧数为 0（独立成段）—— 不承接上一段，整段从零生成。")
            return None, 0, None

        want = snap_guide_run(cont["frames"])
        if want < MIN_REF_FRAMES:
            raise ValueError(
                "H3 Studio: a continuation needs at least %d frames. Usable runs "
                "are 5, 22, 39, 56, 73." % MIN_REF_FRAMES)
        if want >= frame_count:
            raise ValueError(
                "H3 Studio: continuing from %d frames into a %d frame clip leaves "
                "nothing new. Shorten the window or lengthen the clip."
                % (want, frame_count))

        # a little slack, then snap down and keep the TAIL - a window that lands
        # between source frames can come back one short or one long, and either
        # way the run must finish on the previous clip's last frame
        # by position, so the run really does finish on the clip's last frame -
        # falls back to the timestamp path for anything not at FPS
        frames = _load_video_tail(cont["file"], want + 17, cont["start"])
        if frames is None:
            frames = _load_video_frames(cont["file"], cont["start"], cont["end"], want + 17)
        # Snap LAST. It used to be min(snap(available), want), which returns
        # `want` untouched whenever want is the smaller of the two - and want
        # comes from the browser's window, which on mkv can round to 23 or 24
        # where the file really holds 22. Anything that is not 17k+5 makes the
        # model reserve rows for one more latent frame than the encode produces,
        # which is the constant shape mismatch: same size every time for a given
        # canvas, a different size for every canvas.
        n = snap_guide_run(min(frames.shape[0], want))
        if n < MIN_REF_FRAMES:
            raise ValueError(
                "H3 Studio: %s gave only %d frames in that window; H3 needs %d. "
                "Widen the window." % (cont["file"], frames.shape[0], MIN_REF_FRAMES))
        frames = frames[-n:]

        frames = flatten_exposure(frames, cont["flatten"])
        frames = _resize(frames, width, height, "center")
        keyframe = {"resolved_frame_index": 0, "latent": vae.encode(frames)}

        # Fail fast on a guide the model cannot pack. PackedLayout reserves rows
        # for this block from the TARGET canvas grid - n = vt * (target_h//2 *
        # target_w//2), model.py:380 - yet fills them from patchify_video() of the
        # guide's OWN latent, model.py:539. When those two spatial grids disagree
        # the row counts never differ by "a bit": sampling blows up with
        # "value tensor of shape [A, 96] cannot be broadcast to indexing result of
        # shape [B, 96]" (model.py:706) and nothing in the traceback says why.
        # Compare the two grids here, while the canvas is still in hand, so the
        # user gets one readable sentence instead of a seven-times row count.
        try:
            kf = keyframe["latent"]
            tgt = latent["samples"].tensors[0]
            kf_h, kf_w = int(kf.shape[3]), int(kf.shape[4])
            tg_h, tg_w = int(tgt.shape[3]), int(tgt.shape[4])
            kf_rows = (kf_h // 2) * (kf_w // 2)
            tg_rows = (tg_h // 2) * (tg_w // 2)
            if kf_rows != tg_rows:
                raise ValueError(
                    "H3 Studio: 续写来源的引导潜空间与目标画布网格不一致——引导 %s"
                    "（空间 %dx%d → patch 行 %d）对目标画布 %dx%d（空间 %dx%d → patch 行 %d）。"
                    "H3 按目标网格预留行数、却按引导自身网格填充，两者不等就是那个 "
                    "cannot be broadcast 的形状错误。请让续写来源与本次画布同分辨率，"
                    "或重载工作流 / 重启 ComfyUI 清掉过期缓存后重试。"
                    % (tuple(kf.shape), kf_h, kf_w, kf_rows,
                       width, height, tg_h, tg_w, tg_rows))
        except ValueError:
            raise
        except Exception as e:
            _log("延续 形状校验跳过 (%s)" % e)

        # The shape mismatch reports live here. The model reserves rows from the
        # SHAPE of this guide latent and then fills them from the same tensor, so
        # if those two disagree the numbers below say by how much - and whether
        # the guide is a legal 17k+5 run in the first place.
        try:
            _log("延续 帧数窗口=%d  画布=%dx%d  引导潜空间=%s  目标潜空间=%s  片段帧数=%d"
                 % (n, width, height, tuple(keyframe["latent"].shape),
                    tuple(latent["samples"].tensors[0].shape), frame_count))
        except Exception as e:
            _log("延续 形状报告不可用 (%s)" % e)

        if cont["audio"]:
            # end=None: to EOF, so the carried sound finishes where the
            # picture does rather than at a duration the browser rounded
            # 上限同样要接上：续写音轨和参考音轨走的是同一个音频 VAE，
            # 一样会先撞显存、再撞 latent_dim=2 的分块回退死路。
            cap = ref_audio_limit_seconds(frame_count)
            track = _load_video_soundtrack(cont["file"], cont["start"], None,
                                           max_seconds=cap)
            if track is None:
                _log("延续 %s 无音轨，仅画面" % cont["file"])
            else:
                _got = _trimmed_duration(track)
                if _got + 1e-6 >= cap:
                    _log("延续 %s 音轨已按上限自动截到 %.1fs"
                         % (os.path.basename(cont["file"]), _got))
                audio_latent, audio_rt = None, 0
                try:
                    audio_latent, audio_rt = self._encode_ref_audio(
                        audio_vae, track, cont["file"], log=_log,
                        cache_key=_ref_audio_cache_key(cont["file"], cont["start"], None, cap))
                except _RefAudioTooShort as e:
                    _log("延续 %s 音轨太短，仅画面（%s）" % (cont["file"], e))
                if audio_rt > 0:
                    # anchored at frame 0, so the whole of this clip's audio grid is
                    # available; crop only if the window somehow overruns it
                    max_rt = int(latent["samples"].tensors[1].shape[-1])
                    if audio_rt > max_rt:
                        audio_latent = audio_latent[..., :max_rt].clone()
                    keyframe["audio_latent"] = audio_latent

        _log("延续 %d 帧取自 %s @ 帧0%s，重叠 %d"
             % (n, cont["file"], "（已压平）" if cont["flatten"] > 0 else "", n))
        return keyframe, n, frames

    def _continuation_latent(self, cfg, vae, cond, latent, width, height,
                             frame_count, log=None):
        """潜空间续写：上一片段的采样潜空间直接切片，复用 Motion Context 算术。

        与 _continuation（文件档）的区别：不走「解码成像素 → 缩放 → 重编码」的
        有损往返，钉住的画面位对位；声音窗口结束于接缝、向后倒推，是真正接上
        而不是重放一段像的。代价：分辨率必须一致（latent 无法缩放），且没有
        像素帧，曝光压平（flatten_exposure）不适用——亮度跳变交给拼接侧的
        「对齐亮度」兜底。

        返回 (挂好钉帧的条件, 剪头帧数)。条件已由 Motion Context 组装完毕
        （含 last_frame 锚保留、钉头内锚丢弃），调用方直接替换，不再追加。
        """
        def _log(*a):
            if log:
                log(*a)

        # 续接 = 用户明确要的动作，默认不接（20261029）。主开关就是**承接帧数**：
        # 时间轴上给这一段填的「承接帧数」> 0 才接，默认 0 = 独立成段。只凭"轴上
        # 有上一段"就自动接，等于替用户决定 —— 那正是"取消了还在承接"的根源。
        if int((cfg.get("cont") or {}).get("frames") or 0) <= 0:
            _log("延续（潜空间）本段承接帧数为 0（独立成段）—— 不承接上一段。"
                 "要接就把时间轴上这一段的「承接帧数」调大（5/22/39/56…）。")
            return cond, 0
        # 有承接帧数还不够，轴上得真有上一段可接（第一段当然没有）。
        _has_prev = False
        try:
            _ch = cfg.get("chain") or {}
            _nm = str(_ch.get("name") or "")
            _ci = str(_ch.get("clip") or "")
            from .. import csglide_chain as _c0
            from ..core.csglide_ticket import resolve_clip_id
            # 提交编译清空 clip → 按 shot uid 反查本段 id（与 _register_clip 同口径）
            _ci = resolve_clip_id(_nm, _ci, str(_ch.get("shot") or ""),
                                  _c0.film_summary)
            if _nm and _ci:
                _order0 = [str(c) for c in (_c0.load_chain(_nm).get("order") or [])]
                _has_prev = (_ci in _order0) and _order0.index(_ci) > 0
        except Exception:
            _has_prev = False
        if not (cfg.get("cont") or {}).get("latent_file") and not _has_prev:
            # 用户把承接帧数填成 > 0 = 明确要续接。此时静默「按首段处理」或
            # 按目录 mtime 猜档，都是拿别的段/别的片的档接上，接缝必然撕裂。
            raise RuntimeError(
                "H3 导演台：本段承接帧数 %d > 0（明确要续接），但轴上没有上一段、"
                "也没有承接档凭据（cont_saved）。已拒绝静默按首段处理 / 按目录猜档。"
                "处理：先用「▶ 全部渲染」跑上一段让它写档，或把承接帧数设为 0 "
                "表示独立成段。"
                % int((cfg.get("cont") or {}).get("frames") or 0))

        if _MC_Node is None:
            raise RuntimeError(
                "H3 Studio: 潜空间续写依赖 _h3mc（Motion Context）组件，但它没有"
                "加载成功。请查看启动日志里的报错，或把续写档位切回「文件」。")
        # 潜空间档承接**上一段**的尾部存档。认段从"猜"改成"记"（20261010）：
        # 上一段跑完收片时，它写出的续拍存档路径已落进它的档案
        # （take_params.cont_saved，见 csglide_chain.adopt_film）—— 下一段
        # 直接按记录取，精确认段。目录里 mtime 最新可能是别的段/别的工程
        # 写的，拿错了就是"自己接自己"，接缝直接撕裂。
        # 没记录的老段退回目录按新旧扫；再不行才拿全局最新。
        latest = None
        prev_clip_id = None
        prev_end = None
        prev_row = None
        try:
            from .. import csglide_chain as _chain
        except Exception:
            _chain = None
        chain_ref = cfg.get("chain") or {}
        _name = chain_ref.get("name") or ""
        _cid = chain_ref.get("clip") or ""
        # 20261107 真机：提交编译清空 clip 后这里拿不到本段 id，
        # order.index(_cid) 永远失败 → prev_clip_id 为空 → 承接档定位失败 →
        # strict 模式直接中止，连采样都没开始。按 shot uid 补一次解析。
        if _chain is not None and _name and not _cid:
            try:
                from ..core.csglide_ticket import resolve_clip_id
                _cid = resolve_clip_id(
                    _name, "", str(chain_ref.get("shot") or ""),
                    _chain.film_summary)
                if _cid:
                    _log("延续（潜空间）按 shot uid 认到本段 %s" % _cid)
            except Exception:
                _cid = ""
        if _chain is not None and _name and _cid:
            try:
                # chain.order 存的是**段落 id 字符串**，不是段落对象
                order = [str(c) for c in
                         (_chain.load_chain(_name).get("order") or [])]
                k = order.index(_cid) if _cid in order else -1
                if k > 0:
                    prev_clip_id = order[k - 1]
                    for r in (_chain.film_summary(_name).get("clips") or []):
                        if r.get("id") == prev_clip_id:
                            prev_end = int(r.get("clip_to") or 0)
                            prev_row = r
                            break
            except Exception:
                prev_clip_id = None
                prev_end = None
        # 承接窗口（20261010bd · 方案 B；20261108 特殊接法 UI 已删）：
        # 老档案里若还留着显式 pins（「钉住谁的哪一头」），统一在这里走
        # csglide_pins 的算术，区别只在钉子放在头部还是尾部。
        # 新工程 pins 恒为空，走下面的段序回退（自动接续）。
        # pins 优先于面板的「引用」开关：它是明写的指令，不是靠 mtime 猜的。
        # 左接缝「断链」：这一段与上一段衔接处**不接续**（用户在时间轴上对这
        # 一段左缘标的 unlink）。语义是头部独立起头 —— 不承接任何段的尾巴：
        #   · 头钉一律去掉（尾钉属右接缝、与上一段无关，保留）；
        #   · 下面也不再走「没有 pins 就默认续写 prev」那条退路；
        #   · 头部承接窗口 trim_frames=0，成片拼接不裁头。
        _pins = []
        _head_unlink = False
        if _chain is not None and _name and _cid:
            try:
                _pins = _chain.pins_of(_name, _cid) or []
            except Exception:
                _pins = []
            try:
                _tr = _chain.transitions_of(_name)
                if str(_cid) in _tr and str(
                        (_tr.get(str(_cid)) or {}).get("type")) == "unlink":
                    _head_unlink = True
            except Exception:
                _head_unlink = False
            if _head_unlink:
                _pins = [p for p in _pins if str(p.get("at")) != "head"]
        if _pins:
            from .. import csglide_pins as _pinsmod
            try:
                _srcs = _pinsmod.resolve_sources(
                    _name, _cid, log=_log, drop_head=_head_unlink)
                cond, _h, _t = _pinsmod.build(cond, latent, _srcs,
                                              frame_count, log=_log)
            except Exception as e:
                raise RuntimeError(
                    "H3 Studio: 承接窗口（pins）组装失败 —— %s。"
                    "清掉这一段的承接窗口即可退回「自动接续」。" % e)
            # 钉住的那两截交付时要剪掉：头上是上一段末尾的重绘，尾上是后一段
            # 开头的重绘。写进档案，时间轴/保存成片才知道本段新画面是哪一段。
            try:
                _chain.update_clip(_name, _cid,
                                   {"trim_frames": int(_h), "trim_tail": int(_t)})
            except Exception:
                pass
            _log("延续（承接窗口）剪头 %d 帧、剪尾 %d 帧 —— 本段新画面 %d 帧。"
                 % (_h, _t, frame_count - _h - _t))
            return cond, _h
        if _head_unlink:
            # 断链且没有尾钉：整段独立，头部一帧都不承接。
            try:
                _chain.update_clip(_name, _cid, {"trim_frames": 0})
            except Exception:
                pass
            _log("延续：这一段与上一段**断链**（接缝不接续）—— 头部独立起头，"
                 "不承接上一段尾帧，按本段的第一段处理。")
            return cond, 0

        cands = []
        prev_saved = None
        prev_saved_of = ""
        if _chain is not None and _name and prev_clip_id:
            try:
                pm = _chain.load_clip(_name, prev_clip_id) or {}
                tp = (pm.get("take_params") or {}).get(
                    str(pm.get("current_take") or 1)) or {}
                ps = str(tp.get("cont_saved") or "")
                prev_saved_of = str(tp.get("cont_saved_of") or "")
                if ps and os.path.isfile(ps):
                    prev_saved = ps
            except Exception:
                prev_saved = None
        # 认档凭据校验（2-A）：上一段档案里记了「这份承接档属于哪一段」。对不上
        # 就是拿错档了（mtime 兜底串进了别的段 / 别的片）——直接报错中止，绝不
        # 静默拿错档去接：接缝撕裂还查不出根因，比"接不上"更糟。
        if prev_saved and prev_saved_of and prev_saved_of != str(prev_clip_id):
            raise RuntimeError(
                "H3 Studio：上一段（%s）的承接档凭据对不上——档案记录这份档属于 %s。"
                "说明承接档来源被串改（目录扫描拿错段 / 别的片）。已中止本段。\n"
                "  处理：重跑上一段让它重新写档，或删掉 output/h3_context/ 里的"
                "错误存档后重试。" % (prev_clip_id, prev_saved_of))
        # 20261107 修订：保留「绝不按 mtime 猜档」的原则，但补一条确定性兜底。
        # 优先级：档案里的 cont_saved 凭据 → 按段号精确构造的上一段当前 take
        # 档路径（不扫目录、不比时间）→ 都没有才报错。
        import os as _os
        if prev_saved:
            cands = [prev_saved]
        elif _chain is not None and _name and prev_clip_id:
            try:
                # 方案一：认档案里实际写盘的阶段档，而不是按 current_take 盲拼。
                # 一采/二采曾分裂到不同 take，cont_saved 与盲拼都指向没写过的
                # 文件；clip_cont_resolve 从当前 take 往回认最近一版真在盘上的
                # stages[stage]，只读上一段自己的档案，绝不按目录 mtime 猜档。
                resolved = _chain.clip_cont_resolve(
                    _name, prev_clip_id, _chain.current_stage(_name))
                if resolved:
                    cands = [resolved]
                    _log("延续（潜空间）无 cont_saved 凭据，按阶段认到实际写盘档 %s"
                         % _os.path.basename(resolved))
            except Exception:
                cands = []
        if not cands:
            raise RuntimeError(
                "H3 导演台：本段要续接 %s，但找不到它的承接档 —— 档案里没有登记，"
                "它自己文件夹里也没有这一版的文件。已拒绝按目录猜档"
                "（那会接到别的段 / 别的片）。\n"
                "  处理：回到上一段点一次渲染（跑完会自动写档）；如果这段本来就"
                "不需要承接，把「承接帧数」设为 0，独立成段。"
                % (prev_clip_id or "上一段"))

        context_latent = None
        latest = None
        tried = []
        if cands and _MC_Load is None:
            raise RuntimeError(
                "H3 Studio: _h3mc（Motion Context）组件没有加载成功，"
                "无法读取续拍存档。请查看启动日志，或把续写档位切回「文件」。")
        for c in cands:
            lat = _MC_Load().load(c, 1)[0]
            sv = _mc_streams(lat)[0]
            if sv.ndim == 4:
                sv = sv.unsqueeze(0)
            w0, h0 = int(sv.shape[4]) * 16, int(sv.shape[3]) * 16
            if (w0, h0) == (width, height):
                context_latent, latest = lat, c
                break
            tried.append("%s 是 %dx%d" % (os.path.basename(c), w0, h0))
        if context_latent is None and tried:
            # 分辨率提前用中文拦下，并给出两条能立刻执行的路。
            # 上一段当前版自己的画布一并摆出来（20261010 版本绑参数）：它就是
            # 该对齐的那个数 —— 报错让人对不上号，比报错本身更耽误事。
            pv = ""
            if prev_row and prev_row.get("w") and prev_row.get("h"):
                pv = ("上一段当前版（第 %s 版）的画布是 %dx%d —— 潜空间续写"
                      "要对齐的就是它。"
                      % (prev_row.get("take"), prev_row["w"], prev_row["h"]))
            raise ValueError(
                "H3 Studio: 上一段的续拍存档与本次画布分辨率不一致（%s；本次画布 "
                "%dx%d）。%s潜空间无法缩放 —— 要么把上一段按 %dx%d 重新生成一次"
                "（推荐，保住潜空间档的无缝接续），要么把续写档位切回「文件」"
                "（文件档走像素，允许缩放）。"
                % ("；".join(tried[:3]), width, height, pv, width, height))
        if latest is not None:
            _log("延续（潜空间）承接存档：%s"
                 % os.path.relpath(latest, folder_paths.get_output_directory()))
        if context_latent is None:
            # 引用了但磁盘上没有存档：按第一段处理，说清楚差别。
            _log("延续（潜空间）没找到存档文件——本片段按第一段处理（无续写）。"
                 "工作流里是否接了「H3 续拍存档」（采样输出 → 存档，编号 0）？")
            # 登记时按面板 cont.frames 预估写了 trim_frames；这里确认一帧没接，
            # 必须把真值改回 0，否则导出会把开头正常画面当成承接头剪掉。
            try:
                _chain.update_clip(_name, _cid, {"trim_frames": 0})
            except Exception:
                pass
            return cond, 0

        # 帧数吸附到潜空间整步（124…22,5,1，向下取）。面板窗口值可能不是整步，
        # 吸附后语义不变：钉住的总是尾部。
        n = max(1, int((cfg.get("cont") or {}).get("frames") or 22))
        n = max(g for g in _MC_RUN_GRID if g <= n)

        cond, trim = _MC_Node().apply(
            conditioning=cond, vae=vae, latent=latent,
            context_length=n, audio_context_length=24,
            context_latent=context_latent)

        # ---- [承接钉帧] 头部逐位写进输入潜空间 + 遮罩钉住（20261031）----
        # MC 的逐 step keyframe 只是**条件**，模型（4 步 + cfg 1.0）对它的还原
        # 不忠实 —— 新段头部重建出的承接帧与上一段真实尾部有内容漂移，成片剪头
        # 后交界 = 上一段真实末帧 ‖ 新段第一个自由帧（它接着的是重建头）→
        # 单帧背景突变。承接帧数调多大都没用：锚定是「条件」不是「钉死」。
        # 这是 20261029 潜空间档改造时明确标注「仍未验证」的那条风险，现落地：
        # 把上一段尾部 latent steps 位对位**写进**输入潜空间头部再挂遮罩 ——
        # samplers.py:642 对遮罩为 0 的位置直接输出输入潜空间，头部逐位等于
        # 上一段真实尾部，自由帧从真实内容续出，交界逐位连续。
        # 铁律（20261027 花屏教训）：**先写内容、再挂遮罩**；写不进就**不挂**
        # （遮罩会把没内容的空 latent 冻在头上，解码即花屏 —— 宁可接缝跳，
        # 不出废品）。
        if _mc_tail_from_latent is not None and n >= 5:
            _seeded, _seed_why, _seed_cells = False, "", 0
            try:
                import comfy.nested_tensor as _nt
                _blocks, _offs, _cov = _mc_tail_from_latent(context_latent, n)
                _samples = latent.get("samples")
                _nested = bool(getattr(_samples, "is_nested", False))
                _parts = (list(_samples.unbind()) if _nested else [_samples])
                _v = _parts[0]
                _T = int(_v.shape[2])
                if _T < len(_blocks):
                    raise RuntimeError(
                        "本段潜空间只有 %d 步，装不下 %d 步承接头"
                        % (_T, len(_blocks)))
                for _k, _blk in enumerate(_blocks):
                    _v[:, :, _k:_k + 1].copy_(_blk.to(_v.dtype))
                _seed_cells = len(_blocks)
                _seeded = True
                if _nested:
                    # 与重抽钉帧同款姿势（本文件 钉帧 方案 A' 处）：unbind 拿到的
                    # 流就地改完后重新包回 NestedTensor，别赌容器缓存了什么。
                    latent["samples"] = (_nt.NestedTensor(_parts)
                                         if len(_parts) > 1 else _parts[0])
                from .banzhang_h3_pin import build_pin_mask
                latent["noise_mask"] = build_pin_mask(
                    latent, head=n, tail=0, keep_audio=False)
                # 承接头全程硬钉（mask=0），不许在尾部放开：那几帧正是剪头之后
                # 成片接缝的上下文，放开就等于让模型重猜上一段的末帧。20261102
                # 实测羽化版第 17~21 帧 PSNR 从 43.7 dB 掉到 38.5 dB，交界相位
                # 相关峰只剩 0.478（正常相邻帧 0.90+）。过渡交给交付端的接缝平滑，
                # 不在潜空间里让出逐位一致性。
                _log("延续（潜空间）[承接钉帧] 上一段尾部 %d 帧已**先写进**输入"
                     "潜空间（%d 步）并挂遮罩全部钉住 —— 交界前上下文逐位一致。"
                     % (n, _seed_cells))
            except Exception as _e:
                _seed_why = "%s: %s" % (type(_e).__name__, _e)
                latent.pop("noise_mask", None)
            if not _seeded:
                _log("延续（潜空间）[承接钉帧] 没挂上（%s）—— 本次只靠 MC 条件"
                     "锚定，两段交界处可能有背景突变。" % _seed_why)

        _log("延续（潜空间）钉住 %d 帧 + 尾部声音（默认 1 秒），剪头 %d 帧。"
             "本档位始终延续声音——这正是它存在的意义；「延续声音」开关只对文件档生效。"
             % (n, trim))
        return cond, trim

    # ---------------- 段落档案 ----------------

    @staticmethod
    def _whole_film_path(cfg):
        """时间轴上的「当前整片」路径：把所有已可播段按净长拼成的**完整片**
        （档案目录下的 _preview.mp4），与监视器连播 / 「保存成片」 / 前端「推送
        整片」是同一条片子。

        旧实现取「最后一段的 film」，但实测 clip_000x.mp4 只是**单段**（约 10 秒，
        含承接重叠），并不是「到这一段为止的累积片」——真正的全轴拼接只存在于
        preview_film 产出的 _preview.mp4。这里 ensure=True 现拼 / 取缓存：段内容
        或顺序没变就复用（流复制 + 一次重编码，几秒，带签名缓存），变了才重拼。
        没有片名 / 一段都没出 → 返回 ""。
        """
        chain = cfg.get("chain") or {}
        name = str(chain.get("name") or "")
        if not name:
            return ""
        try:
            from .. import csglide_chain as _chain
            res = _chain.preview_film(name, ensure=True)
        except Exception:
            return ""
        if res and res.get("ok"):
            fp = res.get("path")
            if fp and os.path.isfile(fp):
                return fp
        return ""

    @staticmethod
    def _register_clip(cfg, frame_count, log):
        """把本段登记进段落档案，返回段落 id（不归档则返回 ""）。

        片名为空 → 完全不碰磁盘，导演台照旧单段工作。
        段落 id 为空（画布裸跑/首段自登记）→ 新建一段并设为该片「当前段」；
        下游 💾 续拍存档 节点读 chain.json 的 current 就能自动对上，用户不用手填。
        指定了 id → 就地更新（时长、提示词、参考），重抽就是走这条路。
        指定了 id 但档案里查不到（uid 兜底也没对上）→ **当场拦下报错**，
        绝不静默新建段（20261103 身份不变量：段身份只由档案签发，执行不签发；
        静默新建就是用户报的「3 段跑完变 4 段 + 成片收不上轴」的直接来源）。
        """
        chain_ref = cfg.get("chain") or {}
        name = chain_ref.get("name") or ""
        if not name:
            return ""
        try:
            from .. import csglide_chain as _chain
        except Exception as e:
            log("【段落档案】模块未就绪（%s），本次不归档" % e)
            return ""

        cid = chain_ref.get("clip") or ""
        shot = chain_ref.get("shot") or ""
        refs = [s.get("file") for s in (cfg.get("images") or [])
                if isinstance(s, dict) and s.get("file")]
        # 这一段**实际**用多少帧承接到上一段。写进档案而不是只留在面板里：
        # 重抽这一段时必须用回同一个窗口，否则接缝换了个接法、下一段跟着变；
        # 时间轴上也要看得见"这一段当初是怎么接的"。
        # 0 必须写进档案（20261029 起默认就是 0）：不写就会沿用上次的旧账，
        # 成片照旧剪头、净长照旧扣。
        head = cont_head_frames(cfg, frame_count)
        # pins 里显式标了头部承接窗口：它比面板上的「承接帧数」更具体 —— 采样时
        # 就是按它钉的，真账在它这里。取较大者，别让"面板窗口 0（默认独立）"把
        # pins 写好的 39 覆盖成 0，否则接缝会重复播一截。
        try:
            for _p in (_chain.pins_of(name, cid) or []):
                if str(_p.get("at")) == "head" and int(_p.get("window") or 0) > head:
                    head = int(_p.get("window") or 0)
                    break
        except Exception:
            pass
        win = {"trim_frames": int(head)} if head > 0 else {}
        if not head:
            # 本次没有承接（独立段 / 断了链 / 承接帧数为 0）：必须**显式写 0**。
            # 不写就沿用上次生成的旧账（39），成片拼接照旧剪掉开头 39 帧正常内容，
            # 时间轴净长也照旧按 39 扣 —— 用户看到的"没让它剪，它还是剪了"。
            # trim_tail 不在这里碰：它归尾钉（pins 的 tail）管，与头部无关。
            win["trim_frames"] = 0
        try:
            # 双轨互斥（4-B）：手工导演台段不许去碰制片中枢工程。中枢模板跑出来
            # 的段（cfg.producer=True）跳过这个检查 —— 它自己就是中枢的合法写入。
            if not cfg.get("producer"):
                _chain.assert_no_producer_project(name)
                # 运行期锁（4-C）：片名正在中枢运行时拒绝手工段登记，防插队冲乱
                # chain.order（认档靠 order 顺序）。
                _chain.assert_manual_allowed(name)
            # 记下「最近登记过的片名」：💾/📤 的片名留空时会读它，这样用户只
            # 需要在导演台工程面板里填一次工程名，两个节点就不必再手打一遍。
            _chain.mark_last(name)
            # 认段的优先级：显式 clip id → 分段身份 shot id → 自登记新建（仅限
            # 本来就没 id 的裸跑）。中间那步是「重抽同一分段」的关键：clip id
            # 前端拿不到（端口不给），只有分段自身的 uid 能在多次运行之间保持稳定。
            _asked = cid          # 面板/中枢点名的段；非空却认不出 = 绑定断了
            if not (cid and _chain.load_clip(name, cid) is not None):
                cid = ""
                if shot:
                    for c in (_chain.summary(name).get("clips") or []):
                        if c.get("shot") == shot:
                            cid = c.get("id") or ""
                            break
            if cid:
                _chain.update_clip(name, cid, dict({
                    "frames": int(frame_count),
                    "prompt_seg": cfg.get("prompt") or "",
                    "refs": refs,
                    "shot": shot,
                    "pin_head": int(chain_ref.get("pin_head") or 0),
                    "pin_tail": int(chain_ref.get("pin_tail") if chain_ref.get("pin_tail") is not None else 0),
                }, **win))
            elif _asked:
                # 绑定断了不静默新建段（20261103 身份不变量）。旧行为 add_clip
                # 会让「3 段跑完变 4 段」，且收片按旧 id 报错、成片收不上轴，
                # 两头都看不出为什么。当场拦下：错误进执行日志与结果行，
                # 用户按提示认领/重加段，而不是白烧一轮 GPU。
                raise _SegBindingLost(
                    "认不出段落档案：导演台记录的段 id 是 %s，但工程「%s」的档案里"
                    "没有这一段（按分段编号也没对上）。多半是档案目录被删过、"
                    "或导入了别处的工程。请在时间轴上右键认领对应段，"
                    "或删掉这一段重新添加，再渲染。" % (_asked, name))
            else:
                # 本来就没 id（画布裸跑/首段）：自登记新建一段，照旧放行。
                cid = _chain.add_clip(name, frames=int(frame_count),
                                      prompt_seg=cfg.get("prompt") or "",
                                      refs=refs, shot=shot,
                                      pin_head=int(chain_ref.get("pin_head") or 0),
                                      pin_tail=int(chain_ref.get("pin_tail") if chain_ref.get("pin_tail") is not None else 0),
                                      **win)
            # 当前段必须挪到刚登记的这一段：下游 💾续拍存档 就是读
            # chain.json 的 current 来对号的。重抽走的是 update_clip
            # 那条路，而它不会挪 current（只有 add_clip 会），漏了这一步就会
            # 把这次的结果存到**上一段**的档案里 —— 看着跑通了，其实存错了
            # 地方，而且这种错最难查。
            if cid:
                _chain.set_current(name, cid)
                # 尾部没钉住（保留尾帧为 0）→ 本段末尾与旧版对不上了，下一段
                # 开头的承接帧悬空 —— 标下一段重抽，别让两段连接处的错位只靠
                # 眼睛发现。尾帧钉住了就尾部一致，下一段不用重跑，不标。
                if int(chain_ref.get("pin_tail") or 0) <= 0:
                    _order = _chain.load_chain(name).get("order") or []
                    if cid in _order:
                        _k = _order.index(cid)
                        _nxt = _order[_k + 1] if _k + 1 < len(_order) else None
                        # 同样只认「接本段的那一段」：补桥 / 往前接的下一段
                        # 头钉钉的不是本段，本段尾部变不变与它无关，标它重抽
                        # 是冤枉的（它根本没接本段）。
                        # 只认**明示**的头钉：pins 为空就是「这一段明确独立」，
                        # 不该靠「轴上前一段」替它猜一个爹出来 —— 猜错就冤枉
                        # 一段根本没接本段的片子去重抽。
                        if _nxt and _chain.head_parent(
                                name, _nxt, fallback_prev=False) == str(cid):
                            _chain.set_pending(name, _nxt, "redo")
                            log("【段落档案】本段尾部未钉住 —— 下一段（%s）已标为「要重抽」" % _nxt)
            info = _chain.summary(name)
            # 本段序号要按它在档案里的**位置**算，不能用总段数顶替——两个参数
            # 都传 len(clips) 时会永远输出「第 N 段 / 共 N 段」，看不出这是第几段。
            order = [c.get("id") for c in (info.get("clips") or [])]
            pos = (order.index(cid) + 1) if cid in order else len(order)
            # 全片长度报**净长**（film_summary 口径，与时间轴一致）—— summary 的
            # 原始 sum 含各段承接重叠，比轴上多出所有重叠帧，日志里写一个、轴上
            # 显示另一个，最容易被当成"总时长算错了"。
            try:
                _total = int(_chain.film_summary(name).get("total_frames") or 0)
            except Exception:
                _total = int(info.get("total_frames") or 0)
            log("【段落档案】片「%s」· 本段 %s（第 %d 段 / 共 %d 段 · 全片 %d 帧）"
                % (name, cid, pos, len(order), _total))
        except _SegBindingLost:
            # 绑定断了必须让这次执行当场失败（见类 docstring），
            # 绝不能落到下面「出图不受影响」——那等于退回静默世界。
            raise
        except Exception as e:
            # 20261106 诊断：此前只 log 一行类型+消息，真实调用栈被吞掉，
            # 「收不到片 / 段数对不上」时无法定位是登记链路哪一步失败。先把
            # 完整 traceback 打出来拿真错误（本步只加可见性，控制流照旧放行出图）。
            log("【段落档案】登记失败（%s: %s），下面是完整诊断堆栈：" % (type(e).__name__, e))
            for _tb_line in traceback.format_exc().rstrip().splitlines():
                log("    " + _tb_line)
            return ""
        return cid

    # ---------------- 钉帧（重抽这一段时，别牵连后面）----------------

    @staticmethod
    def _pin_grid_compatible(old_path, latent):
        """钉帧的硬前提：旧版潜空间能**逐位拷回**本次的网格。

        「钉住」只是让采样器别改那几步（ComfyUI samplers.py:
        out = out*denoise_mask + self.latent_image*latent_mask）—— 它并不会把
        旧内容变出来。旧内容全靠采样后「方案 B 回填」逐位拷回，而回填的判据
        就是形状全等（banzhang_ksampler_patch.py:43），差一个数就整条流静默
        跳过。形状对不上时，钉住的那几步会永远停在初始 latent（未采样）上，
        VAE 解码成红褐编织纹 —— 就是用户报的「最后几帧花屏」。
        这里必须与回填用同一把尺子，否则就留着「钉了但拷不回」的窗口。
        读不出来时不猜，按兼容处理：一次 IO 抖动不该把钉帧意图整个关掉。
        """
        try:
            from safetensors import safe_open
            new = tuple(latent["samples"].shape)
            with safe_open(old_path, framework="pt") as f:
                keys = list(f.keys())
                k = "video" if "video" in keys else keys[0]
                return tuple(f.get_slice(k).get_shape()) == new
        except Exception:
            return True

    @staticmethod
    def _attach_pin(latent, chain_ref, cid, log, unlinked=False):
        """重抽已有段时，把钉帧挂到本段的潜空间上。

        判据只有一条：**这一段以前跑过、有旧版潜空间可对照**。那就是「重抽」，
        也正是「只在重抽时生效」的落地方式 —— 不必让调用方传一个 is_redo 标志，
        因为「有没有旧版」本身就把这件事说完了，而且是磁盘上的事实，不会说谎。

        全新的一段不钉：没有旧版可参照，钉帧只会把它冻住；而新段的连贯性
        本来由 H3 原生的潜空间续写负责。钉帧解决的是另一个问题 ——
        「改了这一段，怎么保证后面各段不用跟着重跑」。

        两件事一起做，因为它们管的是不同的东西：
          · noise_mask（方案一）—— 采样中把钉住的帧锁死，让模型照着走。
            它依赖采样器原样收下遮罩；SelfLift 会在采样中途换 latent 网格，
            遮罩的参照物就不再是喂进 KSampler 的原稿，所以这一路只是 best effort
            （真机验过：带 SelfLift 时不成立 —— 那时要绕过 SelfLift 才有效）。
          · bz_pin 元数据（方案二）—— 采样器补丁跑完，把**头尾帧**从本段旧版
            原样拷回。纯张量拷贝，不经过采样器，与 SelfLift 无关。
            「后面各段不用重跑」这条性质由它保证 —— 遮罩成没成都不影响。
        """
        if not latent or not cid:
            return latent
        # 20261111 断链花屏次因：旧版潜空间的**头帧是上一段的承接内容**。
        # 用户把接续去掉后重抽，本段是独立起头，再把那批旧头帧拷回来 /
        # 用 noise_mask 钉住，就等于把别的段的画面钉在开头 —— 后面段一片花。
        # 断链时钉头钉尾都失去意义（下一段也不接本段），整段不钉。
        if unlinked:
            log("【钉帧】本段已「取消接续」（独立起头）—— 旧版潜空间的头帧"
                "属于上一段的承接内容，绝不拷回本次画面；本次不挂遮罩也不回填。")
            return latent
        name = str(chain_ref.get("name") or "")
        if not name:
            return latent
        try:
            from .. import csglide_chain as _chain
            from .banzhang_h3_pin import build_pin_mask
        except Exception as e:
            log("【钉帧】模块未就绪（%s），本次不挂遮罩也不回填" % e)
            return latent

        # 旧版潜空间 = 本段的上一版。它同时是三个问题的答案：是不是重抽、
        # 采样后尾帧以谁为准、下一段的引导头会不会变。
        try:
            meta = _chain.load_clip(name, cid) or {}
            take = int(meta.get("current_take") or 0)
            old_path = (_chain.clip_cont(name, cid, take,
                                         _chain.current_stage(name))
                        if take > 0 else "")
        except Exception as e:
            log("【钉帧】读不出本段档案（%s）—— 本次不挂遮罩也不回填。" % e)
            return latent
        if not old_path or not os.path.isfile(old_path):
            log("【钉帧】本段还没有旧版潜空间 —— 这是首次生成，不钉帧"
                "（新段的连贯性由 H3 原生续写负责）。")
            return latent

        # 形状对不上就一个都不钉：钉住的帧拷不回旧内容，等于钉住未采样的空
        # 潜空间 —— 片尾必花。宁可接缝跳（看得见、能补），也不要出废品。
        if not CSGlideCast._pin_grid_compatible(old_path, latent):
            log("【钉帧】旧版潜空间与本次网格对不上（形状不同）—— 钉住的帧拷不回"
                "旧内容，会停在未采样的空潜空间上，片尾必花。本次整段不钉帧；"
                "下一段的接缝请跟着重跑。")
            return latent

        head = int(chain_ref.get("pin_head") or 0)
        tail = int(chain_ref.get("pin_tail")
                   if chain_ref.get("pin_tail") is not None else 0)
        # [承接钉帧] 本段头部若由续接承接钉着（上一段尾部已逐位写入），重抽的
        # 「保留头部」让位：那几帧本来就属承接区、交付时剪头剪掉，钉住旧版只会
        # 让接缝对不上**新**上一段（两位主人抢同一批帧时，续接赢）。
        # 注意：这里的"续接承接遮罩是否存在"必须直接读 latent（_cont_mask 在本函数
        # 后面才从同一个 latent 里捕获，此处提前引用会 UnboundLocalError）。
        if latent.get("noise_mask") is not None and head > 0:
            log("【钉帧】本段头部 %d 帧由**续接承接**钉住（上一段尾部逐位写入），"
                "「保留头部」本次让位 —— 钉旧版会让接缝对不上一段。" % head)
            head = 0
        # ---- 钉尾至少覆盖「下一段的承接窗口」（20261010 修接缝跳变）----
        # 接缝宽度定义在接缝**右边**的那一段：下一段开头的 trim 帧，是照本段
        # 尾部那几帧重绘出来的引导头。本段尾部只要有一帧变了，下一段那个头
        # 就对不上 —— 接缝处必然跳一下，而且这种跳变是"内容对不上"，续接
        # 合成的 S 渐变切只能抹平一点点，抹不掉动作错位。
        # 面板上的「保留尾部」是**重抽力度**旋钮（钉得越多，本段能改的越少），
        # 它可以更大，但绝不能小于下一段的承接窗口 —— 小于就是"钉了也白钉"：
        # 钉住的 22 帧没变，可第 23~39 帧变了，下一段照样接不上。
        next_trim = 0
        try:
            rows = (_chain.film_summary(name).get("clips") or [])
            for _i, _r in enumerate(rows):
                if str(_r.get("id")) == str(cid) and _i + 1 < len(rows):
                    _nxt = rows[_i + 1]
                    # 只有**下一段的头钉钉的是本段**时，它的 trim 才代表
                    # 「要接本段的尾部」。补桥的下一段头钉钉的是别人 —— 那
                    # 个 trim 与本段无关，照它抬钉尾就是凭空少掉一截能改的
                    # 画面，而且不报错，只表现为「重抽了半天中间没怎么变」。
                    # 见 csglide_chain.head_parent。
                    _nt = int(_nxt.get("trim_frames") or 0)
                    # trim 为 0 就不用问了：没有承接窗口 = 没接任何人的尾巴，
                    # 本段尾部无须为它抬。（顺带绕开 pins 空列表的歧义 ——
                    # 「从来没写过」与「明确设为独立」在 pins 上长得一样。）
                    # 同上，只认明示的头钉。pins 为空时 head_parent 会回退到
                    # 「轴上前一段」—— 那恰好就是本段，于是用户明明取消了续接、
                    # 保留尾部也填了 0，钉尾照样被抬到 39（20261022）。
                    if _nt > 0 and _chain.head_parent(
                            name, _nxt.get("id"), fallback_prev=False) == str(cid):
                        next_trim = _nt
                    break
        except Exception as e:
            log("【钉帧】读不出下一段的承接窗口（%s: %s）—— 钉尾按面板值走。"
                % (type(e).__name__, e))
        if next_trim > tail:
            log("【钉帧】钉尾 %d → %d：下一段要接 %d 帧，少于这个数接缝就会跳。"
                % (tail, next_trim, next_trim))
            tail = next_trim

        # 本段自己尾部也钉着（往前接 / 补桥）时，钉尾窗口有一部分落在**要被
        # 剪掉**的那截上（末尾 trim_tail 帧是后一段头的重绘，交付时剪掉）。
        # 钉住它是白钉 —— 不会出错（剪掉就没了），但本段能改的范围平白少了。
        # 不自动减，因为「面板填的是重抽力度」这个语义不能让别的参数悄悄改掉；
        # 说清楚，让人自己决定要不要调小。
        try:
            _tt = int((_chain.load_clip(name, cid) or {}).get("trim_tail") or 0)
        except Exception:
            _tt = 0
        if _tt > 0 and tail > 0:
            log("【钉帧】本段末尾有 %d 帧是「钉住后一段的头」的重绘（交付时剪掉）"
                " —— 保留尾部 %d 帧里有一部分落在那截上，等于白钉；"
                "想让本段能改的多一点，就把「保留尾部」调小。" % (_tt, tail))

        if head <= 0 and tail <= 0:
            log("【钉帧】头尾都不钉 —— 这一段不做钉帧（整段从零重拍，"
                "后面各段要跟着重跑）。")
            return latent

        # [承接钉帧] 延续（_continuation_latent）可能已往 latent 挂了头部遮罩
        # （钉住上一段尾部写进来的承接帧）。下面重抽钉帧自建的遮罩只管本段
        # 尾部，直接覆盖会把承接头冲掉 —— 先捕获，稍后合并。
        _cont_mask = latent.get("noise_mask")
        out = dict(latent)

        # ---- 方案 A'：旧内容**先写进**输入潜空间（20261027 修「最后几帧花屏」）----
        # 遮罩只保证「别改这几步」，内容得自己先写进去 —— samplers.py:642 对遮罩
        # 为 0 的位置直接输出 latent_image，而 model_k.latent_image 就是喂进采样器
        # 的这份输入潜空间（:986）。以前这件事**完全**交给采样后的回填，可回填有
        # 三道会静默不跑的关：① 换了自定义 / 放大采样器就绕过补丁，回填那行根本
        # 没机会执行；② SelfLift / 多级提升中途把网格放大 1.5×，回填发现形状不符
        # 整条流被跳过；③ 回填时读不到旧档。哪道关没过，被钉住的那几步就停在没
        # 采样过的 latent 上 —— VAE 解码成红褐编织纹，就是「最后几帧花屏」。
        seeded, seed_cells, seed_why = False, 0, "未尝试"
        try:
            from .banzhang_h3_pin import seed_pinned_streams
            from .csglide_clip import CSGlideClipLoadCS
            _ref, _ref_info = CSGlideClipLoadCS().load(
                片名=name, 段落=cid, 版本=take, 没有档案时="直通（不回填）",
                顺序锚=-1)   # 内部调用，不是节点：别让它打「没接顺序锚」的提示
            if _ref and not _ref.get("bz_empty") and _ref.get("samples") is not None:
                _rs = _ref["samples"]
                _src = (list(_rs.unbind()) if getattr(_rs, "is_nested", False)
                        else [_rs])
                _os = out["samples"]
                _dst = [x.clone() for x in (
                    _os.unbind() if getattr(_os, "is_nested", False) else [_os])]
                seeded, seed_cells, seed_why = seed_pinned_streams(_dst, _src, head, tail)
                if seeded:
                    out["samples"] = (comfy.nested_tensor.NestedTensor(_dst)
                                      if len(_dst) > 1 else _dst[0])
            else:
                seed_why = "旧版档案取不到"
        except Exception as e:
            seed_why = "%s: %s" % (type(e).__name__, e)

        try:
            _pin_mask = build_pin_mask(latent, head, tail, False)
            # [承接钉帧] 两笔账合并：0=钉住，取 min = 任一方要钉就钉。
            # 重抽钉尾 + 续接钉头（含羽化释放区的浮点权重）并存时，直接覆盖
            # 会丢掉接缝的逐位连续。NestedTensor 不保证支持 torch.minimum ——
            # 按流拆开逐元素取小再包回，二值/浮点遮罩都成立。
            if _cont_mask is not None:
                _a = list(_cont_mask.unbind())
                _b = list(_pin_mask.unbind())
                _m = [torch.minimum(x, y) for x, y in zip(_a, _b)]
                out["noise_mask"] = (comfy.nested_tensor.NestedTensor(_m)
                                     if len(_m) > 1 else _m[0])
            else:
                out["noise_mask"] = _pin_mask
        except Exception as e:
            log("【钉帧】遮罩没挂上（%s）—— 采样后的尾帧回填不受影响，照做。" % e)
            seeded = True      # 没有遮罩 = 不存在「钉住却空着」的位置
        if seeded:
            log("【钉帧】旧版头 %d 帧 / 尾 %d 帧已**先写进**潜空间（%d 格）——"
                " 采样器会把它原样留在钉住的位置，采样后回填只是第二道保险"
                "（内容相同，等于白写一遍）。" % (head, tail, seed_cells))
        else:
            # 遮罩会把钉住的那几步冻在输入潜空间上；里面没有旧内容时，冻住的
            # 就只有空 latent，解码即花屏。宁可接缝跳（看得见、能补），也不要
            # 出废品 —— 本次整段不挂遮罩，只靠采样后回填。
            out.pop("noise_mask", None)
            if _cont_mask is not None:
                # [承接钉帧] 延续头部的遮罩与重抽回填无关：那个区域的内容由
                # 延续自己**先写进去**了（写不进它自己就不会挂），照常保住。
                out["noise_mask"] = _cont_mask
            log("【钉帧】旧内容写不进潜空间（%s）—— 重抽钉帧**不挂遮罩**（挂了就会"
                "把空 latent 冻在片尾，必花屏），只靠采样后回填。" % seed_why)
        out["bz_pin"] = {"name": name, "cid": cid, "head": head, "tail": tail}

        log("【钉帧】重抽本段（旧版第 %d 版）：钉住头 %d / 尾 %d 帧\n"
            "  · 方案 A 遮罩：已挂，让模型采样时看得见头尾（best effort ——"
            " SelfLift 会把遮罩按 1.5× 网格重采样，开着时它只作引导，不保证逐位）\n"
            "  · 方案 B 回填：采样后按旧版**逐位拷回**头尾帧，与 SelfLift 无关 ——"
            "「后面各段不用重跑」这条承诺由它保证\n"
            "  · 不再钉中间帧：骨架钉帧已被删除（20261026）——"
            "它按固定间隔把整个 latent 步贴成旧版画面，会周期性闪"
            % (take, head, tail))
        return out

    # ---------------- main ----------------

    @staticmethod
    def _preflight_check(cfg, first_frame=None, last_frame=None, prompt_wired=False):
        """开拍前体检：**只提醒，不拦下**，返回 {"bad": [...], "stat": ...}。

        空词已由 _resolve_wired_content 套用默认镜头；这里只在默认镜头常量被
        清空（还原态）或空素材时提醒，绝不替用户拦下渲染。
        20261107：区分「没接线」和「接了但文本为空」—— 线接了还报「未接线」
        会把人指去查连线，方向全错。
        """
        def _filled(seq):
            return [s for s in (seq or []) if isinstance(s, dict) and s.get("file")]

        imgs = _filled(cfg.get("images"))
        vids = _filled(cfg.get("videos"))
        auds = _filled(cfg.get("audios"))
        prompt = str(cfg.get("prompt") or "").strip()
        fl2va = cfg.get("mode") == "fl2va"
        bad = []
        if not prompt:
            if prompt_wired:
                bad.append("提示词接线了，但这一段的文本是空的 —— 本次送模型 0 字，"
                           "照常渲染，画面只由随机种子与模型先验决定。"
                           "\n       说明：线是通的，不用去查连线；要控画面就在文案台写词。")
            else:
                bad.append("提示词未接线（本段面板里也没写词）—— 本次按空词渲染，"
                           "照常出片但画面不受控。"
                           "\n       处理：把文案台「提示词」输出接到导演台「外接提示词」口"
                           "（也可接任意文本节点）。")
        if fl2va:
            if not (cfg.get("first") or cfg.get("last")
                    or first_frame is not None or last_frame is not None):
                bad.append("首/末帧是空的 —— fl2va（首/尾帧）模式没有锚点就退化成普通"
                           "文生视频，首尾不会遵你的图。"
                           "\n       处理：在面板「首帧 / 末帧」卡放图，或给"
                           "「首帧 / 末帧」口接 LoadImage（端口优先）。")
        elif not (imgs or vids):
            bad.append("参考素材未接线 —— 本次按空素材渲染，ref2va（多参考）模式下"
                       "画面完全由提示词与随机种子决定，照常出片。"
                       "\n       处理：把媒体架 → 文案台「参考素材」→ 导演台 refs 口接回。")
        return {"bad": bad,
                "stat": "参考图 %d 张 / 参考视频 %d 段 / 参考音频 %d 段 / 模式 %s"
                        % (len(imgs), len(vids), len(auds), "fl2va" if fl2va else "ref2va")}

    @staticmethod
    def _builtin_drift_model(model, result, h3_data):
        """把动态前缀 mask 装进 model，作为第 9 个输出口返回。

        prefix_steps 直接取导演台自己的 cont.frames，不依赖 hidden.prompt / Ticket；
        没接 model、首段无承接头、或装载失败时一律原样返回 model，绝不阻断出片。
        sigmas 传 None：_DriftState.mask_function 首次调用会从采样器透传的
        extra_options["sigmas"] 补齐（banzhang_h3_drift.py:158-162）。
        """
        if model is None:
            return model
        try:
            cfg = parse_h3_data(h3_data)
            frames = int((cfg.get("cont") or {}).get("frames") or 0)
            if frames <= 0:
                return model
            # 20261111 断链花屏根因修复：时间轴上「取消接续」后本段是**独立
            # 起头**，头部一帧都不承接（head_unlinked() / cont_head_frames()
            # 都返回 0）。旧版这里只看面板的 cont.frames 就装动态前缀 mask，
            # 等于告诉模型「前 22 帧是承接区」，可那 22 帧其实是从零生成的
            # 新画面 —— 真机日志里「已断链」与「承接头 22 帧 → prefix_steps=7」
            # 同时出现，后面几段就是这么花的。判据与 _continuation / 承接窗口
            # / 音频驱动统一用 head_unlinked()，绝不在这里另猜一套。
            if head_unlinked(cfg):
                print("[H3 导演台] 内置动态前缀 mask：本段已「取消接续」"
                      "（头部独立起头）—— 本次不挂 mask。面板仍写着承接 %d 帧，"
                      "那是上一次生成的旧账，挂上会让新画面开头花掉。" % frames)
                return model
            try:
                from ..core import csglide_ledger as ledger
                from .banzhang_h3_drift import install_drift_control
            except ImportError:
                from ..core import csglide_ledger as ledger
                from .banzhang_h3_drift import install_drift_control
            steps = ledger.drift_prefix_steps(frames)
            patched = install_drift_control(model, result[2], None, steps)
            print("[H3 导演台] 内置动态前缀 mask：承接头 %d 帧 → prefix_steps=%d"
                  % (frames, steps))
            return patched
        except Exception as exc:
            print("[H3 导演台] 内置动态 mask 未挂上（沿用原 model）：%s" % exc)
            return model

    @staticmethod
    def _builtin_model_chain(model, result, h3_data, unique_id):
        """导演台第 0 口的 MODEL：动态前缀 mask + 轻量动画预览，一次装完。

        预览能力来自 banzhang_mmh3_preview.apply_h3_preview_override（原本由
        画布上的「班长 MiniMax H3 预览覆盖」节点提供）。事件名与 payload 不变，
        导演台监视器订阅同一事件即可，画布上不再需要那个节点。
        装失败一律返回上一步的 model，绝不阻断出片。
        """
        patched = CSGlideCast._builtin_drift_model(model, result, h3_data)
        if patched is None:
            return None
        try:
            from .banzhang_mmh3_preview import apply_h3_preview_override
            cfg = parse_h3_data(h3_data)
            pv = cfg.get("preview") or {}
            n = int(pv.get("preview_frames") or 0)   # 0 = 全部时间格
            frame_count = align_frame_count(int(cfg.get("length") or 124))
            segment_seconds = frame_count / FPS
            # 20261108 17:24 定案：源节点 tiny VAE 真解码出 576x320 真 RGB；
            # 帧延时 = 本段真实秒数 / 实际解码帧数，回放与成片严格 1:1；
            # 不建 NVENC 会话，产物固定 WebP。
            patched = apply_h3_preview_override(
                patched, unique_id or "cast",
                max_resolution=int(pv.get("max_resolution") or 576),
                jpeg_quality=int(pv.get("jpeg_quality") or 60),
                suppress_default_preview=False,
                preview_frames=n,
                lite_animation=True,
                segment_seconds=segment_seconds,
            )
            print("[H3 导演台] 内置动画预览已装：%s / %.2f 秒段长 / 长边 576，"
                  "VAE 真解码、1:1 回放"
                  % ("全部时间格" if n < 2 else "%d 帧" % n, segment_seconds))
        except Exception as exc:
            print("[H3 导演台] 内置轻量动画预览未挂上（不影响出片）：%s" % exc)
        return patched

    def build(self, clip, vae, h3_data, audio_vae=None, first_frame=None, last_frame=None,
              refs=None, prompt_text=None, h3_override=None, model=None,
              prompt=None, unique_id=None):
        try:
            # 段身份 Ticket：从本次 hidden.prompt 确定性编译，只记录不阻断。
            # 存档节点会用同一份 prompt 独立算出同一张 Ticket 并按它认段；
            # 编译失败时这里只警告，由存档节点硬拦（不再读全局 current 猜段）。
            try:
                from ..core.csglide_ticket import ticket_from_prompt
                _ticket = ticket_from_prompt(prompt, unique_id)
                print("[H3 导演台/Ticket] 已签发 %s，%d 帧（剪头 %d / 净 %d），指纹 %s"
                      % (_ticket.label, _ticket.gross_frames, _ticket.trim_head,
                         _ticket.net_frames, _ticket.fingerprint[:12]))
            except Exception as _te:
                print("[H3 导演台/Ticket] 警告：本次未签发 Ticket（%s）；"
                      "存档节点将拒绝写档。请用画布正常 Queue，不要直接 POST /prompt。"
                      % _te)
            result = self._do_build(clip, vae, h3_data, audio_vae, first_frame,
                                    last_frame, refs, prompt_text, h3_override,
                                    prompt=prompt)
            # 模型口已置顶：先按旧 8 元组（result[2] 仍是潜空间）算 patched model，
            # 再拼成 9 元组。重排影响压在这一处，_do_build 一行不用动。
            patched = self._builtin_model_chain(model, result, h3_data, unique_id)
            return (patched,) + result
        except Exception as _e:
            print("[H3 导演台] 运行出错：%s: %s" % (type(_e).__name__, _e))
            raise
        finally:
            # 无论成功、报错还是被中断，都用完就还。放在 finally 里是因为
            # 「出错时恰好是最该把显存还回去的时候」——OOM 往往就发生在节点内部。
            _release_clip_when_done(clip, prompt, unique_id)

    def _do_build(self, clip, vae, h3_data, audio_vae=None, first_frame=None, last_frame=None,
                  refs=None, prompt_text=None, h3_override=None, prompt=None):
        # AI 制片中枢：外接 h3_data 接线即整体替换（断线/空串恢复面板原文）。
        _used_override = h3_override is not None and str(h3_override).strip() != ""
        if _used_override:
            h3_data = h3_override
        cfg = parse_h3_data(h3_data)
        # 方案A（20261025 重做）：中央库是**段内容**的唯一权威，h3_data 只是面板
        # 镜像缓存。执行这一刻从库里重读本段 state，**按 SEG_KEY_OWNER 逐字段合并**。
        #
        # 为什么不再是「整份替换」（`cfg = parse_h3_data(_state)`）：
        # 库里只存"段内容"，而 alias / segFps 这类**编译上下文库里根本没有**
        # （实测 61 段全缺）。整份替换等于把它们删掉，删完再按"缺失 = 旧行为"
        # 兜底 —— 别名开关关不住、段 fps 对账恒早退，20261025 查实的暗病 1/2。
        # 这两处 20261023 才修过一次，当时修的是白名单；这次是整份替换绕过白名单。
        #
        # 例外：外接 h3_override 是 AI 制片中枢的程序化整包，它本身就是权威，
        # 不查库（中枢不逐段写 state 进库，查了反而丢参数）。
        # 身份（name/clip/shot）保留提交那份：跑哪一段由提交决定，不能跟库里
        # state 最后停在哪一段走。
        if not _used_override:
            _d, _cid = _seg_dir_of(cfg)
            if _d and _cid.startswith("clip_"):
                try:
                    from ..core import csglide_store as _st
                    _state = (_st.load_clip_doc(_d, _cid) or {}).get("state")
                    if isinstance(_state, dict) and _state:
                        cfg = _merge_db_authority(cfg, _state, _cid)
                except Exception as _e2:
                    # 读库失败退回镜像继续渲染，不拦出图。
                    print("[H3 导演台] 中央库 state 读取失败，退回面板镜像: %s: %s"
                          % (type(_e2).__name__, _e2))
        # AI 制片中枢把词与参考音频放在 h3_override 整包里（它本身就是一根
        # 接线），折算成同样的两个来源交给收口，中枢行为保持不变。
        eff_refs = refs
        eff_prompt = prompt_text
        if _used_override:
            if eff_refs is None:
                eff_refs = {"slots": {
                    "images": cfg.get("images") or [],
                    "videos": cfg.get("videos") or [],
                    "audios": cfg.get("audios") or [],
                }}
            if eff_prompt is None:
                eff_prompt = cfg.get("prompt") or ""

        logs = []

        def log(msg):
            line = str(msg)
            logs.append(line)
            print("[H3 导演台] " + line)

        # 段内容的唯一写入口：接线才生效，断线即空（不再从库补词、不再让库覆盖）。
        # 必须在别名展开之前，外接文本里的 @图片N / 角色名同样要走展开。
        _resolve_wired_content(cfg, eff_refs, eff_prompt, log)
        _audit_seg_fps(cfg, log)

        # 一处收口：面板存的老写法与外接的官方英文写法都在这里归一成 @标签，
        # 否则按需过滤认不出 <Picture 1>，参考素材根本不会送进模型。
        # 别名先于归一化展开：名为 "image 3.png" 的素材若走归一化会被英文
        # 规则抢成 @图片1，指向错误槽位。
        # 音频引用不查表：<Audio N> 按第 N 个独立音频理解，那一格空着就保留
        # 原文 —— 宁可不生效，也不悄悄指到别处。
        #
        # 「别名模式」开关全链路唯一权威在文案台（desk.alias），经 h3_data.alias
        # 透传到这里（前端提交时由 bz_project_store 注入）。关闭时只认显式 @图片N
        # 写法 —— 剧本里裸写角色名 / 文件名主干不再被悄悄当成引用发图，与文案台
        # chip 高亮、编辑器提示严格同口径（所见即所送）。写法归一化（<Picture N>、
        # 图片N、image 1 等收敛成 @图片N）不属于别名，任何时候都照做，不受开关影响。
        # 面板模式（没接文案台，h3_data 里没这字段）默认 True，保持旧行为。
        #
        # 20261023：三态取值的写法是刻意的。原先直接 `cfg.get("alias", True)`，
        # 而 alias 根本不在白名单里 —— 于是"关"永远读不到，恒按 True 展开。
        # 现在显式区分"用户关了(False)"与"这份数据没这个字段(None→旧行为)"。
        _alias_on = cfg.get("alias")
        if _alias_on is None:
            _alias_on = True
        _amap, _strict = alias_table(cfg)
        _prompt = cfg["prompt"]
        if _alias_on:
            _prompt = expand_aliases(_prompt, _amap, _strict)
        elif _amap:
            # 开关关着但架上有别名：只在文本**确实点了名**时提醒一句。
            #
            # 这句提醒是有分量的，不是客套：20261023 之前 alias 恒为 True，
            # 于是「将 @图片3 定义为 陈九一」被展开成「将 @图片3 定义为 @图片3」
            # —— 角色定义整句失效，模型拿到的是一串自我指涉的编号，不知道
            # 哪一号图是谁。真机上 7 段共 74 处被这样改写。现在开关真正生效后
            # 这些名字会按原文保留，得让用户知道"变化发生了、原因在哪、怎么退回"。
            _hit = [n for n in _amap if n in _prompt]
            if _hit:
                log("【引用】别名模式关闭：文本里出现的 %d 个素材名/角色名按原文保留，"
                    "不转成 @图片N（例：%s）。这些名字仍在提示词里照常描述画面；"
                    "想让它们自动变成引用，打开文案台的「别名模式」。"
                    % (len(_hit), "、".join(_hit[:3])))
        # 展开结果**不写回** cfg["prompt"]：设计约定是「原文不改写，展开只发生
        # 在送模型这一路」（见上面别名表的注释）。原先这里把展开后的文本写回了
        # cfg，段落档案登记（prompt_seg，见本文件后面 _register_clip 里的两次
        # 落库）随后把它存进档案 —— 于是「@图片3 中的陈九一」被存成「@图片3 中
        # 的@图片3」：说明性文字里的角色名被当成引用换掉了，别名语义丢失、人看
        # 不懂，且每次重跑再展开一次会继续退化，无法还原回原文。
        # 现在展开只留在局部变量里：档案落原文，送模型走展开后的这份。
        prompt_for_model = normalize_refs(_prompt)

        if prompt_text is not None:
            log("【提示词】外接模式：prompt_text 接线，本次执行用的是接线那头的文本"
                "（即文案台的输出）；「未参与」仅指导演台自己面板里的提示词框")

        # 默认镜头常量被清空（还原态）时才走到这里：保持原来的空词跑法，不拦、不确认。
        # 0 字送模型时画面只由随机种子决定，必须先把后果说清。
        if not str(prompt_for_model or "").strip():
            log("⚠【用词】本次送模型 0 字 —— 提示词不起任何作用，画面只由随机种子"
                "与模型先验决定；按你的跑法照常渲染。要控画面，在文案台写词即可。")

        # 开拍前体检：缺素材 / 缺提示词只提醒、不拦下（理由见
        # _preflight_check 的文档串）。位置仍然排在所有昂贵操作（潜空间分配、
        # 参考图编码、CLIP 编码）之前——体检本身不花时间，该说的却一句不少。
        _pf = self._preflight_check(cfg, first_frame, last_frame,
                                    prompt_wired=prompt_text is not None)
        if _pf["bad"]:
            log("")
            log("⚠【开拍前体检】%d 项提醒 —— 本次照常渲染，"
                "以下只说明画面为什么不受控" % len(_pf["bad"]))
            for _i, _t in enumerate(_pf["bad"], 1):
                log("    %d) %s" % (_i, _t))
            log("    当前识别到：" + _pf["stat"])
        else:
            log("开拍前体检通过：" + _pf["stat"])

        def finish(cond, hd_cond, hd_upgraded):
            """Shared tail for both modes: attach the continuation, if any.

            hd_cond 是「放大重绘」端口（二采三采共用）的条件，统一在这里拼到
            末尾——两种模式都必须出这个端口，由调用方决定填重编码后的条件还是
            基础条件自身。

            hd_upgraded=False 时在潜空间上打「未升级」标记：这份条件与基础条件
            逐字相同，下游二采三采据此自动直通，不接线也不用改任何设置。
            """
            cont_mode = (cfg.get("cont") or {}).get("mode") or "file"
            if cont_mode == "latent":
                # 潜空间续写：Motion Context 算术在内部把钉帧与音频窗口挂进条件，
                # 返回的条件直接替换，不走下面的 keyframe 追加。
                cond, overlap = self._continuation_latent(
                    cfg, vae, cond, latent, width, height, frame_count, log=log)
            else:
                # 老档案里还留着承接窗口却停在「文件」档位：pins 走的是潜空间，
                # 钉不住。静默按文件档跑出来的是「自动接续」，与档案里的钉法
                # 对不上 —— 这正是最难查的那种错位，必须说出来。
                try:
                    from .. import csglide_chain as _c
                    _cr = cfg.get("chain") or {}
                    if _cr.get("name") and _cr.get("clip") and \
                            (_c.pins_of(_cr["name"], _cr["clip"]) or []):
                        log("⚠ 这一段（老档案）还留着承接窗口（钉住别的段），但续写档位"
                            "是「文件」—— 承接窗口只有**潜空间档**钉得住。"
                            "把档位切到「潜空间」，否则本次按文件档的自动接续跑。")
                except Exception:
                    pass
                # 先试潜空间，走不了再退回文件档（20261029）。
                # 文件档要把上一段解码成像素、再缩放到本段画布、再重编码成 latent：
                # 三道有损往返叠在一起，接缝开头必然偏软（实测承接窗内清晰度只有
                # 正常帧的 1/3~1/8，肉眼就是"前 1.6 秒糊"）。潜空间档直接切上一段
                # 采样后的 latent，位对位、不重编码，才是"无缝无痕"该有的样子。
                # 只在确实能接时才用（画布不同 / 没有上一段存档 → 退回文件档）。
                _auto = None
                if not head_unlinked(cfg) and int(
                        (cfg.get("cont") or {}).get("frames") or 0) > 0:
                    try:
                        _auto = self._continuation_latent(
                            cfg, vae, cond, latent, width, height, frame_count,
                            log=log)
                        if _auto is not None and int(_auto[1] or 0) <= 0:
                            _auto = None      # 没接上（第一段 / 无存档）→ 文件档
                    except Exception as _e:
                        log("延续（潜空间）不可用（%s）—— 本次退回文件档；文件档要"
                            "把上一段解码成像素再重编码，接缝开头会偏软。" % _e)
                        _auto = None
                if _auto is not None:
                    cond, overlap = _auto
                else:
                    guide, overlap, _ = self._continuation(
                        cfg, vae, audio_vae, latent, width, height, frame_count, log=log)
                    # 文件档续写：把引导帧（续写来源的锚）追加进 keyframes。
                    # 潜空间档不经过这里 —— 钉帧由 MC 算术在条件内部处理，
                    # 那条分支根本没有 guide 这个变量（20261031 修复：此块曾被
                    # 误放在 cont_mode 分支外层，潜空间档渲染必炸
                    # UnboundLocalError: guide；同款雷也埋在旧版「文件档+
                    # 自动潜空间成功」的路径里，一并拔除）。
                    if guide is not None:
                        keyframes = list(cond[0][1].get("minimax_keyframes", []))
                        keyframes.append(guide)
                        cond = node_helpers.conditioning_set_values(
                            cond, {"minimax_keyframes": keyframes})
            # 说明：原本这里有「源视频」端口——文件档 = 续写文件本身、潜空间档
            # 实时抓最新成片，供「Glide 续接合成」拼长片。现已随端口一并移除：
            # 续接合成（Join）前端早已改成「源视频不做端口、路径面板自填或自动
            # 接片」，不再依赖导演台这条输出；续写算术本身也从没读过它。
            log("")
            log("【输出】正面条件 / 潜空间 %d 帧 / %d×%d / %.2f 秒%s"
                % (frame_count, width, height, seconds,
                   (" / 延续重叠 %d 帧" % overlap) if overlap else ""))
            if not hd_upgraded:
                log("【放大重绘】条件未升级（与一采逐字相同）——已给潜空间打标记，"
                    "下游二采/三采节点会自动直通，不跑那两次重绘")
            # 整片口：读档案里最后一段在磁盘上的累积成片，包成 VIDEO。还没渲染
            # 出过整片 / 没填片名时为 None —— 下游视频合并的 VIDEO 口是 optional，
            # 收到 None 会退回它自己的图像分支，不会报错。
            # 开关关（默认）时连拼都不拼：本次压根不用整片，省掉几秒拼接，也
            # 不让下游的超分/插帧白等一根永远不会有内容的线（它们收到空会自己
            # 安静跳过）。要整片就打开面板上的「整片口输出」。
            if not cfg.get("push_whole"):
                whole_film = None
                log("【输出】「整片」口：开关关着 —— 本次不拼整片、也不往下发"
                    "（下游超分/插帧会安静跳过）。要发就打开「整片口输出」。")
            else:
                whole_path = self._whole_film_path(cfg)
                whole_film = _video_from_file(whole_path)
                if whole_film is not None:
                    log("【输出】「整片」口（完整全片）：%s" % whole_path)
                else:
                    log("【输出】「整片」口：当前还没有成片（先渲染 / 导出过整片）")
            # 「整片潜空间」口：开关关（默认）时连读档案都不做 —— 面板上手动
            # 打开才拼（20261101 用户定：段全备齐再发，不要每次渲染都白拼一次）。
            if not cfg.get("push_film_latent"):
                film_latent = None
                log("【输出】「整片潜空间」口：开关关着 —— 本次不拼整条 latent。"
                    "要发就先在面板「高级区 → 整片潜空间」打勾，再跑整片重绘工作流。")
            else:
                film_latent = _whole_film_latent(cfg, log)
            out_latent = self._attach_pin(
                _mark_hd_upgraded(latent, hd_upgraded),
                cfg.get("chain") or {}, clip_id, log,
                unlinked=head_unlinked(cfg))
            # 驱动音频必须排在 _attach_pin **之后**：钉帧会重建 noise_mask，
            # 先写驱动会被整份盖掉，音频锁噪丢失又退回「只参考」。
            out_latent = self._apply_driver(
                cfg, audio_vae, out_latent, frame_count, log, prompt=prompt)
            return (cond, hd_cond, out_latent, frame_count, seconds, overlap,
                    film_latent, whole_film)

        width = max(CANVAS_MULTIPLE, (cfg["width"] // CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        height = max(CANVAS_MULTIPLE, (cfg["height"] // CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        latent, frame_count = _empty_av_latent(width, height, cfg["length"])
        seconds = frame_count / FPS

        log("—— H3 导演台 · 运行日志 ——")
        log("模式：%s" % ("fl2va（首/尾帧）" if cfg["mode"] == "fl2va" else "ref2va（多参考）"))
        log("画布：%d × %d" % (width, height))
        log("时长：%d 帧 ≈ %.2f 秒" % (frame_count, seconds))

        # 编号引用的错位风险：@图片N 按槽位**位置**解析（只数已填槽位重排），
        # 在媒体架里插入或删掉一张素材，后面的编号就整体前移 —— 提示词里写的
        # 「@图片3」会指向另一个人，且画面看着还挺合理，极难发现。槽位上起了
        # 名字（别名）的，写名字就永久免疫：名字跟着素材走，位置怎么动都不变。
        _num_refs = sorted(set(re.findall(r"@图片\d+", str(cfg.get("prompt") or ""))))
        if _num_refs:
            _named = [s for s in (cfg.get("images") or [])
                      if isinstance(s, dict) and (s.get("alias") or [])]
            _tip = ""
            if _named:
                _tip = "　这些槽位是有名字的，把编号改写成名字即可（如「%s」）" % \
                    str((_named[0].get("alias") or [""])[0])
            log("⚠ 提示词里有 %d 处编号引用（%s）：编号按槽位位置解析，"
                "插/删素材会整体错位。%s"
                % (len(_num_refs), "、".join(_num_refs[:5]), _tip))

        # 段落档案登记：这一段归到哪条片子、是第几段。
        # 放在这里是因为 frame_count 刚算出来，且两种模式都要走（fl2va 中途
        # return 也在此之前）。登记失败只告警——档案是辅助账，不该让出图挂掉。
        # 唯一例外：_SegBindingLost（点名的段在档案里认不出）必须穿透拦下，
        # 否则就回到「静默新建段、3 段变 4 段」的老坑（20261103）。
        clip_id = self._register_clip(cfg, frame_count, log)


        if cfg["mode"] == "fl2va":
            first = first_frame if first_frame is not None else (
                _load_image(cfg["first"]["file"]) if cfg["first"] else None)
            last = last_frame if last_frame is not None else (
                _load_image(cfg["last"]["file"]) if cfg["last"] else None)

            tags, _ = build_tag_map(cfg, first is not None, last is not None)
            prompt = transcribe_prompt(prompt_for_model, tags, ["@first", "@last"])

            log("")
            log("【关键帧】首帧=%s  尾帧=%s"
                % ("有" if first is not None else "无", "有" if last is not None else "无"))
            if tags:
                log("【转译】" + "  ".join("%s→%s" % (k, v) for k, v in tags.items()))

            # 续写把上一片段的尾部钉在帧 0..n-1。首帧锚自动落到接缝处，不再与
            # 续写块抢同一个时间坐标——同坐标的后果是「谁也不像」或「被整块丢弃」，
            # 没有第二种合理结果，所以自动错开、不给开关。没有续写时 head=0，
            # 与改之前逐字一致。
            head = cont_head_frames(cfg, frame_count)
            if last is not None:
                head = min(head, max(0, frame_count - 2))

            images, keyframes = [], []
            if first is not None:
                img = _resize(first[:1], width, height, "center")     # cover-crop：与末帧同口径
                images.append(img)
                keyframes.append({"resolved_frame_index": head, "image": img})
            if last is not None:
                img = _resize(last[:1], width, height, "center")      # follower: cover-crop
                images.append(img)
                keyframes.append({"resolved_frame_index": frame_count - 1, "image": img})

            if head:
                log("【关键帧】首帧锚自动后移到第 %d 帧——续写钉住了帧 0..%d，"
                    "两个锚落在同一坐标会互相抵消（潜空间档会被整块丢弃）。"
                    % (head, head - 1))
            # 首尾帧都按居中裁切进画布：锚点只要求尺寸等于 width×height，裁切与
            # 拉伸都满足，但拉伸会把竖图压扁、人脸变形。20261026 之前首帧用的是
            # "disabled"（拉伸），理由写的是 "geometry anchor" —— 那个理由不成立，
            # 且与紧邻的末帧口径相反。
            for cap, src in (("首帧", first), ("末帧", last)):
                if src is None:
                    continue
                sw, sh = int(src.shape[2]), int(src.shape[1])
                if abs(sw * height - sh * width) > 0.02 * sh * width:
                    log("【关键帧】%s 源图 %dx%d 与画布 %dx%d 比例不一致（按居中裁切，"
                        "只保留画面中间部分）——想要保住完整构图，请把画布设成图片的比例"
                        % (cap, sw, sh, width, height))

            tokens = clip.tokenize(prompt, images=images)
            cond = clip.encode_from_tokens_scheduled(tokens)
            if keyframes:
                for kf in keyframes:
                    kf["latent"] = vae.encode(kf.pop("image"))
                # minimax_frame_count 曾一并写在这里，但核心从不读它（全仓库无
                # 消费方），留着只会让人以为首尾帧锚带着帧数约束——删掉。
                cond = node_helpers.conditioning_set_values(cond, {
                    "minimax_keyframes": keyframes,
                })
            # fl2va 没有参考素材可重编码，放大重绘条件等于基础条件；关键帧在
            # 二采/三采被放大画布时由 PackedLayout 自愈钩子按需重采样（见
            # install_keyframe_autofit），不需要用户填任何倍数。
            log("【放大重绘条件】首尾帧模式：端口与基础条件完全相同"
                "（关键帧按各阶段画布自动重采样，无需手动匹配倍数）")
            return finish(cond, cond, False)

        # ---- ref2va ----
        # 首尾帧只在 fl2va 分支里读。面板槽位也好、first_frame / last_frame
        # 端口也好，多参考模式下都是静默忽略——用户看到卡片上摆着图、画布上
        # 也接了线，却完全没有约束，且没有任何提示。这里把「摆了却用不上」
        # 直接说出来。
        if (first_frame is not None or last_frame is not None
                or cfg.get("first") or cfg.get("last")):
            log("【关键帧】⚠ 当前是「多参考」模式，首尾帧不参与生成——面板里的"
                "首帧/末帧与 first_frame / last_frame 端口都只在「首/尾帧」模式下"
                "生效。要按首尾帧约束，请把模式切到「首/尾帧」（并加载 "
                "minimax_h3_fl2va 开头的权重）。")

        kept, over = _filter_refs_by_prompt(cfg, prompt_for_model)

        def _known(fmt, base, arr, used):
            top = max(base, len(arr), max(used) if used else 0)
            return [fmt % i for i in range(1, top + 1)]

        known = (_known("@图片%d", MAX_IMAGES, cfg["images"], kept["images"])
                 + _known("@视频%d", MAX_VIDEOS, cfg["videos"], kept["videos"])
                 + _known("@视频音频%d", MAX_VIDEOS, cfg["videos"], kept["videos"])
                 + _known("@音频%d", MAX_AUDIOS, cfg["audios"], kept["audios"]))
        tags, presentation = build_tag_map(cfg, False, False)
        prompt = transcribe_prompt(prompt_for_model, tags, known)

        log("")
        if any(kept.values()):
            label = {"images": "图片", "videos": "视频", "audios": "音频"}
            parts = [",".join("@%s%d" % (label[k], n) for n in v)
                     for k, v in kept.items() if v]
            log("【参考素材】按需发送：" + "  ".join(parts))
            # 官方交互代码图片侧上限是 <Picture 1>~<Picture 9>。别名自动展开
            # 让「一段里提到几个角色就送几张」变得极易触发；超出的引用已在
            # _filter_refs_by_prompt 里截断，这里把截断如实告诉用户。
            for k, n in over.items():
                cap = {"images": MAX_IMAGES, "videos": MAX_VIDEOS, "audios": MAX_AUDIOS}[k]
                log("【参考素材】⚠ %s 引用了 %d 个，超出上限 %d——只保留编号最小的 %d 个，"
                    "其余已从提示词移除" % (label[k], n, cap, cap))
        else:
            log("【参考素材】提示词未引用任何 @标签，本次不送参考")
        ref_items, ref_blocks = self._refs(cfg, vae, audio_vae, width, height, frame_count, log=log)

        if tags:
            log("")
            log("【提示词转译】")
            for k in sorted(tags):
                log("  %s → %s" % (k, tags[k]))

        tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
        cond = clip.encode_from_tokens_scheduled(tokens)
        if ref_blocks:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})

        def cond_at(scale):
            """按给定参考档位倍数重建一份条件。

            提示词两份逐字相同，变的是参考素材那两条通道：字典里的 minimax_refs
            （VAE 潜空间，DiT 直接看）与文本嵌入里的视觉 token。两条都重建意味着
            32B 视觉编码器要再跑一遍——视觉 token 数随档位平方增长，这是放大重绘
            档位的主要代价。
            """
            items, blocks = self._refs(cfg, vae, audio_vae, width, height, frame_count,
                                       log=log, ref_scale=scale)
            toks = clip.tokenize(prompt, minimax_ref_items=items)
            c = clip.encode_from_tokens_scheduled(toks)
            if blocks:
                c = node_helpers.conditioning_set_values(c, {"minimax_refs": blocks})
            return c

        # 二采与三采共用同一份条件：两级放大重绘吃的是同一套参考口径，分量没有
        # 依据，只会让用户多接一根线。倍数 1 = 跟随主档位，直接复用基础条件对象，
        # 零额外计算（与加此功能前完全一致）；没有参考素材时也无从重编码。
        # 三种「端口 = 基础条件复制品」的情况都明说——之前是静默的，用户以为
        # 端口在起作用，实际二采拿到的与一采一字不差。
        m = cfg["ref_scale_hd"]
        if not ref_blocks:
            hd_cond = cond
            hd_ok = False
            log("【放大重绘条件】没有参考素材可重编码 —— 端口与基础条件完全相同")
        elif cfg["ref_image_size"] == "raw":
            hd_cond = cond
            hd_ok = False
            log("【放大重绘条件】原图档不参与倍数放大 —— 参考已按官方上限原样编码，"
                "端口与基础条件完全相同")
        elif m <= 1.0 + 1e-6:
            hd_cond = cond
            hd_ok = False
            log("【放大重绘条件】倍数 1.0 —— 端口与基础条件完全相同"
                "（要生效：倍数调到 1.5/2，且参考源文件分辨率 ≥ 二采后的目标）")
        else:
            target = _ref_target_long(cfg["ref_image_size"], max(width, height), m)
            log("")
            log("【放大重绘条件】参考档位 %.2f×（主档位 %s → 目标长边 %.0f）—— 二采三采共用，重编码参考素材"
                % (m, cfg["ref_image_size"], target))
            # 参考只缩不放：源文件不够大时倍数被上限截住，这是二采阶段
            # 「跟参考不一致」最常见的隐形原因，必须点名让用户能自查。
            log("【放大重绘条件】注意：参考只缩不放 —— 若上方素材「编码 WxH」小于目标长边，"
                "说明源文件分辨率不够，倍数只生效到源素材上限")
            hd_cond = cond_at(m)
            hd_ok = True
        return finish(cond, hd_cond, hd_ok)

    @classmethod
    def IS_CHANGED(cls, h3_data, **kwargs):
        # 连线输入在 IS_CHANGED 调用时恒为 None（execution.py 的 mark_missing），
        # 给 refs / prompt_text 做指纹是死路 —— 旧版拼了这两项，等于永远空串，
        # 改外接词不重跑。失效链改由上游自己声明：文案台与媒体架各有
        # IS_CHANGED，外部文本节点由 ComfyUI 原生输入签名负责。
        # h3_data 管几何与采样参数，改它自然失效。
        # 时间轴音频驱动存在磁盘 bzsa.driver 里，不进 h3_data；编辑/裁剪音轨
        # 后 h3_data 一字不变，ComfyUI 判定节点没变、直接复用上次输出，
        # 表现就是「编辑音轨后采样被跳过」。把驱动指纹拼进来强制失效。
        return str(h3_data or "") + "|" + _audio_driver_stamp(h3_data)


def _audio_driver_stamp(raw):
    """本工程驱动音频的指纹：各段驱动 wav 的路径 + 修改时间。

    读不到就返回空串（老工程 / 没拖音频），行为与以前完全一致。
    """
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
        name = str(((data.get("chain") or {}).get("name")) or "").strip()
        if not name:
            return ""
        import os
        import folder_paths
        from ..core import csglide_store as _st
        conn = _st._connect(_st.chain_dir(name), create=False)
        if conn is None:
            return ""
        drv = _st._meta_get(conn, "bzsa.driver", {}) or {}
        inp = folder_paths.get_input_directory()
        out = []
        for cid in sorted(drv):
            f = str((drv[cid] or {}).get("file") or "")
            if not f or ".." in f.split("/"):
                continue
            p = os.path.join(inp, *f.split("/"))
            mt = int(os.path.getmtime(p)) if os.path.isfile(p) else 0
            out.append("%s:%d" % (f, mt))
        return "|".join(out)
    except Exception:
        return ""


NODE_CLASS_MAPPINGS = {"CSGlideCastCS": CSGlideCast}
NODE_DISPLAY_NAME_MAPPINGS = {"CSGlideCastCS": "🎞️ H3 导演台 (H3 Studio) · 班长"}


# --------------------------------------------------------------------------
# 潜空间续写：给前端预览用的查询路由 + 执行时的自动承接。
# 「续拍存档」自动模式（编号 0）每跑一段落一个新文件，最新的就是上一片段。
# --------------------------------------------------------------------------
def _latest_central_cont_latent():
    """中央系统：返回当前段的上一段 cont 与本次分段视频预览。"""
    try:
        from .. import csglide_chain as _chain
    except Exception:
        return None
    try:
        name = _chain.last_name()
        if not name:
            return None
        chain_doc = _chain.load_chain(name) or {}
        cid = str(chain_doc.get("current") or "")
        order = [str(x) for x in (chain_doc.get("order") or [])]
        if not cid or cid not in order or order.index(cid) <= 0:
            return None
        prev = order[order.index(cid) - 1]
        meta = _chain.load_clip(name, prev) or {}
        take = max(1, int(meta.get("current_take") or 1))
        receipt = None
        try:
            receipts = _chain.store.list_run_receipts(
                _chain.chain_dir(name), limit=20, cid=prev)
            receipt = next((r for r in receipts
                           if int(r.get("take") or 1) == take), None)
        except Exception:
            receipt = None
        path = (receipt or {}).get("cont_path")
        if not path:
            tp = (meta.get("take_params") or {}).get(str(take)) or {}
            path = tp.get("cont_saved")
        if not path or not os.path.isfile(path):
            return None
        seg = (receipt or {}).get("segment_film") or {}
        preview = None
        if seg.get("filename"):
            preview = {
                "name": seg.get("filename"),
                "subfolder": seg.get("subfolder") or "",
                "type": "output",
            }
        return {"path": path, "preview": preview}
    except Exception:
        return None


def _latest_cont_latent_path():
    """output/h3_context/ 里最新的一个续拍存档（绝对路径），没有则 None。"""
    if _mc_under_output is None or _MC_SLOT_FILE is None:
        return None
    folder = _mc_under_output("h3_context")
    if not folder or not os.path.isdir(folder):
        return None
    cands = [os.path.join(folder, f) for f in os.listdir(folder)
             if f.endswith(".safetensors") and _MC_SLOT_FILE.search(f)]
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def _latest_output_video():
    """output 目录里最新的一个成片视频（绝对路径），没有则 None。

    与潜空间续写「运行时自动承接最新存档」同一条假设：最新的成片就是
    上一片段。跳过 Glide Video 给浏览器解码写的 preview 代理——它永远比
    母片新，接错会把 4:2:0 副本当源片。
    """
    try:
        from ..core.csglide_adopt import VIDEO_EXT as _EXT, _PREVIEW_RE as _PV
    except Exception:
        _EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
        _PV = re.compile(r"(^|[._-])preview\.[^.]+$", re.IGNORECASE)
    root = folder_paths.get_output_directory()
    best, best_mtime, seen = None, -1.0, 0
    for base, _dirs, files in os.walk(root):
        for fn in files:
            if os.path.splitext(fn)[1].lower() not in _EXT or _PV.search(fn):
                continue
            full = os.path.join(base, fn)
            try:
                m = os.stat(full).st_mtime
            except OSError:
                continue
            if m > best_mtime:
                best, best_mtime = full, m
            seen += 1
            if seen >= 4000:        # 与 /cglide/recent_outputs 同一扫描上限
                return best
    return best


def register_cont_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None:
        return

    from .._h3mc.csrf_guard import require_same_origin

    @server.routes.post("/banzhang/h3mc/latest_latent")
    @require_same_origin
    async def _latest_latent_route(request):
        latest = _latest_central_cont_latent()
        if latest is None:
            legacy = _latest_cont_latent_path()
            latest = {"path": legacy, "preview": None} if legacy else None
        if latest is None:
            return web.json_response({"found": False})
        rel = os.path.relpath(latest["path"], folder_paths.get_output_directory())
        return web.json_response({
            "found": True,
            "path": rel.replace(os.sep, "/"),
            "preview": latest.get("preview"),
        })


# --------------------------------------------------------------------------
# 首尾帧锚的网格自愈（安装一次，全局生效）
# --------------------------------------------------------------------------
def _resample_keyframe_latent(lat, latent_h, latent_w):
    """关键帧潜空间重采样到目标网格——只动空间，时间维与通道不动。"""
    b, c, t, _h, _w = lat.shape
    x = lat.reshape(b * t, c, _h, _w)
    x = torch.nn.functional.interpolate(
        x.to(torch.float32), size=(latent_h, latent_w),
        mode="bilinear", align_corners=False)
    return x.to(lat.dtype).reshape(b, c, t, latent_h, latent_w)


def install_keyframe_autofit():
    """首尾帧锚在二采/三采阶段自动对齐画布网格。

    PackedLayout 用「目标画布」的网格给关键帧预留行数
    （n = vt * frame_rows，model.py:380），却用关键帧自身潜空间的 patchify
    去填（model.py:539）。一采按 768×1344 编码的关键帧，遇到二采把潜空间放大
    2×，两者必然不等——采样直接抛 cannot be broadcast，而报错里没有一个字指向
    「首尾帧」，用户只会以为首尾帧坏了。

    不要求用户填倍数、也不重建条件：在布局构造前把关键帧对齐到目标网格，任何
    改画布的下游（二采、三采、外挂放大、续写）都自动覆盖。尺寸本来就相等时一个
    字节都不动，行为逐字不变。官方节点同样受益——它也有一样的下场。
    """
    try:
        from comfy.ldm.minimax import model as _mm
    except Exception:
        return False
    cls = getattr(_mm, "PackedLayout", None)
    if cls is None or getattr(cls, "_h3studio_autofit", False):
        return False
    original = cls.__init__

    def patched(self, *args, **kwargs):
        try:
            # 形参顺序（不含 self）：text_len, latent_t, latent_h, latent_w,
            # audio_t, keyframes, refs —— 位置回退按这个序号取，别把 self 算进去。
            latent_h = kwargs.get("latent_h", args[2] if len(args) > 2 else None)
            latent_w = kwargs.get("latent_w", args[3] if len(args) > 3 else None)
            keyframes = kwargs.get("keyframes", args[5] if len(args) > 5 else None)
            if latent_h is not None and latent_w is not None and keyframes:
                latent_h, latent_w = int(latent_h), int(latent_w)
                for kf in keyframes:
                    lat = kf.get("latent")
                    # _Stub（未加载的占位）没有 ndim —— 别让它把整个自愈炸掉，
                    # 只跳过这一个关键帧（20261031：之前一句 AttributeError
                    # 会让同批其余关键帧的网格对齐也一起被跳过）。
                    if lat is None or not hasattr(lat, "ndim") or lat.ndim != 5:
                        continue
                    if (int(lat.shape[3]) == latent_h
                            and int(lat.shape[4]) == latent_w):
                        continue
                    print("[H3 导演台] 关键帧潜空间 %s 与当前画布网格 %dx%d 不一致 ——"
                          " 已自动重采样对齐（首尾帧锚跟着当前阶段走，二采/三采不会中断）"
                          % (tuple(lat.shape), latent_h, latent_w))
                    kf["latent"] = _resample_keyframe_latent(lat, latent_h, latent_w)
        except Exception as e:
            print("[H3 导演台] 关键帧网格自愈跳过（%s: %s）" % (type(e).__name__, e))
        return original(self, *args, **kwargs)

    cls.__init__ = patched
    cls._h3studio_autofit = True
    return True


install_keyframe_autofit()
register_cont_routes()
