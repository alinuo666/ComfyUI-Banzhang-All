"""ComfyUI nodes for Apple Depth Pro 2 metric monocular depth."""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path

import torch
from torch.nn import functional as F
from safetensors.torch import load_file

import folder_paths
import comfy.model_management as mm
from comfy.utils import ProgressBar

from .depth_pro_2 import PRESETS, DepthPro2
from .depth_pro_2.model import to_normalized_tensor
from .colormaps import COLORMAPS, color_scale, colorize, inverse_metric
from .fp8 import QuantizedLinear, quantize_linears

LOGGER = logging.getLogger(__name__)

MODELS_DIR = Path(folder_paths.models_dir) / "depthpro2"
folder_paths.add_model_folder_path("depthpro2", str(MODELS_DIR))

HF_REPOS = {
    "depthpro2-s": "apple/DepthPro2-S",
    "depthpro2-b": "apple/DepthPro2-B",
    "depthpro2-l": "apple/DepthPro2-L",
    "depthpro2-h": "apple/DepthPro2-H",
}
FOCAL_REPO = "apple/DepthPro2-focal"

DTYPES = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}

# (embed_dim, num_blocks) -> preset, for local weight files without a config.json.
ARCH_BY_SHAPE = {
    (384, 12): "depthpro2-s",
    (768, 12): "depthpro2-b",
    (1024, 24): "depthpro2-l",
    (1280, 32): "depthpro2-h",
}


def _download_repo(repo_id: str, name: str) -> Path:
    from huggingface_hub import snapshot_download

    local = MODELS_DIR / name
    if not (local / "model.safetensors").exists():
        LOGGER.info("Downloading %s to %s", repo_id, local)
        snapshot_download(
            repo_id=repo_id,
            allow_patterns=["config.json", "model.safetensors", "LICENSE"],
            local_dir=str(local),
        )
    return local


def _local_weight_files() -> list[str]:
    if not MODELS_DIR.exists():
        return []
    files = []
    for path in sorted(MODELS_DIR.rglob("*")):
        if path.suffix in (".safetensors", ".pt") and path.is_file():
            files.append(str(path.relative_to(MODELS_DIR)))
    return files


def _load_state_dict(path: Path) -> dict[str, torch.Tensor]:
    if path.suffix == ".safetensors":
        return load_file(str(path))
    return torch.load(path, map_location="cpu", weights_only=True)


def _detect_preset(state_dict: dict[str, torch.Tensor]) -> str:
    embed_dim = state_dict["encoder.cls_token"].shape[-1]
    num_blocks = (
        max(
            int(key.split(".")[2])
            for key in state_dict
            if key.startswith("encoder.blocks.")
        )
        + 1
    )
    preset = ARCH_BY_SHAPE.get((embed_dim, num_blocks))
    if preset is None:
        raise ValueError(
            f"Cannot detect DepthPro2 size from weights (embed_dim={embed_dim}, "
            f"blocks={num_blocks}). Place a config.json next to the weight file."
        )
    return preset


def _resolve_weights(name: str) -> tuple[dict, dict[str, torch.Tensor], Path | None]:
    """Return (config kwargs, state dict, focal weights path or None) for a model choice."""
    if name in HF_REPOS:
        local = _download_repo(HF_REPOS[name], name)
        config = json.loads((local / "config.json").read_text())
        state_dict = _load_state_dict(local / "model.safetensors")
    else:
        path = MODELS_DIR / name
        if not path.exists():
            raise FileNotFoundError(f"Weight file not found: {path}")
        state_dict = _load_state_dict(path)
        config_path = path.with_name("config.json")
        if config_path.exists():
            config = json.loads(config_path.read_text())
        else:
            config = vars(PRESETS[_detect_preset(state_dict)]).copy()
            config = {
                key: config[key]
                for key in (
                    "backbone_preset",
                    "reassembled_blocks",
                    "cross_frame_blocks",
                    "dims_reassemble",
                    "dim_decoder",
                )
            }
    has_fov = any(key.startswith("fov.") for key in state_dict)
    focal_path = None if has_fov else _download_repo(FOCAL_REPO, "depthpro2-focal") / "model.safetensors"
    return config, state_dict, focal_path


def _cast_storage(model: torch.nn.Module, dtype: torch.dtype) -> None:
    """Cast floating params/buffers to ``dtype``, leaving fp8-quantized modules untouched."""
    for module in model.modules():
        if isinstance(module, QuantizedLinear):
            continue
        for name, param in module.named_parameters(recurse=False):
            param.data = param.data.to(dtype)
        for name, buf in module.named_buffers(recurse=False):
            if buf is not None and buf.is_floating_point():
                module._buffers[name] = buf.to(dtype)


def load_depthpro2(name: str, precision: str, device: str) -> dict:
    if device == "auto":
        torch_device = mm.get_torch_device()
    else:
        torch_device = torch.device(device)
    if precision == "auto":
        precision = "fp32" if torch_device.type == "cpu" else "bf16"

    config, state_dict, focal_path = _resolve_weights(name)
    compute_dtype = DTYPES["bf16" if precision == "fp8" else precision]
    if precision == "fp8" and torch_device.type == "cpu":
        compute_dtype = torch.float32

    model = DepthPro2(
        **{key: value for key, value in config.items() if key != "fov"},
        fov=focal_path is not None or any(k.startswith("fov.") for k in state_dict),
        precision=compute_dtype,
    )
    if focal_path is not None:
        state_dict.update({f"fov.{k}": v for k, v in _load_state_dict(focal_path).items()})
    model.load_state_dict(state_dict, strict=True)
    del state_dict

    if precision == "fp8":
        count = quantize_linears(model.encoder, compute_dtype)
        LOGGER.info("DepthPro2: quantized %d linear layers to fp8.", count)
    if compute_dtype != torch.float32:
        # Store the autocast-covered parts in low precision; the heads run in float32.
        _cast_storage(model.encoder, compute_dtype)
        _cast_storage(model.decoder, compute_dtype)
        if model.fov is not None:
            _cast_storage(model.fov.trunk, compute_dtype)

    model.to(torch_device).eval()
    return {"model": model, "device": torch_device, "name": name, "precision": precision}


def _focal_mm_to_px(focal_mm: float, height: int, width: int) -> float:
    """35mm-equivalent focal length -> pixels of the input image (35mm frame: 36x24mm)."""
    if focal_mm <= 0:
        return 0.0
    return focal_mm * math.hypot(width, height) / math.hypot(36.0, 24.0)


# Sensor width is what matters for focal conversion; heights are listed for recognition.
SENSOR_PRESETS = {
    "Full frame 36x24 (Sony Venice, Canon R5)": (36.0, 24.0),
    "ARRI ALEXA 35 (27.99x19.22)": (27.99, 19.22),
    "ARRI ALEXA Mini LF (36.70x25.54)": (36.70, 25.54),
    "ARRI ALEXA Mini / AMIRA (28.25x18.17)": (28.25, 18.17),
    "Blackmagic URSA 12K (27.03x14.25)": (27.03, 14.25),
    "Blackmagic Pocket 6K (23.10x12.99)": (23.10, 12.99),
    "Super 35 3-perf (24.89x18.66)": (24.89, 18.66),
    "APS-C Sony/Fujifilm (23.5x15.6)": (23.5, 15.6),
    "APS-C Canon (22.3x14.9)": (22.3, 14.9),
    "Micro Four Thirds (17.3x13)": (17.3, 13.0),
    "1-inch (13.2x8.8)": (13.2, 8.8),
    "custom": None,
}


class DepthPro2FocalLength:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "focal_length_mm": ("FLOAT", {"default": 35.0, "min": 0.0, "step": 0.5}),
                "sensor": (list(SENSOR_PRESETS), {"default": next(iter(SENSOR_PRESETS))}),
                "sensor_width_mm": ("FLOAT", {"default": 36.0, "min": 0.1, "max": 100.0, "step": 0.01}),
                "width": ("INT", {"default": 1920, "min": 1, "max": 16384}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("focal_length_px",)
    FUNCTION = "convert"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Convert a physical lens focal length (mm, as engraved on the lens) to pixels for a "
        "known sensor size, for cine/mirrorless cameras (ARRI, Blackmagic, Sony...). Link the "
        "image to use its width, or set width manually. Pick a sensor preset or 'custom' "
        "with sensor_width_mm; the conversion assumes the image spans the full sensor width "
        "(for cropped readouts, use the width of the sensor area actually used). Link the "
        "output to the focal_length_px input of the Estimate/Video nodes. For phone photos "
        "and unknown cameras, use the focal_length_mm (35mm-equivalent) widget instead."
    )

    def convert(
        self,
        focal_length_mm: float,
        sensor: str,
        sensor_width_mm: float,
        width: int,
        image: torch.Tensor | None = None,
    ):
        if image is not None:
            width = image.shape[2]
        preset = SENSOR_PRESETS[sensor]
        sensor_w = preset[0] if preset is not None else sensor_width_mm
        if focal_length_mm <= 0:
            return (0.0,)
        return (focal_length_mm * width / sensor_w,)


def _prepare_frames(
    images: torch.Tensor, device: torch.device, max_size: int, f_px: float
) -> tuple[list[torch.Tensor], float | None, float]:
    """ComfyUI IMAGE batch (T, H, W, 3) float 0..1 -> normalized frame tensors and focal."""
    height, width = images.shape[1:3]
    scale = 1.0
    if max_size > 0 and max(height, width) > max_size:
        scale = max_size / max(height, width)
        new_h = max(32, round(height * scale))
        new_w = max(32, round(width * scale))
        images = F.interpolate(
            images.permute(0, 3, 1, 2), size=(new_h, new_w), mode="bilinear", antialias=True
        ).permute(0, 2, 3, 1)
    frames = [
        to_normalized_tensor((frame.clamp(0, 1) * 255).round().to(torch.uint8).numpy(), device)
        for frame in images
    ]
    focal = None if f_px <= 0 else f_px * scale
    return frames, focal, scale


def _normalize_inverse_depth(inverse_depth: torch.Tensor) -> torch.Tensor:
    """Per-frame min-max to 0..1, near white; sky (inverse depth 0) stays black."""
    finite = torch.isfinite(inverse_depth)
    out = torch.zeros_like(inverse_depth)
    for i in range(inverse_depth.shape[0]):
        values = inverse_depth[i][finite[i]]
        if values.numel() == 0:
            continue
        lo, hi = values.min(), values.max()
        if hi > lo:
            out[i] = (inverse_depth[i] - lo) / (hi - lo)
    return out.clamp(0, 1)


def _depth_outputs(
    predictions: list[dict], original_size: tuple[int, int], scale: float
) -> tuple[torch.Tensor, torch.Tensor, float, torch.Tensor]:
    inverse = torch.stack([p["inverse_depth"].float().cpu() for p in predictions])
    depth = torch.stack(
        [
            p["depth"].float().cpu()
            if p["depth"] is not None
            else torch.full_like(p["inverse_depth"], float("nan"))
            for p in predictions
        ]
    )
    if inverse.shape[-2:] != original_size:
        inverse = F.interpolate(inverse[:, None], size=original_size, mode="bilinear")[:, 0]
        depth = F.interpolate(depth[:, None], size=original_size, mode="bilinear")[:, 0]
    image = _normalize_inverse_depth(inverse).unsqueeze(-1).repeat(1, 1, 1, 3)
    focal = 0.0
    if predictions[0]["focallength_px"] is not None:
        # Report in pixels of the original input, undoing any max_size downscale.
        focal = float(predictions[0]["focallength_px"]) / scale
    sky = (~torch.isfinite(depth)).to(torch.float32)
    return image, depth, focal, sky


class DepthPro2Loader:
    @classmethod
    def INPUT_TYPES(cls):
        choices = list(HF_REPOS) + _local_weight_files()
        return {
            "required": {
                "model": (choices, {"default": "depthpro2-s"}),
                "precision": (["auto", "bf16", "fp16", "fp32", "fp8"], {"default": "auto"}),
                "device": (["auto", "cuda", "mps", "cpu"], {"default": "auto"}),
            }
        }

    RETURN_TYPES = ("DEPTHPRO2_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Load Apple Depth Pro 2. Preset names download weights from Hugging Face into "
        "models/depthpro2 on first use; local .safetensors/.pt files in that folder are also "
        "listed. fp8 stores encoder weights as float8 with per-channel scales (about half the "
        "memory of bf16); the focal-length estimator stays in high precision."
    )

    def load(self, model: str, precision: str, device: str):
        return (load_depthpro2(model, precision, device),)


class DepthPro2Estimate:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("DEPTHPRO2_MODEL",),
                "image": ("IMAGE",),
                "focal_length_mm": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.5}),
                "max_size": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 32}),
            },
            "optional": {"focal_length_px": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1})},
        }

    RETURN_TYPES = ("IMAGE", "DEPTHPRO2_DEPTH", "FLOAT", "MASK")
    RETURN_NAMES = ("depth_image", "depth_meters", "focal_length_px", "sky")
    FUNCTION = "estimate"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Estimate metric depth for each image of the batch independently. depth_image is "
        "normalized inverse depth (near white, far black) for preview/ControlNet; depth_meters "
        "is raw metric depth (T, H, W) with inf at sky; sky is a MASK (1 at sky) for comp "
        "holdouts. focal_length_mm is the lens focal length "
        "as a 35mm-equivalent (e.g. 24, 35, 50 — the EXIF FocalLengthIn35mmFilm value); 0 "
        "estimates it with the focal-length model. Depth in meters scales linearly with focal "
        "length. max_size caps the longest side processed (0 = native resolution, sharpest edges). "
        "For physical mm with a known camera sensor, link the Focal Length node's focal_length_px "
        "output to the optional focal_length_px input; it overrides focal_length_mm."
    )

    def estimate(
        self,
        model: dict,
        image: torch.Tensor,
        focal_length_mm: float,
        max_size: int,
        focal_length_px: float | None = None,
    ):
        net, device = model["model"], model["device"]
        f_px = focal_length_px or _focal_mm_to_px(focal_length_mm, *image.shape[1:3])
        frames, focal, scale = _prepare_frames(image, device, max_size, f_px)
        progress = ProgressBar(len(frames))
        predictions = []
        for frame in frames:
            predictions.append(net.infer(frame, f_px=focal))
            progress.update(1)
        mm.soft_empty_cache()
        return _depth_outputs(predictions, tuple(image.shape[1:3]), scale)


class DepthPro2Video:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("DEPTHPRO2_MODEL",),
                "images": ("IMAGE",),
                "window": ("INT", {"default": 16, "min": 1, "max": 64}),
                "overlap": ("INT", {"default": 4, "min": 0, "max": 63}),
                "focal_length_mm": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.5}),
                "max_size": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 32}),
                "mode": (["buffered", "unbuffered"], {"default": "buffered"}),
            },
            "optional": {"focal_length_px": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1})},
        }

    RETURN_TYPES = ("IMAGE", "DEPTHPRO2_DEPTH", "FLOAT", "MASK")
    RETURN_NAMES = ("depth_image", "depth_meters", "focal_length_px", "sky")
    FUNCTION = "estimate"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Temporally consistent depth for a video batch: frames are processed jointly in "
        "overlapping windows and share one focal length. focal_length_mm is the 35mm-equivalent "
        "focal length (0 estimates it from the first window). Lower window/overlap if you run out "
        "of memory. depth_image is normalized over the whole batch so brightness is steady "
        "across frames. buffered lets each frame also see later frames (overlap applies); "
        "unbuffered predicts each frame from itself and the frames before it, at lower latency "
        "and memory (overlap is ignored). Link the Focal Length node's focal_length_px output "
        "to the optional focal_length_px input to override focal_length_mm with a sensor-aware "
        "physical focal length."
    )

    def estimate(
        self,
        model: dict,
        images: torch.Tensor,
        window: int,
        overlap: int,
        focal_length_mm: float,
        max_size: int,
        mode: str = "buffered",
        focal_length_px: float | None = None,
    ):
        if mode == "buffered" and overlap >= window:
            raise ValueError("overlap must be smaller than window.")
        net, device = model["model"], model["device"]
        f_px = focal_length_px or _focal_mm_to_px(focal_length_mm, *images.shape[1:3])
        frames, focal, scale = _prepare_frames(images, device, max_size, f_px)
        progress = ProgressBar(len(frames))
        predictions = []
        for prediction in net.infer_video(
            iter(frames), window=window, overlap=overlap, f_px=focal, mode=mode
        ):
            predictions.append(prediction)
            progress.update(1)
        mm.soft_empty_cache()
        image, depth, focal_out, sky = _depth_outputs(predictions, tuple(images.shape[1:3]), scale)
        # One shared range keeps the visualization temporally steady.
        finite = torch.isfinite(depth) & (depth > 0)
        if finite.any():
            inverse = 1.0 / depth.clamp(min=1e-6)
            inverse[~finite] = 0.0
            lo = inverse[finite].min()
            hi = inverse[finite].max()
            if hi > lo:
                image = ((inverse - lo) / (hi - lo)).clamp(0, 1).unsqueeze(-1).repeat(1, 1, 1, 3)
        return image, depth, focal_out, sky


class DepthPro2Colorize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("DEPTHPRO2_DEPTH",),
                "colormap": (list(COLORMAPS), {"default": "turbo"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("depth_color",)
    FUNCTION = "colorize"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Color preview of metric depth, as in Apple's CLI: turbo maps dark blue at infinitely "
        "far to red/white near. The scale is fixed by the first frame's nearest point plus 20% "
        "headroom, so a video stays steady and points coming nearer later saturate. gray uses "
        "the same scale in grayscale (white near, black infinitely far)."
    )

    def colorize(self, depth: torch.Tensor, colormap: str):
        inverse = inverse_metric(depth)
        return (colorize(inverse, colormap, color_scale(inverse)),)


class DepthPro2PositionPass:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("DEPTHPRO2_DEPTH",),
                "focal_length_px": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1}),
                "max_depth": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.5}),
                "cx_offset": ("FLOAT", {"default": 0.0, "min": -4096.0, "max": 4096.0, "step": 0.5}),
                "cy_offset": ("FLOAT", {"default": 0.0, "min": -4096.0, "max": 4096.0, "step": 0.5}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("position_xyz", "valid")
    FUNCTION = "position"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Camera-space position pass in meters: X right, Y down, Z along the viewing direction, "
        "back-projected from metric depth with focal_length_px (link it from the estimate node) "
        "and the image center as principal point, shifted by cx_offset/cy_offset for calibrated "
        "cameras. Sky and pixels beyond max_depth (0 = no clip) are zero with valid = 0; clip "
        "before making point clouds, as sky depth is unreliable."
    )

    def position(
        self,
        depth: torch.Tensor,
        focal_length_px: float,
        max_depth: float,
        cx_offset: float,
        cy_offset: float,
    ):
        if focal_length_px <= 0:
            raise ValueError("focal_length_px must be positive; link it from the estimate node.")
        height, width = depth.shape[-2:]
        valid = torch.isfinite(depth) & (depth > 0)
        if max_depth > 0:
            valid = valid & (depth <= max_depth)
        z = torch.where(valid, depth, torch.zeros_like(depth))
        u = torch.arange(width, dtype=torch.float32) + 0.5 - (width / 2 + cx_offset)
        v = torch.arange(height, dtype=torch.float32) + 0.5 - (height / 2 + cy_offset)
        x = z * u.view(1, 1, width) / focal_length_px
        y = z * v.view(1, height, 1) / focal_length_px
        return (torch.stack([x, y, z], dim=-1), valid.to(torch.float32))


class DepthPro2Save16:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("DEPTHPRO2_DEPTH",),
                "filename_prefix": ("STRING", {"default": "depthpro2/depth16"}),
            }
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "save"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Save inverse metric depth as 16-bit grayscale PNGs (white near, black infinitely far) "
        "on the color preview's scale, for compositing tools: read as raw data (Raw in Nuke, "
        "Non-Color in Blender). Depth in meters = k / value; k is logged and stored in each "
        "PNG's depthpro2_k text chunk. 0 is infinitely far. Shows an 8-bit preview on the node."
    )

    def save(self, depth: torch.Tensor, filename_prefix: str):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        inverse = inverse_metric(depth)
        scale = color_scale(inverse)
        k = 65535.0 / scale
        height, width = depth.shape[-2:]
        folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), width, height
        )
        temp_dir = Path(folder_paths.get_temp_directory())
        previews = []
        for frame in inverse:
            normalized = (frame / scale).clamp(0, 1)
            values = normalized.mul(65535).round().to(torch.uint16).numpy()
            meta = PngInfo()
            meta.add_text("depthpro2_k", f"{k:.6g}")
            path = Path(folder) / f"{filename}_{counter:05d}.png"
            Image.fromarray(values).save(path, pnginfo=meta, compress_level=1)
            preview_name = f"{filename}_{counter:05d}_preview.png"
            preview = normalized.mul(255).round().to(torch.uint8).numpy()
            Image.fromarray(preview).save(temp_dir / preview_name, compress_level=1)
            previews.append({"filename": preview_name, "subfolder": "", "type": "temp"})
            counter += 1
        LOGGER.info("DepthPro2 16-bit: depth in meters = %.2f / value, 0 is infinitely far.", k)
        return {"ui": {"images": previews}}


class DepthPro2SaveFloat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("DEPTHPRO2_DEPTH",),
                "filename_prefix": ("STRING", {"default": "depthpro2/depth_float"}),
                "format": (["exr", "tiff"], {"default": "exr"}),
                "sky_value": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 100.0}),
            },
            "optional": {"focal_length_px": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1})},
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "save"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Save metric depth in meters as 32-bit float for compositing (Nuke, Fusion, Blender): "
        "single-channel EXR (channel Z, needs the optional OpenEXR package: pip install OpenEXR) "
        "or float32 TIFF with no extra dependencies. Unlike the 16-bit node this is lossless and "
        "stores true meters, not an inverse scale. sky_value replaces sky/invalid pixels with a "
        "far distance (0 keeps infinity). Link focal_length_px from the estimate node to embed "
        "it, with units and sky convention, in the file metadata. Shows an 8-bit preview."
    )

    def save(
        self,
        depth: torch.Tensor,
        filename_prefix: str,
        format: str,
        sky_value: float,
        focal_length_px: float | None = None,
    ):
        from PIL import Image

        meters = depth.float().cpu().clone()
        invalid = ~torch.isfinite(meters)
        if sky_value > 0:
            meters[invalid] = sky_value
        else:
            meters[torch.isnan(meters)] = float("inf")
        sky_desc = f"{sky_value:g} m" if sky_value > 0 else "inf"
        focal = float(focal_length_px) if focal_length_px else 0.0
        height, width = meters.shape[-2:]
        ext = ".exr" if format == "exr" else ".tif"
        folder, filename, _, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), width, height
        )
        # get_save_image_path counts PNGs only; count our own format to avoid overwrites.
        counter = len(list(Path(folder).glob(f"{filename}_*{ext}")))
        if format == "exr":
            try:
                import Imath
                import OpenEXR
            except ImportError as e:
                raise ImportError(
                    "EXR export needs the OpenEXR package (pip install OpenEXR), "
                    "or choose the tiff format."
                ) from e
        temp_dir = Path(folder_paths.get_temp_directory())
        inverse = inverse_metric(depth)
        scale = color_scale(inverse)
        previews = []
        for i, frame in enumerate(meters):
            path = Path(folder) / f"{filename}_{counter:05d}{ext}"
            if format == "exr":
                header = OpenEXR.Header(width, height)
                header["channels"] = {"Z": Imath.Channel(Imath.PixelType(Imath.PixelType.FLOAT))}
                header["depthpro2_units"] = b"meters"
                header["depthpro2_sky"] = sky_desc.encode()
                if focal > 0:
                    header["depthpro2_focal_px"] = f"{focal:.6g}".encode()
                out = OpenEXR.OutputFile(str(path), header)
                out.writePixels({"Z": frame.numpy().tobytes()})
                out.close()
            else:
                from PIL.TiffImagePlugin import ImageFileDirectory_v2

                info = ImageFileDirectory_v2()
                info[65000] = "meters"
                info[65001] = sky_desc
                if focal > 0:
                    info[65002] = f"{focal:.6g}"
                Image.fromarray(frame.numpy()).save(path, tiffinfo=info)
            preview_name = f"{filename}_{counter:05d}_float_preview.png"
            preview = (inverse[i] / scale).clamp(0, 1).mul(255).round().to(torch.uint8).numpy()
            Image.fromarray(preview).save(temp_dir / preview_name, compress_level=1)
            previews.append({"filename": preview_name, "subfolder": "", "type": "temp"})
            counter += 1
        LOGGER.info("DepthPro2 float depth: %s, meters, sky = %s.", path, sky_desc)
        return {"ui": {"images": previews}}


class DepthPro2SavePLY:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "position": ("IMAGE",),
                "valid": ("MASK",),
                "filename_prefix": ("STRING", {"default": "depthpro2/points"}),
            },
            "optional": {"image": ("IMAGE",)},
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "save"
    CATEGORY = "depth/DepthPro2"
    DESCRIPTION = (
        "Write a metric point cloud (binary PLY, in meters) from the Position Pass outputs: "
        "link position_xyz and valid; only valid points are written, sky and clipped pixels "
        "are dropped. Link the original image to color the points. Coordinates are camera-space "
        "(X right, Y down, Z forward) — flip Y in DCCs that expect Y up. Opens in MeshLab, "
        "Blender and CloudCompare."
    )

    def save(
        self,
        position: torch.Tensor,
        valid: torch.Tensor,
        filename_prefix: str,
        image: torch.Tensor | None = None,
    ):
        import numpy as np

        if position.ndim != 4 or position.shape[-1] != 3:
            raise ValueError("position must be the Position Pass position_xyz output (T, H, W, 3).")
        if image is not None and image.shape[1:3] != position.shape[1:3]:
            raise ValueError("image resolution must match the position pass resolution.")
        height, width = position.shape[1:3]
        folder, filename, _, _, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), width, height
        )
        counter = len(list(Path(folder).glob(f"{filename}_*.ply")))
        colored = image is not None
        props = "property float x\nproperty float y\nproperty float z\n"
        fields = [("x", "<f4"), ("y", "<f4"), ("z", "<f4")]
        if colored:
            props += "property uchar red\nproperty uchar green\nproperty uchar blue\n"
            fields += [("red", "u1"), ("green", "u1"), ("blue", "u1")]
        for i in range(position.shape[0]):
            mask = valid[i].bool()
            points = position[i][mask].numpy().astype("<f4")
            record = np.empty(len(points), dtype=np.dtype(fields))
            record["x"], record["y"], record["z"] = points.T
            if colored:
                rgb = (image[i][mask].clamp(0, 1) * 255).round().to(torch.uint8).numpy()
                record["red"], record["green"], record["blue"] = rgb.T
            header = (
                f"ply\nformat binary_little_endian 1.0\nelement vertex {len(points)}\n"
                f"{props}end_header\n"
            )
            path = Path(folder) / f"{filename}_{counter:05d}.ply"
            path.write_bytes(header.encode("ascii") + record.tobytes())
            LOGGER.info("DepthPro2 PLY: %s (%d points, meters).", path, len(points))
            counter += 1
        return ()


NODE_CLASS_MAPPINGS = {
    "DepthPro2Loader": DepthPro2Loader,
    "DepthPro2Estimate": DepthPro2Estimate,
    "DepthPro2Video": DepthPro2Video,
    "DepthPro2FocalLength": DepthPro2FocalLength,
    "DepthPro2Colorize": DepthPro2Colorize,
    "DepthPro2PositionPass": DepthPro2PositionPass,
    "DepthPro2Save16": DepthPro2Save16,
    "DepthPro2SaveFloat": DepthPro2SaveFloat,
    "DepthPro2SavePLY": DepthPro2SavePLY,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "DepthPro2Loader": "DepthPro2 Loader",
    "DepthPro2Estimate": "DepthPro2 Estimate Depth",
    "DepthPro2Video": "DepthPro2 Video Depth",
    "DepthPro2FocalLength": "DepthPro2 Focal Length",
    "DepthPro2Colorize": "DepthPro2 Colorize Depth",
    "DepthPro2PositionPass": "DepthPro2 Position Pass",
    "DepthPro2Save16": "DepthPro2 Save 16-bit Depth",
    "DepthPro2SaveFloat": "DepthPro2 Save Float Depth",
    "DepthPro2SavePLY": "DepthPro2 Save PLY Points",
}