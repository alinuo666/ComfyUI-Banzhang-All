import { promptNodeOf, rackSlotsOf, rackNodeOf, onRackChange } from "./bz_rack.js";

/* ============================================================
 * 指挥条段头 与 总览轴计数
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installMeta(ui) {
  /* ---- 指挥条段头 / 总览轴计数 ----
     段头是三节点共同的「编辑目标」：与时间轴上那段的紫环、文案台上那颗胶囊
     同一个信号，所以用同一个紫。段号同步取自面板选中段。 */
  function updateSegChip() {
    const p = ui.proj();
    /* 段数只认档案（真源）。p.shots 是工作流节点属性里的投影，删段或音频重排
       后会与档案分叉，用它会让监视器上方写 3、时间轴只有 2 块。
       档案未读回（clipCount=-1）时暂用工程数，别把刚载入的片子说成 0 段。 */
    const cn = (ui.monitor && ui.monitor.clipCount) ? ui.monitor.clipCount() : -1;
    const n = cn >= 0 ? cn : p.shots.length;
    if (!n) {
      ui.segChip.style.display = "none";
      if (ui.metaWrap) ui.metaWrap.style.display = "none";
      return;
    }
    if (ui.metaWrap) ui.metaWrap.style.display = "";
    ui.segChip.style.display = "";
    /* 对账护栏期内工程段可能仍比档案多，当前序号不能超过总段数。 */
    const cur = Math.min(Math.max(1, (p.idx || 0) + 1), n);
    ui.segChip.innerHTML = `<span class="mlab">段</span><span class="mval">${cur}/${n}</span>`;
    ui.segChip.title = "当前编辑的段（点总览轴上任意一段切换）";
  }

  /* 总览轴头部的段数。段一多，光靠数轴上那排色块数不出总数 —— 而这条轴的意
     义恰恰是"一眼看完整个片子"。
     20261108：两处段数统一只读档案真源，p.shots 不参与计数。分叉信息只进
     tooltip，界面上永远只出现一个数 —— 以前「2 段 · 工程 3」摆两个数，
     用户看到的还是那个错的 3。 */
  function updateLanesMeta() {
    const cn = (ui.monitor && ui.monitor.clipCount) ? ui.monitor.clipCount() : -1;
    const pn = ui.proj().shots.length;
    /* 渲染中这一位变成进度：段数是平时才需要的信息，跑起来的时候"跑到第几
       段"才是。同一个位置换内容，不新增一行，也不跟遮罩抢地方。 */
    if (ui.run && ui.run.total) {
      ui.lanesMeta.textContent = `${ui.run.k + 1} / ${ui.run.total}`;
      ui.lanesMeta.style.color = "var(--h3-accent)";
      ui.lanesMeta.title = `正在渲染第 ${ui.run.i + 1} 段（共 ${ui.run.total} 段）`;
      return;
    }
    ui.lanesMeta.style.color = "";
    ui.lanesMeta.title = "";
    const n = cn >= 0 ? cn : pn;
    if (!n) { ui.lanesMeta.textContent = "还没有分段"; return; }
    ui.lanesMeta.textContent = `${n} 段`;
    /* 残留工程段由段身份对账自愈；这里只留提示，不摆第二个数字。 */
    if (cn >= 0 && cn !== pn) {
      ui.lanesMeta.title = `轴上 ${cn} 段、工程里 ${pn} 个分段 —— 以轴上为准，`
        + "工程多出来的残留分段正在自动清理";
    }
  }
  /* 指挥条上的「本段预设 ▾」连同它那四个动作已整套删除（20261009）——
     单段预设文件与"每段配置随工程保存"重复，详见 csglide_cast_preset.js 末的说明。 */

  /* 面板槽位 + 接线媒体架槽位的合并视图（媒体架覆盖同编号，空位面板兜底）。
     它不再是"展示视图" —— 参考标签 chips 与提交格式展示条都随编辑区删了 ——
     现在只服务两件事：别名表按素材名建索引、排队前的素材自检按它找文件。
    * 数组长度取两者较长者——媒体架是动态槽位（可 >9/3/3），若以面板固定长度
    * 起步，超出部分的素材永远进不了合并视图（也就永远拿不到文件）。 */
  /* 解析缓存由 rackSlotsOf 持有（它按 rack_data 原文缓存 JSON.parse 结果）；
     这里只缓存「合并后的视图」，并按同样的键失效，避免每次都重新合并一遍
     面板槽位与媒体架槽位。键同时充当「上游是否变过」的判据，见 syncRack。 */
  ui.rackCache = { key: null, slots: { images: [], videos: [], audios: [] } };
  function mergedSlots() {
    /* 段内容只认接线（20261105）：refs 口没接线时前端也按空素材算，面板
       ui.st.slots 不再兜底 —— 否则界面显示 34 张、后端实送 0 张。 */
    const src = promptNodeOf(ui.node);
    const refsIn = (ui.node.inputs || []).find(
      (s) => s && s.name === "refs" && s.link != null);
    const key = rackSlotsOf(ui.node).raw + "\u0002" + (src ? "W" + (src.id ?? "") : "N")
              + "\u0002" + (refsIn ? "R" : "N");
    if (key !== ui.rackCache.key) {
      ui.rackCache = {
        key,
        slots: refsIn ? rackSlotsOf(ui.node).slots
                      : { images: [], videos: [], audios: [] },
      };
    }
    const out = {};
    for (const kind of ["images", "videos", "audios"]) {
      out[kind] = (ui.rackCache.slots[kind] || []).map(
        (s) => (s && s.file ? { ...s } : null));
    }
    return out;
  }

  function fileForToken(token) {
    if (!token) return null;
    const view = mergedSlots();
    const m = /^@图片(\d+)$/.exec(token); if (m) return view.images[+m[1] - 1]?.file || null;
    const v = /^@视频(?:音频)?(\d+)$/.exec(token); if (v) return view.videos[+v[1] - 1]?.file || null;
    const a = /^@音频(\d+)$/.exec(token); if (a) return view.audios[+a[1] - 1]?.file || null;
    if (token === "@first") return ui.st.slots.first.file;
    if (token === "@last") return ui.st.slots.last.file;
    return null;
  }

  /* 规范 @标签。命中别名的正则必须每次现拼（见 tokReOf）：别名集合随媒体架变化，
     别名字面量不能写死在正则里。 */
  const TOK_SRC = "@(?:first|last|图片\\d+|视频音频\\d+|视频\\d+|音频\\d+)(?![0-9A-Za-z])";

  /** 扫描"提示词里引用了什么"：规范 @标签 与别名都命中，别名经 am 表换成 canon
      （规范 token），供 fileForToken 判定有没有实际文件。
      它原来还兼着编辑器高亮（哪一段该点亮、点成什么颜色），那份职责随编辑区一起
      删了；排队前的素材自检 missingRefs() 仍然靠它 —— 引用了却没有素材，必须在
      前端拦下，不能让后端甩一句「槽位为空」。 */
  function tokReOf() {
    const { map: am, strict } = ui.aliasInfo();
    const keys = Object.keys(am);
    if (!keys.length) return { re: ui.reOf(TOK_SRC, "g"), am };
    const parts = [];
    /* 分两组：auto 组允许 @?（裸写也认），strict 组强制 @（只有写 @小明 才算
       引用）。组名带 g/s 前缀，调用方按「哪组有值」取回用户原文。 */
    for (const scope of ["auto", "strict"]) {
      const ks = keys.filter((k) => (scope === "strict") === strict.has(k));
      if (!ks.length) continue;
      const grp = ui.aliasEdges(ks);
      for (const key of ["ascii", "cjk"]) {
        if (!grp[key].length) continue;
        grp[key].sort((a, b) => b.length - a.length);   // 长名优先，短名不能抢
        const L = ui.EDGE_L[key];
        const R = key === "ascii" ? "(?![A-Za-z0-9])" : "(?![0-9])";
        const at = scope === "strict" ? "@" : "@?";
        const gn = (scope === "strict" ? "s" : "g") + (key === "ascii" ? "a" : "c");
        /* 别名里的空格在正文里可能写成半角，也可能被输入法写成全角 U+3000。
           别名表的 key 已归一成半角，所以这里把空格展开成 [ 　] 两种都能命中。 */
        const alt = grp[key].map((n) => ui.escRe(n).replace(/ /g, "[ \u3000]")).join("|");
        parts.push(L + at + "(?<" + gn + ">" + alt + ")" + R);
      }
    }
    const re = ui.reOf(TOK_SRC + "|" + parts.join("|"), "g");
    re.lastIndex = 0;
    return { re, am };
  }
  /* 取四个别名组里真正命中的那一个（只可能有一组有值） */
  const alOf = (g) => {
    for (const k of ["ga", "gc", "sa", "sc"]) if (g && g[k] !== undefined) return g[k];
    return null;
  };

  /* 排队前自检：提示词里引用到的 @标签 / 别名，必须能在合并视图（面板槽位 +
     媒体架）里找到文件。缺了就在前端拦下，说清缺哪个标签、怎么补——不再让
     后端甩一句「槽位为空」让人摸不着头脑（尤其媒体架现在按分段记忆，切段
     倒回旧快照后素材可能不在了）。 */
  function missingRefs() {
    const bad = [];
    const seen = new Set();
    /* 扫「真正会发送」的文本 effPrompt：外接时读文案台 → 按文案台「别名模式」
       开关展开 → 归一化 → 续接注入，与后端口径逐字一致。旧版扫 ui.st.prompt：
       外接模式下面板 prompt 根本不参与发送（会漏报），且别名展开不看文案台开关
       （会多报）。effPrompt 已把别名展开成规范 token，这里只扫规范 @标签即可。 */
    const text = ui.effPrompt();
    const re = ui.reOf(TOK_SRC, "g");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const canon = m[0];
      if (seen.has(canon)) continue;
      seen.add(canon);
      if (!fileForToken(canon)) bad.push(canon);
    }
    return bad;
  }

  /* 音频参考需要独立接「音频 VAE」（minimax_h3_audio_vae_fp32）——它不在
     optional 里强制，不接也能跑，于是一用到音频就在后端抛异常中断。这里在排队
     前拦下：提示词引用了音频、或视频槽位勾了音轨，而 audio_vae 没接线，直接
     报清楚缺什么、怎么补。判定只看「有没有连线」，不猜模型对不对。

     第三条判据「音频槽位摆了素材」是 20261021 补的：后端
     _filter_refs_by_prompt 对 audios 是**无条件发送**——它是代码里的显式例外，
     不看提示词（csglide_cast.py:1210-1217，官方 MiniMaxH3ReferenceToVideo 对
     ref_audios 同样无条件发送）。于是只要槽位里摆了音频，后端就一定会走到
     _encode_ref_audio，audio_vae 为 None 时抛异常中断。
     原先这里只查提示词与视频音轨勾选，于是「摆了音频 + 提示词没写 @音频N」
     这个组合前端放行进队、后端跑一半炸掉，用户看到的是「音频不生效」。
     三条判据必须与后端真正会走到 _encode_ref_audio 的三条路一一对应，
     少一条就是一条漏网的中断。 */
  function audioVaeMissing() {
    const slots = mergedSlots();
    const inPrompt = /@音频\d+/.test(ui.effPrompt());
    const hasAudioSlot = (slots.audios || []).some((s) => s && s.file);
    const hasVideoTrack = (slots.videos || []).some((s) => s && s.file && s.audio);
    if (!(inPrompt || hasAudioSlot || hasVideoTrack)) return null;
    const inp = (ui.node.inputs || []).find(
      (s) => s && (s.name === "audio_vae" || s.localized_name === "audio_vae")
             && s.type === "VAE");
    if (inp && inp.link != null) return null;
    return {
      why: inPrompt
        ? "提示词引用了 @音频N"
        : hasAudioSlot
          ? "音频槽位摆了素材（音频无条件发送，不写 @音频N 也会送）"
          : "视频槽位勾了「同时把其音轨作为音频参考」",
    };
  }

  /* 媒体架在另一个节点上编辑，导演台不会自己重渲——悬停进面板时比对 rack_data
     与外接提示词文本，变了才重渲。
     它现在唯一的作用是让 effPrompt() 的缓存失效重算：effPrompt 要按当前素材
     表展开别名，而别名表来自媒体架。原先还要顺带重画 chips / 展示条 / 高亮，
     那些随编辑区一起删了。 */
  const syncRack = () => {
    const before = ui.rackCache.key;
    /* 正在别的节点里编辑文本（ComfyUI 的浮动输入/外接文本源）时不动：整面板
       render 会触发画布重排，打断外部输入。等焦点离开再刷新。 */
    const ae = document.activeElement;
    if (ae && ae !== document.body && !ui.root.contains(ae)) {
      const editing = ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable;
      if (editing) return false;
    }
    mergedSlots();
    /* 不需要再单独判外接提示词的文本差异：接线状态与上游节点 id 都在 key 里，
       上游改字会让 key 变，key 变就足以触发重渲。 */
    if (ui.rackCache.key !== before) { ui.render(); return true; }
    return false;
  };
  ui.root.addEventListener("pointerenter", syncRack);
  /* 媒体架镜像同步（20261012 方案B：零轮询）：
     · 媒体架一 commit 就广播 rack-change → 导演台立刻 syncRack（只在事件源是
       自己接的那台媒体架时；syncRack 自带 key 比对，不会白画）；
     · 鼠标移入导演台（pointerenter）再兜一次，覆盖直接改工作流等外部场景。
     旧的 4s 轮询 + visibilitychange 空转已彻底删除。 */
  const offRackEvt = onRackChange((d) => {
    if (ui.node.flags?.collapsed) return;
    try {
      const rn = rackNodeOf(ui.node);
      if (rn && d.node != null && rn.id !== d.node) return;
    } catch (_) { /* 取不到就当是自己的，syncRack 自带 key 比对，不会白画 */ }
    syncRack();
  });
  /* 名字保留（cast.js destroy 里 clearInterval(ui.rackPoll)），恒 0 = 无定时器 */
  const rackPoll = 0;
  /* destroy() 的清理入口：摘掉 rack-change 监听。 */
  const rackPollTeardown = () => {
    try { offRackEvt && offRackEvt(); } catch (_) {}
  };


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { updateSegChip, updateLanesMeta, mergedSlots, fileForToken, TOK_SRC, tokReOf, alOf, missingRefs, audioVaeMissing, syncRack, rackPoll, rackPollTeardown });
}
