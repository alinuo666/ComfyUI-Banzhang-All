# -*- coding: utf-8 -*-
"""
👨‍🏫 班长全家桶 - 统一系统信息读取（显存 / 内存）

用途：给「显存预留卫士」「全能系统净化」「顶栏监控」提供同一套读数，
避免三处各写一份、改一处漏两处的情况。

约定：所有返回值一律用「字节」，需要 GB 的地方自己除以 1024**3。
"""

import subprocess

# ---------------------------------------------------------------- pynvml
pynvml = None
PYNVML_INSTALLED = False
try:
    import pynvml as _pynvml
    _pynvml.nvmlInit()
    pynvml = _pynvml
    PYNVML_INSTALLED = True
    print("✅ [班长全家桶] pynvml 驱动库加载成功")
except Exception as e:
    print(f"⚠️ [班长全家桶] pynvml 不可用，改用备用方案读取显存（{e}）")

# ---------------------------------------------------------------- psutil
try:
    import psutil
    PSUTIL_INSTALLED = True
except ImportError:
    psutil = None
    PSUTIL_INSTALLED = False


def get_gpu_info():
    """显存读数：(总字节, 已用字节, 来源)。全部失败时返回 (0, 0, '失败')。"""

    # 方案 A：NVIDIA 驱动（最准，含其他程序占用）
    if PYNVML_INSTALLED:
        try:
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            return mem.total, mem.used, "NVML"
        except Exception:
            pass

    # 方案 B：nvidia-smi 命令行
    try:
        out = subprocess.check_output(
            ['nvidia-smi', '--query-gpu=memory.total,memory.used', '--format=csv,nounits,noheader'],
            creationflags=0x08000000  # 不弹黑窗
        )
        parts = out.decode('utf-8').strip().split(',')
        return float(parts[0]) * 1024 * 1024, float(parts[1]) * 1024 * 1024, "CMD"
    except Exception:
        pass

    # 方案 C：PyTorch（取物理显存，而非缓存池）
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            free, total = torch.cuda.mem_get_info()
            return total, total - free, "Torch"
    except Exception:
        pass

    return 0, 0, "失败"


def get_ram_info():
    """内存读数：(总字节, 已用字节)。失败时返回 (0, 0)。"""
    if PSUTIL_INSTALLED:
        try:
            mem = psutil.virtual_memory()
            return mem.total, mem.used
        except Exception:
            pass
    return 0, 0


# ---------------------------------------------------------------- aimdo (DynamicVRAM)
#  启用 DynamicVRAM 后，模型权重会常驻在 aimdo 自己的 VBAR 池里。这部分显存
#  **不经过 PyTorch 的 caching allocator**，于是：
#    - torch.cuda.empty_cache() 对它无效（空池是空的，无从可清）；
#    - NVML 读到的 used 混着它，却拆不出「多少是 VBAR 占的」。
#  下面这组函数把 VBAR 驻留量与 torch 池分别读出来，才能判断「清完还剩多少」。
def aimdo_enabled():
    """DynamicVRAM (aimdo) 是否处于启用状态。"""
    try:
        import comfy.memory_management
        return bool(getattr(comfy.memory_management, "aimdo_enabled", False))
    except Exception:
        return False


def get_aimdo_vram_bytes():
    """aimdo 自报的显存申请量（字节）；未启用 / 读不到时返回 0。

    口径说明：这是 aimdo 的申请量，与 NVML 的物理占用不是同一个数，
    只能用于「有没有降下来」的趋势判断，不能直接相减。
    """
    if not aimdo_enabled():
        return 0
    try:
        import comfy_aimdo.control as aimdo_control
        used = aimdo_control.get_total_vram_usage()
        return int(used) if used else 0
    except Exception:
        return 0


def get_torch_vram_bytes():
    """PyTorch caching allocator 的 (allocated, reserved) 字节数。

    reserved 明显大于 allocated 的部分就是 empty_cache() 能回收的；
    若两者已接近而物理占用仍高，说明占用不在 torch 手里（在 aimdo 或别的库）。
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return 0, 0
        return int(torch.cuda.memory_allocated()), int(torch.cuda.memory_reserved())
    except Exception:
        return 0, 0


def get_vram_breakdown():
    """一次性取全各项显存读数（字节），供净化节点做「清完还剩什么」的归因。

    返回 dict:
      total / used   —— 物理口径（NVML 优先，含其他程序占用）
      torch_alloc / torch_reserved —— PyTorch 池口径
      aimdo          —— DynamicVRAM 池口径（未启用时为 0）
    """
    total, used, source = get_gpu_info()
    torch_alloc, torch_reserved = get_torch_vram_bytes()
    return {
        "total": int(total),
        "used": int(used),
        "source": source,
        "torch_alloc": torch_alloc,
        "torch_reserved": torch_reserved,
        "aimdo": get_aimdo_vram_bytes(),
    }
