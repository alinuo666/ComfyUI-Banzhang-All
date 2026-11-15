# -*- coding: utf-8 -*-
"""🔗 顺序锚：给两条互不依赖的分支造一条真实的先后依赖。

老三采工作流把「顺序锚」挂在二采链末端（旧续拍存档），只锁住「一采合并
先于二采净化」，锁不住二采放大 —— 调度器跑完二采放大才被迫回头补一采解码。
本节点必须插在**后一阶段的起点**，等待口接前一阶段最后完成的节点。
不读数据、不改数据，只用 ComfyUI 自己的拓扑依赖排序。
"""


class BanZhang_OrderAnchor:
    """等待口的上游先跑完，数据口才放行；数据原样透传。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "等待": ("*", {
                    "tooltip": "接必须先跑完的那个节点的任意输出，例如上一采的「视频合并」。这里的值不会被读取，只用来排顺序。",
                }),
                "数据": ("*", {
                    "tooltip": "接原本要送进后一阶段的数据（如潜空间），原样输出，不改内容。",
                }),
            },
        }

    # "*" = 通用类型，与「互斥选路器」同口径，可接 LATENT / IMAGE / MODEL…
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("数据",)
    FUNCTION = "passthrough"
    CATEGORY = "👨‍🏫班长/工具与标注"
    DESCRIPTION = (
        "保证两段工作流的先后：先把「等待」接的节点跑完，再把「数据」交给下游。"
        "放在后一阶段的第一个节点之前，不要放在链尾。"
    )

    def passthrough(self, 等待, 数据):
        # 等待只用来生成拓扑依赖，函数体故意不读它；删掉这个参数等于删掉约束。
        return (数据,)


NODE_CLASS_MAPPINGS = {"BanZhang_OrderAnchor": BanZhang_OrderAnchor}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_OrderAnchor": "🔗 顺序锚（保证先后）"}
