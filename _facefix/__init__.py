# -*- coding: utf-8 -*-
"""🪞 人脸修复台引擎子包（_facefix）—— 像素域后处理。

节点只做端口与面板，真正的修复逻辑按职责拆在这里：
  detection  SAM3.1 记忆追踪（obj_id 全程稳定）→ 逐帧逐身份的人脸框
  groups     互动分组：挨得近的脸归一组，组框逐帧并集 + 时间平滑
  refine     组框裁块 → 放大到画布 → H3 低降噪重渲染 → 羽化贴回
  inpaint    节点内 H3 AV 采样（视频 + 哑音频双流，CFGGuider）
  pipeline   编排：检测 → 分组 → 精修 → 前后对比缩略图
  frames     VAE 解码关键帧、裁人脸缩略图
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
for _f in ("refine.py", "pipeline.py"):
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
