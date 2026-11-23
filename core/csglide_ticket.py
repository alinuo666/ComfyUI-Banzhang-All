# -*- coding: utf-8 -*-
"""从 ComfyUI prompt 确定性编译段身份 Ticket（内部数据契约，**不是节点**）。

为什么从 prompt 编译
--------------------
execution.py:219-220 里 hidden.PROMPT 注入的是
``dynprompt.get_original_prompt()``，同一次执行里导演台与存档节点拿到的是
**同一份 prompt 字典**。两边各自算出同一张 Ticket，于是：

  * 不读全局 ``chain.json.current``（消除异步写 current 导致的错段）
  * 不查进程内短时表（导演台被 ComfyUI 缓存跳过也照样算得出来）
  * 不加端口、不改连线、旧工作流零改动

定位导演台优先走「顺序锚」连线（历史遗留口，接导演台输出 3）。20261111
阶段 1 起「💾 续拍存档」已并入「🎬 H3 VAE 快速解码」，新结构不再有这个口，
一律走「全图唯一导演台」——提交前门禁已保证导演台只有一个。

阶段判定也放在本模块：写盘方（VAE 快速解码）与收片方（视频合并自报身份）
必须调用同一个 decode_stage()，不能各写一套，否则会认错一采/二采。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

try:
    from . import csglide_ledger as ledger
except ImportError:
    from . import csglide_ledger as ledger

CAST_TYPES = ("CSGlideCastCS", "CSGlideCastLegacyCS")


class TicketError(ValueError):
    """段身份契约违规。一律硬失败，不再兜底新建段。"""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), default=str)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _strip_runtime_keys(prompt: Any) -> Any:
    """剥掉执行器在节点字典上原地追加的运行时键，只留提交时的字面图。

    ComfyUI 执行器开跑时给每个带 IS_CHANGED 的节点写 ``is_changed``（execution.py
    的 IsChangedCache），写档方拿到的 hidden.prompt 是**带标记的活图**；而历史
    （PromptQueue.task_done）存的是**执行前一刻的深拷贝**，没有标记。两侧若直接
    对整图哈希，同一份提交也会算出两个指纹，认版守卫永远拒收（20261123 真机：
    视频出了、潜空间档写了，自动收片却报「没有对应的潜空间版本」）。
    这里与成片嵌入元数据 ``_video_prompt_json`` 同一套净化：哈希前剥 is_changed，
    写档方与收片方都归一到提交时的干净图，指纹必然相等。
    """
    if not isinstance(prompt, dict):
        return prompt
    return {nid: ({k: v for k, v in entry.items() if k != "is_changed"}
                  if isinstance(entry, dict) else entry)
            for nid, entry in prompt.items()}


def prompt_fingerprint(prompt: Any) -> str:
    if not isinstance(prompt, dict) or not prompt:
        raise TicketError("hidden.prompt 未注入或为空：请确认节点声明了 hidden PROMPT")
    return digest(_strip_runtime_keys(prompt))


@dataclass(frozen=True)
class SegmentTicket:
    project_id: str
    clip_id: str
    shot: str
    id_kind: str
    length: int
    gross_frames: int
    trim_head: int
    net_frames: int
    fps: int
    fingerprint: str
    cast_node_id: str

    def ticket_hash(self):
        return digest(asdict(self))

    @property
    def label(self):
        return "%s / %s" % (self.project_id, self.clip_id)


def _locate_cast(prompt, node_id=None):
    """按 顺序锚（历史遗留）→ 本节点自身 → 全图唯一 的优先级定位导演台。

    20261111 阶段 1 起新结构没有顺序锚，一律落到「全图唯一」这一条；
    提交前门禁已保证导演台只有一个。
    """
    if node_id is not None:
        mine = prompt.get(str(node_id))
        if isinstance(mine, dict):
            anchor = (mine.get("inputs") or {}).get("顺序锚")
            if isinstance(anchor, (list, tuple)) and len(anchor) >= 2:
                src = prompt.get(str(anchor[0]))
                if isinstance(src, dict) and src.get("class_type") in CAST_TYPES:
                    return str(anchor[0])
            if mine.get("class_type") in CAST_TYPES:
                return str(node_id)
    found = [str(k) for k, v in prompt.items()
             if isinstance(v, dict) and v.get("class_type") in CAST_TYPES]
    if len(found) == 1:
        return found[0]
    if not found:
        raise TicketError("本次 prompt 里没有导演台节点（CSGlideCastCS）")
    raise TicketError("本次 prompt 有 %d 个导演台（%s），段身份不唯一；"
                      "一张画布只能保留一个导演台"
                      % (len(found), ",".join(found)))


def resolve_clip_id(name, clip, shot, summary_fn=None):
    """按 _register_clip 同口径解析真实段 id（段身份的唯一入口）。

    两条提交路径，身份来源不同（20261107 后）：
      · 编译通道（导演台正常提交）：bz_prompt_build.js 在提交时写入本段真实
        cid，并有一处兜底再钉一次 —— 这里显式 clip 优先即可命中。
      · 裸提交（直接 Queue / 旧工作流 / 外部 POST /prompt）：
        csglide_cast.js 的 serializeValue 会把 widget 里的 chain.clip 抹成 ""
        （防止工作流跨机器分发时带着别的工程的 clip_XXXX 撞 _SegBindingLost），
        此时只能按 chain.shot 这个分段 uid 从档案反查。
    所以所有需要 cid 的下游（承接档定位、自动收片、视频合并归属、
    时间轴音频驱动）都必须走这里，不能再各自读 chain.clip。
    都拿不到返回空串；调用方必须打日志说明影响，不要静默退化。
    """
    cid = str(clip or "").strip()
    if cid:
        return cid
    shot = str(shot or "").strip()
    if not (name and shot and summary_fn):
        return ""
    try:
        for row in (summary_fn(name).get("clips") or []):
            if str(row.get("shot") or "") == shot:
                return str(row.get("id") or "")
    except Exception:
        return ""
    return ""


def ticket_from_prompt(prompt, node_id=None):
    """把一次提交的 prompt 编译成唯一段身份。找不到 / 不完整一律抛中文错误。"""
    fingerprint = prompt_fingerprint(prompt)
    cast_id = _locate_cast(prompt, node_id)
    spec = prompt[cast_id]
    inputs = spec.get("inputs") or {}
    override = inputs.get("h3_override")
    if isinstance(override, str) and override.strip():
        raw = override
    elif isinstance(override, (list, tuple)) and len(override) >= 2:
        # 中枢/无头编排可能把 h3_data 从上游节点接进来。能读到字面值就用它；
        # 读不到必须硬失败，绝不能退回去用面板里那份旧的 h3_data（会认错段）。
        src = prompt.get(str(override[0]))
        raw = None
        if isinstance(src, dict):
            upstream = src.get("inputs") or {}
            for key in ("h3_data", "value", "text", "string"):
                value = upstream.get(key)
                if isinstance(value, str) and value.strip():
                    raw = value
                    break
        if raw is None:
            raise TicketError(
                "导演台 h3_override 接了 #%s 的连线，但上游没有可直接读取的字面值；"
                "Ticket 不能拿面板里的旧 h3_data 顶替（会认错段）。"
                "请让上游直接输出 h3_data 字符串，或改用 h3_data 字面值提交。"
                % override[0])
    else:
        raw = inputs.get("h3_data")
    if isinstance(raw, (list, tuple)):
        raise TicketError("导演台 h3_data 是连线而非字面值；Ticket 需要字面 JSON")
    try:
        data = json.loads(raw or "{}")
    except (TypeError, ValueError) as exc:
        raise TicketError("导演台 h3_data 不是合法 JSON：%s" % exc)
    if not isinstance(data, dict):
        raise TicketError("导演台 h3_data 解析后不是对象")

    chain = data.get("chain") or {}
    name = str(chain.get("name") or "").strip()
    cid = str(chain.get("clip") or "").strip()
    shot = str(chain.get("shot") or "").strip()
    if not name:
        raise TicketError("导演台 h3_data.chain.name 为空：工程名没登记")
    if not cid and not shot:
        raise TicketError(
            "导演台 h3_data.chain 的 clip 与 shot 都为空 —— 既没有段 id 也没有"
            "分段 uid，无法认段。请检查提交前编译是否把段身份写进来。")
    # 正常画布 Queue 时 bz_prompt_build.js:937-940 会主动清掉 chain.clip，
    # 后端 _register_clip 按 chain.shot 认段（csglide_cast.py:2791-2801）。
    # Ticket 沿用同一口径：clip 为空就以 shot uid 作待解析身份，由存档节点
    # 按 shot 从档案反查真实 cid（不读全局 current）。
    id_kind = "clip" if cid else "shot"
    resolved = cid if cid else "@shot:" + shot

    length = int(data.get("length") or 124)
    cont = data.get("cont") or {}
    try:
        overlap = int(cont.get("frames") or 0)
    except (TypeError, ValueError):
        overlap = 0
    is_first = (cid == "clip_0001") or overlap <= 0
    frame = ledger.frame_spec_for(length, is_first=is_first, overlap=overlap)

    return SegmentTicket(
        project_id=name, clip_id=resolved, shot=shot, id_kind=id_kind,
        length=int(length), gross_frames=frame.gross_frames,
        trim_head=frame.trim_head, net_frames=frame.net_frames, fps=frame.fps,
        fingerprint=fingerprint, cast_node_id=cast_id,
    )


# ==============================================================================
# 阶段判定（20261111 阶段 1）
# ==============================================================================

# 阶段的结构性定义：这份 latent 一共经过几个「🎬 H3 终极放大」的放大重采样。
#   0 个 → s1（一采）；1 个 → s2（二采）；≥2 个 → s3（三采-latent，复用终极放大）。
# 三采 RelayVSR 是像素域超分、不接 latent 到解码，天然不进这个判定（它的 s3
# 由收片方 _declare_film_identity 认出 RelayVSR 自报）。
UPSCALE_TYPES = ("BanZhang_MMH3_Upscale",)

# 导演台各输出口「本身已是第几采」（用放大个数表示的基阶段）。
# 单阶段提交时上游历史在导演台读档口被截断，纯数可见放大个数会少算 —— 读档口
# 携带的基阶段补回被截断的那部分。口号按 RETURN_TYPES 序号（csglide_cast.py）：
#   3 潜空间（活一采输出，放大前）→ 0；7 整片潜空间 → 0（沿用旧纯计数行为）；
#   9 本段一采潜空间 → 0；10 本段二采潜空间 → 1（这份档本身已二采）；
#   11 本段二采视频 → 1（P3 视频口超分读档口，VIDEO 喂 RelayVSR，登记只为判据自洽，
#   与前端 bz_stage_decode.js CAST_PORT_BASE 逐字同源）。
# 未列出的口（含旧版导演台）默认 0，等价于旧的纯计数，无回归。
CAST_PORT_BASE = {3: 0, 7: 0, 9: 0, 10: 1, 11: 1}


def decode_stage(prompt, node_id, max_hops=16):
    """从本节点的 latent 输入向上回溯，判 s1/s2/s3。

    判据＝**导演台读档口携带的基阶段** ＋ **上游可见的终极放大个数**：
      · 为什么按「有几个放大节点」而不是编号/命名/深度/首个命中：编号换工作流就变、
        命名可改、深度被透传节点顶偏；三采-latent 复用同一个放大类，链上串两个放大，
        旧版「首个命中即返 s2」会把三采误判成二采。只有「被放大重采样过几次」是
        数据本身的属性，插多少中间节点都改不了它。
      · 为什么要加基阶段：单阶段提交（只跑二采/只跑三采）时，下游接的是导演台
        「本段一采/二采潜空间」读档口，上游历史在口上被截断、可见放大只剩本次那一个。
        读档口本身是第几采（CAST_PORT_BASE）补回被截断的部分：接二采档＋1 个可见
        放大 → 1+1=2 → s3，不再误判 s2。全程提交（活链完整）基阶段为 0、数得到全部
        放大，结果与旧版一致。

    解码节点、存档节点都能用：两者拿到的都是同一条 latent 链。
    """
    graph = prompt if isinstance(prompt, dict) else {}
    me = str(node_id)
    spec = graph.get(me) or {}
    seen = set()
    # frontier 携带 (节点 id, 连线用的输出口序号)：序号用来在碰到导演台时取基阶段。
    frontier = []
    for value in (spec.get("inputs") or {}).values():
        if isinstance(value, (list, tuple)) and len(value) == 2:
            frontier.append((str(value[0]), value[1]))
    upscales = set()
    base = 0
    for _ in range(max_hops):
        if not frontier:
            break
        nxt = []
        for nid, out_idx in frontier:
            if nid in seen or nid == me:
                continue
            seen.add(nid)
            up = graph.get(nid) or {}
            cls = str(up.get("class_type") or "")
            if cls in UPSCALE_TYPES:
                upscales.add(nid)   # 记数但继续往上：三采要数到第二个放大
            if cls in CAST_TYPES:
                # 导演台是 latent 源头：按输出口序号取基阶段，不必再往上。
                port_base = CAST_PORT_BASE.get(out_idx, 0)
                if out_idx == 12:
                    try:
                        from .csglide_stage_bus import downstream_latent_stage
                        raw = (up.get("inputs") or {}).get("h3_data") or "{}"
                        data = json.loads(raw) if isinstance(raw, str) else raw
                        stage = downstream_latent_stage(data.get("stage_flow"))
                        port_base = max(0, int(stage[1:]) - 1) if stage else 0
                    except (ValueError, TypeError, AttributeError):
                        port_base = 0
                base = max(base, port_base)
                continue
            for value in (up.get("inputs") or {}).values():
                if isinstance(value, (list, tuple)) and len(value) == 2:
                    nxt.append((str(value[0]), value[1]))
        frontier = nxt
    n = base + len(upscales)
    if n >= 2:
        return "s3"
    if n == 1:
        return "s2"
    return "s1"
