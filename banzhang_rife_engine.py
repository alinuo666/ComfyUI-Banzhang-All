# -*- coding: utf-8 -*-
"""引擎层：RIFE 插帧（纯 PyTorch，什么显卡都能跑）

和 NVIDIA 那两套插帧的区别：
    RTX 视频插帧  = NVIDIA 专属 SDK，官方只给 RTX 40/50
    DLSS5 插帧    = NVIDIA NGX DLSS-FG，官方只给 RTX 40/50
    RIFE 插帧     = 开源模型，A 卡 N 卡 20/30/40/50 系通吃，靠显卡算力硬算

两个可用版本（架构相同、键名一致，只有训练权重不同，可随时切换）：
    v4.26  2024-09-21 发布，最新训练，画质最好（默认）
    v4.25  2024-09-19 发布，动漫场景突出、公认最稳（升级前一直在用的就是它）
    （v4.22 官方推荐用于扩散模型生成的视频，但各镜像都没有标准版权重，暂不提供）

模型结构见 banzhang_rife_model.py（MIT 协议的 Practical-RIFE），
权重放 ComfyUI/models/rife/，缺失时会自动从国内镜像下载。
"""
import os
import urllib.request

import torch

from .banzhang_rife_model import IFNet
from .banzhang_stream_util import (free_cache, head_bytes as _head_bytes,
                                   quarantine as _quarantine, rounds_for,
                                   size_of as _size_of, weight_ok,
                                   stream_interpolate as _stream)

_NO_AUTO_DOWNLOAD_ENV = "BANZHANG_NO_AUTO_PIP"
_WEIGHT_MIN_BYTES = 1024 * 1024  # 完整权重约 25MB，小于 1MB 视为损坏/没下完

# 版本 id -> (本地规范文件名, 下载地址, 下拉菜单显示名)
# 显示名里直接写清楚这一版的优点，选的时候不用再查资料。
MODEL_VERSIONS = {
    "v4.26": ("flownet_v4.26.pkl",
              "https://hf-mirror.com/MonsterMMORPG/RIFE_4_26/resolve/main/train_log/flownet.pkl",
              "v4.26｜最新·画质最佳（推荐）"),
    "v4.25": ("flownet.pkl",
              "https://hf-mirror.com/Upsampler/rife-4-25/resolve/main/flownet.pkl",
              "v4.25｜动漫最强·公认最稳"),
}
DEFAULT_VERSION = "v4.26"

# 别的 RIFE 插件 / 官方压缩包里，同版本权重常见的落地路径（相对 ComfyUI/models）。
# 命中任一就直接复用，不再重复下载；两版都是 IFNet_HDv3 架构，权重可直接加载。
_LOCAL_CANDIDATES = {
    "v4.26": [
        "rife/flownet_v4.26.pkl",
        "rife/flownet_v426.pkl",
        "rife/rife4.26.pth",
        "rife/rife426.pth",
        "rife/v4.26/flownet.pkl",
        "rife/RIFE4.26/flownet.pkl",
        "rife/RIFE4.26/train_log/flownet.pkl",
        "frame_interpolation/ckpts/rife4.26.pth",
        "frame_interpolation/ckpts/rife426.pth",
    ],
    "v4.25": [
        "rife/flownet.pkl",
        "rife/flownet_v4.25.pkl",
        "rife/flownet_v425.pkl",
        "rife/rife4.25.pth",
        "rife/rife425.pth",
        "rife/v4.25/flownet.pkl",
        "rife/RIFE4.25/flownet.pkl",
        "rife/RIFE4.25/train_log/flownet.pkl",
        "frame_interpolation/ckpts/rife4.25.pth",
        "frame_interpolation/ckpts/rife425.pth",
    ],
}
# 递归兜底时扫描的目录（相对 ComfyUI/models）
_LOCAL_SEARCH_DIRS = ["rife", "frame_interpolation"]

_CACHE = {}
_RESOLVED = {}  # version -> 实际使用的权重路径（可能是别处已下载的文件）


class RIFEError(RuntimeError):
    """给用户看的中文报错。"""


def _models_dir() -> str:
    import folder_paths

    path = os.path.join(folder_paths.models_dir, "rife")
    os.makedirs(path, exist_ok=True)
    return path


def _good_weight(path: str) -> bool:
    # 光看大小会把「下了一半 / 被别的压缩包顶替」的文件当成有效权重，
    # 一路喂进 torch.load，炸出 KeyError: filename 'storages' not found。
    return weight_ok(path, _WEIGHT_MIN_BYTES)


def _search_roots():
    """模型搜索根：主 models 目录排第一，其后是 extra_model_paths.yaml 里映射的插帧目录。

    RIFE 在 ComfyUI 里不是官方文件夹类型 —— 只有用户装了第三方插帧包、或在 yaml 里
    显式写了 rife / frame_interpolation，才有映射路径可读。读不到就只剩主目录，
    与改前行为一致；主目录优先，也不会改变最终选中哪个文件。
    """
    import folder_paths

    roots = []
    try:
        roots.append(folder_paths.models_dir)
    except Exception:
        pass
    try:
        table = folder_paths.folder_names_and_paths
    except Exception:
        table = {}
    for key in _LOCAL_SEARCH_DIRS:
        try:
            paths = table.get(key, ([], set()))[0] or []
        except Exception:
            continue
        for p in paths:
            if not p or p in roots:
                continue
            # 第三方插帧包常把自己的默认目录注册成 models/frame_interpolation，
            # 这类已经在主目录内部的映射，下面按约定子目录递归时本来就会扫到，
            # 再单独加根只会把同一处扫两遍。
            try:
                if os.path.commonpath([os.path.abspath(roots[0]), os.path.abspath(p)]) \
                        == os.path.abspath(roots[0]):
                    continue
            except Exception:
                pass
            roots.append(p)
    return roots


def _scan_dirs(roots):
    """递归找权重时要扫的目录。

    主根只扫约定子目录（整个 models 盘递归太慢）；映射目录连自己一起扫 ——
    用户在 yaml 里通常直接指到 rife / frame_interpolation 那一层，模型就躺在里面。
    """
    dirs = []
    for i, root in enumerate(roots):
        if i:
            dirs.append(root)
        dirs.extend(os.path.join(root, d) for d in _LOCAL_SEARCH_DIRS)
    return dirs


def find_local_weight(version: str = DEFAULT_VERSION):
    """在 ComfyUI 本地模型目录里找用户已下载好的同版本权重；找不到返回 None。

    先认常见固定路径（FizzNodes、Fannovel16 插帧包、官方 RIFE 压缩包等），
    再递归扫 rife / frame_interpolation 目录，匹配带版本号的 flownet.pkl / rife*.pth。
    主 models 目录与 yaml 映射目录都找一遍，避免用户映射盘里已有权重还被重复下载。
    """
    import glob

    roots = _search_roots()

    for root in roots:
        for rel in _LOCAL_CANDIDATES.get(version, []):
            p = os.path.join(root, rel.replace("/", os.sep))
            if _good_weight(p):
                return p

    token = version.lstrip("v")          # "4.26"
    compact = token.replace(".", "")     # "426"
    for base in _scan_dirs(roots):
        for p in glob.glob(os.path.join(base, "**", "*"), recursive=True):
            name = os.path.basename(p).lower()
            # 别只认精确的 flownet.pkl：官方压缩包和第三方包普遍叫 flownet_v4.26.pkl /
            # flownet_426.pkl，卡死文件名会让映射目录里明明存在的权重被当成没有而重复下载。
            # 先按名字筛，再验内容：验内容要开文件，对整个目录的无辜大文件都验太亏。
            is_known = (name.startswith("flownet") and name.endswith(".pkl")) or (
                name.startswith("rife") and name.endswith(".pth"))
            if not is_known:
                continue
            low = p.lower()
            if token not in low and compact not in low:
                continue
            if _good_weight(p):
                return p
    return None


def any_local_weight() -> bool:
    """任一版本在本地已有权重（用于启动时判断要不要注册节点）。"""
    for ver in MODEL_VERSIONS:
        canonical = os.path.join(_models_dir(), MODEL_VERSIONS[ver][0])
        if _good_weight(canonical) or find_local_weight(ver):
            return True
    return False


def model_path(version: str = DEFAULT_VERSION) -> str:
    """实际要用的权重路径：优先解析到的本地文件，否则是规范存放位置。"""
    if version not in MODEL_VERSIONS:
        version = DEFAULT_VERSION
    resolved = _RESOLVED.get(version)
    if _good_weight(resolved):
        return resolved
    return os.path.join(_models_dir(), MODEL_VERSIONS[version][0])


def ensure_model(version: str = DEFAULT_VERSION) -> bool:
    """本地已有同版本权重就直接用（不重复下载）；没有才联网下载。

    不想自动下载就设 BANZHANG_NO_AUTO_PIP=1。
    """
    if version not in MODEL_VERSIONS:
        version = DEFAULT_VERSION
    filename, url, _ = MODEL_VERSIONS[version]
    canonical = os.path.join(_models_dir(), filename)

    if _good_weight(canonical):
        _RESOLVED[version] = canonical
        return True

    if os.path.isfile(canonical):
        # 文件在、但不是权重（下了一半 / 被同名文件顶替）。
        # 改名留证而不是直接覆盖：万一那是别的插帧插件在用的同名文件，用户还能找回来。
        size, head = _size_of(canonical), _head_bytes(canonical)
        bad = _quarantine(canonical)
        print(f"[班长全家桶] RIFE {version} 的权重文件不是有效权重"
              f"（{size} 字节，开头 {head!r}）"
              f"{'，已改名为 ' + os.path.basename(bad) if bad else '，且无法改名'}，重新下载。")

    local = find_local_weight(version)
    if local:
        _RESOLVED[version] = local
        print(f"[班长全家桶] 检测到本地已有的 RIFE {version} 权重，直接复用（不重复下载）：\n  {local}")
        return True

    if str(os.environ.get(_NO_AUTO_DOWNLOAD_ENV, "")).strip().lower() in ("1", "true", "yes", "on"):
        return False

    print(f"[班长全家桶] 首次启用 RIFE {version}，本地未找到，正在下载模型（约 25MB）...")
    tmp = canonical + ".tmp"
    try:
        urllib.request.urlretrieve(url, tmp)
        # 下完当场验内容：断网 / 被劫持留下的半截文件绝不能转正，
        # 否则下次启动直接崩在 torch.load，用户只看到一句天书。
        if not _good_weight(tmp):
            raise OSError(f"下载到的文件不是有效权重（{_size_of(tmp)} 字节，"
                          f"开头 {_head_bytes(tmp)!r}）")
        os.replace(tmp, canonical)
    except Exception as exc:
        try:
            os.remove(tmp)
        except OSError:
            pass
        print(f"[班长全家桶] 模型下载失败：{exc}\n"
              f"  可手动下载 {url}\n"
              f"  改名成 {filename} 放到 {canonical}")
        return False
    _RESOLVED[version] = canonical
    print(f"[班长全家桶] RIFE {version} 模型下载完成。")
    return True


def _read_state(version: str, path: str):
    """读权重；读不出来就当坏文件处理：改名 → 重下 → 再读一次。

    格式检查只能拦住「一眼假」的文件。整包合法但内部 CRC 坏、被同名 zip 顶替、
    权重键对不上，都要等 torch.load 才炸。这里当场自愈一次，
    用户不用看懂报错、也不用再点一次运行。
    """
    for attempt in (1, 2):
        try:
            return torch.load(path, map_location="cpu", weights_only=False)
        except Exception as exc:
            size, head = _size_of(path), _head_bytes(path)
            bad = _quarantine(path)
            print(f"[班长全家桶] RIFE {version} 权重读不出来（{size} 字节，开头 {head!r}），"
                  f"{'已改名为 ' + os.path.basename(bad) + '，' if bad else ''}"
                  f"重新下载后重试...")
            if attempt == 2 or not ensure_model(version):
                raise RIFEError(
                    f"RIFE {version} 的权重读不出来：{path}\n"
                    f"文件 {size} 字节，开头 {head!r} —— 这不是一个正常的权重文件。\n"
                    f"插件已自动重新下载过一次仍失败，多半是网络取不到正确文件。\n"
                    f"联网后重启 ComfyUI 重跑即可；一直不行就手动下载放到这个目录。\n"
                    f"原始报错：{exc}") from None
            path = model_path(version)


def load_model(fp16: bool = True, version: str = DEFAULT_VERSION):
    """加载并缓存模型（同一版本 + 同一精度只加载一次）。"""
    if version not in MODEL_VERSIONS:
        version = DEFAULT_VERSION
    key = f"{version}:{'fp16' if fp16 else 'fp32'}"
    cached = _CACHE.get(key)
    if cached is not None:
        return cached

    if not ensure_model(version):
        raise RIFEError(
            f"找不到 RIFE {version} 权重：{model_path(version)}\n"
            f"手动下载后放进去就行，或联网重启一次让插件自己下。")

    path = model_path(version)
    if not _good_weight(path):
        # 文件在场但内容不对：早期版本下了一半的残骸，或别处插件留下的同名文件。
        # 自动改名 + 重下，用户不用自己翻目录删东西。
        size, head = _size_of(path), _head_bytes(path)
        bad = _quarantine(path)
        print(f"[班长全家桶] RIFE {version} 权重文件已损坏（{path}，{size} 字节，"
              f"开头 {head!r}）"
              f"{'，已改名为 ' + os.path.basename(bad) if bad else ''}，正在重新下载...")
        if not ensure_model(version):
            raise RIFEError(
                f"RIFE {version} 权重损坏且重下失败：{path}\n"
                f"请联网后重启一次 ComfyUI，插件会自己下；"
                f"或手动下载放到这个位置。")
        path = model_path(version)

    import comfy.model_management as mm

    net = IFNet()
    state = _read_state(version, path)
    state = {k.replace("module.", ""): v for k, v in state.items()}
    net.load_state_dict(state, strict=False)
    net.eval().to(mm.get_torch_device())
    if fp16:
        net.half()
    _CACHE[key] = net
    return net


def _pad(tensor, pad_h, pad_w):
    return torch.nn.functional.pad(tensor, (0, pad_w, 0, pad_h), mode="replicate")


@torch.inference_mode()
def _infer(net, img0, img1, fp16: bool, timestep: float = 0.5) -> torch.Tensor:
    """输入 (1,3,H,W) 的 0~1 浮点图，输出中间帧。尺寸不是 64 的倍数会先补齐。"""
    device = next(net.parameters()).device
    img0 = img0.to(device)   # ComfyUI 的图像批次默认在内存里，模型在显卡上，先对齐
    img1 = img1.to(device)
    _, _, height, width = img0.shape
    # RIFE 是 5 级金字塔：第一级 ÷16，块内部再 ÷4，所以边长必须是 64 的倍数
    # （只补到 32 的倍数的话 544÷16=34，34÷4=8.5 除不尽，插出来的帧会错位报错）
    pad_h = (-height) % 64
    pad_w = (-width) % 64
    if pad_h or pad_w:
        img0 = _pad(img0, pad_h, pad_w)
        img1 = _pad(img1, pad_h, pad_w)

    pair = torch.cat((img0, img1), 1)
    if fp16:
        with torch.autocast("cuda", dtype=torch.float16):
            merged = net(pair, timestep=timestep)
    else:
        merged = net(pair, timestep=timestep)

    merged = merged.float().clamp(0.0, 1.0)
    return merged[:, :, :height, :width] if (pad_h or pad_w) else merged


def _make_infer(net, fp16: bool):
    def infer(img0, img1, timestep):
        return _infer(net, img0, img1, fp16, timestep)

    return infer


# ------------------------------------------------------------- 流式（边插边编码）

def stream_interpolate(frames_iter, total_in: int, multiplier: int, fp16: bool,
                       sink, progress=None, version: str = DEFAULT_VERSION) -> None:
    """流式插帧：逐帧喂 numpy uint8 RGB，边插边把帧吐给 sink。

    内存/显存峰值 = 模型 + 一对帧 + 2^倍数 个中间帧，与片长完全无关。
    """
    try:
        rounds = rounds_for(multiplier)
    except ValueError as exc:
        raise RIFEError(str(exc)) from None

    net = load_model(fp16, version)
    _stream(frames_iter, total_in, rounds, sink, _make_infer(net, fp16),
            fp16=fp16, progress=progress)


__all__ = ["DEFAULT_VERSION", "MODEL_VERSIONS", "RIFEError", "ensure_model",
           "any_local_weight", "find_local_weight",
           "load_model", "model_path", "stream_interpolate"]
