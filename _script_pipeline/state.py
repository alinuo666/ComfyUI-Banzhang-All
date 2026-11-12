# -*- coding: utf-8 -*-
"""会话状态：资产/核心帧每条的状态、图片文件、日志，全部持久化。"""
import json
import os
import time

from .parser import parse_asset_file, parse_wrapped_file

# 状态：pending 待跑 / running 生成中 / ok 完成 / failed 失败 / locked 锁定
WAIT_STATES = ("pending", "failed")
LOG_LIMIT = 120

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BASE_DIR = os.path.join(_ROOT, "caches", "script_pipeline")


def _brief(item):
    """传给前端的条目：去掉 prompt（长文本）。"""
    return {k: v for k, v in item.items() if k != "prompt"}


class SessionState:
    def __init__(self, session_id):
        self.session_id = session_id
        self.dir = os.path.join(_BASE_DIR, str(session_id)[:32])
        self.path = os.path.join(self.dir, "state.json")
        self.data = {"assets": [], "kfs": [], "logs": [], "stage": "parse"}
        self.load()

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self.data = json.load(f)
        except Exception:
            pass

    def save(self):
        os.makedirs(self.dir, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    def log(self, line):
        entry = f"[{time.strftime('%H:%M:%S')}] {line}"
        self.data["logs"].append(entry)
        self.data["logs"] = self.data["logs"][-LOG_LIMIT:]
        return entry

    def rebuild(self, files):
        """按文件解析结果重建条目，按 id 保留旧状态（已生成的图、锁定）。"""
        assets, kfs = [], []
        for f in files:
            with open(f["path"], "r", encoding="utf-8") as fh:
                text = fh.read()
            fname = os.path.basename(f["path"])
            assets += parse_asset_file(text, fname)
            kfs += parse_wrapped_file(text, fname)

        # 资产编号 @图片N 是全局唯一引用（核心帧靠它定位资产），跨文件重复会让状态静默互串，
        # 这里在源头报明确错误，不让用户踩静默错乱。
        seen = {}
        for a in assets:
            key = a["id"]
            if key in seen:
                raise ValueError(
                    f"资产编号 {key} 重复定义：同时出现在「{seen[key]}」和「{a.get('file')}」。"
                    "剧本里的 @图片N 必须全片唯一，请检查后重拖。")
            seen[key] = a.get("file")

        old_assets = {a["id"]: a for a in self.data["assets"]}
        old_kfs = {k["id"]: k for k in self.data["kfs"]}
        self.data["assets"] = [self._merge(old_assets.get(a["id"]), a)
                               for a in assets]
        self.data["kfs"] = [self._merge(old_kfs.get(k["id"], None), k,
                                        kid=k["id"]) for k in kfs]
        if self.data["stage"] == "done":
            self.data["stage"] = "asset"
        self.save()

    @staticmethod
    def _merge(old, new, kid=None):
        item = dict(new)
        item_id = kid or new.get("id") or new["name"]
        item["id"] = item_id
        item.setdefault("status", "pending")
        item.setdefault("file", "")
        item.setdefault("subfolder", "")
        item.setdefault("error", "")
        item.setdefault("seed", None)
        if old:
            for k in ("status", "file", "subfolder", "error"):
                item[k] = old.get(k, item[k])
        return item

    def _bucket(self, kind):
        return self.data["assets"] if kind == "asset" else self.data["kfs"]

    def get(self, kind, item_id):
        for it in self._bucket(kind):
            if it["id"] == item_id:
                return it
        return None

    def set_item(self, kind, item_id, **fields):
        it = self.get(kind, item_id)
        if it:
            it.update(fields)
            self.save()
        return it

    def pending(self, kind):
        return [it for it in self._bucket(kind)
                if it["status"] in WAIT_STATES]

    def summary(self):
        def stat(items):
            counts = {s: 0 for s in
                      ("pending", "running", "ok", "failed", "locked")}
            for it in items:
                counts[it["status"]] = counts.get(it["status"], 0) + 1
            return counts

        return {
            "session": self.session_id,
            "stage": self.data["stage"],
            "assets": [_brief(a) for a in self.data["assets"]],
            "kfs": [_brief(k) for k in self.data["kfs"]],
            "asset_stat": stat(self.data["assets"]),
            "kf_stat": stat(self.data["kfs"]),
            "logs": self.data["logs"][-60:],
        }
