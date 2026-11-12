# -*- coding: utf-8 -*-
"""
👨‍🏫 班长分辨率与图像处理模块
包含：全能分辨率节点、图像桥接器
"""

import math
import torch
import torch.nn.functional as F
import os
import numpy as np
import imageio
import uuid
import folder_paths
from comfy_api.latest import InputImpl


# ==============================================================================
# 节点 1: 班长-全能分辨率 (BanZhang_UltimateResolution)
# ==============================================================================
class BanZhang_UltimateResolution:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "🎯 目标模型": (
                    ["Wan 2.2 (万视频)", "Flux.1 (黑森林)", "LTX-2 (视频模型)", "Z-Image (图像模型)"],
                    {"default": "Wan 2.2 (万视频)"}
                ),
                "📐 画面比例": (
                    [
                        "👇 ========== Wan 2.2 (万视频) ========== 👇",
                        "📺 1280x720 (16:9 Wan标准720p)",
                        "📱 720x1280 (9:16 Wan标准720p)",
                        "📺 832x480 (16:9 Wan极速480p)",
                        "📱 480x832 (9:16 Wan极速480p)",
                        "🟦 1024x1024 (1:1 通用正方形)",
                        "👇 ========== LTX-2 (视频模型) ========== 👇",
                        "📷 768x512 (3:2 LTX标准)",
                        "🖼️ 512x768 (2:3 LTX竖屏)",
                        "🎬 1216x704 (16:9 LTX高清)",
                        "🧊 640x640 (1:1 LTX方形)",
                        "📼 1024x768 (4:3 LTX大画幅)",
                        "📲 768x1024 (3:4 LTX大竖屏)",
                        "👇 ========== Flux.1 (黑森林) =========== 👇",
                        "🖥️ 1344x768 (16:9 Flux宽屏)",
                        "📲 768x1344 (9:16 Flux竖屏)",
                        "📼 1152x864 (4:3 Flux标准)",
                        "📔 864x1152 (3:4 Flux标准)",
                        "🎞️ 1536x640 (21:9 Flux电影)",
                        "🗼 640x1536 (9:21 Flux长屏)",
                    ],
                    {"default": "📺 1280x720 (16:9 Wan标准720p)"}
                ),
                "✨ 缩放基准": (
                    ["无 (按预设倍率)", "原始比例 (Original)", "最长边 (Longest)", "最短边 (Shortest)", "指定宽度 (Width)", "指定高度 (Height)", "总像素 (kPixel)", "自定义 (Custom)"],
                    {"default": "无 (按预设倍率)"}
                ),
                "🔢 基准数值": ("INT", {"default": 1024, "min": 64, "max": 32000, "step": 32}),
                "📏 自定义宽度": ("INT", {"default": 1280, "min": 64, "max": 32000, "step": 32}),
                "📏 自定义高度": ("INT", {"default": 720, "min": 64, "max": 32000, "step": 32}),
                "🔘 启用倍率缩放": ("BOOLEAN", {"default": False}),
                "🔍 尺寸倍率": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.05}),
                "🔘 强制倍数取整": ("BOOLEAN", {"default": True}),
                "🧱 倍数数值": ("INT", {"default": 16, "min": 1, "max": 64, "step": 1}),
                "🎨 缩放模式": (
                    ["Letterbox (指定色填充)", "Crop (居中裁剪)", "Stretch (拉伸变形)"],
                    {"default": "Letterbox (指定色填充)"}
                ),
                "🔴 红色 (R)": ("INT", {"default": 0, "min": 0, "max": 255, "step": 1}),
                "🟢 绿色 (G)": ("INT", {"default": 0, "min": 0, "max": 255, "step": 1}),
                "🔵 蓝色 (B)": ("INT", {"default": 0, "min": 0, "max": 255, "step": 1}),
                "🔢 批量大小": ("INT", {"default": 1, "min": 1, "max": 256}),
            },
            "optional": {
                "📷 图像 (可选)": ("IMAGE", {}),
                "🎭 遮罩 (可选)": ("MASK", {}),
                "宽度": ("INT", {"forceInput": True}),
                "高度": ("INT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING")
    RETURN_NAMES = ("🖼️ 图像", "🎭 遮罩", "↔️ 宽度", "↕️ 高度", "📝 原始信息")
    FUNCTION = "execute_all"
    CATEGORY = "👨‍🏫班长/图像处理"

    def execute_all(self, **kwargs):
        image = kwargs.get("📷 图像 (可选)", None)
        mask = kwargs.get("🎭 遮罩 (可选)", None)

        input_image_w = 0
        input_image_h = 0
        has_image = False

        # 输入验证：检查图像输入
        if image is not None:
            if not isinstance(image, torch.Tensor):
                print(f"⚠️ [班长分辨率] 警告：输入图像不是Tensor类型，而是 {type(image)}")
            elif len(image.shape) not in [3, 4]:
                print(f"⚠️ [班长分辨率] 警告：输入图像维度异常 {image.shape}，期望3或4维")
            else:
                input_image_h = image.shape[1]
                input_image_w = image.shape[2]
                has_image = True

        model_type = kwargs.get("🎯 目标模型", "Wan 2.2 (万视频)")
        ratio_string = kwargs.get("📐 画面比例", "📺 1280x720 (16:9 Wan标准720p)")
        scale_basis = kwargs.get("✨ 缩放基准", "无 (按预设倍率)")
        basis_value = kwargs.get("🔢 基准数值", 1024)
        custom_w_widget = kwargs.get("📏 自定义宽度", 1280)
        custom_h_widget = kwargs.get("📏 自定义高度", 720)

        enable_scale = kwargs.get("🔘 启用倍率缩放", False)
        scale_input = kwargs.get("🔍 尺寸倍率", 1.0)
        scale_factor = scale_input if enable_scale else 1.0

        force_divisible = kwargs.get("🔘 强制倍数取整", True)
        divisible_by = kwargs.get("🧱 倍数数值", 16)

        # 输入验证：检查外部宽高输入
        input_w_opt = kwargs.get("宽度", None)
        input_h_opt = kwargs.get("高度", None)
        if input_w_opt is not None and not isinstance(input_w_opt, (int, float)):
            print(f"⚠️ [班长分辨率] 警告：宽度输入类型错误 {type(input_w_opt)}，将忽略")
            input_w_opt = None
        if input_h_opt is not None and not isinstance(input_h_opt, (int, float)):
            print(f"⚠️ [班长分辨率] 警告：高度输入类型错误 {type(input_h_opt)}，将忽略")
            input_h_opt = None

        batch_size_gen = kwargs.get("🔢 批量大小", 1)

        # 解析预设分辨率字符串
        try:
            parts = ratio_string.split(' ')
            res_part = "1024x1024"
            for p in parts:
                if 'x' in p and p[0].isdigit():
                    res_part = p
                    break
            w_str, h_str = res_part.split('x')
            preset_w = int(w_str)
            preset_h = int(h_str)
            preset_ratio = preset_w / preset_h
        except Exception as e:
            print(f"⚠️ [班长分辨率] 警告：解析分辨率字符串 '{ratio_string}' 失败: {e}，使用默认值1024x1024")
            preset_w, preset_h = 1024, 1024
            preset_ratio = 1.0

        target_w = 0.0
        target_h = 0.0
        calc_mode_log = ""

        use_image_ratio = has_image and (scale_basis in ["最长边 (Longest)", "最短边 (Shortest)", "总像素 (kPixel)"])

        if use_image_ratio:
            current_ratio = input_image_w / input_image_h if input_image_h > 0 else 1.0
            calc_mode_log_prefix = "智能跟随图片"
        else:
            current_ratio = preset_ratio
            calc_mode_log_prefix = "使用预设比例"

        # ========== 优先级1: 外部强制输入（最高优先级）==========
        if input_w_opt or input_h_opt:
            if input_w_opt and input_h_opt:
                target_w, target_h = input_w_opt, input_h_opt
            elif input_w_opt:
                target_w = input_w_opt
                target_h = target_w / current_ratio
            elif input_h_opt:
                target_h = input_h_opt
                target_w = target_h * current_ratio
            calc_mode_log = "外部强制输入"
        # ========== 优先级2: 自定义宽高 ==========
        elif "自定义" in scale_basis:
            target_w = custom_w_widget
            target_h = custom_h_widget
            calc_mode_log = "自定义宽高"
        # ========== 优先级3: 缩放基准设置 ==========
        elif "无" in scale_basis:
            target_w = preset_w * scale_factor
            target_h = preset_h * scale_factor
            calc_mode_log = f"预设 x{scale_factor}"
        # ========== 新增: 原始比例 ==========
        elif "原始比例" in scale_basis:
            if has_image and input_image_w > 0 and input_image_h > 0:
                # 使用图像原始宽高比和尺寸
                original_w = input_image_w
                original_h = input_image_h

                # 配合尺寸倍率缩放
                if enable_scale and scale_factor != 1.0:
                    target_w = original_w * scale_factor
                    target_h = original_h * scale_factor
                    calc_mode_log = f"原始比例(倍率x{scale_factor}): {int(original_w)}x{int(original_h)}"
                else:
                    # 保持原始尺寸
                    target_w = original_w
                    target_h = original_h
                    calc_mode_log = f"原始比例(保持原尺寸): {int(original_w)}x{int(original_h)}"
            else:
                # 无图像输入时回退到预设比例
                target_w = preset_w * scale_factor
                target_h = preset_h * scale_factor
                calc_mode_log = f"无图像输入，回退到预设 x{scale_factor}"
        elif "指定宽度" in scale_basis:
            target_w = basis_value
            target_h = target_w / current_ratio
            calc_mode_log = f"{calc_mode_log_prefix}: 指定宽度"
        elif "指定高度" in scale_basis:
            target_h = basis_value
            target_w = target_h * current_ratio
            calc_mode_log = f"{calc_mode_log_prefix}: 指定高度"
        elif "最长边" in scale_basis:
            if current_ratio >= 1:
                target_w = basis_value
                target_h = target_w / current_ratio
            else:
                target_h = basis_value
                target_w = target_h * current_ratio
            calc_mode_log = f"{calc_mode_log_prefix}: 最长边固定"
        elif "最短边" in scale_basis:
            if current_ratio >= 1:
                target_h = basis_value
                target_w = target_h * current_ratio
            else:
                target_w = basis_value
                target_h = target_w / current_ratio
            calc_mode_log = f"{calc_mode_log_prefix}: 最短边固定"
        elif "总像素" in scale_basis:
            total = basis_value * 1000
            target_w = math.sqrt(total * current_ratio)
            target_h = target_w / current_ratio
            calc_mode_log = f"{calc_mode_log_prefix}: 总像素"

        # 先转换为整数
        target_w = int(target_w)
        target_h = int(target_h)

        # ========== 优先级最高: 强制倍数取整（始终在最终输出前执行）==========
        if force_divisible:
            # 根据模型类型智能选择默认倍数
            if "LTX-2" in model_type and divisible_by == 16:
                # LTX-2模型推荐使用32，但用户可手动覆盖
                effective_divisible = 32
                calc_mode_log += f" [LTX模式: 使用{effective_divisible}取整]"
            else:
                effective_divisible = divisible_by
                calc_mode_log += f" [强制取整: {effective_divisible}]"

            # 统一使用向下取整（保持画面不被放大超出限制）
            target_w = (target_w // effective_divisible) * effective_divisible
            target_h = (target_h // effective_divisible) * effective_divisible

        # 确保最小尺寸（最后的安全检查）
        target_w = max(32, target_w)
        target_h = max(32, target_h)

        info_text = f"模型: {model_type}\n"
        info_text += f"模式: {calc_mode_log}\n"
        info_text += f"结果: {target_w}x{target_h}"
        if not has_image:
            info_text += f", 帧数: {batch_size_gen}"

        r = kwargs.get("🔴 红色 (R)", 0)
        g = kwargs.get("🟢 绿色 (G)", 0)
        b = kwargs.get("🔵 蓝色 (B)", 0)
        bg_rgb = (r / 255.0, g / 255.0, b / 255.0)

        resample_method = "bicubic"
        mode = kwargs.get("🎨 缩放模式", "Letterbox (指定色填充)")

        final_img = None
        final_mask = None

        # ========== 无图像输入：生成纯色画布 ==========
        if not has_image:
            final_img = torch.tensor(bg_rgb).view(1, 1, 1, 3).repeat(batch_size_gen, target_h, target_w, 1)
            final_mask = torch.zeros((batch_size_gen, target_h, target_w), dtype=torch.float32)
            return (final_img, final_mask, target_w, target_h, info_text + "\n(生成模式)")

        # ========== 有图像输入：处理图像和遮罩 ==========
        # 验证图像维度
        if not isinstance(image, torch.Tensor):
            raise TypeError(f"[班长分辨率] 错误：输入图像必须是torch.Tensor，而不是 {type(image)}")

        # 确保4维 [B, H, W, C]
        if len(image.shape) == 3:
            image = image.unsqueeze(0)
        elif len(image.shape) != 4:
            raise ValueError(f"[班长分辨率] 错误：输入图像维度必须是3或4，当前 {len(image.shape)}")

        input_batch_size = image.shape[0]
        input_image_h = image.shape[1]
        input_image_w = image.shape[2]

        img_tensor = image.permute(0, 3, 1, 2)
        device = img_tensor.device

        if "Stretch" in mode:
            final_img = F.interpolate(img_tensor, size=(target_h, target_w), mode=resample_method)
        elif "Crop" in mode:
            scale = max(target_w / input_image_w, target_h / input_image_h)
            temp_w, temp_h = int(input_image_w * scale), int(input_image_h * scale)
            temp_img = F.interpolate(img_tensor, size=(temp_h, temp_w), mode=resample_method)
            sx = (temp_w - target_w) // 2
            sy = (temp_h - target_h) // 2
            final_img = temp_img[:, :, sy:sy+target_h, sx:sx+target_w]
        else:
            scale = min(target_w / input_image_w, target_h / input_image_h)
            new_w, new_h = int(input_image_w * scale), int(input_image_h * scale)
            new_w, new_h = max(1, new_w), max(1, new_h)
            resized_content = F.interpolate(img_tensor, size=(new_h, new_w), mode=resample_method)
            canvas = torch.tensor(bg_rgb, device=device).view(1, 3, 1, 1).repeat(input_batch_size, 1, target_h, target_w)
            pad_l = (target_w - new_w) // 2
            pad_t = (target_h - new_h) // 2
            canvas[:, :, pad_t:pad_t+new_h, pad_l:pad_l+new_w] = resized_content
            final_img = canvas

        # 处理遮罩输入
        if mask is None:
            mask = torch.zeros((input_batch_size, input_image_h, input_image_w), device=device, dtype=torch.float32)
        elif not isinstance(mask, torch.Tensor):
            print(f"⚠️ [班长分辨率] 警告：遮罩不是Tensor类型，而是 {type(mask)}，将创建空白遮罩")
            mask = torch.zeros((input_batch_size, input_image_h, input_image_w), device=device, dtype=torch.float32)
        elif len(mask.shape) == 2:
            # 单张遮罩扩展到批次
            mask = mask.unsqueeze(0).repeat(input_batch_size, 1, 1)
        elif len(mask.shape) == 3:
            # 检查批次是否匹配
            if mask.shape[0] != input_batch_size:
                print(f"⚠️ [班长分辨率] 警告：遮罩批次 {mask.shape[0]} 与图像批次 {input_batch_size} 不匹配，将调整")
                if mask.shape[0] == 1:
                    mask = mask.repeat(input_batch_size, 1, 1)
                else:
                    # 裁剪或填充到匹配批次
                    mask = mask[:input_batch_size] if mask.shape[0] > input_batch_size else \
                        torch.cat([mask, torch.zeros((input_batch_size - mask.shape[0], mask.shape[1], mask.shape[2]), device=mask.device)])

        mask_tensor = mask.unsqueeze(1).to(device)

        if "Stretch" in mode:
            final_mask = F.interpolate(mask_tensor, size=(target_h, target_w), mode="nearest")
        elif "Crop" in mode:
            scale = max(target_w / input_image_w, target_h / input_image_h)
            temp_w, temp_h = int(input_image_w * scale), int(input_image_h * scale)
            temp_mask = F.interpolate(mask_tensor, size=(temp_h, temp_w), mode="nearest")
            sx = (temp_w - target_w) // 2
            sy = (temp_h - target_h) // 2
            final_mask = temp_mask[:, :, sy:sy+target_h, sx:sx+target_w]
        else:
            scale = min(target_w / input_image_w, target_h / input_image_h)
            new_w, new_h = int(input_image_w * scale), int(input_image_h * scale)
            resized_mask = F.interpolate(mask_tensor, size=(new_h, new_w), mode="nearest")
            canvas_mask = torch.zeros((input_batch_size, 1, target_h, target_w), device=device, dtype=torch.float32)
            pad_l = (target_w - new_w) // 2
            pad_t = (target_h - new_h) // 2
            canvas_mask[:, :, pad_t:pad_t+new_h, pad_l:pad_l+new_w] = resized_mask
            final_mask = canvas_mask

        final_img = final_img.permute(0, 2, 3, 1)
        final_mask = final_mask.squeeze(1)

        return (final_img, final_mask, target_w, target_h, info_text)


# ==============================================================================
# 节点 2: 视频-图像信号桥接器 (BanZhang_ImageToVideo_Bridge)
# ==============================================================================
class BanZhang_ImageToVideo_Bridge:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "输入图像流": ("IMAGE",),
                "输入视频流": ("VIDEO",),
                "视频帧率": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 120.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("VIDEO", "IMAGE")
    RETURN_NAMES = ("📺 视频信号(Video)", "🖼️ 图像信号(Image)")
    FUNCTION = "run_bridge"
    CATEGORY = "👨‍🏫班长/图像处理"

    def run_bridge(self, 输入图像流=None, 输入视频流=None, 视频帧率=24.0):
        if 输入图像流 is None and 输入视频流 is None:
            raise ValueError("👨‍🏫 班长提示：请至少连接 输入图像流 或 输入视频流 其中之一")

        # === 视频信号输出：有图像流则打包成临时视频文件；否则直接透传视频流 ===
        if 输入图像流 is not None:
            帧数 = len(输入图像流)
            print(f"👨‍🏫 班长提示：正在将 {帧数} 张图片打包成临时视频文件，帧率 {视频帧率}...")
            临时目录 = folder_paths.get_temp_directory()
            文件名 = f"banzhang_bridge_{uuid.uuid4().hex[:8]}.mp4"
            保存路径 = os.path.join(临时目录, 文件名)
            try:
                图片数组 = (输入图像流.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
                imageio.mimsave(保存路径, 图片数组, fps=视频帧率, format='FFMPEG')
                print(f"👨‍🏫 班长提示：临时视频已生成 -> {保存路径}")
            except Exception as e:
                raise RuntimeError(f"图像流打包为视频失败：{e}") from e
            out_video = InputImpl.VideoFromFile(保存路径)
        else:
            out_video = 输入视频流

        # === 图像信号输出：有视频流则抽帧成图像序列；否则直接透传图像流 ===
        if 输入视频流 is not None:
            try:
                out_image = 输入视频流.get_components().images
                print(f"👨‍🏫 班长提示：已从视频流抽取 {len(out_image)} 帧图像序列")
            except Exception as e:
                raise RuntimeError(f"视频流抽帧为图像序列失败：{e}") from e
        else:
            out_image = 输入图像流

        return (out_video, out_image)


# 注册映射
NODE_CLASS_MAPPINGS = {
    "BanZhang_UltimateResolution": BanZhang_UltimateResolution,
    "BanZhang_ImageToVideo_Bridge": BanZhang_ImageToVideo_Bridge
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_UltimateResolution": "🌟 班长-全能分辨率 (Pro Fix)",
    "BanZhang_ImageToVideo_Bridge": "🌉 视频-图像信号桥接器"
}
