# -*- coding: utf-8 -*-
"""DLSS5 帧生成插帧 —— 引擎层（worker 管道协议 + 插帧级联调度）

通过管道驱动外部的 dlssg-worker.exe（MIT 协议，非 NVIDIA 文件），
由它调用 NVIDIA NGX 的 DLSS 帧生成（DLSS-FG）。

运行帧交换协议（与上游一致，2026-09 在 RTX 4090 上验证）：
    setup  "<5I"   0x31534746 宽 高 输入帧数 每区间生成帧数
    reply  "<4I"   0x31524746 状态 最大倍增-1 保留
    frame  "<4I2q" 0x31464746 序号 是否重置 0 时间戳分子 时间戳分母
                   + RGBA8 画面 + f16 运动向量
    reply  "<4I"   0x314F4746 状态 生成帧数 是否停用 + 生成帧 * RGBA8

帧语义：处理输入的第 i 帧时，产出的是 (i-1, i) 这段区间的插值帧。
最后一段区间没有"下一帧"可插，所以 2 倍输出恰好是 2T-1 帧、帧率恰好翻倍。

来源：MIT 协议的 ComfyUI-RH-DLSS5 (RH-RunningHub/ComfyUI-RH-DLSS5)，
      其 worker 协议源自 Merserk 一系。
2026-10-07 并入班长全家桶：删除 Linux/Wine 分支，Windows 原生运行 worker。
"""
from __future__ import annotations

import json
import os
import re
import struct
import subprocess
import threading
import uuid
from collections import deque
from contextlib import closing
from fractions import Fraction
from pathlib import Path

import numpy as np
import torch

from .banzhang_dlss5_fg_media import (
    NvofGuideGenerator, StreamEncoder, TemporalGuideGenerator, build_video, video_from_file,
)


class DLSS5FGError(RuntimeError):
    """会以中文弹给用户看的可执行失败。"""


SETUP_MAGIC = 0x31534746
SETUP_OUT_MAGIC = 0x31524746
FRAME_MAGIC = 0x31464746
FRAME_OUT_MAGIC = 0x314F4746
REPLY_SIZE = struct.calcsize("<4I")
SETUP_SIZE = struct.calcsize("<5I")
FRAME_HEAD_SIZE = struct.calcsize("<4I2q")

WORKER_NAME = "dlssg-worker.exe"
RUNTIME_FILES = ("dlssg-worker.exe", "nvngx.dll", "_nvngx.dll", "nvngx_dlssg.dll")
MULTIPLIERS = {"2倍": 2, "3倍": 3, "4倍": 4}
TARGET_FPS_CHOICES = ["23.976", "24", "25", "29.97", "30", "48", "50",
                      "59.94", "60", "72", "90", "96", "120", "144"]
_FPS_ALIASES = {"23.976": Fraction(24000, 1001), "29.97": Fraction(30000, 1001),
                "59.94": Fraction(60000, 1001)}

_GPU_HINT = ("提示：NVIDIA DLSS 帧生成官方只支持 RTX 40 / RTX 50 系列显卡；"
             "RTX 30 / 20 系可以靠社区补丁 dlssg_for_sm86 用上（见下方说明）。")

_FALLBACK_HINT = ("替代方案：改用不依赖 NGX 的插帧节点（如 "
                  "ComfyUI-Frame-Interpolation 的 RIFE / GMFSS），"
                  "RTX 30 及更早型号可以正常跑。")

# 2026-10-09 实测更正：这句原本写"30 系无解"，错了。社区补丁 dlssg_for_sm86
# （把 d3d12.dll + dlssg_sm86.ini 放进引擎目录）确实能让 30 系跑通 DLSS-FG：
# 本节点的 worker 是 D3D12 程序，会加载同目录的 d3d12.dll，代理正好挂得上。
_NO_OLD_GPU_PATH = ("RTX 30 / 20 系想用上它：放社区补丁 dlssg_for_sm86 的两个文件"
                    "（alternatives\\d3d12.dll 和 dlssg_sm86.ini）到引擎目录"
                    "（ComfyUI\\models\\dlss5\\dlssg\\），重启即可；已在 RTX 3090 实测通过。"
                    "补丁是第三方闭源二进制，介意的话就用「🎞️ RIFE 插帧(全显卡通用)」。")

_MIN_CAPABILITY = (8, 9)


def detect_gpu():
    """返回 (显卡名, 算力)，探测不到就返回 None。

    只用作诊断信息，不做硬性门槛：NGX 走的是 D3D12 适配器枚举，不看
    CUDA_VISIBLE_DEVICES，所以 torch 看到的卡未必就是真正出图的那张。
    最终裁决权始终归 worker 自检。
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        index = torch.cuda.current_device()
        return torch.cuda.get_device_name(index), torch.cuda.get_device_capability(index)
    except Exception:
        return None


def describe_gpu(gpu) -> str:
    """把 (显名名, 算力) 翻成大白话的代次说明。"""
    name, capability = gpu
    major, minor = capability
    if major >= 12:
        label = "RTX 50 系 / Blackwell"
    elif (major, minor) == (8, 9):
        label = "RTX 40 系 / Ada"
    elif major == 8:
        label = "RTX 30 系 / Ampere"
    elif major == 7:
        label = "RTX 20 系 / Turing"
    else:
        return f"{name}（算力 {major}.{minor}）"
    return f"{name}（{label}）"


def as_fps(value) -> Fraction:
    """保持分数精度，把 23.976 / 29.97 / 59.94 这些别名映射成精确的 NTSC 分数。"""
    if isinstance(value, Fraction):
        return value
    text = str(value).strip()
    return _FPS_ALIASES[text] if text in _FPS_ALIASES else Fraction(text)


def _models_root() -> Path:
    try:
        import folder_paths
        return Path(folder_paths.models_dir)
    except Exception:
        comfy_root = Path(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        return comfy_root / "models"


def find_runtime(override: str = "") -> Path:
    """找到放 dlssg-worker.exe 等 4 个文件的目录。

    顺序：节点上的 引擎目录 → 环境变量 BANZHANG_DLSS5_FG_DIR →
          models/dlss5/dlssg → 插件自带 runtime/dlssg
    """
    candidates = []
    if override and str(override).strip():
        candidates.append(Path(str(override).strip()))
    env_dir = os.environ.get("BANZHANG_DLSS5_FG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.append(_models_root() / "dlss5" / "dlssg")
    candidates.append(Path(os.path.dirname(os.path.abspath(__file__))) / "runtime" / "dlssg")

    recommend = str(_models_root() / "dlss5" / "dlssg")
    for candidate in candidates:
        missing = [n for n in RUNTIME_FILES if not (candidate / n).is_file()]
        if not missing:
            return candidate
    searched = "\n  - ".join(str(c) for c in candidates)
    raise DLSS5FGError(
        "找不到 DLSS 帧生成引擎，以下 4 个文件缺一个或多个：\n"
        f"  {WORKER_NAME}（帧生成宿主程序，MIT 协议）\n"
        f"  nvngx.dll、_nvngx.dll、{RUNTIME_FILES[3]}（NVIDIA 专有，需自备）\n"
        f"推荐放到：{recommend}\n"
        f"已在这些位置找过：\n  - {searched}")


_PROBE_CACHE: dict[str, tuple[float, dict]] = {}

_NGX_ARCH_RE = re.compile(r"snippet is using newer GPU arch (\d+)\s*>\s*(\d+)")
_NGX_ADAPTER_RE = re.compile(r"Adapter \d+:\s*([^,\r\n]+)")


def _unavailable_reason(stderr: str) -> str:
    """从 NGX 自检的 stderr 里还原「为什么不可用」，拿不到线索就返回空串。

    注意不能信 result 里的 detail 字段：那是 worker 写死的套话
    （Direct D3D12 NGX capability query completed.），
    真正的原因只出现在 stderr 的 NGX 日志里。
    """
    arch = _NGX_ARCH_RE.search(stderr)
    if not arch:
        return ""
    need, have = arch.group(1), arch.group(2)
    adapter = _NGX_ADAPTER_RE.search(stderr)
    who = adapter.group(1).strip() if adapter else "当前显卡"
    return (f"原因：引擎要求的显卡架构是 {need}，{who} 的架构是 {have}，"
            f"达不到要求（数字越大越新）。")


def probe_capabilities(runtime: Path) -> dict:
    """跑一次 worker --probe 自检（按目录 + 文件时间缓存）。"""
    key = str(runtime)
    stamp = max((runtime / name).stat().st_mtime for name in RUNTIME_FILES)
    cached = _PROBE_CACHE.get(key)
    if cached and cached[0] == stamp:
        return cached[1]

    try:
        proc = subprocess.Popen(
            [str(runtime / WORKER_NAME), "--probe"],
            cwd=str(runtime), env=os.environ.copy(),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, text=True, encoding="utf-8", errors="replace",
        )
    except OSError as exc:
        raise DLSS5FGError(f"无法启动帧生成宿主程序 {WORKER_NAME}：{exc}")
    try:
        stdout, stderr = proc.communicate(timeout=120)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise DLSS5FGError("帧生成自检超时（120 秒没回话）。")

    if proc.returncode:
        detail = (stderr or stdout).strip() or f"退出码 {proc.returncode}"
        raise DLSS5FGError(f"帧生成自检失败：\n{detail[-1500:]}\n{_GPU_HINT}")
    lines = [line for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise DLSS5FGError("帧生成自检没有任何输出。")
    try:
        result = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise DLSS5FGError(f"帧生成自检返回的内容不是 JSON：{exc}")
    if isinstance(result, dict) and not result.get("available"):
        reason = _unavailable_reason(stderr or "")
        if reason:
            result["reason"] = reason
    _PROBE_CACHE[key] = (stamp, result)
    return result


class _StderrDrain(threading.Thread):
    """后台收集 worker 的 stderr，出错时能贴出最后几行。"""

    def __init__(self, stream) -> None:
        super().__init__(daemon=True)
        self.lines: deque[str] = deque(maxlen=80)
        self._stream = stream

    def run(self) -> None:
        for raw in iter(self._stream.readline, b""):
            try:
                self.lines.append(raw.decode("utf-8", errors="replace").rstrip())
            except Exception:
                pass

    def tail(self, count: int = 12) -> str:
        return "\n".join(list(self.lines)[-count:])


class FGSession:
    """一次 dlssg-worker.exe 会话（固定分辨率与帧数）。"""

    def __init__(self, runtime: Path, width: int, height: int, frame_count: int,
                 generated_count: int) -> None:
        self.width = int(width)
        self.height = int(height)
        self.frame_bytes = self.width * self.height * 4
        self.generated_count = int(generated_count)
        self._closed = False
        try:
            self.proc = subprocess.Popen(
                [str(runtime / WORKER_NAME), "--serve"],
                cwd=str(runtime), env=os.environ.copy(),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            raise DLSS5FGError(f"无法启动帧生成宿主程序：{exc}")
        self.drain = _StderrDrain(self.proc.stderr)
        self.drain.start()
        try:
            self.proc.stdin.write(struct.pack("<5I", SETUP_MAGIC, self.width, self.height,
                                              max(1, int(frame_count)), self.generated_count))
            self.proc.stdin.flush()
            magic, status, maximum, _reserved = struct.unpack("<4I", self._read(REPLY_SIZE))
        except Exception as exc:
            self.close()
            raise DLSS5FGError(f"与帧生成宿主握手失败：\n{self.drain.tail()}\n{exc}")
        if magic != SETUP_OUT_MAGIC or status:
            self.close()
            raise DLSS5FGError(
                f"帧生成会话被拒绝（状态码 {status}），"
                f"当前运行时最多支持 {maximum + 1} 倍。\n{self.drain.tail()}\n{_GPU_HINT}")
        if self.generated_count > maximum:
            self.close()
            raise DLSS5FGError(
                f"当前运行时最多支持 {maximum + 1} 倍插帧，你要的是 "
                f"{self.generated_count + 1} 倍。")

    def _read(self, count: int) -> bytes:
        data = bytearray()
        while len(data) < count:
            block = self.proc.stdout.read(count - len(data))
            if not block:
                raise DLSS5FGError(
                    f"帧生成宿主程序提前关闭了输出：\n{self.drain.tail()}")
            data.extend(block)
        return bytes(data)

    def process_frame(self, rgba: np.ndarray, motion: np.ndarray, timestamp: Fraction,
                      reset: bool, index: int) -> list[np.ndarray]:
        if self._closed:
            raise DLSS5FGError("帧生成会话已经关闭。")
        color = np.ascontiguousarray(rgba, dtype=np.uint8)
        vectors = np.ascontiguousarray(motion, dtype=np.float16)
        if color.shape != (self.height, self.width, 4):
            raise DLSS5FGError(f"画面帧形状不对：{color.shape}")
        if vectors.shape != (self.height, self.width, 2):
            raise DLSS5FGError(f"运动向量形状不对：{vectors.shape}")
        try:
            self.proc.stdin.write(struct.pack("<4I2q", FRAME_MAGIC, index, 1 if reset else 0, 0,
                                              int(timestamp.numerator), int(timestamp.denominator)))
            self.proc.stdin.write(memoryview(color).cast("B"))
            self.proc.stdin.write(memoryview(vectors).cast("B"))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise DLSS5FGError(f"第 {index} 帧写入宿主程序失败：\n{self.drain.tail()}\n{exc}")
        magic, status, generated, disabled = struct.unpack("<4I", self._read(REPLY_SIZE))
        if magic != FRAME_OUT_MAGIC or status:
            raise DLSS5FGError(f"第 {index} 帧生成失败（状态码 {status}）：\n{self.drain.tail()}")
        if disabled:
            return []
        return [np.frombuffer(self._read(self.frame_bytes), np.uint8)
                .reshape(self.height, self.width, 4).copy() for _ in range(generated)]

    def close(self) -> None:
        if getattr(self, "_closed", False):
            return
        self._closed = True
        proc = getattr(self, "proc", None)
        if proc is None:
            return
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                    proc.wait(timeout=5)
                except Exception:
                    pass
        for stream in (proc.stdout, proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass


# ==============================================================================
# 注：目标是输出列表时，源帧直接复用原始 float 值，不经过 uint8 往返，
# 避免 2 倍时源帧画质被量化。
# ==============================================================================

def _guide_generator(width: int, height: int, motion_mode: str, threshold: float):
    """按模式挑光流生成器 -> (生成器, 实际用到的引擎名)。"""
    if motion_mode in ("auto", "nvof"):
        try:
            guide = NvofGuideGenerator(width, height, threshold)
            if guide.available or motion_mode == "nvof":
                return guide, "nvof"
            print(f"[班长DLSS5插帧] 硬件光流不可用({guide.init_error})，"
                  f"改用软件光流", flush=True)
        except Exception:
            if motion_mode == "nvof":
                raise
    return TemporalGuideGenerator(width, height, threshold), "dis"


def _frame_to_rgba(frame: torch.Tensor) -> np.ndarray:
    rgb = frame.detach().cpu().numpy()
    rgb = np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)
    alpha = np.full((rgb.shape[0], rgb.shape[1], 1), 255, np.uint8)
    return np.ascontiguousarray(np.concatenate([rgb, alpha], axis=2))


def _image_source(images: torch.Tensor):
    def source(index: int):
        frame = images[index].detach().cpu().to(torch.float32)
        return _frame_to_rgba(frame), frame
    return source


def _rgb_source(rgb: np.ndarray):
    def source(index: int):
        rgba = np.empty((rgb.shape[1], rgb.shape[2], 4), dtype=np.uint8)
        rgba[..., :3] = rgb[index]
        rgba[..., 3] = 255
        return rgba, None
    return source


def _rgba_source(cur: np.ndarray):
    def source(index: int):
        return cur[index], None
    return source


def _plan(src_fps, multiplier: int, target_fps):
    """决定 2 倍级联层数与最终时间线 -> (层数, 输出帧率, 精确倍率)。"""
    src_fps = as_fps(src_fps)
    if src_fps <= 0:
        raise DLSS5FGError("源视频帧率必须大于 0。")
    if target_fps is not None:
        target_fps = as_fps(target_fps)
        if target_fps <= src_fps:
            raise DLSS5FGError(
                f"目标帧率 {float(target_fps):g} 必须高于源帧率 {float(src_fps):g}，"
                f"插帧只能把帧率变高。")
        if target_fps > src_fps * 6:
            raise DLSS5FGError(
                f"目标帧率 {float(target_fps):g} 超过源帧率的 6 倍，不支持。")
        stages = 0
        while src_fps * (2 ** stages) < target_fps:
            stages += 1
        return stages, target_fps, None
    if multiplier not in (2, 3, 4):
        raise DLSS5FGError("支持的倍率只有 2 / 3 / 4 倍。")
    stages = {2: 1, 3: 2, 4: 2}[multiplier]
    return stages, src_fps * multiplier, multiplier


def _unavailable_message(probe: dict) -> str:
    """自检说不可用时，拼一条能直接指导下一步的中文报错。

    分三种情形，因为对用户的含义完全不同：
      ① 显卡够格 -> 问题在引擎文件/驱动/杀毒，可修；
      ② 显卡不够格 -> 硬件代次问题，无解，别白折腾；
      ③ 显卡探测不到 -> 退回 NGX 日志里的架构线索。
    """
    gpu = detect_gpu()
    if gpu is not None and gpu[1] >= _MIN_CAPABILITY:
        detail = probe.get("detail") or probe
        return (f"显卡本身够格：{describe_gpu(gpu)}，但引擎自检没通过：{detail}\n"
                f"排查方向：\n"
                f"  1. 确认 models/dlss5/dlssg 下 4 个文件齐全且版本互相匹配；\n"
                f"  2. 更新 NVIDIA 显卡驱动；\n"
                f"  3. 检查杀毒软件是否拦截了 dlssg-worker.exe。")
    if gpu is not None:
        return (f"这台机器的显卡不支持 DLSS 帧生成：{describe_gpu(gpu)}。\n"
                f"{_GPU_HINT}\n{_NO_OLD_GPU_PATH}\n{_FALLBACK_HINT}")
    reason = probe.get("reason")
    if reason:
        return f"这台机器上的 DLSS 帧生成不可用。\n{reason}\n{_GPU_HINT}\n{_FALLBACK_HINT}"
    detail = probe.get("detail") or probe
    return f"这台机器上的 DLSS 帧生成不可用：{detail}\n{_GPU_HINT}\n{_FALLBACK_HINT}"


def _prepare(src_fps, width: int, height: int, frames_count: int, runtime_dir: str):
    """两个入口共用的校验：帧数、runtime、显卡可用性、偶数尺寸。"""
    if frames_count < 2:
        raise DLSS5FGError("插帧至少需要 2 帧。")
    if width % 2 or height % 2:
        raise DLSS5FGError(f"插帧要求宽高都是偶数，当前是 {width}x{height}。")
    runtime = find_runtime(runtime_dir)
    probe = probe_capabilities(runtime)
    if not probe.get("available"):
        raise DLSS5FGError(_unavailable_message(probe))
    src_fps = as_fps(src_fps)
    if src_fps <= 0:
        raise DLSS5FGError(f"源帧率无效：{src_fps}")
    return runtime, src_fps


def _stage_frames(sources, count: int, runtime: Path, stage_fps: Fraction,
                  threshold: float, motion_mode: str, progress, engine_out=None):
    """一次 2 倍插帧：按时间顺序产出每个区间的生成帧 + 源帧。"""
    first_rgba, first_float = sources(0)
    height, width = first_rgba.shape[:2]
    guide, engine = _guide_generator(width, height, motion_mode, threshold)
    if engine_out is not None:
        engine_out.append(engine)
    zero = np.zeros((height, width, 2), np.float16)
    previous = (first_rgba, first_float)
    session = FGSession(runtime, width, height, count, 1)
    try:
        for index in range(count):
            if index == 0:
                rgba, src_float = first_rgba, first_float
            else:
                rgba, src_float = sources(index)
            motion, reset = guide.process(rgba[..., :3])
            if index == 0:
                reset = True
            if reset:
                motion = zero
            got = session.process_frame(rgba, motion, Fraction(index, 1) / stage_fps,
                                        reset, index)
            if index:
                # 切镜时不插AI帧，改为重复上一帧，绝不跨镜头混画面
                yield (got[0], None) if got and not reset else previous
            yield rgba, src_float
            previous = (rgba, src_float)
            if progress is not None:
                progress(index + 1, count)
    finally:
        session.close()


def _pick_indices(grid_count: int, grid_rate: Fraction, target_rate: Fraction) -> list[int]:
    """把目标帧率的时间点映射到更密的级联网格上（最近邻取样，不重复帧）。"""
    count = int(Fraction(grid_count - 1, 1) / grid_rate * target_rate) + 1
    indices = []
    tie_late = False
    for k in range(count):
        pos = Fraction(k, 1) / target_rate * grid_rate
        lower = pos.numerator // pos.denominator
        remainder = pos - lower
        if remainder < Fraction(1, 2):
            index = lower
        elif remainder > Fraction(1, 2):
            index = lower + 1
        else:
            index = lower + int(tie_late)
            tie_late = not tie_late
        indices.append(max(0, min(index, grid_count - 1)))
    return indices


def _stage_buffer_path():
    """级联中间网格的磁盘暂存。

    不用 /tmp：容器里那里常是 tmpfs，等于把"磁盘"缓冲放回内存。
    """
    try:
        from folder_paths import get_temp_directory
        d = Path(get_temp_directory())
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        import tempfile
        d = Path(tempfile.mkdtemp(prefix="banzhang_dlss5fg_"))
    return d / f"banzhang_dlss5fg_{uuid.uuid4().hex}.raw"


def cascade_frames(sources, count: int, runtime, src_fps, stages, out_fps,
                   threshold, motion_mode, progress_callback, engines):
    """多级 2 倍级联：非最终级写磁盘暂存，最终级边生成边取样输出。

    3/4 倍的中间网格如果全放内存，4K 长片会到上百 GB 直接 OOM；
    改成只读 memmap，脏页缓存就不会攒下一整级。
    """
    total = sum((count - 1) * 2 ** stage + 1 for stage in range(stages))
    done = 0
    scratch: list[Path] = []

    def progress(current, _total):
        if progress_callback is not None:
            progress_callback(done + current, total)

    try:
        for stage in range(stages):
            grid_count = 2 * count - 1
            frames = _stage_frames(sources, count, runtime, src_fps * 2 ** stage,
                                   threshold, motion_mode, progress, engines)
            with closing(frames):
                if stage == stages - 1:
                    picks = iter(_pick_indices(grid_count, src_fps * 2 ** stages, out_fps))
                    wanted = next(picks, None)
                    for index, item in enumerate(frames):
                        if index == wanted:
                            yield item
                            wanted = next(picks, None)
                else:
                    spill = None
                    written = 0
                    for _index, (rgba, _) in enumerate(frames):
                        if spill is None:
                            spill = _stage_buffer_path()
                            scratch.append(spill)
                            fh = open(spill, "wb")
                            shape = rgba.shape
                        fh.write(np.ascontiguousarray(rgba).tobytes())
                        written += 1
                    if spill is None:
                        raise DLSS5FGError("级联某一级没有产出任何帧")
                    fh.close()
                    if written != grid_count:
                        raise DLSS5FGError(
                            f"级联某一级写出 {written} 帧，预期 {grid_count} 帧")
                    buffer = np.memmap(str(spill), dtype=np.uint8, mode="r",
                                       shape=(grid_count, *shape))
                    sources = _rgba_source(buffer)
            done += count
            count = grid_count
    finally:
        for p in scratch:
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass


def interpolate_frames(images: torch.Tensor, src_fps, multiplier: int, motion_mode="auto",
                       scene_threshold=0.24, runtime_dir="", progress_callback=None,
                       target_fps=None):
    """图像批次插帧 -> (结果张量, 输出帧率, 说明)。

    输出帧数 = floor((输入帧数 - 1) * 输出帧率 / 源帧率) + 1，不额外补尾巴。
    """
    if images.ndim != 4 or images.shape[-1] != 3:
        raise DLSS5FGError("插帧要求输入是 (帧数, 高, 宽, 3) 的图像批次。")
    count, height, width, _ = images.shape
    stages, out_fps, _ = _plan(src_fps, multiplier, target_fps)
    runtime, src_fps = _prepare(src_fps, width, height, count, runtime_dir)
    out_count = int((count - 1) * out_fps / src_fps) + 1
    result = torch.empty((out_count, height, width, 3), dtype=torch.float32)
    engines = []
    frames = cascade_frames(_image_source(images), count, runtime, src_fps, stages,
                            out_fps, scene_threshold, motion_mode, progress_callback, engines)
    with closing(frames):
        for index, (rgba, original) in enumerate(frames):
            if original is not None:
                result[index] = original
            else:
                result[index] = torch.from_numpy(rgba[..., :3].astype(np.float32) * (1.0 / 255.0))
    note = f"光流={engines[0] if engines else 'none'}，{count}->{out_count} 帧，" \
           f"{float(src_fps):g}->{float(out_fps):g}fps，{2 ** stages}x 网格"
    return result, out_fps, note


def interpolate_stream_from_source(sources, count: int, width: int, height: int, src_fps,
                                   multiplier: int, motion_mode="auto", scene_threshold=0.24,
                                   runtime_dir="", progress_callback=None, frame_sink=None,
                                   target_fps=None):
    """边插帧边把结果交给 frame_sink（通常是编码器），不全片堆内存。"""
    if frame_sink is None:
        raise DLSS5FGError("流式插帧需要一个 frame_sink 回调。")
    stages, out_fps, _ = _plan(src_fps, multiplier, target_fps)
    runtime, src_fps = _prepare(src_fps, width, height, count, runtime_dir)
    engines = []
    frames = cascade_frames(sources, count, runtime, src_fps, stages,
                            out_fps, scene_threshold, motion_mode, progress_callback, engines)
    emitted = 0
    with closing(frames):
        for rgba, _ in frames:
            frame_sink(np.ascontiguousarray(rgba[..., :3]))
            emitted += 1
    note = f"光流={engines[0] if engines else 'none'}，{count}->{emitted} 帧，" \
           f"{float(src_fps):g}->{float(out_fps):g}fps，{2 ** stages}x 网格"
    return out_fps, note


def interpolate_stream(rgb, src_fps, multiplier: int, motion_mode="auto",
                       scene_threshold=0.24, runtime_dir="", progress_callback=None,
                       frame_sink=None, target_fps=None):
    """已解码的 uint8 批次 -> 流式插帧 + 流式编码。"""
    if frame_sink is None:
        raise DLSS5FGError("流式插帧需要一个 frame_sink 回调。")
    if rgb.ndim != 4 or rgb.shape[-1] != 3:
        raise DLSS5FGError("插帧要求输入是 (帧数, 高, 宽, 3) 的图像批次。")
    count, height, width, _ = rgb.shape
    return interpolate_stream_from_source(
        _rgb_source(rgb), count, width, height, src_fps, multiplier,
        motion_mode=motion_mode, scene_threshold=scene_threshold,
        runtime_dir=runtime_dir, progress_callback=progress_callback,
        frame_sink=frame_sink, target_fps=target_fps)


def source_path_of(video) -> str | None:
    """VIDEO 对象背后可直拷贝音轨的文件路径，没有就返回 None。"""
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


__all__ = [
    "DLSS5FGError", "MULTIPLIERS", "TARGET_FPS_CHOICES", "StreamEncoder",
    "as_fps", "build_video", "cascade_frames", "find_runtime", "interpolate_frames",
    "interpolate_stream", "interpolate_stream_from_source", "probe_capabilities",
    "source_path_of", "video_from_file",
]
