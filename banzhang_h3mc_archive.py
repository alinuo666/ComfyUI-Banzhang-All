# -*- coding: utf-8 -*-
"""💾 H3 续拍存档 · 中央档案统一编号（**唯一写盘内核** + 注册层包装）

20261111 阶段 1：写盘方已从「💾 续拍存档」节点迁移到「🎬 H3 VAE 快速解码」。
本文件不再属于某个画布节点，而是全工程唯一的写盘内核：mirror_to_central()
由 VAE 解码节点在解码前调用；apply_archive() 只是给仍注册着的老节点留一条
能跑的路（新工作流画布上不放这个节点，也不再需要「顺序锚」）。

设计
----
续拍存档不使用 ComfyUI 保存计数器，以导演台当前段和当前 take 为唯一归属：

    output/h3_chain/<片名>/clip_000N.t<take>.cont.safetensors        s1 一采
    output/h3_chain/<片名>/clip_000N.t<take>.s2.cont.safetensors     s2 二采

**一个阶段一份 AV latent，两份属于同一个 take。** s1 沿用旧文件名（承接窗口、
整片潜空间等所有既有读者零改动），s2 只是同一版本下的第二份加工档 ——
一次运行里一采/二采两个解码节点写的是「一版两阶」，不是「两个版本」。

20261104 之前，本节点内部会先调用「📦 H3 段落存档」写一份
``clip_000N.t<take>.latent.safetensors``，再自己拷出 ``.cont.safetensors``。
两份内容完全相同、却由两条独立代码路径写入，任何一次写入失败都会留下
「只有一个文件」的半档；而下游按文件名分读（钉帧/整片潜空间读 .latent，
承接窗口读 .cont），于是出现加长被拒、收片缺档、整片潜空间静默丢段。
现在本节点自己完成登记 + 写盘，📦 节点与 .latent 文件一并删除。

「顺序锚」已删除：Ticket 一律从全图唯一导演台认段，提交前门禁保证唯一。
"""

import os
import threading
import time

_NODE_ID = "MiniMaxH3MotionContextSaveLatent"
_TAG = "[H3 续拍存档]"

# 本次运行的 take 分配表。一次 prompt 里一采/二采两个 VAE 解码节点会各调一次
# mirror_to_central()，必须落到**同一个 take**；旧逻辑每次都 current_take+1，
# 会把一版两阶写成 t2/t3 两个版本。
# 键用 Ticket.fingerprint（整份 prompt 的哈希）：同一次 Queue 里两个节点拿到
# 的是同一份 prompt → 同一指纹；换了提示词/seed/参数 → 指纹变 → 新开版本。
# prompt 完全相同再点一次 Queue 时结果本就字节一致，复用同一 take 是对的。
_RUN_TAKES = {}
_RUN_LOCK = threading.Lock()


def _take_for_run(name, cid, run_key, meta, stage="s1"):
    """返回 (take, 是否本次新开版本)；同一 run_key 只分配一次。

    二采(s2)复用当前 take，不另开版本：一采/二采是同一版的两份加工档
    （s1 主档 + s2 放大档），不是两个版本。旧写法每次调用都 current_take+1，
    一采落 take1、二采落 take2，cont_saved 与续接查找按 current_take 拼路径
    就指向从没写过的文件 —— 这正是「第 2 段找不到续接档」的根。
    """
    with _RUN_LOCK:
        key = (str(name), str(cid), str(run_key))
        if key in _RUN_TAKES:
            return _RUN_TAKES[key], False
        if stage == "s2":
            # 二采复用一采刚写的那版，不推进、不缓存：它的 take 由当前状态决定，
            # 缓存反而会在 current_take 推进后返旧值。同 run 里一采先写已缓存，
            # 上面 cache 命中即与一采同 take，不会分裂。
            return max(1, int(meta.get("current_take") or 1)), False
        take = max(1, int(meta.get("current_take") or 0) + 1)
        _RUN_TAKES[key] = take
        if len(_RUN_TAKES) > 64:      # 只留最近 32 次，避免长跑内存无界增长
            for old in list(_RUN_TAKES)[:-32]:
                _RUN_TAKES.pop(old, None)
        return take, True

# 开关两档文字一并提供中文：ComfyUI 原生支持 BOOLEAN 的 label_on / label_off
# （comfy/comfy_types/node_typing.py），不写就回落成前端默认的英文 true/false。
_ENABLED_SPEC = ("BOOLEAN", {
    "default": True,
    "label": "启用存档",
    "label_on": "开",
    "label_off": "关",
    "tooltip": "关掉后本节点只透传潜空间，不写档、不推进 take、不登记段落。"
               "新工作流不需要本节点：写盘已由「🎬 H3 VAE 快速解码」承担。",
})


def _set_last_saved(path):
    """把中央 cont 路径登记给 _h3mc；兼容旧代码读取 LAST_SAVED。"""
    try:
        from ._h3mc import nodes as mc_nodes
    except Exception:
        from _h3mc import nodes as mc_nodes
    mc_nodes.LAST_SAVED = {"path": path, "time": time.time()}


def _write_av_latent(latent, path):
    """把采样器输出的 AV latent 写成**唯一**那份 cont 文件。

    只复用 csglide_clip 里的容器工具函数（拆 NestedTensor / 安全落盘），
    不再调用任何存档节点类。Windows 上 safetensors 是内存映射的，
    _write_st 内部先写 .tmp 再 os.replace，避免覆盖正在被读的文件时炸。
    """
    from .nodes.csglide_clip import _streams, _write_st

    streams = _streams((latent or {}).get("samples"))
    if not streams:
        raise ValueError("续拍存档收到的潜空间是空的。")
    tensors = {}
    for i, stream in enumerate(streams):
        key = "video" if i == 0 else "audio" if i == 1 else "s%d" % i
        tensors[key] = stream.cpu().contiguous()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _write_st(path, tensors)
    return tensors


def _ticket_identity(prompt, unique_id):
    """从本次 prompt 编译 Ticket，返回 (工程名, 段 id, Ticket)。

    默认严格：编译失败一律抛错，绝不退回全局 current 猜段 —— 这正是
    「采样 6 分钟里 current 被改回旧段、第 3 段成果存进第 2 段」的根治点。
    应急回退仅供真机排障：设环境变量 BZ_TICKET_FALLBACK=1 后重启。
    """
    try:
        from .core.csglide_ticket import ticket_from_prompt
    except ImportError:
        from .core.csglide_ticket import ticket_from_prompt

    fallback = os.environ.get("BZ_TICKET_FALLBACK", "").strip() == "1"
    try:
        ticket = ticket_from_prompt(prompt, unique_id)
        print("%s Ticket 认段：%s（指纹 %s）"
              % (_TAG, ticket.label, ticket.fingerprint[:12]))
        cid = ticket.clip_id
        if getattr(ticket, "id_kind", "clip") == "shot":
            # 与 _register_clip 完全同一口径（csglide_cast.py:2791-2801）：
            # 按稳定 shot uid 从档案反查真实 cid，绝不读全局 current。
            try:
                from . import csglide_chain as ch
            except ImportError:
                import csglide_chain as ch
            cid = ""
            for row in (ch.summary(ticket.project_id).get("clips") or []):
                if str(row.get("shot") or "") == ticket.shot:
                    cid = str(row.get("id") or "")
                    break
            if not cid:
                raise RuntimeError(
                    "%s 按分段 uid %s 没在档案里找到段落 —— 请先重跑上一段让它登记，"
                    "或在时间轴上认领该段。" % (_TAG, ticket.shot))
            print("%s 按 shot uid 认段：%s → %s" % (_TAG, ticket.shot, cid))
        return ticket.project_id, cid, ticket
    except Exception as exc:
        if not fallback:
            raise RuntimeError(
                "%s Ticket 认段失败：%s。本节点不再读全局 current 猜段；"
                "请用画布正常 Queue（由提交前编译注入 chain.clip）。"
                "应急回退：设环境变量 BZ_TICKET_FALLBACK=1 后重启。" % (_TAG, exc))
        print("⚠️ %s Ticket 认段失败，已按应急开关回退到旧 current 路径：%s"
              % (_TAG, exc))
        try:
            from . import csglide_chain as chain
        except ImportError:
            import csglide_chain as chain
        name = chain.last_name() or ""
        cid = ""
        if name:
            cid = ((chain.load_chain(name) or {}).get("current") or "").strip()
        return name, cid, None


def mirror_to_central(latent, prompt=None, unique_id=None, stage=None):
    """把当前 latent 归到 Ticket 指定的段，按 (段, take, 阶段) 写一份 cont。

    **全工程唯一写盘入口**，调用方是「🎬 H3 VAE 快速解码」节点。
    · 返回 None  = 本次没有导演台/工程身份（普通工作流），只解码不写档；
    · 返回 dict  = 写盘成功；
    · 抛 RuntimeError = 有工程但认段失败，一律硬停，绝不读全局 current 猜段。
    """
    try:
        from . import csglide_chain as chain
    except ImportError:
        import csglide_chain as chain
    try:
        from .core.csglide_ticket import CAST_TYPES, decode_stage
    except ImportError:
        from .core.csglide_ticket import CAST_TYPES, decode_stage

    graph = prompt if isinstance(prompt, dict) else {}
    has_cast = any(isinstance(v, dict) and v.get("class_type") in CAST_TYPES
                   for v in graph.values())
    if not has_cast:
        return None        # 不带导演台的普通工作流：不该让它连解码都用不了

    name, cid, ticket = _ticket_identity(prompt, unique_id)
    if not name or not cid:
        raise RuntimeError(
            "%s Ticket 没能给出工程名 / 段 id：不读全局 current 猜段。"
            "请用导演台画布正常 Queue（提交前编译会注入 chain.clip / chain.shot）。"
            % _TAG)
    meta = chain.load_clip(name, cid)
    if meta is None:
        raise RuntimeError(
            "%s 段 %s/%s 在档案里不存在：请先让导演台登记这一段，再跑采样。"
            % (_TAG, name, cid))

    if stage not in ("s1", "s2"):
        stage = decode_stage(graph, unique_id)

    run_key = ticket.fingerprint if ticket is not None else "%s|%s" % (name, cid)
    take, fresh = _take_for_run(name, cid, run_key, meta, stage)
    path = chain.clip_cont(name, cid, take, stage)
    tensors = _write_av_latent(latent, path)

    # 每次写盘都重读 meta：同一 run 里另一个阶段可能刚刚才写完，拿旧 meta
    # 覆盖会把对方登记的 stages 抹掉（这就是「阶段档互相盖」的根）。
    meta = chain.load_clip(name, cid) or {}
    takes = list(meta.get("takes") or [])
    if take not in takes:
        takes.append(take)
    tp = dict(meta.get("take_params") or {})
    rec = dict(tp.get(str(take)) or {})
    stages = dict(rec.get("stages") or {})
    stages[stage] = path
    rec["stages"] = stages
    rec["run_fingerprint"] = run_key
    rec["cont_saved_of"] = str(cid)
    # 承接窗口跟随时间轴当前选中阶段（冲突 2=A / Q6=A）；默认 s1 主档。
    rec["cont_saved"] = chain.clip_cont(name, cid, take, chain.current_stage(name))
    tp[str(take)] = rec
    chain.update_clip(name, cid, {
        "takes": takes, "current_take": take,
        "has_latent": True, "pending": None, "take_params": tp,
    })
    _set_last_saved(path)

    names = ", ".join("%s(%s)" % (k, tuple(v.shape)) for k, v in tensors.items())
    print("%s 已统一归档：%s / %s / take %d / %s%s，cont=%s；流：%s"
          % (_TAG, name, cid, take, stage,
             "（本次新开版本）" if fresh else "（同一 run 复用版本）",
             os.path.basename(path), names))
    return {
        "name": name, "cid": cid, "take": take, "stage": stage,
        "cont_path": path, "new_take": fresh,
        "ticket": ticket.ticket_hash() if ticket is not None else None,
    }


def apply_archive(cls_map):
    """给仍注册着的老存档节点保留一条能跑的路（新画布不放它）。

    20261111 阶段 1 起「顺序锚」已删除、写盘方是 🎬 H3 VAE 快速解码；这里只
    保留「启用存档」开关与 Ticket 认段，让老节点万一还在画布上也不至于出错。
    """
    cls = cls_map.get(_NODE_ID)
    if cls is None:
        return False
    try:
        # 取未绑定的原函数，避免 classmethod 包装后多传一次 cls。
        orig_input = cls.INPUT_TYPES.__func__

        def _patched_input(cls, *a, **k):
            data = orig_input(cls, *a, **k)
            required = data.get("required") or {}
            # 保存路径和本片段编号不再交给用户；统一由 Ticket/take 决定。
            required.pop("filename_prefix", None)
            required.pop("clip_index", None)
            # 开关设为可选（默认开）：老工作流/老模板没有这个控件也不会被判缺字段，
            # 且可选控件同样会随工作流提交、带默认值，中央选片能照常读到状态。
            data.setdefault("optional", {})["archive_enabled"] = _ENABLED_SPEC
            # hidden 只用于读本次 prompt 与节点 id，不渲染控件、不改连线。
            # execution.py:216-228 确认 PROMPT 给的是完整原始 prompt 字典。
            hidden = data.setdefault("hidden", {})
            hidden["prompt"] = "PROMPT"
            hidden["unique_id"] = "UNIQUE_ID"
            return data

        cls.INPUT_TYPES = classmethod(_patched_input)

        def _patched(self, *a, **kw):
            latent = kw.pop("latent", None)
            if latent is None and a:
                latent = a[0]
            prompt = kw.pop("prompt", None)
            node_id = kw.pop("unique_id", None)

            # 开关关闭：纯透传，不写档、不推进 take、不登记段落（20261017）。
            if not kw.pop("archive_enabled", True):
                return (latent,)

            stale = []
            for key in ("filename_prefix", "clip_index"):
                if key in kw:
                    value = kw.pop(key)
                    if value not in (None, "", 0):
                        stale.append("%s=%r" % (key, value))
            if stale:
                print("%s 旧参数 %s 已失效；现在按 Ticket/中央段落/take 统一编号。"
                      % (_TAG, "、".join(stale)))

            # 关键字传参：写盘内核签名以后再加维度也不会把 prompt / unique_id
            # 错位塞进别的参数（位置传参吃过这个亏）。
            info = mirror_to_central(latent, prompt=prompt, unique_id=node_id)
            if info is None:
                print("%s 本次没有导演台/工程身份，按普通工作流纯透传，不写档。" % _TAG)
            # 输出仍为 latent 直通，供后续 VAE 解码和二采链使用。
            return (latent,)

        cls.save = _patched
        return True
    except Exception as e:
        print("⚠️ [班长全家桶] 续拍存档统一编号未挂载: %s" % e)
        return False
