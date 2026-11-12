# -*- coding: utf-8 -*-
"""ComfyUI 节点：🎞️ 插帧（全显卡通用 · 流式）

开源模型插帧，不挑显卡：N 卡 20/30/40/50 系、A 卡都能跑，靠算力硬算。
NVIDIA 那两套插帧（RTX 视频插帧 / DLSS5）官方只给 RTX 40/50，
30 系及更早的用户就用这个。

两套引擎可切换：
    RIFE     快、省显存，通用场景够用（默认），可选 v4.26 / v4.7 两版权重
    EMA-VFI  多尺度光流 + 注意力，画质高一档，慢一些、显存多一些（固定单精度）

流式工作方式：边解码 → 边插帧 → 边编码，内存/显存峰值 = 模型 + 几帧画面，
与视频多长完全无关，一小时的长片也不会撑爆内存。
输出直接是 VIDEO，接「保存视频」即可。

模型来源：Practical-RIFE（MIT）、EMA-VFI/ECCV2022 系（Apache-2.0），
2026-10-09 并入班长全家桶。
2026-10-13：「图像」输入端口移到「视频」上方；视频入口改为与「🎥 视频合并」
同一套解析（文件路径型含 FlashVSR 直出 mp4、上传字典、内存型 VIDEO 都认）；
取消「状态」输出口（处理信息改打在控制台）。
"""
import gc

import torch

from .banzhang_dlss5_fg_engine import as_fps
from .banzhang_dlss5_fg_media import (
    StreamEncoder,
    build_source,
    resolve_video_path,
    video_from_file,
)
from .banzhang_rife_engine import (DEFAULT_VERSION, MODEL_VERSIONS, RIFEError)
from .banzhang_rife_engine import stream_interpolate as rife_stream
from .banzhang_stream_util import rounds_for

try:
    from . import banzhang_ema_engine as ema_engine

    _EMA_OK = True
    _EMAErrorCls = ema_engine.EMAVFIError
except Exception as _ema_exc:            # EMA 引擎整体起不来也不影响 RIFE
    ema_engine = None
    _EMA_OK = False
    _EMAErrorCls = RIFEError
    print(f"⚠️ [班长全家桶] EMA-VFI 引擎加载失败，插帧节点仅提供 RIFE：{_ema_exc}")

CAT_VIDEO = "👨‍🏫班长/视频处理"

ENG_RIFE = "RIFE｜快·省显存（默认）"
ENG_EMA = "EMA-VFI｜画质更高·大运动稳（慢约19倍）"
ENGINE_CHOICES = [ENG_RIFE] + ([ENG_EMA] if _EMA_OK else [])

# 下拉显示名 <-> 引擎内部版本 id
RIFE_VERSION_LABELS = [v[2] for v in MODEL_VERSIONS.values()]
_LABEL_TO_VERSION = {v[2]: k for k, v in MODEL_VERSIONS.items()}
_DEFAULT_VERSION_LABEL = MODEL_VERSIONS[DEFAULT_VERSION][2]

_SWITCH_TIP = ("⚠️ 切换后建议把本节点删掉重新添加一次，参数才会刷新；"
               "两个引擎是各自独立的模型，互不影响。")


def _log(msg: str) -> None:
    print(f"[班长插帧] {msg}")


def _hint(exc) -> str:
    """只按关键词对号入座，别把任意异常都算到 ffmpeg / 显存头上。

    以前这里一句「常见原因：找不到 ffmpeg；显存不够」盖住了所有异常，
    连「权重文件损坏」都被引到 ffmpeg 和显存上排查，白绕一大圈。
    """
    low = str(exc).lower()
    # 权重坏了要排在最前：这类报错最容易被人当成「没装 ffmpeg / 显存不够」
    if any(k in low for k in ("storages", "unpickling", "invalid load key",
                              "pickled data", "file is not a zip", "safetensors")):
        return ("模型权重文件损坏（不是 ffmpeg、也不是显存问题）。"
                "插件已自动重新下载过一次；仍失败多半是网络取不到文件 —— "
                "检查网络后重跑，或手动下载权重放进 models/rife。")
    if "ffmpeg" in low:
        return "系统里找不到能用的 ffmpeg（ComfyUI 自带的 tools/ffmpeg 目录里应该有）。"
    if "out of memory" in low or "cuda" in low:
        return "显存不够：降分辨率、降倍数、关掉其他占显存的节点，或把引擎换成 RIFE 再试。"
    return "程序原始报错，不是 ffmpeg / 显存问题；把这一行原文发出来即可定位。"


def 进度回调():
    """进度条 + 随时响应"中断"按钮。"""
    import comfy.model_management as mm
    from comfy.utils import ProgressBar

    bar = ProgressBar(100)

    def callback(done, total):
        bar.update_absolute(int(100 * done / max(1, total)))
        mm.throw_exception_if_processing_interrupted()

    return callback


def _video_fps(components):
    """从视频组件里把源帧率抠出来（保持分数精度）。"""
    config = getattr(components, "config", None)
    fps = getattr(config, "fps", None) if config is not None else None
    if fps:
        return as_fps(fps)
    frame_rate = getattr(components, "frame_rate", None)
    return as_fps(frame_rate if frame_rate is not None else 24)


def _pick_engine(引擎, 版本标签):
    """把下拉选择变成「一次插帧调用」，并把引擎名用于状态提示。"""
    version = _LABEL_TO_VERSION.get(版本标签, DEFAULT_VERSION)
    if 引擎 == ENG_EMA and ema_engine is not None:
        def interp(frames_iter, total_in, multiplier, fp16, sink, progress):
            # EMA-VFI 固定单精度（理由见 banzhang_ema_engine.py 文件头）
            return ema_engine.stream_interpolate(frames_iter, total_in, multiplier,
                                                 False, sink, progress)
        return interp, "EMA-VFI"
    if 引擎 == ENG_EMA:
        _log("EMA-VFI 引擎不可用（加载失败），本次自动改用 RIFE。")

    def interp(frames_iter, total_in, multiplier, fp16, sink, progress):
        return rife_stream(frames_iter, total_in, multiplier, fp16, sink,
                           progress=progress, version=version)

    return interp, f"RIFE {version}"


class BanZhang_RIFE_Interpolation:
    """插帧：把视频补密，做慢动作（流式，长视频也不占大内存）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "插帧倍数": ([2, 4, 8], {"default": 2,
                         "tooltip": "2 = 每两帧中间补 1 帧（24fps 变 48fps）；"
                                    "4 = 补 3 帧；8 = 补 7 帧。倍数越高越慢，一般 2 就够。"}),
                "计算精度": (["半精度(快,推荐)", "单精度(画质稳)"], {"default": "半精度(快,推荐)",
                         "tooltip": "半精度(fp16)速度快、省显存，绝大多数情况看不出差别；"
                                    "单精度(fp32)更稳，遇到画面发虚或出怪色时再换它。"
                                    "（EMA-VFI 引擎固定单精度，此项对它无效）"}),
                "保留原音": (["开", "关"], {"default": "开",
                         "tooltip": "开 = 输出视频带上源视频的音轨（仅「视频」输入时有效，"
                                    "从文件直拷，不重编码）。"}),
                # 新增控件一律追加在末尾：ComfyUI 旧工作流按位置回填参数值
                "插帧引擎": (ENGINE_CHOICES, {"default": ENG_RIFE,
                         "tooltip": "【RIFE】约 24ms/对帧，快、省显存，通用场景够用，默认选它。\n"
                                    "【EMA-VFI】多尺度光流+注意力融合，画质更高、大运动更稳，"
                                    "但慢约 19 倍（约 450ms/对帧）、显存多约 1GB，且固定单精度运行。\n"
                                    "建议：先用 RIFE，遇到难啃的大运动镜头再切 EMA 对比。\n"
                                    + _SWITCH_TIP}),
                "RIFE模型版本": (RIFE_VERSION_LABELS, {"default": _DEFAULT_VERSION_LABEL,
                         "tooltip": "只在「插帧引擎」选 RIFE 时有效。两版权重架构相同、速度一样，随时可切：\n"
                                    "【v4.26】2024-09-21 发布，最新训练，通用画质最佳（默认推荐）。\n"
                                    "【v4.25】2024-09-19 发布，动漫场景最强、公认最稳；"
                                    "升级前你一直在用的就是它。部分用户反馈它比 v4.26 更少伪影，"
                                    "同一个片段两个版本各跑一遍对比最靠谱。\n"
                                    "（v4.22 官方推荐用于 AI 生成视频，但各镜像都缺标准版权重，暂未收录）"}),
            },
            "optional": {
                # 两个输入口的顺序即节点上的上下顺序：图像在上、视频在下
                "图像": ("IMAGE", {"tooltip": "备选入口：接一批按顺序排好的视频帧"
                                              "（比如「加载图像序列」）。同样流式编码成视频输出；"
                                              "帧率取下面的「序列源帧率」。"}),
                "视频": ("VIDEO", {"tooltip": "推荐入口：接「加载视频」等节点的 VIDEO 输出，"
                                            "文件路径型（含 FlashVSR 直出的 mp4 路径）、内存型、"
                                            "上传文件都认，和「🎥 视频合并」的视频入口一致。"
                                            "走流式管线，边解码边插帧边编码，"
                                            "内存/显存峰值与片长无关。"}),
                "序列源帧率": ("INT", {"default": 24, "min": 1, "max": 240,
                             "tooltip": "仅「图像」输入时有效：这批图当作多少 fps 的源，"
                                        "输出帧率 = 它 × 插帧倍数。"}),
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频",)
    FUNCTION = "run"
    CATEGORY = CAT_VIDEO
    OUTPUT_NODE = False

    def run(self, 插帧倍数, 计算精度, 保留原音, 插帧引擎=ENG_RIFE,
            RIFE模型版本=None, 视频=None, 图像=None, 序列源帧率=24):
        from comfy_execution.graph import ExecutionBlocker
        try:
            if 视频 is None and 图像 is None:
                # 两个口都是空的。最常见的是「视频」接了一支不产出的上游
                # （RTX 超分两口皆空、导演台「整片」口还没渲染过）——那一支
                # 本次本来就该安静跳过，抛错会把整条 prompt 打断，前面跑完的
                # 十几分钟采样全白等，用户看到的还是一句「把线接上」，可他的
                # 线明明接着。改成安静阻断：本节点不跑，下游（视频合并）被
                # 一并冻住，画布上其余分支照常出片，全程没有红色报错。
                # 与「🔍 RTX 超分降噪」同一套做法（banzhang_nvidia_vfx.py）。
                _log("两个输入口本次都是空的 —— 跳过（不报错）。"
                     "若「视频」接的是上游的 VIDEO 口：那一支本次没有产出内容。")
                return ExecutionBlocker(None)
            multiplier = int(插帧倍数)
            fp16 = (计算精度 == "半精度(快,推荐)")
            keep_audio = (保留原音 == "开")
            interp, 引擎名 = _pick_engine(插帧引擎, RIFE模型版本 or _DEFAULT_VERSION_LABEL)
            progress = 进度回调()
            if 视频 is not None:
                out, note = self._run_video(视频, multiplier, fp16, keep_audio,
                                            progress, interp, 引擎名)
                _log(note)
                return (out,)
            if 图像 is not None:
                out, note = self._run_image(图像, 序列源帧率, multiplier, fp16,
                                            progress, interp, 引擎名)
                _log(note)
                return (out,)
            # 走到这里说明两个口都不是 None 却都没进上面的分支 —— 现有类型
            # 判断下不可能发生，不再抛「没有输入」把整条 prompt 打断。
            return ExecutionBlocker(None)
        except (RIFEError, _EMAErrorCls):
            raise
        except Exception as exc:
            raise RIFEError(f"插帧失败：{exc}\n{_hint(exc)}") from None

    # ------------------------------------------------------------ 视频分支

    def _run_video(self, video, multiplier, fp16, keep_audio, progress, interp, 引擎名):
        # 与「🎥 视频合并」同一套视频入口：文件路径型（含 FlashVSR 直出的 mp4 路径）、
        # 上传字典、VideoFromFile 都先解析成路径；解析不到再走内存 VIDEO 兜底
        source_path = resolve_video_path(video, log=_log)
        source_video_for_copy = (source_path or video) if keep_audio else None
        chunked = build_source(source_path, log=_log) if source_path else None
        audio = None

        if chunked is not None:
            # 首选：ffmpeg 管道分块解码，内存里永远只有几帧
            reader, source = chunked
            src_fps = as_fps(reader.fps if reader.fps > 0 else 24)
            total_in, height, width = int(reader.count), int(reader.height), int(reader.width)
            _log(f"{引擎名} 流式解码 {total_in} 帧 {width}x{height} @{float(src_fps):g}fps")
            out_fps = src_fps * multiplier

            def frames():
                for i in range(total_in):
                    rgba, _ = source(i)
                    yield rgba[..., :3]

            mode = "边解码边插帧边编码"
        else:
            # 兜底：拿不到文件路径（比如视频是内存里现拼的），整段解码进内存再流式编码
            components_getter = getattr(video, "get_components", None)
            if not callable(components_getter):
                raise RIFEError(
                    "视频输入拿不到可读文件路径，也不是内存 VIDEO 对象，无法处理；"
                    "请改接「加载视频」或上游视频节点的 VIDEO 输出。")
            components = components_getter()
            tensor = components.images
            src_fps = _video_fps(components)
            total_in, height, width = (int(tensor.shape[0]), int(tensor.shape[1]),
                                       int(tensor.shape[2]))
            audio = components.audio if keep_audio else None
            out_fps = src_fps * multiplier

            def frames():
                for i in range(total_in):
                    f = tensor[i].detach().cpu().mul(255.0).round_().clamp_(0.0, 255.0)
                    yield f.to(torch.uint8).numpy()[..., :3]

            mode = "流式插帧编码"

        # 插帧后的总帧数：首帧 + 每对相邻源帧补 (2^rounds - 1) 帧 + 末帧。
        # 这个数必须算准后交给编码器锁死，否则带音轨时会被 -shortest 砍尾。
        out_frames = (total_in - 1) * (2 ** rounds_for(multiplier)) + 1
        encoder = StreamEncoder(width, height, out_fps, audio, source_video_for_copy,
                                out_frames)
        try:
            interp(frames(), total_in, multiplier, fp16, encoder.write, progress)
            encoder.close()
        except BaseException:
            encoder.abort()
            raise
        finally:
            gc.collect()

        out = video_from_file(encoder.path)
        audio_note = "音轨从源视频直拷" if encoder.source else "无音轨"
        note = (f"{引擎名}｜{total_in} 源帧 {float(src_fps):g}→{float(out_fps):g}fps"
                f"（{multiplier} 倍），{mode}，{audio_note}")
        return out, note

    # ------------------------------------------------------------ 图像分支

    def _run_image(self, images, batch_fps, multiplier, fp16, progress, interp, 引擎名):
        images = images[..., :3]
        total_in, height, width = (int(images.shape[0]), int(images.shape[1]),
                                   int(images.shape[2]))
        src_fps = as_fps(max(1, int(batch_fps or 24)))
        out_fps = src_fps * multiplier

        def frames():
            for i in range(total_in):
                f = images[i].detach().cpu().mul(255.0).round_().clamp_(0.0, 255.0)
                yield f.to(torch.uint8).numpy()

        encoder = StreamEncoder(width, height, out_fps)
        try:
            interp(frames(), total_in, multiplier, fp16, encoder.write, progress)
            encoder.close()
        except BaseException:
            encoder.abort()
            raise
        finally:
            gc.collect()

        out = video_from_file(encoder.path)
        note = (f"{引擎名}｜{total_in} 帧 @{float(src_fps):g}→{float(out_fps):g}fps"
                f"（{multiplier} 倍），流式插帧编码（图像批次无音轨）")
        return out, note


# 无条件注册：注册只取决于代码可用性，不取决于权重是否已就位。
# 权重改为「跑的时候才取」——load_model() 内部会 ensure_model()，缺权重时抛中文提示。
NODE_CLASS_MAPPINGS = {
    "BanZhang_RIFE_Interpolation": BanZhang_RIFE_Interpolation,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_RIFE_Interpolation": "🎞️ 插帧·RIFE/EMA(全显卡通用·流式)",
}
