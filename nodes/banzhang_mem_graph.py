# =============================================================================
# 📈 活动监视器（内存 / 显存曲线）—— 画布节点，纯显示
# =============================================================================
# 采样由**独立线程按 0.25 秒定时**做，不绑在 HTTP 请求上。
# 为什么必须这样：后端「被问一次才采一个点」时，采样点的时间戳就是请求到达的时刻。
# 请求一旦漏掉（ComfyUI 执行线程占着 GIL、前端 abort 掉慢请求），那一小段时刻
# **永久不会再有采样点**。而前端的曲线右边界锚在「最后一个采样点」，节点的阶段时间
# 一旦晚于它，整段就被裁到画布外 —— 用户看到的就是「执行都完成了，节点还没出来」。
# 线程惰性启停：5 分钟没人问才停采，面板关掉/页面切走后照样零常驻开销。
# 不取更短是因为切走标签页时前端会停轮询，停采太早会在曲线上留一段无法补回的空洞。
#
# 历史只存在进程内存里（环形缓冲），ComfyUI 重启自然清零。
#
# 每个采样点字段：
#   t           时间戳（秒）
#   vram_used / vram_total   显存字节（NVML 驱动层真实占用，含 ComfyUI 之外）
#   ram_used  / ram_total    内存字节（psutil）
#   gpu_util    GPU 核心利用率 0-100（NVML，拿不到为 0）
#   gpu_temp    GPU 温度 ℃（NVML，拿不到为 0）
#
# 对外接口（给班长净化🧹等节点联动用）：
#   from .banzhang_mem_graph import 打标记
#   打标记("净化前") / 打标记("净化后")
# 前端会在曲线对应时间点画一根竖虚线 + 文字。
# =============================================================================

import threading
import time
from collections import deque

import psutil

try:
    import pynvml
    pynvml.nvmlInit()
    _nvml句柄 = pynvml.nvmlDeviceGetHandleByIndex(0)
except Exception:
    _nvml句柄 = None

# 0.25 秒 1 点 × 7200 点 = 30 分钟（采样线程定时采，与前端请求频率无关）
# 前端上限 MAX_PTS=7400 比这里大一圈，留一点余量，免得刚被环形缓冲丢掉的点前端还想要。
_历史 = deque(maxlen=7200)
_标记 = deque(maxlen=50)
# 采样线程 append 的同时路由在 list() 拷贝，deque 迭代期间被改会抛 RuntimeError，读写都过锁
_锁 = threading.Lock()
_最近请求 = 0.0          # 最后一次被前端问的时刻（秒）；超过 300 秒没人问就停采
_线程已启 = False


def _显存采样():
    """返回 (已用字节, 总字节)。NVML 是驱动层真实占用（含 ComfyUI 之外的），
    优先用；拿不到退回 torch 的 mem_get_info（同样反映驱动层余量）；再不行 (0, 0)。"""
    if _nvml句柄 is not None:
        try:
            信息 = pynvml.nvmlDeviceGetMemoryInfo(_nvml句柄)
            return 信息.used, 信息.total
        except Exception:
            pass
    try:
        import torch
        if torch.cuda.is_available():
            空闲, 总量 = torch.cuda.mem_get_info(0)
            return 总量 - 空闲, 总量
    except Exception:
        pass
    return 0, 0


def _gpu状态采样():
    """返回 (利用率%, 温度℃)。NVML 拿不到就 (0, 0)，不影响主曲线。"""
    if _nvml句柄 is None:
        return 0, 0
    利用率 = 0
    温度 = 0
    try:
        利用率 = int(pynvml.nvmlDeviceGetUtilizationRates(_nvml句柄).gpu)
    except Exception:
        pass
    try:
        温度 = int(pynvml.nvmlDeviceGetTemperature(_nvml句柄, pynvml.NVML_TEMPERATURE_GPU))
    except Exception:
        pass
    return 利用率, 温度


def _采一个点():
    点 = {"t": time.time()}
    用, 总 = _显存采样()
    点["vram_used"] = 用
    点["vram_total"] = 总
    虚拟内存 = psutil.virtual_memory()
    点["ram_used"] = 虚拟内存.used
    点["ram_total"] = 虚拟内存.total
    点["gpu_util"], 点["gpu_temp"] = _gpu状态采样()
    return 点


def _采样循环():
    """独立线程按 0.25 秒采一点。采样节奏必须由时间驱动，不能由请求驱动：
    请求漏一次，那一刻就永久缺一个采样点，那段时间的节点会全部落到曲线右边界之外。"""
    while True:
        time.sleep(0.25)
        if time.time() - _最近请求 > 300:
            continue                      # 面板关掉 / 页面切走后停采，零常驻开销
        try:
            点 = _采一个点()
        except Exception:
            continue
        with _锁:
            _历史.append(点)


def _确保采样线程():
    global _线程已启
    if _线程已启:
        return
    _线程已启 = True
    threading.Thread(target=_采样循环, name="banzhang_mem_graph", daemon=True).start()


def 打标记(文字=""):
    """给时间轴钉一枚标记（净化前 / 净化后 …）。空文字忽略。"""
    文字 = str(文字 or "").strip()
    if not 文字:
        return
    with _锁:
        _标记.append({"t": time.time(), "label": 文字[:20]})


# ==============================================================================
# HTTP 接口
# ==============================================================================
try:
    from aiohttp import web
    from server import PromptServer

    if PromptServer.instance is not None:
        @PromptServer.instance.routes.get("/banzhang/mem_graph")
        async def _历史接口(request):
            # 这里不再采样，只取数据 —— 采样由 _采样循环 定时做。
            # 记住「有人在看」，让线程继续采；5 分钟没人问它自己停。
            global _最近请求
            _最近请求 = time.time()
            _确保采样线程()
            # since：只回该时刻之后的点（增量）。前端 0.25 秒问一次，回全量等于
            # 每秒搬四五次 30 分钟数据（几千个点），本地回环也白白烧 JSON 序列化。
            # full 字段一定要回：前端靠它在场与否判断后端是不是老版本（老版本不支持
            # since，每次都回全量，前端若按增量 concat 会把点数堆爆 → 界面越跑越卡）。
            # 首次请求(since=0)、后端重启或历史被清空(最老点比 since 还新) 时自动回全量。
            try:
                since = float(request.query.get("since", 0) or 0)
            except Exception:
                since = 0.0
            if since != since:                       # NaN 守卫：NaN 与任何数比较都是 False，
                since = 0.0                          # 漏进来会永远回空列表、曲线彻底冻住
            with _锁:
                快照 = list(_历史)
                标记 = list(_标记)
            全量 = since <= 0 or not 快照 or 快照[0]["t"] > since
            点 = 快照 if 全量 else [p for p in 快照 if p["t"] > since]
            return web.json_response({
                "points": 点,
                "marks": 标记,
                "full": 全量,
            })

        @PromptServer.instance.routes.post("/banzhang/mem_mark")
        async def _打标接口(request):
            try:
                数据 = await request.json()
                打标记(数据.get("label", ""))
            except Exception:
                pass
            return web.json_response({"ok": True})
except Exception:
    # 离线单测等无 PromptServer 环境：跳过路由注册，不影响节点类定义
    pass


# ==============================================================================
# 节点
# ==============================================================================
class BanZhang_Mem_Graph_Node:
    """📈 活动监视器（内存 / 显存）—— 拖到画布上看实时曲线，不进工作流数据链。"""

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 秒数，前端用对数滑块无极调节（30 秒 ~ 30 分钟）。
                # 旧工作流存的是 "5 分钟" 这类枚举字符串，前端 winSecOf() 会兜底换算。
                "时间窗": ("FLOAT", {"default": 300, "min": 30, "max": 1800, "step": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "空跑"
    CATEGORY = "👨‍🏫班长/显存与系统"
    DESCRIPTION = "📈 活动监视器：实时显示显存 / 内存占用曲线（含 GPU 利用率与温度）。放在画布任意位置即可，不参与执行；配合班长净化🧹会在曲线上标出净化前 / 净化后。"

    def 空跑(self, 时间窗="5 分钟"):
        return ()


NODE_CLASS_MAPPINGS = {
    "BanZhang_Mem_Graph": BanZhang_Mem_Graph_Node,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_Mem_Graph": "📈 活动监视器·内存显存",
}
