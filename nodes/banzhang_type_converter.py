# -*- coding: utf-8 -*-
"""
👨‍🏫 班长类型转换器节点
将任意输入类型转换为指定的输出类型（字符串、整数、浮点、布尔）
通过下拉框选择目标类型，输出端口自动切换为对应类型
"""

import torch


class BanZhang_TypeConverter:
    """万能类型转换器：输入任意类型，通过下拉框选择转换目标类型"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输入数据": ("*", {}),
                "转换类型": (["STRING", "INT", "FLOAT", "BOOLEAN"], {"default": "STRING"}),
            }
        }

    FUNCTION = "convert_type"
    CATEGORY = "👨‍🏫班长/工具与标注"

    # "*" 是 ComfyUI 的万能通配符类型, 可以连接到任何输入端口
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("转换结果",)

    def convert_type(self, 输入数据, 转换类型="STRING"):

        # ---- 处理 torch.Tensor 输入（如图像、潜空间等）----
        if isinstance(输入数据, torch.Tensor):
            if 转换类型 == "STRING":
                shape_str = "×".join(str(d) for d in 输入数据.shape)
                dtype_str = str(输入数据.dtype).replace("torch.", "")
                return (f"<Tensor shape=({shape_str}) dtype={dtype_str}>",)
            elif 转换类型 == "INT":
                try:
                    return (int(输入数据.mean().item()),)
                except Exception:
                    return (0,)
            elif 转换类型 == "FLOAT":
                try:
                    return (float(输入数据.mean().item()),)
                except Exception:
                    return (0.0,)
            elif 转换类型 == "BOOLEAN":
                try:
                    return (bool(输入数据.mean().item() != 0),)
                except Exception:
                    return (False,)

        # ---- 处理其他类型 ----
        if 转换类型 == "STRING":
            return (str(输入数据),)

        elif 转换类型 == "INT":
            try:
                # 先转 float 再转 int，支持 "3.14" 这种字符串
                return (int(float(输入数据)),)
            except (ValueError, TypeError):
                return (0,)

        elif 转换类型 == "FLOAT":
            try:
                return (float(输入数据),)
            except (ValueError, TypeError):
                return (0.0,)

        elif 转换类型 == "BOOLEAN":
            if isinstance(输入数据, str):
                return (输入数据.lower() in ("true", "1", "yes", "是"),)
            elif isinstance(输入数据, (int, float)):
                return (输入数据 != 0,)
            else:
                return (bool(输入数据),)

        # fallback
        return (str(输入数据),)


# ============================================================
# 节点注册
# ============================================================
NODE_CLASS_MAPPINGS = {
    "BanZhang_TypeConverter": BanZhang_TypeConverter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_TypeConverter": "🔄 类型转换器 (万能转 String/Int/Float/Bool)",
}
