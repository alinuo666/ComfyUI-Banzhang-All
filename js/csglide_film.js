/* ============================================================
 * 成片监视器 —— 「上成片 / 下时间轴」的共用组件
 * ------------------------------------------------------------
 * 导演台与续接合成都要这一块，所以抽成独立模块，两边共用同一份实现——
 * 各写一份一定会在某次改动后走样，而用户看到的是「同一个预览窗」。
 *
 * 布局按剪辑软件的直觉：上面是最终成片，下面是所有段落的时间轴。
 *
 *   · 标题栏：片名 · 第 N 段 / 共 N 段 · 锁定态（只读，没有按钮）
 *   · 取景器：成片本体（走 Range 请求，拖动即 seek，服务端不解码）
 *   · 时间轴：段落色块（可点选切段）+ 胶片条 + 波形 + 播放头
 *
 * 三态：内嵌（inline）/ 收起（collapsed）/ 拖出悬浮（floating）。
 * 标题栏上那颗「拖出」按钮已撤，三态能力仍留在代码里、但当前没有 UI 入口 ——
 * 要恢复悬浮，把按钮加回 .bzf-bar 并接一次 setMode("floating") 即可。
 * 悬浮时根节点搬到 body 上并在原位留一个占位块，收回再放回去——
 * 直接 appendChild 会把节点面板里的兄弟节点顺序搞乱。
 *
 * 后端复用已有的只读接口，本模块不新增任何路由：
 *   /cglide/chain/film_summary          整片成片视图（避开 /film GET-POST 串线）
 *   /cglide/join/info|thumb|waveform|video   单条成片的元信息 / 缩略图 / 波形 / 流
 *
 * 时间轴的刻度口径：第 k 段的成片是「前 k 段累积起来的片子」，所以选中
 * 第 k 段时时间轴画的是 1..k 段；每段在成片里的净贡献要扣掉与前面重叠的
 * trim 帧（H3 恒定 22），再整体归一化到这条成片的真实帧数。
 * ============================================================ */
import { api } from "../../scripts/api.js";

import { bzStore } from "./bz_store.js";
import { mountAudioLane } from "./csglide_audio_lane.js";
import { createTimelineEngine } from "./csglide_timeline_engine.js";
import { netOfTotal, totalOfNet, secsIntOfFrames } from "./csglide_length.js";

const JOIN = "/cglide/join";
const CHAIN = "/cglide/chain";

/* 「当前段 / 编辑目标」的规范色 —— 三个节点必须共用这一个值。
   以前三处各说各话：时间轴给选中段描白边，文案台与媒体架的胶囊用紫色，用户
   看不出它们指的是同一件事。这里定义并导出，另两个节点用模板字符串插进自己
   的 CSS —— 不存在手抄副本，改一处就一起改。 */
export const CUR_SEG = "#a97bff";
export const CUR_SEG_DIM = "#a97bff26";

const CSS_ID = "bz-film-css";
const CSS = `
.bzfilm {
  --bz-bg:#191919; --bz-panel:#212121; --bz-raise:#2b2b2b; --bz-line:#3b3b3b;
  --bz-well:#131313;
  --bz-txt:#e3e3e3; --bz-dim:#979797;
  --bz-accent:#58d1ff; --bz-accent-dim:#58d1ff26;
  --bz-violet:${CUR_SEG}; --bz-violet-dim:${CUR_SEG_DIM};
  --bz-over:#e24b4a; --bz-wave:#59c14f;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: var(--bz-txt); font-size: 12px; line-height: 1.35;
  pointer-events: auto; position: relative; width: 100%; min-width: 0;
  background: var(--bz-bg); border: 1px solid var(--bz-line); border-radius: 10px;
  padding: 8px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 6px; overflow: hidden;
  user-select: none; -webkit-user-select: none;
}
.bzfilm * { box-sizing: border-box; }

/* ---- 工具栏 ---- */
.bzf-bar {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex: none;
  color: var(--bz-dim); font-size: 11.5px; white-space: nowrap; overflow: hidden;
}
.bzf-bar .bzf-title { color: var(--bz-txt); font-weight: 500; flex: none; }
.bzf-bar .bzf-meta { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bzf-bar .bzf-sp { flex: 1 1 auto; min-width: 4px; }
.bzf-bar .bzf-btn {
  all: unset; pointer-events: auto; cursor: pointer; flex: none;
  padding: 2px 8px; border-radius: 4px; background: var(--bz-raise);
  border: 1px solid var(--bz-line); font-size: 11px; color: var(--bz-txt);
  font-family: inherit;
}
.bzf-bar .bzf-btn:hover { border-color: var(--bz-accent); color: var(--bz-accent); }
.bzf-bar .bzf-btn.bzf-on {
  border-color: var(--bz-accent); color: var(--bz-accent);
  background: var(--bz-accent-dim);
}
.bzf-bar .bzf-btn:disabled { opacity: .4; cursor: default; }
.bzf-bar .bzf-err { color: #f09595; }

/* ---- 取景器 ---- */
.bzf-view {
  /* 20261108 固定 16:9：以前 --bzf-ar 由 loadedmetadata 按真实分辨率写入，
     竖屏 9:16 会把监视器、双栏乃至整个节点顶高一倍。尺寸是布局参数，
     不该由素材决定；竖画面用 contain 居中，左右留黑边。 */
  /* max-height 只防超宽节点把高度推过头：宽度 >747px 时 16:9 会算出 >420px。 */
  position: relative; flex: 0 0 auto; width: 100%; min-height: 96px;
  max-height: 420px;
  aspect-ratio: 16 / 9;
  background: #0d0d0d; border: 1px solid var(--bz-line); border-radius: 6px;
  overflow: hidden; cursor: pointer;
}
.bzfilm.bzf-collapsed .bzf-view,
.bzfilm.bzf-collapsed .bzf-band,
.bzfilm.bzf-collapsed .bzf-foot { display: none; }
.bzf-view video, .bzf-view img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: contain; display: block; background: #0d0d0d;
}
.bzf-view img { opacity: 0; }
.bzf-view img.bzf-ok { opacity: 1; }
.bzf-view video { opacity: 0; }
.bzf-view video.bzf-ok { opacity: 1; }
/* 拖动跨接缝冻结层：常驻 canvas，GPU 位图拷贝当前帧、不编码；换源空窗盖最上防黑 */
.bzf-view canvas.bzf-freeze {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: contain; display: block; background: #0d0d0d; opacity: 0;
}
.bzf-view canvas.bzf-freeze.bzf-ok { opacity: 1; }
/* 空态引导覆盖层：没有成片时给一句引导；pointer-events:none 不挡手势。
   大播放钮已删除（拖时间轴指针时挡画面、碍眼），播放/暂停走点击画面或空格。 */
.bzf-center {
  position: absolute; inset: 0; z-index: 3;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none; transition: opacity .22s ease;
}
.bzf-cstatus {
  font-size: 12px; letter-spacing: .02em; color: rgba(236,236,240,.85);
  background: rgba(10,10,12,.45); border: 1px solid rgba(255,255,255,.07);
  padding: 5px 13px; border-radius: 20px;
  backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
}
/* 有成片（暂停或播放）时整层隐藏，不挡画面、不碍拖指针；空态才显示引导 */
.bzf-center.has-film { opacity: 0; }
.bzf-cap {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 8px;
  font-size: 11px; color: var(--bz-dim); background: linear-gradient(transparent, #000a);
  pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bzf-badge {
  position: absolute; top: 6px; left: 6px; padding: 2px 7px; border-radius: 4px;
  font-size: 10.5px; background: #0009; color: var(--bz-accent);
  border: 1px solid var(--bz-accent-dim); pointer-events: none;
}

/* ---- 时间轴 ---- */
.bzf-band {
  position: relative; flex: none; cursor: crosshair;
  background: var(--bz-well); border: 1px solid var(--bz-line); border-radius: 6px;
  /* 像素/帧模型：内容区 track 可超出可视宽。**不渲染横向滚动条**（20261031
     用户定）：overflow-x:auto 时，几像素的右缘探出（播放头手柄/刻度标签）
   就能让滚动条常驻。改 hidden 后：
   · 滚动条永不显示，几像素假溢出由裁切兜住；尺子一律严格铺满，不缩让
     （缩让会在右侧留下可见空白带，20261108 用户报「拖音频后空出一块」）；
   · JS 的 scrollLeft 在 overflow:hidden 下照常可用 —— 滚轮横滚、拖段贴边
     自动滚动、缩放锚定恢复全部不受影响；
   · 真缩放后的横向查看走滚轮（垂直转横向）与拖段贴边，不需要滚动条。 */
  overflow-x: hidden; overflow-y: hidden;
}
/* 内容轨：宽 = 总片长×px/帧（JS 写入），纵向叠放标尺/段块/音频；绝不窄于可视宽,
   短片段也铺满。position:relative 让播放头/吸附线相对它定位、随它滚动。 */
.bzf-track {
  position: relative; box-sizing: border-box;
  /* 左边 26px 只放一个小小的静音按钮，时间轴 0 帧从这里开始。
     引擎 fit 已把这一列从可见宽扣掉（gutter），整条片仍正好铺满。 */
  margin-left: 26px; min-width: calc(100% - 26px);
  display: flex; flex-direction: column;
  touch-action: none;
}
/* 时间刻度带：压在段落轨上面的一条 16px 细尺。它给"这是第几秒"一个锚 ——
   以前轴是一个纯比例条，播放头拖到 60% 也读不出是 12 秒还是 20 秒，那正是
   "不像剪辑软件"的一半来源。每 5/10/15 秒一根短线、每几根一根长线 + 时间标签；
   刻度是**绝对帧号 / fps** 算的，改画布长度 / 缩放跟着 total 重算。 */
.bzf-ruler { position: relative; height: 16px; overflow: visible; }
.bzf-tick {
  position: absolute; top: 0; height: 5px; width: 1px;
  background: var(--bz-line); transform: translateX(-0.5px);
}
.bzf-tick.major {
  height: 9px; background: var(--bz-dim);
}
.bzf-tick.major::after {
  content: attr(data-t); position: absolute; top: 0; left: 3px;
  font-size: 9px; line-height: 9px; color: var(--bz-dim); white-space: nowrap;
}
.bzf-segs { position: relative; height: 72px; overflow: visible; }
/* 裁切剃刀覆盖层（20261014）：平时不拦截事件、不占位；进入裁切模式后整块接管
   段块行的鼠标 —— 像剪辑软件的剃刀：移动显示吸附竖线，点哪切哪。
   它只覆盖段块行（top/高度由 JS 对齐 .bzf-segs），不挡上方标尺搓帧、下方波形
   与任何按钮。 */
.bzf-cutlayer {
  position: absolute; left: 0; top: 16px; width: 100%; height: 72px;
  z-index: 8; pointer-events: none; display: none; touch-action: none;
}
.bzf-band.bzf-cutting .bzf-cutlayer { display: block; pointer-events: auto; cursor: crosshair; }
.bzf-band.bzf-cutting .bzf-segs .bzf-seg { cursor: crosshair; }
.bzf-cutline {
  position: absolute; top: -2px; bottom: -2px; left: 0; width: 0;
  display: none; pointer-events: none;
  border-left: 2px dashed #ff5f56;
  box-shadow: 0 0 0 1px #000a, 0 0 9px #ff5f5699;
}
.bzf-cutline.on { display: block; }
.bzf-cutline.bad { border-left-color: #8a8a8a; box-shadow: 0 0 0 1px #0008; }
.bzf-cuttip {
  position: absolute; top: 0; left: 5px; white-space: nowrap;
  font-size: 10.5px; line-height: 1.45; padding: 1px 6px; border-radius: 4px;
  background: #000e; color: #ffd7d4; pointer-events: none;
}
.bzf-cutline.bad .bzf-cuttip { color: #c2c2c2; }
/* 空态（M4）：居中一张分步引导卡 —— 标题 + 三步 + 可点的「接第一段」CTA，
   新人第一次打开就知道先做什么，而不是对着一条空轴猜。 */
.bzf-empty { position:absolute; inset:0; display:grid; place-items:center;
  color:#787878; font-size:11px; line-height:1.5; text-align:center;
  padding:0 12px; }
.bzf-emp-card { display:flex; flex-direction:column; gap:9px; align-items:center;
  background:color-mix(in srgb,var(--bz-panel) 72%,transparent);
  border:1px solid var(--bz-line); border-radius:12px; padding:14px 18px;
  max-width:340px; }
.bzf-emp-tt { font-size:12.5px; font-weight:600; color:var(--bz-txt); }
.bzf-emp-steps { display:flex; flex-direction:column; gap:5px; text-align:left; }
.bzf-emp-step { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--bz-dim); }
.bzf-emp-n { flex:0 0 auto; width:15px; height:15px; border-radius:50%;
  display:grid; place-items:center; font-size:9.5px; color:var(--bz-accent);
  background:var(--bz-accent-dim); }
.bzf-emp-cta { margin-top:2px; appearance:none; border:none; cursor:pointer;
  background:var(--bz-accent); color:#06181f; font-size:11.5px; font-weight:600;
  padding:6px 16px; border-radius:8px; transition:filter .15s,transform .1s; }
.bzf-emp-cta:hover { filter:brightness(1.08); }
.bzf-emp-cta:active { transform:scale(.97); }
/* 合并轨：每一段 = 色头（编号/名/时长）+ 染色块体（未生成=彩色占位 /
   已生成=成片缩略图补位）。整块共用一个段色 —— 但"段色"是**两档原料**
   （--bz-seg-lo* 暗 / --bz-seg-hi* 亮，由 renderSegs 逐段写入）加**一个开关**
   （--bz-seg*，由下面的 .bzf-seg / .bzf-seg.bzf-sel 决定用哪档）。
   不再色条+黑体两截。 */
.bzf-seg {
  position: absolute; top: 0; bottom: 0; pointer-events: auto; cursor: pointer;
  display: flex; flex-direction: column; overflow: hidden;
  border-right: 1px solid #0009; border-radius: 5px;
  background: var(--bz-seg-bd2, #101010); box-sizing: border-box;
  /* 未选中：一圈**极淡**的轮廓（8% 白）。它只负责让人看清「段与段的边界在
     哪儿」，不参与"我是不是被选中"这件事 —— 那件事完全交给选中态。
     原来这里没有轮廓，边界靠右侧那条黑线；而「没成片」「没潜空间」的段又
     各自带一圈亮边（35% 白 / 中灰）。于是整条轴上深浅不一的边比选中提示
     还抢眼，扫一眼根本分不出点中的是哪一段。现在一律压到 8%，
     选中态靠下面的紫环 + 整块亮色说话。 */
  box-shadow: inset 0 0 0 1px #ffffff0d;
  /* ---- 段色：间接一层，专治"选中了但底色不变" ----
     这里是**整条配色唯一的分叉点**。段色分暗（常态）/ 亮（选中）两档，
     而"用哪一档"必须由**这里**决定 —— 因为 JS 给每个段块写的是 inline 样式
     变量。inline 的优先级**高于任何样式表规则**，所以只要 JS 直接把
     --bz-seg 写进元素，下面那条 .bzf-seg.bzf-sel 里的
     「--bz-seg: var(--bz-seg-hi)」就永远轮不到 —— 表现就是"点了段，
     只有紫环亮了，底色一动不动"。
     （这就是之前那个 bug：规则写了、看着也对，但它是死规则。）
     现在 JS 只写**调色板**（--bz-seg-lo* / --bz-seg-hi*，两个都是原料），
     "结果变量" --bz-seg* 只在这里和 .bzf-sel 里赋值 —— 一处给暗档，
     一处给亮档，样式表说了算，选中的那一段整块就真的亮起来。
     注意：这段注释在 JS 模板字符串里面，不能出现反引号 —— 一个反引号就会
     把整块 CSS 字符串提前截断，报的错还落在几百行之外。 */
  --bz-seg: var(--bz-seg-lo, #3a3a3a);
  --bz-seg-bd1: var(--bz-seg-lo-bd1, #1a1a1a);
  --bz-seg-bd2: var(--bz-seg-lo-bd2, #101010);
}
.bzf-seg-hd {
  flex: none; height: 20px; display: flex; align-items: center; gap: 4px;
  padding: 0 5px; overflow: hidden;
  font-size: 10.5px; color: #e8e8e8; font-weight: 600; white-space: nowrap;
  background: var(--bz-seg, #3a3a3a);
}
.bzf-seg-bd {
  flex: 1 1 auto; position: relative; min-height: 0; overflow: hidden;
  background: linear-gradient(180deg, var(--bz-seg-bd1, #1a1a1a), var(--bz-seg-bd2, #101010));
  /* 井底内阴影（20261024 晚，抄 Tail Ref 胶片条的 .bz-view）：画面带贴进去
     像落在一条槽里，格与格、段与段的边界因此看得清。 */
  box-shadow: inset 0 1px 3px #00000061;
}
.bzf-seg-bd .bzf-ph {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 2px;
  font-size: 11px; font-weight: 600; letter-spacing: .06em;
  color: var(--bz-seg-ph, #ffffff66);
  background:
    repeating-linear-gradient(135deg, var(--bz-seg-st, #ffffff0a) 0 6px, transparent 6px 12px);
  pointer-events: none;
}
.bzf-seg-bd .bzf-ph .bzf-ph-sub {
  font-size: 9px; font-weight: 400; letter-spacing: 0; color: #ffffff7a;
}
.bzf-seg.bzf-miss { opacity: .45; }
/* 段块里的三样东西：编号 / 名字 / 时长。编号与时长 flex:none 保住，名字可裁 ——
   块窄的时候先牺牲名字，但那两个数还在，而它们正是判断"这段多长"要用的。 */
.bzf-seg .bzf-no { flex: none; font-weight: 600; opacity: .92; }
/* 改名输入框就地把名字顶掉：贴着色条同款字号，不吃掉行高。
   Enter 确认 / Esc 取消的逻辑在宿主（导演台 renameShot）里。 */
.bzf-seg-hd input {
  flex: 1 1 auto; min-width: 0; margin: 1px 0; padding: 0 3px;
  border: 0; border-radius: 3px; outline: none;
  font: inherit; font-size: 10.5px; font-weight: 600; color: #101010;
  background: #ffffffcc;
}
.bzf-seg-hd input::placeholder { color: #10101059; }
.bzf-seg .bzf-nm { min-width: 0; overflow: hidden; text-overflow: ellipsis;
  opacity: .96; }
.bzf-seg .bzf-du {
  flex: none; margin-left: auto; padding-left: 5px; opacity: .8; font-size: 9.5px;
  font-family: ui-monospace, Consolas, monospace;
}
/* 版本号。段块窄，它排在实际内容之后、被 overflow 裁掉也无所谓 ——
   完整的「版本 k/n」写在 title 里，鼠标移上去能看全。 */
.bzf-seg .bzf-v { opacity: .7; font-size: 9px; margin-left: 1px; }
/* 选中段块：段操作图标浮在块体**正中间**（方案 B，20261011）。默认不显示、不拦截，
   选中才淡入；不挂 body、不超出块、不挡标尺接缝胶囊。 */
/* 选中段块：段操作图标收进**标题栏正中间、很小**（20261011 用户改定），不占块体、
   不挡画面；不挂 body、不超出块、不挡标尺接缝胶囊。 */
.bzf-seg-actions { position:absolute; top:2px; left:50%; transform:translateX(-50%);
  z-index:7; display:flex; gap:2px;
  opacity:0; pointer-events:none; transition:opacity .14s ease; }
.bzf-seg.bzf-sel .bzf-seg-actions { opacity:1; pointer-events:auto; }
.bzf-seg-act { width:16px; height:16px; padding:0; border-radius:4px;
  border:1px solid #ffffff26; background:#00000078; color:#e8e8e8; font-size:10px;
  line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.bzf-seg-act:hover { background:var(--bz-accent); border-color:var(--bz-accent); color:#07141a; }
.bzf-seg-act[data-act="del"]:hover { background:var(--bz-over); border-color:var(--bz-over); color:#fff; }
/* 已跳过：图标换成 ◉ 并点亮，避免「看着正常其实不渲染」 */
.bzf-seg-act[data-act="skip"].on { color:var(--bz-accent); border-color:var(--bz-accent); }
/* 段块接法胶囊已并入标尺单标记（方案 B，20261011），段块上不再有 .bzf-pin。 */
/* 待办：这一段被改过时长，得重跑一次才对得上。琥珀在本组件里**只**表示
   "有事没做"这一件事，别的语义不许借用它。 */
.bzf-seg.bzf-pend::after {
  content: ""; position: absolute; top: 1px; right: 2px;
  width: 5px; height: 5px; border-radius: 50%; background: #f0c674;
  box-shadow: 0 0 4px #f0c67499;
}
/* 没有潜空间档案的段（外部导入）：斜纹底 + 淡边，一眼看出它"不完全属于这条链"。
   身份靠**斜纹**表达就够了 —— 原来那圈中灰（#8a8a8a）比选中态的紫环还亮，
   一条轴上十几段里有几段是灰边时，看着像是被选中了。边框压到和别的段一样淡，
   差异只保留在斜纹上。 */
.bzf-seg.bzf-nolatent {
  box-shadow: inset 0 0 0 1px #ffffff1f;
  background-image: repeating-linear-gradient(45deg, #ffffff14 0 5px, transparent 5px 10px);
}
/* 当前段 = 编辑目标。用规范紫而不是白：白在一条 16px 高的段落条上读成
   "高亮/悬浮"，跟文案台、媒体架上那颗紫色胶囊对不上号 —— 三处说的是同一
   件事却长得不一样，用户得自己把它们联系起来。
   选中态同时把整块换成本段的亮色版：未选中的段全是暗色，只有点中的那一段
   亮起来 —— 「在哪一段」不用找。色头跟着换成深色字：亮底上浅字读不清。
   这三行**必须留在样式表里**，不能改成 JS 写 inline：JS 写的 inline 变量
   优先级更高，会把暗档钉死在元素上，这一档就永远生效不了（见 .bzf-seg 里
   那段「段色：间接一层」的说明）。
   放在 nolatent 之后：外部导入的段照样可以是当前段，不能让灰边把"正在编辑
   它"这条更要紧的信息盖掉。 */
.bzf-seg.bzf-sel {
  /* 选中描边（20261010 重做）：原来只有 2px 紫环贴边，相邻两段颜色相近时
     紫环糊进块里。现在三层：内侧 2px 紫环（规范色不变）→ 环外一圈 1px 黑线
     （把紫环从任何底色上"剪"出来）→ 最外一点微光晕（选中=唯一高声说话的
     那一块）。亮色块上依然清晰，暗色块上更是跳出来。 */
  box-shadow: inset 0 0 0 2px var(--bz-violet), 0 0 0 1px #000000b3,
    0 0 9px 1px var(--bz-violet-dim);
  --bz-seg: var(--bz-seg-hi);
  --bz-seg-bd1: var(--bz-seg-hi-bd1);
  --bz-seg-bd2: var(--bz-seg-hi-bd2);
}
.bzf-seg.bzf-sel .bzf-seg-hd { color: #101010; }
/* 选中的段如果还是"没成片"（bzf-none 会压 opacity）或"没潜空间"（斜纹），
   那两个修饰各自叠了一层底 —— 它们压在选中态上会让"我选中的是哪一段"弱掉。
   选中时把它们让开：斜纹与压暗都撤掉，只留亮色块，位置感交给紫环。 */
.bzf-seg.bzf-sel.bzf-none { opacity: 1; }
.bzf-seg.bzf-sel.bzf-none .bzf-seg-hd { box-shadow: none; }
.bzf-seg.bzf-sel.bzf-nolatent { background-image: none; }
/* 选中态下的「待生成」占位（20261010 补）：占位文字的颜色是本段亮色
   （--bz-seg-ph 由 JS 写入），选中后块底换成同一个亮色 —— 亮底亮字，
   「待生成」三个字直接糊掉。选中时换成深字 + 深斜纹，占位在亮块上照样
   读得清。 */
.bzf-seg.bzf-sel .bzf-ph {
  color: #141414d9;
  background: repeating-linear-gradient(135deg, #00000014 0 6px, transparent 6px 12px);
}
.bzf-seg.bzf-sel .bzf-ph .bzf-ph-sub { color: #141414a0; }
/* 跳过（不参与渲染）= 整块灰化降透 + 右上角文字角标。
   与「没成片」（.bzf-none 只管压 opacity）刻意分开：这里**同时去饱和**，
   还带一句明确文字 —— 扫一眼就知道是"故意不要这一段"，不是"还没跑"。
   段块总高 72px（头 20px + 画面 52px），角标放得下，不会盖住画面主体。
   **压暗只压色头与画面两个子块，不压 .bzf-seg 本体**：opacity/filter 会
   连带把 ::before 那个角标一起变淡，角标就白写了。 */
.bzf-seg.bzf-skip .bzf-seg-hd,
.bzf-seg.bzf-skip .bzf-seg-bd { opacity: .34; filter: grayscale(.9); }
.bzf-seg.bzf-skip::before {
  content: "已跳过"; position: absolute; top: 2px; right: 3px; z-index: 3;
  font-size: 10px; line-height: 13px; padding: 0 4px; border-radius: 3px;
  background: #000000c4; color: #dcdcdc; letter-spacing: .5px;
  border: 1px solid #ffffff2e; pointer-events: none;
}
/* 跳过的段被选中时，压暗让开一半：选中的是哪一段比"它被跳过"更要紧，
   但这条信息也不能丢 —— 点进去才发现是跳过的，才最坑。 */
.bzf-seg.bzf-sel.bzf-skip .bzf-seg-hd,
.bzf-seg.bzf-sel.bzf-skip .bzf-seg-bd { opacity: .62; filter: grayscale(.5); }
/* 待办的琥珀圆点与角标抢同一个右上角：跳过时它已无意义（跳过就不跑），让开。 */
.bzf-seg.bzf-skip.bzf-pend::after { display: none; }

/* ===== 段块接缝：一条低调边界竖线（不挡缩略图）；交互节点移到上方标尺 ===== */
.bzf-seam {
  position: absolute; top: 0; bottom: 0; width: 2px; z-index: 2;
  pointer-events: auto; cursor: pointer; background: #00000070;
}
.bzf-seam.bzf-tr-link { background: linear-gradient(180deg, #58d1ff55, #00000070); }
.bzf-seam.bzf-tr-cut { background: #00000085; }
.bzf-seam.bzf-tr-unlink {
  width: 3px;
  background: repeating-linear-gradient(180deg, #e05a5a 0 4px, transparent 4px 8px);
}
.bzf-seam:hover { width: 4px; }
/* 拖动改时长 / 拖排序过程中接缝先藏起来：它记的是旧边界，实时预览留在原地
   反而误导，松手刷新后按新边界重画。 */
.bzf-band.bzf-resizing .bzf-seam,
.bzf-band.bzf-reordering .bzf-seam { display: none; }
/* 「跳」这一档加个闪，别让人一眼扫过去没看见 */
.bzf-seam-bad { animation: bzf-seampulse 1.6s ease-in-out infinite; }
@keyframes bzf-seampulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

/* ===== 标尺接缝节点：菱形 marker + 重叠帧数，骑在边界刻度上，不碰画面 ===== */
/* 热区扩大（20261011）：挂 band、38×34 的点击/右键热区，◆ 视觉仍在 ruler 中心，
   热区向下覆到段块标题栏 —— 右键不必精确对准 9px 菱形（旧 ruler 16px 高、热区
   仅约 30×9，稍偏就点空，表现为"右键没反应"）。 */
.bzf-rseam {
  position: absolute; top: 0; left: 0; z-index: 8;
  width: 38px; height: 34px;
  display: flex; align-items: flex-start; justify-content: center; gap: 2px;
  white-space: nowrap; transform: translateX(-50%); cursor: pointer;
}
.bzf-rseam .rs-d {
  width: 9px; height: 9px; flex: 0 0 auto; box-sizing: border-box;
  margin-top: 3.5px;
  transform: rotate(45deg); border-radius: 2px;
  border: 1px solid #ffffff45; background: #16161b;
}
.bzf-rseam .rs-n {
  font-style: normal; font-size: 8px; line-height: 1; font-weight: 600;
  margin-top: 4.5px;
  color: #9fb6c2; font-variant-numeric: tabular-nums;
}
.bzf-rseam.is-link .rs-d { border-color: #58d1ffcc; background: #58d1ff22; }
.bzf-rseam.is-link .rs-n { color: #8fd8f5; }
.bzf-rseam.is-cut .rs-d { width: 7px; height: 7px; border-color: #ffffff38; }
.bzf-rseam.is-unlink .rs-d { border-color: #e05a5a; background: #e05a5a33; }
.bzf-rseam.is-bad .rs-d { border-color: #e8a13a; }
.bzf-rseam.is-bad { animation: bzf-seampulse 1.6s ease-in-out infinite; }
.bzf-rseam:hover .rs-d {
  background: var(--bz-accent); border-color: var(--bz-accent);
  box-shadow: 0 0 6px var(--bz-accent);
}
.bzf-rseam.is-unlink:hover .rs-d {
  background: #e05a5a; border-color: #e05a5a; box-shadow: 0 0 6px #e05a5a;
}
/* 重叠区：接缝两侧半透明区（链接且有重叠帧） */
.bzf-overlap { position: absolute; top: 0; bottom: 0; z-index: 1; pointer-events: none; }
.bzf-overlap.bzf-ov-overlap {
  background: linear-gradient(90deg, transparent, #ffffff24, transparent);
}
/* 接缝卡浮层 */
.bzf-trcard {
  position: fixed; z-index: 100000; min-width: 198px;
  background: #1b1b1f; border: 1px solid #ffffff24; border-radius: 12px;
  box-shadow: 0 20px 48px #000cc, 0 0 0 1px #00000080;
  padding: 10px; font-size: 12px; color: #e9e9ee;
}
.bzf-trcard .bzf-trc-title {
  font-size: 11px; color: #9a9aa2; padding: 0 2px 8px;
  display: flex; justify-content: space-between; align-items: center;
}
.bzf-trcard .bzf-trc-ov { padding: 2px 0 8px; }
.bzf-trcard .bzf-trc-ov-h {
  font-size: 10.5px; color: #c8c8ce;
  display: flex; justify-content: space-between; align-items: center;
}
.bzf-trcard .bzf-trc-ovhint { font-size: 10px; color: #8a8a92; margin-top: 4px; }
/* 承接帧数：步进 − / 输入 / ＋ 一行 */
.bzf-trcard .bzf-trc-frames { display: flex; align-items: stretch; gap: 6px; margin-top: 6px; }
.bzf-trcard .bzf-trc-frames button {
  flex: 0 0 auto; width: 26px; padding: 0; cursor: pointer;
  border-radius: 7px; border: 1px solid #3d3d43; background: #2c2c31;
  color: #d6d6dc; font-size: 14px; line-height: 1;
}
.bzf-trcard .bzf-trc-frames button:hover:not(:disabled) { background: #36363d; }
.bzf-trcard .bzf-trc-frames input {
  flex: 1 1 auto; min-width: 0; text-align: center;
  background: #1c1c20; color: #ececf0; border: 1px solid #3d3d43;
  border-radius: 7px; padding: 4px 6px; font: inherit; font-size: 11.5px;
}
.bzf-trcard .bzf-trc-frames input:focus {
  border-color: color-mix(in srgb, var(--bz-accent) 55%, transparent); outline: none;
}
.bzf-trcard .bzf-trc-frames button:disabled,
.bzf-trcard .bzf-trc-frames input:disabled { opacity: .4; cursor: default; }
/* 常用档位 chips */
.bzf-trcard .bzf-trc-chips { display: flex; gap: 6px; margin-top: 6px; }
.bzf-trcard .bzf-trc-chips button {
  flex: 1 1 0; padding: 4px 0; cursor: pointer;
  border-radius: 7px; border: 1px solid #3d3d43; background: #2c2c31;
  color: #c4c4cc; font-size: 11px;
}
.bzf-trcard .bzf-trc-chips button:hover:not(:disabled) { background: #36363d; }
.bzf-trcard .bzf-trc-chips button[aria-selected="true"] {
  border-color: color-mix(in srgb, var(--bz-accent) 60%, transparent);
  background: color-mix(in srgb, var(--bz-accent) 18%, transparent);
  color: #eaf6f8;
}
.bzf-trcard .bzf-trc-chips button:disabled { opacity: .4; cursor: default; }
/* 断链开关：全宽按钮 */
.bzf-trcard button.bzf-trc-toggle {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--bz-accent) 35%, transparent);
  background: color-mix(in srgb, var(--bz-accent) 14%, transparent);
  color: #dfe6e8; font-size: 10.5px; text-align: left;
}
.bzf-trcard button.bzf-trc-toggle svg {
  width: 16px; height: 16px; flex: 0 0 auto; color: var(--bz-accent);
}
.bzf-trcard button.bzf-trc-toggle:hover {
  background: color-mix(in srgb, var(--bz-accent) 22%, transparent);
}
.bzf-trcard button.bzf-trc-toggle.is-unlink {
  border-color: #e05a5a66; background: #e05a5a18; color: #f0c4c4;
}
.bzf-trcard button.bzf-trc-toggle.is-unlink svg { color: #e07a7a; }
.bzf-trcard .bzf-trc-score {
  font-size: 10px; margin-top: 8px; color: #9a9aa2; line-height: 1.5;
}

/* 改时长的把手：只在宿主允许时（导演台）才出现，续接合成那边不给拖 */
/* 拖动手柄。常态必须**看得见** —— 原来是 #ffffff14（8% 白），压在深蓝段落块
   上几乎等于没有，用户根本不知道这里能拖。抬到 ~18% 并加一条竖虚线脊：一眼
   是个"把手"，又不至于抢走段落块本身的信息（段号、待办点、接缝都在这条上）。
   鼠标移到整段上时再亮一档，让人不用精确命中 7px 就能发现这里可拖。 */
.bzf-grip {
  position: absolute; top: 0; bottom: 0; right: 0; width: 7px;
  cursor: ew-resize; z-index: 2; background: #ffffff2e;
  border-left: 1px solid #0005;
}
.bzf-grip::before {
  content: ""; position: absolute; top: 3px; bottom: 3px; left: 2px; width: 3px;
  border-left: 1px dotted #00000070;
}
.bzf-seg:hover .bzf-grip { background: #ffffff4d; }
.bzf-grip:hover { background: var(--bz-accent); }

/* ---- 拖动排序 ----
   能拖的时候段块是"可以搬动的东西"：手型光标就是那句"拖我"。拖动中，被拖的
   那一块要**跟手**（不加过渡，否则一顿一顿地追指针），其余各段让位要**平滑**
   （加过渡，读起来才是"腾出空档"，而不是"跳一下"）。
   只过渡 transform：left / width 是每次重排后按比例重算的，给它们加过渡会
   让整条轴在刷新时慢慢爬过去，看着像卡住。 */
.bzf-seg { transition: transform .13s ease; }
/* 拖动改时长（bzf-resizing）期间必须把这条过渡关掉：否则后续段的让位是
   "缓动追赶"指针，一顿一顿 —— 拖接缝卡顿的直接原因（20261013：接缝重构
   时这条规则丢了，startResize 的注释还写着它应该存在）。 */
.bzf-band.bzf-resizing .bzf-seg { transition: none; }
.bzf-segs.bzf-sortable .bzf-seg { cursor: pointer; }
.bzf-segs.bzf-sortable .bzf-seg.bzf-press { filter:brightness(1.07); }
/* 被拖起来的那一块：抬到最上层 + 紫环 + 投影，"手里拿着它"这件事要说清。
   写在 .bzf-sel / .bzf-press 之后 —— 同权重下后者会被它覆盖，而拖动时的
   "拿着"比"选中"更应该说话。 */
.bzf-seg.bzf-drag-lift {
  z-index: 5; cursor: grabbing; transition: none;
  box-shadow: inset 0 0 0 2px var(--bz-violet), 0 10px 22px #000c,
    0 0 14px 2px var(--bz-violet-dim);
}
/* 拖动期间接缝的位置也过期了（它记的是拖动前的边界），先藏起来，重排后再画 */
.bzf-band.bzf-reordering .bzf-seam { display: none; }
@media (prefers-reduced-motion: reduce) {
  .bzf-seg { transition: none; }
}
.bzf-tip {
  position: absolute; top: -1px; padding: 1px 5px; border-radius: 3px;
  background: #000d; color: var(--bz-accent); font-size: 10.5px;
  pointer-events: none; white-space: nowrap; z-index: 4; transform: translateX(-50%);
}
/* 还没有成片的段。原先整块换成灰斜纹（而且那条 background 被行内的段色覆盖，
   本来就没生效）—— 后果是新建的段全是一片灰，跟时间轴底色差不多，用户根本
   找不到自己刚加的那一段。
   现在保留它自己那一色，只压暗 + 套一圈虚线：既有颜色可认，又一眼看出"这段
   还没拍"。 */
.bzf-seg.bzf-none {
  opacity: .78;
}
/* 同上：这圈白环是说「这段还没拍」，不是「这段被选中」。原来 35% 白在暗色块
   上很跳，压到 10% —— 淡到不抢戏，但仍看得出比已生成的段虚一点。 */
.bzf-seg.bzf-none .bzf-seg-hd {
  box-shadow: inset 0 0 0 1px #ffffff1a;
}
/* 合并进段块后，全宽黑色 film 条隐藏；缩略图改画在各段 .bzf-seg-bd 内。 */
.bzf-film { display: none !important; height: 0 !important; overflow: hidden !important; border: 0 !important; padding: 0 !important; margin: 0 !important; }
.bzf-film-kept { position: relative; height: 56px; overflow: hidden; background: #0d0d0d; }
/* 段块画面：一张雪碧图（横向拼起来的整段画面带）。
   20261024 晚「胶条化」：**不再 object-fit 硬拉** —— 拼图是 6:1 上下的扁长条、
   块体却接近 10:1，fill 会把每格纵向拉伸近 3 倍（发虚发扁的根因）。现在尺寸由
   spriteInto/fitStrip 按拼图 naturalWidth/Height 显式算（等比、只缩不放），
   CSS 这边只负责「加载前占位 + 渐显」。格间那条 1px 缝是后端 SPRITE_GAP 直接
   拼进图里的，不占 DOM。 */
.bzf-thumb-img { position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; opacity: 0;
  transition: opacity .18s linear; }
.bzf-thumb-img.bzf-ok { opacity: 1; }
/* 降级通道用的小格（后端还没有 /sprite 时，退回逐张 /thumb）：
   几张各占一段宽度并排，拼出一条粗画面带。格内用 cover —— 单张被裁一点
   比拉伸变形好看；整条带用 fill（不裁两侧）。 */
.bzf-thumb-img.bzf-thumb-tile { right: auto; object-fit: cover; }
.bzf-wave {
  /* 成片自带音轨：视频段块正下方，画这一段成片里自己的声音波形。
     与下方 bzsa 参考音轨是两回事 —— 这条永远是「已生成视频的声音」。 */
  display: block;
  position: relative; height: 32px; overflow: visible;
  border-top: 1px solid var(--bz-line);
}
/* 音频轴：波形底下先铺一层按段着色的音频占位块（与上排段块同色同跨度），
   选中段的波形再叠画在上面 —— 上下两排颜色对得上，一眼看出哪段对哪段。
   20261010 重做观感：上下各留 2px 呼吸边 + 圆角，块读成"音频片段"而不是
   一根通长色条；当前段亮色 + 紫环，跟上层选中态同一个信号。 */
.bzf-wave-segs { position: absolute; inset: 0; overflow: visible; }
.bzf-wave-segs div {
  position: absolute; top: 2px; bottom: 2px; overflow: hidden;
  border-radius: 3px; box-sizing: border-box;
  border-right: 1px solid #0007;
  box-shadow: inset 0 0 0 1px #ffffff14;
}
.bzf-wave-segs div.bzf-wcur {
  box-shadow: inset 0 0 0 1px var(--bz-violet, #a97bff), 0 0 6px #a97bff40;
}
.bzf-wave-mute {
  /* 热区铺满左侧 26px 轨道头列，20px 小图标点不中、又和下方音轨的
     喇叭紧挨着，用户点了没反应就会以为「一直置灰」。视觉仍是一颗小图标。 */
  position: absolute; left: -26px; top: 0; width: 26px; height: 32px;
  padding: 0; border: none; border-radius: 6px; background: transparent;
  color: #e6e6ea; font-size: 12px; line-height: 32px; text-align: center;
  cursor: pointer; z-index: 4;
}
.bzf-wave-mute:hover { background: #ffffff14; }
.bzf-wave-mute[data-off="1"] { color: #e24b4a; background: #e24b4a1f; }
/* 静音时整条成片音轨置灰：按钮之外还要有看得见的「这一行没声音」反馈。 */
.bzf-wave[data-muted="1"] .bzf-wave-segs,
.bzf-wave[data-muted="1"] canvas { filter: grayscale(1); opacity: .35; }
/* 整行都是静音热区；「已静音」标签让状态不靠猜波形颜色。 */
.bzf-wave { cursor: pointer; }
.bzf-wave-flag { position: absolute; left: 4px; top: 2px; z-index: 3;
  font-size: 10px; line-height: 14px; color: #e24b4a;
  background: #000000a8; border-radius: 4px; padding: 0 4px; pointer-events: none; }
.bzf-wave canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bzf-play {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--bz-over); pointer-events: none; z-index: 3;
  box-shadow: 0 0 6px #e24b4a99;
  /* 常驻合成层（根因修复）：搓播放头时 transform 每帧改，同时视频 seek/波形在
     主线程抢资源；不提升就会被长任务吞帧、竖线"停下才动"。will-change 让
     translateX 走 GPU 合成器，主线程再忙竖线也逐帧跟手 —— 剪辑软件的播放头
     竖线本就是合成层，跟手零成本，画面帧可以略慢、竖线不能慢。 */
  will-change: transform;
}
.bzf-play::before {
  content: ""; position: absolute; top: 0; left: -4px; width: 10px; height: 6px;
  background: var(--bz-over); border-radius: 2px;
}
/* 搓动时间码气泡：挂在播放头顶部，平时隐藏，搓动（is-scrub）才出现；
   上行时间码、下行帧号，等宽数字不跳动。 */
.bzf-ptip {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  display: none; flex-direction: column; align-items: center; gap: 1px;
  padding: 4px 8px; min-width: 58px;
  background: rgba(18,18,20,.92); border: 1px solid rgba(255,255,255,.12);
  border-radius: 7px; box-shadow: 0 6px 18px rgba(0,0,0,.45);
  white-space: nowrap; pointer-events: none; z-index: 6;
}
.bzf-ptip b { font-size: 11px; font-weight: 600; color: #f0f0f2;
  font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.bzf-ptip span { font-size: 9px; color: #9a9aa0; font-variant-numeric: tabular-nums; }
.bzf-play.is-scrub .bzf-ptip { display: flex; }
/* 吸附引导线：拖段块边缘/排序时，吸附到 H3 网格点就亮一条青色竖线，让人看见
   "松手会落到这里"。青色 = 生成区语义（对方青色选区同源），与红色播放头区分。 */
.bzf-snap {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--bz-accent); pointer-events: none; z-index: 4;
  box-shadow: 0 0 6px #58d1ff99;
}

/* ---- 状态行 ---- */
.bzf-foot {
  display: flex; align-items: center; gap: 10px; flex: none; min-width: 0;
  font-size: 11px; color: var(--bz-dim); white-space: nowrap; overflow: hidden;
}
.bzf-foot .bzf-warn { color: #f0c674; }
/* 当前段帧数精确输入：剪辑软件里"拖个大概 + 敲个准数"的第二种方式。
   拖边缘改的是大概，这里改的是准数 —— 两者共用同一条 onResize 落库。 */
.bzf-frames-wrap { margin-left: auto; display: flex; align-items: center; gap: 4px; }
/* 特异性要压过导演台的 .gcast input[type=number]（foot 被外挂进 .gcast 容器，
   不然会被它的 62px 宽 / 4px 内边距撑成一个大框，和前后 11px 的文字不搭）。 */
.gcast .bzf-foot input.bzf-frames, .bzf-frames {
  width: 52px; min-height: 0; background: #00000040; color: inherit;
  border: 1px solid var(--bz-line); border-radius: 4px;
  padding: 1px 5px; font-family: inherit; font-size: 11px; line-height: 1.4;
  text-align: right;
}
.bzf-frames:disabled { opacity: .4; }

/* ---- 时间轴外挂宿主（v7 式布局）----
   .bzf-band/.bzf-foot 被 append 到调用方的容器时，它们脱离了 .bzfilm，
   上面定义的 --bz-* 变量全部失联 —— 在宿主上重新声明同一套变量，
   时间轴的配色、波形绿、播放头强调色才不会退化成 initial。 */
.bzf-lanes {
  --bz-bg:#191919; --bz-panel:#212121; --bz-raise:#2b2b2b; --bz-line:#3b3b3b;
  --bz-well:#131313;
  --bz-txt:#e3e3e3; --bz-dim:#979797;
  --bz-accent:#58d1ff; --bz-accent-dim:#58d1ff26;
  --bz-violet:${CUR_SEG}; --bz-violet-dim:${CUR_SEG_DIM};
  --bz-over:#e24b4a; --bz-wave:#59c14f;
  color: var(--bz-txt); font-size: 12px; line-height: 1.35;
  pointer-events: auto; position: relative; width: 100%; min-width: 0;
  display: flex; flex-direction: column; gap: 6px;
  user-select: none; -webkit-user-select: none;
}
.bzf-lanes * { box-sizing: border-box; }
/* 收起监视器只收取景器：外挂的时间轴照常可见（与 v7 一致）。
   时间轴在 .bzfilm 之外，下面第一条本来就匹配不到；留着是为
   「没传 timelineHost」的兜底路径保住原行为。 */
.bzfilm.bzf-collapsed .bzf-band,
.bzfilm.bzf-collapsed .bzf-foot { display: none; }

/* ---- 悬浮态 ---- */
.bzfilm.bzf-float {
  position: fixed !important; z-index: 1200; width: 660px; height: 520px;
  box-shadow: 0 18px 60px #000b, 0 0 0 1px var(--bz-accent-dim);
  padding: 8px;
}
.bzfilm.bzf-float .bzf-bar { cursor: grab; }
.bzfilm.bzf-float.bzf-drag .bzf-bar { cursor: grabbing; }
.bzf-slot {
  flex: none; height: 132px; border: 1px dashed var(--bz-line); border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  color: var(--bz-dim); font-size: 11px; background: #ffffff08;
}
/* 缩放把手：只在悬浮态出现（内嵌时节点自己在管大小，插手会和框架打架） */
.bzf-rsz { display: none; }
.bzfilm.bzf-float .bzf-rsz {
  display: block; position: absolute; right: 0; bottom: 0;
  width: 16px; height: 16px; cursor: nwse-resize; z-index: 6;
}
.bzfilm.bzf-float .bzf-rsz::before {
  content: ""; position: absolute; right: 3px; bottom: 3px;
  width: 8px; height: 8px; border-right: 2px solid var(--bz-dim);
  border-bottom: 2px solid var(--bz-dim); border-radius: 0 0 2px 0;
}
.bzfilm.bzf-float .bzf-rsz:hover::before { border-color: var(--bz-accent); }
/* 不要让 foot 顶到把手上：悬浮时给底部留点空 */
.bzfilm.bzf-float .bzf-foot { padding-right: 18px; }
`;

function injectCSS() {
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement("style");
  s.id = CSS_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/* 时间轴左侧留白（像素）：只放一个小小的静音按钮，时间轴 0 帧从它右边开始。
   CSS 的 .bzf-track margin-left / .bzsa-row 的 26px 列必须与这里同值。 */
const TRACK_GUTTER = 26;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* 时间码。统一 mm:ss.cc（如 01:04.20）—— 剪辑时看的是"几分几秒第几帧"。
   底栏的「当前位置 / 全片时长」两个数必须同一种写法，位置是 31.40 秒、全长是
   64.20 秒时，若位置写成 "31.40s"、全长写成 "01:04.20"，一眼对不上（"s" 和
   "分:秒" 是两套刻度）。所以这里始终给 mm:ss.cc，秒数不足一分钟也补 00:。 */
function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}

/** 取一个后端 JSON；失败就抛，调用方决定怎么显示。 */
async function getJSON(url) {
  const res = await api.fetchApi(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * 建一个成片监视器。
 *
 * @param {object} opts
 *   getName()       -> 片名（导演台工程名）。返回空串表示还没登记过片子。
 *   onPick(clip)    选中某段时回调（宿主拿它去联动文案台 / 媒体架）。
 *   onMode(mode)    三态切换时回调（宿主拿它去调节点尺寸）。
 *   canResize(clip) 这一段能不能拖边缘改时长（返回真才会出现把手）。
 *                   续接合成改不了段落时长，所以那边不传 —— 摆个能拖的把手就是骗人。
 *   onResize(clip, frames)  拖完提交。宿主负责调后端，本组件只管随后刷新。
 *   onReorder(ids)  轴上把某一段拖到别处、松手时调一次，参数是重排后的
 *                   clip id 全表（只含已有的 id，一段不多一段不少）。
 *                   不传就没有拖动排序 —— 纯检视 / 只读的时间轴用不着它，
 *                   拖不出东西也不会换个光标骗人。
 *   canReorder()    此刻能不能拖。返回假则段块按老规矩：在轴上按下就是搓动。
 *                   渲染中要禁拖（顺序变了会和正在跑的链对不上），所以做成
 *                   每次按下时现问，而不是建组件时问一次。
 *   mode            初始态："inline" | "collapsed" | "floating"
 *   title           标题文字
 */
export function createFilmMonitor(opts = {}) {
  /* 版本标记（20261010bj）：改动都在时间轴/监视器这一侧，导演台那个 build
     号看不出有没有刷到。Ctrl+F5 之后在控制台认这一行。只打一次——同一页里
     可能有好几个宿主共用这个组件。 */
  if (!createFilmMonitor._logged) {
    createFilmMonitor._logged = true;
    console.info(
      "[H3 Studio] 成片时间轴/监视器 · build 20261011-realtime（拖动实时预览：最新目标合并、呈现后续 seek、冷缓存不转码）"
      + "：换源是**异步**的（select 先同步改 st.cur，再花几百毫秒去 /info、可能还要"
      + "现场生成播放版），那段时间里 st.cur 已经是新段、video 里还装着旧片 —— 旧代码"
      + "拿新段的坐标系去 seek 旧片，秒数是照另一条片子算的，而正着拖和反着拖撞上的"
      + "旧片不是同一条，于是同一个播放头位置出现两个画面；换源落地那一刻还会硬跳一次，"
      + "读作「接缝闪烁」。现在 seek 与播放头回写一律认 **loadedId**（元素里真正装着的那"
      + "一段），身份在 src 赋值那一行同步落定（不挂 loadeddata —— 那个事件在浏览器里不"
      + "保证来，押上去一次不来整个监视器就冻住）。换源调度从 250ms 节流改成串行 + 尾补："
      + "节流吞掉的那一次没有补冲，来向不同就吞掉不同的那一次，最终停在哪一段成了路径"
      + "依赖 —— 这是不一致的另一半。拖动中不抽垫图（一次抽帧 70~1100ms，乱序回来的那张"
      + "会把画面垫成上一个目标的帧，接缝附近一路乱闪）。松手这一下也拆成两件事：换不换"
      + "源认 loadedId，要不要通知宿主认 st.cur —— 合成一档时，一段成片都没有的工程里每"
      + "次松手都空放一次 onPick，播放头压在段末尾那一帧还会被归位逻辑拨回段首。"
      + "本版修「保存的成片接缝还好、时间轴里却跳」：量下来两边接的是**同一批帧**（接缝那一"
      + "跨的画面差都是 4.8/255 ≈ 1.9%，肉眼基本无感），差别在**怎么接** —— 成片是一条 mp4、"
      + "只跨一个帧边界；时间轴要换源，而换源是一段路程：ended → 服务端抽垫图（70~1100ms）→"
      + " /info（首次还要现生成播放版 1~2s）→ 换 src → 等第一帧。这期间 video 已被藏起、屏幕"
      + "上挂的还是**上一段的中段垫图**，于是一道接缝要跳三下（上一段末帧 → 上一段中段 → 下"
      + "一段中段 → 下一段首帧）。现在连播接段先把**此刻这一帧**就地定格（canvas，零请求）、"
      + "禁止抽新垫图，并提前 4 秒把下一段预载好（/info 顺带把播放版生成出来）：接缝只剩一次"
      + "换画，与成片同构。本版再补一刀「接缝黑一帧」（20261010bo）：定格是先把 data: 图塞给"
      + "垫图层再收视频 —— img 换 src 后要重新解码，那一瞬屏幕上是个还没解码出来的空图，跳没"
      + "了却换成闪黑。现在顺序反过来：上一段最后一帧**保持到定格图真的画出来**（img load）才"
      + "换层，解码失败才退回收视频的老路。还不够 —— 给 video 换 src 的那一瞬间旧帧"
      + "**立刻消失**，而定格图（刚生成的 data: 图）还要解码，/info 往返却常常更快，于是"
      + "仍然空一帧黑。本版把顺序钉死：**定格图没画出来，不许换 src**（frzReady），并让垫图"
      + "多盖两帧再撤（第一帧真正上屏还要一个合成周期）。续接合成那个面板不闪是因为它用两条"
      + "video 轮流（下一条在暗处加载好再换可见性），单 video 只能靠这个顺序补。");
  }
  injectCSS();

  const root = document.createElement("div");
  root.className = "bzfilm";
  root.innerHTML = `
    <div class="bzf-bar">
      <span class="bzf-title">${esc(opts.title || "成片监视器")}</span>
      <span class="bzf-meta">—</span>
      <span class="bzf-sp"></span>
      <span class="bzf-tools"></span>
    </div>
    <div class="bzf-view" title="点击播放整片（从当前段起，一段接一段播到最后一个有成片的段）；播放中再点一次暂停">
      <video class="bzf-va" playsinline preload="metadata"></video>
      <video class="bzf-vb" playsinline preload="metadata"></video>
      <img alt="">
      <canvas class="bzf-freeze"></canvas>
      <div class="bzf-badge" style="display:none"></div>
      <div class="bzf-cap">—</div>
      <div class="bzf-center">
        <div class="bzf-cstatus">还没有成片 —— 先接出第一段并渲染</div>
      </div>
    </div>
    <div class="bzf-band">
      <div class="bzf-track">
        <div class="bzf-ruler"></div>
        <div class="bzf-segs"></div>
        <div class="bzf-cutlayer" aria-hidden="true">
          <div class="bzf-cutline"><span class="bzf-cuttip"></span></div>
        </div>
        <div class="bzf-film"></div>
        <div class="bzf-wave">
          <div class="bzf-wave-segs"></div>
          <canvas></canvas>
          <button class="bzf-wave-mute" title="关闭成片声音（再点恢复）">🔊</button>
        </div>
        <div class="bzf-play" style="display:none"><div class="bzf-ptip"></div></div>
        <div class="bzf-snap" style="display:none"></div>
      </div>
    </div>
    <div class="bzf-foot">
      <span class="bzf-where">—</span>
      <span class="bzf-stat">—</span>
      <label class="bzf-frames-wrap">当前段净长 <input class="bzf-frames" type="number" min="5" max="719" step="1"> 帧</label>
    </div>
    <div class="bzf-rsz" title="拖动改变悬浮窗大小"></div>
  `;

  const el = {
    tools: root.querySelector(".bzf-tools"),
    meta: root.querySelector(".bzf-meta"),
    view: root.querySelector(".bzf-view"),
    videoA: root.querySelector(".bzf-view video.bzf-va"),
    videoB: root.querySelector(".bzf-view video.bzf-vb"),
    img: root.querySelector(".bzf-view img"),
    freeze: root.querySelector(".bzf-view canvas.bzf-freeze"),
    badge: root.querySelector(".bzf-badge"),
    cap: root.querySelector(".bzf-cap"),
    center: root.querySelector(".bzf-center"),
    cstatus: root.querySelector(".bzf-cstatus"),
    band: root.querySelector(".bzf-band"),
    track: root.querySelector(".bzf-track"),
    ruler: root.querySelector(".bzf-ruler"),
    segs: root.querySelector(".bzf-segs"),
    cutlayer: root.querySelector(".bzf-cutlayer"),
    cutline: root.querySelector(".bzf-cutline"),
    cuttip: root.querySelector(".bzf-cuttip"),
    film: root.querySelector(".bzf-film"),
    waveSegs: root.querySelector(".bzf-wave-segs"),
    canvas: root.querySelector(".bzf-wave canvas"),
    play: root.querySelector(".bzf-play"),
    ptip: root.querySelector(".bzf-ptip"),
    snap: root.querySelector(".bzf-snap"),
    where: root.querySelector(".bzf-where"),
    stat: root.querySelector(".bzf-stat"),
    frames: root.querySelector(".bzf-frames"),
  };
  /* 成片音轨静音：只管预览播放出不出声，不改生成结果。
     不跨会话记忆 —— 上次点过静音，下次打开就莫名一直灰。 */
  let audioMuted = false;
  const waveMute = root.querySelector(".bzf-wave-mute");
  function paintWaveMute() {
    if (waveMute) {
      waveMute.textContent = audioMuted ? "🔇" : "🔊";
      waveMute.dataset.off = audioMuted ? "1" : "0";
      waveMute.title = audioMuted ? "成片声音已关闭：点一下恢复" : "关闭成片声音（再点恢复）";
    }
    /* 置灰不靠 dataset + 属性选择器：重绘后 dataset 可能被冲掉，
       直接把样式写进波形元素，谁重建都盖不住。 */
    root.querySelectorAll(".bzf-wave").forEach((wv) => {
      wv.dataset.muted = audioMuted ? "1" : "0";
      wv.title = audioMuted
        ? "成片自带音轨：已静音 —— 点这一行任意处恢复"
        : "成片自带音轨：有声 —— 点这一行任意处静音";
      wv.querySelectorAll("canvas, .bzf-wave-segs").forEach((n) => {
        n.style.filter = audioMuted ? "grayscale(1)" : "";
        n.style.opacity = audioMuted ? "0.35" : "";
      });
      let flag = wv.querySelector(".bzf-wave-flag");
      if (audioMuted) {
        if (!flag) {
          flag = document.createElement("span");
          flag.className = "bzf-wave-flag";
          wv.appendChild(flag);
        }
        flag.textContent = "已静音";
      } else if (flag) flag.remove();
    });
    if (el.video) el.video.muted = audioMuted;
    /* 监视器是 A/B 双缓冲，正在出声的未必是 getter 当前指向的那一个。 */
    root.querySelectorAll("video").forEach((v) => { v.muted = audioMuted; });
  }
  function toggleWaveMute() {
    audioMuted = !audioMuted;
    paintWaveMute();
  }
  if (waveMute) waveMute.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWaveMute();
  });
  /* 26px 小按钮和下方参考音轨的喇叭挨着，很容易点空 —— 整条成片音轨
     都是热区，点波形任意处也能切；拖播放头不算点击。 */
  let waveDownX = 0;
  root.querySelectorAll(".bzf-wave").forEach((wv) => {
    wv.addEventListener("pointerdown", (e) => { waveDownX = e.clientX || 0; });
    wv.addEventListener("click", (e) => {
      if (Math.abs((e.clientX || 0) - waveDownX) > 4) return;
      if (e.target.closest(".bzf-wave-mute")) return;
      e.stopPropagation();
      toggleWaveMute();
    });
  });
  paintWaveMute();

  /* 音频轴：外部模块自建两行（轨道头 + 按段波形），挂在现有 .bzf-wave 下方。
     挂载失败不许影响时间轴本身。 */
  let audioLaneApi = null;
  try {
    audioLaneApi = mountAudioLane({
      wave: el.waveSegs && el.waveSegs.parentElement,
      /* 块的坐标只认时间轴这把尺子（pxOf/wOf）：与段块同一个原点、同一比例。 */
      pxOf: xOfFrame,
      wOf: wOfFrames,
      getName: opts.getName,
      /* 建段入口由导演台注入：音频轴不再自己 POST add_clip（那会只写档案）。 */
      addShot: opts.onAddShot,
      /* 工程对象里的段数：排段前跟档案段数比一次，两边对不上先拦下。 */
      shotCount: opts.getShotCount,
      /* 排段后把新帧数写齐每段的面板预设，避免下次渲染拿旧 length 覆盖档案。 */
      syncShotFrames: opts.syncShotFrames,
      /* 新拖入的附加音轨默认只作用在「当前选中段」（时间轴驱动场景）。
         st 在下面才初始化，箭头函数延迟到拖入时才读，不会踩 TDZ。 */
      getCurClip: () => String((st && st.cur) || ""),
      /* 音频模式（有无主音轨）翻转 → 宿主重渲染设置面板「时长」（方案 B）。 */
      onAudioModeChange: opts.onAudioModeChange,
      /* 选中轨变化 → 宿主更新 ✂ 按钮可用态（没选中就置灰）。 */
      onSelectChange: opts.onAudioSelectChange,
    });
  } catch (e) {
    console.warn("[audio-lane] 挂载失败:", e);
  }

  /* ---- 双缓冲（方案B/M2）：取景框里常驻两条 video，A/B 乒乓。 ----
     activeIsA 标记当前"在播/可见"的是哪一条；el.video 做成 getter，于是全文件
     几十处 el.video.xxx 无需改动，始终指向当前在播的那一条。另一条（standby）
     在暗处提前装好下一段并解出首帧，接缝时只切可见性、不换源 → 无解码空窗、
     不闪黑。 */
  let activeIsA = true;
  Object.defineProperty(el, "video", {
    get() { return activeIsA ? el.videoA : el.videoB; },
    configurable: true,
  });
  const standbyEl = () => (activeIsA ? el.videoB : el.videoA);

  /* 整片预览模式（20261011 根治接缝闪黑）：连播 / 跨段拖动改播后端拼好的【一条】
     整片连续片（固定 videoA），帧映射 f→f/fps 线性、无跨 video 交接；明确选段
     编辑（select）自动退出本模式。 */
  let wholeMode = false;
  let wholeInfo = null;
  let wholeWant = -1;
  let wholeReveal = false;       /* 换整片源后，只在目标帧就位时撤冻结层 */
  let wholePrepareToken = 0;
  let wholeChecked = false;      /* 每次拖动最多查询一次已有整片缓存，不触发转码 */

  /* 时间轴外挂（v7 式布局）：调用方给 timelineHost 时，把 .bzf-band（分段轨 +
     波形 + 播放头）与 .bzf-foot（时间码）移挂到那个外部容器 —— 让时间轴横贯
     整个节点宽度，不受监视器宽度约束（监视器收起或拖出悬浮时时间轴仍常驻）。
     元素在创建时已被 querySelector 抓住引用，移动 DOM 位置不影响任何逻辑；
     但 CSS 变量定义在 .bzfilm 上，移出去会丢 —— 所以给宿主补 bzf-lanes 类。 */
  if (opts.timelineHost) {
    opts.timelineHost.classList.add("bzf-lanes");
    opts.timelineHost.append(el.band, root.querySelector(".bzf-foot"));
  }

  const st = {
    mode: opts.mode || "inline",
    film: null,      // /cglide/chain/film_summary 的返回
    cur: null,       // 当前选中的段落 id
    info: null,      // 当前成片的 /info
    wave: null,
    span: 0,         // 当前成片真实帧数
    frame: 0,
    drag: false,
    dead: false,
    slot: null,      // 悬浮时留在原位的占位块
    floatSize: null, // 上次拖出时调过的尺寸，下次接着用
    seq: 0,          // 请求序号：慢请求回来时如果已经切段了就丢掉
    /* 「整片连播」是否开着。点取景器起播时打开，播到最后一段 / 用户改选段 /
       搓播放头 / 暂停时关掉。放 st 里而不是模块级 let：clearView 在它之前
       就定义了，用 let 会踩 TDZ（本文件已经被同类问题咬过一次）。 */
    playAll: false,
    /* 当前 <video> 装的是**原片**还是**播放版**（20261010av 方案③）。
       true = 原片（头部带承接重叠帧，videoT0 要减 trim，自愈仍需工作）；
       false = 播放版 .play.mp4（第 0 帧就是本段新画面开头，videoT0=clip_from，
       连播接段从 0 秒起播，不需要任何对位 seek）。默认 true 保守兜底。 */
    curRaw: true,
    /* 被「跳过」的段 id 集合（工程侧 p.shots[].off，film_summary 不带它）。
       null = 宿主还没推过来，此时一律不画跳过标记。 */
    skipIds: null,
  };

  /* 这一段是不是被跳过（不参与渲染）。只读宿主推来的集合，不自己猜 ——
     「跳过」的真值在工程里，档案侧没有这个字段。 */
  function isSkipped(c) {
    return !!(st.skipIds && c && c.id && st.skipIds.has(String(c.id)));
  }

  /* ==================== 像素/帧 坐标模型 → 统一时间轴视图引擎（20261014 方案A/B） ====================
     专业剪辑软件（Premiere/达芬奇/Final Cut）的时间轴不按"百分比填满固定宽度"，
     而是一把固定的"像素/帧"尺子贯穿所有层：
       · left = 帧 × pxPerFrame；width = 帧长 × pxPerFrame
       · 拖一段接缝：只有被拖段变宽、后续段平移、左侧段纹丝不动
       · 内容区 track 宽 = 总片长 × pxPerFrame，超出可视宽 → 横向滚动
     pxPerFrame 是持久化状态：只在「首次加载 / 点适配屏幕 / 切工程 / 缩放」时算一次，
     拖动和普通刷新都不改它，否则又退化成"总片长一变、全部段重新压缩"的旧模型。

     20261014 起，坐标/缩放/容器 resize/合帧重画全部收口到 csglide_timeline_engine
     （唯一坐标 frameToX、唯一缩放参数、唯一 ResizeObserver、一个 rAF render 总线）。
     这里只保留同名薄封装，业务调用点不改动——段块/连播/续拍/波形等高度定制逻辑
     零行为变化；引擎还带来 Ctrl+滚轮锚点缩放（见滚轮处理）。 */
  /* let + 先置空：mountAudioLane() 在本函数之前就挂载，并且可能在拿到
     bzStore 帧账快照后立刻调 opts.wOf()。const 会让那段读 tEngine 的薄封装
     踩 TDZ 直接抛错；置空后薄封装返回 0（尺子未就绪），布局自然走 CSS 兜底，
     等引擎建好再由 layout/sync 补上真实宽度。 */
  let tEngine = null;
  tEngine = createTimelineEngine({
    band: el.band,
    /* 左侧 88px 轨道头留白：时间轴 0 帧从这里开始（见 .bzf-track margin-left）。 */
    gutter: TRACK_GUTTER,
    getTotalFrames: () => totalFrames(),
    isCollapsed: () => st.mode === "collapsed",
    onRender: () => { if (!st.dead && st.mode !== "collapsed") layout(); },
  });
  function viewportW() { return tEngine ? tEngine.viewportW() : 1; }
  /* 适配屏幕 / 首次建尺 / 坐标换算 —— 全部委托引擎（唯一权威）。
     引擎还没建好时一律返回「无尺子」，绝不抛 TDZ（见上方 let 注释）。 */
  function fitTimeline() { if (tEngine) tEngine.fit(); }
  function ensureScale() { if (tEngine) tEngine.ensureScale(); }
  function xOfFrame(f) { return tEngine ? tEngine.xOf(f) : 0; }   // 帧 → 横坐标
  function wOfFrames(n) { return tEngine ? tEngine.wOf(n) : 0; }   // 帧长 → 像素宽

  /* ---------------------------------------------------------- 三态 */

  function setMode(m) {
    if (m === "floating") {
      if (!root.classList.contains("bzf-float")) {
        st.slot = document.createElement("div");
        st.slot.className = "bzf-slot";
        st.slot.textContent = "监视器已拖出 · 点「收回」放回这里";
        root.parentNode && root.parentNode.insertBefore(st.slot, root);
        document.body.appendChild(root);
        root.classList.add("bzf-float");
        placeFloat();
      }
    } else {
      if (root.classList.contains("bzf-float")) {
        if (st.slot && st.slot.parentNode) {
          st.slot.parentNode.insertBefore(root, st.slot);
          st.slot.remove();
        } else {
          document.body.removeChild(root);
        }
        st.slot = null;
        // 记下浮动时的尺寸，下次拖出接着用；内嵌态必须还原成跟着节点走，
        // 否则缩放过的尺寸会残留下来把节点撑变形。
        if (root.style.width || root.style.height) {
          st.floatSize = { w: root.style.width, h: root.style.height };
        }
        root.classList.remove("bzf-float");
        root.style.left = root.style.top = "";
        root.style.width = root.style.height = "";
      }
    }
    root.classList.toggle("bzf-collapsed", m === "collapsed");
    st.mode = m;
    if (m !== "collapsed") {
      requestAnimationFrame(() => { layout(); refresh(); });
    }
    if (opts.onMode) opts.onMode(m);
  }

  function placeFloat() {
    // 默认落在视口中间偏右，避开左侧的节点树与右侧的侧栏
    const w = 660, h = 520;
    const x = Math.max(12, (window.innerWidth - w) / 2 + 120);
    const y = Math.max(12, (window.innerHeight - h) / 2 - 40);
    root.style.left = `${Math.round(x)}px`;
    root.style.top = `${Math.round(y)}px`;
    // 上次拖出时调过尺寸就接着用，否则交给 CSS 默认
    if (st.floatSize) {
      root.style.width = st.floatSize.w;
      root.style.height = st.floatSize.h;
    }
  }

  /* 标题栏只剩片名 / 段位 / 时间码这一行只读信息。
     原先右侧四颗按钮（适配 / 锁定 / 刷新 / 拖出）已撤：适配由时间轴引擎在
     建尺、缩放、换工程时自动做；锁定在段块右键菜单里；刷新由档案推送与选中
     自动触发；拖出悬浮这条交互没人用，反而占地儿。 */

  /* 悬浮窗缩放：右下角把手。下限卡死，缩太小取景器和时间带都会挤成一团。 */
  const FLOAT_MIN_W = 380, FLOAT_MIN_H = 280;
  const rsz = root.querySelector(".bzf-rsz");
  let sizeOff = null;
  rsz.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    sizeOff = { x: e.clientX, y: e.clientY,
      w: root.offsetWidth, h: root.offsetHeight };
    rsz.setPointerCapture(e.pointerId);
  });
  rsz.addEventListener("pointermove", (e) => {
    if (!sizeOff) return;
    root.style.width = `${Math.max(FLOAT_MIN_W, sizeOff.w + e.clientX - sizeOff.x)}px`;
    root.style.height = `${Math.max(FLOAT_MIN_H, sizeOff.h + e.clientY - sizeOff.y)}px`;
  });
  rsz.addEventListener("pointerup", () => {
    if (!sizeOff) return;
    sizeOff = null;
    layout();
  });

  /* 悬浮窗拖动：只认标题栏空白处，按钮自己吃掉事件 */
  let dragOff = null;
  root.addEventListener("pointerdown", (e) => {
    if (!root.classList.contains("bzf-float")) return;
    if (e.target.closest(".bzf-btn") || e.target.closest(".bzf-band")
        || e.target.closest(".bzf-rsz")) return;
    if (!e.target.closest(".bzf-bar")) return;
    dragOff = { x: e.clientX - root.offsetLeft, y: e.clientY - root.offsetTop };
    root.classList.add("bzf-drag");
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!dragOff) return;
    root.style.left = `${Math.round(clamp(e.clientX - dragOff.x, 0, window.innerWidth - 80))}px`;
    root.style.top = `${Math.round(clamp(e.clientY - dragOff.y, 0, window.innerHeight - 40))}px`;
  });
  root.addEventListener("pointerup", () => {
    dragOff = null;
    root.classList.remove("bzf-drag");
  });

  /* ---------------------------------------------------------- 数据 */

  /* proxy=auto：让后端按分辨率自己决定 —— 宽片（>1600，比如 3072×1728）给一份
     512px 小副本，浏览器软解 530 万像素太吃亏；窄片仍返回原片，零额外成本。
     代理片是等帧重编码，帧数与时长一致，时间轴和进度都不会错位。
     左上角那一栏尺寸标签读的是 /info 的元数据（母片真实尺寸），不受影响。 */
  const vurl = (v, ver) => `${JOIN}/video?video=${encodeURIComponent(v)}&proxy=auto`
    + (ver ? `&v=${ver}` : "");
  /* ver = 该段档案的 updated 时间戳。**它只用来把浏览器缓存顶掉**：重抽是覆盖
     写同一个成片路径，URL 一字不变的话浏览器会直接拿一小时前缓存的旧图（后端
     给这两条路由都带了 max-age=3600）。带上它，重抽一次 URL 就变一次，画面才
     跟得上；没重抽时它不变，缓存照旧命中，一次请求都不多发。 */
  const turl = (v, f, w, ver) =>
    `${JOIN}/thumb?video=${encodeURIComponent(v)}&frame=${f}&w=${w}`
    + (ver ? `&v=${ver}` : "");
  /* 雪碧图：一段画面一次解码、拼成一张横向长图（列数在 X-Sprite-Cols 头里）。
     f0/f1 是这一段在自己成片里的那一截 —— 累积片必传，否则每段块都是同一部
     整片（见 renderStrip 的采样窗口）。 */
  const surl = (v, cols, cw, f0, f1, ver) =>
    `${JOIN}/sprite?video=${encodeURIComponent(v)}&cols=${cols}&cw=${cw}`
    + (f0 != null && f1 != null && f1 - f0 >= 1 ? `&f0=${f0}&f1=${f1}` : "")
    + (ver ? `&v=${ver}` : "");

  /* ==================================================================
     接缝（20261010bj）：连播接段那一下，屏幕上只允许出现**两幅**画面
     ------------------------------------------------------------------
     用户报「保存的成片接缝还好，但是时间轴播放的视频衔接处有跳变」。把两边
     放在同一把尺子上量过，两句话都对、而且不矛盾 —— 接的是同一批帧：
       · 保存的成片是**一条** mp4，接缝就是一个**帧边界**，1/24 秒跨过去
         （实测那一步的画面差 4.84/255 ≈ 1.9%，肉眼基本无感 —— 所以"还好"）；
       · 时间轴是**一条一段地换源**，接缝是一段**路程**：ended → showPoster
         （服务端抽帧 70~1100ms）→ /info（一次往返，首次还要现生成播放版
         1~2s）→ 换 src → 等第一帧解码 → play。
     而 loadVideo 一进门就把 video 藏了（remove bzf-ok），此刻 img 上挂的还
     是**上一次 showPoster 留下的那张** —— 选中上一段时抽的**中段**帧。于是
     一道接缝要跳三下：
         上一段最后一帧 → 上一段中段（旧垫图）→ 下一段中段（新垫图到位）
                        → 下一段第一帧（视频出画）
     成片里那 1.9% 的内容差，在这里被放大成三次来回跳 —— 这才是"跳变"。
     两件事就能消掉：
       ① 换源前把**此刻画面**就地定格（本地截帧，零请求，没有中间态）；
       ② 连播期间不许 showPoster 插一脚（它那一脚 70~1100ms 正好卡在中间）。
     再把下一段**预载**好，定格就只停一两帧 —— 那是"接上了"，不是"卡住了"。
     ================================================================== */
  let seamHold = false;      /* 连播接段途中：不许 showPoster 换垫图 */
  let seamFrozen = false;    /* 定格图已铺上，且要等它**画出来**才换显示层 */
  /** 定格图就位的信号（20261010bq）。
      单 video 元素做不到"无缝"：给 src 赋值的那一刻，画面**立刻空掉**（浏览器
      把旧的一帧丢了），而定格图（img 的 data: URL）还要解码 —— 解码通常比一次
      /info 往返慢，于是"换了 src、定格图还没画出来"那一段就是黑的。
      （续接合成那个面板不闪，是因为它用**两条 video 轮流**（见
      csglide_join_panel.js 的 el.videos / state.vA）：下一条在暗处加载好再换
      可见性，压根没有"画面空掉"这一说。）
      所以这里把顺序钉死：**定格图没画出来，不许换 src**。 */
  let frzReady = null;

  /** 把**此刻 video 上的画面**就地定格到垫图层。
      不发一个请求 —— 定格要的就是"零延迟"；走服务端抽帧（showPoster）等于又
      引入一个"目标还没到"的中间态，那正是要消灭的东西。
      抓不到（还没解码出画面 / 画布被跨域弄脏）就返回假，由调用方决定怎么办：
      宁可退回老样子，也不要盖一张不相干的图上去。
      **先换图、等它真的画出来，再换显示层**（20261010bo）：img 换 src 后要重
      新解码，这一刻就把 video 收了、把 img 亮了，屏幕上是一个还没解码出来的
      **空 img** —— 那一帧是黑的。用户报的「接缝黑一帧」就是它：跳没有了，换
      成了闪黑。所以视频（上一段最后一帧）保持到定格图就位为止，交换才无痕。 */
  function freezeCurrentFrame() {
    try {
      const w = el.video.videoWidth, h = el.video.videoHeight;
      if (!w || !h) return false;
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(el.video, 0, 0, w, h);
      const url = cv.toDataURL("image/jpeg", 0.9);
      if (!url || url.length < 64) return false;
      const swap = () => {
        el.img.classList.add("bzf-ok");
        el.video.classList.remove("bzf-ok");
      };
      frzReady = new Promise((resolve) => {
        let settled = false;
        /* ok=true：定格图画出来了 → 换层；ok=false：画不出来（解码失败 / 超时）
           → 退回"立刻收视频"的老样子，loadeddata 一到就有新画面，最多闪一下，
           不会冻在旧画面上。 */
        const done = (ok) => {
          if (settled) return;
          settled = true;
          if (ok) swap(); else el.video.classList.remove("bzf-ok");
          resolve();
        };
        el.img.addEventListener("load", () => done(true), { once: true });
        el.img.addEventListener("error", () => done(false), { once: true });
        /* 先摘旧 src 再挂新图：同一张 data: 图连着两道接缝时 src 一字不变，
           浏览器不会再发 load，就永远等不到。摘一下强制走一次完整的加载循环
           —— 这一瞬 img 还藏着（bzf-ok 没加），画面由 video 顶着，不黑。 */
        el.img.removeAttribute("src");
        el.img.src = url;
        /* data: 图多半同步就绪（缓存命中时浏览器可能不重放 load）—— 补一脚
           同步检查，与 armPoster 同款。 */
        if (el.img.complete && el.img.naturalWidth) { done(true); return; }
        /* 兜底：150ms 还没画出来就放行 —— 不能为了一张定格图把接段卡死。 */
        setTimeout(() => done(false), 150);
      });
      return true;
    } catch {
      return false;         /* 画布脏了 / 元素还没就绪 */
    }
  }

  /* ---- 拖动跨接缝冻结（20261011，"零编码位图"方案）： ----
     换源前把当前 video 当前帧 drawImage 到【常驻 canvas】（GPU 位图拷贝 ~0.2ms、
     不 toDataURL、不新建元素），canvas 盖最上；新段首帧 rvfc 真正上屏后撤。
     换源空窗里屏幕始终是"离开前那一帧"，不露黑、也不倒回旧段中段。 */
  function showFreeze() {
    try {
      const w = el.video.videoWidth, h = el.video.videoHeight;
      if (!w || !h) return false;
      if (el.freeze.width !== w || el.freeze.height !== h) {
        el.freeze.width = w; el.freeze.height = h;
      }
      el.freeze.getContext("2d").drawImage(el.video, 0, 0, w, h);
      el.freeze.classList.add("bzf-ok");
      return true;
    } catch { return false; }
  }
  function hideFreeze() { el.freeze.classList.remove("bzf-ok"); }

  /** /info 的记忆：同一段同一版只问一次（20261010bj）。
      连播预载与真正换源问的是**同一个 URL** —— 没有这份记忆，预载等于白跑一
      趟（预载跑完、换源又从头问一次后端，白等两回）。
      **失败的答案不算答案**：读档失败多半是"重抽覆盖写那一瞬间 ffprobe 探到
      半截文件"，把它记住等于这一段从此永远读不出来 —— 失败就把记忆抹掉。 */
  const infoMemo = new Map();
  function infoFor(url, memKey) {
    const k = memKey || url;
    let p = infoMemo.get(k);
    if (!p) {
      p = getJSON(url);
      infoMemo.set(k, p);
      p.catch(() => { if (infoMemo.get(k) === p) infoMemo.delete(k); });
    }
    return p;
  }
  /** /info 的 URL —— 预载与换源必须用**同一条**，否则记不住（见 infoFor）。
      掐头帧数 / 限尾帧数 / 段长三个参数一起决定后端认不认这条片子是"本段那
      一条"（见 ensure_play_film 里 own 的注释），所以一个都不能少。 */
  function infoUrlOf(row) {
    /* trim = 本段新画面在这条成片里的位置 = clip_from - filmT0（20261010ba
       统一）：单段成片掐掉头部承接重叠，累积片掐到本段在全片里的起点。 */
    const trimQ = Math.max(0, int(row.clip_from) - filmT0(row));
    /* take = 本段要留下几帧（轴上的净长）—— 只掐头不限尾的话，第 1 段那种
       比净长长一大截的成片会多带一截不属于本段的画面进播放版。 */
    const takeQ = Math.max(0, int(row.clip_to) - int(row.clip_from));
    return `${JOIN}/info?video=${encodeURIComponent(row.film)}&trim=${trimQ}`
      + `&take=${takeQ}&frames=${Math.max(0, int(row.frames))}`;
  }
  /** 这一段要播的那条片子 —— 有播放版就播播放版（它的第 0 帧 = 本段新画面
      开头，接段不需要任何 seek），没有才退回原片。 */
  function playUrlOf(row, hasPlay) {
    return hasPlay
      ? `${JOIN}/video?video=${encodeURIComponent(row.film)}&play=1&proxy=auto`
        + `&v=${int(row.updated)}`
      : vurl(row.film, int(row.updated));
  }
  /** 让浏览器把下一条片子**先取回来**：一个离屏 video，只为填缓存。
      不为播放 —— 播放永远只有 el.video 那一个元素，免得两份播放状态互相打架。 */
  const warmEls = new Map();
  function warmPlayUrl(url) {
    if (!url || warmEls.has(url)) return;
    const v = document.createElement("video");
    v.className = "bzf-warm";
    v.preload = "metadata"; v.muted = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("aria-hidden", "true");
    /* 贴到取景框里（而不是留在文档外）：离屏的媒体元素有些浏览器不取，挂进
       文档才稳妥；框子自己 overflow:hidden，再叠一层 opacity:0 与 1px 尺寸，
       怎么都露不出来。行内样式压得住 .bzf-view video 那套铺满规则。 */
    v.style.cssText = "position:absolute;left:-9999px;top:0;width:1px;height:1px;"
      + "opacity:0;pointer-events:none;";
    v.src = url;
    (el.view || root).appendChild(v);
    warmEls.set(url, v);
    /* 同时攒着的不超过 3 条：来回点几段就会攒一堆，白占带宽。 */
    while (warmEls.size > 3) {
      const k = warmEls.keys().next().value;
      const old = warmEls.get(k);
      warmEls.delete(k);
      try {
        old.removeAttribute("src");
        if (old.parentNode) old.parentNode.removeChild(old);
      } catch { /* 收尾失败无所谓 */ }
    }
  }

  /* 切段前先垫一张该段的缩略图（20261010）：跨段 / 点选换 video 源的那几百
     毫秒，video 里还没有可显示的画面 —— 不垫就黑一下帧。img 叠在 video 之上，
     等新视频 loadeddata 出第一帧再撤掉，切段就无缝了。 */
  function showPoster(row) {
    if (!row || !row.film) return;
    const own = Math.max(1, int(row.frames));
    /* 判据统一到 isCumulative（20261010bg）：原来这里只写了「覆盖到本段末尾」
       这一条，缺「成片明显长过本段自己」—— 短段（比如第 2 段，clip_to 才
       net1+net2）会被误判成累积片，于是垫图按**全片坐标** clip_from + net/2
       去取帧，而这条片子只有 own 帧那么长 —— 取到的是最后一帧或压根取不到，
       切段一瞬间垫出一张不相干的画面，正是"接缝处闪一下"的又一来源。 */
    const cum = isCumulative(row);
    /* 垫图取**块上显示范围**的中帧（20261010 对齐净长口径）：单段成片的开头
       trim 帧是承接重叠（归上一段展示），垫图不该从那里取 —— 否则切段一瞬
       间垫出来的是上一段的画面，看着像"切了段画面还是旧的"。 */
    const trim = Math.min(Math.max(0, int(row.trim_frames)), own - 1);
    const f = cum
      ? int(row.clip_from) + Math.floor(Math.max(1, int(row.clip_to) - int(row.clip_from)) / 2)
      : trim + Math.floor((own - trim) / 2);
    /* 版本号同上：垫图走 /thumb，同一条缓存规则 —— 不带上它，重抽之后跨段时
       垫出来的还是上一版那一帧。 */
    el.img.src = turl(row.film, f, 320, int(row.updated));
    el.img.classList.add("bzf-ok");
    el.video.classList.remove("bzf-ok");
  }

  async function pickFilm() {
    const name = (opts.getName && opts.getName()) || "";
    if (!name) {
      st.film = null;
      return null;
    }
    /* 单一数据源（20261012 方案B）：快照只从 bzStore 取，缓存没有才让它拉，
       不再自己发 film_summary HTTP —— 全页面同片名只有一份请求、一份数据。 */
    st.film = bzStore.film(name) || await bzStore.touchNow(name, "monitor");
    return st.film;
  }

  /* 订阅当前片名的 store 变更；片名切换（改名/新建/打开工程）自动换订阅。
     store 推送来的刷新走 "store" 静默档（不换视频源、不抽垫图，见 refreshInner）。 */
  let subName = "";
  let unsubStore = null;
  function ensureSub() {
    const name = (opts.getName && opts.getName()) || "";
    if (name === subName) return;
    if (unsubStore) { try { unsubStore(); } catch (_) {} unsubStore = null; }
    const prevName = subName;
    subName = name;
    /* 换片（新建工程 / 改名 / 打开别的工程）：旧片的段块与接缝胶囊当场抹掉，
       不等档案拉回来。异步那几帧里挂着旧片的"胶囊"最容易被当成新片的接缝，
       而只清复用表会把它们变成永久孤儿（20261012）。只在"真换过一次"时做，
       免得片名瞬间为空把轴清掉。 */
    if (prevName) { dropSegLayers(); el.segs.innerHTML = ""; tEngine.reset(); }
    if (!name) return;
    unsubStore = bzStore.subscribe(name, (d) => {
      if (st.dead) return;
      if (d.immediate || d.reason === "cached" || d.reason === "optimistic") return;
      void refresh("store");
    });
  }

  /** 选中第 k 段：它的成片就是「前 k 段累积起来的那条」。
      viaUser = 这一次是**用户在轴上点/拖出来的**，不是刷新自动挑的
     （refreshInner 每次都会替用户挑一段：最后一段有成片的那些）。
     必须区分对待：自动挑的那一次若也去改"当前段"，用户刚点的那一段会被它
     盖回去 —— 表现为"点完过一会儿自己跳回去了"。 */
  async function select(id, viaUser, previewOnly = false) {
    const film = st.film;
    if (!film || !film.clips || !film.clips.length) return;
    if (!previewOnly) exitWhole();   /* 明确编辑才退出；拖动预览不作废缓存查询 */
    let row = film.clips.find((c) => c.id === id);
    if (!row) row = film.clips[film.clips.length - 1];
    if (previewOnly) {
      /* 预览身份由 loadedId 管理，st.cur/宿主选中状态只在松手提交。 */
      await loadVideo(row, true);
      return;
    }
    st.cur = row.id;
    /* 播放头跟着落到这一段上。它是**全片坐标**（见 setPlayheadAbs）：点了别的
       段，人就应当移到那一截上去 —— 换了段而播放头还停在上一截，时间码和画面
       说的就不是一回事了。
       只在它**不在这段里**时才挪：还在段内就别动 —— 重绘一遍（改名、拖时长、
       切版本都会走到 refresh → select）就把播放头拨回段首，那是另一种"乱跑"。 */
    const from = int(row.clip_from), to = Math.max(from + 1, int(row.clip_to));
    if (!(st.frame >= from && st.frame < to)) st.frame = from;
    /* 刷新路径也必须重画段块（20261009 修）：refreshInner → select(target)
       不带 viaUser。以前这里 if (!viaUser) return 直接跳过后面的
       renderSegs / scheduleStrip / loadVideo，导致「＋ 接一段」登记成功后
       轴上不出现新块，直到窗口缩放触发 layout() 才偶发刷新。
       viaUser 只应闸住 onPick / userPick / 停连播 —— 别闸绘制。 */
    if (!viaUser) {
      /* 非用户点选：仍更新标题、锁钮、段块；不改 userPick、不回调 onPick。 */
      el.meta.textContent = `${film.name || "未命名"} · 第 ${row.index} 段 / 共 ${film.clips.length} 段`;
      el.meta.className = "bzf-meta";
      renderSegs();
      scheduleStrip();
      if (!row.playable) {
        clearView();
        el.play.style.display = "";
        setPlayheadAbs(fracOfFrame(st.frame));
        el.cap.textContent = `第 ${row.index} 段还没有成片 —— 跑一次衔接合成就有了`;
        el.badge.style.display = "none";
        refreshCenter();
        return;
      }
      /* 拖动中**不换垫图**（20261010bg）：showPoster 是一次服务端抽帧
         （70~1100ms），而拖动跨段一秒好几次 —— 这些请求会乱序回来，把画面
         垫成上一个目标的帧，接缝附近一路乱闪。拖动中交给 loadVideo 的
         "就位才出画"，亮出来的第一帧就是目标帧本身，没有中间态可闪。
         **连播接段同样不换**（20261010bj，seamHold）：那一路上垫图已经由
         freezeCurrentFrame 就地定格成"上一帧"了，再让 showPoster 去抽一张新
         的，等于在接缝中间又插第三幅画面 —— 详见上面"接缝"那段的注释。 */
      if (!st.drag && !seamHold) showPoster(row);
      await loadVideo(row);
      refreshCenter();
      return;
    }
    /* 用户在轴上亲手改选了段 —— 整片连播到此为止。连播途中点别的段，
       那是"我要看这一段"，不该把它当成"从这儿接着播完整片"：静悄悄重启
       一次连播，用户会以为播放器坏了。要接着连播，再点一次取景器。 */
    haltPlayback();
    resetBuffer();   /* 用户亲手改选段：备用 video 的预载作废，避免接缝抬错段 */
    /* 记住用户挑的这一段。刷新时要认它 —— 不然下一次 refresh（改名、拖时长、
       换版本、别的节点改了档案都会触发）又会按 head 重新挑一段，用户刚点的
       那一段的高亮就被挪走了，看着像"自己跳回去"。 */
    userPick = row.id;
    el.meta.textContent = `${film.name || "未命名"} · 第 ${row.index} 段 / 共 ${film.clips.length} 段`;
    el.meta.className = "bzf-meta";

    renderSegs();
    /* 段块复用之后缩略图不再被一起带走，这里只是「补上还没铺的那些」：
       签名没变的段一块都不动。走 scheduleStrip 而不是直接铺 —— loadVideo
       马上还会再喊一次 layout()，两次合并成一帧里的一次。 */
    scheduleStrip();
    if (opts.onPick) opts.onPick(row, !!viaUser);

    if (!row.playable) {
      clearView();
      /* clearView 把播放头收起来了（没有视频可播），但轴上还有整部片子的
         **规划**可以搓 —— 播放头照样给，否则这一段上它凭空消失，拖也没得拖。 */
      el.play.style.display = "";
      setPlayheadAbs(fracOfFrame(st.frame));
      el.cap.textContent = `第 ${row.index} 段还没有成片 —— 跑一次续接合成就有了`;
      el.badge.style.display = "none";
      refreshCenter();
      return;
    }
    showPoster(row);
    /* loadVideo 吃的是**行对象**（自己取 row.film / row.updated，20261010 改）。
       原来这里还传着 row.film（路径字符串）—— 签名改了它没跟上：字符串上取
       .film 得到 undefined，src 变成 garbage、/info 必炸、clearView 把 st.span
       清零。后果是两条：点段块 / 拖播放头松手落段，监视器都换不了画面；更阴
       的是 span 清零后 seekFrac 的跨段切换整个被冻住 —— "拖到了第一段、监视器
       还是第二段画面"就是它。（刷新路径 select(row) 一直是对的，所以自动挑段
       看着正常，更难察觉。） */
    await loadVideo(row);
    refreshCenter();
  }

  /* ---- 「video 里现在装的是哪一段」—— 整条时间轴最容易出错的一处隐藏状态 ----
     select() 是**先同步改 st.cur、再 await loadVideo 去换 src**。中间隔着几百
     毫秒（一次 /info，可能还要现场生成播放版）：此刻
       · curRow() 已经是**新段**
       · el.video.src 装的还是**旧片**
     谁拿新段的坐标系去 seek 这条旧片，秒数就是照另一条片子算的 —— 视频跳到
     一个毫不相干的位置。而正着拖和反着拖撞上的"旧片"不是同一条（来向不同），
     于是**同一个播放头位置、正拖反拖两个画面** —— 就是"路过接缝时正放倒放
     不一致"。换源落地那一刻还会硬跳一次，读作"接缝处闪烁跳变"。
     所以 seek / 回写一律认 loadedId（元素里真正装着的段），不认 st.cur
     （下一个**打算**装谁）。两者只在换源落地那一瞬相等。 */
  let loadedId = null;      /* 已装载（第一帧已解码）的段 id；null = 没有 / 正在换 */
  let loadingId = null;     /* 正在换到哪一段；null = 没在换 */
  /* 已装载成片的**身份** = 段 id + 成片路径。loadedId 只说得清"装的是哪一段"，
     说不出"装的是这一段的第几个 take"：收片把 t22 覆盖成 t23 是同一段换片，
     loadedId 前后完全相等。后台推送要靠它判断「成片到底换没换」——
     只认后台推送就一律静默，会把新 take 挡在屏幕外（20261023）。 */
  let loadedFilmKey = null;
  const filmKeyOf = (row) => (row ? `${row.id}|${row.film || ""}` : null);
  let loadedKind = null;    /* 已装载那条是 "play"（播放版）还是 "raw"（原片） */
  /** 换源想去哪一段 / 是不是正在换。拖动中每秒上百次"想去"，不能每次都换源
      （一次换源 = /info + 可能生成播放版 + 抽帧 + 波形），也不能像原来那样
      用 250ms 节流硬砍 —— 节流吞掉的那一次**没有补冲**，来向不同就吞掉不同
      的那一次，最终停在哪一段成了路径依赖：这正是"正放倒放不一致"的另一半。
      改成串行 + 尾补：换源期间只记目标，落地后再看目标变没变，变就再换一次。
      最后一次一定兑现，且一次来回搓最多两次换源。 */
  let switchWant = null;
  let switching = false;
  function requestSwitch(id) {
    if (!id || wholeMode) return;
    switchWant = id;            /* 先覆盖：拖回已装/正在装的段也要撤掉旧排队目标 */
    if (loadedId === id || loadingId === id || switching) return;
    runSwitch();
  }
  async function runSwitch() {
    if (switching || wholeMode || st.dead) return;
    if (st.drag && loadedId && !el.video.error
        && (el.video.seeking || seekPaintCancel || el.video.readyState < 2)) return;
    switching = true;
    try {
      while (!wholeMode && !st.dead && switchWant
             && switchWant !== loadedId && switchWant !== loadingId) {
        const id = switchWant; switchWant = null;
        await select(id, false, st.drag);
        /* 新源要先解出目标帧；其间只记最新段，避免快速横扫连续重建解码器。 */
        if (st.drag) break;
      }
    } finally {
      switching = false;
    }
  }
  function rowById(id) {
    const clips = (st.film && st.film.clips) || [];
    return id == null ? null : (clips.find((c) => c.id === id) || null);
  }

  async function loadVideo(row, previewOnly = false) {
    const seq = ++st.seq;
    const path = row.film;
    try {
      /* 换源进行中的标记：requestSwitch 据此不再重复发起。**不动** loadedId
         —— 此刻 src 里还是上一条片子，loadedId 就该继续说"装的是那一条"，
         于是 seekFrac 认得出"播放头已经不在这一段了"，不会拿新段的坐标系
         去 seek 这条还没卸掉的旧片（见 loadedId 处的注释）。 */
      loadingId = row.id;
      el.video.pause();
      /* 上一次的"等对位"作废：它的秒数是按**上一条**视频算的，不能带过来。 */
      cancelArm();
      /* 直接播**成片本身**：本插件生成的成片恒为 H.264+aac 的 mp4，而 /video
         是 FileResponse（自带 Range）—— 浏览器直接播原片、拖动 seek 全部免费，
         和视频合并节点那条路一致。低清代理机制已于 20261010 删除。
         版本号同雪碧图：重抽覆盖写了同一个路径，src 一字不变的话浏览器连请求
         都不发，监视器里播的就还是重抽前那一版。
         （20261010av：src 的选择挪到 /info 回来之后 —— 有没有播放版要问过
         后端才知道，见下方 st.curRaw 的赋值处。） */
      /* 上一条视频攒下的 seek 目标作废（秒数是按旧视频算的，不能带到新视频
         上；下面若需要对位会立刻写入新目标）。 */
      resetSeekQueue();
      if (previewOnly) showFreeze();
      /* 出声：video 标签上的 muted 已去掉，每次换源后保险再设一次。 */
      el.video.muted = audioMuted;
      /* 连播接段**不在这里收视频**（20261010bo）：此刻定格图（freezeCurrentFrame
         铺的那张 data: 图）多半还没解码完，先收了 video，屏幕上就是一帧黑 ——
         用户报的「黑一帧」正是这一收。视频保持显示上一段最后一帧，等定格图真的
         画出来（img 的 load）才切换；定格失败（抓不到帧 / 解码出错）则照旧在
         这里收，退回老样子。 */
      if (!(seamHold && seamFrozen)) el.video.classList.remove("bzf-ok");
      /* 不撤 img.bzf-ok：垫图（showPoster 塞进去的那张）留着盖住黑帧，
         等 loadeddata 出第一帧再撤。 */
      el.cap.textContent = "读取成片信息…";
      /* 掐头帧数 = 本段新画面在这条成片里的位置 = clip_from - videoT0
         （20261010ba 统一）：
           · 单段成片 videoT0 = clip_from - trim      → 掐掉头部承接重叠帧；
           · 累积片   videoT0 = 0                     → 掐到本段在全片里的起点。
         两种片子掐完都**正好是本段的净长**，播放版的第 0 帧一律 = 本段新画面
         的第一帧。早先只有单段片掐、累积片整条从 0 播 —— 于是累积片那条
         永远从全片开头放起，连播接段时前面几段又播了一遍。 */
      /* frames = 本段自己的规划帧数（20261010aw）：后端拿它跟**真实帧数**比，
         裁定这条片子到底是"本段那一条"还是一条累积片/整片 —— 这个裁定必须
         由看得见文件的一方来下，前端档案里的 film_frames 可能是陈旧的。
         URL 走 infoUrlOf（20261010bj）：连播预载问的是同一条，两边拼法一致
         才能命中 infoFor 的记忆 —— 各拼一遍必然在某个参数上分叉。
         记忆键带上 updated：这一段重抽过（版本号变了）就得重新问，不能拿上
         一版的帧数去当"是不是累积片"的判据。 */
      /* 拖动预览只探测原片，trim=0 不触发后端播放版生成；缓存与生成请求分开。 */
      const iurl = previewOnly
        ? `${JOIN}/info?video=${encodeURIComponent(path)}`
        : infoUrlOf(row);
      const info = await infoFor(iurl, iurl + "|" + int(row.updated));
      if (seq !== st.seq || st.dead) return;
      if (previewOnly && rowAtFrame(st.frame)?.id !== row.id) {
        loadingId = null;
        /* /info 返回时用户已离开：保留旧源，直接补当前最新段，不提交过期 src。 */
        const latest = rowAtFrame(st.frame);
        switchWant = latest?.playable && latest.id !== loadedId ? latest.id : null;
        whenVideoPainted(() => {
          if (loadedId) el.video.classList.add("bzf-ok");
          hideFreeze();
          if (switchWant && !switching) runSwitch();
        });
        return;
      }
      st.info = info;
      /* 把后端读到的**真实帧数**回写进这一段（同上）：它才是"是不是累积片"
         这个判据的地面真相。日志里出现过"第 2 段掐头 39 → 204 帧"，就是档案
         里记着 107、磁盘上却是 243 帧的整片 —— 判据用了陈旧值，于是把一条
         整片当单段片掐了头，掐完当成本段那 68 帧播，位置全错 = 跳闪。 */
      if (int(info.total_frames) > 0) row.film_frames = int(info.total_frames);
      st.span = Math.max(1, int(info.frames || info.nb_frames || 0));
      /* 有播放版就播它（20261010av）：/video?play=1 会回掐好头的 .play.mp4，
         它的第 0 帧 = 本段新画面开头 —— 连播接段从 0 秒直接播，**不需要任何
         对位 seek**，接缝因此没有跳变没有闪。没有（后端没 ffmpeg / 首次
         生成失败）就退回原片 + 原口径，ARM 接着兜底。 */
      st.curRaw = !info.play_film;
      /* 连播接段：**定格图没画出来就不许换 src**（20261010bq）。
         给 src 赋值的那一刻，video 里那一帧**立刻没**（浏览器把旧的丢了），
         而定格图是刚生成的 data: 图、还要解码 —— 这段空窗就是黑帧。/info 往返
         常常比解码还快，所以光"先定格再换源"不够，得等它真画出来。定格失败
         （解码出错或 150ms 超时）也放行：宁可闪一下也不能把接段卡死。 */
      if (seamHold && seamFrozen && frzReady) await frzReady;
      if (seq !== st.seq || st.dead) return;      // 等定格图期间已经切走了
      el.video.src = st.curRaw
        ? vurl(path, int(row.updated))
        : `${JOIN}/video?video=${encodeURIComponent(path)}&play=1`
          + `&v=${int(row.updated)}`;
      /* 身份在 src 落定的**这一行**同步确定（20261010bg）—— 刻意不挂在
         loadeddata / loadedmetadata 上：那两个事件在浏览器里**不保证**来
         （src 没变时不重放、编码出错时只有 error、某些容器要等好几秒），
         把"画面能不能动"押在它们身上，一次不来就是整个监视器冻住 —— 比
         原 bug 更难查。而 src 赋值是同步的：这一行之后，元素和这条片子就
         绑定了，之后任何 seek 都该按它的坐标系算。 */
      loadedId = row.id; loadingId = null;
      loadedFilmKey = filmKeyOf(row);
      loadedKind = st.curRaw === false ? "play" : "raw";
      /* scrub 跨段切进来时（见 seekFrac 的节流切换），画面直接对到播放头所在
         的帧 —— 不 seek 的话视频停在 0，timeupdate 会把播放头拽回段首，
         拖动中画面"闪回开头"。换算与 seekFrac 同一套口径（videoT0）。
         走 seek 队列而不是硬赋值（20261010 修）：此刻刚换完源，元数据多半
         还没就绪，硬赋值抛异常就白给；队列会在 loadedmetadata 补冲。 */
      {
        const r0 = row;
        const v0 = videoT0(r0);
        const to0 = Math.max(v0 + 1, int(r0 && r0.clip_to));
        if (r0 && (previewOnly || (st.frame >= v0 && st.frame <= to0))) {
          const fp0 = Number(info.fps) || 24;
          const f0 = previewOnly ? clamp(st.frame, int(r0.clip_from), to0 - 1) : st.frame;
          const sec = Math.max(0, (f0 - v0) / fp0);
          if (st.drag || previewOnly) {
            /* 拖动中**不抽垫图**（20261010bg）：一次抽帧 70~1100ms，而拖动
               跨段一秒能跨好几次 —— 前一次的目标帧图还在路上，后一次的已经
               换源了，先到的那张把画面垫成**上一个目标**的画面，于是接缝附近
               一路乱闪（"正放倒放不一致"看起来就更明显）。拖动中要的是跟手，
               不是不闪：照旧走"就位才出画"（等 seeked 落定才亮），只是不拿
               静态图铺底 —— 亮出来的第一帧就是目标帧本身，没有第二次换画。 */
            armImgOk = true;
            requestVideoSeek(sec, true);
          } else if (sec > 0.04) {
            /* 走 ARM（20261010at）：垫图换成**目标那一帧**，静态图与视频到位
               后的第一帧同源同帧，撤图那一刻没有"换画"可看 —— 详见 armedTo /
               revealVideo 的注释。这一步是消闪的另一半：没有它，段中帧的垫图
               → 目标帧的视频，中间仍是一次肉眼可见的跳。
               **连播接段不抽这张目标垫图**（20261010bj）：屏幕上已经由
               freezeCurrentFrame 定格住上一段最后一帧了，再抽一张目标帧只是把
               "一张定格"换成"另一张定格" —— 白等 70~1100ms，还在接缝中间多插
               一幅画。armImgOk 默认真，所以不抽也能放行：等 seeked 就位，视频
               直接换上来，全程仍然只有一次换画。 */
            if (!seamHold) {
              armPoster(path, Math.round(sec * fp0), int(row.updated), seq);
            }
            requestVideoSeek(sec, true);
          } else {
            requestVideoSeek(sec);
          }
        }
      }
      /* video 可见性交给 loadeddata：出第一帧前它还是黑的，此刻不标 ok ——
         垫图（img.bzf-ok）盖着，等 loadeddata 撤垫图、亮视频。 */
      el.play.style.display = "";
      el.badge.style.display = "";
      el.badge.textContent = `${info.width || "?"}×${info.height || "?"} · ${(info.fps || 24).toFixed(2)}fps`;
      el.cap.textContent = path.split(/[\\/]/).pop() || path;
      if (!previewOnly) {
        layout();          /* 拖动跨段只更新视频，不拉波形/缩略图 */
        void loadWaveFor({ film: path, playable: true, updated: int(st.info && st.info.mtime) }, seq);
      }
    } catch (err) {
      if (seq !== st.seq || st.dead) return;
      clearView();
      /* 读不出来≠轴没了：指针留在原地，规划照样可搓（20261010 修）。 */
      el.play.style.display = "";
      setPlayheadAbs(fracOfFrame(st.frame));
      el.cap.textContent = `读不了这条成片：${err.message}`;
      el.meta.className = "bzf-meta bzf-err";
    }
  }

  /* 波形按段记着（20261010 重做）：**每一**段自己的音频频谱都画在自己的
     窗口里，而不是只有选中段才有 —— 时间轴是整条片子的预览器，音频轴也该
     整条可读。缓存按「成片路径 + 档案 updated 时间戳 + bins」记：这段重跑过
     （updated 变了）就当没见过，来回点几段则命中缓存零请求。
     bins 自适应：按画布实际宽度 ×2（每像素一对峰谷）取，夹在 [240, 1600]。 */
  const WAVE_BINS_MIN = 240, WAVE_BINS_MAX = 1600;
  const waveBins = () => {
    const wpx = el.canvas.clientWidth || el.band?.clientWidth || 800;
    return Math.max(WAVE_BINS_MIN,
      Math.min(WAVE_BINS_MAX, Math.round(wpx * 2)));
  };
  const waveMemos = new Map();     // key -> { bins }
  let waveRev = 0;                // 波形数据版本，变了才允许重画
  let waveDrawSig = "";
  /* key 只按「成片+版本」、**不含 bins**：bins 随画布宽度实时变。若写进 key，
     加载瞬间（canvas 还没布局、clientWidth=0 → fallback 800）存的是一份 bins 的
     key，绘制时按实际宽度算出另一份 bins 的 key，waveFor 永远查不到 → 整条音频
     轴空白。绘制本就按窗口比例采样 bins（i0/m），bins 多少都能画，故与 bins 解耦。 */
  const waveKeyOf = (clip) =>
    `${clip.film}|${int(clip.updated) || 0}`;
  const waveFor = (clip) =>
    (clip && clip.film) ? (waveMemos.get(waveKeyOf(clip)) || null) : null;

  async function loadWaveFor(clip, seq) {
    if (!clip || !clip.playable || !clip.film) return;
    const key = waveKeyOf(clip);
    if (waveMemos.has(key)) return;
    try {
      /* 版本号同雪碧图：这段重抽过（updated 变了）就换个 URL，浏览器才不会
         拿上一版的频谱来画。 */
      const w = await getJSON(
        `${JOIN}/waveform?video=${encodeURIComponent(clip.film)}&bins=${waveBins()}`
        + `&v=${int(clip.updated) || 0}`);
      if (seq !== st.seq || st.dead) return;
      waveMemos.set(key, w);
      waveRev += 1;
      drawWave();
    } catch {
      /* 波形画不出来不挡预览，静默 */
    }
  }

  /** 全轴波形：把**每个有成片的段**的频谱都拉齐（串行 = 天然错峰，缓存命中
      零请求），齐了重画一次。 */
  async function loadAllWaves() {
    const seq = st.seq;
    for (const r of segSpans()) {
      if (seq !== st.seq || st.dead) return;
      await loadWaveFor(r.clip, seq);
    }
    if (seq === st.seq) drawWave();
  }

  function clearView() {
    exitWhole();
    resetSeekQueue();
    st.info = null; st.span = 0;
    haltPlayback();
    st.curRaw = true;      // 口径复位（下一条片没问过后端前按原片保守处理）
    /* 没有视频可播 = video 里没有可信的身份。不清的话 seekFrac 会拿一个**早已
       不存在**的 loadedId 去判定，画面冻在一条已经读不出来的片子上。 */
    loadedId = null; loadingId = null; loadedKind = null;
    /*这条成片没了，挂着等的"就位"也就没意义了 —— 别留个定时器在后台乱戳。 */
    cancelArm();
    resetBuffer();
    el.video.classList.remove("bzf-ok");
    el.img.classList.remove("bzf-ok");
    /* 播放头**不**跟着藏（20261010 修「指针突然不见了」）：它是**轴上的**
       东西，不是取景框里的东西 —— 轴上只要有规划（哪怕一段成片都没有）就
       该能搓，搓就得有指针。原来这里把指针藏了，而 loadVideo 的失败路径
       调完 clearView 没人把它放回来 —— 一次读片失败（重抽覆盖写同一个
       成片文件的瞬间，ffprobe 探到半截文件是常态）指针就永久消失。
       真该藏的只有「轴上什么都没有」的两种情况，refreshInner 自己负责。 */
    el.film.innerHTML = "";
    drawWave();
  }

  /** 清空整条时间轴与所有按「上一部片子」记的缓存（20261010br）。
      宿主点「新建整片」时调用 —— 旧片子的 /info 记忆、波形、预载视频、播放
      位置、选中段、接缝定格旗标全部作废，否则换片后仍按旧片判定（用户报的
      「新建整片后时间轴没复位」）。clearView 只清「当前这一条视频」，清不掉
      这些跨片子的缓存，所以这里把两件事一起做完。 */
  function reset() {
    cancelScrubRaf();
    press = null;
    resetSeekQueue();
    closeTransitionCard();
    st.seq++;                       // 作废所有在途请求
    st.film = null; st.cur = null; st.info = null; st.skipIds = null;
    st.frame = 0; st.span = 0; st.drag = false; st.curRaw = true;
    haltPlayback();
    userPick = null;
    exitWhole();        /* 整片预览模式一并退出（固定 videoA 的整片源随后续播放器归零） */
    prewarmed = "";
    infoMemo.clear();
    waveMemos.clear();
    /* 预载的离屏 video 指的都是旧片子的 URL，一并清掉 */
    for (const v of warmEls.values()) {
      try { v.removeAttribute("src"); if (v.parentNode) v.parentNode.removeChild(v); } catch { /* 忽略 */ }
    }
    warmEls.clear();
    /* 播放器归零：停、卸源、取消一切对位 / seek / 定格目标 */
    try { el.video.pause(); } catch { /* 已销毁 */ }
    /* 见 destroy() 里同一条：摘 src 之后必须 load()，解码缓冲才真的放掉 */
    try { el.video.removeAttribute("src"); el.video.load(); } catch { /* 忽略 */ }
    seekTarget = null;
    switchWant = null; switching = false;
    loadedId = null; loadingId = null; loadedKind = null;
    seamHold = false; seamFrozen = false; frzReady = null;
    cancelArm();
    /* 双缓冲：备用 video 装的是旧片下一段，连同缓冲状态一起清零、卸掉它的源 */
    try { resetBuffer(); } catch { /* 忽略 */ }
    try { const sb = standbyEl(); sb.pause(); sb.removeAttribute("src"); sb.load(); } catch { /* 忽略 */ }
    el.video.classList.remove("bzf-ok");
    el.img.classList.remove("bzf-ok");
    el.img.removeAttribute("src");
    el.film.innerHTML = "";
    /* 音频分段轴也清空：M4 改增量复用（waveEls）后，reset 不主动清就会残留
       旧片的分段块（用户报「新建整片后音频轴还暂留 3 段」）。 */
    if (el.waveSegs) el.waveSegs.innerHTML = "";
    waveEls.clear();
    /* 段块层与接缝胶囊当场清空（20261012）：新建工程 / 换片时旧片的"胶囊"必须
       立刻消失，不能等下一次 renderSegs。而 .bzf-rseam 挂在 **band** 上（不在
       segs 里），只 clear Map 会让它们变成永远删不掉的孤儿 —— 这正是"新建工程
       后轴上一直有两个胶囊"的来源。dropSegLayers 先摘 DOM 再清表。 */
    dropSegLayers();
    el.segs.innerHTML = "";
    /* 立刻重画一次：把空态占位（「还没有任何段落」）铺回轴上 —— 只留一条
       空白轴和"面板坏了"在视觉上没有区别。 */
    try { renderSegs(); } catch (_) { /* 布局还没就绪 */ }
    setPlayheadAbs(0);
    syncFoot();
  }

  /* ---------------------------------------------------------- 渲染 */

  /**
   * 全片总览的段落跨度：**每一段都画**，位置按它自己的规划时长（clip_from/
   * clip_to，后端按段 frame 累加），除以整部片子的规划总帧数（total_frames）。
   *
   * 关键：这里**不能**用 st.span（那条累积成片经 ffprobe 实测的帧数）——
   * st.span 只有在某一段真跑出成片、loadVideo() 读完 /info 之后才有值；还没
   * 渲染任何一段时它是 0，用它当分母会把段块推到屏幕外好几个屏宽，「＋ 接一段」
   * 之后轴上什么都看不见。而 total_frames 是「各段 frame 之和」，刚登记完
   * 一段就有值，跟渲染进度无关 —— 总览轴讲的是「整部片子的规划」，本来就该
   * 用它，而不是用「已经渲染到哪儿的实测」。
   *
   * 原来这里只画到「当前选中那一段为止」（upto = idx），是为旧版「点到第 k 段
   * 就只看到前 k 段」的累积成片视图写的；总览轴要一眼看完整部片子，必须全画。
   */
  function segSpans() {
    const film = st.film;
    if (!film || !film.clips || !film.clips.length) return [];
    const rows = [];
    for (let i = 0; i < film.clips.length; i++) {
      const c = film.clips[i];
      const from = int(c.clip_from);
      const to = Math.max(from + 1, int(c.clip_to));
      rows.push({ clip: c, i, from, to });
    }
    return rows;
  }

  /* 接缝评分：续接合成在真正拼的时候算出来的拟合残差，越小越顺。
     没有评分（第 1 段、或者这一段还没拼过）就是 null —— 这时候不画，
     而不是画成「满分」。假的好看比难看更害人。 */
  const SEAM_COLORS = { 顺: "#5ad38a", 还行: "#c8d35a", 看得出来: "#e8a34a", 跳: "#e05a5a" };

  function seamOf(c) {
    const v = c && c.seam_left;
    if (v === null || v === undefined || !isFinite(Number(v))) return null;
    const note = String(c.seam_left_note || "");
    const tag = (note.split("·")[0] || "").trim() || "还行";
    return { score: Number(v), tag, note, color: SEAM_COLORS[tag] || "#c8d35a" };
  }

  /* ================= 接缝（M3 简化版）=================
     接缝胶囊只表达两件事：
       ① 两段的「重叠帧」—— 生成承接多少帧（只读显示；帧数在双击段块左端 /
          接缝承接卡 seamCard 里改）；
       ② 「断链」开关 —— 断链后播放停在接缝、不连播。
     不再有硬切 / 溶解 / 淡变这类成片视觉转场。读走 opts.getTransition、
     写走 opts.onTransition，默认「链接」。 */
  const ICON_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1"/></svg>`;
  const ICON_UNLINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 14.5l-1 1a3.5 3.5 0 0 1-5-5l2-2a3.5 3.5 0 0 1 5 0"/><path d="M14.5 9.5l1-1a3.5 3.5 0 0 1 5 5l-2 2a3.5 3.5 0 0 1-5 0"/><path d="M3 3l18 18"/></svg>`;
  function transitionOf(clipId) {
    let t = null;
    try { t = opts.getTransition ? opts.getTransition(clipId) : null; } catch { t = null; }
    if (t && t.type === "unlink") return { type: "unlink" };
    return { type: "link" };
  }
  /* 接缝处两段「生成承接」的重叠帧数。20261108：四种特殊接法删除后，
     承接只发生在头部，恒读 trim_frames（不再有尾钉 trim_tail 分支）。 */
  function seamOverlapFrames(c) {
    return c ? Math.max(0, int(c.trim_frames)) : 0;
  }
  /* 胶囊显示 / 编辑用的承接帧数：优先宿主里**用户设置**的 cont.frames（意图，
     改了立刻反映），宿主没给回调或该段还没认领（返回 null）时回退 clip 实际
     裁剪帧 trim。 */
  function displayOverlapFrames(c) {
    if (opts.contFramesOf) {
      const n = int(opts.contFramesOf(c && c.id));
      if (isFinite(n)) return Math.max(0, n);
    }
    return seamOverlapFrames(c);
  }
  /* 承接帧格点：0（不承接）+ 17k+5（5, 22, 39 …），与后端 snap_guide_run、
     CONT_WINDOWS 同口径。步进按钮和自定义输入都在这序列上取/吸附。 */
  const CONT_STEPS = [0, 5, 22, 39, 56, 73, 90, 107, 124];
  function stepUpCont(n) {
    for (const s of CONT_STEPS) if (s > n) return s;
    return Math.max(5, n) + 17;
  }
  function stepDownCont(n) {
    for (let i = CONT_STEPS.length - 1; i >= 0; i--) {
      if (CONT_STEPS[i] < n) return CONT_STEPS[i];
    }
    return 0;
  }
  function snapContFrames(raw) {
    let n = Math.max(0, Math.min(4096, Math.round(Number(raw) || 0)));
    if (n > 0) n = Math.max(5, 5 + 17 * Math.floor((n - 5) / 17));
    return n;
  }
  async function saveLink(clipId, unlink) {
    if (!opts.onTransition) return;
    try {
      await opts.onTransition(clipId, unlink
        ? { type: "unlink", overlap: 0 } : { type: "cut", overlap: 0 });
      repaintSeams();
    } catch (e) { console.warn("[H3 Studio] 接缝状态没保存：", e); }
  }

  /* 接缝卡浮层（点外面 / Esc 关闭）。 */
  let trCard = null;
  function closeTransitionCard() {
    if (!trCard) return;
    const { card, onOut, onKey } = trCard;
    document.removeEventListener("pointerdown", onOut, true);
    document.removeEventListener("keydown", onKey, true);
    if (card.parentNode) card.parentNode.removeChild(card);
    trCard = null;
  }
  function positionCard(card, anchorRect) {
    card.style.visibility = "hidden";
    document.body.appendChild(card);
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = anchorRect.left;
    let y = anchorRect.bottom + 6;
    if (x + cw > window.innerWidth - 10) x = window.innerWidth - cw - 10;
    if (x < 10) x = 10;
    if (y + ch > window.innerHeight - 10) y = anchorRect.top - ch - 6;
    if (y < 10) y = 10;
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
    card.style.visibility = "";
  }
  function openLinkCard(clipRow, anchorRect) {
    /* 20261011 已停用：接缝操作收进右侧卡接缝组，菱形 / 段块接缝点击改走
       opts.onFocusSeam。本函数不再弹浮层（保留原实现仅作回滚参考）。 */
    return;
    closeTransitionCard();
    const clipId = clipRow.id;
    const linked = transitionOf(clipId).type !== "unlink";
    const card = document.createElement("div");
    card.className = "bzf-trcard";
    const title = document.createElement("div");
    title.className = "bzf-trc-title";
    title.innerHTML = `<span>接缝</span><span>第 ${clipRow.index} 段左接缝</span>`;
    card.append(title);

    /* 承接帧数（可编辑）：段间过渡 = 这一段开头承接上一段末尾多少帧。
       步进按钮 + 数字输入 + 常用档位；断链时整组禁用（断链不承接）。 */
    const ovN = displayOverlapFrames(clipRow);
    const canEdit = linked && !!opts.onContFrames;
    const ov = document.createElement("div");
    ov.className = "bzf-trc-ov";
    const ovH = document.createElement("div");
    ovH.className = "bzf-trc-ov-h";
    ovH.innerHTML = `<span>承接上一段</span>`
      + `<span>${ovN} 帧 · ${(ovN / 24).toFixed(2)}s</span>`;
    ov.append(ovH);

    const applyN = async (raw) => {
      const n = snapContFrames(raw);
      if (opts.onContFrames) {
        await opts.onContFrames(clipId, n);
        repaintSeams();
      }
      openLinkCard(clipRow, anchorRect);
    };
    /* 步进 − / 数字输入 / ＋ */
    const inpRow = document.createElement("div");
    inpRow.className = "bzf-trc-frames";
    const minus = document.createElement("button");
    minus.type = "button"; minus.textContent = "−";
    minus.disabled = !canEdit || ovN <= 0;
    minus.onclick = () => applyN(stepDownCont(ovN));
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.max = "4096"; inp.step = "1";
    inp.value = String(ovN);
    inp.disabled = !canEdit;
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") applyN(inp.value);
    };
    const plus = document.createElement("button");
    plus.type = "button"; plus.textContent = "+";
    plus.disabled = !canEdit;
    plus.onclick = () => applyN(stepUpCont(ovN));
    inpRow.append(minus, inp, plus);
    ov.append(inpRow);
    /* 常用档位 */
    const chips = document.createElement("div");
    chips.className = "bzf-trc-chips";
    [5, 22, 39, 56].forEach((n) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = String(n);
      b.disabled = !canEdit;
      if (n === ovN) b.setAttribute("aria-selected", "true");
      b.onclick = () => applyN(n);
      chips.append(b);
    });
    ov.append(chips);
    const ovHint = document.createElement("div");
    ovHint.className = "bzf-trc-ovhint";
    ovHint.textContent = canEdit
      ? "帧数越多越连贯，但重抽时动不了的帧也越多；0 = 不承接。重抽这一段后生效。"
      : (linked ? "当前环境改不了承接帧数。"
        : "已断链 —— 先恢复链接，才能设置承接帧数。");
    ov.append(ovHint);
    card.append(ov);

    /* 断链开关（全宽按钮，显示当前状态与点下去的结果）。 */
    const tg = document.createElement("button");
    tg.className = "bzf-trc-toggle" + (linked ? "" : " is-unlink");
    tg.innerHTML = linked
      ? `${ICON_LINK}<span>当前链接 · 播放连续 —— 点此断链</span>`
      : `${ICON_UNLINK}<span>当前断链 · 播放停在此 —— 点此恢复链接</span>`;
    tg.onclick = async () => {
      await saveLink(clipId, linked);
      openLinkCard(clipRow, anchorRect);
    };
    card.append(tg);

    /* 接缝评分（残差，越小越顺）。 */
    const seam = seamOf(clipRow);
    if (seam) {
      const sc = document.createElement("div");
      sc.className = "bzf-trc-score";
      sc.textContent = `接缝 ${seam.tag} · 残差 ${seam.score.toFixed(4)}（越小越顺，重抽后更新）`;
      card.append(sc);
    }

    positionCard(card, anchorRect);
    const onOut = (e) => { if (!card.contains(e.target)) closeTransitionCard(); };
    const onKey = (e) => { if (e.key === "Escape") closeTransitionCard(); };
    document.addEventListener("pointerdown", onOut, true);
    document.addEventListener("keydown", onKey, true);
    trCard = { card, onOut, onKey };
  }

  /* 接缝胶囊 + 重叠区重绘封装（接缝卡改动后调用）。 */
  function repaintSeams() {
    const rows = segSpans();
    const total = Math.max(1, int(st.film && st.film.total_frames));
    const w = el.segs.clientWidth || el.segs.offsetWidth || 1;
    paintSeams(rows, total, w);
    paintOverlaps(rows, total, w);
  }

  /* 段块按 clip id 复用，不再每次刷新整条推倒重建。
     重建的代价不在 DOM 本身，而在它顺手带走的那一屋缩略图：段块一重建，里面
     每个 <img> 都得再向服务端取一次帧（后端是 ffmpeg 抽帧 + 落盘缓存）。于是
     「点一下段」「拖一下窗口宽度」都变成几十个抽帧请求排队 —— 浏览器同域并发
     只有 6 条，整条轴连同整个节点一起卡住，这就是总览轴一动就假死的全部来源。
     现在：位置 / 状态 / 文字每次照刷（它们本来就会变），块体与里面的画面
     原样留着；要不要补新的缩略图由 renderStrip 的签名来定。 */
  const segEls = new Map();        // clipId -> 段块元素
  const seamEls = new Map();       // 段号 -> 段块边界细线
  const rseamEls = new Map();      // 段号 -> 标尺接缝节点（菱形）
  let scrubbed = false;            // 这一次按下是不是在拖播放头（搓动）
  let userPick = null;             // 用户亲手挑的那一段（刷新时的优先权，见 select）
  /* 拖动排序的会话态。null = 没在拖。一次拖动只认一个：拖起来的段块、
     它原来在几号位、它有多宽（让位的量）、以及当前算出来的落点。 */
  let reorder = null;
  /* 刚刚拖过一次排序。拖完松手浏览器还会补一个 click —— 那一下子不能再
     当"点选这一段"处理，否则拖完顺带把选中改到拖过的那段上（用户没要这个）。
     跟 scrubbed 是同一个套路：一个手势只兑现一种结果。 */
  let justReordered = false;
  /* 刚刚由 pointerup 完成过一次「点选」。click 是 pointerup 之后浏览器补发的，
     两条路都在就会把同一段选中做两遍（两遍 = 两次 /info + 两次换源），
     所以 click 兜底看到这个标记就让位。400ms 后自动清，避免旧标记吃掉下一次。 */
  let justPickedId = "";

  const clipById = (id) =>
    ((st.film && st.film.clips) || []).find((c) => c.id === id) || null;
  /* 段块在 segEls 里的键。renderSegs / paintSeg 写的是这个键，拖动排序
     回头找块时也必须用同一个 —— 写两处、哪天改一处就找不到了。 */
  const segKey = (c) => (c && (c.id || ("#" + c.index))) || "";
  /* 段块取色用的稳定下标：**按段落 id 哈希，不按下标**。
     以前用 (c.index - 1) % 12 —— 下标是"位置"，不是"身份"。一拖动排序，
     所有段的颜色就跟着位置全换一遍，用户对"我第 3 段是蓝的"的记忆当场作废；
     而且那种颜色跳变让重排看起来像"整个片子都换了"，其实是同一批段。
     颜色应当属于**段**（身份 = clip id），不属于位置。id 哈希在重排前后不变，
     于是"蓝的第 3 段"拖到第 7 位，它还是蓝的 —— 眼睛能跟着那段走。 */
  function segHueIndex(c) {
    const key = segKey(c);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return Math.abs(h) % SEG_COLORS.length;
  }
  /** 此刻能不能拖着段块改顺序。宿主没给 onReorder 就是不能。 */
  const sortable = () => !!(opts.onReorder && (!opts.canReorder || opts.canReorder()));

  function makeSegEl() {
    const d = document.createElement("div");
    const hd = document.createElement("div");
    hd.className = "bzf-seg-hd";
    const bd = document.createElement("div");
    bd.className = "bzf-seg-bd";
    d.append(hd, bd);

    /* 选中段块才浮在**块体正中间**的段操作图标（方案 B，20261011 用户定）：
       ○ 跳过 / ⧉ 复制配置到末尾 / ＋ 在此后插一段 / ✕ 删除。不挂 body、不超出块、
       不挡标尺接缝胶囊 —— 显隐完全由 .bzf-sel class + CSS 控制。
       20261026 起「跳过」也在这里（原段块右键里的第一项）：paintSeg 会按本段状态
       把 ○ 刷成 ◉ 并点亮，所以它不再是一颗"点了没反馈"的按钮。

       20261106：这段 absolute 图标在**窄段**上会被段块 overflow 裁掉，用户实测
       「每段太小会导致这些按钮看不到」。导演台传 hideInlineSegActions 时整组
       不创建，段级动作改由宿主的「当前段上下文条」承担（见
       csglide_cast_settings.js 的 .gcast-ctx-segacts）。不传这个开关的宿主
       保持原来的段内交互 —— 共享组件不替所有使用方做决定。
       paintWave 里查 .bzf-seg-act 的地方本来就有 if (sb) 保护，不创建不会报错。 */
    if (!opts.hideInlineSegActions) {
      const actions = document.createElement("div");
      actions.className = "bzf-seg-actions";
      [
        /* 跳过（20261026 从段块右键搬来）：○ = 参与渲染，◉ = 已跳过。
           图标与 title 由 paintSeg 按当前段状态刷新 —— 这里只给初始值。 */
        { k: "skip", t: "○", title: "跳过这一段（渲染时越过，保留配置）" },
        { k: "copy", t: "⧉", title: "完整复制这一段到末尾（提示词/参考图/画布/时长/全部参数照抄）" },
        { k: "add", t: "＋", title: "在此后插一段（新段承接这一段继续演）" },
        { k: "del", t: "✕", title: "删除这一段（连块、档案与磁盘成片一起删，不可恢复）" }
      ].forEach((a) => {
        const ab = document.createElement("button");
        ab.type = "button"; ab.className = "bzf-seg-act"; ab.textContent = a.t;
        ab.title = a.title; ab.dataset.act = a.k;
        /* pointerdown 拦住：点图标不能触发 band 搓动 / 段块拖排序判定 */
        ab.addEventListener("pointerdown", (e) => e.stopPropagation());
        ab.addEventListener("click", (e) => {
          e.stopPropagation();
          const c = clipById(d.dataset.clipId);
          if (c && opts.onSegAction) opts.onSegAction(a.k, c);
        });
        actions.appendChild(ab);
      });
      d.appendChild(actions);
    }
    /* 段级编辑入口。这两条原本挂在导演台「工程分段条」上，第二条轴撤掉
       之后搬到这里 —— 时间轴只剩这一条，段落级的改动必须能在块上直接做，
       否则「能看见这一段」和「能改这一段」就分家了。
       共享组件自己不知道这些操作是什么：续接合成不传这两个回调，就只是
       一个纯检视的时间轴。 */
    d.addEventListener("click", (e) => {
      e.stopPropagation();
      /* 搓动 / 拖段换位置松手那一下不是"点中它"，吃掉。 */
      if (scrubbed) { scrubbed = false; return; }
      if (justReordered) { justReordered = false; return; }
      if (justPickedId && justPickedId === d.dataset.clipId) { justPickedId = ""; return; }
      /* 兜底（20261023）：pointerup 那一下可能**根本没来** —— 段块每次刷新都被
         renderSegs 重建，pointer capture 跟着元素一起消失，随后那一下 pointerup
         就丢了，点选整体失效（现象：点每一段都毫无反应，控制台连 onPick 都不打）。
         click 是浏览器在 down/up 落在同一元素后补发的，比 pointerup 结实得多，
         这里补一次点选。pointerup 已经处理过的那一段刚被 justPickedId 挡掉。 */
      const row = segSpans().find((r) => r.clip.id === d.dataset.clipId);
      if (row) settleAtFrame(Math.round((row.from + row.to) / 2), true);
    });
    d.addEventListener("dblclick", (e) => {
      if (!opts.onRename) return;
      const c = clipById(d.dataset.clipId);
      if (!c) return;
      e.stopPropagation(); e.preventDefault();
      opts.onRename(c, d, e);
    });
    d.addEventListener("contextmenu", (e) => {
      if (!opts.onSegMenu) return;
      const c = clipById(d.dataset.clipId);
      if (!c) return;
      e.stopPropagation(); e.preventDefault();
      opts.onSegMenu(c, e);
    });
    /* ---- 拖着段块换顺序 ----
       这是"前移 / 后移"两个右键菜单项的下场（20261009）：一次只挪一位，
       十几段的片子要把第 12 段挪到第 2 位得右键十几次。改成拽着走，一次到
       位 —— 而且这正是剪辑软件里"挪片段"的手势，不用再教。
       按下先不动手：横向挪过几像素才算拖（否则点一下就成了拖，选中就没了）。
       stopPropagation 是必须的 —— band 上也认按下（那边是搓播放头），不拦住
       就会一次按下同时起拖和搓动。只有开排序时才拦；不开排序的宿主照旧搓动。 */
    /* ---- 拖着段块换顺序（延迟判定，20261011 修）----
       按下不立即拦截：先让 band 也收到 pointerdown（纯点击要靠 band 的
       pointerup → settleAtFrame 选中 / 跳帧）。只有横向挪过 REORDER_SLOP、
       确认是"搬段"，才 capture 接管并取消 band 的搓动；否则就是点选。 */
    /* ---- 段块手势：点击选中 / 拖动换序（d 自己捕获，20261011 重构）----
       旧"延迟判定"让 band 先收到 pointerdown 建搓动 press；真实鼠标下 band 与 d
       的横移阈值相同（都=4），那次 move 里 d 与 band 抢 setPointerCapture，d 常
       抢不到、后续 move 被 band 截走 → 段块拖不动（合成事件时序宽松才偶然成功）。
       现在 sortable 时 d 在 pointerdown 就 stopProp + setPointerCapture，move/up
       全归 d：横移超 SLOP = 换序；原地松手 = 点击，d 主动 settle 选中该段。
       搓动预览（scrub）仍在上方标尺行进行（剪辑器标准分工：标尺搓帧、段块选/搬）。 */
    let press0 = null;
    d.addEventListener("pointerdown", (e) => {
      justReordered = false;                         // 上次拖动的"余味"作废
      if (e.button !== 0) return;
      if (e.target.closest(".bzf-grip")) return;     // 右边缘归改时长
      if (e.target.closest(".bzf-seg-actions")) return; // 标题栏操作按钮自己处理
      /* 点选与「能不能拖排序」解耦（20261023）：原来这里 `if (!sortable()) return;`
         —— 排序关着时（渲染态、或宿主没给 onReorder）事件冒泡到标尺层，被当成
         「搓播放头」，于是 settle 走的是 forcePick=false 那条路，onPick(viaUser=false)
         当场 return：右侧设置卡 / 文案台 / 媒体架一个都不切，看着就是"点了没反应"。
         但点选是独立语义，凭什么依赖排序？这里一律拦住，只有 sortable() 时才
         允许开始拖（见 pointermove）。 */
      e.stopPropagation();                           // 拦住 band：不建搓动 press
      /* 段块拦截了冒泡、document 的"点外部关卡"收不到 —— 这里主动收起接缝卡 */
      document.querySelectorAll(".gcast-seam-winmenu").forEach((m) => {
        if (m._stopFollow) m._stopFollow();
        m.remove();
      });
      press0 = { x0: e.clientX, pid: e.pointerId };
      try { d.setPointerCapture(e.pointerId); } catch { /* 已捕获 */ }
      d.classList.add("bzf-press");
    });
    d.addEventListener("pointermove", (e) => {
      if (!sortable()) return;                       // 排序关着 → 只当点选，不许起拖
      if (press0 && !(reorder && reorder.el === d)) {
        if (Math.abs(e.clientX - press0.x0) < REORDER_SLOP) return;
        if (!beginReorder({ clientX: press0.x0 }, d)) { press0 = null; return; }
        reorder.moved = true;
        el.band.classList.add("bzf-reordering");
        e.preventDefault();                          // 别让文字被划出一片蓝
        cancelScrubRaf(); press = null; st.drag = false;
        el.band.classList.remove("bzf-scrubbing");
        el.play.classList.remove("is-scrub");
        paintReorder(e);
        return;
      }
      if (reorder && reorder.el === d) paintReorder(e);
    });
    d.addEventListener("pointerup", (e) => {
      const wasPress = press0;
      press0 = null;
      d.classList.remove("bzf-press");
      try { d.releasePointerCapture(wasPress ? wasPress.pid : e.pointerId); } catch { /* */ }
      if (reorder && reorder.el === d) { finishReorder(); return; }
      if (wasPress) {
        /* 原地松手 = 点击：定位并选中这一段（d 主动 settle，不再靠 band 冒泡） */
        const row = segSpans().find((r) => r.clip.id === d.dataset.clipId);
        if (row) {
          settleAtFrame(Math.round((row.from + row.to) / 2), true);
          /* 记一笔：浏览器随后补发的 click 别再重复选一次（见 justPickedId）。 */
          const cid = row.clip.id;
          justPickedId = cid;
          setTimeout(() => { if (justPickedId === cid) justPickedId = ""; }, 400);
        }
      }
    });
    d.addEventListener("pointercancel", () => {
      press0 = null;
      d.classList.remove("bzf-press");
      if (reorder && reorder.el === d) cancelReorder();
    });
    /* 拖右边缘改时长。只有宿主明确允许（导演台）才给把手 —— 续接合成
       那边改不了段落时长，摆个能拖的把手就是骗人。
       把手常驻 DOM、只按这一段的允许状态显隐：刷新时重建它会让正在拖的那
       一次丢掉 pointer capture，手一松就拖不动了。 */
    const g = document.createElement("div");
    g.className = "bzf-grip";
    g.title = "左右拖动改这一段的长度";
    g.style.display = "none";
    g.addEventListener("pointerdown", (e) => {
      if (g.style.display === "none") return;
      e.stopPropagation();
      e.preventDefault();
      const row = segSpans().find((r) => r.clip.id === d.dataset.clipId);
      if (row) startResize(e, row, d);
    });
    d.append(g);
    d._grip = g;
    return d;
  }

  /** 接缝转场胶囊：压在两段交界上。每个接缝都画（硬切是默认细线，溶解/淡变
      是胶囊，断链是缺口）；点击弹转场卡。同样按段号复用，避免越积越多。 */
  const overlapEls = new Map();     // 段号 -> 重叠区元素
  function paintSeams(rows) {
    const alive = new Set();
    for (const r of rows) {
      if (r.i < 1) continue;
      const seam = seamOf(r.clip);
      const unlinked = transitionOf(r.clip.id).type === "unlink";
      const ovN = displayOverlapFrames(r.clip);
      const bad = !!(seam && seam.tag === "跳");
      const key = String(r.clip.index);
      alive.add(key);
      const x = xOfFrame(r.from);
      /* 方案 B（20261011）：接法符号 + 帧数合并到标尺一个标记，段块不再画胶囊。
         20261108：四种特殊接法删除后，接法恒为「自动接续」；有承接帧就是
         默认顺序续写（→ + 帧数），断链 / 无承接帧则不画符号。 */
      const autoJoin = !unlinked && ovN > 0;
      const markSym = autoJoin ? "→" : "";
      const markName = autoJoin ? "自动接续" : "接缝";
      const tip = unlinked
        ? "断链：不接续、不连播 · 点击定位，胶囊卡里用「连播」恢复"
        : (ovN > 0
            ? `${markName} · 承接 ${ovN} 帧（${(ovN / 24).toFixed(2)}s）· 点击定位 · 右键胶囊改帧数`
            : "硬接缝（无承接帧）· 点击定位 · 右键胶囊改帧数");
      /* 点击：接缝操作已收进右侧「这一段」卡的接缝组，这里只选中该段并定位 /
         高亮接缝组（opts.onFocusSeam），不再弹独立转场卡浮层。 */
      const openHere = (e) => {
        e.stopPropagation();
        const row = clipById(e.currentTarget.dataset.clipId);
        if (row && opts.onFocusSeam) opts.onFocusSeam(r.clip.index, r.clip.id || "");
        else console.warn("[H3 Studio] 接缝胶囊点击未生效：时间轴快照里找不到段 "
          + (e.currentTarget.dataset.clipId || "(无 id)")
          + " —— 刷新一次监视器再试；若仍不行看控制台是否有 openSeamWindow 的提示");
      };

      /* 段块区域不再画竖条 / 色带（20261011 用户定）：接缝信息只留标尺标记，
         段块保持干净；旧 .bzf-seam 由函数末尾统一移除。 */

      /* —— 标尺区域：菱形 + 承接帧数（唯一文字标记与点击热区），不碰画面 —— */
      let q = rseamEls.get(key);
      if (!q || !q.isConnected) {
        q = document.createElement("div");
        /* 右键胶囊 = 直接编辑承接帧数（opts.onSeamWindow）；用 dataset 定位段，
           q 复用时不会引用到旧 row。 */
        q.addEventListener("contextmenu", (ce) => {
          ce.preventDefault(); ce.stopPropagation();
          if (!opts.onSeamWindow) return;
          const row = clipById(ce.currentTarget.dataset.clipId);
          if (row) opts.onSeamWindow(row.index, ce);
        });
        rseamEls.set(key, q);
        /* 挂 track（不挂 16px 高的 ruler、也不挂 band 滚动容器）：随内容滚动，
           热区向下扩到段块顶、右键好点 */
        el.track.appendChild(q);
      }
      q.dataset.clipId = r.clip.id || "";
      q.style.left = `${x}px`;
      q.className = "bzf-rseam"
        + (unlinked ? " is-unlink" : (ovN > 0 ? " is-link" : " is-cut"))
        + (bad ? " is-bad" : "");
      /* 复位 inline transform（上次 resize 平移过会残留），让 CSS 的 translateX(-50%)
         居中生效；q.style.left 已在上面按内容坐标写好。 */
      q.style.transform = "translateX(-50%)";
      /* q 重画 marker 时，把已打开的帧数卡取出、重画后挂回，避免缩放/刷新丢卡 */
      const keepMenu = q.querySelector(".gcast-seam-winmenu");
      q.innerHTML = `<i class="rs-d"></i>`
        + (!unlinked && ovN > 0 ? `<i class="rs-n">${markSym}${ovN}</i>` : "");
      if (keepMenu) q.appendChild(keepMenu);
      q.title = tip;
      q.onclick = openHere;
    }
    /* 段块竖条已停用：一次性清掉所有残留 .bzf-seam */
    for (const [k, m] of Array.from(seamEls)) { m.remove(); seamEls.delete(k); }
    for (const [k, q] of Array.from(rseamEls)) {
      if (!alive.has(k)) { q.remove(); rseamEls.delete(k); }
    }
    /* 幽灵胶囊清扫（20261012）：换工程 / 片子清空时，rseamEls 被 clear() 掉而
       .bzf-rseam 挂在 **band** 上（不是 segs），innerHTML="" 扫不到它们 → 菱形
       留在轴上没人认领，换工程后一直显示（"新建工程后一直有两个胶囊"）。 */
    sweepGhostMarks();
  }

  /** 不在任何复用表里的接缝/重叠标记 = 孤儿，一律从 DOM 摘掉。
      正常路径靠上面 alive 比对就够了，这一层是兜底：历史上已经丢掉引用的
      节点、以及别处半路插进来的同款节点，都不该留在轴上。 */
  function sweepGhostMarks() {
    const owned = new Set();
    for (const v of rseamEls.values()) owned.add(v);
    for (const v of seamEls.values()) owned.add(v);
    for (const v of overlapEls.values()) owned.add(v);
    for (const host of [el.track, el.band, el.segs]) {
      if (!host) continue;
      host.querySelectorAll(".bzf-rseam,.bzf-seam,.bzf-overlap").forEach((n) => {
        if (!owned.has(n)) n.remove();
      });
    }
  }

  /** 整层清空（轴上一根都不留）。三处调用点（空轴 / 没片子 / 没分段）过去只
      clear() 了 Map —— Map 一清就丢了 DOM 的唯一引用，band 上的接缝菱形变成
      永远删不掉的孤儿（换工程后残留旧工程的胶囊）。这里**先摘 DOM 再清表**，
      并顺手把历史孤儿一起扫掉。 */
  function dropSegLayers() {
    for (const [, d] of Array.from(segEls)) d.remove();
    for (const [, m] of Array.from(seamEls)) m.remove();
    for (const [, q] of Array.from(rseamEls)) q.remove();
    segEls.clear(); seamEls.clear(); rseamEls.clear();
    sweepGhostMarks();
    /* 段块签名同步作废：换工程后段 id 会复用，留着旧签名会让新段跳过 paintSeg */
    renderSegs.__seamSig = "";
  }

  /** 重叠区：链接且有重叠帧时，在接缝两侧画半透明区，宽度=重叠帧数。 */
  function paintOverlaps() {
    /* 段块重叠色带已停用（20261011 用户定）：重叠帧只在标尺标记上以数字体现，
       段块不画色带；清掉所有残留 .bzf-overlap。 */
    for (const [k, o] of Array.from(overlapEls)) { o.remove(); overlapEls.delete(k); }
  }

  function paintSeg(d, c, x, ww, seam, prevClip) {
    d.className = "bzf-seg"
      + (c.id === st.cur ? " bzf-sel" : "")
      + (c.playable ? "" : " bzf-none")
      + (c.pending ? " bzf-pend" : "")
      + (c.has_latent === false ? " bzf-nolatent" : "")
      + (isSkipped(c) ? " bzf-skip" : "");
    d.style.left = `${x}px`;
    d.style.width = `${ww}px`;
    /* 拖动排序留下的位移是**临时**的：一次重排之后所有段的 left/width 都按新
       顺序重算过了，那段 translate 必须撤掉，否则块会歪在旧位置旁边。 */
    d.style.transform = "";
    /* 段色写两档进 CSS 变量。**只写原料，不写结果**：
       --bz-seg-lo* 是暗色（常态）、--bz-seg-hi* 是亮色（选中）。
       真正被 background 读的 --bz-seg / --bz-seg-bd1 / --bz-seg-bd2 由
       样式表赋值（见 .bzf-seg 与 .bzf-seg.bzf-sel）—— 因为这里是 inline
       样式，inline 会压过样式表，直接写结果就等于把"选中"那一档作废。
       占位文字（「待生成」）恒用亮色 —— 暗块上它得读得清，亮块上它本来
       就是亮的，两态通用。 */
    const segColor = SEG_COLORS[segHueIndex(c)];
    const segHi = SEG_COLORS_HI[segHueIndex(c)];
    d.style.setProperty("--bz-seg-lo", segColor);
    d.style.setProperty("--bz-seg-hi", segHi);
    /* 块体的两档渐变端点。旧版底端只有 11%（1c），新档色相本来更足，
       底端抬到 16%（28）/ 选中档 19%（30）：暗档不再发黑，亮档渐变更顺。 */
    d.style.setProperty("--bz-seg-lo-bd1", segColor + "59");
    d.style.setProperty("--bz-seg-lo-bd2", segColor + "28");
    d.style.setProperty("--bz-seg-hi-bd1", segHi + "59");
    d.style.setProperty("--bz-seg-hi-bd2", segHi + "30");
    d.style.setProperty("--bz-seg-ph", segHi);
    d.style.setProperty("--bz-seg-st", segColor + "24");
    d.dataset.clipId = c.id || "";
    /* 还没成片就没有画面可取 —— 路径一并清空，免得缩略图拿上一次的路径
       去抽帧（那会抽出一堆永远对不上的旧画面）。 */
    d.dataset.film = c.playable ? (c.film || "") : "";
    /* 这一段档案的写入时间戳。重抽是**覆盖**同一个成片路径 —— 光看路径分不出
       新旧，段块画面的签名必须带上它，重抽之后图才会重取（见 renderStrip）。 */
    d.dataset.upd = String(int(c.updated));
    d.dataset.frames = String(Math.max(1, int(c.frames)));
    /* 这一段在**自己的成片**里占哪一截（给雪碧图采样窗口用，见 renderStrip）。
       film_frames 是成片实测帧数：它盖到 clip_to 说明这条成片是累积片（前 k
       段拼起来的），段块就只该采 [clip_from, clip_to) 这一截 —— 不传窗口会把
       整部片挤进一个块里，每段长得一模一样。 */
    d.dataset.from = String(int(c.clip_from));
    d.dataset.to = String(int(c.clip_to));
    d.dataset.fframes = String(int(c.film_frames));
    /* 承接重叠的**有效**帧数（净长口径，后端 film_summary 已夹好）。雪碧图
       采样窗口用它跳过视频开头的重叠段 —— 那截是照上一段尾巴重绘的，块里
       不该再画一遍（见 spriteWin）。 */
    d.dataset.trim = String(Math.max(0, int(c.trim_frames)));
    /* 段号落进 dataset：宿主的段级操作（改名 / 菜单）要按它反查这一块，
       不然只能在 DOM 里按序号数，重排一次就错。 */
    d.dataset.seg = String(c.index);
    const noLat = c.has_latent === false;

    d.title = `第 ${c.index} 段 · ${c.frames} 帧`
      + (c.playable ? "" : " · 还没有成片")
      + (isSkipped(c) ? " · 已跳过（不参与渲染）" : "")
      + (c.pending ? ` · 待办：${PEND_TEXT[c.pending] || c.pending}` : "")
      + (seam ? ` · 接缝${seam.tag}（${seam.score.toFixed(4)}）` : "")
      + (c.takes > 1 ? ` · 版本 ${c.take}/${c.takes}（右键可切换）` : "")
      + (c.trim_frames ? ` · 续接窗口 ${c.trim_frames} 帧` : "")
      + (c.trim_tail ? ` · 末尾钉住 ${c.trim_tail} 帧（接下一段的头）` : "")
      + (noLat ? "\n⚠ 没有潜空间档案（外部导入）· 只能缩短，加长与重抽做不到" : "")
      + (sortable() ? "\n⇄ 左右拖动这一段可以改顺序（原「前移 / 后移」已改成拖着走）" : "")
      + (opts.onRename ? "\n双击块可改名" : "");

    /* 段块头部三样东西：编号 / 名字 / 时长。文字每次照刷 —— 重建这几行不值钱，
       重建块体（连带缩略图）才值钱。 */
    const hd = d.querySelector(".bzf-seg-hd");
    hd.replaceChildren();
    const noEl = document.createElement("span");
    noEl.className = "bzf-no";
    noEl.textContent = `${c.index}`;
    hd.append(noEl);
    /* 后端在没有名字时会给一个「第 N 段」的兜底名。那种名字不要显示 ——
       块上已经有编号了，「3 第 3 段」是同义反复，白占半块地方。 */
    const autoName = `第 ${c.index} 段`;
    if (c.name && c.name !== autoName) {
      const nmEl = document.createElement("span");
      nmEl.className = "bzf-nm";
      nmEl.textContent = c.name;
      hd.append(nmEl);
    }
    const durEl = document.createElement("span");
    durEl.className = "bzf-du";
    /* 块上显示**净长**秒数（= 块宽度的语义）：完整帧数含承接重叠，比块宽
       多出一段 —— 数字和块对不上会让人以为显示错了。接续段必须用 netOfTotal
       扣掉 trim 再取整，拿总长取整会比设置卡多显示一段承接重叠（约 2 秒）；
       取整与设置卡共用 secsIntOfFrames，同一帧数不会两处显示成两个数。 */
    durEl.textContent = `${secsIntOfFrames(netOfTotal(int(c.frames), int(c.trim_frames)))}s`;
    hd.append(durEl);
    /* 抽过多个版本的段在块上标 v(k/n)：这是「这一段换过镜头」唯一的视觉
       记号。只有一个版本时不标 —— 满屏 v1/1 是噪音。 */
    if (c.takes > 1) {
      const v = document.createElement("span");
      v.className = "bzf-v";
      v.textContent = `v${c.take}/${c.takes}`;
      hd.append(v);
    }
    /* 接法符号 + 帧数已移到标尺标记（方案 B），段块色头不再画胶囊，帧数只出现一次。 */

    /* 块体：只在**还没有内容**时给占位。已经铺了缩略图的块整块留着不动 ——
       这才是「刷新不卡」的关键。成片没了（重跑覆盖失败等）才把旧画面撤掉。 */
    const bd = d.querySelector(".bzf-seg-bd");
    const hasArt = bd.querySelector(".bzf-thumb-img");
    if (!c.playable && hasArt) { bd.innerHTML = ""; delete bd.dataset.tsig; }
    if (!bd.querySelector(".bzf-thumb-img") && !bd.querySelector(".bzf-ph")) {
      bd.innerHTML = "";
      const ph = document.createElement("span");
      ph.className = "bzf-ph";
      if (!c.playable) {
        /* 未生成：占位不是一片黑 —— 段色斜纹打底，正中「待生成」，下面一行
           小字说清补位规则：这段跑出成片后就用成片画面填进来。 */
        const t = document.createElement("span");
        t.textContent = "待生成";
        const sub = document.createElement("span");
        sub.className = "bzf-ph-sub";
        sub.textContent = "成片出来后补位";
        ph.append(t, sub);
      } else {
        ph.textContent = "成片";
        ph.style.opacity = ".28";
      }
      bd.append(ph);
    }
    if (d._grip) {
      d._grip.style.display = (opts.canResize && opts.canResize(c)) ? "" : "none";
    }
  }

  /* 时间刻度带。刻度按**绝对帧号 / fps** 定位 —— 它是全片坐标，跟段块共用
     同一把尺子（renderSegs 传进来的 total 与 w），所以刻度永远和下面的段对齐。
     步长按全片时长自适应：短片 5 秒一格，长片 10/15 秒一格，别在 30 秒的片
     子上挤满 60 根线。整 3 根给一根长线 + 标签（0:15 这种），短线只做视觉。 */
  let _rulerSig = "";
  function renderRuler(total) {
    if (!el.ruler) return;
    const fps = (st.film && Number(st.film.fps)) || 24;
    /* 几何/总长/尺子没变就一根刻度都不重建（silent 后台刷新风暴里的固定成本） */
    const rsig = `${total}|${tEngine.getPx().toFixed(5)}|${fps}`;
    if (rsig === _rulerSig) return;
    _rulerSig = rsig;
    const dur = total / Math.max(1, fps);
    const step = dur >= 180 ? 15 : (dur >= 60 ? 10 : 5);
    const majorEvery = 3;
    const mk = (s, k) => {
      const t = document.createElement("div");
      t.className = "bzf-tick" + (k % majorEvery === 0 ? " major" : "");
      /* 像素/帧：第 (s*fps) 帧的横坐标 = 帧 × pxPerFrame */
      t.style.left = `${xOfFrame(s * fps)}px`;
      if (k % majorEvery === 0) {
        const m = Math.floor(s / 60);
        t.dataset.t = `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")}`;
      }
      el.ruler.appendChild(t);
    };
    /* 刻度元素复用：innerHTML 重铺一遍比 diff 简单 —— 刻度最多几十根，代价
       可忽略，而 diff 要按位置对号、重排后还容易留残线。 */
    el.ruler.innerHTML = "";
    for (let s = 0, k = 0; s <= dur + 1e-6; s += step, k++) mk(s, k);
  }

  /* 尺子未就绪时的自动补画：有段但 clientWidth 还是 0（面板刚创建/折叠展开/
     热重建那一刻），pxPerFrame=0 画出来就是"所有段 left=0、宽 2px、全挤左边"。
     这时不画、等下一帧布局就绪再补；ResizeObserver 也会补，这里双保险。
     refitQueued 保证一轮只排一次，避免 hidden 窗口 / 反复刷新里空转。 */
  let refitQueued = false;
  // 退避计数：尺子一直「未就绪」时，不能每帧空转（requestAnimationFrame 每
  // 帧都跑一次全量 layout，段越多越慢，实测 87ms 一路飙到 1193ms，把主线程
  // 占满 —— 这正是「拖节点放不下」的元凶）。「就绪」最终由 ResizeObserver 在
  // 尺寸真正变化时驱动，这里的主动重试只需兜住面板刚创建那几帧，之后退避。
  let refitBackoff = 0;
  function scheduleRefit() {
    if (refitQueued) return;
    refitQueued = true;
    const doIt = () => {
      if (refitQueued) {
        refitQueued = false;
        if (st.mode !== "collapsed") {
          if (!tEngine.isFitted()) {
            refitBackoff = Math.min(refitBackoff + 1, 8);
            const delay = refitBackoff <= 2
              ? 16                       // 前两帧：面板刚展开，快速兜底
              : Math.min(1000, 200 * (refitBackoff - 1));  // 之后 200/400/…/1000ms 退避
            setTimeout(scheduleRefit, delay);
            return;
          }
          refitBackoff = 0;
          layout();
        }
      }
    };
    requestAnimationFrame(doIt);
    setTimeout(doIt, 120);   /* hidden 页面 rAF 不跑时的兜底 */
  }

  function renderSegs() {
    const rows = segSpans();
    /* 能拖排序时给这一层挂个类：光标变 grab，一眼看出"这些块是能搬的"。
       不能拖（续接合成 / 正在渲染）就没有这个光标 —— 手型光标是承诺。 */
    el.segs.classList.toggle("bzf-sortable", sortable());
    const total = Math.max(1, int(st.film && st.film.total_frames));
    /* 像素/帧：先确保尺子存在（首次按填满算），再把内容轨宽度设成总片长×px */
    ensureScale();
    /* 有段但尺子没建立（clientWidth=0 的塌缩瞬间）：绝不画挤成一团的中间态，
       等布局就绪下一帧补画。此时保留已有段块（上一帧几何），不闪不挤。 */
    if (rows.length && !tEngine.isFitted()) { scheduleRefit(); return; }
    if (el.track) el.track.style.width = `${wOfFrames(total)}px`;
    renderRuler(total);
    if (!rows.length) {
      dropSegLayers();
      el.segs.innerHTML = "";
      renderSegs.__seamSig = "";
      /* 空态文案：一条空白轴和"面板坏了"在视觉上没有区别。把路写在轴上 ——
         段块从哪儿来、为什么还没出现，一眼就有答案。 */
      const ph = document.createElement("div");
      ph.className = "bzf-empty";
      const card = document.createElement("div");
      card.className = "bzf-emp-card";
      const empTt = document.createElement("div");
      empTt.className = "bzf-emp-tt";
      empTt.textContent = "还没有任何段落";
      const empSteps = document.createElement("div");
      empSteps.className = "bzf-emp-steps";
      ["在工程面板填好片名", "点下面按钮接出第一段", "写好提示词，点「全部渲染」"]
        .forEach((s, k) => {
          const sr = document.createElement("div");
          sr.className = "bzf-emp-step";
          const n = document.createElement("span");
          n.className = "bzf-emp-n";
          n.textContent = String(k + 1);
          const x = document.createElement("span");
          x.textContent = s;
          sr.append(n, x);
          empSteps.append(sr);
        });
      const cta = document.createElement("button");
      cta.className = "bzf-emp-cta";
      cta.textContent = "＋ 接第一段";
      cta.title = "接出第一段（需要先填好片名）";
      /* 别让这一下穿透到画布/轴上变成别的手势 */
      cta.addEventListener("click", (e) => {
        e.stopPropagation();
        if (opts.onAddFirstShot) opts.onAddFirstShot();
      });
      card.append(empTt, empSteps, cta);
      ph.append(card);
      el.segs.appendChild(ph);
      /* 空轴也要喊宿主：导演台的「分段登记自愈」靠 onAfterSegs 核对工程与
         档案 —— 空档案恰恰是最需要核对（补登记）的场合。 */
      if (opts.onAfterSegs) opts.onAfterSegs(rows, true);
      return;
    }
    /* 有段了就摘掉空态占位：它 pointer-events:none 挡不住点击，但段块体是
       半透明的，这行字会**透过块体**显示出来（实测）。 */
    const staleEmpty = el.segs.querySelector(".bzf-empty");
    if (staleEmpty) { staleEmpty.remove(); }
    const alive = new Set();
    /* changed：本轮是否真有段块增删 / 几何内容变化。没有变化时（典型：store
       后台推送的同一份账），接缝层不重画、宿主不被要求 setDirtyCanvas 整画布
       重排 —— LiteGraph 下 DOM widget 标脏整排是"联动一次卡一下"的 L3 主因。 */
    let changed = !!staleEmpty;
    for (const r of rows) {
      const c = r.clip;
      const id = c.id || ("#" + c.index);
      alive.add(id);
      const x = xOfFrame(r.from);
      const ww = Math.max(2, wOfFrames(r.to - r.from));
      let d = segEls.get(id);
      if (!d || !d.isConnected) {
        d = makeSegEl();
        segEls.set(id, d);
        el.segs.appendChild(d);
        changed = true;
      }
      /* 接缝就落在这段的左边缘 —— 这里是「上一段」与「这一段」交界的地方。
         第 1 段没有左边可接的东西，seamOf 返回 null，不画。 */
      const seam = r.i > 0 ? seamOf(c) : null;
      const prev = r.i > 0 ? rows[r.i - 1].clip : null;
      /* 只重绘变动的段（20261010）：paintSeg 每次要重写类名、7 个样式变量、
         色头三个 span 和整条 title —— 10+ 段的轴一次刷新就是几百次 DOM 写。
         几何与内容打包成签名，没变就只同步选中类，一个字节都不碰。
         选中态**不进**签名：它只是一次 classList.toggle，必须即时跟手。 */
      const sig = `${x.toFixed(1)}|${ww.toFixed(1)}|${int(c.frames)}|${c.name || ""}`
        + `|${c.playable ? 1 : 0}|${c.pending || ""}|${isSkipped(c) ? 1 : 0}`
        + `|${c.has_latent === false ? 1 : 0}|${int(c.trim_frames)}`
        + `|${c.takes || 1}/${c.take || 1}|${c.film || ""}`
        // 20261108：接法写入口已删，pin_mode / disp_pin_mode 恒为 source；
        // 仍保留在签名里，只为老工程档案的字段变化能触发一次重画。
        + `|${seam ? seam.score : "-"}|${c.pin_mode || ""}|${c.disp_pin_mode || ""}`
        + `|${c.head_unlink ? 1 : 0}|${int(c.trim_tail)}`;
      d.classList.toggle("bzf-sel", c.id === st.cur);
      if (d.__bzfSig === sig) continue;
      d.__bzfSig = sig;
      changed = true;
      paintSeg(d, c, x, ww, seam, prev);
    }
    /* 消失的段（删了 / 换了片子）连元素一起带走，别留下点不到的残块 */
    for (const [id, d] of Array.from(segEls)) {
      if (!alive.has(id)) { d.remove(); segEls.delete(id); changed = true; }
    }
    /* 接缝层的显示签名（20261012）：承接帧数读的是**前端意图**
       （displayOverlapFrames → contFramesOf → state.cont.frames），改帧数
       不写档案 —— 段块签名（档案字段）不变 → changed 恒 false → paintSeams
       被跳过，标尺上的帧数永远停在旧值。给它单独一个签名：帧数 /
       断链 / 评分任一显示值变了就重画接缝层。 */
    let seamSig = "";
    for (const r of rows) {
      if (r.i < 1) continue;
      const seam = seamOf(r.clip);
      seamSig += `${r.clip.index}~${displayOverlapFrames(r.clip)}`
        + `~${transitionOf(r.clip.id).type}~${r.clip.disp_pin_mode || r.clip.pin_mode || ""}`
        + `~${seam ? seam.tag : "-"};`;
    }
    if (seamSig !== renderSegs.__seamSig) {
      renderSegs.__seamSig = seamSig;
      changed = true;
    }
    /* 接缝/重叠层只在账面真变了时重画（内部各自增量，N 小，但能省则省） */
    if (changed) {
      paintSeams(rows);
      paintOverlaps();
    }
    renderWaveSegs(rows);
    /* 裁切层几何跟着段块行走（节点宽度 / 字体变化后也始终对齐）。 */
    if (cutMode) syncCutlayerGeom();
    /* 画完了通知宿主（导演台）。宿主要往段块上加自己的标记（渲染范围亮条、
       正在渲染脉冲、与上一段断链的琥珀虚线），而 paintSeg 每次是**整体重写**
       className 的 —— 宿主那些类在这一步被抹掉。以前宿主是靠 MutationObserver
       盯这里的子节点变动来补；但只要这一次重绘没有增删节点（点一下段、拖一下
       窗口就是这种），观察器不触发，标记就永久消失 —— 这正是"那些条子时有时
       无、续接看不见"的根因。给它一个明确的画完回调，比猜什么时候该重绘稳。
       第二参 changed：本轮段块有无增删/几何内容变化 —— 没变（后台同账推送）
       时宿主不必 setDirtyCanvas 整画布重排（20261012 方案C）。 */
    if (opts.onAfterSegs) opts.onAfterSegs(rows, changed);
  }

  /* 音频轴：按段着色的音频占位块，与上排段块同色同跨度 —— 上下两排颜色
     一一对应。选中段的波形由 drawWave 叠画在 canvas 上，没波形时这层
     也让"音频在整条片里的位置"看得见。 */
  const waveEls = new Map();
  let waveRows = [];
  function renderWaveSegs(rows) {
    waveRows = rows || [];
    if (!el.waveSegs) return;
    /* 增量复用：按 clip id 复用元素，只更新几何/选中态，消失的段带走。
       像素/帧定位（与上轨同口径、天然对齐）。 */
    const aliveW = new Set();
    for (const r of rows) {
      const c = r.clip;
      const id = c.id || ("#" + c.index);
      aliveW.add(id);
      const sel = c.id === st.cur;
      let d = waveEls.get(id);
      if (!d || !d.isConnected) {
        d = document.createElement("div");
        waveEls.set(id, d);
        el.waveSegs.appendChild(d);
      }
      d.style.left = `${xOfFrame(r.from)}px`;
      d.style.width = `${Math.max(2, wOfFrames(r.to - r.from))}px`;
      /* 拖动改时长时给后续音频块写过 translateX(dPx)，重画必须像 paintSeg 一样
         复位 transform，否则 refresh 后音频块还停在平移后的位置 → 音频轨错位。 */
      d.style.transform = "";
      /* 工具条那颗 ○/◉ 跟着本段状态走（20261026）。paintSeg 每次重绘都跑，
         段块本身是复用的 —— 不在这里刷就会停在上一段的图标上。 */
      {
        const sb = d.querySelector('.bzf-seg-act[data-act="skip"]');
        if (sb) {
          const sk = isSkipped(c);
          sb.textContent = sk ? "◉" : "○";
          sb.title = sk ? "恢复参与渲染（当前被跳过）" : "跳过这一段（渲染时越过，保留配置）";
          sb.classList.toggle("on", sk);
        }
      }
      d.style.background = (sel ? SEG_COLORS_HI : SEG_COLORS)[segHueIndex(c)]
        + (sel ? "73" : "59");
      d.className = sel ? "bzf-wcur" : "";
      d.title = `第 ${c.index} 段 · 音频` + (sel ? "（当前段）" : "");
    }
    for (const [id, d] of Array.from(waveEls)) {
      if (!aliveW.has(id)) { d.remove(); waveEls.delete(id); }
    }
  }

  /* ---- 拖边缘改时长 ---- */

  let resizing = null;

  /* 吸附到 H3 的 17k+5 帧网格，与后端 snap_frames 同口径。算法只在
     csglide_length.js 的 totalOfNet 里留一份，这里不再抄第二遍。 */
  function snapH3(n) { return totalOfNet(n, 0); }
  /* 下一个更大的格点（气泡提示"还差几帧到下一格"用）。当前已到顶就返回自己。 */
  function BASE_GRID_UP(n) {
    const v = Math.round(Number(n) || 0);
    const out = v + 17;
    return out > 719 ? v : out;
  }

  function startResize(e, row, segEl) {
    const vp = el.band.clientWidth;
    /* clientWidth=0（布局未完成 / 节点塌缩）时启动会让 pxPerFrame 趋近 0、
       拖动量被放大成几百上千帧，宽度直接算飞。等布局好了再拖。 */
    if (!vp) return;
    ensureScale();
    /* 一次性缓存所有几何（拖只读它、不重算、不查 DOM）：
       scale=画布缩放；每段记初始 left(帧)/净长 + seg/rseam/wave 元素引用。 */
    const br = el.band.getBoundingClientRect();
    const scale = br.width ? br.width / vp : 1;
    const items = segSpans().map((r) => ({
      r,
      from0: r.from,
      net0: r.to - r.from,
      seg: segEls.get(r.clip.id || ("#" + r.clip.index)),
      rseam: rseamEls.get(String(r.clip.index)),
      wave: waveEls.get(r.clip.id || ("#" + r.clip.index)),
    }));
    const trimN = Math.min(int(row.clip.trim_frames) || 0,
      Math.max(1, int(row.clip.frames) || 1));
    resizing = {
      row, segEl, x0: e.clientX, scale, items,
      dragIndex: row.i, net0: row.to - row.from, trimN,
      baseTotal: totalFrames(), lastKey: "",
    };
    /* setPointerCapture 容错：合成事件/个别环境无活动指针会抛 NotFoundError，
       不能让它中断 resizing（resizing 已在上一行设好）。真实指针不受影响。 */
    try { segEl.setPointerCapture?.(e.pointerId); } catch (_) { /* 忽略 */ }
    /* 拖动期间接缝位置会过期（它记的是旧边界），先藏起来，松手刷新后再画。
       resizing 类同时关掉 .bzf-seg 的 transform 过渡（拖时要零延迟跟手）。 */
    el.band.classList.add("bzf-resizing");
    /* 起始气泡同样报净长（与拖动中一致，别一开始就说个和块宽不符的数）。 */
    const fps0 = (st.film && Number(st.film.fps)) || 24;
    const net0Show = netOfTotal(int(row.clip.frames), trimN);
    showTip(segEl, `${net0Show} 帧 · ${secsIntOfFrames(net0Show, fps0)}s`
      + (trimN ? `（段总长 ${row.clip.frames} 帧 · 含 ${trimN} 帧承接重叠）` : ""));
  }

  function showTip(segEl, text) {
    /* 挂 track（不挂 band 滚动容器）：随内容滚动，气泡不被裁剪；
       位置 = 段块右缘（内容坐标）。 */
    let t = el.track.querySelector(".bzf-tip");
    if (!t) {
      t = document.createElement("div");
      t.className = "bzf-tip";
      el.track.append(t);
    }
    t.textContent = text;
    t.style.left = `${xOfFrame(segElOffsetFrame(segEl))}px`;
    t.style.top = `${el.segs.offsetTop + el.segs.offsetHeight}px`;
    t.style.display = "";
  }
  /* 段块右缘所在的全片帧号（showTip 用；从 dataset 读，避免 offsetWidth 强排）。 */
  function segElOffsetFrame(segEl) {
    const from = int(segEl.dataset.from);
    const to = int(segEl.dataset.to);
    return to || from;
  }

  let resizeRaf = 0;
  function moveResize(e) {
    if (!resizing) return;
    /* 按帧节流：pointermove 每秒上百次，合并到 rAF 就是"每帧跟手"。
       setTimeout 兜底：页面处于 hidden（窗口最小化/后台）时浏览器不跑 rAF，
       只靠 rAF 会让拖动手势彻底不动；100ms 兜底强制刷一次（前台时 rAF 先到、
       resizeRaf 清零，兜底不会触发）。 */
    if (resizeRaf) return;
    const ev = e;
    const fire = () => { if (resizeRaf) { resizeRaf = 0; applyResize(ev); } };
    resizeRaf = 1;
    requestAnimationFrame(fire);
    setTimeout(fire, 100);
  }

  function applyResize(e) {
    if (!resizing) return;
    const { x0, scale, items, dragIndex, net0, trimN } = resizing;
    /* 净长变化（帧）：视口像素 dx 先除画布缩放、再除全局 px/帧。
       提交值 = 吸附 H3 的 17k+5 网格（与后端同口径）。
       ⚠ 视觉**也必须走吸附值**（netNow），不能跟手用原始值：H3 帧数只能落
       在 17k+5 格点上（5/22/39/…/90/107/124…），从 90 拖到 107 之间的 17 帧
       是死区。若视觉跟手，块在拖动中会"实时变长"，松手吸附回 90 又缩回去，
       就成了"一拉长就收回"的错觉（20261013）。让块宽只在下一次落点时跳变，
       用户看到的是"要么不动、要么跳到 107"，和真实结果一致。 */
    const dNetRaw = (e.clientX - x0) / scale / tEngine.getPx();
    const raw = Math.round(net0 + dNetRaw + trimN);
    const frames = totalOfNet(net0 + dNetRaw, trimN);
    const netNow = netOfTotal(frames, trimN);      /* 提交 + 视觉同源：吸附格点 */
    const snapped = frames !== raw;
    const dPx = wOfFrames(netNow - net0);
    /* 同一格点不重写样式：pointermove 每秒上百次，值没变的帧重写
       width/transform 是白跑布局（rAF 已合并到每帧一次，这里再省掉平帧）。 */
    const key = netNow + "|" + frames;
    if (resizing.lastKey !== key) {
      resizing.lastKey = key;
      /* 轨道宽必须在拖动中同步增减（关键，否则超出框外）：
         被拖段加长后，后续段 translateX 到了右边，但若 trackW 还停在
         旧值，band.scrollWidth 不增大、不出滚动条，段块就直接"画"到 band
         右侧外 —— 必须让 track 随内容生长，band 才会正确出横向滚动条。 */
      if (el.track) el.track.style.width = `${wOfFrames(resizing.baseTotal + (netNow - net0))}px`;
      /* 波纹：被拖段只改 width（左缘不动）；后续段整体 translateX(dPx)（GPU，
         帧长不变、只平移）；左侧段不动。seg/rseam/wave 三个元素同步处理。 */
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (i === dragIndex) {
          const nw = wOfFrames(netNow);
          if (it.seg) it.seg.style.width = `${nw}px`;
          if (it.wave) it.wave.style.width = `${nw}px`;
          /* rseam 骑左缘，左缘没动 → 不动 */
        } else if (i > dragIndex) {
          if (it.seg) it.seg.style.transform = `translateX(${dPx}px)`;
          if (it.wave) it.wave.style.transform = `translateX(${dPx}px)`;
          /* rseam 自带 translateX(-50%) 居中，平移要在其基础上叠加 */
          if (it.rseam) it.rseam.style.transform = `translateX(calc(-50% + ${dPx}px))`;
        }
      }
    }
    /* 气泡：目标帧数 + 秒；位置钉在**吸附落点**的右缘。当还没跨到下一格时
       明确说"还差 N 帧到下一格"，让"拖了没变"有据可查、不像是坏了。 */
    const gripX = xOfFrame(items[dragIndex].from0 + netNow);
    const tip = el.track.querySelector(".bzf-tip");
    if (tip) {
      const net0Frames = resizing.net0 + resizing.trimN;
      const cur = snapH3(Math.round(net0Frames));
      const nxt = BASE_GRID_UP(cur);
      const delta = nxt - frames;
      /* ⚠ 气泡必须报**净长**（块宽画的就是净长），不是总帧数（20261013）：
         第 2+ 段开头有 56 帧是上一段尾部的重绘（承接重叠），总帧数比块宽多
         这么多。以前气泡报总帧数，用户照着"10 秒 = 240 帧"去拖，块的实际
         净长只有 184 帧（7.7 秒）—— "拖到 10 秒了怎么还是 7.7 秒"。
         主数字说净长（和眼睛看到的块一致），总帧数放括号里备查。 */
      const fpsT = (st.film && Number(st.film.fps)) || 24;
      tip.textContent = `${netNow} 帧 · ${secsIntOfFrames(netNow, fpsT)}s`
        + (trimN ? `（段总长 ${frames} 帧 · 含 ${trimN} 帧承接重叠）` : "")
        + (snapped ? " · 松手吸附到 H3 网格" : "")
        + (frames === cur && nxt > cur
            ? `（再拖 ${Math.max(1, delta)} 帧到 ${Math.max(1, nxt - trimN)} 帧）` : "");
      tip.style.left = `${gripX}px`;
    }
    /* 吸附引导线：常驻钉在落点（吸附后的右缘），块跳变时它跟着跳，清楚显示会落在哪 */
    if (el.snap) {
      el.snap.style.display = "";
      el.snap.style.left = `${gripX}px`;
    }
    /* 拖到视口边缘自动滚动：让 grip 始终可见（Premiere 手感）。 */
    edgeAutoScroll(gripX);
    resizing.frames = frames;
  }
  /* 只有真超宽（缩放态 / 拖段把 track 撑宽）才允许横向滚动。fit 态下
     scrollWidth 会比 clientWidth 大几像素（末帧播放头手柄 / 段尾徽标探出），
     overflow-x:hidden 裁得掉，但若谁去推 scrollLeft，右侧就凭空多出一条
     空白带（20261108 根修：与去掉 absorbTinyOverflow 同一口径）。 */
  function maxScrollX() {
    /* 用内容轨的真实宽度判超宽，不用 band.scrollWidth：后者会被右缘探出的
       几像素算进去，fit 态也 >0，于是「整片全看得见却还能横滚」。 */
    const vw = Math.max(1, el.band.clientWidth - TRACK_GUTTER);
    const trackW = el.track ? el.track.offsetWidth : vw;
    return Math.max(0, trackW - vw);
  }
  /* 边缘自动滚动：内容坐标 gripX 相对当前可视区，贴边就推 scrollLeft。 */
  function edgeAutoScroll(gripX) {
    if (maxScrollX() <= 1) return;
    const vp = el.band.clientWidth;
    const edge = 46;
    /* 内容 x → 容器内可见 x：左侧还有一列轨道头留白。 */
    const viewX = gripX + TRACK_GUTTER - el.band.scrollLeft;
    if (viewX > vp - edge) {
      el.band.scrollLeft += (viewX - (vp - edge)) + 6;
    } else if (viewX < edge) {
      el.band.scrollLeft -= (edge - viewX) + 6;
    }
  }
  /* 播放跟随：自动连播时让播放头始终留在可视区（播放头将出右缘就把视图
     推过去）。手动搓播放头不跟随（用户自己控制位置）。 */
  function followPlayhead(frame) {
    if (!st.playAll || maxScrollX() <= 1) return;
    const x = xOfFrame(frame) + TRACK_GUTTER;
    const vp = el.band.clientWidth;
    const sl = el.band.scrollLeft;
    if (x < sl + 10) el.band.scrollLeft = x - 10;
    else if (x > sl + vp - 46) el.band.scrollLeft = x - (vp - 46);
  }

  async function endResize(e) {
    if (!resizing) return;
    const { row, items } = resizing;
    /* ⚠ 关键：松手那一刻的最终位置必须重算一次，不能直接用 resizing.frames。
       moveResize 有 rAF 节流（每帧只算一次），最后一次 pointermove 常常在
       resizeRaf 尚未清空的间隙被 `if (resizeRaf) return` 丢弃 —— resizing.frames
       就停在**倒数第二次**的值。松手用旧值提交，后端认为"没变"，块被 refresh
       弹回原长 —— 这就是「一拉长就回弹」的真根因（20261013）。
       用 pointerup 的 clientX 当场重算最终帧数，保证提交的一定是松手位置。 */
    if (e && typeof e.clientX === "number") {
      const { x0, scale, net0, trimN } = resizing;
      const dNetRaw = (e.clientX - x0) / scale / tEngine.getPx();
      resizing.frames = totalOfNet(net0 + dNetRaw, trimN);
    }
    const frames = resizing.frames;
    resizing = null;
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
    el.band.classList.remove("bzf-resizing");
    const t = el.track.querySelector(".bzf-tip");
    if (t) t.style.display = "none";
    if (el.snap) el.snap.style.display = "none";
    /* 让 refresh 强制重画所有几何，但**不动**拖动中写的 width/transform：
       乐观几何（被拖段加宽 + 后续段 translateX 右移）必须一直保持到
       renderSegs / paintSeams / renderWaveSegs 用档案真值**原子重画**的那一刻。
       只把各层的重画签名作废（段块 __bzfSig、接缝层 __seamSig），几何一律不碰。
       （20261013 真机「拖中间段拉长被后一段覆盖」真根因：旧版在 await 网络请求
       回来后、refresh 重画**之前**就清了后续段的 transform，于是被拖段还是加宽
       状态、后续段却先弹回原 left，被拖段新长出来的一截被后一段（DOM 靠后、
       画在上层）压住，这个覆盖窗口会持续整个网络请求。） */
    const invalidateGeom = () => {
      for (const d of segEls.values()) d.__bzfSig = "";
      renderSegs.__seamSig = "";
    };
    /* refresh 原子重画**之后**的兜底：此时 left/width/transform 都已按档案
       真值重画过，再扫一遍 transform 只是确保无残留，不会再造成覆盖（位置已对齐）。 */
    const clearGhostAfter = () => {
      for (const it of items) {
        if (it.seg) it.seg.style.transform = "";
        if (it.wave) it.wave.style.transform = "";
        if (it.rseam) it.rseam.style.transform = "translateX(-50%)";
      }
    };
    if (!frames || !opts.onResize) { invalidateGeom(); await refresh(); clearGhostAfter(); return; }
    try {
      const res = await opts.onResize(row.clip, frames);
      invalidateGeom();
      await refresh();
      clearGhostAfter();
      /* 三种"跟想象不一样"都必须说一声，不然用户只会以为拖动坏了（20261013）：
         ① 后端吸附到了别的格点；② 拖动量没跨过 17 帧网格 —— 松手弹回原长的
         最常见原因，不是 bug 是格点约束；③ 加长被拒 —— 这一段没有续拍存档
         原稿（💾 H3 续拍存档写的 .cont.safetensors），没有原稿加长就接不回画面。 */
      if (res && res.no_stock) {
        /* 加长成功，但这一段没有「💾 续拍存档」原稿 → 走的是整段重抽，
           且下一段的头钉取自本段尾部、也一并待重跑。时长已经改成了，
           代价必须当场说清（20261013：以前这里是"拒绝加长"，中间段
           因此永远拉不长、一拉就弹回）。 */
        note(`第 ${row.clip.index} 段已加长到 ${res.to} 帧 · 需整段重抽`
          + (res.next_pending ? `，第 ${row.clip.index + 1} 段也要跟着重跑` : "")
          + `：${res.reason || ""}`);
      } else if (res && res.refused) {
        note(`第 ${row.clip.index} 段不能加长：${res.reason || "这一段没有续拍存档原稿"}`);
      } else if (res && res.changed === false) {
        const cur = Math.round(res.to ?? frames);
        const nxt = BASE_GRID_UP(cur);
        note(`第 ${row.clip.index} 段：${cur} 帧已经是 H3 的格点，长度没变`
          + (nxt > cur ? `—— 想加长请拖到 ${nxt} 帧（还差 ${nxt - cur} 帧）` : ""));
      } else if (res && typeof res.to === "number" && res.to !== Math.round(frames)) {
        note(`第 ${row.clip.index} 段：${Math.round(frames)} 帧不在 H3 的 17k+5 网格上，已取 ${res.to} 帧`);
      }
    } catch (err) {
      /* 乐观更新的另一半（20261010）：拖动期间块宽/邻段位置已经按手预写，
         接口一失败这份预写就成了谎言 —— 立刻按档案重画弹回真实长度，
         并说清原因。UI 在慢网/断网下依旧跟手，错了就退回来。 */
      note(`改时长失败：${err.message || err} —— 已弹回原长`);
      invalidateGeom();
      void refresh().then(clearGhostAfter);
    }
  }

  /** 一行瞬态提示（会被下一次 refresh 覆盖，所以只配说这种"顺带一提"）。 */
  function note(text) {
    el.stat.textContent = text;
    el.stat.classList.add("bzf-warn");
  }

  el.segs.addEventListener("pointermove", moveResize);
  el.segs.addEventListener("pointerup", endResize);
  el.segs.addEventListener("pointercancel", endResize);

  /* ---- 拖动排序 ----
     顺序这一件事只写在**档案的 chain.order** 里（时间轴画的就是它）。这里只
     负责把"用户想换成什么顺序"变成一串 id 交给宿主，宿主去落库。组件自己不
     知道顺序存在哪、也不改任何数据 —— 不传 onReorder 的宿主就自动没有这个
     手势，同一份代码两处行为一致。
     手势的分工：**在段块上横拖 = 换顺序，在轴上（波形那条）横拖 = 搓播放头**。
     两件事各占一块地方，不靠修饰键区分 —— 这是剪辑软件的通行分法：片段是拿
     来搬的，标尺才是拿来搓的。 */
  const REORDER_SLOP = 4;   // 横移超过这几像素才算"拖"，否则算"点"

  /* 画布缩放（scale）不再单独成函数：拖动/搓播放头在入口一次性算好，避免
     每帧 getBoundingClientRect；见 startResize、pxInSegs、fracFromEvent。 */

  function pxInSegs(e) {
    /* 内容坐标（相对 segs）：视口像素除画布缩放，再加滚动偏移。 */
    const r = el.segs.getBoundingClientRect();
    const cw = el.segs.clientWidth || 1;
    const scale = r.width ? r.width / cw : 1;
    return (e.clientX - r.left) / scale + el.band.scrollLeft;
  }

  function beginReorder(e, d) {
    const rows = segSpans();
    const di = rows.findIndex((x) => x.clip.id === d.dataset.clipId);
    if (di < 0) return false;
    ensureScale();
    /* 被拖的这一块宽度（像素）= 后面各段"让位"的量；抽出再插，中间段相对
       次序不变，所以每段正好平移这一个宽度。 */
    const dragW = Math.max(2, wOfFrames(rows[di].to - rows[di].from));
    reorder = {
      el: d, id: d.dataset.clipId, di, dragW,
      x0: e.clientX, moved: false, target: di, rows,
    };
    return true;
  }

  function paintReorder(e) {
    const { el: dragEl, rows, di, dragW } = reorder;
    const px = pxInSegs(e);
    /* ① 拖起来的那一块跟着指针走（translate 不碰布局，拖动期间不重抽缩略图）。 */
    const rc = xOfFrame((rows[di].from + rows[di].to) / 2);
    dragEl.classList.add("bzf-drag-lift");
    dragEl.style.transform = `translateX(${Math.round(px - rc)}px)`;

    /* ② 落点：拿其余各段横向中心当标尺，过了谁的中心就排在谁后面。 */
    const others = rows.filter((_, i) => i !== di);
    let target = 0;
    for (const r of others) {
      const cx = xOfFrame((r.from + r.to) / 2);
      if (px > cx) target++;
    }
    reorder.target = target;

    /* ③ 其余各段让位：抽出被拖段、插到 target，每段正好平移一个 dragW。 */
    const ids = rows.map((r) => r.clip.id);
    const arr = ids.filter((_, i) => i !== di);
    arr.splice(target, 0, ids[di]);
    const pos = new Map(arr.map((id, i) => [id, i]));
    for (const r of rows) {
      if (r.clip.id === reorder.id) continue;
      const node = segEls.get(segKey(r.clip));
      if (!node) continue;
      const ni = pos.get(r.clip.id);
      if (ni < r.i) node.style.transform = `translateX(${-dragW}px)`;
      else if (ni > r.i) node.style.transform = `translateX(${dragW}px)`;
      else node.style.transform = "";
    }
    /* 气泡锚在指针上（内容坐标）。 */
    showTip(dragEl, `第 ${target + 1} 位 / 共 ${rows.length} 段`);
    const tip = el.track.querySelector(".bzf-tip");
    if (tip) tip.style.left = `${px}px`;
  }

  /** 把拖动排序留在 DOM 上的痕迹全部收回。松手 / 取消 / 出错都要走到这里，
      否则那几段会永远停在让位后的位置上，看着像顺序已经变了。 */
  function clearReorderPaint(r) {
    el.band.classList.remove("bzf-reordering");
    const t = el.track.querySelector(".bzf-tip");
    if (t) t.style.display = "none";
    for (const row of r.rows) {
      const node = segEls.get(segKey(row.clip));
      if (!node) continue;
      node.classList.remove("bzf-drag-lift");
      node.style.transform = "";
    }
  }

  async function finishReorder() {
    if (!reorder) return;
    const r = reorder;
    reorder = null;
    clearReorderPaint(r);
    if (!r.moved) return;        // 没真挪过 = 那一下就是"点选"，交给 click
    justReordered = true;
    const ids = r.rows.map((x) => x.clip.id);
    const arr = ids.filter((_, i) => i !== r.di);
    arr.splice(r.target, 0, ids[r.di]);
    if (arr.join("|") === ids.join("|")) return;   // 原地放下，别白跑一趟网络
    try {
      await opts.onReorder(arr);
      await refresh();
      note(`已把第 ${r.rows[r.di].clip.index} 段挪到第 ${r.target + 1} 位`);
    } catch (err) {
      el.meta.textContent = `改顺序失败：${err.message || err}`;
      el.meta.className = "bzf-meta bzf-err";
    }
  }

  function cancelReorder() {
    if (!reorder) return;
    const r = reorder;
    reorder = null;
    clearReorderPaint(r);
  }

  /* 段块画面（20261010 重做：**雪碧图 + 按需**）。
     原来每张缩略图一次请求、一次解码 —— 铺满一轴几十次，吃配置。现在：
       · 每段只发**一个**请求，拿到一张拼好的横向长图（雪碧图），铺满段块
         就是一条连续画面带；服务端一次顺序解码，不再逐张 seek；
       · 默认只铺**选中段**与**鼠标划过的段**（划过即留下），冷启动秒开；
       · 签名不含段宽与当前段 —— 拖窗口、拖播放头都不再触发重取。 */
  /* 20261024 晚「胶条化」（对标 ⏱ 参照图替换 的胶片条几何）：
     格宽不再拍一个 14px，而是**由块高算出来** —— 格宽 = 画面高 × 16:9，
     每格恰好是一个原生 16:9 小帧（tailref 的 cellPx 同款算法）。于是：
       · 源格物理宽 ≈ 屏幕格宽 × DPR，贴上 1:1，零放大、零变形；
       · 列数 = ceil(段宽 ÷ 格宽)，再离散到 SPRITE_COL_STEPS 档位防抖；
       · cw 只随 (格宽, DPR) 变 —— 同列档内拖窗口、缩放都不重取。
     块高量不到时用 SEG_BD_H（.bzf-segs 72 − .bzf-seg-hd 20）。 */
  const THUMB_ASPECT = 16 / 9;      // H3 成片 16:9；拼图真实比例由加载后 naturalWidth 校正
  const THUMB_MIN_CELL = 40;        // 格宽下限：比这还窄，不如少几帧
  const SEG_BD_H = 52;              // 段块画面区高度（量不到时的兜底）
  const SPRITE_COL_STEPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24];  // 离散列档（对齐后端 SPRITE_MAX_COLS）
  const SPRITE_MAX_COLS_FE = SPRITE_COL_STEPS[SPRITE_COL_STEPS.length - 1];
  function thumbCellPx(bd) {
    const h = (bd && bd.clientHeight) || SEG_BD_H;
    return Math.max(THUMB_MIN_CELL, Math.round(h * THUMB_ASPECT));
  }
  function spriteColsFor(w, span, cellPx) {
    // 向上取整：宁可块底留一条井底缝，也不把帧裁掉
    const ideal = Math.max(1, Math.ceil(w / cellPx));
    const cap = Math.max(1, Math.min(SPRITE_MAX_COLS_FE, Math.floor(span)));
    const target = Math.min(ideal, cap);
    // 从 1 起跳，不是档位表首项（2）：时间轴缩小后大量段块不足一格宽，
    // 从 2 起跳会给它们硬塞两格、每格不到半格宽（20261024 晚自测抓到的）。
    let pick = 1;
    for (const s of SPRITE_COL_STEPS) { if (s <= target) pick = s; }
    return Math.max(1, Math.min(pick, cap));
  }
  /* 每格物理像素（清晰度）：≈ 屏幕格宽 × DPR。刻意**不**按连续段宽算 ——
     那样拖一次窗口就换一次图（解码风暴）；格宽由 CSS 块高定，是稳定量。 */
  function spriteCellW(cellPx, dpr) {
    const d = (dpr && dpr > 0) ? dpr : 1;
    return Math.max(32, Math.min(320, Math.round(cellPx * d)));
  }
  /* 比这还窄的块不值得为它抽帧。定 20 而不是 26：段一多时块会压到 20 上下，
     门槛太高会出现"整条轴一块画面都没有"（看着像功能没生效）。 */
  const THUMB_MIN_SEG_W = 20;
  let spriteTick = 0;              // 错峰计数（见 renderStrip）
  let spriteWarned = false;        // /sprite 失败只提醒一次，别刷屏
  let hoverSegId = "";             // 鼠标正悬停在哪一段（按需铺画面）

  /* 鼠标划过哪段就补铺哪段：:hover 的 CSS 管不到"要发请求"，只能自己记。 */
  el.segs.addEventListener("pointerover", (e) => {
    const seg = e.target.closest?.(".bzf-seg[data-seg]");
    const cid = seg && seg.dataset.clipId;
    if (!cid || cid === hoverSegId) return;
    hoverSegId = cid;
    scheduleStrip();
  });

  /* 这一段在自己的成片里占哪一截（帧号，左闭右开）。
     成片有两种：**单段成片**（这段自己那条 mp4，整条都归这段）与**累积成片**
     （前 k 段拼起来的那条，这段只占末尾一截）。判据与 videoT0 / drawWave 完全
     同一口径 —— 三处必须一致，否则会出现"块上画的是整片、底下音频只画一截"。
     第 1 段两种判法结果一样，怎么走都对。 */
  function spriteWin(segEl, ownFrames) {
    const fN = int(segEl.dataset.fframes);
    const from = int(segEl.dataset.from), to = int(segEl.dataset.to);
    const own = Math.max(1, int(ownFrames));
    /* 双判据，与 isCumulative 同源（20261010）：只认"成片比本段自己长"的
       累积片。少了前半条，第 1 段（成片长度天生 = 自己的 clip_to）会被当成
       累积片，采样窗口按 [clip_from, clip_to) 取 —— 第 1 段恰好也是这个范围，
       所以看不出来；但第 2 段往后若 film_frames 登记得偏大也会跟着错。 */
    const cumulative = fN > own * 1.05 && to > 0 && fN >= to * 0.9;
    if (cumulative && to - from >= 1) return { lo: from, hi: to };
    /* 单段成片：块画的是扣掉承接重叠后的**净长**，采样窗口也得从 trim 起
       （20261010 修）。原来从 0 采，把"照上一段尾巴重绘"的那截重叠帧也铺进
       了块里 —— 接缝左右同一段内容出现两遍、整块还被压扁错位，看着就是
       "接缝接不上 / 重叠帧没删对"。第 1 段（trim=0）与旧行为一致。 */
    const trim = Math.min(Math.max(0, int(segEl.dataset.trim)), own - 1);
    return { lo: trim, hi: own };
  }

  let stripRaf = 0;
  /** 合并到下一帧：ResizeObserver / 连续刷新会在一帧里喊好几次，只做一次。 */
  function scheduleStrip() {
    if (stripRaf) return;
    stripRaf = requestAnimationFrame(() => { stripRaf = 0; renderStrip(false); });
  }

  /* T1 视口红：时间轴纵向滚出视口时不新增任何缩略图请求（renderStrip 直接
     返回）；滚回视口（提前 200px）再铺。比页面级 visibilityState 更细——
     标签页仍可见、只是时间轴被滚到屏幕外时也省。 */
  let stripInView = true;
  if (typeof IntersectionObserver === "function") {
    const stripIO = new IntersectionObserver((entries) => {
      for (const en of entries) {
        stripInView = en.isIntersecting;
        if (stripInView) scheduleStrip();
      }
    }, { root: null, rootMargin: "200px 0px" });
    stripIO.observe(el.segs);
  }

  /* 空闲补铺（20261010 补）：优先级之外的段不是不铺，是**等空闲再铺**。
     第一次进入只铺选中段 + 悬停段（冷启动秒开），剩下的排进 requestIdleCallback
     —— 浏览器闲下来就把整条轴填满。这样"按需"的快还在，但不会有人看着半条
     空轴以为画面没做出来。（后端并发上限 2 兜底，空闲时慢慢跑不抢 CPU。） */
  let idleQueued = false;
  function scheduleIdleFill() {
    if (idleQueued) return;
    idleQueued = true;
    const go = () => { idleQueued = false; renderStrip(true); };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(go, { timeout: 1500 });
    } else {
      setTimeout(go, 600);
    }
  }

  /** 按拼图**自然尺寸**贴块：等比、只缩不放（20261024 晚「胶条化」）。
      object-fit 那套出问题，就是让浏览器替我们决定怎么拉伸；现在尺寸自己算 ——
      宽撑到块宽，高按拼图真实宽高比推。条比块高就上下居中裁一点（裁的是对称
      两边、每格仍然等宽不变形），比块矮就贴顶、下面露井底。
      nw/nh 存在 dataset 里：同 url 复用（块宽变了）时不必等重新加载就能重贴。 */
  function fitStrip(im, bd) {
    const nw = +(im.dataset.nw || 0), nh = +(im.dataset.nh || 0);
    const boxW = bd.clientWidth, boxH = bd.clientHeight;
    if (!nw || !nh || !boxW || !boxH) return;
    const h = Math.max(1, Math.round(nh * (boxW / nw)));
    im.style.width = `${boxW}px`;
    im.style.height = `${h}px`;
    im.style.top = `${h > boxH ? Math.round((boxH - h) / 2) : 0}px`;
  }

  /** 往块体里铺一张雪碧图。
      后端还没有 /sprite（**ComfyUI 没重启**时新路由就不存在，请求是 404）
      会走 error 分支降级成逐张 /thumb —— 老服务端也总能看见画面，不会留下
      一个 opacity:0 的空 img 把占位顶掉（那一看就是"画面没做出来"）。 */
  function spriteInto(bd, path, cols, cw, seq, f0, f1, ver) {
    if (!bd.isConnected) return;
    const url = surl(path, cols, cw, f0, f1, ver);
    let im = bd.querySelector("img.bzf-thumb-img");
    if (!im) {
      im = document.createElement("img");
      im.className = "bzf-thumb-img";
      im.decoding = "async";
      im.addEventListener("load", () => {
        /* 先按拼图真实尺寸贴好，再渐显 —— 用户永远看不到拉伸中的那一帧。 */
        im.dataset.nw = im.naturalWidth;
        im.dataset.nh = im.naturalHeight;
        /* seq 不能用闭包里一次性捕获的：img 会被复用、换 src，而渲染收尾会有
           多次 select→loadVideo（每段收片 WS + 最终 refresh），每次 ++st.seq。
           旧闭包 seq 永远落后 → 图加载了却不显示。改读每次 spriteInto 刷新的
           dataset.seq，最终一次 refresh 必然收敛。 */
        if (im.dataset.seq === String(st.seq)) { fitStrip(im, bd); im.classList.add("bzf-ok"); }
      });
      im.addEventListener("error", () => {
        if (bd.dataset.tfall === "1") return;   // 已降级过一次，别反复折腾
        bd.dataset.tfall = "1";
        /* 最常见的成因：**加了新路由但 ComfyUI 没重启** —— /sprite 压根不存在，
           请求就是 404。写一行到控制台，省得下次又当成"前端没生效"。 */
        if (!spriteWarned) {
          spriteWarned = true;
          console.warn("[H3 Studio] /cglide/join/sprite 拿不到（404？）——"
            + "段块画面已降级成逐张 /thumb。若是刚改过后端，**重启 ComfyUI 再硬刷页面**"
            + "（Ctrl+F5）即可用上雪碧图。");
        }
        thumbsInto(bd, path, seq, f0, f1, ver);
      });
      bd.appendChild(im);
    }
    /* 复用 img：url 没变不重设（避免无谓解码/闪烁）；变了才换 src，靠 .18s
       opacity 过渡渐暗再渐亮（见 .bzf-thumb-img），不 innerHTML 清空、不重排。
       url 没变也要重贴一次：块宽可能变过（拖窗口），胶条的缩放系数跟着变。 */
    if (im.dataset.url === url) { fitStrip(im, bd); im.classList.add("bzf-ok"); return; }
    im.dataset.url = url;
    delete im.dataset.nw;      // 旧拼图的尺寸作废，等新的 load 再填
    delete im.dataset.nh;
    im.classList.remove("bzf-ok");
    im.dataset.seq = String(seq);   // 本次 load 该认的最新 seq（见上方 load 监听）
    im.src = url;
  }

  /** 降级通道：老服务端没有 /sprite，退回 /thumb 逐张抽帧。
      张数压到 3 —— 这是"没有雪碧图时的兜底"，不是常态路径。 */
  function thumbsInto(bd, path, seq, f0, f1, ver) {
    if (!bd.isConnected) return;
    const segEl = bd.closest(".bzf-seg[data-seg]");
    /* 采样窗口与雪碧图同一口径：累积片只抽这一段自己那一截（见 spriteWin）。 */
    const win = (f0 != null && f1 != null && f1 - f0 >= 1)
      ? { lo: f0, span: f1 - f0 }
      : { lo: 0, span: Math.max(1, int(segEl && segEl.dataset.frames)) };
    const n = Math.min(3, win.span);
    bd.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const f = win.lo + Math.round(i * (win.span - 1) / Math.max(1, n - 1));
      const im = document.createElement("img");
      im.className = "bzf-thumb-img bzf-thumb-tile";
      im.decoding = "async";
      im.style.left = `${(i / n) * 100}%`;
      im.style.width = `${(1 / n) * 100}%`;
      im.addEventListener("load", () => { if (im.dataset.seq === String(st.seq)) im.classList.add("bzf-ok"); });
      /* 连 /thumb 都拿不到（成片刚被删 / 路径失效）：把这张撤掉，全没了就把
         「成片」占位放回去 —— 块上至少要有个字，不能是一块纯色。 */
      im.addEventListener("error", () => {
        im.remove();
        if (!bd.querySelector("img")) {
          bd.innerHTML = "";
          const ph = document.createElement("span");
          ph.className = "bzf-ph";
          ph.textContent = "成片";
          ph.style.opacity = ".28";
          bd.append(ph);
        }
      });
      im.dataset.seq = String(seq);
      bd.appendChild(im);
      setTimeout(() => { if (im.isConnected) im.src = turl(path, f, 128, ver); }, i * 40);
    }
  }

  function renderStrip(fillRest) {
    /* 合并轨：缩略图铺在各段自己的 .bzf-seg-bd 里，不再画整条黑色 film。
       未 playable 的段保持「待生成」占位；有成片的段按本段宽度铺帧条。 */
    /* 页面隐藏时整段跳过（20261010）：缩略图是真实的服务端抽帧（ffmpeg），
       用户看不见时一张都别拉；回前台由 visibilitychange 补一次 scheduleStrip。 */
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!stripInView) return;        /* T1：时间轴不在视口，不铺、不发请求 */
    const bodies = el.segs.querySelectorAll(".bzf-seg");
    if (!bodies.length) {
      if (el.film) el.film.innerHTML = "";
      return;
    }
    const seq = st.seq;
    let pending = 0;          // 还有几段没铺（>0 就排一次空闲补铺）
    for (const segEl of bodies) {
      const bd = segEl.querySelector(".bzf-seg-bd");
      if (!bd) continue;
      const path = segEl.dataset.film || "";
      const playable = !segEl.classList.contains("bzf-none");
      const frames = Math.max(1, int(segEl.dataset.frames));
      const w = bd.clientWidth || segEl.clientWidth || 0;
      if (!playable || !path || w <= 0) {
        /* 占位已在 renderSegs 写好；这里只在刷新时保证还有 ph */
        if (!bd.querySelector(".bzf-ph") && !bd.querySelector(".bzf-thumb-img")) {
          const ph = document.createElement("span");
          ph.className = "bzf-ph";
          ph.textContent = "待生成";
          bd.append(ph);
        }
        continue;
      }
      if (w < THUMB_MIN_SEG_W) continue;

      /* ---- 采样窗口：这一段在**自己的成片**里占哪一截 ----
         成片可能是累积片（前 k 段拼起来的那条 mp4）。这种文件里有的是全片，
         而段块代表的只是其中一截 —— 不给窗口的话每段块都会采样到整部片，
         第 1 段和第 5 段长得一模一样。判据与波形 / 播放器同一口径：
         成片实测帧数盖到 clip_to 即为累积片（见 videoT0 / drawWave）。 */
      const win = spriteWin(segEl, frames);
      /* ---- 雪碧图：一次请求拿整条画面带铺满段块（1 请求 / 1 次解码）----
         列数按「块高 × 16:9」定的格宽自适应、离散分档；每格物理像素随 DPR
         （thumbCellPx / spriteColsFor / spriteCellW）—— 每格原生 16:9、
         贴上 1:1，短段少抽、长段多抽、高分屏不糊。 */
      const span = Math.max(1, win.hi - win.lo);
      const cellPx = thumbCellPx(bd);
      const cols = spriteColsFor(w, span, cellPx);
      const cw = spriteCellW(cellPx, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      /* 签名只认稳定量：成片路径 / 列档 / 格宽 / 采样窗口 / 档案 updated。
         刻意不含连续段宽与 st.cur —— 同档内拖窗口、换选中段都不重取；列档离散，
         只有宽度跨档才换图。updated 必须带：重抽覆盖同一成片路径，不认时间戳就
         永远显示重抽前那版（"重抽了画面不换"）。 */
      const upd = int(segEl.dataset.upd);
      const sig = `sp2|${path}|${cols}|${cw}|${win.lo}-${win.hi}|${upd}`;
      if (bd.dataset.tsig === sig) {
        /* 同列档内块宽变了（拖窗口 / 节点缩放）：图不用重取，但得按新块宽
           重新贴一次 —— 胶条是等比贴的，块宽变了缩放系数就变了（20261024 晚）。
           同时补 bzf-ok：上一次 load 若撞上 st.seq 变动，图已解码却没渐显，
           这里是当前最新 refresh，让它可见，不再受旧 seq 钳制。 */
        const im0 = bd.querySelector("img.bzf-thumb-img");
        if (im0 && im0.dataset.nw) { fitStrip(im0, bd); im0.classList.add("bzf-ok"); }
        continue;   // 这块已经铺过，不用再算 pending
      }

      /* ---- 按需铺画面（20261010 用户选的方案 ③）----
         **立刻**铺的只有**选中段**与**鼠标划过的段**；其余段记一笔 pending，
         等浏览器空闲再补（见 scheduleIdleFill）。划过之后画面留在原地不撤
         —— 看过的段不用再等，冷启动是秒开的，而整条轴最终会填满。 */
      const cid = segEl.dataset.clipId;
      const isPri = (cid === st.cur || cid === hoverSegId);
      if (!isPri && !fillRest) { pending++; continue; }
      bd.dataset.tsig = sig;
      delete bd.dataset.tfall;
      /* 只移除「待生成」占位、不清空整块：旧 img 交给 spriteInto 复用换 src，
         避免 innerHTML 重排（T5）。 */
      const oldPh = bd.querySelector(".bzf-ph");
      if (oldPh) oldPh.remove();
      /* 错峰：一次刷新多段同铺时别让请求一起砸进后端（后端另有并发上限 2
         兜着）；段块中途被撤掉就不再发请求。 */
      const slot = spriteTick++;
      const delay = (slot % 4) * 60;
      const f0 = win.lo, f1 = win.hi;
      setTimeout(() => {
        if (bd.isConnected && bd.dataset.tsig === sig) {
          spriteInto(bd, path, cols, cw, seq, f0, f1, upd);
        }
      }, delay);
    }
    if (el.film) el.film.innerHTML = "";
    if (!fillRest && pending) scheduleIdleFill();
  }

  /* ---- 波形画在哪一段上 ----
     返回选中段在轴上的**像素比例窗口**，以及该从第几个 bin 开始画。

     为什么需要这个：一条成片可能是两种东西之一 ——
       · 单段成片（这段自己那一条 mp4）→ 整条波形都属于这一段；
       · 累积成片（前 k 段拼起来的）→ 只有最后那一截是这一段的。
     以前的画法是把 canvas 缩成"这一段的累积右边界"再让整条波形铺满那个
     宽度 —— 选第 1 段看着一切正常，一选到第 2 段（它的 clip_to 就是全片
     末尾）整条轴就都是波形了。上下两排于是对不上：上排第 2 段只占一半，
     下排的音频却横贯全轴，读起来就像"音频跑到别的段底下去了"。
     现在 canvas 恒为整幅宽，波形只画进**这一段自己的窗口**，上下一一对应。

     判据用档案里的 film_frames（成片实测帧数，见 drawWave）：累积成片一定
     覆盖到本段末尾（≈ clip_to），单段成片只到本段自己的长度。第 1 段两者
     相等，怎么判都对。
     （waveWindow 已删：波形改画**每段自己的窗口**后，它只服务选中段，
     没有调用者了 —— 累积/单段的判据内联进 drawWave。） */

  /* 波形只由音频轴按段块画（csglide_audio_lane）：这里不再画整条包络 ——
     逐段拼起来的连续波形铺满整轴，正是"和上方段块对不上"的来源。 */
  function drawWave() {
    const c = el.canvas;
    c.style.width = "100%";
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 0, h = c.clientHeight || 0;
    if (!w || !h) return;
    /* 布局/拖动会高频调 layout；数据没变就别重画整条波形。 */
    const sig = [w, h, waveRows.length, waveRev,
                 waveRows.map((r) => (r.clip ? waveKeyOf(r.clip) : "")).join("|")].join("~");
    if (sig === waveDrawSig) return;
    waveDrawSig = sig;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    /* 每段只画自己成片的那截音频：波峰按段宽采样到同一把帧→像素尺子上，
       上下与视频段块严格对齐。没渲染过的段没有 film，自然留空。 */
    g.fillStyle = "#5ad38ab3";
    for (const r of waveRows) {
      const memo = waveFor(r.clip);
      const bins = memo && (memo.bins || memo["峰值"]);
      if (!bins || !bins.length) continue;
      const x0 = xOfFrame(r.from), x1 = xOfFrame(r.to);
      const segW = Math.max(1, x1 - x0);
      const n = Math.min(bins.length, Math.max(1, Math.round(segW)));
      const bw = segW / n;
      for (let i = 0; i < n; i++) {
        const v = Number(bins[Math.floor(i * bins.length / n)]) || 0;
        const bh = Math.max(1, Math.min(1, v) * h * 0.9);
        g.fillRect(x0 + i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
      }
    }
  }

  function layout() {
    /* 性能埋点（临时）：定位「单次 layout 吃掉 13 秒」烧在哪一步。
       只在超过 25ms 时打印，平时零开销、不刷屏。定位到元凶后删除。 */
    const _now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const _t0 = _now();
    renderSegs();
    const _t1 = _now();
    /* 播放头按帧号放回（坐标由帧×px算，与轴宽无关）；轴宽变化不会挂错。 */
    setPlayheadAbs(fracOfFrame(st.frame));
    const _t2 = _now();
    /* 缩略图合到下一帧：layout 会被 ResizeObserver 每一帧喊一次（拖窗口、
       拖悬浮窗），跟着每帧重铺就是每帧几十个抽帧请求。 */
    scheduleStrip();
    const _t3 = _now();
    drawWave();
    /* 时间轴像素尺子刚重算过：音频块按新坐标重摆一次（不重切峰值）。 */
    if (audioLaneApi) audioLaneApi.sync();
    const _t4 = _now();
    /* 20261108 根修：这里原来每次 layout 都调 absorbTinyOverflow()，把尺子
       微缩 24px 去"吃掉"右缘徽标造成的几像素假溢出。但 .bzf-band 是
       overflow-x:hidden，滚动条本就不显示；缩尺子的唯一可见后果是段块、
       波形、音频块右端统一短 24px，而 .bzsa-row 按容器铺满 → 右侧凭空多出
       一条空白带，× / 试听 / 本段 按钮浮在里面。现在 fit 即严格铺满、
       fitMode 下 scrollLeft 恒 0，不再做任何吸附。 */
    const _cost = _t4 - _t0;
    if (_cost > 25) {
      console.warn("[H3时间轴] layout 慢 " + Math.round(_cost) + "ms → "
        + "renderSegs=" + Math.round(_t1 - _t0)
        + " | playhead=" + Math.round(_t2 - _t1)
        + " | scheduleStrip=" + Math.round(_t3 - _t2)
        + " | drawWave=" + Math.round(_t4 - _t3)
        + "（段数=" + (st.film && st.film.clips ? st.film.clips.length : 0)
        + " 总帧=" + (st.film && st.film.total_frames || 0) + "）");
    }
  }

  /* ---------------------------------------------------------- 播放头 */

  /* （原来这里有一个 curClipEndFrac()：把"选中段的累积右边界"换算成比例，
     只给波形用过宽度。波形改成画进"这一段自己的窗口"之后它没有调用者了，
     一并删掉 —— 留着就是一段会被误认为"音频还铺整条轴"的死代码，
     那正是这次要修掉的观感。见上面的 waveWindow()。） */

  /* ---- 播放头的坐标系 ----
     **st.frame 一律是「整部片子的第几帧」**（全片坐标），从 0 起到
     total_frames 止。以前它有时是"这一段内部的第几帧"（timeupdate / 老
     seekFrac 写的是段内坐标），有时又被当成全片坐标去显示时间码
     （syncFoot）—— 同一字段两套含义，于是只要选中的不是第 1 段，时间码
     和落差就整整差了前面所有段的时长：明明在看第 3 段，状态行却说"第 60
     帧"。这类错读最难自查，因为它每一帧都在变、看着像对的。
     现在就一个坐标系。换算只在**进/出视频**的那两处发生：
       · 全片 → 段内：frame - row.clip_from（seek 视频时才用得上）
       · 段内 → 全片：row.clip_from + 段内帧
     其余地方一律全片坐标。 */
  function curRow() {
    const clips = (st.film && st.film.clips) || [];
    return clips.find((c) => c.id === st.cur) || clips[clips.length - 1] || null;
  }
  /** 这条成片是不是「前 k 段拼起来的累积片」—— **全片只有这一个判据**
      （20261010 统一）：必须**两条同时成立**
        ① 成片明显长过本段自己的长度（film_frames > frames × 1.05）
        ② 且覆盖到本段末尾（film_frames >= clip_to × 0.9）
      少了① 就把**单段成片**误判成累积片：第 1 段的成片长度天生就等于它自己的
      clip_to（它前面没有段），于是第 1 段一路被当成"这条就是全片"——
        · 整片连播：播完第 1 段直接跳到**最后一段**（中间各段根本不播），而
          指针还停在第 1 段末尾、早于最后一段视频的起点，seek 对位不成立，
          最后一段的视频从 0 帧放起 —— 放的是"照上一段尾巴重绘"的那截。
          观感就是"每一段都播了两遍、前后衔接不对"。
        · 采样窗口 / 播放头换算同样按"这条就是全片"来算，处处错位。
      波形那边早就用的是双判据（见 drawWave），只有这几处漏了① —— 现在统一。 */
  function isCumulative(row) {
    if (!row) return false;
    const own = Math.max(1, int(row.frames) || 1);
    /* 档案里的 film_frames 有时是 0（老渲染没登记）；当前段可以拿实测的
       st.span 顶上 —— 它是刚从 /info 读出来的真值。 */
    const filmN = int(row.film_frames) || (row.id === st.cur ? int(st.span) : 0);
    return filmN > own * 1.05 && filmN >= Math.max(1, int(row.clip_to)) * 0.9;
  }
  /** 这条**原片**的 0 时刻落在全片的第几帧（净长口径）：
      · 单段成片：原片从承接重叠的开头算起 → 全片 clip_from - trim；
      · 累积成片（前 k 段拼片）：0 时刻 = 全片 0 帧。
      与后端 csglide_chain._film_t0 同源 —— 两处必须一致，否则"时间轴上看到的"
      和"保存成片取出来的"不是同一段画面。

      刻意**不看** st.curRaw：换源那一刻 curRaw 还是上一条片子留下的值，让它
      掺进来就会把掐头帧数算成 0（播放版因此不生成）。播放版的口径在 videoT0
      里单独处理。 */
  function filmT0(row) {
    if (!row) return 0;
    /* 契约（20261010ba）：``film_head`` = 这条成片开头有几帧是承接/旧内容，
       收片那一刻由后端算一次、写死在档案里 —— 全片只有那一处判断形态。
       这里直接读：原片 0 帧落在全片第几帧 = clip_from - film_head。
          · 单段片 film_head = trim   → clip_from - trim（同旧算法）；
          · 累积片 film_head = clip_from → 0（同旧算法）。
       老档案还没这个字段时退回原判据，下一次读档/收片会自动补上。 */
    const h = row.film_head;
    if (h != null) return int(row.clip_from) - int(h);
    if (isCumulative(row)) return 0;                                // 累积片
    const own = Math.max(1, int(row.frames) || 1);
    return int(row.clip_from) - Math.min(int(row.trim_frames) || 0, own);
  }
  /** 当前**装着的那条视频**的 0 时刻落在全片的第几帧。
      scrub / timeupdate / 切段 seek 全走这一个换算，口径不会散。 */
  function videoT0(row) {
    if (!row) return 0;
    /* 播放版（20261010av 方案③）：头部多出来的帧已被服务端掐掉（单段片掐
       承接重叠、累积片掐到本段起点），它的第 0 帧 = 本段新画面开头 = 全片的
       clip_from —— 口径恒为 clip_from，连播接段换算出的目标秒恒为 0，不需要
       任何 seek。 */
    if (st.curRaw === false) return int(row.clip_from);
    return filmT0(row);
  }
  /** **已装载那条片子**的 0 时刻落在全片第几帧 —— seek 与 timeupdate 只认
      这个。与 videoT0 的差别只在"问的是谁"：videoT0 回答「下一条要装的片子
      会怎么对位」（loadVideo 里算 seek 目标用），loadedT0 回答「现在装着这
      条片子该怎么对位」。混用就是跨段那一瞬的画面跳变。 */
  function loadedT0(row) {
    if (!row) return 0;
    if (loadedKind === "play") return int(row.clip_from);
    return filmT0(row);
  }
  /** 换源落地后把画面对到播放头。不补这一脚，换源完成那一刻视频停在 0 帧
      （播放版的 0 帧 = 本段新画面开头），而播放头可能在本段中段 —— 画面和
      指针说的不是一个位置，下一次拖动就是一次跳。 */
  function settleLoadedSeek() {
    const row = rowById(loadedId);
    if (!row || !st.span) return;
    const fps = Number((st.info && st.info.fps) || 24) || 24;
    const t0 = loadedT0(row);
    if (st.frame >= t0 && st.frame <= Math.max(t0 + 1, int(row.clip_to))) {
      requestVideoSeek(Math.max(0, (st.frame - t0) / fps));
    }
  }
  function totalFrames() { return Math.max(1, int(st.film && st.film.total_frames)); }
  /** 全片帧号 → 轴上的比例（0..1） */
  function fracOfFrame(f) { return clamp(f / totalFrames(), 0, 1); }
  function setPlayheadAbs(fracAbs) {
    /* 播放头在 track 内（随内容滚动）；transform 只走合成层，搓起来不拖泥带水。
       像素/帧：横坐标 = 帧 × pxPerFrame。left 固定 0，不读 clientWidth。 */
    const frame = clamp(fracAbs, 0, 1) * totalFrames();
    if (el.play.style.left !== "0px") el.play.style.left = "0px";
    el.play.style.transform = `translateX(${xOfFrame(frame)}px)`;
    /* 参考音轨试听：播放头一动就广播全片帧位，音频轴自己对齐 currentTime。 */
    el.track.dispatchEvent(new CustomEvent("bzf:playhead", {
      bubbles: true, detail: { frame },
    }));
  }
  /* 全片帧号落在哪一段上（段边界：[clip_from, clip_to)） */
  function rowAtFrame(f) {
    const clips = (st.film && st.film.clips) || [];
    return clips.find((c) => f >= int(c.clip_from) && f < int(c.clip_to))
      || clips[clips.length - 1] || null;
  }

  /* ---- 整片连播要用的三个问题 ----
     一条成片可能是两种东西：单段成片（这段自己那一条 mp4）或累积成片
     （前 k 段拼起来的）。二者的"播完一段接着播什么"完全不同，所以判据要
     跟 waveWindow 用同一个：**成片实测帧数是否覆盖到本段末尾**。 */
  function playableRows() {
    return ((st.film && st.film.clips) || []).filter((c) => c.playable);
  }
  function firstPlayableRow() { return playableRows()[0] || null; }
  /* 居中覆盖层（监视器皮肤）三态：
     · 空态（一段成片都没有）：藏大播放钮，只留"先接第一段并渲染"引导；
     · 暂停（有成片）：显示大播放钮 + "点击播放整片"；
     · 播放中：整层淡出，不挡画面。
     覆盖层 pointer-events:none，点击穿透到 .bzf-view 的播放/暂停手势，不另写。 */
  function refreshCenter() {
    if (!el.center) return;
    const hasAny = playableRows().length > 0;
    /* 大播放钮已删：有成片时整层隐藏（不挡画面、不碍拖指针），空态才显示引导。 */
    el.center.classList.toggle("has-film", hasAny);
    if (!el.cstatus) return;
    /* 空态文案要分两种（20261011 修）：段都接好了只是没渲染，却说"先接第一段"，
       新人点了段、监视器中央还让他接第一段，像"点了没选中"。 */
    if (hasAny) el.cstatus.textContent = "";
    else {
      const segN = ((st.film && st.film.clips) || []).length;
      el.cstatus.textContent = segN
        ? "段落都接好了 —— 点「全部渲染」生成画面"
        : "还没有分段 —— 点画面中央的「＋ 接第一段」开始";
    }
  }
  function lastPlayableRow() {
    const r = playableRows();
    return r.length ? r[r.length - 1] : null;
  }
  /** 轴上这一段之后的**下一个有成片的段**（中间没渲染的段直接跨过）。 */
  function nextPlayableRow(row) {
    const r = playableRows();
    const i = r.findIndex((c) => c.id === (row && row.id));
    return i >= 0 ? (r[i + 1] || null) : null;
  }
  /** 现在加载着的这条成片，是不是"前 k 段拼起来"的那种累积成片。 */
  function filmIsCumulative(row) {
    return isCumulative(row);      // 判据统一到一处（见 isCumulative 的注释）
  }
  /** 连播的下一站（20261010bj）：ended 与预载**共用这一套判据** —— 写两遍必
      有一处漏改，漏的那处就是"预载了 A、接段去了 B"。
      当前这条是**累积成片**时，下一段那条会把前面重播一遍，所以整片改由"最后
      一个有成片的段"那一条一次播完（见 ended 里的同一条说明）。 */
  function seamTarget(row) {
    const later = nextPlayableRow(row);
    if (!later) return null;
    const tgt = filmIsCumulative(row) ? lastPlayableRow() : later;
    /* 断链：目标段左接缝是 unlink，播到这里停下、不自动连播 */
    if (tgt && tgt.id !== row.id && transitionOf(tgt.id).type === "unlink") return null;
    return tgt;
  }

  /* ---- 下一段预载（20261010bj）：接缝要"无缝"，就得在下一段被用到**之前**
     把它准备好。 ----
     不预载的话，接缝处要等一次 /info 往返（首次还要后端现生成播放版 1~2s）
     加浏览器现拉下一条 mp4 —— 定格帧得停在那儿几百毫秒到一两秒，看着就是"先
     卡一下再跳"。预载之后换源只剩"取缓存 + 解一帧"。
     提前量取 4 秒：短段（本段自己就不到 4 秒）一开始播就预热，长段也够后端把
     播放版现生成出来。 */
  const PREWARM_SEC = 4.0;
  let prewarmed = "";       /* 已触发过预载的段；实际去重由 buf 负责 */
  function prewarmNext(row) {
    if (!st.playAll || st.dead || st.drag || !row || !row.film) return;
    const tgt = seamTarget(row);
    if (!tgt || !tgt.film || tgt.id === row.id) return;
    if (prewarmed === tgt.id && buf.ready) return;
    prewarmed = tgt.id;
    /* 双缓冲（方案B）：把下一段装进"备用 video"并解出首帧。prepareStandby
       内部先 /info（顺带让后端把播放版现生成出来），再设 src、seek 首帧。
       旧的 warmPlayUrl 只填缓存、播放仍要换源，已被此路径取代。 */
    prepareStandby(tgt);
  }

  /* ================= 双缓冲调度（方案B / M2）=================
     buf 描述"备用 video"现在装的是哪段、首帧是否已解码就位。
       · prepareStandby(row)：把 row 装进备用 video，解出本段新画面首帧；
       · handoverTo(row)：当前段 ended 且 buf 就位时，A/B 只切可见性（零换源）；
       · resetBuffer()：用户主动跳段 / 刷新 / 清空时，把备用内容与在途装载作废。
     两条 video 永远只有 active 在播，standby 恒 paused、opacity:0。 */
  const buf = { id: null, kind: null, buffered: false, ready: false, loading: false, firstSec: 0 };
  let bufToken = 0;
  /* 交棒后新 active 未就绪时登记"就绪即播"；handoverSeek 保存要补的起点秒数。 */
  let autoContinue = false;
  let handoverSeek = -1;
  function resetBuffer() {
    bufToken++;
    buf.id = null; buf.kind = null; buf.buffered = false; buf.ready = false;
    buf.loading = false; buf.firstSec = 0;
    autoContinue = false; handoverSeek = -1;
    const s = standbyEl();
    try { s.pause(); } catch { /* 已暂停 */ }
    s.classList.remove("bzf-ok");   /* 备用元素确保隐藏；src 留给下次覆盖 */
    hideFreeze();
  }

  /* 等备用 video 缓冲到首帧（轮询 buf.buffered），用于 ended 时原地等待。 */
  function waitBuffered(ms) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if (buf.buffered || performance.now() - t0 >= ms) resolve();
        else setTimeout(tick, 30);
      };
      tick();
    });
  }
  /* 等备用把本段首帧 seek 就位（buf.ready），无缝交棒前原地等待。 */
  function waitReady(ms) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if (buf.ready || performance.now() - t0 >= ms) resolve();
        else setTimeout(tick, 30);
      };
      tick();
    });
  }

  /* 预取（刻意不在暗处 seek）：只把下一段 src 装进备用 video，让浏览器提前下载、
     缓冲到开头，loadeddata 一到记 buffered。"对到本段起点"放在交棒切可见性之后、
     在可见元素上做 —— 不可见元素的 seek 在 Chromium 里常不及时完成、也不保证触发
     seeked，押上去会让缓冲永不就位、接缝只能走会闪的回退路径。 */
  async function prepareStandby(row) {
    if (!row || !row.film) return;
    if (buf.id === row.id && (buf.buffered || buf.loading)) return;
    const token = ++bufToken;
    const v = standbyEl();
    buf.id = row.id; buf.buffered = false; buf.loading = true;
    buf.kind = null; buf.firstSec = 0;
    try {
      const iurl = infoUrlOf(row);
      const info = await infoFor(iurl, iurl + "|" + int(row.updated));
      if (token !== bufToken || st.dead) return;
      const usePlay = !!(info && info.play_film);
      buf.kind = usePlay ? "play" : "raw";
      const fps = Number(info.fps) || 24;
      /* 交棒后要 seek 的秒数：播放版首帧即本段起点=0；原片=相对视频 0 的偏移 */
      buf.firstSec = usePlay
        ? 0
        : Math.max(0, (int(row.clip_from) - videoT0(row)) / fps);
      v.muted = audioMuted;
      v.src = playUrlOf(row, usePlay);
      buf.loading = false;
      /* 缓冲到开头后，提前在备用元素（opacity:0 但在合成树、会 decode）seek 到本段
         起点，等 seeked 确认该帧就位 → buf.ready。交棒只翻 opacity，浏览器单次合成
         直接上目标帧，不再先露一帧 frame 0（连接处闪的根因）。
         seeked 600ms 不来（个别 Chromium 对不可见元素不及时）就不置 ready，
         handoverTo 自动走"翻转后 seek + autoContinue"回退，不卡死。 */
      const armFirstFrame = () => {
        if (token !== bufToken) return;
        buf.buffered = true;
        const fs = Number(buf.firstSec) || 0;
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(to);
          if (token === bufToken && v.readyState >= 2) buf.ready = true; } };
        const to = setTimeout(finish, 600);   /* rvfc/seeked 都不来的兜底（走回退） */
        /* 20261011 修「接缝有时黑有时不黑」：ready 必须等备用首帧**真正提交合成器**。
           seeked 只表示 seek 完成、常早于帧上屏（GPU/磁盘忙时尤甚），旧逻辑只听
           seeked → 帧没进合成树就翻转、偶露一帧黑。有 rvfc 就只信 rvfc（它正是
           "帧已提交"的硬件信号）；无 rvfc 的老浏览器才退回 seeked。 */
        if (typeof v.requestVideoFrameCallback === "function")
          v.requestVideoFrameCallback(finish);
        else
          v.addEventListener("seeked", finish, { once: true });
        if (fs > 0.02) { try { v.currentTime = fs; } catch { finish(); } }
        else finish();
      };
      if (v.readyState >= 2) armFirstFrame();
      else v.addEventListener("loadeddata", armFirstFrame, { once: true });
    } catch {
      if (token === bufToken) {
        buf.loading = false; buf.id = null; buf.kind = null; buf.firstSec = 0;
        buf.buffered = false; buf.ready = false;
      }
    }
  }

  /* 接缝交棒（join_panel 成熟模式）：备用 video 已提前装好 target。
     翻转可见性后，在**同一个同步栈**里立即把新 active seek 到本段起点 —— 浏览器
     单次合成：预取已缓冲时直接上目标帧，从不上屏开头重叠帧，零黑帧。未缓冲到
     则登记 autoContinue，由 loadedmetadata 补 seek、补播。 */
  async function handoverTo(target) {
    resetSeekQueue();
    const incoming = standbyEl();   /* 翻转前：备用 = 即将上台 */
    const outgoing = el.video;      /* 当前在播（已 ended） */
    const firstSec = Number(buf.firstSec) || 0;
    const seamless = !!buf.ready;   /* 备用已提前 seek 到起点、帧就位 → 翻转即现 */
    handoverSeek = seamless ? -1 : firstSec;
    incoming.classList.add("bzf-ok");
    outgoing.classList.remove("bzf-ok");
    try { outgoing.pause(); } catch { /* 已结束 */ }
    activeIsA = !activeIsA;         /* getter 此刻起指向 incoming */
    st.cur = target.id;
    loadedId = target.id; loadingId = null; loadedKind = buf.kind;
    loadedFilmKey = filmKeyOf(target);
    st.frame = int(target.clip_from);
    userPick = target.id;
    /* 无缝路径：备用已停在 firstSec，翻转 opacity 同帧即现目标帧，不再 seek
       （此刻 seek 是异步的，反而会先露出中间帧）；只有回退路径才翻转后 seek。 */
    if (!seamless) {
      try { if (firstSec > 0.02) el.video.currentTime = firstSec; }
      catch { /* 未就绪：loadedmetadata 里用 handoverSeek 补 */ }
    }
    el.meta.textContent = `${(st.film && st.film.name) || "未命名"} · 第 ${target.index} 段 / 共 ${(st.film.clips || []).length} 段`;
    el.meta.className = "bzf-meta";
    /* 旧 buf（已上台）作废；翻转后 standbyEl() 指向旧 outgoing，供下一轮装载 */
    bufToken++;
    buf.id = null; buf.kind = null; buf.buffered = false; buf.ready = false;
    buf.loading = false; buf.firstSec = 0;
    renderSegs();
    setPlayheadAbs(fracOfFrame(st.frame));
    syncFoot();
    /* 起播：无缝（帧已就位）或已缓冲直接 play；未就绪登记 autoContinue，
       loadedmetadata 补 seek、补播。 */
    el.video.muted = audioMuted;
    if (seamless || el.video.readyState >= 1) {
      autoContinue = false; handoverSeek = -1;
      try { await el.video.play(); } catch { /* 自动播放被拒：用户再点一次画面 */ }
    } else {
      autoContinue = true;   /* handoverSeek 保留，loadedmetadata 补 seek/播 */
    }
    const nt = seamTarget(target);
    if (nt && nt.id !== target.id && nt.film) prepareStandby(nt);
  }

  /* 成片视觉转场（溶解 / 淡变）已按用户要求移除：接缝只保留「重叠帧可视化
     + 断链」，播放交棒统一走 handoverTo（双缓冲、不黑帧），不再做 opacity 交叉。 */

  function syncFoot() {
    const fps = Number((st.info && st.info.fps) || (st.film && st.film.fps) || 24);
    const secs = st.span / (fps || 24);
    /* 全片规划总时长（各段 frame 之和 / fps）。刚登记完第一段就有值，跟渲染
       进度无关 —— 底栏的「全片多长」该用它，而不是等某段真跑出成片才有。 */
    const planSecs = (st.film && st.film.seconds) || secs;
    const planFrames = (st.film && st.film.total_frames) || st.span || 0;
    /* 先说"看到哪儿了 / 全片多长"，而且是**时间**不是帧数：剪片子的人想的是秒，
       帧数只在精确对齐时才用得上，所以放后面并写明"帧"。
       还没渲染出成片时位置是 0，但全长照给 —— 别显示成 "—"，让人以为没登记。 */
    /* 没渲染出成片时 st.span 是 0，但 st.frame 仍然被搓动写上了（见 seekFrac）
       —— 时间码照着它走，拖动才有反馈。原来按 `st.span ? ... : 0` 恒显示 0，
       跟「拖了没反应」是同一件事的两面。 */
    el.where.textContent = planFrames
      ? `${fmtTime(st.frame / fps)} / ${fmtTime(planSecs)}　·　第 ${Math.round(st.frame)} / ${planFrames} 帧`
      : "—";
    const clips = (st.film && st.film.clips) || [];
    const total = clips.length;
    const done = clips.filter((c) => c.playable).length;
    /* 20261107：后端已保序去重，这里再兜一次，旧档案/旧快照也不显示两遍。 */
    const brokenIds = [...new Set((st.film && st.film.broken) || [])];
    const broken = brokenIds.length;
    // 当前段的接缝写进底栏：不用 hover 到那条细缝上也能看见
    const cur = clips.find((c) => c.id === st.cur);
    const seam = cur ? seamOf(cur) : null;
    /* 当前段帧数精确输入框：只回显、不改数据（改走 change 事件里的 onResize）。
       锁定段 / 渲染中 / 没接 onResize 都禁用 —— 跟拖边缘同一个闸门。 */
    if (el.frames) {
      if (cur) {
        el.frames.value = String(netOfTotal(int(cur.frames), int(cur.trim_frames)));
        el.frames.disabled = !opts.onResize;
      } else {
        el.frames.value = "";
        el.frames.disabled = true;
      }
    }
    /* 「N / M 段已渲染」比原来那句「N 段待生成」直白：用户问的是"我拍到哪儿了"，
       不是"还差几段"。待生成的数量等于两者之差，不用再写一遍。 */
    el.stat.textContent = total
      ? `${done} / ${total} 段已渲染　·　全片 ${fmtTime(st.film.seconds)}`
        + (broken ? `　·　⚠ ${broken} 段档案读不出来（${brokenIds.join("、")}）` : "")
        + (seam ? `　·　接缝${seam.tag}（${seam.score.toFixed(4)}）` : "")
        + (st.playAll ? "　·　▶ 整片连播中（再点画面暂停）" : "")
      : "";
    el.stat.classList.toggle("bzf-warn", !!broken || !!(seam && seam.tag === "跳"));
  }

  /* 当前段帧数精确输入：敲一个准数，吸到 H3 网格后走 onResize 落库。
     与拖边缘是同一件事的两种入口 —— 拖个大概、敲个准数。 */
  el.frames.addEventListener("change", async () => {
    const row = curRow();
    if (!row || !opts.onResize) return;
    const trimN = int(row.trim_frames) || 0;
    const v = totalOfNet(Number(el.frames.value), trimN);
    el.frames.value = String(netOfTotal(v, trimN));
    try {
      const res = await opts.onResize(row, v);
      await refresh();
      if (res && typeof res.to === "number" && res.to !== v) {
        note(`第 ${row.index} 段：${v} 帧不在 H3 网格上，已取 ${res.to} 帧`);
      }
    } catch (err) {
      el.meta.textContent = `改时长失败：${err.message || err}`;
      el.meta.className = "bzf-meta bzf-err";
    }
  });

  /* ---- seek 排队（20261010 用户选的方案 ①，播放器行业标准做法）----
     拖播放头时每秒会有一百次"想到达的位置"。直接每次赋值 currentTime，
     每次都打断解码器正在进行的解码、从关键帧重来 —— 解码器永远干不完活，
     画面卡住直到松手。改成：只记住最新目标；视频一旦空闲（不在 seeking）
     或刚完成一次 seek（seeked），就立刻跳到**最新**目标。解码器不被打断。 */

  /* ---- ARM：就位才出画（20261010at，用户报"是好多了，但是他会闪一下"）----
     闪的根因不是 seek 慢，是**顺序错了**：
       换源 → loadeddata 到（此时 video 停在 **0 帧**）→ 撤垫图 → play()
       → 几百毫秒后 seek 才真的落到"本段新画面开头"。
     可单段成片的 **0 帧是承接上一段尾帧的重绘**（接缝重叠区），于是屏幕上
     先掠过一小段"上一段的尾巴"，再跳到正确位置 —— 肉眼就是"闪一下"。
     上一版在 timeupdate 里自愈（跑进重叠区就拽回），只是把这个跳往后挪，
     跳本身还在，所以"好多了但还是闪"。

     正解（W3C / MSE 与播放器工程里的通行做法：**切换点必须发生在解码器
     已经停在目标帧之后**，而不是先播再拽）：
       · 换源后把要对到的秒数记进 armGoal，垫图**一直盖着**不撤；
       · 与此同时把垫图换成**目标那一帧**的抽帧图 —— 静态图与视频到位后
         的第一帧是同一幅画面，撤图那一刻两边像素一致，交换不可察觉；
       · seeked 真的到位（误差 ≤ 半帧）且目标垫图已就位 → 撤垫图、起播。
     整个"换源→seek"窗口里屏幕上只有一张静止图，没有运动帧可闪。 */
  let armGoal = null;      /* 要对到的秒数；null = 不用对位 / 已就位 */
  let armTimer = 0;        /* 超时兜底，免得监视器永远停在一张垫图上 */
  let armPlay = false;     /* 就位之后要不要接着播（连播接段用） */
  let armImgOk = true;     /* 目标垫图是否已加载好 */

  let armTries = 0;        /* seek 到位失败的重试次数（防死循环） */
  function armedTo(goal) {
    armGoal = goal;
    armTries = 0;
    if (armTimer) clearTimeout(armTimer);
    /* 兜底：有些浏览器/损坏文件压根不发 seeked —— 1.2s 后无条件出画起播，
       宁可见一次旧式的跳，也不能把监视器冻在静态图上。 */
    armTimer = setTimeout(() => { revealVideo("arm 超时"); }, 1200);
  }
  /** 换源/作废时把整件事取消（**不**出画，让垫图继续盖着）。 */
  function cancelArm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    armGoal = null; armPlay = false; armImgOk = true; armTries = 0;
  }
  function armDone() {
    const fps = Number((st.info && st.info.fps) || 24) || 24;
    return Math.abs(el.video.currentTime - armGoal) <= 0.6 / fps;
  }
  /** 等 video 的当前帧**真的提交给合成器**之后才执行 fn。
      首选 requestVideoFrameCallback —— W3C 标准，只在某帧提交给合成器那一刻
      回调，是「画面确实上屏」的确定性信号，不再靠数 rAF 猜。
      但 paused 的视频不产新帧、rvfc 可能永不回调，所以补一道超时兜底：
      宁可垫图多盖一瞬（它本来就是贴着接缝的那幅画面，无感），也不能让屏幕
      空一帧（黑一帧看得一清二楚）。没有 rvfc 的浏览器退回双 rAF（旧行为）。 */
  function whenVideoPainted(fn) {
    const v = el.video, seq = st.seq, src = v.src;
    let fired = false, frameId = null, timer = 0, raf = 0;
    const cancel = () => {
      fired = true;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      if (frameId !== null && typeof v.cancelVideoFrameCallback === "function")
        v.cancelVideoFrameCallback(frameId);
    };
    const fire = () => {
      if (fired) return;
      cancel();
      if (!st.dead && seq === st.seq && v === el.video && src === v.src) fn();
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      frameId = v.requestVideoFrameCallback(fire);
      timer = setTimeout(fire, 80);   /* paused 的帧已提交时，回调可能赶不上 */
    } else {
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(fire); });
    }
    return cancel;
  }
  /** 条件齐了才撤垫图 + 起播；不齐就什么都不做，等下一次事件。 */
  function revealVideo(why) {
    if (armGoal === null) return;            // 没在等对位（或已出过画）
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    const sloppy = why === "arm 超时";        // 超时兜底：不再挑三拣四
    if (!armDone()) {
      /* 差得远 —— 浏览器把 seek 吸到邻近关键帧上了是常态。再拽一次，
         拽三次还不准就认了（继续等只会无限循环）。 */
      if (!sloppy && ++armTries <= 3) {
        /* 直接走队列，不走 requestVideoSeek(_, true)：那会把 armTries 清零，
           三次作废的重试就永远数不满了。 */
        seekTarget = armGoal; flushVideoSeek();
        return;
      }
    }
    if (!armImgOk && !sloppy) return;        // 视频到位了，等目标垫图跟风
    console.info("[H3 Studio] 换源就位：目标", (armGoal || 0).toFixed(3) + "s",
      "实际", el.video.currentTime.toFixed(3) + "s", "→", why);
    armGoal = null;
    /* 到这一步 video 里已经是"该看的那一帧"了 —— 才允许它露脸。 */
    el.video.classList.add("bzf-ok");
    /* 等 video 这一帧真的提交给合成器再撤垫图（20261010br）：原来这里同步
       撤，垫图一撤、视频首帧还没上屏 → 中间一帧黑。这正是「接缝黑一帧」的
       第二副本 —— loadeddata 那条路等了两帧 rAF，这里一个都没等。 */
    whenVideoPainted(() => { el.img.classList.remove("bzf-ok"); hideFreeze(); });
    if (armPlay) { armPlay = false; el.video.play().catch(() => {}); }
  }
  /** 手一动就不再"等对位"（20261010bg）：上一次换源留下的 arm 作废、立刻亮
      画面。arm 是为**自动**换源（连播接段、点段）设计的捂画面策略，捂的是
      "还没 seek 到位的那几百毫秒"；人在搓的时候捂它毫无意义 —— 最坏要等
      1.2s 超时才露出视频，搓一下像卡住了。取消归取消，seek 目标照旧排队，
      画面该对到哪儿还是对到哪儿。 */
  function abortArmAndShow() {
    if (armGoal === null) return;
    cancelArm();
    el.video.classList.add("bzf-ok");
    el.img.classList.remove("bzf-ok");
  }
  /** 把垫图换成**目标那一帧**：静态图与视频到位后的第一帧同源同帧，
      撤图的那一刻两边画面一致，交换肉眼接不出来。 */
  function armPoster(path, frameNo, ver, seq) {
    armImgOk = false;
    el.img.addEventListener("load", () => {
      if (seq !== st.seq) return;
      armImgOk = true; revealVideo("垫图就绪");
    }, { once: true });
    el.img.addEventListener("error", () => {
      if (seq !== st.seq) return;
      /* 抽帧图拿不到（后端没重启 / 正在重抽）不等于不能出画 —— 放行，
         退回"静态换动态"的老行为，总比冻住强。 */
      armImgOk = true; revealVideo("垫图缺失");
    }, { once: true });
    el.img.src = turl(path, frameNo, 320, ver);
    el.img.classList.add("bzf-ok");
    /* 命中缓存时浏览器可能不重放已解码图片的 load 事件，补一脚同步检查。 */
    if (el.img.complete && el.img.naturalWidth) {
      armImgOk = true; revealVideo("垫图已缓存");
    }
  }

  let seekTarget = null;        /* 最新目标（秒，视频内时间）；null = 没有 */
  let seekPaintCancel = null;   /* 一次 seek 完成后先让该帧呈现，再追最新目标 */
  function resetSeekQueue() {
    if (seekPaintCancel) seekPaintCancel();
    seekPaintCancel = null;
    seekTarget = null;
  }
  function seekFramePresented() {
    if (seekPaintCancel || el.video.seeking || el.video.readyState < 2) return;
    seekPaintCancel = whenVideoPainted(() => {
      seekPaintCancel = null;
      if (wholeMode) {
        if (wholeReveal) {
          wholeReveal = false;
          el.video.classList.add("bzf-ok");
          el.img.classList.remove("bzf-ok");
          hideFreeze();
          resumeWholePlay();
        }
        flushWholeSeek();
      } else {
        if (armGoal === null) {
          el.video.classList.add("bzf-ok");
          el.img.classList.remove("bzf-ok");
          hideFreeze();
        }
        flushVideoSeek();
        if (switchWant && !switching) runSwitch();
      }
    });
  }
  function requestVideoSeek(t, arm) {
    seekTarget = t;
    if (arm && t > 0.04) armedTo(t);
    flushVideoSeek();
  }
  function flushVideoSeek() {
    const v = el.video;
    if (wholeMode || st.dead || seekTarget === null || seekPaintCancel
        || v.seeking || v.readyState < 1 || !st.span) return;
    const fps = Number((st.info && st.info.fps) || 24) || 24;
    const end = Number.isFinite(v.duration) ? Math.max(0, v.duration - 1 / fps) : Infinity;
    const t = clamp(seekTarget, 0, end);
    if (Math.abs(v.currentTime - t) <= 0.5 / fps) { seekTarget = null; return; }
    try { v.currentTime = t; seekTarget = null; }
    catch { /* 未就绪不丢目标，等 metadata / loadeddata 再补冲 */ }
  }

  /* 双缓冲：两套媒体事件 A/B 各绑一份。回调里 el.video（getter）指向当前在播的
     那一条，逻辑无需区分事件来自哪条。 */
  function bindMedia(v) {
  v.addEventListener("play", () => { if (v === el.video) refreshCenter(); });
  v.addEventListener("pause", () => { if (v === el.video) refreshCenter(); });
  v.addEventListener("seeked", () => {
    if (v !== el.video) return;   /* 双缓冲：只理当前在岗那条，备用 seeked 忽略 */
    if (wholeMode) { seekFramePresented(); return; }  /* 整片也要等本帧呈现再追最新位置 */
    /* 换源定位（ARM）走到这一步才是真到位 —— 交给 revealVideo 裁决：
       到位了就撤垫图/起播，没到位就再拽一次（见 armTries）。 */
    if (armGoal !== null) revealVideo("seeked");
    seekFramePresented();
  });
  /* 补一道最晚的保险（20261010）：`playing` 在真正开始播放那一刻才触发 ——
     不管 loadedmetadata 早到被消费、还是 currentTime 赋值被"未就绪"吞掉，
     只要还欠着一个 seek 目标，播放开动时在这里兜底冲一次，跨段接播就不会
     从 0 帧起（那是"倒回来重播上一段尾巴"的唯一来源）。 */
  v.addEventListener("playing", () => { if (v === el.video && !wholeMode) flushVideoSeek(); });
  v.addEventListener("timeupdate", () => {
    if (v !== el.video) return;   /* 备用 video 不回写播放头 */
    /* 拖动中不回写（20261010 用户报"指针乱飘、抖动"的根因）：seek 还没完成时
       currentTime 仍是旧值，这里无条件回写会把播放头拽回去，跟手上的拖动
       互扯 —— 一扯一松就成了抖动。拖动期间播放头只听 seekFrac 的。 */
    if (st.drag || press || seekPaintCancel || seekTarget !== null
        || (wholeMode && (wholeWant >= 0 || wholeReveal))) return;
    if (wholeMode) {
      /* 整片连续片：currentTime*fps 即全片帧（第0帧对齐），播放头线性跟随；
         跨段顺带对齐段高亮（不 loadVideo、画面始终由连续片提供、不闪）。 */
      const wfps = (wholeInfo && wholeInfo.fps)
                   || Number((st.info && st.info.fps) || 24) || 24;
      const f = Math.min(totalFrames() - 1,
                         Math.max(0, Math.round(v.currentTime * wfps)));
      st.frame = f;
      setPlayheadAbs(fracOfFrame(f));
      followPlayhead(f);
      if (el.ptip) el.ptip.innerHTML =
        `<b>${fmtTime(f / wfps)}</b><span>${f} 帧</span>`;
      const wrow = rowAtFrame(f);
      if (wrow && wrow.id !== st.cur) { st.cur = wrow.id; renderSegs(); }
      return;
    }
    /* 还在"等对位"就别回写（20261010at）：此刻 currentTime 基本是 0（视频
       刚换源、seek 未落定），拿它算会把播放头钉回段首 —— 画面无误可播放头
       先跳一下，同样读作"闪"。等 revealVideo 出画后这一段才恢复正常。 */
    if (armGoal !== null) return;
    /* 换源进行中：currentTime 属于**还没卸掉的那条旧片**，拿它回写播放头
       会把指针钉到旧片的坐标系上 —— 指针乱飘。等 loadeddata 认下新身份再说。 */
    if (!loadedId) return;
    const fps = Number((st.info && st.info.fps) || 24) || 24;
    /* 段内 → 全片：视频给的是"这条成片里播到第几秒"，加上它 0 时刻在全片的
       位置才是整部片子里的位置。认的是**已装载那一段**（loadedId），不是
       curRow() —— 见 loadedId 处的注释。 */
    const row = rowById(loadedId);
    /* 连播快到接缝了就把下一段预备好（20261010bj，见 prewarmNext）：提前
       PREWARM_SEC 秒动手，够后端把播放版现生成出来、够浏览器把文件取回来 ——
       接段那一刻就不用再等，接缝只停一两帧。
       放在自愈分支**之前**：那一条会 return 掉后面所有回写，而它恰恰只在"视频
       还停在重叠区"时触发 —— 正是最需要预载的时候。 */
    if (st.playAll && row) {
      const dur = el.video.duration;
      if (isFinite(dur) && dur > 0 && dur - el.video.currentTime <= PREWARM_SEC) {
        prewarmNext(row);
      }
    }
    /* 连播自愈（20261010 换更稳的方案，不再赌单次 seek）：
       换源后若视频没按预期从"本段新画面开头"起跳（浏览器对"未就绪就 seek"
       会抛 InvalidStateError，各版本时序还不一样），它会从 0 帧起 —— 0 帧起
       就是那 39 帧"照上一段尾巴重绘"的接续重叠，于是每段播完都倒回去重播。
       与其修那个脆弱的 seek，不如在 timeupdate 里自愈：连播中只要当前这条是
       **单段成片**、且 currentTime 还停在重叠区里，就立刻拽到新画面开头。
       任何一次 seek 失败都救得回来，且是确定性的（不靠事件时序）。 */
    if (st.playAll && loadedKind === "raw" && row && !isCumulative(row)) {
      /* 只对**原片口径**生效（20261010av）：播放版的重叠帧已被服务端掐掉，
         它就是从"本段新画面"播起的 —— 这里若再按 trim 拽它，会把正常播放
         的片子永远钉在 1.6s 上（0 < startSec 恒成立）。播放版不需要自愈。 */
      const trim = Math.min(Math.max(0, int(row.trim_frames)),
                            Math.max(0, int(row.frames) - 1));
      const startSec = trim / fps;
      if (startSec > 0.05 && el.video.currentTime < startSec - 0.04) {
        try { el.video.currentTime = startSec; } catch { /* 未就绪，下一帧再试 */ }
        return;   // 这一帧的 currentTime 是重叠区的旧值，别拿去写播放头
      }
    }
    st.frame = loadedT0(row) + el.video.currentTime * fps;
    setPlayheadAbs(fracOfFrame(st.frame));
    followPlayhead(st.frame);
    syncFoot();
  });
  v.addEventListener("loadedmetadata", () => {
    if (v !== el.video) return;   /* 备用 metadata 不作用于当前状态 */
    /* 不再按真实分辨率改 --bzf-ar：监视器固定 16:9，尺寸不随素材横竖变。 */
    if (wholeMode) { flushWholeSeek(); return; }  /* 元数据就绪，补最新整片目标 */
    /* 换源后第一次拿到元数据：把没冲出去的 seek 目标补上（见 flushVideoSeek）
       —— 刚换源就 seek 必然"未就绪"，没有这一步，跨段切进来的画面永远停在
       段首，timeupdate 再把播放头拽回去，看着就是"拖过去了又闪回开头"。 */
    flushVideoSeek();
    if (!st.span && el.video.duration) {
      const fps = Number((st.info && st.info.fps) || 24) || 24;
      st.span = Math.max(1, Math.round(el.video.duration * fps));
      layout();
    }
    syncFoot();
    /* 双缓冲交棒：新 active 刚就绪，补好起点再续播（见 handoverTo）。 */
    if (autoContinue) {
      autoContinue = false;
      try { if (handoverSeek > 0.02) el.video.currentTime = handoverSeek; } catch { /* 忽略 */ }
      handoverSeek = -1;
      el.video.play().catch(() => {});
    }
  });
  v.addEventListener("loadeddata", () => {
    if (wholeMode && v === el.videoA) {
      flushWholeSeek();
      if (!v.seeking) seekFramePresented();
      return;
    }
    if (v !== el.video) return;   /* 关键：备用首帧不得提前露出/误加 bzf-ok */
    /* 第一帧出来了（身份早在 src 赋值那一行就定下了，见那里）。落地即把画面
       对到播放头：换源完成时视频停在 0 帧，而播放头多半不在段首 —— 不补这
       一脚，画面和指针说的就不是一个位置，拖一下才对上，肉眼就是一次跳。
       **但 ARM 正等对位时不能插这一脚**（20261010bg）：那一脚的目标已经记在
       armGoal 里，两个主人同时写 currentTime，arm 的"到位"判据（读
       currentTime）会被自己补的这一脚提前判成已到位 —— 垫图在 seek 真正落定
       之前就撤了，"闪"原样回来。换源定位期间 armGoal 独占这一脚。 */
    if (armGoal === null) settleLoadedSeek();
    /* 拖动中的跨段尾补也要等这一帧呈现，不能 loadeddata 一到就再次换源。 */
    if (!v.seeking) seekFramePresented();
    if (armGoal !== null) return;
    el.video.classList.add("bzf-ok");
    /* 等 video 首帧**真的上屏**再撤垫图（20261010br）：原来用「等两帧 rAF」
       估算合成周期，慢机器两帧不够就黑一帧。改成 rvfc（帧提交给合成器的确定
       信号），paused 不产帧时退超时兜底 —— 垫图多盖一瞬无感，屏幕空一帧
       看得一清二楚。 */
    whenVideoPainted(() => { el.img.classList.remove("bzf-ok"); hideFreeze(); });
  });
  /* 装不上（文件被删 / 半截文件 / 编码坏了）：身份必须跟着作废，否则
     loadingId 一直挂着那一段，requestSwitch 会永远认为"正在装"而不再换，
     监视器就冻在一条播不了的片子上。 */
  v.addEventListener("error", () => {
    /* 备用 video 装载失败：作废 buf，让接缝走回退（定格）路径 */
    if (v !== el.video) {
      if (v === standbyEl() && buf.id) {
        bufToken++;
        buf.id = null; buf.kind = null; buf.buffered = false;
        buf.loading = false; buf.firstSec = 0;
      }
      return;
    }
    if (wholeMode) {
      exitWhole();
      haltPlayback();
      el.cap.textContent = "整片预览片读取失败：可再点播放重试，或先检查各段成片";
      return;
    }
    loadingId = null; loadedId = null; loadedKind = null;
    hideFreeze();
    if (switchWant && !switching) runSwitch();
  });
  }
  bindMedia(el.videoA);
  bindMedia(el.videoB);

  el.view.addEventListener("click", async (e) => {
    if (e.target.closest(".bzf-bar")) return;
    try { el.band.focus(); } catch { /* 点过画面，键盘也对这条轴生效 */ }
    /* 同上：问"在不在播"要问在岗的那一个，整片预览下是 videoA。 */
    /* 判「在不在播」不能只问 video.paused：没成片时 video 永远 paused，
       每次点都走启动分支，音轨被反复唤起且永远停不下来（20261108 用户报）。 */
    const playing = st.playAll
      || (audioLaneApi && audioLaneApi.isPlaying && audioLaneApi.isPlaying());
    if (!playing) {
      /* 点播放：先立即播当前段、整片就绪后无感升级（见 startPlayback），零等待。 */
      await startPlayback();
      return;
    }
    /* 播放中点 = 暂停（整片预览也停），音轨由 pausePlay 统一收。 */
    pausePlay();
  });

  /* ============== 整片预览模式（20261011，根治接缝闪黑）==============
     连播 / 跨段拖动不做"两个 video 交棒"，而播后端按当前段顺序拼好的【一条】
     整片连续片：固定 videoA、videoB 停用；全局帧 f → currentTime=f/fps（线性、
     第0帧对齐），跨接缝是同一条视频内的普通 seek，原理上不闪。
     首次播放后端流复制拼接（几秒），期间保留当前画面、不露黑；之后按签名缓存。 */
  /* 用一份已就绪的整片 info 把 videoA 装成整片播放器（固定单 video）。 */
  function mountWholeInfo(info, atFrame) {
    resetBuffer();
    /* 清理备用后再冻结当前在岗画面，避免 resetBuffer 同步撤掉冻结层。 */
    showFreeze();
    st.seq++;                          /* 作废旧段的在途 /info 和撤罩回调 */
    cancelArm();
    resetSeekQueue();
    switchWant = null;
    loadedId = null; loadingId = null; loadedKind = null;
    wholeInfo = info;
    wholeMode = true;
    wholeReveal = true;
    activeIsA = true;                    /* 固定 videoA 当整片播放器 */
    /* 分段那条 video 必须一起停：它此前正在播（startPlayback 先播的是分段源，
       整片就绪才升级），升级之后画面归 videoA，它却还在后台一路解码 —— 屏幕上
       看不见、耳朵里听不见，解码线程与显存照占，"预览完之后机器空转、风扇狂
       转"就有它一份。留着它还更糟：下面问"在不在播"问错人时，一看它 paused=false
       就以为还在播，暂停键因此失灵。 */
    try { el.video.pause(); } catch { /* 已停 */ }
    try { el.videoB.pause(); } catch { /* 已停 */ }
    el.videoB.classList.remove("bzf-ok");
    const v = el.videoA;
    v.dataset.whole = info.signature;
    v.muted = audioMuted;
    wholeWant = atFrame;
    v.src = `${JOIN}/video?video=${encodeURIComponent(info.path)}`
          + `&v=${encodeURIComponent((info.signature || "x").slice(-10))}`;
  }
  /* 装载完成后（整片首帧 rvfc 上屏）若仍要播放，继续 play，避免升级后停住。 */
  function resumeWholePlay() {
    const v = el.videoA;
    const seq = st.seq, token = playbackToken;
    const go = () => {
      if (!st.dead && seq === st.seq && token === playbackToken
          && wholeMode && st.playAll && !wholeReveal) v.play().catch(() => {});
    };
    if (v.readyState >= 2) go();
    else v.addEventListener("loadeddata", go, { once: true });
  }
  let playbackToken = 0;
  let wholeBusy = null;       /* 每次拖动只查一次缓存，不积压旧帧的 async 等待者 */
  async function enterWhole(atFrame) {
    if (wholeMode) { wholeSeek(atFrame); return true; }
    if (wholeBusy || wholeChecked) return false;
    wholeChecked = true;
    const token = wholePrepareToken, nm = opts.getName();
    const job = (async () => {
      let info;
      try {
        info = await getJSON(`${CHAIN}/preview_film?name=${encodeURIComponent(nm)}&ensure=0`);
      } catch { return false; }
      if (st.dead || token !== wholePrepareToken || nm !== opts.getName()
          || !st.drag || !info || !info.ok) return false;
      /* 等待查询期间仍用分段预览；缓存命中才升级，并采用现在的最新帧。 */
      mountWholeInfo(info, st.frame);
      return true;
    })();
    wholeBusy = job;
    try { return await job; } finally { if (wholeBusy === job) wholeBusy = null; }
  }
  /* 点播放 / 空格统一入口（方案3）：先立即播当前段（零等待出声出画），后台触发
     预热并轮询；整片就绪后在当前帧无感升级 wholeMode、继续播放。超时未就绪则
     当前段继续播、跨段走旧双缓冲兜底，不打断用户。 */
  /* 统一停止：状态与音轨一起收。以前只置 st.playAll，音轨靠 video 的 pause
     事件捎带停 —— 没成片时 video 根本不播、永远不发 pause，声音就在后台一直响。 */
  function haltPlayback() {
    st.playAll = false;
    if (audioLaneApi && audioLaneApi.stopAudio) audioLaneApi.stopAudio();
  }
  const WHOLE_WAIT_MS = 12000, POLL_MS = 600;
  async function startPlayback() {
    /* 没有成片视频时点监视器 / 空格不该出声：以前无条件 primeAudio 把音轨唤起，
       视频却没源不播，声音就在空画面下一直响（20261112 用户报）。有 playable
       成片才进入播放，否则直接返回 —— 不碰音轨、不置 playAll，下次点仍是启动分支。 */
    if (!firstPlayableRow()) return;
    /* 在用户手势链里先唤起参考音轨，避开浏览器自动播放拦截。 */
    if (audioLaneApi && audioLaneApi.primeAudio) audioLaneApi.primeAudio();
    const token = ++playbackToken, nm = opts.getName();
    st.playAll = true;
    const valid = () => !st.dead && token === playbackToken && nm === opts.getName() && st.playAll;
    if (wholeMode) { resumeWholePlay(); return; }  /* 恢复整片不重设相同 src */
    const seg = el.video, src = seg.src;
    /* 播放入口每次强行取消静音会盖过音轨喇叭，读同一份状态。 */
    seg.muted = audioMuted;
    const kickSeg = () => { if (valid() && seg === el.video && src === seg.src) seg.play().catch(() => {}); };
    if (seg.readyState >= 2) kickSeg();
    else seg.addEventListener("loadeddata", kickSeg, { once: true });
    const q0 = `${CHAIN}/preview_film?name=${encodeURIComponent(nm)}&ensure=0`;
    let info = null;
    try { info = await getJSON(q0); } catch { info = { ok: false }; }
    if (!valid()) return;
    if (!info.ok) {
      try { getJSON(`${CHAIN}/prewarm?name=${encodeURIComponent(nm)}`); }
      catch { /* 忽略 */ }
      const t0 = Date.now();
      while (valid() && Date.now() - t0 < WHOLE_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!valid()) return;
        try { info = await getJSON(q0); } catch { info = { ok: false }; }
        if (!valid()) return;
        if (info.ok) break;
      }
    }
    if (info.ok && valid() && !wholeMode) {
      mountWholeInfo(info, st.frame);
      resumeWholePlay();
    }
  }
  function exitWhole() {
    playbackToken++;
    wholePrepareToken++;              /* 选段/清空后，不让旧缓存查询重新接管画面 */
    wholeChecked = false;
    wholeBusy = null;
    if (!wholeMode) return;
    resetSeekQueue();
    wholeMode = false; wholeInfo = null; wholeWant = -1; wholeReveal = false;
    loadedId = null; loadingId = null; loadedKind = null;
    try { delete el.videoA.dataset.whole; }
    catch { el.videoA.removeAttribute("data-whole"); }
  }
  function wholeSeek(f) {
    const maxF = (wholeInfo && wholeInfo.frames) ? wholeInfo.frames - 1 : totalFrames() - 1;
    wholeWant = clamp(Math.round(f), 0, maxF);
    flushWholeSeek();
  }
  function flushWholeSeek() {
    const v = el.videoA;
    if (!wholeMode || st.dead || wholeWant < 0 || seekPaintCancel
        || v.seeking || v.readyState < 1) return;
    const fps = Number(wholeInfo && wholeInfo.fps) || 24;
    const end = Number.isFinite(v.duration) ? Math.max(0, v.duration - 1 / fps) : Infinity;
    const t = clamp(wholeWant / fps, 0, end);
    if (Math.abs(v.currentTime - t) <= 0.5 / fps) {
      wholeWant = -1;
      if (wholeReveal) seekFramePresented();
      return;
    }
    try { v.currentTime = t; wholeWant = -1; }
    catch { /* 目标保留，等 metadata / loadeddata 补冲；不持续抢占解码 */ }
  }

  /* 一段播完 → 接下一段继续播。
     两个分支：
       · 普通（单段成片）：切到轴上**下一个有成片的段**接着播；
       · 当前这条是**累积成片**（前 k 段拼的）：下一段那条会把前面重播一遍，
         所以整片改由"最后一个有成片的段"那一条一次播完（它的成片就是 1..k）。
     走到最后一个有成片的段就收工，playAll 关掉。 */
  /* 不用 rAF 提前交棒：rAF 跑在浏览器合成 vsync，和视频自身的呈现 vsync 不同步，
     "距末帧约一帧"的判定不精确，容易少切/晚切一帧，接缝反而闪一下（续接合成面板
     老实等 ended 就不闪）。末帧黑已由后端播放版 CFR 修复（末帧有正常呈现时长），
     接缝统一由 ended → onEnded → handoverTo 完成。 */

  const onEnded = async () => {
    if (wholeMode) { haltPlayback(); syncFoot(); return; }  /* 整片连续片播完：收工 */
    if (!st.playAll || st.dead) return;
    const row = curRow();
    const target = seamTarget(row);
    /* —— 双缓冲无缝路径（方案B/M2）：备用 video 已提前装好下一段。交棒只切
       可见性、在可见元素上 seek、就绪即播，不换源、不走定格/ARM。
       若还没缓冲到首帧（短段/慢盘），原地等最多 700ms —— 旧段末帧仍在屏不黑，
       缓冲到再交棒；等不到才落到下面的回退（定格）路径。 —— */
    if (target && buf.id === target.id) {
      /* 等备用把首帧 seek 就位（ready）最多 700ms，旧段末帧在屏不黑；ready 才
         无缝交棒。只 buffered 而首帧没对好，就落到下面的定格回退路径。 */
      if (!buf.ready) await waitReady(700);
      if (buf.ready && buf.id === target.id) {
        try { await handoverTo(target); } catch { haltPlayback(); }
        return;
      }
    }
    if (!target || (row && target.id === row.id)) {
      haltPlayback();
      syncFoot();
      return;
    }
    try {
      /* 接缝定格（20261010bj）：换源**之前**把此刻这一帧（上一段最后一帧）就地
         铺到垫图层，并立起 seamHold 让 showPoster 别插一脚。
         不这样做的话，接缝会跳三下（旧垫图=上一段中段 → 新垫图=下一段中段 →
         视频第一帧），而保存出来的成片只跨一个帧边界 —— 这就是"成片还好、时间
         轴跳"的全部差别。定格之后与成片同构：只剩"上一段最后一帧 → 下一段第
         一帧"这一次换画。理由详见上面「接缝」那一段的注释。
         抓不到（还没解码 / 画布脏）也不打紧：那只是退回"多停一会儿"，不会再多
         跳一次。 */
      seamHold = true;
      seamFrozen = freezeCurrentFrame();
      /* 连播自动接下去的那一段也算"用户正在看的"（20261010 修）：播到一半
         来了次刷新，userPick 还指着起播那一段，refreshInner 会把连播拽回去。 */
      userPick = target.id;
      /* 连播接下一段 = 从**这一段自己的开头**播（20261010aw）。原来靠
         "上一段末尾恰好等于本段 clip_from"这个巧合来得到 0 —— 上一条是
         累积片/整片时 st.frame 会停在全片末尾，那个巧合就不成立了：会一头
         栽到下一段的尾巴上，又是一次跳变。先按档案归位一次（让 loadVideo
         的对位直接落在段首），select 之后再按 /info 回写的真实帧数校一次。 */
      const tgtRow = ((st.film && st.film.clips) || [])
        .find((c) => c.id === target.id);
      /* 一律归位到**本段在全片里的起点** clip_from（20261010ba 修）。
         早先这里写的是「累积片归位到 0」：累积片的 0 时刻是全片第 0 帧，
         于是连播接到第 k 段时整条片子从头放起 —— 前面几段又播了一遍，正
         是"每一段都播了两遍"。videoT0 已经把三种情形都算对了（播放版 →
         clip_from；原片累积片 → 0；原片单段片 → clip_from - trim），这里
         只要给"我要看本段开头"这个意图就行，落点由 videoT0 换算。 */
      if (tgtRow) st.frame = int(tgtRow.clip_from);
      await select(target.id, false);
      /* 换源落地 —— 定格解除。往后（刷新、点段、搓动）垫图照旧由 showPoster
         负责；只有"连播接段"这一下不许它插手。 */
      seamHold = false;
      seamFrozen = false;
      frzReady = null;      /* 这道接缝用完了，下一次重新等（见 frzReady 的注释） */
      if (st.playAll && !st.dead) {
        /* 校一次：/info 已把真实帧数写回 row，"是不是累积片"这时才靠得住。 */
        const r0 = curRow();
        if (r0) st.frame = int(r0.clip_from);
        const v0 = videoT0(r0);
        const fp0 = Number((st.info && st.info.fps) || 24) || 24;
        const want = Math.max(0, (st.frame - v0) / fp0);
        console.info("[H3 Studio] 连播接下一段：",
          r0 && r0.id, "| st.frame=", Math.round(st.frame),
          "| videoT0=", v0, "| 应seek到=", want.toFixed(3) + "s",
          "| 当前 currentTime=", el.video.currentTime.toFixed(3) + "s");
        /* 兜底：不等事件，这里再明确 seek 一次到本段新画面开头（trim 处）。
           loadVideo 里已 seek 过一次，这里重复是无害的幂等操作，专治各种
           "事件被消费/赋值被吞"的浏览器时序。
           arm=true：这次 seek 是**换源定位**，要走"就位才出画"； */
        if (want > 0) requestVideoSeek(want, true);
        /* 还没就位就别急着 play()（20261010at）—— 那等于让视频从"0 帧"先动
           起来再被 seek 拽走，旧版的"倒回去播一遍接续帧 + 闪一下"就是这么
           来的。登记 armPlay，等 revealVideo 确认落在目标帧上再起播。 */
        if (armGoal !== null) armPlay = true;
        else await el.video.play().catch(() => {});
      }
    } catch {
      haltPlayback();
      /* 接段没接成（/info 失败 / 段被删）也得把定格解掉 —— 留着它，后面每一次
         正常切段都不再垫图，监视器从此没有垫图可用。 */
      seamHold = false;
      seamFrozen = false;
    }
  };
  /* ended 两条 video 都要监听（只有在播的那一条会真触发，备用那条恒 paused）。 */
  el.videoA.addEventListener("ended", () => { onEnded(); });
  el.videoB.addEventListener("ended", () => { onEnded(); });

  /* 时间轴上按下 = 搓动（seek）。
     原来这里写的是「点在段块上就不搓动，交给段块去选中」—— 可段块铺满整条
     轴（一段接一段，中间没有空隙），这条规则等于把搓动彻底废掉：轴上每一寸
     都是段块，红色播放头永远拖不动。
     改成一次按下两种归宿：横向移动超过几像素才算搓动，没超过就是点一下（选段）。
     这样段块上照样能搓，点一下照样选段，两件事不再互相顶掉。 */
  const SCRUB_SLOP = 4;
  let press = null;            // { x } —— 按下时的横坐标，用来分辨「拖」还是「点」
  function fracFromEvent(e) {
    const r = el.band.getBoundingClientRect();
    const cw = el.band.clientWidth || 1;
    const scale = r.width ? r.width / cw : 1;
    /* 视口像素 → 布局像素（除画布缩放）→ 内容像素（加滚动偏移）→ 帧 → 比例 */
    const localX = (e.clientX - r.left) / scale;
    const contentX = localX + el.band.scrollLeft - TRACK_GUTTER;
    const frame = clamp(tEngine.frameAtX(contentX), 0, totalFrames());
    return frame / totalFrames();
  }
  el.band.addEventListener("pointerdown", (e) => {
    /* 右键留给菜单，拖时长把手归把手 */
    if (e.button !== 0 || e.target.closest(".bzf-grip")) return;
    justReordered = false;      // 新手势开始，上一次拖动的余味作废（同上）
    /* 手一碰轴，接缝定格就解除（20261010bj）：那是给**自动接段**用的，搓动时
       垫图该换还得换（见 showPoster 的 seamHold 判据）。 */
    seamHold = false;
    seamFrozen = false;
    /* 搓播放头 = 用户要自己定位 → 退出整片连播。不退出的话 timeupdate 会把
       播放头一秒几十次地拽回去，跟手上的搓动互扯，看着像播放头卡住了。 */
    haltPlayback();
    /* 搓动定位 = 暂停（剪辑软件手感）：整片在播就暂停整片、否则暂停当前段；
       不然播放态下 timeupdate 会把播放头拽走、画面也不跟手。 */
    try { if (wholeMode) el.videoA.pause(); else el.video.pause(); }
    catch { /* 忽略 */ }
    cancelScrubRaf();
    playbackToken++;
    wholePrepareToken++;
    wholeChecked = false;
    wholeBusy = null;
    press = { x: e.clientX };
    scrubbed = false;
    try { el.band.focus(); } catch { /* 点过轴就能用方向键/空格控制这条轴 */ }
  });
  let scrubRaf = 0, scrubEvent = null;
  function cancelScrubRaf() {
    if (scrubRaf) cancelAnimationFrame(scrubRaf);
    scrubRaf = 0; scrubEvent = null;
  }
  el.band.addEventListener("pointermove", (e) => {
    if (!press) return;
    if (!st.drag) {
      if (Math.abs(e.clientX - press.x) < SCRUB_SLOP) return;
      st.drag = true;
      scrubbed = true;
      /* 搓动中给 band 打标记：宿主据此不弹悬停工具条（它 fixed 悬在块上方，
         跟着鼠标出现/消失，看着就是"段块一直在闪"）。 */
      el.band.classList.add("bzf-scrubbing");
      el.play.classList.add("is-scrub");
      try { el.band.setPointerCapture(e.pointerId); } catch { /* 已捕获 */ }
    }
    /* 按帧节流（20261010）：scrub 每秒上百次 pointermove，seekFrac 里除了
       播放头还有时间码与视频 seek —— 合并到 rAF，一帧一次，正是剪辑软件
       的"每帧跟手"。 */
    scrubEvent = e;                  /* 同一显示帧内保留最新位置，不丢后续 move */
    if (scrubRaf) return;
    scrubRaf = requestAnimationFrame(() => {
      scrubRaf = 0;
      const ev = scrubEvent; scrubEvent = null;
      if (!press || !ev || st.dead) return;
      seekFrac(applySnap(fracFromEvent(ev), ev));
    });
  });
  /* 松手只做最终精确定位和选段收口；拖动中已通过串行视频预览实时出画。 */
  el.band.addEventListener("pointerup", (e) => {
    if (!press) return;
    cancelScrubRaf();
    wholePrepareToken++; wholeBusy = null;
    switchWant = null;
    press = null; st.drag = false;
    el.band.classList.remove("bzf-scrubbing");
    el.play.classList.remove("is-scrub");
    /* 松手统一处理三种情况：
       · 纯点击（没拖过）= 点哪跳哪（剪辑软件标准手感；原来 if(!scrubbed)return
         导致单击无反应）；
       · 快甩：最后一下位置还压在 rAF 队列没算，这里按松手位置补算；
       · 正常拖完：落到松手处。
       先过磁吸（按住 S / Ctrl·⌘ 不吸），再 settleAtFrame 统一收口、切段；
       松手后磁吸提示线与时间码气泡都收起。 */
    const frac = applySnap(fracFromEvent(e), e);
    settleAtFrame(Math.round(frac * totalFrames()));
    hidePlaySnap();
  });
  el.band.addEventListener("pointercancel", () => {
    cancelScrubRaf();
    wholePrepareToken++; wholeBusy = null;
    switchWant = null;
    press = null; st.drag = false;
    el.band.classList.remove("bzf-scrubbing");
    el.play.classList.remove("is-scrub");
    hidePlaySnap();
  });

  /* 轴上按下 = 搓动（seek）。位置按**整条轴**给：拖动时整部片子都在手底下，
     而不是只能在这一段里搓。 */
  function seekFrac(frac) {
    const fps = Number((st.info && st.info.fps) || 24) || 24;
    st.frame = clamp(Math.round(frac * totalFrames()), 0, totalFrames() - 1);
    setPlayheadAbs(fracOfFrame(st.frame));
    /* 搓动时间码气泡内容（class is-scrub 时才可见；隐藏时更新也无害）。 */
    if (el.ptip) el.ptip.innerHTML =
      `<b>${fmtTime(st.frame / fps)}</b><span>${Math.round(st.frame)} 帧</span>`;
    /* 整片预览模式：全局帧直接 seek 连续片（跨段也是同一条视频），不换源、不黑 */
    if (wholeMode) { wholeSeek(st.frame); syncFoot(); return; }
    if (st.drag && !wholeChecked && !wholeBusy) void enterWhole(st.frame);
    /* 这段该看谁的画面 —— 只由**帧号**决定。原来这里拿的是 curRow()（当前
       选中的段），而 st.cur 是 select() **同步**改的、src 却是异步换的：
       换源那几百毫秒里 curRow() 已经是新段、video 里还装着旧片，于是拿新段
       的坐标系去 seek 旧片 —— 秒数照另一条片子算，画面跳到一个毫不相干的
       位置；正拖和反拖撞上的旧片不是同一条，**同一个位置两个画面**（20261010bg
       修的就是它）。现在一律认 loadedId：video 里装的是谁就按谁的口径换算，
       装的是别的段就先换源，绝不越权 seek。 */
    const here = rowAtFrame(st.frame);
    if (here && loadedId === here.id && st.span) {
      /* 手一搓，机器就不该再捂着画面（见 abortArmAndShow）。 */
      switchWant = null;             /* 拖回已装段，撤掉旧的跨段目标 */
      cancelArm();                    /* 最新手动目标不能被旧 ARM 起点覆盖 */
      if (el.video.readyState >= 2 && !el.video.seeking && !seekPaintCancel) {
        el.video.classList.add("bzf-ok");
        el.img.classList.remove("bzf-ok");
        hideFreeze();
      }
      /* 只记录目标、由 seeked 链消化（见上方 seek 排队）——不再每次硬赋值 */
      requestVideoSeek(Math.max(0, (st.frame - loadedT0(here)) / fps));
    } else if (here && here.id !== loadedId) {
      /* 播放头已经在别的段上：先停残留播放，别让它把播放头拽回去。 */
      if (!el.video.paused) el.video.pause();
      if (st.drag) {
        /* 整片缓存未命中时，不等生成、不转码；串行装已有段视频继续预览。 */
        userPick = here.id;
        if (here.playable) requestSwitch(here.id);
        else switchWant = null;
        syncFoot();
        return;
      }
      /* 非拖动（程序定位 / 点段跳转）：段口径换源 */
      if (here.playable) requestSwitch(here.id);
    }
    syncFoot();
  }

  /* ==================== P2：播放头磁吸 ==================== */
  /* 段边界帧（每段首、尾）—— 播放头磁吸点。 */
  function boundaryFrames() {
    const out = [];
    const clips = (st.film && st.film.clips) || [];
    for (const c of clips) { out.push(int(c.clip_from)); out.push(int(c.clip_to)); }
    return out;
  }
  const SNAP_DIST_FRAMES = 6;   /* 距段边界 ≤6 帧（0.25s）即磁吸 */
  let snapKeyHeld = false;      /* 按住 S 临时关磁吸 */
  /* 全片比例按"靠近段边界就吸住"处理，返回（可能吸附后的）frac，并亮/灭青色提示线。
     复用 el.snap（拖段块也用它）：搓播放头与拖段块从不同时发生（grip 的 pointerdown
     直接 return），所以不会互相抢。 */
  function applySnap(frac, e) {
    const suppress = snapKeyHeld || (e && (e.ctrlKey || e.metaKey));
    const f = Math.round(frac * totalFrames());
    let best = null, bd = SNAP_DIST_FRAMES + 1;
    if (!suppress) {
      for (const b of boundaryFrames()) {
        const d = Math.abs(f - b);
        if (d < bd) { bd = d; best = b; }
      }
    }
    if (best != null && bd <= SNAP_DIST_FRAMES) { showPlaySnap(best); return fracOfFrame(best); }
    hidePlaySnap();
    return frac;
  }
  function showPlaySnap(frame) {
    if (!el.snap) return;
    el.snap.style.display = "";
    el.snap.style.left = `${xOfFrame(clamp(frame, 0, totalFrames()))}px`;
  }
  function hidePlaySnap() { if (el.snap) el.snap.style.display = "none"; }

  /* ==================== P2：统一落地 + 键盘 ==================== */
  /* 落到指定全片帧：seekFrac 处理画面/换源，再按"画面/界面"三档收口（与原 pointerup
     同一套判定，抽出让键盘逐帧、点击跳转都走这条，不复制）。 */
  function settleAtFrame(fr, forcePick = false) {
    const f = clamp(Math.round(fr), 0, totalFrames() - 1);
    seekFrac(fracOfFrame(f));
    if (wholeMode) {
      /* 整片预览下松手：**不换源、不重载、不闪** —— 画面继续由那条连续片
         提供（真要编辑该段时，select 会退出本模式）。

         但「不换源」和「不通知」是两件事，以前被这一条 return 捆成了一件：
         整片预览一旦进来（点播放连播 / 跨段拖动升级），点段块、拖播放头松手
         全部走不到 onPick —— 时间轴自己的 st.cur 改了、紫环也动了，导演台
         面板 / 文案台 / 媒体架却一个都没收到通知，从此停在开始连播那一段。
         用户的话是「预览完所有视频之后就切不动了，点哪一段都是同一个」：
         画面确实在动（整片是一条片子，wholeSeek 照常 seek），所以看着像切了，
         而编辑目标其实一直没动过。

         所以这里照旧**不 select**（不重载、不退出整片），只把「当前段」这一件
         事广播出去。口径与非整片那条路一致：forcePick（用户亲手点段块）时，
         即便 st.cur 已经是这一段也要广播 —— 否则"点当前段"被当成"没变"吞掉，
         而宿主那三个节点恰好就停在旧段上，正是要修的那个现象。 */
      const wrow = rowAtFrame(st.frame);
      if (wrow) {
        userPick = wrow.id;
        if (forcePick || st.cur !== wrow.id) {
          if (st.cur !== wrow.id) { st.cur = wrow.id; renderSegs(); }
          /* 与 select(viaUser) 同一条规则：用户亲手改选了段，连播到此为止。
             不置这一位的话，广播引发的重载把整片踢回单段之后，playAll 还挂着
             true，这一段播完又会自作主张接下一段 —— 点了一段却播起全片来。 */
          haltPlayback();
          el.meta.textContent = `${(st.film && st.film.name) || "未命名"} · 第 ${wrow.index} 段 / 共 ${(st.film.clips || []).length} 段`;
          el.meta.className = "bzf-meta";
          if (opts.onPick) opts.onPick(wrow, true);
          void loadWaveFor(wrow, st.seq);
        }
      }
      syncFoot();
      return;
    }
    const row = rowAtFrame(st.frame);
    if (!row) return;
    userPick = row.id;
    /* forcePick = 用户主动点段块（不是搓播放头/键盘）。此时即便时间轴本地
       st.cur 已经是这一段，也必须广播 onPick —— 否则时间轴本地选中状态与
       导演台面板/文案台/媒体架脱节时，点段块会被当成「点当前段」跳过广播，
       另外两个节点永远停在旧段（20261012 联动失效根因）。 */
    if (row.id === loadedId || row.id === loadingId) {
      /* 预览已装好/正在装最终段：只提交选中状态，不再换相同 src。 */
      if (forcePick || st.cur !== row.id) {
        st.cur = row.id;
        el.meta.textContent = `${(st.film && st.film.name) || "未命名"} · 第 ${row.index} 段 / 共 ${(st.film.clips || []).length} 段`;
        el.meta.className = "bzf-meta";
        renderSegs();
        if (opts.onPick) opts.onPick(row, true);
        scheduleStrip();
        void loadWaveFor(row, st.seq);
      }
      if (row.id === loadedId) { cancelArm(); settleLoadedSeek(); }
      syncFoot();
    } else if (row.id === st.cur) {
      if (row.playable && loadingId !== row.id) select(row.id, forcePick);
    } else {
      select(row.id, true);
    }
  }
  /* 播整片 / 暂停（抽自监视器点击手势，供空格键调用）。 */
  async function playFromHere() {
    /* 点播放：先立即播当前段、整片就绪无感升级（见 startPlayback）。 */
    await startPlayback();
  }
  function pausePlay() {
    haltPlayback();
    resetBuffer();
    /* 整片预览里真正在播的是 videoA（el.video 是那条已退居幕后的分段源）——
       只 pause el.video，整片照跑不误：空格按下去没反应就是这么来的。
       与 el.view 的点击暂停保持同一口径。 */
    if (wholeMode) { try { el.videoA.pause(); } catch { /* 忽略 */ } }
    else el.video.pause();
  }
  /* 键盘：←/→ 逐帧、Shift+←/→ 十帧、Home/End 首尾、空格播放暂停。焦点在文本输入
     类控件时不拦截（正常打字）；只在 band 被点过、获得焦点后生效，不全局抢快捷键。 */
  function onFilmKey(e) {
    const t = e.target;
    if (t && t.closest && t.closest("input,textarea,select,[contenteditable='true']")) return;
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); settleAtFrame(st.frame - (e.shiftKey ? 10 : 1)); break;
      case "ArrowRight": e.preventDefault(); settleAtFrame(st.frame + (e.shiftKey ? 10 : 1)); break;
      case "Home": e.preventDefault(); settleAtFrame(0); break;
      case "End": e.preventDefault(); settleAtFrame(totalFrames() - 1); break;
      case " ": case "Spacebar":
        e.preventDefault();
        /* 问"当前这个播放器在不在播"必须问对人：整片预览下在岗的是 videoA，
           问 el.video 会得到恒 paused（它已经退到幕后），于是空格永远走
           playFromHere、永远停不下来。 */
        if ((wholeMode ? el.videoA : el.video).paused) playFromHere(); else pausePlay();
        break;
      default: return;
    }
  }
  el.band.tabIndex = -1;            /* 可被 JS focus、收 keydown，但不进 Tab 序 */
  el.band.addEventListener("keydown", onFilmKey);
  /* S 键临时关磁吸：pointermove 读不到普通按键状态，这里记一下（不拦截、不影响别的）。 */
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && t.closest && t.closest("input,textarea,select,[contenteditable='true']");
    if (!typing && (e.key === "s" || e.key === "S")) snapKeyHeld = true;
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "s" || e.key === "S") snapKeyHeld = false;
  });
  window.addEventListener("blur", () => { snapKeyHeld = false; });   /* 失焦复位，防卡死 */

  /* ---------------------------------------------------------- 生命周期 */

  /* 容器尺寸 / 窗口缩放 / 合帧重画已由 tEngine 统一接管（唯一 ResizeObserver +
     唯一 window resize + 一个 rAF render 总线）：滚动容器 clientWidth 变（拖节点
     边框 / 拖浮动窗 / 窗口缩放）才重 fit、高度变只重画，并锚定重排前左缘帧不跳。
     拖段/接缝只改内部 track 的 scrollWidth、不改 clientWidth，不会误触发 refit。
     这里不再重复挂 observer，避免双重 resize → 双重重排（这是过去"改了又坏"的
     视图层根因之一）。 */
  /* 回前台补一笔（20261010）：隐藏期间缩略图与重画整段跳过了，回来这会儿
     把落下的补上 —— drawWave 有签名闸门，状态没变就是零成本。 */
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && st.mode !== "collapsed") {
        scheduleStrip();
        drawWave();
      }
    });
  }

  /* 刷新并发闸门。导演台有七八处会喊 refresh（登记段、改名、切版本、载入时
     的两个延时兜底…），原来每次都从头跑：拉一次档案 + 选段 + 读视频信息 +
     读波形 + 铺缩略图。几个调用点撞在一起就是一串串行的网络来回，面板在这
     段时间里是死的。现在：正在跑就记个「再跑一次」，跑完接着跑那一次 ——
     既不漏掉最后一次的真实状态，也不让中间那些重复的请求排队。 */
  let refreshing = false;
  let refreshAgain = false;
  let refreshHow = "";
  async function refresh(how = "") {
    if (st.mode === "collapsed") return;
    if (refreshing) { refreshAgain = true; refreshHow = how || refreshHow; return; }
    refreshing = true;
    try {
      await refreshInner(how);
    } finally {
      refreshing = false;
      if (refreshAgain) { const h = refreshHow; refreshAgain = false; refreshHow = ""; refresh(h); }
    }
  }

  /* how="store"：来自 bz_store 的后台变更推送。此时用户可能正在看/拖某一段，
     只许更新段块账（帧数/顺序/可播态/波形），**不许换视频源、不许 ffmpeg 抽
     垫图**——旧版每次后台刷新都 select→showPoster（70~1100ms），是卡顿主因。 */
  async function refreshInner(how = "") {
    const silent = how === "store";
    try {
      ensureSub();
      const film = await pickFilm();
      if (!film) {
        clearView();
        /* 轴上真的什么都没有了 —— 指针跟着收（clearView 已不管指针，见上） */
        el.play.style.display = "none";
        el.meta.textContent = "还没登记过片子 —— 在导演台「工程」面板填个工程名";
        el.meta.className = "bzf-meta bzf-err";
        el.cap.textContent = "没有可预览的成片";
        el.where.textContent = "—";
        el.stat.textContent = "";
        el.segs.innerHTML = "";
        dropSegLayers();
        refreshCenter();
        return;
      }
      /* 片名有了、但一段都还没有：不是"读不了"，是"还没开始"。给一句明确引导
         而不是留着个 "—"，否则刚拖出来的节点看着像坏了。 */
      if (!film.clips || !film.clips.length) {
        clearView();
        el.play.style.display = "none";
        el.meta.textContent = film.name ? `${film.name} · 还没有分段` : "还没有分段";
        el.meta.className = "bzf-meta";
        el.cap.textContent = "点画面中央的「＋ 接第一段」开始";
        el.where.textContent = "—";
        el.stat.textContent = "";
        el.segs.innerHTML = "";
        dropSegLayers();
        refreshCenter();
        return;
      }
      /* 档案又读了一遍（多了一段 / 哪段重抽过）→ "已经预热过哪一段"作废
         （20261010bj）：段 id 没变不代表文件没变，接着跳过预热就要拿上一版的
         文件去接段 —— 接缝处播的是旧画面。 */
      /* 总片长变了 → 自动重新适配（20261013 用户定）：整条片重新刚好铺满
         可视宽，最右段不再超出框外。拖动进行中不算（不跟手抢戏、不抖）；
         总长没变的普通刷新也不算（保留当前比例）。 */
      if (!resizing && totalFrames() >= 2 && totalFrames() !== tEngine.getLastFitTotal()) {
        fitTimeline();
      }
      prewarmed = "";
      const has = (id) => !!id && film.clips.some((c) => c.id === id);
      /* 用户挑过、且那一段还在 → 认用户的；否则默认加载**最后一个有成片的
         段** —— 它的成片覆盖最多（续接链下往往就是"到这段为止的整条片子"），
         监视器作为整条时间轴的预览器，默认就该拿覆盖最全的那条；
         一段都没渲染过才退回最后一段。少"认用户的"这条，刷新会把选中挪走。 */
      const lastPlayableId = (() => {
        const rows = film.clips || [];
        for (let k = rows.length - 1; k >= 0; k--) {
          if (rows[k].playable) return rows[k].id;
        }
        return null;
      })();
      /* 认段优先级（20261010 修）：用户挑过的 > **当前正在看的** > 最后一个
         有成片的。原来中间这档没有 —— 用户没点过段（只搓过播放头 / 连播自动
         往下走）时，任何一次刷新都会按"最后一个有成片的段"重新挑，把正在看
         的画面顶掉。刷新是"同步别人的改动"，不该替用户换镜头。 */
      const target = has(userPick) ? userPick
        : (has(st.cur) ? st.cur
          : (lastPlayableId || film.head || film.clips[film.clips.length - 1].id));
      if (!has(userPick)) userPick = null;
      /* 静默档（后台推送）：本来只按「消息来自 store」就一律不换源、不抽垫图。
         但那条件太宽：收片把当前段的成片从 t22 覆盖成 t23 也是"后台推送"，
         段块账更新了、画面却还停在旧 take —— 用户只能靠刷新网页才看到新片
         （20261023）。换源的真正前提是「正在看的这条成片变了」，所以这里
         比成片身份（段 id + 成片路径），不是比消息来源：别的段重抽、改名、
         拖段长、波形补拉一律照旧静默，不白抽垫图。 */
      const curRow = has(st.cur) ? rowById(st.cur) : null;
      const filmUnchanged = !!curRow && loadedId === st.cur
        && filmKeyOf(curRow) === loadedFilmKey;
      /* wholeMode 例外：select() 会 exitWhole() 把用户从「整片」视图里踢回
         单段 —— 用户自己在看总览，后台收个片不该改变他的查看模式。
         整片播的是导演台整片口的输出，本来也不吃分段成片。 */
      if (silent && (wholeMode || filmUnchanged)) {
        renderSegs();
      } else {
        await select(target);
      }
      void loadAllWaves();   /* 每段自己的音频频谱：memo 命中零请求，只拉新段 */
      syncFoot();
      refreshCenter();
    } catch (err) {
      el.meta.textContent = `读不了段落档案：${err.message}`;
      el.meta.className = "bzf-meta bzf-err";
    }
  }

  /* ---- 滚轮（横滚 / Ctrl+滚轮缩放，像素/帧模型配套） ----
     原先这里还挂着一颗「适配」按钮，已撤：建尺 / 换工程 / 缩放后引擎自己会
     重算每帧像素，手动再点一次和自动结果一致，纯属多一颗按钮。 */
  /* 鼠标滚轮悬停在时间轴上：
     · 普通滚轮：垂直滚轮转成横向滚动，方便左右查看（不按 Shift）；
       Shift+滚轮 或 横向滚轮按原始方向。
     · Ctrl/Cmd + 滚轮：以鼠标下那一帧为锚点放大/缩小（专业剪辑软件惯例），
       缩放是引擎唯一参数，所有层在下一帧一次重画，丝滑不抖。 */
  el.band.addEventListener("wheel", (e) => {
    if (e.target.closest && e.target.closest(".bzf-grip")) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-(Number(e.deltaY) || 0) * 0.0015);
      tEngine.zoomAt(factor, e.clientX);
      return;
    }
    const hasH = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const d = hasH ? e.deltaX : e.deltaY;
    /* fit 态 maxScrollX()=0，滚轮不该把视图推走、在右侧留下空白带
       （20261108 根修，与引擎 fitMode 归零同一口径）。 */
    const max = maxScrollX();
    if (max <= 1) return;
    e.preventDefault();
    el.band.scrollLeft = Math.max(0,
      Math.min(max, el.band.scrollLeft + d));
  }, { passive: false });

  ensureSub();
  requestAnimationFrame(() => refresh());

  /* ==================== 裁切剃刀工具（20261109 改为纯音频切块） ==========
     ✂ 永远只切「选中音轨」的音频块，不再做段级分割。落点传全片连播帧，
     由音频轴切块、后端按片段合成驱动。覆盖层只盖段块行，不挡上方标尺搓帧、
     下方波形与任何按钮；关闭后 pointer-events:none，拖排序 / 搓帧 / 点选零影响。 */
  let cutMode = false;
  let cutHit = null;     // 当前竖线落点：{ clipId,index,a,N,ok,globalFrame }

  function syncCutlayerGeom() {
    if (!el.cutlayer || !el.segs) return;
    el.cutlayer.style.top = `${el.segs.offsetTop}px`;
    el.cutlayer.style.height = `${el.segs.offsetHeight || 72}px`;
  }

  /* 鼠标事件 → 「全片连播坐标的第几帧」。音频轴与后端切片用的都是这套
     坐标（film_summary 的 clip_from / clip_to）。段自身帧切点 a / 17k+5
     吸附 / 前后各留 5 帧 是段级分割的约束，✂ 现在只切音频块，整套下架。 */
  function cutHitAtEvent(e) {
    if (!st.film || !tEngine.isFitted()) return null;
    /* 取整到整帧：竖线位置与真正落库的切点必须是同一个数，否则看着切在
       这里、后端却切在隔壁一帧。 */
    const f = Math.round(tEngine.frameAtX(pxInSegs(e)));
    const r = segSpans().find((x) => f >= x.from && f < x.to);
    if (!r) return null;
    return { clipId: r.clip.id, index: r.clip.index,
             globalFrame: f, from: r.from, to: r.to };
  }

  function paintCutline(hit) {
    const line = el.cutline;
    if (!line) return;
    if (!cutMode || !hit) { line.classList.remove("on"); return; }
    line.classList.add("on");
    const ok = !!(audioLaneApi && audioLaneApi.canCutAt && audioLaneApi.canCutAt(hit));
    line.classList.toggle("bad", !ok);
    line.style.left = `${xOfFrame(hit.globalFrame)}px`;
    const fps = Number(st.film && st.film.fps) || 24;
    el.cuttip.textContent = ok
      ? `第 ${hit.index} 段 · ${(hit.globalFrame / fps).toFixed(2)} 秒处切开选中音轨`
      : "这里不能切 —— 先点音轨行选中，或换到音频块内部";
  }

  function onCutMove(e) {
    if (!cutMode) return;
    cutHit = cutHitAtEvent(e);
    paintCutline(cutHit);
  }
  function onCutLeave() { cutHit = null; paintCutline(null); }
  function onCutClick(e) {
    if (!cutMode) return;
    const hit = cutHitAtEvent(e);
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    if (typeof opts.onAudioCutAt === "function") {
      try { opts.onAudioCutAt(hit); }
      catch (err) { console.warn("[film] 音频裁切失败：", err); }
    }
    /* 切完旧落点已失效，先藏起竖线，等下一次移动。 */
    cutHit = null; paintCutline(null);
  }
  if (el.cutlayer) {
    el.cutlayer.addEventListener("pointermove", onCutMove);
    el.cutlayer.addEventListener("pointerleave", onCutLeave);
    el.cutlayer.addEventListener("click", onCutClick);
  }

  /* 开关裁切模式。宿主按钮 / Esc / 渲染开始都应调它。 */
  function setCutMode(on) {
    cutMode = !!on;
    if (el.band) el.band.classList.toggle("bzf-cutting", cutMode);
    if (!cutMode) { cutHit = null; paintCutline(null); }
    else { syncCutlayerGeom(); }
  }

  /* 宿主往监视器工具栏注入按钮用的插槽。共享组件不预设具体有哪些操作；
    20261106 起导演台的段级按钮在「当前段上下文条」上，不再走这个插槽，
    但接口保留给其他宿主。 */
  function addTool(btn) {
    el.tools.appendChild(btn);
    return btn;
  }

  return {
    root,
    refresh,
    /* 只重画标尺菱形 / 重叠标记（paintSeams+paintOverlaps），不拉档案、不换视频源、
       不重建段块与缩略图。接缝胶囊改帧数 / 断链后只需要它 —— 旧版一律走全量
       refresh（pickFilm 网络往返 + 段块重建 + 缩略图请求风暴），点一下 chips 卡
       几百毫秒到数秒（20261012 胶囊卡顿根治）。菱形数据实时读 opts 回调
       （contFramesOf / getTransition），本地 state 已改、局部重画即准。 */
    repaintSeams: () => { try { repaintSeams(); } catch (e) { console.warn("[film] repaintSeams:", e); } },
    setMode,
    getMode: () => st.mode,
    select,
    /* 按 clip id 反查档案里这一段的完整行（index/frames/trim_frames/...）。
       宿主拿它做「孤儿段认领」—— 块在轴上却不在工程里时，认领需要档案的
       元数据，宿主自己没有这份数据。 */
    clipRowOf: (id) => clipById(id) || null,
    /* 轴上此刻画了几段（档案口径）。轴头「全片总览 · N 段」必须读它 ——
       以前读的是宿主工程的 shots.length，那是**另一个数据源**（存在工作流
       节点属性里，档案在磁盘上）。删段只清了档案、或两段抢同一个 clip id
       时，两个源就分叉：轴上 3 块、轴头写 4 段，"删了跟没删一样"。
       轴头说的是这条轴，就该数这条轴画出来的块。 */
    /* -1 = 档案还没读回来（此时别让宿主拿它当"0 段"，会把刚载入的片子
       说成"还没有分段"）；0 = 读回来了、确实一段都没有。 */
    clipCount: () => (st.film ? ((st.film.clips || []).length) : -1),
    /* 整包切工程：音轨数据直接转给音频轴，与 racks / desk 走同一条线路。 */
    hydrateAudioTracks: (data) => {
      if (audioLaneApi && audioLaneApi.hydrateTracks) {
        return audioLaneApi.hydrateTracks(data);
      }
      return 0;
    },
    /* 哪些段被「跳过」了（不参与渲染）。这是**工程侧**状态（p.shots[].off），
       film_summary 里没有 —— 由宿主推过来，本组件只负责画。
       传 null/undefined = 未知（清掉标记）；传数组或 Set = 精确集合。
       集合没变就直接返回：宿主每次重绘都会调它，别让它变成一次性扰动。 */
    setSkipIds: (ids) => {
      let next = null;
      if (ids) { const a = Array.from(ids); if (a.length) next = new Set(a.map(String)); }
      const prev = st.skipIds;
      const same = (!next && !prev)
        || (next && prev && next.size === prev.size && Array.from(next).every((x) => prev.has(x)));
      if (same) return;
      st.skipIds = next;
      try { renderSegs(); } catch (e) { console.warn("[film] setSkipIds:", e); }
    },
    /* 重新问一次"现在能不能拖排序"，并把结果落到光标上。宿主在渲染开始 / 结束
       时喊一声 —— 那两件事不改段的布局，走不到 renderSegs，光标会一直停在
       上一次的答案上（渲染中该是箭头，却还是手型）。 */
    syncSortable: () => { el.segs.classList.toggle("bzf-sortable", sortable()); },
    /* 裁切剃刀模式开关（工具栏「✂ 裁切」/ Esc / 渲染开始调用）。 */
    setCutMode,
    isCutMode: () => cutMode,
    /* 音频轴能力转给宿主：✂ 按钮置灰、切块落库都经这两个口。 */
    hasAudioTrack: () => !!(audioLaneApi && audioLaneApi.selectedTrack
      && audioLaneApi.selectedTrack()),
    cutAudioAt: (hit) => (audioLaneApi && audioLaneApi.cutAt)
      ? audioLaneApi.cutAt(hit)
      : { ok: false, 提示: "音频轴还没就绪" },
    /* 方案 B：设置面板「时长」在有主音轨时改驱动切段。三个口转给音频轴：
       判语义 / 读每段秒数 / 设秒数并重切全片。 */
    hasMainAudio: () => !!(audioLaneApi && audioLaneApi.hasMainAudio && audioLaneApi.hasMainAudio()),
    getSegSec: () => (audioLaneApi && audioLaneApi.getSegSec) ? audioLaneApi.getSegSec() : 10,
    setSegSec: (n) => (audioLaneApi && audioLaneApi.setSegSec) ? audioLaneApi.setSegSec(n) : null,
    addTool,
    reset,
    destroy() {
      st.dead = true;
      if (unsubStore) { try { unsubStore(); } catch (_) {} unsubStore = null; }
      cancelScrubRaf();
      resetSeekQueue();
      cancelArm();
      exitWhole();
      /* src="" 只是换了个空源，浏览器的解码缓冲**不一定**放回（preload=metadata
         也挡不住）。真正释放要三步：pause → 摘掉 src → load()。少最后一步，
         切几段之后内存就一路涨上去（PROJECT.md 记过：3 个视频节点 1GB+）。 */
      try { el.video.pause(); el.video.removeAttribute("src"); el.video.load(); } catch { /* 已销毁 */ }
      try { const sb = standbyEl(); sb.pause(); sb.removeAttribute("src"); sb.load(); } catch { /* 已销毁 */ }
      try { tEngine.destroy(); } catch (_) { /* 已销毁 */ }
      if (root.classList.contains("bzf-float") && root.parentNode) {
        root.parentNode.removeChild(root);
      }
      if (st.slot && st.slot.parentNode) st.slot.remove();
      root.remove();
    },
  };
}

/* 段落配色（20261010 再改 · 用户定：统一、低调、高级）：
   不再按段哈希 12 色相 —— 彩色段块排在深色时间轴上显得花、也廉价。所有段
   统一**冷石板中性灰**，段与段只靠 1px 分隔线和块内缩略图区分；「现在在哪
   一段」交给选中态的紫环 + 色头/块体的轻微提亮，以及克制的语义小色点
   （待办琥珀 / 接法青 / 断链红斜纹）。
   SEG_COLORS     未选中色头（深石板灰）；SEG_COLORS_HI 选中色头（中性亮灰、
   配深色字）。两数组各项同值 —— segHueIndex 仍按 clip id 取下标，但取到哪
   一个都一样，整条轴因此是一块干净的中性色。 */
const SEG_COLORS = [
  "#36363c", "#36363c", "#36363c", "#36363c", "#36363c", "#36363c",
  "#36363c", "#36363c", "#36363c", "#36363c", "#36363c", "#36363c",
];
const SEG_COLORS_HI = [
  "#5a5a63", "#5a5a63", "#5a5a63", "#5a5a63", "#5a5a63", "#5a5a63",
  "#5a5a63", "#5a5a63", "#5a5a63", "#5a5a63", "#5a5a63", "#5a5a63",
];
/* 三档代价差一个量级，写出来而不是笼统称"待办"：trim 只重拼一次（秒级），
   grow / redo 要重新跑模型（分钟级）。用户据此判断值不值得现在跑。 */
const PEND_TEXT = {
  grow: "要加长（重生成，尾部钉住）",
  trim: "要裁剪（只重拼，不用重采样）",
  // 换过版本（swap takes）：后面各段的累积成片里还夹着旧版本，重拼一次即可，
  // 不用重新采样。代价和「重抽」差一个量级，必须分开说。
  rejoin: "要重拼（换过版本，成片还没跟上）",
  redo: "要重抽",
};
/* 20261108：「特殊接法」四种（往后接 / 往前接 / 补桥 / 循环）连同时间轴上的
   接法符号表 PIN_MARK 整组删除。接缝只剩「自动接续」一种，paintSeams 里
   有承接帧就画 → 加帧数，不再按接法查表。 */
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
