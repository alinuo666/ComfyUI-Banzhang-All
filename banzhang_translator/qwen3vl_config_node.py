# -*- coding: utf-8 -*-
import re
from .banzhang_utils import MODEL_CONFIGS, Quantization, ModelType, list_gguf_models

class Qwen3VL_ModelConfig:
    @classmethod
    def INPUT_TYPES(cls):
        model_names = [name for name in MODEL_CONFIGS.keys() if not name.startswith('_')]
        default_model = "Qwen3-VL-4B-Instruct" if "Qwen3-VL-4B-Instruct" in model_names else (model_names[0] if model_names else "None")
        
        gguf_models = list_gguf_models()
        # 空列表会被 ComfyUI 前端当成"未连接的输入插槽"：节点一拖到画布上就报
        # "缺少必需的输入"，刷新也甩不掉（前端拿到的 options 一直是空的）。
        # 给一条占位项兜住，保证下拉永远非空；选到它会由 resolve_gguf_model 报出明确中文错误。
        if not gguf_models:
            gguf_models = ["（未找到 GGUF 模型，请把 .gguf 放进 models/llm/GGUF）"]
        default_gguf = gguf_models[0]
        
        return {
            "required": {
                "🔧 模型类型": (ModelType.get_values(), {"default": ModelType.HF.value}),
                "🤖 模型选择 (HF)": (model_names or ["None"], {"default": default_model}),
                "🤖 模型文件 (GGUF)": (gguf_models, {"default": default_gguf}),
                "⚙️ 量化级别 (HF)": (list(Quantization.get_values()), {"default": Quantization.NONE}),
                "🔄 保持模型加载": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                # 上下文预设：标签开头数字即真实 n_ctx，后面是场景说明，避免盲填
                "📝 上下文长度 (GGUF)": (
                    ["8192 · 省显存｜单图打标",
                     "16384 · 多图/短片段",
                     "32768 · 日常推荐｜短视频",
                     "65536 · 长视频/多帧｜27B稳妥最大",
                     "98304 · 极限｜仅2B/8B小模型"],
                    {"default": "32768 · 日常推荐｜短视频"}
                ),
                # 显存不够时 llama.cpp 只抛一句笼统的 "Failed to load model from file"，
                # 所以给个能降的档位，让 8G/12G 卡也有退路（-1 = 全部上显卡）。
                "🖥️ GPU 层数 (GGUF)": (
                    ["自动 · 全部上显卡（推荐）",
                     "36 层 · 显存紧张时往下调",
                     "24 层 · 中等",
                     "12 层 · 小显存（8G 卡）",
                     "0 层 · 纯 CPU（很慢，仅兜底）"],
                    {"default": "自动 · 全部上显卡（推荐）",
                     "tooltip": "报「Failed to load model from file」且显存被占满时，往下调一档再跑。\n"
                                "调低会让部分层留在内存，速度变慢但不爆显存。"}
                ),
            }

        }
    RETURN_TYPES = ("QWEN3VL_MODEL_CONFIG",)
    RETURN_NAMES = ("🔧 本地Qwen配置",)
    FUNCTION = "get_config"
    CATEGORY = "👨‍🏫班长/AI接口"
    
    def get_config(self, **kwargs):
        model_type = kwargs.get("🔧 模型类型")
        config = {
            "model_type": model_type,
            "keep_loaded": kwargs.get("🔄 保持模型加载", False)
        }
        
        if model_type == ModelType.HF.value:
            config["model_name"] = kwargs.get("🤖 模型选择 (HF)")
            config["quantization"] = kwargs.get("⚙️ 量化级别 (HF)")
        else:  # GGUF
            config["model_name"] = kwargs.get("🤖 模型文件 (GGUF)")
            # 档位标签开头是数字就取该数字，否则（"自动 · 全部上显卡"）用 -1 = 全部上显卡。
            # n_gpu_layers 超过模型实际层数时 llama.cpp 会自动全上，档位不会因此报错。
            raw_layers = str(kwargs.get("🖥️ GPU 层数 (GGUF)", "")).strip()
            m_layers = re.match(r"\s*(\d+)", raw_layers)
            config["gpu_layers"] = int(m_layers.group(1)) if m_layers else -1
            # 解析预设标签：取开头数字（如 "32768 · 日常推荐" → 32768）
            raw_ctx = str(kwargs.get("📝 上下文长度 (GGUF)", "8192"))
            m_ctx = re.match(r"\s*(\d+)", raw_ctx)
            config["context_length"] = int(m_ctx.group(1)) if m_ctx else 8192
        
        return (config,)