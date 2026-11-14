"""📤 H3 段落调取 —— 从中央档案把某一版 AV latent 读回图里。

20261104 起，一段一版**只有一份** AV latent 文件：

    output/h3_chain/<片名>/clip_000N.t<take>.cont.safetensors

它由「💾 H3 续拍存档」写入，同时充当下一段的承接窗口、本段的钉帧/加长
原稿、整片潜空间拼接的段落来源。

此前还并行存在一份内容完全相同的 ``.latent.safetensors``（由「📦 H3 段落
存档」写入），两套文件名被不同读者分读：钉帧/整片潜空间读 .latent，承接
窗口读 .cont。任一次写入只成功一半，就会留下「只有一个文件」的半档 ——
整片潜空间因此静默丢段、时间轴整体前移，表现为「顺序乱 + 部分片段闪」。
现在写入方只有一个（💾），读取路径只有 clip_cont()，📦 节点已删除。

本文件剩下的 ``_streams`` / ``_write_st`` / ``_META`` 是**公共 AV 容器工具**
（拆 NestedTensor、Windows 上先写 .tmp 再替换的安全落盘），💾 续拍存档也
复用它们；它们不属于任何节点，也不产生第二份文件。
"""

import json
import os

try:
    from safetensors.torch import load_file as _st_load, save_file as _st_save
except Exception:      # pragma: no cover
    _st_load = _st_save = None

try:
    from comfy.nested_tensor import NestedTensor
except Exception:      # pragma: no cover
    NestedTensor = None

try:                                  # 作为插件包被 ComfyUI 加载
    from .. import csglide_chain as chain
except Exception:                     # pragma: no cover —— 单独跑自检时
    import csglide_chain as chain

_META = {"format": "h3_motion_context_av_v1"}


def _streams(samples):
    if samples is None:
        return []
    if getattr(samples, "is_nested", False):
        return list(samples.unbind())
    return [samples]


def _write_st(path, tensors):
    """Windows 上 safetensors 是内存映射的，直接覆盖会炸；先写 .tmp 再替换。"""
    import gc
    tmp = path + ".tmp"
    try:
        _st_save(tensors, tmp, metadata=_META)
        try:
            os.replace(tmp, path)
        except OSError:
            gc.collect()
            os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


class _NameMixin:
    """片名解析：留空就跟导演台走。

    导演台每次运行都会 mark_last(工程名)。本节点留空读它，就永远不会出现
    「导演台叫 A、节点读的是 B，看着跑通了其实读了另一个档案」这种事。
    """

    @staticmethod
    def _name(片名):
        n = (片名 or "").strip()
        if n:
            return n
        n = chain.last_name()
        if not n:
            raise ValueError(
                "H3 段落调取：片名留空，但也没有「最近登记过」的片子 —— "
                "先在 🎞️ H3 导演台的「工程」面板里填工程名（它就是片名），"
                "跑一次导演台；或者直接在片名栏手打一个。")
        print("[H3 段落调取] 片名留空 → 跟随导演台：%s" % n)
        return n


class CSGlideClipLoadCS(_NameMixin):
    """把档案里的某一段读回图里。重抽时用它拿引导头，替换时用它拿旧版本。

    只读节点：不写档、不产生新文件、不推进 take。写档一律由
    「🎬 H3 VAE 快速解码」负责（20261111 阶段 1 迁移）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "片名": ("STRING", {"default": "", "label": "片名",
                                   "tooltip": "留空 = 跟随导演台（用导演台工程面板里的工程名）。"}),
                "段落": ("STRING", {"default": "", "label": "段落 id",
                                    "tooltip": "留空 = 取该片「当前段」（与 💾 续拍存档"
                                               "对齐的那一段）。"}),
                "版本": ("INT", {"default": 0, "min": 0, "max": 999, "step": 1,
                                "label": "版本（0=当前）"}),
                "没有档案时": (["直通（不回填）", "报错"],
                              {"default": "直通（不回填）",
                               "label": "没有档案时",
                               "tooltip": "首次运行还没有存档时怎么办。"
                                          "「直通」= 返回空标记，下游 🧷 尾帧回填 "
                                          "会原样放过，照样能存下第一版。"}),
            },
            "optional": {
                # 不参与计算，纯粹是为了**排序**：导演台要先跑完 _register_clip
                # 把「当前段」登记进 chain.json，本节点才读得到对的段。
                # 不接这根线的话，本节点和导演台是两条独立的分支，谁先跑由
                # 图遍历顺序决定 —— 那就可能读到上一轮残留的 current，静默取错段。
                "顺序锚": ("*", {"label": "顺序锚",
                                "tooltip": "不参与计算，只保证本节点排在导演台之后执行："
                                           "导演台要先登记「当前段」，这里才读得到正确的段。"}),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("潜空间", "段落信息")
    FUNCTION = "load"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = "把「🎬 H3 VAE 快速解码」归档的那一段 AV latent 读回图里（跟随时间轴当前阶段）。"

    def load(self, 片名, 段落, 版本=0, 没有档案时="直通（不回填）", 顺序锚=None):
        if _st_load is None:
            raise RuntimeError("H3 段落调取：safetensors 不可用。")
        if 顺序锚 is None:
            print("[H3 段落调取] 提示：没接「顺序锚」，本节点与导演台是两条独立分支，"
                  "谁先跑不保证 —— 若取到的段不对，把导演台「总帧数」接到「顺序锚」上。")

        def empty(why):
            """没有可取的档案：直通模式下给一个空标记，让下游回填原样放过。"""
            if str(没有档案时).startswith("报错"):
                raise ValueError("H3 段落调取：%s" % why)
            print("[H3 段落调取] %s —— 直通（下游回填会原样放过）" % why)
            return ({"samples": None, "bz_empty": True}, why)

        片名 = self._name(片名)
        cid = (段落 or "").strip()
        if not cid:
            cid = (chain.load_chain(片名) or {}).get("current") or ""
            if not cid:
                return empty("片「%s」还没有任何段落" % 片名)
        meta = chain.load_clip(片名, cid)
        if meta is None:
            return empty("没有这一段（%s / %s）" % (片名, cid))
        take = int(版本) if int(版本) > 0 else int(meta.get("current_take") or 1)
        # 20261111 阶段 2：整片潜空间拼接等读者一律跟随时间轴当前选中阶段。
        # s1 沿用旧文件名（零迁移），s2 是同一 take 的第二份加工档。
        stage = chain.current_stage(片名)
        path = chain.clip_cont(片名, cid, take, stage)
        if not os.path.exists(path):
            label = "一采" if stage == "s1" else "二采"
            return empty("这一段第 %d 版还没有「%s」的续拍存档（%s）。"
                         "请先跑一轮把两采都写出来，或把时间轴切回已出片的阶段"
                         % (take, label, path))

        data = _st_load(path)
        order = [k for k in ("video", "audio") if k in data]
        order += [k for k in data.keys() if k not in order]
        streams = [data[k] for k in order]
        if NestedTensor is None or len(streams) < 2:
            samples = streams[0]
        else:
            samples = NestedTensor(streams)

        info = json.dumps({
            "id": meta.get("id"), "index": meta.get("index"),
            "frames": meta.get("frames"), "take": take,
            "takes": meta.get("takes"), "pending": meta.get("pending"),
            "prompt": meta.get("prompt_seg"),
            "shapes": {k: tuple(data[k].shape) for k in order},
        }, ensure_ascii=False, indent=1)
        return ({"samples": samples}, info)


NODE_CLASS_MAPPINGS = {
    "CSGlideClipLoadCS": CSGlideClipLoadCS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CSGlideClipLoadCS": "📤 H3 段落调取 (H3 Clip Load)",
}
