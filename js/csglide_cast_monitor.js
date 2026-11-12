import { api } from "../../scripts/api.js";
import { setCurrent } from "./bz_rack.js";
import { blankState } from "./csglide_cast_core.js";
import { createFilmMonitor } from "./csglide_film.js";
import { el } from "./csglide_ui_kit.js";
import { projectShots } from "./csglide_seg_projection.js";

/* ============================================================
 * 成片监视器 / 时间轴 / 渲染控制 / 渲染范围
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

/* 采样参数：叠在取景器底部右侧的一行小字，绝对定位不占布局。不依赖 image
   字段，逐帧图没到也能看数；未采样时整行隐藏，画面保持干净。 */
function buildLiveStats(host) {
  const bar = el("div", "gcast-stats");
  host.append(bar);

  const num = (v, digits) => {
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
  };
  const ms = (v) => {
    const n = v == null ? NaN : Number(v);
    if (!Number.isFinite(n)) return "—";
    return n >= 1000 ? (n / 1000).toFixed(2) + " s" : Math.round(n) + " ms";
  };
  api.addEventListener("minimax_h3_preview_override", (e) => {
    const d = e && e.detail;
    if (!d || d.node_id == null) return;
    // boundary-0 带完整 sigma 调度，是新一轮起点：收起上一轮数字，等第一步。
    if (Array.isArray(d.sigmas) && d.sigmas.length > 1) {
      bar.classList.remove("is-on");
      return;
    }
    if (d.sigma == null && d.delta == null && d.step_ms == null) return;
    bar.textContent = "σ " + num(d.sigma, 3) + " · Δ " + num(d.delta, 4)
      + " · " + ms(d.step_ms);
    bar.classList.add("is-on");
  });
  return bar;
}

export function installMonitor(ui) {
  /* ---- 成片监视器（吸收续接合成的预览窗） ----
     续接合成在图上拿不到本段解码画面（导演台 → KSampler → VAE Decode →
     导演台 会成环），所以物理上合不进导演台；合并落在面板这一层：导演台
     与续接合成共用同一个成片监视器组件，看的是同一份段落档案。

     片名 = 工程名（阶段 1 已把两者合一），所以这里直接读工程面板的那个名字，
     不另设输入框——两处打不一致就会各存各的档案，那是最难查的一类坑。 */
  const monWrap = el("div", "gcast-monitor");
  /* 时间轴外挂（v7 式 lanes 行）：分段轨 + 波形 + 播放头横贯整个节点宽度，
     独立于监视器宽度 —— 监视器在双栏左栏里再窄，时间轴也占满整行。
     监视器收起 / 拖出悬浮时这条轴照常可用。

     它是面板上唯一能一眼看完整部片子的地方，段一多就必须独占整行，不能跟
     监视器、设置卡挤在双栏里分宽度。所以给它单独一个头：标题 + 段数/总时长
     + 工程级操作按钮。 */
  const lanesWrap = el("div", "gcast-lanes");
  const lanesHd = el("div", "gcast-lanes-hd");
  const lanesTitle = el("span", "t", "全片总览");
  const lanesMeta = el("span", "mono", "—");
  /* 这一行的工具区：工程级操作（裁切 / 全部渲染 / 导出 / 工程菜单）。所有「动
    的是这部片子」的操作都归到这条轴上 —— 它们管的就是轴上这些段落，摆在这儿
    眼睛不用离开要改的东西。
    20261106：「＋ 接一段」已按用户要求撤掉（详见下方轴头工具条注释），段级
    增删改统一搬到「当前段上下文条」上，轴头不再有加段入口。
    注意：原来那组缩放按钮（−/＋/⤢）已经不放在这里了 —— 它们控制的是那条
     已撤下的旧时间轴（tl 仍留在内存但没挂进面板，见「两条时间轴合一」），点了
     只会空转。总览轴始终把所有段落按比例铺满整行（renderSegs 按 total_frames
     定宽），没有"缩放"这个概念，摆三个按不动的按钮只会让人以为面板坏了。 */
  const lanesTools = el("div", "tools");
  /* 运行时反馈条：落点在**面板最底部独占一行**（20261015 用户定）。
     来路：原先夹在轴头那一行里（「全片总览 · N 段」与四组按钮之间只剩很窄
     一格，一句话被收成省略号，等于白提示）；先搬到轴头正下方独占一行，用户
     看了说还是想让去最底下 —— 把落地行那句「文案来自文案台 · 第 N 段」换掉，
     那句只是复述一条已经接好的线，接没接看画布就知道，常驻一行白占地方。
     最底下吃满整行宽度、过长自动折行；平时 display:none 不占高度。 */
  const flashBar = el("div", "gcast-flash");
  lanesHd.append(lanesTitle, lanesMeta, lanesTools);
  lanesWrap.append(lanesHd);
  /* E1：当前段上下文条（段选择 / 重抽 / 接缝 / 主按钮）挂在全局命令行与
     段块轨之间；createFilmMonitor 随后把 band/foot 外挂到它后面。 */
  if (ui.ctxBar) lanesWrap.append(ui.ctxBar);
  ui.lastPickedClip = null;
  /* 片名 = 工程名（阶段 1 已把两者合一）。抽成一个函数：监视器的三个回调
     都要它，写三遍就会在某次改动后少改一处。 */
  const castName = () => {
    const p = ui.node.properties && ui.node.properties.gcast_project;
    return (p && p.name) || (ui.st.chain && ui.st.chain.name) || "";
  };
  /* ---- 轴上拖动排序 ----
     「前移 / 后移」两个菜单项已删（20261009）：一次只挪一位，十几段的片子要把
     第 12 段挪到第 2 位得右键十几次。改成在轴上拽着段块走（见 csglide_film.js
     的拖动排序），一次到位，也才是剪辑软件里"挪片段"的手势。

     顺序同时存在两处，必须一起改：
       · 段落档案的 chain.order —— 时间轴画的**就是它**（film_summary 走它）
       · 工程里的 p.shots —— 右栏那张「这一段」卡、渲染范围亮条、跳过 / 断链
         标记都按它的**下标**读
     只改一边，两边当场错位：轴上第 3 块对应的却是面板里的第 5 段，
     paintRunScope 会把亮条画到别的块上。而且这种错位不报错，只是"看着不对"，
     最难查。所以两边同改，且都按 clip id 对齐 —— id 是分段唯一的身份，
     位置才是那个本来就要变的量。 */
  async function reorderTo(ids) {
    const name = castName();
    if (!name) throw new Error("还没有片名");
    if (ui.run) throw new Error("正在渲染 —— 等这一轮跑完再改顺序");
    const p = ui.proj();
    /* 记住重排前的样子。顺序同时存在两处，前端先改、后端再落盘：后端失败
       的话前端已经变了，两边就错位 —— 轴上第 3 块对应面板第 5 段，而且这种
       错位不报错，最难查。所以先存快照，后端失败就原样还原（工程顺序回到
       拖动前；轴上段块本来就没真改过 left，只是 translate 跟手，失败时平移
       一撤就自然弹回旧位置，与还原后的工程重新对得上）。 */
    const before = { shots: p.shots.slice(), idx: p.idx };
    const byClip = new Map();
    p.shots.forEach((sh) => { if (sh.clip) byClip.set(sh.clip, sh); });
    /* 编辑目标跟着**那一段**走，而不是留在同一个下标上：重排之后下标换了
       意思，不跟着搬，"当前段"就跳到别的段上去了。 */
    const curShot = p.shots[p.idx] || null;
    /* 按档案给的 id 顺序重排。工程里还没登记进档案（没有 clip）的分段原样
       挪到末尾 —— 一段都不丢，只是排在后面。 */
    const head = ids.map((id) => byClip.get(id)).filter(Boolean);
    const tail = p.shots.filter((sh) => !(sh.clip && ids.includes(sh.clip)));
    p.shots = head.concat(tail);
    if (curShot) p.idx = Math.max(0, p.shots.indexOf(curShot));
    ui.commit();
    ui.render();
    try {
      const res = await api.fetchApi("/cglide/chain/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, order: ids,
          /* 只给留痕用：重排改的是整片顺序，后端推不出"拖的是哪一段"，
             把当前编辑段一起发过去，events 里才追得到。 */
          cid: (curShot && curShot.clip) || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      /* 回滚：把工程顺序还原，并重画面板，让"工程"和"档案"重新对齐旧顺序。 */
      p.shots = before.shots;
      p.idx = before.idx;
      ui.commit();
      ui.render();
      throw e;
    }
  }

  /* ---- 段身份：档案唯一真值 → 工程段投影（20261110 骨架重写）----------
     以前每轮按「回绑 / 幽灵 / 摘除 / 补建」四步增量改 p.shots，还要读自己
     上一轮写进段对象里的 clip。任何一轮产物少写一个字段，下一轮就认不出
     已有段、再补一批 —— 段数每刷一次轴往上涨（多人实测档案 4 段、工程
     266 段，渲染前预检因此拦下全部渲染）。
     现在改成纯计算：projectShots(档案, 现存段) 直接算出「按档案顺序、每
     cid 恰好一条」的完整列表，同样输入永远同样输出，物理上不可能膨胀。
     这里只负责装配：取真值、调投影、落盘、给中文提示。 */
  const seenCids = new Map();   /* 工程名 → Set(既往确认存在于档案的 cid) */
  function reconcileSegmentIdentity(rows) {
    const empty = { linked: 0, swept: 0, dropped: 0, created: 0 };
    const name = ui.castName();
    if (!name) return empty;
    const p = ui.proj();
    if (!p || !Array.isArray(p.shots)) return empty;
    const seen = seenCids.get(name) || new Set();
    const res = projectShots(rows, p.shots, name, seen,
      () => ui.detachChain(blankState()));
    /* 档案为空 / 清单明显未就绪：整轮不产出，宁可不动也不能误删。 */
    if (!res.trusted || !res.next) return empty;
    for (const r of rows || []) {
      const c = r && r.clip;
      if (c && c.id) seen.add(String(c.id));
    }
    seenCids.set(name, seen);

    const changed = res.next.length !== p.shots.length
      || res.next.some((sh, i) => sh !== p.shots[i]);
    if (!changed) return res.out;
    p.shots.length = 0;
    for (const sh of res.next) p.shots.push(sh);
    p.idx = p.shots.length
      ? Math.min(Math.max(0, +p.idx || 0), p.shots.length - 1) : -1;
    ui.commit();
    ui.paintSegTools();
    const bits = [];
    if (res.out.linked) bits.push(`回绑 ${res.out.linked} 段`);
    if (res.out.swept) bits.push(`清掉 ${res.out.swept} 个撞号幽灵段`);
    if (res.out.dropped) bits.push(`摘掉 ${res.out.dropped} 段（档案条目已删除）`);
    if (res.out.created) bits.push(`补建 ${res.out.created} 段（档案里有、工程里没有）`);
    if (bits.length)
      ui.lanesFlash("段身份对账：" + bits.join(" · ") + "　·　误删只能手动补回");
    return res.out;
  }


  /* ---- 段级四动作的唯一实现（20261106 抽出）----
     原来只有时间轴段块里那排悬停图标会调 onSegAction。现在那排按钮搬到了
     「当前段上下文条」（csglide_cast_settings.js），两处入口必须共用一份业务
     逻辑 —— 抽成 ui.segAction，createFilmMonitor 的 opts.onSegAction 与 ctxBar
     的四颗按钮都指向它。改动只落一处，不会出现两套按钮、两套下标换算。 */
  ui.segAction = (kind, c) => {
    const shots = ui.proj().shots || [];
    const cid = c && c.id;
    /* 上下文条直接给工程段下标（真值）；时间轴段块只认得 clip id，
       仍按 id 反查。两条入口共用这一份业务，不再各算一套下标。 */
    const j = (c && Number.isInteger(c.index) && c.index >= 0)
      ? c.index
      : (cid ? shots.findIndex((sh) => sh.clip === cid) : -1);
    if (kind === "skip") {
      /* 20261026：跳过 / 恢复 从右键搬到段块悬停工具条（那个 ○ 按钮）。
         20261106 起那排工具条整体搬到上下文条。只在档案里的孤儿段没有工程
         下标，没处落 off 标记 —— 先提示认领。 */
      if (j < 0) { ui.lanesFlash("这一段只在档案里，先双击它认领进工程再跳过"); return; }
      ui.toggleSkip(j);
    } else if (kind === "copy") {
      if (j < 0) { ui.lanesFlash("这一段只在档案里，先右键「认领」进工程再复制"); return; }
      /* 完整克隆（提示词/参考/画布/时长/参数全照抄）到末尾，20261012 起
         不再走"接一段（只继承班底、提示词被砍、参考还会被轮询清掉）"。 */
      void ui.duplicateShot(j);
    } else if (kind === "add") {
      if (j >= 0) void ui.insertShot(j);
    } else if (kind === "del") {
      if (j >= 0) { void ui.delShot(j); return; }
      if (cid) void ui.unregisterShot({ clip: cid }, true).then((d) => {
        if (d && d.removed) ui.lanesFlash("档案残留段已删（含磁盘文件）");
      });
    }
  };

  /* ✂ 按钮会由音频轴在挂载期间回调（选中轨变化），必须提前声明，
     否则 createFilmMonitor 还没返回就撞上 TDZ。 */
  let btnCut = null;
  const monitor = createFilmMonitor({
    title: "🎬 成片监视器",
    /* 段块内那排 absolute 图标在窄段上会被裁掉（20261106 用户实测）。导演台
       把段级动作统一放到上下文条，这里整组不创建；不传此开关的其他宿主
       （纯检视时间轴）保持原来的段内交互，共享组件行为不变。 */
    hideInlineSegActions: true,
    getName: castName,
    timelineHost: lanesWrap,
    /* 音频轴「补齐 N 段」走这一个建段入口：addShot 同一次调用写工程段 + 档案。
       音频轴不再自己 POST add_clip（那会只落档案，工程段永远是 1）。 */
    onAddShot: () => ui.addShot(false),
    /* 音频轴排段前的防呆：把「工程对象里的段数」交给它，跟档案段数比对。
       两边对不上就别再 addShot —— 否则会在一堆没绑档案的孤儿段后面继续加。 */
    getShotCount: () => ((ui.proj && ui.proj().shots) || []).length,
    /* 音频轴按音频重排段长后，把每段新帧数写齐面板预设（shot.state.length）。
       渲染登记时后端拿面板预设覆盖档案 frames；只改档案不改面板，下一次渲染
       就会把排好的时长静默改回去（20261013「拖成 10 秒又弹回 3.9 秒」）。 */
    syncShotFrames: (frames, rows) => {
      const p = ui.proj && ui.proj();
      if (!p || !Array.isArray(p.shots)) return;
      let dirty = false;
      for (let i = 0; i < Math.min(frames.length, rows.length); i++) {
        const s = p.shots.find((x) => x && x.clip === rows[i].id);
        if (s && s.state && s.state.length !== frames[i]) {
          s.state.length = frames[i];
          dirty = true;
        }
      }
      if (dirty) { ui.commit(); if (ui.render) ui.render(); }
    },
    /* 音频模式（有无主音轨）翻转时重渲染设置面板「时长」：它在逐段时长与
       「每段秒数·全片」之间切换（20261112 方案 B 合并）。 */
    onAudioModeChange: () => { if (ui.render) ui.render(); },
    /* 点中某段 → 把它设为三个节点共享的「当前段」。
       文案台与媒体架轮询读它，于是切段时两边自动跟着切 —— ComfyUI 没有
       跨节点事件机制，走后端这份档案是最小的代价（几十字节的 JSON）。 */
    onPick: (clip, viaUser) => {
      console.log("[联动] onPick 入口: clip=" + (clip && clip.id) + " viaUser=" + viaUser + " name=" + castName());
      ui.lastPickedClip = clip;
      ui.updateSegChip();
      /* 只有**用户亲手点/拖**的那一次才动"当前段"。
         refresh 也会替人选一段（最后一段有成片的那些），那是自动行为；让它也
         去写当前段，用户刚点的那一段过一会儿就被盖回去了。 */
      if (!viaUser) return;
      const name = castName();
      if (name && clip) {
        /* 网络写入失败要有说法：高亮/切换已经本地生效（乐观），档案那边
           写不进去时说一声，别让"点了没反应"从另一头再长出来。 */
        setCurrent(name, clip.id)
          .catch((e) => ui.lanesFlash?.(`切换当前段没能写进档案：${e && e.message ? e.message : e}`));
      }
      /* 面板跟着换段 —— 这一步原先没有，是"点了段、什么都没发生"的根因：
         轴上点第 3 段，只有轴自己知道（它内部换了选中的那一段），而面板右侧那张
         「这一段」设置卡、首尾帧卡、指挥条上的"第 N 段"、乃至「删除本段」按钮
         操作的都还是**工程里的 p.idx**——两套"当前段"互不相认，于是点完之后
         看起来只有那个紫环动了一下，别的纹丝不动；更糟的是这时点「删除本段」
         删掉的是上一段。
         现在时间轴是唯一的切段入口：点哪一段，面板就搬到哪一段（switchTo 里
         stash / 还原媒体架 / load / commit 全套都在）。
         档里那一段在工程里找不到对应分段时（多半是旧档案残留），既不能硬写
         p.idx 也不能装作没事 —— 说出来，让用户知道这一段只能在这条轴上换版本，
         在这儿改不了它的参数。 */
      if (!clip) return;
      const p = ui.proj();
      let j = -1;
      if (clip.id) j = p.shots.findIndex((sh) => sh.clip === clip.id);
      if (j < 0) j = (clip.index || 1) - 1;
      if (!p.shots[j]) {
        ui.lanesFlash(`第 ${clip.index} 段只在档案里 —— 右键它（或双击改名）即可认领进工程，之后就能就地编辑`);
        return;
      }
      if (j !== p.idx) ui.switchTo(j);
    },
    /* 轴上拖着段块改顺序（即原「前移 / 后移」两个菜单项的下场）。
       渲染中禁拖：顺序一变，正在跑的渲染链就和档案里新写的顺序对不上了 ——
       与其拖完再回滚，不如拖不动（并给出为什么）。 */
    canReorder: () => !ui.run,
    onReorder: (ids) => reorderTo(ids),
    /* 段级编辑入口。这两条原本挂在「工程分段条」上（双击改名 / 右键换色），
       第二条轴撤掉之后搬到这里 —— 时间轴只剩这一条，能看见这一段就必须能
       改这一段，否则「看」和「改」分家，用户得记着去别处改。
       下标换算：监视器的 clip.index 从 1 起，工程 shots 从 0 起。阶段 1 已
       把两者合一（工程名 = 片名，分段 = 段落），所以差 1。 */
    onRename: async (clip, hostEl) => {
      /* 孤儿段（只在档案里）双击改名 = 先认领回工程再就地改 —— 原来对不上
         工程下标就悄悄 return，用户看到的就是"双击没反应"。 */
      const p = ui.proj();
      let j = p.shots.findIndex((sh) => sh.clip === clip.id);
      if (j < 0 && clip.id) {
        const row = ui.monitor.clipRowOf?.(clip.id);
        if (row) await ui.claimShot(row);
        j = p.shots.findIndex((sh) => sh.clip === clip.id);
      }
      if (j >= 0) ui.renameShot(j, hostEl);
    },
    /* clip 这一行本身就是档案视图里的一段（带 id / take / takes），整条传进去：
       段级菜单要按它去拉这一段的版本清单，不必再拿下标去换一次 id。 */
    onSegMenu: (clip, e) => {
      try {
        ui.shotMenu((clip.index || 1) - 1, e.clientX, e.clientY, clip);
      } catch (err) {
        /* 菜单没弹出来必须给个说法，别又变回"点了没反应"。 */
        console.error("[H3 Studio] 右键菜单打开失败：", err);
        ui.lanesFlash("右键菜单打开失败：" + (err && err.message ? err.message : err));
      }
    },
    /* 拖边缘改时长。锁定撤掉后恒可拖。这个回调**必须留着并返回真**：
       film 里判的是 `opts.canResize && opts.canResize(c)`，完全不传等于
       "把手永远不出现"—— 那不是能拖，是拖不了。 */
    canResize: () => true,
    onResize: (clip, frames) => ui.applyFrames(clip.id, (clip.index || 1) - 1, frames),
    /* 空态引导卡的「＋ 接第一段」CTA（M4）：走的是 ui.addShot(false)。
       20261106 轴头「＋ 接一段」撤掉后，这是 addShot 仅剩的入口，别顺手删。 */
    onAddFirstShot: () => ui.addShot(false),
    onMode: (m) => {
      /* 收起 / 拖出后占位高度完全不同，交给 CSS 换档（固定高度是给取景器
         用的，收起时留 300px 空盒子就太傻了）。 */
      monWrap.classList.toggle("is-collapsed", m === "collapsed");
      monWrap.classList.toggle("is-float", m === "floating");
      /* 三态切换后面板内容高度变了，节点要跟着重排。
         延后一帧：此刻 DOM 还没重排完，量到的是旧高度。
         只增高、不缩回（fitNode(false)）：高度归用户所有，收起监视器留下的一点
         留白远好过每次换档都把用户亲手拖的高度抹掉。 */
      ui.node.setDirtyCanvas(true, true);
      requestAnimationFrame(() => { try { ui.fitNode(false); } catch { /* 忽略 */ } });
    },
    /* 段块画完的回调。宿主加在段块上的标记（渲染范围亮条 / 正在渲染脉冲 /
       断链虚线）每次都会被 paintSeg 的 className 整体重写抹掉；以前靠
       MutationObserver 盯子节点变动来补 —— 它只认"增删"，而点一下段、拖一下
       窗口这类重绘一个节点都不增删，补丁压根不触发，标记就此灰飞烟灭，
       表现就是"那些条子一会儿有一会儿没有"。
       改成由画的人喊一声：绘制归它，补标记归我们，两者在同一刻发生。 */
    onAfterSegs: (rows, changed) => {
      /* 标记/轴头/自愈每次都补：它们只遍历 1~3 个段块，成本可忽略；且渲染
         脉冲开始/结束时 film 账不变（changed=false），漏画脉冲会出大事。 */
      paintRunScope();
      paintLinkMarks();
      try { ui.updateLanesMeta && ui.updateLanesMeta(); } catch { /* 尚未装好 */ }
      /* 段身份只归一个裁判：按档案重算（回绑 + 撞号幽灵 + 已删条目）。
         只改工程副本，绝不补登记 / 删档案。 */
      reconcileSegmentIdentity(rows);
      /* 整画布标脏（LiteGraph 全节点重排，L3 卡顿源）只在段块真有增删/几何
         内容变化时做。后台 store 推送同一份账（changed=false）时，选中类、脉冲
         都是 classList 变化，浏览器直接合成，不需要重排（20261012 方案C）。 */
      if (changed !== false) {
        try { ui.node.setDirtyCanvas(true, true); } catch { /* 已销毁 */ }
      }
    },
    /* 接缝胶囊读取 / 设置「承接上一段多少帧」（段间过渡帧数）。真值在该段
       state.cont.frames（后端 csglide_cast.py 生成时读 cont.frames）。孤儿段先
       认领；contFramesOf 找不到段时返回 null，让组件回退到成片实际裁剪帧。
       20261029：后端改成「承接帧数 = 要不要接」的唯一开关，默认 0（独立成段）。
       所以这里**不再**在 frames 为 0 时补一个 22 的幻影默认值 —— 那会让菱形
       显示 22、执行侧一帧不接，比显示 0 更误导。 */
    contFramesOf: (clipId) => {
      const p = ui.proj();
      const j = p.shots.findIndex((s) => s.clip === clipId);
      if (j < 0) return null;
      /* 断链 = 这段一帧都不承接，显示 0（与后端一致）。不能只读 cont.frames：
         取消接续只写 transitions、不动面板窗口，读窗口会把 22 显示成"还接着"。 */
      const broken = !!(p.transitions && p.transitions[clipId]
        && p.transitions[clipId].type === "unlink");
      if (broken) return 0;
      return Math.max(0, Math.round(
        Number(p.shots[j].state && p.shots[j].state.cont && p.shots[j].state.cont.frames) || 0));
    },
    onContFrames: async (clipId, frames) => {
      let j = ui.proj().shots.findIndex((sh) => sh.clip === clipId);
      if (j < 0) {
        const row = ui.monitor.clipRowOf?.(clipId);
        if (row) {
          await ui.claimShot(row);
          j = ui.proj().shots.findIndex((sh) => sh.clip === clipId);
        }
      }
      if (j < 0) {
        ui.lanesFlash("这一段认领失败 —— 请右键它重试");
        return;
      }
      const p = ui.proj();
      const own = (p.shots[j].state = p.shots[j].state || {});
      own.cont = own.cont || {};
      own.cont.frames = Math.max(0, Math.min(4096, Math.round(Number(frames) || 0)));
      own.cont.mode = own.cont.mode || "latent";
      if (Number(p.idx) === j) ui.st.cont = { ...own.cont };
      ui.commit();
      ui.paintSegTools();
      /* 改了承接帧数就该自己重画接缝胶囊：以前重画散在各调用方，
         「恢复接续」按钮这条路径漏了 —— 帧数写回 22、图标却还停在 0。 */
      try { ui.monitor?.repaintSeams?.(); } catch { /* 监视器尚未就绪 */ }
      if (typeof ui.paintLinkMarks === "function") ui.paintLinkMarks();
    },
    /* 接缝成片转场（M3）：读 / 写都落在工作流 properties 的独立映射，
       不污染 shots/state、不需后端新端点，随工作流保存、刷新不丢。 */
    getTransition: (clipId) => {
      const p = ui.node.properties && ui.node.properties.gcast_project;
      const m = p && p.transitions;
      return (m && clipId && m[clipId]) || null;
    },
    onTransition: (clipId, t) => ui.applyTransition(clipId, t),
    /* 菱形 / 段块接缝点击：选中该段并定位、高亮右侧卡接缝组（不弹浮层）。 */
    onFocusSeam: (segIndex1based, clipId) => ui.focusSeamPanel(segIndex1based, clipId),
    /* film.js 传来的 row.index 是 1based 段号；openSeamWindow/readSeamState 按
       0based 工程下标取段（targetIndex==null 用 p.idx），这里必须 −1，否则接缝
       段错位 / 末接缝越界返回 null（"还没登记上轴"）、帧数显示 0。 */
    onSeamWindow: (segIndex1based, ev) => ui.openSeamWindow(segIndex1based - 1, ev),
    /* 段级动作的唯一实现已抽到 ui.segAction（见上）。导演台隐藏了段块内那排
       按钮，这里留着接口只是为了共享组件的其他宿主仍能用原来的段内交互。 */
    onSegAction: (kind, c) => ui.segAction(kind, c),
    /* ✂ 只切选中音轨的音频块（20261109）：段级分割整体下架，切点用
       全片连播帧，由音频轴落库、后端重切驱动。 */
    onAudioCutAt: (hit) => {
      if (ui.run) return;
      const m = ui.monitor;
      const r = m && m.cutAudioAt ? m.cutAudioAt(hit)
        : { ok: false, 提示: "时间轴还没就绪" };
      if (r && r.提示) ui.lanesFlash(r.提示);
    },
    /* 选中轨变化 → ✂ 按钮可用态。宿主只认这一条回调，不自己猜状态。 */
    onAudioSelectChange: (has) => {
      if (!btnCut) return;
      btnCut.disabled = !has;
      btnCut.style.opacity = has ? "" : ".45";
      btnCut.style.cursor = has ? "" : "not-allowed";
      btnCut.title = has
        ? "裁切选中音轨：在段块上想切开的位置点一下（只切音频，不拆段）"
        : "先点一下要裁剪的音轨，选中后才能裁切";
      if (!has && ui.cutMode) setCutMode(false);
    },
  });
  /* —— 阶段 3 / 断链音频修复：接缝改完按新净长重切驱动音频 ——
     「取消接续」会让本段净长从「全长 - trim」变回全长，但 bzsa.driver 里的
     切片还停在旧边界，生成时尾部就被循环补齐（音频重复 / 结尾跳回）。
     连续点「去掉全部接续」会连发 N 次，做 600ms 防抖只发一次；胶囊点完**不等它**，
     点起来不卡 —— 但渲染前由 flushDriverReslice 收口（见下），不会拿旧切片出片。
     重切失败只给提示、绝不回滚已写入的接缝（回滚是 transitions 同步失败那条路的事）。 */
  /* 20261111 方案 B：后端单一事务缩完末段后，把回读的真实帧数写齐面板预设。
     与音频轴 syncFramesFromSlice 是同一件事，但导演台这里没有 clipsOf()，
     所以后端在「段序」里带上与「帧数」同序的 cid，按 clip 直接认段，不靠
     下标猜。只改档案不改面板 → 下一次渲染登记会拿旧 shot.state.length 把
     档案静默改回去（20261109 的 56↔243 事故原样复现）。 */
  ui.syncShrinkFrames = (pre) => {
    const frames = pre && Array.isArray(pre["帧数"]) ? pre["帧数"] : null;
    if (!frames || !frames.length || !Number(pre["已缩短"])) return false;
    const p = ui.proj && ui.proj();
    if (!p || !Array.isArray(p.shots)) return false;
    const cids = Array.isArray(pre["段序"]) ? pre["段序"] : [];
    let dirty = false;
    for (let i = 0; i < frames.length; i++) {
      const s = cids[i]
        ? p.shots.find((x) => x && x.clip === cids[i])
        : p.shots[i];
      if (s && s.state && s.state.length !== frames[i]) {
        s.state.length = frames[i];
        dirty = true;
      }
    }
    if (dirty) { ui.commit(); if (ui.render) ui.render(); }
    return dirty;
  };

  let resliceTimer = 0;
  let resliceInflight = null;   /* 在途重切的 Promise（空闲时为 null）——收口要等它 */
  let resliceDirty = false;     /* 有接缝已写入、但还没重切过音频 */
  /* 重切的唯一执行体：串行，同一时刻只允许一条在途。失败只给可见提示，
     绝不抛 —— 收口（flushDriverReslice）靠 await 它，不能因一次失败把渲染拦下。 */
  function runDriverReslice() {
    if (resliceInflight) return resliceInflight;
    resliceDirty = false;
    resliceInflight = (async () => {
      try {
        const res = await api.fetchApi("/cglide/chain/reslice_drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          /* 取消续接会让 trim 派生归零 → 净长变长 → 原音源不够铺。必须走
             与拖音频同一套单一事务：先缩末段 frames，再重切一次音频。 */
          body: JSON.stringify({ name: castName(), shrink_frames: 1 }),
        });
        const d = await res.json().catch(() => ({}));
        if (d.done) {
          ui.syncShrinkFrames?.(d["末段缩短"]);
          console.log("[H3 导演台] " + (d.提示 || "驱动音频已重切"));
        } else if (d.提示 && !d.skip) {
          ui.lanesFlash?.(d.提示);
        }
      } catch (e) {
        console.warn("[H3 导演台] 驱动音频重切请求失败：", e);
        ui.lanesFlash?.("驱动音频没重切成功 —— 声音可能还按旧段长，去时间轴重新拖一次音频即可");
      } finally { resliceInflight = null; }
    })();
    return resliceInflight;
  }
  function scheduleDriverReslice() {
    resliceDirty = true;
    window.clearTimeout(resliceTimer);
    resliceTimer = window.setTimeout(() => {
      resliceTimer = 0;
      runDriverReslice();
    }, 600);
  }
  /* 窗口 1 修复（20261111）：渲染前把驱动音频重切收口。
     「取消接续」的重切是 600ms 防抖、且胶囊点完不等它 —— 紧接着点渲染就会
     拿旧切片出片（声画错位）。这里把待发的防抖立即触发、在途的等完，循环到
     空闲为止，保证排队那一刻切片 = 最新接缝。本身永不抛（失败已在执行体内
     给过可见提示），所以不会拦下用户手点的运行。两条提交路径都要调它：
     画布单次运行在 bz_queue_align.js，「全部渲染」批跑在 csglide_cast_run.js
     （批跑绕过 queue 包装，那条 flush 不生效，必须自己收口一次）。 */
  ui.flushDriverReslice = async () => {
    for (let guard = 0; guard < 50; guard++) {
      if (resliceTimer) {
        window.clearTimeout(resliceTimer);
        resliceTimer = 0;
        await runDriverReslice();
        continue;
      }
      if (resliceInflight) { await resliceInflight; continue; }
      if (resliceDirty) { await runDriverReslice(); continue; }
      break;
    }
  };
  /* 断链/接上的唯一实现（接缝卡片、右键菜单、悬停 ⛓ 都走这里）：
     1) 写工程映射 p.transitions（随工作流落盘）；
     2) 同步后端 /transitions —— 播放与导出成片读它，缺了这步右键断开
        就只改时间轴显示、导出仍连播（旧 toggleLink 写 sh.link 的残缺 bug）；
     3) 防抖重切驱动音频，让声音跟着新的段长走。 */
  ui.applyTransition = async (clipId, t) => {
    if (!clipId) return;
    const p = ui.proj();
    if (!p.transitions) p.transitions = {};
    /* 窗口 2 修复（20261111）：先快照旧值。后端同步失败就回滚到它 ——
       时间轴绝不能显示一个后端没接受的状态，否则「取消接续」屏幕上独立成段、
       后端却仍按续接生成（显示 ≠ 真值）。 */
    const had = Object.prototype.hasOwnProperty.call(p.transitions, clipId);
    const prev = had ? p.transitions[clipId] : undefined;
    if (!t || t.type === "cut") delete p.transitions[clipId];
    else p.transitions[clipId] = {
      type: t.type,
      overlap: Math.max(0, Math.round(Number(t.overlap) || 0)),
    };
    /* 本地状态一改就重画，不押在后端往返成功上 —— 否则一次网络失败就表现为
       「点了取消接续 / 恢复接续，胶囊没反应」。断链只改 transitions、不改
       pins，局部重画即可（全量 refresh 会拉档案重建段块，是胶囊卡顿主因）。
       回滚时复用同一套重画，保证退回后胶囊也是旧状态。 */
    const repaint = () => {
      try { ui.node.setDirtyCanvas(true, true); } catch { /* 已销毁 */ }
      if (typeof ui.paintLinkMarks === "function") ui.paintLinkMarks();
      try { ui.paintUnlinkAllBtn && ui.paintUnlinkAllBtn(); } catch { /* 尚未装载 */ }
      try { ui.monitor?.repaintSeams?.(); } catch { /* 监视器尚未就绪 */ }
    };
    repaint();
    /* 同步断链状态到后端档案（播放 / 导出读取）；失败回滚本地、给可见提示 */
    try {
      const res = await api.fetchApi("/cglide/chain/transitions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: castName(), id: clipId,
          type: (t && t.type) || "cut",
          overlap: Math.max(0, Math.round(Number(t && t.overlap) || 0)),
        }),
      });
      /* fetchApi 对 4xx/5xx 也 resolve（fetch 只在网络断时抛）—— 缺片名 → 400
         这种必须当失败回滚，不能当成成功还去调度重切。 */
      if (res && res.ok === false) throw new Error("HTTP " + res.status);
      scheduleDriverReslice();
    } catch (e) {
      if (had) p.transitions[clipId] = prev;
      else delete p.transitions[clipId];
      repaint();
      console.warn("[H3 Studio] 转场同步后端失败，已回滚本地状态：", e);
      ui.lanesFlash?.("接续改动没写进档案，已恢复原状 —— 请确认后端在运行，再点一次");
    }
  };
  monWrap.append(monitor.root);
  /* ---- 内置轻量动画预览（取代画布上的 MiniMaxH3PreviewOverride 节点）----
     导演台后端在采样期间广播 "minimax_h3_preview_override"，image 是 base64
     animated WebP（L2RGB 时间切片，多帧）；初始噪声帧仍是单张 JPEG。
     独立 img 层盖在取景器上，不抢成片 video/img；<img> 原生按 WebP 内嵌的
     帧延时与 loop=0 循环播放，无需 <video> 层。整轮结束由 paintRun 收尾
     分支调 ui.clearLive() 撤掉，恢复成片画面。 */
  const liveImg = el("img", "gcast-live-frame");
  liveImg.alt = "";
  /* 源节点那条路线的产物是 MP4：<video> 自己管时间轴，再用 playbackRate 把
     「片段时长 ÷ 段真实秒数」的偏差抹平 —— 比手算 WebP 每帧停留更稳，且
     NVENC 编码只要 WebP 的 1/4、期间释放 GIL。两元素同 class，CSS 共用。 */
  const liveVideo = el("video", "gcast-live-frame");
  liveVideo.muted = true;
  liveVideo.loop = true;
  liveVideo.playsInline = true;
  /* 不设 autoplay：只在收到预览帧后由 applyRate 显式 play，
     否则 DOM 重建会自己播，成为采样期媒体自动播放的源头。 */
  liveVideo.preload = "auto";
  liveVideo.setAttribute("muted", "");
  liveVideo.setAttribute("playsinline", "");
  const liveView = monitor.root.querySelector(".bzf-view");
  (liveView || monWrap).append(liveImg, liveVideo);
  const statsBar = buildLiveStats(liveView || monWrap);
  let liveUrl = null;
  const stopLiveVideo = () => {
    try { liveVideo.pause(); } catch { /* 尚未加载 */ }
    liveVideo.removeAttribute("src");
    try { liveVideo.load(); } catch { /* 空源时部分内核会抛 */ }
  };
  const clearLive = () => {
    liveImg.classList.remove("is-on");
    liveImg.removeAttribute("src");
    liveVideo.classList.remove("is-on");
    stopLiveVideo();
    if (liveUrl) { try { URL.revokeObjectURL(liveUrl); } catch { /* 已回收 */ } liveUrl = null; }
  };
  const b64ToBlob = (b64, mime) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || "image/jpeg" });
  };
  let liveLogged = false;
  const onH3Preview = (e) => {
    const d = e && e.detail;
    if (!d || !d.image) return;
    /* 三条产物都接：MP4（NVENC 动画，走 <video> + playbackRate）、
       animated WebP（NVENC 不可用时的兜底动画，走 <img>）、JPEG（初始噪声帧）。 */
    const mime = d.mime || "image/jpeg";
    const isMp4 = mime === "video/mp4";
    if (!isMp4 && mime !== "image/jpeg" && mime !== "image/webp") return;
    /* 首帧只报一次：真机上用来区分「帧没到」与「帧到了但看不见」。 */
    if (!liveLogged) {
      liveLogged = true;
      console.log("[班长] 监视器收到首帧内置动画预览 %s×%s %s（step %s/%s）",
        d.w, d.h, mime, d.step, d.total);
    }
    try {
      /* refresh 重建 DOM 时可能把独立预览层摘掉：每帧自愈重挂，
         这样时间轴正常刷新与逐帧预览可以共存，互不牺牲。 */
      const host = monitor.root.querySelector(".bzf-view") || monWrap;
      const layer = isMp4 ? liveVideo : liveImg;
      const other = isMp4 ? liveImg : liveVideo;
      if (!layer.isConnected) host.appendChild(layer);
      if (!liveImg.isConnected) host.appendChild(liveImg);
      if (!liveVideo.isConnected) host.appendChild(liveVideo);
      const url = URL.createObjectURL(b64ToBlob(d.image, mime));
      const prev = liveUrl;
      liveUrl = url;
      other.classList.remove("is-on");
      if (other === liveVideo) stopLiveVideo(); else liveImg.removeAttribute("src");
      if (isMp4) {
        const rate = Number(d.rate);
        const applyRate = () => {
          if (Number.isFinite(rate) && rate > 0) {
            try { liveVideo.playbackRate = rate; } catch { /* 内核不支持就按原速 */ }
          }
          const p = liveVideo.play();
          if (p && p.catch) p.catch(() => { /* 未手势自动播放被拦：首帧静帧仍在 */ });
        };
        liveVideo.onloadedmetadata = applyRate;
        liveVideo.src = url;
        applyRate();
      } else {
        liveImg.src = url;
      }
      layer.classList.add("is-on");
      if (prev) setTimeout(() => { try { URL.revokeObjectURL(prev); } catch { /* 已回收 */ } }, 0);
    } catch (err) {
      console.warn("[H3 Studio] 逐帧预览渲染失败：", err);
    }
  };
  api.addEventListener("minimax_h3_preview_override", onH3Preview);
  Object.assign(ui, { onH3Preview, clearLive });
  /* 监视器在左、设置卡在右（v7 式双栏）。monWrap 在此处声明完成之后才挂进
     studioRow —— 之前会撞 TDZ。 */
  /* 顶部行：监视器（左）+ 参数卡（右），两栏顶对齐。参数卡内容多（首尾帧卡
     展开）时整行自然撑高、把下方全宽时间轴往下推，全貌直接露出。 */
  ui.studioRow.append(monWrap, ui.rightCol);


  /* ---- 两条时间轴合一（真融合，不是藏起来）----
     分段与段落从阶段 1 起就是同一回事（工程名 = 片名，分段 = 段落）。摆两条
     时间轴画同一批段落，只会让人不知道该看哪条 —— 但旧条上那些能力（增删、
     排序、改名、换色、跳过、断链）又不能丢。

     所以做的是**迁移**而不是**折叠**：把旧条上的段落级能力全部搬到监视器
     那条轴上（双击改名 / 右键段操作菜单 / 工具栏增删按钮），然后把旧条这条
     轴整个撤掉。能力一个不少，时间轴只剩一条。

     旧条当时是整块留在内存里的（没挂进面板，但绘制逻辑还在跑）。后来这块
     已整段删除 —— 见「阶段 0 死代码清理」：它早退到只剩 paintSegTools() 一
     条路，等于白跑一趟计算还占了五百行。 */
  /* 段落与工程级操作挂到总览轴那一行，不挂监视器工具栏：它们动的是这条轴上
     的段落，不是那块画面。「＋ / 🗑 / 导出」原先在监视器上，等于把"改片子"和
     "看片子"两件事混在同一个工具栏里。 */
  const laneBtn = (label, cls, title, onClick) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onClick(e); };
    lanesTools.append(b);
    return b;
  };
  const tsep = () => {
    const s = el("div", "tsep");
    lanesTools.append(s);
    return s;
  };

  /* ===== 轴头工具条：按工作流成组（20261011 重构 / 20261106 删接段）=====
     [✂裁切] │ [▶全部渲染] [⬇导出成片] │ [工程▾]
    同组动作相邻、组间竖分隔；主色只给「全部渲染」一颗。
    段级操作（跳过 / 复制 / 插段 / 删除 / 断链接链）不进这一排 —— 20261106 起
    统一在「当前段上下文条」上（csglide_cast_settings.js 的 .gcast-ctx-segacts）。

    20261106 用户定：撤掉轴头「＋ 接一段」。它曾是 addShot(false)（在末尾接一段、
    **继承当前媒体架素材**）在工程已有段时的唯一入口。撤掉后：
      · 零段工程 → 成片监视器空态引导卡的「＋ 接第一段」CTA（onAddFirstShot）；
      · 已有段要加段 → 上下文条「＋ 在此后插一段」（insertShot，会清空参考素材，
        在最后一段上点约等于末尾加段，但语义与 addShot 不同，别混用）。
    ui.addShot 本身保留 —— 空态 CTA 还在用它。 */

  /* —— 编辑组：只剩裁切剃刀 —— */
  /* —— 裁切剃刀（20261014）：剪辑软件式"点哪切哪" ——
     点一下进裁切模式（时间轴鼠标变剃刀、出现吸附竖线），在段块上点一下即切
     两段；再点一次该按钮或按 Esc 退出；开始渲染自动退出。 */
  function setCutMode(on) {
    on = !!on && !ui.run;
    if (on && !(ui.monitor && ui.monitor.hasAudioTrack && ui.monitor.hasAudioTrack())) {
      ui.lanesFlash("先点一下要裁剪的音轨，选中后才能裁切");
      return;
    }
    if (ui.cutMode === on) return;
    ui.cutMode = on;
    btnCut.classList.toggle("active", on);
    btnCut.textContent = on ? "✂ 裁切中" : "✂ 裁切";
    btnCut.title = on
      ? "裁切模式已开：在段块上想切开的位置点一下，只切选中音轨的音频；再点本按钮或按 Esc 退出"
      : "裁切选中音轨：点一下进入模式，再在段块上点想切开的位置（不拆段）";
    try { ui.monitor && ui.monitor.setCutMode && ui.monitor.setCutMode(on); }
    catch (e) { console.warn("[H3 Studio] 裁切模式切换失败：", e); }
    if (on) ui.lanesFlash("裁切模式：在段块上点一下，切开选中音轨的音频；Esc 退出");
  }
  ui.setCutMode = setCutMode;
  btnCut = laneBtn("✂ 裁切", "gcast-btn gcast-cut-btn",
    "先点一下要裁剪的音轨，选中后才能裁切",
    () => setCutMode(!ui.cutMode));
  btnCut.disabled = true;
  btnCut.style.opacity = ".45";
  btnCut.style.cursor = "not-allowed";
  /* Esc 退出裁切（捕获：避免画布快捷键同时响应）。 */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui.cutMode) { e.stopPropagation(); setCutMode(false); }
  }, true);
  /* 20261026：撤销按钮 + Ctrl+Alt+Z/Ctrl+Alt+Shift+Z 快捷键整块删除。
     连带删掉的：paintUndoBtns、onUndoAltKey、castActive/onCastPointer/
     onCastFocus（这三个只服务撤销的"鼠标在不在导演台里"判定）、
     ui.undoKeyTeardown。原因与代价见 csglide_cast_shots.js 顶部说明。
     注意：裸 Ctrl+Z 仍是 ComfyUI 画布撤销（会整张工作流回滚），导演台不再
     提供任何撤销快捷键 —— 这是明确的取舍，不是遗漏。 */

  tsep();

  /* —— 时间轴阶段互斥（20261111 阶段 2）——
     一采(s1) / 二采(s2) 是**整片级**开关，写的是 chain.stage。后端所有读者
     （📤 段落调取 / 整片潜空间拼接 / 承接窗口 / 钉帧 / 收片）一律按它取档，
     前端不缓存第二份阶段真值。s1 画布 576×320、s2 画布 864×480，逐段混搭
     必然让整片潜空间拼接中止，所以这两颗必须严格互斥。
     Q8=A：只切档案阶段 + 中文提示，绝不自动改 Cast 面板宽高。 */
  const stageBtns = {};
  const paintStage = (s) => {
    const cur = s === "s2" ? "s2" : "s1";
    Object.keys(stageBtns).forEach((k) => {
      stageBtns[k].classList.toggle("active", k === cur);
      stageBtns[k].setAttribute("aria-pressed", k === cur ? "true" : "false");
    });
    ui.stage = cur;
    /* 变体钮只在二采出现：一采没有「三采成品」这份文件，摆着是噪音。
       用 ui.btnVariant 守卫而非直接引用 const btnVariant —— paintStage 定义在
       btnVariant 之前，守卫让显隐与定义顺序解耦，syncStage 异步回灌时也安全。 */
    if (ui.btnVariant) ui.btnVariant.style.display = cur === "s2" ? "" : "none";
  };
  ui.paintStage = paintStage;
  /* 初始化从档案读真实阶段，不能默认写死 s1 —— 否则 F5 之后按钮亮「一采」、
     后端却在按「二采」取档，属于「看着对、其实错」最难查的一类。 */
  async function syncStage() {
    const name = castName();
    if (!name) { paintStage("s1"); paintVariant("raw"); return; }
    try {
      const res = await api.fetchApi(
        "/cglide/chain/summary?name=" + encodeURIComponent(name));
      const d = await res.json().catch(() => ({}));
      const okState = res.ok && !d.error;
      paintStage(okState ? d.stage : "s1");
      paintVariant(okState ? d.variant : "raw");
    } catch (e) { paintStage("s1"); paintVariant("raw"); }
  }
  ui.syncStage = syncStage;   /* 切换工程后由工程同步块调用，保持按钮与档案一致 */
  async function setStage(s, btn) {
    if (ui.run) { ui.lanesFlash("正在渲染 —— 跑完这一轮再切阶段"); return; }
    const name = castName();
    if (!name) { ui.lanesFlash("还没有片名 —— 先在指挥条的工程名上填一个"); return; }
    if (btn) btn.disabled = true;
    try {
      const res = await api.fetchApi("/cglide/chain/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stage: s }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      paintStage(d.stage || s);
      ui.lanesFlash(d.提示 || ("已切到「" + (s === "s2" ? "二采" : "一采") + "」"));
    } catch (err) {
      ui.lanesFlash("切阶段没成：" + (err.message || err)
        + " —— 时间轴阶段保持原样");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  ui.setStage = setStage;
  stageBtns.s1 = laneBtn("一采", "gcast-btn gcast-stage-btn",
    "时间轴切到一采（s1）：续接档 .cont.safetensors，画布 576×320",
    () => setStage("s1", stageBtns.s1));
  stageBtns.s2 = laneBtn("二采", "gcast-btn gcast-stage-btn",
    "时间轴切到二采（s2）：续接档 .s2.cont.safetensors，画布 864×480",
    () => setStage("s2", stageBtns.s2));

  /* —— 成片变体小切换（阶段 C / Q7=C）——
     二采有两份成片：二采成片(raw) 与三采最终成品(final)，**默认 raw**。
     20261111 用户纠正：切「二采」当然该用二采成片，三采成品只是另一份可选，
     绝不默认抢占。放在阶段组里、紧挨导出组：它和「一采/二采」是同一件事的
     两个维度；
     paintVariant 也必须在 syncStage() 发起前定义好（const 有 TDZ）。
     状态写进档案（整片级），时间轴 / 预览 / 导出都由后端 film_pick 跟随。 */
  const btnVariant = el("button", "gcast-btn gcast-stage-btn", "🎞 用三采成品");
  btnVariant.type = "button";
  btnVariant.title = "二采默认用「二采成片」；点一下改用「三采最终成品」，"
    + "再点一下切回（不重新渲染，只换拼片用的那份文件）";
  const paintVariant = (v) => {
    const useFinal = v === "final";
    btnVariant.classList.toggle("active", useFinal);
    btnVariant.textContent = useFinal ? "🎞 已用三采成品" : "🎞 用三采成品";
    btnVariant.setAttribute("aria-pressed", useFinal ? "true" : "false");
    ui.filmVariant = useFinal ? "final" : "raw";
  };
  ui.paintVariant = paintVariant;
  async function setFilmVariant(v) {
    if (ui.run) { ui.lanesFlash("正在渲染 —— 跑完这一轮再换成片"); return; }
    const name = castName();
    if (!name) { ui.lanesFlash("还没有片名 —— 先在指挥条的工程名上填一个"); return; }
    btnVariant.disabled = true;
    try {
      const res = await api.fetchApi("/cglide/chain/film_variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, variant: v }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      paintVariant(d.variant || v);
      ui.lanesFlash(d.提示
        || (v === "final" ? "已改用「三采最终成品」" : "已改回「二采成片」"));
    } catch (err) {
      ui.lanesFlash("换成片没成功：" + (err.message || err)
        + " —— 当前成片保持原样");
    } finally {
      btnVariant.disabled = false;
    }
  }
  ui.setFilmVariant = setFilmVariant;
  btnVariant.onclick = (e) => {
    e.stopPropagation();
    void setFilmVariant(ui.filmVariant === "raw" ? "final" : "raw");
  };
  ui.btnVariant = btnVariant;

  /* 阶段分段控件（20261112 用户定：第 2 条合并）——
     一采/二采 + 成片变体三颗收进一个连通外壳，读作「一个控件」。laneBtn 已把
     s1/s2 append 进 lanesTools，这里 append 把它们连同 btnVariant 一起 reparent
     进 stageSeg（DOM append 移动节点、不复制），外壳落在原变体钮的位置（阶段组
     tsep 与渲染组 tsep 之间）。变体钮显隐由 paintStage 按阶段控制（只在二采出现）；
     默认 raw、手动切、互斥、不自动改宽高——20261111 的决定一条都不碰。 */
  const stageSeg = el("div", "gcast-stage-seg");
  stageSeg.append(stageBtns.s1, stageBtns.s2, btnVariant);
  lanesTools.append(stageSeg);

  /* 20261111 用户定：「删除联动互斥器按钮和其代码，我还是去节点上手动切换」。
     阶段 3 的联动按钮、localStorage 状态、前端联动标志整套删除。
     轴头阶段组只留一采/二采 + 成片变体两件真数据。 */

  paintVariant("raw");
  paintStage("s1");
  void syncStage();
  tsep();

  /* —— 生成 / 交付组 ——
     渲染（重新生成画面）与导出（只拼接、不生成）是一前一后两步，挨在一起。 */
  const btnRunAll = el("button", "gcast-btn run", "▶ 全部渲染");
  btnRunAll.type = "button";
  btnRunAll.title = "依次渲染工程里的每一段（续写模式，渲染整个工程）";
  btnRunAll.onclick = (e) => {
    e.stopPropagation();
    ui.renderAll("continue", "all");
  };
  lanesTools.append(btnRunAll);

  const btnSaveFilm = el("button", "gcast-btn gcast-export-btn", "⬇ 导出成片");
  btnSaveFilm.type = "button";
  btnSaveFilm.title = "把时间轴上所有段拼成一条完整视频存进档案目录"
    + "（连接处自动裁掉承接重叠，与时间轴总长一致）";
  btnSaveFilm.onclick = (e) => {
    e.stopPropagation();
    void ui.saveFilmMerged(btnSaveFilm);
  };
  lanesTools.append(btnSaveFilm);

  const btnPushFilm = el("button", "gcast-btn gcast-export-btn", "🎬 推送整片");
  btnPushFilm.type = "button";
  btnPushFilm.title = "不重跑渲染，把时间轴上的整片直接送到「整片」口连的视频合并节点"
    + "（只加载模型、不采样；视频合并直接采用，不重新编码）";
  btnPushFilm.onclick = (e) => {
    e.stopPropagation();
    void ui.pushFilm(btnPushFilm);
  };
  lanesTools.append(btnPushFilm);

  /* 「整片潜空间」推送（20261102 用户定）：原先它是设置面板高级区里的一个
     勾选框，勾着忘了取消 → 平时每次渲染都白拼一条整片 latent；忘了勾 → 下游
     拿到空线报错。改成和「推送整片」完全同构的**一次性按钮**：点一下才开、
     排完立刻关。紧挨着「推送整片」放，因为它们是同一件事的两个出口
     （一个发 mp4、一个发 latent）。 */
  const btnPushFilmLatent = el("button", "gcast-btn gcast-export-btn", "🧬 推送整片潜空间");
  btnPushFilmLatent.type = "button";
  btnPushFilmLatent.title = "把所有段拼成一条完整潜空间，从「整片潜空间」口送给下游"
    + "（二采 / 时间分块重绘；会跑一次导演台读档案、但**不采样**）";
  btnPushFilmLatent.onclick = (e) => {
    e.stopPropagation();
    void ui.pushFilmLatent(btnPushFilmLatent);
  };
  lanesTools.append(btnPushFilmLatent);

  /* 历史旧工程切换（20261013 用户定）：点开档案目录里的旧工程，一键切回；
     不是操作记录，是 output/h3_chain 下的工程档案。菜单见 csglide_cast_history.js。 */
  const btnHistory = el("button", "gcast-btn", "🕘 历史 ▾");
  btnHistory.type = "button";
  btnHistory.title = "切换到以前的旧工程（档案目录里的整部工程，不是操作记录）";
  btnHistory.onclick = (e) => {
    e.stopPropagation();
    if (ui.openHistoryMenu) ui.openHistoryMenu(btnHistory);
  };
  lanesTools.append(btnHistory);
  tsep();

  /* —— 历史组已删（20261012 用户定）：轴头上不再放撤销 / 重做 / 历史 ▾。
     20261026：撤销 / 重做**彻底删除**，连快捷键也不再保留（见 shots.js 顶部说明）。
     裸 Ctrl+Z 仍是画布撤销，与导演台无关。 */

  /* —— 工程组已删（20261102 用户定）：轴头不再挂「工程 ▾」按钮。 —— */

  /* 渲染状态。声明位置刻意靠前：paintRenderRow() 读 run，而 render() →
     paintSegTools() 在 buildUI 还没跑到后半段时就会调用它。 */
  ui.run = null;                 /* null when idle; the run's own state when not */
  ui.runBox = null;              /* the overlay, so it can be torn down */

  /* 20261107：上一轮渲染异常结束 / 刷新恢复后 ui.run 可能残留非空，把整排
     按钮永久置灰。真正在渲染时必然有跟随浮层或有在途 prompt；两者都没有、
     且已过了刚开跑的保护窗口，就视为残留，不算「渲染中」。 */
  function isReallyRendering() {
    if (!ui.run) return false;
    if (ui.runBox || ui.run.pid) return true;
    const started = Number(ui.run.startedAt || 0);
    return started > 0 && (Date.now() - started) < 20000;
  }
  ui.isReallyRendering = isReallyRendering;

  /* 可用状态：工程里没分段、或正在渲染时禁用。跟随段操作按钮一起刷新，
     所以挂在 paintSegTools() 里 —— 任何一次时间轴重绘都会带上它。 */
  function paintRenderRow() {
    const n = ui.proj().shots.length;
    const busy = isReallyRendering();
    /* 渲染一开就把裁切剃刀收起来 —— 段块在跑，不能再切。 */
    if (busy && ui.cutMode) { try { setCutMode(false); } catch (e) { /* 尚未就绪 */ } }
    btnRunAll.disabled = !n || busy;
    btnRunAll.title = !n ? "请先添加一些分段"
      : `按顺序排队渲染全部 ${n} 个分段（续写模式：每段喂给下一段当引导，`
        + "最后得到的就是完整成片）。";
    /* 导出成片跟着禁：渲染中成片在变，拼到一半的片子不该被存；正在拼片
       时也别让人再点一次（dataset.busy 由 saveFilmMerged 自己挂牌）。 */
    btnSaveFilm.disabled = !n || busy || btnSaveFilm.dataset.busy === "1";
    btnSaveFilm.title = !n ? "请先添加一些分段"
      : "把时间轴上所有段拼成一条完整视频存进档案目录"
        + "（连接处自动裁掉承接重叠，与时间轴总长一致）";
    /* 推送整片跟着禁：渲染中不该再排一次；推送自己挂牌时也别重复点。 */
    btnPushFilm.disabled = !n || busy || btnPushFilm.dataset.busy === "1";
    btnPushFilm.title = !n ? "请先添加一些分段"
      : "不重跑渲染，把时间轴上的整片直接送到「整片」口连的视频合并节点"
        + "（只加载模型、不采样；视频合并直接采用，不重新编码）";
    /* 推送整片潜空间同理：渲染中不该排；自己挂牌时也别重复点。它比上面那个
       更重（要跑一次导演台读全部档案），正式跑之前先把"没段"挡掉。 */
    btnPushFilmLatent.disabled = !n || busy || btnPushFilmLatent.dataset.busy === "1";
    btnPushFilmLatent.title = !n ? "请先添加一些分段"
      : "把所有段拼成一条完整潜空间，从「整片潜空间」口送给下游"
        + "（二采 / 时间分块重绘；会跑一次导演台读档案、但**不采样**）";
    /* 裁切剃刀：没段 / 渲染中都禁用（跟其它编辑按钮一致）。 */
    btnCut.disabled = !n || busy;
    /* 20261107：取消接续按钮的 disabled 也依赖 busy，但通用重绘入口不一定
       每轮都走到 paintSegTools；这里补一次，保证两排按钮状态始终一致。 */
    try { ui.paintUnlinkAllBtn && ui.paintUnlinkAllBtn(); } catch (_) { /* 尚未装载 */ }
  }

  /* ---- 渲染范围 ↔ 时间轴联动 ----
     渲染范围固定「整个工程」：落在轴上的段顶上亮一条主色细条，正在跑的那
     一段亮度脉冲 —— 点之前能确认，跑的时候能看见。 */
  function paintRunScope() {
    /* 渲染中不能拖排序（顺序一变就和正在跑的链对不上），光标也要跟着变 ——
       手型光标是一句承诺，兑现不了就别给。这里顺手把那条承诺收回来。 */
    ui.monitor?.syncSortable?.();
    const segs = monitor.root.querySelectorAll(".bzf-seg[data-seg]");
    segs.forEach((s) => {
      const i = (parseInt(s.dataset.seg, 10) || 1) - 1;
      s.classList.toggle("inrun", true);
      s.classList.toggle("running", !!(ui.run && ui.run.i === i));
    });
  }

  /* 断口画在段块的左边缘：这一段独立起头，不承接上一段的尾巴。
     "接没接上"是这条轴最该说清的事之一 —— 段与段之间连不连贯，用户本该在按
     渲染之前就看见，而不是等成片出来才发现。 */
  /* 段 i 是否断链 —— 唯一真值 p.transitions（工程映射），与后端 /transitions 同步。 */
  const isUnlinkedAt = (i) => {
    const p = ui.proj();
    const sh = p.shots[i];
    return i > 0 && !!(sh && sh.clip && p.transitions
      && p.transitions[sh.clip] && p.transitions[sh.clip].type === "unlink");
  };
  function paintLinkMarks() {
    /* band 被 timelineHost 外挂进 lanesWrap，monitor.root 里已经没有段块
       （实测 .bzfilm 内 .bzf-seg = 0）—— 必须在 lanesWrap 里查，否则断链
       的左缘虚线口永远画不上。 */
    lanesWrap.querySelectorAll(".bzf-seg[data-seg]").forEach((s) => {
      const i = (parseInt(s.dataset.seg, 10) || 1) - 1;
      const broken = isUnlinkedAt(i);
      s.classList.toggle("unlinked", broken);
      /* tooltip：断开时追加、接上时撤回（旧版只增不删，重新接上仍挂"断开"）。 */
      if (broken && !/接缝已断链/.test(s.title || "")) {
        s.title = (s.title || "")
          + "\n⇤ 接缝已断链 —— 播放到这里不自动连播（停在段尾）";
      } else if (!broken && /\n⇤ 接缝已断链[^\n]*/.test(s.title || "")) {
        s.title = s.title.replace(/\n⇤ 接缝已断链[^\n]*/g, "");
      }
    });
  }

  /* 原先这里有一个 MutationObserver 盯 .bzf-segs 的子节点变动，用来在重绘后
     补画标记。它看不住"没增删节点"的那类重绘（点段 / 拖窗口），而那恰恰是
     最常用的两次 —— 现已改由上面的 onAfterSegs 在每次画完时补，观察器撤掉。 */

  /* 落地行：文案来源 + 渲染控制合一。这两件都是"看一眼 / 点一下"的动作，
     原来分两行各占一条，中间还夹着模式开关与首尾帧卡 —— 相关的两件事被拆到
     面板两头。 */
  const footSp = el("div");
  footSp.style.flex = "1 1 auto";
  footSp.style.minWidth = "4px";
  /* 不叫 foot：buildUI 后半段另有两个同名的局部变量（段落卡里的 foot），同名
     会遮蔽外层的这一个，改一次 DOM 就可能踩到。 */
  const footRow = el("div", "gcast-foot");
  /* 渲染结果行。跑完一整轮之后，面板必须留下"这一轮到底成了没有"——
     原来中断/失败只往控制台打一行，遮罩一撤界面就回到空闲，用户看不出跑了
     几段、断在第几段、要不要重跑、从哪里接着跑。结果常驻到下一次渲染开始。 */
  const runResult = el("div", "gcast-psrc gcast-runres");
  runResult.style.display = "none";
  /* 结果行的**唯一权威是面板存档**（st.run_result = {ok, text}）：
     渲染完写存档 → paintFootRow 把它画出来；刷新页面 → parseInitial 读回存档
     → 同一条 paintFootRow 再画一次。DOM 只是呈现层，不持有状态 ——
     之前状态只存在 DOM 里，刷新一次就没了。 */
  function setRunResult(ok, text) {
    if (ui.st) ui.st.run_result = { ok: !!ok, text: String(text) };
    paintFootRow();
    /* 落盘：commit 把 st 写进 h3_data widget。面板还没建好时 commit 不存在，
       那次结果就只在内存里（下次运行仍会重写一遍），不报错。 */
    try { ui.commit?.(); } catch (_) { /* 面板未就绪 */ }
  }
  /* 把存档里的结果画出来。DOM 已是同一份内容时不重画——每次重绘都重写
     textContent 会让 title 抖动、也会打断用户正在选中的文本。 */
  function paintRunResult() {
    const rr = ui.st && ui.st.run_result;
    const text = (rr && rr.text) ? String(rr.text) : "";
    const ok = !!(rr && rr.ok);
    if (runResult.textContent !== text) {
      runResult.textContent = text;
      runResult.title = text;
    }
    runResult.classList.toggle("ok", ok);
    runResult.classList.toggle("bad", !ok);
    runResult.style.display = text ? "" : "none";
  }
  /* 落地行整行"没话说就藏"（20261015）：文案来源那句撤掉之后，接好线的情况下
     里面两个元素都是空的 —— 只剩一个带边框的圆角空盒子挂在反馈条上面。空的
     虚线框有 .gcast-psrc:empty 兜底，但落地行永远带着三个子元素、:empty 恒不
     成立，所以这里按"里面到底有没有字"显式收一次。 */
  function paintFootRow() {
    /* 先把存档里的渲染结果画出来（DOM 是呈现层，权威在 st.run_result）。 */
    paintRunResult();
    const hasRes = runResult.style.display !== "none" && !!runResult.textContent;
    const hasSrc = !!(ui.pSrcLine && ui.pSrcLine.textContent);
    footRow.style.display = (hasRes || hasSrc) ? "" : "none";
  }
  ui.paintFootRow = paintFootRow;
  /* 刷新后把存档里的结果行画回 DOM。权威一直在 st.run_result，paintFootRow 读的
     就是它 —— 这里只是给它一个显式的名字，给"节点重建完要恢复界面"的调用方用
     （load/render 已经会走到 paintFootRow，调一次是幂等的）。 */
  function restoreRunResult() {
    paintFootRow();
  }
  footRow.append(runResult, ui.pSrcLine, footSp);
  paintFootRow();

  /* 顺序：指挥条（我是谁/哪一段/什么模式）→ 双栏（监视器 | 设置+首尾帧）
     → 全宽总览轴 → 落地行（没接文案台时的告警 + 渲染结果）→ 反馈条（最底一行）。
     总览轴独占整行放在双栏下面：段一多它就需要吃满整个节点宽度，放在双栏里
     会被右栏 540px 挤掉近一半；同时"上画面、下时间轴"是剪辑软件的位置直觉。 */
  /* （手势提示框已删，20261010 用户定：这行说明书常驻在轴下没人看 —— 操作
     说明都在悬停 title 与右键菜单里，不需要一整行常驻文字。） */

  /* 反馈条垫在最底：上面是落地行（渲染结果 / 未接文案台的告警），它再往下
     独占一行 —— 说的是"刚做的那个动作怎么样了"，放在最后不挡任何操作。 */
  ui.root.append(ui.cmdBar, ui.studioRow, lanesWrap, footRow, flashBar);

  /* 右栏（设置 + 首尾帧）**不做限高**：内容多高，gcast-studio 就自然撑多高、把
     下方全宽时间轴往下推，全貌直接露出（用户明确要的旧行为）。原先"限高=监视器
     高 + 卡内滚动"会把首尾帧卡藏在卡内、还被下方时间轴挡住，已整段撤除，不再
     wrap monitor.refresh，也不挂限高 ResizeObserver。 */
  /* 原先这里挂了一个 ResizeObserver 在旧工程条的 tlView 上重画它。那条轴已
     撤下（连元素带绘制逻辑一起删了，见「阶段 0 死代码清理」），
     ResizeObserver 对脱离文档的元素根本不触发 —— 留着就是永不执行的死代码，
     删掉。段操作按钮的状态由 paintSegTools() 每次改动直接刷新，不依赖尺寸
     变化。 */


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { monWrap, lanesWrap, lanesHd, lanesTitle, lanesMeta, lanesTools, flashBar, castName, reorderTo, monitor, laneBtn, tsep, btnRunAll, btnSaveFilm, paintRenderRow, paintRunScope, paintLinkMarks, footSp, footRow, runResult, setRunResult, restoreRunResult });
}
