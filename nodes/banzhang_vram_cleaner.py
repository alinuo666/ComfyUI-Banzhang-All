# -*- coding: utf-8 -*-
import torch
import gc
import comfy.model_management
import ctypes
from ctypes import wintypes
import os
import sys
import time

from ..core.banzhang_sysinfo import get_gpu_info
from ..core.banzhang_fast_terminate import _check_interrupt, _safe_force_clear_vram, get_vram_breakdown, aimdo_enabled

# --------------------------------------------------------------------------------
#  👨‍🏫 显存与系统节点
#  提供两个节点：
#    🧹 全能系统净化 —— 卸载模型 + 清缓存 + 回收 aimdo VBAR
#    🛡️⚡ 显存守卫   —— 显存预留（物理占位 + 内核封锁）+ 快速中断
#
#  近期变更：
#   - 合并原「显存预留卫士」「全能快速中断」为「显存守卫」，二者已下线。
#   - 显存守卫改为非破坏性：不再卸载模型，可放在采样器之前。
#   - 预留量不再叠加 physical_used，修掉外部占用被重复扣减的 bug。
#   - 净化节点新增 aimdo VBAR 深度回收与分池读数（解释「释放了但读数不降」）。
#   - 净化节点精简界面：只保留「卸载模型 / 清理缓存」两个开关；
#     提示音迁到「视频合并」节点，重试次数、监控面板输出已移除。
#   - 端口与开关改名（2026-10-16）：
#       显存_卸载模型 → 卸载模型 ｜ 显存_清理缓存 → 清理缓存
#       信号触发入口  → 入口  ｜ 信号直通出口  → 出口
#     旧工作流里这两个开关会回落成默认值，输入连线会断开，重连一次即可。
# --------------------------------------------------------------------------------

# 🟢 1. 定义万能类型
class 万能类型(str):
    def __ne__(self, __value: object) -> bool:
        return False
任意接口 = 万能类型("*")

# 🟢 2. 定义内存结构体 (Windows API 备用)
class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('PageFaultCount', wintypes.DWORD),
        ('PeakWorkingSetSize', ctypes.c_size_t),
        ('WorkingSetSize', ctypes.c_size_t),
        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
        ('QuotaPagedPoolUsage', ctypes.c_size_t),
        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
        ('PagefileUsage', ctypes.c_size_t),
        ('PeakPagefileUsage', ctypes.c_size_t),
        ('PrivateUsage', ctypes.c_size_t),
    ]

# 🟢 3. 共享辅助函数：全能显存获取（统一走 banzhang_sysinfo，单位 GB）
def get_robust_gpu_info():
    total, used, source = get_gpu_info()
    gb = 1024 ** 3
    return total / gb, used / gb, source






# ⛔ 已下线：禁用 Dynamic VRAM (aimdo)
#    ─────────────────────────────────────────────────────────────────────────
#    这里原本有一对函数（ensure_aimdo_disabled / _aimdo_actually_disabled），
#    做法是把 aimdo 关掉，好让 EXTRA_RESERVED_VRAM 生效：
#        comfy.memory_management.aimdo_enabled = False
#        comfy.model_patcher.CoreModelPatcher = comfy.model_patcher.ModelPatcher
#    它们已被删除，请勿再引入。原因（有实测证据，勿凭印象改回去）：
#
#      关掉 aimdo 的副作用是「之后载入的每一个模型都不再分页流式加载」，
#      而是整份搬进显存。用户 2026-10-05 的日志完整记录了这个因果链：
#        · 关之前：Model MiniMaxH3TEModel_ prepared for dynamic VRAM loading.
#                  14969MB Staged（0.1 秒）→ 导演台 14 秒，节点显存 1.3 GB
#        · 关之后：loaded completely; 14970.10 MB loaded, full load: True（21 秒）
#                  → 导演台 2 分 59 秒，节点显存 16.0 GB，OutOfMemoryError
#      也就是说，为了「留 2 GB 给别的程序」，把一台 24 GB 的卡让出了 15 GB。
#
#      而且这个关法还会**反噬它自己的目的**：_release_aimdo_vbar() 开头就是
#      `if not aimdo_enabled(): return 0, 0`，先关掉它 = 让 VBAR 深度回收整段空转。
#      用户日志里「VBAR卸载: 0 个 / 约 0.00 GB」就是这么来的。
#
#    正确做法：保持 aimdo 开启，用它自己的旋钮 ——
#      · 要预留显存 → aimdo_set_headroom()（见下面 🟢 4b）
#      · 要回收驻留页 → _release_aimdo_vbar() / release_model_residency()（见下）
#      · 若发现 aimdo 在运行期被人关掉了 → ensure_aimdo_healthy() 自动开回来
#
#    main.py:276-305 的启动链条（判断 aimdo「本次启动是否启用」的唯一依据）：
#      init_devices() 成功 → 填 comfy_aimdo.control.devctxs
#                          → CoreModelPatcher = ModelPatcherDynamic
#                          → memory_management.aimdo_enabled = True
#      所以 devctxs 非空 ⟺ 本次启动启用了 DynamicVRAM。
#    用 --disable-dynamic-vram 启动时 devctxs 为空 —— 那种情况下不能硬开回来。


# 🟢 4. aimdo (DynamicVRAM) 深度回收
#    ─────────────────────────────────────────────────────────────────────────
#    为什么必须单独处理：
#      启用 DynamicVRAM 后，ComfyUI 用 ModelPatcherDynamic 把权重钉进 aimdo 的
#      ModelVBAR 池（VBAR = 虚拟显存地址空间，aimdo 自己 fault/unpin 那几页）。
#      这些页**不是** PyTorch caching allocator 的块，所以：
#        torch.cuda.empty_cache() —— 清的是一个空池，对 VBAR 一点用没有；
#        unload_all_models()     —— 只能把「已加载的 patcher」摘下来，
#                                   VBAR 内部的驻留页依然在占着显存。
#      这就是「每次都释放 6GB / 15.99GB，剩余的一直不降」的真正原因：
#      不是 cudaMallocAsync 的 reserved 不归还（那是 torch 自己的池），
#      而是有个 torch 根本碰不到的占用方 —— aimdo VBAR。
#
#    释放路径：ModelVBAR.free_memory()  →  vbar_free_memory（卸掉驻留页）
#              最后 aimdo 才可能把页还给驱动。
_dyn_patcher_cls = None


def _dynamic_patcher_class():
    """取出 ModelPatcherDynamic 类（aimdo 关闭时为 None）。"""
    global _dyn_patcher_cls
    if _dyn_patcher_cls is None:
        try:
            import comfy.model_patcher
            _dyn_patcher_cls = getattr(comfy.model_patcher, "ModelPatcherDynamic", None)
        except Exception:
            return None
    return _dyn_patcher_cls


def _release_aimdo_vbar(aggressive: bool = True) -> tuple[int, int]:
    """回收 aimdo VBAR 里已加载但不用的权重页。

    返回 (卸载的 patcher 数, 释放的字节数估计)。aimdo 未启用时直接返回 (0, 0)。
    """
    if not aimdo_enabled():
        return 0, 0
    cls = _dynamic_patcher_class()
    if cls is None:
        return 0, 0

    freed = 0
    n = 0
    try:
        loaded = list(comfy.model_management.current_loaded_models)
    except Exception:
        return 0, 0

    for lm in loaded:
        patcher = getattr(lm, "model", None)
        if not isinstance(patcher, cls):
            continue
        # 先看这块 VBAR 当前驻留了多少
        try:
            vbar = patcher._vbar_get()
            before = vbar.loaded_size() if vbar is not None else 0
        except Exception:
            before = 0

        # 全部驻留页卸掉
        try:
            if vbar is not None:
                vbar.free_memory(1 << 62)
        except Exception:
            pass
        try:
            patcher.unload()
        except Exception:
            pass
        try:
            if vbar is not None:
                after = vbar.loaded_size()
                if after < before:
                    freed += before - after
        except Exception:
            pass
        n += 1

    # 收尾：让 aimdo 立刻回收已释放的页，并复位水位线（否则它会按旧水位继续占）
    if aggressive and n:
        try:
            import comfy_aimdo.model_vbar as mvbar
            mvbar.vbars_analyze()
            mvbar.vbars_reset_watermark_limits()
        except Exception:
            pass
        try:
            import comfy_aimdo.control as aimdo_control
            aimdo_control.analyze()
        except Exception:
            pass
    return n, freed


# 🟢 4b. aimdo 原生预留（替代「关掉 DynamicVRAM」那套写法）
#    ─────────────────────────────────────────────────────────────────────────
#    旧写法为了让 EXTRA_RESERVED_VRAM 生效，直接把 aimdo 关掉：
#        comfy.memory_management.aimdo_enabled = False
#        comfy.model_patcher.CoreModelPatcher = comfy.model_patcher.ModelPatcher
#    代价极大：CoreModelPatcher 一旦被指回经典版，**之后载入的每一个模型都不再
#    分页流式加载**，而是整份搬进显存。实测证据（用户 2026-10-05 的日志）：
#        · 关之前：Model MiniMaxH3TEModel_ prepared for dynamic VRAM loading.
#                  14969MB Staged（0.1 秒）→ 导演台 14 秒跑完，节点显存 1.3 GB
#        · 关之后：loaded completely; 14970.10 MB loaded, full load: True（21 秒）
#                  → 导演台 2 分 59 秒，节点显存 16.0 GB，最后 OutOfMemoryError
#    也就是说，为了「留 2 GB 给别的程序」，把一台 24 GB 的卡让出了 15 GB。
#
#    aimdo 自己就有原生预留旋钮，根本不用关它：
#        comfy_aimdo.control.set_simple_vram_headroom(字节)
#    它是软预算：aimdo 会为了保住这个空闲量去驱逐自己的 VBAR 页；按内核自己的
#    说明，「torch 的分配会被计入但不被拒绝」（control.py:215-235）——所以物理
#    占位那一层仍然保留，用来兜住硬保证。两者叠加才是「ComfyUI 最多用到总量 − N」。
#
#    可用性判据必须取 comfy_aimdo.control.devctxs：
#        main.py:276-305 只有 ctl.init_devices() 成功时才填它，并同时把
#        CoreModelPatcher 切到动态版、aimdo_enabled 置 True。
#        所以 devctxs 非空 ⟺ 本次启动确实启用了 DynamicVRAM。
#    不能拿 args.disable_dynamic_vram 之类的参数去猜：用户可能用
#    --disable-dynamic-vram 启动（devctxs 为空 → 不能硬开），也可能被别的节点在
#    运行期关掉（devctxs 还在 → 应该开回来）。这是两种完全不同的情况。
def aimdo_native_ready():
    """aimdo 是否真的初始化过 —— 这是它能不能用的唯一判据。返回 (可用, 原因)。"""
    try:
        import comfy_aimdo.control as _ctl
    except Exception as e:
        return False, "comfy-aimdo 不可用（%s）" % type(e).__name__
    if getattr(_ctl, "lib", None) is None:
        return False, "comfy-aimdo 运行库未加载"
    if not getattr(_ctl, "devctxs", None):
        return False, ("本次启动没有启用 DynamicVRAM（多半用了 --disable-dynamic-vram），"
                       "aimdo 原生预留不可用")
    return True, ""


def aimdo_get_headroom():
    """当前 aimdo 原生预留量（字节）。取不到返回 None。"""
    ok, _ = aimdo_native_ready()
    if not ok:
        return None
    try:
        import comfy_aimdo.control as _ctl
        return int(_ctl.get_simple_vram_headroom())
    except Exception:
        return None


def aimdo_set_headroom(nbytes):
    """设置 aimdo 原生预留量（字节），返回 (是否成功, 原因)。

    注意「调小」不会主动把页填回来：页要等下一次模型载入才回来（与内核说明一致）。
    """
    ok, why = aimdo_native_ready()
    if not ok:
        return False, why
    try:
        import comfy_aimdo.control as _ctl
        _ctl.set_simple_vram_headroom(int(nbytes))
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)
    # 回读确认，不靠「我设过了」自证 —— 静默失效比报错更难查
    got = aimdo_get_headroom()
    if got is None:
        return False, "设置后读不回预留量"
    if got != int(nbytes):
        return False, "设置后回读不一致（设 %d，读到 %d）" % (int(nbytes), got)
    return True, ""


def ensure_aimdo_healthy():
    """aimdo 本该开着却被人关掉了 → 自动开回来。返回 (是否发生纠正, 说明)。

    这是本次 OOM 的正面修法。运行期关掉 aimdo 的代价是「之后载入的所有模型都退回
    整份全量加载」，而调用它的出发点往往只是临时腾一点显存 —— 完全不值得。
    """
    try:
        import comfy.memory_management
        import comfy.model_patcher
    except Exception as e:
        return False, "导入内核模块失败: %s" % e

    if not hasattr(comfy.memory_management, "aimdo_enabled"):
        return False, ""

    ready, why = aimdo_native_ready()
    if not ready:
        # 本次启动就没启用（例如 --disable-dynamic-vram）→ 不要擅自打开
        return False, ""

    dyn_cls = getattr(comfy.model_patcher, "ModelPatcherDynamic", None)
    if not isinstance(dyn_cls, type):
        return False, ""

    need_fix = (not comfy.memory_management.aimdo_enabled
                or getattr(comfy.model_patcher, "CoreModelPatcher", None) is not dyn_cls)

    if not need_fix:
        return False, ""

    comfy.memory_management.aimdo_enabled = True
    comfy.model_patcher.CoreModelPatcher = dyn_cls

    back_ok = (bool(comfy.memory_management.aimdo_enabled)
               and getattr(comfy.model_patcher, "CoreModelPatcher", None) is dyn_cls)
    if back_ok:
        return True, ("检测到 DynamicVRAM 被提前关掉了（这会让之后载入的模型"
                      "全部退回整份全量加载，15 GB 的文本编码器会整份占满显存），"
                      "已自动开回来")
    return False, "尝试恢复 DynamicVRAM 未生效，请检查是否有其他节点仍在关闭它"


# 🟢 5. 用完就还：把某一个模型占的显存驻留页交还系统（可逆）
#    场景：导演台把提示词交给文本编码器编完就再也不碰它了，可它占的显存会一直
#    挂到工作流结束，后面的扩散模型 + LoRA 就得跟它抢。
#
#    为什么是「丢页」而不是「销毁」：
#      丢页 = partially_unload_ram()（弹 pin 栈 + hostbuf.truncate）+ vbar.free_memory()。
#      权重仍在原 safetensors 里 —— aimdo 给每个张量挂了 _comfy_tensor_file_slice
#      （comfy/utils.py:145-168），下次要用会自动重新读回来。代价是重新读一遍数据。
#      而 to_empty("meta") 那种「彻底销毁」不可逆：CLIPLoader 的输出对象被 ComfyUI
#      缓存下来跨运行复用（model_patcher.py 的 cached_patcher_init 只在
#      deepclone_multigpu 里消费），第二次跑同一个工作流会拿到被掏空的 CLIP 直接报错。
#
#    实测（K: 上 1.71 GB 的 CLIP-L，aimdo 已启用、fast_disk=True）：
#      · partially_unload_ram(1e32) 释放 0 字节 —— fast_disk=True 时权重压根不驻留
#        内存，是「文件→显存」直通（comfy/ops.py:188-191：fast_disk 时连内存 pin 都不建）
#      · partially_unload(None, 1e32) 释放 268.6 MB 显存
#      · 丢页后重新编码比「热的」多 0.221 s / 1.71 GB = 7.7 GB/s（页缓存命中）
#      · 真读盘按 1395 MB/s 算 = 0.72 s/GB
#        → 15.7 GB 的 H3 文本编码器 ≈ 2.0 s（页缓存热）/ ≈ 11.3 s（真读盘）
#      · 用户自己日志可交叉验证：首次编 15 GB 用了 21 s（≈1.4 GB/s，读盘）；
#        紧接着第二次只用了 10 s 上下（页缓存热）—— 与上面的两个边界吻合。
#
#    经典 patcher（DynamicVRAM 被关掉时）：内核没有「丢页」API，只能把权重挪回
#    offload 设备（内存条）。那等于把显存压力换成内存压力，所以先量内存够不够，
#    不够就什么都不做 —— 宁可少还一点，也不能把机器拖进交换。
def release_model_residency(patcher, model_size=None, log=None, label="模型"):
    """把某个 patcher 的驻留页交还系统，返回 (释放的内存字节, 释放的显存字节)。

    label 只用于日志。log 传一个 callable(str) 或不传。
    """
    def _say(msg):
        if log is not None:
            try:
                log(msg)
            except Exception:
                pass

    if patcher is None:
        return 0, 0

    try:
        import comfy.model_management as _mm
    except Exception:
        _mm = None

    vram_before = 0
    if _mm is not None:
        try:
            vram_before = int(_mm.get_free_memory())
        except Exception:
            pass

    try:
        is_dyn = bool(patcher.is_dynamic())
    except Exception:
        is_dyn = False

    ram_freed = 0
    vram_freed = 0

    if is_dyn:
        # ── 动态路径：可逆丢页 ──────────────────────────────────────────
        try:
            ram_freed = int(patcher.partially_unload_ram(1e32) or 0)
        except Exception as e:
            _say("  %s：内存 pin 回收失败（%s），跳过。" % (label, type(e).__name__))
        try:
            vram_freed = int(patcher.partially_unload(None, 1e32) or 0)
        except Exception as e:
            _say("  %s：显存页回收失败（%s），跳过。" % (label, type(e).__name__))
        # 让 aimdo 立刻把刚交还的页真正放掉，并复位水位线
        # （不然它会按旧水位继续占着，读数看不到下降）
        try:
            import comfy_aimdo.model_vbar as _mvbar
            _mvbar.vbars_analyze()
            _mvbar.vbars_reset_watermark_limits()
        except Exception:
            pass
    else:
        # ── 经典路径：只能「搬走」，先量内存 ────────────────────────────
        off = getattr(patcher, "offload_device", None)
        size = int(model_size or 0)
        if not size:
            try:
                size = int(patcher.model_size())
            except Exception:
                size = 0
        avail = None
        try:
            import comfy.system_memory as _sm
            avail = int(_sm.virtual_memory_available())
        except Exception:
            avail = None
        if off is None:
            _say("  %s：拿不到 offload 设备，跳过回收。" % label)
            return 0, 0
        # 需要 size + 512 MB 余量。不够就别搬：那是把显存压力换成内存压力。
        need = size + 512 * 1024 ** 2
        if avail is None or avail < need:
            _say("  %s：DynamicVRAM 未启用，内核没有可逆丢页；把 %.1f GB 挪到内存条"
                 "需要 %.1f GB、当前只剩 %.1f GB —— 已跳过，不冒拖垮内存的风险。"
                 % (label, size / 1e9, need / 1e9, (avail or 0) / 1e9))
            return 0, 0
        try:
            vram_freed = int(patcher.partially_unload(off, 1e32) or 0)
        except Exception as e:
            _say("  %s：权重挪回内存失败（%s），跳过。" % (label, type(e).__name__))
            return 0, 0

    if _mm is not None:
        try:
            _mm.soft_empty_cache()
        except Exception:
            pass

    # 实测空闲显存增量留作交叉验证（官方返回值有时是「估算」，实际可能更少）
    if _mm is not None and vram_before:
        try:
            delta = int(_mm.get_free_memory()) - vram_before
            if delta > vram_freed:
                vram_freed = delta
        except Exception:
            pass

    return max(0, ram_freed), max(0, vram_freed)


def _release_qwen_cache():
    """释放 Qwen3VL 本地模型缓存（HF 与 GGUF 两种）。

    它们存在 banzhang_translator 的全局字典里，压根不走 comfy.model_management，
    所以 unload_all_models() 完全看不见它们 —— 不在这里补一手，用户点净化
    只会看到别的模型掉了、Qwen 那几 GB 一动不动（这就是「卸不掉」的直接来源）。

    返回 (释放的模型个数, 说明文本)；没有可释放的返回 (0, "")。
    """
    try:
        # 延迟导入：避免启动阶段把翻译器整包拉起来，也避开包内循环导入
        from ..banzhang_translator.banzhang_utils import (
            MODEL_CACHE, clear_global_cache, get_gpu_used,
        )
    except Exception:
        return 0, ""

    n = len(MODEL_CACHE)
    if not n:
        return 0, ""

    before = get_gpu_used()
    clear_global_cache()
    return n, f"已释放 Qwen3VL 本地模型 {n} 个（整卡显存 {before} → {get_gpu_used()}）"


# 本包各节点的模块级缓存：(模块短名, 属性名, 中文说明)
# 共同点 —— 全是模块级字典，压根不在 comfy 的模型管理器里，unload_all_models() 看不见它们。
# 只列「持权重 / 张量 / 解码帧」这种真占显存内存的；纯元数据的小表顺手也清，代价只是下次重算。
# 以后新增带全局缓存的模块，在这里加一行就够，不要在清理处再写 if。
_节点缓存表 = (
    ("banzhang_flashvsr", "_PIPES", "FlashVSR 管线"),
    ("banzhang_relayvsr", "_模型缓存", "RelayVSR 模型"),
    ("banzhang_rife_engine", "_CACHE", "RIFE 插帧"),
    ("banzhang_ema_engine", "_CACHE", "EMA 平滑"),
    ("banzhang_clipproj", "_ENCODER_CACHE", "CLIP 编码器"),
    ("banzhang_clipproj_proj", "_CACHE", "CLIP 投影层"),
    ("csglide_cast", "_REF_IMAGE_CACHE", "参考图"),
    ("csglide_cast", "_REF_AUDIO_CACHE", "参考音频"),
    ("csglide_cast_legacy", "_REF_AUDIO_CACHE", "参考音频(旧)"),
    ("csglide_audio_io", "_AUDIO_VAE_BYTES_CACHE", "音频VAE尺寸"),
    ("banzhang_rife_model", "_GRID_CACHE", "插帧网格"),
    ("banzhang_video_tools", "_NVENC_CACHE", "NVENC 编码器"),
    ("csglide_chain", "_FFPROBE_CACHE", "视频元数据"),
)


def _release_node_caches():
    """清空上面那张表里登记的所有模块级缓存。

    只碰**已经 import 过**的模块（sys.modules 里查）：没加载过的模块不可能有缓存，
    为了清它专门去 import，反而会把依赖和模型重新拉起来，纯亏。

    每项各自 try —— 某个模块因为缺依赖没导入、或缓存类型不是 dict，不能连累其它项。
    返回 (清掉的条目数, 说明文本)；什么都没清返回 (0, "")。
    """
    import sys

    前缀 = (__package__ + ".") if __package__ else ""

    def _找(短名):
        # 先按本包前缀精确取；取不到再按后缀扫一遍。兜住「包被改名 / 以别的
        # 方式加载导致 __package__ 为空」—— 那种情况下前缀拼接会让表里所有项
        # 静默清不到，而日志上看不出任何异常。
        模块 = sys.modules.get(前缀 + 短名) if 前缀 else None
        if 模块 is not None:
            return 模块
        for 全名, 候选 in sys.modules.items():
            if 全名 == 短名 or 全名.endswith("." + 短名):
                return 候选
        return None

    条数 = 0
    已清 = []

    for 短名, 属性名, 说明 in _节点缓存表:
        模块 = _找(短名)
        if 模块 is None:
            continue
        try:
            缓存 = getattr(模块, 属性名, None)
            if not 缓存:
                continue
            个数 = len(缓存)
            缓存.clear()
            if 个数:
                条数 += 个数
                已清.append(f"{说明}×{个数}")
        except Exception as e:
            print(f"[净化] ⚠️ {说明} 清理失败: {e}")

    if not 已清:
        return 0, ""
    return 条数, "、".join(已清)


def _出口接了东西(prompt, node_id):
    """净化节点自己的出口有没有接下游（扫 API 工作流里的 [本节点, 0]）。

    接了 = 它站在链条中途（典型用途：给 6G 卡腾显存，好让紧跟着的 VAE 解码不卡）。
           这种场合只清显存，不裁工作集 —— 裁员后下游要把权重重新缺页进来，更慢。
    没接 = 用户单独点它跑，这才是「我要内存降下来」的场合，此时才裁。
    """
    if not prompt or node_id is None:
        return False
    me = str(node_id)
    try:
        for nid, node in prompt.items():
            if str(nid) == me or not isinstance(node, dict):
                continue
            for v in (node.get("inputs") or {}).values():
                if isinstance(v, list) and len(v) == 2 and str(v[0]) == me and v[1] == 0:
                    return True
    except Exception:
        return False
    return False


def 读进程内存():
    """返回 (工作集, 专用提交) 字节。任务管理器「内存」一栏看的就是工作集。

    必须显式声明 argtypes/restype：不声明时 ctypes 按 C int 传参，64 位下伪句柄
    GetCurrentProcess()=-1 会被截成 32 位，调用静默失败、读数永远是 0。
    """
    try:
        k32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE,
                                               ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
                                               wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        c = PROCESS_MEMORY_COUNTERS_EX()
        c.cb = ctypes.sizeof(c)
        if not psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
            return 0, 0
        return int(c.WorkingSetSize), int(c.PrivateUsage)
    except Exception:
        return 0, 0


def 裁工作集():
    """把本进程占的物理页压回最小（内存条口径上的"净化"）。

    为什么必须显式裁：Windows 不会因为 Python free() 就把页还给系统，任务管理器
    里那一栏会一直挂着；只有 SetProcessWorkingSetSize(-1,-1) 才让它掉。
    代价可接受：safetensors 是 mmap 的只读页，被挤出去进的是系统备用缓存，
    再读是软缺页（不落盘）；cudaHostRegister 钉住的锁页内存不会被裁掉。
    """
    try:
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetProcessWorkingSetSize.argtypes = [wintypes.HANDLE, ctypes.c_size_t, ctypes.c_size_t]
        k32.SetProcessWorkingSetSize.restype = wintypes.BOOL
        h = k32.GetCurrentProcess()
        ok = bool(k32.SetProcessWorkingSetSize(h, ctypes.c_size_t(-1).value, ctypes.c_size_t(-1).value))
        try:
            ctypes.windll.psapi.EmptyWorkingSet.argtypes = [wintypes.HANDLE]
            ctypes.windll.psapi.EmptyWorkingSet.restype = wintypes.BOOL
            ok = bool(ctypes.windll.psapi.EmptyWorkingSet(h)) or ok
        except Exception:
            pass
        return ok
    except Exception:
        return False


def 执行深度清理(卸载模型=True, 清理缓存=True, 裁工作集_=False):
    """卸载模型 + 清缓存的唯一实现：净化节点与「🎥 视频合并」的出片后自动净化共用。

    两处各写一套必然漂移 —— 尤其 _release_aimdo_vbar 这段 VBAR 深度回收，
    漏了就少收几 GB，而它正是净化节点比 unload_all_models 多要回来的那部分。
    本函数吞掉所有异常（清理失败不能影响调用方的出片/返回值）。

    裁工作集_ 默认关：出片后自动净化若也裁，下一段要把 15.9GB 权重重新缺页
    进来，白白拖慢；只有用户能点到的净化节点才做。

    返回 (卸载页数, 释放字节, 内存前, 内存后)，打印交给调用方。
    """
    卸载页数, 释放字节 = 0, 0
    内存前 = 内存后 = 0
    try:
        if torch.cuda.is_available():
            torch.cuda.synchronize()

        模型管理器 = comfy.model_management

        # 垃圾回收固定执行：开销极小，只为把刚卸载的引用尽快回收掉
        gc.collect()
        gc.collect()

        if 卸载模型:
            # Qwen3VL 等自定义节点的模型不在 comfy 的模型管理器里，
            # 必须先在它们的全局缓存里真释放，否则下面 unload_all_models 会漏掉它们
            _qn, _qnote = _release_qwen_cache()
            if _qn:
                print(f"[净化] 🍭 {_qnote}")

            # 节点自己的缓存必须在这里断引用：它们不在模型管理器里，
            # 留着就会在 unload_all_models 之后继续钉住显存和内存。
            _cn, _cnote = _release_node_caches()
            if _cn:
                print(f"[净化] 🧩 {_cnote}")

            # aimdo 必须保持开启：关着的话下面那段 VBAR 深度回收整段空转（其开头就判
            # aimdo_enabled），而且之后载入的每个模型都退回整份全量加载 —— 那是
            # 2026-10-05 那次 OOM 的起点。发现被人关了就开回来。
            _fixed, _fix_note = ensure_aimdo_healthy()
            if _fixed:
                print("[净化] ⚙️ " + _fix_note)

            # ── 关键：清 aimdo VBAR 的驻留页，必须在 unload_all_models 之前 ──
            # unload_all_models 会调 free_memory()，把卸载掉的模型从
            # current_loaded_models 里 pop 出去（model_management.py:901-924）。
            # _release_aimdo_vbar 的循环源就是这个列表 —— 放在 unload 后面调，
            # 列表已空，永远返回 0 个 0 字节（20261112 用户报「开了卸载也卸不掉」
            # 正是顺序反了：先摘了清单，腾页找不到模型）。先收页，再让 unload 摘 patcher。
            try:
                un, fr = _release_aimdo_vbar(aggressive=True)
                卸载页数 += un
                释放字节 += fr
            except Exception as e:
                print(f"[净化] ⚠️ VBAR 回收出错: {e}")

            模型管理器.unload_all_models()
            try:
                模型管理器.free_memory(100 * 1024**3, torch.device("cuda"))
            except:
                try:
                    模型管理器.free_memory(torch.device("cpu"), torch.device("cuda"))
                except:
                    pass
            if hasattr(模型管理器, "cleanup_models"):
                try:
                    模型管理器.cleanup_models()
                except:
                    pass

            gc.collect()

        if 清理缓存:
            模型管理器.soft_empty_cache()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
    except Exception as 错误:
        print(f"[净化] ⚠️ 清理出错: {错误}")

    if torch.cuda.is_available():
        torch.cuda.synchronize()

    if 裁工作集_:
        gc.collect()
        内存前 = 读进程内存()[0]
        裁工作集()
        内存后 = 读进程内存()[0]

    return 卸载页数, 释放字节, 内存前, 内存后


# =============================================================================
#  NODE 1: 🧹 全能系统净化
# =============================================================================
class BanZhang_VRAM_Cleaner_Node:
    """
    🧹 全能净化节点 (v7.0)
    """
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "卸载模型": ("BOOLEAN", {"default": True, "label_on": "开", "label_off": "关", "tooltip": "是否把模型踢出显存？踢出后模型搬到内存条上，下次用能秒回来（不会从硬盘重读）。"}),
                "清理缓存": ("BOOLEAN", {"default": True, "label_on": "开", "label_off": "关", "tooltip": "清理 PyTorch 显存碎片"}),
            },
            "optional": {
                "入口": (任意接口,), 
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (任意接口,)
    RETURN_NAMES = ("出口",)
    FUNCTION = "execute_clean_task"
    CATEGORY = "👨‍🏫班长/显存与系统"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")
    
    DESCRIPTION = """
👨‍🏫 班长的小课堂 - 全能系统净化 (v7.0)
"""

    def execute_clean_task(self, 卸载模型, 清理缓存, 入口=None, **kwargs):
        # 0. aimdo 状态确认（保持开启）
        #    旧版这里先 ensure_aimdo_disabled()，理由是「让权重不再回流到 VBAR 池」。
        #    那是反的，而且会反噬它自己的目的 —— 两个独立的问题：
        #      ① _release_aimdo_vbar() 开头就是 `if not aimdo_enabled(): return 0, 0`，
        #         先关掉它 = 让下面那段 VBAR 深度回收整段空转。
        #      ② aimdo 一旦被关，之后载入的每个模型都退回整份全量加载
        #         （15.7 GB 文本编码器整份进显存），这是 2026-10-05 那次 OOM 的起点。
        #    正确做法：保持 aimdo 开启，用它的原生接口清页；发现被人关了就开回来。
        # 1. 记录清理前状态
        before = get_vram_breakdown()
        gpu_used_before = before["used"] / 1024**3

        # 曲线监视器联动：在「🧹 内存显存曲线」上钉一枚净化前标记（监视器不在也无妨，静默跳过）
        try:
            from .banzhang_mem_graph import 打标记 as _曲线打标
            _曲线打标("净化前")
        except Exception:
            pass

        print(f"\n🧹 [班长净化 v7.0] 任务开始")

        # 2. 执行大扫除（与「🎥 视频合并」的出片后自动净化共用同一实现）
        #    裁不裁工作集，看它是不是单独跑的：出口接了下游 = 站在链条中途，只腾显存
        #    （6G 卡解码前腾地方就是这个用法），裁员会让下游重新缺页、反而更慢；
        #    出口悬空 = 用户专门点它清内存，这时才裁。
        单独运行 = not _出口接了东西(kwargs.get("prompt"), kwargs.get("unique_id"))
        vbar_unloaded, vbar_freed, 内存前, 内存后 = 执行深度清理(卸载模型, 清理缓存, 裁工作集_=单独运行)

        time.sleep(0.5)

        # 3. 记录清理后状态并打印结果
        after = get_vram_breakdown()
        gpu_used_after = after["used"] / 1024**3
        gpu_diff = gpu_used_before - gpu_used_after

        # 曲线监视器联动：净化后也钉一枚，前端两根黄虚线一夹就是本次净化释放了多少
        try:
            from .banzhang_mem_graph import 打标记 as _曲线打标
            _曲线打标("净化后")
        except Exception:
            pass

        print(f"✨ [班长净化 v7.0] 结束 | VRAM: {gpu_used_after:.2f} GB | 释放: {gpu_diff:.2f} GB"
              f" | VBAR卸载: {vbar_unloaded} 个 / 约 {vbar_freed/1024**3:.2f} GB")
        if 内存前:
            print(f"   🧠 内存工作集: {内存前/1024**3:.2f} → {内存后/1024**3:.2f} GB"
                  f" | 释放: {(内存前-内存后)/1024**3:.2f} GB\n")
        elif not 单独运行:
            print("   🧠 内存工作集: 本次站在链条中途（出口有下游），只腾显存不裁内存\n")
        else:
            print()
        return (入口,)

# =============================================================================
#  NODE 2: 🛡️⚡ 显存守卫（显存预留 + 快速中断）
# =============================================================================
#  合并了原来的「显存预留卫士」与「全能快速中断」两个节点。
#
#  与旧版的差异：
#    1. 非破坏性——不卸载模型、不清缓存。放在采样器前也不会白重载一次模型，
#       因此可以和「快速中断」合并成同一个节点（中断功能必须在模型加载之后）。
#    2. 预留量不再叠加 physical_used。那个数就是NVML 的 mem.used，
#       内核的 get_free_memory() 已经扣过一次，再塞进 EXTRA_RESERVED_VRAM
#       等于让外部占用被扣两遍（旧版的隐藏 bug）。
#    3. 不替换 minimum_inference_memory 函数。内核本身是
#       minimum_inference_memory() = 0.8GB + extra_reserved_memory()，
#       只改EXTRA_RESERVED_VRAM 就能抬高门槛，且天然可还原。
#    4. 预留容量 = 0 时完整回滚：释放物理占位、还原内核预留量与 aimdo 原生预留量。
#    5. 【本次】不再关闭 Dynamic VRAM。旧版靠
#           aimdo_enabled = False + CoreModelPatcher 指回经典版
#       来让 EXTRA_RESERVED_VRAM 生效 —— 代价是之后载入的**每一个**模型都退回
#       整份全量加载（实测 15.7 GB 文本编码器：驻留 1.3 GB → 全量 15 GB → OOM）。
#       现在改用 aimdo 原生预留 set_simple_vram_headroom()，动态显存保持开启。
#       「禁用动态显存」开关随之下线；旧工作流里带的值会被忽略并提示一次。
#       若 aimdo 本次启动就不可用（--disable-dynamic-vram），自动退回内核预留量。
#
_guard_state = {
    "extra_reserved": None,   # comfy.model_management.EXTRA_RESERVED_VRAM 原值
    "aimdo": None,            # comfy.memory_management.aimdo_enabled 原值（仅为旧版遗留状态兜底）
    "core_patcher": None,     # comfy.model_patcher.CoreModelPatcher 原类（同上）
    "aimdo_headroom": None,   # aimdo 原生预留量原值（字节）
    "tensor": None,           # 物理占位张量
}


def _guard_release_tensor():
    """释放物理占位张量。仅丢弃引用 + 清缓存，不碰任何其他显存。"""
    if _guard_state["tensor"] is None:
        return
    _guard_state["tensor"] = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _guard_restore_kernel():
    """把内核变量还原到本节点介入之前的状态。"""
    extra = _guard_state["extra_reserved"]
    if extra is not None:
        # 必须整体 import comfy.model_management：只 import 子模块时，
        # Python 会把 comfy 绑成局部名，导致同名全局不可见（UnboundLocalError）。
        import comfy.model_management
        comfy.model_management.EXTRA_RESERVED_VRAM = extra
        _guard_state["extra_reserved"] = None

    # aimdo 原生预留量还原。调小不会立刻把页填回来（要等下次载入），
    # 但水位线本身必须还原，否则下次设预留时会叠加上去。
    if _guard_state["aimdo_headroom"] is not None:
        ok, why = aimdo_set_headroom(_guard_state["aimdo_headroom"])
        if ok:
            _guard_state["aimdo_headroom"] = None
        else:
            print(f"[显存守卫] ⚠️ 还原 aimdo 原生预留量失败：{why}（下次运行会重试）")

    # 旧版遗留：如果本节点曾经关过 DynamicVRAM，这里还原回去。
    # 新版不再走这条路，_guard_state["aimdo"] 通常是 None，等于空操作。
    if _guard_state["aimdo"] is not None:
        try:
            import comfy.memory_management
            import comfy.model_patcher
            comfy.memory_management.aimdo_enabled = _guard_state["aimdo"]
            comfy.model_patcher.CoreModelPatcher = _guard_state["core_patcher"]
        except Exception as e:
            print(f"[显存守卫] ⚠️ 恢复 Dynamic VRAM 失败: {e}")
        _guard_state["aimdo"] = None
        _guard_state["core_patcher"] = None


class BanZhang_VRAM_Guard_Node:
    """
    🛡️⚡ 显存守卫：给指定程序让出显存 + 点停止能秒响应。

    两件事合成一个节点，所以要放在采样器前面：
      · 快速中断要在模型加载完之后才挂得上 patch
      · 显存预留改成非破坏性（不卸载模型），放在这里不会白重载一次模型
    """

    _patch_notified = False
    _legacy_notified = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "预留容量_GB": ("FLOAT", {
                    "default": 2.0,
                    "min": 0.0,
                    "max": 128.0,
                    "step": 0.1,
                    "tooltip": "你想给显卡里留出多少空闲显存，单位 GB。\n"
                               "例如设2 = 无论 ComfyUI 还是别的程序，都只能用到「总量 − 2GB」。\n"
                               "\n"
                               "【怎么填】\n"
                               "· 只是想让浏览器/游戏别被挤爆 → 1.5 ~ 2\n"
                               "· 边生成视频边留显存给别的东西 → 3 ~ 4\n"
                               "· 显卡本来就不大（8G/12G）→ 1 足够，别设太大\n"
                               "\n"
                               "【上限】超过总显存 90% 时会自动封顶。\n"
                               "\n"
                               "【设 0 = 完全不启用预留功能】\n"
                               "释放全部物理占位，并把内核设置还原成启动时的样子。\n"
                               "这时本节点只剩「快速中断」一个作用。\n"
                               "\n"
                               "【实现方式（全自动，无需选择）】\n"
                               "启用动态显存时走 aimdo 原生预留（set_simple_vram_headroom），\n"
                               "动态显存不可用时自动退回内核预留量（EXTRA_RESERVED_VRAM）。\n"
                               "无论哪种，都不会再关掉动态显存。"
                }),
            },
            "optional": {
                "🔣 任意输入": (任意接口, {
                    "tooltip": "接模型（MODEL）。上游模型加载完后再接进来，\n"
                               "这样「点停止秒响应」才生效。\n\n"
                               "不接也能用：此时只执行显存预留，中断功能不启用。\n"
                               "接非模型数据（图片/潜空间等）会原样透传。"
                }),
            },
        }

    RETURN_TYPES = (任意接口,)
    RETURN_NAMES = ("⚡ 智能输出",)
    FUNCTION = "execute_guard"
    CATEGORY = "👨‍🏫班长/显存与系统"
    OUTPUT_NODE = True

    DESCRIPTION = """放在采样器（KSampler）之前：硬保住「预留容量_GB」的空闲显存给其他程序，同时加快点停止的响应。设 0 = 不启用预留，只保留中断。详细取值悬停各参数查看。预留方式全自动：动态显存可用时走 aimdo 原生预留，否则退回内核预留量；不会再关掉动态显存。"""
    def _apply_intrinsic_guard(self, input_data):
        """中断守护：入口检测 + 标准 UNet 的 block 级 patch。

        返回 (透传后的对象, 中断能力描述)。描述必须如实反映实际挂上了什么，
        否则日志会报告「已挂上」但实际没生效。
        """
        try:
            _check_interrupt()
        except Exception:
            _safe_force_clear_vram()
            raise

        is_model = (
            input_data is not None
            and hasattr(input_data, "get_model_object")
            and hasattr(input_data, "add_object_patch")
        )
        if not is_model:
            hint = ("未接模型，本次不启用" if input_data is None
                    else "输入不是模型，本次不启用")
            return input_data, hint

        patched_model = input_data.clone()

        def _block_input_patch(h, _transformer_options):
            try:
                _check_interrupt()
            except Exception:
                _safe_force_clear_vram()
                raise
            return h

        block_patched = False
        try:
            # 只有标准 UNet（openaimodel）会真正读取 input_block_patch，
            # 用 input_blocks 属性精确判定，避免给 FLUX/H3 挂永不触发的 patch。
            if hasattr(patched_model.model, "input_blocks"):
                patched_model.set_model_input_block_patch(_block_input_patch)
                block_patched = True
        except Exception:
            block_patched = False

        if not BanZhang_VRAM_Guard_Node._patch_notified:
            if block_patched:
                print("👨‍🏫 显存守卫：防卡死守护已激活 (block级patch)，点停止将快速响应。")
            else:
                print("👨‍🏫 显存守卫：当前模型不支持 block 级中断注入（DiT 架构），"
                      "已回退为入口 + ComfyUI per-op 检测。若点停止无反应，"
                      "多为单个超长 kernel 无法中途打断。")
            BanZhang_VRAM_Guard_Node._patch_notified = True

        return patched_model, ("已挂上块级检测" if block_patched
                              else "该模型无块级结构，已回退为 ComfyUI 内置检测（响应略慢）")

    def execute_guard(self, 预留容量_GB, **kwargs):
        input_data = kwargs.get("🔣 任意输入", None)
        sep = "─" * 16

        # 旧工作流里可能还带着已下线的「禁用动态显存」开关 —— 忽略它，
        # 只提示一次，免得用户以为这个设置还在起作用。
        if "禁用动态显存" in kwargs and not BanZhang_VRAM_Guard_Node._legacy_notified:
            BanZhang_VRAM_Guard_Node._legacy_notified = True
            print("[显存守卫] ℹ️ 「禁用动态显存」开关已下线：现在改用 aimdo 原生预留，"
                  "不会再关掉动态显存。旧工作流里的这个值已被忽略。")

        # ---- 0a. 自动纠正：把被提前关掉的动态显存开回来 ----
        # 放在最前面。关掉动态显存会让之后载入的每个模型都退回整份全量加载
        # （15 GB 的文本编码器会整份占满显存），而这一步只是恢复启动时的状态，
        # 不改变用户任何显式设置 —— 用 --disable-dynamic-vram 启动时不会被碰。
        fixed, fix_note = ensure_aimdo_healthy()
        if fixed:
            print("[显存守卫] ⚙️ " + fix_note)

        # ---- 0b. 同步显存读数 ----
        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception:
                pass
        total_vram, physical_used, source = get_robust_gpu_info()
        if total_vram == 0:
            print("[显存守卫] ❌ 无法获取显卡信息，预留功能未执行")
            return (self._apply_intrinsic_guard(input_data)[0],)

        # ---- 1. 先释放旧占位，避免叠加 ----
        _guard_release_tensor()

        native_ok, native_why = aimdo_native_ready()

        # ---- 2. 预留容量=0 → 不启用预留，完整回滚 ----
        if 预留容量_GB <= 0:
            _guard_restore_kernel()
            guarded, guard_hint = self._apply_intrinsic_guard(input_data)
            log = (
                f"🛡️⚡ 预留功能：未启用{sep}\n"
                f"📊 显卡总共 {total_vram:.1f} GB ｜ 当前已用 {physical_used:.2f} GB\n"
                f"{sep}\n"
                f"✅ 物理占位已释放，内核预留量与 aimdo 预留量已还原成介入前的值\n"
                f"ℹ️ 本节点现在只负责「快速中断」：{guard_hint}\n"
                f"ℹ️ 想重新启用预留，把「预留容量_GB」改成大于 0 的数值即可。"
            )
            print("\n🛡️⚡ [显存守卫]\n" + log)
            return (guarded,)

        # ---- 3. 写预留量：优先 aimdo 原生，不可用时退回内核预留量 ----
        # 两条都写不冲突：aimdo 管动态分页模型，EXTRA_RESERVED_VRAM 管非动态模型。
        # 关键是**不再关掉动态显存** —— 那会让所有模型退回整份全量加载。
        if _guard_state["extra_reserved"] is None:
            _guard_state["extra_reserved"] = comfy.model_management.EXTRA_RESERVED_VRAM
        if _guard_state["aimdo_headroom"] is None and native_ok:
            # 记下介入前的值，便于 0 时还原（取不到就记 0，还原成 0 也无害）
            cur = aimdo_get_headroom()
            _guard_state["aimdo_headroom"] = 0 if cur is None else cur

        # 封顶 90%：留一成给 CUDA context 和驱动固定开销
        safe_ceiling = total_vram * 0.9
        final_reserved_gb = min(预留容量_GB, safe_ceiling)
        capped = final_reserved_gb < 预留容量_GB
        reserve_bytes = int(final_reserved_gb * 1024 * 1024 * 1024)

        comfy.model_management.EXTRA_RESERVED_VRAM = reserve_bytes

        aimdo_ok = False
        aimdo_note = ""
        if native_ok:
            aimdo_ok, aimdo_err = aimdo_set_headroom(reserve_bytes)
            if not aimdo_ok:
                aimdo_note = f"⚠️ aimdo 原生预留未生效（{aimdo_err}），已由内核预留量接管"
                print("[显存守卫] ⚠️ " + aimdo_note)
        else:
            aimdo_note = f"ℹ️ 动态显存不可用（{native_why}），本次只用内核预留量"

        # ---- 4. 物理占位（失败不报错，内核/aimdo 那层仍然有效） ----
        phys_ok = False
        phys_note = ""
        try:
            _guard_state["tensor"] = torch.empty(
                reserve_bytes, dtype=torch.uint8, device="cuda"
            )
            phys_ok = True
        except RuntimeError as e:
            phys_note = "⚠️ 未能占住物理显存（显卡已满），但内核/aimdo 预留仍然生效"
            print(f"[显存守卫] ⚠️ 物理占位失败（显存已满），预留仍生效: {e}")

        available_for_comfy = total_vram - final_reserved_gb
        guarded, guard_hint = self._apply_intrinsic_guard(input_data)

        if aimdo_ok:
            mech = "aimdo 原生预留（动态显存正常工作，模型仍分页流式加载）"
        elif native_ok:
            mech = "内核预留量（aimdo 原生预留未生效，已自动降级）"
        else:
            mech = f"内核预留量（{native_why}）"

        # 这两条说明要接在最后一行后面。反斜杠不能写进 f-string 的表达式里 ——
        # PEP 701 放宽这条限制是 Python 3.12 的事，3.10/3.11（ComfyUI 便携版
        # 常见环境）会直接 SyntaxError，整个模块 import 失败，于是「显存净化 /
        # 显存守卫」两个节点根本没有注册，用户界面只看到"未知节点"。
        phys_tail = ("\n   " + phys_note) if phys_note else ""
        aimdo_tail = ("\n   " + aimdo_note) if aimdo_note else ""

        log = (
            f"🛡️⚡ 预留功能：已生效{sep}\n"
            f"📊 显卡总共 {total_vram:.1f} GB ｜ 当前已用 {physical_used:.2f} GB\n"
            f"{sep}\n"
            f"🎯 预留空闲 {final_reserved_gb:.2f} GB"
            f"{'（你设的值超过总量 90%，已自动封顶）' if capped else ''}\n"
            f"💡 ComfyUI 可用到 {available_for_comfy:.2f} GB 以内\n"
            f"🧱 物理占位："
            f"{'成功，任何程序都抢不走这 ' + f'{final_reserved_gb:.2f} GB' if phys_ok else '未成功'}\n"
            f"⚙️ 预留方式：{mech}\n"
            f"{sep}\n"
            f"ℹ️ 动态显存：{'保持开启（不再需要为预留而关闭）' if native_ok else '本次启动未启用'}"
            f"{('｜' + fix_note) if fixed else ''}\n"
            f"ℹ️ 快速中断：{guard_hint}"
            f"{phys_tail}"
            f"{aimdo_tail}"
        )
        print("\n🛡️⚡ [显存守卫]\n" + log)
        return (guarded,)


# =============================================================================
#  NODE MAPPINGS
# =============================================================================
NODE_CLASS_MAPPINGS = {
    "BanZhang_VRAM_Cleaner": BanZhang_VRAM_Cleaner_Node,
    "BanZhang_VRAM_Guard": BanZhang_VRAM_Guard_Node,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_VRAM_Cleaner": "🧹 全能系统净化",
    "BanZhang_VRAM_Guard": "🛡️⚡ 显存守卫",
}