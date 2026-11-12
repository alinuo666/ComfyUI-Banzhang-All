"""音频读写的最小公共层：解码 + 重采样 + 编码长度预算。

全插件共用这一份（导演台 csglide_cast / 媒体架间接调用 / AI 翻译器 /
班长音频处理节点 / 动作上下文 _h3mc）。此前每个模块各自写一遍
「torchaudio 优先、PyAV 兜底」，同一件事最多的时候有四份实现，且各自的声道
与位深处理都不一样。

为什么必须多后端：ComfyUI 各发行版带的音频栈并不一致。实测本机便携版
torchaudio.load 因缺 libtorchcodec 对**所有**格式一律失败，而同环境的 PyAV
与 soundfile 都完好；换一台机器可能正好反过来。能不能读取决于这台机器恰好
装了什么——这正是「同一个 wav，别人能用我不能用」的根。

顺序：soundfile（最快、自带解码器）→ PyAV（格式最全）→ torchaudio（兜底）。
重采样同样三档降级，永远不会因为少装一个库就让整次渲染失败。

后半部分（audio_vae_budget_seconds）是**编码长度预算**：H3 音频 VAE 的显存
占用随音频长度线性增长，而核心没有它的分块降级实现，撞了显存不是「慢一点」
而是必然崩溃。凡是往这颗 VAE 里送音频的地方，都要先过这里算一遍长度上限。
"""

import itertools

import numpy as np
import torch

try:
    import torchaudio
except Exception:  # pragma: no cover
    torchaudio = None

try:
    import av
except Exception:  # pragma: no cover
    av = None

try:
    # 自带 libsndfile，不依赖系统 ffmpeg——wav / flac / ogg / aiff 一类的第一选择。
    import soundfile as soundfile_lib
except Exception:  # pragma: no cover
    soundfile_lib = None


def stereo_channels(w):
    """声道归一到 2 轨：单声道复制一份，多声道取前两轨。

    H3 音频 VAE 固定要 2 轨。多轨环绕声不做矩阵下混——取前两轨保留原始左右
    声道、不会被相位抵消，比 swresample 的默认下混矩阵更可预期。
    """
    w = w.float()
    if w.ndim == 1:
        w = w[None, :]
    if w.shape[0] == 1:
        return w.repeat(2, 1)
    if w.shape[0] > 2:
        return w[:2]
    return w


# --------------------------------------------------------------------------
# 解码
#
# 全部支持 max_seconds（只解前 N 秒）：这不是「顺手加个优化」，而是参考音频
# 不爆显存的前提。解码完再切片意味着为了取前 15 秒要先解出整条 40 分钟的
# 素材——多花的 CPU 与内存毫无意义，还会在长素材上把交互卡死。
# --------------------------------------------------------------------------
def _want_frames(max_seconds, sr):
    """秒 → 采样帧数；None / 非正数表示不限制。"""
    if max_seconds is None:
        return None
    try:
        secs = float(max_seconds)
    except Exception:
        return None
    if secs <= 0:
        return None
    return int(round(secs * int(sr)))


def _decode_soundfile(path, max_seconds=None):
    if soundfile_lib is None:
        raise RuntimeError("未安装 soundfile")
    sr = int(soundfile_lib.info(path).samplerate)
    frames = _want_frames(max_seconds, sr)
    data, sr = soundfile_lib.read(
        path, frames=-1 if frames is None else frames,
        dtype="float32", always_2d=True)  # [N, C]
    return torch.from_numpy(np.ascontiguousarray(data.T)), int(sr)


def _decode_pyav(path, max_seconds=None):
    """容器与有损格式最全（mp3 / m4a / aac / opus / wma / ac3 / ape ...）。

    统一交给 libswresample 转成立体声 float planar，而不是手工拼
    frame.to_ndarray()：planar / interleaved 的形状约定与整数位深换算每一种
    格式都不一样，手写必然在某个长尾格式上翻车（典型症状是声道被当成时间轴、
    或 int16 没归一化导致满幅爆音）。
    """
    if av is None:
        raise RuntimeError("未安装 PyAV")
    chunks = []
    with av.open(path) as container:
        streams = container.streams.audio
        if not streams:
            raise ValueError("文件里没有音轨")
        sr = int(streams[0].rate)
        limit = _want_frames(max_seconds, sr)
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=sr)
        got = 0
        truncated = False
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                arr = out.to_ndarray()
                chunks.append(arr)
                got += arr.shape[-1]
            if limit is not None and got >= limit:
                truncated = True
                break
        # 提前收工就不要再 flush：flush 会把重采样器里剩下的尾巴吐出来，
        # 白白多解一段不需要的音频（长素材上这段可以很长）。
        if not truncated:
            chunks.extend(out.to_ndarray() for out in resampler.resample(None))
    if not chunks:
        raise ValueError("没解出任何音频帧")
    return torch.from_numpy(np.ascontiguousarray(np.concatenate(chunks, axis=-1))), sr


def _decode_torchaudio(path, max_seconds=None):
    if torchaudio is None:
        raise RuntimeError("未安装 torchaudio")
    if max_seconds is None:
        w, sr = torchaudio.load(path)
    else:
        info = torchaudio.info(path)
        frames = _want_frames(max_seconds, int(info.sample_rate))
        w, sr = torchaudio.load(path, num_frames=-1 if frames is None else frames)
    return w, int(sr)


def decode_audio_file(path, max_seconds=None):
    """解码任意音频文件为 (波形 [2, N] float32, 采样率)。三个后端依次降级。

    max_seconds 只解码前 N 秒（None = 整条）。三个后端都走原生截断而不是
    「解完再切」，所以素材再长，代价也只跟要用的那一段成正比。
    """
    tried = []
    for name, fn in (("soundfile", _decode_soundfile),
                     ("PyAV", _decode_pyav),
                     ("torchaudio", _decode_torchaudio)):
        try:
            waveform, sr = fn(path, max_seconds=max_seconds)
            if waveform.ndim == 1:
                waveform = waveform[None, :]
            return stereo_channels(waveform), int(sr)
        except Exception as e:
            tried.append("%s：%s" % (name, str(e).splitlines()[0][:110]))
    raise RuntimeError(
        "H3 Studio: 这个音频读不出来 —— 已依次尝试 soundfile / PyAV / torchaudio"
        " 三个解码器，全部失败：%s。请把文件转成 WAV 或 FLAC 后重试。"
        % "；".join(tried))


# --------------------------------------------------------------------------
# 重采样
# --------------------------------------------------------------------------
def _resample_torchaudio(flat, sr, target_sr):
    """torchaudio 的重采样是专业多相滤波，首选。"""
    if torchaudio is None:
        raise RuntimeError("未安装 torchaudio")
    return torchaudio.functional.resample(flat, sr, target_sr)


def _resample_pyav(flat, sr, target_sr):
    """降级档：PyAV 的 libswresample。只处理 1/2 轨——多轨交给下一档。"""
    if av is None:
        raise RuntimeError("未安装 PyAV")
    layout = {1: "mono", 2: "stereo"}.get(int(flat.shape[0]))
    if layout is None:
        raise ValueError("声道数 %d 不在 swresample 支持的布里" % flat.shape[0])
    resampler = av.AudioResampler(format="fltp", layout=layout, rate=target_sr)
    frame = av.AudioFrame.from_ndarray(
        flat.detach().cpu().numpy(), format="fltp", layout=layout)
    frame.rate = sr
    chunks = [f.to_ndarray() for f in resampler.resample(frame)]
    chunks += [f.to_ndarray() for f in resampler.resample(None)]
    if not chunks:
        raise ValueError("swresample 没吐出任何帧")
    return torch.from_numpy(np.ascontiguousarray(np.concatenate(chunks, axis=-1)))


def _resample_linear(flat, sr, target_sr):
    """最后一道：纯 torch 线性插值。宁可音质略差，也不让「少装个库」变成渲染失败。"""
    n = max(1, int(round(flat.shape[-1] * target_sr / sr)))
    return torch.nn.functional.interpolate(
        flat[None], size=n, mode="linear", align_corners=False)[0]


def resample_waveform(w, sr, target_sr):
    """重采样到 target_sr。输入 [C, T] 或 [B, C, T] 都行，形状原样奉还。

    内部一律摊平成 [声道, T] 再重采样，所以 B*C 大于 2 的批量输入走不了
    swresample（它的布局最多认立体声），会自动落到线性插值那一档——结果形状
    和语义都对，只有插值方式不同。
    """
    sr, target_sr = int(sr), int(target_sr)
    if sr == target_sr or w.numel() == 0:
        return w
    shape = w.shape
    flat = w if w.dim() == 2 else w.reshape(-1, shape[-1])
    out = None
    for fn in (_resample_torchaudio, _resample_pyav, _resample_linear):
        try:
            got = fn(flat, sr, target_sr)
            if got is not None and got.shape[-1] > 0:
                out = got
                break
        except Exception:
            continue
    if out is None:
        raise RuntimeError("H3 Studio: 重采样失败（%d Hz → %d Hz），三个后端都不可用。"
                           % (sr, target_sr))
    return out if w.dim() == 2 else out.reshape(shape[:-1] + (out.shape[-1],))


# --------------------------------------------------------------------------
# 编码长度策略（H3 音频 VAE）
#
# 为什么长度要有个上限：comfy/sd.py 的 VAE.encode 在显存不够时会退到分块编码，
# 而它的分派（sd.py:1451-1463）只实现了
#     latent_dim == 3                → encode_tiled_3d     （视频）
#     latent_dim == 1 / extra_1d_channel → encode_tiled_1d （其它音频）
#     其余                            → encode_tiled_      （图像版）
# H3 音频 VAE 是 latent_dim == 2（sd.py:1070），而它自己没有实现 encode_tiled
# （MiniMaxH3AudioVAE 里没有这个方法，所以 handles_tiling = False），于是必然
# 落到图像版分支去访问 shape[3]——音频张量只有 3 维，直接
#     IndexError: tuple index out of range
# 报错里没有一个字提到音频或长度。
#
# ⚠ 对策**不是**按显存截短音频（20261026 之前是这么做的，已拆掉，理由见
# audio_vae_budget_seconds 的注释）。现在的对策是两道：
#     ① 编码前用 audio_vae_need_bytes() 判一次，放不下就改走 CPU（不缩短）；
#     ② GPU 真抛错，接住再改走 CPU（_recover_cuda_cache 之后重试）。
# 这里的 AUDIO_VAE_* 常量只剩「语义上限」这一个职责：过长的音频对参考没有
# 价值，只会白烧时间。
AUDIO_VAE_SR = 32000               # H3 音频 VAE 的采样率（1 潜空间帧 = 800 样本 = 1/40 秒）
AUDIO_VAE_BYTES_PER_SAMPLE = 900   # 每样本的编码峰值字节
AUDIO_VAE_FIXED_BYTES = 105_000_000  # 固定开销 ≈ 105 MB
AUDIO_VAE_DTYPE_BYTES = 4          # working_dtypes = [float32]
AUDIO_VAE_HARD_CAP = 60.0          # 秒。远超训练分布的音频没有参考价值，只稀释预算
AUDIO_VAE_MIN = 5.0                # 秒。给参考音频用的「至少想给这么多」底量
AUDIO_VAE_FLOOR = 1.0              # 秒。绝对下限，任何情况下都不返回更短的值


def audio_vae_peak_gb(seconds, sr=None):
    """把「这段时长要多少显存」算成人话里的 GB（按 comfy/sd.py:1078 的官方口径）。

    口径：峰值 ≈ (900 × 样本数 + 105MB) × 4 (float32) × 1.03
    """
    samples = float(seconds) * int(sr or AUDIO_VAE_SR)
    return (AUDIO_VAE_BYTES_PER_SAMPLE * samples + AUDIO_VAE_FIXED_BYTES) \
        * AUDIO_VAE_DTYPE_BYTES * 1.03 / 1e9


def audio_vae_budget_seconds(desired_seconds, free_bytes=0.0, minimum=0.0):
    """这段音频**应该**编多长（秒）—— 只由语义决定，不再由显存决定。

    参数
      desired_seconds  想给的时长（比如 = 目标片段时长、= 要钉住的尾巴时长）
      free_bytes       【已废弃】为兼容旧调用保留，读进来就丢弃，不参与计算
      minimum          底量：想要的时长低于它时抬到它（参考音频用，普通调用给 0）

    ── 20261026：拆掉「显存预算一票否决」─────────────────────────────
    这里原本还有一道按空闲显存反推最长音频的硬截断（预算取 free×0.5，再减去
    105 MB 固定开销反解秒数），理由是撞显存会落进核心那条对本颗 VAE 必然崩溃
    的分块回退。这道截断是**多余的**，而且代价记在用户看不见的地方：

      · 更准的那道闸早就存在：`encode_audio_latent` 编码前先按
        `audio_vae_need_bytes()`（权重 + 激活，还知道权重此刻在不在卡上）判
        一次，放不下**直接改走 CPU**；GPU 真抛错还会再接住改走 CPU 重试。
        本函数这里的粗估（只按样本数反解）比它更差，却更保守。
      · CPU 那条路实测与原值余弦相似 0.99974、逐帧中位偏差 0.8%（比降到 fp16
        的 0.997 / 4.3% 更接近原值），只是多花几秒，不改音色味道。
      · 反过来，截短的后果是**音色参考覆盖不到整段片长**：参考音频被压到目标
        时长以下时，模型在没被覆盖的部分退回默认嗓音。现场实测就是这么一次
        静默失败 —— 7.18s 的音色配 9.42s 片长（覆盖 76%）出的是另一把嗓子，
        而日志里那句「自动截到 X 秒」看起来像正常行为，谁也查不出来。
      · 显存更紧时 `AUDIO_VAE_FLOOR`（1 秒）是绝对下限，等于把音色参考压成
        近乎没用 —— 这正是「宁可音频短到近乎没用，也不能崩」那句注释的代价。
      · 而音频本身不占什么显存：按 peak 口径 7.18s ≈ 1.28 GB，60 秒上限也才
        7.55 GB，与 20 GB 级的 DiT 不是一个量级。

    所以现在的口径：**长度只由语义与 `AUDIO_VAE_HARD_CAP` 决定；显存紧张就
    慢一点、走 CPU 编码，绝不偷偷缩短音频。**
    """
    del free_bytes          # 废弃参数：签名留着，只为不打破旧调用方
    desired = max(0.0, float(desired_seconds))
    limit = min(max(desired, float(minimum)), AUDIO_VAE_HARD_CAP)
    return max(AUDIO_VAE_FLOOR, limit)


def free_vram_bytes():
    """当前空闲显存；量不到就返回 0（0 = 不做显存限制）。"""
    try:
        import comfy.model_management as mm
        return float(mm.get_free_memory())
    except Exception:
        return 0.0


def _dtype_bytes(dtype):
    try:
        return max(1, int(torch.empty(0, dtype=dtype).element_size()))
    except Exception:
        return 4


def _module_device(module):
    try:
        return next(module.parameters()).device
    except Exception:
        return None


def _device_histogram(module):
    """扫**全部**参数与缓冲，返回 {设备类型: 个数}。

    为什么不抽查第一个参数：显存紧张时核心会把权重**按层部分卸载**到内存
    （VAE.encode 自己不 to(device)，设备由 patcher 经 load_models_gpu 托管），
    此时模型是「一半在卡上一半在内存」的混合状态。抽查第一个恰好落在 cpu 上，
    就会误判成「已经全在 CPU 了、不用搬」，而实际还有一部分权重留在卡上；
    随后拿 CPU 张量去跑立刻撞
    `Input type (torch.FloatTensor) and weight type (torch.cuda.FloatTensor)`。
    这个坑在真机压力测试里真实踩到过：压力下编完一次之后设备直方图是
    {'cpu': 658, 'cuda:0': 259}。
    """
    d = {}
    for t in itertools.chain(module.parameters(), module.buffers()):
        k = t.device.type
        d[k] = d.get(k, 0) + 1
    return d


def _force_cpu(module):
    """把模型**整份**请到内存，返回 (是否确认全部落位, 设备直方图)。

    无条件调用、不查不猜——已经在 CPU 时 `to("cpu")` 是廉价空转，比"先判断再
    决定搬不搬"安全得多。搬的过程若抛错（通常是刚 OOM 过、分配器还攥着缓存块，
    连本该只走主机的动作都会继续报 OOM）就回收缓存后补搬一次；补搬只会处理还
    没落位的那些张量，重复调用是安全的。
    """
    try:
        module.to("cpu")
    except Exception:
        _recover_cuda_cache()
        module.to("cpu")
    hist = _device_histogram(module)
    if set(hist) - {"cpu"}:
        _recover_cuda_cache()
        module.to("cpu")
        hist = _device_histogram(module)
    return set(hist) <= {"cpu"}, hist


def _restore_device(fsm, prev, audio_vae, log=None):
    """把权重送回 patcher 认定的设备。

    核心的 VAE.encode 从不自己 `to(device)`（sd.py:1411-1440），设备全权由
    patcher 经 load_models_gpu 托管；我们绕过 patcher 动过权重，就必须还回去，
    否则核心以为它还在卡上、实际躺在内存里。

    还回的代价是重新占一份权重显存（音频 VAE 约 0.7 GB），显存紧张时可能失败。
    失败**不静默吞掉**：先回收缓存补还一次，仍不行就留在 CPU —— CPU 本来就是这颗
    VAE 的 offload_device，是它的正常休息态；真到那一步说明显存确实不够，下一次
    GPU 调用会失败并再回到这条 CPU 路上，行为依然正确。此时打一行日志，免得日后
    拿着「模型莫名其妙在 CPU 上」的现场无从下手。
    """
    if prev is None or getattr(prev, "type", None) == "cpu":
        return
    dt = getattr(audio_vae, "vae_dtype", torch.float32)
    try:
        fsm.to(prev, dtype=dt)
        return
    except Exception:
        pass
    _recover_cuda_cache()
    try:
        fsm.to(prev, dtype=dt)
        return
    except Exception as e:
        if log:
            log("音频 VAE 编码完毕，但权重搬回 %s 失败（%s: %s）—— 先留在内存里，"
                "下次需要时会由核心重新加载。"
                % (prev, type(e).__name__, str(e).splitlines()[0][:60]))


_AUDIO_VAE_BYTES_CACHE = {}


def audio_vae_param_bytes(audio_vae):
    """这颗音频 VAE 的权重字节数（按它当前的计算精度）。"""
    key = id(audio_vae)
    hit = _AUDIO_VAE_BYTES_CACHE.get(key)
    if hit is not None and hit[0] is audio_vae:
        return hit[1]
    n = 0
    try:
        fsm = audio_vae.first_stage_model
        n = sum(int(p.numel()) for p in fsm.parameters())
        n += sum(int(b.numel()) for b in fsm.buffers())
    except Exception:
        n = 0
    n *= _dtype_bytes(getattr(audio_vae, "vae_dtype", torch.float32))
    _AUDIO_VAE_BYTES_CACHE[key] = (audio_vae, n)
    return n


def audio_vae_need_bytes(audio_vae, samples):
    """这次编码大约要多少显存 = 激活 + 还没搬上卡的权重。

    权重只有在模型此刻不在卡上时才计入——已经在卡上的部分不用再算一份，
    否则会对「明明放得下」的情况也误判成放不下。
    """
    dt = getattr(audio_vae, "vae_dtype", torch.float32)
    act = (AUDIO_VAE_BYTES_PER_SAMPLE * int(samples) + AUDIO_VAE_FIXED_BYTES) \
        * _dtype_bytes(dt) * 1.03
    weights = audio_vae_param_bytes(audio_vae)
    try:
        on_card = bool(set(_device_histogram(audio_vae.first_stage_model)) - {"cpu"})
    except Exception:
        on_card = False
    if on_card:
        weights = 0
    return act + weights


def _recover_cuda_cache():
    """把 CUDA 分配器里攥着的缓存块还回去，用于从 OOM 现场恢复。

    为什么需要：GPU 那条路失败（OOM）之后，分配器往往还攥着失败现场那一大堆
    缓存块，此时连「把权重搬回内存」这种本该只走主机的操作都会继续报 OOM。
    先还缓存再搬，是从 OOM 里爬出来的标准动作。

    注意 soft_empty_cache 内部会 torch.cuda.synchronize()，而同步本身可能再次
    抛错（正是在 OOM 现场），所以它放在第一档、失败后退到不同步的 empty_cache。
    """
    try:
        import comfy.model_management as mm
        mm.soft_empty_cache()
        return
    except Exception:
        pass
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass


def _normalize_waveform(waveform):
    """把波形整成内层模型要的 [B, 声道, 样本]。

    两条口径只差一个 movedim，传错却**不会报错**，只会静默算出一个荒唐的形状：
    内层 MiniMaxH3AudioVAE.encode 按 (b, s, length) 解形状（audio_vae.py:433），
    拿到 [1, L, 2] 就会以为「1 条、声道数是 L、每个声道 2 个样本」，把 2 个样本
    补齐到 800，再 reshape 成 (L, 1, 800)——第一层 Conv1d(1→64) 当场要吃
    1920000×64×800 个元素 = 393 GB。实测报错就是
    `DefaultCPUAllocator: not enough memory: you tried to allocate 393216000000 bytes`。
    """
    x = waveform.to("cpu", dtype=torch.float32).contiguous()
    if x.ndim == 3 and x.shape[1] != 2 and x.shape[-1] == 2:
        x = x.movedim(-1, 1).contiguous()
    return x


def encode_audio_latent_cpu(audio_vae, waveform, log=None):
    """在 CPU 上把 [B, 2, N] 波形编成 H3 音频潜空间，返回 [B, 32, 2, T]。

    直接调内层模型，绕过 comfy 的 VAE 包装器——包装器会强行把张量搬到
    `self.device`，而这里要的恰恰是「别碰显存」。值等价性：本模型是 causal
    注意力 + 卷积，VAE 的 process_input 对音频是恒等映射，所以直接调用与走
    包装器在数学上是同一件事，只差浮点累加次序（实测余弦相似 0.99974）。

    搬模型的讲究：VAE 的 offload_device 本来就是 CPU，也就是说「待在 CPU」
    是它的正常休息态。所以这里只是把权重请回休息态干完活，干完立刻搬回
    `audio_vae.device`（patcher 记账里它在哪，就回哪）——拿抽查结果当依据是
    不行的，见 _device_histogram 的注释。
    """
    fsm = audio_vae.first_stage_model
    x = _normalize_waveform(waveform[:1])

    prev = getattr(audio_vae, "device", None) or _module_device(fsm)

    ok, hist = _force_cpu(fsm)
    if not ok:
        raise RuntimeError(
            "H3 Studio: 音频 VAE 无法整份加载到内存（仍有 %s 留在显存上），"
            "CPU 兜底编码不可用，请先腾出一些显存后重试。"
            % {k: v for k, v in hist.items() if k != "cpu"})

    try:
        with torch.no_grad():
            z = fsm.encode(x).detach()
    finally:
        _restore_device(fsm, prev, audio_vae, log)
    # 与走包装器时保持一致：落到 output_device / 输出精度，下游拿到的形状与
    # 设备口径完全一样，缓存里存的也是这一份。
    try:
        z = z.to(device=audio_vae.output_device, dtype=audio_vae.vae_output_dtype())
    except Exception:
        pass
    return z


def encode_audio_latent(audio_vae, waveform, label="", log=None, headroom=0.9):
    """把 [B, 2, N] 波形编成 H3 音频潜空间。返回 (latent, 实际用的设备)。

    GPU 优先；**预判放不下、或 GPU 这条路失败，都自动改走 CPU**。两条路都要有，
    因为它们覆盖的是不同的失败：

      · 预判：权重 + 激活的估算已经超出空闲显存的 90%，那就别去撞——撞上去
        不只是慢，核心会先 OOM、再退到对本颗 VAE 必然崩的分块回退上。
      · 兜底：估算偏乐观、或者显存在两次测量之间被别的节点占走。此时 GPU 那条
        路会抛错（就是那个与音频毫无关系的 tuple 错误），接住它改走 CPU。

    CPU 那条路实测余弦相似 0.99974、逐帧中位偏差 0.8%，比降到 fp16
    （0.997 / 4.3%）明显更接近原值——慢几秒，但不改音色味道。
    """
    x = _normalize_waveform(waveform[:1])
    need = audio_vae_need_bytes(audio_vae, int(x.shape[-1]))
    free = free_vram_bytes()
    name = label or "(未命名)"
    if free > 0 and need > free * headroom:
        if log:
            log("音频 %s 编码约需 %.2f GB（含权重），当前空闲显存 %.2f GB ——"
                " 自动改走 CPU 编码：不占显存，多花几秒，结果与 GPU 几乎一致。"
                % (name, need / 1e9, free / 1e9))
        return encode_audio_latent_cpu(audio_vae, x, log=log), "cpu"
    try:
        # 包装器内部自己会把张量搬到 self.device，这里交给它即可
        return audio_vae.encode(x.movedim(1, -1)), "gpu"
    except Exception as e:
        if log:
            log("音频 %s 在 GPU 上编码失败（%s）—— 自动改走 CPU 编码重试。"
                % (name, "%s: %s" % (type(e).__name__,
                                     str(e).splitlines()[0][:90])))
        # 失败往往伴随 OOM，先把分配器的缓存还回去，否则「搬权重到内存」这种
        # 本该只走主机的动作都会继续报 OOM（实测过，见 _recover_cuda_cache）。
        _recover_cuda_cache()
        return encode_audio_latent_cpu(audio_vae, x, log=log), "cpu"
