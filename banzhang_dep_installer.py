# -*- coding: utf-8 -*-
"""通用 pip 依赖自动安装器：本地 wheels/ 离线包优先，联网源兜底。

用途：某些节点（如 Qwen3VL 的 GGUF 本地推理、RTX 视频特效）缺一个 pip 包就
用不了。别的用户拿到插件包后，首次启动 ComfyUI 会自动把依赖装好，不需要手敲命令；
把预编译 wheel 放进插件目录 wheels/ 后，连断网/内网也能装。

安装顺序（见 ensure_pip_package）：
    1) 本地 wheel（连同依赖一起装，绝大多数人的环境）
    2) 本地 wheel（--no-deps，纯离线兜底，依赖本机已有）
    3) 在线 pip 安装（可带专属 --extra-index-url）
    4) 公共源（当前环境配置的镜像，国内镜像通常可用）

设环境变量 BANZHANG_NO_AUTO_PIP=1 可关闭一切自动安装。
"""
import glob
import os
import subprocess
import sys
from importlib import import_module, invalidate_caches

_NO_AUTO_PIP_ENV = "BANZHANG_NO_AUTO_PIP"
_DEFAULT_TIMEOUT = 1800  # 30 分钟：带 CUDA 的 wheel 可能上百 MB，慢网给够时间

# 本文件位于插件根目录，wheels/ 与本文件同级
PACK_ROOT = os.path.dirname(os.path.abspath(__file__))
WHEELS_DIR = os.path.join(PACK_ROOT, "wheels")


def _auto_pip_disabled() -> bool:
    return str(os.environ.get(_NO_AUTO_PIP_ENV, "")).strip().lower() in (
        "1", "true", "yes", "on")


def local_wheels(pattern: str) -> list:
    """列出 wheels/ 目录里符合通配符的离线 wheel（文件名排序，版本号大的优先）。"""
    return sorted(glob.glob(os.path.join(WHEELS_DIR, pattern)), reverse=True)


def _run_pip(args: list, timeout: int = _DEFAULT_TIMEOUT) -> tuple:
    """执行 pip install，返回 (是否成功, 输出尾部)。"""
    cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir"] + args
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # pip 都没跑起来（权限/杀毒拦截等）
        return False, f"pip 启动失败：{exc}"
    tail = (result.stdout or "") + (result.stderr or "")
    return result.returncode == 0, tail[-1200:]


def _preimport(names) -> None:
    """先导入前置模块（如 torch）。

    CUDA 版 llama-cpp 的 llama.dll 依赖 torch 进程里已加载的 CUDA DLL（cudart/
    cublas 等），不先 import torch 会报“找不到 llama.dll（或其依赖）”；
    ComfyUI 里 torch 本来就先加载，这里只是把独立验证场景也补齐。
    """
    for name in names or ():
        try:
            import_module(name)
        except Exception:
            pass


def ensure_pip_package(import_name: str, pip_name: str, wheel_pattern: str,
                       *, extra_index: str = None, label: str = "",
                       preimport=(), timeout: int = _DEFAULT_TIMEOUT,
                       force: bool = False) -> tuple:
    """确保某个 pip 依赖可导入；缺失就自动安装。

    参数：
        import_name    : import 时的模块名（如 llama_cpp_python 包的模块名是 llama_cpp）
        pip_name       : pip 安装名（如 llama-cpp-python）
        wheel_pattern  : wheels/ 里离线 wheel 的通配符（如 llama_cpp_python-*.whl）
        extra_index    : 真 wheel 专属索引（如 NVIDIA 的 https://pypi.nvidia.com）
        label          : 控制台提示里给人看的中文名称
        preimport      : 验证导入前先导入的模块（CUDA 原生包需要先 import torch）

    返回 (bool, module|None)。已经能导入会立刻返回，绝不重装正在用的包。

    force=True 跳过「已经能导入」这道早退，无条件装一遍。为什么需要它：包能
    import ≠ 版本对 —— comfy-aimdo 0.5.6 能正常 import，但它的 ModelVBAR 收不下
    核心新传的 pageout_callback，按「能导入就放行」判会一律放过，故障照旧。
    """
    # 1) 已经能用
    _preimport(preimport)
    if not force:
        try:
            return True, import_module(import_name)
        except Exception:
            pass

    if _auto_pip_disabled():
        print(f"[班长全家桶] 已设 {_NO_AUTO_PIP_ENV}=1，跳过自动安装 {pip_name}。")
        return False, None

    display = label or pip_name
    print(f"[班长全家桶] 首次启用 {display}，正在自动安装依赖 {pip_name}"
          f"（体积可能较大，需要几分钟，只此一次）...")

    # 2) 组装安装尝试：本地 wheel 两条（带依赖 / 不依赖），再在线
    attempts = []
    for wheel in local_wheels(wheel_pattern):
        base = os.path.basename(wheel)
        attempts.append((f"离线 wheel（连同依赖）：{base}", [wheel]))
        attempts.append((f"离线 wheel（纯离线，不装依赖）：{base}",
                         ["--no-deps", wheel]))

    if extra_index:
        attempts.append((f"在线安装（专属源 {extra_index}）",
                         [pip_name, "--extra-index-url", extra_index]))
        attempts.append(("在线安装（当前环境配置的公共源）", [pip_name]))
    else:
        attempts.append(("在线安装（当前环境配置的源）", [pip_name]))

    last_tail = ""
    for name, args in attempts:
        print(f"[班长全家桶] 尝试安装途径：{name}")
        ok, tail = _run_pip(args, timeout=timeout)
        last_tail = tail
        if not ok:
            print(f"[班长全家桶] 该途径失败：{tail[-400:]}")
            continue
        invalidate_caches()
        _preimport(preimport)
        try:
            module = import_module(import_name)
            print(f"[班长全家桶] {display} 依赖装好了（{name}），可以使用。")
            return True, module
        except Exception as exc:
            print(f"[班长全家桶] 装完了但仍然无法导入 {import_name}：{exc}")

    print(f"[班长全家桶] {display} 依赖自动安装失败：\n{last_tail}")
    hint = f"{sys.executable} -m pip install {pip_name}"
    if extra_index:
        hint += f" --extra-index-url {extra_index}"
    print(f"[班长全家桶] 可手动执行：{hint}")
    print(f"[班长全家桶] 也可把 {wheel_pattern} 对应的 .whl 放进：{WHEELS_DIR}")
    return False, None
