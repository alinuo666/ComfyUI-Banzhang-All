# -*- coding: utf-8 -*-
"""🪞 人脸修复台（BanZhang_FaceFixStudio）—— 像素域成片后处理节点。

定位：放在三采之后、合成出片之前，吃解码后的像素帧，吐修好的帧。
SAM3.1 检测追踪所有人脸 → 保留逐帧分割并集遮罩 → MaskVid 线性规划器
整段联合求解恒定尺寸裁剪框（遮罩抖动/丢帧/遮挡框不动，持续运动才最小
移动）→ 裁剪序列放大到目标像素量 → H3 低降噪重渲染 → 按脸区遮罩羽化贴回。

为什么是像素域后处理而不是 latent 链中间节点：latent 域修脸受一采分辨率
上限（脸只有 ~12×18 token，重绘补不出细节）；放大后的裁剪序列上脸占满
token，细节才补得出来。

隔离承诺：只通过标准端口（IMAGE/MODEL/CONDITIONING/VAE）对接，不依赖
任何第三方插件；删掉本文件并撤回 __init__ 注册行，现有工作流逐字不变。
"""

import json

from .._facefix.pipeline import execute


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
                # H3 主模型：裁剪序列的重渲染采样用
                "model": ("MODEL",),
                # 正条件：导演台 positive，采样必需
                "positive": ("CONDITIONING",),
                # 解码/编码 VAE：裁剪序列进出的通道，必接
                "vae": ("VAE",),
                # SAM3.1 检测模型（CheckpointLoaderSimple 加载 sam3.1 权重）
                "sam3_model": ("MODEL",),
                # SAM3.1 的文本编码器（同一 CheckpointLoaderSimple 的 CLIP 口）
                "sam3_clip": ("CLIP",),
                # 人脸提示词，前端面板里直接可改
                "sam3_prompt": ("STRING", {"default": "human face", "multiline": False}),
                # 检测阈值：低=检出更多（含误检），高=更严；0.5 是 SAM3 官方默认
                "sam3_threshold": ("FLOAT", {"default": 0.5, "min": 0.05,
                                             "max": 0.95, "step": 0.05}),
                # 裁剪模式（面板收起，默认恒尺寸跟随）：
                # 静止大框 = 一个框包住所有人脸全程运动，最稳；
                # 恒尺寸跟随 = 框大小不变、人脸快出框才小幅移动；
                # 变焦跟随 = 框还跟着人脸大小缩放，重采样到固定输出分辨率
                "裁剪模式": (["combined", "tracked", "zoomed"],
                             {"default": "tracked"}),
                # 包边比例：裁剪框相对人脸并集大小的倍数，1.4 = 人脸占框约七成
                "包边比例": ("FLOAT", {"default": 1.4, "min": 1.0, "max": 3.0,
                                       "step": 0.05}),
                # 裁剪序列放大到约多少百万像素再采样（0 = 只对齐网格不放大）。
                # 默认 0.5：这是耗时主导项——采样步时与它基本成正比。2026-11-21
                # 实测 362 帧成片，1.0MP（裁剪 1376x752）时 68.9 秒/步、本节点 10分14秒；
                # 主画布整幅只有 0.34MP（768x448）＝ 24~29 秒/步。0.5 约为主画布
                # 1.5 倍，脸区细节仍远高于原生裁剪，总耗时降到约 6 分钟。
                "放大百万像素": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 16.0,
                                           "step": 0.05}),
                # 渲染步数
                "steps": ("INT", {"default": 4, "min": 1, "max": 30, "step": 1}),
                # 渲染降噪。遮罩外由原帧 latent 保留；脸区重绘仍可能改变身份，
                # 降噪只决定重渲染贡献多少细节：0.25~0.35 = 稳健修脸；
                # 0.5 以上高频伪影风险增大（画布条件已剥，无空间锚）。
                "denoise": ("FLOAT", {"default": 0.30, "min": 0.05, "max": 1.0,
                                      "step": 0.05}),
                # 贴回羽化（像素）：越大与周围融合越软
                "feather": ("INT", {"default": 8, "min": 0, "max": 64, "step": 4}),
            },
            # 面板要收自己的事件（进度字幕 / 逐步动画 / 成片循环），得知道发给
            # 哪个节点。hidden 既不生成 widget 也不生成端口，对旧存档完全安全。
            "optional": {
                "crop_padding": ("INT", {"default": -1, "min": -1, "max": 512, "step": 1}),
                "crop_long_edge": ("INT", {"default": -1, "min": -1, "max": 4096, "step": 16}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("修复后画面", "工程JSON", "修复报告")
    FUNCTION = "run"
    CATEGORY = "👨‍🏫班长/人脸修复"
    OUTPUT_NODE = True

    def run(self, project_data, frames, model, positive, vae,
            sam3_model, sam3_clip, sam3_prompt, sam3_threshold,
            裁剪模式, 包边比例, 放大百万像素, steps, denoise, feather,
            unique_id=None, crop_padding=None, crop_long_edge=None):
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
            crop_mode=裁剪模式, crop_scale=包边比例, megapixels=放大百万像素,
            steps=steps, denoise=denoise, feather=feather,
            node_id=unique_id,
            # 循环动画的回放速度按成片真实帧率算；一采 VideoCombine 就是 24 帧/秒
            # （362 帧 ≈ 15.1 秒）。改这里不影响画质，只影响预览循环快慢。
            fps=24.0, crop_padding=crop_padding, crop_long_edge=crop_long_edge)
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
        # [明细不进面板] 参数/规划简报/逐行日志只随工程 JSON 走：面板底部只显示
        # report 那一行结论（前端按「｜」拆行直显），要排查就接「工程JSON」输出口。
        project["last_detail"] = info.get("detail", "")
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
