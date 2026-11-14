# -*- coding: utf-8 -*-
"""
👨‍🏫 班长智能视频分镜切割模块
基于 PySceneDetect 实现视频智能场景检测与分割
将原 Tkinter GUI 工具的核心能力封装为 ComfyUI 节点
"""

import os
import json
import folder_paths

HAS_SCENEDETECT = False
try:
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector
    from scenedetect.video_splitter import split_video_ffmpeg
    from scenedetect.frame_timecode import FrameTimecode
    HAS_SCENEDETECT = True
except ImportError:
    pass

VIDEO_EXTENSIONS = ('.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv')


def _get_video_files():
    input_dir = folder_paths.get_input_directory()
    if os.path.exists(input_dir):
        files = [f for f in os.listdir(input_dir) if f.lower().endswith(VIDEO_EXTENSIONS)]
        if files:
            return files
    return ["no_video_file"]


class BanzhangSceneDetectSplit:
    """🍿 智能视频分镜切割 — 自动检测视频中的场景切换点并切割为独立分镜文件"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "📂 视频文件": (_get_video_files(),),
                "🎚️ 画面变化阈值": ("FLOAT", {"default": 27.0, "min": 1.0, "max": 100.0, "step": 0.5,
                                         "tooltip": "数值越小越灵敏，切割的分镜越多"}),
                "⏱️ 最小场景长度(秒)": ("FLOAT", {"default": 1.5, "min": 0.1, "max": 60.0, "step": 0.1,
                                            "tooltip": "小于此时长的场景将被合并"}),
                "📼 输出格式": (["MP4", "MOV", "AVI"], {"default": "MP4"}),
                "✂️ 镜头前修减时间(秒)": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                                "tooltip": "每个分镜开头减去的秒数，用于去除转场残留"}),
            },
            "optional": {
                "📁 自定义视频路径": ("STRING", {"default": "", "multiline": False,
                                               "placeholder": "留空则使用上方选择的文件，或粘贴完整视频路径"}),
                "📁 自定义输出目录": ("STRING", {"default": "", "multiline": False,
                                               "placeholder": "留空则保存到 ComfyUI/output/分镜切割/"}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("📄 分镜文件列表(JSON)", "🔢 场景数量", "📋 场景详情")
    FUNCTION = "split_scenes"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = "智能检测视频中的场景切换点，自动切割为独立分镜视频文件。基于 PySceneDetect (ContentDetector) 算法。"

    def split_scenes(self, 视频文件, 画面变化阈值, 最小场景长度, 输出格式, 镜头前修减时间,
                     自定义视频路径="", 自定义输出目录=""):

        if not HAS_SCENEDETECT:
            return ("❌ 未安装 PySceneDetect 库\n请执行: pip install scenedetect[opencv]", 0, "⚠️ 依赖缺失")

        if 自定义视频路径 and 自定义视频路径.strip():
            video_path = 自定义视频路径.strip()
        else:
            video_path = folder_paths.get_annotated_filepath(视频文件.strip())

        if not video_path or not os.path.isfile(video_path):
            return (f"❌ 视频文件不存在: {video_path}", 0, "⚠️ 文件未找到")

        if not video_path.lower().endswith(VIDEO_EXTENSIONS):
            return (f"❌ 不支持的视频格式: {os.path.splitext(video_path)[1]}", 0, "⚠️ 格式不支持")

        if 自定义输出目录 and 自定义输出目录.strip():
            output_base = 自定义输出目录.strip()
        else:
            output_base = os.path.join(folder_paths.get_output_directory(), "分镜切割")

        base_filename = os.path.splitext(os.path.basename(video_path))[0]
        save_dir = os.path.join(output_base, base_filename)
        os.makedirs(save_dir, exist_ok=True)

        output_template = os.path.join(save_dir, f"Scene-$SCENE_NUMBER.{输出格式.lower()}")

        try:
            video = open_video(video_path)
            scene_manager = SceneManager()
            scene_manager.add_detector(
                ContentDetector(
                    threshold=画面变化阈值,
                    min_scene_len=int(最小场景长度 * video.frame_rate)
                )
            )
            scene_manager.detect_scenes(video, show_progress=False)
            scene_list = scene_manager.get_scene_list()
            raw_scene_count = len(scene_list)

            if 镜头前修减时间 > 0 and scene_list:
                adjusted_scenes = []
                trim_frames = int(镜头前修减时间 * video.frame_rate)
                for start, end in scene_list:
                    new_start_frame = start.get_frames() + trim_frames
                    if new_start_frame < end.get_frames():
                        new_start = FrameTimecode(new_start_frame, video.frame_rate)
                        adjusted_scenes.append((new_start, end))
                scene_list = adjusted_scenes

            scene_count = len(scene_list)

            details_parts = []
            details_parts.append(f"📹 视频文件: {base_filename}")
            details_parts.append(f"🎚️ 画面变化阈值: {画面变化阈值}")
            details_parts.append(f"⏱️ 最小场景长度: {最小场景长度}s")
            details_parts.append(f"🔢 原始检测场景数: {raw_scene_count}")
            if 镜头前修减时间 > 0:
                details_parts.append(f"✂️ 镜头前修减: {镜头前修减时间}s")
            details_parts.append(f"🎬 最终分镜数: {scene_count}")
            details_parts.append(f"📁 输出目录: {save_dir}")
            details_parts.append("─" * 40)

            scene_paths = []

            if scene_list:
                split_video_ffmpeg(
                    video_path, scene_list,
                    output_file_template=output_template,
                    show_progress=False, show_output=False
                )

                for i, (start, end) in enumerate(scene_list, 1):
                    scene_file = os.path.join(save_dir, f"Scene-{i:03d}.{输出格式.lower()}")
                    if os.path.exists(scene_file):
                        scene_paths.append(scene_file)

                    start_sec = start.get_seconds()
                    end_sec = end.get_seconds()
                    duration = end_sec - start_sec
                    details_parts.append(
                        f"  场景{i:03d}  {start_sec:8.2f}s → {end_sec:8.2f}s  |  时长 {duration:.2f}s"
                    )

                details_parts.append("─" * 40)
                details_parts.append(f"✅ 切割完成！共生成 {len(scene_paths)} 个分镜文件")
            else:
                details_parts.append("⚠️ 未检测到任何场景切换点")
                details_parts.append("💡 建议：降低「画面变化阈值」参数以获得更多分镜")

            scene_info = "\n".join(details_parts)
            scene_list_json = json.dumps(scene_paths, ensure_ascii=False, indent=2)

            return (scene_list_json, scene_count, scene_info)

        except Exception as e:
            error_detail = f"❌ 处理失败\n文件: {base_filename}\n错误: {str(e)}"
            return (json.dumps([], ensure_ascii=False), 0, error_detail)


class BanzhangSceneDetectOnly:
    """🔍 视频场景检测 — 仅分析场景切换点，不进行切割"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "📂 视频文件": (_get_video_files(),),
                "🎚️ 画面变化阈值": ("FLOAT", {"default": 27.0, "min": 1.0, "max": 100.0, "step": 0.5,
                                         "tooltip": "数值越小越灵敏，检测到的场景点越多"}),
                "⏱️ 最小场景长度(秒)": ("FLOAT", {"default": 1.5, "min": 0.1, "max": 60.0, "step": 0.1,
                                            "tooltip": "小于此时长的场景将被合并"}),
            },
            "optional": {
                "📁 自定义视频路径": ("STRING", {"default": "", "multiline": False,
                                               "placeholder": "留空则使用上方选择的文件，或粘贴完整视频路径"}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "STRING", "STRING")
    RETURN_NAMES = ("📋 场景时间码(JSON)", "🔢 场景数量", "📊 场景详情", "⏱️ 场景时间轴")
    FUNCTION = "detect_scenes"
    CATEGORY = "👨‍🏫班长/视频处理"
    DESCRIPTION = "仅检测视频中的场景切换时间点，不进行文件切割。可用于预览分析后再决定是否切割。"

    def detect_scenes(self, 视频文件, 画面变化阈值, 最小场景长度, 自定义视频路径=""):

        if not HAS_SCENEDETECT:
            return ("[]", 0, "⚠️ 依赖缺失", "请安装: pip install scenedetect[opencv]")

        if 自定义视频路径 and 自定义视频路径.strip():
            video_path = 自定义视频路径.strip()
        else:
            video_path = folder_paths.get_annotated_filepath(视频文件.strip())

        if not video_path or not os.path.isfile(video_path):
            return ("[]", 0, "⚠️ 文件未找到", f"路径: {video_path}")

        base_filename = os.path.splitext(os.path.basename(video_path))[0]

        try:
            video = open_video(video_path)
            scene_manager = SceneManager()
            scene_manager.add_detector(
                ContentDetector(
                    threshold=画面变化阈值,
                    min_scene_len=int(最小场景长度 * video.frame_rate)
                )
            )
            scene_manager.detect_scenes(video, show_progress=False)
            scene_list = scene_manager.get_scene_list()
            scene_count = len(scene_list)

            timecodes = []
            timeline_parts = ["视频时间轴 (秒):", ""]
            details_parts = [f"📹 视频: {base_filename}",
                           f"🎚️ 阈值: {画面变化阈值}",
                           f"⏱️ 最小场景长度: {最小场景长度}s",
                           f"🔢 检测到 {scene_count} 个场景",
                           "─" * 40]

            total_duration = 0
            durations = []

            for i, (start, end) in enumerate(scene_list, 1):
                start_sec = start.get_seconds()
                end_sec = end.get_seconds()
                duration = end_sec - start_sec
                durations.append(duration)
                total_duration += duration
                timecodes.append({
                    "scene": i,
                    "start": round(start_sec, 3),
                    "end": round(end_sec, 3),
                    "duration": round(duration, 3)
                })
                details_parts.append(
                    f"  场景{i:03d}  {start_sec:8.2f}s → {end_sec:8.2f}s  |  时长 {duration:.2f}s"
                )

                bar_len = 40
                if total_duration > 0:
                    bar_pos = int((start_sec / (end_sec if scene_count == 1 else scene_list[-1][1].get_seconds())) * bar_len)
                else:
                    bar_pos = 0
                bar_width = max(1, int((duration / (scene_list[-1][1].get_seconds())) * bar_len)) if scene_list else 0
                bar = "·" * bar_pos + "▓" * bar_width
                timeline_parts.append(f"  {bar} {start_sec:6.1f}s ({duration:.1f}s)")

            if durations:
                avg_duration = total_duration / scene_count
                details_parts.append("─" * 40)
                details_parts.append(f"📊 总时长: {total_duration:.2f}s")
                details_parts.append(f"📊 平均场景: {avg_duration:.2f}s")
                details_parts.append(f"📊 最长场景: {max(durations):.2f}s")
                details_parts.append(f"📊 最短场景: {min(durations):.2f}s")

                if scene_count < 5:
                    details_parts.append("💡 检测到的场景较少，可降低阈值获得更多分镜")
                elif scene_count > 50:
                    details_parts.append("💡 检测到的场景较多，可提高阈值减少分镜")

            scene_info = "\n".join(details_parts)
            timecodes_json = json.dumps(timecodes, ensure_ascii=False, indent=2)
            timeline = "\n".join(timeline_parts) if timeline_parts else "无场景数据"

            return (timecodes_json, scene_count, scene_info, timeline)

        except Exception as e:
            return ("[]", 0, f"❌ 分析失败: {str(e)}", "")


NODE_CLASS_MAPPINGS = {
    "BanzhangSceneDetectSplit": BanzhangSceneDetectSplit,
    "BanzhangSceneDetectOnly": BanzhangSceneDetectOnly,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangSceneDetectSplit": "🍿 智能视频分镜切割",
    "BanzhangSceneDetectOnly": "🔍 视频场景检测",
}
