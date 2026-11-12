"""
🎬 剧本全流程·本地生图引擎

把本地 ComfyUI 模型（MODEL/CLIP/VAE）封装成与云 API 等价的生图引擎，
供「🎬 班长-剧本全流程生图」节点调用：

- 🎬 本地文生图器：资产阶段（文生图）
- 🎬 本地参考图生图器：核心帧阶段（参考图网格拼图/仅首张 → 图生图）

引擎只持模型引用与采样配置，模型本身走 ComfyUI 全局缓存，不在此重复加载。
"""
import math
import numpy as np
import torch
from PIL import Image

# 连线类型（英文蛇形，跨模块匹配用；显示名走 RETURN_NAMES 中文）
ASSET_ENGINE_TYPE = "BZ_LOCAL_ASSET_ENGINE"
FRAME_ENGINE_TYPE = "BZ_LOCAL_FRAME_ENGINE"

try:
    from comfy.samplers import SAMPLER_NAMES as SAMPLERS
except Exception:
    from comfy.samplers import KSampler
    SAMPLERS = KSampler.SAMPLERS
try:
    from comfy.samplers import SCHEDULER_NAMES as SCHEDULERS
except Exception:
    from comfy.samplers import KSampler
    SCHEDULERS = KSampler.SCHEDULERS

DEFAULT_NEG = "低质量，模糊，畸变，变形，多余肢体，断指，水印，文字，logo，jpeg压缩痕迹"


# ── 图像工具（tensor[1,H,W,3] 与 PIL 互转） ──────────────────
def _tensor_to_pil(t):
    arr = (t[0].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr).convert("RGB")


def _pil_to_tensor(im):
    arr = np.array(im, dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None, ]


def _mosaic(pils, w, h):
    """多张图按网格拼图并铺满目标尺寸（每张资产占一个格子）。"""
    n = len(pils)
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    cw, ch = max(1, w // cols), max(1, h // rows)
    canvas = Image.new("RGB", (w, h), (0, 0, 0))
    for i, im in enumerate(pils):
        r, c = divmod(i, cols)
        canvas.paste(im.resize((cw, ch), Image.LANCZOS), (c * cw, r * ch))
    return canvas


class _BaseEngine:
    """与云 API 节点同构的生图接口：提示词进、IMAGE tensor 出。"""

    def __init__(self, model, clip, vae, negative, width, height,
                 steps, cfg, sampler_name, scheduler, seed_start, seed_control):
        self.model = model
        self.clip = clip
        self.vae = vae
        self.negative = negative or ""
        self.width = int(width)
        self.height = int(height)
        self.steps = int(steps)
        self.cfg = float(cfg)
        self.sampler_name = sampler_name
        self.scheduler = scheduler
        self.seed = int(seed_start)
        self.fixed = seed_control == "fixed"
        # 核心节点类实例（无状态，可跨条目复用）
        import nodes as _nodes
        self._n_latent = _nodes.NODE_CLASS_MAPPINGS["EmptyLatentImage"]()
        self._n_text = _nodes.NODE_CLASS_MAPPINGS["CLIPTextEncode"]()
        self._n_sample = _nodes.NODE_CLASS_MAPPINGS["KSampler"]()
        self._n_decode = _nodes.NODE_CLASS_MAPPINGS["VAEDecode"]()
        self._n_encode = _nodes.NODE_CLASS_MAPPINGS["VAEEncode"]()

    def advance_to(self, seed):
        """断点续跑时把种子推进到已用最大值之后，避免续跑重复旧种子。"""
        if not self.fixed:
            self.seed = max(self.seed, int(seed) + 1)

    def _next_seed(self):
        used = self.seed
        if not self.fixed:
            self.seed += 1
        return used

    def _sample(self, prompt, latent_image, denoise):
        used = self._next_seed()
        with torch.no_grad():
            positive = self._n_text.encode(self.clip, prompt)[0]
            negative = self._n_text.encode(self.clip, self.negative)[0]
            latent = self._n_sample.sample(
                self.model, used, self.steps, self.cfg,
                self.sampler_name, self.scheduler, positive, negative,
                latent_image, denoise=denoise)[0]
            image = self._n_decode.decode(self.vae, latent)[0]
        return image, used

    def _txt2img(self, prompt):
        latent = self._n_latent.generate(self.width, self.height)[0]
        return self._sample(prompt, latent, 1.0)


class LocalAssetEngine(_BaseEngine):
    """资产阶段：纯文生图。"""

    def generate(self, prompt):
        return self._txt2img(prompt)


class LocalFrameEngine(_BaseEngine):
    """核心帧阶段：参考图拼图后图生图；无参考资产时退化为文生图。"""

    def __init__(self, model, clip, vae, negative, width, height,
                 steps, cfg, sampler_name, scheduler, seed_start, seed_control,
                 ref_mode="grid", denoise=0.6):
        super().__init__(model, clip, vae, negative, width, height,
                         steps, cfg, sampler_name, scheduler,
                         seed_start, seed_control)
        self.ref_mode = ref_mode
        self.denoise = float(denoise)

    def generate(self, prompt, refs=None):
        refs = refs or []
        if not refs:
            return self._txt2img(prompt)
        pils = [_tensor_to_pil(t) for t in refs]
        if self.ref_mode == "仅第一张":
            base = pils[0].resize((self.width, self.height), Image.LANCZOS)
        else:
            base = _mosaic(pils, self.width, self.height)
        with torch.no_grad():
            latent = self._n_encode.encode(self.vae, _pil_to_tensor(base))[0]
        return self._sample(prompt, latent, self.denoise)


# ── 节点定义（只做装配：连线参数 → 引擎对象） ──────────────────
_COMMON_REQUIRED = {
    "model": ("MODEL",),
    "clip": ("CLIP",),
    "vae": ("VAE",),
    "负面提示词": ("STRING", {"default": DEFAULT_NEG, "multiline": True}),
    "↔️ 宽": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
    "↕️ 高": ("INT", {"default": 1536, "min": 64, "max": 8192, "step": 8}),
    "采样步数": ("INT", {"default": 25, "min": 1, "max": 100}),
    "CFG": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 30.0, "step": 0.5}),
    "采样器": (SAMPLERS, {"default": "euler"}),
    "调度器": (SCHEDULERS, {"default": "normal"}),
    "🎲 起始种子": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
    "🎲 种子控制": (["increment", "fixed"], {"default": "increment"}),
}


class BanZhang_LocalAssetEngineNode:
    """🎬 本地文生图器：连 MODEL/CLIP/VAE，输出资产引擎给剧本节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": dict(_COMMON_REQUIRED)}

    RETURN_TYPES = (ASSET_ENGINE_TYPE,)
    RETURN_NAMES = ("🔌 本地资产引擎",)
    FUNCTION = "build"
    CATEGORY = "👨‍🏫班长/剧本资产"

    def build(self, model, clip, vae, **p):
        eng = LocalAssetEngine(
            model, clip, vae, p["负面提示词"], p["↔️ 宽"], p["↕️ 高"],
            p["采样步数"], p["CFG"], p["采样器"], p["调度器"],
            p["🎲 起始种子"], p["🎲 种子控制"])
        return (eng,)


class BanZhang_LocalFrameEngineNode:
    """🎬 本地参考图生图器：核心帧把资产图拼图喂给本引擎图生图。"""

    @classmethod
    def INPUT_TYPES(cls):
        req = dict(_COMMON_REQUIRED)
        req["参考图模式"] = (["🧩 网格拼图", "1️⃣ 仅第一张"],
                           {"default": "🧩 网格拼图"})
        req["重绘强度"] = ("FLOAT", {"default": 0.6, "min": 0.05,
                                    "max": 1.0, "step": 0.05})
        return {"required": req}

    RETURN_TYPES = (FRAME_ENGINE_TYPE,)
    RETURN_NAMES = ("🔌 本地核心帧引擎",)
    FUNCTION = "build"
    CATEGORY = "👨‍🏫班长/剧本资产"

    def build(self, model, clip, vae, **p):
        ref_mode = "仅第一张" if "第一张" in p["参考图模式"] else "grid"
        eng = LocalFrameEngine(
            model, clip, vae, p["负面提示词"], p["↔️ 宽"], p["↕️ 高"],
            p["采样步数"], p["CFG"], p["采样器"], p["调度器"],
            p["🎲 起始种子"], p["🎲 种子控制"],
            ref_mode=ref_mode, denoise=p["重绘强度"])
        return (eng,)


NODE_CLASS_MAPPINGS = {
    "BanZhang_LocalAssetEngine": BanZhang_LocalAssetEngineNode,
    "BanZhang_LocalFrameEngine": BanZhang_LocalFrameEngineNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_LocalAssetEngine": "🎬 本地文生图器",
    "BanZhang_LocalFrameEngine": "🎬 本地参考图生图器",
}
