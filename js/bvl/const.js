/**
 * 常量表：全是死数据，改这里不影响别处逻辑。
 *
 * 用得到的抽屉字段：无（本文件不依赖任何运行时状态）
 */

import { BZ_MEDIA_MIME as 拖拽数据类型 } from "../bz_media_ref.js";

export { 拖拽数据类型 };

export const 目标节点名称 = "BanzhangVisualLoader";
export const API_前缀 = "/banzhang_api";

// 拖到画布空白处时，每种媒体各建哪种节点、值写进哪个控件
export const 拖出目标表 = {
    image: { 节点: "LoadImage", 控件: "image" },
    video: { 节点: "LoadVideo", 控件: "file" },
    audio: { 节点: "LoadAudio", 控件: "audio" },
};

// 反过来：遇到这些加载节点时，能接哪种媒体、值写进哪个控件
export const 加载节点表 = {
    LoadImage: { 类型: "image", 控件: "image" },
    LoadVideo: { 类型: "video", 控件: "file" },
    LoadAudio: { 类型: "audio", 控件: "audio" },
};

export const 类型角标 = { video: "▶", audio: "♪" };
export const 类型图标 = { image: "🖼", video: "🎞", audio: "🎵" };

export const 媒体MIME表 = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", bmp: "image/bmp", gif: "image/gif", tiff: "image/tiff",
    mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
    avi: "video/x-msvideo", webm: "video/webm", m4v: "video/x-m4v",
    flv: "video/x-flv", wmv: "video/x-ms-wmv", mpg: "video/mpeg", mpeg: "video/mpeg",
    ts: "video/mp2t",
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg",
    m4a: "audio/mp4", aac: "audio/aac", wma: "audio/x-ms-wma", opus: "audio/opus",
    aiff: "audio/aiff", ape: "audio/x-ape"
};
