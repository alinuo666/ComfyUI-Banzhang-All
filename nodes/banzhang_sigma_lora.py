# -*- coding: utf-8 -*-
"""按采样进度自动调整 LoRA 强度。

ComfyUI 原生在权重加载时就把 LoRA 增量烤进权重，运行时没有强度字段；
要按步调强度，只能在模块 forward 上按当前 sigma 注入低秩贡献。
调度由 wrapper 直接读采样器实际用的 sigmas，无需手填步数或每步数字。
"""
import os
import torch
import folder_paths
from safetensors.torch import load_file
from comfy.patcher_extension import WrappersMP

_KEY = "banzhang_sigma_lora"
_KEY_OUTER = "banzhang_sigma_lora_outer"
_LORA_CACHE = {}
_HOOKS = []
# 末步仍保留三成：后期贡献衰减很快，但全关会丢细节（社区在 H3 turbo 上实测）
_FLOOR = 0.3


def _pairs_from_file(path):
    """把 LoRA 拆成 {层名: (A, B, 固有缩放)}，两种常见命名都认。"""
    sd = load_file(path)
    out = {}
    for k, a in sd.items():
        if k.endswith(".lora_A.weight"):
            pre = k[:-len(".lora_A.weight")]
            b = sd.get(pre + ".lora_B.weight")
        elif k.endswith(".lora_down.weight"):
            pre = k[:-len(".lora_down.weight")]
            b = sd.get(pre + ".lora_up.weight")
        else:
            continue
        if b is None:
            continue
        # 有 alpha 时按 ComfyUI 的 alpha/rank 还原；alpha 已烘焙进 B 的保持 1.0
        alpha = sd.get(pre + ".alpha")
        scale = float(alpha.reshape(-1)[0]) / a.shape[0] if alpha is not None else 1.0
        out[pre] = (a, b, scale)
    return out


def _load_pairs(name):
    path = folder_paths.get_full_path("loras", name)
    if path is None:
        raise ValueError("找不到 LoRA 文件：%s" % name)
    stamp = (path, os.path.getmtime(path))
    hit = _LORA_CACHE.get(name)
    if hit and hit[0] == stamp:
        return hit[1]
    pairs = _pairs_from_file(path)
    if not pairs:
        raise ValueError("不是 ComfyUI 的 lora_A/B 或 lora_down/up 格式：%s" % name)
    _LORA_CACHE[name] = (stamp, pairs)
    return pairs


class _State:
    """持有调度与当前强度；调度由 wrapper 自动填入，末端 0 不是模型调用。"""

    def __init__(self, base, schedule=None):
        self.base = float(base)
        self.current = float(base)
        self.sigmas = []
        self.step = -1
        if schedule:
            self.set_schedule(schedule)

    def set_schedule(self, vals):
        v = [float(x) for x in vals]
        if v and v[-1] == 0.0:
            v = v[:-1]
        if v:
            self.sigmas = v

    def strength_for(self, sigma):
        if not self.sigmas:
            return self.base
        n = len(self.sigmas)
        i = min(range(n), key=lambda j: abs(self.sigmas[j] - sigma))
        self.step = i
        f = 0.0 if n == 1 else i / (n - 1)
        return self.base * (1.0 - (1.0 - _FLOOR) * f)


def _hook(state, a, b, scale):
    def fn(module, inputs, output):
        if state.current == 0.0 or not torch.is_tensor(output) or not inputs:
            return None
        x = inputs[0]
        if not torch.is_tensor(x):
            return None
        with torch.no_grad():
            aa = a.to(device=x.device, dtype=x.dtype)
            bb = b.to(device=x.device, dtype=x.dtype)
            delta = (x @ aa.T) @ bb.T
            return output + (delta * scale * state.current).to(output.dtype)
    return fn


def _attach(pairs, dit, state):
    global _HOOKS
    # hook 挂在共享的模块对象上，重跑前必须先摘掉，否则会逐次累加
    for h in _HOOKS:
        h.remove()
    _HOOKS = []
    mods = {"diffusion_model." + n: m for n, m in dit.named_modules() if n}
    hit = 0
    for key, (a, b, scale) in pairs.items():
        m = mods.get(key)
        if m is None:
            continue
        _HOOKS.append(m.register_forward_hook(_hook(state, a, b, scale)))
        hit += 1
    if hit == 0:
        raise ValueError("LoRA 层名和模型对不上（匹配 0 处），已停止；请确认是 ComfyUI 格式 LoRA")
    return hit, len(pairs)


def _outer_wrapper(state):
    """采样开始时读采样器实际用的 sigmas，自动识别步数。"""

    def fn(executor, *args, **kwargs):
        # args = (noise, latent_image, sampler, sigmas, denoise_mask, ...)
        if len(args) >= 4 and torch.is_tensor(args[3]):
            vals = [float(x) for x in args[3].flatten().tolist()]
            if vals and vals[-1] == 0.0:
                vals = vals[:-1]
            if vals:
                state.set_schedule(vals)
                print("[班长按步LoRA] 自动识别 %d 步 | 强度 %.2f → %.2f"
                      % (len(vals), state.base, state.base * _FLOOR))
        return executor(*args, **kwargs)
    return fn


def _apply_wrapper(state):
    """每次模型调用按当前 sigma 在调度中的位置算强度。"""

    def fn(executor, *args, **kwargs):
        # apply_model 的调用序列是 (x, t, ...)，t 即当前 sigma
        if len(args) >= 2:
            t = args[1]
            try:
                sigma = float(t.reshape(-1)[0]) if torch.is_tensor(t) else float(t)
                state.current = state.strength_for(sigma)
                if state.step >= 0 and state.sigmas:
                    print("[班长按步LoRA] 第%d/%d步 sigma=%.6f → 强度 %.3f（自动）"
                          % (state.step + 1, len(state.sigmas), sigma, state.current))
            except Exception:
                state.current = state.base
        return executor(*args, **kwargs)
    return fn


class BanZhang_SigmaLora:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": "接上游 MODEL；本节点只挂补丁，不改权重文件。"}),
                "LoRA文件": (folder_paths.get_filename_list("loras"), {
                    "tooltip": "选要按步调强度的 LoRA。支持 ComfyUI 的 lora_A/B 与 lora_down/up 两种格式。"}),
                "基础强度": ("FLOAT", {
                    "default": 1.0, "min": -2.0, "max": 2.0, "step": 0.05,
                    "tooltip": "整体强度。每步强度由节点自动按调度计算，无需手填。"}),
            },
            "optional": {
                "调度": ("SIGMAS", {
                    "tooltip": "可选。不接时自动读采样器正在用的 SIGMAS；接了则以它为准。"}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = "自动识别采样步数，按进度递减 LoRA 强度，把多步轨迹的 LoRA 适配到少步采样。"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def apply(self, 模型, LoRA文件, 基础强度=1.0, 调度=None):
        pairs = _load_pairs(LoRA文件)
        sig = []
        if 调度 is not None:
            sig = [float(x) for x in 调度.flatten().tolist()]
            if sig and sig[-1] == 0.0:
                sig = sig[:-1]
        state = _State(基础强度, sig)
        inner = getattr(模型, "model", None)
        dit = getattr(inner, "diffusion_model", None)
        if dit is None:
            raise ValueError("拿不到扩散主干，本节点只支持 ComfyUI 的 MODEL 输入")

        hit, total = _attach(pairs, dit, state)
        patched = 模型.clone()
        patched.add_wrapper_with_key(WrappersMP.OUTER_SAMPLE, _KEY_OUTER, _outer_wrapper(state))
        patched.add_wrapper_with_key(WrappersMP.APPLY_MODEL, _KEY, _apply_wrapper(state))
        patched.model_options[_KEY] = state
        print("[班长按步LoRA] %s | 匹配 %d/%d 层 | 基础强度 %.2f | 预置 %d 步"
              % (LoRA文件, hit, total, 基础强度, len(state.sigmas)))
        return (patched,)


NODE_CLASS_MAPPINGS = {"BanZhang_SigmaLora": BanZhang_SigmaLora}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_SigmaLora": "🎚️ 按步 LoRA 强度"}
