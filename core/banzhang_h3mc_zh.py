# -*- coding: utf-8 -*-
"""H3 Motion Context 六节点的中文化与归类层（班长全家桶统一风格）。

只改显示层：节点显示名 / 分类 / 参数名 label / 参数悬停说明 / 输出槽位名。
不动 _h3mc 内部任何代码——上游升级直接覆盖 _h3mc/ 目录即可，本文件不受影响。
"""

_H3MC_CATEGORY = "👨‍🏫班长/MiniMax H3"

_H3MC_NAMES = {
    "MiniMaxH3MotionContext": "🎞️ H3 续拍钉帧 (Motion Context)",
    "MiniMaxH3MotionContextTrim": "✂️ H3 续拍剪头 (Trim)",
    "MiniMaxH3MotionContextSaveLatent": "💾 H3 续拍存档",
    "MiniMaxH3MotionContextLoadLatent": "📂 H3 续拍读档 (Load Latent)",
    "MiniMaxH3MotionContextChain": "🔗 H3 续拍链控 (Chain)",
    "MiniMaxH3MotionContextSeamProbe": "🔍 H3 续拍接缝检测 (Seam Probe)",
}

_H3MC_RETURN_NAMES = {
    "MiniMaxH3MotionContext": ("正面条件", "剪头帧数"),
    "MiniMaxH3MotionContextTrim": ("图像", "音频"),
    "MiniMaxH3MotionContextSaveLatent": ("潜空间",),
    "MiniMaxH3MotionContextLoadLatent": ("续写潜空间",),
    "MiniMaxH3MotionContextSeamProbe": ("音频", "检测报告"),
}

# 节点描述（右键「属性」等处显示的说明文字）。
_H3MC_DESC = {
    "MiniMaxH3MotionContextSaveLatent":
        "把采样器输出的画面+声音潜空间存进 output 目录，供下一次潜空间续写自动承接。"
        "编号保持 0（自动模式）接一次即可：之后每跑一段自动落一个新文件，永不改动。"
        "输出是输入潜空间的直通，可直接接后面的 VAE 解码节点。",
    "MiniMaxH3MotionContextLoadLatent":
        "读取一份续拍存档。日常无需使用——导演台的潜空间续写会自动承接最新存档；"
        "只有想把某个特定片段锁定为续写来源时才需要它，属于高级用法。",
}

# 参数显示名 + 悬停说明。tooltip 为空串表示只改名字、不动说明。
_H3MC_SPEC = {
    "MiniMaxH3MotionContext": {
        "conditioning": ("条件", ""),
        "vae": ("视频 VAE", ""),
        "latent": ("本片段潜空间", ""),
        "context_length": ("续写画面帧数",
                           "从上一片段带过来的画面帧数。只有这几个数是潜空间整步，所以只提供这几个。"
                           "5 勉强流畅，22 几乎无缝。越长钉住的越多，但都会从成片开头剪掉——"
                           "56 相当于每次渲染白扔 2.3 秒。"),
        "audio_context_length": ("续写音频帧数",
                                 "钉住的尾部声音帧数，与画面窗口无关。0 = 跟随画面帧数。"
                                 "窗口与钉住的画面对齐结尾，这里只决定声音往回够多远。"
                                 "3 的倍数正好落在 40Hz 音频网格上，24 的倍数是整秒：24 即钉住最后一秒。"),
        "context_frames": ("上一片段画面（像素）",
                           "上一片段解码后的帧。没接 context_latent 时才用它；接了就以潜空间为准，这里忽略。"),
        "context_latent": ("上一片段潜空间",
                           "上一片段的采样输出潜空间（接解码节点的同一根线）。画面和声音都直接从中切片，"
                           "跳过解码-重编码的每链损耗。分辨率必须与本片段一致。"),
        "audio_vae": ("音频 VAE",
                      "H3 音频 VAE。配合 context_audio 使用，把上一片段的尾部声音接过接缝。"
                      "接了 context_latent 就不需要。"),
        "context_audio": ("上一片段音频",
                          "上一片段的音频。与钉住帧数对应的尾部会被编码并一起钉住。接了 context_latent 时忽略。"),
    },
    "MiniMaxH3MotionContextTrim": {
        "images": ("图像", ""),
        "trim_frames": ("剪掉帧数",
                        "接「续拍钉帧」的 trim_frames 输出。钉住的帧会出现在成片开头，拼接前要剪掉。"),
        "audio": ("音频",
                  "同一片段解码后的音频。按相同时长修剪，声音与画面保持锁定。无声片段可不接。"),
        "fps": ("帧率",
                "把剪掉帧数换算成音频时长的帧率。必须与接给「创建视频」的帧率一致。"),
        "match_tail": ("对齐音频尾部",
                       "让音频时长严格等于 帧数/帧率：长则截断，短则补静音。H3 的音频网格按最近取整，"
                       "每段都会多出或少了约 8ms 声音，不处理会在每次续接时累积。"),
    },
    "MiniMaxH3MotionContextSaveLatent": {
        "latent": ("潜空间", "采样器的输出潜空间（接解码节点的同一根线）。"),
        "filename_prefix": ("保存路径",
                            "保存在 ComfyUI 的 output 目录下。默认值把整条链的潜空间收在同一个文件夹，"
                            "读档节点才能按编号找到。"),
        "clip_index": ("本片段编号",
                       "保持 0（自动模式）即可：每次运行自动存一个新编号文件，永不覆盖旧档，"
                       "导演台的潜空间续写永远承接最新一段，全程无需手动管理编号。"
                       "只有想固定槽位、重跑时覆盖自己的废片，才手动填 1、2、3……"),
    },
    "MiniMaxH3MotionContextLoadLatent": {
        "latent_path": ("存档路径",
                        "保存的潜空间文件或文件夹（相对路径基于 ComfyUI 的 output 目录）。"
                        "指向具体文件且编号大于 0 时总是读那个文件、忽略编号。编号 0 不读任何文件。"),
        "clip_index": ("续写自第几段",
                       "要承接的片段编号，读档节点读它的槽位。第一段：这里 0，存档 1（不读文件）。"
                       "从第一段做第二段：这里 1，存档 2。"),
    },
    "MiniMaxH3MotionContextSeamProbe": {
        "clip_b_untrimmed": ("本片段未剪音频",
                             "本片段直接从音频 VAE 解码出来的音频，接在剪头节点之前。"
                             "它还带着钉住的头部，那正是要测量的部分。"),
        "trim_frames": ("剪掉帧数",
                        "接「续拍钉帧」的 trim_frames 输出，与剪头节点同值。即钉住的跨度。"),
        "clip_a_latent": ("上一片段潜空间",
                          "上一片段的 AV 潜空间：与「续拍钉帧」context_latent 同一根线。"
                          "节点会自己解码并做尾部对齐。不接则只描述本片段，不做测量。"),
        "audio_vae": ("音频 VAE", "H3 音频 VAE，用于把上一片段的音频从潜空间解出来。"),
        "fps": ("帧率", "必须与接给「创建视频」的帧率一致。"),
        "window_ms": ("分析窗口(毫秒)", "相关性分析窗口。"),
        "search_ms": ("搜索范围(毫秒)", "向两侧搜索的最大偏移。"),
    },
}

# 控件默认值覆盖（仍只在注册层注入，_h3mc 内部保持上游原样）。
_H3MC_DEFAULTS = {
    # 编号默认 0 = 自动模式：每跑一段自动落一个新文件，潜空间续写永远承接最新。
    "MiniMaxH3MotionContextSaveLatent": {"clip_index": 0},
}


def _wrap_input_types(orig, spec_map, defaults=None):
    """包一层原节点的 INPUT_TYPES：命中映射的参数注入中文 label / tooltip。

    orig 是通过类访问拿到的已绑定 classmethod，调用时不传参。
    """
    def wrapper(*args, **kwargs):
        d = orig()
        for section in ("required", "optional"):
            for key, spec in d.get(section, {}).items():
                hit = spec_map.get(key)
                if hit is None:
                    continue
                if not isinstance(spec, tuple) or not spec:
                    continue
                zh_label, zh_tip = hit
                meta = spec[1] if len(spec) >= 2 else None
                if meta is None:
                    meta = {}
                    if len(spec) == 1:
                        d[section][key] = (spec[0], meta)
                    else:
                        d[section][key] = spec[:1] + (meta,)
                if isinstance(meta, dict):
                    meta["label"] = zh_label
                    if zh_tip:
                        meta["tooltip"] = zh_tip
                    dft = (defaults or {}).get(key)
                    if dft is not None:
                        meta["default"] = dft
        return d
    return wrapper


def apply_zh(cls_map, name_map):
    """在注册层统一班长全家桶风格。cls_map/name_map 是 _h3mc 的两个映射 dict。

    单个节点处理失败只跳过该节点，不拖垮整包加载。
    """
    for node_id, cls in list(cls_map.items()):
        try:
            cls.CATEGORY = _H3MC_CATEGORY
            if node_id in _H3MC_NAMES:
                name_map[node_id] = _H3MC_NAMES[node_id]
            ret = _H3MC_RETURN_NAMES.get(node_id)
            if ret and len(getattr(cls, "RETURN_TYPES", ()) or ()) == len(ret):
                cls.RETURN_NAMES = ret
            if node_id in _H3MC_DESC:
                cls.DESCRIPTION = _H3MC_DESC[node_id]
            spec_map = _H3MC_SPEC.get(node_id)
            if spec_map:
                cls.INPUT_TYPES = classmethod(
                    _wrap_input_types(cls.INPUT_TYPES, spec_map,
                                      _H3MC_DEFAULTS.get(node_id)))
        except Exception as e:
            print(f"⚠️ [班长全家桶] H3 续拍节点 {node_id} 中文化跳过: {e}")
