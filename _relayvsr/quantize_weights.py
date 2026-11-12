r"""把 RelayVSR 权重目录离线量化成 ComfyUI 原生 W4A8 权重包。

用法（在 ComfyUI 根目录外的任意位置都能跑）：
    python_embeded\\python.exe custom_nodes\\ComfyUI-Banzhang-All\\_relayvsr\\quantize_weights.py \
        --源目录 ...\models\relayvsr\RelayVSR_X2 --输出目录 ...\models\relayvsr\RelayVSR_X2_W4A8

只量化 wan 的 transformer block 二维线性层；norm / modulation / embedding / 投影头 / 卷积保持原精度。
flash 是逐帧解码器，只占 0.12G，量化只省 0.07G 却让平均像素差从 4.29 升到 4.92/255，
所以它原样复制、不量化（加载端按模块逐个认 comfy_quant 标记，混合包能直接用）。
输出目录里仍是配对的 wan / flash 两个 safetensors，原文件的 format / config metadata 原样保留，
所以节点「权重包」下拉会自动多出一项，不需要改扫描逻辑。
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def _find_comfyui_root():
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "comfy" / "quant_ops.py").is_file():
            return str(parent)
    return os.environ.get("COMFYUI_PATH", ".")


sys.path.insert(0, _find_comfyui_root())

from comfy.quant_ops import QuantizedTensor, get_layout_class  # noqa: E402
import comfy_kitchen as ck  # noqa: E402

_LAYOUT = "AsymW4A8Int8Layout"
_FORMAT = "asym_w4a8_int8"
_分组 = 16
_跳过关键词 = (
    "norm", "scale_shift_table", "embed", "proj_out", "spatial_head",
    "residual_projection", "patch_embedding", "lq_proj",
)


def _可量化(name, tensor):
    if not name.endswith(".weight") or tensor.dim() != 2:
        return False
    if any(word in name for word in _跳过关键词):
        return False
    width = tensor.shape[1]
    # W4A8 带 convrot，K 必须同时被 group_size 与 convrot_groupsize 整除；
    # 不满足的层保持原精度，别为了覆盖率去改分组参数（加载端与量化端必须一致）。
    return width >= 64 and width % _分组 == 0 and width % 256 == 0


def _转存(tensor):
    # safetensors 不收 fp8；按官方 loader 的约定以 uint8 落盘。
    if tensor.dtype == torch.float8_e4m3fn:
        return tensor.contiguous().view(torch.uint8).cpu()
    return tensor.contiguous().cpu()


def 量化单文件(源路径, 输出路径, 设备):
    out = {}
    count = 0
    with safe_open(str(源路径), framework="pt", device="cpu") as handle:
        metadata = dict(handle.metadata() or {})
        for name in handle.keys():
            if name.endswith(".comfy_quant") or ".weight_s_" in name or name.endswith(".weight_codebook"):
                continue
            tensor = handle.get_tensor(name)
            if not _可量化(name, tensor):
                out[name] = tensor
                continue
            weight = tensor.to(device=设备, dtype=torch.bfloat16)
            qdata, s_rel, s_channel, _, codebook = ck.quantize_w4a8_int8_weight(
                weight, group_size=_分组, symmetric=True
            )
            cls = get_layout_class(_LAYOUT)
            params = cls.Params(
                scale=s_rel, s_channel=s_channel, codebook=codebook,
                group_size=_分组, convrot_groupsize=256,
                orig_dtype=torch.bfloat16, orig_shape=tuple(weight.shape),
            )
            qt = QuantizedTensor(qdata, _LAYOUT, params)
            for key, value in qt.state_dict(name).items():
                out[key] = _转存(value)
            module = name[: -len(".weight")]
            conf = {"format": _FORMAT, "group_size": _分组, "orig_shape": list(weight.shape)}
            out[module + ".comfy_quant"] = torch.tensor(
                list(json.dumps(conf).encode("utf-8")), dtype=torch.uint8
            )
            count += 1
            del weight, qdata, s_rel, s_channel, codebook, qt
    输出路径.parent.mkdir(parents=True, exist_ok=True)
    save_file(out, str(输出路径), metadata=metadata)
    old = 源路径.stat().st_size / 1024 ** 3
    new = 输出路径.stat().st_size / 1024 ** 3
    print(f"  {源路径.name}: 量化 {count} 层 | {old:.2f}G -> {new:.2f}G | -> {输出路径.name}")


def main():
    ap = argparse.ArgumentParser(description="RelayVSR 权重离线量化为 ComfyUI 原生 W4A8")
    ap.add_argument("--源目录", required=True, help="含 wan / flash 两个 safetensors 的原权重目录")
    ap.add_argument("--输出目录", required=True, help="新权重目录，不覆盖原文件")
    ap.add_argument("--设备", default="cuda", help="cuda 或 cpu，默认 cuda")
    args = ap.parse_args()

    src, dst = Path(args.源目录), Path(args.输出目录)
    if not src.is_dir():
        raise SystemExit(f"源目录不存在：{src}")
    if src.resolve() == dst.resolve():
        raise SystemExit("输出目录不能等于源目录")
    device = torch.device(args.设备)
    print(f"设备 = {device} | 源 = {src} | 输出 = {dst}")

    # 用 metadata 里的 format 认 wan / flash，不靠文件名。
    from checkpoints import inspect_safetensors
    files = {}
    for path in sorted(src.glob("*.safetensors")):
        info = inspect_safetensors(path)
        if info:
            files[info[0]] = path
    if set(files) != {"wan", "flash"}:
        raise SystemExit(f"源目录里没找到配对的 wan / flash 权重：{list(files)}")

    量化单文件(files["wan"], dst / files["wan"].name, device)
    shutil.copy2(files["flash"], dst / files["flash"].name)
    print(f"  {files['flash'].name}: 保持原精度，直接复制")
    print("完成。重启 ComfyUI 后，节点「权重包」下拉会多出这个目录。")


if __name__ == "__main__":
    main()
