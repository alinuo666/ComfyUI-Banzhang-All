"""RelayVSR 流式超分调度：时间块切分、空间分块、重叠帧融合、写回视频。

从 Comfyui-Relay-VSR 的 streaming.py 按职责拆出，逻辑未改动。
"""

import os
from itertools import chain

import numpy as np
import comfy.utils
import folder_paths

from .shotcut import ShotCutDetector
from .tiling import axis_alphas, axis_tiles, stitch
from .video_io import CODECS, PRESETS, FrameSequenceReader, VideoReader, VideoWriter


def open_video_source(video, codec):
    """VIDEO 入口：按容器决定音轨能否原样封装，帧率读文件自身。"""
    return VideoReader(video, CODECS[codec][1])


def open_image_source(frames, fps):
    """IMAGE 入口：内存帧序列，没有容器也没有音轨，帧率由调用方给。"""
    return FrameSequenceReader(frames, fps)


def reference_count(frame_count, chunk_len):
    """本次 restore 会用几个参考帧：首帧 1 个，之后每多开一个窗口再加 1 个。

    流式一个时间块固定 2 个；图像超分喂单张图时是 1 个。KV 槽位按这个数分配，
    1080p 每少一个槽省 2.8 GiB（单图因此省 8.4 GiB）。
    """
    return 1 + -(-max(0, frame_count - 1) // max(1, chunk_len - 1))


def upscale_chunk(engine, frames, sr_ratio, chunk_len, seed, tiles_y, tiles_x, y_alphas, x_alphas, check):
    refs = reference_count(len(frames), chunk_len)
    if len(tiles_y) == 1 and len(tiles_x) == 1:
        return list(engine.restore(frames, seed, sr_ratio, chunk_len, check, max_references=refs))

    tiles = []
    for y0, y1 in tiles_y:
        for x0, x1 in tiles_x:
            check()
            tile_input = [frame[:, y0:y1, x0:x1].contiguous() for frame in frames]
            tiles.append(list(engine.restore(tile_input, seed, sr_ratio, chunk_len, check, max_references=refs)))

    outputs = []
    for offset in range(len(frames)):
        outputs.append(stitch([tile[offset] for tile in tiles], tiles_y, tiles_x, y_alphas, x_alphas, sr_ratio))
        for tile in tiles:
            tile[offset] = None
    return outputs


def _output_size(width, height, sr_ratio, upscale_width):
    if not upscale_width:
        return width * sr_ratio, height * sr_ratio
    out_width = max(2, int(round(upscale_width / 2)) * 2)
    out_height = max(2, int(round(out_width * height / width / 2)) * 2)
    return out_width, out_height


def _shot_blocks(reader, chunk_len, overlap):
    """按镜头边界产块，yield (frames, audio, 尾留帧数)。

    尾留帧数＝本块末尾有几帧要留给下一块重算并交叉淡化。硬切处归零：把两个镜头叠在一起会出鬼影，
    而且新镜头的第一帧必须自己当参考，不能沿用旧镜头的。
    音频不按帧对齐（解封装读到哪算哪），所以整批随块发出、发过即清，总量与顺序都不变。
    frames 为空的那一次是纯音频收尾：重采样器尾部样本只在最后一次空读里吐出来。
    硬切标记在读帧时逐帧算好、与帧一一对应；重叠携带帧复用旧标记，绝不重判 ——
    重判会丢掉运动历史，把持续大运动误判成硬切，切出比携带帧数还短的块。
    """
    detector = ShotCutDetector()
    buf, marks, audio = [], [], []
    eof = False
    while True:
        while not eof and len(buf) < chunk_len:
            got, got_audio = reader.read_chunk(chunk_len - len(buf))
            audio.extend(got_audio)
            if got:
                buf.extend(got)
                marks.extend(detector.is_cut(frame) for frame in got)
            else:
                eof = True
        if not buf:
            if audio:
                yield [], audio, 0
            return
        cut = next((i for i in range(1, len(marks)) if marks[i]), None)
        if cut is not None:
            yield buf[:cut], audio, 0
            buf, marks, audio = buf[cut:], marks[cut:], []
            continue
        tail = 0 if eof else overlap
        yield buf, audio, tail
        if eof:
            return
        buf, marks, audio = buf[len(buf) - tail:], marks[len(marks) - tail:], []


def stream_upscale(
    engine,
    reader,
    upscale_width,
    sr_ratio,
    chunk_len,
    seed,
    chunk_overlap,
    spatial_grid_cols,
    spatial_grid_rows,
    spatial_overlap,
    codec,
    crf,
    preset,
    filename_prefix,
    check,
):
    """reader 为已打开的帧源（open_video_source / open_image_source），函数结束时由本函数关闭。

    返回 (输出文件路径, 文件名, 子目录)。
    """
    chunk_len = max(2, int(chunk_len))
    overlap = min(max(0, int(chunk_overlap)), chunk_len - 1)

    writer = None
    try:
        blocks = _shot_blocks(reader, chunk_len, overlap)
        first = next(blocks, None)
        if first is None or not first[0]:
            raise ValueError("RelayVSR: 输入视频没有可解码的帧")

        height, width = first[0][0].shape[-2:]
        out_width, out_height = _output_size(width, height, sr_ratio, upscale_width)
        tiles_y = axis_tiles(height, spatial_grid_rows, spatial_overlap, engine.geometry.wan_stride)
        tiles_x = axis_tiles(width, spatial_grid_cols, spatial_overlap, engine.geometry.wan_stride)
        y_alphas = axis_alphas(tiles_y, sr_ratio)
        x_alphas = axis_alphas(tiles_x, sr_ratio)

        folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), out_width, out_height
        )
        file_name = "{}_{:05}_.{}".format(name, counter, CODECS[codec][1])
        out_path = os.path.join(folder, file_name)
        writer = VideoWriter(
            out_path, out_width, out_height, reader.fps, codec, crf, preset,
            reader.audio_layout, reader.audio_rate,
            reader.audio_stream if reader.audio_copy else None,
        )

        progress = comfy.utils.ProgressBar(reader.frame_estimate) if reader.frame_estimate else None
        written = 0
        pending = None

        for frames, audio, tail in chain((first,), blocks):
            check()
            if not frames:
                writer.write([], audio)
                continue
            outputs = upscale_chunk(
                engine, frames, sr_ratio, chunk_len, seed, tiles_y, tiles_x, y_alphas, x_alphas, check
            )
            if pending is not None:
                for index, previous in enumerate(pending):
                    weight = (index + 0.5) / len(pending)
                    blended = previous.astype(np.float32) * (1.0 - weight) + outputs[index].astype(np.float32) * weight
                    outputs[index] = np.clip(blended, 0, 255).round().astype(np.uint8)

            keep = len(outputs) - tail
            writer.write(outputs[:keep], audio)
            pending = outputs[keep:] if tail else None
            written += keep
            if progress is not None:
                progress.update_absolute(min(written, reader.frame_estimate))

        writer.finish()
        writer = None
        return out_path, file_name, subfolder
    finally:
        reader.close()
        if writer is not None:
            writer.abort()
