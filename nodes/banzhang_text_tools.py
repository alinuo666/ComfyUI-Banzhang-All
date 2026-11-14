# -*- coding: utf-8 -*-
"""
👨‍🏫 班长文本处理工具模块
包含：智能文本保存、文本智能区间提取、文本智能分批、万能文本分割、结构化字段解包器
"""

import os
import re
import json
from datetime import datetime
import difflib


# ==============================================================================
# 共享解析引擎: 结构化包裹符字段提取
# 支持四种包裹风格:
#   🔺 <<<NAME>>>...<<<NAME_END>>>
#   🔤 <NAME>...</NAME>
#   🔣 {{NAME}}...{{/NAME}}
#   📦 [NAME]...[/NAME]
# 一份文本可含多条记录(如多首歌): 字段名再次出现即自动切分为新记录
# ==============================================================================
# 字段名同时接受英文/数字/下划线与中文：中文模板 <<<歌名>>>…<<<歌名结束>>>
# 与英文老模板 <<<TITLE_VALUE>>>…<<<TITLE_VALUE_END>>> 走同一条正则。
_NAME = r"[A-Za-z0-9_\u4e00-\u9fa5]+"
_WRAPPER_PATTERNS = {
    "triangle": (r"<<<\s*(" + _NAME + r")\s*>>>(.*?)<<<\s*\1(?:_END|结束)\s*>>>", "🔺 三角 <<<NAME>>>"),
    "xml":      (r"<\s*(" + _NAME + r")\s*>\s*(.*?)\s*<\s*/\s*\1\s*>", "🔤 XML <NAME>"),
    "mustache": (r"\{\{\s*(" + _NAME + r")\s*\}\}(.*?)\{\{\s*/\s*\1\s*\}\}", "🔣 双花括号 {{NAME}}"),
    "bbcode":   (r"\[\s*(" + _NAME + r")\s*\](.*?)\[\s*/\s*\1\s*\]", "📦 方括号 [NAME]"),
}

_PLACEHOLDER_HINT = re.compile(
    r"(智能生成|纯数字|在此处|在此撰写|在此填写|请填写|待填写|歌词第|第一行|第二行|placeholder)",
    re.IGNORECASE
)
# 嵌套方括号行, 如 [Intro - [Instrument]] / [Chorus - [Emotion]]，真实歌词标签不会嵌套
_NESTED_BRACKET_LINE = re.compile(r"^\s*\[[^\[\]]*\[[^\[\]]+\][^\[\]]*\]\s*$")


def _normalize_field_name(raw_name):
    """字段名归一化: TITLE_VALUE -> TITLE，统一大写、空格/横杠转下划线"""
    name = re.sub(r"[\s\-]+", "_", str(raw_name).strip().upper()).strip("_")
    if name.endswith("_VALUE"):
        name = name[:-6]
    return name


# 清单行里误粘包裹符时，从中提取字段名(四种风格的开标记)
_FIELD_LINE_MARKERS = (
    re.compile(r"<<<\s*([A-Za-z0-9_\u4e00-\u9fa5 ]+?)\s*>>>"),
    re.compile(r"<([A-Za-z\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5 ]*)>"),
    re.compile(r"\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5 ]+?)\s*\}\}"),
    re.compile(r"\[\s*([A-Za-z0-9_\u4e00-\u9fa5 ]+?)\s*\]"),
)
# 中文放开后必须限长：否则整句正文（无标点）也会被当成字段名长出一个乱端口
_FIELD_NAME_VALID = re.compile(
    r"^(?:[A-Z0-9_]{1,24}|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_]{0,11})$"
)


def _parse_field_spec_lines(field_spec):
    """
    解析「输出字段清单」，返回 (合法字段名列表, 被丢弃行数)。
    - 每行只允许一个字段名；误粘整段包裹符模板时自动提取其中字段名；
    - 归一化后仍不合法(含符号/整句正文)的行丢弃，由前端/预览提示。
    """
    names = []
    dropped = 0
    for raw_line in str(field_spec or "").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        token = line
        for marker in _FIELD_LINE_MARKERS:
            match = marker.search(line)
            if match:
                token = match.group(1)
                break
        name = _normalize_field_name(token)
        if _FIELD_NAME_VALID.match(name):
            if name not in names:
                names.append(name)
        else:
            dropped += 1
    return names, dropped


def _is_placeholder(value):
    """识别 LLM 未填写的模板占位，如 [纯数字]、[Key]、[在此处撰写...]、[Intro - [Instrument]]"""
    v = (value or "").strip()
    if not v:
        return False
    if _PLACEHOLDER_HINT.search(v):
        return True
    # 单行且整体被一对方括号包裹 (多行的歌词块含 [Intro] 等标签不受影响)
    if "\n" not in v and len(v) >= 2 and v[0] == "[" and v[-1] == "]":
        return True
    # 多行内容: 任一行出现嵌套方括号说明 → 整个字段仍是模板
    for line in v.split("\n"):
        if _NESTED_BRACKET_LINE.match(line):
            return True
    return False


def _extract_wrapped_fields(text, style="auto", trim=True, custom_pattern=None):
    """
    解析包裹符文本。
    返回 (records, field_order, hit_styles):
      records     : [ {字段名: 值, ...}, ... ]，同名字段再次出现自动开启新记录
      field_order : 首次出现的字段名顺序
      hit_styles  : 实际命中的包裹风格 key 列表
      custom_pattern: 用户自定义正则，须含两个捕获组 (字段名, 内容)
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    style_keys = [style] if style in _WRAPPER_PATTERNS else list(_WRAPPER_PATTERNS.keys())

    spans = []
    for key in style_keys:
        pattern, _label = _WRAPPER_PATTERNS[key]
        try:
            for m in re.finditer(pattern, text, re.DOTALL | re.IGNORECASE):
                spans.append((m.start(), m.end(), m.group(1), m.group(2), key))
        except re.error:
            continue

    # 用户自定义正则(2 个捕获组: 名称, 内容)
    if custom_pattern:
        try:
            compiled = re.compile(custom_pattern, re.DOTALL | re.IGNORECASE)
            if compiled.groups >= 2:
                for m in compiled.finditer(text):
                    spans.append((m.start(), m.end(), m.group(1), m.group(2), "custom"))
        except re.error:
            pass

    # 按位置排序，同起点取更长匹配；自动模式下剔除不同风格间的重叠命中
    spans.sort(key=lambda x: (x[0], -x[1]))
    picked = []
    cursor = -1
    hit_styles = []
    for span in spans:
        if span[0] >= cursor:
            picked.append(span)
            cursor = span[1]
            if span[4] not in hit_styles:
                hit_styles.append(span[4])

    records = []
    current = {}
    field_order = []
    for _s, _e, raw_name, value, _style in picked:
        name = _normalize_field_name(raw_name)
        if not name or not _FIELD_NAME_VALID.match(name):
            # 名字不像字段名（典型：中文长句被包在包裹符里）→ 不生成端口
            continue
        if trim:
            value = value.strip()
        if name in current:  # 同名字段再次出现 → 新记录
            records.append(current)
            current = {}
        current[name] = value
        if name not in field_order:
            field_order.append(name)
    if current:
        records.append(current)

    return records, field_order, hit_styles


# ==============================================================================
# 节点 1: 班长智能文本保存 (班长_智能文本保存)
# ==============================================================================
class Banzhang_SaveText:
    """
    这是一个用于保存文本内容的节点类。
    支持自动抓取上游节点标题，支持穿透 Reroute 节点，支持复杂 ID 匹配。
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输入文本": ("STRING", {"forceInput": True}),
                "自定义文件名": ("STRING", {"default": "auto", "multiline": False}),
                "保存路径": ("STRING", {"default": "auto", "multiline": False}),
                "文件格式": (["md", "txt"],),
            },
            "hidden": {
                "节点唯一ID": "UNIQUE_ID",
                "额外信息": "EXTRA_PNGINFO"
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("📄 输出文本",)
    OUTPUT_TOOLTIPS = ("传递原始文本内容",)
    OUTPUT_NODE = True
    FUNCTION = "执行保存逻辑"
    CATEGORY = "👨‍🏫班长/文本处理"

    def 清洗ID(self, 原始ID):
        id_str = str(原始ID)
        if ":" in id_str:
            return id_str.split(":")[-1]
        return id_str

    def 查找节点信息(self, 目标节点ID, 工作流数据):
        目标ID_清洗后 = self.清洗ID(目标节点ID)
        for 节点 in 工作流数据.get("nodes", []):
            if str(节点["id"]) == 目标ID_清洗后:
                return 节点
        return None

    def 追溯源头(self, 当前节点ID, 工作流数据):
        当前ID_清洗后 = self.清洗ID(当前节点ID)
        源头节点ID = None

        for 连线 in 工作流数据.get("links", []):
            连线目标ID = str(连线[3])
            if self.清洗ID(连线目标ID) == 当前ID_清洗后:
                源头节点ID = 连线[1]
                break

        if not 源头节点ID:
            return None

        源头节点 = self.查找节点信息(源头节点ID, 工作流数据)
        if not 源头节点:
            return None

        节点类型 = str(源头节点.get("type", "")).lower()
        if "reroute" in 节点类型:
            print(f"🔄 [班长节点] 遇到 Reroute 节点 (ID: {源头节点ID})，继续向上追溯...")
            return self.追溯源头(源头节点ID, 工作流数据)

        return 源头节点

    def 执行保存逻辑(self, 输入文本, 自定义文件名, 保存路径, 文件格式, 节点唯一ID=None, 额外信息=None):
        print(f"\n🔍 [班长节点] ================= 开始执行保存 =================")

        目标文件名 = "未知来源文本"
        是否需要侦探 = True

        用户输入名 = str(自定义文件名).strip() if 自定义文件名 else ""
        if 用户输入名 in ["", "auto", "自动", "默认"]:
            是否需要侦探 = True
            print(f"ℹ️ [班长节点] 模式: 自动侦探上游标题")
        else:
            目标文件名 = 用户输入名
            是否需要侦探 = False
            print(f"ℹ️ [班长节点] 模式: 用户自定义 ({目标文件名})")

        if 是否需要侦探:
            if 额外信息 and "workflow" in 额外信息:
                工作流数据 = 额外信息["workflow"]
                当前节点ID_Str = str(节点唯一ID)
                print(f"🕵️ [班长节点] 当前节点运行时 ID: {当前节点ID_Str}")
                最终源头节点 = self.追溯源头(当前节点ID_Str, 工作流数据)

                if 最终源头节点:
                    节点标题 = 最终源头节点.get("title")
                    节点类型 = 最终源头节点.get("type")
                    目标文件名 = 节点标题 if 节点标题 else (节点类型 if 节点类型 else f"节点_{最终源头节点['id']}")
                    print(f"✅ [班长节点] 锁定源头: 【{目标文件名}】 (ID: {最终源头节点['id']})")
                else:
                    print(f"⚠️ [班长节点] 追溯失败：在全局连线表中未找到指向当前节点的连线。")
            else:
                print(f"❌ [班长节点] 错误：无法获取工作流信息。")

        当前时间戳 = datetime.now().strftime("_%Y%m%d_%H%M")
        目标文件名 = f"{目标文件名}{当前时间戳}"
        目标文件名 = re.sub(r'[\\/*?:"<>|]', '_', str(目标文件名))

        用户路径 = str(保存路径).strip() if 保存路径 else ""
        if 用户路径 in ["", "auto", "自动", "默认"]:
            当前脚本目录 = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            最终保存目录 = os.path.join(当前脚本目录, "Saved_Texts")
        else:
            最终保存目录 = 用户路径

        if not os.path.exists(最终保存目录):
            try:
                os.makedirs(最终保存目录)
                print(f"📂 [班长节点] 创建目录: {最终保存目录}")
            except Exception as e:
                print(f"❌ [班长节点] 创建目录失败: {e}")
                return (输入文本,)

        基础文件名 = f"{目标文件名}.{文件格式}"
        完整文件路径 = os.path.join(最终保存目录, 基础文件名)

        序号 = 1
        while os.path.exists(完整文件路径):
            新文件名 = f"{目标文件名}_{序号}.{文件格式}"
            完整文件路径 = os.path.join(最终保存目录, 新文件名)
            序号 += 1

        try:
            with open(完整文件路径, 'w', encoding='utf-8') as f:
                f.write(str(输入文本))
            print(f"✅ [班长节点] 保存成功: {完整文件路径}")
        except Exception as e:
            print(f"❌ [班长节点] 写入失败: {e}")

        print(f"🔍 [班长节点] ================= 结束 =================\n")
        return (输入文本,)


# ==============================================================================
# 节点 2: 文本智能区间提取 (BanZhangTextExtractor)
# ==============================================================================
class BanZhang_Text_Range_Extractor:
    """
    用于从长文本中，根据起始和结束标记，提取中间的内容。
    版本: V4.0 (终极融合版) - 内置智能匹配 + 新增 80% 相似度模糊识别
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "📄 原始长文档": ("STRING", {"multiline": True, "forceInput": True, "default": ""}),
                "🚩 起始标记词": ("STRING", {"multiline": False, "default": "### (Subject)"}),
                "🏁 结束标记词": ("STRING", {"multiline": False, "default": "---"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("✂️ 提取结果",)
    FUNCTION = "execute_extraction"
    CATEGORY = "👨‍🏫班长/文本处理"
    OUTPUT_NODE = True

    def _regex_match(self, text, marker, start_pos):
        try:
            pattern_str = re.escape(marker).replace(r'\ ', r'\s*')
            match = re.search(pattern_str, text[start_pos:], re.IGNORECASE)
            if match:
                return start_pos + match.start(), start_pos + match.end()
        except Exception as e:
            print(f"⚠️ 正则匹配跳过: {e}")
        return -1, -1

    def _fuzzy_match(self, text, marker, start_pos, threshold=0.8):
        if len(marker) < 3:
            return -1, -1

        lines = text[start_pos:].splitlines(keepends=True)
        current_idx = start_pos
        marker_len = len(marker)
        marker_lower = marker.lower()

        for line in lines:
            line_len = len(line)
            if line_len < marker_len * 0.5:
                current_idx += line_len
                continue

            if difflib.SequenceMatcher(None, marker_lower, line.lower()).quick_ratio() < 0.4:
                current_idx += line_len
                continue

            step = 1
            for i in range(0, max(1, line_len - marker_len + 5), step):
                window = line[i : i + marker_len + 2]
                ratio = difflib.SequenceMatcher(None, marker_lower, window.lower()).ratio()
                if ratio >= threshold:
                    found_start = current_idx + i
                    found_end = found_start + len(window)
                    return found_start, found_end
            current_idx += line_len
        return -1, -1

    def execute_extraction(self, **kwargs):
        full_text = kwargs.get("📄 原始长文档", "")
        start_marker = kwargs.get("🚩 起始标记词", "").strip()
        end_marker = kwargs.get("🏁 结束标记词", "").strip()
        full_text = str(full_text) if full_text is not None else ""

        final_result = ""
        ui_msg_result = ""
        match_method_log = ""

        print(f"\n--- 👨‍🏫 班长节点 (模糊匹配版) 开始执行 ---")

        if not full_text or not full_text.strip():
            ui_msg_result = "❌ 错误：输入的【原始长文档】是空的！"
        elif not start_marker:
            ui_msg_result = "❌ 错误：【起始标记词】未填写！"
        else:
            s_start, s_end = self._regex_match(full_text, start_marker, 0)
            if s_start == -1:
                print("ℹ️ 精确匹配失败，启动 80% 相似度模糊搜索...")
                s_start, s_end = self._fuzzy_match(full_text, start_marker, 0, threshold=0.8)
                if s_start != -1:
                    match_method_log = "(通过模糊匹配找到起始点: 相似度 > 80%)"

            if s_start == -1:
                ui_msg_result = f"⚠️ 提取失败：在文档中未找到起始标记\n👉 '{start_marker}'\n(已尝试精确匹配与模糊匹配)"
            else:
                actual_content_start = s_end
                e_start, e_end = self._regex_match(full_text, end_marker, actual_content_start)
                if e_start == -1:
                    e_start, e_end = self._fuzzy_match(full_text, end_marker, actual_content_start, threshold=0.8)

                if e_start == -1:
                    print(f"⚠️ 警告：没找到结束标记，提取到末尾。")
                    extracted_content = full_text[actual_content_start:]
                    ui_msg_result = f"⚠️ 警告：未找到结束标记 '{end_marker}'，已提取至末尾。\n{'-'*20}\n{extracted_content.strip()}"
                    final_result = extracted_content.strip()
                else:
                    extracted_content = full_text[actual_content_start:e_start]
                    final_result = extracted_content.strip()
                    if not final_result:
                        ui_msg_result = f"⚠️ 警告：定位成功，但中间没有内容。"
                    else:
                        ui_msg_result = final_result

        print(f"👨‍🏫 [后端] 处理完毕。{match_method_log}")
        return {
            "ui": {
                "text": [ui_msg_result, full_text]
            },
            "result": (final_result,)
        }


# ==============================================================================
# 节点 3: 文本智能分批 (BanZhang_TextBatchSplitter)
# ==============================================================================
class BanZhang_TextBatchSplitter:
    """
    👨‍🏫 班长提供的【文本智能分批节点】
    功能：将多行文本按指定规则切分，支持索引控制输出批次
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输入文本": ("STRING", {
                    "multiline": True,
                    "default": "提示词1\n提示词2\n提示词3\n提示词4\n提示词5",
                }),
                "分割方式": (["按换行符分割", "按空行(段落)分割", "按中文逗号分割"], {"default": "按换行符分割"}),
                "去除首尾空格": ("BOOLEAN", {"default": True, "label_on": "是 (推荐)", "label_off": "否"}),
                "忽略空行": ("BOOLEAN", {"default": True, "label_on": "忽略空行", "label_off": "保留空行"}),
                "起始索引": ("INT", {"default": 0, "min": 0, "step": 1}),
                "提取数量": ("INT", {"default": 9999, "min": 1, "max": 99999, "step": 1}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("📦 选定批次(连CLIP)", "📄 选定文本(拼接)", "🔢 选定数量", "👀 原文全览")
    OUTPUT_IS_LIST = (True, False, False, False)
    FUNCTION = "process_text_batch"
    CATEGORY = "👨‍🏫班长/文本处理"

    def process_text_batch(self, 输入文本, 分割方式, 去除首尾空格, 忽略空行, 起始索引, 提取数量):
        处理中文本 = 输入文本.replace('\r', '')
        原始列表 = []

        if 分割方式 == "按换行符分割":
            原始列表 = 处理中文本.split('\n')
        elif 分割方式 == "按空行(段落)分割":
            原始列表 = 处理中文本.split('\n\n')
        elif 分割方式 == "按中文逗号分割":
            处理中文本 = 处理中文本.replace('，', ',')
            原始列表 = 处理中文本.split(',')

        清洗后列表 = []
        for 单行内容 in 原始列表:
            if 去除首尾空格:
                单行内容 = 单行内容.strip()
            if 忽略空行 and len(单行内容) == 0:
                continue
            清洗后列表.append(单行内容)

        if len(清洗后列表) == 0:
            清洗后列表 = [""]

        总行数 = len(清洗后列表)
        有效起始 = max(0, min(起始索引, 总行数 - 1))
        有效结束 = min(有效起始 + 提取数量, 总行数)
        选定批次列表 = 清洗后列表[有效起始 : 有效结束]
        选定文本字符串 = "\n".join(选定批次列表)
        选定数量 = len(选定批次列表)
        原文预览 = "\n".join(清洗后列表)

        return (选定批次列表, 选定文本字符串, 选定数量, 原文预览)


# ==============================================================================
# 节点 4: 万能文本分割 (BanZhang_TitleSplitter)
# ==============================================================================
class BanZhang_TitleSplitter:
    """
    👨‍🏫 班长提供的【万能文本分割节点】(V8.0)
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        default_script = """### 步骤 2: 数据包
```json
{ "scene": "荒岛", "time": "日" }
```

### 步骤 3: 拍摄脚本
| 格数 | 运镜 | 提示词 |
| :--- | :--- | :--- |
| G1 | 左摇 | VO: "陈峰！是陈峰！" |
| G2 | 急推 | VO: "他还没死！" |
"""
        return {
            "required": {
                "输入文本": ("STRING", {"multiline": True, "default": default_script}),
                "分割模式": ([
                    "🎬 导演脚本/表格(智能拆解)",
                    "🏷️ 智能标题/正则 (分镜/Markdown)",
                    "🧩 包裹符字段(一键拆解)",
                    "📝 按段落(空行)分割",
                    "🪜 按单行分割",
                    "✂️ 自定义分隔符/正则提取"
                ], {"default": "🏷️ 智能标题/正则 (分镜/Markdown)"}),
                "分割特征或正则": ("STRING", {"default": "", "multiline": False}),
                "保留表格表头": ("BOOLEAN", {"default": True}),
                "去除首尾空格": ("BOOLEAN", {"default": True}),
                "起始索引": ("INT", {"default": 0, "min": 0, "step": 1}),
                "提取数量": ("INT", {"default": 9999, "min": 1, "max": 99999, "step": 1}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("📦 内容批次", "🏷️ 标题/索引", "📄 完整预览", "🔢 数量", "📜 合并文本")
    OUTPUT_IS_LIST = (True, True, False, False, False)
    FUNCTION = "main_process"
    CATEGORY = "👨‍🏫班长/文本处理"

    def main_process(self, **kwargs):
        input_text = kwargs.get("输入文本", "")
        split_mode = kwargs.get("分割模式", "")
        filter_pattern = kwargs.get("分割特征或正则", "")
        keep_header = kwargs.get("保留表格表头", True)
        trim_spaces = kwargs.get("去除首尾空格", True)
        start_index = kwargs.get("起始索引", 0)
        max_count = kwargs.get("提取数量", 9999)

        if not input_text:
            input_text = ""
        clean_text = input_text.replace('\r\n', '\n').replace('\r', '\n')
        split_results = []
        mode_json_text = ""

        if "导演脚本" in split_mode:
            temp_pool = []
            try:
                json_pattern = re.compile(r'```json\s*(.*?)\s*```', re.DOTALL | re.IGNORECASE)
                all_jsons = json_pattern.findall(clean_text)
                for idx, content in enumerate(all_jsons):
                    temp_pool.append({"title": f"📦 视觉数据包(JSON)_{idx+1}", "content": content.strip() if trim_spaces else content})
            except:
                pass

            lines = clean_text.split('\n')
            current_header = None
            current_divider = None
            is_in_table = False

            for i, line in enumerate(lines):
                stripped_line = line.strip()
                is_table_row = stripped_line.startswith('|') and stripped_line.endswith('|')
                if is_table_row:
                    if not is_in_table:
                        current_header = line
                        is_in_table = True
                        if i + 1 < len(lines) and '---' in lines[i+1]:
                            current_divider = lines[i+1]
                    elif current_divider and stripped_line == current_divider.strip():
                        continue
                    elif current_header and current_divider:
                        cols = stripped_line.split('|')
                        row_title = "表格行"
                        if len(cols) > 2:
                            row_title = re.sub(r"[\*#]+", "", cols[1].strip()).strip()
                        row_content = f"{current_header}\n{current_divider}\n{line}" if keep_header else line
                        temp_pool.append({"title": f"🎬 {row_title}", "content": row_content})
                else:
                    is_in_table = False

            if filter_pattern and filter_pattern.strip():
                search_word = filter_pattern.strip().lower()
                split_results = [item for item in temp_pool if search_word in item["title"].lower() or search_word in item["content"].lower()]
            else:
                split_results = temp_pool

        elif "智能标题" in split_mode:
            user_regex = filter_pattern.strip() if filter_pattern else ""
            if user_regex.lower() == "json":
                try:
                    json_pattern = re.compile(r'```json\s*(.*?)\s*```', re.DOTALL | re.IGNORECASE)
                    matches = json_pattern.findall(clean_text)
                    for idx, m in enumerate(matches):
                        split_results.append({"title": f"📦 JSON_{idx+1}", "content": m.strip() if trim_spaces else m})
                except:
                    pass
            else:
                lines = clean_text.split('\n')
                curr_title = "前言(表头)"
                curr_content = []
                regex = user_regex if user_regex else r"(^#+\s+)|(^\s*(?:[\*_`\[]*\s*)?(?:第\s*[0-9一二三四五六七八九十]+\s*[镜集回场章节]|No\.\s*\d+|Vol\.\s*\d+|[a-zA-Z]*\d+))"
                for line in lines:
                    try:
                        is_title = bool(re.search(regex, line.strip(), re.IGNORECASE))
                    except:
                        is_title = False
                    if is_title:
                        if curr_content:
                            split_results.append({"title": curr_title, "content": "\n".join(curr_content)})
                        curr_title = line.strip()
                        if "|" in curr_title:
                            cols = curr_title.split("|")
                            if len(cols) > 2:
                                curr_title = cols[1].strip()
                        curr_content = [line]
                    else:
                        curr_content.append(line)
                if curr_content:
                    split_results.append({"title": curr_title, "content": "\n".join(curr_content)})

        elif "包裹符字段" in split_mode:
            # 一次解析 <<<NAME>>>...<<<NAME_END>>> 等全部包裹字段
            wrapped_records, _wrapped_order, _ = _extract_wrapped_fields(clean_text, "auto", trim_spaces)
            multi_record = len(wrapped_records) > 1
            for r_idx, record in enumerate(wrapped_records):
                for fname, fval in record.items():
                    title = f"🎵 歌曲{r_idx+1}·{fname}" if multi_record else f"🏷️ {fname}"
                    split_results.append({"title": title, "content": fval})
            mode_json_text = json.dumps(wrapped_records, ensure_ascii=False, indent=2)

        elif "自定义" in split_mode:
            sep = filter_pattern.strip() if filter_pattern else ","
            is_regex_extraction = False
            regex_pattern = ""
            if "*" in sep and ".*" not in sep and "?P<" not in sep:
                try:
                    temp_pat = re.escape(sep).replace(r"\ ", r"\s*").replace(r"\:", r"\s*[:：]\s*").replace(r'\"', r"[\"\"\"]").replace(r"\'", r"[''']").replace(r"\(", r"[\(（]").replace(r"\)", r"[\)）]").replace(r"\=", r"\s*=\s*").replace(r"\*", r"(.*?)")
                    regex_pattern = temp_pat
                    is_regex_extraction = True
                except:
                    pass
            elif "(" in sep and ")" in sep:
                regex_pattern = sep
                is_regex_extraction = True

            if is_regex_extraction:
                try:
                    matches = re.findall(regex_pattern, clean_text, re.DOTALL | re.IGNORECASE)
                    for i, match in enumerate(matches):
                        content = match if isinstance(match, str) else " ".join(match)
                        if trim_spaces:
                            content = content.strip()
                        if content:
                            split_results.append({"title": f"提取_{i+1}", "content": content})
                except:
                    split_results.append({"title": "❌ 错误", "content": "正则解析失败"})
            else:
                for i, p in enumerate(clean_text.split(sep)):
                    if trim_spaces:
                        p = p.strip()
                    if p:
                        split_results.append({"title": f"片段_{i+1}", "content": p})

        elif "按段落" in split_mode:
            for i, p in enumerate(re.split(r'\n\s*\n', clean_text)):
                if p.strip():
                    split_results.append({"title": f"段落_{i+1}", "content": p})
        elif "按单行" in split_mode:
            for i, line in enumerate(clean_text.split('\n')):
                if line.strip():
                    split_results.append({"title": f"行_{i+1}", "content": line})

        total_found = len(split_results)
        py_start = max(0, min(start_index, total_found))
        py_end = max(py_start, min(py_start + max_count, total_found))
        final_data = split_results[py_start : py_end]

        if not final_data:
            out_contents = [""]
            out_titles = ["无结果"]
        else:
            out_contents = [item["content"] for item in final_data]
            out_titles = [item["title"] for item in final_data]

        actual_count = len(out_contents)
        all_combined_text = "\n".join(out_contents) if out_contents and out_contents[0] != "" else ""
        if mode_json_text:
            # 包裹符模式下，第 5 端口直接输出结构化 JSON 而非简单拼接
            all_combined_text = mode_json_text

        preview_report = f"📊 班长调试报告 (V8.0)\n模式: {split_mode}\n"
        preview_report += f"📥 总匹配: {total_found} | 📤 输出: {actual_count}\n"
        preview_report += "-"*20 + "\n"
        for i, item in enumerate(final_data):
            preview_report += f"#{py_start+i} {item['title']}: {item['content'][:30]}...\n"

        return (out_contents, out_titles, preview_report, actual_count, all_combined_text)


# ==============================================================================
# 节点 5: 文本循环收集器 (BanZhang_Text_Batcher)
# ==============================================================================
class BanZhang_Text_Batcher:
    """
    功能说明：
    这个节点专门用于在循环（For Loop）中收集文本。
    它可以把每次循环生成的文本拼接在一起，形成一篇长文或列表。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "现有文本堆": ("STRING", {"forceInput": True}),
                "新文本": ("STRING", {"forceInput": True}),
                "连接方式": (["⬇️ 换行符 (\\n)", "➕ 逗号分隔 (,)", "⬜ 空格分隔 ( )", "🔗 无缝拼接"], {"default": "⬇️ 换行符 (\\n)"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("📜 整合后的文本",)
    FUNCTION = "collect_text"
    CATEGORY = "👨‍🏫班长/文本处理"

    def collect_text(self, 现有文本堆, 新文本, 连接方式):
        if 现有文本堆 is None:
            return (新文本,)

        str_现有 = str(现有文本堆)
        str_新 = str(新文本)

        if str_现有 == "":
            return (str_新,)

        连接符 = ""
        if "换行符" in 连接方式:
            连接符 = "\n"
        elif "逗号" in 连接方式:
            连接符 = ","
        elif "空格" in 连接方式:
            连接符 = " "
        else:
            连接符 = ""

        合并后的文本 = str_现有 + 连接符 + str_新
        return (合并后的文本,)


# ==============================================================================
# 节点 6: 万能包裹符解析器 (BanZhang_WrapperParser) —— 与业务无关的通用解包
# 字段名与字段数量完全由输入文本(或用户字段清单)决定；
# 前端 JS 为每个字段动态生成一个同名输出端口，无需循环、无需重复跑节点
# ==============================================================================
class BanZhang_WrapperParser:
    """
    🔌 班长-万能包裹符解析器 (V8.1)
    单份记录 → 每个字段端口一个值；多份记录 → 每个端口输出对齐批次(list)。
    缺失字段自动兜底为空串并在预览中告警，节点永不报错中断。
    """

    MAX_PORTS = 24  # 动态端口上限(静态 RETURN_TYPES 长度，受 ComfyUI 校验机制约束)
    STYLE_OPTIONS = {
        "🤖 自动识别 (推荐)": "auto",
        "🔺 三角 <<<NAME>>>": "triangle",
        "🔤 XML <NAME>": "xml",
        "🔣 双花括号 {{NAME}}": "mustache",
        "📦 方括号 [NAME]": "bbcode",
        "✏️ 自定义正则": "custom",
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 默认留空：示例以前端灰色 placeholder 呈现，不参与解析
                "输入文本": ("STRING", {"multiline": True, "default": ""}),
                "包裹符格式": (list(cls.STYLE_OPTIONS.keys()), {"default": "🤖 自动识别 (推荐)"}),
                "自定义正则(2捕获组:名称,内容)": ("STRING", {
                    "default": "", "multiline": False,
                    "tooltip": "仅当格式选「自定义正则」时生效，示例：@@(\\w+)@@(.*?)@@/\\1@@",
                }),
                "输出字段清单(每行一个,留空=自动)": ("STRING", {
                    "default": "", "multiline": True,
                    "tooltip": "高级：每行只填一个字段名(如 STYLE)，强制端口顺序；留空则自动解析正文，勿把正文/模板粘进此处",
                }),
                "去除首尾空格": ("BOOLEAN", {"default": True}),
                "占位符自动置空": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "检测到 [待填写] / [在此处撰写...] 等未填写占位时自动输出空值，避免脏数据流入下游",
                }),
                "起始记录": ("INT", {"default": 0, "min": 0, "step": 1}),
                "记录数量": ("INT", {"default": 999, "min": 1, "max": 9999, "step": 1}),
            }
        }

    RETURN_TYPES = tuple(["STRING"] * MAX_PORTS) + ("STRING", "INT", "STRING")
    RETURN_NAMES = tuple(f"字段 {i+1}" for i in range(MAX_PORTS)) + (
        "📦 全部字段(JSON)", "🔢 记录数", "📄 解析预览",
    )
    OUTPUT_IS_LIST = tuple([True] * MAX_PORTS) + (False, False, False)
    FUNCTION = "parse"
    CATEGORY = "👨‍🏫班长/文本处理"

    def parse(self, **kwargs):
        text = kwargs.get("输入文本", "") or ""
        style_label = kwargs.get("包裹符格式", "🤖 自动识别 (推荐)")
        custom_pattern = (kwargs.get("自定义正则(2捕获组:名称,内容)", "") or "").strip()
        field_spec = kwargs.get("输出字段清单(每行一个,留空=自动)", "") or ""
        trim = kwargs.get("去除首尾空格", True)
        blank_placeholder = kwargs.get("占位符自动置空", True)
        start = max(0, int(kwargs.get("起始记录", 0)))
        count = max(1, int(kwargs.get("记录数量", 999)))

        style_key = self.STYLE_OPTIONS.get(style_label, "auto")
        cp = custom_pattern if style_key == "custom" and custom_pattern else None
        records, auto_order, hit_styles = _extract_wrapped_fields(text, style_key, trim, cp)
        total_records = len(records)
        records = records[start:start + count]

        # 输出字段：用户清单优先(容错解析)，否则用自动解析顺序
        specified, spec_dropped = _parse_field_spec_lines(field_spec)
        field_names = (specified if specified else auto_order)[: self.MAX_PORTS]

        warnings = []
        if spec_dropped:
            warnings.append(f"⚠️ 字段清单 {spec_dropped} 行不是合法字段名，已忽略（每行只填字段名，勿粘正文）")
        port_lists = []
        for fname in field_names:
            values = []
            for r_idx, record in enumerate(records):
                raw_value = record.get(fname, "")
                if not raw_value:
                    warnings.append(f"⚠️ 记录{start + r_idx + 1} · {fname} 缺失或为空")
                elif blank_placeholder and _is_placeholder(raw_value):
                    warnings.append(f"⚠️ 记录{start + r_idx + 1} · {fname} 仍是模板占位符，已置空")
                    raw_value = ""
                values.append(raw_value)
            port_lists.append(values if values else [""])

        # JSON：输出字段 + 文本中出现的其他字段(未知字段不丢失)
        extra_keys = []
        for record in records:
            for key in record:
                if key not in field_names and key not in extra_keys:
                    extra_keys.append(key)
        json_keys = list(field_names) + extra_keys
        json_records = []
        for record in records:
            obj = {}
            for key in json_keys:
                value = record.get(key, "")
                if blank_placeholder and value and _is_placeholder(value):
                    value = ""
                obj[key] = value
            json_records.append(obj)

        # 无结果 / 端口补齐到静态长度
        if not records:
            port_lists = [[""] for _ in range(self.MAX_PORTS)]
            json_text = "[]"
            field_list = ""
        else:
            while len(port_lists) < self.MAX_PORTS:
                port_lists.append([""])
            json_text = json.dumps(json_records, ensure_ascii=False, indent=2)
            field_list = ", ".join(field_names)

        # ── 解析预览报告 (状态、告警、逐条字段摘要) ──
        style_hit_text = "、".join(
            _WRAPPER_PATTERNS[k][1] for k in hit_styles if k in _WRAPPER_PATTERNS)
        if not style_hit_text:
            style_hit_text = "✏️ 自定义正则" if hit_styles else "未命中"
        preview = "🔌 班长包裹符解析报告 (V8.1)\n"
        preview += f"格式: {style_label} | 实际命中: {style_hit_text}\n"
        preview += f"📥 解析记录: {total_records} | 📤 输出: {len(records)} | 🏷️ 字段: {field_list or '无'}\n"
        if warnings:
            preview += "─" * 24 + "\n" + "\n".join(warnings) + "\n"
        preview += "─" * 24 + "\n"
        for r_idx, obj in enumerate(json_records):
            preview += f"🔌 记录 [{start + r_idx + 1}]\n"
            for fname in field_names:
                snippet = (obj.get(fname, "") or "").replace("\n", " ⏎ ")[:40]
                preview += f"   {fname}: {snippet or '∅'}\n"

        return tuple(port_lists) + (json_text, len(records), preview)


# 后端解析路由：供前端 JS 自动识别字段名(无需在 JS 里重复解析逻辑)
def _register_wrapper_route():
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None or getattr(_register_wrapper_route, "_done", False):
        return

    @server.routes.post("/banzhang/parse_wrapper")
    async def _parse_wrapper_route(request):
        data = await request.json()
        custom_pattern = (data.get("custom_pattern") or "").strip()
        style = data.get("style", "auto")
        cp = custom_pattern if style == "custom" and custom_pattern else None
        records, order, hits = _extract_wrapped_fields(
            data.get("text", ""), style, True, cp)
        return web.json_response({
            "fields": order, "records": records,
            "hits": hits, "count": len(records),
        })

    _register_wrapper_route._done = True


_register_wrapper_route()





# 注册映射
NODE_CLASS_MAPPINGS = {
    "Banzhang_SaveText": Banzhang_SaveText,
    "BanZhang_Text_Range_Extractor": BanZhang_Text_Range_Extractor,
    "BanZhang_TextBatchSplitter": BanZhang_TextBatchSplitter,
    "BanZhang_TitleSplitter": BanZhang_TitleSplitter,
    "BanZhang_Text_Batcher": BanZhang_Text_Batcher,
    "BanZhang_WrapperParser": BanZhang_WrapperParser
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_SaveText": "💾 班长智能文本保存",
    "BanZhang_Text_Range_Extractor": "✂️ 文本智能区间提取",
    "BanZhang_TextBatchSplitter": "✂️ 文本智能分批 (Text Batch)",
    "BanZhang_TitleSplitter": "📑 班长-万能文本分割 V8.0",
    "BanZhang_Text_Batcher": "📝 文本循环收集器 (Batch Text)",
    "BanZhang_WrapperParser": "🔌 班长-万能包裹符解析器 V8.1"
}
