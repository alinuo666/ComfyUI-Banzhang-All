# -*- coding: utf-8 -*-
"""H3 漂移控制 —— 段交界无缝续接的动态前缀 mask。

为什么静态 mask 治不了硬跳
--------------------------
导演台承接钉帧把上一段尾部写进新段头部、挂静态 mask（头部 0 = 全程钉死）。
整个采样里 DiT 完全不参与头部那几步，它的内部去噪轨迹和头部内容是脱节的；
到 mask 从 0 变 1 的边界，轨迹突然接上 —— 观感就是「交界那一帧硬跳」。
即使在边界加 3 步静态羽化，mask 全程不变，DiT 在前几步照样不参与，治标不治本。

动态 mask 的做法
----------------
在 model 上挂一个 denoise_mask_function 回调，每一步去噪按当前 sigma 重算头部
mask。先记住 mask 的语义：denoise_mask=1 完全采用 DiT 输出（重新生成），
denoise_mask=0 完全保留 latent_image（钉住上一段）。

    noise_ratio = next_sigma / current_sigma
    头部 mask  = 前缀权重 × noise_ratio

去噪早期（高 sigma）next/current 大（你的 ManualSigmas 第一步 0.94），头部
mask 高 → DiT 输出主导，DiT 在头部真正「参与」生成，内部时间轨迹连续；
去噪后期 ratio 递减，mask 降低 → latent_image（上一段真实内容）逐步混入；
最后一步 ratio=0、mask=0 → 头部完全等于 latent_image，位对位钉住上一段。
边界不再是「DiT 全程没参与、突然接上」，轨迹连续且最终精确无缝，硬跳消失。

关键：只 clone model、只改本次采样的临时 mask，不碰存档的上一段 latent ——
档案与画面始终一致（避开了 latent 域平移补偿的过冲 / 不一致坑）。

思路参考公开的 H3 续接实践（Drift-Control AV），本文件为独立重写实现。
"""

import math

import torch

# 默认前缀长度（潜空间步，不是像素帧）：前 8 步硬权重、后 4 步渐隐。
DEFAULT_PREFIX_STEPS = 12
DEFAULT_MATCHED_STEPS = 8
DEFAULT_TAPER_STEPS = 4
# model 上的 wrapper 标识，自己的命名空间，避免和别的插件撞 key。
_WRAPPER_KEY = "banzhang_h3_drift_control"


def _schedule_values(sigmas):
    """把 sigma 调度归一化成「有限、非负、降序、去重」的纯数字元组。"""
    if torch.is_tensor(sigmas):
        raw = sigmas.detach().float().reshape(-1).cpu().tolist()
    else:
        raw = list(sigmas or ())
    out = []
    for value in raw:
        number = float(value)
        if math.isfinite(number) and number >= 0.0:
            out.append(number)
    return tuple(sorted(set(out), reverse=True))


def _next_sigma(current_sigma, sigmas):
    """调度表里严格小于当前 sigma 的下一个值；没有就返回 0。"""
    current = float(current_sigma)
    if not math.isfinite(current) or current <= 0.0:
        return 0.0
    tolerance = max(1e-7, abs(current) * 1e-6)
    for candidate in _schedule_values(sigmas):
        if candidate < current - tolerance:
            return candidate
    return 0.0


def _noise_ratio(current_sigma, sigmas):
    """当前步到下一步的噪声残留比例，钳在 [0,1]。"""
    current = float(current_sigma)
    if not math.isfinite(current) or current <= 0.0:
        return 0.0
    ratio = _next_sigma(current, sigmas) / current
    return max(0.0, min(1.0, ratio))


def _prefix_weights(prefix_steps, taper_steps):
    """前缀内部的时间权重：前面全 1.0，末尾 taper 步线性衰减到 0。

    例如 prefix=12、taper=4：前 8 步 1.0，后 4 步 0.75 / 0.5 / 0.25 / 0.0。
    """
    count = int(prefix_steps)
    taper = int(taper_steps)
    if count < 1:
        raise ValueError("前缀步数必须为正数")
    if taper < 1 or taper > count:
        raise ValueError("渐隐步数必须落在前缀区间内")
    weights = [1.0] * (count - taper)
    for offset in range(taper):
        weights.append(float(taper - offset - 1) / float(taper))
    return tuple(weights)


def _latent_streams(latent):
    """从 H3 latent 取出各条流（画面 + 声音），兼容 NestedTensor / 普通张量。"""
    samples = latent.get("samples") if isinstance(latent, dict) else None
    if hasattr(samples, "unbind"):
        return list(samples.unbind())
    if hasattr(samples, "tensors"):
        return list(samples.tensors)
    if isinstance(samples, (tuple, list)):
        return list(samples)
    if torch.is_tensor(samples):
        return [samples]
    return []


class _DriftState:
    """每步重算前缀 mask 的状态对象（挂在 clone 出来的 model 上）。"""

    def __init__(self, video_shape, audio_shape, sigmas, prefix_steps):
        self.video_shape = tuple(int(v) for v in video_shape)
        self.audio_shape = tuple(int(v) for v in audio_shape)
        self.sigmas = _schedule_values(sigmas)
        self.prefix_steps = int(prefix_steps)
        self.video_mask = None
        self.audio_mask = None

    def _recompute(self, sigma, packed_mask):
        shape = self.video_shape
        video_elements = math.prod(shape[1:])
        output = packed_mask.clone()

        # 取出画面段并还原成 5D，按当前噪声比例重写前缀。
        # 断开与 output 的内存别名：切片 reshape 可能仍是视图，留着别名会在写回时被判定源与目标重叠
        video = output[..., :video_elements].reshape(shape).clone()
        current = float(torch.as_tensor(sigma).detach().float().reshape(-1)[0])
        ratio = _noise_ratio(current, self.sigmas)
        taper = min(DEFAULT_TAPER_STEPS, self.prefix_steps)
        weights = torch.tensor(
            _prefix_weights(self.prefix_steps, taper),
            device=video.device,
            dtype=video.dtype,
        ) * ratio
        video[:, :, :self.prefix_steps] = weights.view(
            1, 1, self.prefix_steps, 1, 1
        )

        # 对齐 H3 的 token-mask 量化（ceil 到 1/256），让采样混合与模型内部
        # 每行的时间步标签描述同一个状态，避免两套 mask 口径不一致。
        h3_video = torch.ceil(video[:, :1].float() * 256.0) / 256.0

        # 把改好的画面段写回 packed，再拆出声音段。
        output[..., :video_elements] = video.reshape(
            output.shape[0], 1, video_elements
        )
        audio = output[..., video_elements:]
        if int(audio.numel()) != math.prod(self.audio_shape):
            raise ValueError("漂移控制：packed mask 与声音流形状对不上")
        h3_audio = audio.reshape(self.audio_shape)[:, :1].clone()

        self.video_mask = h3_video
        self.audio_mask = h3_audio
        return output

    def mask_function(self, sigma, denoise_mask, extra_options=None):
        if not self.sigmas:
            # 兜底：构造时没拿到调度，就从采样器透传的 extra_options 里补。
            self.sigmas = _schedule_values(
                (extra_options or {}).get("sigmas", ())
            )
        return self._recompute(sigma, denoise_mask)

    def apply_model_wrapper(self, executor, *args, **kwargs):
        # 把画面 / 声音 mask 分别塞进 model 调用，保证 H3 内部按行时间步与
        # 采样器的混合用的是同一份动态 mask。
        if self.video_mask is not None:
            kwargs["denoise_mask"] = self.video_mask
        if self.audio_mask is not None:
            kwargs["audio_denoise_mask"] = self.audio_mask
        return executor(*args, **kwargs)


def install_drift_control(model, latent, sigmas, prefix_steps):
    """clone 一个 H3 model 并装上动态前缀 mask 回调，返回 patched model。

    不动传入的 model 本体，也不改存档 latent；下游用返回的 model 采样即可。
    """
    if model is None or not callable(getattr(model, "clone", None)):
        raise ValueError("漂移控制需要一个 ComfyUI MODEL 输入")

    streams = _latent_streams(latent)
    if not streams or not torch.is_tensor(streams[0]) or streams[0].ndim != 5:
        raise ValueError("漂移控制需要 5D 的 H3 画面潜空间")
    if len(streams) < 2 or not torch.is_tensor(streams[1]):
        raise ValueError("漂移控制需要画面 + 声音两条 H3 流")

    prefix_steps = int(prefix_steps)
    total_t = int(streams[0].shape[2])
    if prefix_steps < 1 or prefix_steps >= total_t:
        raise ValueError(
            "前缀步数必须在 1 到画面时间维(%d)之间，且不能占满整段" % total_t
        )

    # 能拿到 model_type 就校验一下；拿不到（包装节点）就靠 latent 结构兜底。
    inner = getattr(model, "model", None)
    type_name = str(getattr(getattr(inner, "model_type", None), "name", ""))
    if type_name and type_name != "FLOW_AV":
        raise ValueError("漂移控制只适用于 MiniMax H3 音视频(FLOW_AV)模型")

    patched = model.clone()
    options = getattr(patched, "model_options", None)
    if not isinstance(options, dict):
        raise ValueError("接入的 MODEL 没有 model_options 字典")
    if callable(options.get("denoise_mask_function")):
        raise ValueError("漂移控制不能和另一个动态 mask 补丁叠加使用")
    if not callable(getattr(patched, "set_model_denoise_mask_function", None)):
        raise RuntimeError("当前 ComfyUI 不支持动态 denoise mask（set_model_denoise_mask_function）")
    if not callable(getattr(patched, "add_wrapper_with_key", None)):
        raise RuntimeError("当前 ComfyUI 不支持 apply-model wrapper（add_wrapper_with_key）")

    from comfy.patcher_extension import WrappersMP

    state = _DriftState(
        tuple(streams[0].shape), tuple(streams[1].shape),
        sigmas, prefix_steps
    )
    patched.set_model_denoise_mask_function(state.mask_function)
    patched.add_wrapper_with_key(
        WrappersMP.APPLY_MODEL, _WRAPPER_KEY, state.apply_model_wrapper
    )
    patched.model_options[_WRAPPER_KEY] = state
    return patched


class BanZhangH3DriftControl:
    """🎬 H3 漂移控制：串在 KSampler 的 model 线上，根治段交界硬跳。

    输入已经挂好静态承接 mask 的潜空间（来自导演台），输出装好动态 mask 的
    model；采样器用这个 model 跑，前缀 mask 会随去噪 sigma 每步重算。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "latent": ("LATENT",),
                "sigmas": ("SIGMAS",),
                "prefix_steps": ("INT", {
                    "default": 7,
                    "min": 1,
                    "max": 256,
                    "step": 1,
                    "label": "前缀步数",
                    "tooltip": "动态前缀覆盖的潜空间步（不是像素帧）。正常提交时会自动按"
                               "导演台承接头的帧账校正，手填值只作兜底：5帧→2步，22帧→"
                               "7步，39帧→12步，56帧→17步。想强制用手填值请设 "
                               "BZ_DRIFT_MANUAL=1。",
                }),
            },
            # 只用于从本次 prompt 读出 Ticket 的承接头帧数，不渲染控件、不改连线。
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = "H3 漂移控制：随去噪 sigma 动态调整前缀 mask，前缀步数自动跟帧账走。"

    def apply(self, model, latent, sigmas, prefix_steps,
              prompt=None, unique_id=None):
        """prefix_steps 从 Ticket 的 trim_head 派生，杜绝「手填 7 / 实际承接 39 帧」。"""
        import os as _os
        steps = int(prefix_steps)
        if _os.environ.get("BZ_DRIFT_MANUAL", "").strip() != "1":
            try:
                try:
                    from .csglide_ticket import ticket_from_prompt
                    from . import csglide_ledger as ledger
                except ImportError:
                    from csglide_ticket import ticket_from_prompt
                    import csglide_ledger as ledger
                ticket = ticket_from_prompt(prompt, unique_id)
                derived = ledger.drift_prefix_steps(ticket.trim_head)
                if derived <= 0:
                    # 首段没有承接头：动态前缀 mask 会作用在空前缀上，直接透传。
                    print("[v2 漂移控制] 首段无承接头（trim_head=0）—— "
                          "直接透传 model，不挂动态 mask。")
                    return (model,)
                if derived != steps:
                    print("[v2 漂移控制] ⚠ 前缀步数按帧账自动校正：手填 %d → %d "
                          "（承接头 %d 帧；5→2 / 22→7 / 39→12 / 56→17）。"
                          "想保留手填值请设 BZ_DRIFT_MANUAL=1。"
                          % (steps, derived, ticket.trim_head))
                steps = derived
            except Exception as exc:
                # 裸提交 / 中枢注入 / hidden 未注入时不能拦出片，退回面板值。
                print("[v2 漂移控制] 拿不到 Ticket，沿用面板前缀步数 %d（%s）。"
                      % (steps, exc))
        patched = install_drift_control(model, latent, sigmas, steps)
        return (patched,)


NODE_CLASS_MAPPINGS = {
    "BanZhangH3DriftControl": BanZhangH3DriftControl,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhangH3DriftControl": "🎬 H3 漂移控制 (Drift Control)",
}
