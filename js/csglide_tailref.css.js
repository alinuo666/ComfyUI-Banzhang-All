/* ============================================================
 * ⏱ 参照图替换 — 面板样式（方案 B：接缝双画面）
 * ------------------------------------------------------------
 * 纯文本，与逻辑零耦合，单独成文件。与导演台/续接合成共用同一套
 * H3 色板：灰阶为底，青色只给"将发生的动作"，橙色只给"已发生的
 * 可逆变更"，绿/红只出现在底部状态行。
 * ============================================================ */
export const CSS = `
/* root 铺满 dom-widget 容器、不带外边框圆角（面板即节点，同 minimax 预览）：
   外层框由 ComfyUI 节点本身提供，避免双层框与贴边缩放时的缝隙 */
.bzt {
  --hz-bg:#191919; --hz-panel:#212121; --hz-raise:#2b2b2b; --hz-line:#3b3b3b;
  --hz-well:#131313;
  --hz-txt:#e3e3e3; --hz-dim:#979797; --hz-label:#787878;
  --hz-accent:#58d1ff; --hz-accent-dim:#58d1ff26; --hz-warn:#e2a24b;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: var(--hz-txt); font-size: 12px; line-height: 1.35;
  pointer-events: auto; position: relative; width: 100%; height: 100%;
  min-width: 0; box-sizing: border-box;
  background: var(--hz-bg); border: none;
  padding: 8px 10px 10px;
  display: flex; flex-direction: column; gap: 7px; overflow: hidden;
  user-select: none; -webkit-user-select: none;
}

/* ---- 标题行 ---- */
.bzt .bz-bar { display: flex; align-items: center; gap: 8px; min-width: 0;
               font-size: 11.5px; color: var(--hz-dim); }
.bzt .bz-title { color: var(--hz-txt); font-weight: 500; flex: none; }
.bzt .bz-sep { color: var(--hz-line); flex: none; }
.bzt .bz-meta { flex: 1 1 auto; min-width: 0; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
.bzt .bz-btn {
  all: unset; flex: none; cursor: pointer; padding: 2px 9px; border-radius: 5px;
  background: var(--hz-raise); border: 1px solid var(--hz-line);
  font-size: 11px; color: var(--hz-txt); font-family: inherit;
}
.bzt .bz-btn:hover:not(:disabled) { border-color: var(--hz-accent); color: var(--hz-accent); }
.bzt .bz-btn:disabled { opacity: .4; cursor: default; }

/* ---- 取片列表：点「选取成片」在标题行下展开，浮在内容上不挤压布局 ---- */
.bzt .bz-pick { position: absolute; top: 33px; left: 10px; right: 10px; z-index: 20;
                max-height: 192px; overflow-y: auto; padding: 3px;
                background: var(--hz-panel); border: 1px solid var(--hz-line);
                border-radius: 7px; box-shadow: 0 8px 24px #000000aa; }
.bzt .bz-pick[hidden] { display: none; }
.bzt .bz-pick-row { display: flex; align-items: center; gap: 8px;
                    padding: 4px 7px; border-radius: 5px; cursor: pointer;
                    font-size: 11px; color: var(--hz-txt); }
.bzt .bz-pick-row:hover { background: var(--hz-raise); }
.bzt .bz-pick-row.on { color: var(--hz-accent); }
.bzt .bz-pick-nm { flex: 1 1 auto; min-width: 0; overflow: hidden;
                   white-space: nowrap; text-overflow: ellipsis; }
.bzt .bz-pick-tm { flex: none; font-size: 10px; color: var(--hz-label); }
.bzt .bz-pick-empty { padding: 8px; font-size: 11px; color: var(--hz-label); }

/* ---- 选帧胶片条（薄轨）---- */
.bzt .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
/* 胶片条保持细轨固定高：它吃弹性高度的话，帧宽是按 view 高度推的
   （cellPx = view.clientHeight × 画幅），一撑高就变成三张巨帧，视觉炸掉。
   富余高度改为全部落进 msg 上方的留白。 */
.bzt .bz-band { display: flex; flex-direction: column; gap: 3px; flex: none; }
.bzt .bz-view { position: relative; height: 30px; overflow: hidden;
                background: var(--hz-well); border: 1px solid var(--hz-line);
                border-radius: 6px; box-shadow: inset 0 1px 3px #00000061;
                touch-action: none; cursor: crosshair; outline: none; }
.bzt .bz-view img { position: absolute; top: 0; height: 100%; display: block;
                    pointer-events: none; }
/* display:block 会顶掉 [hidden] 的 UA 隐藏，抽帧失败时破损图必须真正消失 */
.bzt img[hidden] { display: none !important; }
.bzt .bz-view .bz-empty { position: absolute; inset: 0; display: flex;
                          align-items: center; justify-content: center;
                          color: var(--hz-label); font-size: 10.5px; }
.bzt .bz-view.bz-pan { cursor: grab; }
.bzt .bz-view.bz-panning { cursor: grabbing; }
.bzt .bz-view.bz-live { cursor: ew-resize; }
/* 播放头：细竖线 + 顶部小三角 */
.bzt .bz-play { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
                background: #f5f5f5; pointer-events: none; z-index: 3;
                box-shadow: 0 0 4px #000c; }
.bzt .bz-play::before { content: ""; position: absolute; top: 0; left: -4px;
                        border-left: 4px solid transparent; border-right: 4px solid transparent;
                        border-top: 6px solid #f5f5f5; }
.bzt .bz-bub { position: absolute; top: 2px; transform: translateX(-50%); z-index: 4;
               pointer-events: none; display: none; white-space: nowrap;
               background: #000000d9; border: 1px solid var(--hz-line); border-radius: 4px;
               padding: 1px 6px; font-size: 10.5px; color: var(--hz-txt); }
/* 胶片条下方一行：时间码 · 缩放倍数 · 尾帧 */
.bzt .bz-trackrow { display: flex; align-items: center; gap: 8px; min-width: 0;
                    font-size: 10.5px; color: var(--hz-label); }
.bzt .bz-tc { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap;
              text-overflow: ellipsis; font-size: 10.5px; }
.bzt .bz-zoom { flex: none; min-width: 26px; text-align: right; font-size: 10px;
                color: var(--hz-dim); }
.bzt .bz-mini { all: unset; flex: none; cursor: pointer; font-size: 10.5px;
                padding: 1px 8px; border-radius: 4px; color: var(--hz-dim);
                border: 1px solid var(--hz-line); background: var(--hz-well); }
.bzt .bz-mini:hover:not(:disabled) { color: var(--hz-accent); border-color: var(--hz-accent); }
.bzt .bz-mini:disabled { opacity: .4; cursor: default; }

/* ---- 目标切换：空间关系参照图 / 开场构图 ---- */
.bzt .bz-tabs { display: flex; gap: 5px; flex: none; }
.bzt .bz-tab { all: unset; cursor: pointer; padding: 2px 9px; border-radius: 5px;
               font-size: 10.5px; color: var(--hz-label); font-family: inherit;
               border: 1px solid var(--hz-line); background: var(--hz-well); }
.bzt .bz-tab:hover:not(.on) { color: var(--hz-dim); border-color: var(--hz-dim); }
.bzt .bz-tab.on { color: var(--hz-accent); border-color: var(--hz-accent);
                  background: var(--hz-accent-dim); }

/* ---- 接缝：左源帧 / 圆形动作 / 右目标帧 ---- */
.bzt .bz-seam { display: flex; align-items: stretch; gap: 8px; }
.bzt .bz-card { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.bzt .bz-cl { font-size: 10.5px; color: var(--hz-label); margin-bottom: 3px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bzt .bz-cl b { color: var(--hz-txt); font-weight: 600; }
.bzt .bz-vframe { position: relative; aspect-ratio: 16 / 9; border-radius: 7px;
                  overflow: hidden; background: #000;
                  border: 1px solid var(--hz-line); }
.bzt .bz-vframe.dash { background: var(--hz-well);
                       border: 1px dashed var(--hz-line); }
.bzt .bz-vframe img { position: absolute; inset: 0; width: 100%; height: 100%;
                      object-fit: contain; display: block; }
/* 搓帧时直接铺胶片条对应格子，零网络延迟跟手；松手才换高清 preview */
.bzt .bz-stripzoom { position: absolute; inset: 0; z-index: 1;
                     background-repeat: no-repeat; background-color: #000; }
.bzt .bz-vcap { position: absolute; inset: 0; display: flex; align-items: center;
                justify-content: center; text-align: center; padding: 6px;
                font-size: 10.5px; color: var(--hz-label); line-height: 1.4; }
.bzt .bz-vframe.bz-err .bz-vcap { color: #f09595; }
.bzt .bz-vbadge { position: absolute; top: 5px; right: 5px; z-index: 2;
                  font-size: 9.5px; padding: 1px 6px; border-radius: 5px;
                  color: #d8d8de; background: rgba(18,18,20,.62);
                  border: 1px solid rgba(255,255,255,.16);
                  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.bzt .bz-vbadge.hot { color: #ffc06a; border-color: var(--hz-warn);
                      background: rgba(226,162,75,.18); }
.bzt .bz-vm { display: flex; align-items: center; gap: 6px; margin-top: 3px;
              font-size: 10.5px; color: var(--hz-dim); min-width: 0; }
.bzt .bz-vm span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* 源帧画面上的左右步进 */
.bzt .bz-nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 3;
               width: 22px; height: 22px; border-radius: 50%; display: grid;
               place-items: center; padding: 0; font-size: 13px; color: #f2f2f4;
               background: rgba(18,18,20,.56); border: 1px solid rgba(255,255,255,.12);
               backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
               cursor: pointer; }
.bzt .bz-nav-l { left: 5px; } .bzt .bz-nav-r { right: 5px; }
.bzt .bz-nav:hover:not(:disabled) { border-color: var(--hz-accent); color: var(--hz-accent); }
.bzt .bz-nav:disabled { opacity: .35; cursor: default; }

/* 中间圆形主动作：青=替换，橙=已替换（可还原），灰=不可用 */
.bzt .bz-mid { flex: none; align-self: center; width: 36px; height: 36px;
               border-radius: 50%; padding: 0; border: none; cursor: pointer;
               display: grid; place-items: center; font-size: 15px; font-weight: 700;
               background: var(--hz-accent); color: #08222b;
               box-shadow: 0 3px 12px rgba(88,209,255,.32); font-family: inherit; }
.bzt .bz-mid:hover:not(:disabled) { filter: brightness(1.1); }
.bzt .bz-mid:disabled { background: var(--hz-raise); color: var(--hz-label);
                        box-shadow: none; cursor: default; }
.bzt .bz-mid.bz-on { background: var(--hz-warn); color: #241708;
                     box-shadow: 0 3px 12px rgba(226,162,75,.32); }
/* 替换成功：目标卡边框亮一下 */
.bzt .bz-vframe.bz-flash { animation: bzflash .55s ease-out; }
@keyframes bzflash {
  0%   { box-shadow: 0 0 0 0 rgba(88,209,255,.0); border-color: var(--hz-accent); }
  25%  { box-shadow: 0 0 0 3px rgba(88,209,255,.35); }
  100% { box-shadow: 0 0 0 0 rgba(88,209,255,.0); }
}

/* ---- 状态行 ---- */
/* margin-top:auto：节点比内容高时，状态行贴住面板底边，面板视觉上跟到节点底部，
   富余空间变成 msg 上方的呼吸留白，而不是内容被拉散。 */
.bzt .bz-msg { font-size: 11px; color: var(--hz-label); min-width: 0;
               margin-top: auto; padding-top: 6px;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bzt .bz-msg.bz-ok { color: #6ec49a; }
.bzt .bz-msg.bz-err { color: #f09595; }
`;
