import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el } from "./csglide_ui_kit.js";
import { projectStore } from "./bz_project_store.js";

/* ============================================================
 * 导出成片（整轴拼接）
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installReview(ui) {
  async function runDelivery(action) {
    if (ui._bzDeliveryPreparing || ui.run || ui._bzRunPreparing || ui.node.bzStageBusy?.()) {
      ui.lanesFlash("已有运行或整片处理尚未结束，请完成后再推送或导出");
      return;
    }
    ui._bzDeliveryPreparing = true;
    try { ui.paintRenderRow?.(); return await action(); }
    finally { ui._bzDeliveryPreparing = false; ui.paintRenderRow?.(); }
  }
  /* （重抽后的「采纳 / 丢弃 / 再抽一次」对比框已删，20261010 用户定：重抽的
     结果一律直接采纳，不弹窗。旧版本仍然留在磁盘上 —— 要回去用段块右键里的
     版本清单切（csglide_cast_takes.js 的 switchTake），那条路没动。） */

  /* 「工程 ▾」菜单与它整套工程文件功能已删（20261102 用户定）：打开工程 / 导入分段 /
     保存工程文件 / 工程另存 / 工程打包 五项，连同轴头那颗按钮、这里的菜单板与定位
     函数一起下线。工程本来就随工作流存在节点里，这些文件级动作没人用。
     换工程走「切换工程」（bz_project_sync.js）。 */
  /* 20261026：撤销 / 重做 / 还原点历史菜单 —— **全部删除**（用户定）。
     轴头按钮、Ctrl+Alt+Z 快捷键、本菜单顶部两项、还原点栈一起下线；
     工程生命周期各操作不再存还原点，替换类操作从此不可逆。
     原因与代价见 csglide_cast_shots.js 顶部说明。 */

  /* ---- 导出成片（整轴拼接，20261010；20261011 增续渲串联）------------
     导出读的是磁盘上**已经生成好**的各段成片，把它们按净长拼成一条完整视频
     写进档案目录，不是重新渲染一遍。点下去前先把两件事摆出来：
       1. 片子到哪儿为止 —— 后面的段没生成，成片就到不了那里；
       2. 改动进没进片子 —— 段上挂着待办，成片还是改之前那一版。
     用户三选一：先不导出 / 仍要这一版 / 先续渲再导出（自动从未就绪段开始
     续写渲染，跑完自动导出）。 */

  async function chainJSON(url) {
    const res = await api.fetchApi(url);
    if (res.status === 404) {
      /* 404 = 后端没有这个接口。八成是刚更新过插件、只刷新了页面：
         前端 JS 刷新浏览器就生效，后端 Python 必须重启 ComfyUI 才会注册上新路由。 */
      throw new Error("后端没有这个接口（404）—— 如果刚更新过插件，重启一次 ComfyUI "
        + "再试（刷新页面只更新前端，后端要重启才生效）");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const planURL = (name) =>
    "/cglide/chain/export_film_plan?name=" + encodeURIComponent(name);

  /** 把导出计划翻成几行人话。一行一个事实，不写「可能」「建议」这种软话。 */
  function exportNotes(plan) {
    const out = [];
    const miss = (plan.beyond || []).filter((r) => !r.playable);
    if (miss.length) {
      out.push(`后面还有 ${miss.length} 段没生成（`
        + miss.map((r) => `第 ${r.index} 段`).join("、")
        + `）—— 成片只到第 ${plan.at_index} 段为止，这些不在片子里。`);
    }
    const pend = plan.pending || [];
    if (pend.length) {
      out.push(`有 ${pend.length} 段改过但还没重跑：`
        + pend.map((r) => `第 ${r.index} 段 ${r.text || r.kind}`).join("；")
        + " —— 成片用的是改之前那一版。");
    }
    if ((plan.broken || []).length) {
      out.push(`有 ${plan.broken.length} 段的档案读不出来（被手动删了或写坏了）`
        + " —— 它们也不在这条片子里。");
    }
    /* 位置对不上的段：本段新画面在这条成片里应有的位置已经超出了片子实际
       长度 —— 说明这条片子不是「到这一段为止的整条」（接了外来源片 / 重抽后
       长度变了）。裁出来的一截位置不对，拼进去不是重播就是跳戏。 */
    const short = plan.short || [];
    if (short.length) {
      out.push(`有 ${short.length} 段的成片对不上时间轴上的位置（`
        + short.map((r) => `第 ${r.index} 段：成片只有 ${r.film_frames} 帧，`
            + `本段要取 ${r.want} 帧处`).join("；")
        + `）—— 这几段重跑一次再来导出。`);
    }
    /* 面板填了承接帧数、档案里却记成 0：导出按 0 剪头，承接头会连播两遍。 */
    const trims = plan.trim_notes || [];
    if (trims.length) {
      out.push(`有 ${trims.length} 段的承接帧数对不上（`
        + trims.map((r) => `第 ${r.index} 段：面板 ${r.panel} 帧、档案 ${r.archive} 帧`).join("；")
        + "）—— 成片接缝会重复播放一截，请重跑这几段再导出。");
    }
    /* 20261111 方案 B：轨静音只改驱动混音，旧 mp4 里那条音轨已经混进去了，
       导出抽不掉。这一行会进三选一对话框，「先续渲再导出」正好把它跑掉。 */
    if (plan.film_mute_warning) out.push(plan.film_mute_warning);
    return out;
  }

  /** 第一个未就绪段（0-based）：续渲的起点。 */
  function firstBadIndex(plan) {
    const idxs = [];
    (plan.missing || []).forEach((r) => idxs.push(r.index));
    (plan.beyond || []).filter((r) => !r.playable).forEach((r) => idxs.push(r.index));
    (plan.pending || []).forEach((r) => idxs.push(r.index));
    (plan.broken || []).forEach((r) => idxs.push(r.index));
    (plan.short || []).forEach((r) => idxs.push(r.index));
    (plan.mute_stale_clips || []).forEach((i) => idxs.push(i));
    if (!idxs.length) {
      /* 兜底：老后端（无 missing 字段）报 no_film 时，从第 1 段起。 */
      return plan.blocker === "no_film" ? 0 : -1;
    }
    return Math.min(...idxs) - 1;
  }

  /** 导出成片：读计划 → 有问题给三选一对话框（可续渲）→ 拼接写盘。 */
  async function saveFilmMerged(btn) {
    const name = ui.castName();
    if (!name) {
      ui.lanesFlash("还没有片名 —— 先在指挥条的工程名上填一个");
      return;
    }
    let plan;
    try {
      plan = await chainJSON(planURL(name));
    } catch (err) {
      ui.lanesFlash("读不到这部片子的档案：" + err.message);
      return;
    }
    /* 20261111 阶段 2：导出阶段可见但不打断。只走底部反馈条，不进 notes ——
       notes 非空就会弹三选一，本来没问题的导出会被硬塞一个对话框。 */
    if (plan.stage) {
      const stageCn = { s1: "一采", s2: "二采", s3: "三采" }[plan.stage] || "一采";
      ui.lanesFlash(`当前时间轴阶段「${stageCn}」`
        + `（${plan.stage}）· ` + (plan.film_stage_warning || ""));
    }
    let notes = plan.ok ? exportNotes(plan) : [];
    /* 阻断态（一部成片都没有 / 中间缺段）：转成一条清单，同样给三选一 ——
       「先续渲再导出」从第一个未就绪段跑起、跑完自动导出。其余 blocker
       （no_such_clip 等 URL 异常）直接提示。 */
    if (!plan.ok) {
      if (plan.blocker === "no_film" || plan.blocker === "missing_clips") {
        notes = [plan.message || "还没有可导出的成片"];
      } else {
        ui.lanesFlash(plan.message || "还没有可导出的成片");
        return;
      }
    }
    if (notes.length) {
      const choice = await askExport(plan, notes, "导出");
      if (choice === "cancel") return;
      if (choice === "export") {
        if (!plan.ok) {
          ui.lanesFlash("这一版还没有任何成片可导出 —— 请选「先续渲再导出」");
          return;
        }
      }
      if (choice === "render") {
        const from = firstBadIndex(plan);
        const fromIdx = from >= 0 ? from : 0;
        ui.lanesFlash(`先续渲再导出 —— 从第 ${fromIdx + 1} 段开始，跑完自动导出`);
        if (ui.proj().idx !== fromIdx) ui.switchTo(fromIdx);
        await ui.renderAll("continue", "from");
        await ui.monitor.refresh().catch(() => {});
        /* 重读计划：全部就绪才静默导出；仍有未完成段（中断 / 失败）就停下，
           不再弹一次窗。 */
        let plan2;
        try { plan2 = await chainJSON(planURL(name)); }
        catch (err) { ui.lanesFlash("续渲后读不到档案：" + err.message); return; }
        if (!plan2.ok) { ui.lanesFlash(plan2.message || "还没有可导出的成片"); return; }
        const notes2 = exportNotes(plan2);
        if (notes2.length) {
          ui.lanesFlash("续渲未全部完成 —— 处理后再点「导出成片」");
          return;
        }
        plan = plan2;
      }
    }
    await doExport(btn, plan, name);
  }

  /** 计划已就绪后的实际导出：弹另存为 → 后端拼接 → 写盘 / 下载。
      档案目录同时留一份副本（output/h3_chain/<片名>/<片名>_成片.mp4）。 */
  async function doExport(btn, plan, name) {
    return runDelivery(() => writeExport(btn, plan, name));
  }
  async function writeExport(btn, plan, name) {
    const defaultName = plan.file || (name + "_成片.mp4");
    /* 「另存为」必须等后端拼完再弹（20261123）：showSaveFilePicker 一确认就在
       目标目录**当场创建文件**（0 字节），真正写内容却要等拼接成功之后。
       先弹后拼的次序下，任何后端拒绝（缺帧 / 缺段 / 门禁 / 拼接失败）都只走
       catch 弹一句提示，那个空文件既不写也不删 —— 用户看到的就是「导出了一个
       空视频」（实测：桌面 未命名工程 2_成片.mp4 = 0 字节）。
       File System Access API 没有删除句柄的能力，失败时回滚不了，
       所以只能把创建动作推迟到产物确认之后，而不是在失败路径上补救。
       环境不支持（Firefox / 非 localhost）照旧降级为浏览器下载。 */
    const oldText = btn ? btn.textContent : "";
    if (btn) {
      btn.dataset.busy = "1";
      btn.disabled = true;
      btn.textContent = "拼片中…";
    }
    let merged = null;      // 拼接结果；非空 = 档案副本已生成
    try {
      if (ui.castName() !== name || (plan.stage && ui.stage && plan.stage !== ui.stage)) {
        throw new Error("工程或阶段已变化，请重新确认导出范围");
      }
      const startRes = await api.fetchApi("/cglide/chain/export_film_job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, at: plan.at || null,
          no_audio: (() => { try {
            const b = document.querySelector(".bzf-wave-mute");
            return !!b && b.dataset.off === "1";
          } catch (_) { return false; } })() }),
      });
      if (startRes.status === 404) {
        throw new Error("后端还没有拼接接口 —— 重启一次 ComfyUI 再来"
          + "（刷新页面只更新前端，后端要重启才生效）");
      }
      const start = await startRes.json().catch(() => ({}));
      if (!startRes.ok || start.error) throw new Error(start.error || `HTTP ${startRes.status}`);
      if (!start.ok || !start.job) throw new Error(start.message || "导出任务没能启动");

      /* 长片重编码要几分钟：请求秒回，靠状态轮询等结果，避免 fetch 超时。
         同一个片子并发触发时后端回同一个 job，只拼一遍。 */
      let data = null;
      for (let tick = 0; tick < 600; tick += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        const stRes = await api.fetchApi("/cglide/chain/export_film_status?job="
          + encodeURIComponent(start.job));
        const st = await stRes.json().catch(() => ({}));
        if (!stRes.ok || st.state === "lost") {
          throw new Error(st.message || "导出任务已丢失，请重新导出");
        }
        if (st.state === "done") { data = st.result || {}; break; }
        if (btn) btn.textContent = `拼片中…（${tick + 1} 秒）`;
      }
      if (!data) throw new Error("导出超过 10 分钟仍未完成，请查看终端日志");
      if (data.ok === false) throw new Error(data.message || "拼接失败");
      merged = data;
      const secs = (data.seconds || 0).toFixed(1);

      /* 到这里后端已经拼完、档案副本已确认存在，才轮到用户选位置。
         顺序反过来就会在失败时留下 0 字节的空片子，见函数开头。 */
      let handle = null;
      if (window.showSaveFilePicker) {
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [{ description: "MP4 视频", accept: { "video/mp4": [".mp4"] } }],
          });
        } catch (err) {
          if (err && err.name === "AbortError") {
            /* 取消另存 ≠ 导出失败：档案副本已经拼好了，说清在哪儿，
               别让下面的 catch 把「取消」报成「失败」。 */
            ui.lanesFlash("已取消另存 —— 成片已在档案里：" + merged.path);
            return;
          }
          handle = null;                   // 其它失败 → 降级浏览器下载
        }
      }
      let where;
      if (handle) {
        const fileRes = await api.fetchApi("/cglide/chain/export_film_file?name="
          + encodeURIComponent(name));
        if (fileRes.status === 404) {
          throw new Error("后端还没有读回接口 —— 重启一次 ComfyUI 再试");
        }
        if (!fileRes.ok) throw new Error("读回成片失败（HTTP " + fileRes.status + "）");
        const w = await handle.createWritable();
        try {
          await fileRes.body.pipeTo(w);      // 流式写盘：不整块占内存
        } catch (e) {
          try { await w.abort(); } catch (_) {}   // 写一半失败：解锁文件别占着
          throw e;
        }
        where = handle.name || defaultName;
      } else {
        /* 降级：触发浏览器下载，存哪由浏览器说了算。 */
        const a = el("a");
        a.href = api.apiURL("/cglide/chain/export_film_file?name="
          + encodeURIComponent(name));
        a.download = defaultName;
        document.body.append(a);
        a.click();
        a.remove();
        where = "浏览器下载（" + defaultName + "）";
      }
      ui.lanesFlash(`成片已导出：${where}`
        + `（${data.frames} 帧 · ${secs} 秒 · ${data.clips} 段`
        + (data.audio === false ? " · 无音轨" : "")
        + `；档案副本：${data.path}）`);
    } catch (err) {
      ui.lanesFlash("导出成片失败：" + err.message
        + (merged ? "（拼接本身已完成，档案副本在：" + merged.path + "）" : ""));
    } finally {
      if (btn) {
        btn.dataset.busy = "";
        btn.textContent = oldText || "⬇ 导出成片";
        ui.paintSegTools();
      }
    }
  }

  /** 导出前的对话框。用真正的对话框而不是 confirm：清单有好几行，
      confirm 会把换行压成一个方块，用户根本读不完就点了确定。
      返回三选一：'cancel' / 'export'（仍要这一版）/ 'render'（先续渲）。 */
  function askExport(plan, notes, verb) {
    verb = verb || "导出";
    return new Promise((resolve) => {
      const wrap = el("div", "gcast-modal");
      const sheet = el("div", "gcast-sheet");
      const secs = (plan.seconds || 0).toFixed(1);
      const ready = !!(plan.ok && plan.at_index);
      /* 20261111 阶段 2：标题上点名当前阶段。只改文案，不动 notes ——
         notes 决定要不要弹这个三选一，把阶段塞进去等于凭空多一次打断。 */
      const stageTag = plan.stage
        ? ` · ${{ s1: "一采", s2: "二采", s3: "三采" }[plan.stage] || "一采"}(${plan.stage})`
        : "";
      sheet.append(el("h3", null, (ready
        ? `${verb}到第 ${plan.at_index} 段为止`
          + (plan.total_clips > plan.at_index ? `（共 ${plan.total_clips} 段）` : "")
        : `还没有可${verb}的成片（共 ${plan.total_clips || 0} 段）`) + stageTag));
      const body = el("div", "body");
      if (ready) {
        body.append(el("div", "hint",
          `这一版是第 1–${plan.at_index} 段合起来的：`
          + `${plan.frames} 帧 · ${secs} 秒。`));
      }
      notes.forEach((t) => body.append(el("div", "gcast-export-note", t)));
      const foot = el("div", "foot");
      const cancel = el("button", "gcast-btn ghost", "先不导出");
      const go = el("button", "gcast-btn ghost", `仍要${verb}这一版`);
      if (!ready) go.style.display = "none";   // 无成片可导出，不给这个选项
      const renderFirst = el("button", "gcast-btn", "先续渲再导出");
      renderFirst.title = "关闭本窗，自动从第一个未生成 / 待重跑段开始续写渲染，"
        + "跑完后自动导出成片";
      foot.append(cancel, go, renderFirst);
      sheet.append(body, foot);
      wrap.append(sheet);
      const done = (v) => { wrap.remove(); resolve(v); };
      cancel.onclick = () => done("cancel");
      go.onclick = () => done("export");
      renderFirst.onclick = () => done("render");
      wrap.addEventListener("pointerdown", (ev) => {
        if (ev.target === wrap) done("cancel");
      });
      document.body.append(wrap);
      renderFirst.focus();
    });
  }

  /* 导出按钮"未就绪"小黄点徽标机制已于 20261012 应要求移除：未就绪清单在
     点击「导出成片」弹出的确认窗里照常逐条列出（askExport），不影响导出
     与"先续渲再导出"流程，只是按钮上不再常驻数字角标。 */

  /* ---- 推送整片到下游（不重跑，20261013）-----------------------------
     「整片」口连到下游（视频合并 / 超分 → 视频合并）后，点按钮把**磁盘上已
     存好的整片文件**直接喂给下游，**导演台 / 媒体架 / 文案台 / CLIP / VAE 一个
     都不跑**（连 VAE、文本编码器都不加载）。步骤：
       1. 调 /cglide/chain/preview_film?ensure=1 让后端把**时间轴所有段按净长**
          拼成完整片（_preview.mp4，与监视器连播/保存成片同一条；段没变复用
          缓存，只流复制不重渲染），这一步不依赖导演台执行；
       2. graphToPrompt 出全图，往里面注入一个临时 BanzhangVisualLoader
          （视频口 index 3）直接加载这个完整片文件；
       3. 从整片口「正向」追踪整条链（超分 → 视频合并 OUTPUT_NODE），不含导演台；
       4. 链上引到「导演台整片口」的改接加载器，引到链外的（含 KSampler、
          CLIP/VAE 等）全部删除，只留整片链 + widget 标量；
       5. 反向收上游闭包（加载器无上游）、校验含 OUTPUT_NODE（否则 400
          "Prompt has no outputs"），queuePrompt 提交 { output: sub, workflow }。
     最终子图只有：加载器 + 超分(可选) + 视频合并。 */

  /* 判断 graphToPrompt 输出里某个值是不是连线引用（[源节点id, 输出口序号]）。 */
  const isRef = (v, out) =>
    Array.isArray(v) && v.length === 2 && !!out[v[0]];

  async function pushFilm(btn) {
    const castNode = ui.node;
    const outputs = castNode.outputs || [];
    const slotIdx = outputs.findIndex((o) => {
      const nm = (o.name || "").toLowerCase().replace(/[\s_]+/g, "");
      return nm === "整片" || nm === "wholefilm";
    });
    if (slotIdx < 0) {
      ui.lanesFlash("节点上没有「整片」口 —— 重启 ComfyUI 让后端节点定义刷新后再试");
      return;
    }
    /* 找连在整片口上的下游节点（去重）。 */
    const targets = [];
    for (const linkId of (outputs[slotIdx].links || [])) {
      const link = castNode.graph.links[linkId];
      if (link && link.target_id != null && !targets.includes(String(link.target_id))) {
        targets.push(String(link.target_id));
      }
    }
    /* 20261118 自动推送：整片口没手接时不再报错要求手连 —— 注入一个**专用**
       视频合并节点直接吃整片加载器（视频+音频），子图＝加载器+该合并，绝不复用
       画布上的阶段合并节点（复用会把整片写进阶段出片、还把选路器/解码整条渲染链
       拖进子图 → 类型不匹配 / 选路器空路报错，20261118 用户真机日志）。
       画布接线不变，只动本次提交副本。 */
    const autoVideo = targets.length === 0;
    const oldText = btn ? btn.textContent : "";
    if (btn) { btn.dataset.busy = "1"; btn.disabled = true; btn.textContent = "推送中…"; }
    /* 子图直接读整片文件，不需要改导演台面板的 push_whole 开关。 */
    try {
      /* 整片 = 时间轴上**所有段按净长拼成的完整片**（档案目录下的 _preview.mp4，
         与监视器连播 / 「保存成片」是同一条片子），不是某一段自己的 clip
         （clip_000x.mp4 只是单段、约 10 秒）。让后端 preview_film 现拼 / 取缓存：
         ensure=1 时段内容或顺序变了就重拼（流复制 + 一次重编码，几秒），没变
         直接复用缓存。这一步只读盘拼接、不渲染、也不执行导演台。 */
      const chainName = (ui.st && ui.st.chain && ui.st.chain.name) || "";
      if (!chainName) {
        ui.lanesFlash("还没有工程名 —— 先在导演台里建 / 选一个工程再推送");
        return;
      }
      let whole = "";
      let wholeFrames = 0;
      try {
        const plan = await chainJSON(planURL(chainName));
        if (!plan.ok || (plan.beyond || []).length) {
          throw new Error(plan.message || "工程还有未生成的段，不能作为完整整片推送");
        }
        const pvUrl = "/cglide/chain/preview_film?name="
          + encodeURIComponent(chainName) + "&ensure=1";
        const pvRes = await api.fetchApi(pvUrl);
        if (!pvRes.ok) throw new Error("HTTP " + pvRes.status);
        const pv = await pvRes.json();
        if (!pv.ok || !pv.path) {
          throw new Error(pv.message || pv.blocker || "整片尚未拼好");
        }
        whole = pv.path;
        wholeFrames = parseInt(pv.frames, 10) || 0;
      } catch (e) {
        ui.lanesFlash("整片拼不出来（" + e.message + "）—— 先渲染 / 播放至少一段再推送");
        return;
      }
      const pm = whole.match(/^(.*)[\\/]([^\\/]+)$/);
      if (!pm) { ui.lanesFlash("整片路径无法解析：" + whole); return; }
      const folder = pm[1];
      const fileOnly = pm[2];

      const p = await app.graphToPrompt();
      const out = p.output || p;
      /* ---- 注入一个「媒体加载器」直接读整片文件，顶替导演台整片口 ----
         这样子图里压根没有导演台 / 媒体架 / 文案台 / CLIP / VAE，也就不会
         加载 VAE、文本编码器、处理参考图（那 14 秒的重活）。加载器只把磁盘
         上的整片包成 VIDEO（VideoFromFile），毫秒级。 */
      const LOADER_ID = "__bz_pushfilm_loader__";
      const LOADER_VIDEO_SLOT = 3;   // BanzhangVisualLoader: 图像0/遮罩1/文件名2/视频3/音频4
      out[LOADER_ID] = {
        class_type: "BanzhangVisualLoader",
        inputs: {
          "📂 文件夹路径": folder,
          "📄 指定文件": fileOnly,
          "🔃 排序方式": "时间:最新优先",
          "🔍 缩略图尺寸": 60,
          "📁 含子目录": false,
        },
      };
      /* ---- 收集「整片链」（正向，只从整片口出发，不碰导演台其他输出）----
         整片可能经超分等处理节点再到视频合并（OUTPUT_NODE），所以沿输出正向
         追踪到终点。绝不能从导演台的正面条件等口正向走（那会拉进 KSampler）。 */
      const gnodes = app.graph._nodes || [];
      const gbyid = {};
      for (const n of gnodes) gbyid[String(n.id)] = n;
      /* 自动模式：注入专用合并节点吃整片加载器。required 控件优先抄画布上现有
         合并节点的提交值（保证提示音等 combo 合法），没有就用安全默认；媒体口
         按类型接加载器（视频3/音频4），不接图像口避免 IMAGE/VIDEO 混淆。 */
      const PUSH_COMBINE_ID = "__bz_pushfilm_combine__";
      if (autoVideo) {
        let tpl = null;
        for (const nid of Object.keys(out)) {
          if ((out[nid] || {}).class_type === "banzhangVideoCombine") { tpl = out[nid].inputs; break; }
        }
        const base = Object.assign({}, tpl || {});
        for (const k of Object.keys(base)) {
          if (isRef(base[k], out)) delete base[k];   // 剥掉所有媒体/上游引用
        }
        base["⏱️ 帧率"] = base["⏱️ 帧率"] || 24;
        base["📼 视频格式"] = base["📼 视频格式"] || "MP4 (H264/通用)";
        base["🏷️ 文件前缀"] = "整片推送";
        base["💾 保存元数据"] = true;
        base["🔔 提示音文件"] = base["🔔 提示音文件"] || "🔇 不播放提示音";
        base["🧹 出片后自动净化"] = false;
        base["🎬 视频文件"] = [LOADER_ID, LOADER_VIDEO_SLOT];
        base["🎵 音频"] = [LOADER_ID, 4];
        out[PUSH_COMBINE_ID] = { class_type: "banzhangVideoCombine", inputs: base };
        targets.push(PUSH_COMBINE_ID);
        console.log("[推送整片] 整片口未手接，注入专用合并节点吃整片加载器（不复用阶段合并）");
      }
      /* 整片链：只从整片口直接下游开始，**不包含导演台**（它由加载器顶替）。 */
      const forward = new Set();
      const fq = [...targets];
      while (fq.length) {
        const nid = String(fq.shift());
        if (forward.has(nid)) continue;
        forward.add(nid);
        const n = gbyid[nid];
        if (!n) continue;
        for (const o of (n.outputs || [])) {
          for (const lid of (o.links || [])) {
            const l = castNode.graph.links[lid];
            if (l && l.target_id != null) fq.push(String(l.target_id));
          }
        }
      }
      /* 改链上节点的输入：
         · 引到「导演台整片口」的 → 改接到注入的加载器视频口（整片文件）；
         · 引到导演台其他口（正面条件等）的 → 删除（避免拉进 KSampler / CLIP /
           VAE 等重链，那是要省的重活）；
         · 链内引用、以及链外的轻量上游（如 RelayVSR 加载器的「模型」）→ 保留，
           由下方反向闭包把来源节点收进子图（必填输入剥不得，否则缺模型 400）。 */
      for (const nid of forward) {
        const e = out[nid];
        if (!e || !e.inputs) continue;
        for (const k of Object.keys(e.inputs)) {
          const v = e.inputs[k];
          if (!isRef(v, out)) continue;
          const src = String(v[0]);
          const slot = Number(v[1]);
          if (src === String(castNode.id) && slot === Number(slotIdx)) {
            e.inputs[k] = [LOADER_ID, LOADER_VIDEO_SLOT];
          } else if (forward.has(src)) {
            /* 链内引用，保留 */
          } else if (src === String(castNode.id)) {
            /* 导演台其他口（正面条件等）：剥掉，避免把 KSampler/CLIP/VAE 重链
               拉进子图——那正是推送整片要省的重活，整片口已由加载器顶替。 */
            console.log("[推送整片] 剥离 %s 的导演台输入 %s（重链，由加载器顶替）", nid, k);
            delete e.inputs[k];
          } else {
            /* 链外的轻量上游（如 RelayVSR 加载器的「模型」）：保留，交给下方
               反向闭包把来源节点收进子图。先剥后收会把必填输入误剥——流式超分
               缺模型 → 400（20261116 用户报）。隔壁推送整片潜空间本就是先收闭包
               再剪，这里对齐它：只有导演台重链该剥，处理链必需的上游不该剥。 */
          }
        }
      }
      /* 20261118 选路器自动切路（用户提议「控制互斥选路器自动推送」的视频版）：
         整片口接在选路器某一路时，本次提交把 selected 切到「加载器（整片）」那一路、
         其余路剪掉。否则 selected 仍指旧路（如二采合并），而旧路上游被静音/剥除后
         选路器空路 → 「第 1 路没有连线」（20261118 用户真机日志 wf28 #674/#675）。
         只动提交副本，画布 selected 不变。 */
      for (const nid of forward) {
        const e = out[nid];
        if (!e || e.class_type !== "BanZhang_RouteSwitch") continue;
        const keys = Object.keys(e.inputs || {}).filter((k) => /^input_\d+$/.test(k));
        const keepKey = keys.find((k) =>
          isRef(e.inputs[k], out) && String(e.inputs[k][0]) === LOADER_ID);
        if (!keepKey) continue;
        for (const k of keys) {
          if (k !== keepKey && isRef(e.inputs[k], out)) delete e.inputs[k];
        }
        const want = Math.max(1, Number(keepKey.slice(6)) || 1);
        if ("selected" in e.inputs) e.inputs.selected = want;
        if ("count" in e.inputs && !(Number(e.inputs.count) >= want)) e.inputs.count = want;
        console.log("[推送整片] 选路器 #" + nid + " 本次切到第 " + want + " 路（整片加载器），其余路已剪");
      }
      /* 反向收集上游闭包：加载器（无上游）+ 整片链保留的输入。 */
      const keep = new Set([LOADER_ID]);
      const queue = [...forward];
      while (queue.length) {
        const nid = String(queue.shift());
        if (keep.has(nid)) continue;
        keep.add(nid);
        const e = out[nid];
        if (!e) continue;
        for (const k of Object.keys(e.inputs || {})) {
          const v = e.inputs[k];
          if (isRef(v, out)) queue.push(String(v[0]));
        }
      }
      /* 子图必须有 OUTPUT_NODE，否则后端报 "Prompt has no outputs"。整片只
         连到超分（非 OUTPUT_NODE）且超分输出悬空时，正是这个坑。加载器本身
         不是 OUTPUT_NODE，要排除它。 */
      const hasOutput = [...keep].some((nid) =>
        nid === PUSH_COMBINE_ID ||
        (nid !== LOADER_ID && gbyid[nid]?.constructor?.nodeData?.output_node === true));
      if (!hasOutput) {
        throw new Error("整片链路末端没有输出节点 —— 把超分的「视频」输出连到视频合并，"
          + "或直接把整片连到视频合并节点");
      }
      /* 裁出子图。 */
      const sub = {};
      for (const nid of keep) if (out[nid]) sub[nid] = out[nid];
      console.log("[推送整片] 整片文件：" + whole
        + (wholeFrames ? "（" + wholeFrames + " 帧完整片）" : ""));
      console.log("[推送整片] 整片链=" + [...forward].join("/"));
      console.log("[推送整片] 子图节点：" + Object.keys(sub).join("/")
        + "（不含导演台/媒体架/文案台/CLIP/VAE，不重跑）");
      /* queuePrompt 第二个参数必须是 { output, workflow }：它内部解构 output
         当 prompt、workflow 塞进 extra_pnginfo。workflow 沿用原图（子图不含
         连线信息，只影响保存元数据，不影响执行）。 */
      const submission = { output: sub, workflow: p.workflow, bz_delivery: "whole_film" };
      if (ui.castName() !== chainName) throw new Error("工程已切换，请重新推送当前工程");
      projectStore.markDeliveryPrompt(submission);
      const res = await api.queuePrompt(0, submission);
      const id = res && (res.prompt_id || res.promptId);
      if (!id) throw new Error("服务端未返回任务 ID");
      ui.stageFlowQueued?.(String(id));
      const lenTxt = wholeFrames ? `${wholeFrames} 帧完整片 · ` : "";
      ui.lanesFlash(`已推送 ${lenTxt}到 ${targets.length} 个下游节点（不重跑渲染）· 任务 ${id}`);
    } catch (err) {
      ui.lanesFlash("推送整片失败：" + err.message);
    } finally {
      if (btn) {
        btn.dataset.busy = "";
        btn.textContent = oldText || "🎬 推送整片";
        if (ui.paintSegTools) ui.paintSegTools();
      }
    }
  }

  /* ---- 推送整片潜空间到下游（20261102）-------------------------------
     与「🎬 推送整片」同构的一次性动作，唯一区别是**数据从哪来**：

       · 「整片」口吐的是磁盘上的 mp4 —— 可以注入一个 BanzhangVisualLoader
         顶替导演台，于是导演台 / 媒体架 / CLIP / VAE 一个都不跑；
       · 「整片潜空间」口吐的是后端现拼的 latent —— **没有任何节点能把"一条
         整片 latent"从文件加载回来**，所以这一路必须让导演台真的执行一次
         （读全部段落档案 → 按净长裁头 → 拼成一条）。能省的只有采样：只从
         「整片潜空间」口正向追踪下游，导演台的正面条件 / 单段潜空间两个口
         不正向走，首采 KSampler 就不会被带进子图。

     追踪用**序列化后**的 input 引用，不用 graph.links：reroute / 转接节点
     在 graphToPrompt 里已被解析成真实源节点，按连线走会在 reroute 处断。
     判断「谁吃了某个口」就是找 `[导演台id, 口序号]` 引用；口序号一律
     outputs.findIndex(按名字) 现查，别抄旧注释里的数字（端口重排过一次，
     这里的「第 7 口 / `[导演台id, 6]`」就是重排前留下的过时说法）。 */
  async function pushFilmLatent(btn) {
    const castNode = ui.node;
    const outputs = castNode.outputs || [];
    /* 端口一律按**名字**找，绝不写死序号。20261106 后端把「模型」置顶后所有
       输出口整体 +1：旧代码把「一采潜空间」硬编码成 2，而 2 现在是
       「正面条件·二采三采」、真正的「潜空间」是 3。于是染脏染的是二采链、
       硬断言又把二采采样器（它本来就该吃口 2）当成「偷偷跑一采」报出来，
       推送 100% 失败（20261108 用户报）。ComfyUI 按序号存连线，节点定义一改
       序号就漂，名字才是唯一稳定契约。 */
    const normSlot = (o) =>
      (o.name || "").toLowerCase().replace(/[\s_]+/g, "");
    const slotIdx = outputs.findIndex((o) => normSlot(o) === "整片潜空间");
    const firstStageSlot = outputs.findIndex((o) => normSlot(o) === "潜空间");
    if (slotIdx < 0) {
      ui.lanesFlash("节点上没有「整片潜空间」口 —— 重启 ComfyUI 让后端节点定义刷新后再试");
      return;
    }
    if (firstStageSlot < 0 || firstStageSlot === slotIdx) {
      ui.lanesFlash("节点上找不到「潜空间」口（或它与「整片潜空间」重名）—— "
        + "重启 ComfyUI 让后端节点定义刷新后再试；为安全起见已中止，避免偷偷跑一采");
      return;
    }
    const chainName = (ui.st && ui.st.chain && ui.st.chain.name) || "";
    if (!chainName) {
      ui.lanesFlash("还没有工程名 —— 先在导演台里建 / 选一个工程再推送");
      return;
    }
    const oldText = btn ? btn.textContent : "";
    if (btn) { btn.dataset.busy = "1"; btn.disabled = true; btn.textContent = "拼潜空间中…"; }
    /* 20261102 第二次返工：**不再靠 ui.commit() 把开关写进面板状态**。
       实测它没能进到提交数据里（后端日志两次都说"开关关着"，而 0.89 秒跑完
       证明 upstream 全走了缓存 —— h3_data 与上一轮逐字节相同）。
       改成一刀到位：直接改**这次提交副本**里导演台的 h3_data JSON，改完回读
       核对。这样开关和面板状态彻底解耦 —— 面板里永远不会残留 true（也就不会
       让平时渲染白拼一条整片 latent），而这一笔提交必然带着 true。 */
    /* 20261111 用户定：互斥器恢复**纯手动切换**，推送整片潜空间不再自动选路。
       阶段 3 的自动选路块已整套删除。下面那段「只动本次提交副本、画布
       selected 不变」的选路器剪枝是既有的省钱逻辑，与联动无关，保留。 */
    try {
      const p = await app.graphToPrompt();
      const out = p.output || p;
      const castId = String(castNode.id);
      const de = out[castId];
      if (!de) {
        throw new Error("导演台不在提交图里 —— 它可能被旁路 / 静音（Mute）了");
      }
      if (!de.inputs || typeof de.inputs["h3_data"] !== "string") {
        throw new Error("拿不到导演台提交数据（h3_data）—— 这个节点可能不是导演台，"
          + "或前端版本不兼容");
      }
      let h3d = null;
      try { h3d = JSON.parse(de.inputs["h3_data"] || "{}"); } catch (e1) { h3d = null; }
      if (!h3d || typeof h3d !== "object") {
        throw new Error("导演台 h3_data 不是合法 JSON —— 先在面板上随便改一项再点推送");
      }
      h3d.push_film_latent = true;
      h3d.cont = { ...(h3d.cont || {}), frames: 0 };
      h3d.pin_head = 0; h3d.pin_tail = 0;
      de.inputs["h3_data"] = JSON.stringify(h3d);
      let back = null;
      try { back = JSON.parse(de.inputs["h3_data"]); } catch (e2) { back = null; }
      if (!back || back.push_film_latent !== true) {
        throw new Error("「整片潜空间」开关没能写进提交数据 —— 已中止，避免白跑一次渲染");
      }
      console.log("[推送整片潜空间] 提交数据里的开关已置真（回读核对通过）");
      /* 反向索引：源节点 id → 吃它的节点 id 列表。 */
      const consumers = {};
      for (const nid of Object.keys(out)) {
        const e = out[nid];
        for (const k of Object.keys((e && e.inputs) || {})) {
          const v = e.inputs[k];
          if (!isRef(v, out)) continue;
          const src = String(v[0]);
          (consumers[src] = consumers[src] || []).push(nid);
        }
      }
      /* 直接吃「整片潜空间」口的节点 —— 分两路查，结论完全不同：
         ① 提交图（out）里谁引用 [导演台, 本口]  → 真正会被执行的
         ② 画布上谁连了这个口（graph.links）   → 用户以为的
         两者对不上（②有①无）= 下游被旁路 / 静音，提交图里它压根不存在。
         以前只查 ①，于是"接了但被旁路" 被错误地报成"还没连出去"。 */
      const gbyid = {};
      for (const n of (app.graph._nodes || [])) gbyid[String(n.id)] = n;
      const graphDown = [];
      for (const lid of (outputs[slotIdx].links || [])) {
        const lk = castNode.graph && castNode.graph.links ? castNode.graph.links[lid] : null;
        if (lk && lk.target_id != null && !graphDown.includes(String(lk.target_id))) {
          graphDown.push(String(lk.target_id));
        }
      }
      const targets = [];
      for (const nid of (consumers[castId] || [])) {
        const ins = (out[nid] && out[nid].inputs) || {};
        const hit = Object.values(ins).some((v) =>
          isRef(v, out) && String(v[0]) === castId && Number(v[1]) === slotIdx);
        if (hit && !targets.includes(nid)) targets.push(nid);
      }
      /* 导演台每个口分别被谁吃 —— 出问题时这一行能直接看出是"口接错了"还是
         "下游没进图"。 */
      const slotUse = {};
      for (const nid of Object.keys(out)) {
        for (const v of Object.values((out[nid] && out[nid].inputs) || {})) {
          if (!isRef(v, out) || String(v[0]) !== castId) continue;
          const sl = Number(v[1]);
          (slotUse[sl] = slotUse[sl] || []).push(nid);
        }
      }
      /* 端口映射直接打出来：下次后端再重排，一眼就能看出前端该跟哪个序号，
         不用再去翻 RETURN_NAMES 对照「各口被吃」。 */
      console.log("[推送整片潜空间] 端口映射="
        + outputs.map((o, i) => i + ":" + (o.name || "?")).join(" "));
      console.log("[推送整片潜空间] 本口序号=" + slotIdx
        + "（整片潜空间）一采口序号=" + firstStageSlot + "（潜空间）"
        + " 画布连线→" + (graphDown.join("/") || "无")
        + " 提交图下游→" + (targets.join("/") || "无")
        + " 各口被吃=" + JSON.stringify(slotUse));
      /* 20261118 自动推送：画布没把「整片潜空间」连出去时不再要求手接 ——
         找提交图里的互斥选路器，把整片潜空间接进它空着的一路（只动本次提交
         副本，画布接线不变）。后面既有的选路器剪枝会自动切到这一路并剪掉其余路。 */
      if (!targets.length) {
        const routerId = Object.keys(out).find((nid) =>
          (out[nid] && out[nid].class_type) === "BanZhang_RouteSwitch");
        if (routerId) {
          const re = out[routerId];
          re.inputs = re.inputs || {};
          let freeKey = null;
          for (let i = 1; i <= 8; i++) {
            const k = "input_" + i;
            if (!isRef(re.inputs[k], out)) { freeKey = k; break; }
          }
          if (freeKey) {
            re.inputs[freeKey] = [castId, slotIdx];
            targets.push(routerId);
            console.log("[推送整片潜空间] 画布未连线，自动接入选路器 #" + routerId
              + " 的 " + freeKey + "（仅本次提交，画布不变）");
          }
        }
      }
      if (!targets.length) {
        const nm = graphDown.map((x) => (gbyid[x] ? (gbyid[x].type || x) : x)).join("、");
        ui.lanesFlash(graphDown.length
          ? `「整片潜空间」口接的是 ${nm}，但它这次没进提交图 —— 多半被旁路 / 静音了，`
            + "取消旁路（Ctrl+B）后再点一次"
          : "「整片潜空间」口还没连出去，且画布上没有互斥选路器可自动接入 —— "
            + "放一个「🔀 互斥选路器」或把「🧬 整片潜空间」连到下游二采 / 放大节点");
        return;
      }
      /* ---- 先把「一采分支」整片标脏，后面所有闭包都不许碰它 ----
         一采 = 吃导演台「潜空间」口（单段潜空间，非「整片潜空间」）算出来的
         那一整条，往下一直到互斥选路器 / 最终保存。上一次推送就是被互斥
         选路器把这条链整串拉进子图，白跑 32 秒一采、还把段落存档重渲覆盖成
         新 take。序号由开头按名字查出，绝不写死。 */
      const FIRST_STAGE_SLOT = firstStageSlot;
      /* 选路器单独处理（见下）：它会把它吃的那一路上游全部求值，所以既不能
         顺着它把一采染脏，也不能让"脏"穿过它往下传染二采。 */
      const SELECTOR_TYPES = ["BanZhang_RouteSwitch"];
      const isSelector = (nid) => {
        const nd = gbyid[nid];
        return !!nd && SELECTOR_TYPES.includes(nd.type);
      };
      const dropped = [];
      const tainted = new Set();
      {
        const tq = [];
        for (const nid of Object.keys(out)) {
          const ins = (out[nid] && out[nid].inputs) || {};
          /* 名字与下面剪枝用的 eatsFirst(v) 判据区分开：这里是「这颗节点是否
             是一采链的种子」，不是同名函数，免得读代码时混淆。 */
          const isFirstSeed = Object.values(ins).some((v) =>
            isRef(v, out) && String(v[0]) === castId && Number(v[1]) === FIRST_STAGE_SLOT);
          if (isFirstSeed) tq.push(nid);
        }
        while (tq.length) {
          const nid = String(tq.shift());
          if (tainted.has(nid)) continue;
          tainted.add(nid);
          for (const c of (consumers[nid] || [])) {
            if (tainted.has(c) || isSelector(c)) continue;   // 选路器不染，它下游是二采
            tq.push(c);
          }
        }
      }
      /* 正向闭包：只从潜空间口往下走，绝不从导演台的正面条件口走（那会拉进一采）。
         **这里不能跳过一采染色节点** —— 二采链路上常见"合并节点顺带接了一采的
         东西"，跳过它会把整条脊柱拦腰截断（上次提交里连二采采样器的下游都没了）。
         染色只用来禁止"往回走"，不用来禁止"往下走"。 */
      const forward = new Set();
      const fq = [...targets];
      while (fq.length) {
        const nid = String(fq.shift());
        if (forward.has(nid)) continue;
        forward.add(nid);
        for (const c of (consumers[nid] || [])) if (!forward.has(c)) fq.push(c);
      }
      if (!forward.size) {
        throw new Error("沿「整片潜空间」往下走一个能用的节点都没有 —— "
          + "把「🧬 整片潜空间」接到二采 / 放大节点的 latent 输入");
      }
      /* ---- 选路器：这一笔提交里切到「整片潜空间」那一路，其余路剪掉 ----
         ComfyUI 会把选路器**所有**连着的输入都求值，selected 只决定输出哪一个。
         所以"一采接路 1、整片潜空间接路 2、用选路器切"这个接法，每次都会把
         一采整整跑一遍 —— 选路器不是省钱开关。推送的正确语义是：让选路器这次
         只走整片潜空间，别的那几路（含一采）整条不入图。
         只动**这一笔提交的副本**，画布上的接线和 selected 都不变。 */
      for (const nid of [...forward]) {
        if (!isSelector(nid)) continue;
        const e = out[nid];
        if (!e || !e.inputs) continue;
        const keys = Object.keys(e.inputs).filter((k) => /^input_\d+$/.test(k));
        /* 优先取直接指着「整片潜空间」口的那一路；否则退而取"不依赖一采"的那一路。 */
        let keepKey = keys.find((k) => {
          const v = e.inputs[k];
          return isRef(v, out) && String(v[0]) === castId && Number(v[1]) === slotIdx;
        });
        if (!keepKey) {
          keepKey = keys.find((k) => {
            const v = e.inputs[k];
            return !isRef(v, out) || !tainted.has(String(v[0]));
          });
        }
        if (!keepKey) {
          throw new Error("选路器 #" + nid + " 上没有一路是「整片潜空间」来的 —— "
            + "把「🧬 整片潜空间」接到选路器的某一路再点推送");
        }
        const want = Math.max(1, Number(keepKey.slice(6)) || 1);
        for (const k of keys) {
          if (k === keepKey) continue;
          if (!isRef(e.inputs[k], out)) continue;
          delete e.inputs[k];
          dropped.push(nid + "." + k);
        }
        if ("selected" in e.inputs) e.inputs.selected = want;
        if ("count" in e.inputs && !(Number(e.inputs.count) >= want)) e.inputs.count = want;
        console.log("[推送整片潜空间] 选路器 #" + nid + " 本次切到第 " + want
          + " 路（" + keepKey + "），其余路已剪掉");
      }
      /* 反向闭包：脊柱（从整片潜空间往下走过的）**全收**，再往上补齐非一采的输入
         （导演台、二采正负条件、模型、VAE 会自己浮上来）。
         注意：脊柱上的节点就算"自己也吃着一点一采的东西"（很常见 —— 同一个合并
         节点两路都接），它仍然是二采链的一环，不能整颗丢；那一路输入由下面统一
         剪掉。上一版把这种节点当一采分支整颗剔除，结果把出片节点一起干掉了。 */
      const keep = new Set(forward);
      const bq = [...forward];
      while (bq.length) {
        const nid = String(bq.shift());
        const e = out[nid];
        if (!e) continue;
        for (const k of Object.keys(e.inputs || {})) {
          const v = e.inputs[k];
          if (!isRef(v, out)) continue;
          const src = String(v[0]);
          if (tainted.has(src) || keep.has(src)) continue;   // 只禁止"往回走进一采"
          keep.add(src);
          bq.push(src);
        }
      }
      /* 逐条剪掉两类输入：
         ① 指向「不在子图里」的上游 —— 留着会让服务端拿一个不存在的上游去解析；
         ② **直接指着导演台「潜空间」口的输入** —— 上面注释早写了「那一路输入
            由下面统一剪掉」，但旧实现只剪 ①，而这条的源 (castId) 恰好在 keep
            里，于是永远剪不掉：脊柱上顺带接了一采 latent 的合并节点会因此被
            硬断言整笔中止。现在按契约剪掉它，节点若缺必填项报错也直白。
         （dropped 在上面就声明了，选路器那一步也在往里记。） */
      const eatsFirst = (v) => isRef(v, out) && String(v[0]) === castId
        && Number(v[1]) === FIRST_STAGE_SLOT;
      for (const nid of keep) {
        const e = out[nid];
        if (!e || !e.inputs) continue;
        for (const k of Object.keys(e.inputs)) {
          const v = e.inputs[k];
          if (!isRef(v, out)) continue;
          const src = String(v[0]);
          if (keep.has(src) && !eatsFirst(v)) continue;
          delete e.inputs[k];
          dropped.push(nid + "." + k + (eatsFirst(v) ? "(一采口)" : ""));
        }
      }
      /* 硬断言：剪完之后不该还有一采引用；有就说明剪枝漏了，宁可报错也不许
         悄悄跑一采。带上节点与口名，别再留一句无头案。 */
      const stillFirst = [];
      for (const nid of keep) {
        const ins = (out[nid] && out[nid].inputs) || {};
        if (Object.values(ins).some(eatsFirst)) stillFirst.push(nid);
      }
      if (stillFirst.length) {
        throw new Error("子图里还有节点在吃「潜空间」口（#" + FIRST_STAGE_SLOT
          + "）：" + stillFirst.join("/") + " —— 剪枝没清干净，已中止（不允许偷偷跑一采）");
      }
      if (!keep.has(castId)) {
        throw new Error("下游没吃到导演台输出的 latent —— 支路里找不到「整片潜空间」的来源");
      }
      /* 子图必须有 OUTPUT_NODE，否则后端报 "Prompt has no outputs"。
         **必须只看脊柱（从潜空间口往下走过的节点）**：只看 keep 会被
         `BanZhang_VRAM_Guard` / `BanZhang_H3MemoryOptimizer` 这类"顺手往界面
         打一段字"的节点蒙混过关 —— 它们也是 OUTPUT_NODE，但跟出片毫无关系。
         上一版就因此放过了一个没有解码、没有合并的子图。 */
      const isOutNode = (nid) =>
        gbyid[nid]?.constructor?.nodeData?.output_node === true;
      const hasOutput = [...forward].some((nid) => isOutNode(nid));
      if (!hasOutput) {
        const seen = [...forward]
          .map((x) => (out[x] && out[x].class_type) || gbyid[x]?.type || x).join(" → ");
        throw new Error("二采这条链末端没有输出节点（走过：" + seen + "）—— "
          + "把二采采样器的输出接上 VAE 解码 → 视频合并 / 预览 / 保存；"
          + "若已经接了，检查那串节点是不是被旁路（Ctrl+B）了（内存守卫这类节点不算输出）");
      }
      /* 兜底：这条链路如果顺带把「整片」（mp4）口也吃了 —— 同一个视频合并节点
         两路都接是很常见的接法 —— 那一路在 push_whole 关着时会收到空串，合并
         直接报错，人会以为是"潜空间口坏了"。不改用户的面板状态，只改**这次
         提交的副本**：把序列化进去的 h3_data 里 push_whole 置真，导演台这一次
         顺手把整片也拼出来。代价是几秒磁盘拼接，比一次莫名失败便宜。 */
      const wholeSlotIdx = outputs.findIndex((o) => {
        const nm = (o.name || "").toLowerCase().replace(/[\s_]+/g, "");
        return nm === "整片" || nm === "wholefilm";
      });
      if (wholeSlotIdx >= 0) {
        const eatsWhole = [...keep].some((nid) => {
          const ins = (out[nid] && out[nid].inputs) || {};
          return Object.values(ins).some((v) =>
            isRef(v, out) && String(v[0]) === castId && Number(v[1]) === wholeSlotIdx);
        });
        const de = out[castId];
        if (eatsWhole && de && de.inputs && typeof de.inputs["h3_data"] === "string") {
          try {
            const d = JSON.parse(de.inputs["h3_data"] || "{}");
            if (!d.push_whole) {
              d.push_whole = true;
              de.inputs["h3_data"] = JSON.stringify(d);
              console.log("[推送整片潜空间] 下游顺带用了「整片」口 —— 这次提交里一并打开它");
            }
          } catch (e2) {
            console.warn("[推送整片潜空间] h3_data 解析失败，整片口没顺带打开", e2);
          }
        }
      }
      const sub = {};
      for (const nid of keep) if (out[nid]) sub[nid] = out[nid];
      console.log("[推送整片潜空间] 下游=" + targets.join("/")
        + " 一采分支 " + tainted.size + " 个已排除");
      console.log("[推送整片潜空间] 子图=" + Object.keys(sub)
        .map((nid) => nid + ":" + ((out[nid] && out[nid].class_type) || "?"))
        .join(" "));
      if (dropped.length) {
        console.log("[推送整片潜空间] 剪掉的跨分支输入：" + dropped.join("、"));
      }
      /* 只为这一份子图登记推送身份；同时发生的普通提交仍走正常编译。
         bz_delivery 是载荷级显式标记（B1）：中间层克隆/重建提交对象时
         WeakSet 凭据会丢，标记跟着载荷走，队列入口仍认得出这是交付。 */
      const submission = { output: sub, workflow: p.workflow, bz_delivery: "whole_film_latent" };
      if (ui.castName() !== chainName) throw new Error("工程已切换，请重新推送当前工程");
      projectStore.markDeliveryPrompt(submission);
      const res = await api.queuePrompt(0, submission);
      const id = res && (res.prompt_id || res.promptId);
      if (!id) throw new Error("服务端未返回任务 ID");
      ui.stageFlowQueued?.(String(id));
      const total = (ui.proj && ui.proj() ? ui.proj().shots.length : 0) || 0;
      ui.lanesFlash(`整片潜空间加工任务已入队（${total} 段），目标 ${targets.length} 个下游节点、`
        + `共 ${Object.keys(sub).length} 个节点（跳过了 ${tainted.size} 个一采节点）· 任务 ${id}`);
    } catch (err) {
      /* 面板反馈条可能在用户视野外，失败一律再往控制台打一份 —— "点了没反应"
         是最难查的现象，不能只靠一行会自动消失的提示。 */
      console.warn("[推送整片潜空间] 失败：", err);
      ui.lanesFlash("推送整片潜空间失败：" + err.message);
    } finally {
      if (btn) {
        btn.dataset.busy = "";
        btn.textContent = oldText || "🧬 推送整片潜空间";
        if (ui.paintSegTools) ui.paintSegTools();
      }
    }
  }

  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, {
    chainJSON, exportNotes,
    firstBadIndex, saveFilmMerged, doExport, askExport,
    pushFilm: (btn) => runDelivery(() => pushFilm(btn)),
    pushFilmLatent: (btn) => runDelivery(() => pushFilmLatent(btn)),
  });
}
