# -*- coding: utf-8 -*-
"""执行器：单张/批量调 API，状态实时广播；失败只标记当前条目，不连带。"""
import os
import re

import numpy as np
import torch
from PIL import Image

from .state import _brief


def _emit(session, event, **data):
    try:
        from server import PromptServer
        s = getattr(PromptServer, "instance", None)
        if s:
            s.send_sync("script_pipeline",
                        {"event": event, "session": session, **data})
    except Exception:
        pass


def _unique_path(folder, name):
    path = os.path.join(folder, name + ".png")
    i = 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{name}_{i}.png")
        i += 1
    return path


def _subfolder(out_dir):
    try:
        from folder_paths import get_output_directory
        sub = os.path.relpath(out_dir, get_output_directory()).replace("\\", "/")
        return "" if sub.startswith("..") else sub
    except Exception:
        return ""


def _ensure_inside_output(out_dir):
    """前端缩略图走 /view?type=output，只能看 output 内文件，越界目录会导致卡片图全裂。"""
    from folder_paths import get_output_directory
    root = os.path.abspath(get_output_directory())
    target = os.path.abspath(out_dir)
    if target != root and not target.startswith(root + os.sep):
        raise ValueError(
            f"输出目录必须在 ComfyUI 的 output 目录内，否则面板缩略图无法显示。\n当前目录：{out_dir}")


def _save_tensor(img, folder, name):
    path = _unique_path(folder, name)
    arr = (img.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    Image.fromarray(arr).save(path)
    return os.path.basename(path)


def base_kwargs(p):
    return {
        "🔗 自定义地址": p["url"], "🔑 API密钥": p["key"],
        "🚫 禁用系统代理": p.get("no_proxy", False),
        "🤖 模型名称": p["model"], "📝 提示词": "",
        "📐 尺寸规则": p["size_rule"], "🖥️ 尺寸预设": p["size_preset"],
        "↔️ 手动宽": p["width"], "↕️ 手动高": p["height"],
        "🎲 随机种子": p["seed"], "🎲 种子控制": p["seed_control"],
        "🐞 详细日志": False, "⏱️ 超时秒数": p["timeout"],
        "🛑 失败时中断": True,
    }


def _h3_for_frame(item, out_dir, assets):
    paths = {a["id"]: os.path.join(out_dir, a["file"])
             for a in assets if a["status"] in ("ok", "locked")}
    missing = [r for r in item["refs"] if r not in paths]
    if missing:
        raise ValueError("引用资产未就绪：" + ", ".join(missing))
    numbers = [int(r.replace("@图片", "")) for r in item["refs"]]
    slots = [{}] * max(numbers)
    for r in item["refs"]:
        no = int(r.replace("@图片", ""))
        slots[no - 1] = {"file": paths[r]}
    return {"slots": {"images": slots, "videos": [], "audios": []}}


def _load_refs_for_item(out_dir, assets, item):
    """本地引擎用：按 refs 顺序把已就绪资产图读成 IMAGE tensor。"""
    paths = {a["id"]: os.path.join(out_dir, a["file"])
             for a in assets if a["status"] in ("ok", "locked") and a.get("file")}
    missing = [r for r in item["refs"] if r not in paths]
    if missing:
        raise ValueError("引用资产未就绪：" + ", ".join(missing))
    tensors = []
    for r in item["refs"]:
        arr = np.array(Image.open(paths[r]).convert("RGB"),
                       dtype=np.float32) / 255.0
        tensors.append(torch.from_numpy(arr)[None, ])
    return tensors


def run_one(state, get_api, kw_base, kind, item, out_dir, subfolder,
            asset_engine=None, frame_engine=None):
    was_locked = item["status"] == "locked"
    state.set_item(kind, item["id"], status="running", error="")
    _emit(state.session_id, "item", kind=kind, item=_brief(item))
    state.log(f"{kind} 开始：{item['name']}")
    _emit(state.session_id, "log", line=state.data["logs"][-1])

    try:
        local_engine = asset_engine if kind == "asset" else frame_engine
        if local_engine is not None:
            # 本地工作流：引擎直接跑核心采样链，不经过任何外部 API
            if kind == "asset" or not item.get("refs"):
                if kind == "kf":
                    state.log(f"{item['name']} 未引用任何资产，按文生图生成")
                    _emit(state.session_id, "log", line=state.data["logs"][-1])
                img, _seed = local_engine.generate(item["prompt"])
            else:
                refs = _load_refs_for_item(out_dir, state.data["assets"], item)
                img, _seed = local_engine.generate(item["prompt"], refs)
            imgs = [img]
        elif kind == "asset":
            kw = dict(kw_base, **{
                "🎨 生成类型": "✨ 文生图 (Generations)",
                "📝 外接提示词": item["prompt"],
            })
            imgs, _report, _seed = get_api().dispatch_generate(**kw)
        elif item.get("refs"):
            h3 = _h3_for_frame(item, out_dir, state.data["assets"])
            kw = dict(kw_base, **{
                "🎨 生成类型": "🎨 图像编辑/重绘 (Edits)",
                "📝 外接提示词": item["prompt"],
                "🖼️ 参考素材": h3,
            })
            imgs, _report, _seed = get_api().dispatch_generate(**kw)
        else:
            state.log(f"{item['name']} 未引用任何资产，按文生图生成")
            _emit(state.session_id, "log", line=state.data["logs"][-1])
            kw = dict(kw_base, **{
                "🎨 生成类型": "✨ 文生图 (Generations)",
                "📝 外接提示词": item["prompt"],
            })
            imgs, _report, _seed = get_api().dispatch_generate(**kw)
        fname = _save_tensor(imgs[0], out_dir, item["name"])
        new_status = "locked" if was_locked else "ok"
        state.set_item(kind, item["id"], status=new_status,
                       file=fname, subfolder=subfolder, error="", seed=_seed)
        state.log(f"{item['name']} 完成 → {fname}")
        ok = True
    except Exception as e:
        msg = str(e)
        state.set_item(kind, item["id"], status="failed", error=msg)
        state.log(f"{item['name']} 失败：{msg[:120]}")
        ok = False

    _emit(state.session_id, "item", kind=kind,
          item=_brief(state.get(kind, item["id"])))
    _emit(state.session_id, "log", line=state.data["logs"][-1])
    return ok


def _set_stage(state, stage):
    state.data["stage"] = stage
    state.save()
    _emit(state.session_id, "stage", stage=stage)


def _all_ready(items):
    return all(i["status"] in ("ok", "locked") for i in items)


def run_pending(state, params, out_dir, asset_engine=None, frame_engine=None):
    import comfy.model_management

    _ensure_inside_output(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    # 云 API 节点按需实例化（两个阶段都走本地时完全不创建）
    _api_node = None

    def get_api():
        nonlocal _api_node
        if _api_node is None:
            from banzhang_image_api import UnifiedBanana2Node
            _api_node = UnifiedBanana2Node()
        return _api_node

    kw = base_kwargs(params)
    sub = params["subfolder"]

    # 断点续跑：本地引擎种子从已用最大值之后继续，避免与旧图撞种子
    used_seeds = [int(i.get("seed") or 0)
                  for i in state.data["assets"] + state.data["kfs"]
                  if i.get("seed") is not None] + [int(params.get("seed") or 0)]
    for eng in (asset_engine, frame_engine):
        if eng is not None and hasattr(eng, "advance_to"):
            eng.advance_to(max(used_seeds))

    def stop_requested():
        return getattr(comfy.model_management, "current_interrupted", False)

    def abort():
        state.log("🛑 检测到停止请求，中止剩余任务（未完成项保留，可继续）")
        state.save()
        _emit(state.session_id, "log", line=state.data["logs"][-1])
        _emit(state.session_id, "done")

    _set_stage(state, "asset")
    for item in state.pending("asset"):
        if stop_requested():
            abort()
            return
        run_one(state, get_api, kw, "asset", item, out_dir, sub,
                asset_engine=asset_engine, frame_engine=frame_engine)

    if not _all_ready(state.data["assets"]):
        n = len([a for a in state.data["assets"]
                 if a["status"] not in ("ok", "locked")])
        state.log(f"资产还有 {n} 项未完成，核心帧暂不开始")
        _emit(state.session_id, "log", line=state.data["logs"][-1])
        state.save()
        _emit(state.session_id, "done")
        return

    _set_stage(state, "kf")
    for item in state.pending("kf"):
        if stop_requested():
            abort()
            return
        run_one(state, get_api, kw, "kf", item, out_dir, sub,
                asset_engine=asset_engine, frame_engine=frame_engine)

    _set_stage(state, "done" if _all_ready(state.data["kfs"]) else "kf")
    _emit(state.session_id, "done")


def rerun_one(state, params, kind, item_id, out_dir):
    item = state.get(kind, item_id)
    if not item:
        return
    from banzhang_image_api import UnifiedBanana2Node
    _ensure_inside_output(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    api_node = UnifiedBanana2Node()
    # 重生换新种子（原种子 +1），避开与旧图撞种子；increment 模式从新值继续递增
    p = dict(params)
    if item.get("seed") is not None:
        p["seed"] = int(item["seed"]) + 1
    # 注意：本地引擎模式的单张重生走 sp_mark_rerun + 重新执行整个节点，
    # 因为 HTTP 路由拿不到连线上的引擎对象；此函数只服务云 API 模式。
    run_one(state, lambda: api_node, base_kwargs(p), kind, item,
            out_dir, p.get("subfolder") or _subfolder(out_dir))
    # 重跑后重新评估阶段
    if kind == "asset" and _all_ready(state.data["assets"]):
        if state.data["stage"] == "asset":
            _set_stage(state, "kf")
    elif kind == "kf" and _all_ready(state.data["kfs"]):
        _set_stage(state, "done")
    _emit(state.session_id, "done")
