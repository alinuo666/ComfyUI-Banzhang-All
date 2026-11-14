# -*- coding: utf-8 -*-
"""DLSS5 帧生成插帧 —— 媒体层（运动引导 / 视频解码 / 视频输出）

职责划分：
    banzhang_dlss5_fg.py       节点层（参数、进度条、报错文案）
    banzhang_dlss5_fg_engine.py 引擎层（worker 管道协议 + 插帧级联调度）
    banzhang_dlss5_fg_media.py  本文件（光流 + 视频读写）

来源：MIT 协议的 ComfyUI-RH-DLSS5 (RH-RunningHub/ComfyUI-RH-DLSS5)，
      其帧交换有一部分源自 Merserk 一系的 worker 协议。
2026-10-07 并入班长全家桶时的改动：
    - 删除 Linux/Wine/Xvfb/多卡钉卡等本机用不到的分支
    - 删除 sanitize_user_text()（它把真实文件名洗成"增强引擎"，妨碍排障）
    - 报错信息改为中文，直接显示缺失的真实文件名
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from fractions import Fraction
from pathlib import Path

import numpy as np
import torch

from ..banzhang_ffmpeg import (  # 全插件共用的 ffmpeg 查找（含包内 tools/ffmpeg 兜底）
    ffmpeg_help,
    find_binary as _find_binary,
    find_ffmpeg as _find_ffmpeg,
)

try:
    import cv2
except ImportError:  # 光流是可选的：没有 OpenCV 就退化成零运动向量
    cv2 = None


# ==============================================================================
# 一、运动引导（光流）
# ==============================================================================

def flow_implausible(flow: np.ndarray, basis: int) -> bool:
    """判断光流场是否不可信。True = 按"切镜"处理。

    高速平移、运动模糊或重复纹理会让光流算歪；这种向量喂给插帧会累积拖影，
    而重置历史只损失一帧的平滑度，代价小得多。
    """
    mag = np.hypot(flow[..., 0].astype(np.float32), flow[..., 1].astype(np.float32))
    mean_mag = float(mag.mean())
    if mean_mag <= 1e-3:
        return False  # 静止帧：零光流永远是安全的
    if mean_mag > 0.35 * basis:
        return True   # 整体位移大到不合常理
    median = float(np.hypot(np.median(flow[..., 0]), np.median(flow[..., 1])))
    return median / mean_mag < 0.15


class TemporalGuideGenerator:
    """用 OpenCV DIS 软件光流生成 FP16 运动向量。

    输入是 uint8 RGB 帧。没装 OpenCV 时退化为零向量 + 每帧重置。
    """

    def __init__(self, width: int, height: int, scene_change_threshold: float = 0.24) -> None:
        self.width = int(width)
        self.height = int(height)
        self.scene_change_threshold = float(scene_change_threshold)
        self.previous_gray: np.ndarray | None = None
        self.available = cv2 is not None
        if self.available:
            # 光流在缩小后的分辨率上计算，再放大回原尺寸
            flow_width = min(self.width, 640)
            self.flow_width = max(64, int(round(flow_width / 2.0) * 2))
            self.flow_height = max(64, int(round(self.height * self.flow_width / self.width / 2.0) * 2))
            self.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
            self.dis.setUseSpatialPropagation(True)
            self.dis.setFinestScale(1)

    def _small_gray(self, rgb: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        return cv2.resize(gray, (self.flow_width, self.flow_height), interpolation=cv2.INTER_AREA)

    def process(self, rgb: np.ndarray) -> tuple[np.ndarray, bool]:
        if not self.available:
            reset = self.previous_gray is None
            self.previous_gray = None
            return np.zeros((self.height, self.width, 2), dtype=np.float16), reset

        current = self._small_gray(rgb)
        if self.previous_gray is None:
            self.previous_gray = current
            return np.zeros((self.height, self.width, 2), dtype=np.float16), True

        zero_field = np.zeros((self.height, self.width, 2), dtype=np.float32)
        scene_score = float(np.mean(cv2.absdiff(current, self.previous_gray))) / 255.0
        if scene_score > self.scene_change_threshold:
            self.previous_gray = current
            return np.ascontiguousarray(zero_field.astype(np.float16)), True

        flow = self.dis.calc(current, self.previous_gray, None)
        if flow_implausible(flow, self.flow_width):
            self.previous_gray = current
            return np.ascontiguousarray(zero_field.astype(np.float16)), True

        motion = cv2.resize(flow, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
        motion[..., 0] *= self.width / self.flow_width
        motion[..., 1] *= self.height / self.flow_height
        self.previous_gray = current
        return np.ascontiguousarray(motion.astype(np.float16)), False


def sample_u8(image: np.ndarray) -> np.ndarray:
    """float RGB [H,W,C] 0..1 -> uint8 RGB。RGBA 输入只取前 3 通道。"""
    if image.ndim == 3 and image.shape[-1] > 3:
        image = image[..., :3]
    return np.clip(image * 255.0 + 0.5, 0, 255).astype(np.uint8)


# ==============================================================================
# 二、NVIDIA 硬件光流（NVOFA）
# ==============================================================================
# 通过 ctypes 直接调用驱动的 NVOF API。任何初始化或运行期失败都退化成
# "零运动向量 + 重置"，绝不把异常抛进帧循环。

import ctypes
import ctypes.util
import glob
import platform
from ctypes import (
    CFUNCTYPE, POINTER, Structure, byref, c_char_p, c_int, c_int32,
    c_size_t, c_uint32, c_uint64, c_void_p,
)

NV_OF_API_VERSION = (2 << 4) | 0
_CUDA_MEMCPY_HOST_TO_DEVICE = 1
_CUDA_MEMCPY_DEVICE_TO_HOST = 2
_USAGE_INPUT, _USAGE_OUTPUT, _USAGE_COST = 1, 2, 4
_FMT_ABGR8, _FMT_SHORT2, _FMT_UINT8 = 3, 5, 7
_BUFFER_TYPE_CUARRAY = 1
_MODE_OPTICALFLOW = 1
_CAP_OUTPUT_GRIDS, _CAP_WIDTH_MIN, _CAP_HEIGHT_MIN = 0, 4, 5


class NvofError(RuntimeError):
    pass


def _check(status: int, what: str) -> None:
    if status != 0:
        raise NvofError(f"{what} failed with NV_OF_STATUS {status}")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _even(value: int) -> int:
    return max(2, int(round(value / 2.0)) * 2)


_PFN_CREATE_OF = CFUNCTYPE(c_int, c_void_p, POINTER(c_void_p))
_PFN_OF_INIT = CFUNCTYPE(c_int, c_void_p, c_void_p)
_PFN_CREATE_BUFFER = CFUNCTYPE(c_int, c_void_p, c_void_p, c_int, POINTER(c_void_p))
_PFN_GET_CUARRAY = CFUNCTYPE(c_void_p, c_void_p)
_PFN_GET_CUDEVICEPTR = CFUNCTYPE(c_uint64, c_void_p)
_PFN_GET_STRIDE = CFUNCTYPE(c_int, c_void_p, c_void_p)
_PFN_SET_STREAMS = CFUNCTYPE(c_int, c_void_p, c_uint64, c_uint64)
_PFN_EXECUTE = CFUNCTYPE(c_int, c_void_p, c_void_p, c_void_p)
_PFN_DESTROY_BUFFER = CFUNCTYPE(c_int, c_void_p)
_PFN_DESTROY = CFUNCTYPE(c_int, c_void_p)
_PFN_LAST_ERROR = CFUNCTYPE(c_char_p, c_void_p)
_PFN_GET_CAPS = CFUNCTYPE(c_int, c_void_p, c_int, POINTER(c_uint32), POINTER(c_uint32))


class NV_OF_CUDA_API_FUNCTION_LIST(Structure):
    _fields_ = [
        ("nvCreateOpticalFlowCuda", _PFN_CREATE_OF),
        ("nvOFInit", _PFN_OF_INIT),
        ("nvOFCreateGPUBufferCuda", _PFN_CREATE_BUFFER),
        ("nvOFGPUBufferGetCUarray", _PFN_GET_CUARRAY),
        ("nvOFGPUBufferGetCUdeviceptr", _PFN_GET_CUDEVICEPTR),
        ("nvOFGPUBufferGetStrideInfo", _PFN_GET_STRIDE),
        ("nvOFSetIOCudaStreams", _PFN_SET_STREAMS),
        ("nvOFExecute", _PFN_EXECUTE),
        ("nvOFDestroyGPUBufferCuda", _PFN_DESTROY_BUFFER),
        ("nvOFDestroy", _PFN_DESTROY),
        ("nvOFGetLastError", _PFN_LAST_ERROR),
        ("nvOFGetCaps", _PFN_GET_CAPS),
    ]


class NV_OF_BUFFER_DESCRIPTOR(Structure):
    _fields_ = [("width", c_uint32), ("height", c_uint32),
                ("bufferUsage", c_int32), ("bufferFormat", c_int32)]


class NV_OF_INIT_PARAMS(Structure):
    _fields_ = [
        ("width", c_uint32), ("height", c_uint32), ("outGridSize", c_int32),
        ("hintGridSize", c_int32), ("mode", c_int32), ("perfLevel", c_int32),
        ("enableExternalHints", c_int32), ("enableOutputCost", c_int32),
        ("hPrivData", c_void_p), ("disparityRange", c_int32), ("enableRoi", c_int32),
    ]


class NV_OF_EXECUTE_INPUT_PARAMS(Structure):
    _fields_ = [
        ("inputFrame", c_void_p), ("referenceFrame", c_void_p), ("externalHints", c_void_p),
        ("disableTemporalHints", c_int32), ("padding", c_uint32), ("hPrivData", c_void_p),
        ("padding2", c_uint32), ("numRois", c_uint32), ("roiData", c_void_p),
    ]


class NV_OF_EXECUTE_OUTPUT_PARAMS(Structure):
    _fields_ = [("outputBuffer", c_void_p), ("outputCostBuffer", c_void_p), ("hPrivData", c_void_p)]


class _STRIDE(Structure):
    _fields_ = [("strideXInBytes", c_uint32), ("strideYInBytes", c_uint32)]


class NV_OF_CUDA_BUFFER_STRIDE_INFO(Structure):
    _fields_ = [("strideInfo", _STRIDE * 3), ("numPlanes", c_uint32)]


def _load_nvof_library() -> ctypes.CDLL:
    errors = []
    names = ("nvofapi64.dll",) if platform.system() == "Windows" else ("libnvidia-opticalflow.so.1",)
    for name in names:
        try:
            return ctypes.CDLL(name)
        except OSError as exc:
            errors.append(str(exc))
    for pattern in ("/usr/lib/x86_64-linux-gnu/libnvidia-opticalflow.so.*",
                    "/usr/lib64/libnvidia-opticalflow.so.*"):
        for path in sorted(glob.glob(pattern), reverse=True):
            try:
                return ctypes.CDLL(path)
            except OSError as exc:
                errors.append(str(exc))
    raise NvofError("libnvidia-opticalflow not loadable: " + "; ".join(errors[-2:]))


def _load_cudart() -> ctypes.CDLL:
    """单独加载共享 CUDA runtime：torch 的静态 runtime 用 ctypes 取不到。"""
    errors = []
    names = (("cudart64_13.dll", "cudart64_12.dll", "cudart64_110.dll")
             if platform.system() == "Windows"
             else ("libcudart.so.12", "libcudart.so.11.0", "libcudart.so"))
    for name in names:
        try:
            return ctypes.CDLL(name)
        except OSError as exc:
            errors.append(str(exc))
    found = ctypes.util.find_library("cudart")
    if found:
        try:
            return ctypes.CDLL(found)
        except OSError as exc:
            errors.append(str(exc))
    for pattern in ("/usr/local/cuda*/lib64/libcudart.so*",
                    "/usr/lib/x86_64-linux-gnu/libcudart.so*"):
        for path in sorted(glob.glob(pattern), reverse=True):
            if path.endswith(".a"):
                continue
            try:
                return ctypes.CDLL(path)
            except OSError as exc:
                errors.append(str(exc))
    raise NvofError("shared libcudart not loadable: " + "; ".join(errors[-2:]))


def _resize_bilinear(src: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    if src.shape[0] == out_h and src.shape[1] == out_w:
        return src
    try:
        import cv2
        return cv2.resize(src, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
    except Exception:
        pass
    h, w = src.shape[:2]
    ys = np.linspace(0, h - 1, out_h)
    xs = np.linspace(0, w - 1, out_w)
    y0 = np.floor(ys).astype(np.int64)
    y1 = np.minimum(y0 + 1, h - 1)
    x0 = np.floor(xs).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None, None]
    wx = (xs - x0)[None, :, None]
    a = src[np.ix_(y0, x0)]
    b = src[np.ix_(y0, x1)]
    c = src[np.ix_(y1, x0)]
    d = src[np.ix_(y1, x1)]
    return (a * (1 - wy) * (1 - wx) + b * (1 - wy) * wx
            + c * wy * (1 - wx) + d * wy * wx).astype(src.dtype)


class _NvofBuffer:
    def __init__(self, handle: c_void_p, cuarray: c_void_p, row_bytes: int, height: int):
        self.handle = handle
        self.cuarray = cuarray
        self.row_bytes = row_bytes
        self.height = height


class NvofGuideGenerator:
    """NVIDIA 硬件光流生成器，接口与 TemporalGuideGenerator 完全一致。"""

    def __init__(self, width: int, height: int, scene_change_threshold: float = 0.24) -> None:
        self.width = int(width)
        self.height = int(height)
        self.scene_change_threshold = float(scene_change_threshold)
        self.available = False
        self.init_error = ""
        self.engine = "nvof"
        self._previous_gray: np.ndarray | None = None
        self._broken = False
        self._cost_enabled = False
        self._rt = None
        self._fn: NV_OF_CUDA_API_FUNCTION_LIST | None = None
        self._hof: c_void_p | None = None
        self._buffers: list[_NvofBuffer] = []
        self._buf_prev = self._buf_cur = self._buf_out = self._buf_cost = None
        try:
            self._engine_init()
            self.available = True
        except Exception as exc:
            self.init_error = f"{type(exc).__name__}: {exc}"
            self._release()

    # -- 初始化 ---------------------------------------------------------------

    def _engine_init(self) -> None:
        if not torch.cuda.is_available():
            raise NvofError("CUDA is not available")
        torch.zeros(8, device="cuda")
        torch.cuda.synchronize()

        self._rt = _load_cudart()
        self._rt.cudaSetDevice.argtypes = [c_int]
        self._rt.cudaSetDevice.restype = c_int
        self._rt.cudaDeviceSynchronize.argtypes = []
        self._rt.cudaDeviceSynchronize.restype = c_int
        self._rt.cudaMemcpy2DToArray.argtypes = [
            c_void_p, c_size_t, c_size_t, c_void_p, c_size_t, c_size_t, c_size_t, c_int]
        self._rt.cudaMemcpy2DToArray.restype = c_int
        self._rt.cudaMemcpy2DFromArray.argtypes = [
            c_void_p, c_size_t, c_void_p, c_size_t, c_size_t, c_size_t, c_size_t, c_int]
        self._rt.cudaMemcpy2DFromArray.restype = c_int
        _check(self._rt.cudaSetDevice(torch.cuda.current_device()), "cudaSetDevice")

        cuda = ctypes.CDLL("nvcuda.dll" if platform.system() == "Windows" else "libcuda.so.1")
        cuda.cuCtxGetCurrent.argtypes = [POINTER(c_void_p)]
        cuda.cuCtxGetCurrent.restype = c_int
        ctx = c_void_p()
        _check(cuda.cuCtxGetCurrent(byref(ctx)), "cuCtxGetCurrent")
        if not ctx.value:
            raise NvofError("no current CUDA context")

        lib = _load_nvof_library()
        fn = NV_OF_CUDA_API_FUNCTION_LIST()
        _check(lib.NvOFAPICreateInstanceCuda(c_uint32(NV_OF_API_VERSION), byref(fn)),
               "NvOFAPICreateInstanceCuda")
        if not fn.nvCreateOpticalFlowCuda:
            raise NvofError("NvOF function list not populated")
        self._fn = fn
        self._ctx = ctx

        flow_width = _even(min(self.width, _env_int("BANZHANG_OF_MAXW", 640)))
        flow_height = _even(int(round(self.height * flow_width / max(1, self.width))))
        grid = _env_int("BANZHANG_OF_GRID", 2)
        perf = _env_int("BANZHANG_OF_PERF", 10)
        cost_lo = _env_int("BANZHANG_OF_COST_LO", 64)
        cost_hi = _env_int("BANZHANG_OF_COST_HI", 192)
        self._cost_lo, self._cost_hi = float(min(cost_lo, cost_hi)), float(max(cost_lo, cost_hi))

        last_error: Exception | None = None
        for enable_cost in (True, False):
            try:
                self._init_session(ctx, flow_width, flow_height, grid, perf, enable_cost)
                self._cost_enabled = enable_cost
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                self._release_session()
                if not enable_cost:
                    raise
        if last_error is not None:
            raise last_error

    def _init_session(self, ctx: c_void_p, flow_width: int, flow_height: int,
                      grid: int, perf: int, enable_cost: bool) -> None:
        fn = self._fn
        hof = c_void_p()
        _check(fn.nvCreateOpticalFlowCuda(self._ctx, byref(hof)), "nvCreateOpticalFlowCuda")
        self._hof = hof

        grids = self._caps(_CAP_OUTPUT_GRIDS)
        if grids and grid not in grids:
            grid = min(grids)
        width_min = self._caps(_CAP_WIDTH_MIN)
        height_min = self._caps(_CAP_HEIGHT_MIN)
        flow_width = max(flow_width, width_min[0] if width_min else 0)
        flow_height = max(flow_height, height_min[0] if height_min else 0)

        init = NV_OF_INIT_PARAMS(
            width=flow_width, height=flow_height, outGridSize=grid, hintGridSize=grid,
            mode=_MODE_OPTICALFLOW, perfLevel=perf, enableExternalHints=0,
            enableOutputCost=1 if enable_cost else 0, hPrivData=None,
            disparityRange=0, enableRoi=0)
        _check(fn.nvOFInit(self._hof, byref(init)), "nvOFInit")

        self.flow_width, self.flow_height, self.grid = flow_width, flow_height, grid
        self._out_w, self._out_h = -(-flow_width // grid), -(-flow_height // grid)
        self._buf_prev = self._create_buffer(flow_width, flow_height, _USAGE_INPUT, _FMT_ABGR8)
        self._buf_cur = self._create_buffer(flow_width, flow_height, _USAGE_INPUT, _FMT_ABGR8)
        self._buf_out = self._create_buffer(self._out_w, self._out_h, _USAGE_OUTPUT, _FMT_SHORT2)
        self._buf_cost = (self._create_buffer(self._out_w, self._out_h, _USAGE_COST, _FMT_UINT8)
                          if enable_cost else None)

    def _caps(self, cap: int, count: int = 16) -> list[int]:
        vals = (c_uint32 * count)()
        returned = c_uint32(count)
        _check(self._fn.nvOFGetCaps(self._hof, cap, vals, byref(returned)), f"nvOFGetCaps({cap})")
        return [int(vals[i]) for i in range(min(returned.value, count))]

    def _create_buffer(self, width: int, height: int, usage: int, fmt: int) -> _NvofBuffer:
        desc = NV_OF_BUFFER_DESCRIPTOR(width, height, usage, fmt)
        handle = c_void_p()
        _check(self._fn.nvOFCreateGPUBufferCuda(self._hof, byref(desc), _BUFFER_TYPE_CUARRAY,
                                                byref(handle)), "nvOFCreateGPUBufferCuda")
        stride = NV_OF_CUDA_BUFFER_STRIDE_INFO()
        _check(self._fn.nvOFGPUBufferGetStrideInfo(handle, byref(stride)),
               "nvOFGPUBufferGetStrideInfo")
        cuarray = c_void_p(self._fn.nvOFGPUBufferGetCUarray(handle))
        if not cuarray.value:
            self._fn.nvOFDestroyGPUBufferCuda(handle)
            raise NvofError("NVOF buffer has no CUarray")
        buf = _NvofBuffer(handle, cuarray, int(stride.strideInfo[0].strideXInBytes), height)
        self._buffers.append(buf)
        return buf

    # -- 释放 -----------------------------------------------------------------

    def _release_session(self) -> None:
        fn = self._fn
        for buf in self._buffers:
            try:
                fn.nvOFDestroyGPUBufferCuda(buf.handle)
            except Exception:
                pass
        self._buffers = []
        if self._hof is not None and fn is not None:
            try:
                fn.nvOFDestroy(self._hof)
            except Exception:
                pass
        self._hof = None

    def _release(self) -> None:
        self._release_session()
        self._rt = None
        self._fn = None

    def __del__(self) -> None:
        try:
            self._release()
        except Exception:
            pass

    # -- 每帧 -----------------------------------------------------------------

    def _upload(self, buf: _NvofBuffer, bgra: np.ndarray) -> None:
        row_bytes = bgra.shape[1] * 4
        if buf.row_bytes < row_bytes:
            raise NvofError(f"buffer pitch {buf.row_bytes} < row {row_bytes}")
        _check(self._rt.cudaMemcpy2DToArray(
            buf.cuarray, 0, 0, c_void_p(bgra.ctypes.data), row_bytes, row_bytes, buf.height,
            _CUDA_MEMCPY_HOST_TO_DEVICE), "cudaMemcpy2DToArray")

    def _download(self, buf: _NvofBuffer, host: np.ndarray) -> None:
        row_bytes = host.nbytes // host.shape[0]
        if buf.row_bytes < row_bytes:
            raise NvofError(f"buffer pitch {buf.row_bytes} < row {row_bytes}")
        _check(self._rt.cudaMemcpy2DFromArray(
            c_void_p(host.ctypes.data), row_bytes, buf.cuarray, 0, 0, row_bytes, host.shape[0],
            _CUDA_MEMCPY_DEVICE_TO_HOST), "cudaMemcpy2DFromArray")

    def _downscale(self, rgb: np.ndarray) -> np.ndarray:
        h, w = rgb.shape[:2]
        if w == self.flow_width and h == self.flow_height:
            return rgb
        try:
            import cv2
            return cv2.resize(rgb, (self.flow_width, self.flow_height),
                              interpolation=cv2.INTER_AREA)
        except Exception:
            return _resize_bilinear(rgb, self.flow_height, self.flow_width)

    def _pack_bgra(self, rgb: np.ndarray) -> np.ndarray:
        rgb = self._downscale(rgb)
        h, w = rgb.shape[:2]
        bgra = np.empty((h, w, 4), dtype=np.uint8)
        bgra[..., 0] = rgb[..., 2]
        bgra[..., 1] = rgb[..., 1]
        bgra[..., 2] = rgb[..., 0]
        bgra[..., 3] = 255
        return bgra

    def _scene_gray(self, rgb: np.ndarray) -> np.ndarray:
        h, w = rgb.shape[:2]
        ys = np.linspace(0, h - 1, min(h, 288), dtype=np.int64)
        xs = np.linspace(0, w - 1, min(w, 512), dtype=np.int64)
        small = rgb[np.ix_(ys, xs)].astype(np.float32)
        return small[..., 0] * 0.299 + small[..., 1] * 0.587 + small[..., 2] * 0.114

    def _zero(self) -> np.ndarray:
        return np.zeros((self.height, self.width, 2), dtype=np.float16)

    def process(self, rgb: np.ndarray) -> tuple[np.ndarray, bool]:
        if self._broken or not self.available:
            return self._zero(), True
        try:
            return self._process_impl(rgb)
        except Exception as exc:
            self._broken = True
            print(f"[班长DLSS5插帧] 硬件光流出错已停用: {exc}", flush=True)
            return self._zero(), True

    def _process_impl(self, rgb: np.ndarray) -> tuple[np.ndarray, bool]:
        gray = self._scene_gray(rgb)
        bgra = self._pack_bgra(rgb)
        if self._previous_gray is None:
            self._previous_gray = gray
            self._upload(self._buf_prev, bgra)
            return self._zero(), True

        scene_score = float(np.mean(np.abs(gray - self._previous_gray))) / 255.0
        self._previous_gray = gray
        self._upload(self._buf_cur, bgra)
        if scene_score > self.scene_change_threshold:
            self._buf_prev, self._buf_cur = self._buf_cur, self._buf_prev
            return self._zero(), True

        inp = NV_OF_EXECUTE_INPUT_PARAMS(inputFrame=self._buf_cur.handle,
                                         referenceFrame=self._buf_prev.handle,
                                         disableTemporalHints=0)
        outp = NV_OF_EXECUTE_OUTPUT_PARAMS(
            outputBuffer=self._buf_out.handle,
            outputCostBuffer=self._buf_cost.handle if self._buf_cost is not None else None)
        _check(self._fn.nvOFExecute(self._hof, byref(inp), byref(outp)), "nvOFExecute")
        _check(self._rt.cudaDeviceSynchronize(), "cudaDeviceSynchronize")

        flow = np.empty((self._out_h, self._out_w, 2), dtype=np.int16)
        self._download(self._buf_out, flow)
        motion = flow.astype(np.float32) / 32.0
        if flow_implausible(motion, self.flow_width):
            self._buf_prev, self._buf_cur = self._buf_cur, self._buf_prev
            return self._zero(), True
        if self._buf_cost is not None:
            cost = np.empty((self._out_h, self._out_w), dtype=np.uint8)
            self._download(self._buf_cost, cost)
            weight = np.clip((self._cost_hi - cost.astype(np.float32))
                             / max(1.0, self._cost_hi - self._cost_lo), 0.0, 1.0)
            motion *= weight[..., None]

        motion = _resize_bilinear(motion, self.height, self.width)
        motion[..., 0] *= self.width / self.flow_width
        motion[..., 1] *= self.height / self.flow_height
        self._buf_prev, self._buf_cur = self._buf_cur, self._buf_prev
        return np.ascontiguousarray(motion.astype(np.float16)), False


# ==============================================================================
# 三、视频输入：分块解码
# ==============================================================================
# VIDEO.get_components() 会把整段视频变成 float32（每像素每帧 12 字节）：
# 1824 帧 1080p 约 45GB，4K 约 181GB，会直接 OOM。文件型 VIDEO 改走 ffmpeg
# rawvideo 管道分块解码，内存峰值只有一个块，与片长无关。


def probe_video(path: str) -> dict | None:
    """ffprobe 读取基本信息 -> {'frames','width','height','fps'} 或 None。"""
    ffprobe = _find_binary("ffprobe")
    if not ffprobe:
        return None
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets",
             "-show_entries", "stream=nb_read_packets,nb_frames,width,height,avg_frame_rate",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=120)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    try:
        streams = (json.loads(r.stdout or "{}").get("streams") or [])
    except Exception:
        return None
    if not streams:
        return None
    s = streams[0]

    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    frames = _int(s.get("nb_read_packets")) or _int(s.get("nb_frames"))
    width, height = _int(s.get("width")), _int(s.get("height"))
    if frames <= 0 or width <= 0 or height <= 0:
        return None
    fps = 0.0
    ar = str(s.get("avg_frame_rate") or "")
    try:
        if "/" in ar and _int(ar.split("/", 1)[1]) != 0:
            fps = _int(ar.split("/", 1)[0]) / _int(ar.split("/", 1)[1])
        elif ar:
            fps = float(ar)
    except (TypeError, ValueError):
        fps = 0.0
    return {"frames": frames, "width": width, "height": height, "fps": fps}


class ChunkedVideoReader:
    """把视频文件按时间顺序流式读成 (序号, uint8 RGB 帧)。"""

    CHUNK_FRAMES = 32

    def __init__(self, path: str, log=print):
        self.path = str(path)
        self.log = log
        info = probe_video(self.path)
        if info is None:
            raise RuntimeError(f"无法读取视频信息: {self.path}")
        self.count = int(info["frames"])
        self.width = int(info["width"])
        self.height = int(info["height"])
        self.fps = float(info["fps"])

    def iter_frames(self):
        ffmpeg = _find_binary("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("找不到 ffmpeg，无法分块解码")
        w, h = self.width, self.height
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error",
               "-i", self.path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-v", "error", "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        frame_bytes = w * h * 3
        chunk = max(1, self.CHUNK_FRAMES)
        index = 0
        try:
            while index < self.count:
                raw = proc.stdout.read(frame_bytes * chunk)
                if not raw:
                    break
                got = len(raw) // frame_bytes
                if got <= 0:
                    break
                block = np.frombuffer(raw[:got * frame_bytes], dtype=np.uint8)
                frames = block.reshape(got, h, w, 3)
                for i in range(got):
                    if index >= self.count:
                        break
                    yield index, frames[i]
                    index += 1
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


class SequentialSource:
    """严格顺序访问的 source(index)：只允许 0,1,2,... 走一遍。

    插帧的各级 pipeline 都是严格向前的；一旦出现跳序说明调用层改坏了，
    这里直接报错，而不是悄悄吐出重复帧。
    """

    def __init__(self, reader: ChunkedVideoReader):
        self._reader = reader
        self._iter = reader.iter_frames()
        self._next_index = 0
        self._buffered = None
        self._served_up_to = -1

    def __call__(self, index: int):
        if index <= self._served_up_to:
            raise RuntimeError(
                f"顺序源被重复读取: 第 {index} 帧已经给过 (已给到 {self._served_up_to})")
        if index > self._next_index:
            raise RuntimeError(
                f"顺序源被跳读: 要第 {index} 帧, 下一个未读是 {self._next_index}")
        while self._next_index <= index:
            item = next(self._iter, None)
            if item is None:
                raise RuntimeError(
                    f"视频在第 {index} 帧就解完了 (共解出 {self._next_index}/"
                    f"{self._reader.count} 帧)")
            served_index, frame = item
            self._buffered = frame
            self._next_index = served_index + 1
        self._served_up_to = index
        rgba = np.empty((self._reader.height, self._reader.width, 4), dtype=np.uint8)
        rgba[..., :3] = self._buffered
        rgba[..., 3] = 255
        self._buffered = None
        return rgba, None


def build_source(path: str, log=print):
    """文件型 VIDEO -> (reader, SequentialSource)；失败返回 None。"""
    try:
        reader = ChunkedVideoReader(path, log=log)
        return reader, SequentialSource(reader)
    except Exception as e:
        log(f"[班长DLSS5插帧] 分块解码不可用({e})，回退到整段解码")
        return None


def resolve_video_path(video, log=print):
    """把各种形态的 VIDEO 输入解析成可读的视频文件路径；拿不到返回 None。

    与「🎥 视频合并」节点的视频入口保持同一套兼容面：
      - 字符串 / 路径对象：FlashVSR 等节点直接把 mp4 路径当 VIDEO 输出；
      - 上传文件字典 {filename, subfolder, type}；
      - VideoFromFile 等带 get_stream_source() 的 VIDEO 对象；
      - 纯内存型 VIDEO（背后没有文件）：返回 None，调用方走 get_components()。
    """
    if video is None:
        return None
    if isinstance(video, (str, os.PathLike)):
        s = os.fspath(video)
        if os.path.isfile(s):
            return s
        try:
            import folder_paths
            resolved = folder_paths.get_annotated_filepath(s)
            if resolved and os.path.isfile(resolved):
                return resolved
        except Exception:
            pass
        return None
    if isinstance(video, dict):
        base = ""
        try:
            import folder_paths
            base = folder_paths.get_annotated_filepath(video) or ""
        except Exception:
            base = ""
        if base and os.path.isfile(base):
            return base
        base = str(video.get("filename", "") or "")
        if base and os.path.isfile(base):
            return base
        return None
    getter = getattr(video, "get_stream_source", None)
    if not callable(getter):
        return None
    try:
        info = getter()
    except Exception:
        return None
    if isinstance(info, (tuple, list)) and info:
        path = str(info[0])
        return path if os.path.exists(path) else None
    if isinstance(info, str) and os.path.exists(info):
        return info
    return None


# ==============================================================================
# 四、视频输出
# ==============================================================================

def _find_ffmpeg() -> str | None:
    found = _find_binary("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _encode_with_pyav(images: torch.Tensor, fps, path: Path) -> None:
    import av

    _, height, width, _ = images.shape
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("libx264", rate=Fraction(fps))
        stream.width = int(width)
        stream.height = int(height)
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "18", "preset": "medium"}
        stream.time_base = 1 / Fraction(fps)
        for index, frame_rgb in enumerate(images):
            frame = frame_rgb.detach().cpu().clamp(0.0, 1.0).numpy()
            frame_u8 = (frame * 255.0 + 0.5).astype(np.uint8)
            packet_source = av.VideoFrame.from_ndarray(frame_u8, format="rgb24")
            packet_source.pts = index
            packet_source.time_base = 1 / Fraction(fps)
            for packet in stream.encode(packet_source):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def audio_source_path(audio_input, source_video) -> str | None:
    """从 AUDIO 对象或源 VIDEO 里找到可直拷贝的音频文件路径。"""
    for candidate in (source_video, audio_input):
        if candidate is None:
            continue
        # 字符串路径（FlashVSR 等节点把 mp4 路径当 VIDEO 输出）
        if isinstance(candidate, (str, os.PathLike)):
            path = os.fspath(candidate)
            if path and os.path.exists(path):
                return path
            continue
        getter = getattr(candidate, "get_stream_source", None)
        if callable(getter):
            try:
                info = getter()
                if isinstance(info, (tuple, list)) and info:
                    path = str(info[0])
                    if path and os.path.exists(path):
                        return path
                if isinstance(info, str) and os.path.exists(info):
                    return info
            except Exception:
                continue
    return None


def _audio_to_wav(audio_input) -> Path | None:
    """AUDIO 对象 -> 临时 int16 WAV 文件（无法直拷贝时的兜底）。"""
    wave = getattr(audio_input, "waveform", None)
    rate = getattr(audio_input, "sample_rate", None)
    if wave is None and isinstance(audio_input, dict):
        wave = audio_input.get("waveform")
        rate = audio_input.get("sample_rate")
    if wave is None or rate is None:
        return None
    try:
        import wave as wavefile
        from folder_paths import get_temp_directory

        samples = torch.as_tensor(wave).detach().cpu().float()
        if samples.ndim == 3:
            samples = samples[0]
        if samples.ndim == 1:
            samples = samples[None, :]
        pcm = (np.clip(samples.T.contiguous().numpy(), -1.0, 1.0) * 32767.0).astype("<i2")
        path = Path(get_temp_directory()) / f"banzhang_dlss5fg_{uuid.uuid4().hex}_audio.wav"
        with wavefile.open(str(path), "wb") as handle:
            handle.setnchannels(pcm.shape[1])
            handle.setsampwidth(2)
            handle.setframerate(int(rate))
            handle.writeframes(pcm.tobytes())
        return path
    except Exception:
        return None


def _video_from_components(images: torch.Tensor, fps, audio_input):
    fps = Fraction(fps)
    try:
        from comfy_api.video import VideoFromComponents, VideoComponents  # type: ignore
    except Exception:
        pass
    else:
        config = None
        for module_name in ("comfy_api.input", "comfy_api.input_impl"):
            try:
                module = __import__(module_name, fromlist=["VideoAudioConfig"])
                config = module.VideoAudioConfig(fps=fps)
                if Fraction(config.fps) != fps:
                    config = None
                    continue
                break
            except Exception:
                continue
        try:
            if config is None:
                raise ValueError("No exact frame-rate config available")
            components = VideoComponents(images=images, audio=audio_input, config=config)
            return VideoFromComponents(components), None
        except Exception:
            pass
    try:
        from comfy_api.latest import InputImpl, Types  # type: ignore

        components = Types.VideoComponents(images=images, frame_rate=Fraction(fps),
                                           audio=audio_input)
        return InputImpl.VideoFromComponents(components), None
    except Exception:
        return None, None


def video_from_file(path):
    try:
        from comfy_api.video import VideoFromFile  # type: ignore
        return VideoFromFile(str(path))
    except Exception:
        pass
    try:
        from comfy_api.latest import InputImpl  # type: ignore
        return InputImpl.VideoFromFile(str(path))
    except Exception:
        return None


class StreamEncoder:
    """逐帧喂进去的 RGB uint8 输出槽，成片落在 ComfyUI 临时目录。

    优先走 ffmpeg 子进程（快，且能把源片音轨直拷进去）；
    系统里没有 ffmpeg 时自动降级成 PyAV 编码（ComfyUI 自带，只是没有音轨）。
    生命周期：每帧 write()，正常结束 close()，出错走 abort()。
    """

    def __init__(self, width: int, height: int, fps, audio_input=None, source_video=None,
                 n_frames: int | None = None) -> None:
        fps = Fraction(fps)
        self.width = int(width)
        self.height = int(height)
        self.source = None
        self._audio_wav: Path | None = None
        self._av = None
        self._av_stream = None
        self._av_index = 0
        from folder_paths import get_temp_directory

        self.path = Path(get_temp_directory()) / f"banzhang_dlss5fg_{uuid.uuid4().hex}.mp4"

        ffmpeg = _find_ffmpeg()
        if ffmpeg is None:
            self._open_av(fps)
            return
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-video_size", f"{self.width}x{self.height}",
            "-framerate", f"{fps.numerator}/{fps.denominator}",
            "-i", "-",
        ]
        if audio_input is not None or source_video is not None:
            source = audio_source_path(audio_input, source_video)
            if source:
                self.source = source
                # 源音轨直拷这条线**不能**挂 -shortest：音轨只要比画面短一丁点（毫秒级
                # 差异在真实片里普遍存在），ffmpeg 就判定「最短的流结束了」，把后面
                # 还没写完的画面帧整批扔掉（实测写 30 帧只剩 25 帧，且无声无息）。
                command += ["-i", source, "-map", "0:v:0", "-map", "1:a?", "-c:a", "copy"]
            elif audio_input is not None:
                self._audio_wav = _audio_to_wav(audio_input)
                if self._audio_wav is not None:
                    # apad 把音轨补成无限长，必须留封顶手段，否则进程永不退出；
                    # 这条线音频不会先结束，-shortest 只可能由画面触发，是安全的。
                    command += ["-i", str(self._audio_wav), "-map", "0:v:0", "-map", "1:a",
                                "-c:a", "aac", "-af", "apad", "-shortest"]
        command += ["-c:v", "libx264", "-preset", "medium", "-crf", "18",
                    "-pix_fmt", "yuv420p"]
        if n_frames:
            # 帧数由调用方锁死：画面该有多少帧本来就由我们决定，不该交给 ffmpeg
            # 按音轨长度去猜。-t 多给半帧余量，保证它不会先于 -frames:v 生效而
            # 砍掉最后一帧（-frames:v 数的是帧，可靠；-t 按时间算，会漂）。
            command += ["-frames:v", str(int(n_frames)),
                        "-t", f"{(int(n_frames) + 0.5) / float(fps):.6f}"]
        command += [str(self.path)]
        self._proc = subprocess.Popen(command, stdin=subprocess.PIPE,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self._errors: list[str] = []
        self._drain = threading.Thread(target=self._drain_stderr, daemon=True)
        self._drain.start()

    # -------------------------------------------------- PyAV 兜底（无 ffmpeg 时）
    def _open_av(self, fps: Fraction) -> None:
        """系统里没有 ffmpeg 时的降级通道：用 ComfyUI 自带的 PyAV 编码。

        代价是拿不到源片音轨（ffmpeg 那套 -c:a copy 直拷这里做不到），
        输出视频是静音的，调用方会在日志里说明。
        """
        try:
            import av
        except ImportError as exc:
            raise RuntimeError(
                f"找不到 ffmpeg，ComfyUI 自带的 PyAV 也不可用，没法把结果编码成视频。\n"
                f"{ffmpeg_help()}") from exc
        self._av = av.open(str(self.path), mode="w")
        stream = self._av.add_stream("libx264", rate=fps)
        stream.width = self.width
        stream.height = self.height
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "18", "preset": "medium"}
        stream.time_base = 1 / fps
        self._av_stream = stream
        print(f"[班长视频] 系统里没有 ffmpeg，已自动改用 ComfyUI 自带的 PyAV 编码"
              f"（输出视频没有音轨）。\n{ffmpeg_help()}", flush=True)

    def _drain_stderr(self) -> None:
        try:
            for raw in iter(self._proc.stderr.readline, b""):
                self._errors.append(raw.decode("utf-8", errors="replace").rstrip())
        except Exception:
            pass

    def _error_tail(self) -> str:
        return "\n".join(self._errors[-8:])

    def write(self, rgb) -> None:
        frame = np.ascontiguousarray(rgb, dtype=np.uint8)
        if frame.ndim != 3 or frame.shape[0] != self.height or frame.shape[1] != self.width \
                or frame.shape[2] != 3:
            raise RuntimeError(f"编码器收到形状不对的帧 {tuple(frame.shape)}，"
                               f"期望 ({self.height}, {self.width}, 3)")
        if self._av_stream is not None:
            import av

            video_frame = av.VideoFrame.from_ndarray(frame, format="rgb24")
            video_frame.pts = self._av_index
            video_frame.time_base = self._av_stream.time_base
            self._av_index += 1
            for packet in self._av_stream.encode(video_frame):
                self._av.mux(packet)
            return
        try:
            self._proc.stdin.write(frame.tobytes())
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise RuntimeError(f"ffmpeg 编码进程中途挂了:\n{self._error_tail()}\n{exc}")

    def close(self) -> None:
        if self._av_stream is not None:
            for packet in self._av_stream.encode():
                self._av.mux(packet)
            self._av.close()
            return
        proc = self._proc
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except OSError:
            pass
        try:
            rc = proc.wait(timeout=300)
        finally:
            try:
                proc.stderr.close()
            except OSError:
                pass
        if rc != 0:
            raise RuntimeError(f"ffmpeg 编码进程退出码 {rc}:\n{self._error_tail()}")
        self._cleanup_audio_wav()

    def abort(self) -> None:
        if self._av_stream is not None:
            try:
                self._av.close()
            except Exception:
                pass
            return
        proc = self._proc
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except Exception:
                pass
        self._cleanup_audio_wav()

    def _cleanup_audio_wav(self) -> None:
        wav, self._audio_wav = getattr(self, "_audio_wav", None), None
        if wav is not None:
            try:
                wav.unlink(missing_ok=True)
            except OSError:
                pass


def _mux_audio(video_only: Path, source: str, ffmpeg: str) -> Path:
    from folder_paths import get_temp_directory

    output = Path(get_temp_directory()) / f"banzhang_dlss5fg_{uuid.uuid4().hex}_muxed.mp4"
    if str(source).lower().endswith(".wav"):
        audio_opts = ["-c:a", "aac", "-af", "apad", "-shortest"]
    else:
        audio_opts = ["-c:a", "copy"]
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_only), "-i", str(source),
        "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "1",
        "-c:v", "copy", *audio_opts, str(output),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0 or not output.is_file():
        raise RuntimeError(result.stderr.strip()[-400:] or "ffmpeg 音频合并失败")
    return output


def build_video(images: torch.Tensor, fps, audio_input=None, source_video=None):
    """用处理好的帧拼一个 ComfyUI VIDEO 对象 -> (VIDEO 或 None, 说明文字)。"""
    images = images.detach().cpu()
    if not images.is_contiguous():
        images = images.contiguous()
    if images.numel() and (float(images.min()) < 0.0 or float(images.max()) > 1.0):
        images.clamp_(0.0, 1.0)

    video_obj, _ = _video_from_components(images, fps, audio_input)
    if video_obj is not None:
        return video_obj, "内存 VIDEO 对象（音轨已带上）"

    from folder_paths import get_temp_directory

    temp_path = Path(get_temp_directory()) / f"banzhang_dlss5fg_{uuid.uuid4().hex}.mp4"
    _encode_with_pyav(images, fps, temp_path)

    audio_note = "无音轨"
    if audio_input is not None:
        ffmpeg = _find_ffmpeg()
        source = audio_source_path(audio_input, source_video)
        wav = None
        if ffmpeg and not source:
            wav = _audio_to_wav(audio_input)
            source = str(wav) if wav else None
        if ffmpeg and source:
            try:
                muxed = _mux_audio(temp_path, source, ffmpeg)
                if muxed != temp_path:
                    temp_path.unlink(missing_ok=True)
                    temp_path = muxed
                audio_note = ("音轨从源文件直拷贝" if wav is None else "音轨由 AUDIO 输入重编码")
            except Exception as exc:
                audio_note = f"音轨合并失败({exc})，输出只有画面"
        else:
            audio_note = "音轨丢了（找不到 ffmpeg 或源文件）"
        if wav is not None:
            try:
                wav.unlink(missing_ok=True)
            except OSError:
                pass

    video_obj = video_from_file(temp_path)
    note = f"临时文件 {temp_path}（{audio_note}）"
    if video_obj is None:
        note = f"当前 ComfyUI 版本没有 VIDEO 类型，结果已写到 {temp_path}（{audio_note}）"
    return video_obj, note
