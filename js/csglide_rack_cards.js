/* ============================================================
 * H3 媒体架 — 参考视频 / 参考音频卡片区
 * ------------------------------------------------------------
 * 与导演台面板的 mediaSlot 逐项同构：波形、双柄修剪、播放修剪区间、悬停
 * 预览、快速帧档、色度徽章文案、音轨勾选行。修剪条本身在
 * csglide_rack_trim.js —— 它不认识卡片，卡片每次重渲都向它要一条新的。

 * 对外挂到 ui 上：vidGrid / audGrid（含各自的「＋ 添加」格）、
 * appendMedia（节点级拖入用）、rebuildMedia（load 与「按提示词排序」共用）。
 * ============================================================ */
import { api } from "../../scripts/api.js";
import { ACCEPT_VIDEO, ACCEPT_AUDIO } from "./csglide_cast.js";
import { hasRef, relFromEvent } from "./bz_media_ref.js";
import { el, MAX_SLOTS, fileKind, pickFile, probeDuration, viewURL } from "./csglide_rack_core.js";
import { aliasInput, setAutoAlias } from "./csglide_rack_alias.js";
import { mediaFor } from "./csglide_rack_media.js";
import { buildTrim } from "./csglide_rack_trim.js";

export function installCards(ui) {
  const vidGrid = el("div", "gcast-grid med");
  const audGrid = el("div", "gcast-grid med");
  const vidCards = [], audCards = [];

  /* 拖拽换位的源槽号：必须是**模块级共享**变量（与图片区 dragImageIndex 同），
     不能放进 makeMedia 闭包 —— dragstart 发生在源卡、dragover/drop 发生在
     目标卡，两张卡闭包各自独立，跨卡读不到就会「拖起来但放不下」。 */
  let dragFrom = null;

  /* 重内容延迟挂载（20261023 P1 性能专项）：视频/音频卡的 <video>/<audio>
     元素（拉元数据/首帧）与波形修剪条（buildTrim 的 idle 回调会 fetch 整个
     文件做 WebAudio 解码，参考视频常 10MB+）在旧实现里**每卡一 paint 就立刻
     发起**——切到含 N 个视频的段，N 个文件同时抢 IO/CPU，切段迟钝。
     现在进视口前 300px 才挂载（滚到即用、只挂一次），视口外只留 cap + 占位。
     与图片区缩略图同一套 IO 思路，但这里不卸载：挂载后修剪状态/波形复用，
     且媒体元素本就有 32 上限的池化。 */
  let heavyObs = null;
  function scheduleHeavy(card) {
    if (!heavyObs && typeof IntersectionObserver === "function") {
      heavyObs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const fn = en.target.__gcastMount;
          if (typeof fn === "function") { try { fn(); } catch (_) {} }
          heavyObs.unobserve(en.target);
        }
      }, { rootMargin: "300px 0px" });
    }
    if (heavyObs) heavyObs.observe(card);
    else { try { card.__gcastMount && card.__gcastMount(); } catch (_) {} }
  }

  ui.vidGrid = vidGrid;
  ui.audGrid = audGrid;
  ui.rebuildMedia = rebuildMedia;
  ui.healGrids = healGrids;   // 函数声明hoist，定义在文件末（网格样式自愈）

  function makeMedia(slot, kind, index) {
    const isVideo = kind === "videos";
    const caption = isVideo ? `视频 ${index + 1}` : `音频 ${index + 1}`;
    const token = isVideo ? `@视频${index + 1}` : `@音频${index + 1}`;
    const card = el("div", "gcast-media" + (slot.file ? " filled" : ""));
    /* 槽号挂卡片上给「被本段文案引用没引用」的亮/灰用（csglide_rack_refs.js）。
       卡片复用时 index 与实际槽号恒等（缓存键就是建卡时的槽号），所以不用担心
       复用后编号漂移。 */
    card.dataset.refIdx = String(index);

    async function fill(src) {
      /* 架面身份（20261101 串段根治，与 csglide_rack_images.assignImage 同一
         条规矩）：上传/探测是 await，中途切段的话，下面按索引回写的就是上
         一段的槽位对象 —— 图/视频看着进了新段，实际写进了旧段记忆并落库。
         这里把「这次写入属于哪一段」在 await 之前固定（架面对象 + 段身份 +
         槽位还在原位），回来任一不符就丢弃并提示。 */
      const ownerSlots = ui.st.slots;
      const ownerCur = ui.st.cur;
      const ownerArr = ownerSlots ? ownerSlots[kind] : null;
      /* src 是字符串 = 文件已在 input 目录里的相对路径，直接落槽，不再上传一遍 */
      const ref = typeof src === "string" ? src : await ui.uploadOrToast(src);
      if (!ref) return;   // 失败已提示。提前返回，否则 slot.file = null 会清空槽位。
      if (ui.st.slots !== ownerSlots || String(ui.st.cur) !== String(ownerCur)
          || !ownerArr || ownerArr[index] !== slot) {
        ui.toast(`切段中：「${typeof src === "string" ? src : src.name}」没有放进 ${ownerCur || "原段"}，请重新导入`, true);
        return;
      }
      ui.clearSlot(slot);
      slot.file = ref;
      setAutoAlias(slot, ref);            // 与图片同规则：文件名主干即别名
      const dur = await probeDuration(viewURL(ref), isVideo);
      /* 探测也是 await：期间切段就把时长/入出点写进上一段、并把新段的架面
         提交一次。同一条规矩，再验一次。 */
      if (ui.st.slots !== ownerSlots || String(ui.st.cur) !== String(ownerCur)) return;
      if (dur) { slot.dur = dur; slot.start = 0; slot.end = dur; }
      if (isVideo) slot.audio = true;
      paint(); ui.commit();
      tagChroma(ref);
    }

    function tagChroma(ref) {
      if (!isVideo) return;
      const i = ref.lastIndexOf("/");
      api.fetchApi("/cglide/probe?type=input"
        + `&filename=${encodeURIComponent(i >= 0 ? ref.slice(i + 1) : ref)}`
        + `&subfolder=${encodeURIComponent(i >= 0 ? ref.slice(0, i) : "")}`)
        .then((r) => (r.status === 200 ? r.json() : null))
        .then((d) => {
          if (!d || slot.file !== ref) return;
          slot.chroma = d.chroma || "";
          slot.codec = d.codec || "";
          if (!slot.dur && d.duration) { slot.dur = d.duration; slot.end = d.duration; }
          paint(); ui.commit();
        })
        .catch(() => {});      /* 徽章是装饰，失败静默 */
    }

    /* 卡销毁：修剪条挂的 ResizeObserver 等资源在这里释放（见 trim.js 的
       __gcastDestroy）。keyed 增量缓存淘汰卡时必须走它，否则观察器随卡
       一起脱离 DOM 却不断开，反复切段会累积成「越切越卡」。 */
    function destroy() {
      try { card.__gcastDestroy && card.__gcastDestroy(); } catch (_) {}
      try { heavyObs && heavyObs.unobserve(card); } catch (_) {}
      try { card.remove(); } catch (_) {}
    }

    function paint() {
      /* 重绘会整条替换子树：先断开上一条修剪条的 ResizeObserver ——
         buildTrim 每次都新建观察器，不主动断的话，导入/清除/色度回填
         触发一次 paint 就泄漏一个（与卡销毁同一泄漏点的另一条路径）。 */
      const oldTrim = card.querySelector(".gcast-trim");
      try { oldTrim && oldTrim.__gcastDestroy && oldTrim.__gcastDestroy(); } catch (_) {}
      card.replaceChildren();
      card.classList.toggle("filled", !!slot.file);
      /* 「本段文案引用了没引用」由 ui.paintRefMarks 统一点亮/置灰：
         判据是**文案里有没有写 @视频N**，不是槽号超过上限（那是错的 —— 上限算
         的是被引用的个数）。空有素材、文案没提它，模型就看不到它。
         归 paintRefMarks 管是为了单一数据源：引用状态随文案变，这里不该再判一遍。 */

      /* cap：编号标题 + @token + 清除 */
      const cap = el("div", "gcast-cap");
      cap.append(el("span", "n", caption));
      if (slot.file) cap.append(el("span", null, token));
      if (slot.file) cap.append(aliasInput(slot, ui.commit, () => paint()));
      cap.append(el("div", "spacer"));
      if (slot.file) {
        const x = el("button", "gcast-x", "×");
        x.title = "清除槽位";
        x.onclick = (e) => {
          e.stopPropagation(); ui.clearSlot(slot);
          /* 尾格清空即收缩（编号永不漂移）；中间格清空后保留占位 */
          const arr = ui.st.slots[kind];
          const list = kind === "videos" ? vidCards : audCards;
          if (arr.indexOf(slot) === arr.length - 1) {
            arr.pop(); const old = list.pop(); old && old.destroy && old.destroy();
          } else {
            paint();
          }
          const newLast = list[list.length - 1];
          if (newLast && !newLast.slot.file) newLast.render();
          ui.commit();
        };
        cap.append(x);
      } else if (index === ui.st.slots[kind].length - 1) {
        const del = el("button", "gcast-x", "－");
        del.title = "删除这个空槽位";
        del.onclick = (e) => {
          e.stopPropagation();
          const arr = ui.st.slots[kind];
          const list = kind === "videos" ? vidCards : audCards;
          arr.pop(); const old = list.pop(); old && old.destroy && old.destroy();
          const newLast = list[list.length - 1];
          if (newLast && !newLast.slot.file) newLast.render();
          ui.commit();
        };
        cap.append(del);
      }
      card.append(cap);
      card.dataset.refBase = slot.file || "";
      /* 卡重画之后引用状态要跟着重刷（paint 会 replaceChildren，新的内部节点
         没有旧状态）—— 只改根节点的 class，成本可以忽略。 */
      if (ui.paintRefMarks) ui.paintRefMarks();

      if (slot.file) {
        /* 重内容（媒体元素 + 波形修剪条 + 音轨勾选）整块延迟挂载，见
           scheduleHeavy 的注释。未挂载时 .gcast-heavy 只有 CSS 占位高度。 */
        const heavy = el("div", "gcast-heavy " + (isVideo ? "hv" : "ha"));
        let mounted = false;
        const mountHeavy = () => {
          if (mounted || !heavy.isConnected || !slot.file) return;
          mounted = true;
          heavy.classList.add("mounted");
          let m = null;
          if (isVideo) {
            /* 视频缩略图：元素跨 render 复用（mediaFor），移动不重载；
               悬停静音预览，仅当传输未被占用时（muted 时才 hover-play） */
            m = mediaFor(slot, "video", slot.file);
            m.playsInline = true;
            if (m.paused) m.muted = true;
            m.loop = false;
            m.onmouseenter = () => { if (m.muted) m.play().catch(() => {}); };
            m.onmouseleave = () => {
              if (m.muted) { m.pause(); m.currentTime = slot.start || 0; }
            };
            const body = el("div", "gcast-thumb");
            m.style.cssText = "width:100%;height:100%;object-fit:contain;";
            body.append(m);
            heavy.append(body);
          } else {
            /* 音频没有可见缩略图：隐藏元素供播放，文件名由波形背 */
            m = mediaFor(slot, "audio", slot.file);
            m.style.display = "none";
            heavy.append(m);
          }
          /* 波形修剪条（带媒体时才有）；销毁钩子挂到卡上，供 destroy()
             与下次 paint() 断旧观察器使用。延迟挂载后必须链式保留本卡的
             视口观察注销（见 scheduleHeavy）。 */
          const trimW = buildTrim({ slot, isVideo, media: m, commit: ui.commit });
          const trimDestroy = trimW && trimW.__gcastDestroy;
          card.__gcastDestroy = () => {
            try { trimDestroy && trimDestroy(); } catch (_) {}
            try { heavyObs && heavyObs.unobserve(card); } catch (_) {}
          };
          if (trimW) heavy.append(trimW);
          if (isVideo) {
            const lab = el("label", "gcast-chk");
            const cb = el("input"); cb.type = "checkbox"; cb.checked = slot.audio !== false;
            cb.onchange = () => { slot.audio = cb.checked; ui.commit(); };
            lab.append(cb, el("span", null, "同时把其音轨作为音频参考"));
            heavy.append(lab);
          }
        };
        card.__gcastMount = mountHeavy;
        scheduleHeavy(card);
        card.append(heavy);
      } else {
        if (isVideo) {
          const body = el("div", "gcast-thumb");
          body.append(el("div", "gcast-empty", "+"));
          card.append(body);
        } else {
          card.append(el("div", "gcast-wav", "+ 音频"));
        }
      }
    }
    paint();

    /* 手动拖拽换位（与图片区同口径）：唯一允许改变槽位顺序的手动操作。
       卡是 keyed 复用的（makeMedia 只在缓存未命中/重建时新建 DOM），这里监听
       挂一次不会重复；换位只改数组顺序，再由 rebuildMedia(true) 强制重排
       DOM —— keyed 缓存按槽号比对 file，标题「视频 N / 音频 N」随之重算。
       dragFrom 是模块级共享变量（见 installCards 顶部），跨卡才能读到。 */
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      dragFrom = index;
      card.classList.add("gcast-dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(index)); } catch (_) {}
    });
    card.addEventListener("dragend", () => {
      dragFrom = null;
      card.classList.remove("gcast-dragging");
      const g = isVideo ? vidGrid : audGrid;
      g.querySelectorAll(".gcast-reorder-drop")
        .forEach((n) => n.classList.remove("gcast-reorder-drop"));
    });
    card.addEventListener("dragover", (e) => {
      /* 内部换位优先：有拖拽中的媒体卡时不把它当外部文件落点 */
      if (dragFrom == null || dragFrom === index) return;
      e.preventDefault(); e.stopPropagation();
      card.classList.add("gcast-reorder-drop");
    });
    card.addEventListener("dragleave", () => card.classList.remove("gcast-reorder-drop"));
    card.addEventListener("drop", (e) => {
      if (dragFrom == null || dragFrom === index) return;
      e.preventDefault(); e.stopPropagation();
      card.classList.remove("gcast-reorder-drop");
      const arr = ui.st.slots[kind];
      const t = arr[dragFrom]; arr[dragFrom] = arr[index]; arr[index] = t;
      dragFrom = null;
      rebuildMedia(true); ui.commit();
    });

    /* 空槽点击 / 外部文件拖落（元素级监听只挂一次，paint 只换 children） */
    card.addEventListener("click", async () => {
      if (!slot.file) {
        const f = await pickFile(isVideo ? ACCEPT_VIDEO : ACCEPT_AUDIO);
        if (f) await fill(f);
      }
    });
    card.addEventListener("dragover", (e) => {
      /* 内部换位进行中：这不是外部文件，别亮外部落点的「drop」样式 */
      if (dragFrom != null) return;
      if (![...e.dataTransfer.items].some((it) => it.kind === "file") && !hasRef(e)) return;
      e.preventDefault();
      card.classList.add("drop");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop"));
    card.addEventListener("drop", async (e) => {
      if (dragFrom != null) return;   // 内部换位已在前面那个 drop 处理
      e.preventDefault(); e.stopPropagation();
      card.classList.remove("drop");
      /* 已在 input 目录里的素材：直接记引用 */
      const ref = relFromEvent(e);
      if (ref) {
        if (fileKind({ name: ref }) !== (isVideo ? "video" : "audio")) {
          ui.toast(`这一格只收${isVideo ? "视频" : "音频"}：${ref}`, true);
          return;
        }
        await fill(ref);
        return;
      }
      const files = [...(e.dataTransfer.files || [])];
      const f = files.find((x) => fileKind(x) === (isVideo ? "video" : "audio"));
      if (f) await fill(f);
      else if (files.length) {
        ui.toast(`这一格只收${isVideo ? "视频" : "音频"}：${files.map((x) => x.name).join("、")}`, true);
      }
    });

    return { card, slot, fill, render: paint, destroy };
  }

  /* 动态追加：槽位按需生长（append-only，编号永不漂移）。
     新卡插在「＋ 添加」格之前，添加格始终居末。 */
  function addTile(label, onAdd) {
    const t = el("div", "gcast-addtile", "＋ " + label);
    t.title = "追加一个空槽位";
    t.onclick = onAdd;
    return t;
  }
  /* 媒体卡 keyed 增量缓存（20261012 媒体架专项）：
     旧实现每次切段（load）都 replaceChildren 两个网格并逐卡 makeMedia +
     buildTrim —— <video> 虽已按文件池化不重载，但修剪条 DOM、波形 canvas、
     ResizeObserver 全部重建，首次切到某段还要当场 fetch 整个媒体文件 +
     WebAudio 解码波形，是媒体架切段迟钝、越切越卡的主因。
     现在按「段身份 cur + 槽号 + 文件」复用卡：file 没变，卡连同修剪条、
     波形、池化视频元素一个 DOM 都不重建；段切换整池作废（旧卡闭包绑的是
     旧段 slot 对象，必须销毁，原则与图片区一致）。按提示词排序改了槽位
     顺序 → 槽号上的 file 变化，相关卡自然重建，「视频 N」标题随之正确。 */
  const mediaCardCache = { videos: new Map(), audios: new Map() };
  let mediaCacheCur = null;

  function destroyEntry(hit) {
    const e = hit && hit.entry;
    if (!e) return;
    try { e.destroy && e.destroy(); } catch (_) {}
  }

  function appendMedia(kind, grid, cards, addT) {
    if (ui.st.slots[kind].length >= MAX_SLOTS) return null;
    const prev = cards[cards.length - 1];
    if (prev && !prev.slot.file) prev.render();   /* 摘掉旧尾格的「－」 */
    const slot = {};
    ui.st.slots[kind].push(slot);
    const m = makeMedia(slot, kind, cards.length);
    cards.push(m);
    /* 同步登记进 keyed 缓存，否则下次 rebuildMedia 会把这张手动卡当残留
       拔掉再重建一张同内容的（手动追加是低频操作，但不白做）。 */
    mediaCardCache[kind].set(cards.length - 1, { file: slot.file || "", entry: m });
    grid.insertBefore(m.card, addT);
    ui.commit();
    return m;
  }
  const vidAdd = addTile("添加视频", () => appendMedia("videos", vidGrid, vidCards, vidAdd));
  const audAdd = addTile("添加音频", () => appendMedia("audios", audGrid, audCards, audAdd));

  /* 给节点级拖入用：卡片列表 / 网格 / 添加格是本分区的内部件，不外露——
     拖入只要「第一个空位」和「再加一个」，不需要看见数组。 */
  const gridOf = (kind) => (kind === "videos" ? vidGrid : audGrid);
  const cardsOf = (kind) => (kind === "videos" ? vidCards : audCards);
  const addTOf = (kind) => (kind === "videos" ? vidAdd : audAdd);
  ui.freeMediaSlot = (kind) => cardsOf(kind).find((x) => !x.slot.file) || null;
  ui.appendMedia = (kind) => appendMedia(kind, gridOf(kind), cardsOf(kind), addTOf(kind));

  function rebuildZone(kind, grid, cards, addT) {
    const arr = ui.st.slots[kind];
    /* 添加格先摘下，卡归位完再挂末位，不参与 children[i] 参照计算 */
    if (addT.parentNode) addT.remove();
    arr.forEach((slot, i) => {
      const file = slot.file || "";
      let hit = mediaCardCache[kind].get(i);
      /* 比较用 entry 闭包里 slot 的实时 file：文件落进已有空槽（fill）后
         slot 引用不变、file 更新，命中复用、不白重建；排序后槽位引用换了，
         file 对不上，自然重建。 */
      const hitFile = hit ? (hit.entry.slot.file || "") : null;
      /* 与图片区同：除 file 外再校验 slot 对象身份，防止「cur 不变、st.slots 被
         load 整体换对象」时旧卡闭包绑游离旧对象，导致复制段「只能增不能删」。 */
      const hitSlot = hit ? hit.entry.slot : null;
      if (!hit || hitFile !== file || hitSlot !== slot) {
        if (hit) destroyEntry(hit);
        const m = makeMedia(slot, kind, i);
        hit = { file, entry: m };
        mediaCardCache[kind].set(i, hit);
      }
      cards[i] = hit.entry;
      const card = hit.entry.card;
      /* ⚠ 参照物必须**每一轮重新取 grid.children[i]**，不能用沿途自增的
         anchor 指针（20261019 修）：被换掉的旧卡是当场 remove() 掉的，若它
         正好是 anchor，anchor 从此不再是 grid 的子节点，下一次
         insertBefore(card, anchor) 直接抛 NotFoundError —— 同 cur 的
         load()（Ctrl+Z 回滚 rack_data / 外部改 rack_data）会经 revive 整批
         换 slot 对象，必踩这条，整条渲染链断在中间、网格停在半渲染态（与
         图片区 renderImages 20261012「全部渲染跑到第 2 段就中断」同一根因，
         那边早就换成了 children[i]，这边是漏网的同款）。
         children[i] 一定是 grid 的子节点；i 越界时是 undefined → null
         （insertBefore 第二参数传 null 等价 append）。 */
      const at = grid.children[i] || null;
      if (at !== card) grid.insertBefore(card, at);
    });
    /* 槽位收缩：淘汰编号越界的卡 */
    for (const k of Array.from(mediaCardCache[kind].keys())) {
      if (k >= arr.length) {
        destroyEntry(mediaCardCache[kind].get(k));
        mediaCardCache[kind].delete(k);
      }
    }
    cards.length = arr.length;
    /* 归位完成后，第 arr.length 位及其后的都是旧残留（旧 addtile / 被换掉的
       卡），从尾部整串移除，再补添加格。 */
    while (grid.children.length > arr.length) {
      const last = grid.lastChild;
      if (!last) break;
      last.remove();
    }
    grid.append(addT);
  }

  /* 视频/音频卡增量重建。force=true 用于整池作废后的强制全量（如排序后
     需要确保编号标题全对）；load() 切段走 cur 变化自动作废。 */
  function rebuildMedia(force) {
    const cur = ui.st.cur || "";
    if (force || cur !== mediaCacheCur) {
      mediaCacheCur = cur;
      for (const kind of ["videos", "audios"]) {
        for (const hit of mediaCardCache[kind].values()) destroyEntry(hit);
        mediaCardCache[kind].clear();
      }
      vidGrid.replaceChildren(); audGrid.replaceChildren();
    }
    rebuildZone("videos", vidGrid, vidCards, vidAdd);
    rebuildZone("audios", audGrid, audCards, audAdd);
    healGrids();
    /* 新卡的亮/灰要在重渲后补一次（见 csglide_rack_refs.js）：只碰 DOM，
       不等下一次桌面事件，否则「刚写 @视频2，第 2 格还不亮」。 */
    if (ui.paintRefMarks) ui.paintRefMarks();
  }

  /* ---- 网格样式自愈（20261019「两个音频卡竖排堆成一列」）----
     ComfyUI 对 custom_nodes 下的 js/css 是静态服务、无缓存戳：用户覆盖更新后
     不硬刷新，浏览器会新旧文件混跑。旧版样式表缺 .gcast-grid.med 的列定义时，
     网格退化成「有 display:grid、无 grid-template-columns」——所有卡落进单一
     隐式列，竖着摞成一列。只在缓存了旧样式的用户那儿可见，本机开发环境不可
     见，正是「有的用户」三个字的来历（与插帧报错同源：用户跑在旧包上）。
     不猜、只验：算一遍网格的真实计算样式，display 不是 grid 或没有列模板，
     就把关键三项（display / 列 / 间距）就地补成内联——内联胜样式表，旧缓存
     再也压不住；同时吼一声，让人去硬刷新把全套样式拿全。样式正常时零成本
     （三次 getComputedStyle），补过的值与 RACK_CSS 里的规则逐字一致，硬刷新
     后视觉无差异。 */
  const MED_COLS = "repeat(auto-fit, minmax(180px, 1fr))";
  function healOne(grid, cols) {
    if (!grid || !grid.isConnected) return false;   // 没上文档算不出样式，别误诊
    let cs = null;
    try { cs = getComputedStyle(grid); } catch (_) { return false; }
    if (cs.display === "grid" && cs.gridTemplateColumns && cs.gridTemplateColumns !== "none") return false;
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = cols;
    if (!grid.style.gap) grid.style.gap = "7px";
    return true;
  }
  function healGrids() {
    const bad = [];
    if (healOne(vidGrid, MED_COLS)) bad.push("参考视频");
    if (healOne(audGrid, MED_COLS)) bad.push("参考音频");
    /* 图片格由 installImages 先装（installCards 运行时 ui.imgGrid 已就位）；
       它的列值在 RACK_CSS 的 .gmr .gcast-grid.img 里，一并验。 */
    if (ui.imgGrid && healOne(ui.imgGrid, "repeat(auto-fill, minmax(96px, 1fr))")) bad.push("参考图片");
    if (bad.length) {
      console.warn("[H3 Studio] 媒体架网格样式缺失（" + bad.join(" / ")
        + " 退化成单列），已就地修复 —— 浏览器缓存了旧版样式表，请 Ctrl+F5 硬刷新一次拿全样式");
    }
    return bad.length;
  }
}
