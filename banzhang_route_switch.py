# -*- coding: utf-8 -*-
"""
🔀 互斥选路器 (BanZhang_RouteSwitch)
================================================================================
N 路通用输入（类型 *，可接任意类型）任选 1 路直通输出。
前端面板为电台行样式，点击行切换通路；双击端口标签可自定义名称。
路数 2–8，端口 input_1..input_8 全部 optional，按 count 动态增减。
"""


def _upstream_of(prompt, unique_id, key):
    """从 prompt 里读出这一路接的上游节点，供报错点名用"""
    if not isinstance(prompt, dict) or unique_id is None:
        return ""
    me = prompt.get(str(unique_id))
    if not isinstance(me, dict):
        return ""
    link = (me.get("inputs") or {}).get(key)
    if not (isinstance(link, (list, tuple)) and len(link) == 2):
        return ""
    src_id = str(link[0])
    src = prompt.get(src_id) or {}
    return f"上游是「{src.get('class_type') or '未知节点'}」#{src_id}"


class BanZhang_RouteSwitch:
    """N 选 1 直通开关：输入任意类型，输出当前选中那一路"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "count": ("INT", {"default": 3, "min": 2, "max": 8}),
                "selected": ("INT", {"default": 1, "min": 1, "max": 8}),
            },
            "optional": {
                "input_1": ("*",),
                "input_2": ("*",),
                "input_3": ("*",),
                "input_4": ("*",),
                "input_5": ("*",),
                "input_6": ("*",),
                "input_7": ("*",),
                "input_8": ("*",),
            },
            # 只用于报错时点名「这一路的上游是谁」，不参与运算
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    FUNCTION = "route"
    CATEGORY = "👨‍🏫班长/工具与标注"

    # "*" = 通用类型，可接 IMAGE / MODEL / CONDITIONING / LATENT / INT / STRING…
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("输出",)

    def route(self, count=3, selected=1, prompt=None, unique_id=None, **wired):
        # 用「键存在」判断有没有连线，不能用「值是不是 None」：
        # execution.py 的 get_input_data 只遍历 prompt 里出现过的键，
        # 上游被静音 / 旁路 / 执行失败时键在、值是 None —— 两者必须分开报，否则会说"没连线"。
        raw = selected - 1
        # 钳制索引：selected 从 1 开始；count 上限；input_1..input_8 共 8 路
        idx = max(0, min(raw, count - 1, 7))
        key = f"input_{idx + 1}"
        clamped = ""
        if raw != idx:
            clamped = (f"（原选中第 {selected} 路，超出当前路数 {count}，"
                       f"已按第 {idx + 1} 路处理）")
        if key not in wired:
            linked = sorted(int(k[6:]) for k in wired
                            if k.startswith("input_") and k[6:].isdigit())
            hint = (f"（本次只有第 {'、'.join(map(str, linked))} 路有连线）"
                    if linked else "（本次没有任何一路连线）")
            raise ValueError(
                f"🔀 互斥选路器：第 {idx + 1} 路没有连线{clamped}{hint}。"
                f"请接上这一路，或点下方其他数字按钮。"
            )
        val = wired[key]
        if val is None:
            src = _upstream_of(prompt, unique_id, key)
            extra = f"{src}，" if src else "上游"
            raise ValueError(
                f"🔀 互斥选路器：第 {idx + 1} 路已连线，但{extra}这次没有产出{clamped}。"
                f"检查它是否被静音 / 旁路，或本身执行失败。"
            )
        return (val,)


# ============================================================
# 节点注册
# ============================================================
NODE_CLASS_MAPPINGS = {
    "BanZhang_RouteSwitch": BanZhang_RouteSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_RouteSwitch": "🔀 互斥选路器",
}
