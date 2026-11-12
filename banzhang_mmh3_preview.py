"""MiniMax H3 Preview Override — kjnodes-style live preview for MiniMax H3.

合并自 ComfyUI-MiniMaxH3-PreviewOverride（班长全家桶集成版，原 node_id 保持不变）。

Port of KJNodes' "Model Preview Override" for the MiniMax H3 AV model.

Instead of the default 512px first-frame preview, this node attaches an
OUTER_SAMPLE wrapper to the model. On every sampler step the H3 *video* latent
(the first stream of the NestedTensor) is decoded and pushed to a DOM widget
on this node via the "minimax_h3_preview_override" websocket event, at full
sampler resolution (capped by max_resolution).

Decoding paths:
  0. Optional tiny VAE (TAEHV/TAESD from MiniMax H3 Tiny VAE Loader) -> true-RGB
     previews via vae.decode(). Only tiny decoders are accepted: a full VAE (e.g.
     minimax_h3_video_vae) is IGNORED, because decoding it every step while the DiT
     is resident blows up VRAM (that was the original VRAM-killer).
  1. Animated Latent2RGB     -> preview_frames temporal slices decoded with the
                                H3 latent_rgb_factors (24ch), played back as
                                WebP/MP4 at preview_fps (preview_frames > 1).
  2. Single Latent2RGB frame -> one JPEG per step (preview_frames = 1).

For full-quality frames use the regular VAEDecode after sampling.

The payload schema matches KJNodes' so the same JS widget conventions apply:
boundary-0 message carries the sigma schedule, step messages carry the image.
"""

import base64
import io as pyio
import logging
import queue
import threading
import time

import numpy as np
import torch

import comfy.patcher_extension
import comfy.utils
import folder_paths
import latent_preview
from comfy_api.latest import io
from PIL import Image, ImageOps

try:
    from server import PromptServer
except ImportError:
    PromptServer = None


def _suppressed_preview_image(self_, preview_format, x0):
    return None


class _AsyncPreviewEncoder:
    """Off-thread encoder. Bounded FIFO drops-on-full so the sampler never blocks on us."""

    _STOP = object()

    def __init__(self, max_in_flight=2):
        self.q = queue.Queue(maxsize=max_in_flight)
        self.thread = threading.Thread(target=self._run, name="minimax_h3_preview_encoder", daemon=True)
        self.thread.start()

    def submit(self, fn):
        try:
            self.q.put_nowait(fn)
            return True
        except queue.Full:
            return False

    def _run(self):
        while True:
            item = self.q.get()
            if item is self._STOP:
                return
            try:
                item()
            except Exception:
                logging.exception("[MiniMax H3 Preview Override] async encoder error")

    def shutdown(self, drain_timeout=5.0):
        try:
            self.q.put(self._STOP, timeout=drain_timeout)
        except queue.Full:
            pass
        self.thread.join(timeout=drain_timeout)


def _get_core_previewer(load_device, latent_format):
    # Walk past custom-node hooks on get_previewer to reach the unwrapped core function.
    fn = latent_preview.get_previewer
    seen = set()
    while hasattr(fn, "__wrapped__") and id(fn) not in seen:
        seen.add(id(fn))
        fn = fn.__wrapped__
    return fn(load_device, latent_format)


def _video_part(x0, latent_shapes):
    """Extract the video stream from an H3 latent.

    Nested latents are packed flat ([B, 1, N]) before sampling, and an OUTER_SAMPLE
    wrapper that replaces the callback receives the *packed* tensor at step boundaries
    (the sampler's own unpack wrapper is bypassed). Handle both the already-unpacked
    NestedTensor and the flat-packed tensor here.
    """
    if getattr(x0, "is_nested", False):
        return x0.unbind()[0]
    if latent_shapes is not None and len(latent_shapes) > 1:
        return comfy.utils.unpack_latents(x0, latent_shapes)[0]
    return x0


_tae_decode_warned = False


def _tae_decode_to_pil(decoder, video_5d, max_frames=None):
    """True-RGB preview via a tiny decoder (TAEHV / 扁平 TAESD 式), kjnodes-style.

    decoder.decode_video returns [n, 3, H, W]: uint8 for TinyVAEDecoder,
    0..1 float for TAEHVDecoder. Any failure returns [] so the caller falls back to
    Latent2RGB; the warning is logged once, not per step.
    """
    global _tae_decode_warned
    if video_5d.ndim != 5:
        return []
    try:
        t_total = video_5d.shape[2]
        n = t_total
        indices = None
        if max_frames is not None and 0 < max_frames < t_total:
            n = int(max_frames)
            indices = np.linspace(0, t_total - 1, n).round().astype(int).tolist()
        out = decoder.decode_video(video_5d[:1], indices)
        if not torch.is_tensor(out):
            return []
        # [n, 3, H, W] -> [n, H, W, 3]
        frames = out.detach().float()
        if frames.max().item() <= 1.5:  # TAEHV 输出 0..1
            frames = frames.mul_(255.0)
        u8 = frames.clamp_(0, 255).to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
        return [Image.fromarray(u8[i]) for i in range(u8.shape[0])]
    except Exception as e:
        if not _tae_decode_warned:
            _tae_decode_warned = True
            logging.warning(f"[MiniMax H3 PreviewOverride] Tiny VAE decode failed, falling back to Latent2RGB: {e}")
        return []


def _vae_approx_list():
    """TAE files available in ComfyUI/models/vae_approx for the vae_name combo."""
    try:
        options = sorted(folder_paths.get_filename_list("vae_approx"))
    except Exception:
        options = []
    return options or ["MiniMax-H3-TAE.safetensors"]


def _load_tiny_vae(vae_name):
    """Load a tiny decoder from models/vae_approx via the KJNodes-style loader.

    comfy.sd.VAE cannot build these files: core's TAEHV derives patch_size from the
    channel count and has no entry for H3's 24 channels, and flat TAESD-style files
    (MiniMax-H3-TAE) aren't recognised at all — core silently produced None there and
    the node kept falling back to Latent2RGB (the "blurry preview" bug).
    """
    from .banzhang_mmh3_tinyvae import load_tiny_vae_decoder

    decoder = load_tiny_vae_decoder(vae_name)
    if decoder is None:
        raise RuntimeError(f"tiny VAE decoder '{vae_name}' unavailable")
    return decoder


def _decode_video_frames_l2rgb(x0_5d, latent_format, max_frames, stride=1):
    """Decode T temporal frames of a 5D video latent via latent_rgb_factors -> list[PIL].

    Mirrors KJNodes' helper: linear project [B,24,T,H,W] with the format's
    latent_rgb_factors, then scale -1..1 -> 0..255 (same math as core preview_to_image).
    """
    if x0_5d.ndim != 5:
        return []
    rgb_factors = getattr(latent_format, "latent_rgb_factors", None)
    if rgb_factors is None:
        return []
    try:
        reshape = getattr(latent_format, "latent_rgb_factors_reshape", None)
        if reshape is not None:
            x0_5d = reshape(x0_5d)
        bias = getattr(latent_format, "latent_rgb_factors_bias", None)
        factors = torch.tensor(rgb_factors, device=x0_5d.device, dtype=x0_5d.dtype).transpose(0, 1)
        bias_t = torch.tensor(bias, device=x0_5d.device, dtype=x0_5d.dtype) if bias is not None else None
        x = x0_5d[0]
        if stride > 1:
            x = x[:, ::stride]
        t_total = x.shape[1]
        if max_frames > 0 and max_frames < t_total:
            indices = np.linspace(0, t_total - 1, max_frames).round().astype(int).tolist()
            x = x[:, indices]
        x = x.movedim(0, -1)
        rgb = torch.nn.functional.linear(x, factors, bias=bias_t)
        rgb.add_(1.0).mul_(127.5).clamp_(0, 255)
        rgb_cpu = rgb.to(torch.uint8).cpu().numpy()
        return [Image.fromarray(rgb_cpu[i]) for i in range(rgb_cpu.shape[0])]
    except Exception:
        return []


# PyPI PyAV wheels typically lack NVENC; probe once at import.
def _probe_nvenc():
    try:
        import av  # noqa
        av.Codec("h264_nvenc", "w")
        return True
    except Exception:
        return False


_NVENC_AVAILABLE = _probe_nvenc()

# NVENC H.264 rejects sub-145x49 inputs at avcodec_open2 — fall back to WebP for small frames.
_NVENC_MIN_W = 145
_NVENC_MIN_H = 49

_nvenc_warned = False


def _encode_mp4_nvenc(frames, fps, max_res):
    """Fragmented MP4 so the browser can decode mid-download. Returns (None, 0, 0) on
    failure (including too-small-for-NVENC), so the caller falls through to WebP."""
    global _nvenc_warned
    if not frames:
        return None, 0, 0
    try:
        import av
    except Exception:
        return None, 0, 0
    pil_frames = []
    for f in frames:
        pf = f if f.mode == "RGB" else f.convert("RGB")
        if max_res and max_res > 0 and (pf.width > max_res or pf.height > max_res):
            pf = ImageOps.contain(pf, (max_res, max_res), Image.LANCZOS)
        pil_frames.append(pf)
    # yuv420p requires even dimensions.
    w0, h0 = pil_frames[0].width, pil_frames[0].height
    out_w, out_h = w0 & ~1, h0 & ~1
    if (out_w, out_h) != (w0, h0):
        pil_frames = [pf.resize((out_w, out_h), Image.LANCZOS) for pf in pil_frames]
    if out_w < _NVENC_MIN_W or out_h < _NVENC_MIN_H:
        return None, 0, 0
    option_candidates = [
        {"preset": "p1", "rc": "vbr", "cq": "23"},
        {"preset": "p1"},
    ]
    last_err = None
    for opts in option_candidates:
        buf = pyio.BytesIO()
        try:
            container = av.open(
                buf, mode="w", format="mp4",
                options={"movflags": "frag_keyframe+empty_moov+default_base_moof"},
            )
            stream = container.add_stream("h264_nvenc", rate=int(max(1, fps)))
            stream.width = out_w
            stream.height = out_h
            stream.pix_fmt = "yuv420p"
            stream.options = opts
            for pf in pil_frames:
                for pkt in stream.encode(av.VideoFrame.from_image(pf)):
                    container.mux(pkt)
            for pkt in stream.encode():
                container.mux(pkt)
            container.close()
            return base64.b64encode(buf.getvalue()).decode("ascii"), out_w, out_h
        except Exception as e:
            last_err = e
            continue
    if not _nvenc_warned:
        _nvenc_warned = True
        logging.warning(f"[MiniMax H3 PreviewOverride] NVENC MP4 encode failed, using WebP fallback: {last_err}")
    return None, 0, 0


def _encode_animated_webp(frames, fps, quality, max_res, duration_ms_override=None):
    if not frames:
        return None, 0, 0
    pil_frames = []
    for f in frames:
        pf = f if f.mode == "RGB" else f.convert("RGB")
        if max_res and max_res > 0 and (pf.width > max_res or pf.height > max_res):
            pf = ImageOps.contain(pf, (max_res, max_res), Image.LANCZOS)
        pil_frames.append(pf)
    # 帧延时优先用「段真实秒数 / 帧数」算出的值，回放速度与成片 1:1；
    # 独立节点不传段长时退回 fps 语义。
    duration_ms = (max(1, int(round(duration_ms_override)))
                   if duration_ms_override and duration_ms_override > 0
                   else max(1, int(round(1000 / max(1, fps)))))
    buf = pyio.BytesIO()
    try:
        pil_frames[0].save(
            buf,
            format="WEBP",
            save_all=True,
            append_images=pil_frames[1:],
            duration=duration_ms,
            loop=0,
            quality=quality,
            # method=2：72 帧 576x320 实测 755ms（method=4 要 2.1 秒，且长时间占 GIL
            # 反拖采样主线程）；体积 1.78MB，比 method=4 的 1.69MB 只大 5%。
            method=2,
        )
    except Exception as e:
        logging.warning(f"Animated WebP encode failed: {e}")
        return None, 0, 0
    return base64.b64encode(buf.getvalue()).decode("ascii"), pil_frames[0].width, pil_frames[0].height


class _H3PreviewOverrideWrapper:
    def __init__(self, max_resolution, node_id, jpeg_quality, suppress_default,
                 preview_frames=1, preview_fps=12, vae=None, lite_animation=False,
                 segment_seconds=0.0):
        self.max_resolution = max_resolution
        self.node_id = str(node_id) if node_id is not None else None
        self.jpeg_quality = jpeg_quality
        self.suppress_default = suppress_default
        self.preview_frames = preview_frames
        self.preview_fps = preview_fps
        self.frames = []
        # 轻量动画路线（导演台内置专用）：只用 latent_rgb_factors 抽时间切片，
        # 不跑 tiny VAE 的逐帧 GPU 前向，也不建 NVENC 会话。
        self.lite_animation = bool(lite_animation)
        # 本段成片真实时长（秒）：帧延时 = 段秒数 / 实际解码帧数，保证 1:1 播放。
        self.segment_seconds = float(segment_seconds or 0.0)
        # Only tiny decoders (TAEHV / flat TAESD-style) are allowed per step; the loader
        # returns one of those or None. A full video VAE would eat VRAM every step.
        self.vae = vae
        self._tiny_vae = vae is not None
        if vae is not None:
            logging.info(
                f"[MiniMax H3 PreviewOverride] tiny decoder {type(vae).__name__}: "
                f"{getattr(vae, 'latent_channels', '?')}ch, upscale x{getattr(vae, 'upscale_ratio', '?')}"
            )

    def __call__(self, executor, noise, latent_image, sampler, sigmas, denoise_mask,
                 callback, disable_pbar, seed, latent_shapes):
        guider = executor.class_obj
        model_patcher = guider.model_patcher
        latent_format = model_patcher.model.latent_format

        # Preflight: a tiny decoder must match the model's video latent channels (H3 = 24).
        # A mismatched TAE (e.g. the 128-channel LTX2 tae) physically cannot decode H3 latents
        # — disable it with one clear warning instead of failing every step.
        if self._tiny_vae:
            try:
                want = latent_shapes[0][1] if latent_shapes and len(latent_shapes) > 0 \
                    else getattr(latent_format, "latent_channels", None)
                have = getattr(self.vae, "latent_channels", None)
                if want is not None and have is not None and have != want:
                    logging.warning(
                        f"[MiniMax H3 PreviewOverride] Loaded TAE has {have} latent channels but "
                        f"the model needs {want} — it cannot decode these latents. TAE previews "
                        f"disabled, using Latent2RGB. (LTX/Wan TAEs are incompatible with H3; "
                        f"a 24-channel H3 TAE is required.)"
                    )
                    self._tiny_vae = False
            except Exception:
                pass

        # H3's MiniMaxH3AV has no taesd_decoder_name, so the core previewer is Latent2RGB.
        previewer = _get_core_previewer(model_patcher.load_device, latent_format)
        # Explicit Latent2RGB built from the format's own factors (24ch video stream).
        fallback_previewer = None
        try:
            rgb_factors = getattr(latent_format, "latent_rgb_factors", None)
            if rgb_factors is not None:
                fallback_previewer = latent_preview.Latent2RGBPreviewer(
                    rgb_factors,
                    getattr(latent_format, "latent_rgb_factors_bias", None),
                    getattr(latent_format, "latent_rgb_factors_reshape", None),
                )
        except Exception:
            pass

        original_callback = callback
        node_id = self.node_id
        max_res = self.max_resolution
        quality = self.jpeg_quality
        self.frames = []

        sigmas_list = sigmas.detach().cpu().tolist() if sigmas is not None else []

        # Pre-seed so step 1 has a measurable Δ (model's first transformation noise -> x0).
        initial_video_cpu = None
        try:
            if sigmas is not None and len(sigmas) > 0:
                s0 = sigmas[0].to(noise.device) if hasattr(sigmas[0], "to") else sigmas[0]
                seeded = noise * s0  # flat packed tensor at OUTER_SAMPLE level
                initial_video_cpu = _video_part(seeded, latent_shapes).detach().float().cpu()
        except Exception as e:
            logging.warning(f"[MiniMax H3 PreviewOverride] initial seed Δ pre-fill failed: {e}")

        state = {"last_video_gpu": None, "last_time": None, "step_ms_window": []}
        total_steps_init = max(0, len(sigmas_list) - 1)

        # Boundary-0 message: sigma schedule (required by JS) plus optional noise preview.
        if node_id is not None and PromptServer is not None:
            init_payload = {
                "node_id": node_id,
                "step": 0,
                "total": total_steps_init,
                "sigma": sigmas_list[0] if sigmas_list else None,
                "sigmas": sigmas_list,
            }
            try:
                pil_init = None
                if initial_video_cpu is not None and initial_video_cpu.ndim == 5:
                    if fallback_previewer is not None:
                        out = fallback_previewer.decode_latent_to_preview(initial_video_cpu)
                        if isinstance(out, Image.Image):
                            pil_init = out
                if pil_init is not None:
                    if pil_init.mode != "RGB":
                        pil_init = pil_init.convert("RGB")
                    if max_res and max_res > 0 and (pil_init.width > max_res or pil_init.height > max_res):
                        pil_init = ImageOps.contain(pil_init, (max_res, max_res), Image.LANCZOS)
                    ibuf = pyio.BytesIO()
                    pil_init.save(ibuf, format="JPEG", quality=quality)
                    init_payload["image"] = base64.b64encode(ibuf.getvalue()).decode("ascii")
                    init_payload["w"] = pil_init.width
                    init_payload["h"] = pil_init.height
            except Exception as e:
                logging.warning(f"Initial noise preview failed (sigmas still sent): {e}")
            PromptServer.instance.send_sync("minimax_h3_preview_override", init_payload, PromptServer.instance.client_id)

        encoder = _AsyncPreviewEncoder()
        animate_video = self.preview_frames > 1 or self.lite_animation
        anim_frames = self.preview_frames
        anim_fps = self.preview_fps

        def new_callback(step, x0, x, total_steps_):
            if previewer is not None or fallback_previewer is not None:
                try:
                    video = _video_part(x0, latent_shapes)
                    if not isinstance(video, torch.Tensor):
                        raise TypeError(f"unexpected x0 type: {type(video).__name__}")

                    pil_frames = []
                    if self._tiny_vae and video.ndim == 5:
                        # 源节点那套 tiny VAE 真解码：16 倍上采样出 576x320 真 RGB，
                        # 比 L2RGB 的 36x20 格点插值放大清晰得多。
                        # lite 路线缺省解全部时间格（preview_frames=0）：
                        # 实测 72 帧 314ms，而单步采样 20.7s，占比 1.5%，可忽略；
                        # 帧数越多动作越连贯，帧延时再由段长摊平保证 1:1。
                        n = anim_frames if (self.lite_animation or animate_video) else 1
                        pil_frames = _tae_decode_to_pil(self.vae, video, max_frames=n)
                    # 帧延时按「段秒数 / 实际解出的帧数」算，与解码帧数无关，
                    # 永远 1:1；不按手填 fps 播（否则整段被压进 1 秒，快放）。
                    frame_ms = 0.0
                    if self.segment_seconds > 0 and len(pil_frames) > 1:
                        frame_ms = self.segment_seconds * 1000.0 / len(pil_frames)
                    if not pil_frames and animate_video and video.ndim == 5:
                        pil_frames = _decode_video_frames_l2rgb(video, latent_format, anim_frames)
                    if not pil_frames:
                        for prev in (previewer, fallback_previewer):
                            if prev is None:
                                continue
                            try:
                                out = prev.decode_latent_to_preview(video)
                            except Exception as e:
                                if prev is previewer:
                                    logging.warning(f"Active previewer raised, trying Latent2RGB fallback: {e}")
                                continue
                            if isinstance(out, Image.Image):
                                pil_frames = [out]
                                break
                            elif prev is previewer:
                                logging.warning(
                                    f"[MiniMax H3 PreviewOverride] {type(previewer).__name__} returned "
                                    f"{type(out).__name__} instead of PIL.Image — falling back to Latent2RGB."
                                )

                    if not pil_frames:
                        if original_callback is not None:
                            original_callback(step, x0, x, total_steps_)
                        return

                    pil_first = pil_frames[0]
                    if pil_first.mode != "RGB":
                        pil_first = pil_first.convert("RGB")
                        pil_frames[0] = pil_first
                    # Kept so a second run could reuse captured frames if needed.
                    self.frames.append(pil_first)

                    if node_id is not None and PromptServer is not None:
                        # Δ over the video stream only; computed on GPU to avoid a per-step
                        # full-latent CPU copy (keeps one latent in VRAM instead).
                        delta_v = None
                        try:
                            video_cur = video.detach()
                            prev = state["last_video_gpu"]
                            if prev is not None and prev.shape == video_cur.shape:
                                diff = video_cur.float().sub(prev.float())
                                delta_v = (diff.norm() / max(1, diff.numel()) ** 0.5).item()
                            state["last_video_gpu"] = video_cur
                        except Exception as e:
                            logging.warning(f"[MiniMax H3 PreviewOverride] Δ failed: {e}")

                        now = time.perf_counter()
                        step_ms = None
                        if state["last_time"] is not None:
                            step_ms = (now - state["last_time"]) * 1000.0
                            w = state["step_ms_window"]
                            w.append(step_ms)
                            if len(w) > 8:
                                w.pop(0)
                        state["last_time"] = now
                        avg_step_ms = (sum(state["step_ms_window"]) / len(state["step_ms_window"])) if state["step_ms_window"] else None
                        sigma_val = sigmas_list[step] if 0 <= step < len(sigmas_list) else None
                        sent_step = step + 1

                        def _encode_and_send(
                            pil_frames=pil_frames, step_ms=step_ms, avg_step_ms=avg_step_ms,
                            sigma_val=sigma_val, sent_step=sent_step, total_steps_=total_steps_,
                            delta_v=delta_v, frame_ms=frame_ms,
                        ):
                            play_rate = None
                            if len(pil_frames) > 1:
                                b64, w_, h_, mime = None, 0, 0, None
                                # 借鉴源节点：优先 NVENC 出 MP4（实测 72 帧 576x320
                                # 编码 199ms，WebP 要 787ms；NVENC 走 GPU 且编码时
                                # 释 放 GIL，不拖采样主线程）。MP4 装不下时落 WebP。
                                enc_fps = anim_fps
                                if self.segment_seconds > 0:
                                    # 烘焙帧率取最近整数，残余误差交给前端
                                    # playbackRate 抹平：墙钟时长恒等于段长。
                                    enc_fps = max(1, int(round(
                                        len(pil_frames) / self.segment_seconds)))
                                    play_rate = (len(pil_frames)
                                                 / (enc_fps * self.segment_seconds))
                                if _NVENC_AVAILABLE:
                                    b64, w_, h_ = _encode_mp4_nvenc(pil_frames, enc_fps, max_res)
                                    if b64:
                                        mime = "video/mp4"
                                if not b64:
                                    b64, w_, h_ = _encode_animated_webp(
                                        pil_frames, anim_fps, quality, max_res,
                                        duration_ms_override=frame_ms)
                                    mime = "image/webp"
                                    play_rate = None
                            else:
                                pil_send = pil_frames[0]
                                if max_res and max_res > 0 and (pil_send.width > max_res or pil_send.height > max_res):
                                    pil_send = ImageOps.contain(pil_send, (max_res, max_res), Image.LANCZOS)
                                buf = pyio.BytesIO()
                                pil_send.save(buf, format="JPEG", quality=quality)
                                b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                                w_, h_ = pil_send.width, pil_send.height
                                mime = "image/jpeg"

                            if not b64:
                                return

                            PromptServer.instance.send_sync(
                                "minimax_h3_preview_override",
                                {
                                    "node_id": node_id,
                                    "image": b64,
                                    "mime": mime,
                                    "w": w_,
                                    "h": h_,
                                    "step": sent_step,
                                    "total": total_steps_,
                                    "sigma": sigma_val,
                                    "sigmas": None,
                                    "delta": delta_v,
                                    "step_ms": step_ms,
                                    "avg_step_ms": avg_step_ms,
                                    "fps": anim_fps if mime in ("video/mp4", "image/webp") else None,
                                    # MP4 专用：前端 <video> 的 playbackRate，
                                    # = 片段时长 / 段真实秒数，保证 1:1 回放。
                                    "rate": play_rate,
                                },
                                PromptServer.instance.client_id,
                            )

                        encoder.submit(_encode_and_send)
                except Exception as e:
                    logging.warning(f"[MiniMax H3 PreviewOverride] step preview failed: {e}")
            if original_callback is not None:
                original_callback(step, x0, x, total_steps_)

        # Suppress every concrete decode_latent_to_preview_image so only this node's
        # preview updates while sampling (progress bar still advances).
        prev_methods = []
        if self.suppress_default:
            targets = [latent_preview.LatentPreviewer]
            stack = list(latent_preview.LatentPreviewer.__subclasses__())
            while stack:
                cls = stack.pop()
                targets.append(cls)
                stack.extend(cls.__subclasses__())
            for cls in targets:
                if "decode_latent_to_preview_image" in cls.__dict__:
                    prev_methods.append((cls, cls.__dict__["decode_latent_to_preview_image"]))
                    cls.decode_latent_to_preview_image = _suppressed_preview_image
        try:
            state["last_time"] = time.perf_counter()
            return executor(noise, latent_image, sampler, sigmas, denoise_mask, new_callback,
                            disable_pbar, seed, latent_shapes=latent_shapes)
        finally:
            encoder.shutdown(drain_timeout=5.0)
            for cls, prev in prev_methods:
                cls.decode_latent_to_preview_image = prev
            # Don't keep the last sampled latent pinned on GPU after the run.
            state["last_video_gpu"] = None


class MiniMaxH3PreviewOverride(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxH3PreviewOverride",
            display_name="班长 MiniMax H3 预览覆盖",
            category="👨‍🏫班长/MiniMax H3",
            description=(
                "在节点上为 MiniMax H3 开启逐帧实时预览面板。默认预览只有 512px 且仅显示第一帧；"
                "本节点把 H3 视频 latent 每步解码为全分辨率画面（可选动画）推送到节点内置控件，"
                "并附带 σ/Δ 曲线与步耗时统计。"
            ),
            inputs=[
                io.Model.Input("model", display_name="模型", tooltip="接入预览覆盖的 MiniMax H3 模型（建议接在 MiniMaxH3SigmaShift 之后）。"),
                io.Int.Input(
                    "max_resolution",
                    display_name="最大分辨率",
                    default=960,
                    min=0,
                    max=8192,
                    step=8,
                    tooltip="预览画面最长边（像素）。0 = 不缩放，按采样原始分辨率输出。",
                ),
                io.Int.Input(
                    "jpeg_quality",
                    display_name="预览画质",
                    default=80,
                    min=30,
                    max=100,
                    step=1,
                    tooltip="预览传输使用的 JPEG/WebP 画质。",
                ),
                io.Boolean.Input(
                    "suppress_default_preview",
                    display_name="抑制默认预览",
                    default=True,
                    tooltip="采样时隐藏采样器节点上的标准预览，只更新本节点的画面。进度条不受影响。",
                ),
                io.Int.Input(
                    "preview_frames",
                    display_name="预览帧数",
                    default=60,
                    min=1,
                    max=1024,
                    step=1,
                    tooltip="每步从 H3 视频 latent 中抽取的帧数，用于动画预览。"
                            "1 = 单帧（最快）。>1 = 动画 WebP（有 NVENC 时为 MP4），按下方帧率回放。",
                ),
                io.Int.Input(
                    "preview_fps",
                    display_name="预览帧率",
                    default=4,
                    min=1,
                    max=60,
                    step=1,
                    tooltip="动画预览的回放帧率。预览帧数=1 时无效。",
                ),
                io.Combo.Input(
                    "vae_name",
                    display_name="VAE文件",
                    options=_vae_approx_list(),
                    default="MiniMax-H3-TAE.safetensors",
                    tooltip="从 models/vae_approx 选择小型自编码器文件，用于每步真 RGB 解码。"
                            "优先使用 MiniMax-H3-TAE.safetensors（H3 官方小型解码器，真 RGB 最清晰）；"
                            "已放入 ComfyUI/models/vae_approx/。",
                ),
            ],
            outputs=[io.Model.Output(display_name="模型", tooltip="附加了预览覆盖的模型。")],
            hidden=[io.Hidden.unique_id],
            is_experimental=True,
        )

    @classmethod
    def execute(cls, model, max_resolution, jpeg_quality, suppress_default_preview,
                preview_frames, preview_fps,
                vae_name="MiniMax-H3-TAE.safetensors", **legacy) -> io.NodeOutput:
        # 音频预览已下线。旧工作流里还存着 audio_preview / audio_preview_from /
        # audio_vae 三个键，ComfyUI 会原样把它们塞进 execute()，不吸收掉整条
        # 工作流就跑不起来（TypeError: unexpected keyword argument）。
        del legacy
        m = apply_h3_preview_override(
            model, cls.hidden.unique_id,
            max_resolution=max_resolution,
            jpeg_quality=jpeg_quality,
            suppress_default_preview=suppress_default_preview,
            preview_frames=preview_frames,
            preview_fps=preview_fps,
            vae_name=vae_name,
        )
        return io.NodeOutput(m)


def apply_h3_preview_override(model, node_id, *, max_resolution=960, jpeg_quality=80,
                              suppress_default_preview=False, preview_frames=1,
                              preview_fps=4,
                              vae_name="MiniMax-H3-TAE.safetensors",
                              lite_animation=False, segment_seconds=0.0):
    """供导演台内置调用的预览安装函数：clone model 并装 OUTER_SAMPLE wrapper。

    事件名 / payload 与本节点完全一致，js/csglide_cast_monitor.js 直接订阅
    "minimax_h3_preview_override" 即可，不必在画布上再串独立节点。
    与节点默认值的两点差异（内置场景更安全）：
      · suppress_default_preview=False：不全局 patch LatentPreviewer 子类，
        避免影响同进程内其它并发采样；
      · preview_frames=1：独立节点调用时保持单帧 JPEG 的历史行为。

    lite_animation=True 是导演台内置唯一使用的路线（20261108 17:24 定案）：
      · 用源节点那套 MiniMax-H3-TAE.safetensors 真解码，576x320 真 RGB；
      · 缺省解全部时间格（preview_frames=0），72 帧约 314ms / 步；
      · segment_seconds 给本段成片真实秒数，帧延时 = 段秒数 / 帧数，
        回放速度与成片严格 1:1（17:10 的固定 8fps 会快放 8 倍，已撤回）；
      · 强制 animated WebP，不建 NVENC 会话、不发 MP4；
      · L2RGB 只在 tiny VAE 不可用时作兜底。
    参数追加在末尾，独立节点 / 旧工作流不传时行为逐字不变。
    node_id 必填（前端按它判空），导演台传自己的 unique_id。
    """
    tiny_vae = None
    if vae_name:
        try:
            tiny_vae = _load_tiny_vae(vae_name)
        except Exception as exc:
            logging.warning(
                "[MiniMax H3 PreviewOverride] tiny VAE unavailable: %s "
                "— falling back to Latent2RGB previews.", exc)
    patched = model.clone()
    patched.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
        "minimax_h3_preview_override",
        _H3PreviewOverrideWrapper(
            max_resolution, str(node_id), jpeg_quality, suppress_default_preview,
            preview_frames, preview_fps, tiny_vae, lite_animation, segment_seconds,
        ),
    )
    return patched


# 班长全家桶集成：通过 NODE_CLASS_MAPPINGS 注册 V3 节点（ComfyUI 对 io.ComfyNode
# 子类在注册/执行/object_info 全链路均有 V3 分支支持，无需 comfy_entrypoint）。
NODE_CLASS_MAPPINGS = {
    "MiniMaxH3PreviewOverride": MiniMaxH3PreviewOverride,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3PreviewOverride": "班长 MiniMax H3 预览覆盖",
}
