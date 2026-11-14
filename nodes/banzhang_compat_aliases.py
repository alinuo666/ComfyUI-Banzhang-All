# -*- coding: utf-8 -*-
"""已注销节点的兼容别名（只保「能打开」，不恢复旧功能）。

背景
----
20261112 起两个节点被正式移除，但模板 producer_video_h3*.json、用户已保存的
老工作流、以及 js/banzhang_h3mc_alias.js 等前端改写逻辑仍引用这两个内部名：

* ``BanZhang_IgnoreGroups``   —— 「忽略多组」，__init__.py 第 24 组注销
* ``BanZhang_H3_ClipArchive`` —— 「💾 H3 续拍存档」，第 32 组注销，
  写盘已并入「🎬 H3 VAE 快速解码」

ComfyUI 打开工作流时遇到找不到的 class_type 会直接弹「节点未注册」，整张图不可用。
与其去改四份模板加一堆前端别名（模板还是生成器产出的，重建一次就回来），
不如在这里按旧端口契约挂一对直通节点：老图零改动即可打开，菜单里也能一眼看出已停用。

职责边界：不写盘、不改数据、不注册路由，只做端口兼容。
"""

_已提示 = set()


def _提示一次(名字, 去向):
    if 名字 in _已提示:
        return
    _已提示.add(名字)
    print(f"⏭️ [班长全家桶] 「{名字}」已停用并由兼容节点接管"
          f"（功能现由「{去向}」负责）；建议另存为新工作流后删掉这个旧节点。")


class 旧版忽略多组兼容:
    """端口契约与已移除的 BanZhang_IgnoreGroups 一致：无输入、无输出、OUTPUT_NODE。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "直通"
    CATEGORY = "👨‍🏫班长/兼容（旧工作流）"
    OUTPUT_NODE = True

    def 直通(self):
        _提示一次("忽略多组", "画布自带的编组禁用")
        return ()


class 旧版续拍存档兼容:
    """旧「💾 H3 续拍存档」的端口壳：接 latent / 顺序锚，输出一个顺序锚占位。

    下游 BanzhangProducerClipAdopt 的「顺序锚」是 (*) 通配口，只用来保证执行
    先后、不读具体值，所以给一个常量即可，不必恢复写盘逻辑。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {
            "latent": ("*", {}),
            "顺序锚": ("*", {}),
        }}

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("顺序锚",)
    FUNCTION = "直通"
    CATEGORY = "👨‍🏫班长/兼容（旧工作流）"
    OUTPUT_NODE = False

    def 直通(self, latent=None, 顺序锚=None):
        _提示一次("H3 续拍存档", "🎬 H3 VAE 快速解码")
        return (0,)


NODE_CLASS_MAPPINGS = {
    "BanZhang_IgnoreGroups": 旧版忽略多组兼容,
    "BanZhang_H3_ClipArchive": 旧版续拍存档兼容,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_IgnoreGroups": "忽略多组（旧工作流兼容·已停用）",
    "BanZhang_H3_ClipArchive": "💾 H3 续拍存档（旧工作流兼容·已停用）",
}
