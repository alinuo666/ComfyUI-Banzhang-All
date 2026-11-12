/* bz_audit.js — 事件溯源 + 段体检（方案⑤）
 * ============================================================================
 * 方案①（编译式渲染）保证「每一次提交送出去的，都是那一段自己的数据」。
 * 本文件回答的是另一半问题：**事后能查清它当时到底送了什麼**。
 *
 * 串段这类故障的难点从来不是修，而是"偶发、不可复现、说不清是哪一刻坏的"。
 * 这里做两件事：
 *   ① 编译流水：每次编译落一条 events（cid/字数/槽位/@引用/指纹/来源），
 *      渲染结果因此可以对着指纹回溯 —— "这一段用的是谁的图"有据可查；
 *   ② 段体检：把全工程的段并排摆成一张表（词数/素材数/引用/成片/指纹），
 *      词或素材指纹撞车当场标红。**两段渲染出一模一样的东西，以前只能靠
 *      肉眼事后发现；现在提交前就会报警。**
 *
 * 用法（控制台，F12）：
 *   bzHealth()            全工程段体检表
 *   bzAudit("clip_0009")  这一段的历史流水（编译/落库/改段…）
 *   bzAudit()             整个工程最近 200 条流水
 * ============================================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { promptBuild, basisOf } from "./bz_prompt_build.js";
import { bzStore } from "./bz_store.js";

/* 同一条流水的 seq 由服务端发号，前端只负责 append。同一段重复编译
   （例如重抽同一段）只在指纹变化时才落一条 —— 否则流水会被"一模一样的
   那条"刷满，真正变化的那一次反而被埋掉。 */
const lastFp = new Map();     /* cid -> fp */

function castNodeOf() {
  const g = (app && app.graph) || null;
  const nodes = (g && (g._nodes || g.nodes)) || [];
  for (const n of nodes) if (n && n.type === "CSGlideCastCS") return n;
  return null;
}

function projNameOf(node) {
  try { return String((node.h3ui && node.h3ui.castName && node.h3ui.castName()) || ""); }
  catch (_) { return ""; }
}

function post(payload) {
  try {
    return api.fetchApi("/cglide/store/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);        /* 流水不是关键路径：失败一律吞掉 */
  } catch (_) { return Promise.resolve(null); }
}

/* ---------------------------------------------------------------- 编译流水 */
/**
 * 记一次编译。返回**要挂到本轮结果行上的告警**（重复段 / 引用缺口）。
 * @param {object} rec bz_prompt_build 的回执
 * @param {object} [ui] 导演台 ui bag（有就顺手把告警记进本轮 warnings）
 */
export function noteCompile(rec, ui) {
  const warns = [];
  if (!rec) return warns;

  const tag = `段${rec.idx + 1}${rec.cid ? " " + rec.cid : ""}`;

  /* 重复段：串段的最终表现就是它。命中就点名"和谁一样"，不用再去猜。
     ⚠ 判据是**送出去的那几张**（dupFp），不是整台架面 —— 全片固定编号时
     每段架子上都是同一批素材，拿架面指纹比会把整部片都判成串段，用户照着
     这句去查，越查越像串了（20261024 真机日志）。 */
  if (rec.dupOf) {
    warns.push(`${tag} 与 ${rec.dupOf} 的${rec.dupWhy} —— 这两段会渲染出一模一样的东西`);
    console.warn(`[编译] ⚠ ${tag} 与 ${rec.dupOf} 的${rec.dupWhy}（指纹 `
      + `${rec.dupFp || ""}）`
      + " —— 这一轮它们会出同一份东西，查这两段的 @图片N 是不是写成了同几格");
  }
  /* 引用缺口：词里 @图片3，槽位 3 是空的。以前这类只在导演台按**当前架面**
     自检一次（渲染循环里架面可能已经停在别段），现在按段数据判，永远不会误报。 */
  if (rec.gaps && rec.gaps.length) {
    warns.push(`${tag} 引用的 ${rec.gaps.join("、")} 没有对应素材`);
  }
  /* 第三刀：文本里点了名、但解析不出来的引用。以前这里一片安静 ——
     `@马魁` 既不算引用也不报错，用户以为发图了，实际只是散文。
     只往控制台喊：给人看的那句文案由 resolve 生成（那里有段号与原因），
     两边各写一遍会在结果行里出现两句意思相同的话。 */
  const un = rec.unresolved || [];
  if (un.length) {
    console.warn(`[编译] ⚠ ${tag} 有 ${un.length} 处引用解析不了：`
      + un.map((u) => `@${u.name}(${u.why === "alias-off" ? "别名模式关着" : "本段没有这件素材"})`)
        .join("、")
      + " —— 这几处不会变成参考图");
  }
  /* 定义句错位（20261023）：`将 @图片15 定义为 KF_01-05` 但第 15 格是帆布包。
     这类错位不报错、不缺图、画面还可能"看着还行" —— 只有把"文案说的"和
     "架上实际的"并排摆出来才看得见。给人看的那句已由 resolve 生成（那里有
     段号与"现在在第几格"），这里只做控制台一声。 */
  const dp = rec.defProblems || [];
  if (dp.length) {
    const say = (p) => `${p.tok} 文案说是「${p.claim}」，实际是「${p.actual}」`
      + (p.k === "moved" && p.at ? `（${p.claim} 现在在第 ${p.at} 格）`
        : (p.elsewhere && p.elsewhere.cid
          ? `（本段没有，${p.claim} 在 ${p.elsewhere.cid} 第 ${p.elsewhere.idx + 1} 格）`
          : `（全片都没有 ${p.claim} —— 素材缺失）`));
    const lost = dp.filter((p) => p.k === "missing" && !p.elsewhere);
    console.warn(`[编译] ⚠ ${tag} 定义句对不上：`
      + dp.map(say).join("；")
      + (lost.length ? ` —— ${lost.length} 件素材全片都没有，这几格现在挂着别的图` : ""));
  }

  /* 片名取**正在提交的那个**导演台（多节点画布上"第一个"未必是它）。 */
  const name = projNameOf((ui && ui.node) || castNodeOf());
  const key = rec.cid || `#${rec.idx}`;
  if (name && lastFp.get(key) !== rec.fp) {
    lastFp.set(key, rec.fp);
    post({
      name, action: "compile", cid: rec.cid || null, actor: "frontend",
      payload: {
        idx: rec.idx, words: rec.words, slots: rec.slots, refs: rec.refs,
        gaps: rec.gaps, src: rec.src, patched: rec.patched || [],
        wordFp: rec.wordFp, imgFp: rec.imgFp, vidFp: rec.vidFp,
        audFp: rec.audFp, fp: rec.fp, dupOf: rec.dupOf || "",
        aliasOn: rec.aliasOn !== false,
        unresolved: (rec.unresolved || []).map((u) => ({ name: u.name, why: u.why })),
        defs: (rec.defProblems || []).map((p) => ({
          k: p.k, tok: p.tok, claim: p.claim, actual: p.actual, at: p.at || 0,
          elsewhere: p.elsewhere && p.elsewhere.cid
            ? { cid: p.elsewhere.cid, idx: p.elsewhere.idx } : null,
        })),
      },
    });
  }

  /* resolve 阶段攒下的告警（缺架记录 / 未解析引用 / 别名关着）也要进结果行。
     它们是按段身份判出来的，比排队前那次面板自检更可信；两边同文案时按字符串去重。 */
  for (const w of rec.warnings || []) if (warns.indexOf(w) < 0) warns.push(w);

  if (ui && ui.run && warns.length) {
    /* 去重：排队前自检已经报过的条目（同一句话）不再追加一遍 —— 结果行是给人
       看的一句话，不是日志。 */
    const cur = ui.run.warnings || [];
    for (const w of warns) if (cur.indexOf(w) < 0) cur.push(w);
    ui.run.warnings = cur;
  }
  return warns;
}

/* ---------------------------------------------------------------- 段体检 */
/**
 * 全工程段体检。
 * @param {object} [castNode] 不传就找画布上第一个导演台
 * @returns {{rows: object[], dups: object[], node: object|null}}
 *
 * 只读：不 stash、不落库、不动面板。任何一段解析失败都单独标出来，
 * 不会让整张表出不来（那正是最需要看表的时候）。
 */
export function health(castNode) {
  const node = castNode || castNodeOf();
  const rows = [], dups = [], defRows = [];
  /* 缺素材按名字汇总（见下面"整片缺素材"那张表）。 */
  const goneMap = new Map();
  if (!node || !node.h3ui) {
    console.warn("[段体检] 画布上没有导演台节点");
    return { rows, dups, node: null, defs: defRows };
  }
  let shots = [];
  try { shots = (node.h3ui.proj() || {}).shots || []; } catch (_) { shots = []; }

  /* 成片信息（可播与否）来自中央档案缓存；缓存没到就留空，不阻塞体检。 */
  let film = null;
  try {
    const nm = projNameOf(node);
    film = nm ? bzStore.film(nm) : null;
  } catch (_) { film = null; }
  const clipOf = (cid) => {
    const list = (film && film.clips) || [];
    for (const c of list) if (c && String(c.id) === String(cid)) return c;
    return null;
  };

  shots.forEach((shot, i) => {
    const cid = String((shot && shot.clip) || "");
    const row = {
      段: i + 1, 名: (shot && shot.name) || "", cid: cid || "(未登记)",
      词: 0, 图: 0, 送图: 0, 视: 0, 音: 0, 引用: "", 缺口: "", 未解析: "",
      成片: "", 词指纹: "", 图指纹: "", 标记: "",
    };
    try {
      const { seg, receipt: r } = promptBuild.inspect(node, cid || String(shot.id || ""), i);
      row.词 = r.words;
      row.图 = r.slots.images; row.视 = r.slots.videos; row.音 = r.slots.audios;
      /* 架子上有几张（图）≠ 这一段送几张（送图）：后端严格按 @引用 过滤，
         一张没提就一张都不送。两列并排才看得出"28 张里其实只用了 6 张"。 */
      row.送图 = r.sendN || 0;
      row.引用 = r.refs.map((x) => "@" + x).join("");
      row.缺口 = r.gaps.join("");
      /* 第三刀：文本里点了名但解析不出来的引用。以前这里什么都不显示 ——
         用户以为引用了，实际只是散文，一张参考图都没挂上。 */
      const un = r.unresolved || [];
      row.未解析 = un.map((u) => "@" + u.name).join("");
      if (un.length) {
        const off = un.filter((u) => u.why === "alias-off").length;
        row.标记 += off === un.length ? "别名模式关着 " : "未解析引用 ";
      }
      row.词指纹 = r.wordFp; row.图指纹 = r.imgFp;
      /* 定义句错位（20261023）：这一段的文案断言"第 N 格是谁"，架上却不是。
         详情不进主表 —— 主表已经 13 列，再塞长句就没法看了；这里只标记，
         真正的明细在表下面那张专表里。 */
      const dp = r.defProblems || [];
      if (dp.length) {
        row.标记 += (dp.some((p) => p.k === "missing") ? "缺素材 " : "定义句错位 ");
        defRows.push({ 段: i + 1, cid: cid || "(未登记)", items: dp });
      }
      /* 缺素材按名字汇总：同一张图常常被好几段一起点名（20261024 现场：
         KF_01-05/06/07 各被一段点名 —— 逐段看是"三段各缺一张"，汇总看才是
         "整片缺 3 张，一次补齐就全好"）。 */
      for (const p of dp) {
        if (p.k !== "missing") continue;
        const g = goneMap.get(p.claim) || { 名字: p.claim, 被这些段点名: [], 别的段有: "" };
        g.被这些段点名.push((i + 1) + "段" + (p.tok ? " " + p.tok : ""));
        if (p.elsewhere && p.elsewhere.cid) {
          g.别的段有 = `${p.elsewhere.cid} 第 ${p.elsewhere.idx + 1} 格`;
        }
        goneMap.set(p.claim, g);
      }
      if (r.src && r.src.rack === "空") row.标记 += "无架记录 ";
      const c = cid ? clipOf(cid) : null;
      if (c) {
        const takes = (c.takes || []).length;
        row.成片 = c.film ? (c.playable === false ? "有(有缺口)" : "有") : "无";
        if (takes > 1) row.成片 += ` ${takes}版`;
      }
      rows.push({ r, seg, row });
    } catch (e) {
      row.标记 += "解析失败:" + String((e && e.message) || e).slice(0, 24);
      rows.push({ r: null, seg: null, row });
    }
  });

  /* 撞车检测：词指纹相同 = 八成串段；**送出去的图**相同 = 这两段给模型的
     基准完全一样（也八成是写成了同几格）。架面指纹相同不算错 —— 全片固定
     编号时它就是一样，那列只用来对账"这台架子是不是同一台"。 */
  const byWord = new Map(), byImg = new Map();
  for (const { r, row } of rows) {
    if (!r) continue;
    if (r.words > 0) {
      const k = r.wordFp;
      if (byWord.has(k)) {
        const a = byWord.get(k);
        dups.push({ kind: "word", a: a.cid, b: row.cid, fp: k });
        row.标记 += `词与段${a.idx + 1}相同 `;
      } else byWord.set(k, { cid: row.cid, idx: r.idx });
    }
    if (r.sendN > 0) {
      const k = r.sendFp;
      if (byImg.has(k)) {
        const a = byImg.get(k);
        dups.push({ kind: "img", a: a.cid, b: row.cid, fp: k });
        row.标记 += `送图与段${a.idx + 1}相同 `;
      } else byImg.set(k, { cid: row.cid, idx: r.idx });
    }
  }

  console.table(rows.map((x) => x.row));

  /* 定义句对账专表（20261023）：主表 13 列已经排满，「@图片15 文案说 KF_01-05、
     架上实际 帆布包」这种话塞不进一格。单独一张表反而最好读 —— 它要回答的
     就一个问题："这句话现在指的是不是那一张图"。 */
  if (defRows.length) {
    const flat = [];
    for (const g of defRows) {
      for (const p of g.items) {
        flat.push({
          段: g.段, cid: g.cid, 引用: p.tok, 文案说: p.claim,
          架上实际: p.actual || "(空格位)",
          说明: p.kind === "moved"
            ? `「${p.claim}」现在在第 ${p.at} 格（${p.atTok}）`
            : (p.elsewhere && p.elsewhere.cid
              ? `本段没有，它在 ${p.elsewhere.cid} 第 ${p.elsewhere.idx + 1} 格`
              : "全片都没有这张图 —— 素材缺失"),
        });
      }
    }
    console.warn(`[段体检] 定义句对账：${flat.length} 处对不上 —— `
      + `文案里「@图片N 定义为 名字」断言的是**位置**，格子挪过、或那件素材`
      + `根本没导入，这句话就不再成立（不影响渲染，但模型会拿错图当基准）`);
    console.table(flat);

    /* 整片缺素材：一张图常同时被好几段点名，按名字汇总才是"要补几张"的答案。 */
    if (goneMap.size) {
      const gone = [...goneMap.values()].map((g) => ({
        缺的素材: g.名字,
        状态: g.别的段有 ? `别的段有（${g.别的段有}）` : "全片都没有 · 需导入",
        被点名: g.被这些段点名.join("、"),
      }));
      console.warn(`[段体检] ⚠ 整片缺 ${gone.length} 件素材：`
        + gone.map((g) => g.缺的素材).join("、")
        + " —— 这几件的「定义句」还在，但素材不在架上，"
        + "这些格现在挂着别的图，模型会拿错图当基准");
      console.table(gone);
    }
  } else if (rows.length) {
    console.info("[段体检] 定义句对账：全部对得上");
  }

  /* 基准共用 / 基准闲置（20261024 现场）
  ------------------------------------------------------------
  「两段把**同一件**素材断言成自己的本段基准」是复制段之后最常见的残留：
  段号改对了，`将 @图片13 定义为 KF_01-03` 那句没改。它不报错、不缺图，
  画面看着都"对"，只是两段拿同一张基准图生成 —— 用户读作"参考图串了"。
  真实现场：段1/2/3 分别是 KF_01-01/02/03，段4 仍是 KF_01-03，而架上的
  KF_01-04 一整轮没有任何一段引用它。判据（只认纯 ASCII 素材名、中文名不报）
  在 bz_prompt_build.basisOf 里，是纯函数，自测能直接喂假数据。 */
  const basis = basisOf(rows.map((x) => ({ idx: x.row.段 - 1, seg: x.seg, receipt: x.r })));
  const sharedBase = basis.shared.map((g) => ({
    素材: g.name,
    被这几段断言: g.segs.map((n, i) => `${n}段(${g.toks[i]})`).join("、"),
    说明: "同一件素材被当成两段以上的「本段基准」—— 若不是故意的，"
        + "多半是复制段之后只改了数字、没改名字",
  }));
  const idleBase = basis.idle.map((g) => ({
    素材: g.name, 架在第几段: g.seg + "段", 格: g.slot, 文件: g.file,
  }));

  const bad = rows.filter((x) => x.row.标记).length;
  const unres = rows.filter((x) => x.row.未解析).length;
  const dupW = dups.filter((d) => d.kind === "word");

  if (sharedBase.length) {
    console.warn(`[段体检] ⚠ 有 ${sharedBase.length} 件素材被**两段以上**当成「本段基准」：`
      + sharedBase.map((g) => g.素材).join("、")
      + " —— 这几件不会报错也不缺图，只是那几段在拿同一张图当画面基准，"
      + "看起来就像「参考图串了」。逐段核对定义句里的名字。");
    console.table(sharedBase);
  }
  if (idleBase.length) {
    console.warn(`[段体检] ⚠ 有 ${idleBase.length} 件命名规范的素材摆在架上、`
      + `但整片没有任何一段引用它：` + idleBase.map((g) => `${g.素材}（${g.架在第几段}第 ${g.格} 格）`).join("、")
      + " —— 这类素材通常是「该接到某一段、却一直没接上」的那一张。");
    console.table(idleBase);
  }
  if (bad || unres || defRows.length || sharedBase.length || idleBase.length) {
    console.warn(`[段体检] ${rows.length} 段里有 ${bad} 段带标记`
      + (dupW.length ? `；**${dupW.length} 处段词撞车**（段数据串了，这几段会出同一份东西）` : "")
      + (unres ? `；**${unres} 段有解析不了的引用**（文本写了 @名字，本段架上没有这件素材，`
        + `或者别名模式关着 —— 那几处不会变成参考图）` : "")
      + (defRows.length ? `；**${defRows.length} 段有定义句错位**`
        + `（文案说"这一格是谁"，架上却不是它 —— 见下面那张表）` : "")
      + (sharedBase.length ? `；**${sharedBase.length} 件基准被多段共用**` : "")
      + (idleBase.length ? `；**${idleBase.length} 件素材摆着没人引用**` : "")
      + (goneMap.size ? `；**整片缺 ${goneMap.size} 件素材**：`
        + [...goneMap.keys()].join("、") : "")
      + "。看「未解析」列、带标记的行，以及定义句对账表。");
  } else {
    console.info(`[段体检] ${rows.length} 段全部通过：没有段词撞车，没有素材撞车，`
      + `没有解析不了的引用，定义句也全部对得上。`);
  }
  return { rows: rows.map((x) => x.row), dups, node, defs: defRows,
           sharedBase, idleBase };
}

/* ---------------------------------------------------------------- 流水 */
const ACTION_ZH = {
  compile: "编译提交", rack_save: "媒体架落库", desk_save: "文案台落库",
  state_save: "面板落库", shot_state: "段状态", rack: "媒体架",
  resize: "改尺寸", register: "登记段", collect: "收片",
  film_set: "设定成片", current: "切段",
  run_collected: "收片完成", run_collect_dup: "重复收片(已拦)",
  clip_add: "新建段", clip_remove: "删除段", reorder: "改顺序",
  take_swap: "切版本", take_drop: "删版本", lock: "锁定", pins: "接法",
  transition: "接缝",
  /* 20261023 第二/三刀新增 */
  rev_drift: "指纹漂移", words_filled: "词已补齐",
};

/* prompt_id 是 UUID，整串会把表格撑爆；只要前 8 位就够和别的记录对上。 */
const shortId = (v) => (v ? String(v).slice(0, 8) : "");

function digest(ev) {
  const p = ev.payload || {};
  if (ev.action === "compile") {
    return `词 ${p.words || 0}字 · 图${(p.slots || {}).images || 0}`
      + ` 视${(p.slots || {}).videos || 0} 音${(p.slots || {}).audios || 0}`
      + ` · 指纹 ${p.wordFp || "?"}/${p.imgFp || "?"}`
      + (p.dupOf ? ` · ⚠ 与 ${p.dupOf} 重复` : "")
      + (p.defs && p.defs.length ? ` · ⚠ 定义句 ${p.defs.length} 处对不上` : "");
  }
  /* 落库流水（20261023 起带内容指纹）：字数+指纹，与编译回执同一套算法，
     所以两行并排看就能判断"落库的那份"和"送出去的那份"是不是同一个东西。 */
  if (ev.action === "desk_save") {
    const bits = [];
    if (p.chars != null) bits.push(`段词 ${p.chars}字 ${p.fp || ""}`.trim());
    if (p.g_chars != null) bits.push(`片子级 ${p.g_chars}字 ${p.g_fp || ""}`.trim());
    if (p.pack) bits.push(`整包 ${p.segs || 0} 段`);
    return bits.join(" · ") || "（无内容字段 · 旧前端）";
  }
  if (ev.action === "rack_save") {
    const nn = p.named || null;
    const cnt = (k) => String(nn && nn[k] != null ? nn[k] : (p[k] || 0));
    return `图${cnt("images")} 视${cnt("videos")} 音${cnt("audios")}`
      + (p.img_fp ? ` · 指纹 ${p.img_fp}/${p.vid_fp}/${p.aud_fp}`
                  : " · （旧记录：槽数含空位，无指纹）");
  }
  if (ev.action === "run_collected" || ev.action === "run_collect_dup") {
    return `prompt ${shortId(p.prompt_id)} · take ${p.take || "?"}`
      + (p.source_node ? ` · 源节点 ${p.source_node}` : "")
      + (p.status ? ` · ${p.status}` : "")
      + (p.path ? ` · ${String(p.path).split(/[\\/]/).pop()}` : "");
  }
  if (ev.action === "resize") {
    return `${p.from != null ? p.from : "?"} → ${p.to != null ? p.to : "?"} 帧`
      + (p.planned ? " · 计划值" : "") + (p.pending ? ` · 待办 ${p.pending}` : "");
  }
  if (ev.action === "reorder") {
    const o = p.order || [];
    return o.length ? `${o.length} 段：${o.map(shortId).join(" → ")}` : "";
  }
  /* 对账：前端提交时自称的指纹 vs 库里此刻的真值。两边都印出来，
     一眼就能看出是"词变了"还是"素材变了"，不用再去比对文件名。 */
  if (ev.action === "rev_drift") {
    const c = p.claim || {}, t = p.store || {};
    const diff = Array.isArray(p.diff) ? p.diff.join("") : "?";
    return `${diff}不一致 · 提交 ${c.word || "?"}/${c.img || "?"}`
      + ` · 库里 ${t.word || "?"}/${t.img || "?"}`
      + (p.used === "submit" ? " · 按提交渲染" : "");
  }
  if (ev.action === "words_filled") {
    return `库里取回 ${p.chars || 0} 字（提交里这一段是空的）`;
  }
  const s = JSON.stringify(p);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

/**
 * 查流水。`bzAudit()` 全工程，`bzAudit("clip_0009")` 单段。
 * @param {string} [cid] 段 id
 * @param {number} [limit] 默认 200
 */
export async function audit(cid, limit) {
  const node = castNodeOf();
  const name = projNameOf(node);
  if (!name) { console.warn("[流水] 没有工程名 —— 先给片子起个名"); return []; }
  let url = `/cglide/store/events?name=${encodeURIComponent(name)}&limit=${limit || 200}`;
  if (cid) url += `&cid=${encodeURIComponent(cid)}`;
  let rows = [];
  try {
    const res = await api.fetchApi(url);
    const d = await res.json().catch(() => ({}));
    rows = (d && d.events) || [];
  } catch (e) {
    console.warn("[流水] 取不到：", e);
    return [];
  }
  if (!rows.length) { console.info("[流水] 没有记录（这个工程还没有编译/落库流水）"); return []; }
  console.table(rows.map((e) => ({
    seq: e.seq,
    时间: new Date((e.ts || 0) * 1000).toLocaleTimeString(),
    动作: ACTION_ZH[e.action] || e.action,
    段: e.cid || "",
    内容: digest(e),
  })));
  /* 单段查流水时顺手对一次账 —— 这是"这段为什么用了别人的图"的**直接判据**：
     最近一次编译送出去的图（imgFp）与库里最后落的图（img_fp）是同一个指纹吗？
     不是 = 那次渲染用的确实不是这一段当时的素材，而且这里能说出是什么时候。 */
  if (cid && rows.length) {
    const rev = rows.slice().reverse();
    const lastC = rev.find((e) => e.action === "compile" && e.payload && e.payload.imgFp);
    const lastR = rev.find((e) => e.action === "rack_save" && e.payload && e.payload.img_fp);
    const at = (e) => new Date((e.ts || 0) * 1000).toLocaleTimeString();
    if (lastC && lastR) {
      const a = lastC.payload.imgFp;
      const b = lastR.payload.img_fp;
      if (a === b) {
        console.info(`[流水] 对账通过：${cid} 最近一次编译的参考图与库里最后落的一致（${a}）`);
      } else {
        console.warn(`[流水] ⚠ 对账不一致：${cid} 编译时用的图 ${a}（${at(lastC)}）`
          + ` ≠ 库里最后落的图 ${b}（${at(lastR)}）`
          + " —— 这次渲染用的不是这一段当时的素材，往前翻 rack_save 就能看到它被谁换过");
      }
    }
    const dups = rows.filter((e) => e.action === "run_collect_dup");
    if (dups.length) {
      console.info(`[流水] 这一段有 ${dups.length} 次重复收片被拦下`
        + `（两条收片通道前后脚到达，没有重复复制/重复落成片）`);
    }
  }
  return rows;
}

/* ---------------------------------------------------------------- 装到窗口 */
function install() {
  globalThis.bzHealth = (node) => health(node);
  globalThis.bzAudit = (cid, limit) => audit(cid, limit);
  /* 槽位纠错（20261024）：文案点名了"第 N 格是谁"，那一格却放着别的图。
     bzVacate() 立即跑一次 · bzVacateUndo() 还原 · bzVacateAuto(false) 关掉自动。
     自动时机是"切到那一段时"（见 csglide_rack_seg.switchSeg），默认开。 */
  const rackOf = () => {
    const g = (app && app.graph) || null;
    const ns = (g && (g._nodes || g.nodes)) || [];
    for (const n of ns) {
      if (!n) continue;
      if (n.gmr && typeof n.gmr.vacate === "function") return n.gmr;
    }
    return null;
  };
  globalThis.bzVacate = () => {
    const g = rackOf();
    if (!g) { console.warn("[槽位纠错] 画布上没找到媒体架"); return null; }
    return g.vacate();
  };
  globalThis.bzVacateUndo = () => {
    const g = rackOf();
    if (!g) { console.warn("[槽位纠错] 画布上没找到媒体架"); return false; }
    return g.vacateUndo();
  };
  globalThis.bzVacateAuto = (on) => {
    const g = rackOf();
    if (!g) { console.warn("[槽位纠错] 画布上没找到媒体架"); return null; }
    const v = g.vacateAuto(on);
    console.info("[槽位纠错] 自动纠错已" + (v ? "开启" : "关闭")
      + "（手动跑 bzVacate() 仍然可用）");
    return v;
  };
  /* 排查"点了没反应"的两把刀（20261024）：
       bzPlan() —— **只看不动**：把"这一格该放谁 / 现在放的是谁"列成表。
       bzSort() —— 等于按一次「按提示词排序」按钮，但控制台里能留下全过程。
     一条命令就能分清"没读到文案""没认出名字""缺素材""纠错没接上"这四种，
     不必再靠打开面板肉眼逐格核对。 */
  globalThis.bzPlan = (cid) => {
    const g = rackOf();
    if (!g) { console.warn("[媒体架] 画布上没找到媒体架"); return null; }
    if (typeof g.vacatePlan !== "function") { console.warn("[媒体架] 这个实例没有纠错计划"); return null; }
    const p = g.vacatePlan(cid);
    const rows = [];
    for (const m of (p && p.moved) || []) {
      rows.push({ 类型: "归位", 目标格: m.want + 1, 文案要的: m.claim, 现在在: m.at + 1 });
    }
    for (const v of (p && p.missing) || []) {
      rows.push({ 类型: "腾位", 目标格: v.want + 1, 文案要的: v.claim, 现在放着: v.actual });
    }
    console.info(`[媒体架] 纠错计划（段 ${(p && p.cid) || "?"}，${rows.length} 处）`
      + `· 读到文案 ${(p && p.text || "").length} 字`);
    if (rows.length) console.table(rows); else console.info("  没有要纠正的格子");
    return p;
  };
  globalThis.bzSort = (all) => {
    const g = rackOf();
    if (!g) { console.warn("[媒体架] 画布上没找到媒体架"); return null; }
    const fn = all ? g.sortAllSegs : g.sortByPrompt;
    if (typeof fn !== "function") { console.warn("[媒体架] 这个实例没有排序入口"); return null; }
    console.info("[媒体架] 开始" + (all ? "排全部段" : "按提示词排序") + "……");
    return fn.call(g);
  };
  /* 「每一段到底送了哪几张参考图」—— 一条命令 (20261024)
  ------------------------------------------------------------
  为什么非要有它：媒体架是全片固定编号，**每段架子上都是同样那 28 张图**，
  肉眼看面板根本分不清"这一轮送给模型的是哪几张"；旧日志里的指纹又是
  架面指纹（每段相同），于是"参考图串了没有"只能靠感觉猜 —— 上一轮就是
  被这句"参考图完全相同"带偏的。
     bzRefs()            全片：每段一行（架子几张 / 送几张 / 送了哪几个）
     bzRefs('clip_0003') 单段：逐条 @引用→第几格→哪张图，外加"架上有但这段
                         没引用"的清单（那就是"为什么这段画面里没有它"）。
  只读：不编译、不落库、不动面板。 */
  globalThis.bzRefs = (cid) => {
    const node = castNodeOf();
    if (!node || !node.h3ui) { console.warn("[引用对账] 画布上没找到导演台"); return null; }
    let shots = [];
    try { shots = (node.h3ui.proj() || {}).shots || []; } catch (_) { shots = []; }
    if (!shots.length) { console.warn("[引用对账] 工程里没有分段"); return null; }
    const want = cid ? String(cid) : "";
    const rows = [], detail = [], unused = [];
    shots.forEach((shot, i) => {
      const c = String((shot && shot.clip) || "");
      if (want && c !== want) return;
      let seg = null, r = null;
      try { const x = promptBuild.inspect(node, c || String(shot.id || ""), i); seg = x.seg; r = x.receipt; }
      catch (e) { console.warn("[引用对账] 第 " + (i + 1) + " 段解析失败:", e); return; }
      const sentTxt = (r.sent || []).filter((x) => x.f).map((x) => x.t).join(" ") || "(一张都没引用)";
      /* 模型那一侧看到的编号：@图片11 在模型眼里是 <Picture 6>。文案台显示
         @图片11、缩略图也对，但模型读的是"第 6 张" —— 这两列并排摆出来，
         "引用有没有对上"就不再靠眼睛比对了。 */
      const pics = r.pics || {};
      const ordTxt = Object.keys(pics)
        .filter((k) => pics[k] && pics[k].k)
        .sort((a, b) => pics[a].k - pics[b].k)
        .map((k) => k + "=P" + pics[k].k)
        .join(" ");
      rows.push({
        段: i + 1, cid: c || "(未登记)",
        架子图: r.slots.images, 送图: r.sendN || 0,
        引用: sentTxt,
        模型编号: ordTxt || "",
        空格引用: (r.gaps || []).join(" ") || "",
      });
      if (!want) return;
      /* 单段模式：逐条列出"这句话指向哪张图、模型叫它第几号"。空格位也列 ——
         那正是要修的地方。 */
      for (const x of (r.sent || [])) {
        const p = pics[x.t] || {};
        detail.push({
          引用: x.t, 格: x.s, 类别: x.k,
          模型看到: x.f ? (p.dropped ? "超上限，已从提示词移除"
                        : ("Picture " + (p.k || "?"))) : "（空格位 → 已从提示词移除）",
          送出的图: x.f || "(空)",
        });
      }
      const used = new Set((r.sent || []).filter((x) => x.f).map((x) => x.k + ":" + x.s));
      (seg.sig.images || []).forEach((f, k) => {
        if (!f || f === "-") return;
        if (used.has("images:" + (k + 1))) return;
        unused.push({ 格: k + 1, 文件: f });
      });
    });
    console.info(`[引用对账] ${rows.length} 段 · 架面相同不等于送出相同：`
      + `后端严格按 @引用 过滤，没被引用的格子一张都不会送`);
    console.table(rows);
    if (want && detail.length) {
      console.info(`[引用对账] ${want} 逐条：`);
      console.table(detail);
      if (unused.length) {
        console.info(`[引用对账] ${want} 架上有、但这一段没引用的 ${unused.length} 格`
          + `（这些图不会送进模型）：`);
        console.table(unused);
      }
      return { rows, detail, unused };
    }
    return { rows, detail, unused };
  };
  /* 与段体检配套的一行小抄：用户不必记住函数名。只打一次。 */
  if (!globalThis.__bzAuditHinted) {
    globalThis.__bzAuditHinted = true;
    setTimeout(() => {
      console.info("[段体检] 控制台可用：bzHealth() 全工程段体检 · bzAudit() 编译/落库流水"
        + " · bzAudit('clip_0009') 单段流水 · bzPlan() 看槽位纠错计划（只看不动）"
        + " · bzSort() 跑一次按提示词排序"
        + " · bzRefs() 每段到底送了哪几张参考图");
    }, 2500);
  }
}

install();
