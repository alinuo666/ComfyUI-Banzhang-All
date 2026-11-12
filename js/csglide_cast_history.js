/* ============================================================
 * 历史旧工程菜单（轴头「🕘 历史 ▾」· 20261013）
 * ------------------------------------------------------------
 * 点开是一个轻量下拉菜单，列出 output/h3_chain/ 下的**整部旧工程**
 * （不是操作记录，不是 undo/redo），点任一行即切换到那个工程。
 *
 * 数据通道：
 *   GET  /cglide/chain/history/list   工程清单（新 DB / 老 JSON 都支持）
 *   GET  /cglide/chain/history/bundle 切换整包（见 bz_project_sync.switchToProject）
 *   POST /cglide/chain/history/reveal 打开档案目录
 *
 * 老 JSON 工程（20261012 前）：媒体架/文案台当时未归档，菜单标「老工程」，
 * 切换后只恢复导演台段面板参数。
 * ============================================================ */
import { api } from "../../scripts/api.js";
import { el } from "./csglide_ui_kit.js";

export function installHistory(ui) {
  let listCache = null;
  let showSys = false;

  /* 相对时间：刚刚 / N分钟前 / N小时前 / N天前；更早显示日期。 */
  function fmtAgo(ts) {
    if (!ts) return "";
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + "分钟前";
    if (s < 86400) return Math.floor(s / 3600) + "小时前";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "天前";
    const d = new Date(ts * 1000);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  /* 时长用工程账帧 / 24 给个约值（含承接重叠，显示足够）。 */
  function fmtDuration(frames) {
    const sec = Math.round((frames / 24) * 10) / 10;
    return sec + "s";
  }

  /* 历史清单是纯只读 GET，不需要 ComfyUI 的客户端身份包装。走原生 fetch
     少一层 api.fetchApi 的版本差异（20261109「列表恒加载失败」根修）；
     同一进程里这条 URL 实测 HTTP 200 + JSON，后端没有异常。 */
  async function fetchList() {
    const q = showSys ? "?include_sys=1" : "";
    const res = await fetch("/cglide/chain/history/list" + q);
    if (!res.ok) throw new Error("接口返回 HTTP " + res.status);
    try {
      return await res.json();
    } catch (e) {
      throw new Error("返回不是 JSON：" + String((e && e.message) || e));
    }
  }

  /* 菜单定位：锚点下方展开，贴边/下方不够时自动翻转。 */
  function positionMenu(menu, r) {
    document.body.append(menu);
    const mw = menu.offsetWidth || 272;
    const mh = menu.offsetHeight || 200;
    let x = r.left;
    let y = r.bottom + 4;
    if (x + mw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - mw - 8);
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
  }

  function openHistoryMenu(anchor) {
    document.querySelectorAll(".gcast-hist").forEach((m) => m.remove());
    if (ui.run) {
      ui.lanesFlash("渲染中不能切换工程 —— 等这轮跑完（或先停止）");
      return;
    }
    const r = anchor.getBoundingClientRect();
    const menu = el("div", "gcast-menu gcast-hist");

    /* 搜索框 */
    const search = el("input", "gcast-hist-search");
    search.type = "text";
    search.placeholder = "搜索旧工程…";
    menu.append(search);

    /* 列表 */
    const listBox = el("div", "gcast-hist-list");
    listBox.append(el("div", "gcast-hist-empty", "加载中…"));
    menu.append(listBox);
    menu.append(el("div", "gcast-msep"));

    /* 底部操作 */
    const foot = el("div", "gcast-hist-foot");
    const btnRefresh = el("button", null, "↻ 刷新");
    btnRefresh.type = "button";
    const btnSys = el("button", null, "显示系统工程");
    btnSys.type = "button";
    const btnReveal = el("button", null, "📁 档案目录");
    btnReveal.type = "button";
    foot.append(btnRefresh, btnSys, el("div", "sp"), btnReveal);
    menu.append(foot);

    positionMenu(menu, r);
    const onDoc = (ev) => {
      if (menu.contains(ev.target)) return;
      menu.remove();
      document.removeEventListener("pointerdown", onDoc, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", onDoc, true), 0);

    function renderRows(projects) {
      const q = (search.value || "").trim().toLowerCase();
      listBox.innerHTML = "";
      const cur = (ui.proj() && ui.proj().name) || "";
      const rows = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
      if (!rows.length) {
        listBox.append(el("div", "gcast-hist-empty", q ? "没有匹配的工程" : "还没有旧工程"));
        return;
      }
      rows.forEach((p) => {
        const row = el("button", "gcast-hist-row");
        row.type = "button";
        if (p.name === cur) row.setAttribute("aria-current", "true");

        const dot = el("span", "gcast-hist-dot " + (p.status || "empty"));
        const main = el("div", "gcast-hist-main");
        const name = el("div", "gcast-hist-name");
        name.textContent = p.name + (p.name === cur ? "  ✓" : "");
        const parts = [p.segCount + "段"];
        if (p.totalFrames) parts.push(fmtDuration(p.totalFrames));
        if (p.w) parts.push(p.w + "×" + p.h);
        parts.push(p.sizeMB + "MB");
        if (p.status === "miss") parts.push(p.playable + "/" + p.segCount + "段成片");
        const sub = el("div", "gcast-hist-sub", parts.join(" · "));
        main.append(name, sub);

        row.append(dot, main);
        if (p.backend === "json") {
          const tag = el("span", "gcast-hist-tag", "老工程");
          tag.title = "早期 JSON 工程：媒体架/文案台未归档，只恢复导演台参数";
          row.append(tag);
        }
        row.append(el("span", "gcast-hist-when", fmtAgo(p.openedAt)));

        /* 一键删除整个工程目录：当前工程不显示（删自己会状态错乱），其余直接
           删、无弹窗、无确认。点击 stopPropagation，不触发整行切换。 */
        if (p.name !== cur) {
          const del = el("span", "gcast-hist-del", "✕");
          del.title = "删除整个工程（不可恢复）";
          del.onclick = async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (del.dataset.busy) return;
            del.dataset.busy = "1";
            del.classList.add("busy");
            try {
              const r = await api.fetchApi("/cglide/chain/history/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: p.name, dir: p.dir }),
              });
              const d = await r.json().catch(() => ({}));
              if (!r.ok || d.error) {
                ui.lanesFlash("删除失败：" + (d.error || "HTTP " + r.status));
                del.dataset.busy = "";
                del.classList.remove("busy");
                return;
              }
              /* 同步缓存后整列表重渲染，该行立即消失。 */
              listCache = (listCache || []).filter((x) => x.name !== p.name);
              renderRows(listCache);
            } catch (e) {
              ui.lanesFlash("删除失败：" + (e && e.message ? e.message : e));
              del.dataset.busy = "";
              del.classList.remove("busy");
            }
          };
          row.append(del);
        }

        row.onclick = async () => {
          if (p.name === cur) { menu.remove(); return; }
          menu.remove();
          try {
            await ui.switchToProject(p.name);
          } catch (e) {
            ui.lanesFlash("切换失败：" + (e && e.message ? e.message : e));
          }
        };
        listBox.append(row);
      });
    }

    async function reload() {
      listBox.innerHTML = "";
      listBox.append(el("div", "gcast-hist-empty", "加载中…"));
      try {
        const d = await fetchList();
        listCache = d.projects || [];
        renderRows(listCache);
      } catch (e) {
        /* 以前这里只写死一句「加载失败」，接口错 / JSON 错 / 渲染错全被吞成
           同一句话，永远查不出真因。现在把原因直接写在菜单里（title 留全文）。 */
        const msg = String((e && e.message) || e || "未知错误");
        listBox.innerHTML = "";
        const box = el("div", "gcast-hist-empty", "列表加载失败：" + msg + "（点 ↻ 刷新重试）");
        box.title = msg;
        listBox.append(box);
      }
    }

    search.oninput = () => { if (listCache) renderRows(listCache); };
    btnRefresh.onclick = (e) => { e.stopPropagation(); reload(); };
    btnSys.onclick = (e) => {
      e.stopPropagation();
      showSys = !showSys;
      btnSys.textContent = showSys ? "隐藏系统工程" : "显示系统工程";
      reload();
    };
    btnReveal.onclick = (e) => {
      e.stopPropagation();
      api.fetchApi("/cglide/chain/history/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }).catch(() => {});
    };

    reload();
    setTimeout(() => { try { search.focus(); } catch (_) {} }, 30);
  }

  Object.assign(ui, { openHistoryMenu });
}
