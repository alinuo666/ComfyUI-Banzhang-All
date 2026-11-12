"""把小的文本编码器包装成大的那个：ProjectedCLIP。

移植自 ComfyUI-ClipProj 0.1.13（MIT，nicolab28）的 clipproj_nodes.py，
只取 ProjectedCLIP 本体，去掉多卡固定、内存模式选择、Generate/Caption。

原理：Qwen3-VL 的 4B/8B/32B 共用同一个分词器（151936 词），同一个 prompt 切出
的 token 位置一一对应，所以两个模型第 N 层的隐藏态之间存在一个可学的逐位置
线性映射。这里做的就是：截第 tap 层 → 减去均值除标准差 → 乘 W → 乘回标准差
加回均值 → 得到 DiT 要的 5120 维条件张量。

为什么用包装而不是改 ComfyUI：下游节点认的是官方 CLIP 对象的方法签名。
__getattr__ 把没重写的一律转发给原 CLIP，只接管 tokenize 和两条 encode，
于是它可以原封不动插进现有工作流的 clip 口。
"""

import logging
import weakref

import torch

import comfy.model_management as mm

from .banzhang_clipproj_patch import (install_int8_vision_fix,
                                      install_video_blocks, raw_tokenizer,
                                      submodel, tags_from_embeds_info)
from .banzhang_clipproj_proj import build_residual, load_projection

PAD_TOKEN = 151643
VISION_START = 151652
VISION_END = 151653

# 换投影矩阵时，旧实例的 GPU 缓存要能被提前清掉：一个 -mlp 文件的残差网络
# 在 fp32 下就是 576MB，新旧两份同时压在卡上的那一刻正好是加载新编码器最
# 吃紧的时候。弱引用是为了这张表自己不留住任何东西。
_PROJETES = []


class ProjectedCLIP:
    """小编码器冒充大编码器：外面套一层线性投影。"""

    def __init__(self, base, projection_name):
        self.__dict__["_base"] = base
        self.__dict__["_proj_name"] = projection_name
        self.__dict__["_proj"] = load_projection(projection_name)
        self.__dict__["_key"] = getattr(base.cond_stage_model, "clip", "qwen3vl_4b")
        # 投影的显存副本，只做一次。
        self.__dict__["_gpu"] = {}
        _PROJETES.append(weakref.ref(self))

    def __getattr__(self, name):
        """没重写的一律转发给原 CLIP。"""
        return getattr(self.__dict__["_base"], name)

    def __setattr__(self, name, value):
        if name in self.__dict__:
            self.__dict__[name] = value
        else:
            setattr(self.__dict__["_base"], name, value)

    def clone(self):
        """按原 CLIP 克隆整个包装。"""
        return ProjectedCLIP(self._base.clone(), self._proj_name)

    def tokenize(self, text, return_word_ids=False, images=[],
                 minimax_ref_items=None, **kwargs):
        """按 MiniMax H3 的方式切词：裸文本 + 插进去的画面块。

        Raises:
            ValueError: 用到了 ref2va 的参考素材时说明风险。
        """
        tok = raw_tokenizer(self._base)
        entries = []

        def add_text(s):
            entries.extend((t, 1.0) for t in tok(s, add_special_tokens=False)["input_ids"])

        def add_vision(data, video_block=False):
            entries.append((VISION_START, 1.0))
            embed = {"type": "image", "data": data, "original_type": "image"}
            if video_block:
                # preprocess_embed 读到这个标记就走 process_video_block，
                # 否则会当成单张图。
                embed["minimax_video_block"] = True
            entries.append((embed, 1.0))
            entries.append((VISION_END, 1.0))

        if minimax_ref_items:
            # ref2va：参考 token 在每一步采样都会被重读，投影误差是累积而不是
            # 只发生一次，所以这条路是实验性的。序号按类型各自从 1 开始，与
            # MiniMaxH3Tokenizer 一致，prompt 里的 <Picture i> 才对得上。
            counters = {"image": 0, "audio": 0, "video": 0}
            for item in minimax_ref_items:
                kind = item["type"]
                counters[kind] = counters.get(kind, 0) + 1
                if kind == "image":
                    add_text("<Picture %d>: " % counters["image"])
                    add_vision(item["data"])
                elif kind == "audio":
                    # 音频不进 Qwen，只进它的标签。
                    add_text("<Audio %d>: " % counters["audio"])
                else:
                    # 视频：H3 不把片段当一串图，而是两帧一对喂进视觉塔的时间
                    # patch，每对前面带这对中点的秒数。帧率按 2fps 算，奇数帧
                    # 补最后一帧凑整对。
                    frames = item["data"]
                    stamps = item.get("timestamps")
                    if stamps is None:
                        stamps = [i / 2.0 for i in range(frames.shape[0])]
                    stamps = list(stamps)
                    if frames.shape[0] % 2 == 1:
                        frames = torch.cat([frames, frames[-1:]], dim=0)
                        stamps.append(stamps[-1])
                    add_text("<Video %d>: " % counters["video"])
                    for k in range(0, frames.shape[0], 2):
                        add_text("<%.1f seconds>" % ((stamps[k] + stamps[k + 1]) / 2.0))
                        add_vision(frames[k:k + 2], video_block=True)
        else:
            for i, img in enumerate(images):
                add_text("<Picture %d>: " % (i + 1))
                add_vision(img)
        add_text(text)

        if len(entries) == 0:
            entries.append((PAD_TOKEN, 1.0))
        if return_word_ids:
            entries = [t + (0,) for t in entries]
        return {self._key: [entries]}

    def _encode(self, tokens):
        """读指定层的隐藏态，然后投影。

        Returns:
            tuple: (cond [B, seq, d_out], tags [seq])。
        """
        proj = self._proj
        base = self._base
        sm = submodel(base)
        install_video_blocks(sm)
        install_int8_vision_fix(sm)

        mm.load_models_gpu([base.patcher])
        device = base.patcher.load_device

        pairs = tokens[self._key] if isinstance(tokens, dict) else tokens
        pairs = [[(t[0], t[1]) for t in seq] for seq in pairs]

        tap = int(proj["tap"])

        # 标签取决于画面块落在第几个位置，只有 process_tokens 知道，所以拦
        # 一次 forward 把 embeds_info 截下来。
        captured = {}
        orig_forward = sm.transformer.forward

        def capturing_forward(*args, **kwargs):
            captured["embeds_info"] = kwargs.get("embeds_info", [])
            return orig_forward(*args, **kwargs)

        saved = (sm.layer, sm.layer_idx, sm.layer_norm_hidden_state, sm.execution_device)
        try:
            sm.transformer.forward = capturing_forward
            sm.layer = [tap] if tap >= 0 else "last"
            sm.layer_idx = None
            sm.layer_norm_hidden_state = False
            sm.execution_device = device
            with mm.cuda_device_context(device):
                with torch.no_grad():
                    out = sm.encode_token_weights(pairs)
        finally:
            sm.transformer.forward = orig_forward
            (sm.layer, sm.layer_idx, sm.layer_norm_hidden_state, sm.execution_device) = saved

        h = out[0]
        if h.dim() == 4:  # [B, n_taps, seq, d_in]：只要了一层
            h = h[:, 0]
        h = h.float()

        dev = h.device
        d_in = h.shape[-1]
        cache = self.__dict__["_gpu"]
        if cache.get("device") != dev:
            cache.clear()
            cache["device"] = dev
        if "p" not in cache:
            # 用 mean_in 而不是 W 判维度：不带线性路径的文件（-mlp 版）没有 W，
            # 而 mean_in 说的是同一件事。
            d_proj = proj["mean_in"].shape[0]
            if d_in != d_proj:
                taille = {2560: "4B", 4096: "8B", 5120: "32B"}
                raise ValueError(
                    "投影矩阵和编码器对不上：编码器是 %s（%d 维），矩阵要的是"
                    " %s（%d 维）。每个矩阵只配自己那个尺寸 —— 请换成 "
                    "mmh3-%s-ClipProj 文件，或者把编码器换成 %s。"
                    % (taille.get(d_in, "?"), d_in,
                       taille.get(d_proj, "?"), d_proj,
                       taille.get(d_in, "?").lower(),
                       taille.get(d_proj, "?")))
            cache["p"] = {k: proj[k].to(dev) for k in
                          ("W", "mean_in", "std_in", "mean_out", "std_out")
                          if k in proj}
            cache["mlp"] = build_residual(proj, dev)
        p = cache["p"]

        # 岭回归是在标准化空间里拟合的，残差网络也在这个空间里做修正，这样
        # 它修正的量级和被测对象一致。网络最后一层从零初始化训起，所以一个
        # 什么都没学到的网络会精确复现线性矩阵。
        xn = (h - p["mean_in"]) / p["std_in"]
        reseau = cache.get("mlp")
        # 没有 W 就完全靠网络：乘一个全零矩阵得到的仍是同样的结果，还要多
        # 付每 token 一次 2560x5120 的乘加和 26MB 显存。
        yn = xn @ p["W"] if "W" in p else None
        if reseau is not None:
            # 网络留在文件的精度里，只在两头转换。fp16 的残差就只占 fp16 的
            # 显存，而不是只有磁盘上省。
            td = reseau[0].weight.dtype
            sortie = reseau(xn.to(td)).float()
            yn = sortie if yn is None else yn + sortie
        elif yn is None:
            raise ValueError(
                "这个投影文件既没有线性矩阵也没有残差网络，产不出条件张量。"
                "文件是残的，请重新下载。")
        cond = yn * p["std_out"] + p["mean_out"]

        # 第 0 个 token 是注意力汇集点：方向恒定（1966 条 prompt 上余弦
        # 1.0000），不含任何文本信息，但它的范数能到 16500，而普通文本 token
        # 只有 291。校准时刻意剔掉了它 —— 不剔会毁掉统计量 —— 于是 W 从没
        # 见过这种量级，会把它投到一个范数巨大的随机方向。200 token 的
        # prompt 里它占 0.5%，看不出来；7 token 的 prompt 里它占 14%，足以
        # 毁掉画面。既然这个向量是恒定的，直接换成实测值就是精确解，不是近似。
        sink = proj.get("sink_out")
        if sink is not None and cond.shape[1] > 0:
            cond[:, 0] = sink.to(device=cond.device, dtype=cond.dtype)

        cond = cond.to(mm.intermediate_device())
        tags = tags_from_embeds_info(cond.shape[1], captured.get("embeds_info", []))
        return cond, tags

    def encode_from_tokens(self, tokens, return_pooled=False, return_dict=False):
        """对齐 comfy.sd.CLIP.encode_from_tokens 的签名。"""
        cond, tags = self._encode(tokens)
        if return_dict:
            out = {"cond": cond, "pooled_output": None, "minimax_token_tags": tags}
            self._base.add_hooks_to_dict(out)
            return out
        if return_pooled:
            return cond, None
        return cond

    def encode_from_tokens_scheduled(self, tokens, unprojected=False, add_dict={},
                                     show_pbar=True):
        """按 ComfyUI 的 [[tensor, dict]] 格式返回条件。

        分步调度在这里没有意义：投影是静态的，一次就出结果。
        """
        cond, tags = self._encode(tokens)
        extra = {"pooled_output": None, "minimax_token_tags": tags}
        extra.update(add_dict)
        self._base.add_hooks_to_dict(extra)
        return [[cond, extra]]

    def encode(self, text):
        """直接编码一段文字。"""
        return self.encode_from_tokens(self.tokenize(text))


def purge_projection_caches(device=None):
    """清掉所有投影实例的显存副本，返回腾出的 MB 数。

    换编码器 / 换矩阵前后调用一次，避免新旧两套投影在卡上相遇。
    """
    total = 0.0
    vivants = []
    for ref in _PROJETES:
        obj = ref()
        if obj is None:
            continue
        vivants.append(ref)
        cache = obj.__dict__.get("_gpu")
        if not cache:
            continue
        if device is not None and cache.get("device") != device:
            continue
        for cle in ("p", "mlp"):
            valeur = cache.get(cle)
            if valeur is None:
                continue
            tenseurs = (valeur.values() if isinstance(valeur, dict)
                        else (p for p in valeur.parameters()))
            total += sum(t.numel() * t.element_size() for t in tenseurs) / 2**20
        cache.clear()
    _PROJETES[:] = vivants
    if total:
        logging.info("[班长·投影] 已清空 %.0f MB 投影缓存（%s）", total, device)
    return total
