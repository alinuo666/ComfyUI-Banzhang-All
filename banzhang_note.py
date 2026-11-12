# -*- coding: utf-8 -*-
"""
注释 · 虚拟节点（后端桩）
================================================================================
仅在 /object_info 中登记节点，使前端节点库把它归入「👨‍🏫班长/工具」目录与班长全家桶节点包。
节点本体（绘制、文本编辑、序列化）由 js/banzhang_note.js 的前端类接管，
该前端类 isVirtualNode = true，不参与执行，本桩节点不会被提交到后端。
================================================================================
"""


class BanzhangNote:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "👨‍🏫班长/工具与标注"

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "注释": BanzhangNote,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "注释": "注释",
}
