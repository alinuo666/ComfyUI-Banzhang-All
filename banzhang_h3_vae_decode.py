# -*- coding: utf-8 -*-
"""
🎬 班长全家桶 — H3 VAE 快速解码（VAE 端口传入 + 时间分块）
================================================================================
原版作者: Tridae (ComfyUI-MiniMaxH3_LatentUpscaler 的 vae_decode.py)
班长全家桶版改造:
    1. VAE 由输入端口传入(接官方 VAELoader), 节点不再内置加载器。
    2. 潜空间输入直接接采样器输出的音视频联合潜空间(NestedTensor),
       自动剥离音频流, 只解码视频流, 输出图像。
    3. 空间分块固定 256/64 官方几何(不开放调节: 实测这是唯一能压住 16 像素
       patch 栅格的档位, 调成别的值画面就会变成小格子);
       时间分块默认开启, 长视频峰值显存不再随帧数线性增长。
    4. 20261111 阶段 1：集成「💾 续拍存档」。解码前自动把本阶段的**音视频
       联合潜空间**写进工程档案，一采/二采各一份、同属一个 take；面板不加
       任何控件、不需要用户设置。画布上不再需要「💾 续拍存档」节点。
       写盘方仍然只有一个（本节点 → banzhang_h3mc_archive.mirror_to_central）。

为什么不用官方 VAEDecode:
    官方 VAEDecode 无法修改 H3 VAE 的 tile_size; 且 OOM 时退回通用 3D 分块器
    (不遵守 H3 混合规则, 接缝变网格)。本节点直接调用 H3 自带分块路径:
    tile_size 锁 256、重叠锁 64 不接缝, 时间分块支持长视频低显存。

关于共享状态(2026-10-17 修):
    下面这三个属性 —— vae.first_stage_model 的 tiling / tile_size /
    tile_overlap_min —— 是 VAELoader 缓存的**进程级共享**对象上的, 不是本节点私有。
    本节点只往里写唯一正确的官方值(256/64), 所以不需要"用完还原":
    写进去本身就是修好, 还能把早先被改坏的共享状态自愈回来。
    早期版本按用户设置写、又不还原, 结果同进程里所有用同一个 VAE 的官方
    VAEDecode 全被拖下水 —— 连一采画面都变成小格子, 且不重启不自愈。

注(2026-10): 不再支持改造版 2x PixelShuffle VAE —— 官方 VAELoader 写死 3 通道,
    加载不了 12 通道检查点, 所以端口传入后只支持官方 3 通道 H3 视频 VAE。
================================================================================
"""

from __future__ import annotations

import os

import numpy as np
import torch

import comfy.model_management as model_management
import comfy.nested_tensor

# 官方空间分块几何：256 像素分块 + 64 像素重叠。
# 这是实测唯一能压住 H3 解码器 16 像素 patch 栅格的档位（详见 decode 内注释），
# 也是 H3 VAE 自己的构造默认值，固定不开放调节。
_STOCK_TILE = 256
_STOCK_OVERLAP = 64

# 时间分块内定值：每块新解 85 帧、块间留 39 帧上下文（= 5+17×2，对齐 H3 的 17 帧组）。
# 实测在 768x448 与 1152x672 上都够用，速度与显存的平衡点，固定不开放调节。
_TEMPORAL_FRAMES = 85
_TEMPORAL_CONTEXT = 39
# 接缝告警内定值：重叠区重复解码的平均绝对差超过它就在控制台报警。
# 不占界面格子，但保留诊断能力。
_SEAM_THRESHOLD = 0.02


# ==============================================================================
# 潜空间音视频分离
# ==============================================================================

def _extract_video_latent(samples: dict) -> torch.Tensor:
    """从采样器输出的联合潜空间取出视频流, 音频流剥离丢弃。

    H3 联合潜空间是 NestedTensor: 成员[0]=视频 [B,24,T,H,W], 成员[1]=音频 [B,32,2,Ta]。
    普通单张量潜空间也兼容(直接当视频流)。
    """
    if "samples" not in samples:
        raise KeyError('LATENT 字典缺少 "samples"')
    raw = samples["samples"]
    if isinstance(raw, comfy.nested_tensor.NestedTensor) or getattr(raw, "is_nested", False):
        members = list(raw.unbind())
        if not members:
            raise ValueError("联合潜空间的成员列表为空")
        video = members[0]
    elif isinstance(raw, torch.Tensor):
        video = raw
    else:
        raise TypeError(f"应为 NestedTensor 或 torch.Tensor, 实际是 {type(raw)}")
    if video.ndim != 5:
        raise ValueError(
            f"应为 H3 视频潜空间 BxCxTxHxW, 实际形状 {tuple(video.shape)}"
        )
    return video


# ==============================================================================
# 解码辅助 (继承自原版 vae_decode.py, 逻辑一致)
# ==============================================================================

def _decode_once(vae, dtype, video: torch.Tensor, output_device: torch.device) -> torch.Tensor:
    """单次(或单窗口)解码: 腾显存 -> H3 自带路径解码 -> 输出 RGB。

    解码前按 VAE 实际需求把其他模型(采样器/文本编码器)请出显存: 否则小显存卡上
    主模型与 VAE 共驻, 会触发反复换页导致解码慢 2~3 倍(ComfyUI #15484)。
    load_models_gpu 会顺带卸掉放不下的模型, 下次用到会自动重载。
    """
    model = vae.first_stage_model
    device = model_management.get_torch_device()

    memory_used = vae.memory_used_decode(video.shape, dtype)
    model_management.load_models_gpu([vae.patcher], memory_required=memory_used)

    pixel_samples = torch.empty(
        model.decode_output_shape(video.shape),
        device=output_device,
        dtype=torch.float32,
    )
    samples = video.to(device=device, dtype=dtype)
    try:
        model.decode(samples, output_buffer=pixel_samples)
    except RuntimeError as exc:
        if "out of memory" not in str(exc).lower():
            raise
        model_management.soft_empty_cache()
        raise RuntimeError(
            "解码过程显存不足(OOM)。空间分块已固定为官方 256/64 几何(再改就会出小格子), "
            "所以只能：确认「时间分块」已开启、减少帧数或降低分辨率后重试。"
        ) from exc

    # [B,C,T,H,W] -> [B,T,H,W,C]: 通道挪到最后, 与 Comfy IMAGE 布局一致(原版同样处理)
    return pixel_samples.movedim(1, -1)


def _h3_frame_count(video_t: int) -> int:
    """把官方 H3 视频潜空间的 T 换算成解码帧数。"""
    video_t = int(video_t)
    if video_t < 2 or (video_t - 2) % 5:
        raise ValueError(
            f"时间分块要求潜空间 T 符合 17k+5 网格; 当前 T={video_t}。"
        )
    return 5 + 17 * ((video_t - 2) // 5)


def _temporal_settings(tile_frames: int, context_frames: int) -> tuple[int, int, int, int]:
    """把界面上的帧数请求换算成 H3 的因果组。

    前两个潜空间位置解码 5 帧; 之后每 5 个潜空间位置增加 17 帧。
    后面的块额外带 2 个前导潜空间位置 + 上下文组, 然后丢弃解码出的
    前缀, 只保留稳定的中段帧。
    """
    tile_groups = max(1, int(round(max(17, int(tile_frames)) / 17.0)))
    context_groups = max(0, int(round(max(5, int(context_frames)) - 5) / 17.0))
    return tile_groups, context_groups, 17 * tile_groups, 5 + 17 * context_groups


def _decode_temporal_tiled(vae, dtype, video: torch.Tensor, output_device: torch.device,
                           tile_frames: int, context_frames: int,
                           seam_warning_threshold: float) -> torch.Tensor:
    """按因果时间窗口解码 H3, 只保留稳定区域(长视频低显存)。

    实现挪到 _iter_temporal_tiles：整段玩法 = 把每一块拼起来，流式玩法 = 边取边写。
    两种玩法共用同一份算法，不会再出现「改了一处、另一处漂移」。
    """
    pieces = list(_iter_temporal_tiles(vae, dtype, video, output_device,
                                       tile_frames, context_frames,
                                       seam_warning_threshold))
    # 只有一块时原样返回，避免 torch.cat 多拷一份（短视频走的就是这条）
    return pieces[0] if len(pieces) == 1 else torch.cat(pieces, dim=1)


def _iter_temporal_tiles(vae, dtype, video: torch.Tensor, output_device: torch.device,
                         tile_frames: int, context_frames: int,
                         seam_warning_threshold: float):
    """同一套因果窗口算法，唯一差别是把「攒齐再拼」换成「算一块给一块」。

    为什么值得这样改：ComfyUI 会把每个节点的输出缓存到整轮结束，515 帧 ×
    1200×672 float32 会以 4.64 GiB 的形态一直挂着。让步进来，调用方拿到一块
    就能立刻写盘丢弃，峰值只剩单块 —— 算法一行没动，只是换了个出口。
    """
    total_frames = _h3_frame_count(video.shape[2])
    total_groups = (int(video.shape[2]) - 2) // 5
    tile_groups, context_groups, resolved_tile, resolved_context = _temporal_settings(
        tile_frames, context_frames
    )
    if total_groups <= tile_groups:
        yield _decode_once(vae, dtype, video, output_device)
        return

    print(
        f"[H3 VAE 快速解码] 时间分块: 共 {total_frames} 帧, "
        f"每块新解码 {resolved_tile} 帧, 因果上下文 {resolved_context} 帧。"
    )
    上一块 = None
    completed_groups = 0
    worst_seam = 0.0
    已产出 = 0

    while completed_groups < total_groups:
        core_groups = min(tile_groups, total_groups - completed_groups)
        if completed_groups == 0:
            end_t = 2 + 5 * core_groups
            decoded = _decode_once(vae, dtype, video[:, :, :end_t], output_device)
            稳定块 = decoded
        else:
            overlap_groups = min(context_groups, completed_groups)
            # 在重叠组之前带上紧邻的 2 个因果基础位置, 保证每个窗口自身长度为 2+5k。
            start_t = 5 * (completed_groups - overlap_groups)
            end_t = 2 + 5 * (completed_groups + core_groups)
            decoded = _decode_once(vae, dtype, video[:, :, start_t:end_t], output_device)
            discard = 5 + 17 * overlap_groups
            if int(decoded.shape[1]) <= discard:
                raise RuntimeError("时间块在丢弃上下文后没有剩余稳定帧。")

            threshold = float(seam_warning_threshold)
            if threshold > 0 and 上一块 is not None:
                compare = min(discard, int(上一块.shape[1]))
                if compare:
                    previous = 上一块[:, -compare:].float()
                    repeated = decoded[:, discard - compare:discard].float()
                    difference = float(torch.mean(torch.abs(previous - repeated)).item())
                    worst_seam = max(worst_seam, difference)
                    if difference > threshold:
                        print(
                            f"[H3 VAE 快速解码] 警告: 第 "
                            f"{5 + 17 * completed_groups} 帧附近的时间接缝差异 "
                            f"{difference:.6f}, 超过阈值 {threshold:.6f}。"
                            f"（时间上下文帧数已内定为 {_TEMPORAL_CONTEXT}，不开放调节；"
                            f"该差异通常来自该帧附近画面变化本身）"
                        )
            稳定块 = decoded[:, discard:]

        上一块 = 稳定块
        completed_groups += core_groups
        已产出 += int(稳定块.shape[1])
        yield 稳定块

    if 已产出 != total_frames:
        raise RuntimeError(
            f"时间重建产出 {已产出} 帧; 应为 {total_frames} 帧。"
        )
    if float(seam_warning_threshold) > 0:
        print(f"[H3 VAE 快速解码] 最大时间重叠差异: {worst_seam:.6f}。")


# ==============================================================================
# 节点
# ==============================================================================


def _archive_latent(潜空间, prompt, unique_id):
    """把本阶段的联合潜空间写进工程档案 —— 全工程唯一的写盘调用点。

    写的是**完整的**潜空间字典（含音频流），解码只用自己的视频流副本；
    二采的音频恒透传一采原始音频，所以 s2 档里同样有声音，无需另存音频文件。

    没有导演台（普通工作流）时只跳过存档、不影响解码；有工程但认段失败一律
    抛错 —— 宁可这一轮停住，也不能让用户以为档存上了。
    """
    try:
        from . import banzhang_h3mc_archive as arch
    except ImportError:
        import banzhang_h3mc_archive as arch
    info = arch.mirror_to_central(潜空间, prompt=prompt, unique_id=unique_id)
    if info is None:
        print("[H3 VAE 快速解码] 本次提交没有导演台/工程身份 —— 只解码，不写续拍存档。")
    else:
        print("[H3 VAE 快速解码] 续拍存档已写：%s / take %d / %s → %s"
              % (info["cid"], info["take"], info["stage"],
                 os.path.basename(info["cont_path"])))


class H3帧流:
    """解码的紧凑帧包：解码在本节点执行时**当场做完**，只把 uint8 帧递出去。

    为什么不做惰性：惰性会把解码推迟到下游节点执行的那一刻，下游（视频合并）
    的耗时就从「几秒编码」变成「几十秒解码+编码」，用户看到的现象是
    「合并节点慢了很多」—— 活没变少，只是记在了别人的账上。谁出的帧谁解。
    省内存靠降精度（uint8 是 float32 的 1/4），不靠把活推给下游。
    一次解完还能反复读：编码降级重试不必重新解码。
    """

    def __init__(self, vae, dtype, video, output_device, 时间分块):
        self._vae, self._dtype = vae, dtype
        self._video, self._dev = video, output_device
        self._时间分块 = 时间分块
        self.帧数 = _h3_frame_count(int(video.shape[2]))
        self._u8 = None
        self._已解 = False
        self.高 = self.宽 = 0

    def 解(self):
        """解完全部块并转 uint8。幂等：多次调用只解一次。"""
        if self._已解:
            return self
        self._u8 = []
        for piece in self._iter():
            piece = self._to_image(piece)
            # 必须非原地：_iter_temporal_tiles 里 `上一块 = 稳定块` 保留的就是 yield
            # 出去的这个张量，原地乘 255 会把下一轮接缝比较读到的值放大 255 倍，
            # 于是每块都误报「接缝差异 78.8 > 阈值 0.02」。多一份 float32 中间量
            # （864×480×90 帧 ≈ 447MB）换诊断不再说谎，值得。
            arr = piece.mul(255).round_().clamp_(0, 255).to(torch.uint8)
            arr = arr.cpu().numpy() if piece.is_cuda else arr.numpy()
            arr = np.ascontiguousarray(arr)
            if not self.宽:
                self.高, self.宽 = int(arr.shape[1]), int(arr.shape[2])
            self._u8.append(arr)
            del piece, arr
        self._已解 = True
        self._video = None
        字节 = sum(a.nbytes for a in self._u8)
        print(f"[H3 VAE 快速解码] 帧包已备好：{self.帧数} 帧 {self.宽}x{self.高}，"
              f"{字节 / 1024 ** 3:.2f} GB uint8（整段 float32 的 1/4）")
        return self

    def 批次(self, batch):
        """按批产出 uint8 [n,高,宽,3]，给 ffmpeg 直接写管道。可反复遍历。"""
        self.解()
        for arr in self._u8:
            n = int(arr.shape[0])
            for s in range(0, n, batch):
                yield arr[s:min(s + batch, n)]

    def pull_all(self):
        """兼容必须整段持有的通路（动图 GIF/WEBP、无 video 支持的回退）。"""
        self.解()
        u8 = self._u8[0] if len(self._u8) == 1 else np.concatenate(self._u8, axis=0)
        return torch.from_numpy(u8).float().div_(255.0)

    def _iter(self):
        if self._时间分块:
            yield from _iter_temporal_tiles(self._vae, self._dtype, self._video, self._dev,
                                            _TEMPORAL_FRAMES, _TEMPORAL_CONTEXT,
                                            _SEAM_THRESHOLD)
        else:
            yield _decode_once(self._vae, self._dtype, self._video, self._dev)

    @staticmethod
    def _to_image(piece):
        # [B,T,H,W,C] -> [B*T,H,W,C]，与 Comfy IMAGE 布局一致
        if len(piece.shape) == 5:
            return piece.reshape(-1, piece.shape[-3], piece.shape[-2], piece.shape[-1])
        return piece


class BanZhangH3VAEDecodeFast:
    """H3 音视频联合潜空间 -> 图像: VAE 端口传入, 自动剥离音频, 时间分块解码。"""

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """本节点带写盘副作用，绝不能被 ComfyUI 输入缓存跳过。

        缓存命中 = 节点不执行 = 这一采的 .cont.safetensors 没写，画面却从缓存
        里照常出图，用户完全看不出档丢了。NaN 让每次比较都不相等，于是每次
        Queue 都真正执行（与旧存档节点「每次另存一版」的行为一致）。

        没有加 OUTPUT_NODE=True：解码下游必然接着视频合并节点，不会被拓扑
        剪枝；强行标成输出节点反而会把 IMAGE 口塞进结果面板，得不偿失。
        """
        return float("NaN")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("VAE", {"tooltip": "接官方「VAE加载器」加载的 H3 视频 VAE(3 通道)。"}),
                "潜空间": ("LATENT", {"tooltip": "直接接采样器输出的音视频联合潜空间。"
                                                 "节点自动剥离音频流, 只解码视频流输出图像。"}),
                "时间分块": (
                    ["开", "关"],
                    {
                        "default": "开",
                        "tooltip": (
                            "默认开启: 按因果窗口分段解码并丢弃重复上下文, "
                            "长视频峰值显存不再随帧数增长(短片自动整段解码)。"
                            "显存充足想更快可关闭, 关闭后整段时间一次解码。"
                        ),
                    },
                ),
                "帧流模式": (
                    ["开", "关"],
                    {
                        "default": "关",
                        "tooltip": (
                            "打开后「图像」出口直接输出 uint8 帧包(低显存流式), "
                            "原来接视频合并「🖼️ 图像」口的线不用动, 自动走「解一块写一块丢一块」, "
                            "内存峰值只剩单块。"
                        ),
                    },
                ),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "decode"
    CATEGORY = "👨‍🏫班长/MiniMax H3"
    DESCRIPTION = (
        "H3 音视频联合潜空间直连解码: VAE 由输入端口传入(接官方 VAE 加载器), "
        "自动剥离音频流只解视频。空间分块与时间分块尺寸均固定为实测最优值、不开放调节"
        "(空间 256/64 是唯一能压住 16 像素 patch 栅格的档位; 时间 85 帧/块 + 39 帧上下文)。"
        "「帧流模式」打开后「图像」出口直接输出 uint8 帧包, 接视频合并即可流式写盘、"
        "内存峰值只剩单块。解码前自动按需腾显存, 避免小显存卡上模型与 VAE 共驻导致的解码变慢。"
        "解码前还会自动把本阶段音视频联合潜空间归档到工程文件集（一采/二采各一份），"
        "无需任何设置，画布上不必再接「💾 续拍存档」节点。"
    )

    def decode(
        self,
        vae,
        潜空间,
        时间分块="开",
        帧流模式="关",
        **kwargs
    ):
        from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE

        # combo 下拉传入 "开"/"关" 字符串; 兼容老工作流里直接存布尔值 true/false 的情况
        时间分块 = (时间分块 != "关") if isinstance(时间分块, str) else bool(时间分块)
        帧流模式 = (帧流模式 == "开") if isinstance(帧流模式, str) else bool(帧流模式)

        model = vae.first_stage_model
        if not isinstance(model, MiniMaxH3VideoVAE):
            raise ValueError(
                "「H3 VAE 快速解码」只认 MiniMax H3 视频 VAE。"
                "请接官方 VAE 加载器加载的 H3 视频 VAE(音频 VAE 或其它 VAE 会报错)。"
            )

        dtype = vae.vae_dtype
        video = _extract_video_latent(潜空间)  # 音频流在此剥离

        # ── 续拍存档（20261111 阶段 1）──
        # 放在解码之前：latent 已经是最终产物，存档不该依赖解码是否成功；
        # 阶段由 latent 上游有没有「🎬 H3 终极放大」自动判定，用户无需设置。
        _archive_latent(潜空间, kwargs.get("prompt"), kwargs.get("unique_id"))

        # ── 空间分块几何固定为官方 256/64，不开放调节 ──
        # H3 的"VAE"其实不是卷积 VAE，而是 ViT3DDecoder(patch_size=16)：
        # 每个 latent 格 = 1 个 token，proj_out 直接线性铺一个 16x16 像素块，
        # 块与块之间没有卷积缝合。所以"16 像素网格"是解码器自带的 patch 栅格，
        # 任何 latent 都有，只是被 256/64 分块的重叠混合抹平了。
        # 实测（干净 latent 48x28，量"16 像素边界处梯度 / 其余处梯度"）：
        #     整幅不分块          2.715
        #     128 分块 + 32 重叠  2.708
        #     512 分块 + 128 重叠 2.350
        #     256 分块 + 64 重叠  1.045  ← 唯一有效档
        # 这三个属性写在 VAELoader 缓存的**进程级共享** VAE 对象上，而 256/64
        # 既是唯一有效档、也是 VAE 自己的构造默认 —— 写进去就是正确状态，
        # 所以不需要「用完还原」；顺带还能把早先被改坏的共享状态自愈回来。
        model.tiling = True
        model.tile_size = _STOCK_TILE
        model.tile_overlap_min = _STOCK_OVERLAP

        out_dev = model_management.intermediate_device()

        # 帧流模式开关: 显式控制。
        # 开 → 「图像」出口直接吐 H3帧流 对象(鸭子类型, 视频合并节点靠
        #       hasattr(批次) 识别), 用户原来接「🖼️ 图像」口的线不用动。
        #       时间分块在此路径强制开: 否则等于整段解码, 内存省不下来。
        # 关 → 正常输出 float32 IMAGE。
        if 帧流模式:
            print("[H3 VAE 快速解码] 帧流模式开启 → 「图像」口直接输出 uint8 帧包"
                  "(原线接视频合并即可, 内存峰值只剩单块)")
            return (H3帧流(vae, dtype, video, out_dev, True).解(),)

        if 时间分块:
            images = _decode_temporal_tiled(
                vae,
                dtype,
                video,
                out_dev,
                _TEMPORAL_FRAMES,
                _TEMPORAL_CONTEXT,
                _SEAM_THRESHOLD,
            )
        else:
            images = _decode_once(vae, dtype, video, out_dev)

        # [B, C, T, H, W] -> [B*T, H, W, C]
        if len(images.shape) == 5:
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        print(
            f"[H3 VAE 快速解码] 完成: {images.shape[0]} 帧, "
            f"{images.shape[2]}x{images.shape[1]} 像素"
        )
        return (images, None)


# ==========================================
# 班长全家桶注册
# ==========================================
NODE_CLASS_MAPPINGS = {
    "BanZhang_H3VAEDecodeFast": BanZhangH3VAEDecodeFast,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_H3VAEDecodeFast": "🎬 H3 VAE 快速解码",
}
