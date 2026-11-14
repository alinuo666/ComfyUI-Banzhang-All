"""对 ComfyUI 内部的三处适配：取子模型、给位置打标签、补两条缺失的路径。

这些东西本质上是在绕过 ComfyUI 为 32B 写死的假设，跟「投影」本身无关，
所以单独一个文件。上游一改，只需要看这里。

移植自 ComfyUI-ClipProj 0.1.13（MIT，nicolab28）。
"""

import json
import logging
import struct

import torch

# 视觉塔 merger 的输出宽度 → 该用哪个 CLIPType 实例化。
# 直接读 safetensors 头，所以 fp8 / nvfp4 / int8 这些量化版一样认得出来。
_ARCH_BY_DIM = {2560: ("krea2", "4B"), 4096: ("boogu", "8B"),
                5120: ("minimax", "32B")}
_MERGER_KEYS = ("model.visual.merger.linear_fc2.weight",
                "visual.merger.linear_fc2.weight")

# Qwen3-VL 全家的词表都是这个数。
# 为什么必须查词表而不只看宽度：Qwen3.5 的宽度和 Qwen3-VL 撞得一模一样
# （4B/2560、9B/4096），MOSS-Image 的 qwen3.5_9b 在这里会被认成 Qwen3-VL-8B，
# 然后用错误的 CLIPType 加载、产出一份忽略 prompt 的条件 —— 全程不报错。
# 词表是最硬的判据：151936 对 248320，差着十万。
_VOCAB_QWEN3VL = 151936


def detect_arch(path):
    """读 safetensors 头判断这是 4B / 8B / 32B 里的哪个。

    Returns:
        tuple[str, str]|None: (CLIPType 名, 人类可读标签)，认不出返回 None。
    """
    try:
        with open(path, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            header = json.loads(f.read(n))
    except Exception:
        return None

    # 键名在家族里不统一（model.embed_tokens 与 model.language_model.embed_tokens
    # 都见过），所以按后缀匹配，顺便避开 .weight_scale / .comfy_quant。
    vocab = None
    for k, v in header.items():
        if k.endswith("embed_tokens.weight") and isinstance(v, dict) and v.get("shape"):
            vocab = v["shape"][0]
            break
    if vocab != _VOCAB_QWEN3VL:
        return None

    for key in _MERGER_KEYS:
        entry = header.get(key)
        if entry and entry.get("shape"):
            return _ARCH_BY_DIM.get(entry["shape"][0])
    return None


def submodel(clip):
    """取出内层 SDClipModel，绕过 TEModel 的重写。

    Krea2、Mage 这些专用 TEModel 会改写 encode_token_weights（剥模板、堆多层），
    我们要的是原始隐藏态，所以直接对着 transformer 说话。
    """
    csm = clip.cond_stage_model
    name = getattr(csm, "clip", None)
    if name is not None and hasattr(csm, name):
        return getattr(csm, name)
    for attr in dir(csm):
        if attr.startswith("_"):
            continue
        sub = getattr(csm, attr, None)
        if hasattr(sub, "encode_token_weights") and hasattr(sub, "transformer"):
            return sub
    raise RuntimeError("这个 CLIP 里找不到可用的子模型")


def raw_tokenizer(clip):
    """取出 CLIP 底下的 HuggingFace 分词器。"""
    tk = clip.tokenizer
    name = getattr(tk, "clip_name", None)
    if name is not None and hasattr(tk, name):
        sub = getattr(tk, name)
        if hasattr(sub, "tokenizer"):
            return sub.tokenizer
    for attr in dir(tk):
        if attr.startswith("_"):
            continue
        sub = getattr(tk, attr, None)
        if hasattr(sub, "tokenizer"):
            return sub.tokenizer
    raise RuntimeError("这个 CLIP 里找不到分词器")


def tags_from_embeds_info(seq_len, embeds_info):
    """按 MiniMax H3 的规矩给位置打标：画面块是 0，文字是 1。

    整个画面块都算 0，包括两头夹着的 vision_start / vision_end，所以左右各
    放宽一格。这些标签直接驱动 DiT 的 adaLN，错一格画面就飘。
    """
    tags = torch.ones(seq_len, dtype=torch.long)
    for e in embeds_info:
        if e.get("type") == "image":
            tags[max(0, e["index"] - 1):e["index"] + e["size"] + 1] = 0
    return tags


def install_video_blocks(sm):
    """让 4B/8B 也能读懂 H3 的「两帧一组」视频块。

    ComfyUI 只在 MiniMaxQwen3VL（32B 专用）上实现了这条路径。4B/8B 是普通的
    Qwen3VL，会把一对帧当成单张图处理 —— 网格和 token 数都不对，而且不报错。
    所以在这里把方法换掉，非视频块仍走原实现。
    """
    tr = getattr(sm, "transformer", None)
    if tr is None or getattr(tr, "_bzclipproj_video", False):
        return
    try:
        from comfy.text_encoders.minimax import process_video_block
    except Exception as e:
        logging.warning("[班长·投影] 视频块不可用：%s", e)
        return
    original = tr.preprocess_embed

    def preprocess_embed(embed, device):
        if embed.get("type") == "image" and embed.get("minimax_video_block", False):
            flatten, grid = process_video_block(embed["data"])
            merged, deepstack = tr.visual(flatten.to(device, dtype=torch.float32), grid)
            return merged, {"grid": grid, "deepstack": deepstack}
        return original(embed, device)

    tr.preprocess_embed = preprocess_embed
    tr._bzclipproj_video = True


def install_int8_vision_fix(sm):
    """int8 编码器带参考图时不至于崩在视觉塔上。

    comfy/ops.py 的 MixedPrecisionOps.forward_comfy_cast_weights 按权重的
    「声明格式」分支，而不是按 cast context 实际返回的东西：可换页路径上它
    返回的是已经反量化好的 bf16，代码却照样把它喂给 int8 反量化器，于是

        NoCapableBackendError: dequantize_int8_embedding:
        q: dtype torch.bfloat16 not in {torch.int8}

    只有视觉塔的 pos_embed 走这条路，而且只在有图的时候走 —— 纯文字 prompt
    永远看不到，所以这个坑埋了很久。

    不重写那个方法（上游一改就废），只是失败一次之后把 quant_format 清空再
    试：同一段代码会落到它自己的 F.embedding 分支，那里的反量化结果是对的。
    用个记忆位保证失败的尝试只付一次。
    """
    tr = getattr(sm, "transformer", None)
    vis = getattr(tr, "visual", None) if tr is not None else None
    pe = getattr(vis, "pos_embed", None) if vis is not None else None
    if pe is None or getattr(pe, "_bzclipproj_int8", False):
        return
    if getattr(pe, "quant_format", None) != "int8_tensorwise":
        return
    original = pe.forward_comfy_cast_weights
    etat = {"replie": False}

    def forward_comfy_cast_weights(input, out_dtype=None):
        if not etat["replie"]:
            try:
                return original(input, out_dtype=out_dtype)
            except Exception as e:
                etat["replie"] = True
                logging.info("[班长·投影] pos_embed 的 int8 在此加载路径上不可用"
                             "（%s），改走普通查表", e)
        fmt = pe.quant_format
        pe.quant_format = None
        try:
            return original(input, out_dtype=out_dtype)
        finally:
            pe.quant_format = fmt

    pe.forward_comfy_cast_weights = forward_comfy_cast_weights
    pe._bzclipproj_int8 = True
