# -*- coding: utf-8 -*-
"""媒体架素材上传路由 —— 把「同名 = 同一素材」这条假设拆掉（20261112 根因修复）。

旧链路 /upload/image + overwrite=true：同名直接覆盖。微信导出的图都叫
图片2.png，拖 N 张不同的图会互相顶掉、磁盘只剩一份（用户实测丢图）。
根因是「文件名即身份」分不清「同一素材改了内容」和「不同素材恰好同名」。

本路由在落盘前按**内容哈希**判定：
  · 目标不存在 / 内容相同 → 正常落盘（同名同内容仍当更新，槽位路径不动，
    保住「在外面改了图再拖回来、引用它的格子自动换新」这个正当工作流）；
  · 同名但内容不同：
      resolve=auto    → 不落盘，回 conflict，让前端问用户「替换 / 新增」；
      resolve=replace → 覆盖旧文件（用户明确要替换）；
      resolve=new     → 落一份内容哈希命名的新文件（图片2.a1b2c3d4.png），
                        与旧文件并存，丢图从结构上不可能。

哈希在服务端算（sha256），不依赖浏览器 crypto.subtle —— 局域网 http 访问
不是安全上下文，前端拿不到 subtle，服务端算才稳。
"""

from __future__ import annotations

import hashlib
import os

from aiohttp import web

import folder_paths
from server import PromptServer

PREFIX = "/cglide/asset_upload"


def _resolve_inside(root: str, *parts: str) -> str | None:
    """Join under ``root``，拒绝任何逃出去的路径（与 csglide_thumb 同口径）。"""
    candidate = os.path.realpath(os.path.join(root, *parts))
    root = os.path.realpath(root)
    if candidate != root and not candidate.startswith(root + os.sep):
        return None
    return candidate


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_atomic(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)      # 原子替换：并发请求不会读到半截文件


def _rel(sub: str, name: str) -> str:
    return f"{sub}/{name}" if sub else name


@PromptServer.instance.routes.post(PREFIX)
async def _asset_upload(request: web.Request) -> web.Response:
    try:
        post = await request.post()
    except Exception:
        # 与旧 /upload/image 的 413 对齐：前端按「超过上传上限」提示。
        return web.json_response({"error": "上传体解析失败（可能超过上传上限）"}, status=413)
    img = post.get("image")
    if img is None or not hasattr(img, "file"):
        return web.json_response({"error": "缺少上传文件"}, status=400)
    raw = img.file.read()
    fname = os.path.basename(str(img.filename or "").replace("\\", "/")).strip()
    if not fname:
        return web.json_response({"error": "文件名为空"}, status=400)
    sub = str(post.get("subfolder") or "").strip().strip("/")
    resolve = str(post.get("resolve") or "auto")

    root = folder_paths.get_input_directory()
    directory = _resolve_inside(root, sub) if sub else root
    if directory is None:
        return web.json_response({"error": "非法目录"}, status=400)
    target = _resolve_inside(directory, fname)
    if target is None:
        return web.json_response({"error": "非法文件名"}, status=400)

    incoming = _sha256(raw)
    if os.path.isfile(target):
        try:
            with open(target, "rb") as f:
                existing = _sha256(f.read())
        except OSError:
            existing = None
        if existing == incoming:
            # 同名同内容：当更新，原地落盘，槽位路径不动。
            _write_atomic(target, raw)
            return web.json_response({"status": "same", "name": fname,
                                      "subfolder": sub, "path": _rel(sub, fname)})
        # 同名不同内容：默认不落盘，交给用户定夺。
        if resolve == "auto":
            return web.json_response({"status": "conflict", "name": fname,
                                      "subfolder": sub})
        if resolve == "new":
            stem, ext = os.path.splitext(fname)
            new_name = f"{stem}.{incoming[:8]}{ext}"
            new_path = _resolve_inside(directory, new_name)
            if new_path is None:
                return web.json_response({"error": "非法文件名"}, status=400)
            # 内容哈希命名天然去重：同内容重导落同一份；极端撞名再补全哈希。
            if os.path.isfile(new_path):
                with open(new_path, "rb") as f:
                    if _sha256(f.read()) != incoming:
                        new_name = f"{stem}.{incoming}{ext}"
                        new_path = _resolve_inside(directory, new_name)
            _write_atomic(new_path, raw)
            return web.json_response({"status": "new", "name": new_name,
                                      "subfolder": sub, "path": _rel(sub, new_name)})
        # resolve == "replace"：用户明确要替换，覆盖旧文件。
        _write_atomic(target, raw)
        return web.json_response({"status": "replaced", "name": fname,
                                  "subfolder": sub, "path": _rel(sub, fname)})
    # 目标不存在：正常落盘。
    _write_atomic(target, raw)
    return web.json_response({"status": "stored", "name": fname,
                              "subfolder": sub, "path": _rel(sub, fname)})