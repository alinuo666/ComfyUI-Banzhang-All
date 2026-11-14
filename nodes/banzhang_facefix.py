# -*- coding: utf-8 -*-
"""🪞 人脸修复台（BanZhang_FaceFixStudio）—— 像素域成片后处理节点。

定位：放在三采之后、合成出片之前，吃解码后的像素帧，吐修好的帧。
SAM3.1 检测追踪所有人脸 → 多脸拼一张画布（脸占满全部 token，解决一采小脸
糊的分辨率上限）→ H3 一次重渲染 → 高频残差贴回（几何/身份/嘴型由原帧低频
保住，采样只贡献细节）→ 羽化融入。

为什么是像素域后处理而不是 latent 链中间节点：latent 域修脸受一采分辨率
上限（脸只有 ~12×18 token，重绘补不出细节）；三采的整幅重绘还会盖掉上游
像素修。放大后的像素帧上脸块裁出来放大到画布，token 才够。

隔离承诺：只通过标准端口（IMAGE/MODEL/CONDITIONING/VAE）对接，不依赖
任何第三方插件；删掉本文件并撤回 __init__ 注册行，现有工作流逐字不变。
"""

import json

from .._facefix.pipeline import execute


def _upscale_choices():
    """像素域放大模型清单（models/upscale_models）+ 「不用模型」。
    import 期只读文件名，不加载权重。"""
    try:
        import folder_paths
        names = ["（不用模型）"] + list(folder_paths.get_filename_list("upscale_models"))
    except Exception:
        names = ["（不用模型）"]
    return names


_UPSCALE_CHOICES = _upscale_choices()
# [默认不用模型] 模型放大在拼贴逐帧场景没有性价比甜蜜点：倍数 ≤1.5 时它
# 不触发（格子太小），倍数 ≥2 时每帧每脸都要跑（5 脸×124 帧 ≈ 620 次，
# 实测 +9 分钟）。细节交给扩散 + 大格宽，模型留作手动加分项。
_UPSCALE_DEFAULT = _UPSCALE_CHOICES[0]


class BanZhang_FaceFixStudio:
    """🪞 人脸修复台：像素域多人脸精修，单页面板。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 面板状态存档（前端双写，隐藏 widget）
                "project_data": ("STRING", {"default": ""}),
                # 成片像素帧：VAE Decode 之后、Video Combine 之前
                "frames": ("IMAGE",),
                # H3 主模型：脸块画布的重渲染采样用
                "model": ("MODEL",),
                # 正条件：导演台 positive，画布采样必需
                "positive": ("CONDITIONING",),
                # 解码/编码 VAE：脸块进出的通道，必接
                "vae": ("VAE",),
                # SAM3.1 检测模型（CheckpointLoaderSimple 加载 sam3.1 权重）
                "sam3_model": ("MODEL",),
                # SAM3.1 的文本编码器（同一 CheckpointLoaderSimple 的 CLIP 口）
                "sam3_clip": ("CLIP",),
                # 人脸提示词，前端面板里直接可改
                "sam3_prompt": ("STRING", {"default": "face", "multiline": False}),
                # 细节强度：高频残差的放大系数（面板第一格）。1.0 = 采样细节
                # 全量叠加；锐化过头/白边 → 降到 0.5~0.7；0 = 完全不叠
                # （等于只做检测不修脸）。
                "detail_gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0,
                                          "step": 0.05}),
                # 检测阈值：低=检出更多（含误检），高=更严
                "sam3_threshold": ("FLOAT", {"default": 0.35, "min": 0.05,
                                             "max": 0.95, "step": 0.05}),
                # 修复范围外扩（像素）：贴回范围 = 脸框 + 此值，调多少生效多少。
                # [命名遗留] 内部名沿用 mask_dilate，只为老工程能读回。
                "mask_dilate": ("INT", {"default": 24, "min": 0, "max": 96, "step": 4}),
                # 画布渲染步数
                "steps": ("INT", {"default": 6, "min": 1, "max": 30, "step": 1}),
                # 画布渲染降噪。[高频残差] 模式下低频（几何/身份/嘴型）永远来自
                # 原帧，降噪只决定贴回多少高频细节：0.25~0.35 = 稳健修脸；
                # 0.5 以上高频伪影风险增大（refs/keyframes 已剥，画布无空间锚，
                # 高频是模型自由生成的）。1.0 = 高频完全按提示词重新生成。
                "denoise": ("FLOAT", {"default": 0.30, "min": 0.05, "max": 1.0,
                                      "step": 0.05}),
                # 贴回羽化（像素）：越大与周围融合越软
                "feather": ("INT", {"default": 24, "min": 0, "max": 64, "step": 4}),
                # 放大倍数：格宽 = 脸框长边 × 倍数（自动夹 128~768、对齐 16、
                # 总面积 ≤1.2MP）。默认 3 —— 脸约 120px 时格宽 352，比旧固定
                # 256 大一档；小脸不再被拉爆，大脸自动降格。
                # [只能追加在末尾] widget 值按顺序存档，插中间 = 旧工程整排错位
                "upscale": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 4.0,
                                      "step": 0.5}),
                # 像素域放大模型：脸块先用它真放大再进拼贴画布 —— 扩散拿到
                # 的是有细节的输入，不是双线性糊块。「不用模型」= 纯双线性。
                "upscale_model": (_UPSCALE_CHOICES, {"default": _UPSCALE_DEFAULT}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("修复后画面", "工程JSON", "修复报告")
    FUNCTION = "run"
    CATEGORY = "👨‍🏫班长/人脸修复"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, project_data, frames, model, positive, vae,
            sam3_model, sam3_clip, sam3_prompt, detail_gain, sam3_threshold,
            mask_dilate, steps, denoise, feather, upscale, upscale_model):
        try:
            project = json.loads(project_data) if str(project_data).strip() else {}
        except Exception:
            project = {}
        if not isinstance(project, dict):
            project = {}
        project.pop("modules", None)   # 旧版存档的幽灵键

        fixed, info = execute(
            frames, model=model, positive=positive, vae=vae,
            sam3_model=sam3_model, sam3_clip=sam3_clip,
            sam3_prompt=sam3_prompt, sam3_threshold=sam3_threshold,
            mask_dilate=mask_dilate, steps=steps, denoise=denoise,
            upscale=upscale, upscale_model=upscale_model, feather=feather,
            detail_gain=detail_gain)
        report = info.get("report", "")

        # 前端人脸缩略图：修复前（原帧裁）与修复后（精修结果裁）
        project["faces"] = [
            {"index": int(f.get("index", i)),
             "status": str(f.get("status", "tracked")),
             "thumb": f.get("thumb"),
             # [后图兜底] 精修失败/裁剪失败时右侧半格也必须有图（退到前图），
             # 不能让前端显示成「—」被误读成「后图没出」。
             "thumb_after": f.get("thumb_after") or f.get("thumb")}
            for i, f in enumerate(info.get("faces", []))
        ]
        project["backend"] = info.get("backend", "none")
        project["last_report"] = report
        full_json = json.dumps(project, ensure_ascii=False)

        return {
            "ui": {"project": [full_json], "report": [report]},
            "result": (fixed, full_json, report),
        }


NODE_CLASS_MAPPINGS = {
    "BanZhang_FaceFixStudio": BanZhang_FaceFixStudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_FaceFixStudio": "🪞 人脸修复台 (Face Fix Studio)",
}
