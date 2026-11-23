# 🧱 遮罩块化（班长版）
# 功能等价移植自 ComfyUI-UniversalToolkit 的「Blockify Mask (UTK)」
# （nodes/mask/blockify_mask.py，类型键 BlockifyMask_UTK）。
# 类型键、显示名、分类全部独立——两插件同时安装互不覆盖，未装 UTK 的用户
# 也能在班长菜单里直接用；算法保持一致：平均池化→最近邻还原=马赛克块化。
# 2026-11-20 追加：可直接接官方 SAM3 视频跟踪的 track_data（SAM3_TRACK_DATA），
# 内部转换等价官方「SAM3 Track to Mask」，并把 track_data 直通给下游
# 「SAM3 Track Preview」——链路省一个节点，还能看块化前原始跟踪预览。
# 2026-11-20 追加：遮罩外扩/羽化两参数（作用于块化后结果，羽化 0=关，
# 膨胀与主体重绘共用层同款 3×3 最大池化，羽化借 grow_soft_mask 模糊段）。
# 2026-11-20 再追加：外扩支持负数=向内收缩（取反最大池化=最小池化，镜像同款核），
# 控件边界显式 ±100 万（前端 INT 缺 max 会强补 2048，实测），收敛即停不空转。

import torch
import torch.nn.functional as F

# 官方 SAM3 跟踪数据的端口类型字符串（comfy_extras/nodes_sam3.py:
# SAM3TrackData = io.Custom("SAM3_TRACK_DATA")，自定义类型按名字匹配连线）。
_TRACK_TYPE = "SAM3_TRACK_DATA"


class BZ_MaskBlockify:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "遮罩": ("MASK", {
                    "tooltip": "接 SAM 检测、遮罩绘制等任意 MASK 输出；支持批量帧。接了跟踪数据时本口可不接；两个都接以本口为准。",
                }),
                "跟踪数据": (_TRACK_TYPE, {
                    "tooltip": "接官方「SAM3 视频跟踪」输出口，自动按对象编号转成逐帧遮罩再块化；下方「跟踪数据」口同时直通给「SAM3 跟踪预览」。",
                }),
                "对象编号": ("STRING", {
                    "default": "",
                    "tooltip": "逗号分隔的对象序号，如 0,2（对应跟踪预览画面上标的数字）；留空=全部对象合并。仅在使用「跟踪数据」口时生效。",
                }),
                "📏 块大小（像素）": ("INT", {
                    "default": 16, "min": 1, "max": 4096, "step": 1,
                    "tooltip": "每个马赛克方块的边长。1=原样直通；越大块越粗。",
                }),
                "🎨 二值化": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "开=块化后按阈值切成纯黑白；关=保留块状灰度过渡。",
                }),
                "🎚️ 二值化阈值": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "块内平均灰度达到该值算遮罩区。阈值越高，块越倾向于判为背景。",
                }),
                # 前端实测：INT 不写 max 会被补成 2048、不写 min 补 0，所以显式写
                # ±100 万当「不限」——扩/缩到画面边界即收敛，再大结果也一样。
                "📐 遮罩外扩（像素）": ("INT", {
                    "default": 0, "min": -1000000, "max": 1000000, "step": 1,
                    "tooltip": "正数=块化后的遮罩整体向外扩张，盖住轮廓外的环带与投影；负数=向内收缩；0=关闭。无实际上限（扩/缩到画面边界自动收敛）。块大小=1 时同样生效。",
                }),
                "🌫️ 遮罩羽化（像素）": ("INT", {
                    "default": 0, "min": 0, "max": 128, "step": 1,
                    "tooltip": "块边缘软过渡带的宽度（模糊半径）。0=关闭，保持硬边；越大边缘越柔和。与主体重绘节点的「0=自动」不同，这里 0 就是关。",
                }),
            },
        }

    RETURN_TYPES = ("MASK", _TRACK_TYPE)
    RETURN_NAMES = ("遮罩", "跟踪数据")
    FUNCTION = "blockify"
    CATEGORY = "👨‍🏫班长/遮罩处理"
    DESCRIPTION = "把连续遮罩按块大小马赛克化（可选二值化），块化后可整体外扩（负数=内缩）、羽化柔边。可直接吃官方 SAM3 视频跟踪数据并转成遮罩，跟踪数据同时直通给下游预览。"

    @staticmethod
    def _track_to_mask(track_data, object_indices=""):
        # 与官方 SAM3_TrackToMask 逐行等价（comfy_extras/nodes_sam3.py:493）。
        import comfy.model_management
        from comfy.ldm.sam3.tracker import unpack_masks
        packed = track_data["packed_masks"]
        H, W = track_data["orig_size"]

        if packed is None:
            N = track_data["n_frames"]
            return torch.zeros(N, H, W, device=comfy.model_management.intermediate_device())

        N, N_obj = packed.shape[0], packed.shape[1]
        if str(object_indices).strip():
            indices = [int(i.strip()) for i in str(object_indices).split(",") if i.strip().isdigit()]
            indices = [i for i in indices if 0 <= i < N_obj]
        else:
            indices = list(range(N_obj))
        if not indices:
            return torch.zeros(N, H, W, device=comfy.model_management.intermediate_device())

        union_packed = packed[:, indices[0]].clone()
        for i in indices[1:]:
            union_packed |= packed[:, i]
        union = unpack_masks(union_packed).unsqueeze(1).float()  # [N, 1, Hm, Wm]
        return F.interpolate(union, size=(H, W), mode="bilinear", align_corners=False)[:, 0]

    def blockify(self, **kwargs):
        # 全部走 optional：两个遮罩来源二选一（也可只接其一），输入口排在参数区最上面。
        masks = kwargs.get("遮罩")
        track_data = kwargs.get("跟踪数据")
        if masks is None and track_data is None:
            raise ValueError("遮罩块化：「遮罩」和「跟踪数据」至少要接一个输入。")
        if masks is None:
            masks = self._track_to_mask(track_data, kwargs.get("对象编号", ""))

        block_size = int(kwargs.get("📏 块大小（像素）", 16))
        binarize = bool(kwargs.get("🎨 二值化", True))
        threshold = float(kwargs.get("🎚️ 二值化阈值", 0.5))

        if block_size <= 1:
            out = torch.clamp(masks, 0.0, 1.0)
        else:
            # 固定 CPU：avg_pool+nearest 是纯内存操作，显卡反而多两趟搬运（原 UTK 的
            # CUDA 选项实测无收益，2026-11-20 按用户要求移除参数）。
            x = masks.unsqueeze(1).contiguous()
            # ceil 对齐+最近邻还原：与 UTK 原版逐位一致，尺寸不整除时边缘块照常成块。
            pooled = F.avg_pool2d(x, kernel_size=block_size, stride=block_size, ceil_mode=True)
            out = F.interpolate(pooled, size=(masks.shape[1], masks.shape[2]), mode="nearest").squeeze(1)

            if binarize:
                out = (out >= threshold).float()

        # 外扩/羽化作用于块化后的结果。羽化 0=关（用户拍板 B 方案），而共用层
        # grow_soft_mask 的 0=自动，所以膨胀单独做、羽化>0 时才借它的模糊段。
        grow = int(kwargs.get("📐 遮罩外扩（像素）", 0))
        feather = int(kwargs.get("🌫️ 遮罩羽化（像素）", 0))
        if grow != 0:
            x = out.unsqueeze(1)
            # 正=膨胀（最大池化），负=腐蚀（取反做最大池化=最小池化），同款 3×3
            # 十字核、贴边零填充。结果不再变化（到边/全0/铺满）立即停，超大值不空转。
            for _ in range(abs(grow)):
                if grow > 0:
                    nx = F.max_pool2d(x, 3, stride=1, padding=1)
                else:
                    nx = -F.max_pool2d(-x, 3, stride=1, padding=1)
                if torch.equal(nx, x):
                    break
                x = nx
            out = x[:, 0]
        if feather > 0:
            from ..core.banzhang_subject_redraw_core import grow_soft_mask
            out = grow_soft_mask(out, 0, feather)

        return (torch.clamp(out, 0.0, 1.0), track_data)


NODE_CLASS_MAPPINGS = {"BanZhang_MaskBlockify": BZ_MaskBlockify}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_MaskBlockify": "🧱 遮罩块化"}
