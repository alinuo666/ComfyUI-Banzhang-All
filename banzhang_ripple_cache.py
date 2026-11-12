# -*- coding: utf-8 -*-
"""让浏览器不缓存本包的 .mjs 辅助模块。

ComfyUI 只给 .js 发 no-store；.mjs 会被启发式缓存，结果新版入口配旧版规则模块。
改时间轴规则后「改了没生效」多半出在这里。
注册必须在模块导入时完成，放进函数延后调用会赶不上 add_routes。
"""

from __future__ import annotations

from aiohttp import web
from server import PromptServer

PREFIX = "/extensions/ComfyUI-Banzhang-All/"
_instance = PromptServer.instance

if _instance is not None and not getattr(_instance, "_bz_ripple_cache", False):

    @web.middleware
    async def no_store(request, handler):
        response = await handler(request)
        if request.path.endswith(".mjs") and PREFIX in request.path:
            response.headers["Cache-Control"] = "no-store"
        return response

    try:
        _instance.app.middlewares.append(no_store)
    except RuntimeError:  # 应用已启动，中间件列表冻结
        pass
    else:
        _instance._bz_ripple_cache = True
