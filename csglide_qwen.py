# -*- coding: utf-8 -*-
"""图像编辑台 —— Qwen-Image 2.1 / MOSS-Image / MiniMax H3 Image 三模型文本编码节点。

同一个节点服务三个模型家族，因为它们在**编码入口**上就分道扬镳，与其在外围
加开关糊过去，不如把差异收进一个判别点：

  · tokenizer 类型 —— MOSSImageTokenizer（qwen3.5_9b，last hidden state，
    open think block 模板）vs QwenImage21Tokenizer（qwen3vl_8b，图像槽位拼接）
    vs MiniMaxH3Tokenizer（qwen3vl_32b，<Picture N> 标签 + minimax_refs）。
    三者 tokenize 签名不同：MOSS 不吃 images/keep_vision 参数。
  · 潜空间通道与维度 —— MOSS 走 Flux2 格式 128 通道 4D，Qwen-Image 2.1 走
    QwenImage21 格式 64 通道 4D，H3 Image 走 24 通道 5D（T=1 静帧）。
    DiT 输入维度不同，潜空间不能互换。
  · 参考图能力 —— 三个家族都走视觉塔，但下游通道不同：Qwen-Image 2.1 的
    DiT 吃 reference_latents；H3 Image 的 DiT 吃 minimax_refs（视觉/VAE 看
    不同尺寸）；MOSS 没有参考潜空间通道，只靠视觉 token 影响文本条件。
  · 负面条件 —— H3 Image 用正面清零（ConditioningZeroOut），面板负面框不参与。
  · 提示词改写 —— H3 Image 主编码器截断 50 层不能出字，必须外接独立模型
    （同文案台机制：按文件名直连加载）；Qwen/MOSS 默认用主 CLIP 自己改写。

判别依据是 `type(clip.tokenizer).__name__`——这是唯一可靠信号：编码器类型
由 CLIPLoader 的 type 决定，用户接错 clip 时会走到明确报错而不是静默出错。

Qwen-Image 2.1 模式的编码逻辑与官方 TextEncodeQwenImage21
（comfy_extras/nodes_qwen.py）一致：参考图缩放后一式两份——视觉编码器看
缩放后的 RGB，DiT 看同一张图的 VAE 潜空间（reference_latents）；输出的空
潜空间取第一张参考图的尺寸，因为换成别的尺寸就会让编辑结果整体偏移。

H3 Image 模式的编码逻辑与官方 MiniMaxH3ImageConditioning
（comfy_extras/nodes_minimax_h3.py）一致：参考图视觉编码器看短边 1024，
VAE 看短边 [1024, 2048]（可放大小图），两份不同尺寸；DiT 吃 minimax_refs
条件键；画布上限 8192（官方推荐到 6272×2688）。

与官方节点的不同只在参考图怎么进来：官方挂在自动增长的 IMAGE 端口上，本节点
由 🗂️ H3 媒体架 经 refs 端口喂入（槽位编号与媒体架一致）。槽位编号即提示词
里的 @图片N，由本节点转译成编码器真正看到的标签（Qwen/MOSS 用 <imageN>，
H3 Image 用 <Picture N>）。

媒体架槽位可带别名（slot.alias）：提示词里直接写名字就引用那张图，由
expand_aliases 展开成 @图片N；\名字 是「保留文字、不展开」的转义写法。
面板上的「别名」开关（qwen_data.alias，缺省开）关掉后整张别名表作废——
同一张图既写别名又写 @图片N 会展开成两次引用（两个 <imageN>），关掉即可。

Qwen/MOSS 参考图一律全送：图片编辑改的就是这些图，不必在提示词里点名；
@图片N 只是用来在文字里区分它们（"把 @图片1 的猫放进 @图片2"）。
H3 Image 只送提示词引用的图（与官方 H3 工作流一致）：媒体架可能有几十张，
全送会让视觉 token 撑爆 qwen3vl_32b 的注意力矩阵（OOM）。

MOSS-Image 模式没有参考潜空间通道（视觉 token 仍进文本条件），面板上参考图
区会提示「读过再画」而非按图编辑。
"""

import json
import os
import re

import torch

import comfy.model_management
import comfy.utils
import node_helpers

from .csglide_assets import load_image, merge_rack_refs
from .csglide_image_models import (
    FAMILY_MOSS, FAMILY_QWEN21, FAMILY_H3IMAGE, LATENT_CHANNELS,
    MOSS_REWRITE_SYSTEM, H3IMAGE_REWRITE_SYSTEM,
    detect_family, rewrite_max_length, rewrite_prompt,
)

MULTIPLE = 32           # 参考图与画布的对齐粒度，与官方一致
CANVAS_DEFAULT = 1024
CANVAS_DEFAULT_H3 = 2048  # H3 Image 官方默认 2048²（模型调优面积 ~4MP）
CANVAS_MAX = 4096
CANVAS_MAX_H3 = 8192    # H3 Image 官方推荐到 6272×2688，硬顶放宽到 8192
REF_CAP_DEFAULT = 1024  # 参考图最长边上限（px）；0 = 不设上限
REF_CAP_MAX = 4096

# H3 Image 参考图尺寸（与官方 nodes_minimax_h3.py 同源）：
# 视觉编码器看短边 1024；VAE 看短边夹进 [1024, 2048]。两个消费者看不同尺寸。
H3_REF_VISION_SHORT = 1024
H3_REF_VAE_SHORT_MIN = 1024
H3_REF_VAE_SHORT_MAX = 2048

LEFTOVER_RE = re.compile(r"@\S+")


def ref_encode_size(ow, oh, cap):
    """参考图的编码尺寸：cap 是**最长边**上限（px，按 32 对齐），0 = 不设上限。

    只缩不放：超过上限就等比缩到上限，没超过就保持原尺寸交给 VAE——
    放大一张小图只是白花显存换不出细节，用户要的是「太大的压下来，
    小的别动」。两侧一律向下取 32 的整数倍，所以任何情况下都不会超过原图。
    """
    long_side = max(ow, oh)
    scale = (cap / float(long_side)) if (cap > 0 and long_side > cap) else 1.0
    w = max(MULTIPLE, (int(round(ow * scale)) // MULTIPLE) * MULTIPLE)
    h = max(MULTIPLE, (int(round(oh * scale)) // MULTIPLE) * MULTIPLE)
    return w, h


def _ref_cap(value):
    """参考图最长边上限：0/负数 = 不设上限，其余按 32 对齐并夹进 [32, 4096]。"""
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return REF_CAP_DEFAULT
    if n <= 0:
        return 0
    n = max(MULTIPLE, min(REF_CAP_MAX, n))
    return max(MULTIPLE, round(n / MULTIPLE) * MULTIPLE)


def _slots(raw):
    """白名单化槽位数组：只留带 file 的项，其余置 None 但保住编号位置。"""
    src = raw if isinstance(raw, list) else []
    return [s if isinstance(s, dict) and s.get("file") else None
            for s in src[:64]]


def _side(value, fallback, max_side=CANVAS_MAX):
    """画布单边：按 32 对齐后夹进合法区间；缺省/非法/小于下限都用 fallback。"""
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    if n < MULTIPLE:
        return fallback          # 旧存档里的 0（曾表示"跟随参考图"）回落默认画布
    return max(MULTIPLE, min(max_side, round(n / MULTIPLE) * MULTIPLE))


def _canvas(raw):
    """画布 (宽, 高)：按 32 对齐；缺省/非法回落官方默认 1024²。"""
    raw = raw if isinstance(raw, dict) else {}
    return (_side(raw.get("w"), CANVAS_DEFAULT), _side(raw.get("h"), CANVAS_DEFAULT))


def _long_side(value, fallback, max_side=CANVAS_MAX):
    """跟随图片1时的画布长边（px）：0 = 用图片原尺寸；其余按 32 对齐夹进 [32, max_side]。"""
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    if n <= 0:
        return 0
    return max(MULTIPLE, min(max_side, round(n / MULTIPLE) * MULTIPLE))


def ref_canvas_size(ow, oh, long_side, max_side=CANVAS_MAX):
    """图片1 尺寸缩到「长边 ≤ long_side」后的画布尺寸；long_side 为 0 即不设限。

    只缩不放：图片本来就比上限小，就按原尺寸出图（放大只是白花显存换不出细节）。
    缩放系数统一乘两边——若各边独立夹上限，6000×4000 会被算成 4096×4000，
    比例当场崩掉；max_side 是无论如何都要守住的硬顶。之后两侧取最近的 32 倍数：
    这里不像参考图那样向下取整（参考图永远不能超过原图），画布取最近倍数比例更准
    ——800×600 向下取是 800×576（比例 1.39），取最近是 800×608（1.32），原图 1.33。
    """
    high = max(ow, oh)
    scale = (long_side / float(high)) if (long_side > 0 and high > long_side) else 1.0
    scale = min(scale, max_side / float(high))
    return (_align(ow * scale, max_side), _align(oh * scale, max_side))


def _align(v, max_side=CANVAS_MAX):
    """单边：取最近的 32 整数倍并夹进 [32, max_side]。"""
    return max(MULTIPLE, min(max_side, int(round(v / MULTIPLE)) * MULTIPLE))


def _h3_short_edge_size(ow, oh, low, high):
    """H3 Image 参考图尺寸：短边夹进 [low, high]，等比缩放，32 对齐。
    与官方 _size_short_edge 同源——会放大小图（短边 < low 时拉到 low）。"""
    short = min(ow, oh)
    scale = min(max(short, low), high) / float(short)
    w = max(MULTIPLE, int(round(ow * scale / MULTIPLE)) * MULTIPLE)
    h = max(MULTIPLE, int(round(oh * scale / MULTIPLE)) * MULTIPLE)
    return w, h


def _zero_out_conditioning(cond):
    """H3 Image 负面 = 正面清零（与官方 ConditioningZeroOut 同义）。"""
    out = []
    for t in cond:
        d = t[1].copy()
        for key in ("pooled_output", "conditioning_lyrics", "conditioning_scale", "direct_context"):
            v = d.get(key)
            if v is not None:
                d[key] = torch.zeros_like(v)
        out.append([torch.zeros_like(t[0]), d])
    return out


# ---------------- 改写模型加载（同文案台机制）----------------
# 按文件名直连加载，不依赖画布连线。类变量缓存：第一次从磁盘读，之后常驻；
# 改写完交还驻留页。H3 Image 主编码器截断 50 层不能出字，必须外接独立模型。
_rw_clip_cache = None   # (模型文件相对路径, clip) 或 None


def _rewrite_model_names():
    """改写模型下拉候选：text_encoders 目录，MOSS-Image/ 优先。"""
    try:
        import folder_paths
        names = [n.replace("\\", "/") for n in folder_paths.get_filename_list("text_encoders")]
        moss = sorted(n for n in names if n.startswith("MOSS-Image/"))
        return moss or sorted(names)
    except Exception:
        return []


def _resolve_rewrite_model(model_file):
    base = ((model_file or "").strip() or "qwen3.5-2b-int8.safetensors").replace("\\", "/").split("/")[-1]
    for n in _rewrite_model_names():
        if n.split("/")[-1] == base:
            return n
    raise FileNotFoundError(
        "改写模型 %s 没找到，可选的有：%s" % (base, "、".join(_rewrite_model_names())))


def _get_rewrite_clip(log, model_file=None):
    global _rw_clip_cache
    hit = _resolve_rewrite_model(model_file)
    if _rw_clip_cache is not None and _rw_clip_cache[0] == hit:
        return _rw_clip_cache[1]
    if _rw_clip_cache is not None:
        log("切换改写模型：%s → %s" % (_rw_clip_cache[0], hit))
        try:
            _release_rewrite_clip(_rw_clip_cache[1], log)
        except Exception as e:
            log("旧改写模型退场失败（继续加载新模型）：%s" % e)
        _rw_clip_cache = None
    import nodes as _nodes
    import folder_paths
    loader = _nodes.NODE_CLASS_MAPPINGS["CLIPLoader"]()
    try:
        import comfy.model_management as _mm
        full = folder_paths.get_full_path("text_encoders", hit)
        need = int(os.path.getsize(full) * 1.15) if full else 10 * 1024 ** 3
        _mm.free_memory(need, _mm.get_torch_device())
    except Exception as e:
        log("改写模型加载前腾显存跳过：%s" % e)
    clip = loader.load_clip(hit, type="moss_image")[0]
    _rw_clip_cache = (hit, clip)
    log("改写模型 %s 已加载（按文件直连，不依赖画布连线）" % hit)
    return clip


def _release_rewrite_clip(clip, log):
    global _rw_clip_cache
    try:
        patcher = getattr(clip, "patcher", None)
        if patcher is not None:
            try:
                from .banzhang_vram_cleaner import release_model_residency
            except Exception:
                from banzhang_vram_cleaner import release_model_residency
            ram, vram = release_model_residency(patcher, log=log, label="改写模型")
            if ram or vram:
                log("已交还 —— 显存 %.0f MB / 内存 %.0f MB" % (vram / 1e6, ram / 1e6))
            import comfy.model_management as _mm
            _mm.unload_model_and_clones(patcher, unload_additional_models=False)
            if not patcher.is_dynamic():
                patcher.model.to("cpu")
            _mm.soft_empty_cache()
            log("改写模型已从显存账本摘除（下次按需重载）")
    except Exception as e:
        log("回收跳过：%s" % e)
    finally:
        _rw_clip_cache = None


# HTTP 路由：改写模型候选列表（前端下拉用，与文案台 /csglide_desk/models 同口径）
try:
    from aiohttp import web
    from server import PromptServer
    if getattr(PromptServer, "instance", None) is not None:
        @PromptServer.instance.routes.get("/csglide_qwen/models")
        async def _图像编辑台模型列表(request):
            return web.json_response({
                "models": _rewrite_model_names(),
                "default": "qwen3.5-2b-int8.safetensors",
            })

        @PromptServer.instance.routes.post("/csglide_qwen/rewrite")
        async def _图像编辑台改写接口(request):
            inst = PromptServer.instance
            if not hasattr(inst, "last_prompt_id"):
                inst.last_prompt_id = os.urandom(16).hex()
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"error": "请求体不是 JSON"}, status=400)
            prompt = str(body.get("prompt") or "")
            logs = []

            def _log(line):
                logs.append(str(line))
                print("[图像编辑台·改写] " + str(line))

            try:
                model = str(body.get("model") or "").strip()
                clip = _get_rewrite_clip(_log, model or None)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
            # 参考图：前端直传媒体架快照，缩到长边 512 给改写模型看。
            imgs = []
            refs = str(body.get("refs") or "")
            if refs:
                try:
                    data = json.loads(refs)
                    slots = (data.get("slots") or {}).get("images") or []
                    for slot in slots:
                        if not isinstance(slot, dict) or not slot.get("file"):
                            continue
                        try:
                            img = load_image(slot["file"])
                            h, w = int(img.shape[1]), int(img.shape[2])
                            long = max(w, h)
                            if long > 512:
                                s = 512 / long
                                nw = max(32, (int(w * s) // 32) * 32)
                                nh = max(32, (int(h * s) // 32) * 32)
                                img = comfy.utils.common_upscale(
                                    img.movedim(-1, 1), nw, nh,
                                    "lanczos", "disabled").movedim(1, -1)
                            imgs.append(img)
                        except Exception:
                            pass
                except Exception:
                    pass
            _log("参考图 %d 张（长边 ≤512）" % len(imgs))
            sys_p = str(body.get("system") or "").strip()
            max_len = int(body.get("max_length") or 512)
            try:
                new = rewrite_prompt(clip, prompt, sys_p, max_len, _log,
                                     images=imgs or None)
            finally:
                _release_rewrite_clip(clip, _log)
            return web.json_response({"text": new, "logs": logs})
except Exception:
    pass


def parse_qwen_data(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    canvas_w, canvas_h = _canvas(data.get("canvas"))
    return {
        "prompt": str(data.get("prompt") or ""),
        "negative_prompt": str(data.get("negative_prompt") or ""),
        # 旧存档里叫 resolution（当时是按面积锚定），数值本身当「最长边上限」用依然合理
        "ref_cap": _ref_cap(data.get("ref_cap", data.get("resolution"))),
        "canvas_w": canvas_w,
        "canvas_h": canvas_h,
        # 画布跟随图片1：勾上后输出尺寸取图片1的原尺寸，长按 ref_long 等比缩；
        # 面板上的画布数值保留但不用（没接参考图时回落面板画布）
        "canvas_from_ref": bool(data.get("canvas_from_ref")),
        "ref_long": _long_side(data.get("ref_long"), CANVAS_DEFAULT),
        "images": _slots(data.get("images")),
        # 提示词改写：开关 + 系统提示词 + 采样参数。改写由接入的 clip 自己做，
        # 不另接 LLM 端口（用户定：改写模型用接入的那个）。
        "rewrite": bool(data.get("rewrite", False)),
        "rewrite_system": str(data.get("rewrite_system") or ""),
        "rewrite_max_length": rewrite_max_length(data.get("rewrite_max_length")),
        # 别名开关：缺省开（旧存档没有这一项，保持它们原本的行为）。
        # 关掉后只认 @图片N，槽位里起的名字一律当普通文字。
        "alias": data.get("alias", True) is not False,
        # 片子级（LoRA 触发词）。前端提交前就已经拼进 prompt 最前面，
        # 这里单独留一份原件——只为日志能分开「哪段是自动加的」，
        # 不参与编码、也不影响任何既有行为。
        "global": str(data.get("global") or ""),
        # 本次不要参考图（批量跑资产时前端置真）。空 images 挡不住媒体架回填——
        # merge_rack_refs 把空数组当「面板没填」，必须另给一个显式声明。
        "no_refs": bool(data.get("no_refs")),
        # 改写模型文件名（同文案台机制：按文件名直连加载，不依赖画布连线）。
        # 空 = Qwen/MOSS 用主 CLIP 自己改写；H3 Image 必须外接（主编码器截断50层不能出字）。
        "rewrite_model": str(data.get("rewrite_model") or ""),
    }


# ---------------- 别名（命名引用）----------------
# 媒体架槽位可带别名（slot.alias）：剧本里写「小明」就引用 @图片N。
# 口径与 csglide_cast.py / csglide_media_rack.js 同源：全角空格归一、
# 单字不注册、含 @ 或反斜杠不行、撞内置词不行、先出现者优先。
ALIAS_SPLIT = re.compile(r"[,，、;；]+")
ALIAS_MIN, ALIAS_MAX, ALIAS_TOTAL = 2, 40, 12
BUILTIN_ALIAS = re.compile(r"^(?:图片\d+|视频音频\d+|视频\d+|音频\d+)$")
_ALIAS_ESC = "\u0000"            # 哨兵：提示词里不可能出现的字符


def _norm_space(s):
    """全角空格 U+3000 → 半角。中文输入法在词间极易产出全角空格，两侧都要归一。"""
    return s.replace("\u3000", " ") if s else s


def _alias_ok(name):
    return (ALIAS_MIN <= len(name) <= ALIAS_MAX
            and "@" not in name and "\\" not in name
            and not BUILTIN_ALIAS.match(name))


def alias_table(cfg):
    """名字(不含@) → 规范 token（@图片N）；先出现者优先，重名后者失效。

    写法即作用域：@小明 → 必须带 @ 才引用（名字太常见时用），返回 strict 集合。
    """
    table, strict = {}, set()
    for n, slot in enumerate(cfg["images"], start=1):
        if slot is None:
            continue
        raw = slot.get("alias")
        if isinstance(raw, str):
            parts = ALIAS_SPLIT.split(raw)
        elif isinstance(raw, list):
            parts = [p for p in raw if isinstance(p, str)]
        else:
            continue
        count = 0
        for p in parts:
            a = _norm_space(p.strip())
            if not a or len(a) > ALIAS_MAX or a in table:
                continue
            at = a.startswith("@")
            name = a[1:] if at else a
            if not _alias_ok(name) or name in table:
                continue
            table[name] = "@图片%d" % n
            if at:
                strict.add(name)
            count += 1
            if count >= ALIAS_TOTAL:
                break
    return table, strict


def expand_aliases(text, table, strict):
    """把别名替换成规范 token，返回新文本。无别名时原样返回。

    逐个别名按长度先长后短替换（短名不能吃掉长名的一段）；\别名 是「保留
    文字、不展开」的转义写法，用哨兵挡住后续匹配再统一还原。
    """
    if not text or not table:
        return text
    text = _norm_space(str(text))
    names = sorted(table, key=len, reverse=True)
    text = re.sub(r"\\(?=%s)" % "|".join(re.escape(n) for n in names),
                  _ALIAS_ESC, text)
    for n in names:
        # 边界只按「首尾是否 ASCII 字母」分组：中文没有空格分词，若连汉字一起
        # 挡，「看小明走过来」这种最常见的句式会整个失效（与 csglide_cast.py 同）。
        edge = "ascii" if re.search(r"[A-Za-z]", n[0] + n[-1]) else "cjk"
        left = "(?<![\\u0000\\\\A-Za-z0-9])" if edge == "ascii" else "(?<![\\u0000\\\\0-9])"
        right = "(?![A-Za-z0-9])" if edge == "ascii" else "(?![0-9])"
        at = "@" if n in strict else "@?"
        text = re.sub(left + at + "(" + re.escape(n) + ")" + right, table[n], text)
    return text.replace(_ALIAS_ESC, "")


def build_tag_map(cfg, family=FAMILY_QWEN21):
    """@图片N → 编码器标签；I 只数已填槽位，与 tokenizer 的编号同义。
    H3 Image 用 <Picture N>（有空格），其余用 <imageN>。"""
    tags = {}
    i = 0
    for n, slot in enumerate(cfg["images"], start=1):
        if slot is None:
            continue
        i += 1
        if family == FAMILY_H3IMAGE:
            tags["@图片%d" % n] = "<Picture %d>" % i
        else:
            tags["@图片%d" % n] = "<image%d>" % i
    return tags


def transcribe_prompt(prompt, tags, known, log):
    """把 @图片N 换成真实标签；指向空槽位的引用整段删掉并告警。"""
    out = prompt
    for token in sorted(known, key=len, reverse=True):
        if token in tags:
            out = out.replace(token, tags[token])
        elif token in out:
            log("【提示词】%s 指向空槽位，已从提示词移除" % token)
            out = out.replace(token, "")
    leftover = sorted(set(LEFTOVER_RE.findall(out)))
    if leftover:
        log("【提示词】有未识别的 @标签（引用参考图请用 @图片N）：%s"
            % ", ".join(leftover))
    return out


class CSGlideImageCast:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                # 不放多行：v2 前端会把多行 STRING 渲染成浮在节点 UI 上的
                # textarea，吃掉那一条里的所有点击（同导演台 h3_data）。
                "qwen_data": ("STRING", {"default": ""}),
            },
            "optional": {
                "vae": ("VAE",),
                "refs": ("H3_REFS",),
                # 外接提示词：接线即接管**正面**提示词（模式 A），负面仍归面板。
                # 面板 st.prompt 永不被外部数据污染——断线即恢复原文。
                "prompt_text": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "STRING")
    RETURN_NAMES = ("正面条件", "负面条件", "潜空间", "日志")
    FUNCTION = "build"
    CATEGORY = "👨‍🏫班长/图像处理"
    DESCRIPTION = ("图像编辑台——按接入的 CLIP 自动分流："
                   "Qwen-Image 2.1（qwen3vl_8b）走图片编辑，参考图接 🗂️ H3 媒体架，"
                   "提示词里写 @图片N 指代第 N 张参考图；"
                   "MOSS-Image（qwen3.5_9b）走文生图，参考图区自动忽略；"
                   "MiniMax H3 Image（qwen3vl_32b）走文生图 + 图片编辑，"
                   "负面自动用正面清零，画布上限 8192。"
                   "prompt_text 接线时正面提示词改由外部文本提供（断线即恢复面板原文）。"
                   "面板可开启提示词改写——Qwen/MOSS 默认用主 CLIP，H3 必须外接独立模型。")

    def build(self, clip, qwen_data, vae=None, refs=None, prompt_text=None):
        try:
            return self._build(clip, qwen_data, vae, refs, prompt_text)
        except Exception as e:
            print("[图像编辑台] 运行出错：%s: %s" % (type(e).__name__, e))
            raise

    def _build(self, clip, qwen_data, vae=None, refs=None, prompt_text=None):
        cfg = parse_qwen_data(qwen_data)
        merge_rack_refs(cfg, refs)

        logs = []
        # 改写后的提示词：通过 ui 推回前端，回填到提示词框。没有它的话，
        # 改写只在后端发生、用户看不见——面板提示词框与实际送去编码的文本
        # 会对不上，等于「面板说了不算」。
        rewritten = None

        def log(msg):
            line = str(msg)
            logs.append(line)
            print("[图像编辑台] " + line)

        # 模型判别：一次判别，各处差异（tokenize 签名 / 潜空间通道 / 参考图能力）
        # 全部据此分流，不另设开关。
        family = detect_family(clip)
        is_moss = (family == FAMILY_MOSS)
        is_h3 = (family == FAMILY_H3IMAGE)
        log("—— 图像编辑台 · 运行日志 ——")
        log("模型：%s" % ("MOSS-Image（文生图，无参考图）" if is_moss
                          else "MiniMax H3 Image（文生图 + 图片编辑）" if is_h3
                          else "Qwen-Image 2.1（图片编辑，支持参考图）"))

        # H3 Image 画布上限 8192、默认 2048²（官方 IMAGE_SIZE）。parse 阶段按
        # 4096/1024 夹过，这里从原始数据重读，用 H3 参数重新夹。
        if is_h3:
            _raw = json.loads(qwen_data) if isinstance(qwen_data, str) else (qwen_data or {})
            _rc = _raw.get("canvas") or {}
            cfg["canvas_w"] = _side(_rc.get("w"), CANVAS_DEFAULT_H3, CANVAS_MAX_H3)
            cfg["canvas_h"] = _side(_rc.get("h"), CANVAS_DEFAULT_H3, CANVAS_MAX_H3)
            cfg["ref_long"] = _long_side(_raw.get("ref_long"), CANVAS_DEFAULT_H3, CANVAS_MAX_H3)

        # 外接提示词（模式 A）：接线即整体替换正面提示词。外部文本里可直接写
        # @图片N 或别名——展开与转译在下面照常生效。负面提示词不受影响。
        if prompt_text is not None:
            cfg["prompt"] = str(prompt_text)
            log("【提示词】外接模式：prompt_text 接线，正面提示词用外部文本"
                "（面板正面未参与；负面仍用面板）")

        tags = build_tag_map(cfg, family)
        known = ["@图片%d" % i for i in range(1, len(cfg["images"]) + 1)]
        table, strict = alias_table(cfg) if cfg["alias"] else ({}, set())
        if not cfg["alias"]:
            log("【别名】已关闭：只认 @图片N，槽位里的名字当普通文字"
                "（同一张图既写名字又写 @图片N 时用它避免重复引用）")
        elif table:
            log("【别名】" + "  ".join(
                "%s%s → %s" % (k, "（仅@）" if k in strict else "", v)
                for k, v in table.items()))
        # 中间态全留在变量里：日志要逐段对照。只打最终值的话，
        # 「字被别名吃了」「@ 转译动了内容」「压根没送进来」这三种
        # 完全不同的故障长得一模一样。
        pos_raw, neg_raw = cfg["prompt"], cfg["negative_prompt"]
        pos_exp = expand_aliases(pos_raw, table, strict)
        neg_exp = expand_aliases(neg_raw, table, strict)
        # H3 Image：只送提示词引用的图（与官方 H3 工作流一致）。媒体架可能
        # 有几十张，全送会让视觉 token 撑爆 qwen3vl_32b 的注意力矩阵（OOM）。
        # 别名已展开成 @图片N，这里扫的是展开后的文本。标签表重建：只含被
        # 引用且非空的槽位，序号从 1 重编——与 images_vl 的顺序对齐。
        ref_filter = None
        if is_h3:
            ref_filter = set()
            for m in re.finditer(r"@图片(\d+)", pos_exp):
                n = int(m.group(1))
                if 1 <= n <= len(cfg["images"]) and cfg["images"][n - 1] is not None:
                    ref_filter.add(n)
            tags = {}
            i = 0
            for n, slot in enumerate(cfg["images"], start=1):
                if slot is None or n not in ref_filter:
                    continue
                i += 1
                tags["@图片%d" % n] = "<Picture %d>" % i
        log("【片子级】%s" % (cfg["global"].strip() or "（空，不拼）"))
        # 外接模式下 cfg["prompt"] 已被外部文本覆盖，标签跟着改，
        # 否则日志会把外部文本标成「面板原文」，排查时反而被误导。
        pos_src = "外部文本" if prompt_text is not None else "面板原文"
        log("【提示词·%s】%d 字\n%s" % (pos_src, len(pos_raw), pos_raw.strip() or "（空）"))
        if pos_exp != pos_raw:
            log("【提示词·别名展开后】%d 字\n%s" % (len(pos_exp), pos_exp))
        prompt = transcribe_prompt(pos_exp, tags, known, log)
        log("【提示词·送编码】%d 字%s\n%s"
            % (len(prompt), "（含 @ 转译）" if prompt != pos_exp else "",
               prompt.strip() or "（空）"))
        log("【负面·面板原文】%d 字\n%s" % (len(neg_raw), neg_raw.strip() or "（空）"))
        if neg_exp != neg_raw:
            log("【负面·别名展开后】%d 字\n%s" % (len(neg_exp), neg_exp))
        negative = transcribe_prompt(neg_exp, tags, known, log)
        log("【负面·送编码】%d 字%s\n%s"
            % (len(negative), "（含 @ 转译）" if negative != neg_exp else "",
               negative.strip() or "（空）"))

        # 提示词改写：H3 Image 主编码器截断 50 层不能出字，必须外接独立模型（同文案台
        # 机制：按文件名直连加载）。Qwen/MOSS 默认用主 CLIP 自己改写；指定了 rewrite_model
        # 时也走外部模型。放在转译之后——改写结果不该再带 @图片N 标签。
        if cfg["rewrite"] and prompt.strip():
            sys_prompt = cfg["rewrite_system"] or (
                H3IMAGE_REWRITE_SYSTEM if is_h3 else MOSS_REWRITE_SYSTEM if is_moss else "")
            log("【改写】已开启")
            # 改写模型看图：缩到长边 512（只缩不放），与文案台同口径。
            # H3 只给被引用的图（ref_filter），Qwen/MOSS 全给。
            rw_imgs = []
            for n, slot in enumerate(cfg["images"], start=1):
                if slot is None:
                    continue
                if ref_filter is not None and n not in ref_filter:
                    continue
                try:
                    img = load_image(slot["file"])
                    h, w = int(img.shape[1]), int(img.shape[2])
                    long = max(w, h)
                    if long > 512:
                        s = 512 / long
                        nw = max(32, (int(w * s) // 32) * 32)
                        nh = max(32, (int(h * s) // 32) * 32)
                        img = comfy.utils.common_upscale(
                            img.movedim(-1, 1), nw, nh,
                            "lanczos", "disabled").movedim(1, -1)
                    rw_imgs.append(img)
                except Exception:
                    pass
            if rw_imgs:
                log("【改写】参考图 %d 张（长边 ≤512）" % len(rw_imgs))
            before = prompt
            rw_clip = None
            try:
                if is_h3 or cfg["rewrite_model"]:
                    rw_clip = _get_rewrite_clip(log, cfg["rewrite_model"] or None)
                    prompt = rewrite_prompt(rw_clip, prompt, sys_prompt,
                                            cfg["rewrite_max_length"], log,
                                            images=rw_imgs or None)
                else:
                    prompt = rewrite_prompt(clip, prompt, sys_prompt,
                                            cfg["rewrite_max_length"], log,
                                            images=rw_imgs or None)
            finally:
                if rw_clip is not None:
                    try:
                        _release_rewrite_clip(rw_clip, log)
                    except Exception:
                        pass
            # 只有真的改动了才回填：失败时 rewrite_prompt 回落原文，
            # 这时把原文再写回面板等于抹掉用户刚输入的内容。
            if prompt != before:
                rewritten = prompt
                log("【提示词·改写后】%d 字（原文 %d 字）\n%s"
                    % (len(prompt), len(before), prompt))
            else:
                log("【改写】模型输出与原文一致，本次未改动")

        cap = cfg["ref_cap"]
        cw, ch = cfg["canvas_w"], cfg["canvas_h"]
        images_vl, ref_latents = [], []
        first_ref = None   # 第一张参考图的尺寸 (宽, 高)，画布跟随的基准

        log("画布：%s"
            % ("跟随图片1" if cfg["canvas_from_ref"] else
               "%dx%d（面积 %.2fMP）" % (cw, ch, cw * ch / 1e6)))

        # 参考图：三个家族都走视觉塔，但下游通道不同：
        # · Qwen-Image 2.1：DiT 吃 reference_latents（VAE 潜空间），按图编辑
        # · MOSS：无参考潜空间通道，只靠视觉 token 影响文本条件（读过再画）
        # · H3 Image：DiT 吃 minimax_refs（VAE 潜空间块），视觉/VAE 看不同尺寸
        if is_h3:
            log("参考尺寸：视觉短边 %d px / VAE 短边 [%d, %d] px（可放大小图）"
                % (H3_REF_VISION_SHORT, H3_REF_VAE_SHORT_MIN, H3_REF_VAE_SHORT_MAX))
        else:
            log("参考尺寸：%s"
                % ("最长边上限 %d px（只缩不放）" % cap if cap else "原尺寸（不设上限）"))
        if ref_filter is not None:
            total = sum(1 for s in cfg["images"] if s is not None)
            log("【参考图】H3 Image：只送提示词引用的图（媒体架 %d 张，引用 %d 张，跳过 %d 张）"
                % (total, len(ref_filter), total - len(ref_filter)))
        for n, slot in enumerate(cfg["images"], start=1):
            if slot is None:
                continue
            if ref_filter is not None and n not in ref_filter:
                log("图片 @图片%d %s  跳过（提示词未引用）"
                    % (n, os.path.basename(slot["file"])))
                continue
            image = load_image(slot["file"])
            samples = image[:1].movedim(-1, 1)
            ow, oh = samples.shape[3], samples.shape[2]
            if is_h3:
                # H3: 视觉编码器看短边 1024，VAE 看短边 [1024, 2048]，两份不同尺寸。
                # 与官方 _image_refs 同源——会放大小图（短边 < 1024 时拉到 1024）。
                vw, vh = _h3_short_edge_size(ow, oh, H3_REF_VISION_SHORT, H3_REF_VISION_SHORT)
                dw, dh = _h3_short_edge_size(ow, oh, H3_REF_VAE_SHORT_MIN, H3_REF_VAE_SHORT_MAX)
                if first_ref is None:
                    first_ref = (dw, dh)    # VAE 缩放后的尺寸，画布跟随的基准
                if (vw, vh) == (ow, oh):
                    s_vl = image[:1]
                else:
                    s_vl = comfy.utils.common_upscale(samples, vw, vh, "lanczos", "disabled").movedim(1, -1)
                images_vl.append(s_vl)
                if vae is not None:
                    if (dw, dh) == (ow, oh):
                        s_vae = image[:1]
                    else:
                        s_vae = comfy.utils.common_upscale(samples, dw, dh, "lanczos", "disabled").movedim(1, -1)
                    z = vae.encode(s_vae)
                    ref_latents.append({"kind": "image", "latent_h": z.shape[-2],
                                        "latent_w": z.shape[-1], "latent": z})
                log("图片 @图片%d %s  原图 %dx%d → 视觉 %dx%d  VAE %dx%d  潜空间 %dx%d"
                    % (n, os.path.basename(slot["file"]), ow, oh, vw, vh, dw, dh,
                       dh // 16, dw // 16))
                continue
            width, height = ref_encode_size(ow, oh, cap)
            if first_ref is None:
                first_ref = (ow, oh)        # 原图尺寸，画布跟随的基准
            if (width, height) == (ow, oh):
                s = image[:1]
            else:
                s = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)
            images_vl.append(s)
            if is_moss:
                log("图片 @图片%d %s  原图 %dx%d → 编码 %dx%d（MOSS 走视觉塔，不进潜空间）"
                    % (n, os.path.basename(slot["file"]), ow, oh, width, height))
                continue
            if vae is not None:
                ref_latents.append(vae.encode(s))
            log("图片 @图片%d %s  原图 %dx%d → 编码 %dx%d  潜空间 %dx%d"
                % (n, os.path.basename(slot["file"]), ow, oh, width, height,
                   height // 16, width // 16))

        if not images_vl:
            log("【参考图】没有填任何槽位——本次按纯文生图编码")
        elif is_moss:
            log("【参考图】MOSS 的编码器带视觉塔，图按视觉 token 进了文本条件；"
                "但 MOSS 没有参考潜空间通道，是「读过这张图再画」，不是按图编辑。")
        elif is_h3 and ref_latents:
            log("【参考图】H3 Image：图按 minimax_refs 进了 DiT 潜空间，按图编辑。")

        if is_moss:
            # MOSS 的 tokenizer 走 Qwen35ImageTokenizer：有图时父类会自动用带
            # <|vision_start|><|image_pad|><|vision_end|> 的模板（按张数复制）。
            # 但它自己有一段「没指定 thinking 就强制套纯文本模板」的覆盖，
            # 不显式给 thinking=False 的话，图会被那个纯文本模板吞掉。
            # 没有参考图时不传任何多余参数，保持原有出图行为一字不变。
            if images_vl:
                positive = clip.encode_from_tokens_scheduled(
                    clip.tokenize(prompt, images=images_vl, thinking=False,
                                  prevent_empty_text=True))
                negative = clip.encode_from_tokens_scheduled(
                    clip.tokenize(negative, images=images_vl, thinking=False,
                                  prevent_empty_text=True))
            else:
                positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))
                negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative))
        elif is_h3:
            # H3 Image：tokenize 用 picture_label="Picture %d: "（与官方一致，
            # 无尖括号——tokenizer 默认带尖括号，官方显式覆盖）。
            # 参考图走 minimax_refs 条件键（不是 reference_latents）。
            positive = clip.encode_from_tokens_scheduled(
                clip.tokenize(prompt, images=images_vl, picture_label="Picture %d: "))
            if ref_latents:
                positive = node_helpers.conditioning_set_values(
                    positive, {"minimax_refs": ref_latents})
            elif images_vl and vae is None:
                log("【VAE】未接 VAE——参考图只走视觉编码器，不进 DiT 潜空间（效果会明显变弱）")
            # H3 负面 = 正面清零（官方工作流用 ConditioningZeroOut 节点）。
            # 面板负面框不参与——前端置灰提示用户。
            negative = _zero_out_conditioning(positive)
            log("【负面】H3 Image 用正面清零作负面（面板负面框不参与）")
        else:
            # 没接 VAE 就没有潜空间可替换视觉 token，此时视觉 token 必须留下，
            # 参考图只经文本编码器这一条路影响结果（官方 keep_vision 同义）。
            keep_vision = len(ref_latents) == 0
            positive = clip.encode_from_tokens_scheduled(
                clip.tokenize(prompt, images=images_vl, keep_vision=keep_vision,
                              prevent_empty_text=True))
            negative = clip.encode_from_tokens_scheduled(
                clip.tokenize(negative, images=images_vl, keep_vision=keep_vision,
                              prevent_empty_text=True))
            if ref_latents:
                positive = node_helpers.conditioning_set_values(
                    positive, {"reference_latents": ref_latents}, append=True)
                negative = node_helpers.conditioning_set_values(
                    negative, {"reference_latents": ref_latents}, append=True)
            elif images_vl and vae is None:
                log("【VAE】未接 VAE——参考图只走视觉编码器，不进 DiT 潜空间（效果会明显变弱）")

        # 画布跟随图片1：Qwen/MOSS 取原图尺寸，H3 取 VAE 缩放后的尺寸（与官方
        # width=0 时用 vae_size(image_1) 同义）。按面板长边上限等比缩小，
        # H3 硬顶 8192，其余 4096。没接参考图时回落面板画布。
        if cfg["canvas_from_ref"] and not is_moss:
            if first_ref is not None:
                ow, oh = first_ref
                _max = CANVAS_MAX_H3 if is_h3 else CANVAS_MAX
                cw, ch = ref_canvas_size(ow, oh, cfg["ref_long"], _max)
                log("【画布】跟随图片1%s：%dx%d → 长边 %s → %dx%d"
                    % ("（VAE 缩放后）" if is_h3 else "", ow, oh,
                       "≤ %d px" % cfg["ref_long"] if cfg["ref_long"] else "不限",
                       cw, ch))
            else:
                log("【画布】勾选了「跟随图片1」但没有参考图，回落面板画布 %dx%d" % (cw, ch))

        # 画布由面板给出、始终是明确尺寸（按 32 对齐），输出潜空间直接取它。
        # 提醒一句官方的警告：采样尺寸与参考图不一致会让编辑结果整体偏移。
        if images_vl and not cfg["canvas_from_ref"]:
            log("【画布】%dx%d（与参考图编码尺寸无关，差异大时编辑结果可能整体偏移）" % (cw, ch))

        # 潜空间通道数与维度按模型家族取：
        # MOSS 128 通道 4D / Qwen-Image 2.1 64 通道 4D / H3 Image 24 通道 5D（T=1 静帧）。
        channels = LATENT_CHANNELS[family]
        if is_h3:
            latent = {"samples": torch.zeros([1, channels, 1, ch // 16, cw // 16],
                                             device=comfy.model_management.intermediate_device())}
        else:
            latent = {"samples": torch.zeros([1, channels, ch // 16, cw // 16],
                                             device=comfy.model_management.intermediate_device())}
        if tags and not is_moss:
            log("【提示词转译】" + "  ".join("%s → %s" % (k, v) for k, v in sorted(tags.items())))
        log("【输出】潜空间 %s（画面 %dx%d）"
            % (tuple(latent["samples"].shape), cw, ch))

        # 把改写后的提示词推回前端：ComfyUI 执行时会把节点返回的 ui 挂到
        # executed 事件上（execution.py 里 send_sync("executed", {...output})），
        # 前端监听该事件即可回填提示词框——不必查 history（普通节点的
        # STRING 输出不进 history，只有 OUTPUT_NODE 的 ui 才进）。
        # 只在真的改写了才带 ui 键：ui 为 None 也会被算进 output_ui，
        # 让下游按「有 ui」处理却没有内容。
        result = (positive, negative, latent, "\n".join(logs))
        if rewritten:
            return {"ui": {"text": [rewritten]}, "result": result}
        return result

    @classmethod
    def IS_CHANGED(cls, qwen_data, **kwargs):
        # 媒体架的 rack_data 变化随 refs 传入，一并计入，否则上游改素材而本节点
        # qwen_data 未变时会被缓存跳过。外接提示词同理：上游改文本也要重跑。
        return "%s|%s|%s" % (qwen_data, kwargs.get("refs") or "",
                             kwargs.get("prompt_text") or "")


NODE_CLASS_MAPPINGS = {"CSGlideImageCastCS": CSGlideImageCast}
NODE_DISPLAY_NAME_MAPPINGS = {"CSGlideImageCastCS": "🎨 图像编辑台 (Image Studio)"}
