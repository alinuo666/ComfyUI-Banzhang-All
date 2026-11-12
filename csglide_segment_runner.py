# -*- coding: utf-8 -*-
"""多段渲染的后端权威状态机（纯 Python，不是节点）。

浏览器端 renderAll 的 for 循环保留（它负责按段编译 prompt），但「跑到第几段、
哪段成功、刷新后从哪继续」改由这里持有 —— 取代 localStorage 心跳与
司机/观察者选举。HTTP 路由见 csglide_chain.py 的 /cglide/chain/run_segments/*。

状态与提交解耦：submit/done 只认段序，不碰 ComfyUI 队列，因此可纯 Python 单测。
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

PLANNED = "planned"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
SKIPPED = "skipped"


class RunnerError(ValueError):
    """段序 / 状态违规。"""


@dataclass
class RunnerState:
    run_id: str
    project_id: str
    clips: List[str]
    states: Dict[str, str] = field(default_factory=dict)
    index: int = 0
    receipts: Dict[str, Any] = field(default_factory=dict)
    prompt_ids: Dict[str, str] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    finished: bool = False


class SegmentRunner:
    def __init__(self, project_id: str, clips: List[str], run_id: str = None):
        clips = [str(c) for c in (clips or [])]
        if not clips:
            raise RunnerError("分段列表为空")
        if len(set(clips)) != len(clips):
            raise RunnerError("分段列表有重复 clip id")
        self.s = RunnerState(run_id or uuid.uuid4().hex[:12],
                             str(project_id or ""), clips)
        for clip in clips:
            self.s.states[clip] = PLANNED

    def next_clip(self) -> Optional[str]:
        if self.s.finished or self.s.index >= len(self.s.clips):
            return None
        return self.s.clips[self.s.index]

    def submit(self, clip: str, prompt_id: str = None) -> str:
        if self.next_clip() != str(clip):
            raise RunnerError("提交顺序错：期望 %s，收到 %s"
                              % (self.next_clip(), clip))
        self.s.states[str(clip)] = RUNNING
        if prompt_id:
            self.s.prompt_ids[str(clip)] = str(prompt_id)
        return str(clip)

    def done(self, clip: str, ok: bool, receipt: Any = None) -> Optional[str]:
        if self.next_clip() != str(clip) and self.s.states.get(str(clip)) != RUNNING:
            raise RunnerError("回执段号 %s 不是当前运行段" % clip)
        self.s.states[str(clip)] = DONE if ok else FAILED
        if receipt is not None:
            self.s.receipts[str(clip)] = receipt
        if not ok:
            self.s.finished = True
            return None
        self.s.index += 1
        if self.s.index >= len(self.s.clips):
            self.s.finished = True
            return None
        return self.s.clips[self.s.index]

    def skip(self, clip: str) -> Optional[str]:
        return self._skip(clip)

    def _skip(self, clip: str) -> Optional[str]:
        if self.next_clip() != str(clip):
            raise RunnerError("跳过顺序错：期望 %s" % self.next_clip())
        self.s.states[str(clip)] = SKIPPED
        self.s.index += 1
        if self.s.index >= len(self.s.clips):
            self.s.finished = True
            return None
        return self.s.clips[self.s.index]

    def snapshot(self) -> Dict[str, Any]:
        return {
            "run_id": self.s.run_id, "project_id": self.s.project_id,
            "clips": list(self.s.clips), "states": dict(self.s.states),
            "index": self.s.index, "receipts": dict(self.s.receipts),
            "prompt_ids": dict(self.s.prompt_ids),
            "created_at": self.s.created_at, "finished": self.s.finished,
            "next": self.next_clip(),
        }

    @classmethod
    def restore(cls, data: Dict[str, Any]) -> "SegmentRunner":
        obj = cls(data.get("project_id") or "", data.get("clips") or [],
                  run_id=data.get("run_id"))
        obj.s.states = dict(data.get("states") or obj.s.states)
        obj.s.index = int(data.get("index") or 0)
        obj.s.receipts = dict(data.get("receipts") or {})
        obj.s.prompt_ids = dict(data.get("prompt_ids") or {})
        obj.s.created_at = float(data.get("created_at") or time.time())
        obj.s.finished = bool(data.get("finished"))
        return obj


_LOCK = threading.Lock()
_RUNNERS: Dict[str, SegmentRunner] = {}


def create_runner(project_id: str, clips: List[str], run_id: str = None) -> SegmentRunner:
    with _LOCK:
        runner = SegmentRunner(project_id, clips, run_id)
        _RUNNERS[runner.s.run_id] = runner
        return runner


def get_runner(run_id: str) -> Optional[SegmentRunner]:
    with _LOCK:
        return _RUNNERS.get(str(run_id or ""))


def drop_runner(run_id: str) -> bool:
    with _LOCK:
        return _RUNNERS.pop(str(run_id or ""), None) is not None
