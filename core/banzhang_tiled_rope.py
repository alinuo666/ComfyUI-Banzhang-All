# -*- coding: utf-8 -*-
"""分块采样时给模型「补坐标」的钩子 + 参考图按块切分。

为什么需要它
------------
分块采样把整幅切成瓦片逐块跑，模型每一块都会以为自己是整幅图的正中间 ——
Qwen-Image 2.1 的位置编码（build_sequence 里的 hh / ww）是以 0 为中心的，
于是相邻两块拿到同一段坐标，出来就是接缝和「每块都长出一个完整主体」。

修法
----
块采样期间临时接管 pe_embedder：把当前块的坐标平移到它在整幅里的真实位置。
只在 pe_embedder 这一层动手，不复制官方任何逻辑；装不上就自动降级（打日志、
继续按老样子跑），绝不因为补丁失败让整条流程崩掉。

兼容性（重要）
--------------
依赖 comfy/ldm/qwen_image21 的两条事实：
  1. 坐标由 `pe = self.pe_embedder(cat(ids))` 统一编码；
  2. ids 里 target（被采样的那块）排在序列**最后**，前面是文本与参考图。
ComfyUI 换了实现就自动识别不到、降级处理，不会崩。

参考图按块切
------------
编辑类模型把参考图整张塞进条件，每块都看全图，是重复主体的第二个来源。
按当前块在整幅里的**位置比例**去切参考图（参考图与目标尺寸不一致也能切，
比「只有尺寸完全相等才切」的通行做法适用范围更广）。切不了就整张照用。
"""

import logging

import torch

_TAG = "🖼️ 分块坐标对齐"


def _ceil_half(n):
    """ceil(n/2)：Qwen-Image 2.1 以 0 为中心编码坐标时的半幅。"""
    return (int(n) + 1) // 2


def install(模型):
    """给 Qwen-Image 2.1 的 pe_embedder 装上坐标平移钩子。

    返回 (set_tile, uninstall)；模型不是 Qwen-Image 2.1 或已装过则返回 None。
    调用方必须在采样结束后执行 uninstall，否则钩子会一直挂在模型上。
    """
    dm = 模型.get_model_object("diffusion_model")
    module = type(dm).__module__ if dm is not None else "无"
    if dm is None or not module.startswith("comfy.ldm.qwen_image21"):
        logging.info("[%s] 模型不是 Qwen-Image 2.1（%s），坐标对齐跳过", _TAG, module)
        return None
    embedder = getattr(dm, "pe_embedder", None)
    if embedder is None or getattr(dm, "_bzq_rope_hooked", False):
        logging.info("[%s] 未找到 pe_embedder 或已挂过钩子，坐标对齐跳过", _TAG)
        return None

    orig_forward = embedder.forward

    def patched(ids):
        """把当前块的 h/w 坐标平移到全图画布上的真实位置。"""
        state = getattr(dm, "_bzq_tile_state", None)
        if state is None or ids.ndim != 3 or ids.shape[-1] < 3:
            return orig_forward(ids)
        n = int(state["n"])
        sh, sw = float(state["shift_h"]), float(state["shift_w"])
        if n <= 0 or ids.shape[1] < n or (sh == 0.0 and sw == 0.0):
            return orig_forward(ids)
        shifted = ids.clone()
        shifted[:, -n:, 1] += sh
        shifted[:, -n:, 2] += sw
        return orig_forward(shifted)

    def set_tile(n, shift_h, shift_w):
        """登记当前块：target token 数与相对全图的坐标平移量。"""
        dm._bzq_tile_state = {"n": int(n),
                              "shift_h": float(shift_h),
                              "shift_w": float(shift_w)}

    def uninstall():
        embedder.forward = orig_forward
        dm._bzq_rope_hooked = False
        dm._bzq_tile_state = None

    embedder.forward = patched
    dm._bzq_rope_hooked = True
    dm._bzq_tile_state = None
    logging.info("[%s] 已挂上坐标平移钩子（%s）", _TAG, module)
    return set_tile, uninstall


def tile_shifts(y0, x0, th, tx, h, w):
    """当前块相对全图画布的坐标平移量（潜空间格口径）。

    Qwen-Image 2.1 的坐标以 0 为中心：整幅是 arange(h) - ceil(h/2)，
    块内是 arange(th) - ceil(th/2)，块左上角落在 y0，两者相减即平移量。
    """
    return (y0 + _ceil_half(th) - _ceil_half(h),
            x0 + _ceil_half(tx) - _ceil_half(w))


def slice_reference_latents(条件, y0, x0, th, tx, h, w):
    """按当前块在整幅里的位置比例，切出参考图对应区域。

    条件结构保持原样（张量不动，只换 dict 里的 reference_latents），
    参考图拿不到或尺寸对不上就整张照用。
    """
    out = []
    for item in 条件:
        tensor = item[0]
        payload = item[1] if len(item) > 1 else {}
        refs = payload.get("reference_latents")
        if not refs:
            out.append(item)
            continue
        sliced = []
        for r in refs:
            if isinstance(r, torch.Tensor) and r.ndim == 4 and r.shape[-2] > 1 and r.shape[-1] > 1:
                rh, rw = int(r.shape[-2]), int(r.shape[-1])
                ry0 = min(rh - 1, round(y0 / h * rh))
                rx0 = min(rw - 1, round(x0 / w * rw))
                rth = max(1, min(rh - ry0, round(th / h * rh)))
                rtx = max(1, min(rw - rx0, round(tx / w * rw)))
                sliced.append(r[..., ry0:ry0 + rth, rx0:rx0 + rtx])
            else:
                sliced.append(r)
        new_payload = dict(payload)
        new_payload["reference_latents"] = sliced
        out.append([tensor, new_payload])
    return out
