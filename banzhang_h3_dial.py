# -*- coding: utf-8 -*-
"""H3 风格旋钮：简版常量滑块 + 专业版贝塞尔时间曲线。

权重来源 MATLOWAI/H3-Dials（MiniMax H3 Community License）。
专业版曲线注入直接使用 ComfyUI-MAINodes 的 dials/timecurve.py（GPL-3.0，
见 _mainodes_dials/LICENSE-GPL-3.0.txt）：官方实现带 SAMPLER_SAMPLE 编译期、
像素帧均值权重与 torch.lerp 混合，比自研简化版可靠。
本包的 −1~+1 曲线在提交前采样成密集关键点，并拆成正／负两行，
让负段走真实负向 dial 分支，而不是线性外推。
"""
import json
import os

import torch
from safetensors import safe_open

_DIAL_DIR = os.path.join(os.path.dirname(__file__), "dials")
_CATALOG = os.path.join(_DIAL_DIR, "_zh.json")
_MAX_ROWS = 3
_PUSH_LIMIT = 1.5
_HOOK_KEY = "diffusion_model.token_refiner.forward"


def _catalog():
    with open(_CATALOG, "r", encoding="utf-8") as f:
        return json.load(f)


def _style_map():
    return {x["name"]: x for x in _catalog()["styles"]}


def _parse_rows(raw):
    rows = json.loads(raw) if raw else []
    if not isinstance(rows, list):
        raise ValueError("风格配置格式不对，请删掉本节点重新添加")
    out = [r for r in rows if isinstance(r, dict) and r.get("on") and r.get("name")]
    return out[:_MAX_ROWS]


class _ShiftedForward:
    # 加在 token_refiner 输出，正是 DiT 读提示词的位置；不改模块树，可与其他补丁叠加。
    def __init__(self, forward, shift):
        self.forward = forward
        self.shift = shift

    def __call__(self, x, *args, **kwargs):
        out = self.forward(x, *args, **kwargs)
        return out + self.shift.to(device=out.device, dtype=out.dtype)


# ---- 贝塞尔求值：只用于把 UI 曲线采样成官方 check_spec 能吃的关键点 ----
def _bezier_segments(points):
    segs = []
    for i in range(len(points) - 1):
        p0, p1 = points[i], points[i + 1]
        pm = points[i - 1] if i > 0 else p0
        pp = points[i + 2] if i + 2 < len(points) else p1
        c1 = (p0[0] + (p1[0] - pm[0]) / 6.0, p0[1] + (p1[1] - pm[1]) / 6.0)
        c2 = (p1[0] - (pp[0] - p0[0]) / 6.0, p1[1] - (pp[1] - p0[1]) / 6.0)
        segs.append((p0, c1, c2, p1))
    return segs


def _cubic(a, b, c, d, u):
    v = 1.0 - u
    return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d


def _curve_at(segs, t):
    for i, (p0, c1, c2, p1) in enumerate(segs):
        if t > p1[0] and i < len(segs) - 1:
            continue
        lo, hi = 0.0, 1.0
        for _ in range(18):
            u = (lo + hi) / 2.0
            if _cubic(p0[0], c1[0], c2[0], p1[0], u) < t:
                lo = u
            else:
                hi = u
        y = _cubic(p0[1], c1[1], c2[1], p1[1], (lo + hi) / 2.0)
        return min(1.0, max(-1.0, y))
    return segs[-1][3][1] if segs else 0.0


def _sample_curve(points, n=21):
    segs = _bezier_segments(points)
    return [[i / (n - 1), _curve_at(segs, i / (n - 1))] for i in range(n)]


def _official_rows(rows, get_vec):
    """−1~+1 曲线 → 官方 (label, dial, strength) 与 time spec 两条分支。"""
    smap = _style_map()
    rack, specs = [], []
    for r in rows:
        cv = r.get("curve")
        pts = cv.get("points") if isinstance(cv, dict) else None
        if not pts:
            continue
        st = smap[r["name"]]
        dial = {
            "vec": get_vec(st["file"]), "target": "token_refiner", "mode": "post",
            "meta": {"model_family": "MiniMax H3", "name": st["name"]},
        }
        dense = _sample_curve(pts)
        k = max(1, min(6, int(cv.get("k", 1))))
        for label, sign, cap, pick in (
            ("正向", 1.0, float(st["pos_cap"]), lambda c: max(0.0, c)),
            ("负向", -1.0, float(st["neg_cap"]), lambda c: max(0.0, -c)),
        ):
            keys = [[t, pick(c)] for t, c in dense]
            if not any(v > 0.0 for _, v in keys):
                continue
            rack.append((st["name"] + "·" + label, dial, sign * cap))
            specs.append({
                "type": "keys", "points": keys, "unit": "normalized",
                "interp": "linear", "steps": k, "audio": "protect",
            })
    return rack, specs


class BanZhang_H3_Dial:
    # 向量只有 5376 维，读一次就够；禁止每次执行重新读盘。
    _cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        cat = _catalog()
        return {
            "required": {"model": ("MODEL",)},
            "optional": {
                "dial_config": ("STRING", {
                    "default": "[]",
                    "tooltip": "多路风格面板配置，由前端维护，勿手改",
                }),
                "dial_params": ("STRING", {
                    "default": json.dumps(cat, ensure_ascii=False),
                    "tooltip": "中文风格清单与标定值，由前端读取",
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "apply_dials"
    CATEGORY = "班长/风格控制"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return "|".join(str(kwargs.get(k, "")) for k in ("model", "dial_config"))

    @classmethod
    def VALIDATE_INPUTS(cls, dial_config=None, **kwargs):
        try:
            rows = _parse_rows(dial_config or "[]")
        except Exception as e:
            return "风格配置读取失败：%s" % e
        smap = _style_map()
        for r in rows:
            if r["name"] not in smap:
                return "找不到风格「%s」，请重新选择" % r["name"]
            cv = r.get("curve")
            if isinstance(cv, dict) and cv.get("points"):
                pts = cv["points"]
                if len(pts) < 2 or any(len(p) != 2 for p in pts):
                    return "「%s」的曲线至少需要两个有效锚点" % r["name"]
        return True

    @classmethod
    def _get_vec(cls, filename):
        if filename in cls._cache:
            return cls._cache[filename]
        path = os.path.join(_DIAL_DIR, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError("缺少风格文件：%s" % filename)
        with safe_open(path, "pt") as f:
            keys = list(f.keys())
            if len(keys) != 1 or not keys[0].endswith(".dials_shift"):
                raise ValueError("%s 不是标准风格文件，暂不支持多路合成" % filename)
            vec = f.get_tensor(keys[0]).float()
            meta = dict(f.metadata() or {})
        # 老文件没有 model_family，按上游约定视为 H3 dial。
        family = meta.get("model_family", "MiniMax H3")
        if family != "MiniMax H3":
            raise ValueError("%s 属于 %s，不能用在 MiniMax H3 上" % (filename, family))
        cls._cache[filename] = vec
        return vec

    @classmethod
    def _collect_jobs(cls, rows):
        """简版常量行：按文件名排序求和，一次 object_patch。"""
        smap = _style_map()
        jobs = []
        for r in rows:
            st = smap[r["name"]]
            value = min(1.0, max(-1.0, float(r.get("pct") or 0) / 100.0))
            if value == 0:
                continue
            side = "pos" if value > 0 else "neg"
            jobs.append({
                "file": st["file"], "name": st["name"],
                "vec": cls._get_vec(st["file"]),
                "strength": value * float(st[side + "_cap"]), "value": abs(value),
            })
        # 固定顺序是可复现的根：与用户第几路、先加谁无关。
        jobs.sort(key=lambda j: (j["file"], j["name"]))
        return jobs

    @staticmethod
    def _push_scale(jobs):
        push = sum(j["value"] for j in jobs)
        return 1.0 if push <= _PUSH_LIMIT else _PUSH_LIMIT / push

    def apply_dials(self, model, dial_config="[]", dial_params=None):
        rows = _parse_rows(dial_config)
        if not rows:
            return (model,)
        curved = [r for r in rows
                  if isinstance(r.get("curve"), dict) and r["curve"].get("points")]
        const_rows = [r for r in rows
                      if not (isinstance(r.get("curve"), dict) and r["curve"].get("points"))]
        jobs = self._collect_jobs(const_rows)
        # 全 0 且无曲线：不校验模型、不读权重、不 clone、不打补丁。
        if not curved and not jobs:
            return (model,)
        m = model.clone()
        if curved:
            try:
                from _mainodes_dials import timecurve as tc
            except Exception as e:
                raise ValueError("专业版曲线模块未就绪（_mainodes_dials）：%s" % e)
            rack, specs = _official_rows(curved, self._get_vec)
            if rack:
                tc.apply_rack(m, rack, specs)
                print("[H3风格旋钮] 专业版：已按官方实现注册 %d 条曲线分支" % len(rack))
        if not jobs:
            return (m,)
        scale = self._push_scale(jobs)
        with torch.no_grad():
            total = torch.zeros_like(jobs[0]["vec"], dtype=torch.float64)
            for j in jobs:
                total += j["vec"].double() * (j["strength"] * scale)
            total = total.float()
        m.add_object_patch(
            _HOOK_KEY, _ShiftedForward(m.get_model_object(_HOOK_KEY), total))
        return (m,)


NODE_CLASS_MAPPINGS = {"BanZhang_H3_Dial": BanZhang_H3_Dial}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_H3_Dial": "H3 风格旋钮（多路实时合成）"}
