/* ============================================================
 * H3 媒体架 — 参考图片区
 * ------------------------------------------------------------
 * 与面板同结构：流式换行的 gcast-grid.img。槽位编号即 @图片N 的 N，
 * 唯一允许改变图片位置的操作是手动拖拽换位——本节点没有任何自动搬动
 * 图片的逻辑（自动排序只在用户点「按提示词排序」时发生）。

 * 落格语义（20261020）：拖入**默认追加到末尾**，不覆盖任何已有素材；按住
 * Shift（或 Ctrl）拖到某一格才是「替换这一格」。空格子仍照旧填那一格 ——
 * 空着就是等着被填，不存在"顶掉谁"的问题。详见 buildCard 里的 落这一格()。

 * 对外挂到 ui 上：imgBox（含标题的整盒）、assignImage（统一导入漏斗）、
 * renderImages（重渲）、isReordering（节点级拖放要据此让路）。
 * ============================================================ */
import { ACCEPT_IMAGE, badImageKind } from "./csglide_cast.js";
import { hasRef, relFromEvent } from "./bz_media_ref.js";
import { el, MAX_SLOTS, fileKind, pickFile, viewURL, THUMB_SIZE } from "./csglide_rack_core.js";
import { aliasInput, setAutoAlias } from "./csglide_rack_alias.js";

export function installImages(ui) {
  const imgGrid = el("div", "gcast-grid img");
  /* 与面板 refWrap 同构：图片九格收进带边框的 gcast-imgbox 盒 */
  const imgBox = el("div", "gcast-imgbox");
  imgBox.append(el("div", "gcast-label", "参考图片"), imgGrid);
  let dragImageIndex = null;

  ui.imgGrid = imgGrid;
  ui.imgBox = imgBox;
  ui.assignImage = assignImage;
  ui.renderImages = renderImages;

  /* 切换历史工程后把全段参考图缩略图提前取进浏览器缓存。
     架面一次只显示当前段，其余段要切过去才 set img.src；不预取的话每切一段
     都要等 /cglide/thumb 现场生成，用户看到的就是「素材慢慢冒出来」。
     只预取、不持有 Image 对象：解码位图不驻留，内存不随段数涨。 */
  const prefetched = new Set();
  const prefetchQueue = [];
  let prefetchActive = 0;
  const PREFETCH_MAX = 4;   // 后端缩略图生成并发有限，一次最多排 4 张
  function prefetchThumbs(files) {
    if (prefetched.size > 600) prefetched.clear();
    for (const f of files || []) {
      if (!f || typeof f !== "string" || prefetched.has(f)) continue;
      prefetched.add(f);
      prefetchQueue.push(f);
    }
    pumpPrefetch();
  }
  function pumpPrefetch() {
    while (prefetchActive < PREFETCH_MAX && prefetchQueue.length) {
      const f = prefetchQueue.shift();
      let url;
      try { url = viewURL(f, THUMB_SIZE); } catch (_) { continue; }
      prefetchActive++;
      const im = new Image();
      const done = () => {
        prefetchActive--;
        im.onload = im.onerror = null;
        pumpPrefetch();
      };
      im.onload = done;
      im.onerror = done;
      im.src = url;
    }
  }
  ui.prefetchThumbs = prefetchThumbs;
  ui.isReordering = () => dragImageIndex != null;

  /* 图片导入的唯一漏斗：点击选文件、落格、节点级拖入三条路全汇到这里。
     src 是字符串 = 文件已在 input 目录里（从媒体加载器拖来）的相对路径，
     直接落槽、不再上传一遍 —— 与 fill() 及导演台同名入口同口径。少了这一
     支，字符串会被当 File 塞进 FormData（append 报 "parameter 2 is not of
     type 'Blob'"，文件名读出 undefined）。 */
  async function assignImage(index, src) {
    const label = typeof src === "string" ? src : src.name;
    /* 可疑格式先拦：HEIC/SVG/PSB 这类文件 MIME 齐全，能过 fileKind() 的关，
       但后端 PIL 没有对应解码器，收下只会一路传到模型端才抛异常。所有图片
       导入路径都汇到这里的漏斗，拦一道就全覆盖。
       字符串来源只给得了文件名，故按 {name} 归一后再判——已经在 input 目录里
       的 HEIC 同样读不了，不该因为「绕过上传」就放行。 */
    const bad = badImageKind(typeof src === "string" ? { name: src } : src);
    if (bad) { ui.toast(`「${label}」是 ${bad}，无法作为参考图，请先转成 PNG/JPG`, true); return; }
    /* 架面身份（20261101 串段根治）：上传是 await，这几百毫秒里随时会切段。
       旧代码 await 回来才按索引取 ui.st.slots —— 取到的已经是新段的数组，
       于是"一次粘贴，图同时落进两段、旧段整批素材被顶掉"（工程库实测：
       clip_0006 的 34 张被粘给 clip_0005 的 5 张取代，且已落库不可恢复）。
       根治办法是把"这次写入属于哪一段"在 await **之前**固定下来：
       槽位对象、架面数组、段身份三者一起抓，回来只要有一个变了就丢弃这次
       写入并明确提示 —— 跨段写入从结构上不可能发生，而不是靠调用顺序去赌。 */
    const ownerSlots = ui.st.slots;
    const ownerCur = ui.st.cur;
    const slot = ownerSlots.images[index];
    const ref = typeof src === "string" ? src : await ui.uploadOrToast(src);
    if (!ref) return;   // 失败已提示。必须提前返回——否则下一行会把 null 写进槽位、清掉已有素材。
    if (ui.st.slots !== ownerSlots || String(ui.st.cur) !== String(ownerCur)) {
      /* 空壳槽位由 appendImage 的 !arr[at].file 分支从它自己抓的那个数组里
         收掉，不会留在被切走的那一段上。 */
      ui.toast(`切段中：「${label}」没有放进 ${ownerCur || "原段"}，请重新导入`, true);
      return;
    }
    ui.clearSlot(slot);
    slot.file = ref;
    setAutoAlias(slot, ref);            // 文件名主干即别名，剧本里直接写它
    /* 显示层根因修复（20261112）：同名替换后路径与槽位对象都没变，卡片缓存
       会误判「没变」而复用旧 <img>，浏览器不回源、服务端 ETag 够不着，面板
       停在旧图。放图后强制作废这一格卡片，让它重建回源拿新内容。 */
    imgCardCache.delete(index);
    renderImages(); ui.commit();
    /* 诊断：放图要能当场看出「进了哪一段的第几格」。三段摆完若仍然串台，
       靠这一行就能分清是"根本没放进去"还是"放进了错的段"（20261012）。 */
    console.log("[联动] 媒体架 放图: 段=" + (ui.st.cur || "(未认段)")
      + " 第" + (index + 1) + "格 = " + ref);
  }

  /* 追加到末尾（20261020 落格语义的默认落点）。挂到 ui 上给卡片 drop 与节点
     级拖入共用，两条路就不会各写一份 push、写出两种顺序。
     满了就一个都不加、只提示 —— 与 allocImageSlots 同口径。 */
  async function appendImage(src) {
    const arr = ui.st.slots.images;
    if (arr.length >= MAX_SLOTS) {
      ui.toast(`图片槽位已达上限 ${MAX_SLOTS} 个，请先清理再导入`, true);
      return null;
    }
    arr.push({});
    const at = arr.length - 1;
    await assignImage(at, src);
    /* assignImage 中途退出（可疑格式 / 上传失败）会把刚 push 的空壳留在末尾，
       显示成一个多余的空格位。收掉，别留假槽位。 */
    if (!arr[at].file) { arr.pop(); renderImages(); ui.commit(); return null; }
    return at;
  }
  ui.appendImage = appendImage;

  /* 缩略图按需解码（20261020）：进视口才装载 src，离开视口换成 1×1 占位。

     只靠 loading="lazy" 不够 —— 它只保证视口外**不加载**，滚过的**不会释放**。
     来回滚几遍，几十张图的解码位图就全留在内存里了（「素材一多就卡」的大头，
     跟上传快慢无关）。卸掉 src 是把解码结果还给浏览器唯一的办法。

     一个 observer 管全部卡片：200 张各建一个 observer 本身就是负担，而且谁观察
     谁、谁负责注销会乱成一团。回调里只做「设 src / 卸 src」两件事。 */
  const BLANK =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  let thumbObs = null;

  /* 元素是否在视口装载范围内（含上下 margin）。getBoundingClientRect 是同步
     几何，用来给「卡片刚插入 DOM 的第一帧」做**确定的首次装载**——不再依赖
     IntersectionObserver 的异步首次回调：渲染后系统繁忙、节点几何变化时，那次
     回调可能不判 intersecting，表现为「段切了、对账也对、缩略图却没刷」。 */
  function inLoadRange(img, margin) {
    const r = img.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;   // 还没布局（折叠/未挂载）
    const m = margin || 0;
    return r.bottom >= -m && r.top <= window.innerHeight + m
        && r.right >= -m && r.left <= window.innerWidth + m;
  }
  function observeThumb(img) {
    if (!thumbObs && typeof IntersectionObserver === "function") {
      thumbObs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const im = en.target;
          if (en.isIntersecting) {
            if (im.src !== im.dataset.src) im.src = im.dataset.src;
          } else if (im.src && im.src !== BLANK) {
            im.src = BLANK;      // 卸掉 → 浏览器释放这一张的解码位图
          }
        }
      }, { rootMargin: "240px 0px" });   // 提前约一屏装载，滚过来不会先空白
    }
    if (thumbObs) {
      /* 同步首次装载：卡片已插入 DOM 且在装载范围内就立即给 src，再交给
         observer 管后续滚动；不在范围内给 BLANK，等滚到时 observer 装载。 */
      img.src = inLoadRange(img, 240) ? img.dataset.src : BLANK;
      thumbObs.observe(img);
    } else {
      img.src = img.dataset.src;      // 没有 IO 的老浏览器：退化成直接装载
    }
  }

  /* 卡片被丢弃时必须注销，否则 observer 一直攥着已移除节点的引用 —— 那正是这套
     机制要消灭的东西（内存只增不减）。 */
  function unwatchThumb(node) {
    if (!thumbObs || !node?.querySelectorAll) return;
    for (const im of node.querySelectorAll("img")) thumbObs.unobserve(im);
  }

  /* 图片卡 keyed 增量（20261012 方案C）：旧实现每次 renderImages 都
     replaceChildren + 给所有 <img> 重设 src，同段内任何一次小操作（改别名、
     单次落图、外部刷新）都会让全部缩略图重新解码，是媒体架卡顿/闪烁主因。
     现在按「段身份 + 槽号 + 文件」复用卡片：file 没变一个 DOM 都不碰，
     <img> 不重设 src、别名输入框编辑状态不丢；段切换（cur 变）整池作废。 */
  const imgCardCache = new Map();   // i -> { file, card }
  let imgCacheCur = null;

  function buildCard(i, slot, arr) {
      const card = el("div", "gcast-slot" + (slot.file ? " filled" : ""));
      /* 槽号挂在卡片上给「被本段文案引用没引用」的亮/灰走（csglide_rack_refs.js 的
         paintGrid）：它遍历 DOM 的孩子，必须能问出这一张是第几格。不按 DOM
         序号算 —— 中间空槽、增删槽位都会让序号和槽号错开。 */
      card.dataset.refIdx = String(i);
      /* ⚠ 这里曾经按「槽号 ≥ MAX_IMAGES 就标灰 + 提示『不会进提示词』」，
         20261023 删除：**上限算的是被引用的个数，不是槽号**。后端
         _filter_refs_by_prompt 是 `keep = sorted(idxs)[:cap]` —— 第 15 格只要
         被 @图片15 引用、且整段被引用的图不超过 9 张，它照样进得去（实测
         未命名工程 6/clip_0005 引用 [1,2,4,6,9,15] 共 6 张，第 15 格确实送
         出去了）。按槽号判灰把 10~28 格全冤枉成"不进提示词"，而真正的超限
         情况后端会自己报警（见 csglide_cast.py【参考素材】⚠ 引用了 N 个…）。
         现在「本段到底用没用这一格」由 ui.paintRefMarks 判定并点亮/置灰（真实、
         可算、不误报），见 csglide_rack_refs.js。 */
      const thumb = el("div", "gcast-thumb");
      if (slot.file) {
        const img = el("img");
        /* 真实地址放 data-src，**不直接给 src** —— 由 observeThumb 在进视口时
           才装载、离开视口时卸掉。理由见 observeThumb。 */
        img.dataset.src = viewURL(slot.file, THUMB_SIZE);
        img.decoding = "async";    /* 解码不卡主线程 */
        img.draggable = false;      /* 保留卡片自身的拖拽换位 */
        /* 两级兜底：① 缩略图出不来（PIL 打不开这种格式）→ 退回原图再试一次；
           ② 原图也不行（文件不在 input 目录 / 浏览器解不了）→ 才报缺失。
           直接跳到缺失会把「服务端压不出缩略图」误报成「素材丢了」。
           改的是 data-src：否则下次进视口又把失败的缩略图地址装回去。 */
        let fellBack = false;
        img.onerror = () => {
          if (!fellBack) {
            fellBack = true;
            img.dataset.src = viewURL(slot.file);
            img.src = img.dataset.src;
            return;
          }
          if (!thumb.isConnected) return;   // 槽位已重渲，别覆盖新内容
          const box = el("div", "gcast-broken");
          box.append(el("span", "gcast-broken-ico", "⚠"));
          box.append(el("span", "gcast-broken-txt", "预览缺失 · 重新导入"));
          thumb.replaceChildren(box);
        };
        /* 不在此 observe：img 还没插入 DOM，getBoundingClientRect 拿不到几何。
           由 renderImages 在 insertBefore 之后统一 armThumb（同步首次装载）。 */
        thumb.append(img);
      } else {
        thumb.append(el("div", "gcast-empty", "+"));
      }
      thumb.append(el("span", "gcast-num", String(i + 1)));
      card.append(thumb);

      const cap = el("div", "gcast-cap");
      /* 文件名换成可编辑的别名：拖入时已按文件名主干自动登记，这里改一下即可
         （剧本里写这个名字就引用本素材）。文件名仍在 tooltip 里备查。 */
      if (slot.file) cap.append(aliasInput(slot, ui.commit, () => renderImages()));
      cap.append(el("div", "spacer"));
      if (slot.file) {
        const x = el("button", "gcast-x", "×");
        x.title = "清除槽位";
        x.onclick = (e) => {
          e.stopPropagation(); ui.clearSlot(slot);
          /* 尾格清空即收缩（编号永不漂移）；中间格清空后保留占位 */
          if (i === arr.length - 1) arr.pop();
          renderImages(); ui.commit();
        };
        cap.append(x);
      } else if (i === arr.length - 1) {
        const del = el("button", "gcast-x", "－");
        del.title = "删除这个空槽位";
        del.onclick = (e) => {
          e.stopPropagation();
          arr.pop(); renderImages(); ui.commit();
        };
        cap.append(del);
      }
      card.append(cap);
      /* 基础提示（文件名 / 空槽说明）只存在 dataset 里，由 ui.paintRefMarks
         按「本段文案有没有引用它」补一句状态、再写回 title。
         单一数据源的理由：引用状态会随文案变（那边改），而拖入悬停又要临时换
         成落点说明（这里改）—— 两边各存一份，改一处就漂。 */
      card.dataset.refBase = slot.file ? slot.file : `点击或拖入图片（@图片${i + 1}）`;
      card.dataset.refTip = card.dataset.refBase;
      card.title = card.dataset.refTip;

      card.addEventListener("click", async () => {
        if (!slot.file) {
          const f = await pickFile(ACCEPT_IMAGE);
          if (f) await assignImage(i, f);
        }
      });
      /* 手动拖拽换位 —— 唯一允许改变图片位置的操作 */
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        dragImageIndex = i;
        card.classList.add("gcast-dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(i)); } catch (_) {}
      });
      card.addEventListener("dragend", () => {
        dragImageIndex = null;
        card.classList.remove("gcast-dragging");
        imgGrid.querySelectorAll(".gcast-reorder-drop")
          .forEach((n) => n.classList.remove("gcast-reorder-drop"));
      });
      card.addEventListener("dragover", (e) => {
        if (dragImageIndex == null || dragImageIndex === i) return;
        e.preventDefault(); e.stopPropagation();
        card.classList.add("gcast-reorder-drop");
      });
      card.addEventListener("dragleave", () => card.classList.remove("gcast-reorder-drop"));
      card.addEventListener("drop", async (e) => {
        if (dragImageIndex == null || dragImageIndex === i) return;
        e.preventDefault(); e.stopPropagation();
        card.classList.remove("gcast-reorder-drop");
        const arr = ui.st.slots.images;
        const t = arr[dragImageIndex]; arr[dragImageIndex] = arr[i]; arr[i] = t;
        dragImageIndex = null;
        renderImages(); ui.commit();
      });
      /* 外部文件的落点（20261020）：默认追加到末尾，按住 Shift/Ctrl 才是替换这一格。

         为什么修饰键不是 Alt：Windows 资源管理器里「Alt + 拖文件」= 创建快捷
         方式，且拖到浏览器时 Windows 不解析快捷方式，浏览器直接拿到 .lnk ——
         fileKind 认不出，导入必然失败。Ctrl+Shift 同样建快捷方式，一并避开。
         Shift/Ctrl 不改变拖给浏览器的文件，安全。 */
      const 要替换 = (e) => e.shiftKey || e.ctrlKey;
      /* 空格子照旧填这一格：空着就是等着被填，不涉及"顶掉谁"。 */
      const 落这一格 = (e) => !slot.file || 要替换(e);
      const 清高亮 = () => {
        card.classList.remove("drop", "drop-append");
        card.title = card.dataset.refTip || card.dataset.refBase || "";
      };

      card.addEventListener("dragover", (e) => {
        if (![...e.dataTransfer.items].some((it) => it.kind === "file") && !hasRef(e)) return;
        e.preventDefault(); e.stopPropagation();
        /* 两种落点给两种样子：实线 = 就落这一格；虚线 = 加到末尾、这一格不动。
           不给区分的话，"拖到这格上却出现在末尾"会被当成程序乱放。 */
        card.classList.add("drop");
        card.classList.toggle("drop-append", !落这一格(e));
        card.title = 落这一格(e)
          ? `放到第 ${i + 1} 格`
          : `追加到末尾 · 按住 Shift 则替换第 ${i + 1} 格`;
      });
      card.addEventListener("dragleave", 清高亮);
      card.addEventListener("drop", async (e) => {
        if (dragImageIndex != null) return;
        e.preventDefault(); e.stopPropagation();
        清高亮();
        /* 已在 input 目录里的素材（从媒体加载器拖来）：直接记引用，不再上传。
           交给 assignImage / appendImage 而不是在这里再抄一遍落槽逻辑——
           「字符串还是 File」的分支只在漏斗里判一次，两个入口就不会再各自漏一支。 */
        const ref = relFromEvent(e);
        if (ref) {
          if (fileKind({ name: ref }) !== "image") {
            ui.toast(`这一格只收图片：${ref}`, true);
            return;
          }
          if (落这一格(e)) { await assignImage(i, ref); return; }
          const at = await appendImage(ref);
          if (at != null) ui.toast(`已追加到第 ${at + 1} 格`);
          return;
        }
        const files = [...(e.dataTransfer.files || [])];
        const imgs = files.filter((x) => fileKind(x) === "image");
        if (!imgs.length) {
          /* 落到这一格却不是图片：MIME 缺失的 HEIC（系统没注册）会走到这里，
             此时 fileKind() 已返回空、进不了上面的 imgs。仍按可疑格式报因由。 */
          const hit = files.map((x) => [x, badImageKind(x)]).find(([, b]) => b);
          if (hit) ui.toast(`「${hit[0].name}」是 ${hit[1]}，无法作为参考图，请先转成 PNG/JPG`, true);
          else if (files.length) ui.toast(`这一格只收图片：${files.map((x) => x.name).join("、")}`, true);
          return;
        }
        if (落这一格(e)) {
          /* 替换语义下同一格只收得下一张，挑可用的那张；若只剩可疑格式，也交给
             assignImage，由它把「是 HEIC，请转 PNG/JPG」这类真实原因说出来，
             而不是含糊地回一句"只收图片"——它确实是图片，只是后端读不了。 */
          await assignImage(i, imgs.find((x) => !badImageKind(x)) || imgs[0]);
          return;
        }
        /* 追加语义下多张就都追加：这里再"挑一张"就会变成"又少了好几张"。
           beginBatch 包起来——每张都 commit 是 O(n²)（深拷贝 + 全量序列化 + 全
           画布重绘 + 广播），批量末尾做一次就够。 */
        ui.beginBatch();
        let 成了 = 0;
        for (const f of imgs) { if ((await appendImage(f)) != null) 成了++; }
        ui.endBatch();
        if (成了) ui.toast(`已追加 ${成了} 张到末尾`);
      });
      return card;
  }

  function renderImages() {
    /* 批量导入期间挂起（20261020）：一次拖 100 张会调 100 次 renderImages，
       每次都是「遍历全部槽位 + insertBefore 校正」= O(n²)。批量中只记一笔，
       由 endBatch 末尾统一渲一次（与 commit 同一套节奏）。 */
    if (ui.inBatch?.()) { ui.markRendered?.(); return; }

    const arr = ui.st.slots.images;
    /* 段身份变了（切段/新建/打开工程）：旧卡片闭包绑定的是旧段 slot 对象，
       整池作废，避免编辑写到错段。 */
    const cur = ui.st.cur || "";
    if (cur !== imgCacheCur) {
      imgCacheCur = cur;
      /* 整池作废 = 所有被观察的 img 都要注销，否则 observer 攥着一堆已经不在
         文档里的节点（卸的是别处的内存，这里却一直涨）。 */
      if (thumbObs) { thumbObs.disconnect(); thumbObs = null; }
      imgCardCache.clear();
      imgGrid.replaceChildren();
    }
    /* 顺序校正用 insertBefore 而非 replaceChildren(fragment)：位置本来就对的
       卡片一个都不碰 —— 别名输入框正在打字时触发的重渲不会让它失焦。

       ⚠ 参照物必须**每一轮重新取 imgGrid.children[i]**，不能用一个沿途自增
       的 anchor 指针：被换掉的旧卡是当场 remove() 掉的，若它正好是 anchor，
       anchor 从此不再是 imgGrid 的子节点，下一次 insertBefore(card, anchor)
       直接抛 NotFoundError —— 切段 / 渲染倒回重复 load 时整条渲染链就断在
       这里（20261012「全部渲染跑到第 2 段就中断」的根因）。 */
    /* 本轮新挂的 img 收集区：写入阶段只插 DOM，几何测量统一挪到循环外 */
    const freshImgs = [];
    arr.forEach((slot, i) => {
      const file = slot.file || "";
      let hit = imgCardCache.get(i);
      /* 除「段身份变了整池作废」外，再校验 slot 对象身份。存在「cur 不变、
         st.slots 被 load(revive) 整体换成新数组/新对象」的路径（复制段后的事件
         竞态）—— 只判 cur 会让旧卡片闭包绑着游离旧对象，删除点下去作用于旧
         对象、真实 st.slots 与落库纹丝不动，而「＋ 添加」走最新数组，表现为
         「只能增不能删」。slot 引用真变了就重建，引用没变仍复用（性能不退）。 */
      let isNew = false;
      if (!hit || hit.file !== file || hit.slot !== slot) {
        if (hit && hit.card.parentNode) { unwatchThumb(hit.card); hit.card.remove(); }
        hit = { file, slot, card: buildCard(i, slot, arr) };
        imgCardCache.set(i, hit);
        isNew = true;
      }
      const card = hit.card;
      /* children[i] 一定是 imgGrid 的子节点；i 越界时是 undefined → null
         （insertBefore 的第二参数传 null 等价于 append）。 */
      const at = imgGrid.children[i] || null;
      if (at !== card) imgGrid.insertBefore(card, at);
      /* 缩略图的首次装载**不在这里做**：observeThumb 里的 inLoadRange 要
         getBoundingClientRect，边插边量 = 每张新卡强制一次同步布局，
         200 张 = 200 次全网格 relayout = O(n²)——「粘贴一批卡住几秒 /
         切到大段卡一下」的量级来源。先收集、循环外统一量（fastdom 的
         写读分离：布局只在第一次读时刷一次，之后全是缓存命中）。 */
      if (isNew) {
        for (const im of card.querySelectorAll("img")) freshImgs.push(im);
      }
    });
    /* 槽位收缩：多余的旧卡带走（addtile 也在这轮被顺带顶掉，下面重建） */
    for (const k of Array.from(imgCardCache.keys())) {
      if (k >= arr.length) {
        const hit = imgCardCache.get(k);
        if (hit && hit.card.parentNode) { unwatchThumb(hit.card); hit.card.remove(); }
        imgCardCache.delete(k);
      }
    }
    /* 归位完成后，第 arr.length 位及其后的都是旧残留（旧 addtile / 被换掉的
       卡），从尾部整串移除，再补新 addtile。 */
    while (imgGrid.children.length > arr.length) {
      const last = imgGrid.lastChild;
      if (!last) break;
      unwatchThumb(last);
      last.remove();
    }
    if (arr.length < MAX_SLOTS) {
      const add = el("div", "gcast-addtile", "＋ 添加");
      add.title = "添加一个图片槽位";
      add.onclick = () => { arr.push({}); renderImages(); ui.commit(); };
      imgGrid.append(add);
    }
    /* 写读分离（fastdom 模式）：上面所有写（插卡/摘卡/addtile）做完之后，
       这里统一做读 —— 每张新卡的 getBoundingClientRect 只在第一次触发
       布局刷新，后续全是缓存命中，O(n²) 塌回 O(n)。行为不变：仍是本轮
       同步完成首次装载，段切了、对账对了、缩略图当帧就刷。 */
    for (const im of freshImgs) observeThumb(im);
    /* 新建/重建的卡片没有亮/灰 class，重渲末尾补一次（只碰 DOM，不读节点）。
       不补的话「摆好图 → 文案写 @图片3 → 第 3 格亮」在第一次重渲后就断了。 */
    if (ui.paintRefMarks) ui.paintRefMarks();
  }
}
