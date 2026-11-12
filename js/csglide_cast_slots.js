import { api } from "../../scripts/api.js";
import { relFromEvent } from "./bz_media_ref.js";
import { promptNodeOf, upstreamTextOf } from "./bz_rack.js";
import { projectStore } from "./bz_project_store.js";
import { EXT_KIND, badImageKind, FPS, castSlotFiles } from "./csglide_cast_core.js";
import { dragKind, el, pickFile, probeDuration, uploadFile, viewURL, castAssetDir } from "./csglide_ui_kit.js";

/* ============================================================
 * 槽位填充 与 采纳最新成片
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installSlots(ui) {
  /* ------------------------------------------------------------ slots */

  function clearSlot(slot) { for (const k of Object.keys(slot)) delete slot[k]; }

  /* hasToken()（"这个 @标签 有没有被提示词提到"）原先服务于参考标签 chips 的
     点亮与展示条的按需过滤，两者随编辑区一起删了，一并去掉。 */

  function fileKind(f) {
    const t = f?.type || "";
    if (t.startsWith("image/")) return "image";
    if (t.startsWith("video/")) return "video";
    if (t.startsWith("audio/")) return "audio";
    /* No MIME type at all is common for containers the OS does not know --
       mkv on a machine without a matroska registration is the usual one. The
       extension still says what it is. */
    const ext = (f?.name || "").split(".").pop().toLowerCase();
    return EXT_KIND[ext] || "";   /* still unknown: let it through, don't block */
  }

  /* First empty slot of the right kind, else the last one so a full rack still
     takes the file rather than dropping it on the floor. Tokens are renumbered
     against filled slots at emit, so the index chosen here does not matter.
     For images, prefer an empty slot whose @图片N is already referenced in the
     prompt, so re-pasted references land on the number the prompt expects. */
  /* 参考图/视频/音频槽位 UI 已外迁至「🗂️ H3 媒体架」（refs 接线），面板不再
   * 接收参考素材：拖到面板空白处的文件会被拒绝（防止静默填进看不见的槽位）。
   * 首末帧卡与续写卡有各自的 wireDrop，卡级拖放不受影响。绑定关系永久固定：
   * 素材落在媒体架哪个格，@图片N 就永远指它，任何自动逻辑都不得搬动。 */

  /* 续接提示词自动注入（对照 TimelineDirector 的 _inject_continuity_instruction）。
     续接段（有续接窗口、且不是第 1 段）的成片开头其实是"上一段片尾的潜空间续接"，
     模型并不知道这件事 —— 在提示词里点明"开头先按上一段末镜描述、再引入新动作"，
     续接连贯性一半靠它。只在**送模型**这一路（effPrompt）注入，st.prompt 原文不动。
     注入点优先官方 6 段格式的 [Shot 1] 之后；自然语言则插在最前。 */
  function injectContinuity(prompt) {
    const c = ui.st.cont || {};
    const win = Number(c.frames) || 0;
    if (!win) return prompt;                       // 没续接窗口 = 不注入
    const p = ui.proj ? ui.proj() : null;
    const idx = p && Number.isFinite(+p.idx) ? +p.idx : -1;
    if (idx <= 0) return prompt;                   // 第 1 段没有上一段可接
    /* 取消接续（时间轴左接缝 unlink）的那一段**不承接任何东西**，也就不能告诉
       模型"开头是承接画面、先按上一段末镜描述" —— 那句指令会让模型凭空复现
       上一段内容，开头几秒被它自己的复述拖软。判据与后端 head_unlinked 一致：
       只看接缝表，不看面板上的续写窗口（窗口是配置，不是本次承不承接的结论）。 */
    const cid = (p && p.shots && p.shots[idx] && p.shots[idx].clip) || "";
    const tr = (p && p.transitions) || {};
    if (cid && tr[cid] && tr[cid].type === "unlink") return prompt;
    const durStr = (win / FPS).toFixed(3).padStart(6, "0");
    const instr = `[续接] 开头 00:${durStr} 是承接上一段片尾的潜空间续接画面，`
      + "先按上一段末镜描述（保持人物位置、环境、动作、运镜、光线、色彩与声音），"
      + "再引入新动作。";
    for (const field of ["integrated_multimodal_description:", "detailed_description:"]) {
      const fi = prompt.indexOf(field);
      if (fi < 0) continue;
      const si = prompt.indexOf("[Shot 1]", fi + field.length);
      if (si >= 0) {
        const at = si + "[Shot 1]".length;
        return prompt.slice(0, at) + " " + instr + prompt.slice(at);
      }
    }
    return instr + " " + prompt;                    // 自然语言：插在最前
  }

  /* 续接窗口指纹，参与 effPrompt 的缓存键：改了窗口/切了段，注入结果就得重算。
     必须把「接缝是否断链」也算进来 —— 否则按了「取消接续」之后缓存键没变，
     effPrompt 会一直命中上一次（带续接指令）的结果，取消等于没取消。
     只读状态，不产生副作用。 */
  const contKey = () => {
    const c = ui.st.cont || {};
    const p = ui.proj ? ui.proj() : null;
    const idx = p && Number.isFinite(+p.idx) ? +p.idx : -1;
    const cid = (p && idx >= 0 && p.shots && p.shots[idx] && p.shots[idx].clip) || "";
    const tr = (p && p.transitions) || {};
    const unlink = (cid && tr[cid] && tr[cid].type === "unlink") ? "U" : "";
    return `${c.mode || ""}|${c.frames || 0}|${idx}|${unlink}`;
  };

  /* 外接提示词（模式 A）：prompt_text 接线即外部文本整体接管。所有展示型
   * 逻辑（按需过滤 / 素材自检）都读 effPrompt()；st.prompt 的存储永不被外部
   * 数据污染，断线即恢复面板原文。 */
  const promptWired = () => !!promptNodeOf(ui.node);
  /* 一次渲染里 effPrompt() 会被问好几遍（素材自检一次、别名表一次、按需过滤
     一次……），而它只在「原文」或「别名表」变了才会变——按这两者做键缓存下来。
     别名表版本要先刷新，否则改完别名还会命中旧结果。 */
  ui.effCache = { key: "", out: "" };
  const effPrompt = () => {
    /* 别名先展开、再归一化：名为 image 3.png 的素材若先走归一化，会被英文
       规则抢成 @图片1，指向完全错误的槽位。
       注意这里返回的是「送模型」用的展开文本——编辑器里仍是剧本原文，
       hasToken / 按需过滤 / 展示条都靠它识别别名引用。 */
    const srcNode = promptNodeOf(ui.node);
    const wired = !!srcNode;
    let raw;
    if (!wired) {
      raw = ui.st.prompt || "";
    } else if (srcNode && srcNode.type === "CSGlideDeskCS"
               && srcNode.deskUI && typeof srcNode.deskUI.composedWords === "function") {
      /* 文案台：读「片子级 + 当前段」权威组合（与后端 compose_text 同口径），
         不用 upstreamTextOf 的「最长 widget」——那会把整段 desk_data JSON
         当提示词，把别的段的 @图片N 也算进本次自检 / 展示。 */
      const clip = (ui.st && ui.st.chain && ui.st.chain.clip) || "";
      raw = srcNode.deskUI.composedWords(clip);
    } else {
      raw = upstreamTextOf(srcNode);
    }
    /* 别名是否展开，外接文案台时以文案台「别名模式」开关为唯一权威——和后端
       csglide_cast（h3_data.alias）、文案台 chip 高亮严格同口径：开关关时剧本里
       裸写的角色名不在这里展开，素材自检/展示条也就不会把它算成会发送的引用，
       做到所见即所送。面板模式（没接文案台）默认展开，旧行为不变。
       写法归一化（<Picture N>/图片N 等）不属于别名，任何时候都照做。 */
    const aliasOn = wired ? projectStore.deskAliasOf(srcNode) !== false : true;
    ui.aliasInfo();                       // 刷新别名表版本，下面才拿得到新键
    const key = ui.aliasCache.key + "\u0001" + raw + "\u0001" + contKey()
      + "\u0001" + (aliasOn ? "a1" : "a0");
    if (ui.effCache.key === key) return ui.effCache.out;
    let out = raw;
    if (aliasOn) out = ui.expandAliases(out);
    out = ui.normalizeRefs(out);
    out = injectContinuity(out);
    ui.effCache = { key, out };
    return out;
  };

  function flashPanel() {
    ui.root.classList.add("gcast-reject");
    setTimeout(() => ui.root.classList.remove("gcast-reject"), 320);
  }

  function flashWrong(node_) {
    node_.classList.add("gcast-reject");
    setTimeout(() => node_.classList.remove("gcast-reject"), 320);
  }

  async function assign(slot, src, kind, token) {
    /* src 是字符串 = 文件已在 input 目录里的相对路径，直接引用，不再上传。
       真要上传就落本工程子目录 input/cglide/<片名>/，不跟别的工程混在一层
       （castAssetDir 的细节见 csglide_cast_core.js 的 assetDirOf）。 */
    const name = typeof src === "string" ? src : await uploadFile(src, castAssetDir(ui.st, src.name));
    clearSlot(slot);
    slot.file = name;
    if (kind !== "image") {
      const d = await probeDuration(viewURL(name), kind === "video");
      slot.dur = d; slot.start = 0; slot.end = d;
      if (kind === "video") slot.audio = true;
    }
    ui.render(); ui.commit();
    /* Dropped or picked clips skip the adopt route entirely, so they arrive
       with no chroma known -- and a clip from somewhere else is precisely the
       one worth checking. Done after the render so the slot appears at once
       and the badge follows. */
    if (slot === ui.st.cont && kind === "video") tagChroma(slot, name);
  }

  /* Ask the server what a file in input/ actually is. Quiet on failure: an
     unknown chroma just means no badge, which is the state before this ran. */
  async function tagChroma(slot, name) {
    try {
      const i = name.lastIndexOf("/");
      const sub = i >= 0 ? name.slice(0, i) : "";
      const base = i >= 0 ? name.slice(i + 1) : name;
      const r = await api.fetchApi("/cglide/probe?type=input"
        + `&filename=${encodeURIComponent(base)}&subfolder=${encodeURIComponent(sub)}`);
      if (r.status !== 200) return;
      const d = await r.json();
      if (slot.file !== name) return;      /* the slot moved on while we waited */
      slot.chroma = d.chroma || "";
      slot.codec = d.codec || "";
      /* a container the browser could not decode still has a real duration */
      if (!slot.dur && d.duration) {
        slot.dur = d.duration; slot.start = 0; slot.end = d.duration;
      }
      ui.render(); ui.commit();
    } catch (err) {
      console.warn("[H3 Studio] probe failed:", err);
    }
  }

  /* ------------------------------------------------- adopt a finished render
   * Renders land in output/, guides are read from input/cglide/. The copy is
   * done SERVER-SIDE by /cglide/adopt_output -- pulling a 12s 4:4:4 file into
   * the browser only to post the same bytes back would move hundreds of
   * megabytes across the loopback for a disk copy.
   */
  /* ------------------------------------------------ what am I about to take?
   * Hovering the button probes the newest output and says what it is, BEFORE
   * it is adopted. Worth the round trip because chroma is not cosmetic here:
   * measured on the same clip pair, an AV1 yuv420p10le guide made Glide Join
   * report a -2 frame correspondence on every run, while 4:2:2 and 4:4:4
   * guides reported none. Three quarters of the chroma is gone before the
   * model sees the frames, so the anchor is weaker.
   * Probing is cached server-side on path+mtime, so a second hover is free. */
  const CHROMA_WARN = "4:2:0";
  ui.hoverProbe = null;

  function describeSource(info) {
    if (!info || !info.name) return "取用输出目录里最新的视频";
    const what = [info.codec, info.chroma].filter(Boolean).join(" ");
    const head = what ? `${info.name} — ${what}` : info.name;
    if (info.chroma === CHROMA_WARN) {
      return head + "\n\n该视频为色度亚采样（4:2:0）：进入模型的参考只保留四分之一的色度信息。";
    }
    return head;
  }

  function primeLastRenderTip(btn) {
    /* one request per hover, and the answer is reused for the next one */
    if (ui.hoverProbe) { ui.hoverProbe.then((i) => { btn.title = describeSource(i); }); return; }
    ui.hoverProbe = api.fetchApi("/cglide/recent_outputs?limit=1&probe=1")
      .then((r) => (r.status === 200 ? r.json() : []))
      .then((list) => (Array.isArray(list) && list.length ? list[0] : null))
      .catch(() => null);
    ui.hoverProbe.then((i) => { btn.title = describeSource(i); });
    /* the newest output changes as soon as anything renders */
    setTimeout(() => { ui.hoverProbe = null; }, 15000);
  }

  /* Adopt one NAMED output. Shared by the button and by the run loop, which
     needs a specific file rather than whatever happens to be newest. */
  async function adoptInto(slot, pick) {
    const a = await api.fetchApi("/cglide/adopt_output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: pick.name, subfolder: pick.subfolder || "", type: pick.type || "output",
        /* 让后端知道「这是哪个工程在采纳、本工程已经在用哪些素材」：成片也按
           工程落 input/cglide/<片名>/，同名覆盖不改名（详见 csglide_adopt.py）。
           两个字段都可省 —— 老前端不传时后端与旧版逐字一致落 cglide 根。 */
        project: (ui.st.chain && ui.st.chain.name) || "",
        used: castSlotFiles(ui.st),
      }),
    });
    if (a.status !== 200) throw new Error(`导入输出失败 (${a.status})`);
    const d = await a.json();
    const name = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
    /* 续写窗口与档位是**这段自己的设定**，不是这段引用的那部片子的属性。
       下面 clearSlot 会把整个槽位清空、start/end 重置成整段 —— 不先存下来，
       连续渲染时每一段都会把用户选的窗口冲回默认，菜单选了等于没选。 */
    const keepWin = { frames: slot.frames, mode: slot.mode };
    clearSlot(slot);
    slot.file = name;
    if (keepWin.frames) slot.frames = keepWin.frames;
    if (keepWin.mode) slot.mode = keepWin.mode;
    /* Ask the browser first; fall back to the server's reading. The browser
       reports 0 for anything it cannot decode, and HEVC 4:4:4 in Matroska --
       what the high-fidelity preset writes -- is exactly that case. Without a
       duration there is no window to draw. */
    let dur = await probeDuration(viewURL(name), true);
    if (!dur) dur = Number(d.duration) || 0;
    slot.dur = dur; slot.start = 0; slot.end = dur;
    slot.audio = true;
    /* Assigned unconditionally, including to nothing: a blank probe must clear
       a previous file's label rather than leave it standing over the new one. */
    slot.chroma = d.chroma || "";
    slot.codec = d.codec || "";
    /* start/end left at the full range on purpose: the render pass snaps an
       untouched continuation clip to its last 22 frames. */
    return d;
  }

  async function adoptLastRender(slot, card, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "\u2026"; }
    try {
      const r = await api.fetchApi("/cglide/recent_outputs?limit=1");
      if (r.status !== 200) throw new Error(`获取最新输出失败 (${r.status})`);
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) {
        /* Nothing rendered yet, or the outputs went somewhere else. Say so
           rather than failing mutely. */
        console.warn("[H3 Studio] no video found in the output folder");
        flashWrong(card);
        return;
      }
      await adoptInto(slot, { ...list[0], type: "output" });
      ui.render(); ui.commit();
    } catch (err) {
      console.error("[H3 Studio] could not adopt the last render:", err);
      flashWrong(card);
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "引用最新渲染"; }
    }
  }

  function wireDrop(node_, slot, kind, accept, token) {
    /* 可疑图片格式：MIME 齐全，能过 fileKind() 的关进到图片槽，但后端 PIL 没有
       解码器——收了只会一路炸到模型端。提前拒绝，沿用导演台既有的拒绝语言
       （卡片红框闪一下）；面板里没有 toast 体系，原因挂到 title 上，鼠标移上去
       能看全，3 秒后摘掉免得残留误导。 */
    const rejectBad = (f) => {
      if (kind !== "image") return false;
      const bad = badImageKind(f);
      if (!bad) return false;
      flashWrong(node_);
      const msg = `「${f.name}」是 ${bad}，无法作为参考图，请先转成 PNG/JPG`;
      node_.title = msg;
      setTimeout(() => { if (node_.title === msg) node_.title = ""; }, 3000);
      console.warn(`[H3 导演台] 拒绝可疑参考图：${msg}`);
      return true;
    };
    node_.addEventListener("click", async (e) => {
      if (e.target.closest(".gcast-x, .gcast-track, .gcast-chk, .gcast-times, .gcast-quick")) return;
      const f = await pickFile(accept);
      if (f && !rejectBad(f)) await assign(slot, f, kind, token);
    });
    node_.dataset.kind = kind;
    /* The paste handler finds its target by hover, and a hovered element only
     * knows its kind from the dataset. Carry the slot object and its token on
     * the element too, so a paste can go straight into the slot under the
     * pointer instead of always routing to the first free one. Re-set on every
     * render, since these elements are rebuilt. */
    node_.__gcastSlot = slot;
    node_.__gcastToken = token || null;
    node_.addEventListener("dragover", (e) => {
      const k = dragKind(e);
      if (k === null) return;                    /* not a file: leave it alone */
      e.preventDefault(); e.stopPropagation();
      /* a mismatch stays unhighlighted, so the wrong slot never looks willing */
      node_.classList.toggle("drop", k === "" || k === kind);
    });
    /* dragleave also fires crossing into a child, which made the highlight
       flicker. Only clear when the pointer has really left the card. */
    node_.addEventListener("dragleave", (e) => {
      if (!node_.contains(e.relatedTarget)) node_.classList.remove("drop");
    });
    node_.addEventListener("drop", async (e) => {
      const k = dragKind(e);
      if (k === null) return;
      e.preventDefault(); e.stopPropagation(); node_.classList.remove("drop");
      const ref = relFromEvent(e);
      if (ref) {
        if (fileKind({ name: ref }) !== kind) { flashWrong(node_); return; }
        await assign(slot, ref, kind, token);
        return;
      }
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (fileKind(f) && fileKind(f) !== kind) { flashWrong(node_); return; }
      if (rejectBad(f)) return;
      await assign(slot, f, kind, token);
    });
  }

  function imageSlot(slot, caption, token, badge) {
    const card = el("div", "gcast-slot" + (slot.file ? " filled" : ""));
    const thumb = el("div", "gcast-thumb");
    if (slot.file) {
      const img = el("img"); img.src = viewURL(slot.file); img.loading = "lazy";
      img.draggable = false;   /* keep the card's drag; the img is natively draggable */
      thumb.append(img);
    } else thumb.append(el("div", "gcast-empty", "+"));
    card.append(thumb);
    if (badge) {
      /* Reference cells: a corner number dot on the image (carrying the
         @图片N identity), with a caption bar below showing just the original
         filename and the clear control pushed to the far end. */
      thumb.append(el("span", "gcast-num", caption));
      const cap = el("div", "gcast-cap");
      if (slot.file) {
        const fn = el("span", "fn", slot.file.split("/").pop());
        fn.title = slot.file;
        cap.append(fn);
      }
      cap.append(el("div", "spacer"));
      if (slot.file) {
        const x = el("button", "gcast-x", "×");
        x.title = "清除槽位";
        x.onclick = (e) => { e.stopPropagation(); clearSlot(slot); ui.render(); ui.commit(); };
        cap.append(x);
      }
      card.append(cap);
    }
    if (!badge) {
      const cap = el("div", "gcast-cap");
      cap.append(el("span", "n", caption));
      if (slot.file && slot.wired) cap.append(el("span", "gcast-wired", "\u{1F517} 端口"));
      else if (slot.file && token) cap.append(el("span", null, token));
      if (slot.file) {
        const x = el("button", "gcast-x", "×");
        x.title = slot.wired ? "断开端口连线" : "清除槽位";
        x.onclick = (e) => {
          e.stopPropagation();
          if (slot.wired && slot.unwire) slot.unwire();
          else { clearSlot(slot); ui.render(); ui.commit(); }
        };
        cap.append(x);
      }
      card.append(cap);
    }
    return card;
  }


  /* ===== 首帧 / 尾帧端口 → 面板槽镜像 =====
     后端 build 已"端口优先、槽兜底"。这里让面板槽跟上端口：first_frame /
     last_frame 接了加载器，对应槽自动显示那张图（wired 只读镜像，× = 拆线）；
     端口断开，槽恢复用户手动上传的值。只有能拿到 input 相对路径的上游
     （LoadImage 等）能镜像；纯张量来源没有文件可显示。 */
  function imageFileOfNode(un) {
    const ws = un.widgets || [];
    const direct = ws.find((w) => w.name === "image");
    if (direct && typeof direct.value === "string"
        && fileKind({ name: direct.value }) === "image") return direct.value;
    const any = ws.map((w) => w.value)
      .find((v) => typeof v === "string" && fileKind({ name: v }) === "image");
    return any || "";
  }
  function portFile(portName) {
    const s = ui.node.inputs.find((x) => x.name === portName);
    if (!s || s.link == null) return "";
    const L = ui.node.graph.links[s.link];
    if (!L) return "";
    const un = ui.node.graph.getNodeById(L.origin_id);
    return un ? imageFileOfNode(un) : "";
  }
  function disconnectPort(portName) {
    const i = ui.node.inputs.findIndex((x) => x.name === portName);
    if (i >= 0) ui.node.disconnectInput(i);
    requestAnimationFrame(syncPortFrames);
  }
  function syncPortFrames() {
    let changed = false;
    [["first", "first_frame"], ["last", "last_frame"]].forEach(([key, portName]) => {
      const slot = ui.st.slots[key], pf = portFile(portName);
      if (pf) {
        if (!slot.wired && slot.file) slot.manualFile = slot.file;
        slot.unwire = () => disconnectPort(portName);
        if (!slot.wired || slot.file !== pf) { slot.wired = true; slot.file = pf; changed = true; }
      } else if (slot.wired) {
        slot.wired = false; delete slot.unwire;
        slot.file = slot.manualFile || ""; delete slot.manualFile; changed = true;
      }
    });
    if (changed) { ui.render(); ui.commit(); }
  }
  ui.syncPortFrames = syncPortFrames;
  /* 连线 / 拆线的自动触发统一在节点原型 onConnectionsChange（csglide_cast.js
     register 段）里调 h3ui.syncPortFrames()，这里不再做实例级覆盖（重复且在本
     前端版本不被稳定调用）。 */

  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { clearSlot, fileKind, promptWired, effPrompt, flashPanel, flashWrong, assign, tagChroma, CHROMA_WARN, describeSource, primeLastRenderTip, adoptInto, adoptLastRender, wireDrop, imageSlot, syncPortFrames });
}
