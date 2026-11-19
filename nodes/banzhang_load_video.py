# ==========================================
# 节点: 📼 加载视频 (班长) + 📊 视频信息（已加载）(班长)
# 功能对应 VHS 的 LoadVideo / Video Info (Loaded)，但注册键、类名、
# 显示名、数据类型（BZ_VIDEOINFO）全部独立 —— 与 VHS 插件并存零冲突。
# 解码走 PyAV（与 csglide_cast 同引擎）；VIDEO 口复用媒体加载器的
# 构造视频值，与核心 LoadVideo / 班长媒体加载器输出一致。
# ==========================================
import os
import torch
import folder_paths

from .banzhang_visual_loader import 构造视频值

try:
    import av
    from av.video.reformatter import Interpolation as _AV_INTERP
except Exception:
    av = None
    _AV_INTERP = None

CAT_VIDEO = "👨‍🏫班长/视频处理"

# 下拉列表过滤用（与 VHS 白名单同源，另加国内常见的 flv/wmv）
视频扩展名 = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v",
              ".mpg", ".mpeg", ".wmv", ".flv", ".gif"}


def 列出输入目录视频():
    目录 = folder_paths.get_input_directory()
    文件 = []
    if os.path.isdir(目录):
        for f in sorted(os.listdir(目录)):
            if os.path.splitext(f)[1].lower() in 视频扩展名 \
                    and os.path.isfile(os.path.join(目录, f)):
                文件.append(f)
    return 文件


def 解析视频路径(下拉选择, 手填路径):
    """手填路径优先，下拉兜底 —— 二合一入口的分流规则。"""
    手填 = (手填路径 or "").strip()
    if 手填:
        return 手填
    if 下拉选择 and 下拉选择 != "无":
        return folder_paths.get_annotated_filepath(下拉选择)
    return None


def 读流信息(容器):
    """尽量从容器元数据取源信息；缺失字段给 0，残缺元数据不许炸掉加载。"""
    流 = 容器.streams.video[0]
    时间基 = float(流.time_base) if 流.time_base else 0.0
    源帧率 = float(流.average_rate) if 流.average_rate else 0.0
    源宽 = int(流.codec_context.width or 0)
    源高 = int(流.codec_context.height or 0)
    源时长 = float(流.duration * 时间基) if (流.duration and 时间基 > 0) else 0.0
    源帧数 = int(流.frames or 0)
    if 源帧数 <= 0 and 源时长 > 0 and 源帧率 > 0:
        源帧数 = int(round(源时长 * 源帧率))
    源信息 = {"source_fps": 源帧率, "source_frame_count": 源帧数,
              "source_duration": 源时长, "source_width": 源宽, "source_height": 源高}
    return 流, 时间基, 源信息


def 算缩放目标(源宽, 源高, 自定义宽度, 自定义高度):
    """两个都填→强制尺寸；只填一边→等比算另一边并对齐偶数（下游 VAE 友好）。"""
    if 自定义宽度 <= 0 and 自定义高度 <= 0:
        return (0, 0)
    if 自定义宽度 > 0 and 自定义高度 > 0:
        return (自定义宽度, 自定义高度)
    if 自定义宽度 > 0:
        return (自定义宽度, max(2, 2 * round(源高 * 自定义宽度 / 源宽 / 2)))
    return (max(2, 2 * round(源宽 * 自定义高度 / 源高 / 2)), 自定义高度)


def 采样视频帧(容器, 时间基, 跳帧数, 目标间隔, 基础间隔, 上限帧数, 缩放目标):
    """跳过前 N 源帧 → 按目标帧间隔在线取最近帧 → 截断。
    与 csglide 的参考视频解码同思路：只留一格前瞻窗口，内存峰值恒定，
    不把整段解码帧堆进内存再采样。"""
    import numpy as np
    from collections import deque

    选中帧 = deque()
    窗口帧 = deque()
    窗口时刻 = deque()
    已跳过 = 0
    解码序 = 0
    首个有效时刻 = None

    def 结算():
        # 窗口里能确定的采样点尽量结算；同一源帧可连续命中多个采样点
        while len(选中帧) < 上限帧数 and len(窗口时刻) >= 2:
            目标时刻 = 首个有效时刻 + len(选中帧) * 目标间隔
            if abs(窗口时刻[1] - 目标时刻) <= abs(窗口时刻[0] - 目标时刻):
                窗口时刻.popleft()
                窗口帧.popleft()
                continue
            选中帧.append(窗口帧[0])

    for 帧 in 容器.decode(video=0):
        if 帧.pts is not None and 时间基 > 0:
            时刻 = float(帧.pts * 时间基)
        else:
            时刻 = 解码序 * 基础间隔   # pts 缺失的畸形流按平均帧距回退
        解码序 += 1
        if 已跳过 < 跳帧数:
            已跳过 += 1
            continue
        if 首个有效时刻 is None:
            首个有效时刻 = 时刻
        # 缩放在解码后立刻用 libswscale 在 C 层做（缩小时 AREA 质量最优），
        # 峰值内存只留一帧缩后 rgb24，不再走「解出全尺寸帧→PIL 缩放」
        if 缩放目标 != (0, 0) and (帧.width, 帧.height) != 缩放目标:
            帧 = 帧.reformat(width=缩放目标[0], height=缩放目标[1],
                             format="rgb24", interpolation=_AV_INTERP.AREA)
            arr = np.ascontiguousarray(帧.to_ndarray())
        else:
            arr = np.ascontiguousarray(帧.to_ndarray(format="rgb24"))
        窗口帧.append(arr)
        窗口时刻.append(时刻)
        结算()
        if len(选中帧) >= 上限帧数:
            break
    if len(选中帧) < 上限帧数 and 窗口帧:
        选中帧.append(窗口帧[-1])   # 源耗尽 — 末尾只补一帧，不无限定格
    return list(选中帧)


def 解码视频帧(路径, 强制帧率, 自定义宽度, 自定义高度, 帧数上限, 跳帧数, 隔帧数):
    """按参数把视频解成帧张量。返回 (图像[N,H,W,3]float32, 视频信息dict)。"""
    import numpy as np
    if av is None:
        raise RuntimeError("PyAV 未安装，无法解码视频（本节点依赖 PyAV）")
    with av.open(路径) as 容器:
        if not 容器.streams.video:
            raise ValueError(f"文件里没有视频流: {路径}")
        _, 时间基, 源信息 = 读流信息(容器)
        源宽, 源高 = 源信息["source_width"], 源信息["source_height"]
        if 源宽 <= 0 or 源高 <= 0:
            raise ValueError(f"读不出视频宽高，文件可能损坏: {路径}")
        # 目标帧间隔：强制帧率优先，否则跟随源帧率；再乘「每隔N帧取一帧」
        if 强制帧率 > 0:
            基础间隔 = 1.0 / 强制帧率
        elif 源信息["source_fps"] > 0:
            基础间隔 = 1.0 / 源信息["source_fps"]
        else:
            基础间隔 = 0.04
        目标间隔 = 基础间隔 * max(1, 隔帧数)
        上限帧数 = 帧数上限 if 帧数上限 > 0 else 10 ** 9
        缩放目标 = 算缩放目标(源宽, 源高, 自定义宽度, 自定义高度)
        帧列表 = 采样视频帧(容器, 时间基, 跳帧数, 目标间隔,
                            基础间隔, 上限帧数, 缩放目标)
    if not 帧列表:
        raise ValueError(f"没有从视频里解出任何帧: {路径}")
    帧数组 = np.stack(帧列表).astype(np.float32)
    帧数组 /= 255.0
    图像 = torch.from_numpy(帧数组)
    视频信息 = dict(源信息)
    视频信息.update({
        "loaded_fps": 1.0 / 目标间隔,
        "loaded_frame_count": int(图像.shape[0]),
        "loaded_duration": 图像.shape[0] * 目标间隔,
        "loaded_width": int(图像.shape[2]),
        "loaded_height": int(图像.shape[1]),
    })
    return 图像, 视频信息


def 解码音轨兜底(路径):
    """复用媒体加载器的 PyAV 音频解码；无音轨给 1 样本静音，下游不炸。"""
    try:
        from .banzhang_visual_loader import 解码音频
        return 解码音频(路径)
    except Exception:
        return {"waveform": torch.zeros((1, 1, 1)), "sample_rate": 44100}


# ==========================================
# 节点类: 📼 加载视频 (班长)
# ==========================================
class BanzhangLoadVideo:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "📁 视频文件": (["无"] + 列出输入目录视频(),
                               {"tooltip": "从 input 目录里选；在「或填完整路径」填了值时此项失效"}),
                "✍️ 或填完整路径": ("STRING", {"default": "",
                                              "tooltip": "手填完整文件路径（含扩展名），填了就走这里"}),
                "⏱️ 强制帧率": ("INT", {"default": 0, "min": 0, "max": 60, "step": 1,
                                        "tooltip": "0 = 保持原速；>0 = 把帧流重采样到该帧率"}),
                "📏 自定义宽度": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1,
                                         "tooltip": "0 = 不缩放；只填一边时等比自动算另一边"}),
                "📏 自定义高度": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1,
                                         "tooltip": "0 = 不缩放；只填一边时等比自动算另一边"}),
                "🔢 帧数上限": ("INT", {"default": 0, "min": 0, "max": 1000000000, "step": 1,
                                        "tooltip": "0 = 不限制；>0 = 最多加载这么多帧"}),
                "⏭️ 跳过前面帧数": ("INT", {"default": 0, "min": 0, "max": 1000000000, "step": 1,
                                            "tooltip": "先跳过源视频的前这么多帧再开始取"}),
                "🔁 每隔N帧取一帧": ("INT", {"default": 1, "min": 1, "max": 1000000000, "step": 1,
                                             "tooltip": "2 = 每两帧取一帧（帧率减半）；1 = 全取"}),
            }
        }

    CATEGORY = CAT_VIDEO
    RETURN_TYPES = ("VIDEO", "IMAGE", "INT", "AUDIO", "BZ_VIDEOINFO")
    RETURN_NAMES = ("🎬 视频", "🖼️ 图像帧", "🔢 帧数", "🎵 音频", "ℹ️ 视频信息")
    FUNCTION = "执行加载"

    def 执行加载(self, **kwargs):
        路径 = 解析视频路径(kwargs.get("📁 视频文件"), kwargs.get("✍️ 或填完整路径"))
        if not 路径 or not os.path.isfile(路径):
            raise FileNotFoundError(
                "没有找到视频文件：请在「📁 视频文件」里选一个，或在「✍️ 或填完整路径」里填本地完整路径")
        图像, 视频信息 = 解码视频帧(
            路径,
            int(kwargs.get("⏱️ 强制帧率") or 0),
            int(kwargs.get("📏 自定义宽度") or 0),
            int(kwargs.get("📏 自定义高度") or 0),
            int(kwargs.get("🔢 帧数上限") or 0),
            int(kwargs.get("⏭️ 跳过前面帧数") or 0),
            int(kwargs.get("🔁 每隔N帧取一帧") or 1),
        )
        音频 = 解码音轨兜底(路径)
        return (构造视频值(路径), 图像, int(图像.shape[0]), 音频, 视频信息)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        路径 = 解析视频路径(kwargs.get("📁 视频文件"), kwargs.get("✍️ 或填完整路径"))
        try:
            文件状态 = os.stat(路径)
            return f"{文件状态.st_mtime_ns}_{文件状态.st_size}"
        except Exception:
            return ""


# ==========================================
# 节点类: 📊 视频信息（已加载）(班长)
# 只拆「按参数加载后」的信息；原片信息留在加载节点的源信息里
# ==========================================
class BanzhangVideoInfoLoaded:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "ℹ️ 视频信息": ("BZ_VIDEOINFO", {"tooltip": "接「加载视频 (班长)」的 ℹ️ 视频信息口"}),
            }
        }

    CATEGORY = CAT_VIDEO
    RETURN_TYPES = ("FLOAT", "INT", "FLOAT", "INT", "INT")
    RETURN_NAMES = ("⏱️ 帧率", "🔢 帧数", "⌛ 时长", "📐 宽度", "📐 高度")
    FUNCTION = "拆解信息"

    def 拆解信息(self, **kwargs):
        信息 = kwargs.get("ℹ️ 视频信息") or {}
        return (
            float(信息.get("loaded_fps", 0) or 0),
            int(信息.get("loaded_frame_count", 0) or 0),
            float(信息.get("loaded_duration", 0) or 0),
            int(信息.get("loaded_width", 0) or 0),
            int(信息.get("loaded_height", 0) or 0),
        )


# 注册映射（键名与 VHS 的 VHS_* 全部错开，装了 VHS 也不冲突）
NODE_CLASS_MAPPINGS = {
    "BanzhangLoadVideo": BanzhangLoadVideo,
    "BanzhangVideoInfoLoaded": BanzhangVideoInfoLoaded,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangLoadVideo": "📼 加载视频 (班长)",
    "BanzhangVideoInfoLoaded": "📊 视频信息（已加载）(班长)",
}
