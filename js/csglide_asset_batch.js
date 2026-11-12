/**
 * 🎨 图像编辑台 · 资产提示词批量导入
 * ------------------------------------------------------------------
 * 文档格式（祖龙锁那套，纯文本规则即可切，不需要 AI）：
 *
 *   ## @图片9 = 守缺斋前堂
 *   <<<场景提示词>>>
 *   场景标题名称：守缺斋前堂
 *   …正文…
 *   <<<场景提示词_END>>>
 *
 * 为什么走前端派发、不新增后端节点：ComfyUI 一次执行 = 一张图，
 * 13 个提示词只能拆成 13 个 job。项目里已有 api.queuePrompt 的成熟用法
 * （csglide_cast_run.js、csglide_cast_review.js），这里复用同一口径，
 * 不重复造提交链路。
 *
 * 批量只改「提交对象」，不改画布上的 qwen_data —— 跑完面板仍是你原来那段
 * 提示词。这样不会把用户手写的内容覆盖掉，也避免跑一半时面板跳来跳去。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* 资产节标题两种已知产出：旧版「## @图片N = 名字」、新版技能的裸行「@图片N = 名字」
   （按集组织的文件没有 ## 前缀）。前缀整体可选，# 层数 1~4 都认；
   正文行有 "- " 列表前缀、或不含「图片N + 分隔符」的都不会误匹配。 */
const SECTION = /^(?:#{1,4}\s*)?@?图片\s*(\d+)\s*[=＝:：]\s*(.+?)\s*$/;
const TAG = /^<<<(.+?)>>>\s*$/;
/* 包裹符内的内层：标题、画幅这些只给程序看，不进正文。
   进了正文的话，生图模型会把「主体标题名称：陈墨白」当画面文字画出来。 */
const META_TAG = "元信息";
const META_END = "元信息_END";
const SAVE_RE = /SaveImage|SaveAnimatedWEBP|SaveVideo|SaveAudio/i;
const COMBINE_CLASS = "banzhangVideoCombine";   // 本项目「🎥 视频合并」
/* 必须是完整注册名。写短了（"CSGlideImageCast"）会让 injectGlobals 里的
   class_type 比对永远不成立 —— 片子级（LoRA 触发词）在批量路径上静默不生效。 */
const CAST_CLASS = "CSGlideImageCastCS";        // 图像编辑台

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

const CSS = `
/* 浮层，不是 flex 子项。
   .gcast 是 flex column + height:100%，任何占高度的子项一展开就会抢走提示词框
   （flex:1 1 auto; min-height:190px）的空间，框内文字溢出自身盒子后与相邻元素叠在一起。
   绝对定位不参与布局，从根本上不会挤压任何东西。 */
.gqb { position:absolute; left:10px; right:10px; bottom:10px; z-index:40;
  display:none; max-height:calc(100% - 20px); overflow:auto;
  background:var(--h3-panel); border:1px solid var(--h3-line); border-radius:10px;
  padding:8px 10px; box-sizing:border-box; }
.gqb.on { display:block; }
.gqb-head { display:none; align-items:center; gap:8px; padding:0 2px 6px; font-size:12px;
  color:var(--h3-dim); }
.gqb-head.on { display:flex; }
.gqb-head.dropping { color:var(--h3-accent); }
.gqb-name { font-weight:500; color:var(--h3-txt); }
.gqb-count { margin-left:auto; }
.gqb-btn { all:unset; cursor:pointer; font-size:12px; padding:2px 8px; border-radius:6px;
  border:1px solid var(--h3-line); color:var(--h3-txt); }
.gqb-bar { display:flex; flex-wrap:wrap; gap:6px; padding-top:2px; }
.gqb-btn:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gqb-btn[disabled] { opacity:.45; cursor:default; }
.gqb-btn.primary { border-color:var(--h3-accent); color:var(--h3-accent); }
.gqb-list { display:none; max-height:210px; overflow:auto; border:1px solid var(--h3-line);
  border-radius:8px; background:var(--h3-well); padding:2px 0; margin-bottom:6px; }
.gqb-list.on { display:block; }
.gqb-item { display:flex; align-items:center; gap:8px; padding:3px 8px; font-size:12px;
  cursor:pointer; color:var(--h3-txt); }
.gqb-item:hover { background:var(--h3-raise); }
.gqb-item input { accent-color:var(--h3-accent); }
.gqb-tag { font-size:11px; color:var(--h3-dim); border:1px solid var(--h3-line);
  border-radius:5px; padding:0 4px; }
.gqb-size { margin-left:auto; font-size:11px; color:var(--h3-dim); }
.gqb-note { display:none; font-size:12px; line-height:1.5; padding:4px 0; color:var(--h3-dim); }
.gqb-note.on { display:block; }
.gqb-note.bad { color:#e2564a; }
`;

function ensureCSS() {
  if (document.getElementById("gqb-css")) return;
  const s = document.createElement("style");
  s.id = "gqb-css";
  s.textContent = CSS;
  document.head.append(s);
}

/* ---------------- 解析 ---------------- */

/** 把一个文档切成若干资产：{no, name, type, body}。 */
export function parseAssetDoc(text) {
  const out = [];
  let cur = null;
  let buf = null;
  let open = null;
  let meta = null;           // 非空 = 正在收集元信息层
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const mSec = line.match(SECTION);
    if (mSec) {
      cur = { no: Number(mSec[1]), name: mSec[2].trim(), type: "", body: "", meta: "" };
      out.push(cur);
      buf = null;
      open = null;
      meta = null;
      continue;
    }
    /* 「## 变更记录」这类非资产节：直接丢掉上下文，别把表格当提示词 */
    if (/^##\s/.test(line)) { cur = null; buf = null; open = null; meta = null; continue; }
    if (!cur) continue;
    const mTag = line.match(TAG);
    if (mTag) {
      const t = mTag[1].trim();
      /* 内层必须先判：`元信息_END` 也以 _END 结尾，落到下面的通用分支
         就会被当成外层收尾，正文从此截断。 */
      if (t === META_TAG) { meta = []; continue; }
      if (t === META_END) {
        cur.meta = meta.join("\n").trim();
        meta = null;
        continue;
      }
      if (!open) {
        open = t;
        buf = [];
        if (!cur.type) cur.type = t.replace(/提示词.*$/, "") || "提示词";
      } else if (t.endsWith("_END")) {
        cur.body = buf.join("\n").trim();
        buf = null;
        open = null;
      }
      continue;
    }
    if (meta) { meta.push(line); continue; }
    if (buf) buf.push(line);
  }
  /* 没有正文的节（比如只有标题没写提示词）不参与批量 */
  return out.filter((a) => a.body);
}

/** 给保存节点打资产名标记。两种节点口径不同，必须分开处理：
 *  · 官方 SaveImage：filename_prefix 支持 `/`，按资产名分子目录最清楚；
 *  · 本项目 🎥 视频合并（banzhangVideoCombine）：前缀过 _safe_name，`/` 会被换成 `-`，
 *    分层会变成名字里的一道横线，所以只能拼在本名前缀后面。
 */
function stampSavePrefix(output, name) {
  const safe = String(name || "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").trim().slice(0, 40);
  if (!safe) return { dir: 0, prefix: 0 };
  let dir = 0;
  let prefix = 0;
  for (const key of Object.keys(output)) {
    const nd = output[key];
    const inp = nd && nd.inputs;
    if (!inp) continue;
    const ct = String(nd.class_type || "");
    if (ct === COMBINE_CLASS) {
      const k = "🏷️ 文件前缀";
      if (typeof inp[k] === "string") {
        inp[k] = `${inp[k]}_${safe}`;
        prefix += 1;
      }
      continue;
    }
    if (!SAVE_RE.test(ct)) continue;
    if (typeof inp.filename_prefix !== "string") continue;
    /* 原前缀可能为空：直接拼 "/名字" 会变成以斜杠开头的路径，落到 output 之外 */
    const base = inp.filename_prefix.replace(/[\\/]+$/, "");
    inp.filename_prefix = base ? `${base}/${safe}` : safe;
    dir += 1;
  }
  return { dir, prefix };
}

/* ---------------- 产物元数据对齐 ----------------
   提交对象里有两份东西：output 决定跑什么，workflow 是画布快照、会被 ComfyUI
   原样写进产物的 PNG 元数据。批量时只改 output，workflow 就还是批量开始前那一份
   ——于是每张成品图里都嵌着同一条旧提示词、同一批旧素材。把图拖回画布，旧提示词
   和旧参考图跟着回来，看起来就是「又出了一张以前那张图，还带着一段写死的提示词」。

   只同步两处，都对应本次执行的真实状态：
   · 图像编辑台的 qwen_data —— 这条资产自己的提示词；
   · 媒体架的图片槽位 —— 批量不带参考图（no_refs），快照里也不该留旧图，
     否则拖回画布时那些图会被当成参考素材一起送进编码器。
   视频/音频槽不动：批量资产只跑图片，动它们没有依据。 */
const RACK_CLASS = "CSGlideH3MediaRackCS";

function syncWorkflowMeta(workflow, cfgJson, clearRack) {
  for (const n of (workflow && workflow.nodes) || []) {
    const type = String(n.type || "");
    if (type !== CAST_CLASS && type !== RACK_CLASS) continue;
    let raw;
    if (type === CAST_CLASS) {
      /* no_refs 是提交期的临时指令（"这次不要参考图"），不是面板状态。
         写进元数据的话，拖回成品图后它会一直生效——用户重新拖素材也不管用，
         而面板上根本没有这个开关可以关掉。 */
      try {
        const cfg = JSON.parse(cfgJson);
        delete cfg.no_refs;
        raw = JSON.stringify(cfg);
      } catch (_) { raw = cfgJson; }
    } else {
      if (!clearRack) continue;     // 单张运行不清素材：那是用户手里正在用的
      try {
        const cfg = JSON.parse(String((n.widgets_values || [])[0] || "{}"));
        if (!cfg.slots || typeof cfg.slots !== "object") cfg.slots = {};
        cfg.slots.images = [];
        raw = JSON.stringify(cfg);
      } catch (_) { continue; }     // 解析不了就原样留着，不阻断提交
    }
    if (Array.isArray(n.widgets_values) && n.widgets_values.length) n.widgets_values[0] = raw;
    /* 新版前端另存一份按名字索引的 widget 值，两份要一起改，否则导出后仍读到旧的 */
    const named = n.widgets_values_named;
    if (named && typeof named === "object") {
      named[type === CAST_CLASS ? "qwen_data" : "rack_data"] = raw;
    }
  }
}

/* ---------------- 片子级（LoRA 触发词） ----------------
   口径照抄文案台 csglide_desk.compose_text：片子级在前、正文在后，换行连接。

   为什么不在面板提示词框里拼：那是用户手写的内容，自动改写会被当成"自己打的"，
   撤销、切段、引用高亮全都对不上。改为在**提交对象**上拼 ——
   单张运行和批量派发最终都落到 api.queuePrompt，在这一个点上拼，
   两条路径行为一致、不会拼两次，用户也只设一处。
*/
const PROVIDERS = new Set();     // 每个面板注册一个 () => ({ id, text })
const INJECTED = new WeakSet();  // 同一个提交对象只拼一次，防止重试/多包装叠加
let queuePatched = false;

export function composeGlobal(globalText, body) {
  const clean = (t) => String(t || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return [clean(globalText), clean(body)].filter(Boolean).join("\n");
}

export function injectGlobals(prompt, providers = PROVIDERS) {
  const output = prompt && prompt.output;
  if (!output) return;
  if (typeof prompt === "object") {
    if (INJECTED.has(prompt)) return;
    INJECTED.add(prompt);
  }
  for (const get of providers) {
    let id = "";
    let text = "";
    try { ({ id, text } = get() || {}); } catch (_) { continue; }
    if (!id || !text || !text.trim()) continue;
    const nd = output[id] || output[Number(id)];
    if (!nd || nd.class_type !== CAST_CLASS) continue;
    const raw = nd.inputs ? nd.inputs.qwen_data : "";
    if (typeof raw !== "string") continue;
    let cfg = {};
    try { cfg = JSON.parse(raw || "{}") || {}; } catch (_) { continue; }
    cfg.prompt = composeGlobal(text, cfg.prompt);
    nd.inputs.qwen_data = JSON.stringify(cfg);
    /* 片子级是实际送进编码器的一部分，元数据也得带上——否则把成品图拖回画布，
       看到的是一段没拼过片子级的正文，和当时跑的并不是同一份。 */
    syncWorkflowMeta(prompt.workflow, nd.inputs.qwen_data, false);
  }
}

function patchQueue() {
  if (queuePatched || !api || typeof api.queuePrompt !== "function") return;
  queuePatched = true;
  const orig = api.queuePrompt.bind(api);
  api.queuePrompt = async function (number, prompt, ...rest) {
    try { injectGlobals(prompt); } catch (_) {}
    return orig(number, prompt, ...rest);
  };
}

/* ---------------- 派发 ---------------- */

async function dispatchAll(node, items) {
  const p = await app.graphToPrompt();
  const id = String(node.id);
  let submitted = 0;
  const hit = { dir: 0, prefix: 0 };
  for (const it of items) {
    /* 每个 job 都从同一份骨架深拷贝：不深拷贝的话第二个 job 会带上第一个的提示词 */
    const output = JSON.parse(JSON.stringify(p.output));
    const target = output[id] || output[Number(id)];
    if (!target) throw new Error(`提交对象里找不到本节点（id=${id}），请刷新页面后重试`);
    const raw = target.inputs ? target.inputs.qwen_data : "";
    if (typeof raw !== "string") throw new Error("qwen_data 不是面板数据，批量已中止");

    const cfg = JSON.parse(raw || "{}");
    cfg.prompt = it.body;
    /* 这批资产是新写的，提示词里没有 @图片N 引用；带上参考图会污染画面。
       光清空 images 不够——后端 merge_rack_refs 把空数组当「面板没填」，
       会把媒体架那套图整个塞回来，于是每条资产都套着同一批参考图，
       生成出来互相像、分不开。必须给显式声明让兜底让路。 */
    cfg.images = [];
    cfg.no_refs = true;
    cfg.canvas_from_ref = false;
    /* 图不要文字：正面已经不含画字指令（标题/视图名/尺寸框都挪进了元信息层），
       负面再压一层，防止模型按训练习惯自己补标签或水印。 */
    cfg.negative_prompt = [cfg.negative_prompt, "文字、水印、字幕、标注、标题、签名、数字"]
      .filter(Boolean).join(", ");
    /* 画布就用面板设的那个，不按文档「画幅」重算。
       面板填了什么就该出什么——按长边重算会把面板的高丢掉
       （1024x1024 + 文档 16:9 变成 1024x576），用户看到的是「设了没用」。 */
    const data = JSON.stringify(cfg);
    target.inputs.qwen_data = data;

    const h = stampSavePrefix(output, it.name);
    hit.dir = Math.max(hit.dir, h.dir);
    hit.prefix = Math.max(hit.prefix, h.prefix);
    /* 每条都取一份新的 workflow 快照：改过的元数据不能回头污染上一轮提交对象 */
    const wf = JSON.parse(JSON.stringify(p.workflow || {}));
    syncWorkflowMeta(wf, data, true);
    await api.queuePrompt(0, { output, workflow: wf });
    submitted += 1;
  }
  return { submitted, ...hit };
}

/* ---------------- 面板 ---------------- */

export function installAssetBatch(node, hooks) {
  ensureCSS();
  const { root } = hooks;

  const wrap = el("div", "gqb");
  const head = el("div", "gqb-head");
  /* 常驻提示语已去掉：这行只在拖入时临时出现，平时底部完全隐身。
     拖入必须有反馈，否则用户不知道有没有拖对目标。 */
  const hint = el("span", "gqb-name", "松手读取 .md");
  const count = el("span", "gqb-count", "");
  head.append(hint, count);

  const list = el("div", "gqb-list");
  const note = el("div", "gqb-note");
  const bar = el("div", "gqb-bar");

  wrap.append(head, list, bar, note);
  root.append(wrap);

  /* 片子级输入框由面板常驻渲染（hooks.globalInput），这里只读它此刻的值，
     不缓存快照 —— 改完立刻点运行就该生效。输入框不存在时返回空，等于不拼。 */
  const provider = () => {
    const box = hooks.globalInput;
    return { id: String(node.id), text: box ? String(box.value || "") : "" };
  };
  PROVIDERS.add(provider);
  patchQueue();

  let items = [];
  let boxes = [];
  let dropping = false;

  /* 三态合一：拖入中 / 清单展开 / 有结果提示，任一成立才显现，
     否则整条高度为 0，不占面板空间。 */
  function syncChrome() {
    const listed = list.classList.contains("on");
    const noted = note.classList.contains("on");
    wrap.classList.toggle("on", dropping || listed || noted);
    head.classList.toggle("on", dropping || listed);
    head.classList.toggle("dropping", dropping);
    hint.style.display = dropping ? "" : "none";
  }

  const say = (msg, bad) => {
    note.textContent = msg;
    note.className = bad ? "gqb-note on bad" : "gqb-note on";
    syncChrome();
  };
  const clearSay = () => { note.className = "gqb-note"; syncChrome(); };

  function paintBar() {
    bar.replaceChildren();
    if (!items.length) { count.textContent = ""; return; }
    const picked = boxes.filter((b) => b.checked).length;
    count.textContent = `已选 ${picked} / ${items.length}`;

    const bAll = el("button", "gqb-btn", "全选");
    bAll.type = "button";
    bAll.onclick = () => { boxes.forEach((b) => { b.checked = true; }); paintBar(); };
    const bNone = el("button", "gqb-btn", "全不选");
    bNone.type = "button";
    bNone.onclick = () => { boxes.forEach((b) => { b.checked = false; }); paintBar(); };
    const bRun = el("button", "gqb-btn primary", "批量生成");
    bRun.type = "button";
    bRun.onclick = () => run(bRun);
    const bClose = el("button", "gqb-btn", "收起");
    bClose.type = "button";
    bClose.onclick = () => { list.classList.remove("on"); clearSay(); };
    bar.append(bAll, bNone, bRun, bClose);
  }

  function show(got) {
    items = got;
    boxes = [];
    list.replaceChildren();
    for (const a of items) {
      const row = el("label", "gqb-item");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.onchange = paintBar;
      boxes.push(cb);
      row.append(cb,
        el("span", "gqb-name", `@图片${a.no} ${a.name}`),
        el("span", "gqb-tag", a.type || "提示词"),
        el("span", "gqb-size", `${a.body.length} 字`));
      list.append(row);
    }
    list.classList.add("on");
    paintBar();
    syncChrome();
    const types = {};
    for (const a of items) types[a.type] = (types[a.type] || 0) + 1;
    const brief = Object.keys(types).map((k) => `${k} ${types[k]}`).join(" · ");
    say(`读到 ${items.length} 个提示词（${brief}）。勾掉不想跑的，再点「批量生成」。`);
  }

  function showErr(msg) { items = []; boxes = []; list.replaceChildren(); list.classList.remove("on"); paintBar(); say(msg, true); }

  async function run(btn) {
    const picked = items.filter((_, i) => boxes[i].checked);
    if (!picked.length) { say("一个都没勾，没有可跑的任务", true); return; }
    if (hooks.locked && hooks.locked()) {
      say("外接提示词正在接管（prompt_text 已接线），批量不会生效。请先断开那条线。", true);
      return;
    }
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      const r = await dispatchAll(node, picked);
      const tail = r.dir
        ? "输出已按资产名分子目录（SaveImage）。"
        : r.prefix
          ? "「🎥 视频合并」的文件前缀已拼上资产名，文件名形如 班长作品_陈墨白_N节点号_0001.png。"
          : "没识别到可命名的保存节点（SaveImage / 🎥 视频合并），输出只能靠流水号 + 执行顺序对照。";
      say(`已提交 ${r.submitted} 个任务，ComfyUI 队列会依次跑完。${tail}`);
    } catch (err) {
      say(`批量失败：${(err && err.message) || err}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "批量生成";
    }
  }

  /* 拖放：只拦 .md/.txt，其它文件（图片）放行给画布，不在面板里抢 */
  const hasFiles = (e) => {
    const t = e.dataTransfer;
    return !!t && Array.from(t.types || []).includes("Files");
  };
  root.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    dropping = true;
    syncChrome();
  });
  root.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && root.contains(e.relatedTarget)) return;
    dropping = false;
    syncChrome();
  });
  root.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dropping = false;
    syncChrome();
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /\.(md|txt)$/i.test(f.name || ""));
    if (!files.length) { say("只认 .md / .txt 文档", true); return; }
    const got = [];
    for (const f of files) {
      let txt = "";
      try { txt = await f.text(); } catch (_) { txt = ""; }
      for (const a of parseAssetDoc(txt)) {
        got.push({ ...a, src: f.name });
      }
    }
    if (!got.length) {
      showErr("这几份文档里没找到资产节。需要「## @图片N = 名字」+「<<<xx提示词>>>…<<<xx提示词_END>>>」这种结构。");
      return;
    }
    show(got);
  });

  return { destroy: () => { PROVIDERS.delete(provider); wrap.remove(); } };
}
