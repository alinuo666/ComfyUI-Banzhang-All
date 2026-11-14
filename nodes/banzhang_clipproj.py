"""🎬 文本编码器投影：把小编码器接成大编码器，省 11GB 显存。

一个节点：选编码器模型 + 选投影矩阵，输出可直接接 H3 的 CLIP。
只装配，不实现。真正的活在 banzhang_clipproj_core.ProjectedCLIP 里。
"""

import logging

import comfy.sd
import folder_paths

from ..core.banzhang_clipproj_core import ProjectedCLIP, purge_projection_caches
from ..core.banzhang_clipproj_patch import detect_arch
from ..core.banzhang_clipproj_proj import list_projections, register_folder

# 必须在这里调，而且要在 INPUT_TYPES 求值之前：不注册这个目录，
# folder_paths 不认识 "clip_projections"，下拉里就只剩三个对照项 ——
# 用户放进去的矩阵一个都看不到。原包也是在 __init__ 里调这一句。
register_folder()

# 下拉里只放这三个型号 + 自动识别。ComfyUI 的 CLIPType 有三十多项，
# 全列出来等于让人在字典里找钥匙，而这三种就是 Qwen3-VL 的全部档位。
_TYPE_CHOICES = {
    "自动识别": None,
    "krea2（Qwen3-VL-4B）": "krea2",
    "boogu（Qwen3-VL-8B）": "boogu",
    "minimax（Qwen3-VL-32B）": "minimax",
}

# 换矩阵不应该重新加载一遍编码器：加载一次 4~10GB，改个下拉就重来太浪费。
# 只留最近一份，切换编码器时旧的那份自然被挤掉。
_ENCODER_CACHE = {}


def _load_encoder(encoder, type_choice):
    """按 ComfyUI 自己的方式加载编码器，返回官方 CLIP 对象。

    走 comfy.sd.load_clip 而不是自己搭 ModelPatcher，是为了让 ComfyUI 的显存
    管理全程接管：编完 prompt 它会自己把编码器挪回内存，采样时整张卡还给
    DiT。这一点是关键 —— 把编码器钉在卡上的做法在单卡上会让 DiT 换页，
    8GB 卡实测比原生 32B 还慢。
    """
    path = folder_paths.get_full_path_or_raise("text_encoders", encoder)

    type_name = _TYPE_CHOICES.get(type_choice)
    if type_name is None:
        found = detect_arch(path)
        if found is None:
            raise ValueError(
                "认不出 %s 是哪个型号：文件里没有视觉塔。纯文本的 Qwen3 和 "
                "Qwen3-VL 宽度完全一样，靠宽度分辨不出来，所以这里不敢猜。"
                "请在「编码器类型」里手动指定 krea2 / boogu / minimax。"
                % encoder)
        type_name = found[0]
        logging.info("[班长·投影] 自动识别 %s = %s", encoder, found[1])

    key = (path, type_name)
    hit = _ENCODER_CACHE.get(key)
    if hit is not None:
        return hit

    clip_type = getattr(comfy.sd.CLIPType, type_name.upper(), None)
    if clip_type is None:
        raise ValueError("这个 ComfyUI 版本不认识编码器类型 %s，请升级 ComfyUI"
                         % type_name)

    clip = comfy.sd.load_clip(
        ckpt_paths=[path],
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        clip_type=clip_type,
    )
    _ENCODER_CACHE.clear()
    _ENCODER_CACHE[key] = clip
    return clip


def _wrap(clip, projection):
    """把投影套到官方 CLIP 上，返回一个行为等价的包装对象。"""
    wrapped = ProjectedCLIP(clip, projection)
    p = wrapped.__dict__["_proj"]
    logging.info(
        "[班长·投影] %s | 读第 %d 层 | %d -> %d 维%s%s",
        projection, int(p["tap"]),
        p["mean_in"].shape[0], p["mean_out"].shape[0],
        "" if "W" in p else " | 只有残差网络",
        " | 测试余弦 %.4f" % float(p["cos_test"]) if "cos_test" in p else "")
    return wrapped


class BanzhangClipProjLoader:
    """一步到位：选编码器 + 选矩阵，输出可直接接 H3 的 CLIP。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "encoder": (folder_paths.get_filename_list("text_encoders"), {
                    "tooltip": "小号文本编码器。4B 配 mmh3-4b-*，8B 配 mmh3-8b-*，"
                               "8B 的 w4a8 量化版只有 5.9GB，比 4B 的 bf16 还省"}),
                "encoder_type": (list(_TYPE_CHOICES), {
                    "default": "自动识别",
                    "tooltip": "自动识别：读模型文件头里的视觉塔宽度判断型号。"
                               "认不出时才需要手动指定"}),
                "projection": (list_projections(), {
                    "tooltip": "学出来的投影矩阵，放在 models/clip_projections/"}),
            },
        }

    RETURN_TYPES = ("CLIP",)
    RETURN_NAMES = ("clip",)
    FUNCTION = "load"
    CATEGORY = "👨‍🏫班长/MiniMax H3"
    DESCRIPTION = ("加载一个小号 Qwen3-VL 并投影进 32B 的条件空间。"
                   "32B 的 15.7GB 换成 4.5~9.9GB，DiT 和采样器完全不动。")

    def load(self, encoder, encoder_type, projection):
        """返回投影后的 CLIP，直接接 H3 的 clip 口。"""
        purge_projection_caches()
        clip = _load_encoder(encoder, encoder_type)
        return (_wrap(clip, projection),)


NODE_CLASS_MAPPINGS = {
    "BanzhangClipProjLoader": BanzhangClipProjLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangClipProjLoader": "🎬 文本编码器投影",
}
