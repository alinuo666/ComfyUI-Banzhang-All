# -*- coding: utf-8 -*-
"""工程库体检 / 修复 —— 专治「时间轴凭空多出几段」。

背景（20261025）：旧的 scheduleSelfHeal 会把「film_summary 这一轮没画出来的段」
当成「档案里已经没有了」，先清空 shot.clip 再调 registerShot，于是同一段在档案里
被登记出第二个 cid。时间轴按档案画块 → 6 段变 10 段，刷新也不回去。

这个工具做两件事：
    python project_db_doctor.py <工程名>            # 只体检，一个字节都不写
    python project_db_doctor.py <工程名> --apply     # 修（先自动备份整库）

判据（只摘「确定是重复登记的空壳」，绝不碰真身）：
    段 A 的 shot_uid，被段 B 的 state.chain.shot 声明，且 B 自己有 shot_state 行
    → B 才是这段的真身，A 是重复登记出来的空壳。
    两个都有 state 时，created_at 早的是真身。

为什么不会误伤正常段：
    · 真身 B 一定有自己的 shot_state（跑过、存过内容）
    · 正常段的 uid 只被它自己声明，找不到"另一个段"来抢
    · 无法判定的（uid 为空、两边都没 state）一律只报告，不动手

修完之后前端第一次刷新会自动对账：工程里那些 clip 已不存在的段会被摘掉
（csglide_cast_monitor.js 的 reconcileShotsWithOrder），不会反向重建。
"""
import argparse
import datetime as _dt
import json
import os
import shutil
import sqlite3
import sys

CHAIN_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "..", "..", "output", "h3_chain")
# 相对路径不成立就直接报错，不再退回作者本机目录。
if not os.path.isdir(CHAIN_ROOT):
    raise SystemExit("找不到工程库：请设置环境变量 BANZHANG_CHAIN_ROOT 指向 output/h3_chain")

CHILD_TABLES = ("shots", "shot_state", "rack_slots", "rack_refs",
                "shot_versions", "run_receipts", "segment_bindings", "files")


def _ts(t):
    try:
        return _dt.datetime.fromtimestamp(float(t)).strftime("%m-%d %H:%M:%S")
    except Exception:
        return str(t)


def _load_state(conn, cid):
    row = conn.execute("SELECT state_json FROM shot_state WHERE cid=?", (cid,)).fetchone()
    if not row:
        return None, None
    try:
        return json.loads(row[0]), row[0]
    except Exception:
        return None, row[0]


def inspect(conn):
    """返回一份完整体检结果 + 待摘名单。

    「谁是谁」有两个声明处，两处都要看：
      · shots.shot_uid          —— 登记表说这个 cid 的 uid 是 X
      · shot_state.chain.shot   —— 段内容自己说「我是 X」
    20261025 那次事故里，空壳 clip_0007 的 uid(1myflik) 只出现在
    **clip_0003 的 state.chain.shot** 里 —— 只查 shots 表就看不见它。
    """
    shots = {}
    for r in conn.execute(
            "SELECT cid, ord, shot_uid, created_at FROM shots ORDER BY ord, created_at"):
        shots[r["cid"]] = {"ord": r["ord"], "uid": str(r["shot_uid"] or ""),
                           "created": r["created_at"] or 0}
    order = []
    row = conn.execute("SELECT value FROM meta WHERE key='order'").fetchone()
    if row:
        try:
            order = [str(c) for c in (json.loads(row[0]) or [])]
        except Exception:
            order = []
    has_state = {r[0] for r in conn.execute("SELECT cid FROM shot_state")}

    claimants = {}

    def claim(uid, cid):
        if not uid:
            return
        lst = claimants.setdefault(uid, [])
        if cid not in lst:
            lst.append(cid)

    for cid, info in shots.items():
        claim(info["uid"], cid)
    for cid in has_state:
        st, _raw = _load_state(conn, cid)
        claim(str(((st or {}).get("chain") or {}).get("shot") or ""), cid)

    orphans, unsure = [], []
    for cid, info in shots.items():
        uid = info["uid"]
        if not uid:
            unsure.append((cid, "shot_uid 为空，无法判定"))
            continue
        # 有 state 的段永远不当空壳：它跑过、存过内容，是某一段的真身
        if cid in has_state:
            continue
        others = [c for c in claimants.get(uid, []) if c != cid and c in has_state]
        if others:
            real = min(others, key=lambda c: shots[c]["created"])
            orphans.append((cid, real, uid))
        else:
            unsure.append((cid, "没有 state，也没有别的段声明这个 uid"))
    return {"shots": shots, "order": order, "has_state": has_state,
            "orphans": orphans, "unsure": unsure}


def report(name, info):
    print(f"工程：{name}")
    print(f"  shots 表 {len(info['shots'])} 行 · shot_state {len(info['has_state'])} 行"
          f" · meta.order {len(info['order'])} 个")
    print()
    print("  cid          ord  创建          state   uid")
    for cid in sorted(info["shots"], key=lambda c: info["shots"][c]["ord"]):
        s = info["shots"][cid]
        print(f"  {cid:<12} {s['ord']:>3}  {_ts(s['created']):<12}  "
              f"{'有' if cid in info['has_state'] else '无':<5}  {s['uid']}")
    print()
    if info["orphans"]:
        print(f"  ⚠ 重复登记的空壳 {len(info['orphans'])} 个（真身 → 空壳）：")
        for cid, own, uid in info["orphans"]:
            print(f"      {own}  ←  {cid}   (uid {uid})")
    else:
        print("  ✓ 没有重复登记的空壳")
    if info["unsure"]:
        print(f"  ? 无法判定 {len(info['unsure'])} 个（只报告，不动手）：")
        for cid, why in info["unsure"]:
            print(f"      {cid}: {why}")
    if not info["orphans"] and not info["unsure"] and len(info["order"]) == len(info["shots"]):
        print("  ✓ 三处段数一致，库是干净的")


def apply(name, db, info):
    orphans = info["orphans"]
    if not orphans:
        print("\n没有需要修的东西。")
        return 0
    # 备份
    bak_dir = os.path.join(os.path.dirname(db),
                           "_dbbackup_" + _dt.datetime.now().strftime("%Y%m%d_%H%M%S"))
    os.makedirs(bak_dir, exist_ok=True)
    bak = os.path.join(bak_dir, "project.db")
    src = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    dst = sqlite3.connect(bak)
    src.backup(dst)
    dst.close()
    src.close()
    print(f"\n已备份 → {bak}")

    drop = {cid for cid, _own, _uid in orphans}
    # order 里的空壳换成真身（保持原位置），再按真身去重
    fix = {cid: own for cid, own, _uid in orphans}
    new_order = []
    for c in info["order"]:
        c2 = fix.get(c, c)
        if c2 not in new_order:
            new_order.append(c2)
    # order 里没提到的真身补到末尾
    for c in sorted(info["shots"], key=lambda x: info["shots"][x]["ord"]):
        if c not in drop and c not in new_order:
            new_order.append(c)

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=8000")
    try:
        conn.execute("BEGIN IMMEDIATE")
        for t in CHILD_TABLES:
            for cid in drop:
                conn.execute(f"DELETE FROM {t} WHERE cid=?", (cid,))
        # 重排 ord（ord 只是排序缓存，权威是 meta.order）
        for i, cid in enumerate(new_order):
            conn.execute("UPDATE shots SET ord=? WHERE cid=?", (i, cid))
        # state 里被污染的 chain.shot 还原成 shots 表的正确 uid
        for cid in new_order:
            st, _raw = _load_state(conn, cid)
            uid = info["shots"].get(cid, {}).get("uid") or ""
            if not st or not uid:
                continue
            ch = st.get("chain")
            if isinstance(ch, dict) and str(ch.get("shot") or "") != uid:
                old = ch.get("shot")
                ch["shot"] = uid
                conn.execute("UPDATE shot_state SET state_json=?, updated_at=? WHERE cid=?",
                             (json.dumps(st, ensure_ascii=False), _now(), cid))
                print(f"  {cid}: chain.shot {old} → {uid}")
        # order / current 落库
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('order',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(new_order, ensure_ascii=False),))
        cur = conn.execute("SELECT value FROM meta WHERE key='current'").fetchone()
        cur_cid = None
        if cur:
            try:
                cur_cid = json.loads(cur[0])
            except Exception:
                cur_cid = None
        if isinstance(cur_cid, str) and cur_cid in drop:
            cur_cid = fix.get(cur_cid) or (new_order[-1] if new_order else None)
            conn.execute(
                "INSERT INTO meta(key,value) VALUES('current',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (json.dumps(cur_cid, ensure_ascii=False),))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"\n✓ 已摘掉 {len(drop)} 个空壳：{'、'.join(sorted(drop))}")
    print(f"✓ 新顺序（{len(new_order)} 段）：{'、'.join(new_order)}")
    # 顺手把 v3 的唯一索引建上（重启时 _migrate_v3 也会做，先建先受益）
    try:
        c2 = sqlite3.connect(db)
        c2.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_shots_uid "
                   "ON shots(shot_uid) WHERE shot_uid <> ''")
        c2.commit()
        c2.close()
        print("✓ shot_uid 唯一索引已建立")
    except Exception as e:
        print("⚠ 唯一索引没建成（历史数据里仍有重复 uid，先清完再重启）：", e)
    return 0


def _now():
    import time
    return time.time()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="工程库体检 / 修复（默认只查不写）")
    ap.add_argument("name", help="工程名，例如：未命名工程 13")
    ap.add_argument("--apply", action="store_true", help="执行修复（会先自动备份整库）")
    ap.add_argument("--root", default=CHAIN_ROOT, help="h3_chain 根目录")
    args = ap.parse_args()

    db = os.path.join(args.root, args.name, "project.db")
    if not os.path.isfile(db):
        print(f"找不到库：{db}")
        return 2
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    info = inspect(conn)
    conn.close()
    report(args.name, info)
    if not args.apply:
        if info["orphans"]:
            print("\n（只读体检。要修就加 --apply）")
        return 0
    return apply(args.name, db, info)


if __name__ == "__main__":
    sys.exit(main())
