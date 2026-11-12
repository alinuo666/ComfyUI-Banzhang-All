import { api } from "../../scripts/api.js";
import { rackNodeOf, rackSlotsOf, emitCastChange, deskNodeOf } from "./bz_rack.js";
import { blankState } from "./csglide_cast_core.js";
import { fieldText } from "./csglide_prompt_check.js";

/* ============================================================
 * 分段 与 上一份副本（.bak）
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installShots(ui) {
  /* ---- shots: several shots in one project --------------------------
   *
   * A film is a list of shots that mostly share their references, so a file
   * per shot loses the relationship and repeats the work. A project holds
   * the shot states together.
   *
   * The single-shot Save / Save as / Save packed / Load buttons are NOT
   * touched: every existing .h3.json and .h3pack keeps loading exactly as
   * before, and a project is a separate file with its own two buttons.
   *
   * Shots live in node.properties, which LiteGraph serialises with the
   * workflow. A project therefore survives a browser reload without ever
   * being written to disk -- the file is for moving it somewhere else, not
   * for not losing it.
   *
   * Media is referenced by filename, as in .h3.json. There is no packed
   * project yet: the files have to still be in ComfyUI's input folder.
   */

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 9);

  function proj() {
    ui.node.properties = ui.node.properties || {};
    let p = ui.node.properties.gcast_project;
    if (!p) {
      /* gen 也要给上：文案台靠 gen 判断"是不是新建了整片"，空壳里缺 gen 会被
         读成 0，而真实代际可能是 19 —— 0 !== 19 就被误判成换片子、整份段词被
         清空（20261022「刷新后提示词闪一下就没了」）。 */
      p = { name: "", shots: [], idx: -1, gen: 0 };
      ui.node.properties.gcast_project = p;
      return p;
    }
    /* 只补缺失字段，**绝不换掉整个对象**（20261022）。原来这里只要
       shots 不是数组，就把 gcast_project 整个替换成 {name:"",shots:[],idx:-1}
       —— 一个"读"函数在销毁数据：片名、段、gen 一起丢。存档来自旧版插件
       或被手改过时 gcast_project 可能缺字段，补默认值即可，不能连坐原数据。
       （与文案台"拉不到就当空正是丢词的标准姿势"是同一种病。） */
    if (!Array.isArray(p.shots)) p.shots = [];
    if (typeof p.idx !== "number") p.idx = -1;
    if (typeof p.name !== "string") p.name = "";
    return p;
  }

  /* 20261026：还原点 / 撤销 / 重做 整套删除（用户定）。
     删掉的不只是轴头那颗按钮：本地 10 点环、中央镜像回填（B2）、
     重做的"未来栈"、undoProject/redoProject/undoInfo/paintUndoBtns 一起下线。
     **代价（必须知道）**：新建工程 / 打开工程 / 删段 / 拆分 / 渲染全部
     之前不再存还原点，这些操作从此不可逆。误点一次就没了 —— 想留后路请先
     「另存工程文件」。为什么不做成"只删入口、保留还原点"：那样还原点只进不出，
     白占 node.properties 撑大工作流 JSON，且界面上的"可撤销"全变成假话。
     相关调用点（8 个文件 20 处）已同步删除。 */


  /* 这份架况里到底有没有素材（图片/视频/音频任一有 file 就算）。
     「segs[key] 存在」不等于「有素材」——空快照也是对象，靠它判断会不会
     把本来该灌回的素材挡在门外，这一段就永远空着。 */
  function rackHasFile(rack) {
    const s = (rack && rack.slots) || {};
    for (const k of ["images", "videos", "audios"]) {
      const arr = Array.isArray(s[k]) ? s[k] : [];
      if (arr.some((x) => x && x.file)) return true;
    }
    return false;
  }

  /* 媒体架的分段快照。素材住在「H3 媒体架」节点里，现在跟着分段一起记：
   * 每段存一份当时的完整架况（槽位引用 + 裁剪窗 + 别名 + 帧率 + 音频输出
   * 编号），切换、打开、渲染时倒回，各段互不串台。只记引用不复制文件——
   * 要连文件一起走请用「打包」。没接媒体架时返回 null、字段不写：那是
   * 「当时没有媒体架」，不是「媒体架空着」。 */
  /* 把媒体架段记忆里的某段整理成标准快照（无料/不存在返回 null）。 */
  function segMemSnap(rn, key) {
    const mst = rn.gmr && rn.gmr.st;
    if (!key || !mst || !mst.segs) return null;
    const v = mst.segs[key];
    if (!v || !rackHasFile(v)) return null;
    return {
      slots: (v.slots && typeof v.slots === "object")
        ? JSON.parse(JSON.stringify(v.slots))
        : { images: [], videos: [], audios: [] },
      fps: v.fps || 0,
      audio_out: v.audio_out || 0,
    };
  }

  /* 从 rack_data widget 序列化值构造「当前架面」快照（无料返回 null）。 */
  function widgetSnap(rn) {
    const raw = (rn.widgets && rn.widgets.find((x) => x.name === "rack_data")?.value) || "";
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      if (!d || typeof d !== "object") return null;
      /* 只取「这一段」的槽位快照，剥离 segs / cur —— 那是媒体架的全局状态
         （各段记忆 + 当前编辑段），不是某一段的素材。整份塞进 shots[i].rack
         再经 loadSeg 灌回，会把全局 segs/cur 当成段快照回写，各段快照被互相
         污染成同一份（20261012「点第1段显示第3段」的串台根因）。 */
      const snap = {
        slots: (d.slots && typeof d.slots === "object")
          ? JSON.parse(JSON.stringify(d.slots))
          : { images: [], videos: [], audios: [] },
        fps: d.fps || 0,
        audio_out: d.audio_out || 0,
      };
      /* 段级素材防丢（20261012「渲染后每段只剩片级首图」）：widget 序列化值
         可能偏旧（热重载旧实例、load 签名去重等），媒体架**内存**里当前段
         的槽位可能比 widget 全。只在媒体架当前认的段 == 导演台当前段时补齐
         （防止把别的段素材错补进来），只补不删。 */
      try {
        const mst = rn.gmr && rn.gmr.st;
        const curClip = (ui.st && ui.st.chain && ui.st.chain.clip) || "";
        if (mst && curClip && String(mst.cur) === String(curClip)) {
          const mem = (mst.segs && mst.segs[mst.cur]) || null;
          mergeRackSlots(snap.slots, mem ? mem.slots : mst.slots);
        }
      } catch (e) { console.warn("[H3 Studio] rackSnapshot 内存补齐失败(忽略)：", e); }
      /* 空架况（一个素材都没有）不存为快照 —— 空 object 一旦写进
         shots[i].rack，restoreShotRack 就会把它当成"这一段就是空的"权威副本，
         在用户刚摆图还没切段时把图盖掉。复制段走的是整份 shot 克隆，不经过这里。 */
      if (!rackHasFile(snap)) return null;
      return snap;
    } catch (_) { return null; }
  }

  function rackSnapshot(cid) {
    const rn = rackNodeOf(ui.node);
    if (!rn) return null;
    const keyCid = cid ? String(cid) : "";
    /* 带段身份（stash 切段用）：onPick 后 set_current 广播会让媒体架**先于**
       导演台 switchTo 把架面切到新段 —— 此时再读"当前架面" widget，读到的是
       新段的图，却写进旧段的 shots[i].rack；下一次切回旧段，restoreShotRack
       拿着新段的图把旧段盖住（20261013 日志铁证：段2 被存成段3 的图，两图
       对调、快速切段后三段全变成同一张）。segs[cid] 是媒体架按段身份记的账、
       switchSeg 离开旧段时第一时间写入，与架面现在停在哪无关，是竞态免疫通道。 */
    if (keyCid) {
      const mst = rn.gmr && rn.gmr.st;
      /* 全片共用（媒体架 setShared 打开）：整片就一副架面，**不存在"停在哪一段"**，
         也没有按段的记忆 —— 架面此刻的 widget 就是所有段的权威，直接读它。
         20261025 用户现场：共用模式下 st.cur 是空串，被下面那条"停在别的段"
         判定接手 → 只信段记忆 → 共用模式根本没有段记忆（st.segs 为空时一条都
         写不进去，见 csglide_media_rack.js:158）→ 返回 null → bz_prompt_build
         按"空素材"编译 → 参考图全丢。症状是**媒体架显示"本段用 3"、
         导演台却报"本段媒体架槽位为空"**，两边打架，就是这条。 */
      if (mst && mst.shared) return widgetSnap(rn) || segMemSnap(rn, keyCid);
      /* 架面已停在别的段：widget 是别的段的，绝不能碰，只信段记忆；记忆空就
         如实返回 null（"这一段没素材"），不能拿别段/空架面填。
         注意 cur 为空 = "还没停在任何段"，不是"停在别的段"，此时不存在串段
         风险，照常读架面。 */
      if (mst && mst.cur && String(mst.cur) !== keyCid) return segMemSnap(rn, keyCid);
      /* 架面正好停在该段：widget 可能比段记忆新（刚摆图、切段尚未发生），读
         widget，再用段记忆只补不删；widget 没值时段记忆也能救回来。 */
      const segMem = segMemSnap(rn, keyCid);
      const snap = widgetSnap(rn);
      if (snap && segMem) mergeRackSlots(snap.slots, segMem.slots);
      return snap || segMem;
    }
    /* 无 cid（addShot / 复制 / 渲染等）：架面就停在目标段，读当前架面。 */
    return widgetSnap(rn);
  }

  /* 槽位补齐：dst（widget 序列化值）里**空着**、src（媒体架内存段记忆/当前
     架面）同槽位**有 file** 时，把 src 的条目深拷贝补进 dst；dst 已有的条目
     一律不动，src 多出的尾部条目追加。只补不删、按槽位对齐 —— widget 值
     偏旧时抢救段级素材用，绝不反向覆盖。 */
  function mergeRackSlots(dst, src) {
    if (!dst || !src) return;
    for (const kind of ["images", "videos", "audios"]) {
      if (!Array.isArray(dst[kind])) dst[kind] = [];
      const s = Array.isArray(src[kind]) ? src[kind] : [];
      for (let i = 0; i < s.length; i++) {
        const sv = s[i];
        if (!sv || !sv.file) continue;
        if (i < dst[kind].length) {
          if (!dst[kind][i] || !dst[kind][i].file) dst[kind][i] = JSON.parse(JSON.stringify(sv));
        } else {
          dst[kind].push(JSON.parse(JSON.stringify(sv)));
        }
      }
    }
  }

  /* 把分段存的快照倒回媒体架。没有快照就一动不动——老工程、建段时没接
   * 媒体架的分段都没有这个字段，绝不能拿空快照把用户现在摆好的素材清掉。
   * 20261012：走 loadSeg 连同段身份一起认（segs[key]=快照、cur=key）——
   * 旧实现只 load 快照，cur 被置空，1~2 秒后媒体架轮询发现档案 current 是
   * 新段、自己又没存它的快照，照清空不误，参考图"复制/接段后闪一下消失"。 */
  /* 媒体架热重载旧实例警示只弹一次（本次页面生命周期内）。 */
  let warnedStaleRack = false;
  function restoreShotRack(shot) {
    const rn = rackNodeOf(ui.node);
    if (!rn || !rn.gmr || !shot || !shot.rack || typeof shot.rack !== "object") return;
    /* 全片共用：整片一副架面，不属于任何一段。switchSeg 已经早退，这里必须
       同样早退 —— 否则共用模式 cur 为空、onKey 恒 false，会拿某一段的快照
       灌回架面，切段后仍显示第一段的图片引用。 */
    if (rn.gmr.st && rn.gmr.st.shared) return;
    const key = shot.clip || shot.id;
    const st = rn.gmr.st || {};
    const mem = st.segs ? st.segs[key] : null;
    const onKey = st.cur === key;
    const memHasFile = !!(mem && rackHasFile(mem));
    const snapHasFile = rackHasFile(shot.rack);
    /* 媒体架自己已经记着这一段 **且那段记忆里确实有素材**、人也在本段 →
       以媒体架为准，不拿工程快照覆盖。工程快照（shots[i].rack）可能是素材
       串台时期存下的脏副本 —— 无条件灌回会把用户摆好的素材又盖成旧图，
       渲染三段全用同一张参考图（20261012 渲染日志铁证：三段参考图都是
       0039.png）。
       还必须**人就在这一段上**（st.cur === key）：架子的 cur 可能被别处
       切走 —— store 订阅（后端 current 变化 / 另一个标签页点的段）和
       setCurrent 广播都不受渲染循环支配。只判记忆不判 cur，架子停在别段时
       这一行直接 return，渲染就会拿着别段的素材提交。 */
    if (onKey && memHasFile) return;
    /* 空快照（字段在、三类槽位一个 file 都没有）永不灌入：它是建段时架子
       空着记下的，用户却可能刚在这一段摆了图、还没来得及切段 stash。空灌
       零收益，只会把刚摆的素材清掉，随后到达的 switch 广播还会把空架面
       固化进段记忆（20261012 日志铁证：摆图→onPick 一圈，图被空快照盖没、
       segs 里也变空）。
       - 人在本段：架面以当前操作为准，一动不动；
       - 人不在段但记忆有料：切回本段让记忆上屏（switchSeg 先存好当前段）；
       - 人不在段、记忆也空：本来就是空，什么都不用做。 */
    if (!snapHasFile) {
      if (!onKey && memHasFile && typeof rn.gmr.switchSeg === "function") {
        try { rn.gmr.switchSeg(key); } catch (e) {
          console.warn("[联动] 导演台 restoreShotRack 切回段失败(忽略):", e);
        }
      }
      return;
    }
    const fi = (() => { try { const s = (shot.rack && shot.rack.slots) || {}; const imgs = s.images || []; return (imgs[0] && imgs[0].file) ? imgs[0].file.split(/[\\/]/).pop() : "(空)"; } catch (_) { return "(err)"; } })();
    console.log("[联动] 导演台 restoreShotRack: key=" + key + " shot.id=" + (shot && shot.id) + " rack首图=" + fi);
    try {
      if (memHasFile && typeof rn.gmr.switchSeg === "function") {
        /* 记忆有料但人不在段上 → 切回本段：switchSeg 先存好当前段、再灌本段记忆 */
        rn.gmr.switchSeg(key);
      } else if (typeof rn.gmr.loadSeg === "function") {
        rn.gmr.loadSeg(key, shot.rack);
      } else {
        /* 旧实例兜底：媒体架节点是热重载前创建的（热重载只重注册扩展，不重跑
           onNodeCreated，node.gmr 停在旧 bag：有 load 无 loadSeg/switchSeg）。
           这条路径不认段身份，是段级素材被污染的直接诱因，所以：
           ①load 必须 force=true —— 否则撞签名去重（load 内 sig===lastLoadSig
           直接 return），灌快照被静默跳过，架面停在上一段；
           ②红字常驻提示硬刷新（只提示一次，不刷屏），混搭状态下继续摆素材
           仍可能丢，必须让用户知道要 Ctrl+F5。 */
        rn.gmr.load(shot.rack, true);
        if (typeof rn.gmr.commit === "function") rn.gmr.commit();
        if (!warnedStaleRack) {
          warnedStaleRack = true;
          const msg = "检测到媒体架节点是热重载前的旧实例（缺段记忆接口），段素材联动可能错乱 —— 请按 Ctrl+F5 硬刷新页面后再摆素材/渲染";
          console.warn("[H3 Studio]", msg);
          try {
            const h = ui.flashBar;
            if (h) { h.textContent = msg; h.title = msg; h.classList.add("on"); }
          } catch (_) {}
        }
      }
    } catch (e) {
      /* 倒回素材只是"把架子摆到位"的辅助动作，炸在这里会让整轮「全部渲染」
         停在半路（20261012 NotFoundError 铁证：第 2 段处中断）。失败就记一笔
         继续跑，本段该用的素材仍以媒体架当前架况提交，不牵连后面几段。 */
      console.warn("[联动] 导演台 restoreShotRack 失败(已忽略，不影响渲染):", e);
    }
  }

  /* 当前段/工程身份变化的即时广播：媒体架、文案台、Qwen 台监听后立刻切段，
     不再等 0.8~1.5 秒轮询（轮询保留为 3 秒兜底）。 */
  /* 上一条广播的签名。广播表达的是「当前段发生了变化」这个事实 —— 同一个事实
     不该发第二次：导演台自愈补登记、段登记、切段常常在同一段上连发好几条
     （20261022 现场：同一段连发 3 条，媒体架/文案台跟着跑了 3 遍 B1 全量对账
     和素材条重建）。签名里带上 reason：新建工程/切段这类语义不同的事件即使
     段身份没变也照发。 */
  let lastBcastSig = "";
  function broadcastSeg(reason) {
    try {
      const p = proj();
      const shot = p.shots[p.idx];
      const why = reason || "seg";
      const sig = [ui.castName() || "", (shot && shot.clip) || "",
        (shot && shot.id) || "", p.idx, p.gen || 0, why].join("|");
      if (sig === lastBcastSig) return;
      lastBcastSig = sig;
      emitCastChange({
        name: ui.castName() || "",
        clip: (shot && shot.clip) || "",
        shot: (shot && shot.id) || "",
        idx: p.idx, gen: p.gen || 0,
        reason: why,
      });
    } catch (_) { /* 广播失败退回轮询，不挡操作 */ }
  }

  /* Autosave. The shot being left is written back before anything else
   * happens, so browsing the list can never cost an edit. */
  function stash() {
    const p = proj();
    if (p.idx >= 0 && p.shots[p.idx]) {
      p.shots[p.idx].state = clone(ui.st);
      const cid = (ui.st && ui.st.chain && ui.st.chain.clip) || p.shots[p.idx].clip;
      /* 媒体架跟段走：必须按**段身份**取快照（20261013 两图对调根因）。
         媒体架收到 set_current 广播会先于导演台 switchTo 把架面切到新段，
         此时读"当前架面"会读到新段的图、写进旧段 shot.rack；传 cid 后
         rackSnapshot 从媒体架段记忆 segs[cid] 取，免疫架面停在哪。 */
      const snap = rackSnapshot(cid);
      if (snap) p.shots[p.idx].rack = snap;
      else delete p.shots[p.idx].rack;
      /* 有 clip id 就把完整面板防抖落盘（工程库 / 重启可恢复） */
      if (cid && ui.persistClipState) ui.persistClipState(cid, p.shots[p.idx].state);
    }
  }

  /* Vocabulary, kept straight on purpose: a CLIP is one generation, and a clip
   * can contain several SHOTS - the [Shot N] markers the model cuts on. The
   * project list talks about clips; the timeline strip talks about shots.
   * Internals and the file format still say "shots" so old projects load. */
  const shotLabel = (s, i) => s.name || `分段 ${i + 1}`;


  /* A new shot in a film usually reuses the same cast and location, so it
   * starts from the current one. The prompt does not carry over -- except
   * subject_definitions, which describes the references that just came with
   * it and would only be retyped. */
  function inheritedState() {
    const s = clone(ui.st);
    const subs = fieldText(ui.effPrompt(), "subject_definitions");
    s.prompt = subs ? `subject_definitions:\n${subs}\n\n` : "";
    return s;
  }

  /* 新分段的段身份必须是**新的**：clip（档案里的 id）与 shot（分段 uid）都
     不能从上一段继承过来。
     clip 尤其危险 —— 后端认段的优先级是「clip id → shot id → 新建」，顶着
     上一段的 clip id 去登记/渲染，等于把上一段的档案整段覆盖掉。
     抽成一个函数：新建分段有两条路径（接一段 / 把屏幕内容变成第 1 段），
     漏掉任何一条都会留下同一个坑。 */
  function detachChain(s) {
    s.chain = {
      name: (s.chain && s.chain.name) || "",
      clip: "",
      shot: uid(),
    };
    return s;
  }

  /* The first Add turns what is on screen into Shot 1 rather than losing it. */
  function seedFromScreen(p) {
    if (p.shots.length === 0 && p.idx < 0) {
      const s = detachChain(clone(ui.st));
      normalizeNewShotCont(s);
      const shot = { id: uid(), name: "", state: s };
      const snap = rackSnapshot();
      if (snap) shot.rack = snap;
      p.shots.push(shot);
      p.idx = 0;
    }
  }

  /* 「任何工程都至少有一段」的唯一守卫（20261108 扩展成不变量）。
     时间轴画的是档案里的段：只往 p.shots 塞对象，轴上什么都不会出现，
     所以造完必须登记。以前只处理「新建节点 + 0 段」，片名没起来或档案
     登记没跟上时轴就空 —— 用户看到的是「段偶尔全没了」。
     三条洞各补一次：
       · 缺片名 → 先补名（幂等，内部有 fromState 保护，不会顶掉已存工程）；
       · 0 段 → 造默认段并登记（原逻辑）；
       · 有段但没绑 clip、且档案确实空 → 只给没 clip 的段登记。
     绝不主动清空 shot.clip：20261025 血案（一段变两段，不可逆）。
     clipCount=-1 = 档案还没读回，此时不判，等 refresh 完成后再来。
     登记失败当场收回，下次 boot 重来，不留半成品段。 */
  let ensuringFirst = false;
  async function ensureFirstShot() {
    if (ensuringFirst) return;
    const p = proj();
    if (!(p.name || "").trim() && typeof ui.ensureProjectName === "function") {
      ui.ensureProjectName();
    }
    if (!(p.name || "").trim()) return;
    if (typeof ui.registerShot !== "function") return;
    ensuringFirst = true;
    try {
      /* 0 段：seedFromScreen 要求 idx < 0 才动手，显式归位，
         避免「删光所有段后 idx 残留 0」把它挡掉。 */
      if (!p.shots.length) {
        p.idx = -1;
        seedFromScreen(p);
        const shot = p.shots[0];
        if (!shot) return;
        ui.commit();
        ui.paintSegTools();
        await ui.registerShot(shot);
        if (!shot.clip) {
          p.shots = [];
          p.idx = -1;
          ui.commit();
          ui.paintSegTools();
          return;
        }
        broadcastSeg("seg");
        return;
      }
      /* 有段：只在「档案一段都没有」时给没绑定的段补登记。
         有 clip 的段绝不碰；档案未读回（-1）或已有段（>0）都交给对账。 */
      const cn = (ui.monitor && ui.monitor.clipCount) ? ui.monitor.clipCount() : -1;
      if (cn !== 0) return;
      const pending = p.shots.filter((s) => s && !s.clip);
      if (!pending.length) return;
      for (const shot of pending) await ui.registerShot(shot);
      if (p.shots.some((s) => s && s.clip)) {
        ui.commit();
        ui.paintSegTools();
        broadcastSeg("seg");
      }
    } finally {
      ensuringFirst = false;
    }
  }

  /* 新分段默认潜空间续写（工程链路的常规档位）；继承了明确文件来源的
   * （用户手动引用过的文件窗口）保持文件档不动。只用于新建分段，
   * 载入老工程不走这里——老工程没有续写信息时仍按文件档，行为逐帧不变。 */
  function normalizeNewShotCont(s, hasPrev) {
    if (!(s.cont && s.cont.file)) {
      s.cont = Object.assign({}, s.cont, { mode: "latent" });
    }
    if (hasPrev) {
      /* 第 2+ 段：默认**承接 22 帧**（20261107 用户定：MV 要每段平滑衔接，
         旧的 0 = 独立成段，导入音频排段后续接胶囊全置灰、段与段硬切）。
         22 是承接帧数预设档位（5/22/39/56）之一，比旧出厂默认 39 轻。
         要独立成段就把这一段的「承接帧数」调回 0。
         latent_file 不能继承（那是上段的续拍存档身份，渲染前 cast_run 会按段序
         重新认领本段该接的那一版）。 */
      delete s.cont.latent_file;
      s.cont.frames = 22;
    }
  }

  /* 无工程名先拦下（消灭"点了没反应"）：档案按片名建目录，没名字就登记不进
     档案，轴上永远不会出现块 —— 与其"加了段却看不见"，不如先让你把名字填了。
     拦下的同时把焦点直接交到工程名输入框上，用户不用自己找那一格。 */
  function requireName() {
    if ((ui.castName() || "").trim()) return true;
    ui.lanesFlash("还没填工程名 —— 已把光标放到工程名上，填好再点「＋」，段会立刻登记上轴");
    ui.focusProjName?.();
    return false;
  }

  async function addShot(blank) {
    /* 整条链包进 try：这条按钮是「点了到底有没有反应」的最高频质疑点，
       任何一步炸掉都不能再静默 —— 静默 = 用户以为面板坏了，而控制台他没开。 */
    if (!requireName()) return null;
    try {
      const p = proj();
      stash();
      seedFromScreen(p);
      const s = detachChain(blank ? blankState() : inheritedState());
      /* seedFromScreen 已保证工程里至少有一段，所以新段恒为第 2+ 段，
         默认潜空间顺序续写 22 帧（20261108 与全局段间接续默认对齐）。 */
      normalizeNewShotCont(s, true);
      const shot = { id: uid(), name: "", state: s };
      /* 新分段继承当前媒体架（与"继承班底"同一逻辑：班底跟着段走） */
      const snap = rackSnapshot();
      if (snap) shot.rack = snap;
      p.shots.push(shot);
      p.idx = p.shots.length - 1;
      /* 立刻把继承的架况灌进媒体架并认段（旧实现漏这一步，要等 1~2 秒
         轮询，且轮询发现新段无记忆会把参考清空 —— 20261012）。 */
      ui.restoreShotRack(shot);
      ui.load(JSON.stringify(s));
      ui.commit();
      ui.paintSegTools();
      broadcastSeg("seg");
      /* 立刻给一句可见反馈。它同时是一块试金石：点了连这句都没有，
         说明浏览器里跑的还是旧脚本 —— 强刷一次（Ctrl+F5）。 */
      ui.lanesFlash(`已接第 ${p.shots.length} 段 —— 正在登记档案…`);
      /* 登记进档案 —— 时间轴画的是**档案里的段**（film_summary 走 chain 的
         order），只往 p.shots 里塞一个对象，轴上什么都不会出现。
         加段=登记（20261103 身份不变量）：**等它登记完**，拿不到 clip 就当场
         收回。旧行为是留一段没绑定的半成品在轴上，等渲染时后端静默新建一段
         兜底 —— 用户看到的「3 段跑完变 4 段 + 成片收不上轴」就是这么来的。
         现在后端那扇兜底门已关（执行认不出段直接拦下报错），半成品段更不该留。 */
      await ui.registerShot(shot);
      if (!shot.clip) {
        const at = p.shots.indexOf(shot);
        if (at >= 0) p.shots.splice(at, 1);
        p.idx = p.shots.length ? Math.min(Math.max(0, at - 1), p.shots.length - 1) : -1;
        if (ui.dropRackSeg) { ui.dropRackSeg(shot.id); }
        const back = p.shots[p.idx];
        if (back) {
          ui.restoreShotRack(back);
          try { ui.load(JSON.stringify(back.state || {})); } catch (_) { /* 面板未就绪 */ }
        }
        ui.commit();
        ui.paintSegTools();
        broadcastSeg("seg");
        ui.lanesFlash(`第 ${at + 1} 段没能登记进档案 —— 已收回，不留没绑定的半成品段。`
          + "确认服务端正常后重新接一段");
        return null;
      }
      /* 给「补齐 N 段」这类批量入口一个可判的返回值：拿不到段就停，别往下硬补。 */
      return shot;
    } catch (e) {
      console.error("[H3 Studio] 接一段失败：", e);
      ui.lanesFlash("接一段失败：" + (e && e.message ? e.message : e)
        + "（详情在浏览器控制台 F12）");
      return null;
    }
  }


  /** 在第 i 段后面插一段（接缝「＋」的落点，方案 D）。
      新段克隆左边那段做底（班底/画布/时长照抄），续写默认潜空间 22 帧 ——
      它本来就是"接着左边那段继续演"的产物。add_clip 恒追加在档案末尾，
      插在中段必须把档案顺序与工程对齐一次（syncArchiveOrder），否则轴上
      错位。 */
  async function insertShot(i) {
    if (!requireName()) return;
    try {
      const p = proj();
      stash();
      const base = p.shots[i] || null;
      const s = detachChain(clone(base ? (base.state || {}) : blankState()));
      s.prompt = "";
      s.slots = blankState().slots;
      s.cont = { mode: "latent", frames: 22 };
      const shot = { id: uid(), name: "", state: s };
      p.shots.splice(i + 1, 0, shot);
      p.idx = i + 1;
      /* 全片共用：整片一副架面，插段不该清空它 —— 否则参考图凭空消失。
         按段记忆模式仍按原样清空新段，让用户自己摆图。 */
      const rn = rackNodeOf(ui.node);
      const sharedRack = !!(rn && rn.gmr && rn.gmr.st && rn.gmr.st.shared);
      if (!sharedRack) clearRackSeg(shot.id);
      copyDeskSeg("", shot.id);
      ui.load(JSON.stringify(s));
      ui.commit();
      ui.paintSegTools();
      ui.lanesFlash(`已插入第 ${i + 2} 段（承接第 ${i + 1} 段）—— 正在绑定中央段…`);
      const receipt = await bindShotSegment(
        shot, "insert_after", base ? (base.clip || base.id) : "");
      await ui.syncArchiveOrder();
      ui.paintSegTools();
      return receipt;
    } catch (e) {
      console.error("[H3 Studio] 插入分段失败：", e);
      ui.lanesFlash("插入分段失败：" + (e && e.message ? e.message : e)
        + "（详情在浏览器控制台 F12）");
    }
  }


  function emptyRackSnap() {
    return { slots: { images: [], videos: [], audios: [] }, fps: 0, audio_out: 0 };
  }

  function clearRackSeg(key) {
    try {
      const rn = rackNodeOf(ui.node);
      if (rn && rn.gmr && typeof rn.gmr.loadSeg === "function") {
        rn.gmr.loadSeg(String(key), emptyRackSnap());
        return true;
      }
    } catch (e) {
      console.warn("[H3 Studio] 媒体架清空段失败(忽略):", e);
    }
    return false;
  }

  function copyRackSeg(srcKey, dstKey) {
    try {
      const rn = rackNodeOf(ui.node);
      if (rn && rn.gmr && typeof rn.gmr.copySeg === "function") {
        rn.gmr.copySeg(srcKey ? String(srcKey) : "", String(dstKey));
        return true;
      }
    } catch (e) {
      console.warn("[H3 Studio] 媒体架复制段失败(忽略):", e);
    }
    return false;
  }

  function claimRackSeg(shot, cid) {
    try {
      const rn = rackNodeOf(ui.node);
      if (rn && rn.gmr && typeof rn.gmr.claimSeg === "function") {
        rn.gmr.claimSeg(String(shot.id), String(cid));
        return true;
      }
    } catch (e) {
      console.warn("[H3 Studio] 媒体架段身份升级失败(忽略):", e);
    }
    return false;
  }

  function switchRackSeg(key) {
    try {
      const rn = rackNodeOf(ui.node);
      if (rn && rn.gmr && typeof rn.gmr.switchSeg === "function") {
        rn.gmr.switchSeg(String(key));
        return true;
      }
    } catch (e) {
      console.warn("[H3 Studio] 媒体架切段失败(忽略):", e);
    }
    return false;
  }

  function dropRackSeg(key) {
    try {
      const rn = rackNodeOf(ui.node);
      if (rn && rn.gmr && typeof rn.gmr.dropSeg === "function") {
        rn.gmr.dropSeg(String(key));
        return true;
      }
    } catch (e) {
      console.warn("[H3 Studio] 媒体架删段记忆失败(忽略):", e);
    }
    return false;
  }

  async function bindShotSegment(shot, action, sourceKey) {
    const name = ui.castName();
    const rn = rackNodeOf(ui.node);
    const state = clone(shot.state || {});
    let rack = emptyRackSnap();
    if (action === "duplicate") {
      if (rn && rn.gmr && rn.gmr.st && rn.gmr.st.segs && rn.gmr.st.segs[shot.id]) {
        rack = clone(rn.gmr.st.segs[shot.id]);
      } else if (shot.rack) {
        rack = clone(shot.rack);
      }
    }
    let desk_text = "";
    if (action === "duplicate") {
      const dn = deskNodeOf(ui.node);
      if (dn && dn.deskUI && typeof dn.deskUI.segWords === "function") {
        desk_text = dn.deskUI.segWords(shot.id);
      }
    }
    const body = {
      name, action, source_cid: sourceKey || "",
      shot: state.chain ? state.chain.shot : "",
      state, rack, desk_text,
      frames: state.length,
      clip_name: shot.name || "",
    };
    /* 不传 trim_frames：登记只是"把这一段记进工程"，此刻还没生成、没有任何承接
       头，档案的承接帧数只能是 0。真值由生成后的后端按本次实际承接回填
       （csglide_cast._register_clip）。传 cont.frames 会把"打算接多少"提前
       记成"已经接了 22 帧"，生成失败/没跑时成片照旧被剪头。 */
    const res = await api.fetchApi("/cglide/chain/bind_segment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || ("HTTP " + res.status));
    }
    shot.clip = data.id;
    claimRackSeg(shot, data.id);
    claimDeskSeg(shot.id, data.id);
    return data;
  }

  /* 文案台节点（导演台上游的那台）。 */
  function deskOf() {
    const dn = deskNodeOf(ui.node);
    return dn && dn.deskUI ? dn : null;
  }
  /* 文案台把源段段词抄到目标段身份（复制段提前上屏用）。 */
  function copyDeskSeg(srcCid, dstCid) {
    if (!dstCid) return;
    try {
      const dn = deskOf();
      if (dn && typeof dn.deskUI.copySeg === "function") {
        dn.deskUI.copySeg(srcCid ? String(srcCid) : "", String(dstCid));
      }
    } catch (e) { console.warn("[H3 Studio] 文案台复制段词失败(忽略):", e); }
  }
  /* 文案台临时段身份（shot.id）升级为真实 clip id。 */
  function claimDeskSeg(tempId, clipId) {
    if (!clipId) return;
    try {
      const dn = deskOf();
      if (dn && typeof dn.deskUI.claimSeg === "function") {
        dn.deskUI.claimSeg(tempId ? String(tempId) : "", String(clipId));
      }
    } catch (e) { console.warn("[H3 Studio] 文案台段身份升级失败(忽略):", e); }
  }

  /**
   * 完整复制第 i 段到工程末尾（时间轴段块悬浮条的 ⧉ 与右键菜单「复制这一段」。
   *
   * 与 addShot(继承班底) 的区别：那是"新开一段"，提示词故意只留班底定义；
   * 这是"原样克隆一段做同款连拍"——**提示词全文、画布、时长、全部生成参数、
   * 参考图照抄**（菜单/按钮提示词承诺的就是"照抄"，20261012 对齐实现）。
   * 新身份必须 detach：clip/shot uid 全新，否则会顶掉原段档案。
   * 续接档不继承：复制段物理上接在全片末尾，cont 重置为潜空间 22 帧头钉，
   * 尤其不能带上原段的 latent_file（那是别的段的续拍档，带上会认错档）。
   */
  async function duplicateShot(i) {
    if (!requireName()) return;
    try {
      const p = proj();
      const base = p.shots[i] || null;
      if (!base) return;
      stash();
      /* 完整克隆 state：不走 inheritedState()（它会把 prompt 砍成只剩班底） */
      const s = detachChain(clone(base.state || blankState()));
      normalizeNewShotCont(s);
      /* 复制段恒在末尾：只要不是工程唯一段，就按"往后接"潜空间 22 帧头钉 */
      if (p.shots.length > 0) s.cont = { mode: "latent", frames: 22 };
      const shot = { id: uid(), name: "", state: s };
      if (base.rack) shot.rack = clone(base.rack);
      /* 媒体架和文案台都先抄到临时段身份，且都是独立副本；随后再升级为真实 cid。 */
      copyRackSeg(base.clip || base.id, shot.id);
      copyDeskSeg(base.clip || base.id, shot.id);
      p.shots.push(shot);
      p.idx = p.shots.length - 1;
      /* 连同段身份一起灌架：复制后参考图必须立刻在架上，且不被随后轮询清掉 */
      if (!switchRackSeg(shot.id)) ui.restoreShotRack(shot);
      ui.load(JSON.stringify(s));
      ui.commit();
      ui.paintSegTools();
      broadcastSeg("seg");
      ui.lanesFlash(`已完整复制第 ${i + 1} 段到末尾（提示词/参考/画布/时长/参数全照抄）—— 正在绑定中央段…`);
      await bindShotSegment(shot, "duplicate", base.clip || base.id);
      ui.paintSegTools();
    } catch (e) {
      console.error("[H3 Studio] 复制分段失败：", e);
      ui.lanesFlash("复制分段失败：" + (e && e.message ? e.message : e)
        + "（详情在浏览器控制台 F12）");
    }
  }

  /** 把「只在档案里」的段**认领**回工程（20261010）。
      块在轴上就该能就地编辑 —— 认领 = 建一个绑定该 clip id 的工程分段
      （时长 / 名字 / 续接窗口照档案抄），之后双击改名、右键菜单、悬停工具条
      全部就地可用。后端认段优先 clip id，认领段渲染时照常对上同一段档案。 */
  async function claimShot(clipRow) {
    try {
      if (!clipRow || !clipRow.id) return null;
      const p = proj();
      const already = p.shots.findIndex((sh) => sh.clip === clipRow.id);
      if (already >= 0) return p.shots[already];
      stash();
      const s = detachChain(blankState());
      s.length = Math.max(5, Math.round(Number(clipRow.frames) || 124));
      const trimN = Math.max(0, Math.round(Number(clipRow.trim_frames) || 0));
      s.cont = trimN ? { mode: "latent", frames: trimN } : { mode: "latent" };
      s.chain = { name: s.chain.name || "", clip: clipRow.id, shot: String(clipRow.shot || "") };
      const autoName = `第 ${clipRow.index} 段`;
      const shot = {
        id: uid(),
        name: clipRow.name && clipRow.name !== autoName ? clipRow.name : "",
        state: s,
        clip: clipRow.id,
      };
      const snap = rackSnapshot();
      if (snap) shot.rack = snap;
      const at = Math.min(Math.max(0, (Number(clipRow.index) || 1) - 1), p.shots.length);
      p.shots.splice(at, 0, shot);
      p.idx = at;
      ui.restoreShotRack(shot);
      ui.load(JSON.stringify(s));
      ui.commit();
      ui.paintSegTools();
      ui.lanesFlash(`已认领第 ${clipRow.index} 段进工程 —— 改名 / 右键 / 续接帧数现在就地可改`);
      /* 认领后档案顺序要跟工程对齐（reorder 会重画轴）—— **等它画完再返回**：
         双击改名的输入框挂在这之后，不然会被这次重绘当场抹掉（"回车没反应"）。 */
      await ui.syncArchiveOrder();
      ui.paintSegTools();
      return shot;
    } catch (e) {
      console.error("[H3 Studio] 认领分段失败：", e);
      ui.lanesFlash("认领分段失败：" + (e && e.message ? e.message : e));
      return null;
    }
  }

  /** 删光后自动补一段**默认初始设置**的新段（20261010 用户定：时间轴永远
      保底一段）。不走 addShot —— 那条路的 seedFromScreen 会把屏幕上刚删掉
      的内容又变成第 1 段；这里要的是一张白纸：默认画布 / 默认时长 / 无参考，
      照常登记上轴。 */
  function restoreDefaultShot(silent) {
    try {
      const p = proj();
      const s = detachChain(blankState());
      normalizeNewShotCont(s);
      const shot = { id: uid(), name: "", state: s };
      p.shots.push(shot);
      p.idx = 0;
      ui.load(JSON.stringify(s));
      ui.commit();
      ui.paintSegTools();
      if (!silent) ui.lanesFlash("已补回一段默认设置的新段 —— 时间轴永远保底一段");
      void ui.registerShot(shot);
    } catch (e) {
      console.error("[H3 Studio] 补回默认段失败：", e);
    }
  }

  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { clone, uid, proj, rackSnapshot, restoreShotRack, broadcastSeg, stash, shotLabel, inheritedState, detachChain, seedFromScreen, ensureFirstShot, normalizeNewShotCont, addShot, insertShot, duplicateShot, claimShot, restoreDefaultShot, copyDeskSeg, claimDeskSeg, clearRackSeg, copyRackSeg, claimRackSeg, switchRackSeg, dropRackSeg, bindShotSegment });
}
