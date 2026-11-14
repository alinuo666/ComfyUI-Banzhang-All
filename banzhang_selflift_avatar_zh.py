# -*- coding: utf-8 -*-
"""selflift-Avatar 采样器的班长化接口层（中文端口 + 内置采样参数）。

做三件事：
  1. 端口和参数全部改成中文，采样器内置到节点里（和官方 K 采样器一样），
     「自定义日程」接了就用它，没接就按节点内部的 步数 / 降噪强度 / 调度器 算。
  2. 图片版升级为「多级渐进」：「分段步数 / 级间倍率」像 H3 多级渐进一样填，
     采样循环走 banzhang_selflift_image_multistage 引擎（高级参数内置为论文默认值）。
  3. 统一归类到「👨‍🏫班长/MiniMax H3」。

只包装不改上游：_selflift_avatar/ 内部代码一行不动，上游升级直接覆盖该目录即可。
"""

import torch

import comfy.model_management
import comfy.samplers

from ._selflift_avatar import nodes as _sl
from .nodes.banzhang_selflift import _parse_num_list
from . import banzhang_selflift_image_multistage as _image_ms

_SL_CATEGORY = "👨‍🏫班长/MiniMax H3"

_SL_NAMES = {
    "SelfLiftAvatarH3Sampler": "🎯 H3 渐进采样器 (SelfLift-Avatar)",
    "SelfLiftAvatarImageSampler": "🖼️ 图片多级渐进 (SelfLift-Avatar)",
}

_SL_DESC = {
    "SelfLiftAvatarH3Sampler":
        "把「小尺寸先采 → 放大 → 大尺寸采完」压缩进一次采样，总步数一步不多。\n"
        "采样器、步数、调度器都在节点里，不用外接；想用自定义日程就接「自定义日程」口，接了就优先用它。\n"
        "没有负面条件端口：本节点按「只有正面」的方式运行（等价于 CFG=1），少跑一遍模型，速度更快。\n"
        "特色：支持音视频双遮罩——音频遮罩填 0 表示保留原声，填 1 表示重新生成声音。",
    "SelfLiftAvatarImageSampler":
        "图片模型版多级渐进：填「分段步数」（如 6,6,6）和「级间倍率」（如 2 或留空自动），\n"
        "一次采样里逐级换大纸，总步数一步不多。控制台会打印完整阶梯（各级尺寸 + 步数），可随时核对。\n"
        "能用：整流流（flow matching）模型，如 SD3 / FLUX / Qwen-Image / Z-Image-Turbo / Lumina。\n"
        "不能用：SD1.5 / SD2 / SDXL 这类老模型（会直接报「需要整流流模型」），也不接视频模型的 5D 潜空间。\n"
        "高级参数已内置论文默认值（修正强度 0.5~1.0），\n"
        "只留「像素锚点修正比例」和「潜空间放大方式」两个精修旋钮：发糊先试放大方式切 bilinear、\n"
        "再试锚点比例往上加。每多一级多一次 VAE 往返，级数别贪多。",
}

_SCHEDULERS = list(comfy.samplers.SCHEDULER_NAMES)
_DEFAULT_SCHEDULER = "normal" if "normal" in _SCHEDULERS else _SCHEDULERS[0]

_SCHEDULER_TIP = (
    "噪声日程的形状，和官方 K 采样器里那个是同一个。\n"
    "normal 通用；simple / beta 在流模型上常见；karras 前密后疏，低步数更稳；"
    "sgm_uniform 对齐 SGM 系模型；exponential 衰减更陡。"
)

_SAMPLER_TIP = "SelfLift 只支持标准 euler（s_churn=0），换分辨率那一步要复用它的预测，所以这里没有别的选择。"

_MODEL_TIP = "主干模型。低分辨率前段跑它；不接「高清阶段模型」时，高清后段也是它。"


def _upscaler_input():
    """复用上游的放大模型清单，只把说明换成中文。"""
    choices, opts = _sl._upscaler_input()
    opts = dict(opts)
    opts["tooltip"] = (
        "外部 H3 latent 放大模型，放在 models/latent_upscale_models 目录。\n"
        "选 none 就是最近邻直接放大，必须配合「像素锚点修正比例」大于 0 使用；两个都关会直接报错。\n"
        "默认自动选中第一个检测到的 H3 模型。"
    )
    return (choices, opts)


def _resolve_sigmas(模型, 步数, 降噪强度, 调度器, 自定义日程):
    """接了自定义日程就优先用它；没接就按节点内部参数算（与官方 K 采样器同一套逻辑）。

    日程必须待在 intermediate_device 上：上游换分辨率那一步会直接拿 sigma 去和
    潜空间做算术，两边设备不一致就会报 "found at least two devices"。
    """
    device = comfy.model_management.intermediate_device()
    if 自定义日程 is not None:
        return 自定义日程.to(device)
    scheduler = 调度器 if 调度器 in _SCHEDULERS else _DEFAULT_SCHEDULER
    helper = comfy.samplers.KSampler(
        模型, 步数, device, sampler="euler", scheduler=scheduler, denoise=降噪强度,
    )
    return helper.sigmas


def _check_transition(低分辨率步数, sigmas):
    """日程太短时给中文提示，不用去猜上游那段英文报错。"""
    count = sigmas.numel() if torch.is_tensor(sigmas) else 0
    if count < 3:
        raise ValueError(
            f"日程太短：当前只有 {max(count - 1, 0)} 步，「低分辨率步数」放不下。把「步数」调大再试。"
        )
    if not 1 <= 低分辨率步数 <= count - 2:
        raise ValueError(
            f"「低分辨率步数」必须在 1 ~ {count - 2} 之间（总步数 {count - 1}）。"
        )


class BZ_SelfLiftAvatarH3Sampler(_sl.SelfLiftAvatarH3Sampler):
    """H3 版：端口中文，采样器 / 步数 / 降噪 / 调度器内置。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": _MODEL_TIP}),
                "正面条件": ("CONDITIONING", {"tooltip":
                    "提示词编码后的条件。本节点没有负面端口，按「只有正面」运行（等价于 CFG=1）。"}),
                "视频VAE": ("VAE", {"tooltip":
                    "换分辨率那一刻的像素基准。只有「像素锚点修正比例」大于 0 才会走解码-重编码这条路；"
                    "等于 0 时它基本不参与计算，但端口仍然要接上。"}),
                "目标潜空间": ("LATENT", {"tooltip":
                    "决定最终分辨率和时长的 H3 音视频潜空间。\n"
                    "也可以接遮罩：0 = 保留原有内容，1 = 重新生成，0~1 之间是软约束。\n"
                    "开 spatial 分块只允许「视频全 1 + 音频全 0」；global 系模式保留完整遮罩，局部/软遮罩都能用。"}),
                "随机种子": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                  "control_after_generate": True, "tooltip": "换个种子换一张图。"}),
                "步数": ("INT", {"default": 8, "min": 1, "max": 10000, "tooltip":
                    "总采样步数。不接「自定义日程」时按它生成日程；接了就以自定义日程为准，这里只作参考。"}),
                "降噪强度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip":
                    "1.0 = 从纯噪声开始完整生成；小于 1.0 = 在已有潜空间上改图（图生图 / 续写）。"
                    "接了「自定义日程」时不起作用。"}),
                "调度器": (_SCHEDULERS, {"default": _DEFAULT_SCHEDULER, "tooltip": _SCHEDULER_TIP}),
                "采样器": (["euler"], {"default": "euler", "tooltip": _SAMPLER_TIP}),
                "低分辨率步数": ("INT", {"default": 6, "min": 1, "max": 10000, "tooltip":
                    "前段在小尺寸上跑几步。论文图片模型是 8 步里跑 6 步；H3 没有官方推荐值，需要自己试。"
                    "必须小于总步数。"}),
                "低分辨率倍率": ("FLOAT", {"default": 0.5, "min": 0.25, "max": 1.0, "step": 0.05, "tooltip":
                    "前段用多大的尺寸跑。0.5 = 长宽各一半。越小越快越省显存，但打底越粗、"
                    "高清阶段要补的东西越多。"}),
                "像素锚点修正比例": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip":
                    "把最容易出错的位置拉回 VAE 像素基准的强度。\n"
                    "0 = 完全不走 VAE，只靠外部 latent 放大模型（H3 默认，最快）；\n"
                    "放大模型选 none、走纯 SelfLift 路线时，从 0.6 附近开始试。"}),
                "修正强度下限": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip":
                    "修正力度的最低值。论文图片模型用 0.5；H3 的最近邻抬升误差偏大，可能需要拉到 1.0。"}),
                "修正强度上限": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip":
                    "修正力度的最高值。做纯 SelfLift 对照时保持 1.0。"}),
                "潜空间放大模型": _upscaler_input(),
            },
            "optional": {
                "sigmas": ("SIGMAS", {"tooltip":
                    "接了就优先用它，节点里的「步数 / 降噪强度 / 调度器」全部忽略。"
                    "不接就按节点内部参数自动生成。"}),
                "高清阶段模型": ("MODEL", {"tooltip":
                    "可选。高清后段换用另一个模型（比如不同底模或 LoRA 组合），架构和 latent 格式必须一致。"
                    "低分辨率前段始终用「模型」。"}),
                "高分辨率分块": ("BOOLEAN", {"default": False, "label_on": "开启", "label_off": "关闭", "tooltip":
                    "高清阶段省显存总开关。关闭 = 整帧一次算完。\n"
                    "开 spatial：把高清画面切成几块分别算，每块都拿到完整音频；带遮罩只允许「视频全 1 + 音频全 0」。\n"
                    "开 global 系：不切空间，保留完整上下文分批算，遮罩不限。"}),
                "省显存模式": (["spatial", "global_stream", "global", "global_ram"],
                            {"default": "spatial", "tooltip":
                    "高清阶段省显存的策略（只影响高清后段，低清前段始终整帧）：\n"
                    "spatial：空间裁切，最快最省，但背景可能膨胀/位移/出现接缝（老行为）；\n"
                    "global_stream：保留完整上下文分批计算，推荐，需要 native SLA/sol-attn；\n"
                    "global：完整上下文兼容路径，不需要原生稀疏，但更吃显存；\n"
                    "global_ram：完整上下文 + 主机内存暂存，最省 GPU 但最慢。"}),
                "token分块大小": ("INT", {"default": 4096, "min": 128, "max": 16384, "step": 128, "tooltip":
                    "仅 global 系模式有效：投影/前馈网络每批处理多少 token。\n"
                    "调小通常省中间激活显存但增加开销；调大更快但更吃显存。\n"
                    "它不是空间块，也不是注意力窗口。"}),
                "权重缓存预算": ("FLOAT", {"default": 4.0, "min": 0.0, "max": 64.0, "step": 0.5, "tooltip":
                    "仅 global_stream 有效：权重缓存预算（GiB）。\n"
                    "调小给工作区留更多空间但可能增加权重换入换出；0 = 保留自动策略，不是关闭缓存。"}),
                "分块模式": (["auto", "manual"], {"default": "auto", "tooltip":
                    "仅 spatial 模式有效。\n"
                    "自动：按显存估算在 1~8 块里挑一个能放下的；\n"
                    "手动：严格按下面选的块数来，显存不够只会警告，不会偷偷加块，也不会自动重试。"}),
                "手动块数": ([2, 4, 6, 8], {"default": 2, "tooltip":
                    "仅 spatial + 手动模式有效，可选 2 / 4 / 6 / 8。空间尺寸太小时实际块数会自动减少。\n"
                    "想要整图处理，直接把「高分辨率分块」关掉，不要在这里找 1。"}),
                "分块方向": (["auto", "width", "height"], {"default": "auto", "tooltip":
                    "仅 spatial 模式有效。\n"
                    "自动：沿较长的一边切；宽度：左右切成竖条；高度：上下切成横条。音频和时间维度永远不切。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_NAMES = ("潜空间",)

    def sample(self, 模型, 正面条件, 视频VAE, 目标潜空间, 随机种子, 步数, 降噪强度, 调度器, 采样器,
               低分辨率步数, 低分辨率倍率, 像素锚点修正比例, 修正强度下限, 修正强度上限,
               潜空间放大模型, sigmas=None, 高清阶段模型=None, 高分辨率分块=False,
               分块模式="auto", 手动块数=2, 分块方向="auto", 省显存模式="spatial",
               token分块大小=4096, 权重缓存预算=4.0, unique_id=None):
        sigmas = _resolve_sigmas(模型, 步数, 降噪强度, 调度器, sigmas)
        _check_transition(低分辨率步数, sigmas)
        return super().sample(
            # 没有负面条件：正反面同传一份、cfg=1，走官方的 cfg1 快路径——只跑一遍模型，
            # 结果与「有负面但两个条件相同」完全一致（cond - uncond = 0）。
            low_res_model=模型, positive=正面条件, negative=正面条件, vae=视频VAE, latent_image=目标潜空间,
            sampler=comfy.samplers.sampler_object(采样器), sigmas=sigmas, seed=随机种子, cfg=1.0,
            transition_step=低分辨率步数, lowres_scale=低分辨率倍率, rho=像素锚点修正比例,
            w_min=修正强度下限, w_max=修正强度上限, upscaler_model=潜空间放大模型,
            high_res_model=高清阶段模型, highres_tiling=高分辨率分块, tiling_mode=分块模式,
            tiling_tiles=手动块数, tiling_axis=分块方向,
            highres_tiling_mode=省显存模式, highres_token_chunk=token分块大小,
            highres_weight_cache_gb=权重缓存预算, unique_id=unique_id,
        )


class BZ_SelfLiftAvatarImageSampler(_sl.SelfLiftAvatarImageSampler):
    """图片版多级渐进：「分段步数 / 级间倍率」填法，高级参数内置为论文默认值。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": _MODEL_TIP}),
                "正面条件": ("CONDITIONING", {"tooltip": "正向提示词编码后的条件。"}),
                "负面条件": ("CONDITIONING", {"tooltip": "负向提示词编码后的条件。"}),
                "VAE": ("VAE", {"tooltip":
                    "每级换分辨率时的像素基准（解码 → 放大 → 重编码锚点）。\n"
                    "「像素锚点修正比例」大于 0 时才会真正参与计算。"}),
                "目标潜空间": ("LATENT", {"tooltip":
                    "决定最终尺寸的图片潜空间。也可以接遮罩：0 = 保留原有内容，1 = 重新生成。\n"
                    "Qwen-Image 这类 64 通道模型，请接官方编码节点自己输出的 latent，不要用普通的空 Latent。"}),
                "随机种子": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                  "control_after_generate": True, "tooltip": "换个种子换一张图。"}),
                "分段步数": ("STRING", {"default": "6,14", "multiline": False, "tooltip":
                    "填逗号分隔的步数，填几个数就是分几级（和 H3 多级渐进同款填法）。\n"
                    "例：6,14 → 两级 = 6 步小图打底 + 14 步大图收尾；6,6,8 → 三级阶梯。\n"
                    "合计就是总步数。低清步数只建议占总步数的 30%~40%（例：40 步 → 12,28），\n"
                    "低清步数太多、高清太少会糊 —— 大图阶段才是出细节的地方。"}),
                "级间倍率": ("STRING", {"default": "", "multiline": False, "tooltip":
                    "每级放大的倍率，必须大于 1。留空 = 自动每级长宽各翻倍（论文口径 0.5 起步）。\n"
                    "填一个值 = 各级同倍率（例 2）；也可逐级给，个数 = 级数 - 1（例 2,1.5）。"}),
                "降噪强度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip":
                    "1.0 = 从纯噪声开始完整生成；小于 1.0 = 在已有潜空间上改图（图生图 / 局部重绘）。\n"
                    "接了「sigmas」时不起作用。"}),
                "调度器": (_SCHEDULERS, {"default": _DEFAULT_SCHEDULER, "tooltip": _SCHEDULER_TIP}),
                "引导系数": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01,
                                    "tooltip": "提示词跟随强度。整流流图片模型常用 1.0。"}),
                "像素锚点修正比例": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip":
                    "每次换大纸时，把最容易出错的位置拉回 VAE 像素基准的强度。论文：FLUX.2-Klein 用 0.4，"
                    "Z-Image-Turbo 用 0.3。0 = 不修正；画面发糊就往上加，出怪色块可试调低。"}),
                "潜空间放大方式": (["nearest", "bilinear"], {"default": "nearest", "tooltip":
                    "换纸时 latent 的插值方式。论文默认 nearest；Qwen-Image 这类 64 通道模型\n"
                    "建议试 bilinear —— 画面发糊或有块状感时先切这个。"}),
            },
            "optional": {
                "sigmas": ("SIGMAS", {"tooltip":
                    "接了就优先用它（步数必须与「分段步数」合计一致，否则报错并给出建议值），"
                    "「降噪强度 / 调度器」忽略。不接就自动生成。"}),
                "高清阶段模型": ("MODEL", {"tooltip":
                    "可选。最后一级（满分辨率收尾）换用另一个模型（比如不同底模或 LoRA 组合），"
                    "架构和 latent 格式必须一致。前面各级始终用「模型」。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_NAMES = ("潜空间",)

    def sample(self, 模型, 正面条件, 负面条件, VAE, 目标潜空间, 随机种子,
               分段步数, 级间倍率, 降噪强度, 调度器, 引导系数, 像素锚点修正比例,
               潜空间放大方式, sigmas=None, 高清阶段模型=None, unique_id=None):
        segs = _parse_num_list(分段步数, int, "分段步数", "🖼️ 图片多级渐进")
        ratios = _parse_num_list(级间倍率, float, "级间倍率", "🖼️ 图片多级渐进") or None
        sigmas = _resolve_sigmas(模型, sum(segs), 降噪强度, 调度器, sigmas)
        return (_image_ms.progressive_sample_multistage(
            model=模型, positive=正面条件, negative=负面条件, vae=VAE, latent_image=目标潜空间,
            sampler=comfy.samplers.sampler_object("euler"), sigmas=sigmas, seed=随机种子,
            cfg=引导系数, segments=segs, ratios=ratios, rho=像素锚点修正比例,
            latent_upsample=潜空间放大方式, model_hires=高清阶段模型),)


def apply_zh(cls_map, name_map):
    """把上游两个采样器换成班长化版本；单个节点失败只跳过，不拖垮整包加载。"""
    replacements = {
        "SelfLiftAvatarH3Sampler": BZ_SelfLiftAvatarH3Sampler,
        "SelfLiftAvatarImageSampler": BZ_SelfLiftAvatarImageSampler,
    }
    for node_id, cls in replacements.items():
        try:
            cls.CATEGORY = _SL_CATEGORY
            cls.DESCRIPTION = _SL_DESC[node_id]
            cls_map[node_id] = cls
            name_map[node_id] = _SL_NAMES[node_id]
        except Exception as e:
            print(f"⚠️ [班长全家桶] SelfLift-Avatar 节点 {node_id} 班长化跳过: {e}")
