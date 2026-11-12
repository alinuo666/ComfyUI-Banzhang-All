# -*- coding: utf-8 -*-
"""SQLite 统一状态库（csglide_store）自测 —— 不调 GPU / 不起 HTTP 服务。

覆盖：
  1. 后端定型：新工程首次写自动建库、不产生 JSON；预置 chain.json 的老工程永不建库
  2. 段 CRUD / state 大 JSON round-trip / film_summary 读模型在 DB 工程上正常
  3. rack 段槽位、desk 整包、project 全量
  4. events seq 单调 + 20 线程并发读-改-写不丢字段
  5. snapshots 还原点增查删
  6. rename 搬目录后库随目录走、数据完整
  7. health 完整性检查

运行（cwd 须为 ComfyUI 根目录）：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\store_selftest.py
"""
import json
import os
import shutil
import sys
import time
import importlib.util
import concurrent.futures

COMFY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (COMFY_ROOT, PKG_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

# 以包形态加载（csglide_chain 内部用 from . import csglide_store 相对导入）
_spec = importlib.util.spec_from_file_location(
    "banzhang_pkg", os.path.join(PKG_ROOT, "__init__.py"),
    submodule_search_locations=[PKG_ROOT])
_pkg = importlib.util.module_from_spec(_spec)
sys.modules["banzhang_pkg"] = _pkg
_spec.loader.exec_module(_pkg)
import csglide_chain as C      # noqa: E402
import csglide_store as S      # noqa: E402

PASS, FAIL = 0, 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % name)
    else:
        FAIL += 1
        print("  ✗ %s %s" % (name, extra))


TS = int(time.time())
NAME = "_selftest_db_%d" % TS
OLD = "_selftest_json_%d" % TS
NEWNAME = "_selftest_db_renamed_%d" % TS

d = C.chain_dir(NAME)
dold = C.chain_dir(OLD)
dnew = C.chain_dir(NEWNAME)


def cleanup():
    for x in (d, dold, dnew):
        try:
            S.close_db(x)
        except Exception:
            pass
    for x in (d, dold, dnew):
        shutil.rmtree(x, ignore_errors=True)


cleanup()

try:
    print("【1】后端定型（新工程建库 / 老工程留 JSON）")
    # 全新工程：第一次 add_clip 自动建库，且不产生任何 chain/clip JSON
    cid1 = C.add_clip(NAME, shot="s01", frames=360)
    C.update_clip(NAME, cid1, {"name": "第一段"})
    check("首段 id=clip_0001", cid1 == "clip_0001", cid1)
    check("新工程已建 project.db", S.has_db(d), os.listdir(d))
    check("新工程无 chain.json",
          not os.path.isfile(os.path.join(d, "chain.json")), os.listdir(d))
    check("新工程无 clip_0001.json",
          not os.path.isfile(os.path.join(d, "clip_0001.json")), os.listdir(d))

    # 老工程：手工放 chain.json，读写都不应建库
    os.makedirs(dold, exist_ok=True)
    C._write_json(os.path.join(dold, "chain.json"),
                  {"name": OLD, "fps": 24, "trim_frames": 22,
                   "prompt_global": "", "current": None,
                   "locked": False, "order": []})
    check("老工程 backend=json", S.backend(dold) == "json", S.backend(dold))
    oc = C.load_chain(OLD)
    check("老工程能读 chain.json", oc.get("name") == OLD)
    C.save_chain(OLD, dict(oc, prompt_global="老工程全局词"))
    check("老工程写后仍未建库", not S.has_db(dold))
    check("老工程 chain.json 已更新",
          C.load_chain(OLD).get("prompt_global") == "老工程全局词")

    print("【2】段 CRUD / state / film_summary")
    cid2 = C.add_clip(NAME, shot="s02", frames=379)
    C.update_clip(NAME, cid2, {"name": "第二段"})
    cid3 = C.add_clip(NAME, shot="s03", frames=379)
    C.update_clip(NAME, cid3, {"name": "第三段"})
    check("续段 id 顺序", cid2 == "clip_0002" and cid3 == "clip_0003", (cid2, cid3))
    summ = C.summary(NAME)
    check("summary 三段且顺序正确",
          [c.get("id") for c in summ["clips"]] ==
          ["clip_0001", "clip_0002", "clip_0003"], summ.get("clips") and
          [c.get("id") for c in summ["clips"]])
    check("current=最新段 clip_0003", summ.get("current") == "clip_0003",
          summ.get("current"))

    big_state = {"mode": "t2v", "width": 928, "height": 544,
                 "prompt": "词" * 200, "slots": {"images": [None] * 9},
                 "cont": {"mode": "latent", "latent_file": "auto",
                          "frames": 22, "audio": True},
                 "nested": {"a": [1, 2, {"b": "中文"}]}}
    C.update_clip(NAME, cid2, {"state": big_state})
    m2 = C.load_clip(NAME, cid2)
    check("state 大 JSON round-trip", m2.get("state") == big_state,
          "state 不一致")
    # 再写别的字段，state 必须原样保留（state 在独立小表）
    C.update_clip(NAME, cid2, {"prompt_seg": "第二段台词", "locked": True})
    m2 = C.load_clip(NAME, cid2)
    check("更新其他字段后 state 不丢", m2.get("state") == big_state)
    check("新字段已落", m2.get("prompt_seg") == "第二段台词"
          and m2.get("locked") is True,
          (m2.get("prompt_seg"), m2.get("locked")))

    fs = C.film_summary(NAME)
    check("film_summary 段数=3", len(fs["clips"]) == 3, len(fs["clips"]))
    check("film_summary current 透传", fs["current"] == cid3, fs["current"])
    check("film_summary 净长>0", fs["total_frames"] > 0, fs["total_frames"])

    C.set_current(NAME, cid1)
    check("set_current 落库", C.load_chain(NAME).get("current") == cid1)
    C.set_locked(NAME, cid2, True)
    check("set_locked 落库", C.load_clip(NAME, cid2).get("locked") is True)
    C.set_pins(NAME, cid2, [{"at": "head", "from": cid1, "frames": 22}])
    check("set_pins 落库",
          C.pins_of(NAME, cid2)[0].get("from") == cid1)
    C.set_transition(NAME, cid3, {"type": "unlink"})
    check("set_transition 落库",
          C.transitions_of(NAME).get(cid3, {}).get("type") == "unlink")
    r = C.reorder_clips(NAME, [cid1, cid3, cid2])
    check("reorder 落库", r["order"] == [cid1, cid3, cid2], r["order"])
    C.reorder_clips(NAME, [cid1, cid2, cid3])   # 复位

    rr = C.resize_clip(NAME, cid2, 200)
    check("resize 吸附并落库", rr.get("changed") and
          C.load_clip(NAME, cid2).get("frames") == rr["clip"].get("frames"),
          (rr.get("changed"), rr.get("clip", {}).get("frames")))

    print("【2b】resize 语义与广播（20261012 时长实时同步）")
    # 假 PromptServer 收 ws_broadcast（ws_broadcast 函数内现 import server，
    # 运行期注入即时生效）
    import types as _types
    _sent = []

    class _PS:
        instance = _types.SimpleNamespace(
            send_sync=lambda t, p: _sent.append((t, p)))

    _fake_server = _types.ModuleType("server")
    _fake_server.PromptServer = _PS
    sys.modules["server"] = _fake_server
    try:
        # —— 未渲染的规划段：改时长=改计划，直改帧长、不挂待办、不牵连下段 ——
        r_short = C.resize_clip(NAME, cid2, 120)
        check("规划段缩短吸附落库",
              r_short.get("changed") and r_short.get("planned") is True
              and C.load_clip(NAME, cid2)["frames"] == r_short["to"],
              (r_short.get("changed"), r_short.get("planned"), r_short.get("to")))
        check("规划段缩短不挂 trim/redo",
              r_short.get("pending") not in ("trim", "grow")
              and r_short.get("next_pending") is None,
              (r_short.get("pending"), r_short.get("next_pending")))
        # 未渲染段（film=None，无 latent 也无成片）加长：必须放行，不能误判
        # 成"无原稿的外部导入段"
        r_grow = C.resize_clip(NAME, cid2, 300)
        check("规划段加长不被拒且不挂 grow",
              r_grow.get("refused") != "no_latent" and r_grow.get("changed") is True
              and r_grow.get("planned") is True
              and r_grow.get("pending") not in ("grow", "trim"),
              (r_grow.get("refused"), r_grow.get("changed"), r_grow.get("pending")))
        check("resize 后广播 clip_resized 且带 clip",
              any(p.get("type") == "clip_resized" and p.get("clip") == cid2
                  for _, p in _sent), str(_sent))
        check("resize 动作在 events 流水",
              any(e.get("action") == "resize" for e in S.list_events(d, limit=500)))
        _n_before = len(_sent)
        cur_frames = C.load_clip(NAME, cid2)["frames"]
        r_same = C.resize_clip(NAME, cid2, cur_frames)
        check("相同帧长 changed=False 且不广播",
              r_same.get("changed") is False and len(_sent) == _n_before,
              (r_same.get("changed"), len(_sent), _n_before))

        # —— 已出片但 latent 不在磁盘（模拟没接存档节点/外部导入）：语义回退到
        # 既有规则：缩短=trim 且下一段 redo；加长拒绝 no_latent ——
        C.update_clip(NAME, cid2, {"film": "fake_film.mp4", "film_frames": cur_frames})
        r_trim = C.resize_clip(NAME, cid2, 120)
        check("已出片段缩短 pending=trim",
              r_trim.get("changed") and r_trim.get("pending") == "trim",
              (r_trim.get("changed"), r_trim.get("pending")))
        check("已出片段缩短后下一段标 redo",
              r_trim.get("next") == cid3 and r_trim.get("next_pending") == "redo",
              (r_trim.get("next"), r_trim.get("next_pending")))
        r_refuse = C.resize_clip(NAME, cid2, 700)
        check("无 latent 加长拒绝 no_latent 且帧长不变",
              r_refuse.get("refused") == "no_latent"
              and r_refuse.get("to") == r_trim.get("to")
              and C.load_clip(NAME, cid2)["frames"] == r_trim.get("to"),
              (r_refuse.get("refused"), r_refuse.get("to")))
    finally:
        del sys.modules["server"]

    print("【3】rack 段槽位 / desk / project 全量")
    S.save_rack(d, cid1, {"slots": {
        "images": [{"file": "0039.png", "alias": ["首图"]}, None,
                   {"file": "ref2.jpg", "crop": [0, 1, 2, 3]}],
        "videos": [], "audios": []}, "fps": 24, "audio_out": 1})
    S.save_rack(d, cid2, {"slots": {
        "images": [{"file": "美女.jpeg"}], "videos": [{"file": "v1.mp4"}],
        "audios": []}})
    rk1 = S.load_rack(d, cid1)
    check("段1 rack 三槽（空槽保留）",
          len(rk1["slots"]["images"]) == 3
          and rk1["slots"]["images"][0]["file"] == "0039.png"
          and rk1["slots"]["images"][1] is None
          and rk1["slots"]["images"][2]["file"] == "ref2.jpg",
          rk1["slots"])
    check("段1 rack 槽位参数保留",
          rk1["slots"]["images"][2].get("crop") == [0, 1, 2, 3])
    rk2 = S.load_rack(d, cid2)
    check("段2 rack 独立不串段",
          rk2["slots"]["images"][0]["file"] == "美女.jpeg"
          and rk2["slots"]["videos"][0]["file"] == "v1.mp4", rk2["slots"])
    check("片级 fps/audio_out", rk1["fps"] == 24 and rk1["audio_out"] == 1,
          (rk1["fps"], rk1["audio_out"]))

    desk = {"chain": {"name": NAME}, "global": "全局台词",
            "segs": {cid1: "第一段词", cid2: "第二段词", cid3: "第三段词"},
            "alias": {"a": "b"}, "presets": ["p1", "p2"]}
    S.save_desk(d, desk)
    check("desk round-trip", S.load_desk(d) == desk)

    blob = S.project_blob(d, NAME, C.summary)
    check("project backend=db", blob.get("backend") == "db")
    check("project clips=3", len(blob.get("clips") or []) == 3)
    check("project racks 两段",
          set((blob.get("racks") or {}).keys()) == {cid1, cid2},
          list((blob.get("racks") or {}).keys()))
    check("project desk 带回", (blob.get("desk") or {}).get("global") == "全局台词")

    print("【4】events 与并发")
    ev0 = S.list_events(d, limit=500)
    check("events 已有动作且 seq 单调",
          [e["seq"] for e in ev0] == sorted(e["seq"] for e in ev0)
          and len(ev0) >= 5, len(ev0))
    acts = {e["action"] for e in ev0}
    check("关键动作都在流水里",
          {"clip_add", "current", "reorder", "pins", "transition"} <= acts, acts)

    # 20 线程并发读-改-写：必须走 @chainlocked 原子的 update_clip（load+save
    # 拆开会破坏临界区）。每线程写一个独有键，最终一个都不许丢。
    def _writer(i):
        C.update_clip(NAME, cid3, {"并发键_%02d" % i: "v%d" % i})
        return i

    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
        list(ex.map(_writer, range(20)))
    m3 = C.load_clip(NAME, cid3)
    missing = [i for i in range(20) if m3.get("并发键_%02d" % i) != "v%d" % i]
    check("20 线程并发写零丢失", not missing, "缺失 %s" % missing[:5])

    print("【5】snapshots 还原点")
    sid = S.add_snapshot(d, "自测还原点", [{"id": cid1}], desk,
                         cur_cid=cid1, idx=0, source="manual")
    snaps = S.list_snapshots(d)
    check("snapshot 已存", any(s["id"] == sid for s in snaps))
    got = S.get_snapshot(d, sid)
    check("snapshot 内容可读", got and got["label"] == "自测还原点"
          and got["shots"][0]["id"] == cid1 and got["desk"] == desk)
    check("snapshot 可删", S.delete_snapshot(d, sid)
          and all(s["id"] != sid for s in S.list_snapshots(d)))

    print("【6】rename 搬目录")
    rr2 = C.rename_chain(NAME, NEWNAME)
    check("rename 成功", rr2.get("renamed"), rr2)
    check("旧目录已移走", not os.path.isdir(d))
    check("新目录有 db", S.has_db(dnew), os.listdir(dnew) if os.path.isdir(dnew) else "无目录")
    summ2 = C.summary(NEWNAME)
    check("改名后三段都在",
          [c.get("id") for c in summ2["clips"]] ==
          ["clip_0001", "clip_0002", "clip_0003"],
          [c.get("id") for c in summ2["clips"]])
    check("改名后 rack 还在",
          (S.load_rack(dnew, cid1) or {}).get("slots", {}).get("images", [{}])[0]
          and S.load_rack(dnew, cid1)["slots"]["images"][0]["file"] == "0039.png")
    check("改名后 desk 还在",
          (S.load_desk(dnew) or {}).get("global") == "全局台词")

    print("【7】health")
    h = S.health(dnew)
    check("integrity_check ok", h["ok"], h.get("errors"))
    check("health 段数=3", h["shots"] == 3, h)

    print("【8】删段级联")
    # cid2 无成片，force 可删
    rm = C.remove_clip(NEWNAME, cid2, force=True)
    check("remove_clip 成功", rm.get("removed"), rm)
    check("DB 段行已删", C.load_clip(NEWNAME, cid2) is None)
    check("rack 随段级联删除", S.load_rack(dnew, cid2) is None)
    check("order 已摘除",
          cid2 not in C.load_chain(NEWNAME).get("order"))

finally:
    cleanup()
    # 清掉老工程测试目录
    shutil.rmtree(dold, ignore_errors=True)

print("=" * 60)
print("PASS=%d FAIL=%d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
