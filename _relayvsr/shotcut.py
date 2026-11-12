"""镜头硬切检测：让时间块边界对齐镜头边界。

RelayVSR 一个时间块内所有帧共用首尾两帧当参考（runtime.py 的 start_condition / end_condition），
Wan 骨干只处理这两个参考帧。块一旦跨过镜头切换，中间帧的两个参考就都不属于它所在的镜头，
补出来的细节是别的画面的 —— 表现就是「画面突然糊掉」，且误差随帧号累积。
上游 kopperx/RelayVSR 与 bbaudio-2025/Comfyui-Relay-VSR 都没有做这件事。
"""

import torch

# ffmpeg select 滤镜 scene 分数的官方示例阈值（doc/filters.texi）。本项目两条真实样本实测：
# 真硬切最低 0.4217、非硬切最高 0.1516，0.4 落在空隙中间，两侧各有约 2.7 倍余量。
CUT_THRESHOLD = 0.4


def _gray(frame):
    """uint8 (3,H,W) -> float32 (H,W)。三通道取均值即亮度，够判硬切，不必走完整 YUV 矩阵。"""
    return frame.to(torch.float32).mean(dim=0)


def scene_score(previous_mafd, mafd):
    """ffmpeg libavfilter/f_select.c 的 scene 分数：min(帧间平均绝对差, 该差的突变) / 100。

    取 min 是为了压住持续运动：运动幅度大但稳定时突变很小，不该判成切换。
    """
    return min(mafd, abs(mafd - previous_mafd)) / 100.0


class ShotCutDetector:
    """跨块连续的硬切判定：每帧只判一次，运动历史不因分块而重置。

    按块重新起算会让块首那一对退化成裸 MAD/100，持续大运动被误判成硬切；
    误判点落在重叠携带区时，切出的块比携带帧数还短，融合时数组越界崩溃。
    """

    def __init__(self):
        self._previous = None
        self._previous_mafd = 0.0

    def is_cut(self, frame):
        """这一帧相对上一帧是不是硬切。流的第一帧没有上一帧，永远不是。"""
        gray = _gray(frame)
        if self._previous is None:
            self._previous = gray
            return False
        mafd = float((gray - self._previous).abs().mean())
        self._previous = gray
        cut = scene_score(self._previous_mafd, mafd) > CUT_THRESHOLD
        self._previous_mafd = mafd
        return cut