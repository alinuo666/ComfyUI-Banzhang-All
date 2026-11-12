"""SelfLift 核心算法包。

本包不做节点注册 —— 节点由上一层的 ``banzhang_selflift.py`` 提供。

- ``selflift.py`` : 双路提升 + 伪影感知一致性校正（arXiv:2609.02036 · SelfLift-zero）
- ``h3_mem.py``   : H3 显存优化补丁（前馈分块 + 低显存注意力，移植自 ComfyUI-KJNodes）
"""

__all__ = ["selflift", "h3_mem"]
