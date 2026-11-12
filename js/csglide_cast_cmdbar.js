import { api } from "../../scripts/api.js";
import { el } from "./csglide_ui_kit.js";

/* ============================================================
 * 指挥条 与 工程名
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installCmdBar(ui) {
  /* ---- 指挥条（方案 A）----
     片名 / 段头 / 时长 / 模式开关 / 文件操作 收在这一行。面板其余部分各归各
     卡片，纵向不再七段平铺 —— 原来滚到哪儿全靠认控件形状。 */
  const cmdBar = el("div", "gcast-cmd");
  /* 工程名（= 片名）—— 可直接编辑。它是这条片的身份，档案按它建目录。 */
  const projNameEl = el("div", "c-proj");
  /* 段头 = 三节点共同的「编辑目标」。与时间轴上那段紫环、文案台上那颗胶囊
     是同一个信号，所以用同一个紫（--h3-violet），不另造颜色。 */
  const segChip = el("div", "c-seg");
  segChip.style.display = "none";
  const cmdTime = el("div", "c-time");

  /* 模式开关（原 modeBar）上提到这里：它决定下面那张首尾帧卡显示什么，必须
     与被它控制的内容同屏。need（该加载哪套权重）跟着模式变，所以贴着开关。 */
  const seg = el("div", "gcast-seg");
  const btnFL = el("button", "gcast-seg-btn", "首尾帧");
  const btnRef = el("button", "gcast-seg-btn", "多参考");
  seg.append(btnFL, btnRef);
  const need = el("div", "gcast-need");

  /* 「本段预设」整套已删（20261009 用户定）：存这段 / 另存 / 打包 / 读这段
     四项，连同指挥条上这颗菜单按钮一起移除。理由写在评审文档第 10.7 节 ——
     每段的配置本来就随工程存在节点里，单段落盘这套动作在同一条片子内部无事
     可做，而它的名字也讲不清自己解决什么。
     「工程 ▾」按钮与它整套工程文件功能已删（20261102 用户定）：打开工程 /
     导入分段 / 保存工程文件 / 工程另存 / 工程打包 五项一起下线（含后端解析与
     打包工具 csglide_cast_preset.js 整个文件）。工程随工作流存在节点里，换
     工程走「切换工程」，文件级存取没人用。 */

  /* 工程名旁的状态点：已自动保存 / 渲染中 / 工程文件已保存。
     消除"我要不要点保存"的焦虑 —— 配置本就自动存在节点里。 */
  const saveDot = el("span", "gcast-savedot");
  saveDot.style.display = "none";
  function paintSaveDot() {
    let cls = "auto", txt = "已自动保存";
    let tip = "分段配置随工作流自动保存在本节点，刷新不丢。";
    if (ui.run) {
      cls = "run"; txt = "渲染中";
      tip = "正在渲染 —— 工程操作暂时锁定";
    }
    saveDot.style.display = "";
    saveDot.className = "gcast-savedot " + cls;
    saveDot.title = tip;
    /* 文字包一层：平时（非渲染中）只留状态点、不显示"已自动保存"这类噪音，
       渲染中才展开"渲染中"。hover 小点看 title。 */
    saveDot.innerHTML = "";
    saveDot.append(el("span", "dot-txt", txt));
  }

  /* 「新建工程」从菜单里移到节点右上角（20261011 用户定）：高频的
     生命周期动作，藏在菜单里新人找不到。菜单本体 20261102 已删，这颗按钮留着。 */
  const btnNewProj = el("button", "gcast-btn ghost gcast-newproj", "＋ 新建工程");
  btnNewProj.type = "button";
  btnNewProj.title = "清空所有分段、文案与素材，自动留一个空白第一段。旧工程不会留副本，不可恢复";
  btnNewProj.onclick = (e) => {
    e.stopPropagation();
    if (ui.run) { ui.lanesFlash("正在渲染 —— 跑完或停止后再新建工程"); return; }
    void ui.newProject();
  };

  /* 「工程库」按钮与面板已于 20261012 应要求移除（csglide_cast_library.js
     及后端 /library/* 路由整体删除）。 */

  /* 元信息组：段号 / 时长 / 权重 收进同一个浅底容器，等高、竖线分隔、
     同字号 —— 原来三项一个紫胶囊、两串裸文字，视觉各说各话。 */
  const metaWrap = el("div", "gcast-meta");
  metaWrap.append(segChip, cmdTime, need);

  cmdBar.append(projNameEl, saveDot, metaWrap, seg,
                el("div", "spacer"), btnNewProj);

  /* ---- 工程名：什么时候它是空的、怎么改 ----
     片名不是必填项了。没有就自动起一个（见 ensureProjectName）—— 档案按片名
     建目录，没名字就没有归档、没有时间轴、什么都没有；为了让刚拖出来的节点
     就能用，先给一个能用的默认名，想改随时改。 */
  ui.projNameEditing = false;
  function paintProjName() {
    if (ui.projNameEditing) return;
    const p = ui.node.properties && ui.node.properties.gcast_project;
    const nm = (p && p.name) || "";
    projNameEl.textContent = nm || "（未命名）";
    projNameEl.dataset.empty = nm ? "0" : "1";
    /* 改过名的工程，**目录名不再等于片名**（方案 G 20261020）：目录建好就永远
       不动，改名只改索引里的一条记录。所以这里不能再写「档案在 h3_chain/<片名>/」，
       那个路径改完名就不对了 —— 想看档案目录用面板上「打开工程文件夹」。 */
    projNameEl.title = nm
      ? `工程名（= 片名）：${nm}\n改名只改名字，档案目录不动。点一下直接改。`
      : "点一下给这条片起个名字";
  }
  /** 把新名字落到工程上。
      片名与档案目录已经解耦（方案 G）：后端只改「名字 → 目录」索引里的一条记录，
      磁盘一个字节都不动。以前要连目录一起改名（os.rename），Windows 上目录里
      只要有一个文件被打开就会拒绝 —— 刚渲染完想改名时最容易撞上这个。 */
  async function commitProjName() {
    const p = ui.proj();
    let v = (projNameEl.textContent || "").trim().replace(/\s+/g, " ");
    /* 「（未命名）」只是空名的占位，不是真名字 —— 别把占位文本当成片名存下去。 */
    if (v === "（未命名）") v = "";
    const old = (p.name || "").trim();
    if (!v || v === old) { paintProjName(); return; }
    if (v.length > 40) { ui.lanesFlash("片名太长了（40 字以内）—— 它就是磁盘上的目录名"); paintProjName(); return; }
    p.name = v;
    ui.commit();
    paintProjName();
    /* 磁盘上跟着改。改不动（比如新名字已经被另一条片子占了）就把前端也退
       回去 —— 宁可名字没改成，也不能让前端和后端各说各的。 */
    if (!old) { void ui.monitor.refresh(); return; }
    try {
      const res = await api.fetchApi("/cglide/chain/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: old, to: v }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error || !data.renamed) {
        throw new Error(data.error || data.reason || `HTTP ${res.status}`);
      }
      ui.lanesFlash(`片子已改名为「${v}」（档案目录不动，改名不会再失败）`);
    } catch (e) {
      p.name = old;
      ui.commit();
      paintProjName();
      ui.lanesFlash("改名没成：" + (e.message || e) + " —— 名字保持原样");
      return;
    }
    await ui.monitor.refresh();
  }
  projNameEl.setAttribute("contenteditable", "plaintext-only");
  projNameEl.setAttribute("spellcheck", "false");
  projNameEl.addEventListener("focus", () => {
    ui.projNameEditing = true;
    /* 点一下就进入「改名」而不是「先把原名删掉再敲」：有名字就全选（直接输入即
       覆盖），空名占位「（未命名）」则直接清空（它不是真名字，留着只会碍手）。
       用 requestAnimationFrame 是因为部分浏览器在 focus 事件里刚设好选区会被
       随后的默认焦点处理重置。 */
    requestAnimationFrame(() => {
      if (!ui.projNameEditing) return;
      if (projNameEl.dataset.empty === "1") {
        projNameEl.textContent = "";
      } else {
        const range = document.createRange();
        range.selectNodeContents(projNameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });
  projNameEl.addEventListener("blur", () => {
    ui.projNameEditing = false;
    void commitProjName();
  });
  projNameEl.addEventListener("keydown", (e) => {
    /* 别让按键冒到画布上 —— ComfyUI 的全局快捷键会在这里吃掉回车/空格。 */
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); projNameEl.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); paintProjName(); projNameEl.blur(); }
  });
  projNameEl.addEventListener("pointerdown", (e) => e.stopPropagation());

  /* 自动片名。带日期时间是为了在 output/h3_chain/ 下几条片子并排时认得出先后 ——
     全叫「未命名」的话，攒了三四条之后谁也分不清哪条是哪条。
     不带冒号：片名就是磁盘上的目录名，Windows 文件名里不能有冒号。 */
  function defaultProjectName() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return `未命名片子 ${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
      + `${p2(d.getHours())}-${p2(d.getMinutes())}`;
  }

  /* 片名不再必填 —— 没有就自动起一个，用户随后想改再改。
     原来"没填片名 = 什么都不归档"这套规则是对的（不该往磁盘上乱写目录），但
     代价是新拖出来的节点什么都不能用：没有时间轴、加段看不见、参考素材也存
     不下，而用户并不知道要先去做"填片名"这个动作。现在默认给一个能用的名字，
     想改随时改，改的时候磁盘目录跟着走（见 commitProjName）。
     可重复调用（幂等）：只在真的没有名字时才生成。刻意不做"只跑一次"的标记 ——
     buildUI 跑在 configure() 之前，那一刻 node.properties 还是空的，这次生成的
     名字会被随后恢复的存档覆盖掉；所以注册段在 configure 之后又调了一次。
     用"一次性标记"会把那第二次机会也掐掉。 */
  function ensureProjectName() {
    const p = ui.proj();
    if ((p.name || "").trim()) return;
    /* 工程对象里没名字，但面板存档里有（ui.st.chain.name）—— 这是"存档刚到、
       properties 还没合并"的那一瞬，**不是"用户没起名"**。这时把存档里的名字
       补回去，绝不能自动起一个新名：自动名 = 一次"新建工程" = 段与历史一起丢
       （20261022 定位：proj() 的空壳化 + 这里自动起名，两步把人存的项目顶没了）。 */
    const fromState = (ui.st && ui.st.chain && ui.st.chain.name) || "";
    if (fromState.trim()) {
      p.name = fromState;
      ui.commit();
      paintProjName();
      return;
    }
    p.name = defaultProjectName();
    ui.commit();
    paintProjName();
  }

  /* 「模式开关（首尾帧 / 多参考）+ 权重提示」已上提到指挥条 —— 见上面 cmdBar。
     它决定首尾帧卡显示什么，跟被它控制的内容隔开三行时，用户会先看到一组空
     槽位、再往上翻两屏才知道当前是什么模式。 */


  /* 「把光标交回工程名」：没填片名就想接段时的引导动作 —— 拦下操作、
     说清原因、焦点直接落到要填的那一格，用户不用自己找。
     20261106 轴头「＋ 接一段」撤掉后，触发它的是空态卡「＋ 接第一段」。 */
  function focusProjName() {
    projNameEl.focus();
  }

  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { cmdBar, projNameEl, saveDot, paintSaveDot, segChip, cmdTime, seg, btnFL, btnRef, need, metaWrap, paintProjName, commitProjName, defaultProjectName, ensureProjectName, focusProjName });
}
