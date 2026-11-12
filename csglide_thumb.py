# -*- coding: utf-8 -*-
"""媒体架缩略图路由 —— 只做一件事：把原图真缩成小图，并缓存下来。

为什么非要自己写一条（20261020）：ComfyUI 自带的 /view?preview=webp;50
**不缩放尺寸** —— server.py:644-658 只有 img.save(format, quality)，没有
thumbnail/resize。4000×3000 的原图返回仍然是 4000×3000，于是：

    · 浏览器解码后按像素占内存 ≈ 4000×3000×4B ≈ 46 MB/张，几十张就是 GB 级
    · 服务端每次请求都要完整解码一遍原图再编码，而且没有缓存

    GET /cglide/thumb?filename=&subfolder=&size=256     → webp

⚠️ 只给**图片**用。PIL 打不开视频/音频，请求它们会拿到 415。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os

from aiohttp import web

import folder_paths
from server import PromptServer

PREFIX = "/cglide/thumb"

# 缩略图边长上限。卡片实际显示百来像素，256 在 2× 屏上也够；上限防有人传个
# 离谱的 size 来把整张原图搬一遍。
THUMB_MAX = 512
THUMB_DEFAULT = 256

# 缓存落在 temp：既不污染 input/output，也不进工程目录。
_CACHE_SUB = os.path.join("cglide", "thumb")

# 生成失败的文件记一笔，不再反复重试（PIL 打不开的格式重试也没用）。
# 只存路径，进程重启即清空 —— 换了解码器/换了图会重新试一次。
_failed: set = set()


def _resolve_inside(root: str, *parts: str) -> str | None:
    """Join under ``root``，拒绝任何逃出去的路径。

    subfolder / filename 都来自浏览器，不校验的话一个 ``../../etc/passwd``
    就能读到任意文件。realpath + 前缀比较是唯一能扛住 ``..`` 混软链接的写法。
    """
    candidate = os.path.realpath(os.path.join(root, *parts))
    root = os.path.realpath(root)
    if candidate != root and not candidate.startswith(root + os.sep):
        return None
    return candidate


def cache_name(path: str, size: int) -> str:
    """缓存文件名 = 路径 + mtime + size 的哈希。

    mtime 进 key，所以原图一改就自动重新生成，不需要手动清缓存；
    size 也进 key，同一张图的不同尺寸各存一份，互不覆盖。
    """
    h = hashlib.sha1()
    h.update(path.encode("utf-8", "surrogateescape"))
    st = os.stat(path)
    h.update(str(st.st_mtime_ns).encode())
    h.update(str(st.st_size).encode())
    h.update(str(size).encode())
    return h.hexdigest()[:24] + ".webp"


def make_thumb(path: str, size: int) -> bytes:
    """PIL 缩图并编码成 webp。阻塞操作，由调用方丢进 executor。"""
    from PIL import Image      # 函数内 import：不在插件 import 阶段付代价

    with Image.open(path) as im:
        im.thumbnail((size, size), Image.LANCZOS)
        # webp 吃不下 P / CMYK 这类模式，统一转 RGB（缩略图不需要保真色彩空间）
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=82)
        return buf.getvalue()


def _cache_headers(etag: str) -> dict:
    """缩略图缓存策略（20261101）。

    以前是 ``public, max-age=31536000, immutable``，依据是「同一 URL 的内容
    永不变」。但 URL 里只有文件名/子目录/边长，**同名文件在本地被替换后 URL
    一模一样** —— 浏览器按 immutable 一年不发请求，媒体架于是永远显示旧图
    （删图 → 本地换同名新图 → 重新导入，看到的还是老一张）。

    改成 no-cache + ETag：每次使用前回源验证，没变就 304（几十字节、不解码
    不传图），文件一换 ETag 必变、必然取新图。服务端磁盘缓存本来就以 mtime
    为 key，这里只是让「验证」这件事有机会发生。
    """
    return {"Cache-Control": "no-cache", "ETag": etag}


@PromptServer.instance.routes.get(PREFIX)
async def _thumb(request: web.Request) -> web.Response:
    name = request.query.get("filename") or ""
    sub = request.query.get("subfolder") or ""
    if not name:
        return web.json_response({"error": "filename is required"}, status=400)

    try:
        size = int(request.query.get("size") or THUMB_DEFAULT)
    except ValueError:
        size = THUMB_DEFAULT
    size = max(32, min(THUMB_MAX, size))

    src = _resolve_inside(folder_paths.get_input_directory(), sub, name)
    if not src or not os.path.isfile(src):
        return web.json_response({"error": "not found"}, status=404)
    if src in _failed:
        return web.json_response({"error": "unsupported image"}, status=415)

    cache_dir = os.path.join(folder_paths.get_temp_directory(), _CACHE_SUB)
    try:
        tag = cache_name(src, size)
    except OSError:
        return web.json_response({"error": "not found"}, status=404)
    etag = '"%s"' % tag.split(".")[0]
    inm = (request.headers.get("If-None-Match") or "").replace("W/", "")
    if inm and etag in [t.strip() for t in inm.split(",")]:
        return web.Response(status=304, headers=_cache_headers(etag))
    out = os.path.join(cache_dir, tag)
    if not os.path.isfile(out):
        try:
            data = await asyncio.get_running_loop().run_in_executor(None, make_thumb, src, size)
        except Exception as exc:
            _failed.add(src)
            return web.json_response({"error": str(exc)}, status=415)
        os.makedirs(cache_dir, exist_ok=True)
        tmp = out + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, out)      # 原子替换：并发请求不会读到半截文件

    # 不用 FileResponse：它会在 prepare 里用自己猜的 content_type 覆盖掉我们传的
    # 头，.webp 认不认全看系统 mimetypes。缩略图才几十 KB，读出来自己发，
    # Content-Type 才是确定的。
    with open(out, "rb") as f:
        data = f.read()
    return web.Response(body=data, content_type="image/webp",
                        headers=_cache_headers(etag))
