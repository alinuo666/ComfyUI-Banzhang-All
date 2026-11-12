# -*- coding: utf-8 -*-
"""
👨‍🏫 班长的小课堂：多 LoRA 管理器 (实时融合 · 多 LoRA 版 v2.2)
================================================================================
作用：
    一个节点管理多个 LoRA（最多 10 个），等价于把多个 ComfyUI 原生
    「仅模型 LoRA 加载器(LoraLoaderModelOnly)」串在一起，但集中在一个
    面板里，逐行开关/调强度/写备注，并逐条诊断。

加载机制（与原生完全一致）：
    comfy.sd 原生 patch 路径 -> model.clone() + add_patches()
    只保存低秩增量(rank×in / out×rank)，前向时逐层临时叠加 base+delta，
    不生成、也不常驻完整权重副本，显存占用与原生 LoRA 完全相同。

注意：本节点只改 DiT/UNet（画面部分），不加载 text encoder（文字理解）。
    若 LoRA 含 lora_te* / text_encoder* 权重，会丢弃并在诊断中告警。
    对 MiniMax-H3 视频模型：画面 LoRA 均训练在 DiT 上，此行为完全正确。

v2.1 多 LoRA 支持（由前端 JS 扩展 js/banzhang_lora_loader.js 驱动）：
    - 「＋ 添加 LoRA」按钮动态新增行，最多 10 个；
    - 每行：启用勾选(最左) | LoRA 选择(Filter 搜索 + 文件夹树弹层) | 强度 | 备注 | 删除；
    - 整个面板序列化为 JSON 字符串从「LoRA配置」输入传入。

v2.2 严格模式 + 优化：
    - 任何 LoRA 加载失败（文件找不到 / 融合报错 / 与模型不匹配）都会立即
      抛出异常，不再静默跳过；
    - 融合流程合并为一次全模型扫描（原来预检+加载扫两遍）；
    - 读盘结果缓存，同一 LoRA 不反复读硬盘。

v2.3 MiniMax-H3 官方 LoRA 支持：
    - H3 官方发布的 LoRA 是 diffusers 分离命名（transformer_blocks.N.attn.to_q /
      token_refiner.refiner_blocks.N.ff.net.0.proj），而 ComfyUI 的 H3 权重是融合
      命名（blocks.N.attn.qkv_proj / blocks.N.mlp.fc1），原始 key_map 命中数为 0。
      官方「仅模型 LoRA 加载器」遇到这种情况只刷 warning 然后静默跳过，看起来
      "能用"其实一个权重都没打上。
    - 现在按模型实际 key 自动补别名，qkv 三段用偏移量落到同一条 qkv_proj 上。
================================================================================
"""

import json

import comfy
import comfy.lora
import comfy.lora_convert
import comfy.model_base
import comfy.sd
import comfy.utils
import comfy.model_management
import folder_paths


# ------------------------------------------------------------------------------
# 工具函数
# ------------------------------------------------------------------------------
def _gb(n):
    """字节 -> GB 字符串"""
    try:
        return f"{n / (1024 ** 3):.2f} GB"
    except Exception:
        return "?"


# ComfyUI 的 H3 权重用融合命名，官方发布的 H3 LoRA 用 diffusers 分离命名。
# 后缀表：融合权重后缀 -> 同一个 block 下 diffusers 侧的分离模块名。
_H3_FUSED_SUFFIXES = (
    (".attn.qkv_proj", ("attn.to_q", "attn.to_k", "attn.to_v")),
    (".attn.out_proj", ("attn.to_out.0",)),
    (".mlp.fc1", ("ff.net.0.proj",)),
    (".mlp.fc2", ("ff.net.2",)),
)


def _h3_diffusers_names(name):
    """融合权重名（不含 .weight）-> (diffusers 侧模块名元组, 是否 qkv 融合)。

    ComfyUI 的 H3 权重是融合命名（blocks.N.attn.qkv_proj / blocks.N.mlp.fc1），
    官方发布的 H3 LoRA 是 diffusers 分离命名（transformer_blocks.N.attn.to_q /
    ff.net.0.proj）。两套名字毫无交集，官方加载器只会刷 warning 然后静默跳过，
    一个权重都不打。这里给出反向名字，供下面建别名用。
    """
    for fused_suffix, tails in _H3_FUSED_SUFFIXES:
        if not name.endswith(fused_suffix):
            continue
        module = name[:-len(fused_suffix)]
        if module.startswith("token_refiner.blocks."):
            stem = "token_refiner.refiner_blocks." + module[len("token_refiner.blocks."):]
        elif module.startswith("blocks."):
            stem = "transformer_blocks." + module[len("blocks."):]
        else:
            return (), False
        return tuple("{}.{}".format(stem, t) for t in tails), len(tails) == 3
    return (), False


def _add_h3_diffusers_aliases(model, key_map):
    """给 MiniMax-H3 的 key_map 补 diffusers 命名别名（原地改 key_map）。

    qkv 三个分离模块要落到同一条 qkv_proj 的三段上，用 (键, (维, 起, 长)) 的
    偏移形式表达 —— ComfyUI 的 add_patches 支持这种写法（上游给 Flux3 /
    MOSSImage 也是这么干的），三段互不覆盖，可以叠加。
    int8 底模安全：patch 时 convert_weight 先反量化成普通张量，narrow 是共享
    视图，加完增量由 set_weight 重新压回 int8，显存不涨。
    """
    if not isinstance(model, comfy.model_base.MiniMaxH3):
        return
    sdk = model.state_dict()
    for k in sdk:
        if not k.startswith("diffusion_model.") or not k.endswith(".weight"):
            continue
        names, fused_qkv = _h3_diffusers_names(k[len("diffusion_model."):-len(".weight")])
        if not names:
            continue
        if fused_qkv:
            seg = sdk[k].shape[0] // 3
            for i, name in enumerate(names):
                key_map[name] = (k, (0, i * seg, seg))
        else:
            key_map[names[0]] = k


def _apply_lora_to_model(model, lora_sd, strength):
    """把一个 LoRA 实时融合到模型（只改 DiT/UNet，不碰 text encoder）。

    复刻 comfy.sd.load_lora_for_models 的 model-only 分支（clip=None 时），
    一次扫描完成「key 映射 + 提取 patch + 打补丁」，返回 (新模型, 实际打上补丁的层数)。
    """
    key_map = comfy.lora.model_lora_keys_unet(model.model, {})
    _add_h3_diffusers_aliases(model.model, key_map)
    lora_sd = comfy.lora_convert.convert_lora(lora_sd)
    loaded = comfy.lora.load_lora(lora_sd, key_map)
    new_modelpatcher = model.clone()
    applied = new_modelpatcher.add_patches(loaded, strength)
    return new_modelpatcher, len(applied)


def _has_text_encoder_weights(lora_sd):
    """检测 LoRA 里是否含「文字理解(text encoder)」权重。

    本节点只改 DiT/UNet（clip=None），text encoder 权重会被丢弃。
    若 LoRA 带了这类权重（lora_te* / text_encoder* / text_encoders*），
    返回 True 用于告警，避免用户误以为完整加载了。
    """
    prefixes = ("lora_te", "text_encoder", "text_encoders")
    return any(k.startswith(prefixes) for k in lora_sd)


def _parse_config(LoRA配置):
    """解析前端传入的 LoRA 行 JSON -> [(文件, 强度, 备注), ...]"""
    try:
        rows = json.loads(LoRA配置) if isinstance(LoRA配置, str) else []
        if not isinstance(rows, list):
            rows = []
    except Exception:
        rows = []

    jobs = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        if not r.get("on", True):
            continue  # 未勾选启用
        file = str(r.get("file") or "").strip()
        # Windows 的 os.path.relpath 产出 "\"，统一归一成 "/"，
        # 保证工作流从 Windows 传到 Linux/Mac 也能解析（get_full_path 靠这个）。
        file = file.replace("\\", "/")
        if not file:
            continue  # 未选择文件
        try:
            strength = float(r.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        note = str(r.get("note") or "").strip()
        jobs.append((file, strength, note))
    return jobs


# ------------------------------------------------------------------------------
# NODE：多 LoRA 管理器（实时融合 · 多 LoRA，全中文面板）
# ------------------------------------------------------------------------------
class BanZhang_LoRA_VramSafe:
    def __init__(self):
        # 缓存已读盘的 LoRA 权重（path -> state_dict），避免同一 LoRA 反复读盘。
        # 只占 CPU 内存，不影响显存；与原生 LoraLoader 的 loaded_lora 同思路。
        self._lora_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        # 「模型」是唯一真正的输入端口（MODEL 是连线类型）。
        # LoRA配置 / LoRA文件 / 模型强度 都是 STRING 或 combo —— 在 ComfyUI
        # 前端它们是 widget（不是端口），由框架自动创建、自动序列化到
        # widgets_values、自动在 configure 时恢复 —— 这保证了「刷新/重开工作流
        # 不丢配置」。前端 js 只负责隐藏这些 widget 的 UI 并覆盖 serializeValue。
        return {
            "required": {
                "模型": ("MODEL",),
            },
            "optional": {
                # 兜底单 LoRA + 面板文件清单来源（combo 由后端填充，含子目录）
                "LoRA文件": (folder_paths.get_filename_list("loras"),),
                # 多 LoRA 面板序列化 JSON（前端扩展维护，勿手改）
                "LoRA配置": ("STRING", {
                    "default": "[]",
                    "tooltip": "多 LoRA 面板 JSON（启用/文件/强度/备注），由前端扩展维护，勿手改。"
                }),
                # 兜底强度：必须 STRING（空值 str() 不报错，避免 FLOAT 空值判 invalid）
                "模型强度": ("STRING", {
                    "default": "1.0",
                    "tooltip": "兜底用：LoRA配置 为空时按此强度加载单 LoRA。"
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "apply_lora"
    CATEGORY = "👨‍🏫班长/模型优化"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return "|".join(str(kwargs.get(key, "")) for key in
                        ("模型", "LoRA配置", "LoRA文件", "模型强度"))

    @classmethod
    def VALIDATE_INPUTS(cls, LoRA配置=None, LoRA文件=None):
        # 与 ComfyUI 原生 combo 一致：文件不存在 → 节点红框 + 报错文字，
        # 队列直接拦截，不会「没找到模型也继续跑」。
        # （LoRA文件 是 combo，其值可能是别人机器上的文件名，所以这里
        #   不做 combo 成员校验，只做存在性校验；真融合失败由 apply_lora 诊断。）
        files = []
        if isinstance(LoRA配置, str) and LoRA配置:
            try:
                rows = json.loads(LoRA配置)
            except Exception:
                rows = []
            if isinstance(rows, list):
                for r in rows:
                    if isinstance(r, dict) and r.get("on", True):
                        f = str(r.get("file") or "").strip().replace("\\", "/")
                        if f:
                            files.append(f)
        if not files and LoRA文件:
            f = str(LoRA文件).strip().replace("\\", "/")
            if f:
                files.append(f)
        for f in files:
            if folder_paths.get_full_path("loras", f) is None:
                return (
                    f"LoRA 文件未找到：{f}\n"
                    f"请确认已放入 models/loras 目录，且子目录层级、文件名（含大小写）与保存时一致。"
                )
        return True

    DESCRIPTION = """
👨‍🏫 班长的小课堂 - 多 LoRA 管理器（实时融合 · v2.2）
一个节点管理多个 LoRA，省去串联多个加载器的画布空间。

核心能力：
  1. 面板内「＋ 添加 LoRA」可挂多个 LoRA（最多 10 个），每行可单独
     勾选启用、调强度、写备注、删除；
  2. LoRA 选择器 = Filter 搜索 + 文件夹树弹层；
  3. 逐条诊断：每个 LoRA 是否生效、打了多少处补丁，一目了然；
  4. 严格模式：任何 LoRA 加载失败 / 与模型不匹配，立即报错停止，
     不再静默跳过。

重要说明（请务必读）：
  · 本节点等价于 ComfyUI 原生「仅模型 LoRA 加载器」——只改画面(DiT/UNet)，
    不加载「文字理解(text encoder)」部分。若 LoRA 带了文字理解权重，
    会丢弃并在诊断里告警。对 MiniMax-H3 视频模型：H3 的画面 LoRA 都训练在
    DiT 上，用本节点完全正确、不会丢东西。
  · 显存占用与原生 LoRA 完全一致（实时融合，只存低秩增量），不产生额外
    完整权重副本。

用法：串在模型加载器之后、采样器(或 H3-SLA 节点)之前。
"""

    def apply_lora(self, 模型, LoRA配置="[]", LoRA文件=None, 模型强度=1.0, **kwargs):
        # **kwargs：吞掉历史/隐藏输入，避免不同前端版本多传参数导致报错
        jobs = _parse_config(LoRA配置)
        # 兜底：面板无配置时按旧版单 LoRA 走（前端扩展未加载、旧工作流、API 调用）
        if not jobs and LoRA文件:
            lora_name = str(LoRA文件).strip().replace("\\", "/")
            try:
                jobs = [(lora_name, float(模型强度), "")]
            except (TypeError, ValueError):
                jobs = [(lora_name, 1.0, "")]
        if not jobs:
            print(
                "[多LoRA管理器] ⚠️ 未启用任何 LoRA，模型将直接透传（不做任何修改）。\n"
                "   如需使用，请点「＋ 添加 LoRA」选择文件并勾选启用；\n"
                "   若面板打不开，请 Ctrl+Shift+R 强制刷新前端。"
            )
            return (模型,)

        free_before = comfy.model_management.get_free_memory()

        current = 模型
        lines = []
        for idx, (file, strength, note) in enumerate(jobs, 1):
            tag = f"（{note}）" if note else ""

            if strength == 0.0:
                lines.append(f"▸ [{idx}] ⏸️ {file}{tag} 强度为 0，跳过")
                continue

            # ---- 读盘（带缓存）----
            try:
                lora_path = folder_paths.get_full_path("loras", file)
                if lora_path is None:
                    raise FileNotFoundError(f"loras 目录下未找到：{file}")
                lora = self._lora_cache.get(lora_path)
                if lora is None:
                    lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
                    self._lora_cache[lora_path] = lora
            except Exception as e:
                raise RuntimeError(
                    f"❌ LoRA 加载失败 [{idx}] {file}{tag}\n"
                    f"   原因：{e}\n"
                    f"   请确认 LoRA 在 models/loras 目录下，且子目录层级、"
                    f"文件名（含大小写）与选择时一致。"
                ) from e

            # ---- 检测是否含「文字理解」权重（本节点不加载，需告警）----
            te_warn = _has_text_encoder_weights(lora)

            # ---- 实时融合（一次扫描）----
            try:
                current, matched = _apply_lora_to_model(current, lora, strength)
            except Exception as e:
                raise RuntimeError(
                    f"❌ LoRA 应用失败 [{idx}] {file}{tag}\n   原因：{e}"
                ) from e

            # matched == 0 说明 LoRA 与当前模型完全不匹配
            # （例如 SD1.5 的 LoRA 用在 SDXL/Flux/H3 上），什么都没加上。
            if matched == 0:
                raise RuntimeError(
                    f"❌ LoRA 无效 [{idx}] {file}{tag}\n"
                    f"   该 LoRA 与当前模型不匹配（如 SD1.5 的 LoRA 用在 SDXL/H3 上），\n"
                    f"   没有任何权重被应用。请换成对应模型的 LoRA。"
                )

            lines.append(
                f"▸ [{idx}] ✅ {file}{tag} 强度 {strength:.2f}  +{matched} 处补丁")
            if te_warn:
                lines.append(
                    f"     ⚠️ 该 LoRA 含「文字理解」权重，本节点不加载（只改画面部分）")

        free_after = comfy.model_management.get_free_memory()
        delta = (free_after - free_before) / (1024 ** 3)
        delta_str = f"{delta:+.2f} GB" if abs(delta) >= 0.005 else "≈0"
        print(
            f"[班长多LoRA] ✅ 实时融合完成（{len(jobs)} 个 LoRA）\n"
            "──────────────────────────────\n"
            + "\n".join(lines) + "\n"
            "──────────────────────────────\n"
            + f"▸ 空闲显存  : {_gb(free_before)} → {_gb(free_after)}  ({delta_str})"
        )
        return (current,)


# ------------------------------------------------------------------------------
# 节点映射
# ------------------------------------------------------------------------------
NODE_CLASS_MAPPINGS = {
    "BanZhang_LoRA_VramSafe": BanZhang_LoRA_VramSafe,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_LoRA_VramSafe": "🛡️ 多 LoRA 管理器 (实时融合)",
}
