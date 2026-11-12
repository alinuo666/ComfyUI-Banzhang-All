import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { emitCastChange } from "./bz_rack.js";
import { blankState } from "./csglide_cast_core.js";
import { el } from "./csglide_ui_kit.js";

/* ============================================================
 * 工程 / 档案冲突检测 与 段落编辑
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installConflict(ui) {
  /* ---- 工程/档案冲突检测（P1-10 的 mtime 校验） --------------------------
     一个分段的时长有两个写入源，都合法、都可能被用户改：导演台面板的「长度」
     预设（跟工作流走）、时间轴拖边缘（写磁盘档案）。渲染时后端会用面板预设
     覆盖档案 —— 所以用户拖了时间轴却没重设面板长度，下次渲染就会被旧预设
     **静默覆盖**，这正是文档禁止的。

     这里在「渲染全部」之前拦一道：把工程里的分段预设发给后端，后端按 shot
     id 对齐档案，把对不上的段列出来，让用户逐条选「用面板」还是「用档案」。
     只查不改，绝不自己动手覆盖。 */

  async function syncCheck() {
    const p = ui.proj();
    const name = (p && p.name) || "";
    if (!name || !p.shots.length) return true;
    const shots = p.shots.map((sh) => ({
      id: sh.id || "",
      frames: sh.state ? sh.state.length : undefined,
      synced: sh.synced,
    }));
    let data;
    try {
      const res = await api.fetchApi("/cglide/chain/sync_check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, shots }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      /* 冲突检测失败不该挡渲染 —— 它是护栏不是门槛。静默放行。 */
      return true;
    }
    const conflicts = (data.conflicts || []);
    if (!conflicts.length) return true;
    /* 20261013 用户定：**一切以面板为准**。面板就是设置中心，拖时间轴改的段
       也会同步写进面板（applyFrames 两边一起写），所以"面板≠档案"只剩旧数据
       一种情形 —— 没必要弹窗把用户拦下来反问"哪边算数"（那是在问一句废话：
       用户在面板上做的所有设定，当然以面板为主）。直接按面板把档案改齐，
       用一行不挡操作的提示说清改了什么，然后照常渲染。 */
    const done = [];
    for (const c of conflicts) {
      try { await applySyncChoice(p, c, "preset"); } catch (_) { /* 单段失败不挡渲染 */ }
      done.push(`第${c.index}段 ${c.fact}→${c.preset} 帧`);
    }
    ui.lanesFlash?.(`档案时长与面板不一致，已按面板为准写齐：${done.join("、")}`);
    return true;
  }

  /** 弹冲突清单，让用户定哪边算数。返回是否「处理完毕、可以继续渲染」。 */
  function askSync(p, conflicts) {
    return new Promise((resolve) => {
      const wrap = el("div", "gcast-modal");
      const sheet = el("div", "gcast-sheet");
      sheet.append(el("h3", null,
        `有 ${conflicts.length} 段的「面板时长」和「档案」对不上`));
      const body = el("div", "body");
      body.append(el("div", "hint",
        "渲染会用面板预设覆盖档案。下面选哪边算数 —— 不选就点「先不渲染」。"));
      conflicts.forEach((c) => {
        const row = el("div", "gcast-sync-row");
        const t = el("div", "t");
        t.append(el("b", null, `第 ${c.index} 段`),
          el("span", null, `面板 ${c.preset} 帧 · 档案 ${c.fact} 帧`));
        row.append(t);
        body.append(row);
      });
      const foot = el("div", "foot");
      const cancel = el("button", "gcast-btn ghost", "先不渲染");
      const usePreset = el("button", "gcast-btn", "全部用面板");
      usePreset.title = "把这些段的档案时长都改成面板预设（会标成待办）";
      const useFact = el("button", "gcast-btn ghost", "全部用档案");
      useFact.title = "把这些段的面板预设都改成档案里的时长";
      foot.append(cancel, useFact, usePreset);
      sheet.append(body, foot);
      wrap.append(sheet);

      const close = () => { wrap.remove(); };
      cancel.onclick = () => { close(); resolve(false); };
      usePreset.onclick = async () => {
        close();
        await Promise.all(conflicts.map((c) => applySyncChoice(p, c, "preset")));
        resolve(true);
      };
      useFact.onclick = () => {
        close();
        conflicts.forEach((c) => applySyncChoice(p, c, "fact"));
        resolve(true);
      };
      wrap.addEventListener("pointerdown", (ev) => {
        if (ev.target === wrap) { close(); resolve(false); }
      });
      document.body.append(wrap);
      usePreset.focus();
    });
  }

  /** 落实用户对某一段的选择：用面板 → 写档案；用档案 → 改面板。 */
  async function applySyncChoice(p, c, which) {
    const sh = p.shots.find((s) => (s.id || "") === (c.shot || ""));
    if (which === "fact" && sh && sh.state) {
      sh.state.length = c.fact;
      ui.commit();
    } else if (which === "preset") {
      const name = p.name || "";
      try {
        const res = await api.fetchApi("/cglide/chain/resize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, id: c.id, frames: c.preset }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      } catch (err) {
        ui.lanesFlash("把档案时长改成面板预设失败：" + err.message);
      }
    }
  }

  /* moveShot(i, ±1) 已删（20261009）：它只服务右键菜单里的「← 前移 / 后移 →」，
     一次挪一位。那两个菜单项撤掉之后它就再没有调用者了 —— 留着是一段只会被
     误认为"排序还在"的死代码。排序改成了在轴上拽着段块走，落在
     csglide_cast_monitor.js 的 reorderTo()（工程与档案同改）。 */

  /* One place that flips the skip flag, reachable from the timeline dot,
   * the timeline Alt-click, and the project list dot. */
  function toggleSkip(i) {
    const p = ui.proj();
    const sh = p.shots[i];
    if (!sh) return;
    sh.off = !sh.off;
    ui.commit(); paintSegTools();
  }

  /* The link flag (sh.link === false means "break the chain") marks a seam as
   * NOT continuing from the previous clip. In continue mode, renderAll only
   * adopts the previous render into clips whose link is not explicitly false,
   * so the timeline lets you break one seam while the rest of the film stays
   * chained. */
  /* 断链 / 接上：唯一真值是工程映射 p.transitions（随工作流落盘）并同步后端
     /transitions（播放、导出成片读取）。旧实现只写 sh.link，导出仍连播、且与
     接缝卡片各写一套 —— 现统一走 ui.applyTransition。 */
  async function toggleLink(i) {
    if (ui.run) return;
    const p = ui.proj();
    const sh = p.shots[i];
    if (!sh || i < 1 || !sh.clip) return;
    const broken = !!(p.transitions && p.transitions[sh.clip]
      && p.transitions[sh.clip].type === "unlink");
    if (sh.link !== undefined) delete sh.link;  // 清掉旧的第二真值
    await ui.applyTransition(sh.clip,
      broken ? { type: "cut", overlap: 0 } : { type: "unlink", overlap: 0 });
    ui.commit();
    paintSegTools();
    if (typeof ui.paintLinkMarks === "function") ui.paintLinkMarks();
  }

  /* Close the project without touching the shot on screen. Clearing the list
   * and wiping the node are different wishes: the usual reason to start a new
   * project is that the shot you are looking at is the first one of it, so it
   * is kept and the next Add makes it Shot 1. "Blank" still gives an empty
   * node when that is what you want. */
  async function newProject() {
    const p = ui.proj();
    const n = p.shots.length;
    const oldName = p.name || "";
    /* 不弹确认（点「新建工程」就新建）。20261026 撤销栈删除后，旧工程**带不回来** ——
       想留后路请先「另存工程文件」。 */
    /* 拿一个**不冲突**的默认片名 —— 段要登记进档案才上轴，重名会把新片写进
       旧片档案（20261107「新建后画面还是上一个工程的词」就是这么来的）。
       名字**只能由后端发号**：要不到就**不建工程**，绝不本地编名兜底。 */
    let name = "";
    /* 60s 才放弃：本地后端在渲染高峰会排队，6s 会把正常请求判成失败；
       但也不能无限等，否则「新建工程」点了永远没反馈。超时同样按失败停。 */
    try {
      const _uc = new AbortController();
      const _ut = setTimeout(() => _uc.abort(), 60000);
      try {
        const res = await api.fetchApi("/cglide/chain/unique_name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base: "未命名工程" }),
          signal: _uc.signal,
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.name) name = String(d.name);
      } finally {
        clearTimeout(_ut);
      }
    } catch (_) { /* 失败即停，下面统一报错 */ }
    if (!name) {
      ui.lanesFlash("没能向后台要到工程名（后台可能正在渲染）。工程没有创建，请稍后重试。");
      return;
    }
    /* 全新工程：**代际 gen +1** —— 文案台 / 媒体架轮询到新代际会把各自的
       提示词 / 素材彻底清空（用户报的「新建后联动节点还是旧内容」）。
       重置后立刻补一个空白第一段，时间轴永远保底一段（用户定的逻辑）。 */
    const gen = (p.gen || 0) + 1;
    ui.node.properties.gcast_project = { name, shots: [], idx: -1, gen };
    /* 面板所有参数归位到空白默认（档位 / 锚点 / 钉帧 / 时长 / 画布 / 参考） */
    ui.st = blankState();
    ui.commit();
    ui.render();
    paintSegTools();
    /* 时间轴归零、清掉旧片缓存（含音频轴）；第一段登记完 registerShot 会
       自己 refresh，这里不重复 refresh。 */
    try { if (ui.monitor) ui.monitor.reset(); } catch { /* 已销毁 */ }
    /* 新代际即时广播：媒体架 / 文案台立刻清空，不再等 1~3 秒轮询（20261012）。 */
    try { emitCastChange({ name, gen, clip: "", reason: "project" }); } catch (_) {}
    /* 自动建一个空白第一段：不继承班底 / 素材 / 提示词 */
    ui.restoreDefaultShot(true);
    ui.lanesFlash(n
      ? `已新建「${name}」—— 旧工程「${oldName || "当前工程"}」的 ${n} 段已关闭（不可恢复）`
      : `已新建「${name}」`);
  }

  /** 拖进来的视频 → 按它当时的现场开一个独立新工程。
      不改 gen：gen+1 会广播「新建工程」把文案台 / 媒体架清空，那正是要保留的东西。

      20261107 用户定：**把旧片的整份档案复制到新片名下**。
      视频的元数据里只有 prompt + workflow，段 id / 成片 / 续拍存档都在
      output/h3_chain/<片名>/ 里，一样都带不走 —— 所以拖进来的工程轴上是空的。
      现在改成：先让后端把源片的档案目录整个复制到新片名下（/cglide/chain/copy），
      再按复制过来的档案重建工程对象。于是时间轴上是原片的全部段，
      点开能播、能续、能重抽，旧工程一个字节都没动。
      源片没有档案（别的机器 / 已删）时退回老行为：只登记第 1 段，轴不空着。 */
  async function restoreVideoAsNewProject(fileName) {
    const p = ui.proj();
    const oldName = (p && p.name) || "未命名工程";
    /* 唯一名必须由后端给：本地撞名会把新片写进旧片档案。
       要不到名 → **不还原、不写任何档案**（与「新建工程」同一口径，不再本地编名）。 */
    let name = "";
    try {
      const res = await api.fetchApi("/cglide/chain/unique_name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base: `${oldName} · 还原` }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d && d.name) name = String(d.name);
    } catch (_) { /* 失败即停，下面统一报错 */ }
    if (!name) {
      ui.lanesFlash("没能向后台要到工程名（后台可能正在渲染）。没有还原，也没有写任何档案，请稍后重试。");
      return;
    }

    /* 整份档案复制。大工程要几百 MB / 几秒，先给一行提示，别让人以为卡住了。 */
    ui.lanesFlash?.(`正在把「${oldName}」的整份档案复制到「${name}」…`);
    let copied = null;
    let copyHttp = null;      /* null = 没拿到响应（断网/超时），数字 = HTTP 状态 */
    try {
      const res = await api.fetchApi("/cglide/chain/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: oldName, to: name }),
      });
      copyHttp = res.status;
      copied = await res.json().catch(() => ({}));
    } catch (_) { copied = null; }        /* 断网 / 超时：按"没有档案"处理 */
    const okCopy = !!(copied && copied.copied === true);

    /* 目标名已有档案（正常不可能，唯一名是后端给的）：**一个段都不许登记**。
       往已有档案里写段是在改别人的工程，比"复制失败"严重得多。
       这一页也不能回灌 —— 否则它会被绑定到那个已有工程上，编辑就写进去了。 */
    if (copied && copied.code === "exists") {
      ui.node._bzVideoSnap = true;
      ui.commit();
      ui.lanesFlash(`没有复制：${copied.reason}。这一页不会写任何档案 —— 再拖一次即可`);
      return;
    }

    for (const s of (p.shots || [])) {
      if (s) s.clip = "";           /* 复制成功时由档案回填；失败时保持空 */
    }
    p.name = name;
    /* 内存属性：不进 properties，保存这个标签页也不会把还原态带进工作流。
       只在**没复制到档案**时置位 —— 那时新片名下什么都没有，一次回灌就会把
       视频里带过来的文案 / 素材当空架子清掉。复制成功则相反：库里就是刚
       复制来的整份档案，让正常的回灌通道（自愈巡检）照常兜底。 */
    ui.node._bzVideoSnap = !okCopy;
    ui.commit();
    ui.render();
    try { ui.monitor?.refresh?.()?.catch?.(() => {}); } catch (_) {}

    if (okCopy) {
      /* 以复制来的档案为权威重建工程对象（内部不 stash —— stash 会把内存里
         的 state / 素材写回**源片**档案，而这一步的承诺是旧工程不动）。 */
      let adopted = false;
      try { adopted = (await ui.adoptCopiedProject?.(name)) === true; } catch (_) {}
      if (adopted) {
        ui.lanesFlash(`已把原片「${oldName}」的整份档案复制到「${name}」`
          + `（${copied.sizeMB != null ? copied.sizeMB + " MB · " : ""}全部段 / 参数 / 文案台 / 媒体架 / 成片），`
          + `旧工程未改动`);
        return;
      }
      /* 复制成功但整包拉不回来（接口超时）：轴上的段由 archive 轮询照常画出，
         段 id 交给 boot 后的回灌按 uid 补齐，这里不再动工程对象。 */
      ui.lanesFlash(copied.segments === 0
        ? `「${oldName}」的档案里还没有段（渲染后删光了）—— 已复制空档案到「${name}」，可以接着开拍`
        : `原片档案已复制到「${name}」，但工程对象没重建成功 —— 刷新一次页面（Ctrl+F5）即可恢复全部段`);
      return;
    }

    /* 走到这里 = 没有可复制的档案：退回「至少一段」，时间轴不空着。 */
    let why;
    if (copyHttp === 404) {
      /* 改过 .py 却没完全重启时最常撞到的就是这个 —— 说清楚，省一轮排查。 */
      why = "后端还没有 /cglide/chain/copy 接口（改过 .py 必须完全重启 ComfyUI，Ctrl+F5 不算）";
    } else if (copyHttp == null) {
      why = "没连上后端（请求失败或超时）";
    } else if (copied && copied.code === "no_src") {
      why = `本机没有「${oldName}」的档案（视频可能来自别的机器）`;
    } else {
      const r = copied && (copied.reason || copied.error);
      why = "档案复制失败" + (r ? "：" + r : "");
    }
    ui.lanesFlash(`已按视频「${fileName}」当时的现场新建工程「${name}」`
      + `—— ${why}，只登记了第 1 段；旧工程「${oldName}」未改动`);
    try {
      const first = (p.shots || [])[0];
      if (first) {
        await ui.registerShot(first);
        ui.commit();
        ui.paintSegTools();
        ui.broadcastSeg?.("seg");
      } else if (ui.ensureFirstShot) {
        await ui.ensureFirstShot();
      }
    } catch (_) { /* 登记失败：段仍在内存，下次 boot 由 ensureFirstShot 兜底 */ }
  }

  /** 轴头可用状态 + 段头计数 + 总览轴计数，一次刷完。
     它是面板里唯一被到处调用的重绘入口：任何一次改动（换段、跳过、断链、
     保存、渲染开始/结束）都要走它。
     20261010 撤掉「🗑 删除 / ⇥ 接上一段」，20261106 又撤掉轴头「＋ 接一段」；
     段级操作先搬到段块悬浮工具条，20261106 再统一搬到「当前段上下文条」
     （见 csglide_cast_settings.js 的 paintSegActBar），所以这里不再刷轴头按钮。
     零段工程的加段入口是成片监视器空态引导卡的「＋ 接第一段」，不在轴上。 */
  function paintSegTools() {
    /* 20261026：撤销 / 重做按钮已整体删除，paintUndoBtns 不存在了。 */
    /* 一键取消接续（20261015）：按钮是"全片还有没有段在接续"，段增删、断链、
       refresh 之后都要跟着重算 —— 挂在通用重绘入口里最省事，不用到处补调。 */
    try { ui.paintUnlinkAllBtn && ui.paintUnlinkAllBtn(); } catch (_) { /* 还没装好 */ }
    /* 上下文条那排段级按钮（20261106）：换段 / 跳过 / 增删段 / 渲染开始结束
       都走这个通用重绘入口，跟着一起刷，按钮不会停在上一段的 ○/◉ 或禁用态。 */
    try { ui.paintSegActBar && ui.paintSegActBar(); } catch (_) { /* 还没装好 */ }
    ui.paintRenderRow();
    ui.paintRunScope();
    ui.paintLinkMarks();
    ui.updateSegChip();
    ui.updateLanesMeta();
    ui.paintProjName?.();
    ui.paintSaveDot?.();
    /* 「跳过」的标记画在时间轴的段块上，真值却在工程里（p.shots[].off）——
       film_summary 不带这个字段，所以每次通用重绘都把集合推一次给时间轴。
       集合没变时 film 内部直接返回，不会引起重画。 */
    try {
      const shots = ui.proj().shots || [];
      ui.monitor?.setSkipIds?.(shots.filter((sh) => sh.off && sh.clip).map((sh) => sh.clip));
    } catch (_) { /* 时间轴还没装好 */ }
  }


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { syncCheck, askSync, applySyncChoice, toggleSkip, toggleLink, newProject, restoreVideoAsNewProject, paintSegTools });
}
