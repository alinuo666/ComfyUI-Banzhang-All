# -*- coding: utf-8 -*-
"""
👨‍🏫 班长开发工具节点 (Banzhang Dev Utils)
整合自 ComfyUI-Dev-Utils
功能: 执行时间统计
"""

from __future__ import annotations
import os
import time
import logging
import inspect

import torch

# pyright: reportMissingImports=false
import execution
import server

# ==============================================================================
# 日志配置
# ==============================================================================
logger = logging.getLogger("Banzhang-DevUtils")


# ==============================================================================
# 1. 执行时间节点
# ==============================================================================

class ExecutionTime:
    """执行时间统计节点 - 虚拟节点，用于显示各节点执行耗时和显存使用"""

    CATEGORY = "👨‍🏫班长/工具与标注"
    DESCRIPTION = (
        "统计每个节点的执行耗时、累计耗时与显存占用。拖入画布即可，无需连线。"
        "表格可切换到「仅视频合并阶段」，按视频合并节点的自定义名称查看每个阶段耗时。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "process"

    def process(self):
        return ()


# ==============================================================================
# 执行时间剖析器 (Execution Profiler)
# ==============================================================================

# 是否启用「显存峰值」统计。开启后每个节点开始执行时会调用
# torch.cuda.reset_max_memory_allocated()——这是 CUDA 全局状态，会连带清掉
# ComfyUI 自身及其他插件记录的峰值。关掉则显存列恒为 0。
VRAM_PEAK_ENABLED = True


class ExecutionProfiler:
    """管理执行时间和VRAM统计的单例类

    账本按 prompt_id 隔离：多个标签页/多个客户端交替排队时互不串账。
    """

    MAX_SESSIONS = 8  # 最多保留的会话数，防止长期运行内存持续增长

    def __init__(self):
        self.sessions = {}  # prompt_id -> {"total_start", "nodes_start", "nodes_vram"}
        self._order = []  # 会话进入顺序，用于淘汰最旧的

    def reset(self, prompt_id):
        self.sessions[prompt_id] = {
            "total_start": time.perf_counter(),
            "nodes_start": {},
            "nodes_vram": {},
        }
        self._order.append(prompt_id)
        while len(self._order) > self.MAX_SESSIONS:
            self.sessions.pop(self._order.pop(0), None)

    def _session(self, prompt_id):
        """取会话；不存在时补建一个（兼容未捕获到 execution_start 的情况）"""
        session = self.sessions.get(prompt_id)
        if session is None:
            self.reset(prompt_id)
            session = self.sessions[prompt_id]
        return session

    def start_node(self, prompt_id, node_id):
        session = self._session(prompt_id)
        session["nodes_start"][node_id] = time.perf_counter()
        if VRAM_PEAK_ENABLED and torch.cuda.is_available():
            try:
                torch.cuda.reset_max_memory_allocated()
                session["nodes_vram"][node_id] = torch.cuda.memory_allocated()
            except Exception:
                pass

    def pop_node_start(self, prompt_id, node_id):
        return self._session(prompt_id)["nodes_start"].pop(node_id, None)

    def get_peak_vram_diff(self, prompt_id, node_id):
        if not VRAM_PEAK_ENABLED or not torch.cuda.is_available():
            return 0
        start_vram = self._session(prompt_id)["nodes_vram"].pop(node_id, None)
        if start_vram is None:
            return 0
        try:
            vram_used = torch.cuda.max_memory_allocated() - start_vram
        except Exception:
            return 0
        return max(0, vram_used)

    def total_elapsed(self, prompt_id):
        session = self.sessions.get(prompt_id)
        if not session or session["total_start"] <= 0:
            return 0
        return time.perf_counter() - session["total_start"]

    def drop(self, prompt_id):
        self.sessions.pop(prompt_id, None)
        if prompt_id in self._order:
            self._order.remove(prompt_id)

    def format_time(self, seconds):
        """格式化时间：10秒内保留1位小数，超过则取整；超过1分钟显示为分+秒"""
        if seconds < 10:
            return f"{seconds:.1f}秒"
        seconds = int(seconds)
        if seconds < 60:
            return f"{seconds}秒"
        m, s = divmod(seconds, 60)
        if m >= 60:
            h, m = divmod(m, 60)
            return f"{h}小时{m}分{s}秒"
        return f"{m}分{s}秒"


def format_vram(num_bytes):
    """把字节数格式化成人类可读的单位"""
    if not num_bytes or num_bytes <= 0:
        return "0"
    value = float(num_bytes)
    for unit in ("KB", "MB", "GB"):
        value /= 1024.0
        if value < 1024.0:
            return f"{value:.1f}{unit}"
    return f"{value:.1f}TB"


# 初始化全局实例
profiler = ExecutionProfiler()


def _handle_execute_completion(class_type, prompt_id, server_obj, unique_id):
    """处理节点执行完成后的数据统计与发送"""
    try:
        start_time = profiler.pop_node_start(prompt_id, unique_id)
        if start_time:
            end_time = time.perf_counter()
            execution_time = end_time - start_time
            cumulative_time = profiler.total_elapsed(prompt_id)
            vram_used = profiler.get_peak_vram_diff(prompt_id, unique_id)
            time_str = profiler.format_time(execution_time)
            cumulative_str = profiler.format_time(cumulative_time)

            if server_obj:
                try:
                    client_id = getattr(server_obj, 'client_id', None)
                    if client_id is not None:
                        server_obj.send_sync(
                            "Banzhang-DevUtils.ExecutionTime.executed",
                            {
                                "node": unique_id,
                                "prompt_id": prompt_id,
                                "class_type": class_type,
                                "execution_time": int(execution_time * 1000),
                                "formatted_time": time_str,
                                "cumulative_time": int(cumulative_time * 1000),
                                "formatted_cumulative_time": cumulative_str,
                                "vram_used": vram_used
                            },
                            client_id
                        )
                except Exception as e:
                    logger.warning(f"发送同步数据出错: {e}")

            vram_str = f" - 显存 {format_vram(vram_used)}" if vram_used else ""
            print(f"#{unique_id} [{class_type}]: {time_str} (累计{cumulative_str}){vram_str}")
    except Exception as e:
        logger.error(f"handle_execute_completion 出错: {e}")


# ==============================================================================
# 执行上下文提取 (兼容不同版本ComfyUI)
# ==============================================================================

def _extract_execution_context(args, kwargs):
    """
    智能提取执行上下文，兼容不同版本的ComfyUI execute签名
    返回: server_obj, unique_id, prompt_id, dynprompt
    """
    server_obj = None
    unique_id = None
    prompt_id = kwargs.get('prompt_id', '')
    # 新版 ComfyUI 为位置参数: execute(server, dynprompt, caches, current_item,
    # extra_data, executed, prompt_id, ...)
    if not prompt_id and len(args) > 6 and isinstance(args[6], str):
        prompt_id = args[6]
    dynprompt = None

    # 1. 尝试从 kwargs 获取
    if 'server' in kwargs:
        server_obj = kwargs['server']
    if 'current_item' in kwargs:
        unique_id = kwargs['current_item']
    if 'dynprompt' in kwargs:
        dynprompt = kwargs['dynprompt']

    # 2. 从 args 推断
    if server_obj is None and len(args) > 0:
        if hasattr(args[0], 'client_id') and hasattr(args[0], 'send_sync'):
            server_obj = args[0]

    if unique_id is None and len(args) > 3:
        potential_id = args[3]
        if isinstance(potential_id, (str, int)):
            unique_id = potential_id

    if dynprompt is None and len(args) > 1:
        if hasattr(args[1], 'get_node'):
            dynprompt = args[1]

    return server_obj, unique_id, prompt_id, dynprompt


# ==============================================================================
# 装饰 execute 函数 (添加执行时间统计)
# ==============================================================================

def _patch_execution_execute():
    """包装 execution.execute 以添加时间统计"""
    try:
        origin_execute = execution.execute

        async def _banzhang_dev_utils_execute_wrapper(*args, **kwargs):
            server_obj, unique_id, prompt_id, dynprompt = _extract_execution_context(args, kwargs)
            class_type = None

            if unique_id:
                try:
                    if dynprompt:
                        node_info = dynprompt.get_node(unique_id)
                        if node_info:
                            class_type = node_info.get('class_type')
                except Exception:
                    pass

            # 执行原始逻辑
            if inspect.iscoroutinefunction(origin_execute):
                result = await origin_execute(*args, **kwargs)
            else:
                result = origin_execute(*args, **kwargs)

            # 后处理：统计时间
            if unique_id and class_type and server_obj:
                _handle_execute_completion(class_type, prompt_id, server_obj, unique_id)

            return result

        execution.execute = _banzhang_dev_utils_execute_wrapper
        logger.info("[班长开发工具] 已成功挂载 execution.execute 计时钩子")
    except Exception as e:
        logger.error(f"[班长开发工具] 挂载 execution.execute 失败: {e}")


# ==============================================================================
# 装饰 send_sync 方法 (捕获开始时间和节点事件)
# ==============================================================================

def _patch_send_sync():
    """包装 server.PromptServer.send_sync 以捕获执行事件"""
    try:
        origin_send_sync = server.PromptServer.send_sync

        def _banzhang_dev_utils_send_sync_wrapper(self, event, data, sid=None):
            try:
                if event == "execution_start":
                    prompt_id = data.get("prompt_id", "") if isinstance(data, dict) else ""
                    profiler.reset(prompt_id)
                    logger.debug("执行开始，剖析器已重置")

                elif event == "executing" and data:
                    node_id = None
                    prompt_id = ""
                    if isinstance(data, dict):
                        node_id = data.get("node")
                        prompt_id = data.get("prompt_id", "")
                    elif isinstance(data, (str, int)):
                        node_id = data

                    if node_id is None:
                        # 整个 workflow 执行结束
                        if sid is not None:
                            total_time = profiler.total_elapsed(prompt_id)
                            if total_time > 0:
                                new_data = {}
                                if isinstance(data, dict):
                                    new_data = data.copy()
                                new_data['execution_time'] = int(total_time * 1000)
                                new_data['formatted_time'] = profiler.format_time(total_time)

                                try:
                                    origin_send_sync(
                                        self,
                                        "Banzhang-DevUtils.ExecutionTime.execution_end",
                                        new_data,
                                        sid
                                    )
                                    logger.debug(f"发送执行结束事件: {total_time:.2f}s")
                                except Exception as e:
                                    logger.warning(f"发送执行结束事件出错: {e}")
                            profiler.drop(prompt_id)
                    else:
                        # 单个节点开始执行
                        profiler.start_node(prompt_id, node_id)
                        logger.debug(f"开始剖析节点: {node_id}")

                elif event in ("execution_interrupted", "execution_error"):
                    prompt_id = data.get("prompt_id", "") if isinstance(data, dict) else ""
                    profiler.drop(prompt_id)
            except Exception as e:
                logger.warning(f"send_sync 钩子出错: {e}")

            # 调用原始方法
            return origin_send_sync(self, event=event, data=data, sid=sid)

        server.PromptServer.send_sync = _banzhang_dev_utils_send_sync_wrapper
        logger.info("[班长开发工具] 已成功挂载 send_sync 事件钩子")
    except Exception as e:
        logger.error(f"[班长开发工具] 挂载 send_sync 失败: {e}")


# ==============================================================================
# 执行钩子挂载
# ==============================================================================

# 全局标志，确保只挂载一次
_EXECUTION_HOOKS_INSTALLED = False


def _install_all_hooks():
    """安装所有执行钩子 (只执行一次)"""
    global _EXECUTION_HOOKS_INSTALLED
    if _EXECUTION_HOOKS_INSTALLED:
        return
    _EXECUTION_HOOKS_INSTALLED = True

    try:
        _patch_execution_execute()
        _patch_send_sync()
        logger.info("[班长开发工具] 所有钩子已安装完成")
    except Exception as e:
        logger.error(f"[班长开发工具] 安装钩子时出错: {e}")


# ==============================================================================
# 节点映射
# ==============================================================================

NODE_CLASS_MAPPINGS = {
    "BZ_ExecutionTime": ExecutionTime,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BZ_ExecutionTime": "⏱️ 执行时间统计",
}

# 模块导入时自动安装钩子
_install_all_hooks()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
