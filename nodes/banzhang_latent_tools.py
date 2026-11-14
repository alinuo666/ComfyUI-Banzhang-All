# -*- coding: utf-8 -*-
"""
👨‍🏫 班长潜在空间工具模块
包含：潜在空间保存、潜在空间加载
"""

import os
import torch
import folder_paths
import re
import json
import time
import threading
import numpy as np
from PIL import Image, ImageDraw

# 尝试导入 safetensors
try:
    import safetensors.torch
    HAS_SAFETENSORS = True
except ImportError:
    HAS_SAFETENSORS = False

# 全局内存中转站
BZ_GLOBAL_LATENT_STORE = {}

# ==========================================
# 工具函数
# ==========================================
def list_all_latents_in_output():
    """扫描 output 文件夹中的所有 .pt 和 .safetensors 文件"""
    output_dir = folder_paths.get_output_directory()
    if not os.path.exists(output_dir):
        return ["None"]
    latents = []
    for root, _, files in os.walk(output_dir):
        for file in files:
            if file.lower().endswith(".pt") or file.lower().endswith(".safetensors"):
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, output_dir)
                name_without_ext = os.path.splitext(rel_path)[0].replace("\\", "/")
                latents.append(name_without_ext)
    return sorted(latents) if latents else ["None"]

def sanitize_filename(name):
    """移除文件名中的非法字符"""
    return re.sub(r'[<>:"/\\|?*]', '', name).strip()

def create_fallback_image(msg="Preview Unavailable"):
    """生成一张纯色兜底图片"""
    img = Image.new('RGB', (256, 256), color=(40, 40, 40))
    d = ImageDraw.Draw(img)
    d.text((10, 120), msg, fill=(200, 200, 200))
    return img

def latent_to_preview_image(latent_tensor):
    """智能自适应缩略图生成"""
    try:
        l_sample = None
        if str(type(latent_tensor)).find("NestedTensor") >= 0:
            if hasattr(latent_tensor, "unbind"):
                l_sample = latent_tensor.unbind()[0]
            elif hasattr(latent_tensor, "tensors"):
                l_sample = latent_tensor.tensors[0] if len(latent_tensor.tensors) > 0 else None
            else:
                try:
                    l_sample = latent_tensor[0]
                except:
                    pass
        else:
            l_sample = latent_tensor[0]

        if l_sample is None:
            return create_fallback_image("NestedTensor Error")

        if hasattr(l_sample, "float"):
            l_sample = l_sample.float()
        if hasattr(l_sample, "cpu"):
            l_sample = l_sample.cpu()
        elif hasattr(l_sample, "to"):
            l_sample = l_sample.to("cpu")

        if len(l_sample.shape) < 3:
            return create_fallback_image(f"Shape: {l_sample.shape}")

        channels, height, width = l_sample.shape
        img_data = None

        if channels == 4:
            img_data = l_sample[:3, :, :].permute(1, 2, 0).numpy()
            img_data = (img_data * 0.18 + 0.5).clip(0, 1) * 255
        elif channels >= 16:
            img_data = l_sample[:3, :, :].permute(1, 2, 0).numpy()
            min_v = img_data.min()
            max_v = img_data.max()
            if max_v - min_v > 1e-5:
                img_data = (img_data - min_v) / (max_v - min_v)
            else:
                img_data = np.zeros_like(img_data)
            img_data = (img_data * 255).clip(0, 255)
        else:
            c_to_take = min(3, channels)
            img_data = l_sample[:c_to_take, :, :].permute(1, 2, 0).numpy()
            if c_to_take < 3:
                img_data = np.repeat(img_data, 3, axis=2)
            img_data = (img_data * 0.18 + 0.5).clip(0, 1) * 255

        img = Image.fromarray(img_data.astype(np.uint8))
        return img

    except Exception as e:
        print(f"⚠️ [班长节点] 缩略图生成失败: {e}")
        return create_fallback_image("Gen Failed")

def async_save_task(data_dict, file_path, format_type, save_thumb, thumb_path, latent_preview):
    """后台线程保存任务"""
    try:
        torch.save(data_dict, file_path)
        print(f"✅ [后台保存完成] {os.path.basename(file_path)}")
        if save_thumb and latent_preview is not None:
            latent_preview.save(thumb_path)
    except Exception as e:
        print(f"❌ [后台保存出错] {str(e)}")


# ==========================================
# 节点 1: 潜在空间保存 (BZ_SaveLatent)
# ==========================================
class BZ_SaveLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "🌀 潜在空间 (LATENT)": ("LATENT", {"tooltip": "请连接来自 KSampler 或 VAE Encode 的 Latent 连线。"}),
                "📄 文件名前缀": ("STRING", {
                    "default": "latent_work",
                    "tooltip": "给你的文件起个名字（不支持特殊字符），会自动添加数字后缀避免覆盖。"
                }),
                "📁 子文件夹名": ("STRING", {
                    "default": "Saved_Latents",
                    "tooltip": "在 ComfyUI 的 output 目录下创建一个子文件夹来存放这些文件，保持整洁。"
                }),
                "💾 存储位置": (["Disk (硬盘)", "Memory (内存)", "Both (双存)"], {
                    "tooltip": "Disk=永久保存到硬盘；Memory=临时存到内存供跨工作流使用；Both=我全都要。"
                }),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("🌀 潜在空间 (LATENT)",)
    FUNCTION = "execute_save"
    OUTPUT_NODE = True
    CATEGORY = "👨‍🏫班长/潜空间"

    def execute_save(self, **kwargs):
        samples = kwargs.get("🌀 潜在空间 (LATENT)")
        raw_prefix = kwargs.get("📄 文件名前缀", "latent")
        raw_folder = kwargs.get("📁 子文件夹名", "Saved_Latents")
        save_mode = kwargs.get("💾 存储位置")

        compression = "FP16 (半精度)"
        create_thumbnail = True
        extension = ".pt"

        memory_data = {}
        for key, value in samples.items():
            if key == "metadata":
                continue
            processed_value = value
            is_tensor = hasattr(value, "device") or isinstance(value, torch.Tensor)
            is_nested = str(type(value)).find("NestedTensor") >= 0

            if is_tensor:
                if hasattr(value, "clone") and not is_nested:
                    try:
                        processed_value = value.clone()
                    except:
                        processed_value = value
                else:
                    processed_value = value

                if compression == "FP16 (半精度)" and hasattr(processed_value, "half") and not is_nested:
                    try:
                        processed_value = processed_value.half()
                    except:
                        pass

                if is_nested:
                    if hasattr(processed_value, "cpu"):
                        try:
                            processed_value = processed_value.cpu()
                        except:
                            print(f"⚠️ [班长节点] Key '{key}' 是 NestedTensor 且无法移动到 CPU，将保存 GPU 引用。")
                else:
                    if hasattr(processed_value, "cpu"):
                        try:
                            processed_value = processed_value.cpu()
                        except:
                            pass
                    elif hasattr(processed_value, "to"):
                        try:
                            processed_value = processed_value.to("cpu")
                        except:
                            pass

            memory_data[key] = processed_value

        metadata = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "compression": compression,
            "format": extension,
            "keys_saved": list(memory_data.keys())
        }
        memory_data["metadata"] = metadata

        filename_prefix = sanitize_filename(raw_prefix)
        folder_name = sanitize_filename(raw_folder)
        output_dir = folder_paths.get_output_directory()
        save_dir = os.path.join(output_dir, folder_name)

        preview_img = None
        if create_thumbnail and "samples" in memory_data:
            preview_img = latent_to_preview_image(memory_data["samples"])

        if "Disk" in save_mode or "Both" in save_mode:
            os.makedirs(save_dir, exist_ok=True)
            counter = 0
            while True:
                suffix = f"_{counter:02d}" if counter > 0 else ""
                final_filename = f"{filename_prefix}{suffix}{extension}"
                save_path = os.path.join(save_dir, final_filename)
                if not os.path.exists(save_path):
                    break
                counter += 1

            thumb_path = os.path.join(save_dir, final_filename.rsplit('.', 1)[0] + ".png")
            save_thread = threading.Thread(
                target=async_save_task,
                args=(memory_data, save_path, "pt", create_thumbnail, thumb_path, preview_img)
            )
            save_thread.start()

        if "Memory" in save_mode or "Both" in save_mode:
            mem_key = f"{folder_name}/{filename_prefix}"
            BZ_GLOBAL_LATENT_STORE[mem_key] = memory_data
            print(f"🧠 [内存保存] Key: '{mem_key}'")

        torch.cuda.empty_cache()
        return (samples,)


# ==========================================
# 节点 2: 潜在空间加载 (BZ_LoadLatent)
# ==========================================
class BZ_LoadLatent:
    @classmethod
    def INPUT_TYPES(cls):
        file_list = list_all_latents_in_output()
        return {
            "required": {
                "📂 来源模式": (["Disk (硬盘文件)", "Memory (内存变量)"], {
                    "tooltip": "Disk=扫描硬盘文件；Memory=读取内存中转站的数据（重启 ComfyUI 后会清空）。"
                }),
                "🔍 选择文件 (硬盘)": (file_list, {
                    "tooltip": "这里列出了 output 文件夹下所有的 Latent 文件，选择一个来加载。"
                }),
                "🔑 变量键名 (内存)": ("STRING", {
                    "default": "Saved_Latents/latent_work",
                    "tooltip": "如果在保存时选了内存模式，请输入对应的 '子文件夹/文件前缀' 来提取。"
                }),
            }
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("🌀 潜在空间 (LATENT)", "ℹ️ 元数据 (STRING)")
    FUNCTION = "execute_load"
    CATEGORY = "👨‍🏫班长/潜空间"

    def execute_load(self, **kwargs):
        source_mode = kwargs.get("📂 来源模式")
        disk_file_base = kwargs.get("🔍 选择文件 (硬盘)")
        mem_key = kwargs.get("🔑 变量键名 (内存)")

        loaded_data = None
        metadata_str = ""

        if "Disk" in source_mode:
            output_dir = folder_paths.get_output_directory()
            possible_extensions = [".safetensors", ".pt"]
            load_path = None
            found_ext = ""

            for ext in possible_extensions:
                path_try = os.path.join(output_dir, f"{disk_file_base}{ext}")
                if os.path.exists(path_try):
                    load_path = path_try
                    found_ext = ext
                    break
                path_try_norm = os.path.normpath(path_try)
                if os.path.exists(path_try_norm):
                    load_path = path_try_norm
                    found_ext = ext
                    break

            if not load_path:
                print(f"❌ [加载失败] 未找到文件: {disk_file_base}")
                return ({"samples": torch.zeros([1, 4, 8, 8])}, "")

            try:
                try:
                    loaded_data = torch.load(load_path, map_location="cpu", weights_only=False)
                except TypeError:
                    loaded_data = torch.load(load_path, map_location="cpu")
            except Exception as e:
                print(f"❌ [加载失败] 文件损坏或被拦截: {e}")
                return ({"samples": torch.zeros([1, 4, 8, 8])}, f"Error: {e}")

        else:
            if mem_key in BZ_GLOBAL_LATENT_STORE:
                loaded_data = BZ_GLOBAL_LATENT_STORE[mem_key]
            else:
                return ({"samples": torch.zeros([1, 4, 8, 8])}, "Key Not Found")

        if loaded_data is None:
            return ({"samples": torch.zeros([1, 4, 8, 8])}, "Load Failed")

        final_output = {}

        if isinstance(loaded_data, dict):
            meta = loaded_data.get("metadata", {})
            if meta:
                metadata_str = json.dumps(meta, indent=2, ensure_ascii=False)
            for k, v in loaded_data.items():
                if k != "metadata":
                    final_output[k] = v
            if not final_output and "samples" not in final_output:
                for k, v in loaded_data.items():
                    if isinstance(v, torch.Tensor):
                        final_output["samples"] = v
                        break
        elif isinstance(loaded_data, torch.Tensor):
            final_output = {"samples": loaded_data}
            metadata_str = "Legacy Format (No Metadata)"

        if "samples" not in final_output:
            return ({"samples": torch.zeros([1, 4, 8, 8])}, "Invalid Data (No samples key)")

        keys_info = list(final_output.keys())
        print(f"✅ [成功加载] 包含键: {keys_info}")
        return (final_output, metadata_str)


# 注册映射
NODE_CLASS_MAPPINGS = {
    "BanZhang_SaveLatent": BZ_SaveLatent,
    "BanZhang_LoadLatent": BZ_LoadLatent
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_SaveLatent": "🌀 班长·潜在空间保存 (Final)",
    "BanZhang_LoadLatent": "🌀 班长·潜在空间加载 (Final)"
}
