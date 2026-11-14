# -*- coding: utf-8 -*-
"""
🎬 班长-剧本全流程生图（V2 整合节点）
标签页 + 步骤条；拖入文件 → 资产批量生图 → 核心帧带参考生图；
单张重生/锁定，断点续跑，流程实时可见。只走 API。
file_list_json 结构：{"session":"会话id","files":[{"path":...,"name":...}]}
"""
import json
import os

import numpy as np
import torch
from PIL import Image
from folder_paths import get_output_directory

from .._script_pipeline.parser import clean_filename
from .._script_pipeline.state import SessionState
from .._script_pipeline.runner import run_pending, rerun_one, _ensure_inside_output

DEFAULT_DIR = os.path.join(get_output_directory(), "剧本资产")


def _subfolder(out_dir):
    try:
        sub = os.path.relpath(out_dir, get_output_directory()).replace("\\", "/")
        return "" if sub.startswith("..") else sub
    except Exception:
        return ""


def _params(kw):
    return {
        "url": kw["🔗 API地址"], "key": kw["🔑 API密钥"],
        "model": kw["🤖 模型名称"], "size_rule": kw["📐 尺寸规则"],
        "size_preset": kw["🖥️ 尺寸预设"], "width": kw["↔️ 宽"],
        "height": kw["↕️ 高"], "seed": kw["🎲 起始种子"],
        "seed_control": kw["🎲 种子控制"], "timeout": kw["⏱️ 超时秒数"],
        "subfolder": _subfolder(kw["📁 输出目录"]),
    }


def _load_batch(out_dir, items):
    tensors = []
    for it in items:
        if it["file"]:
            path = os.path.join(out_dir, it["file"])
            if os.path.exists(path):
                arr = np.array(Image.open(path).convert("RGB"),
                               dtype=np.float32) / 255.0
                tensors.append(torch.from_numpy(arr)[None,])
    if not tensors:
        return torch.zeros(1, 64, 64, 3)
    try:
        return torch.cat(tensors, dim=0)
    except Exception:
        return tensors[0]


class BanZhang_ScriptPipeline:
    """🎬 班长-剧本全流程生图。"""

    @classmethod
    def INPUT_TYPES(cls):
        from .banzhang_image_api import load_size_presets
        return {
            "required": {
                "file_list_json": ("STRING", {"default": ""}),
                "🎨 资产生图来源": (["☁️ 云API", "🔌 本地工作流"],
                               {"default": "☁️ 云API"}),
                "🎨 核心帧生图来源": (["☁️ 云API", "🔌 本地工作流"],
                               {"default": "☁️ 云API"}),
                "🔗 API地址": ("STRING", {"default": ""}),
                "🔑 API密钥": ("STRING", {"default": ""}),
                "🤖 模型名称": ("STRING", {"default": "nano-banana-2"}),
                "📐 尺寸规则": (["🛠️ 使用下方预设", "✍️ 使用手动输入"],
                               {"default": "🛠️ 使用下方预设"}),
                "🖥️ 尺寸预设": (load_size_presets(),
                               {"default": "📱 9:16 - 4K (2160x3840) | 海报级"}),
                "↔️ 宽": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "↕️ 高": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "🎲 起始种子": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "🎲 种子控制": (["increment", "fixed"], {"default": "increment"}),
                "⏱️ 超时秒数": ("INT", {"default": 300, "min": 30, "max": 3600, "step": 10}),
                "📁 输出目录": ("STRING", {"default": DEFAULT_DIR}),
            },
            "optional": {
                "🔌 本地资产引擎": ("BZ_LOCAL_ASSET_ENGINE",),
                "🔌 本地核心帧引擎": ("BZ_LOCAL_FRAME_ENGINE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("🖼️ 资产图", "🎬 核心帧图", "📄 运行报告")
    FUNCTION = "run"
    CATEGORY = "👨‍🏫班长/剧本资产"

    def run(self, file_list_json, **kw):
        try:
            payload = json.loads(file_list_json or "{}")
        except Exception:
            payload = {}
        files = payload.get("files", [])
        session_id = payload.get("session") or "default"
        if not files:
            raise ValueError("还没有拖入任何剧本文件，请把 .md/.txt 拖进节点面板")
        for f in files:
            if not os.path.isfile(f.get("path", "")):
                raise ValueError(f"文件不存在或已被移动：{f.get('name')}")

        out_dir = kw["📁 输出目录"]
        asset_local = str(kw.get("🎨 资产生图来源", "")).startswith("🔌")
        kf_local = str(kw.get("🎨 核心帧生图来源", "")).startswith("🔌")
        asset_engine = kw.get("🔌 本地资产引擎")
        frame_engine = kw.get("🔌 本地核心帧引擎")
        if asset_local and asset_engine is None:
            raise ValueError("资产已选择「🔌 本地工作流」，但左侧未连接「🎬 本地文生图器」")
        if kf_local and frame_engine is None:
            raise ValueError("核心帧已选择「🔌 本地工作流」，但左侧未连接「🎬 本地参考图生图器」")

        state = SessionState(session_id)
        state.rebuild(files)
        run_pending(state, _params(kw), out_dir,
                    asset_engine if asset_local else None,
                    frame_engine if kf_local else None)

        report = json.dumps(state.summary(), ensure_ascii=False, indent=2)
        return (_load_batch(out_dir, state.data["assets"]),
                _load_batch(out_dir, state.data["kfs"]), report)


# ── 路由：拖拽重建 / 单张重跑 / 锁定 / 状态恢复 ──────────────────
def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(_register_routes, "_done", False):
        return

    def _state_of(data):
        return SessionState(data.get("session", "default"))

    @server.routes.post("/banzhang/sp_rebuild")
    async def _rebuild(request):
        data = await request.json()
        state = _state_of(data)
        try:
            state.rebuild(data.get("files", []))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response(state.summary())

    @server.routes.post("/banzhang/sp_rerun")
    async def _rerun(request):
        data = await request.json()
        state = _state_of(data)
        rerun_one(state, data.get("params", {}), data.get("kind"),
                  data.get("id"), data.get("params", {}).get("out_dir",
                                                             DEFAULT_DIR))
        return web.json_response(state.summary())

    @server.routes.post("/banzhang/sp_lock")
    async def _lock(request):
        data = await request.json()
        state = _state_of(data)
        target = "locked" if data.get("locked") else "ok"
        state.set_item(data.get("kind"), data.get("id"), status=target)
        return web.json_response(state.summary())

    @server.routes.post("/banzhang/sp_mark_rerun")
    async def _mark_rerun(request):
        """本地引擎模式的单张重生：HTTP 路由拿不到连线上的引擎对象，
        这里只把条目重置为 pending，由前端重新执行整个节点（引擎只跑 pending）。"""
        data = await request.json()
        state = _state_of(data)
        state.set_item(data.get("kind"), data.get("id"),
                       status="pending", error="")
        return web.json_response(state.summary())

    @server.routes.post("/banzhang/sp_state")
    async def _state(request):
        data = await request.json()
        return web.json_response(_state_of(data).summary())

    _register_routes._done = True


_register_routes()


def _register_upload_route():
    """拖拽上传：内容持久到 caches/script_parser。"""
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(_register_upload_route, "_done", False):
        return

    @server.routes.post("/banzhang/upload_script")
    async def _upload_route(request):
        data = await request.json()
        raw_name = str(data.get("name", "script.txt"))
        ext = os.path.splitext(raw_name)[1].lower()
        if ext not in (".md", ".txt"):
            ext = ".txt"
        base_name = clean_filename(os.path.splitext(raw_name)[0]) or "script"
        save_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "caches", "script_parser")
        os.makedirs(save_dir, exist_ok=True)
        path = os.path.join(save_dir, base_name + ext)
        i = 2
        while os.path.exists(path):
            path = os.path.join(save_dir, f"{base_name}_{i}{ext}")
            i += 1
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(data.get("content", "")))
        return web.json_response({"path": path, "name": raw_name})

    @server.routes.post("/banzhang/sp_import_assets")
    async def _import_assets(request):
        """批量导入已按资产名命名的图片：跳过对应资产的生成，直接供核心帧引用。

        表单字段：session（文本）、out_dir（文本）、images（多个图片文件）。
        匹配规则：图片文件名（去扩展名）与资产 name 完全一致；统一转存 PNG。
        """
        import io
        try:
            reader = await request.multipart()
        except Exception as e:
            return web.json_response({"error": f"上传解析失败：{e}"}, status=400)

        session_id, out_dir, files = "default", DEFAULT_DIR, []
        while True:
            field = await reader.next()
            if field is None:
                break
            if field.name == "session":
                session_id = (await field.read()).decode("utf-8", "ignore") or "default"
            elif field.name == "out_dir":
                out_dir = (await field.read()).decode("utf-8", "ignore") or DEFAULT_DIR
            elif field.name == "images":
                chunks = []
                while True:
                    chunk = await field.read_chunk(size=2 ** 20)
                    if not chunk:
                        break
                    chunks.append(chunk)
                if field.filename:
                    files.append((field.filename, b"".join(chunks)))

        state = SessionState(session_id)
        try:
            _ensure_inside_output(out_dir)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        os.makedirs(out_dir, exist_ok=True)

        allowed = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
        # 同一批里同名文件只取最后一张，避免重复导入互相覆盖
        by_name = {a.get("name"): a for a in state.data["assets"]}
        imported, unmatched = [], []
        for fname, blob in files:
            base, ext = os.path.splitext(os.path.basename(fname))
            key = base.strip()
            if ext.lower() not in allowed:
                unmatched.append(f"{fname}（不是图片文件）")
                continue
            if len(blob) > 64 * 1024 * 1024:
                unmatched.append(f"{fname}（超过 64MB 限制）")
                continue
            item = by_name.get(key)
            if item is None:
                unmatched.append(f"{fname}（剧本里没有同名资产）")
                continue
            try:
                img = Image.open(io.BytesIO(blob)).convert("RGB")
                target = os.path.join(out_dir, item["name"] + ".png")
                # 目标名已被别的条目占用（历史重名）时退避，绝不覆盖他人图
                if os.path.exists(target) and os.path.basename(target) != item.get("file"):
                    i = 2
                    while os.path.exists(os.path.join(out_dir, f"{item['name']}_{i}.png")):
                        i += 1
                    target = os.path.join(out_dir, f"{item['name']}_{i}.png")
                # 清掉该条目旧图（与新目标不同名时），不留孤儿文件
                old = item.get("file")
                if old and old != os.path.basename(target):
                    oldp = os.path.join(out_dir, old)
                    if os.path.isfile(oldp):
                        try:
                            os.remove(oldp)
                        except OSError:
                            pass
                img.save(target, format="PNG")
                new_status = "locked" if item.get("status") == "locked" else "ok"
                state.set_item("asset", item["id"], status=new_status,
                               file=os.path.basename(target),
                               subfolder=_subfolder(out_dir), error="")
                imported.append(key)
            except Exception as e:
                unmatched.append(f"{fname}（图片无法读取：{str(e)[:60]}）")

        if imported:
            state.log(f"导入已有资产图 {len(imported)} 张：{ '、'.join(imported) }")
        if unmatched:
            state.log(f"{len(unmatched)} 张图未导入：{ '、'.join(unmatched) }")
        summary = state.summary()
        summary["imported"] = imported
        summary["unmatched"] = unmatched
        return web.json_response(summary)

    _register_upload_route._done = True


_register_upload_route()


NODE_CLASS_MAPPINGS = {
    "BanZhang_ScriptPipeline": BanZhang_ScriptPipeline,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_ScriptPipeline": "🎬 班长-剧本全流程生图",
}
