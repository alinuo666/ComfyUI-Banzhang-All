/* ============================================================
 * H3 媒体架 — 面板条
 * ------------------------------------------------------------
 * 一行装四样：本段指示、按提示词排序、帧率/音频输出编号两颗胶囊、清空钮。
 * 帧率与音频编号是节点级设置，随 rack_data 一起序列化（commit 序列化整个 st）。

 * 「音频输出编号」的自愈也在这里——它认的是那个输入框，挪不出去。
 * ============================================================ */
import { el, MAX_SLOTS } from "./csglide_rack_core.js";

export function installBar(ui) {
  const st = ui.st;

  /* ---- 一键清空：移除媒体架里的全部素材（图片/视频/音频）。只清素材，
     不碰设置类状态；与导演台原「一键清空」同一语义：一次点击即生效，不弹确认。
     小圆形红叉钮，固定在面板右下角。 ---- */
  const bClear = el("button", "gmr-clear");
  bClear.setAttribute("aria-label", "清空所有素材");
  bClear.title = "清空所有素材：图片、视频、音频";
  bClear.onclick = () => {
    st.slots.images = [];
    st.slots.videos = [];
    st.slots.audios = [];
    ui.rebuildMedia();
    ui.renderImages(); ui.commit();
  };

  /* ---- 按提示词排序：把素材搬到提示词写定的编号上（实现见 csglide_rack_sort.js） ---- */
  const bSort = el("button", "gmr-mini", "按提示词排序");
  bSort.title = "按导演台提示词里写死的编号，重排本架素材\n"
    + "· 认的是提示词里显式写的 @图片N / @视频N / @音频N，以及它左右最近的那个人名/物名\n"
    + "· 命中靠架上现有的别名与文件名，提示词里写了个架上没有的名字 → 不动那一格\n"
    + "· 多个节点（比如分段）同时接本架时按画布顺序取，编号被先写的那个占住\n"
    + "例：<Subject 1> 为 @图片3 中的陈九一 → 把别名叫陈九一的那张图搬到第 3 格\n"
    + "顺序 = 编号，所以 改完导演台提示词，来这里点一下就对齐了。";
  bSort.onclick = () => ui.sortByPrompt?.();

  /* ---- 排全部段：一次跑完，每段用它自己的提示词（实现见 sortAllSegs） ---- */
  const bSortAll = el("button", "gmr-mini", "全部段");
  /* bar 是单行 flex，gmr-mini 自带 margin-left:auto（把按钮推到最右）。
     两个都带 auto 会被平分，这里把第二颗的 auto 收掉，两颗才挨在一起。 */
  bSortAll.style.marginLeft = "6px";
  /* 段数不写死：末尾那句按**真实**分段数拼 —— 写死成「8 段」时，只有 1 段的工程
     上这句就成了假话（20261022）。装 bar 时还没认到段，先按「全片各段」出，
     认到段之后由 syncSegChip 按实际段数重写。 */
  ui.sortAllTitle = (n) => "把时间轴上每一段，都按**它自己那段**的提示词重排素材\n"
    + "· 素材清单是每段一份独立副本，所以每段各排各的，互不影响\n"
    + "· 读的是文案台里对应那段的文本，不用手动切段\n"
    + "· 当前段排完直接落库，其余段按段身份各自落库\n"
    + "适合：" + (n ? `全片 ${n} 段` : "全片各段")
    + "共用同一批素材、但每段提示词里的 @图片N 编号不同";
  bSortAll.title = ui.sortAllTitle(0);
  bSortAll.onclick = () => ui.sortAllSegs?.();

  /* 胶囊小控件：标签内嵌，空态不占视觉，聚焦才描边。 */
  const mkNum = (label, title, onchg) => {
    const chip = el("label", "gmr-chip");
    chip.title = title;
    const inp = el("input", "gmr-num");
    inp.type = "number";
    inp.onchange = onchg;
    chip.append(el("span", "gmr-chiplab", label), inp);
    return { chip, inp };
  };
  const fpsCtl = mkNum("帧率",
    "参考视频自定帧率：留空/0 = 跟随导演台面板的抽帧帧率；填数（如 24）= 该媒体架所有参考视频按此帧率抽帧（导演台与素材取帧都生效）",
    () => {
      const v = parseFloat(fpsCtl.inp.value);
      st.fps = v > 0 ? v : 0;
      if (!st.fps) fpsCtl.inp.value = "";
      ui.commit();
    });
  fpsCtl.inp.min = "0"; fpsCtl.inp.max = "60"; fpsCtl.inp.step = "0.1";

  const audCtl = mkNum("音频",
    "原始音频输出编号：输出第 N 个视频槽位（@视频N）的原始音轨（按槽位起止修剪），供外部视频合成使用。0 = 不输出",
    () => {
      const v = parseInt(audCtl.inp.value, 10);
      st.audio_out = v > 0 ? v : 0;
      if (!st.audio_out) audCtl.inp.value = "";
      /* 手动改编号 = 用户重新指定素材，同步自愈基准，否则 commit 里的
         fixAudioOut 会把这次修改当成"槽位被换"改回去 */
      setAudioBaseline(st.audio_out > 0 ? st.slots.videos[st.audio_out - 1] : null);
      ui.commit();
    });
  audCtl.inp.min = "0"; audCtl.inp.max = String(MAX_SLOTS); audCtl.inp.step = "1";
  const fpsIn = fpsCtl.inp, audIn = audCtl.inp;   /* load() 恢复时沿用这两个引用 */

  /* 本段指示：让用户一眼看出「架子上的素材属于哪一段」——看不见的话，
     切段后素材悄悄换了一批，用户会以为素材丢了。 */
  const segChip = el("span", "gmr-segchip", "全片共用");
  /* 段数不写死：这里只是 installBar 时的初值，认到段之后由 syncSegChip 按真实
     分段数重写（写死成「8 段」，1 段的工程上那句就是假话，20261022）。 */
  segChip.title = "素材按分段记忆：切到哪一段，架子上就是哪一段的素材\n"
    + "点一下可切到「全片共用」：全片共用同一副架面，加一张图所有分镜都有";
  /* 点芯片在「全片共用 / 按段记忆」之间切换（20261022）。
     切成共用会覆盖各段的独立副本 → 二次确认：先变待确认态，再点一次才执行。
     setShared 装在 installSeg 里（晚于本文件），所以用可选调用做晚绑定。 */
  let armTimer = 0;
  const disarm = () => {
    segChip.dataset.armed = "";
    segChip.classList.remove("armed");
    clearTimeout(armTimer);
    armTimer = 0;
  };
  segChip.onclick = () => {
    if (ui.st && ui.st.shared) { disarm(); ui.setShared?.(false); return; }  // 切回按段：不丢东西
    if (segChip.dataset.armed === "1") { disarm(); ui.setShared?.(true); return; }
    segChip.dataset.armed = "1";
    segChip.classList.add("armed");
    ui.toast?.("再点一次「" + segChip.textContent + "」即切为全片共用：所有分镜的架面将统一为当前这份，各段现有独立副本会被覆盖", false, 6000);
    armTimer = setTimeout(disarm, 6000);
  };

  const bar = el("div", "gmr-bar");
  bar.append(el("div", "gcast-label", "素材"), segChip,
             bSort, bSortAll, fpsCtl.chip, audCtl.chip, bClear);

  /* 音频输出编号自愈。编号按「第几个视频槽位」引用，素材删除/拖拽换位后
     可能悬空或指错素材。每次 commit 前校一遍：
     · 指向的槽位仍是原文件 → 记住它，不动；
     · 槽位空了或被换成别的文件 → 在全架按文件名找原文件，找到就把编号跟到
       新位置（toast 告知）；找不到（素材真被删/被替换）→ 清零并提示。
     绝不静默地把音频换成另一条素材。手动改编号时会同步基准，不会被误改回。 */
  let lastAudioFile = "";
  function setAudioBaseline(slot) { lastAudioFile = (slot && slot.file) || ""; }
  function fixAudioOut() {
    const slot = st.slots.videos[st.audio_out - 1];
    const file = (slot && slot.file) || "";
    if (file && (!lastAudioFile || file === lastAudioFile)) {
      lastAudioFile = file;
      return;
    }
    if (!st.audio_out) { lastAudioFile = ""; return; }
    if (lastAudioFile) {
      const i = st.slots.videos.findIndex((s) => s && s.file === lastAudioFile);
      if (i >= 0) {
        st.audio_out = i + 1;
        audIn.value = String(st.audio_out);
        ui.toast(`音频输出编号已自动改为 ${st.audio_out}：原槽位已空，素材挪到了新位置`);
        return;
      }
    }
    st.audio_out = 0;
    audIn.value = "";
    lastAudioFile = "";
    ui.toast("音频输出编号指向的视频已不在架上，已自动清零（0 = 不输出）", true);
  }

  ui.bar = bar;
  ui.segChip = segChip;
  ui.bSort = bSort;
  ui.bSortAll = bSortAll;
  ui.fpsIn = fpsIn;
  ui.audIn = audIn;
  ui.fixAudioOut = fixAudioOut;
  ui.setAudioBaseline = setAudioBaseline;
}
