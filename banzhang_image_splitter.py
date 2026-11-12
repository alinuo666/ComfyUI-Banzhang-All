# -*- coding: utf-8 -*-
"""
👨‍🏫 班长图像处理模块
包含：宫格图片拆分器
"""

import torch

class BanZhang_GridImageSplitter:
    """
    这是一个用于将宫格图片（如2宫格、4宫格、9宫格）切分为独立图片批次的节点。
    升级版：支持指定索引提取特定图片。
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原始大图": ("IMAGE",),
                "切分行数": ("INT", {"default": 2, "min": 1, "max": 10, "step": 1}),
                "切分列数": ("INT", {"default": 2, "min": 1, "max": 10, "step": 1}),
                "起始索引": ("INT", {"default": 1, "min": 1, "max": 100, "step": 1}),
                "提取数量": ("INT", {"default": 999, "min": 1, "max": 999, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("📦 图片批次",)
    FUNCTION = "execute_split"
    CATEGORY = "👨‍🏫班长/图像处理"

    def execute_split(self, 原始大图, 切分行数, 切分列数, 起始索引, 提取数量):
        try:
            切片结果列表 = []

            for 单张大图 in 原始大图:
                图片总高度 = 单张大图.shape[0]
                图片总宽度 = 单张大图.shape[1]

                单块高度 = 图片总高度 // 切分行数
                单块宽度 = 图片总宽度 // 切分列数

                for 当前行 in range(切分行数):
                    for 当前列 in range(切分列数):
                        起始Y = 当前行 * 单块高度
                        结束Y = 起始Y + 单块高度
                        起始X = 当前列 * 单块宽度
                        结束X = 起始X + 单块宽度

                        当前切片 = 单张大图[起始Y:结束Y, 起始X:结束X, :]
                        切片结果列表.append(当前切片)

            Python起始索引 = 起始索引 - 1
            总切片数 = len(切片结果列表)
            if Python起始索引 >= 总切片数:
                print(f"⚠️ 班长提示：起始索引 {起始索引} 超出了图片总数 {总切片数}，将自动返回最后一张图。")
                Python起始索引 = 总切片数 - 1

            Python结束索引 = Python起始索引 + 提取数量
            筛选后的列表 = 切片结果列表[Python起始索引:Python结束索引]

            if len(筛选后的列表) == 0:
                print("❌ 班长提示：筛选结果为空，返回原图。")
                return (原始大图,)

            输出批次 = torch.stack(筛选后的列表)
            return (输出批次,)

        except Exception as 错误信息:
            print(f"❌ 班长提示：切分图片时发生了错误: {错误信息}")
            return (原始大图,)

# 注册映射
NODE_CLASS_MAPPINGS = {
    "BanZhang_GridImageSplitter": BanZhang_GridImageSplitter
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_GridImageSplitter": "✂️ 宫格图片拆分器"
}
