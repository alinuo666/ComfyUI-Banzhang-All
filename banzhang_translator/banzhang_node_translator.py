# -*- coding: utf-8 -*-
import os
import json
import inspect
import re
import hashlib
import nodes
import folder_paths
from pathlib import Path
from .banzhang_utils import AnyType

# ================= JS 前端文本扫描正则模式 =================
# 提取 JS 中 widget 的 name/label（通过 addWidget 或 widget 配置对象）
_JS_WIDGET_RE = re.compile(
    r'''(?:addWidget|widgets\.push)\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']'''
)

# JS 字符串转义还原：\uXXXX → 实际字符、\xXX → 字符、\n/\t/\r → 控制符、\\/\" 等 → 字面符。
# 浏览器实际渲染的 DOM 文本是"还原后"的字符，因此抓取文本必须先还原，前端替换才能精确命中。
_JS_STRING_UNESCAPE_RE = re.compile(
    r'\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrt0\\"\'/])'
)

# 已知的非 UI 字符串排除模式（纯小写标识符：变量名/事件名等，仅在非 UI 上下文中排除）
_JS_EXCLUDE_PATTERNS = re.compile(
    r'^(?:[a-z_][\w\-]*|node|app|widget|combo|toggle|slider|text|number|boolean|button|image|video|audio|string|int|float|bool|true|false|null|undefined|return|function|class|const|let|var|import|export|require|module)$'
)

# 前端扫描时排除的目录：资源/文档/缓存/测试等不含 UI 文本的目录
# （ComfyUI 插件前端目录五花八门：js/、web/、web_version/、javascript/ 等，
#   因此采用全插件递归扫描 + 排除清单，确保任意目录结构都不漏）
_JS_SCAN_EXCLUDE_DIRS = {
    "__pycache__", ".git", ".github", ".vscode", ".idea", "node_modules",
    "docs", "doc", "examples", "example_workflows", "notebook", "troubleshooting",
    "tests", "test", "__tests__", "coverage", "e2e", "cypress", "playwright",
    "fonts", "models", "assets", "images", "image", "res", "resources", "luts",
    "audio", "video", "media", "caches", "cache", "workflow", "workflows",
    "locales", "wildcards", "custom_wildcards", "repos", "input", "output",
    "temp", "presets", "prompts", "styles", "samples", "icons", "svg", "dist", "build",
}

# 前端扫描时排除的文件：构建/测试配置、类型声明等（如 playwright.config.js、*.test.js、.d.ts）
_JS_SCAN_EXCLUDE_FILE_RE = re.compile(
    r'''^\.'''
    r'''|\.(?:config|test|spec)\.(?:js|mjs|ts|mts|cts)$'''
    r'''|\.d\.ts$''',
    re.IGNORECASE
)

# JS 关键字/字面量：无论上下文如何都不算 UI 文本
_JS_KEYWORDS = {
    "true", "false", "null", "undefined", "nan", "infinity", "this", "super",
    "function", "return", "var", "let", "const", "class", "new", "typeof",
    "instanceof", "void", "delete", "import", "export", "default", "extends",
    "async", "await", "yield", "throw", "try", "catch", "finally", "switch",
    "case", "break", "continue", "do", "while", "for", "if", "else", "in",
    "of", "static", "get", "set", "then", "none", "end", "begin",
}

# UI 上下文提示：字符串附近出现这些特征 → 该字符串会展示给用户（小写单词也算 UI 文本）
_JS_UI_HINT_RE = re.compile(
    r'''innerText|textContent|innerHTML|placeholder|tooltip|title\s*[:=]|label\s*[:=,]|aria-label|'''
    r'''alert\s*\(|confirm\s*\(|toast|message\s*[:=,]|button|menu|dialog|modal|hint|caption|badge|'''
    r'''addWidget|addDOMWidget|addSetting|registerExtension|name\s*:\s*["']|text\s*[:=,]\s*["']|'''
    r'''option|select\s*[:=,]|checkbox|combobox|header|footer|content\s*[:=,]''',
    re.IGNORECASE
)

# 事件绑定上下文：旁边的纯小写单词多为事件名（click/change/input 等），不是 UI 文本
_JS_EVENT_CTX_RE = re.compile(
    r'addEventListener|removeEventListener|dispatchEvent|\.on\(|\.off\(|\.emit\(|\.once\('
)

# 文件路径/URL 特征（./xxx、../xxx、xxx.js、https:// 等），不是 UI 文本
_JS_PATH_LIKE_RE = re.compile(
    r'''^(?:[\w\-]+\.)+(?:js|mjs|cjs|ts|css|scss|less|html|htm|json|png|jpe?g|gif|webp|svg|ico|py|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|safetensors|ckpt|pt|pth|gguf|bin|yaml|yml|toml|md|txt|csv|xml|zip)$'''
    r'''|^(?:\.{1,2}/|/|[A-Za-z]:[\\/])''',
    re.IGNORECASE
)

# 纯小写单词（候选事件名/标识符）
_JS_LOWER_WORD_RE = re.compile(r'^[a-z][a-z0-9_\-]*$')

# HTML 标签名：不是 UI 文本（div/span/TEXTAREA 等）
_HTML_TAG_NAMES = {
    "div", "span", "input", "textarea", "button", "canvas", "svg", "path",
    "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "label",
    "form", "img", "video", "audio", "select", "option", "header", "footer",
    "section", "main", "nav", "aside", "template", "style", "link", "meta",
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "b", "i", "em", "strong",
    "small", "br", "hr", "iframe", "object", "embed", "source", "track",
    "datalist", "optgroup", "output", "progress", "meter", "fieldset",
    "legend", "details", "summary", "dialog", "figure", "figcaption",
    "mark", "abbr", "cite", "code", "pre", "blockquote", "article", "kbd",
}

# 常见字体名：不是 UI 文本（Segoe UI 等）
_FONT_NAMES = {
    "segoe ui", "arial", "helvetica", "times new roman", "courier new",
    "consolas", "monospace", "sans-serif", "serif", "microsoft yahei",
    "simhei", "simsun", "roboto", "inter", "noto sans", "noto serif",
    "menlo", "monaco", "ubuntu", "calibri", "cambria", "verdana", "tahoma",
    "geneva", "georgia", "palatino", "bookman", "comic sans ms",
}

class BanzhangNodeTranslator:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "⚡ 执行开关": ("BOOLEAN", {"default": True, "label_on": "🚀 启动", "label_off": "😴 暂停"}),
                "🔍 插件搜索": ("STRING", {"default": "", "multiline": False, "placeholder": "输入 菜单名(Category) 或 文件夹名(如 layerstyle)"}),
                "📂 保存目录": ("STRING", {"default": "output", "multiline": False}),
            },
            "optional": {
                "🔗 识别用节点": (AnyType("*"), {"tooltip": "连线识别来源 (可选)"}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"}
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("📄 运行状态报告", "📂 JSON文件路径")
    FUNCTION = "execute_task"
    CATEGORY = "👨‍🏫班长/文本处理"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        m = hashlib.sha256()
        for k in ["🔍 插件搜索", "⚡ 执行开关", "📂 保存目录"]:
            v = kwargs.get(k, "")
            m.update(str(v).encode())
        prompt = kwargs.get("prompt", {})
        unique_id = kwargs.get("unique_id", None)
        if unique_id and prompt:
            node_data = prompt.get(str(unique_id), {})
            inputs_config = node_data.get("inputs", {})
            m.update(str(inputs_config).encode())
        return m.hexdigest()

    @staticmethod
    def _get_plugin_root(node_class):
        """反查节点类所在插件根目录，返回 (绝对路径, 目录名)；非 custom_nodes 返回 (None, None)。"""
        try:
            abs_path = os.path.abspath(inspect.getfile(node_class))
            parts = abs_path.split(os.sep)
            if "custom_nodes" in parts:
                idx = parts.index("custom_nodes")
                if idx + 1 < len(parts):
                    return os.sep.join(parts[:idx + 2]), parts[idx + 1]
        except (TypeError, OSError):
            pass
        return None, None

    @staticmethod
    def _get_attr_value(node_class, attr_name, default=None):
        """获取节点属性值，兼容 classmethod（声明式节点 io.ComfyNode）与普通属性（传统节点）。
        声明式节点把 CATEGORY/INPUT_TYPES/RETURN_NAMES 等定义为 classmethod，直接 getattr 会拿到 bound method。"""
        val = getattr(node_class, attr_name, None)
        if val is None:
            return default
        if callable(val):
            try:
                return val()
            except Exception:
                return default
        return val

    def _scan_js_file_for_ui_texts(self, file_path):
        """扫描单个 JS 文件，提取所有用户可见的英文 UI 文本字符串（需翻译为中文）

        返回: { "字符串内容": {"file": "文件名", "context": "上下文类型", "original": "英文原文"} }
        """
        result = {}
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception:
            return result

        file_name = os.path.basename(file_path)

        # 方法1：提取引号/模板字符串中的英文文本（排除换行，避免跨行抓取代码块）
        for match in re.finditer(
            r'''[`"']([^`"'\n]{2,})[`"']''', content
        ):
            # 先还原 JS 转义（\u2014 → — 等），使文本与浏览器渲染的 DOM 文本一致
            raw = self._unescape_js_string(match.group(1)).strip()
            if not raw or '\n' in raw or '\r' in raw:
                continue  # 还原后含换行 → 跨行代码/模板串，跳过
            # 获取上下文（前后40字符），判断是否 UI 展示场景
            pos = match.start()
            ctx = content[max(0, pos - 40):pos + 40].replace('\n', ' ')
            ui_hint = bool(_JS_UI_HINT_RE.search(ctx))
            # 事件绑定旁的纯小写单词多为事件名（click/change 等），不算 UI 文本
            if ui_hint and _JS_EVENT_CTX_RE.search(ctx) and _JS_LOWER_WORD_RE.match(raw):
                ui_hint = False

            candidates = [raw]
            # 含 HTML 标签的串（innerHTML/模板片段）：拆出标签之间的可见文本。
            # 例："Drop an image here<br><span>or use the buttons below</span>"
            #     → "Drop an image here"、"or use the buttons below"
            if re.search(r'</?[A-Za-z]', raw):
                chunks = [c.strip() for c in re.findall(r'>([^<>]+)<', f'>{raw}<') if c.strip()]
                if chunks:
                    candidates = chunks
                else:
                    stripped_html = re.sub(r'<[^>]+>', ' ', raw).strip()
                    if stripped_html:
                        candidates = [stripped_html]

            for text in candidates:
                if not self._is_translatable_ui_text(text, ui_context=ui_hint):
                    continue
                result[text] = {
                    "file": file_name,
                    "context": self._classify_ui_context(ctx, text),
                    "original": text,
                }

        # 方法2：提取 widget 名称（英文）——addWidget("类型", "名称", ...) 的第2参数必然展示给用户
        # （第1参数是内部类型 combo/button/text 等，不翻译）
        for match in _JS_WIDGET_RE.finditer(content):
            w_name, w_label = match.group(1), match.group(2)
            w_label = self._unescape_js_string(w_label).strip()
            if self._is_translatable_ui_text(w_label, ui_context=True):
                result[w_label] = {"file": file_name, "context": f"widget标签 (内部名: {w_name})", "original": w_label}

        # 方法3：提取 addSetting 中的英文 name——设置项名称必然展示给用户
        for match in re.finditer(
            r'''addSetting\(\s*\[?\s*["']([^"']{2,})["']''', content
        ):
            text = self._unescape_js_string(match.group(1)).strip()
            if self._is_translatable_ui_text(text, ui_context=True):
                result[text] = {"file": file_name, "context": "设置项名称", "original": text}

        return result

    @staticmethod
    def _unescape_js_string(text):
        r"""还原 JS 字符串转义（\u2014 → —、\n → 换行、\\ → \ 等）。
        浏览器渲染的 DOM 文本是还原后的字符，先还原才能让翻译键与界面文本精确匹配。"""
        def _sub(m):
            esc = m.group(1)
            if esc[0] in 'ux':
                try:
                    return chr(int(esc[1:], 16))
                except ValueError:
                    return m.group(0)
            return {'n': '\n', 't': '\t', 'r': '\r', '0': '\0',
                    '\\': '\\', '"': '"', "'": "'", '/': '/'}.get(esc, m.group(0))
        return _JS_STRING_UNESCAPE_RE.sub(_sub, text)

    @staticmethod
    def _is_translatable_ui_text(text, ui_context=False):
        """判断字符串是否为需翻译的英文 UI 文本：含英文、不含中文、非纯代码标识符/关键字/路径噪音。

        ui_context=True 表示字符串处于 UI 展示上下文（label/placeholder/innerHTML/widget 等），
        此时纯小写单词（如 loading/success/error）也算 UI 文本，不再一刀切排除。
        """
        if not text or len(text) < 2:
            return False
        if not re.search(r'[A-Za-z]', text):
            return False  # 无英文，无需翻译
        if re.search(r'[\u4e00-\u9fff]', text):
            return False  # 已含中文，跳过
        stripped = text.lstrip()
        # 排除 CSS 色码 / 模板插值 / CSS 类名前缀 / 纯 CSS 数值（数字+单位）
        if stripped.startswith('#') or stripped.startswith('.') or stripped.startswith('${'):
            return False
        if re.match(r'^[\d.]+\s*(px|em|rem|%|vh|vw|ms|s|deg|fr|pt|cm|mm|in)?\s*$', stripped):
            return False
        # 排除 URL / data URI / 文件路径（./xxx、../xxx、xxx.js 等）
        if '://' in text or stripped.startswith('data:') or _JS_PATH_LIKE_RE.match(stripped):
            return False
        # 排除模块导入别名（@/composable/xxx、@constants 等）
        if re.match(r'^@[\w\-/]', stripped):
            return False
        # 排除图标/CSS 类名列表（mdi mdi-xxx、fa fa-xxx 等）
        if re.match(r'^(?:mdi|fa[sbr]?|bi|material-icons|icon)\s', text):
            return False
        # 排除 ${} 模板插值且其余部分全为小写标识符的 CSS 类名模板（如 "mdi ${PREFIX}theme"）
        if '${' in text:
            parts = re.sub(r'\$\{[^}]*\}', ' ', text).split()
            if parts and all(re.match(r'^[a-z][\w\-]*$', p) for p in parts):
                return False
        # 排除正则/代码片段（无空格且含 \d、(?:、连续元字符，如 "-?\d*(?:\.\d+)"）
        if ' ' not in text and (
            re.search(r'\\[dwsSWbBnv]', text) or '(?:' in text
            or re.search(r'[$^*+|()\[\]{}?]{2}', text)
        ):
            return False
        # 含反斜杠转义序列的文本（\t、\u2014、\n 等，多为正则/代码/转义片段）
        if '\\' in text:
            return False
        # 排除 JS 关键字与字面量
        if text.lower() in _JS_KEYWORDS:
            return False
        # ===== 代码片段噪音排除（CSS/HTML/JS 拼接片段、选择器、属性名等）=====
        # CSS 声明串：含分号且有 属性:值 形式（如 "display:flex;gap:6px;"）
        if ';' in text and re.search(r'[\w-]+\s*:', text):
            return False
        # HTML 标签片段（含 <tag 或 </tag，如 "</b> <span class="）
        if re.search(r'</?[A-Za-z][A-Za-z0-9]*', text):
            return False
        # CSS 选择器（#id、[attr]、[attr=，如 "canvas#graph-canvas"、"[data-kind]"）
        if re.search(r'\w#\w', text) or re.search(r'\[[\w-]+(?:=|\])', text):
            return False
        # aria-/data- HTML 属性名（aria-disabled、data-focus=）
        if re.match(r'^(?:aria|data)-[\w-]+', stripped):
            return False
        # 以代码符号开头/结尾的拼接片段（")...</b>"、"; seek.max ="、"}  ${...}"、"&t="、"· ..."、"^..."）
        if stripped[0] in ')]}>+;,=&\\·^' or stripped[-1] in '([{<+=&;(':
            return False
        # JS 方法调用链（".join("、".slice(0," 等）
        if re.search(r'\.\w+\s*\(', text):
            return False
        # 文件扩展名列表（"audio/*,.wav,.mp3"）与数字开头的格式名（"3gp"）
        if re.search(r'\*\.\w+', text) or re.search(r',\.\w{2,4}\b', text) or re.match(r'^\d[\w.]{0,4}$', text):
            return False
        # URL 查询参数片段（"&type=input&subfolder="）
        if re.search(r'&[\w-]+=', text):
            return False
        # 无空格含 . 或 / 的路径/命名空间（"cglide.glidecast"、"assets/"）。
        # 仅当真的是路径形态时排除：含 /、或点号夹在两个单词之间（a.b / file.png）。
        # 尾部单点/省略号（"Ready."、"Analyzing..."）是真实 UI 文本，不能误杀。
        if ' ' not in text and ('/' in text or re.search(r'\w\.\w', text)):
            return False
        # HTTP 头名（"Content-Type"）
        if re.match(r'^[A-Z][a-z]+-[A-Z][A-Za-z]+$', text):
            return False
        # 无空格的驼峰标识符（类名/组件名，如 "CSGlideCastCS"、"GlideVideo"）。
        # 带连字符的复合标签（如 "OpenAI-compatible"）是真实 UI 文本，不排除。
        if ' ' not in text and '-' not in text and re.search(r'[a-z][A-Z]', text):
            return False
        # 无空格含下划线：snake_case 变量/常量名（"integrated_multimodal_description"）
        if ' ' not in text and '_' in text:
            return False
        # 无空格全小写带连字符：kebab-case CSS 类名（"gcast-css"、"gcast-select"）
        if ' ' not in text and re.match(r'^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$', text):
            return False
        # 下划线开头的常量/属性值（"_blank"、"_self"）
        if stripped.startswith('_'):
            return False
        # 含函数调用插值的模板串（"${mmss(t)}"、"${bl.slice(0,300)}"）——代码拼接特征
        if re.search(r'\$\{[^}]*\(', text):
            return False
        # HTML 标签名 / 字体名（div、span、Segoe UI 等）
        if text.lower() in _HTML_TAG_NAMES or text.lower() in _FONT_NAMES:
            return False
        # 纯小写标识符（变量名/事件名）：仅在 UI 上下文中视为可翻译文本
        if _JS_EXCLUDE_PATTERNS.match(text):
            return bool(ui_context)
        return True

    def _classify_ui_context(self, context_snippet, text):
        """根据上下文判断 UI 字符串的类型"""
        ctx_lower = context_snippet.lower()
        if 'placeholder' in ctx_lower or '占位' in ctx_lower:
            return "placeholder"
        if 'tooltip' in ctx_lower or 'title' in ctx_lower:
            return "tooltip/提示"
        if 'alert(' in ctx_lower or '弹窗' in context_snippet:
            return "弹窗消息"
        if 'console.log' in ctx_lower or 'console.error' in ctx_lower:
            return "控制台日志"
        if 'innerHTML' in ctx_lower or 'textContent' in ctx_lower or 'innerText' in ctx_lower:
            return "DOM文本"
        if 'label' in ctx_lower and ('"' in context_snippet or "'" in context_snippet):
            return "标签文本"
        if 'menu' in ctx_lower or '右键' in context_snippet:
            return "菜单项"
        if 'button' in ctx_lower or '按钮' in context_snippet:
            return "按钮标签"
        if 'addwidget' in ctx_lower or 'widgets.push' in ctx_lower:
            return "widget定义"
        if 'addsetting' in ctx_lower:
            return "设置项"
        return "UI文本"

    def _scan_plugin_frontend(self, plugin_root):
        """递归扫描插件全目录下的前端文件（js/mjs/ts），自动跳过资源/文档/缓存目录。

        相比旧版只扫 js/、web/ 两个固定目录，可覆盖：
        - web_version/（如 ComfyUI-Easy-Use 的自定义 WEB_DIRECTORY）
        - 根目录散落的 .js 文件（旧式插件）
        - 任意命名的自定义前端目录
        返回: (UI文本汇总dict, 扫描的文件数)
        """
        all_texts = {}
        root = Path(plugin_root)
        if not root.exists():
            return all_texts, 0

        js_files = []
        seen = set()
        for dirpath, dirnames, filenames in os.walk(root):
            # 原地过滤排除目录与隐藏目录，阻止 os.walk 深入（性能保护）
            dirnames[:] = [d for d in dirnames if d not in _JS_SCAN_EXCLUDE_DIRS and not d.startswith('.')]
            for fn in filenames:
                if fn.lower().endswith(('.js', '.mjs', '.ts')) and not _JS_SCAN_EXCLUDE_FILE_RE.search(fn):
                    p = Path(dirpath) / fn
                    k = str(p).lower()
                    # 去重（防大小写差异导致重复扫描同一文件）
                    if k not in seen:
                        seen.add(k)
                        js_files.append(p)

        for js_file in sorted(js_files, key=lambda p: str(p).lower()):
            file_texts = self._scan_js_file_for_ui_texts(str(js_file))
            if file_texts:
                all_texts.update(file_texts)

        return all_texts, len(js_files)

    def execute_task(self, **kwargs):
        enable_switch = kwargs.get("⚡ 执行开关", True)
        raw_search_query = kwargs.get("🔍 插件搜索", "").strip()
        save_dir_input = kwargs.get("📂 保存目录", "output")
        reference_data = kwargs.get("🔗 识别用节点", None)
        prompt_data = kwargs.get("prompt", None)
        my_node_id = kwargs.get("unique_id", None)

        if not enable_switch: return ("😴 暂停中...", "")

        # ====== 主线：Python 节点扫描 + JS 前端文本扫描（内置合并）======
        target_class_type = None 
        if reference_data is not None and prompt_data and my_node_id:
            try:
                my_node_data = prompt_data.get(str(my_node_id))
                if my_node_data and "inputs" in my_node_data:
                    link_info = my_node_data["inputs"].get("🔗 识别用节点")
                    if isinstance(link_info, list) and len(link_info) > 0:
                        upstream_node_id = str(link_info[0])
                        upstream_node_data = prompt_data.get(upstream_node_id)
                        if upstream_node_data and "class_type" in upstream_node_data:
                            target_class_type = upstream_node_data["class_type"]
                            print(f"👨‍🏫 班长：顺藤摸瓜成功！检测到上游节点类名 -> 【{target_class_type}】")
            except Exception as e:
                print(f"👨‍🏫 班长：连线分析失败 ({e})，回退到搜索框模式。")

        if target_class_type:
            search_query = "" 
            print(f"👨‍🏫 班长：启用【精准识别模式】，忽略搜索框内容。")
        else:
            search_query = raw_search_query
            if not search_query:
                return ("❌ 请输入搜索关键词 (如 layerstyle) 或连接一个有效的节点。", "")

        search_lower = search_query.lower() if search_query else ""

        # 第一轮：找种子节点（精准识别=单个类名；搜索框=CATEGORY/文件路径子串命中）
        seed_node_ids = set()
        for node_id, node_class in nodes.NODE_CLASS_MAPPINGS.items():
            is_hit = False
            if target_class_type:
                if node_id == target_class_type: is_hit = True
            else:
                node_cat = str(self._get_attr_value(node_class, "CATEGORY", "")).strip()
                node_file_path = ""
                try: node_file_path = inspect.getfile(node_class).replace("\\", "/").lower()
                except (TypeError, OSError): pass
                rel_module = str(getattr(node_class, "RELATIVE_PYTHON_MODULE", "")).lower()
                if node_cat and search_lower and search_lower in node_cat.lower(): is_hit = True
                elif search_lower and ((node_file_path and search_lower in node_file_path) or (rel_module and search_lower in rel_module)): is_hit = True
            if is_hit:
                seed_node_ids.add(node_id)

        if not seed_node_ids:
            err_msg = f"❌ 未找到目标插件。"
            if target_class_type: err_msg += f"\n已识别到上游节点类名：{target_class_type}，但在系统映射中未找到。"
            else: err_msg += f"\n搜索词：'{search_query}' 无匹配。"
            return (err_msg, "")

        # 第二轮：锁定种子节点所属插件根目录（按文件路径收敛，避免 CATEGORY 前缀跨插件误抓）
        plugin_roots = {}
        for node_id in seed_node_ids:
            root_path, root_name = self._get_plugin_root(nodes.NODE_CLASS_MAPPINGS[node_id])
            if root_path:
                plugin_roots[root_path] = root_name

        if len(plugin_roots) > 1:
            names = "、".join(sorted(set(plugin_roots.values())))
            return (f"❌ 命中 {len(plugin_roots)} 个不同插件（{names}）。\n请用更精确的文件夹名（如 facerefine）或连线识别单个节点。", "")

        if plugin_roots:
            locked_root_path, locked_root_name = next(iter(plugin_roots.items()))
            # 抓该插件目录下的所有节点（全家桶）
            final_node_ids = set()
            for node_id, node_class in nodes.NODE_CLASS_MAPPINGS.items():
                rp, _ = self._get_plugin_root(node_class)
                if rp == locked_root_path:
                    final_node_ids.add(node_id)
        else:
            # 无法定位插件目录（ComfyUI 内置节点），只抓命中的节点
            locked_root_path, locked_root_name = None, None
            final_node_ids = set(seed_node_ids)

        extraction_result = {}
        count = 0
        KNOWN_SOCKET_TYPES = ["IMAGE", "MASK", "LATENT", "MODEL", "CLIP", "VAE", "CONDITIONING", "STYLE_MODEL", "CLIP_VISION", "WEBCAM", "AUDIO", "VIDEO", "GLIGEN", "CONTROL_NET"]
        sorted_node_ids = sorted(list(final_node_ids))

        for node_id in sorted_node_ids:
            try:
                node_class = nodes.NODE_CLASS_MAPPINGS[node_id]

                display_name = nodes.NODE_DISPLAY_NAME_MAPPINGS.get(node_id, node_id)
                inputs_dict = {}
                widgets_dict = {}
                
                inputs = self._get_attr_value(node_class, "INPUT_TYPES", None)
                if inputs is not None:
                    try:
                        all_params = {}
                        if isinstance(inputs, dict):
                            all_params.update(inputs.get("required", {}))
                            all_params.update(inputs.get("optional", {}))
                        
                        for k, v in all_params.items():
                            raw_type = v[0]
                            opts = v[1] if len(v) > 1 and isinstance(v[1], dict) else {}
                            is_socket = False
                            if isinstance(raw_type, list): is_socket = False 
                            elif isinstance(opts, dict) and opts.get("forceInput", False): is_socket = True
                            elif isinstance(raw_type, str):
                                if raw_type in KNOWN_SOCKET_TYPES: is_socket = True
                            if is_socket: inputs_dict[k] = k
                            else: widgets_dict[k] = k
                    except (TypeError, AttributeError, KeyError): pass

                outputs_dict = {}
                return_names = self._get_attr_value(node_class, "RETURN_NAMES", None)
                if return_names is not None:
                    for n in return_names: outputs_dict[n] = n
                else:
                    return_types = self._get_attr_value(node_class, "RETURN_TYPES", None)
                    if return_types is not None:
                        for i in range(len(return_types)): outputs_dict[f"output_{i}"] = f"output_{i}"

                # 提取节点描述（如果有）
                description = self._get_attr_value(node_class, "DESCRIPTION", "")
                if not isinstance(description, str):
                    description = ""

                count += 1
                node_entry = {
                    "title": str(display_name),
                    "inputs": inputs_dict,
                    "widgets": widgets_dict,
                    "outputs": outputs_dict
                }
                if description:
                    node_entry["description"] = description
                extraction_result[node_id] = node_entry
            except Exception as e:
                print(f"👨‍🏫 班长：解析节点 [{node_id}] 时出错: {e}")

        # ====== 保存路径处理 ======
        if save_dir_input == "output": target_dir = folder_paths.get_output_directory()
        else:
            if not os.path.isabs(save_dir_input): target_dir = os.path.join(os.getcwd(), save_dir_input)
            else: target_dir = save_dir_input

        if not os.path.exists(target_dir):
            try: os.makedirs(target_dir)
            except OSError as e: return (f"❌ 目录创建失败: {target_dir} ({e})", "")

        if locked_root_name: final_name = locked_root_name
        elif search_query: final_name = search_query
        else: final_name = "Detected_Plugin"
            
        final_name = re.sub(r'[\\/*?:"<>|]', "", final_name) 
        
        # ====== 内置 JS 前端文本扫描 ======
        # 递归扫描目标插件的全部前端文件（js/mjs/ts，自动跳过资源/文档目录），
        # 覆盖 js/、web/、web_version/ 等任意目录结构
        js_count = 0
        js_file_count = 0
        if locked_root_path:
            print(f"👨‍🏫 班长: 递归扫描插件前端 JS UI 文本 → {locked_root_path}")
            js_texts, js_file_count = self._scan_plugin_frontend(locked_root_path)
            if js_texts:
                for text, meta in js_texts.items():
                    # 用清理后的文本前缀作为键，避免换行/特殊字符污染 key
                    safe_prefix = re.sub(r'[^\w\u4e00-\u9fff]', '_', text[:30])
                    key = f"js_{safe_prefix}"
                    if key in extraction_result:
                        key = f"{key}_{hash(text) & 0xffff:04x}"
                    extraction_result[key] = {
                        "title": text,
                        "original": text,  # 保留英文原文，AI 翻译后转 DD-Translation 格式作键
                        "file": meta["file"],
                        "context": meta["context"],
                        "inputs": {},
                        "widgets": {},
                        "outputs": {}
                    }
                js_count = len(js_texts)
                print(f"👨‍🏫 班长: JS 扫描完成（{js_file_count} 个前端文件），追加 {js_count} 条 UI 文本到翻译清单")
            else:
                print(f"👨‍🏫 班长: JS 扫描完成（{js_file_count} 个前端文件），未发现 UI 文本")
        else:
            print(f"👨‍🏫 班长: 未定位到插件目录（ComfyUI 内置节点），跳过前端文本扫描")

        json_file = f"{final_name}.json"
        full_path = os.path.join(target_dir, json_file)

        # 文件已存在则直接覆盖
        with open(full_path, "w", encoding="utf-8") as f:
            json.dump(extraction_result, f, indent=4, ensure_ascii=False, sort_keys=True)
        
        report = f"✅ 抓取成功！\n🎯 目标名称：{final_name}\n📊 Python节点：{count} 个"
        if js_file_count > 0:
            report += f"\n📱 前端JS文件：{js_file_count} 个 → UI文本：{js_count} 条"
        report += f"\n📂 JSON路径：{full_path}"
        return (report, full_path)