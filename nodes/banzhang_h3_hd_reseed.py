# -*- coding: utf-8 -*-
"""
🎬 H3 高清重采预置 (BanZhang_H3_HDReseed)
================================================================================
二采前处理：像素放大 → 视频VAE编码 → 音频VAE编码 → AV潜空间拼接，
输出整条 AV 潜空间给 KSampler 做 img2img。

采样条件不走 CLIP 参考条件，直接复用一采的正面条件（导演台）——
砍掉 15GB Qwen 文本编码器装填与参考块编码整段开销。
潜空间初值就是结构锚，去噪强度在采样器上（0.3 抛光 ↔ 0.7+ 趋向重画）。

宽/高/帧数在内部统一计算，潜空间自身天然一致；帧数必须落在 H3 的
17k+5 网格上，不符会被向下裁齐并警告（帧账请在上游保证）。
"""

import math
import time

import torch
import torch.nn.functional as F

# comfy-core MiniMax H3 的画布约束（与 comfy_extras/nodes_minimax_h3.py 保持一致）
CANVAS_MULTIPLE = 32
MAX_PIXELS = 768 * 1344
BASE_FPS = 24
AUDIO_LATENT_FPS = 40


def _align_frame_count(n):
    """H3 潜空间时间块网格：帧数必须满足 17k + 5。向下裁，不动帧账往上凑。"""
    while n % 17 != 5:
        n -= 1
    return n


def _snap(v):
    return max(CANVAS_MULTIPLE, round(v / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)


def _video_latent_t(frame_count):
    # comfy-core video_latent_t 同式：潜空间时间 token 数
    return 2 if frame_count <= 5 else ((frame_count - 5) // 17) * 5 + 2


def _core_node(name, 用途):
    from nodes import NODE_CLASS_MAPPINGS
    cls = NODE_CLASS_MAPPINGS.get(name)
    if cls is None:
        raise ValueError(
            f"🎬 H3 高清重采预置：找不到 comfy-core 节点「{name}」（{用途}）。"
            "请确认 ComfyUI 版本自带 MiniMax H3 支持。"
        )
    return cls


def _unwrap(node_output):
    r = getattr(node_output, "result", None)
    if r is None:
        r = node_output
    if isinstance(r, (tuple, list)):
        r = r[0]
    return r


class BanZhang_H3_HDReseed:
    """一采帧图 → 放大+编码+音视频拼接 → 潜空间，直喂 KSampler 做 img2img"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "帧图": ("IMAGE",),
                "音频": ("AUDIO",),
                "视频VAE": ("VAE",),
                "音频VAE": ("VAE",),
                "放大倍数": ("FLOAT", {
                    "default": 1.5, "min": 1.0, "max": 4.0, "step": 0.1,
                    "tooltip": "像素放大倍数，画布自动对齐32并压回H3训练面积上限",
                }),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("潜空间",)
    FUNCTION = "reseed"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def reseed(self, 帧图, 音频, 视频VAE, 音频VAE, 放大倍数):
        frames = 帧图[..., :3]
        n = int(frames.shape[0])
        if n < 5:
            raise ValueError(
                f"🎬 H3 高清重采预置：帧图只有 {n} 帧，H3 最短为 5 帧，请检查一采时长。"
            )
        m = _align_frame_count(n)
        if m != n:
            print(f"⚠️ [H3 高清重采预置] 帧数 {n} 不在 17k+5 网格，裁到 {m} 帧"
                  f"（丢弃 {n - m} 帧）。请检查导演台时长设置。")
            frames = frames[:m]

        # 像素放大（最近邻），画布对齐 32、压回训练面积上限
        h, w = int(frames.shape[1]), int(frames.shape[2])
        tw, th = _snap(w * 放大倍数), _snap(h * 放大倍数)
        if tw * th > MAX_PIXELS:
            s = math.sqrt(MAX_PIXELS / (tw * th))
            tw, th = _snap(tw * s), _snap(th * s)
            print(f"⚠️ [H3 高清重采预置] 目标画布超出 H3 训练面积上限，已压回 {tw}x{th}。")
        if (tw, th) != (w, h):
            frames = F.interpolate(
                frames.movedim(-1, 1), size=(th, tw), mode="nearest-exact"
            ).movedim(1, -1)
        print(f"🎬 [H3 高清重采预置] 画布 {w}x{h} -> {tw}x{th}，{m} 帧")

        with torch.no_grad():
            # 视频潜空间：与 comfy-core 内部同款，vae.encode 直编帧序列
            t = time.perf_counter()
            vz = 视频VAE.encode(frames)
            print(f"🎬 [H3 高清重采预置] 视频编码 {m} 帧：{time.perf_counter() - t:.1f}s")
            t_expect = _video_latent_t(m)
            if not (isinstance(vz, torch.Tensor) and vz.ndim == 5 and vz.shape[2] == t_expect):
                raise ValueError(
                    f"🎬 H3 高清重采预置：视频潜空间形状 {tuple(vz.shape)} 与预期"
                    f"时间长度 {t_expect} 不符，视频VAE可能与当前 ComfyUI 的 H3 不匹配。"
                )

            # 音频潜空间：重用 comfy-core VAEEncodeAudio（含重采样）
            try:
                AudioEnc = _core_node("VAEEncodeAudio", "音频编码")
                t = time.perf_counter()
                az = _unwrap(AudioEnc.execute(vae=音频VAE, audio=音频))["samples"]
                print(f"🎬 [H3 高清重采预置] 音频编码：{time.perf_counter() - t:.1f}s")
            except Exception as e:
                raise ValueError(f"🎬 H3 高清重采预置：音频编码失败 —— {e}")

            # 音频流时间轴独立于视频流（40 latent帧/秒），按公式校验，不与视频流混对
            at_expect = round(m / BASE_FPS * AUDIO_LATENT_FPS)
            ta = int(az.shape[-1])
            if ta > at_expect:
                az = az[..., :at_expect]
            elif ta < at_expect:
                az = torch.cat(
                    [az, torch.zeros_like(az[..., :1]).expand(*az.shape[:-1], at_expect - ta)],
                    dim=-1,
                )
                print(f"⚠️ [H3 高清重采预置] 音频比视频短 {at_expect - ta} 个音频latent帧，尾部补静音。")

            # AV 拼接：重用 comfy-core ConcatAVLatent（音视频流各自时间轴直接打包）
            try:
                Concat = _core_node("LTXVConcatAVLatent", "音视频潜空间拼接")
                t = time.perf_counter()
                latent = _unwrap(Concat.execute(
                    video_latent={"samples": vz}, audio_latent={"samples": az},
                ))
                print(f"🎬 [H3 高清重采预置] AV拼接：{time.perf_counter() - t:.1f}s")
            except Exception as e:
                raise ValueError(f"🎬 H3 高清重采预置：音视频潜空间拼接失败 —— {e}")

        return (latent,)


NODE_CLASS_MAPPINGS = {
    "BanZhang_H3_HDReseed": BanZhang_H3_HDReseed,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_H3_HDReseed": "🎬 H3 高清重采预置",
}
