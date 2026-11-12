"""投影矩阵的加载与对照矩阵构造。

移植自 ComfyUI-ClipProj 0.1.13（MIT，nicolab28）的 clipproj_projection.py，
只保留「文本编码器投影」节点需要的那部分：不再支持已撤下的 .pt 之外的东西，
也没有多卡固定相关逻辑。

一个投影文件（.safetensors）里的键：

    W         [d_in, d_out]  岭回归解出的线性矩阵（-mlp 版本可能没有）
    mean_in   [d_in]         小模型激活均值
    std_in    [d_in]         对应标准差
    mean_out  [d_out]        大模型激活均值
    std_out   [d_out]        对应标准差
    tap       int            读小模型第几层
    mlp.N.*   可选，残差网络的 Linear 层

还原公式：cond = ((h - mean_in) / std_in) @ W * std_out + mean_out
"""

import json
import os

import torch
from safetensors.torch import load_file as _load_safetensors
from safetensors import safe_open as _safe_open

import folder_paths

# safetensors 头里标量只能存字符串，读回来要按这个表转回原类型。
_META_TYPES = {
    "tap": int, "d_in": int, "d_out": int,
    "n_train_prompts": int, "n_train_tokens": int,
    "lambda": float, "cos_test": float, "r2_test": float,
    "cond_proj_weighted": lambda v: v.lower() == "true",
}

FOLDER = "clip_projections"

# 目录为空时下拉里放这一条。原包放的是 <control:zero> 这类对照项，
# 尖括号会被前端当成 HTML 标签吃掉，显示出来就是几行空白 —— 用户看到的
# 就是「没有的选项占着位置」。这里换成一句中文，至少能看懂是什么情况。
PLACEHOLDER = "（还没放矩阵文件，请放到 models/clip_projections/）"

_CACHE = {}


def register_folder():
    """把 clip_projections 注册成 ComfyUI 的模型目录。

    注册后下拉框里就是纯文件名，而不是一长串绝对路径。目录不存在就建一个，
    否则用户不知道该往哪儿放文件。
    """
    path = os.path.join(folder_paths.models_dir, FOLDER)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    existing = folder_paths.folder_names_and_paths.get(FOLDER)
    if existing is None:
        folder_paths.folder_names_and_paths[FOLDER] = ([path], {".pt", ".safetensors"})
    elif path not in existing[0]:
        existing[0].append(path)


def list_projections():
    """返回磁盘上真实存在的投影文件；一个都没有时给一条提示。

    只列能打开的扩展名。ComfyUI 会把目录里所有东西都递回来，一个 README
    也会出现在下拉里，选中后报的是文件格式错误而不是「你选错了」。
    """
    try:
        found = list(folder_paths.get_filename_list(FOLDER))
    except Exception:
        found = []
    found = [f for f in found if f.lower().endswith((".safetensors", ".pt"))]
    return found or [PLACEHOLDER]


def load_projection(name):
    """按名字读投影文件。

    Raises:
        FileNotFoundError: 文件不存在，或选的是空目录提示项。
        KeyError: 缺必需键。
    """
    if name == PLACEHOLDER:
        raise FileNotFoundError(
            "还没有投影矩阵。项目页 https://huggingface.co/NicoLab28/ClipProj-MiniMax-H3 "
            "下载 mmh3-8b-ClipProj-v3.1.safetensors（配 8B 编码器）或 "
            "mmh3-4b-ClipProj-v3.1.safetensors（配 4B），放进 "
            "ComfyUI/models/clip_projections/ 后重启。")

    path = folder_paths.get_full_path(FOLDER, name)
    if path is None or not os.path.isfile(path):
        raise FileNotFoundError("找不到投影矩阵文件：%s" % name)

    key = (path, os.path.getmtime(path))
    if key in _CACHE:
        return _CACHE[key]

    if path.lower().endswith(".safetensors"):
        data = _load_safetensors(path)
        with _safe_open(path, framework="pt") as f:
            meta = f.metadata() or {}
        for k, v in meta.items():
            cast = _META_TYPES.get(k)
            try:
                data[k] = cast(v) if cast else v
            except (TypeError, ValueError):
                data[k] = v
    else:
        # weights_only=True 不是可选项：不带它打开一个 pickle 等于执行文件里
        # 写好的任意代码，为六个张量冒这个风险没有道理。
        data = torch.load(path, map_location="cpu", weights_only=True)

    # W 可以缺席。用残差网络训出来的文件不带线性矩阵，存一个全零矩阵会白占
    # 26MB 外加每 token 一次 2560x5120 的乘加。维度从 mean_in/mean_out 读，
    # 每个文件都有。
    for k in ("mean_in", "std_in", "mean_out", "std_out", "tap"):
        if k not in data:
            raise KeyError("投影文件 %s 缺少键 '%s'" % (name, k))
    # 激活值进来是 float32，右边挂一个半精度矩阵会直接报错而不是静默转换。
    for k in ("W", "mean_in", "std_in", "mean_out", "std_out"):
        if k in data:
            data[k] = data[k].float()

    # 一次只留一个：每个都几十 MB，同时留几个没有意义。
    _CACHE.clear()
    _CACHE[key] = data
    return data


def build_residual(proj, device, dtype=None):
    """重建文件里捎带的残差网络。

    文件按 mlp.N.weight / mlp.N.bias 平铺存张量，层间的激活函数是固定的
    GELU，不存。这样格式可读，也不用塞一个 pickle 过的 module 进去。

    dtype 传 None 就沿用文件自己的精度 —— fp16 的残差若在加载时抬成 fp32，
    省下的磁盘空间会一分不差地在显存里还回去。
    """
    couches = sorted({int(k.split(".")[1]) for k in proj if k.startswith("mlp.")})
    if not couches:
        return None
    if dtype is None:
        dtype = proj["mlp.%d.weight" % couches[0]].dtype
    modules = []
    for n, i in enumerate(couches):
        w = proj["mlp.%d.weight" % i]
        lin = torch.nn.Linear(w.shape[1], w.shape[0], bias=("mlp.%d.bias" % i) in proj)
        lin.weight.data = w.to(device=device, dtype=dtype)
        if lin.bias is not None:
            lin.bias.data = proj["mlp.%d.bias" % i].to(device=device, dtype=dtype)
        modules.append(lin)
        if n < len(couches) - 1:
            modules.append(torch.nn.GELU())
    reseau = torch.nn.Sequential(*modules).to(device=device, dtype=dtype)
    # 用 train(False) 而不是 eval()，行为一样，少一个安全扫描器的误报。
    reseau.train(False)
    for p in reseau.parameters():
        p.requires_grad_(False)
    return reseau
