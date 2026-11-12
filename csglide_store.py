"""班长全家桶 · 本地统一状态库（SQLite，方案 A）—— 20261012

一条片子 = 工程目录里一个 ``project.db``。新工程的全部状态（片级设置、段落
元数据、导演台面板、媒体架段槽位、文案台台词、操作流水、还原点、版本台账）
都收口到这个库里；大文件（latent / cont / mp4 / wav）仍留在文件系统，库里
只存路径与参数。

与旧 JSON 档案的关系（用户拍板：老工程不管）：

* 工程目录里**已有 chain.json** 的 = 老工程，永远继续走 JSON，本模块不碰；
* 两者都没有的工程第一次写时**自动建库**，此后只走 DB、不再产生 JSON；
* 工程目录里有 project.db 的 = DB 工程，权威在库。

并发模型：每库一个连接（WAL，多读单写）+ 每库一把 RLock。csglide_chain 的
公开写点本来就全包在全局 ``_chain_lock`` 里，库调用在其内天然串行；本模块
自带的 per-db 锁给自检脚本与未来直连兜底。所有写都是完整事务，崩溃不留
半截状态；操作流水 ``events.seq`` 由 SQLite AUTOINCREMENT 发号，全局单调，
前端按它对账，迟到旧写不可能盖掉新状态。

本模块**不 import csglide_chain**（单向依赖：chain → store），工程目录口径
与 ``csglide_chain.chain_dir`` 保持逐字一致（两处同实现，改一处要同步另一处）。
"""

import contextlib
import json
import os
import re
import sqlite3
import threading
import time

try:
    import folder_paths
except Exception:      # pragma: no cover
    folder_paths = None

DB_FILENAME = "project.db"
# v3（20261025）：shots.shot_uid 唯一 —— 一段的 uid 全局只能登记一次。
# 事故背景见 _migrate_v3 的注释；v4 见 _migrate_v4（段词版本号）。
SCHEMA_VERSION = 4

# 素材落在 input 下的哪个目录（与前端 csglide_cast_core.js 的 ASSET_SUBFOLDER
# 同值；ComfyUI 在 Linux 上区分大小写，别改大小写）。
ASSET_SUBFOLDER = "cglide"

# 片级键值表（meta）里允许出现的键；chain 文档其余键也照存，这里只列默认值。
# 20261111 阶段 2 / C：stage（一采 s1 / 二采 s2）与 film_variant
# （三采成品 final / 二采原片 raw）都是片级真值，必须登记进白名单。
# 漏登记时 save_chain_doc 会静默丢键 —— set_stage 返回「已切到二采」但库里
# 还是一采，F5 之后按钮和后端直接对不上，属于最难查的「假成功」。
_CHAIN_KEYS = ("name", "fps", "trim_frames", "prompt_global", "current",
               "locked", "order", "transitions", "gen", "stage", "film_variant")
_CHAIN_DEFAULTS = {
    "name": "", "fps": 24, "trim_frames": 22, "prompt_global": "",
    "current": None, "locked": False, "order": [], "transitions": {},
    "gen": 0, "stage": "s1", "film_variant": "raw",
}
# clip 文档里被抽成 shots 标量列的键（其余一律进 meta_json，绝不丢字段）。
_SHOT_SCALARS = {
    "shot_uid": ("shot", ""),       # 标量列名, (clip dict 键, 默认值)
    "name": ("name", ""),
    "frames": ("frames", 0),
    "locked": ("locked", 0),
    "pending": ("pending", None),
}

# --------------------------------------------------------------------------
# 连接管理（每工程目录一个连接，按绝对路径缓存）
# --------------------------------------------------------------------------

_conns = {}                 # normpath(dir) -> sqlite3.Connection
_db_locks = {}              # normpath(dir) -> RLock
_conns_guard = threading.Lock()


def _out_dir():
    # 与 csglide_chain._out_dir 同口径。
    return folder_paths.get_output_directory() if folder_paths is not None else "."


# --------------------------------------------------------------------------
# 名字 → 目录名 索引（20261020 方案 G）
# --------------------------------------------------------------------------
# 以前「片名」就是磁盘目录名，于是改名 = 给目录改名（os.rename）。这在 Windows
# 上天生脆弱：目录里只要有**任何一个**文件被打开，系统就拒绝改目录名
# （PermissionError WinError 5，已本地复现）。而"刚渲染完想改个名"恰恰是句柄
# 最多的时候。
#
# 现在：目录建好之后**永远不动**，改名字只改这张索引表。索引只登记**改过名的**
# 工程 —— 没改过名的，目录名就等于片名，走老规则自动正确，不需要登记。
#
# 反查（目录名 → 名字）给「历史工程清单」用：那个清单是扫目录得到的，扫出来
# 的是目录名，要翻回用户看到的名字。
INDEX_FILENAME = "_index.json"
_index_cache = {"mtime": -1, "data": {}}


def _index_path():
    return os.path.join(_out_dir(), "h3_chain", INDEX_FILENAME)


def _read_index():
    """读索引（按 mtime 缓存，改名是低频操作，但 chain_dir 是高频调用）。"""
    p = _index_path()
    try:
        mt = os.path.getmtime(p)
    except Exception:
        _index_cache["mtime"] = -1
        _index_cache["data"] = {}
        return {}
    if mt == _index_cache["mtime"]:
        return _index_cache["data"]
    data = {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        got = d.get("names") if isinstance(d, dict) else None
        if isinstance(got, dict):
            data = {str(k): str(v) for k, v in got.items() if k and v}
    except Exception:
        data = {}
    _index_cache["mtime"] = mt
    _index_cache["data"] = data
    return data


def _write_index(data):
    """整表写回（tmp + os.replace，与 _write_json 同口径）。"""
    p = _index_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "names": data}, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p)
    except Exception:
        return False
    _index_cache["mtime"] = -1
    _index_cache["data"] = {}
    return True


def dir_name_of(name):
    """该片名的档案目录名（h3_chain 下的那一层）。没登记过返回空串。"""
    return _read_index().get(str(name or "").strip()) or ""


def name_of_dir(dirname):
    """反查：这个目录现在是哪个片子在用。没登记过返回空串。"""
    dn = str(dirname or "").strip()
    if not dn:
        return ""
    for nm, d in _read_index().items():
        if d == dn:
            return nm
    return ""


def set_dir_of(name, dirname):
    """登记 / 改一条映射。返回是否真写了（同值不写）。"""
    nm, dn = str(name or "").strip(), str(dirname or "").strip()
    if not nm or not dn:
        return False
    data = dict(_read_index())
    if data.get(nm) == dn:
        return False
    data[nm] = dn
    return _write_index(data)


def drop_dir_of(name):
    """删掉一条映射（工程删除 / 改名后旧名作废）。"""
    nm = str(name or "").strip()
    if not nm:
        return False
    data = dict(_read_index())
    if nm not in data:
        return False
    data.pop(nm)
    return _write_index(data)


def rename_index_key(old, new):
    """改名：把 old 这条映射的**键**换成 new，指向的目录一个字节都不动。

    顺序是先写新键再删旧键 —— 反过来会有一瞬间两条键指向同一目录，而中间
    崩溃则旧键残留（旧名仍指向该目录）。
    """
    o, n = str(old or "").strip(), str(new or "").strip()
    if not o or not n or o == n:
        return False
    data = dict(_read_index())
    if o not in data:
        return False
    data[n] = data[o]
    data.pop(o)
    return _write_index(data)


def chain_dir(name):
    """片名 → 档案目录（唯一实现；csglide_chain.chain_dir 委托到这里）。

    先看索引（改过名的工程，目录名与片名不同），没有就按老规则拼 —— 没改过名
    的工程目录名就是片名，老规则自动正确。
    """
    safe = "".join(c for c in (name or "未命名") if c not in '\\/:*?"<>|').strip() or "未命名"
    dn = dir_name_of(name)
    return os.path.join(_out_dir(), "h3_chain", dn or safe)


def safe_dir_name(name):
    """片名 → **素材**目录名（input 侧）。

    ⚠️ 与上面 chain_dir（output 侧）**不是一个口径**：chain_dir 把非法字符
    **删掉**，这里换成**下划线**（``a/b`` → ``ab`` / ``a_b``）。两个目录是历史
    上各自这么建起来的，统一任何一边都会让老工程找不到自己的目录。所以任何
    按片名拼目录的代码，都必须先分清自己在算哪一侧、用对应的那个函数。

    与前端 csglide_cast_core.js 的 ``safeDirName`` 同口径（非法字符 + 控制
    字符 → ``_``），两边算出不同的名字，素材就会落在两个地方、隔离形同虚设。
    """
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", str(name or "")).strip()
    return "" if s in (".", "..") else s


def asset_dir(name):
    """该工程的素材目录 ``input/cglide/<片名>/``（与前端 assetDirOf 同口径）。

    拿不到片名或拿不到 input 目录时返回空串 —— 调用方按「退回 cglide 根」处理，
    与这套隔离上线之前的行为逐字一致。
    """
    d = safe_dir_name(name)
    if not d or folder_paths is None:
        return ""
    return os.path.join(folder_paths.get_input_directory(), ASSET_SUBFOLDER, d)


def db_path(d):
    return os.path.join(d, DB_FILENAME)


def has_db(d):
    """工程目录里是否已有状态库。"""
    return os.path.isfile(db_path(d))


# 连接门面：锁跟着连接走，调用方绕不过去（20261109）
# 为什么：_connect 原本按工程缓存唯一 sqlite3.Connection 且 check_same_thread=False，
# 锁只在调用方自觉 with _lock_for(d) 时生效；banzhang_audio_cut 等模块直接拿连接
# 调 _meta_set，撞上 run_in_executor 线程池就触发 SQLITE_MISUSE。
class _SafeCursor:
    """游标代理：execute 之后的 fetch / 迭代也必须持锁，否则仍是并发用连接。"""

    def __init__(self, cur, lock):
        object.__setattr__(self, "_cur", cur)
        object.__setattr__(self, "_lock", lock)

    def __iter__(self):
        with object.__getattribute__(self, "_lock"):
            for row in object.__getattribute__(self, "_cur"):
                yield row

    def __getattr__(self, name):
        lock = object.__getattribute__(self, "_lock")
        with lock:
            attr = getattr(object.__getattribute__(self, "_cur"), name)
            if not callable(attr) or isinstance(attr, type):
                return attr

            def _wrapped(*a, **kw):
                with lock:
                    return attr(*a, **kw)

            return _wrapped


class _SafeConn:
    """连接门面：所有接口整段持该工程 RLock；属性读写转发到真实连接。"""

    def __init__(self, raw, lock):
        object.__setattr__(self, "_raw", raw)
        object.__setattr__(self, "_lock", lock)
        object.__setattr__(self, "_closed", False)

    @contextlib.contextmanager
    def op(self):
        """整段持锁的操作门面：多行写 + 条件提交必须是一个原子操作。"""
        with object.__getattribute__(self, "_lock"):
            if object.__getattribute__(self, "_closed"):
                raise RuntimeError("工程库已关闭，请重新打开工作流后再操作")
            yield object.__getattribute__(self, "_raw")

    def execute(self, sql, *a, **kw):
        with self.op() as raw:
            return _SafeCursor(raw.execute(sql, *a, **kw), self._lock)

    def close(self):
        with self._lock:
            object.__setattr__(self, "_closed", True)
            self._raw.close()

    def __enter__(self):
        self._lock.acquire()
        try:
            self._raw.__enter__()
            return self
        except BaseException:
            self._lock.release()
            raise

    def __exit__(self, *exc):
        try:
            return self._raw.__exit__(*exc)
        finally:
            self._lock.release()

    def __getattr__(self, name):
        lock = object.__getattribute__(self, "_lock")
        with lock:
            attr = getattr(object.__getattribute__(self, "_raw"), name)
            if not callable(attr) or isinstance(attr, type):
                return attr

            def _wrapped(*a, **kw):
                with lock:
                    return attr(*a, **kw)

            return _wrapped

    def __setattr__(self, name, value):
        if name.startswith("_"):
            object.__setattr__(self, name, value)
            return
        with object.__getattribute__(self, "_lock"):
            setattr(object.__getattribute__(self, "_raw"), name, value)


def _locked(conn):
    """整段持锁的上下文；自检脚本直接传原始连接时也能用。"""
    return conn.op() if isinstance(conn, _SafeConn) else contextlib.nullcontext(conn)


def _lock_for(d):
    key = os.path.normcase(os.path.abspath(d))
    with _conns_guard:
        lk = _db_locks.get(key)
        if lk is None:
            lk = threading.RLock()
            _db_locks[key] = lk
        return lk


def _connect(d, create=True):
    """拿（必要时建）该工程的库连接。create=False 且库不存在时返回 None。"""
    key = os.path.normcase(os.path.abspath(d))
    lock = _lock_for(d)          # 先取锁：_conns_guard 不可重入，别在它里面嵌套拿
    with _conns_guard:
        conn = _conns.get(key)
        if conn is not None:
            return conn
        if not create and not os.path.isfile(db_path(d)):
            return None
        os.makedirs(d, exist_ok=True)
        conn = _SafeConn(sqlite3.connect(db_path(d), check_same_thread=False), lock)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        _create_schema(conn)
        _conns[key] = conn
        return conn


def close_db(d):
    """工程改名/删除后关掉旧路径连接（WAL 先 checkpoint，文件随目录搬走）。"""
    key = os.path.normcase(os.path.abspath(d))
    with _conns_guard:
        conn = _conns.pop(key, None)
    if conn is None:
        return
    try:
        with conn.op() as raw:      # 整段持锁，别在别人还在读写时关连接
            raw.execute("PRAGMA wal_checkpoint(FULL)")
            raw.close()
            object.__setattr__(conn, "_closed", True)
    except Exception:
        pass


def copy_db(src_dir, dst_dir):
    """把一个工程库**一致地**复制到另一个目录（拖入视频还原整份档案用，20261107）。

    为什么不能像普通文件那样 shutil.copy2：库跑在 WAL 模式下，最后一次
    checkpoint 之后的写入还躺在 ``project.db-wal`` 里，只拷主文件会把它们
    全丢掉 —— 新工程看起来"少了一段"，或者参数整段退回上一次的值，而这两种
    现象都不会报错，只会让人怀疑"复制功能坏了"。

    SQLite 的在线备份 API 把 WAL 里的页一起读出来写进目标库，读侧不中断
    （自愈巡检每 3 秒在读同一个库）。目标目录里已有的旧库文件先删掉：备份
    是"写一份新库"，不是"覆盖页"，残留的 -wal 会让新库以为有别人没写完的
    事务。

    返回是否真复制了（源目录没有库 = JSON 老工程，返回 False，由调用方按
    "整个目录照拷"处理）。
    """
    s_db = db_path(src_dir)
    if not os.path.isfile(s_db):
        return False
    os.makedirs(dst_dir, exist_ok=True)
    d_db = db_path(dst_dir)
    for suffix in ("", "-wal", "-shm"):
        try:
            if os.path.isfile(d_db + suffix):
                os.remove(d_db + suffix)
        except Exception:
            pass
    src = sqlite3.connect(s_db, timeout=10)
    try:
        dst = sqlite3.connect(d_db, timeout=10)
        try:
            src.backup(dst)
            # 备份时写进去的页还堆在目标库自己的 -wal 里：checkpoint 一次，
            # 让 project.db 单体就是完整的（用户拷走一个文件也不会缺东西）。
            try:
                dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
        finally:
            dst.close()
    finally:
        src.close()
    return True


def replace_in_db(d, pairs):
    """在库的**所有文本列**里做字面替换（复制档案后把绝对路径指向新目录）。

    为什么宽到"所有文本列"：路径不止藏在 ``shots.meta_json``（``film`` /
    ``take_params.*.cont_saved`` 存的就是绝对路径），``shot_versions`` 每版
    快照、``segment_bindings``、``snapshots`` 里也都可能有。按字段名一处一处
    补，迟早漏掉下一个新加的 —— 而"漏掉"的表现是副本播的还是原片的文件，
    原片一删就报"找不到承接档"，比复制失败难查得多。

    一次事务、失败回滚：半改的库（一半指向新目录、一半指向旧目录）比不改更糟。
    表都很小（几 MB 的 JSON），整表 REPLACE 的代价可以忽略。
    """
    conn = _connect(d, create=False)
    if conn is None:
        return 0
    pairs = [(o, n) for o, n in (pairs or []) if o]
    if not pairs:
        return 0
    hit = 0
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            tables = [r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%'")]
            for t in tables:
                cols = [r[1] for r in conn.execute('PRAGMA table_info("%s")' % t)]
                if not cols:
                    continue
                # 只动文本列：整数/浮点列做 REPLACE 会改写类型。
                kinds = {r[1]: str(r[2] or "").upper()
                         for r in conn.execute('PRAGMA table_info("%s")' % t)}
                for col in cols:
                    k = kinds.get(col, "")
                    if k and k not in ("TEXT", "CLOB", ""):
                        continue
                    for old, new in pairs:
                        cur = conn.execute(
                            'UPDATE "%s" SET "%s" = REPLACE("%s", ?, ?)'
                            % (t, col, col), (old, new))
                        # changes() 数的是"被 UPDATE 摸到的行"，只在真的变了才准，
                        # 这里只用它做粗略统计（闪一下给用户看），不作判据。
                        hit += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return hit


def backend(d):
    """返回该工程当前的存储后端：'db' / 'json' / None（啥都还没有）。

    判定只读磁盘、不建库。db 与 json 并存时以 db 为权威（正常不会并存）。
    """
    if has_db(d):
        return "db"
    if os.path.isfile(os.path.join(d, "chain.json")):
        return "json"
    return None


def ensure_db(d):
    """首次写定型：db 在→db；chain.json 在（老工程）→不动，返回 'json'；
    都没有（全新工程）→建库，返回 'db'。"""
    be = backend(d)
    if be == "db":
        _connect(d)
        return "db"
    if be == "json":
        return "json"
    _connect(d, create=True)
    return "db"


# --------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------

def _migrate(conn):
    """把老库修到当前 SCHEMA_VERSION 的形状。幂等、**零破坏**（不删用户段）。

    每次 _connect 都会进来，靠 PRAGMA user_version 决定是否动手。升级失败**不抛**
    —— 留一条 meta 告警让界面提示，库继续按旧结构可用，不能因为迁移把节点带崩。
    """
    try:
        ver = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
    except Exception:
        ver = 0
    if ver >= SCHEMA_VERSION:
        return
    try:
        if ver < 3:
            _migrate_v3(conn)
        if ver < 4:
            _migrate_v4(conn)
    except Exception as e:
        print("[H3 Store] 迁移失败（库继续可用，仍是旧结构）：", e)


def _migrate_v4(conn):
    """v4（20261031）：给段词上**版本号**（A+ 方案的乐观锁）。

    事故：段词有两条写通道 —— 按段增量 pushSegText 和整包 saveDesk（防抖
    700ms 全量覆盖）。整包那一份是前端内存的**旧副本**，它会把另一个节点刚
    写进中央的词原样盖回去。merge 层的"空值不抹"只能挡住空串，挡不住"有内
    容的旧值"。要根治就得让中央能回答一句话："你手上这份是过期的"。

    所以段词行加一列 desk_rev：每次真写入 +1，写的时候带上 base_rev，
    对不上就 409 并把中央真值回给前端。列本身零破坏（默认值 0 = 从未版本化）。
    """
    cols = [str(r["name"]) for r in conn.execute(
        "PRAGMA table_info(segment_bindings)")]
    if "desk_rev" not in cols:
        conn.execute(
            "ALTER TABLE segment_bindings "
            "ADD COLUMN desk_rev INTEGER NOT NULL DEFAULT 0")
    conn.commit()


def _migrate_v3(conn):
    """v3（20261025）：给段身份上锁。

    事故：段没有唯一身份约束时，一次误调用就能让同一段在档案里出现第二个 cid
    （旧 scheduleSelfHeal 先把 shot.clip 清空再登记，后端 add_clip 的 uid 幂等
    因此失效），时间轴按档案画块 → 6 段变 10 段，且不可逆。

    这里只**加约束 + 修顺序号**，绝不替用户删段：
      · ord 撞号（两段同为 ord=5）会让"没有 order 时的排序"变成随机的 →
        按 meta.order 重排一次。ord 只是排序缓存，权威是 meta.order。
        **ord 不加唯一约束**：ord 的下标来自 index-1，两段同 index 是合法业务
        状态，加约束会让保存直接抛错。
      · shot_uid 唯一（空串除外）：一段的 uid 全局只能出现一次。历史数据本身
        有重复时索引建不上 —— 写一条 meta 告警交给用户清理，不在这里静默删段。
    """
    order = _meta_get(conn, "order", []) or []
    try:
        order = [str(c) for c in order]
    except Exception:
        order = []
    rows = [str(r["cid"]) for r in conn.execute(
        "SELECT cid FROM shots ORDER BY created_at, cid")]
    if rows:
        seq = [c for c in order if c in set(rows)]
        seq += [c for c in rows if c not in set(seq)]
        for i, cid in enumerate(seq):
            conn.execute("UPDATE shots SET ord=? WHERE cid=? AND ord<>?",
                         (i, cid, i))
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_shots_uid "
            "ON shots(shot_uid) WHERE shot_uid <> ''")
        conn.execute("DELETE FROM meta WHERE key='migrate_v3_warn'")
    except sqlite3.IntegrityError:
        dup = ["%s×%d" % (r[0], r[1]) for r in conn.execute(
            "SELECT shot_uid, COUNT(*) FROM shots WHERE shot_uid <> '' "
            "GROUP BY shot_uid HAVING COUNT(*) > 1")]
        _meta_set(conn, "migrate_v3_warn",
                  "shots 表存在重复 shot_uid（" + "、".join(dup[:8])
                  + "），唯一索引未建立；先清理重复段再升级")
        print("[H3 Store] v3 警告：重复 shot_uid，唯一索引未建立 →", dup[:8])
    conn.commit()


def _create_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shots (
            cid        TEXT PRIMARY KEY,
            ord        INTEGER NOT NULL DEFAULT 0,
            shot_uid   TEXT NOT NULL DEFAULT '',
            name       TEXT NOT NULL DEFAULT '',
            frames     INTEGER NOT NULL DEFAULT 0,
            locked     INTEGER NOT NULL DEFAULT 0,
            pending    TEXT,
            created_at REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL,
            meta_json  TEXT NOT NULL DEFAULT '{}'   -- clip 文档全量（state 除外）
        );
        CREATE INDEX IF NOT EXISTS idx_shots_ord ON shots(ord);

        CREATE TABLE IF NOT EXISTS shot_state (
            cid TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rack_slots (
            cid      TEXT NOT NULL,
            kind     TEXT NOT NULL,                 -- images / videos / audios
            slot_idx INTEGER NOT NULL,
            file     TEXT NOT NULL DEFAULT '',
            params   TEXT NOT NULL DEFAULT '{}',
            updated_at REAL NOT NULL,
            PRIMARY KEY (cid, kind, slot_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_rack_file ON rack_slots(file);

        -- 素材池（20261017）：一部片子的素材只在这里存一份，按「名字」收口。
        -- 段不再各存一份 file，而是在 rack_refs 里记「第几格用了哪个名字」，
        -- 读的时候 JOIN 展开。换一张图只改这里一行，引用它的所有段跟着一起
        -- 变 —— 原来 9 段 × 28 张 = 252 条里 89% 是重复，改一次要改九次。
        CREATE TABLE IF NOT EXISTS asset_pool (
            alias      TEXT PRIMARY KEY,   -- 素材名（别名优先，其次文件名主干）
            kind       TEXT NOT NULL DEFAULT 'images',
            file       TEXT NOT NULL DEFAULT '',
            params     TEXT NOT NULL DEFAULT '{}',
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rack_refs (
            cid      TEXT NOT NULL,
            kind     TEXT NOT NULL,
            slot_idx INTEGER NOT NULL,
            alias    TEXT NOT NULL,        -- → asset_pool.alias
            updated_at REAL NOT NULL,
            PRIMARY KEY (cid, kind, slot_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_rack_refs_alias ON rack_refs(alias);

        CREATE TABLE IF NOT EXISTS events (
            seq     INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      REAL NOT NULL,
            actor   TEXT NOT NULL DEFAULT '',
            action  TEXT NOT NULL,
            cid     TEXT,
            payload TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'auto',   -- auto / manual / before_action
            shots_json TEXT NOT NULL,
            desk_json TEXT NOT NULL DEFAULT '{}',
            cur_cid TEXT, idx INTEGER,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shot_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cid TEXT NOT NULL,
            take INTEGER NOT NULL,
            frames INTEGER NOT NULL DEFAULT 0,
            width INTEGER, height INTEGER,
            take_params TEXT NOT NULL DEFAULT '{}',
            film_path TEXT, latent_path TEXT, cont_path TEXT, audio_path TEXT,
            film_frames INTEGER NOT NULL DEFAULT 0,
            is_current INTEGER NOT NULL DEFAULT 1,
            note TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            UNIQUE(cid, take)
        );

        CREATE TABLE IF NOT EXISTS run_receipts (
            prompt_id TEXT PRIMARY KEY,
            cid TEXT NOT NULL,
            take INTEGER NOT NULL,
            latent_path TEXT,
            cont_path TEXT,
            segment_film TEXT NOT NULL DEFAULT '{}',
            whole_film TEXT NOT NULL DEFAULT '{}',
            detail_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'adopted',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_receipts_cid_take
            ON run_receipts(cid, take);

        CREATE TABLE IF NOT EXISTS segment_bindings (
            cid TEXT PRIMARY KEY,
            shot_uid TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'append',
            source_cid TEXT NOT NULL DEFAULT '',
            state_json TEXT NOT NULL DEFAULT '{}',
            rack_json TEXT NOT NULL DEFAULT '{}',
            desk_text TEXT NOT NULL DEFAULT '',
            desk_rev INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'bound',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_segment_bindings_shot
            ON segment_bindings(shot_uid);

        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cid TEXT NOT NULL, take INTEGER NOT NULL DEFAULT 1,
            kind TEXT NOT NULL,
            path TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
            mtime REAL NOT NULL DEFAULT 0,
            UNIQUE(cid, take, kind, path)
        );
        """
    )
    # 老库升级：表结构用 IF NOT EXISTS 建不出来差异，数据/约束的补齐走这里。
    _migrate(conn)
    conn.execute("PRAGMA user_version = %d" % SCHEMA_VERSION)
    conn.commit()


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _asset_key(item, kind, idx):
    """素材池主键：别名 → 文件名主干 → 槽位兜底，三者必居其一。

    素材池按「名字」收口，同一个名字在整部片子里只有一份 file。别名是用户在
    媒体架上起的名字（陈九一、守缺斋后堂…），没起名就退回文件名主干
    （ref2.jpg → ref2）——两张内容不同但同名的素材因此不会被互相顶掉，
    代价是它们会共用一个池条目（真要分开就起不同别名，如「陈九一·近景」）。
    """
    if isinstance(item, dict):
        al = item.get("alias")
        if isinstance(al, (list, tuple)):
            for x in al:
                s = str(x or "").strip()
                if s:
                    return s
        elif isinstance(al, str) and al.strip():
            return al.strip()
    f = str((item or {}).get("file") or "")
    stem = os.path.splitext(os.path.basename(f))[0].strip()
    if stem:
        return stem
    return "%s_%d" % (kind, idx)


def _jdumps(v):
    return json.dumps(v, ensure_ascii=False)


def _jloads(s, default):
    if s is None:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


def _meta_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    return _jloads(row[0], default)


def _meta_set(conn, key, value):
    # 无锁调用方（banzhang_audio_cut 等）写完不 commit 会留隐式事务，
    # 撞上持锁事务块的 BEGIN IMMEDIATE 就报 cannot start a transaction within a transaction。
    # 整段持锁，且「进入时不在事务里」的写立即提交；显式事务内行为不变。
    with _locked(conn) as raw:
        was_in_tx = raw.in_transaction
        raw.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, _jdumps(value)))
        if not was_in_tx and raw.in_transaction:
            raw.commit()


def _meta_set_many(conn, items):
    # 同 _meta_set：整段持锁，非显式事务写完立即提交。
    with _locked(conn) as raw:
        was_in_tx = raw.in_transaction
        raw.executemany(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [(k, _jdumps(v)) for k, v in items])
        if not was_in_tx and raw.in_transaction:
            raw.commit()


# --------------------------------------------------------------------------
# 片级文档（chain dict）
# --------------------------------------------------------------------------

def load_chain_doc(d, name):
    """从库拼出与旧 chain.json 同构的 dict。库不存在返回 None。"""
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        doc = dict(_CHAIN_DEFAULTS)
        doc["name"] = name
        for k in _CHAIN_KEYS:
            if k == "name":
                continue
            row = conn.execute("SELECT value FROM meta WHERE key=?", (k,)).fetchone()
            if row is not None:
                doc[k] = _jloads(row[0], _CHAIN_DEFAULTS.get(k))
        return doc


def save_chain_doc(d, name, data):
    """片级文档落库（调用方须已持写锁/在 chainlocked 内）。返回 'db'。"""
    conn = _connect(d, create=True)
    now = time.time()
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            items = [("name", name)]
            for k in _CHAIN_KEYS:
                if k == "name":
                    continue
                if k in data:
                    items.append((k, data.get(k)))
                elif k in ("stage", "film_variant"):
                    # 阶段 / 变体都是整片级开关：调用方只改 current / order 时
                    # 传进来的 doc 往往不带它们，按默认值覆盖会把用户选的二采、
                    # 「用二采原片」冲掉。没显式给就保留库里现有的值。
                    row = conn.execute(
                        "SELECT value FROM meta WHERE key=?", (k,)).fetchone()
                    _def = _CHAIN_DEFAULTS.get(k)
                    items.append((k, _jloads(row[0], _def) if row is not None
                                  else _def))
                else:
                    items.append((k, _CHAIN_DEFAULTS.get(k)))
            _meta_set_many(conn, items)
            if conn.execute("SELECT value FROM meta WHERE key='created_at'").fetchone() is None:
                _meta_set(conn, "created_at", now)
            _meta_set(conn, "updated_at", now)
            # 顺序同步到 shots.ord（标量查询列；order 本身以 meta 为权威）
            order = [str(c) for c in (data.get("order") or []) if c]
            for i, cid in enumerate(order):
                conn.execute("UPDATE shots SET ord=? WHERE cid=?", (i, cid))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return "db"


# --------------------------------------------------------------------------
# 段文档（clip dict）
# --------------------------------------------------------------------------

def load_clip_doc(d, cid):
    """从库拼出与旧 clip_XXXX.json 同构的 dict（含 state）。没有返回 None。"""
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        row = conn.execute("SELECT * FROM shots WHERE cid=?", (str(cid),)).fetchone()
        if row is None:
            return None
        meta = _jloads(row["meta_json"], {})
        if not isinstance(meta, dict):
            meta = {}
        # 标量列回填（以列为地面真相，meta_json 只作兜底）
        meta["id"] = str(cid)
        meta["shot"] = row["shot_uid"] or meta.get("shot", "")
        meta["name"] = row["name"] or meta.get("name", "")
        meta["frames"] = int(row["frames"] or meta.get("frames", 0) or 0)
        meta["locked"] = bool(row["locked"])
        meta["pending"] = row["pending"]
        meta["updated"] = row["updated_at"] or meta.get("updated")
        srow = conn.execute("SELECT state_json FROM shot_state WHERE cid=?",
                            (str(cid),)).fetchone()
        if srow is not None:
            st = _jloads(srow["state_json"], None)
            if st is not None:
                meta["state"] = st
        return meta


def save_clip_doc(d, cid, meta):
    """段文档落库。state 抽进 shot_state（高频小表，防抖整包写不污染全量），
    其余字段进 shots.meta_json + 标量列。"""
    conn = _connect(d, create=True)
    cid = str(cid)
    now = time.time()
    doc = dict(meta or {})
    state = doc.pop("state", None)
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            existed = conn.execute("SELECT 1 FROM shots WHERE cid=?", (cid,)).fetchone()
            shot_uid = str(doc.get("shot") or "")
            name = str(doc.get("name") or "")
            frames = int(doc.get("frames") or 0)
            locked = 1 if doc.get("locked") else 0
            pending = doc.get("pending")
            ord_val = int(doc.get("index") or 0) - 1
            if ord_val < 0:
                # 没带 index 就按当前 order 位置
                order = _meta_get(conn, "order", []) or []
                ord_val = order.index(cid) if cid in order else 0
            if existed:
                conn.execute(
                    "UPDATE shots SET ord=?,shot_uid=?,name=?,frames=?,locked=?,"
                    "pending=?,updated_at=?,meta_json=? WHERE cid=?",
                    (ord_val, shot_uid, name, frames, locked, pending,
                     now, _jdumps(doc), cid))
            else:
                conn.execute(
                    "INSERT INTO shots(cid,ord,shot_uid,name,frames,locked,pending,"
                    "created_at,updated_at,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (cid, ord_val, shot_uid, name, frames, locked, pending,
                     now, now, _jdumps(doc)))
            if state is not None:
                conn.execute(
                    "INSERT INTO shot_state(cid,state_json,updated_at) VALUES(?,?,?) "
                    "ON CONFLICT(cid) DO UPDATE SET state_json=excluded.state_json,"
                    "updated_at=excluded.updated_at",
                    (cid, _jdumps(state), now))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return "db"


def delete_clip_doc(d, cid):
    """删段：shots 级联清掉 state / rack_slots / versions / files。"""
    conn = _connect(d, create=False)
    if conn is None:
        return False
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute("DELETE FROM shots WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM shot_state WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM rack_slots WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM rack_refs WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM shot_versions WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM run_receipts WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM segment_bindings WHERE cid=?", (str(cid),))
            conn.execute("DELETE FROM files WHERE cid=?", (str(cid),))
            conn.commit()
            return cur.rowcount > 0
        except Exception:
            conn.rollback()
            raise


def all_clip_cids(d):
    conn = _connect(d, create=False)
    if conn is None:
        return []
    with _lock_for(d):
        # 以 meta.order 为权威，没有则按 ord 列
        order = _meta_get(conn, "order", []) or []
        if order:
            return [str(c) for c in order]
        return [r[0] for r in conn.execute(
            "SELECT cid FROM shots ORDER BY ord, cid").fetchall()]


# --------------------------------------------------------------------------
# 中央生成回执（prompt_id → cid/take/latent/segment/whole）
# --------------------------------------------------------------------------

def save_run_receipt(d, rec):
    """保存一次执行的中央回执。prompt_id 是主键，cid/take 是归属。"""
    conn = _connect(d, create=True)
    prompt_id = str(rec.get("prompt_id") or "")
    if not prompt_id:
        raise ValueError("run receipt 缺少 prompt_id")
    cid = str(rec.get("cid") or "")
    if not cid:
        raise ValueError("run receipt 缺少 cid")
    take = int(rec.get("take") or 1)
    now = time.time()
    created = float(rec.get("created_at") or now)
    segment = rec.get("segment_film") or {}
    whole = rec.get("whole_film") or {}
    detail = rec.get("detail") or {}
    status = str(rec.get("status") or "adopted")
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO run_receipts(
                    prompt_id,cid,take,latent_path,cont_path,
                    segment_film,whole_film,detail_json,status,
                    created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(prompt_id) DO UPDATE SET
                    cid=excluded.cid,
                    take=excluded.take,
                    latent_path=excluded.latent_path,
                    cont_path=excluded.cont_path,
                    segment_film=excluded.segment_film,
                    whole_film=excluded.whole_film,
                    detail_json=excluded.detail_json,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (prompt_id, cid, take,
                 rec.get("latent_path"), rec.get("cont_path"),
                 _jdumps(segment), _jdumps(whole), _jdumps(detail),
                 status, created, now))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {"prompt_id": prompt_id, "cid": cid, "take": take, "status": status}


def _row_to_run_receipt(row):
    out = {
        "prompt_id": row["prompt_id"],
        "cid": row["cid"],
        "take": row["take"],
        "latent_path": row["latent_path"],
        "cont_path": row["cont_path"],
        "segment_film": _jloads(row["segment_film"], {}),
        "whole_film": _jloads(row["whole_film"], {}),
        "detail": _jloads(row["detail_json"], {}),
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    return out


def load_run_receipt(d, prompt_id):
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        row = conn.execute("SELECT * FROM run_receipts WHERE prompt_id=?",
                           (str(prompt_id),)).fetchone()
        return _row_to_run_receipt(row) if row else None


def list_run_receipts(d, limit=100, cid=None):
    conn = _connect(d, create=False)
    if conn is None:
        return []
    limit = max(1, min(int(limit or 100), 1000))
    with _lock_for(d):
        if cid:
            rows = conn.execute(
                "SELECT * FROM run_receipts WHERE cid=? "
                "ORDER BY updated_at DESC LIMIT ?",
                (str(cid), limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM run_receipts ORDER BY updated_at DESC LIMIT ?",
                (limit,)).fetchall()
        return [_row_to_run_receipt(r) for r in rows]


# --------------------------------------------------------------------------
# 中央段绑定回执（cid → shot_uid/state/rack/desk）
# --------------------------------------------------------------------------

def save_segment_binding(d, binding):
    """保存一次新增/插入/复制段的三节点绑定回执。"""
    conn = _connect(d, create=True)
    cid = str(binding.get("cid") or "")
    if not cid:
        raise ValueError("缺少 cid")
    shot_uid = str(binding.get("shot_uid") or "")
    if not shot_uid:
        raise ValueError("缺少 shot_uid")
    action = str(binding.get("action") or "append")
    source_cid = str(binding.get("source_cid") or "")
    state = binding.get("state") if binding.get("state") is not None else {}
    rack = binding.get("rack") if binding.get("rack") is not None else {}
    desk_text = str(binding.get("desk_text") or "")
    status = str(binding.get("status") or "bound")
    now = time.time()
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT created_at, desk_rev FROM segment_bindings WHERE cid=?",
                (cid,)).fetchone()
            created_at = row["created_at"] if row else now
            old_rev = (int(row["desk_rev"] or 0)
                       if row and "desk_rev" in row.keys() else 0)
            # 版本号**不许被同步路径打回 0**：sync_segment_binding 只是把
            # 投影刷新一遍，它不是一次"用户改词"，凭什么重置乐观锁？
            # 调用方不显式给 rev 就继承旧值；只有 put_segment_text 才 +1。
            desk_rev = binding.get("desk_rev")
            desk_rev = old_rev if desk_rev is None else int(desk_rev)
            conn.execute(
                """
                INSERT INTO segment_bindings(
                    cid,shot_uid,action,source_cid,state_json,rack_json,
                    desk_text,desk_rev,status,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(cid) DO UPDATE SET
                    shot_uid=excluded.shot_uid,
                    action=excluded.action,
                    source_cid=excluded.source_cid,
                    state_json=excluded.state_json,
                    rack_json=excluded.rack_json,
                    desk_text=excluded.desk_text,
                    desk_rev=excluded.desk_rev,
                    status=excluded.status,
                    updated_at=excluded.updated_at
                """,
                (cid, shot_uid, action, source_cid, _jdumps(state),
                 _jdumps(rack), desk_text, desk_rev, status, created_at, now))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {"cid": cid, "shot_uid": shot_uid, "action": action,
            "source_cid": source_cid, "status": status, "desk_rev": desk_rev}


def _row_to_segment_binding(row):
    return {
        "cid": row["cid"],
        "shot_uid": row["shot_uid"],
        "action": row["action"],
        "source_cid": row["source_cid"],
        "state": _jloads(row["state_json"], {}),
        "rack": _jloads(row["rack_json"], {}),
        "desk_text": row["desk_text"],
        "desk_rev": int(row["desk_rev"] or 0) if "desk_rev" in row.keys() else 0,
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def load_segment_binding(d, cid):
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        row = conn.execute("SELECT * FROM segment_bindings WHERE cid=?",
                           (str(cid),)).fetchone()
        return _row_to_segment_binding(row) if row else None


def list_segment_bindings(d, limit=100):
    conn = _connect(d, create=False)
    if conn is None:
        return []
    limit = max(1, min(int(limit or 100), 1000))
    with _lock_for(d):
        rows = conn.execute(
            "SELECT * FROM segment_bindings ORDER BY updated_at DESC LIMIT ?",
            (limit,)).fetchall()
    return [_row_to_segment_binding(r) for r in rows]


def _desk_text_of(d, cid):
    """从中央 desk 取某一段的段词（拿不到给空串，绝不抛）。"""
    desk = load_desk(d)
    if not isinstance(desk, dict):
        return ""
    segs = desk.get("segs")
    if not isinstance(segs, dict):
        return ""
    t = segs.get(str(cid))
    return str(t) if t is not None else ""


# [单一真值] 真值 → 镜像 的**唯一**方向。镜像（desk.segs）永远不许反向改真值。
def _mirror_desk_seg(d, cid, text, desk=None):
    """把**版本化真值**单向回写到 desk 整包的 segs 镜像（只写不读真值）。

    desk.segs 从今天起是**投影**：老路径（整包读 / 导出 / 老前端 / 换机器
    看档案）靠它看段词，而真值在 segment_bindings.desk_text + desk_rev。
    方向只允许 真值 → 镜像，镜像永远不许反向改真值（sync_segment_binding
    里那条"版本化过就以列为准"就是守住这个方向）。

    `desk` 可以传入**已经读好的**整包（调用方手上有就别再读一遍）——
    段词是打字路径，一次按键就要走一遭，整包 JSON 的读写次数直接决定
    后端手感。返回写好的整包（失败返回 None），调用方接着用，别再读。
    """
    try:
        if not isinstance(desk, dict):
            desk = load_desk(d)
        if not isinstance(desk, dict):
            desk = {}
        desk = dict(desk)
        segs = desk.get("segs")
        segs = dict(segs) if isinstance(segs, dict) else {}
        segs[str(cid)] = "" if text is None else str(text)
        desk["segs"] = segs
        save_desk(d, desk)
        return desk
    except Exception as e:
        # 镜像写失败**不能**判成真值写失败：真值已经在库里，镜像后补即可。
        print("[H3 Store] desk 镜像回写失败（真值已落库）：", e)
        return None


def seg_text_of(d, cid, fallback_mirror=True):
    """读某一段的**段词真值**（20261031 · 单一真值收口，执行层入口）。

    以前执行层（`csglide_desk.compose`）读的是 `desk.segs` —— 那是**投影**，
    而且判据是"提交里没这个键才问库"，等于把后端的正确性押在"前端永远不会
    写出空键"这个隐式契约上（前端一旦又写出一个空键，兜底就静默失效，段词
    当场变空 —— 20261030 就是这个形状）。

    现在一律读真值列 `segment_bindings.desk_text`：
      · binding 在 → 直接用（真值）；
      · binding 不在 → `sync_segment_binding` 现场补建（老工程自愈）；
      · 连补建都做不到（孤儿段 / JSON 老工程 / 没库）→ 才退回投影兜底。
    方向始终是 真值 → 投影，绝不反过来。
    """
    cid = str(cid or "")
    if not cid:
        return ""
    b = load_segment_binding(d, cid)
    if b is None:
        try:
            b = sync_segment_binding(d, cid)
        except Exception:
            b = None
    if b:
        return str(b.get("desk_text") or "")
    return _desk_text_of(d, cid) if fallback_mirror else ""


# [单一真值] 段词的**唯一**写入口。真值 = segment_bindings.desk_text + desk_rev；
# desk.segs 只是投影（方向只能 真值→镜像）。整包保存已不带 segs。
# 改动前必读 docs/段词单一真值-改造方案.md，并跑 tests/py/_selftest_segcontract.py。
def put_segment_text(d, cid, text, base_rev=None, allow_empty=False, desk=None):
    """**段词唯一的写入口**（A+ 方案：乐观锁 / 版本号）。

    `desk` 可选：调用方手上已有的整包（省一次读）。成功时回包里也会带上
    写好的 `desk`，调用方接着用，别再读一遍。


    返回 dict（调用方一律先看 `conflict`）：
      · {"ok": True,  "rev": n}                           写进去了
      · {"ok": True,  "rev": n, "unchanged": True}        内容一样，没动
      · {"ok": True,  "rev": n, "skipped": True, "text": 真值}
                                                          空串防抹，保住了库里的
      · {"ok": False, "conflict": True, "rev": n, "text": 真值}
                                                          你手上这份过期了
      · {"ok": False, "error": "..."}                     真失败（没库等）

    三条铁律：
    1. **只有内容真变了才 bump rev**。同一段被反复推同一个词是常态（切段
       风暴 / 后端回声 / 防抖重发），那些不是"别人改过"，不该制造 409。
       409 的唯一含义是：中央的真值在你上次读之后被别人动过。
    2. **base_rev=None = 不看版本硬写**。升级过渡期和没有 rev 概念的调用方
       仍能写，但中央照样 bump，下一次带 rev 的写就会老实撞上。
    3. **空串不抹真值**（沿用老契约）：真要清空必须显式 allow_empty=1。
    """
    cid = str(cid or "")
    if not cid:
        return {"ok": False, "error": "缺少 cid"}
    # __new__ 是前端「新段还没从档案拿到 clip」时的**本地占位**，不是一个段。
    # 放它进中央，同一段就有了两个身份，孤儿键就是这么来的（铁律 4）。
    # 前端 pushSegText 已挡一道，这里再挡一道：写入口是公开 Python API，
    # 正确性不该取决于「调用方会不会传」。
    if cid.startswith("__new__"):
        return {"ok": False, "error": "临时键不是段身份，拒绝写入：" + cid}
    conn = _connect(d, create=True)
    if conn is None:
        return {"ok": False, "error": "没有状态库（老工程）"}
    txt = "" if text is None else str(text)
    # 段还没登记（新段）时先现场补建一行 —— 有 shot_uid 就能建出来，
    # 建出来才有版本号可锁。
    if load_segment_binding(d, cid) is None:
        try:
            sync_segment_binding(d, cid)
        except Exception:
            pass
    res = None
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT desk_text, desk_rev FROM segment_bindings WHERE cid=?",
                (cid,)).fetchone()
            if row is None:
                # 孤儿段（没绑 shot_uid）：没法进 binding，退回只写镜像，
                # rev=0 = "这一份没版本保护"。宁可没锁，也不能写不进去。
                conn.execute("ROLLBACK")
                md = _mirror_desk_seg(d, cid, txt, desk=desk)
                res = {"ok": md is not None, "rev": 0, "unversioned": True}
                if md is not None:
                    res["desk"] = md
                return res
            cur_text = str(row["desk_text"] or "")
            cur_rev = int(row["desk_rev"] or 0) if "desk_rev" in row.keys() else 0
            if base_rev is not None and int(base_rev) != cur_rev:
                conn.execute("ROLLBACK")
                return {"ok": False, "conflict": True, "rev": cur_rev,
                        "text": cur_text}
            if not txt and not allow_empty and cur_text:
                conn.execute("ROLLBACK")
                return {"ok": True, "rev": cur_rev, "skipped": True,
                        "text": cur_text}
            if txt == cur_text:
                # 内容没变就**不 bump**：否则每次回声都制造一次伪冲突。
                conn.execute("ROLLBACK")
                return {"ok": True, "rev": cur_rev, "unchanged": True}
            new_rev = cur_rev + 1
            conn.execute(
                "UPDATE segment_bindings SET desk_text=?, desk_rev=?, "
                "updated_at=? WHERE cid=?", (txt, new_rev, time.time(), cid))
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return {"ok": False, "error": str(e)}
    # 镜像在事务外写：save_desk 自己会 commit，套在 BEGIN IMMEDIATE 里
    # 会把上面那次更新一起提交掉（甚至回滚掉）。
    md = _mirror_desk_seg(d, cid, txt, desk=desk)
    out = {"ok": md is not None, "rev": new_rev}
    # 回传写好的整包：调用方（路由）接着用它补 global / chain、喂给
    # sync_segment_binding，不要再读一遍 —— 打字路径一次按键走一遭。
    if md is not None:
        out["desk"] = md
    return out


def _merge_desk(old, incoming, allow_empty=False, live_cids=None):
    """整包写也**不能**把用户真写过的段词抹成空串（最后一道防线）。

    前端内存里某个 cid 是空（切段竞态 / 刚 hydrate / 新段还没写词）是常态，
    整包覆盖一发，中央里那段真写过的词就没了 —— 这正是 20261015「刷新页面
    后第二段词消失」的成形路径。所以整包写也要逐段比对：
      · 前端给空、库里有货、又没显式 allow_empty → 保住库里的；
      · 库里有、前端压根没带的段 → 一律保留（前端只装了部分段是常态）。
    """
    out = dict(incoming or {})
    osegs = old.get("segs") if isinstance(old.get("segs"), dict) else {}
    isegs = out.get("segs")
    if isinstance(isegs, dict):
        merged = {}
        for cid, t in isegs.items():
            cid = str(cid)
            t = "" if t is None else str(t)
            if not t and not allow_empty and str(osegs.get(cid) or ""):
                merged[cid] = str(osegs.get(cid))
            else:
                merged[cid] = t
        for cid, t in osegs.items():
            cid = str(cid)
            if cid not in merged:
                merged[cid] = str(t or "")
        # 垃圾键清理：Ctrl+Z（ComfyUI 画布撤销）会把整个 graph 回滚重建，
        # 三个节点的 desk_data widget 跟着回到旧版本 —— 带着一堆早已删掉的
        # 段的 uid 键，再整包 commit 就把它们全写回中央（清一次复活一次）。
        # 只丢"三无"键：不在册 + 值是空 + 库里也没货。有内容的孤儿一律留着
        # （可能是用户正在编辑、还没登记进 order 的新段，宁可多留不能误删）。
        # 临时键（前端 __new__ 前缀：新段还没从档案拿到 clip 时的本地占位）
        # **一律丢**：它按定义就不是一个段，上面那条"有内容的孤儿留着"不适用
        # —— 留着它，同一段就有了两个身份，孤儿键就是这么来的。
        for cid in list(merged.keys()):
            if str(cid).startswith("__new__"):
                merged.pop(cid, None)
        if live_cids is not None:
            live = set(str(c) for c in live_cids)
            for cid in list(merged.keys()):
                if cid in live:
                    continue
                if str(merged.get(cid) or ""):
                    continue
                if str(osegs.get(cid) or ""):
                    continue
                merged.pop(cid, None)
        out["segs"] = merged
    elif osegs:
        out["segs"] = {str(k): str(v or "") for k, v in osegs.items()}
    if not str(out.get("global") or "") and str(old.get("global") or ""):
        out["global"] = str(old.get("global"))
    return out


def sync_segment_binding(d, cid, action=None, source_cid=None, desk=None):
    """把某段的**当前真相**聚合回 segment_bindings（B1 的核心一步）。

    segment_bindings 不是"创建那一刻的出生快照"，而是"这一段的活档案"：
    导演台状态改了、媒体架换素材了、文案台改词了，都得把它刷新一遍。

    之前只在 bind_segment（新建段）时写过一次，之后就再没人刷新 —— 于是
    它几秒后就过期，前端不敢信它，只能退回各自的内存副本（rack 的
    ui.st.segs / desk 的 st.segs / cast 的 shots[].state）去"猜当前段"。
    三份内存 + 中央一份 = 四份真相，20261015 那一整串"素材串段 / 提示词
    被清空 / 刷新后段词消失"全都从这里长出来。

    契约：凡写过 rack / desk / clip 的地方，末尾都要调一次这里。
    """
    cid = str(cid or "")
    if not cid:
        return None
    if backend(d) != "db":
        return None
    clip = load_clip_doc(d, cid) or {}
    shot_uid = str(clip.get("shot") or "")
    if not shot_uid:
        # 没绑 shot_uid 的孤儿段（老数据）：save_segment_binding 会拒，跳过。
        return None
    old = load_segment_binding(d, cid) or {}
    old_text = str(old.get("desk_text") or "")
    old_rev = int(old.get("desk_rev") or 0)
    # `desk` 是调用方手上已有的整包（刚写过段词的那次调用一定有）—— 传进来
    # 就别再整包读一遍。段词是打字路径，省这一次是实打实的手感。
    if isinstance(desk, dict):
        _msegs = desk.get("segs") if isinstance(desk.get("segs"), dict) else {}
        _mt = _msegs.get(str(cid))
        mirror = str(_mt) if _mt is not None else ""
    else:
        mirror = _desk_text_of(d, cid)
    if old_rev > 0 and mirror != old_text:
        # 镜像（desk.segs）被**版本化真值之外**的路径动过：老工程遗留 / 外部
        # 脚本 / 升级前那几次整包覆盖。真值在列里 —— 反手把镜像掰回来，
        # **绝不让投影反向覆盖真值**（那正是"刷新后段词没了 / 两段词串了"
        # 的成形路径）。rev=0 表示这一行还没版本化，此时以镜像为准做一次性
        # 收养，之后就归列管。
        _mirror_desk_seg(d, cid, old_text)
        desk_text = old_text
    else:
        desk_text = mirror
    binding = {
        "cid": cid,
        "shot_uid": shot_uid,
        "action": action or old.get("action") or "append",
        "source_cid": source_cid or old.get("source_cid") or "",
        "state": clip.get("state") or {},
        "rack": load_rack(d, cid) or {"slots": {"images": [], "videos": [],
                                                "audios": []},
                                      "fps": 0, "audio_out": 0},
        "desk_text": desk_text,
        "desk_rev": old_rev,
        "status": old.get("status") or "bound",
    }
    save_segment_binding(d, binding)
    return binding


def delete_segment_binding(d, cid):
    """删段：把它的绑定回执一并清掉（delete_clip_doc 已级联，这里给外部用）。"""
    conn = _connect(d, create=False)
    if conn is None:
        return False
    with _lock_for(d):
        cur = conn.execute("DELETE FROM segment_bindings WHERE cid=?", (str(cid),))
        conn.commit()
        return cur.rowcount > 0


# --------------------------------------------------------------------------
# 媒体架段槽位（rack）
# --------------------------------------------------------------------------

def load_rack(d, cid):
    """读某段媒体架：{slots:{images,videos,audios}, fps,audio_out}。
    没写过返回 None（前端据此不覆盖内存里的现状）。"""
    conn = _connect(d, create=False)
    if conn is None:
        return None
    cid = str(cid)
    with _lock_for(d):
        # 权威判定：谁写得新听谁的。旧版本（还没重启的 ComfyUI）只写
        # rack_slots —— 迁移完若不重启就摆素材，槽位时间会新于引用，这时退回
        # 整段槽位读，用户摆的东西不会「存进去了却读不出来」。
        ts_slot = conn.execute(
            "SELECT MAX(updated_at) FROM rack_slots WHERE cid=?",
            (cid,)).fetchone()[0] or 0
        ts_ref = conn.execute(
            "SELECT MAX(updated_at) FROM rack_refs WHERE cid=?",
            (cid,)).fetchone()[0] or 0
        rows = []
        if ts_ref and ts_ref >= ts_slot:
            rows = conn.execute(
                "SELECT r.kind, r.slot_idx, p.file AS file, p.params AS params "
                "FROM rack_refs r LEFT JOIN asset_pool p ON p.alias = r.alias "
                "WHERE r.cid=? ORDER BY r.kind, r.slot_idx", (cid,)).fetchall()
            if not any((r["file"] or "") for r in rows):
                rows = []   # 池被清空之类的异常：宁可退回槽位，也不出空架
        if not rows:
            # 老工程 / 还没迁移：退回整段槽位自读，返回格式与上面完全一致。
            rows = conn.execute(
                "SELECT kind,slot_idx,file,params FROM rack_slots WHERE cid=? "
                "ORDER BY kind,slot_idx", (cid,)).fetchall()
            if not rows:
                return None
        slots = {"images": [], "videos": [], "audios": []}
        maxidx = {"images": -1, "videos": -1, "audios": -1}
        for r in rows:
            kind = r["kind"] if r["kind"] in slots else "images"
            item = _jloads(r["params"], {})
            if not isinstance(item, dict):
                item = {}
            if r["file"]:
                item["file"] = r["file"]
            slots[kind].append((r["slot_idx"], item))
            maxidx[kind] = max(maxidx[kind], r["slot_idx"])
        out = {"images": [None] * 0, "videos": [], "audios": []}
        for kind in ("images", "videos", "audios"):
            arr = [None] * (maxidx[kind] + 1)
            for idx, item in slots[kind]:
                arr[idx] = item
            out[kind] = arr
        return {"slots": out,
                "fps": _meta_get(conn, "rack.fps", 0) or 0,
                "audio_out": _meta_get(conn, "rack.audio_out", 0) or 0}


def save_rack(d, cid, rack):
    """整段替换某段槽位：素材进池、段只存引用，并同步 rack_slots 镜像。

    file 只写进 asset_pool 一份；rack_refs 记「这段第几格用了哪个名字」，读的
    时候 JOIN 池展开。换一张图改池里一行，引用它的段全都跟着变。
    rack_slots 仍整段重写一遍，作为老代码 / 外部脚本的镜像 —— 本模块不再读它，
    它落后于池也不会影响任何读取结果。
    """
    conn = _connect(d, create=True)
    cid = str(cid)
    now = time.time()
    slots = (rack or {}).get("slots") or {}
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM rack_slots WHERE cid=?", (cid,))
            conn.execute("DELETE FROM rack_refs WHERE cid=?", (cid,))
            rows, refs = [], []
            for kind in ("images", "videos", "audios"):
                for idx, item in enumerate(slots.get(kind) or []):
                    if not item:
                        continue
                    if not isinstance(item, dict):
                        continue
                    it = dict(item)
                    f = str(it.pop("file", "") or "")
                    key = _asset_key(item, kind, idx)
                    # 同名素材整片只有一份：后写的一次生效（最新的便是权威）。
                    conn.execute(
                        "INSERT INTO asset_pool(alias,kind,file,params,updated_at) "
                        "VALUES(?,?,?,?,?) ON CONFLICT(alias) DO UPDATE SET "
                        "kind=excluded.kind, file=excluded.file, "
                        "params=excluded.params, updated_at=excluded.updated_at",
                        (key, kind, f, _jdumps(it), now))
                    refs.append((cid, kind, idx, key, now))
                    rows.append((cid, kind, idx, f, _jdumps(it), now))
            conn.executemany(
                "INSERT INTO rack_slots(cid,kind,slot_idx,file,params,updated_at) "
                "VALUES(?,?,?,?,?,?)", rows)
            conn.executemany(
                "INSERT INTO rack_refs(cid,kind,slot_idx,alias,updated_at) "
                "VALUES(?,?,?,?,?)", refs)
            if (rack or {}).get("fps") is not None:
                _meta_set(conn, "rack.fps", rack.get("fps"))
            if (rack or {}).get("audio_out") is not None:
                _meta_set(conn, "rack.audio_out", rack.get("audio_out"))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return True


def load_all_racks(d):
    """工程内所有段的架况（rehydrate 一次拉全）。"""
    conn = _connect(d, create=False)
    if conn is None:
        return {}
    with _lock_for(d):
        cids = [r[0] for r in conn.execute(
            "SELECT DISTINCT cid FROM rack_refs "
            "UNION SELECT DISTINCT cid FROM rack_slots").fetchall()]
    return {cid: load_rack(d, cid) for cid in cids}


# --------------------------------------------------------------------------
# 素材池（asset_pool）：一部片子的素材只存一份
# --------------------------------------------------------------------------

def load_pool(d):
    """素材池全量：{alias: {"kind":…, "file":…, "params":…}}。"""
    conn = _connect(d, create=False)
    if conn is None:
        return {}
    with _lock_for(d):
        rows = conn.execute(
            "SELECT alias,kind,file,params FROM asset_pool ORDER BY alias").fetchall()
    out = {}
    for r in rows:
        it = _jloads(r["params"], {})
        if not isinstance(it, dict):
            it = {}
        it["file"] = r["file"]
        out[r["alias"]] = {"kind": r["kind"], "file": r["file"], "params": it}
    return out


def set_asset_file(d, alias, file):
    """换图：改池里一行，引用它的段全部跟着变（含 rack_slots 镜像）。

    返回被刷新的段数；池里没有这个名字返回 0（不凭空造条目）。
    """
    conn = _connect(d, create=True)
    now = time.time()
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "UPDATE asset_pool SET file=?, updated_at=? WHERE alias=?",
                (str(file or ""), now, str(alias)))
            if cur.rowcount == 0:
                conn.commit()
                return 0
            conn.execute(
                "UPDATE rack_slots SET file=?, updated_at=? WHERE rowid IN ("
                "  SELECT s.rowid FROM rack_slots s JOIN rack_refs r"
                "    ON r.cid=s.cid AND r.kind=s.kind AND r.slot_idx=s.slot_idx"
                "  WHERE r.alias=?)", (str(file or ""), now, str(alias)))
            n = conn.execute(
                "SELECT COUNT(DISTINCT cid) FROM rack_refs WHERE alias=?",
                (str(alias),)).fetchone()[0]
            conn.commit()
            return int(n or 0)
        except Exception:
            conn.rollback()
            raise


def migrate_rack_to_pool(d):
    """一次性迁移：把已有 rack_slots 抽成素材池 + 段引用（幂等，可重复跑）。

    已存在的池条目用 INSERT OR IGNORE 保留（不覆盖用户后来改过的 file）；
    引用行用 REPLACE 对齐最新槽位。返回 {"pool": 新增条数, "refs": 写入条数}。
    """
    conn = _connect(d, create=True)
    now = time.time()
    with _lock_for(d):
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                "SELECT cid,kind,slot_idx,file,params,updated_at FROM rack_slots "
                "ORDER BY cid,kind,slot_idx").fetchall()
            n_pool = n_ref = 0
            for r in rows:
                it = _jloads(r["params"], {})
                if not isinstance(it, dict):
                    it = {}
                key = _asset_key(dict(it, file=r["file"]), r["kind"], r["slot_idx"])
                cur = conn.execute(
                    "INSERT OR IGNORE INTO asset_pool(alias,kind,file,params,updated_at)"
                    " VALUES(?,?,?,?,?)",
                    (key, r["kind"], r["file"], _jdumps(it), r["updated_at"] or now))
                n_pool += cur.rowcount
                conn.execute(
                    "INSERT OR REPLACE INTO rack_refs(cid,kind,slot_idx,alias,updated_at)"
                    " VALUES(?,?,?,?,?)",
                    (r["cid"], r["kind"], r["slot_idx"], key, r["updated_at"] or now))
                n_ref += 1
            conn.commit()
            return {"pool": n_pool, "refs": n_ref}
        except Exception:
            conn.rollback()
            raise


# --------------------------------------------------------------------------
# 文案台（desk）
# --------------------------------------------------------------------------

def load_desk(d):
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        return _meta_get(conn, "desk", None)


def save_desk(d, desk):
    conn = _connect(d, create=True)
    with _lock_for(d):
        _meta_set(conn, "desk", desk or {})
        conn.commit()
    return True


# --------------------------------------------------------------------------
# 操作流水（events，只追加）
# --------------------------------------------------------------------------

def _fnv8(text):
    """8 位指纹（FNV-1a 32bit，对 **UTF-8 字节** 取值）。

    与前端 js/bz_prompt_build.js 的 fp32 **逐字一致** —— 这是刻意的：
    流水里 rack_save 的 img_fp/vid_fp/aud_fp 可以直接和编译回执的
    imgFp/vidFp/audFp 对照，"这次落库的素材"与"那次送出去的素材"是不是
    同一份，一个字符串比就知道，不用再肉眼比对文件名。
    对 UTF-8 取字节而不是取字符：否则 emoji 这类增补平面字符在 JS（UTF-16
    码元）与 Python（码点）之间会算出不同的值。"""
    h = 0x811C9DC5
    for b in str(text or "").encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return "%08x" % h


def _rack_fps(slots):
    """媒体架槽位指纹，三类各一个。规则与前端 rackSig 完全一致：
    **按位置**取文件名、转小写、空槽记 '-'、以 '|' 连接。

    按位置而不是"压缩掉空槽"：@图片N 是位置引用，第 3 槽空着和第 2 槽空着
    是两件不同的事，压掉就看不出差异了。"""
    out = {}
    try:
        for kind, key in (("images", "img_fp"), ("videos", "vid_fp"),
                          ("audios", "aud_fp")):
            arr = (slots or {}).get(kind) or []
            parts = []
            for x in arr:
                f = (x or {}).get("file") if isinstance(x, dict) else ""
                parts.append(os.path.basename(str(f)).lower() if f else "-")
            # 只裁尾部空槽（与前端 rackSig 同规则）：架面铺 9 格还是 2 格不该
            # 算出两个指纹；中间的缺口要保留，那是引用错位的证据。
            while parts and parts[-1] == "-":
                parts.pop()
            out[key] = _fnv8("|".join(parts))
    except Exception:
        out = {"img_fp": "", "vid_fp": "", "aud_fp": ""}
    return out


def _norm_words(t):
    """文本归一化 —— 与前端 js/bz_prompt_build.js 的 normWords **逐字同口径**。

    对账之所以要求逐字一致：两边只要差一个空格，同一段词就会算出两个指纹，
    于是每次渲染都报"漂移"，很快没人再看这个告警。所以这里的四步与前端
    严格一一对应，顺序都不能换：
        \\r\\n → \\n → 行内连续空格/制表符压成一个 → 三个以上换行压成两个 → trim
    """
    s = str(t or "").replace("\r\n", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _state_prompt(d, cid):
    """某段落档案里自带的 prompt（面板模式下的词源）。取不到给空串。"""
    conn = _connect(d, create=False)
    if conn is None:
        return ""
    with _lock_for(d):
        row = conn.execute("SELECT state_json FROM shot_state WHERE cid=?",
                           (str(cid),)).fetchone()
    if not row:
        return ""
    st = _jloads(row["state_json"], {})
    return str((st or {}).get("prompt") or "") if isinstance(st, dict) else ""


def seg_words(d, cid):
    """库里该段**真正会送出去的词**：片子级 + 本段，用换行连起来。

    口径与前端 bz_prompt_build.resolve 的 effWords、以及 csglide_desk.compose_text
    完全一致（两处都只做 normWords 再筛空串），否则"补齐"补进来的词和编译出的
    词长度就不一样了，对账立刻自相矛盾。

    补空专用：**只在该段提交里一个字都没有时**才拿它兜底。有值就不许覆盖 ——
    用户按下运行时看到的词就是他要的，库里更新的那份不能偷偷顶上去。
    """
    desk = load_desk(d) or {}
    segs = desk.get("segs") if isinstance(desk.get("segs"), dict) else {}
    g = _norm_words(desk.get("global"))
    t = _norm_words(segs.get(str(cid or "")))
    return "\n".join([x for x in (g, t) if x])


def seg_fps(d, cid):
    """该段在**库里**的内容指纹（只读真源，不碰任何前端缓存）。

    这是方案②的对账基石：前端编译时把"我送出去的是什么"算成指纹写进提交，
    后端拿库里的真值再算一遍，两边一比就知道「前端那份副本是不是过时的」。
    刻意用内容指纹而不是递增 rev：rev 被一次无意义的写操作碰一下就会变，
    指纹只在**内容真变了**才变，而且能指出分歧在词、在图还是在参数上。

    口径（必须与 js/bz_prompt_build.js 一致）：
        word        = FNV( [norm(global), norm(segs[cid])].filter(Boolean).join("\\n") )
        word_prompt = FNV( norm(state.prompt) )          ← 没接文案台时的词源
        img/vid/aud = _rack_fps(该段槽位)

    返回的项取不到时是空串而不是假值：空串表示"库这边说不清"，调用方一律
    跳过，绝不能把"我不知道"当成"你错了"。
    """
    out = {"word": "", "word_prompt": "", "img": "", "vid": "", "aud": ""}
    cid = str(cid or "")
    if not cid:
        return out
    try:
        desk = load_desk(d) or {}
        segs = desk.get("segs") if isinstance(desk.get("segs"), dict) else {}
        g = _norm_words(desk.get("global"))
        t = _norm_words(segs.get(cid))
        out["word"] = _fnv8("\n".join([x for x in (g, t) if x]))
        out["word_prompt"] = _fnv8(_norm_words(_state_prompt(d, cid)))
        fps = _rack_fps(((load_rack(d, cid) or {}).get("slots")) or {})
        out["img"] = fps.get("img_fp", "")
        out["vid"] = fps.get("vid_fp", "")
        out["aud"] = fps.get("aud_fp", "")
    except Exception:
        # 对账永远不能把渲染搞挂：库坏了就当"说不清"，返回空串让对方跳过。
        pass
    return out


def log_event(d, action, cid=None, payload=None, actor="backend"):
    """记一条操作流水，返回服务端单调 seq。库不存在（老工程）返回 None。"""
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        cur = conn.execute(
            "INSERT INTO events(ts,actor,action,cid,payload) VALUES(?,?,?,?,?)",
            (time.time(), str(actor or ""), str(action or ""),
             str(cid) if cid is not None else None,
             _jdumps(payload if payload is not None else {})))
        conn.commit()
        return cur.lastrowid


def list_events(d, limit=100, cid=None, action=None):
    conn = _connect(d, create=False)
    if conn is None:
        return []
    sql = "SELECT seq,ts,actor,action,cid,payload FROM events"
    where, args = [], []
    if cid:
        where.append("cid=?")
        args.append(str(cid))
    if action:
        where.append("action=?")
        args.append(str(action))
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY seq DESC LIMIT ?"
    args.append(int(limit or 100))
    with _lock_for(d):
        rows = [dict(x) for x in conn.execute(sql, args).fetchall()]
    rows.reverse()          # DESC 翻回时间正序（旧→新）
    for r in rows:
        r["payload"] = _jloads(r.get("payload"), {})
    return rows


# --------------------------------------------------------------------------
# 还原点（snapshots）
# --------------------------------------------------------------------------

def add_snapshot(d, label, shots_json, desk_json=None, cur_cid=None, idx=None,
                 source="auto", keep=0):
    """存一个还原点。

    keep>0 时只保留该 source 下**最新** keep 条（其余删掉）：撤销点是每次
    结构性操作都写一条的，不裁剪这张表会一路膨胀到几百上千行，而用户真正
    用得到的永远只有最后十来个。
    """
    conn = _connect(d, create=True)
    with _lock_for(d):
        cur = conn.execute(
            "INSERT INTO snapshots(label,source,shots_json,desk_json,cur_cid,idx,"
            "created_at) VALUES(?,?,?,?,?,?,?)",
            (str(label or ""), str(source or "auto"),
             shots_json if isinstance(shots_json, str) else _jdumps(shots_json),
             desk_json if isinstance(desk_json, str) else _jdumps(desk_json or {}),
             str(cur_cid) if cur_cid is not None else None,
             int(idx) if idx is not None else None, time.time()))
        sid = cur.lastrowid
        try:
            keep = int(keep or 0)
        except (TypeError, ValueError):
            keep = 0
        if keep > 0:
            conn.execute(
                "DELETE FROM snapshots WHERE source=? AND id NOT IN "
                "(SELECT id FROM snapshots WHERE source=? ORDER BY id DESC LIMIT ?)",
                (str(source or "auto"), str(source or "auto"), keep))
        conn.commit()
        return sid


def list_snapshots(d, limit=200, full=False, source=None):
    """还原点列表。

    full=True 才带 shots/desk 正文 —— 列表页只要标题和 id，撤销栈**回填**
    才要得着正文，一律带会把每个还原点的整份工程都拖出来（几 MB 级）。
    source 用来只看某一类（撤销栈镜像是 "undo"，手动存点是 "manual"）。
    """
    conn = _connect(d, create=False)
    if conn is None:
        return []
    limit = max(1, min(int(limit or 200), 1000))
    with _lock_for(d):
        if source:
            rows = conn.execute(
                "SELECT * FROM snapshots WHERE source=? ORDER BY id DESC LIMIT ?",
                (str(source), limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM snapshots ORDER BY id DESC LIMIT ?",
                (limit,)).fetchall()
    out = []
    for r in rows:
        item = {"id": r["id"], "label": r["label"], "source": r["source"],
                "cur_cid": r["cur_cid"], "idx": r["idx"],
                "created_at": r["created_at"]}
        if full:
            item["shots"] = _jloads(r["shots_json"], [])
            item["desk"] = _jloads(r["desk_json"], {})
        out.append(item)
    return out


def clear_snapshots(d, source=None):
    """清空还原点（不传 source = 全清）。"""
    conn = _connect(d, create=False)
    if conn is None:
        return 0
    with _lock_for(d):
        if source:
            cur = conn.execute("DELETE FROM snapshots WHERE source=?", (str(source),))
        else:
            cur = conn.execute("DELETE FROM snapshots")
        conn.commit()
        return cur.rowcount or 0


def get_snapshot(d, sid):
    conn = _connect(d, create=False)
    if conn is None:
        return None
    with _lock_for(d):
        r = conn.execute("SELECT * FROM snapshots WHERE id=?", (int(sid),)).fetchone()
    if r is None:
        return None
    out = dict(r)
    out["shots"] = _jloads(r["shots_json"], [])
    out["desk"] = _jloads(r["desk_json"], {})
    return out


def delete_snapshot(d, sid):
    conn = _connect(d, create=False)
    if conn is None:
        return False
    with _lock_for(d):
        cur = conn.execute("DELETE FROM snapshots WHERE id=?", (int(sid),))
        conn.commit()
        return cur.rowcount > 0


# --------------------------------------------------------------------------
# 全量工程（rehydrate）与健康检查
# --------------------------------------------------------------------------

def project_blob(d, name, clips_loader=None):
    """一次拉全量：片级文档 + 各段 clip（含 state）+ 全部 rack + desk。

    clips_loader(name)->list[dict]：由 csglide_chain 传入 summary()，保证与
    时间轴/film_summary 完全同构（含 broken 等派生字段的原始材料由前端自算）；
    不传时直接从库拼。
    """
    be = backend(d)
    if be != "db":
        return {"name": name, "backend": be or "none"}
    chain_doc = load_chain_doc(d, name) or {}
    if clips_loader is not None:
        loaded = clips_loader(name)
        # loader 传的是 csglide_chain.summary()，返回整片 dict，取其 clips 列表
        clips = loaded.get("clips") if isinstance(loaded, dict) else loaded
    else:
        clips = []
        for cid in all_clip_cids(d):
            m = load_clip_doc(d, cid)
            if m is not None:
                clips.append(m)
    # 音轨与 racks/desk 在同一张 meta 表、同一个工程库，随整包一起回前端。
    # 音频轴不再另发 /banzhang/audio/tracks，避免第二套恢复时序。
    # 共享连接由 store 自己管理，这里不 close。
    conn = _connect(d, create=False)
    audio_tracks = _meta_get(conn, "bzsa.tracks", []) if conn else []
    audio_layout = _meta_get(conn, "bzsa.layout", {}) if conn else {}
    return {
        "name": name,
        "backend": "db",
        "schema": SCHEMA_VERSION,
        "fps": chain_doc.get("fps", 24),
        "trim_frames": chain_doc.get("trim_frames", 22),
        "prompt_global": chain_doc.get("prompt_global", ""),
        "current": chain_doc.get("current"),
        "locked": bool(chain_doc.get("locked")),
        "order": chain_doc.get("order", []),
        "transitions": chain_doc.get("transitions", {}),
        "gen": chain_doc.get("gen", 0),
        "clips": clips,
        "racks": load_all_racks(d),
        "desk": load_desk(d),
        "audio": {"轨": audio_tracks if isinstance(audio_tracks, list) else [],
                  "布局": audio_layout if isinstance(audio_layout, dict) else {}},
    }


def health(d):
    """库完整性自检。"""
    be = backend(d)
    out = {"backend": be, "db": None, "ok": be != "db", "schema": None,
           "shots": 0, "events": 0, "snapshots": 0, "errors": []}
    if be != "db":
        out["ok"] = True          # 老工程/空工程不算病
        return out
    conn = _connect(d)
    out["db"] = db_path(d)
    with _lock_for(d):
        try:
            ic = conn.execute("PRAGMA integrity_check").fetchone()
            ok = bool(ic and ic[0] == "ok")
            out["ok"] = ok
            if not ok:
                out["errors"].append(str(ic[0]) if ic else "integrity_check failed")
            out["schema"] = conn.execute("PRAGMA user_version").fetchone()[0]
            out["shots"] = conn.execute("SELECT COUNT(*) FROM shots").fetchone()[0]
            out["events"] = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            out["snapshots"] = conn.execute(
                "SELECT COUNT(*) FROM snapshots").fetchone()[0]
        except Exception as e:
            out["ok"] = False
            out["errors"].append("%s: %s" % (type(e).__name__, e))
    return out


# 原 repath_db（改名后回写库里的旧绝对路径）已于 20261020 随方案 G 删除：
# 改名只改索引，目录不动，库里的路径全是相对/绝对到同一目录，不需要回写。
# 将来若真要做「物理搬目录」，可到 csglide_store.py.bak_gindex_20261020 找回。


# --------------------------------------------------------------------------
# HTTP 路由（/cglide/store/*）—— 与 csglide_chain 同风格，模块加载即注册
# --------------------------------------------------------------------------

def _json_response(obj, status=200):
    from aiohttp import web
    return web.json_response(obj, status=status)


def _chain_module():
    """取已加载的 csglide_chain 模块（包名含连字符，直接 import 的路径不保证，
    从 sys.modules 按后缀找最稳）。只用于借它的 ws_broadcast 发广播。"""
    import sys
    for _k, _m in sys.modules.items():
        if _k.endswith("csglide_chain") and hasattr(_m, "ws_broadcast"):
            return _m
    return None


def _broadcast(kind, name, **extra):
    """借 csglide_chain.ws_broadcast 发 WS 变更通知。ws_broadcast 是**同步**
    函数（内部 PromptServer.send_sync 同步发 JSON，且自带异常静默），路由
    协程在 await run_in_executor 之后已回到事件循环线程，直接调即可。"""
    try:
        _cc = _chain_module()
        if _cc:
            _cc.ws_broadcast(kind, name, **extra)
    except Exception:
        pass


def register_routes():
    """在 PromptServer 就绪后由 csglide_chain 调用（不能在模块 import 顶部注册：
    本模块被 csglide_chain 顶部 import 时，PromptServer.instance 可能尚未创建）。"""
    import asyncio
    from server import PromptServer

    def _store_dir(request, body=None, qname=None):
        name = qname
        if name is None and body is not None:
            name = body.get("name")
        if not name:
            name = request.query.get("name") if qname is None else qname
        return name, chain_dir(name)

    @PromptServer.instance.routes.get("/cglide/store/health")
    async def _route_store_health(request):
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        loop = asyncio.get_event_loop()
        h = await loop.run_in_executor(None, health, chain_dir(name))
        h["name"] = name
        return _json_response(h)

    @PromptServer.instance.routes.get("/cglide/store/project")
    async def _route_store_project(request):
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        import asyncio
        loop = asyncio.get_event_loop()

        def _build():
            # clips 走 chain.summary 保持同构（含实时磁盘探测字段）；
            # 包名含连字符，相对导入失败时从 sys.modules 兜底。
            cc = _chain_module()
            loader = getattr(cc, "summary", None)
            d = chain_dir(name)
            if ensure_db(d) != "db":
                # 老工程：不建库，回一个 json 后端标记，前端走老路径
                return {"name": name, "backend": "json"}
            return project_blob(d, name, loader)

        return _json_response(await loop.run_in_executor(None, _build))

    @PromptServer.instance.routes.post("/cglide/store/rack")
    async def _route_store_rack(request):
        import asyncio
        try:
            body = await request.json()
        except Exception:
            return _json_response({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = body.get("cid") or body.get("id")
        if not cid:
            return _json_response({"error": "缺少段落 id"}, 400)
        d = chain_dir(name)
        if ensure_db(d) != "db":
            return _json_response({"error": "老工程（JSON 档案）不支持状态库写入"}, 409)
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, save_rack, d, cid,
            {"slots": body.get("slots"), "fps": body.get("fps"),
             "audio_out": body.get("audio_out")})
        # B1：素材一换，这一段的"活档案"必须跟着换 —— 否则 binding 停在
        # 建段那一刻，前端读它就会拿到旧素材（「删掉的段又冒出来」的近亲）。
        await loop.run_in_executor(None, sync_segment_binding, d, cid)
        # 流水不能只记"有几个槽"——那既可能是空槽占位，也看不出"这次到底换成
        # 了哪几张图"。加 fp（与前端 rackSig 同口径）+ named（真放了文件的槽数）：
        # 事后翻流水就能回答"这一段第 3 张图是什么时候被换掉的"。
        _sl = body.get("slots") or {}
        def _named(k):
            return sum(1 for x in ((_sl.get(k) or []))
                       if isinstance(x, dict) and x.get("file"))
        await loop.run_in_executor(
            None, log_event, d, "rack_save", cid,
            {"images": len(_sl.get("images") or []),
             "videos": len(_sl.get("videos") or []),
             "audios": len(_sl.get("audios") or []),
             "named": {"images": _named("images"), "videos": _named("videos"),
                       "audios": _named("audios")},
             **_rack_fps(_sl)},
            "rack")
        _broadcast("rack_saved", name, clip=cid)
        return _json_response({"ok": True})

    @PromptServer.instance.routes.post("/cglide/store/desk")
    async def _route_store_desk(request):
        """写文案台。两种写法，互不干扰：

        1) **按段增量**（B1 起文案台走这条）：body 带 cid —— 只动那一段，
           别的段连碰都不碰。前端内存里别的段是空，也伤不到中央分毫。
        2) **整片覆盖**（兼容老路径）：body 带 desk —— 整包写。

        之前只有第 2 种：任何一个 cid 在前端内存里是空串，整包一写就把中央
        里**用户真写过的**段词抹成空 —— 这就是「刷新后第二段词没了」的另一
        半根因（前端 curKey 只修好了"写错段"，没修好"整片覆盖"）。

        空值保护：默认空串不覆盖已存词（防切段竞态把词清空）；前端在用户
        **真的**把词删空时显式带 allow_empty=1 才允许清空。
        """
        import asyncio
        try:
            body = await request.json()
        except Exception:
            return _json_response({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        d = chain_dir(name)
        if ensure_db(d) != "db":
            return _json_response({"error": "老工程（JSON 档案）不支持状态库写入"}, 409)
        loop = asyncio.get_event_loop()
        cid = str(body.get("cid") or body.get("id") or "")

        def _write():
            desk = load_desk(d) or {}
            if not isinstance(desk, dict):
                desk = {}
            live = all_clip_cids(d)
            put_res = None
            need_desk_write = True      # 整包分支永远要写
            if cid:
                # ---- 按段增量：段词走**唯一写入口** put_segment_text ----
                # 这里**不再**直接改 desk["segs"]：desk.segs 现在是投影，
                # 真值在 segment_bindings.desk_text + desk_rev。两条通道同时
                # 能写 segs，就是"整包旧副本盖掉刚写的词"的结构性根因。
                if "text" in body:
                    put_res = put_segment_text(
                        d, cid, body.get("text"),
                        base_rev=body.get("base_rev"),
                        allow_empty=bool(body.get("allow_empty")),
                        desk=desk)
                    if put_res.get("conflict"):
                        # 冲突 = 前端手上那份过期了。一个字都不许写，
                        # 把中央真值原样回给它，让它自己决定重来还是放弃。
                        return {"__conflict__": put_res}
                    # put 已经把镜像写好了，并把写好的整包回传 —— 直接用它，
                    # 不要再 load_desk 一遍（打字路径，整包读写次数 = 手感）。
                    if isinstance(put_res.get("desk"), dict):
                        desk = put_res["desk"]
                need_desk_write = ("global" in body) or isinstance(body.get("chain"), dict)
                if "global" in body:
                    g = body.get("global")
                    g = "" if g is None else str(g)
                    if g or body.get("allow_empty") or not desk.get("global"):
                        desk["global"] = g
                if isinstance(body.get("chain"), dict):
                    desk["chain"] = body.get("chain")
            else:
                incoming = body.get("desk")
                # 没带 desk（只带 cid/text 的增量请求误落到老后端）：**绝不能**
                # 把库写成空 —— save_desk(d, {}) 会把用户所有段的词一次清空。
                # 拿不到整包就原样写回，等于没动。
                if isinstance(incoming, dict) and incoming:
                    # 整包写先过 merge：空值不抹已存段词 + 丢掉三无垃圾键
                    # （画布撤销回滚 widget 会把已删段的 uid 键带回来）。
                    desk = _merge_desk(desk, incoming, bool(body.get("allow_empty")),
                                       live)
            if cid and not need_desk_write:
                # 只改段词的两道剪枝（实测：一次按键从 4读2写 5.2x 降到
                # 1读1写，再到这里剪掉 sync 后 ~1.5x）：
                # ① put_segment_text 已经把真值和镜像都写好了，这里**不许**再
                #    save_desk 一遍整包（10KB+ 的 JSON 白跑一趟）；
                # ② sync_segment_binding 会把 clip 的 state / rack 重新聚一遍
                #    再 UPSERT —— 可这次调用 state 和 rack 一行没动，它只会用
                #    同样的值再写一遍。它是剩下开销里最大的一块，跳过。
                #    真值已经在列里，镜像也同步了，sync 没别的事可做。
                return {"cid": cid, "desk_rev": (put_res or {}).get("rev")}
            save_desk(d, desk)
            # 段词一改，活档案跟着改 —— 前端下次 pull 拿到的就是新的。
            return sync_segment_binding(d, cid, desk=desk) if cid else None

        binding = await loop.run_in_executor(None, _write)
        if isinstance(binding, dict) and binding.get("__conflict__"):
            # 409 = 「你手上这份过期了」。前端收到它要**停下手里那次写**，
            # 用回包里的 text 刷新自己的内存，绝不能重发（重发还是撞）。
            c = binding["__conflict__"]
            await loop.run_in_executor(
                None, log_event, d, "desk_conflict", cid,
                {"base_rev": body.get("base_rev"), "rev": c.get("rev"),
                 "chars": len(str(c.get("text") or ""))}, "desk")
            return _json_response(
                {"ok": False, "conflict": True, "rev": c.get("rev"),
                 "text": c.get("text") or ""}, 409)
        # 段号优先用按段增量的 cid；整包写（只存 presets/alias/global 那类）没有
        # cid，就退回前端顺手带来的 cur_cid —— 留痕缺了段号，事后就追不到"是哪
        # 一段改的"（改之前 787 条里有 254 条 desk_save 是无段号的）。
        evt_cid = cid or str(body.get("cur_cid") or "") or None
        # 流水要能回答"这一段词是什么时候、被改成什么样的"。
        # 原来只有 {"seg": true} —— 787 条 desk_save 里没有一条带得动内容，
        # 出现「两段词一样」时根本查不到是哪一次写坏的。
        # chars/fp 是**要写进去的那份**（不是落库后的结果），配合相邻两条流水
        # 的 fp 变化，整段改动史就是一条可读的时间线。
        evt = {"seg": bool(evt_cid)}
        if "text" in body:
            _t = "" if body.get("text") is None else str(body.get("text"))
            evt["chars"] = len(_t)
            evt["fp"] = _fnv8(_t)
        if "global" in body:
            _g = "" if body.get("global") is None else str(body.get("global"))
            evt["g_chars"] = len(_g)
            evt["g_fp"] = _fnv8(_g)
        if isinstance(body.get("desk"), dict):
            _pk = body.get("desk") or {}
            evt["pack"] = True
            evt["segs"] = len(_pk.get("segs") or {})
        await loop.run_in_executor(None, log_event, d, "desk_save", evt_cid, evt, "desk")
        # rev 单独抬到顶层：前端拿它当"下一次写的 base_rev"，不用去 binding
        # 里翻（老前端不认 binding.desk_rev 也不影响，只是没锁而已）。
        _rev = (binding or {}).get("desk_rev") if isinstance(binding, dict) else None
        return _json_response({"ok": True, "binding": binding, "rev": _rev})

    @PromptServer.instance.routes.get("/cglide/store/segment")
    async def _route_store_segment(request):
        """**按段 id** 读这一段的权威档案 —— B1 之后前端唯一的段读入口。

        前端三个节点以前各存一份内存（rack 的 ui.st.segs、desk 的 st.segs、
        cast 的 shots[].state），切段时各自"猜当前段"，猜错就串段/丢词。
        有了这个接口，切段改成：拿 cid → 问中央 → 中央说什么就是什么。

        **没有 binding 时现场补建**（从 shots / rack_slots / desk 现场聚合），
        历史工程本来就 0 行 binding，靠这一下自动愈合，不用重建工程。
        """
        import asyncio
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        cid = str(request.query.get("id") or request.query.get("cid") or "")
        if not cid:
            return _json_response({"error": "缺少段落 id"}, 400)
        d = chain_dir(name)
        if not has_db(d):
            return _json_response({"error": "老工程（JSON 档案）没有中央段档案"}, 409)
        loop = asyncio.get_event_loop()

        def _read():
            clip = load_clip_doc(d, cid)
            if clip is None:
                return None
            b = load_segment_binding(d, cid) or sync_segment_binding(d, cid)
            if b is None:
                # 孤儿段（没绑 shot_uid）：能读到的都给它，至少别让前端瞎猜。
                b = {"cid": cid, "shot_uid": "", "action": "", "source_cid": "",
                     "state": clip.get("state") or {},
                     "rack": load_rack(d, cid)
                             or {"slots": {"images": [], "videos": [], "audios": []},
                                 "fps": 0, "audio_out": 0},
                     "desk_text": _desk_text_of(d, cid), "status": "orphan"}
            order = all_clip_cids(d)
            out = dict(b)
            out["index"] = order.index(cid) + 1 if cid in order else 0
            out["order"] = order
            out["clip_name"] = clip.get("name") or ""
            out["frames"] = int(clip.get("frames") or 0)
            out["backend"] = "db"
            return out

        out = await loop.run_in_executor(None, _read)
        if out is None:
            return _json_response({"error": "没有这一段：%s" % cid}, 404)
        return _json_response(out)

    @PromptServer.instance.routes.post("/cglide/store/event")
    async def _route_store_event(request):
        import asyncio
        try:
            body = await request.json()
        except Exception:
            return _json_response({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        d = chain_dir(name)
        if not has_db(d):
            return _json_response({"ok": True, "seq": None})   # 老工程静默跳过
        loop = asyncio.get_event_loop()
        seq = await loop.run_in_executor(
            None, log_event, d, body.get("action") or "event",
            body.get("cid"), body.get("payload") or {},
            body.get("actor") or "frontend")
        return _json_response({"ok": True, "seq": seq})

    @PromptServer.instance.routes.get("/cglide/store/events")
    async def _route_store_events(request):
        import asyncio
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        d = chain_dir(name)
        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(
            None, list_events, d,
            int(request.query.get("limit") or 100),
            request.query.get("cid") or None,
            request.query.get("action") or None)
        return _json_response({"events": rows})

    @PromptServer.instance.routes.post("/cglide/store/snapshot")
    async def _route_store_snapshot_add(request):
        import asyncio
        try:
            body = await request.json()
        except Exception:
            return _json_response({"error": "请求体不是 JSON"}, 400)
        name = str(body.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        d = chain_dir(name)
        if ensure_db(d) != "db":
            return _json_response({"error": "老工程（JSON 档案）不支持状态库写入"}, 409)
        loop = asyncio.get_event_loop()
        sid = await loop.run_in_executor(
            None, add_snapshot, d, body.get("label") or "",
            body.get("shots") or [], body.get("desk"),
            body.get("cur_cid"), body.get("idx"),
            body.get("source") or "manual",
            int(body.get("keep") or 0))
        return _json_response({"ok": True, "id": sid})

    @PromptServer.instance.routes.get("/cglide/store/snapshots")
    async def _route_store_snapshot_list(request):
        import asyncio
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        d = chain_dir(name)
        # full=1 才带 shots/desk 正文（撤销栈回填用）；只列标题时别拖整份工程。
        full = str(request.query.get("full") or "") in ("1", "true", "yes")
        src = request.query.get("source") or None
        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(
            None, list_snapshots, d, int(request.query.get("limit") or 200),
            full, src)
        return _json_response({"snapshots": rows})

    @PromptServer.instance.routes.delete("/cglide/store/snapshots")
    async def _route_store_snapshot_clear(request):
        """清空还原点（?source=undo 只清撤销栈镜像）。"""
        import asyncio
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        d = chain_dir(name)
        src = request.query.get("source") or None
        loop = asyncio.get_event_loop()
        n = await loop.run_in_executor(None, clear_snapshots, d, src)
        return _json_response({"ok": True, "removed": n})

    @PromptServer.instance.routes.get("/cglide/store/snapshot")
    async def _route_store_snapshot_get(request):
        import asyncio
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        sid = request.query.get("id")
        d = chain_dir(name)
        loop = asyncio.get_event_loop()
        out = await loop.run_in_executor(None, get_snapshot, d, sid)
        if out is None:
            return _json_response({"error": "没有这个还原点"}, 404)
        return _json_response(out)

    @PromptServer.instance.routes.delete("/cglide/store/snapshot")
    async def _route_store_snapshot_del(request):
        import asyncio
        name = str(request.query.get("name") or "").strip()
        if not name:
            return _json_response({"error": "缺少片名：请求没带 name，已停止，不读写任何档案"}, 400)
        sid = request.query.get("id")
        d = chain_dir(name)
        loop = asyncio.get_event_loop()
        ok = await loop.run_in_executor(None, delete_snapshot, d, sid)
        return _json_response({"ok": bool(ok)})
