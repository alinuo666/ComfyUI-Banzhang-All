"""H3 段落档案 —— 一条片子 = 一个文件夹，一个段落 = 一份档案（潜空间 + 元数据）。

一条原则：时间轴和潜空间存档必须是一套账。以前潜空间按 clip_index 编号存在
h3_context/ 下，时间轴另有一套顺序，两套编号一旦对不上就会出「接错了段」这种
最难查的错。现在段落档案统一发号，潜空间文件跟着段落 id 走。

磁盘布局：

    output/h3_chain/<片名>/
        chain.json                      整条片：顺序、帧率、当前段、锁定
        clip_0001.json                  第 1 段元数据
        clip_0001.cont.safetensors      第 1 段 s1 一采 AV latent（主档）
        clip_0001.t2.cont.safetensors   第 1 段第 2 个版本
        clip_0001.t2.s2.cont.safetensors  同一版本 s2 二采 AV latent
        clip_0001.mp4                   成片

20261104 起：一段一版**只有一个** AV latent 文件（.cont.safetensors）。
曾经同时存在 .latent.safetensors 与 .cont.safetensors 两份内容相同的文件，由
两条独立代码路径写入、被不同读者分别读取，导致「加长被拒 / 收片缺档 / 整片
潜空间静默丢段」。现在写入方只有一个（20261111 起是「🎬 H3 VAE 快速解码」），所有读者统一走
clip_cont()；不做旧 .latent 回退（按需求，旧工程兼容一概不管）。
一段一版仍只有一个**主档**(s1)，s2 是同一 take 的第二份加工档，按 stage 取。

只做读写和路由，不做界面；界面在 js/csglide_studio.js（阶段 4）。
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

try:
    import folder_paths
except Exception:      # pragma: no cover
    folder_paths = None

# 本地统一状态库（20261012 方案 A）：新工程的 chain/clip 权威在 SQLite，
# 老工程（目录里已有 chain.json）继续走 JSON。store 模块自带 /cglide/store/* 路由。
try:
    from .core import csglide_store as store
except ImportError:      # pragma: no cover - 独立脚本直跑
    from .core import csglide_store as store

# 引导头默认承接帧数（出厂默认）。H3 续写窗口合法格点是 17k+5：5/22/39/56…，
# 注册段时前端按 state.cont.frames 显式传值；这里是「没显式传」时的兜底，默认 39。
DEFAULT_TRIM = 39
import functools

# chain 档案的读-改-写临界区锁（20261012）：路由搬进线程池后，多个写请求
# 可能并发跑（事件循环不再天然串行化同步段）。RLock 允许函数互相嵌套调用
# （add_clip 内部会调 update_clip / save_clip）。
_chain_lock = threading.RLock()


def chainlocked(fn):
    @functools.wraps(fn)
    def _w(*a, **k):
        with _chain_lock:
            return fn(*a, **k)
    return _w


async def _io(fn, *a, **k):
    """路由里把同步档案 IO（json 读写 / stat / listdir）丢线程池：

        meta = await _io(update_clip, name, cid, patch)

    aiohttp 单事件循环，同步 IO 直接跑在路由里会堵死所有 HTTP 请求 ——
    K 盘上一次 film_summary 几十次 stat，期间整个 ComfyUI 界面都卡。
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(fn, *a, **k))


# ---------------- WebSocket 变更广播（20261012 方案B）----------------
# 档案任何写点落盘后，向所有前端推一条轻量「变了」信号；前端 bz_store
# 收到后按片名在 100ms 合帧窗口里只拉一次 film_summary（信号-拉取模式：
# 消息极小、不怕乱序/重复/丢条，权威状态永远以拉取结果为准）。
# ComfyUI 的 PromptServer.send_sync 内部已是 loop.call_soon_threadsafe，
# 所以从事件循环线程 / executor 工作线程 / 工作流执行线程调用都安全。
_WS_EVENT = "bz.chain.event"


def ws_broadcast(kind, name, clip=None, **extra):
    """档案变更广播。无界面/自检环境（PromptServer 不存在）静默跳过。"""
    try:
        from server import PromptServer
        ps = getattr(PromptServer, "instance", None)
        if ps is None:
            return
        payload = {"type": kind, "name": name}
        if clip is not None:
            payload["clip"] = str(clip)
        if extra:
            payload.update(extra)
        ps.send_sync(_WS_EVENT, payload)
    except Exception:
        pass


def _last_saved_cont():
    """_h3mc 最近一次自动写出的续拍存档（120 秒内才算数，否则 None）。

    存档节点写文件是本次采样的最后一步，收片（adopt_film）紧跟其后 ——
    时间窗内那条 LAST_SAVED 就是本次 run 写的。把它记到该段档案名下
    （take_params.cont_saved），下一段续写就能**精确认段**：目录扫描只能
    猜「最新的是谁」，串两个工程就把别的段的档接进来了。
    组件读不到 / 记录太旧 / 文件已删，都如实返回 None。
    """
    try:
        from ._h3mc import nodes as _mc_nodes
    except Exception:
        try:
            from _h3mc import nodes as _mc_nodes
        except Exception:
            return None
    rec = getattr(_mc_nodes, "LAST_SAVED", None) or {}
    p = str(rec.get("path") or "")
    t = float(rec.get("time") or 0)
    if p and os.path.isfile(p) and (time.time() - t) < 120:
        return p
    return None


def _out_dir():
    return folder_paths.get_output_directory() if folder_paths is not None else "."


# ---------------- 成片实测帧数（20261010）----------------
# H3MC 链路登记成片走 adopt_film，而它从来不写 film_frames —— 档案里恒为 0。
# 前端"这条成片是不是累积片"的判据（videoT0 / 连播落段 / 雪碧图 / 波形窗口）
# 全都靠这个字段分辨单段片与累积片，0 等于失去地面真相，只能靠猜 ——
# "整片连播每一段播两遍、前后衔接不对"就是从这开始的。
_FFPROBE_CACHE = {}


def _ffprobe_exe():
    """统一走全插件共用的查找：PATH / ComfyUI 自带 / 本包 tools/ffmpeg。
    找不到返回 None（调用方放弃探测，不是致命错误）。"""
    from .banzhang_ffmpeg import find_ffprobe
    return find_ffprobe()


def probe_film_info(path, timeout=15):
    """成片视频流的实测宽高与帧数，按 (路径, mtime, size) 缓存；失败项为 0。"""
    if not path or not os.path.isfile(path):
        return {"width": 0, "height": 0, "frames": 0}
    try:
        st = os.stat(path)
        key = (os.path.normcase(os.path.realpath(path)), st.st_mtime, st.st_size)
    except OSError:
        return {"width": 0, "height": 0, "frames": 0}
    hit = _FFPROBE_CACHE.get(key)
    if hit is not None:
        return dict(hit)
    info = {"width": 0, "height": 0, "frames": 0}
    exe = _ffprobe_exe()
    if exe:
        try:
            out = subprocess.run(
                [exe, "-v", "error", "-select_streams", "v:0", "-count_frames",
                 "-show_entries", "stream=width,height,nb_read_frames",
                 "-of", "default=noprint_wrappers=1:nokey=0", path],
                capture_output=True, text=True, timeout=timeout)
            for line in (out.stdout or "").splitlines():
                line = line.strip()
                if "=" not in line:
                    continue
                key_name, value = line.split("=", 1)
                value = value.strip()
                if key_name == "nb_read_frames":
                    key_name = "frames"
                if key_name in ("width", "height", "frames") and value.isdigit():
                    info[key_name] = int(value)
        except Exception:
            info = {"width": 0, "height": 0, "frames": 0}
    _FFPROBE_CACHE[key] = info
    return dict(info)


def probe_film_frames(path, timeout=15):
    """成片视频流的**实测**帧数；同一份文件（没被重抽覆盖过）只探一次。"""
    return int(probe_film_info(path, timeout=timeout).get("frames") or 0)


def chain_dir(name):
    """片名 → 档案目录。

    实现只有一份，在 csglide_store.chain_dir（本文件与 store 各写一份的历史
    遗留已消除）。查索引优先：改过名的工程目录名与片名不同（方案 G，20261020），
    按片名硬拼会拼出一个不存在的目录。
    """
    return store.chain_dir(name)


def unique_chain_name(base):
    """给一个还没被占用的片名：base 没目录就用它，否则 base 2 / base 3 ……
    「新建整片」自动命名用，避免重名把新片写进旧片档案。

    ⚠️ 判据是「这个名字解析出的档案目录是否已存在」，不是「索引里有没有这个
    名字」—— 改过名的工程会把旧目录留给新名字，于是**旧片名虽然从索引里抹掉
    了，按老规则拼出来却仍指向那个已被占用的目录**（方案 G，20261020）。此时
    用旧片名开新片照样会写进别人的档案，所以必须判成"已占用"并跳号。
    """
    base = (base or "未命名整片").strip() or "未命名整片"

    def taken(cand):
        # 走 chain_dir 而不是按名字硬拼：改过名的工程目录名 ≠ 片名（方案 G），
        # 硬拼会拼出一个不存在的目录 → 判成"没被占用" → 新片写进旧片档案。
        return os.path.exists(chain_dir(cand))

    if not taken(base):
        return base
    i = 2
    while taken("%s %d" % (base, i)):
        i += 1
    return "%s %d" % (base, i)


def _last_path():
    return os.path.join(_out_dir(), "h3_chain", "_last.json")


def mark_last(name):
    """记下最近一次导演台登记过的片名。

    💾续拍存档 / 📤段落调取 的「片名」留空时读它 —— 用户只要在导演台工程
    面板里填了工程名，这两个节点就不必再手打一遍，也不会因为打错或忘了同步
    而存进**另一个**档案（那是最难查的一类坑：看着跑通了，其实存错了地方）。
    """
    if not (name or "").strip():
        return
    _write_json(_last_path(), {"name": name, "time": time.time()})


def last_name():
    return ((_read_json(_last_path(), {}) or {}).get("name") or "").strip()


def producer_pkg_path(name):
    """该片名若是制片中枢工程，返回其中枢工程包路径（pkg.json），否则 None。

    中枢的目录口径（_safe_fs）把空格也换成下划线，手工的 chain_dir 保留空格
    —— 含空格的片名会落进两个目录，只按一种口径查就漏判，两种都查。

    改过名的工程还要多查一个名字：中枢目录是**改名之前**建的，按现在的片名
    根本找不到（方案 G 之后目录不跟着改名）。索引里存着的目录名就是当年建
    目录时的片名，拿它补一次 —— 否则改名会让 assert_no_producer_project
    失效：中枢工程一改名，手工导演台就认不出它、直接打开覆盖中枢的数据。
    """
    raw = str(name or "").strip()
    if not raw:
        return None
    try:
        inp = folder_paths.get_input_directory()
    except Exception:
        return None
    cands = [raw]
    try:
        dn = store.dir_name_of(raw)
    except Exception:
        dn = ""
    if dn and dn != raw:
        cands.append(dn)
    for raw_i in cands:
        safe_u = re.sub(r'[\\/:*?"<>|\s]+', "_", raw_i).strip("_")
        manual = "".join(c for c in raw_i if c not in '\\/:*?"<>|').strip()
        for safe in (safe_u, manual):
            if safe:
                p = os.path.join(inp, "_producer", safe, "pkg.json")
                if os.path.isfile(p):
                    return p
    return None


def assert_no_producer_project(name):
    """手工侧互斥（与中枢 assert_no_manual_project 对称）：该片名已是制片中枢
    工程就就地报错，不让手工导演台去覆盖它。

    两套体系共用 output/h3_chain/<片名>/ 段落档案。用手工导演台打开一个中枢
    工程，会把中枢跑出来的成片 / 续拍档 / 段档案当成自己的写坏，事后极难察觉。
    """
    p = producer_pkg_path(name)
    if not p:
        return True
    rel = p
    try:
        rel = os.path.relpath(p, folder_paths.get_input_directory())
    except Exception:
        pass
    raise ValueError(
        "「%s」已是制片中枢工程（%s 存在）。\n"
        "两套体系共用 output/h3_chain/ 段落档案，用手工导演台继续跑会覆盖中枢的"
        "成片 / 续拍档 / 段档案。\n"
        "  · 想用手工导演台：换一个没用过的片名\n"
        "  · 想继续用中枢：回到中枢工作流继续" % (name, rel))


# 中枢运行锁（4-C）：N3 一次性把 N 段 POST 进队列，队列执行期间若有同片名的
# 手工图插进来，chain.order 的追加顺序就被打乱 —— 认档靠 order 顺序，插队即
# 整体错位。锁落在两套共用的 output/h3_chain/<片名>/ 里，手工段登记前查它。
_PRODUCER_LOCK_FN = "_producer_run.lock"
_PRODUCER_LOCK_TTL = 6 * 3600   # 6 小时；过期视为失效（一次中枢跑不完 6h）


def producer_lock_path(name):
    return os.path.join(chain_dir(name), _PRODUCER_LOCK_FN)


def set_producer_lock(name, run_id=""):
    os.makedirs(chain_dir(name), exist_ok=True)
    _write_json(producer_lock_path(name),
                {"run_id": str(run_id), "updated": time.time()})


def clear_producer_lock(name):
    try:
        os.remove(producer_lock_path(name))
    except Exception:
        pass


def producer_lock_active(name):
    j = _read_json(producer_lock_path(name), None)
    if not j:
        return False
    try:
        if time.time() - float(j.get("updated") or 0) > _PRODUCER_LOCK_TTL:
            return False
    except Exception:
        return False
    return True


def assert_manual_allowed(name):
    """手工段登记前检查：片名正在中枢运行就拒绝。"""
    if producer_lock_active(name):
        raise ValueError(
            "「%s」正在制片中枢运行（%s 存在且未过期）。\n"
            "此时用手工导演台跑同片名段会插进队列，把段落顺序（chain.order）"
            "冲乱，导致后续各段接错上一段。\n"
            "  · 等中枢跑完、清空队列后再来\n"
            "  · 确认中枢已结束后，删除该锁文件即可强制解锁"
            % (name, _PRODUCER_LOCK_FN))
    return True


# JSON 读缓存（20261012 联动提速）：时间轴每 1~2 秒轮询一次 summary，
# 一次 film_summary 要读 1 + N 个 json、stat 3N+ 次，全部是同步阻塞 IO。
# 按 (path, mtime, size) 缓存解析结果，文件没变就是一次字典查找；写后主动失效。
_json_memo = {}
_json_memo_lock = threading.Lock()

# 档案写入版本号（1-B）：任何 save_chain / save_clip 落盘都 +1。film_summary
# 用它做短 TTL 结果缓存的失效键 —— 文件 mtime 只能反映「JSON 工程」的变化，
# DB 工程（project.db）写 clip 不动 chain.json 的 mtime，单靠 mtime 会漏判；
# 版本号对两种后端统一、且零额外 stat。
_archive_version = 0
_archive_version_lock = threading.Lock()


def _bump_archive():
    global _archive_version
    with _archive_version_lock:
        _archive_version += 1


def _archive_version_now():
    with _archive_version_lock:
        return _archive_version


# film_summary 的短 TTL 结果缓存（1-B）：{片名: (写入时刻, 档案版本号, 结果)}。
# 0.8s 是文件头注释里早就写明的压频口径，现在补上实现。
_film_memo = {}
_film_memo_lock = threading.Lock()
_FILM_SUMMARY_TTL = 0.8


def _read_json(path, default):
    try:
        st = os.stat(path)
    except Exception:
        return default
    key = os.path.normcase(os.path.abspath(path))
    sig = (st.st_mtime, st.st_size)
    with _json_memo_lock:
        hit = _json_memo.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return default
    with _json_memo_lock:
        _json_memo[key] = (sig, data)
    return data


def _invalidate_json(path):
    """写盘后让读缓存失效（_write_json 已自动调用，外部直写时可补调）。"""
    key = os.path.normcase(os.path.abspath(path))
    with _json_memo_lock:
        _json_memo.pop(key, None)


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    _invalidate_json(path)


def load_chain(name):
    d = chain_dir(name)
    if store.has_db(d):
        # DB 工程：权威在库，库读不出来就是默认空账，绝不回退翻 JSON
        doc = store.load_chain_doc(d, name)
        if doc is not None:
            return doc
    return _read_json(os.path.join(d, "chain.json"), None) or {
        "name": name, "fps": 24, "trim_frames": DEFAULT_TRIM,
        "prompt_global": "", "current": None, "locked": False, "order": []
    }


@chainlocked
def save_chain(name, data):
    d = chain_dir(name)
    # 首次写定型：全新工程（db/json 都没有）自动建库；老工程（chain.json 在）
    # ensure_db 返回 'json'，继续写 JSON，互不干扰。
    if store.ensure_db(d) == "db":
        store.save_chain_doc(d, name, data)
    else:
        _write_json(os.path.join(d, "chain.json"), data)
    _bump_archive()


def clip_json(name, cid):
    return os.path.join(chain_dir(name), "%s.json" % cid)


def clip_film(name, cid, take=1, stage=None, variant=None):
    """这一段第 take 版、第 stage 阶段、第 variant 变体的成片路径。

    成片必须和潜空间档案待在一起：一个片子的东西散落在 output 根目录，用户
    清目录时不知道哪个 mp4 属于哪一段哪个版本，备份/迁移也无从下手。放进来
    之后，拷走 h3_chain/<片名>/ 这一个文件夹就是完整工程。

    20261111 阶段 C（Q5=A / Q7=C）：成片按阶段分流，s1/s2 不再互盖。命名与
    clip_cont 同口径 —— s1 沿用旧名零迁移；s2 二采原片 .s2.mp4；s2 三采成品
    .s2.final.mp4。新参数一律追加在末尾，老调用零改动。
    """
    stem = cid if take <= 1 else "%s.t%d" % (cid, take)
    s = str(stage or "").strip().lower()
    v = str(variant or "").strip().lower()
    if s != "s2":
        suffix = ""
    elif v == "final":
        suffix = ".s2.final"
    else:
        suffix = ".s2"
    return os.path.join(chain_dir(name), "%s%s.mp4" % (stem, suffix))


def current_stage(name, default="s1"):
    """整片级「时间轴当前选中阶段」的唯一读取口（s1 一采 / s2 二采）。

    阶段必须是整片级全局状态：s1 画布 576×320、s2 画布 864×480，
    _whole_film_latent() 对段画布不一致会直接中止拼接，逐段混搭必然接不上。
    20261111 阶段 2 起导演台「一采/二采」按钮写 set_stage() → chain.stage；
    所有读者（段落调取 / 整片潜空间拼接 / 承接窗口 / 钉帧 / 收片）一律调本函数，
    没有任何第二处判阶段的地方，也就不会出现「存的是 s2、拼的是 s1」。
    """
    try:
        s = str((load_chain(name) or {}).get("stage") or "").strip().lower()
    except Exception:
        s = ""
    return s if s in ("s1", "s2") else default


# 20261111 用户纠正：切「二采」就该用二采成片，三采成品只是另一份可选。
# 默认必须是 raw；之前把 final 当默认是设计错误，不是参数没调好。
FILM_VARIANTS = ("raw", "final")
FILM_VARIANT_LABEL = {"raw": "二采成片", "final": "三采最终成品"}


def current_variant(name, default="raw"):
    """整片级「成片变体」的唯一读取口（raw 二采成片 / final 三采成品）。"""
    try:
        v = str((load_chain(name) or {}).get("film_variant") or "").strip().lower()
    except Exception:
        v = ""
    return v if v in FILM_VARIANTS else default


def _film_key(stage, variant):
    """收片登记 films 字典的键：s1 / s2:raw / s2:final。"""
    if str(stage or "").strip().lower() != "s2":
        return "s1"
    return ("s2:final" if str(variant or "raw").strip().lower() == "final"
            else "s2:raw")


def film_pick(name, cid, take=1, stage=None, variant=None, meta=None, fallback=None):
    """时间轴 / 导出 / 整片口该用哪一份成片 —— 所有读侧的唯一裁决口。

    真值是 take_params[take].films（收片时登记）。老档案没登记时原样回退到
    fallback（一般就是 clip["film"]），升级不会让时间轴突然空白。s2 请求的
    变体缺档时回退到该阶段另一份，避免「切了二采却一片空白」。
    """
    s = str(stage or current_stage(name)).strip().lower()
    v = str(variant or current_variant(name)).strip().lower()
    if meta is None:
        meta = load_clip(name, cid) or {}
    tp = (meta.get("take_params") or {}).get(str(max(1, int(take or 1)))) or {}
    films = tp.get("films") or {}
    key = _film_key(s, v)
    path = str(films.get(key) or "")
    if path and os.path.isfile(path):
        return path
    if s == "s2":
        other = "s2:raw" if key == "s2:final" else "s2:final"
        path = str(films.get(other) or "")
        if path and os.path.isfile(path):
            return path
        cand = clip_film(name, cid, take, "s2", v)
        if os.path.isfile(cand):
            return cand
    return fallback or clip_film(name, cid, take)


@chainlocked
def set_film_variant(name, variant):
    """写「整片级成片变体」—— final 三采成品 / raw 二采原片，唯一写入口。"""
    v = str(variant or "").strip().lower()
    if v not in FILM_VARIANTS:
        raise ValueError(
            "成片变体只能是「三采最终成品」(final) 或「二采原片」(raw)，收到：%r"
            % variant)
    doc = load_chain(name)
    doc["film_variant"] = v
    save_chain(name, doc)
    with _film_memo_lock:
        _film_memo.pop(str(name), None)
    # 与 set_stage 同一条写后读回护栏：DB 白名单漏登记会静默丢键（阶段 2 真机坑）。
    if current_variant(name, default="") != v:
        raise RuntimeError(
            "成片变体没写进档案（写后读回不一致）：期望 %s，实际 %r。"
            "多半是档案存储层的片级字段白名单漏登记 film_variant 键。"
            % (v, current_variant(name, default="")))
    stage = current_stage(name)
    tip = ("二采导出将用「%s」。" % FILM_VARIANT_LABEL[v]) if stage == "s2" else (
        "已选「%s」。当前时间轴还是「一采」(s1)，一采只有一份成片，"
        "切到「二采」后才会生效。" % FILM_VARIANT_LABEL[v])
    return {"variant": v, "label": FILM_VARIANT_LABEL[v],
            "stage": stage, "提示": tip}


@chainlocked
def set_stage(name, stage):
    """写「时间轴当前选中阶段」——整片级全局开关，唯一写入口。

    阶段必须是整片级：s1 576×320 / s2 864×480，_whole_film_latent() 对段画布
    不一致会直接中止拼接，逐段混搭必然接不上。

    Q8=A：只写 chain.stage 并给中文提示，**不自动改写 Cast 面板宽高**；
    canvas 是档案里已记录的当前版画布（take_params.*.w/h，历史事实），
    只读出来给用户核对，绝不因切阶段篡改它。
    """
    s = str(stage or "").strip().lower()
    if s not in ("s1", "s2"):
        raise ValueError("阶段只能是「一采」(s1) 或「二采」(s2)，收到：%r" % stage)
    doc = load_chain(name)
    doc["stage"] = s
    save_chain(name, doc)
    # 写后读回：DB 工程的片级字段走 csglide_store._CHAIN_KEYS 白名单，将来
    # 再加片级字段漏登记时写盘会静默丢键，前端却已经显示「已切到二采」——
    # 这种「假成功」最难查。这里直接拦下并点名，绝不让档案与按钮分叉。
    if current_stage(name, default="") != s:
        raise RuntimeError(
            "阶段没写进档案（写后读回不一致）：期望 %s，实际 %r。"
            "多半是档案存储层的片级字段白名单漏登记 stage 键。"
            % (s, current_stage(name, default="")))
    # film_summary 有 0.8s 结果缓存：不清的话切完阶段时间轴还显示旧阶段，
    # 「点了没反应」和真故障分不清。这里主动让它下一轮重算。
    with _film_memo_lock:
        _film_memo.pop(str(name), None)
    canvas = {"w": 0, "h": 0}
    cid = str(doc.get("current") or "").strip()
    if cid:
        meta = load_clip(name, cid) or {}
        tp = (meta.get("take_params") or {}).get(
            str(max(1, int(meta.get("current_take") or 1)))) or {}
        canvas = {"w": int(tp.get("w") or 0), "h": int(tp.get("h") or 0)}
    label = "一采" if s == "s1" else "二采"
    tip = "已切到「%s」。" % label
    if canvas["w"] and canvas["h"]:
        tip += "档案记录的当前画布 %d×%d；" % (canvas["w"], canvas["h"])
    tip += "按你的设置，Cast 面板宽高不会自动改动，请自行确认二采画布。"
    if s == "s2":
        tip += ("二采成片分两份存（二采原片 .s2.mp4 / 三采成品 .s2.final.mp4），"
                "当前导出用「%s」。" % FILM_VARIANT_LABEL[current_variant(name)])
    return {"stage": s, "label": label, "canvas": canvas, "提示": tip}


def clip_cont(name, cid, take=1, stage=None):
    """这一段第 take 版、第 stage 阶段的 AV latent 唯一真值。

    s1 沿用 20261104 起的旧文件名：承接窗口、整片潜空间、has_latent 等所有
    既有读者一律调 clip_cont(name, cid, take) 不传 stage，零改动、不迁移。
    s2 是同一 take 下的第二份加工档（一采/二采同版，不是两个版本）。
    写入方只有一个：🎬 H3 VAE 快速解码 → banzhang_h3mc_archive。

    与成片同目录、同命名口径：拷走 h3_chain/<片名>/ 就是完整工程。
    """
    stem = cid if take <= 1 else "%s.t%d" % (cid, take)
    if stage in (None, "", "s1"):
        fn = "%s.cont.safetensors" % stem
    else:
        fn = "%s.%s.cont.safetensors" % (stem, stage)
    return os.path.join(chain_dir(name), fn)


def clip_cont_resolve(name, cid, stage=None):
    """按阶段认这一段**实际写盘**的承接档；找不到返回 None。

    为什么不能只拼 clip_cont(current_take, stage)：一采(s1)与二采(s2)曾是两次
    独立 Queue，旧写法各开一个 take，s1 落 take1、s2 落 take2；cont_saved 与
    续接查找都按 current_take 拼路径，指向的是从没写过的文件。这里改成认档案
    take_params 里真正记了 stages[stage] 且文件在盘上的那一版，从当前 take 往回
    找最近的一版，都没有再退回按段号拼的路径。只读这一段自己的档案，绝不按
    目录 mtime 猜档（那会接到别的段 / 别的片）。
    """
    if stage in (None, ""):
        stage = current_stage(name)
    meta = load_clip(name, cid) or {}
    tp = meta.get("take_params") or {}
    cur = int(meta.get("current_take") or 1)
    takes = sorted({int(t) for t in tp if str(t).isdigit()}, reverse=True)
    for t in takes:
        if t > cur:
            continue
        p = str(((tp.get(str(t)) or {}).get("stages") or {}).get(stage) or "")
        if p and os.path.isfile(p):
            return p
    exact = clip_cont(name, cid, cur, stage)
    return exact if exact and os.path.isfile(exact) else None


# ---------------- 中央生成回执：按本次 prompt 拓扑认片 ----------------

_VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}


def _is_video_filename(fn):
    return os.path.splitext(str(fn or "").split("?")[0])[1].lower() in _VIDEO_EXTS


def _server_history_entry(prompt_id):
    """从 ComfyUI 自己的 prompt queue 取服务端历史，不以前端扫描结果为准。"""
    from server import PromptServer
    ps = getattr(PromptServer, "instance", None)
    if ps is None or not hasattr(ps, "prompt_queue"):
        return None
    history = ps.prompt_queue.get_history(prompt_id=str(prompt_id)) or {}
    return history.get(str(prompt_id))


def _history_graph(entry):
    """从历史 prompt 元组中取出 graph：{node_id: {class_type, inputs}}。"""
    raw = (entry or {}).get("prompt")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (list, tuple)):
        for item in raw:
            if (isinstance(item, dict) and item and all(
                    isinstance(v, dict) and "class_type" in v
                    for v in item.values())):
                return item
    return {}


def _graph_children(graph):
    """构造 source -> downstream edges；连接值格式为 [source_node, output_index]。"""
    children = {str(nid): [] for nid in (graph or {})}
    for nid, spec in (graph or {}).items():
        for input_name, value in (spec.get("inputs") or {}).items():
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                continue
            try:
                src = str(value[0])
                src_out = int(value[1])
            except (TypeError, ValueError):
                continue
            if src in children:
                children[src].append({
                    "dst": str(nid), "input": input_name, "out": src_out,
                })
    return children


def _reachable(children, start, start_out=None):
    """从 start 可达的节点及最大图深度；start_out 限定只从某输出口出发。"""
    start = str(start)
    seen = {start: 0}
    stack = [(start, 0)]
    while stack:
        nid, depth = stack.pop()
        for edge in children.get(nid, []):
            if nid == start and start_out is not None and \
                    int(edge.get("out", -1)) != int(start_out):
                continue
            dst = str(edge["dst"])
            nd = depth + 1
            if nd > seen.get(dst, -1):
                seen[dst] = nd
                stack.append((dst, nd))
    return seen


def _history_video_outputs(entry):
    """列出本次服务端历史中的全部视频输出。"""
    out_list = []
    outputs = (entry or {}).get("outputs") or {}
    for nid, bag in outputs.items():
        for slot_name, arr in (bag or {}).items():
            if not isinstance(arr, list):
                continue
            for idx, item in enumerate(arr):
                if not isinstance(item, dict):
                    continue
                fn = item.get("filename") or item.get("master") or ""
                if not _is_video_filename(fn):
                    continue
                out_list.append({
                    "node": str(nid),
                    "slot": slot_name,
                    "index": idx,
                    "filename": fn,
                    "subfolder": item.get("subfolder") or "",
                    "type": item.get("type") or "",
                    "item": item,
                })
    return out_list


def _archive_enabled(spec):
    """存档节点的「启用存档」开关是否打开。老工作流没有这个控件 = 视为开。"""
    val = ((spec or {}).get("inputs") or {}).get("archive_enabled", True)
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() not in ("", "0", "false")


# 续接存档节点的两个类名：BanZhang_H3_ClipArchive 是避开同名冲突后的新入口。
_BZ_ARCH_TYPES = ("MiniMaxH3MotionContextSaveLatent", "BanZhang_H3_ClipArchive")


def classify_run_media(entry):
    """按本次 prompt 拓扑，把视频分为分段片与整片，不使用节点白名单。

    分段片：从「💾 H3 续拍存档」节点向下游**最近的一层 VAE 解码节点**可达的视频
    输出，取最靠近解码的那个合并节点（存档与解码之间允许串「系统净化」等透传
    节点）。整片：从「🎞️ H3 导演台」的「整片」输出口（第 8 口，index=7）向下游
    可达。
    """
    graph = _history_graph(entry)
    children = _graph_children(graph)
    videos = _history_video_outputs(entry)

    # 20261111 阶段 1：💾 续拍存档已并入 🎬 H3 VAE 快速解码，画布不再有存档节点。
    # 认片锚点因此从「唯一开着的存档」换成「解码节点本身」：每个解码节点自己
    # 就是这一采的分段片起点，不必再从存档往下找直连解码。
    # 本函数已是历史入口（正式收片走 collect_run 的声明式裁决），保留它是为了
    # 排查时还能按拓扑列出候选；口径必须与新结构一致，不能留旧假设。
    cast_nodes = [str(nid) for nid, spec in graph.items()
                  if spec.get("class_type") == "CSGlideCastCS"]

    whole_reach = {}
    for cast in cast_nodes:
        for nid, depth in _reachable(children, cast, 7).items():
            if depth > whole_reach.get(nid, -1):
                whole_reach[nid] = depth

    DECODE_TYPES = ("VAEDecode", "VAEDecodeAudio", "VAEDecodeTiled",
                    "BanZhang_H3VAEDecodeFast")
    save_nodes = [str(nid) for nid, spec in graph.items()
                  if str(spec.get("class_type") or "") in DECODE_TYPES]
    save_nodes_all = list(save_nodes)
    direct_decodes = list(save_nodes)

    # 从这些解码向下找视频产出：中途串什么都不影响，只要终点是合并节点。
    decode_reach = {}
    for dec in direct_decodes:
        for nid, depth in _reachable(children, dec).items():
            if depth > decode_reach.get(nid, -1):
                decode_reach[nid] = depth

    segment_candidates, whole_candidates = [], []
    for video in videos:
        if video["node"] in whole_reach:
            video["depth"] = whole_reach[video["node"]]
            whole_candidates.append(video)
        elif video["node"] in decode_reach:
            video["depth"] = decode_reach[video["node"]]
            segment_candidates.append(video)

    def _deepest(candidates):
        if not candidates:
            return None, []
        max_depth = max(int(v.get("depth") or 0) for v in candidates)
        deepest = [v for v in candidates if int(v.get("depth") or 0) == max_depth]
        return (deepest[0] if len(deepest) == 1 else None), deepest

    def _shallowest(candidates):
        """取最靠近锚点的那一支。候选已收窄到「存档直连解码的下游」，这里只在
        **多个合并节点吃同一份解码输出**时定主次：直接吃解码输出的是正片，更
        下游的（插帧 / 再合并）是衍生片。深度并列仍然拒绝盲收。"""
        if not candidates:
            return None, []
        min_depth = min(int(v.get("depth") or 0) for v in candidates)
        shallowest = [v for v in candidates if int(v.get("depth") or 0) == min_depth]
        return (shallowest[0] if len(shallowest) == 1 else None), shallowest

    segment_film, segment_finals = _shallowest(segment_candidates)
    whole_film, whole_finals = _deepest(whole_candidates)
    seg_err = ""
    if not direct_decodes:
        seg_err = (
            "本次提交的画布上没有 VAE 解码节点"
            "（VAEDecode / VAEDecodeAudio / VAEDecodeTiled / H3 VAE 快速解码）—— "
            "续拍存档与分段片认片现在都由「🎬 H3 VAE 快速解码」承担。"
            "请在采样输出后接上它，再接视频合并节点。")
    return {
        "graph": graph,
        "save_nodes": save_nodes,
        "save_nodes_all": save_nodes_all,
        "cast_nodes": cast_nodes,
        "segment_candidates": segment_candidates,
        "whole_candidates": whole_candidates,
        "segment_film": segment_film,
        "segment_finals": segment_finals,
        "segment_error": seg_err,
        "whole_film": whole_film,
        "whole_finals": whole_finals,
    }


def _output_path_from_descriptor(desc):
    """还原产物在磁盘上的真实路径。

    节点回报里可能带着真实落盘位置：视频合并节点的「📂 自定义保存路径」生效时，
    成片只写在自定义目录、output 里**没有副本**（见 banzhang_video_tools 的注释）。
    这时若仍按 output 目录硬拼，得到的是一个不存在的文件名——收片判「找不到分段
    视频源文件」，多段循环就此中断；更糟的是 output 里若躺着同名旧片，会**静默
    收错片**（收到上一次的画面还不报错）。故优先认节点自己报的真实路径，确认在
    磁盘上才用；都没有再回落原来的 output 拼接（默认路径下两者等价）。
    """
    item = desc.get("item") or desc
    for key in ("abs_path", "src_path"):
        p = str(item.get(key) or "").strip()
        if p and os.path.isfile(p):
            return p
    return os.path.join(_out_dir(), desc.get("subfolder") or "",
                        os.path.basename(desc["filename"]))


def load_clip(name, cid):
    d = chain_dir(name)
    if store.has_db(d):
        # DB 工程库里没有这段 = 真没有（同 JSON 工程里 json 文件缺失返回 None）
        return store.load_clip_doc(d, str(cid))
    return _read_json(clip_json(name, cid), None)


@chainlocked
def reorder_clips(name, order, cur_cid=None):
    """按给定的段落 id 顺序重排 chain.order（时间轴拖动排序用）。

    规则与理由：
      · **只认识档案里已有的 id**，且忽略重复 —— 前端可能把整条轴的顺序发过来，
        其中混着只存在于工程、还没登记的段（它们没有 id），发什么都不能凭空造段。
      · 名单里没提到的段**不丢**，按原相对顺序跟在后面。宁可少排一段，不可吞段：
        chain.order 是时间轴与成片链的唯一依据，静默丢掉一段等于凭空删了一整段画面。
      · 返回新的完整顺序，前端据此回显（而不是自己猜）。
    """
    chain = load_chain(name)
    cur = [c for c in (chain.get("order") or []) if c]
    have = set(cur)
    seen = set()
    head = []
    for c in (order or []):
        c = str(c)
        if c in have and c not in seen:
            seen.add(c)
            head.append(c)
    tail = [c for c in cur if c not in seen]
    chain["order"] = head + tail
    save_chain(name, chain)
    # 重排是"整片"动作，被拖动的那一段后端推不出来（前端只发新顺序）。记上
    # 前端传来的当前段（cur_cid），事后至少知道这次改序发生在编辑哪一段时。
    store.log_event(chain_dir(name), "reorder", str(cur_cid) if cur_cid else None,
                    {"order": chain["order"]}, "monitor")
    ws_broadcast("reordered", name)
    return {"order": chain["order"], "moved": len(head), "kept": len(tail)}


@chainlocked
def save_clip(name, cid, meta):
    meta = dict(meta)
    meta["updated"] = time.time()
    d = chain_dir(name)
    if store.ensure_db(d) == "db":
        store.save_clip_doc(d, cid, meta)
    else:
        _write_json(clip_json(name, cid), meta)
    _bump_archive()


def _dedup_order(order, name=None):
    """去掉 order 里的重复段 id，保序、保首个。

    旧版 next_cid 按 len(order)+1 发号：删过一段之后长度缩回去，下一次
    「接一段」就会发出一个**仍然存在**的 id —— 新段 json 直接覆盖旧段，
    order 里出现重复 id。此后删段只能删掉第一个同 id 项，另一个成了永远
    删不掉的幽灵段：时间轴与「全片时长」被它撑得永远比实际长（工程里删到
    只剩一段，底栏还是 6 段的总时长）。除了修发号源头，每次写 order 时
    顺手清一遍历史遗留的重复项，老档案自愈。

    传了 name 再多修一类：段落 json 已经不在的 id（覆盖/手删留下的空壳）
    直接摘掉 —— 留着只会让时间轴多画一段「档案读不出来」的空壳引人误会。
    """
    seen, out = set(), []
    for c in (order or []):
        if not c or c in seen:
            continue
        if name is not None and load_clip(name, c) is None:
            continue
        seen.add(c)
        out.append(c)
    return out


def next_cid(name):
    """发一个**没被占用**的段落 id。

    占用 = 出现在 order 里，或磁盘上已有同号段落 json（order 修不到的残留）。
    绝不发会覆盖已有段的号 —— 那正是「删一段再接一段，另一段凭空消失、
    底栏总时长再也降不回去」的根因。
    """
    chain = load_chain(name)
    taken = set(c for c in (chain.get("order") or []) if c)
    try:
        for fn in os.listdir(chain_dir(name)):
            if fn.startswith("clip_") and fn.endswith(".json"):
                taken.add(fn[:-5])
    except Exception:
        pass
    n = len(taken) + 1
    while ("clip_%04d" % n) in taken:
        n += 1
    return "clip_%04d" % n


@chainlocked
def add_clip(name, **fields):
    """新增一段，返回段落 id。fields 覆盖默认值。

    同一分段 uid（meta.shot）只允许有一段：工程被还原/重载后 clip id 丢了
    再登记，不能又在档案里堆一段 —— 那是「档案越堆越长、删都删不干净」的
    另一半根因。命中已有段就补齐其余字段后原样返回它的 id。
    """
    chain = load_chain(name)
    shot_uid = str(fields.get("shot") or "")
    if shot_uid:
        for c in _dedup_order(chain.get("order")):
            if str((load_clip(name, c) or {}).get("shot") or "") == shot_uid:
                patch = dict((k, v) for k, v in fields.items() if k != "shot")
                if patch:
                    update_clip(name, c, patch)
                return c
    cid = next_cid(name)
    meta = {
        "id": cid, "index": len(chain["order"]) + 1,
        "frames": 149, "fps": chain.get("fps", 24),
        # order 空 = 这是全片第一段，不承接任何段 → trim=0。
        # 非首段也默认 0（20261029）：承接是用户明确要的动作，段一建出来就记 39
        # 帧承接账，会让"没接过的段"被当成接过 —— 成片剪头、时间轴净长全错。
        # 真要接，生成时按实际承接帧数由 _register_clip 回填。
        "trim_frames": 0,
        "prompt_seg": "", "refs": [],
        "seed": 0, "steps": 4, "cfg": 1.0,
        "takes": [], "current_take": 0,
        "seam_left": None, "seam_right": None,
        "tail_lock": True, "pending": None, "has_latent": True,
        # 锁定 = 钉住编辑目标（见 set_locked），不是"这段不许改"
        "locked": False,
        # 成片：第 k 段的 film = 生成完第 k 段之后的**累积**成片。
        # 播放头拖到第 k 段就播这一版 —— 和剪辑软件里「看到第 k 个镜头为止」
        # 的直觉一致。Join 每次写出成片都会把它登记到当前段。
        "film": None, "film_frames": 0, "film_seam": None,
        # 契约（20261010ba）：这条成片**开头有几帧是承接/旧内容**。
        # 本段新画面 = [film_head, film_head + 净长)。落盘时算一次并写死，
        # 下游一律读它 —— 不再各处猜「这条是累积片还是单段片」。
        # None = 老档案没记（film_summary 会补一次，见 _migrate_film_head）。
        "film_head": None,
        # 承接窗口（20261010bb · 方案 B 的地基）：这一段**生成时钉住了谁的
        # 哪一段画面**。四种接法全是它的配置，不是四套代码：
        #   · 往后接 extend：一条 at="head"（钉住上一段尾部）
        #   · 往前接 prepend：一条 at="tail"（钉住后一段头部）
        #   · 补桥 bridge：head + tail 两条（两个父），中间留噪声让模型填
        #   · 循环 loop：head 钉最后一段尾、tail 钉第一段头
        # 生成侧照它拼输入，输出只取没被钉住的那一截 —— 于是四种接法共用
        # 一条链路。空列表 = 还没接过（独立生成的首段）。
        "pins": [],
        # 承接窗口钉在**尾部**时（往前接 / 补桥 / 循环），交付的片子末尾那
        # 几帧是后一段开头的重绘，进成片前要剪掉，否则与后一段重复。
        # 0 = 尾部没钉（往后接 / 独立首段）—— 与 trim_frames 对称，只是反方向。
        "trim_tail": 0,
    }
    meta.update(fields)
    # 这里**不**吸附帧数：档案要记的是导演台真实跑出来的帧数，改它就是篡改
    # 记录（潜空间是 149 帧，档案却写 141，后面按档案裁就裁错了）。
    # 吸附只在 resize_clip 里做 —— 那是用户主动选时长，必须给他一个合法的。
    save_clip(name, cid, meta)
    chain["order"] = _dedup_order(chain.get("order"), name) + [cid]
    chain["current"] = cid
    save_chain(name, chain)
    store.log_event(chain_dir(name), "clip_add", cid,
                    {"frames": meta.get("frames"), "shot": shot_uid}, "backend")
    ws_broadcast("clip_added", name, cid)
    return cid


@chainlocked
def update_clip(name, cid, patch):
    meta = load_clip(name, cid)
    if meta is None:
        return None
    meta.update(patch or {})
    save_clip(name, cid, meta)
    ws_broadcast("clip_updated", name, cid)
    return meta


def _empty_rack_snapshot():
    return {"slots": {"images": [], "videos": [], "audios": []},
            "fps": 0, "audio_out": 0}


@chainlocked
def bind_segment(name, payload):
    """新增/插入/复制段的中央绑定：一次登记 clip + state + rack + desk。

    这是“段创建回执”，与 run_receipts 的“段执行回执”分工不同：
      run_receipts 回答“这次 prompt 产出了什么”；
      segment_bindings 回答“这个 cid 绑定了哪一个 shot_uid、导演台状态、
      媒体架槽位和文案台段词”。
    """
    payload = dict(payload or {})
    d = chain_dir(name)
    if store.backend(d) != "db":
        raise RuntimeError("老工程（JSON 档案）不支持中央段绑定")

    action = str(payload.get("action") or "append")
    if action not in ("insert_after", "duplicate", "append"):
        action = "append"
    shot_uid = str(payload.get("shot") or "")
    if not shot_uid:
        raise ValueError("缺少 shot")
    source_cid = str(payload.get("source_cid") or "")
    state = json.loads(json.dumps(payload.get("state") or {}))
    rack = json.loads(json.dumps(payload.get("rack") or {}))
    desk_text = str(payload.get("desk_text") or "")
    clip_name = str(payload.get("clip_name") or "").strip()[:60]

    chain = load_chain(name)
    for cid in _dedup_order(chain.get("order"), name):
        clip = load_clip(name, cid)
        if clip and str(clip.get("shot") or "") == shot_uid:
            binding = store.load_segment_binding(d, cid)
            if binding:
                return {"id": cid, "index": chain.get("order").index(cid) + 1,
                        "order": chain.get("order"), "binding": binding,
                        "reused": True}

    frames = payload.get("frames") or state.get("length") or 149
    trim_frames = payload.get("trim_frames")
    if trim_frames is None:
        # 段刚登记时还没生成过，没有任何承接头 —— trim 只能是 0。
        # 旧逻辑拿续写窗口（默认 39）顶替，凭空给每段记了 39 帧承接账：
        # 之后即使这一段是独立生成的，成片拼接也照旧剪掉开头 39 帧正常内容
        # （20261029 定性：用户看到「开头少一截 / 明明没续接却在承接」）。
        trim_frames = 0
    cid = add_clip(name, frames=int(frames), shot=shot_uid,
                   trim_frames=int(trim_frames or 0))
    if clip_name:
        update_clip(name, cid, {"name": clip_name})

    state.setdefault("chain", {})
    state["chain"]["name"] = name
    state["chain"]["clip"] = cid
    state["chain"]["shot"] = shot_uid
    # 空值不覆盖：add_clip 撞同 shot_uid 时会返回**已有** cid（重复登记），
    # 此时 desk_text 常为空（只有 duplicate 才带词），直接写会把这一段已经
    # 写好的提示词静默清空（20261015「每段提示词全没了」的根因）。
    if desk_text:
        state["prompt"] = desk_text
    clip = load_clip(name, cid) or {}
    clip["state"] = state

    if action == "insert_after":
        rack_snap = _empty_rack_snapshot()
        if isinstance(rack, dict):
            rack_snap["fps"] = rack.get("fps") or 0
            rack_snap["audio_out"] = rack.get("audio_out") or 0
        # 显式清空，防止同 cid 下残留旧槽位（正常新建没有，这是防御式契约）。
        store.save_rack(d, cid, rack_snap)
    else:
        rack_snap = rack if isinstance(rack, dict) and rack.get("slots") else _empty_rack_snapshot()
        store.save_rack(d, cid, rack_snap)

    desk = store.load_desk(d) or {}
    if not isinstance(desk, dict):
        desk = {}
    desk.setdefault("chain", {})
    desk["chain"]["name"] = name
    desk["chain"]["clip"] = cid
    desk["chain"]["shot"] = shot_uid
    desk.setdefault("global", "")
    desk.setdefault("segs", {})
    # 同上：空段词只在这一段**还没有**记录时才写。重复登记（撞 uid 返回已有
    # cid）拿不到词也绝不能把库存的段词抹成空串 —— 那是用户真写过的东西。
    if desk_text or cid not in desk["segs"]:
        desk["segs"][cid] = desk_text
    store.save_desk(d, desk)

    old_order = _dedup_order((load_chain(name)).get("order"), name)
    desired = payload.get("order")
    if isinstance(desired, list) and desired:
        target_order = [str(x) for x in desired if str(x)]
    elif action == "insert_after" and source_cid in old_order:
        target_order = list(old_order)
        target_order.remove(cid)
        pos = target_order.index(source_cid) + 1
        target_order.insert(pos, cid)
    else:
        target_order = list(old_order)
    reorder_clips(name, target_order, cid)

    stored_rack = store.load_rack(d, cid) or rack_snap
    binding = {
        "cid": cid, "shot_uid": shot_uid, "action": action,
        "source_cid": source_cid, "state": state, "rack": stored_rack,
        "desk_text": desk_text, "status": "bound",
    }
    store.save_segment_binding(d, binding)
    final_chain = load_chain(name)
    final_order = _dedup_order(final_chain.get("order"), name)
    ws_broadcast("segment_bound", name, cid)
    return {"id": cid,
            "index": final_order.index(cid) + 1 if cid in final_order else len(final_order),
            "order": final_order,
            "binding": store.load_segment_binding(d, cid),
            "reused": False}


# 四档待办的**代价**完全不同，凡是列给用户看的地方都要说清是哪一档：
# trim / rejoin 只是重拼一次（秒级），grow / redo 要重新跑模型（分钟级）。
# 只写"待办"两个字，用户没法判断值不值得现在跑。
PENDING_TEXT = {
    "grow": "待加长（要重新生成）",
    "trim": "待裁剪（要重拼一次）",
    # 换过版本（swap takes）之后：后面各段的累积成片里还夹着旧版本，
    # 重拼一次就好 —— 不用重新采样。
    "rejoin": "待重拼（换过版本，成片还没跟上）",
    "redo": "待重抽（要重新生成）",
}


def set_pending(name, cid, kind):
    """kind: None / 'grow'（要加长）/ 'trim'（要裁剪）/ 'redo'（要重抽）"""
    return update_clip(name, cid, {"pending": kind})


# ---- 时长：网格与吸附 ----------------------------------------------------
# H3 只认 17k+5 这一段时长的格点（17 是它的时间压缩步长，+5 是首帧开销）。
# 不在格点上的帧数模型直接拒，所以时间轴上拖出来的数必须吸附回去——
# 吸附在**改时长这一刻**做，而不是等到出图时才报"帧数非法"。
# 20261106 v2 阶段 ④：格点 / 帧率常量只从 csglide_ledger 一处取，消灭第二套定义。
# 注意 snap_frames 是「四舍五入到最近格点」，与 ledger.align_frame_count 的
# 「向上吸附」语义不同 —— 算法保持原样，这里只统一常量值。
try:
    from .core import csglide_ledger as _ledger
except ImportError:
    try:
        from .core import csglide_ledger as _ledger
    except ImportError:
        _ledger = None
FRAME_GRID = getattr(_ledger, "FRAME_GRID", 17)
FRAME_BASE = getattr(_ledger, "FRAME_BASE", 5)
FRAME_FPS = getattr(_ledger, "FPS", 24)
MIN_CLIP_FRAMES = getattr(_ledger, "MIN_FRAMES", 5)
# 上限与导演台 LENGTH_PRESETS 的最大值对齐（719 ≈ 30s）。再长显存撑不住，
# 与其出到一半炸掉，不如在时间轴上就挡住。
MAX_CLIP_FRAMES = 719


def snap_frames(n, hi=None):
    """吸附到 17k+5，并夹进 [MIN, hi]。"""
    try:
        n = int(round(float(n)))
    except (TypeError, ValueError):
        n = MIN_CLIP_FRAMES
    top = int(hi or MAX_CLIP_FRAMES)
    n = max(MIN_CLIP_FRAMES, min(top, n))
    k = max(0, int(round((n - FRAME_BASE) / FRAME_GRID)))
    out = FRAME_BASE + FRAME_GRID * k
    # round 可能把结果顶出上限（例如 719 → 726），回退一格
    while out > top and k > 0:
        k -= 1
        out = FRAME_BASE + FRAME_GRID * k
    return max(MIN_CLIP_FRAMES, out)


def snap_frames_floor(n, hi=None):
    """**向下**吸附到 17k+5 —— 末段按剩余音频缩短专用，绝不向上加帧。

    snap_frames() 用的是 round：50 帧会被吸到 56，凭空多出 6 帧没有声音的
    画面，正是用户要去掉的那截「补静音凑满设定时长」。这里一律取 floor，
    保证新段长 ≤ 剩余音频能铺满的长度。
    """
    try:
        n = int(round(float(n)))
    except (TypeError, ValueError):
        n = MIN_CLIP_FRAMES
    top = int(hi or MAX_CLIP_FRAMES)
    n = max(MIN_CLIP_FRAMES, min(top, n))
    grid = max(1, int(FRAME_GRID))
    k = max(0, int((n - FRAME_BASE) // grid))
    out = FRAME_BASE + grid * k
    while out > top and k > 0:
        k -= 1
        out = FRAME_BASE + grid * k
    return max(MIN_CLIP_FRAMES, out)


def shrink_tail_to_audio(name, files=None):
    """导入音频后：末段音源不够时，**连画面段长一起**缩短到剩余音频实际时长。

    用户 20261111 选 B：末段不该补静音凑满 10 秒，画面也不该多出那截空帧。

    本函数**只改档案 frames**（走唯一写入口 _resize_one），不碰音频。调用方
    /banzhang/audio/auto_slice 紧接着在同一事务里跑一次 reslice_drivers，
    它读到的是新 clip_to —— 改档案与重切音频共用同一份段账，只切一次。

    历史红线（20261109 工程26 events，56↔243 反复覆盖 6 次）：音频轴当年只改
    档案、没改导演台面板 shot.state.length，渲染登记时后端拿面板旧值把档案写
    回去。所以本函数回传「按段序的真实新帧数」清单，前端**必须**拿它调
    syncShotFrames 写齐面板预设 —— 少这一步就是那次事故原样复现。

    只缩第一个「音源不够但还剩一点声音」的段，且只缩不拉。音源彻底耗尽
    （不足 0.05 秒）的段不动：它们本来就没有驱动，缩成 5 帧只会造出一串
    空壳段，交给模型自行出声更合理。
    """
    out = {"成功": True, "已缩短": 0, "帧数": [], "段序": [], "明细": []}
    try:
        from .core import banzhang_audio_cut as _audio
        files = [str(x).strip() for x in (files or []) if x]
        if not files:
            return out
        # 「剩余音频」以最长轨为准，与 reslice_drivers 的 max_src 同一口径。
        max_src = 0.0
        for rel in files:
            try:
                max_src = max(max_src, float(
                    _audio.probe(_audio._input_path(rel)).get("时长秒") or 0))
            except Exception:
                continue
        if max_src <= 0:
            return out
        fs = film_summary(name)
        rows = [r for r in (fs.get("clips") or [])
                if str(r.get("id") or "").startswith("clip_")]
        if not rows:
            return out
        fps = float(fs.get("fps") or FRAME_FPS) or FRAME_FPS
        total_src_frames = int(round(max_src * fps))
        for r in rows:
            cid = str(r.get("id") or "")
            cf = int(r.get("clip_from") or 0)
            ct0 = int(r.get("clip_to") or cf)
            old = int(r.get("frames") or 0)
            unlink = bool(r.get("head_unlink"))
            net = max(0, ct0 - cf)                  # film_summary 已按断链归零 trim
            overlap = max(0, old - net)             # 被扣掉的重叠帧
            # 20261111 方案 B：film_summary 对断链段把 trim **派生**归零，
            # clip_to 就是「净长 = frames」的终点；reslice_drivers 上一轮也
            # 删掉了 ct += trim。音频只铺 net，绝不再把 trim 补回切片终点 ——
            # 那会侵占下一段开头音频，正是「取消接续后头尾重复」的根因。
            # 断链段 overlap 恒为 0，反解不需要再为它单独扣一次 trim。
            span = max(0, ct0 - cf)                 # 本段音频实际要铺几帧
            avail = max(0, total_src_frames - cf)   # 段起点之后还剩几帧音频
            # 与 reslice_drivers 的「eff_secs >= 0.05 才给驱动」同一把尺子：
            # 不足 0.05 秒的段后端本来就不写驱动，缩它只会得到 5 帧空壳。
            if avail >= span or (avail / fps) < 0.05:
                continue
            # 反解目标总帧：new - overlap = avail
            want_total = avail + overlap
            new = snap_frames_floor(want_total)
            if new >= old or new < MIN_CLIP_FRAMES:
                continue
            res = _resize_one(name, cid, new)
            if not (res and res.get("changed")):
                continue
            out["已缩短"] += 1
            out["明细"].append({
                "段": cid, "原帧": old, "新帧": new,
                "原净长": net, "剩余音频帧": avail,
                "剩余音频秒": round(avail / fps, 3),
                "断链": unlink,
            })
            break
        if out["已缩短"]:
            # _resize_one 已 bump 档案版本，但同一请求里 reslice_drivers 还会读
            # film_summary；0.8s TTL 可能命中改前的旧 clip_to，主动失效一次。
            with _film_memo_lock:
                _film_memo.pop(str(name), None)
        # 回读真实段长给前端写面板，绝不把上面的估算直接递出去。
        fs2 = film_summary(name) if out["已缩短"] else fs
        _rows2 = [x for x in (fs2.get("clips") or [])
                  if str(x.get("id") or "").startswith("clip_")]
        # 与「帧数」同序的 cid 清单：取消续接的单一事务在导演台里没有
        # audio_lane 的 clipsOf()，拿它按 clip 直接写面板预设，不必再拉一次
        # film_summary，也不会因为段序变化串位。
        out["段序"] = [str(x.get("id") or "") for x in _rows2]
        out["帧数"] = [int(x.get("frames") or 0) for x in _rows2]
    except Exception as e:
        out["错误"] = str(e)
        print("[Banzhang] 末段画面按音频缩短失败：%s" % e)
    return out


def _resync_audio_drivers(name, files=None):
    """段长落盘后，按**当前段档案**重切全部驱动音频。

    bzsa.driver / bzsa.tracks 是 frames 的派生数据，不是可以独立维护的档案。
    统一由 banzhang_audio_cut.reslice_drivers 落盘：拖入音频、改每段秒数、
    时间轴拖动、段菜单、冲突消解，最后都走这一处。
    """
    try:
        from .core import csglide_store as _st
        from .core import banzhang_audio_cut as _audio
        d = chain_dir(name)
        if not _st.has_db(d):
            return {}
        conn = _st._connect(d, create=False)
        if conn is None:
            return {}
        if not files:
            tracks = _st._meta_get(conn, "bzsa.tracks", []) or []
            files = [str(t.get("文件") or "") for t in tracks
                     if isinstance(t, dict) and t.get("文件")]
        if not files:
            return {}
        return _audio.reslice_drivers(name, files) or {}
    except Exception as e:
        print("[Banzhang] 段长已改，但音频驱动重切失败：%s" % e)
        return {}


def resize_clip(name, cid, frames):
    """改一段的时长，并把它的派生数据一起同步（段长唯一写入口）。

    20261108 根因修复：frames 与音频切片以前是两条独立写入链路，时间轴拖动 /
    段菜单 / 冲突消解改完帧长就走人，切片还停在旧边界 —— 生成时声音流按新段长
    铺、驱动音频只有旧长度，尾部零 latent 被 VAEDecodeAudio 解成底噪。现在任何
    改段长的路径都在同一个写入口里重切一次，两者不可能再分开。
    """
    res = _resize_one(name, cid, frames)
    if res and res.get("changed"):
        _resync_audio_drivers(name)
    return res


def resize_many(name, items, files=None):
    """一次改多段帧长、只重切一次音频（排段专用，避免 N 段跑 N 次 ffmpeg）。

    files 由调用方传入：拖入新音轨时工程库里还没有这条轨，不能从 bzsa.tracks
    反查，否则重切会按旧轨清单把新轨漏掉。
    """
    out, changed = [], False
    for it in (items or []):
        if not isinstance(it, dict):
            continue
        cid = str(it.get("id") or "")
        try:
            fr = int(it.get("frames"))
        except (TypeError, ValueError):
            out.append({"clip": cid, "error": "frames 不是整数"})
            continue
        r = _resize_one(name, cid, fr)
        if r is None:
            out.append({"clip": cid, "error": "没有这一段"})
            continue
        out.append(r)
        changed = changed or bool(r.get("changed"))
    slice_res = _resync_audio_drivers(name, files) if (changed or files) else {}
    return {"结果": out, "已改": changed, "切片": slice_res}


def _resize_one(name, cid, frames):
    """改一段的时长 —— 真正决定「后面要不要重跑」的就是这个函数。

    加长：多出来的帧模型根本没画过，凭空变不出来，所以本段标 **grow**（要重
    生成）。但重生成时尾部 22 帧是钉住的（方案 A 遮罩 / 方案 B 回填），
    下一段的引导头取自那个尾部 —— 没变，所以**下一段不用重跑**。这就是
    「拖长第 N 段，第 N+1 段成片不变」（A4）。

    缩短：本段尾部被裁掉了，而下一段的引导头正是从那个尾部取的 —— 源头没了，
    下一段必须标 **redo**。这是诚实的代价，不能假装没事：不标的话下一段会
    对着一个不存在的引导头继续跑，接缝处直接撕裂。本段自己标 **trim**：
    成片要重拼一次才会真的短下来，但已经生成的潜空间照样能用，不必重采样。
    """
    meta = load_clip(name, cid)
    if meta is None:
        return None
    old = int(meta.get("frames") or 0)
    new = snap_frames(frames)
    if new == old:
        return {"clip": meta, "changed": False, "pending": meta.get("pending"),
                "next": None, "next_pending": None}

    # 没有**本版 AV latent 档**（clip_XXXX.cont.safetensors，💾 续拍存档写）
    # 的段：加长**不再硬拒**（20261013）。
    #
    # 硬拒的历史后果：当年判定只认 .latent.safetensors 这一个文件名，而用户
    # 实际用的是「💾 H3 续拍存档」（写 .cont.safetensors）—— 于是除第 1 段外
    # 其余各段**永远**判定"无原稿"，一拉长就被拒、时间轴弹回原位。20261104
    # 起两个文件名收敛成一个，这类「认错文件名」的分支已不可能再出现。
    #
    # 没有原稿失去的只是 **grow 那条捷径**（尾部钉住、后面各段不用重跑），
    # 不等于**不能改时长**：老老实实把本段标 redo（整段重抽），本段尾部会变，
    # 下一段的头钉正是取自本段尾部，所以下一段也一并标 redo。用户把一段从
    # 3 秒拉到 10 秒，本来就是打算重抽的 —— 拦住他才是错。
    no_stock = bool(new > old and not _has_latent_on_disk(name, meta))

    order = (load_chain(name) or {}).get("order") or []
    i = order.index(cid) if cid in order else -1
    nxt = order[i + 1] if 0 <= i < len(order) - 1 else None

    # 从未渲染过的规划段（无成片路径、无实测帧；外部导入的 mp4 会有 film，
    # 不在此列）：改时长只是改计划，没有任何已生成画面要重采样或重拼，直接
    # 写帧长即可 —— 不标 grow/trim/redo、不牵连下一段。否则用户在右侧设置
    # 卡把一段还没抽过的片从 10 秒改成 4 秒，轴上立刻挂"待重拼/下一段待重跑"
    # 的标记，纯属吓唬人（20261012）。
    if not meta.get("film") and int(meta.get("film_frames") or 0) == 0:
        meta = update_clip(name, cid, {"frames": new})
        store.log_event(chain_dir(name), "resize", cid,
                        {"from": old, "to": new, "planned": True}, "monitor")
        ws_broadcast("clip_resized", name, cid)
        return {"clip": meta, "changed": True, "from": old, "to": new,
                "planned": True, "pending": meta.get("pending"),
                "next": None, "next_pending": None}

    if new > old:
        # 有原稿 → grow（尾部钉住，后面各段不动）。
        # 无原稿 → redo（整段重抽）；本段尾部会变，下一段的头钉取自本段尾部，
        #          所以下一段也跟着标 redo —— 这是诚实的代价，总比"改了却不说"好。
        pending, next_pending = ("redo" if no_stock else "grow"), \
                               ("redo" if (no_stock and nxt) else None)
    else:
        # 缩短**本段也要标**，标的是 trim（待裁剪）而不是 redo。
        #
        # 原因：本段的成片是「到本段为止的累积成片」，缩短之后它得重拼一次
        # 才会真的短下来 —— 磁盘上那一版还是 149 帧。可本段已经生成的潜空间
        # 照样能用（只是少用后面几帧），不需要重新采样，所以代价和「加长」
        # 完全不是一个量级：trim = 重拼一下，grow/redo = 重新跑模型。
        #
        # 以前这里给本段标 None（等于"没事了"），于是「导出成片」的清单看不
        # 出这一段其实已经改过 —— 用户会拿到一条比档案设定长的片子，还以为
        # 导出坏了。分档标出来，代价也一并说清。
        pending, next_pending = "trim", ("redo" if nxt else None)

    meta = update_clip(name, cid, {"frames": new, "pending": pending})
    next_meta = update_clip(name, nxt, {"pending": next_pending}) if nxt else None
    store.log_event(chain_dir(name), "resize", cid,
                    {"from": old, "to": new, "pending": pending,
                     "next": nxt, "next_pending": next_pending}, "monitor")
    # 帧长改了必须广播（20261012）：时间轴段块宽度读的是档案 frames，右侧设置
    # 区改时长（不只拖段块边缘）也走本函数；不广播，轴只能等下一次轮询/手动刷新。
    ws_broadcast("clip_resized", name, cid)

    return {"clip": meta, "changed": True, "from": old, "to": new,
            "pending": pending, "next": nxt, "next_pending": next_pending,
            "next_clip": next_meta,
            # 没有续拍存档原稿、只能整段重抽（不再拒绝）：前端要说清代价，
            # 否则用户只会看到"能拉长了"却不知道后面一段也要跟着重跑。
            "no_stock": no_stock,
            "reason": ("这一段没有「💾 H3 续拍存档」原稿，加长后要**整段重抽**；"
                       "它后面那一段的头钉取自本段尾部，也一并标了「待重跑」"
                       "（想只重抽本段、不动后面，请渲染时接上「💾 H3 续拍存档」节点）"
                       if no_stock else "")}


@chainlocked
def set_current(name, cid):
    """把某段设为「当前段」——三个节点共享的编辑目标就是它。

    导演台切段时立刻写一次（不等执行），文案台与媒体架读它，于是
    「切到哪一段，两边就跟着切到哪一段」。20261012 起落盘后经 WebSocket
    广播 bz.chain.event(current)，前端 bz_store 毫秒级跟随，不再靠轮询。
    """
    chain = load_chain(name)
    if cid and load_clip(name, cid) is None:
        return None
    chain["current"] = cid or None
    save_chain(name, chain)
    store.log_event(chain_dir(name), "current", cid, {}, "cast")
    ws_broadcast("current", name, cid)
    return chain


@chainlocked
def set_locked(name, cid, locked):
    """锁定一段。

    锁的是**编辑目标**：钉住之后，再点别的段，文案台与媒体架继续写锁定的
    这一段（不跟着走）。同时也钉住时长——把手消失，拖不动。

    为什么是"锁编辑目标"而不是"锁内容"：长片的实际用法是「我正盯着第 3 段
    调，别让我一点时间轴就跳走」。锁内容（不许重抽）反而没用——重抽本来就
    是手动触发的，不存在误触。
    """
    meta = load_clip(name, cid)
    if meta is None:
        return None
    out = update_clip(name, cid, {"locked": bool(locked)})
    store.log_event(chain_dir(name), "lock", cid, {"locked": bool(locked)}, "cast")
    return out


def set_seam(name, cid, side, score, note=None):
    """记一段接缝的评分（side: 'left' / 'right'）。

    分数由续接合成在真正拼的时候算（那里才同时看得到两段），这里只负责存，
    面板拿它把分数画在两段之间。
    """
    if side not in ("left", "right"):
        return None
    patch = {"seam_%s" % side: None if score is None else float(score)}
    if note is not None:
        patch["seam_%s_note" % side] = str(note)
    return update_clip(name, cid, patch)


# ---- 版本（takes）-------------------------------------------------------
# 一段可以抽很多次。每次重抽存成一个新版本（潜空间 .t2/.t3…，成片同名），
# 旧的一版原样留在磁盘上 —— 于是「换一个镜头」变成「在这一段里选第几版」，
# 而不是「把这一段覆盖掉、后面全部跟着重跑」。
#
# 版本号就是文件名里的 .tN，与 clip_cont / clip_film 同一套命名口径：
# 磁盘上看到一个 clip_0003.t2.cont.safetensors，就是第 3 段第 2 版，
# 不需要另开一份索引去记它。

def take_count(name, cid, meta=None):
    """这一段实际抽过几个版本（以磁盘为准）。

    档案里的 takes[] 只是「我们登记过什么」，磁盘才是「现在真有什么」——
    用户可能手动删过，也可能手动拷进来一个。数磁盘，面板才不会显示一个
    点进去 404 的版本。
    """
    m = meta if meta is not None else load_clip(name, cid)
    if m is None:
        return 0
    ts = {int(t) for t in (m.get("takes") or []) if str(t).isdigit() and int(t) > 0}
    ts.add(int(m.get("current_take") or 1))
    ts.add(1)
    n = 0
    for t in ts:
        if (os.path.isfile(clip_cont(name, cid, t))
                or os.path.isfile(clip_film(name, cid, t))):
            n += 1
    return n


def take_rows(name, cid):
    """这一段所有版本的清单 —— 面板「版本」菜单直接吃这个。"""
    meta = load_clip(name, cid)
    if meta is None:
        return None
    cur = int(meta.get("current_take") or 1)
    ts = {int(t) for t in (meta.get("takes") or []) if str(t).isdigit() and int(t) > 0}
    ts.add(cur)
    ts.add(1)
    rows = []
    for t in sorted(ts):
        cp, fp = clip_cont(name, cid, t), clip_film(name, cid, t)
        have_l, have_f = os.path.isfile(cp), os.path.isfile(fp)
        if not (have_l or have_f):
            continue                      # 档案记着、磁盘上没有 = 已经没了
        rows.append({
            "take": t, "current": t == cur,
            "latent": cp if have_l else None,
            "film": fp if have_f else None,
            "bytes": (os.path.getsize(cp) if have_l
                      else os.path.getsize(fp) if have_f else 0),
            "mtime": (os.path.getmtime(cp) if have_l
                      else os.path.getmtime(fp) if have_f else None),
        })
    return {"id": cid, "current": cur,
            # 注意不能写 ``meta.get("trim_frames") or DEFAULT_TRIM``：trim 合法值
            # 0（首段不承接）会被 ``0 or 22`` 吞成 22。只有缺字段才退回默认。
            "trim_frames": int(meta["trim_frames"])
            if meta.get("trim_frames") is not None else DEFAULT_TRIM,
            "takes": rows}


def tail_fingerprint(name, cid, take, trim=None):
    """这一段第 take 版**尾部窗口**的指纹。

    为什么只看尾部：下一段的引导头正是从这里取的。两版尾部指纹相同 = 下一段
    拿到的是一模一样的引导头 = 它的潜空间照样成立，换这一版不牵连后面。这是
    「换一段而不必把后面全换掉」在物理上唯一的判据 —— 不能靠猜，只能比。

    量化到 1e-3 再哈希：同一份画面必然同哈希，采样里 1e-4 级的浮点噪声不会
    把两个本该相同的尾部判成不同。取不到（没有潜空间档案 / safetensors 不
    可用）就返回 None，调用方必须按「无法验证」处理，不能当成「相同」。
    """
    path = clip_cont(name, cid, take)
    if not os.path.isfile(path):
        return None
    try:
        import hashlib
        import torch
        from safetensors.torch import load_file as _load
        data = _load(path)
    except Exception:
        return None
    t = data.get("video")
    if t is None:
        for k in data.keys():
            t = data[k]
            break
    if t is None:
        return None
    try:
        n = int(trim or DEFAULT_TRIM)
        w = t[-n:] if (n > 0 and t.shape[0] > n) else t
        q = torch.round(w.float() * 1000.0).contiguous()
        return hashlib.sha1(q.numpy().tobytes()).hexdigest()[:16]
    except Exception:
        return None


def set_take(name, cid, take, trim=None):
    """把这一段换成第 take 版，并把代价说清楚。

    换版本有两种结果，代价差一个量级，必须分开报：

      · 两版尾部窗口指纹**相同** —— 下一段的引导头没变，它的潜空间照样成立。
        只有「到各段为止的累积成片」是旧的，重拼一次即可（rejoin：解码+拼接，
        不用重新采样）。这正是重抽时钉住尾帧想换来的东西。
      · 指纹**不同** —— 下一段的引导头来自一个已经不存在的尾部，它必须重抽
        （redo）。这是诚实的代价：不标的话它会接着一个不存在的引导头跑，
        接缝处直接撕裂。

    指纹取不到时 same=None：照实说「没法验证」，而不是显示一个绿色的
    「不影响后面」—— 假的安全感比明确的未知更害人。
    """
    meta = load_clip(name, cid)
    if meta is None:
        return None
    rows = take_rows(name, cid) or {}
    known = [r["take"] for r in rows.get("takes", [])]
    try:
        take = int(take)
    except (TypeError, ValueError):
        return {"ok": False, "error": "版本号必须是整数"}
    if take not in known:
        return {"ok": False, "changed": False,
                "error": "这一段没有第 %d 版（现有：%s）"
                         % (take, "、".join(str(t) for t in known) or "无")}

    old = int(meta.get("current_take") or 1)
    if take == old:
        return {"ok": True, "changed": False, "take": take, "from": old,
                "tail_same": True, "next": None, "next_pending": None}

    trim_n = int(trim or meta.get("trim_frames") or DEFAULT_TRIM)
    fp_old = tail_fingerprint(name, cid, old, trim_n)
    fp_new = tail_fingerprint(name, cid, take, trim_n)
    same = None if (fp_old is None or fp_new is None) else (fp_old == fp_new)

    order = (load_chain(name) or {}).get("order") or []
    i = order.index(cid) if cid in order else -1
    nxt = order[i + 1] if 0 <= i < len(order) - 1 else None
    after = order[i + 1:] if i >= 0 else []

    patch = {"current_take": take}
    # 这一版自己带成片（重抽时 Join 写出来的就是 .tN.mp4）→ 成片直接指过去，
    # 这一段不算待办；否则成片还是旧版那一版，得重拼。
    own_film = clip_film(name, cid, take)
    if os.path.isfile(own_film):
        patch["film"] = own_film
        patch["pending"] = None
    else:
        patch["pending"] = "rejoin"
    meta = update_clip(name, cid, patch)
    # 这版自己的生成参数（画布等）。前端拿它把面板回滚到"当时怎么生成的"，
    # 版本与参数从此绑定 —— 切到哪版，面板就是哪版的画布。
    tp = (meta.get("take_params") or {}).get(str(take)) or {}

    next_pending = None
    if same is False and nxt:
        next_pending = "redo"
        update_clip(name, nxt, {"pending": "redo"})
        after = after[1:]
    # 下游每一段的累积成片都含这一段 —— 换版之后全是旧的。只标「重拼」，
    # 且不降档：已经在等「重抽」的段不会被改回「重拼」。
    for c in after:
        _raise_pending(name, c, "rejoin")
    store.log_event(chain_dir(name), "take_swap", cid,
                    {"from": old, "take": take, "tail_same": same,
                     "next_pending": next_pending}, "monitor")

    return {"ok": True, "changed": True, "from": old, "take": take,
            "takes": known, "trim": trim_n,
            "take_params": tp,
            "tail_same": same,
            "tail_note": (None if same is None else
                          "尾部 %d 帧一致 —— 下一段的引导头没变" % trim_n if same else
                          "尾部 %d 帧变了 —— 下一段的引导头来自旧版本" % trim_n),
            "next": nxt, "next_pending": next_pending,
            "rejoined": after, "clip": meta}


# 待办档次的轻重。只用于「不降档」比较：一段已经在等重抽（redo/grow），
# 就不能因为一次换版本把它改回「只要重拼」——那等于把更重的代价藏起来。
_PENDING_RANK = {"trim": 1, "rejoin": 2, "grow": 3, "redo": 3}


def _raise_pending(name, cid, kind):
    """把一段的待办提到 kind；已有待办更重就不动它。"""
    meta = load_clip(name, cid)
    if meta is None:
        return None
    cur = meta.get("pending")
    if cur and _PENDING_RANK.get(cur, 0) >= _PENDING_RANK.get(kind, 0):
        return meta
    return update_clip(name, cid, {"pending": kind})


def drop_take(name, cid, take):
    """删掉一个版本（潜空间 + 成片一起删）。

    当前版本不给删：时间轴上正挂着它，删了这一段就没有可用潜空间，后面各段
    的引导头也断了。要删就先切到别的版本。
    """
    meta = load_clip(name, cid)
    if meta is None:
        return None
    try:
        take = int(take)
    except (TypeError, ValueError):
        return {"ok": False, "error": "版本号必须是整数"}
    cur = int(meta.get("current_take") or 1)
    if take == cur:
        return {"ok": False, "error": "不能删当前正在用的第 %d 版 —— "
                                      "先切到别的版本再删。" % take}
    gone = []
    for p in (clip_cont(name, cid, take), clip_film(name, cid, take)):
        if os.path.isfile(p):
            try:
                os.remove(p)
                gone.append(os.path.basename(p))
            except OSError as e:
                return {"ok": False, "error": "删不掉 %s：%s"
                                              % (os.path.basename(p), e)}
    takes = [int(t) for t in (meta.get("takes") or []) if str(t).isdigit()]
    meta = update_clip(name, cid, {"takes": [t for t in takes if t != take]})
    store.log_event(chain_dir(name), "take_drop", cid,
                    {"take": take, "removed": gone}, "monitor")
    return {"ok": True, "take": take, "removed": gone, "clip": meta}


@chainlocked
def set_film(name, cid, path, frames=None, seam=None, head=None):
    """把「生成完这一段之后的成片」登记到这一段上。

    语义很关键：不是「这一段的成片」，而是「到这一段为止的成片」。
    所以时间轴上点第 k 段，监视器播的就是前 k 段合起来的片子。

    ``head`` 是契约：这条片子开头有几帧是承接/旧内容（见 _compute_film_head）。
    收片时算一次写死，下游不再猜。
    """
    patch = {"film": path or None}
    if frames is not None:
        patch["film_frames"] = int(frames)
    if head is not None:
        patch["film_head"] = int(head)
    if seam is not None:
        patch["film_seam"] = seam
    out = update_clip(name, cid, patch)
    store.log_event(chain_dir(name), "film_set", cid,
                    {"path": path, "frames": frames}, "backend")
    return out


def _media_brief(desc):
    """可入库的视频描述，避免把完整历史 item 直接塞进 receipt。"""
    if not desc:
        return {}
    return {
        "node": desc.get("node"),
        "slot": desc.get("slot"),
        "index": desc.get("index"),
        "filename": desc.get("filename"),
        "subfolder": desc.get("subfolder") or "",
        "type": desc.get("type") or "",
        "depth": desc.get("depth"),
        "path": _output_path_from_descriptor(desc),
    }


@chainlocked
def collect_run(name, cid, prompt_id):
    """按 prompt_id 从服务端历史中确认本次分段片，统一归档并写中央回执。"""
    name = str(name or "").strip()
    if not name:
        raise ValueError("缺少片名")
    cid = str(cid or "").strip()
    prompt_id = str(prompt_id or "").strip()
    if not cid:
        raise ValueError("缺少段落 id")
    if not prompt_id:
        raise ValueError("缺少 prompt_id")

    # ---- 幂等：同一个 prompt 只收一次 ----
    # 收片有两个独立的发起者，实测相隔 0.5~1s 前后脚到达：
    #   ① 导演台 waitForPrompt 之后的 ui.collectRun（前端主动）
    #   ② csglide_autocollect 的 executing 钩子（任何运行，含手点队列）
    # 20261023 现场铁证：prompt 305b615e / 4b420e8e / d63b5991 各有两条
    # run_collected + 两条 film_set —— 白复制一次视频、白探测一次帧数、还让
    # 时间轴/监视器多收两轮更新广播（段块闪一下就是这么来的）。
    # 判据取 run_receipts：那张表的 prompt_id 是主键，且**在收片完整成功之后
    # 才落库**（见下方顺序），所以"有回执" ⟺ "这次已经收完"。失败的那次不会
    # 留回执，重试仍能走完整流程。
    _d = chain_dir(name)
    try:
        _prev = store.load_run_receipt(_d, prompt_id)
    except Exception:
        _prev = None
    if _prev and str(_prev.get("cid") or "") == cid:
        try:
            store.log_event(_d, "run_collect_dup", cid,
                            {"prompt_id": prompt_id, "take": _prev.get("take")},
                            "backend")
        except Exception:
            pass

        def _rel_out(pth):
            if not pth:
                return ""
            try:
                return os.path.relpath(
                    pth, folder_paths.get_output_directory()).replace(os.sep, "/")
            except Exception:
                return str(pth)

        return {
            "clip": load_clip(name, cid),
            "deduped": True,
            "receipt": {
                "prompt_id": prompt_id,
                "cid": cid,
                "take": int(_prev.get("take") or 1),
                "latent_path": _rel_out(_prev.get("latent_path")),
                "cont_path": _rel_out(_prev.get("cont_path")),
                "segment_film": _prev.get("segment_film") or {},
                "whole_film": _prev.get("whole_film") or {},
                "status": str(_prev.get("status") or "adopted"),
                "deduped": True,
            },
        }

    entry = _server_history_entry(prompt_id)
    if entry is None:
        raise ValueError("服务端历史里没有本次 prompt：%s" % prompt_id)
    status = entry.get("status") or {}
    status_str = str(status.get("status_str") or "")
    run_status = "adopted"
    if status_str and status_str != "success":
        # 手动中断不允许误收；非中断的 partial prompt（通常是整片后处理失败）
        # 仍可按拓扑收已经成功落盘的分段视频。
        if "execution_interrupted" in json.dumps(entry, ensure_ascii=False):
            raise ValueError("本次 prompt 已被中断，不能收片")
        run_status = "partial"

    chain_doc = load_chain(name) or {}
    current = str(chain_doc.get("current") or "")
    if current and current != cid:
        # 20261107：档案里可能残留早先误新建的段，current 还指着它。
        # 目标段确实属于本工程时，把 current 纠正回来再收片，别把整轮判死；
        # 目标段根本不在 order 里才按原逻辑拒绝（那是真的身份错位）。
        order = [str(c) for c in (chain_doc.get("order") or [])]
        if str(cid) in order:
            try:
                set_current(name, str(cid))
                print("[H3 档案] 收片前把 current 从 %s 纠正到 %s"
                      % (current, cid))
                current = str(cid)
            except Exception as exc:
                print("[H3 档案] current 纠正失败：%s" % exc)
        if current != str(cid):
            raise ValueError("当前段是 %s，不能把本次结果收给 %s" % (current, cid))

    meta = load_clip(name, cid)
    if meta is None:
        raise ValueError("没有这一段：%s" % cid)

    # 声明式收片：视频合并节点在 ui.painter_output 里自报身份。
    #
    # 两道判据，缺一不可：
    #   · 段 id 定「哪一段」—— 一采/二采/三采的合并节点读同一份 h3_data，bz_cid
    #     完全相同，光按 cid 筛会把三采的片全浮上来；
    #   · 阶段定「哪一采」（20261111 阶段 1）—— 存档节点删掉后，合并节点改自报
    #     bz_stage（由 latent 上游有没有「🎬 H3 终极放大」自动判定），收片端按
    #     时间轴当前选中阶段筛。阶段 2 的「一采/二采」按钮写的就是同一个字段。
    videos = _history_video_outputs(entry)

    def _decl(v):
        return v.get("item") or {}

    stage = current_stage(name)

    segs = [v for v in videos
            if str(_decl(v).get("bz_role") or "") == "segment"
            and str(_decl(v).get("bz_cid") or "") == str(cid)]
    if not segs:
        listed = "、".join(
            "#%s %s（%s）" % (v.get("node"), v.get("filename"),
                            _decl(v).get("bz_role") or "未声明")
            for v in videos) or "本次没有任何视频输出"
        raise ValueError(
            "没有视频合并节点声明为这一段的分段片（段 %s）。本次视频输出：%s。"
            "请确认视频合并节点的图像输入来自 VAE 解码链，且导演台 h3_data 里有片名和段 id。"
            % (cid, listed))

    declared = [v for v in segs
                if str(_decl(v).get("bz_stage") or "s1") == stage]
    if not declared:
        listed = "、".join(
            "#%s %s（阶段 %s）" % (v.get("node"), v.get("filename"),
                                _decl(v).get("bz_stage") or "未声明")
            for v in segs)
        raise ValueError(
            "这次没有合并节点属于当前选中阶段「%s」（段 %s）。本次分段片：%s。"
            "请确认一采/二采各接了一个「🎬 H3 VAE 快速解码」，"
            "或到导演台把时间轴切到已出片的那个阶段。"
            % (stage, cid, listed))
    # 20261111 阶段 C（Q7=C）：s2 允许两份分段片 —— 二采原片(raw) +
    # 三采成品(final)，按 bz_variant 分组各写各的文件；s1 仍严格一份。
    # 同一变体出现两个 = 真接错线，照样拒收，不靠「取第一个」糊过去。
    by_variant = {}
    for v in declared:
        vv = ("final" if str(_decl(v).get("bz_variant") or "raw").strip().lower()
              == "final" else "raw")
        if stage != "s2":
            vv = "raw"
        if vv in by_variant:
            raise ValueError(
                "有多个视频合并节点都声明为这一段「%s / %s」的分段片：#%s 与 #%s —— 只保留一个"
                % (stage, vv, by_variant[vv].get("node"), v.get("node")))
        by_variant[vv] = v
    # 默认展示 / 导出用二采成片；只有用户显式切到「用三采成品」才换。
    default_vv = "raw" if "raw" in by_variant else "final"
    segment = by_variant[default_vv]

    take = max(1, int(meta.get("current_take") or 1))
    # 20261111：按当前选中阶段校验对应的那份 cont（s1 仍是旧主档文件名）。
    cont_path = clip_cont(name, cid, take, stage)
    if not os.path.isfile(cont_path):
        raise ValueError("缺少本次 take 的续拍存档：%s"
                         % os.path.basename(cont_path))
    # 回执/DB/前端一直有 latent_path 这个字段，删它会破坏契约。
    latent_path = cont_path

    take_params = dict(meta.get("take_params") or {})
    # 写盘方已经在本版登记过 stages / run_fingerprint；这里必须**合并**而不是
    # 整条覆写，否则收一次片就把 s2 那份档的登记抹掉了（阶段档静默丢失）。
    rec = dict(take_params.get(str(take)) or {})
    films = dict(rec.get("films") or {})
    briefs = {}
    for vv, v in by_variant.items():
        src = _output_path_from_descriptor(v)
        if not os.path.isfile(src):
            raise ValueError("找不到分段视频源文件：%s" % v.get("filename"))
        dest = clip_film(name, cid, take, stage, vv)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.abspath(src) != os.path.abspath(dest):
            shutil.copy2(src, dest)
        vinfo = probe_film_info(dest)
        vframes = int(vinfo.get("frames") or 0)
        if vframes <= 0:
            raise ValueError("收片后无法确认视频帧数：%s" % os.path.basename(dest))
        films[_film_key(stage, vv)] = dest
        brief = _media_brief(v)
        brief.update({
            "width": int(vinfo.get("width") or 0),
            "height": int(vinfo.get("height") or 0),
            "frames": vframes,
            "archived_path": dest,
        })
        briefs[vv] = brief

    default_brief = briefs[default_vv]
    frames = int(default_brief["frames"])
    dest = default_brief["archived_path"]
    rec.update({
        "prompt_id": prompt_id,
        "source_node": segment.get("node"),
        "source_slot": segment.get("slot"),
        "role": "segment_film",
        "w": int(default_brief["width"]),
        "h": int(default_brief["height"]),
        "cont_saved": cont_path,
        # 认档凭据（2-A）：这份承接档属于哪一段。下一段续写据此校验，对不上即报错。
        "cont_saved_of": cid,
        # 阶段 C：本版所有成片一份都不丢，切阶段 / 切变体时按它回找。
        "films": films,
    })
    for key in ("prompt_seg", "steps", "cfg", "refs"):
        if key in meta:
            rec[key] = meta[key]
    take_params[str(take)] = rec
    update_clip(name, cid, {"take_params": take_params})

    segment_brief = default_brief
    whole_brief = {}

    def _decl_brief(v):
        """声明摘要：哪一段、哪个阶段、为什么这么判。"""
        d = _media_brief(v)
        it = _decl(v)
        d.update({
            "bz_role": it.get("bz_role") or "",
            "bz_cid": it.get("bz_cid") or "",
            "bz_stage": it.get("bz_stage") or "",
            "bz_stage_why": it.get("bz_stage_why") or "",
            "bz_variant": it.get("bz_variant") or "",
            "bz_arch": it.get("bz_arch") or "",
            "bz_arch_on": bool(it.get("bz_arch_on")),
            "bz_why": it.get("bz_why") or "",
        })
        return d

    detail = {
        "declare": [_decl_brief(v) for v in declared],
        "video_outputs": [_decl_brief(v) for v in videos],
        # 20261111 阶段 1 起「哪一采」由时间轴当前选中阶段裁决，存档节点已删。
        # 这里原先写着 archive_on: list(arch_on)，定义删了、引用没删 —— 每次
        # 收片到这儿 NameError，成片已复制完却走不到 set_film，时间轴一直空白。
        "stage": stage,
        "variants": {k: b["archived_path"] for k, b in briefs.items()},
    }
    clip_from, clip_to, head_trim = _span_of(name, cid)
    # clip["film"] 是时间轴 / 预览 / 拼片的唯一读口：这里直接指向当前
    # 「阶段 + 变体」选中的那一份，切换时由 film_summary 的 film_pick 动态选，
    # 读侧一行都不用改。
    show_path = film_pick(name, cid, take, stage, current_variant(name),
                          fallback=dest)
    out = set_film(name, cid, show_path, frames=frames,
                   head=_compute_film_head(clip_from, clip_to, frames,
                                           head_trim=head_trim))

    # 回执**只在收片完整成功之后**落库（20261023）。
    # 它是上面那段幂等短路的判据："有回执" 必须等价于 "这次已经收完"。
    # 原来放在 set_film 之前：一旦 set_film 抛错，回执已经在了 —— 重试会被
    # 幂等短路直接挡回去，那一段就永远收不成片，而且看不出为什么。
    store.save_run_receipt(chain_dir(name), {
        "prompt_id": prompt_id,
        "cid": cid,
        "take": take,
        "latent_path": latent_path,
        "cont_path": cont_path,
        "segment_film": segment_brief,
        "whole_film": whole_brief,
        "detail": detail,
        "status": run_status,
    })
    store.log_event(chain_dir(name), "run_collected", cid,
                    {"prompt_id": prompt_id, "take": take,
                     "source_node": segment.get("node"),
                     "path": dest, "status": run_status}, "backend")
    schedule_prewarm(name)
    receipt = {
        "prompt_id": prompt_id,
        "cid": cid,
        "take": take,
        "latent_path": os.path.relpath(
            latent_path, folder_paths.get_output_directory()).replace(os.sep, "/"),
        "cont_path": os.path.relpath(
            cont_path, folder_paths.get_output_directory()).replace(os.sep, "/"),
        "segment_film": segment_brief,
        "whole_film": whole_brief,
        "status": run_status,
    }
    return {"clip": out, "receipt": receipt}


def _has_latent_on_disk(name, c):
    """has_latent 的真实判定：档案说有还不够，当前版本的 latent 文件得真在。

    只纠「渲染过（有成片路径）却没存档」这一种 —— 从未渲染的段本来就没有
    latent 文件，不能因此把它标成无原稿（那是外部导入段的语义）。

    字段缺失（老档案还没有这个字段）按"有档案"处理：直接 `not c.get(...)`
    会把 None 和 False 混为一谈，老工程一升级就全被标成"无原稿"，加长/重抽
    全被拒 —— 升级即瘫痪，而且看不出为什么。
    """
    _hl = c.get("has_latent")
    if _hl is not None and not _hl:
        return False
    if not c.get("film"):
        return True
    take = max(1, int(c.get("current_take") or 1))
    # 实时判定：用户手动删 latent 后加长/重抽拦截语义必须立刻生效。
    return os.path.isfile(clip_cont(name, c.get("id"), take))


def _head_trim_of(c, n):
    """这一段**成片开头**有几帧是上一段的重绘（承接重叠）。

    只认档案里的 ``trim_frames``，**不看它排第几**（20261026 修 391/430）。
    早先两处都写成 ``... if i > 0 else 0``：段的位置成了第二个真值。删掉前段 /
    把段拖到最前之后，位置变了、``trim_frames`` 没变 —— 导演台卡片按 trim 算
    （430 − 39 = 391 帧 / 16.3s）、时间轴按位置算（430 帧 / 17.9s）、导出的成片
    跟着轴走 430，同一段三个数，用户没法判断哪个是真的。

    这笔账只能有一个来源：**文件里那几帧到底在不在**。在就是承接，就得扣；
    它排第几改变不了 mp4 的头 39 帧长什么样。

    残留旧账（成了首段却还揣着承接窗口）由 :func:`film_summary` 里那段清账
    处理 —— 那里才拿得到「有没有成片」这个判据。
    """
    return min(int(c.get("trim_frames") or 0), max(0, int(n) - 1))


def film_summary(name):
    """整片的成片视图 —— 导演台监视器 / 时间轴直接吃这个。

    返回每段在全片里的起止帧（clip_from/clip_to），前端拿它画时间轴；
    `film` 是该段为止的累积成片；`playable` 说明这份成片还在不在磁盘上
    （用户可能手动清了 output，不能让面板对着一个 404 播）。

    性能（20261012 + 1-B）：json 读走 _read_json 的 mtime 缓存；本函数再加一层
    **短 TTL（0.8s）结果缓存**，失效键 = (片名, 档案版本号)。连续生成时前端
    时间轴 + 多段收片在百毫秒内会重复拉同一份 film_summary，命中缓存就省掉
    3N+ 次 stat（K 盘上这几十次同步 stat 就是「界面卡」的元凶，见文件头 _io）。
    playable 的「删片即时反映」由 0.8s TTL 兜底 —— 最多延迟不到一秒。
    """
    _key = str(name)
    _now = time.time()
    with _film_memo_lock:
        _hit = _film_memo.get(_key)
        if _hit and (_now - _hit[0]) < _FILM_SUMMARY_TTL \
                and _hit[1] == _archive_version_now():
            return _hit[2]
    # 20261111 阶段 C：成片视图跟随「阶段 + 变体」，与整片导出同一份选片。
    # 所有读侧（时间轴 / 预览 / 整片口 / 拼片）都吃这个 film 字段，改这里就够。
    _stage = current_stage(name)
    _variant = current_variant(name)
    info = summary(name)
    fps = float(info.get("fps") or FRAME_FPS)
    # 段序：老档案 pins 分类器判断「绕回」要拿它比轴向位置
    _order = [str(x.get("id")) for x in (info.get("clips") or [])]
    try:
        _trans = transitions_of(name)
    except Exception:
        _trans = {}
    at = 0
    rows = []
    for i, c in enumerate(info["clips"]):
        n = int(c.get("frames") or 0)
        # 断链判据在**整片级**只算一次，后面 trim 兜底 / 派生归零 / 显示接法
        # 全用这一个值。以前散在三处各查一遍 _trans，改一处漏两处。
        _cid = str(c.get("id") or "")
        _head_unlink = bool(_cid in _trans
                            and (_trans.get(_cid) or {}).get("type") == "unlink")
        # 当前版自己的生成参数（adopt_film 落的，20261010）：画布宽高跟着
        # 版本走。没记录的段（老渲染）是 None —— 前端据此不回滚面板。
        _tp = (c.get("take_params") or {}).get(
            str(max(1, int(c.get("current_take") or 1)))) or {}
        # film_frames 自愈（20261010）：adopt_film 早年不写它，存量档案恒 0。
        # 现场探一次实测帧数并**写回档案**——此后这一段走缓存零开销，前端
        # 的累积/单段判据从此有地面真相。
        ff = int(c.get("film_frames") or 0)
        _film_path = film_pick(name, c.get("id"),
                               max(1, int(c.get("current_take") or 1)),
                               _stage, _variant, meta=c,
                               fallback=c.get("film"))
        # playable 必须实时：用户手动删掉成片后轴上要立刻转"不可播"，
        # 目录清单有 1.5s TTL，这里不能用它（_film_selftest 红线）。
        # 单次 stat 在线程池路由里跑、film_summary 又有 0.8s TTL 压频，
        # N 段 N 次 stat 可接受。
        _film_on_disk = bool(_film_path) and os.path.isfile(_film_path)
        if ff <= 0 and _film_on_disk:
            ff = probe_film_frames(_film_path)
            if ff > 0:
                try:
                    update_clip(name, c.get("id"), {"film_frames": ff})
                    c["film_frames"] = ff        # 本轮 summary 直接用上
                except Exception:
                    pass
        # 净长模型（20261010 重做）：第 k 段视频里开头 trim 帧是上一段末尾的
        # 重绘（承接重叠），它们在时间轴上**归属上一段的展示区** —— 段块只画
        # 本段的**新画面净长**（frames - trim），段与段首尾干净相接，连接处
        # 不再重复/叠盖。trim 至少给本段留 1 帧。
        trim = _head_trim_of(c, n)
        # 生成前 trim_frames 还没回填（=0），但用户「承接多少帧」的意图在
        # state.cont.frames 里。用它兜底：音频切片 / 时间轴段块才能在没成片时
        # 也按续接扣净长 —— 否则音频按 frames 切、成片按 frames-trim 拼，音画
        # 总长会差 (段数-1)×承接帧。断链（unlink）时意图作废，按 0。
        if trim == 0:
            # 意图在 segment_bindings.state.cont.frames（不在 clip doc 里，
            # bind_segment 存 state 到 binding）。读不到就当 0。
            _st = None
            try:
                _bind = store.load_segment_binding(chain_dir(name), str(c.get("id")))
                if isinstance(_bind, dict):
                    _st = _bind.get("state")
            except Exception:
                _st = None
            if isinstance(_st, dict) and not _head_unlink:
                trim = min(int((_st.get("cont") or {}).get("frames") or 0),
                           max(0, n - 1))
        # 位置不再参与算账（见 _head_trim_of），但**残留的旧账要清**：一段成了
        # 首段、却还揣着「接上一段」的承接窗口，而它**从来没拍过成片** —— 那
        # 几帧就不是"文件里的旧内容"，只是登记时继承下来的空头承诺（复制段 /
        # 拆分段出厂就带 39）。留着等于让它在轴上凭空短一截：渲染会拍满 n 帧，
        # 轴上却按 n - trim 画，又是两个数。
        # **有成片的一律不动**：那 trim 帧真实存在于 mp4 里，「排第一」这个位置
        # 改变不了它；要清得先重跑一段不带承接的，不能改档案假装。
        # 判据只看**盘上有没有片子**（不看 film_frames：片子被手动删掉后那个数
        # 还在，它证明不了帧还在）。
        if trim and i == 0 and not _film_on_disk:
            try:
                update_clip(name, c.get("id"), {"trim_frames": 0})
                c["trim_frames"] = 0
            except Exception:
                pass
            trim = 0
        # 20261111 方案 B：断链是**意图优先**的派生状态。
        # 档案里的 trim_frames 是上一次生成时 mp4 里真实存在的承接头（文件
        # 事实），不能因为后来点了「取消接续」就假装它不在 —— 恢复续接时还要
        # 用，也不该为了改账去重写历史。但断链语义就是「不承接、不剪头」，
        # 所以本轮**派生账**一律按 0：net = frames、clip_from/clip_to 如实
        # 重算、_seg_cut 不剪头，与 csglide_cast._apply_driver() 的
        # head_frames=0 对齐（声画不再错开）。旧成片会被导出门禁标成待重跑，
        # 这是诚实代价，不是 bug；恢复续接时 trim_frames 还在，自动回原账。
        if _head_unlink:
            trim = 0
        net = max(1, n - trim)
        # 尾钉的对称账（20261010bd）：钉在尾部时末尾那几帧是**后一段**开头的
        # 重绘，同样不属于本段。默认 0 → 与改之前逐字相同，往后接/首段不受影响。
        tail = min(int(c.get("trim_tail") or 0), max(0, net - 1))
        net = max(1, net - tail)
        # 契约迁移（20261010ba）：老档案没有 film_head。这里用同一笔账算一次
        # 并写回档案 —— 从此这一段永久走契约，不再判断它是什么形态。
        head = c.get("film_head")
        if ff > 0:
            _want_head = _compute_film_head(at, at + net, ff, head_trim=trim)
            # 一律「算一遍、不一样就改」。以前这里有个 `_single = ff < 净末`
            # 的闸门，等于把「这条片子是什么形态」在调用处又判了第二遍 ——
            # 而它和 _compute_film_head 内部判据分叉，正是「档案里写着 0、
            # 导出从第 0 帧开始」的来路。形态判定只留 _compute_film_head 一处，
            # 这里只负责把结果落到档案（幂等：算出来一样就不写）。
            if head is None or int(head or 0) != int(_want_head):
                head = _want_head
                try:
                    update_clip(name, c.get("id"), {"film_head": int(head)})
                except Exception:
                    pass
        head = int(head or 0)
        _pins = pins_of(name, c.get("id"))
        # 老档案显示用接法：断链（头部不接续）时把头钉摘掉再判。
        # 20261108 前端已无接法符号，这两个字段只作档案字段契约保留。
        _disp_pins = [p for p in _pins if str(p.get("at")) != "head"] \
            if _head_unlink else _pins
        rows.append({
            "id": c.get("id"), "index": i + 1,
            "name": c.get("name") or "第 %d 段" % (i + 1),
            # 认段靠它：档案里的 shot 是「分段身份 uid」，工程对象里的 shot.id
            # 就是同一串。前端拿它把「工程预设」和「档案事实」对齐做 mtime 校验。
            "shot": c.get("shot") or "",
            # 档案的写入时间戳（save_clip 每次都刷新）。前端拿它比对工程对象的
            # 同步戳，判断「档案是不是被时间轴/后端改得更新」。
            "updated": c.get("updated"),
            # frames = 这段视频的完整长度（含承接重叠）；块宽/全片长度用的是
            # 扣掉重叠后的净长（clip_to - clip_from）。
            "frames": n,
            # 头部承接帧数（trim_frames 生成前用 cont.frames 兜底后的值）。
            # 前端排段（planFrames）要拿它把续接帧加回 frames，音频切片才和
            # 视频净长对齐。
            "trim_frames": trim,
            "clip_from": at, "clip_to": at + net,
            "film": _film_path,
            "film_frames": int(c.get("film_frames") or 0),
            # 契约：这条成片开头有几帧是承接（本段新画面从这里开始）。
            # 前端的时间轴定位、播放落点、保存成片裁切**全部读这一个数**。
            "film_head": head,
        # 承接窗口（方案 B 地基；20261108 起仅老档案兼容）：这段生成时钉住了
        # 谁的哪一段画面。新工程 pins 恒为空，走段序回退（自动接续）。
        "pins": _pins,
        # 接法名只为保住 film_summary 的字段契约；前端已不再按接法分叉显示，
        # 导演台也只剩「自动接续」一种。
        "pin_mode": pin_mode(_pins, _order),
        "head_unlink": _head_unlink,
        "disp_pin_mode": pin_mode(_disp_pins, _order),
            "film_seam": c.get("film_seam"),
            # 接缝评分：只在真正拼过的时候才有（续接合成算的）。第 1 段没有
            # 左边可接的东西，所以是 None —— 面板据此不画，而不是画个 0。
            "seam_left": c.get("seam_left"),
            "seam_left_note": c.get("seam_left_note"),
            "seam_right": c.get("seam_right"),
            "seam_right_note": c.get("seam_right_note"),
            # 实时 isfile（理由同 _film_on_disk，不用目录清单缓存）
            "playable": _film_on_disk,
            # has_latent 以磁盘为准：档案标了 true、但当前版本的潜空间文件
            # 不在（渲染时工作流没接「💾 H3 续拍存档」），重抽/加长的承诺兑现
            # 不了 —— 如实报 false，时间轴才会给它"无原稿"的灰边、拖加长
            # 才会被拒。只纠「渲染过（有成片）却没档案」这一种：从未渲染的
            # 段本来就没有 latent 文件，不能因此把它标成"外部导入"。
            "has_latent": _has_latent_on_disk(name, c),
            "pending": c.get("pending"),
            "locked": bool(c.get("locked")),
            # 版本：这一段抽过几个、现在用第几个。时间轴块上显示 v(k/n)，
            # 右键菜单据此列出可切换的版本。以磁盘为准（见 take_count）。
            "take": max(1, int(c.get("current_take") or 1)),
            "takes": take_count(name, c.get("id"), c),
            # 这一段当初是用多少帧的窗口接上一段的（0 = 没有上一段）。
            # 输出的是**净长模型里的有效值**：min(设定的窗口, 本段帧数 - 1)，
            # 与块宽（clip_to - clip_from = frames - trim）同一套口径。
            "trim_frames": trim,
            # 尾钉剪掉几帧（仅老档案里显式尾钉才有）。时间轴上本段的新画面
            # 是 [头, 尾) 之间那一截，块宽已经把它扣掉了。
            "trim_tail": tail,
            # 当前版的画布（版本绑定参数，20261010）。None = 没记录。
            "w": _tp.get("w"), "h": _tp.get("h"),
        })
        at += net
    # 播放头默认落在最后一段有成片的地方
    head = None
    for r in reversed(rows):
        if r["playable"]:
            head = r["id"]
            break
    result = {
        "name": name, "fps": fps,
        # 全片长度 = 扣完各段承接重叠后的**净长**（= 最后一段的 clip_to），
        # 与时间轴布局同一套口径 —— 用原始 sum 会比轴长出所有重叠帧，
        # scrub 的全片坐标、时间码就全错位了。
        "total_frames": at,
        "trim_frames": info.get("trim_frames", DEFAULT_TRIM),
        "seconds": (at / fps) if fps else 0.0,
        "clips": rows,
        # 各段的接法（老档案 pins 分类）。20261108 前端已不再消费接法名，
        # 保留整份只为 film_summary 字段契约不突然少键。
        "pin_modes": {r["id"]: pin_mode(r["pins"], [x["id"] for x in rows])
                      for r in rows},
        "head": head,
        # 当前编辑段（chain.current）：媒体架/文案台跟随切段就认它，
        # 20261012 起 bz_store 一次拉取拿全，不必再单查 /current。
        "current": info.get("current"),
        # 时间轴直接吃 film_summary，阶段跟着一起给，面板不用再单查一次。
        "stage": current_stage(name),
        "missing": [r["id"] for r in rows if not r["playable"]],
        # 段落 json 读不出来的段（被手动删了 / 写坏了）。面板要报，不然用户
        # 只会看到"第 3 段不见了"，而不知道是档案坏了。
        # 20261107：chain.order 里若混入重复坏 id，未经去重的 broken 会让
        # 时间轴下方把同一句「N 段档案读不出来」渲染成两遍。保序去重。
        "broken": list(dict.fromkeys(info.get("broken") or [])),
    }
    with _film_memo_lock:
        _film_memo[_key] = (_now, _archive_version_now(), result)
    return result


def _safe_file_part(s, fallback="未命名"):
    """文件名里能用的那部分。与 chain_dir 同一套过滤，别各写一份。"""
    t = "".join(c for c in (s or "") if c not in '\\/:*?"<>|').strip()
    return t or fallback


def export_plan(name, at=None):
    """「导出成片」之前要跟用户说清的那张清单。

    导出读的是磁盘上**已经生成好**的成片，不是重新渲染一遍。所以点下去之前
    必须先把两件事摆出来，否则用户拿到一条跟想象中不一样的片子，只会以为
    导出坏了：

      1. 片子到哪儿为止 —— 只有生成过的段才有成片，最后一段没跑过，导出就
         只到倒数第二段。这是最容易踩的坑。
      2. 改动进没进片子 —— 段上挂着的待办是**档案里的设定**，成片还是改之前
         那一版。不跑一次它不会自己变。

    刻意不在这里自动去跑：导出是个读盘动作，偷偷重渲染会让「点一下导出」
    变成「跑了二十分钟」。列清楚，让用户自己决定。

    at 为空 = 导出能拿到的最新版（最后一段还拿得到成片的段）。
    """
    fs = film_summary(name)
    rows = fs["clips"]
    fps = float(fs.get("fps") or FRAME_FPS) or float(FRAME_FPS)
    broken = fs.get("broken") or []

    def brief(r):
        return {"index": r["index"], "name": r["name"],
                "frames": r["frames"], "playable": r["playable"]}

    if at:
        pick = next((r for r in rows if r["id"] == at), None)
        if pick is None:
            return {"name": name, "ok": False, "blocker": "no_such_clip",
                    "beyond": [], "pending": [], "broken": broken,
                    "message": "没有这一段：%s" % at}
    else:
        # 默认导出「能拿到的最新版」——不是最后一段。最后一段可能压根没跑过。
        pick = next((r for r in reversed(rows) if r["playable"]), None)

    if pick is None:
        return {"name": name, "ok": False, "blocker": "no_film",
                "beyond": [brief(r) for r in rows], "pending": [],
                "broken": broken, "total_clips": len(rows),
                "message": "这部片子还没有任何一段生成过成片 —— 先跑一次再来导出。"}

    cut = pick["index"]
    frames = int(pick.get("film_frames") or 0)
    return {
        "name": name, "ok": True, "blocker": None,
        "at": pick["id"], "at_index": cut, "at_name": pick["name"],
        "path": pick.get("film") or "",
        "frames": frames,
        "seconds": (frames / fps) if fps else 0.0,
        "file": "%s_到第%d段.mp4" % (_safe_file_part(name), cut),
        "total_clips": len(rows),
        # 导出点之后的段：全都进不了这条片子。
        "beyond": [brief(r) for r in rows if r["index"] > cut],
        # 导出点之内还挂着待办的段：设定改了，成片没跟上。
        "pending": [{"index": r["index"], "name": r["name"],
                     "kind": r["pending"],
                     "text": PENDING_TEXT.get(r["pending"], r["pending"]),
                     "frames": r["frames"]}
                    for r in rows if r["index"] <= cut and r.get("pending")],
        "broken": broken,
        "message": "",
    }


# ---------------- 保存成片：整轴拼接导出（20261010）----------------
# 「保存成片」与「导出成片」不是一回事，别再混：
#   · 导出成片（export_plan / /chain/export）：把**某一段自己的成片文件**下载走；
#   · 保存成片（export_film_plan / export_film / /chain/export_film）：把时间轴
#     上**所有段**按净长拼成一条完整视频写进档案目录。连接处裁掉每段头部的
#     承接重叠帧（净长模型：第 k 段视频开头 trim 帧是上一段末尾的重绘，在成片
#     里归属上一段），成片总长 = 最后一段的 clip_to，与时间轴布局同一套口径。
_FILM_EXPORT_LOCK = threading.Lock()   # 同一片子的拼接串行化：别让两次点击互相踩临时文件

# 导出任务表（20261104）：POST 立刻回 job id，ffmpeg 在后台线程跑。
# 只串行不够 —— 归档每生成一个播放版都会顺带触发一次导出，4 次触发就是
# 4 遍重编码排队，最后一个请求必然超过前端的 fetch 上限。同一个片子正在
# 拼时复用同一个 job，去重是任务表的副产品，不再另设一套去重机制。
_FILM_JOBS = {}
_FILM_JOBS_LOCK = threading.Lock()
_FILM_JOB_TTL = 600.0


def _strip_audio_file(path):
    """导出成片去掉音轨：只复制视频流，不重编码、零画质损失。

    拼接有「整片重编码 / 流复制 / PyAV 逐帧」三条路径，逐条改拼接函数必漏；
    去音轨是产物属性，统一在导出任务的收口处做一次。"""
    import subprocess
    if not os.path.isfile(path):
        return {"ok": False, "message": "成片文件不存在，没法去掉音轨"}
    jp = _join_panel()
    exe = getattr(jp, "_ffmpeg_exe", lambda: None)() if jp else None
    if not exe:
        return {"ok": False, "message": "找不到 ffmpeg，没法去掉音轨"}
    tmp = path + ".noaudio.part.mp4"
    try:
        cmd = [exe, "-y", "-hide_banner", "-loglevel", "error",
               "-i", path, "-map", "0:v:0", "-c", "copy", "-an",
               "-movflags", "+faststart", "-f", "mp4", tmp]
        kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
        subprocess.run(cmd, check=True, timeout=900, **kwargs)
        _replace_retry(tmp, path)
        return {"ok": True}
    except Exception as exc:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return {"ok": False, "message": "去掉音轨失败：%s" % exc}


def _start_export_job(name, at, no_audio=False):
    """返回 (job_id, 记录)。同一 (片名, 截止段) 正在跑时复用同一个 job。

    已完成的任务不复用：用户改过时间轴后再点导出，必须重新拼一次才拿得到
    最新画面。只去重「并发」，不去重「先后」。
    """
    key = "%s|%s|%s" % (name, at or "", "mute" if no_audio else "audio")
    with _FILM_JOBS_LOCK:
        now = time.time()
        for jid in [k for k, v in _FILM_JOBS.items()
                    if now - v["ts"] > _FILM_JOB_TTL]:
            _FILM_JOBS.pop(jid, None)
        for jid, rec in _FILM_JOBS.items():
            if rec["key"] == key and rec["state"] == "running":
                return jid, rec
        jid = uuid.uuid4().hex[:12]
        rec = {"key": key, "state": "running", "result": None,
               "ts": time.time()}
        _FILM_JOBS[jid] = rec

    def _run():
        try:
            res = export_film(name, at)
            if res.get("ok") and no_audio:
                out_path = res.get("path") or ""
                strip = (_strip_audio_file(out_path) if out_path else
                         {"ok": False, "message": "导出结果没带成片路径"})
                if not strip.get("ok"):
                    res = dict(res, ok=False, blocker="strip_audio_failed",
                               message=strip.get("message") or "去掉音轨失败")
                else:
                    res = dict(res, audio=False, audio_seconds=0.0, drift=0.0)
        except Exception as exc:
            res = {"ok": False, "message": str(exc)}
        with _FILM_JOBS_LOCK:
            rec["state"] = "done"
            rec["result"] = res
            rec["ts"] = time.time()

    threading.Thread(target=_run, daemon=True, name="h3-film-export").start()
    return jid, rec


def _join_panel():
    """取播放版 / 无损拼接所在的模块。

    延迟导入：那个模块 import 了 server 与 aiohttp（要注册路由），而本模块会被
    别的链路在 ComfyUI 起来之前就 import —— 顶层硬引会把它拖进不该有的时机。
    取不到（旧环境 / 单独跑自检）返回 None，调用方退回重编码路径。
    """
    try:
        from . import csglide_join_panel as m            # noqa: F401
        return m
    except Exception:
        try:
            import csglide_join_panel as m               # noqa: F401
            return m
        except Exception:
            return None


def pins_of(name, cid):
    """这一段的承接窗口（生成时钉住了谁的哪一段）。空 = 独立生成的首段。"""
    c = load_clip(name, cid) or {}
    p = c.get("pins")
    return [dict(x) for x in p] if isinstance(p, list) else []


@chainlocked
def set_pins(name, cid, pins):
    """改写这一段的承接窗口。**只有**动手生成之前改它才有意义 —— 生成完
    再改等于篡改血统，接法跟实际画面对不上。"""
    out = update_clip(name, cid, {"pins": [dict(x) for x in (pins or [])]})
    store.log_event(chain_dir(name), "pins", cid,
                    {"pins": [dict(x) for x in (pins or [])]}, "cast")
    return out


def pin_mode(pins, order=None):
    """这段的 pins 属于哪种接法 —— **只作老档案解释，不再有写入口**。

    20261108：导演台「特殊接法」四种（extend / prepend / bridge / loop）
    已连同 UI 与写入口删除，真实工程档案里也从未落过非空 pins。保留这个
    分类器只为老档案 / 外部工具写入的 pins 能被 film_summary 稳定解释；
    新工程的接法恒为 ``source``（自动接续，按段序回退上一段）。
    """
    heads = [p for p in (pins or []) if p.get("at") == "head"]
    tails = [p for p in (pins or []) if p.get("at") == "tail"]
    if heads and tails and order:
        # 绕回：尾端钉的那段在轴向位置比头端钉的还靠前 → 首尾相接的循环
        try:
            i_h = order.index(heads[-1].get("from"))
            i_t = order.index(tails[-1].get("from"))
            if i_t < i_h:
                return "loop"
        except (ValueError, AttributeError):
            pass
        return "bridge"
    if heads and tails:
        return "bridge"
    if tails:
        return "prepend"
    if heads:
        return "extend"
    return "source"


def transitions_of(name):
    """整片的接缝状态映射：后一段 cid -> {"type":"unlink"}（断链）。
    没有记录 = 链接（默认）。成片视觉转场（溶解/淡变）已移除。"""
    ch = load_chain(name)
    t = ch.get("transitions")
    return dict(t) if isinstance(t, dict) else {}


@chainlocked
def set_transition(name, cid, t):
    """写一条接缝状态：unlink（断链、播放不连播）记下；cut / 空 = 删除（回链接）。
    只有这两态。返回新映射。"""
    ch = load_chain(name)
    tt = ch.get("transitions")
    if not isinstance(tt, dict):
        tt = {}
    if str((t or {}).get("type") or "cut") == "unlink":
        tt[str(cid)] = {"type": "unlink", "overlap": 0}
    else:
        tt.pop(str(cid), None)
    ch["transitions"] = tt
    save_chain(name, ch)
    # 20261111 方案 B：接缝一改，film_summary 对断链段把 trim **派生**归零
    # → net 变长 → 后面所有段的 clip_from/clip_to 整体**后移**（档案里的
    # trim_frames 不动，恢复续接自动回原账）。film_summary 有 0.8s 缓存，不清掉
    # 紧接着的驱动音频重切 / 时间轴刷新会读到旧净长，切片永远差一截。
    with _film_memo_lock:
        _film_memo.pop(str(name), None)
    store.log_event(chain_dir(name), "transition", cid, t, "monitor")
    ws_broadcast("transition", name, cid)
    return tt


def head_parent(name, cid, fallback_prev=True):
    """这一段的**头钉钉的是谁** —— 没有头钉（独立首段 / 纯往前接）返回 ``""``。

    20261108：四种特殊接法的 UI 已删，下面按 pins 分类的分支只用于老档案
    兼容；新工程 pins 恒为空，一律走 ``fallback_prev`` 的段序回退（自动接续）。

    它是「本段开头那几帧是从谁的尾巴重绘来的」的唯一答案，也是上一段决定
    **自己尾部要钉多少帧**的唯一依据（见 csglide_cast._attach_pin）。

    为什么非要问它、不能只看「下一段的 trim_frames」：补桥的那一段同样有
    ``trim_frames``（它头钉钉了 22 帧），但钉的是**别人** —— 本段若照着把
    尾部也钉 22 帧，就是凭空少掉一截能改的画面，而且这种"少掉"不报错，
    只表现为"重抽了半天中间没怎么变"。

    没有 pins 的老工程退回传统语义（轴上前一段）—— 那时只有往后接一种接法，
    「下一段」就是「接本段的那一段」，两者本来就是同义词。
    """
    pins = pins_of(name, cid)
    for p in pins:
        if p.get("at") == "head":
            return str(p.get("from") or "")
    if pins:
        # 写过 pins 却没有头钉 = 明确不接任何人（往前接 / 独立起头）
        return ""
    if not fallback_prev:
        return ""
    try:
        order = [str(c) for c in (load_chain(name).get("order") or [])]
        k = order.index(str(cid)) if str(cid) in order else -1
        return order[k - 1] if k > 0 else ""
    except Exception:
        return ""


def _span_of(name, cid):
    """这一段在全片里的 ``[from, to)``（净长口径）与**头部**承接帧数。

    找不到返回 ``(0, 0, 0)``；否则 ``(from, to, head_trim)``。

    净长模型：重叠帧只记在接缝**右段**头部，段块宽度 = ``frames - trim -
    trim_tail``，整条 = 各段净长之和。第三个返回值是头部那截 trim（尾钉
    trim_tail 不算在内），收片算 film_head 要用 —— 单段片的开头旧帧只来自
    头部，不能把尾钉也计进去。

    20261026：trim 改为只认 ``trim_frames``（:func:`_head_trim_of`），不再按
    「第几段」硬推 —— 与 :func:`film_summary` 同一口径，导出裁切才不会跟轴上
    的块宽分叉。
    """
    at = 0
    for c in summary(name)["clips"]:
        n = int(c.get("frames") or 0)
        trim = _head_trim_of(c, n)
        net = max(1, n - trim)
        net = max(1, net - min(int(c.get("trim_tail") or 0), max(0, net - 1)))
        if c.get("id") == cid:
            return at, at + net, trim
        at += net
    return 0, 0, 0


def _compute_film_head(clip_from, clip_to, film_frames, head_trim=None):
    """契约：这条成片**开头有几帧是承接/旧内容**，本段新画面从这之后开始。

    全片**只有这一处**判断「这条片子是什么形态」，而且只在收片/迁移时跑一次，
    结果写进档案的 ``film_head`` —— 下游（时间轴、播放、保存成片）一律读它。
    早先这同一笔账在后端算一遍、前端算一遍、播放版再算一遍，三处判据稍有出入
    就是「正向拖一个画面、反向拖另一个画面」这类鬼故事。

    两种形态（都是续接合成的**正常产物**，没有谁有病）：
      · 累积片（「到本段为止的整条」）：片子长到能盖住本段末尾，开头那
        ``clip_from`` 帧是前面几段 → head = clip_from；
      · 单段片（只含承接重叠）：head = 头部承接窗口 trim。

    ``head_trim`` 是这段净账里的**头部**承接帧数（trim_frames，首段 0），必须
    与尾钉（trim_tail）分开：单段片总长 = trim(头) + 净长 + tail(尾)，旧内容
    不只在开头、还可能在末尾（往前接 / 补桥 / 循环 / 断链后残留尾钉）。早先
    ``head = ff - 净长`` 把**头尾两端**的旧帧全算进了开头，带尾钉的段导出时
    裁切窗口整体往后错了一个 tail、末尾也没把尾钉去掉 —— 显式传 trim 后，
    头部只认头部那截。不传（老调用 / 老档案）退回旧算法，无尾钉时两者等价。
    """
    net = max(1, int(clip_to) - int(clip_from))
    ff = int(film_frames or 0)
    if ff <= 0:
        return 0
    if ff >= int(clip_to):
        # 20261026：``clip_from == 0`` 时累积长度**恰好等于净长**，「累积片」和
        # 「带承接重叠的单段片」两种解释同时成立。旧写法无条件取累积片
        # （head = 0），于是首段开头那 trim 帧承接被当成新画面从第 0 帧用起 ——
        # 导出多留 trim 帧旧画面、末尾反而少 trim 帧真画面。这是「卡片 391 /
        # 轴 430 / 成片 430」的下游那一半。
        # 只加一条判据：片子长到能盖住「承接头 + 净长」，它就不可能是累积片。
        # clip_from > 0 时累积片恒比单段片长，走不到这里，行为与旧版逐字相同。
        if int(clip_from) == 0 and head_trim and ff >= net + int(head_trim):
            return max(0, int(head_trim))
        return max(0, int(clip_from))
    if head_trim is not None:
        return max(0, int(head_trim))
    return max(0, ff - net)


def _seg_cut(r):
    """这一段进成片的裁切窗口 ``(skip, net)`` —— 直接读契约，不算第二遍。

    ``skip`` = 档案里落盘时写死的 ``film_head``。老档案没有这个字段的由
    ``film_summary`` 迁移补写（见那里的补写分支），走到这里必已有值。
    """
    net = max(1, int(r.get("clip_to") or 0) - int(r.get("clip_from") or 0))
    head = r.get("film_head")
    skip = int(head) if head is not None else 0
    return max(0, skip), net


def export_film_plan(name, at=None):
    """「保存成片」动手前的那张清单：拼到哪儿为止 + 哪些段进不了片子。

    字段刻意与 export_plan 同构 —— 前端一套 askExport / exportNotes 两处共用。
    frames / seconds 是**净长口径**（扣掉各段头部承接重叠），与时间轴总长一致，
    不是各段文件长度之和。
    """
    fs = film_summary(name)
    rows = fs["clips"]
    fps = float(fs.get("fps") or FRAME_FPS) or float(FRAME_FPS)
    broken = fs.get("broken") or []

    def brief(r):
        return {"index": r["index"], "name": r["name"],
                "frames": r["frames"], "playable": r["playable"]}

    if at:
        pick = next((r for r in rows if r["id"] == at), None)
        if pick is None:
            return {"name": name, "ok": False, "blocker": "no_such_clip",
                    "beyond": [], "pending": [], "broken": broken,
                    "total_clips": len(rows),
                    "message": "没有这一段：%s" % at}
        cut = pick["index"]
    else:
        # 默认拼到最后一段有成片的地方 —— 不是最后一段（它可能压根没跑过）。
        cut = 0
        for r in rows:
            if r["playable"]:
                cut = r["index"]

    picks = [r for r in rows if r["index"] <= cut]
    _stage = current_stage(name)
    _variant = current_variant(name)
    _stage_label = "二采" if _stage == "s2" else "一采"
    # 20261111 方案 B：轨静音改的是**驱动混音**，但已渲染的 mp4 里那条音轨
    # 已经混进去了 —— H3 成片只有一条 AV 音轨，导出阶段物理上抽不掉。
    # 用「静音最后一次生效时间」比对成片 mtime，点名还是旧混音的段，
    # 引导重跑，而不是假装能改旧文件。
    mute_at = 0.0
    mute_stale = []
    try:
        _d = store.chain_dir(name)
        if store.ensure_db(_d) == "db":
            _mc = store._connect(_d, create=False)
            if _mc is not None:
                mute_at = float(store._meta_get(_mc, "bzsa.mute_at", 0) or 0)
    except Exception:
        mute_at = 0.0
    if mute_at > 0:
        for r in picks:
            if not r.get("playable"):
                continue
            _p = r.get("film")
            try:
                _mt = os.path.getmtime(_p) if _p else 0.0
            except OSError:
                _mt = 0.0
            if _mt and _mt < mute_at:
                mute_stale.append(int(r["index"]))
    film_mute_warning = ""
    if mute_stale:
        film_mute_warning = (
            "时间轴上有音轨被静音，第 %s 段的成片还是静音前那一版 —— "
            "导出拼的是已渲染的 mp4，抽不掉混进去的音轨，请重跑这几段再导出。"
            % "、".join(str(x) for x in mute_stale))
    common = {
        "name": name,
        "stage": _stage,
        "variant": _variant,
        "variant_label": FILM_VARIANT_LABEL[_variant],
        "mute_stale_clips": mute_stale,
        "film_mute_warning": film_mute_warning,
        # 20261111 阶段 C：成片已按 (段, 版本, 阶段, 变体) 分开落盘，导出计划
        # 必须写明这次拼的是哪一份，否则用户切了「用二采原片」却不知道生效没有。
        "film_stage_warning": (
            "本次导出用「%s」·「%s」。"
            % (_stage_label, FILM_VARIANT_LABEL[_variant]) if _stage == "s2" else
            "本次导出用「一采」成片（一采只有一份）。"),
        "beyond": [brief(r) for r in rows if r["index"] > cut],
        "pending": [{"index": r["index"], "name": r["name"],
                     "kind": r["pending"],
                     "text": PENDING_TEXT.get(r["pending"], r["pending"]),
                     "frames": r["frames"]}
                    for r in picks if r.get("pending")],
        "broken": broken,
        "total_clips": len(rows),
    }

    if not any(r["playable"] for r in picks):
        return dict(common, ok=False, blocker="no_film",
                    missing=[brief(r) for r in picks if not r["playable"]],
                    message="这部片子还没有任何一段生成过成片 —— 先跑一次再来保存。")
    missing = [r for r in picks if not r["playable"]]
    if missing:
        # 中间缺段拼不成整条：跳过它会让连接处凭空跳戏，宁可明说。
        return dict(common, ok=False, blocker="missing_clips",
                    missing=[brief(r) for r in missing],
                    message="第 %s 段的成片不在磁盘上（被手动清了？）—— "
                            "中间缺段的片子拼不成整条，先把这几段补跑出来再保存。"
                            % "、".join(str(r["index"]) for r in missing))

    last = picks[-1]
    frames = int(last["clip_to"])          # 净长 = 最后一段的 clip_to
    out_file = "%s_成片.mp4" % _safe_file_part(name)
    # 帧数不够的段要点名：本段在成片里应有的位置（skip+net）超出了这条片子
    # 的实际长度 —— 说明这条片子不是"到这一段为止的整条"（比如接的是一段
    # 外来的源片，或重抽后长度变了）。裁出来的一截位置不对，拼进去就是重播
    # 或跳戏。不说的话用户只会觉得"成片怎么老重播"。
    short = []
    for r in picks:
        skip, net = _seg_cut(r)
        ff = int(r.get("film_frames") or 0)
        if ff and skip + net > ff:
            short.append({"index": r["index"], "name": r["name"],
                          "film_frames": ff, "want": skip + net})
    # 承接帧数只有一个真值：档案里的 trim_frames。面板 state.cont.frames 是
    # 用户意图，两者对不上说明登记那一步把值写丢了 —— 导出会按 0 剪头，
    # 接缝重复播一截。只提示不阻断：独立成段的用户本来就填 0。
    trim_notes = []
    for r in picks:
        if int(r.get("index") or 0) <= 1:
            continue
        m = load_clip(name, r.get("id")) or {}
        st = m.get("state")
        if not isinstance(st, dict) and isinstance(m.get("meta"), dict):
            st = m["meta"].get("state")
        if not isinstance(st, dict):
            continue
        want = int((st.get("cont") or {}).get("frames") or 0)
        got = int(r.get("trim_frames") or 0)
        if want > 0 and want != got:
            trim_notes.append({"index": int(r["index"]),
                               "panel": want, "archive": got})
    if trim_notes:
        print("[H3 档案] ⚠ 承接帧数对不上：%s —— 成片接缝会重复播放一截，"
              "请重跑这几段再导出。"
              % "；".join("第%d段(面板%d/档案%d)"
                         % (x["index"], x["panel"], x["archive"])
                         for x in trim_notes))

    # 20261106 v2 阶段 ④：把「只提示不阻断」的 short / trim_notes 升级为硬门禁，
    # 并补帧账 / 待办 / 成片 / 帧率检查。BZ_EXPORT_GATE=0 可应急关闭。
    gate = []
    if os.environ.get("BZ_EXPORT_GATE", "1").strip() != "0":
        try:
            from .core.csglide_export_gate import export_gate
        except ImportError:
            from .core.csglide_export_gate import export_gate
        gate = export_gate(fs, {"at_index": cut, "short": short,
                                "trim_notes": trim_notes})
    if gate:
        print("[H3 档案] 导出门禁拒绝：%s" % "；".join(gate))
        return dict(common, ok=False, blocker="export_gate", gate=gate,
                    trim_notes=trim_notes, at=last["id"], at_index=cut,
                    at_name=last["name"], clips=len(picks), frames=frames,
                    seconds=(frames / fps) if fps else 0.0,
                    path=os.path.join(chain_dir(name), out_file),
                    file=out_file, short=short,
                    message="导出门禁未通过：" + "；".join(gate))
    return dict(common, ok=True, blocker=None,
                trim_notes=trim_notes,
                at=last["id"], at_index=cut, at_name=last["name"],
                clips=len(picks), frames=frames,
                seconds=(frames / fps) if fps else 0.0,
                path=os.path.join(chain_dir(name), out_file),
                file=out_file, short=short,
                message="")


def _audio_track(path):
    """成片的第一条音轨 → (int16 [n, ch], 采样率)。没有音轨 / 读不出来 → (None, 0)。

    整条解进内存：几分钟片子的音轨也就几十 MB int16，换来后面按采样点精确
    裁头、按段首尾相接的省事。"""
    try:
        import numpy as np
        import av
    except Exception:      # pragma: no cover - 依赖缺失在 export_film 里统一报
        return None, 0
    try:
        with av.open(path) as c:
            if not c.streams.audio:
                return None, 0
            st = c.streams.audio[0]
            sr = int(st.rate or 48000)
            ch = int(st.layout.nb_channels)
            chunks = []
            for fr in c.decode(audio=0):
                a = fr.to_ndarray()
                if a.ndim == 1:
                    a = a[None, :]
                if a.dtype != np.int16:
                    f = a.astype(np.float32)
                    if f.max() > 1.5:          # 整型刻度只是存成了 float
                        f = f / 32768.0
                    a = np.clip(f * 32767.0, -32767, 32767).astype(np.int16)
                if a.shape[0] == 1 and ch > 1:      # 交织打包：[1, n*ch]
                    a = a.reshape(-1, ch)
                elif a.shape[0] == ch:              # 平面：[ch, n]
                    a = a.T
                chunks.append(np.ascontiguousarray(a, dtype=np.int16))
        if not chunks:
            return None, sr
        return np.concatenate(chunks, axis=0), sr
    except Exception:
        return None, 0


def _tmp_out(path):
    """同目录下的一次性临时名。并发两次导出绝不能落到同一个文件名上 ——
    写同一份临时文件的后果不是"后一次覆盖前一次"，而是两份 ffmpeg 同时往里
    写、先完成的那次把文件改名成成片、后一次的句柄跟着过去把成片写坏
    （实测确实产出过 1560 帧满屏 Invalid NAL unit size 的成片）。
    后缀必须还是 .mp4：concat_preview_fast 末尾用 PyAV 读回时长，认不出别的。"""
    return "%s.%d-%s.tmp.mp4" % (path, os.getpid(), uuid.uuid4().hex[:8])


def _replace_retry(src, dst, tries=4):
    """Windows 上 os.replace 会因为目标被别的进程打开（播放器 / 缩略图 /
    杀毒扫描）直接 WinError 32 —— 这跟"写失败"是两回事，重试几次多半就过。
    仍不行就报人话，别把原始异常甩给前端。"""
    last = None
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.3 * (i + 1))
    raise RuntimeError("成片文件正被其他程序占用（播放器 / 杀毒扫描）—— "
                       "关掉它再点一次「保存成片」。（%s）" % last)


def _join_film(jobs, picks, plan, out_fps):
    """整片一次重编码 + 接缝平滑；走不通再退回流复制。成功返回结果字典，
    都不成就返回 None，交给调用方走 PyAV 逐帧重编码那条路。

    调用方必须持 `_FILM_EXPORT_LOCK`：归档模块每生成一个播放版都会顺带触发
    一次整片导出，并发是常态 —— 写盘这一段只能串行。"""
    jp = _join_panel()
    if jp is None:
        return None

    # 优先：与监视器完全同一条拼接。流复制会把单帧突变原样留下（实测交界
    # 帧间差 1.92，重编码后 1.48），"界面顺、导出跳"就是两条路径不一样造成的。
    fast = getattr(jp, "concat_preview_fast", None)
    if fast is not None:
        tmp = _tmp_out(plan["path"])
        try:
            try:
                res = fast(jobs, tmp,
                           seam_frames=getattr(jp, "SEAM_BLEND_FRAMES", 4))
            except Exception as exc:
                res = {"ok": False, "why": "fast_exc", "detail": repr(exc)}
            if res.get("ok"):
                want = int(plan["frames"])
                got = int(res.get("frames") or 0)
                if got == want:      # 帧口径裁帧后必须严丝合缝，差一帧都不收
                    _replace_retry(tmp, plan["path"])
                    v_secs = float(res.get("video_seconds") or 0.0) or (
                        got / out_fps if out_fps else 0.0)
                    a_secs = float(res.get("audio_seconds") or 0.0)
                    print("[H3 档案] 保存成片（整片重编码 + 接缝平滑）："
                          "%d 段 -> %s（%d/%d 帧 @ %.3f fps）"
                          % (len(picks), plan["path"], got, want, out_fps))
                    return {"ok": True, "path": plan["path"],
                            "file": plan["file"], "frames": got,
                            "seconds": v_secs, "clips": len(picks),
                            "at_index": plan["at_index"],
                            "audio": bool(a_secs),
                            "audio_seconds": round(a_secs, 3),
                            "drift": round(abs(v_secs - a_secs), 3),
                            "expected_frames": want, "lossless": False,
                            "encode": {"video": "libx264 crf17 veryfast"
                                                "（整片一次重编码 + 接缝 4 帧平滑）",
                                       "audio": "aac 128k"}}
                print("[H3 档案] ⚠ 整片重编码帧数对不上（%d/%d），退回无损拼接"
                      % (got, want))
            else:
                print("[H3 档案] 整片重编码没走成（%s），退回无损拼接：%s"
                      % (res.get("why"), res.get("detail") or ""))
        finally:
            # 只删自己这一份：文件名带 pid + uuid，删不到别人的。
            if os.path.isfile(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass

    res = jp.concat_play_films(jobs, plan["path"])
    if res.get("ok"):
        want = int(plan["frames"])
        got = int(res.get("frames") or 0)
        a_secs = float(res.get("audio_seconds") or 0.0)
        v_secs = float(res.get("video_seconds") or 0.0)
        print("[H3 档案] 保存成片（无损拼接）：%d 段 -> %s（%d/%d 帧 @ %.3f fps，"
              "流复制）" % (len(picks), plan["path"], got, want, out_fps))
        if got and abs(got - want) > 1:
            print("[H3 档案] ⚠ 成片帧数对不上时间轴：%d 帧 / 应为 %d 帧"
                  % (got, want))
        if v_secs and a_secs and abs(v_secs - a_secs) > 0.05:
            print("[H3 档案] ⚠ 成片音画不等长：画面 %.3fs / 声音 %.3fs"
                  % (v_secs, a_secs))
        return {"ok": True, "path": plan["path"], "file": plan["file"],
                "frames": got,
                "seconds": v_secs or (got / out_fps if out_fps else 0.0),
                "clips": len(picks), "at_index": plan["at_index"],
                "audio": bool(a_secs), "audio_seconds": round(a_secs, 3),
                "drift": round(abs(v_secs - a_secs), 3),
                "expected_frames": want,
                "lossless": True,
                "encode": {"video": "copy（流复制 —— 拼接零损失）",
                            "audio": "copy（流复制 —— 拼接零损失）"}}
    print("[H3 档案] 无损拼接没走成（%s），退回重编码：%s"
          % (res.get("why"), res.get("detail") or ""))
    return None


def export_film(name, at=None):
    """把时间轴上所有段拼成一条完整成片，写进档案目录，覆盖旧的那份。

    拼接口径与时间轴一致：第 k（k>0）段视频开头 trim 帧是上一段末尾的重绘
    （承接重叠），拼接时把它裁掉（第一段 trim=0 不裁）；音轨按同样的秒数裁。
    画面、声音都要重编码 —— trim 落点几乎不可能是关键帧，流复制会花屏。
    先写 .part 临时文件、拼完再改名：中途失败不会留下半条片子冒充成片。
    """
    plan = export_film_plan(name, at)
    if not plan.get("ok"):
        return plan
    try:
        import numpy as np
        import av
        from fractions import Fraction
    except Exception as e:      # pragma: no cover
        return {"ok": False, "blocker": "no_av",
                "message": "拼接需要 PyAV（ComfyUI 自带），当前环境读不到：%s" % e}

    fs = film_summary(name)
    rows = fs["clips"]
    picks = [r for r in rows if r["index"] <= plan["at_index"]]

    # 画布校验：跨段分辨率不一致（重抽时换过画布）拼出来必花屏 —— 明确报错，
    # 让用户去统一画布，而不是得到一条能播但看着不对的片子。
    dims = []
    for r in picks:
        try:
            with av.open(r["film"]) as c:
                vs = c.streams.video[0]
                dims.append((int(vs.width), int(vs.height),
                             float(vs.average_rate or 0)))
        except Exception:
            dims.append(None)
    bad = [r["index"] for r, d in zip(picks, dims) if d is None]
    if bad:
        return {"ok": False, "blocker": "unreadable_film",
                "message": "第 %s 段的成片文件读不出来（可能没写完 / 被占用）—— "
                           "重新渲染这几段再保存。"
                           % "、".join(map(str, bad))}
    if len(set((d[0], d[1]) for d in dims)) > 1:
        detail = "、".join("第%d段%dx%d" % (r["index"], d[0], d[1])
                          for r, d in zip(picks, dims))
        return {"ok": False, "blocker": "size_mismatch",
                "message": "各段分辨率不一致，拼不成一条片子（%s）—— "
                           "把画布统一后重跑不一致的段。" % detail}

    out_fps = dims[0][2] or float(fs.get("fps") or FRAME_FPS) or float(FRAME_FPS)

    # 帧数够不够：某段的成片比它应有的净长还短，裁完就少写帧，视频比音频短
    # —— 又是一条音画错开的片子。动手之前先把话说清楚，别让用户在播放器里
    # 自己去发现声音对不上嘴。film_frames 是档案里记的实测帧数（film_summary
    # 会现探一次并写回），拿它当依据不必再解一遍。
    short = []
    for r in picks:
        skip, net = _seg_cut(r)
        ff = int(r.get("film_frames") or 0)
        if ff and skip + net > ff:
            short.append("第%d段只有%d帧、要%d帧" % (r["index"], ff, skip + net))
    if short:
        return {"ok": False, "blocker": "short_film",
                "message": "有段的成片帧数不够（%s）—— 重跑这几段再保存，"
                           "缺帧拼出来音画会错开。" % "、".join(short)}

    # 拼接口径：先试「整片一次重编码 + 接缝平滑」——与监视器完全同一条路径；
    # 不行再退「各段播放版 + 流复制」（零重编码，但单帧突变会原样保留）；两条
    # 都不成才落到下面 PyAV 逐帧重编码。
    jobs = []
    for r in picks:
        skip, net = _seg_cut(r)
        jobs.append((r["film"], out_fps, skip, net))
    # 写盘只能串行：归档模块每生成一个播放版都会顺带触发一次整片导出，并发是
    # 常态。临时名也必须本次独有（见 _tmp_out）—— 两次 ffmpeg 同写一份临时
    # 文件时，先完成的把文件改名成成片、后一个的句柄跟着过去，把成片写坏。
    with _FILM_EXPORT_LOCK:
        try:
            done = _join_film(jobs, picks, plan, out_fps)
        except RuntimeError as exc:
            # 成片被别的程序占住（替换失败）。当日志 + 人话返回，
            # 不让前端拿到 500 和一堆堆栈 —— 用户看不懂，也不该看到。
            print("[H3 档案] 保存成片失败：%s" % exc)
            return {"ok": False, "blocker": "file_locked", "message": str(exc)}
    if done is not None:
        return done


    # 音轨：全部段都有、且采样率一致才带声音；否则明说，不出一条音画错位的片子。
    # 这里只**读**音轨并核对采样率，拼接要等画面写完 —— 每段取多少样本取决于
    # 那段实际写出了几帧（见下面的 wrote），不是取决于账面上的净长。
    full_audio = None
    tracks = [_audio_track(r["film"]) for r in picks]
    wavs = [t[0] for t in tracks]
    rates = set(t[1] for t in tracks if t[0] is not None)
    if all(w is None for w in wavs):
        sr = 0
    elif not all(w is not None for w in wavs) or len(rates) != 1:
        return {"ok": False, "blocker": "audio_mismatch",
                "message": "各段的音轨不一致（有的没声音 / 采样率不同）—— "
                           "把没声音的段重跑出来再保存。"}
    else:
        sr = rates.pop()

    out_path = plan["path"]
    tmp_path = out_path + ".part"
    W, H = dims[0][0], dims[0][1]
    out = None
    with _FILM_EXPORT_LOCK:
        try:
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            # format 显式给 mp4：临时文件后缀是 .part，PyAV 推断不出容器
            out = av.open(tmp_path, "w", format="mp4")
            vs = out.add_stream("libx264",
                                rate=Fraction(out_fps).limit_denominator())
            vs.width, vs.height, vs.pix_fmt = W, H, "yuv420p"
            # 画面要重编码（trim 落点几乎不可能落在关键帧，流复制会花屏），
            # 所以这是**二次有损**：段片已经是 h264，再过一遍编码器必然掉一点。
            # crf 12 + preset medium 是"肉眼挑不出"那一档 —— 原来 crf 18/fast
            # 把 1.9 Mbps 的段片压到 868 kbps，掉了一半码率，画质肉眼可见地软。
            # 小画面（576×320 这个量级）跑 medium 也就多几秒，值。
            vs.options = {"crf": "12", "preset": "medium"}
            # 音轨流必须**在第一次 mux 之前**建好（header 还没写）；等视频
            # 全部写完再 add_stream 会得到 "Cannot rebase to zero time"。
            # 音频**数据**仍在视频之后喂（与 join 同款次序），只是流先占坑。
            out_as = None
            if sr:
                ch = int(tracks[0][0].shape[1])
                out_as = out.add_stream("aac", rate=int(sr))
                out_as.layout = "stereo" if ch >= 2 else "mono"
                # 音轨同样是二次有损（AAC→PCM→AAC）。256k 在 32 kHz 立体声下
                # 已远超"听不出差别"的门槛，留足余量，别让音质成为新的疑点。
                out_as.bit_rate = 256000
            vframe = 0
            wrote = []        # 每段**实际**写出几帧 —— 音频按它取样本，见下
            for r in picks:
                skip, net = _seg_cut(r)
                n = 0
                with av.open(r["film"]) as c:
                    s = c.streams.video[0]
                    s.thread_type = "AUTO"
                    for idx, frame in enumerate(c.decode(video=0)):
                        if idx < skip:
                            continue
                        # 净长之外的帧不进成片。这一段漏了会怎样（20261010 实测）：
                        # 第 1/3 段的成片是累积片（226 / 243 帧），被整条倒进去，
                        # 成片 498 帧 20.75 秒，而音频只按净长裁了 10.14 秒 ——
                        # 后半条整段没声音，前半条音画错位，听感就是"糊"。
                        if idx >= skip + net:
                            break
                        arr = frame.to_ndarray(format="rgb24")
                        nf = av.VideoFrame.from_ndarray(
                            np.ascontiguousarray(arr), format="rgb24")
                        nf.pts = vframe
                        for pkt in vs.encode(nf):
                            out.mux(pkt)
                        vframe += 1
                        n += 1
                wrote.append(n)
            for pkt in vs.encode(None):
                out.mux(pkt)

            if out_as is not None:
                # 每段音频严格取"这一段画面实际写出几帧"对应的样本数 ——
                # 音块 = 画面块，逐段对齐。
                # 为什么不按账面净长取：源片的帧数常有 1~2 帧的取整误差
                # （容器/编码器各舍入一次），画面少写一帧、声音照取满的话，
                # 每过一个接缝就漂一点，段一多就听得出来（实测一次差 42ms）。
                # AAC 每段解码出来的 PCM 头尾还带编码器 padding（每段多 ~17ms），
                # 照单全收漂得更厉害 —— 所以只取该取的那一段，一帧不多。
                # 接缝处再加 6ms 淡入：各段波形任意相位硬切相接会咔哒一声。
                pieces = []
                fade = max(0, int(round(sr * 0.006)))
                for i, ((wav, _sr), n) in enumerate(zip(tracks, wrote)):
                    vskip, _net = _seg_cut(picks[i])
                    start = int(round(vskip / out_fps * sr))
                    take = int(round(n / out_fps * sr))
                    piece = wav[start:start + take]
                    if piece.shape[0] < take:   # 音轨比画面短：尾部补静音
                        piece = np.vstack([piece, np.zeros(
                            (take - piece.shape[0], piece.shape[1]), dtype=np.int16)])
                    if fade and i > 0 and piece.shape[0] > fade:
                        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)[:, None]
                        piece = piece.astype(np.float32)
                        piece[:fade] *= ramp
                        piece = piece.astype(np.int16)
                    pieces.append(piece)
                wav = np.concatenate(pieces, axis=0)
                full_audio = (wav, sr)
                ch = int(wav.shape[1])
                pts, step = 0, 1024
                for off in range(0, wav.shape[0], step):
                    chunk = wav[off:off + step]
                    if chunk.shape[0] < step:
                        pad = np.zeros((step - chunk.shape[0], ch), dtype=np.int16)
                        chunk = np.vstack([chunk, pad])
                    packed = np.ascontiguousarray(chunk.T).reshape(1, -1)
                    af = av.AudioFrame.from_ndarray(
                        packed, format="s16", layout=out_as.layout)
                    af.sample_rate = int(sr)
                    af.pts = pts
                    pts += step
                    for pkt in out_as.encode(af):
                        out.mux(pkt)
                for pkt in out_as.encode(None):
                    out.mux(pkt)

            out.close()
            out = None
            os.replace(tmp_path, out_path)
        except Exception as e:
            if out is not None:
                try:
                    out.close()
                except Exception:
                    pass
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            return {"ok": False, "blocker": "encode_failed",
                    "message": "拼接写片失败（文件被播放器占用？）：%s" % e}

    # 对账：视频帧数必须与时间轴的净长一致、音频秒数必须与视频一致。
    # 这一条就是「音频糊」那次事故的东西 —— 差一点点都会变成声音对不上嘴，
    # 而用户在播放器里只看得到"声音怪"，看不出差在哪。写进日志，一眼能核对。
    want = int(plan["frames"])
    a_secs = (full_audio[0].shape[0] / float(full_audio[1])) if full_audio else 0.0
    v_secs = (vframe / out_fps) if out_fps else 0.0
    drift = abs(v_secs - a_secs) if full_audio else 0.0
    print("[H3 档案] 保存成片：%d 段 -> %s（%d/%d 帧 @ %.3f fps，净长口径）"
          % (len(picks), out_path, vframe, want, out_fps))
    if vframe != want:
        print("[H3 档案] ⚠ 成片帧数对不上时间轴：写了 %d 帧、应为 %d 帧"
              " —— 有段的成片比它应有的净长短" % (vframe, want))
    if full_audio and drift > 0.05:
        print("[H3 档案] ⚠ 成片音画不等长：画面 %.3fs、声音 %.3fs（差 %.3fs）"
              % (v_secs, a_secs, drift))
    return {"ok": True, "path": out_path, "file": plan["file"],
            "frames": vframe, "seconds": v_secs,
            "clips": len(picks), "at_index": plan["at_index"],
            "audio": full_audio is not None,
            "audio_seconds": round(a_secs, 3),
            "drift": round(drift, 3),
            "expected_frames": want,
            "lossless": False,
            "encode": {"video": "libx264 crf=12 preset=medium（重编码，二次有损）",
                       "audio": "aac %d bps（重编码，二次有损）"
                                % (256000 if full_audio else 0)}}


def preview_film(name, ensure=True):
    """整片连续预览片：把当前所有可播段按顺序拼成【一条】mp4（流复制、帧精确），
    供导演台连播 / 跨段拖动播放。前端只面对单 video、单条连续时间轴，跨接缝是
    同一条视频里的普通位置，从根上消除"两个独立 video 交接偶发黑帧"。

    与 export_film 同构但更轻：拼到最后一个可播段、输出固定文件名、按签名缓存
    （段内容/顺序没变就复用，不重拼）。ensure=False 只读取当前缓存状态、不拼接。
    """
    fs = film_summary(name)
    rows = [r for r in (fs.get("clips") or []) if r.get("playable")]
    fps = float(fs.get("fps") or FRAME_FPS) or float(FRAME_FPS)
    base = {"name": name, "fps": fps}
    if not rows:
        return dict(base, ok=False, blocker="no_film",
                    message="还没有可播放的段，先渲染一段。")
    frames_total = int(rows[-1]["clip_to"])
    # 签名：参与段的 身份/版本/净长/源片 + 顺序，任一变化即失效重拼。
    # pv3：裁帧改帧口径（旧缓存是秒口径拼的，会少几帧），必须失效重拼一次。
    sig = "pv3|" + "|".join(
        "%s:%s:%s:%s" % (r.get("id"), r.get("updated"),
                         int(r.get("clip_to") or 0), r.get("film"))
        for r in rows)
    d = chain_dir(name)
    out = os.path.join(d, "_preview.mp4")
    side = out + ".sig"
    cached_sig = None
    if os.path.isfile(out):
        try:
            with open(side, encoding="utf-8") as fh:
                cached_sig = fh.read().strip()
        except OSError:
            cached_sig = None
    if os.path.isfile(out) and cached_sig == sig:
        return dict(base, ok=True, path=out, frames=frames_total,
                    seconds=(frames_total / fps) if fps else 0.0,
                    signature=sig, cached=True, clips=len(rows))
    if not ensure:
        return dict(base, ok=False, blocker="stale",
                    signature=sig, frames=frames_total, clips=len(rows))
    jp = _join_panel()
    if jp is None:
        return dict(base, ok=False, blocker="no_join_panel")
    jobs = []
    for r in rows:
        skip, net = _seg_cut(r)
        jobs.append((r["film"], fps, skip, net))
    # 快速路径：一条 ffmpeg、只重编码一次；走不通（混合音频 / 参数不一致 / 失败）
    # 回退"逐段播放版 + concat 流复制"的稳妥路径。
    res = None
    fast = getattr(jp, "concat_preview_fast", None)
    if fast is not None:
        try:
            res = fast(jobs, out,
                       seam_frames=getattr(jp, "SEAM_BLEND_FRAMES", 4))
        except Exception as exc:
            res = {"ok": False, "why": "fast_exc", "detail": repr(exc)}
    if not (res and res.get("ok")):
        try:
            res = jp.concat_play_films(jobs, out)
        except Exception as exc:
            return dict(base, ok=False, blocker="concat_failed", why="exc",
                        detail=repr(exc))
    if not res.get("ok"):
        return dict(base, ok=False, blocker="concat_failed",
                    why=res.get("why"), detail=res.get("detail"))
    try:
        with open(side, "w", encoding="utf-8") as fh:
            fh.write(sig)
    except OSError:
        pass
    got = int(res.get("frames") or 0) or frames_total
    return dict(base, ok=True, path=out, frames=got,
                seconds=float(res.get("video_seconds") or 0.0)
                        or (got / fps if fps else 0.0),
                signature=sig, cached=False, clips=len(rows),
                audio_seconds=float(res.get("audio_seconds") or 0.0))


# ---------------- 整片预览后台预热（20261011）----------------
_prewarm_running = set()      # 已在后台预热的片名（去重）
_prewarm_timers = {}          # 待启动的防抖计时器


async def _prewarm_task(name):
    try:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, preview_film, name, True)
        if res.get("ok"):
            print("[H3 档案] 整片预览已预热：%s（%d 帧）"
                  % (name, int(res.get("frames") or 0)))
            # T3：顺带在后台把各段默认档雪碧图落盘（失败不影响整片预热）。
            jp = _join_panel()
            warm = getattr(jp, "warm_project_sprites", None) if jp is not None else None
            if warm is not None:
                def _warm():
                    return warm(film_summary(name).get("clips") or [])
                try:
                    n = await loop.run_in_executor(None, _warm)
                    if n:
                        print("[H3 档案] 时间轴缩略图已预生成：%s（%d 段）"
                              % (name, int(n)))
                except Exception:
                    pass
    except Exception as exc:
        print("[H3 档案] 整片预览预热失败：%r" % (exc,))
    finally:
        _prewarm_running.discard(name)


def _launch_prewarm(name):
    _prewarm_timers.pop(name, None)
    if not name or name in _prewarm_running:
        return
    _prewarm_running.add(name)
    try:
        asyncio.ensure_future(_prewarm_task(name))
    except RuntimeError:
        _prewarm_running.discard(name)


def schedule_prewarm(name, delay=1.2):
    """收片 / 全部渲染完成后调用：后台拼好整片预览片（不阻塞、同名去重、短延时
    防抖以合并连续收片）。ffmpeg 是同步 subprocess，统一丢线程池、不堵事件循环。"""
    if not name:
        return
    old = _prewarm_timers.get(name)
    if old is not None:
        old.cancel()
    try:
        loop = asyncio.get_event_loop()
        _prewarm_timers[name] = loop.call_later(max(0.0, delay), _launch_prewarm, name)
    except RuntimeError:
        pass


# ================= 工程库（P3）已于 20261012 应要求移除 =================
# 原工程库浏览 / 命名版本 / 回收站 / 模板新建 / 缩略图 / zip 打包下载相关函数，
# 以及 /cglide/chain/library/*、/thumb、/reveal 路由已整体删除（前端
# csglide_cast_library.js 与「工程库」按钮同步移除）。核心段落档案能力
# （move_clip / rename_chain / remove_clip / sync_check / summary 等）保留。


def move_clip(name, cid, to_index):
    chain = load_chain(name)
    order = chain.get("order", [])
    if cid not in order:
        return chain
    order.remove(cid)
    order.insert(max(0, min(len(order), int(to_index))), cid)
    chain["order"] = order
    save_chain(name, chain)
    return chain


# 原 _repoint_paths（递归把 clip.json 里的旧绝对路径换成新路径）已于 20261020
# 随方案 G 删除：改名不再搬目录，绝对路径一个字节都没变，不需要回写。
# 将来若真要做「物理搬目录」，可到 csglide_chain.py.bak_gindex_20261020 找回。


@chainlocked
def rename_chain(name, new_name):
    """给整条片子改名 —— **只改索引，目录一个字节都不动**（方案 G，20261020）。

    以前改名 = os.rename(整个目录)，在 Windows 上天生脆弱：目录里只要有**任何
    一个**文件被打开，系统就拒绝改目录名（PermissionError WinError 5，已本地
    复现）。而"刚渲染完想改个名"恰恰是句柄最多的时候 —— 成片刚写完、预览可能
    还开着、SQLite 连接还在。

    现在目录一旦建好就**永远不动**，片名只是索引里的一条记录。连带省掉三件事：
      · 不再需要 _repoint_paths / repath_db —— 绝对路径没变，改完名数据照样对得上；
      · 不需要关 SQLite 连接再重开（以前是搬目录的前提）；
      · 素材目录（input/cglide/<片名>/）也不搬 —— 它按片名算，改名后新导入的
        素材落在新名下，老槽位指向旧目录照样读得到（代价：一个工程的素材可能
        分在两个目录，但**不会错**，只是不整齐）。

    新名字已被别的片子占用就拒绝：宁可没改成，也不能让两条片子共用一个目录。
    """
    old = (name or "").strip()
    new = (new_name or "").strip()
    if not new:
        return {"renamed": False, "reason": "新片名是空的"}
    if old == new:
        return {"renamed": True, "from": old, "to": new, "moved": False}
    src = chain_dir(old)
    if not os.path.isdir(src):
        # 一次都没渲染过、还没有档案目录：改个名而已，连索引都不用登记 ——
        # 没登记过就走老规则（目录名 = 片名），将来第一次渲染时自然建出来。
        return {"renamed": True, "from": old, "to": new, "moved": False}
    # 判重用 chain_dir（它会自动查索引）：新名字若已被占用，解析出的目录必然
    # 存在且不是我们自己的目录。
    dst = chain_dir(new)
    if os.path.isdir(dst) and os.path.normpath(dst) != os.path.normpath(src):
        return {"renamed": False,
                "reason": "已经有一条片子叫「%s」了，换一个名字" % new}

    dirname = os.path.basename(src)
    # 索引里改键（内部先写新键再删旧键，中间崩溃不会让旧键残留）。
    # old 没登记过 = 老工程，这时补登记一条即可。
    if not store.rename_index_key(old, new):
        store.set_dir_of(new, dirname)
        store.drop_dir_of(old)
    # chain.json 里的名字同步一份：按名字找片子时不会翻出旧名。
    try:
        c = load_chain(new)
        c["name"] = new
        save_chain(new, c)
    except Exception:
        pass
    # 「最近登记过的片名」也跟着走，否则 💾/📤 还去旧名里找。
    try:
        if last_name() == old:
            mark_last(new)
    except Exception:
        pass
    # 旧名作废、新名刷新（前端 store 清旧缓存后订阅新名）
    ws_broadcast("renamed", old, new_name=new)
    ws_broadcast("chain", new)
    return {"renamed": True, "from": old, "to": new, "moved": False,
            "dir": dirname}


def _repath_pairs(src_dir, dst_dir):
    """复制档案后要做的路径替换对：旧前缀 → 新前缀。

    为什么非要改：clip 文档里 ``film`` 与 ``take_params.*.cont_saved`` 存的是
    **绝对路径**（``...\\output\\h3_chain\\片名\\clip_0001.t3.mp4``）。原样复制
    的话副本播的是原片的文件 —— 原片一删就"找不到承接档"，而且两条片子共享
    同一份成片，重抽一边会动到另一边看着像灵异事件。

    四种写法都要准备，因为写进去的代码不止一条路：
      · 绝对路径 + 反斜杠（Windows 上 os.path.join 的产物）；
      · 绝对路径 + 正斜杠（前端/路由里 replace(os.sep, "/") 过的）；
      · 相对 output 的 ``h3_chain\\片名\\``（历史上 relpath 写进档案的）；
      · 相对 output 的正斜杠版本。
    再加一种：**JSON 源码里反斜杠是双写的**（``"K:\\\\...\\\\片名\\\\x.mp4"``），
    所以每种写法还要一个转义版本 —— 少了它，库里的路径一条都换不掉
    （这个坑在自检 _selftest_chain_copy 里被钉住了）。
    """
    src_abs = os.path.abspath(src_dir)
    dst_abs = os.path.abspath(dst_dir)
    sdir, ddir = os.path.basename(src_abs), os.path.basename(dst_abs)
    # os.path.join(x, "") 补出结尾分隔符：只换"这个目录下"的路径，
    # 不碰同前缀的兄弟目录（「片A」vs「片A 2」）。
    s_sep = os.path.join(src_abs, "")
    d_sep = os.path.join(dst_abs, "")
    forms = [
        (s_sep, d_sep),
        (s_sep.replace("\\", "/"), d_sep.replace("\\", "/")),
        ("h3_chain\\" + sdir + "\\", "h3_chain\\" + ddir + "\\"),
        ("h3_chain/" + sdir + "/", "h3_chain/" + ddir + "/"),
    ]
    out, seen = [], set()
    for old, new in forms:
        for o, n in ((old, new), (old.replace("\\", "\\\\"),
                                  new.replace("\\", "\\\\"))):
            if o and o not in seen:
                seen.add(o)
                out.append((o, n))
    return out


def _rewrite_json_paths(dirpath, pairs):
    """把目录里所有 .json 里的旧路径前缀换掉（老 JSON 工程 / 残留的 chain.json）。

    与库那条（store.replace_in_db）互为补充：新工程走库，20261012 之前的老工程
    只有 json 文件。返回改写过的文件数。
    """
    n = 0
    try:
        names = sorted(os.listdir(dirpath))
    except Exception:
        return 0
    for fn in names:
        if not fn.lower().endswith(".json"):
            continue
        p = os.path.join(dirpath, fn)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                s = f.read()
        except Exception:
            continue
        t = s
        for old, new in pairs:
            t = t.replace(old, new)
        if t == s:
            continue
        try:
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(t)
            os.replace(tmp, p)
            _invalidate_json(p)
            n += 1
        except Exception:
            pass
    return n


@chainlocked
def copy_chain(name, new_name):
    """把一条片子的**整份档案**复制到一个新片名下（拖入视频还原，20261107）。

    与 rename_chain 恰好相反：那个只改索引、目录一个字节都不动；这个真复制出
    一份新目录，此后两条片子互不影响 —— 旧片删掉、重抽、改参数，都不会碰到新片。

    复制的范围 = 档案目录里的**全部文件**：段落 json / 成片 mp4（含各版本）/
    续拍存档 cont / 波形 / 播放代理 / project.db。也就是说，时间轴上有几段、
    每段什么参数、点开能不能播，复制完和原片逐字一致。

    复制完还要**改写路径**：clip 文档里 film / take_params.*.cont_saved 存的是
    绝对路径，原样复制的话副本播的是原片的文件 —— 原片一删就"找不到承接档"。
    见 _repath_pairs（连 JSON 里双写的反斜杠一起换）。

    三样东西**不复制**，各有理由：
      · project.db-wal / -shm：新库自己的日志与共享内存，由 SQLite 按需重建；
        拷过去等于告诉新库"有别人没写完的事务"，轻则白读一遍，重则库打不开。
      · _preview.*：采样期间的实时预览缓存（成片监视器用），与片名无关、下一次
        采样就会覆盖。带过去只会在新工程里显示一张旧片尾帧，看着像"复制错了"。
      · input/cglide/<片名>/ 里的素材：库里的槽位记的是 ``cglide/<片名>/x.png``
        这种 input 相对路径，照旧读得到；搬一份等于把用户的图翻倍占盘。改名
        （rename_chain）也不搬素材，两处口径必须一致，否则同一个工程的素材会
        在两种操作后落在不同地方。

    目标名已有档案就**拒绝**（不是覆盖）：覆盖别人的档案是这套东西里唯一
    不可挽回的错，宁可复制失败让用户换个名字。
    """
    src_name = (name or "").strip()
    dst_name = (new_name or "").strip()
    if not src_name or not dst_name:
        return {"copied": False, "code": "bad_name", "reason": "片名是空的"}
    if src_name == dst_name:
        return {"copied": False, "code": "same", "reason": "新旧片名一样"}
    src = chain_dir(src_name)
    if not os.path.isdir(src):
        # 没有档案可复制（视频来自别的机器 / 原片已被删）：由调用方退回
        # 「至少一段」，这里如实报告，不要造一个空档案冒充成功。
        return {"copied": False, "code": "no_src",
                "reason": "源片「%s」没有档案" % src_name}
    dst = chain_dir(dst_name)
    if os.path.exists(dst):
        # 走 chain_dir 解析（改过名的工程目录名 ≠ 片名），所以判的是"这个名字
        # 解析出的目录"是否已被占用，与 unique_chain_name 同口径。
        return {"copied": False, "code": "exists",
                "reason": "已经有一条片子叫「%s」了，换一个名字" % dst_name}

    try:
        # 除库文件外一律照拷（含子目录）：段落 json、各版本 mp4、cont、波形全在里面。
        shutil.copytree(src, dst,
                        ignore=shutil.ignore_patterns("project.db*", "_preview.*"))
        # 库单独走 SQLite 备份：WAL 里没 checkpoint 的写入也带上（理由见 store.copy_db）。
        store.copy_db(src, dst)
    except Exception as e:
        # 半截档案比没有更糟（时间轴上会出现打不开的段）：整目录清掉，让用户重来。
        try:
            store.close_db(dst)
        except Exception:
            pass
        shutil.rmtree(dst, ignore_errors=True)
        return {"copied": False, "code": "error",
                "reason": "%s: %s" % (type(e).__name__, e)}

    # 把副本里指向源目录的绝对路径改到新目录（film / cont_saved 存的是绝对路径，
    # 不改等于"复制成功但播的还是原片"，原片一删就找不到承接档）。
    repathed = 0
    try:
        pairs = _repath_pairs(src, dst)
        if store.has_db(dst):
            store.replace_in_db(dst, pairs)
        repathed = _rewrite_json_paths(dst, pairs)
    except Exception as e:
        print("[H3 Chain] 复制后改写路径失败（段与参数都在，重抽一次即可修正）：", e)

    # 库/JSON 里的片名改成新名（同 rename_chain）：否则按名字找片子会翻出旧名。
    try:
        c = load_chain(dst_name)
        c["name"] = dst_name
        save_chain(dst_name, c)
    except Exception as e:
        print("[H3 Chain] 复制后写新片名失败（不影响使用）：", e)

    ws_broadcast("chain", dst_name)
    # 段数照实回给前端：0 段 = 源片档案是空的（渲染完把段删光了），那时"复制
    # 成功"但轴上还是空 —— 前端据此说话才不会骗人（见 restoreVideoAsNewProject）。
    try:
        seg_n = len([x for x in (load_chain(dst_name).get("order") or []) if x])
    except Exception:
        seg_n = 0
    return {"copied": True, "from": src_name, "to": dst_name,
            "dir": os.path.basename(dst), "sizeMB": _dir_size_mb(dst),
            "segments": seg_n, "json_rewritten": repathed}


def clip_files(name, cid):
    """这一段在档案目录里占用的所有文件（段落 json / 成片 / 潜空间 / 波形 / 各版本）。

    判据是 **文件名以 "<cid>." 开头** —— clip_0001.mp4、clip_0001.cont.safetensors、
    clip_0001.wave.json、clip_0001.t2.mp4 全都算它的；而 clip_00010.json 不会被误伤
    （它不以 "clip_0001." 开头）。这样将来多出什么派生文件也自动跟着走，
    不必每加一种文件就回来改一次删除逻辑。

    「删除这一段」在删之前要把这份清单摆给用户看 —— 删是不可逆的，清单是唯一的依据。
    """
    out = []
    try:
        d = chain_dir(name)
    except Exception:
        return out
    if not os.path.isdir(d):
        return out
    prefix = str(cid) + "."
    for fn in sorted(os.listdir(d)):
        if not fn.startswith(prefix):
            continue
        p = os.path.join(d, fn)
        if not os.path.isfile(p):
            continue
        try:
            size = os.path.getsize(p)
        except Exception:
            size = 0
        out.append({"name": fn, "size": size})
    return out


@chainlocked
def remove_clip(name, cid, force=False):
    """把一段从档案里去掉。

    ``force=False``（默认）只允许删**还没有成片**的空段；``force=True`` 是
    「删除这一段」—— 真删，连同磁盘上的段落 json / 成片（含各版本）/ 潜空间 / 波形
    一起清掉，order 与 current 同步更新。

    为什么默认那条拒绝分支还留着：第 k 段的 film 有可能是「前 k 段累积起来的片子」，
    抽掉中间一段，后面每一段的累积成片都对不上了 —— 那不是"删一段"，那是"从成片里
    剪掉一段"，得走剪辑。所以后端不替用户判断"你大概不是这个意思"，而是把判据留在
    这里，由前端**先把要删哪些文件摆出来**、用户点确认之后才带 force 调进来。
    不可逆的事，确认必须发生在看得见后果的地方。
    """
    chain = load_chain(name)
    order = _dedup_order(chain.get("order"))
    if cid not in order:
        # 允许拿「分段 uid」（meta.shot）来删：工程里还没拿到 clip id 的段
        # （登记失败 / 工程被还原过）也能把档案条目删干净，不再留孤儿。
        for c in order:
            if str((load_clip(name, c) or {}).get("shot") or "") == str(cid):
                cid = c
                break
    if cid not in order:
        return {"removed": False, "reason": "档案里没有这一段"}
    meta = load_clip(name, cid) or {}
    if meta.get("film") and not force:
        return {"removed": False, "reason": "这一段已经拍出成片，不能从档案里抽掉"}
    idx = order.index(cid)
    # 同 id 的历史重复项（旧版发号撞号留下的幽灵）一并清掉；顺手把段落 json
    # 已经丢失的空壳段摘掉 —— 只删第一个同 id 项的话，幽灵留在 order 里，
    # 时间轴与全片时长永远降不回去。
    order = [c for c in order if c != cid and load_clip(name, c) is not None]
    chain["order"] = order
    if chain.get("current") == cid:
        chain["current"] = order[-1] if order else ""
    save_chain(name, chain)

    # DB 工程：段落行连同 state / rack 槽位 / 版本台账一起级联删掉。
    try:
        if store.has_db(chain_dir(name)):
            store.delete_clip_doc(chain_dir(name), cid)
            store.log_event(chain_dir(name), "clip_remove", cid,
                            {"index": idx + 1}, "backend")
    except Exception:
        pass

    # 磁盘清理。单个文件删不掉（被占用等）不抛整条失败 —— 把名字带回去让前端说。
    deleted, failed = [], []
    for f in clip_files(name, cid):
        p = os.path.join(chain_dir(name), f["name"])
        try:
            os.remove(p)
            deleted.append(f["name"])
        except Exception as e:
            failed.append("%s（%s）" % (f["name"], e))

    # 紧接着这一段的那一段，它的引导头本来就是从这一段尾巴来的 —— 那一段没了，
    # 它的续接窗口就悬空了，必须重抽。只在它**确实接着上一段**（有 trim 窗口）时才标，
    # 否则是凭空给用户加一条待办。
    note = None
    nxt = order[idx] if idx < len(order) else None
    if nxt:
        try:
            nm = load_clip(name, nxt) or {}
            if int(nm.get("trim_frames") or 0) > 0:
                _raise_pending(name, nxt, "redo")
                note = ("往后紧接着的第 %d 段原来的续接窗口接的就是这一段，"
                        "已标为「要重抽」" % (idx + 1))
        except Exception:
            pass
    ws_broadcast("clip_removed", name, cid)
    return {"removed": True, "id": cid, "index": idx + 1,
            "files": deleted, "failed": failed, "note": note}


def sync_check(name, shots):
    """「工程预设」vs「档案事实」的冲突清单 —— P1-10 的核心。

    一个 shot 的时长（frames）有**两个写入源**，都合法、都可能被用户改：

      1. 导演台面板的「长度」预设 → 存在工程对象里（跟工作流走，没有时间戳）；
      2. 时间轴拖边缘 → 写磁盘档案（带 updated 时间戳）。

    渲染时 `_register_clip` 会用面板预设覆盖档案。所以如果用户拖了时间轴
    （改档案），却没重新在面板设长度，下次渲染就会被面板的旧预设**静默覆盖**
    —— 这正是文档禁止的"静默覆盖"。

    本函数只负责**查**，不负责改：把两边对不上的段列出来，交给前端弹清单让
    用户选「用工程预设」还是「用档案事实」，绝不自己动手覆盖。

    shots: 前端工程对象里的分段数组，每项 { id, frames, synced }。id 是分段
    身份 uid（= 档案里的 shot 字段）；frames 是面板预设（原始 length，未吸附）；
    synced 是前端上次从档案同步回来的时间戳（可省略，省略则只按 frames 是否
    一致判断）。

    预设的吸附规则与渲染侧一致（align_frame_count 向上取 17k+5），所以
    预设 243 和档案 243 不会因为吸附算法不同而误报 —— 吸附逻辑只在这里和
    csglide_cast 各一份，比对前先对齐。
    """
    try:
        from .nodes import csglide_cast as _cast
        _align = getattr(_cast, "align_frame_count", None)
    except Exception:
        _align = None
    if _align is None:
        _align = lambda n: max(5, int(n))       # 兜底：至少给个确定的函数

    rows = {c.get("shot"): c for c in summary(name).get("clips", [])
            if c.get("shot")}
    out = []
    for s in shots or []:
        sid = (s.get("id") or "").strip()
        if not sid:
            continue
        row = rows.get(sid)
        if not row:
            # 工程里有这个分段、档案里还没它（还没跑过第一遍）——不是冲突。
            continue
        raw = s.get("frames")
        if raw is None:
            continue
        try:
            preset = int(_align(int(raw)))
        except (TypeError, ValueError):
            continue
        fact = int(row.get("frames") or 0)
        if preset == fact:
            continue
        # 档案比「前端上次同步」新，说明是时间轴/后端后来改的 —— 真正要提示的
        # 情况。没传 synced 就按"预设与事实不同即冲突"处理。
        synced = s.get("synced")
        out.append({
            "shot": sid,
            "id": row.get("id"),
            "index": (row.get("index") or 0),
            # preset 是吸附后的值（与渲染时一致），fact 是档案里的真实帧数
            "preset": preset,
            "fact": fact,
            "updated": row.get("updated"),
            "stale": (synced is None) or (synced is not None and synced < (row.get("updated") or 0)),
        })
    return {"name": name, "conflicts": out}


def summary(name):
    chain = load_chain(name)
    clips, broken = [], []
    for c in chain.get("order", []):
        m = load_clip(name, c)
        # 段落 json 被手动删了 / 写坏了：静默丢掉会让人以为那段从来没生成过，
        # 于是"我的第 3 段呢"变成无头案。单独列出来交给面板报。
        (clips if m else broken).append(m or c)
    return {
        # 只留还读得到的段；total_frames 也就只统计这些，不会虚高
        "broken": broken,
        "name": name,
        "fps": chain.get("fps", 24),
        "trim_frames": chain.get("trim_frames", DEFAULT_TRIM),
        "prompt_global": chain.get("prompt_global", ""),
        "current": chain.get("current"),
        "locked": bool(chain.get("locked")),
        # 时间轴当前选中阶段 / 成片变体：导演台按钮、后端所有读者共用的整片级状态。
        # 前端 F5 后靠这两个字段恢复按钮高亮，缺一个就会「按钮亮默认、后端按档案」。
        "stage": current_stage(name),
        "variant": current_variant(name),
        "variant_label": FILM_VARIANT_LABEL[current_variant(name)],
        "total_frames": sum(int(c.get("frames", 0)) for c in clips),
        "clips": clips,
    }


def bus_view(name):
    """工程产物统一只读视图：段 / 版本 / 类型 / 路径 / 内容指纹 / 画布 / 来源节点一次给全。

    只读、不落盘：档案写入方必须始终只有一个（20261111 起是
    「🎬 H3 VAE 快速解码」），多一个写盘方就会重演文件头 20261104 记的
    「加长被拒 / 收片缺档 / 整片潜空间静默丢段」。
    stage 维度同样只在这里扩键，不新开索引文件、不新增写入路径。
    """
    doc = summary(name)
    records = []
    for c in doc.get("clips") or []:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        tp = c.get("take_params") or {}
        for row in (take_rows(name, cid) or {}).get("takes") or []:
            t = int(row.get("take") or 1)
            p = tp.get(str(t)) or {}
            canvas = {"w": int(p.get("w") or 0), "h": int(p.get("h") or 0)}
            for kind in ("latent", "film"):
                path = row.get(kind)
                if not path or not os.path.isfile(path):
                    continue
                st = os.stat(path)
                records.append({
                    "cid": cid, "take": t, "kind": kind, "stage": "s1", "path": path,
                    # 句柄带 size+mtime：文件内容被后续运行覆盖时缓存能自然失效
                    "fingerprint": "%s|%d|%d" % (
                        os.path.basename(path), st.st_size, st.st_mtime_ns),
                    "canvas": canvas, "current": bool(row.get("current")),
                    "source_node": p.get("source_node"),
                    "source_slot": p.get("source_slot"),
                })
            # s2（以及以后新增的阶段）由写盘方登记在 take_params.*.stages 里，
            # 不会出现在 take_rows 的 latent 列上 —— 在这里补进同一份只读索引。
            for st_name, st_path in (p.get("stages") or {}).items():
                if st_name == "s1" or not st_path or not os.path.isfile(st_path):
                    continue
                stat = os.stat(st_path)
                records.append({
                    "cid": cid, "take": t, "kind": "latent", "stage": st_name,
                    "path": st_path,
                    "fingerprint": "%s|%d|%d" % (
                        os.path.basename(st_path), stat.st_size, stat.st_mtime_ns),
                    "canvas": canvas, "current": bool(row.get("current")),
                    "source_node": p.get("source_node"),
                    "source_slot": p.get("source_slot"),
                })
    return {
        "name": name, "fps": doc.get("fps"),
        "total_frames": doc.get("total_frames"), "current": doc.get("current"),
        "stage": current_stage(name),
        "broken": doc.get("broken") or [], "records": records,
    }


# --------------------------------------------------------------------------
# 历史旧工程（轴头「历史」按钮）：扫描 output/h3_chain/ 一劳永逸
# --------------------------------------------------------------------------

def _dir_size_mb(path):
    """目录占用（MB）。历史列表显示工程大小用，失败不致命。"""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except Exception:
                    pass
    except Exception:
        pass
    return round(total / 1048576.0, 1)


def history_list(include_sys=False):
    """历史旧工程清单（轻量）：新 DB 工程 / 老 JSON 工程都走公共加载函数
    （load_chain / load_clip 对 store 透明），只读文档、**不跑 ffprobe**。

    状态口径：
      empty 空工程 · todo 只有潜空间没成片 · miss 部分段有成片 · film 全段成片。

    自检/冒烟残留（_routesmoke、__probe、H3StudioDebug 等下划线开头目录）默认
    隐藏，include_sys=True 才列出（前端「显示系统工程」开关）。
    """
    root = os.path.join(_out_dir(), "h3_chain")
    def _is_sys(d):
        return d.startswith((".", "_")) or d.startswith("H3StudioDebug")
    try:
        names = [d for d in os.listdir(root)
                 if os.path.isdir(os.path.join(root, d))
                 and (include_sys or not _is_sys(d))]
    except Exception:
        names = []
    out = []
    for d0 in names:
        try:
            # 扫出来的是**目录名**；改过名的工程目录名 ≠ 片名，翻回用户看到的名字
            # （方案 G）。没登记过就说明没改过名，目录名就是片名。
            nm = store.name_of_dir(d0) or d0
            d = chain_dir(nm)
            is_db = store.has_db(d)
            ch = load_chain(nm)
            order = [str(c) for c in (ch.get("order") or [])]
            seg = len(order)
            total_frames = 0
            playable = 0
            pending = False
            w = h = 0
            latest = 0.0
            for cid in order:
                m = load_clip(nm, cid)
                if not m:
                    continue
                total_frames += int(m.get("frames") or 0)
                if m.get("pending"):
                    pending = True
                fp = m.get("film")
                if fp and os.path.isfile(fp):
                    playable += 1
                tp = (m.get("take_params") or {}).get(
                    str(max(1, int(m.get("current_take") or 1)))) or {}
                if not w and int(tp.get("w") or 0):
                    w, h = int(tp["w"]), int(tp.get("h") or 0)
                try:
                    latest = max(latest, float(m.get("updated") or 0))
                except Exception:
                    pass
            if seg == 0:
                status = "empty"
            elif playable == seg:
                status = "film"
            elif playable > 0:
                status = "miss"
            else:
                status = "todo"
            try:
                created = os.path.getctime(d)
            except Exception:
                created = 0
            opened = latest or created
            out.append({
                "name": nm,
                "dir": d0,
                "segCount": seg,
                "totalFrames": total_frames,
                "w": w,
                "h": h,
                "status": status,
                "pending": pending,
                "playable": playable,
                "backend": "db" if is_db else "json",
                "createdAt": round(created, 2),
                "openedAt": round(opened, 2),
                "sizeMB": _dir_size_mb(d),
            })
        except Exception:
            continue
    out.sort(key=lambda x: x.get("openedAt") or 0, reverse=True)
    return {"projects": out, "count": len(out)}


def history_bundle(name):
    """切换工程的完整资料包。
      · DB 工程：project_blob 全量（clips 含 state、racks 媒体架、desk 文案台），
        与当时离开时一模一样；
      · 老 JSON 工程：片账 + 段文档（媒体架/文案台 20261012 才开始入库，
        老工程没有这两份，缺省 —— 前端菜单标注「老工程」）。
    """
    d = chain_dir(name)
    if not os.path.isdir(d):
        return {"error": "没有这个工程：%s" % name}
    if store.has_db(d):
        return store.project_blob(d, name, summary)
    ch = load_chain(name)
    clips = []
    for cid in (ch.get("order") or []):
        m = load_clip(name, str(cid))
        if m is not None:
            clips.append(m)
    return {"name": name, "backend": "json", "chain": ch, "clips": clips}


def delete_project(name, dirname=None):
    """删除整个工程目录（output/h3_chain/<name>），历史菜单「一键删除」用。
    不进回收站、不可恢复 —— 前端已明确不弹确认。

    目录来源：优先用历史清单给的目录名（列表与删除同源）；没带 dir 才退回片名
    反查索引，兼容老前端。系统工程（点 / 下划线开头、H3StudioDebug）同样可删
    —— 前端开了「显示系统工程」就该让 ✕ 有用。

    安全：解析结果必须在 h3_chain 根下、且不能是根本身，防路径穿越；
    目录不存在返回 not_found。
    """
    safe = "".join(c for c in (name or "") if c not in '\\/:*?"<>|').strip()
    dn = str(dirname or "").strip()
    if not safe and not dn:
        return {"error": "缺少工程名"}
    base = os.path.realpath(os.path.join(_out_dir(), "h3_chain"))
    # 列表与删除同源：历史清单扫出来的是**目录名**，直接按它删，不再靠片名反查
    # 索引。改过名 / 老 JSON 工程 / 索引丢失 / 名字含非法字符时，按片名拼目录会
    # 指向一个不存在的目录 → 400「没有这个工程」。dir 缺失才退回原片名解析。
    d = os.path.realpath(os.path.join(base, dn or (store.dir_name_of(name) or safe)))
    if d == base or os.path.commonpath([base, d]) != base:
        return {"error": "非法工程名"}
    if not os.path.isdir(d):
        return {"error": "没有这个工程：%s" % (dn or safe), "name": safe}
    # 删除前先关掉该工程的 SQLite 连接：Windows 上 project.db / -wal / -shm
    # 一旦连接常驻就会被句柄锁住，直接 rmtree 报 PermissionError → 500（真机实测）。
    try:
        store.close_db(d)
    except Exception:
        pass
    size_mb = _dir_size_mb(d)

    def _force_remove(func, path, exc):
        # rmtree 兜底：去掉只读位再删一次（Windows 只读文件 / 句柄瞬时占用）。
        try:
            os.chmod(path, 0o777)
            func(path)
        except Exception:
            pass

    last_err = None
    for _attempt in range(3):
        # 浏览器预览可能正占着 mp4 等句柄：整体重试 3 次，间隔等句柄释放。
        try:
            shutil.rmtree(d, onexc=_force_remove)
            last_err = None
            break
        except Exception as e:
            last_err = e
            time.sleep(0.4)
    if os.path.exists(d):
        return {"error": "删除未完成，可能有文件被占用：%s" % last_err, "name": safe}
    # 目录没了，索引里那条映射也一起清掉，否则同名工程将来会被指向已删的目录。
    try:
        store.drop_dir_of(name)
    except Exception:
        pass
    return {"ok": True, "name": safe, "sizeMB": size_mb}


# --------------------------------------------------------------------------
# 路由（前端时间轴用）
# --------------------------------------------------------------------------

try:
    from server import PromptServer

    @PromptServer.instance.routes.get("/cglide/chain/projects")
    async def _route_projects(request):
        """列出所有工程名（文案台独立认段用，20261031）。

        文案台不连导演台时没有「片名」入口 —— 片名原来只从导演台内存来。
        这个接口把"有哪些工程"摆出来：零个工程就用「未命名」现建（add_clip
        本来就有这个兜底）；只有一个就自动用（单用户场景覆盖绝大多数）；
        多个才需要人选。工程目录名与片名可能不同（改过名），所以逐目录读
        chain.json 取 name，读不到才退回目录名。
        """
        import asyncio
        base = os.path.join(_out_dir(), "h3_chain")
        loop = asyncio.get_running_loop()

        def _list():
            out = []
            try:
                dirs = sorted(d for d in os.listdir(base)
                              if os.path.isdir(os.path.join(base, d)))
            except Exception:
                return out
            for dn in dirs:
                nm = dn
                try:
                    with open(os.path.join(base, dn, "chain.json"),
                              encoding="utf-8") as f:
                        nm = str((json.load(f) or {}).get("name") or dn)
                except Exception:
                    pass
                out.append(nm)
            return out

        return _json({"projects": await loop.run_in_executor(None, _list)})

    @PromptServer.instance.routes.get("/cglide/chain/summary")
    async def _route_summary(request):
        # 读盘走线程池：summary 每 1~2 秒被三节点轮询一次，同步 stat/json 读
        # 堵在事件循环上会拖死 ComfyUI 全部 HTTP（面板"反应迟钝"的后端根因）。
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        loop = asyncio.get_running_loop()
        return _json(await loop.run_in_executor(None, summary, name))

    @PromptServer.instance.routes.post("/cglide/chain/unique_name")
    async def _route_unique_name(request):
        """「新建整片」用：回一个还没被占用的默认片名，避免重名写进旧档案。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        return _json({"name": await _io(unique_chain_name, body.get("base"))})

    @PromptServer.instance.routes.get("/cglide/chain/clip")
    async def _route_clip(request):
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = request.query.get("id") or ""
        loop = asyncio.get_running_loop()
        meta = await loop.run_in_executor(None, load_clip, name, cid)
        if meta is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json(meta)

    @PromptServer.instance.routes.get("/cglide/chain/cont")
    async def _route_cont(request):
        """取这一段**当前版本**的续拍存档（cont）相对路径（只读）。

        渲染循环里的 previous 只认「本轮刚跑出来的回执」。重拍某一段
        （scope=clip）时前序段没在本次渲染里跑过，previous 恒为空 ——
        「前序片段中央回执缺失，无法续写」就是这么来的。档案里其实存着
        前一段上一次跑出来的 cont，这里补一条查询让重拍也能接上（20261015）。
        """
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = request.query.get("id") or ""
        loop = asyncio.get_running_loop()

        def _get():
            meta = load_clip(name, cid)
            if meta is None:
                return {"error": "没有这一段：%s" % cid}
            try:
                take = int(meta.get("current_take") or 1)
            except (TypeError, ValueError):
                take = 1
            p = clip_cont(name, cid, take)
            if not os.path.isfile(p):
                return {"error": "这一段还没有续拍存档 —— 先跑一次这一段"}
            return {"cid": cid, "take": take,
                    "cont_path": os.path.relpath(
                        p, folder_paths.get_output_directory()).replace(os.sep, "/")}

        return _json(await loop.run_in_executor(None, _get))

    @PromptServer.instance.routes.post("/cglide/chain/update")
    async def _route_update(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        meta = await _io(update_clip, name, cid, body.get("patch") or {})
        if meta is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json(meta)

    @PromptServer.instance.routes.post("/cglide/chain/rename")
    async def _route_rename(request):
        """导演台改片名用。片名就是磁盘上的目录名，改名 = 搬目录（理由见 rename_chain）。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        old = (body.get("name") or "").strip()
        new = (body.get("to") or "").strip()
        if not new:
            return _json({"error": "缺少新片名"}, 400)
        try:
            return _json(await _io(rename_chain, old, new))
        except Exception as e:
            return _json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

    @PromptServer.instance.routes.post("/cglide/chain/copy")
    async def _route_copy(request):
        """拖入视频还原用：把源片的**整份档案**复制到一个新片名下。

        与 /rename 正相反 —— 那个只改索引、目录不动；这个真复制一份新目录。
        路线：拿 unique_name 要到的新片名 → 这里复制 → 前端按复制过来的档案
        重建工程对象。于是时间轴上是原片的全部段，而不是空轴 + 一段占位。

        复制可能上百 MB，必须走线程池（同步 IO 堵在事件循环上会冻结整个界面）。
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON", "code": "bad_body"}, 400)
        src = (body.get("from") or body.get("name") or "").strip()
        dst = (body.get("to") or "").strip()
        if not src or not dst:
            return _json({"copied": False, "code": "bad_name",
                          "error": "缺少片名"}, 400)
        try:
            return _json(await _io(copy_chain, src, dst))
        except Exception as e:
            return _json({"copied": False, "code": "error",
                          "error": "%s: %s" % (type(e).__name__, e)}, 500)

    @PromptServer.instance.routes.post("/cglide/chain/add_clip")
    async def _route_add_clip(request):
        """导演台「＋ 接一段」用：把新分段登记进档案。

        时间轴画的是**档案里的段**（film_summary 走 chain 的 order），而「接
        一段」改的是工程对象（跟工作流走的 shots）。只在工程对象里加一段、
        不登记的话轴上永远不出现 —— 用户点了按钮却什么都没发生，就是这个原因。

        刻意不吸附帧数：档案要记的是真实跑出来的帧数（见 add_clip 的注释）。
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        fields = {}
        n = body.get("frames")
        if n:
            try:
                fields["frames"] = max(1, int(n))
            except Exception:
                pass
        if body.get("shot"):
            fields["shot"] = str(body["shot"])
        # 承接窗口 trim：前端按**工程真实段序**算好发来（首段 0、其余头部窗口）。
        # 必须显式提取并透传 —— 旧路由漏了这一项，前端发的 trim_frames 被静默
        # 丢弃，于是首段也落了 add_clip 的 chain 级默认 22。
        tf = body.get("trim_frames")
        if tf is not None:
            try:
                fields["trim_frames"] = max(0, int(tf))
            except Exception:
                pass
        # 段名：显示在时间轴的段块上。键名与 body["name"]（片名）分开，两回事。
        # 不能塞进 fields["name"] 再 add_clip(name, **fields)：那会让 add_clip
        # 同时收到「片名」和「段名」两个 name，直接 TypeError（multiple values）。
        # 段名落盘走 update_clip，与 add_clip 分两步 —— 反正都是写同一个 json。
        clip_name = str(body["clip_name"]).strip()[:60] if body.get("clip_name") else ""
        try:
            def _add():
                _cid = add_clip(name, **fields)
                if clip_name:
                    update_clip(name, _cid, {"name": clip_name})
                return _cid
            cid = await _io(_add)
        except Exception as e:
            return _json({"error": "%s: %s" % (type(e).__name__, e)}, 500)
        # add_clip 命中同 uid 的已有段时会返回它的 id —— index 按它在 order
        # 里的**位置**给，不能拿总段数顶替，否则前端会显示错段号。
        order_now = _dedup_order((await _io(load_chain, name)).get("order"), name)
        return _json({"id": cid,
                      "index": (order_now.index(cid) + 1) if cid in order_now
                               else len(order_now)})

    @PromptServer.instance.routes.post("/cglide/chain/bind_segment")
    async def _route_bind_segment(request):
        """新增/插入/复制段的中央段绑定回执。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        try:
            receipt = await _io(bind_segment, name, body)
        except Exception as e:
            return _json({"error": "%s: %s" % (type(e).__name__, e)}, 500)
        return _json(receipt)

    @PromptServer.instance.routes.post("/cglide/chain/reorder")
    async def _route_reorder(request):
        """时间轴拖动排序用：按前端给的 id 顺序重排 chain.order。

        为什么需要后端参与：时间轴画的是**档案里的顺序**（film_summary 走
        chain.order），只在前端把 shots 数组换个次序，下一次 film_summary 回来
        又会按老顺序画 —— 用户看到的是"拖完弹回去了"。所以顺序必须落盘。
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        order = body.get("order")
        if not isinstance(order, list):
            return _json({"error": "order 必须是 id 数组"}, 400)
        # cur_cid 只用于留痕：重排影响整片，但得知道这次是在编辑哪一段时改的
        cur_cid = str(body.get("cid") or body.get("cur_cid") or "") or None
        try:
            return _json(await _io(reorder_clips, name, order, cur_cid))
        except Exception as e:
            return _json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

    @PromptServer.instance.routes.post("/cglide/chain/remove_clip")
    async def _route_remove_clip(request):
        """删除一段。``force=true`` = 导演台「删除本段」—— 真删（含磁盘文件）。

        不带 force 时后端保留"有成片的段不给删"那条判据（理由见 remove_clip）。
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        try:
            return _json(await _io(remove_clip, name, cid, force=bool(body.get("force"))))
        except Exception as e:
            return _json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

    @PromptServer.instance.routes.get("/cglide/chain/clip_files")
    async def _route_clip_files(request):
        """这一段要删掉的话，会删到哪些文件（只读，不删任何东西）。

        前端「删除本段」拿它把清单摆出来 —— 删是不可逆的，用户点确认之前
        必须先看见自己将要失去什么。大小一并给出，好判断是不是那块成片。
        """
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = request.query.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        loop = asyncio.get_running_loop()
        files, meta = await loop.run_in_executor(
            None, lambda: (clip_files(name, cid), load_clip(name, cid) or {}))
        return _json({
            "id": cid,
            "files": files,
            "total_bytes": sum(int(f.get("size") or 0) for f in files),
            "has_film": bool(meta.get("film")),
            # 有没有潜空间原稿 —— 有的话"删了就重抽不出来"，确认框要说清这一点。
            "has_latent": any(".latent" in f["name"] for f in files),
        })

    @PromptServer.instance.routes.get("/cglide/chain/film")
    async def _route_film(request):
        """整片成片视图：导演台监视器 / 时间轴用它。

        注意：曾出现活服务器把 GET /cglide/chain/film 误送到 POST 处理器的情况
        （返回「请求体不是 JSON」）。为兜底同时注册 /film_summary，前端可切过去。
        """
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        loop = asyncio.get_running_loop()
        return _json(await loop.run_in_executor(None, film_summary, name))

    # 与 /film 同义的只读别名 —— 避开偶发的同路径 GET/POST 串线
    @PromptServer.instance.routes.get("/cglide/chain/film_summary")
    async def _route_film_summary(request):
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        loop = asyncio.get_running_loop()
        return _json(await loop.run_in_executor(None, film_summary, name))

    @PromptServer.instance.routes.get("/cglide/chain/preview_film")
    async def _route_preview_film(request):
        """整片连续预览片（连播 / 跨段拖动播放用）：确保就绪、返回路径/帧数/签名。
        ensure=0 只读缓存、不拼接。拼接走线程池、不堵事件循环。 """
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        ensure = request.query.get("ensure", "1") not in ("0", "false")
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, preview_film, name, ensure)
        return _json(res)

    @PromptServer.instance.routes.get("/cglide/chain/prewarm")
    async def _route_prewarm_get(request):
        """后台预热整片预览片（GET 便捷入口，立即返回、不等待拼接）。"""
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        was = name in _prewarm_running
        schedule_prewarm(name)
        return _json({"ok": True, "already_running": was})

    @PromptServer.instance.routes.post("/cglide/chain/prewarm")
    async def _route_prewarm(request):
        """后台预热整片预览片：立即返回、不等待拼接（同名在跑去重）。
        前端在全部渲染完成 / 收片后 fire-and-forget；收片后端也会自行调一次。 """
        name = request.query.get("name")
        try:
            body = await request.json()
            if isinstance(body, dict) and body.get("name"):
                name = body["name"]
        except Exception:
            body = None
        name = str(name or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        was = name in _prewarm_running
        schedule_prewarm(name)
        return _json({"ok": True, "already_running": was})

    @PromptServer.instance.routes.post("/cglide/chain/set_film")
    async def _route_film_set(request):
        """手工登记/改一段的成片路径（面板上「选一个文件当这段的成片」用）。

        路径从 /cglide/chain/film 拆出，避免与 GET 同路径时被误路由。
        仍保留下方 POST /film 兼容入口。
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        meta = await _io(set_film, name, cid, body.get("path"),
                         body.get("frames"), body.get("seam"))
        if meta is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json(meta)

    # 注意：不要再在 /cglide/chain/film 上挂 POST。
    # ComfyUI-LG_HotReload 热重载时会按「路径」替换 handler、不区分 method，
    # 同路径的 GET+POST 会被最后一个 method 的 handler 覆盖 —— 这就是
    # GET /film 返回「请求体不是 JSON」的根因。写操作用 /set_film。

    @PromptServer.instance.routes.post("/cglide/chain/adopt_film")
    async def _route_adopt_film(request):
        """把刚渲染出来的视频**收进本片文件夹**，并登记为这一段的成片。

        渲染节点把文件写在哪儿由工作流决定（output 根目录、video 子目录、前缀
        怎么起都是用户自己设的）—— 档案若只记那个位置，一部片子的成片就散在
        output 各处，而潜空间、波形都躺在 h3_chain/<片名>/ 里，三样东西分三个
        地方，"这一段到底有哪些文件"就无从查起。
        所以这里统一口径：拷成 h3_chain/<片名>/clip_000N.mp4 再登记。这样
        「成片 / 潜空间 / 波形」同目录同命名，拷贝一个文件夹就是完整工程。
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        fn = str(body.get("filename") or "")
        if not fn:
            return _json({"error": "缺少文件名"}, 400)
        meta = load_clip(name, cid)
        if meta is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)

        root = _out_dir()
        src = os.path.join(root, str(body.get("subfolder") or ""),
                           os.path.basename(fn))
        if not os.path.isfile(src):
            return _json({"error": "找不到刚渲染出来的文件：%s" % fn}, 404)
        take = max(1, int(meta.get("current_take") or 1))
        dest = clip_film(name, cid, take)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # copy2 走线程池：几百兆的成片不该把事件循环堵住
            await asyncio.get_running_loop().run_in_executor(
                None, shutil.copy2, src, dest)
        except Exception as e:
            return _json({"error": "收片失败：%s" % e}, 500)

        # 这一版是怎么生成的，跟成片一起记下（20261010，版本与参数绑定）：
        #   w/h —— 本次画布。切回这一版时面板画布跟着回滚，不再"画面回去了、
        #          参数还留在新设的值上"，混着跑必然接不上；
        #   cont_saved —— 本次 run 写出的续拍存档（120 秒时间窗内才认）。
        #          下一段续写优先接**这一份**，精确认段，不再靠目录猜。
        tp = dict(meta.get("take_params") or {})
        # 同上：保留写盘方登记的 stages，收片只叠加自己的字段。
        rec = dict(tp.get(str(take)) or {})
        try:
            if int(body.get("w") or 0) > 0 and int(body.get("h") or 0) > 0:
                rec["w"] = int(body.get("w"))
                rec["h"] = int(body.get("h"))
        except (TypeError, ValueError):
            pass
        # 参数快照（20261010bb · 抄 obvpm「从片段恢复当时的设置」）：把这一版
        # 生成用的提示词与采样参数一并记下 —— 切回旧版本时能看清当时用的是
        # 什么，不用自己另外记。
        # **seed 不在此列**：它在工作流节点里，导演台拿不到；档案里那个 seed
        # 是恒 0 的占位，抄进来只会让人以为能复现。宁可不记，也不记假的。
        for k in ("prompt_seg", "steps", "cfg", "refs"):
            if k in meta:
                rec[k] = meta[k]
        # 续拍存档登记：存档节点已经把这一版的档写进本段文件夹
        # （clip_cont(片名,段号,版号)），这里只按「本段 + 本版」点那份文件。
        # 存在就登记并写明它属于哪一段 —— 下一段拿错档会直接中止；
        # 不存在就不登记，绝不拿「最后写的那份」凑数（那可能是别的段/别的片）。
        cdst = clip_cont(name, cid, take, current_stage(name))
        if os.path.isfile(cdst):
            rec["cont_saved"] = cdst
            rec["cont_saved_of"] = str(cid)
        else:
            print("[H3 档案] 本段（%s / 第 %d 版）没有写出续拍存档（%s）—— "
                  "工作流里是否接了「H3 续拍存档」节点？下一段将无法承接。"
                  % (cid, take, os.path.basename(cdst)))
        if rec:
            tp[str(take)] = rec
            update_clip(name, cid, {"take_params": tp})
        # 实测帧数随成片一起入账（20261010 修）：以前这里不传 frames，
        # film_frames 恒 0 —— 前端的累积/单段判据、连播落段、采样窗口全部
        # 失去地面真相，"整片连播每段播两遍"就是从这来的。
        # 契约（20261010ba）：同一刻把「开头几帧是承接」也算一次写死，
        # 从此时间轴/播放/保存成片都读它，不再各处判断这条片子是什么形态。
        _ff = probe_film_frames(dest)
        _from, _to, _htrim = _span_of(name, cid)
        out = set_film(name, cid, dest, frames=_ff,
                       head=_compute_film_head(_from, _to, _ff, head_trim=_htrim))
        # 收片后后台预热整片预览片（点播放即秒开）；不阻塞本次响应。
        schedule_prewarm(name)
        return _json(out)

    @PromptServer.instance.routes.post("/cglide/chain/collect_run")
    async def _route_collect_run(request):
        """按 prompt_id 让中央系统从服务端历史中认领本次分段片。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        prompt_id = body.get("prompt_id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        if not prompt_id:
            return _json({"error": "缺少 prompt_id"}, 400)
        try:
            res = await _io(collect_run, name, cid, prompt_id)
        except ValueError as e:
            return _json({"error": str(e)}, 400)
        except Exception as e:
            return _json({"error": "中央收片失败：%s" % e}, 500)
        return _json(res)

    @PromptServer.instance.routes.post("/cglide/chain/resize")
    async def _route_resize(request):
        """拖时间轴改一段的时长。返回本段与下一段的待办状态。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        try:
            frames = int(body.get("frames"))
        except (TypeError, ValueError):
            return _json({"error": "frames 必须是整数"}, 400)
        res = await _io(resize_clip, name, cid, frames)
        if res is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json(res)

    @PromptServer.instance.routes.post("/cglide/chain/resize_many")
    async def _route_resize_many(request):
        """排段一次 POST：改完 N 段帧长，后端只重切一次音频驱动。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        items = body.get("items")
        if not isinstance(items, list):
            return _json({"error": "items 必须是数组"}, 400)
        files = [str(x).strip() for x in (body.get("files") or []) if x] or None
        res = await _io(resize_many, name, items, files)
        return _json(res)

    @PromptServer.instance.routes.post("/cglide/chain/seam")
    async def _route_seam(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        meta = await _io(set_seam, name, cid, body.get("side"),
                         body.get("score"), body.get("note"))
        if meta is None:
            return _json({"error": "没有这一段，或 side 不是 left/right"}, 404)
        return _json(meta)

    @PromptServer.instance.routes.post("/cglide/chain/current")
    async def _route_current(request):
        """设「当前段」——三个节点共享的编辑目标。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id") or ""
        ch = await _io(set_current, name, cid)
        if ch is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json({"current": ch.get("current")})

    @PromptServer.instance.routes.post("/cglide/chain/stage")
    async def _route_stage(request):
        """设「时间轴当前选中阶段」（一采 s1 / 二采 s2）——整片级全局开关。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        stage = str(body.get("stage") or "").strip().lower()
        try:
            out = await _io(set_stage, name, stage)
        except ValueError as exc:
            return _json({"error": str(exc)}, 400)
        return _json(out)

    @PromptServer.instance.routes.post("/cglide/chain/film_variant")
    async def _route_film_variant(request):
        """设「整片级成片变体」（final 三采成品 / raw 二采原片）。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str((body or {}).get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        try:
            out = await _io(set_film_variant, name, (body or {}).get("variant"))
        except ValueError as exc:
            return _json({"error": str(exc)}, 400)
        return _json(out)

    @PromptServer.instance.routes.post("/cglide/chain/lock")
    async def _route_lock(request):
        """锁定 / 解锁一段（锁的是编辑目标）。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        meta = await _io(set_locked, name, cid, body.get("locked"))
        if meta is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json(meta)

    @PromptServer.instance.routes.post("/cglide/chain/pending")
    async def _route_pending(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        meta = await _io(set_pending, name, body.get("id"), body.get("kind"))
        if meta is None:
            return _json({"error": "没有这一段"}, 404)
        return _json(meta)

    # 20261108：「特殊接法」四种接法删除，/cglide/chain/pins（写）与
    # /cglide/chain/pins_state（读）两条路由随之一并移除 —— 前端已无任何写
    # pins 的入口，接缝状态全部来自本地工程对象（state.cont.frames /
    # transitions）。底层 pins_of / set_pins / pin_mode / head_parent 保留：
    # 它们是「自动接续」按段序回退上一段、以及老工程档案解释的底座。
    #
    # 下面 /transitions_state（读）与 /transitions（写）仍分两条路径：
    # ComfyUI-LG_HotReload 热重载按**路径**整条换 handler、不区分 method，
    # 同路径挂 GET+POST 会被后注册那个盖掉（/cglide/chain/film 踩过这个坑）。
    # 接缝成片转场（M3）：读走 /transitions_state、写走 /transitions。
    # 分路径的理由见上方注释：热重载按路径换 handler、不认 method。
    @PromptServer.instance.routes.get("/cglide/chain/transitions_state")
    async def _route_transitions_state(request):
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        return _json({"transitions": await _io(transitions_of, name)})

    @PromptServer.instance.routes.post("/cglide/chain/transitions")
    async def _route_transitions(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id") or ""
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        tt = await _io(set_transition, name, cid, body)
        # 重切驱动音频**不放在这里**：时间轴上连点「去掉全部接续」会连发 N 次，
        # 每次都全量解码十几段音频会把胶囊卡死。改走独立路由 +
        # 前端 600ms 防抖，见 _route_reslice_drivers。
        return _json({"id": cid, "transitions": tt})

    @PromptServer.instance.routes.post("/cglide/chain/reslice_drivers")
    async def _route_reslice_drivers(request):
        """接缝 / 段长改完后，按**当前段档案**重切全部驱动音频。

        20261111 断链音频根因修复：接缝一改净长就变，可 bzsa.driver 里的切片
        还停在旧边界 —— 真机日志「驱动切片只有 368 格，比本段净长 405 格短
        37 格；尾部已按本段音频循环补齐」。resize_clip / auto_slice 早已落
        reslice_drivers，唯独「取消接续」这条路径漏了，补在这里。
        独立路由 = 前端可防抖，连点只发一次；失败只给中文提示，不动档案。
        重切一律复用 _resync_audio_drivers（段长派生数据的唯一入口），
        绝不在这里另写第二条 reslice 链路。

        20261111 方案 B：带 shrink_frames=1 时与 /banzhang/audio/auto_slice
        **同一套单一事务** —— 断链让 trim 派生归零 → net 变长 → 原来按
        30 秒音源铺满的 Σnet 不够了，必须先 shrink_tail_to_audio() 把末段
        frames 缩到剩余音频，再在同一事务里重切一次音频，并把回读的真实
        帧数 / 段序交给前端写齐面板预设。少这一步就是「音频被裁短、画面多出
        一截空帧」。
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str((body or {}).get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        try:
            from .core import csglide_store as _st
            d = _st.chain_dir(name)
            conn = _st._connect(d, create=False) if _st.has_db(d) else None
            tracks = (_st._meta_get(conn, "bzsa.tracks", []) or []) if conn else []
            files = [str(x.get("文件") or "").strip()
                     for x in tracks if isinstance(x, dict)]
            files = [x for x in files if x]
            if not files:
                return _json({"done": False, "skip": "工程里没有音频轨，无需重切"})
            shrink = bool((body or {}).get("shrink_frames"))

            def _work():
                """改档案与重切音频在同一请求里只做一次，不分叉。"""
                pre = {}
                if shrink:
                    pre = shrink_tail_to_audio(name, files) or {}
                res = _resync_audio_drivers(name, files)
                if shrink:
                    res = dict(res or {})
                    res["末段缩短"] = pre
                return res

            # 复用段长派生数据的唯一入口，不在这里另写第二条 reslice 链路。
            out = await _io(_work)
            if not out or "段数" not in out:
                return _json({"done": False,
                              "error": "驱动音频重切没返回结果",
                              "提示": "接缝已改，但驱动音频还按旧段长 —— "
                                      "去时间轴重新拖一次音频即可"})
            out["done"] = True
            _tail = ("；末段画面已按剩余音频缩到 %s 帧"
                     % int((out.get("末段缩短") or {}).get("明细", [{}])[0].get("新帧", 0))
                     ) if int((out.get("末段缩短") or {}).get("已缩短") or 0) else ""
            out["提示"] = ("已按新的接续设置重切 %s 段驱动音频 —— 音频不会再按"
                           "旧段长在尾巴循环补齐" % out.get("段数", "?")) + _tail
            return _json(out)
        except Exception as e:
            return _json({"done": False,
                          "error": "驱动音频重切没成功：%s" % e,
                          "提示": "接缝已改，但驱动音频还按旧段长 —— "
                                  "去时间轴重新拖一次音频即可"})

    @PromptServer.instance.routes.get("/cglide/chain/takes")
    async def _route_takes(request):
        """这一段抽过的所有版本（以磁盘为准）。面板「版本」菜单吃这个。"""
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = request.query.get("id") or ""
        rows = await _io(take_rows, name, cid)
        if rows is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        return _json(rows)

    @PromptServer.instance.routes.post("/cglide/chain/take")
    async def _route_take(request):
        """切换 / 删除某一段的版本。

        body: { name, id, take }            → 切到第 take 版（返回代价判定）
              { name, id, take, drop: true } → 删掉第 take 版
        """
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("id")
        if not cid:
            return _json({"error": "缺少段落 id"}, 400)
        if body.get("drop"):
            res = drop_take(name, cid, body.get("take"))
        else:
            res = set_take(name, cid, body.get("take"), body.get("trim"))
        if res is None:
            return _json({"error": "没有这一段：%s" % cid}, 404)
        if res.get("ok") is False:
            return _json(res, 400)
        return _json(res)

    # ---- v2 阶段 ⑤：后端权威渲染状态 + 三节点单一真源守卫 ----
    @PromptServer.instance.routes.post("/cglide/chain/run_segments/start")
    async def _route_run_start(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        try:
            from .core import csglide_segment_runner as sr
            runner = sr.create_runner(body.get("name") or "",
                                      body.get("clips") or [],
                                      body.get("run_id") or None)
            return _json(runner.snapshot())
        except Exception as exc:
            return _json({"error": str(exc)}, 400)

    @PromptServer.instance.routes.post("/cglide/chain/run_segments/submit")
    async def _route_run_submit(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        from .core import csglide_segment_runner as sr
        runner = sr.get_runner(body.get("run_id"))
        if runner is None:
            return _json({"error": "没有这个 run_id"}, 404)
        try:
            runner.submit(body.get("clip") or "", body.get("prompt_id"))
            return _json(runner.snapshot())
        except Exception as exc:
            return _json({"error": str(exc)}, 400)

    @PromptServer.instance.routes.post("/cglide/chain/run_segments/done")
    async def _route_run_done(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        from .core import csglide_segment_runner as sr
        runner = sr.get_runner(body.get("run_id"))
        if runner is None:
            return _json({"error": "没有这个 run_id"}, 404)
        try:
            nxt = runner.done(body.get("clip") or "", bool(body.get("ok")),
                              body.get("receipt"))
            return _json(dict(runner.snapshot(), next=nxt))
        except Exception as exc:
            return _json({"error": str(exc)}, 400)

    @PromptServer.instance.routes.get("/cglide/chain/run_segments/status")
    async def _route_run_status(request):
        from .core import csglide_segment_runner as sr
        runner = sr.get_runner(request.query.get("run_id") or "")
        if runner is None:
            return _json({"error": "没有这个 run_id"}, 404)
        return _json(runner.snapshot())

    @PromptServer.instance.routes.post("/cglide/chain/run_segments/stop")
    async def _route_run_stop(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        from .core import csglide_segment_runner as sr
        return _json({"dropped": sr.drop_runner(body.get("run_id"))})

    @PromptServer.instance.routes.post("/cglide/store/segment_binding/verify")
    async def _route_binding_verify(request):
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)

        def as_dict(value):
            if isinstance(value, dict):
                return value
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                    return parsed if isinstance(parsed, dict) else {}
                except Exception:
                    return {}
            return {}

        try:
            from .core import csglide_single_source as ss
            name = body.get("name") or ""
            clip = body.get("clip") or ""
            binding = None
            try:
                from .core import csglide_store as st
                raw = st.load_segment_binding(chain_dir(name), clip)
                if raw is not None and not isinstance(raw, dict):
                    raw = dict(raw)
                binding = raw
            except Exception:
                binding = None
            errs, warns = ss.verify_snapshots(
                name, clip,
                as_dict(body.get("desk") or body.get("desk_data")),
                as_dict(body.get("rack") or body.get("rack_data")),
                as_dict(body.get("h3") or body.get("h3_data")),
                binding)
            return _json({"ok": not errs, "errors": errs, "warnings": warns})
        except Exception as exc:
            return _json({"error": str(exc)}, 400)

    @PromptServer.instance.routes.get("/cglide/chain/export_plan")
    async def _route_export_plan(request):
        """导出之前的那张清单：到哪儿为止 + 哪些改动还没进片子。"""
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        return _json(export_plan(name, request.query.get("at") or None))

    @PromptServer.instance.routes.post("/cglide/chain/sync_check")
    async def _route_sync_check(request):
        """「工程预设 vs 档案事实」冲突清单（P1-10）。前端把分段预设传过来，
        后端按 shot id 对齐档案，把对不上的段列出来 —— 只查不改。"""
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        shots = body.get("shots")
        if not isinstance(shots, list):
            return _json({"error": "shots 必须是数组"}, 400)
        return _json(sync_check(name, shots))

    @PromptServer.instance.routes.get("/cglide/chain/export")
    async def _route_export(request):
        """把「到某一段为止的成片」作为一个文件下载出去。

        路径只从段落档案里读，不接受调用方传路径 —— 否则这个接口立刻变成
        一个任意读文件的洞。
        """
        from aiohttp import web
        from urllib.parse import quote

        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        plan = export_plan(name, request.query.get("at") or None)
        if not plan.get("ok"):
            return _json({"error": plan.get("message") or "没有可导出的成片"}, 404)

        path = os.path.abspath(plan.get("path") or "")
        out_root = os.path.abspath(_out_dir())
        # normcase：Windows 上盘符大小写不统一，直接 startswith 会误判成越界
        if (not os.path.isfile(path)
                or not os.path.normcase(path).startswith(
                    os.path.normcase(out_root + os.sep))):
            return _json({"error": "成片已经不在输出目录里了：%s" % path}, 404)

        return web.FileResponse(path, headers={
            "Content-Type": "video/mp4",
            # 中文片名走 filename*，否则浏览器存下来的文件名是一串问号
            "Content-Disposition":
                "attachment; filename=\"film.mp4\"; filename*=UTF-8''%s"
                % quote(plan.get("file") or "film.mp4"),
        })

    @PromptServer.instance.routes.get("/cglide/chain/export_film_plan")
    async def _route_export_film_plan(request):
        """「保存成片」动手前的清单：所有段拼接的方案（净长口径）。"""
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        return _json(export_film_plan(name, request.query.get("at") or None))

    @PromptServer.instance.routes.post("/cglide/chain/export_film")
    async def _route_export_film(request):
        """真正动手拼：时间轴上所有段按净长拼接写盘。

        拼接要重编码、耗时随片长，**必须丢进线程池** —— 在事件循环里同步跑
        会把整个 ComfyUI（队列刷新、进度轮询）一起冻住。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str((body or {}).get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        at = (body or {}).get("at") or None
        # get_running_loop：协程内的规范写法（get_event_loop 在新 Python 里已弃用）
        res = await asyncio.get_running_loop().run_in_executor(
            None, lambda: export_film(name, at))
        return _json(res)

    @PromptServer.instance.routes.post("/cglide/chain/export_film_job")
    async def _route_export_film_job(request):
        """启动导出任务，秒回 job id。旧路由保留给后端内部调用，不动它。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str((body or {}).get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        at = (body or {}).get("at") or None
        no_audio = bool((body or {}).get("no_audio"))
        jid, rec = _start_export_job(name, at, no_audio)
        return _json({"ok": True, "job": jid, "state": rec["state"]})

    @PromptServer.instance.routes.get("/cglide/chain/export_film_status")
    async def _route_export_film_status(request):
        """轮询导出结果。重启后任务表为空，必须明确说丢，别让前端一直转圈。"""
        jid = request.query.get("job") or ""
        with _FILM_JOBS_LOCK:
            rec = _FILM_JOBS.get(jid)
            if rec is None:
                return _json({"ok": False, "state": "lost",
                              "message": "导出任务已丢失（ComfyUI 重启过或已过期），请重新导出"})
            state, result = rec["state"], rec["result"]
        if state == "running":
            return _json({"ok": True, "state": "running"})
        return _json({"ok": True, "state": "done", "result": result or {}})

    @PromptServer.instance.routes.get("/cglide/chain/export_film_file")
    async def _route_export_film_file(request):
        """把档案里的整片成片读回去 —— 前端「另存为」下载用。

        路径只从片名推导（chain_dir/<片名>/<片名>_成片.mp4），不接受调用方
        传路径，和 /chain/export 同一个安全口径。"""
        from aiohttp import web
        from urllib.parse import quote

        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        path = os.path.join(chain_dir(name), "%s_成片.mp4" % _safe_file_part(name))
        if not os.path.isfile(path):
            return _json({"error": "档案里还没有成片 —— 先保存一次"}, 404)
        # FileResponse 在 Windows 上全程握着源文件的读句柄 —— 用户下完再点一次
        # 导出，后端给它改名替换就被这个句柄挡住（WinError 32），界面报失败。
        # 所以吐一份快照：读端不碰档案里的原件，导出永远能覆盖它。
        d = os.path.dirname(path)
        for old in os.listdir(d):
            if not old.endswith(".dl.mp4"):
                continue
            try:
                f_old = os.path.join(d, old)
                if time.time() - os.path.getmtime(f_old) > 3600:
                    os.remove(f_old)
            except OSError:
                pass
        snap = path + ".%d-%s.dl.mp4" % (os.getpid(), uuid.uuid4().hex[:8])
        try:
            shutil.copy2(path, snap)
        except OSError as exc:
            return _json({"error": "成片正被其他程序占用，读不出来：%s" % exc}, 503)
        return web.FileResponse(snap, headers={
            "Content-Type": "video/mp4",
            # 中文片名走 filename*，否则浏览器存下来的文件名是一串问号
            "Content-Disposition":
                "attachment; filename=\"film.mp4\"; filename*=UTF-8''%s"
                % quote(_safe_file_part(name) + "_成片.mp4"),
        })

    # 历史旧工程（轴头「历史」按钮）：列表 + 整包加载。只读扫描，全部走
    # 线程池，不堵事件循环。
    @PromptServer.instance.routes.get("/cglide/chain/history/list")
    async def _route_history_list(request):
        include_sys = (request.query.get("include_sys") or "") in ("1", "true", "yes")
        res = await _io(history_list, include_sys)
        return _json(res)

    @PromptServer.instance.routes.get("/cglide/chain/history/bundle")
    async def _route_history_bundle(request):
        name = request.query.get("name") or ""
        if not name:
            return _json({"error": "缺少工程名"}, 400)
        res = await _io(history_bundle, name)
        if res.get("error"):
            return _json(res, 404)
        return _json(res)

    @PromptServer.instance.routes.post("/cglide/chain/history/reveal")
    async def _route_history_reveal(request):
        """在资源管理器里打开档案目录（没给片名打开 h3_chain 根）。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = body.get("name") or ""
        def _open():
            path = chain_dir(name) if name else os.path.join(_out_dir(), "h3_chain")
            if not os.path.isdir(path):
                return {"error": "目录不存在"}
            try:
                os.startfile(path)
            except Exception as e:
                return {"error": str(e)}
            return {"ok": True}
        res = await _io(_open)
        return _json(res, 404 if res.get("error") else 200)

    @PromptServer.instance.routes.post("/cglide/chain/history/delete")
    async def _route_history_delete(request):
        """一键删除整个工程目录（无确认，前端不弹框）。当前工程由前端隐藏入口。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get("name") or "").strip()
        dirname = str(body.get("dir") or "").strip()
        if not name and not dirname:
            return _json({"error": "缺少工程标识：请求没带 name / dir，已停止，不读写任何档案"}, 400)
        res = await _io(delete_project, name, dirname)
        return _json(res, 400 if res.get("error") else 200)

    def _json(data, status=200):
        from aiohttp import web
        return web.json_response(data, status=status)

    # 状态库 /cglide/store/* 路由（20261012 方案 A）：在同一 try 块内、
    # PromptServer.instance 确认就绪后注册。
    try:
        store.register_routes()
    except Exception as _se:
        print("⚠️ [班长全家桶] SQLite 状态库路由注册失败: %s" % _se)

except Exception as _e:      # pragma: no cover
    print("⚠️ [班长全家桶] H3 段落档案路由注册失败（节点仍可用，仅时间轴面板受影响）: %s" % _e)
