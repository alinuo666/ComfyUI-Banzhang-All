/* ============================================================
 * ✍️ H3 文案台 面板
 * ------------------------------------------------------------
 * 提示词从导演台里搬出来，单独成一个节点。三块内容：
 *
 *   顶部：@标签 chips   —— 媒体架里有什么素材，点一下就插进光标处
 *   中部：片子级 / 本段 —— 片子级是全片统一的基调，本段是这一段发生的事
 *   底部：预设          —— 常用的几句，点一下追加
 *
 * 为什么严格按这个顺序分两块：片子级在前、本段在后。反过来写会让每段开头
 * 都在重复世界观，模型的注意力被固定前缀拉走，段与段的差别被稀释。
 *
 * 段身份从导演台节点直接读（同一个 gcast_project 快照），不从后端反查——
 * 文案台在图上排在导演台前面执行，那时档案里的 current 还是上一段。
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { rackSlotsOf, rackNodeOf, castProject, currentOf, currentClipOf,
         onCastChange, onRackChange, emitDeskChange, BZ_BAG_VERSION } from "./bz_rack.js";
import { bzStore } from "./bz_store.js";
import { saveDesk } from "./bz_project_sync.js";
import { pullSeg, pushSegText, segPushBroken, isRealCid, tempKeyOf, isTempKey } from "./bz_seg.js";
import { projectStore } from "./bz_project_store.js";
import { CUR_SEG, CUR_SEG_DIM } from "./csglide_film.js";
/* 提示词检查规则。词在这边写，检查就在这边跑 —— 搬到导演台去只会让人看到
   警告却改不了词。规则只有一份，三个节点共用。 */
import { promptCheck } from "./csglide_prompt_check.js";
/* 通用提示词编辑器：高亮 / @补全 / 悬停预览都在它里面，文案台不再自己在
   textarea 上叠高亮层、手写几何命中（那套没有 @ 补全，且容易与文字层错位）。 */
import { makePromptEditor } from "./csglide_prompt_editor.js";
/* 编辑器样式（.gcast-ed / .tok / .gcast-ac / .gcast-toktip）与导演台同源，
   只从纯样式文件取字符串，不拖入导演台主逻辑，避免副作用与循环依赖。 */
import { CSS as CAST_CSS } from "./csglide_cast.css.js";
/* 引用归一化 / 别名展开 / "实际会发送哪些参考"的唯一权威纯函数（与后端
   csglide_cast.normalize_refs / expand_aliases 对称）。chip 亮灭读它，保证
   文案台点亮 == 后端真发。 */
import { effectiveTags } from "./csglide_ref_text.js";

const NODE_ID = "CSGlideDeskCS";
/* 与媒体架同一套缩放口径：floor 是报给框架的最小高度（不是内容高），
   节点实际高度靠 setSize + fit 给一个能装下内容的起点。 */
const MIN_W = 460, MIN_H = 520, MIN_FLOOR_H = 120;

const CSS_ID = "bz-desk-css";
const CSS = `
.bzdesk {
  --bz-bg:#191919; --bz-panel:#212121; --bz-raise:#2b2b2b; --bz-line:#3b3b3b;
  --bz-well:#131313;
  --bz-txt:#e3e3e3; --bz-dim:#979797;
  --bz-accent:#58d1ff; --bz-accent-dim:#58d1ff26;
  /* 「当前段」的规范色从成片监视器导入，不在本文件另抄一份 —— 三个节点必须
     用同一个值，手抄副本迟早会漂。 */
  --bz-violet:${CUR_SEG}; --bz-violet-dim:${CUR_SEG_DIM};
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: var(--bz-txt); font-size: 12px; line-height: 1.35;
  pointer-events: auto; position: relative; width: 100%; min-width: 0;
  background: var(--bz-bg); border: 1px solid var(--bz-line); border-radius: 10px;
  padding: 8px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 7px;
  user-select: none; -webkit-user-select: none;
  /* 填满节点主体、内容超出时在面板内滚动 —— 与媒体架同一机制：节点拖短
     不会把内容挤到框外，而是这里出滚动条。 */
  height: 100%; overflow: auto; overflow-x: hidden;
}
.bzdesk * { box-sizing: border-box; }

.bzdesk-bar {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex: none;
  font-size: 11.5px; color: var(--bz-dim); white-space: nowrap; overflow: hidden;
}
.bzdesk-bar .d-title { color: var(--bz-txt); font-weight: 500; flex: none; }
/* 当前段指示 —— 与时间轴上那一段的紫环、媒体架上那颗胶囊是**同一个信号**的
   三种画法：同一个规范色，同一个"锁定加发光"的加强方式。 */
.bzdesk-bar .d-segchip {
  padding: 1px 7px; border-radius: 4px; background: var(--bz-violet-dim);
  border: 1px solid var(--bz-violet); color: var(--bz-violet); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; flex: none;
}
.bzdesk-bar .d-segchip.locked {
  box-shadow: 0 0 7px 1px var(--bz-violet-dim);
  border-width: 2px; padding: 0 6px;
}
.bzdesk-bar .d-sp { flex: 1 1 auto; min-width: 4px; }
.bzdesk-bar .d-btn {
  all: unset; cursor: pointer; flex: none; font-family: inherit;
  padding: 2px 8px; border-radius: 4px; background: var(--bz-raise);
  border: 1px solid var(--bz-line); font-size: 11px; color: var(--bz-txt);
}
.bzdesk-bar .d-btn:hover { border-color: var(--bz-accent); color: var(--bz-accent); }
.bzdesk-bar .d-btn:disabled { opacity: .4; cursor: default; }

/* ---- @标签 chips ---- */
.bzdesk-chips {
  display: flex; flex-wrap: wrap; gap: 5px; flex: none;
  padding: 5px; background: var(--bz-well);
  border: 1px solid var(--bz-line); border-radius: 6px;
  max-height: 170px; overflow: auto;
}
/* 逐条照搬导演台 .gcast-chip：圆形 18px 缩略图、等宽 10.5px、别名为主 /
   规范 token 缩小作副标；.on = 提示词里提到了 = 真的会送进参考。 */
.bzdesk-chip {
  all: unset; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px 2px 2px; border-radius: 20px;
  background: var(--bz-raise); border: 1px solid var(--bz-line);
  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
  color: var(--bz-txt); max-width: 190px; transition: .13s;
}
.bzdesk-chip:hover { border-color: var(--bz-accent); }
.bzdesk-chip.on { border-color: var(--bz-accent); background: var(--bz-accent-dim); }
.bzdesk-chip.on .lbl, .bzdesk-chip.on .sub { color: var(--bz-accent); }
.bzdesk-chip .sub { opacity: .5; font-size: 9.5px; letter-spacing: .2px; }
.bzdesk-chip img, .bzdesk-chip video {
  width: 18px; height: 18px; border-radius: 50%; object-fit: cover;
  background: #0d0d0d; flex: none;
}
.bzdesk-chip .glyph {
  width: 18px; height: 18px; border-radius: 50%; flex: none;
  display: grid; place-items: center; background: var(--bz-bg);
  font-size: 9px; color: var(--bz-accent);
}
.bzdesk-chip .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bzdesk-empty { color: var(--bz-dim); font-size: 11px; padding: 2px 4px; }

/* ---- 编辑区 ---- */
.bzdesk-sec { display: flex; flex-direction: column; gap: 3px; flex: none; }
.bzdesk-sec .d-lab {
  font-size: 9.5px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--bz-dim); display: flex; align-items: center; gap: 6px;
}
.bzdesk-sec .d-lab .hint { text-transform: none; letter-spacing: 0; opacity: .7; }
/* 提示词检查。每条一行，只报不拦 —— 它不是校验门，是"写的时候顺手看一眼"。
   告警用琥珀（有事没做），不用红色：这些都不是错误，不会让渲染失败。 */
.bzdesk-sec .d-check {
  display: flex; flex-direction: column; gap: 3px;
  background: var(--bz-well); border: 1px solid var(--bz-line);
  border-radius: 7px; padding: 5px 7px;
}
.bzdesk-sec .d-crow { display: flex; align-items: baseline; gap: 7px; font-size: 11px; }
.bzdesk-sec .d-crow b { color: var(--bz-accent); font-weight: 500; min-width: 34px;
  flex: 0 0 auto; }
.bzdesk-sec .d-crow.warn span { color: #e0a34a; }
.bzdesk-sec .d-crow.ok span { color: var(--bz-dim); }
/* ---- 提示词编辑器（makePromptEditor，自带 @ 补全 / 高亮 / 悬停预览） ----
   编辑器节点必须是 .gcast-pwrap > .gcast-ed（基础样式在导演台 CAST_CSS），
   这里只把外观对齐文案台：深井底色、青色主色、圆角；高度片子级矮、本段吃满。
   不再有 textarea 透明文字 + 高亮层的双层结构（那套没有 @ 补全、还会错位）。 */
.bzdesk-sec .gcast-pwrap {
  width: 100%; box-sizing: border-box;
  background: var(--bz-well); border: 1px solid var(--bz-line); border-radius: 6px;
}
.bzdesk-sec .gcast-pwrap:focus-within { border-color: var(--bz-accent); }
.bzdesk-sec .gcast-pwrap > .gcast-ed {
  width: 100%; box-sizing: border-box;
  background: transparent; border: none; border-radius: 6px;
  padding: 6px 7px; font-family: inherit; font-size: 12px; line-height: 1.5;
  /* 把编辑器内部用的 --h3-* 变量重指到文案台主题，高亮/占位符/主色就与
     本面板一致，不必在 CAST_CSS 里另抄一份颜色。 */
  --h3-bg: var(--bz-well); --h3-txt: var(--bz-txt); --h3-dim: var(--bz-dim);
  --h3-accent: var(--bz-accent); --h3-accent-dim: var(--bz-accent-dim);
  --h3-line: var(--bz-line);
}
/* 片子级：固定矮框，内容多了在框内滚动 */
.bzdesk-sec.global .gcast-pwrap > .gcast-ed { min-height: 46px; max-height: 140px; }
/* 本段吃满剩余高度：节点拖高就多显示几行，不必手动拉输入框 */
.bzdesk-sec.d-segsec { flex: 1 1 auto; min-height: 0; }
.bzdesk-sec.d-segsec .gcast-pwrap { flex: 1 1 auto; min-height: 120px; display: flex; }
.bzdesk-sec.d-segsec .gcast-pwrap > .gcast-ed {
  flex: 1 1 auto; min-height: 120px; max-height: none;
}

/* ---- 预设 ---- */
.bzdesk-presets { display: flex; flex-wrap: wrap; gap: 5px; flex: none; }
.bzdesk-preset {
  all: unset; cursor: pointer; font-family: inherit; font-size: 11px;
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px 3px 2px 8px; border-radius: 999px; background: var(--bz-raise);
  border: 1px solid var(--bz-line); color: var(--bz-txt); max-width: 240px;
}
.bzdesk-preset .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bzdesk-preset:hover { border-color: var(--bz-violet); color: var(--bz-violet); }
/* ✕ 必须有实心可点区域：裸 span 小字点不中，点偏就落在胶囊上变成"追加" */
.bzdesk-preset .x {
  flex: none; cursor: pointer; padding: 0 6px; border-radius: 999px;
  color: var(--bz-dim);
}
.bzdesk-preset .x:hover { color: #f09595; }
/* 拖文档进来时的落点提示 + 读入结果提示条（20261022） */
.bzdesk.dropping { outline: 2px dashed var(--bz-accent, #58d1ff); outline-offset: -3px; }
.bzdesk.dropping .d-segwrap { outline: 1px dashed var(--bz-accent, #58d1ff); outline-offset: -2px; }
/* 改写行：开关与系统提示词同一行，不额外占高度；留空走内置默认指令 */
.bzdesk .d-rwrow { display: flex; align-items: center; gap: 8px; }
.bzdesk .d-rwcb { display: flex; align-items: center; gap: 5px; font-size: 12px;
  white-space: nowrap; cursor: pointer; color: var(--bz-txt, #d8d8d8); }
.bzdesk .d-rwcb input { margin: 0; accent-color: var(--bz-accent, #58d1ff); }
.bzdesk .d-rwsys { flex: 1 1 auto; min-width: 0; box-sizing: border-box;
  font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--bz-line, #333); background: var(--bz-well, #171717);
  color: var(--bz-txt, #d8d8d8); outline: none; }
.bzdesk .d-rwsys:focus { border-color: var(--bz-accent, #58d1ff); }
.bzdesk .d-rwsys::placeholder { color: var(--bz-dim, #777); }
.bzdesk .d-rwmodel { all: unset; box-sizing: border-box; flex: 0 1 auto; max-width: 36%;
  font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--bz-line, #333); background: var(--bz-well, #171717);
  color: var(--bz-txt, #d8d8d8); cursor: pointer; white-space: nowrap; }
.bzdesk .d-rwmodel option { background: var(--bz-well, #171717); color: var(--bz-txt, #d8d8d8); }
.bzdesk .d-rwbtn { all: unset; cursor: pointer; font-size: 12px; padding: 3px 10px;
  border-radius: 6px; border: 1px solid var(--bz-accent, #58d1ff);
  color: var(--bz-accent, #58d1ff); white-space: nowrap; }
.bzdesk .d-rwbtn:hover { background: var(--bz-accent, #58d1ff); color: #111; }
.bzdesk .d-rwbtn[disabled] { opacity: .45; cursor: default; }
.d-toast { margin: 4px 0 0; padding: 4px 7px; border-radius: 6px; font-size: 10px;
  line-height: 1.5; background: var(--bz-raise); border: 1px solid var(--bz-line);
  color: var(--bz-txt); word-break: break-all; }
.d-toast.bad { background: #3a1e1e; border-color: #a05252; color: #ffb3b3; }
.d-toast .d-btn { margin-left: 6px; font-size: 10px; }
`;

function injectCSS() {
  /* 编辑器基础样式（导演台 / qwen 也注入同一份，id 去重，全局只一份）。
     先于 desk CSS 注入：下面的 desk 覆盖规则才能压过它。 */
  if (!document.getElementById("gcast-css")) {
    const base = document.createElement("style");
    base.id = "gcast-css";
    base.textContent = CAST_CSS;
    document.head.appendChild(base);
  }
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement("style");
  s.id = CSS_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const DEFAULT_PRESETS = [
  "镜头缓慢推进，主体保持在画面中央",
  "手持感轻微晃动，环境光偏冷",
  "固定机位，人物从画面左侧入画",
];

function blankState() {
  return {
    chain: { name: "", clip: "", shot: "" },
    global: "",            // 片子级
    segs: {},              // { 段身份: 本段提示词 }
    alias: false,          // 别名模式：名字直接当引用（关 = 只认 @图片N 写法）
    presets: DEFAULT_PRESETS.slice(),
    // 提示词改写：编码前用接入的编码器整段重写；系统提示词留空走内置默认
    // （内置那段专门钉住 <d> 台词 / [镜N] / 音效行 / @引用，别删）。
    rewrite_system: "",
    rewrite_model: "",     // 留空 = 后端默认模型；选项来自 /csglide_desk/models    // 留空 = 官方六段规范（后端内置）；写了自定义就用自定义
  };
}

/** 素材文件 → 预览地址。与导演台/媒体架同一套 /view 口径：文件名可能带
 *  子目录（媒体架上传落在 input/cglide/），必须拆出来填 subfolder，否则 404。
 *  thumb 给了数字 = 走 /cglide/thumb 256px 缩略图（20261101）：与媒体架同一
 *  套磁盘缓存 + ETag（304 只回几十字节），同 size 同 URL 共享一份缓存。 */
function viewURL(file, thumb) {
  const f = String(file || "");
  if (!f) return "";
  const i = f.lastIndexOf("/");
  const sub = i >= 0 ? f.slice(0, i) : "";
  const name = i >= 0 ? f.slice(i + 1) : f;
  if (thumb) {
    return api.apiURL(`/cglide/thumb?filename=${encodeURIComponent(name)}`
      + `&subfolder=${encodeURIComponent(sub)}&size=${thumb}`);
  }
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(sub)}&type=input`);
}

/* 小图口子的统一取图（20261101）：素材条 chip、@补全列表、悬停预览原来
 * 都拉**原图** —— 4K 素材解码后 ≈46MB/张，十几个引用就是几百 MB 常驻，
 * 而且每次 rack 变更重建 chip 都重新解码一遍。统一改走 256 缩略图；
 * 视频不能走缩略图端点（后端 PIL 415），按扩展名回原图。 */
const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
function previewURL(file) {
  const f = String(file || "");
  const ext = f.split(".").pop().toLowerCase();
  return IMG_EXT.has(ext) ? viewURL(f, 256) : viewURL(f);
}

app.registerExtension({
  name: "cglide.glidedesk",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;
    injectCSS();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const node = this;

      let st = blankState();
      let dataWidget = node.widgets?.find((w) => w.name === "desk_data");
      if (dataWidget) {
        try { st = Object.assign(blankState(), JSON.parse(dataWidget.value || "{}")); }
        catch { st = blankState(); }
        /* 同导演台：h3_data / desk_data 只作值载体，不摆在画布上 */
        dataWidget.hidden = true;
        dataWidget.options = Object.assign({}, dataWidget.options, { hidden: true });
        dataWidget.computeSize = () => [0, -4];
        dataWidget.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
        dataWidget.label = "";
        dataWidget.tooltip = "";
        dataWidget.serializeValue = dataWidget.serializeValue || (() => dataWidget.value);
        if (dataWidget.element) {
          Object.assign(dataWidget.element.style, {
            display: "none", visibility: "hidden", pointerEvents: "none",
            position: "absolute", left: "-99999px", top: "0",
            width: "0px", height: "0px", opacity: "0", zIndex: "-1",
          });
          dataWidget.element.hidden = true;
        }
      }

      const root = document.createElement("div");
      root.className = "bzdesk";
      root.innerHTML = `
        <div class="bzdesk-bar">
          <span class="d-title">✍️ 文案台</span>
          <span class="d-segchip" style="display:none"></span>
          <span class="d-sp"></span>
          <button class="d-btn d-alias" type="button"
            title="别名模式：媒体架登记过的名字（小明 / @小明）直接当引用，在本段里高亮，点标签插进去的也是名字而不是 @图片N">别名：关</button>
          <button class="d-btn d-save" type="button"
            title="把当前这句话存成预设">存预设</button>
        </div>
        <div class="bzdesk-chips"></div>
        <div class="d-toast" style="display:none"></div>
        <div class="bzdesk-sec">
          <div class="d-lab">预设 <span class="hint">点一下追加到本段末尾</span></div>
          <div class="bzdesk-presets"></div>
        </div>
        <div class="bzdesk-sec global">
          <div class="d-lab">片子级 <span class="hint">全片基调，每段都带 · 写 @ 也会送，引用建议写在本段</span></div>
          <div class="gcast-pwrap d-global-pwrap"></div>
        </div>
        <div class="bzdesk-sec d-segsec">
          <div class="d-lab">本段 <span class="hint">这一段要发生的事 · 输入 @ 弹出素材补全 · 提示词文档（.txt）可直接拖进来</span></div>
          <div class="gcast-pwrap d-segwrap"></div>
        </div>
        <div class="bzdesk-sec d-rwsec">
          <div class="d-rwrow">
            <select class="d-rwmodel" title="改写用的编码器模型：加载几秒，切一次换一次"></select>
            <input type="text" class="d-rwsys" placeholder="系统提示词（留空 = 导演级：结构一字不动，只润色描述句）">
            <button type="button" class="d-rwbtn">立即改写</button>
          </div>
        </div>
        <div class="bzdesk-sec d-checksec" style="display:none">
          <div class="d-lab">提示词检查 <span class="hint">只报不拦，改词就在上面</span></div>
          <div class="d-check"></div>
        </div>
      `;

      const el = {
        /* 两个编辑区是 .gcast-pwrap 容器，makePromptEditor 的 node 挂进去。
           类名彼此区分开（片子级 .d-global-pwrap / 本段 .d-segwrap），
           靠顺序活着的 querySelector 改一次 DOM 就翻车。 */
        segChip: root.querySelector(".d-segchip"),
        alias: root.querySelector(".d-alias"),
        save: root.querySelector(".d-save"),
        chips: root.querySelector(".bzdesk-chips"),
        toast: root.querySelector(".d-toast"),
        globalWrap: root.querySelector(".d-global-pwrap"),
        segWrap: root.querySelector(".d-segwrap"),
        rewriteModel: root.querySelector(".d-rwmodel"),
        rewriteSys: root.querySelector(".d-rwsys"),
        rewriteBtn: root.querySelector(".d-rwbtn"),
        presets: root.querySelector(".bzdesk-presets"),
        checkSec: root.querySelector(".d-checksec"),
        check: root.querySelector(".d-check"),
      };

      let lastGen = null;      // 上次见到的导演台「代际」；变了 = 新建整片 → 清空
      let curKey = "";         // 当前本段写的是哪一段（段身份）
      /* 方案A（20261025）：编辑器画面与段身份**必须同一瞬间切换**。
         edSegKey = 编辑器此刻显示的是哪一段的词（每次 setSegText 当场绑定）。
         所有"把编辑框内容写回某段"的路径一律按它走 —— 以前只认 curKey，
         而乐观首跳先换画面、curKey 要等网络往返后才更新，中间那步"切段前
         存旧段"就把**新段**的词存进了**旧段**名下（两段词对调的根因）。 */
      let edSegKey = "";       // 编辑器内容与哪一段绑定（随画面一起换）
      const segPushWarned = {}; // 落库推送失败提示去重：每段只警告一次
      let reconciledKey = "";  // 已经和中央库对过账的段（乐观切换后仍须对账）
      /* 编辑器是否已装填当前段的词。false = edSeg 里的内容与 curKey 无关
         （刚切段还没填、hydrate 刚灌完还没填、读档还没恢复），此时所有
         「收口写回」一律只读不写 —— 拿一个还没就绪的编辑器当权威，
         就会把空编辑框当成「用户清空了本段」写回 st.segs，把刚从工程库
         灌进来的段词抹掉（20261017 现场实证：10 段词里独独当前段变空串，
         因为只有 curKey 命中的那一段会被收口写回）。 */
      let edReady = false;
      /* 编辑器里是否有**用户还没落地**的输入（true = 编辑器比 st.segs 新）。
         只有它为 true 时，「收口写回」才允许拿编辑器文本覆盖 st.segs。
         没有这一位的时候，任何一次外部把 st.segs[k] 改新（中央纠词、读档
         灌库、复制段）都会被下一次巡检用**过时的编辑框内容**盖回去 ——
         盖回去的那份文本属于上一段，于是两段词对调/重复（20261023 编译式
         渲染改造一并收口：读段数据不要副作用）。 */
      let edSegDirty = false;
      let chipSig = "";
      let curRow = null;       // 当前段那一行档案（段号 / 锁定）
      const chipEls = new Map();   // 规范 token → chip 按钮（打字时只改 class）

      /* ---- 文案落 SQLite 工程库（20261012 方案 A）----
         commit 是所有编辑（打字 / 切段 / 预设 / 别名）的唯一收口，防抖 700ms
         整份落 /cglide/store/desk。hydrate 灌库后 2s 内的 commit 不回写，
         防止"刚读出又写回"的回声把库里的新数据盖掉。 */
      let deskSaveTimer = 0;
      let deskHydrateUntil = 0;
      function scheduleDeskSave() {
        if (Date.now() < deskHydrateUntil) return;
        const p = castProject(node);
        const name = (p && p.name) || (st.chain && st.chain.name) || "";
        if (!name) return;
        clearTimeout(deskSaveTimer);
        /* 写穿透统一经 projectStore 防抖调度：fire 时才取最新 st 落库，
           提交前 flushWrites 立即触发并等它。 */
        projectStore.scheduleSave(name, "desk", () => {
          const body = JSON.parse(JSON.stringify(st));
          /* **段词不进整包**（20261031 · 单一真值收口）。

             段词的真值是中央 segment_bindings.desk_text + desk_rev；desk.segs
             降级成**投影**（只给老路径/导出/换机器看）。整包这份是前端内存的
             快照，还防抖 700ms 才发一次 —— 它天然落后于用户最后一次敲键。
             让它继续带 segs，就等于留着一条「用旧副本覆盖新真值」的通道：
             A 节点刚写完、B 节点的旧快照随后一到，B 赢。这就是"后段的词被
             前段污染 / 刷新后段词没了"的结构性根因，靠 merge 层挡不住
             （merge 只能挡空串，挡不住「有内容的旧值」）。

             所以段词从今天起只有**一条**写入口：pushSegText（带版本号，
             撞了中央说了算）。整包只负责 global / alias / presets / chain。

             ⚠ 唯一的例外是**降级**：按段接口不通时（后端没重启 / 网络挂了）
             段词必须退回整包，否则用户敲的字一次都不落盘，重启就没了。
             这时候没有版本号保护，等于回到改造前的老风险 —— 但"老风险"
             明显好过"必定丢数据"，且通道一通就立刻自动收回。 */
          // [单一真值] 段词**不进整包**。写入口只有 pushSegText（带版本号）。
          // 让整包带 segs = 留一条"旧副本盖真值"的通道，串词/丢词就是从这儿来的。
          if (body && !segPushBroken()) {
            delete body.segs;
          } else if (body && body.segs && typeof body.segs === "object") {
            /* 降级整包：仍然只放真 clip 键，临时键/uid 一律不进中央。 */
            for (const k of Object.keys(body.segs)) {
              if (!isRealCid(k)) delete body.segs[k];
            }
          }
          /* cur_cid 只用于事件留痕（后端拿它填 events.cid），**不**走按段增量
             分支 —— 整包要照旧存 presets / alias / global。 */
          return saveDesk(name, body, keyOf());
        }, 700);
      }

      /* ---- B1：中央段档案读写入口 ----
         片名统一从导演台 / 本台 chain 取，别各处自己拼（拼错就写到别的片子里）。 */
      const projName = () => {
        const p = castProject(node);
        return (p && p.name) || (st.chain && st.chain.name) || "";
      };
      /* 拉某一段的中央档案。拉不到返回 null，**绝不因此清空界面** ——
         以前"拉不到就当空"正是丢词的标准姿势。 */
      async function pullSegFor(cid) {
        const nm = projName();
        if (!nm || !cid) return null;
        try { return await pullSeg(nm, cid); } catch (_) { return null; }
      }

      const keyOf = () => {
        /* 段身份**只有** clip 一个来源。
           以前这里写的是 `clip || shot`：新段还没从档案拿到 clip 时退回工程
           内部的 uid。uid 一旦落进中央，同一段就有了两个身份，中央多出孤儿
           键（之前清出来的 34n8fhu / mgsixqd 就是这类）。现在改成：拿不到
           clip 就用 __new__ 开头的**本地临时键**，它永远不进中央；等 clip 回
           来，migrateTempSeg 一次性把词搬到真 clip 键下。 */
        const c = (st.chain && st.chain.clip) || "";
        if (c && isRealCid(c)) return c;
        return (st.chain && st.chain.shot) ? tempKeyOf(st.chain.shot) : "";
      };

      /* [单一真值] 独立认段（20261031 · 文案台脱离导演台用）。
         段身份的唯一合法来源是后端档案里的 clip id（铁律 4）。有导演台时它
         由 syncFromCast 同步过来；没有导演台时这里补一条**同源**通道：
           · 片名：hydrate 恢复的 st.chain.name；空则问后端有哪些工程
             （零个 → 「未命名」现建；一个 → 直接用；多个 → 列出来提示）
           · 当前段：GET /cglide/chain/summary → d.current（导演台建的段也在这）
           · 工程还是空的 → POST /cglide/chain/add_clip 现场建一段
             （后端发号 + 设 current，和导演台走的是**同一条路**）
         拿到 cid 写进 st.chain.clip —— 之后 pushSegText / 版本号 / 单写入口
         全部自动生效，**不为独立模式另开一套机制**。这正是方案 A 的要点：
         独立化不是第二套真值，是把最后那个第二身份（临时键）也收编。 */
      let segIdProm = null;   // 并发去重：切段风暴 / 连续打字只认一次
      function ensureSegIdentity() {
        if (castProjectSafe() || segIdProm) return segIdProm || Promise.resolve("");
        segIdProm = (async () => {
          try {
            let nm = (st.chain && st.chain.name) || "";
            if (!nm) {
              /* 片名没有入口（文案台本来没有片名框）→ 问后端有哪些工程。
                 零个就用「未命名」（add_clip 自带这个兜底）；一个就直接用；
                 多个说明用户有不止一部片子，必须人来选 —— 这里只能明说，
                 替他猜一个就会把词写进别人的片子。 */
              try {
                const r = await api.fetchApi("/cglide/chain/projects");
                const d = await r.json().catch(() => null);
                const ps = (d && Array.isArray(d.projects)) ? d.projects : [];
                if (ps.length === 1) nm = String(ps[0] || "");
                else if (ps.length > 1) {
                  console.warn("[文案台] 独立模式：检测到 %d 个工程（%s…）。"
                    + "本次先用「未命名」；要指定哪一部，把导演台放进画布选好片名"
                    + "即可，或等后续版本加工程选择框。", ps.length,
                    ps.slice(0, 3).join("、"));
                }
              } catch (_) { /* 列不到工程就按零个处理 */ }
            }
            if (!nm) nm = "未命名";
            if (!st.chain.name) st.chain.name = nm;
            let cid = "";
            try {
              const r = await api.fetchApi(
                "/cglide/chain/summary?name=" + encodeURIComponent(nm));
              const d = await r.json().catch(() => null);
              cid = String((d && d.current) || "");
            } catch (_) { /* summary 失败按空工程处理 */ }
            if (!cid || !isRealCid(cid)) {
              const r2 = await api.fetchApi("/cglide/chain/add_clip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: nm }),
              });
              const d2 = await r2.json().catch(() => null);
              if (r2.ok && d2 && d2.id) cid = String(d2.id);
            }
            if (cid && isRealCid(cid) && !(st.chain && st.chain.clip)) {
              const prevShot = (st.chain && st.chain.shot) || "";
              st.chain.clip = cid;
              if (!prevShot) st.chain.shot = cid;
              console.log("[文案台] 独立认段:", cid, "（片名=" + nm + "）");
              /* 认到段之前，词可能落在临时键里（prevShot 已有时），也可能
                 只留在编辑框里（prevShot 也没有时）。有真身份了：能搬的搬，
                 编辑框里没落地的直接推中央 —— 不然用户敲的头几个字会丢。 */
              try {
                const tk = prevShot ? tempKeyOf(prevShot) : "";
                if (tk && !isRealCid(tk) && typeof st.segs[tk] === "string"
                    && !st.segs[cid]) {
                  st.segs[cid] = st.segs[tk];
                  delete st.segs[tk];
                }
              } catch (_) {}
              curKey = cid;
              try {
                const t = (edReady && edSeg) ? edSeg.getText() : "";
                if (t) {
                  st.segs[cid] = t;
                  pushSegText(nm, cid, t,
                              { allowEmpty: true, retryOnConflict: true });
                }
              } catch (_) {}
              commit();
              refresh();
            }
            return st.chain.clip || "";
          } catch (_) {
            return "";
          } finally {
            segIdProm = null;
          }
        })();
        return segIdProm;
      }
      /* castProject 在无导演台时会 console.warn（bz_rack.js 里写的）。独立
         模式下不能每次打字都 warn 一遍，也不能永久缓存（用户后补导演台就
         失效了）—— 折中：按 3 秒 TTL 探测。 */
      let _castProbe = { at: 0, val: null };
      function castProjectSafe() {
        const now = Date.now();
        if (now - _castProbe.at < 3000) return _castProbe.val;
        _castProbe.at = now;
        try { _castProbe.val = castProject(node); } catch (_) { _castProbe.val = null; }
        return _castProbe.val;
      }

      /* clip 到货 → 把临时键下的段词搬到真 clip 键下（20261031 重写）。
         旧版拿到一个 cid 就把**所有**临时键一锅端进来：第一个非空的赢、其余
         直接删 —— 连续建多段时，后面段的词被搬进前面段的名下（串词），或者
         干脆被删掉（丢词）。这正是"多段时后面的段词串了"的一条直接通路。
         现在按工程里每段自己的 uid→clip 对应关系**各搬各的**：谁的临时键配
         谁的 clip。还没拿到 clip 的段，临时键原地保留，等它自己到货那轮再搬。
         目标键已有词时不覆盖（段表现有那份更新），但丢弃临时键副本必须出声。 */
      function migrateTempSeg(p) {
        const segs = (st && st.segs && typeof st.segs === "object") ? st.segs : null;
        if (!segs) return false;
        const shots = ((p && p.cast && p.cast.properties
          && p.cast.properties.gcast_project) || {}).shots || [];
        if (!Array.isArray(shots) || !shots.length) return false;
        const nm = projName();
        let moved = false;
        for (const sh of shots) {
          if (!sh || !sh.id || !sh.clip) continue;
          const cidS = String(sh.clip);
          if (!isRealCid(cidS)) continue;
          const tk = tempKeyOf(String(sh.id));
          if (!tk || !isTempKey(tk) || !(tk in segs)) continue;
          const v = segs[tk];
          delete segs[tk];
          if (v && !segs[cidS]) {
            segs[cidS] = v;
            moved = true;
            console.log("[文案台] 临时键词已归位:", tk, "→", cidS,
              "（" + String(v).length + " 字）");
            if (nm) { try { pushSegText(nm, cidS, v); } catch (_) { /* 落库失败不挡使用 */ } }
          } else if (v) {
            console.warn("[文案台] 临时键", tk, "里有词，但本段", cidS,
              "在段表里已有词 —— 丢弃临时键这份旧副本（以段表现有词为准）");
          }
        }
        return moved;
      }

      const commit = () => {
        syncFromCast();
        if (!dataWidget) dataWidget = node.widgets?.find((w) => w.name === "desk_data");
        if (dataWidget) dataWidget.value = JSON.stringify(st);
        node.setDirtyCanvas(true, true);
        scheduleDeskSave();    // 防抖落工程库（老工程后端 409 静默，无副作用）
        /* 文本变了要广播（20261023）：媒体架上「这一格被本段文案引用没引用」的亮/灰
           靠它实时亮灭。文案台以前什么都不广播，媒体架只能等自己下一次重渲
           （切段 / 落图 / 提交）才知道文案变了 —— 表现是「刚写的 @图片3 不亮」。
           只带身份、不带正文：正文由监听方自己去读，多一份副本就多一处会漂。
           合帧在 emitDeskChange 里做（一次编辑会连着 commit 好多次）。 */
        try { emitDeskChange({ name: st.chain?.name || "", clip: st.chain?.clip || "", reason: "text" }); }
        catch (_) { /* 广播失败不影响落库 */ }
      };

      /* ---- 跟随导演台：段身份与片名都从它那儿来 ----
         认段优先用**三个节点共享的 current**（后端那份当前段），而不是导演台
         面板上的选中段 —— 差别就在锁定：锁定后导演台把 current 钉在那一段，
         于是这里继续写锁定的段，不跟着点来点去跳。这正是「锁编辑目标」的意思。 */
      async function syncFromCast() {
        const p = castProject(node);
        if (!p) return;
        if (p.name) st.chain.name = p.name;
        /* 20261012 方案B：current 与段行优先读 bzStore 快照（零 HTTP），
           缓存还没到才退回接口。 */
        const sf = bzStore.film(p.name);
        let id = sf ? (sf.current || sf.head || "") : "";
        if (!id) { try { id = (await currentOf(p.name)) || ""; } catch { id = ""; } }
        if (!id) id = p.clip || p.shot || "";   // 导演台还没认段时退回面板快照
        /* clip 只写真 cid：面板快照里的 p.shot 是工程内部 uid，塞进 clip 会让
           段身份又变回双轨（uid 一旦落中央就是孤儿键）。 */
        /* 迁移不再只盯着"刚切换到的这一段"：任何一段的 clip 到货都可能让它
           的临时键变得可搬，各搬各的（见 migrateTempSeg）。随手调一次没有
           副作用 —— 段表里没有临时键时它一步都不动。 */
        migrateTempSeg(p);
        if (id && isRealCid(id)) {
          st.chain.clip = id;
        }
        if (p.shot) st.chain.shot = p.shot;
        /* 段号与锁定状态从**档案那一行**读，而不是拿导演台面板的 idx 去拼：
           面板 idx 是"导演台上选中了哪一段"，锁定后它会跟着点走，而档案里的
           current 才是三个节点共同的编辑目标。拼错了就会出现「时间轴说写第
           2 段，文案台说第 3 段」。 */
        if (sf && id) {
          curRow = (sf.clips || []).find((c) => c.id === id) || null;
        } else {
          try { curRow = await currentClipOf(p.name); } catch { curRow = null; }
        }
      }

      function refreshSegChip() {
        const p = castProject(node);
        const id = keyOf();
        if (!id || !p) {
          el.segChip.style.display = "none";
          el.segChip.title = "";
          return;
        }
        el.segChip.style.display = "";
        const n = (curRow && curRow.index) || ((p.index ?? 0) + 1);
        el.segChip.textContent = `第 ${n} 段`;
        el.segChip.title = `片「${p.name || "未命名"}」· 段落 ${st.chain.clip || st.chain.shot || "未登记"}`;
      }

      /* ---- @标签 chips：媒体架里有什么就摆什么 ---- */
      /* 别名为主、规范 token 作副标 —— 与导演台同一套：chip 上认得出是谁，
         点进去插的是别名，展开成 <Picture n> 只在发送时发生。 */
      /* 别名规则与导演台同口径：多个称呼用逗号分隔；重名时先出现者胜；
         @小明 必须带 @ 才引用，小明 裸写就引用。 */
      const ALIAS_SPLIT = /[,，、;；]+/;
      const normSpace = (s) => (s ? s.replace(/\u3000/g, " ") : s);
      function aliasListOf(s) {
        const v = s && s.alias;
        const arr = Array.isArray(v) ? v
          : (typeof v === "string" && v.trim() ? v.split(ALIAS_SPLIT) : []);
        return arr.map((x) => String(x).trim()).filter(Boolean);
      }

      /** 媒体架当前的素材清单（chips 与高亮层共用同一份）。 */
      function rackRows() {
        const { slots } = rackSlotsOf(node);
        const rows = [];
        const push = (kind, token, s, label) => {
          const list = aliasListOf(s);
          rows.push({ kind, token, file: s.file, label: (list[0] || s.name || label), alias: list[0] || "", aliases: list });
        };
        (slots.images || []).forEach((s, i) => {
          if (s && s.file) push("image", `@图片${i + 1}`, s, `图片${i + 1}`);
        });
        (slots.videos || []).forEach((s, i) => {
          if (!s || !s.file) return;
          if (s.audio) push("audio", `@视频音频${i + 1}`, s, `${s.name || `视频${i + 1}`} · 音轨`);
          push("video", `@视频${i + 1}`, s, `视频${i + 1}`);
        });
        (slots.audios || []).forEach((s, i) => {
          if (s && s.file) push("audio", `@音频${i + 1}`, s, `音频${i + 1}`);
        });
        return rows;
      }

      /** 给通用编辑器喂词表：一条素材一条记录。
          · name   规范名 @图片N，永远是主名（必须带 @ 才引用）
          · alias  友好名（不带 @），只在「别名模式」开时给 —— 关时只认 @图片N，
                    与 paintChips / 旧高亮层同一口径
          · strict 该别名登记成 @小明（带 @ 才引用）
          · file   空 → 编辑器把这条引用标成「指向空槽位」警示色 */
      function editorTokens() {
        const useAlias = !!st.alias;
        return rackRows().map((r) => {
          let alias = "", strict = false;
          if (useAlias) {
            for (const raw of r.aliases) {
              const at = raw.charAt(0) === "@";
              const nm = normSpace(at ? raw.slice(1) : raw).trim();
              if (nm.length < 2 || /[@\\]/.test(nm)) continue;
              if (/^(?:图片|视频音频|视频|音频)\d+$/.test(nm)) continue;
              alias = nm; strict = at; break;
            }
          }
          return {
            name: r.token, alias, canon: r.token, file: r.file || "",
            strict, label: alias || r.label, note: r.token,
          };
        });
      }

      function renderChips() {
        const rows = rackRows();

        /* 别名开关也进签名：开/关切换时 chip 插入的东西变了，必须重建 */
        const sig = (st.alias ? "A|" : "") + rows.map((r) => r.token + r.file + r.label).join("|");
        /* 「亮不亮」随打字变，所以只比对素材集合；亮灭另走 paintChips。 */
        if (sig === chipSig) { paintChips(); return; }
        chipSig = sig;
        chipEls.clear();
        el.chips.replaceChildren();
        if (!rows.length) {
          const s = document.createElement("span");
          s.className = "bzdesk-empty";
          s.textContent = "参考素材请放入 H3 媒体架，并把媒体架的「参考素材」接到本节点";
          el.chips.append(s);
          /* 素材清空：编辑器词表/高亮也跟着重算 */
          edGlobal.refresh(); edSeg.refresh();
          return;
        }
        for (const r of rows) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "bzdesk-chip";
          if (r.kind === "image") {
            const im = document.createElement("img");
            im.src = previewURL(r.file);
            b.append(im);
          } else if (r.kind === "video") {
            const v = document.createElement("video");
            v.src = viewURL(r.file);
            v.muted = true; v.preload = "metadata"; v.playsInline = true;
            b.append(v);
          } else {
            const g = document.createElement("span");
            g.className = "glyph";
            g.textContent = "♪";
            b.append(g);
          }
          const l = document.createElement("span");
          l.className = "lbl";
          l.textContent = r.label;
          b.append(l);
          const sub = document.createElement("span");
          sub.className = "sub";
          sub.textContent = r.token;
          b.append(sub);
          /* 保住光标：mousedown 默认行为会把焦点从 textarea 抢走 */
          b.addEventListener("mousedown", (e) => e.preventDefault());
          /* 点击 = 每次都在光标处插一个引用（同一张图可引用多次，与 qwen 面板、
             设计注释"点一下就插进光标处"一致）。不再做"再点移除"开关——那会让
             第二次点击把刚插的引用删掉，表现为"引用一次后再也引用不了"。
             取消引用直接在文本里删 @图片N 即可。 */
          b.addEventListener("click", () => insert((st.alias && r.alias) ? r.alias : r.token));
          b.dataset.alias = r.alias || "";
          el.chips.append(b);
          chipEls.set(r.token, b);
        }
        paintChips();
        /* 素材集合变了：编辑器补全词表与 @ 高亮跟着重算 */
        edGlobal.refresh(); edSeg.refresh();
      }

      /* 素材条就绪兜底：媒体架往往比文案台晚 configure（764 扩展建图慢），
         而读档不触发 commit、首帧读到的是空架。主通道是媒体架 onConfigure 后
         广播的 bz:rack-change（见 onRackChange → renderChips），这里只做有限
         轮询兜底，防止事件丢失 / 节点先后错位导致素材条永久空。
         · 已渲染出 chip → 成功，停止；
         · 媒体架有素材但本面板没渲染 → 继续刷（renderChips 自带签名去重，
           空刷/重复刷不重建 DOM）；
         · 媒体架还没建 / 确实没素材 → 继续等到窗口结束（最长约 12s，覆盖
           慢建图）。节点创建与每次读档（onConfigure）都重新启动一轮。 */
      let chipKickTimer = null;
      let chipKickRetry = 0;

      /* ---- 段身份就绪兜底（20261022「刷新后提示词不见了」根因修复）----
         刷新/读档时三个节点的恢复顺序是「媒体架 / 文案台 → 导演台」：文案台
         第一轮 switchSeg 跑的时候导演台还没 configure，castProject() 返回
         null → 认不到段（k 为空）。原来的去重 `if (k === curKey) return;`
         在 k 与 curKey 同为空时**空转早退** —— 不清空（对），但也没有任何
         地方再叫醒它，于是文案台就一直停在空白（20261024 现场：库里的词
         明明都在，界面却是空的）。
         唤醒必须做成**拉取式**而不是广播式：广播可能早于对方订阅（广播在
         导演台 onConfigure 里发，订阅在文案台 onNodeCreated 里挂，谁先谁后
         取决于节点顺序），靠广播 = 碰运气。这里每 300ms 主动问一次导演台
         「当前段是谁」，拿到就重跑一次 switchSeg（它内部 syncFromCast 补
         段身份、再由 B1 对账把工程库里的词灌回来）。 */
      let segKickTimer = null;
      let segKickRetry = 0;
      /* 本轮 switchSeg 结束时"还需要再等"吗：段没认到（导演台还没就绪），
         或认到了但中央拉不到（片名还没同步，拉不回词）。真正空的段不算 ——
         那是用户还没写，不该一直轮询。 */
      let segNeedRetry = false;
      function kickSegUntilReady() {
        if (node.flags?.collapsed) return;
        if (segKickTimer) return;
        /* 上限 40 次 × 300ms ≈ 12s，覆盖慢建图；再久等下去也没意义
           （那时用户早该看到提示了，切一下段就能拉回来）。 */
        if (segKickRetry++ >= 40) { segKickTimer = null; segKickRetry = 0; return; }
        segKickTimer = setTimeout(() => {
          segKickTimer = null;
          const go = () => {
            void enqueueSwitch().then(() => {
              /* 这一轮还是没着落 → 继续等。 */
              if (segNeedRetry) kickSegUntilReady();
            });
          };
          /* 导演台还没上画布 → 继续等。 */
          if (castProject(node)) go(); else kickSegUntilReady();
        }, 300);
      }

      function kickChipsUntilReady() {
        if (node.flags?.collapsed) return;
        renderChips();
        if (root.querySelectorAll(".bzdesk-chip").length > 0) {
          chipKickRetry = 0;
          return;
        }
        if (chipKickRetry++ >= 40) { chipKickTimer = null; return; }
        if (chipKickTimer) clearTimeout(chipKickTimer);
        chipKickTimer = setTimeout(() => {
          chipKickTimer = null;
          kickChipsUntilReady();
        }, 300);
      }

      /** 亮 = 提示词里提到了 = 真的会送进参考；暗 = 没提，摆了也不会送。
          判定直接走共享纯函数 effectiveTags：先按与后端同一套规则归一化
          （<Picture N>、图片N、image 1 等都算显式引用），再按「别名模式」开关
          决定是否展开裸角色名。于是 chip 点亮的素材 == 导演台/后端实际发送的
          参考，杜绝"标签没亮、视频却被参考图带跑"。实时读编辑器，不依赖回写时机。 */
      function paintChips() {
        const all = [edGlobal.getText(), edSeg.getText()].join("\n");
        const { slots } = rackSlotsOf(node);
        const tags = effectiveTags(all, slots, st.alias);
        chipEls.forEach((b, token) => {
          const on = tags.has(token);
          b.classList.toggle("on", on);
          b.title = on
            ? `${token} · 已在提示词里（点一下可在光标处再插一次；取消就删掉文本里的 ${token}）`
            : `${token} · 点一下插到光标处（同一素材可引用多次）`;
        });
      }

      /* chip 点击只做「插入」（见上方绑定），同一张图可反复引用；
         亮/灭（chip 上的 .on）由 paintChips 按文本里出现次数自动反映，
         不再提供"再点一下移除"的开关。要取消引用，直接在文本里删 @图片N。 */

      /* ---- 两个提示词编辑器（片子级 / 本段）----
         高亮、@ 补全、悬停预览、纯文本回读都由 makePromptEditor 内置，文案台
         不再自绘高亮层、手写几何命中。词表共用 editorTokens（随媒体架/别名
         开关变化），onChange 直接拿纯文本；外部 setText 不回声。 */
      const onGlobalChange = (t) => { st.global = t; paintChips(); paintCheck(); commit(); };
      const onSegChange = (t) => {
        /* 编辑器此刻比段表新 —— 这是「收口写回」唯一被允许的情形。 */
        edSegDirty = true;
        /* 写段词必须用「编辑器画面绑定的段」（edSegKey，随每次 setSegText
           同瞬间切换），而不是 keyOf()。keyOf 读 st.chain.clip，syncFromCast
           会把它从后端拉回旧段 —— 段身份在前端乐观值与后端还没对账的窗口里，
           打字会写进上一段（「写第二段、存进了第一段」的根因，20261015）。
           20261025 方案A：curKey 也可能滞后（乐观首跳先换画面、正式流程才
           更新账），所以 edSegKey 优先。 */
        const k = edSegKey || curKey || keyOf();
        if (k) st.segs[k] = t;
        /* B1：段词**按 cid 增量**直推中央，这是权威写入。
           整包那条（scheduleDeskSave）仍走，用来存 presets/alias/global，
           但它现在过后端 _merge_desk 保护，不可能再抹掉任何一段已存的词。
           这里 allowEmpty=true：编辑框里剩下的就是用户意图，全删了就是真删。 */
        const nm = projName();
        if (nm && k) {
          /* retryOnConflict：编辑框里这份是**用户当下的意图**，不是过期副本 ——
             撞版本号时该赢的是它，换中央刚给的 rev 再押一次即可。 */
          pushSegText(nm, k, t, { allowEmpty: true, retryOnConflict: true })
            .then((r) => {
            /* 推送失败只影响跨会话持久化（本次执行用的是提交里的词，不受影响），
               但重启后会丢——仍要告诉用户。 */
            if (r === null && !segPushWarned[k]) {
              segPushWarned[k] = true;
              toast("⚠ 本段词没写进中央库——本次运行不受影响，但重启 ComfyUI 后这段词会丢失", true);
            } else if (r && r.conflict && !segPushWarned[k]) {
              /* 两次都撞 = 真并发（另一个窗口/节点也在改这一段）。
                 不硬盖：把中央真值收下，让用户自己看。 */
              segPushWarned[k] = true;
              st.segs[k] = r.text || "";
              toast("⚠ 本段词正在别处被改，已按中央库的版本刷新，请确认后再改", true);
            } else if (r !== null && !r.conflict && segPushWarned[k]) {
              segPushWarned[k] = false;
            }
          }).catch(() => {});
        }
        paintChips();
        paintCheck();
        commit();
      };
      /** 外部写入段词（切段装填 / 中央纠词 / 复制段 / 预设追加）。
          统一走这里：setText 不触发 onChange，写进去之后编辑器就**不比段表新**
          了 —— 必须把 edSegDirty 清掉，否则下一次巡检会以为"用户在编辑"，
          拿这份外部写入的内容反过来覆盖段表（盖上来的如果是别段的词，就是
          "两段词对调"）。 */
      function setSegText(t, caret, owner) {
        edSegDirty = false;
        /* 画面与段身份同瞬间绑定：owner 省略 = 调用方已把 curKey 切到位。 */
        edSegKey = owner === undefined ? (curKey || "") : String(owner || "");
        if (caret == null) edSeg.setText(t);
        else edSeg.setText(t, caret);
      }

      const edGlobal = makePromptEditor({
        cls: "d-global", mode: "desk", view: previewURL, tokens: editorTokens,
        placeholder: "例：写实电影感，35mm 胶片颗粒，自然光",
        onChange: onGlobalChange,
      });
      const edSeg = makePromptEditor({
        cls: "d-seg", mode: "desk", view: previewURL, tokens: editorTokens,
        placeholder: "例：@图片1 转过身，看向窗外，@音频1 起",
        onChange: onSegChange,
      });
      el.globalWrap.appendChild(edGlobal.node);
      el.segWrap.appendChild(edSeg.node);

      /* 提示词改写：开关与系统提示词都进 st，跟其它字段一起进 h3_data。
         系统提示词留空 = 后端用内置那段（钉住 <d> / [镜N] / 音效行 / @引用）。 */
      function paintRewrite() {
        el.rewriteSys.value = st.rewrite_system || "";
      }
      el.rewriteSys.oninput = () => { st.rewrite_system = el.rewriteSys.value; commit(); };
      el.rewriteModel.value = st.rewrite_model || "";
      el.rewriteModel.onchange = () => { st.rewrite_model = el.rewriteModel.value; commit(); };
      /* 候选来自后端（MOSS-Image 目录优先）。拉取失败时只留「默认」一项，
         改写照常可用，不让下拉拖垮主功能。 */
      (async () => {
        const put = (opts) => {
          el.rewriteModel.replaceChildren(...opts.map(([v, t]) =>
            Object.assign(document.createElement("option"), { value: v, textContent: t })));
          el.rewriteModel.value = st.rewrite_model || "";
        };
        try {
          const r = await api.fetchApi("/csglide_desk/models");
          const d = await r.json();
          const list = Array.isArray(d.models) ? d.models : [];
          const def = String(d.default || "");
          const base = (n) => n.replace(/\\/g, "/").split("/").pop();
          const opts = [["", "默认模型" + (def ? "（" + base(def) + "）" : "")]];
          for (const n of list) opts.push([n, base(n)]);
          // 存档里记的模型这次不在列表里（被删/改名）→ 保留显示，选它会在后端得到明确报错
          if (st.rewrite_model && !opts.some((o) => o[0] === st.rewrite_model))
            opts.push([st.rewrite_model, base(st.rewrite_model) + "（存档所选）"]);
          put(opts);
        } catch (_) { put([["", "默认模型"]]); }
      })();
      /* 改写结果/错误写进「提示词检查」框：toast 会被其它消息盖掉，
         检查框常驻且用户本来就会往这里看。用户一打字就会被正常检查刷新掉。 */
      function sayCheck(msg, bad) {
        el.checkSec.style.display = "";
        const item = document.createElement("div");
        item.className = "d-crow " + (bad ? "warn" : "ok");
        const b = document.createElement("b");
        b.textContent = "改写";
        const s = document.createElement("span");
        s.textContent = " " + msg;
        item.append(b, s);
        el.check.prepend(item);
      }

      /* 「立即改写」按钮：不走画布运行通道，直接调后端 HTTP 接口改写本段，
         结果写回编辑器并推中央库。成功后自动关掉「自动改写」——不关的话，
         下次画布运行会拿改写稿再改一遍，逐轮叠加跑偏。
         按钮 = 手动改一次；开关 = 每次画布运行都改。两者别同时生效。 */
      el.rewriteBtn.onclick = async () => {
        const k = edSegKey || curKey || keyOf();
        const t = (k && st.segs[k]) || "";
        if (!t.trim()) { sayCheck("本段还没有提示词，没有可改写的内容", true); return; }
        el.rewriteBtn.disabled = true;
        const old = el.rewriteBtn.textContent;
        el.rewriteBtn.textContent = "改写中…";
        try {
          /* 参考图由前端直传：读上游媒体架内存里的素材快照，
             不依赖序列化 widget，存盘格式再变也不会让改写拿到空清单。 */
          const slotIdx = (node.inputs || []).findIndex((s) => s && s.name === "参考素材");
          const rack = slotIdx >= 0 ? node.getInputNode?.(slotIdx) : null;
          const st = rack?.gmr?.st;
          const refs = st && st.slots
            ? JSON.stringify({ slots: st.slots, fps: st.fps || 0,
                               audio_out: st.audio_out || 0 })
            : "";
          const res = await api.fetchApi("/csglide_desk/rewrite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: t,
              system: st.rewrite_system || "",
              model: st.rewrite_model || "",
              refs,
            }),
          });
          /* 不能直接 res.json()：后端没就绪/路径不对时 aiohttp 回的是
             "404: Not Found" 这类纯文本，按 JSON 解析会报
             「Unexpected non-whitespace character after JSON at position 3」，
             用户根本看不出真实原因。先读文本再解析，失败就把状态码和原文片段
             摆进错误信息。 */
          const raw = await res.text();
          let d;
          try { d = JSON.parse(raw); }
          catch (_) { throw new Error(`HTTP ${res.status}：${raw.slice(0, 120)}`); }
          if (!res.ok || d.error) throw new Error(d.error || ("HTTP " + res.status));
          if (!d.text || d.text === t) { sayCheck("模型没有产出改动，本段保持原样"); return; }
          st.segs[k] = d.text;
          setSegText(d.text, null, k);
          const nm = projName();
          if (nm && k) pushSegText(nm, k, d.text, { allowEmpty: true, retryOnConflict: true });
          commit();
          /* 后端日志里的 ⚠（例如「本次没有参考图」）一并摆到检查框：
             这是改写质量的前置条件，用户不看日志就不知道。 */
          (d.logs || []).filter((x) => String(x).includes("⚠"))
            .forEach((w) => sayCheck(String(w).replace(/^⚠\s*/, ""), true));
          sayCheck(`已改写 ${d.text.length} 字并写回本段`);
        } catch (err) {
          sayCheck("改写失败：" + ((err && err.message) || err), true);
        } finally {
          el.rewriteBtn.disabled = false;
          el.rewriteBtn.textContent = old;
        }
      };


      /** 最后聚焦的编辑器；没聚焦过就插到本段（与 qwen 面板同一手法）。 */
      let lastEd = edSeg;
      edGlobal.node.addEventListener("focus", () => { lastEd = edGlobal; });
      edSeg.node.addEventListener("focus", () => { lastEd = edSeg; });

      /** 读编辑器内当前光标字符偏移（chip mousedown 已 preventDefault 保住焦点，
          此刻编辑器仍聚焦；TreeWalker 累加文本节点，与通用编辑器同口径）。 */
      function edCaret(ed) {
        const node = ed.node;
        const s = window.getSelection();
        if (!s || !s.rangeCount) return ed.getText().length;
        const r = s.getRangeAt(0);
        if (!node.contains(r.startContainer)) return ed.getText().length;
        let total = 0;
        const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          if (n === r.startContainer) return total + r.startOffset;
          total += n.textContent.length;
        }
        return ed.getText().length;
      }

      /** 插入到最后聚焦的编辑器光标处，前后按需补空格；没聚焦过插到本段。 */
      function insert(text) {
        const ed = lastEd || edSeg;
        if (ed.readonly()) return;
        const v = ed.getText();
        const pos = edCaret(ed);
        const needL = pos > 0 && !/\s$/.test(v.slice(0, pos)) ? " " : "";
        const needR = pos < v.length && !/^\s/.test(v.slice(pos)) ? " " : "";
        ed.insert(needL + text + needR);
        ed.focus();
      }

      function renderPresets() {
        el.presets.replaceChildren();
        (st.presets || []).forEach((p, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "bzdesk-preset";
          b.title = "追加到本段末尾";
          const t = document.createElement("span");
          t.className = "lbl";
          t.textContent = p;
          const x = document.createElement("span");
          x.className = "x";
          x.textContent = "✕";
          x.title = "删掉这条预设";
          /* 删除绑在 pointerdown：一点就删、✕ 随即移出 DOM，松开鼠标时
             click 落不到胶囊上 —— 不会出现「点删除反而把预设插进本段」。 */
          x.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            e.preventDefault();
            st.presets.splice(i, 1);
            renderPresets();
            commit();
          });
          b.append(t, x);
          b.addEventListener("click", () => {
            /* 追加到本段末尾（不是光标处）；setText 不触发 onChange，手动收口 */
            const cur = edSeg.getText();
            const next = (cur ? cur.replace(/\s*$/, "") + "\n" : "") + p;
            setSegText(next, next.length);
            onSegChange(next);
          });
          el.presets.append(b);
        });
        if (!(st.presets || []).length) {
          const s = document.createElement("span");
          s.className = "bzdesk-empty";
          s.textContent = "还没有预设 —— 写好一句话点「存预设」";
          el.presets.append(s);
        }
      }

      /* 打字收口已由两个编辑器的 onChange（onGlobalChange / onSegChange）负责，
         不再需要 textarea 时代的 onEdit 轮询两个框。 */

      /* ---- 提示词检查 ----
         这一块原先挂在导演台。但词在哪，检查就该在哪：在导演台看到"台词超时 /
         缺字段"却改不了词，只能记住警告再跑来改，警告等于白报。
         规则也不抄第二份（共用 csglide_prompt_check.js）—— 抄了迟早两边算出
         不一样的结论。
         片段时长这里拿不到（画布与帧数在导演台），传 0：共享模块会跳过时长那
         一项，不去报一个必然是红的"台词超出片段时长"。 */
      function paintCheck() {
        const text = [edGlobal.getText(), edSeg.getText()].join("\n").trim();
        const rows = promptCheck(text, 0);
        el.check.replaceChildren();
        rows.forEach((r) => {
          const item = document.createElement("div");
          item.className = "d-crow " + (r.state === "warn" ? "warn" : "ok");
          const b = document.createElement("b");
          b.textContent = r.label;
          const s = document.createElement("span");
          s.textContent = r.text;
          item.append(b, s);
          el.check.append(item);
        });
        /* 没查出问题就整块收掉：空着一条边框占位比没有更糟，用户会以为
           "有东西我没看见"。 */
        el.checkSec.style.display = rows.length ? "" : "none";
      }

      /** 切段：把当前框里的词先存进旧段，再换上新段的词。
          optimisticClip：导演台 cast 事件里**直接带来的目标段**。事件在
          setCurrent 的 POST 往返之前就到，此刻 bzStore.current 还是旧段，
          只靠 syncFromCast 读 store 首跳必然切不动（日志铁证：点第 2 段时
          bzStore.current=clip_0003 → 首跳停在旧段，要等 POST 回声才切）。
          事件 payload 是导演台刚广播的权威意图，直接采用；store 回声到达后
          仍会再跑一次 switchSeg 做后端权威校正（含锁定段被钉住的场景）。 */
      async function switchSeg(optimisticClip) {
        /* 独立模式（画布上没有导演台）：先向后端认段，拿到真 cid 再往下走。
           有导演台时这里什么都不做（castProjectSafe 缓存探测，不重复 warn）。
           认段是幂等的：已有 clip 直接返回，后端不可用也不会挡渲染。 */
        if (!optimisticClip && !(st.chain && st.chain.clip)) {
          try { await ensureSegIdentity(); } catch (_) {}
        }
        /* 导演台「新建整片」：代际 gen 变了，就把文案台整体清空（片子级 global、
           各段词 segs、段身份），只保留个人预设短语 presets。lastGen===null 的
           首次只记录、不清 —— 否则打开一部旧工程会把人存的词误清掉。 */
        const cp = castProject(node);
        if (cp) {
          const gen = Number(cp.gen) || 0;
          /* ⚠ gen 拿不到（0 / undefined）= 工程对象还没就绪 —— proj() 在
             properties 还没恢复时会造一个不带 gen 的空壳。这时**什么都不做**：
             既不能把它记成 lastGen（否则真实代际回来时 19 !== 0 会被判成
             "新建了整片"），更不能判定为换片子。
             这正是 20261022「刷新/重启后提示词闪一下就没了」的根因：词先被 B1
             从工程库灌进来，紧接着一次 switchSeg 撞上空壳拿到 gen=0，于是
             整份段词被静默清空（这个分支原来连日志都没有，控制台查不到痕迹）。 */
          if (!gen) {
            /* 代际未知，跳过本轮判定 */
          } else if (lastGen === null) {
            lastGen = gen;
          } else if (gen !== lastGen) {
            console.log("[联动] 文案台清空（新代际）:", lastGen, "->", gen,
              "片=" + (cp.name || ""), "原有段词 " + Object.keys(st.segs || {}).length + " 段");
            lastGen = gen;
            const keepPresets = st.presets;
            st = blankState();
            st.presets = keepPresets;
            paintRewrite();
            curKey = "";
            edSegKey = "";
            reconciledKey = "";
            edReady = false;
            edSegDirty = false;
            edGlobal.setText("");
            setSegText("", null, "");
            commit();
            renderPresets();
          }
        }
        /* 乐观首跳提前到任何 await 之前（20261024）：事件已带来目标段，先同步
           上屏，不等 syncFromCast / pullSegFor 的网络往返 —— 渲染后系统繁忙、
           store 不完整时 syncFromCast 会退回 HTTP，编辑器卡在旧段。
           ⚠ 20261025 方案A 收口：首跳必须「先存旧段 → 账与画面同一瞬间切」，
           而不是只换画面。只换画面时，下面正式流程的"存旧段"会把**新段**的
           词按旧段身份写回 st.segs 并推中央 —— 两段词对调、新段覆盖前段、
           全部渲染逐段切换时把整片搅乱，全是这一个时序 bug。
           目标段本地没词也照样切（切完显示空框，随后中央对账灌真词）：
           不切的话用户在 await 窗口里打的字会按旧段身份存进上一段。 */
        if (optimisticClip) {
          const ok0 = String(optimisticClip);
          if (ok0 !== curKey) {
            if (curKey && edReady) {
              st.segs[curKey] = edSeg.getText();
              const nmO = projName();
              if (nmO) pushSegText(nmO, curKey, st.segs[curKey]);
            }
            curKey = ok0;
            edReady = true;
            /* clip 只写真 cid（uid/临时键塞进 clip 会造出双身份，见 keyOf）。 */
            if (isRealCid(ok0)) {
              st.chain.clip = ok0;
              if (!st.chain.shot) st.chain.shot = ok0;
            }
            setSegText(st.segs[ok0] || "", null, ok0);
          }
        }
        await syncFromCast();
        let k = optimisticClip ? String(optimisticClip) : keyOf();
        /* 乐观首跳：store 还停在旧段、syncFromCast 把 st.chain.clip 写成了旧值，
           这里必须改写成事件带来的目标段，否则随后 commit 落盘的 desk_data
           chain.clip 仍是旧段，渲染提交会拿错提示词。 */
        if (optimisticClip && k && isRealCid(k)) {
          st.chain.clip = k;
          if (!st.chain.shot) st.chain.shot = k;
        }
        if (k === curKey && k === reconciledKey) {
          refreshSegChip();
          /* 认不到段（k 为空）= 导演台还没就绪 / 本段还没登记 clip。
             这里**不能就此躺平**：早退只保证"不把空编辑框当用户清空写回"，
             段身份还得有人去取 —— 挂兜底轮询，导演台一就位就自动认段、
             把工程库里的词灌回来（见 kickSegUntilReady）。 */
          if (!k) { segNeedRetry = true; kickSegUntilReady(); }
          return;
        }   // 已在本段且已对过账，去重不重复刷
        /* 乐观首跳已把账切到目标段并当场存过旧段；这里只在「账还没切」的
           正常路径存旧段。curKey===k 时再存一遍是无害重复，跳过。 */
        if (curKey && edReady && curKey !== k) {
          st.segs[curKey] = edSeg.getText();
          /* 离开旧段：把旧段词补回中央（空不覆盖，防竞态抹词）。 */
          const nm0 = projName();
          if (nm0) pushSegText(nm0, curKey, st.segs[curKey]);
        }
        /* 编辑器先装填、段身份后就位 —— 顺序不能反（20261017 根因修复）。
           反过来的顺序是「先赋 curKey，再 await pullSegFor 网络往返填编辑器」，
           中间那段窗口里 curKey 已命中新段、edSeg 却还是空的，任何一次
           segWords(curKey) / composedWords(curKey)（巡检每 3 秒一次）都会
           把空编辑框当成「用户清空了本段」写回 st.segs，把刚从工程库灌进来
           的段词抹掉。pullSegFor 问不到中央时没人纠正，画布就永久少一段词。
           setText 不走 onChange（见 csglide_prompt_editor.js「外部写入」），
           提前填不会触发 commit 回声。 */
        if (k) setSegText(st.segs[k] || "", null, k);
        curKey = k;
        edReady = !!k;
        console.log("[联动] 文案台 switchSeg 切换:", k);
        /* B1：**先问中央这一段到底是什么词，再显示。**
           以前只信本地 st.segs —— 刷新页面后它是空的，于是「第二段变空白」。
              · 中央有词 → 以中央为准（它才是权威）；
              · 中央没词而本地有 → 本地是用户刚打进去的，以本地为准并立刻
                补回中央，否则一刷新又没了。 */
        const central = isRealCid(k) ? await pullSegFor(k) : null;
        /* 临时键（新段还没登记）不去问中央：它不是段身份，问了只会让后端给
           一个不存在的 cid 现场补建 binding，反而造出一条假档案行。 */
        /* 无条件打：以前只在"不一致"时打，一致就静默，用户根本看不出 B1 在跑。
           这条是 B1 的**心跳** —— 控制台搜 "[B1]" 没有它，就是没生效。 */
        console.log("[B1] 段词对账:", k,
                    "中央=" + (central ? ((central.desk_text || "").length + "字") : "没拿到"),
                    "本地=" + ((st.segs[k] || "").length + "字"));
        if (central && typeof central.desk_text === "string" && central.desk_text) {
          if ((st.segs[k] || "") !== central.desk_text) {
            console.log("[B1] 段词以中央为准:", k,
                        "中央", central.desk_text.length, "字 / 本地",
                        (st.segs[k] || "").length, "字");
          }
          st.segs[k] = central.desk_text;
        } else if (central && k && (st.segs[k] || "")) {
          const nm1 = projName();
          if (nm1) pushSegText(nm1, k, st.segs[k]);
        }
        /* 没认到段就**不要**清空 —— 画布上还没有导演台时
           用户照样能在里面写词，一清空就把人正在写的东西抹了。 */
        if (k) setSegText(st.segs[k] || "", null, k);   // 二次刷：中央纠正过就用纠正后的
        edReady = !!k;                            // 编辑器与 st.segs 此刻同文
        /* 本段已与中央对过账：之后的重复事件（store 回声）在 k===curKey 时
           直接去重早退；没对过账的（乐观首跳刚换完画面）必须走完上面流程。 */
        reconciledKey = k;
        /* 段认到了、中央却拉不到（片名还没同步 / 请求失败）且本地也没词 →
           界面此刻是空的。挂兜底轮询，等导演台就位再拉一次：中央才是权威，
           这一段早晚会自己回来（20261024 现场：库里明明有词，界面一直空白）。 */
        segNeedRetry = !!(k && !central && !(st.segs[k] || ""));
        if (segNeedRetry) kickSegUntilReady();
        refreshSegChip();
        paintChips();
        paintCheck();        // 换段 = 换了一段词，检查跟着换
        /* 切段必须落盘 desk_data：后端读的是 widget 里的 chain.clip 来认段，
           只改内存 st 不写 widget，渲染提交（graphToPrompt）拿到的还是旧段
           —— 三段渲染全用同一段的提示词（20261012 渲染日志铁证：
           第 2 段渲染时文案台输出「段 clip_0003」）。 */
        commit();
      }

      /** 中央工程状态层（projectStore）按段身份读本段段词。
          若此刻正编辑该段，先把编辑器最新文本收口再返回。 */
      function getSegWords(key) {
        if (!key) return "";
        key = String(key);
        /* 只在"用户确实在编这一段、且编完之后没被外部写入覆盖"时才收口。
           edSegDirty 那一位是必须的：没有它，任何一次中央纠词/读档灌库之后，
           这份过时的编辑框内容都会把权威段词盖回去（盖回去的可能是上一段）。 */
        if (curKey && curKey === key && edReady && edSegDirty) st.segs[key] = edSeg.getText();
        return String(st.segs[key] || "");
      }

      /** 与后端 csglide_desk.compose_text **逐字同口径**的「片子级 + 本段」组合：
          片子级（global）在前、本段（seg）在后，去掉行尾空白并给相邻 @标签补空格。
          这是导演台外接文案台时**真正会发送**的文本。导演台 effPrompt 不再用
          "最长字符串 widget" 启发式（那会把整段 desk_data JSON 当成提示词，于是
          预览/自检把别的段的 @图片N 也算进来）。key 为段 clip id；不传只出片子级。
          按段身份直接读 st.segs[key]，不依赖文案台 UI 此刻停在哪一段（广播切段
          是异步的，渲染循环里导演台已切段、文案台还没跟上时也读得对）。 */
      function composedWords(key) {
        // global 全片唯一，编辑器里始终是它，先收口一次拿到最新输入。
        if (edGlobal) st.global = edGlobal.getText();
        let seg = "";
        if (key) {
          const k = String(key);
          if (curKey && curKey === k && edReady && edSegDirty) st.segs[k] = edSeg.getText();
          seg = String(st.segs[k] || "");
        }
        const clean = (t) => String(t || "").replace(/\r\n/g, "\n")
          .replace(/[ \t]+\n/g, "\n").trim();
        const parts = [clean(st.global), clean(seg)].filter(Boolean);
        return parts.join("\n").replace(
          /(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)/g, "$1 ");
      }

      /** 复制段时把源段段词照抄到新段（导演台 duplicateShot 调用）。
          缺这一步，复制段切过来时编辑器读 st.segs[新cid] 是空的 —— 文案没复制。
          若此刻正编辑源段，先把编辑器最新文本收口；已在目标段则同步上屏。 */
      function copySegWords(srcCid, dstCid) {
        if (!dstCid) return false;
        srcCid = srcCid ? String(srcCid) : "";
        dstCid = String(dstCid);
        if (curKey && curKey === srcCid && edReady && edSegDirty) st.segs[srcCid] = edSeg.getText();
        const words = srcCid ? String(st.segs[srcCid] || "") : "";
        st.segs[dstCid] = words;
        if (curKey === dstCid) setSegText(words);
        refreshSegChip();
        commit();
        return true;
      }

      /** 临时段身份（shot.id）升级成真实 clip id（registerShot 拿到 id 后调用）。
          把先前抄到临时身份的段词搬到 clip id；若此刻正停在临时身份，连人一起切。
          没有临时段词也不影响（addShot 新段本来就是空）。 */
      function claimSegWords(tempId, clipId) {
        if (!clipId) return false;
        tempId = tempId ? String(tempId) : "";
        clipId = String(clipId);
        if (curKey && curKey === tempId && edReady && edSegDirty) st.segs[tempId] = edSeg.getText();
        let words = "";
        if (tempId && st.segs[tempId] != null) words = String(st.segs[tempId] || "");
        if (tempId && tempId !== clipId) delete st.segs[tempId];
        st.segs[clipId] = words;
        if (curKey === tempId || curKey === clipId) {
          curKey = clipId;
          setSegText(words);
        }
        refreshSegChip();
        commit();
        return true;
      }

      /* 输入 / 高亮 / 悬停预览 / 滚动全部由两个 makePromptEditor 实例内置：
         输入经 onGlobalChange / onSegChange 收口，@ 补全、.tok 高亮、悬停缩略图
         都在编辑器内部，文案台不再挂 textarea 事件、自建 toktip 几何命中。 */

      /* 别名模式：开 = 名字（小明）直接当引用，在本段里高亮、标签插入名字；
         关 = 只认 @图片N。真正把名字换成 <Picture n> 是导演台后端做的，
         这个开关只管文案台怎么显示和怎么写。 */
      const paintAlias = () => {
        el.alias.textContent = `别名：${st.alias ? "开" : "关"}`;
      };
      el.alias.addEventListener("click", () => {
        st.alias = !st.alias;
        paintAlias();
        renderChips();       // 重新插入：开/关切换后 chip 点击插入的写法变了
        commit();
      });

      el.save.addEventListener("click", () => {
        const t = edSeg.getText().trim();
        if (!t) return;
        if (!st.presets.includes(t)) st.presets.push(t);
        renderPresets();
        commit();
      });

      /* 联动零轮询（20261012 方案B）：
         · 导演台本地切段/新建 → bz:cast-seg-change 即时响应；
         · 媒体架 commit → bz:rack-change 即时刷 chips；
         · 后端档案 current/段账变化（含跨标签页、工作流执行中登记）
           → bzStore film 事件即时 switchSeg。
         renderChips 与 switchSeg 各自带签名去重，重复触发零重建。 */
      /* 快速连点时 cast/store 事件会瞬间到达多个，switchSeg 是 async
         （内含 await syncFromCast），并发执行会交错读写 curKey / st.segs，
         把旧段的词存进新段。用一条链把切段严格串行化（20261012 连点串段）。 */
      let segChain = Promise.resolve();
      const enqueueSwitch = (clip) => {
        segChain = segChain.then(() => switchSeg(clip)).catch(() => {});
        return segChain;
      };
      const pollOnce = async (optimisticClip) => {
        if (node.flags?.collapsed) return;
        renderChips();
        await enqueueSwitch(optimisticClip);
      };
      /* store 订阅随片名切换（新建/打开工程 cast 事件里重新挂） */
      let storeName = "";
      let offStore = null;
      const ensureSub = () => {
        const cp = castProject(node);
        const name = (cp && cp.name) || "";
        if (name === storeName) return;
        if (offStore) { try { offStore(); } catch (_) {} offStore = null; }
        storeName = name;
        if (!name) return;
        offStore = bzStore.subscribe(name, (d) => {
          if (node.flags?.collapsed || d.immediate) return;
          void enqueueSwitch();
        });
      };
      ensureSub();
      const offCast = onCastChange((d) => {
        console.log("[联动] 文案台收到", d.reason || "?", "name=" + (d.name || ""), "clip=" + (d.clip || ""), "折叠=" + !!node.flags?.collapsed);
        if (node.flags?.collapsed) { console.warn("[联动] 文案台跳过: 节点折叠"); return; }
        const cp = castProject(node);
        if (!cp || d.name !== cp.name) { console.warn("[联动] 文案台跳过: 名字不匹配 d.name=" + (d.name || "") + " cp.name=" + (cp && cp.name || "无")); return; }
        ensureSub();
        /* 段没变 → pollOnce 里的 renderChips 会整条重建素材条（几十个 chip），
           而 switchSeg 进去也是空转早退。这一条广播没有新信息就跳过
           （20261022）；段词为空的自救另有 kickSegUntilReady 轮询兜底。 */
        const target = d.clip || d.shot || "";
        if (target && String(target) === String(curKey)) {
          console.log("[联动] 文案台跳过: 段没变", target);
          return;
        }
        /* 事件带了目标段就直接乐观切过去（首跳不等 store）。复制/新建段第一次
           广播时 clip 还没登记，但带了临时 shot.id —— 用它先切、段词已提前抄好，
           不用等 add_clip 网络往返（消除"慢一拍"）。 */
        void pollOnce(target);
      });
      const offRack = onRackChange((d) => {
        if (node.flags?.collapsed) return;
        const w = rackNodeOf(node);
        if (w && d.node != null && w.id !== d.node) return;
        renderChips();
      });

      /* ---- 提示词文档直接拖进来（20261022）----
         文档里用 <<<视频提示词>>> … <<<视频提示词_END>>> 把要用的那一段包起来。
         拖一个 → 写当前段；拖多个 → 按文件名里的段号（SEG_6_prompt.txt → 第 6 段）
         分别写进对应段。省掉「打开文档 → 找块 → 复制 → 切回粘贴」四步。 */
      const DOC_BEGIN = "<<<视频提示词>>>";
      const DOC_END = "<<<视频提示词_END>>>";

      /** 取文档里的「视频提示词」块。没有这个包裹符就整篇都当提示词用 ——
          老格式文档没有包裹符，宁可整篇读进来也不能什么都不干。 */
      function pickVideoBlock(text) {
        const s = String(text || "");
        const a = s.indexOf(DOC_BEGIN);
        if (a < 0) return s.trim();
        const from = a + DOC_BEGIN.length;
        const b = s.indexOf(DOC_END, from);
        return (b < 0 ? s.slice(from) : s.slice(from, b))
          .replace(/^\s*\n/, "").replace(/\s+$/, "");
      }

      /** 文件名里的段号：SEG_6_prompt.txt → 6；认不出返回 0。 */
      function segNoOfFile(name) {
        const m = String(name || "").match(/SEG[_\-\s]*(\d+)/i);
        if (m) return Number(m[1]);
        const d = String(name || "").match(/(\d+)/);
        return d ? Number(d[1]) : 0;
      }

      /** 第 N 段（1-based）的 clip id。
          段列表以导演台的 shots 为准 —— 后端 clips[].index 实测返回
          2,2,3,4,5,6,7,8（前两段重复），拿它当段号会错位。 */
      function clipOfSeg(no) {
        const cp = castProject(node);
        const p = cp && cp.cast && cp.cast.properties
          && cp.cast.properties.gcast_project;
        const shots = (p && p.shots) || [];
        const s = shots[no - 1];
        return (s && s.clip) || "";
      }

      let toastTimer = 0;
      function toast(msg, bad) {
        el.toast.textContent = msg;
        el.toast.style.display = "";
        el.toast.classList.toggle("bad", !!bad);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.toast.style.display = "none"; }, bad ? 9000 : 5000);
      }
      /** 带按钮、不自动消失的确认条（多段写入会覆盖，不能闷头就写）。 */
      function toastConfirm(msg, btnText, onYes) {
        clearTimeout(toastTimer);
        el.toast.classList.remove("bad");
        el.toast.textContent = msg;
        const b = document.createElement("button");
        b.className = "d-btn";
        b.type = "button";
        b.textContent = btnText;
        b.onclick = () => { el.toast.style.display = "none"; onYes(); };
        el.toast.append(b);
        el.toast.style.display = "";
      }

      /** 把一段词写进某一段（本段顺带刷新编辑器），并落工程库。 */
      function writeSeg(cid, text) {
        if (!cid) return false;
        st.segs[cid] = text;
        if (cid === curKey) setSegText(text);
        const nm = projName();
        if (nm) pushSegText(nm, cid, text, { allowEmpty: true, retryOnConflict: true });
        commit();
        return true;
      }

      async function readDocFiles(fileList) {
        const files = Array.from(fileList || [])
          .filter((f) => /\.(txt|md)$/i.test(f.name || ""));
        if (!files.length) { toast("拖进来的不是 .txt / .md 文档", true); return; }
        const items = [];
        for (const f of files) {
          let body = "";
          try { body = pickVideoBlock(await f.text()); } catch (_) { body = ""; }
          if (body) items.push({ name: f.name, body, no: segNoOfFile(f.name) });
        }
        if (!items.length) { toast("这些文档里没读到内容", true); return; }

        /* 单个文档 → 直接写当前段（编辑器里可见，写错了 Ctrl+Z 能撤回）。 */
        if (items.length === 1) {
          const cid = curKey || keyOf();
          if (!cid) { toast("还没认到当前段（导演台没就绪？先点一下段再拖）", true); return; }
          writeSeg(cid, items[0].body);
          toast(`已读入《${items[0].name}》· ${items[0].body.length} 字 → 已替换本段`);
          return;
        }

        /* 多个文档 → 按段号分别写入，先列清单确认。 */
        const plan = [];
        for (const it of items) {
          const cid = clipOfSeg(it.no);
          if (!cid) {
            toast(`《${it.name}》认不出段号（文件名里要有 SEG_6 这样的段号），已取消整批`,
              true);
            return;
          }
          plan.push({ ...it, cid });
        }
        const brief = plan
          .map((p) => `${p.name.replace(/\.(txt|md)$/i, "")}→第${p.no}段(${p.body.length}字)`)
          .join("、");
        toastConfirm(`读到 ${plan.length} 个文档：${brief}`,
          `确认写入 ${plan.length} 段`,
          () => {
            let n = 0;
            for (const p of plan) if (writeSeg(p.cid, p.body)) n += 1;
            toast(`已写入 ${n} 段：` + plan.map((p) => `第${p.no}段`).join("、"));
          });
      }

      /* 拖放：只认文件（图片/素材走媒体架，不在这里抢）。 */
      const dragHasFile = (e) => {
        const t = e.dataTransfer;
        if (!t) return false;
        if (t.items && t.items.length) {
          for (const it of t.items) if (it && it.kind === "file") return true;
        }
        return !!t.files;
      };
      root.addEventListener("dragover", (e) => {
        if (!dragHasFile(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        root.classList.add("dropping");
      });
      root.addEventListener("dragleave", (e) => {
        if (!e.relatedTarget || !root.contains(e.relatedTarget)) root.classList.remove("dropping");
      });
      root.addEventListener("drop", (e) => {
        if (!dragHasFile(e)) return;
        e.preventDefault();
        e.stopPropagation();
        root.classList.remove("dropping");
        void readDocFiles(e.dataTransfer && e.dataTransfer.files);
      });

      const onRemoved = nodeType.prototype.onRemoved;
      node.onRemoved = function () {
        if (offStore) { try { offStore(); } catch (_) {} offStore = null; }
        try { offCast(); offRack(); } catch (_) {}
        /* 停掉素材条就绪兜底轮询，避免节点销毁后定时器残留 */
        if (chipKickTimer) { clearTimeout(chipKickTimer); chipKickTimer = null; }
        if (segKickTimer) { clearTimeout(segKickTimer); segKickTimer = null; }
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0; }
        /* 摘掉补全列表 / 悬停浮窗与 document 监听，避免节点销毁后残留 */
        try { edGlobal.destroy(); edSeg.destroy(); } catch (_) {}
        return onRemoved?.apply(this, arguments);
      };

      const w = node.addDOMWidget("desk_ui", "div", root, {
        serialize: false, hideOnZoom: false,
      });
      /* 报固定小值 minHeight（不是内容高）：前端拖拽以 node.computeSize()
         （各 widget minHeight 之和）做下限钳制，报内容峰值节点就永远拖不矮。
         报小值 + maxHeight 无限，布局让面板填满节点主体，收短后内容在面板里
         滚动、不塌陷。 */
      w.computeLayoutSize = () => ({ minHeight: MIN_FLOOR_H, maxHeight: void 0, minWidth: 0 });

      /* 建节点/读档后长一次，给个装得下内容的起点（只增不减）；此后不再自动
         改高，高度全归用户。scrollHeight 取内容实高，offsetHeight 兜底。 */
      const fit = () => {
        requestAnimationFrame(() => {
          if (node.flags?.collapsed) return;
          const contentH = Math.ceil(Math.max(root.scrollHeight || 0, root.offsetHeight || 0));
          if (!contentH) return;
          const head = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
          const needH = head + 2 + contentH + 6;
          if (needH > (node.size?.[1] || 0) + 1) node.setSize?.([node.size[0], Math.ceil(needH)]);
        });
      };
      /* DOM widget 的包裹层设 none，点击才能落回画布；面板根恢复 auto，
         内部子元素照常可点（与媒体架同一手法）。 */
      requestAnimationFrame(() => {
        const wrap = root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
      });

      edGlobal.setText(st.global || "");
      paintAlias();
      switchSeg();
      renderChips();
      renderPresets();
      paintChips();
      paintCheck();
      /* 立刻再同步一次：castProject 要等画布上导演台节点建好才拿得到，
         建面板这一刻往往还没有。用 setTimeout 而非 rAF：标签页在后台时
         rAF 被暂停，素材条兜底会整段不启动（setTimeout 后台仍执行）。 */
      setTimeout(async () => {
        await switchSeg();
        /* 素材条就绪：先刷一次，再由 kickChipsUntilReady 兜底到媒体架就绪；
           主通道是媒体架 onConfigure 广播的 bz:rack-change（见 onRackChange）。 */
        kickChipsUntilReady();
      }, 0);
      node.setSize?.([MIN_W, MIN_H]);
      fit();

      /* 工程库启动灌库（hydrate）：用库里的文案整份替换内存，再重绘。
         chain（片名/段身份）以导演台与后端当前值为准，不被库存档里的旧
         chain 带偏——只恢复 global/segs/alias/presets 这些文案内容。 */
      const hydrateDesk = (desk) => {
        if (!desk || typeof desk !== "object") return false;
        deskHydrateUntil = Date.now() + 2000;   // 抑制 hydrate 触发的 commit 回写
        const incoming = JSON.parse(JSON.stringify(desk));
        const chain = Object.assign({}, st.chain || {}, incoming.chain || {});
        st = Object.assign(blankState(), incoming, { chain });
        paintRewrite();
        if (!dataWidget) dataWidget = node.widgets?.find((w) => w.name === "desk_data");
        if (dataWidget) dataWidget.value = JSON.stringify(st);
        curKey = "";
        edSegKey = "";        // 编辑器内容与段身份的绑定作废（方案A）
        reconciledKey = "";   // 旧对账记录作废，新段必须重新问中央
        edReady = false;      // 编辑框尚未装填新词，禁止任何收口写回
        edSegDirty = false;   // 脏位同理作废：编辑器内容与段表已无对应关系
        lastGen = null;
        edGlobal.setText(st.global || "");
        paintAlias();
        renderPresets();
        /* 走串行链，不裸调 switchSeg：hydrate 之后 replayCurrent 会紧接着
           broadcastSeg("hydrate") 触发另一路 enqueueSwitch。两路 switchSeg
           并发执行就会交错读写 curKey / st.segs / edSeg（作者在 964 行的
           注释里已经点出这个风险，只是 hydrate 这条没接进来）。 */
        enqueueSwitch();
        renderChips();
        paintChips();
        paintCheck();
        console.log("[状态库] 文案台 hydrate 完成: 段词=" + Object.keys(st.segs || {}).length
          + " 全局=" + ((st.global || "").length) + "字");
        return true;
      };

      node.deskUI = {
        root,
        BAG_VERSION: BZ_BAG_VERSION,
        hydrate: hydrateDesk,
        refresh() { renderChips(); switchSeg(); paintChips(); },
        segWords: getSegWords,
        composedWords,
        copySeg: copySegWords,
        claimSeg: claimSegWords,
        /* ---- 编译式渲染的只读快照（bz_prompt_build.js 用）----
           与 segWords 的差别就一条：**不读编辑器、不回写段表**。
           segWords 是给「实时预览」用的，它会把编辑框里的文本收口进 st.segs；
           编译期一旦有这种副作用，一个还没刷新的编辑框就能把权威段词盖掉，
           而且盖回去的可能是上一段的词。这里只把段表原样交出去。 */
        snapshot() {
          if (edGlobal) st.global = edGlobal.getText();
          return {
            global: String(st.global || ""),
            segs: JSON.parse(JSON.stringify(st.segs || {})),
            alias: st.alias === true,
            chain: { name: String((st.chain && st.chain.name) || ""),
                     clip: String((st.chain && st.chain.clip) || "") },
            curKey: String(curKey || ""),
          };
        },
      };

      /* ---- 刷新网页 / 读档时恢复内容 ----
         onNodeCreated 建面板时 desk_data 还是空的（工作流保存值要等 configure
         才填进来），不在这里重读一次，面板就是空白；再一编辑还会把空白写回
         desk_data，把人存的内容真抹掉。与导演台 / 媒体架同一套做法。 */
      const onConfigure = nodeType.prototype.onConfigure;
      node.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        if (dataWidget) {
          try { st = Object.assign(blankState(), JSON.parse(dataWidget.value || "{}")); }
          catch { st = blankState(); }
          paintRewrite();
        }
        curKey = "";              // 旧段身份作废，让 switchSeg 重新认段
        edSegKey = "";            // 编辑器绑定作废（方案A：等 switchSeg 重新绑）
        reconciledKey = "";       // 旧对账记录作废，读档必须重新问中央
        edReady = false;          // 编辑框内容同步作废：此时收口写回会把旧段文本存进新段
        edSegDirty = false;       // 旧段的待收口文本绝不能跟着进新段
        lastGen = null;           // 代际也重新认识，避免读档后被误判为「新建」
        segKickRetry = 0;         // 读档 = 新一轮等待，兜底轮询的额度重置
        edGlobal.setText(st.global || "");
        paintAlias();             // 别名开关要跟着存档一起回来
        /* 恢复时以**自己存的段身份**为准（20261023 骨架修复）。
           后端 compose 认段用的就是 desk_data 里的 chain.clip
           （见 csglide_desk.py：cid = st["chain"]["clip"]），刷新必须重现保存
           那一刻的编辑目标。以前这里调无参 switchSeg，于是同步去问中央
           current：它常常已经指着**另一段**（导演台后来切过 / 渲染登记过），
           而那一段本地没词，界面就成了空白 —— 抢没抢到取决于谁先 configure，
           这就是「刷新没了、再刷一下又有」。
           把自己的 clip 作为本轮目标段传进去，走的正是「事件带来的权威意图」
           那条既有通道（见 switchSeg 的 optimisticClip），不用新增开关。
           不是真 cid（新段还挂着临时键）就照旧交回原逻辑，别把 uid 写成 clip。
           切段跟随不受影响：那条路本来就是事件带着目标段进来。 */
        switchSeg(isRealCid(st.chain.clip) ? st.chain.clip : "");
        renderPresets();
        paintChips();
        paintCheck();
        /* 读档（reload / loadGraphData）后媒体架通常比文案台晚 configure：
           立即刷一次，再交给 kickChipsUntilReady 兜底（媒体架 onConfigure 也会
           广播 bz:rack-change 走主通道）。否则素材条在慢建图后永久空着。
           用 setTimeout 而非 rAF，后台标签页也能启动。 */
        setTimeout(() => kickChipsUntilReady(), 0);
        return r;
      };
      return r;
    };
  },
});
