# -*- coding: utf-8 -*-
"""🪞 人脸修复台 · 运行时画面推送（复用「班长 MiniMax H3 预览覆盖」那套机制）。

三件事，全部走同一条 WebSocket 通道、同一份 payload 约定：

1. 阶段字幕：检测 / 编码 / 采样 / 贴回 / 完成 —— 面板底部那一行状态文字。
2. 每人一路小视频：`faces()` 沿这个人自己的逐帧框取正方形视野，抽 12 帧编成
   animated WebP 推给对应格子。kind="before" 是原片（检测一结束就推，所以采样
   那几分钟每格都在动），kind="after" 是成片（贴回完成后推）。
   裁剪视野与静态缩略图共用 `frames.crop_square`，形状规则只有一处定义。
3. 采样逐步动画：不在本文件 —— 由 render.py 给模型装
   `apply_h3_preview_override`，那个 wrapper 自带逐步解码与广播
   （事件名 minimax_h3_preview_override），画面就是被修的那块裁剪区域。

性能口径（2026-11-21 本机实测）：
  · 每人 12 帧 / 128 边：单帧正方形裁剪+缩放约 0.6 毫秒，8 人 96 帧的张量搬运
    ≈ 0.3 秒（对照：整片 362 帧转 uint8 是 1.2 秒），一次性、不在采样关键路径；
    单段 WebP 约 20~40KB，8 段一次约 200~300KB。
  · 逐步采样：H3 官方 TAE 解 24 格 ≈ 110 毫秒 + 编码 ≈ 260 毫秒，且编码在
    `_AsyncPreviewEncoder` 后台线程，4 步合计 <1 秒（整轮约十分钟的 0.2%）。
  · 前端一律交给浏览器原生解码（animated WebP 用 <img>，按内嵌帧延时自动循环），
    不写 setInterval、不用 requestAnimationFrame；格子滚出画面或页面切后台撤 src。

任何一步失败都只吞异常返回，预览永远不许影响出片。
"""

import logging

import torch

FACE_FRAMES = 12          # 每人抽几帧：15 秒的脸抽 12 帧，够看出表情与转头
FACE_SIDE = 128           # 面板半格实测约 72 像素，128 留放大余量；再大纯属白烧
FACE_QUALITY = 80         # WebP 质量，与预览覆盖节点的缺省一致
EVENT = "banzhang_facefix_preview"


def _server():
    try:
        from server import PromptServer
        return PromptServer.instance
    except Exception:
        return None


def _send(node_id, payload):
    """广播一条面板事件。node_id 为空（拿不到 UNIQUE_ID）时直接静默。"""
    if not node_id:
        return
    srv = _server()
    if srv is None:
        return
    try:
        body = dict(payload)
        body["node_id"] = str(node_id)
        srv.send_sync(EVENT, body, srv.client_id)
    except Exception as exc:
        logging.warning("[人脸修复台] 预览广播失败（不影响出片）: %s" % exc)


def stage(node_id, text):
    """阶段字幕：面板底部状态行（跑完会被最终报告覆盖）。"""
    _send(node_id, {"kind": "stage", "text": str(text or "")})


def _even_indices(total, count):
    """[0,total) 上均匀取 count 个下标（保首尾）。"""
    if total <= 0 or count <= 0:
        return []
    n = min(int(count), int(total))
    if n == 1:
        return [total // 2]
    step = (total - 1) / float(n - 1)
    return [int(round(i * step)) for i in range(n)]


def _u8(frames, indices):
    """[T,H,W,3] 0-1 张量里按批取若干帧 → uint8 numpy [n,H,W,3]。

    一次 gather + 一次换算：逐帧 .cpu() 会把 12 次小搬运变成 12 次同步等待。
    """
    sub = frames[indices]
    if sub.device.type != "cpu":
        sub = sub.to("cpu")
    return (sub.detach().float().clamp_(0.0, 1.0).mul_(255.0)
            .to(torch.uint8).numpy())


def faces(node_id, frames, faces, kind="before", fps=24.0):
    """按人推一路循环小视频。返回成功推送的人数。

    每个人的 12 帧取自**他自己的有效帧**（缺席帧跳过），所以只在画面里出现
    3 秒的人也拿得到 12 帧，而不是整片均匀抽稀后什么都看不见。
    """
    if not node_id or not faces:
        return 0
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4:
        return 0
    try:
        from ..nodes.banzhang_mmh3_preview import _encode_animated_webp
        from .frames import crop_square
    except Exception as exc:
        logging.warning("[人脸修复台] 预览编码器不可用: %s" % exc)
        return 0
    from PIL import Image

    total = int(frames.shape[0])
    pushed = 0
    for f in faces:
        try:
            boxes = f.get("boxes") or []
            valid = [i for i, b in enumerate(boxes[:total]) if b]
            if not valid:
                continue
            # 连续帧才形成流畅运动，均匀抽整片会每秒跳一次姿态。
            center = valid[len(valid) // 2]
            start = center
            while start > 0 and center - start < FACE_FRAMES // 2 and boxes[start - 1]:
                start -= 1
            idx = []
            for i in range(start, min(total, start + FACE_FRAMES)):
                if not boxes[i]:
                    break
                idx.append(i)
            u8 = _u8(frames, idx)
            pil = []
            for n, i in enumerate(idx):
                crop = crop_square(u8[n], boxes[i], FACE_SIDE)
                if crop is None:
                    continue
                pil.append(Image.fromarray(crop))
            if len(pil) < 2:
                continue
            # 帧延时按「这个人真实出现的那段秒数 ÷ 帧间隔数」，循环回放与成片同速
            span = float(idx[-1] - idx[0]) / float(fps or 24.0)
            dur_ms = span * 1000.0 / max(1, len(pil) - 1) if span > 0 else None
            b64, w, h = _encode_animated_webp(
                pil, int(fps or 24), FACE_QUALITY, FACE_SIDE,
                duration_ms_override=dur_ms)
            if not b64:
                continue
            _send(node_id, {
                "kind": "face", "face_kind": kind, "face_index": int(f.get("index", 0)),
                "image": b64, "mime": "image/webp", "w": w, "h": h,
                "frames": len(pil), "duration_ms": dur_ms,
                "tracks": f.get("tracks") or [],
            })
            pushed += 1
        except Exception as exc:
            logging.warning("[人脸修复台] 第 %s 路预览生成失败（不影响出片）: %s"
                            % (f.get("index"), str(exc)[:80]))
    return pushed
