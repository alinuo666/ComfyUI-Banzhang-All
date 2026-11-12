# -*- coding: utf-8 -*-
"""🎬 MV 规划台（BanZhang_MVPlanner）—— 独立节点，不改动任何现有节点。

定位：把一首完整歌曲（时长任意，2 分钟 / 3 分钟 / 更长都不写死）按 H3 帧账
自动拆成若干 15 秒级片段，并可选接入现有「🍭 Qwen3VL 模型配置」自动生成
每段分镜提示词。节点只通过标准端口与现有导演台通信：

  · 「当前段提示词」STRING  → 导演台 optional 口 prompt_text
  · 「当前段 h3 配置」STRING → 导演台 optional 口 h3_override

隔离承诺：本模块不 import 导演台/链路/文案台/媒体架的任何内部实现，只复用
公共音频层与 BanzhangAITranslator 的推理入口；删掉本文件并撤回 __init__
里的注册行，现有工作流逐字不变。

帧账（与 banzhang_producer 常量对齐，禁改）：
  首段 362 帧 = 15.083s；续段总长 379 帧（含 22 帧头部重叠），净 357
  帧 = 14.875s；末段按剩余时长吸附到 H3 合法帧长 5+17n。
"""

import json
import math
import re
import time

import numpy as np
import torch

# 公共音频层（解码/重采样，三后端自动降级）
from .csglide_audio_io import decode_audio_file

# ── 帧账常量 ───────────────────────────────────────────────────────────────
FPS = 24                    # H3 工程帧率
FIRST_FRAMES = 362          # 首段帧长（15.083s）
NEXT_TOTAL_FRAMES = 379     # 续段总帧长（含头部重叠）
HEAD_OVERLAP = 22           # 续段头部重叠/头钉帧数
NEXT_NET_FRAMES = 357       # 续段净帧长（379-22，14.875s）
MIN_LEGAL_FRAMES = 22       # 末段最小合法帧长（5+17）
MAX_REF_IMAGES = 9          # 导演台 MAX_IMAGES：参考图槽位上限，超出模型不认

# 苹果风面板的默认画布（与三采工作流首段一致，可在前端调整）
DEFAULT_WIDTH = 576
DEFAULT_HEIGHT = 320


# ── 工具函数 ───────────────────────────────────────────────────────────────
def _snap_legal_frames(frames):
    """把任意目标帧长吸附到 H3 合法网格 5+17n（n≥1）。"""
    n = int(round((int(frames) - 5) / 17.0))
    n = max(1, n)
    return 5 + 17 * n


def _mono_from_waveform(waveform):
    """[B, C, N] 或 [C, N] 张量 → 单声道 numpy（供 librosa 分析）。"""
    w = waveform
    if w.ndim == 3:
        w = w[0]
    if w.ndim == 2:
        w = w.mean(dim=0)
    return w.detach().cpu().float().numpy()


def _analyze_music(waveform, sample_rate):
    """librosa 分析 BPM 与节拍时间点。分析失败时退回空节拍，不阻断分段。"""
    info = {"bpm": 0.0, "beat_times": []}
    try:
        import librosa
        y = _mono_from_waveform(waveform)
        # 重采样到 22050 做分析，避免高采样率下节拍跟踪变慢
        if int(sample_rate) != 22050:
            y = librosa.resample(y, orig_sr=int(sample_rate), target_sr=22050)
            sr = 22050
        else:
            sr = int(sample_rate)
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        beat_times = librosa.frames_to_time(beats, sr=sr).tolist()
        info["bpm"] = round(bpm, 2)
        info["beat_times"] = [round(float(x), 3) for x in beat_times]
    except Exception as e:  # 分析是增强项，失败不影响主流程
        info["error"] = "节拍分析失败（不影响分段）：%s" % str(e).splitlines()[0][:120]
    return info


def _plan_segments(duration):
    """按实际时长动态规划分段，返回段字典列表；时长不写死。

    每段字段：index / total_frames / net_frames / head_overlap / start / end
    start/end 为该段净画面在整曲时间轴上的秒数。
    """
    segs = []
    # 首段
    first_end = FIRST_FRAMES / FPS
    if duration <= first_end:
        # 短于首段：整曲一段，帧长吸附到实际时长
        frames = _snap_legal_frames(int(round(duration * FPS)))
        segs.append({
            "index": 0, "total_frames": frames, "net_frames": frames,
            "head_overlap": 0, "start": 0.0,
            "end": min(duration, frames / FPS),
        })
        return segs
    segs.append({
        "index": 0, "total_frames": FIRST_FRAMES, "net_frames": FIRST_FRAMES,
        "head_overlap": 0, "start": 0.0, "end": first_end,
    })
    cursor = first_end
    idx = 1
    while cursor < duration - 1e-6:
        remain = duration - cursor
        if remain <= NEXT_NET_FRAMES / FPS + 0.6:
            # 末段：按剩余时长吸附（至少 22 帧）
            net = _snap_legal_frames(max(MIN_LEGAL_FRAMES,
                                         int(round(remain * FPS))))
            segs.append({
                "index": idx, "total_frames": net + HEAD_OVERLAP,
                "net_frames": net, "head_overlap": HEAD_OVERLAP,
                "start": cursor, "end": cursor + net / FPS,
            })
            cursor += net / FPS
            break
        segs.append({
            "index": idx, "total_frames": NEXT_TOTAL_FRAMES,
            "net_frames": NEXT_NET_FRAMES, "head_overlap": HEAD_OVERLAP,
            "start": cursor, "end": cursor + NEXT_NET_FRAMES / FPS,
        })
        cursor += NEXT_NET_FRAMES / FPS
        idx += 1
    return segs


def _resolve_input_path(path):
    """把 input 相对路径（如 cglide/song.mp3）解析为完整路径；绝对路径原样返回。"""
    import os
    if os.path.isfile(path):
        return path
    try:
        import folder_paths
        full = os.path.join(folder_paths.get_input_directory(), path)
        if os.path.isfile(full):
            return full
    except Exception:
        pass
    return path


def _resolve_audio(audio_input, audio_path):
    """确定音频来源：优先 AUDIO 端口，其次文件路径。返回 (waveform, sr, path)。"""
    if audio_input is not None and isinstance(audio_input, dict):
        w = audio_input.get("waveform")
        sr = int(audio_input.get("sample_rate") or 0)
        if isinstance(w, torch.Tensor) and sr > 0:
            return w, sr, str(audio_path or "")
    path = str(audio_path or "").strip()
    if not path:
        return None, 0, ""
    w, sr = decode_audio_file(_resolve_input_path(path))
    return w, sr, path


def _audio_ref_for_cast(path):
    """歌曲路径 → 导演台 resolve_asset 认得的 input 相对路径。

    resolve_asset（csglide_assets.py:59）只往 input 目录上拼，不信绝对路径；
    把 "K:/x/song.mp3" 原样送过去会拼成 input/K:/x/song.mp3 再报
    FileNotFoundError —— 那会让导演台整段执行失败。转不出来就返回空：
    宁可不挂参考音频，也不要炸掉这一段。
    """
    p = str(path or "").strip()
    if not p:
        return ""
    try:
        import os
        import folder_paths
        root = os.path.abspath(folder_paths.get_input_directory())
        full = os.path.abspath(p if os.path.isabs(p)
                               else os.path.join(root, p))
        if not os.path.isfile(full):
            return ""
        rel = os.path.relpath(full, root)
        if rel.startswith(".."):
            return ""
        return rel.replace("\\", "/")
    except Exception:
        return ""


def _audio_window(seg):
    """本段参考音频在整曲上的窗口（秒）。

    窗口要**往前覆盖头钉那 22 帧**：续段开头是上一段尾帧的重绘（交付时裁掉），
    它唱的是上一段最后 0.917 秒。只填净画面窗口会让这 22 帧音画错近一秒。
    覆盖后窗口长度恰好 == total_frames / FPS，与导演台的参考音频上限
    （ref_audio_limit_seconds = 片长）一致，不会被截。
    """
    head = int(seg.get("head_overlap") or 0)
    start = float(seg.get("start") or 0.0) - head / FPS
    end = float(seg.get("end") or 0.0)
    return (round(max(0.0, start), 3), round(end, 3))


def _refs_images(refs):
    """媒体架 H3_REFS → 有效参考图槽位（有 file 的才算数）。

    H3_REFS 是 JSON 字符串 {"slots": {"images": [{"file": ...}, ...]}}。
    解析不出来就当没接 —— 少送参考图只是人物可能漂移，不至于让节点崩。
    """
    try:
        data = json.loads(refs) if isinstance(refs, str) else refs
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    slots = data.get("slots")
    if not isinstance(slots, dict):
        return []
    imgs = slots.get("images")
    if not isinstance(imgs, list):
        return []
    return [s for s in imgs[:MAX_REF_IMAGES]
            if isinstance(s, dict) and s.get("file")]


def _ensure_ref_tags(prompt, images):
    """提示词里没出现 @图片N 就补在末尾。

    导演台对**图片是按需发送**：提示词一个 @标签都没提就整类不送
    （csglide_cast.py:1730 kept[kind] = ... if any_keep else []），音频才是
    无条件发送的特例。所以「媒体架摆好了人物图、Qwen 没写标签」= 图白摆，
    13 段跑出来主角长相逐段漂移 —— 这正是接参考图最常见的失效方式。
    """
    p = str(prompt or "").strip()
    if not images or not p:
        return p
    if re.search(r"@图片\d+", p):
        return p
    tags = " ".join("@图片%d" % (i + 1) for i in range(len(images)))
    return p + " " + tags


def _mark_done(project):
    """按档案里的成片记录把已出片的段标成 done。

    planner 不写档案、不改链路，只读 film_summary 看哪些 clip 已经有成片。
    读不到（没接档案 / 模块没加载 / 没跑过）就保持原状态 —— 这是增强信息，
    不是流程依赖。
    """
    segs = project.get("segments")
    name = str(project.get("project_name") or "").strip()
    if not segs or not name:
        return
    try:
        from . import csglide_chain as _chain
        rows = (_chain.film_summary(name).get("clips") or [])
    except Exception:
        return
    done_ids = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        cid = str(row.get("id") or "")
        # 有成片路径 / 标记可播 = 这一段已经出过片
        if cid and (row.get("film") or row.get("playable")):
            done_ids.add(cid)
    if not done_ids:
        return
    for i, seg in enumerate(segs):
        if not isinstance(seg, dict):
            continue
        if ("clip_%04d" % (i + 1)) in done_ids:
            seg["status"] = "done"


def _build_h3_override(seg, project, clip_id, shot_id, audio_ref=""):
    """构造导演台 parse_h3_data 认可的配置 JSON（字段对齐其白名单）。"""
    canvas = project.get("canvas") or {}
    width = int(canvas.get("width") or DEFAULT_WIDTH)
    height = int(canvas.get("height") or DEFAULT_HEIGHT)
    chain_name = str(project.get("project_name") or "").strip()
    is_first = int(seg["index"]) == 0

    # 参考音频：导演台 _load_audio 自己按 start/end 从整曲里截（csglide_cast.py:565），
    # 不产生切片文件；上限是 ref_audio_limit_seconds(片长) —— 15 秒段正好 100%
    # 覆盖，覆盖不满模型就退回默认嗓音（20261026 实测 76% 就换了一把嗓子）。
    # 独立音频不参与「提示词没写 @音频N 就丢」的按需过滤（csglide_cast.py:1710），
    # 所以槽位填上就一定会送，不用往提示词里塞标签。
    audios = [{} for _ in range(3)]
    if audio_ref:
        a_start, a_end = _audio_window(seg)
        audios[0] = {"file": audio_ref, "start": a_start, "end": a_end}

    data = {
        "mode": "ref2va",
        "width": width,
        "height": height,
        "length": int(seg["total_frames"]),
        # 首段无头钉；续段 22 帧头钉，承接上一段尾帧
        "pin_head": 0 if is_first else HEAD_OVERLAP,
        "pin_tail": 0,
        "ref_image_size": "match",
        "ref_video_size": 768,
        "ref_video_fps": FPS,
        "ref_scale_hd": 1,
        "pace": 2.5,
        "prompt": str(seg.get("prompt") or ""),
        "slots": {
            "first": {}, "last": {},
            "images": [{} for _ in range(9)],
            "videos": [{} for _ in range(3)],
            "audios": audios,
        },
        # 承接帧数是导演台唯一真开关（_head_cont_frames 第一道门就是
        # cont.frames <= 0 → 不接，csglide_cast.py:2252）。只写 mode 不写 frames
        # 等于每段都当第一段重拍 —— 段间人物长相、构图、动作全跳。
        "cont": {"mode": "latent", "frames": 0 if is_first else HEAD_OVERLAP},
        # 整片口必须开：逐段渲染时每段跑完自动把「档案里的前段 + 本段新视频」
        # 拼成整片，从「🎬 整片」口输出给视频合并节点。关着的话用户渲染完
        # 只有一段一段的散片，找不到完整成片在哪。每次拼接几秒，值得。
        "push_whole": True,
        "chain": {
            "name": chain_name,
            "clip": clip_id,
            "shot": shot_id,
        },
    }
    return json.dumps(data, ensure_ascii=False)


# ── Qwen 提示词生成 ────────────────────────────────────────────────────────
_QWEN_SYSTEM = (
    "你是顶级音乐 MV 分镜导演，精通电影镜头语言与音乐情绪表达。"
    "根据用户给出的片段信息（时间码、歌词、情绪、人物）输出该片段的画面提示词："
    "只输出一段可直接用于视频生成模型的中文描述，包含景别、运镜、光线、场景与"
    "人物状态，保持人物长相服装与参考图一致；不要解释、不要分条、不要引号。"
)


def _qwen_generate(seg, qwen_config, person_image, temperature, max_tokens,
                   style_note=""):
    """复用 BanzhangAITranslator 的本地推理入口，返回 (报告, 提示词)。"""
    from .banzhang_translator.banzhang_ai_translator import BanzhangAITranslator
    if not isinstance(qwen_config, dict) or not qwen_config:
        return "❌ 未接 Qwen3VL 配置，无法自动生成", ""
    media_seq = []
    if isinstance(person_image, torch.Tensor) and person_image.numel() > 0:
        media_seq.append({"kind": "image", "no": 1, "tensor": person_image})
    # style_note 是用户对整支 MV 的统一文字要求（风格/场景/人物设定），每段都带上，
    # 否则 13 段各自为政 —— 用户看到的 13 个画面风格互不相干。
    style_line = "整体创作要求：{}\n".format(str(style_note).strip()) \
        if str(style_note).strip() else ""
    user_prompt = (
        "片段序号：第 {idx} 段\n"
        "{style}"
        "时间码：{start:.2f}s - {end:.2f}s\n"
        "歌词：{lyric}\n"
        "情绪/风格：{mood}\n"
        "请输出这一段的画面提示词。"
    ).format(
        idx=seg["index"], style=style_line,
        start=float(seg["start"]), end=float(seg["end"]),
        lyric=str(seg.get("lyric") or "（无歌词/纯音乐）"),
        mood=str(seg.get("mood") or "随歌曲情绪自然推进"),
    )
    translator = BanzhangAITranslator()
    return translator._run_local_inference(
        qwen_config, _QWEN_SYSTEM, user_prompt, media_seq,
        FPS, int(max_tokens), float(temperature), 768)


class BanZhang_MVPlanner:
    """🎬 MV 规划台：歌曲分段 + Qwen 提示词编排，单节点三栏面板。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 完整工程 JSON 的承载 widget（前端双写，刷新恢复）
                "project_data": ("STRING", {"default": ""}),
                # 动作分发：idle / analyze / generate_one / generate_all
                "action": ("STRING", {"default": "idle"}),
                # 当前段索引（前端选段时同步）
                "current_index": ("INT", {"default": 0, "min": 0, "max": 9999}),
                "audio_path": ("STRING", {"default": ""}),
            },
            "optional": {
                "audio": ("AUDIO",),
                # 媒体架「参考素材」：人物图/风格图从架子上选，planner 只查它
                # 有几个有效图，好决定提示词里要不要写 @图片N（见 _ensure_ref_tags）。
                # 图本身不用 planner 转存 —— 导演台 merge_rack_refs 在
                # parse_h3_data 之后执行（csglide_cast.py:2944），会直接用媒体架的
                # 槽位覆盖同编号位置，planner 再填一遍是重复且会打架。
                "refs": ("H3_REFS",),
                "qwen_config": ("QWEN3VL_MODEL_CONFIG",),
                "person_image": ("IMAGE",),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0,
                                          "max": 1.0, "step": 0.1}),
                "max_tokens": ("INT", {"default": 2000, "min": 256,
                                      "max": 100000, "step": 128}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("当前段提示词", "当前段h3配置", "完整工程JSON", "编排报告")
    FUNCTION = "run"
    CATEGORY = "👨‍🏫班长/MV制片"

    # 面板按钮只提交「本节点 + 上游」（前端 upstreamOnly）。没这条，节点不是
    # 任何输出节点的上游时会被 ComfyUI 剪枝掉 —— 点了按钮连报告都不回。
    OUTPUT_NODE = True

    # ComfyUI 默认按输入 hash 缓存：输入一点没变就命中缓存、根本不执行。
    # 于是「重生成这一段」点了第二次完全没反应（提示词纹丝不动），看起来像
    # 模型坏了一样。本节点的价值就在于每次都真跑，缓存必须关掉。
    # 必须是**类方法**：ComfyUI 会把它当函数调用（execution.py:98），
    # 写成 `IS_CHANGED = float("nan")` 会抛 TypeError，被兜底捕获虽然也能达到
    # 「每次都变」的效果，但每次执行都在日志里刷一条 WARNING。
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, project_data, action, current_index, audio_path,
            audio=None, refs=None, qwen_config=None, person_image=None,
            temperature=0.7, max_tokens=2000):
        reports = []
        project = {}
        try:
            project = json.loads(project_data) if str(project_data).strip() else {}
        except Exception:
            project = {}
        if not isinstance(project, dict):
            project = {}

        action = str(action or "idle")

        # ── 分析：读取音频 → 节拍 → 动态分段 ──────────────────────────
        if action == "analyze":
            waveform, sr, used_path = _resolve_audio(audio, audio_path)
            if waveform is None:
                reports.append("❌ 分析中止：没有可用音频（接 AUDIO 端口或填歌曲路径）")
            else:
                duration = float(waveform.shape[-1]) / float(sr)
                music = _analyze_music(waveform, sr)
                old_segs = project.get("segments") or []
                old_path = str((project.get("audio") or {}).get("path") or "")
                # 只有「同一首歌」才按序号继承歌词/提示词。换一首歌时段的
                # 时间位置全变了，按 index 继承会把上一首第 3 段的歌词套到
                # 新歌第 3 段 —— 位置不是真值，音频路径才是。
                same_song = bool(old_path and old_path == str(used_path).strip())
                planned = _plan_segments(duration)
                merged = []
                for new_seg in planned:
                    row = dict(new_seg)
                    row.update({"lyric": "", "mood": "", "prompt": "",
                                "status": "pending"})
                    k = row["index"]
                    if same_song and k < len(old_segs) \
                            and isinstance(old_segs[k], dict):
                        old = old_segs[k]
                        for keep_key in ("lyric", "mood", "prompt", "status"):
                            if old.get(keep_key):
                                row[keep_key] = old[keep_key]
                    merged.append(row)
                project.update({
                    "audio": {
                        "path": used_path, "sample_rate": sr,
                        "duration": round(duration, 3),
                        "bpm": music.get("bpm", 0.0),
                        "beat_times": music.get("beat_times", []),
                    },
                    "segments": merged,
                    "canvas": project.get("canvas") or {
                        "width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT},
                    # 工程名就是归档用的 chain 名。默认「未命名MV」会让两个不同
                    # 的片子共用一条 chain，段互相串档 —— 默认值必须带唯一后缀。
                    # 用户一旦自己改了名字就以他的为准，不再动。
                    "project_name": project.get("project_name")
                    or ("MV_%s" % time.strftime("%m%d%H%M%S")),
                })
                if music.get("error"):
                    reports.append(music["error"])
                reports.append(
                    "✅ 分析完成：时长 %.2fs ｜BPM %s ｜共 %d 段"
                    % (duration, music.get("bpm") or "未知", len(merged)))

        segments = project.get("segments") or []

        # ── Qwen 生成 ────────────────────────────────────────────────
        if action in ("generate_one", "generate_all") and segments:
            targets = [int(current_index)] if action == "generate_one" \
                else list(range(len(segments)))
            for k in targets:
                if k >= len(segments):
                    continue
                seg = segments[k]
                rep, text = _qwen_generate(
                    seg, qwen_config, person_image, temperature, max_tokens,
                    str(project.get("style_note") or ""))
                if str(text).strip():
                    seg["prompt"] = str(text).strip()
                    seg["status"] = "ready"
                    reports.append("✅ 第 %d 段提示词已生成（%d 字）"
                                   % (k, len(str(text).strip())))
                else:
                    reports.append("⚠️ 第 %d 段：%s" % (k, rep))

        # ── 输出当前段 ───────────────────────────────────────────────
        # 返回值必须走 {"ui": ..., "result": ...} 协议：ComfyUI 只在节点返回
        # 带 ui 的 dict 时才把它写进 history.outputs **并发 executed 事件**
        # （execution.py:567-580）。以前返回裸 tuple，面板就永远收不到回执 ——
        # 不是事件丢了，是根本没发。
        if not segments:
            reports.append("ℹ️ 尚未分段：点「分析歌曲」生成片段表")
            full_json = json.dumps(project, ensure_ascii=False)
            report = "\n".join(reports)
            return {"ui": {"project": [full_json], "report": [report]},
                    "result": ("", "", full_json, report)}

        # 已出片的段标 done：只读档案，不改链路。放在输出前，用户每次执行
        # 都能看到最新的"跑到哪了"，而不用自己记。
        _mark_done(project)

        cur = max(0, min(int(current_index), len(segments) - 1))
        seg = segments[cur]
        clip_id = "clip_%04d" % (cur + 1)
        shot_id = str(seg.get("shot") or ("shot_%04d" % (cur + 1)))
        audio_ref = _audio_ref_for_cast((project.get("audio") or {}).get("path"))
        h3_override = _build_h3_override(seg, project, clip_id, shot_id, audio_ref)
        # 参考图标签必须补在提示词里，否则导演台按需过滤会把图整类丢掉
        prompt_text = _ensure_ref_tags(str(seg.get("prompt") or ""),
                                       _refs_images(refs))
        full_json = json.dumps(project, ensure_ascii=False)
        if not reports:
            # 前端状态行只显示报告第一行，音频/承接这两个最容易静默失效的
            # 环节必须挤进这一行，否则用户永远查不出"为什么没声音/没接上"。
            if audio_ref:
                a_start, a_end = _audio_window(seg)
                audio_note = "已挂 %.2fs-%.2fs" % (a_start, a_end)
            else:
                audio_note = "未挂（歌曲不在 input 目录）"
            reports.append(
                "ℹ️ 第 %d/%d 段（%s）｜参考音频 %s｜承接 %s"
                % (cur + 1, len(segments), seg.get("status", "pending"),
                   audio_note,
                   "首段不接" if cur == 0
                   else "%d 帧（需档案里有上一段）" % HEAD_OVERLAP))
        report = "\n".join(reports)
        return {"ui": {"project": [full_json], "report": [report]},
                "result": (prompt_text, h3_override, full_json, report)}


# ── HTTP 接口 ─────────────────────────────────────────────────────────────
# 「分析歌曲」走自有 API，不走 ComfyUI 队列。原因：它只是解码 + 分段（秒级），
# 完全不需要执行引擎；而走队列要靠 executed 事件把结果带回来 —— 实测会撞上
# prompt_service 的竞态（'execution_start' fired before prompt was made），
# 后端明明执行完，事件却被前端整个丢掉，面板永远没反应。
# 同步 HTTP 一问一答，从物理上不存在「结果没回来」的问题。
# （结构照抄 banzhang_mem_graph：try 包住 import，server 不在时整个接口静默消失。）
try:
    from aiohttp import web as _web
    from server import PromptServer as _PromptServer

    if _PromptServer.instance is not None:
        @_PromptServer.instance.routes.post("/banzhang/mv_analyze")
        async def _mv_analyze(request):
            try:
                body = await request.json()
            except Exception:
                return _web.json_response({"error": "请求体不是合法 JSON"}, status=400)
            try:
                node = BanZhang_MVPlanner()
                res = node.run(
                    str(body.get("project_data") or ""), "analyze",
                    int(body.get("current_index") or 0),
                    str(body.get("audio_path") or ""))
                # run() 返回 {"ui":..., "result":...}，取值要走 result
                out = res["result"] if isinstance(res, dict) else res
            except Exception as e:
                return _web.json_response(
                    {"error": "%s: %s" % (type(e).__name__, str(e)[:300])},
                    status=500)
            try:
                project = json.loads(out[2]) if out[2] else {}
            except Exception:
                project = {}
            return _web.json_response({"project": project, "report": out[3]})

except Exception as _e:
    print("⚠️ [班长全家桶] MV 规划台 API 注册失败（仅面板「分析歌曲」受影响）: %s" % _e)


NODE_CLASS_MAPPINGS = {
    "BanZhang_MVPlanner": BanZhang_MVPlanner,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_MVPlanner": "🎬 MV 规划台 (Music Video Planner)",
}
