# -*- coding: utf-8 -*-
"""
📝 脚本名称：万能空节点 (修复版)
👨‍🏫 开发：班长
🛠️ 修复说明：
    1. AnyType 复用 banzhang_utils；AnyObject 独立定义（保留固定 __hash__ 与 __eq__）。
    2. 【V2 核心修复】让 AnyObject 继承 str (字符串) 类，解决 text.replace() 等字符串操作时的类型报错。
    3. 保留 __hash__ 和 __eq__ 确保缓存系统正常。
"""

# ================= 核心类定义 (本地增强版) =================
from .banzhang_utils import AnyType

class AnyObject(str):
    """
    📦 万能对象定义 (用于实际数据传输)
    作用：作为一个占位符对象传递。
    
    🛠️ 升级说明 (V2)：
    继承 str 类，使其本质上是一个字符串。
    这样当连接到文本节点（如 CR Text）时，它会被视为空字符串处理，而不会报错。
    """
    def __new__(cls, text=""):
        # 创建一个字符串实例，默认为空字符串
        return super().__new__(cls, text)

    def __init__(self, text=""):
        # 初始化附加属性
        self.status = "I am ready"

    def __eq__(self, other):
        # 只要是同类对象，就视为相等（避免重复运行）
        return isinstance(other, AnyObject)

    def __hash__(self):
        # 【关键】返回固定哈希值，确保 ComfyUI 缓存不报错
        return hash("BanzhangAnyObject_Fixed")

# ================= 节点主逻辑 =================

class BanzhangAnyOutputNode:
    """
    🧩 节点名称：万能空节点
    功能：接收任何输入，不进行任何处理，直接输出一个万能对象。
    适用场景：
        1. 用于临时断开工作流的某一部分。
        2. 作为调试时的占位符。
        3. 修复报错：TypeError: replace() argument 2 must be str
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        """
        定义输入端口
        """
        return {"required": {}}

    # 定义输出类型：AnyType("*") 表示通配符
    RETURN_TYPES = (AnyType("*"),) 
    
    # 定义输出端口名称
    RETURN_NAMES = ("🧩 万能输入源",)
    
    # 执行的主函数名
    FUNCTION = "do_nothing"
    
    # 节点分类
    CATEGORY = "👨‍🏫班长/文本处理"

    def do_nothing(self):
        """
        执行函数
        作用：返回一个伪装成空字符串的万能对象。
        """
        # 返回元组 (AnyObject,)
        # 此时它既是对象，也是一个空字符串 ""
        return (AnyObject(""),)