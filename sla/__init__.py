"""Block-sparse attention for MiniMax-H3, as used by the SLA turbo LoRA."""

from __future__ import annotations

# 包出口必须与调用方的 `from .sla import ...` 一一对应：
# 漏一个名字，整条导入会失败并被外层 except 吞成"静默不加速"，
# 排查成本极高（现象是没加速，日志却指向环境问题）。
from .patch import engine_status, patch_h3_sla

__all__ = ["engine_status", "patch_h3_sla"]
