# -*- coding: utf-8 -*-
"""✍️ H3 文案台 —— 提示词的独立节点。

为什么独立出去：导演台那块面板已经装了画布、参考卡、成片监视器、分段条，
提示词挤在最后面，写长剧本要一路往下滚。拆出来之后导演台只管「怎么生成」，
文案台只管「说什么」。

链路是 **媒体架 → 文案台 → 导演台**：

    媒体架 ──参考素材──> 文案台 ──参考素材──> 导演台
                           └────提示词────────┘

参考素材是**透传**的：文案台自己不编码素材（那是导演台的活），它只是需要
看一眼槽位，好把 @图片1 / @视频2 / @音频1 这些标签摆成 chips 让用户点。
透传而不是让导演台自己接一根线，是为了让「标签里看到的」和「实际送进去的」
永远是同一份——两头各接一次，素材架换一次位就可能不一致。

段身份由**前端**写进 state，不靠执行顺序推导：文案台排在导演台前面执行，
那时 chain.json 里的 current 还是上一段，靠后端反查必然认错段。前端直接读
导演台节点上的工程快照（同一个 gcast_project），拿到当前分段的 uid。
"""

import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    from . import csglide_chain as chain
except Exception:                                    # 顶层导入（自检）
    import csglide_chain as chain                     # noqa: E402

# 提示词改写：复用图像编辑台那套（clip.tokenize → clip.generate → clip.decode），
# 守门规则也共用一份，别在这里抄第二份。
try:
    from .csglide_image_models import (
        REWRITE_MAX_LENGTH_DESK, REWRITE_SYSTEM_OFFICIAL, rewrite_normalized,
        _allowed_task_types,
    )
    from .csglide_assets import load_image as _load_image
except Exception:                                    # 顶层导入（自检）
    from csglide_image_models import (                # noqa: E402
        REWRITE_MAX_LENGTH_DESK, REWRITE_SYSTEM_OFFICIAL, rewrite_normalized,
        _allowed_task_types,
    )
    from csglide_assets import load_image as _load_image   # noqa: E402

# 改写模型直连加载需要这两个（无 server 的自检环境可能没有，退化为 None）
try:
    import nodes as _nodes
    import folder_paths as _folder_paths
except Exception:                                    # 顶层导入（自检）
    _nodes = None
    _folder_paths = None

# 提示词里 @标签 的规范写法，与 csglide_cast.py 保持一致（那里是权威定义）。
# 这里只做「本段/片子级拼接」与归档，不改写法规则。
_GLUE_RE = re.compile(r"(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)")


_ANY_REF_RE = re.compile(r"@(?:图片|音频|视频)\d+")


def _provided_refs(refs):
    """refs 里**真有文件**的槽位编号集合（编号 = 槽位位置，1 起）。"""
    if not refs:
        return set()
    try:
        data = json.loads(refs) if isinstance(refs, str) else refs
    except Exception:
        return set()
    slots = data.get("slots") if isinstance(data, dict) else None
    if not isinstance(slots, dict):
        return set()
    out = set()
    for kind, label in (("images", "图片"), ("videos", "视频"), ("audios", "音频")):
        for i, slot in enumerate(slots.get(kind) or [], start=1):
            if isinstance(slot, dict) and slot.get("file"):
                out.add("@%s%d" % (label, i))
    return out


def _drop_unbacked_refs(text, refs, log):
    """把「没有对应参考图」的编号从文本里摘掉，返回 (新文本, 被摘掉的编号列表)。

    为什么必须摘：编号是给导演台按槽位找素材用的，悬空编号找不到图 = 画面失控，
    而且模型会以为有素材、照着写引用。摘掉后模型按其上下文用文字描述替代
    （@图片1中的小明 → 小明），这也是用户要的「改成对应文字描述」。
    """
    if not text:
        return text, []
    _have = _provided_refs(refs)
    _drop = sorted(set(_ANY_REF_RE.findall(text)) - _have)
    if not _drop:
        return text, []
    for r in _drop:
        text = text.replace(r, "")
    text = re.sub(r"[ \t]{2,}", " ", text)
    log("未提供对应参考图的引用已改为文字描述：%s" % "、".join(_drop))
    return text, _drop


def _ref_facts(refs):
    """媒体架槽位 → 素材事实表：{"images": [名字或 None, ...], "videos": ..., "audios": ...}。

    下标 + 1 = 槽位编号（空槽也占号，@图片2 永远是第 2 格）。**改写管线里
    「本次有哪些素材」只有这一个来源**——清单文本、守门白名单、机械裁剪全从它
    派生。20261101 凭空冒出 <Video 1> 的根因就是三处口径各写一份：指南讲通用
    标签、清单只列 @编号、守门只查 @编号，没人知道"这次没有视频"。
    """
    if not refs:
        return None
    try:
        data = json.loads(refs) if isinstance(refs, str) else refs
    except Exception:
        return None
    slots = data.get("slots") if isinstance(data, dict) else None
    if not isinstance(slots, dict):
        return None
    out = {}
    for kind in ("images", "videos", "audios"):
        arr = []
        for slot in (slots.get(kind) or []):
            if not (isinstance(slot, dict) and slot.get("file")):
                arr.append(None)
                continue
            al = slot.get("alias")
            if isinstance(al, list) and al:
                arr.append(str(al[0]))
            else:
                arr.append(os.path.splitext(
                    str(slot["file"]).replace("\\", "/").split("/")[-1])[0])
        out[kind] = arr
    return out


def _ref_manifest(refs):
    """把事实表铺成「给模型看的允许清单」+ 返回事实表本身（守门/裁剪共用）。

    文本里必须显式写「这次没有视频/音频」与「只能用哪些任务类型」：模型按
    指南的通用词汇造句，不告诉它边界就会造出 <Video 1>。
    """
    facts = _ref_facts(refs)
    if not facts:
        return "", None

    def _ids(kind):
        return [(i + 1, nm) for i, nm in enumerate(facts.get(kind) or []) if nm]

    lines = ["【本次素材（改写必须遵守）】"]
    for kind, label in (("images", "图片"), ("videos", "视频"), ("audios", "音频")):
        ids = _ids(kind)
        if ids:
            lines.append("%s %d 个：%s" % (label, len(ids), "，".join(
                "@%s%d = %s" % (label, i, nm) for i, nm in ids)))
        else:
            lines.append("无%s素材" % label)
    lines.append("【引用规则】输入里的 @图片N / @视频N / @音频N 必须逐字保留，"
                 "不得增删改号；只能用上面列出的编号。")
    for kind, tag in (("images", "Picture"), ("videos", "Video"), ("audios", "Audio")):
        nums = sorted(i for i, _ in _ids(kind))
        if not nums:
            lines.append("禁止出现 <%s N>（本次没有对应素材）" % tag)
        elif nums != list(range(1, max(nums) + 1)):
            lines.append("<%s N> 只能用 N = %s" % (tag, "、".join(str(n) for n in nums)))
        else:
            lines.append("<%s N> 只能用 N = 1–%d" % (tag, max(nums)))
    lines.append("【任务类型】只能用 %s（summary 开头方括号里）"
                 % "、".join(sorted(_allowed_task_types(facts))))
    return ("\n".join(lines), facts)


def _rewrite_ref_images(refs, log, cap=512):
    """改写模型要看的参考图：只缩不放，长边夹到 cap 并对齐 32。

    从媒体架透传的 H3_REFS 里取，**不改引用本身**（导演台那份数据一个字节都不动）。
    改写发生在筛图之前——那时还没有提示词可依，所以有图的槽位全给，不做挑选。
    缩到 512 的理由：原图直塞视觉塔既慢又吃显存，改写是锦上添花，不该顶掉采样。
    """
    if not refs:
        return []
    try:
        data = json.loads(refs) if isinstance(refs, str) else refs
    except Exception:
        return []
    slots = data.get("slots") if isinstance(data, dict) else None
    if not isinstance(slots, dict):
        return []
    try:
        import comfy.utils as _cu
    except Exception:
        return []
    out = []
    for slot in (slots.get("images") or []):
        if not isinstance(slot, dict) or not slot.get("file"):
            continue
        try:
            img = _load_image(slot["file"])          # [1,H,W,3]
        except Exception as e:
            log("参考图 %s 读不到（%s），这张跳过" % (slot["file"], type(e).__name__))
            continue
        h, w = int(img.shape[1]), int(img.shape[2])
        long = max(w, h)
        if long > cap:
            s = cap / long
            nw = max(32, (int(w * s) // 32) * 32)
            nh = max(32, (int(h * s) // 32) * 32)
            img = _cu.common_upscale(img.movedim(-1, 1), nw, nh,
                                     "lanczos", "disabled").movedim(1, -1)
        out.append(img)
    return out


_REWRITE_MODEL_FILE = "qwen3.5-2b-int8.safetensors"
_rw_clip_cache = None          # (模型文件相对路径, clip) 或 None


def _rewrite_model_names():
    """改写模型下拉候选：MOSS-Image 目录下的编码器（挂 moss_image tokenizer
    才能同时看参考图与出字）。没有该目录时退回全列表。"""
    if _folder_paths is None:
        return []
    names = [n.replace("\\", "/") for n in _folder_paths.get_filename_list("text_encoders")]
    moss = sorted(n for n in names if n.startswith("MOSS-Image/"))
    return moss or sorted(names)


def _resolve_rewrite_model(model_file):
    """用户选的模型文件名 → folder_paths 相对路径；空 = 默认。找不到列出候选。"""
    base = ((model_file or "").strip() or _REWRITE_MODEL_FILE).replace("\\", "/").split("/")[-1]
    for n in _rewrite_model_names():
        if n.split("/")[-1] == base:
            return n
    raise FileNotFoundError(
        "改写模型 %s 没找到，可选的有：%s" % (base, "、".join(_rewrite_model_names())))


def _get_rewrite_clip(log, model_file=None):
    """「立即改写」用的改写模型：与连线解耦，按文件名直连加载。

    默认模型 = MOSS 的 Qwen3.5 9B 编码器：带视觉塔（能看参考图）+ lm_head（能出字）。
    type 必须是 moss_image——qwen3.5_9b 只有挂上 MOSSImageTokenizer 才同时具备
    这两样；挂成 qwen_image 会是另一套 tokenizer。
    类变量缓存：第一次点击从磁盘读一次（几秒），之后常驻；改写完交还的是驻留页，
    对象仍在，重跑不需要重读磁盘。找不到模型时抛错并列出目录现有文件。
    """
    global _rw_clip_cache
    hit = _resolve_rewrite_model(model_file)
    if _rw_clip_cache is not None and _rw_clip_cache[0] == hit:
        return _rw_clip_cache[1]
    if _rw_clip_cache is not None:
        # 换模型：旧的一份先请出显存账本——两份权重叠在 22GB 卡上必爆。
        log("切换改写模型：%s → %s" % (_rw_clip_cache[0], hit))
        try:
            _release_rewrite_clip(_rw_clip_cache[1], log)
        except Exception as _e:
            log("旧改写模型退场失败（继续加载新模型）：%s: %s" % (type(_e).__name__, _e))
        _rw_clip_cache = None
    if _nodes is None or _folder_paths is None:
        raise RuntimeError("环境缺少 nodes / folder_paths，无法加载改写模型")
    loader = _nodes.NODE_CLASS_MAPPINGS["CLIPLoader"]()
    # 加载前主动腾显存：改写模型 9B int8 ≈ 9.3GB，与 H3(约20GB)+H3编码器(约15.7GB)
    # 在 22GB 卡上必然争抢。交给账本「边加载边驱逐」会在 H3 驻留时顶到墙直接 OOM；
    # 先按真实需求量腾一次（free_memory(0, dev) 什么都不卸，必须传需求量）。
    try:
        import comfy.model_management as _mm
        _full = _folder_paths.get_full_path("text_encoders", hit)
        _need = int(os.path.getsize(_full) * 1.15) if _full else 10 * 1024 ** 3
        _mm.free_memory(_need, _mm.get_torch_device())
    except Exception as _e:
        log("改写模型加载前腾显存跳过：%s: %s" % (type(_e).__name__, _e))
    clip = loader.load_clip(hit, type="moss_image")[0]
    _rw_clip_cache = (hit, clip)
    log("改写模型 %s 已加载（按文件直连，不依赖画布连线）" % hit)
    return clip


def _release_rewrite_clip(clip, log):
    """改写用完把模型**彻底请出显存账本**。失败绝不能影响出图。

    20261030 爆显存的根因就在这：原实现只交还「驻留页」，对象仍挂在类缓存里，
    ComfyUI 账本据此认为它还在用 → 采样前不愿驱逐 → 与 H3(20GB)+编码器(15.7GB)
    在 22GB 卡上叠加必爆。现在卸账本 + 搬回 CPU + 清缓存，下次点击按需重载。
    """
    global _rw_clip_cache
    try:
        patcher = getattr(clip, "patcher", None)
        if patcher is not None:
            try:
                from .banzhang_vram_cleaner import release_model_residency
            except Exception:
                from banzhang_vram_cleaner import release_model_residency
            ram, vram = release_model_residency(patcher, log=log, label="改写模型")
            if ram or vram:
                log("已交还 —— 显存 %.0f MB / 内存 %.0f MB" % (vram / 1e6, ram / 1e6))
            import comfy.model_management as _mm
            _mm.unload_model_and_clones(patcher, unload_additional_models=False)
            if not patcher.is_dynamic():
                # 动态显存模式下权重由 vbar 托管，参数可能已被替换，不能自己搬。
                patcher.model.to("cpu")
            _mm.soft_empty_cache()
            log("改写模型已从显存账本摘除（下次点击按需重载）")
    except Exception as e:
        try:
            log("回收跳过：%s: %s" % (type(e).__name__, e))
        except Exception:
            pass
    finally:
        _rw_clip_cache = None


def _clean(t):
    return re.sub(r"[ \t]+\n", "\n", str(t or "").replace("\r\n", "\n")).strip()


def compose_text(global_text, seg_text, sep="\n"):
    """片子级 + 本段 = 最终提示词。

    片子级在**前**：它是全片统一的风格/基调，本段是这一段要发生的事。
    反过来写会让每段的开头都在重复世界观，模型的注意力被拉到固定前缀上，
    段与段的差别被稀释。
    """
    parts = [_clean(global_text), _clean(seg_text)]
    parts = [p for p in parts if p]
    out = sep.join(parts)
    return _GLUE_RE.sub(r"\1 ", out)


class CSGlideDeskCS:
    """✍️ H3 文案台 —— 写提示词的地方，接在媒体架与导演台之间。"""

    # 「立即改写」按钮用的缓存：compose 执行时把参考素材存一份，HTTP 路由
    # 兜底用（前端按钮也会把媒体架 rack_data 直接传上来，两条来源谁有值用谁）。
    # 改写模型不依赖连线——按文件名直连加载（见模块级 _get_rewrite_clip）。
    _rw_refs = ""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端把整份 state 写进这个 widget（多行会让 v2 前端渲染成
                # 浮在节点上的 textarea，所以与导演台 h3_data 一样走单行
                # STRING + 前端隐藏）。
                "desk_data": ("STRING", {"default": ""}),
            },
            "optional": {
                "参考素材": ("H3_REFS", {
                    "tooltip": "接 H3 媒体架的「参考素材」。只看不编码："
                               "拿它把 @图片N / @视频N / @音频N 摆成标签，"
                               "点一下就插进提示词。"}),
                "外接提示词": ("STRING", {
                    "forceInput": True,
                    "tooltip": "接线即整体替换本节点的输出（给外部文本源用）。"
                               "留空才用面板里写的词。"}),
            },
        }

    RETURN_TYPES = ("H3_REFS", "STRING")
    RETURN_NAMES = ("参考素材", "提示词")
    FUNCTION = "compose"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = ("H3 文案台——提示词的独立编辑节点。接在媒体架与导演台之间："
                   "参考素材原样透传给导演台，提示词输出给导演台的「外接提示词」。")

    def compose(self, 参考素材=None, 外接提示词=None, desk_data=""):
        st = {}
        try:
            st = json.loads(desk_data) if desk_data else {}
        except Exception:
            st = {}
        if not isinstance(st, dict):
            st = {}

        # 按钮改写的参考图兜底：compose 执行时存下参考素材，路由在没跑过画布时用；
        # 前端按钮也会把媒体架 rack_data 直接传上来，两条来源谁有值用谁。
        type(self)._rw_refs = 参考素材 or ""


        # 片名只认面板 state 里跟来的那份（前端从导演台读来的）：节点上不再
        # 有手动覆盖的「片名 / 段落」参数 —— 那是同一份身份的第二个入口，填了
        # 就会和导演台对不上，写到别的片子里去。
        name_hint = ((st.get("chain") or {}).get("name") or "")

        # 外接优先：接了线就是外部文本源说了算，面板里的词不参与。
        if 外接提示词 is not None:
            text = str(外接提示词)
            print("[H3 文案台] 外接模式：使用外部文本（%d 字）" % len(text))
            # 外接文本不归档：它是外部文本源的内容，写进 prompt_seg 会把面板里
            # 手写的那份盖掉（旧版靠「段落」参数几乎总是空来免掉这一步）。
            return (参考素材, text)

        g = st.get("global") or ""
        segs = st.get("segs") if isinstance(st.get("segs"), dict) else {}

        # 认段：只认面板记下的段身份（前端跟随导演台），认不出就只出片子级。
        cid = (st.get("chain") or {}).get("clip") or ""
        seg = segs.get(cid) if cid else ""
        # 键存在但为空 = 用户真删空。编译层只在段表真有这个键时才写，
        # 所以「键在」现在是可信的意图信号，不能再拿库里的旧词填回来。
        seg_key_present = bool(cid) and cid in segs
        word_src = "本次提交"
        # 新段还没登记时，编译层把段词放在 pending_seg 里随本次提交走；
        # 它不进段表、也不写中央库（临时键被 isRealCid 挡住）。
        if not seg and st.get("pending_seg"):
            seg = str(st.get("pending_seg") or "")
            word_src = "待登记段(本次提交)"
        # ⚠ 20261031：**删掉了按 shot（uid）找词的那条兜底**。
        # 它是"段身份双轨"在执行层的最后残留：clip 取不到词就去翻 segs[shot]，
        # 而 uid 是工程内部编号 —— 段复制/重排/删除后它会错配到**另一段**名下，
        # 表现正是"多段时后面的段拿到了别的段的词"。
        # 段身份只有一个：clip。取不到词就走下面的中央兜底，不靠 uid 猜。

        # [单一真值] 执行层取词优先级。段身份只有 clip（uid 兜底已删），
        # 中央兜底读的是真值列 seg_text_of()，不是投影 desk.segs。
        # 优先级**不许反转** —— 20261025 反转过一次，20261030 实测翻车。
        # 取词的优先级（20261031 定案，两版补丁都在这里翻过车，别再翻）：
        #   1. **执行真相 = 本次提交**（desk_data）。ComfyUI 的可复现性建立在
        #      「输入 = 提交」上：执行时用库覆盖提交，等于同一个工作流跑两次
        #      结果取决于库状态 —— 20261030 实测「编辑后第二次运行输出旧词」
        #      的根因就是它（那时推送有三个静默失败分支，库停在旧词反盖新词）。
        #   2. **中央只兜底"这一段现在没词"**：新机器 / 新段第一次跑 / 提交
        #      快照还没带上这一段。兜底读的是**真值列**
        #      segment_bindings.desk_text（seg_text_of），不是投影 desk.segs。
        #      现在推送失败会明着报错（前端 toast + 终端 warn），不再是静默的。
        # 优先级**不反转**，改的是兜底的判据与取数源：判据只看"有没有词"，
        # 不再赌"前端不会写出空键"；取数源改成真值列，不再是投影。
        if name_hint and cid and cid.startswith("clip_") and (not seg or not g):
            try:
                try:
                    from . import csglide_store as _store
                except Exception:
                    import csglide_store as _store
                _d = _store.chain_dir(name_hint)
                # 20261031：兜底的**判据和取数源**都换了。
                # 判据：只看"这一段现在有没有词"（not seg），**不再**看
                #   `cid not in segs_map` —— 后者在赌"前端永远不会写出空键"，
                #   前端一旦又写出空键，兜底当场静默失效，段词变空。
                # 取数源：`seg_text_of()` 读**真值列** segment_bindings.desk_text，
                #   不再是 desk.segs（那只是投影，方向只能是 真值→投影）。
                if not seg and not seg_key_present:
                    seg = _store.seg_text_of(_d, cid)
                    if seg:
                        word_src = "中央段档案兜底"
                        print("[H3 文案台] 本段词本次提交里没有，已从中央段档案兜底（%d 字）"
                              % len(seg))
                if not g:
                    _desk = _store.load_desk(_d) or {}
                    if isinstance(_desk, dict) and "global" in _desk:
                        g = str(_desk.get("global") or "")
                        if g:
                            print("[H3 文案台] 片子级本次提交里没有，已从中央库兜底（%d 字）" % len(g))
            except Exception as e:
                # 读库失败退回提交镜像继续出图 —— 文案台的活是「说出文本」，
                # 不能因为库抖一下就断渲染。
                print("[H3 文案台] 中央库读取失败，退回提交镜像: %s: %s"
                      % (type(e).__name__, e))

        text = compose_text(g, seg)
        print("[H3 文案台] 【用词】段 %s · 来源 %s · 片子级 %d 字 + 本段 %d 字 → 送模型 %d 字 · 开头 40 字：%s"
              % (cid or "未登记", word_src, len(_clean(g)), len(_clean(seg)),
                 len(text), _clean(text)[:40].replace("\n", " / ")))
        print("[H3 文案台] 执行用词开头 40 字：%s"
              % _clean(text)[:40].replace("\n", " / "))
        print("[H3 文案台] 片子级 %d 字 + 本段 %d 字 → %d 字%s"
              % (len(_clean(g)), len(_clean(seg)), len(text),
                 ("（段 %s）" % cid) if cid else "（未认段，只出片子级）"))

        self._archive(name_hint, cid, text)
        return (参考素材, text)

    @staticmethod
    def _archive(片名, cid, text):
        """把最终文本写进段落档案 —— 时间轴与重抽都靠它回显。

        写档失败绝不能挡出图：文案台的活是「说出文本」，归档只是顺手。
        """
        name = (片名 or "").strip()
        # 片名缺失就**不落档**（20261107）：以前读 chain.last_name() 兜最近登记
        # 过的片名，多工程时会写进**别的**档案 —— 宁可这次不归档，也不串档。
        if not name or not cid:
            return
        try:
            if chain.load_clip(name, cid) is None:
                return
            chain.update_clip(name, cid, {"prompt_seg": text})
            print("[H3 文案台] 已归档到 %s / %s" % (name, cid))
        except Exception as e:
            print("[H3 文案台] 归档失败（不影响出图）: %s: %s"
                  % (type(e).__name__, e))


    @classmethod
    def IS_CHANGED(cls, desk_data, **kwargs):
        # 改词必须让 ComfyUI 判本节点变了：外接词是连线输入，下游导演台的
        # IS_CHANGED 拿不到它，只能靠上游自己声明（媒体架同口径）。
        return desk_data


NODE_CLASS_MAPPINGS = {"CSGlideDeskCS": CSGlideDeskCS}
NODE_DISPLAY_NAME_MAPPINGS = {"CSGlideDeskCS": "✍️ H3 文案台 (H3 Desk)"}


# ==============================================================================
# HTTP 接口：面板「立即改写」按钮 —— 不走画布运行通道
# ==============================================================================
# 为什么用 HTTP 而不是排队：改写只需要编码器出字，跑整条工作流既慢、又会在
# 时间轴上多记一笔。CLIP 对象在 compose 执行时缓存进 _rw_clip，路由直接用。
try:
    from aiohttp import web
    from server import PromptServer

    # getattr 而不是直接点属性：自检/无 server 环境里 PromptServer 类还没被
    # 实例化过，instance 属性根本不存在，直接取会 AttributeError 炸掉整个模块。
    if getattr(PromptServer, "instance", None) is not None:
        @PromptServer.instance.routes.post("/csglide_desk/rewrite")
        async def _文案台改写接口(request):
            # 绕过队列直改写：ComfyUI 只在真实队列执行时才写 last_prompt_id
            # （main.py），而部分第三方节点会给模型挂全局钩子去读它——缺失会让
            # clip.generate 在生成第一步就 AttributeError。
            inst = PromptServer.instance
            if not hasattr(inst, "last_prompt_id"):
                inst.last_prompt_id = os.urandom(16).hex()
            try:
                body = await request.json()
            except Exception:
                return web.json_response({"error": "请求体不是 JSON"}, status=400)
            prompt = str(body.get("prompt") or "")
            logs = []

            def _log(line):
                logs.append(str(line))
                print("[H3 文案台·改写] " + str(line))

            try:
                model = str(body.get("model") or "").strip()
                clip = _get_rewrite_clip(_log, model)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
            # 参考图来源：前端按钮把媒体架 rack_data 直接传上来（优先）；
            # 没传就退回 compose 执行时缓存的兜底；两个都没有则纯文本改写。
            refs = str(body.get("refs") or "") or CSGlideDeskCS._rw_refs or ""
            imgs = _rewrite_ref_images(refs, _log)
            _log("参考图 %d 张" % len(imgs))
            if not imgs:
                # 无参考图是**正常可选状态**，不是故障：按纯文本模式照常执行，
                # 引用编号由 rewrite_normalized 的最小清单保住。不加警告前缀 ——
                # 前端会把带警告标记的日志行刷到检查框，看着像报错。
                _log("本次没有参考图：按纯文本模式改写（@引用编号仍会保留）；"
                     "想让描述贴合画面，可在媒体架摆好素材后再改一次")
            # 没有对应参考图的编号先摘掉：悬空编号会让导演台按编号找不到素材，
            # 也会让模型误以为有图。摘掉后模型按上下文用文字描述替代。
            prompt, _dropped = _drop_unbacked_refs(prompt, refs, _log)
            # 默认官方六段规范；body 里的 system 非空才用自定义。
            sys_p = str(body.get("system") or "").strip() or REWRITE_SYSTEM_OFFICIAL
            if _dropped:
                sys_p = sys_p + ("\n\n【注意】输入里有些编号引用因对应参考素材未提供"
                                 "已被移除；请按上下文用具体的文字描述这些主体，"
                                 "不要编造新的编号引用。")
            _man, _facts = _ref_manifest(refs)
            try:
                new = rewrite_normalized(prompt, clip, sys_p, REWRITE_MAX_LENGTH_DESK,
                                         _log, manifest=_man, images=imgs, facts=_facts)
            finally:
                # 用完交还驻留页；下次点击按需重载，不常驻占显存。
                _release_rewrite_clip(clip, _log)
            return web.json_response({"text": new, "logs": logs})

        @PromptServer.instance.routes.get("/csglide_desk/models")
        async def _文案台模型列表(request):
            # 改写模型下拉候选（MOSS-Image 优先）；default 供前端标出默认项。
            return web.json_response({"models": _rewrite_model_names(),
                                      "default": _REWRITE_MODEL_FILE})
except ImportError:
    pass    # 无 server 环境（自检）跑不到这里
