import { FPS, RATIOS, REF_FPS_MAX, REF_FPS_MIN, REF_IMAGE_MAX, REF_MIN, REF_SCALE_MAX, REF_SCALE_MIN, REF_SCALE_STEP, REF_STEP, REF_VIDEO_MAX } from "./csglide_cast_core.js";
import { el, makeSelect } from "./csglide_ui_kit.js";

/* ============================================================
 * 设置卡 与 首尾帧卡
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

/* 钉头 / 钉尾只认 0 或 5+17k（H3 一个完整时间周期 17 帧），落在别的数上后端
 * 要向上取整 —— 填 23 实际钉 26。手输也吸附，框里显示的就是实际会钉的帧数。 */
function pinSnap(v) {
  const x = Math.max(0, Math.round(Number(v) || 0));
  if (x < 3) return 0;                       /* 1~2 帧没有意义，按不钉处理 */
  return Math.min(5 + 17 * Math.round((x - 5) / 17), 4085);
}

export function installSettings(ui) {
  /* ---- settings ---- */
  /* 紧凑表单（方案 B）：标签定宽左对齐 + 控件 + 读出右对齐，行间只用细分隔线。
     设置是「参数表」不是内容块，卡片层级让给续写来源这类真正的内容。 */
  const row = el("div", "gcast-row");
  /* 读出位靠 margin-left:auto 顶到行尾，不需要额外 spacer */
  const field = (label, ctl, read) => {
    const f = el("div", "gcast-field");
    f.append(el("span", "gcast-flabel", label), ctl);
    if (read) f.append(read);
    return f;
  };

  /* 原 segmented（把互斥 <select> 包成分段按钮）20261020 随重抽档位胶囊一起
     删除 —— 它是为「微调 / 重来」那条分段胶囊写的，唯一调用点没了。
     将来再要做分段控件，到 .bak_redosimp_20261020 找回。 */

  const canvasCtl = el("div", "gcast-ctl");
  const selRatio = makeSelect(ui.node, "宽高比");
  selRatio.setOptions(RATIOS.map((r) => ({ label: r.label, value: r.label, note: `${r.w} x ${r.h}` }))
    .concat([{ label: "自定义", value: "custom" }]));
  const selSize = makeSelect(ui.node, "该比例下的画布尺寸");
  const inW = el("input"); inW.type = "number"; inW.step = 32; inW.min = 32;
  const inH = el("input"); inH.type = "number"; inH.step = 32; inH.min = 32;
  const canvasNote = el("div", "gcast-read");
  canvasCtl.append(selRatio.el, selSize.el, inW, el("span", "gcap dim-x", "\u00d7"), inH);

  const lenCtl = el("div", "gcast-ctl");
  /* 时长预设下拉已删除：滑块粗调 + 秒框精确已够用，下拉多余。 */
  /* 自定义输入以「秒」为单位（曾是帧数）：帧数只有落在 17k+5 网格上才合法，
     用户想的却是「我要 12 秒」。写入统一经 nearestFrames 吸附，回显只给整数秒
     ——精确帧数在右侧读出位、精确秒数在 title 里，不劳用户自己算网格。 */
  const inLen = el("input"); inLen.type = "number";
  /* step="any"：不要让浏览器自己算小数步长。它的网格是 min + k*step，而 min 与
     step 都是四舍五入后的秒（0.21 / 0.7083），旧回显还带两位小数——三张网格互不
     重合。按一次跳到最近的浏览器格点、回写后又被吸附回同样的帧数，按钮看起来
     毫无反应（141 帧卡在 5.88s，升一次到 158 就再也上不去）。现在浏览器只负责
     ±1 秒，吸附交给 nearestFrames，全程只有一张网格。
     min 只声明「秒数非负」而不是 5 帧下限：只要存在 min，浏览器一旦算出「当前值
     − 1 低于 min」就整个拒绝步进（既不夹也不触发），22 帧（0.92s）按 ↓ 会静默无
     反应。帧网格的下限统一由 nearestFrames 裁决，浏览器不插手。 */
  inLen.step = "any"; inLen.min = 0;
  inLen.title = "自定义时长（秒）。会吸附到 H3 的 17k+5 帧网格，实际帧数见右侧读出。";
  const lenNote = el("div", "gcast-read");
  /* 时长一行：滑块（弹性占宽、停 5+17k 网格）→ 秒数字框；同一真值 st.length。 */
  const lenRange = el("input", "gcast-range");
  lenRange.type = "range"; lenRange.min = "5"; lenRange.max = "719"; lenRange.step = "17";
  lenRange.title = "拖动粗调片段时长（吸附到帧网格）；精确秒数用右侧输入框。";
  lenCtl.append(lenRange, inLen, el("span", "gcap", "秒"));

  /* 按内容长度自动撑宽：CSS 里的 42px 只放得下 4~5 个字符，「1888」「4096」
     一变长就被浏览器静默截断，用户既看不到自己填了什么、也改不回去。
     数字字号 10px 下每字符约 6px，两侧各留 9px 内边距。
     flex:0 1 auto 里的 flex-shrink=1 会在行内空间不足时把宽度压回去（这正是
     上一版设了 style.width 仍被截断的原因），故这里同时钉死 flex-basis 与
     flex-grow/shrink，让浏览器无法回压。 */
  /* 数字框统一固定宽度（不再按字符数动态变宽 —— 那是"框大框小"的来源）：
     10px 字体下 4 位数（1344）约 26px，52px 足够且最整齐；flex 钉死防压缩。 */
  const autoWidth = (inp) => {
    inp.style.flex = "0 0 52px";
    inp.style.width = "52px";
  };

  const refCtl = el("div", "gcast-ctl");
  const selRef = makeSelect(ui.node, "图片参考尺寸档位");
  selRef.setOptions([
    { label: "跟随画布", value: "match", note: "长边跟画布" },
    { label: "原图", value: "raw", note: "原样发 · 短边≤2048" },
    { label: "自定义", value: "custom", note: "指定长边" },
  ]);
  const inRef = el("input"); inRef.type = "number"; inRef.step = REF_STEP; inRef.min = REF_MIN; inRef.max = REF_IMAGE_MAX;
  inRef.title = "图片参考的最长边（px）：等比缩放到长边不超过该值；比它小的图片原样编码，不放大。";
  /* 放大重绘（二采/三采）条件的参考档位倍数：属于「参考素材怎么编码」的参数，
     所以跟参考尺寸同处一行。1 = 直接用上面的档位，不额外编码。 */
  const inScale = el("input");
  inScale.type = "number"; inScale.step = REF_SCALE_STEP; inScale.min = REF_SCALE_MIN; inScale.max = REF_SCALE_MAX;
  inScale.title = "放大重绘条件的参考档位倍数：1 = 跟随左侧档位、不额外编码；"
    + "1.5/2 = 参考素材按更大档位重新编码后交给二采与三采，细节更多。"
    + "倍数越高越慢——每个档位都要重跑一遍视觉编码器。";
  const refNote = el("div", "gcast-read");
  /* 「放大倍数」移到高级区：它属于"调过一次就再也不动"的参数，摆在这一行会
     挤掉本行真正常用内容的空间（见下面的 gcast-adv）。 */
  refCtl.append(selRef.el, inRef);

  const vrefCtl = el("div", "gcast-ctl");
  const selVRef = makeSelect(ui.node, "视频参考尺寸档位");
  selVRef.setOptions([
    { label: "跟随画布", value: "match", note: "长边跟画布" },
    { label: "原图", value: "raw", note: "官方 · 短边768" },
    { label: "自定义", value: "custom", note: "指定长边" },
  ]);
  const inVRef = el("input"); inVRef.type = "number"; inVRef.step = REF_STEP; inVRef.min = REF_MIN; inVRef.max = REF_VIDEO_MAX;
  inVRef.title = "视频参考的最长边（px）：等比缩放到长边不超过该值；比它小的视频原样编码，不放大。";
  const vrefNote = el("div", "gcast-read");
  const fpsRef = el("input"); fpsRef.type = "number"; fpsRef.step = 1; fpsRef.min = REF_FPS_MIN; fpsRef.max = REF_FPS_MAX;
  fpsRef.title = "参考视频采样帧率：24=不抽帧；往低调（如 12/8）在时长不变时减少参考帧数、节省显存，但会降低参考锚定精度。";
  const fpsNote = el("span", "gcast-read");
  /* 视频参考一行并进「抽帧帧率」：这两项同属视频参考的采样设置，
     原来单独占一行把卡片撑高、又和上行控件重复了「视频参考」的语义。 */
  /* 同上：「抽帧帧率」移入高级区。 */
  vrefCtl.append(selVRef.el, inVRef);

  /* 绑定必须放在上面所有输入框都声明完之后：const 声明前引用会抛 TDZ
     （Cannot access before initialization），整个面板连带工作流加载一起中止。 */
  for (const inp of [inW, inH, inLen, inRef, inScale, inVRef, fpsRef]) {
    inp.addEventListener("input", () => { autoWidth(inp); });
  }

  const fRef = field("图片参考", refCtl, refNote);
  const fVRef = field("视频参考", vrefCtl, vrefNote);
  /* 首尾帧模式下这两行不生效（fl2va 没有 @图片N/@视频N），view 里会灰掉它们；
     灰掉的同时要把 label 换成带标注的文案，否则用户只看到"点了没反应"。
     label 是 field() 里的第一个子元素，取出来存住，免得 view 每帧 querySelector。 */
  const refLabel = fRef.firstElementChild, vrefLabel = fVRef.firstElementChild;


  /* 「整片潜空间」口没有面板开关（20261102 用户定）：改成轴头「🧬 推送整片潜空间」
     按钮的一次性动作 —— 点一下才开、排完立刻关。理由与 push_whole 完全一致：
     它不是"调一次就再也不动"的工程级设置，而是"所有段都备好了，现在发"的
     手动推送；留在面板上就必然出现"勾着忘了取消 / 忘了勾就报错"的两种翻车。
     控件连同 chkFilmLat / filmLatCtl / fFilmLat 三个导出一起删除。
     开关本身不在 ui.st 里：按钮在提交前直接把它写进"这一笔提交副本"的 h3_data
     （后端 cfg 仍按 submit 读这个键，键名不变）。 */

  /* ---- 高级区（默认折叠）----
     放大重绘倍数 / 抽帧帧率都是"调过一次就再也不动"的参数。它们和
     画布、时长等权重地排在一起时，既抢走新手的注意力，也让老手每次都要在五
     行里找画布。折叠起来，明面只留每段都要动的三行。 */
  const advScaleCtl = el("div", "gcast-ctl");
  advScaleCtl.append(el("span", "gcap", "参考档位倍数"), inScale);
  const advScaleNote = el("div", "gcast-read");
  const fAdvScale = field("放大重绘", advScaleCtl, advScaleNote);

  const advFpsCtl = el("div", "gcast-ctl");
  advFpsCtl.append(fpsRef, el("span", "gcap", "fps"), fpsNote);
  const fAdvFps = field("抽帧", advFpsCtl);

  /* 原「高级」折叠（details + summary「高级　语义桥 · 放大重绘」）20261020 改为
     **常驻展开并去掉标题行**（用户定）—— 那行对已经熟的用户是纯噪音，还压着
     下面三项；内容本来就只有三项、不长，没必要收。
     要恢复折叠：到 csglide_cast_settings.js.bak_advopen_20261020 找回。 */
  const adv = el("div", "gcast-adv");
  const advBd = el("div", "adv-bd");
  advBd.append(fAdvScale, fAdvFps);
  adv.append(advBd);

  /* 「重抽」只剩**钉头 / 钉尾**两个帧数框（20261020 用户定）。
     以前这里摆着「改动幅度」档位（微调 / 重来）+ 「高级 ▾」弹层里的精细 /
     尾部 / 骨架锚点 / 钉头 / 钉尾 —— 6 个控件管同一件事，而实际只用得上
     「整段重抽」和「只抽中间」两种，本质是**头尾留不留**这一个变量。
     所以帧数填 0 就是整段重抽、填帧数就是只抽中间，档位概念纯属多余。

     20261026：redo_mode / redo_anchor 与骨架钉帧已**整体删除**，后端只读
     pin_head / pin_tail —— 填了就生效，不再需要"顺手把档位改回重画"这条
     补丁（那条补丁正是老工程里骨架被幽灵复活的路径之一）。 */
  const mkPinInp = (key, tip) => {
    const inp = el("input", "gcast-btn gcast-pin-inp");
    inp.type = "number"; inp.style.width = "56px";
    /* 与「🎬 H3 终极放大参数 → 重叠帧数」同一套：min=5 + step=17，浏览器原生
       箭头就是 5 → 22 → 39 → 56，全部落在 5+17k 上，不自己维护档位表。 */
    inp.min = "5"; inp.max = "1000"; inp.step = "17";
    inp.value = String(pinSnap(ui.st[key]));
    inp.title = tip + "\n上下箭头按档位跳：0 / 5 / 22 / 39 / 56 …（5+17k）";
    /* 0（不钉）不在 5+17k 上，浏览器给不出这一档 —— 在 5 上再按下即归零。 */
    inp.onkeydown = (e) => {
      if (e.key === "ArrowDown" && Math.round(Number(inp.value) || 0) <= 5) {
        e.preventDefault();
        inp.value = "0";
        inp.onchange();
      }
    };
    inp.onchange = () => {
      ui.st[key] = pinSnap(inp.value);
      inp.value = String(ui.st[key]);
      ui.commit();
      /* 立刻落进本段的 shot.state：commit 只写 h3_data 控件，shot.state 要等
         stash 才更新 —— 不 stash，渲染循环 switchTo 到别的段再切回来就会把
         你刚填的帧数冲掉（20261013「点渲染后重来变微调」的老坑）。 */
      if (ui.stash) ui.stash();
      /* 顺手把存档节点的「另存为版本」勾上（20261020）：改完帧数直接点**画布
         运行**是很自然的用法，而那条路不走 renderAll —— 不在这里勾，重抽就
         会直接覆盖当前版本、旧版没了。「重抽永远可反悔」是 20261010 定下的
         （那时删掉了勾选框，改成渲染前无条件勾上），这里补上第二条路。 */
      if (ui.setSaveNewTake) ui.setSaveNewTake(true);
    };
    return inp;
  };
  const inpPinHead = mkPinInp("pin_head",
    "重抽时开头留几帧原样不动。\n"
    + "0 = 从第一帧就开始重抽。两个框都是 0 = 整段从零重拍。");
  const inpPinTail = mkPinInp("pin_tail",
    "重抽时结尾留几帧原样不动。\n"
    + "0 = 一直重抽到最后一帧（⚠ 后面各段要跟着重跑）；\n"
    + "填了帧数 = 只抽中间，后面各段不用重跑。\n"
    + "注意：填得比「下一段的承接窗口」小会被自动抬上去 —— 留少了下一段照样"
    + "接不上，那几帧等于白留。");
  /* 钉头 / 钉尾直接进上下文条 redoGrp（见下方），不再藏在任何弹层里。 */

  /* 原 paintRedoLink（按档位置灰锚点 / 钉头钉尾）20261020 随档位一起删除：
     现在钉头 / 钉尾是唯一旋钮、任何时候都生效，没有"本档不适用"的控件了。
     view.js 里那句 `if (ui.paintRedoLink) ui.paintRedoLink()` 已同步移除。 */

  /* 接缝（链接/断链、承接帧数）统一在时间轴两段交界的「接缝胶囊」里操作，
     右侧不再放重复入口（20261010 用户定）。 */

  /* 「存为新版本」勾选框已删（20261010 用户定）：重抽**默认总是另存**新版本
     （渲染前由 run.js 无条件勾上存档节点的「另存为版本」），旧版本原样保留，
     重抽变成可反悔的尝试，不再有"覆盖了就回不去"。 */

  /* 重抽只剩「保留头 / 尾」两个数字框，直接进时间轴上下文条 redoGrp（见下），
     右卡不再建任何重抽 field（20261020）。 */

  /* 字段分组：规格（画布/时长）→ 参考（图/视频）→ 重抽 → 接缝。
     组间细分隔线 + 留白把"先定规格、再挂参考、然后管重抽、最后定接缝"的
     顺序立起来。重抽 20261020 只剩头尾帧数两个框，已移出本卡（进上下文条）。
     接缝（接法 / 承接帧数 / 断链）20261011 从右键与时间轴浮层
     收进本卡，成为唯一入口；内容由 sync.js 的 refreshSeamPanel 填充。 */
  const grpSpec = el("div", "gcast-fgroup");
  grpSpec.append(field("画布", canvasCtl, canvasNote),
                 field("时长", lenCtl, lenNote));
  const grpRef = el("div", "gcast-fgroup");
  grpRef.append(fRef, fVRef);
  /* E1：重抽档 / 接缝移出本卡（改到时间轴上下文条），卡内只留规格、参考 */
  row.append(grpSpec, grpRef);

  /* 设置卡：常用行在明面，高级项折在下面。 */
  const setCard = el("div", "gcast-card");
  const setHd = el("div", "hd");
  /* 卡片标题 = 当前编辑段的身份（手动命名显示名字，默认显示「第 N 段」）。
     以前写死「这一段」，切了段也看不出卡上改的是谁 —— 用户以为点了轴上的
     第 2 段卡就跟着第 2 段走，实际改没改对段完全无从判断（20261013）。
     真值由视图层 renderInner 按 p.idx / st.chain.clip 每次刷新（ui.segTitle）。 */
  const segTitle = el("span", null, "这一段");
  setHd.append(segTitle,
               el("span", "sub", "规格 · 参考"));
  const setBd = el("div", "bd");
  setBd.append(row);
  setCard.append(setHd, setBd, adv);

  /* ============ E1：时间轴「当前段上下文条」========================
     段号 + 重抽（保留头 / 尾帧数）+ 取消接续，横贯
     时间轴宽度、单行；从右卡移出以瘦身。DOM 在 monitor.js 挂进 lanesWrap。 */
  /* 当前段下标 = 唯一真值。工程里 `p.shots[j]` 就是这一段，不需要等后端
     把 shot.clip 登记回来 —— 新建工程时登记是异步的，用 clip 反查会把
     「明明有段」判成「没登记」。段号读数、按钮状态、点击落点三处共用。 */
  const curSegIndex = () => {
    const pp = ui.proj();
    const n = (pp.shots || []).length;
    return n ? Math.min(n - 1, Math.max(0, pp.idx | 0)) : -1;
  };

  const ctxBar = el("div", "gcast-ctxbar");

  /* 段号指示（20261025 用户定）：只显示"第几段"，不再是下拉选择器 ——
     切段只走时间轴段块那一条路。同一个动作留两个入口，两处状态迟早会打架，
     而这里本来也只是个"现在在哪一段"的读数。 */
  const segSel = el("span", "gcast-ctx-segsel");
  const fillSegSel = () => {
    const j = curSegIndex();
    segSel.textContent = j >= 0 ? `第 ${j + 1} 段` : "第 — 段";
    /* 段号读数一变，右侧那排段级按钮的「作用于第几段 / 跳过没跳过 / 能不能点」
       也得跟着变 —— 两者是同一件事，挂在这里就不会出现段号换了按钮还指着上一段。 */
    try { paintSegActBar(); } catch (_) { /* 本函数还没跑到按钮定义那段 */ }
  };

  /* 重抽组：钉头 / 钉尾两个帧数框。改动幅度档位与「高级 ▾」弹层 20261020
     已整体删除 —— 头尾留多少帧就是唯一的重抽力度旋钮，藏进弹层反而没人用。 */
  const redoGrp = el("div", "gcast-ctx-grp");
  redoGrp.append(el("span", "gcast-ctx-lbl", "保留"),
                 inpPinHead, el("span", "gcast-ctx-unit", "头"),
                 inpPinTail, el("span", "gcast-ctx-unit", "尾"));
  redoGrp.title = "重抽这一段时，头尾各留几帧原样不动：\n"
    + "· 两个都是 0 = 整段从零重拍（⚠ 后面各段要跟着重跑）；\n"
    + "· 填了帧数 = 只抽中间，头尾沿用旧版（后面各段不用重跑）。";

  /* 方案A（20261011）：接缝组已移除 —— 接法 / 连播 / 承接帧全部在时间轴接缝
     胶囊右键卡里（ui.openSeamWindow），上下文条不再占这一组。 */

  /* 「⟳ 重抽这一段」按钮 20261020 删除（用户定：只想留画布上那一个运行按钮）。
     它原本是导演台自己的运行入口，顺带做了另存新版本 / 快照 / 落档 / 冲突对账
     这四件事 —— 现在全搬到 h3_data widget 的 beforeQueued 钩子上（见
     csglide_cast.js），ComfyUI 在生成 prompt 前会自动调用，无论点哪个运行按钮
     都会做完。renderAll() 本身保留：时间轴「全部渲染」批量跑多段还在用它。 */

  /* 「一键取消接续」（20261015）：全片每一段一起与上一段断开 / 一起恢复。
     这是**全片级**动作（不是"这一段"的）。点击行为与状态刷新在 sync.js ——
     那里才有 applyTransition / proj 的上下文。 */
  const btnUnlinkAll = el("button", "gcast-ctx-act");
  btnUnlinkAll.type = "button";
  btnUnlinkAll.append(el("span", "gcast-go-ic", "⊘"),
                      el("span", "gcast-go-tx", "取消接续"));

  /* ---- 段级四动作：从段块悬浮工具条搬到本条（20261106）----
     段块里那排 .bzf-seg-actions 是 absolute 钉在块体正中间的，段一窄就被
     overflow 裁掉 —— 用户实测「每段太小会导致这些按钮看不到」。上下文条
     横贯整行、永远有位置，左侧「第 N 段」读数又正好说明按钮作用于谁。
     语义没变：原来也只有**选中段**才淡入那排按钮，选中的就是当前段。

     业务逻辑一律不在这里重写：monitor.js 把原来传给时间轴的 onSegAction
     抽成 ui.segAction，这里与共享组件共用同一份实现（按 clip id 找工程下标）。
     导演台同时给 createFilmMonitor 传 hideInlineSegActions，段内那组不再创建，
     于是全片只有这一处入口，不会出现两套按钮、两套状态。 */
  /* 20261106 用户定：去掉纯图标，改成带名字的文字按钮 —— 图标要靠猜，
     名字一眼就知道会动哪一段、做什么。四个都是两个字，宽度齐整；
     「跳过」是唯一有状态的，点过之后翻成「恢复」（仍两字，不撑宽、不跳动）。
     共享组件 csglide_film.js 里那套段内图标按钮保留原样，只服务其他宿主。 */
  const segActDefs = [
    { k: "skip", t: "跳过", title: "跳过这一段（渲染时越过，保留配置）" },
    { k: "copy", t: "复制", title: "完整复制这一段到末尾（提示词/参考图/画布/时长/全部参数照抄）" },
    { k: "add", t: "插段", title: "在此后插一段（新段承接这一段继续演）" },
    { k: "del", t: "删除", title: "删除这一段（连块、档案与磁盘成片一起删，不可恢复）" },
  ];
  /* 当前段一律走上面那个 curSegIndex()，不再按 clip 反查。 */
  const segActs = el("div", "gcast-ctx-segacts");
  const segActBtns = {};
  for (const a of segActDefs) {
    const b = el("button", "gcast-ctx-segact");
    b.type = "button";
    b.textContent = a.t;
    b.dataset.act = a.k;
    b.title = a.title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.disabled) return;
      const j = curSegIndex();
      const cid = ((ui.proj().shots || [])[j] || {}).clip || "";
      void ui.segAction?.(a.k, { index: j, id: cid });
    });
    segActBtns[a.k] = b;
    segActs.append(b);
  }

  /** 四颗按钮恒可用：段在工程里就够，不需要等后端把 clip 登记回来。
      「跳过 ↔ 恢复」文字与点亮态、title 上的「作用于第 N 段」仍随当前段刷。
      挂在通用重绘入口 paintSegTools 与段号读数 fillSegSel 上。 */
  function paintSegActBar() {
    const shots = ui.proj().shots || [];
    const j = curSegIndex();
    const sh = shots[j];
    for (const a of segActDefs) {
      const b = segActBtns[a.k];
      if (!b) continue;
      b.disabled = false;
      b.title = j >= 0
        ? `${a.title}　·　作用于当前「第 ${j + 1} 段」`
        : `${a.title}　·　当前还没有分段`;
    }
    const sb = segActBtns.skip;
    if (sb) {
      const sk = !!(sh && sh.off);
      sb.textContent = sk ? "恢复" : "跳过";
      sb.classList.toggle("on", sk);
      if (j >= 0) {
        sb.title = (sk ? "恢复参与渲染（当前被跳过）" : "跳过这一段（渲染时越过，保留配置）")
          + `　·　作用于当前「第 ${j + 1} 段」`;
      }
    }
  }

  /* 上下文条：段号 + 重抽范围 + 取消接续 + 段级四动作（渲染走画布上的运行按钮）。
     「取消接续」是全片级动作，与后面的段级动作之间留一条细分隔线分组。 */
  ctxBar.append(segSel, el("span", "gcast-ctx-vsep"),
                redoGrp, btnUnlinkAll,
                el("span", "gcast-ctx-vsep"), segActs);

  /* ---- slot areas ----
     首尾帧做成卡片而不是裸的一行标签：它受指挥条上的模式开关控制，卡片头能
     当场说清"现在是什么模式、这两个槽位生不生效"。非首尾帧模式时卡收起内容
     但保留卡头，用户始终知道有这两个槽位、为什么不生效。 */
  const flWrap = el("div", "gcast-card");
  const flHd = el("div", "hd");
  flHd.append(el("span", null, "首尾关键帧"));
  const flSub = el("span", "sub", "");
  flHd.append(flSub);
  const flBd = el("div", "bd");
  const flGrid = el("div", "gcast-grid fl");
  flBd.append(flGrid);
  flWrap.append(flHd, flBd);

  /* 右栏：设置卡在上、首尾帧卡在下，两卡共用一条定宽；监视器吃满余宽。 */
  const rightCol = el("div", "gcast-col");
  rightCol.append(setCard, flWrap);

  /* 参考图/视频/音频三模块已外迁至「🗂️ H3 媒体架」节点（refs 端口接线）。
     续写来源也已由监视器里的分段轴承担（段与段之间的接续在那里预览与切换），
     所以面板不再有独立的续写来源卡 —— 只保留左监视器 + 右设置卡的双栏布局。 */
  /* 双栏：监视器在左占满余宽，设置卡（.gcast-row 自带定宽）在右，v7 式布局。 */
  const studioRow = el("div", "gcast-studio");


  /* 20261026：重抽档位（redo_mode/redo_anchor）与骨架钉帧已整体删除，
     后端不再读这些字段。老工程里若还存着旧值，在这里一次性清掉 ——
     留在 state 里只会在存档里越积越多，没有任何代码会用它。 */
  if (ui.st && ("redo_mode" in ui.st || "redo_anchor" in ui.st)) {
    delete ui.st.redo_mode;
    delete ui.st.redo_anchor;
    ui.commit();
    if (ui.stash) ui.stash();
  }

  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { row, field, canvasCtl, selRatio, selSize, inW, inH, canvasNote, lenCtl, inLen, lenNote, lenRange, autoWidth, refCtl, selRef, inRef, inScale, refNote, refLabel, vrefCtl, selVRef, inVRef, vrefNote, vrefLabel, fpsRef, fpsNote, fRef, fVRef, adv, advBd, advScaleNote, inpPinHead, inpPinTail, ctxBar, segSel, fillSegSel, btnUnlinkAll,
    segActs, segActBtns, paintSegActBar, setCard, setHd, setBd, segTitle, flWrap, flHd, flSub, flBd, flGrid, rightCol, studioRow });
}
