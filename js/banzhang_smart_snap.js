// 班长智能吸附 — 画布上拖动/缩放节点与编组时的智能参考线与吸附。
// 核心逻辑提取自 nomadoor/ComfyUI-Smart-Guides（MIT, Copyright (c) 2026 nomadoor），
// 裁掉了对齐分布、编组四角缩放与多语言菜单，只保留智能吸附链路。
// 本文件只做装配（注册扩展 + 中文设置）；吸附数学、指针模型、绘制在各 banzhang_snap_*.js 模块。
// 功能：拖动/缩放时吸附到连线水平位、其他节点/编组边缘、紧贴相邻位；按住 Shift 临时关闭。

const { app } = window.comfyAPI.app;

import { createEnv, SETTINGS } from "./banzhang_snap_env.js";
import { createDragSnapper } from "./banzhang_snap_drag.js";
import { createOverlay, snapGuides } from "./banzhang_snap_overlay.js";
import { createStatus } from "./banzhang_snap_status.js";

// 参考线画布的样式（原版 smart_guides.css 中与本功能相关的唯一一条）
const style = document.createElement("style");
style.textContent = ".smart-guides-overlay{position:absolute;pointer-events:none;z-index:40;}";
document.head.append(style);

app.registerExtension({
  name: "Banzhang.SmartSnap",

  settings: [
    { id: SETTINGS.enabled, category: ["班长吸附", "吸附", "开关"], name: "拖动和缩放时吸附", type: "boolean", defaultValue: true },
    { id: SETTINGS.wires, category: ["班长吸附", "吸附", "连线"], name: "吸附到连线水平位置", type: "boolean", defaultValue: true },
    { id: SETTINGS.edges, category: ["班长吸附", "吸附", "边缘"], name: "吸附到其他节点和编组的边缘", type: "boolean", defaultValue: true },
    { id: SETTINGS.distance, category: ["班长吸附", "吸附", "距离"], name: "吸附距离（屏幕像素）", type: "slider", attrs: { min: 2, max: 24, step: 1 }, defaultValue: 8 },
  ],

  setup() {
    const status = createStatus();
    const env = createEnv(app, status);
    const overlay = createOverlay(env);
    const drag = createDragSnapper(env);

    // 本扩展依赖的前端全局类（缺了谁都无法区分节点/编组、包住画布）
    const GLOBALS = ["LiteGraph", "LGraph", "LGraphCanvas", "LGraphNode", "LGraphGroup"];
    const missing = GLOBALS.filter((n) => !globalThis[n]);
    if (missing.length) {
      status.report("snap", "off", `window.${missing.join(", window.")} not found`);
      return;
    }

    try {
      drag.install();
    } catch (err) {
      status.report("snap", "off", `install failed: ${err?.message ?? err}`);
      console.warn("[班长吸附] install", err);
    }

    overlay.add(snapGuides(env, () => [drag.session]));
    drag.onChange(() => { overlay.request(); if (app.canvas) app.canvas.dirty_bgcanvas = true; });

    // 浏览器控制台输入 SmartGuidesStatus() 可查看各功能状态表（报障用）
    globalThis.SmartGuidesStatus = () => console.table(status.rows());
  },
});
