# -*- coding: utf-8 -*-
"""🪞 人脸修复台引擎子包（_facefix）—— 像素域后处理。

节点只做端口与面板，真正的修复逻辑按职责拆在这里：
  detection  SAM3.1 记忆追踪 → 把逐段 obj_id 归并成「按人」的逐帧人脸框
  render     MaskVid 式内核：稳定裁剪 → H3 整段重渲染 → 按脸区羽化贴回
  inpaint    节点内 H3 AV 采样（视频 + 哑音频双流，CFGGuider）
  pipeline   编排：检测 → 稳定裁剪渲染 → 前后对比缩略图
  frames     VAE 解码关键帧、裁人脸缩略图
  preview    运行时画面推送：阶段字幕 + 修复前/修复后循环动画

旧「拼贴画布 + 高频残差」内核（refine.py / groups.py）已于 2026-11-19
整体替换，原文件归档在 _archive/2026-11/bak/*.bak_facefix_20261119。
"""

import os
import time

from .pipeline import execute

__all__ = ["execute"]

# [加载版本] Python 模块只在 ComfyUI 启动时 import 一次，改 .py 不会热重载。
# 把磁盘 mtime 打进启动日志，「改了没效果」第一眼就能比对进程启动时间 ——
# 本包已经因为「看的是旧代码」栽过三次，别再靠猜。
_HERE = os.path.dirname(os.path.abspath(__file__))
_STAMP = []
for _f in ("render.py", "pipeline.py", "detection.py", "frames.py", "preview.py"):
    try:
        _STAMP.append("%s@%s" % (
            _f,
            time.strftime("%m-%d %H:%M:%S",
                          time.localtime(os.path.getmtime(
                              os.path.join(_HERE, _f))))))
    except OSError:
        pass
print("[人脸修复台] 引擎已加载（磁盘版本 %s）—— 改 .py 后必须重启 ComfyUI"
      % "、".join(_STAMP))
