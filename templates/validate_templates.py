# -*- coding: utf-8 -*-
"""H3 制片中枢模板静态校验：节点存在性 / 连线口存在性 / 类型兼容性 / required 完整性。

在 ComfyUI 便携 python 下运行：
  python_embeded\\python.exe templates\\validate_templates.py
"""
import json
import os
import sys

COMFY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (COMFY_ROOT, PKG_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

import importlib  # noqa: E402
import types  # noqa: E402
import importlib.util  # noqa: E402
import nodes as core_nodes  # noqa: E402

REG = {}
REG.update(core_nodes.NODE_CLASS_MAPPINGS)

# comfy_extras 新版为异步初始化（VAEDecodeAudio / RepeatLatentBatch 等）
import asyncio  # noqa: E402
for _fn in ("init_builtin_extra_nodes", "init_extra_nodes"):
    if hasattr(core_nodes, _fn):
        try:
            _r = getattr(core_nodes, _fn)()
            if asyncio.iscoroutine(_r):
                asyncio.run(_r)
            break
        except Exception as _e:
            print("⚠ %s 失败: %s" % (_fn, _e))

# 目录名含连字符，无法正常 import；用 spec 按包加载 __init__（包内相对导入才生效）
_spec = importlib.util.spec_from_file_location(
    "banzhang_pkg", os.path.join(PKG_ROOT, "__init__.py"),
    submodule_search_locations=[PKG_ROOT])
_full = importlib.util.module_from_spec(_spec)
sys.modules["banzhang_pkg"] = _full
try:
    _spec.loader.exec_module(_full)
    REG.update(getattr(_full, "NODE_CLASS_MAPPINGS", {}))
    print("✓ 节点包整体加载，注册节点 %d 个" %
          len(getattr(_full, "NODE_CLASS_MAPPINGS", {})))
except Exception as e:
    print("⚠ 节点包整体加载失败: %s" % e)

# ---- 独立脚本环境 stub（PromptServer 未初始化导致部分模块加载失败；
#      类型口径照节点源码，仅用于静态连线校验）----
def _stub(name, inputs, ret):
    if name in REG:
        return
    REG[name] = type("Stub_" + name, (), {
        "INPUT_TYPES": classmethod(lambda cls, i=inputs: i),
        "RETURN_TYPES": ret,
        "OUTPUT_NODE": name == "banzhangVideoCombine",
    })

_stub("VAEDecodeAudio",
      {"required": {"samples": ("LATENT",), "vae": ("*",)}}, ("AUDIO",))
_stub("ModelAttentionBackend",
      {"required": {"attention": ("STRING",), "model": ("MODEL",)}},
      ("MODEL",))
_stub("MiniMaxH3SigmaShift",
      {"required": {"shift_video": ("FLOAT",), "shift_audio": ("FLOAT",),
                    "model": ("MODEL",)}}, ("MODEL",))
_stub("BanzhangVisualLoader", {"required": {}}, ())
_stub("banzhangVideoCombine", {
    "required": {
        "⏱️ 帧率": ("FLOAT",), "📼 视频格式": ("STRING",),
        "🏷️ 文件前缀": ("STRING",), "💾 保存元数据": ("BOOLEAN",),
        "🔀 输出模式": ("STRING",)},
    "optional": {
        "🖼️ 图像": ("IMAGE",), "🎬 视频文件": ("VIDEO",),
        "🎵 音频": ("AUDIO",), "📂 自定义保存路径": ("STRING",)}},
      ("IMAGE", "VIDEO", "AUDIO"))


def type_ok(src_type, dst_type):
    if not dst_type or dst_type == "*":
        return True
    if src_type == "*":
        return True
    if not src_type:
        return False
    return str(src_type) == str(dst_type)


def validate(path):
    errs = []
    with open(path, "r", encoding="utf-8") as f:
        graph = json.load(f)
    # 1) 节点存在
    for nid, n in graph.items():
        ct = n.get("class_type")
        if ct not in REG:
            errs.append("[%s] 未知 class_type: %s" % (nid, ct))
    if errs:
        return errs, [], []

    for nid, n in graph.items():
        cls = REG[n["class_type"]]
        it = cls.INPUT_TYPES()
        req = it.get("required", {}) or {}
        opt = it.get("optional", {}) or {}
        all_in = {}
        all_in.update(req)
        all_in.update(opt)
        inputs = n.get("inputs", {})

        # 2) required 完整（forceInput 必须连线；普通 widget 必须有值）
        for k, spec in req.items():
            if k not in inputs:
                errs.append("[%s %s] 缺少 required 输入: %s" % (nid, n["class_type"], k))
                continue
            v = inputs[k]
            force = isinstance(spec, tuple) and len(spec) > 1 and \
                isinstance(spec[1], dict) and spec[1].get("forceInput")
            if isinstance(v, list):
                pass  # 连线，后面统一查
            elif force:
                errs.append("[%s %s] %s 是 forceInput，必须连线" % (nid, n["class_type"], k))
            else:
                kind = spec[0]
                if kind in ("STRING", "INT", "FLOAT", "BOOLEAN") and v is None:
                    errs.append("[%s %s] %s widget 值为空" % (nid, n["class_type"], k))

        # 3) 未知输入键（仅警告级别；自定义节点可能透传额外键，这里不报）
        # 4) 连线校验
        for k, v in list(inputs.items()):
            if not isinstance(v, list) or len(v) != 2:
                continue
            src_id, src_slot = str(v[0]), int(v[1])
            if src_id not in graph:
                errs.append("[%s].%s -> 源节点 [%s] 不存在" % (nid, k, src_id))
                continue
            src_cls = REG[graph[src_id]["class_type"]]
            rtypes = getattr(src_cls, "RETURN_TYPES", ()) or ()
            if src_slot >= len(rtypes):
                errs.append("[%s].%s -> [%s] 口%d 超出输出口数 %d" %
                            (nid, k, src_id, src_slot, len(rtypes)))
                continue
            if k not in all_in:
                errs.append("[%s %s] 没有名为 %s 的输入口" % (nid, n["class_type"], k))
                continue
            dst_type = all_in[k][0]
            src_type = rtypes[src_slot]
            if not type_ok(src_type, dst_type):
                errs.append("[%s].%s(%s) <- [%s].%d(%s) 类型不通" %
                            (nid, k, dst_type, src_id, src_slot, src_type))

    # 5) OUTPUT 祖先链：每个 OUTPUT_NODE 的依赖闭包（信息项）
    def anc(x, acc):
        for v in graph[x].get("inputs", {}).values():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) in graph:
                if str(v[0]) not in acc:
                    acc.add(str(v[0]))
                    anc(str(v[0]), acc)
        return acc
    outs = [nid for nid, n in graph.items()
            if getattr(REG[n["class_type"]], "OUTPUT_NODE", False)]
    reach = set()
    for o in outs:
        reach |= anc(o, set())
    dead = [nid for nid in graph if nid not in outs and nid not in reach]
    return errs, outs, sorted(dead, key=str)


def main():
    tdir = os.path.dirname(os.path.abspath(__file__))
    bad = 0
    for fn in ("producer_asset_qwen.json", "producer_asset_qwen_lite.json",
               "producer_video_h3.json", "producer_master.json"):
        res = validate(os.path.join(tdir, fn))
        errs = res[0]
        print("=" * 70)
        print(fn)
        if errs:
            bad += 1
            for e in errs:
                print("  ✗", e)
        else:
            print("  ✓ 节点/连线/类型/required 全部通过")
            outs, dead = res[1], res[2]
            print("  OUTPUT 节点：%s" % outs)
            if dead:
                print("  ℹ 不在输出祖先链（不会执行，保留无害）：%s" % dead)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
