# -*- coding: utf-8 -*-
"""
👨‍🏫 班长翻译器子模块
包含：万能空节点、抓取神器、AI全能生成、Qwen3VL配置
"""

from .banzhang_any_output_node import BanzhangAnyOutputNode
from .banzhang_node_translator import BanzhangNodeTranslator
from .banzhang_ai_translator import BanzhangAITranslator
from .qwen3vl_config_node import Qwen3VL_ModelConfig

# GGUF 本地推理（Qwen3VL/Qwen2.5-VL 等）依赖 llama-cpp-python，缺了就自动装：
# 优先用插件 wheels/ 里的 CUDA 预编译 wheel（断网也能装），再联网兜底。
# 装不上不影响 HF（transformers）模式，也不影响这几个节点注册。
try:
    from ..banzhang_dep_installer import ensure_pip_package
    ensure_pip_package(
        "llama_cpp",
        "llama-cpp-python",
        "llama_cpp_python-*.whl",
        label="Qwen3VL/GGUF 本地推理",
        preimport=("torch",),  # CUDA 版 llama.dll 依赖 torch 已加载的 CUDA DLL
    )
except Exception as _e:  # 自动安装器本身异常绝不能拖垮整个插件
    print(f"[班长全家桶] llama-cpp-python 自动检查跳过（不影响 HF 模式）：{_e}")

NODE_CLASS_MAPPINGS = {
    "BanzhangNodeTranslator": BanzhangNodeTranslator,
    "BanzhangAnyOutputNode": BanzhangAnyOutputNode,
    "BanzhangAITranslator": BanzhangAITranslator,
    "BanZhang_Qwen3VL_ModelConfig": Qwen3VL_ModelConfig
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanzhangNodeTranslator": "🔍 抓取神器 V13 (深度降噪版)",
    "BanzhangAnyOutputNode": "🧩 万能空节点",
    "BanzhangAITranslator": "🤖 AI 全能生成",
    "BanZhang_Qwen3VL_ModelConfig": "🍭 Qwen3VL 模型配置"
}
