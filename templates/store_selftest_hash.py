# -*- coding: utf-8 -*-
"""素材池「内容哈希身份」（v5）专项自检：离线跑，不碰任何真实工程。

运行（任意目录下）：
  python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\store_selftest_hash.py

覆盖：同名不同内容不互顶 / 同内容共享 / 换图换绑 / 重名歧义 / v4 老库迁移 /
坏 v5 库（版本达标主键没切）修复 / 幂等 / 读不出文件兜底 / 显式降级与再升级 /
哈希缓存 / rack_slots 一次性迁移。
"""
import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import csglide_store as S  # noqa: E402

FAILS = []


def check(label, cond, detail=""):
    print("  %s %s" % ("✓" if cond else "✗", label)
          + ("" if cond else "  → %r" % (detail,)))
    if not cond:
        FAILS.append(label)


def put(d, name, data):
    p = os.path.join(d, name)
    with open(p, "wb") as fp:
        fp.write(data)
    return p


def sha(p):
    with open(p, "rb") as fp:
        return hashlib.sha256(fp.read()).hexdigest()


def rack(files):
    return {"slots": {"images": files, "videos": [], "audios": []}}


def raw(d):
    conn = sqlite3.connect(os.path.join(d, "project.db"))
    conn.row_factory = sqlite3.Row
    return conn


def pk_of(d, table="asset_pool"):
    conn = raw(d)
    try:
        return [r[1] for r in conn.execute(
            "PRAGMA table_info(%s)" % table) if r[5]]
    finally:
        conn.close()


def ver_of(d):
    conn = raw(d)
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def build_old_db(d, pool, refs, slots, ver):
    """手工构造老库：asset_pool 是 alias 主键、rack_refs 没有 hash 列。"""
    os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(os.path.join(d, "project.db"))
    conn.executescript("""
        CREATE TABLE asset_pool (
            alias TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'images',
            file TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}',
            updated_at REAL NOT NULL);
        CREATE TABLE rack_refs (
            cid TEXT NOT NULL, kind TEXT NOT NULL, slot_idx INTEGER NOT NULL,
            alias TEXT NOT NULL, updated_at REAL NOT NULL,
            PRIMARY KEY (cid, kind, slot_idx));
        CREATE TABLE rack_slots (
            cid TEXT NOT NULL, kind TEXT NOT NULL, slot_idx INTEGER NOT NULL,
            file TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}',
            updated_at REAL NOT NULL, PRIMARY KEY (cid, kind, slot_idx));
    """)
    now = time.time()
    for alias, f in pool:
        conn.execute("INSERT INTO asset_pool VALUES(?,?,?,?,?)",
                     (alias, "images", f, "{}", now))
    for cid, idx, alias in refs:
        conn.execute("INSERT INTO rack_refs VALUES(?,?,?,?,?)",
                     (cid, "images", idx, alias, now))
    for cid, idx, f in slots:
        conn.execute("INSERT INTO rack_slots VALUES(?,?,?,?,?,?)",
                     (cid, "images", idx, f, "{}", now))
    conn.execute("PRAGMA user_version = %d" % ver)
    conn.commit()
    conn.close()


def case_share(d):
    print("【1】同名不同内容不互顶 + 同内容全片共享")
    a1 = put(d, "a1.png", b"AAA-content-1")
    a2 = put(d, "a2.png", b"BBB-content-2")
    a3 = put(d, "a3.png", b"CCC-content-3")
    b1 = put(d, "b1.png", b"AAA-content-1")   # 与 a1 同内容、不同路径
    S.save_rack(d, "c1", rack([{"file": a1, "alias": ["陈九一"]}]))
    S.save_rack(d, "c2", rack([{"file": a2, "alias": ["陈九一"]}]))
    S.save_rack(d, "c3", rack([{"file": a3, "alias": ["陈九一"]}]))
    S.save_rack(d, "c4", rack([{"file": b1, "alias": ["陈九一"]}]))
    pool = S.load_pool(d)
    check("三份不同内容 → 三条池记录（同名不再合并）", len(pool) == 3, pool)
    f1 = S.load_rack(d, "c1")["slots"]["images"][0]["file"]
    f2 = S.load_rack(d, "c2")["slots"]["images"][0]["file"]
    f3 = S.load_rack(d, "c3")["slots"]["images"][0]["file"]
    f4 = S.load_rack(d, "c4")["slots"]["images"][0]["file"]
    check("段2/段3 各读各的图（核心 bug：跨段不互顶）",
          f2 == a2 and f3 == a3, (f2, f3))
    check("同内容共享一条：段1/段4 读回同一文件", f1 == f4, (f1, f4))
    check("共享条目内容与原图一致", sha(f1) == sha(a1), f1)
    conn = raw(d)
    hs = {r["cid"]: r["hash"] for r in conn.execute(
        "SELECT cid, hash FROM rack_refs WHERE kind='images' AND slot_idx=0")}
    conn.close()
    check("引用记非空哈希：段1=段4，段1/2/3 互不相同",
          all(hs.values()) and hs["c1"] == hs["c4"]
          and len({hs["c1"], hs["c2"], hs["c3"]}) == 3, hs)
    check("重名清单键不丢条目",
          len(pool) == 3 and {v["file"] for v in pool.values()} == {a2, a3, b1},
          list(pool.keys()))
    return hs


def case_swap(d, hs):
    print("【2】换图＝换绑：重名歧义 + 后缀指定")
    newf = put(d, "new.png", b"NEW-content")
    try:
        S.set_asset_file(d, "陈九一", newf)
        check("重名不带后缀应拒绝并列候选", False, "没有抛 ValueError")
    except ValueError as e:
        check("重名不带后缀应拒绝并列候选", "陈九一#" in str(e), str(e))
    n = S.set_asset_file(d, "陈九一#" + hs["c2"][:8], newf)
    f1 = S.load_rack(d, "c1")["slots"]["images"][0]["file"]
    f2 = S.load_rack(d, "c2")["slots"]["images"][0]["file"]
    f3 = S.load_rack(d, "c3")["slots"]["images"][0]["file"]
    check("后缀指定换图只动段2", n == 1 and f2 == newf, (n, f2))
    check("段1/段3 不受牵连", f1 != newf and f3 != newf, (f1, f3))
    check("孤儿旧条目被删、池仍 3 条", len(S.load_pool(d)) == 3)
    conn = raw(d)
    mir = conn.execute(
        "SELECT file FROM rack_slots WHERE cid='c2' AND kind='images'"
        " AND slot_idx=0").fetchone()[0]
    conn.close()
    check("rack_slots 镜像同步换绑", mir == newf, mir)


def case_unique(d):
    print("【3】唯一名换图 / 不存在的名字")
    u1 = put(d, "u1.png", b"U1")
    u2 = put(d, "u2.png", b"U2")
    S.save_rack(d, "c5", rack([{"file": u1, "alias": ["独一份"]}]))
    n = S.set_asset_file(d, "独一份", u2)
    check("唯一名换图返回 1 段且读回新图",
          n == 1 and S.load_rack(d, "c5")["slots"]["images"][0]["file"] == u2, n)
    check("池里没有的名字返回 0", S.set_asset_file(d, "不存在", u2) == 0)


def case_migrate_v4(d):
    print("【4】v4 老库自动迁移")
    g1 = put(d, "g1.png", b"OLD-1")
    g2 = put(d, "g2.png", b"OLD-2")
    build_old_db(d,
                 pool=[("陈九一", g1), ("美女", g2)],
                 refs=[("c1", 0, "陈九一"), ("c2", 0, "陈九一"),
                       ("c2", 1, "美女")],
                 slots=[("c1", 0, g1), ("c2", 0, g1), ("c2", 1, g2)],
                 ver=4)
    r1 = S.load_rack(d, "c1")
    r2 = S.load_rack(d, "c2")
    check("老库段1读回正确", r1["slots"]["images"][0]["file"] == g1, r1)
    check("老库段2两槽读回正确",
          [x["file"] for x in r2["slots"]["images"]] == [g1, g2], r2)
    check("主键切到 hash", pk_of(d) == ["hash"], pk_of(d))
    check("版本推到 5", ver_of(d) == 5, ver_of(d))
    conn = raw(d)
    ph = {r["alias"]: r["hash"] for r in conn.execute(
        "SELECT alias, hash FROM asset_pool")}
    rh = conn.execute(
        "SELECT hash FROM rack_refs WHERE cid='c1'").fetchone()[0]
    idx = [r["name"] for r in conn.execute("PRAGMA index_list(rack_refs)")]
    conn.close()
    check("hash 回填＝文件真实 sha256",
          ph.get("陈九一") == sha(g1) and ph.get("美女") == sha(g2), ph)
    check("段引用同步回填 hash", rh == sha(g1), rh)
    check("hash 索引在补列之后建成", "idx_rack_refs_hash" in idx, idx)
    g3 = put(d, "g3.png", b"OLD-3")
    ok = S.save_rack(d, "c3", rack([{"file": g3, "alias": ["新段"]}]))
    check("迁移后保存不再报 ON CONFLICT 错", ok is True)
    return g1, g2


def case_bad_v5(d):
    print("【5】坏 v5 库（版本达标但主键没切）自检修复")
    k1 = put(d, "k1.png", b"BAD5-1")
    build_old_db(d, pool=[("坏库", k1)], refs=[("c1", 0, "坏库")],
                 slots=[("c1", 0, k1)], ver=5)
    r = S.load_rack(d, "c1")
    check("坏库读回正确", r["slots"]["images"][0]["file"] == k1, r)
    check("主键自检切到 hash（不依赖版本号）",
          pk_of(d) == ["hash"], pk_of(d))
    S.save_rack(d, "c2", rack([{"file": k1, "alias": ["坏库"]}]))
    check("坏库修复后保存可用",
          S.load_rack(d, "c2")["slots"]["images"][0]["file"] == k1)


def case_idempotent(d):
    print("【6】幂等：重复打开不改数据")
    before = S.load_pool(d)
    S.close_db(d)
    after = S.load_pool(d)
    check("重开前后池条目一致", before == after, (before, after))
    check("主键/版本稳定", pk_of(d) == ["hash"] and ver_of(d) == 5)


def case_fallback(d):
    print("【7】读不出文件 / 无文件的兜底")
    ghost1 = os.path.join(d, "ghost1.png")   # 故意不创建
    ghost2 = os.path.join(d, "ghost2.png")
    S.save_rack(d, "c1", rack([{"file": ghost1, "alias": ["幽灵"]}]))
    S.save_rack(d, "c2", rack([{"file": ghost2, "alias": ["幽灵"]}]))
    check("两份读不出的同名素材不互撞（路径占位）",
          len(S.load_pool(d)) == 2, S.load_pool(d))
    check("各读各的路径",
          S.load_rack(d, "c1")["slots"]["images"][0]["file"] == ghost1
          and S.load_rack(d, "c2")["slots"]["images"][0]["file"] == ghost2)
    S.save_rack(d, "c3", rack([{"alias": ["无图"]}]))
    r3 = S.load_rack(d, "c3")
    check("无文件槽位保存读回正常",
          r3["slots"]["images"][0].get("alias") == ["无图"], r3)


def case_downgrade(d, g1, g2):
    print("【8】显式降级与再升级（回滚通道）")
    check("降级执行", S.downgrade_pool_to_v4(d) is True)
    check("主键回 alias、版本回 4",
          pk_of(d) == ["alias"] and ver_of(d) == 4, (pk_of(d), ver_of(d)))
    conn = raw(d)
    rows = conn.execute(
        "SELECT r.cid, p.file FROM rack_refs r"
        " LEFT JOIN asset_pool p ON p.alias=r.alias"
        " WHERE r.cid IN ('c1','c2') ORDER BY r.cid, r.slot_idx").fetchall()
    conn.close()
    check("旧代码按名字 JOIN 读回一致（回滚可用）",
          [(r["cid"], r["file"]) for r in rows]
          == [("c1", g1), ("c2", g1), ("c2", g2)],
          [tuple(r) for r in rows])
    check("二次降级无事可做", S.downgrade_pool_to_v4(d) is False)
    S.close_db(d)
    r = S.load_rack(d, "c1")
    check("新代码重开自动再升级、数据不变",
          pk_of(d) == ["hash"] and r["slots"]["images"][0]["file"] == g1)


def case_cache(tmp):
    print("【9】哈希缓存")
    cf = put(tmp, "cache.bin", b"v1")
    h1 = S._file_hash(cf)
    check("未变文件重复取哈希一致", h1 == S._file_hash(cf) and h1 == sha(cf))
    put(tmp, "cache.bin", b"v2-longer-content")
    check("内容变了哈希跟着变",
          S._file_hash(cf) == sha(cf) and S._file_hash(cf) != h1)
    check("读不出的文件返回空串",
          S._file_hash(os.path.join(tmp, "nope.bin")) == "")


def case_slots_migration(d):
    print("【10】rack_slots 一次性迁移")
    m1 = put(d, "m1.png", b"M1")
    build_old_db(d, pool=[], refs=[], slots=[("c1", 0, m1)], ver=4)
    S.load_rack(d, "c1")   # 先触发结构迁移（空池，退回槽位读）
    r = S.migrate_rack_to_pool(d)
    check("迁移出 1 池条目 + 1 引用", r == {"pool": 1, "refs": 1}, r)
    check("迁移后读回正确",
          S.load_rack(d, "c1")["slots"]["images"][0]["file"] == m1)
    r2 = S.migrate_rack_to_pool(d)
    check("幂等重跑不新增池条目", r2["pool"] == 0, r2)


def main():
    tmp = tempfile.mkdtemp(prefix="bz_hash_v5_")
    dirs = []

    def nd(name):
        d = os.path.join(tmp, name)
        os.makedirs(d)
        dirs.append(d)
        return d

    try:
        d1 = nd("case1")
        hs = case_share(d1)
        case_swap(d1, hs)
        case_unique(d1)
        d4 = nd("case4")
        g1, g2 = case_migrate_v4(d4)
        case_bad_v5(nd("case5"))
        case_idempotent(d4)
        case_fallback(nd("case7"))
        case_downgrade(d4, g1, g2)
        case_cache(tmp)
        case_slots_migration(nd("case10"))
        print("")
        if FAILS:
            print("自检失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("素材池哈希 v5 自检：全部通过")
        return 0
    finally:
        for d in dirs:
            try:
                S.close_db(d)
            except Exception:
                pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())