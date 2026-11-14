# -*- coding: utf-8 -*-
"""
👨‍🏫 显存守护工具函数
被「🛡️⚡ 显存预留+快速中断」节点调用，不含任何节点。

提供三样东西：
  1. _check_interrupt / _safe_force_clear_vram
     ——中断检测与中断后的轻量显存回收。
  2. aimdo_enabled()
     ——Dynamic VRAM 当前是否真的开着（读 comfy 真实标志位）。
  3. get_vram_breakdown()
     ——显存分池读数。启用 DynamicVRAM 后权重被钉进 aimdo 的 ModelVBAR 池，
       那不是 PyTorch caching allocator 的块，NVML 读到的 used 是
      「torch 池 + aimdo 池 + 其他进程」混在一起的总数。分池报出来才能区分
     「真没释放」和「释放了但数字被驱动缓存吃掉」。
"""

import torch
from comfy.model_management import throw_exception_if_processing_interrupted


def _check_interrupt():
    """中断检测——调 ComfyUI 官方函数。"""
    throw_exception_if_processing_interrupted()


def _safe_force_clear_vram():
    """轻量显存清理：中断后 ComfyUI 自己也会回收，这里只做必要回收，
    不再 synchronize / ipc_collect（慢且中断场景几乎用不到）。"""
    if torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass


# ==========================================
# 🔍 显存读数：分池归因
# ==========================================
#  为什么要分池：启用 DynamicVRAM 后，权重被钉进 aimdo 的 ModelVBAR 池，
#  那不是 PyTorch caching allocator 的块。于是 NVML 读到的 used 是
#  「torch 池 + aimdo 池 + 其他进程」混在一起的总数，清理前后对比
#  看不出到底释放了哪一块——这正是「每次都说释放了、物理读数却不降」的由来。
#  分池报出来，才能区分「真没释放」和「释放了但数字被驱动缓存吃掉」。

def aimdo_enabled() -> bool:
    """Dynamic VRAM (aimdo) 当前是否真的开着。读 comfy 真实标志位。"""
    try:
        import comfy.memory_management
        return bool(getattr(comfy.memory_management, 'aimdo_enabled', False))
    except Exception:
        return False


def get_vram_breakdown() -> dict:
    """返回显存分池读数（单位：字节）。

    字段：
      total          显卡总显存
      used           物理已用（NVML/mem_get_info，含所有进程）
      free           物理空闲
      torch_reserved PyTorch caching allocator 持有但未激活的池
      torch_active   PyTorch 真正在用的显存
      aimdo          aimdo VBAR 驻留页（aimdo 未启用时为 0）
      source         读数来源
    任一环节失败都退回全 0，绝不让读数异常打断工作流。
    """
    zero = {"total": 0, "used": 0, "free": 0, "torch_reserved": 0,
            "torch_active": 0, "aimdo": 0, "source": "失败"}

    try:
        from .banzhang_sysinfo import get_gpu_info
        total, used, source = get_gpu_info()
    except Exception:
        return zero

    if total <= 0:
        return zero

    out = dict(zero)
    out["total"] = total
    out["used"] = used
    out["free"] = max(0, total - used)
    out["source"] = source

    # torch 池：reserved 是分配器占住但没动的，active 是真在用的
    try:
        if torch.cuda.is_available():
            stats = torch.cuda.memory_stats()
            out["torch_reserved"] = int(stats.get("reserved_bytes.all.current", 0))
            out["torch_active"] = int(stats.get("active_bytes.all.current", 0))
    except Exception:
        pass

    # aimdo 池：把已加载动态 patcher 的 VBAR 驻留页加总
    if aimdo_enabled():
        try:
            import comfy.model_management
            import comfy.model_patcher
            cls = getattr(comfy.model_patcher, "ModelPatcherDynamic", None)
            if cls is not None:
                total_vbar = 0
                for lm in list(comfy.model_management.current_loaded_models):
                    patcher = getattr(lm, "model", None)
                    if not isinstance(patcher, cls):
                        continue
                    try:
                        vbar = patcher._vbar_get()
                        if vbar is not None:
                            total_vbar += vbar.loaded_size()
                    except Exception:
                        continue
                out["aimdo"] = int(total_vbar)
        except Exception:
            pass

    return out

