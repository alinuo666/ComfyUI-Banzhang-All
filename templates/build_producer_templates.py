# -*- coding: utf-8 -*-
"""H3 AI 制片中枢 · 工作流模板生成脚本（可重复运行）

产出：
  producer_asset_qwen.json       W-A  本地 Qwen 编辑台生图 + VL 联系表选图（候选 N 张）
  producer_asset_qwen_lite.json  W-A-lite 单候选直取（无 Repeat/VL/二次入库）
  producer_video_h3.json         W-V  H3 导演台单段渲染（注入资产架/续接合成/段尾归位）

运行：python build_producer_templates.py
N3 编排器只按节点 id 锚点改写，改接线后重跑本脚本即可再生成模板。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

CLIP_NAME = "qwen3vl_8b_fp8_scaled.safetensors"
UNET_NAME = "Qwen-Image-2.1/rayQwen21编辑强化_turboV13Int8convrot.safetensors"
VAE_NAME = "qwen_image_2.1_vae_bf16.safetensors"


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": dict(inputs)}


def translator_widgets(ref_link=None):
    w = {
        "seed": 9,
        "🔑 API_KEY": "",
        "🌐 API服务商": "Doubao (豆包/火山)",
        "🔗 自定义地址": "",
        "🤖 模型名称": "",
        "🎨 提示词预设": "无 (使用自定义)",
        "🧠 系统指令 (指令)": "",
        "🗣️ 用户提示 (正文)": "",
        "🔢 最大Token (万)": 0.2,
        "🌡️ 采样温度": 0.2,
        "🎬 视频帧率": 24,
        "📉 媒体限制(边长)": 768,
        "💾 覆盖原文件": True,
    }
    if ref_link is not None:
        w["🗂️ 参考素材"] = ref_link
    return w


def n2a_widgets(pick_link=None):
    w = {
        "工程名": "未命名短片",
        "组编号": "a1",
        "别名": "主角",
        "类型": "全局角色（每段都可能出现）",
        "归属段": "",
        "视图名": "主锚",
        "主锚": True,
        "图片": ["decode", 0],
        "模式": "入库并选图",
        "手动选用编号": 0,
    }
    if pick_link is not None:
        w["选图结论"] = pick_link
    return w


def build_wa():
    g = {}
    g["clip_l"] = node("CLIPLoader", clip_name=CLIP_NAME, type="qwen_image")
    g["unet_l"] = node("UNETLoader", unet_name=UNET_NAME, weight_dtype="default")
    g["vae_l"] = node("VAELoader", vae_name=VAE_NAME)
    g["rack"] = node("BanzhangProducerRack",
                     **{"工程名": "未命名短片", "视图": "生图参考",
                        "当前段": "", "生图参考别名": "", "引用清单": ""})
    g["qwen"] = node("CSGlideImageCastCS",
                     qwen_data="", clip=["clip_l", 0], vae=["vae_l", 0],
                     refs=["rack", 0])
    g["rep"] = node("RepeatLatentBatch", samples=["qwen", 2], amount=0)
    g["ks"] = node("KSampler",
                   seed=9, steps=6, cfg=1.0, sampler_name="euler",
                   scheduler="simple", denoise=1.0,
                   model=["unet_l", 0], positive=["qwen", 0],
                   negative=["qwen", 1], latent_image=["rep", 0])
    g["decode"] = node("VAEDecode", samples=["ks", 0], vae=["vae_l", 0])
    g["n2a_in"] = node("BanzhangProducerLibraryIn", **n2a_widgets())
    g["vl"] = node("BanzhangAITranslator",
                   **translator_widgets(ref_link=["n2a_in", 1]))
    w2 = n2a_widgets(pick_link=["vl", 1])
    w2["模式"] = "仅重选（用盘上候选重新挑）"
    g["n2a_pick"] = node("BanzhangProducerLibraryIn", **w2)
    return g


def build_wa_lite():
    g = {}
    g["clip_l"] = node("CLIPLoader", clip_name=CLIP_NAME, type="qwen_image")
    g["unet_l"] = node("UNETLoader", unet_name=UNET_NAME, weight_dtype="default")
    g["vae_l"] = node("VAELoader", vae_name=VAE_NAME)
    g["rack"] = node("BanzhangProducerRack",
                     **{"工程名": "未命名短片", "视图": "生图参考",
                        "当前段": "", "生图参考别名": "", "引用清单": ""})
    g["qwen"] = node("CSGlideImageCastCS",
                     qwen_data="", clip=["clip_l", 0], vae=["vae_l", 0],
                     refs=["rack", 0])
    g["ks"] = node("KSampler",
                   seed=9, steps=6, cfg=1.0, sampler_name="euler",
                   scheduler="simple", denoise=1.0,
                   model=["unet_l", 0], positive=["qwen", 0],
                   negative=["qwen", 1], latent_image=["qwen", 2])
    g["decode"] = node("VAEDecode", samples=["ks", 0], vae=["vae_l", 0])
    g["n2a_in"] = node("BanzhangProducerLibraryIn", **n2a_widgets())
    return g


def build_wv():
    with open(os.path.join(HERE, "producer_video_h3.base.json"),
              "r", encoding="utf-8") as f:
        g = json.load(f)

    # 1) 修复原工作流残线：VAEDecode/VAEDecodeAudio 必须接二采最终 LATENT [13]
    g["8"]["inputs"]["samples"] = ["13", 0]
    g["9"]["inputs"]["samples"] = ["13", 0]

    # 2) 注入资产架（N3 每段改写工程名/当前段/引用清单）
    g["pr_rack"] = node("BanzhangProducerRack",
                        **{"工程名": "未命名短片", "视图": "视频段",
                           "当前段": "clip_0001", "生图参考别名": "",
                           "引用清单": ""})

    # 3) 导演台 refs 改接资产架；移除 prompt_text 外接（合订词写进 h3_data.prompt）
    g["31"]["inputs"]["refs"] = ["pr_rack", 0]
    g["31"]["inputs"].pop("prompt_text", None)

    # 4) 注入续接合成：图像/音频接解码输出，重叠帧接导演台口5
    #    source_video 留空（段1直通；N3 对续段改写为上一段 clip_film 绝对路径）
    g["pr_join"] = node(
        "CSGlideJoinCS",
        source_video="", images=["8", 0], audio=["9", 0],
        overlap_frames=["31", 5], fps=24.0, match_tail=True,
        seam_mode="提前切", seam_blend_frames=6, match_levels=True)

    # 5) VideoCombine 段1默认接 Join 透传口（N3 对续段改写为收养 Join VIDEO）
    vc = g["156"]["inputs"]
    vc["🖼️ 图像"] = ["pr_join", 0]
    vc["🎵 音频"] = ["pr_join", 2]
    vc.pop("🎬 视频文件", None)

    # 6) 注入段尾归位：顺序锚接段落存档，成片接 VideoCombine 视频透传
    g["pr_adopt"] = node("BanzhangProducerClipAdopt",
                         **{"顺序锚": ["125", 0], "成片": ["156", 1]})
    return g


def build_master():
    """主控图：N1 制片中枢 → N3 DAG 编排器（用户唯一需要打开的图）。"""
    g = {}
    g["n1"] = node(
        "BanzhangAIProducer",
        **{
            "🔑 API密钥": "",
            "🌐 服务商": "Doubao (豆包/火山)",
            "🔗 自定义地址": "",
            "🤖 编剧模型": "",
            "🤖 编译模型": "",
            "💬 一句话创意": "例：雨夜太原站前，一名机甲武士与全息龙对视后转身离去，赛博东方玄幻。",
            "🎬 片名": "未命名短片",
            "📐 画幅": "横屏 16:9 (928x544)",
            "⏱️ 总秒数": 30,
            "✂️ 单段秒数": 15,
            "🎚️ 丰富度": "标准（推荐）",
            "🔢 主锚候选数": 4,
            "🔢 普通视图候选": 1,
            "🧠 选图方式": "AI看图选图（推荐，需多模态模型）",
            "🤖 选图模型": "",
            "🌡️ 编剧温度": 0.8,
            "🔢 最大字数(万Token)": 4.0,
            "🎲 随机种子": 9,
        })
    g["n3"] = node(
        "BanzhangProducerDirector",
        **{
            "📦 工程包": ["n1", 0],
            "🗂️ 资产清单": ["n1", 3],
            "🎬 工程名": "",
            "🚦 运行模式": "全自动闭环（生图+视频一条龙）",
            "▶ 起始段": 1,
            "⏹ 截止段": 0,
            "🌐 本机软件地址": "http://127.0.0.1:8188",
            "🔑 选图API密钥": "",
            "🌐 选图服务商": "Doubao (豆包/火山)",
            "🔗 选图自定义地址": "",
            "🤖 选图模型": "",
            "📁 模板目录": "",
        })
    return g


def main():
    outs = {
        "producer_asset_qwen.json": build_wa(),
        "producer_asset_qwen_lite.json": build_wa_lite(),
        "producer_video_h3.json": build_wv(),
        "producer_master.json": build_master(),
    }
    for fn, graph in outs.items():
        p = os.path.join(HERE, fn)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(graph, f, ensure_ascii=False, indent=1)
        print("written %s (%d nodes)" % (fn, len(graph)))


if __name__ == "__main__":
    main()
