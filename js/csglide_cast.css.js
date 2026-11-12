/* ============================================================
 * 导演台样式
 * ------------------------------------------------------------
 * 从 csglide_cast.js 里整块搬出来：样式是纯文本，跟逻辑没有任何耦合，
 * 却占了原文件一千多行 —— 每次为了改个按钮把 CSS 一起读进来太不划算。
 *
 * ⚠️ 这不是导演台私有的样式表。它以 CAST_CSS 之名导出，下面这些节点
 *    注入的是同一份，并直接复用这里的类名：
 *      · csglide_qwen.js          （Qwen 编辑台）
 *      · csglide_media_rack.js    （H3 媒体架）
 *      · csglide_prompt_editor.js （提示词编辑器：.gcast-ed / .tok /
 *                                   .gcast-ac / .gcast-toktip）
 *    所以**删类之前必须先 grep 全目录**：某条规则在导演台里已经没人用，
 *    不等于它在整套节点里没人用。导演台删掉提示词编辑区时，正是靠这一步
 *    保住了 .gcast-ed / .gcast-chip / .gcast-ac 那一批。
 * ============================================================ */

export const CSS = `
.gcast {
  --h3-bg:#191919; --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b;
  --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-label:#787878;
  --h3-accent:#58d1ff; --h3-accent-dim:#58d1ff26;
  /* 段落档案（长片时间轴）专用色。原先只定义在工程区块作用域内，
     面板其它区块拿不到——提到根，片名条等新区块才能用。 */
  --h3-violet:#a97bff; --h3-violet-dim:#a97bff26;
  --gc-wave:#59c14f;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: var(--h3-txt); font-size: 12px; line-height: 1.35;
  /* 节点 body 的 DOM widget（.dom-widget）被设为 pointer-events:none，让点击能
     落回画布；这里给强调根恢复 auto，使节点内所有子元素默认可点。内部装饰层
     （gcast-wave/gcast-num/gcast-wavlabel 等）仍保留自己的 none 保持穿透。 */
  pointer-events:auto;
  position:relative;
  background: var(--h3-bg); border:1px solid var(--h3-line); border-radius:10px;
  padding:10px; display:flex; flex-direction:column; gap:9px;
  box-sizing:border-box; width:100%; min-width:0; height:calc(100% - 8px);
  /* 底部让出 8px 是给「节点下边缘的 resize 热区」的：litegraph 的拖拽手柄在节点
     内侧边缘约 10px 内，而本面板 pointer-events:auto 铺满整个 body —— 铺到哪就
     吃掉哪，鼠标压在底边上根本进不了画布的重置光标分支，表现就是"节点高度拖不动、
     像被固定住"。wrapper（.dom-widget）是 pointer-events:none，让出来的这 8px 会
     直接穿透到画布，手柄重新可用。 */
  /* 可纵向滚动，但滚动条占位恒定。

     ⚠️ 本文件整段是反引号模板字符串（见文件开头的 export const CSS），
        **注释里绝不能出现反引号** —— 一个反引号就会把字符串提前截断，
        整个模块 SyntaxError：导演台 / 媒体架 / Qwen 编辑台 / 提示词编辑器
        注入的都是这一份 CAST_CSS，会一起全挂（20261029 实测）。

     20261029 曾把这里改成 overflow:hidden，理由是内部缩略图 .gcast-thumb 为
     width:100% + aspect-ratio:1/1（高度由宽度决定），与滚动条凑成自激回路：
       内容超高 → 滚动条出现 → clientWidth 少 17px → 缩略图变矮 → 内容变矮
       → 滚动条消失 → clientWidth 回来 → 缩略图又变高 → 滚动条又出现…
     结果：装不下时底部整片（落地行 / 反馈条）直接被裁、永久够不着 —— 而节点
     高度受存档值、载入时机、宽度换行共同影响，永远无法保证"刚好装下"。

     断回路该断在"clientWidth 随滚动条闪变"这一环，不是砍掉滚动能力：
     scrollbar-gutter:stable 让滚动条空间**常驻**，有没有滚动条 clientWidth
     都一样 → 缩略图不会再变宽变窄 → 回路消失，且溢出的内容随时可滚到。
     thin + 深灰配色只是为了这条常驻占位不刺眼。 */
  overflow-y:auto; overflow-x:hidden;
  scrollbar-gutter:stable;
  scrollbar-width:thin; scrollbar-color:#3f3f3f transparent;
  /* 滚到面板头/尾时不要把滚动链甩给画布（那样会连带缩放/平移整个图）。 */
  overscroll-behavior:contain;
  /* Hard ceiling so a runaway measurement can never stretch the panel to
     infinity: the expanded prompt already scrolls inside the layer, and
     collapsed content is ~1300px, so this cap is only ever a safety net. */
  max-height:6000px;
}
.gcast[data-mode="fl2va"] { --h3-accent:#59c14f; --h3-accent-dim:#59c14f26; }

/* 成片监视器 —— 吸收续接合成的预览窗（上成片 / 下时间轴）。
   固定高度而不是弹性：取景器需要一个稳定的可视区，跟着面板一起弹性伸缩会
   让视频在每次重排时跳动。收起 / 拖出时高度换档——那时它只剩一条标题栏或
   一个占位块，留着 300px 的空盒子毫无意义。 */
/* 不写死 height 而是 min-height：双栏按 align-items:stretch 对齐，右栏（设置卡
   + 首尾帧卡）比 300px 高时监视器跟着一样高，两栏底边齐平。写死 300px 会让
   监视器下方空出一条 30~40px 的白边，而双栏底边不齐在视觉上比"视频高度微变"
   更刺眼。取景器的稳定由 bzf-view 的 min-height 兜住，不会塌。 */
.gcast-monitor { flex: 0 0 auto; min-height: 300px; }
.gcast-monitor.is-collapsed { min-height: 0; }
.gcast-monitor.is-float { min-height: 0; }
.gcast-monitor .bzfilm { height: 100%; }

/* 采样参数：叠在取景器底部右侧的一行小字，绝对定位、不占布局；未采样时隐藏。 */
.gcast-stats { position:absolute; right:10px; bottom:9px; z-index:7;
  padding:3px 8px; border-radius:6px; background:#0000008c;
  color:#e3e3e3; font-family:ui-monospace,Consolas,monospace;
  font-size:11px; line-height:1.35; white-space:nowrap;
  pointer-events:none; display:none; }
.gcast-stats.is-on { display:block; }

/* v7 式双栏：监视器在左占满余宽，设置卡（.gcast-row）在右定宽竖排。
   监视器收起/拖出后高度变了，行内按 align-items:stretch 自然对齐。 */
/* position:relative —— 双栏内的绝对定位小标记仍参照这一层；渲染遮罩
   （.gcast-run）20261013 起改挂 document.body + fixed，按本层视觉矩形
   rAF 贴齐，只盖双栏、不盖总览轴（跑到第几段要盯着轴看）。 */
/* 20261011 align-items 改 flex-start：原 stretch 把监视器拉到与右栏等高，
   视频 contain 后上下各留一大块黑空白。现在两栏顶对齐，监视器高度跟随视频。 */
/* 顶部行：监视器（左）+ 参数卡（右），两栏顶对齐。参数卡内容多（首尾帧卡展开
   等）时整行**自然撑高**、把下方全宽时间轴往下推，全貌直接露出 —— 不做限高
   滚动：限高会把内容藏在卡内、还被下方时间轴挡住。 */
/* flex-wrap 常驻（20261012 双栏溢出根治）：容不下两栏时 CSS 自动上下堆叠，
   不再只靠 JS 按 820 阈值打 .narrow —— v2 前端 DOM widget 是 position:fixed
   容器、宽度由框架每帧同步，JS 测宽偶尔滞后时，旧规则（nowrap + 右栏固定 450）
   会把监视器压成几十像素竖条、整行溢出节点边界。渲染遮罩 20261013 起已改挂
   body + fixed（不再受双栏溢出影响），但双栏自身被压竖条仍要修，故保留。
   监视器 basis 360 = 最小可用宽，右栏可缩到 300；
   并排临界 ≈ 360+450+9+内边距 ≈ 839px，与 JS 的 820 narrow 阈值连续无空档。 */
.gcast-studio { display:flex; flex-wrap:wrap; gap:9px; align-items:flex-start; min-width:0;
  position:relative; }
.gcast-studio .gcast-monitor { flex:1 1 360px; min-width:0; }
.gcast-studio .gcast-col { flex:0 1 450px; min-width:min(100%,300px); }
/* v7 式 lanes 行：分段轨 + 波形 + 播放头的全宽时间轴（监视器组件把
   .bzf-band/.bzf-foot 外挂到这里）。独立于双栏，始终横贯节点宽度。
   段多的时候它是面板上唯一能一眼看完整个片子的地方，所以它独占一整行，
   不与监视器/设置争宽度。 */
.gcast-lanes { flex:none; min-width:0; display:flex; flex-direction:column; gap:5px;
  padding:7px 8px; background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:8px; }
.gcast-lanes-hd { display:flex; align-items:center; gap:8px; flex:none; min-width:0;
  flex-wrap:wrap; row-gap:4px;
  font-size:11px; color:var(--h3-dim); white-space:nowrap; overflow:hidden; }
.gcast-lanes-hd .t { color:var(--h3-txt); font-weight:500; flex:none; }
.gcast-lanes-hd .mono { font-family:ui-monospace,Consolas,monospace; font-size:10.5px; }
.gcast-lanes-hd .tools { display:flex; gap:4px; flex:0 0 auto; margin-left:auto; }
/* 触控目标：原来 17×15px 在窄屏上几乎点不准，抬到 24×22（HIG 建议的最小可点
   区域）。缩放/适配这三个按钮此前随工程条一起撤下，入口没了 —— 挂回这条轴上。 */
.gcast-lanes-hd .tools button { all:unset; pointer-events:auto; cursor:pointer;
  width:24px; height:22px; padding:0; display:grid; place-items:center;
  border:1px solid var(--h3-line); border-radius:5px; background:var(--h3-raise);
  color:var(--h3-dim); box-sizing:border-box; }
.gcast-lanes-hd .tools button:hover:not(:disabled) { color:var(--h3-txt);
  border-color:var(--h3-accent); }
.gcast-lanes-hd .tools button:disabled { opacity:.35; cursor:default; }
.gcast-lanes-hd .tools button.danger:hover:not(:disabled) { color:#ff8a8a;
  border-color:#ff8a8a; }
.gcast-lanes-hd .tools svg { width:11px; height:11px; fill:none; stroke:currentColor;
  stroke-width:1.5; stroke-linecap:round; }
/* 带文字的（裁切 / 全部渲染 / 导出 / 工程 ▾）按内容撑宽，图标的保持 24×22 方形。
   tools 里那条 all:unset 会把 gcast-btn 自带的尺寸一并清掉，不补回来就会把
   「✂ 裁切」这类按钮压成一个 24px 宽的方块。
   （20261106 轴头「＋ 接一段」已撤，这条规则不再作用于它。） */
.gcast-lanes-hd .tools button.gcast-btn { width:auto; height:22px; padding:0 9px;
  font-size:10.5px; }
/* 组间细分隔：不留一条缝，四组按钮会看成一排。 */
.gcast-lanes-hd .tools .tsep { flex:none; width:1px; height:15px; background:var(--h3-line);
  margin:0 3px; align-self:center; }
.gcast-lanes-hd .tools button.gcast-btn { position:relative; }
/* 时间轴阶段互斥（20261111 阶段 2）：两颗必有一亮。
   启用态与全站「选中」控件同一套语言：淡 accent 底 + 同色描边 + 同色字
   （.gcast-chip.on / .gcast-seam-chip.is-on / .gcast-play.on 都是这个范式）。
   旧版给实心高饱和亮蓝 + 白字，22px 高的轴头里那块色太跳、和旁边「✂ 裁切」
   「🎞 用三采成品」完全不是一套质感。用 var() 还有个好处：--h3-accent 随
   data-mode 自动切（fl2va 模式变绿），不用为两种模式各写一份。 */
.gcast-lanes-hd .tools button.gcast-stage-btn { min-width:54px; }
.gcast-lanes-hd .tools button.gcast-stage-btn.active {
  border-color:var(--h3-accent); color:var(--h3-accent);
  background:var(--h3-accent-dim); font-weight:600; }
.gcast-lanes-hd .tools button.gcast-stage-btn:disabled { opacity:.55; cursor:wait; }
/* 阶段分段控件（20261112 用户定：一采/二采 + 成片变体并成一个控件）。
   连通外壳：共享描边 + 圆角 + 浅底（--h3-well 轨道），内部三颗去独立圆角、
   用左分隔线相连，读作「一个分段控件」而非三颗散钮。启用态仍走上面
   .gcast-stage-btn.active 的全站选中语言（淡 accent 底 + 同色字）；分隔线由
   相邻兄弟规则钉成中性 --h3-line，特异性压过 active 的 border-color，不随选中染色。
   变体钮 display 由 paintStage 按阶段控制（只在二采出现）：隐藏时它仍是兄弟节点，
   但 s2 的分隔线来自 s1+s2，一采末尾不会留一条悬空竖线。 */
.gcast-lanes-hd .tools .gcast-stage-seg {
  display:inline-flex; align-items:center; flex:none;
  border:1px solid var(--h3-line); border-radius:7px; overflow:hidden;
  background:var(--h3-well); }
.gcast-lanes-hd .tools .gcast-stage-seg button.gcast-stage-btn {
  border:none; border-radius:0; min-width:54px; }
.gcast-lanes-hd .tools .gcast-stage-seg button.gcast-stage-btn + button.gcast-stage-btn {
  border-left:1px solid var(--h3-line); }
.gcast-lanes-hd .tools button.gcast-export-btn {
  display:inline-flex; align-items:center; gap:5px; }
/* （导出按钮"未就绪"小黄点徽标样式已于 20261012 应要求移除。） */
/* （手势提示样式已删，20261010：那行说明框整个撤了。） */

/* 运行时反馈条：lanesFlash 的非阻塞提示落点，住在**面板最底部独占一行**
   （20261015 用户定）。来路：原先挤在轴头那一行里，横向只剩很窄一格、被收成
   省略号；中间试过轴头正下方，最后定在最底下，把落地行那句「文案来自文案台 ·
   第 N 段」顶掉 —— 那句只是复述一条已经接好的线。
   吃满整行宽度、过长自动折行 —— 不必再靠悬停看全文。平时不占位。 */
.gcast-flash { display:none; width:100%; min-width:0; font-size:10.5px;
  color:#e0a34a; line-height:1.45; white-space:normal; overflow-wrap:anywhere; }
.gcast-flash.on { display:block; }

/* 悬停段块浮出的迷你工具条（方案 D）：✕删除 / ⛓断开⇄接上 / ⧉复制 / ＋末尾加段。
   挂在 body 上（不在节点内），拿不到节点的局部 CSS 变量 —— 颜色写兜底值。 */
.gcast-segtools { position:fixed; z-index:10000; display:none; gap:2px;
  padding:2px; background:#212121; border:1px solid #3b3b3b; border-radius:6px;
  box-shadow:0 4px 14px #0009; }
.gcast-segtools button { all:unset; cursor:pointer; width:20px; height:18px;
  display:grid; place-items:center; border-radius:4px; font-size:11px;
  color:#979797; }
.gcast-segtools button:hover:not(:disabled) { background:#ffffff14; color:#e3e3e3; }
.gcast-segtools button.del:hover { color:#ff8a8a; }
.gcast-segtools button.add:hover { color:#7fd8a0; }
.gcast-segtools button:disabled { opacity:.35; cursor:default; }
.gcast-segtools button.unlinked { text-decoration:line-through; }

/* 接缝插入点：悬停两段交界时浮在交界正上方的「＋」，点一下在那里插一段。 */
.gcast-seamadd { position:fixed; z-index:10000; all:unset; cursor:pointer;
  width:20px; height:16px; display:grid; place-items:center; font-size:11px;
  color:#7fd8a0; background:#212121; border:1px solid #3b3b3b; border-radius:4px;
  box-shadow:0 4px 14px #0009; }
.gcast-seamadd:hover { color:#e3e3e3; border-color:#7fd8a0; }

/* ---- 渲染范围 ↔ 时间轴联动 ----
   "这次点下去会跑哪几段"不该等到跑起来看日志才知道。范围选择器一变，落在
   范围内的段顶上就亮出一条主色细条，范围外的没有 —— 眼睛停在轴上就能确认
   "我要跑的是不是这几段"。
   用顶部细条而不是改段块底色：底色已经被"有没有成片 / 待办 / 外部导入"占
   了语义，再拿它表示"会不会被渲染"两种信息就打架了。 */
.gcast .bzf-lanes .bzf-seg.inrun::before {
  content:""; position:absolute; left:0; right:0; top:0; height:3px; z-index:2;
  background:var(--h3-accent); box-shadow:0 0 5px var(--h3-accent-dim);
}
/* 断口：这一段与上一段**没有接上**（独立起头，不承接上一段的尾巴）。
   琥珀在本面板里只表示"有事没做"这一件事，这里借用它表示"这一段是断开的"
   —— 它是用户**主动**选择的、且后果明确（两段之间不连贯），属于同一类语义。
   不用新色：断链不是错误，不需要红色，但它必须一眼可见，否则用户只有在渲染
   完、看着两段接不上时才会回头找。 */
/* 原来只画 2px 虚线边，压在深色段块上跟段与段之间那条黑线混成一片 ——
   "这一段接没接上"是这条轴最该一眼看清的事，不能只有一条若有若无的边。
   现在：左侧一整条 3px 琥珀虚线竖到底，色头再压一层琥珀底。
   刻意不用 box-shadow 做这件事：那条 inset 环是"选中 / 锁定"专用的，规范紫与
   琥珀抢同一个属性，结果只会是两者只能显示一个。琥珀虚线 + 色头染色是另一个
   通道，与选中态并存、互不覆盖。 */
.gcast .bzf-lanes .bzf-seg.unlinked {
  border-left: 3px dashed #ff9f43;
}
.gcast .bzf-lanes .bzf-seg.unlinked .bzf-seg-hd {
  background-image: linear-gradient(90deg, rgba(255,159,67,.55), rgba(255,159,67,0) 60%);
}
/* 轴工具栏上那个「接上一段」开关：断开态用琥珀，接上态保持默认强调色。 */
.gcast-lanes-hd .tools button.unlinked {
  color:#ff9f43; border-color:rgba(255,159,67,.5); background:rgba(255,159,67,.12);
}
/* 正在跑的那一段：亮度脉冲。进度数字在轴头的计数里，段块上只给"就是它在跑"。 */
.gcast .bzf-lanes .bzf-seg.running { animation:gcast-runpulse 1.15s ease-in-out infinite; }
@keyframes gcast-runpulse {
  0%, 100% { filter:brightness(1); }
  50%      { filter:brightness(1.55); }
}
@media (prefers-reduced-motion: reduce) {
  .gcast .bzf-lanes .bzf-seg.running { animation:none; }
  .gcast .bzf-lanes .bzf-seg.running { box-shadow:inset 0 0 0 2px var(--h3-accent); }
}
/* 段落轨加高（合并轨）：色头 18 + 视频体 ≈72。只在外挂宿主里加高，
   续接合成那边的内嵌时间轴不受影响。 */
.gcast .bzf-lanes .bzf-segs { height:72px; }
.gcast .bzf-lanes .bzf-band { flex:none; }
.gcast .bzf-lanes .bzf-foot { padding:0 2px; }

/* ---- 指挥条（方案 A）----
   面板原先纵向堆七段（顶栏 / 双栏 / 轴 / 渲染 / 模式 / 首尾帧 / 文案来源），
   滚到哪儿全靠认控件形状。指挥条把最常被问的三件事——我是哪部片、我在哪一
   段、我按什么模式生成——收到第一行，其余各归各卡片。 */
/* 允许换行：节点可以被用户拖到 560px 宽，那时片名 + 段头 + 时长 + 开关 + 五个
   文件按钮一行放不下。换行比横向溢出更好——溢出时 .gcast 的 overflow-x:hidden
   会把右侧的「工程 ▾」直接裁掉，用户连工程文件都打不开。 */
.gcast-cmd { display:flex; align-items:center; gap:8px; flex:none; min-width:0;
  flex-wrap:wrap; row-gap:5px;
  padding:6px 8px; background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:8px; }
/* 工程名 = 片名 = 磁盘上档案目录的名字。它是这条片的身份，所以做成**可以直接
   点进去改**的一格 —— 原来这里显示的是"预设文件名"，工程名压根没有输入口，
   新用户找不到在哪儿给片子起名。虚线边是"可编辑"的提示，聚焦才变实线。 */
.gcast-cmd .c-proj {
  flex:0 1 auto; min-width:72px; max-width:190px;
  font-size:12px; font-weight:600; padding:2px 7px; border-radius:5px;
  border:1px dashed transparent; cursor:text; box-sizing:border-box;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.gcast-cmd .c-proj:hover { border-color:var(--h3-line); }
.gcast-cmd .c-proj:focus { outline:none; border-style:solid;
  border-color:var(--h3-accent); background:var(--h3-well); }
.gcast-cmd .c-proj[data-empty="1"] { color:var(--h3-label); font-weight:400; }
/* 工程名后的保存状态点：已自动保存（蓝）/ 工程文件已保存（绿）/ 渲染中（琥珀脉冲）。 */
.gcast-cmd .gcast-savedot {
  flex:0 0 auto; display:inline-flex; align-items:center; gap:4px;
  font-size:9.5px; color:var(--h3-dim); white-space:nowrap;
}
.gcast-cmd .gcast-savedot::before {
  content:""; width:7px; height:7px; border-radius:50%;
  background:#6aa7c7; flex:none;
}
.gcast-cmd .gcast-savedot.saved { color:#7fbf7f; }
.gcast-cmd .gcast-savedot.saved::before { background:#7fbf7f; }
.gcast-cmd .gcast-savedot.run { color:#e8a34a; }
.gcast-cmd .gcast-savedot.run::before { background:#e8a34a;
  animation:gcast-dotpulse 1s ease-in-out infinite; }
@keyframes gcast-dotpulse { 50% { opacity:.3; } }
/* 平时（已自动保存 / 工程文件已保存）只留状态点、不显文字；渲染中(.run)才展开"渲染中" */
.gcast-cmd .gcast-savedot .dot-txt { font-size:9.5px; }
.gcast-cmd .gcast-savedot:not(.run) .dot-txt { display:none; }
/* 预设文件名降到次要一级：它只是"存这段会写到哪个文件"，不是这条片的身份。
   段号不再在这里显示 —— 指挥条上的段头胶囊已经说了"第 N 段 / M"。 */
.gcast-cmd .c-name { font-size:10.5px; color:var(--h3-dim); flex:0 0 auto;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px; }
.gcast-cmd .c-name .dirty { color:var(--h3-label); }
/* 段头：与时间轴上那段紫环、文案台上那颗胶囊是同一个信号，同一个紫。 */
/* ===== 元信息组：统一「灰标签 + 亮值」状态栏，三项完全同构、竖线分隔 ===== */
.gcast-cmd .gcast-meta {
  flex:0 0 auto; display:inline-flex; align-items:stretch; height:24px;
  background:#141414; border:1px solid var(--h3-line); border-radius:6px;
  font-family:ui-monospace,"Cascadia Mono",Consolas,"Microsoft YaHei",monospace; }
.gcast-cmd .gcast-meta > .c-seg,
.gcast-cmd .gcast-meta > .c-time,
.gcast-cmd .gcast-meta > .gcast-need {
  flex:none; display:inline-flex; align-items:center; gap:5px; margin:0;
  padding:0 11px; background:transparent; border:0; border-radius:0;
  font-size:11px; line-height:1; font-weight:400; color:var(--h3-dim); white-space:nowrap; }
/* 项间统一竖线（第一项不画） */
.gcast-cmd .gcast-meta > .c-time,
.gcast-cmd .gcast-meta > .gcast-need { box-shadow:-1px 0 0 var(--h3-line); }
/* 标签弱化、值亮白 —— 三项节奏一致：灰 → 亮 → 灰 → 亮 */
.gcast-cmd .gcast-meta .mlab { color:var(--h3-dim); font-weight:400; }
.gcast-cmd .gcast-meta .mval { color:#e9e9e9; font-weight:600; }
.gcast-cmd .gcast-meta .munit,
.gcast-cmd .gcast-meta .mdot { color:var(--h3-dim); font-weight:400; }
/* 段号值 → 紫、权重值 → 蓝：只染字、不铺块，不再有突出的实心色块 */
.gcast-cmd .gcast-meta > .c-seg .mval { color:var(--h3-violet); }
.gcast-cmd .gcast-meta > .gcast-need .mval { color:var(--h3-accent); }
.gcast-cmd .gcast-meta .gcast-warn { color:#e8a34a; font-weight:400; }
/* ===== 模式组：与元信息组同高、同圆角、同底色的分段控件，两段等宽 ===== */
.gcast-cmd .gcast-seg {
  flex:0 0 auto; height:24px; background:#141414; border-radius:6px; }
.gcast-cmd .gcast-seg .gcast-seg-btn { flex:0 0 58px; padding:0; font-size:10.5px; }
.gcast-cmd .spacer { margin-left:auto; }
.gcast-cmd .gcast-btn { flex:none; }
/* 节点右上角「新建工程」（20261011 从「工程 ▾」菜单移来）：常驻、克制，
   hover 才用强调色点亮。 */
.gcast-cmd .gcast-newproj { flex:none; }
.gcast-cmd .gcast-newproj:hover:not([disabled]) { color:var(--h3-accent);
  border-color:var(--h3-accent); background:var(--h3-accent-dim); }
.gcast-cmd .gcast-newproj[disabled] { opacity:.4; cursor:default; }

/* ---- 卡片 / 高级折叠 ---- */
.gcast-card { flex:none; min-width:0; background:var(--h3-panel);
  border:1px solid var(--h3-line); border-radius:10px; overflow:hidden; }
.gcast-card > .hd { display:flex; align-items:center; gap:7px; padding:5px 9px;
  background:var(--h3-raise); border-bottom:1px solid var(--h3-line);
  font-size:10.5px; color:var(--h3-txt); font-weight:500; min-width:0; }
.gcast-card > .hd .sub { margin-left:auto; color:var(--h3-dim); font-weight:400;
  font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gcast-card > .hd .gcast-need { margin-left:0; }
.gcast-card > .bd { padding:6px 9px; }
/* 高级项默认折叠：放大重绘、抽帧帧率属于"调过一次就再也不动"的
   参数，它们和画布/时长等权重地排在一起时，抢走了新手的注意力，也让老手
   每次都要在五行里找画布。 */
.gcast-adv { border-top:1px solid var(--h3-line); }
/* 原 .gcast-adv > summary 三条（折叠标题「高级　语义桥 · 放大重绘」）20261020
   随折叠一起删除 —— 现在这一块常驻展开、没有标题行。 */
.gcast-adv > .adv-bd { padding:6px 9px; display:flex; flex-direction:column; }
/* 右栏：设置卡 + 首尾帧卡上下叠，两卡共用一条定宽，监视器吃满余宽。 */
.gcast-col { display:flex; flex-direction:column; gap:9px; flex:0 1 540px;
  min-width:0; padding-bottom:9px; }

/* ---- 落地行：文案来源 + 渲染结果 ----
   渲染按钮已上提轴头（20261010），这行只剩文案来源与上一轮的结果。 */
.gcast-foot { display:flex; align-items:center; gap:8px; flex:none; min-width:0;
  flex-wrap:wrap; padding:6px 8px; background:var(--h3-panel);
  border:1px solid var(--h3-line); border-radius:8px; }
/* 文案来源那句会很长（未接文案台时是一整句接线指引），给它可以被压、必要时
   换行的弹性。 */
.gcast-foot .gcast-psrc { flex:1 1 auto; min-width:0; white-space:normal; }
/* 渲染结果行独占一行（且排在落地行最前）：它说的是"上一整轮跑得怎么样"，
   跟同一行里的"文案来源"不是一件事。 */
.gcast-foot .gcast-runres { flex:1 1 100%; order:-1; white-space:normal; }
.gcast-runres.ok  { color:#7fbf7f; }
.gcast-runres.bad { color:#e08a7a; }

/* 检查区标题的副标注：这一列报的是提示词的问题，而本节点已经不能改词——
   不给出去处，用户看到警告只能干瞪眼。 */
.gcast-psub { font-size:9.5px; color:var(--h3-label); }

/* ---- 窄节点：双栏改为上下堆叠 ----
   右栏定宽 540px、节点最小宽 560px，双栏在窄节点上会把成片监视器压到十几像素
   宽——用户看到的是"监视器凭空消失了"，而不是"它被挤扁了"。节点宽度不是视口
   宽度，媒体查询管不到，只能按容器实测宽度切档（.narrow 由 JS 的 ResizeObserver
   打上）。 */
.gcast.narrow .gcast-studio { flex-wrap:wrap; }
.gcast.narrow .gcast-studio .gcast-monitor { flex:1 1 100%; min-height:200px; }
.gcast.narrow .gcast-col { flex:1 1 100%; max-height:none !important; overflow:visible; }
/* 窄档（<820px）双栏上下堆（20261010 补齐）：右栏设置卡原本钉死 540px，
   堆到全宽行里右边留一条空档；落地行（文案来源 + 渲染控制）也要换行，
   否则窄档下互相挤成省略号。 */
.gcast.narrow .gcast-row { flex:1 1 100%; }
.gcast.narrow .gcast-foot { flex-wrap:wrap; row-gap:4px; }
/* 指挥条在窄节点上会换行，权重提示这一格是次要信息（全称已在模式开关的
   title 里），先让它让位，别把片名和段头挤到第二行去。 */
.gcast.narrow .gcast-cmd .gcast-need { display:none; }

/* 删除是这一排里唯一的破坏性操作，用淡红常驻（悬停那一档更红），
   别让它看起来跟"新建""还原"一样。 */
.gcast-lanes-hd .tools button.danger { color:#c98a8a; border-color:rgba(201,138,138,.35); }

/* custom dropdown -------------------------------------------------- */
.gcast-select { all:unset; pointer-events:auto; cursor:pointer; box-sizing:border-box;
  display:flex; align-items:center; gap:8px; min-width:0;
  background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:5px; padding:4px 8px; font-size:11.5px; font-family:inherit; }
.gcast-select:hover { border-color:var(--h3-dim); }
.gcast-select:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcast-select .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcast-select .caret { margin-left:auto; color:var(--h3-dim); font-size:9px; }
.gcast-select[aria-disabled="true"] { opacity:.45; cursor:default; }

.gcast-menu {
  --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-accent:#58d1ff;
  position:fixed; z-index:9100; box-sizing:border-box;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  background:var(--h3-panel); border:1px solid var(--h3-line); border-radius:9px;
  padding:4px; display:flex; flex-direction:column; gap:2px;
  max-height:60vh; overflow:auto; box-shadow:0 22px 60px #000d, 0 2px 10px #0009; }
.gcast-menu[data-mode="fl2va"] { --h3-accent:#59c14f; }
.gcast-menu button { all:unset; pointer-events:auto; cursor:pointer; box-sizing:border-box;
  display:flex; align-items:center; gap:8px; width:100%;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:6px;
  padding:3px 8px; font-size:11px; color:var(--h3-txt); white-space:nowrap; }
.gcast-menu button:hover { border-color:var(--h3-accent); }
.gcast-menu button[aria-selected="true"] { color:var(--h3-accent); border-color:var(--h3-accent); }
.gcast-menu button:disabled { opacity:.4; cursor:default; }
.gcast-menu button:disabled:hover { border-color:var(--h3-line); }
/* 段操作菜单里的分隔线与分组小标题 */
.gcast-msep { height:1px; background:var(--h3-line); margin:1px 2px; }
.gcast-msep-label { font-size:9.5px; color:var(--h3-dim); padding:1px 3px; }
.gcast-menu button .note { margin-left:auto; color:var(--h3-dim); font-size:9.5px;
  font-family:ui-monospace,Consolas,monospace; }
.gcast-menu .grp { padding:2px 3px 1px; font-size:9px; letter-spacing:.13em;
  text-transform:uppercase; color:var(--h3-dim); }
/* 异步补进菜单的分组（版本清单）。整组一起进出，所以包一层：
   拉不到清单时整组不出现，不会留下一个空的小标题。 */
.gcast-msub { display:flex; flex-direction:column; gap:2px; }
/* 版本行（20261026 用户定）：左边「切到第 N 版」，右边一个垃圾桶，点它就删这一版。
   删除只出现在非当前版上 —— 删掉正在用的那版，这一段就没有潜空间可用了。
   原来删除版单开一整组（标题 + N-1 个按钮），重抽几次菜单就长一倍。 */
.gcast-menu .gcast-take-row { display:flex; align-items:stretch; gap:3px; }
.gcast-menu .gcast-take-row > button { flex:1 1 auto; }
.gcast-menu .gcast-take-row > button.gcast-take-del { flex:0 0 auto; width:24px; padding:3px 0;
  text-align:center; font-size:10px; color:var(--h3-dim); }
.gcast-menu .gcast-take-row > button.gcast-take-del:hover { color:#e5534b; border-color:#e5534b; }

/* 历史旧工程菜单（轴头「🕘 历史」）---------------------------------- */
.gcast-hist { width:272px; }
.gcast-hist .gcast-hist-search { all:unset; box-sizing:border-box; pointer-events:auto;
  width:100%; background:var(--h3-well); border:1px solid var(--h3-line);
  border-radius:6px; padding:4px 8px; font-size:11px; color:var(--h3-txt); }
.gcast-hist .gcast-hist-search:focus { border-color:var(--h3-accent); }
.gcast-hist .gcast-hist-list { display:flex; flex-direction:column; gap:2px;
  overflow:auto; min-height:30px; max-height:46vh; }
.gcast-hist .gcast-hist-row { all:unset; pointer-events:auto; cursor:pointer; box-sizing:border-box;
  display:flex; align-items:center; gap:7px; width:100%; padding:4px 7px;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:6px; }
.gcast-hist .gcast-hist-row:hover { border-color:var(--h3-accent); }
.gcast-hist .gcast-hist-row[aria-current="true"] { border-color:var(--h3-accent); }
.gcast-hist .gcast-hist-dot { flex:0 0 7px; width:7px; height:7px; border-radius:50%; }
.gcast-hist .gcast-hist-dot.film { background:#59c14f; }
.gcast-hist .gcast-hist-dot.miss { background:#e8b23a; }
.gcast-hist .gcast-hist-dot.todo { background:#6b8fa8; }
.gcast-hist .gcast-hist-dot.empty { background:#555; }
.gcast-hist .gcast-hist-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:1px; }
.gcast-hist .gcast-hist-name { font-size:11px; color:var(--h3-txt); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.gcast-hist .gcast-hist-sub { font-size:9px; color:var(--h3-dim); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.gcast-hist .gcast-hist-when { flex:0 0 auto; font-size:9px; color:var(--h3-dim);
  font-family:ui-monospace,Consolas,monospace; }
.gcast-hist .gcast-hist-tag { flex:0 0 auto; font-size:8.5px; color:#c9a86a;
  border:1px solid #6a5534; border-radius:4px; padding:0 3px; }
.gcast-hist .gcast-hist-del { flex:0 0 auto; width:17px; height:17px; line-height:16px;
  text-align:center; font-size:11px; color:var(--h3-dim); border-radius:4px;
  cursor:pointer; user-select:none; box-sizing:border-box; }
.gcast-hist .gcast-hist-del:hover { color:#ff6b6b; background:rgba(220,80,80,.18); }
.gcast-hist .gcast-hist-del.busy { opacity:.45; pointer-events:none; }
.gcast-hist .gcast-hist-foot { display:flex; gap:6px; align-items:center;
  padding:2px 2px 0; }
.gcast-hist .gcast-hist-foot button { all:unset; pointer-events:auto; cursor:pointer;
  font-size:9.5px; color:var(--h3-dim); padding:1px 4px; border-radius:4px; }
.gcast-hist .gcast-hist-foot button:hover { color:var(--h3-txt); background:var(--h3-raise); }
.gcast-hist .gcast-hist-foot .sp { flex:1 1 auto; }
.gcast-hist .gcast-hist-empty { font-size:10px; color:var(--h3-dim); padding:8px 4px; text-align:center; }

.gcast-label { font-size:9.5px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--h3-label); font-weight:600; }

/* project timeline ----------------------------------------------------
   The whole film across the top of the node: one block per clip, width in
   proportion to its real length - honestly, so the ruler above means what it
   says. A short clip really is a narrow block; zoom in to work with it.
   Colour comes from the clip's id rather than its position, so a block keeps
   its colour when the film is reordered and can be followed while dragging. */
.gcast-tl { display:flex; flex-direction:column; gap:2px; }
.gcast-tl.off { display:none; }
.gcast-tl .head { display:flex; align-items:flex-end; gap:5px; }
.gcast-tl .tools { display:flex; gap:3px; flex:0 0 auto; padding-bottom:1px; }
.gcast-tl .tools button { width:17px; height:15px; padding:0; display:grid;
  place-items:center; background:var(--h3-well); color:var(--h3-dim);
  border:1px solid var(--h3-line); border-radius:4px; cursor:pointer;
  transition:color .12s ease, border-color .12s ease; }
.gcast-tl .tools button:hover:not(:disabled) { color:var(--h3-txt); border-color:var(--h3-accent); }
.gcast-tl .tools button:disabled { opacity:.35; cursor:default; }
.gcast-tl .tools button.danger:hover:not(:disabled) { color:#ff8a8a; border-color:#ff8a8a; }
.gcast-tl .tools svg { width:9px; height:9px; fill:none; stroke:currentColor;
  stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
/* a block too narrow for a label shows none rather than a clipped one */
.gcast-tl .clip.tiny { padding:0 2px; }
.gcast-tl .clip.tiny .nm, .gcast-tl .clip.tiny .du { display:none; }
.gcast-tl .clip input { width:100%; box-sizing:border-box; font-size:10px;
  padding:1px 3px; border-radius:3px; border:1px solid var(--h3-accent);
  background:rgba(0,0,0,.6); color:#fff; outline:none; }
/* The ruler is a pan surface as well as a scale. Once the strip overflows
   there is no empty track left to grab -- every pixel of it is a block --
   so without this the only way to scroll a long film is the wheel. */
.gcast-tl .rule { position:relative; height:10px; overflow:hidden;
  touch-action:none; flex:1 1 auto; min-width:0; }
.gcast-tl .rule.pannable { cursor:grab; }
.gcast-tl .rule.panning { cursor:grabbing; }
.gcast-tl .rule .t { position:absolute; bottom:0; width:1px; height:3px;
  background:var(--h3-dim); opacity:.32; }
.gcast-tl .rule .t.maj { height:6px; opacity:.65; }
.gcast-tl .rule .lbl { position:absolute; top:0; margin-left:3px; line-height:1;
  font-family:ui-monospace,Consolas,monospace; font-size:8px; color:var(--h3-dim);
  opacity:.75; }
.gcast-tl .view { position:relative; height:41px; overflow:hidden; border-radius:7px;
  background:var(--h3-well); box-shadow:inset 0 1px 3px rgba(0,0,0,.38);
  touch-action:none; }
.gcast-tl .view.pannable { cursor:grab; }
.gcast-tl .view.panning { cursor:grabbing; }
/* panned by left, not by transform: a transformed layer inside the canvas
   zoom is rasterised at one scale and composited at another, which is what
   put the prompt colouring a letter out. Nothing here has to line up with a
   caret, but the text would still soften for no gain. */
.gcast-tl .strip { position:absolute; top:0; bottom:0; }
.gcast-tl .clip { position:absolute; top:0; bottom:0; border-radius:6px;
  box-sizing:border-box; padding:0 7px 0 12px; overflow:hidden; cursor:pointer;
  display:flex; flex-direction:column; justify-content:center; gap:1px;
  /* A card, not a colour block: near-black body with the clip's colour as a
     solid edge down the left and a bloom off it. That replaces the old dark
     ramp, which existed because colours are keyed to clip IDENTITY, so two
     neighbours can draw the same colour and a shared edge between two flat
     fills is invisible. A hard colour bar at every block start says it louder. */
  background:linear-gradient(90deg, var(--cg, #ffffff1a) 0px, var(--cw, #ffffff0f) 24px,
             #ffffff00 66%), var(--h3-panel);
  box-shadow:inset 0 0 0 2px #ffffff17, 0 1px 3px rgba(0,0,0,.45);
  transition:left .15s cubic-bezier(.2,.7,.3,1), filter .12s ease, box-shadow .12s ease; }
.gcast-tl .clip::before { content:""; position:absolute; left:0; top:0; bottom:0;
  width:4px; border-radius:6px 0 0 6px; background:var(--c, #444); }
.gcast-tl .clip.nomove { transition:filter .12s ease, box-shadow .12s ease; }
.gcast-tl .clip .nm { font-size:12px; line-height:1.15; color:#fff; opacity:.96;
  text-shadow:0 1px 2px rgba(0,0,0,.55); white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; }
.gcast-tl .clip .du { font-family:ui-monospace,Consolas,monospace; font-size:9.5px;
  line-height:1; color:#fff; opacity:.66; text-shadow:0 1px 2px rgba(0,0,0,.55);
  white-space:nowrap; }
.gcast-tl .clip:hover { filter:brightness(1.18); }
/* Skipped clips stay legible but plainly out of the run: greyed and dropped
   back, never hidden and never a different height -- the timeline is how you
   read the shape of the project, and a block that changes size when you skip
   it makes the whole strip jump. Grey reads at any zoom, including blocks too
   narrow to carry the dot. */
.gcast-tl .clip.off { filter:grayscale(1); opacity:.45; }
.gcast-tl .clip.off:hover { filter:grayscale(1) brightness(1.3); opacity:.62; }
.gcast-tl .clip.off .nm { opacity:.8; }
/* The dot is the CONTROL, and it degrades where the state does not: below a
   readable width it would be a 6px target sitting on a draggable block, which
   is a mis-click waiting to happen. The block still shows its state; you just
   toggle it from the project list or with Alt-click. */
.gcast-tl .clip .sk { position:absolute; top:3px; right:4px; width:13px; height:13px;
  border:0; padding:0; border-radius:50%; background:#00000059; color:#fff;
  font-size:8px; line-height:13px; text-align:center; cursor:pointer;
  opacity:.5; transition:opacity .12s ease, background .12s ease; z-index:2; }
.gcast-tl .clip .sk:hover { opacity:1; background:#000000a6; }
.gcast-tl .clip.off .sk { opacity:.9; }
.gcast-tl .clip.hasdot { padding-right:21px; }
.gcast-tl .clip.on { box-shadow:inset 0 0 0 2px var(--h3-accent), 0 2px 7px rgba(0,0,0,.55); }
.gcast-tl .clip.on .nm { opacity:1; }
.gcast-tl .clip.lifted { opacity:.3; }
/* where the dragged clip would land */
.gcast-tl .drop { position:absolute; top:-1px; bottom:-1px; width:3px; margin-left:-1.5px;
  background:#fff; border-radius:2px;
  box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 0 9px rgba(255,255,255,.75);
  pointer-events:none; z-index:3; }
/* Links. A linked pair is drawn as one run: no gap between the blocks, the
   touching corners squared off, and an accent rule along the bottom of every
   block in the run - readable at any zoom, including blocks too narrow for
   the button. The rule is an ::after because the block clips its own
   overflow and ::before is already the colour edge. */
.gcast-tl .clip.lp { border-top-left-radius:0; border-bottom-left-radius:0; }
.gcast-tl .clip.lp::before { border-radius:0; }
.gcast-tl .clip.ln { border-top-right-radius:0; border-bottom-right-radius:0; }
.gcast-tl .clip.lk::after { content:""; position:absolute; left:0; right:0; bottom:0;
  height:2px; opacity:.9; pointer-events:none;
  background:repeating-linear-gradient(90deg, #ff9f43 0 6px, transparent 6px 10px); }
/* The control sits ON the seam, in the strip rather than in either block -
   both blocks clip their overflow, so a child of one could not straddle the
   edge. Invisible at rest when unlinked so it does not litter every boundary;
   the whole strip reveals them on hover. Linked ones stay lit. */
.gcast-tl .lnk { position:absolute; top:calc(50% - 8px); width:16px; height:16px;
  margin-left:-8px; padding:0; border:1px solid #ffffff38; border-radius:50%;
  background:#141414e6; color:#bdbdbd; display:grid; place-items:center;
  cursor:pointer; pointer-events:auto; z-index:4; opacity:0;
  transition:opacity .12s ease, border-color .12s ease, color .12s ease; }
.gcast-tl .lnk svg { width:10px; height:10px; fill:none; stroke:currentColor;
  stroke-width:1.5; stroke-linecap:round; }
.gcast-tl .view:hover .lnk { opacity:.6; }
.gcast-tl .lnk:hover { opacity:1; color:#fff; border-color:#ff9f43; }
.gcast-tl .lnk.on { opacity:1; background:#ff9f43; border-color:#ff9f43;
  color:#111; }
.gcast-tl .view:hover .lnk.on { opacity:1; }
/* Blocks slide during a drag and the seams move with them, so the controls
   would sit on boundaries that no longer exist. Gone until the drop repaints. */
.gcast-tl .strip.dragging .lnk { display:none; }
.gcast-tl .clip.virtual { cursor:default; }

/* mode bar ---------------------------------------------------------- */
.gcast-modebar { display:flex; align-items:center; gap:10px;
  background:linear-gradient(90deg, var(--h3-accent-dim), transparent 65%);
  border:1px solid var(--h3-line); border-left:3px solid var(--h3-accent);
  border-radius:8px; padding:7px 10px; }
/* 旧 .gcast-seg / .gcast-seg button 规则已删（20261011）：与下文 inspector 段的
   .gcast-seg / .gcast-seg-btn 重复，且「.gcast-seg button」元素选择器优先级更高、
   把分段按钮固定高度覆盖了；segmented 同步用 .is-on，不用 aria-pressed。 */
.gcast-need { margin-left:auto; font-family:ui-monospace,Consolas,monospace; font-size:10.5px;
  color:var(--h3-dim); }
.gcast-need b { color:var(--h3-accent); font-weight:600; }

/* settings row ------------------------------------------------------ */
/* 设置区：紧凑表单（方案 B）——每行「标签定宽 + 控件 + 读出右对齐」，行间只用
   细分隔线，不再给每项描边成卡片。设置是参数表不是内容块，卡片层级让给续写
   来源与提示词；省下的高度直接还给提示词区。
   min-width:0 / minmax(0,1fr)：控件与文案的 min-content 会托住轨道，节点收窄
   时必须显式压到 0，宽度才真正由 flex 分配。
   现在 row 是「监视器在左、设置卡在右」双栏里的右侧栏（.gcast-studio），固定
   到 540px 让五张参数卡有稳定宽；窄节点时允许收缩、内层控件 minmax 已防溢出。 */
.gcast-row { display:flex; flex-direction:column; flex:0 1 540px;
  max-width:540px; min-width:320px; padding:0 10px; }
.gcast-field { display:flex; align-items:center; gap:7px; min-height:30px;
  min-width:0; overflow:hidden; border-bottom:1px solid var(--h3-line); }
.gcast-field:last-child { border-bottom:0; }
.gcast-flabel { flex:0 0 62px; font-size:11px; font-weight:600; letter-spacing:.06em;
  color:var(--h3-label); white-space:nowrap; }
.gcast-ctl { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
.gcast select, .gcast input[type="number"] {
  background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:5px; padding:4px 6px; font-size:11.5px; font-family:inherit; outline:none; }
.gcast select:focus-visible, .gcast input:focus-visible, .gcast textarea:focus-visible {
  border-color:var(--h3-accent); }
.gcast input[type="number"] { width:62px; }
.gcast-read { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--h3-dim); }
.gcast-read b { color:var(--h3-txt); font-weight:600; }
/* 表单行：全行唯一字号 11px（层级只靠颜色与字重区分，不再用字号），
   控件统一 22px 高。下拉改按内容宽度自适应——flex:1 曾把 "10s" 撑成 121px
   的空壳框，"框很大"的根因就在这里。数据读出放弃等宽：中文在等宽字体下会
   回退到系统字体反而更乱，改用同字体 + 等宽数字 tabular-nums。 */
.gcast-field .gcast-ctl { flex-wrap:nowrap; gap:6px; min-width:0; }
/* 控件字号与高度统一：数字框、下拉、按钮一律 10px / 20px。原先三者各为
   11/11/11px 且高度不一，数字框窄、字号却与按钮一样大，4 位数（如 1888）
   必然被截。gcast-select 是 all:unset 的按钮，自身没有默认高度，必须在此
   显式给 height，否则它按内容行高排、与旁边 20px 的数字框差一截。 */
.gcast-field input[type="number"], .gcast-field .gcast-select,
.gcast-field select.gcast-btn, .gcast-btn {
  height:20px; box-sizing:border-box; font-size:10px; }
.gcast-field .gcast-select { flex:0 1 auto; min-width:0; padding:0 5px; gap:5px; }
.gcast-field .gcast-select .caret { font-size:10px; }
/* flex 由 autoWidth 在 JS 里逐个钉成 0 0 auto（否则 flex-shrink 会把按内容
   算出的宽度压回去，长值照旧截断）；此处不写 flex，留给 JS 决定。 */
.gcast-field .gcast-ctl input[type="number"] { width:52px; min-width:0;
  text-align:center; padding:0 2px; letter-spacing:-.01em; }
.gcast-field .gcap { font-size:11px; font-family:inherit; color:var(--h3-dim);
  white-space:nowrap; flex:0 0 auto; }
.gcast-field .gcap.dim-x { color:var(--h3-label); padding:0 2px; }
.gcast-field input[type="checkbox"] { accent-color:var(--h3-accent);
  width:13px; height:13px; margin:0; flex:0 0 auto; }
.gcast-field .gcast-read { font-size:10px; font-family:inherit;
  font-variant-numeric:tabular-nums; color:var(--h3-dim); margin-left:auto;
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  text-align:right; }
.gcast-field .gcast-read b { color:var(--h3-txt); font-weight:600; }

/* ---- 字段分组（规格 / 参考 / 重抽·接缝）----------------------------
   六个 field 不再等权平铺：分组后用细分隔线 + 间距把层级立起来，新人一眼
   看出"先定规格、再挂参考、最后管重抽"。 */
.gcast-fgroup { display:flex; flex-direction:column; min-width:0; }
.gcast-fgroup + .gcast-fgroup {
  margin-top:8px; padding-top:8px; border-top:1px solid var(--h3-line);
}

/* 时长滑块：与预设下拉、秒框同一行，滑块弹性占宽（不另起一行） */
.gcast-range { -webkit-appearance:none; appearance:none;
  flex:1 1 auto; min-width:72px; height:20px;
  background:transparent; cursor:pointer; margin:0; }
.gcast-range::-webkit-slider-runnable-track {
  -webkit-appearance:none; appearance:none;
  height:4px; border-radius:2px; background:#45454c;
}
.gcast-range::-webkit-slider-thumb {
  -webkit-appearance:none; appearance:none;
  width:16px; height:16px; border-radius:50%; margin-top:-6px;
  background:#e9e9ef; border:0;
  box-shadow:0 1px 3px rgba(0,0,0,.6), inset 0 0 0 .5px rgba(0,0,0,.15);
  transition:background .12s, transform .12s;
}
.gcast-range:hover::-webkit-slider-thumb { background:#fff; }
.gcast-range:active::-webkit-slider-thumb { background:#58d1ff; transform:scale(1.12); }
.gcast-range:focus { outline:none; }

/* ---- 分段胶囊（Apple segmented control）----------------------------
   一组互斥选项摊成一整条分段按钮，替代下拉：选项全部可见、一眼可点，是
   新人最不容易迷路的控件。容器是内凹的 well，选中段是一块凸起的滑块。 */
.gcast-seg {
  flex:1 1 auto; min-width:0; position:relative; box-sizing:border-box;
  display:flex; gap:2px; padding:2px; height:22px;
  background:#141414; border:1px solid var(--h3-line); border-radius:8px;
}
.gcast-seg-btn {
  flex:1 1 0; min-width:0; appearance:none; border:0; cursor:pointer;
  background:transparent; color:var(--h3-dim); align-self:stretch;
  font-family:inherit; font-size:10.5px; font-weight:500; letter-spacing:.01em;
  padding:0 4px; display:flex; align-items:center; justify-content:center;
  border-radius:6px; white-space:nowrap;
  transition:color .15s ease, background .15s ease, box-shadow .15s ease;
}
.gcast-seg-btn:hover { color:var(--h3-txt); }
.gcast-seg-btn.is-on {
  color:var(--h3-txt); background:var(--h3-raise);
  box-shadow:0 1px 2.5px rgba(0,0,0,.55), inset 0 0 0 .5px rgba(255,255,255,.06);
}
.gcast-seg.is-disabled { opacity:.5; }
.gcast-seg.is-disabled .gcast-seg-btn { cursor:default; }

/* slots ------------------------------------------------------------- */
.gcast-grid { display:grid; gap:7px; }
.gcast-grid.img { grid-template-columns:repeat(9, minmax(0,1fr)); }
/* 首尾帧（fl）与多参考（fl3）按固定列宽而非等分：等分会让每格吃掉整行宽度，
   缩略图被拉得过宽、修剪条与波形一起变松垮。固定 190px 让卡片保持紧凑，
   右侧余宽留给续写卡。minmax(0,190px) 保证窄节点下仍能收缩。 */
.gcast-grid.fl  { grid-template-columns:repeat(2, minmax(0,190px)); }
.gcast-grid.med { grid-template-columns:repeat(3, minmax(0,190px)); }
/* One extra column so the continuation rides in the SAME row as the reference
   slots. It had a section of its own below them, and that cost a whole row of
   node height for one card. */
/* grid 行默认按内容高度（auto），不会跟着分栏的 align-items:stretch 长高——
   这正是续写卡右侧留空白的真因：容器被 flex 撑高了，卡片本身没长。
   grid-template-rows:1fr 让唯一的续写卡占满整行，高度交给 flex:1 的缩略图分配。 */
.gcast-grid.med4 { grid-template-columns:1fr; grid-template-rows:1fr; }
.gcast-grid.fl3  { grid-template-columns:repeat(3, minmax(0,190px)); }

.gcast-slot { position:relative; background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:7px; overflow:hidden; cursor:pointer; transition:.13s;
  box-shadow:0 2px 6px rgba(0,0,0,.45); }
.gcast-slot:hover { border-color:var(--h3-dim); }
.gcast-slot.filled { border-color:var(--h3-accent); }
.gcast-slot.drop { border-color:var(--h3-accent); background:var(--h3-accent-dim); }
/* 追加态（20261020 落格语义）：默认落点是「加到末尾、这一格不动」，用虚线 +
   淡底与「就落这一格」的实线区分。不区分的话，拖到这格上却出现在末尾会被
   当成程序乱放。按住 Shift 才切回实线（替换这一格）。 */
.gcast-slot.drop-append { border-style:dashed; background:var(--h3-well); }
.gcast-slot.drop-append .gcast-thumb { opacity:.5; }
/* While a file is over the node, every slot that could take it lifts out of
   the background, so a near-miss is visible before the release rather than
   after. The slot actually under the pointer keeps the stronger .drop look. */
.gcast-armed { outline:1px dashed var(--h3-accent); outline-offset:-2px;
  background:var(--h3-accent-dim); }
.gcast-armed .gcast-empty { color:var(--h3-accent); opacity:1; }
.gcast-reject { border-color:#b4544f !important; background:rgba(180,84,79,.14) !important; }
/* Only the slot UNDER THE POINTER reads as the target. Arming every slot that
   could take the file lit up all nine images or all four video cards at once,
   which reads as everything-selected rather than as a hint. Neutralised per
   slot type, not by one blanket rule: gcast-armed lands on the THUMB for a
   video and on the card for an image, so a single background:transparent took
   the dark well with it. Each gets its own background back. Two classes beats
   the one-class gcast-armed rules above, and source order settles the rest. */
.gcast-thumb.gcast-armed { outline:none; background:var(--h3-well); }
.gcast-wav.gcast-armed   { outline:none; background:var(--h3-well); }
.gcast-slot.gcast-armed  { outline:none; background:var(--h3-panel); }
.gcast-armed .gcast-empty { color:#525252; opacity:.9; }
/* The hovered target. Media slots wire their drop on an INNER element - the
   thumb for video, the waveform for an empty audio - so the drop class lands
   there and the gcast-slot.drop rule never matched them. Without this the slot
   under the pointer showed nothing, which is why they all looked the same. */
.gcast-media.drop, .gcast-media .gcast-thumb.drop, .gcast-media .gcast-wav.drop {
  border-color:var(--h3-accent); background:var(--h3-accent-dim);
  box-shadow:inset 0 0 0 1px var(--h3-accent); }
.gcast-thumb { width:100%; aspect-ratio:1/1; display:flex; align-items:center; justify-content:center;
  background:var(--h3-well); }
.gcast-grid.fl .gcast-thumb, .gcast-grid.fl3 .gcast-thumb { aspect-ratio:16/9; }
.gcast-thumb img, .gcast-thumb video { width:100%; height:100%; display:block; object-fit:contain; }
/* 视频等比例完整显示（contain），不裁边：竖屏素材在 16:9 框内左右留黑、
   上下完整可见，而不是被 cover 切成一条。图片仍走各自规则（img 槽 contain、
   悬浮预览 cover 保持）。 */
.gcast-thumb video { object-fit:contain; }
/* 槽填图后也**保持固定框**（fl/fl3 = 16/9，其它网格见各自规则）：图片/视频一律
   object-fit:contain 等比缩放进框，竖图左右留边、横图上下留边 —— 不按原始尺寸
   把槽撑大（会顶乱整行、把时间轴推下去），也不 cover 裁切。空槽保留同尺寸给
   "+" 占位。 */
/* Reference-image box: all nine slots share one bordered box laid out as a
   3x3 grid (read left-to-right, top-to-bottom). Cells keep one fixed height so
   a tall portrait reference no longer blows the rack up, and the image stays
   contained -- never cropped -- inside it. */
.gcast-imgbox { background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:8px; padding:7px; display:flex; flex-direction:column; gap:7px; }
.gcast-grid.img .gcast-slot { padding:4px; display:flex; flex-direction:column; gap:4px; }
/* Border colour follows the video/audio cards exactly: quiet grey until a file
   is in, accent once filled, no hover shift. */
.gcast-grid.img .gcast-slot:hover { border-color:var(--h3-line); }
.gcast-grid.img .gcast-thumb { position:relative; width:100%; height:48px; aspect-ratio:auto; }
.gcast-grid.img .gcast-thumb img { width:100%; height:100%; object-fit:contain; object-position:center; }
/* Corner number dot: a perfect circle, no stroke, pale-blue tint, white digit.
   Its own class so the FL/REF text badge styles never leak into it. */
.gcast-num { position:absolute; left:2px; top:2px; z-index:2; pointer-events:none;
  display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box;
  width:8px; height:8px; min-width:8px; min-height:8px; flex:0 0 auto; padding:0; margin:0;
  border:none; outline:none; box-shadow:none; border-radius:50%;
  font-family:ui-monospace,Consolas,monospace; font-size:6px; font-weight:700;
  line-height:1; letter-spacing:0; color:#fff; background:rgba(88,209,255,.5); }
/* Caption bar on each cell: just the original filename (6px so long names fit)
   with the clear control pushed to the far end. */
.gcast-grid.img .gcast-cap { padding:0; gap:4px; font-size:6px; line-height:1.3; }
.gcast-grid.img .gcast-cap .fn { flex:1 1 auto; min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; opacity:.8; }
.gcast-grid.img .gcast-cap .gcast-x { font-size:10px; padding:0 1px; }
/* Reorder affordance: the picture is what moves, the cell keeps its number. */
.gcast-grid.img .gcast-slot { cursor:grab; }

/* ---- 手动拖拽换位：看得见的反馈（20261023）----
   换位逻辑早就可以用（图片 / 视频 / 音频三类都挂了 dragstart/dragover/drop），
   但 gcast-dragging 与 gcast-reorder-drop 这两个类名**全项目没有一条样式**
   —— 拖起来的卡和落点卡长得一模一样，用户只能"松手看看有没有动"，于是
   这件事在他眼里等于"不能拖"。这里把两个状态补上，语义按**交换**表达
   （落点是"和这一格换"，不是"插到这一格前面"）。
   背景拖外部文件时用的 .drop / .drop-append 是另一套，互不干扰。 */
.gcast-slot.gcast-dragging,
.gcast-media.gcast-dragging {
  opacity:.34;
  /* 降饱和而不是变透明到底：还看得见是哪一张被拿起来了，位置不丢 */
  filter:grayscale(.55);
  border-style:dashed;
  cursor:grabbing;
  /* 被拿起来的那张不跟着指针重排，避免"拖着自己跑"的错觉 */
  transform:none;
}
.gcast-slot.gcast-reorder-drop,
.gcast-media.gcast-reorder-drop {
  border-color:var(--h3-accent);
  border-style:dashed;
  background:var(--h3-accent-dim);
  /* 抬高一点：落点是自己浮上来，不是源卡压下去 */
  box-shadow:0 0 0 2px var(--h3-accent-dim), 0 6px 18px rgba(0,0,0,.55);
}
/* 落点角标「⇄」：明确这是交换。只在非源卡上出现，源卡自己不会亮
   （JS 里 dragover 已经挡掉 dragFrom === i 的情况）。 */
.gcast-slot.gcast-reorder-drop::after,
.gcast-media.gcast-reorder-drop::after {
  content:"⇄";
  position:absolute; top:3px; right:3px; z-index:6;
  width:15px; height:15px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-size:10px; line-height:1; color:#0d0d0d;
  background:var(--h3-accent);
  box-shadow:0 1px 4px rgba(0,0,0,.6);
  pointer-events:none;
}
/* 落到**空槽**上是"搬过去"，不是"交换" —— 这正是调整 @图片N / @视频N 位置
   的常用手法（把第 5 张搬到第 2 格，它就变成 @图片2）。所以空槽一样要高亮，
   只把角标换成箭头，两种语义一眼分得开。 */
.gcast-slot:not(.filled).gcast-reorder-drop::after,
.gcast-media:not(.filled).gcast-reorder-drop::after { content:"→"; }
/* 拖拽期间别让浏览器去选中卡片里的文字（拖到一半出现蓝色选区非常跳） */
.gcast-slot.gcast-dragging, .gcast-media.gcast-dragging,
.gcast-grid.img, .gcast-grid.med { user-select:none; }
/* 缩略图默认是原生可拖元素，会抢走卡片的 dragstart（拖出来的是一个 img，
   不是整张卡）—— 关掉它，换位始终以"卡"为单位。 */
.gcast-slot img, .gcast-media img { -webkit-user-drag:none; }
/* 「本段文案**没有引用**」的格子 → 置灰。
   素材还在架上存着，但这一段提示词里没写 @图片N，模型看不到它 —— 摆了 28 张、
   文案实际用了 6 张，一眼就能看出哪几张真的在被用。这就是"高亮引用项"的
   另一半：被引用的是正常显示（相对就是亮的），没被引用的压暗。

   20261024：这里的判据换过一次 —— 原来是「槽号 ≥ 导演台会送的张数」，那是
   **错的**：上限算的是**被引用的个数**（后端 sorted(idxs)[:cap]），第 15 格被
   @图片15 引用时照样送得出去，按槽号判会把 10 格以后全冤枉成"不进提示词"。
   机制与视觉原样保留，只是把判据换成"本段文案有没有写它"（见
   csglide_rack_refs.js）。降饱和 + 虚线边，不遮挡缩略图本身。 */
.gcast-unref { border-style:dashed !important; }
.gcast-unref .gcast-thumb { opacity:.5; }
.gcast-unref .gcast-cap { opacity:.6; }
.gcast-unref .gcast-num { background:rgba(151,151,151,.55); }
/* 「＋ 添加」格：常驻各类槽位末尾，按需追加空槽位。共用——媒体架与 Qwen
   编辑台都用同一张样式表，各写一份迟早会漂。 */
.gcast-addtile { border:1px dashed var(--h3-line); border-radius:7px; min-height:48px;
  display:flex; align-items:center; justify-content:center;
  color:var(--h3-dim); font-size:11px; cursor:pointer; user-select:none; }
.gcast-addtile:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcast-empty { color:#525252; font-size:18px; font-weight:300; }
/* 预览缺失（/view 404 或浏览器解不了码）时的占位：警示色、可读、给行动建议 */
.gcast-broken { display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:3px; width:100%; height:100%; padding:4px; box-sizing:border-box;
  background:#3a1e1e; border:1px dashed #a05252; border-radius:5px;
  color:#ffb3b3; text-align:center; }
.gcast-broken-ico { font-size:14px; line-height:1; }
.gcast-broken-txt { font-size:8px; line-height:1.25; opacity:.9; }
.gcast-cap { display:flex; align-items:center; gap:5px; padding:4px 6px;
  font-family:ui-monospace,Consolas,monospace; font-size:10px; color:var(--h3-dim); }
.gcast-slot.filled .gcast-cap { color:var(--h3-accent); }
.gcast-cap .n { opacity:.55; }
.gcast-cap .spacer { margin-left:auto; }
.gcast-last { all:unset; pointer-events:auto; cursor:pointer; padding:1px 6px; border-radius:4px;
  border:1px solid #4d3b22; color:#e8a758; font-size:9px; line-height:1.5;
  font-family:ui-monospace,Consolas,monospace; }
.gcast-last:hover { border-color:#ff9f43; color:#ff9f43; background:#ff9f4314; }
.gcast-last:focus-visible { outline:2px solid #ff9f43; outline-offset:1px; }
.gcast-last[disabled] { opacity:.45; cursor:default; }
.gcast-last.warn { border-color:#c8892f; color:#ffc069; }
.gcast-last.warn:hover { border-color:#ffc069; background:#ffc0691a; }
.gcast-chroma { position:absolute; left:5px; top:5px; z-index:3; pointer-events:auto;
  font-family:ui-monospace,Consolas,monospace; font-size:8px; line-height:1.5;
  padding:1px 5px; border-radius:3px; cursor:help; white-space:nowrap;
  background:#0b0b0bcc; border:1px solid #3f7d4f; color:#6fe08a; }
.gcast-chroma.weak { border-color:#b5502a; color:#ff8a5c; }

/* The run overlay covers the panel on purpose: while a run owns the node,
   editing a clip that is about to be queued would silently change what gets
   rendered. Blocking input is simpler to reason about than disabling widgets
   one by one, and Stop is the only thing that stays live. */
.gcast.running { position:relative; }
/* max-width/max-height 双保险（20261012）：即使将来再有内容把双栏撑出节点，
   遮罩与卡片也锁在 studio 盒内，不跟着溢出到画布/隔壁节点上。 */
/* 挂 document.body + position:fixed：left/top/width/height 由 JS（placeRunBox）
   按双栏 .gcast-studio 的视觉矩形逐帧写入。脱离节点 .dom-widget 的
   transform:scale 缩放盒 —— 画布缩放/平移时遮罩不偏移、卡片不被放大。
   z-index 9500：低于段工具条/弹出菜单（10000），高于面板内一切内容。 */
.gcast-run { position:fixed; left:0; top:0; width:1px; height:1px; z-index:9500;
  display:flex; align-items:center; justify-content:center;
  background:#07070799; backdrop-filter:blur(1.5px);
  overflow:hidden; box-sizing:border-box; }
/* 20261106：渲染期监视器要显示导演台内置的逐帧预览，遮罩不再盖左栏。
   placeRunBox 已改为按右栏定位；这里再加一层保险，几何有偏差也不把画面压黑。 */
.gcast-run.bz-live { background:transparent; backdrop-filter:none; pointer-events:none; }
.gcast-run.bz-live .card { pointer-events:auto; }
.bzf-view { position:relative; }
/* 20261107 修：csglide_film.js:108 有 .bzf-view img { opacity:0 }（靠 .bzf-ok 才显），
   预览层正好是 .bzf-view 里的 img —— 不显式盖掉 opacity 就收到帧也全透明。
   本选择器优先级 (0,2,0) 高于 .bzf-view img (0,1,1)。 */
.bzf-view .gcast-live-frame { position:absolute; inset:0; width:100%; height:100%;
  object-fit:contain; background:#000; z-index:6; display:none; opacity:1;
  pointer-events:none; }
.bzf-view .gcast-live-frame.is-on { display:block; opacity:1; }
.gcast-run .card { display:flex; flex-direction:column; gap:7px; align-items:center;
  padding:16px 22px; border-radius:8px; background:#141414f2;
  border:1px solid var(--h3-accent); box-shadow:0 10px 34px #000a;
  max-width:calc(100% - 24px); box-sizing:border-box; }
.gcast-run .ttl { font-size:11px; color:var(--h3-accent); letter-spacing:.04em; }
.gcast-run .msg { font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#e8e8e8; }
.gcast-run .sub { font-size:10px; color:var(--h3-dim); min-height:12px; }
.gcast-runmode { background:#191919; color:#ccc; border:1px solid #333; border-radius:4px;
  font-size:10px; padding:2px 4px; font-family:inherit; }
.gcast-btn.run { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcast-btn.run:hover:not([disabled]) { background:#ff9f4318; }
/* 裁切剃刀模式按钮（20261014）：激活态用切割红，明确"现在点段块会切开"，
   与运行（琥珀）/ 普通（中性）区分。 */
.gcast-btn.gcast-cut-btn.active { border-color:#ff5f56; color:#ff8a84; background:#ff5f5618; }
.gcast-btn.gcast-cut-btn.active:hover:not([disabled]) { background:#ff5f562a; }
/* （渲染控制行已撤，20261010：按钮上轴头、两个下拉删除 —— 相关样式一并清掉。） */

/* （重抽后的采纳对比框样式已删，20261010：那个框本身撤了 —— 重抽一律直接采纳，
   不再弹窗。旧版本仍留在磁盘上，用段块右键的版本清单切回去。） */
.gcast-x { all:unset; pointer-events:auto; cursor:pointer; margin-left:auto; color:var(--h3-dim); padding:0 3px;
  border-radius:3px; font-size:12px; line-height:1; }
.gcast-x:hover { color:#ff7a7a; background:#ff7a7a1a; }

/* media cards ------------------------------------------------------- */
/* position:relative 是给换位角标（.gcast-reorder-drop::after）用的：
   卡片里唯一绝对定位的子元素 .gcast-chroma 挂在 .gcast-track 上，而 track 自己
   已经是 position:relative，所以在这里补定位上下文不会挪动任何现有元素。 */
.gcast-media { position:relative; background:var(--h3-panel);
  border:1px solid var(--h3-line); border-radius:7px;
  overflow:hidden; padding:7px; display:flex; flex-direction:column; gap:6px; }
/* 节点收窄时网格卡（续写来源等）允许缩到轨道宽并裁掉内容，min-content 不再
   把卡片托出面板（横向溢出的元凶就是卡内「续写来源」标签的 nowrap 最小宽） */
.gcast-grid > * { min-width:0; }
.gcast-media.filled { border-color:var(--h3-accent); }
/* Amber, not the accent: the continuation is not a reference, it is where this
   clip picks up from. Different job, different colour, so the eye never files
   it with the slots either side of it. */
.gcast-media.cont { background:#221c15; border-color:#4d3b22; }
.gcast-media.cont.filled { border-color:#ff9f43; }
.gcast-media.cont .gcast-cap { color:#e8a758; }
.gcast-media.cont .gcast-ico { color:#ff9f43; display:flex; flex:0 0 auto; }
.gcast-media.cont .gcast-chk { color:#e8a758; }
.gcast-media .gcast-thumb { aspect-ratio:16/9; border-radius:5px; overflow:hidden; cursor:pointer; }
/* 续写卡（med4 单列全宽）的高度必须向左列四卡看齐，而不是自己定高：
   aspect-ratio:16/9 会让缩略图随余宽变高，反过来把整条分栏撑开。
   改为 flex 填充——但修剪条（波形+播放行+快速帧档+复选框）本身已比
   四卡总高还高，min-height:0 会把缩略图压成 0px、视频整条看不见，
   所以给一个 96px 的可见下限：四卡保持内容高，续写卡略高于四卡。
   Source order matters here: same specificity as the 16/9 rule above, so this
   has to come AFTER it or it never applies. */
/* 续写卡（med4 单列全宽）必须真正铺满右侧余宽，而不是靠 min-height 兜一个
   96px 下限——那正是截图里右侧留一大块空白的原因。改为：卡片本身撑满分栏高度
   （align-items:stretch 已在容器上），缩略图 flex:1 吃掉修剪条以外的全部剩余，
   min-height 保 96px 只作为修剪条本身过高时的兜底。 */
.gcast-grid.med4 .gcast-thumb { aspect-ratio:auto; flex:1 1 0; min-height:96px; }
/* 档位按钮行现在位于卡片内部首位：给卡片加 7px 顶部内边距、按钮行自身去掉
   外边距，使「文件续写」与下方「续写来源」标题之间保持与其他卡片一致的间距，
   而不是紧贴卡片顶边。 */
.gcast-media.cont > .gcast-bar:first-child { margin: -2px 0 1px; }
.gcast-grid.fl3 .gcast-thumb { aspect-ratio:6/5; }
.gcast-wav { width:100%; height:34px; background:var(--h3-well); border-radius:5px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; color:#525252; font-size:11px; }

.gcast-trim { padding:2px 0 0; }
.gcast-track { position:relative; height:44px; cursor:pointer;
  background:var(--h3-well); border-radius:5px; overflow:hidden; }
.gcast-wave { position:absolute; inset:0; width:100%; height:100%; display:block; }
.gcast-wavlabel { position:absolute; inset:0; display:flex; align-items:flex-start;
  justify-content:center; padding-top:2px; font-size:10.5px; color:var(--h3-dim);
  pointer-events:none; text-shadow:0 1px 4px #000, 0 0 10px #000; letter-spacing:.02em; }
.gcast-span { position:absolute; top:0; bottom:0; background:var(--gc-wave);
  opacity:.13; pointer-events:none; }
.gcast-track.slidable { cursor:grab; }
.gcast-track.sliding { cursor:grabbing; }
.gcast-track.sliding .gcast-span { opacity:.24; }
.gcast-used { position:absolute; top:0; bottom:0; border-right:1px dashed var(--h3-dim); }
.gcast-head { position:absolute; top:0; bottom:0; width:1px; background:#fff;
  opacity:.85; display:none; pointer-events:none; }
.gcast-play { all:unset; pointer-events:auto; cursor:pointer; width:22px; height:22px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; flex:0 0 auto;
  border:1px solid var(--h3-line); color:var(--h3-dim); font-size:9px; }
.gcast-play:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcast-play:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcast-play.on { border-color:var(--h3-accent); color:var(--h3-accent); }
/* 11px was wider than a short span: at 22f on a 13s clip the selection is about
   20px, so the two handles covered it completely and there was no span left to
   grab -- every slide became a jump-to-pointer instead of a relative drag.
   Visible width halved to 6px. The grab area is padded back OUTWARD only, away
   from the selection, so the handle stays easy to hit without stealing the
   middle of the window back. */
.gcast-h { position:absolute; top:4px; width:6px; height:36px; margin-left:-3px; border-radius:3px;
  background:var(--gc-wave); cursor:ew-resize; box-shadow:0 0 0 1px #101010;
  touch-action:none; }
.gcast-h::after { content:""; position:absolute; top:-3px; bottom:-3px; }
.gcast-h.a::after { left:-5px; right:0; }
.gcast-h.b::after { left:0; right:-5px; }
.gcast-track { touch-action:none; }
.gcast-quick { display:flex; gap:4px; flex-wrap:wrap; }
.gcast-quick button { all:unset; pointer-events:auto; cursor:pointer; padding:2px 7px; border-radius:4px;
  border:1px solid var(--h3-line); font-family:ui-monospace,Consolas,monospace;
  font-size:10px; color:var(--h3-dim); }
.gcast-quick button:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcast-quick button:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcast-h:focus-visible { outline:2px solid #fff; outline-offset:1px; }
.gcast-times { display:flex; align-items:center; gap:7px; justify-content:space-between;
  font-family:ui-monospace,Consolas,monospace; font-size:10px; color:var(--h3-dim); }
.gcast-times > * { white-space:nowrap; }
.gcast-times span:last-child { text-align:right; }
.gcast-chk { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--h3-dim);
  cursor:pointer; user-select:none; }
.gcast-chk input { accent-color:var(--h3-accent); margin:0; }

/* prompt ------------------------------------------------------------ */
/* 定位父级：行号 gutter 与 @补全浮层都曾靠它定位。gutter 已随分镜条一起删掉，
   这条留着是因为 Qwen 编辑台与提示词编辑器仍在用 .gcast-pwrap 做定位父级。 */
.gcast-pwrap { position:relative; }
/* 文案来源标记：一行，替代整块提示词编辑区（词归文案台管） */
.gcast-psrc { font-size:11px; color:var(--h3-dim, #9a9a9a); padding:5px 8px;
  border:1px dashed #3a3a3a; border-radius:7px; line-height:1.5; flex:0 0 auto; }
/* 空的虚线框不再占位（20261010 用户定）：结果行/来源行没话说时就整个藏掉，
   别留一个空的虚线壳在轴下面。 */
.gcast-psrc:empty { display:none; }
/* 没接文案台：这是「这条链路不完整」，不是普通提示，给个暖色 */
.gcast-psrc.gcast-warnline { color:#e0a34a; border-color:#5a4526; }
.gcast-phead { display:flex; align-items:center; gap:8px; }
/* 外接提示词：只读镜像编辑器 + 标题徽章 */
.gcast-ed.gcast-ro { cursor:default; }
.gcast-ed.gcast-ro .tok { pointer-events:auto; }
.gcast-extbadge { font-size:9.5px; letter-spacing:.08em; color:var(--h3-accent, #7fb2ff);
  border:1px solid currentColor; border-radius:20px; padding:1px 8px; white-space:nowrap; }

.gcast-phead .spacer { margin-left:auto; }
.gcast-phead button { padding:2px 9px; font-size:10.5px; }
.gcast-chips { display:flex; flex-wrap:wrap; gap:5px; }
.gcast-chip { all:unset; pointer-events:auto; cursor:pointer; display:flex; align-items:center; gap:5px;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:20px;
  padding:2px 9px 2px 2px; font-family:ui-monospace,Consolas,monospace; font-size:10.5px;
  color:var(--h3-txt); transition:.13s; }
.gcast-chip:hover { border-color:var(--h3-accent); }
.gcast-chip.on { border-color:var(--h3-accent); background:var(--h3-accent-dim); }
.gcast-chip.on span:last-child { color:var(--h3-accent); }
/* 别名 chip：别名为主，规范 token 缩小作副标（素材认得出是谁） */
.gcast-chip .sub { opacity:.5; font-size:9.5px; letter-spacing:.2px; }
.gcast-chip.on .lbl, .gcast-chip.on .sub { color:var(--h3-accent); }
.gcast-chip img, .gcast-chip video { width:18px; height:18px; border-radius:50%; object-fit:cover; }
.gcast-chip .glyph { width:18px; height:18px; border-radius:50%; background:var(--h3-bg);
  display:flex; align-items:center; justify-content:center; font-size:9px; color:var(--h3-accent); }
.gcast textarea { background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:7px; padding:8px 9px; font-family:inherit; font-size:12px; line-height:1.5;
  /* resize:none, not vertical. The browser's own grip writes an INLINE height
     onto the element, which outranks the flex fill and cannot be undone by
     anything the layout does - the panel then stays taller than the node
     however small the node is dragged, and the two come unstuck. The prompt
     already grows with the node; that is the handle. */
  resize:none; width:100%; box-sizing:border-box; outline:none;
  overflow-y:auto; overscroll-behavior:contain; }
/* contenteditable prompt editor — a real <div> instead of a <textarea>, so a
   <d>…</d> spoken line can be styled inline and selection/caret are native.
   No overlay to drift out of alignment. */
.gcast-pwrap > .gcast-ed { position:relative; flex:1 1 auto; min-height:0;
  background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:7px; padding:8px 9px; font-family:inherit; font-size:12px; line-height:1.5;
  width:100%; box-sizing:border-box; outline:none; cursor:text;
  overflow-y:auto; overscroll-behavior:contain; overflow-wrap:break-word; word-break:break-word;
  white-space:pre-wrap; -webkit-user-modify:read-write-plaintext-only;
  scrollbar-width:none; }
.gcast-pwrap > .gcast-ed::-webkit-scrollbar { width:0; height:0; display:none; }
.gcast-pwrap > .gcast-ed:focus { outline:none; }
/* placeholder only while empty */
.gcast-pwrap > .gcast-ed:empty::before { content:attr(data-placeholder); color:var(--h3-dim); pointer-events:none; }
/* <d>…</d> spoken line highlighted in green */
.gcast-pwrap > .gcast-ed .d { background:#1f5c38; color:#d9f5e2; border-radius:3px;
  padding:0 1px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
/* @标签 高亮：有图用主色，空槽位用警示色 */
.gcast-pwrap > .gcast-ed .tok { border-radius:3px; padding:0 1px; cursor:default;
  box-decoration-break:clone; -webkit-box-decoration-break:clone; }
.gcast-pwrap > .gcast-ed .tok.has { background:var(--h3-accent-dim); color:var(--h3-accent); }
.gcast-pwrap > .gcast-ed .tok.miss { background:#5c262673; color:#ffb3b3;
  text-decoration:underline wavy #ff8a8a 1px; }
/* 悬停预览浮窗。与 .gcast-ac 同理挂在 body 上，取不到 .gcast 的局部变量，
   自带一份——否则 background/color 全部落空，浮窗会退化成无底色的裸图。 */
.gcast-toktip { --h3-bg:#191919; --h3-panel:#212121; --h3-raise:#2b2b2b;
  --h3-line:#3b3b3b; --h3-well:#131313; --h3-txt:#e3e3e3; --h3-dim:#979797;
  position:fixed; z-index:99999; display:none; background:var(--h3-panel);
  border:1px solid var(--h3-line); border-radius:6px; padding:4px; color:var(--h3-txt);
  font-size:11px; max-width:170px; box-shadow:0 4px 14px #0009; pointer-events:none; }
/* 保持素材原始比例：约束一个 150×220 的边界框，宽高都自动，等比缩到框内——
   竖图/竖视频不会被裁成 16:9。视频在 metadata 加载前按默认 300×150 量尺寸，
   加载完自然收到原始比例。 */
.gcast-toktip img, .gcast-toktip video { display:block; width:auto; height:auto;
  max-width:150px; max-height:220px; object-fit:contain;
  border-radius:4px; background:var(--h3-well); }
.gcast-toktip .cap, .gcast-toktip .glyph { display:block; margin-top:3px; text-align:center;
  color:var(--h3-dim); }
/* preset bar + dialogs ------------------------------------------------ */
.gcast-bar { display:flex; align-items:center; gap:6px; }
.gcast-bar .name { font-family:ui-monospace,Consolas,monospace; font-size:11px;
  color:var(--h3-txt); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcast-bar .name .dirty { color:var(--h3-dim); }
.gcast-bar .name .shot { color:#c9aeff; }
.gcast-bar .spacer { margin-left:auto; }
.gcast-btn { all:unset; pointer-events:auto; cursor:pointer; padding:4px 10px; border-radius:6px;
  border:1px solid var(--h3-line); background:var(--h3-panel);
  font-size:10px; color:var(--h3-txt); transition:.13s; }
/* 续写三件套（文件续写 / 潜空间续写 / 续写帧数）：它们同属一行，必须等高等宽
   才像一组控件。内边距收到 4px 6px、字号与上方的数字框统一 10px。 */
.gcast-btn.cont { padding:0 6px; height:20px; line-height:18px; box-sizing:border-box;
  display:inline-flex; align-items:center; font-size:10px; }
.gcast-btn:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcast-btn:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcast-btn.ghost { background:transparent; color:var(--h3-dim); }

/* shots -------------------------------------------------------------
   Violet on purpose: amber already means "something is wrong" in the
   prompt check and the presentation strip, and blue/green are taken by
   the two weight families. */
.gcast-btn.shots { background:#2a2340; border-color:#584a78; color:#c9aeff; }
.gcast-btn.shots:hover { border-color:#a97bff; color:#e4d6ff; }
.gcast-badge { font-family:ui-monospace,Consolas,monospace; font-size:9.5px;
  letter-spacing:.06em; padding:1px 6px; border-radius:10px; flex:0 0 auto;
  border:1px solid currentColor; }
.gcast-badge.ref { color:#58d1ff; }
.gcast-badge.fl { color:#59c14f; }

.gcast-modal {
  --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-accent:#58d1ff;
  position:fixed; inset:0; z-index:9000; background:#000a;
  display:flex; align-items:center; justify-content:center;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.gcast-sheet { background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:12px; box-shadow:0 20px 60px #000c; width:460px; max-width:92vw;
  max-height:76vh; display:flex; flex-direction:column; overflow:hidden;
  color:var(--h3-txt); font-size:12px; }
.gcast-sheet h3 { margin:0; padding:13px 15px 10px; font-size:12px; font-weight:600;
  letter-spacing:.04em; border-bottom:1px solid var(--h3-line); }
.gcast-sheet .body { padding:13px 15px; display:flex; flex-direction:column; gap:9px;
  overflow:auto; }
.gcast-sheet .foot { padding:11px 15px; border-top:1px solid var(--h3-line);
  display:flex; gap:7px; justify-content:flex-end; }
.gcast-sheet input[type="text"] { background:var(--h3-well); color:var(--h3-txt);
  border:1px solid var(--h3-line); border-radius:6px; padding:8px 10px;
  font-size:12px; font-family:inherit; outline:none; width:100%; box-sizing:border-box; }
.gcast-sheet input[type="text"]:focus { border-color:var(--h3-accent); }
.gcast-sheet .hint { color:var(--h3-dim); font-size:11px; line-height:1.45; }
/* 导出清单的一行。左边一道琥珀竖条：这些是"还没生效的改动"，跟 amber 在
   提示词检查里表示"有问题"是同一个语义，不必另造一种颜色。 */
.gcast-export-note { font-size:11px; line-height:1.5; padding:7px 9px;
  border-radius:6px; background:#ff9f4314; border-left:2px solid #ff9f43; }
/* 工程/档案冲突清单的一行：标题 + 两边各多少帧。样式对齐 gcast-row2，但这里
   是不可点的说明行（决定在底部按钮做）。 */
.gcast-sync-row { display:flex; align-items:center; gap:9px; padding:8px 9px;
  border:1px solid var(--h3-line); border-radius:8px; background:var(--h3-well); }
.gcast-sync-row .t { flex:1; min-width:0; }
.gcast-sync-row .t b { display:block; font-weight:600; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.gcast-sync-row .t span { color:var(--h3-dim); font-size:10.5px;
  font-family:ui-monospace,Consolas,monospace; }
.gcast-row2 { display:flex; align-items:center; gap:9px; padding:8px 9px;
  border:1px solid var(--h3-line); border-radius:8px; cursor:pointer; background:var(--h3-well); }
.gcast-row2:hover { border-color:var(--h3-accent); }
.gcast-row2 .t { flex:1; min-width:0; }
.gcast-row2 .t b { display:block; font-weight:600; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.gcast-row2 .t span { color:var(--h3-dim); font-size:10.5px;
  font-family:ui-monospace,Consolas,monospace; }
.gcast-row2 .del { all:unset; pointer-events:auto; cursor:pointer; color:var(--h3-dim); padding:2px 6px;
  border-radius:4px; }
.gcast-row2 .del:hover { color:#ff7a7a; background:#ff7a7a1a; }

.gcast-ac {
  --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797;
  --h3-accent:#58d1ff; --h3-accent-dim:#58d1ff26;
  --gc-wave:#59c14f;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  position:absolute; z-index:70; background:var(--h3-raise);
  border:1px solid var(--h3-line); border-radius:8px; padding:4px; min-width:210px;
  max-height:236px; overflow:auto; box-shadow:0 10px 28px #000b; }
.gcast-ac[data-mode="fl2va"] { --h3-accent:#59c14f; --h3-accent-dim:#59c14f26; }
.gcast-ac button { all:unset; box-sizing:border-box; cursor:pointer; display:flex; width:100%;
  align-items:center; gap:8px; padding:5px 7px; border-radius:5px;
  font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--h3-txt); }
.gcast-ac button[aria-selected="true"] { background:var(--h3-accent-dim); }
.gcast-ac img, .gcast-ac video { width:22px; height:22px; border-radius:50%; object-fit:cover; flex:0 0 auto; }
.gcast-ac .glyph { width:22px; height:22px; border-radius:50%; background:var(--h3-well);
  display:flex; align-items:center; justify-content:center; font-size:10px;
  color:var(--h3-accent); flex:0 0 auto; }
.gcast-ac .tag { margin-left:auto; color:var(--h3-dim); font-size:10px; }
.gcast-ac .fname { color:var(--h3-dim); font-size:9.5px; opacity:.75;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:120px; }
.gcast-ac .glyph.mark { background:var(--h3-accent-dim); color:var(--h3-accent); }
.gcast-ac .none { padding:6px 8px; color:var(--h3-dim); font-size:11px; font-family:inherit; }

.gcast-warn { color:#ffcc66; }

/* ================= 接缝组 + 卡底操作条（20261011 · 方案 B）================= */
/* seamCtl 撑满 field 控件区：承接帧 chips 的 margin-left:auto 才有空间靠右 */
/* E1：seamCtl 在上下文条里横向单行（接法 + 承接帧同一行） */
.gcast-ctx-seamgrp .gcast-seamctl { flex:1 1 auto; min-width:0; }
.gcast-seamctl { display:flex; flex-direction:row; align-items:center; gap:8px;
  min-width:0; flex:1 1 auto; }
.gcast-seamctl.is-flash { animation:gcast-seamflash 1.2s ease; }
@keyframes gcast-seamflash {
  0%,100% { box-shadow:none; }
  20% { box-shadow:0 0 0 2px var(--h3-accent), 0 0 16px var(--h3-accent-dim); } }
/* 20261108：「特殊接法」折叠区的 5 档接法按钮网格已整组删除，接缝面板只留
   「接法状态字 + 连播开关」一行。 */
/* 行尾「连播」开关：控制左接缝 cut（连播）/ unlink（断链），与接法解耦、
   独立可控（对齐方案 R1）。 */
.gcast-seam-link { all:unset; box-sizing:border-box; cursor:pointer;
  flex:0 0 auto; display:inline-flex; align-items:center; gap:6px;
  font-size:10px; color:var(--h3-dim); }
.gcast-seam-link .tr { position:relative; display:inline-block; flex:none;
  width:27px; height:16px; border-radius:9px; background:var(--h3-line);
  transition:background .15s; }
.gcast-seam-link .tr::after { content:""; position:absolute; top:1.5px; left:2px;
  width:13px; height:13px; border-radius:50%; background:#d8d8d8;
  transition:transform .15s; }
.gcast-seam-link.on { color:var(--h3-txt); }
.gcast-seam-link.on .tr { background:var(--h3-accent); }
.gcast-seam-link.on .tr::after { transform:translateX(11px); background:#04222c; }
/* 承接帧数行 */
.gcast-seam-win { display:flex; flex-direction:column; align-items:stretch; gap:4px; flex:none; }
.gcast-seam-winline { display:flex; align-items:center; gap:4px; flex-wrap:nowrap; }
.gcast-seam-win.is-dis { opacity:.4; pointer-events:none; }
.gcast-seam-lbl { font-size:10px; color:var(--h3-dim); flex:0 0 auto; }
.gcast-seam-step { all:unset; box-sizing:border-box; cursor:pointer;
  width:22px; flex:0 0 22px; height:20px; text-align:center; border:1px solid var(--h3-line);
  border-radius:5px; background:var(--h3-well); color:var(--h3-txt); font-size:12px; }
.gcast-seam-step:hover:not([disabled]) { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcast-seam-step[disabled] { opacity:.4; cursor:default; }
.gcast-seam-inp { width:auto; flex:1 1 auto; min-width:0; height:20px; box-sizing:border-box;
  background:var(--h3-well); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:5px; font-size:10.5px; text-align:center;
  font-family:ui-monospace,Consolas,monospace; appearance:textfield; }
.gcast-seam-inp::-webkit-outer-spin-button,
.gcast-seam-inp::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.gcast-seam-inp:focus { outline:none; border-color:var(--h3-accent); }
.gcast-seam-chips { display:flex; gap:4px; flex:none; width:100%; }
.gcast-seam-chip { all:unset; box-sizing:border-box; cursor:pointer;
  flex:1 1 0; height:20px; line-height:20px; text-align:center; padding:0;
  border:1px solid var(--h3-line); border-radius:5px;
  background:var(--h3-well); color:var(--h3-dim); font-size:10px;
  font-family:ui-monospace,Consolas,monospace; }
.gcast-seam-chip:hover:not([disabled]) { color:var(--h3-txt); border-color:var(--h3-dim); }
.gcast-seam-chip.is-on { color:var(--h3-accent); border-color:var(--h3-accent);
  background:var(--h3-accent-dim); }
.gcast-seam-chip[disabled] { opacity:.4; cursor:default; }

/* ============ E1：时间轴「当前段上下文条」============ */
.gcast-ctxbar { display:flex; align-items:center; gap:6px; flex-wrap:nowrap;
  width:100%; min-width:0; padding:4px 7px; margin:2px 0;
  /* 20261106 加了段级四按钮后，极窄节点上这一行宁可横向滚动也不把按钮挤没 ——
     本来搬上来的目的就是「段再小也看得见」。条内没有弹层，不会裁到接缝胶囊。 */
  overflow-x:auto; scrollbar-width:thin;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:8px; }
/* 段号读数（20261025 起是 <span> 不是 <select>）：长得像控件是为了跟右邻的
   帧数框对齐，但它不可点 —— cursor 必须说实话，否则鼠标一上去就成手型。 */
.gcast-ctx-segsel { all:unset; box-sizing:border-box; cursor:default; flex:none;
  display:inline-flex; align-items:center;
  height:22px; padding:0 8px; line-height:1; font-size:10.5px; color:var(--h3-txt);
  background:var(--h3-well); border:1px solid var(--h3-line); border-radius:6px; }
.gcast-ctx-vsep { flex:none; width:1px; align-self:stretch; background:var(--h3-line); }
.gcast-ctx-grp { display:flex; align-items:center; gap:5px; flex:none; min-width:0; }
.gcast-ctx-seamgrp { flex:1 1 auto; min-width:0; }
.gcast-ctx-lbl { flex:none; font-size:10px; color:var(--h3-dim); }
/* 数字框后面的「头 / 尾」单位字（20261020 重抽只留钉头钉尾两个框） */
.gcast-ctx-unit { flex:none; font-size:10px; color:var(--h3-dim); margin-right:4px; }
.gcast-ctx-grp input.gcast-pin-inp { flex:none; padding:0 4px; height:22px;
  font-size:11px; text-align:center; }
/* 原 .gcast-ctx-go（主按钮「⟳ 重抽这一段」的样式）20261020 随按钮删除。 */
/* 接缝单行：接法组 + 竖隔 + 承接帧 */
.gcast-seam-line { display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0; }
.gcast-seam-vsep { flex:none; width:1px; align-self:stretch; background:var(--h3-line); }
/* 承接帧 chips 弹层 */
.gcast-seam-chipop { position:relative; flex:none; }
.gcast-seam-chipbtn { all:unset; box-sizing:border-box; cursor:pointer;
  width:21px; height:20px; text-align:center; font-size:12px; line-height:18px;
  border:1px solid var(--h3-line); border-radius:5px;
  background:var(--h3-well); color:var(--h3-dim); }
.gcast-seam-chipbtn:hover:not([disabled]) { color:var(--h3-accent); border-color:var(--h3-accent); }
.gcast-seam-chipbtn[disabled] { opacity:.4; cursor:default; }
.gcast-seam-chipmenu { display:none; position:absolute; top:calc(100% + 5px); right:0;
  z-index:10001; padding:6px; background:#262626; border:1px solid var(--h3-line);
  border-radius:8px; box-shadow:0 14px 36px rgba(0,0,0,.5); }
.gcast-seam-chipmenu.is-open { display:block; }
.gcast-seam-chipmenu .gcast-seam-chips { flex-direction:column; gap:4px; }
.gcast-seam-chipmenu .gcast-seam-chip { flex:none; min-width:52px; text-align:center; padding:5px 8px; }

/* 原重抽「高级 ▾」按钮（.gcast-ctx-advbtn）20261020 随弹层一起删除，见下方注释。 */
/* 上下文条「一键取消接续」（20261015）：全片级动作，紧跟重抽组右侧。
   规格与重抽组同级（22px 高 / well 底），字色亮一档 —— 它是动作不是标签。 */
.gcast-ctx-act { all:unset; box-sizing:border-box; cursor:pointer; flex:none;
  display:inline-flex; align-items:center; gap:4px;
  height:22px; padding:0 9px; font-size:10.5px; color:var(--h3-txt);
  background:var(--h3-well); border:1px solid var(--h3-line); border-radius:6px; }
.gcast-ctx-act:hover:not([disabled]) { color:var(--h3-accent); border-color:var(--h3-accent); }
.gcast-ctx-act[disabled] { opacity:.45; cursor:default; }
.gcast-ctx-act .gcast-go-ic { font-size:11px; line-height:1; }

/* ---- 段级四动作（20261106 从段块悬浮工具条搬上上下文条）----
   原 .bzf-seg-actions 是 absolute 钉在段块正中间，段窄时被 overflow 裁掉。
   这排按钮横贯整行、永远有位置；规格与左邻「取消接续」同级（22px / well 底），
   语义色沿用段内那套：插段绿、删除红、跳过点亮用强调色。
   20261106 二次调整（用户定）：纯图标改成带名字的文字按钮
   （跳过 / 复制 / 插段 / 删除），宽度按内容撑开 —— 图标要猜，名字不用。
   四颗都是两个字，跳过态翻成「恢复」也是两字，切换时不会把后面的按钮推来推去；
   窄条由 .gcast-ctxbar 的 overflow-x:auto 兜底，不会被裁。 */
.gcast-ctx-segacts { display:flex; align-items:center; gap:4px; flex:0 0 auto; }
.gcast-ctx-segact { all:unset; box-sizing:border-box; cursor:pointer; flex:none;
  height:22px; min-width:38px; padding:0 8px;
  display:inline-flex; align-items:center; justify-content:center;
  font-size:10.5px; line-height:1; white-space:nowrap; color:var(--h3-txt);
  background:var(--h3-well); border:1px solid var(--h3-line); border-radius:6px; }
.gcast-ctx-segact:hover:not([disabled]) { color:var(--h3-accent);
  border-color:var(--h3-accent); }
.gcast-ctx-segact[disabled] { opacity:.4; cursor:default; }
.gcast-ctx-segact[data-act="add"]:hover:not([disabled]) { color:#7fd8a0;
  border-color:#7fd8a0; }
.gcast-ctx-segact[data-act="del"]:hover:not([disabled]) { color:#ff8a8a;
  border-color:#ff8a8a; }
.gcast-ctx-segact[data-act="skip"].on { color:var(--h3-accent);
  border-color:var(--h3-accent); }

/* 原「重抽 · 高级 ▾」弹层（.gcast-ctx-advmenu / .gcast-adv-row / .gcast-adv-lbl
   / .gcast-ctx-advbtn）20261020 随重抽档位一起删除 —— 唯一使用者就是那个弹层，
   里面装的精细 / 尾部 / 骨架锚点 / 钉头 / 钉尾已全部取消，只剩上下文条上的
   「保留 头 / 尾」两个框。需要时到 .bak_redosimp_20261020 找回。 */

/* 右键接缝胶囊弹出的「承接帧数」小卡（−框＋≡ 一行） */
/* 帧数卡锚定接缝 q：absolute 相对 q，落在标尺下方、横向居中；q 滚动/缩放/刷新
   它天然跟随（旧 fixed 一次性定位会跑偏）。 */
.gcast-seam-winmenu { position:absolute; top:17px; left:50%; z-index:10002;
  transform:translateX(-50%); width:196px; padding:8px; display:none;
  flex-direction:column; gap:6px;
  background:#262626; border:1px solid var(--h3-line); border-radius:10px;
  box-shadow:0 14px 36px rgba(0,0,0,.55); }
.gcast-seam-winmenu.is-open { display:flex; }
.gcast-seam-winmenu .gcast-seam-win { display:flex; flex-direction:column; gap:4px; min-width:0; }
/* 卡内分组小标题（带右侧延伸细线） */
.gcast-seam-grouplbl { font-size:9.5px; color:var(--h3-dim); letter-spacing:.3px;
  display:flex; align-items:center; gap:6px; }
.gcast-seam-grouplbl::after { content:""; flex:1; height:1px; background:var(--h3-line); }
/* 常驻「接法状态 + 连播」一行（20261020）：接法降级成状态字，唯一可点的是
   连播开关 —— 两个控件并排时会被读成"同一件事的两个选项"。 */
.gcast-seam-curline { display:flex; align-items:center; gap:6px; min-height:24px; }
.gcast-seam-cur { flex:1 1 auto; min-width:0; font-size:10px; color:var(--h3-txt);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcast-seam-curline .gcast-seam-link { flex:none; height:24px; gap:4px;
  justify-content:center; border:1px solid var(--h3-line); border-radius:6px;
  background:var(--h3-well); font-size:9.5px; padding:0 5px; }
.gcast-seam-curline .gcast-seam-link .tr { width:22px; height:13px; border-radius:7px; }
.gcast-seam-curline .gcast-seam-link .tr::after { width:10px; height:10px; top:1.5px; }
.gcast-seam-curline .gcast-seam-link.on .tr::after { transform:translateX(9px); }
/* 卡内分隔线 */
.gcast-seam-vsep { height:1px; background:var(--h3-line); border:0; margin:1px 0; }

/* 卡底固定操作条（E1 已停用，保留兼容）：计划摘要 + 主按钮 */
.gcast-seamact { display:flex; flex-direction:column; gap:6px;
  padding:7px 9px; border-top:1px solid var(--h3-line); background:var(--h3-raise); }
.gcast-plannote { display:none; min-width:0; }
.gcast-plannote.show { display:block; font-size:10px; color:var(--h3-dim);
  line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* 主按钮已收进时间轴上下文条（E1），改成与条内控件等高（22px）的紧凑样式 */
.gcast-go { all:unset; box-sizing:border-box; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:5px;
  height:22px; padding:0 14px; border-radius:6px;
  background:var(--h3-accent); color:#04222c; font-size:11px; font-weight:600; }
.gcast-go:hover:not([disabled]) { filter:brightness(1.08); }
.gcast-go:active { filter:brightness(.95); }
.gcast-go[disabled] { opacity:.5; cursor:default; }
.gcast-go-ic { font-size:12px; }

@media (prefers-reduced-motion: reduce) { .gcast * { transition:none !important; } }
`;
