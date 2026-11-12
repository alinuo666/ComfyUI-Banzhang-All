# -*- coding: utf-8 -*-
"""
👨‍🏫班长 视频与音频工具模块
包含：视频合并、音乐播放器、手动输入歌词（上游传入/一键固定）、加载歌词文件、图像对比
"""

import os
import ctypes
import asyncio
import subprocess
import threading
import queue
import numpy as np
import folder_paths
import tempfile
import torch
import torch.nn.functional as F
import random
import string
import wave
import sys
import json
import shutil
import fractions
import mimetypes

try:
    import av  # PyAV：ffmpeg 库随 Python 包自带，无需系统安装 ffmpeg
    HAS_AV = True
except ImportError:
    HAS_AV = False
    print("[Banzhang] PyAV(av) missing: 视频合并将不可用，请 pip install av")

# ==========================================
# 依赖检查
# ==========================================
HAS_AUDIO = False

# 用全插件共用的查找：系统 PATH / ComfyUI 自带 / 首次自动下载的缓存目录都算，
# 拿到本插件包的人不用再自己装 ffmpeg
from .banzhang_ffmpeg import find_ffmpeg as _find_ffmpeg  # noqa: E402

# 兼容外部脚本读取（自测脚本用它打印当前路径）
ffmpeg_path = _find_ffmpeg()

_FFMPEG_CACHE = {"exe": None}


def _ffmpeg_exe():
    """现查现用：首次启动时 ffmpeg 可能还在后台下载，不能把结论锁死。

    旧写法在 import 期算一次并固定下来，下载完成后本进程仍认为没有 ffmpeg，
    用户必须重启 ComfyUI 才能出片。
    """
    cached = _FFMPEG_CACHE["exe"]
    if cached and os.path.isfile(cached):
        return cached
    found = _find_ffmpeg()
    if found:
        _FFMPEG_CACHE["exe"] = found
    return found or "ffmpeg"


def _has_ffmpeg():
    return os.path.isfile(_ffmpeg_exe())


if _has_ffmpeg():
    print(f"[Banzhang] ffmpeg OK, banzhangVideoCombine enabled: {_ffmpeg_exe()}")
else:
    print("[Banzhang] 暂未找到 ffmpeg，首次运行视频节点时会自动下载，装好即可用")

try:
    import torchaudio
    HAS_AUDIO = True
    print("[Banzhang] torchaudio OK, MusicPlayer enabled")
except ImportError:
    print("[Banzhang] torchaudio missing, MusicPlayer disabled")

try:
    import soundfile as sf
except ImportError:
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "soundfile"])
        import soundfile as sf
    except Exception:
        sf = None

try:
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    from comfy.utils import ProgressBar
except ImportError:
    ProgressBar = None

# 原生 VIDEO 对象（供「📹 视频对象」端口用）：只是把落盘路径包一层，构造时不解码。
# 老版本 ComfyUI 没有这个类时置 None，端口返回空值，不影响「🎬 视频透传」的文件路径。
try:
    from comfy_api.latest import VideoFromFile as _VideoFromFile
except Exception:
    _VideoFromFile = None

# ==========================================
# API 接口：在系统文件管理器中打开文件夹
# ==========================================
try:
    from server import PromptServer
    from aiohttp import web
    HAS_SERVER = True
except Exception as e:
    HAS_SERVER = False
    print(f"⚠️ [班长] 无法导入 PromptServer，文件夹打开接口不可用: {e}")

if HAS_SERVER:
    @PromptServer.instance.routes.post("/banzhang_api/open_folder")
    async def 打开文件夹接口(request):
        try:
            数据包 = await request.json()
            目标路径 = str(数据包.get("path", "")).strip().strip('"').strip("'")
            if not 目标路径:
                return web.json_response({"success": False, "msg": "路径为空"})
            if not os.path.exists(目标路径):
                return web.json_response({"success": False, "msg": "路径不存在"})
            try:
                if os.path.isfile(目标路径):
                    # 传入的是文件：弹出资源管理器并自动定位选中该文件
                    if os.name == "nt":
                        subprocess.Popen(f'explorer /select,"{os.path.normpath(目标路径)}"')
                    elif sys.platform == "darwin":
                        subprocess.Popen(["open", "-R", 目标路径])
                    else:
                        subprocess.Popen(["xdg-open", os.path.dirname(目标路径)])
                else:
                    # 传入的是目录：直接打开该目录
                    if os.name == "nt":
                        os.startfile(目标路径)
                    elif sys.platform == "darwin":
                        subprocess.Popen(["open", 目标路径])
                    else:
                        subprocess.Popen(["xdg-open", 目标路径])
            except Exception as e:
                return web.json_response({"success": False, "msg": str(e)})
            return web.json_response({"success": True, "path": 目标路径})
        except Exception as e:
            return web.json_response({"success": False, "msg": str(e)})

    # 视频文件读取接口：供前端预览保存在自定义路径（output 目录之外）的视频
    # 支持 Range 请求，保证 <video> 可拖动进度
    @PromptServer.instance.routes.get("/banzhang_api/video_file")
    async def 读取视频文件接口(request):
        try:
            文件路径 = str(request.query.get("path", "")).strip()
            视频后缀 = (".mp4", ".mov", ".mkv", ".webm", ".gif", ".webp", ".avi", ".png", ".jpg", ".jpeg")
            if not 文件路径 or not os.path.isfile(文件路径):
                return web.Response(status=404, text="file not found")
            if not 文件路径.lower().endswith(视频后缀):
                return web.Response(status=403, text="forbidden")

            文件大小 = os.path.getsize(文件路径)
            content_type = mimetypes.guess_type(文件路径)[0] or "application/octet-stream"

            区间头 = request.headers.get("Range")
            if 区间头 and 区间头.startswith("bytes="):
                try:
                    起止 = 区间头[6:].split("-")
                    起点 = int(起止[0]) if 起止[0] else 0
                    终点 = int(起止[1]) if 起止[1] else 文件大小 - 1
                    终点 = min(终点, 文件大小 - 1)
                except ValueError:
                    return web.Response(status=416)
                with open(文件路径, "rb") as f:
                    f.seek(起点)
                    数据 = f.read(终点 - 起点 + 1)
                return web.Response(status=206, body=数据, headers={
                    "Content-Type": content_type,
                    "Content-Range": f"bytes {起点}-{终点}/{文件大小}",
                    "Accept-Ranges": "bytes",
                })

            with open(文件路径, "rb") as f:
                数据 = f.read()
            return web.Response(status=200, body=数据, headers={
                "Content-Type": content_type,
                "Accept-Ranges": "bytes",
            })
        except Exception as e:
            return web.Response(status=500, text=str(e))

    # 调色台「应用并导出」接口：直接对本地已有视频做调色重编码
    # 不进 ComfyUI 执行队列、不触发上游节点、不写入任何节点控件
    @PromptServer.instance.routes.post("/banzhang_api/bake_video")
    async def 视频调色烘焙接口(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"success": False, "msg": "请求体不是合法 JSON"})

        源路径 = str(body.get("src", "")).strip()
        if not 源路径 or not os.path.isfile(源路径):
            return web.json_response({"success": False, "msg": "源视频路径无效或文件不存在"})

        # 复用 _read_tune 的兜底与范围夹紧：前端漏传某项也不会炸
        tune = _read_tune(body.get("tune") or {})
        # 输出跟随源文件所在目录，方便与原片并排对比
        保存目录 = os.path.dirname(源路径) or folder_paths.get_output_directory()

        try:
            # 编码是 CPU 密集操作，丢线程池执行，避免阻塞 ComfyUI 的 HTTP 服务
            结果 = await asyncio.to_thread(
                _bake_video_tuned, 源路径, tune, 保存目录, body.get("fps"))
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({"success": False, "msg": f"导出失败: {e}"})

        print(f"[Banzhang] 调色导出 → {结果.get('path', '')} | {结果.get('msg', '')}".strip())
        return web.json_response(结果)


    # ==========================================
    # 工作流元数据嵌入（拖入 ComfyUI 画布可还原工作流）
    # 说明：不能用 -metadata 命令行传值——工作流 JSON 常达数十 KB，
    # 会触发 Windows 命令行长度上限（WinError 206）；改用 ffmetadata 文件。
    # ==========================================
    def _embed_workflow_metadata(src_path, dst_path, embed_meta, fmt_ext):
        meta_txt = dst_path + ".ffmeta"
        try:
            lines = [";FFMETADATA1"]
            for k, v in embed_meta.items():
                esc = v.replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#")
                lines.append(f"{k}={esc}")
            with open(meta_txt, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

            cmd = [_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", src_path, "-i", meta_txt,
                   "-map", "0", "-map_metadata", "1", "-c", "copy"]
            if fmt_ext in ("mp4", "mov", "m4v"):
                # use_metadata_tags 保留任意键名；faststart 将 moov 前置（前端只读前 64MB）
                cmd += ["-movflags", "use_metadata_tags+faststart"]
            cmd += ["-f", {"mp4": "mp4", "mov": "mov", "m4v": "mp4", "mkv": "matroska", "webm": "webm"}.get(fmt_ext, fmt_ext), dst_path]
            remux = subprocess.run(cmd, capture_output=True, timeout=300)
            ok = remux.returncode == 0 and os.path.isfile(dst_path) and os.path.getsize(dst_path) > 0
            if not ok:
                print(f"[Banzhang] workflow embed failed: {remux.stderr.decode(errors='replace')[:200]}")
            return ok
        except Exception as embed_e:
            print(f"[Banzhang] workflow embed error: {embed_e}")
            return False
        finally:
            if os.path.isfile(meta_txt):
                try:
                    os.remove(meta_txt)
                except OSError:
                    pass


# ==========================================
# 音频工具函数
# ==========================================
def save_audio_robust(filepath, waveform, sample_rate, format="wav"):
    if isinstance(waveform, torch.Tensor):
        data = waveform.detach().cpu()
        if data.dim() == 3:
            data = data[0]
    else:
        data = waveform

    # 统一转为 numpy 用于后续处理
    if isinstance(data, torch.Tensor):
        data_np = data.numpy()
    else:
        data_np = np.asarray(data)

    if data_np.ndim == 1:
        data_np = np.expand_dims(data_np, axis=0)

    format_lower = format.lower()

    if format_lower == "wav":
        try:
            data_int = np.clip(data_np * 32767, -32768, 32767).astype(np.int16)
            channels, samples = data_int.shape

            with wave.open(filepath, 'wb') as wf:
                wf.setnchannels(channels)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                if channels == 1:
                    wf.writeframes(data_int.tobytes())
                else:
                    interleaved = np.empty((samples * channels,), dtype=np.int16)
                    for c in range(channels):
                        interleaved[c::channels] = data_int[c]
                    wf.writeframes(interleaved.tobytes())
            return True
        except Exception as e:
            print(f"[Banzhang] wave save failed: {e}")

    # 非 wav 格式：soundfile → torchaudio → ffmpeg，依次降级。
    # 顺序不能反过来：便携版实测 torchaudio.save 因缺 libtorchcodec 对**所有**
    # 格式一律失败（wav / flac / ogg / mp3 全试过），放在前面等于每次都白跑一轮、
    # 还往终端刷一条吓人的报错；而 soundfile 自带 libsndfile，wav/flac/ogg 都好。
    # 剩下的 mp3 之类 soundfile 也写不了的，交给最后的 ffmpeg。
    if data_np.ndim == 2 and data_np.shape[0] > 1:
        data_for_save = data_np.T  # (channels, samples) -> (samples, channels)
    else:
        data_for_save = data_np.squeeze()

    if sf:
        try:
            sf.write(filepath, data_for_save, sample_rate, format=format_lower)
            return True
        except Exception as e_sf:
            print(f"[Banzhang] soundfile save failed: {e_sf}")

    try:
        torchaudio.save(filepath, data, sample_rate, format=format_lower)
        return True
    except Exception as e:
        print(f"[Banzhang] torchaudio save failed: {e}")

    # fallback: 使用 ffmpeg 保存（支持 mp3/ogg/flac 等）
    if format_lower in ("mp3", "ogg", "flac"):
        try:
            # 将 numpy 数据写入临时 wav，再用 ffmpeg 转码
            tmp_wav = filepath + ".tmp.wav"
            if save_audio_robust(tmp_wav, data_np, sample_rate, format="wav"):
                codec_map = {"mp3": "libmp3lame", "ogg": "libvorbis", "flac": "flac"}
                codec = codec_map.get(format_lower, "libmp3lame")
                result = subprocess.run(
                    [_ffmpeg_exe(), "-y", "-i", tmp_wav, "-c:a", codec, "-b:a", "192k", filepath],
                    capture_output=True, text=True
                )
                os.remove(tmp_wav)
                if result.returncode == 0:
                    return True
                else:
                    print(f"[Banzhang] ffmpeg encode failed: {result.stderr}")
        except Exception as e_ff:
            print(f"[Banzhang] ffmpeg fallback failed: {e_ff}")

    return False


def load_audio_file(filepath):
    ext = filepath.lower().split('.')[-1]
    if ext == 'wav':
        try:
            with wave.open(filepath, 'rb') as wf:
                channels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                sr = wf.getframerate()
                raw = wf.readframes(wf.getnframes())
                if sampwidth == 1:
                    dtype = np.uint8
                elif sampwidth == 2:
                    dtype = np.int16
                elif sampwidth == 4:
                    dtype = np.int32
                else:
                    dtype = np.int16
                arr = np.frombuffer(raw, dtype=dtype)
                if channels > 1:
                    arr = arr.reshape(-1, channels).T
                else:
                    arr = arr.reshape(1, -1)
                tensor = torch.from_numpy(arr.astype(np.float32) / (2 ** (8 * sampwidth - 1)))
                return tensor, sr
        except:
            pass
    # 非标准 wav：交给全插件共用的解码层（soundfile → PyAV → torchaudio 依次
    # 降级）。原先只有 torchaudio + soundfile 两级，漏掉了格式最全的 PyAV。
    try:
        from .csglide_audio_io import decode_audio_file
        return decode_audio_file(filepath)
    except Exception:
        pass
    # 最终兜底：用 ffmpeg 转成 wav（仅依赖内置 wave 模块读取，不依赖第三方解码库）
    try:
        tmp_wav = os.path.join(tempfile.gettempdir(), f"_banzhang_decode_{random.randint(0, 10 ** 8)}.wav")
        result = subprocess.run(
            [_ffmpeg_exe(), "-y", "-i", filepath, "-ac", "2", "-ar", "44100", tmp_wav],
            capture_output=True, text=True
        )
        if result.returncode == 0 and os.path.exists(tmp_wav):
            waveform, sr = load_audio_file(tmp_wav)  # wav 走内置 wave 读取
            try:
                os.remove(tmp_wav)
            except Exception:
                pass
            return waveform, sr
        if os.path.exists(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass
    except Exception as e:
        print(f"[Banzhang] ffmpeg decode fallback failed: {e}")
    raise Exception("Audio decode failed")


# ==========================================
# 编码辅助：ffmpeg 子进程管道编码（进程隔离）
# 编码器原生崩溃只失败本节点，不再拖垮 ComfyUI 主进程
# ==========================================
_NVENC_CACHE = {}


def _has_nvenc(codec="h264_nvenc"):
    """检测 GPU 硬件编码器是否可用（结果缓存，只查一次）。"""
    if codec in _NVENC_CACHE:
        return _NVENC_CACHE[codec]
    ok = False
    try:
        r = subprocess.run([_ffmpeg_exe(), "-hide_banner", "-encoders"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        ok = codec in r.stdout.decode("utf-8", "replace")
    except Exception:
        ok = False
    _NVENC_CACHE[codec] = ok
    return ok


# 调色参数的键名与默认值：调色台「应用并导出」走 bake 接口，节点上已无这些控件，
# 仅供接口解析与烘焙成片报告使用（改名会同时影响前端面板的提交字段，勿单侧修改）
TUNE_DEFAULTS = {
    "🎨 饱和度": 1.0,
    "✨ 泛光强度": 0.0, "✨ 泛光起点": 0.75, "✨ 泛光范围": 4.0,
    "🌫️ 柔雾强度": 0.0, "🌫️ 柔焦范围": 4.0, "🌫️ 灰雾浓度": 0.30,
    "🔥 暖晕强度": 0.0, "🔥 暖晕起点": 0.70, "🔥 暖晕范围": 5.0,
}


def _read_tune(kwargs):
    """从 kwargs 读全部调色参数：旧工作流缺控件时取默认值，缺一个也不报错"""
    tune = {}
    for name, d in TUNE_DEFAULTS.items():
        try:
            v = float(kwargs.get(name, d))
        except Exception:
            v = d
        if not (v == v):      # NaN
            v = d
        tune[name] = v
    tune["🎨 饱和度"] = min(2.0, max(0.0, tune["🎨 饱和度"]))
    tune["✨ 泛光强度"] = min(1.0, max(0.0, tune["✨ 泛光强度"]))
    tune["✨ 泛光起点"] = min(0.95, max(0.0, tune["✨ 泛光起点"]))
    tune["✨ 泛光范围"] = min(10.0, max(1.0, tune["✨ 泛光范围"]))
    tune["🌫️ 柔雾强度"] = min(1.0, max(0.0, tune["🌫️ 柔雾强度"]))
    tune["🌫️ 柔焦范围"] = min(10.0, max(1.0, tune["🌫️ 柔焦范围"]))
    tune["🌫️ 灰雾浓度"] = min(1.0, max(0.0, tune["🌫️ 灰雾浓度"]))
    tune["🔥 暖晕强度"] = min(1.0, max(0.0, tune["🔥 暖晕强度"]))
    tune["🔥 暖晕起点"] = min(0.95, max(0.0, tune["🔥 暖晕起点"]))
    tune["🔥 暖晕范围"] = min(10.0, max(1.0, tune["🔥 暖晕范围"]))
    return tune


def _tune_text(tune):
    """详情面板的调色行：只列出真正生效的项"""
    t = ""
    if abs(tune["🎨 饱和度"] - 1.0) > 1e-4:
        t += f"🎨 饱和度 : {tune['🎨 饱和度']:g}\n"
    if tune["✨ 泛光强度"] > 1e-4:
        t += f"✨ 泛光 : {tune['✨ 泛光强度']:g} / 起点 {tune['✨ 泛光起点']:g} / 范围 {tune['✨ 泛光范围']:g}\n"
    if tune["🌫️ 柔雾强度"] > 1e-4:
        t += f"🌫️ 柔雾 : {tune['🌫️ 柔雾强度']:g} / 范围 {tune['🌫️ 柔焦范围']:g} / 灰雾 {tune['🌫️ 灰雾浓度']:g}\n"
    if tune["🔥 暖晕强度"] > 1e-4:
        t += f"🔥 暖晕 : {tune['🔥 暖晕强度']:g} / 起点 {tune['🔥 暖晕起点']:g} / 范围 {tune['🔥 暖晕范围']:g}\n"
    return t


def _blur_direct(x, s):
    """原尺寸可分离高斯：横向一遍、纵向一遍。x: NCHW"""
    r = max(1, int(3 * s))
    k = torch.arange(-r, r + 1, dtype=x.dtype, device=x.device)
    kern = torch.exp(-0.5 * (k / s) ** 2)
    kern = kern / kern.sum()
    n, c, h, w = x.shape
    t = x.reshape(n * c, 1, h, w)
    t = F.conv2d(F.pad(t, (r, r, 0, 0), mode="replicate"), kern.view(1, 1, 1, -1))
    t = F.conv2d(F.pad(t, (0, 0, r, r), mode="replicate"), kern.view(1, 1, -1, 1))
    return t.reshape(n, c, h, w)


def _blur(x, s, ds_min=6.0, short_min=192):
    """高斯模糊，replicate 填充避免边缘发黑。x: NCHW

    sigma 是按画面宽度算出来的（见 _apply_tuning 的 rad * 0.00x * w），4K 下
    涨到 90 以上、核宽近 600 像素，逐帧六次这种卷积——这是调色导出慢的主因。
    模糊是纯低频操作，放到 1/ds 的小图上算完再放大回来，像素量与核宽同时
    缩小。实测（3090）：4K 13~16 倍、1080p 5 倍，与全尺寸结果平均差 0.07
    灰阶（0-255），肉眼不可分辨。

    sigma 小时 ds 落到 1，走原尺寸路径，不引入额外插值误差；short_min 保证
    小图短边不低于 192，低分辨率素材不会为了省算力而糊过头。
    """
    ds = max(1, int(s // ds_min))
    ds = min(ds, max(1, min(x.shape[-2], x.shape[-1]) // short_min))
    h, w = x.shape[-2] // ds, x.shape[-1] // ds
    if ds > 1 and h >= 2 and w >= 2:
        small = F.interpolate(x, size=(h, w), mode="area")
        small = _blur_direct(small, s / ds)
        return F.interpolate(small, size=(x.shape[-2], x.shape[-1]),
                             mode="bilinear", align_corners=False)
    return _blur_direct(x, s)


def _bright_pass(x, thr):
    """提取亮部：用亮度做 mask 但保留原色，低于 thr 的全部压成 0。x: NCHW"""
    lum = x[:, 0:1] * 0.299 + x[:, 1:2] * 0.587 + x[:, 2:3] * 0.114
    mask = torch.clamp((lum - thr) / max(1e-4, 1.0 - thr), 0.0, 1.0)
    return x * mask


@torch.inference_mode()
def _apply_tuning(images, tune):
    """合并调色：饱和度 + 泛光 + 暖晕 + 柔雾 在单次遍历内完成。

    四种效果各自单独实现过时，一次调色要经历 4 次 NHWC↔NCHW 转置、4 次分批
    循环、4 次显存回退判定；合并后只需一次遍历，并全程 inference_mode 关掉
    autograd 记录——显著降低「调好参数后生成偏慢」的开销。
    处理顺序：饱和度 → 泛光 → 暖晕 → 柔雾。
    """
    sat = tune["🎨 饱和度"]
    bloom_i, bloom_t, bloom_r = tune["✨ 泛光强度"], tune["✨ 泛光起点"], tune["✨ 泛光范围"]
    warm_i, warm_t, warm_r = tune["🔥 暖晕强度"], tune["🔥 暖晕起点"], tune["🔥 暖晕范围"]
    soft_i, soft_r, haze = tune["🌫️ 柔雾强度"], tune["🌫️ 柔焦范围"], tune["🌫️ 灰雾浓度"]

    need_sat = abs(sat - 1.0) > 1e-4
    need_bloom = bloom_i > 1e-4
    need_warm = warm_i > 1e-4
    need_soft = soft_i > 1e-4
    if not (need_sat or need_bloom or need_warm or need_soft):
        return images

    # 参数预归一化（写代码时保持与单独实现版取值一致，避免手滑改错）
    bloom_thr = min(0.99, max(0.0, float(bloom_t)))
    bloom_rad = min(10.0, max(1.0, float(bloom_r)))
    warm_thr = min(0.99, max(0.0, float(warm_t)))
    warm_rad = min(10.0, max(1.0, float(warm_r)))
    warm_tint = (1.35, 0.60, 0.28)
    soft_mix = soft_i * 0.5
    soft_rad = min(10.0, max(1.0, float(soft_r)))
    soft_hz = min(1.0, max(0.0, float(haze)))
    soft_contrast = 1.0 - soft_hz * 0.18
    soft_lift = soft_hz * 0.055

    def _batch(t):
        n, h, w, _ = t.shape
        # 批次上限：CUDA 上按实时可用显存算，CPU 上固定 4 帧。
        # 旧口径写死 400 万像素预算，4K（829 万）一除就是 0，兜底成 1——
        # 等于逐帧跑，显卡完全吃不饱。每帧峰值按 6 份 float32 估（输入 /
        # 输出 / 中间量），只取四成可用显存，别把生成模型的位置挤掉。
        step = 4
        if t.is_cuda:
            try:
                free, _ = torch.cuda.mem_get_info()
                step = max(1, min(16, int(free * 0.4) // max(1, h * w * 3 * 4 * 6)))
            except Exception:
                pass
        # 预分配输出、逐块写回：不再把每块结果攒在列表里最后 torch.cat。
        # 攒列表 + cat 会再申请一份与整段等大的连续内存，长片开启调色时
        # 就是这一份把内存顶爆的。写回式只多一份输出，峰值与块大小无关。
        out = torch.empty((n, h, w, 3), dtype=t.dtype, device=t.device)
        for s in range(0, n, step):
            e = min(s + step, n)
            x = t[s:e, :, :, :3].permute(0, 3, 1, 2)          # NHWC → NCHW
            if need_sat:
                gray = x[:, 0:1] * 0.299 + x[:, 1:2] * 0.587 + x[:, 2:3] * 0.114
                x = torch.clamp(gray + (x - gray) * sat, 0.0, 1.0)
            if need_bloom:
                glow = _blur(_bright_pass(x, bloom_thr), max(1.0, bloom_rad * 0.005 * w))
                x = torch.clamp(x + glow * bloom_i, 0.0, 1.0)
            if need_warm:
                glow = _blur(_bright_pass(x, warm_thr), max(1.0, warm_rad * 0.005 * w))
                glow = torch.cat([glow[:, 0:1] * warm_tint[0],
                                  glow[:, 1:2] * warm_tint[1],
                                  glow[:, 2:3] * warm_tint[2]], dim=1)
                x = torch.clamp(x + glow * warm_i, 0.0, 1.0)
            if need_soft:
                x = x * (1 - soft_mix) + _blur(x, max(0.5, soft_rad * 0.0022 * w)) * soft_mix
                x = torch.clamp((x - 0.5) * soft_contrast + 0.5 + soft_lift, 0.0, 1.0)
            out[s:e, :, :, :] = x.permute(0, 2, 3, 1)          # NCHW → NHWC，就地写回
        return out

    try:
        return _batch(images)
    except Exception as e:
        print(f"[Banzhang] 调色 GPU 处理失败，回退 CPU: {e}")
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        return _batch(images.detach().cpu())


def _build_encode_candidates(fmt_str, w_ext, h_ext, n_frames, ext, fps=24.0):
    """编码参数候选链：按固定档位顺序逐个尝试，失败自动换下一档，尽量保住成品。

    档位顺序（画质优先）：GPU 高画质 → CPU 高画质 → GPU 极速 → CPU 极速 → CPU 兜底。
    档位不暴露为节点参数，全自动执行——新增 required 参数会让旧工作流报
    「Required input is missing」，并使 widgets_values 按下标错位。
    NVENC 在 GPU 上完成编码，几乎不占系统内存，是长视频/高分辨率场景下
    避免原生崩溃（内存不足 access violation）的备选路径。
    长视频(>=300帧)额外启用碎片化写入，进程被杀时已编码部分仍可抢救。
    """
    heavy = (w_ext * h_ext >= 1280 * 720) or (n_frames >= 300)  # 启用碎片化抢救写入
    # 碎片化写入：每约 2 秒一个关键帧，让已编码的分片及时落盘
    mux = (["-movflags", "+frag_keyframe+empty_moov", "-g", str(max(1, min(int(fps * 2), 50)))]
           if (n_frames >= 300 or heavy) and ext in ("mp4", "mov") else [])

    def wrap(args):
        return args + mux

    # ProRes / WEBM 无硬件编码器，直接走原 CPU 链路
    if "ProRes" in fmt_str:
        return [
            ("ProRes 422HQ", wrap(["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"])),
            ("ProRes 422 降级", wrap(["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"])),
        ]
    if "WEBM" in fmt_str:
        return [
            ("VP9 CRF20", wrap(["-c:v", "libvpx-vp9", "-crf", "20", "-b:v", "0", "-pix_fmt", "yuv420p"])),
            ("VP8 极速兜底", wrap(["-c:v", "libvpx", "-crf", "30", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"])),
        ]

    nv = ("HEVC" in fmt_str or "H265" in fmt_str)
    nvenc_name = "hevc_nvenc" if nv else "h264_nvenc"
    gpu_ok = _has_nvenc(nvenc_name) if _has_ffmpeg() else False
    # HEVC 在 mov/mkv 容器需要显式 tag
    hevc_tag = ["-tag:v", "hvc1"] if nv and ext in ("mov", "mkv", "mp4") else []

    gpu_fast = wrap(["-c:v", nvenc_name, "-preset", "p1", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-pix_fmt", "yuv420p"] + hevc_tag)
    gpu_hq = wrap(["-c:v", nvenc_name, "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "16", "-pix_fmt", "yuv420p"] + hevc_tag)
    cpu_hq = wrap(["-c:v", "libx264" if not nv else "libx265", "-crf", "12" if not nv else "16",
                   "-preset", "medium", "-pix_fmt", "yuv420p"] + hevc_tag)
    cpu_fast = wrap(["-c:v", "libx264" if not nv else "libx265", "-crf", "18" if not nv else "22",
                     "-preset", "veryfast", "-pix_fmt", "yuv420p"] + hevc_tag)
    cpu_last = wrap(["-c:v", "libx264", "-crf", "23", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])

    # 固定档位顺序：画质优先，逐档降级
    candidates = []
    if gpu_ok:
        # NVENC 预检不可用时跳过 GPU 档，避免注定失败的尝试
        candidates.append(("GPU 高画质", gpu_hq))
    candidates.append(("CPU 高画质", cpu_hq))
    if gpu_ok:
        candidates.append(("GPU 极速", gpu_fast))
    candidates.append(("CPU 极速", cpu_fast))
    candidates.append(("CPU 兜底", cpu_last))
    return candidates


# 「这个位置写不进去」类错误：换编码参数不可能修好，继续试剩下几档只会
# 拿着同一个 out_path 再撞一次墙。ffmpeg 走英文 stderr，Python 的 OSError
# 在中文 Windows 上给中文，两边特征都要认，否则漏判就退化成跑满五档。
_不可写错误特征 = (
    "Permission denied", "No space left", "Read-only file system",
    "Error opening output", "拒绝访问", "磁盘空间不足", "只读",
)
# OSError.errno：无权限 / 不允许 / 无空间 / 只读文件系统（不引 errno 模块）
_不可写_errno = (1, 13, 28, 30)


def _ffmpeg_encode_frames(images, n_frames, w_ext, h_ext, fps, out_path, candidates, audio_args, err_tmp, pbar=None, out_fmt=None, out_duration=None, 帧流=None):
    """管道喂原始 RGB 帧给 ffmpeg 子进程编码；候选参数逐个尝试，成功即返回。

    out_fmt：显式容器格式（part 文件后缀不可识别，必须显式指定）。
    out_duration：输出时长硬上限（秒）。靠它裁掉音频尾部，而不是指望
    「按采样数截断 WAV」——AAC 编码器 priming 会多塞约 1024 个采样，
    容器时长按最长流算，画面就会定格最后半帧。多给半帧余量保证画面不丢。
    stderr 落临时文件（非管道）：避免编码器日志写满缓冲与喂帧互相死锁。
    返回 (ok, err_msg, used_label)
    """
    last_err = ""

    for idx, (label, vargs) in enumerate(candidates):
        proc = None
        # 降级到新档位时把进度条归零重爬：否则第一档跑到 60% 失败，
        # 后面几档不更新进度，界面会一直停在 60% 直到突然完成
        if pbar is not None:
            try:
                pbar.update(-pbar.value)
            except Exception:
                pass
        try:
            if os.path.isfile(out_path):
                os.remove(out_path)
            cmd = [
                _ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
                "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", f"{w_ext}x{h_ext}", "-r", str(fps), "-i", "pipe:0",
            ] + audio_args + vargs + (["-t", f"{out_duration:.6f}"] if out_duration else []) + (["-f", out_fmt] if out_fmt else []) + [out_path]
            with open(err_tmp, "w", encoding="utf-8", errors="replace") as err_f:
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err_f)
                # 批量转 uint8 后整块写入：帧在 GPU 时直接在 GPU 上转换，
                # 传输量从 float32(12B/像素) 降到 uint8(3B/像素)，并减少 Python 逐帧开销
                batch = max(1, min(32, 20000000 // max(1, w_ext * h_ext)))
                if 帧流 is None and images.is_cuda:
                    # 按实时可用显存再收一次上限（只用一半），显存紧张时自动缩小批次
                    try:
                        free_bytes, _ = torch.cuda.mem_get_info()
                        per_frame = w_ext * h_ext * 3 * 5  # float32 中间量 + uint8 结果
                        batch = max(1, min(batch, int(free_bytes * 0.5) // per_frame))
                    except Exception:
                        pass
                if 帧流 is not None:
                    # 帧在解码节点里就已解好并存成 uint8，这里只剩写盘 ——
                    # 所以本节点的耗时回到「纯编码」，且编码档位降级重试可以整段重放，
                    # 不必重新解码（旧实现是惰性生成器，第二次消费拿不到帧）。
                    for arr in 帧流.批次(batch):
                        proc.stdin.write(np.ascontiguousarray(arr[:, :h_ext, :w_ext]).tobytes())
                        if pbar is not None:
                            pbar.update(int(arr.shape[0]))
                else:
                    for s in range(0, n_frames, batch):
                        e = min(s + batch, n_frames)
                        chunk = images[s:e, :h_ext, :w_ext]
                        try:
                            u8 = chunk.mul(255).round_().clamp_(0, 255).to(torch.uint8)
                            if chunk.is_cuda:
                                u8 = u8.cpu().numpy()
                            else:
                                u8 = u8.numpy()
                        except Exception:
                            # 显存不足等：退回 CPU 逐帧转换，保证能出片
                            u8 = np.stack([
                                np.ascontiguousarray((images[i].detach().cpu().numpy()[:h_ext, :w_ext] * 255).astype(np.uint8))
                                for i in range(s, e)
                            ])
                        proc.stdin.write(np.ascontiguousarray(u8).tobytes())
                        if pbar is not None:
                            pbar.update(e - s)
                proc.stdin.close()
                ret = proc.wait()
                proc = None

            if ret == 0 and os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
                if idx > 0:
                    print(f"[Banzhang] 编码降级成功，使用档位: {label}")
                return True, "", label

            tail = ""
            try:
                with open(err_tmp, "r", encoding="utf-8", errors="replace") as f:
                    tail = f.read().strip()[-400:]
            except Exception:
                pass
            last_err = f"[{label}] 退出码 {ret} {tail}".strip()
            print(f"[Banzhang] 编码尝试失败 {last_err}")
            if any(k in tail for k in _不可写错误特征):
                return False, f"{last_err}（已试 {idx + 1}/{len(candidates)} 档，不可恢复错误，提前停止）", label
        except Exception as e:
            # 编码器一旦提前退出（编码器名不支持 / 显存不足 / 分辨率非法），
            # 继续写 stdin 只会拿到一句 Broken pipe —— 真实原因全在 stderr 文件里。
            # 先收掉子进程让它把日志写完，再优先报日志内容，否则用户看到的是假原因。
            if proc is not None:
                try:
                    proc.kill()
                    proc.wait(timeout=5)
                except Exception:
                    pass
                proc = None
            tail = ""
            try:
                with open(err_tmp, "r", encoding="utf-8", errors="replace") as f:
                    tail = f.read().strip()[-400:]
            except Exception:
                pass
            last_err = f"[{label}] {tail or e}"
            print(f"[Banzhang] 编码尝试异常 {last_err}")
            # 删不掉残留 .part（被别的进程锁住）时 ffmpeg 根本没起来，stderr 是空的，
            # 只有异常本身带着原因 —— 中文 Windows 下是「拒绝访问」，得靠 errno 认。
            if any(k in tail for k in _不可写错误特征) or getattr(e, "errno", None) in _不可写_errno:
                return False, f"{last_err}（已试 {idx + 1}/{len(candidates)} 档，不可恢复错误，提前停止）", label
        finally:
            if proc is not None:
                try:
                    proc.kill()
                except Exception:
                    pass
    return False, f"{last_err or '未知错误'}（已试 {len(candidates)} 档）", ""


def _ffmpeg_remux(src_path, dst_path, ext, in_fmt=None):
    """碎片/临时文件 → 标准容器（重建 moov + faststart），失败返回 False。"""
    try:
        cmd = [_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error"]
        if in_fmt:
            cmd += ["-f", in_fmt]
        cmd += ["-i", src_path, "-c", "copy", "-err_detect", "ignore_err"]
        if ext in ("mp4", "mov"):
            cmd += ["-movflags", "+faststart"]
        cmd += [dst_path]
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok = r.returncode == 0 and os.path.isfile(dst_path) and os.path.getsize(dst_path) > 0
        if not ok and os.path.isfile(dst_path):
            try:
                os.remove(dst_path)
            except Exception:
                pass
        return ok
    except Exception as e:
        print(f"[Banzhang] remux 失败: {e}")
        return False


def _bake_progress(src_path, done, total):
    """导出进度广播。前端「应用并导出」按钮据此显示百分比。"""
    try:
        PromptServer.instance.send_sync("banzhang.bake.progress", {
            "src": src_path, "done": int(done), "total": int(max(total, done)),
        })
    except Exception:
        pass


def _bake_video_tuned(src_path, tune, save_dir, out_fps=None):
    """对本地已有视频做调色重编码：不进 ComfyUI 队列、不触发上游节点、不写任何节点控件。

    三段流水线——后台线程解码 → GPU 调色 → 后台线程写编码器，三者重叠进行：
    解码的 swscale 是纯 CPU 活，写管道要等编码器，把它们从主线上挪开后
    GPU 才不会干等。峰值内存只与批次大小相关，长视频不会一次性铺满内存。
    音频用 -c:a copy 无损搬运（webm 容器不支持 aac，该分支改 libopus）。
    输出与源文件同目录、同容器，命名 {源名}_调色_NN.{ext}，原片保留。
    每次都是「从传进来的源重新算」，因此反复导出不会累积失真。
    返回 {success:True, path, filename, fps, frame_count, engine, report} 或 {success:False, msg}
    """
    if not HAS_AV:
        return {"success": False, "msg": "缺少 PyAV(av) 组件，无法解码源视频（pip install av）"}
    if not _has_ffmpeg():
        return {"success": False,
                "msg": "还没装好 ffmpeg：首次使用会自动下载，稍等一会儿再点一次；"
                       "若一直失败，看 ComfyUI 终端的下载提示"}

    ext = os.path.splitext(src_path)[1].lstrip(".").lower()
    if ext not in ("mp4", "mov", "mkv", "webm"):
        return {"success": False, "msg": f"不支持对 .{ext} 文件做调色导出（仅 mp4 / mov / mkv / webm）"}

    fmt_std = {"mp4": "MP4 (H264/通用)", "mov": "MOV (H264/网页兼容)",
               "mkv": "MKV (H264/防损坏)", "webm": "WEBM (网页/透明)"}[ext]
    out_fmt = {"mp4": "mp4", "mov": "mov", "mkv": "matroska", "webm": "webm"}[ext]

    # --- 探测源信息 ---
    try:
        with av.open(src_path) as c:
            vs = c.streams.video[0]
            src_w, src_h = int(vs.width), int(vs.height)
            src_fps = float(vs.average_rate) if vs.average_rate else 24.0
            n_frames = int(vs.frames) if vs.frames else 0
            if not n_frames and c.duration:
                n_frames = int(c.duration / 1_000_000.0 * src_fps)
            has_audio = len(c.streams.audio) > 0
    except Exception as e:
        return {"success": False, "msg": f"无法读取源视频信息: {e}"}

    fps = float(out_fps) if out_fps else src_fps
    w_ext, h_ext = (src_w // 2) * 2, (src_h // 2) * 2
    if w_ext < 2 or h_ext < 2:
        return {"success": False, "msg": f"源视频尺寸异常: {src_w}x{src_h}"}

    # --- 自增命名：与源文件同目录，原片保留 ---
    try:
        os.makedirs(save_dir, exist_ok=True)
    except Exception as e:
        return {"success": False, "msg": f"无法创建保存目录: {e}"}
    stem = os.path.splitext(os.path.basename(src_path))[0]
    counter = 1
    while True:
        file_name = f"{stem}_调色_{counter:02d}.{ext}"
        file_path = os.path.join(save_dir, file_name)
        if not os.path.exists(file_path):
            break
        counter += 1

    part_path = file_path + ".part"
    err_tmp = file_path + ".ffmpegerr"
    candidates = _build_encode_candidates(fmt_std, w_ext, h_ext, n_frames, ext, fps)

    # 调色走 GPU：泛光/柔焦的高斯是卷积运算，显卡比 CPU 快几十倍。
    # 编码档位本来就有 GPU 档，此前慢的正是这一段被固定建在 CPU 张量上。
    cuda_ok = torch.cuda.is_available()

    # 批次大小：按实时可用显存算，而不是写死一个字节预算——写死的 256MB 在
    # 4K 下只够 2 帧，显卡刚起步就收工。每帧峰值按 6 份 float32 估（输入 /
    # 输出 / 中间量），只取四成可用显存，别把生成模型的位置挤掉。
    per_frame = w_ext * h_ext * 3 * 4
    batch_max = 4
    if cuda_ok:
        try:
            free, _ = torch.cuda.mem_get_info()
            batch_max = max(1, min(16, int(free * 0.4) // max(1, per_frame * 6)))
        except Exception:
            pass

    last_err = ""
    ok = False
    used_label = ""
    frames_written = 0

    for idx, (label, vargs) in enumerate(candidates):
        proc = None
        try:
            if os.path.isfile(part_path):
                os.remove(part_path)

            cmd = [
                _ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
                "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", f"{w_ext}x{h_ext}", "-r", str(fps), "-i", "pipe:0",
                "-i", src_path, "-map", "0:v:0",
            ]
            if has_audio:
                # webm 只认 opus/vorbis，源音轨常是 aac，必须转码；其余容器直接 copy 无损
                if ext == "webm":
                    cmd += ["-map", "1:a:0", "-c:a", "libopus", "-b:a", "192k"]
                else:
                    cmd += ["-map", "1:a:0", "-c:a", "copy"]
            cmd += vargs + ["-f", out_fmt, part_path]

            with open(err_tmp, "w", encoding="utf-8", errors="replace") as err_f:
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                        stdout=subprocess.DEVNULL, stderr=err_f)

                def _tune_batch(arrs):
                    """一批已解码的 RGB uint8 帧 → torch 调色 → 转回 uint8。

                    GPU 可用时在显卡上调色（卷积快几十倍），显存不足等异常整批
                    退回 CPU 重算，保证能出片。这里故意不做 .cpu() 回传——回传
                    与写管道都交给写线程，主线程立刻去算下一批。
                    """
                    arr = np.stack(arrs)

                    def _run(on_gpu):
                        t = torch.from_numpy(arr)
                        if on_gpu:
                            # 先以 uint8 上传、到显卡上再转 float：4K 16 帧的
                            # 传输量从 1.6GB 降到 400MB，CPU 侧也省掉一次
                            # 1.6GB float32 的分配与写（实测省一半耗时）
                            t = t.cuda(non_blocking=True)
                        t = t.float().div_(255.0)
                        t = _apply_tuning(t, tune)
                        return t.mul(255).round_().clamp_(0, 255).to(torch.uint8)

                    u8 = None
                    if cuda_ok:
                        try:
                            u8 = _run(True)
                        except Exception as e:
                            print(f"[Banzhang] 调色导出 GPU 调色失败，回退 CPU: {e}")
                            try:
                                torch.cuda.empty_cache()
                            except Exception:
                                pass
                            u8 = None
                    if u8 is None:
                        u8 = _run(False)
                    return u8

                def _read_frames():
                    """后台解码：AUTO 让解码器自身多核，队列让它与调色、写盘重叠。"""
                    try:
                        with av.open(src_path) as c:
                            vs = c.streams.video[0]
                            vs.thread_type = "AUTO"
                            for frame in c.decode(vs):
                                # 裁剪到偶数尺寸（编码器要求），与节点内编码策略一致
                                frame_q.put(frame.to_ndarray(format="rgb24")[:h_ext, :w_ext])
                    except Exception as e:
                        frame_q.put(e)
                    finally:
                        frame_q.put(None)

                def _write_frames():
                    """后台写管道：uint8 回传与 stdin 阻塞都在这里，主线不等。"""
                    while True:
                        item = write_q.get()
                        if item is None:
                            break
                        try:
                            arr = item.cpu().numpy() if item.is_cuda else item.numpy()
                            proc.stdin.write(np.ascontiguousarray(arr).tobytes())
                        except Exception as e:
                            # 编码器提前退出（管道破裂 / 参数不被接受）。异常不能
                            # 让线程停在这里：队列一满主线程就永远卡在 put 上，
                            # 所以只记录、继续排空，交给主线去换下一档编码。
                            write_err.append(e)

                frames_written = 0
                frame_q = queue.Queue(maxsize=batch_max * 2)
                write_q = queue.Queue(maxsize=1)
                write_err = []
                reader = threading.Thread(target=_read_frames, daemon=True)
                writer = threading.Thread(target=_write_frames, daemon=True)
                reader.start()
                writer.start()
                try:
                    buf = []
                    while True:
                        item = frame_q.get()
                        if item is None:
                            break
                        if isinstance(item, Exception):
                            raise item
                        buf.append(item)
                        if len(buf) >= batch_max:
                            write_q.put(_tune_batch(buf))
                            frames_written += len(buf)
                            _bake_progress(src_path, frames_written, n_frames)
                            buf = []
                    if buf:
                        write_q.put(_tune_batch(buf))
                        frames_written += len(buf)
                        _bake_progress(src_path, frames_written, n_frames)
                    write_q.put(None)
                    writer.join()
                    if write_err:
                        raise write_err[0]
                finally:
                    # 解码异常时也要放哨兵，否则写线程卡在 get() 上不收工
                    write_q.put(None)
                    reader.join(timeout=5)

                proc.stdin.close()
                ret = proc.wait()
                proc = None

            if ret == 0 and os.path.isfile(part_path) and os.path.getsize(part_path) > 0:
                ok = True
                used_label = label
                break

            tail = ""
            try:
                with open(err_tmp, "r", encoding="utf-8", errors="replace") as f:
                    tail = f.read().strip()[-300:]
            except Exception:
                pass
            last_err = f"[{label}] 退出码 {ret} {tail}".strip()
            print(f"[Banzhang] 调色导出编码失败 {last_err}")
        except Exception as e:
            last_err = f"[{label}] {e}"
            print(f"[Banzhang] 调色导出编码异常 {last_err}")
        finally:
            if proc is not None:
                try:
                    proc.kill()
                except Exception:
                    pass

    if os.path.isfile(err_tmp):
        try:
            os.remove(err_tmp)
        except Exception:
            pass

    if not ok:
        if os.path.isfile(part_path):
            try:
                os.remove(part_path)
            except Exception:
                pass
        return {"success": False, "msg": f"已尝试 {len(candidates)} 档编码参数均失败：{last_err}"}

    # --- 收尾：碎片 → 标准容器（重建 moov + faststart） ---
    if _ffmpeg_remux(part_path, file_path, ext, out_fmt):
        if os.path.isfile(part_path):
            try:
                os.remove(part_path)
            except Exception:
                pass
    else:
        os.replace(part_path, file_path)

    size_mb = os.path.getsize(file_path) / (1024 * 1024)
    print(f"[Banzhang] 调色导出完成 {file_path}（{frames_written} 帧 / {size_mb:.2f} MB / 档位 {used_label}）")

    return {
        "success": True,
        "path": file_path,
        "filename": file_name,
        "fps": fps,
        "frame_count": frames_written,
        "engine": used_label,
        "report": (
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"📂 文件名称 : {file_name}\n"
            f"📏 物理尺寸 : {w_ext} x {h_ext}\n"
            f"🎞️ 总帧数量 : {frames_written} 帧\n"
            f"📉 视频帧率 : {fps:g} FPS\n"
            f"💾 文件体积 : {size_mb:.2f} MB\n"
            f"📼 编码格式 : {ext.upper()}" + ("（含源音轨）" if has_audio else "") + "\n"
            + _tune_text(tune)
            + f"⚙️ 编码档位 : {used_label}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"✅ 输出路径 : {file_path}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━"
        ),
    }


def _safe_name(s):
    """文件名安全化：Windows 文件名不允许 <>:"/\\|?* 与控制符，一律换成连字符。

    子图内的节点 unique_id 形如 1377:1264，直接拼进文件名时冒号会被 Windows
    当成 NTFS 备用数据流(ADS)分隔符——数据写进隐藏的 :1264_0001.mp4 流，
    真正落盘的是名为「前缀_N1377」的 0 字节空文件，且 os.path.exists 仍为真，
    直到 os.replace 才抛 WinError 87，报错点离真因很远，极难排查。
    用户手填的文件前缀同样可能含有这些字符，一并处理。

    结尾的点和空格必须自己剥：Windows 落盘时会静默去掉它们，报告里显示的
    名字就和盘上实际的不是同一个，用户照着报告去找文件会找不到。
    """
    t = "".join("-" if (c in '<>:"/\\|?*' or ord(c) < 32) else c for c in str(s))
    # 40 字上限：前缀后面还要接 _N节点号_0001.mp4，Windows 整条路径只到 260
    return t.strip().rstrip(". ")[:40].rstrip(". ")


def _strip_view_ds(workflow_data):
    """删除工作流里保存的画布视角(extra.ds)。

    视频合并嵌入元数据时会把当前画布视角一并写进视频；该视角常指着
    某个放大后的角落，拖回 ComfyUI 时只看到几个节点，其余全在画面外
    （被误认为"工作流错位"）。删掉它之后，ComfyUI 拖入视频时会自动
    "适应画布"，所有节点一次全部落入窗口（实测 39/39 节点可见）。
    """
    if not isinstance(workflow_data, dict):
        return
    extra = workflow_data.get("extra")
    if isinstance(extra, dict):
        extra.pop("ds", None)


# 声明式收片：产出方自己说清「我是哪一片哪一段的什么片」，收片方不再扫全图猜拓扑。
_BZ_DECODE_TYPES = ("VAEDecode", "VAEDecodeAudio", "VAEDecodeTiled",
                    "BanZhang_H3VAEDecodeFast")
_BZ_ARCH_TYPES = ("MiniMaxH3MotionContextSaveLatent", "BanZhang_H3_ClipArchive")


def _declare_film_identity(prompt, node_id):
    """从本次提交的 API prompt 读工程身份，判明「我是哪一采的片」。

    身份只认导演台 h3_data.chain，与裸跑自动收片同一口径。

    为什么光有段 id 不够（20261106 三采工作流实测）
    -------------------------------------------------
    一采 / 二采 / 三采各有一个🎥 视频合并节点，三个节点读的是**同一份** h3_data，
    所以 bz_cid 一模一样 —— 只按 cid 筛会把三采的片全浮上来，收片端只能报
    「有多个合并节点都声明为这一段」然后拒收。

    20261111 阶段 1：💾 续接存档已并入 🎬 H3 VAE 快速解码、画布不再放存档节点，
    「收哪一采」改由**阶段**裁决。所以这里自报两件事：
      · bz_role —— 我这张画面是不是直接从 VAE 解码来的；
      · bz_stage —— 这一路解码的 latent 上游有没有「🎬 H3 终极放大」：
        有 = s2 二采，没有 = s1 一采。判据与写盘方共用
        csglide_ticket.decode_stage()，两边绝不会各猜一套。
        收片端按时间轴当前选中阶段筛。

    20261111 阶段 C（Q7=C）：再自报一件事 —— bz_variant。链上出现 RelayVSR
    节点就是「三采最终成品」(final)，否则是「二采原片」(raw)。判据只认节点
    类型、不认节点编号，换工作流照样生效；三采是像素域超分、只可能接在二采
    之后，所以阶段直接判 s2，不再往上游猜。
    """
    graph = prompt if isinstance(prompt, dict) else {}

    def _arch_on(spec):
        val = ((spec or {}).get("inputs") or {}).get("archive_enabled", True)
        if isinstance(val, bool):
            return val
        return str(val).strip().lower() not in ("", "0", "false")

    # ---- 身份：片名 + 段 id ----
    name = cid = ""
    for spec in graph.values():
        if not isinstance(spec, dict) or spec.get("class_type") != "CSGlideCastCS":
            continue
        raw = (spec.get("inputs") or {}).get("h3_data")
        if not isinstance(raw, str) or not raw.strip():
            continue
        try:
            ch = json.loads(raw).get("chain") or {}
        except Exception:
            continue
        name = str(ch.get("name") or "").strip()
        cid = str(ch.get("clip") or "").strip()
        shot = str(ch.get("shot") or "").strip()
        if name and not cid and shot:
            # 提交编译清空 clip；按 shot uid 反查本段 id，否则视频合并节点
            # 会被判成「没有片名或段 id」而丢失归属（20261107 真机日志）。
            try:
                from . import csglide_chain as _c
                from .csglide_ticket import resolve_clip_id
                cid = resolve_clip_id(name, "", shot, _c.film_summary)
            except Exception:
                cid = ""
        if name and cid:
            break

    # ---- 角色：只看自己的输入链，8 跳以内碰到 VAE 解码就是分段片 ----
    # 碰到**另一个视频合并节点**必须停：超分/插帧那条链的画面就来自上一采的
    # 合并节点，放任继续爬会把「超分」也算成分段片（三采工作流 #458 实测）。
    # 唯一例外是三采：链上先见到 RelayVSR 之后才允许穿过那个合并节点，否则
    # 三采成品永远停在「另一个合并节点」上，Q7=C 的两份成片就收不全。
    role, why = "none", "没认出图像输入的来源"
    cur = graph.get(str(node_id)) or {}
    frontier = [(str(v[0]), v[1]) for v in (cur.get("inputs") or {}).values()
                if isinstance(v, list) and len(v) == 2]
    seen, decodes, vsr_nodes = set(), [], []
    for _ in range(8):
        if not frontier or (decodes and not vsr_nodes):
            break
        nxt = []
        for nid, out_idx in frontier:
            if nid in seen:
                continue
            seen.add(nid)
            spec = graph.get(nid) or {}
            cls = str(spec.get("class_type") or "")
            if cls in _BZ_DECODE_TYPES:
                decodes.append(nid)
                role, why = "segment", "上游 #%s %s 是 VAE 解码" % (nid, cls)
                continue
            if "RelayVSR" in cls:
                vsr_nodes.append(nid)   # 像素域超分，不产出 latent，继续往上摸
            if cls == "CSGlideCastCS":
                # 导演台输出口 20261106 置顶重排：「整片」从第 8 口(7)挪到第 9 口(8)
                if int(out_idx or -1) == 8:
                    role, why = "whole", "上游是导演台「整片」输出口"
                else:
                    why = "上游是导演台非整片输出口"
                continue
            if "VideoCombine" in cls and not vsr_nodes:
                continue          # 衍生片：画面来自另一采的合并节点
            for v in (spec.get("inputs") or {}).values():
                if isinstance(v, list) and len(v) == 2:
                    nxt.append((str(v[0]), v[1]))
        frontier = nxt
    if vsr_nodes and role != "segment":
        role = "segment"
        why = "上游 #%s 是 RelayVSR 三采超分（三采成品）" % vsr_nodes[0]

    # ---- 阶段：从这一路的解码节点回溯，判一采/二采 ----
    # 与写盘方（VAE 快速解码 → banzhang_h3mc_archive）共用同一个函数，
    # 避免「存的是 s2、收片认成 s1」这种最难查的错。
    variant = "final" if vsr_nodes else "raw"
    variant_why = ("上游 #%s 是 RelayVSR 三采超分 → 三采最终成品" % vsr_nodes[0]
                   if vsr_nodes else "链上没有 RelayVSR → 原生采样成片")
    stage, stage_why = "s1", ""
    if vsr_nodes:
        # 三采是像素域超分，只可能接在二采之后；即使中间隔着二采的合并节点
        # 没摸到 VAE 解码，阶段也只能是 s2，不猜、不往上追。
        stage, stage_why = "s2", "三采 RelayVSR 只接在二采之后 → s2"
    elif role == "segment" and decodes:
        try:
            from .csglide_ticket import decode_stage
        except ImportError:
            from csglide_ticket import decode_stage
        stage = decode_stage(graph, decodes[0])
        stage_why = "解码 #%s 的 latent 上游%s「🎬 H3 终极放大」→ %s" % (
            decodes[0], "有" if stage == "s2" else "没有", stage)
    elif role != "segment":
        stage_why = "不是分段片，不判阶段"

    if not name or not cid:
        role, why = "none", "导演台 h3_data 里没有片名或段 id"
        stage = ""
    # bz_arch / bz_arch_on 是旧声明式收片的字段：存档节点已删除，留空只为让
    # 日志与结果面板的旧列不出错；收片端已改用 bz_stage。
    return {"bz_name": name, "bz_cid": cid, "bz_role": role, "bz_why": why,
            "bz_stage": stage, "bz_stage_why": stage_why,
            "bz_variant": variant, "bz_variant_why": variant_why,
            "bz_arch": "", "bz_arch_on": False,
            "bz_arch_why": "存档节点已并入 VAE 快速解码，改按阶段认片"}


提示音静音项 = "🔇 不播放提示音"


def _list_notify_sounds():
    """扫描本包 sounds 目录下的提示音文件，notify.mp3 排在最前。

    首项是可见的静音选项：静音本就是「提示音文件」这一个控件的状态之一，
    原先额外挂一个布尔开关承载它，两个控件会自相矛盾（关着开关却选了 mp3）。
    末尾保留 '' 兼容位：旧工作流按位置回填时可能塞进空字符串，
    少了这一项 ComfyUI 校验会直接报 Value not in list。
    """
    files = [提示音静音项]
    sounds_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sounds")
    if os.path.exists(sounds_dir):
        try:
            scanned = [f for f in os.listdir(sounds_dir) if f.lower().endswith(('.mp3', '.wav'))]
        except Exception:
            scanned = []
        if "notify.mp3" in scanned:
            scanned.remove("notify.mp3")
            scanned.insert(0, "notify.mp3")
        files += scanned
    if len(files) == 1:
        files.append("notify.mp3")
    files.append("")
    return files


# ==========================================
# 视频合并节点
# ==========================================
class banzhangVideoCombine:
    """
    班长: 图像序列转视频 (V3.8)
    将 ComfyUI IMAGE 批次转换为视频文件，支持音频叠加。
    """

    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"

    # === VIDEO 输入：解析上游文件路径（兼容字符串 & ComfyUI {filename,subfolder,type}） ===
    def _resolve_video_path(self, video_val):
        if not video_val:
            return ""
        if isinstance(video_val, dict):
            try:
                base = folder_paths.get_annotated_filepath(video_val)
            except Exception:
                base = ""
            if not base:
                base = video_val.get("filename", "") or ""
            # 若拿到的是相对/基础名，尝试在输出目录拼接回退
            for cand in (base, os.path.join(self.output_dir, os.path.basename(base))):
                if cand and os.path.isfile(cand):
                    return cand
            return base
        # ComfyUI VIDEO 对象（RIFE 插帧 / DLSS5 插帧等节点的输出）：取背后的成品文件路径
        if not isinstance(video_val, str):
            getter = getattr(video_val, "get_stream_source", None)
            if callable(getter):
                try:
                    info = getter()
                except Exception:
                    info = None
                if isinstance(info, (tuple, list)) and info:
                    path = str(info[0])
                    return path if os.path.exists(path) else ""
                if isinstance(info, str) and os.path.exists(info):
                    return info
            return ""
        s = str(video_val)
        if os.path.isfile(s):
            return s
        try:
            resolved = folder_paths.get_annotated_filepath(s)
            if resolved and os.path.isfile(resolved):
                return resolved
        except Exception:
            pass
        cand = os.path.join(self.output_dir, os.path.basename(s))
        return cand if os.path.isfile(cand) else ""

    # === 直接采用成品视频文件：保存到自定义路径（唯一位置）或输出目录，不做重新编码 ===
    def _adopt_existing(self, src_path, prefix, node_id, custom_path, prompt_data=None, extra_pnginfo_data=None, save_metadata=True, want_ext=""):
        源容器 = os.path.splitext(src_path)[1].lstrip(".").lower() or "mp4"
        src_ext = 源容器
        # 自定义路径生效时为唯一保存位置，output 不再留文件（预览走 /banzhang_api/video_file 接口）
        save_dir = self._解析保存目录(custom_path)

        save_prefix = f"{_safe_name(prefix) or '班长作品'}_N{_safe_name(node_id)}"

        # 本分支原来一律沿用源容器，等于把「📼 视频格式」当空气——选 MKV 防损坏、
        # 选 MOV 网页兼容，出来的仍是源 mp4，界面还一声不响。同族容器（mp4/mov/mkv）
        # 用流复制换壳零画质损失；跨族（GIF/WEBP/ProRes）换不了，就当场说明并保持
        # 源格式，绝不静默错配。
        fmt_note = ""
        want = str(want_ext or "").lower()
        需要换壳 = False
        if want and want != src_ext:
            if want in ("mp4", "mov", "mkv") and src_ext in ("mp4", "mov", "m4v", "mkv"):
                src_ext = want
                需要换壳 = True
            else:
                fmt_note = (f"\n⚠️ 「采用成品」模式无法输出 {want.upper()}，已保持源格式 .{src_ext}"
                            f"（要真转格式请断开「🎬 视频文件」只接「🖼️ 图像」）")

        file_name, file_path, _ = self._next_path(save_dir, save_prefix, src_ext)

        # 优先 ffmpeg 流复制嵌入工作流元数据（拖入 ComfyUI 可还原工作流）；
        # 换容器也走这条链路，「换壳 + 嵌元数据」一步完成，失败才回退普通复制。
        embed_done = False
        if _has_ffmpeg() and (save_metadata or 需要换壳) and src_ext in ("mp4", "mov", "m4v", "mkv", "webm"):
            adopt_meta = {}
            if save_metadata:
                if prompt_data is not None:
                    adopt_meta["prompt"] = json.dumps(prompt_data)
                if isinstance(extra_pnginfo_data, dict) and extra_pnginfo_data.get("workflow"):
                    _strip_view_ds(extra_pnginfo_data["workflow"])
                    adopt_meta["workflow"] = json.dumps(extra_pnginfo_data["workflow"])
            if adopt_meta or 需要换壳:
                if _embed_workflow_metadata(src_path, file_path, adopt_meta, src_ext):
                    embed_done = True
                    if adopt_meta:
                        print(f"[Banzhang] 已嵌入工作流元数据: {file_path}")
        if not embed_done:
            if 需要换壳:
                # 换壳失败：退回源容器，宁可格式不符也绝不写出打不开的文件
                try:
                    if os.path.isfile(file_path):
                        os.remove(file_path)
                except Exception:
                    pass
                src_ext = 源容器
                file_name, file_path, _ = self._next_path(save_dir, save_prefix, src_ext)
                fmt_note = f"\n⚠️ 换容器到 .{want} 失败，已回退源格式 .{源容器}"
            shutil.copy2(src_path, file_path)

        # 尽力探测源视频信息（失败则显示未知）
        # fps / 帧数一并返回给前端：同步预览要按帧号寻址，靠前端从详情文本
        # 正则猜帧率会猜错（解析不到就默认 24），对齐基准必须是真值。
        width = height = n_frames = duration_sec = fps = None
        if HAS_AV:
            try:
                with av.open(src_path) as c:
                    vs = c.streams.video[0]
                    width, height = vs.width, vs.height
                    n_frames = vs.frames or None
                    duration_sec = (c.duration or 0) / 1_000_000.0
                    if vs.average_rate:
                        fps = float(vs.average_rate)
            except Exception:
                pass

        f_size = os.path.getsize(file_path) / (1024 * 1024)
        w_txt = f"{width}" if width else "未知"
        h_txt = f"{height}" if height else "未知"
        f_txt = f"{n_frames}" if n_frames else "未知"
        dur_txt = f"{int(duration_sec)}" if duration_sec else "未知"
        fps_txt = f"{fps:g}" if fps else "未知"

        detail_report = (
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"📂 文件名称 : {file_name}\n"
            f"📏 物理尺寸 : {w_txt} x {h_txt}\n"
            f"🎞️ 总帧数量 : {f_txt} 帧\n"
            f"⏱️ 播放时长 : {dur_txt} 秒\n"
            f"📉 视频帧率 : {fps_txt} FPS\n"
            f"💾 文件体积 : {f_size:.2f} MB\n"
            f"📼 编码格式 : {src_ext.upper()} (成品)\n"
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"✅ 输出路径 : {file_path}{fmt_note}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━"
        )

        if custom_path and custom_path.strip():
            abs_path = file_path
        else:
            abs_path = ""

        _declare = _declare_film_identity(prompt_data, node_id)
        return {
            "ui": {
                "painter_output": [dict(
                    {"filename": file_name, "subfolder": "", "type": "output",
                     "abs_path": abs_path, "src_path": file_path,
                     "fps": fps, "frame_count": n_frames}, **_declare)],
                "detail_info": [detail_report]
            },
            "result": ()
        }

    # === 图片模式：逐张保存为 PNG（可选择嵌入工作流元数据），不走视频编码 ===
    def _save_images(self, images, prefix, node_id, custom_path, prompt_data, extra_pnginfo_data, save_metadata, audio=None):
        if not HAS_PIL:
            raise RuntimeError("缺少 Pillow，无法保存图片")

        save_dir = self._解析保存目录(custom_path)

        save_prefix = f"{_safe_name(prefix) or '班长作品'}_N{_safe_name(node_id)}"
        n_frames, h, w, c = images.shape

        metadata = None
        if save_metadata:
            metadata = PngInfo()
            if prompt_data is not None:
                metadata.add_text("prompt", json.dumps(prompt_data))
            if extra_pnginfo_data is not None:
                for key in extra_pnginfo_data:
                    metadata.add_text(key, json.dumps(extra_pnginfo_data[key]))

        saved = []
        for i in range(n_frames):
            file_name, file_path, _ = self._next_path(save_dir, save_prefix, "png")
            img_np = np.ascontiguousarray((images[i].detach().cpu().numpy() * 255).astype(np.uint8))
            Image.fromarray(img_np).save(file_path, pnginfo=metadata, compress_level=4)
            saved.append((file_name, file_path))

        total_mb = sum(os.path.getsize(p) for _, p in saved) / (1024 * 1024)
        if custom_path and custom_path.strip():
            abs_path = saved[0][1]
        else:
            abs_path = ""

        path_txt = "\n".join(p for _, p in saved) if len(saved) > 1 else saved[0][1]
        detail_report = (
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"📂 文件名称 : {saved[0][0]}"
            + (f"\n🖼️ 图片数量 : {len(saved)} 张" if len(saved) > 1 else "") + "\n"
            f"📏 物理尺寸 : {w} x {h}\n"
            f"💾 文件体积 : {total_mb:.2f} MB\n"
            f"📄 编码格式 : PNG (图片)\n"
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"✅ 输出路径 : {path_txt}" +
            ("\n⚠️ 图片模式不支持音频，音频已被忽略" if audio is not None else "") + "\n"
            f"━━━━━━━━━━━━━━━━━━━━━━"
        )

        return {
            "ui": {
                "painter_output": [{"filename": n, "subfolder": "", "type": "output",
                                    "abs_path": abs_path} for n, _ in saved],
                "detail_info": [detail_report]
            },
            # 图片模式没有视频：第 2 路明确给空，避免下游拿到上一轮的对象
            "result": (images, None, audio)
        }

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "⏱️ 帧率": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.01}),
                "📼 视频格式": ([
                    "MP4 (H264/通用)",
                    "MP4 (H265/高画质)",
                    "MOV (H264/网页兼容)",
                    "MOV (ProRes/专业剪辑)",
                    "MKV (H264/防损坏)",
                    "WEBM (网页/透明)",
                    "GIF (动图)",
                    "WEBP (动图)",
                ],),
                "🏷️ 文件前缀": ("STRING", {"default": "班长作品"}),
                "💾 保存元数据": ("BOOLEAN", {"default": True}),
                # 提示音（从原「全能显存净化」节点迁来）：默认静音，避免旧工作流突然发声
                "🔔 提示音文件": (_list_notify_sounds(), {"default": 提示音静音项,
                                          "tooltip": "出片完成后播放的提示音；选「🔇 不播放提示音」即静音"}),
                # 新增控件必须追加在末尾：ComfyUI 旧工作流按位置（而非名称）回填 widgets_values，
                # 插到中间会让旧工作流的帧率/格式/前缀整体错位一格
                "🧹 出片后自动净化": ("BOOLEAN", {"default": True, "label_on": "开", "label_off": "关",
                                          "tooltip": "出片完成后自动卸载模型并清理显存缓存（与「🧹 全能系统净化」同一套清理逻辑）"}),
            },
            "optional": {
                "🖼️ 图像": ("IMAGE",),
                "🎬 视频文件": ("VIDEO",),
                "🎵 音频": ("AUDIO",),
                "📂 自定义保存路径": ("STRING", {"default": ""}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID"
            }
        }

    # 「🎬 视频透传」原来是文件路径字符串，已换成真正的 VIDEO 对象（位置不变，
    # 旧工作流连在这根线上的第 2 位依然成立）。换的原因：对象是超集 ——
    # 路径型下游（视频合并 / RIFE / NVIDIA VFX）走 get_stream_source 认它，
    # 组件型下游（DLSS5 补帧 / 分辨率）走 get_components 只认对象、喂字符串会崩。
    RETURN_TYPES = ("IMAGE", "VIDEO", "AUDIO")
    RETURN_NAMES = ("🖼️ 图像透传", "📹 视频对象", "🎵 音频透传")
    OUTPUT_NODE = True
    CATEGORY = "👨‍🏫班长/视频处理"
    FUNCTION = "execute_combine"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """永远判定为「变了」：NaN 不等于任何值（包括它自己），ComfyUI 的缓存比对
        必然不等 —— 于是每次点运行都真的重跑，不会像之前那样第二次起被整节点跳过。
        与「🧹 全能系统净化」节点同一套做法，界面参数一个不加。
        """
        return float("NaN")

    def _play_notify(self, file_name):
        """出片完成后播放提示音。走后台线程，不挡住出片流程。"""
        def _run():
            try:
                path = file_name
                if not os.path.isabs(path):
                    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sounds", path)
                if not os.path.exists(path):
                    return
                # MCI 只认短路径：长路径/中文路径必须先转换，否则 open 会静默失败
                buffer = ctypes.create_unicode_buffer(260)
                ctypes.windll.kernel32.GetShortPathNameW(path, buffer, 260)
                short_path = buffer.value
                alias = "bz_video_notify"
                mci = ctypes.windll.winmm.mciSendStringW
                mci(f"close {alias}", None, 0, 0)
                if mci(f"open \"{short_path}\" type mpegvideo alias {alias}", None, 0, 0):
                    mci(f"open \"{short_path}\" alias {alias}", None, 0, 0)
                mci(f"setaudio {alias} volume to 1000", None, 0, 0)
                mci(f"play {alias} wait", None, 0, 0)
                mci(f"close {alias}", None, 0, 0)
            except Exception as e:
                print(f"[Banzhang] 提示音播放失败: {e}")

        threading.Thread(target=_run, daemon=True).start()

    @staticmethod
    def _帧源引用次数(prompt, node_id):
        """找出「🖼️ 图像」输入指向的上游 [节点, 槽]，并数完全图对它的引用次数（含自己）。"""
        me = str(node_id)
        node = (prompt or {}).get(me)
        link = ((node or {}).get("inputs") or {}).get("🖼️ 图像")
        if not (isinstance(link, list) and len(link) == 2):
            return None, 0
        key = (str(link[0]), link[1])
        次数 = 0
        try:
            for nid, other in prompt.items():
                if not isinstance(other, dict):
                    continue
                for v in (other.get("inputs") or {}).values():
                    if isinstance(v, list) and len(v) == 2 and (str(v[0]), v[1]) == key:
                        次数 += 1
        except Exception:
            return None, 0
        return key, 次数

    def _回收已消费帧(self, prompt, node_id, images):
        """出片成功后，把刚消费完的那份整段帧从执行器缓存里摘掉。

        为什么这条路走得通：内核把释放能力通过 extra_ram_release 暴露给节点
        （execution.py:806 自己跑完一个节点就调它），是官方通道，不是后门。
        闸门必须严：free_active=True 是按「评分」挑条目（往轮的先走、同轮最大的
        先走），不是按身份挑 —— 所以只在确认这份张量除了本节点没人用时才发起，
        且只申请刚好覆盖它的量，避免波及别人还要用的中间结果。
        """
        if images is None or not hasattr(images, "numel"):
            return
        size = int(images.numel() * images.element_size())
        if size < 256 * 1024 ** 2:
            return
        _key, 次数 = self._帧源引用次数(prompt, node_id)
        if 次数 != 1:
            return
        try:
            import comfy.model_management as mm
            from comfy.system_memory import virtual_memory_available
            if not hasattr(mm, "extra_ram_release"):
                return
            before = virtual_memory_available()
            freed = mm.extra_ram_release(before + size, free_active=True)
            after = virtual_memory_available()
            print(f"♻️ [视频合并] 这一段的帧已消费完，回收 {freed/1024**3:.2f} GB"
                  f"（可用内存 {before/1024**3:.1f} → {after/1024**3:.1f} GB）")
        except Exception as e:
            print(f"[视频合并] 回收中间结果失败（不影响出片）: {e}")

    def execute_combine(self, **kwargs):
        """唯一出口：先出片，再按开关做显存净化。

        净化放 finally：出片成功要回收，出片失败更要回收——失败时张量与
        编码器残留仍在显存里，不清理会让用户重跑时更容易 OOM，把一次
        参数错误放大成连续失败。异常只打印，绝不掩盖原始报错。
        """
        # 本节点 OUTPUT_NODE=True，ComfyUI 收执行入口时只认这个标志、不认连线，
        # 摆在画布上没接线的空节点也会被送进来，然后「无输入」raise 把整轮 prompt
        # 打断，连真正要跑的节点一起停。这里在进主流程前把「纯摆着」挑掉：
        # 既没有任何输入连线，也没有任何下游消费 → 本轮用不到它。
        # 放在 try 之前 return，finally 的净化也一并跳过（空节点不该占一次深度清理）。
        if not self._本节点已接线(kwargs.get("prompt"), kwargs.get("unique_id")) \
                and not self._有下游消费(kwargs.get("prompt"), kwargs.get("unique_id")):
            print("⏭️ [视频合并] 未接线且无下游 → 跳过（不报错，不影响本轮其他节点）")
            return {"ui": {}, "result": (None, None, None)}
        try:
            ret = self._combine_impl(**kwargs)
            # 先在 composer 之外把这段的整段帧还给执行器缓存：后面的净化只管显存，
            # 内存侧这一刀只有这里能落。
            self._回收已消费帧(kwargs.get("prompt"), kwargs.get("unique_id"),
                               kwargs.get("🖼️ 图像"))
            return self._按需透传(ret, kwargs)
        finally:
            if kwargs.get("🧹 出片后自动净化", True):
                self._出片后净化()

    # ---------- 空节点识别：OUTPUT_NODE 标志不看连线，得自己判 ----------
    @staticmethod
    def _本节点已接线(prompt, node_id):
        """本节点 inputs 里有没有任何一项指向别的节点。

        判不出来（拿不到 prompt / 找不到自己）一律按「已接线」返回：
        宁可保留原来的报错，也不能把「真连错了」静默吞成跳过。
        """
        if not prompt or node_id is None:
            return True
        me = str(node_id)
        try:
            node = next((n for k, n in prompt.items()
                         if str(k) == me and isinstance(n, dict)), None)
            if node is None:
                return True
            for v in (node.get("inputs") or {}).values():
                if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int):
                    return True
            return False
        except Exception:
            return True

    @staticmethod
    def _有下游消费(prompt, node_id):
        """任何下游节点把本节点任一输出当输入（三路输出都算）。

        只接输出不接输入属于「接错了」，必须让它报错，所以这条单独判。
        """
        if not prompt or node_id is None:
            return True
        me = str(node_id)
        try:
            for nid, node in prompt.items():
                if str(nid) == me or not isinstance(node, dict):
                    continue
                for v in (node.get("inputs") or {}).values():
                    if isinstance(v, list) and len(v) == 2 and str(v[0]) == me and isinstance(v[1], int):
                        return True
        except Exception:
            return True
        return False

    # ---------- 图像透传：没人接就不许占着整段帧 ----------
    @staticmethod
    def _图像透传有下游(prompt, node_id):
        """扫一遍 API 工作流：有没有任何节点把 [本节点, 0] 当输入。

        判据是「连没连线」，不是「跑没跑」—— 下游被分组忽略或执行失败时依旧
        保留整段，宁可多占内存也不让下游拿到空张量。拿不到工作流时同样保留。
        """
        if not prompt or node_id is None:
            return True
        me = str(node_id)
        try:
            for nid, node in prompt.items():
                if str(nid) == me or not isinstance(node, dict):
                    continue
                for v in (node.get("inputs") or {}).values():
                    if isinstance(v, list) and len(v) == 2 and str(v[0]) == me and v[1] == 0:
                        return True
        except Exception:
            # 各版本对 hidden PROMPT 的包装不一致；判不出来就按「有人接」处理，
            # 宁可多占一份内存，也不能让透传判断把出片流程带崩。
            return True
        return False

    def _按需透传(self, ret, kwargs):
        """图像透传无人消费时只返回首帧。

        省的不是拷贝：ComfyUI 的输出缓存在本轮内不可驱逐（caching.py 的
        ram_release 会跳过 used_generation 相同的条目），515 帧 float32 会
        在内存里钉到整轮结束 —— 二采/三采各约 4.6 GiB，净化节点碰不到它。
        必须 clone：切片是视图，视图仍挂着整段 storage，等于没放。
        """
        if not isinstance(ret, dict):
            return ret
        result = ret.get("result")
        if not isinstance(result, tuple) or not result:
            return ret
        images = result[0]
        if images is None or not hasattr(images, "shape") or int(images.shape[0]) <= 1:
            return ret
        if self._图像透传有下游(kwargs.get("prompt"), kwargs.get("unique_id")):
            return ret
        帧数 = int(images.shape[0])
        释放GB = images.numel() * images.element_size() / 1024 ** 3
        ret["result"] = (images[:1].clone(),) + tuple(result[1:])
        print(f"🧠 [视频合并] 图像透传无人接 → 只留首帧，释放内存 {释放GB:.2f} GB（{帧数 - 1} 帧）")
        return ret

    def _出片后净化(self):
        """与「🧹 全能系统净化」共用同一套清理实现（卸载模型 + 清缓存 + VBAR 深度回收）。"""
        try:
            import comfy.model_management as 模型管理
            清理前 = 模型管理.get_free_memory()
            from .banzhang_vram_cleaner import 执行深度清理
            执行深度清理(True, True)
            释放 = (模型管理.get_free_memory() - 清理前) / 1024**3
            print(f"🧹 [视频合并] 出片后自动净化 | 释放显存 {释放:.2f} GB")
        except Exception as e:
            print(f"[视频合并] ⚠️ 自动净化失败（不影响出片）: {e}")

    # ==========================================================
    #  出片主流程（原 _combine_impl 447 行拆分为 8 步）
    # ==========================================================
    def _combine_impl(self, **kwargs):
        """4 个出口：成品直采 / 单图存 PNG / 编码出片 / 无输入报错。

        原来这 447 行挤在一个函数里：命名、编码、动图、报告、清理各写一遍，
        连失败时的返回值都有两套（编码失败丢音频、异常保留音频）。拆分的判据
        是「这段是否需要独立的失败语义与独立的收尾」，而不是按行数硬切。
        """
        try:
            ctx = self._读参数(kwargs)

            # 出口 1：接了成品视频 → 直接采用，不重新编码
            if ctx["src_path"]:
                return self._出口成品直采(ctx)

            # 出口 2：图片也没接
            if ctx["images"] is None:
                if ctx["帧流"] is not None:
                    return self._出口帧流(ctx)
                raise RuntimeError("未接入 🖼️ 图像 或 🎬 视频文件，请至少连接一个输入")

            # 尺寸在这里才取：VIDEO 采用分支不需要碰图像张量
            ctx.update(self._读尺寸(ctx["images"]))

            # 出口 3：单张图且没接音频 → 存 PNG（接了音频说明就是要一段视频）
            if ctx["n_frames"] == 1 and ctx["audio"] is None:
                return self._save_images(ctx["images"], ctx["prefix"], ctx["node_id"],
                                         ctx["custom_path"], ctx["prompt"],
                                         ctx["extra_pnginfo"], ctx["save_metadata"], ctx["audio"])

            # 出口 4：编码
            return self._出口编码(ctx)

        except Exception as e:
            import traceback
            traceback.print_exc()
            # 原样往上抛：ComfyUI 会把异常显示成红框，并且下游节点不再执行。
            # 之前这里返回正常结构，节点是绿的、下游拿 None 继续跑，用户以为成了。
            print(f"━━━━━━━━━━━━━━━━━━━━━━\n❌ [视频合并] 执行失败 : {e}\n━━━━━━━━━━━━━━━━━━━━━━")
            raise

    def _读参数(self, kwargs):
        """一次读全所有输入，后续步骤只认 ctx，不再各自 kwargs.get。"""
        fmt_str = kwargs.get("📼 视频格式", "MP4 (H264/通用)")
        video_src = kwargs.get("🎬 视频文件")
        ext_map = {"MP4": "mp4", "MOV": "mov", "MKV": "mkv", "WEBM": "webm", "GIF": "gif", "WEBP": "webp"}
        out_fps = float(kwargs.get("⏱️ 帧率", 24.0))
        print(f"[Banzhang] 合并参数 → 帧率={out_fps:g}")

        images = kwargs.get("🖼️ 图像")
        帧流 = kwargs.get("🎞️ 帧流")
        # 鸭子类型兼容: 「H3 VAE 快速解码」开了「帧流模式」后, 它的第0路「图像」口
        # 会直接吐 H3帧流 对象(而不是 torch.Tensor)。这里识别一下: 「🖼️ 图像」口
        # 拿到的对象若带「批次」方法(torch.Tensor 没有), 自动转成帧流走流式写盘,
        # 用户原来接「🖼️ 图像」的线一根都不用动。
        if 帧流 is None and images is not None and hasattr(images, "批次"):
            print("[视频合并] 「🖼️ 图像」口收到帧包对象 → 自动走流式写盘(解一块写一块)")
            帧流 = images
            images = None

        return {
            "images": images,
            "帧流": 帧流,
            "out_fps": out_fps,
            "fmt_str": fmt_str,
            # 容器后缀：VIDEO 采用分支也要按用户所选格式换壳，不能等编码分支才算
            "ext": next((v for k, v in ext_map.items() if k in fmt_str), "mp4"),
            "is_anim": ("GIF" in fmt_str or "WEBP" in fmt_str),
            "prefix": kwargs.get("🏷️ 文件前缀", "班长作品"),
            "node_id": kwargs.get("unique_id", "000"),
            "custom_path": kwargs.get("📂 自定义保存路径", ""),
            "save_metadata": kwargs.get("💾 保存元数据", True),
            "prompt": kwargs.get("prompt", None),
            "extra_pnginfo": kwargs.get("extra_pnginfo", None),
            "audio": kwargs.get("🎵 音频"),
            "提示音": kwargs.get("🔔 提示音文件") or 提示音静音项,
            "src_path": self._resolve_video_path(video_src),
            "audio_warning": "",
            "used_label": "",
        }

    @staticmethod
    def _读尺寸(images):
        try:
            n_frames, h, w = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
        except Exception:
            raise RuntimeError(
                f"🖼️ 图像 形状异常：{getattr(images, 'shape', type(images))}，应为 [帧数, 高, 宽, 通道]")
        # 奇数宽高裁 1 像素（yuv420p 要求偶数），从右下裁，构图偏左上半个像素
        return {"n_frames": n_frames, "h": h, "w": w,
                "w_ext": (w // 2) * 2, "h_ext": (h // 2) * 2}

    def _解析保存目录(self, custom_path):
        """把用户手填的保存路径变成可用的绝对目录；不行就用中文说清为什么。

        原来三处各写一遍 `os.makedirs(custom_path.strip())`，Windows 原始异常
        直接抛到界面：盘符不存在报「拒绝访问 WinError 5」、带引号粘贴报
        「语法不正确 WinError 123」、填成文件路径报「已存在 WinError 183」——
        每一条都看不出该改哪里。
        """
        raw = str(custom_path or "").strip()
        if not raw:
            return self.output_dir

        p = raw
        # 资源管理器「复制文件地址」带双引号；中文输入法下还可能粘成全角引号
        if len(p) >= 2 and p[0] in "\"'“”" and p[-1] in "\"'“”":
            p = p[1:-1].strip()
        if p.lower().startswith("file://"):
            p = p[7:]
            # file:///D:/作品 → 去掉多出来的前导斜杠
            if len(p) > 2 and p[0] in "/\\" and p[2] == ":":
                p = p[1:]
        p = os.path.expandvars(os.path.expanduser(p)).strip()

        if not os.path.isabs(p):
            raise RuntimeError(
                f"📂 自定义保存路径要填完整路径，例如 D:\\作品（现在填的是「{raw}」）")

        drive, _ = os.path.splitdrive(p)
        if drive and not os.path.exists(drive + os.sep):
            raise RuntimeError(
                f"📂 这台机器上没有 {drive} 盘，路径「{p}」用不了，请换成现有的盘")

        # 冒号只允许出现在盘符里：其余位置会被 Windows 当成 NTFS 数据流分隔符
        体 = p[len(drive):]
        非法 = sorted({c for c in 体 if c in '<>:"|?*' or ord(c) < 32})
        if 非法:
            raise RuntimeError(
                f"📂 路径里有不能用于文件夹名的字符：{' '.join(非法)}（请删掉后重填）")

        if os.path.exists(p) and not os.path.isdir(p):
            raise RuntimeError(
                f"📂「{p}」是一个文件，不是文件夹。请填文件夹路径，例如 D:\\作品")

        try:
            os.makedirs(p, exist_ok=True)
        except PermissionError as e:
            raise RuntimeError(
                f"📂 没有权限在「{p}」里写文件（{e.strerror or '拒绝访问'}）。"
                f"请换一个文件夹（例如 D:\\作品），或用管理员身份启动 ComfyUI") from None
        except OSError as e:
            raise RuntimeError(f"📂 无法创建文件夹「{p}」：{e.strerror or e}") from None
        return p

    @staticmethod
    def _next_path(save_dir, save_prefix, ext):
        """取下一个未被占用的编号文件名；编号按扩展名各自独立。

        全节点只有这一处编号逻辑：原来 _adopt_existing / _save_images / 编码
        分支各写一份 while，改一处忘两处是迟早的事。

        同名 .part 也算占用：编码失败留下的半成品若没被清掉，光判 .ext 会让
        这组编号被永久锁死 —— 下次还选同一个名字，再撞一次同一面墙。
        """
        n = 1
        while True:
            name = f"{save_prefix}_{n:04}.{ext}"
            path = os.path.join(save_dir, name)
            if not os.path.exists(path) and not os.path.exists(path + ".part"):
                return name, path, n
            n += 1

    def _响提示音(self, 提示音文件):
        if 提示音文件 and 提示音文件 != 提示音静音项:
            self._play_notify(提示音文件)

    @staticmethod
    def _包视频对象(file_path):
        """把落盘视频包成 ComfyUI 原生 VIDEO 对象（路径型与组件型下游都认它）。

        构造只存路径、不解码，开销可忽略。拿不到类或构造失败时退回文件路径字符串 ——
        这是本端口换型前的旧形态，路径型下游照样能用，比返回 None 让整条链断掉强。
        """
        if not file_path or not os.path.isfile(file_path):
            return None
        if _VideoFromFile is not None:
            try:
                return _VideoFromFile(file_path)
            except Exception as e:
                print(f"[Banzhang] 构造 VIDEO 对象失败，退回文件路径: {e}")
        else:
            print("[Banzhang] 当前 ComfyUI 无 VideoFromFile，视频透传退回文件路径")
        return file_path

    def _出口成品直采(self, ctx):
        """接了「🎬 视频文件」：采用上游成品，只按用户所选格式换壳，不重新编码。"""
        ret = self._adopt_existing(ctx["src_path"], ctx["prefix"], ctx["node_id"], ctx["custom_path"],
                                   ctx["prompt"], ctx["extra_pnginfo"], ctx["save_metadata"],
                                   want_ext=ctx["ext"])
        # 透传：图像原样 + 音频原样；视频给刚落盘的成品对象（已换壳、已嵌元数据）
        # —— 给成品而不是上游原件，是因为这一路本来就该代表「本节点产出的片子」
        成品路径 = (ret["ui"].get("painter_output") or [{}])[0].get("src_path", "")
        ret["result"] = ret["result"] + (ctx["images"], self._包视频对象(成品路径), ctx["audio"])
        self._响提示音(ctx["提示音"])
        return ret

    def _出口帧流(self, ctx):
        """接了「🎞️ 帧流」：帧已在解码节点里解成 uint8，这里只问尺寸再出片。

        动图 GIF/WEBP 与「无 video 支持」的回退路径必须整段持有才能编码，这两条
        直接一次性拼齐，表现与今天一致 —— 紧凑帧包只让 mp4/mov/mkv/webm 受益。
        """
        st = ctx["帧流"].解()  # 幂等：解码早在上一节点做过，这里立刻返回
        ctx.update({"n_frames": st.帧数, "h": st.高, "w": st.宽,
                    "w_ext": (st.宽 // 2) * 2, "h_ext": (st.高 // 2) * 2})
        if ctx["is_anim"] or not _has_ffmpeg():
            ctx["images"] = st.pull_all()
            ctx["帧流"] = None
            return self._出口编码(ctx)
        print(f"[Banzhang] 帧包出片：{st.帧数} 帧 {st.宽}x{st.高}，"
              f"写盘即编码（解码已在解码节点完成）")
        return self._出口编码(ctx)

    def _出口编码(self, ctx):
        """编码路径的唯一装配点：准备 → 按格式分派 → 写报告 → 返回。"""
        self._准备输出(ctx)

        if ctx["is_anim"]:
            self._编码动图(ctx)
        elif _has_ffmpeg():
            self._编码视频(ctx)
        else:
            self._编码视频回退(ctx)

        detail_report = self._出片报告(ctx)
        self._响提示音(ctx["提示音"])
        _declare = _declare_film_identity(ctx["prompt"], ctx["node_id"])
        return {
            "ui": {
                "painter_output": [dict(
                    {"filename": ctx["file_name"], "subfolder": ctx["sub_dir"], "type": "output",
                     "abs_path": ctx["abs_path"], "src_path": ctx["file_path"],
                     "fps": float(ctx["out_fps"]), "frame_count": ctx["n_frames"]}, **_declare)],
                "detail_info": [detail_report]
            },
            # 本分支是「图像+音频」现场编码出的新视频，video_src 必然为空。
            # 「📹 视频对象」直接指向刚落盘的成品文件。
            "result": (ctx["images"], self._包视频对象(ctx["file_path"]), ctx["audio"])
        }

    # ---------- 编码前准备 ----------
    def _准备输出(self, ctx):
        """编码前的一切准备：目标目录、唯一文件名、进度条、动图首帧元数据、
        音频 PCM 与截断、容器元数据、磁盘预检。"""
        custom_path = ctx["custom_path"]
        # 自定义路径生效时为唯一保存位置，output 不再留文件（预览走 /banzhang_api/video_file）
        ctx["save_dir"] = self._解析保存目录(custom_path)
        ctx["abs_path"] = ""      # 先占位，拿到 file_path 再填

        ctx["save_prefix"] = f"{_safe_name(ctx['prefix']) or '班长作品'}_N{_safe_name(ctx['node_id'])}"
        ctx["file_name"], ctx["file_path"], ctx["file_no"] = self._next_path(
            ctx["save_dir"], ctx["save_prefix"], ctx["ext"])
        if custom_path and custom_path.strip():
            ctx["abs_path"] = ctx["file_path"]
        ctx["sub_dir"] = ""
        ctx["pbar"] = ProgressBar(ctx["n_frames"]) if ProgressBar else None

        self._存动图首帧元数据(ctx)
        self._准备音频(ctx)
        self._准备容器元数据(ctx)

        if not ctx["is_anim"]:
            self._编码前预检(ctx)

    def _存动图首帧元数据(self, ctx):
        """mp4/mov/mkv/webm 已把工作流写进容器元数据，再存一份 PNG 是纯冗余；
        GIF/WEBP 走 Pillow 编码、容器存不了元数据，这张首帧是唯一的工作流载体。"""
        # 流式出片时 ctx["images"] 为 None（整段帧不存在），这里直接跳过
        if ctx["images"] is None:
            return
        if not (ctx["save_metadata"] and ctx["is_anim"] and ctx["n_frames"] > 0 and HAS_PIL):
            return
        try:
            first_frame = ctx["images"][0:1].cpu().numpy()
            pil_img = Image.fromarray((first_frame[0] * 255).astype(np.uint8))
            metadata = PngInfo()
            if ctx["prompt"] is not None:
                metadata.add_text("prompt", json.dumps(ctx["prompt"]))
            if ctx["extra_pnginfo"] is not None:
                for key in ctx["extra_pnginfo"]:
                    metadata.add_text(key, json.dumps(ctx["extra_pnginfo"][key]))
            meta_name = f"{ctx['save_prefix']}_{ctx['file_no']:04}_meta.png"
            pil_img.save(os.path.join(ctx["save_dir"], meta_name), pnginfo=metadata, compress_level=4)
        except Exception as meta_e:
            print(f"[Banzhang] metadata save failed: {meta_e}")

    def _准备音频(self, ctx):
        """AUDIO → PCM 16 位；重采样 + 按画面帧数补零/截断，音画严格对齐。

        旧实现只截尾不补短：音频比画面短时尾部是无声缺口；采样率直取源值，
        编码侧再 -ar 会二次换算。现在统一走 csglide_audio_align。
        BZ_AUDIO_TARGET_SR=48000 可强制统一重采样（默认跟随源采样率）。
        """
        ctx["pcm"] = ctx["sr"] = ctx["ch"] = None
        audio = ctx["audio"]
        if not audio:
            return
        if ctx["is_anim"]:
            ctx["audio_warning"] = "\n⚠️ GIF/WEBP 动图格式不支持音频，音频已被忽略"
            print(f"[Banzhang] {ctx['audio_warning'].strip()}")
            return

        # 局部变量不能叫 wave，会遮蔽标准库 wave 模块，导致后面写临时 WAV 失败、音频静默丢失
        wave_np = audio['waveform'][0].detach().cpu().numpy().astype(np.float32)
        sr = int(audio['sample_rate'])
        try:
            from .csglide_audio_align import align_audio
        except ImportError:
            from csglide_audio_align import align_audio
        pcm, out_sr, info = align_audio(
            wave_np, sr, int(ctx.get("n_frames") or 0), float(ctx.get("out_fps") or 0))
        ctx["pcm"], ctx["sr"], ctx["ch"] = pcm, out_sr, int(pcm.shape[0])

        seconds = info["video_seconds"]
        src_seconds = info["src_samples"] / max(1, info["out_sr"])
        if info["action"] == "pad":
            ctx["audio_warning"] = (
                f"\n🎵 音频(源 {src_seconds:.1f}s)短于画面 {seconds:.1f}s，"
                f"已补静音 {info['target_samples'] - info['src_samples']} 采样")
        elif info["action"] == "trim":
            ctx["audio_warning"] = (f"\n🎵 音频(源 {src_seconds:.1f}s)已按画面 "
                                    f"{seconds:.1f}s 截断尾部")
        if info["src_sr"] != info["out_sr"]:
            ctx["audio_warning"] = (ctx.get("audio_warning") or "") + (
                f"\n🎵 采样率 {info['src_sr']} → {info['out_sr']} Hz 已重采样")
        if ctx.get("audio_warning"):
            print(f"[Banzhang] {ctx['audio_warning'].strip()}")

    def _准备容器元数据(self, ctx):
        """键名与 ComfyUI 前端 ISOBMFF/WebM 解析器约定一致：prompt（API 格式）+ workflow（UI 格式）"""
        ctx["embed_meta"] = {}
        if not ctx["save_metadata"]:
            return
        if ctx["prompt"] is not None:
            ctx["embed_meta"]["prompt"] = json.dumps(ctx["prompt"])
        if isinstance(ctx["extra_pnginfo"], dict) and ctx["extra_pnginfo"].get("workflow"):
            _strip_view_ds(ctx["extra_pnginfo"]["workflow"])
            ctx["embed_meta"]["workflow"] = json.dumps(ctx["extra_pnginfo"]["workflow"])

    def _编码前预检(self, ctx):
        """腾显存给帧转换留余量；磁盘空间不够就提前报错（长视频最容易在这里翻车）。"""
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        try:
            if ctx["images"] is not None:
                frame_mem_gb = ctx["images"].element_size() * ctx["images"].nelement() / (1024 ** 3)
                print(f"[Banzhang] 待编码 {ctx['n_frames']} 帧 {ctx['w_ext']}x{ctx['h_ext']}，张量约 {frame_mem_gb:.2f} GB")
            else:
                print(f"[Banzhang] 待编码 {ctx['n_frames']} 帧 {ctx['w_ext']}x{ctx['h_ext']}，"
                      f"帧包模式（uint8，已解码）")
            usage = shutil.disk_usage(ctx["save_dir"])
            need_bytes = int(ctx["w_ext"] * ctx["h_ext"] * 3 * ctx["n_frames"] * 0.3) + 256 * 1024 * 1024
            if usage.free < need_bytes:
                raise RuntimeError(
                    f"磁盘空间不足：预计需要 {need_bytes / (1024 ** 3):.1f} GB，"
                    f"仅剩 {usage.free / (1024 ** 3):.1f} GB，请先清理或改保存路径")
            # 目录存在 ≠ 写得进去：只读属性、安全软件拦截、被别的进程锁住，
            # 只有真写一次才知道。放在编码前探，报错点就是「输出目录写不进去」；
            # 放到编码里，就变成五档参数全跑完后甩一句 ffmpeg 的 Permission denied。
            探针 = os.path.join(ctx["save_dir"], f".班长写入测试_{os.getpid()}.tmp")
            try:
                with open(探针, "wb") as 探针文件:
                    探针文件.write(b"0")
                os.remove(探针)
            except OSError as 写错误:
                raise RuntimeError(
                    f"输出目录写不进去：{ctx['save_dir']}（{写错误.strerror or 写错误}）\n"
                    f"常见原因：① 该目录里的文件正被播放器或资源管理器预览占用，关掉后重跑；"
                    f"② 杀毒软件拦截写入，把输出目录加入白名单；"
                    f"③ 目录只读或无权限，改「📂 自定义保存路径」到别的文件夹"
                ) from None
        except RuntimeError:
            raise
        except Exception as chk_e:
            print(f"[Banzhang] 磁盘预检跳过: {chk_e}")

    # ---------- 视频编码：ffmpeg 主路径 ----------
    def _编码视频(self, ctx):
        """ffmpeg 子进程编码：进程隔离，编码器原生崩溃只失败本节点，不拖垮 ComfyUI 主进程。"""
        file_path = ctx["file_path"]

        # 音频：先落临时 WAV（标准库 wave，无第三方依赖），作为 ffmpeg 第二输入
        wav_tmp, audio_args = None, []
        if ctx["pcm"] is not None:
            try:
                ch_use = 2 if ctx["ch"] >= 2 else 1
                wav_tmp = file_path + ".audiotmp.wav"
                with wave.open(wav_tmp, "wb") as wf:
                    wf.setnchannels(ch_use)
                    wf.setsampwidth(2)
                    wf.setframerate(ctx["sr"])
                    wf.writeframes(np.ascontiguousarray(ctx["pcm"][:ch_use].T).tobytes())
                acodec = "pcm_s16le" if "ProRes" in ctx["fmt_str"] else ("libopus" if "WEBM" in ctx["fmt_str"] else "aac")
                audio_args = ["-i", wav_tmp, "-c:a", acodec, "-b:a", "192k"]
                if acodec == "libopus":
                    audio_args += ["-ar", "48000"]
            except Exception as wav_e:
                ctx["audio_warning"] = f"\n⚠️ 音频写入临时文件失败，本段无音频: {wav_e}"
                print(f"[Banzhang] {ctx['audio_warning'].strip()}")
                if wav_tmp and os.path.exists(wav_tmp):
                    os.remove(wav_tmp)
                wav_tmp = None

        # stderr 落临时文件（避免管道缓冲写满导致与 stdin 喂帧互相死锁）
        part_path = file_path + ".part"
        err_tmp = file_path + ".ffmpegerr"
        out_fmt = {"mp4": "mp4", "mov": "mov", "mkv": "matroska", "webm": "webm"}.get(ctx["ext"])
        candidates = _build_encode_candidates(ctx["fmt_str"], ctx["w_ext"], ctx["h_ext"],
                                             ctx["n_frames"], ctx["ext"], ctx["out_fps"])
        # 输出时长硬锁 = 帧数/帧率：实测 48 帧 @24fps 精确截到 2.000s、48 帧不丢，
        # 而音频编码器多塞的 padding 被一起裁掉，画面不会定格
        时长上限 = ctx["n_frames"] / ctx["out_fps"] if (ctx["out_fps"] > 0 and ctx["n_frames"] > 0) else None
        ok, enc_err, ctx["used_label"] = _ffmpeg_encode_frames(
            ctx["images"], ctx["n_frames"], ctx["w_ext"], ctx["h_ext"], ctx["out_fps"],
            part_path, candidates, audio_args, err_tmp, ctx["pbar"], out_fmt, 时长上限,
            帧流=ctx.get("帧流")
        )
        for tmp_f in (err_tmp, wav_tmp):
            if tmp_f and os.path.exists(tmp_f):
                try:
                    os.remove(tmp_f)
                except Exception:
                    pass

        if not ok:
            part_saved = self._抢救碎片(part_path, ctx, out_fmt)
            权限类 = any(k in enc_err for k in _不可写错误特征)
            # 这句必须点名「不是画面问题」：用户看到 Permission denied 只会去改
            # 编码格式和分辨率，越改越远。
            指引 = ("\n👉 这是输出目录写不进去，不是画面或参数问题："
                    "关掉正在播放该目录视频的播放器 / 资源管理器预览窗格，"
                    "或把输出目录加入杀毒软件白名单，或改「📂 自定义保存路径」到别的文件夹。"
                    if 权限类 else "")
            detail_report = (
                f"━━━━━━━━━━━━━━━━━━━━━━\n"
                f"❌ 视频编码失败\n"
                f"{enc_err}{指引}\n"
                + (f"🛡️ 已保留部分成品（末尾片段可能不完整）：\n{part_saved}\n" if part_saved else "")
                + f"━━━━━━━━━━━━━━━━━━━━━━"
            )
            print(f"[Banzhang] {detail_report}")
            # 必须抛错：原来返回的是带 detail_info 的正常结构，节点显示绿色、
            # 下游拿着 None 继续跑，用户以为片子出来了。保存类节点失败就得红框。
            raise RuntimeError(
                f"视频编码失败：{enc_err}{指引}"
                + (f"｜已保留部分成品（末尾可能不完整）：{part_saved}" if part_saved else "")
            )

        self._收尾容器(part_path, ctx, out_fmt)

    def _抢救碎片(self, part_path, ctx, out_fmt):
        """全部档位失败时保留已编码的碎片作抢救成品，绝不删已生成内容。
        碎片末尾分片可能不完整：先试容错 remux，失败则原样保留。"""
        part_saved = ""
        try:
            if os.path.isfile(part_path) and os.path.getsize(part_path) > 0:
                part_final = os.path.join(
                    ctx["save_dir"], f"{ctx['save_prefix']}_{ctx['file_no']:04}_PART.{ctx['ext']}")
                if _ffmpeg_remux(part_path, part_final, ctx["ext"], out_fmt):
                    part_saved = part_final
                else:
                    os.replace(part_path, part_final)
                    part_saved = part_final
        except Exception as keep_e:
            print(f"[Banzhang] 保留部分成品失败: {keep_e}")
            if os.path.isfile(part_path):
                part_saved = part_path
        return part_saved

    def _收尾容器(self, part_path, ctx, out_fmt):
        """碎片文件 → 标准容器（重建 moov + faststart），并按需嵌入工作流元数据。"""
        file_path, ext = ctx["file_path"], ctx["ext"]
        try:
            if ctx["embed_meta"] and ext in ("mp4", "mov", "mkv", "webm"):
                tmp_path = file_path + ".embedtmp"
                if _embed_workflow_metadata(part_path, tmp_path, ctx["embed_meta"], ext):
                    os.replace(tmp_path, file_path)
                    print(f"[Banzhang] 已嵌入工作流元数据: {file_path}")
                else:
                    if os.path.isfile(tmp_path):
                        os.remove(tmp_path)
                    if not _ffmpeg_remux(part_path, file_path, ext, out_fmt):
                        os.replace(part_path, file_path)
            else:
                if not _ffmpeg_remux(part_path, file_path, ext, out_fmt):
                    os.replace(part_path, file_path)
        finally:
            if os.path.isfile(part_path):
                try:
                    os.remove(part_path)
                except Exception:
                    pass

    # ---------- 视频编码：PyAV 回退 ----------
    def _编码视频回退(self, ctx):
        """无 ffmpeg 可执行文件时用 PyAV 在主进程内编码（非首选路径）。"""
        if not HAS_AV:
            raise RuntimeError("缺少 ffmpeg(imageio_ffmpeg) 与 PyAV(av)，无法编码视频")
        file_path, fmt_str = ctx["file_path"], ctx["fmt_str"]
        pbar, n_frames = ctx["pbar"], ctx["n_frames"]
        w_ext, h_ext, out_fps = ctx["w_ext"], ctx["h_ext"], ctx["out_fps"]
        images, pcm, sr, ch = ctx["images"], ctx["pcm"], ctx["sr"], ctx["ch"]

        container = None
        av_ok = False
        try:
            container = av.open(file_path, mode="w")

            if "ProRes" in fmt_str:
                vcodec = "prores"
            elif "H265" in fmt_str:
                vcodec = "libx265"
            elif "WEBM" in fmt_str:
                vcodec = "libvpx-vp9"
            else:
                vcodec = "libx264"

            vstream = container.add_stream(vcodec, rate=fractions.Fraction(out_fps).limit_denominator(1000))
            vstream.width = w_ext
            vstream.height = h_ext
            vstream.pix_fmt = "yuv422p10le" if "ProRes" in fmt_str else "yuv420p"

            # 画质对齐：H264 CRF8 / H265 CRF4 / VP9 无损，preset slower
            if vcodec == "libx264":
                vstream.options["crf"] = "8"
                vstream.options["preset"] = "slower"
            elif vcodec == "libx265":
                vstream.options["crf"] = "4"
                vstream.options["preset"] = "slower"
                vstream.options["aq-mode"] = "3"
            elif vcodec == "libvpx-vp9":
                vstream.options["lossless"] = "1"

            # 音频流（通道数收敛到 1/2，s16p 平面布局逐通道送入）
            astream = None
            if pcm is not None:
                ch_use = 2 if ch >= 2 else 1
                acodec = "pcm_s16le" if "ProRes" in fmt_str else ("libopus" if "WEBM" in fmt_str else "aac")
                astream = container.add_stream(acodec, rate=sr)
                astream.layout = "stereo" if ch_use == 2 else "mono"

            # 逐帧编码（裁剪到偶数尺寸 + 色彩转换到流格式，满足 yuv420p 校验）
            for i in range(n_frames):
                frame_np = images[i].detach().cpu().numpy()
                # 上游 tensor 可能非 C-contiguous，PyAV from_ndarray 强制要求连续，此处统一保证
                frame_rgb = np.ascontiguousarray((frame_np[:h_ext, :w_ext] * 255).astype(np.uint8))
                vframe = av.VideoFrame.from_ndarray(frame_rgb, format="rgb24")
                vframe = vframe.reformat(width=w_ext, height=h_ext, format=vstream.pix_fmt)
                for packet in vstream.encode(vframe):
                    container.mux(packet)
                if pbar:
                    pbar.update(1)

            # 冲刷视频流尾帧
            for packet in vstream.encode():
                container.mux(packet)

            # 编码音频（s16p 平面格式，shape=通道×采样；残差/采样率交给 PyAV 内部重采样）
            if astream is not None:
                ch_use = 2 if ch >= 2 else 1
                # waveform 经上游变换后可能非 C-contiguous，from_ndarray 强制要求连续
                aframe = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm[:ch_use]),
                                                    format="s16p", layout=astream.layout)
                aframe.sample_rate = sr
                for packet in astream.encode(aframe):
                    container.mux(packet)
                for packet in astream.encode():
                    container.mux(packet)
            av_ok = True

        except Exception as enc_e:
            import traceback
            traceback.print_exc()
            # 与 ffmpeg 分支一致：编码失败必须红框，不能假绿让下游拿 None 继续跑
            raise RuntimeError(f"PyAV 编码失败：{enc_e}") from enc_e
        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass
            # close 会补写容器尾部，所以只能在 close 之后判断残留并删除
            if not av_ok:
                try:
                    if os.path.exists(file_path):
                        os.remove(file_path)
                except Exception:
                    pass

        # 元数据：ffmpeg 主路径在 _收尾容器 里已嵌，这里单独补一次。
        # 注意走回退编码时本函数的 _has_ffmpeg() 恒为 False（有 ffmpeg 就不会走回退），
        # 所以这段实际不执行；保留它是因为守卫条件对应「ffmpeg 检测逻辑若变更」的场景。
        if ctx["embed_meta"] and _has_ffmpeg() and ctx["ext"] in ("mp4", "mov", "mkv", "webm"):
            tmp_path = file_path + ".embedtmp"
            if _embed_workflow_metadata(file_path, tmp_path, ctx["embed_meta"], ctx["ext"]):
                os.replace(tmp_path, file_path)
                print(f"[Banzhang] 已嵌入工作流元数据: {file_path}")
            elif os.path.isfile(tmp_path):
                os.remove(tmp_path)

    # ---------- 动图编码 ----------
    def _编码动图(self, ctx):
        """GIF / WEBP：Pillow 直接编码动图，无需 ffmpeg。"""
        if not HAS_PIL:
            raise RuntimeError("缺少 Pillow，无法编码 GIF/WEBP 动图")
        if ctx["n_frames"] <= 0:
            raise RuntimeError("没有可编码的帧")

        images, n_frames = ctx["images"], ctx["n_frames"]
        h_ext, w_ext, out_fps = ctx["h_ext"], ctx["w_ext"], ctx["out_fps"]

        # 延迟按「格」做累计反推，误差不累积：直接给 int(1000/fps) 每帧都截断，
        # 24fps 算得 41ms 而 GIF 的延迟字段只有 1/100 秒精度、Pillow 再除 10 取整，
        # 实际落成 40ms —— 48 帧就少 48ms，一千帧能跑快十几秒。
        格 = 10 if "GIF" in ctx["fmt_str"] else 1

        def _帧延迟(i):
            return max(格, (int(round((i + 1) * 1000.0 / out_fps / 格))
                           - int(round(i * 1000.0 / out_fps / 格))) * 格)

        def _帧流(start):
            # 生成器惰性喂帧：先把所有帧转成 PIL 对象囤进 list，一千帧 4K 就是 25GB
            for i in range(start, n_frames):
                frame_np = images[i].detach().cpu().numpy()
                frame_rgb = np.ascontiguousarray((frame_np[:h_ext, :w_ext] * 255).astype(np.uint8))
                yield Image.fromarray(frame_rgb)

        首帧 = next(_帧流(0))
        首帧.save(ctx["file_path"], save_all=True, append_images=_帧流(1),
                  duration=[_帧延迟(i) for i in range(n_frames)], loop=0, optimize=False)
        if ctx["pbar"]:
            ctx["pbar"].update(n_frames)

    # ---------- 详情面板 ----------
    def _出片报告(self, ctx):
        file_path, n_frames, out_fps = ctx["file_path"], ctx["n_frames"], ctx["out_fps"]
        f_size = os.path.getsize(file_path) / (1024 * 1024)
        duration_sec = n_frames / out_fps
        used_label = ctx.get("used_label") or ""
        engine_txt = f"⚙️ 编码档位 : {used_label}\n" if used_label else ""
        return (
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"📂 文件名称 : {ctx['file_name']}\n"
            f"📏 物理尺寸 : {ctx['w_ext']} x {ctx['h_ext']}\n"
            f"🎞️ 总帧数量 : {n_frames} 帧\n"
            f"⏱️ 播放时长 : {int(duration_sec)} 秒\n"
            f"📉 视频帧率 : {out_fps:g} FPS\n"
            f"💾 文件体积 : {f_size:.2f} MB\n"
            f"📼 编码格式 : {ctx['fmt_str'].split(' ')[0]}\n"
            f"{engine_txt}"
            f"━━━━━━━━━━━━━━━━━━━━━━\n"
            f"✅ 输出路径 : {file_path}{ctx['audio_warning']}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━"
        )


# ==========================================
# 音乐播放器节点
# ==========================================
class MusicPlayerWithLyricsNode:
    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        audio_files = []
        if os.path.exists(input_dir):
            audio_files = [f for f in os.listdir(input_dir) if f.lower().endswith(
                ('.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.aif', '.aiff', '.webm'))]
        # 占位项恒定入列：语义是「不选文件，只用 🎵 音频 输入口」，后端与前端都按这个值读写。
        # 原先只在目录为空时才给，导致目录里有音频时它不在列表里，而存档/前端归位逻辑
        # 仍会写入这个值 —— 提交即报 Value not in list。占位项的存在不能由磁盘内容决定。
        # 放末尾是为了保持列表首项仍是真实音频，不改动新节点的默认选中。
        音乐清单 = sorted(audio_files) + ["no audio file"]

        return {
            "required": {
                "📂 音乐文件": (音乐清单,),
                "🌈 频谱样式": (["镜像频谱", "丝滑波形", "环形扩散", "像素点阵"], {"default": "镜像频谱"}),
                "▶️ 自动播放": ("BOOLEAN", {"default": True}),
                "📄 保存文件名": ("STRING", {"default": "banzhang_audio"}),
                "🏷️ 保存格式": (["mp3", "wav", "flac", "ogg"], {"default": "mp3"}),
                "📂 保存目录": ("STRING", {"default": "", "placeholder": "为空则自动保存到 output/audio"}),
                "💾 保存到输出目录": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "🎵 音频": ("AUDIO",),
                "📝 歌词": ("STRING", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("🎵 音频(透传)",)
    FUNCTION = "execute_play"
    CATEGORY = "👨‍🏫班长/音频处理"
    OUTPUT_NODE = True

    def execute_play(self, **kwargs):
        audio_input = kwargs.get("🎵 音频")
        file_component = kwargs.get("📂 音乐文件")
        lyrics = kwargs.get("📝 歌词")
        save_prefix = kwargs.get("📄 保存文件名", "audio")
        save_format = kwargs.get("🏷️ 保存格式", "mp3")
        save_path_str = kwargs.get("📂 保存目录", "").strip()
        # 方案 B：试听与导出解耦，默认试听不落盘，避免 output/audio 垃圾堆积
        save_enabled = bool(kwargs.get("💾 保存到输出目录", False))

        result_ui = {"audio": []}
        result_audio = None
        from_input = False

        if audio_input is not None:
            result_audio = audio_input
            from_input = True
        elif file_component and file_component != "no audio file":
            path = folder_paths.get_annotated_filepath(file_component)
            if path and os.path.exists(path):
                try:
                    waveform, sr = load_audio_file(path)
                    if waveform.dim() == 2:
                        waveform = waveform.unsqueeze(0)
                    result_audio = {"waveform": waveform, "sample_rate": sr}
                    result_ui["audio"].append({"filename": file_component, "subfolder": "", "type": "input"})
                    # 自动匹配同目录同名 .lrc 歌词（外部传入歌词优先）
                    if not lyrics:
                        lrc_candidate = os.path.splitext(path)[0] + ".lrc"
                        if os.path.exists(lrc_candidate):
                            try:
                                with open(lrc_candidate, "r", encoding="utf-8", errors="ignore") as lf:
                                    lyrics = lf.read()
                                print(f"[Banzhang] 已自动匹配同名歌词: {os.path.basename(lrc_candidate)}")
                            except Exception:
                                pass
                except Exception as e:
                    print(f"[Banzhang] 音乐文件解码失败，已降级为静音: {e}")

        if result_audio is None:
            # 无可用音频时给 1 秒静音，避免播放器点播放毫无反馈
            result_audio = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}

        # 预览：仅当音频来自管线输入时需要生成临时预览文件（按所选保存格式，做到所见即所得）
        if from_input:
            random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
            preview_ext = save_format if save_format in ("wav", "mp3", "ogg", "flac") else "wav"
            preview_name = f"preview_{random_suffix}.{preview_ext}"
            temp_dir = folder_paths.get_temp_directory()
            if temp_dir:
                preview_path = os.path.join(temp_dir, preview_name)
                if not save_audio_robust(preview_path, result_audio["waveform"], result_audio["sample_rate"], format=preview_ext):
                    # 回退到 wav 预览，保证播放器始终可播
                    preview_name = f"preview_{random_suffix}.wav"
                    preview_path = os.path.join(temp_dir, preview_name)
                    save_audio_robust(preview_path, result_audio["waveform"], result_audio["sample_rate"], format="wav")
                result_ui["audio"].append({"filename": preview_name, "subfolder": "", "type": "temp"})

        # 保存到输出目录（仅在勾选「保存到输出目录」时执行，试听只走 temp 预览）
        if save_enabled:
            try:
                if not save_path_str:
                    final_output_dir = os.path.join(folder_paths.get_output_directory(), "audio")
                else:
                    final_output_dir = save_path_str if os.path.isabs(save_path_str) else os.path.join(folder_paths.get_output_directory(), save_path_str)

                os.makedirs(final_output_dir, exist_ok=True)
                filename = f"{save_prefix}_{''.join(random.choices(string.digits, k=4))}.{save_format}"
                full_path = os.path.join(final_output_dir, filename)
                ok = save_audio_robust(full_path, result_audio["waveform"], result_audio["sample_rate"], format=save_format)
                if ok:
                    result_ui["status"] = f"✅ 已保存: {os.path.basename(full_path)}"
                else:
                    result_ui["status"] = f"⚠️ 保存失败，请检查解码与格式: {filename}"
            except Exception as e:
                print(f"[Banzhang] auto save failed: {e}")
                result_ui["status"] = f"❌ 保存失败: {e}"
        else:
            result_ui["status"] = "🎧 试听模式：未写入 output（勾选「保存到输出目录」可导出）"

        # 回传音频元信息，供前端播放器展示（时长 / 采样率 / 声道）
        try:
            _w = result_audio["waveform"]
            result_ui["meta"] = [{
                "duration": round(float(_w.shape[-1]) / float(result_audio["sample_rate"]), 3),
                "sample_rate": int(result_audio["sample_rate"]),
                "channels": int(_w.shape[1]) if _w.dim() == 3 else 1,
            }]
        except Exception as e:
            print(f"[Banzhang] meta report failed: {e}")

        if lyrics:
            result_ui["lyrics"] = [lyrics]
        return {"ui": result_ui, "result": (result_audio,)}


class BanZhang_LyricsInput:
    """📝 手动输入歌词：可直接手输，也可接入上游文本。
    不固定（跟随）时透传传入文本并回填到节点编辑框；节点上点「📌 固定」后
    布尔置真，框内内容定格为本地副本，可自由编辑，运行/刷新都不再被上游覆盖；
    再点「🔓 取消固定」恢复跟随。"""

    MODE_PIN_CN = "📌 固定编辑"   # 旧版 combo 存档（中文枚举）兼容用

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 本地文本框沿用旧键名且排在首位：旧工作流 widgets_values 按位恢复不丢内容
                "📝 歌词文本": ("STRING", {"multiline": True, "default": ""}),
                # 布尔承载固定状态（前端隐藏勾选框，由一个 toggle 按钮翻转）
                "pinned": ("BOOLEAN", {"default": False,
                               "tooltip": "True=固定本地编辑（运行不覆盖）；False=跟随上游传入。节点上用按钮切换"}),
            },
            "optional": {
                "text_in": ("STRING", {"forceInput": True,
                               "tooltip": "上游文本（如「加载歌词文件」、LLM 输出）。未固定时输出并回填到编辑框；点「固定」后定格为本地副本"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("lyrics",)
    FUNCTION = "process"
    CATEGORY = "👨‍🏫班长/音频处理"
    # 标记为输出节点：右键「对所选输出节点进行排队」可单独执行（只跑上游文本来源），
    # 便于在节点上完成「传入 → 回填 → 固定」，不必连带播放器等下游重跑；STRING 输出口照常透传。
    OUTPUT_NODE = True

    @staticmethod
    def _normalize_pinned(raw):
        """固定状态归一化：兼容旧版 combo 留下的中文枚举字符串。"""
        if isinstance(raw, str):
            return raw == BanZhang_LyricsInput.MODE_PIN_CN
        return bool(raw)

    def process(self, **kwargs):
        local = kwargs.get("📝 歌词文本", "") or ""
        pinned = self._normalize_pinned(kwargs.get("pinned", False))
        # 接线与否看键是否存在；空串是合法传入值(上游字段为空)，必须能清空本地旧内容
        connected = "text_in" in kwargs
        incoming = kwargs.get("text_in", None)
        incoming_text = "" if incoming is None else str(incoming)

        if not pinned and connected:
            out_text = incoming_text
        else:
            out_text = local

        result_ui = {}
        if not pinned and connected:
            # 跟随态始终回填(含空串→前端清空编辑框)
            result_ui["incoming_text"] = [incoming_text]
        return {"ui": result_ui, "result": (out_text.strip(),)}


class BanZhang_LoadLyricsFile:
    @classmethod
    def INPUT_TYPES(cls):
        dir_path = folder_paths.get_input_directory()
        files = [f for f in os.listdir(dir_path) if f.lower().endswith(('.lrc', '.txt'))] if os.path.exists(dir_path) else []
        # 同 MusicPlayerWithLyricsNode：占位项恒定入列，不能由磁盘内容决定是否合法。
        歌词清单 = sorted(files) + ["no lyrics file"]
        return {"required": {"📂 歌词文件": (歌词清单,)}}

    RETURN_TYPES = ("STRING",)
    FUNCTION = "load"
    CATEGORY = "👨‍🏫班长/音频处理"

    def load(self, **kwargs):
        file_name = kwargs.get("📂 歌词文件")
        if not file_name or file_name == "no lyrics file":
            return ("",)
        path = os.path.join(folder_paths.get_input_directory(), file_name)
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                return (f.read(),)
        except Exception as e:
            print(f"[Banzhang] 歌词文件读取失败: {e}")
            return ("",)


# ==========================================
# 图像对比节点
# ==========================================
class Banzhang_ImageCompare:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_a": ("IMAGE",),
                "image_b": ("IMAGE",),
                "mode": (["hstack", "vstack", "diff"], {"default": "hstack"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("result",)
    FUNCTION = "compare_images"
    CATEGORY = "👨‍🏫班长/图像处理"

    def compare_images(self, image_a, image_b, mode):
        if image_a is None or image_b is None:
            return (None,)

        if len(image_a.shape) == 3:
            image_a = image_a.unsqueeze(0)
        if len(image_b.shape) == 3:
            image_b = image_b.unsqueeze(0)

        if image_a.shape[1:] != image_b.shape[1:]:
            image_b = torch.nn.functional.interpolate(
                image_b.permute(0, 3, 1, 2),
                size=(image_a.shape[1], image_a.shape[2]),
                mode='bilinear',
                align_corners=False,
            ).permute(0, 2, 3, 1)

        if mode == "hstack":
            result = torch.cat([image_a, image_b], dim=2)
        elif mode == "vstack":
            result = torch.cat([image_a, image_b], dim=1)
        else:
            result = torch.abs(image_a - image_b)

        return (result,)


# ==========================================
# 注册节点
# ==========================================
NODE_CLASS_MAPPINGS = {
    "Banzhang_ImageCompare": Banzhang_ImageCompare,
    "banzhangVideoCombine": banzhangVideoCombine,
    "BanZhang_MusicPlayerWithLyrics": MusicPlayerWithLyricsNode,
    "BanZhang_LyricsInput": BanZhang_LyricsInput,
    "BanZhang_LoadLyricsFile": BanZhang_LoadLyricsFile,
}

WEB_DIRECTORY = "./js"

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_ImageCompare": "🔍 图像对比器",
    "banzhangVideoCombine": "🎥 视频合并",
    "BanZhang_MusicPlayerWithLyrics": "🎵 班长音乐播放器",
    "BanZhang_LyricsInput": "📝 手动输入歌词",
    "BanZhang_LoadLyricsFile": "📂 加载歌词文件",
}


# ==========================================
# 按帧取图：播放仍走原片 <video>，停下来的画面才交给这里
# 这样「播放全清晰度」和「不常驻解码缓冲」不用二选一
# ==========================================
_帧源后缀 = (".mp4", ".mov", ".mkv", ".webm", ".gif", ".webp", ".avi", ".m4v")
_帧缓存 = {}
_帧缓存顺序 = []
_帧缓存上限 = 24
_帧信号量 = asyncio.Semaphore(2)


def _帧缓存键(path, frame, mode):
    # 成片会被反复覆盖，key 不带 mtime+size 会命中上一版的旧画面
    st = os.stat(path)
    return (os.path.realpath(path), st.st_mtime_ns, st.st_size, int(frame), mode)


def _取一帧(path, frame, mode):
    import io
    from PIL import Image
    if av is None:
        raise RuntimeError("缺少 PyAV，无法取帧")
    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        fps = float(v.average_rate or v.base_rate or fractions.Fraction(24, 1))
        tb = float(v.time_base or fractions.Fraction(1, 1000))
        target = max(0, int(frame))
        # 与 csglide_join_panel.frame_jpeg 同一口径：seek 到关键帧后向前走，
        # 按 pts 换算帧号，别自己发明一套（会和实际剪切落点错一帧）
        try:
            c.seek(int(target / fps / tb), stream=v, backward=True)
        except Exception:
            c.seek(0, stream=v, backward=True)
        img = None
        for n, f in enumerate(c.decode(video=0)):
            idx = int(round(float(f.pts * v.time_base) * fps)) if f.pts is not None else n
            img = f.to_image()
            if idx >= target or n >= 240:
                break
        if img is None:
            raise RuntimeError("这一帧解不出来")
        if mode == "fast" and img.width > 640:
            img = img.resize((640, max(2, round(img.height * 640 / img.width))), Image.BILINEAR)
        if img.mode != "RGB":
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88 if mode == "full" else 80)
        return buf.getvalue()


try:
    from aiohttp import web as _bz_web
    from server import PromptServer as _bz_server_cls
    _bz_server = getattr(_bz_server_cls, "instance", None)
except Exception:
    _bz_web, _bz_server = None, None

if _bz_server is not None and not getattr(_bz_server, "_bz_frame_route", False):

    @_bz_server.routes.get("/banzhang/video_frame")
    async def _bz_route_video_frame(request):
        path = request.query.get("path", "")
        if not path or not os.path.isfile(path) or not path.lower().endswith(_帧源后缀):
            return _bz_web.Response(status=404, text="成片不存在或格式不支持")
        try:
            frame = max(0, int(request.query.get("frame", "0")))
        except ValueError:
            return _bz_web.Response(status=400, text="frame 必须是整数")
        mode = "full" if request.query.get("mode") == "full" else "fast"
        try:
            key = _帧缓存键(path, frame, mode)
        except OSError:
            return _bz_web.Response(status=404, text="成片不存在")
        hit = _帧缓存.get(key)
        if hit is None:
            async with _帧信号量:
                hit = _帧缓存.get(key)
                if hit is None:
                    try:
                        hit = await asyncio.get_running_loop().run_in_executor(
                            None, _取一帧, path, frame, mode)
                    except Exception as exc:
                        return _bz_web.Response(status=500, text=str(exc))
                    _帧缓存[key] = hit
                    _帧缓存顺序.append(key)
                    if len(_帧缓存顺序) > _帧缓存上限:
                        del _帧缓存[_帧缓存顺序.pop(0)]
        return _bz_web.Response(body=hit, content_type="image/jpeg",
                                headers={"Cache-Control": "no-store"})

    _bz_server._bz_frame_route = True

