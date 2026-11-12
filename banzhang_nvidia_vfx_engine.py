# -*- coding: utf-8 -*-
"""引擎层：调用 NVIDIA RTX 视频特效 SDK（nvidia-vfx）

只负责"怎么调用显卡"，不含任何 ComfyUI 节点参数。节点层见
banzhang_nvidia_vfx.py。

硬门槛：
    - NVIDIA 带 Tensor Core 的显卡（RTX 20 系 / Turing 及以上），驱动 ≥ 570.65；
      其中「RTX 视频插帧」只支持 RTX 40 / 50 系。
    - CUDA 版 PyTorch（ComfyUI 官方 CUDA 整合包即可）。
    - 依赖 nvidia-vfx：公共 PyPI 只有 4.8KB 空壳包，真 wheel 必须走 NVIDIA 官方源：
          python_embeded\\python.exe -m pip install nvidia-vfx --extra-index-url https://pypi.nvidia.com
      插件启动时会自动装；也可把 wheel 放进 wheels/ 目录做离线安装（见 ensure_sdk）。

改编自 Apache-2.0 协议的 Comfy-Org/ComfyUI_Nvidia_VFX_Nodes，
2026-10-09 并入班长全家桶。
"""
import math
import os
import subprocess
import sys
from importlib import import_module, invalidate_caches

import numpy as np
import torch
import torch.nn.functional as F

_PACKAGE = "nvidia-vfx"
# 公共 PyPI（含华为/清华/中科大等镜像）上只有 4.8KB 的空壳包，真 wheel（约 400MB，
# 内含 NVIDIA VFX SDK 全部 DLL）只在 NVIDIA 官方源发布，所以必须显式带这个源。
_NVIDIA_INDEX = "https://pypi.nvidia.com"
# 想自己掌控依赖的人，设这个环境变量就能关掉自动安装：BANZHANG_NO_AUTO_PIP=1
_NO_AUTO_PIP_ENV = "BANZHANG_NO_AUTO_PIP"
_INSTALL_TIMEOUT = 1800  # 30 分钟：包有 400MB 左右，慢网也要给够时间

try:
    import nvvfx
except ImportError:  # 依赖没装：节点层会据此给出中文提示，而不是崩在导入阶段
    nvvfx = None

# 一次最多让显卡算 1600 万像素，超了就分批处理，防止爆显存
MAX_BATCH_PIXELS = 1024 * 1024 * 16

# 超分档位：中文显示名 → SDK 内部名。
# 档位分四组，选错等于白跑：
#   常规放大      = 有压缩痕迹的片源（大部分视频/下载图）
#   降噪          = 只去噪点，不改尺寸
#   去模糊        = 只锐化，不改尺寸
#   高清片源      = 干净无损片源，不会多余地抹掉细节
#   直播流        = 摄像头/直播画面
QUALITY_LEVELS = {
    "常规放大·极速": "LOW",
    "常规放大·均衡": "MEDIUM",
    "常规放大·高质": "HIGH",
    "常规放大·极致": "ULTRA",
    "降噪·轻度": "DENOISE_LOW",
    "降噪·中度": "DENOISE_MEDIUM",
    "降噪·强力": "DENOISE_HIGH",
    "降噪·极致": "DENOISE_ULTRA",
    "去模糊·轻度": "DEBLUR_LOW",
    "去模糊·中度": "DEBLUR_MEDIUM",
    "去模糊·强力": "DEBLUR_HIGH",
    "去模糊·极致": "DEBLUR_ULTRA",
    "高清片源·极速": "HIGHBITRATE_LOW",
    "高清片源·均衡": "HIGHBITRATE_MEDIUM",
    "高清片源·高质": "HIGHBITRATE_HIGH",
    "高清片源·极致": "HIGHBITRATE_ULTRA",
    "直播流·均衡": "STREAMING_MEDIUM",
    "直播流·极致": "STREAMING_ULTRA",
    "纯插值放大(不用AI)": "BICUBIC",
}

# 插帧画质档
FRAME_MODES = {"低": "LOW", "中": "MEDIUM", "高": "HIGH"}

# 像素精度：10 位比 8 位多保留一档明暗层次，但不会把普通画面变成 HDR
ENCODINGS = {"8位": "RGB8", "10位(更精细)": "RGB10A2"}

# 输出色彩空间
HDR_COLORSPACES = {"HDR(HLG,电视通用)": "HLG", "HDR(PQ,电影常用)": "PQ"}


class NvidiaVFXError(RuntimeError):
    """给用户看的中文报错。"""


def sdk_available() -> bool:
    return nvvfx is not None


def _local_wheels() -> list:
    """插件包 wheels/ 目录里预置的离线 wheel（打包分发时用，断网也能装）。"""
    import glob
    here = os.path.dirname(os.path.abspath(__file__))
    wheels = glob.glob(os.path.join(here, "wheels", "nvidia_vfx-*.whl"))
    # 同环境有多个 wheel 时优先版本号大的（文件名排序即可）
    return sorted(wheels, reverse=True)


def _pip_install(args: list) -> tuple:
    """跑一次 pip，返回 (成功?, 输出尾部)。"""
    cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir"] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                timeout=_INSTALL_TIMEOUT)
    except Exception as exc:  # 连 pip 都没跑起来（权限/被杀毒拦截等）
        return False, f"pip 启动失败：{exc}"
    tail = (result.stdout or "") + (result.stderr or "")
    return result.returncode == 0, tail[-1000:]


def ensure_sdk() -> bool:
    """缺依赖就自动装一次，装好立刻生效（不用重启 ComfyUI）。

    三级安装策略，保证别人拿到插件包也能装上：
      1) wheels/ 目录里有离线 wheel → 直接本地安装（完全断网也行，最稳）；
      2) NVIDIA 官方源（真 wheel 只在这里发布，公共 PyPI 只有空壳）；
      3) 公共 PyPI 兜底（环境已配好源时可能直接成功）。
    不想自动装的，设环境变量 BANZHANG_NO_AUTO_PIP=1 即可。
    """
    global nvvfx
    if nvvfx is not None:
        return True
    if str(os.environ.get(_NO_AUTO_PIP_ENV, "")).strip().lower() in ("1", "true", "yes", "on"):
        return False

    print(f"[班长全家桶] 首次启用 RTX 视频特效，正在自动安装依赖 {_PACKAGE}"
          f"（约 400MB，需要几分钟，只此一次）...")

    # 安装尝试：(说明, pip 参数)。能走到这里说明 import nvvfx 已经失败，
    # 用 --force-reinstall 把“装了同名空壳/装坏了”的情况也一并覆盖。
    attempts = []
    for wheel in _local_wheels():
        attempts.append((f"离线 wheel：{os.path.basename(wheel)}",
                         ["--force-reinstall", "--no-deps", wheel]))
    attempts.append(
        (f"NVIDIA 官方源 {_NVIDIA_INDEX}",
         ["--force-reinstall", "--no-deps", _PACKAGE,
          "--extra-index-url", _NVIDIA_INDEX])
    )
    attempts.append(("公共 PyPI（当前环境配置的源）",
                     ["--force-reinstall", _PACKAGE]))

    last_tail = ""
    for label, args in attempts:
        print(f"[班长全家桶] 尝试安装途径：{label}")
        ok, tail = _pip_install(args)
        last_tail = tail
        if not ok:
            print(f"[班长全家桶] 该途径失败：{tail[-400:]}")
            continue
        invalidate_caches()
        try:
            nvvfx = import_module("nvvfx")
            print(f"[班长全家桶] RTX 视频特效依赖装好了（{label}），三个节点可以直接用。")
            return True
        except ImportError as exc:
            print(f"[班长全家桶] 装完了但仍然导入失败：{exc}")

    # 可能装到了空壳包，或装完没导入成功，统一给人话提示
    print(f"[班长全家桶] 自动安装依赖失败：\n{last_tail}")
    _print_install_help()
    return False


def _print_install_help() -> None:
    print("[班长全家桶] RTX 视频特效依赖安装办法（任选一个）："
          f"\n  1) 双击插件目录里的 Install_RTX_VFX_Deps.bat（自动优先用 wheels/ 离线包，再试 NVIDIA 官方源）"
          f"\n  2) 联网手动执行（注意必须带 NVIDIA 官方源，公共 PyPI 只有空壳）："
          f"\n       {sys.executable} -m pip install {_PACKAGE} --extra-index-url {_NVIDIA_INDEX}"
          f"\n  3) 完全离线：把 nvidia_vfx 对应版本的 .whl 放进插件目录 wheels/ 文件夹，再执行第 1 步"
          f"\n  装不上也不影响：其余节点照常使用，只是这三个节点不出现。")


def require_sdk() -> None:
    if nvvfx is None:
        raise NvidiaVFXError(
            "没有装 nvidia-vfx。请在 ComfyUI 目录下执行："
            "python_embeded\\python.exe -m pip install nvidia-vfx ，然后重启 ComfyUI。")


def get_effect_device():
    """用 ComfyUI 当前选择的显卡。"""
    import comfy.model_management as mm

    device = mm.get_torch_device()
    if device.type != "cuda":
        raise NvidiaVFXError(
            "RTX 视频特效必须用 NVIDIA 显卡跑，当前 ComfyUI 用的不是 CUDA 设备。")
    index = device.index if device.index is not None else torch.cuda.current_device()
    return device, index


# ------------------------------------------------------------------ 像素格式

def pack_rgb10a2(image: torch.Tensor) -> torch.Tensor:
    """把 0~1 的 RGB 打包成 SDK 要的 10 位 RGB10A2。"""
    rgb = image.clamp(0.0, 1.0).mul(1023.0).round().to(torch.int32)
    packed = rgb[..., 0] | (rgb[..., 1] << 10) | (rgb[..., 2] << 20) | -1073741824
    return packed.view(torch.uint32).contiguous()


def unpack_rgb10a2(packed: torch.Tensor) -> torch.Tensor:
    packed = packed.view(torch.int32)
    red = packed.bitwise_and(0x3FF)
    green = packed.bitwise_right_shift(10).bitwise_and(0x3FF)
    blue = packed.bitwise_right_shift(20).bitwise_and(0x3FF)
    return torch.stack((red, green, blue), dim=-1).to(torch.float32).div_(1023.0)


def prepare_frame(image: torch.Tensor, device, encoding: str) -> torch.Tensor:
    image = image.to(device=device, dtype=torch.float32)
    if encoding == "RGB10A2":
        return pack_rgb10a2(image)
    return image.movedim(-1, 0).contiguous()


def copy_effect_output(dlpack_output, destination: torch.Tensor, encoding: str) -> None:
    """SDK 的结果必须立刻复制出来，否则下一次推理会把上一帧覆盖掉。"""
    output = torch.from_dlpack(dlpack_output).clone()
    if encoding == "RGB10A2":
        output = unpack_rgb10a2(output)
    else:
        output = output.movedim(0, -1)
    destination.copy_(output)


# ------------------------------------------------------------- HDR 色彩转换

PQ_M1 = 2610 / 16384
PQ_M2 = 2523 / 4096 * 128
PQ_C1 = 3424 / 4096
PQ_C2 = 2413 / 4096 * 32
PQ_C3 = 2392 / 4096 * 32

HLG_A = 0.17883277
HLG_B = 1 - 4 * HLG_A
HLG_C = 0.5 - HLG_A * math.log(4 * HLG_A)


def pq_to_hlg(image: torch.Tensor, peak_luminance: float) -> torch.Tensor:
    """把 SDK 输出的 PQ 信号按目标峰值亮度转成 HLG。"""
    pq = image.clamp(0.0, 1.0).pow(1.0 / PQ_M2)
    display_light = ((pq.sub(PQ_C1).clamp_min(0.0) / (PQ_C2 - PQ_C3 * pq))
                     ** (1.0 / PQ_M1)) * 10000.0
    display_light.clamp_(max=peak_luminance)

    luminance = (0.2627 * display_light[..., 0]
                 + 0.6780 * display_light[..., 1]
                 + 0.0593 * display_light[..., 2])
    gamma = 1.2 + 0.42 * math.log10(peak_luminance / 1000.0)
    ratio = (luminance / peak_luminance).clamp_min(torch.finfo(display_light.dtype).eps)
    scene_light = (display_light / peak_luminance) * ratio.unsqueeze(-1).pow((1.0 - gamma) / gamma)
    scene_light.clamp_(0.0, 1.0)

    low = torch.sqrt(3.0 * scene_light)
    high = HLG_A * torch.log((12.0 * scene_light - HLG_B).clamp_min(1e-6)) + HLG_C
    return torch.where(scene_light <= 1.0 / 12.0, low, high)


# ------------------------------------------------------------------ 内部工具

def _split_alpha(images: torch.Tensor):
    alpha = images[..., 3:4] if images.shape[-1] > 3 else None
    return images[..., :3], alpha


def _tick(progress, done: int, total: int) -> None:
    if progress is not None:
        progress(done, total)


def _plan_output_size(height, width, resize_type, scale, target_w, target_h, sdk_quality):
    """算出最终宽高：降噪/去模糊保持原尺寸（但仍对齐到 8），其余按设置缩放。"""
    if sdk_quality.startswith(("DENOISE_", "DEBLUR_")):
        # 尺寸不变，可 SDK 同样要求 8 的倍数：输入不是 8 的倍数时会直接报错，
        # 所以这里只做对齐、不缩放（最多差几个像素）。
        out_w, out_h = int(width), int(height)
    elif resize_type == "按倍数放大":
        out_w, out_h = int(width * scale), int(height * scale)
    else:
        out_w, out_h = int(target_w), int(target_h)
    return max(8, round(out_w / 8) * 8), max(8, round(out_h / 8) * 8)


# ------------------------------------------------------------ 1. 超分 / 降噪

def super_resolution(images, resize_type="按倍数放大", scale=2.0, width=1920, height=1080,
                     quality="常规放大·极致", strength=1.0, encoding="8位", progress=None):
    """放大 / 降噪 / 去模糊，返回和输入同批次的 IMAGE。"""
    require_sdk()
    images, alpha = _split_alpha(images)
    total, in_h, in_w, channels = images.shape
    sdk_quality = QUALITY_LEVELS[quality]
    sdk_encoding = ENCODINGS[encoding]

    out_w, out_h = _plan_output_size(in_h, in_w, resize_type, scale, width, height, sdk_quality)
    output = torch.empty((total, out_h, out_w, channels), device=images.device, dtype=images.dtype)

    device, index = get_effect_device()
    # 一次喂多少帧：按输出像素算，至少 1 帧
    chunk = max(1, MAX_BATCH_PIXELS // max(1, out_w * out_h))

    with torch.cuda.device(device), nvvfx.VideoSuperRes(
        quality=nvvfx.QualityLevel[sdk_quality],
        strength=strength,
        device=index,
        image_encoding=nvvfx.ImageEncoding[sdk_encoding],
    ) as effect:
        effect.output_width = out_w
        effect.output_height = out_h
        effect.load()

        done = 0
        for start in range(0, total, chunk):
            batch = images[start:start + chunk].to(device=device, dtype=torch.float32)
            if sdk_encoding == "RGB10A2":
                batch = pack_rgb10a2(batch)
            else:
                batch = batch.movedim(-1, 1).contiguous()
            for offset, frame in enumerate(batch):
                copy_effect_output(effect.run(frame).image, output[start + offset], sdk_encoding)
                done += 1
                _tick(progress, done, total)

    if alpha is not None:
        output = torch.cat((output, F.interpolate(
            alpha.movedim(-1, 1), size=(out_h, out_w), mode="bilinear",
            align_corners=False).movedim(1, -1)), dim=-1)

    note = f"{in_w}x{in_h} → {out_w}x{out_h}，共 {total} 帧，档位：{quality}"
    if sdk_quality.startswith(("DENOISE_", "DEBLUR_")):
        note += "（该档位保持原尺寸）"
    return output, note


def plan_output_size(in_h, in_w, resize_type, scale, target_w, target_h, quality):
    """公开版输出尺寸规划：quality 传节点下拉的中文档位名，返回 (out_w, out_h)。"""
    return _plan_output_size(in_h, in_w, resize_type, scale, target_w, target_h,
                             QUALITY_LEVELS[quality])


def super_resolution_stream(frames_iter, total, in_w, in_h, sink,
                            resize_type="按倍数放大", scale=2.0, width=1920, height=1080,
                            quality="常规放大·极致", strength=1.0, encoding="8位",
                            progress=None):
    """流式超分：逐帧吃 uint8 RGB（H,W,3），逐帧把结果 uint8 RGB 喂给 sink。

    与 super_resolution 的区别：效果器只创建一次（保留 SDK 的时序状态，
    不会在批次边界闪烁），内存峰值 = 一个批次，与片长无关，供 VIDEO 输入
    走「边解码边超分边编码」用。返回 (out_w, out_h, note)。
    """
    require_sdk()
    sdk_quality = QUALITY_LEVELS[quality]
    sdk_encoding = ENCODINGS[encoding]
    out_w, out_h = _plan_output_size(in_h, in_w, resize_type, scale, width, height, sdk_quality)

    device, index = get_effect_device()
    # 一次喂多少帧：按输出像素算，至少 1 帧
    chunk = max(1, MAX_BATCH_PIXELS // max(1, out_w * out_h))

    def handle(batch_frames):
        n = len(batch_frames)
        batch = np.stack(batch_frames, axis=0)[..., :3]
        batch = torch.from_numpy(batch).to(device=device, dtype=torch.float32).div_(255.0)
        if sdk_encoding == "RGB10A2":
            batch = pack_rgb10a2(batch)
        else:
            batch = batch.movedim(-1, 1).contiguous()
        output = torch.empty((n, out_h, out_w, 3), device=device, dtype=torch.float32)
        for offset, frame in enumerate(batch):
            copy_effect_output(effect.run(frame).image, output[offset], sdk_encoding)
        out_u8 = output.mul_(255.0).round_().clamp_(0, 255).to(torch.uint8).cpu().numpy()
        for i in range(n):
            sink(np.ascontiguousarray(out_u8[i]))
        return n

    done = 0
    with torch.cuda.device(device), nvvfx.VideoSuperRes(
        quality=nvvfx.QualityLevel[sdk_quality],
        strength=strength,
        device=index,
        image_encoding=nvvfx.ImageEncoding[sdk_encoding],
    ) as effect:
        effect.output_width = out_w
        effect.output_height = out_h
        effect.load()

        buffered = []
        for frame in frames_iter:
            buffered.append(frame)
            if len(buffered) >= chunk:
                done += handle(buffered)
                buffered = []
                _tick(progress, done, total)
        if buffered:
            done += handle(buffered)
            buffered = []
            _tick(progress, done, total)

    note = f"{in_w}x{in_h} → {out_w}x{out_h}，共 {done} 帧，档位：{quality}"
    if sdk_quality.startswith(("DENOISE_", "DEBLUR_")):
        note += "（该档位保持原尺寸）"
    return out_w, out_h, note


# ------------------------------------------------------------------- 2. 转HDR

def true_hdr(images, contrast=100, saturation=100, middle_gray=50, luminance=650,
             debanding=True, colorspace="HDR(HLG,电视通用)", progress=None):
    """普通画面 → HDR 数据，尺寸不变。"""
    require_sdk()
    images, alpha = _split_alpha(images)
    total = images.shape[0]
    output = torch.empty(images.shape, device=images.device, dtype=torch.float32)
    want_hlg = HDR_COLORSPACES[colorspace] == "HLG"

    device, index = get_effect_device()
    with torch.cuda.device(device), nvvfx.TrueHDR(
        contrast=contrast, saturation=saturation, middle_gray=middle_gray,
        luminance=luminance, debanding_off=int(not debanding), device=index,
    ) as effect:
        effect.load()
        for i, image in enumerate(images):
            result = effect.run(prepare_frame(image, device, "RGB8"))
            hdr = unpack_rgb10a2(torch.from_dlpack(result.image).clone())
            if want_hlg:
                hdr = pq_to_hlg(hdr, luminance)
            output[i].copy_(hdr)
            _tick(progress, i + 1, total)

    if alpha is not None:
        output = torch.cat((output, alpha.to(dtype=output.dtype)), dim=-1)

    note = (f"已按峰值亮度 {luminance} 尼特转成 {colorspace}，尺寸不变；"
            f"⚠️ 存出来发灰是正常的，下游必须按 BT.2020 标记，别当普通 SDR 图看")
    return output, note


# ------------------------------------------------------------------- 3. 插帧

def frame_generation(images, generation_type="按倍数插帧", multiplier=2, timestep=0.5,
                     mode="中", auto_shot_change=True, force_shot_change=False,
                     encoding="8位", progress=None):
    """在相邻帧之间补 AI 帧，返回 (图像, 状态说明)。"""
    require_sdk()
    images = images[..., :3]  # 插帧只吃 RGB，透明通道会丢掉
    total = images.shape[0]
    if total < 2:
        return images, "只有 1 帧，没法插帧，原样返回"

    sdk_encoding = ENCODINGS[encoding]
    if generation_type == "按倍数插帧":
        sdk_multiplier = int(multiplier)
        per_pair = sdk_multiplier - 1
    else:
        sdk_multiplier = 2
        per_pair = 1

    out_count = (total - 1) * (per_pair + 1) + 1
    output = torch.empty((out_count, *images.shape[1:]), device=images.device, dtype=images.dtype)
    output[0].copy_(images[0])

    _, in_h, in_w, _ = images.shape
    device, index = get_effect_device()

    with torch.cuda.device(device), nvvfx.VideoFrameGeneration(
        mode=nvvfx.VideoFrameGeneration.Mode[FRAME_MODES[mode]],
        automatic_shot_change_detection_enabled=auto_shot_change,
        device=index,
        image_encoding=nvvfx.ImageEncoding[sdk_encoding],
    ) as effect:
        effect.input_width = in_w
        effect.input_height = in_h
        effect.frame_multiplier = sdk_multiplier
        effect.load()

        out_index = 1
        previous = prepare_frame(images[0], device, sdk_encoding)
        for pair_index, current_image in enumerate(images[1:]):
            current = prepare_frame(current_image, device, sdk_encoding)
            if generation_type == "按倍数插帧":
                for frame_index in range(1, sdk_multiplier):
                    result = effect.run(previous, current, frame_index=frame_index,
                                        shot_change=force_shot_change)
                    copy_effect_output(result.image, output[out_index], sdk_encoding)
                    out_index += 1
            else:
                result = effect.run_at_timestep(previous, current, timestep,
                                                shot_change=force_shot_change)
                copy_effect_output(result.image, output[out_index], sdk_encoding)
                out_index += 1

            output[out_index].copy_(current_image)
            out_index += 1
            previous = current
            _tick(progress, pair_index + 1, total - 1)

    if generation_type == "按倍数插帧":
        note = (f"{total} 帧 → {out_count} 帧（{sdk_multiplier} 倍）；"
                f"⚠️ 合成视频时帧率也要填源帧率的 {sdk_multiplier} 倍，"
                f"否则画面会慢 {sdk_multiplier} 倍")
    else:
        note = (f"{total} 帧 → {out_count} 帧（每两帧之间补 1 帧，位置 {timestep:.2f}）；"
                f"时间点不等于 0.5 时帧间距不均匀，慢动作/抽帧用")
    return output, note
