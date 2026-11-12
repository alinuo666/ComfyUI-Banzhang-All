/* ============================================================
 * H3 媒体架 — 样式
 * ------------------------------------------------------------
 * 面板级样式复用导演台那份（CAST_CSS），这里只补媒体架专属的：
 * 节点级拖入高亮、提示条、清空钮、别名输入框、胶囊小设置、本段指示。
 * ============================================================ */
/* 断环（20261013 白屏根因）：本文件原来从 csglide_cast.js 取 CAST_CSS / CUR_SEG，
   但依赖链 cast → bz_project_sync → csglide_media_rack → 本文件 → cast 构成循环：
   入口是 cast 时，模块在 L73 模板求值时访问尚未初始化的 CUR_SEG，
   TDZ ReferenceError 让整条扩展链加载失败、三个 H3 节点全裸（前端不显示）。
   直接从定义处取：CSS 是纯文本无依赖、CUR_SEG 只依赖 bz_store，均无环。 */
import { CSS as CAST_CSS } from "./csglide_cast.css.js";
import { CUR_SEG, CUR_SEG_DIM } from "./csglide_film.js";

export const RACK_CSS = `
.gmr.drop-active { outline:2px dashed var(--h3-accent); outline-offset:-3px; }
.gmr-bar { display:flex; align-items:center; }
/* 右下角清空钮：苹果质感——半透明毛玻璃底盘 + inset 高光描边 + 分层投影，
   叉由两条细杆绘制（比字体字符更利落、不随字体变形），悬停填 Apple Red。 */
.gmr { position:relative; }
.gmr button.gmr-clear { position:absolute; right:8px; bottom:8px; z-index:6;
  width:26px; height:26px; padding:0; border:0; border-radius:50%; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  background:rgba(255,255,255,.07);
  -webkit-backdrop-filter:blur(10px) saturate(180%);
  backdrop-filter:blur(10px) saturate(180%);
  box-shadow:inset 0 .5px 0 rgba(255,255,255,.16),
             inset 0 0 0 .5px rgba(255,255,255,.10),
             0 1px 2px rgba(0,0,0,.34), 0 4px 12px rgba(0,0,0,.26);
  color:rgba(255,255,255,.62);
  transition:background .18s cubic-bezier(.25,.8,.25,1), color .18s cubic-bezier(.25,.8,.25,1),
             box-shadow .18s cubic-bezier(.25,.8,.25,1), transform .14s cubic-bezier(.25,.8,.25,1); }
.gmr button.gmr-clear::before, .gmr button.gmr-clear::after {
  content:""; position:absolute; left:50%; top:50%;
  width:11px; height:1.6px; border-radius:2px; background:currentColor;
  transition:background .18s cubic-bezier(.25,.8,.25,1); }
.gmr button.gmr-clear::before { transform:translate(-50%,-50%) rotate(45deg); }
.gmr button.gmr-clear::after  { transform:translate(-50%,-50%) rotate(-45deg); }
.gmr button.gmr-clear:hover { color:#fff; background:rgba(255,59,48,.92);
  box-shadow:inset 0 .5px 0 rgba(255,255,255,.34),
             0 2px 6px rgba(255,59,48,.40), 0 6px 16px rgba(255,59,48,.28); }
.gmr button.gmr-clear:active { transform:scale(.9); background:rgba(255,59,48,.78); }
/* 图片槽位不再固定 9 列：按数量流式换行。整格按 1.5× 放大（64→96 宽、48→72 高）
   ——媒体架是独立素材区，原来 64×48 的格子连缩略图都看不清。宽高必须同倍放大：
   缩略图是 width:100% + object-fit:contain，只放大宽会让高继续卡住横图的显示尺寸。 */
.gmr .gcast-grid.img { grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); }
.gmr .gcast-grid.img .gcast-thumb { height:72px; }
/* 视口外卡片虚拟渲染（20261023 性能专项）：图片槽上限 200，全部卡片常驻
   布局/绘制是「素材一多滚动就卡、拖入排序卡」的结构性根因。
   content-visibility:auto 让浏览器对视口外卡片整块跳过布局/绘制/图片解码
   （浏览器原生虚拟列表，视口外不耗布局帧时间）；contain-intrinsic-size 给
   离屏占位尺寸，auto 关键字表示「首次真实渲染后记住实测尺寸」，滚动条不
   跳。占位高 = border2 + padding8 + thumb72 + gap4 + cap约18 ≈ 104，取 108
   留余量。DOM/事件/拖拽/keyed 缓存全部保留，与 JS 虚拟窗口化性能等价、
   零逻辑风险。只给图片卡（最多 200 是大头）；视频/音频卡各上限 3 张，不做。 */
.gmr .gcast-grid.img .gcast-slot {
  content-visibility:auto;
  contain-intrinsic-size:auto 100px 108px;
}
/* 画布导航期降载（20261101 性能专项第二轮）：媒体架是挂在 ComfyUI 的
   transform:translate/scale 盒里的 DOM widget —— 画布平移/缩放/拖节点时
   整块面板都要按新比例重栅格化，代价 ≈ 可见卡片的像素面积，img/video 的
   重采样是大头（这也解释了「显存内存都不高但很卡」：栅格成本不进那两个
   读数）。html.bz-nav 由 csglide_media_rack.js 在视图变换/按住拖动期间挂
   上、停手 180ms 后摘掉：动的瞬间只隐掉媒体元素本身（布局不动、只是不画
   位图），格框 / 编号牌 / 别名输入全部保留，停下立刻恢复。与
   ComfyUI-NodeSnapshots 的「导航期简化」同一思路（350 节点工作流 20→60
   FPS），但只降媒体元素的栅格成本，不动数据、不动交互结构。 */
html.bz-nav .gmr .gcast-thumb img,
html.bz-nav .gmr .gcast-thumb video,
html.bz-nav .gmr .gcast-wave { visibility:hidden; }
/* 视频/音频卡重内容延迟挂载占位（20261023 P1）：未进视口的卡只挂轻量
   cap + 这个空盒，不建 video、不发起波形解码。占位高度仅为滚动条稳定，
   挂载后（.mounted）归零，最终高度完全由内容决定。 */
.gcast-heavy.hv { min-height:200px; }
.gcast-heavy.ha { min-height:88px; }
.gcast-heavy.mounted { min-height:0; }
/* 编号角标改「时间码牌」样式（方案 F）：原来的 8px 圆点塞不下两位数，6px 字
   压在照片上更看不清 —— 素材一多就数不出第几号，而编号正是文案台 @图片N 的
   唯一对应物。斜切深牌 + 1px 亮边是剪辑软件的时间码语言：一眼认得出是编号，
   也不会被当成图标。宽度随位数自适应（上限 200 位，三位数也装得下）。
   只限定媒体架：.gcast-grid.img 是媒体架图片格专用类，导演台的徽标传的是
   「首/尾」文字、网格类也不同，一起改会把那边弄坏。 */
.gmr .gcast-grid.img .gcast-num {
  /* 牌面上下贴字：牌高不再写死像素，直接取 .85em（跟 font-size 联动，改字号
     不用再配一个数）。line-height 同步压到 .85 —— 光把 height 调小没用，等宽
     字体 14px 的行盒里数字上下本来就各留约 2px 的内部行距，那是我们加的余量
     之外、字体自带的，只能靠 line-height 压掉。压到 .85 后数字顶/底距牌边约
     0.6 / 1.2px，肉眼即贴边。
     ⚠ 别再往下压：低于 .8 时数字会被 clip-path 切掉顶/底（字体差异不可控）。
        发现被切就把这一对 .85 提到 .9。 */
  width:auto; height:.85em; min-height:0; min-width:.85em;
  padding:0 8px 0 7px; border-radius:0;
  font-size:14px; font-weight:600; line-height:.85; letter-spacing:.02em;
  /* 墨绿：与「参照图替换」节点的强调色同源，压在任何照片上都读得出是编号牌，
     又不会像纯黑那样被当成界面阴影。白字对比度约 9:1。 */
  color:#fff; background:#1e4d38;
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.28);
  text-shadow:0 1px 2px rgba(0,0,0,.7);
  clip-path:polygon(0 0, 100% 0, 100% 100%, 5px 100%, 0 calc(100% - 5px));
  left:3px; top:3px; }
/* 「本段文案没有引用」的那几张：牌面转灰绿（保留一点绿，读得出还是同一种
   牌子），语义不变 —— 还是编号，只是这一段没用它。与墨绿牌的饱和度差要够，
   别灰成一片分不出。判据见 csglide_rack_refs.js（写的是 @图片N 才亮）。
   ⚠ 这一整段是**模板字符串**：正文里不许出现反引号。写了就是提前闭合字符串，
   后面那半截变成 JS 表达式 —— 语法还合法（node --check 查不出来），运行期才
   ReferenceError，整个扩展加载失败、节点全空（20261024 现场）。 */
.gmr .gcast-grid.img .gcast-unref .gcast-num { background:#454f4a; }
/* 视频/音频格窄节点降列（20261019「两个音频竖排堆成一列」附带项）：
   .med 原是固定三列 minmax(0,190px)，节点被拖窄后三列一起压扁——cap 文字
   折行、波形只剩几十像素，观感就是「挤成一团」。auto-fit 让宽节点仍从三列
   起、窄了自动降两列/一列，与图片区 auto-fill 同一思路；节点拖宽时列数自然
   增多，不再右侧留一片空白。特异性 (0,3,0) 压过 CAST_CSS 的 (0,2,0)。
   ⚠ 这串列值与 csglide_rack_cards.js 的 healGrids() 兜底值必须保持一致：
   样式表被旧缓存顶掉时（custom_nodes 静态服务无缓存戳，覆盖更新后不硬刷新
   会新旧混跑），那边按计算样式把这串值补成内联。 */
.gmr .gcast-grid.med { grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); }
/* 「＋ 添加」格的样式在共用样式表 CAST_CSS 里（Qwen 编辑台同用一份） */
/* 别名输入框：默认隐形（看起来就是一行文字），聚焦才显形——卡片本来就窄，
   不能为了一个偶尔改的字段常驻描边。 */
.gmr-alias { flex:1 1 auto; min-width:0; width:100%; box-sizing:border-box;
  background:transparent; border:1px solid transparent; border-radius:4px;
  color:inherit; font-family:inherit; font-size:10px; padding:1px 3px;
  text-overflow:ellipsis; }
.gmr-alias:hover { border-color:var(--h3-line); }
.gmr-alias:focus { outline:none; border-color:var(--h3-accent); background:var(--h3-bg); }
.gmr-alias.bad { border-color:#ff9f43; color:#ff9f43; }
.gmr-alias.bad:focus { border-color:#ff9f43; }
.gmr-alias::placeholder { color:var(--h3-dim); opacity:.65; }
.gmr-mini { all:unset; pointer-events:auto; cursor:pointer; margin-left:auto;
  font-size:10px; color:var(--h3-dim); padding:2px 7px; border-radius:5px;
  border:1px solid var(--h3-line); }
.gmr-mini:hover { color:var(--h3-accent); border-color:var(--h3-accent); }
/* 面板条上的胶囊小设置（帧率 / 音频输出编号）：标签内嵌在胶囊里，空态只有
   一颗暗标签，聚焦整颗胶囊才描边，尺寸与 gmr-mini 同一档次，不抢视觉。 */
.gmr-chip { display:inline-flex; align-items:center; gap:4px; margin-left:6px;
  padding:2px 8px; border-radius:999px; border:1px solid var(--h3-line);
  background:transparent;
  transition:border-color .15s cubic-bezier(.25,.8,.25,1), background .15s; }
.gmr-chip:hover { border-color:var(--h3-line); }
.gmr-chip:focus-within { border-color:var(--h3-accent); background:var(--h3-bg); }
.gmr-chiplab { font-size:10px; color:var(--h3-dim); user-select:none; cursor:default; }
/* 本段指示：素材是按分段记忆的，得让人看见现在摆的是哪一段的素材。
   颜色与「锁定加发光」这套画法，跟时间轴上那一段的紫环、文案台上那颗胶囊
   是同一个信号的三种画法 —— 规范色从成片监视器导入，不在这里另抄一份。 */
.gmr-segchip { margin-left:6px; padding:2px 8px; border-radius:999px;
  font-size:10px; color:var(--h3-dim); border:1px dashed var(--h3-line);
  white-space:nowrap; flex:none; }
.gmr-segchip.on { color:${CUR_SEG}; border-style:solid;
  border-color:${CUR_SEG_DIM}; background:${CUR_SEG_DIM}; }
.gmr-segchip.on.locked { box-shadow:0 0 7px 1px ${CUR_SEG_DIM}; border-width:2px;
  padding:1px 7px; }
/* 芯片可点（切「全片共用 / 按段记忆」）：悬停给个能点的信号，待确认态用强调色
   实线描一圈，跟「第 N 段」的紫区分开（20261022）。*/
.gmr-segchip { cursor:pointer; user-select:none; }
.gmr-segchip:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gmr-segchip.armed { border-style:solid; border-color:var(--h3-accent);
  color:var(--h3-accent); background:rgba(88,209,255,.12); }
/* 覆盖共用表里的 .gcast input[type=number] 基础样式（62px 宽、带底色边框，
   特异性比单类名高，不提级选择器就会把胶囊里的输入框撑回大块头——实测教训）。
   三层类名 (0,3,0) 压过 (0,2,1)。 */
.gmr .gmr-chip .gmr-num {
  all:unset; pointer-events:auto; display:inline; width:30px; box-sizing:border-box;
  height:auto; padding:0; border:0; border-radius:0; background:transparent;
  color:var(--h3-txt); font-family:inherit; font-size:11px; text-align:center;
  -moz-appearance:textfield; appearance:textfield; }
/* 隐藏 number 输入的上下箭头：占地方且与胶囊风格不符 */
.gmr .gmr-chip .gmr-num::-webkit-outer-spin-button,
.gmr .gmr-chip .gmr-num::-webkit-inner-spin-button {
  -webkit-appearance:none; margin:0; }
.gmr .gmr-chip .gmr-num:focus-visible { outline:none; border:0; }
/* 瞬态提示条：拖入被拒、上传失败这类「什么都没发生」必须说出来——静默丢弃
   是最难排查的一类问题，用户只会得出「这图导不进来」的结论。
   底部居中，右侧留出清除钮（26px + 8px）的位子，两者不会压到一起。 */
.gmr-toast { position:absolute; left:50%; bottom:10px; transform:translate(-50%,6px);
  max-width:calc(100% - 88px); box-sizing:border-box; z-index:8;
  padding:5px 10px; border-radius:7px; text-align:center;
  font-size:11px; line-height:1.45;
  background:rgba(32,32,34,.95); color:#eaeaec;
  border:1px solid rgba(255,255,255,.16);
  -webkit-backdrop-filter:blur(10px) saturate(180%);
  backdrop-filter:blur(10px) saturate(180%);
  box-shadow:0 4px 14px rgba(0,0,0,.42);
  opacity:0; pointer-events:none;
  transition:opacity .18s cubic-bezier(.25,.8,.25,1), transform .18s cubic-bezier(.25,.8,.25,1); }
.gmr-toast.on { opacity:1; transform:translate(-50%,0); }
.gmr-toast.bad { background:rgba(58,28,28,.96); color:#ffb3b3;
  border-color:rgba(160,82,82,.9); }
`;

let cssInjected = false;
export function injectRackCSS() {
  if (cssInjected) return;
  const s = document.createElement("style");
  s.id = "gmr-css";
  /* 面板样式表原样注入（gcast-css 自带幂等标记），再叠媒体架专属的少量规则 */
  if (!document.getElementById("gcast-css")) {
    const base = document.createElement("style");
    base.id = "gcast-css";
    base.textContent = CAST_CSS;
    document.head.append(base);
  }
  s.textContent = RACK_CSS;
  document.head.append(s);
  cssInjected = true;
}
