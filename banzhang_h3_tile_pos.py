# -*- coding: utf-8 -*-
"""
👨‍🏫 班长 H3 分块全局坐标注入（防分身小人 / 防接缝的最后一块拼图）

背景：
    H3 是纯相对 RoPE。分块采样时，每个 tile 都把自己的空间坐标用
    ``_frame_grid(tile_h, tile_w)`` 从 0 重新归一化到 [-16, +16]，模型以为每块
    都是一张「独立的完整小画布」。于是空背景块会按提示词凭空补主体（分身小人），
    相邻块各自理解画面（接缝）。

    解决：让每个 tile 的 patch 拿到它在「整幅坐标系」下的真实坐标（即整幅
    ``_frame_grid(H_full, W_full)`` 里对应位置的坐标值），模型就知道自己处理的是
    画面第几块、块外还有没有别的主体。

机制：
    复用 ComfyUI 原生 ``_axis_from_sqrt_area`` / ``_frame_grid`` 的坐标生成，
    只取整幅坐标网格里本 tile 覆盖的那段子区间，替换 tile layout 里 video 段与
    keyframe（cond）段的 position_ids 第 1、2 列（h、w）。数学上与整幅一致，
    不引入任何新的坐标规则。keyframe 与目标画面共享网格，必须一起换，否则锚点
    与生成内容分处两套坐标系（背景失去锚定 = 形变）。

注入方式（与 SLA 注意力同源，零 ComfyUI 源码侵入）：
    用 ``diffusion_model`` wrapper 包住 MiniMaxH3Model._forward。分块采样代码在每
    块预测前，把偏移写进 ``transformer_options["banzhang_tile_offset"]``；wrapper
    读到偏移后，临时把 layout.position_ids 的 video 段 h/w 列替换成全局坐标副本，
    调完原始 _forward 再还原。layout 是缓存对象，故只在调用期间临时替换、不改原值，
    避免污染整幅路径。
"""

from __future__ import annotations

import logging

import torch

log = logging.getLogger("BanzhangH3TilePos")

# transformer_options 里承载「本块全局偏移」的键
_OFFSET_KEY = "banzhang_tile_offset"

# diffusion_model wrapper 的 key（add_wrapper_with_key 按 key 去重，重复加是覆盖，幂等）
_WRAPPER_KEY = "banzhang_h3_tile_pos"


def _axis_from_sqrt_area(dim, patch, sqrt_area):
    """与 comfy.ldm.minimax.model._axis_from_sqrt_area 逐位一致。"""
    ratio = dim / sqrt_area
    n = dim // patch
    return (torch.arange(n, dtype=torch.float64) * (ratio / n) + (1.0 - ratio) / 2.0) * 32.0


def global_tile_positions(H_full, W_full, tile_h, tile_w, h_off_patch, w_off_patch):
    """整幅坐标系下，一个 tile 覆盖的每个 2x2 patch 的 (h, w) 坐标。

    参数：
        H_full, W_full  整幅 latent 的高/宽（格）
        tile_h, tile_w  本 tile 的高/宽（格）
        h_off_patch, w_off_patch  本 tile 首格在整幅中的偏移（patch 格，即 latent 格 // 2）

    返回：
        [tile_h//2 * tile_w//2, 2] float64，每行 [h_coord, w_coord]，按
        ``_video_grid`` 的 frame 展开顺序（先 h 后 w）排列，可直接替换
        video 段 position_ids 的第 1、2 列。
    """
    area = (H_full * W_full) ** 0.5
    hh = _axis_from_sqrt_area(H_full, 2, area)      # [H_full // 2]
    ww = _axis_from_sqrt_area(W_full, 2, area)      # [W_full // 2]
    h0, h1 = h_off_patch, h_off_patch + tile_h // 2
    w0, w1 = w_off_patch, w_off_patch + tile_w // 2
    # meshgrid 与 _frame_grid 同序（indexing="ij"，先 h 后 w）
    g = torch.stack(torch.meshgrid(hh[h0:h1], ww[w0:w1], indexing="ij"), dim=-1)
    return g.reshape(-1, 2)


def _spatial_seg_spans(layout):
    """返回需要换成整幅坐标的行区间列表：目标 video 段 + keyframe 的 cond 段。

    keyframe（fl2va 首尾帧）与目标画面共享同一套空间网格 —— 内核 PackedLayout 里
    两者都用同一个 ``frame`` 网格，注释也写了 "sharing the target spatial grid"。
    因此裁块后必须一起换成整幅坐标：只换 video 段会让锚点与生成内容分处两套坐标系，
    背景失去锚定、每步被重新发明 = 形变。
    ref_img / ref_audio / cond_audio / audio / text 各有自己的网格，一律不动。
    """
    spans = []
    for a, b, kind in getattr(layout, "segments", ()) or ():
        if kind in ("video", "cond"):
            spans.append((a, b))
    return spans


def _inject_global_positions(layout, H_full, W_full, tile_h, tile_w,
                             h_off_patch, w_off_patch):
    """把 layout 里 video 段与 keyframe（cond）段的空间坐标（第 1、2 列）
    换成整幅坐标系下的真实位置。

    直接在 layout.position_ids 上原地替换（调用方负责在 finally 里还原）。
    """
    spans = _spatial_seg_spans(layout)
    if not spans:
        return
    new_pos = global_tile_positions(
        int(H_full), int(W_full), int(tile_h), int(tile_w),
        int(h_off_patch), int(w_off_patch))
    frame_rows = new_pos.shape[0]
    for a, b in spans:
        n_rows = b - a
        if n_rows % frame_rows != 0:
            log.warning("[班长H3分块坐标] %d 行与全局坐标 %d 行不匹配，跳过该段注入",
                        n_rows, frame_rows)
            continue
        n_frames = n_rows // frame_rows
        tiled = new_pos.repeat(n_frames, 1)
        layout.position_ids[a:b, 1:] = tiled.to(layout.position_ids.dtype)


def _make_wrapper():
    """diffusion_model wrapper：读到偏移就把 video 段坐标换成全局坐标，用完还原。

    为什么需要重建 layout 并写回 payload：
        H3 的 _forward 会按 ``layout.signature``（含 tile 尺寸）判断缓存是否命中，
        signature 不匹配时用 tile 尺寸重新构建 layout（_frame_grid 从 0 重新归一化
        空间坐标）。因此只改 payload 里旧 layout 的 position_ids 会被重建覆盖。
        正确做法：wrapper 里先按 tile 尺寸构建一份 layout（与 _forward 重建逻辑
        一致），注入全局坐标后写回 payload["layout"]，让 _forward 命中 signature、
        直接用我们给的这份；调用结束再把 payload["layout"] 还原，避免污染整幅路径。
    """

    def wrapper(executor, x, timestep, context, transformer_options=None,
                minimax_payload=None, **kwargs):
        to = transformer_options or {}
        if minimax_payload is not None:
            # 兼容两种形态：dict（_forward 内部读的就是这个）或 CONDConstant（有 .cond）
            payload = getattr(minimax_payload, "cond", minimax_payload)
            kwargs["minimax_payload"] = minimax_payload
        else:
            payload = None
        offset = to.get(_OFFSET_KEY)
        if offset is None or payload is None:
            return executor(x, timestep, context,
                            transformer_options=transformer_options, **kwargs)

        H_full, W_full, tile_h, tile_w, h_off, w_off = offset
        try:
            video_x, audio_x = x[0], x[1]
            latent_t = video_x.shape[2]
            lat_h = video_x.shape[3]
            lat_w = video_x.shape[4]
            audio_t = audio_x.shape[-1]
            text_len = context.shape[1] if context is not None else 0
            saved_layout = payload.get("layout")
            # 按 tile 尺寸构建（与 _forward 重建口径一致），注入全局坐标后写回。
            # 用实际的 lat_h/lat_w（pad 后的）而非传入 tile 尺寸，避免 1 格偏差。
            # PackedLayout 延迟 import：本模块可能在 ComfyUI 尚未完全初始化时被加载。
            from comfy.ldm.minimax.model import PackedLayout as _PackedLayout
            layout = _PackedLayout(
                text_len, latent_t, lat_h, lat_w, audio_t,
                keyframes=payload.get("keyframes"),
                refs=payload.get("refs"))
            _inject_global_positions(layout, H_full, W_full, lat_h, lat_w,
                                     h_off, w_off)
            payload["layout"] = layout
            try:
                return executor(x, timestep, context,
                                transformer_options=transformer_options, **kwargs)
            finally:
                if saved_layout is None:
                    payload.pop("layout", None)
                else:
                    payload["layout"] = saved_layout
        except Exception as exc:  # noqa: BLE001 - 注入失败不应拖垮采样
            log.warning("[班长H3分块坐标] 全局坐标注入失败，本块退回相对坐标：%s", exc)
            return executor(x, timestep, context,
                            transformer_options=transformer_options, **kwargs)

    return wrapper


def install(model_patcher):
    """给 model_patcher 挂上全局坐标注入 wrapper（diffusion_model 层）。

    直接对传入的 ModelPatcher 加 wrapper，不做 clone（调用方负责在合适的时机
    —— 采样 prepare 之前 —— 传入 clone 后的 patcher）。按 key 去重，重复调用
    只是覆盖，幂等。
    """
    model_patcher.add_wrapper_with_key("diffusion_model", _WRAPPER_KEY,
                                        _make_wrapper())
    log.info("[班长H3分块坐标] 已挂全局坐标注入 wrapper")
    return model_patcher


def set_tile_offset(transformer_options, H_full, W_full, tile_h, tile_w,
                    h_off_patch, w_off_patch):
    """把本块的全局偏移写进 transformer_options，供 wrapper 读取。"""
    transformer_options[_OFFSET_KEY] = (
        int(H_full), int(W_full), int(tile_h), int(tile_w),
        int(h_off_patch), int(w_off_patch))
    return transformer_options


def clear_tile_offset(transformer_options):
    """预测完成后清掉偏移，避免污染后续整幅 / 其它 tile 的调用。"""
    transformer_options.pop(_OFFSET_KEY, None)
    return transformer_options
