# -*- coding: utf-8 -*-
"""ffmpeg / ffprobe 查找 —— 全插件共用一份

插件包自带一套在 tools/ffmpeg/bin（含 LICENSE），别人拿到包不用自己装 ffmpeg。
这里只依赖标准库，任何模块都能安全 import，不会顺带把 torch/numpy 拖进来。

查找顺序（本地优先，找到哪个用哪个）：
  1) 系统 PATH（find_binary 里的 shutil.which，本地装了就用本地、绝不联网）
  2) 环境变量 BANZHANG_FFMPEG_DIR 指定的目录
  3) ComfyUI 便携版 / 桌面版自带（python_embeded、standalone-env 等）
  4) Windows 常见安装位（C:\\ffmpeg*\\bin、Program Files、scoop 等）
  5) 本插件包自带 tools/ffmpeg/bin（随包那份，老包才有，发布包已剔除）
  6) 首次自动安装的缓存目录 models/banzhang_tools/ffmpeg/bin（插件目录外，更新不覆盖）
"""
import os
import shutil
import sys
from pathlib import Path


def scan_dirs() -> list:
    """ffmpeg / ffprobe 的常见藏身处，按优先级排好。

    ComfyUI 桌面版和便携整合包用的是独立 Python，系统 PATH 里的 ffmpeg 它
    看不见，只靠 shutil.which 会直接判成"没装"，所以要把这些目录补上。
    """
    roots: list[str] = []

    # 1) 用户手动指定：指向含 ffmpeg.exe 的那个目录
    env_dir = str(os.environ.get("BANZHANG_FFMPEG_DIR", "")).strip().strip('"')
    if env_dir:
        roots.append(env_dir)

    # 2) Python 解释器旁边：ComfyUI 便携版把它塞在 python_embeded/，
    #    桌面版塞在 standalone-env/，这是最常见的藏身处
    exe_dir = os.path.dirname(sys.executable)
    for base in (exe_dir, os.path.dirname(exe_dir), sys.prefix):
        if base:
            roots += [base, os.path.join(base, "ffmpeg"), os.path.join(base, "ffmpeg", "bin")]

    # 3) ComfyUI 根目录附近（本文件在 custom_nodes/<包>/ 下，往上找三层/四层）
    parents = Path(__file__).resolve().parents
    for up in parents[2:4]:
        roots += [str(up), str(up / "ffmpeg"), str(up / "ffmpeg" / "bin")]

    # 4) Windows 常见安装位：系统盘 / 本程序所在盘根下的 ffmpeg*、Program Files、scoop
    if os.name == "nt":
        # ComfyUI 常装在别的盘（比如 E:），而 ffmpeg 大多装在 C:，两个盘都要扫
        drives = [d.rstrip("\\") for d in
                  (os.environ.get("SystemDrive", ""), os.path.splitdrive(sys.executable)[0])
                  if d.strip()]
        drives = list(dict.fromkeys(drives)) or ["C:"]
        for drive in drives:
            roots.append(f"{drive}\\ffmpeg\\bin")
            try:
                roots += [str(p / "bin") for p in Path(drive + "\\").glob("ffmpeg*")
                          if p.is_dir()]
            except OSError:
                pass
        program_files = os.environ.get("ProgramFiles", "").strip()
        if program_files:
            roots.append(str(Path(program_files) / "ffmpeg" / "bin"))
        roots += [str(Path.home() / "ffmpeg" / "bin"),
                  str(Path.home() / "scoop" / "apps" / "ffmpeg" / "current" / "bin")]

    # 5) 本插件包自带：随包那份，本地没装时优先用它（老包才有；发布包已剔除，
    #    见 make_release.py —— 目录不存在时自然跳过，落到下面的自动安装缓存）
    here = Path(__file__).resolve().parent
    roots += [str(here / "tools" / "ffmpeg" / "bin"), str(here / "tools" / "ffmpeg")]

    # 6) 最后才轮到首次自动安装的落点（插件目录之外，更新插件不会覆盖）
    roots.append(str(Path(__file__).resolve().parents[2] / "models" / "banzhang_tools" / "ffmpeg" / "bin"))

    seen, out = set(), []
    for d in roots:
        key = os.path.normcase(os.path.normpath(d))
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


_DIRS: list | None = None


def find_binary(name: str) -> str | None:
    """找 ffmpeg / ffprobe，找不到返回 None。"""
    global _DIRS
    found = shutil.which(name)
    if found:
        return found
    if _DIRS is None:
        _DIRS = scan_dirs()
    exe = f"{name}.exe" if os.name == "nt" else name
    for directory in _DIRS:
        candidate = os.path.join(directory, exe)
        if os.path.isfile(candidate):
            return candidate
    return None


def find_ffmpeg() -> str | None:
    """找 ffmpeg；连 imageio-ffmpeg 那份也算上（它只带 ffmpeg，不带 ffprobe）。"""
    found = find_binary("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def find_ffprobe() -> str | None:
    return find_binary("ffprobe")


def ffmpeg_help() -> str:
    """给用户看的 ffmpeg 安装指引（找不到 ffmpeg 时打在控制台）。"""
    extra = ("" if os.name == "nt"
             else "；Ubuntu 也可直接执行 sudo apt install ffmpeg")
    return ("需要 ffmpeg 才能处理视频。三种办法任选一个：\n"
            "  1) 装好后把 ffmpeg 所在目录加进系统 PATH，重启 ComfyUI；\n"
            "  2) 不想改 PATH：新建环境变量 BANZHANG_FFMPEG_DIR，值填那个目录，重启 ComfyUI；\n"
            "  3) 插件首次启动会自动下载到 models/banzhang_tools/ffmpeg/bin，"
            "正常情况不用你做任何事" + extra + "。")
