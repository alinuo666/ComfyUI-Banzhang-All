# -*- coding: utf-8 -*-
"""把流式吐出的帧直接压成 mp4（NVENC 硬编码）。

跟"先攒一整段再编码"的区别：这里 ffmpeg 起一个常驻子进程，帧算出来就往它的
stdin 里喂原始 rgb 字节，编码在 GPU（NVENC）上边收边压。所以内存是 O(1) 的，
跑一万帧也只占一个窗口的大小。

编码质量：h264_nvenc + 恒定 QP 16（肉眼近乎无损，H.264 最通用）。
选 H.264 不选 HEVC：Windows 自带播放器放 HEVC 要单独装解码包，H.264 开箱即放。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading

try:
    import folder_paths
except Exception:
    folder_paths = None

# 恒定 QP，值越小越接近无损（0 = 真无损）。16 是业界公认的"视觉透明"点：
# 再往下文件体积涨得飞快，肉眼收益却趋近于零。
_QP = "16"


def find_ffmpeg() -> str:
    """优先用 ComfyUI 便携版自带的 ffmpeg（保证存在、与 VHS 同款），找不到再退回 PATH。"""
    candidates = []
    if folder_paths is not None:
        # 便携版根目录 = ComfyUI 根目录的上一级
        root = os.path.dirname(os.path.abspath(folder_paths.base_path))
        candidates += [
            os.path.join(root, "python_embeded", "ffmpeg", "bin", "ffmpeg.exe"),
            os.path.join(root, "python_embeded", "ffmpeg.exe"),
        ]
    # 统一查找兜底：PATH / ComfyUI 自带 / 本包 tools/ffmpeg
    from ..banzhang_ffmpeg import find_ffmpeg
    exe = find_ffmpeg()
    if exe:
        candidates.append(exe)
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return "ffmpeg"


def _dump_audio_wav(audio, tmp_dir: str, dur=None) -> str:
    """把 VHS 的 AUDIO（{waveform: (1, C, N) float, sample_rate}）落成临时 wav。

    dur = 视频时长（秒），可选。给了就把音频补齐（尾部补静音）或截断到正好 dur，
    保证音画同长——否则 ffmpeg 的 -shortest 会在音频播完时提前退出，
    而节点还在往 stdin 写帧，把管道写断（BrokenPipe）。不给则原样落盘。
    """
    import wave

    import torch

    wf = audio["waveform"].detach().cpu().float()
    sr = int(audio.get("sample_rate", 44100))
    if wf.dim() == 3:
        wf = wf.squeeze(0)                       # (C, N)
    if wf.dim() == 1:
        wf = wf.unsqueeze(0)                     # (1, N)
    if wf.shape[0] > wf.shape[1]:
        wf = wf.t()                              # 容错：偶发 (N, C)

    if dur is not None:
        target = int(round(dur * sr))
        c, n = wf.shape
        if n < target:                            # 音频短：尾部补静音
            wf = torch.cat([wf, torch.zeros(c, target - n, dtype=wf.dtype)], dim=1)
        elif n > target:                          # 音频长：截断
            wf = wf[:, :target]

    pcm = (wf.t().contiguous().clamp(-1, 1).numpy() * 32767).astype("<i2")
    path = os.path.join(tmp_dir, f"flashvsr_audio_{os.getpid()}.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return path


class Mp4Writer:
    """常驻 ffmpeg 子进程，喂 rgb24 字节流，产出单个 mp4。"""

    def __init__(self, path: str, w: int, h: int, fps: int = 30, audio=None, n_frames: int = None):
        self.path = path
        self.w, self.h, self.fps = w, h, fps
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)

        # 视频时长（秒）。知道总帧数才能把音频对齐到同长，避免 -shortest 提前退出
        dur = (n_frames / fps) if n_frames else None

        cmd = [
            find_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
            "-i", "-",
        ]
        self._audio_tmp = None
        if audio is not None:
            self._audio_tmp = _dump_audio_wav(audio, tempfile.gettempdir(), dur)
            cmd += ["-i", self._audio_tmp]

        cmd += ["-map", "0:v:0"]
        if audio is not None:
            cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]

        cmd += [
            "-c:v", "h264_nvenc", "-preset", "p7",
            "-rc", "constqp", "-qp", _QP, "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]
        # 音频已对齐到视频时长，不需要 -shortest（它会因为音频短而提前退出、写断管道）
        if audio is not None and dur is None:
            cmd += ["-shortest"]
        cmd += [path]

        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self._finished = False
        self._stderr = []
        # 后台把 ffmpeg 的 stderr 读走，避免它写满管道阻塞；同时攒下来供报错时透传
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        try:
            for line in self.proc.stderr:
                try:
                    self._stderr.append(line.decode(errors="replace").rstrip())
                except Exception:
                    pass
        except Exception:
            pass

    def _err_text(self) -> str:
        return "\n".join(self._stderr[-30:])

    def write_rgb(self, data: bytes):
        """data 必须是 W*H*3 字节的连续 rgb24。"""
        if self._finished:
            raise RuntimeError("Mp4Writer 已结束，不能再写帧")
        try:
            self.proc.stdin.write(data)
        except BrokenPipeError:
            detail = self._err_text() or "（ffmpeg 无输出）"
            raise RuntimeError(f"ffmpeg 提前退出。详情：\n{detail}")

    def finish(self) -> str:
        if self._finished:
            return self.path
        self._finished = True
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.wait(timeout=1200)
        self._cleanup_audio()
        if self.proc.returncode != 0:
            detail = self._err_text() or "（ffmpeg 无输出）"
            raise RuntimeError(f"ffmpeg 编码失败（返回码 {self.proc.returncode}）。详情：\n{detail}")
        return self.path

    def abort(self):
        """用户中断时调用：杀掉子进程、删掉半成品文件。"""
        if self._finished:
            return
        self._finished = True
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            pass
        if os.path.exists(self.path):
            try:
                os.remove(self.path)
            except Exception:
                pass
        self._cleanup_audio()

    def _cleanup_audio(self):
        if self._audio_tmp and os.path.exists(self._audio_tmp):
            try:
                os.remove(self._audio_tmp)
            except Exception:
                pass
