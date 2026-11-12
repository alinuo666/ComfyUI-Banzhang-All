# -*- coding: utf-8 -*-
"""图像编辑台 —— Qwen-Image 2.1 / MOSS-Image 双模型文本编码节点。

同一个节点服务两个模型家族，因为它们在**编码入口**上就分道扬镳，与其在外围
加开关糊过去，不如把差异收进一个判别点：

  · tokenizer 类型 —— MOSSImageTokenizer（qwen3.5_9b，last hidden state，
    open think block 模板）vs QwenImage21Tokenizer（qwen3vl_8b，图像槽位拼接）。
    两者 tokenize 签名不同：MOSS 不吃 images/keep_vision 参数。
  · 潜空间通道 —— MOSS 走 Flux2 格式 128 通道，Qwen-Image 2.1 走
    QwenImage21 格式 64 通道。DiT 输入维度不同，潜空间不能互换。
  · 参考图能力 —— MOSS 编码器**没有视觉塔**（实测权重里 0 条 visual），
    参考图对它完全不成立；Qwen-Image 2.1 有视觉塔，参考图是核心能力。

判别依据是 `type(clip.tokenizer).__name__`——这是唯一可靠信号：编码器类型
由 CLIPLoader 的 type 决定，用户接错 clip 时会走到明确报错而不是静默出错。

Qwen-Image 2.1 模式的编码逻辑与官方 TextEncodeQwenImage21
（comfy_extras/nodes_qwen.py）一致：参考图缩放后一式两份——视觉编码器看
缩放后的 RGB，DiT 看同一张图的 VAE 潜空间（reference_latents）；输出的空
潜空间取第一张参考图的尺寸，因为换成别的尺寸就会让编辑结果整体偏移。

与官方节点的不同只在参考图怎么进来：官方挂在自动增长的 IMAGE 端口上，本节点
由 🗂️ H3 媒体架 经 refs 端口喂入（槽位编号与媒体架一致）。槽位编号即提示词
里的 @图片N，由本节点转译成编码器真正看到的 <imageN>（qwen_image21.py 把参考
图拼成 "<image1><|vision_start|>..."，这个序号按**已填槽位**数，与官方
images= 的列表顺序同义）。

媒体架槽位可带别名（slot.alias）：提示词里直接写名字就引用那张图，由
expand_aliases 展开成 @图片N；\名字 是「保留文字、不展开」的转义写法。
面板上的「别名」开关（qwen_data.alias，缺省开）关掉后整张别名表作废——
同一张图既写别名又写 @图片N 会展开成两次引用（两个 <imageN>），关掉即可。

参考图一律全送，与 H3「提示词提到才送」相反：图片编辑改的就是这些图，不必在
提示词里点名；@图片N 只是用来在文字里区分它们（"把 @图片1 的猫放进 @图片2"）。

MOSS-Image 模式没有参考图这回事（无视觉塔），面板上参考图区会置灰。
MOSS 模式的提示词改写由**接入的 clip 自己做**（qwen3.5_9b 带 lm_head 与
mtp.fc.weight，权重实测存在），不额外占显存。
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
    FAMILY_MOSS, FAMILY_QWEN21, LATENT_CHANNELS, MOSS_REWRITE_SYSTEM,
    detect_family, rewrite_max_length, rewrite_prompt,
)

MULTIPLE = 32           # 参考图与画布的对齐粒度，与官方一致
CANVAS_DEFAULT = 1024
CANVAS_MAX = 4096
REF_CAP_DEFAULT = 1024  # 参考图最长边上限（px）；0 = 不设上限
REF_CAP_MAX = 4096

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


def _side(value, fallback):
    """画布单边：按 32 对齐后夹进合法区间；缺省/非法/小于下限都用 fallback。"""
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    if n < MULTIPLE:
        return fallback          # 旧存档里的 0（曾表示"跟随参考图"）回落默认画布
    return max(MULTIPLE, min(CANVAS_MAX, round(n / MULTIPLE) * MULTIPLE))


def _canvas(raw):
    """画布 (宽, 高)：按 32 对齐；缺省/非法回落官方默认 1024²。"""
    raw = raw if isinstance(raw, dict) else {}
    return (_side(raw.get("w"), CANVAS_DEFAULT), _side(raw.get("h"), CANVAS_DEFAULT))


def _long_side(value, fallback):
    """跟随图片1时的画布长边（px）：0 = 用图片原尺寸；其余按 32 对齐夹进 [32, 4096]。"""
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    if n <= 0:
        return 0
    return max(MULTIPLE, min(CANVAS_MAX, round(n / MULTIPLE) * MULTIPLE))


def ref_canvas_size(ow, oh, long_side):
    """图片1 尺寸缩到「长边 ≤ long_side」后的画布尺寸；long_side 为 0 即不设限。

    只缩不放：图片本来就比上限小，就按原尺寸出图（放大只是白花显存换不出细节）。
    缩放系数统一乘两边——若各边独立夹上限，6000×4000 会被算成 4096×4000，
    比例当场崩掉；4096 是无论如何都要守住的硬顶。之后两侧取最近的 32 倍数：
    这里不像参考图那样向下取整（参考图永远不能超过原图），画布取最近倍数比例更准
    ——800×600 向下取是 800×576（比例 1.39），取最近是 800×608（1.32），原图 1.33。
    """
    high = max(ow, oh)
    scale = (long_side / float(high)) if (long_side > 0 and high > long_side) else 1.0
    scale = min(scale, CANVAS_MAX / float(high))
    return (_align(ow * scale), _align(oh * scale))


def _align(v):
    """单边：取最近的 32 整数倍并夹进 [32, 4096]。"""
    return max(MULTIPLE, min(CANVAS_MAX, int(round(v / MULTIPLE)) * MULTIPLE))


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


def build_tag_map(cfg):
    """@图片N → <imageI>；I 只数已填槽位，与 tokenizer 的编号同义。"""
    tags = {}
    i = 0
    for n, slot in enumerate(cfg["images"], start=1):
        if slot is None:
            continue
        i += 1
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
        log("【提示词】有未识别的 @标签（引用参考图请用 @图片N 或直接写 <imageN>）：%s"
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
                   "MOSS-Image（qwen3.5_9b）走文生图，参考图区自动忽略。"
                   "prompt_text 接线时正面提示词改由外部文本提供（断线即恢复面板原文）。"
                   "面板可开启提示词改写——由接入的 CLIP 自己改写，不另接 LLM。")

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

        # 模型判别：一次判别，三处差异（tokenize 签名 / 潜空间通道 / 参考图能力）
        # 全部据此分流，不另设开关。
        family = detect_family(clip)
        is_moss = (family == FAMILY_MOSS)
        log("—— 图像编辑台 · 运行日志 ——")
        log("模型：%s" % ("MOSS-Image（文生图，无参考图）" if is_moss
                          else "Qwen-Image 2.1（图片编辑，支持参考图）"))

        # 外接提示词（模式 A）：接线即整体替换正面提示词。外部文本里可直接写
        # @图片N 或别名——展开与转译在下面照常生效。负面提示词不受影响。
        if prompt_text is not None:
            cfg["prompt"] = str(prompt_text)
            log("【提示词】外接模式：prompt_text 接线，正面提示词用外部文本"
                "（面板正面未参与；负面仍用面板）")

        tags = build_tag_map(cfg)
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

        # 提示词改写：用接入的 clip 自己（它带 lm_head，能出字），不另接 LLM 端口。
        # 放在转译之后——改写结果不该再带 @图片N 标签（改写模型不认这套语法）。
        if cfg["rewrite"] and prompt.strip():
            sys_prompt = cfg["rewrite_system"] or (MOSS_REWRITE_SYSTEM if is_moss else "")
            log("【改写】已开启")
            before = prompt
            prompt = rewrite_prompt(clip, prompt, sys_prompt,
                                    cfg["rewrite_max_length"], log)
            # 只有真的改动了才回填：失败时 rewrite_prompt 回落原文，
            # 这时把原文再写回面板等于抹掉用户刚输入的内容。
            if prompt != before:
                rewritten = prompt
                # 改写是「提示词看着对、画面却跑偏」的头号嫌疑，必须留全文对照
                log("【提示词·改写后】%d 字（原文 %d 字）\n%s"
                    % (len(prompt), len(before), prompt))
            else:
                log("【改写】模型输出与原文一致，本次未改动")

        cap = cfg["ref_cap"]
        cw, ch = cfg["canvas_w"], cfg["canvas_h"]
        images_vl, ref_latents = [], []
        first_ref = None   # 第一张参考图的原图尺寸 (宽, 高)，画布跟随的基准

        log("画布：%s"
            % ("跟随图片1" if cfg["canvas_from_ref"] else
               "%dx%d（面积 %.2fMP）" % (cw, ch, cw * ch / 1e6)))

        # 参考图：两个家族都走视觉塔。MOSS 的编码器是 Qwen3.5，带完整视觉塔
        # （MOSSImageTokenizer 继承 Qwen35ImageTokenizer，模板里有 <|vision_start|>），
        # 早先那句「MOSS 无视觉塔」是错的。差别在**下游**：只有 Qwen-Image 2.1 的
        # DiT 吃 reference_latents；MOSS 的 rope 里序列只有「生成图 token + 文本
        # token」，没有参考潜空间这条通道，所以 MOSS 不产 ref_latents，
        # 只靠视觉 token 影响文本条件——效果是「读过这张图再画」，不是按图编辑。
        log("参考尺寸：%s"
            % ("最长边上限 %d px（只缩不放）" % cap if cap else "原尺寸（不设上限）"))
        for n, slot in enumerate(cfg["images"], start=1):
            if slot is None:
                continue
            image = load_image(slot["file"])
            samples = image[:1].movedim(-1, 1)
            ow, oh = samples.shape[3], samples.shape[2]
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

        # 画布跟随图片1：取第一张参考图的**原图尺寸**，按面板填的长边上限等比缩小
        # （0 = 不设上限，但有 4096 硬顶），所以图片再大也撑不爆画布。
        # 没接参考图时回落面板画布，并说明白。
        if cfg["canvas_from_ref"] and not is_moss:
            if first_ref is not None:
                ow, oh = first_ref
                cw, ch = ref_canvas_size(ow, oh, cfg["ref_long"])
                log("【画布】跟随图片1：%dx%d → 长边 %s → %dx%d"
                    % (ow, oh,
                       "≤ %d px" % cfg["ref_long"] if cfg["ref_long"] else "不限",
                       cw, ch))
            else:
                log("【画布】勾选了「跟随图片1」但没有参考图，回落面板画布 %dx%d" % (cw, ch))

        # 画布由面板给出、始终是明确尺寸（按 32 对齐），输出潜空间直接取它。
        # 提醒一句官方的警告：采样尺寸与参考图不一致会让编辑结果整体偏移。
        if images_vl and not cfg["canvas_from_ref"]:
            log("【画布】%dx%d（与参考图编码尺寸无关，差异大时编辑结果可能整体偏移）" % (cw, ch))

        # 潜空间通道数按模型家族取：MOSS 走 Flux2 格式 128 通道，
        # Qwen-Image 2.1 走 QwenImage21 格式 64 通道。填错会在采样时炸。
        channels = LATENT_CHANNELS[family]
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
