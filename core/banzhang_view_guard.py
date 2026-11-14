# -*- coding: utf-8 -*-
"""让 /view 对视频文件也给出可用响应（20261106）。

现象
----
前端某些预览路径会把视频文件当成图片来要（URL 里带 ``preview=webp;90``），
而 ComfyUI 的 ``/view`` 只要看到 ``preview`` 就用 ``PIL.Image.open()`` 打开文件，
于是 mp4 必炸，日志每次刷新预览都刷一条 ERROR：

    PIL.UnidentifiedImageError: cannot identify image file '...\\input\\二采_N468_0101.mp4'

它不影响出图（图片照常写盘、照常显示），但把真正的报错淹掉了。

做法
----
注册一个中间件，**只在**「路径是 /view + 带 preview 或 channel + 后缀是视频」时抢先应答
（这两个参数都会让原处理器走 PIL 解码）：

* 请求头 ``Sec-Fetch-Dest: video``  → 原文件当视频返回（FileResponse 自带 Range，能拖进度）；
* 其余（``<img>`` 来要缩略图）      → 返回首帧 webp，节点预览真有画面；
* 解不出来                          → 404，日志干净。

其它请求原样交回 ComfyUI 原处理器，行为不变；本模块任何异常也只降级为「交回原处理器」。
缩略图按 (路径, mtime, size) 缓存在 ``temp/_班长视频缩略图/``，同一文件只解一次。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os

from aiohttp import web

import folder_paths
from server import PromptServer

_视频后缀 = {
    ".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v",
    ".flv", ".wmv", ".mpg", ".mpeg", ".ts", ".m2ts", ".mxf",
}
_缩略图边长 = 512


def _定位文件(request):
    """复刻 server.py view_image 的路径解析，拒绝越权访问。"""
    query = request.rel_url.query
    filename = query.get("filename", "")
    if not filename or filename.startswith("blake3:"):
        return None

    filename, output_dir = folder_paths.annotated_filepath(filename)
    if not filename or filename[0] in "/\\" or ".." in filename:
        return None
    if output_dir is None:
        output_dir = folder_paths.get_directory_by_type(query.get("type", "output"))
    if output_dir is None:
        return None

    subfolder = query.get("subfolder")
    if subfolder:
        full = os.path.join(output_dir, subfolder)
        if os.path.commonpath((os.path.abspath(full), os.path.abspath(output_dir))) != os.path.abspath(output_dir):
            return None
        output_dir = full

    path = os.path.join(output_dir, os.path.basename(filename))
    return path if os.path.isfile(path) else None


def _解码首帧(path):
    import av

    with av.open(path) as container:
        if not container.streams.video:
            return None
        for frame in container.decode(container.streams.video[0]):
            return frame.to_image().convert("RGB")
    return None


def _缩略图(path, 质量):
    """返回 webp 字节；解不出来返回 None。结果按 mtime + 大小缓存。"""
    try:
        stat = os.stat(path)
        key = hashlib.sha1(
            f"{path}|{stat.st_mtime_ns}|{stat.st_size}|{_缩略图边长}".encode("utf-8")
        ).hexdigest()
        缓存目录 = os.path.join(folder_paths.get_temp_directory(), "_班长视频缩略图")
        缓存 = os.path.join(缓存目录, key + ".webp")
        if os.path.isfile(缓存):
            with open(缓存, "rb") as handle:
                return handle.read()

        image = _解码首帧(path)
        if image is None:
            return None
        image.thumbnail((_缩略图边长, _缩略图边长))
        buffer = io.BytesIO()
        image.save(buffer, format="webp", quality=max(1, min(100, int(质量))))
        data = buffer.getvalue()

        os.makedirs(缓存目录, exist_ok=True)
        临时 = f"{缓存}.{os.getpid()}.tmp"
        with open(临时, "wb") as handle:
            handle.write(data)
        os.replace(临时, 缓存)
        return data
    except Exception as error:  # 解码库缺失、坏文件等，一律当「没缩略图」
        print(f"⚠️ [班长全家桶] 视频缩略图生成失败（{os.path.basename(path)}：{error}）")
        return None


def _预览质量(request):
    # preview=webp;90 → 90
    片段 = request.rel_url.query.get("preview", "").split(";")[-1]
    return int(片段) if 片段.isdigit() else 90


async def _应答(request):
    path = _定位文件(request)
    if path is None:
        return web.Response(status=404)

    if request.headers.get("Sec-Fetch-Dest", "") == "video":
        return web.FileResponse(path)  # 让 <video> 拿到真视频，可拖动进度

    data = await asyncio.to_thread(_缩略图, path, _预览质量(request))
    if data is None:
        return web.Response(status=404)
    return web.Response(body=data, content_type="image/webp", headers={"Cache-Control": "no-store"})


@web.middleware
async def 视频预览(request, handler):
    try:
        query = request.rel_url.query
        # preview / channel 都会让原处理器走 PIL 解码，对视频必炸，所以这两种都要接住。
        if request.path == "/view" and ("preview" in query or "channel" in query):
            if os.path.splitext(query.get("filename", ""))[1].lower() in _视频后缀:
                return await _应答(request)
    except Exception as error:
        print(f"⚠️ [班长全家桶] 视频预览兜底异常（{error}），交回原处理器。")
    return await handler(request)


_实例 = getattr(PromptServer, "instance", None)

if _实例 is not None and not getattr(_实例, "_bz_view_guard", False):
    try:
        _实例.app.middlewares.append(视频预览)
    except RuntimeError:  # 应用已启动，中间件列表冻结
        pass
    else:
        _实例._bz_view_guard = True
