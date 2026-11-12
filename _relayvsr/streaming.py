"""RelayVSR 流式超分调度：时间块切分、空间分块、重叠帧融合、写回视频。

从 Comfyui-Relay-VSR 的 streaming.py 按职责拆出，逻辑未改动。
"""

import os
import numpy as np
import comfy.utils
import folder_paths

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
        frames, audio = reader.read_chunk(chunk_len)
        if not frames:
            raise ValueError("RelayVSR: 输入视频没有可解码的帧")

        height, width = frames[0].shape[-2:]
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

        while True:
            check()
            outputs = upscale_chunk(
                engine, frames, sr_ratio, chunk_len, seed, tiles_y, tiles_x, y_alphas, x_alphas, check
            )
            if pending is not None:
                for index, previous in enumerate(pending):
                    weight = (index + 0.5) / overlap
                    blended = previous.astype(np.float32) * (1.0 - weight) + outputs[index].astype(np.float32) * weight
                    outputs[index] = np.clip(blended, 0, 255).round().astype(np.uint8)

            next_frames, next_audio = reader.read_chunk(chunk_len - overlap)
            if next_frames:
                if overlap:
                    writer.write(outputs[:-overlap], audio)
                    pending = outputs[-overlap:]
                else:
                    writer.write(outputs, audio)
                frames = (frames[-overlap:] if overlap else []) + next_frames
                audio = next_audio
                written += len(outputs) - overlap
            else:
                writer.write(outputs, audio + next_audio)
                written += len(outputs)
            if progress is not None:
                progress.update_absolute(min(written, reader.frame_estimate))
            if not next_frames:
                break

        writer.finish()
        writer = None
        return out_path, file_name, subfolder
    finally:
        reader.close()
        if writer is not None:
            writer.abort()
