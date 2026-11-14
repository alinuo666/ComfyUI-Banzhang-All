# -*- coding: utf-8 -*-
"""图像编辑台的模型家族判别与提示词改写。

从 csglide_qwen.py 拆出来的独立职责：这两个东西都只跟「模型是谁」有关，
跟面板长什么样、参考图怎么进无关，混在节点文件里会让那个文件超长，
也让「换一个模型家族要改哪几处」这件事不直观。

判别依据是 tokenizer 类型——它由 CLIPLoader 的 type 决定，与模型文件一一
对应，不受用户连线顺序影响。三个硬差异（tokenize 签名 / 潜空间通道 /
参考图能力）全挂在同一个判别点上，不另设开关。
"""

import re


# ---- 模型家族 ----------------------------------------------------------
FAMILY_MOSS = "moss"        # MOSS-Image：qwen3.5_9b 编码器（带视觉塔；DiT 无参考潜空间）
FAMILY_QWEN21 = "qwen21"    # Qwen-Image 2.1：qwen3vl_8b 编码器，有视觉塔
FAMILY_H3IMAGE = "h3image"  # MiniMax H3 Image：qwen3vl_32b 编码器（截断50层），文生图+图片编辑

# 潜空间通道数：MOSS 走 Flux2 格式（128），Qwen-Image 2.1 走 QwenImage21（64），
# H3 Image 走视频潜空间静态帧（24，5维含 T=1）。
LATENT_CHANNELS = {FAMILY_MOSS: 128, FAMILY_QWEN21: 64, FAMILY_H3IMAGE: 24}

# 提示词改写的默认系统提示词：MOSS-Image 是中文描述模型，喂成段的描述比
# 喂关键词串更稳。改写后仍走同一个编码器，不额外占显存。
MOSS_REWRITE_SYSTEM = (
    "你是 MOSS-Image 的提示词改写器。把用户的一段描述改写成一段**中文画面描述**，"
    "供文生图模型直接使用。\n"
    "规则：\n"
    "- 只输出改写后的描述文本本身，不要标题、不要解释、不要列表、不要 Markdown。\n"
    "- 保留用户指定的主体、数量、动作、场景、风格、氛围、色彩，不得擅自增删。\n"
    "- 用户没写的地方补具体的视觉信息：取景、视角、光照、材质、配色。\n"
    "- 只写画面里看得见的东西：不写声音、气味、背景故事、创作意图。\n"
    "- 不加画质关键词（masterpiece、8K、best quality 之类），不写负面提示词。\n"
    "- 中文，1～3 个自然段，200～350 字。"
)

REWRITE_MAX_LENGTH_DEFAULT = 512

# H3 Image 的提示词改写默认系统提示词：把简短编辑指令扩写成完整的英文画面描述。
# 主编码器 qwen3vl_32b 截断到 50 层，不能出字——改写必须外接独立模型（同文案台机制）。
H3IMAGE_REWRITE_SYSTEM = (
    "You are a prompt expander for MiniMax H3 Image. "
    "Rewrite the user's short editing instruction into a rich, vivid English description "
    "of the intended finished target image.\n"
    "Rules:\n"
    "- Output only the rewritten description, no titles, no explanations, no JSON.\n"
    "- Preserve every subject, action, scene, and style the user specified.\n"
    "- Refer to reference images as <Picture 1>, <Picture 2>, etc.\n"
    "- Add concrete visual details: framing, lighting, materials, colors, atmosphere.\n"
    "- Describe only what is visible in the image; no sounds, smells, or backstory.\n"
    "- English, 1-3 paragraphs, 150-400 words."
)


def detect_family(clip):
    """按 tokenizer 类型判别模型家族；认不出来就报错，不猜。

    猜错的代价很高：潜空间通道数不匹配会在采样时才炸，而报错发生在编码前，
    用户能立刻看懂是自己接错了 clip。
    """
    tok_name = type(getattr(clip, "tokenizer", None)).__name__
    if tok_name == "MOSSImageTokenizer":
        return FAMILY_MOSS
    if tok_name == "QwenImage21Tokenizer":
        return FAMILY_QWEN21
    if tok_name == "MiniMaxH3Tokenizer":
        return FAMILY_H3IMAGE
    raise RuntimeError(
        "图像编辑台只支持三种编码器：MOSS-Image（qwen3.5_9b，CLIPLoader 的 type 选 "
        "moss_image）、Qwen-Image 2.1（qwen3vl_8b，type 选 qwen_image）与 "
        "MiniMax H3 Image（qwen3vl_32b，type 选 minimax）。"
        "当前接入的是 %s——请检查 CLIP 加载节点的 type。" % (tok_name or "未知类型"))


def rewrite_max_length(value):
    """改写输出的最大 token 数。0 = 不限（用模型默认）。

    改写产出的是 200～350 字的中文段落，512 token 已经宽裕；上限只是防止
    模型跑飞时无限出字。
    """
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return REWRITE_MAX_LENGTH_DEFAULT
    if n <= 0:
        return 0
    return max(64, min(4096, n))


def rewrite_prompt(clip, prompt, system_prompt, max_length, log, images=None,
                   temperature=0.7):
    """用接入的 clip 自己做提示词改写，返回改写后的文本。

    走的是官方 TextGenerate 那条路（clip.tokenize → clip.generate → clip.decode），
    所以采样参数与官方节点同源，不另发明一套。MOSS 的编码器带 lm_head 与
    mtp.fc.weight（权重实测存在），能出字；Qwen-Image 2.1 的 qwen3vl_8b 同样带
    lm_head，只是没有 mtp 权重（推测解码不可用，普通解码不受影响）。

    tokenize 的参数集与官方 TextGenerate 在 use_default_template=True 时**逐字
    相同**：thinking=False 让模型直接给答案（不吐思考块），system_prompt 前置成
    独立的 system 段。

    改写失败一律**回落到原文**并记日志：改写是锦上添花，不该让整条链路挂掉。

    `images` 是可选的多模态输入（`[[1,H,W,3], ...]`）：只有编码器带视觉塔时
    才有效（Qwen3-VL / Qwen3.5 系列都带；不传就是纯文本改写，行为与原来一致）。
    调用方要自己控制尺寸——原图直塞会撑爆视觉塔。
    """
    if not prompt.strip():
        return prompt
    try:
        tokens = clip.tokenize(prompt, image=None, images=images or [], skip_template=False,
                               min_length=1, thinking=False, video=None, audio=None,
                               system_prompt=system_prompt or "")
        ids = clip.generate(tokens, do_sample=True, max_length=max_length or 512,
                            temperature=temperature, top_k=64, top_p=0.95, min_p=0.05,
                            repetition_penalty=1.05, seed=0)
        text = clip.decode(ids).strip()
        if not text:
            log("【改写】模型没有输出内容，沿用原文")
            return prompt
        log("【改写】已改写（%d 字）" % len(text))
        return text
    except Exception as e:
        log("【改写】失败（%s: %s），沿用原文" % (type(e).__name__, e))
        return prompt


# ---------------- 文案台：整段改写 + 硬守门 ----------------

# 生成长度上限。**不是**模型上下文（32768 那是输入窗口）：H3 段提示词常在
# 2000~3000 字，1024 会中途截断；截断后守门判镜号/标签数量不符、回落原文，
# 等于白跑一轮。要更长的段就往上调，代价按比例变慢。
REWRITE_MAX_LENGTH_DESK = 4096

# 官方全参考模式改写格式指南（MiniMax H3 Full-Reference Mode Rewrite Output
# Format Guide）：原文逐字内置 + 语言覆盖 + 三条管线适配补丁。
REWRITE_SYSTEM_OFFICIAL = r"""【输出语言】简体中文。只有对白、歌词、画面可见文字保留原语言。段名与英文标记照抄，不翻译。

# 必须只输出这六段，按序，不加其它内容
subject_definitions：每个被引用内容一项一行——标签、是什么、要保留的特征
summary：一句话概括目标视频与引用关系，以 [任务类型] 开头
retention_analysis：每个标签一行，说明保留/转移/复用方式
detailed_description：逐镜描述画面、动作、光影、运镜、声音、对白
overall_soundscape：全片环境底噪与物件实声
non_diegetic_music：只有观众听得见的配乐（无则写"无"）

# 引用标签
<Subject N>：可复用的可见内容（人物、场景、道具、服装、风格）。代表"用在片子里的东西"，不是源文件
<Picture N>：图片本身作为首帧、关键帧、末帧、构图锚点时单列；只用来定义角色或场景的，写进对应 <Subject N> 定义里，不单列
<Video N>：整片级关系（剪辑源、续写起点、结构参考）
<Audio N>：音频（复制或参考）
标签编号在六段中含义一致；四类标签各自独立编号，不互相配对。

# summary 任务类型（可组合，用 + 连接，不重复）
keyframe completion：图片作具体帧锚点
reference generation：素材提供生成依据，不作具体帧、不作剪辑源
video editing：直接修改源视频
video continuation：从源视频续写
audio reuse：原样复制音频
audio reference：只参考音色、节奏、风格，不复制信号
剪辑类在类型前缀后起笔："目标视频是 <Video 1> 的剪辑版。"

# retention_analysis 关系标记（固定英文值）
可见内容：fully_preserved（完整保留）/ partially_preserved（部分保留）/ attribute_transfer（把一份素材的外貌/特征移到另一个主体上，例如以参考图的脸生成另一个人；只转移被引用的那几项特征，目标主体的身份、其余外貌与动作自行合理设定）/ weak_reference（只保留宽泛相似）
音频：fully_copy / partially_copy / reference / weak_reference
写法：<Subject 1>（出现于 [Shot 1]、[Shot 3]）：fully_preserved - 说明

# detailed_description
- [Shot 1] 不带时间戳；后续镜头写 [Shot N] At MM:SS.mmm, ……
- 每镜交代：景别、构图、主体位置与动作、环境与光线、运镜、当前声音。<Subject N> 首次出现时写其特征与画面位置，后续沿用同一标签不再重定义
- 运镜写类型、幅度、速度；<Picture N> 作帧锚点时用自然措辞（镜头自 <Picture 1> 起幅 / 关键帧对应 <Picture 2> / 落在 <Picture 3>）
- 发声源固定编号 (S1)(S2)…；对白歌词写 <d>[语言] ……</d>，听不清写 [unclear]；主体发声写 <Subject N> (Sx)，画外注明"画外"。(Sx) 按实际发声顺序一次性分配，retention_analysis 里不写
- 对白跨切点用 <scenetrans>，语音被片尾截断用 <cutoff>
- [Shot 1] 前用一两句确立整体风格；相邻镜头之间要有动作/视线/情绪上的接续
- 生成类 700–1200 字，按各镜头信息量分配，不机械凑数

# 声音两段
overall_soundscape 只写贯穿全片的环境底噪与实声；对白、歌唱、单镜音效留在 detailed_description。
non_diegetic_music 只写观众听得见的配乐（编制、速度、力度发展），无则写"无"。
对白歌词只出现在 <d> 里，不在这两段重复。

# 示例
subject_definitions:
<Subject 1> 为 <Picture 1> 中的咖啡店环境，砖墙、橙色软包沙发、霓虹灯牌、木质茶几。
<Subject 2> 为 <Picture 2> 中的金发女子，长发、浅粉衬衫。
summary:
[reference generation] <Subject 2> 在 <Subject 1> 里吃饼干，一条白狗扑来，她护住饼干开口喝止。
retention_analysis:
<Subject 1>（出现于 [Shot 1]、[Shot 2]）：fully_preserved - 砖墙、沙发、霓虹灯牌、茶几保留。
<Subject 2>（出现于 [Shot 1]、[Shot 2]）：fully_preserved - 身份、长发、浅粉衬衫保留。
detailed_description:
写实多机位情景喜剧风格，室内暖光。
[Shot 1] 中景建立 <Subject 1>。 <Subject 2> (S1) 坐在沙发上捧着巧克力曲奇。一条厚白毛的狗从左入画扑向曲奇，牵引绳绷直。<Subject 2> (S1) 手向后一收，<d>[中文] 哎！看着点你家的狗！</d> 她合上嘴护住饼干。
[Shot 2] At 00:03.000, 硬切至 <Subject 2> (S1) 近景，她的恼意缓下来，<d>[中文] 至少他品味不错。</d> 笑着把曲奇举了一下。
overall_soundscape:
咖啡店室内柔和底噪贯穿全片。
non_diegetic_music:
无

# 本管线规则（优先于以上）
1. 输入中的 @图片N / @音频N / @视频N 必须逐字保留，不得转写成 <Picture N> 等，不得删改编号——下游按这些编号选素材，少一个就少一份素材。
2. 只能用输入里出现过、或「可用引用」清单里列出的编号；缺素材的主体改用具体文字描述。
3. 把输入重建成完整六段：输入比完整分镜短（一句话、一条粗略记录）时，按已有信息扩写成完整镜头与细节；不引入输入和清单里都没有的素材或剧情。"""


_REF_RE = re.compile(r"@(?:图片|音频|视频)\d+")
# 官方素材标签（<Picture N> / <Video N> / <Audio N>）。Subject 是抽象主体，
# 不占素材槽位，所以不在校验范围内。
_MAT_TAG_RE = re.compile(r"<(Picture|Video|Audio)\s*(\d+)>")
_KNOWN_TASK_TYPES = {"keyframe completion", "reference generation", "video editing",
                     "video continuation", "audio reuse", "audio reference"}


def _allowed_numbers(facts, kind):
    """某类素材**有文件**的槽位编号集合（空槽占号但不算素材）。"""
    return {i + 1 for i, nm in enumerate(facts.get(kind) or []) if nm}


def _allowed_task_types(facts):
    """本次素材允许的任务类型：有视频才谈剪辑/续写，有音频（或带音轨的视频）
    才谈音频；否则 reference generation / keyframe completion 以外的一律不许。"""
    out = {"reference generation"}
    if _allowed_numbers(facts, "images"):
        out.add("keyframe completion")
    if _allowed_numbers(facts, "videos"):
        out |= {"video editing", "video continuation", "audio reuse", "audio reference"}
    if _allowed_numbers(facts, "audios"):
        out |= {"audio reuse", "audio reference"}
    return out


def _materials_desc(facts):
    """「图片 2 张，没有视频和音频」这类中文说明，给守门报错用。"""
    names = {"images": "图片", "videos": "视频", "audios": "音频"}
    have = ["%s %d 个" % (names[k], len(_allowed_numbers(facts, k)))
            for k in ("images", "videos", "audios") if _allowed_numbers(facts, k)]
    return "、".join(have) if have else "没有参考素材"


def _summary_types(new):
    """summary 开头方括号里的任务类型列表；找不到返回 None（不拦）。"""
    i = new.find("summary")
    if i < 0:
        return None
    m = re.search(r"\[([^\]\n]{2,80})\]", new[i:i + 400])
    if not m:
        return None
    return [t.strip() for t in m.group(1).split("+") if t.strip()]
# 镜头标记同时认两种写法：项目 H3 实际产出「【镜头 1｜全景】」（全角括号），
# 与通用格式的「[Shot 1]」。之前只认 [镜N]，对真实格式计数恒为 0，
# 镜号保护等于没开——守门空转比没有守门更危险，因为它让人以为有保护。
def rewrite_gate_refs(text, new, manifest, facts=None):
    """格式规范化下的引用守门：None = 通过；字符串 = 不合格原因（用于重试反馈）。

    只剩两条——「保结构」的镜号/台词/`<d>` 计数随那个目标一起退役：
    ① 输入里的引用编号必须都出现在输出（丢 = 对应素材被筛掉，画面失控）；
    ② 输出不得编造清单之外的编号（清单 = 媒体架槽位映射，编 = 素材错配）。
    """
    _old = sorted(set(_REF_RE.findall(text)))
    _new = sorted(set(_REF_RE.findall(new)))
    _lost = [x for x in _old if x not in _new]
    if _lost:
        return "丢掉了引用 %s —— 这些编号对应媒体架素材，输出必须包含它们" % "、".join(_lost)
    # 允许集 = 素材清单里的编号 ∪ 输入里保留的编号。无清单时允许集就是输入那些，
    # 模型若自己把已摘掉的编号写回来（无对应参考图），这里必须拦——否则导演台
    # 按编号找不到素材，画面照样失控。所以这条检查**无条件执行**。
    _allowed = set(_REF_RE.findall(manifest)) if manifest else set()
    _allowed |= set(_old)
    _extra = [x for x in _new if x not in _allowed]
    if _extra:
        return ("出现了没有对应参考图的引用 %s —— 输入和素材清单里都没有这些编号，"
                "请用具体文字描述替代" % "、".join(_extra))
    if facts:
        # 素材标签与任务类型也走白名单：口径只有事实表一处，新增素材类型不必改这里。
        _cap = {"Picture": _allowed_numbers(facts, "images"),
                "Video": _allowed_numbers(facts, "videos"),
                "Audio": _allowed_numbers(facts, "audios")}
        _bad_tags = sorted({"<%s %s>" % (k, n) for k, n in _MAT_TAG_RE.findall(new)
                            if int(n) not in _cap.get(k, set())})
        if _bad_tags:
            return ("引用了本次不存在的素材 %s —— 这次只有%s，请改用文字描述"
                    % ("、".join(_bad_tags), _materials_desc(facts)))
        _types = _summary_types(new)
        if _types:
            _allow = _allowed_task_types(facts)
            _bad_types = [t for t in _types if t in _KNOWN_TASK_TYPES and t not in _allow]
            if _bad_types:
                return ("任务类型 %s 与本次素材不符 —— 这次只能用 %s"
                        % ("、".join(_bad_types), "、".join(sorted(_allow))))
    return None


def _reinject_lost_refs(new, lost, manifest):
    """把模型丢掉的引用编号按清单机械补回，返回补回后的文本。

    为什么是定义行而不是找语义位置：丢引用时无法可靠知道模型在正文哪句描述了
    该主体，语义插桩会插错地方；定义行落在 subject_definitions 段，下游（导演台
    按编号找素材）只认「编号存在」，正文语义不受影响。引用链路由代码保证，
    不赌模型记性——这是方案 A 的根修点。
    """
    names = dict(re.findall(r"(@(?:图片|音频|视频)\d+)\s*=\s*([^\n]+)", manifest or ""))
    lines = []
    for r in lost:
        nm = (names.get(r) or "").strip() or "参考素材"
        lines.append("%s = %s（本段引用的参考素材）" % (r, nm))
    block = "\n".join(lines)
    m = re.search(r"subject_definitions\s*:[^\n]*\n", new)
    if m:
        i = m.end()
        return new[:i] + block + "\n" + new[i:]
    return "subject_definitions:\n" + block + "\n\n" + new


def _trim_illegal_refs(new, facts):
    """清掉模型编造的素材标签、过滤与素材不符的任务类型，返回 (文本, 清除清单)。

    机械可验证的事由代码保证（与引用编号同一原则）：重试两轮仍有编造时不弃稿，
    按事实表裁剪后写回 —— 正文是模型写的，只有不存在的素材引用被摘掉。
    """
    if not facts:
        return new, []
    cap = {"Picture": _allowed_numbers(facts, "images"),
           "Video": _allowed_numbers(facts, "videos"),
           "Audio": _allowed_numbers(facts, "audios")}
    removed = []
    kept = []
    for line in new.split("\n"):
        m = re.match(r"\s*<(Picture|Video|Audio)\s*(\d+)>", line)
        # 整行以不存在的素材开头（retention 条目的形态）→ 整行删掉：
        # 只删标签会把关系标记和说明留成悬空碎片。
        if m and int(m.group(2)) not in cap.get(m.group(1), set()):
            removed.append("<%s %s>" % (m.group(1), m.group(2)))
            continue
        kept.append(line)
    out = "\n".join(kept)

    def _drop(mm):
        if int(mm.group(2)) not in cap.get(mm.group(1), set()):
            removed.append("<%s %s>" % (mm.group(1), mm.group(2)))
            return ""
        return mm.group(0)
    out = _MAT_TAG_RE.sub(_drop, out)
    out = re.sub(r"[ \t]{2,}", " ", out)

    _types = _summary_types(out)
    if _types:
        _allow = _allowed_task_types(facts)
        _keep = [t for t in _types if t not in _KNOWN_TASK_TYPES or t in _allow]
        if not _keep:
            _keep = ["reference generation"]
        if _keep != _types:
            removed.extend([t for t in _types if t not in _keep])
            i = out.find("summary")
            m = re.search(r"\[([^\]\n]{2,80})\]", out[i:i + 400])
            if m:
                out = (out[:i + m.start()] + "[" + " + ".join(_keep) + "]"
                       + out[i + m.end():])
    return out, removed


def rewrite_normalized(text, clip, system_prompt, max_length, log, manifest=None,
                       images=None, temperature=0.3, retries=1, facts=None):
    """格式规范化改写：任何输入都按官方指南重写成标准六段格式。

    与旧「润色保结构」路线的本质区别：输出结构由官方指南定义，原文结构不需要
    保持——单句会扩成完整分镜（这是特性，不是失控），已是六段的输入会被重新
    规范化（幂等）。结构剥离/镜号/`<d>` 计数那一整套随「保结构」目标一起退役，
    守门只剩引用两条；丢引用由代码按清单补回定义行（引用链路不赌模型），\n    编造编号带原因重试一次，仍不合格才回落原文。
    """
    # 引用指令必须有：有槽位清单用清单（带名字）；没有就从**输入文本**提取
    # 引用编号生成最小清单。否则模型按官方指南的 <Picture N> 标签体系转写，
    # @引用在输出里消失（实测两次：1→0、2→0），守门只能回落——白跑。
    _base = system_prompt
    if manifest:
        _base = _base + "\n\n" + manifest
    else:
        _inline = sorted(set(_REF_RE.findall(text)))
        if _inline:
            _base = _base + ("\n\n【必须保留的引用】\n输入文本中的以下引用必须逐字"
                             "保留在输出里（不要转写成 <Picture N> 等其它形式）：\n"
                             + "、".join(_inline))
    sys_p = _base
    last_why = ""
    for attempt in range(retries + 1):
        try:
            new = rewrite_prompt(clip, text, sys_p, max_length, log,
                                 images=images, temperature=temperature)
        except Exception as e:
            log("【改写】调用失败（%s: %s），沿用原文" % (type(e).__name__, e))
            return text
        if not new or new == text:
            return text
        why = rewrite_gate_refs(text, new, manifest, facts)
        if why is not None and why.startswith("丢掉了引用"):
            # 丢引用不弃稿：按清单机械补回定义行再过闸。之前是重试一轮（小模型
            # 大概率还丢）→ 两轮全挂 → 回落原文 → 用户白等还什么都没拿到。
            _lost = [x for x in sorted(set(_REF_RE.findall(text)))
                     if x not in set(_REF_RE.findall(new))]
            new = _reinject_lost_refs(new, _lost, manifest)
            log("【改写】模型丢了引用 %s —— 已由代码按清单补回定义行，不弃稿"
                % "、".join(_lost))
            why = rewrite_gate_refs(text, new, manifest, facts)
        if why is None:
            log("【改写】已规范化为官方六段格式（%d 字 → %d 字%s）"
                % (len(text), len(new),
                   "，第 %d 次尝试" % (attempt + 1) if attempt else ""))
            return new
        last_why = why
        if attempt < retries:
            log("【改写】第 %d 次不合格（%s），带反馈重试" % (attempt + 1, why))
            sys_p = (_base
                     + "\n\n【上一次输出不合格：" + why
                     + "。重写时：六段结构与标记照指南；输入里的 @引用编号必须全部"
                       "出现；只能使用清单里列出的编号；对白保留原语言】")
            temperature = max(0.15, temperature - 0.1)
    # ⚠ 前缀是给前端的信号：检查框只刷带 ⚠ 的行。回落 = 用户改写没生效，
    # 必须让他不翻终端就知道为什么（通常 = 换大模型或检查引用）。
    # 两轮都不合格 → 机械裁剪兜底：按事实表清掉编造的素材标签/任务类型，
    # 清完能过闸就写回（正文是模型的，只摘掉不存在的素材引用）。
    _trimmed, _removed = _trim_illegal_refs(new, facts)
    if _removed and rewrite_gate_refs(text, _trimmed, manifest, facts) is None:
        log("⚠ 【改写】模型写了本次不存在的素材引用（%s），已由代码清除后写回"
            % "、".join(_removed))
        return _trimmed
    log("⚠ 【改写】两轮都没通过检查：%s —— 已回落原文，本段没有改动" % last_why)
    return text
