# -*- coding: utf-8 -*-
"""
🎓 ComfyUI 班长全家桶 (Banzhang All-in-One)
================================================================================
📅 版本: v2.1.1 整合版
👨‍🏫 作者: 班长
💻 适用: ComfyUI

⚠️⚠️⚠️ AI 开发必读（人工也一样）⚠️⚠️⚠️
    新增 / 修改任何节点前：
      1. 先读本包根目录  AGENTS.md
      2. 带界面的节点（addDOMWidget / 自定义绘制 / 自定义 widget）
         必须再读  docs/AI节点开发铁律.md  并照抄其第 11 节骨架
    那里规定了新旧两套前端的尺寸声明、刷新恢复、隐藏 widget 合法写法、
    端口中文化等强制规则——违反会导致节点底部空白 / 面板裁切 / 刷新丢配置。
================================================================================

🎯 整合内容:
    ✅ 音频处理节点 (音频循环收集器、音频定长与补齐)
    ✅ 潜在空间工具 (潜在空间保存/加载)
    ✅ 图像处理节点 (全能分辨率、视频-图像桥接器)
    ✅ 文本工具 (智能保存、区间提取、分批、分割)
    ✅ 字幕工具 (视频字幕添加器、语音转脚本)
    ✅ 可视化加载器
    ✅ 图像编辑API (Banana2全能版)
    ✅ 智能视频分镜切割 (场景检测与视频分割)
    ✅ 显存管理 (清理内存 + 顶栏监控)
    ✅ 显存守卫 (显存预留 + 快速中断，合并节点)
    ✅ 开发工具 (URL下载、文件上传、执行时间统计)
    ✅ Topaz 星光超分 (星光2.6/Astra 视频增强放大, 合并自 ComfyUI-TopazStarlight)
    ✅ MiniMax H3 预览覆盖 (采样逐帧实时预览, 合并自 ComfyUI-MiniMaxH3-PreviewOverride)
    ✅ MiniMax H3 Latent 放大 (2D/3D 神经网络潜空间放大, 单节点 backend 切换, 合并自 Comfyui_Minimax_h3_latent_Upscaler)
    ✅ SelfLift-Avatar 渐进采样器 (H3 音视频遮罩 + 高分辨率空间分块, 合并自 selflift-Avatar v0.1.4)
    ✅ SelfLift 多级完整采样 (每级各跑一条完整曲线, 「各级步数」填几个数算几级, H3)
    ✅ 图片多级渐进补丁 (MODEL → MODEL 接官方 K 采样器, 图片模型的 SelfLift-zero 多级推广)
    ✅ 图片高清放大二采重绘 (⚡插值/upscale_models模型放大 → VAE 编码(可分块), 图片版终极放大)
    ✅ 图片分块二采 (大图潜空间切块逐块采样 + 核心区余弦窗融合, 显存峰值≈单瓦片, 防 4K OOM)
    ✅ RTX 视频特效三件套 (超分降噪去模糊 / 转HDR / AI插帧, 显卡硬件加速不吃模型显存,
       需 NVIDIA RTX 显卡 + pip 装 nvidia-vfx; 改编自 Apache-2.0 的 ComfyUI_Nvidia_VFX_Nodes)
    ✅ 插帧 RIFE/EMA (开源模型, 不挑显卡, 20/30/40/50 系与 A 卡都能跑, 是 30 系插帧的解决方案;
       流式边解码边插帧边编码, 内存/显存峰值与片长无关;
       RIFE 可选 v4.26(最新·画质最佳) / v4.25(动漫最强·最稳) 两版权重,
       EMA-VFI(CVPR2023) 画质更高一档;
       权重缺失时自动下载; 分别改编自 MIT 的 Practical-RIFE 与 Apache-2.0 的 EMA-VFI)
    ✅ FlashVSR 扩散超分 (自包含, 权重读 models/FlashVSR, 不依赖官方插件与外部程序)
    ✅ DLSS5 帧生成插帧 (NVIDIA NGX DLSS-FG 2/3/4 倍与指定目标帧率; 引擎文件自备放 models/dlss5/dlssg,
       官方支持 RTX 40/50, RTX 30/20 系可打社区补丁 dlssg_for_sm86 用上——已实测通过;
       改编自 MIT 协议的 ComfyUI-RH-DLSS5)
================================================================================
"""

# ==============================================================================
# 导入所有模块的节点映射
# ==============================================================================

# 0. 内置调度器（必须最先执行：后面有模块在 import 阶段就给「调度器」下拉
#    取了一次列表快照，晚于它注册的名字永远进不了那个节点的下拉）
try:
    from . import banzhang_schedulers
    banzhang_schedulers.install()
except Exception as e:
    print(f"⚠️ [班长全家桶] 内置调度器加载失败: {e}")

# 1. 音频节点
try:
    from . import banzhang_audio_nodes
    Audio_Cls = getattr(banzhang_audio_nodes, 'NODE_CLASS_MAPPINGS', {})
    Audio_Names = getattr(banzhang_audio_nodes, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 音频节点加载失败: {e}")
    Audio_Cls, Audio_Names = {}, {}

# 2. 潜在空间工具
try:
    from . import banzhang_latent_tools
    Latent_Cls = getattr(banzhang_latent_tools, 'NODE_CLASS_MAPPINGS', {})
    Latent_Names = getattr(banzhang_latent_tools, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 潜在空间工具加载失败: {e}")
    Latent_Cls, Latent_Names = {}, {}

# 3. 分辨率与图像处理
try:
    from . import banzhang_resolution
    Res_Cls = getattr(banzhang_resolution, 'NODE_CLASS_MAPPINGS', {})
    Res_Names = getattr(banzhang_resolution, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 分辨率节点加载失败: {e}")
    Res_Cls, Res_Names = {}, {}

# 4. 文本工具
try:
    from . import banzhang_text_tools
    Text_Cls = getattr(banzhang_text_tools, 'NODE_CLASS_MAPPINGS', {})
    Text_Names = getattr(banzhang_text_tools, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 文本工具加载失败: {e}")
    Text_Cls, Text_Names = {}, {}

# 4.5 剧本全流程生图（整合节点）
try:
    from . import banzhang_script_pipeline
    ScriptAsset_Cls = getattr(banzhang_script_pipeline, 'NODE_CLASS_MAPPINGS', {})
    ScriptAsset_Names = getattr(banzhang_script_pipeline, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 剧本全流程节点加载失败: {e}")
    ScriptAsset_Cls, ScriptAsset_Names = {}, {}

# 4.6 剧本全流程·本地生图引擎
try:
    from . import banzhang_local_engines
    LocalEngine_Cls = getattr(banzhang_local_engines, 'NODE_CLASS_MAPPINGS', {})
    LocalEngine_Names = getattr(banzhang_local_engines, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 本地生图引擎节点加载失败: {e}")
    LocalEngine_Cls, LocalEngine_Names = {}, {}

# 5. 字幕工具
try:
    from . import banzhang_subtitle
    Sub_Cls = getattr(banzhang_subtitle, 'NODE_CLASS_MAPPINGS', {})
    Sub_Names = getattr(banzhang_subtitle, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 字幕工具加载失败: {e}")
    Sub_Cls, Sub_Names = {}, {}

# 6. 可视化加载器
try:
    from . import banzhang_visual_loader
    Vis_Cls = getattr(banzhang_visual_loader, 'NODE_CLASS_MAPPINGS', {})
    Vis_Names = getattr(banzhang_visual_loader, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 可视化加载器加载失败: {e}")
    Vis_Cls, Vis_Names = {}, {}

# 7. 图像编辑API
try:
    from . import banzhang_image_api
    API_Cls = getattr(banzhang_image_api, 'NODE_CLASS_MAPPINGS', {})
    API_Names = getattr(banzhang_image_api, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 图像API节点加载失败: {e}")
    API_Cls, API_Names = {}, {}

# 8. 显存守护工具函数 (无节点，被显存守卫调用)
try:
    from . import banzhang_fast_terminate
    Terminate_Cls, Terminate_Names = {}, {}
except Exception as e:
    print(f"⚠️ [班长全家桶] 显存守护工具加载失败: {e}")
    Terminate_Cls, Terminate_Names = {}, {}

# 9. 图像处理工具
try:
    from . import banzhang_image_splitter
    Splitter_Cls = getattr(banzhang_image_splitter, 'NODE_CLASS_MAPPINGS', {})
    Splitter_Names = getattr(banzhang_image_splitter, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 图像拆分器节点加载失败: {e}")
    Splitter_Cls, Splitter_Names = {}, {}


# 10. AI翻译器工具 (包含万能空节点、抓取神器、AI全能生成、Qwen3VL配置)
try:
    from . import banzhang_translator
    Trans_Cls = getattr(banzhang_translator, 'NODE_CLASS_MAPPINGS', {})
    Trans_Names = getattr(banzhang_translator, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] AI翻译器节点加载失败: {e}")
    Trans_Cls, Trans_Names = {}, {}

# 11. 额外工具 (音频保存、音频拼接、两宫格分割、替换首尾帧)
try:
    from . import banzhang_extra_tools
    Extra_Cls = getattr(banzhang_extra_tools, 'NODE_CLASS_MAPPINGS', {})
    Extra_Names = getattr(banzhang_extra_tools, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 额外工具节点加载失败: {e}")
    Extra_Cls, Extra_Names = {}, {}

# 12. 视频工具 (视频合并、音乐播放器、图像对比)
try:
    from . import banzhang_video_tools
    Video_Cls = getattr(banzhang_video_tools, 'NODE_CLASS_MAPPINGS', {})
    Video_Names = getattr(banzhang_video_tools, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 视频工具节点加载失败: {e}")
    Video_Cls, Video_Names = {}, {}

# 13. 智能视频分镜切割 (场景检测与分割)
try:
    from . import banzhang_scene_splitter
    Scene_Cls = getattr(banzhang_scene_splitter, 'NODE_CLASS_MAPPINGS', {})
    Scene_Names = getattr(banzhang_scene_splitter, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 视频分镜切割节点加载失败: {e}")
    Scene_Cls, Scene_Names = {}, {}

# 14. 显存管理 (显存预留、清理显存、清理内存 + 后台监控)
try:
    from . import banzhang_vram_reserved
    Vram_Cls = getattr(banzhang_vram_reserved, 'NODE_CLASS_MAPPINGS', {})
    Vram_Names = getattr(banzhang_vram_reserved, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 显存管理节点加载失败: {e}")
    Vram_Cls, Vram_Names = {}, {}

# 15. 显存管理（全能系统净化 + 显存守卫）
try:
    from . import banzhang_vram_cleaner
    CleanVram_Cls = getattr(banzhang_vram_cleaner, 'NODE_CLASS_MAPPINGS', {})
    CleanVram_Names = getattr(banzhang_vram_cleaner, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 显存管理节点加载失败: {e}")
    CleanVram_Cls, CleanVram_Names = {}, {}

# 15.5 顶栏净化接口（「显存 / 内存」胶囊旁两个按钮的后端）
# 单独 try：这文件炸了只丢两个按钮，不能连累上面两个清理节点
try:
    from . import banzhang_purge_api  # noqa: F401  注册 /banzhang/purge/{mode}
except Exception as e:
    print(f"⚠️ [班长全家桶] 顶栏净化按钮接口加载失败（按钮会无反应，其它功能不受影响）: {e}")

# 16. 类型转换器 (万能转 String/Int/Float/Bool)
try:
    from . import banzhang_type_converter
    Conv_Cls = getattr(banzhang_type_converter, 'NODE_CLASS_MAPPINGS', {})
    Conv_Names = getattr(banzhang_type_converter, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 类型转换器节点加载失败: {e}")
    Conv_Cls, Conv_Names = {}, {}

# 16.5 互斥选路器 (N选1直通，通用任意类型，双击改名)
try:
    from . import banzhang_route_switch
    RouteSwitch_Cls = getattr(banzhang_route_switch, 'NODE_CLASS_MAPPINGS', {})
    RouteSwitch_Names = getattr(banzhang_route_switch, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 互斥选路器节点加载失败: {e}")
    RouteSwitch_Cls, RouteSwitch_Names = {}, {}

# 17. 开发工具 (URL下载、文件上传、执行时间统计)
try:
    from . import banzhang_dev_utils
    DevUtils_Cls = getattr(banzhang_dev_utils, 'NODE_CLASS_MAPPINGS', {})
    DevUtils_Names = getattr(banzhang_dev_utils, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 开发工具节点加载失败: {e}")
    DevUtils_Cls, DevUtils_Names = {}, {}

# 18. KSampler Sigmas 补丁 (内置 KSampler 恢复 sigmas 端口)
try:
    from . import banzhang_ksampler_patch
except Exception as e:
    print(f"⚠️ [班长全家桶] KSampler Sigmas 补丁加载失败: {e}")

# 20. 显存安全 LoRA 加载器 (实时融合，规避加速 LoRA 预融合导致的 OOM)
try:
    from . import banzhang_lora_loader
    LoraSafe_Cls = getattr(banzhang_lora_loader, 'NODE_CLASS_MAPPINGS', {})
    LoraSafe_Names = getattr(banzhang_lora_loader, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 显存安全 LoRA 加载器加载失败: {e}")
    LoraSafe_Cls, LoraSafe_Names = {}, {}

# 21. CGlide 视频工具集 (合并自 ComfyUI-CGlide)
try:
    from . import (
        csglide_seed,
        csglide_cast, csglide_join, csglide_media_rack, csglide_tailref,
    )
    Glide_Cls, Glide_Names = {}, {}
    for _m in (csglide_seed,
               csglide_cast, csglide_join, csglide_media_rack, csglide_tailref):
        Glide_Cls.update(getattr(_m, 'NODE_CLASS_MAPPINGS', {}))
        Glide_Names.update(getattr(_m, 'NODE_DISPLAY_NAME_MAPPINGS', {}))
except Exception as e:
    print(f"⚠️ [班长全家桶] CGlide 节点加载失败: {e}")
    Glide_Cls, Glide_Names = {}, {}

# 21a-4. H3 音频轴切片（口型轨按净长切、配乐轨连续铺）：只有接口、没有节点。
# 单独成块，不并进上面的 CGlide 元组 —— 那里任一模块出错会连坐五个 CGlide 节点。
try:
    from . import banzhang_audio_cut
except Exception as e:
    print(f"⚠️ [班长全家桶] 音频切片加载失败: {e}")

# 21-legacy. H3 导演台（经典版）：2026-10-07 版导演台，与现行导演台并存、互不冲突。
# 三处独立，保证与现行版零耦合：
#   · 节点名 CSGlideCastLegacyCS（现行版是 CSGlideCastCS）
#   · 路由   /banzhang/h3mc/latest_latent_legacy
#   · 存档   output/h3_context_legacy/（不与现行版共用续拍存档）
try:
    from . import csglide_cast_legacy
    LegacyCast_Cls = getattr(csglide_cast_legacy, 'NODE_CLASS_MAPPINGS', {})
    LegacyCast_Names = getattr(csglide_cast_legacy, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 导演台（经典版）加载失败: {e}")
    LegacyCast_Cls, LegacyCast_Names = {}, {}

# 21a. H3 段落调取（只读；写档统一由 💾 H3 续拍存档负责）
try:
    from . import csglide_clip
    Clip_Cls = getattr(csglide_clip, 'NODE_CLASS_MAPPINGS', {})
    Clip_Names = getattr(csglide_clip, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 段落调取加载失败: {e}")
    Clip_Cls, Clip_Names = {}, {}

# 21a-2. H3 文案台（提示词独立节点：媒体架 → 文案台 → 导演台）
try:
    from . import csglide_desk
    Desk_Cls = getattr(csglide_desk, 'NODE_CLASS_MAPPINGS', {})
    Desk_Names = getattr(csglide_desk, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 文案台加载失败: {e}")
    Desk_Cls, Desk_Names = {}, {}

# 21a-3. H3 AI 制片中枢（N1 制片中枢 / N2a 资产入库 / N2b 资产架 / N3 DAG编排器 / N4 段尾归位）
try:
    from . import banzhang_producer
    Producer_Cls = getattr(banzhang_producer, 'NODE_CLASS_MAPPINGS', {})
    Producer_Names = getattr(banzhang_producer, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 AI 制片中枢加载失败: {e}")
    Producer_Cls, Producer_Names = {}, {}

# CGlide 服务端路由 (/cglide/recent_outputs、/cglide/adopt_output、/cglide/probe)，仅注册路由不注册节点
try:
    from . import csglide_adopt  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] CGlide 路由加载失败: {e}")

# 媒体架缩略图路由 (/cglide/thumb)，仅注册路由不注册节点。
# 自带 /view?preview= 只压编码不缩尺寸，几十张原图能把浏览器内存吃满（20261020）。
try:
    from . import csglide_thumb  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] 缩略图路由加载失败: {e}")

# 媒体架素材上传路由 (/cglide/asset_upload)，仅注册路由不注册节点。
# 落盘前按内容哈希判同名冲突，同名不同内容先问用户「替换/新增」，
# 不再盲目覆盖（微信同名图互相顶掉丢图的根因修复，20261112）。
try:
    from . import csglide_asset_upload  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] 素材上传路由加载失败: {e}")

# CGlide 续接合成剪辑面板路由 (/cglide/join/info、/thumb、/waveform)，仅注册路由不注册节点
try:
    from . import csglide_join_panel  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] 续接剪辑面板路由加载失败: {e}")

# 21b. H3 钉帧遮罩（长片时间轴地基：改一段不动后面的数学保证）
try:
    from . import banzhang_h3_pin
    Pin_Cls = getattr(banzhang_h3_pin, 'NODE_CLASS_MAPPINGS', {})
    Pin_Names = getattr(banzhang_h3_pin, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 钉帧遮罩加载失败: {e}")
    Pin_Cls, Pin_Names = {}, {}

# 21c. H3 漂移控制（段交界无缝：随去噪 sigma 动态重算前缀 mask，根治硬跳）
try:
    from . import banzhang_h3_drift
    Drift_Cls = getattr(banzhang_h3_drift, 'NODE_CLASS_MAPPINGS', {})
    Drift_Names = getattr(banzhang_h3_drift, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 漂移控制加载失败: {e}")
    Drift_Cls, Drift_Names = {}, {}

# CGlide 长片段落档案路由 (/cglide/chain/summary、/clip、/update、/film、/resize、
# /seam、/current、/lock、/pending、/export_plan、/export、/sync_check)，仅注册路由不注册节点
try:
    from . import csglide_chain  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] 长片段落档案路由加载失败: {e}")

# 裸跑自动收片：直接点 ComfyUI 运行按钮时也要按当前段归档，否则时间轴不出现画面
try:
    from . import csglide_autocollect  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] 裸跑自动收片钩子加载失败: {e}")

# 22. H3 SLA 注意力加速（内部走官方 comfy-kitchen sol-attn，合并自 ComfyUI-H3-SLA-Attention）
try:
    from . import banzhang_sla_attention
    Sla_Cls = getattr(banzhang_sla_attention, 'NODE_CLASS_MAPPINGS', {})
    Sla_Names = getattr(banzhang_sla_attention, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 SLA 注意力节点加载失败: {e}")
    Sla_Cls, Sla_Names = {}, {}

# 24. 孤海实用工具整组已于 20261112 移除（万能滑条／忽略多组／取色器）

# 25. 注释虚拟节点 (后端桩：仅用于节点库归类，渲染由 js/banzhang_note.js 接管)
try:
    from . import banzhang_note
    Note_Cls = getattr(banzhang_note, 'NODE_CLASS_MAPPINGS', {})
    Note_Names = getattr(banzhang_note, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 注释节点加载失败: {e}")
    Note_Cls, Note_Names = {}, {}

# 26. Topaz 星光超分已于 20261112 移除：依赖专有商业引擎，外部无人调用
Topaz_Cls, Topaz_Names = {}, {}

# 27. MiniMax H3 预览覆盖 (采样逐帧实时预览, 合并自 ComfyUI-MiniMaxH3-PreviewOverride)
try:
    from . import banzhang_mmh3_preview
    H3Prev_Cls = getattr(banzhang_mmh3_preview, 'NODE_CLASS_MAPPINGS', {})
    H3Prev_Names = getattr(banzhang_mmh3_preview, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] MiniMax H3 预览覆盖节点加载失败: {e}")
    H3Prev_Cls, H3Prev_Names = {}, {}

# 28. SelfLift 渐进提升（MODEL → MODEL 补丁节点，配合原生采样器；依赖 selflift/ 子包）
try:
    from . import banzhang_selflift
    SelfLift_Cls = getattr(banzhang_selflift, 'NODE_CLASS_MAPPINGS', {})
    SelfLift_Names = getattr(banzhang_selflift, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] SelfLift 渐进提升节点加载失败: {e}")
    SelfLift_Cls, SelfLift_Names = {}, {}

# 29. H3 Latent 放大 (2D/3D 合一) —— 单节点 backend 下拉切换 2D 主干(仅空间) / 3D 主干(时空联合)，合并自 Comfyui_Minimax_h3_latent_Upscaler
try:
    from . import banzhang_h3_latent_upscaler_3d
    H3Latent_Cls = getattr(banzhang_h3_latent_upscaler_3d, 'NODE_CLASS_MAPPINGS', {})
    H3Latent_Names = getattr(banzhang_h3_latent_upscaler_3d, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 Latent放大节点加载失败: {e}")
    H3Latent_Cls, H3Latent_Names = {}, {}

# 30. Qwen Image 2.1 编辑台 (参考图走 H3 媒体架/面板槽位，与导演台同一套素材接入口径)
try:
    from . import csglide_qwen
    Qwen_Cls = getattr(csglide_qwen, 'NODE_CLASS_MAPPINGS', {})
    Qwen_Names = getattr(csglide_qwen, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] Qwen 编辑台加载失败: {e}")
    Qwen_Cls, Qwen_Names = {}, {}

# 31. H3 终极放大（内置纯插值放大 + 空间分块重采样；只注册「参数 + 主节点」两个）
try:
    from . import banzhang_mmh3_upscale
    _H3Up_Cls = getattr(banzhang_mmh3_upscale, 'NODE_CLASS_MAPPINGS', {})
    _H3Up_Names = getattr(banzhang_mmh3_upscale, 'NODE_DISPLAY_NAME_MAPPINGS', {})
    H3Up_Cls = {k: v for k, v in _H3Up_Cls.items()
                if k in ("BanZhang_MMH3_UpscaleParams", "BanZhang_MMH3_Upscale")}
    H3Up_Names = {k: v for k, v in _H3Up_Names.items() if k in H3Up_Cls}
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 终极放大节点加载失败: {e}")
    H3Up_Cls, H3Up_Names = {}, {}

# 清掉 ComfyUI 自定义节点翻译的 lru_cache（app/custom_node_manager.py 的
# build_translations 带 @lru_cache(maxsize=1)）：locales/*/nodeDefs.json 改过
# 之后，光刷新浏览器不生效，控件中文名会一直卡在旧缓存上。这里在节点模块
# 每次加载时主动清一次，配合前端「刷新节点定义」即可免整进程重启。
try:
    from app.custom_node_manager import CustomNodeManager as _CNMgr
    _CNMgr.build_translations.cache_clear()
except Exception:
    pass

# 32. 「💾 续拍存档」节点已于 20261112 移除：写盘已内置进 🎬 H3 VAE 快速解码。
#     _h3mc/ 目录必须保留 —— 导演台的潜空间续写算术、钉帧切片、栅格校对仍直接 import 它。
H3MC_Cls, H3MC_Names = {}, {}

# 33. 自定义 Sigma 曲线 (前端可视化画曲线，输出 SIGMAS + 步数，直连 KSampler sigmas 口)
try:
    from . import banzhang_sigmas_custom
    Sigma_Cls = getattr(banzhang_sigmas_custom, 'NODE_CLASS_MAPPINGS', {})
    Sigma_Names = getattr(banzhang_sigmas_custom, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 自定义 Sigma 曲线节点加载失败: {e}")
    Sigma_Cls, Sigma_Names = {}, {}

# 34. SelfLift-Avatar 渐进采样器（独立采样器节点，不是 MODEL 补丁；合并自 slmonker/selflift-Avatar v0.1.4）
#     与 28 项的 SelfLift 补丁不冲突：那边挂在原生采样器前面，这边自己就是采样器。
#     上游的 H3 TST 节点不注册：班长全家桶已移除 TST（开销大、收益不明显），
#     只保留 KJ 的 H3 显存补丁，即「💾 H3 显存优化」节点。
#     想启用上游原版 TST，把下面两行 pop 去掉即可（代码在 _selflift_avatar/h3_tst.py）。
try:
    from . import _selflift_avatar
    _SLAV_Cls = dict(getattr(_selflift_avatar, 'NODE_CLASS_MAPPINGS', {}))
    _SLAV_Names = dict(getattr(_selflift_avatar, 'NODE_DISPLAY_NAME_MAPPINGS', {}))
    _SLAV_Cls.pop("SelfLiftAvatarH3TST", None)
    _SLAV_Names.pop("SelfLiftAvatarH3TST", None)
    from .banzhang_selflift_avatar_zh import apply_zh as _slav_apply_zh
    _slav_apply_zh(_SLAV_Cls, _SLAV_Names)
except Exception as e:
    print(f"⚠️ [班长全家桶] SelfLift-Avatar 采样器加载失败: {e}")
    _SLAV_Cls, _SLAV_Names = {}, {}

# 34b. 图片多级渐进补丁（MODEL → MODEL，接官方 K 采样器；与 34 项同一套算法）
#     与 34 项的区别：那边是独立采样器节点（自己就是采样器，参数自带），
#     这边是补丁：挂在 MODEL 上，步数 / 负面词 / 降噪强度都交给官方 K 采样器管，
#     也能配合自定义 Sigma 曲线等节点。依赖 34 项同款的 _selflift_avatar 上游。
try:
    from . import banzhang_selflift_image_patch
    _SLAVPatch_Cls = getattr(banzhang_selflift_image_patch, 'NODE_CLASS_MAPPINGS', {})
    _SLAVPatch_Names = getattr(banzhang_selflift_image_patch, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 图片多级渐进补丁加载失败: {e}")
    _SLAVPatch_Cls, _SLAVPatch_Names = {}, {}

# 35. H3 VAE 快速解码 (可调瓦片 + 解码时 PixelShuffle 2x 放大, 合并自 ComfyUI-MiniMaxH3_LatentUpscaler)
try:
    from . import banzhang_h3_vae_decode
    H3VAEDec_Cls = getattr(banzhang_h3_vae_decode, 'NODE_CLASS_MAPPINGS', {})
    H3VAEDec_Names = getattr(banzhang_h3_vae_decode, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 VAE 快速解码节点加载失败: {e}")
    H3VAEDec_Cls, H3VAEDec_Names = {}, {}

# 36. FlashVSR 扩散超分 (自包含, 权重读 models/FlashVSR, 不依赖官方插件与外部程序)
try:
    from . import banzhang_flashvsr
    FlashVSR_Cls = getattr(banzhang_flashvsr, 'NODE_CLASS_MAPPINGS', {})
    FlashVSR_Names = getattr(banzhang_flashvsr, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] FlashVSR 扩散超分节点加载失败: {e}")
    FlashVSR_Cls, FlashVSR_Names = {}, {}

# 37. DLSS5 帧生成插帧 (NVIDIA NGX DLSS-FG, 需自备 models/dlss5/dlssg 引擎文件;
#     RTX 40/50 官方支持, RTX 30 及更早不支持)
try:
    from . import banzhang_dlss5_fg
    DLSS5FG_Cls = getattr(banzhang_dlss5_fg, 'NODE_CLASS_MAPPINGS', {})
    DLSS5FG_Names = getattr(banzhang_dlss5_fg, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] DLSS5 帧生成插帧节点加载失败: {e}")
    DLSS5FG_Cls, DLSS5FG_Names = {}, {}

# 38. 图片高清放大（二采重绘）(「放大模型」下拉: ⚡插值档/upscale_models 神经网络模型档,
#     → VAE 编码(可分块); 二采 denoise 交官方 K 采样器; 渐进省显存另接 34b 图片渐进补丁)
try:
    from . import banzhang_image_upscale
    HiresUp_Cls = getattr(banzhang_image_upscale, 'NODE_CLASS_MAPPINGS', {})
    HiresUp_Names = getattr(banzhang_image_upscale, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 图片高清放大二采节点加载失败: {e}")
    HiresUp_Cls, HiresUp_Names = {}, {}

# 38b. 图片分块二采 (潜空间二维网格切块, 每块独立采样, 核心区独占 + 余弦过渡窗融合;
#     显存峰值≈单瓦片, 防 4K OOM; 采样循环走官方 comfy.samplers.sample)
try:
    from . import banzhang_image_tiled_ksampler
    TiledKS_Cls = getattr(banzhang_image_tiled_ksampler, 'NODE_CLASS_MAPPINGS', {})
    TiledKS_Names = getattr(banzhang_image_tiled_ksampler, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 图片分块二采节点加载失败: {e}")
    TiledKS_Cls, TiledKS_Names = {}, {}

# 39. RTX 视频特效三件套 (NVIDIA RTX SDK 硬件加速: 超分/降噪/去模糊 + 转HDR + AI插帧;
#     需 NVIDIA RTX 显卡, 依赖 nvidia-vfx 未安装时本模块不注册节点并给出安装提示)
try:
    from . import banzhang_nvidia_vfx
    VFX_Cls = getattr(banzhang_nvidia_vfx, 'NODE_CLASS_MAPPINGS', {})
    VFX_Names = getattr(banzhang_nvidia_vfx, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] RTX 视频特效节点加载失败: {e}")
    VFX_Cls, VFX_Names = {}, {}

# 40. 插帧 RIFE/EMA (开源模型, 不挑显卡, 30 系插帧的解决方案; 权重缺失时自动下载)
#     RIFE: v4.26 / v4.25 双版权重可选;  EMA-VFI: 画质更高一档(固定单精度)
try:
    from . import banzhang_rife
    RIFE_Cls = getattr(banzhang_rife, 'NODE_CLASS_MAPPINGS', {})
    RIFE_Names = getattr(banzhang_rife, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] RIFE 插帧节点加载失败: {e}")
    RIFE_Cls, RIFE_Names = {}, {}

# 41. YuE2 智能乐谱中枢 (一个节点收口 ABC：智能路由文生规划 / 翻唱转谱 / 手动 / 直生)
try:
    from . import banzhang_yue2_smart
    SmartPlan_Cls = getattr(banzhang_yue2_smart, 'NODE_CLASS_MAPPINGS', {})
    SmartPlan_Names = getattr(banzhang_yue2_smart, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] YuE2 智能乐谱中枢加载失败: {e}")
    SmartPlan_Cls, SmartPlan_Names = {}, {}

# 42. SelfLift 多级完整采样（每级各跑一条完整曲线，级间学习式换纸）
#     与 28 项「多级渐进」互补：那边是几段共享一条曲线、前几段跑切片；
#     本节点每级各跑完整曲线（「各级步数」填几个数就是几级，例 3,3,3），
#     每次换纸抬上去的都是一张画完的图。复用 28 项同一套
#     换纸/分块/钳位实现（继承 _SelfLiftMultiStage，只重写采样主流程）。
try:
    from . import banzhang_selflift_fullstage
    SelfLiftFull_Cls = getattr(banzhang_selflift_fullstage, 'NODE_CLASS_MAPPINGS', {})
    SelfLiftFull_Names = getattr(banzhang_selflift_fullstage, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] SelfLift 双完整采样节点加载失败: {e}")
    SelfLiftFull_Cls, SelfLiftFull_Names = {}, {}

# 43. H3 画面微调已于 20261112 移除
Tweaks_Cls, Tweaks_Names = {}, {}

# 44. Veda 稀疏注意力已于 20261112 移除
Veda_Cls, Veda_Names = {}, {}

# 45. 📈 活动监视器·内存显存 (画布纯显示节点：psutil + pynvml 采样显存/内存/GPU利用率/温度，
#     前端 1 秒一拉，苹果活动监视器风格面板；对外提供 打标记() 给净化🧹联动，
#     曲线上标「净化前/净化后」)
try:
    from . import banzhang_mem_graph
    MemGraph_Cls = getattr(banzhang_mem_graph, 'NODE_CLASS_MAPPINGS', {})
    MemGraph_Names = getattr(banzhang_mem_graph, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 内存显存曲线节点加载失败: {e}")
    MemGraph_Cls, MemGraph_Names = {}, {}

# 26. 文本编码器投影（移植自 ComfyUI-ClipProj 0.1.13，MIT）：把 H3 的 32B
# 文本编码器换成 4B/8B + 学出来的线性矩阵，显存 15.7GB → 4.5GB。
# 只搬了 Apply 一个节点，原包的全局猴补丁与多卡固定一概不要。
try:
    from . import banzhang_clipproj
    ClipProj_Cls = getattr(banzhang_clipproj, 'NODE_CLASS_MAPPINGS', {})
    ClipProj_Names = getattr(banzhang_clipproj, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 文本编码器投影节点加载失败: {e}")
    ClipProj_Cls, ClipProj_Names = {}, {}

# 27. 🎬 MV 规划台：独立外挂节点，只通过标准 STRING 端口驱动导演台，
# 不改动媒体架/文案台/导演台；加载失败不影响其他任何节点。
try:
    from . import banzhang_mv_planner
    MVPlan_Cls = getattr(banzhang_mv_planner, 'NODE_CLASS_MAPPINGS', {})
    MVPlan_Names = getattr(banzhang_mv_planner, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] MV 规划台节点加载失败: {e}")
    MVPlan_Cls, MVPlan_Names = {}, {}

# 28. 🪞 人脸修复台：独立外挂节点，插在一采与二采之间、latent 主干，零侵入；
# 承载方案 C + 五巧思（_facefix 子包）；加载失败不影响其他任何节点。
try:
    from . import banzhang_facefix
    FaceFix_Cls = getattr(banzhang_facefix, 'NODE_CLASS_MAPPINGS', {})
    FaceFix_Names = getattr(banzhang_facefix, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] 人脸修复台节点加载失败: {e}")
    FaceFix_Cls, FaceFix_Names = {}, {}

# 46. RelayVSR 大小模型接力超分 (3 节点, 权重读 models/relayvsr, 自包含算法层 _relayvsr/)
try:
    from . import banzhang_relayvsr
    RelayVSR_Cls = getattr(banzhang_relayvsr, 'NODE_CLASS_MAPPINGS', {})
    RelayVSR_Names = getattr(banzhang_relayvsr, 'NODE_DISPLAY_NAME_MAPPINGS', {})
except Exception as e:
    print(f"⚠️ [班长全家桶] RelayVSR 超分节点加载失败: {e}")
    RelayVSR_Cls, RelayVSR_Names = {}, {}

# ==============================================================================
# 合并所有节点映射
# ==============================================================================
NODE_CLASS_MAPPINGS = {
    **Audio_Cls,
    **Latent_Cls,
    **Res_Cls,
    **Text_Cls,
    **ScriptAsset_Cls,
    **LocalEngine_Cls,
    **Sub_Cls,
    **Vis_Cls,
    **API_Cls,
    **Terminate_Cls,
    **Splitter_Cls,
    **Trans_Cls,
    **Extra_Cls,
    **Video_Cls,
    **Scene_Cls,
    **Vram_Cls,
    **CleanVram_Cls,
    **Conv_Cls,
    **RouteSwitch_Cls,
    **DevUtils_Cls,
    **LoraSafe_Cls,
    **Glide_Cls,
    **Sla_Cls,
    **H3Latent_Cls,
    **Note_Cls,
    **Topaz_Cls,
    **H3Prev_Cls,
    **SelfLift_Cls,
    **SelfLiftFull_Cls,
    **Qwen_Cls,
    **H3Up_Cls,
    **H3MC_Cls,
    **Sigma_Cls,
    **_SLAV_Cls,
    **_SLAVPatch_Cls,
    **H3VAEDec_Cls,
    **FlashVSR_Cls,
    **RelayVSR_Cls,
    **DLSS5FG_Cls,
    **HiresUp_Cls,
    **TiledKS_Cls,
    **VFX_Cls,
    **RIFE_Cls,
    **Clip_Cls,
    **Desk_Cls,
    **LegacyCast_Cls,
    **Producer_Cls,
    **Pin_Cls,
    **Drift_Cls,
    **SmartPlan_Cls,
    **Tweaks_Cls,
    **Veda_Cls,
    **MemGraph_Cls,
    **ClipProj_Cls,
    **MVPlan_Cls,
    **FaceFix_Cls,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **Audio_Names,
    **Latent_Names,
    **Res_Names,
    **Text_Names,
    **ScriptAsset_Names,
    **LocalEngine_Names,
    **Sub_Names,
    **Vis_Names,
    **API_Names,
    **Terminate_Names,
    **Splitter_Names,
    **Trans_Names,
    **Extra_Names,
    **Video_Names,
    **Scene_Names,
    **Vram_Names,
    **CleanVram_Names,
    **Conv_Names,
    **RouteSwitch_Names,
    **DevUtils_Names,
    **LoraSafe_Names,
    **Glide_Names,
    **Sla_Names,
    **H3Latent_Names,
    **Note_Names,
    **Topaz_Names,
    **H3Prev_Names,
    **SelfLift_Names,
    **SelfLiftFull_Names,
    **Qwen_Names,
    **H3Up_Names,
    **H3MC_Names,
    **Sigma_Names,
    **_SLAV_Names,
    **_SLAVPatch_Names,
    **H3VAEDec_Names,
    **FlashVSR_Names,
    **RelayVSR_Names,
    **DLSS5FG_Names,
    **HiresUp_Names,
    **TiledKS_Names,
    **VFX_Names,
    **RIFE_Names,
    **Clip_Names,
    **Desk_Names,
    **LegacyCast_Names,
    **Producer_Names,
    **Pin_Names,
    **Drift_Names,
    **SmartPlan_Names,
    **Tweaks_Names,
    **Veda_Names,
    **MemGraph_Names,
    **ClipProj_Names,
    **MVPlan_Names,
    **FaceFix_Names,
}

# ==============================================================================
# H3 涟漪三节点（界面已汉化，分类 👨‍🏫班长/MiniMax H3）
# ==============================================================================
try:
    import banzhang_ripple_clip as _RippleClip
    import banzhang_ripple_apply as _RippleApply
    import banzhang_ripple_output as _RippleOutput
    import banzhang_ripple_cache  # 模块导入时自行注册接口与缓存头

    for _mod in (_RippleClip, _RippleApply, _RippleOutput):
        NODE_CLASS_MAPPINGS.update(_mod.NODE_CLASS_MAPPINGS)
        NODE_DISPLAY_NAME_MAPPINGS.update(_mod.NODE_DISPLAY_NAME_MAPPINGS)
    print("✅ [班长全家桶] H3 涟漪：3 个节点 + 2 个接口已注册")
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 涟漪节点加载失败: {e}")

# 视频文件被塞进图片预览通道时的兜底：/view?preview=… 对 mp4 会抛
# PIL.UnidentifiedImageError，这里改成返回首帧缩略图（模块导入时自行注册中间件）。
try:
    import banzhang_view_guard  # noqa: F401
except Exception as e:
    print(f"⚠️ [班长全家桶] 视频预览兜底未注册: {e}")

# H3 风格旋钮：多路 dial 方向向量合并为一次注入（权重与中文表在 dials/）。
try:
    import banzhang_h3_dial as _H3Dial
    NODE_CLASS_MAPPINGS.update(_H3Dial.NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(_H3Dial.NODE_DISPLAY_NAME_MAPPINGS)
except Exception as e:
    print(f"⚠️ [班长全家桶] H3 风格旋钮加载失败: {e}")

# ==============================================================================
# Web 前端目录配置
# ==============================================================================
# 创建 js 目录存放前端文件
WEB_DIRECTORY = "./js"

# ==============================================================================
# 启动信息
# ==============================================================================
总节点数 = len(NODE_CLASS_MAPPINGS)

print("=" * 60)
print("🎓👨‍🏫 班长全家桶 (Banzhang All-in-One) v2.1 整合版")
print("=" * 60)
print(f"✅ 成功加载 {总节点数} 个节点:")

if Audio_Cls:
    print(f"   🎵 音频节点: {len(Audio_Cls)} 个")
if Latent_Cls:
    print(f"   🌀 潜在空间: {len(Latent_Cls)} 个")
if Res_Cls:
    print(f"   🖼️ 图像处理: {len(Res_Cls)} 个")
if Text_Cls:
    print(f"   📝 文本工具: {len(Text_Cls)} 个")
if Sub_Cls:
    print(f"   🎬 字幕工具: {len(Sub_Cls)} 个")
if Vis_Cls:
    print(f"   👁️ 可视化: {len(Vis_Cls)} 个")
if API_Cls:
    print(f"   🤖 图像API: {len(API_Cls)} 个")
if Splitter_Cls:
    print(f"   ✂️ 图像拆分: {len(Splitter_Cls)} 个")
if Trans_Cls:
    print(f"   🤖 AI翻译器: {len(Trans_Cls)} 个")
if Extra_Cls:
    print(f"   🎵 额外工具: {len(Extra_Cls)} 个")
if Video_Cls:
    print(f"   🎬 视频工具: {len(Video_Cls)} 个")
if Scene_Cls:
    print(f"   🍿 视频分镜: {len(Scene_Cls)} 个")
if Vram_Cls:
    print(f"   💾 显存管理: {len(Vram_Cls)} 个")
if CleanVram_Cls:
    print(f"   🧹 显存管理: {len(CleanVram_Cls)} 个")
if Conv_Cls:
    print(f"   🔄 类型转换: {len(Conv_Cls)} 个")
if DevUtils_Cls:
    print(f"   🛠️ 开发工具: {len(DevUtils_Cls)} 个")
if LoraSafe_Cls:
    print(f"   ️ 显存安全LoRA: {len(LoraSafe_Cls)} 个")
if Glide_Cls:
    print(f"   🎥 CGlide视频: {len(Glide_Cls)} 个")
if Clip_Cls:
    print(f"   📤 H3段落调取: {len(Clip_Cls)} 个")
if Desk_Cls:
    print(f"   ✍️ H3文案台: {len(Desk_Cls)} 个")
if LegacyCast_Cls:
    print(f"   🎞️ H3导演台(经典版): {len(LegacyCast_Cls)} 个")
if Pin_Cls:
    print(f"   🔒 H3钉帧遮罩: {len(Pin_Cls)} 个")
if Drift_Cls:
    print(f"   🎬 H3漂移控制: {len(Drift_Cls)} 个")
if Sla_Cls:
    print(f"   🧠 H3 SLA注意力: {len(Sla_Cls)} 个")
if H3Latent_Cls:
    print(f"   🎬 H3 Latent放大(2D/3D): {len(H3Latent_Cls)} 个")
if Topaz_Cls:
    print(f"   ⭐ Topaz星光超分: {len(Topaz_Cls)} 个")
if H3Prev_Cls:
    print(f"   👁️ MiniMax H3预览覆盖: {len(H3Prev_Cls)} 个")
if SelfLift_Cls:
    print(f"   🎯 SelfLift渐进提升: {len(SelfLift_Cls)} 个")
if SelfLiftFull_Cls:
    print(f"   🎯 SelfLift多级完整采样: {len(SelfLiftFull_Cls)} 个")
if Qwen_Cls:
    print(f"   🎨 Qwen编辑台: {len(Qwen_Cls)} 个")
if H3MC_Cls:
    print(f"   🎞️ H3 Motion Context: {len(H3MC_Cls)} 个")
if H3Up_Cls:
    print(f"   🔍 H3 终极放大: {len(H3Up_Cls)} 个")
if Sigma_Cls:
    print(f"   📈 自定义Sigma曲线: {len(Sigma_Cls)} 个")
if _SLAV_Cls:
    print(f"   🎯 SelfLift-Avatar采样器: {len(_SLAV_Cls)} 个")
if _SLAVPatch_Cls:
    print(f"   🖼️ 图片多级渐进补丁: {len(_SLAVPatch_Cls)} 个")
if H3VAEDec_Cls:
    print(f"   🎬 H3 VAE快速解码: {len(H3VAEDec_Cls)} 个")
if FlashVSR_Cls:
    print(f"   ✨ FlashVSR扩散超分: {len(FlashVSR_Cls)} 个")
if RelayVSR_Cls:
    print(f"   ✨ RelayVSR接力超分: {len(RelayVSR_Cls)} 个")
if DLSS5FG_Cls:
    print(f"   🎞️ DLSS5帧生成插帧: {len(DLSS5FG_Cls)} 个")
if HiresUp_Cls:
    print(f"   🖼️ 图片高清放大二采: {len(HiresUp_Cls)} 个")
if TiledKS_Cls:
    print(f"   🧩 图片分块二采: {len(TiledKS_Cls)} 个")
if VFX_Cls:
    print(f"   🖼️ RTX视频特效(超分/HDR/插帧): {len(VFX_Cls)} 个")
if RIFE_Cls:
    print(f"   🎞️ 插帧 RIFE/EMA(全显卡通用·流式): {len(RIFE_Cls)} 个")
if SmartPlan_Cls:
    print(f"   🎼 YuE2智能乐谱中枢: {len(SmartPlan_Cls)} 个")
if Tweaks_Cls:
    print(f"   🎚️ H3画面微调: {len(Tweaks_Cls)} 个")

# 视频类节点要用 ffmpeg：发布包不再内置（省 392MB），首次启动后台自动装到
# models/banzhang_tools/ffmpeg —— 插件目录之外，更新插件不会重复下载。
try:
    from .banzhang_ffmpeg import find_ffmpeg as _find_ff, find_ffprobe as _find_fp

    _ff = _find_ff()
    if _ff and _find_fp():
        _where = "插件包自带" if "ComfyUI-Banzhang-All" in _ff else "系统已装"
        print(f"   🎬 ffmpeg: 已就绪（{_where}：{_ff}）")
    else:
        print("   🎬 ffmpeg: 本机没有，正在后台自动下载（只需一次，装好立即生效，不用重启）")
        try:
            from .banzhang_ffmpeg_boot import start_background_install as _boot_ff

            _boot_ff(log=lambda m: print(m, flush=True))
        except Exception as _e:
            print(f"   🎬 ffmpeg: 自动下载没启动起来：{type(_e).__name__}: {_e}")
except Exception:
    pass

# 启动期兼容守卫：核心与本机 comfy-aimdo 接口对不上就同步补装。
# 放在节点列表之后、就绪之前 —— 万一要装包，用户先看到「成功加载 N 个节点」，
# 才知道不是节点坏了在卡；pip 的进度输出也不会被节点列表淹没。
try:
    from .banzhang_compat_guard import ensure_aimdo_compatible as _ensure_aimdo

    _ensure_aimdo()
except Exception as _e:
    print(f"⚠ 启动期兼容检查没跑起来：{type(_e).__name__}: {_e}")

print("=" * 60)
print("🚀 所有节点已准备就绪！开始创作吧！")
print("=" * 60)

# ==============================================================================
# 导出声明
# ==============================================================================
__all__ = [
    'NODE_CLASS_MAPPINGS',
    'NODE_DISPLAY_NAME_MAPPINGS',
    'WEB_DIRECTORY'
]
