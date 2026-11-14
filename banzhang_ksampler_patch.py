# -*- coding: utf-8 -*-
"""
👨‍🏫 班长 KSampler Sigmas 补丁
本版 ComfyUI 内置 KSampler 被精简掉了 sigmas 支持（无 sigmas 端口、sample 不收 sigmas 参数）。
此模块在加载时 monkey-patch 内置 KSampler / common_ksampler，恢复 sigmas 输入端口。
不修改 ComfyUI 任何核心文件；删除本模块即可完全还原。
"""

import logging

import torch

import comfy.nested_tensor
import comfy.sample
import comfy.utils
import latent_preview
import nodes


def _stream_list(x):
    """把 H3 的联合潜空间拆成各条流（画面在前、声音在后）。"""
    if x is None:
        return ()
    try:
        if getattr(x, "is_nested", False):
            return tuple(x.unbind())
        if hasattr(x, "tensors"):
            return tuple(x.tensors)
    except Exception:
        pass
    return (x,)


def _copy_pinned(dst, src, head, tail, tag="H3 尾帧回填"):
    """把头 / 尾各若干**帧**从 src 拷进 dst，并在交界处羽化。

    返回 (新的流列表, 回填格数, 羽化格数)。纯张量操作，不碰采样器 —— 这正是
    方案二「永远成立」的原因，也是要把它和遮罩分开的原因：遮罩管模型怎么走，
    这一道只管边界帧到底变没变。

    head / tail 是**帧**，不是步。20261027 前这里直接拿帧当步用：填 22 帧实际
    拷掉 22 步 = 73 帧，重抽成果被旧版盖掉一半，交界位置也整个后移 3 倍。
    换算走 pin_extent，与「🧷 H3 尾帧回填」节点同一份实现。
    """
    from .nodes.banzhang_h3_pin import (PIN_FEATHER, blend_edge, pin_extent,
                                  pin_feather_weights)

    copied, feathered, streams = 0, 0, []
    n_video_steps = int(dst[0].shape[2]) if dst and dst[0].dim() == 5 else 0
    for i, d in enumerate(dst):
        d = d.clone()
        if i < len(src) and tuple(src[i].shape) == tuple(d.shape):
            ax = 2 if d.dim() == 5 else -1
            total = int(d.shape[ax])
            h, t = pin_extent(head, tail, d, n_video_steps, d.dim() == 5)
            # 羽化只能落在头尾回填之间的缝里；缝比羽化窗还窄就整块放弃
            fw = min(PIN_FEATHER, max(0, total - h - t))
            if h:
                idx = torch.arange(h, device=d.device)
                d.index_copy_(ax, idx, src[i].index_select(ax, idx).to(d.dtype))
                if fw:
                    feathered += blend_edge(d, src[i], ax, h,
                                            pin_feather_weights(fw, True))
            if t:
                idx = torch.arange(total - t, total, device=d.device)
                d.index_copy_(ax, idx, src[i].index_select(ax, idx).to(d.dtype))
                if fw:
                    feathered += blend_edge(d, src[i], ax, total - t - fw,
                                            pin_feather_weights(fw, False))
            copied += h + t
        elif i < len(src):
            # 尺寸不符必须喊出来：静默跳过最坑 —— 用户以为钉住了，
            # 实际一帧没动，后面各段照样全变。
            print("⚠️ [%s] 第 %d 条流：参考 %s 与输出 %s 网格不一致，跳过。"
                  % (tag, i + 1, tuple(src[i].shape), tuple(d.shape)))
        streams.append(d)
    return streams, copied, feathered


def _restore_pinned_tail(out, tag="H3 尾帧回填"):
    """方案二：采样跑完，把钉死的头 / 尾帧从本段旧版潜空间原样拷回去。

    为什么非要有这一道：遮罩那一路（方案一）靠采样器原样收下 noise_mask，
    而 SelfLift 这类中途换 latent 网格的补丁会让遮罩的参照物失效 —— 那一路
    只能算 best effort。可是「重抽这一段，后面各段就不用重跑」依赖的是尾帧
    **逐位**不变，这件事只有纯张量拷贝能保证。

    只在潜空间里带了 bz_pin（导演台重抽已有段时登记）才动手 ——
    别的图一行都不会因此改变。
    """
    spec = out.get("bz_pin")
    if not spec:
        return
    out.pop("bz_pin", None)      # 别把一个几 MB 的引用一路带到解码端
    try:
        head = max(0, int(spec.get("head") or 0))
        tail = max(0, int(spec.get("tail") or 0))
        if head <= 0 and tail <= 0:
            return
        from .nodes.csglide_clip import CSGlideClipLoadCS
        ref, _info = CSGlideClipLoadCS().load(
            片名=spec.get("name") or "", 段落=spec.get("cid") or "", 版本=0,
            没有档案时="直通（不回填）")
        if not ref or ref.get("bz_empty") or ref.get("samples") is None:
            print("[%s] 本段还没有旧版潜空间 —— 本次跳过，下次重抽再用它。" % tag)
            return
        dst = _stream_list(out.get("samples"))
        src = _stream_list(ref.get("samples"))
        if not dst:
            return
        streams, copied, feathered = _copy_pinned(dst, src, head, tail, tag)
        if copied:
            out["samples"] = (streams[0] if len(streams) == 1
                              else comfy.nested_tensor.NestedTensor(streams))
            print("[%s] 已从本段旧版回填 %d 格（头 %d 帧 / 尾 %d 帧换算而来，"
                  "画面一格 = 1 步）＋交界羽化 %d 格 —— 这一段重抽不会牵连后面各段。"
                  % (tag, copied, head, tail, feathered))
        else:
            # 静默失败是最坑的：用户以为钉住了，实际一帧没回去，后面各段的
            # 引导头全对不上，接缝必跳 —— 而且没人告诉他为什么。
            print("⚠️ [%s] **一帧都没回填**（头 %d / 尾 %d）—— 本段尾部是新的，"
                  "后面各段的引导头对不上，接缝会跳，它们要跟着重跑。\n"
                  "  常见原因：① 参考与输出网格不一致（🎯 H3 放大采样器会把网格"
                  "放大 1.5× —— 改用官方 KSampler，它按输入网格重打包，尺寸不变）；"
                  "② 本段还没有旧版潜空间（首次生成）。" % (tag, head, tail))
    except Exception as e:
        print("⚠️ [%s] 跳过：%s: %s" % (tag, type(e).__name__, e))


def _apply_patch():
    # ---------- 1. INPUT_TYPES：添加 optional sigmas 端口 ----------
    try:
        orig_input = nodes.KSampler.INPUT_TYPES.__func__

        def _patched_input(cls):
            t = orig_input(cls)
            if "sigmas" not in t.get("optional", {}):
                t.setdefault("optional", {})["sigmas"] = ("SIGMAS",)
            return t

        nodes.KSampler.INPUT_TYPES = classmethod(_patched_input)
    except Exception as e:
        logging.warning(f"[班长全家桶] KSampler.INPUT_TYPES 补丁失败: {e}")

    # ---------- 2. common_ksampler：透传 sigmas 到底层采样 ----------
    try:
        def _patched_common_ksampler(model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent,
                                     denoise=1.0, disable_noise=False, start_step=None, last_step=None,
                                     force_full_denoise=False, sigmas=None):
            latent_image = latent["samples"]
            latent_image = comfy.sample.fix_empty_latent_channels(model, latent_image, latent.get("downscale_ratio_spacial", None), latent.get("downscale_ratio_temporal", None))

            if disable_noise:
                noise = comfy.sample.prepare_empty_noise(latent_image)
            else:
                batch_inds = latent["batch_index"] if "batch_index" in latent else None
                noise = comfy.sample.prepare_noise(latent_image, seed, batch_inds)

            noise_mask = None
            if "noise_mask" in latent:
                noise_mask = latent["noise_mask"]

            callback = latent_preview.prepare_callback(model, steps)
            disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
            samples = comfy.sample.sample(model, noise, steps, cfg, sampler_name, scheduler, positive, negative, latent_image,
                                          denoise=denoise, disable_noise=disable_noise, start_step=start_step, last_step=last_step,
                                          force_full_denoise=force_full_denoise, noise_mask=noise_mask, callback=callback,
                                          disable_pbar=disable_pbar, seed=seed, sigmas=sigmas)
            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out.pop("downscale_ratio_temporal", None)
            out["samples"] = samples
            _restore_pinned_tail(out)
            return (out,)

        nodes.common_ksampler = _patched_common_ksampler
    except Exception as e:
        logging.warning(f"[班长全家桶] common_ksampler 补丁失败: {e}")

    # ---------- 3. KSampler.sample：接收 sigmas 并透传 ----------
    try:
        def _patched_sample(self, model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent_image,
                            denoise=1.0, sigmas=None):
            return nodes.common_ksampler(model, seed, steps, cfg, sampler_name, scheduler, positive, negative,
                                         latent_image, denoise=denoise, sigmas=sigmas)

        nodes.KSampler.sample = _patched_sample
    except Exception as e:
        logging.warning(f"[班长全家桶] KSampler.sample 补丁失败: {e}")


_apply_patch()
print("✅ [班长全家桶] 内置 KSampler 已恢复 sigmas 输入端口")
