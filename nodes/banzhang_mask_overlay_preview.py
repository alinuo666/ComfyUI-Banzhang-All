# 🎨 遮罩叠画预览（班长版）
# 把任意遮罩按颜色+不透明度铺回原始画面，节点内自带动画预览窗口（前端 js/
# banzhang_mask_overlay.js，面板骨架逐行参照已上线的 🔍 图像对比器），
# 用来确认块化/外扩后的遮罩到底盖住了什么——官方版 SAM3 跟踪预览只吃
# track_data 看不了普通 MASK，本节点补这个缺口。
# 纯预览节点（OUTPUT_NODE=True，同图像对比器/官方预览图像）：没有输出端口，
# 不接任何下游也能单独运行出预览。
# 纯 torch 运算，不加载任何模型。

import os

import torch
import torch.nn.functional as F

# 颜色值=官方跟踪预览同风格的醒目描色；顺序即下拉顺序。
_COLORS = {
    "红": (1.0, 0.15, 0.15),
    "绿": (0.15, 0.8, 0.2),
    "蓝": (0.15, 0.45, 1.0),
    "黄": (1.0, 0.85, 0.1),
    "青": (0.1, 0.9, 0.9),
    "品红": (1.0, 0.15, 0.9),
    "白": (1.0, 1.0, 1.0),
}


class BZ_MaskOverlayPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {
                    "tooltip": "要铺遮罩的原始画面（批量帧直接接视频加载即可）。",
                }),
                "遮罩": ("MASK", {
                    "tooltip": "任意 MASK（SAM 跟踪、块化、外扩后都可用）。白色区域会被描色；尺寸与图像不一致时自动对齐。",
                }),
                "颜色": (list(_COLORS.keys()), {
                    "default": "红",
                    "tooltip": "描色。红色与官方跟踪预览的蓝色叠色对比度最大，方便区分。",
                }),
                "不透明度": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "0=完全不描色，1=遮罩区变成纯色。软边遮罩会按灰度深浅渐变。",
                }),
                "帧率": ("INT", {
                    "default": 24, "min": 1, "max": 120, "step": 1,
                    "tooltip": "节点预览窗口的动画播放速度（帧/秒），循环播放。",
                }),
            },
            "optional": {
                # 官方视频链路（CreateVideo/SaveVideo/输出成片）的帧率统一是 FLOAT，
                # 这里对齐同款类型。上方「帧率」是 INT widget，litegraph 里不右键
                # 「Convert widget to input」根本没有可连的端口，而且转换出来也是 INT，
                # FLOAT 源接不上 —— 所以单独给一个纯连线口（forceInput 不生成 widget）。
                "外部帧率": ("FLOAT", {
                    "forceInput": True,
                    "tooltip": "接「输出成片」等节点的帧率口；接上后覆盖上方「帧率」控件，不接就用控件值。",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "overlay"
    CATEGORY = "👨‍🏫班长/遮罩处理"
    DESCRIPTION = ("把遮罩按颜色铺回原始画面，节点内直接播放预览；OUTPUT_NODE，单独就能跑。"
                   "「外部帧率」口可直接接「输出成片」的帧率输出（FLOAT，与官方视频节点同款），不接时用帧率控件。")

    @torch.no_grad()
    def overlay(self, **kwargs):
        img = kwargs["图像"]
        m = kwargs["遮罩"]
        a = float(kwargs.get("不透明度", 0.5))
        fps = int(round(kwargs.get("外部帧率") or kwargs.get("帧率", 24)))
        unique_id = kwargs.get("unique_id")
        rgb = torch.tensor(_COLORS.get(kwargs.get("颜色", "红"), _COLORS["红"]),
                           device=img.device, dtype=img.dtype)

        if m.ndim == 2:
            m = m.unsqueeze(0)
        H, W = img.shape[1], img.shape[2]
        if m.shape[-2:] != (H, W):
            # 与官方 TrackToMask 同法双线性对齐；用 bilinear 保持软边不被硬化。
            m = F.interpolate(m.unsqueeze(1), size=(H, W), mode="bilinear",
                              align_corners=False)[:, 0]

        n_img, n_m = img.shape[0], m.shape[0]
        if n_m == 1 and n_img > 1:
            m = m.expand(n_img, -1, -1)
        elif n_img == 1 and n_m > 1:
            img = img.expand(n_m, -1, -1, -1)
        elif n_img != n_m:
            raise ValueError(f"遮罩叠画预览：图像 {n_img} 帧与遮罩 {n_m} 帧数量对不上，请把两者对齐到同一视频源。")

        w = m.clamp(0.0, 1.0).unsqueeze(-1) * a
        out = (img * (1.0 - w) + rgb * w).clamp(0.0, 1.0)

        # 面板图源：存临时 JPEG（同图像对比器口径），目录按节点 id 隔离、
        # 文件名按帧序号覆盖，反复运行不堆积垃圾文件。
        import folder_paths
        from PIL import Image
        subfolder = f"bz_mask_overlay/{unique_id or 0}"
        out_dir = os.path.join(folder_paths.get_temp_directory(), subfolder)
        os.makedirs(out_dir, exist_ok=True)
        names = [f"o_{i:05d}.jpg" for i in range(out.shape[0])]
        # 比帧数多的旧轮残留按名清掉（图像对比器原模式在变短重跑时会堆积，此处修净）。
        for old in os.listdir(out_dir):
            if old.startswith("o_") and old.endswith(".jpg") and old not in names:
                try:
                    os.remove(os.path.join(out_dir, old))
                except OSError:
                    pass
        arr = (out.clamp(0, 1) * 255).to(torch.uint8).cpu().numpy()
        for i, frame in enumerate(arr):
            Image.fromarray(frame).save(os.path.join(out_dir, names[i]), quality=90)

        # 核心合并 UI 输出时按键值当列表迭代（execution.py 的 ui merge），
        # 值必须是列表；裸字典会被 flatten 成键名数组，前端拿不到数据。
        ui = {"bz_mask_overlay": [{
            "frames": names,
            "subfolder": subfolder,
            "type": "temp",
            "fps": max(1, fps),
        }]}
        return {"ui": ui}


NODE_CLASS_MAPPINGS = {"BanZhang_MaskOverlayPreview": BZ_MaskOverlayPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_MaskOverlayPreview": "🎨 遮罩叠画预览"}
