import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el } from "./csglide_ui_kit.js";
import { setCurrent } from "./bz_rack.js";
import { projectStore } from "./bz_project_store.js";
import { promptBuild, lineOf } from "./bz_prompt_build.js";
import { noteCompile } from "./bz_audit.js";
import { backendRun } from "./bz_backend_run.js";

/* ============================================================
 * 渲染全部
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installRun(ui) {
  /* ======================================================== Render all
   * Queue every clip in the project in order. In "continue" mode each render
   * is adopted into the next clip's CONTINUE FROM slot, so the graph's own
   * Glide Join stitches as it goes and the LAST render is the finished piece
   * -- there is no separate assembly pass to build.
   *
   * The loop drives the panel rather than the graph: it switches clips, fills
   * the slot, commits, queues, waits. Everything it does is something you
   * could do by hand, which is what makes it safe to interrupt.
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============================================================
   * 渲染进度跨刷新存活
   * ------------------------------------------------------------
   * ui.run 是纯内存：一刷新就没了，浮层跟着消失 —— 而**后端还在跑**当前这
   * 一段（ComfyUI 的执行在服务端，浏览器关掉也照跑）。于是刷新之后：面板看着
   * 是空闲的、后面几段再没人排队、用户也不知道刚才跑到哪了。
   *
   * 修法：进度写进 localStorage（页面刷新唯一活得下来的地方），节点重建时读
   * 回它 —— 有记录就重建 ui.run、把浮层画回来，并接上刷新前入队的那一段
   * （等它跑完 → 中央收片 → 继续排后面几段）。
   *
   * 同一时刻只允许一个"司机"真的在排队，其它页面是"观察者"（只读进度画浮层）。
   * 司机每 1s 打一次心跳；观察者看到心跳停了就接任司机。
   */
  const RUN_KEY = "cglide:run:v1:";
  const RUN_BEAT_MS = 1000;                    /* 司机心跳周期 */
  /* 心跳停这么久没动 = 司机没了，观察者接任。司机活着时每秒都在跳，5 秒足够
     把"刷新后司机已死"和"司机只是卡了一下"分开。 */
  const RUN_CLAIM_MS = 5000;
  const RUN_RESUME_MAX_MS = 15 * 60 * 1000;    /* 再久就不自动续跑（那次早已无人接管） */
  /* 本 bag 的身份。热重建（HMR）会换一个 bag，靠它区分"存档是我写的"还是
     "上一个 bag 写的"。 */
  const RUN_CTX = Math.random().toString(36).slice(2, 10);

  /* 片名为空 = 还没有工程身份：**不读任何续跑存档**。以前兜成 "_"，
     所有无名工程共用同一份队列，刷新后可能接着渲染别人的段。 */
  const runKey = () => {
    let n = "";
    try { n = (ui.castName && ui.castName()) || ""; } catch (_) { /* 面板未就绪 */ }
    return n ? RUN_KEY + n : "";
  };
  /* 工程指纹：段数 + 各段 clip id。刷新前后工程若被改动（增删段 / 换工程），
     存档里的队列下标就对不上了 —— 那种情况绝不能续跑，否则会去渲染别的段。 */
  const projSig = () => {
    try {
      const p = ui.proj();
      const shots = Array.isArray(p && p.shots) ? p.shots : [];
      return shots.map((s) => (s && (s.clip || s.id)) || "").join("|") + "#" + shots.length;
    } catch (_) { return ""; }
  };
  function readRun() {
    const k = runKey();
    if (!k) return null;
    let raw = null;
    try { raw = localStorage.getItem(k); } catch (_) { return null; }
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      return (d && d.v === 1 && Array.isArray(d.queue) && d.queue.length) ? d : null;
    } catch (_) { return null; }
  }
  function runSnapshot() {
    const r = ui.run;
    return {
      v: 1, ctx: r.ctx, sig: r.sig, beat: Date.now(), startedAt: r.startedAt || 0,
      mode: r.mode, scope: r.scope, queue: r.queue, startIdx: r.startIdx,
      k: r.k, i: r.i, total: r.total, skipped: r.skipped,
      pid: r.pid || null, note: r.note || "", cancel: r.cancel ? 1 : 0,
      made: r.made || [], partials: r.partials || [], warnings: r.warnings || [],
      failed: r.failed || [],
    };
  }
  /* 只有司机写盘。观察者写盘会把自己的（只读来的）进度盖到司机头上，两边各
     跑一份，同一段被排两次。 */
  function syncRun() {
    if (!ui.run || !ui.run.driver) return;
    const k = runKey();
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(runSnapshot())); } catch (_) {}
  }
  function clearRun() {
    const k = runKey();
    if (!k) return;
    try { localStorage.removeItem(k); } catch (_) {}
  }
  /* 观察者上点「停止全部」：司机看不到这次点击，只能写进存档让它自己读到。 */
  function markCancel() {
    const k = runKey();
    if (!k) return;
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const d = JSON.parse(raw);
      d.cancel = 1;
      localStorage.setItem(k, JSON.stringify(d));
    } catch (_) { /* 存档不可写：这次停止只在本页生效 */ }
  }
  /* 司机心跳。独立于渲染循环：等一段跑完要几十秒，那段时间的"我还活着"全靠
     它 —— 只靠 paintRun 打点的话，别的页面会误判司机已死、抢着续跑。 */
  function beatTimer(on) {
    try { if (ui.runBeatTimer) { clearInterval(ui.runBeatTimer); ui.runBeatTimer = 0; } } catch (_) {}
    if (!on) return;
    ui.runBeatTimer = setInterval(syncRun, RUN_BEAT_MS);
  }
  /* 服务端认不认这个任务 —— 刷新恢复前必须问一次。
     "已跑完"看 /history，"正在排/正在跑"看 /queue。两者都没有 = 这个任务从
     没进过服务端（刷新正卡在入队那一瞬、或服务重启过），等它是等不到的。
     /queue 的条目形状各版本不一致，这里按整包字符串找 id，不假设下标。 */
  async function promptKnown(id) {
    if (!id) return "";
    try {
      const r = await api.fetchApi(`/history/${id}`);
      if (r.status === 200) return "done";
    } catch (_) { /* 服务忙，继续查队列 */ }
    try {
      const r = await api.fetchApi("/queue");
      const d = await r.json().catch(() => ({}));
      if (JSON.stringify(d || {}).indexOf(id) >= 0) return "queued";
    } catch (_) { /* 查不到 */ }
    return "";
  }
  /* run / runBox 已上移到 buildUI 靠前的位置（见渲染控制行旁）：paintSegTools()
     在 3733 行就会被 render() 调到，而它经 paintRenderRow() 读 ui.run —— 声明留在
     这一行会撞 TDZ（Cannot access 'run' before initialization），整个面板在
     加载时直接抛错。 */
  /* ============================================================
   * 入队 —— 编译式渲染（方案① · 20261023）
   * ------------------------------------------------------------
   * 旧链路：改画布 widget → graphToPrompt 取"此刻的字面量" → 再打补丁覆盖。
   * 补丁里任何一处拿不到数据就**静默跳过**，于是那份"此刻架子/编辑框里的
   * 字面量"原样送了出去 —— 那正是别的段的素材与段词。8 段里总有 1~2 段跟
   * 别的段一模一样，就是这么来的（先污染再擦，且擦不干净时 fail-open）。
   *
   * 新链路：graphToPrompt 只当**图骨架**（拓扑 / 静态参数 / 静音状态），
   * 三个 *_data 输入整块覆写成**按段身份查出来的段数据**。面板此刻停在哪
   * 一段、广播有没有到、文案台拉没拉完，全都不影响提交内容。
   *
   * 由此下面这些"时序补丁"失去了存在意义（保留只是为了让面板跟着切段，
   * 不再承担正确性）：runSegment 里 setCurrent 之后的 sleep(50)。
   * ============================================================ */
  /* clipWanted：本次**要渲染的那一段**（由 runSegment 从工程里点名给出）。
     为什么不读 ui.st.chain.clip —— 面板可能在你点「全部渲染」之后又被别处切走
     （时间轴点选、后端 current 回声），那时"面板指着谁"就渲染谁，正好是串段。
     段身份从工程取，才是编译式渲染的最后一环。 */
  async function queueOnce(clipWanted) {
    const name = ui.castName ? ui.castName() : "";
    /* ① 把面板的当前段收口成段数据（stash 是纯数据写入，不动界面）。
          编译只读段数据 —— 这一步是"最后一次写"，不是"赶在提交前抢占"。 */
    try { ui.stash && ui.stash(); } catch (_) { /* 面板未就绪：下一段再说 */ }
    /* ② 等三节点所有在途落库（防抖 + 网络）完成：后端执行时读的是库，
          提交那一刻库必须已经是这批数据。 */
    await projectStore.flushWrites(name);
    /* ③ 取骨架 + 编译。拿不到段数据时结果是**空**、不是"别人的"；
          真解不出段身份就抛错 —— 这一段不跑，比跑出别人的画面便宜。 */
    /* 兜底也**只认工程现场**（20261105）：st.chain.clip 是随 h3_data 存盘的
       持久值，会跟着工作流跨工程跑，拿它当兜底与上面这条注释的意图自相矛盾。
       与 bz_queue_align 同一口径：段身份一律从工程取。 */
    const p0 = ui.proj();
    const clipNow = (clipWanted != null && clipWanted !== "")
      ? String(clipWanted)
      : String((p0 && Array.isArray(p0.shots) && p0.idx >= 0 && p0.shots[p0.idx])
        ? (p0.shots[p0.idx].clip || "") : "");
    const built = await promptBuild.compile(ui.node, clipNow);
    const rec = built.receipt;
    console.log("[编译] " + lineOf(rec));
    /* 重复段 / 引用缺口在这里就能判定 —— 不用等成片出来才发现两段一样。 */
    noteCompile(rec, ui);
    const res = await api.queuePrompt(0, built.prompt);
    const id = res && (res.prompt_id || res.promptId);
    if (!id) throw new Error("服务端未返回任务 ID");
    return id;
  }

  /* 重拍单段（scope=clip）时前序段不在本轮渲染里，previous 恒为空 —— 但
     中央档案里存着它上一次跑出来的续拍存档。这里按前一段的 cid 回查一次，
     让整段重拍（头尾都不留）也能接上前面（20261015 重拍第 2 段起即报「前序
     片段中央回执缺失」的根因）。查不到就返回 null，由调用方给出可执行的
     提示，而不是一句看不懂的「回执缺失」。 */
  async function prevReceiptFromArchive(p, i) {
    const name = ui.castName ? ui.castName() : "";
    const prev = p.shots[i - 1];
    const cid = prev && (prev.clip || "");
    if (!name || !cid) return null;
    try {
      const res = await api.fetchApi("/cglide/chain/cont?name="
        + encodeURIComponent(name) + "&id=" + encodeURIComponent(cid));
      const d = await res.json().catch(() => ({}));
      if (d && !d.error && d.cont_path) {
        return { cont_path: d.cont_path, segment_film: {} };
      }
    } catch (e) { /* 查不到 → null，交给调用方提示 */ }
    return null;
  }

  /* Polling rather than socket events: it survives a dropped websocket, a tab
     that was backgrounded, and every frontend version. A render is a minute or
     more, so a second between checks costs nothing. */
  async function waitForPrompt(id) {
    for (;;) {
      if (ui.run && ui.run.cancel) throw new Error("cancelled");
      await sleep(1200);
      /* 心跳 + 取消回读：等一段要几十秒，这段时间必须让别的页面看到"司机还
         活着"；别的页面（观察者）点的「停止全部」也只能经存档传过来。 */
      syncRun();
      const rec = readRun();
      if (rec && rec.cancel && ui.run) ui.run.cancel = true;
      if (ui.run && ui.run.cancel) throw new Error("cancelled");
      let entry = null;
      try {
        const r = await api.fetchApi(`/history/${id}`);
        if (r.status === 200) {
          const h = await r.json();
          entry = h && h[id];
        }
      } catch (e) { /* server busy or restarting: try again */ }
      if (!entry) continue;
      const s = entry.status || {};
      if (s.status_str === "error") {
        /* ComfyUI 原生「中断当前」会把该 prompt 记为 error、messages 含
           execution_interrupted —— 这算手动停止（不是真失败），让整个循环停下。
           非中断错误可能是整片后处理失败；分段视频若已落盘，交给中央收片按
           拓扑核验并登记为 partial。 */
        const interrupted = JSON.stringify(entry).includes("execution_interrupted");
        if (interrupted) throw new Error("cancelled");
        console.warn("[H3 Studio] 本次 prompt 为 partial，尝试中央收分段片：", s);
        return entry;
      }
      if (s.completed || s.status_str === "success") return entry;
    }
  }

  /* 渲染浮层（.gcast-run）脱离画布定位、贴住双栏视觉矩形。
     v2 前端把节点 DOM 整体放在 .dom-widget 容器里：该容器 position:fixed
     且带 transform:matrix(scale)（画布缩放），宽度还由框架逐帧同步、缩放时
     会在并排/窄档间重排。浮层若挂在双栏内用 absolute/inset:0，就处在这个
     transform 定位上下文里 —— 缩放/平移时遮罩与卡片跟着变换盒错位、卡片
     也被一起放大。改挂 document.body 后脱离画布变换，再以 rAF 读双栏
     getBoundingClientRect() 的**视觉**坐标（视口 px，fixed 直接可用、无需
     除 scale，与接缝胶囊卡/段工具条同构方案），遮罩始终精确盖双栏可视区、
     卡片保持自然字号，缩放/平移/节点移动/面板重排都实时跟随。 */
  /* 返回：0 = 双栏已不在 DOM（应摘除浮层）；1 = 几何无变化；2 = 本次有重定位。
     只写发生变化的样式，避免每帧强制重排。 */
  function placeRunBox() {
    const box = ui.runBox;
    /* 20261106：遮罩只盖右栏（设置卡），左栏监视器要露出来显示内置逐帧预览。
       防误编辑的意图仍成立 —— 参数卡被盖住，只有「停止」卡片可点。 */
    const sr = ui.rightCol || ui.studioRow;
    if (!box || !sr || !sr.isConnected) return 0;
    const r = sr.getBoundingClientRect();
    const L = Math.round(r.left), T = Math.round(r.top),
          W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    const st = box.style;
    let changed = 1;
    const set = (k, v) => { if (st[k] !== v) { st[k] = v; changed = 2; } };
    set("left", L + "px");
    set("top", T + "px");
    set("width", W + "px");
    set("height", H + "px");
    return changed;
  }

  function paintRun() {
    if (!ui.run) {
      /* 渲染结束（或观察者发现司机跑完了）：存档一并清掉，否则下次刷新会
         把已经结束的一轮当成"还在跑"再接回来。 */
      clearRun();
      /* 整轮结束：撤掉逐帧预览层，让监视器恢复正常的成片画面。 */
      try { ui.clearLive?.(); } catch { /* 面板已销毁 */ }
      if (ui.runBox) {
        try { ui.runBox._stopFollow?.(); } catch { /* 无跟随循环 */ }
        ui.runBox.remove(); ui.runBox = null;
      }
      ui.root.classList.remove("running");
      ui.paintRenderRow();          /* 渲染结束，「全部渲染」重新可用 */
      ui.paintRunScope();           /* 轴上"正在跑"那段的脉冲随之撤掉 */
      ui.updateLanesMeta();         /* 轴头计数从 3 / 8 回到 8 段 */
      return;
    }
    if (!ui.runBox) {
      ui.runBox = el("div", "gcast-run bz-live");
      const card = el("div", "card");
      card.append(el("div", "ttl", "正在渲染工程"));
      card.append(el("div", "msg"));
      card.append(el("div", "sub"));
      const cancel = el("button", "gcast-btn ghost", "停止全部");
      cancel.title = "立即中断当前正在渲染的分段，并取消后面所有分段；已完成的分段会保留。";
      cancel.onclick = async (e) => {
        e.stopPropagation();
        if (!ui.run) return;
        ui.run.cancel = true;
        /* 观察者（别的页面/重建的 bag）点的停止：司机看不到这次点击，写进
           存档让它下一拍读到；司机自己写一份也是同一条路径，不会漏。 */
        if (ui.run.driver) syncRun(); else markCancel();
        /* 立即中断当前正在后端执行的 prompt：光设 cancel 只让前端不再等，
           当前任务在后端仍会跑完，用户会看到"点了停止它还在跑"。 */
        try { await api.interrupt(); } catch { /* 已结束/无任务，忽略 */ }
        /* 清空队列里残留的 pending（兜底：防并发或其他来源已排队的任务）。 */
        try {
          await api.fetchApi("/queue", { method: "DELETE",
            body: JSON.stringify({ delete: [], clear: true }) });
        } catch { /* 旧版无该路由，忽略 */ }
        paintRun();
      };
      card.append(cancel);
      ui.runBox.append(card);
      /* 挂在 document.body（脱离画布 transform 缩放盒），不是双栏内：
         遮罩仍只盖双栏可视区（监视器+设置，跑的时候不该改参数），不盖总览轴
         —— 轴上画着"哪几段在跑、跑到第几段"，盖住它就只剩一个转圈对话框。
         覆盖范围由 rAF 按双栏视觉矩形实时给出（见 placeRunBox）。 */
      document.body.appendChild(ui.runBox);
      placeRunBox();              /* 挂载即定位，避免首帧在左上角闪一下 */
      let raf = 0, tick = 0, idleFrames = 0;
      const stopLoop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
      const loop = () => {
        raf = requestAnimationFrame(loop);
        tick++;
        /* 自适应帧率：缩放/平移/面板重排进行中（几何在变）每帧跟随，零滞后；
           几何连续约 0.5s 无变化（正常渲染静置）降到每 3 帧检测一次，省空转。 */
        if (idleFrames > 30 && (tick % 3 !== 0)) return;
        const moved = placeRunBox();
        if (moved === 0) {
          /* 双栏已不在 DOM（节点被删除/重建）：浮层绝不能残留在 body 上。 */
          stopLoop();
          if (ui.runBox) { try { ui.runBox.remove(); } catch { /* 无 */ } ui.runBox = null; }
          try { ui.root?.classList.remove("running"); } catch { /* 无 */ }
          return;
        }
        idleFrames = moved === 2 ? 0 : idleFrames + 1;
      };
      raf = requestAnimationFrame(loop);
      ui.runBox._stopFollow = stopLoop;
      ui.root.classList.add("running");
    }
    const p = ui.proj();
    const name = p.shots[ui.run.i] ? ui.shotLabel(p.shots[ui.run.i], ui.run.i) : `分段 ${ui.run.i + 1}`;
    ui.runBox.querySelector(".msg").textContent =
      ui.run.cancel ? `正在收尾 ${name}…` : `${name} —— ${ui.run.k + 1} / ${ui.run.total}`;
    ui.runBox.querySelector(".sub").textContent =
      ui.run.note || (ui.run.mode === "continue" ? "经「续写来源」串联" : "各分段独立渲染")
      + (ui.run.skipped ? `，已跳过 ${ui.run.skipped} 段` : "");
    /* 进度同时落在轴上：正在跑的那一段脉冲，轴头计数变成 3 / 8。
       遮罩层盖在面板正中会把轴挡住，而"跑到第几段"恰恰是要盯着轴看的事。 */
    ui.paintRunScope();
    ui.updateLanesMeta();
    /* 每一次进度变化都落盘：这就是刷新之后能把它接回来的那一份。
       （观察者的 syncRun 是空操作，司机才是权威。） */
    syncRun();
  }

  /* ============================================================
   * 渲染前预检（20261103 身份不变量：段身份只由档案签发，执行不签发）
   * ------------------------------------------------------------
   * 「跑完 30 分钟才发现成片收不上轴」的每一条路都能在这里用一次网络
   * 来回提前 3 秒拦下：
   *   ① 本轮各段必须绑着档案里的 clip id —— 断绑（导入别处工程/删过档案/
   *      登记失败）旧行为是执行时静默新建一段：轴上"3 段变 4 段"，
   *      收片按旧 id 报错，两头都看不出为什么；
   *   ② 画布上必须至少有一个「🎬 H3 VAE 快速解码」—— 20261111 起续拍存档
   *      与认片都由它承担，存档节点已从画布删除（一采/二采各一个是正常拓扑）。
   * 返回 "" = 通过；否则返回可直接上结果行的中文原因。
   */
  async function preflightRender(queue) {
    const name = (ui.castName && ui.castName()) || "";
    if (!name) return "还没填工程名 —— 档案按工程名建目录，先在工程面板填名字";
    let ids;
    try {
      const res = await api.fetchApi("/cglide/chain/summary?name="
        + encodeURIComponent(name));
      const d = await res.json().catch(() => ({}));
      if (d && d.error) return "读不到段落档案：" + d.error;
      ids = new Set(((d && d.clips) || []).map((c) => String((c && c.id) || "")));
    } catch (e) {
      return "档案服务没应答（ComfyUI 刚重启？稍等几秒再点）";
    }
    const p = ui.proj();
    const lost = [];
    for (const i of queue) {
      const sh = p.shots[i];
      if (!sh) continue;
      if (!sh.clip || !ids.has(String(sh.clip))) {
        lost.push(ui.shotLabel ? ui.shotLabel(sh, i) : `第 ${i + 1} 段`);
      }
    }
    if (lost.length) {
      return `这些段还没绑进档案：${lost.join("、")} —— 把这些段删掉重新添加`
        + `（会自动绑进档案），然后再渲染（本轮没有开跑，不白烧 GPU）`;
    }
    /* 20261111 阶段 1：存档节点已删除，写盘/阶段判定/认片全在 🎬 H3 VAE 快速解码里。
       一采/二采各挂一个是正常拓扑，只要求「至少一个」。 */
    const DECODE = ["BanZhang_H3VAEDecodeFast"];
    const nodes = (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
    const decodes = nodes.filter((n) => n && DECODE.indexOf(n.comfyClass) >= 0);
    if (!decodes.length) {
      return "画布上没有「🎬 H3 VAE 快速解码」节点 —— 续拍存档和分段片认片现在都由它承担，"
        + "没有它时间轴收不到片。请在一采/二采的采样输出后各接一个";
    }
    return "";
  }

  async function renderAll(mode, scope) {
    if (ui.run) return;
    /* 折叠态下 .bzf-view 是 display:none，逐帧预览看不见；全部渲染时强制展开。 */
    try { ui.monitor.setMode?.("normal"); } catch { /* 监视器尚未就绪 */ }
    const p = ui.proj();
    /* 段数硬闸（20261107）：档案有 N 段、工程只有 M 段 = 有段没登记进工程，
       排队集合本身就不全 —— 这时"顺手补齐"是补丁，会掩盖创建端的错。
       直接停、不排队；对账会在刷新时把缺段从档案派生回工程，再点即可。 */
    const nArc = ui.monitor && ui.monitor.clipCount ? ui.monitor.clipCount() : -1;
    if (nArc > 0 && nArc > p.shots.length) {
      ui.setRunResult(false, `档案里有 ${nArc} 段，工程里只有 ${p.shots.length} 段 —— `
        + "有段没登记进工程，已经停下、没有排队。先刷新一次页面（对账会把缺的段补回工程），"
        + "再点全部渲染。");
      return;
    }
    /* v2 阶段 ⑤：后端权威渲染状态。开关 window.__bzBackendRun 打开时建立
       后端 run_id；后端不可用返回 null，下面照旧走浏览器循环，绝不拦出片。 */
    if (backendRun.enabled() && p && Array.isArray(p.shots)) {
      try {
        const clips = p.shots.map((s) => s && s.clip).filter(Boolean);
        const started = await backendRun.start(String(p.name || ""), clips);
        if (started && started.run_id) {
          ui._bzRunId = started.run_id;
          console.log("[班长] 后端批跑状态已建立：" + started.run_id);
        }
      } catch (_) { /* 后端不可用时保持原浏览器循环 */ }
    }
    if (!p.shots.length) {
      ui.lanesFlash("本工程还没有任何分段 —— 先在成片监视器里点「＋ 接第一段」");
      return;
    }
    scope = scope || "all";

    /* 窗口 1 修复（20261111）：批跑绕过画布 queue 包装（isGloballyRendering 直接
       放行），那条提交前 flush 不生效，必须在这里自己收口一次。「取消接续」的
       驱动音频重切是 600ms 防抖、可能还没发 —— 不收口，头几段就会拿旧切片出片。
       flush 永不抛（失败已给过可见提示），收口失败也不拦批跑。 */
    try { await ui.flushDriverReslice?.(); }
    catch (e) { console.warn("[H3 导演台] 批跑前驱动音频收口失败：", e); }

    /* 工程/档案冲突检测：拖时间轴改过的段，面板预设可能还是旧的，渲染会把它
       静默覆盖掉。先摆出来让用户选哪边算数，再往下排队。用户取消就不渲染。 */
    if (!(await ui.syncCheck())) return;

    /* 预检必须排在 beginRender 之前：拦下就直接 return，不能带着渲染令牌退场
       （令牌不还，面板永远"渲染中"）。queue 这里本地预算一份，与下面正式
       排队同一判据（scopeRange + 跳过位），两段计算之间工程不会变。 */
    {
      const _r = scopeRange(scope, p.idx >= 0 ? p.idx : 0);
      const _q = scope === "clip" ? _r.slice() : _r.filter((i) => !p.shots[i].off);
      const why = await preflightRender(_q);
      if (why) {
        /* 20261107：同一条消息以前既写 .gcast-flash 又写 runResult，
           底部就出现两行一模一样的橙字。只留结果行（带 ok=false 状态）。 */
        ui.setRunResult(false, "渲染前检查没过：" + why);
        return;
      }
    }

    /* 上一轮的结果行作废：本轮还没开始，留着"完成 3 段"会让人以为已经跑过了。
       权威在存档（st.run_result），DOM 由 paintFootRow 呈现 —— 这里清存档，
       直接藏 DOM 会在刷新后复活（存档里那条还在）。
       必须落盘：不清存档的话，刷新页面会看到上一轮的旧结果——而本轮明明
       已经开跑了。渲染**开始前**调 commit 是安全的（此刻还没进 rendering
       态，beginEdit 不会打断任何东西）。 */
    if (ui.st) ui.st.run_result = null;
    ui.paintFootRow?.();
    try { ui.commit?.(); } catch (_) { /* 面板未就绪 */ }
    /* 入队前确认画布上接了「🎬 H3 VAE 快速解码」。
       20261111 阶段 1：💾 续拍存档已并入这个节点，画布不再放存档节点。
       它每次执行前自动写 (段, take, 阶段) 的 cont 档；一采/二采各接一个，
       同一次运行落在同一个 take 下，不再是两个版本。
       setSaveNewTake() 仍数旧存档节点，已不能当这里的判据。 */
    {
      const g = app.graph;
      const ns = g ? (g._nodes || g.nodes || []) : [];
      const hasDecode = ns.some((n) => n && n.comfyClass === "BanZhang_H3VAEDecodeFast");
      if (!hasDecode) {
        console.warn("[H3 Studio] 画布上没有「🎬 H3 VAE 快速解码」节点 —— "
          + "本次不会写任何潜空间档：重抽留不下版本，下一段也接不上承接头。"
          + "请在一采/二采的采样输出后各接一个「🎬 H3 VAE 快速解码」。");
      }
    }

    /* Free undo: the project as it stands goes into the same slot New and Open
       use, so Revert in the project panel brings it back. */
    ui.stash();
    /* 渲染期权威令牌：渲染循环成为唯一权威，self-heal 立即冻结"后端→前端"
       自动灌入，杜绝渲染期间用后端旧值覆盖画布（尺寸不生效根因）。 */
    projectStore.beginRender(ui.node);
    const startIdx = p.idx >= 0 ? p.idx : 0;
    /* 中断原因由 driveRun 持有（catch 里拿到 err，finally 里要用——跨这两个块
       必须有个外层变量，否则 finally 就分不清"跑完了"和"抛异常退出的"）。 */

    /* Which clips the scope covers, minus skipped ones. "clip" is an explicit
       ask, so it renders even a skipped clip. */
    const range = scopeRange(scope, p.idx >= 0 ? p.idx : 0);
    const queue = scope === "clip" ? range.slice() : range.filter((i) => !p.shots[i].off);
    if (!queue.length) {
      ui.lanesFlash("该范围内的分段全部被跳过 —— 没有可渲染的段落");
      return;
    }
    const skipped = range.length - queue.length;

    /* 重抽范围（保留头 / 尾几帧）是**逐段**存的，用户却是在点渲染前设的 ——
       那一组只落到当时正在编辑的那一段，其余各段各自留着旧值；渲染依次
       switchTo 各段，数值就跟着跳成别段的（20261013「点渲染后『重来』变
       『微调』」的老坑，现在换成了帧数而已）。
       本轮按渲染按钮旁**当前显示的那一组**统一跑，写进本轮各段并明确说一声
       —— 想各段不同就逐段切过去设（20261026 起不再存「全部渲染前」快照，改错了要手动改回）。
       20261026：重抽档位（redo_mode）已删除，不再统一写它。 */
    if (queue.length > 1 && ui.st) {
      const runHead = Math.max(0, Math.min(4096, Math.round(Number(ui.st.pin_head) || 0)));
      const runTail = Math.max(0, Math.min(4096, Math.round(Number(ui.st.pin_tail) || 0)));
      let n = 0;
      for (const i of queue) {
        const sh = p.shots[i];
        if (!sh) continue;
        const sst = sh.state || (sh.state = {});
        if ("redo_mode" in sst || "redo_anchor" in sst) {
          delete sst.redo_mode;
          delete sst.redo_anchor;
        }
        if (Number(sst.pin_head || 0) !== runHead
            || Number(sst.pin_tail || 0) !== runTail) {
          sst.pin_head = runHead;
          sst.pin_tail = runTail;
          n++;
        }
      }
      if (n) {
        ui.commit();
        ui.lanesFlash(`本轮 ${queue.length} 段的重抽范围已统一为「保留头 ${runHead} 帧 / 尾 ${runTail} 帧」`
          + (runHead || runTail ? "" : "（头尾都不留 = 整段从零重拍）")
          + `（改了 ${n} 段）—— 想各段不同，请切到那段单独设`);
      }
    }

    ui.run = { driver: true, ctx: RUN_CTX, sig: projSig(), startedAt: Date.now(),
            cancel: false, queue, mode, scope, startIdx, skipped,
            i: queue[0], k: 0, total: queue.length,
            pid: null, note: "", made: [], partials: [], failed: [] };
    paintRun();
    /* 立刻重画分段列表：把建段/删段/换工程这类按钮在运行期间置灰 */
    /* 心跳独立起一条：等一段要几十秒，这段时间"司机还活着"全靠它 —— 只靠
       paintRun 打点的话，别的页面会误判司机已死、抢着续跑。 */
    beatTimer(true);
    await driveRun({ pid: null, k: 0 });
  }

  /* 收片登记：把这一段跑出来的成片名记进本轮 —— 结果行与"已完成几段"都读它。 */
  function pushMade(receipt) {
    const madeName = (receipt.segment_film &&
      (receipt.segment_film.archived_path || receipt.segment_film.filename)) || "";
    ui.run.made.push(madeName);
    if (receipt.status === "partial") ui.run.partials.push(madeName);
    console.log(`[H3 Studio] Render all: clip ${ui.run.i + 1}/${ui.proj().shots.length}`
      + ` \u2192 ${madeName}`, receipt.status || "adopted");
  }

  /* ---- 单段渲染 ----
     切段 → 承接上一段 → 素材自检 → 入队 → 等 → 中央收片。
     「全部渲染」与「刷新后续跑」走的是同一份代码：刷新之后剩下的段必须和没
     刷新时跑出来的一模一样，两份实现迟早会长歪。
     previous = 上一段的中央回执（本段的承接来源；首段为 null）。返回本段回执，
     抛错即整轮中断。 */
  async function runSegment(previous, mode, i, k) {
    const p = ui.proj();
    ui.run.i = i; ui.run.k = k; ui.run.note = ""; ui.run.pid = null;
    paintRun();
    switchTo(i);
    /* 渲染必须让文案台/媒体架跟着切到本段：switchTo 只切了导演台面板 +
       媒体架（restoreShotRack 同步），文案台靠广播异步切、且切段读的是
       后端 current —— 手动点段时 onPick 里有 setCurrent 会更新 current，
       渲染循环里没有，current 一直停在渲染前的段，文案台 desk_data 就
       始终输出旧段提示词，三段渲染同词（20261012「三段生成都一样」根因）。
       ⚠ 20261023 起这条不再是**正确性**依赖：提交内容由 bz_prompt_build 按
       段身份编译，文案台有没有跟上都不影响送出去的东西。setCurrent + 这一拍
       只保留"人看着舒服"的作用（面板跟手切段），删掉也不会串段。 */
    await setCurrent(ui.castName(), p.shots[i].clip || "");
    await sleep(50);
    /* 是否与上段接续：断链真值已统一到 transitions[cid]=unlink（胶囊
       「连播」开关、后端 _continuation_latent 都读它）；shot.link===false
       是旧工程遗留的第二真值，一并认下（20261012 接缝根治）。 */
    const _cid0 = p.shots[i].clip || "";
    const _unlinked = !!(_cid0 && p.transitions && p.transitions[_cid0]
      && p.transitions[_cid0].type === "unlink");
    /* 要不要接 = 本段的「承接帧数」> 0（20261029 起的默认 0 = 独立成段）。
       以前这里默认 true（只要没断链就接），于是用户从没选过"接"，每一段都
       被自动接上前一段 —— 这正是"取消了还在承接"的运行时总闸。
       另外两个否决票照旧：该段被标了 link===false、或左接缝断链。 */
    const _contN = Math.round(Number(
      ui.st && ui.st.cont && ui.st.cont.frames) || 0);
    const linked = _contN > 0
      && !(i > 0 && (p.shots[i].link === false || _unlinked));

    if (linked && i > 0 && mode === "continue") {
      /* previous 为空只在「重拍单段」时出现（前序段没在本轮跑过）：
         先回中央档案补它的续拍存档，补不到再报错。 */
      if (!previous) previous = await prevReceiptFromArchive(p, i);
      if (!previous) {
        throw new Error("接不上前一段：前一段还没有续拍存档。"
          + "请先选中前一段跑一次（或用「全部渲染」从头跑一遍）");
      }
      if (ui.st.cont.mode === "latent") {
        if (!previous.cont_path) {
          throw new Error("前序片段中央回执缺少 cont 存档路径");
        }
        ui.run.note = "正在引用上一分段的中央续拍存档\u2026"; paintRun();
        const prevFilm = previous.segment_film || {};
        const preview = prevFilm.filename ? {
          name: prevFilm.filename,
          subfolder: prevFilm.subfolder || "",
          type: "output",
        } : null;
        ui.applyLatentAdoption(ui.st.cont, {
          path: previous.cont_path,
          preview,
        });
      } else {
        const prevFilm = previous.segment_film || {};
        if (!prevFilm.filename) {
          throw new Error("前序片段中央回执缺少分段视频");
        }
        ui.run.note = "正在截取前序片段的本次分段视频\u2026"; paintRun();
        await ui.adoptInto(ui.st.cont, {
          name: prevFilm.filename,
          subfolder: prevFilm.subfolder || "",
          type: "output",
        });
      }
      ui.render(); ui.commit(); ui.stash();
    }

    /* 排队前自检：缺素材**只提醒、不中断**（20261018 用户定）。
       素材缺口不该拦下整轮渲染 —— 用户可能就是要先看画面，也可能稍后补素材；
       为它中断一整轮、让前面已跑完的段白等，代价远大于"画面可能不受控"。
       缺口收进本轮 warnings 照常跑，收尾时在结果行一并亮出（常驻到下次渲染）。
       判据（20261023）：从「面板此刻的槽位」改成「**本段的段数据**」——
       渲染循环里面板可能已经停在别的段，按面板判会误报或漏报，而漏报的那种
       恰好就是"引用了却没有素材"的真故障（编译式渲染顺带修好的一处）。 */
    ui.run.note = "检查引用素材…"; paintRun();
    try {
      const sh = p.shots[i] || {};
      const { receipt: pre } = promptBuild.inspect(ui.node, sh.clip || sh.id || "", i);
      if (pre && pre.gaps && pre.gaps.length) {
        const warn = `第 ${i + 1} 段引用的 ${pre.gaps.join("、")} 没有对应素材`
          + `（本段媒体架槽位为空）`;
        /* 20261107：续跑从 localStorage 恢复 warnings 后同一段会再自检一次，
           不去重就会在结果行拼出两条一模一样的 ⚠ 警告。 */
        const ws = (ui.run.warnings = ui.run.warnings || []);
        if (!ws.includes(warn)) ws.push(warn);
        console.warn("[H3 Studio] " + warn
          + "。媒体架按分段记忆：切到本分段，把素材放回媒体架即可，"
          + "它会随该分段自动保存。—— 已照常渲染，画面可能不受控。");
      }
    } catch (e) {
      /* 自检失败不该拦住渲染本身：编译那一刻还会再判一次并给出同样的告警。 */
      console.warn("[H3 Studio] 素材自检跳过：", e);
    }

    ui.run.note = "已入队，等待渲染\u2026"; paintRun();
    const id = await queueOnce(p.shots[i] && p.shots[i].clip);
    /* 入队即落盘：此刻刷新，能原样把这一段接回来（等它跑完再收片），而不是
       丢掉它、让前面跑过的段白等 —— 「刷新后弹窗没了」的根因就在这里。 */
    ui.run.pid = id; paintRun();
    await waitForPrompt(id);
    /* 中央收片：后端按 prompt_id 与本次拓扑，只认续拍存档下游的分段视频。
       导演台整片口下游的超分/插帧/合并结果不会进入分段时间轴。 */
    ui.run.note = "中央收片…"; paintRun();
    const collected = await ui.collectRun(p.shots[i], id);
    const receipt = collected && collected.receipt;
    if (!receipt) {
      throw new Error("中央收片未返回回执");
    }
    pushMade(receipt);
    /* 已收片就清掉 pid：这一格之后再刷新，存档不会把同一段收两次片。 */
    ui.run.pid = null; paintRun();
    return receipt;
  }

  /* ---- 整轮驱动（含刷新续跑）----
     start.pid 非空 = 这一段刷新前已经入队、后端多半还在跑：先接回它（等它跑完
     → 中央收片），再从下一格继续排剩下的段。start.k = 存档里"正在跑的那一格"
     的下标；pid 为空时从这一格起跑（刷新发生在两段之间的空档）。 */
  async function driveRun(start) {
    let stopped = false;
    /* 中断原因。catch 里拿到 err，finally 里要用——跨这两个块必须有个外层变量，
       否则 finally 就分不清"跑完了"和"抛异常退出的"。 */
    let failMsg = "";
    let previous = null;
    const startIdx = ui.run.startIdx;
    try {
      let k0 = start.k;
      if (start.pid) {
        /* 服务端还认这个任务吗？不认（刷新卡在入队那一瞬、或服务重启过）就不
           能干等 —— 等一个从没排上队的 id 是永远等不到头的。 */
        const known = await promptKnown(start.pid);
        if (known) {
          ui.run.pid = start.pid;
          ui.run.note = "刷新恢复：正在接回未跑完的这一段…";
          paintRun();
          await waitForPrompt(start.pid);
          ui.run.note = "中央收片…"; paintRun();
          const collected = await ui.collectRun(ui.proj().shots[ui.run.i], start.pid);
          const receipt = collected && collected.receipt;
          if (!receipt) throw new Error("中央收片未返回回执（刷新恢复）");
          previous = receipt;
          pushMade(receipt);
          ui.run.pid = null; paintRun();
          k0 = start.k + 1;
        } else {
          console.warn("[H3 Studio] 刷新恢复：服务端没有任务 " + start.pid
            + " —— 这一段改为重新渲染");
          ui.run.note = "刷新恢复：这一段没跑起来，改为重新渲染";
          ui.run.pid = null; paintRun();
        }
      }
      if (ui.run.cancel) stopped = true;
      else {
        /* 单段失败不再拖垮整轮（20261023 用户定）：收片失败（本次 prompt 是
           partial、存档下游没出片、多个存档节点开着…）只该让**这一段**没成片，
           不该把后面的段一起停掉 —— 一停，用户还得从头再点一次「全部渲染」，
           前面已经跑完的段又要重跑一遍（实测白跑了一段 t25→t26）。
           手动停止（cancelled）仍然当场中止：那是用户的意图，不是失败。 */
        for (let k = k0; k < ui.run.queue.length; k++) {
          try {
            previous = await runSegment(previous, ui.run.mode, ui.run.queue[k], k);
            if (ui._bzRunId) {
              const shot = ui.proj().shots[ui.run.queue[k]];
              await backendRun.done(ui._bzRunId, shot && shot.clip, true,
                previous && previous.cont_path ? { cont_path: previous.cont_path } : null);
            }
          } catch (err) {
            if (String(err && err.message) === "cancelled") {
              stopped = true; failMsg = "已手动停止"; break;
            }
            const why = String((err && err.message) || err);
            ui.run.failed.push({ k, why });
            syncRun();                /* 立即落盘：这轮若中途刷新，失败段不会丢 */
            console.error(`[H3 Studio] 第 ${k + 1} 段失败（其余段继续）：`, err);
            if (ui._bzRunId) {
              const shot = ui.proj().shots[ui.run.queue[k]];
              await backendRun.done(ui._bzRunId, shot && shot.clip, false, { why });
            }
          }
          if (ui.run.cancel) { stopped = true; break; }
        }
      }
    } catch (err) {
      stopped = true;
      if (String(err && err.message) === "cancelled") {
        failMsg = "已手动停止";
        console.log("[H3 Studio] Render all: stopped");
      } else {
        failMsg = String((err && err.message) || err);
        /* 中断仍然不弹窗（20261008 用户要求移除全部此类弹窗）。但"原因只进控制
           台"意味着面板上什么都没有——用户跑完 8 段、第 3 段炸了，看到的是一个
           干干净净的空闲面板，无从判断要不要重跑。所以原因另写进结果行。 */
        console.error("[H3 Studio] Render all stopped:", err,
          `—— 第 ${ui.run.i + 1} 个分段处中断，已完成 ${ui.run.made.length} 个分段并保留`);
      }
    } finally {
      const made = ui.run ? ui.run.made.slice() : [];
      const partials = ui.run ? ui.run.partials.slice() : [];
      const warnings = ui.run ? (ui.run.warnings || []).slice() : [];
      const failed = ui.run ? (ui.run.failed || []).slice() : [];
      const at = ui.run ? ui.run.i : startIdx;
      ui.run = null;
      beatTimer(false);        /* 心跳先停：再写就把这一轮又写回存档了 */
      /* 渲染结束：交回编辑态，前端恢复权威（此时各段已是后端新值，且
         L434 switchTo 会把面板归位）。 */
      projectStore.endRender(ui.node);
      paintRun();              /* 浮层撤掉 + 存档清掉（paintRun 的收尾分支） */
      /* 结果行：成败、完成了几段、断在哪一段、为什么。跑完一轮之后这是面板上
         唯一能回答"刚才到底怎么样了"的地方，所以常驻到下一次渲染开始。 */
      /* 素材缺口挂在结果行尾巴上：不中断，但跑完必须看得见 —— 否则用户会以为
         素材其实在位，等画面不受控时根本找不到原因。 */
      const warnTail = warnings.length ? ` ｜ ⚠ ${warnings.join("；")}` : "";
      if (failMsg) {
        ui.setRunResult(false, `中断于第 ${at + 1} 段 · 已完成 ${made.length} 段`
          + `（${failMsg}）` + warnTail);
      } else if (failed.length) {
        /* 失败段单独列出来：它们没有成片，但整轮照常跑完了 —— 这两种情况的
           处置完全不同（前者要重跑那几段，后者只是后处理不全），不能混成一句。 */
        ui.setRunResult(false,
          `完成 ${made.length} 段 · ${failed.length} 段失败（第 `
          + failed.map((f) => f.k + 1).join("、") + ` 段：${failed[0].why}）`
          + ` ｜ ⚠ 失败段没有成片；它后面的段是按上一段成功的承接档续的，画面可能不连`
          + warnTail);
      } else if (partials.length) {
        ui.setRunResult(false, `完成 ${made.length} 段 · ${partials.length} 段为 partial`
          + `（分段片已收，整片后处理失败）` + warnTail);
      } else if (made.length) {
        ui.setRunResult(true, `完成 ${made.length} 段 · 最后一段 ${made[made.length - 1]}`
          + warnTail);
      }
      /* Back to the clip the run started from, so the panel is where it was */
      const p = ui.proj();
      if (p.shots[startIdx]) switchTo(startIdx);
      ui.paintSegTools();
      if (!stopped && made.length) {
        console.log(`[H3 Studio] Render all: done, ${made.length} clip(s), `
                  + `final file ${made[made.length - 1]}`);
      }
      /* 重抽的结果**一律直接采纳**（20261010 用户定）：不再弹「采纳 / 丢弃 /
         再抽一次」那个对比框 —— 跑了就是要新的。旧版本仍然留在磁盘上，要回去
         用段块右键里的版本清单切，那条路没动。

         这一轮跑完必须重拉一次档案：中央收片（collectRun）改的是**后端**，前端时间轴
         手里还攥着跑之前那份 film_summary —— 不重拉，段块上就还是重抽前的画面。
         段块画面的签名带档案 updated（见 csglide_film.js 的 renderStrip），重拉
         之后签名才会变，图才会重取。 */
      /* 刷新是一次网络来回，失败不该把整轮渲染的收尾打断 —— 画面晚一点刷出来，
         也比在 finally 里抛个错让人以为渲染失败强。 */
      await ui.monitor.refresh().catch(() => {});
    }
  }

  /* ============================================================
   * 刷新 / 热重建之后把"正在渲染"接回来
   * ------------------------------------------------------------
   * 存档里有记录 = 上一轮「全部渲染」没跑完就没了（刷新、关标签页、热重建）。
   * 这时后端多半还在跑刷新前入队的那一段，后面几段则没人再排 —— 所以必须
   * 有人接手。接手前先判断**司机还在不在**：
   *   心跳还在往前走 → 有页面正在驱动，本页只做观察者（画浮层、能点停止）；
   *   心跳停了       → 司机没了，本页接任，把剩下的段接着跑完。
   * ============================================================ */
  let bootTries = 4;

  function projectReady() {
    try {
      const p = ui.proj();
      return !!(p && Array.isArray(p.shots) && p.shots.length);
    } catch (_) { return false; }
  }

  /* 按存档重建 ui.run。driver = 本页是否接管排队。 */
  function runFromRecord(rec, driver) {
    const p = ui.proj();
    const queue = (rec.queue || []).filter((i) => !!p.shots[i]);
    if (!queue.length) { clearRun(); return false; }
    ui.run = {
      driver: !!driver, ctx: driver ? RUN_CTX : rec.ctx, sig: rec.sig,
      startedAt: rec.startedAt || 0,
      queue, mode: rec.mode, scope: rec.scope, startIdx: rec.startIdx,
      cancel: false, i: rec.i, k: rec.k, total: rec.total || queue.length,
      skipped: rec.skipped || 0, pid: rec.pid || null,
      note: driver ? "刷新后已接回渲染进度…" : (rec.note || ""),
      made: (rec.made || []).slice(),
      partials: (rec.partials || []).slice(),
      warnings: (rec.warnings || []).slice(),
      failed: (rec.failed || []).slice(),
    };
    paintRun();
    /* 立刻把建段/删段/换工程这类按钮置灰（paintRenderRow 挂在 paintSegTools
       上）：接回来的这一轮从这一刻起就是"渲染中"，不该还能改工程结构。 */
    try { ui.paintSegTools?.(); } catch (_) { /* 轴还没画出来 */ }
    return true;
  }

  function stopWatching() {
    try { if (ui.runWatchTimer) { clearInterval(ui.runWatchTimer); ui.runWatchTimer = 0; } } catch (_) {}
  }

  /* 观察者：只读存档画浮层。司机跑完 / 撤了（存档没了）就跟着撤；心跳停了就
     接任司机。刷新后**一律先走这条路** —— 浮层在 1 秒内就画出来，至于本页是
     接手还是继续观察，几秒之内自然见分晓（用户在意的"弹窗还在"先给到他）。 */
  function startWatching(rec) {
    if (!runFromRecord(rec, false)) return;
    let lastBeat = rec.beat || 0;
    let lastCtx = rec.ctx;
    /* 随机起跳：多标签页同时刷新时会一起判定"司机没了"，错开一点，后手能看
       到先手已经接任（存档 ctx 变了）并退回观察者。 */
    let stale = -Math.floor(Math.random() * 2000);
    stopWatching();
    ui.runWatchTimer = setInterval(() => {
      if (!ui.run) { stopWatching(); return; }
      const r = readRun();
      if (!r) {                       /* 司机跑完了：浮层跟着收 */
        stopWatching();
        ui.run = null; paintRun();
        return;
      }
      if (r.ctx !== lastCtx || (r.beat || 0) !== lastBeat) {
        /* 有人在驱动（或换了个司机）：本页继续当观察者。 */
        lastBeat = r.beat || 0; lastCtx = r.ctx; stale = 0;
      } else {
        stale += RUN_BEAT_MS;
        if (stale >= RUN_CLAIM_MS) {
          stopWatching();
          const r2 = readRun() || r;
          /* 最后一刻再确认一次：已经有人接手就退回观察者，别排第二次。 */
          if (r2.ctx !== lastCtx) { startWatching(r2); return; }
          /* 交出观察者身份（ui.run = null），否则 startResume 以为"本页已经在
             跑"会直接返回；但**不能**走 paintRun 收尾 —— 那条分支会顺手把存档
             清掉，续跑就没得读了。 */
          ui.run = null;
          startResume(r2);
          return;
        }
      }
      ui.run.k = r.k; ui.run.i = r.i; ui.run.pid = r.pid || null;
      ui.run.note = r.note || "";
      ui.run.made = r.made || []; ui.run.partials = r.partials || [];
      ui.run.failed = r.failed || [];
      ui.run.total = r.total || ui.run.total;
      if (r.cancel) ui.run.cancel = true;
      paintRun();
    }, RUN_BEAT_MS);
  }

  /* 接任司机：接回刷新前入队的那一段，再排剩下的。 */
  async function startResume(rec) {
    if (ui.run) return;
    if (!runFromRecord(rec, true)) return;
    projectStore.beginRender(ui.node);
    beatTimer(true);
    syncRun();
    /* 版本另存照旧勾上：续跑的每一段都是重抽，不留旧版就是覆盖。 */
    try { if (ui.setSaveNewTake) ui.setSaveNewTake(true); } catch (_) { /* 画布未就绪 */ }
    console.log("[H3 Studio] 检测到上一次「全部渲染」没跑完 —— 已接回第 "
      + (ui.run.i + 1) + " 段继续渲染（已完成 " + ui.run.made.length + " 段）");
    await driveRun({ pid: ui.run.pid, k: ui.run.k });
  }

  function bootRestore() {
    if (ui.run) return;                       /* 本页已经在跑 */
    const rec = readRun();
    if (!rec) { retryBoot(); return; }
    /* 工程库是异步灌的（hydrateFromStore），太早读 ui.proj() 只有空壳 ——
       签名比不出来，续跑会跑错段。工程没到位就再等一拍。 */
    if (!projectReady()) { retryBoot(); return; }
    if (rec.ctx === RUN_CTX) return;          /* 同一个 bag：不跟自己抢 */
    /* 工程变了（增删过段 / 换过工程）：存档里的下标已经不对应，续跑会去渲染
       别的段 —— 不续，把"上次没跑完"落成结果行。 */
    if (rec.sig && rec.sig !== projSig()) {
      clearRun();
      ui.setRunResult(false, "上一轮渲染在刷新时中断（工程已改动，未自动续跑）"
        + ` · 已完成 ${(rec.made || []).length} 段`);
      return;
    }
    if (Date.now() - (rec.beat || 0) > RUN_RESUME_MAX_MS) {
      clearRun();
      ui.setRunResult(false, "上一轮渲染在刷新时中断（已过去很久，未自动续跑）"
        + ` · 已完成 ${(rec.made || []).length} 段`);
      return;
    }
    /* 刷新前已经点过「停止全部」：那不是"没跑完"，别接着跑。 */
    if (rec.cancel) {
      clearRun();
      ui.setRunResult(false, "上一轮渲染已手动停止"
        + ` · 已完成 ${(rec.made || []).length} 段`);
      return;
    }
    /* 先以观察者身份把浮层画出来：刷新之后用户第一眼要看到"还在渲染"。
       司机还在（别的页面 / 热重建前的旧 bag）就一直观察；心跳停了就接任，
       把剩下的段接着跑完 —— 见 startWatching。 */
    startWatching(rec);
  }

  function retryBoot() {
    if (bootTries-- > 0) setTimeout(bootRestore, 1500);
  }

  /* Which clips a scope covers, in project order. */
  function scopeRange(scope, a) {
    const p = ui.proj();
    const n = p.shots.length;
    if (!n) return [];
    a = Math.min(Math.max(0, a | 0), n - 1);
    let s = 0, e = n - 1;
    if (scope === "clip") { s = a; e = a; }
    else if (scope === "from") { s = a; }
    const out = [];
    for (let i = s; i <= e; i++) out.push(i);
    return out;
  }

  function switchTo(i) {
    const p = ui.proj();
    if (i === p.idx || !p.shots[i]) return;
    ui.stash();
    p.idx = i;
    /* 先倒回该段的媒体架快照，再加载面板：load 里的 normalizeRefs / 别名表都靠
     * mergedSlots() 读媒体架——顺序反了就会用上一段的旧架况去归一与展开别名，
     * 出现"媒体架还原了但提示词引用对不上槽位"。 */
    ui.restoreShotRack(p.shots[i]);
    ui.load(JSON.stringify(p.shots[i].state));
    ui.commit();
    ui.paintSegTools();
    /* 切段即时广播：媒体架/文案台零延迟跟上（未登记段 clip 为空，它们
       会等登记成功广播 / 3 秒轮询兜底，20261012）。 */
    ui.broadcastSeg && ui.broadcastSeg("switch");
  }

  /* 删除一段 —— **真删**：轴上的块、工程里的分段、以及磁盘上的成片 / 潜空间 /
     波形 / 段落 json 一起去掉。只有这一种语义，没有"只从轴上拿掉"或"只从工程
     拿掉"这回事；右键菜单里那个同名的入口也已经撤掉，删除只有一个去处。

     删之前必须确认一次，而且确认框里要列出**会删掉哪些文件**：这是全流程里
     唯一不可逆的操作（工程面板的「还原」只回退分段配置，删掉的文件不回来）。
     清单由后端给，见 ui.confirmDeleteSegment。 */
  async function delShot(i) {
    const p = ui.proj();
    const s = p.shots[i];
    if (!s) return;
    /* 渲染中不给删：正在跑的链正按 p.shots 的下标取段，抽掉一段会让它去跑
       别的段 —— 与其跑错一段再回滚，不如不让删。 */
    if (ui.run) { ui.lanesFlash("正在渲染 —— 等这一轮跑完再删这一段"); return; }
    const label = ui.shotLabel(s, i);
    /* 不弹确认窗（20261009 用户定：点删除就删，不要任何弹窗）。
       删除是唯一不可逆的操作，代价靠事后一条**非阻塞**提示 + 工程面板「撤销」
       兜底：撤销能退回分段配置，删掉的成片/潜空间文件不会回来 —— 这条在
       提示语里说清楚，而不是用弹窗挡人。 */
    console.log(`[H3 Studio] 删除分段「${label}」：工程与档案一起删，`
      + "磁盘文件与分段配置都不可恢复（撤销已删除）");
    p.shots.splice(i, 1);
    /* 连同媒体架的本地段记忆一起清：segs 里留着已删段的旧素材，之后复制/
       切到复用同 id 的段时会被 switchSeg 命中残留、灌回删除前的图（20261014）。 */
    if (ui.dropRackSeg) {
      ui.dropRackSeg(s.id);
      if (s.clip) ui.dropRackSeg(s.clip);
    }
    if (!p.shots.length) p.idx = -1;
    else if (p.idx > i) p.idx--;
    else if (p.idx === i) {
      p.idx = Math.min(i, p.shots.length - 1);
      ui.restoreShotRack(p.shots[p.idx]);
      ui.load(JSON.stringify(p.shots[p.idx].state));
    }
    ui.commit();
    ui.paintSegTools();
    /* force = 真删（连磁盘上的成片 / 潜空间 / 波形一起清）。
       clip id 还没有（登记失败/被还原）也照删 —— 后端按分段 uid 反查档案
       条目；留着不删的话，删到剩一段底栏也还是 6 段的总时长。 */
    const data = await ui.unregisterShot(s, true);
    if (data && data.removed) {
      const n = (data.files || []).length;
      ui.lanesFlash(`已删除第 ${i + 1} 段「${label}」`
        + (n ? `（连同 ${n} 个档案文件）` : "")
        + "　·　删掉的文件不可恢复，分段配置也一起删了（撤销已删除）");
    }
    /* 时间轴永远保底一段（20261010 用户定）：删掉最后一段的瞬间自动补一个
       **默认初始设置**的新段 —— 空轴不是合法状态：没有段块，悬停工具条、
       接缝插入点、右键菜单全部没有落点，交互整条断掉。
       （「删空清档案残留」的旧逻辑随之移除：删光马上有新段顶上，档案里的
       残留段用悬停 ✕ 或右键逐个清理。） */
    if (!p.shots.length) ui.restoreDefaultShot();
  }


  /* 面板建好之后再去看一眼存档里有没有没跑完的一轮。
     放在 900ms 之后：onConfigure 要先把 h3_data 灌回面板、工程库也要灌完
     （hydrateFromStore 在 500~600ms），早于这个点读 ui.proj() 只有空壳 ——
     bootRestore 自己带四拍重试，慢的工程也能对上。 */
  setTimeout(() => {
    try { bootRestore(); } catch (e) {
      console.warn("[H3 Studio] 渲染进度恢复检查失败（不影响正常使用）：", e);
    }
  }, 900);

  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { sleep, queueOnce, waitForPrompt, paintRun, renderAll, scopeRange,
    switchTo, delShot, driveRun, runSegment, pushMade,
    /* 存档层：别的块（以及节点销毁）要用 */
    readRun, syncRun, clearRun, markCancel, projSig,
    bootRestore, startWatching, startResume,
    stopRunWatch() { stopWatching(); beatTimer(false); } });
}
