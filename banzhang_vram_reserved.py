# -*- coding: utf-8 -*-
import threading
import time
from typing import Any as any_type
from comfy import model_management
import random
import gc
import logging

from .banzhang_sysinfo import get_gpu_info, get_ram_info

initial_random_state = random.getstate()
random.seed(time.time())
reserved_vram_random_state = random.getstate()
random.setstate(initial_random_state)

_original_aimdo_enabled = None
_original_core_model_patcher = None


def _check_dynamic_vram_available():
    try:
        import comfy.memory_management
        return hasattr(comfy.memory_management, 'aimdo_enabled')
    except Exception:
        return False


def _disable_dynamic_vram():
    global _original_aimdo_enabled, _original_core_model_patcher

    try:
        import comfy.memory_management
        import comfy.model_patcher

        if not hasattr(comfy.memory_management, 'aimdo_enabled'):
            print("[显存预留]当前 ComfyUI 版本不支持 Dynamic VRAM，无需禁用")
            return False

        if not comfy.memory_management.aimdo_enabled:
            print("[显存预留]Dynamic VRAM 已处于禁用状态")
            return True

        if _original_aimdo_enabled is None:
            _original_aimdo_enabled = comfy.memory_management.aimdo_enabled
        if _original_core_model_patcher is None:
            _original_core_model_patcher = comfy.model_patcher.CoreModelPatcher

        comfy.memory_management.aimdo_enabled = False

        # 同 banzhang_vram_cleaner 的教训：hasattr 只查存在性。若 ModelPatcher
        # 存在但为 None，赋值会把 None 写回 CoreModelPatcher，之后 sd.py 挑
        # patcher 时才炸。必须确认是可用的类。
        _mp_cls = getattr(comfy.model_patcher, "ModelPatcher", None)
        if isinstance(_mp_cls, type):
            comfy.model_patcher.CoreModelPatcher = _mp_cls
            print("[显存预留]✅ 已将模型加载器切换为传统 ModelPatcher")
        else:
            print(f"[显存预留]⚠️ comfy.model_patcher.ModelPatcher 不可用"
                  f"（读到 {type(_mp_cls).__name__}），无法切换 patcher 入口")

        # 回读确认：没有验证就打印「已禁用」等于骗用户，这正是 OOM 难查的根源。
        # 判等前必须确认 ModelPatcher 可用 —— 若它是 None，两边同为 None 会
        # 让「没改成」被误判成「已关闭」。
        _ok = False
        if isinstance(_mp_cls, type):
            _ok = (not comfy.memory_management.aimdo_enabled
                   and comfy.model_patcher.CoreModelPatcher is _mp_cls)
        if not _ok:
            print("[显存预留]⚠️ Dynamic VRAM 实际未关闭，"
                  "新载入的模型仍走动态分页加载。")
            return False

        print("[显存预留]✅ Dynamic VRAM (aimdo) 已禁用")
        return True

    except Exception as e:
        print(f"[显存预留]❌ 禁用 Dynamic VRAM 时出错: {e}")
        return False


def _restore_dynamic_vram():
    global _original_aimdo_enabled, _original_core_model_patcher

    try:
        import comfy.memory_management
        import comfy.model_patcher

        if _original_aimdo_enabled is not None:
            comfy.memory_management.aimdo_enabled = _original_aimdo_enabled
            _original_aimdo_enabled = None

        if _original_core_model_patcher is not None:
            comfy.model_patcher.CoreModelPatcher = _original_core_model_patcher
            _original_core_model_patcher = None

        print("[显存预留]✅ Dynamic VRAM 已恢复")
        return True

    except Exception as e:
        print(f"[显存预留]❌ 恢复 Dynamic VRAM 时出错: {e}")
        return False


def get_gpu_memory_info():
    """显存读数，单位 GB：(总, 已用)。统一走 banzhang_sysinfo。"""
    total, used, _source = get_gpu_info()
    if total <= 0:
        return None, None
    return total / (1024 ** 3), used / (1024 ** 3)


def new_random_seed():
    global reserved_vram_random_state
    prev_random_state = random.getstate()
    random.setstate(reserved_vram_random_state)
    seed = random.randint(1, 1125899906842624)
    reserved_vram_random_state = random.getstate()
    random.setstate(prev_random_state)
    return seed


class AlwaysEqualProxy(str):
    def __eq__(self, _):
        return True

    def __ne__(self, _):
        return False


any_type = AlwaysEqualProxy("*")


class BanZhang_ClearRAM:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                "输入": (any_type, {})
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("输出",)
    OUTPUT_NODE = True
    FUNCTION = "clear_ram"
    CATEGORY = "👨‍🏫班长/显存与系统"

    def _get_ram_info(self):
        """内存读数，单位 GB：(总, 已用, 可用)。统一走 banzhang_sysinfo。"""
        total, used = get_ram_info()
        if total <= 0:
            return None, None, None
        gb = 1024 ** 3
        return total / gb, used / gb, (total - used) / gb

    def clear_ram(self, **kwargs):
        anything = kwargs.get("输入", None)

        print("[清理内存]" + "=" * 50)
        print("[清理内存]开始清理系统内存...")

        total_before, used_before, avail_before = self._get_ram_info()
        if total_before is not None:
            print(f"[清理内存]清理前: 总内存={total_before:.2f}GB, 已用={used_before:.2f}GB, 可用={avail_before:.2f}GB")

        model_management.unload_all_models()
        print("[清理内存]所有模型已卸载")

        model_management.soft_empty_cache()
        print("[清理内存]软缓存已清空")

        gc.collect()
        gc.collect()
        print("[清理内存]Python垃圾回收完成（两轮）")

        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        import ctypes
        import sys
        if sys.platform == 'win32':
            try:
                ctypes.windll.kernel32.SetProcessWorkingSetSize(
                    ctypes.windll.kernel32.GetCurrentProcess(), -1, -1
                )
                print("[清理内存]Windows工作集已释放")
            except Exception as e:
                print(f"[清理内存]释放Windows工作集时出错: {e}")
        elif sys.platform == 'linux':
            try:
                libc = ctypes.CDLL("libc.so.6")
                libc.malloc_trim(0)
                print("[清理内存]Linux内存已整理(malloc_trim)")
            except Exception as e:
                print(f"[清理内存]Linux内存整理出错: {e}")

        total_after, used_after, avail_after = self._get_ram_info()
        if total_after is not None:
            print(f"[清理内存]清理后: 总内存={total_after:.2f}GB, 已用={used_after:.2f}GB, 可用={avail_after:.2f}GB")
            if used_before is not None:
                freed = used_before - used_after
                print(f"[清理内存]共释放内存: {freed:.2f}GB")

        print("[清理内存]✅ 内存清理完成")
        print("[清理内存]" + "=" * 50)

        from comfy_execution.graph import ExecutionBlocker
        output_value = anything if anything is not None else ExecutionBlocker(None)

        return (output_value,)


NODE_CLASS_MAPPINGS = {
    "BanZhang_ClearRAM": BanZhang_ClearRAM,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_ClearRAM": "🧹 清理内存",
}


class _MonitorThread(threading.Thread):
    """
    顶栏监控推送线程。

    说明：ComfyUI 的 PromptServer.send_sync 内部用的是
    loop.call_soon_threadsafe（官方给工作线程准备的入口），
    所以这里直接在普通线程里调用即可，不需要自己再开一条事件循环。
    """

    def __init__(self, rate=1.5):
        super().__init__(daemon=True)
        self.rate = rate
        self._stop = threading.Event()
        self._error_reported = False

    def stop(self):
        self._stop.set()

    def run(self):
        time.sleep(3)  # 等 ComfyUI 服务器起来
        while not self._stop.is_set():
            try:
                import server as comfy_server
                vram_total, vram_used, _source = get_gpu_info()
                ram_total, ram_used = get_ram_info()

                comfy_server.PromptServer.instance.send_sync(
                    "vram_reserved.monitor",
                    {
                        "vram_total": vram_total,
                        "vram_used": vram_used,
                        "ram_total": ram_total,
                        "ram_used": ram_used,
                    },
                )
            except Exception as e:
                # 只报一次，避免刷屏；前端会在 10 秒没数据时显示"离线"
                if not self._error_reported:
                    self._error_reported = True
                    print(f"⚠️ [班长显存监控] 推送状态失败（后续不再重复提示）: {e}")

            self._stop.wait(self.rate)


_monitor = _MonitorThread(rate=1.5)
_monitor.start()