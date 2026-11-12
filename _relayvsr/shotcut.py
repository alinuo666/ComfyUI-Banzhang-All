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


def first_cut(frames):
    """第一个硬切帧的下标（该帧是新镜头的第一帧），没有则 None。

    返回下标而不是布尔：调用方要在这一帧之前收块，并让下一块从这一帧起算参考。
    """
    if len(frames) < 2:
        return None
    previous = _gray(frames[0])
    previous_mafd = 0.0
    for index in range(1, len(frames)):
        gray = _gray(frames[index])
        mafd = float((gray - previous).abs().mean())
        previous = gray
        if scene_score(previous_mafd, mafd) > CUT_THRESHOLD:
            return index
        previous_mafd = mafd
    return None