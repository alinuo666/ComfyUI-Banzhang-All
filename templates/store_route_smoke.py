# -*- coding: utf-8 -*-
"""SQLite 状态库 /cglide/store/* HTTP 路由端到端冒烟。

store_selftest.py 只直测 DAO；本脚本用真实 aiohttp 应用挂上
csglide_store.register_routes()，把前端会打的请求原样打一遍：

  · 老工程（预置 chain.json）：GET project=backend=json，写接口一律 409
  · 新工程：project 首次拉取自动建库；rack / desk / event 落库；
    events 流水可读；snapshot 增 / 查列表 / 查单条 / 删；health 完整。

运行（cwd 须为 ComfyUI 根目录）：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\store_route_smoke.py
"""
import asyncio
import importlib.util
import json
import os
import shutil
import sys
import time
import types

COMFY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (COMFY_ROOT, PKG_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

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
NAME = "_routesmoke_db_%d" % TS
OLD = "_routesmoke_json_%d" % TS
d = C.chain_dir(NAME)
dold = C.chain_dir(OLD)


def cleanup():
    for x in (d, dold):
        shutil.rmtree(x, ignore_errors=True)


async def main():
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    # ---- 假 server.PromptServer（register_routes 装饰到这张路由表）----
    routes = web.RouteTableDef()
    sent = []      # 记录 ws_broadcast → send_sync 的广播
    fake_server = types.ModuleType("server")

    class PromptServer:
        instance = types.SimpleNamespace(
            routes=routes,
            send_sync=lambda t, p: sent.append((t, p)))

    fake_server.PromptServer = PromptServer
    sys.modules["server"] = fake_server
    S.register_routes()

    app = web.Application()
    app.add_routes(routes)
    client = TestClient(TestServer(app))
    await client.start_server()

    async def get(path):
        r = await client.get(path)
        txt = await r.text()
        try:
            return r.status, json.loads(txt)
        except Exception:
            return r.status, txt

    async def post(path, body):
        r = await client.post(path, json=body)
        txt = await r.text()
        try:
            return r.status, json.loads(txt)
        except Exception:
            return r.status, txt

    async def delete(path):
        r = await client.delete(path)
        return r.status, json.loads(await r.text())

    try:
        # ---- 老工程：先造 chain.json ----
        os.makedirs(dold, exist_ok=True)
        with open(os.path.join(dold, "chain.json"), "w", encoding="utf-8") as f:
            json.dump({"name": OLD, "order": [], "clips": []}, f, ensure_ascii=False)

        print("【1】老工程（JSON）只读、写接口 409")
        st, body = await get("/cglide/store/project?name=" + OLD)
        check("老工程 project backend=json", st == 200 and body.get("backend") == "json", str(body))
        st, _ = await post("/cglide/store/rack",
                           {"name": OLD, "cid": "clip_0001",
                            "slots": {"images": [{"file": "x.png"}], "videos": [], "audios": []}})
        check("老工程 rack 写入 409", st == 409, "status=%s" % st)
        st, _ = await post("/cglide/store/desk", {"name": OLD, "desk": {"global": "x"}})
        check("老工程 desk 写入 409", st == 409, "status=%s" % st)
        check("老工程始终没建库", not os.path.exists(os.path.join(dold, "project.db")))

        print("【2】新工程 project 首拉自动建库")
        st, body = await get("/cglide/store/project?name=" + NAME)
        check("新工程 project backend=db", st == 200 and body.get("backend") == "db", str(body)[:200])
        check("磁盘已建 project.db", os.path.exists(os.path.join(d, "project.db")))

        # 先走 chain 通道建段（与前端真实顺序一致：登记段 → 落架况）
        cid = C.add_clip(NAME)
        check("chain 建段 " + str(cid), bool(cid))

        print("【3】rack / desk / event 落库")
        rack = {"slots": {"images": [{"file": "a.png", "alias": "女主"},
                                     {"file": "b.png"}],
                          "videos": [{"file": "v.mp4"}], "audios": []},
                "fps": 24, "audio_out": 1}
        st, body = await post("/cglide/store/rack", {"name": NAME, "cid": cid, **rack})
        check("rack POST ok", st == 200 and body.get("ok") is True, str(body))
        check("rack POST 后广播 rack_saved 且带 clip",
              any(p.get("type") == "rack_saved" and p.get("clip") == cid for _, p in sent),
              str(sent[-3:]))
        st, body = await post("/cglide/store/desk",
                              {"name": NAME, "desk": {"global": "全片基调",
                                                      "segs": {cid: "本段发生的事"},
                                                      "alias": True, "presets": []}})
        check("desk POST ok", st == 200 and body.get("ok") is True, str(body))
        st, body = await post("/cglide/store/event",
                              {"name": NAME, "action": "front_test", "cid": cid,
                               "payload": {"k": 1}, "actor": "smoke"})
        check("event POST ok 且带回 seq", st == 200 and isinstance(body.get("seq"), int), str(body))

        print("【4】project 全量读回")
        st, body = await get("/cglide/store/project?name=" + NAME)
        check("project clips 含 1 段", st == 200 and len(body.get("clips") or []) == 1, str(body)[:200])
        rk = (body.get("racks") or {}).get(cid)
        check("project racks 带回该段且两图一视频",
              rk and len(rk["slots"]["images"]) == 2 and len(rk["slots"]["videos"]) == 1
              and rk.get("fps") == 24 and rk.get("audio_out") == 1, str(rk)[:200])
        check("project desk 带回", bool((body.get("desk") or {}).get("global")), str(body.get("desk"))[:120])
        check("project current 透传", body.get("current") == cid, str(body.get("current")))

        print("【5】events 流水")
        st, body = await get("/cglide/store/events?name=" + NAME + "&limit=50")
        acts = [e.get("action") for e in body.get("events") or []]
        check("events 含 rack_save/desk_save/front_test",
              "rack_save" in acts and "desk_save" in acts and "front_test" in acts, str(acts))
        seqs = [e.get("seq") for e in body.get("events") or []]
        check("events seq 时间正序单调", all(seqs[i] < seqs[i + 1] for i in range(len(seqs) - 1)), str(seqs))

        print("【6】snapshots 增查删")
        shots = C.summary(NAME).get("clips") or []
        st, body = await post("/cglide/store/snapshot",
                              {"name": NAME, "label": "冒烟还原点", "shots": shots,
                               "desk": {"global": "x"}, "cur_cid": cid, "idx": 0,
                               "source": "smoke"})
        sid = body.get("id") if isinstance(body, dict) else None
        check("snapshot 建成功带回 id", st == 200 and bool(sid), str(body))
        st, body = await get("/cglide/store/snapshots?name=" + NAME)
        check("snapshots 列表有 1 条", st == 200 and len(body.get("snapshots") or []) == 1, str(body)[:200])
        st, body = await get("/cglide/store/snapshot?name=%s&id=%s" % (NAME, sid))
        check("单条 snapshot 可读且 label 对", st == 200 and body.get("label") == "冒烟还原点", str(body)[:160])
        st, body = await delete("/cglide/store/snapshot?name=%s&id=%s" % (NAME, sid))
        check("snapshot 删除 ok", st == 200 and body.get("ok") is True, str(body))
        st, body = await get("/cglide/store/snapshots?name=" + NAME)
        check("删后列表为空", st == 200 and len(body.get("snapshots") or []) == 0, str(body)[:160])

        print("【7】health")
        st, body = await get("/cglide/store/health?name=" + NAME)
        check("health ok 且无 errors",
              st == 200 and body.get("ok") is True and not body.get("errors"),
              str(body)[:200])

        # rack 覆盖写（模拟用户改图后第二次防抖落库）：整段替换不残留旧槽
        rack2 = {"slots": {"images": [{"file": "c.png"}], "videos": [], "audios": []},
                 "fps": 0, "audio_out": 0}
        st, _ = await post("/cglide/store/rack", {"name": NAME, "cid": cid, **rack2})
        st, body = await get("/cglide/store/project?name=" + NAME)
        rk2 = (body.get("racks") or {}).get(cid)
        check("rack 覆盖写后旧槽不残留",
              st == 200 and len(rk2["slots"]["images"]) == 1 and not rk2["slots"]["videos"],
              str(rk2)[:200])

        await client.close()
    finally:
        cleanup()

    print("=" * 48)
    print("ROUTE SMOKE PASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        cleanup()
