"""H3 Media Rack — 独立参考素材架。

把参考图片/视频/音频从导演台面板里拆出来，成为一个可以独立摆放、
一次接线喂多个导演台的素材节点。槽位编号即 @图片N / @视频N / @音频N
的 N，与导演台面板完全同义。

数据流：
  rack_data(STRING widget, 前端写) → parse_rack_data 白名单规范化
  → emit 输出规范化 JSON（自定义类型 H3_REFS）→ 导演台 refs 输入。

导演台侧的合并规则：接线槽位**覆盖**面板同编号槽位，媒体架空槽位
由面板素材兜底；视频/音频的起止修剪随槽位一起携带，文件管道
（修剪/抽帧/色度探针）全部照旧。
"""

import json
import os
import re

# 槽位数量动态（前端按需添加），只设硬上限防失控 JSON。
# 与 csglide_assets.REF_LIMIT / 前端 MAX_SLOTS 同值（20261020 64 → 200）。
REF_LIMIT = 200

# 别名：剧本里直接写角色名（小明）即可引用本槽位，导演台侧展开成 @图片N。
# 支持一个槽位多个称呼（逗号分隔），中英文逗号/顿号/分号都算分隔符。
_ALIAS_SPLIT = re.compile(r"[,，、;；]+")
_ALIAS_MAX = 40       # 单个别名长度上限
_ALIAS_TOTAL = 12     # 每个槽位别名个数上限


def _alias_list(raw):
    """白名单化别名：str（多别名按分隔符切）或 list 都收，统一成去重 list。

    空结果返回 None（不写字段），免得每个槽位都塞一个空数组进 JSON。
    """
    v = raw.get("alias")
    if isinstance(v, str):
        parts = _ALIAS_SPLIT.split(v)
    elif isinstance(v, list):
        parts = []
        for p in v:
            if isinstance(p, str):
                parts.extend(_ALIAS_SPLIT.split(p))
    else:
        return None
    out = []
    for p in parts:
        a = p.strip()
        if not a or len(a) > _ALIAS_MAX or a in out:
            continue
        out.append(a)
        if len(out) >= _ALIAS_TOTAL:
            break
    return out or None


def _num(value, fallback=None):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return fallback if n != n else n          # NaN → fallback


def _slot(raw, kind):
    """白名单化单个槽位：只保留导演台执行真正需要的字段。"""
    if not isinstance(raw, dict) or not raw.get("file"):
        return None
    slot = {"file": str(raw["file"])}
    # 别名必须显式放行：这里是白名单，未列出的字段会被静默丢弃，
    # 漏掉这一行别名根本到不了导演台，表现为「改了名却完全不生效」。
    al = _alias_list(raw)
    if al:
        slot["alias"] = al
    if kind in ("videos", "audios"):
        start = max(0.0, _num(raw.get("start"), 0.0) or 0.0)
        end = _num(raw.get("end"))
        slot["start"] = start
        if end is not None and end > start:
            slot["end"] = end
        if kind == "videos":
            slot["audio"] = bool(raw.get("audio"))
            # 槽位自定帧率（媒体架面板设置，>0 才生效）；导演台抽帧与
            # 素材取帧节点都会优先用它
            fps = _num(raw.get("fps"))
            if fps and fps > 0:
                slot["fps"] = fps
    return slot


def parse_rack_data(raw):
    """Whitelisted parse — 任何未列出的字段在此被丢弃。"""
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    slots = data.get("slots") if isinstance(data.get("slots"), dict) else {}

    def fill(kind):
        src = slots.get(kind) if isinstance(slots.get(kind), list) else []
        # 按实际数组透传，空槽位占位 {} 保持编号对齐
        return [_slot(s, kind) or {} for s in src[:REF_LIMIT]]

    # 节点级自定帧率（面板「帧率」输入框）：>0 时盖到所有已放视频槽位上。
    # 面板上只有一个总开关，语义就是「这个媒体架的参考视频统一用这个帧率」。
    fps = _num(data.get("fps"))
    fps = fps if fps and fps > 0 else None

    # 音频输出编号（面板「音频」输入框）：N = 输出 @视频N 的原始音轨，0 = 不输出
    try:
        audio_out = int(data.get("audio_out"))
    except (TypeError, ValueError):
        audio_out = 0
    if not 0 < audio_out <= REF_LIMIT:
        audio_out = 0

    parsed = {"slots": {
        "images": fill("images"),
        "videos": fill("videos"),
        "audios": fill("audios"),
    }}
    if fps:
        for s in parsed["slots"]["videos"]:
            if s.get("file"):
                s["fps"] = fps
        parsed["fps"] = fps
    parsed["audio_out"] = audio_out
    return parsed


class CSGlideH3MediaRack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端把整个槽位状态 JSON 写进这个 widget；不放多行，
                # 理由同导演台 h3_data——多行 STRING 会被 v2 前端渲染成
                # 浮在节点 UI 上的 textarea。
                "rack_data": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("H3_REFS", "AUDIO")
    RETURN_NAMES = ("参考素材", "参考音频")
    FUNCTION = "emit"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = ("H3 媒体架——参考图片/视频/音频的独立素材架。槽位编号即 "
                   "@图片N/@视频N/@音频N 的 N；输出接导演台 refs 输入，"
                   "接线槽位覆盖面板同编号素材，一个媒体架可喂多个导演台。\n"
                   "面板可设参考视频自定帧率（留空跟随导演台抽帧帧率）；"
                   "「参考音频」输出口按面板音频编号输出对应视频槽位的原始音轨"
                   "（按槽位起止修剪），供外部视频合成使用，0 = 不输出。")

    def emit(self, rack_data):
        data = parse_rack_data(rack_data)
        # 架面内容的**唯一权威是面板镜像**（rack_data），这里不再读中央库。
        #
        # 20261027 拆掉「方案A」的那段覆盖：原先库里存过这一段就用库里的
        # slots 整个替换 data["slots"]。它的判据是 chain{name,clip}，而 chain
        # **只有前端 commit 时才会写进镜像** —— 也就是说这段代码执行的前提，
        # 恰恰是"面板已经写过自己的架面"。所以它从来救不了"面板还没灌库"，
        # 只会在面板更新而库没跟上时用旧数据盖掉新数据：
        #   换图后库写入有 700ms 防抖（csglide_rack_seg.scheduleRackSave），
        #   而且那里还有四道静默 return（无片名 / cid 非 clip_ / cid 不在档案 /
        #   hydrate 后 2 秒内）。命中任何一条，库里停在替换前的快照，
        #   表现就是「面板和文案台看着都是新图，导演台拿到的却是旧图」。
        # 库的角色降级为**存档与恢复**：需要时由前端 hydrateRacks 灌回面板，
        # 走和用户手动摆图同一条路，而不是从后端绕过面板。
        # 代价与取舍：万一某条路径下面板镜像真是空/旧，这里不会再用库补，
        # 少送素材而不是送错素材 —— 看得见的问题好过看不见的错图。
        audio = None
        audio_out = int(data.get("audio_out") or 0)
        if audio_out > 0:
            videos = data["slots"]["videos"]
            slot = videos[audio_out - 1] if audio_out <= len(videos) else None
            if not slot or not slot.get("file"):
                # 编号悬空（素材被删/挪位）不拦流程：警告后按静音继续输出。
                # 前端自愈会把编号跟到素材的新位置，或清零并提示。
                print("[H3 媒体架] 警告：音频输出编号 @视频%d 槽位为空（素材可能已被删除或挪位），"
                      "本次按无音轨输出，渲染继续。请在媒体架面板重新选择音频输出编号。"
                      % audio_out)
            else:
                # 复用导演台同一套音轨加载: 按槽位起止修剪, torchaudio 优先,
                # 视频容器无独立音轨文件时走 PyAV 解码
                from .csglide_cast import _load_audio
                try:
                    audio = _load_audio(slot["file"],
                                        float(slot.get("start") or 0.0),
                                        slot.get("end"))
                except Exception as e:
                    raise ValueError(
                        "H3 媒体架: @视频%d 音轨读取失败: %s" % (audio_out, e))
        return (json.dumps(data, ensure_ascii=False), audio)

    @classmethod
    def IS_CHANGED(cls, rack_data, **kwargs):
        return rack_data


class CSGlideMediaRackVideoFrames:
    """媒体架素材取帧 —— 把媒体架 @视频N / @图片N 槽位的原始素材解码成图像输出。

    专门用于「原始素材 vs 生成结果」对比：媒体架本身只输出 H3_REFS 素材清单，
    视频/图片进不了普通图像节点；本节点接住参考素材输出，按槽位的起止修剪、
    用与导演台完全相同的解码管道取出原始帧/原图。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "🗂️ 参考素材": ("H3_REFS", {"tooltip": "接 H3 媒体架的「参考素材」输出"}),
                "🔢 视频槽位": ("INT", {"default": 1, "min": 0, "max": REF_LIMIT, "step": 1,
                                  "tooltip": "取媒体架第几个视频槽位（即 @视频N 的 N），起止修剪跟随槽位设置。0 = 不取视频"}),
                "🔢 图片槽位": ("INT", {"default": 0, "min": 0, "max": REF_LIMIT, "step": 1,
                                  "tooltip": "取媒体架第几个图片槽位（即 @图片N 的 N），输出原图。0 = 不取图片"}),
                "🔢 最大帧数": ("INT", {"default": 129, "min": 1, "max": 4096, "step": 1,
                                "tooltip": "视频最多取多少帧。帧数 ≈ 时长(秒) × 输出帧率,注意显存占用"}),
                "🔢 输出帧率": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 120.0, "step": 0.1,
                                "tooltip": "把原始视频重采样到该帧率输出。填成和生成视频一致的帧率,两边对比观看才不会不同步。0 = 跟随媒体架面板设置的参考视频自定帧率(未设置则 24)"}),
                "🔢 长边缩放": ("INT", {"default": 1280, "min": 0, "max": 8192, "step": 32,
                                "tooltip": "按长边等比缩小输出的分辨率。4K 源必填,否则多帧会撑爆内存"
                                           "(362 帧 4K ≈ 33.6 GiB)。填生成视频的长边即可,0 = 保持原始尺寸(仅小素材可用)"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("原始视频帧", "原始图片")
    FUNCTION = "load"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = ("媒体架素材取帧——把媒体架 @视频N / @图片N 的原始素材解成图像输出，"
                   "视频按槽位起止修剪 + 输出帧率重采样，可直接接「🧩 图像多路拼接」做前后对比。"
                   "槽位号填 0 表示不取该类素材。槽位指向空位时（素材被删/挪位）"
                   "输出黑帧占位并在控制台告警，不中断渲染。")

    def load(self, **kwargs):
        refs = kwargs["🗂️ 参考素材"]
        video_slot = kwargs["🔢 视频槽位"]
        image_slot = kwargs["🔢 图片槽位"]
        max_frames = kwargs["🔢 最大帧数"]
        out_fps = float(kwargs["🔢 输出帧率"])
        long_edge = int(kwargs["🔢 长边缩放"] or 0)

        # 参考素材输出是媒体架 emit 的规范化 JSON 字符串
        if isinstance(refs, str):
            try:
                data = json.loads(refs)
            except Exception:
                data = {}
        else:
            data = refs if isinstance(refs, dict) else {}
        slots = data.get("slots", {}) if isinstance(data, dict) else {}
        videos = slots.get("videos", [])
        images = slots.get("images", [])

        if video_slot == 0 and image_slot == 0:
            raise ValueError("媒体架素材取帧: 视频槽位和图片槽位都为 0, 无素材可取")

        # 复用导演台同一套解码管道: 视频按槽位起止修剪 + 按输出帧率最近帧采样,
        # scale_to_canvas=False / load_image 原图直读, 不做任何缩放
        from .csglide_cast import _load_video_frames, _load_image

        def _occupied(kind, arr):
            """槽位占用清单，用于告警文案：1=xx.mp4 2=(空)"""
            parts = []
            for i in range(max(len(arr), 1 if arr else 0)):
                f = (arr[i] or {}).get("file") if i < len(arr) else None
                parts.append("%d=%s" % (i + 1, os.path.basename(f) if f else "(空)"))
            return " ".join(parts) if parts else "(全空)"

        def _black_placeholder():
            import torch
            return torch.zeros((1, 64, 64, 3))

        video_out = None
        if video_slot > 0:
            slot = videos[video_slot - 1] if video_slot <= len(videos) else None
            if not slot or not slot.get("file"):
                # 槽位悬空（素材被删/挪位）不拦流程：警告 + 黑帧占位，渲染继续。
                print("[H3 媒体架] 警告：素材取帧 @视频%d 槽位为空（素材可能已被删除或挪位），"
                      "本次输出黑帧占位，渲染继续。当前视频槽位：%s"
                      % (video_slot, _occupied("videos", videos)))
                video_out = _black_placeholder()
            else:
                # 输出帧率 0 = 跟随媒体架为该槽位设置的自定帧率(未设置则 24)
                fps = out_fps if out_fps > 0 else float(slot.get("fps") or 24.0)
                # 长边缩放走解码器内的 C 层重采样(AREA 均值)，不等比放大。
                # 内存 ≈ 帧数 × 长边² × 3 × 4 字节，先按目标算一遍：
                # 帧数超限时直接报可执行的数字，而不是让人对着
                # "Unable to allocate 33.6 GiB"猜参数。
                want = max_frames if slot.get("end") is not None else None
                if want is not None and long_edge > 0:
                    need = want * long_edge * long_edge * 3 * 4 / (1024 ** 3)
                    if need > 8.0:
                        raise ValueError(
                            "媒体架素材取帧: 预计占用 %.1f GiB 内存（%d 帧 × 长边 %d）。"
                            "请降低「最大帧数」或「长边缩放」——长边减半即省 4 倍。"
                            % (need, want, long_edge))
                video_out = _load_video_frames(
                    slot["file"],
                    float(slot.get("start") or 0.0),
                    slot.get("end"),
                    max_frames,
                    scale_to_canvas=long_edge > 0,
                    size_mode=str(long_edge) if long_edge > 0 else None,
                    canvas_long=long_edge,
                    fps=fps,
                )

        image_out = None
        if image_slot > 0:
            slot = images[image_slot - 1] if image_slot <= len(images) else None
            if not slot or not slot.get("file"):
                print("[H3 媒体架] 警告：素材取帧 @图片%d 槽位为空（素材可能已被删除或挪位），"
                      "本次输出黑帧占位，渲染继续。当前图片槽位：%s"
                      % (image_slot, _occupied("images", images)))
                image_out = _black_placeholder()
            else:
                image_out = _load_image(slot["file"])

        return (video_out, image_out)


NODE_CLASS_MAPPINGS = {
    "CSGlideH3MediaRackCS": CSGlideH3MediaRack,
    "CSGlideMediaRackVideoFrames": CSGlideMediaRackVideoFrames,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CSGlideH3MediaRackCS": "🗂️ H3 媒体架 (H3 Media Rack)",
    "CSGlideMediaRackVideoFrames": "🎞️ 媒体架素材取帧",
}
