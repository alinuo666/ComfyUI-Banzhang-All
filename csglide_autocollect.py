# -*- coding: utf-8 -*-
"""裸跑自动收片：一次执行结束，就按导演台 h3_data 认出「哪个工程的哪一段」并归档。

为什么需要它
------------
中央收片原本只挂在导演台的渲染流程上（js/csglide_cast_run.js 里 renderAll 的
其中一步）。用户直接点 ComfyUI 顶上的运行按钮时，工作流照跑、成片照落盘，但那条
前端链路根本不会被触发 —— 档案里没有这一段，时间轴上就永远是空白，看着像"白跑"。

这里把收片挪到后端「执行结束」的时刻：只要一次执行跑完，就自己按 prompt_id 认片
归档，与"这次运行是谁发起的"无关。

口径
----
· 收给谁：从服务端历史里找导演台节点（CSGlideCastCS）的 h3_data，解析出工程名
  （chain.name）与段 id（chain.clip）—— 与前端 collectRun 传的字段完全一致，
  不引入第二套认段口径。
· 什么时候不收：画布上没有导演台节点 —— 静默跳过（普通工作流一天几十次，
  不能刷屏）。认到了 H3 工作流却收片失败，一律打一行中文原因，不再静默吞掉：
  时间轴空白却查不到原因，比多一行日志贵得多。
· 重复收：导演台自己的渲染流程已经收过一次。用「同一 prompt_id 只处理一次」去重。
"""
import threading
import time

_seen = set()
_seen_lock = threading.Lock()
_SEEN_MAX = 500      # 只为去重，超限直接清空（重复收 = 覆盖同一份，无副作用）
_WAIT = 0.4          # 秒：执行结束事件发出时，服务端历史可能还没落库
_TRIES = 3


def _first_time(pid):
    """登记 prompt_id；返回 True 表示这次该处理（之前没处理过）。"""
    with _seen_lock:
        if pid in _seen:
            return False
        _seen.add(pid)
        if len(_seen) > _SEEN_MAX:
            _seen.clear()
        return True


def _target_from_history(entry):
    """从本次执行的历史里取 (工程名, 段 id)；取不到返回 ("", "")。"""
    from .csglide_chain import _history_graph
    from .nodes.csglide_cast import parse_h3_data

    graph = _history_graph(entry) or {}
    for spec in graph.values():
        if (spec or {}).get("class_type") != "CSGlideCastCS":
            continue
        raw = (spec.get("inputs") or {}).get("h3_data")
        # 外接 h3_data（接线）时这里不是字符串而是 [节点, 输出口]，本钩子不猜
        if not isinstance(raw, str) or not raw.strip():
            continue
        cfg = parse_h3_data(raw)
        ch = (cfg or {}).get("chain") or {}
        name = str(ch.get("name") or "").strip()
        cid = str(ch.get("clip") or "").strip()
        shot = str(ch.get("shot") or "").strip()
        if name and not cid and shot:
            # 提交编译主动清空 chain.clip（bz_prompt_build.js），后端只认 shot uid。
            # 不补这一步会被误判成「裸跑」而跳过整轮收片（20261107 真机日志）。
            try:
                from . import csglide_chain as _c
                from .core.csglide_ticket import resolve_clip_id
                cid = resolve_clip_id(name, "", shot, _c.film_summary)
            except Exception:
                cid = ""
        if name and cid:
            return name, cid
    return "", ""


def _collect_async(prompt_id):
    from . import csglide_chain as chain

    entry = None
    for _ in range(_TRIES):
        entry = chain._server_history_entry(prompt_id)
        if entry:
            break
        time.sleep(_WAIT)
    if not entry:
        return

    graph = chain._history_graph(entry) or {}
    has_cast = any((s or {}).get("class_type") == "CSGlideCastCS"
                   for s in graph.values())
    name, cid = _target_from_history(entry)
    if not name or not cid:
        if has_cast:
            print("[班长全家桶] ⚠ 裸跑自动收片跳过：导演台 h3_data 里没有片名或段 id"
                  "（先填工程名，并让这一段登记进档案）")
        return          # 不是 H3 工作流：一天几十次，不刷屏
    try:
        chain.collect_run(name, cid, prompt_id)
    except Exception as e:
        print("[班长全家桶] ⚠ 裸跑自动收片没成功（%s / %s）：%s" % (name, cid, e))
        return
    print("[班长全家桶] 裸跑自动收片：%s / %s 已归档（声明式）" % (name, cid))


def _install():
    """包装 send_sync，在执行结束事件上挂自动收片（只在后台线程里跑）。"""
    try:
        from server import PromptServer
    except Exception:
        return
    origin = PromptServer.send_sync
    if getattr(origin, "_bz_autocollect", False):
        return

    def _wrapper(self, event=None, data=None, sid=None):
        try:
            # node 为 None 的 executing = 整个工作流执行结束（与开发工具计时钩子同口径）
            if event == "executing" and isinstance(data, dict) \
                    and data.get("node") is None:
                pid = str(data.get("prompt_id") or "")
                if pid and _first_time(pid):
                    threading.Thread(target=_collect_async, args=(pid,),
                                     daemon=True).start()
        except Exception:
            pass
        return origin(self, event=event, data=data, sid=sid)

    _wrapper._bz_autocollect = True
    PromptServer.send_sync = _wrapper


_install()
