# -*- coding: utf-8 -*-
"""剧本解析：资产文件（## @图片N）与核心帧文件（<<<>>> 包裹符）双格式。"""
import re

_ASSET_HEAD = re.compile(r"^##\s*@图片(\d+)\s*=\s*(.+?)\s*$", re.M)
_CODE_BLOCK = re.compile(r"```(?:text)?\s*\n([\s\S]*?)```")

_NAME_FIELDS = [
    ("主体", re.compile(r"^主体标题名称[：:]\s*(.+?)\s*$", re.M)),
    ("服装", re.compile(r"^服装标题名称[：:]\s*(.+?)\s*$", re.M)),
    ("道具", re.compile(r"^道具标题名称[：:]\s*(.+?)\s*$", re.M)),
    ("场景", re.compile(r"^场景标题名称[：:]\s*(.+?)\s*$", re.M)),
    ("色板", re.compile(r"^色板标题名称[：:]\s*(.+?)\s*$", re.M)),
]
_GENERIC_NAME = re.compile(r"^标题名称[：:]\s*(.+?)\s*$", re.M)
_REF_IMAGE = re.compile(r"@图片(\d+)")

_WRAP_OPEN = re.compile(r"<<<\s*(主体|服装|道具|场景|色板|核心帧|视频|封面|音乐)\s*提示词\s*>>>")
_WRAP_PAIR = re.compile(
    r"<<<\s*(主体|服装|道具|场景|色板|核心帧|视频|封面|音乐)\s*提示词\s*>>>"
    r"([\s\S]*?)<<<\s*\1\s*提示词_END\s*>>>"
)

ASSET_TYPES = ("主体", "服装", "道具", "场景", "色板")


def clean_filename(name):
    name = re.sub(r'[\\/:*?"<>|]+', "", str(name)).strip()
    return re.sub(r"\s+", "_", name)


def _type_from_filename(fname):
    for t in ASSET_TYPES:
        if t in fname:
            return t
    return "资产"


def parse_asset_file(text, fname):
    segments = []
    for h in _ASSET_HEAD.finditer(text):
        img_id = int(h.group(1))
        head_name = h.group(2).strip()
        block = _CODE_BLOCK.search(text[h.end():])
        content = (block.group(1).strip() if block else "") or head_name

        seg_type, seg_name = None, None
        for t, pat in _NAME_FIELDS:
            m = pat.search(content)
            if m:
                seg_type, seg_name = t, m.group(1).strip()
                break
        if not seg_name:
            m = _GENERIC_NAME.search(content)
            if m:
                seg_name = m.group(1).strip()
        if not seg_name:
            seg_name = head_name
        if not seg_type:
            seg_type = _type_from_filename(fname)

        segments.append({
            "type": seg_type,
            "id": f"@图片{img_id}",
            "img_no": img_id,
            "name": clean_filename(seg_name),
            "prompt": content,
            "file": fname,
        })
    return segments


def _find_unclosed(text):
    for idx, m in enumerate(_WRAP_OPEN.finditer(text), start=1):
        close = re.compile(r"<<<\s*%s\s*提示词_END\s*>>>" % m.group(1))
        if not close.search(text, m.end()):
            line = text.count("\n", 0, m.start()) + 1
            return idx, m.group(1), line
    return None


def parse_wrapped_file(text, fname=""):
    unclosed = _find_unclosed(text)
    if unclosed:
        idx, wtype, line = unclosed
        raise ValueError(
            f"第 {idx} 个「{wtype}提示词」标签没有闭合（第 {line} 行附近），"
            f"请补全 <<<{wtype}提示词_END>>> 后再执行"
        )

    segments, kf_index = [], 0
    for m in _WRAP_PAIR.finditer(text):
        wtype, body = m.group(1), m.group(2).strip()
        if wtype != "核心帧":
            continue
        kf_index += 1
        nm = _GENERIC_NAME.search(body)
        name = clean_filename(nm.group(1).strip()) if nm else f"核心帧_{kf_index}"
        refs = ["@图片%s" % n for n in dict.fromkeys(_REF_IMAGE.findall(body))]
        segments.append({
            "type": "核心帧",
            "id": f"{fname}#kf{kf_index}",
            "img_no": 0,
            "name": name, "prompt": body, "refs": refs,
            "file": fname,
        })
    return segments
