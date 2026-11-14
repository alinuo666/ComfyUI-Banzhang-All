# -*- coding: utf-8 -*-
"""
🎼 BanzhangYuE2SmartPlan —— YuE2 智能乐谱中枢
================================================================================
一个节点替代官方模板里的「YuE2GenerateABC + Switch + PreviewAny + EmptyABC +
SheetSage2AudioToABC」整块 ABC 处理逻辑。

设计（对齐 BanZhang_LoRA_VramSafe 的「单一配置 JSON」模式）：
    · 面板的全部状态（模式 / 高级采样参数 / 本地风格歌词 / 手动乐谱）
      序列化为一个 JSON，经隐藏的 config 输入传给后端，内部状态不占对外端口；
    · 高级采样参数由前端面板常显、紧凑排列（不折叠）；
    · 对外只暴露 6 个真正需要连线的输入：style / lyrics / abc（forceInput，
      可不连，不连时用面板里写的值）、clip / audio_encoder / reference_audio。

六种模式（plan_mode）：
    smart        智能（默认）：接参考音频 → 翻唱转谱；没接 → 文生规划
    text_full    文生：Style + Lyrics → 旋律 + 和弦 ABC
    text_melody  文生：Style + Lyrics → 仅旋律 ABC（伴奏更自由）
    cover        翻唱：参考音频 → SheetSage2 提取旋律 ABC
    manual       手动：使用面板里编辑的 ABC
    off          直生：输出空 ABC，YuE2 自动走 off 直接演唱

输出 style / lyrics / abc / active_source。
"""
import json

# 内部英文枚举（禁止汉化）：主模式
PLAN_MODES = ["smart", "text_full", "text_melody", "cover", "manual", "off"]
# 翻唱转谱 / 规划粒度
SCORE_MODES = ["melody", "full"]

# 面板状态默认值（前端也有一份；config JSON 缺键时用这里兜底）
DEFAULT_CONFIG = {
    "plan_mode": "smart",
    "seed": 0,
    "max_abc_tokens": 8192,
    "abc_temperature": 0.7,
    "abc_top_p": 0.9,
    "abc_top_k": 30,
    "repetition_penalty": 1.005,
    "penalty_window": 100,
    "cover_transcribe_mode": "melody",
    "style": "",
    "lyrics": "",
    "manual_abc": "",
}


class BanzhangYuE2SmartPlan:
    """YuE2 智能乐谱中枢：一个节点收口 ABC 的全部来源。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 隐藏 config：承载面板全部状态 JSON（由前端面板维护）
                "config": ("STRING", {
                    "default": json.dumps(DEFAULT_CONFIG, ensure_ascii=False),
                    "tooltip": "面板状态 JSON（由前端面板维护，无需手动填写）",
                }),
            },
            "optional": {
                # 风格 / 歌词 / abc：可外部连线；未连线时回退到面板里编辑的值
                "style": ("STRING", {
                    "forceInput": True,
                    "tooltip": "可选：外部风格文本；不连则用面板内编辑的风格",
                }),
                "lyrics": ("STRING", {
                    "forceInput": True,
                    "tooltip": "可选：外部歌词文本；不连则用面板内编辑的歌词",
                }),
                "abc": ("STRING", {
                    "forceInput": True,
                    "tooltip": "可选：外部 ABC 乐谱；接入后直接采用，优先级最高",
                }),
                "clip": ("CLIP", {
                    "tooltip": "文生规划需要：来自 CheckpointLoader 的 CLIP",
                }),
                "audio_encoder": ("AUDIO_ENCODER", {
                    "tooltip": "翻唱需要：AudioEncoderLoader 加载的 sheetsage2 编码器",
                }),
                "reference_audio": ("AUDIO", {
                    "tooltip": "翻唱需要：参考歌曲，智能模式据此自动路由",
                }),
            },
        }

    # 输出顺序即右侧端口自上而下：风格 → 歌词 → ABC 乐谱 → 实际来源
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("style", "lyrics", "abc", "active_source")
    FUNCTION = "plan"
    CATEGORY = "👨‍🏫班长/音频音乐"

    def plan(self, config, style=None, lyrics=None, abc=None, clip=None,
             audio_encoder=None, reference_audio=None):
        # —— 解析面板配置，缺键兜底 ——
        try:
            cfg = json.loads(config) if config else {}
        except (ValueError, TypeError):
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}

        def pick(key, caster, default):
            value = cfg.get(key, default)
            if value is None:
                return default
            try:
                return caster(value)
            except (ValueError, TypeError):
                return default

        plan_mode = pick("plan_mode", str, "smart")
        seed = pick("seed", int, 0)
        max_abc_tokens = pick("max_abc_tokens", int, 8192)
        abc_temperature = pick("abc_temperature", float, 0.7)
        abc_top_p = pick("abc_top_p", float, 0.9)
        abc_top_k = pick("abc_top_k", int, 30)
        repetition_penalty = pick("repetition_penalty", float, 1.005)
        penalty_window = pick("penalty_window", int, 100)
        cover_transcribe_mode = pick("cover_transcribe_mode", str, "melody")
        style_local = pick("style", str, "")
        lyrics_local = pick("lyrics", str, "")
        manual_abc = pick("manual_abc", str, "")

        # 外部连线优先，否则用面板本地值
        style = style if style is not None else (style_local or "")
        lyrics = lyrics if lyrics is not None else (lyrics_local or "")

        # —— 外部 ABC 端口优先级最高：接入即直接采用，跳过内部生成 ——
        if abc is not None and str(abc).strip():
            return (style, lyrics, str(abc), "external_abc")

        # —— 智能路由：参考音频是唯一判据 ——
        effective = plan_mode
        if plan_mode == "smart":
            effective = "cover" if reference_audio is not None else "text_full"

        # —— 文生规划：Style + Lyrics → ABC ——
        if effective in ("text_full", "text_melody"):
            if clip is None:
                raise RuntimeError(
                    "【智能乐谱中枢】文生乐谱需要 CLIP：请把 CheckpointLoader 的 "
                    "CLIP 端口接入本节点。")
            cot_mode = "full" if effective == "text_full" else "melody"
            tokens = clip.tokenize(style, lyrics=lyrics, cot=cot_mode, seed=seed,
                                   max_tokens=max_abc_tokens, penalty_window=penalty_window)
            ids = clip.generate(tokens, max_length=max_abc_tokens,
                                temperature=abc_temperature, top_p=abc_top_p, top_k=abc_top_k,
                                repetition_penalty=repetition_penalty, seed=seed)
            abc = clip.decode(ids)
            return (style, lyrics, abc, effective)

        # —— 翻唱转谱：参考音频 → 旋律 ABC ——
        if effective == "cover":
            if reference_audio is None:
                raise RuntimeError(
                    "【智能乐谱中枢】翻唱需要参考音频：请接入 reference_audio 端口。")
            if audio_encoder is None:
                raise RuntimeError(
                    "【智能乐谱中枢】翻唱需要音频编码器：请用 AudioEncoderLoader 加载 "
                    "sheetsage2 并接入 audio_encoder 端口。")
            abc_list = audio_encoder.generate_abc(
                reference_audio["waveform"], reference_audio["sample_rate"],
                melody_only=cover_transcribe_mode == "melody")
            if not abc_list:
                raise RuntimeError("【智能乐谱中枢】参考音频转谱失败，未得到 ABC。")
            # SheetSage2 输出为列表，取第一段
            return (style, lyrics, abc_list[0], "cover")

        # —— 手动乐谱 ——
        if effective == "manual":
            return (style, lyrics, manual_abc or "", "manual")

        # —— 直生：空 ABC，YuE2 自动走 off ——
        return (style, lyrics, "", "off")


NODE_CLASS_MAPPINGS = {
    "BanzhangYuE2SmartPlan": BanzhangYuE2SmartPlan,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangYuE2SmartPlan": "🎼 YuE2 智能乐谱中枢",
}
