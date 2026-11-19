import { api } from "../../scripts/api.js";
import { bzStore } from "./bz_store.js";
import { injectBoardCss } from "./bz_board_css.js";
import { anchorEl } from "./bz_board_anchor.js";

/* 导演台分镜轨（20261119）：音频轨下面一行图片锚。
   一个锚 = 一张 input 图 + 整片绝对帧号；出条件时导演台把落在本段的锚
   挂进 minimax_keyframes（与续写锚同构，真驱动不是参考）。
   一次拖多张图＝在落点所在段内均布；左右拖锚改时间点；点图大预览；× 删锚。
   锚存片级 meta bzsa.board（GET/POST /cglide/chain/board），刷新 / 切工程不丢。
   坐标只认时间轴那把尺子（opts.pxOf / wOf），与段块、音频块同一原点。
   样式在 bz_board_css.js，锚交互在 bz_board_anchor.js。 */

const GUTTER = 26;
const HINT = "把图片拖到这里＝分镜锚（一次拖多张在本段均布）；左右拖改时间点，点图预览，× 删除";

export function mountBoardLane(opts) {
  injectBoardCss();
  const host = opts.after;
  if (!host || !host.parentElement) return null;
  const box = document.createElement("div");
  box.className = "bzsb-box";
  /* 轨头只留 26px 占位与音频轨对齐：图标纯标签无功能，用户嫌冗余删了。 */
  box.innerHTML = '<div class="bzsb-head"></div>'
    + '<div class="bzsb-lane"><div class="bzsb-hint">' + HINT + "</div></div>";
  host.insertAdjacentElement("afterend", box);
  const lane = box.querySelector(".bzsb-lane");
  const hint = box.querySelector(".bzsb-hint");

  let entries = [], film = null, subName = "", unsub = null;

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
  const frameAtX = (x) => {
    const k = ppf();
    return k ? Math.round((x - pxOf(0)) / k) : 0;
  };
  const clampAt = (a) => Math.max(0, Math.min(Math.max(0, totalOf() - 1), Math.round(a)));
  const fmt = (fr) => {
    const s = Math.max(0, fr) / fpsOf();
    return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  };
  const imgUrl = (rel) => {
    const t = String(rel || ""), i = t.lastIndexOf("/");
    return "/view?filename=" + encodeURIComponent(i >= 0 ? t.slice(i + 1) : t)
      + "&subfolder=" + encodeURIComponent(i >= 0 ? t.slice(0, i) : "") + "&type=input";
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
      pxOf, fmt, imgUrl, ppf, clampAt, save,
      del: (ent) => entries.splice(entries.indexOf(ent), 1),
    };
    entries.forEach((ent) => lane.appendChild(anchorEl(ent, ctx)));
  }

  async function save() {
    const name = nameOf();
    if (!name) return;
    try {
      const j = await askJson("/cglide/chain/board", {
        name, entries: entries.map((e) => ({ file: e.file, at: e.at })),
      });
      entries = Array.isArray(j.board) ? j.board : entries;
      render();
    } catch (e) {
      console.warn("[board-lane] 保存失败:", e);
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
    const rect = lane.getBoundingClientRect();
    const spots = dropSpots(files.length, clampAt(frameAtX(e.clientX - rect.left)));
    hint.textContent = "正在上传 " + files.length + " 张图…";
    hint.style.display = "";
    try {
      for (let i = 0; i < files.length; i++) {
        entries.push({ file: await upload(files[i]), at: spots[i] });
      }
      await save();
    } catch (err) {
      console.warn("[board-lane] 拖入失败:", err);
    }
    hint.textContent = HINT;
    render();
  }

  async function loadBoard(name) {
    try {
      const j = await askJson("/cglide/chain/board?name=" + encodeURIComponent(name));
      if (nameOf() !== name) return;
      entries = Array.isArray(j.board) ? j.board : [];
      render();
    } catch (_) {}
  }

  /* 切工程 / 刷新：名字变了就重订阅＋拉锚表；边界变化跟 bzStore 重摆。 */
  function ensureSub() {
    const name = nameOf();
    if (name === subName) return;
    subName = name;
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    entries = [];
    film = null;
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
  /* 节点被删后 box.isConnected 为假，自然停转，不另设卸载接口。 */
  setInterval(() => { if (box.isConnected) ensureSub(); }, 1500);

  const apiObj = { box, sync: render, refresh: ensureSub };
  host.__bzsb = apiObj;
  return apiObj;
}