import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el } from "./csglide_ui_kit.js";
import { findRatio } from "./csglide_cast_core.js";

/* ============================================================
 * 版本（takes）
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installTakes(ui) {
  /* ================= 版本（takes）=====================================
     一段可以抽很多次。每次重抽存成一个新版本，旧的留在磁盘上，于是「换一个
     镜头」变成「在这一段里选第几版」，而不是把这一段覆盖掉、后面全跟着重跑。

     能不能真的不动后面，判据只有一条：新版与旧版的**尾部窗口**（下一段的引导
     头就是它）是不是一致。一致 → 下一段的潜空间照样成立，只是累积成片旧了，
     重拼一次即可；不一致 → 下一段必须重抽。这个判定在后端做（比潜空间指纹），
     前端只负责把结论说清楚。 */

  /** 段级菜单里的「版本」组。异步：版本清单以磁盘为准，得问后端。
      slot 是菜单里预先占好的空壳 —— 拉不到清单就整组撤掉，不留空标题。 */
  async function paintTakeGroup(holder, clipRow) {
    const name = ui.castName();
    const cid = clipRow && clipRow.id;
    if (!name || !cid) { holder.remove(); return; }
    /* 本模块搬出 buildUI 后拿不到原来的 menu 局部变量 —— 从占位向上找它
       所在的菜单关掉即可（引用外部 menu 的按钮一点就 ReferenceError，
       表现就是"点了没效果"）。 */
    const closeMenu = () => holder.closest(".gcast-menu")?.remove();
    let data;
    try {
      data = await ui.chainJSON(`/cglide/chain/takes?name=${encodeURIComponent(name)}`
        + `&id=${encodeURIComponent(cid)}`);
    } catch (e) {
      holder.remove();              /* 拉不到就不显示这一组，不弹错打扰 */
      return;
    }
    if (!holder.isConnected) return;  /* 菜单已经关了 */
    const list = (data && data.takes) || [];
    if (list.length < 2) { holder.remove(); return; }  /* 一个版本没什么可切 */

    holder.append(el("div", "gcast-msep-label",
      `版本 ${data.current} / ${list.length}（重抽过 ${list.length - 1} 次）`));
    /* 一行 = 一个版本：左边「切到第 N 版」，右边一个 🗑（20261026 用户定）。
       原来是「版本清单」+ 单开一组「删除版本（释放磁盘）」标题 + N-1 个删除按钮 ——
       重抽 5 次菜单就长到 15 行，删除还躲在下面那组里，手一滑就点到。
       现在删除挂在各自那一行上：位置一眼可见，也不再额外多占行。 */
    list.forEach((r) => {
      const row = el("div", "gcast-take-row");
      const b = el("button", null, r.current
        ? `第 ${r.take} 版 · 正在用`
        : `切到第 ${r.take} 版`);
      const when = r.mtime ? new Date(r.mtime * 1000).toLocaleString() : "未知时间";
      b.title = `${r.take === 1 ? "最初那一版" : `第 ${r.take} 次重抽`}\n`
        + `${when} · ${(r.bytes / 1048576).toFixed(1)} MB\n\n`
        + "切换后后端会比对新旧两版的尾部窗口：一致则下一段不用重跑，"
        + "只是后面各段的累积成片要重拼一次。";
      if (r.current) b.setAttribute("aria-selected", "true");
      else b.onclick = () => { closeMenu(); switchTake(cid, r.take); };
      row.append(b);
      /* 当前版不给删：删掉正在用的那版，这一段就没有潜空间可用了。 */
      if (!r.current) {
        const del = el("button", "gcast-take-del", "🗑");
        del.title = `删掉第 ${r.take} 版 —— 连同它的潜空间与成片一起删，不可恢复`;
        del.onclick = (e) => {
          e.stopPropagation();        /* 别让这一下穿到「切版本」那个按钮上 */
          closeMenu();
          dropTake(cid, r.take);
        };
        row.append(del);
      }
      holder.append(row);
    });
  }

  async function takeJSON(body) {
    const res = await api.fetchApi("/cglide/chain/take", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /** 切到某一版，并把代价说清楚。 */
  async function switchTake(cid, take) {
    const name = ui.castName();
    if (!name) { ui.lanesFlash("还没有片名 —— 先在「工程」面板里填一个"); return; }
    let data;
    try {
      data = await takeJSON({ name, id: cid, take });
    } catch (err) {
      ui.lanesFlash(`换版本失败：${err.message || err}`);
      return;
    }
    if (!data.changed) {
      /* 静默返回 = 点了像没点（"无法使用"的观感之一）。如实说一句。 */
      ui.lanesFlash(`第 ${data.take} 版本来就是正在用的版本 —— 不需要切换`);
      return;
    }
    /* 版本绑参数（20261010）：切到哪版，画布就是哪版当时生成用的那个。
       改两处 —— 工程里这一段的 state（下次进这段就是对的）+ 面板当前
       st（正在看这段就立刻跟着变）。没记录的版（老渲染）不动面板。 */
    let canvasNote = "";
    const tp = data.take_params || {};
    if (Number(tp.w) > 0 && Number(tp.h) > 0) {
      const w = Number(tp.w), h = Number(tp.h);
      const rl = (findRatio(w, h) || {}).label || "custom";
      const p = ui.proj();
      const si = p.shots.findIndex((s) => String(s.clip || "") === String(cid));
      if (si >= 0 && p.shots[si].state) {
        p.shots[si].state.width = w;
        p.shots[si].state.height = h;
        p.shots[si].state.ratio = rl;
      }
      const cur = p.shots[p.idx];
      if (cur && String(cur.clip || "") === String(cid)) {
        ui.st.width = w;
        ui.st.height = h;
        ui.st.ratio = rl;
        ui.render();
      }
      canvasNote = ` · 画布跟随回到 ${w}×${h}`;
    }
    await ui.monitor.refresh();
    ui.paintSegTools();
    /* data.trim 是后端返回的该版本实际承接帧数；缺省兜底段间接续默认 22。 */
    const trim = data.trim || 22;
    if (data.tail_same === true) {
      /* 最关键的一句：换成功了，而且后面不用重跑。 */
      console.log(`[H3 Studio] 第 ${cid} 段切到第 ${data.take} 版 —— 尾部 ${trim} 帧一致，`
        + "下一段不用重抽。");
      ui.lanesFlash(`已切到第 ${data.take} 版 —— 尾部 ${trim} 帧一致，下一段不用重抽${canvasNote}`);
      return;
    }
    if (data.tail_same === false) {
      ui.lanesFlash(`已切到第 ${data.take} 版。⚠ 这一版尾部 ${trim} 帧和上一版不一样 —— `
        + `下一段（${data.next}）已被标成「重抽」待办${canvasNote}`);
      return;
    }
    /* tail_same === null：后端取不到指纹（没有潜空间档案 / safetensors 不可用）。
       照实说，不假装"没影响"。 */
    ui.lanesFlash(`已切到第 ${data.take} 版。⚠ 后端没能比对这一版的尾部窗口（这一段可能没有潜空间档案），`
      + "下一段会不会受影响无法确认 —— 播放一遍下一段确认接缝" + canvasNote);
  }

  async function dropTake(cid, take) {
    const name = ui.castName();
    if (!name) return;
    /* 不弹确认（点删除就删）。删掉的是非当前版，正在用的那一版不受影响。 */
    try {
      await takeJSON({ name, id: cid, take, drop: true });
      await ui.monitor.refresh();
      ui.paintSegTools();
      ui.lanesFlash(`已删掉第 ${take} 版（潜空间与成片一起删除，不可恢复）`);
    } catch (err) {
      ui.lanesFlash(`删版本失败：${err.message || err}`);
    }
  }

  /** 数一数画布上接了几个「💾 H3 续拍存档」节点。

      20261104：「📦 H3 段落存档」节点已删除，画布上不再有「另存为版本」
      复选框可以替用户勾。💾 由注册层固定按当前段/take 另存为版本，
      每次执行都留一个新版本（t1 → t2 → …），不受这里的 on 影响 ——
      这是刻意维持的既有行为，不是漏改。

      返回命中的存档节点数：0 个说明画布上没接存档节点，新版本根本
      存不下来，那时必须说清楚（否则用户以为自己重抽留了版本，其实
      什么都没存）。 */
  function setSaveNewTake(on) {
    const g = (typeof app !== "undefined" && app && app.graph) ? app.graph : null;
    const nodes = g ? (g._nodes || g.nodes || []) : [];
    let hit = 0;
    for (const nd of nodes) {
      if (!nd) continue;
      if (nd.type === "MiniMaxH3MotionContextSaveLatent"
        || nd.type === "BanZhang_H3_ClipArchive") {
        hit++;
      }
    }
    return hit;
  }


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { paintTakeGroup, takeJSON, switchTake, dropTake, setSaveNewTake });
}
