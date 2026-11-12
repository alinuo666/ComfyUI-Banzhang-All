# -*- coding: utf-8 -*-
"""💾 H3 续拍存档 · 同名冲突防御

背景
----
ComfyUI 的节点总表是按「节点内部名」去重的一张字典，写入时不查重、不提示：
后加载的包直接覆盖先加载的。而加载用的是 `os.listdir`（ComfyUI/nodes.py
的 init_external_custom_nodes），**不排序** —— 谁赢取决于文件系统枚举顺序，
同一台机器上也可能变。独立包 ComfyUI-H3-Motion-Context 注册了与我们完全同
名的 `MiniMaxH3MotionContextSaveLatent`，一旦它赢，班长版的潜空间直通输出、
顺序锚口、中央统一编号全部失效，画布上变成原版（输出 latent_path 字符串那个）。

处置：彻底让出这个名字
----------------------
班长版只注册自己的 `BanZhang_H3_ClipArchive`，**一律不再注册**那个上游 ID
——不管旁边有没有装第三方包，规则唯一，不随加载顺序摇摆。老工作流交给前端
`js/banzhang_h3mc_alias.js`：打开/导入时把旧 ID 就地改写成班长版 ID，用户
全程无感。

代价是那个上游 ID 一旦被第三方占用，菜单里就会多出一个原版节点。语言包
（locales/zh/nodeDefs.json 按内部名汉化）会把它翻译成一个带 ⚠️ 的名字，
避免和班长版混淆；同时启动时仍然扫描 custom_nodes 打告警、挂「冲突提示」
节点写明现状（只在真检测到时才挂，干净机器零污染）。
"""

import os

_LEGACY_ID = "MiniMaxH3MotionContextSaveLatent"
_ARCHIVE_ID = "BanZhang_H3_ClipArchive"
_ARCHIVE_NAME = "💾 H3 续拍存档"
# _LEGACY_ID 我们不再注册：谁抢到算谁的。它要是落在第三方包手里，菜单里的
# 中文名由 locales/zh/nodeDefs.json 那条负责（写成带 ⚠️ 的第三方版），
# 好让用户一眼分得清哪个不是班长版。
_CATEGORY = "👨‍🏫班长/MiniMax H3"

# 认第三方包靠两条线索：目录名同时含 h3 与 motioncontext（忽略 -_空格），
# 或该目录下层的 py 文件里出现了那个被抢的节点内部名。改名安装也躲不掉。
_DIR_HINTS = ("h3", "motioncontext")
_PROBE = b"MiniMaxH3MotionContextSaveLatent"
_MAX_PROBE_BYTES = 2 * 1024 * 1024
_MAX_FILES_PER_DIR = 40


def _norm(name):
    return name.lower().replace("-", "").replace("_", "").replace(" ", "")


def _custom_node_roots():
    roots = []
    try:
        import folder_paths
        roots = list(folder_paths.get_folder_paths("custom_nodes") or [])
    except Exception:
        roots = []
    if not roots:
        # 环境异常时退回「本包所在的 custom_nodes」
        roots = [os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]
    return [r for r in roots if os.path.isdir(r)]


def _py_files(directory):
    try:
        entries = sorted(os.listdir(directory))
    except OSError:
        return []
    return [os.path.join(directory, n) for n in entries
            if n.endswith(".py") and os.path.isfile(os.path.join(directory, n))]


def _probes_same_node_id(directory):
    hits = 0
    for path in _py_files(directory)[:_MAX_FILES_PER_DIR]:
        try:
            if os.path.getsize(path) > _MAX_PROBE_BYTES:
                continue
            with open(path, "rb") as fh:
                if _PROBE in fh.read():
                    return True
        except OSError:
            continue
        hits += 1
    return False


def detect_rivals():
    """返回疑似冲突的第三方包：[(目录路径, 命中原因)]。只读不写，永不吃掉异常。"""
    self_pkg = os.path.dirname(os.path.abspath(__file__))
    found = []
    seen = set()
    for root in _custom_node_roots():
        try:
            entries = sorted(os.listdir(os.path.realpath(root)))
        except OSError:
            continue
        for entry in entries:
            path = os.path.join(root, entry)
            real = os.path.realpath(path)
            if not os.path.isdir(path) or real in seen or real == self_pkg:
                continue
            seen.add(real)
            if entry.endswith(".disabled"):
                continue  # 已禁用，ComfyUI 不会加载它
            reason = []
            if all(h in _norm(entry) for h in _DIR_HINTS):
                reason.append("目录名")
            if _probes_same_node_id(path):
                reason.append("内含同名节点代码")
            if reason:
                found.append((path, " + ".join(reason)))
    return found


def _build_report(rivals):
    lines = ["检测到与「💾 H3 续拍存档」用过同一个节点名的第三方包：", ""]
    for path, reason in rivals:
        lines.append("  · %s  （%s）" % (path, reason))
    lines += [
        "",
        "现状：班长版已改用独占内部名 %s，不再和它抢，两边互不影响。" % _ARCHIVE_ID,
        "",
        "你只需注意一件事：菜单里带 ⚠️ 的「H3 续拍存档（第三方原版）」不是班长版"
        " —— 它输出的是存档路径文本，不走导演台的中央编号。"
        "搜「H3 续拍存档」请认准不带 ⚠️ 的那一个。",
        "",
        "老工作流无需处理：打开时旧节点会自动换成班长版。",
        "",
        "嫌菜单乱：在 ComfyUI-Manager 里禁用或卸载上面列出的包，"
        "或者把它的目录名改成以 .disabled 结尾后重启 ComfyUI。",
    ]
    return "\n".join(lines)


def _build_notice_class(report):
    """冲突提示节点：只在检测到冲突时注册，平时不占菜单。"""

    class _H3ConflictNotice:
        CATEGORY = _CATEGORY
        FUNCTION = "run"
        RETURN_TYPES = ("STRING",)
        RETURN_NAMES = ("冲突报告",)
        OUTPUT_NODE = True
        DESCRIPTION = "H3 续拍存档与第三方包同名冲突的处置说明。正常情况下本节点不会出现。"

        @classmethod
        def INPUT_TYPES(cls):
            return {"required": {}}

        @classmethod
        def IS_CHANGED(cls, **kwargs):
            return float("nan")  # 每次执行都刷新，免得报告被缓存

        def run(self):
            return (report,)

    return _H3ConflictNotice


def apply(cls_map, name_map):
    """把存档节点搬到独占 ID 上（彻底让出上游 ID），并在必要时挂出冲突提示。"""
    cls = cls_map.get(_LEGACY_ID)
    if cls is None:
        return False

    # 同一个类换到独占名下。上游 ID 一律让出去：留着它，归属就由加载顺序
    # 决定（os.listdir 不排序），今天是班长版、明天可能变原版 —— 这种摇摆
    # 比多一个菜单项难查得多。老工作流由前端改写节点类型接住。
    cls_map[_ARCHIVE_ID] = cls
    name_map[_ARCHIVE_ID] = _ARCHIVE_NAME
    cls_map.pop(_LEGACY_ID, None)
    name_map.pop(_LEGACY_ID, None)

    try:
        rivals = detect_rivals()
    except Exception as e:
        print("⚠️ [班长全家桶] H3 冲突自检跳过: %s" % e)
        return True

    if rivals:
        report = _build_report(rivals)
        head = report.splitlines()[0]
        print("\n" + "=" * 68)
        print("⚠️  [班长全家桶] %s" % head)
        for path, reason in rivals:
            print("    · %s  （%s）" % (path, reason))
        print("    → 菜单已挂出「⚠️ H3 冲突提示」节点，处置办法写在里面。")
        print("    → 班长版改用内部名 %s，搜索「H3 续拍存档」即可找到。" % _ARCHIVE_ID)
        print("=" * 68 + "\n")
        cls_map["BanZhang_H3ConflictNotice"] = _build_notice_class(report)
        name_map["BanZhang_H3ConflictNotice"] = "⚠️ H3 冲突提示"
    return True
