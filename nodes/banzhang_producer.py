# -*- coding: utf-8 -*-
"""🎬 H3 AI 制片中枢（Producer）

一句话 Brief 进，一条「参考图资产 → 多段视频」的任务 DAG 出：
  · N1 ✨ AI 制片中枢   ：两次 LLM 调用（编剧 / 编译器），产出工程包 Schema v4
  · N2a 📥 资产入库     ：候选 batch 落盘、编号联系表、VL/人工选图晋升
  · N2b 🗂️ 资产架       ：按工程名从磁盘读资产，给 Qwen 编辑台 / H3 导演台组 H3_REFS
  · N3 🎬 DAG 编排器    ：Kahn 拓扑排序后批量 POST /prompt（FIFO 串行，fire-and-forget）
  · N4 📦 段尾归位      ：续拍档归位 clip_cont + 写 cont_saved；首段成片归位 clip_film

全部跨任务状态只走磁盘工程目录：
    input/_producer/<工程>/
      ├─ pkg.json / assets.json
      ├─ <别名>__<视图>.png
      └─ candidates/<别名>__<视图>__cN.png

设计依据均来自节点包源码核对（见 docs/H3-Producer-AI制片中枢-执行方案.md v4）。
"""

import hashlib
import json
import os
import re
import shutil
import time
import urllib.request
import urllib.error

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import folder_paths

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
PRODUCER_SUBDIR = "_producer"          # input/_producer/<工程>/
REF_LIMIT = 200                        # 与 csglide_assets.REF_LIMIT 一致（20261020 64 → 200）
RACK_SOFT_WARN = 9                     # 面板本地兜底槽位数，超过给警告
MAX_VIDEOS = 3                         # 与 csglide_cast.MAX_VIDEOS 一致
MAX_AUDIOS = 3                         # 与 csglide_cast.MAX_AUDIOS 一致
FPS = 24
FIRST_CLIP_LENGTH = 360                # 首段填 360 → 导演台向上吸附 362 帧 (15.08s)
NEXT_CLIP_LENGTH = 379                 # 续段 17×22+5=379，剪 22 头钉后净 357 帧
CONT_HEAD_FRAMES = 22
CLIENT_ID_PREFIX = "producer-"

_TAG = "[H3 制片中枢]"


def _log(msg):
    print("%s %s" % (_TAG, msg))


# ---------------------------------------------------------------------------
# 磁盘 / JSON / 命名
# ---------------------------------------------------------------------------
def _safe_fs(name):
    """文件系统安全名（保留中文，只去路径非法字符与空白）。"""
    s = re.sub(r'[\\/:*?"<>|\s]+', "_", str(name or "").strip())
    return s.strip("_") or "未命名"


def project_dir(name):
    p = os.path.join(folder_paths.get_input_directory(), PRODUCER_SUBDIR,
                     _safe_fs(name))
    os.makedirs(p, exist_ok=True)
    os.makedirs(os.path.join(p, "candidates"), exist_ok=True)
    return p


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def pkg_path(name):
    return os.path.join(project_dir(name), "pkg.json")


def assets_path(name):
    return os.path.join(project_dir(name), "assets.json")


def load_pkg(name):
    return _read_json(pkg_path(name), None)


def load_assets(name):
    return _read_json(assets_path(name), None) or {"project": name, "groups": []}


def save_assets(name, data):
    data["project"] = name
    data["updated"] = time.time()
    _write_json(assets_path(name), data)


def view_stem(alias, view):
    return "%s__%s" % (_safe_fs(alias), _safe_fs(view))


def view_rel(name, alias, view):
    """正式视图相对 input 的路径（resolve_asset 候选 1 原样命中）。"""
    return "%s/%s/%s.png" % (PRODUCER_SUBDIR, _safe_fs(name), view_stem(alias, view))


def view_abs(name, alias, view):
    return os.path.join(folder_paths.get_input_directory(),
                        view_rel(name, alias, view).replace("/", os.sep))


def cand_rel(name, alias, view, idx):
    return "%s/%s/candidates/%s__c%d.png" % (
        PRODUCER_SUBDIR, _safe_fs(name), view_stem(alias, view), idx)


def cand_abs(name, alias, view, idx):
    return os.path.join(folder_paths.get_input_directory(),
                        cand_rel(name, alias, view, idx).replace("/", os.sep))


def _file_md5(path, block=1 << 20):
    h = hashlib.md5()
    with open(path, "rb") as f:
        while True:
            b = f.read(block)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# 统一素材池（5-A）：同一内容的全机媒体文件只存一份。中枢与手工媒体架共用
# 这套内容寻址 —— 中枢入库 / 磁盘直扫入库落盘前都先问它：盘上已有内容完全
# 相同的文件，就复用已有那份、不再多存。这样「这段的人和别段不一样」从根上
# 断掉：改图只改一处，两套账（assets.json / asset_pool）都指向同一份实体。
_MEDIA_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".webm",
               ".wav", ".mp3", ".m4a", ".flac", ".ogg")

# 进程内内容索引：{abspath: (mtime_ns, size, md5)}。惰性构建，文件一变（mtime
# 或 size 对不上）就重算哈希。进程存活期间，几百个素材文件只算一次 md5。
_content_index = {}


def _content_stat(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except Exception:
        return None


def _content_md5(path):
    ap = os.path.abspath(path)
    fp = _content_stat(ap)
    if fp is None:
        return None
    hit = _content_index.get(ap)
    if hit is not None and hit[0] == fp[0] and hit[1] == fp[1]:
        return hit[2]
    try:
        md5 = _file_md5(ap)
    except Exception:
        return None
    _content_index[ap] = (fp[0], fp[1], md5)
    return md5


def _dedup_roots(name):
    """去重扫描范围：本工程目录 + 手工素材根 cglide + 全部中枢工程（跨工程）。"""
    inp = folder_paths.get_input_directory()
    roots = [project_dir(name)]
    for sub in ("cglide", PRODUCER_SUBDIR):
        p = os.path.join(inp, sub)
        if os.path.isdir(p):
            roots.append(p)
    return roots


def dedup_existing(name, abs_new):
    """内容寻址去重：盘上已有内容完全相同的媒体就复用那一份，不再多存。

    扫描「本工程目录 + input/cglide + 全部中枢工程」，图/视频/音频一视同仁。
    命中返回已有文件的相对路径（相对 input），调用方应删掉刚写的那份并改用
    该路径；返回空串表示没撞上，照常用新文件。
    """
    md5 = _content_md5(abs_new)
    if not md5:
        return ""
    inp = folder_paths.get_input_directory()
    me = os.path.abspath(abs_new)
    for root in _dedup_roots(name):
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.lower().endswith(_MEDIA_EXTS):
                    continue
                p = os.path.join(dirpath, fn)
                if os.path.abspath(p) == me:
                    continue
                if _content_md5(p) == md5:
                    return os.path.relpath(p, inp).replace(os.sep, "/")
    return ""


# 扩展名 → 素材 kind（3-A/3-B 共用）。
_MEDIA_EXT_KIND = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
    ".mp4": "video", ".mov": "video", ".webm": "video",
    ".wav": "audio", ".mp3": "audio", ".m4a": "audio", ".flac": "audio",
    ".ogg": "audio",
}


def _media_kind(fn):
    return _MEDIA_EXT_KIND.get(os.path.splitext(fn)[1].lower())


def scan_media_dir(name):
    """扫 input/_producer/<片名>/ **直接层**媒体文件（跳过 candidates/、pkg.json、
    assets.json），返回 [(别名, kind, 相对路径)]。别名 = 文件名去掉 __视图 后缀。
    """
    d = project_dir(name)
    found = []
    try:
        names = sorted(os.listdir(d))
    except Exception:
        return found
    for fn in names:
        if fn.startswith(".") or fn in ("pkg.json", "assets.json"):
            continue
        p = os.path.join(d, fn)
        if not os.path.isfile(p):
            continue
        kind = _media_kind(fn)
        if not kind:
            continue
        stem = os.path.splitext(fn)[0]
        alias = stem.split("__", 1)[0].strip() or stem
        rel = os.path.join(PRODUCER_SUBDIR, _safe_fs(name), fn).replace(os.sep, "/")
        found.append((alias, kind, rel))
    return found


def ingest_media_dir(name):
    """把目录里尚未入库的媒体文件追加进 assets.json（幂等，已在库的跳过）。

    丢个 mp4 / wav 进目录即可入库，不必手改 JSON。别名撞已有别名时自动加
    -2/-3 后缀，绝不静默覆盖。返回新增条数。
    """
    assets = load_assets(name)
    groups = assets.setdefault("groups", [])
    used_ids = {str(g.get("id")) for g in groups}
    used_alias = {str(g.get("alias")) for g in groups}
    used_files = set()
    for g in groups:
        for v in (g.get("views") or []):
            if v.get("file"):
                used_files.add(str(v["file"]))
    added = 0
    for alias, kind, rel in scan_media_dir(name):
        if rel in used_files:
            continue
        nid = len(groups) + 1
        while ("g%d" % nid) in used_ids:
            nid += 1
        uid = "g%d" % nid
        a = alias
        n = 2
        while a in used_alias:
            a = "%s-%d" % (alias, n)
            n += 1
        groups.append({
            "id": uid, "alias": a, "kind": kind, "role": "", "seg": "",
            "views": [{"view": "主锚", "file": rel, "key_anchor": True,
                       "candidates": [], "chosen": 1, "status": "chosen"}],
        })
        used_ids.add(uid)
        used_alias.add(a)
        used_files.add(rel)
        added += 1
    if added:
        save_assets(name, assets)
    return added


def assert_no_manual_project(name):
    """挡住「中枢与手工用同一个片名」——两套体系共用 output/h3_chain/<片名>/。

    同片名跑中枢会直接覆盖手工工程的成片 / 续拍档 / 段档案，而且事后极难察觉。
    判定：段落档案目录里已有状态库（project.db），却没有中枢工程包（pkg.json）
    → 那是手工导演台的地盘，就地报错，不写任何一个字节。
    """
    inp = folder_paths.get_input_directory()
    out_root = os.path.join(folder_paths.get_output_directory(), "h3_chain")
    raw = str(name or "").strip()
    # 两套体系算目录名的口径不一样：手工导演台（csglide_store.chain_dir）只去
    # 非法字符、**保留空格**；中枢 _safe_fs 连空白一起换成下划线。含空格的片名
    # 在两边会落进两个不同目录 —— 只按自己的口径查就会漏判，两个都要查。
    manual_style = "".join(c for c in raw if c not in '\\/:*?"<>|').strip()
    for safe in (_safe_fs(raw), manual_style):
        if not safe:
            continue
        # project.db = 手工工程（SQLite 状态库）；chain.json = 更老的手工工程。
        # 两种都是别人的地盘，中枢进去都会覆盖成片 / 续拍档 / 档案。
        manual_db = os.path.join(out_root, safe, "project.db")
        manual_json = os.path.join(out_root, safe, "chain.json")
        producer_pkg = os.path.join(inp, PRODUCER_SUBDIR, safe, "pkg.json")
        if not ((os.path.isfile(manual_db) or os.path.isfile(manual_json))
                and not os.path.isfile(producer_pkg)):
            continue
        raise ValueError(
            "「%s」已被手工导演台工程占用（output/h3_chain/%s/project.db 已存在，"
            "但 input/%s/%s/ 下没有中枢工程包）。\n"
            "两套体系共用同一个段落档案目录，继续跑会覆盖对方的成片 / 续拍档 / "
            "段档案，且事后极难察觉。\n"
            "  · 想用中枢跑：换一个没用过的片名（推荐）\n"
            "  · 想继续手工做：不要在中枢这张图里填这个片名"
            % (name, safe, PRODUCER_SUBDIR, safe))
    return True


def _validate_segment_ids(pkg):
    """4-D 段 id 撞车自检：工程包内 shot / cid 不得重复（防手改 pkg 撞号）。"""
    segs = pkg.get("segments") or []
    if not segs:
        raise ValueError("工程包没有 segments，无法编排。")
    seen_shot, seen_cid = set(), set()
    for k, s in enumerate(segs, 1):
        shot = str(s.get("shot") or shot_at(k))
        cid = str(s.get("cid") or cid_at(k))
        if shot in seen_shot:
            raise ValueError("段 %d 的分段身份 %s 与前面重复——撞号会导致认档错位，"
                             "请检查工程包 segments。" % (k, shot))
        if cid in seen_cid:
            raise ValueError("段 %d 的段落 id %s 与前面重复。" % (k, cid))
        seen_shot.add(shot)
        seen_cid.add(cid)
    return True


def _check_segment_collision(name, pkg):
    """4-D 段 id 撞车自检（对档案）：本次 shot 若在档案里已属于**别的** clip 就
    报错。shot+clip 都相同 = 重跑同一段，放行；shot 相同、clip 不同 = 撞号，拦。
    """
    cm = _load_chain_mod()
    if cm is None:
        return True
    try:
        chain = cm.load_chain(name) or {}
        order = [str(c) for c in (chain.get("order") or [])]
    except Exception:
        return True
    if not order:
        return True
    archive = {}
    for cid in order:
        try:
            m = cm.load_clip(name, cid) or {}
        except Exception:
            continue
        sh = str(m.get("shot") or "")
        if sh:
            archive[sh] = cid
    segs = pkg.get("segments") or []
    for k, s in enumerate(segs, 1):
        shot = str(s.get("shot") or shot_at(k))
        cid = str(s.get("cid") or cid_at(k))
        if shot in archive and archive[shot] != cid:
            raise ValueError(
                "段 %d 的分段身份 %s 在档案里已属于 %s，与本次要写的 %s 冲突。\n"
                "多半是工程包段落顺序被改过、或残留了旧段。请先清掉冲突的档案段，"
                "或换一个片名。" % (k, shot, archive[shot], cid))
    return True


def _check_assets_on_disk(name, pkg):
    """4-E 素材在盘性前置校验：被段引用的正式视图文件必须真的在盘上。

    只对「不会再重新生图」的场景（从指定段续跑）有意义；全流程/仅补资产会先
    跑生图，此处不校验（否则必然误报「素材还没生成」）。
    """
    groups = (pkg.get("assets") or [])
    segs = pkg.get("segments") or []
    needed = set()
    for s in segs:
        for tok in (s.get("seg_refs") or []):
            needed.add(str(tok))
    missing = []
    for g in groups:
        gid = str(g.get("id") or "")
        if gid not in needed and str(g.get("alias") or "") not in needed:
            continue
        v = _key_anchor(g)
        if v is None or not v.get("file"):
            missing.append("%s（没有正式视图）" % gid)
            continue
        if not rel_exists(v["file"]):
            missing.append("%s（文件不在 input/：%s）" % (gid, v["file"]))
    if missing:
        raise ValueError("素材在盘性校验没过（已拦下，本次没有提交）：\n"
                         + "\n".join("  · " + m for m in missing))
    return True


def rel_exists(rel):
    return bool(rel) and os.path.isfile(
        os.path.join(folder_paths.get_input_directory(), str(rel).replace("/", os.sep)))


# ---------------------------------------------------------------------------
# tensor / PIL 工具
# ---------------------------------------------------------------------------
def _tensor_to_pil(t):
    arr = (t.detach().cpu().clamp(0, 1).numpy() * 255.0)
    arr = np.rint(arr).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def _pil_to_tensor(img):
    arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _save_tensor_png(t, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _tensor_to_pil(t).save(path, "PNG")


def make_contact_sheet(images, labels=None, thumb_h=384, gap=10):
    """横排编号联系表。images: [N,H,W,3] tensor；labels: 每张下方小字。"""
    n = int(images.shape[0])
    pils = []
    for i in range(n):
        im = _tensor_to_pil(images[i])
        w = max(1, int(im.width * thumb_h / im.height))
        im = im.resize((w, thumb_h), Image.LANCZOS)
        pils.append(im)
    cap_h = 26 if labels else 0
    total_w = sum(im.width for im in pils) + gap * (n + 1)
    total_h = thumb_h + gap * 2 + cap_h
    sheet = Image.new("RGB", (total_w, total_h), (245, 245, 247))
    dr = ImageDraw.Draw(sheet)
    x = gap
    for i, im in enumerate(pils):
        sheet.paste(im, (x, gap))
        r = 16
        dr.ellipse([x + 6, gap + 6, x + 6 + r * 2, gap + 6 + r * 2],
                   fill=(0, 113, 227))
        dr.text((x + 6 + r - 5, gap + 9), str(i + 1), fill=(255, 255, 255))
        if labels:
            dr.text((x + 4, gap + thumb_h + 5), str(labels[i])[:28],
                    fill=(60, 60, 67))
        x += im.width + gap
    return _pil_to_tensor(sheet)


# ---------------------------------------------------------------------------
# assets.json 维护
# ---------------------------------------------------------------------------
def _find_group(assets, gid_or_alias):
    """按 id 或别名查组（读取侧用：引用素材时 id / 别名都能指到）。"""
    key = str(gid_or_alias or "").strip()
    for g in assets.get("groups", []):
        if str(g.get("id")) == key or str(g.get("alias")) == key:
            return g
    return None


def _find_group_by_id(assets, gid):
    """只按 id 精确查组（写入侧用：id 是权威，别名不能顶替 id 定位组）。"""
    key = str(gid or "").strip()
    for g in assets.get("groups", []):
        if str(g.get("id")) == key:
            return g
    return None


def _find_view(group, view_name):
    for v in group.get("views", []):
        if str(v.get("view")) == str(view_name):
            return v
    return None


def _upsert_view(assets, gid, alias, role, seg, view_name, fields):
    gid = str(gid or "").strip()
    alias = str(alias or "").strip()
    groups = assets.setdefault("groups", [])
    # 写入按 id 精确定位组（不能用别名顶替 id —— 否则「ID 不同、别名相同」的
    # 两组会把视图写串进对方，改 A 的图 B 跟着变）。见 20261017 串组 bug。
    g = _find_group_by_id(assets, gid)
    # 别名唯一性校验：别名已被**别的组**占用就直接报错，绝不静默写进别人的组。
    if alias:
        for x in groups:
            if x is not g and str(x.get("alias") or "") == alias:
                raise ValueError(
                    "资产入库：别名「%s」已被组 %s 占用，无法再用于组 %s。"
                    "请改用一个不同的别名（别名在整部片子里必须唯一）。"
                    % (alias, x.get("id"), gid))
    if g is None:
        g = {"id": gid, "alias": alias, "role": str(role or ""),
             "seg": str(seg or ""), "views": []}
        groups.append(g)
    else:
        g.setdefault("views", [])
        if alias:
            g["alias"] = alias
        if role:
            g["role"] = str(role)
        if seg:
            g["seg"] = str(seg)
    v = _find_view(g, view_name)
    if v is None:
        v = {"view": str(view_name)}
        g["views"].append(v)
    v.update(fields)
    if fields.get("key_anchor"):
        for o in g["views"]:
            if o is not v:
                o["key_anchor"] = False
    return g, v


def _key_anchor(group):
    for v in group.get("views", []):
        if v.get("key_anchor"):
            return v
    return (group.get("views") or [None])[0]


_PICK_NUM_RE = re.compile(r"(?:第\s*)?(\d{1,3})\s*[张个幅号]?")


def parse_pick(text, n):
    """从 VL 选图结论里解析编号（1..n）；解析不出返回 0。"""
    if not text:
        return 0
    for m in _PICK_NUM_RE.finditer(str(text)):
        k = int(m.group(1))
        if 1 <= k <= n:
            return k
    nums = [int(x) for x in re.findall(r"\d+", str(text))]
    for k in nums:
        if 1 <= k <= n:
            return k
    return 0


# ---------------------------------------------------------------------------
# refs 引用语法解析："a1"=组主锚；"a1/视图名"=指定视图；也接受 "别名/视图"
# ---------------------------------------------------------------------------
def resolve_ref(assets, token):
    token = str(token or "").strip()
    if not token:
        return None
    gpart, _, vpart = token.partition("/")
    g = _find_group(assets, gpart.strip())
    if g is None:
        return None
    v = _find_view(g, vpart.strip()) if vpart.strip() else _key_anchor(g)
    if v is None or not v.get("file"):
        return None
    kind = str(g.get("kind") or "image").strip().lower()
    if kind not in ("image", "video", "audio"):
        kind = "image"
    return {"file": v["file"], "kind": kind,
            "alias": [str(g.get("alias") or g.get("id")), str(v.get("view"))]}


def build_refs_json(images, videos=None, audios=None):
    """三路素材 → H3_REFS JSON（媒体架/导演台/Qwen 台同口径）。

    images/videos/audios: [{file, alias?}]；缺省只给图，向后兼容旧调用。
    """
    def _slots(items):
        out = []
        for it in items or []:
            if not isinstance(it, dict) or not it.get("file"):
                continue
            s = {"file": str(it.get("file"))}
            if it.get("alias"):
                al = it["alias"]
                s["alias"] = al if isinstance(al, list) else [str(al)]
            out.append(s)
        return out
    return json.dumps({"slots": {"images": _slots(images),
                                 "videos": _slots(videos),
                                 "audios": _slots(audios)},
                       "audio_out": 0}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# h3_data 段配置（N1 预览 / N3 每段改写共用）
# ---------------------------------------------------------------------------
def _empty_slots():
    return {"first": {}, "last": {},
            "images": [{} for _ in range(9)],
            "videos": [{}, {}, {}],
            "audios": [{}, {}, {}]}


def cid_at(k):
    return "clip_%04d" % k


def shot_at(k):
    return "s%02d" % k


def build_h3_data(pkg, seg, k, latent_file=""):
    """k 从 1 开始。latent_file 非空 = 续段（值仅作开关，认档走 N4 写的 cont_saved）。"""
    meta = pkg.get("meta") or {}
    cont = {"mode": str(meta.get("cont") or "latent")}
    if k > 1 or latent_file:
        cont.update({"latent_file": latent_file or "auto",
                     "frames": CONT_HEAD_FRAMES, "audio": True, "flatten": 0,
                     # strict（2-B）：中枢续段不猜档，上一段没写 cont_saved 凭据
                     # 就报错中止，绝不退回「扫目录取最新」的 mtime 兜底。
                     "strict": True})
    global_text = str(pkg.get("global") or "")
    seg_text = str((seg or {}).get("prompt_seg") or "")
    prompt = (global_text + "\n" + seg_text).strip()
    render = pkg.get("render") or {}
    return {
        "mode": "ref2va",
        "width": int(meta.get("width") or 928),
        "height": int(meta.get("height") or 544),
        "ratio": str(meta.get("ratio") or "16:9"),
        "length": int((seg or {}).get("length") or
                      (NEXT_CLIP_LENGTH if k > 1 else FIRST_CLIP_LENGTH)),
        # 20261026：删掉 redo_mode / redo_anchor（重抽档位、骨架钉帧三件套）。
        # 钉帧只留 pin_head / pin_tail —— 续接必需，且不再碰中间帧。
        "pin_head": 0, "pin_tail": CONT_HEAD_FRAMES,
        "ref_image_size": str(render.get("ref_image_size") or "match"),
        "ref_video_size": int(render.get("ref_video_size") or 768),
        "ref_video_fps": int(meta.get("fps") or FPS),
        "ref_scale_hd": 1,
        "pace": 2.5,  # 后端不读，仅占位；运镜节奏一律写进 prompt
        "prompt": prompt,
        "slots": _empty_slots(),
        "cont": cont,
        "chain": {"name": str(meta.get("片名") or ""),
                  "clip": cid_at(k), "shot": shot_at(k)},
        # 中枢模板专用标记：cast 后端据此识别「我是中枢模板跑出来的段」，
        # 从而跳过「手工导演台 vs 中枢工程」的互斥检查（否则中枢自己跑视频段
        # 会被自己的互斥逻辑拦死）；2-B 的 strict 续接也复用这个标记。
        "producer": True,
    }


# ===========================================================================
# N2a · 📥 资产入库
# ===========================================================================
class BanzhangProducerLibraryIn:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "工程名": ("STRING", {"default": ""}),
                "组编号": ("STRING", {"default": "a1",
                    "tooltip": "资产编号，如 a1、a2，同一角色/场景保持一致"}),
                "别名": ("STRING", {"default": "主角"}),
                "类型": (["全局角色（每段都可能出现）", "场景", "道具"],
                        {"default": "全局角色（每段都可能出现）"}),
                "归属段": ("STRING", {"default": "",
                    "tooltip": "场景/道具首次出场的段，如 clip_0001；全局角色留空"}),
                "视图名": ("STRING", {"default": "主锚"}),
                "主锚": ("BOOLEAN", {"default": True,
                    "tooltip": "主锚=该角色/场景的标准定妆/定场图，每组只有一张"}),
                "图片": ("IMAGE",),
                "模式": (["入库并选图", "仅重选（用盘上候选重新挑）"],
                        {"default": "入库并选图"}),
            },
            "optional": {
                "选图结论": ("STRING", {"forceInput": True, "default": ""}),
                "手动选用编号": ("INT", {"default": 0, "min": 0, "max": 999}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "H3_REFS", "STRING")
    RETURN_NAMES = ("🗂️ 资产清单", "🖼️ 联系表", "🧰 视图素材", "📄 报告")
    FUNCTION = "ingest"
    OUTPUT_NODE = True
    CATEGORY = "👨‍🏫班长/AI制片中枢"

    def ingest(self, 工程名, 组编号, 别名, 类型, 归属段, 视图名, 主锚, 图片,
               模式, 选图结论=None, 手动选用编号=0):
        name = str(工程名).strip()
        if not name:
            raise ValueError("资产入库：工程名不能为空。")
        gid = str(组编号).strip() or "a1"
        alias = str(别名 or gid).strip()
        view = str(视图名).strip()
        role_en = _role_to_en(类型)
        assets = load_assets(name)
        reports = []

        n = int(图片.shape[0])
        existing = _find_view((_find_group_by_id(assets, gid) or {}), view)

        if 模式 == "入库并选图":
            # 1) 全量候选落盘（每次入库重写 c1..cN）
            cand_rels = []
            for i in range(n):
                dst = cand_abs(name, alias, view, i + 1)
                _save_tensor_png(图片[i], dst)
                # 内容去重：盘上已有这张图就删掉刚写的这份、直接指过去
                same = dedup_existing(name, dst)
                if same:
                    try:
                        os.remove(dst)
                    except Exception:
                        pass
                    cand_rels.append(same)
                else:
                    cand_rels.append(cand_rel(name, alias, view, i + 1))
            reports.append("候选 %d 张已归档 candidates/" % n)
            chosen = int(手动选用编号 or 0) or parse_pick(选图结论, n) or 1
        else:
            # 仅重选：候选已在盘上
            if existing is None or not existing.get("candidates"):
                raise ValueError("资产入库·仅重选：盘上没有该视图的候选，"
                                 "请先跑一次「入库并选图」。")
            cand_rels = list(existing["candidates"])
            n = len(cand_rels)
            chosen = int(手动选用编号 or 0) or parse_pick(选图结论, n) or \
                int(existing.get("chosen") or 1)

        if not (1 <= chosen <= n):
            chosen = 1
        # 2) 晋升正式视图（内容寻址：盘上已有相同图就复用，不再复制一份）
        src = os.path.join(folder_paths.get_input_directory(),
                           cand_rels[chosen - 1].replace("/", os.sep))
        status = "chosen" if (选图结论 or 手动选用编号) else "pending"
        file_rel = dedup_existing(name, src)
        # 命中的若是本工程候选目录下的临时文件，不认（候选会被清理，正式视图
        # 不能挂在临时文件上）—— 仍走正常复制，保证正式视图始终有独立实体。
        cand_prefix = os.path.join(PRODUCER_SUBDIR, _safe_fs(name), "candidates").replace(os.sep, "/")
        if file_rel and not file_rel.startswith(cand_prefix):
            reports.append("复用已有素材，未重复落盘：%s" % file_rel)
        else:
            file_rel = ""
            dst = view_abs(name, alias, view)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            file_rel = view_rel(name, alias, view)
        _upsert_view(
            assets, gid, alias, role_en, 归属段, view,
            {"key_anchor": bool(主锚), "file": file_rel,
             "candidates": cand_rels, "chosen": chosen, "status": status,
             "note": str(选图结论 or "")[:500]})
        save_assets(name, assets)
        reports.append("已晋升第 %d/%d 张为正式视图：%s（%s）"
                       % (chosen, n, file_rel,
                          "待人工确认" if status == "pending" else "已确认"))

        # 3) 联系表（重新读盘，保证仅重选模式也能出图）
        sheet_imgs = []
        for cr in cand_rels:
            p = os.path.join(folder_paths.get_input_directory(),
                             cr.replace("/", os.sep))
            sheet_imgs.append(_pil_to_tensor(Image.open(p))[0])
        sheet = torch.stack(sheet_imgs, dim=0)
        labels = ["%d%s" % (i + 1, " ✓" if i + 1 == chosen else "")
                  for i in range(n)]
        contact = make_contact_sheet(sheet, labels)

        refs = build_refs_json([{"file": file_rel, "alias": [alias, view]}])
        report = "\n".join("%s %s" % (_TAG, r) for r in reports)
        print(report)
        return (json.dumps(assets, ensure_ascii=False), contact, refs, report)


# ===========================================================================
# N2b · 🗂️ 资产架
# ===========================================================================
class BanzhangProducerRack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "工程名": ("STRING", {"default": ""}),
                "视图": (["视频段", "生图参考"], {"default": "视频段"}),
                "当前段": ("STRING", {"default": "clip_0001"}),
            },
            "optional": {
                "生图参考别名": ("STRING", {"default": "",
                    "tooltip": "视图=生图参考时生效，逗号分隔，如 a1,a2/全景"}),
                "引用清单": ("STRING", {"default": "", "forceInput": False,
                    "tooltip": "JSON 数组，如 [\"a1\",\"a2/全景\"]；视频段视图下"
                               "留空则自动挂全局主锚＋本段场景主锚"}),
            },
        }

    RETURN_TYPES = ("H3_REFS", "STRING", "STRING")
    RETURN_NAMES = ("参考素材", "rack_data", "📄 报告")
    FUNCTION = "emit"
    CATEGORY = "👨‍🏫班长/AI制片中枢"

    def emit(self, 工程名, 视图, 当前段, 生图参考别名="", 引用清单=""):
        name = str(工程名).strip()
        if not name:
            raise ValueError("资产架：工程名不能为空。")
        # 丢进目录的媒体文件自动入库（3-B）：mp4/wav 等按扩展名定 kind、按文件名
        # 定别名，不必手改 assets.json。
        _ingested = ingest_media_dir(name)
        assets = load_assets(name)
        groups = assets.get("groups") or []
        tokens = []

        if 视图 == "生图参考":
            tokens = [t for t in re.split(r"[,，、;；\s]+", str(生图参考别名)) if t.strip()]
        else:
            tokens = self._parse_ref_list(引用清单)
            if not tokens:
                # 自动兜底：全局主锚 ＋ 归属当前段的场景/道具主锚
                for g in groups:
                    v = _key_anchor(g)
                    if v is None or not v.get("file"):
                        continue
                    if str(g.get("role") or "") == "global" or \
                            str(g.get("seg") or "") == str(当前段):
                        tokens.append(str(g.get("id")))

        images, videos, audios, missing, seen = [], [], [], [], set()
        for tok in tokens:
            ref = resolve_ref(assets, tok)
            if ref is None:
                missing.append(tok)
                continue
            if ref["file"] in seen:
                continue
            seen.add(ref["file"])
            if not rel_exists(ref["file"]):
                missing.append(tok + "（文件不在 input/）")
                continue
            if ref.get("kind") == "video":
                videos.append(ref)
            elif ref.get("kind") == "audio":
                audios.append(ref)
            else:
                images.append(ref)

        warns = []
        if len(images) > RACK_SOFT_WARN:
            warns.append("挂了 %d 张参考图，超过面板兜底 9 槽（外接可动态扩槽，"
                         "硬上限 %d，注意注意力质量）" % (len(images), REF_LIMIT))
        if len(images) >= REF_LIMIT:
            images = images[:REF_LIMIT]
            warns.append("图片达到硬上限 %d，已截断" % REF_LIMIT)
        if len(videos) > MAX_VIDEOS:
            videos = videos[:MAX_VIDEOS]
            warns.append("视频超过 %d 个，已截断" % MAX_VIDEOS)
        if len(audios) > MAX_AUDIOS:
            audios = audios[:MAX_AUDIOS]
            warns.append("音频超过 %d 个，已截断" % MAX_AUDIOS)
        if missing:
            warns.append("以下引用未解析：%s" % "、".join(missing))
        if _ingested:
            warns.append("自动入库 %d 个媒体文件（丢进目录的素材已登记）" % _ingested)

        refs = build_refs_json(images, videos, audios)
        report = "%s 资产架[%s/%s] 挂图 %d 张 / 视频 %d / 音频 %d：%s%s" % (
            _TAG, 视图, 当前段, len(images), len(videos), len(audios),
            "、".join("/".join(x["alias"])
                      for x in (images + videos + audios)) or "（无）",
            ("\n⚠ " + "\n⚠ ".join(warns)) if warns else "")
        print(report)
        return (refs, refs, report)

    @staticmethod
    def _parse_ref_list(raw):
        raw = str(raw or "").strip()
        if not raw:
            return []
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return [str(x) for x in data]
        except Exception:
            pass
        return [t for t in re.split(r"[,，、;；\s]+", raw) if t.strip()]


# ===========================================================================
# N1 · ✨ AI 制片中枢
# ===========================================================================
def _load_translator_cls():
    try:
        from ..banzhang_translator.banzhang_ai_translator import BanzhangAITranslator
        return BanzhangAITranslator
    except Exception:
        from banzhang_translator.banzhang_ai_translator import BanzhangAITranslator
        return BanzhangAITranslator


try:
    _TranslatorCls = _load_translator_cls()
    _PROVIDERS = _TranslatorCls.INPUT_TYPES().get("required", {}).get(
        "🌐 API服务商", ([],))[0] or ["Doubao (豆包/火山)"]
except Exception as _e:
    _TranslatorCls = None
    _PROVIDERS = ["Doubao (豆包/火山)"]
    _log("⚠ BanzhangAITranslator 加载失败：%s" % _e)


_CANVAS = {
    "横屏 16:9 (928x544)": (928, 544, "16:9"),
    "竖屏 9:16 (544x928)": (544, 928, "9:16"),
    "方屏 1:1 (768x768)": (768, 768, "1:1"),
}
_RICHNESS = ["精简（只出主角+主场景）", "标准（推荐）", "丰富（多角度+道具特写）"]
_PICKERS = {"AI看图选图（推荐，需多模态模型）": "vl",
            "人工选图（看联系表自己填编号）": "manual",
            "直接用第1张（不挑选）": "none"}
# 类型下拉：面板纯中文，工程包内部仍用 global/scene/prop
_ROLE_CN = {"global": "全局角色（每段都可能出现）",
            "scene": "场景", "prop": "道具"}
_ROLE_EN = {"全局角色（每段都可能出现）": "global",
            "全局角色": "global", "场景": "scene", "道具": "prop"}
_MODES_CN = ["全自动闭环（生图+视频一条龙）", "只生成工程文件（不排队）",
             "只补参考图（不渲染视频）", "从指定段续跑视频"]
_MODES_EN = {"全自动闭环（生图+视频一条龙）": "全流程DAG",
             "只生成工程文件（不排队）": "仅写工程文件",
             "只补参考图（不渲染视频）": "仅补资产",
             "从指定段续跑视频": "从指定段续跑"}


def _role_to_en(v):
    s = str(v or "全局角色（每段都可能出现）")
    if s in _ROLE_EN:
        return _ROLE_EN[s]
    return s if s in ("global", "scene", "prop") else "global"


class BanzhangAIProducer:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "🔑 API密钥": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "大模型服务商给你的密钥，以 sk- 开头"}),
                "🌐 服务商": (_PROVIDERS, {"default": _PROVIDERS[0]}),
                "🔗 自定义地址": ("STRING", {"default": "",
                    "tooltip": "用中转/本地服务时填网址，官方服务商留空"}),
                "🤖 编剧模型": ("STRING", {"default": "",
                    "tooltip": "填服务商给的模型英文名（如 doubao-...-pro）；不会填可先留空试默认"}),
                "🤖 编译模型": ("STRING", {"default": "",
                    "tooltip": "留空则与编剧模型相同"}),
                "💬 一句话创意": ("STRING", {
                    "default": "例：雨夜太原站前，一名机甲武士与全息龙对视后转身离去，赛博东方玄幻。",
                    "multiline": True}),
                "🎬 片名": ("STRING", {"default": "未命名短片"}),
                "📐 画幅": (list(_CANVAS.keys()), {"default": list(_CANVAS.keys())[0]}),
                "⏱️ 总秒数": ("INT", {"default": 30, "min": 15, "max": 600}),
                "✂️ 单段秒数": ("INT", {"default": 15, "min": 15, "max": 15,
                    "tooltip": "固定 15 秒一段，已按模型要求锁定"}),
                "🎚️ 丰富度": (_RICHNESS, {"default": _RICHNESS[1]}),
                "🔢 主锚候选数": ("INT", {"default": 4, "min": 1, "max": 12,
                    "tooltip": "每个角色/场景先生几张定妆图供挑选"}),
                "🔢 普通视图候选": ("INT", {"default": 1, "min": 1, "max": 12}),
                "🧠 选图方式": (list(_PICKERS.keys()),
                            {"default": list(_PICKERS.keys())[0]}),
                "🤖 选图模型": ("STRING", {"default": "",
                    "tooltip": "AI看图选图用，必须是会看图的多模态模型；留空则自动退化为直接用第1张"}),
                "🌡️ 编剧温度": ("FLOAT", {"default": 0.8, "min": 0, "max": 2, "step": 0.05,
                    "tooltip": "越高创意越奔放，越低越听话；编剧0.8、编译器自动用0"}),
                "🔢 最大字数(万Token)": ("FLOAT", {"default": 4.0, "min": 0.1, "max": 32, "step": 0.1}),
                "🎲 随机种子": ("INT", {"default": 9, "min": 0, "max": 0xffffffffffffffff,
                    "tooltip": "换一个数字，AI 会给出不同的剧本"}),
            },
            "optional": {
                "🖼️ 风格参考": ("IMAGE",),
                "📝 修订意见": ("STRING", {"forceInput": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("📦 工程包", "✍️ 首段合订词", "🎛️ 首段h3配置",
                    "🗂️ 资产清单", "🗺️ 生图任务表", "📄 运行报告")
    FUNCTION = "produce"
    CATEGORY = "👨‍🏫班长/AI制片中枢"

    # -- 主流程 -----------------------------------------------------------
    def produce(self, **kw):
        if _TranslatorCls is None:
            raise RuntimeError("BanzhangAITranslator 不可用，无法调用外部 LLM。")
        w, h, ratio = _CANVAS[kw["📐 画幅"]]
        seg_sec = int(kw["✂️ 单段秒数"])
        nseg = max(1, int(np.ceil(int(kw["⏱️ 总秒数"]) / seg_sec)))
        picker = _PICKERS[kw["🧠 选图方式"]]
        anchor_pick = 1 if picker == "none" else int(kw["🔢 主锚候选数"])
        view_pick = 1 if picker == "none" else int(kw["🔢 普通视图候选"])
        film_name = str(kw["🎬 片名"]).strip()
        if not film_name:
            raise ValueError("🎬 片名不能为空：它同时是归档目录名，留空会和别的工程撞名。")
        panel = {
            "片名": film_name,
            "width": w, "height": h, "ratio": ratio,
            "fps": FPS, "seg_sec": seg_sec,
            "total_sec": int(kw["⏱️ 总秒数"]),
            "丰富度": str(kw["🎚️ 丰富度"]).split("（")[0], "picker": picker,
            "anchor_pick": anchor_pick, "view_pick": view_pick,
            "brief": str(kw["💬 一句话创意"]).strip(),
            "nseg": nseg,
        }
        reports = []

        param_line = json.dumps({
            "片名": panel["片名"], "画幅": "%dx%d(%s)" % (w, h, ratio),
            "总秒数": panel["total_sec"], "单段秒数": seg_sec,
            "段数": nseg, "fps": FPS, "丰富度": panel["丰富度"],
            "主锚候选数": anchor_pick, "普通视图候选": view_pick,
            "选图方式": {"vl": "AI看图选图", "manual": "人工选图",
                      "none": "直接用第1张"}[picker],
        }, ensure_ascii=False)
        user1 = "【参数】%s\n【创意】%s" % (param_line, panel["brief"])
        if kw.get("📝 修订意见"):
            user1 += "\n【本轮修订意见】%s" % str(kw["📝 修订意见"])

        t = _TranslatorCls()
        # 第一次：编剧（温度 0.8）
        ok1, c1, r1 = self._call(t, kw, "ai_producer_h3", user1,
                                 float(kw["🌡️ 编剧温度"]),
                                 kw.get("🖼️ 风格参考"),
                                 str(kw["🤖 编剧模型"]))
        reports.append(r1)
        # 第二次：编译（温度 0）
        user2 = ("【系统参数】%s\n【编剧稿如下，请编译为 Schema v4 严格 JSON】\n\n%s"
                 % (param_line, c1 or "（编剧调用失败，请基于创意生成最小合规包）"))
        model2 = str(kw["🤖 编译模型"]).strip() or str(kw["🤖 编剧模型"])
        ok2, c2, r2 = self._call(t, kw, "ai_producer_compile", user2, 0.0,
                                 None, model2)
        reports.append(r2)

        raw = None
        if c2:
            try:
                raw = t._extract_json_from_text(c2)
            except Exception:
                raw = None
        if isinstance(raw, list):
            raw = None
        degraded = False
        if not isinstance(raw, dict) or not raw.get("segments"):
            degraded = True
            reports.append("%s ⚠ 编译器未返回有效工程包，已降级为最小占位包，"
                           "请人工补写资产与分镜。" % _TAG)
            raw = self._fallback(panel)

        pkg = self._normalize(raw, panel)
        # 落盘前先确认这个片名没被手工导演台工程占着（两套共用同一个档案目录）
        assert_no_manual_project(panel["片名"])
        # 落盘
        _write_json(pkg_path(panel["片名"]), pkg)
        assets_db = {"groups": pkg["assets"]}
        save_assets(panel["片名"], assets_db)
        reports.append("%s 工程包已写入 input/%s/%s/（pkg.json + assets.json）"
                       % (_TAG, PRODUCER_SUBDIR, _safe_fs(panel["片名"])))

        seg1 = pkg["segments"][0]
        first_prompt = (str(pkg.get("global") or "") + "\n" +
                        str(seg1.get("prompt_seg") or "")).strip()
        first_h3 = build_h3_data(pkg, seg1, 1)
        tasks = []
        for g in pkg["assets"]:
            for v in g["views"]:
                tasks.append({"gid": g["id"], "alias": g["alias"],
                              "role": g["role"], "gseg": g.get("seg", ""),
                              "view": v["view"], "key_anchor": bool(v.get("key_anchor")),
                              "pick": int(v.get("pick") or 1),
                              "picker": panel["picker"],
                              "refs_from": v.get("refs_from") or [],
                              "canvas": v.get("canvas") or "%dx%d" % (w, h),
                              "prompt": v.get("prompt") or "",
                              "seg": v.get("seg", "")})
        nviews = len(tasks)
        nrefs = sum(len(s.get("seg_refs") or []) for s in pkg["segments"])
        reports.insert(0, "%s ✨ 工程《%s》：%d 段 / %d 个资产组 / %d 个生图视图 / "
                       "段落引用 %d 处%s" %
                       (_TAG, panel["片名"], nseg, len(pkg["assets"]),
                        nviews, nrefs, "（降级包）" if degraded else ""))
        report = "\n".join(reports)
        print(report)
        return (json.dumps(pkg, ensure_ascii=False), first_prompt,
                json.dumps(first_h3, ensure_ascii=False),
                json.dumps(assets_db, ensure_ascii=False),
                json.dumps({"views": tasks}, ensure_ascii=False),
                report)

    # -- translator 调用 --------------------------------------------------
    def _call(self, t, kw, preset, user, temperature, images, model):
        params = {
            "seed": int(kw["🎲 随机种子"]),
            "🔑 API_KEY": str(kw["🔑 API密钥"]),
            "🌐 API服务商": kw["🌐 服务商"],
            "🔗 自定义地址": str(kw["🔗 自定义地址"]),
            "🤖 模型名称": str(model or ""),
            "🎨 提示词预设": preset,
            "🧠 系统指令 (指令)": "",
            "🗣️ 用户提示 (正文)": user,
            "🔢 最大Token (万)": float(kw["🔢 最大字数(万Token)"]),
            "🌡️ 采样温度": float(temperature),
            "🎬 视频帧率": int(FPS),
            "📉 媒体限制(边长)": 768,
        }
        if images is not None:
            params["🗂️ 参考素材"] = images
        try:
            ret = t.generate_content(**params)
            content = ret[1] if isinstance(ret, (list, tuple)) and len(ret) > 1 else ""
            note = str(ret[0])[:200] if isinstance(ret, (list, tuple)) and ret else ""
            return True, content or "", "%s 预设 %s 调用完成。%s" % (
                _TAG, preset, note)
        except Exception as e:
            return False, "", "%s ⚠ 预设 %s 调用失败：%s" % (_TAG, preset, e)

    # -- 规范化 -----------------------------------------------------------
    def _normalize(self, raw, p):
        w, h = p["width"], p["height"]
        canvas = "%dx%d" % (w, h)
        # 1) 资产重排 id，建立引用映射
        old_assets = raw.get("assets") or []
        groups, id_map, alias_map = [], {}, {}
        view_keys = set()

        def remap_token(tok):
            tok = str(tok or "").strip()
            gpart, _, vpart = tok.partition("/")
            ng = id_map.get(gpart) or alias_map.get(gpart)
            if ng is None:
                return None
            return ng if not vpart else ng + "/" + vpart.strip()

        for i, g0 in enumerate(old_assets, 1):
            nid = "a%d" % i
            old_id = str(g0.get("id") or g0.get("alias") or nid)
            alias = str(g0.get("alias") or old_id)
            id_map[old_id] = nid
            alias_map[alias] = nid
            views0 = g0.get("views") or []
            has_explicit_anchor = any(bool(x.get("key_anchor")) for x in views0)
            views = []
            for j, v0 in enumerate(views0):
                # 显式标注优先；整组都没标时才把第一个视图定为主锚
                is_anchor = bool(v0.get("key_anchor")) if has_explicit_anchor \
                    else (j == 0)
                if is_anchor and any(x.get("key_anchor") for x in views):
                    is_anchor = False
                pick = int(v0.get("pick") or
                           (p["anchor_pick"] if is_anchor else p["view_pick"]))
                if p["picker"] == "none":
                    pick = 1
                views.append({
                    "view": str(v0.get("view") or ("主锚" if is_anchor else "视图%d" % j)),
                    "key_anchor": bool(is_anchor),
                    "pick": max(1, pick),
                    "refs_from": [str(x) for x in (v0.get("refs_from") or [])],
                    "canvas": str(v0.get("canvas") or canvas),
                    "prompt": str(v0.get("prompt") or p["brief"]),
                    "seg": str(v0.get("seg") or ""),
                })
                view_keys.add((nid, views[-1]["view"]))
            if not views:
                continue
            # 主锚稳定排到组内首位：保证主锚先生图、下游引用解析确定性
            views.sort(key=lambda x: 0 if x.get("key_anchor") else 1)
            groups.append({"id": nid, "alias": alias,
                           "role": str(g0.get("role") or "global"),
                           "seg": str(g0.get("seg") or ""), "views": views})

        # 2) refs_from 重映射 + 断环 + 指向不存在则清空
        def _strip_edges():
            color = {}

            def dfs(u):
                color[u] = 1
                gidx, vidx = u
                g = groups[gidx]
                v = g["views"][vidx]
                kept = []
                for tok in v["refs_from"]:
                    rt = remap_token(tok)
                    if rt is None:
                        continue
                    gp, _, vp = rt.partition("/")
                    gi = next((k for k, x in enumerate(groups) if x["id"] == gp), -1)
                    if gi < 0:
                        continue
                    vi = next((k for k, x in enumerate(groups[gi]["views"])
                               if x["view"] == (vp or _key_anchor(groups[gi])["view"])), -1)
                    if vi < 0:
                        continue
                    if color.get((gi, vi)) == 1:
                        continue  # 回边，断开
                    if color.get((gi, vi)) != 2:
                        dfs((gi, vi))
                    kept.append(rt)
                v["refs_from"] = kept
                color[u] = 2
            for gi, g in enumerate(groups):
                for vi in range(len(g["views"])):
                    if color.get((gi, vi)) != 2:
                        dfs((gi, vi))
        _strip_edges()

        # 3) 段落重排
        raw_segs = raw.get("segments") or []
        segs = []
        for k in range(1, p["nseg"] + 1):
            s0 = raw_segs[k - 1] if k - 1 < len(raw_segs) else {}
            refs = []
            for tok in (s0.get("seg_refs") or []):
                rt = remap_token(tok)
                if rt and rt not in refs:
                    refs.append(rt)
            if not refs and groups:
                refs = [groups[0]["id"]]
            refs = refs[:9]
            segs.append({
                "cid": cid_at(k), "shot": shot_at(k),
                "title": str(s0.get("title") or "第%d段" % k),
                "prompt_seg": str(s0.get("prompt_seg") or
                                  ("延续上一段镜头与情绪。\n" + p["brief"])),
                "seg_refs": refs,
                "seam": str(s0.get("seam") or "cut"),
                "length": FIRST_CLIP_LENGTH if k == 1 else NEXT_CLIP_LENGTH,
            })

        render = raw.get("render") or {}
        pkg = {
            "pkg_version": 4,
            "meta": {
                "片名": p["片名"], "width": w, "height": h, "ratio": p["ratio"],
                "fps": FPS, "seg_sec": p["seg_sec"], "total_sec": p["total_sec"],
                "丰富度": p["丰富度"], "picker": p["picker"],
                "brief": p["brief"],
                "created": time.time(),
            },
            "global": str(raw.get("global") or p["brief"]),
            "assets": groups,
            "segments": segs,
            "render": {
                "ref_image_size": str(render.get("ref_image_size") or "match"),
                "ref_video_size": int(render.get("ref_video_size") or 768),
            },
        }
        return pkg

    # -- 降级包 -----------------------------------------------------------
    def _fallback(self, p):
        canvas = "%dx%d" % (p["width"], p["height"])
        return {
            "global": p["brief"],
            "assets": [{
                "id": "a1", "alias": "主角", "role": "global", "seg": "",
                "views": [{
                    "view": "主锚", "key_anchor": True,
                    "pick": p["anchor_pick"], "refs_from": [],
                    "canvas": canvas,
                    "prompt": "（兜底占位，请人工改写）" + p["brief"], "seg": ""}],
            }],
            "segments": [{
                "cid": "clip_%04d" % k, "shot": "s%02d" % k,
                "title": "第%d段" % k,
                "prompt_seg": "（自动分镜失败，请人工补写本段分镜）\n" + p["brief"],
                "seg_refs": ["a1"], "seam": "cut",
            } for k in range(1, p["nseg"] + 1)],
        }


# ===========================================================================
# N3 · 🎬 DAG 编排器
# ===========================================================================
import copy as _copy

VL_PICK_SYS = ("你是电影美术选图师。用户给你同一角色/场景的多张候选定妆图（带编号），"
               "你只依据：角色辨识度、五官/服装与设定的一致性、构图端正度、光影干净度、"
               "可作为后续视频参考的稳定性，选出最佳 1 张。回复不超过 60 字，"
               "必须包含『第X张』。")
VL_PICK_USER = ("资产：{alias} / {view}。共 {n} 张候选（角标即编号）。"
                "请选出最适合作为视频参考主图的 1 张，明确回复『第X张』并一句话说明理由。")

_MODES = ["全流程DAG", "仅写工程文件", "仅补资产", "从指定段续跑"]


def _load_chain_mod():
    try:
        from .. import csglide_chain
        return csglide_chain
    except Exception:
        try:
            import csglide_chain
            return csglide_chain
        except Exception:
            return None


def _http_get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _http_post(url, payload, timeout=20):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def topo_views(pkg):
    """视图任务 Kahn 拓扑（refs_from 边）。返回 [(gid, view_name), ...]。"""
    groups = pkg.get("assets") or []
    gid_of = {}
    for g in groups:
        gid_of[str(g["id"])] = g["id"]
        gid_of[str(g.get("alias"))] = g["id"]

    def view_key(token):
        gp, _, vp = str(token).partition("/")
        gid = gid_of.get(gp.strip())
        if not gid:
            return None
        g = next(x for x in groups if x["id"] == gid)
        v = _find_view(g, vp.strip()) if vp.strip() else _key_anchor(g)
        return (gid, v["view"]) if v else None

    nodes, deps = [], {}
    for g in groups:
        for v in g.get("views") or []:
            k = (g["id"], v["view"])
            nodes.append(k)
            ds = []
            for tok in v.get("refs_from") or []:
                dk = view_key(tok)
                if dk and dk != k and dk not in ds:
                    ds.append(dk)
            deps[k] = ds
    indeg = {k: 0 for k in nodes}
    children = {k: [] for k in nodes}
    for k, ds in deps.items():
        for d in ds:
            if d in indeg:
                indeg[k] += 1
                children[d].append(k)
    queue = sorted(k for k in nodes if indeg[k] == 0)
    out = []
    while queue:
        k = queue.pop(0)
        out.append(k)
        for c in children[k]:
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)
                queue.sort()
    if len(out) < len(nodes):  # 残环双保险：剩余节点追加在末尾
        out += [k for k in nodes if k not in out]
    return out


class BanzhangProducerDirector:
    def __init__(self):
        self.run_id = time.strftime("%Y%m%d%H%M%S")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "📦 工程包": ("STRING", {"forceInput": True,
                    "tooltip": "接 ✨AI制片中枢 的「📦工程包」输出口，不用手填"}),
                "🎬 工程名": ("STRING", {"default": "",
                    "tooltip": "留空则自动取工程包里的片名"}),
                "🚦 运行模式": (_MODES_CN, {"default": _MODES_CN[0]}),
                "▶ 起始段": ("INT", {"default": 1, "min": 1, "max": 999,
                    "tooltip": "从第几段开始（续跑时用）"}),
                "⏹ 截止段": ("INT", {"default": 0, "min": 0, "max": 999,
                    "tooltip": "0 = 一直做到最后一段"}),
                "🌐 本机软件地址": ("STRING", {"default": "http://127.0.0.1:8188",
                    "tooltip": "ComfyUI 本机网页地址，默认不用改"}),
                "🔑 选图API密钥": ("STRING", {"default": "",
                    "tooltip": "AI看图选图用的密钥；不用AI选图可留空"}),
                "🌐 选图服务商": (_PROVIDERS, {"default": _PROVIDERS[0]}),
                "🔗 选图自定义地址": ("STRING", {"default": ""}),
                "🤖 选图模型": ("STRING", {"default": "",
                    "tooltip": "必须是会看图的多模态模型；留空则自动退化为直接用第1张"}),
                "📁 模板目录": ("STRING", {"default": "",
                    "tooltip": "留空即可，自动用插件内置模板"}),
            },
            "optional": {
                "🗂️ 资产清单": ("STRING", {"forceInput": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("📄 编排报告")
    FUNCTION = "direct"
    OUTPUT_NODE = True
    CATEGORY = "👨‍🏫班长/AI制片中枢"

    def direct(self, **kwargs):
        工程包 = kwargs["📦 工程包"]
        工程名 = kwargs["🎬 工程名"]
        模式 = _MODES_EN.get(kwargs["🚦 运行模式"], "全流程DAG")
        起始段 = kwargs["▶ 起始段"]
        截止段 = kwargs["⏹ 截止段"]
        ComfyUI地址 = kwargs["🌐 本机软件地址"]
        选图API_KEY = kwargs["🔑 选图API密钥"]
        选图服务商 = kwargs["🌐 选图服务商"]
        选图自定义地址 = kwargs["🔗 选图自定义地址"]
        选图模型 = kwargs["🤖 选图模型"]
        模板目录 = kwargs["📁 模板目录"]
        资产清单 = kwargs.get("🗂️ 资产清单", "")
        lines = []
        try:
            pkg = json.loads(工程包)
        except Exception as e:
            raise ValueError("编排器：工程包不是合法 JSON：%s" % e)
        name = str(工程名).strip() or str((pkg.get("meta") or {}).get("片名") or "").strip()
        if not name:
            raise ValueError("编排器：工程名/片名缺失。")
        # 入队前同样挡一次：同片名会覆盖手工导演台工程的成片 / 续拍档 / 档案
        assert_no_manual_project(name)
        # 4-D 段 id 撞车自检：pkg 内 shot/cid 不得重复，且不得与档案里已有段的
        # shot 撞号（shot 相同但 clip 不同 = 段落顺序被改过/残留旧段 → 认档错位）。
        _validate_segment_ids(pkg)
        _check_segment_collision(name, pkg)

        # 资产清单：外接口优先，否则读盘
        assets_db = None
        if str(资产清单 or "").strip():
            try:
                assets_db = json.loads(资产清单)
            except Exception:
                assets_db = None
        if assets_db is None:
            assets_db = load_assets(name)
        # 始终以工程包 assets 为准落盘一次
        assets_db = {"project": name, "groups": pkg.get("assets") or []}
        _write_json(pkg_path(name), pkg)
        save_assets(name, assets_db)
        lines.append("%s 工程文件已同步：input/%s/%s/" %
                     (_TAG, PRODUCER_SUBDIR, _safe_fs(name)))

        if 模式 == "仅写工程文件":
            return (self._report(name, lines, [], []),)

        # 4-E 素材在盘性前置校验：从指定段续跑不会重新生图，缺素材就是真缺，
        # 入队前就拦，别等跑到第 7 段才发现、前 6 段白跑。
        if 模式 == "从指定段续跑":
            _check_assets_on_disk(name, pkg)

        tdir = str(模板目录).strip() or os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")
        wa = self._load_tpl(tdir, "producer_asset_qwen.json")
        wa_lite = self._load_tpl(tdir, "producer_asset_qwen_lite.json")
        wv = self._load_tpl(tdir, "producer_video_h3.json")
        cm = _load_chain_mod()

        posted, skipped, failed = [], [], []

        def post(graph, label):
            try:
                resp = _http_post(ComfyUI地址.rstrip("/") + "/prompt",
                                  {"prompt": graph,
                                   "client_id": CLIENT_ID_PREFIX + self.run_id})
                if resp.get("node_errors"):
                    failed.append("%s：节点校验错误 %s" %
                                  (label, json.dumps(resp["node_errors"],
                                                     ensure_ascii=False)[:300]))
                else:
                    posted.append("%s（队列号 %s）" % (label, resp.get("number")))
            except Exception as e:
                failed.append("%s：POST 失败 %s" % (label, e))

        # 独占检查（允许 running 里有主控图自己 1 个；pending 必须为空）
        try:
            q = _http_get(ComfyUI地址.rstrip("/") + "/queue")
            nr, np_ = len(q.get("queue_running") or []), len(q.get("queue_pending") or [])
            if np_ > 0 or nr > 1:
                lines.append("⚠ 队列非空（running=%d, pending=%d），已拒绝提交。"
                             "请等当前任务跑完、清空队列后再执行编排器。" % (nr, np_))
                return (self._report(name, lines, posted, failed),)
        except Exception as e:
            lines.append("⚠ 无法访问 %s/queue（%s），仍尝试继续提交。" %
                         (ComfyUI地址, e))

        # 运行期锁（4-C）：提交前给片名上锁，队列执行期间手工导演台跑同片名段
        # 会被 cast 后端拒绝，防止插队冲乱 chain.order（认档靠顺序）。
        if cm is not None:
            try:
                cm.set_producer_lock(name, self.run_id)
                lines.append("%s 已上运行锁（%s），手工导演台同片名段在队列执行期间"
                             "会被拒绝登记。" % (_TAG, name))
            except Exception as e:
                lines.append("⚠ 设置运行锁失败（%s），仍继续提交。" % e)

        vlcfg = {"key": 选图API_KEY, "prov": 选图服务商, "url": 选图自定义地址,
                 "model": 选图模型}

        # ---- 阶段 1：生图资产 DAG ----
        if 模式 in ("全流程DAG", "仅补资产"):
            order = topo_views(pkg)
            gmap = {g["id"]: g for g in pkg.get("assets") or []}
            for gid, vname in order:
                g = gmap[gid]
                v = _find_view(g, vname)
                rel = v.get("file") or view_rel(name, g["alias"], vname)
                if rel_exists(rel):
                    skipped.append("资产 %s/%s（正式视图已存在）" % (gid, vname))
                    continue
                pick = max(1, int(v.get("pick") or 1))
                use_vl = (pkg.get("meta", {}).get("picker") == "vl"
                          and pick > 1 and bool(str(选图模型 or 选图API_KEY).strip()))
                tpl = wa if use_vl else wa_lite
                if tpl is None:
                    failed.append("资产 %s/%s：模板缺失（%s）" %
                                  (gid, vname, "producer_asset_qwen.json"
                                   if use_vl else "producer_asset_qwen_lite.json"))
                    continue
                graph = self._render_asset(tpl, name, g, v, vlcfg)
                post(graph, "生图 %s/%s%s" %
                     (gid, vname, "（VL选图）" if use_vl else "（候选1直取）"))
                if failed:
                    lines.append("⛔ 生图任务提交失败，已中止后续视频段提交；"
                                 "修好后重新执行（已完成视图会自动跳过）。")
                    break

        # ---- 阶段 2：视频段 ----
        if 模式 in ("全流程DAG", "从指定段续跑") and not failed:
            segs = pkg.get("segments") or []
            nseg = len(segs)
            k0 = max(1, int(起始段))
            k1 = nseg if int(截止段) <= 0 else min(int(截止段), nseg)
            if wv is None:
                failed.append("视频模板 producer_video_h3.json 缺失")
            else:
                for k in range(k0, k1 + 1):
                    seg = segs[k - 1]
                    cid = cid_at(k)
                    done = bool(cm and os.path.isfile(cm.clip_film(name, cid, 1)))
                    if done:
                        skipped.append("视频段 %s（成片已存在）" % cid)
                        continue
                    if k > 1 and cm:
                        prev_film = cm.clip_film(name, cid_at(k - 1), 1)
                        if not os.path.isfile(prev_film):
                            lines.append("⚠ %s 的上一段成片尚不在盘（%s）；"
                                         "任务已入队，FIFO 执行时会先生成上一段，"
                                         "若仍缺失续接会报错。" % (cid, prev_film))
                    graph = self._render_video(wv, name, pkg, seg, k, cm)
                    post(graph, "视频段 %s（15s）" % cid)

        return (self._report(name, lines, posted, skipped, failed),)

    # -- 模板 -------------------------------------------------------------
    @staticmethod
    def _load_tpl(tdir, fn):
        p = os.path.join(tdir, fn)
        data = _read_json(p, None)
        if data is None:
            _log("⚠ 模板缺失：%s" % p)
        return data

    @staticmethod
    def _render_asset(tpl, name, g, v, vlcfg):
        gr = _copy.deepcopy(tpl)
        gr["rack"]["inputs"].update({
            "工程名": name, "视图": "生图参考", "当前段": "",
            "生图参考别名": ",".join(v.get("refs_from") or []),
            "引用清单": ""})
        m = re.match(r"\s*(\d+)\s*[x×*]\s*(\d+)\s*$", str(v.get("canvas") or ""))
        cw, ch = (int(m.group(1)), int(m.group(2))) if m else (928, 544)
        gr["qwen"]["inputs"]["qwen_data"] = json.dumps({
            "prompt": str(v.get("prompt") or ""),
            "negative_prompt": "", "ref_cap": 1024,
            "canvas_w": cw, "canvas_h": ch,
            "canvas_from_ref": False, "ref_long": False, "images": [],
        }, ensure_ascii=False)
        if "rep" in gr:
            gr["rep"]["inputs"]["amount"] = max(0, int(v.get("pick") or 1) - 1)
        gr["ks"]["inputs"]["seed"] = abs(
            hash("%s/%s" % (g["id"], v["view"]))) % (2 ** 31)
        for nid in ("n2a_in", "n2a_pick"):
            if nid in gr:
                gr[nid]["inputs"].update({
                    "工程名": name, "组编号": g["id"], "别名": g.get("alias"),
                    "类型": _ROLE_CN.get(g.get("role", "global"),
                                        "全局角色（每段都可能出现）"),
                    "归属段": g.get("seg", ""), "视图名": v["view"],
                    "主锚": bool(v.get("key_anchor"))})
        gr["n2a_in"]["inputs"]["模式"] = "入库并选图"
        gr["n2a_in"]["inputs"]["手动选用编号"] = 0
        if "n2a_pick" in gr:
            gr["n2a_pick"]["inputs"]["模式"] = "仅重选（用盘上候选重新挑）"
        if "vl" in gr:
            ins = gr["vl"]["inputs"]
            ins["🔑 API_KEY"] = vlcfg["key"]
            ins["🌐 API服务商"] = vlcfg["prov"]
            ins["🔗 自定义地址"] = vlcfg["url"]
            ins["🤖 模型名称"] = vlcfg["model"]
            ins["🎨 提示词预设"] = "无 (使用自定义)"
            ins["🧠 系统指令 (指令)"] = VL_PICK_SYS
            ins["🗣️ 用户提示 (正文)"] = VL_PICK_USER.format(
                alias=g.get("alias"), view=v["view"], n=int(v.get("pick") or 1))
            ins["🌡️ 采样温度"] = 0.2
        return gr

    @staticmethod
    def _render_video(tpl, name, pkg, seg, k, cm):
        gr = _copy.deepcopy(tpl)
        h3 = build_h3_data(pkg, seg, k, latent_file=("auto" if k > 1 else ""))
        gr["31"]["inputs"]["h3_data"] = json.dumps(h3, ensure_ascii=False)
        gr["31"]["inputs"]["refs"] = ["pr_rack", 0]
        gr["31"]["inputs"].pop("prompt_text", None)  # 回退 h3_data.prompt
        gr["pr_rack"]["inputs"].update({
            "工程名": name, "视图": "视频段", "当前段": cid_at(k),
            "生图参考别名": "",
            "引用清单": json.dumps(seg.get("seg_refs") or [], ensure_ascii=False)})
        join = gr["pr_join"]["inputs"]
        if k == 1:
            join["source_video"] = ""
        else:
            join["source_video"] = cm.clip_film(name, cid_at(k - 1), 1) if cm \
                else "output/h3_chain/%s/%s.mp4" % (_safe_fs(name), cid_at(k - 1))
        vc = gr["156"]["inputs"]
        vc["🏷️ 文件前缀"] = _safe_fs(name)
        for key in ("🖼️ 图像", "🎬 视频文件", "🎵 音频"):
            vc.pop(key, None)
        if k == 1:
            vc["🖼️ 图像"] = ["pr_join", 0]
            vc["🎵 音频"] = ["pr_join", 2]
        else:
            vc["🎬 视频文件"] = ["pr_join", 1]
        return gr

    @staticmethod
    def _report(name, lines, posted, skipped=None, failed=None):
        skipped = skipped or []
        failed = failed or []
        out = list(lines)
        out.append("")
        out.append("✅ 已提交 %d 个任务（FIFO 串行，请勿同时跑其他工作流）：" % len(posted))
        out += ["  · " + x for x in posted]
        if skipped:
            out.append("⏭ 跳过 %d 项（幂等）：" % len(skipped))
            out += ["  · " + x for x in skipped]
        if failed:
            out.append("❌ 失败 %d 项：" % len(failed))
            out += ["  · " + x for x in failed]
        else:
            out.append("任务已在后台按序执行；完成后段落档案在 output/h3_chain/%s/，"
                       "工程资产在 input/%s/%s/。" %
                       (_safe_fs(name), PRODUCER_SUBDIR, _safe_fs(name)))
        rep = "\n".join(out)
        print(rep)
        return rep


# ===========================================================================
# N4 · 📦 段尾归位
# ===========================================================================
_CONTEXT_LATENT_RE = re.compile(r"\.safetensors$", re.IGNORECASE)


def _latest_context_latent():
    """扫 output/h3_context/ 最新一份续拍档（_last_saved_cont 失效时兜底）。"""
    try:
        d = os.path.join(folder_paths.get_output_directory(), "h3_context")
        cands = [os.path.join(d, f) for f in os.listdir(d)
                 if _CONTEXT_LATENT_RE.search(f)]
        cands = [p for p in cands if os.path.isfile(p)]
        return max(cands, key=os.path.getmtime) if cands else None
    except Exception:
        return None


def _resolve_video_input(val):
    if not val:
        return ""
    if isinstance(val, dict):
        base = ""
        try:
            base = folder_paths.get_annotated_filepath(val)
        except Exception:
            base = ""
        if not base:
            fn = val.get("filename") or ""
            sub = val.get("subfolder") or ""
            if val.get("type") == "temp":
                base = os.path.join(folder_paths.get_temp_directory(), sub, fn)
            else:
                base = os.path.join(folder_paths.get_output_directory(), sub, fn)
        return base if base and os.path.isfile(base) else ""
    if not isinstance(val, str):
        getter = getattr(val, "get_stream_source", None)
        if callable(getter):
            try:
                info = getter()
            except Exception:
                info = None
            if isinstance(info, (tuple, list)) and info:
                return str(info[0]) if os.path.exists(str(info[0])) else ""
            if isinstance(info, str):
                return info if os.path.exists(info) else ""
        return ""
    s = str(val)
    if os.path.isfile(s):
        return s
    try:
        r = folder_paths.get_annotated_filepath(s)
        if r and os.path.isfile(r):
            return r
    except Exception:
        pass
    return ""


class BanzhangProducerClipAdopt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "顺序锚": ("*", {"tooltip": "接段落存档节点的段落id输出，仅用于保证执行顺序"}),
                "成片": ("*", {"tooltip": "接 VideoCombine 的🎬视频透传；续段 Join 已自行落片时可留空"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("📄 归位报告")
    FUNCTION = "adopt"
    OUTPUT_NODE = True
    CATEGORY = "👨‍🏫班长/AI制片中枢"

    def adopt(self, 顺序锚=None, 成片=None):
        cm = _load_chain_mod()
        if cm is None:
            raise RuntimeError("段尾归位：csglide_chain 模块不可用。")
        name = cm.last_name()
        if not name:
            raise RuntimeError("段尾归位：读不到当前片名（导演台 chain.name 是否填写？）。")
        ch = cm.load_chain(name)
        cid = ch.get("current")
        if not cid:
            raise RuntimeError("段尾归位：chain.json 没有 current 段落，导演台是否已登记？")
        clip = cm.load_clip(name, cid) or {}
        take = max(1, int(clip.get("current_take") or 0) or 1)
        lines = ["%s 归位 %s / take %d" % (_TAG, cid, take)]

        # 1) 续拍档 → clip_cont + take_params.cont_saved
        src = None
        try:
            src = cm._last_saved_cont()
        except Exception:
            src = None
        if not src:
            src = _latest_context_latent()
        dst_cont = cm.clip_cont(name, cid, take)
        if src and os.path.isfile(src):
            if not os.path.isfile(dst_cont) or \
                    os.path.getmtime(src) > os.path.getmtime(dst_cont):
                os.makedirs(os.path.dirname(dst_cont), exist_ok=True)
                shutil.copy2(src, dst_cont)
            # 20261104：这一份 .cont.safetensors 同时是「承接档」「钉帧原稿」
            # 「整片潜空间段落来源」，不再额外复制一份 .latent.safetensors。
            # 以前多写一份，是因为钉帧/加长判定只认那个文件名 —— 现已统一。
            meta = cm.load_clip(name, cid) or {}
            tp = meta.get("take_params") or {}
            tp.setdefault(str(take), {})["cont_saved"] = dst_cont
            # 认档凭据（2-A）：这份承接档属于哪一段。下一段续写时据此校验
            # 「拿到的档 == 上一段写的」，对不上就报错，绝不静默接错档。
            tp.setdefault(str(take), {})["cont_saved_of"] = cid
            cm.update_clip(name, cid, {"take_params": tp})
            lines.append("  ✅ 续拍档（唯一 AV latent）：%s → %s" %
                         (os.path.basename(src), os.path.basename(dst_cont)))
        else:
            # 20261104：不再拿「同版 .latent.safetensors」补档 —— 那个文件
            # 已不存在。没存档就是没存档，如实报出来，别伪造一份。
            lines.append("  ⚠ 未找到本次续拍存档（h3_context/ 为空或超出时间窗），"
                         "下一段可能无法精确认档。")

        # 2) 成片 → clip_film（续段 Join 已自行写入则跳过）
        dst_film = cm.clip_film(name, cid, take)
        if os.path.isfile(dst_film):
            lines.append("  ✅ 成片已在段落目录（续接合成已落片），跳过：%s"
                         % os.path.basename(dst_film))
        else:
            fp = _resolve_video_input(成片)
            if fp:
                os.makedirs(os.path.dirname(dst_film), exist_ok=True)
                shutil.copy2(fp, dst_film)
                frames = 0
                try:
                    frames = cm.probe_film_frames(dst_film)
                except Exception:
                    frames = 0
                cm.set_film(name, cid, dst_film,
                            frames=frames or int(clip.get("frames") or 0),
                            head=int(clip.get("trim_frames") or 0))
                lines.append("  ✅ 成片归位：%s（%s 帧）" %
                             (os.path.basename(dst_film), frames or "未知"))
            else:
                lines.append("  ⚠ 没有可归位的成片输入，且段落目录无成片。")

        rep = "\n".join(lines)
        print(rep)
        return (rep,)


NODE_CLASS_MAPPINGS = {
    "BanzhangProducerLibraryIn": BanzhangProducerLibraryIn,
    "BanzhangProducerRack": BanzhangProducerRack,
    "BanzhangAIProducer": BanzhangAIProducer,
    "BanzhangProducerDirector": BanzhangProducerDirector,
    "BanzhangProducerClipAdopt": BanzhangProducerClipAdopt,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangProducerLibraryIn": "📥 资产入库（制片中枢）",
    "BanzhangProducerRack": "🗂️ 资产架（制片中枢）",
    "BanzhangAIProducer": "✨ AI制片中枢",
    "BanzhangProducerDirector": "🎬 任务编排器（制片中枢）",
    "BanzhangProducerClipAdopt": "📦 段尾归位（制片中枢）",
}
