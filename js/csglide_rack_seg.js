/* ============================================================
 * H3 媒体架 — 按分段记忆素材 与 存档读写
 * ------------------------------------------------------------
 * segs[段身份] 存这一段自己的槽位，cur 是当前正在编辑的那一段。切段时先把
 * 当前槽位存进 segs[旧段]，再把 segs[新段] 灌回 st.slots —— 于是「切到哪
 * 一段，架子上就是哪一段的素材」。段身份来自导演台（三个节点共享的 current），
 * 见 bz_rack.js。
 * ============================================================ */
import { castProject, castShotRack,
         onCastChange, emitRackChange, BZ_BAG_VERSION } from "./bz_rack.js";
import { bzStore } from "./bz_store.js";
import { saveRack } from "./bz_project_sync.js";
import { pullSeg, normRack, isRealCid } from "./bz_seg.js";
import { projectStore } from "./bz_project_store.js";
import { MAX_SLOTS } from "./csglide_rack_core.js";

export function installSeg(ui) {
  /* 前端 bag 版本标记：热重载自愈巡检（bz_project_sync.startSelfHeal）
     靠它识别本节点是不是热重载前的旧闭包。 */
  ui.BAG_VERSION = BZ_BAG_VERSION;

  function snapshot() {
    return JSON.parse(JSON.stringify({
      slots: ui.st.slots, fps: ui.st.fps, audio_out: ui.st.audio_out,
    }));
  }

  /* ---- 段槽位落 SQLite 工程库（20261012 方案 A）----
     媒体架是 rack 的唯一权威写入方：摆图 / 删槽 / 裁剪 / 切段收口后，防抖
     700ms 把该段快照 POST /cglide/store/rack。片名从导演台工程快照取。
     hydrate 灌库后 2s 内的 commit 不回写（防止"刚从库读出又写回"的回声）。 */
  /* 只有**真实段**的架况才配落库。Ctrl+Z（ComfyUI 画布撤销）会把 rack_data
     widget 整体回滚到旧版本，里面混着早已删掉段的 uid 键；这些键一旦落库，
     "删掉的素材又冒出来"就从中央层面坐实了。拿不到段名单时一律放行 ——
     宁可放过，也不能误伤还没进缓存的新段。 */
  function isLiveCid(cid) {
    try {
      const p = castProject(ui.node);
      const nm = (p && p.name) || "";
      if (!nm) return true;
      const f = bzStore.film(nm);
      const list = (f && f.clips) || [];
      if (!list.length) return true;      // 缓存还没到，不拦
      return list.some((c) => String(c && c.id) === String(cid));
    } catch (_) { return true; }
  }

  const rackSaveTimers = {};
  let hydrateQuietUntil = 0;
  /* 返回值 = 这一次有没有真的排上落库。四道闸门任一拦下都是 false，调用方
     （参照图替换的跨段还原）靠它区分"已落库"与"静默没落"——否则用户看到
     「已还原」，刷新后中央库又把旧架面灌回来。原有调用方一律忽略返回值。 */
  function scheduleRackSave(cid) {
    if (!cid || Date.now() < hydrateQuietUntil) return false;
    const p = castProject(ui.node);
    const name = (p && p.name) || "";
    if (!name) return false;
    if (!isRealCid(cid)) return false;      // 段身份只有 clip_，uid / 临时键一律不落库
    if (!isLiveCid(cid)) return false;      // 不是档案里的段，别写进去
    clearTimeout(rackSaveTimers[cid]);
    /* 调度时即锁快照（20261113 根因修复）：落库数据此刻深拷贝定死，回调不再
       到点读 segs。旧实现到点才读 ui.st.segs[cid]，而新建/切换工程会同步清空
       segs —— 在途写于是读到空，saveRack 把旧工程该段素材行整段删光（摆完素材
       700ms 内点新建即中招，切回原工程素材全丢）。锁快照后任何清空都污染不了
       在途写；合并语义不变（scheduleSave 每次覆盖 fire，最后一次编辑胜出）。
       写穿透仍统一经 projectStore 防抖，提交前 flushWrites 立即触发并等它。 */
    const snap = cloneRack(ui.st.segs[cid]);
    projectStore.scheduleSave(name, "rack:" + cid, () => {
      /* 空快照**同样要落库**（20261019）：原先「没有素材的段不占库行」让
         清空 / 删光素材之后库里仍留着旧记录，刷新时 hydrateRacks 按库把素材
         整批灌回来 —— 表现就是「点了清空，刷新后素材又长回来」。
         灌库侧只认有素材的段（rackHasFile），空记录灌不进来，写空是安全的。 */
      return saveRack(name, cid, snap);
    }, 700);
    return true;
  }

  function emptyRack() {
    return { slots: { images: [], videos: [], audios: [] }, fps: 0, audio_out: 0 };
  }

  /* 诊断用：这段素材的**全部**图片（原来只打第一张，第 2、3 段各自多摆的
     那张图因此长期看不见 —— 20261012）。用 + 连起来，空槽显示为空。 */
  const firstImg = (rack) => {
    try {
      const s = (rack && rack.slots) || {};
      const imgs = Array.isArray(s.images) ? s.images : [];
      const names = imgs.map((x) => (x && x.file) ? String(x.file).split(/[\\/]/).pop() : "(空)");
      return names.length ? names.join("+") : "(空)";
    } catch (_) { return "(err)"; }
  };

  /* 这份架况里到底有没有素材（三类槽位任一有 file 就算）。空快照也是个
     对象，只看"有没有这个键"会被空快照骗过 —— 借到空快照时绝不能写进
     segs[key]，否则这一段就被永久固化成"没有素材"，参考图再连不上。 */
  const rackHasFile = (rack) => {
    const s = (rack && rack.slots) || {};
    for (const k of ["images", "videos", "audios"]) {
      const arr = Array.isArray(s[k]) ? s[k] : [];
      if (arr.some((x) => x && x.file)) return true;
    }
    return false;
  };

  /* 两份架况是不是同一套素材（只比文件名：别名、裁剪窗不影响"是不是同一段"
     的判断）。用来识破"cur 指着 A、架面摆着 B"的串台残留。 */
  const sameSlots = (a, b) => {
    const sig = (r) => {
      const s = (r && r.slots) || {};
      return ["images", "videos", "audios"]
        .map((k) => (Array.isArray(s[k]) ? s[k] : []).map((x) => (x && x.file) || "").join(","))
        .join("#");
    };
    return sig(a) === sig(b);
  };

  function cloneRack(rack) {
    try {
      return JSON.parse(JSON.stringify(rack && rack.slots ? rack : emptyRack()));
    } catch (_) {
      return emptyRack();
    }
  }

  /** 复制段时把源段媒体架槽位照抄到新段，新段持有独立副本。 */
  function copySeg(srcKey, dstKey) {
    if (!dstKey) return false;
    srcKey = srcKey ? String(srcKey) : "";
    dstKey = String(dstKey);
    if (ui.st.cur && ui.st.cur === srcKey) {
      projectStore.captureRack(ui.node);
    }
    const src = ui.st.segs && ui.st.segs[srcKey]
      ? cloneRack(ui.st.segs[srcKey]) : emptyRack();
    ui.st.segs[dstKey] = src;
    if (ui.st.cur === dstKey) load(src, true);
    syncSegChip();
    return true;
  }

  /** 删段时清掉该段的本地段记忆：把 segs[key] 连同 cur 一起摘掉。
      不这样，已删段的旧素材永远残留在 segs 里 —— 之后切到任何同名/复用
      id 的段，switchSeg 一查 keep[key] 就命中残留、直接灌回删除前的素材
      （「删了一段再复制一段，媒体架冒出删之前素材」的根因，20261014）。
      当前正编辑的段被删时，架面一并清空，别留着上一段的图。 */
  function dropSeg(key) {
    if (!key) return false;
    key = String(key);
    if (ui.st && ui.st.segs) delete ui.st.segs[key];
    if (ui.st && ui.st.cur === key) {
      ui.st.cur = "";
      try { load(emptyRack(), true); } catch (_) {}
      ui.commit();
    }
    syncSegChip();
    return true;
  }

  /** 临时段身份升级为真实 clip id，连媒体架槽位和当前段一起迁移。 */
  function claimSeg(tempKey, cid) {
    if (!cid) return false;
    tempKey = tempKey ? String(tempKey) : "";
    cid = String(cid);
    if (ui.st.cur && ui.st.cur === tempKey) {
      projectStore.captureRack(ui.node);
    }
    const rec = ui.st.segs && ui.st.segs[tempKey]
      ? cloneRack(ui.st.segs[tempKey]) : emptyRack();
    if (tempKey && tempKey !== cid) delete ui.st.segs[tempKey];
    ui.st.segs[cid] = rec;
    if (ui.st.cur === tempKey || ui.st.cur === cid) {
      ui.st.cur = cid;
      load(rec, true);
    }
    syncSegChip();
    ui.commit();
    return true;
  }

  /** 换到另一段：旧段的素材先存好（不然一去不回），新段的素材灌回来。 */
  function switchSegSync(key) {
    if (!key) return false;
    key = String(key);
    if (key === ui.st.cur) {
      /* 人已在本段 ≠ 架面一定对：串台残留时 cur 指着 A、架面却摆着 B 的素材
         （旧代码 renderImages 抛异常后跳过 cur 恢复，就把 B 的素材留给了 A；
         之后每次 commit 还把 B 写进 A 的分段记忆 —— 20261012 存档里段1 的
         记忆混进了段2 的图，铁证）。架面与该段记忆不一致就重灌，不能直接把
         错样 return 留着。 */
      const mem = ui.st.segs[key];
      if (mem && rackHasFile(mem)) {
        if (sameSlots(mem, ui.st)) {
          return false;   // 已在本段、架面一致，去重不重复刷
        }
        /* 校正串台：直接重灌本段记忆。不走下面的"存旧段"——cur 就是 key，
           那一步会把架面上的错样存进本段记忆，越存越脏。 */
        console.warn("[联动] 媒体架 switchSeg 校正串台: 架面与本段记忆不一致，重灌", key);
        ui.st.cur = key;
        try { load(mem, true); }
        finally { ui.st.cur = key; }
        ui.st.segs[key] = snapshot();   // 校正后的架面收口进段记忆
        syncSegChip();
        ui.commit();
        scheduleRackSave(key);          // 串台校正结果落工程库
        emitRackChange({ name: ui.castName ? ui.castName() : "",
                         clip: key, reason: "fixup" });
        return true;
      }
      /* 本段还没有记忆 → 落到下面正常流程（借工程快照 / 空架）。此时 cur===key，
         "存旧段"就是把当前架面记为本段记忆——架面对着呢就是捡回记忆，架面不
         对也只能以它为准，没有更真的事实来源。 */
    }
    const keep = ui.st.segs;
    let s = (key && keep[key]) || null;
    let borrowed = false;
    if (!s) {
      const borrowedRack = castShotRack(ui.node, key);
      /* 只有真有素材的快照才借 —— 工程里那段 rack 可能是"空快照污染"
         时期写下的（rackSnapshot 拿不到 rack_data 时曾返回空对象），借它
         会把这一段永久记成空，之后 restoreShotRack 也补不回来。 */
      if (borrowedRack && rackHasFile(borrowedRack)) { s = borrowedRack; keep[key] = s; borrowed = true; }
    }
    console.log("[联动] 媒体架 switchSeg 切换:", key, "首图=" + firstImg(s), "borrowed=" + borrowed, "旧cur=" + ui.st.cur,
      "segs=" + Object.keys(keep).map((k) => k + "→" + firstImg(keep[k])).join(" "));
    /* 已知段（非借快照）→ 引用切段：每段 slots 物理单一份，不 clone/revive。
       mountRack 内部离开旧段用引用收口、再把 st.slots 指向段记忆数组。 */
    if (s && !borrowed && projectStore.mountRack(ui.node, key)) {
      /* 同步节点设置控件（不走 load，这里补上）。 */
      if (ui.fpsIn) ui.fpsIn.value = ui.st.fps > 0 ? ui.st.fps : "";
      if (ui.audIn) ui.audIn.value = ui.st.audio_out > 0 ? ui.st.audio_out : "";
      if (ui.setAudioBaseline) {
        ui.setAudioBaseline(ui.st.audio_out > 0 ? ui.st.slots.videos[ui.st.audio_out - 1] : null);
      }
      syncSegChip();
      ui.renderImages();
      ui.rebuildMedia();
      /* 引用切段后必须 commit：mountRack 只改了内存 st.slots，没序列化
         rack_data.value —— 文案台标签栏读的就是 rack_data.value，漏掉这步
         素材条不刷新（「切到已有素材的段，标签栏还是空的」的根因，20261014）。 */
      ui.commit();
      return true;
    }
    /* 新段 / 借快照：离开旧段 clone 收口，load revive 建立本段独立数组。 */
    if (ui.st.cur) {
      const oldCid = ui.st.cur;
      ui.st.segs[oldCid] = snapshot();
      scheduleRackSave(oldCid);        // 离开旧段：旧段最后一版架况落库
    }
    ui.st.cur = key;
    /* force=true：切段必须强制刷新架面；try/finally 保证 cur 身份恢复。 */
    try { load(s || emptyRack(), true); }
    finally { ui.st.segs = keep; ui.st.cur = key; }
    syncSegChip();
    ui.commit();
    if (borrowed) {
      emitRackChange({ name: ui.castName ? ui.castName() : "",
                       clip: key, reason: "borrow" });
    }
    return true;
  }

  /* ---- B1：中央校正（异步，不阻塞切段）----
     本地 segs[key] 只是"乐观预览"，中央 rack 才是权威。刷新页面 / 串台残留
     / 别处改过素材之后，本地和中央会对不上 —— 以前只能靠本地猜，于是出现
     「删掉的段素材又冒出来」「点段架子不动」。现在切完段再问一次中央：
       中央有货且与本地不同 → 以中央为准重灌；
       中央没货（这一段还没落过库）  → 本地为准，靠 scheduleRackSave 补上去。
     期间又切了段就丢弃结果（_reconSeq 拦截），绝不把上一段的素材灌进新段。 */
  let _reconSeq = 0;
  function reconcileFromCentral(key) {
    /* 片名必须走 castProject（媒体架自己落库也是这么取的）。ui.castName 在
       这个 bag 里不一定存在 —— 之前用它，取到空串就静默 return，于是这条
       校正从来没跑过（日志里永远搜不到「素材对账」）。 */
    const pj = castProject(ui.node);
    const nm = (pj && pj.name)
            || ((ui.castName && ui.castName()) ? ui.castName() : "");
    if (!nm || !key) {
      console.warn("[B1] 素材对账跳过：拿不到片名", JSON.stringify(nm), key);
      return;
    }
    const mySeq = ++_reconSeq;
    pullSeg(nm, key).then((central) => {
      if (!central) { console.warn("[B1] 素材对账：中央没返回", key); return; }
      if (_reconSeq !== mySeq) return;   // 期间又切段了，丢弃
      if (String(ui.st.cur) !== String(key)) return; // 已经不在这一段了
      /* 渲染期闸门（20261024 · 中央集权）：批量渲染时渲染循环是唯一权威，
         它按段身份自取段记忆；此刻异步中央对账若用（可能是旧的）中央数据
         覆盖本地段记忆，compile 可能取到被覆盖的旧数据。渲染中跳过覆盖，
         渲染结束后用户手动切段会再正常对账。 */
      try {
        if (projectStore.isGloballyRendering && projectStore.isGloballyRendering()) {
          console.log("[B1] 素材对账：渲染中，跳过中央覆盖（渲染循环为权威）", key);
          return;
        }
      } catch (_) {}
      const cr = normRack(central.rack);
      /* 无条件打：B1 的心跳。控制台搜 "[B1]" 没有它 = 媒体架这条没生效。 */
      console.log("[B1] 素材对账:", key,
                  "中央=" + (rackHasFile(cr) ? firstImg(cr) : "无素材"),
                  "本地=" + firstImg(ui.st.segs[key]));
      if (!rackHasFile(cr)) return;                  // 中央也没素材，别拿空覆盖
      const mem = ui.st.segs[key];
      if (mem && rackHasFile(mem) && sameSlots(mem, cr)) return;   // 一致，不动
      console.log("[B1] 素材以中央为准:", key,
                  "中央首图=" + firstImg(cr), "本地首图=" + firstImg(mem));
      ui.st.segs[key] = cr;
      const keep = ui.st.segs;
      try { load(cr, true); }
      finally { ui.st.segs = keep; ui.st.cur = key; }
      syncSegChip();
      ui.commit();
      emitRackChange({ name: nm, clip: key, reason: "central" });
    }).catch(() => {});
  }

  /** 换到另一段（对外入口）：先按本地记忆立刻切（乐观），再问中央校正。 */
  function switchSeg(key) {
    if (!key) return false;
    /* 全片共用：各段就是同一副架面，切段不该换素材 —— 否则每加一张图都要
       每段补一次（20261022）。只刷一下芯片显示，架面原样不动。 */
    if (ui.st.shared) { syncSegChip(); return false; }
    const r = switchSegSync(key);
    reconcileFromCentral(String(key));
    /* 切到这一段之后做一次槽位纠错（20261024）：文案点名了"第 N 格是谁"，
       而那一格放的是别的图（或者那件素材全片都没有）→ 归位 / 腾空。
       放在这里是因为：这是用户**开始用这一段**的时刻，架面刚从段记忆灌回来、
       还没被本轮编辑，动它最安全；而且进段就看到"这一格空着等 KF_01-05"，
       比等提交时才报错有用得多。
       三道保险：只动文案断言过的格、搬动明细全打印、ui.vacateUndo() 可还原。
       开关默认开（ui.st.vacate），关掉就完全不自动 —— 手动随时可跑 bzVacate()。 */
    try {
      if (ui.vacate && ui.vacateAuto && ui.vacateAuto() !== false) ui.vacate(true);
    } catch (e) {
      console.warn("[媒体架] 切段后的槽位纠错失败（架面未动）:", e);
    }
    return r;
  }

  /* ---- 全片共用开关（20261022）----
     素材的编号与槽位全片固定时，各段本就该共用同一副架面。开启后：
       · 切段不换架面（见 switchSeg 的早退）
       · 每次改动都同步写进每一段的记录 —— 库里始终一致，刷新 hydrate 灌回来
         的也是同一份，不会「切了共用、刷新后又散了」
     切回「按段记忆」时把当前架面铺给所有段各存一份副本：位置固定，铺过去
     内容一致，之后各段才开始各自独立。 */
  function setShared(on) {
    const want = !!on;
    if (!!ui.st.shared === want) return false;
    const p = castProject(ui.node);
    const gp = p && p.cast && p.cast.properties && p.cast.properties.gcast_project;
    const cids = ((gp && gp.shots) || [])
      .map((s) => s && s.clip).filter((c) => c && isRealCid(c));
    const snap = snapshot();
    ui.st.shared = want;
    ui.st.segs = {};
    cids.forEach((cid) => { ui.st.segs[cid] = cloneRack(snap); });
    if (want) {
      ui.st.cur = "";
    } else {
      const cur = p && (p.clip || p.shot);
      ui.st.cur = (cur && isRealCid(String(cur))) ? String(cur) : (cids[0] || "");
    }
    syncSegChip();
    ui.commit();
    cids.forEach((cid) => scheduleRackSave(cid));
    emitRackChange({ name: (p && p.name) || "", clip: ui.st.cur, reason: "shared" });
    console.log("[联动] 媒体架 全片共用:", want ? "开" : "关", "同步段数=" + cids.length);
    return true;
  }

  /**
   * 导演台专用：把某段的素材快照**连同段身份一起**灌进来（segs[key]=snap、
   * cur=key）。旧 restoreShotRack 只 gmr.load(snap)，cur 被快照（无 cur 字段）
   * 置空，1~2 秒后轮询发现档案 current 是新段、segs 里又没它，照清空不误 ——
   * 复制/插入段后参考图闪一下就没了。走这里，轮询命中同 key 直接 return。
   */
  function loadSeg(key, snap) {
    if (!key) return false;
    key = String(key);
    console.log("[联动] 媒体架 loadSeg: key=" + key + " 灌入首图=" + firstImg(snap) + " 当前cur=" + ui.st.cur);
    const keep = ui.st.segs;
    if (ui.st.cur && ui.st.cur !== key) {
      /* 离开旧段：引用收口（物理单一），不 clone。 */
      projectStore.captureRack(ui.node);
      scheduleRackSave(ui.st.cur);
    }
    /* 双保险：即便上游塞进带 segs/cur 的整份状态，这里也只取槽位快照，
       全局 segs/cur 绝不进入某一段的 segs[key]，杜绝段快照互相污染。 */
    keep[key] = snap
      ? { slots: (snap.slots && typeof snap.slots === "object") ? snap.slots : { images: [], videos: [], audios: [] },
          fps: snap.fps || 0, audio_out: snap.audio_out || 0 }
      : emptyRack();
    ui.st.cur = key;
    /* load() 内部若整体替换 ui.st.segs / ui.st.cur（段快照带了这两个字段时），
       try/finally 保证下面两行一定执行，cur 绝不会被丢成空字符串。 */
    try { load(keep[key], true); }
    finally { ui.st.segs = keep; ui.st.cur = key; }
    syncSegChip();
    ui.commit();
    scheduleRackSave(key);   // 导演台灌入的段架况（复制/插入段等）同步落库
    emitRackChange({ name: ui.castName ? ui.castName() : "",
                     clip: key, reason: "load_seg" });
    return true;
  }

  /**
   * 工程库启动灌库（hydrate）：把库里各段架况整批灌进 segs，再让架面停在
   * 当前段。灌库期间抑制落盘回声 2s。只灌真有素材的段，空段不覆盖记忆。
   * 返回灌入的段数。旧 bag 没有本函数，由 bz_project_sync 走整包 load 兜底。
   */
  function hydrateRacks(racks, curCid) {
    hydrateQuietUntil = Date.now() + 2000;
    let n = 0;
    Object.keys(racks || {}).forEach((cid) => {
      const rk = racks[cid];
      if (rk && rk.slots && rackHasFile(rk)) {
        ui.st.segs[String(cid)] = {
          slots: JSON.parse(JSON.stringify(rk.slots || { images: [], videos: [], audios: [] })),
          fps: rk.fps || 0, audio_out: rk.audio_out || 0,
        };
        n++;
      }
    });
    /* 后端 current 可能是空串（刚由音频排段建出来的新工程）。以前这里直接
       跳过整个 if，架面停在旧 DOM 上不重画 —— 库里已经换成 3 个音频槽，
       用户却还看着 1 张卡。退回架面自己的当前段，再兜底第一段。 */
    curCid = curCid ? String(curCid) : String(ui.st.cur || "");
    if (!curCid && n) curCid = Object.keys(racks || {})[0] || "";
    if (curCid) {
      if (ui.st.cur === curCid) {
        const mem = ui.st.segs[curCid];
        if (mem) {
          try { load(mem, true); } finally { ui.st.cur = curCid; }
          syncSegChip();
          ui.commit();
        }
      } else {
        switchSeg(curCid);   // 正常切段流程（会从刚灌好的 segs 取架况）
      }
    }
    /* 整包已经把全段素材都灌进内存了，但架面一次只显示当前段。这里把全段
       参考图缩略图提前取进浏览器缓存，之后点任意一段只搬数据、不等后端
       现场生成缩略图 —— 切历史工程后「一段一段慢慢冒」就是等这一步。 */
    try {
      const files = [];
      Object.keys(racks || {}).forEach((cid) => {
        const imgs = (racks[cid] && racks[cid].slots && racks[cid].slots.images) || [];
        for (const s of imgs) if (s && s.file) files.push(s.file);
      });
      if (ui.prefetchThumbs) ui.prefetchThumbs(files);
    } catch (_) {}
    console.log("[状态库] 媒体架 hydrateRacks 灌入 " + n + " 段，当前段=" + (curCid || "空"));
    return n;
  }

  /** 真实分段数（导演台的分段列表为准）。拿不到返回 0。 */
  function segCount(p) {
    const gp = p && p.cast && p.cast.properties && p.cast.properties.gcast_project;
    return (gp && Array.isArray(gp.shots)) ? gp.shots.length : 0;
  }
  /** 「全片 N 段」里的段数：读导演台的**真实**分段数。拿不到就说「全片」——
      绝不写死举例数字（写死成 8 段，1 段的工程上那句就成了假话，20261022）。 */
  function segCountText(p) {
    const n = segCount(p);
    return n ? `全片 ${n} 段` : "全片";
  }

  /* 段号与锁定状态来自档案那一行（见 bz_rack.currentClipOf），不是拿导演台
     面板的 idx 拼出来的：锁定后面板 idx 会跟着点走，而三个节点共同的编辑目标
     是档案里的 current。三处各拼一遍就会各说一个段号。 */
  async function syncSegChip() {
    const chip = ui.segChip;
    if (!chip) return;
    const p = castProject(ui.node);
    /* 「全部段」排序按钮的提示里也带段数，顺带一起按真实值刷新（20261022） */
    if (ui.bSortAll && typeof ui.sortAllTitle === "function") {
      ui.bSortAll.title = ui.sortAllTitle(segCount(p));
    }
    /* 全片共用：整片一副架面，芯片要点得出来、也要看得出来（20261022） */
    if (ui.st.shared) {
      chip.textContent = "🔒 全片共用";
      chip.classList.add("on", "shared");
      chip.classList.remove("locked");
      /* 段数**读真实的分段数**，不写死举例数字 —— 写死成「8 段」时，只有 1 段的
         工程上这句就成了假话（20261022）。 */
      chip.title = `${segCountText(p)}共用同一副架面：加一张图，所有分镜都有\n`
        + "点一下切回「按段记忆」（各段各自一份副本）";
      return;
    }
    chip.classList.remove("shared");
    if (!ui.st.cur || !p) {
      chip.textContent = "全片共用";
      chip.classList.remove("on", "locked");
      chip.title = "还没认段时，素材是全片共用的一套";
      return;
    }
    /* 段号按「媒体架当前编辑段」（ui.st.cur）在 store 快照里反查 —— **不读
       后端 current**：setCurrent 先 await 写档、optimisticCurrent 之后才到，
       切段瞬间读到的 current 还是旧段，chip 就显示旧段号且再无时机刷新
       （20261012「点第 1 段显示第 3 段」的根因）。素材与段号从此同一个真值。 */
    let curRow = null;
    try {
      const sf = bzStore.film(p.name);
      if (sf && Array.isArray(sf.clips)) {
        curRow = sf.clips.find((c) => c && c.id === ui.st.cur) || null;
      }
    } catch (_) { curRow = null; }
    const n = (curRow && curRow.index) || ((p.index ?? 0) + 1);
    const locked = !!(curRow && curRow.locked);
    /* 段号只在导演台那边有；档案里只有 id，显示不出来就说"已按段记忆" */
    chip.textContent = (p.clip === ui.st.cur || p.shot === ui.st.cur)
      ? (locked ? "🔒 " : "") + `第 ${n} 段`
      : (locked ? "🔒 " : "") + "本段";
    chip.classList.add("on");
    chip.classList.toggle("locked", locked);
    chip.title = locked
      ? "素材按分段记忆 · 这一段已锁定，再点别的段，架子上仍是这一段"
      : "素材按分段记忆：切到哪一段，架子上就是哪一段的素材";
  }

  /* ---------------- state io ---------------- */
  /* 内容签名：同一份快照被重复 load（导演台灌一次、轮询又灌一次）时，跳过
     renderImages/rebuildMedia 的全量 DOM 重建 —— 缩略图 <img> 不再重复解码，
     这是"切一次段卡一下"的前端主因之一（20261012）。 */
  let lastLoadSig = "";
  function load(raw, force) {
    let d = {};
    try { d = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {}); } catch (_) { d = {}; }
    const slots = d.slots && typeof d.slots === "object" ? d.slots : {};
    let sig = "";
    try {
      sig = JSON.stringify({ s: slots, f: d.fps, a: d.audio_out,
                             segs: d.segs || null, cur: d.cur || "" });
    } catch (_) { sig = String(Date.now()); }
    if (!force && sig === lastLoadSig) return;
    lastLoadSig = sig;
    /* 槽位数量随存档动态重建。数量与卡片在同一遍里一起重建，makeMedia
     * 闭包引用的 slot 对象与 st.slots 始终同引用（原地回填教训）。
     * 尾部空格不生成格子——旧存档的固定 9/3/3 空位自动收缩。 */
    const revive = (kind) => {
      const saved = Array.isArray(slots[kind]) ? slots[kind] : [];
      while (saved.length && !(saved[saved.length - 1] && saved[saved.length - 1].file)) saved.pop();
      return saved
        .slice(0, MAX_SLOTS)
        .map((s) => (s && typeof s === "object") ? { ...s } : {});
    };
    /* 20261028：槽位**只有 raw 里真的带了 slots 才重建** —— 与下面 segs / cur /
       shared 那三条完全同一个道理。塞进来的常常是"节点刚建好、数据还没到"
       的空对象（rack_data.value 还是 ""/{}），它没有 slots 是**应该的**，
       不是"用户把素材全删了"。

       无条件重建的后果，日志里已经抓到了：`媒体架 load 恢复: cur= slots首图=(空)`。
       满架面被清成空架 → renderImages/rebuildMedia 立刻全量重绘（缩略图重新
       解码）→ 紧接着 hydrate 又灌回来再画一遍，空↔满来回画，用户看到的就是
       「架子一直在闪」。更坏的是这中间只要有一次 commit，空架面就落进了段记忆
       （`segs=clip_0001→(空)`），刷新后素材真的没了。

       显式清空一律走 emptyRack()（它带 slots），切段/灌库也都走 force=true，
       因此这道保护不会让"删素材"变得删不掉。 */
    const hasSlots = !!(d.slots && typeof d.slots === "object" && !Array.isArray(d.slots));
    if (hasSlots) {
      ui.st.slots.images = revive("images");
      ui.st.slots.videos = revive("videos");
      ui.st.slots.audios = revive("audios");
    }
    /* 节点级设置恢复：帧率 / 音频输出编号（老存档没有这两个字段 = 全默认）。
       同上面一条：没有这两个字段 ≠ 归零，只有显式空架（emptyRack 带 slots）
       才当作用户清零。否则一次空 load 就把用户设的帧率抹成自动。 */
    const f = Number(d.fps);
    if (f > 0) ui.st.fps = f;
    else if (hasSlots) ui.st.fps = 0;
    const a = parseInt(d.audio_out, 10);
    if (a > 0) ui.st.audio_out = Math.min(a, MAX_SLOTS);
    else if (hasSlots) ui.st.audio_out = 0;
    ui.fpsIn.value = ui.st.fps > 0 ? ui.st.fps : "";
    ui.audIn.value = ui.st.audio_out > 0 ? ui.st.audio_out : "";
    /* 恢复存档后同步音频编号的自愈基准：当前指向的文件 */
    ui.setAudioBaseline(ui.st.audio_out > 0 ? ui.st.slots.videos[ui.st.audio_out - 1] : null);
    /* 分段记忆随存档一起回来（老存档没有这两个字段 = 全片共用一套素材）
       ⚠ 只有 raw 里**真的带了**才覆盖 —— 塞进来的常常是**某一段的素材快照**
       （shots[i].rack / segs[key]，里面只有 slots/fps/audio_out），它没有
       segs/cur 是**应该的**，不是"清空"。无条件写会让 cur 变成 ""，下一次
       切段时 `if (ui.st.cur) segs[旧段] = snapshot()` 整段跳过 —— 上一段刚
       摆好的素材当场蒸发（20261012「另外两段的图存不住」的根因）。 */
    if (d.segs && typeof d.segs === "object" && !Array.isArray(d.segs)) ui.st.segs = d.segs;
    if (typeof d.cur === "string" && d.cur) ui.st.cur = d.cur;
    /* 全片共用标记同上面两条一样的道理：段素材快照里没有它是**应该的**，
       不是"用户关掉了共用"。无条件写会把共用抹成按段记忆。 */
    if (typeof d.shared === "boolean") ui.st.shared = d.shared;
    console.log("[联动] 媒体架 load 恢复: cur=" + ui.st.cur + " slots首图=" + firstImg(ui.st)
      + " segs=" + Object.keys(ui.st.segs).map((k) => k + "→" + firstImg(ui.st.segs[k])).join(" ")
      + (hasSlots ? "" : "（空快照：没有 slots 字段）"));
    /* 空快照 + 架面本来就有素材 = 这次 load 什么都没改。既不要推倒重画
       （缩略图重新解码 = 肉眼可见的一闪），也不要 fit（面板高度再抖一次）。
       只把段芯片文字对齐就走。显式切段 / 灌库 / 清空都带 force，不受影响。 */
    if (!hasSlots && !force && firstImg(ui.st)) { syncSegChip(); return; }
    syncSegChip();
    ui.renderImages();
    ui.rebuildMedia();
  }

  /* 跟随导演台（20261012 方案B：零轮询）：
     · 导演台本地切段/新建工程 → bz:cast-seg-change 事件即时响应；
     · 后端档案 current 变化（含其他标签页、工作流执行中的登记）
       → bz_store 的 film 快照事件即时响应。
     两条都是事件驱动，不再有任何 setInterval 轮询。 */
  let lastGen = null;
  let storeName = "";
  let offStore = null;
  function ensureStoreSub() {
    const p = castProject(ui.node);
    const name = (p && p.name) || "";
    if (name === storeName) return;
    if (offStore) { try { offStore(); } catch (_) {} offStore = null; }
    storeName = name;
    if (!name) return;
    offStore = bzStore.subscribe(name, (d) => {
      if (ui.node.flags?.collapsed || !d.film) return;
      /* 后端权威 current：与架上当前段不一致就切（导演台还没认段的空段不切） */
      const id = String(d.film.current || d.film.head || "");
      /* ⚠ 必须是 ui.st.cur：裸 st 在本作用域不存在，ES 模块严格模式下必抛
         ReferenceError。它在 store 事件派发链里抛出会炸掉同事件后续所有订阅者
         （文案台/时间轴），并中断 setCurrent 里 optimisticCurrent 之后的
         cast 事件广播 ——「运行完成后点段全不联动」的根因（20261012）。 */
      if (id && id !== ui.st.cur) switchSeg(id);
    });
  }
  ensureStoreSub();

  /* 事件即时通道：导演台广播切段/新建工程 → 立刻换素材或清空。 */
  const offCast = onCastChange((d) => {
    console.log("[联动] 媒体架收到", d.reason || "?", "name=" + (d.name || ""), "clip=" + (d.clip || ""), "折叠=" + !!ui.node.flags?.collapsed);
    if (ui.node.flags?.collapsed) { console.warn("[联动] 媒体架跳过: 节点折叠"); return; }
    const p = castProject(ui.node);
    if (!p || !p.name || d.name !== p.name) { console.warn("[联动] 媒体架跳过: 名字不匹配 d.name=" + (d.name || "") + " cp.name=" + (p && p.name || "无")); return; }
    if (d.reason === "project") {
      lastGen = d.gen || lastGen || 0;
      load(emptyRack(), true);
      /* 新工程 = 从零开始，分段记忆一并清零。load() 现在只在 raw 真的带了
         segs/cur 时才动它们，所以这里必须显式清 —— 否则会带着上一部片子的
         段记忆进入新工程。 */
      ui.st.segs = {};
      ui.st.cur = "";
      ui.commit();
      ensureStoreSub();
      return;
    }
    ensureStoreSub();
    if (d.clip) {
      /* 段没变、架上又有素材 → 这一条广播没有新信息，跳过整轮 B1 对账
         （pullSeg + 62 张签名比对 + 重架素材条）。与 store 订阅通道口径对齐
         —— 那边本来就有 `id !== ui.st.cur` 的判断（20261022）。
         架上空着时不跳过：那时 switchSeg 的中央对账正是把素材拉回来的路。 */
      const mem = ui.st.segs && ui.st.segs[ui.st.cur];
      if (String(d.clip) === String(ui.st.cur) && rackHasFile(mem)) {
        console.log("[联动] 媒体架跳过: 段没变且架上已有素材", d.clip);
        return;
      }
      switchSeg(String(d.clip));
    } else syncSegChip();
  });

  ui.snapshot = snapshot;
  ui.switchSeg = switchSeg;
  ui.setShared = setShared;
  ui.loadSeg = loadSeg;
  ui.copySegRack = copySeg;
  ui.claimSegRack = claimSeg;
  ui.dropSeg = dropSeg;
  ui.syncSegChip = syncSegChip;
  ui.load = load;
  ui.hydrateRacks = hydrateRacks;
  /* 给别的段落库。「排全部段」要写的是其余 7 段，而 ui.commit 只认当前段。 */
  ui.saveSegRack = scheduleRackSave;

  /* 包装 commit：媒体架任何改动（摆图/删槽/裁剪/帧率/音频号）都收口在
     commit，原逻辑之后把**当前编辑段**防抖落库。installSeg 晚于 buildUI
     里 commit 的定义，这里包一层安全。 */
  const _origCommit = ui.commit;
  ui.commit = function () {
    const r = _origCommit.apply(this, arguments);
    if (ui.st && ui.st.cur) {
      /* 实时收口：经中央 projectStore 把当前架面写入段记忆 segs[cur]，
         不等切段离开才快照——消除"摆图后、切段前 segs[cur] 偏旧"的窗口。
         （切段时 switchSeg 仍会 clone 成最终权威副本，内容一致。） */
      projectStore.captureRack(ui.node);
      scheduleRackSave(ui.st.cur);
    }
    return r;
  };

  ui.destroySegPoll = () => {
    Object.keys(rackSaveTimers).forEach((k) => clearTimeout(rackSaveTimers[k]));
    if (offStore) { try { offStore(); } catch (_) {} offStore = null; }
    offCast();
  };
}
