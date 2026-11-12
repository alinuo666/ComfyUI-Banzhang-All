# -*- coding: utf-8 -*-
"""引擎层：EMA-VFI 插帧（CVPR 2023，Apache-2.0 可商用）

和 RIFE 的分工：
    RIFE     快、省显存，通用场景够用（默认）
    EMA-VFI  多尺度光流 + 注意力融合，画质高一档，代价是慢一些、显存多一些

网络代码见 _ema_vfi/（上游 MCG-NJU/EMA-VFI 原样保留）。
权重 ours_t.safetensors（约 250MB，支持任意时间点插帧）放
ComfyUI/models/ema_vfi/，缺失时自动从国内镜像下载。

精度说明：本引擎固定按单精度(fp32)运行。它是注意力架构，
半精度下 warp 采样会与卷积结果产生混合精度冲突（torch.cat 会直接报 dtype 错），
硬上 fp16 得不偿失，所以不做半精度开关。
"""
import os
import urllib.request

import torch
import torch.nn.functional as F

from .banzhang_stream_util import (free_cache, head_bytes, quarantine,
                                   rounds_for, size_of, weight_ok,
                                   stream_interpolate as _stream)
from ._ema_vfi import feature_extractor as fe_mod
from ._ema_vfi import flow_estimation as flow_mod

MODEL_FILENAME = "ours_t.safetensors"
MODEL_URL = "https://hf-mirror.com/WAS/EMA-VFI/resolve/main/ours_t.safetensors"
_MODEL_MIN_BYTES = 100 * 1024 * 1024       # 完整权重约 250MB，小于此值视为下载不完整
_NO_AUTO_DOWNLOAD_ENV = "BANZHANG_NO_AUTO_PIP"

# 别的 EMA-VFI 插件里权重常见的落地路径（相对 ComfyUI/models），命中就复用，不重复下载。
_LOCAL_CANDIDATES = [
    "ema_vfi/ours_t.safetensors",
    "EMA-VFI/ours_t.safetensors",
    "ema/ours_t.safetensors",
    "frame_interpolation/ema_vfi/ours_t.safetensors",
    "frame_interpolation/EMA-VFI/ours_t.safetensors",
]
_LOCAL_SEARCH_DIRS = ["ema_vfi", "EMA-VFI", "ema", "frame_interpolation"]

_CACHE = {}
_resolved_path = None


class EMAVFIError(RuntimeError):
    """给用户看的中文报错。"""


def _models_dir() -> str:
    import folder_paths

    path = os.path.join(folder_paths.models_dir, "ema_vfi")
    os.makedirs(path, exist_ok=True)
    return path


def _good_weight(path: str) -> bool:
    # 只看大小会把「下了一半」的 safetensors 当成有效权重，加载时抛一句看不懂的原生报错。
    return weight_ok(path, _MODEL_MIN_BYTES)


def _search_roots():
    """模型搜索根：主 models 目录排第一，其后是 extra_model_paths.yaml 里映射的插帧目录。

    EMA-VFI 在 ComfyUI 里不是官方文件夹类型 —— 只有用户装了第三方插帧包、或在 yaml 里
    显式写了 ema_vfi / frame_interpolation，才有映射路径可读。读不到就只剩主目录，
    与改前行为一致；主目录优先，不会改变最终选中哪个文件。
    """
    import folder_paths

    roots = []
    try:
        roots.append(folder_paths.models_dir)
    except Exception:
        pass
    try:
        table = folder_paths.folder_names_and_paths
    except Exception:
        table = {}
    for key in _LOCAL_SEARCH_DIRS:
        try:
            paths = table.get(key, ([], set()))[0] or []
        except Exception:
            continue
        for p in paths:
            if not p or p in roots:
                continue
            # 第三方插帧包常把自己的默认目录注册成 models/frame_interpolation，
            # 这类已经在主目录内部的映射，下面按约定子目录递归时本来就会扫到，
            # 再单独加根只会把同一处扫两遍。
            try:
                if os.path.commonpath([os.path.abspath(roots[0]), os.path.abspath(p)]) \
                        == os.path.abspath(roots[0]):
                    continue
            except Exception:
                pass
            roots.append(p)
    return roots


def _scan_dirs(roots):
    """递归找权重时要扫的目录。

    主根只扫约定子目录（整个 models 盘递归太慢）；映射目录连自己一起扫 ——
    用户在 yaml 里通常直接指到 ema_vfi / frame_interpolation 那一层。
    """
    dirs = []
    for i, root in enumerate(roots):
        if i:
            dirs.append(root)
        dirs.extend(os.path.join(root, d) for d in _LOCAL_SEARCH_DIRS)
    return dirs


def find_local_weight():
    """在 ComfyUI 本地模型目录里找已下载好的 EMA-VFI 权重；找不到返回 None。

    主 models 目录与 yaml 映射目录都找一遍，避免用户映射盘里已有权重还被重复下载。
    """
    import glob

    roots = _search_roots()

    for root in roots:
        for rel in _LOCAL_CANDIDATES:
            p = os.path.join(root, rel.replace("/", os.sep))
            if _good_weight(p):
                return p

    for base in _scan_dirs(roots):
        for p in glob.glob(os.path.join(base, "**", MODEL_FILENAME), recursive=True):
            if _good_weight(p):
                return p
    return None


def model_path() -> str:
    """实际要用的权重路径：优先解析到的本地文件，否则是规范存放位置。"""
    global _resolved_path
    if _good_weight(_resolved_path):
        return _resolved_path
    return os.path.join(_models_dir(), MODEL_FILENAME)


def ensure_model() -> bool:
    """本地已有权重就直接用（不重复下载）；没有才联网下载（约 250MB）。

    不想自动下载就设 BANZHANG_NO_AUTO_PIP=1。
    """
    global _resolved_path
    canonical = os.path.join(_models_dir(), MODEL_FILENAME)
    if _good_weight(canonical):
        _resolved_path = canonical
        return True

    if os.path.isfile(canonical):
        # 文件在、但不是权重：改名留证而不是直接覆盖（可能是别的插件在用的同名文件）
        size, head = size_of(canonical), head_bytes(canonical)
        bad = quarantine(canonical)
        print(f"[班长全家桶] EMA-VFI 的权重文件不是有效权重"
              f"（{size} 字节，开头 {head!r}）"
              f"{'，已改名为 ' + os.path.basename(bad) if bad else '，且无法改名'}，重新下载。")

    local = find_local_weight()
    if local:
        _resolved_path = local
        print(f"[班长全家桶] 检测到本地已有的 EMA-VFI 权重，直接复用（不重复下载）：\n  {local}")
        return True

    if str(os.environ.get(_NO_AUTO_DOWNLOAD_ENV, "")).strip().lower() in ("1", "true", "yes", "on"):
        return False

    print("[班长全家桶] 首次启用 EMA-VFI 插帧，本地未找到，正在下载模型（约 250MB）...")

    def _report(blocks, block_size, total):
        if total > 0 and blocks % 200 == 0:
            print(f"  已下载 {blocks * block_size / 1048576:.0f}MB / {total / 1048576:.0f}MB")

    tmp = canonical + ".tmp"
    try:
        urllib.request.urlretrieve(MODEL_URL, tmp, _report)
        # 下完当场验内容：断网留下的半截文件绝不能转正
        if not _good_weight(tmp):
            raise OSError(f"下载到的文件不是有效权重（{size_of(tmp)} 字节，"
                          f"开头 {head_bytes(tmp)!r}）")
        os.replace(tmp, canonical)
    except Exception as exc:
        try:
            os.remove(tmp)
        except OSError:
            pass
        print(f"[班长全家桶] EMA-VFI 模型下载失败：{exc}\n"
              f"  手动下载 {MODEL_URL}\n"
              f"  放到 {canonical}")
        return False
    _resolved_path = canonical
    print("[班长全家桶] EMA-VFI 模型下载完成。")
    return True


# ------------------------------------------------------------------ 网络构建

def _model_config(f=32, w=7, depth=(2, 2, 2, 4, 4)):
    """上游 config.py 的 init_model_config，原样搬过来（不要改数值，要和权重对得上）。"""
    from functools import partial

    import torch.nn as nn

    depth = list(depth)
    return {
        "embed_dims": [f, 2 * f, 4 * f, 8 * f, 16 * f],
        "motion_dims": [0, 0, 0, 8 * f // depth[-2], 16 * f // depth[-1]],
        "num_heads": [8 * f // 32, 16 * f // 32],
        "mlp_ratios": [4, 4],
        "qkv_bias": True,
        "norm_layer": partial(nn.LayerNorm, eps=1e-6),
        "depths": depth,
        "window_sizes": [w, w],
    }, {
        "embed_dims": [f, 2 * f, 4 * f, 8 * f, 16 * f],
        "motion_dims": [0, 0, 0, 8 * f // depth[-2], 16 * f // depth[-1]],
        "depths": depth,
        "num_heads": [8 * f // 32, 16 * f // 32],
        "window_sizes": [w, w],
        "scales": [4, 8, 16],
        "hidden_dims": [4 * f, 4 * f],
        "c": f,
    }


def _read_state(path: str):
    """读权重；读不出来就改名重下再读一次（同 RIFE：用户不用动手）。

    格式检查只能拦住「一眼假」的文件，整包合法但内部坏掉的要等加载才知道。
    """
    try:
        from safetensors.torch import load_file
    except Exception as exc:
        raise EMAVFIError(f"缺少 safetensors 依赖（ComfyUI 自带，可能环境不完整）：{exc}") from None

    for attempt in (1, 2):
        try:
            return load_file(path)
        except Exception as exc:
            size, head = size_of(path), head_bytes(path)
            bad = quarantine(path)
            print(f"[班长全家桶] EMA-VFI 权重读不出来（{size} 字节，开头 {head!r}），"
                  f"{'已改名为 ' + os.path.basename(bad) + '，' if bad else ''}"
                  f"重新下载后重试...")
            if attempt == 2 or not ensure_model():
                raise EMAVFIError(
                    f"EMA-VFI 的权重读不出来：{path}\n"
                    f"文件 {size} 字节，开头 {head!r} —— 这不是一个正常的 safetensors 权重。\n"
                    f"插件已自动重新下载过一次仍失败，多半是网络取不到正确文件。\n"
                    f"联网后重启 ComfyUI 重跑即可；一直不行就手动下载放到这个目录。\n"
                    f"原始报错：{exc}") from None
            path = model_path()


def load_model():
    """加载并缓存模型（只有一个精度，加载一次）。"""
    if _CACHE.get("net") is not None:
        return _CACHE["net"]

    if not ensure_model():
        raise EMAVFIError(
            f"找不到 EMA-VFI 权重：{model_path()}\n"
            f"手动下载后放进去就行，或联网重启一次让插件自己下。")

    path = model_path()
    if not _good_weight(path):
        # 文件在场但内容不对（下了一半 / 被同名文件顶替）：改名 + 重下，用户不用自己动手。
        size, head = size_of(path), head_bytes(path)
        bad = quarantine(path)
        print(f"[班长全家桶] EMA-VFI 权重文件已损坏（{path}，{size} 字节，"
              f"开头 {head!r}）"
              f"{'，已改名为 ' + os.path.basename(bad) if bad else ''}，正在重新下载...")
        if not ensure_model():
            raise EMAVFIError(
                f"EMA-VFI 权重损坏且重下失败：{path}\n"
                f"请联网后重启一次 ComfyUI；或手动下载放到这个位置。")
        path = model_path()

    import comfy.model_management as mm

    backbone_cfg, flow_cfg = _model_config()
    net = flow_mod.MultiScaleFlow(fe_mod.feature_extractor(**backbone_cfg), **flow_cfg)

    state = _read_state(path)
    # 上游训练用 DDP 存盘，键名带 module. 前缀；转换时可能已去掉，两种都兼容
    state = {k.replace("module.", ""): v for k, v in state.items()}
    # attn_mask / HW 是运行时按分辨率算出来的缓存，不该出现在权重里
    state = {k: v for k, v in state.items()
             if "attn_mask" not in k and "HW" not in k}

    missing, unexpected = net.load_state_dict(state, strict=False)
    if missing:
        print(f"⚠️ [班长全家桶] EMA-VFI 权重缺失 {len(missing)} 个键，示例：{list(missing)[:3]}")

    net.eval().to(mm.get_torch_device())
    for p in net.parameters():
        p.requires_grad_(False)
    _CACHE["net"] = net
    print(f"[班长全家桶] EMA-VFI 模型加载完成（{sum(p.numel() for p in net.parameters()) / 1e6:.1f}M 参数）。")
    return net


# ------------------------------------------------------------------ 推理

@torch.inference_mode()
def _infer(net, img0, img1, timestep: float = 0.5) -> torch.Tensor:
    """输入 (1,3,H,W) 的 0~1 浮点图，输出中间帧。边长补到 32 的倍数（上游要求）。"""
    device = next(net.parameters()).device
    img0 = img0.to(device)
    img1 = img1.to(device)
    _, _, height, width = img0.shape
    pad_h = (-height) % 32
    pad_w = (-width) % 32
    if pad_h or pad_w:
        img0 = F.pad(img0, (0, pad_w, 0, pad_h), mode="replicate")
        img1 = F.pad(img1, (0, pad_w, 0, pad_h), mode="replicate")

    pair = torch.cat((img0, img1), 1).float()
    pred = net(pair, timestep=timestep)[3]      # 返回顺序：(光流, 掩码, 各尺度粗融合, 最终帧)
    pred = pred.float().clamp(0.0, 1.0)
    if pad_h or pad_w:
        pred = pred[:, :, :height, :width]
    return pred


def _make_infer(net):
    def infer(img0, img1, timestep):
        return _infer(net, img0, img1, timestep)

    return infer


# ------------------------------------------------------------------ 流式插帧

def stream_interpolate(frames_iter, total_in: int, multiplier: int, fp16: bool,
                       sink, progress=None) -> None:
    """流式插帧入口，签名与 RIFE 引擎保持一致，节点层可无差别调用。"""
    try:
        rounds = rounds_for(multiplier)
    except ValueError as exc:
        raise EMAVFIError(str(exc)) from None

    net = load_model()
    _stream(frames_iter, total_in, rounds, sink, _make_infer(net),
            fp16=False, progress=progress)      # 固定单精度，理由见文件头
    free_cache()


__all__ = ["EMAVFIError", "ensure_model", "load_model", "model_path", "stream_interpolate"]
