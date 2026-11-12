# -*- coding: utf-8 -*-
"""启动期兼容守卫：核心与本机 comfy-aimdo 接口对不上就自动补装。

20261028 事故（用户实报）：
    TypeError: ModelVBAR.__init__() got an unexpected keyword argument 'pageout_callback'
ComfyUI 0.43 的 ModelPatcherDynamic._vbar_get 建 VBAR 时多传了一个
pageout_callback；而便携版用户升级 ComfyUI 主目录不会跟着升 pip 依赖，
机上 comfy-aimdo 还是 0.5.6，其 ModelVBAR.__init__(size, device) 收不下这个
参数。于是**任何**加载大模型的节点都会炸，第一个炸的总是导演台（它最先载入
15GB 文本编码器），看起来像插件坏了。实际与插件无关。

判据刻意不用版本号，而是让两份代码直接对撞：核心源码里有 pageout_callback=、
本机签名里却没有 → 才动手。用版本号会在「装了 0.6.0 但核心还是 0.42」上误报，
而那种组合实测是好的（0.6.0 只多一个带默认值的参数 + 多一个 close()，一个
方法都没删），真按版本号拦下来等于凭空制造故障。

为什么只能「装完让用户重启」：ComfyUI 核心在 main.py 阶段就已经 import 过
comfy_aimdo，早于 custom_nodes 加载 —— 替换磁盘上的 .pyd 不可能让当前进程
生效，也不可能在内存里改掉已实例化的类。同步装 + 一次重启换「一次跑通」，
比「不卡但白跑一轮、重启两次」划算。
"""
import inspect
import os
import re

_MARK = "pageout_callback"
_PKG = "comfy-aimdo"


def _comfy_root():
    """ComfyUI 根目录：插件在 custom_nodes/<包名>/，往上三层。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _core_wants_callback():
    """核心建 VBAR 时会不会传 pageout_callback。

    读不到源码（老核心没有 ModelPatcherDynamic / 没有 _vbar_get）就返回 False：
    没有这项调用，也就没有这项故障，不该拦。
    """
    try:
        from comfy.model_patcher import ModelPatcherDynamic
        return _MARK in inspect.getsource(ModelPatcherDynamic._vbar_get)
    except Exception:
        return False


def _vbar_accepts_callback():
    """本机 comfy-aimdo 的 ModelVBAR 收不收这个参数。

    包本身 import 不了就返回 True（缺包是另一类问题，由 ComfyUI 的依赖清单管，
    这里不越权代劳）。
    """
    try:
        from comfy_aimdo.model_vbar import ModelVBAR
    except Exception:
        return True
    try:
        return _MARK in inspect.signature(ModelVBAR.__init__).parameters
    except Exception:
        return True


def _pinned_spec():
    """核心要求的版本：读 ComfyUI/requirements.txt 里 comfy-aimdo==X 那一行。

    不硬编码版本 —— 以后核心再升级，这里跟着走，不需要改插件。
    读不到就退回 >=0.6.0（pageout_callback 在 0.6.0 引入）。
    """
    root = _comfy_root()
    req = os.path.join(root, "requirements.txt")
    try:
        with open(req, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = re.match(r"^\s*%s\s*==\s*([0-9][^\s#;]*)" % _PKG, line)
                if m:
                    return "%s==%s" % (_PKG, m.group(1))
    except Exception:
        pass
    return "%s>=0.6.0" % _PKG


def ensure_aimdo_compatible():
    """不兼容就同步补装，返回 True 表示无需动作或已装好（待重启生效）。"""
    if not _core_wants_callback() or _vbar_accepts_callback():
        return True

    spec = _pinned_spec()
    ver = spec.split("==")[-1]
    print("=" * 60)
    print("⚠ comfy-aimdo 版本过旧：ComfyUI 本体已经要求新的显存分页接口，"
          "而本机装的还是旧版。")
    print("   现象：加载任何大模型都会报 "
          "ModelVBAR.__init__() got an unexpected keyword argument "
          "'pageout_callback'")
    print("   （与班长插件无关，是 ComfyUI 升级后 pip 依赖没跟上。）")
    print("   正在自动补装 %s …… 体积很小，几秒就好" % spec)

    ok = False
    try:
        from .banzhang_dep_installer import ensure_pip_package
        ok, _ = ensure_pip_package(
            "comfy_aimdo", spec,
            # 只认这个版本的离线轮子：wheels/ 里若没有该版本，glob 空掉、
            # 直接走在线，不会把旧轮子硬装上去反而更糟。
            "comfy_aimdo-%s-*.whl" % ver,
            label="显存动态分页 (comfy-aimdo)",
            force=True,          # 包能 import ≠ 版本对，必须跳过「已导入」早退
            timeout=600)
    except Exception as exc:
        print("   自动补装没能跑起来：%s: %s" % (type(exc).__name__, exc))

    if ok:
        print("   ✅ 已装好 %s —— **请关闭这个黑窗口，重新启动 ComfyUI**（本次进程"
              "已加载旧版，热替换无效）。重启后就正常了。" % spec)
    else:
        print("   ❌ 自动补装失败（可能是断网 / 权限 / 杀毒拦截）。手动执行这一条：")
        print("      %s -m pip install %s" % (
            os.path.join(_comfy_root(), "..", "python_embeded", "python.exe"),
            spec))
        print("   或者把 %s 的 .whl 放进插件的 wheels\\ 目录后重启。" % _PKG)
    print("=" * 60)
    return ok
