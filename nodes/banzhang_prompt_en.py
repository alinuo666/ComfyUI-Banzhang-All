# -*- coding: utf-8 -*-
"""🔤 提示词英文化 —— 把输入文本转成专业英文提示词的独立节点。

为什么独立：文案台的改写锁在「立即改写」按钮的 HTTP 路由里，只能手点；
这条链路要的是队列里自动跑——文本进，专业英文出，接给下游提示词口。

管线全部复用文案台那套（csglide_desk）：改写模型按文件名直连加载
（CLIPLoader type=moss_image，类缓存）、用完立刻请出显存；出字走
core.csglide_image_models 的 rewrite_prompt（clip.tokenize → generate →
decode，失败回落原文）。这里只多两件事：系统提示词开放成输入框（留空
回落内置英文指南），以及温度固定 0.3——转写要的是忠实，不是创作。
"""

import os
import sys

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    from ..core.csglide_image_models import (REWRITE_SYSTEM_EN, rewrite_max_length,
                                             rewrite_prompt)
except Exception:                                    # 顶层导入（自检）
    from core.csglide_image_models import (REWRITE_SYSTEM_EN, rewrite_max_length,   # noqa: E402
                                           rewrite_prompt)

# 模型加载/释放/候选列表/文本清理直接复用文案台那套——共用一份，别抄第二份。
try:
    from .csglide_desk import (_REWRITE_MODEL_FILE, _clean, _get_rewrite_clip,
                               _release_rewrite_clip, _rewrite_model_names)
except Exception:                                    # 顶层导入（自检）
    from .csglide_desk import (_REWRITE_MODEL_FILE, _clean, _get_rewrite_clip,      # noqa: E402
                               _release_rewrite_clip, _rewrite_model_names)


class BanzhangPromptEN:
    """🔤 提示词英文化 —— 文本进、专业英文出，接任何需要提示词的下游节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        # 下拉候选与默认项：优先选中默认模型文件（按文件名比对，MOSS-Image/ 前缀不影响）。
        try:
            names = _rewrite_model_names()
        except Exception:
            names = []
        default = ""
        for n in names:
            if n.split("/")[-1] == _REWRITE_MODEL_FILE:
                default = n
                break
        if not default and names:
            default = names[0]
        if not default:
            default = _REWRITE_MODEL_FILE
        return {
            "required": {
                "文本": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "要转写成英文的文本（中文或任意语言）。"}),
                "系统提示词": ("STRING", {
                    "multiline": True,
                    "default": REWRITE_SYSTEM_EN,
                    "tooltip": "发给改写模型的指令，决定输出要求。默认是「忠实转写成专业"
                               "英文提示词」；写你自己的要求即可整体替换，比如固定英文句式、"
                               "指定风格。清空则回落默认。"}),
                "改写模型": (names or [default], {
                    "default": default,
                    "tooltip": "改写用的编码器，与文案台「立即改写」同一批候选，"
                               "按文件直连加载，与画布连线无关。"}),
                "输出上限": ("INT", {
                    "default": 1024, "min": 64, "max": 4096, "step": 64,
                    "tooltip": "单次生成英文的最大 token 数。100～300 词用 1024 足够，"
                               "要更长就调大，代价按比例变慢。"}),
            },
            "optional": {
                "外接文本": ("STRING", {
                    "forceInput": True,
                    "tooltip": "接线即整体替换面板里的「文本」（给上游文本节点用）。"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("英文提示词",)
    FUNCTION = "rewrite"
    CATEGORY = "👨‍🏫班长/文本处理"
    DESCRIPTION = ("🔤 提示词英文化——把输入文本忠实转写成专业英文提示词。"
                   "系统提示词框可自定义输出要求（清空回落默认）；"
                   "输出接任何需要英文提示词的节点。")

    def rewrite(self, 文本="", 系统提示词="", 改写模型="", 输出上限=1024, 外接文本=None):
        # 外接文本优先：接线即替换面板文本（与文案台「外接提示词」同一语义）。
        src = 外接文本 if (外接文本 is not None and str(外接文本).strip()) else 文本
        src = _clean(src)
        if not src:
            print("[提示词英文化] 输入为空，输出空串")
            return ("",)
        sys_p = _clean(系统提示词) or REWRITE_SYSTEM_EN
        max_len = rewrite_max_length(输出上限)

        def _log(line):
            print("[提示词英文化] " + str(line))

        clip = _get_rewrite_clip(_log, 改写模型)
        try:
            # temperature=0.3：转写要的是忠实不是创作（与 rewrite_normalized 同档）。
            out = rewrite_prompt(clip, src, sys_p, max_len, _log, temperature=0.3)
        finally:
            # 用完立刻请出显存：9.3GB 权重不能跟下游采样模型抢卡（文案台按钮同一套释放）。
            _release_rewrite_clip(clip, _log)
        _log("输出 %d 字，开头 60 字：%s" % (len(out), out[:60]))
        return (out,)


NODE_CLASS_MAPPINGS = {"BanzhangPromptEN": BanzhangPromptEN}
NODE_DISPLAY_NAME_MAPPINGS = {"BanzhangPromptEN": "🔤 提示词英文化 (Prompt EN)"}
