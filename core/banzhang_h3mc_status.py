# -*- coding: utf-8 -*-
"""💾 H3 续拍存档 · 潜空间直通输出（注册层包装）

历史
----
本文件原先还负责节点顶部的「状态信息面板」：算内容指纹、统计链上槽位，
执行后经 websocket 推给前端 DOM 面板（js/banzhang_h3mc_save_status.js）显示
槽位 / 文件名 / 画面声音形状 / 指纹 / 链上最大槽号。

2026-10-12 应用户要求删除该信息显示：前端面板 JS 已移除（原文件备份在
docs/archive/banzhang_h3mc_save_status.js.bak_remove_panel_20261012），
指纹计算、槽位统计与事件推送也一并从本文件撤掉 —— 留着只会在每次存档时
白把整份潜空间搬去 CPU 做摘要，且推送已无人接收。

保留的唯一改造（与信息显示无关，存档链路在用）：
上游原版 `save()` 返回的是存档文件路径字符串；这里把节点输出改成
**潜空间直通** —— 把输入的画面+声音联合潜空间原样吐出去，存档之后可以
直接接 VAE 解码 / 下游节点，不用再从文件读回。

全部在注册层完成，`_h3mc/` 上游一行不动（该目录升级时整个覆盖，写进去
等于每次升级都要重新打补丁，与 banzhang_h3mc_zh / banzhang_h3mc_archive
同一路数）。
"""

_NODE_ID = "MiniMaxH3MotionContextSaveLatent"


def apply_status(cls_map):
    """把续拍存档节点的输出改成潜空间直通。单节点失败只跳过它，不拖垮整包。

    函数名保留旧名 apply_status（__init__.py 按此名导入）；其实际职责已变为
    「直通输出包装」，原状态信息面板已于 2026-10-12 移除。
    """
    cls = cls_map.get(_NODE_ID)
    if cls is None:
        return False
    try:
        # 输出改成潜空间直通：存档路径只在内部流转，不再对外输出。
        cls.RETURN_TYPES = ("LATENT",)
        cls.RETURN_NAMES = ("潜空间",)

        orig_save = cls.save

        def _patched_save(self, latent, filename_prefix, clip_index=0, **kw):
            # 先按上游原逻辑把潜空间写盘，再把输入潜空间原样吐给下游。
            orig_save(self, latent, filename_prefix, clip_index, **kw)
            return (latent,)

        cls.save = _patched_save
        return True
    except Exception as e:
        print(f"⚠️ [班长全家桶] 续拍存档直通改造未挂载: {e}")
        return False
