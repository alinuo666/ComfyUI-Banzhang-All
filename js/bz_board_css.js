/* 分镜轨样式（20261119）：自注入、硬编码琥珀色，与音频轨自注入同套路，
   不依赖宿主 .bzfilm 的 CSS 变量（时间轴外挂移容器后变量会丢）。 */

let cssReady = false;
export function injectBoardCss() {
  if (cssReady) return;
  cssReady = true;
  const s = document.createElement("style");
  s.textContent = `
/* 与音频行同款：.bzf-track 自带 margin-left:26，行用 -26px 把轨头列挪进
   左侧轨头区，lane 起点才落在视频轴 0 帧边缘；宽度补回 26（尺子没起时兜底）。 */
.bzsb-box{display:flex;align-items:stretch;margin:2px 0 0 -26px;width:calc(100% + 26px);min-height:64px;}
.bzsb-head{flex:0 0 26px;}
.bzsb-lane{position:relative;flex:1;height:64px;border:1px dashed rgba(232,180,90,.35);border-radius:6px;background:rgba(232,180,90,.05);overflow:hidden;}
.bzsb-over .bzsb-lane{border-color:#e8b45a;background:rgba(232,180,90,.12);}
.bzsb-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(232,180,90,.75);pointer-events:none;padding:0 8px;text-align:center;}
/* 常驻错误行：有锚时 hint 会被隐藏，「保存/读取失败」不能跟着一起没了。
   右上角小字、不吃点击（pointer-events:none），避免压住 × 删除钮。 */
.bzsb-err{position:absolute;top:2px;right:6px;max-width:60%;font-size:10px;line-height:13px;color:#e05a4e;text-align:right;pointer-events:none;}
.bzsb-anchor{position:absolute;top:4px;width:48px;cursor:grab;user-select:none;touch-action:none;}
.bzsb-anchor img{width:48px;height:32px;object-fit:cover;border-radius:4px;border:1px solid #e8b45a;display:block;}
.bzsb-at{font-size:10px;color:#e8b45a;text-align:center;line-height:14px;}
.bzsb-x{position:absolute;top:-6px;right:-6px;width:14px;height:14px;border-radius:50%;border:none;background:#c0392b;color:#fff;font-size:10px;line-height:14px;padding:0;cursor:pointer;display:none;}
.bzsb-anchor:hover .bzsb-x{display:block;}
.bzsb-preview{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:zoom-out;}
.bzsb-preview img{max-width:82vw;max-height:78vh;border-radius:8px;border:2px solid #e8b45a;}
.bzsb-preview div{color:#e8b45a;font-size:12px;}
`;
  document.head.appendChild(s);
}