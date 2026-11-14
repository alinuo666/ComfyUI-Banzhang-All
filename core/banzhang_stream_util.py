# -*- coding: utf-8 -*-
"""插帧公共骨架：流式逐帧处理 + 帧格式转换。

RIFE 和 EMA-VFI 两个引擎共用这一套：
    内存/显存峰值 = 模型 + 一对源帧 + 2^倍数 个中间帧，与视频多长完全无关。

各引擎只负责两件事：
    1. 提供 infer(img0, img1, timestep) -> 中间帧张量
    2. 报告自己支持多高的插帧倍数
"""
import gc
import os
import struct
import zipfile

import numpy as np
import torch

# 倍数 -> 递归次数（2 倍补 1 帧 = 1 次；4 倍 = 2 次；8 倍 = 3 次）
MULTIPLIER_ROUNDS = {2: 1, 4: 2, 8: 3}

SUPPORTED_MULTIPLIERS = tuple(MULTIPLIER_ROUNDS)


def rounds_for(multiplier: int) -> int:
    rounds = MULTIPLIER_ROUNDS.get(int(multiplier))
    if rounds is None:
        raise ValueError(f"不支持的倍数：{multiplier}，只能选 "
                         f"{'/'.join(str(m) for m in SUPPORTED_MULTIPLIERS)}")
    return rounds


def weight_ok(path: str, min_bytes: int) -> bool:
    """这个文件是不是一个**真能加载**的权重？

    「存在 + 够大」不等于「是权重」：下载中途断网、网盘下的压缩包被改名顶替、
    别的插帧插件留下的半截文件 —— 都能通过大小检查，然后一路喂进
    torch.load / safetensors，最后炸出一句用户看不懂的原生报错
    （RIFE 那边就是 KeyError: filename 'storages' not found，
    还常被误读成「找不到 ffmpeg」或「显存不够」）。所以进门先验内容。
    """
    try:
        if not path or not os.path.isfile(path) or os.path.getsize(path) <= min_bytes:
            return False
    except OSError:
        return False
    if path.lower().endswith(".safetensors"):
        return _safetensors_ok(path)
    return _torch_archive_ok(path)


def _safetensors_ok(path: str) -> bool:
    """safetensors 结构：8 字节小端头长度 + 一段 JSON 头。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(8)
            if len(head) < 8:
                return False
            n = struct.unpack("<Q", head)[0]
            if n <= 0 or n > size - 8:
                return False
            return f.read(n).lstrip()[:1] == b"{"
    except OSError:
        return False


def _torch_archive_ok(path: str) -> bool:
    """torch 存档只有两种合法形态：新版 zip（PK 头）/ 老版 tar（含 storages 成员）。

    只查前者会漏掉旧版 torch.save 的 tar 权重；只查大小则两种都漏。
    """
    try:
        if zipfile.is_zipfile(path):
            return True
    except OSError:
        return False
    try:
        import tarfile

        with tarfile.open(path, "r:") as tar:
            tar.getmember("storages")
        return True
    except Exception:
        return False


def head_bytes(path: str, n: int = 8) -> bytes:
    """文件开头几个字节 —— 报错时贴给用户看，一眼就知道是不是下成了网页/压缩包。"""
    try:
        with open(path, "rb") as f:
            return f.read(n)
    except OSError:
        return b""


def size_of(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def quarantine(path: str):
    """坏权重改名靠边站（不删，用户想查还能查），返回新路径；没东西可挪返回 None。"""
    if not os.path.isfile(path):
        return None
    bad = path + ".bad"
    try:
        os.replace(path, bad)
        return bad
    except OSError:
        return None


def free_cache() -> None:
    """把显存缓存还回去（每处理完一对帧调用一次，峰值更平稳）。"""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def to_gpu(rgb_np, fp16: bool) -> torch.Tensor:
    """numpy uint8 RGB 帧 -> (1,3,H,W) 浮点张量。"""
    t = torch.from_numpy(np.ascontiguousarray(rgb_np, dtype=np.uint8))
    t = t.to(dtype=torch.float32).div_(255.0).movedim(-1, 0).unsqueeze(0)
    return t.half() if fp16 else t


def to_np(mid: torch.Tensor) -> np.ndarray:
    """(1,3,H,W) 浮点张量 -> numpy uint8 RGB 帧。

    注意：推理是在 inference_mode 里跑的，产出的张量出作用域后不允许原地改，
    所以这里全程用非原地算子，并重新包一层 inference_mode。
    """
    with torch.inference_mode():
        frame = mid.squeeze(0).movedim(0, -1).clamp(0.0, 1.0).mul(255.0).round()
    return frame.to(torch.uint8).cpu().numpy()


def interp_mids(infer, img0, img1, rounds: int) -> list:
    """递归插中间帧，返回 2^rounds - 1 个中间帧（按时间顺序）。

    和「反复整段对插」在数学上完全等价，但每次只驻留当前这一对的中间结果。
    """
    if rounds <= 0:
        return []
    mid = infer(img0, img1, 0.5)
    if rounds == 1:
        return [mid]
    return (interp_mids(infer, img0, mid, rounds - 1)
            + [mid]
            + interp_mids(infer, mid, img1, rounds - 1))


def stream_interpolate(frames_iter, total_in: int, rounds: int, sink, infer,
                       fp16: bool = True, progress=None) -> None:
    """流式插帧：逐帧喂 numpy uint8 RGB，边插边把结果帧吐给 sink。

    frames_iter : 生成器，逐帧产出 HxWx3 uint8
    sink        : 每插出一帧就调用一次（通常是视频编码器的 write）
    infer       : infer(img0, img1, timestep) -> (1,3,H,W)
    """
    total_pairs = max(0, int(total_in) - 1)
    prev = None
    served = 0
    for cur_rgb in frames_iter:
        cur = to_gpu(cur_rgb, fp16)
        if prev is None:
            sink(cur_rgb)          # 第一帧原样落地
        else:
            for mid in interp_mids(infer, prev, cur, rounds):
                sink(to_np(mid))
            sink(cur_rgb)          # 再落当前源帧
        prev = cur
        served += 1
        if progress is not None and served >= 2:
            progress(served - 1, total_pairs)
    free_cache()


__all__ = ["MULTIPLIER_ROUNDS", "SUPPORTED_MULTIPLIERS", "rounds_for", "free_cache",
           "weight_ok", "head_bytes", "size_of", "quarantine",
           "to_gpu", "to_np", "interp_mids", "stream_interpolate"]
