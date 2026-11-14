# 🧹 顶栏净化接口 —— 「显存 / 内存」胶囊旁那个「全卸载」按钮的后端
#
# 为什么单独成一个文件，不塞进 banzhang_vram_reserved.py：
#   那个模块顶层没有 `if PromptServer:` 保护。路由注册一旦抛异常，整个模块 import
#   就失败 → 监控线程 + 两个清理节点一起静默消失（本包历史上已经栽过一次：
#   一行 f-string 让两个节点凭空不见，用户侧报 missing_node_type）。
#   这里由 __init__.py 单独 try/except 导入，最坏情况只是按钮没反应。
import asyncio

from aiohttp import web
from server import PromptServer


def _snapshot():
    """清理前后读数。任一来源失败只归零，不能影响清理本身。"""
    from .core.banzhang_sysinfo import get_gpu_info, get_ram_info
    try:
        vram_total, vram_used, _src = get_gpu_info()
    except Exception:
        vram_total, vram_used = 0, 0
    try:
        ram_total, ram_used = get_ram_info()
    except Exception:
        ram_total, ram_used = 0, 0
    return {
        "vram_total": vram_total,
        "vram_used": vram_used,
        "ram_total": ram_total,
        "ram_used": ram_used,
    }


def _running_count():
    """正在执行的任务数。

    只认 ComfyUI 自己的 currently_running：队列里排队但还没开跑的时候卸载是安全的
    （那时模型还没加载）。用 get_current_queue 而不是 volatile 版，因为前者老版本
    也有，deepcopy 一份 JSON 的代价在「人手点一下」的频率下可以忽略。
    """
    try:
        running, _queued = PromptServer.instance.prompt_queue.get_current_queue()
        return len(running)
    except Exception:
        return 0


def _clean():
    """一次清到底：节点缓存 → 模型 → 显存碎片 → 进程内存（裁工作集）。

    全部交给 banzhang_vram_cleaner.执行深度清理 —— 它和「🧹 全能系统净化」节点
    共用同一套实现。两处各写一套必然漂移（VBAR 深度回收那段漏一次就少收几 GB）。

    惰性导入：cleaner 是本包最重的模块之一（aimdo / VBAR），只在用户第一次
    点按钮时才付这份 import 代价。
    """
    from .nodes.banzhang_vram_cleaner import 执行深度清理

    执行深度清理(卸载模型=True, 清理缓存=True, 裁工作集_=True)


@PromptServer.instance.routes.post("/banzhang/purge")
async def banzhang_purge(request):
    # 生成中直接拒绝：跑到一半把模型摘掉，本次会重读权重、变慢，峰值还可能 OOM。
    # 拦在后端而不是只靠前端 —— 前端状态和真实执行状态不同步时前端会放行。
    if _running_count() > 0:
        return web.json_response(
            {"ok": False, "busy": True, "error": "正在生成，先停止再清理"},
            status=403,
        )

    before = _snapshot()

    # 深度清理实测 5~6 秒（free_memory + VBAR 回收 + 裁工作集）。同步跑会把整个
    # 事件循环卡住，表现是这几秒内所有 ComfyUI 请求都无响应，必须丢到线程里。
    await asyncio.to_thread(_clean)

    after = _snapshot()
    return web.json_response({"ok": True, "busy": False,
                              "before": before, "after": after})


print("[班长全家桶] 🧹 顶栏「全卸载」接口已注册：POST /banzhang/purge")
