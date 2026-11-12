"""⏱ 参照图替换 —— 把上一段成片的某一帧，换成下一段的参照图参考。

用法是「手动点一下」：跑完一段之后不点运行，直接在节点面板上点「替换」，面板
自己完成 抽帧 → 落盘 → 把媒体架里参照图那一栏的文件指向这张尾帧。

不是运行期自动行为：节点执行时不改任何东西，只刷新状态。替换发生在「两次运行
之间」，是纯前端动作，所以本节点不需要接任何线 —— 不进 DAG 就没有执行顺序问题，
也不触发导演台的缓存复用（自动模式踩的就是这两个坑）。

编号为什么能不动：@图片N 的 N = slots.images 的物理下标，本节点做的是**原位换
file 指向**，不插队、不追加，既有编号与文案里写死的 @图片N 全部照旧。
"""

import asyncio
import hashlib
import os
import re
import time
from io import BytesIO

from aiohttp import web

try:
    import folder_paths
except Exception:                                    # pragma: no cover
    folder_paths = None

try:
    import av
except Exception:                                    # pragma: no cover
    av = None

try:
    from PIL import Image
except Exception:                                    # pragma: no cover
    Image = None

try:
    from server import PromptServer
except Exception:                                    # pragma: no cover
    PromptServer = None

# 只在服务器实例就绪时挂路由。光判断"模块导入成功"不够：instance 还没建起来就去取
# .routes 会在装饰器那行抛 AttributeError 把整个文件带崩 —— 节点注册不到是硬伤，
# 路由没挂只是抽帧用不了，两害相权取后者。
ROUTES = getattr(getattr(PromptServer, "instance", None), "routes", None)

API = "/cglide/tailref"

# --------------------------------------------------------------------------
# 抽帧性能层（20261022）
#
# 代理片 / 文件签名 / 原子写 / 正确 seek / 解码内缩放 —— 一律用
# core/csglide_proxy.py 里那份（Join 的 thumb 与监视器也用同一份，不写两遍）。
# 本文件只留自己这份缓存：目录、条数上限、并发闸门。
# --------------------------------------------------------------------------
from .core.csglide_proxy import (                      # noqa: E402
    cache_dir as _cache_dir,
    seek_to as _seek_to,
    sig as _sig,
    disk_path as _disk_path,
    write_disk as _write_disk,
    source_for as _source_for,
    scaled as _scaled,
    PROXY_W,
)

_CACHE_DIR   = _cache_dir("h3_tailref_cache")
_CACHE_MAX   = 400     # 内存缓存条数上限
_PRUNE_KEEP  = 600     # 磁盘缓存保留条数（约 60MB 量级）
_PRUNE_TICK  = 200     # 每写盘这么多次扫一次目录，别每次都 listdir
_prune_n     = 0
_PROBE_CACHE: dict = {}
_SPRITE_CACHE: dict = {}
_SPRITE_SEM = asyncio.Semaphore(2)


def _cached_body(key):
    """抽帧结果的二级缓存：内存 → 磁盘。命中返回 bytes，未命中返回 None。"""
    hit = _SPRITE_CACHE.get(key)
    if hit:
        return hit
    dp = _disk_path(_CACHE_DIR, key)
    if dp and os.path.isfile(dp):
        try:
            with open(dp, "rb") as f:
                body = f.read()
            if body:
                _SPRITE_CACHE[key] = body
                return body
        except Exception:
            pass
    return None


def _store_body(key, body):
    """存进内存缓存并落盘（原子写）。"""
    global _prune_n
    _SPRITE_CACHE[key] = body
    if len(_SPRITE_CACHE) > _CACHE_MAX:
        _SPRITE_CACHE.pop(next(iter(_SPRITE_CACHE)), None)
    dp = _disk_path(_CACHE_DIR, key)
    if dp:
        _write_disk(dp, body)
        _prune_n += 1
        if _prune_n >= _PRUNE_TICK:
            _prune_n = 0
            _prune_disk()


def _prune_disk(keep=_PRUNE_KEEP):
    """磁盘缓存兜底清理。

    内存有 400 条上限，磁盘原来没有 —— key 带 mtime，片源每覆盖一次就多一份，
    长期只涨不跌。只清本节点自己的目录，**不碰 h3_proxy**：代理片是共用资产，
    删掉会让视频合并/监视器立刻重转一遍。
    """
    if not _CACHE_DIR:
        return
    try:
        names = [os.path.join(_CACHE_DIR, n) for n in os.listdir(_CACHE_DIR)]
    except OSError:
        return
    if len(names) <= keep:
        return
    def _mt(p):
        try:
            return os.path.getmtime(p)
        except OSError:
            return 0.0            # 列完目录就被删掉的文件排最前，顺手跳过

    names.sort(key=_mt)
    for p in names[:len(names) - keep]:
        try:
            os.unlink(p)
        except OSError:
            pass


def _jpeg_headers(key=None) -> dict:
    """帧图缓存策略（20261101）。

    原来是 ``private, max-age=3600``，而请求 URL 不带任何版本 —— 片源被同名
    覆盖（取最新成片）后，浏览器一小时内不回来验证，面板就一直显示旧画面。
    缓存键里已经含片源 mtime/size（见 _sig），拿它当 ETag：没变 304，变了
    必然取新图。
    """
    h = {"Cache-Control": "no-cache"}
    if key is not None:
        h["ETag"] = '"%s"' % hashlib.md5(repr(tuple(key)).encode("utf-8")).hexdigest()[:24]
    return h


def _not_modified(request, key) -> bool:
    etag = _jpeg_headers(key).get("ETag", "")
    inm = (request.headers.get("If-None-Match") or "").replace("W/", "")
    return bool(inm) and etag in [t.strip() for t in inm.split(",")]

# 尾帧落盘名：带栏号。固定名会让同一段的第二张参照图覆盖第一张 ——
# @图片25 和 @图片31 都指向 tail_ref.png 时，两栏永远是同一张图。
# 栏号在同段内不变，所以"换一段不用改指向"这个好处不受影响。
TAIL_NAME = "tail_ref.png"


def _tail_name(slot):
    try:
        i = int(slot)
    except (TypeError, ValueError):
        i = 0
    return ("tail_ref_%d.png" % i) if i > 0 else TAIL_NAME


def _input_root():
    if folder_paths is None:
        return ""
    try:
        return folder_paths.get_input_directory()
    except Exception:
        return ""


def _safe_join(root, *parts):
    """拼路径并锁死在 root 之内 —— 片名来自用户输入，不能让 ../ 穿出去。"""
    if not root:
        return ""
    path = os.path.abspath(os.path.join(root, *[p for p in parts if p]))
    root_abs = os.path.abspath(root)
    if path != root_abs and not path.startswith(root_abs + os.sep):
        return ""
    return path


def _resolve_video(video):
    """把前端传来的视频路径还原成磁盘路径（绝对/相对 output 都要认）。"""
    if not video:
        return ""
    text = str(video).strip().replace("\\", "/")
    if os.path.isabs(text) and os.path.isfile(text):
        return text
    base = ""
    if folder_paths is not None:
        try:
            base = folder_paths.get_output_directory()
        except Exception:
            base = ""
    if base:
        cand = _safe_join(base, text)
        if cand and os.path.isfile(cand):
            return cand
    return ""


def _probe(path):
    """帧数 / 帧率 / 尺寸。容器不写帧数时退回按时长估算。

    结果按 (路径, mtime, size) 缓存：取片后每次拖动都会问一次基本信息，没必要每次
    都开一遍容器；片源被覆盖则签名变了自动失效。
    """
    if av is None:
        return {"error": "PyAV 不可用"}
    key = (path,) + _sig(path)
    hit = _PROBE_CACHE.get(key)
    if hit:
        return dict(hit)
    try:
        with av.open(path) as c:
            s = c.streams.video[0]
            count = int(s.frames or 0)
            fps = 0.0
            try:
                fps = float(s.average_rate) if s.average_rate else 0.0
            except Exception:
                fps = 0.0
            if count <= 0 and fps > 0 and c.duration:
                count = int(c.duration / 1_000_000.0 * fps)
            info = {
                "frame_count": count,
                "fps": fps or 24.0,
                "width": int(s.width or 0),
                "height": int(s.height or 0),
            }
            if not info.get("error"):
                _PROBE_CACHE[key] = info
                if len(_PROBE_CACHE) > _CACHE_MAX:
                    _PROBE_CACHE.pop(next(iter(_PROBE_CACHE)), None)
            return info
    except Exception as exc:
        return {"error": "%s: %s" % (type(exc).__name__, exc)}


def _grab(path, frame_idx, width=None, need_full=False):
    """取第 frame_idx 帧（0-based，负数从末尾数），返回 PIL 图。

    width —— 只要这么宽：在**解码管线里**用 swscale 缩好再转 PIL。母片 3072×1728
    直接 to_image() 是 15.9MB/帧 的 RGB，实测一次抽帧能把进程内存从 41MB 顶到
    525MB；先缩再转，每帧只剩几 KB、耗时从 45~96ms 降到 5ms。

    need_full —— 最终要落盘的那一帧走母片；代理片只有 512px，落盘会糊。
    """
    if av is None or Image is None:
        return None
    # 帧数/帧率一律以母片为准（代理片是等帧重编码，但没必要拿它的元数据冒险）
    info = _probe(path)
    if info.get("error"):
        return None
    total = int(info.get("frame_count") or 0)
    fps = float(info.get("fps") or 24.0)
    if frame_idx < 0 and total > 0:
        frame_idx = max(0, total + frame_idx)
    if frame_idx < 0:
        frame_idx = 0

    src = _source_for(path, need_full)
    # 先按时间 seek 到目标前 1 秒再解码到目标帧：比从头逐帧解码快得多，又避开了
    # seek 落点不等于关键帧时差几帧的问题。
    with av.open(src) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        target_ts = frame_idx / fps if fps > 0 else 0.0
        _seek_to(c, s, target_ts - 1.0)
        last = None
        hit = None
        for f in c.decode(s):
            last = f
            ts = None
            try:
                if f.pts is not None and s.time_base is not None:
                    ts = float(f.pts * s.time_base)
            except Exception:
                ts = None
            # 时间戳拿不到就按 seek 落点后的**第一帧**算：容器缺 PTS 时根本定位
            # 不到目标帧，能给出的最接近结果就是首帧（不是"最后一帧"——那会跑到
            # 片尾，差出去几百帧）。宁可差几帧也不空手。
            if ts is None or ts + 1e-6 >= target_ts:
                hit = f
                break
        frame = hit or last
        if frame is None:
            return None
        if width and width > 0:
            return _scaled(frame, width)
        return frame.to_image().convert("RGB")


def _sprite(path, cols=8, cell_w=96, start=None, end=None):
    """把 [start, end] 区间均匀抽 cols 帧拼成一条横向胶片条 —— 面板时间轴拿它当轨道。

    一次顺序解码收齐所有需要的帧，而不是挨个 seek：seek 的落点是关键帧，和想要的
    帧号常常差几格，胶片条上就会出现重复画面或跳格。

    为什么要区间：时间轴可以缩放，放大到看 100 帧时若还拿全片等比缩放，画面会糊成
    一团。seeking 到区间前 1 秒再解码，只碰这几帧，缩放后照样清晰。
    """
    if av is None or Image is None:
        return None
    info = _probe(path)
    if info.get("error"):
        return None
    total = int(info.get("frame_count") or 0)
    fps = float(info.get("fps") or 24.0)
    if total <= 1:
        return None
    cols = max(2, min(64, int(cols)))
    cell_w = max(24, min(400, int(cell_w)))

    a = 0 if start is None else max(0, min(total - 1, int(start)))
    b = total - 1 if end is None else max(a, min(total - 1, int(end)))
    idxs = [a + round(i * (b - a) / (cols - 1)) if cols > 1 else a for i in range(cols)]
    want = set(idxs)
    got = {}

    # 抽帧一律走代理片（512px）：母片 3072×1728 解码 ~13ms/帧，代理片快一个数量级。
    # 且每帧都在解码管线里缩到 cell_w 再转 PIL —— 绝不落地全尺寸 RGB（15.9MB/帧）。
    src = _source_for(path)
    with av.open(src) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        _seek_to(c, s, a / fps - 1.0)
        for f in c.decode(s):
            if f.pts is None or s.time_base is None:
                continue
            try:
                idx = int(round(float(f.pts * s.time_base) * fps))
            except Exception:
                continue
            if idx < a:
                continue
            if idx > b:
                break
            if idx in want and idx not in got:
                got[idx] = _scaled(f, cell_w)
            if len(got) >= len(want):
                break
    if not got:
        return None

    first = got.get(idxs[0]) or next(iter(got.values()))
    cell_h = max(1, int(round(cell_w * first.height / max(1, first.width))))
    canvas = Image.new("RGB", (cell_w * cols, cell_h), (28, 28, 30))
    have = sorted(got)
    for i, idx in enumerate(idxs):
        img = got.get(idx)
        if img is None:                       # 缺帧就借最近的一帧，保证格子不空
            near = min(have, key=lambda j: abs(j - idx))
            img = got[near]
        canvas.paste(img if img.width == cell_w else img.resize((cell_w, cell_h)),
                     (i * cell_w, 0))

    buf = BytesIO()
    canvas.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


class CSGlideTailRef:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 面板状态（源片、帧号、已替换记录）全挂在 widget 上，前端隐藏：与
                # 导演台 h3_data / 媒体架 rack_data 同一套"面板 JSON 落 widget"做法。
                "tail_state": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("状态",)
    FUNCTION = "refresh"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = ("把上一段成片的某一帧换成下一段的参照图参考。"
                   "手动点按钮生效，运行工作流不做任何替换。")

    def refresh(self, tail_state=""):
        # 运行期只报状态：替换是前端按钮的事，这里越界动手会让"关掉按钮"这件事变得
        # 不可预测（跑一次就偷偷换一次）。
        try:
            import json
            st = json.loads(tail_state) if tail_state else {}
        except Exception:
            st = {}
        if not isinstance(st, dict):
            st = {}
        note = "⏱ 参照图替换：待手动点击"
        if st.get("replaced"):
            note = ("⏱ 参照图替换：第 %s 栏已指向 %s（第 %s 帧）"
                    % (st.get("index"), st.get("file"), st.get("frame")))
        print("[H3 参照图替换] %s" % note)
        return (note,)


NODE_CLASS_MAPPINGS = {"CSGlideTailRefCS": CSGlideTailRef}
NODE_DISPLAY_NAME_MAPPINGS = {"CSGlideTailRefCS": "⏱ 参照图替换 (Tail Ref)"}


if ROUTES is not None:

    @ROUTES.get(API + "/info")
    async def _tailref_info(request: web.Request) -> web.Response:
        """源片信息：帧数 / 帧率 / 尺寸 —— 面板时间轴靠它定位。"""
        path = _resolve_video(request.query.get("video", ""))
        if not path:
            return web.json_response({"error": "找不到这个视频文件"}, status=404)

        def run():
            return _probe(path)

        try:
            info = await asyncio.get_running_loop().run_in_executor(None, run)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        if info.get("error"):
            return web.json_response(info, status=500)
        return web.json_response(info)

    @ROUTES.get(API + "/preview")
    async def _tailref_preview(request: web.Request) -> web.Response:
        """单帧预览图（jpeg）—— 面板上"现在选的是哪一帧"用。"""
        path = _resolve_video(request.query.get("video", ""))
        if not path:
            return web.Response(status=404)
        try:
            frame = int(request.query.get("frame", "-1"))
        except ValueError:
            frame = -1
        try:
            width = max(64, min(640, int(request.query.get("w", "240"))))
        except ValueError:
            width = 240

        # 缓存键带文件签名：片源会被覆盖（取最新成片），不带 mtime 会命中旧画面
        key = ("pv", path) + _sig(path) + (frame, width)
        if _not_modified(request, key):
            return web.Response(status=304, headers=_jpeg_headers(key))
        body = _cached_body(key)
        if body:
            return web.Response(body=body, content_type="image/jpeg",
                                headers=_jpeg_headers(key))

        def run():
            # 直接在解码管线里缩到目标宽度 —— 不做全尺寸 to_image（省 15.9MB/帧）
            img = _grab(path, frame, width=width)
            if img is None:
                return None
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=82)
            return buf.getvalue()

        # 并发闸门：同时最多 2 个解码，放任并发会把 32 核抢光（实测 5 并发 8.7s）
        async with _SPRITE_SEM:
            try:
                body = await asyncio.get_running_loop().run_in_executor(None, run)
            except Exception as exc:
                return web.Response(status=500, text=str(exc))
        if body is None:
            return web.Response(status=404)
        _store_body(key, body)
        return web.Response(body=body, content_type="image/jpeg",
                            headers=_jpeg_headers(key))

    @ROUTES.get(API + "/sprite")
    async def _tailref_sprite(request: web.Request) -> web.Response:
        """时间轴胶片条：在 [start, end] 区间里等距抽 cols 格拼成一张横图。

        不带 start/end 就是全片（适配视图）；带就是缩放后的可见窗口。
        """
        path = _resolve_video(request.query.get("video", ""))
        if not path:
            return web.Response(status=404)

        def num(key, dflt):
            v = request.query.get(key)
            if v is None or v == "":
                return dflt
            try:
                return int(v)
            except ValueError:
                return dflt

        cols = num("cols", 8)
        cell_w = num("w", 96)
        start = num("start", None)
        end = num("end", None)

        key = ("sp", path) + _sig(path) + (cols, cell_w, start, end)
        if _not_modified(request, key):
            return web.Response(status=304, headers=_jpeg_headers(key))
        body = _cached_body(key)
        if body:
            return web.Response(body=body, content_type="image/jpeg",
                                headers=_jpeg_headers(key))

        def run():
            return _sprite(path, cols, cell_w, start, end)

        async with _SPRITE_SEM:
            try:
                body = await asyncio.get_running_loop().run_in_executor(None, run)
            except Exception as exc:
                return web.Response(status=500, text=str(exc))
        if body is None:
            return web.Response(status=404)
        _store_body(key, body)
        return web.Response(body=body, content_type="image/jpeg",
                            headers=_jpeg_headers(key))

    @ROUTES.post(API + "/grab")
    async def _tailref_grab(request: web.Request) -> web.Response:
        """抽帧落盘：写成 input/cglide/<片名>/tail_ref_<栏号>.png，返回媒体架用的相对路径。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        path = _resolve_video(body.get("video", ""))
        if not path:
            return web.json_response({"error": "找不到这个视频文件"}, status=404)
        try:
            frame = int(body.get("frame", -1))
        except (TypeError, ValueError):
            frame = -1
        name = str(body.get("name") or "").strip()

        root = _input_root()
        if not root:
            return web.json_response({"error": "拿不到 input 目录"}, status=500)

        # 片名里有路径分隔符会打乱落盘结构，压成平铺名
        safe_name = re.sub(r"[\\/:*?\"<>|]+", "_", name)
        rel_dir = "cglide/" + safe_name if safe_name else "cglide"
        out_dir = _safe_join(root, rel_dir)
        if not out_dir:
            return web.json_response({"error": "片名不合法"}, status=400)
        try:
            os.makedirs(out_dir, exist_ok=True)
        except OSError as exc:
            return web.json_response({"error": "建目录失败：%s" % exc}, status=500)
        out_path = os.path.join(out_dir, _tail_name(body.get("slot")))

        def run():
            # need_full：这张是要写进 input 当参照图用的，必须解母片全分辨率。
            # 代理片只有 512px，落盘会让参照图糊掉 —— 预览可以省，落盘不能省。
            img = _grab(path, frame, need_full=True)
            if img is None:
                return None
            img.save(out_path)
            return [img.width, img.height]

        async with _SPRITE_SEM:
            try:
                size = await asyncio.get_running_loop().run_in_executor(None, run)
            except Exception as exc:
                return web.json_response(
                    {"error": "%s: %s" % (type(exc).__name__, exc)}, status=500)
        if not size:
            return web.json_response({"error": "取帧失败（视频打不开或帧号越界）"},
                                     status=500)

        rel_file = "%s/%s" % (rel_dir, _tail_name(body.get("slot")))
        print("[H3 参照图替换] 已落盘 %s（第 %s 帧，源 %s）"
              % (rel_file, frame, os.path.basename(path)))
        return web.json_response({
            "file": rel_file,
            "frame": frame,
            "width": size[0], "height": size[1],
        })
