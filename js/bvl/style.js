/**
 * 样式表：面板所有 CSS 都在这里，扩展启动时注入一次。
 * 改外观只动这个文件；改功能时这个文件可以完全不读。
 *
 * 用得到的抽屉字段：无
 */

const 样式文本 = `
            /* 画布导航期降载（20261101）：媒体加载器同样是 DOM widget，挂在
               ComfyUI 的 transform:translate/scale 盒里 —— 画布平移/缩放/
               拖节点时整块网格要按新比例重栅格化，缩略图 img 的重采样是大头。
               html.bz-nav 由 csglide_media_rack.js 在视图变换/按住拖动期间
               挂上、停手 180ms 后摘掉；动的瞬间只隐缩略图本身（布局不动），
               卡框/角标/文件名全保留。与媒体架 .gmr 同一套机制、同一个钩子。 */
            html.bz-nav .bz-grid-container img { visibility: hidden; }
            .bz-grid-container {
                display: flex;
                flex-direction: row;
                align-items: flex-start;
                gap: 2px;
                background: #1a1a1a;
                padding: 4px;
                overflow-y: auto !important;
                overflow-x: hidden;
                border-radius: 4px;
                width: 100%; 
                box-sizing: border-box;
                flex: 1 1 auto;
                min-height: 0;
                pointer-events: auto;
                border: 2px dashed transparent;
            }
            .bz-grid-container.bz-drag-over { border-color: #4CAF50; background-color: #1e2a1e; }
            .bz-drag-tip {
                position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                display: flex; align-items: center; justify-content: center;
                background: rgba(0,0,0,0.7); color: #fff; font-size: 14px;
                pointer-events: none; z-index: 999; opacity: 0; transition: opacity 0.2s;
            }
            .bz-grid-container.bz-drag-over .bz-drag-tip { opacity: 1; }
            .bz-grid-container::-webkit-scrollbar { width: 6px; }
            .bz-grid-container::-webkit-scrollbar-track { background: #111; }
            .bz-grid-container::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
            
            .bz-column { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
            
            .bz-item {
                width: 100%; height: auto; cursor: pointer;
                border: 1px solid transparent;
                border-radius: 2px;
                overflow: hidden; background: #2a2a2a; position: relative;
                transition: transform 0.1s;
                transform: translateZ(0);
            }
            .bz-item:hover { border-color: #888; transform: scale(1.05); z-index: 5; }
            .bz-item.selected { border-color: #4CAF50; box-shadow: 0 0 4px rgba(76, 175, 80, 0.5); }
            /* 多选勾选态：绿框 + 右上角对勾，和「选中输出」的 selected 区分开 */
            .bz-item.bz-picked { border-color: #4ade80; box-shadow: 0 0 0 1px rgba(74,222,128,0.65) inset; }
            .bz-item.bz-picked::after {
                content: "✓"; position: absolute; top: 3px; right: 3px;
                width: 14px; height: 14px; border-radius: 4px;
                background: #4ade80; color: #04342c; font-size: 11px; line-height: 14px;
                text-align: center; font-weight: 500; z-index: 6; pointer-events: none;
            }

            /* ---- 多选操作条：浮在面板底部，多选模式下常驻 ---- */
            .bz-multi-bar {
                position: absolute; left: 5px; right: 5px; bottom: 5px; z-index: 80;
                display: flex; align-items: center; gap: 7px; padding: 5px 9px;
                background: rgba(20,24,30,0.93);
                backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                border: 1px solid rgba(59,138,221,0.45); border-radius: 8px;
                box-shadow: 0 6px 18px rgba(0,0,0,0.45);
            }
            .bz-multi-bar.bz-off { display: none; }
            .bz-multi-count { font-size: 11px; color: #7fb3ff; white-space: nowrap; font-variant-numeric: tabular-nums; }
            .bz-multi-btn {
                padding: 2px 8px; border-radius: 5px; font-size: 11px; cursor: pointer;
                border: 1px solid rgba(255,255,255,0.14);
                background: rgba(255,255,255,0.07); color: #d5d9dd; white-space: nowrap;
            }
            .bz-multi-btn:hover { background: rgba(255,255,255,0.13); }
            .bz-multi-btn.bz-danger { background: rgba(226,75,74,0.16); border-color: rgba(226,75,74,0.4); color: #f09595; }
            .bz-multi-btn.bz-danger:hover { background: rgba(226,75,74,0.28); }
            .bz-multi-input {
                flex: 1; min-width: 40px; background: #141518; color: #d5d9dd;
                border: 1px solid rgba(255,255,255,0.16); border-radius: 5px;
                padding: 2px 6px; font-size: 11px;
            }
            .bz-multi-rename { display: flex; align-items: center; gap: 6px; flex: 1; }
            .bz-multi-rename.bz-off { display: none; }
            .bz-multi-actions { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: flex-end; }
            .bz-item img { width: 100%; display: block; background: #111; opacity: 0; transition: opacity 0.2s; min-height: 20px; }
            .bz-item img.loaded { opacity: 1; }
            
            .bz-del-btn {
                position: absolute; top: 2px; right: 2px; width: 20px; height: 20px;
                background: rgba(0,0,0,0.5); border-radius: 50%; border: none; 
                color: #fff; font-size: 12px; cursor: pointer; 
                display: flex; align-items: center; justify-content: center;
                z-index: 100; opacity: 0; transition: all 0.15s;
            }
            .bz-item:hover .bz-del-btn { opacity: 1; }
            .bz-del-btn:hover { background: #f00; transform: scale(1.1); }
            
            .bz-tag {
                position: absolute; bottom: 0; left: 0; right: 0;
                background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0));
                color: rgba(255,255,255,0.9); font-size: 9px; padding: 8px 2px 1px 2px;
                text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                pointer-events: none; z-index: 5;   /* 压在播放覆盖层之上，文件名始终可读 */
            }
            .bz-msg { padding: 20px; color: #aaa; text-align: center; font-size: 12px; width: 100%; }

            /* ---- 媒体类型：角标 + 缩略图失败时的图标兜底 ---- */
            .bz-badge {
                position: absolute; top: 3px; left: 3px; z-index: 6;
                min-width: 15px; height: 15px; padding: 0 4px;
                border-radius: 5px; font-size: 9px; line-height: 15px; text-align: center;
                color: #fff; pointer-events: none;
                background: rgba(0,0,0,0.6);
                box-shadow: 0 1px 3px rgba(0,0,0,0.45);
            }
            .bz-item.bz-video .bz-badge { background: rgba(59,130,246,0.9); }
            .bz-item.bz-audio .bz-badge { background: rgba(168,85,247,0.9); }

            .bz-icon {
                display: none;
                align-items: center; justify-content: center;
                font-size: 20px; color: #6b7076;
                background: #111; padding: 14px 0; min-height: 36px;
            }
            .bz-item.bz-noThumb .bz-icon { display: flex; }
            .bz-item.bz-noThumb img { display: none; }

            /* ---- 卡片内联播放：鼠标移到视频/音频卡片上即自动播放 ---- */
            /* 视频：画面盖在缩略图上（contain 不裁切），音频：隐藏 audio 出声 + 波形呼吸 */
            .bz-playback {
                position: absolute; inset: 0; width: 100%; height: 100%;
                object-fit: contain; background: #000;
                opacity: 0; pointer-events: none; z-index: 4;
                transition: opacity 0.15s ease;
            }
            .bz-item.bz-playing .bz-playback { opacity: 1; }
            /* 关键：只用 opacity 隐藏缩略图/图标，绝不能 display:none ——
               卡片高度靠 img 撑起（播放层是 absolute 不占布局），display:none 会让卡片塌陷 */
            .bz-item.bz-video.bz-playing img,
            .bz-item.bz-video.bz-playing .bz-icon { opacity: 0 !important; }
            .bz-item.bz-playing { border-color: #4ade80; box-shadow: 0 0 7px rgba(74,222,128,0.5); }
            .bz-item.bz-playing .bz-badge { background: rgba(74,222,128,0.95); color: #06210f; }

            /* 播放进度：底部细条 */
            .bz-progress {
                position: absolute; left: 0; bottom: 0; height: 3px; width: 0;
                background: linear-gradient(90deg, #4ade80, #86efac);
                box-shadow: 0 0 8px rgba(74,222,128,0.6);
                z-index: 9; pointer-events: none;
            }

            /* 音频播放中：波形图呼吸发亮 */
            @keyframes bz-eq-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.8); } }
            .bz-item.bz-audio.bz-playing:not(.bz-noThumb) img { animation: bz-eq-pulse 0.9s ease-in-out infinite; }
            .bz-item.bz-audio.bz-playing .bz-icon { animation: bz-eq-pulse 0.9s ease-in-out infinite; }

            /* 原文件播不动 → 后端转码中（首次较慢，转完缓存复用，之后秒开） */
            .bz-item.bz-transcoding::after {
                content: "⏳ 转码中…（首次较慢，之后秒开）";
                position: absolute; left: 4px; right: 4px; bottom: 7px; z-index: 12;
                padding: 3px 4px; border-radius: 5px;
                background: rgba(0,0,0,0.82); color: #93c5fd; font-size: 9px; line-height: 1.3;
                text-align: center; pointer-events: none; white-space: normal;
            }

            /* 浏览器解不了该编码（H.265 / mkv / avi 等）时的显性提示，不再黑屏干等 */
            .bz-item.bz-noPlay::after {
                content: "⚠️ 浏览器不支持该编码";
                position: absolute; left: 4px; right: 4px; bottom: 7px; z-index: 12;
                padding: 3px 4px; border-radius: 5px;
                background: rgba(0,0,0,0.82); color: #ffd479; font-size: 9px; line-height: 1.3;
                text-align: center; pointer-events: none; white-space: normal;
            }

            /* DOM 元素只负责撑满前端分配的容器（wrapper 已给固定 w/h），
               自身绝不再按节点尺寸自算 px 高度，否则会顶出节点框。 */
            .bz-wrap { display: flex; flex-direction: column; gap: 7px; box-sizing: border-box; width: 100%; height: 100%; min-height: 0; }
            .bz-slider-row {
                display: flex; align-items: center; gap: 10px;
                padding: 7px 10px; border-radius: 10px;
                background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.012));
                border: 1px solid rgba(255,255,255,0.07);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.35);
                flex: 0 0 auto;
            }
            .bz-slider-label {
                font-size: 10.5px; letter-spacing: 0.4px; color: #8b9198;
                white-space: nowrap; user-select: none;
            }
            .bz-slider {
                position: relative; flex: 1 1 auto; height: 20px;
                display: flex; align-items: center;
                cursor: pointer; touch-action: none;
            }
            .bz-slider-track {
                position: absolute; left: 0; right: 0; height: 5px; border-radius: 99px;
                background: rgba(255,255,255,0.075);
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.65);
            }
            .bz-slider-fill {
                position: absolute; left: 0; width: 0; height: 5px; border-radius: 99px;
                background: linear-gradient(90deg, rgba(76,175,80,0.85), #4ade80);
                box-shadow: 0 0 10px rgba(74,222,128,0.3);
                transition: box-shadow 0.18s ease;
            }
            .bz-slider-thumb {
                position: absolute; left: 0; width: 14px; height: 14px; border-radius: 50%;
                background: radial-gradient(circle at 35% 30%, #ffffff, #d8dbe0);
                box-shadow: 0 1px 3px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.18);
                transform: translateX(-50%) scale(1);
                transition: transform 0.16s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.16s ease;
            }
            .bz-slider:hover .bz-slider-thumb {
                transform: translateX(-50%) scale(1.12);
                box-shadow: 0 2px 7px rgba(0,0,0,0.6), 0 0 0 4px rgba(74,222,128,0.12);
            }
            .bz-slider.bz-active { cursor: grabbing; }
            .bz-slider.bz-active .bz-slider-thumb {
                transform: translateX(-50%) scale(1.06);
                box-shadow: 0 2px 9px rgba(0,0,0,0.65), 0 0 0 6px rgba(74,222,128,0.16);
            }
            .bz-slider.bz-active .bz-slider-fill { box-shadow: 0 0 14px rgba(74,222,128,0.45); }
            .bz-slider-value {
                font-size: 11px; font-variant-numeric: tabular-nums; color: #e6e9ed;
                min-width: 30px; text-align: right; user-select: none;
            }

            /* ---- 工具行：过滤 / 含子目录 / 路径历史 ---- */
            .bz-tools-row {
                display: flex; align-items: center; gap: 7px;
                padding: 5px 7px; border-radius: 10px;
                background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.01));
                border: 1px solid rgba(255,255,255,0.07);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 2px rgba(0,0,0,0.3);
                flex: 0 0 auto;
            }
            .bz-search {
                flex: 1 1 auto; min-width: 0; height: 24px;
                padding: 0 9px; border-radius: 7px;
                background: rgba(0,0,0,0.28);
                border: 1px solid rgba(255,255,255,0.07);
                color: #e6e9ed; font-size: 11px; outline: none;
                box-sizing: border-box;
                transition: border-color 0.16s ease, box-shadow 0.16s ease;
            }
            .bz-search::placeholder { color: #6b7076; }
            .bz-search:focus { border-color: rgba(74,222,128,0.5); box-shadow: 0 0 0 3px rgba(74,222,128,0.1); }
            .bz-chip {
                flex: 0 0 auto; height: 24px; padding: 0 10px;
                border-radius: 7px; cursor: pointer;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                color: #8b9198; font-size: 10.5px; white-space: nowrap;
                transition: all 0.16s ease;
            }
            .bz-chip:hover { color: #c9ced4; border-color: rgba(255,255,255,0.16); }
            .bz-chip.bz-on {
                color: #b7f7cd;
                background: linear-gradient(180deg, rgba(74,222,128,0.22), rgba(74,222,128,0.08));
                border-color: rgba(74,222,128,0.45);
                box-shadow: 0 0 10px rgba(74,222,128,0.15);
            }
            .bz-hist-btn {
                flex: 0 0 auto; width: 26px; height: 24px;
                border-radius: 7px; cursor: pointer;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                color: #8b9198; font-size: 12px; line-height: 1;
                display: flex; align-items: center; justify-content: center;
                transition: all 0.16s ease;
            }
            .bz-hist-btn:hover { color: #e6e9ed; border-color: rgba(255,255,255,0.18); background: rgba(255,255,255,0.09); }

            /* ---- 类型筛选行 ---- */
            .bz-filter-row {
                display: flex; align-items: center; gap: 6px;
                padding: 5px 7px; border-radius: 10px;
                background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.01));
                border: 1px solid rgba(255,255,255,0.07);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 2px rgba(0,0,0,0.3);
                flex: 0 0 auto;
            }
            .bz-chip-group { display: flex; gap: 4px; flex: 1 1 auto; min-width: 0; }
            .bz-chip.bz-mini {
                flex: 0 0 auto; padding: 0 8px; min-width: 32px; text-align: center;
            }
            .bz-count {
                font-size: 10px; color: #6b7076; font-variant-numeric: tabular-nums;
                white-space: nowrap; user-select: none; padding-left: 2px;
            }

            .bz-hist-panel {
                position: fixed; z-index: 100002; min-width: 220px; max-width: 460px;
                padding: 5px; border-radius: 10px;
                background: rgba(28,30,33,0.94);
                backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
                border: 1px solid rgba(255,255,255,0.1);
                box-shadow: 0 10px 30px rgba(0,0,0,0.55);
                font-size: 11px; color: #d5d9dd;
            }
            .bz-hist-item {
                padding: 6px 8px; border-radius: 6px; cursor: pointer;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                transition: background 0.12s ease;
            }
            .bz-hist-item:hover { background: rgba(255,255,255,0.08); }
            .bz-hist-clear { color: #f08a8a; border-top: 1px solid rgba(255,255,255,0.07); margin-top: 4px; padding-top: 7px; }

            /* ---- 悬停放大预览 ---- */
            .bz-zoom {
                position: fixed; z-index: 100001; pointer-events: none;
                padding: 4px; border-radius: 10px;
                background: rgba(20,21,23,0.9);
                backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.12);
                box-shadow: 0 14px 36px rgba(0,0,0,0.6);
                opacity: 0; transform: scale(0.96);
                transition: opacity 0.14s ease, transform 0.14s ease;
            }
            .bz-zoom.bz-show { opacity: 1; transform: scale(1); }
            .bz-zoom img {
                display: block; max-width: 520px; max-height: 520px; border-radius: 7px;
                background-color: #1e1e1e;
                background-image:
                    linear-gradient(45deg, #2e2e2e 25%, transparent 25%, transparent 75%, #2e2e2e 75%),
                    linear-gradient(45deg, #2e2e2e 25%, transparent 25%, transparent 75%, #2e2e2e 75%);
                background-size: 24px 24px;
                background-position: 0 0, 12px 12px;
            }

            /* ---- 重复文件去重合并面板 ---- */
            .bz-dedupe-mask {
                position: fixed; inset: 0; z-index: 100003;
                background: rgba(0,0,0,0.55);
                backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
                display: flex; align-items: center; justify-content: center;
            }
            .bz-dedupe {
                width: 580px; max-width: 92vw; max-height: 84vh;
                display: flex; flex-direction: column;
                background: rgba(28,30,33,0.97);
                border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
                box-shadow: 0 18px 50px rgba(0,0,0,0.6);
                color: #d5d9dd; font-size: 12px; line-height: 1.6;
            }
            .bz-dedupe-head {
                display: flex; align-items: center; justify-content: space-between;
                padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            .bz-dedupe-title { font-size: 13px; font-weight: 500; }
            .bz-dedupe-close { cursor: pointer; padding: 2px 8px; border-radius: 6px; color: #9aa0a6; }
            .bz-dedupe-close:hover { background: rgba(255,255,255,0.08); color: #fff; }
            .bz-dedupe-sum { padding: 10px 14px; color: #9aa0a6; }
            .bz-dedupe-warn { color: #e0b26a; margin-top: 4px; }
            .bz-dedupe-list { flex: 1; overflow-y: auto; padding: 0 14px 10px; min-height: 0; }
            .bz-dedupe-list::-webkit-scrollbar { width: 8px; }
            .bz-dedupe-list::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
            .bz-dup-group {
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 8px; margin-bottom: 8px; overflow: hidden;
            }
            .bz-dup-group-head {
                display: flex; align-items: center; gap: 10px;
                padding: 7px 9px; background: rgba(255,255,255,0.04);
            }
            .bz-dup-head-info { flex: 1; }
            .bz-dup-size { color: #7fb3ff; font-variant-numeric: tabular-nums; white-space: nowrap; }
            .bz-dup-files { padding: 3px 0; }
            .bz-dup-file {
                display: flex; align-items: center; gap: 8px;
                padding: 5px 9px; cursor: pointer;
            }
            .bz-dup-file:hover { background: rgba(255,255,255,0.06); }
            .bz-dup-file.bz-on { background: rgba(74,222,128,0.14); }
            .bz-dup-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .bz-dup-badge { font-size: 10px; color: #6b7076; white-space: nowrap; }
            .bz-dup-file.bz-on .bz-dup-badge { color: #4ade80; }
            .bz-dedupe-foot {
                display: flex; align-items: center; justify-content: space-between; gap: 10px;
                padding: 10px 14px; border-top: 1px solid rgba(255,255,255,0.08);
            }
            .bz-dedupe-prog { color: #9aa0a6; font-variant-numeric: tabular-nums; }
            .bz-dedupe-actions { display: flex; gap: 8px; }
            .bz-dedupe-btn {
                padding: 6px 12px; border-radius: 7px; font-size: 12px; cursor: pointer;
                border: 1px solid rgba(255,255,255,0.14);
                background: rgba(255,255,255,0.06); color: #d5d9dd;
            }
            .bz-dedupe-btn:hover { background: rgba(255,255,255,0.12); }
            .bz-dedupe-btn.bz-primary {
                background: rgba(74,222,128,0.18);
                border-color: rgba(74,222,128,0.45); color: #b9f6cf;
            }
            .bz-dedupe-btn:disabled { opacity: 0.45; cursor: default; }

            /* ---- 双击改名：标签临时变成输入框 ---- */
            .bz-item.bz-editing .bz-tag {
                pointer-events: auto; cursor: text;
                background: rgba(0,0,0,0.92);
                color: #fff; font-size: 10px; padding: 3px 4px;
                outline: 1px solid rgba(74,222,128,0.75);
                white-space: nowrap; overflow: visible; text-overflow: clip;
            }
        `;

export function 注入样式() {
    const style = document.createElement("style");
    style.textContent = 样式文本;
    document.head.appendChild(style);
}
