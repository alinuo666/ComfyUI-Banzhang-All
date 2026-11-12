# -*- coding: utf-8 -*-
"""
👨‍🏫 班长图像编辑API模块
包含：全能Banana2终极版
"""

import sys
import os
import json
import time
import base64
import datetime
import re
from io import BytesIO

# 核心依赖检查
try:
    import requests
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    print("❌ 👨‍🏫班长提示: 缺少 requests 库！")
    raise

import torch
import numpy as np
from PIL import Image
import comfy.utils

# 尺寸预设档案
SIZE_PRESETS_PATH = os.path.join(os.path.dirname(__file__), "banana_size_presets.json")

# 尺寸预设管理
DEFAULT_SIZE_PRESETS = [
    "🖥️ 16:9 - 4K (3840x2160) | 电影级",
    "🖥️ 16:9 - 2K (2560x1440) | 游戏级",
    "🖥️ 16:9 - HD (1920x1080) | 标清",
    "🎬 21:9 - 4K (5120x2160) | 超宽电影",
    "🎬 21:9 - 2K (3440x1440) | 超宽游戏",
    "🎬 21:9 - HD (2560x1080) | 超宽标清",
    "📱 9:16 - 4K (2160x3840) | 海报级",
    "📱 9:16 - 2K (1440x2560) | 手机壁纸",
    "📱 9:16 - HD (1080x1920) | 短视频",
    "📱 9:21 - 4K (2160x5040) | 超长竖屏",
    "📱 9:21 - 2K (1440x3360) | 长图海报",
    "🔳 1:1 - 2K (2048x2048) | 专辑封面",
    "🔳 1:1 - 1K (1024x1024) | 社交头像",
    "📷 4:3 - 2K (2048x1536) | 数码相机",
    "📷 3:4 - 2K (1536x2048) | 杂志排版",
]

def load_size_presets():
    custom_presets = []
    if os.path.exists(SIZE_PRESETS_PATH):
        try:
            with open(SIZE_PRESETS_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
                custom_presets = data.get("presets", [])
        except:
            pass
    return custom_presets + DEFAULT_SIZE_PRESETS

# 通用图像处理工具
def tensor2pil(image):
    result = []
    for img in image:
        arr = img.cpu().numpy()
        if arr.ndim == 2:
            arr = np.expand_dims(arr, axis=-1)
        arr = np.clip(255. * arr, 0, 255).astype(np.uint8)
        if arr.ndim == 3 and arr.shape[0] in [1, 3, 4]:
            arr = arr.squeeze(0) if arr.shape[0] == 1 else arr
        result.append(Image.fromarray(arr))
    return result

def pil2tensor(image):
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)

def create_blank_image(color="black", size=(512, 512)):
    return pil2tensor(Image.new("RGB", size, color=color))

def get_timestamp():
    return datetime.datetime.now().strftime("[%H:%M:%S]")


# ==========================================
# 核心节点类：全能 Banana2 终极版
# ==========================================
class UnifiedBanana2Node:
    def __init__(self):
        self.logs = []
        self.verbose = False
        self.stop_on_error = True
        self.new_seed = 0
        # 种子计数器按节点实例独立保存，避免多个节点互相干扰
        self._seed = None
        self._last_widget_seed = None

    def log(self, icon, message):
        line = f"{get_timestamp()} {icon} {message}"
        print(f"👨‍🏫 {line}")
        self.logs.append(line)

    def debug(self, icon, message):
        """调试日志：仅在【详细日志】开启时记录"""
        if not self.verbose:
            return
        self.log(icon, message)

    def fail(self, color, message):
        """统一失败出口：可选择中断整个工作流"""
        self.log("❌", message)
        if self.stop_on_error:
            raise RuntimeError(f"[🍌班长-全能生图] {message}")
        return (create_blank_image(color), "\n".join(self.logs), self.new_seed)

    def _make_request_with_retry(self, func, url, max_retries=3, **kwargs):
        """带重试机制的请求方法"""
        last_exception = None
        for attempt in range(max_retries):
            try:
                self.log("🔄", f"请求尝试 {attempt + 1}/{max_retries}: {url[:60]}")
                resp = func(url, **kwargs)
                return resp
            except Exception as e:
                last_exception = e
                error_str = str(e).lower()
                if "timeout" in error_str or "524" in error_str or "timed out" in error_str:
                    wait_time = min((attempt + 1) * 5, 15)  # 最多等待15秒
                    self.log("⏱️", f"请求超时/524错误，{wait_time}秒后重试...")
                    time.sleep(wait_time)
                else:
                    # 其他错误直接抛出
                    raise
        # 所有重试都失败了
        raise last_exception if last_exception else Exception(f"请求失败，已重试 {max_retries} 次")

    @classmethod
    def INPUT_TYPES(cls):
        size_presets = load_size_presets()

        return {
            "required": {
                "🔗 自定义地址": ("STRING", {"default": "", "placeholder": "https://api.example.com（必填）"}),
                "🔑 API密钥": ("STRING", {"default": "", "multiline": False, "placeholder": "sk-..."}),
                "🚫 禁用系统代理": ("BOOLEAN", {"default": False}),
                "🤖 模型名称": ("STRING", {"default": "nano-banana-2", "placeholder": "输入模型名，如 nano-banana-2"}),
                "🎨 生成类型": (["✨ 文生图 (Generations)", "🎨 图像编辑/重绘 (Edits)"], {"default": "🎨 图像编辑/重绘 (Edits)"}),
                "📝 提示词": ("STRING", {"multiline": True, "default": "",
                                      "placeholder": "手填提示词；接了【📝 外接提示词】时此项被忽略"}),
                "📐 尺寸规则": (["🛠️ 使用下方预设", "✍️ 使用手动输入", "📏 跟随参考素材尺寸"], {"default": "🛠️ 使用下方预设"}),
                "🖥️ 尺寸预设": (size_presets, {"default": "📱 9:16 - 4K (2160x3840) | 海报级"}),
                "↔️ 手动宽": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "↕️ 手动高": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "🎲 随机种子": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "🎲 种子控制": (["fixed", "increment"], {"default": "increment"}),
                "🐞 详细日志": ("BOOLEAN", {"default": False}),
                "⏱️ 超时秒数": ("INT", {"default": 300, "min": 30, "max": 3600, "step": 10}),
                "🛑 失败时中断": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "📝 外接提示词": ("STRING", {"forceInput": True, "tooltip": "提示词输入端口：接 ✍️ H3 文案台（或任意文本节点）的提示词输出；"
                                                                        "接了就用它，没接就用上方手填的提示词"}),
                "🖼️ 参考素材": ("*", {"tooltip": "万能素材口：可接「加载图片」的 IMAGE、图像批次（一批多张全部上传），"
                                             "或 🗂️ H3 媒体架 / ✍️ H3 文案台的「参考素材」（自动读取全部图片槽位 + 每个视频槽位首帧）"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT")
    RETURN_NAMES = ("🖼️ 输出图像", "📄 运行报告", "🎲 新种子")
    FUNCTION = "dispatch_generate"
    CATEGORY = "👨‍🏫班长/AI接口"

    def dispatch_generate(self, **kwargs):
        self.logs = []
        start_time = time.time()
        self.verbose = bool(kwargs.get("🐞 详细日志", False))
        self.stop_on_error = bool(kwargs.get("🛑 失败时中断", True))
        max_wait_time = int(kwargs.get("⏱️ 超时秒数", 300) or 300)

        self.logs.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        self.logs.append("🚀 班长 AI 终极版 v7.5 - 运行报告")
        self.logs.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

        # 处理种子控制 - 使用本实例的内部计数器实现自动递增
        widget_seed = kwargs.get("🎲 随机种子", 0)
        seed_control = kwargs.get("🎲 种子控制", "increment")

        if seed_control == "increment":
            if self._seed is None:
                # 首次运行：以 widget 值为起点
                self._seed = widget_seed
            elif widget_seed != self._last_widget_seed:
                # 用户手动修改了种子，从新值开始
                self._seed = widget_seed
                self.log("🎲", f"用户手动设置种子: {widget_seed}")

            new_seed = self._seed
            self._seed = new_seed + 1
            self.log("🎲", f"使用种子: {new_seed}，下次自动→ {self._seed}")
        else:
            new_seed = widget_seed
            self.log("🎲", f"固定种子: {new_seed}")

        self._last_widget_seed = widget_seed
        self.new_seed = new_seed

        custom_url = kwargs.get("🔗 自定义地址", "").strip()
        api_key = kwargs.get("🔑 API密钥", "").strip()
        bypass_proxy = kwargs.get("🚫 禁用系统代理", False)

        size_rule = kwargs.get("📐 尺寸规则")
        model_name = kwargs.get("🤖 模型名称", "nano-banana-2")
        final_width, final_height = 1024, 1024
        banana_ar = None
        banana_size = None

        # 万能参考素材口：先统一收成 PIL 列表，尺寸跟随模式要用首张的尺寸
        ref_pils = self._collect_reference_pils(kwargs.get("🖼️ 参考素材"))
        if ref_pils:
            self.log("🖼️", f"参考素材共 {len(ref_pils)} 张")

        if "预设" in size_rule:
            preset_str = kwargs.get("🖥️ 尺寸预设")
            match_pixels = re.search(r"\((\d+)x(\d+)\)", preset_str)
            if match_pixels:
                final_width = int(match_pixels.group(1))
                final_height = int(match_pixels.group(2))
                self.log("📐", f"预设像素: {final_width}x{final_height}")
            match_k = re.search(r"\b([124]K)\b", preset_str)
            if match_k:
                banana_size = match_k.group(1)
            match_ar = re.search(r"\b(\d+:\d+)\b", preset_str)
            if match_ar:
                banana_ar = match_ar.group(1)
            if banana_size and banana_ar:
                self.log("🍌", f"Banana协议: {banana_ar} | {banana_size}")

        elif "手动" in size_rule:
            final_width = kwargs.get("↔️ 手动宽")
            final_height = kwargs.get("↕️ 手动高")
            self.log("📐", f"模式[手动]: {final_width} x {final_height}")

        elif "跟随" in size_rule:
            if ref_pils:
                final_width, final_height = ref_pils[0][0].size
                self.log("📐", f"模式[跟随]: {final_width} x {final_height}")
            else:
                self.log("⚠️", "未接入参考素材，使用默认 1024x1024")

        size_str_pixels = f"{final_width}x{final_height}"

        base_url = custom_url.rstrip('/')
        if not base_url:
            return self.fail("red", "错误：必须填写【🔗 自定义地址】")

        if not api_key:
            return self.fail("red", "错误：API 密钥为空！请在【🔑 API密钥】填写")

        ref_images_data = []
        # 外接提示词（来自文案台等上游节点）优先，没接就用面板上手填的
        prompt = (kwargs.get("📝 外接提示词") or "").strip()
        if prompt:
            self.log("🔗", f"使用外接提示词（{len(prompt)} 字）")
        else:
            prompt = kwargs.get("📝 提示词") or ""
        # 参考素材统一按 PNG 原尺寸无损上传，不做任何压缩
        up_mime = "image/png"

        for idx, (pil_img, tag) in enumerate(ref_pils, start=1):
            buf = BytesIO()
            pil_img.save(buf, format="PNG")
            fname = f"image_{idx - 1}.png"
            ref_images_data.append((fname, buf.getvalue()))

            # 支持多种参考图标记格式
            replacements = [
                f"参考图{idx}",
                f"参考图 {idx}",
                f"【参考图{idx}】",
                f"[参考图{idx}]",
                f"(参考图{idx})",
                f"{{参考图{idx}}}",
                f"<参考图{idx}>",
                f"参考图{idx}号",
                f"图{idx}",
            ]
            # 媒体架 / 文案台的槽位标签：@图片1 / @视频2 等
            if tag:
                bare = tag.lstrip("@")
                replacements += [tag, bare, f"【{tag}】", f"[{tag}]", f"({tag})", f"【{bare}】", f"[{bare}]"]
            for old_marker in replacements:
                if old_marker in prompt:
                    prompt = prompt.replace(old_marker, fname)
                    self.log("🔄", f"提示词替换: '{old_marker}' -> '{fname}'")

            self.debug("🔍", f"参考素材{idx} -> {fname} ({pil_img.width}x{pil_img.height})")

        gen_type = kwargs.get("🎨 生成类型")
        headers = {"Authorization": f"Bearer {api_key}"}

        # 检测是否为 superaiapi，该API使用同步模式
        is_superaiapi = "superaiapi" in base_url.lower()
        if is_superaiapi:
            self.log("🔀", "检测到 superaiapi 地址，自动切换为同步提交流")

        # superaiapi 走同步提交，其余站点走异步提交
        if is_superaiapi:
            request_params = {}
            mode_str = "Sync Mode"
        else:
            request_params = {"async": "true"}
            mode_str = "Async Mode"

        payload = {
            "model": model_name,
            "prompt": prompt,
            "n": 1,
            # 固定要最高画质：支持 quality 的接口会出高清，不支持的会忽略该字段
            "quality": "high",
        }

        # superaiapi 不接受 seed 参数
        if not is_superaiapi:
            payload["seed"] = new_seed

        is_nano_banana = "banana" in model_name.lower()
        if is_nano_banana and banana_ar and banana_size and "预设" in size_rule:
            payload["aspect_ratio"] = banana_ar
            payload["image_size"] = banana_size
            self.log("🚀", f"使用 Banana 协议: {banana_ar} / {banana_size}")
        else:
            payload["size"] = size_str_pixels
            self.log("🚀", f"使用 标准像素: {size_str_pixels}")

        self.log("🚀", f"请求目标: {base_url} ({mode_str})")
        if bypass_proxy:
            self.log("🚫", "已启用: 禁用系统代理")

        session = requests.Session()
        if bypass_proxy:
            session.trust_env = False

        try:
            resp = None

            if "Edits" in gen_type:
                if not ref_images_data:
                    raise ValueError("⚠️ '图像编辑'模式必须连接至少一张参考图！")

                url = f"{base_url}/v1/images/edits"
                files_payload = []
                for fname, fbytes in ref_images_data:
                    files_payload.append(("image", (fname, BytesIO(fbytes), up_mime)))

                data_payload = {k: str(v) for k, v in payload.items()}
                self.log("📤", f"POST Edits (包含 {len(files_payload)} 张参考图)")
                req_timeout = 20 if is_superaiapi else 30
                resp = self._make_request_with_retry(session.post, url, headers=headers, params=request_params, data=data_payload, files=files_payload, timeout=req_timeout)
                resp.encoding = "utf-8"
            else:
                url = f"{base_url}/v1/images/generations"
                self.log("📤", "POST Generations")
                req_timeout = 20 if is_superaiapi else 30
                resp = self._make_request_with_retry(session.post, url, headers=headers, params=request_params, json=payload, timeout=req_timeout)
                resp.encoding = "utf-8"

            # 202 Accepted 也是成功状态（异步任务已创建）
            if resp.status_code not in [200, 202]:
                try:
                    err_msg = resp.json()
                except:
                    raw_text = resp.text
                    err_msg = raw_text[:600] + ("..." if len(raw_text) > 600 else "")
                return self.fail("red", f"API报错 [{resp.status_code}]: {err_msg}")

            # 如果是 202，记录任务已接受
            if resp.status_code == 202:
                self.log("✅", "任务已接受 (202 Accepted)，开始轮询...")

            res_json = resp.json()
            self.log("📥", f"API响应: status={res_json.get('status','?')} task_id={res_json.get('task_id','?')[:16] if res_json.get('task_id') else 'N/A'}")

            # 打印完整的响应结构（截断）
            try:
                resp_preview = json.dumps(res_json, ensure_ascii=False, indent=2)[:2000]
                self.debug("🔍", f"完整响应预览:\n{resp_preview}...")
            except:
                self.debug("🔍", f"响应预览失败: {str(res_json)[:500]}")

            task_id = res_json.get("task_id", "") or res_json.get("id", "")

            self.debug("🔍", "开始尝试从初始响应提取图像...")
            immediate_imgs = self._try_extract_images(res_json, session, is_superaiapi)
            if immediate_imgs is not None:
                self.log("✅", f"生成成功 (耗时 {time.time()-start_time:.1f}s)")
                return (immediate_imgs, self._build_final_report(self.logs, res_json), new_seed)

            # superaiapi/gpt-image-2 使用异步任务模式，总是进入轮询
            if task_id:
                self.log("⏳", f"任务已提交，ID: {task_id}")
                return self._wait_for_task(session, base_url, headers, task_id, start_time, new_seed, is_superaiapi, max_wait_time)
            else:
                return self.fail("blue", "未返回task_id且无图像数据")

        except Exception as e:
            import traceback
            traceback.print_exc()
            error_msg = str(e)
            # 检查是否是524错误
            if "524" in error_msg or "A timeout occurred" in error_msg:
                self.log("💡", "建议: 1) 使用较小的图像尺寸(1K/2K) 2) 稍后重试 3) 联系API提供商")
                return self.fail("red", "Cloudflare 524 错误: API服务器响应超时")
            return self.fail("red", f"严重错误: {error_msg}")

    def _try_extract_images(self, res_json, session, is_superaiapi=False):
        """从 API 响应中尝试提取图像数据，支持多种嵌套结构。
        返回 tensor 或 None"""
        self.debug("🔍", f"尝试提取图像，响应键: {list(res_json.keys())}")

        candidates = []

        # superaiapi 特殊处理: data 字段在顶层，包含图像列表
        if is_superaiapi and "data" in res_json:
            async_data = res_json.get("data")
            if isinstance(async_data, list) and len(async_data) > 0:
                self.debug("🔍", f"异步任务: 顶层data是列表，长度: {len(async_data)}")
                candidates.append(async_data)
            elif isinstance(async_data, dict):
                self.debug("🔍", f"异步任务: 顶层data是字典，键: {list(async_data.keys())}")
                if any(k in async_data for k in ("url", "b64_json")):
                    candidates.append([async_data])
                    self.debug("🔍", "异步任务: data包含图像数据")

        # 情况1: 顶层直接有 data 字段 (通用处理)
        if not candidates:
            data_node = res_json.get("data", {})
            self.debug("🔍", f"顶层data_node 类型: {type(data_node).__name__}")

            if isinstance(data_node, list):
                candidates.append(data_node)
                self.debug("🔍", f"顶层data是列表，长度: {len(data_node)}")
            elif isinstance(data_node, dict):
                self.debug("🔍", f"顶层data是字典，键: {list(data_node.keys())}")
                # 打印 status 字段
                status = data_node.get("status", "N/A")
                self.debug("🔍", f"任务状态: {status}")

                # 检查是否包含图像URL
                if any(k in data_node for k in ("url", "b64_json")):
                    candidates.append([data_node])
                    self.debug("🔍", "顶层data包含 url/b64_json")

                # 情况2: data.data 嵌套 (轮询任务结果)
                inner_data = data_node.get("data")
                # 检查 data 字段的原始值
                self.debug("🔍", f"data.data 原始值类型: {type(inner_data).__name__}")
                self.debug("🔍", f"data.data 值非空: {inner_data is not None}")
                if "data" in data_node:
                    self.debug("🔍", f"'data' 键存在，值: {repr(data_node['data'])[:200] if data_node['data'] is not None else 'None'}")

                if inner_data is not None:
                    self.debug("🔍", f"发现 data.data，类型: {type(inner_data).__name__}")
                    if isinstance(inner_data, list):
                        candidates.append(inner_data)
                        self.debug("🔍", f"data.data 是列表，长度: {len(inner_data)}")
                    elif isinstance(inner_data, dict):
                        self.debug("🔍", f"data.data 是字典，键: {list(inner_data.keys())}")
                        # 检查 inner_data 里面是否还有 data (三层嵌套)
                        inner_inner = inner_data.get("data")
                        if inner_inner is not None:
                            self.debug("🔍", f"发现 data.data.data，类型: {type(inner_inner).__name__}")
                            if isinstance(inner_inner, list):
                                candidates.append(inner_inner)
                                self.debug("🔍", f"data.data.data 是列表，长度: {len(inner_inner)}")
                            elif isinstance(inner_inner, dict):
                                self.debug("🔍", f"data.data.data 是字典")
                                if any(k in inner_inner for k in ("url", "b64_json")):
                                    candidates.append([inner_inner])
                                    self.debug("🔍", "data.data.data 包含 url/b64_json")
                        if any(k in inner_data for k in ("url", "b64_json")):
                            candidates.append([inner_data])
                            self.debug("🔍", "data.data 包含 url/b64_json")
                else:
                    self.debug("🔍", "data.data 为 None，检查 data 字段本身...")
                    # data_node 本身可能就是图像数据
                    if any(k in data_node for k in ("url", "b64_json")):
                        candidates.append([data_node])
                        self.debug("🔍", "顶层data直接包含 url/b64_json")

        # 情况3: 检查其他可能的键
        if not candidates:
            self.debug("🔍", "未找到标准结构，检查其他键...")
            for key in ["images", "results", "output", "items"]:
                if key in res_json:
                    val = res_json[key]
                    if isinstance(val, list):
                        candidates.append(val)
                        self.debug("🔍", f"从 '{key}' 找到列表")
                        break

        self.debug("🔍", f"共 {len(candidates)} 个候选列表")

        for idx, candidate in enumerate(candidates):
            if candidate and len(candidate) > 0:
                self.debug("🔍", f"检查候选 {idx+1}: {len(candidate)} 个条目")
                imgs, _ = self._process_image_response(candidate, session)
                if imgs is not None:
                    self.log("✅", f"从候选 {idx+1} 成功提取图像")
                    return imgs
                else:
                    self.log("⚠️", f"候选 {idx+1} 未能提取图像")
            else:
                self.log("⚠️", f"候选 {idx+1} 为空")

        self.log("❌", "所有候选都未能提取到图像")
        return None

    def _collect_reference_pils(self, ref_input):
        """万能参考素材口 → [(PIL 图, 槽位标签), ...]。

        标签是媒体架/文案台里的 @图片1 / @视频2 之类的叫法，用来把提示词
        里的这些标签替换成本次真正上传的文件名；直接接 IMAGE 时没有标签。

        支持三种输入：
        1) IMAGE（加载图片 / 图像批次）：一批里的每一张都取出
        2) H3_REFS（🗂️ 媒体架 / ✍️ 文案台「参考素材」）：全部图片槽位 + 每个视频槽位首帧
        3) 以上任意一种组成的 list（部分批量节点的输出形态）
        """
        if ref_input is None:
            return []
        if isinstance(ref_input, torch.Tensor):
            return [(img, None) for img in tensor2pil(ref_input)]
        if isinstance(ref_input, (list, tuple)):
            pils = []
            for item in ref_input:
                pils.extend(self._collect_reference_pils(item))
            return pils
        if isinstance(ref_input, (str, dict)):
            return self._pils_from_h3_refs(ref_input)
        self.log("⚠️", f"无法识别的参考素材类型: {type(ref_input).__name__}，已忽略")
        return []

    def _pils_from_h3_refs(self, refs):
        """从媒体架 / 文案台（H3_REFS）规范化 JSON 里读出所有图片与视频首帧。

        返回 [(PIL 图, "@图片N" / "@视频N"), ...]，标签沿用槽位编号。
        """
        if isinstance(refs, str):
            try:
                data = json.loads(refs)
            except Exception:
                self.log("⚠️", "参考素材不是合法的媒体架 JSON，已忽略")
                return []
        else:
            data = refs
        if not isinstance(data, dict):
            return []

        slots = data.get("slots") or {}
        pils = []

        for i, slot in enumerate(slots.get("images") or [], start=1):
            f = (slot or {}).get("file")
            if not f:
                continue
            try:
                from .csglide_assets import load_image
                pils.extend([(img, f"@图片{i}") for img in tensor2pil(load_image(f))])
                self.log("🗂️", f"媒体架 @图片{i}: {os.path.basename(str(f))}")
            except Exception as e:
                self.log("⚠️", f"媒体架 @图片{i} 读取失败: {e}")

        for i, slot in enumerate(slots.get("videos") or [], start=1):
            f = (slot or {}).get("file")
            if not f:
                continue
            try:
                from .csglide_cast import _load_video_frames
                # 解出来的帧数有下限（MIN_REF_FRAMES），这里只取第一帧做参考图
                frames = _load_video_frames(f, float(slot.get("start") or 0.0), slot.get("end"), 1)
                pils.extend([(img, f"@视频{i}") for img in tensor2pil(frames[:1])])
                self.log("🎞️", f"媒体架 @视频{i} 首帧: {os.path.basename(str(f))}")
            except Exception as e:
                self.log("⚠️", f"媒体架 @视频{i} 取帧失败（需要 PyAV）: {e}")

        if not pils:
            self.log("⚠️", "媒体架未读到任何素材（槽位为空，或文件已删除/挪位）")
        return pils

    def _wait_for_task(self, session, base_url, headers, task_id, start_time, new_seed, is_superaiapi=False, max_wait_time=300):
        pbar = comfy.utils.ProgressBar(100)
        url = f"{base_url}/v1/images/tasks/{task_id}"
        self.debug("🔍", f"[轮询开始] URL: {url}")
        self.debug("🔍", f"[轮询配置] is_superaiapi={is_superaiapi}, task_id={task_id}")
        self.log("⏱️", "API任务可能需要排队，请耐心等待...")
        self.log("⏱️", f"最长等待 {max_wait_time} 秒，超时将自动停止")

        # superaiapi 使用 10 秒轮询间隔（推荐），其他使用 3 秒
        poll_interval = 10 if is_superaiapi else 3
        max_retries = max(1, int(max_wait_time / poll_interval) + 2)
        not_start_count = 0  # NOT_START/queued 状态计数器

        for i in range(max_retries):
            loop_start = time.time()
            self.debug("🔍", f"[轮询第{i+1}次] 开始轮询迭代")
            
            # 检查是否超过设定的超时时间
            current_wait = time.time() - start_time
            if current_wait > max_wait_time:
                return self.fail("grey", f"任务超时（已等待{current_wait:.0f}秒，上限{max_wait_time}秒）。可提高【⏱️ 超时秒数】或稍后查看API后台")
            
            # 检查ComfyUI是否正在处理（用户点击停止时）
            if hasattr(comfy.model_management, 'current_interrupted') and comfy.model_management.current_interrupted:
                self.log("🛑", "[轮询中断] 检测到停止请求，终止任务轮询")
                return (create_blank_image("grey"), "🛑 用户已停止任务", new_seed)
            
            self.debug("🔍", f"[轮询第{i+1}次] 等待{poll_interval}秒...")
            time.sleep(poll_interval)

            try:
                self.debug("🔍", f"[轮询第{i+1}次] 发送GET请求: {url}")
                r = session.get(url, headers=headers, timeout=20)
                r.encoding = "utf-8"
                self.debug("🔍", f"[轮询第{i+1}次] HTTP状态码: {r.status_code}")

                if r.status_code != 200:
                    self.log("⚠️", f"[轮询第{i+1}次] HTTP错误 {r.status_code}: {r.text[:200]}")
                    pbar.update_absolute(min((i+1) * 0.5, 99))
                    continue

                self.debug("🔍", f"[轮询第{i+1}次] 解析JSON响应...")
                rj = r.json()
                self.debug("🔍", f"[轮询第{i+1}次] JSON解析成功，键: {list(rj.keys())}")

                # 计算等待时间（放在最前面，避免变量作用域问题）
                wait_time = time.time() - start_time
                self.debug("🔍", f"[轮询第{i+1}次] 已等待: {wait_time:.1f}s")

                # 尝试从多个位置获取状态 (superaiapi在顶层，其他API可能在data里)
                top_status = ""
                submit_time = 0
                start_time_task = 0
                progress = ""
                data_node = {}
                
                # 优先检查顶层 status
                if "status" in rj:
                    top_status = rj.get("status", "")
                    submit_time = rj.get("submit_time", 0)
                    start_time_task = rj.get("start_time", 0)
                    progress = rj.get("progress", "")
                    data_node = rj  # 整个响应就是数据节点
                    self.debug("🔍", f"[轮询第{i+1}次] 从顶层获取状态: {top_status}")
                elif "data" in rj and isinstance(rj.get("data"), dict):
                    # 其次检查 data.status
                    data_node = rj.get("data", {})
                    top_status = data_node.get("status", "")
                    submit_time = data_node.get("submit_time", 0)
                    start_time_task = data_node.get("start_time", 0)
                    progress = data_node.get("progress", "")
                    self.debug("🔍", f"[轮询第{i+1}次] 从data_node获取状态: {top_status}")
                elif "data" in rj:
                    # data 存在但不是 dict
                    data_node = rj.get("data", {})
                    self.debug("🔍", f"[轮询第{i+1}次] data_node类型: {type(data_node).__name__} (非字典)")
                else:
                    self.debug("🔍", f"[轮询第{i+1}次] 响应中无 status 和 data 字段")
                
                # 调试日志
                self.debug("🔍", f"[轮询第{i+1}次] 最终状态: {top_status}, 等待: {wait_time:.0f}s")
                
                # 每2次轮询打印一次完整响应预览
                if i % 2 == 0:
                    try:
                        resp_preview = json.dumps(rj, ensure_ascii=False, indent=2)[:500]
                        self.debug("🔍", f"[轮询第{i+1}次] 响应预览:\n{resp_preview}")
                    except Exception as e:
                        self.log("⚠️", f"[轮询第{i+1}次] 无法序列化响应: {e}")

                # queued/NOT_START 状态特殊处理 (superaiapi 使用 queued)
                if top_status in ["NOT_START", "queued"]:
                    not_start_count += 1
                    self.log("⏳", f"[轮询第{i+1}次] 状态=排队中(queued), 计数={not_start_count}")
                    if not_start_count == 1:
                        self.log("⏳", f"任务正在排队中... (已等待 {wait_time:.0f}s)")
                    elif not_start_count % 6 == 0:
                        self.log("⏳", f"任务仍在排队... (已等待 {wait_time:.0f}s)")
                    pbar.update_absolute(min((i+1) * 0.3, 30))
                    self.debug("🔍", f"[轮询第{i+1}次] 继续下一轮询...")
                    continue

                # 任务已开始，显示详细状态 (superaiapi 使用 running)
                if top_status in ["PENDING", "RUNNING", "IN_PROGRESS", "running"]:
                    self.log("🔄", f"[轮询第{i+1}次] 状态=处理中({top_status})")
                    if start_time_task and submit_time:
                        queue_time = start_time_task - submit_time
                        self.log("🔄", f"任务处理中 [{top_status}] 排队耗时:{queue_time}s 进度:{progress} 总等待:{wait_time:.0f}s")
                    else:
                        self.log("🔄", f"任务处理中 [{top_status}] 进度:{progress} 等待:{wait_time:.0f}s")
                    pbar.update_absolute(min(30 + (i+1) * 0.35, 95))
                    self.debug("🔍", f"[轮询第{i+1}次] 继续下一轮询...")
                    continue

                # 检查失败状态 (superaiapi 使用 failed) - 优先检查失败
                if top_status in ["FAILURE", "failed", "error"]:
                    self.log("❌", f"[轮询第{i+1}次] ❌ 检测到失败状态: {top_status}")
                    fail_reason = ""
                    try:
                        if isinstance(data_node, dict):
                            fail_reason = data_node.get("fail_reason", "")
                            if not fail_reason and "error" in data_node:
                                error_obj = data_node.get("error", {})
                                if isinstance(error_obj, dict):
                                    fail_reason = error_obj.get("message", "")
                                else:
                                    fail_reason = str(error_obj)
                        if not fail_reason:
                            fail_reason = rj.get("fail_reason", "")
                            if not fail_reason and "error" in rj:
                                error_obj = rj.get("error", {})
                                if isinstance(error_obj, dict):
                                    fail_reason = error_obj.get("message", "")
                                else:
                                    fail_reason = str(error_obj)
                    except Exception as e:
                        self.log("⚠️", f"[轮询第{i+1}次] 解析错误信息失败: {e}")
                    
                    if not fail_reason:
                        fail_reason = "未知错误"
                    
                    if "Gemini could not generate" in fail_reason:
                        fail_reason += " (提示词可能触发了安全拦截，请修改提示词)"
                    return self.fail("red", f"任务执行失败: {fail_reason}")

                # 检查成功状态 (superaiapi 使用 succeeded) - 然后检查成功
                if top_status in ["SUCCESS", "success", "succeeded"]:
                    self.log("✅", f"[轮询第{i+1}次] 检测到成功状态: {top_status}，尝试提取图像...")
                    self.debug("🔍", f"[轮询第{i+1}次] 调用_try_extract_images, is_superaiapi={is_superaiapi}")
                    imgs = self._try_extract_images(rj, session, is_superaiapi)
                    
                    if imgs is not None:
                        total_time = time.time() - start_time
                        self.log("✅", f"[轮询第{i+1}次] ✅ 图像提取成功！总耗时: {total_time:.1f}s")
                        return (imgs, self._build_final_report(self.logs, rj), new_seed)
                    else:
                        try:
                            full_resp = json.dumps(rj, ensure_ascii=False, indent=2)
                            self.debug("🔍", f"[完整响应]\n{full_resp}")
                        except Exception as e:
                            self.debug("🔍", f"无法序列化响应: {e}")
                        return self.fail("orange", f"状态为 {top_status} 但未能提取到图像数据")

                # 未知状态，尝试提取图像
                self.debug("🔍", f"[轮询第{i+1}次] 未知状态={top_status}，尝试提取图像...")
                self.debug("🔍", f"[轮询第{i+1}次] 调用_try_extract_images, is_superaiapi={is_superaiapi}")
                imgs = self._try_extract_images(rj, session, is_superaiapi)
                
                if imgs is not None:
                    total_time = time.time() - start_time
                    self.log("✅", f"图像提取成功！总耗时: {total_time:.1f}s")
                    return (imgs, self._build_final_report(self.logs, rj), new_seed)
                else:
                    self.debug("🔍", f"[轮询第{i+1}次] 图像提取返回None，继续轮询...")

            except Exception as e:
                self.log("⚠️", f"轮询异常: {type(e).__name__}: {e}")
                import traceback
                self.debug("🔍", f"[轮询第{i+1}次] 异常堆栈:\n{traceback.format_exc()[:500]}")

        # 超时返回
        total_wait = time.time() - start_time
        return self.fail("grey", f"任务轮询超时（已等待{total_wait:.0f}秒），API任务可能仍在处理，请稍后查看API后台")

    def _clean_url(self, url):
        """清理URL，移除各种引号和反引号"""
        if not url:
            return ""
        # 先去除首尾空格，然后去除各种引号
        url = url.strip()
        url = url.strip('"\'`')  # 去除双引号、单引号、反引号
        url = url.strip()  # 再次去除空格
        return url

    def _process_image_response(self, data_list, session):
        """下载图片，失败时返回 (None, '') 而非空白图"""
        if not isinstance(data_list, list):
            data_list = [data_list]
        tensors = []
        last_url = ""

        self.debug("🔍", f"开始处理图像响应，共 {len(data_list)} 个条目")

        for idx, item in enumerate(data_list):
            try:
                if isinstance(item, dict):
                    self.debug("🔍", f"处理条目 {idx+1}: 键 = {list(item.keys())}")

                    if "url" in item and item["url"]:
                        raw_url = item["url"]
                        self.log("🔗", f"原始URL ({len(raw_url)} 字符): {repr(raw_url[:100])}")

                        last_url = self._clean_url(raw_url)
                        self.log("🔗", f"清理后URL ({len(last_url)} 字符): {repr(last_url[:100])}")

                        if not last_url:
                            self.log("⚠️", f"条目 {idx+1} URL为空，跳过")
                            continue

                        self.log("📥", f"正在下载: {last_url[:80]}...")
                        img_resp = session.get(last_url, timeout=60)
                        self.log("📊", f"下载响应 HTTP {img_resp.status_code}, 大小 {len(img_resp.content)} bytes")

                        if img_resp.status_code != 200:
                            self.log("⚠️", f"下载失败 HTTP {img_resp.status_code}: {last_url[:60]}")
                            continue

                        try:
                            pil_img = Image.open(BytesIO(img_resp.content)).convert("RGB")
                            tensors.append(pil2tensor(pil_img))
                            self.log("✅", f"图片下载成功: {pil_img.width}x{pil_img.height}")
                        except Exception as img_e:
                            self.log("⚠️", f"图片打开失败: {img_e}")
                            continue

                    elif "b64_json" in item and item["b64_json"]:
                        try:
                            img_data = base64.b64decode(item["b64_json"])
                            pil_img = Image.open(BytesIO(img_data)).convert("RGB")
                            tensors.append(pil2tensor(pil_img))
                            self.log("✅", f"Base64解码成功: {pil_img.width}x{pil_img.height}")
                        except Exception as b64_e:
                            self.log("⚠️", f"Base64解码失败: {b64_e}")
                            continue
                    else:
                        self.log("⚠️", f"条目 {idx+1} 无有效URL或b64_json")
                else:
                    self.log("⚠️", f"条目 {idx+1} 不是字典类型: {type(item)}")
            except Exception as e:
                self.log("⚠️", f"图片解析失败: {e}")
                import traceback
                self.debug("🔍", f"详细错误: {traceback.format_exc()[:500]}")

        self.debug("🔍", f"处理完成，成功提取 {len(tensors)} 张图片")

        if tensors:
            return torch.cat(tensors), last_url
        return None, ""

    def _build_final_report(self, logs, json_data):
        if not self.verbose:
            return "\n".join(logs)
        logs.append("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        logs.append("📊 原始响应数据 (Debug用):")
        try:
            logs.append(json.dumps(json_data, indent=2, ensure_ascii=False))
        except:
            logs.append(str(json_data))
        return "\n".join(logs)


# 注册映射
NODE_CLASS_MAPPINGS = {
    "BanZhang_UnifiedBanana2": UnifiedBanana2Node
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_UnifiedBanana2": "🍌班长-全能生图"
}
