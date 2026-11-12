# -*- coding: utf-8 -*-
"""H3 制片中枢逻辑自测（不调用任何外部 API / GPU）：
帧账、Schema 规范化、拓扑、N2a→N2b 磁盘闭环、N3 模板渲染。
运行：python_embeded\\python.exe templates\\producer_selftest.py
"""
import json
import os
import shutil
import sys
import importlib.util

COMFY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (COMFY_ROOT, PKG_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

import torch  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "banzhang_pkg", os.path.join(PKG_ROOT, "__init__.py"),
    submodule_search_locations=[PKG_ROOT])
_pkg = importlib.util.module_from_spec(_spec)
sys.modules["banzhang_pkg"] = _pkg
_spec.loader.exec_module(_pkg)
import banzhang_producer as P  # noqa: E402

PASS, FAIL = 0, 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % name)
    else:
        FAIL += 1
        print("  ✗ %s %s" % (name, extra))


print("【1】帧账与 h3_data")
pkg0 = {"meta": {"片名": "x", "width": 928, "height": 544, "ratio": "16:9"},
        "global": "全局状态锁", "render": {}}
seg1 = {"prompt_seg": "第一段", "seg_refs": ["a1"]}
h1 = P.build_h3_data(pkg0, seg1, 1)
check("首段 length=360", h1["length"] == 360, h1["length"])
check("首段 cont 无 latent_file",
      h1["cont"].get("latent_file", "") == "", h1["cont"])
check("首段 chain clip_0001/s01",
      h1["chain"]["clip"] == "clip_0001" and h1["chain"]["shot"] == "s01")
h2 = P.build_h3_data(pkg0, {"prompt_seg": "第二段"}, 2)
check("续段 length=379", h2["length"] == 379)
check("续段 cont.auto frames=22 audio",
      h2["cont"]["latent_file"] == "auto" and h2["cont"]["frames"] == 22
      and h2["cont"]["audio"] is True, h2["cont"])
check("续段 chain clip_0002/s02",
      h2["chain"]["clip"] == "clip_0002" and h2["chain"]["shot"] == "s02")
check("合订词拼接", h1["prompt"] == "全局状态锁\n第一段")

print("【2】Schema 规范化（乱序 id / 缺段 / 环 / 别名引用）")
raw = {
    "global": "G",
    "assets": [
        {"id": "b1", "alias": "主角", "role": "global", "views": [
            {"view": "侧面", "key_anchor": False, "refs_from": ["主角/主锚"],
             "pick": 2, "canvas": "928x544", "prompt": "侧面图"},
            {"view": "主锚", "key_anchor": True, "refs_from": [],
             "pick": 4, "canvas": "928x544", "prompt": "定妆"}]},
        {"id": "x9", "alias": "酒馆", "role": "scene", "seg": "clip_0001",
         "views": [{"view": "全景", "key_anchor": True,
                    "refs_from": ["主角"], "pick": 1,
                    "canvas": "928x544", "prompt": "场景"}]},
        {"id": "c3", "alias": "环A", "role": "prop", "views": [
            {"view": "主锚", "refs_from": ["环B"], "prompt": "a"},
            {"view": "v2", "refs_from": ["环A/主锚"], "prompt": "b"}]},
        {"id": "d4", "alias": "环B", "role": "prop", "views": [
            {"view": "主锚", "refs_from": ["环A/v2"], "prompt": "c"}]}],
    "segments": [
        {"cid": "clip_0001", "prompt_seg": "s1", "seg_refs": ["主角", "酒馆/全景"]},
        {"cid": "clip_0002", "prompt_seg": "s2", "seg_refs": ["主角"]}],
}
panel = {"片名": "x", "width": 928, "height": 544, "ratio": "16:9",
         "fps": 24, "seg_sec": 15, "total_sec": 45, "丰富度": "标准",
         "picker": "vl", "anchor_pick": 4, "view_pick": 1, "brief": "B",
         "nseg": 3}
prod = BanzhangAIProducer = P.BanzhangAIProducer()
npkg = prod._normalize(raw, panel)
gids = [g["id"] for g in npkg["assets"]]
check("资产 id 重排 a1..a4", gids == ["a1", "a2", "a3", "a4"], gids)
a1 = npkg["assets"][0]
a1_side = next(v for v in a1["views"] if v["view"] == "侧面")
check("每组唯一 key_anchor",
      sum(1 for v in a1["views"] if v["key_anchor"]) == 1)
check("主锚在首位且 pick=4",
      a1["views"][0]["view"] == "主锚" and a1["views"][0]["pick"] == 4,
      a1["views"])
check("refs_from 别名→id 重映射",
      a1_side["refs_from"] == ["a1/主锚"], a1_side)
a3v2 = next(v for g in npkg["assets"] if g["id"] == "a3"
            for v in g["views"] if v["view"] == "v2")
check("回边（a3/v2→a3/主锚）被断开",
      "a3/主锚" not in a3v2.get("refs_from", []), a3v2.get("refs_from"))
check("段数补齐到 3", len(npkg["segments"]) == 3)
check("seg_refs 别名重映射",
      npkg["segments"][0]["seg_refs"] == ["a1", "a2/全景"],
      npkg["segments"][0]["seg_refs"])
check("段 length 首360/续379",
      [s["length"] for s in npkg["segments"]] == [360, 379, 379])
check("seg_refs ≤9", all(len(s["seg_refs"]) <= 9 for s in npkg["segments"]))

print("【3】Kahn 拓扑")
order = P.topo_views(npkg)
idx = {k: i for i, k in enumerate(order)}
check("依赖视图排在主锚之后",
      idx[("a1", "主锚")] < idx[("a1", "侧面")], order)
check("场景排在角色主锚之后",
      idx[("a1", "主锚")] < idx[("a2", "全景")], order)
check("拓扑覆盖全部视图",
      len(order) == sum(len(g["views"]) for g in npkg["assets"]), order)

print("【4】N2a 入库 → N2b 挂图 磁盘闭环")
TEST = "__producer_selftest__"
tdir = P.project_dir(TEST)
try:
    imgs = torch.rand(3, 64, 96, 3)
    n2a = P.BanzhangProducerLibraryIn()
    assets_str, contact, refs, rep = n2a.ingest(
        TEST, "a1", "测试侠", "global", "", "主锚", True, imgs,
        "入库并选图", 选图结论=None, 手动选用编号=0)
    adb = json.loads(assets_str)
    v = adb["groups"][0]["views"][0]
    check("候选 3 张落盘", len(v["candidates"]) == 3, v)
    check("默认晋升候选1(pending)", v["chosen"] == 1 and v["status"] == "pending")
    check("正式视图文件存在", P.rel_exists(v["file"]), v["file"])
    check("联系表 batch=1", contact.shape[0] == 1)
    check("单视图 refs JSON", json.loads(refs)["slots"]["images"][0]["file"] == v["file"])

    _, _, _, rep2 = n2a.ingest(
        TEST, "a1", "测试侠", "global", "", "主锚", True, imgs,
        "仅重选（用盘上候选重新挑）", 选图结论="我选第2张，眼神更稳", 手动选用编号=0)
    adb2 = P.load_assets(TEST)
    v2 = adb2["groups"][0]["views"][0]
    check("VL 结论重选第2张", v2["chosen"] == 2 and v2["status"] == "chosen", rep2)

    n2b = P.BanzhangProducerRack()
    r1, _, rrep = n2b.emit(TEST, "视频段", "clip_0001", "", "")
    check("自动兜底挂全局主锚",
          len(json.loads(r1)["slots"]["images"]) == 1, rrep)
    r2, _, _ = n2b.emit(TEST, "生图参考", "", "测试侠/主锚", "")
    check("生图参考别名挂图",
          json.loads(r2)["slots"]["images"][0]["alias"] == ["测试侠", "主锚"])
    r3, _, _ = n2b.emit(TEST, "视频段", "clip_0001", "",
                        '["a1/不存在的视图"]')
    check("缺失引用不崩溃并给空图",
          len(json.loads(r3)["slots"]["images"]) == 0)
finally:
    shutil.rmtree(tdir, ignore_errors=True)
    print("  ℹ 临时工程目录已清理：%s" % tdir)

print("【5】N3 模板渲染")
tdir = os.path.join(PKG_ROOT, "templates")
wv = json.load(open(os.path.join(tdir, "producer_video_h3.json"), encoding="utf-8"))
wa = json.load(open(os.path.join(tdir, "producer_asset_qwen.json"), encoding="utf-8"))
g1 = P.BanzhangProducerDirector._render_video(wv, "测试片", npkg,
                                              npkg["segments"][0], 1, None)
h3_1 = json.loads(g1["31"]["inputs"]["h3_data"])
check("段1 h3 length=360", h3_1["length"] == 360)
check("段1 导演台 refs 接资产架", g1["31"]["inputs"]["refs"] == ["pr_rack", 0])
check("段1 无 prompt_text 外接", "prompt_text" not in g1["31"]["inputs"])
check("段1 Join 空源直通", g1["pr_join"]["inputs"]["source_video"] == "")
check("段1 VideoCombine 图像/音频接 Join",
      g1["156"]["inputs"].get("🖼️ 图像") == ["pr_join", 0]
      and g1["156"]["inputs"].get("🎵 音频") == ["pr_join", 2])
check("段1 N4 成片接 156 口1",
      g1["pr_adopt"]["inputs"]["成片"] == ["156", 1])
check("VAEDecode 残线已修",
      g1["8"]["inputs"]["samples"] == ["13", 0]
      and g1["9"]["inputs"]["samples"] == ["13", 0])

cm = P._load_chain_mod()
g2 = P.BanzhangProducerDirector._render_video(wv, "测试片", npkg,
                                              npkg["segments"][1], 2, cm)
h3_2 = json.loads(g2["31"]["inputs"]["h3_data"])
check("段2 h3 length=379/cont.auto",
      h3_2["length"] == 379 and h3_2["cont"]["latent_file"] == "auto")
check("段2 Join source=clip_0001.mp4",
      g2["pr_join"]["inputs"]["source_video"].replace("\\", "/").endswith(
          "h3_chain/测试片/clip_0001.mp4"),
      g2["pr_join"]["inputs"]["source_video"])
check("段2 VideoCombine 收养 Join VIDEO",
      g2["156"]["inputs"].get("🎬 视频文件") == ["pr_join", 1]
      and "🖼️ 图像" not in g2["156"]["inputs"])
check("段2 资产架引用清单已注入",
      json.loads(g2["pr_rack"]["inputs"]["引用清单"]) == ["a1"])

gv = P.BanzhangProducerDirector._render_asset(
    wa, "测试片", npkg["assets"][0],
    next(v for v in npkg["assets"][0]["views"] if v["view"] == "主锚"),
    {"key": "k", "prov": "Doubao (豆包/火山)", "url": "", "model": "m"})
qd = json.loads(gv["qwen"]["inputs"]["qwen_data"])
check("W-A qwen_data 画布/提示词",
      qd["canvas_w"] == 928 and qd["canvas_h"] == 544 and qd["prompt"] == "定妆",
      qd)
check("W-A Repeat amount=pick-1=3", gv["rep"]["inputs"]["amount"] == 3)
check("W-A N2a 身份注入（中文面板值）",
      gv["n2a_in"]["inputs"]["组编号"] == "a1"
      and gv["n2a_in"]["inputs"]["类型"] == "全局角色（每段都可能出现）"
      and gv["n2a_pick"]["inputs"]["模式"] == "仅重选（用盘上候选重新挑）")
check("W-A VL 结论接二次入库",
      gv["n2a_pick"]["inputs"]["选图结论"] == ["vl", 1])

print("【6】选图编号解析")
check("中文第X张", P.parse_pick("我选第3张", 4) == 3)
check("越界数字忽略", P.parse_pick("第9张不行，第2张好", 4) == 2)
check("无数字=0", P.parse_pick("都差不多", 4) == 0)

print("=" * 60)
print("PASS=%d FAIL=%d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
