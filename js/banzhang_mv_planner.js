import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════════════════
//  🎬 MV 规划台 · 苹果风三栏工作台
//  顶部：歌曲槽位（拖入/点击上传 + 播放 + 实时频谱）
//  左栏：动态分段列表 ｜ 中栏：分段时间轴 ｜ 右栏：提示词编辑
// ═══════════════════════════════════════════════════════════════════════

const PANEL_W = 700;
const MIN_W = 560;          // 左 200 + 中 + 右 220，再窄三栏就挤没了
const W_KEY = "mv_width";   // 宽度真值存在 properties 里，刷新/复制都带得过来
const TOOLBAR_H = 46;
const SLOT_H = 140;         // 118 时减掉播放器行和进度条，频谱只剩约 50px，跳动几乎看不出来
const BODY_H = 340;         // 右栏要装「创作要求/歌词/情绪/提示词」四组控件，
                            // 300 时提示词输入框被挤出可视区（要滚动才看得见）
// .bz-mv-status 实测只占 16px（height:16 + padding-top:4 在 overflow:hidden 的
// 容器里，scrollHeight 只计到 16）。写成 20 会让节点底部空出 4px —— 实测
// 542 vs 546 就是这么来的。这类数字只能以面板自检报出来的实测值为准。
const STATUS_H = 16;
// 面板高度按公式算，root 铺满容器（照抄 minimax_h3_preview.js 的已验证骨架）：
// **节点尺寸是权威，DOM 被动铺满**。反过来让 DOM 的 offsetHeight 决定节点高度会
// 和前端布局引擎互相覆盖，表现就是整个面板错位。
// 常量必须与 CSS 实际占位逐项对齐：带边框的块一律 box-sizing:border-box，
// .bz-mv-status 是 height16+padding-top4=20。改 CSS 就要回来核这串数字。
const PANEL_H = 20 + TOOLBAR_H + 10 + SLOT_H + 10 + BODY_H + STATUS_H;

const C = {
  blue: "#0A84FF", orange: "#FF9F0A", purple: "#BF5AF2",
  green: "#30D158", red: "#FF453A",
  bg1: "#1d1d22", bg2: "#141418", line: "rgba(255,255,255,.1)",
};

function ensureStyles() {
  if (document.getElementById("bz-mv-planner-style")) return;
  const css = `
  /* height:100% 铺满 .dom-widget：节点高度由 onResize 定，DOM 跟着铺满。
     这是 minimax_h3_preview.js 的成熟做法（同视频合并节点）。 */
  .bz-mv-root{width:100%;height:100%;box-sizing:border-box;padding:10px;border-radius:10px;color:#f5f5f7;
    background:linear-gradient(180deg,#1d1d22,#141418);border:none;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .bz-mv-toolbar{display:flex;align-items:center;gap:8px;height:${TOOLBAR_H}px;margin-bottom:10px;}
  .bz-mv-title{font-size:13px;font-weight:700;letter-spacing:.2px;white-space:nowrap;}
  .bz-mv-spacer{flex:1;}
  .bz-mv-btn{border:1px solid ${C.line};background:rgba(0,0,0,.42);color:rgba(255,255,255,.85);
    border-radius:8px;font-size:11.5px;font-weight:600;padding:5px 10px;cursor:pointer;
    backdrop-filter:blur(8px);transition:transform .16s cubic-bezier(.34,1.4,.5,1),background .15s;}
  .bz-mv-btn:hover{background:rgba(10,132,255,.85);color:#fff;}
  .bz-mv-btn:active{transform:scale(.94);}
  .bz-mv-btn.primary{background:${C.blue};border-color:${C.blue};color:#fff;}
  /* 不可用要置灰而不是点了再报错：没歌时不该让人点「分析歌曲」撞一鼻子灰 */
  .bz-mv-btn:disabled{opacity:.38;cursor:not-allowed;background:rgba(0,0,0,.2);}
  .bz-mv-btn:disabled:hover{background:rgba(0,0,0,.2);color:rgba(255,255,255,.85);}
  .bz-mv-btn:disabled:active{transform:none;}
  /* 歌曲槽位 */
  /* box-sizing:border-box —— 让 height:140px 含那 1px 边框，和 SLOT_H 常量对齐。
     否则实际占位是 142，每个带边框的块都悄悄多 2px。 */
  .bz-mv-slot{height:${SLOT_H}px;margin-bottom:10px;border-radius:10px;
    box-sizing:border-box;border:1px solid ${C.line};
    background:rgba(0,0,0,.3);overflow:hidden;}
  .bz-mv-dropzone{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
    cursor:pointer;transition:background .15s;}
  .bz-mv-dropzone:hover,.bz-mv-slot.drop-active .bz-mv-dropzone{background:rgba(10,132,255,.14);}
  .bz-mv-dropzone .big{font-size:24px;}
  .bz-mv-dropzone .hint{font-size:11.5px;color:rgba(255,255,255,.6);}
  .bz-mv-player{height:100%;display:none;flex-direction:column;padding:8px 10px;gap:5px;}
  .bz-mv-prow{display:flex;align-items:center;gap:9px;}
  .bz-mv-play{width:28px;height:28px;flex:none;border:0;border-radius:50%;background:${C.blue};color:#fff;
    font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;
    transition:transform .16s cubic-bezier(.34,1.4,.5,1);}
  .bz-mv-play:active{transform:scale(.9);}
  .bz-mv-fname{font-size:11.5px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .bz-mv-time{font-size:10.5px;font-family:ui-monospace,Consolas,monospace;color:rgba(255,255,255,.6);}
  .bz-mv-clear{border:0;background:transparent;color:rgba(255,255,255,.5);font-size:13px;cursor:pointer;}
  .bz-mv-clear:hover{color:${C.red};}
  .bz-mv-prog{position:relative;height:16px;display:flex;align-items:center;cursor:pointer;}
  .bz-mv-prog .track{width:100%;height:5px;border-radius:3px;background:rgba(255,255,255,.18);}
  .bz-mv-prog .fill{position:absolute;left:0;height:5px;border-radius:3px;background:${C.blue};width:0;pointer-events:none;}
  .bz-mv-prog .knob{position:absolute;width:11px;height:11px;border-radius:50%;background:#fff;
    transform:translateX(-50%);pointer-events:none;}
  .bz-mv-spec{flex:1;width:100%;display:block;}
  .bz-mv-body{display:flex;gap:10px;height:${BODY_H}px;}
  .bz-mv-col{background:rgba(0,0,0,.3);border:1px solid ${C.line};border-radius:10px;display:flex;flex-direction:column;overflow:hidden;}
  .bz-mv-col-head{font-size:11px;font-weight:700;color:rgba(255,255,255,.7);padding:7px 10px;
    border-bottom:1px solid ${C.line};display:flex;align-items:center;gap:6px;}
  /* display:flex 是给空状态用的：.bz-mv-empty 靠 flex:1 撑满才垂直居中，
     而它挂在 listBox 里 —— 容器不是 flex 的话 flex:1 无效，提示会顶到栏头上，
     和中/右两栏的空状态对不齐。 */
  .bz-mv-list{flex:1;overflow-y:auto;padding:5px;display:flex;flex-direction:column;}
  .bz-mv-segrow{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;
    transition:background .14s;}
  .bz-mv-segrow:hover{background:rgba(255,255,255,.06);}
  .bz-mv-segrow.on{background:rgba(10,132,255,.22);box-shadow:inset 0 0 0 1px rgba(10,132,255,.5);}
  .bz-mv-dot{width:8px;height:8px;border-radius:50%;flex:none;}
  .bz-mv-segno{font-size:12px;font-weight:700;width:34px;flex:none;}
  /* 试听本段：做 MV 必须能反复听某一段，整曲播放条干不了这事 */
  .bz-mv-segplay{width:18px;height:18px;flex:none;border:0;border-radius:50%;
    background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);font-size:9px;
    cursor:pointer;display:flex;align-items:center;justify-content:center;}
  .bz-mv-segplay:hover{background:${C.blue};color:#fff;}
  .bz-mv-segplay.on{background:${C.green};color:#fff;}
  .bz-mv-segplay:disabled{opacity:.3;cursor:not-allowed;}
  .bz-mv-segtime{font-size:10.5px;font-family:ui-monospace,Consolas,monospace;color:rgba(255,255,255,.6);flex:1;}
  .bz-mv-tl-wrap{flex:1;position:relative;padding:8px;}
  .bz-mv-tl{width:100%;height:100%;display:block;}
  .bz-mv-editor{flex:1;display:flex;flex-direction:column;padding:9px;gap:7px;overflow-y:auto;}
  .bz-mv-editor label{font-size:10.5px;font-weight:700;color:rgba(255,255,255,.6);}
  .bz-mv-editor input,.bz-mv-editor textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid ${C.line};
    background:rgba(0,0,0,.5);color:#fff;font-size:11.5px;padding:7px;outline:none;}
  .bz-mv-editor input:focus,.bz-mv-editor textarea:focus{border-color:${C.blue};}
  .bz-mv-editor textarea{flex:1;resize:none;line-height:1.5;min-height:64px;}
  .bz-mv-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:12px;color:rgba(255,255,255,.4);padding:20px;text-align:center;}
  .bz-mv-status{font-size:10.5px;color:rgba(255,255,255,.55);height:16px;line-height:16px;
    padding-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  `;
  const style = document.createElement("style");
  style.id = "bz-mv-planner-style";
  style.textContent = css;
  document.head.appendChild(style);
}

function el(tag, cls, parent) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (parent) parent.appendChild(node);
  return node;
}

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  w.mouse = () => {};
}

function fmtClock(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return m + ":" + String(x).padStart(2, "0");
}

// 端口中文钉名：内部 name 保持英文蛇形，仅把显示用 label 钉成中文。
// configure 会重建 slot 对象，故在 onNodeCreated/onConfigure/onConnectionsChange 各钉一遍。
const PORT_LABELS = {
  audio: "歌曲音频",
  refs: "参考素材",
  qwen_config: "Qwen配置",
  person_image: "人物参考图",
  temperature: "温度",
  max_tokens: "最大Token",
};

function pinPortLabels(n) {
  for (const s of n.inputs || []) {
    const key = String(s.name || "").toLowerCase();
    if (PORT_LABELS[key]) s.label = PORT_LABELS[key];
  }
}

app.registerExtension({
  name: "BanZhang.MVPlanner",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "BanZhang_MVPlanner") return;

    const chain = (target, name, fn) => {
      const old = target[name];
      target[name] = function (...args) {
        if (old) old.apply(this, args);
        return fn.apply(this, args);
      };
    };

    chain(nodeType.prototype, "onNodeCreated", function () {
      ensureStyles();
      const node = this;
      node.properties = node.properties || {};

      const wMap = {};
      // 后端这几个输入是给面板承载数据用的，UI 上不该出现。先列名单再隐藏，
      // 不要遍历 node.widgets 全隐藏 —— DOM 面板自己也挂在 widgets 里，
      // 一刀切会把面板本身隐藏掉。
      const HIDDEN_WIDGETS = ["project_data", "action", "current_index",
        "audio_path", "temperature", "max_tokens"];
      // configure 会**重建 widget 对象**：只有 onNodeCreated 隐藏一次是不够的
      // （节点底部会重新冒出一条控件行），而且 wMap 若还指向旧对象，面板写的值
      // 就落在一个没人序列化的孤立刻上 —— 刷新后工程全丢。
      // 必须两个时机都重新绑定（同 banzhang_lora_loader.ensureHiddenWidgets）。
      function bindWidgets() {
        for (const name of HIDDEN_WIDGETS) {
          const w = (node.widgets || []).find((x) => x.name === name);
          if (!w) continue;
          wMap[name] = w;
          hideWidget(w);
        }
      }
      bindWidgets();

      const state = {
        project: { segments: [] },
        current: 0,
        songRel: "",
      };

      // 正在循环试听的段号；null = 没在试听。这是纯 UI 临时态，不进工程 JSON。
      let loopSeg = null;

      // ── 工具栏 ─────────────────────────────────────────────────
      const root = el("div", "bz-mv-root");
      const toolbar = el("div", "bz-mv-toolbar", root);
      el("span", "bz-mv-title", toolbar).textContent = "🎬 MV 规划台";
      // 这里原先有一组「分段 / Qwen / 导出」Segmented Control，点了只切高亮、
      // 视图完全不变 —— 一个不响应用户操作的控件只会让人以为界面坏了。
      // 三栏本来就是同时看的，没有切换视图的必要，直接删掉。
      el("div", "bz-mv-spacer", toolbar);
      const btnAnalyze = el("button", "bz-mv-btn primary", toolbar);
      btnAnalyze.textContent = "分析歌曲";
      const btnOne = el("button", "bz-mv-btn", toolbar);
      btnOne.textContent = "生成当前段";
      const btnAll = el("button", "bz-mv-btn", toolbar);
      btnAll.textContent = "全部生成";
      const btnRender = el("button", "bz-mv-btn", toolbar);
      btnRender.textContent = "▶ 逐段渲染";
      btnRender.title = "自动逐段出片：切段 → 提交整图（导演台会跑）→ 等本段完成 → 下一段。"
        + "只渲染已有提示词的段；期间不要关闭页面；渲染中再点一次可请求停止";

      // ── 歌曲槽位 ───────────────────────────────────────────────
      const slot = el("div", "bz-mv-slot", root);
      const dropzone = el("div", "bz-mv-dropzone", slot);
      el("span", "big", dropzone).textContent = "🎵";
      el("span", "hint", dropzone).textContent = "拖入歌曲，或点击选择音频文件";

      const player = el("div", "bz-mv-player", slot);
      const prow = el("div", "bz-mv-prow", player);
      const playBtn = el("button", "bz-mv-play", prow);
      playBtn.textContent = "▶";
      const fname = el("span", "bz-mv-fname", prow);
      const tlabel = el("span", "bz-mv-time", prow);
      tlabel.textContent = "0:00 / 0:00";
      const clearBtn = el("button", "bz-mv-clear", prow);
      clearBtn.textContent = "✕";
      clearBtn.title = "移除歌曲";

      const prog = el("div", "bz-mv-prog", player);
      const track = el("div", "track", prog);
      const fill = el("div", "fill", prog);
      const knob = el("div", "knob", prog);

      const specCanvas = el("canvas", "bz-mv-spec", player);

      // 播放引擎
      const audioEl = new Audio();
      let actx = null, analyser = null, freqData = null, mediaReady = false;
      let specRaf = 0;

      function ensureAudioGraph() {
        if (mediaReady) return;
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          actx = new AC();
          analyser = actx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.82;
          const src = actx.createMediaElementSource(audioEl);
          src.connect(analyser);
          analyser.connect(actx.destination);
          freqData = new Uint8Array(analyser.frequencyBinCount);
          mediaReady = true;
        } catch (e) {
          console.warn("[MVPlanner] AudioContext 初始化失败：", e);
        }
      }

      function viewUrlOf(rel) {
        const i = rel.lastIndexOf("/");
        const sub = i >= 0 ? rel.slice(0, i) : "";
        const name = i >= 0 ? rel.slice(i + 1) : rel;
        return api.apiURL("/view?filename=" + encodeURIComponent(name)
          + "&subfolder=" + encodeURIComponent(sub) + "&type=input");
      }

      async function uploadAudio(file) {
        const body = new FormData();
        body.append("image", file, file.name);
        body.append("subfolder", "mv_planner");
        body.append("overwrite", "true");
        body.append("type", "input");
        const res = await api.fetchApi("/upload/image",
          { method: "POST", body });
        if (res.status !== 200) throw new Error("上传失败 (" + res.status + ")");
        const d = await res.json();
        return (d.subfolder || "mv_planner") + "/" + d.name;
      }

      function setSong(rel, displayName) {
        state.songRel = rel;
        if (wMap.audio_path) wMap.audio_path.value = rel;
        state.project.audio = state.project.audio || {};
        state.project.audio.path = rel;
        dropzone.style.display = "none";
        player.style.display = "flex";
        fname.textContent = displayName || rel.split("/").pop();
        audioEl.src = viewUrlOf(rel);
        // 时长显示由全局 durationchange 监听负责（见播放控制段），这里不用重复挂。
        syncProject();
        // 必须重画一次：「分析歌曲」的可用状态取决于有没有歌，不刷的话
        // 按钮一直灰着，用户拖完歌点它毫无反应 —— 看上去像按钮坏了。
        renderAll();
      }

      async function handleFile(file) {
        if (!file || !String(file.type || "").startsWith("audio/")) {
          setStatus("❌ 请选择音频文件");
          return;
        }
        setStatus("⏳ 上传中…");
        try {
          const rel = await uploadAudio(file);
          setSong(rel, file.name);
          setStatus("✅ 已载入：" + file.name);
        } catch (e) {
          setStatus("❌ " + e.message);
        }
      }

      dropzone.addEventListener("click", async () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "audio/*";
        inp.onchange = () => handleFile(inp.files ? inp.files[0] : null);
        inp.click();
      });

      // 节点级拖入（只接音频）
      slot.addEventListener("dragover", (e) => {
        if (![...e.dataTransfer.items].some((it) => it.kind === "file")) return;
        e.preventDefault();
        e.stopPropagation();
        slot.classList.add("drop-active");
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("drop-active"));
      slot.addEventListener("drop", (e) => {
        slot.classList.remove("drop-active");
        const f = e.dataTransfer.files ? e.dataTransfer.files[0] : null;
        if (!f) return;
        e.preventDefault();
        e.stopPropagation();
        handleFile(f);
      });

      clearBtn.onclick = () => {
        audioEl.pause();
        stopLoop();                       // 歌都没了，试听必须一起停
        audioEl.removeAttribute("src");
        state.songRel = "";
        // 工程里的音频路径也要清：只清 widget 的话 properties 里还留着旧路径，
        // syncProject 一跑就把歌写回去，刷新后「已移除」的歌曲又冒出来。
        state.project.audio = {};
        if (wMap.audio_path) wMap.audio_path.value = "";
        dropzone.style.display = "flex";
        player.style.display = "none";
        syncProject();
        renderAll();                      // 「分析歌曲」要跟着变灰
      };

      // ── 播放控制 + 频谱 ────────────────────────────────────────
      async function togglePlay() {
        if (!state.songRel) return;
        ensureAudioGraph();
        if (actx && actx.state === "suspended") await actx.resume();
        if (audioEl.paused) {
          try {
            await audioEl.play();
            playBtn.textContent = "❚❚";
            specLoop();
          } catch (e) {
            setStatus("❌ 浏览器拦截了播放，请再点一次");
          }
        } else {
          audioEl.pause();
          playBtn.textContent = "▶";
        }
      }
      playBtn.onclick = togglePlay;

      // 暂停 / 播完都要停帧循环：specLoop 内部也会自停，这里兜住「被动暂停」
      // （拖进度、切歌、切后台）的情况，否则 rAF 会一直挂着。
      audioEl.addEventListener("pause", stopSpec);
      // 时长元数据一到位就更新显示：不然载入歌曲后（还没点播放）播放器一直
      // 显示 0:00 / 0:00 —— timeupdate 只在播放中触发，没人替它刷这一下。
      // durationchange 比 loadedmetadata 更全（flac 的时长有时晚一拍才修正）。
      audioEl.addEventListener("durationchange", () => {
        const d = audioEl.duration;
        if (!isFinite(d) || d <= 0) return;
        state.project.audio = state.project.audio || {};
        state.project.audio.duration = Math.round(d * 1000) / 1000;
        tlabel.textContent = fmtClock(audioEl.currentTime) + " / " + fmtClock(d);
        requestDrawTimeline();
      });
      audioEl.addEventListener("ended", () => {
        playBtn.textContent = "▶";
        stopSpec();
      });
      audioEl.addEventListener("timeupdate", () => {
        const d = audioEl.duration || 0;
        const ratio = d ? audioEl.currentTime / d : 0;
        fill.style.width = ratio * 100 + "%";
        knob.style.left = ratio * 100 + "%";
        tlabel.textContent = fmtClock(audioEl.currentTime)
          + " / " + fmtClock(d);
        // 试听本段：播到段尾跳回段头，直到用户再点一次停止
        if (loopSeg !== null) {
          const ls = (state.project.segments || [])[loopSeg];
          if (ls && audioEl.currentTime >= (ls.end || 0)) {
            audioEl.currentTime = ls.start || 0;
          }
        }
      });

      function seekFromEvent(e) {
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1,
          (e.clientX - rect.left) / rect.width));
        if (audioEl.duration) audioEl.currentTime = ratio * audioEl.duration;
      }
      let seeking = false;
      prog.addEventListener("mousedown", (e) => {
        seeking = true;
        seekFromEvent(e);
      });
      document.addEventListener("mousemove", (e) => {
        if (seeking) seekFromEvent(e);
      });
      document.addEventListener("mouseup", () => { seeking = false; });

      // 缓存频谱画布尺寸：每帧读 clientWidth/clientHeight 会强制浏览器
      // 重新算布局（reflow），60fps 下这是纯粹的浪费。尺寸变了由
      // ResizeObserver 把 specW 清 0，下一帧再量一次。
      let specW = 0, specH = 0;

      function drawSpec() {
        const canvas = specCanvas;
        const dpr = window.devicePixelRatio || 1;
        if (!specW) {
          specW = Math.max(40, (player.clientWidth || 320) - 20);
          specH = canvas.clientHeight || 40;
          canvas.width = specW * dpr;
          canvas.height = specH * dpr;
        }
        const W = specW, H = specH;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (!analyser) {
          ctx.strokeStyle = "rgba(255,255,255,.25)";
          ctx.beginPath();
          ctx.moveTo(0, H / 2);
          ctx.lineTo(W, H / 2);
          ctx.stroke();
          return;
        }
        analyser.getByteFrequencyData(freqData);
        const n = 40, bw = W / n, mid = H / 2;
        for (let i = 0; i < n; i++) {
          const idx = Math.floor(Math.pow(i / n, 1.6) * (freqData.length * 0.7));
          const v = (freqData[idx] || 0) / 255;
          const bh = Math.max(v * mid * 0.92, 1.5);
          const x = i * bw + bw * 0.25, ww = bw * 0.5;
          // 原来每根柱子每帧都 createLinearGradient：40 根 × 60fps = 每秒
          // 2400 个渐变对象，纯属拿 CPU 换几乎看不出的渐变。上下两段本来就
          // 是两个矩形，直接用两个固定色，视觉一致、开销归零。
          ctx.fillStyle = C.purple;
          ctx.beginPath();
          ctx.roundRect(x, mid - bh, ww, bh, 2);
          ctx.fill();
          ctx.fillStyle = C.blue;
          ctx.beginPath();
          ctx.roundRect(x, mid, ww, bh, 2);
          ctx.fill();
        }
      }

      function specLoop() {
        cancelAnimationFrame(specRaf);
        let last = 0;
        const tick = (ts) => {
          // 暂停就**停止续帧**，不能只是「不画但继续以 60fps 空转」——
          // 那样节点一放就是永远的满帧回调，静止状态的 CPU 全耗在这。
          if (audioEl.paused) { specRaf = 0; return; }
          specRaf = requestAnimationFrame(tick);
          // 30fps 够了：40 根小柱子上的差别肉眼看不出来，但每帧 80 次
          // roundRect+fill 的开销直接减半。用时间戳节流而不是数帧，
          // 120Hz 屏上也能稳定在 30fps。
          if (ts - last < 33) return;
          last = ts;
          drawSpec();
        };
        tick(performance.now());
      }

      function stopSpec() {
        if (specRaf) cancelAnimationFrame(specRaf);
        specRaf = 0;
      }

      // ── 三栏 ───────────────────────────────────────────────────
      const body = el("div", "bz-mv-body", root);
      const colL = el("div", "bz-mv-col", body);
      colL.style.width = "200px";
      colL.style.flex = "none";
      el("div", "bz-mv-col-head", colL).textContent = "片段列表";
      const listBox = el("div", "bz-mv-list", colL);

      const colM = el("div", "bz-mv-col", body);
      colM.style.flex = "1";
      el("div", "bz-mv-col-head", colM).textContent = "分段时间轴 · 节拍";
      const tlWrap = el("div", "bz-mv-tl-wrap", colM);
      const tlCanvas = el("canvas", "bz-mv-tl", tlWrap);

      const colR = el("div", "bz-mv-col", body);
      colR.style.width = "220px";
      colR.style.flex = "none";
      el("div", "bz-mv-col-head", colR).textContent = "分镜提示词";
      const editor = el("div", "bz-mv-editor", colR);

      const statusLine = el("div", "bz-mv-status", root);

      let syncTimer = 0;

      // 立即版：提交前、选段、拖进度这些「必须马上对上」的路径用这个。
      function syncProject() {
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = 0; }
        const raw = JSON.stringify(state.project);
        if (wMap.project_data) wMap.project_data.value = raw;
        node.properties.mv_project = raw;
        if (wMap.current_index) wMap.current_index.value = state.current;
        if (wMap.action) wMap.action.value = "idle";
        node.graph?.change?.();
      }

      // 打字用：每按一键都把整份工程（13 段 + 几百个节拍点、几十 KB）序列化
      // 一遍、再让全图 change 一次 —— CPU 全烧在没人看的中间态上。合并成
      // 300ms 一次；输入框自己的显示是浏览器实时的，不受影响。
      function syncProjectSoon() {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(syncProject, 300);
      }

      // 时间轴重绘合并：同一帧里被叫多次只画一次（onResize / ResizeObserver /
      // 选段都会叫它）。每次 drawTimeline 都会重设 canvas.width，等于重新分配
      // 一块绘制缓冲区，排队多画几次纯属浪费。
      let tlPending = false;
      function requestDrawTimeline() {
        if (tlPending) return;
        tlPending = true;
        requestAnimationFrame(() => { tlPending = false; drawTimeline(); });
      }

      // 统一的后端 API 调用。必须自己解析响应体：接口不存在时后端回的是纯文本
      // （405/404），r.json() 会抛「Unexpected non-whitespace character after
      // JSON at position 3」—— 这个报错完全指不出真正原因（通常是后端没重启、
      // 新接口还没注册）。收口成一句人话。
      async function postJson(url, payload) {
        const r = await api.fetchApi(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const txt = await r.text();
        let data = {};
        try {
          data = txt ? JSON.parse(txt) : {};
        } catch (_) {
          throw new Error("接口返回的不是 JSON（HTTP " + r.status
            + "）—— 多半是 ComfyUI 没重启，新接口还没注册");
        }
        if (!r.ok || data.error) {
          throw new Error(data.error || ("HTTP " + r.status));
        }
        return data;
      }

      // 只保留「本节点 + 它的上游」：生成提示词时不该把导演台一起拉起来跑
      // （那是几十分钟的视频生成）。上游必须保留 —— prompt 里上游是以
      // [nodeId, slot] 引用的，只留本节点会让这些引用指向不存在的节点。
      function upstreamOnly(output, rootId) {
        const keep = new Set();
        const stack = [String(rootId)];
        while (stack.length) {
          const id = String(stack.pop());
          if (keep.has(id)) continue;
          if (!output[id]) continue;   // 上游不在本次 prompt 里（被静音/绕过）
          keep.add(id);
          const ins = output[id].inputs || {};
          for (const v of Object.values(ins)) {
            if (Array.isArray(v) && v.length) stack.push(String(v[0]));
          }
        }
        const out = {};
        for (const id of keep) out[id] = output[id];
        return out;
      }

      async function submitAction(act) {
        syncProject();
        // 「分析歌曲」走自有 API（同步一问一答）。走队列要靠 executed 事件带结果，
        // 实测会撞上 prompt_service 竞态 —— 后端跑完了，事件被前端整个丢掉，
        // 面板就没反应。分析只是解码 + 分段，根本不需要执行引擎。
        if (act === "analyze") {
          try {
            setStatus("⏳ 正在分析（解码 + 分段）…");
            const data = await postJson("/banzhang/mv_analyze", {
              project_data: JSON.stringify(state.project),
              audio_path: state.songRel,
              current_index: state.current,
            });
            applyResult(JSON.stringify(data.project), data.report);
          } catch (e) {
            setStatus("❌ 分析失败：" + e.message);
          }
          return;
        }
        // 「生成提示词」走队列：Qwen 配置/人物图是端口对象，只能由节点执行拿到。
        // 后端 run() 已改成返回 {"ui":..., "result":...} —— 带 ui 的返回值才会
        // 进 history.outputs 并触发 executed（execution.py:567-580），所以这里
        // 双通道（事件 + history）都能拿到结果。
        try {
          const p = await app.graphToPrompt();
          const output = upstreamOnly(
            JSON.parse(JSON.stringify(p.output)), node.id);
          const target = output[String(node.id)] || output[node.id];
          if (!target) throw new Error("提交对象里找不到本节点");
          target.inputs = target.inputs || {};
          target.inputs.action = act;
          target.inputs.current_index = state.current;
          target.inputs.project_data = JSON.stringify(state.project);
          target.inputs.audio_path = state.songRel;
          setStatus(act === "generate_all"
            ? "⏳ 逐段生成提示词中（每段几秒）…"
            : "⏳ 正在生成当前段提示词…");
          p.output = output;
          const pid = await queueGraph(p);
          watchHistory(pid);
        } catch (e) {
          setStatus("❌ " + e.message);
        }
      }

      // 提交 + 三态校验。queuePrompt 被拒时**不抛异常**：返回体里是
      // error / node_errors，没有 prompt_id —— 不查就静默跳过，用户看到
      // 的就是「点了没反应」。分析走 API、提示词走裁剪子图、渲染走整图，
      // 三条路最终都从这里进队列，校验只写这一份。
      async function queueGraph(p) {
        const res = await api.queuePrompt(0, p);
        if (res && res.node_errors && Object.keys(res.node_errors).length) {
          const e = res.node_errors;
          const k = Object.keys(e)[0];
          const why = (e[k] && (e[k].errors || [])[0]) || {};
          console.error("[MV规划台] 提交被拒", e);
          throw new Error("提交被拒：" + (why.message || why.type || "节点校验失败")
            + "（节点 " + k + "）");
        }
        if (!res || !res.prompt_id) {
          console.error("[MV规划台] queuePrompt 返回", res);
          throw new Error("提交失败：后端没有返回任务号");
        }
        return res.prompt_id;
      }

      // ── 逐段渲染编排 ─────────────────────────────────────────
      // 规划台是唯一掌握「每段提示词 + 帧账」的节点：导演台「▶ 全部渲染」
      // 逐段排队时，规划台只会送出当前选中段 —— N 段全用同一份提示词，
      // 段档案还会互相覆盖。所以逐段提交整图这件事只能由这里编排：
      // 切段（改 current_index）→ 提交整图 → 等这一段跑完 → 下一段。
      let rendering = false;
      let renderAbort = false;

      async function submitWholeGraph() {
        syncProject();                       // 先把 current_index 刷进 widget
        const p = await app.graphToPrompt();
        return queueGraph(p);                // 整图，不裁剪 —— 导演台必须跟着跑
      }

      // 等一段渲染完成：只认 history 的 status，不信事件（实测会被前端丢）。
      async function waitPrompt(pid) {
        for (let i = 0; i < 1200; i++) {     // 单段上限 20 分钟
          if (renderAbort) return false;
          await new Promise((ok) => setTimeout(ok, 1000));
          let entry = null;
          try {
            const r = await api.fetchApi("/history/" + pid);
            entry = (await r.json())[pid];
          } catch (_) { continue; }
          if (!entry) continue;              // 还在排队 / 执行中
          const st = entry.status || {};
          if (st.status_str === "error") return false;
          if (st.completed) return true;
        }
        return false;
      }

      async function renderAllSegments() {
        if (rendering) {                     // 再点一次 = 请求停止
          renderAbort = true;
          setStatus("⏹ 将在当前段跑完后停止");
          return;
        }
        const segs = state.project.segments || [];
        // 承接链约束：第 k 段的续拍承接靠「上一段的归位存档」。跳段渲染会让
        // 导演台兜底去扫 h3_context 目录，捡到别的工程的旧档直接报分辨率冲突
        // （实测 421 个旧档就是这么被捡中的）。所以必须从第一个未完成的段
        // 开始连续往下，不允许跳段 —— 链完整，导演台永远按档案精确认段。
        const firstUndone = segs.findIndex((s) => s.status !== "done");
        if (firstUndone < 0) {
          setStatus("✅ 所有段都已渲染完成 —— 可以走合并 / 插帧 / 超分出片了");
          return;
        }
        const todo = [];
        for (let k = firstUndone; k < segs.length; k++) {
          if (segs[k].status === "done") continue;   // 中间已完成的跳过，链不断
          if (!String(segs[k].prompt || "").trim()) {
            setStatus("⚠️ 第 " + (k + 1) + " 段还没有提示词 —— 承接链不能跳段，"
              + "先点「全部生成」补齐提示词，再逐段渲染");
            return;
          }
          todo.push(k);
        }
        rendering = true;
        renderAbort = false;
        btnRender.textContent = "■ 停止渲染";
        btnRender.classList.add("primary");
        let finished = 0;
        try {
          for (const k of todo) {
            if (renderAbort) {
              setStatus("⏹ 已停止，本次完成了 " + finished + " 段");
              return;
            }
            state.current = k;
            syncProject();
            renderAll();
            setStatus("🎬 第 " + (k + 1) + "/" + segs.length + " 段渲染中…（点「■ 停止渲染」可在本段结束后停下）");
            const pid = await submitWholeGraph();
            const ok = await waitPrompt(pid);
            if (!ok) {
              setStatus("❌ 第 " + (k + 1) + " 段渲染失败或超时，已停止。处理后在左栏选中该段重新逐段渲染");
              return;
            }
            // 整个 prompt 成功 = 链上的段尾归位也成功了，乐观标 done；
            // 规划台下次执行时 _mark_done 还会按档案再核一遍。
            segs[k].status = "done";
            finished++;
            syncProject();
            renderAll();
          }
          setStatus("✅ 逐段渲染完成，共 " + finished + " 段 —— 可以走合并 / 插帧 / 超分出片了");
        } catch (e) {
          setStatus("❌ 逐段渲染中断：" + e.message);
        } finally {
          rendering = false;
          renderAbort = false;
          btnRender.textContent = "▶ 逐段渲染";
          btnRender.classList.remove("primary");
        }
      }

      btnAnalyze.onclick = () => submitAction("analyze");
      btnOne.onclick = () => submitAction("generate_one");
      btnAll.onclick = () => submitAction("generate_all");
      btnRender.onclick = () => renderAllSegments();

      function statusColor(s) {
        if (s === "ready") return C.green;
        if (s === "done") return C.blue;
        return C.orange;
      }

      function playSeg(k) {
        const segs = state.project.segments || [];
        const s = segs[k];
        if (!s || !audioEl.src) return;
        if (loopSeg === k) {          // 再点一次 = 停
          loopSeg = null;
          audioEl.pause();
          renderList();
          return;
        }
        loopSeg = k;
        audioEl.currentTime = Math.max(0, s.start || 0);
        audioEl.play().catch(() => { loopSeg = null; renderList(); });
        renderList();
      }

      function stopLoop() {
        if (loopSeg === null) return;
        loopSeg = null;
        renderList();
      }

      function renderList() {
        listBox.innerHTML = "";
        const segs = state.project.segments || [];
        if (!segs.length) {
          el("div", "bz-mv-empty", listBox).textContent = "点「分析歌曲」生成分段";
          return;
        }
        segs.forEach((s, k) => {
          const row = el("div", "bz-mv-segrow", listBox);
          if (k === state.current) row.classList.add("on");
          const dot = el("span", "bz-mv-dot", row);
          dot.style.background = statusColor(s.status);
          el("span", "bz-mv-segno", row).textContent = "#" + (k + 1);
          el("span", "bz-mv-segtime", row).textContent =
            fmtClock(s.start) + "–" + fmtClock(s.end);
          const pb = el("button", "bz-mv-segplay", row);
          pb.textContent = loopSeg === k ? "■" : "▶";
          pb.disabled = !state.songRel;
          pb.title = pb.disabled ? "先加载歌曲才能试听"
            : (loopSeg === k ? "停止试听" : "试听本段");
          if (loopSeg === k) pb.classList.add("on");
          // 必须挡住冒泡：否则点试听会顺带把当前段切走
          pb.onclick = (e) => { e.stopPropagation(); playSeg(k); };
          row.onclick = () => {
            state.current = k;
            renderAll();
          };
        });
      }

      // 「有没有可用的音频」必须是**两个来源都算**：拖进来的文件，或者接上的
      // AUDIO 端口（后端 _resolve_audio 本来就是优先读端口）。只判其中一个，
      // 另一种接法的人就会对着一个永远点不动的按钮 —— 判据不能有两个真值。
      function hasAudioSource() {
        if (state.songRel) return true;
        const slot = (node.inputs || []).find((x) => x.name === "audio");
        return !!(slot && slot.link != null);
      }

      // 按钮该不该能点，取决于现场有没有东西可操作。置灰 + 悬停说原因，
      // 比让人点了再弹「没有可用音频」体面得多。
      function syncButtons() {
        const hasAudio = hasAudioSource();
        const hasSegs = (state.project.segments || []).length > 0;
        btnAnalyze.disabled = !hasAudio;
        btnAnalyze.title = hasAudio ? "按 H3 帧账重新切分整首歌"
          : "先拖入歌曲，或在「歌曲音频」口接上音频";
        btnOne.disabled = !hasSegs;
        btnOne.title = hasSegs ? "" : "先点「分析歌曲」生成分段";
        btnAll.disabled = !hasSegs;
        btnAll.title = hasSegs ? "只生成所有段的提示词，不出片" : "先点「分析歌曲」生成分段";
        // 逐段渲染的可用性独立管理（rendering 时由 renderAllSegments 自己切文案）
        btnRender.disabled = !hasSegs || rendering;
        btnRender.title = hasSegs && !rendering
          ? "自动逐段出片：切段 → 提交整图 → 等完成 → 下一段。只跑有提示词的段"
          : btnRender.title;
      }

      function drawTimeline() {
        const canvas = tlCanvas;
        const dpr = window.devicePixelRatio || 1;
        // 用 canvas 自己的尺寸，不是 tlWrap 的：tlWrap 有 8px padding，拿它当 W
        // 会让绘制缓冲比实际显示宽 16px，缩放比就不再等于 dpr —— 文字被亚像素
        // 拉伸，看着就是一片虚。
        const W = Math.max(60, canvas.clientWidth || 300);
        const H = Math.max(60, canvas.clientHeight || 200);
        // 尺寸没变就不要重设 —— 每次赋值都会丢弃并重新分配绘制缓冲区
        const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
        if (canvas.width !== pw) canvas.width = pw;
        if (canvas.height !== ph) canvas.height = ph;
        const ctx = canvas.getContext("2d");
        // 必须 setTransform（绝对值），不能 scale（相对累积）：canvas.width 被赋成
        // 相同的值时浏览器不保证重置上下文，scale 就会一次次叠上去 —— 拉宽节点时
        // 文字越跑越偏、越放越大越模糊，就是这么来的。
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        const segs = state.project.segments || [];
        const audio = state.project.audio || {};
        const dur = audio.duration || (segs.length ? segs[segs.length - 1].end : 0);
        if (!dur) {
          ctx.fillStyle = "rgba(255,255,255,.4)";
          // 字体跟面板一致：canvas 里的 sans-serif 在中文下会落到系统默认字体，
          // 和旁边 DOM 文字明显不是一套，看着更"糊"。
          ctx.font = '12px -apple-system,BlinkMacSystemFont,"Segoe UI",'
            + '"PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("等待分段数据", W / 2, H / 2);
          return;
        }
        const padX = 12, padY = 26;
        const trackW = W - padX * 2;
        const xOf = (t) => padX + (t / dur) * trackW;

        ctx.fillStyle = "rgba(255,255,255,.62)";
        ctx.font = '11px ui-monospace,Consolas,monospace';
        ctx.textAlign = "center";
        // textBaseline 是上下文状态，setTransform 不会重置它 —— 空状态分支
        // 设过 middle，这里必须显式设回来，否则刻度文字整体下移半个字高。
        ctx.textBaseline = "alphabetic";
        const step = dur > 120 ? 30 : 15;
        for (let t = 0; t <= dur; t += step) {
          // 文字落在整数像素上、1px 线落在半像素上：否则抗锯齿会把字和线一起抹虚
          const xt = Math.round(xOf(t));
          const xl = xt + 0.5;
          ctx.fillStyle = "rgba(255,255,255,.62)";
          ctx.fillText(fmtClock(t), xt, 15);
          ctx.strokeStyle = "rgba(255,255,255,.12)";
          ctx.beginPath();
          ctx.moveTo(xl, padY - 4);
          ctx.lineTo(xl, H - 12);
          ctx.stroke();
        }

        const palette = [C.blue, C.purple, C.orange, C.green];
        segs.forEach((s, k) => {
          const x1 = Math.round(xOf(s.start));
          const x2 = Math.round(xOf(s.end));
          ctx.fillStyle = k === state.current
            ? "rgba(10,132,255,.45)"
            : "rgba(10,132,255,.16)";
          ctx.strokeStyle = palette[k % palette.length];
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x1 + 0.5, padY + 0.5, Math.max(2, x2 - x1), H - padY - 26, 6);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(255,255,255,.78)";
          ctx.font = '11px -apple-system,BlinkMacSystemFont,"Segoe UI",'
            + '"PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = "left";
          if (x2 - x1 > 18) ctx.fillText("#" + (k + 1), x1 + 6, padY + 17);
        });

        ctx.strokeStyle = "rgba(255,159,10,.55)";
        ctx.lineWidth = 1;
        // 节拍线按可视密度抽稀：快歌一分钟能有两百多拍，全画就是一排毛刺，
        // 什么信息都读不出来。相邻两根至少隔 3px，放大节点会自动多显示几根。
        let lastBeatX = -10;
        for (const bt of audio.beat_times || []) {
          const x = Math.round(xOf(bt)) + 0.5;
          if (x - lastBeatX < 3) continue;
          lastBeatX = x;
          ctx.beginPath();
          ctx.moveTo(x, H - 30);
          ctx.lineTo(x, H - 12);
          ctx.stroke();
        }
      }

      tlCanvas.addEventListener("click", (e) => {
        const segs = state.project.segments || [];
        const dur = state.project.audio?.duration || 0;
        if (!segs.length || !dur) return;
        const rect = tlCanvas.getBoundingClientRect();
        const padX = 12;
        const ratio = (e.clientX - rect.left - padX) / (rect.width - padX * 2);
        const t = Math.max(0, ratio) * dur;
        const k = segs.findIndex((s) => t >= s.start && t < s.end);
        if (k >= 0) {
          state.current = k;
          renderAll();
        }
      });

      function renderEditor() {
        editor.innerHTML = "";
        const segs = state.project.segments || [];
        if (!segs.length) {
          el("div", "bz-mv-empty", editor).textContent = "分段后在此编辑提示词";
          return;
        }
        const s = segs[state.current] || {};

        // 创作要求：用户对整支 MV 的统一文字要求（风格/场景/人物设定），生成
        // 提示词时每段都会带上。存工程级 style_note，跟工程一起持久化。
        const l0 = el("label", "", editor);
        l0.textContent = "创作要求（所有段共用）";
        const styleNote = el("input", "", editor);
        styleNote.value = state.project.style_note || "";
        styleNote.placeholder = "例：赛博朋克雨夜、手持镜头、同一女主";
        styleNote.oninput = () => {
          state.project.style_note = styleNote.value;
          syncProjectSoon();
        };

        const l1 = el("label", "", editor);
        l1.textContent = "歌词 / 旁白";
        const lyric = el("input", "", editor);
        lyric.value = s.lyric || "";
        lyric.oninput = () => { s.lyric = lyric.value; syncProjectSoon(); };

        const l2 = el("label", "", editor);
        l2.textContent = "情绪 / 风格";
        const mood = el("input", "", editor);
        mood.value = s.mood || "";
        mood.oninput = () => { s.mood = mood.value; syncProjectSoon(); };

        const l3 = el("label", "", editor);
        l3.textContent = "画面提示词（→ 导演台 prompt_text）";
        const prompt = el("textarea", "", editor);
        prompt.value = s.prompt || "";
        prompt.oninput = () => {
          s.prompt = prompt.value;
          s.status = prompt.value.trim() ? "ready" : "pending";
          syncProjectSoon();
        };
      }

      function renderAll() {
        renderList();
        renderEditor();
        syncButtons();
        requestDrawTimeline();
      }

      // 状态行是单行省略（white-space:nowrap），长报告会被截掉尾巴 —— 而
      // 「承接 / 音频」这类关键字段恰好在末尾。挂 title 让人悬停能看全。
      function setStatus(text) {
        statusLine.textContent = text;
        statusLine.title = text;
      }

      // 把执行结果落到面板上。两条通道（executed 事件 / history 轮询）都会调它，
      // 重复调无害 —— 只是把同一份工程重新画一遍。
      function applyResult(fullJson, report) {
        if (Array.isArray(fullJson)) fullJson = fullJson[0];
        if (fullJson) {
          try {
            const proj = JSON.parse(fullJson);
            if (proj && Array.isArray(proj.segments)) {
              state.project = proj;
              const n = proj.segments.length;
              state.current = Math.min(state.current, Math.max(0, n - 1));
              renderAll();
              syncProject();
            }
          } catch (e) {
            console.error("[MV规划台] 回执 JSON 解析失败", e);
          }
        }
        let rep = report;
        if (Array.isArray(rep)) rep = rep.join("\n");
        if (rep) {
          // 报告是多行拼接，状态行只有一行 —— 全文进 title，正文显示第一行。
          setStatus(String(rep).split("\n")[0]);
          statusLine.title = String(rep);
        }
      }

      function onExecuted(detail) {
        if (String(detail.node) !== String(node.id)) return;
        watchedPid = "";                  // 事件已带回结果，轮询收工
        const out = detail.output || {};
        applyResult(out.project, out.report);
      }

      // history 轮询兜底：executed 事件偶尔会晚到或丢，后端 history 一定有记录
      // （节点现在返回 ui，才会写进 history.outputs）。
      let watchedPid = "";
      async function watchHistory(pid) {
        watchedPid = pid;
        for (let i = 0; i < 600; i++) {
          await new Promise((ok) => setTimeout(ok, i === 0 ? 400 : 1000));
          if (watchedPid !== pid) return;        // 已被 executed 接手
          let entry = null;
          try {
            const r = await api.fetchApi("/history/" + pid);
            entry = (await r.json())[pid];
          } catch (_) { continue; }
          if (!entry) continue;                  // 还在排队 / 执行中
          watchedPid = "";
          const outs = (entry.outputs || {})[String(node.id)];
          if (!outs) { setStatus("⚠️ 后端没有回传本节点的结果"); return; }
          applyResult(outs.project, outs.report);
          return;
        }
      }
      // 每个实例注册一个监听，不注销的话删掉节点后闭包仍持有整棵 DOM，
      // 而且多个规划台会各自响应同一次 executed（靠 node.id 挡住副作用，
      // 但白跑的 handler 一直在）。
      const onExecHandler = (e) => onExecuted(e.detail);
      api.addEventListener("executed", onExecHandler);
      // 执行失败必须显示在面板上：只在浏览器控制台报错，用户看到的就是
      // 「点了没反应」，完全没法自查。
      const onErrHandler = (e) => {
        const d = (e && e.detail) || {};
        if (String(d.node_id) !== String(node.id)) return;
        const msg = d.exception_message || d.exception_type || "未知错误";
        setStatus("❌ 执行失败：" + msg);
        console.error("[MV规划台] 执行失败", d);
      };
      api.addEventListener("execution_error", onErrHandler);
      chain(node, "onRemoved", function () {
        api.removeEventListener("executed", onExecHandler);
        api.removeEventListener("execution_error", onErrHandler);
        stopSpec();                 // 节点删了，帧循环必须停
        ro.disconnect();
        if (syncTimer) clearTimeout(syncTimer);
        delete node._mvSyncButtons;
      });
      // 接线变化在 prototype 级回调里，那里拿不到本闭包 —— 挂一个引用出去，
      // 这样接上/拔掉音频线时按钮状态能立刻跟着变。
      node._mvSyncButtons = syncButtons;

      // ── 尺寸双通道 ─────────────────────────────────────────────
      const domWidget = node.addDOMWidget(
        "mv_planner_panel", "mv_planner", root, { serialize: false });
      node.widgets.unshift(node.widgets.pop());
      if (domWidget) {
        // minHeight 报小值 + maxHeight 无限：控件撑满节点主体。这是 h3 预览
        // 跑通的写法（minHeight 只是布局下限，不是容器高度）。
        domWidget.computeLayoutSize = () => ({
          minHeight: 120, maxHeight: undefined, minWidth: 0,
        });
      }
      // 故意**不**自定义 computeSize：一旦返回固定高度，litegraph 会把它当成
      // 该 widget 的占位，再叠加那几个 hidden widget 的 -4 负高度，节点总高
      // 就和面板实际高度对不上。h3 预览同样不设 computeSize。
      node.setSize([Math.max(node.properties[W_KEY] || node.size?.[0] || PANEL_W,
                             MIN_W),
                    (LiteGraph.NODE_TITLE_HEIGHT || 30) + PANEL_H]);

      // 宽度是**唯一真值**（高度永远由宽度推导、不记忆）。新版前端 GraphView
      // 有一条 DOM→节点的单向尺寸覆盖：只要 liteNode.size 与 Vue 算出的
      // layout.size 不等就用 layout.size 覆盖（不是取大）—— 手动拉宽的副本
      // 松手瞬间缩回去就是它干的。纠正只能挂在 onResize：它是尺寸的唯一
      // 写入口，谁改尺寸都从这过；选时机（rAF / pointerup / 超时兜底）都可能
      // 早于那次覆盖而被吃掉。
      chain(node, "onResize", function (size) {
        const total = (LiteGraph.NODE_TITLE_HEIGHT || 30) + PANEL_H;
        if (app.canvas && app.canvas.resizing_node === node) {
          // 用户亲手拖：宽度记真值，**高度也尊重他** —— 面板内容固定 542，
          // 往下拉只是在底部留空，那是用户的自由；抢回去等于把底边焊死，
          // 用户报「没办法往下拉长了」就是这么来的。和宽度同一条分流原则：
          // 用户亲手操作的永远实时，只有代码自发的覆盖才拉回推导值。
          node.properties[W_KEY] = Math.round(size[0]);
          requestDrawTimeline();
          return;
        }
        // Vue 覆盖 / configure / 折叠：立刻拉回推导值（宽和高都拉）
        const wantW = Math.max(node.properties[W_KEY] || PANEL_W, MIN_W);
        if (Math.abs(size[0] - wantW) > 1 && !node._bz_fixingW) {
          node._bz_fixingW = true;   // setSize 会再触发 onResize，一层递归即收敛
          node.setSize([wantW, total]);
          node._bz_fixingW = false;
          return;
        }
        if (Math.abs(size[1] - total) > 1) size[1] = total;
        // 诊断：常量必须与 CSS 实际占位一致。差超过 2px 就在控制台报一次，
        // 直接给出差值 —— 以后不用再靠肉眼猜「面板底为什么和节点底对不上」。
        if (!node._bz_hChecked && root.scrollHeight) {
          node._bz_hChecked = true;
          const diff = root.scrollHeight - PANEL_H;
          if (Math.abs(diff) > 2) {
            console.warn("[MV规划台] 面板实际高 " + root.scrollHeight
              + "px，常量 " + PANEL_H + "px，差 " + diff + "px —— 核对 PANEL_H");
          }
        }
        requestDrawTimeline();
      });

      chain(node, "onConfigure", function () {
        // 先重新绑定 + 隐藏：configure 可能重建了 widget 对象，晚了就会读到
        // 孤立的旧 widget（值全是空的），面板也不会显示存档里的内容。
        bindWidgets();
        const raw = node.properties?.mv_project;
        if (raw) {
          try {
            state.project = JSON.parse(raw);
            // 当前段也要恢复：widget 值由 ComfyUI 从存档读回来，不读的话
            // 刷新后永远停在第 1 段，用户得重新点一遍。
            const ci = wMap.current_index?.value;
            if (typeof ci === "number" && ci >= 0) state.current = ci;
            const ap = state.project.audio?.path;
            if (ap) {
              state.songRel = ap;
              if (wMap.audio_path) wMap.audio_path.value = ap;
              dropzone.style.display = "none";
              player.style.display = "flex";
              fname.textContent = ap.split("/").pop();
              audioEl.src = viewUrlOf(ap);
            }
            renderAll();
          } catch (_) {}
        }
        syncButtons();   // 没有存档（新建节点）时也要把按钮置灰
        pinPortLabels(node);
        requestAnimationFrame(() => {
          pinPortLabels(node);
          if (node.onResize) node.onResize(node.size);
          drawSpec();
        });
      });

      const ro = new ResizeObserver(() => {
        specW = 0;                  // 尺寸变了，频谱画布下一帧重新量一次
        requestDrawTimeline();
        drawSpec();
      });
      ro.observe(player);

      pinPortLabels(node);
      renderAll();
    });

    // 接线变化会重建 slot，补钉中文标签
    chain(nodeType.prototype, "onConnectionsChange", function () {
      pinPortLabels(this);
      // 音频线接上/拔掉会改变「分析歌曲」能不能点
      if (typeof this._mvSyncButtons === "function") this._mvSyncButtons();
    });
  },
});
