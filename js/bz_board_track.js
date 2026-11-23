import { api } from "../../scripts/api.js";
import { bzStore } from "./bz_store.js";
import { injectBoardCss } from "./bz_board_css.js";
import { anchorEl } from "./bz_board_anchor.js";

/* 导演台分镜轨（20261119）：音频轨下面一行图片锚。
   一个锚 = 一张 input 图 + 整片绝对帧号；出条件时导演台把落在本段的锚
   挂进 minimax_keyframes（与续写锚同构，真驱动不是参考）。
   一次拖多张图＝在落点所在段内均布；左右拖锚改时间点；点图大预览；× 删锚。
   锚存片级 meta bzsa.board：**读 GET /cglide/chain/board、写 POST /cglide/chain/board_set**
   （读写必须分路径 —— 同路径双 method 会被 LG_HotReload 按路径覆盖 handler，
     GET 落到 POST 上，表现＝刷新 / 切工程后锚全不见；见 _selftest_routes.py）。
   保存前必须 loaded=true：整表覆写口径下，读回失败还去保存＝把库里旧的抹掉。
   坐标只认时间轴那把尺子（opts.pxOf / wOf），与段块、音频块同一原点。
   样式在 bz_board_css.js，锚交互在 bz_board_anchor.js。 */

const GUTTER = 26;
/* 锚缩略图边长，与媒体架 csglide_rack_core.THUMB_SIZE 同值：服务端缩略图缓存
   key 含 size，同 size 同 URL 才共享那一份。不直接 import 过来是因为 rack_core
   反向 import 了 csglide_cast.js，接进来会成模块环。 */
const THUMB = 256;
/* 能走缩略图端点的扩展名（服务端 PIL 认得的），与 csglide_qwen.js 同表。 */
const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const HINT = "把图片拖到这里＝分镜锚（一次拖多张在本段均布）；左右拖改时间点，点图预览，× 删除";

export function mountBoardLane(opts) {
  injectBoardCss();
  const host = opts.after;
  if (!host || !host.parentElement) return null;
  const box = document.createElement("div");
  box.className = "bzsb-box";
  /* 轨头只留 26px 占位与音频轨对齐：图标纯标签无功能，用户嫌冗余删了。 */
  box.innerHTML = '<div class="bzsb-head"></div>'
    + '<div class="bzsb-lane"><div class="bzsb-hint">' + HINT + "</div>"
    + '<div class="bzsb-err"></div></div>';
  host.insertAdjacentElement("afterend", box);
  const lane = box.querySelector(".bzsb-lane");
  const hint = box.querySelector(".bzsb-hint");
  const errEl = box.querySelector(".bzsb-err");

  let entries = [], film = null, subName = "", unsub = null;
  /* loaded = 本工程的锚表**成功**从后端读回来过。整表覆写口径下它是唯一的
     数据安全闸：读回失败时 entries 是空的，此时任何一次 save() 都等于把库里
     已有的锚全删掉 ——「拖一张图，旧的 5 张没了」就是这么来的（20261119）。 */
  let loaded = false;

  const nameOf = () => (opts.getName && opts.getName()) || "";
  const fpsOf = () => Number(film && film.fps) || 24;
  const clipsOf = () => (film && Array.isArray(film.clips) ? film.clips : []);
  const totalOf = () => {
    let t = 0;
    for (const r of clipsOf()) t = Math.max(t, Number(r && r.clip_to) || 0);
    return t;
  };
  const pxOf = (f) => (opts.pxOf ? opts.pxOf(f) : 0);
  const ppf = () => Math.max(0, pxOf(1) - pxOf(0));
  /* 画布缩放：屏幕像素 / DOM 局部像素。film.js 自家拖动一律除 scale，
     这里同款——不除的话缩放≠1 时锚跑得比鼠标快几倍（用户报「不跟手」）。 */
  const screenScale = () => {
    const r = lane.getBoundingClientRect();
    return lane.clientWidth && r.width ? r.width / lane.clientWidth : 1;
  };
  /* 缩略图 48px 宽，视觉位置夹在 lane 内，尾锚不探出节点框；
     时间标签仍显示真实 at，中间区域位置精确。 */
  const visLeft = (at) => Math.max(0, Math.min(pxOf(at), lane.clientWidth - 48));
  const frameAtX = (x) => {
    const k = ppf();
    return k ? Math.round((x - pxOf(0)) / k) : 0;
  };
  /* clientX → 帧：减轨道左缘、除画布缩放，只在这里做一次，锚模块不碰尺子内部。
     落点（onDrop）与拖锚（bz_board_anchor.js）必须同一个基准，否则「拖到的位置」
     和「换算出的帧号」差一个左缘偏移。屏幕像素不除 scale 的话，缩放≠1 时
     锚跑得比鼠标快几倍、一拖就撞尾（用户报「不跟手、跑出节点框」的根因）。 */
  const frameAtClientX = (cx) =>
    frameAtX((cx - lane.getBoundingClientRect().left) / screenScale());
  const clampAt = (a) => Math.max(0, Math.min(Math.max(0, totalOf() - 1), Math.round(a)));
  const fmt = (fr) => {
    const s = Math.max(0, fr) / fpsOf();
    return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  };
  /* 锚只有 48×32，以前直接拉 /view 原图：4K 素材解码 ≈46MB/张，一屏十几条锚就
     是几百 MB，而 render 是全删重建 DOM，切工程 / 每次保存都重走一遍。改走自建
     的 /cglide/thumb（服务端真缩尺寸 + 磁盘缓存 + ETag），口径照 csglide_qwen.js
     的 viewURL。顺手补上以前漏掉的 api.apiURL 前缀（挂子路径部署时 /view 会 404）。
     ⚠️ 只有 IMG_EXT 里的扩展名才走缩略图：svg / heic 这类后端回 415，必须回落
        原图，否则锚从「能显示」变成裂图。点图的大预览走 fullUrl，始终原图。 */
  const splitRel = (rel) => {
    const t = String(rel || ""), i = t.lastIndexOf("/");
    return i >= 0 ? [t.slice(0, i), t.slice(i + 1)] : ["", t];
  };
  const fullUrl = (rel) => {
    const p = splitRel(rel);
    return api.apiURL("/view?filename=" + encodeURIComponent(p[1])
      + "&subfolder=" + encodeURIComponent(p[0]) + "&type=input");
  };
  const imgUrl = (rel) => {
    const p = splitRel(rel), dot = p[1].lastIndexOf(".");
    const ext = dot >= 0 ? p[1].slice(dot + 1).toLowerCase() : "";
    if (!IMG_EXT.has(ext)) return fullUrl(rel);
    return api.apiURL("/cglide/thumb?filename=" + encodeURIComponent(p[1])
      + "&subfolder=" + encodeURIComponent(p[0]) + "&size=" + THUMB);
  };

  async function askJson(url, body) {
    const r = await api.fetchApi(url, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    let j = {};
    try { j = await r.json(); } catch (_) { j = {}; }
    const err = j["错误"] || j.error;
    if (err) throw new Error(String(err));
    if (!r.ok) throw new Error("接口返回异常（" + r.status + "）");
    return j;
  }

  async function upload(file) {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("type", "input");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("上传失败，可能是文件太大或格式不支持");
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  /* 行宽与音频轨同口径：最后一块 clip_to × 尺子 + 轨头列，尺子没起走 CSS 兜底。 */
  function syncWidth() {
    const last = totalOf();
    const w = last > 1 && opts.wOf ? Math.max(1, opts.wOf(last)) : 0;
    box.style.width = w > GUTTER ? (w + GUTTER) + "px" : "";
  }

  function render() {
    syncWidth();
    lane.querySelectorAll(".bzsb-anchor").forEach((n) => n.remove());
    hint.style.display = entries.length ? "none" : "";
    const ctx = {
      pxOf, fmt, imgUrl, fullUrl, ppf, clampAt, frameAtClientX, save, visLeft,
      del: (ent) => entries.splice(entries.indexOf(ent), 1),
    };
    entries.forEach((ent) => lane.appendChild(anchorEl(ent, ctx)));
  }

  /* 错误走轨右上角那行常驻小字（.bzsb-err），不借 hint —— hint 在有锚时会被
     render() 隐藏，「保存失败」必须看得见，否则又是静默（本次事故的第二层）。 */
  function note(msg) {
    if (errEl) errEl.textContent = msg || "";
    if (msg) console.warn("[board-lane] " + msg);
  }

  async function save() {
    const name = nameOf();
    if (!name) return;
    if (!loaded) {
      note("锚表没读回来，已拒绝保存（否则会把库里已有的锚整表抹掉）—— 正在重试");
      void loadBoard(name);          // 自愈：后端那条 GET 恢复后这一发就通
      return;
    }
    try {
      const j = await askJson("/cglide/chain/board_set", {
        name, entries: entries.map((e) => ({ file: e.file, at: e.at })),
      });
      entries = Array.isArray(j.board) ? j.board : entries;
      const lost = Array.isArray(j["丢弃"]) ? j["丢弃"] : [];
      /* 后端整表覆写时会丢不合规的条目（文件不在 input、路径越界…）。
         丢一条等于删一条锚，必须点名，不能再只回一份看着正常的表。 */
      note(lost.length
        ? "有 " + lost.length + " 个锚没存上："
          + lost.map((d) => (d.file || "（无名）") + "（" + (d["原因"] || "原因未报") + "）").join("；")
        : "");
      render();
    } catch (e) {
      note("保存失败：" + ((e && e.message) || e) + " —— 屏上这个位置还没落盘");
    }
  }

  /* 多张落点：在落点所在段内均布（含段首尾）；落点不在任何段＝全片均布。 */
  function dropSpots(n, at) {
    if (n === 1) return [at];
    const row = clipsOf().find((r) =>
      at >= (Number(r.clip_from) || 0) && at < (Number(r.clip_to) || 0));
    const cf = row ? Number(row.clip_from) || 0 : 0;
    const ct = row ? Number(row.clip_to) || 0 : Math.max(totalOf(), at + 1);
    const len = Math.max(1, ct - cf);
    const out = [];
    for (let i = 0; i < n; i++) out.push(clampAt(cf + Math.round(i * (len - 1) / (n - 1))));
    return out;
  }

  async function onDrop(e) {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      .filter((f) => (f.type || "").startsWith("image/"));
    if (!files.length || !nameOf()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!loaded) {
      /* 没读回旧锚就先别收新锚：save 是整表覆写，这一发会把库里那几条抹掉。 */
      note("锚表还没读回来，先不收新图（否则保存会覆盖库里已有的锚）—— 正在重试");
      void loadBoard(nameOf());
      return;
    }
    const spots = dropSpots(files.length, clampAt(frameAtClientX(e.clientX)));
    hint.textContent = "正在上传 " + files.length + " 张图…";
    hint.style.display = "";
    try {
      for (let i = 0; i < files.length; i++) {
        entries.push({ file: await upload(files[i]), at: spots[i] });
      }
      await save();
    } catch (err) {
      note("拖入失败：" + ((err && err.message) || err));
    }
    hint.textContent = HINT;
    render();
  }

  async function loadBoard(name) {
    try {
      const j = await askJson("/cglide/chain/board?name=" + encodeURIComponent(name));
      if (nameOf() !== name) return;
      entries = Array.isArray(j.board) ? j.board : [];
      loaded = true;
      note("");
      render();
    } catch (e) {
      /* 原先这里是 catch (_) {} —— 一句都不说。读回失败于是变成「锚自己消失了」，
         而库里其实还好好的（本次事故的第三层：失败必须可见）。 */
      loaded = false;
      note("锚表读取失败：" + ((e && e.message) || e) + " —— 已禁止保存，避免覆盖旧锚");
    }
  }

  /* 切工程 / 刷新：名字变了就重订阅＋拉锚表；边界变化跟 bzStore 重摆。 */
  function ensureSub() {
    const name = nameOf();
    if (name === subName) return;
    subName = name;
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    entries = [];
    film = null;
    loaded = false;          // 换工程＝上一份的读回结果作废，未读回前不许保存
    note("");
    render();
    if (!name) return;
    const snap = bzStore.film(name);
    if (snap) film = snap;
    void loadBoard(name);
    unsub = bzStore.subscribe(name, (d) => {
      if (!d || d.immediate) return;
      const s = bzStore.film(name);
      if (s) { film = s; render(); }
    });
    if (!snap) {
      void askJson("/cglide/chain/film_summary?name=" + encodeURIComponent(name))
        .then((j) => { if (nameOf() === name) { film = j; render(); } })
        .catch(() => {});
    }
  }

  box.addEventListener("dragover", (e) => {
    e.preventDefault();
    box.classList.add("bzsb-over");
  });
  box.addEventListener("dragleave", () => box.classList.remove("bzsb-over"));
  box.addEventListener("drop", (e) => {
    box.classList.remove("bzsb-over");
    void onDrop(e);
  });

  ensureSub();
  /* 节点被删后 box.isConnected 为假，自然停转，不另设卸载接口。
     读回没成功时每 6 秒再试一次（轮询本身 1.5 秒一次，别把失败刷成刷屏）：
     后端那条 GET 恢复后不需要用户再动手，锚自己就回来了。 */
  let lastTry = Date.now();
  setInterval(() => {
    if (!box.isConnected) return;
    ensureSub();
    if (!loaded && subName && Date.now() - lastTry > 6000) {
      lastTry = Date.now();
      void loadBoard(subName);
    }
  }, 1500);

  const apiObj = { box, sync: render, refresh: ensureSub };
  host.__bzsb = apiObj;
  return apiObj;
}