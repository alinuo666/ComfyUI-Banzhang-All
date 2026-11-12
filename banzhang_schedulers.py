# -*- coding: utf-8 -*-
"""
班长内置调度器（移植自 RES4LYF，MIT）
================================================================================
把 bong_tangent / beta57 两个调度器直接做进本包，用户不必再装 RES4LYF。
注册走 ComfyUI 官方扩展点 SCHEDULER_HANDLERS + SCHEDULER_NAMES，
注册后所有节点的「调度器」下拉（含原生 KSampler）都能选到。

为什么单独一个文件（20261101）：
  调度器名与 handler 是两份注册表。第三方包只要有一边没写进去，
  下拉里能选、运行时必抛 `error invalid scheduler xxx`
  （实测：用户机器上 bong_tangent 在列表里、handler 不在，三采直接崩）。
  所以本文件的 install() 只允许「成对写入」，并会把「只有名字没 handler」
  的坏状态就地补好——这是根因，不是兜底。

⚠ bong_tangent 输出的是 0~1 归一化 sigma，不乘模型的 sigma 上限。
  sigma 上限就是 1.0 的蒸馏模型（H3 四步档）正好；
  Flux / SDXL 那种上限十几的模型选它等于几乎不去噪。照搬上游语义，不做自适应。
================================================================================
"""
import math

import torch


def _bong_tangent_stage(steps, slope, pivot, start, end):
    """单段 tan 曲线：把 atan 的 S 形摊到 [start, end] 上，逐位照搬上游。"""
    top = ((2 / math.pi) * math.atan(-slope * (0 - pivot)) + 1) / 2
    bottom = ((2 / math.pi) * math.atan(-slope * ((steps - 1) - pivot)) + 1) / 2
    span = top - bottom
    scale = start - end
    return [((((2 / math.pi) * math.atan(-slope * (x - pivot)) + 1) / 2) - bottom)
            * (1 / span) * scale + end
            for x in range(steps)]


def bong_tangent_scheduler(model_sampling, steps, start=1.0, middle=0.5, end=0.0,
                           pivot_1=0.6, pivot_2=0.6, slope_1=0.2, slope_2=0.2,
                           pad=False):
    """双段 tan 调度：前段 1.0→0.5、后段 0.5→0.0，中段密度最高。

    steps 要先 +2 再分段：两段各去掉一个接缝点后合计 steps+1 个，
    正好是 ComfyUI 要求的 n+1 个 sigma。
    """
    steps += 2
    midpoint = int((steps * pivot_1 + steps * pivot_2) / 2)
    pivot_1 = int(steps * pivot_1)
    pivot_2 = int(steps * pivot_2)
    # 斜率按步数归一：固定 0.2 在 40 步附近最匀，步数少时曲线要跟着变陡
    slope_1 = slope_1 / (steps / 40)
    slope_2 = slope_2 / (steps / 40)

    stage_2_len = steps - midpoint
    stage_1_len = steps - stage_2_len
    tan_sigmas_1 = _bong_tangent_stage(stage_1_len, slope_1, pivot_1, start, middle)
    tan_sigmas_2 = _bong_tangent_stage(stage_2_len, slope_2, pivot_2 - stage_1_len, middle, end)
    tan_sigmas_1 = tan_sigmas_1[:-1]
    if pad:
        tan_sigmas_2 = tan_sigmas_2 + [0]
    return torch.tensor(tan_sigmas_1 + tan_sigmas_2)


def beta57_scheduler(model_sampling, steps):
    """beta 分布固定参数档：alpha=0.5 / beta=0.7（上游叫 beta57）。"""
    import comfy.samplers
    return comfy.samplers.beta_scheduler(model_sampling, steps, alpha=0.5, beta=0.7)


_BUILTIN = {
    "bong_tangent": bong_tangent_scheduler,
    "beta57": beta57_scheduler,
}


def install():
    """幂等注册。返回 (本次新增, 环境里已有)。"""
    try:
        from comfy.samplers import SCHEDULER_HANDLERS, SCHEDULER_NAMES, SchedulerHandler
    except Exception:
        print("⚠️ [班长调度器] 当前 ComfyUI 没有可扩展的调度器注册表（版本过旧），"
              "跳过内置调度器；请直接用 simple / beta 等原生项。")
        return [], []

    added, existed = [], []
    for name, handler in _BUILTIN.items():
        try:
            if name in SCHEDULER_HANDLERS:
                existed.append(name)
            else:
                SCHEDULER_HANDLERS[name] = SchedulerHandler(handler=handler, use_ms=True)
                added.append(name)
            # handler 可能早就被别的插件注册了，但名字没进列表 —— 这里补齐，
            # 否则下拉里永远看不到；反过来也必须补，两份注册表要一致。
            if name not in SCHEDULER_NAMES:
                SCHEDULER_NAMES.append(name)
        except Exception as exc:
            print(f"⚠️ [班长调度器] {name} 注册失败，已跳过：{exc}")

    if added:
        print(f"[班长调度器] 已内置：{', '.join(added)}")
    if existed:
        print(f"[班长调度器] 环境里已有（沿用原实现，不覆盖）：{', '.join(existed)}")
    return added, existed


def schedulers():
    """下拉可选项 —— 只给「真的能算出 sigma」的名字。

    为什么不用 KSampler.SCHEDULERS：那是全局可变 list，任何第三方包都能 append。
    只有 SCHEDULER_HANDLERS 里的名字 calculate_sigmas() 才认。
    用前者做选项，就等于允许用户选到一个运行时必崩的值。
    """
    try:
        from comfy.samplers import SCHEDULER_HANDLERS
        return list(SCHEDULER_HANDLERS)
    except Exception:
        import comfy.samplers
        return list(getattr(comfy.samplers.KSampler, "SCHEDULERS", None) or ["simple"])


def resolve(name):
    """把界面上的名字换成当前环境真能算的那个；算不了就回退并说明原因。

    保留这条是因为老工作流里可能已经存了脏值（名字来自装了插件的旧实例）。
    直接抛异常会让人对着英文 invalid scheduler 无从下手。
    """
    names = schedulers()
    if name in names:
        return name
    fallback = "simple" if "simple" in names else (names[0] if names else "normal")
    print(f"[班长调度器] ⚠ 调度器「{name}」在当前环境算不出 sigma"
          f"（没有注册 handler），本次改用「{fallback}」。\n"
          f"        要用它就把提供它的插件装回来，或在节点下拉里换一个。")
    return fallback
