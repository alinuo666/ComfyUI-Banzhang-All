# -*- coding: utf-8 -*-
"""段字段权威矩阵自测（20261025）—— 防「某个字段在某条路径上被静默丢掉」。

**为什么要有这个脚本**：20261015 / 20261023 / 20261025 三次事故是同一个病 ——
一个字段要在多处同步维护，漏一处就静默退化到默认值，不报错、不打印、没人知道。
前两次修的是"那一处"，所以第三次必然来。

它是 csglide_cast.SEG_KEY_OWNER 契约表的执行保障层：
  · **用例从契约表自动生成** —— 加字段不归表，契约校验当场炸；归了表，用例
    自动就有，不会漏测。这是"让人漏不掉"的另一半（表是设计层，这是实现层）。
  · 三条硬回归断言分别盯着暗病 1 / 2 / 3，它们以前都真机上发生过。

运行（cwd 须为 ComfyUI 根目录）：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\templates\\seg_field_matrix.py
"""
import os
import sys
import importlib.util

COMFY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (COMFY_ROOT, PKG_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

# 以包形态加载。csglide_cast 里有 `from .csglide_assets import ...` 这类相对
# 导入，必须以 banzhang_pkg.xxx 的**子模块身份**加载，普通 import 会报
# "attempted relative import with no known parent package"。
_spec = importlib.util.spec_from_file_location(
    "banzhang_pkg", os.path.join(PKG_ROOT, "__init__.py"),
    submodule_search_locations=[PKG_ROOT])
_pkg = importlib.util.module_from_spec(_spec)
sys.modules["banzhang_pkg"] = _pkg
_spec.loader.exec_module(_pkg)


def _load_sub(name):
    full = "banzhang_pkg.%s" % name
    _sp = importlib.util.spec_from_file_location(
        full, os.path.join(PKG_ROOT, "%s.py" % name))
    _m = importlib.util.module_from_spec(_sp)
    sys.modules[full] = _m
    _sp.loader.exec_module(_m)
    return _m


CAST = _load_sub("csglide_cast")                 # noqa: E402

PASS, FAIL = 0, 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % name)
    else:
        FAIL += 1
        print("  ✗ %s %s" % (name, extra))


# --------------------------------------------------------------------------
# 提交侧：一份"每个字段都有值"的原始 state（形状与库里 state 一致，
# 两边都过 parse_h3_data，比较才公平）。
# alias=False 是刻意选的 —— 它就是 20261025 暗病 1 的真实场景
#（文案台上明明关着，却被按"开"处理）。
# --------------------------------------------------------------------------
SUBMIT_RAW = {
    "prompt": "提交里的词",
    "slots": {
        "first":  {"file": "s_first.png"},
        "last":   {"file": "s_last.png"},
        "images": [{"file": "s1.png"}, {"file": "s2.png"}],
        "videos": [{"file": "sv.mp4"}],
        "audios": [{"file": "sa.wav"}],
    },
    "cont":   {"mode": "file", "file": "s.mp4"},
    "mode":   "fl2va",
    "width":  1344, "height": 768, "length": 124,
    "ref_image_size": 1056, "ref_video_size": 768,
    "ref_video_fps": 24, "ref_scale_hd": 1,
    "push_whole": True, "producer": True,
    "alias": False,
    # 注意：_seg_fps_of 只收 **8 位小写十六进制**，其余一律当"没给"（防畸形值
    # 让对账报出永远消不掉的漂移）。测试样本必须用合法 hex，否则解析成空串。
    "segFps": {"word": "abcd1234", "img": "11223344", "src": "desk"},
    "chain":  {"name": "P", "clip": "clip_0001", "shot": "subuid"},
}

# 库侧：每个字段都给一个"有值"的样本，值与提交侧都不同，才能看出谁赢了。
# alias / segFps **故意不写** —— 实测 61 个段的库 state 里都没有它们。
DB_RAW = {
    "prompt": "库里的词",
    "slots": {
        "first":  {"file": "db_first.png"},
        "last":   {"file": "db_last.png"},
        "images": [{"file": "db1.png"}],
        "videos": [{"file": "dbv.mp4"}],
        "audios": [{"file": "dba.wav"}],
    },
    "cont":   {"mode": "file", "file": "db.mp4"},
    "mode":   "ref2va",
    "width":  960, "height": 540, "length": 200,
    "ref_image_size": 1024, "ref_video_size": 512,
    "ref_video_fps": 16, "ref_scale_hd": 2,
    "push_whole": False, "producer": False,
    "chain":  {"name": "P", "clip": "clip_0001", "shot": "dbuid"},
}

CID = "clip_0001"


def merge(db_raw):
    return CAST._merge_db_authority(CAST.parse_h3_data(SUBMIT_RAW), db_raw or {}, CID)


print("【1】契约完整性（parse_h3_data 的每个返回键都归了类吗）")
check("FIELD_CONTRACT_OK", CAST.FIELD_CONTRACT_OK)
check("SEG_KEY_OWNER 非空", bool(CAST.SEG_KEY_OWNER),
      len(CAST.SEG_KEY_OWNER))
_keys = set(CAST.parse_h3_data({}).keys())
check("契约表与返回键完全对齐（无缺无多）",
      _keys == set(CAST.SEG_KEY_OWNER),
      "多=%s 缺=%s" % (sorted(set(CAST.SEG_KEY_OWNER) - _keys),
                       sorted(_keys - set(CAST.SEG_KEY_OWNER))))

print("\n【2】库为空 → 提交侧的值必须全部保住（三次事故的共同断言）")
# 库 state 完全为空（= 旧工程 / 落库失败 / 刚 hydrate）：
# 不管字段归谁，**一个都不许被库里的"空"或 parse 的默认值覆盖**。
out = merge({})
for key, owner in CAST.SEG_KEY_OWNER.items():
    want = CAST.parse_h3_data(SUBMIT_RAW).get(key)
    got = out.get(key)
    if key == "chain":
        # chain 单独合成：clip 必须是提交认到的那一段
        check("chain.clip 保住提交侧的段", got.get("clip") == CID, got)
        continue
    check("库空时不覆盖 %-16s（%s）" % (key, owner), got == want,
          "得到 %r 期望 %r" % (got, want))

print("\n【3】库有值 → 按 SEG_KEY_OWNER 判定谁赢")
out = merge(DB_RAW)
_want_db = CAST.parse_h3_data(DB_RAW)
_want_sub = CAST.parse_h3_data(SUBMIT_RAW)
for key, owner in CAST.SEG_KEY_OWNER.items():
    if key == "chain":
        continue
    if owner == "db":
        check("库赢 %-16s" % key, out.get(key) == _want_db.get(key),
              "得到 %r 期望库值 %r" % (out.get(key), _want_db.get(key)))
    elif owner == "db_nonempty":
        check("库有值则库赢 %-16s" % key, out.get(key) == _want_db.get(key),
              "得到 %r 期望库值 %r" % (out.get(key), _want_db.get(key)))
    else:
        check("提交赢 %-16s" % key, out.get(key) == _want_sub.get(key),
              "得到 %r 期望提交值 %r" % (out.get(key), _want_sub.get(key)))

print("\n【4】三条硬回归断言（暗病 1 / 2 / 3，以前都在真机上发生过）")
# 暗病 1：库里没有 alias（实测 61 段全缺）。以前整份替换把它删掉 →
# 缺失按旧行为兜底成 True → 文案台开关关不住，裸角色名照样被展开成 @图片N。
_o = merge(DB_RAW)
check("暗病1 别名开关：库里没有 alias 时，提交侧的 False 必须保住",
      _o.get("alias") is False, _o.get("alias"))
check("暗病1 别名开关：库里就算写了 alias=True 也不能覆盖提交侧的关（归 submit）",
      CAST._merge_db_authority(
          CAST.parse_h3_data(SUBMIT_RAW),
          dict(DB_RAW, alias=True), CID).get("alias") is False)

# 暗病 2：seg_fps 同理。以前被整份替换删掉 → _audit_seg_fps 开头
# `if not claim.get("word")` 直接早退 → 对账静默失效、日志再无 rev_drift。
check("暗病2 对账指纹：库里没有 segFps 时，提交侧的指纹必须保住",
      (_o.get("seg_fps") or {}).get("word") == "abcd1234", _o.get("seg_fps"))
check("暗病2 对账指纹：保住之后 _audit_seg_fps 才不会开头早退",
      bool((_o.get("seg_fps") or {}).get("word")))

# 暗病 3：库里 prompt 是空串（实测所有段都是 0 长度）。
# 以前整份替换用空串盖掉面板刚填的词，_fill_empty_words_from_store 又补不到 → 空出图。
_empty_prompt_db = dict(DB_RAW, prompt="")
_o3 = merge(_empty_prompt_db)
check("暗病3 空词：库里 prompt 为空串时必须保住提交侧的词",
      _o3.get("prompt") == "提交里的词", _o3.get("prompt"))

print("\n【5】身份（chain）：跑哪一段由提交决定，不跟库里走")
_o5 = merge(DB_RAW)
check("chain.clip 用提交认到的段", _o5["chain"]["clip"] == CID, _o5["chain"])
check("chain.name 保住提交侧", _o5["chain"]["name"] == "P", _o5["chain"])
check("chain.shot 优先提交侧", _o5["chain"]["shot"] == "subuid", _o5["chain"])
_o5b = CAST._merge_db_authority(
    CAST.parse_h3_data(dict(SUBMIT_RAW, chain={"name": "P", "clip": CID})),
    DB_RAW, CID)
check("chain.shot 提交侧缺失时退而用库里的", _o5b["chain"]["shot"] == "dbuid",
      _o5b["chain"])

print("\n【6】槽位：库里的空槽绝不能清空提交侧的真实参考图")
# 实测 61 个段，库里 slots.images 有真实 file 的段数是 **0**。
# 若槽位归 db（不是 db_nonempty），库里那份空会把参考图全清掉。
_empty_slots_db = dict(DB_RAW, slots={"images": [{}, {}, {}, {}, {}],
                                      "videos": [{}], "audios": [{}]})
_o6 = merge(_empty_slots_db)
check("库槽位为空时不覆盖提交侧 images",
      _o6.get("images") == _want_sub.get("images"),
      "得到 %r 期望 %r" % (_o6.get("images"), _want_sub.get("images")))
check("库槽位为空时不覆盖提交侧 videos",
      _o6.get("videos") == _want_sub.get("videos"))

print("\n【7】媒体架接线：只认接线，断线即空（20261105）")
try:
    AS = _load_sub("csglide_assets")
    _cfg = {"images": [{"file": "keep5.png"}] * 5 + [{"file": "stale6.png"},
                                                     {"file": "stale7.png"}]}
    AS.merge_rack_refs(_cfg, {"slots": {"images": [{"file": "w1.png"},
                                                   {"file": "w2.png"},
                                                   {"file": "w3.png"}]}})
    check("前 3 格用接线的值", _cfg["images"][:3] == [{"file": "w1.png"},
                                                     {"file": "w2.png"},
                                                     {"file": "w3.png"}],
          _cfg["images"][:3])
    # 接线只声明了 3 格 → 面板 / 库里的高位残留一律不留，否则 @图片N 会引用到。
    check("接线只声明 3 格 → 面板残留全清空",
          len(_cfg["images"]) == 3, _cfg["images"])
    # 接线范围内的空槽就是空，不再由面板兜底（接线才生效）。
    _cfg2 = {"images": [{"file": "p%d.png" % i} for i in range(5)]}
    AS.merge_rack_refs(_cfg2, {"slots": {"images": [{"file": "w1.png"}, {},
                                                    {"file": "w3.png"}]}})
    check("接线范围内是空槽 → 按空处理（不再面板兜底）",
          _cfg2["images"][1] is None, _cfg2["images"])
    check("面板高位残留全清空（p3/p4 不留）",
          len(_cfg2["images"]) == 3, _cfg2["images"])
    # 断线是本次改动的核心口径：三类槽位必须全空，照常渲染但不带旧素材。
    _cfg3 = {"images": [{"file": "p0.png"}], "videos": [{"file": "v0.mp4"}],
             "audios": [{"file": "a0.wav"}]}
    AS.merge_rack_refs(_cfg3, None)
    check("refs 断线 → 图/视频/音频三类全空",
          _cfg3["images"] == [] and _cfg3["videos"] == []
          and _cfg3["audios"] == [], _cfg3)
    # 段内容唯一写入口：库里的旧词不许补回来（「改词没反应」的根因）。
    _cfg4 = {"prompt": "库里上次的旧词", "images": [{"file": "old.png"}],
             "videos": [], "audios": []}
    CAST._resolve_wired_content(_cfg4, None, None)
    check("断线 → 词与素材都按空（库里旧词不补回）",
          _cfg4["prompt"] == "" and _cfg4["images"] == [], _cfg4)
    _cfg5 = {"prompt": "库里上次的旧词", "images": [{"file": "old.png"}],
             "videos": [], "audios": []}
    CAST._resolve_wired_content(
        _cfg5, {"slots": {"images": [{"file": "w1.png"}]}}, "新写的一段词")
    check("接线 → 词与素材都只来自上游",
          _cfg5["prompt"] == "新写的一段词"
          and _cfg5["images"] == [{"file": "w1.png"}], _cfg5)
except Exception as e:
    check("merge_rack_refs 可用", False, "%s: %s" % (type(e).__name__, e))

print("\n【8】真实工程库端到端（库里没有的字段，提交侧的必须完整保住）")
try:
    ST = _load_sub("csglide_store")
    import glob
    _found = 0
    for _p in sorted(glob.glob(os.path.join(COMFY_ROOT, "output", "h3_chain",
                                            "*", "project.db"))):
        try:
            _doc = ST.load_clip_doc(os.path.dirname(_p), "clip_0001")
            _st = (_doc or {}).get("state")
            if not isinstance(_st, dict) or not _st:
                continue
        except Exception:
            continue
        _found += 1
        _r = merge(_st)
        check("%s：alias 保住提交侧的 False" % os.path.basename(
                  os.path.dirname(_p)), _r.get("alias") is False, _r.get("alias"))
        check("%s：seg_fps 保住提交侧的指纹" % os.path.basename(
                  os.path.dirname(_p)),
              (_r.get("seg_fps") or {}).get("word") == "abcd1234", _r.get("seg_fps"))
        break          # 有一个真实样本就够，不必全扫
    if not _found:
        print("  （没有可用样本，跳过）")
except Exception as e:
    print("  （跳过多库扫描：%s: %s）" % (type(e).__name__, e))

print("\n【9】负向：加个没归类的新字段，契约校验必须抓到")
# 这是整套机制的**存在意义**：20261015/1023/1025 三次事故都是"加了东西忘了同步"。
# 表本身不值钱，值钱的是"忘了归表会被当场抓住"。这里模拟一次违规。
_orig_parse = CAST.parse_h3_data


def _parse_with_extra(raw):
    d = _orig_parse(raw)
    d["some_new_field"] = 1          # 有人加了个字段，忘了补进 SEG_KEY_OWNER
    return d


CAST.parse_h3_data = _parse_with_extra
_ok = CAST._audit_field_contract()
CAST.parse_h3_data = _orig_parse
check("未归类的新字段 → _audit_field_contract 返回 False", _ok is False, _ok)

# 表里有、parse 不返回的键，同样要抓到（说明有人改了返回体却没同步表）
def _parse_without(raw):
    d = _orig_parse(raw)
    d.pop("alias", None)
    return d


CAST.parse_h3_data = _parse_without
_ok2 = CAST._audit_field_contract()
CAST.parse_h3_data = _orig_parse
check("表里有但 parse 不再返回 → 同样抓到", _ok2 is False, _ok2)

# 复原后必须回到干净状态（防止上面的 patch 污染后续）
check("复原后契约重新对齐", CAST._audit_field_contract() is True)

print("\n【10】clip 不进文件、不进提交（20261105 · C 方案）")
# 根因：clip_XXXX 是后端按 shot uid 现场签发的**运行时凭证**，却被写进
# 工作流 .json 的两处快照（h3_data.chain.clip 与
# properties.gcast_project.shots[].clip，实测桌面 H3三采_空模板.json 都有），
# 随工作流跨机器分发后，后端 load_clip 查不到 → 抛 _SegBindingLost。
# 现在三处出口全部清掉；后端本来就会按 chain.shot 认段
# （csglide_cast.py:2817-2821），不需要前端送 clip。
# 下面七条盯的是「结果」：任何新增出口、任何一处漏清，这里当场红。


def _js_read(fn):
    p = os.path.join(PKG_ROOT, "js", fn)
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


_cast_js = _js_read("csglide_cast.js")
_build_js = _js_read("bz_prompt_build.js")
_store_js = _js_read("bz_project_store.js")

check("导演台 commit 写 widget 时剔除 chain.clip",
      'chain: { ...(ui.st.chain || {}), clip: "" }' in _cast_js,
      "widget.value 同时进工作流存盘与裸提交，漏清就会重新分发旧编号")

check("h3_data 的 serializeValue 也剔除 chain.clip",
      'if (o && typeof o === "object" && o.chain) o.chain.clip = "";' in _cast_js,
      "有的路径直接改 data.value 不经过 commit，序列化时还得兜一层")

check("节点 serialize() 剔除 properties.gcast_project.shots[].clip",
      "delete c.clip;" in _cast_js and "gcast_project" in _cast_js,
      "ComfyUI 把 node.properties 全量写进 .json，不剔除等于继续分发旧编号")

# 20261107 起编译通道改成带**本段真实 cid**（抹空会让第 2/3 段按 shot 认不到，
# 触发 add_clip 新建段）。断言跟着改，别再拿旧字符串硬卡出一条永远红的 FAIL。
check("编译通道提交 h3_data 时带本段真实 cid（20261107 修）",
      'h3Submit.chain = { ...(h3Submit.chain || {}), clip: String(cid || "") };'
      in _build_js)

check("兜底通道提交 h3_data 时清掉 clip",
      'seg.state.chain.clip = "";' in _store_js)

# 20261108 fl2va 回归：编译通道曾把整块 slots 删掉，first/last 再无写入口。
check("编译通道不再整块删 slots（fl2va 首/末帧回归）",
      "delete h3Submit.slots" not in _build_js)
check("编译通道保留 slots.first / last，只清空三类参考槽",
      "h3Submit.slots = {" in _build_js
      and "...(seg.state.slots || {})" in _build_js
      and "images: [], videos: [], audios: []" in _build_js)

check("validClip 已删除（身份校验由「不持久化」取代，不再叠防线）",
      "validClip(" not in _store_js
      and "validClip(" not in _js_read("bz_queue_align.js"))

# 覆盖性检查：h3_data 提交出口只允许这两个文件，新增出口必须同步对齐段身份。
_writers = set()
for _fn in os.listdir(os.path.join(PKG_ROOT, "js")):
    if _fn.endswith(".js") and "inputs.h3_data = JSON.stringify" in _js_read(_fn):
        _writers.add(_fn)
check("h3_data 提交出口只有编译 / 兜底两处（新增出口必须一起清 clip）",
      _writers == {"bz_prompt_build.js", "bz_project_store.js"}, sorted(_writers))

print("\n【9】fl2va 首/末帧：面板槽位 → 提交 → 后端锚点（20261108 回归）")
check("first / last 归 submit（不归 wired，接线收口不写它们）",
      CAST.SEG_KEY_OWNER.get("first") == "submit"
      and CAST.SEG_KEY_OWNER.get("last") == "submit",
      (CAST.SEG_KEY_OWNER.get("first"), CAST.SEG_KEY_OWNER.get("last")))
check("词与三类参考素材仍是 wired（wired 语义没被顺手改坏）",
      all(CAST.SEG_KEY_OWNER.get(k) == "wired"
          for k in ("prompt", "images", "videos", "audios")))
check("提交带 slots.first 时库里的旧首帧不许覆盖（submit = 提交赢）",
      (CAST._merge_db_authority(
          CAST.parse_h3_data(SUBMIT_RAW), DB_RAW, CID).get("first") or {})
      .get("file") == "s_first.png")

_fl2 = CAST.parse_h3_data({
    "mode": "fl2va",
    "slots": {"first": {"file": "s_first.png"},
              "last": {"file": "s_last.png"},
              "images": [], "videos": [], "audios": []},
    "prompt": "at 0.00 seconds in @first is fully referenced.",
})
CAST._resolve_wired_content(
    _fl2, {"slots": {"images": [], "videos": [], "audios": []}}, _fl2["prompt"])
check("_resolve_wired_content 不碰 first / last",
      (_fl2.get("first") or {}).get("file") == "s_first.png"
      and (_fl2.get("last") or {}).get("file") == "s_last.png", _fl2)
_tags, _ = CAST.build_tag_map(_fl2, bool(_fl2["first"]), bool(_fl2["last"]))
check("fl2va 槽位有图 → @first / @last 拿到 <Picture N>",
      _tags.get("@first") == "<Picture 1>"
      and _tags.get("@last") == "<Picture 2>", _tags)
_out = CAST.transcribe_prompt(_fl2["prompt"], _tags, ["@first", "@last"])
check("提示词里的 @first 不再被当空槽删除",
      "@first" not in _out and "<Picture 1>" in _out, _out)

_no = CAST.parse_h3_data({"mode": "fl2va", "prompt": "at 0.00 @first"})
CAST._resolve_wired_content(_no, None, _no["prompt"])
_t2, _ = CAST.build_tag_map(_no, bool(_no["first"]), bool(_no["last"]))
check("面板也没放图时 → 首/末帧仍为空、tags 为空（体检照常报错）",
      _no["first"] is None and _no["last"] is None and _t2 == {})

print("\n" + "=" * 60)
print("PASS=%d FAIL=%d" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
