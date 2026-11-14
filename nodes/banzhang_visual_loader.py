# -*- coding: utf-8 -*-
"""
👨‍🏫 班长媒体加载器模块
包含：图片 / 视频 / 音频 三合一可视化加载器
"""

import os
import re
import glob
import time
import urllib.parse
import shutil
import asyncio
import mimetypes
import subprocess
from concurrent.futures import ThreadPoolExecutor
import folder_paths
import torch
import numpy as np
import hashlib
from PIL import Image, ImageDraw, ImageOps, ImageSequence
from server import PromptServer
from aiohttp import web
from io import BytesIO

# 定义缓存目录
节点根目录 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
缓存目录 = os.path.join(节点根目录, "caches")

if not os.path.exists(缓存目录):
    try:
        os.makedirs(缓存目录)
    except Exception as e:
        print(f"❌ [班长] 无法创建缓存目录: {e}")


def 确保缓存目录():
    """生成前兜底：目录可能被用户在运行中手动删掉，重新建即可自愈，
    不必重启 ComfyUI。exist_ok=True 让并发调用也安全。"""
    try:
        os.makedirs(缓存目录, exist_ok=True)
        return True
    except Exception:
        return False

API_PREFIX = "/banzhang_api"

# 视频首帧 / 音频波形都交给 ffmpeg，格式覆盖最广；找不到就降级为类型图标卡片
# 统一查找：PATH / ComfyUI 自带 / 本包 tools/ffmpeg，拿到本包的人不用自己装
from ..banzhang_ffmpeg import find_ffmpeg as _find_ffmpeg  # noqa: E402

FFMPEG路径 = _find_ffmpeg()

# ---- 缩略图线程池 ----
# 缩略图生成（ffmpeg 抽帧 / showwavespic / PIL 缩放）是同步阻塞操作：
# 0.2~0.4 秒一个，一个 600 文件的目录冷启动要串行跑 30 秒以上。
# 直接在 async 处理器里调用会把 aiohttp 事件循环整段冻住 —— 不只是这个节点卡，
# 队列、其他节点、前端所有请求全部停摆。所以统一丢进这个有界线程池，
# 事件循环只负责 await，界面全程可操作。并发数取 CPU 的一半（上限 6），
# 再多也只是抢进程调度，ffmpeg 单帧解码本身是单线程的。
缩略图并发数 = max(2, min(6, (os.cpu_count() or 4) // 2))
缩略图执行器 = ThreadPoolExecutor(max_workers=缩略图并发数, thread_name_prefix="bz_thumb")
# 去重扫描/合并用独立线程池：大目录哈希可能要几分钟，不能和缩略图 ffmpeg 抢线程，
# 否则缩略图高峰期扫描请求会在队列里干等，前端以为服务挂了。
扫描执行器 = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bz_scan")
# 同目录扫描结果缓存（键 = (目录, 是否递归)，60 秒内重复扫描直接返回，不重算哈希）
扫描缓存 = {}
扫描缓存秒 = 60
# 同一缓存路径正在生成时，后到的请求排队等结果，不重复起进程
生成中集合 = set()

print(f"\n{'='*40}")
print(f"### ✅ 班长媒体加载器 v5.2：服务已启动 (图/视频/音频 · ffmpeg={'有' if FFMPEG路径 else '无'} · 缩略图线程 {缩略图并发数} · 硬链接去重·扫描独立线程) ###")
print(f"{'='*40}\n")

def 清洗路径(path_str):
    if not path_str:
        return ""
    return str(path_str).strip().strip('"').strip("'")


def ComfyUI根目录():
    """input 目录的上一级即 ComfyUI 根目录；folder_paths 是路径语义的唯一权威来源。"""
    return os.path.dirname(folder_paths.get_input_directory() or os.getcwd())


def 解析文件夹路径(path_str):
    """全链路唯一的文件夹路径解析入口：空 → ComfyUI input 目录；相对 → 按 ComfyUI 根目录解析。

    原先只有列表/去重接口各自兜底了一次，节点执行侧漏掉，空路径被 join 成相对进程 CWD 的路径，
    结果一律判成 Deleted。收敛到这里，后端任何入口都不再自己判空。
    """
    文本 = 清洗路径(path_str)
    if not 文本:
        return folder_paths.get_input_directory() or os.getcwd()
    if os.path.isabs(文本):
        return os.path.normpath(文本)
    return os.path.normpath(os.path.join(ComfyUI根目录(), 文本))

非法文件名字符 = re.compile(r'[:*?"<>|]')
图片扩展名集合 = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"}
视频扩展名集合 = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv", ".wmv", ".mpg", ".mpeg", ".ts"}
音频扩展名集合 = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus", ".aiff", ".ape"}
媒体扩展名集合 = 图片扩展名集合 | 视频扩展名集合 | 音频扩展名集合
缓存上限 = 1500
缓存最长保留秒 = 30 * 24 * 3600
_上次清理时间 = 0.0
# 音频波形缩略图只解前 N 秒：整轨解码太贵，网格里也看不出区别
波形采样秒 = 60


def 媒体类型(文件名):
    """返回 image / video / audio；不认识的扩展名返回空串。"""
    扩展名 = os.path.splitext(文件名)[1].lower()
    if 扩展名 in 图片扩展名集合:
        return "image"
    if 扩展名 in 视频扩展名集合:
        return "video"
    if 扩展名 in 音频扩展名集合:
        return "audio"
    return ""


def 取MIME(路径):
    return mimetypes.guess_type(路径)[0] or "application/octet-stream"


def 自然排序键(名称):
    """按数字段拆分，让 2.png 排在 10.png 前面，而不是字典序。"""
    return [(0, int(片段)) if 片段.isdigit() else (1, 片段) for 片段 in re.split(r"(\d+)", 名称.lower())]


def 收集媒体(根目录, 是否递归):
    """收集图片/视频/音频，返回相对根目录的路径（统一用 / 分隔）；递归关闭时只看根目录一层。"""
    相对列表 = []
    for 目录, _子目录列表, 文件列表 in os.walk(根目录):
        for 文件名 in 文件列表:
            if os.path.splitext(文件名)[1].lower() in 媒体扩展名集合:
                相对列表.append(os.path.relpath(os.path.join(目录, 文件名), 根目录).replace(os.sep, "/"))
        if not 是否递归:
            break
    return 相对列表


def 相对input前缀(文件夹路径, 输入目录):
    """文件夹在 ComfyUI input 目录内时，返回它相对 input 的前缀（"" 或 "子目录/"）；
    不在其中返回 None。

    列表项名是相对该文件夹的路径，前缀 + 项名 = input 目录内可直接引用的相对
    路径。判定放在后端是因为只有后端掌握真实路径语义（盘符、大小写、软链接）。"""
    try:
        相对 = os.path.relpath(os.path.realpath(文件夹路径), os.path.realpath(输入目录))
    except ValueError:      # Windows 跨盘符没有相对路径
        return None
    if 相对 == os.curdir:
        return ""
    if 相对 == os.pardir or 相对.startswith(os.pardir + os.sep) or os.path.isabs(相对):
        return None
    return 相对.replace(os.sep, "/").rstrip("/") + "/"


def 排序媒体列表(相对列表, 根目录, 排序方式):
    def 取修改时间(相对):
        return os.path.getmtime(os.path.join(根目录, 相对.replace("/", os.sep)))
    try:
        if "名称:A-Z升序" in 排序方式:
            相对列表.sort(key=自然排序键)
        elif "名称:Z-A降序" in 排序方式:
            相对列表.sort(key=自然排序键, reverse=True)
        elif "时间:最旧优先" in 排序方式:
            相对列表.sort(key=取修改时间)
        else:
            相对列表.sort(key=取修改时间, reverse=True)
    except Exception:
        pass
    return 相对列表


def 取缓存路径(完整路径):
    """缩略图缓存名 = 版本 + 路径 + mtime + 体积 的 md5，任一变化即视为新文件。
    v2：缩略图对透明区域改铺棋盘格，升版本让旧的黑块缓存全部重新生成。"""
    try:
        文件状态 = os.stat(完整路径)
        哈希值 = hashlib.md5(f"v2_{完整路径}_{文件状态.st_mtime}_{文件状态.st_size}".encode("utf-8")).hexdigest()
        return os.path.join(缓存目录, f"{哈希值}.jpg")
    except Exception:
        return None


def 生成图片缩略图(源路径, 目标路径):
    try:
        if not 确保缓存目录():
            return False
        with Image.open(源路径) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA", "P"):
                # 透明 PNG 直接 convert("RGB") 会丢掉 alpha，透明像素落成纯黑——
                # clipspace 蒙版层的整图透明 PNG 就变成一片黑框。先铺灰阶棋盘格
                # （图像软件通用惯例）再把带 alpha 的图贴上去，透明区域一眼可辨。
                img = img.convert("RGBA")
                格 = 8
                底 = Image.new("RGB", img.size, (52, 52, 52))
                画 = ImageDraw.Draw(底)
                for y in range(0, img.size[1], 格):
                    for x in range(0, img.size[0], 格):
                        if (x // 格 + y // 格) % 2:
                            画.rectangle([x, y, x + 格 - 1, y + 格 - 1], fill=(38, 38, 38))
                底.paste(img, mask=img.getchannel("A"))
                img = 底
            elif img.mode != "RGB":
                img = img.convert("RGB")
            img.thumbnail((256, 256))
            img.save(目标路径, format="JPEG", quality=70)
        return True
    except Exception:
        return False


def 生成视频首帧(源路径, 目标路径):
    """ffmpeg 抽 0.1s 处一帧当封面，缩进 256×256 盒子（与图片缩略图同规格）。"""
    if not FFMPEG路径:
        return False
    if not 确保缓存目录():
        return False
    try:
        结果 = subprocess.run(
            [FFMPEG路径, "-y", "-loglevel", "error", "-ss", "0.1", "-i", 源路径,
             "-frames:v", "1", "-vf", "scale=256:256:force_original_aspect_ratio=decrease", 目标路径],
            capture_output=True, timeout=60,
        )
        return 结果.returncode == 0 and os.path.exists(目标路径)
    except Exception:
        return False


def 生成音频波形(源路径, 目标路径):
    """ffmpeg showwavespic 出波形 PNG，再合成到深色底存成 jpg。
    只解码前 波形采样秒 秒：showwavespic 默认会把整条音轨全解一遍（长音频实测 1~2 秒/个），
    而网格缩略图只需要一个"大概长什么样"的波形，截断后耗时固定在 0.1 秒出头。"""
    if not FFMPEG路径:
        return False
    if not 确保缓存目录():
        return False
    try:
        结果 = subprocess.run(
            [FFMPEG路径, "-y", "-loglevel", "error", "-t", str(波形采样秒), "-i", 源路径,
             "-filter_complex", "showwavespic=s=256x144:colors=0x4ade80",
             "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
            capture_output=True, timeout=60,
        )
        if 结果.returncode != 0 or not 结果.stdout:
            return False
        with Image.open(BytesIO(结果.stdout)) as 波形:
            if 波形.mode != "RGBA":
                波形 = 波形.convert("RGBA")
            画布 = Image.new("RGBA", 波形.size, (24, 24, 24, 255))
            画布.alpha_composite(波形)
            画布.convert("RGB").save(目标路径, format="JPEG", quality=80)
        return True
    except Exception:
        return False


def 生成缩略图(完整路径, 缓存文件路径, 类型):
    """按类型分派到具体生成器；供线程池调用，内部全程同步。"""
    if 类型 == "image":
        return 生成图片缩略图(完整路径, 缓存文件路径)
    if 类型 == "video":
        return 生成视频首帧(完整路径, 缓存文件路径)
    if 类型 == "audio":
        return 生成音频波形(完整路径, 缓存文件路径)
    return False


def 构造视频值(路径):
    """VIDEO 口的值：与核心 LoadVideo 一致，用 VideoFromFile 包一个惰性引用。"""
    from comfy_api.latest import InputImpl
    return InputImpl.VideoFromFile(路径)


def 解码音频(路径):
    """AUDIO 口的值：{waveform:(1,C,N) float32, sample_rate:int}。
    解码走 PyAV，逻辑与核心 LoadAudio 保持一致（本机 torchaudio 的 libtorchcodec 不可用）。"""
    import av
    with av.open(路径) as 容器:
        if not 容器.streams.audio:
            raise ValueError("文件里没有音频流")
        流 = 容器.streams.audio[0]
        采样率 = 流.codec_context.sample_rate
        声道数 = 流.channels
        块列表 = []
        for 帧 in 容器.decode(streams=流.index):
            块 = torch.from_numpy(帧.to_ndarray())
            if 块.shape[0] != 声道数:
                块 = 块.view(-1, 声道数).t()
            块列表.append(块)
        if not 块列表:
            raise ValueError("没有解出任何音频帧")
        音频 = torch.cat(块列表, dim=1)
        if 音频.dtype == torch.int16:
            音频 = 音频.float() / (2 ** 15)
        elif 音频.dtype == torch.int32:
            音频 = 音频.float() / (2 ** 31)
        else:
            音频 = 音频.float()
    return {"waveform": 音频.unsqueeze(0), "sample_rate": 采样率}


def 清理缩略图缓存():
    """按张数与时限回收 caches/；最多每 60 秒真正执行一次。"""
    global _上次清理时间
    现在 = time.time()
    if 现在 - _上次清理时间 < 60:
        return
    _上次清理时间 = 现在
    try:
        # jpg = 缩略图；mp4 = 悬停转码副本，同一批回收
        文件列表 = glob.glob(os.path.join(缓存目录, "*.jpg")) + glob.glob(os.path.join(缓存目录, "*.mp4"))
        for 文件 in 文件列表:
            try:
                if 现在 - os.path.getmtime(文件) > 缓存最长保留秒:
                    os.remove(文件)
            except Exception:
                pass
        文件列表 = [f for f in 文件列表 if os.path.exists(f)]
        if len(文件列表) > 缓存上限:
            文件列表.sort(key=os.path.getmtime)
            for 文件 in 文件列表[: len(文件列表) - 缓存上限]:
                try:
                    os.remove(文件)
                except Exception:
                    pass
    except Exception as e:
        print(f"⚠️ [班长] 缩略图缓存清理失败: {e}")

# ==========================================
# API 接口定义
# ==========================================
@PromptServer.instance.routes.post(f"{API_PREFIX}/list_images")
async def 获取图片列表接口(request):
    try:
        数据包 = await request.json()
        默认输入目录 = folder_paths.get_input_directory() or "."
        文件夹路径 = 解析文件夹路径(数据包.get("folder_path"))
        排序方式 = 数据包.get("sort_method", "时间:最新优先")
        是否递归 = bool(数据包.get("recursive", False))

        if not os.path.exists(文件夹路径):
            return web.json_response({"error": "path_not_found", "msg": "文件夹不存在"})

        相对列表 = 排序媒体列表(收集媒体(文件夹路径, 是否递归), 文件夹路径, 排序方式)
        响应 = web.json_response({名称: 媒体类型(名称) for 名称 in 相对列表})
        # 列表在 input 目录内时告诉前端引用前缀，拖拽即可零拷贝投放。
        # 头值只走 latin-1，目录名含中文必须编码。
        前缀 = 相对input前缀(文件夹路径, 默认输入目录)
        if 前缀 is not None:
            响应.headers["X-Input-Rel"] = urllib.parse.quote(前缀)
        return 响应
    except Exception as e:
        return web.json_response({})

@PromptServer.instance.routes.get(f"{API_PREFIX}/view_image")
async def 预览媒体接口(request):
    """图片/视频/音频统一的文件服务。
    ?thumbnail=true 给网格用的小图：图片缩放、视频抽首帧、音频画波形；
    不传或 false 则原样返回文件字节（拖拽跨面板投放靠这条通道）。
    缩略图生成失败返回 404，前端会退化成类型图标卡片。"""
    文件夹路径 = 解析文件夹路径(request.query.get("folder_path"))
    文件名 = request.query.get("filename")
    是否缩略图 = request.query.get("thumbnail") == "true"
    if not 文件名:
        return web.Response(status=404)
    完整路径 = os.path.join(文件夹路径, 文件名.replace("/", os.sep))
    if not os.path.isfile(完整路径):
        return web.Response(status=404)

    def 发送文件(file_path, content_type=None):
        try:
            with open(file_path, 'rb') as f:
                data = f.read()
            return web.Response(body=data, content_type=content_type or 取MIME(file_path))
        except:
            return web.Response(status=500)

    def 发送可流式文件(file_path):
        """原文件走 FileResponse：自动带 Accept-Ranges 并处理 206 分段请求。
        前端卡片内联播放 <video>/<audio> 依赖它——不支持 Range 时浏览器只能整段
        下载后才播，大文件会卡住甚至播不出，拖进度条也无效。"""
        try:
            return web.FileResponse(file_path)
        except Exception:
            return web.Response(status=500)

    if not 是否缩略图:
        return 发送可流式文件(完整路径)

    缓存文件路径 = 取缓存路径(完整路径)
    if not 缓存文件路径:
        return web.Response(status=404)
    if os.path.exists(缓存文件路径):
        return 发送文件(缓存文件路径, "image/jpeg")

    类型 = 媒体类型(文件名)
    if 类型 not in ("image", "video", "audio"):
        return web.Response(status=404)

    循环 = asyncio.get_running_loop()

    if 缓存文件路径 in 生成中集合:
        # 别的请求正在生成同一张：排队等它落盘，最多等 120 秒，不重复起 ffmpeg
        已等待 = 0.0
        while 缓存文件路径 in 生成中集合 and 已等待 < 120:
            await asyncio.sleep(0.15)
            已等待 += 0.15
        生成成功 = os.path.exists(缓存文件路径)
    else:
        生成中集合.add(缓存文件路径)
        try:
            # 生成器内部各自兜了异常；这里再包一层，任何漏网之鱼都退化成 404（前端显示类型图标），
            # 绝不让它冒成 500 打断前端加载
            try:
                生成成功 = await 循环.run_in_executor(
                    缩略图执行器, 生成缩略图, 完整路径, 缓存文件路径, 类型
                )
            except Exception as e:
                print(f"⚠️ [班长] 缩略图生成异常: {e}")
                生成成功 = False
        finally:
            生成中集合.discard(缓存文件路径)

    if not 生成成功 or not os.path.exists(缓存文件路径):
        return web.Response(status=404)
    # 缓存回收也是同步 I/O（glob + 上千次 stat），一并挪出事件循环
    循环.run_in_executor(缩略图执行器, 清理缩略图缓存)
    return 发送文件(缓存文件路径, "image/jpeg")


# ---------- 悬停转码：仅当浏览器播不动原文件（H.265 / mkv / avi…）时才走这条 ----------
# 缓存名 = 路径 + mtime + 体积 的 md5，与缩略图同机制：源文件一变即视为新文件。
转码中集合 = set()


def 取转码缓存路径(完整路径):
    try:
        文件状态 = os.stat(完整路径)
        哈希值 = hashlib.md5(
            f"transcode_{完整路径}_{文件状态.st_mtime}_{文件状态.st_size}".encode("utf-8")
        ).hexdigest()
        return os.path.join(缓存目录, f"{哈希值}.mp4")
    except Exception:
        return None


def 转码视频(源路径, 目标路径):
    """转成浏览器必播的 H.264 + AAC mp4；faststart 把 moov 挪到文件头，支持边下边播。"""
    if not FFMPEG路径:
        return False
    if not 确保缓存目录():
        return False
    try:
        结果 = subprocess.run(
            [FFMPEG路径, "-y", "-loglevel", "error", "-i", 源路径,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
             "-movflags", "+faststart", 目标路径],
            capture_output=True, timeout=1800,
        )
        return 结果.returncode == 0 and os.path.exists(目标路径)
    except Exception:
        return False
    finally:
        # 转码失败不留半截文件，避免下次误命中缓存
        try:
            if os.path.exists(目标路径) and os.path.getsize(目标路径) == 0:
                os.remove(目标路径)
        except Exception:
            pass


@PromptServer.instance.routes.get(f"{API_PREFIX}/play_video")
async def 播放视频接口(request):
    """/play_video?folder_path=&filename=
    前端 <video> 播原文件报 error 后才请求这条；同一文件只转一次，结果缓存复用。
    转码在执行器线程里跑，不阻塞 aiohttp 事件循环。"""
    文件夹路径 = 解析文件夹路径(request.query.get("folder_path"))
    文件名 = request.query.get("filename")
    if not 文件名:
        return web.Response(status=404)
    完整路径 = os.path.join(文件夹路径, 文件名.replace("/", os.sep))
    if not os.path.isfile(完整路径):
        return web.Response(status=404)

    缓存路径 = 取转码缓存路径(完整路径)
    if not 缓存路径:
        return web.Response(status=404)

    if not os.path.exists(缓存路径):
        if 缓存路径 in 转码中集合:
            # 别的请求正在转同一文件：等它落盘，不重复起 ffmpeg
            while 缓存路径 in 转码中集合:
                await asyncio.sleep(0.25)
        else:
            转码中集合.add(缓存路径)
            try:
                循环 = asyncio.get_running_loop()
                成功 = await 循环.run_in_executor(None, 转码视频, 完整路径, 缓存路径)
            finally:
                转码中集合.discard(缓存路径)
            if not 成功:
                return web.Response(status=404)

    try:
        return web.FileResponse(缓存路径)
    except Exception:
        return web.Response(status=500)

# ---------- 重复文件去重合并 ----------
# 合并方式：把重复文件替换成「指向保留文件的硬链接」。
# 关键点是路径名一个都不改 —— 节点控件里存的还是原来那个文件名，工作流 JSON 里的引用
# 也一字不动，所以不会出现"节点找不到文件"；但数据块在磁盘上只留一份，空间立刻收回。
# 相比「删掉重复的 + 改引用」安全得多：不需要扫工作流、也不存在漏改的情况。
# 副作用只有一个：这些名字现在指向同一份数据，改其中一个，其余跟着变（媒体素材不会被改）。
哈希块大小 = 1024 * 1024


def 计算文件哈希(路径):
    """blake2b 分块读，1MB 一块；大视频也不会整块进内存。"""
    哈希 = hashlib.blake2b(digest_size=16)
    try:
        with open(路径, "rb") as 文件:
            while True:
                块 = 文件.read(哈希块大小)
                if not 块:
                    break
                哈希.update(块)
        return 哈希.hexdigest()
    except Exception:
        return None


def 查找重复文件(根目录, 是否递归):
    """两级过滤：先按体积分组（体积不同必然不是同一份），只对体积相同的候选组算内容哈希。
    几百个文件里真正需要读盘的往往只有一小撮。"""
    按体积 = {}
    for 名称 in 收集媒体(根目录, 是否递归):
        完整路径 = os.path.join(根目录, 名称.replace("/", os.sep))
        try:
            大小 = os.path.getsize(完整路径)
        except Exception:
            continue
        if 大小 == 0:
            continue
        按体积.setdefault(大小, []).append((名称, 完整路径))

    分组列表 = []
    for 大小, 候选组 in 按体积.items():
        if len(候选组) < 2:
            continue
        按哈希 = {}
        for 名称, 完整路径 in 候选组:
            哈希值 = 计算文件哈希(完整路径)
            if 哈希值:
                按哈希.setdefault(哈希值, []).append((名称, 完整路径))
        for 哈希值, 条目组 in 按哈希.items():
            if len(条目组) < 2:
                continue
            # 已经合并过的（硬链接指向同一份数据）st_dev+st_ino 相同，算同一块数据。
            # 不去重的话，合并之后重扫还会把这些文件报成重复，看起来像没生效。
            按节点 = {}
            for 名称, 完整路径 in 条目组:
                try:
                    状态 = os.stat(完整路径)
                    键 = (状态.st_dev, 状态.st_ino)
                except Exception:
                    键 = ("?", 名称)
                按节点.setdefault(键, []).append(名称)
            if len(按节点) < 2:
                continue                      # 磁盘上已经只剩一份，跳过
            名称组 = sorted([名称 for 名称, _ in 条目组], key=自然排序键)
            分组列表.append({
                "hash": 哈希值,
                "size": 大小,
                "files": 名称组,
                "blocks": len(按节点),
                # 可回收 = 独立数据块数 - 1：全并成一份后，多出来的块才会被释放
                "waste": 大小 * (len(按节点) - 1),
            })
    分组列表.sort(key=lambda 组: 组["waste"], reverse=True)
    return 分组列表


def 检测硬链接支持(文件夹路径):
    """在目标目录里真建一次链接试试（跨盘 / 权限不足会失败）。用完立刻清理。"""
    测试源 = os.path.join(文件夹路径, ".bz_link_test_src")
    测试目标 = os.path.join(文件夹路径, ".bz_link_test_dst")
    try:
        with open(测试源, "wb") as 文件:
            文件.write(b"bz")
        os.link(测试源, 测试目标)
        return os.path.exists(测试目标)
    except Exception:
        return False
    finally:
        for 路径 in (测试源, 测试目标):
            try:
                if os.path.exists(路径):
                    os.remove(路径)
            except Exception:
                pass


def 合并为硬链接(保留路径, 重复路径):
    """用指向保留文件的硬链接替换重复文件；中间任何一步失败都回滚成原文件。"""
    try:
        临时路径 = 重复路径 + ".bz_dup_tmp"
        if os.path.exists(临时路径):
            os.remove(临时路径)
        os.replace(重复路径, 临时路径)          # 先把原件挪开留退路
        try:
            os.link(保留路径, 重复路径)          # 同盘硬链接，文件名保持不变
        except Exception:
            os.replace(临时路径, 重复路径)       # 回滚
            return False
        try:
            os.remove(临时路径)
        except Exception:
            pass
        return os.path.isfile(重复路径)
    except Exception as e:
        print(f"⚠️ [班长] 去重失败: {重复路径} → {e}")
        return False


@PromptServer.instance.routes.post(f"{API_PREFIX}/find_duplicates")
async def 查找重复接口(request):
    """{folder_path, recursive} → 按内容哈希分组的重复清单，含可回收字节数。"""
    try:
        数据包 = await request.json()
        文件夹路径 = 解析文件夹路径(数据包.get("folder_path"))
        是否递归 = bool(数据包.get("recursive", False))
        if not os.path.isdir(文件夹路径):
            return web.json_response({"error": "path_not_found", "msg": "文件夹不存在"})

        # 60 秒内扫过同一个目录就直接回缓存结果（合并之后由 merge 端清缓存，保证下次重扫）
        缓存键 = (文件夹路径, 是否递归)
        缓存项 = 扫描缓存.get(缓存键)
        if 缓存项 and (time.time() - 缓存项[0]) < 扫描缓存秒:
            支持链接 = 缓存项[2]
            分组列表 = 缓存项[1]
        else:
            循环 = asyncio.get_running_loop()
            分组列表 = await 循环.run_in_executor(扫描执行器, 查找重复文件, 文件夹路径, 是否递归)
            支持链接 = await 循环.run_in_executor(扫描执行器, 检测硬链接支持, 文件夹路径)
            扫描缓存[缓存键] = (time.time(), 分组列表, 支持链接)
        return web.json_response({
            "groups": 分组列表,
            "group_count": len(分组列表),
            "waste": sum(组["waste"] for 组 in 分组列表),
            "support_link": 支持链接,
        })
    except Exception as e:
        return web.json_response({"error": "failed", "msg": str(e)})


@PromptServer.instance.routes.post(f"{API_PREFIX}/merge_duplicates")
async def 合并重复接口(request):
    """{folder_path, keep, replace:[...]} → 逐个替换成硬链接，返回明细与回收字节数。
    整批在线程池里跑，进度靠前端分批调用体现。"""
    try:
        数据包 = await request.json()
        文件夹路径 = 解析文件夹路径(数据包.get("folder_path"))
        if not os.path.isdir(文件夹路径):
            return web.json_response({"error": "path_not_found", "msg": "文件夹不存在"})
        保留名 = 数据包.get("keep")
        替换列表 = [名 for 名 in (数据包.get("replace") or []) if 名 and 名 != 保留名]
        if not 保留名 or not 替换列表:
            return web.json_response({"error": "bad_request", "msg": "参数不完整"})
        保留路径 = os.path.join(文件夹路径, 保留名.replace("/", os.sep))
        if not os.path.isfile(保留路径):
            return web.json_response({"error": "not_found", "msg": "保留的文件不存在"})

        结果 = {"ok": [], "fail": [], "saved": 0}

        def 批量合并():
            for 名称 in 替换列表:
                目标路径 = os.path.join(文件夹路径, 名称.replace("/", os.sep))
                if not os.path.isfile(目标路径):
                    结果["fail"].append({"name": 名称, "msg": "文件已不存在"})
                    continue
                try:
                    大小 = os.path.getsize(目标路径)
                except Exception:
                    大小 = 0
                if 合并为硬链接(保留路径, 目标路径):
                    结果["ok"].append(名称)
                    结果["saved"] += 大小
                else:
                    结果["fail"].append({"name": 名称, "msg": "硬链接失败（跨盘或权限不足）"})

        循环 = asyncio.get_running_loop()
        await 循环.run_in_executor(扫描执行器, 批量合并)
        if 结果["ok"]:
            扫描缓存.pop((文件夹路径, True), None)
            扫描缓存.pop((文件夹路径, False), None)
        return web.json_response({
            "success": len(结果["fail"]) == 0,
            "merged": len(结果["ok"]),
            "failed": 结果["fail"],
            "saved": 结果["saved"],
        })
    except Exception as e:
        return web.json_response({"error": "failed", "msg": str(e)})


@PromptServer.instance.routes.post(f"{API_PREFIX}/delete_image")
async def 删除图片接口(request):
    try:
        数据包 = await request.json()
        文件夹路径 = 解析文件夹路径(数据包.get("folder_path"))
        文件名 = 数据包.get("filename")
        if not 文件名:
            return web.json_response({"success": False})
        完整路径 = os.path.join(文件夹路径, 文件名)
        if not os.path.exists(完整路径):
            return web.json_response({"success": True})
        try:
            try:
                缓存 = 取缓存路径(完整路径)
                if 缓存 and os.path.exists(缓存):
                    os.remove(缓存)
            except:
                pass
            os.remove(完整路径)
            return web.json_response({"success": True})
        except Exception as e:
            return web.json_response({"success": False, "msg": str(e)})
    except:
        return web.json_response({"success": False})


@PromptServer.instance.routes.post(f"{API_PREFIX}/rename_image")
async def 重命名图片接口(request):
    """重命名单张图片。新名可带子目录前缀（递归浏览时保留原目录），缺扩展名则沿用旧扩展名。"""
    try:
        数据包 = await request.json()
        文件夹路径 = 解析文件夹路径(数据包.get("folder_path"))
        旧名 = str(数据包.get("filename") or "").replace("\\", "/").strip().strip("/")
        新名 = str(数据包.get("new_name") or "").replace("\\", "/").strip().strip("/")
        if not 旧名 or not 新名:
            return web.json_response({"success": False, "msg": "参数不完整"})
        新名片段列表 = [片段 for 片段 in 新名.split("/") if 片段]
        if not 新名片段列表 or any(片段 in (".", "..") or 非法文件名字符.search(片段) for 片段 in 新名片段列表):
            return web.json_response({"success": False, "msg": '文件名含非法字符 : * ? " < > |'})
        新名 = "/".join(新名片段列表)

        旧目录 = os.path.dirname(旧名)
        新目录 = os.path.dirname(新名)
        if not 新目录 and 旧目录:
            新名 = f"{旧目录}/{新名}"
        if not os.path.splitext(新名)[1]:
            新名 += os.path.splitext(旧名)[1]

        旧路径 = os.path.join(文件夹路径, 旧名.replace("/", os.sep))
        新路径 = os.path.join(文件夹路径, 新名.replace("/", os.sep))
        if not os.path.isfile(旧路径):
            return web.json_response({"success": False, "msg": "原文件不存在"})
        if os.path.abspath(新路径) == os.path.abspath(旧路径):
            return web.json_response({"success": True, "filename": 新名})

        目标目录绝对 = os.path.abspath(os.path.dirname(新路径))
        if not os.path.isdir(目标目录绝对):
            return web.json_response({"success": False, "msg": "目标子目录不存在"})
        if os.path.exists(新路径):
            return web.json_response({"success": False, "msg": "目标文件名已存在"})

        旧缓存 = 取缓存路径(旧路径)
        os.rename(旧路径, 新路径)
        if 旧缓存 and os.path.exists(旧缓存):
            try:
                os.remove(旧缓存)
            except Exception:
                pass
        return web.json_response({"success": True, "filename": 新名})
    except Exception as e:
        return web.json_response({"success": False, "msg": str(e)})

@PromptServer.instance.routes.post(f"{API_PREFIX}/upload_image")
async def 上传图片接口(request):
    try:
        reader = await request.multipart()
        image_data = None
        filename = None
        target_folder = None

        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == 'image':
                filename = part.filename or "upload.png"
                buffer = BytesIO()
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    buffer.write(chunk)
                buffer.seek(0)
                image_data = buffer
            elif part.name == 'folder_path':
                target_folder = 解析文件夹路径(await part.text())

        if image_data is None:
            return web.json_response({"success": False, "msg": "No file"})

        默认目录 = folder_paths.get_input_directory() or "."
        保存目录 = target_folder if target_folder else 默认目录
        if not os.path.exists(保存目录):
            try:
                os.makedirs(保存目录)
            except:
                保存目录 = 默认目录

        name, ext = os.path.splitext(filename)
        cnt = 1
        final_name = filename
        while os.path.exists(os.path.join(保存目录, final_name)):
            final_name = f"{name}_{cnt}{ext}"
            cnt += 1

        with open(os.path.join(保存目录, final_name), 'wb') as f:
            f.write(image_data.read())

        return web.json_response({"success": True, "filename": final_name})
    except Exception as e:
        print(f"❌ Upload Fail: {e}")
        return web.json_response({"success": False, "msg": str(e)})


@PromptServer.instance.routes.post(f"{API_PREFIX}/import_image")
async def 导入媒体接口(request):
    """为「拖拽到画布」准备原文件：返回可直接填进加载节点的 input 相对路径。
    图片/视频/音频通用；不在 input 目录内时把原文件复制进去（同目录优先，重名加序号）。"""
    try:
        数据包 = await request.json()
        文件夹路径 = 解析文件夹路径(数据包.get("folder_path"))
        文件名 = 数据包.get("filename")
        源路径 = os.path.abspath(os.path.join(文件夹路径, str(文件名).replace("/", os.sep)))
        if not os.path.isfile(源路径):
            return web.json_response({"success": False, "msg": "原文件不存在"})

        输入目录 = os.path.abspath(folder_paths.get_input_directory() or "input")
        try:
            相对路径 = os.path.relpath(源路径, 输入目录)
            在输入目录内 = not 相对路径.startswith("..")
        except ValueError:
            在输入目录内 = False

        if 在输入目录内:
            return web.json_response({"success": True, "value": 相对路径.replace("\\", "/"), "copied": False})

        os.makedirs(输入目录, exist_ok=True)
        名称, 扩展名 = os.path.splitext(os.path.basename(源路径))
        计数 = 1
        目标名 = os.path.basename(源路径)
        while os.path.exists(os.path.join(输入目录, 目标名)):
            目标名 = f"{名称}_{计数}{扩展名}"
            计数 += 1
        shutil.copy2(源路径, os.path.join(输入目录, 目标名))
        return web.json_response({"success": True, "value": 目标名, "copied": True})
    except Exception as e:
        return web.json_response({"success": False, "msg": str(e)})


# ==========================================
# 节点类: 媒体加载器（图片 / 视频 / 音频）
# ==========================================
class BanzhangVisualLoader:
    @classmethod
    def INPUT_TYPES(s):
        # 默认值用相对路径 "input"：存进工作流的是相对 ComfyUI 根目录的路径，
        # 换机器/换盘符照样能跑；真实绝对路径由后端 解析文件夹路径() 统一还原。
        return {
            "required": {
                "📂 文件夹路径": ("STRING", {"default": "input", "multiline": False,
                                          "tooltip": "留空或填相对路径时按 ComfyUI 根目录解析，默认即 input 目录；也可填绝对路径"}),
                "📄 指定文件": ("STRING", {"default": "", "tooltip": "在网格里点选的图片 / 视频 / 音频文件名"}),
                "🔃 排序方式": (["时间:最新优先", "时间:最旧优先", "名称:A-Z升序", "名称:Z-A降序"], {"default": "时间:最新优先"}),
                "🔍 缩略图尺寸": ("INT", {"default": 60, "min": 40, "max": 240, "step": 10, "display": "slider"}),
                "📁 含子目录": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "VIDEO", "AUDIO")
    RETURN_NAMES = ("🖼️ 图像", "😷 遮罩", "📝 文件名", "🎬 视频", "🎵 音频")
    FUNCTION = "执行加载"
    CATEGORY = "👨‍🏫班长/图像处理"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """把源文件的 mtime(纳秒) 与体积纳入缓存键：同名文件被覆盖后会重跑。"""
        folder = 解析文件夹路径(kwargs.get("📂 文件夹路径"))
        filename = kwargs.get("📄 指定文件")
        if not filename:
            return ""
        try:
            文件状态 = os.stat(os.path.join(folder, str(filename).replace("/", os.sep)))
            return f"{文件状态.st_mtime_ns}_{文件状态.st_size}"
        except Exception:
            return ""

    def 执行加载(self, **kwargs):
        """按扩展名分派：图片照旧出 IMAGE/MASK；视频出 🎬、音频出 🎵，
        非对应类型的口一律给 64×64 空白，📝 文件名三种都给。"""
        folder = 解析文件夹路径(kwargs.get("📂 文件夹路径"))
        filename = kwargs.get("📄 指定文件")
        空白图 = lambda: torch.zeros((1, 64, 64, 3))
        空白遮罩 = lambda: torch.zeros((1, 64, 64))
        if not filename:
            return (空白图(), 空白遮罩(), "", None, None)

        path = os.path.join(folder, str(filename).replace("/", os.sep))
        if not os.path.isfile(path):
            return (空白图(), 空白遮罩(), "Deleted", None, None)

        基名 = os.path.splitext(os.path.basename(str(filename)))[0]
        类型 = 媒体类型(filename)

        if 类型 in ("video", "audio"):
            try:
                if 类型 == "video":
                    return (空白图(), 空白遮罩(), 基名, 构造视频值(path), None)
                return (空白图(), 空白遮罩(), 基名, None, 解码音频(path))
            except Exception as e:
                print(f"⚠️ [班长] 加载 {filename} 失败: {e}")
                return (空白图(), 空白遮罩(), "Error", None, None)

        try:
            with Image.open(path) as img:
                img = ImageOps.exif_transpose(img)
                imgs, masks = [], []
                for frame in ImageSequence.Iterator(img):
                    frame = frame.convert("RGBA")
                    img_np = np.array(frame).astype(np.float32) / 255.0
                    imgs.append(torch.from_numpy(img_np[:,:,:3])[None,])
                    if 'A' in frame.getbands():
                        mask_np = np.array(frame.getchannel('A')).astype(np.float32) / 255.0
                        masks.append(torch.from_numpy(mask_np)[None,])
                    else:
                        masks.append(torch.ones((1, frame.height, frame.width), dtype=torch.float32))

            out_img = torch.cat(imgs, dim=0) if len(imgs) > 1 else imgs[0]
            out_mask = torch.cat(masks, dim=0) if len(masks) > 1 else masks[0]
            return (out_img, out_mask, 基名, None, None)
        except:
            err = torch.full((1,64,64,3), 0.5)
            err[:,:,0] = 1.0
            return (err, torch.zeros((1,64,64)), "Error", None, None)


# 注册映射
NODE_CLASS_MAPPINGS = {
    "BanzhangVisualLoader": BanzhangVisualLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangVisualLoader": "🗂️ 班长媒体加载器 (v5.0)"
}
