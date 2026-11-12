/**
 * 👨‍🏫 班长媒体加载器 - 前端扩展入口（薄壳）
 *
 * 2026-10 重构：原 2050 行单文件已按功能拆成 js/bvl/ 下的一组小模块，
 * 逻辑一行没改，只是搬家。改功能请到对应模块：
 *
 *   外观 CSS      → bvl/style.js
 *   拖到画布      → bvl/drop.js
 *   缩略图滑条    → bvl/slider.js
 *   工具行/历史   → bvl/toolbar.js
 *   类型筛选行    → bvl/filterbar.js
 *   去重合并      → bvl/dedupe.js
 *   多选批量      → bvl/multi.js
 *   悬停放大预览  → bvl/hover.js
 *   内联播放      → bvl/playback.js
 *   网格/懒加载   → bvl/grid.js
 *   单张卡片      → bvl/card.js
 *   列表加载      → bvl/list.js
 *   后端接口      → bvl/backend.js
 *   通用小工具    → bvl/util.js
 *   常量表        → bvl/const.js
 *   共享抽屉      → bvl/context.js
 *   总装配        → bvl/main.js
 *
 * 拆分前的完整原件备份在 js/_archive/banzhang_visual_loader.full.js.bak
 */

import "./bvl/main.js";
