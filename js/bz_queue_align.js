/* ============================================================
 * 画布运行对齐（20261017）
 * ------------------------------------------------------------
 * 为什么要有这一层：
 *   画 ▶ / Ctrl+Enter 走的是 ComfyUI 原生提交，交出去的是「画布 widget 此刻
 *   的字面量」。但导演台 / 文案台 / 媒体架的真实状态住在面板闭包与中央库里
 *   ——两者不同步时，后端读到的就是空提示词、空素材、空段落 id；而空 clip
 *   还会被当成「新建一段」，于是你以为在重跑第 2 段，时间轴上却多出一个新段。
 *
 *   20261023 起改用**编译式渲染**（bz_prompt_build）：按段身份把三个
 *   *_data 整块覆写成"这一段自己的数据"，而不是"打补丁修画布字面量"。
 *   「全部渲染」的 queueOnce 走的是同一份编译函数，两条提交路径从此不可能
 *   出现"一个对一个错"。
 *
 * 边界（很重要）：
 *   · 只在提交对象里含导演台时才介入，普通工作流完全不受影响
 *   · 编译失败退回旧的提交对齐；再失败就按原样提交 —— 对齐/编译失败绝不能
 *     把用户手点的运行拦下来
 *   · 不改 ComfyUI 任何文件，只是把 api.queuePrompt 换了个包装
 *
 * 不弹窗（20261026 用户定）：
 *   对齐/编译的结果只写 console，不在屏幕右下角弹 toast。画布运行是最高频的
 *   动作，每次提交弹一条「班长 · 提交对齐」纯属噪音 —— 结果对不对看画面就知道，
 *   真要排障控制台里有 [编译] / [班长] 两行。
 *
 * 补不到的部分（设计如此，不是本文件的缺陷）：
 *   逐段切换、自动续写、批量跑多段仍在「全部渲染」的循环里。这里的对齐只让
 *   单次运行等价于「全部渲染 · 只跑当前这一段」。
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { projectStore } from "./bz_project_store.js";
import { promptBuild, lineOf } from "./bz_prompt_build.js";
import { restoreVideoWorkflow } from "./bz_video_snapshot.js";
import { noteCompile } from "./bz_audit.js";
import { verifySingleSource } from "./bz_single_source.js";
import { applyStageScope, DEFAULT_RUN_MODE, DEFAULT_S3_MODE } from "./bz_stage_orchestrator.js";
import { applyGroupScope, applyPostGroupScope, captureExecutionGraph } from "./bz_group_orchestrator.js";
import { enabledStages, disabledPostGroups } from "./bz_stage_flow.js";
import { flushSegWrites } from "./bz_seg.js";

const CAST = "CSGlideCastCS";
let patched = false;

/** 画布上的导演台节点（面板状态挂在 node.h3ui.st 上，与「全部渲染」同一份）。 */
function castNodeOf() {
  const g = (typeof app !== "undefined" && app && app.graph) || null;
  const nodes = (g && (g._nodes || g.nodes)) || [];
  for (const n of nodes) {
    if (n && n.type === CAST) return n;
  }
  return null;
}

/** 这次提交里有没有导演台 —— 没有就当普通工作流，一律不碰。 */
function hasCastIn(prompt) {
  const out = (prompt && prompt.output) || {};
  for (const k of Object.keys(out)) {
    if (out[k] && out[k].class_type === CAST) return true;
  }
  return false;
}

/* 交付提交的载荷级识别（B1，20261123）：放行不能只挂在提交对象身份上 ——
   中间层克隆/重建提交对象时 WeakSet 凭据会丢，整片子图就被当普通分段提交，
   预检会拦下交付补丁（cont.frames=0 / pin=0）、编排会改它的接线。
   两条载荷通道，认出任一条即交付：
   · 提交对象自带的 bz_delivery 标记（整片推送 / 整片潜空间推送各写各的）；
   · 导演台 h3_data 里 push_film_latent=true —— 全仓只有潜空间推送补丁写它
     （csglide_cast_review.js），普通分段提交不会出现。 */
function deliveryKindOf(workflow) {
  const tag = workflow && workflow.bz_delivery;
  if (tag === "whole_film" || tag === "whole_film_latent") return tag;
  const out = (workflow && workflow.output) || {};
  for (const k of Object.keys(out)) {
    const n = out[k];
    if (!n || n.class_type !== CAST) continue;
    const raw = (n.inputs || {}).h3_data;
    if (typeof raw !== "string") continue;
    try { if (JSON.parse(raw).push_film_latent === true) return "whole_film_latent"; }
    catch (_) { /* h3_data 坏了交给预检报错，不在这里当交付放行 */ }
  }
  return "";
}

/* 提交前门禁（20261106 v2 阶段 ③）——与 csglide_preflight.py 同一套规则。
   只把「会静默错段 / 收不上片」的列为错误；媒体架 chain.name 为空是既有设计，
   不检查。普通工作流（无导演台）直接放行。 */

/* 合并节点的「哪一采」由它的画面来自哪一路 VAE 解码决定。
   与后端 banzhang_video_tools._declare_film_identity() 同一口径：最多向上看 4 跳，
   碰到 VAE 解码就认下来；碰到另一个视频合并节点必须停 —— 超分/插帧链的画面来自
   上一采的合并节点，那是衍生片，不能算这一采的分段片。 */
function combineDecodeRoot(out, nid) {
  const seen = new Set();
  let frontier = Object.values(((out[nid] || {}).inputs) || {})
    .filter(v => Array.isArray(v) && v.length === 2).map(v => String(v[0]));
  for (let hop = 0; hop < 4 && frontier.length; hop++) {
    const nxt = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const spec = out[id] || {};
      const cls = String(spec.class_type || "");
      /* 覆盖 VAEDecode / VAEDecodeAudio / VAEDecodeTiled / BanZhang_H3VAEDecodeFast。 */
      if (cls.indexOf("VAEDecode") >= 0) return id;
      if (cls === "banzhangVideoCombine") continue;
      for (const v of Object.values(spec.inputs || {})) {
        if (Array.isArray(v) && v.length === 2) nxt.push(String(v[0]));
      }
    }
    frontier = nxt;
  }
  return "";
}

function preflightOf(workflow) {
  const out = (workflow && workflow.output) || {};
  const entries = Object.keys(out).map(k => [k, out[k] || {}]);
  const casts = entries.filter(([, n]) => n.class_type === CAST);
  if (!casts.length) return [];
  const errors = [];
  if (casts.length > 1) errors.push("有 " + casts.length + " 个导演台 —— 只保留一个，段身份才唯一");
  const [castId, cast] = casts[0];
  const ins = cast.inputs || {};
  let h3 = {};
  try { h3 = JSON.parse(ins.h3_data || "{}"); } catch (e) { errors.push("h3_data 不是合法 JSON"); }
  const chain = h3.chain || {};
  const name = String(chain.name || "").trim();
  const clip = String(chain.clip || "").trim();
  if (!name) errors.push("导演台 #" + castId + " 的 chain.name 为空：工程名没登记");
  /* 提交编译会主动清空 clip、后端按 shot 认段（csglide_cast.py:2791-2801），
     所以 clip 空不是错误；两者都空才是真的没身份。 */
  const shot = String(chain.shot || "").trim();
  if (!clip && !shot) errors.push("导演台 #" + castId + " 的 chain.clip 与 chain.shot 都为空：无法认段");
  if (Array.isArray(ins.h3_override)) {
    const src = out[String(ins.h3_override[0])] || {};
    const up = src.inputs || {};
    const literal = ["h3_data", "value", "text", "string"]
      .some(k => typeof up[k] === "string" && up[k].trim());
    if (!literal) errors.push("导演台 #" + castId + " 的 h3_override 上游没有可读字面值，不能用旧 h3_data 顶替");
  }
  for (const [nid, n] of entries) {
    if (n.class_type !== "CSGlideDeskCS") continue;
    let other = "";
    try { other = String((JSON.parse((n.inputs || {}).desk_data || "{}").chain || {}).name || "").trim(); } catch (e) {}
    if (name && other && other !== name) {
      errors.push("文案台 #" + nid + " 的工程名「" + other + "」与导演台「" + name + "」不一致");
    }
  }
  /* 20261111 阶段 1：💾 续拍存档已并入 🎬 H3 VAE 快速解码，画布不再有存档节点。
     一采/二采各挂一个解码是正常拓扑，这里只要求「至少一个」，不再数唯一开关。 */
  const decodes = entries.filter(([, n]) => n.class_type === "BanZhang_H3VAEDecodeFast");
  if (!decodes.length) errors.push("画布上没有「🎬 H3 VAE 快速解码」节点 —— 续拍存档、阶段判定和分段片认片现在都由它承担，请至少接一个");
  /* 声明式收片（20261111 起）：_declare_film_identity() 给每个合并节点自报
     bz_role / bz_cid / bz_stage，csglide_chain.py 按
     「segment + 本段 cid + 时间轴当前选中阶段」精确锁定一片。一采/二采/三采各接一个
     合并节点本来就是正常拓扑，bz_cid 相同也不会导致拒收 —— 旧门禁只数「接了
     画面输入的合并节点」就一律判「收片拒收」，是声明式之前只按 cid 筛的
     老假设，会把正常三采提交拦在提交前（20261108 真机）。
     现在只拦真正会冲突的情况：两个合并节点共享同一路 VAE 解码 = 同一采重复出片。
     其余唯一性交给唯一真值源（后端收片）裁决，它会带节点号给出可操作的报错。 */
  const wired = entries.filter(([, n]) => n.class_type === "banzhangVideoCombine"
    && ((n.inputs || {})["🖼️ 图像"] || (n.inputs || {})["🎬 视频文件"] || (n.inputs || {})["🎞️ 帧流"]));
  if (!wired.length) {
    errors.push("没有视频合并节点接画面输入 —— 本轮出不了分段片");
  } else {
    const roots = new Map();
    for (const [nid] of wired) {
      const root = combineDecodeRoot(out, nid);
      /* 认不出解码来源（整片口 / 衍生片）的不在这里判，交给后端声明式收片。 */
      if (!root) continue;
      if (roots.has(root)) {
        errors.push("视频合并节点 #" + roots.get(root) + " 与 #" + nid
          + " 的画面来自同一路 VAE 解码 #" + root
          + " —— 同一采重复出片，收片会拒收，只留一个");
      } else {
        roots.set(root, nid);
      }
    }
  }
  return errors;
}

/* 三份 *_data 快照（提交这一刻的字面值），交给后端 segment_bindings 真值核对。 */
function snapshotsOf(workflow) {
  const out = (workflow && workflow.output) || {};
  const pick = (type, key) => {
    for (const k of Object.keys(out)) {
      if (out[k] && out[k].class_type === type) {
        try { return JSON.parse((out[k].inputs || {})[key] || "{}"); }
        catch (_) { return {}; }
      }
    }
    return {};
  };
  const h3 = pick("CSGlideCastCS", "h3_data");
  return { desk: pick("CSGlideDeskCS", "desk_data"),
    rack: pick("CSGlideH3MediaRackCS", "rack_data"), h3,
    clip: String((h3.chain || {}).clip || "") };
}

function install() {
  if (patched || !api || typeof api.queuePrompt !== "function") return false;
  const send = api.queuePrompt.bind(api);
  const orig = (number, submission, ...rest) => {
    if (submission?.workflow?.nodes && Object.values(submission.output || {}).some(
      n => n?.class_type === "banzhangVideoCombine")) {
      const workflow = JSON.parse(JSON.stringify(submission.workflow));
      restoreVideoWorkflow(workflow, submission.output);
      return send(number, { ...submission, workflow }, ...rest);
    }
    return send(number, submission, ...rest);
  };
  const tracked = async (number, submission, ...rest) => {
    const ui = hasCastIn(submission) && castNodeOf()?.h3ui;
    const name = ui?.castName?.();
    const result = await orig(number, submission, ...rest);
    const id = result?.prompt_id || result?.promptId;
    try {
      if (ui && id) {
        // 批跑由整轮循环维护结果；画布单跑入队成功后，旧批跑错误就不再是当前结果。
        if (!ui.run && !ui._bzRunPreparing && ui.castName?.() === name) ui.clearRunResult?.();
        ui.stageFlowQueued?.(String(id));
      }
    }
    catch (e) { console.warn("[H3 Studio] 任务状态显示更新失败：", e); }
    return result;
  };

  api.queuePrompt = async function (number, workflow, ...rest) {
    if (projectStore.takeDeliveryPrompt?.(workflow) || deliveryKindOf(workflow)) {
      if (projectStore.isGloballyRendering() || castNodeOf()?.h3ui?._bzRunPreparing) {
        throw new Error("全部分段运行中，请结束后再推送整片");
      }
      return orig(number, workflow, ...rest);  // 只跳过这一份整片子图，其他提交仍正常编译。
    }
    if (hasCastIn(workflow) && castNodeOf()?.h3ui?._bzDeliveryPreparing) {
      throw new Error("正在准备整片推送或导出，请稍后再提交当前段");
    }
    const batchPrompt = projectStore.takeBatchPrompt(workflow);
    const preparing = hasCastIn(workflow) && !!castNodeOf()?.h3ui?._bzRunPreparing;
    if ((preparing || projectStore.isGloballyRendering()) && !batchPrompt && hasCastIn(workflow)) {
      throw new Error("导演台正在运行全部分段，请等本轮结束后再提交当前段");
    }
    const stageSwitch = hasCastIn(workflow) && castNodeOf()?.h3ui?.stageFlowStagePromise;
    if (stageSwitch && !(await stageSwitch)) throw new Error("阶段切换未完成，请检查后重新运行");
    /* 「🧬 推送整片潜空间」自己把 h3_data 打好补丁（push_film_latent=true）才提交，
       这里再 apply 一次会把整块 h3_data 换成 seg.state（bz_prompt_build.js:899）
       —— 补丁就没了。实测两次后端都报"整片潜空间口：开关关着"都是这一步盖的。
       整片子图的单次放行已在入口按提交对象处理，不再使用全局跳过开关。 */
    /* 用户手点的局部执行优先（20261121）——
       右键「对所选输出节点进行排队」/节点上的 ▶ 走到这里时，rest[0] 已带显式目标
       名单。下面的阶段/组编排是给「导演台按钮」用的**自动范围推断**，它无权覆盖
       用户的**明确意图**：一旦覆盖，挂在出片口下游的支线（人脸修复台等）就永远
       进不了提交名单，表现是「怎么点都不跑」，而且不报错、终端一行日志都没有。
       判定只看一件事：调用方有没有给显式名单。给了就整段放行——既不裁剪也不
       改接线（改接线同样是服务于自动阶段范围的，手动排队时画布上怎么接就怎么跑）。
       这条规则对所有支线节点一视同仁，不是为某个节点开的特例，所以不会再犯。 */
    const explicit = rest[0]
      && (rest[0].partialExecutionTargets || rest[0].queueNodeIds) || null;
    const isExplicit = !!(explicit && (!Array.isArray(explicit) || explicit.length));
    if (isExplicit) {
      console.log("[班长·局部执行] 目标="
        + (Array.isArray(explicit) ? explicit.join(",") : "?")
        + "：用户显式指定，跳过阶段裁剪与改接线");
    }
    const detection = !isExplicit && hasCastIn(workflow) && castNodeOf()?.bzStageDetected;
    if (detection?.errors?.length) {
      throw new Error("阶段拓扑有错误：" + detection.errors.join("；"));
    }
    if (detection?.mode === "group" && !enabledStages(castNodeOf()).length) {
      throw new Error("请至少启用一个阶段后再运行");
    }
    /* 阶段编排（20261117 方案甲 P2c/P3）——
       刻意放在 isGloballyRendering 放行**之前**：单跑与「全部渲染」批跑的每一段
       都经过这里，两条路径同一口径。按运行模式下拉（ui.runMode）+ 时间轴当前阶段
       （ui.stage）+ 三采方式钮（ui.s3Mode）裁出本次要跑的出片口集合，写进
       partialExecutionTargets（原始 api 读的就是这个键，不是上层 app 服务的
       queueNodeIds）；跨采活线在上游出范围时改接导演台读档口（潜空间 9/10、
       视频口超分 11=本段二采视频）。默认「全程」+ 单条三采子图返回 null = 不裁不改，
       与旧行为完全一致。编排失败绝不拦用户手点的运行，退回全程提交。 */
    try {
      if (!isExplicit && hasCastIn(workflow)) {
        const cnode = castNodeOf();
        const cui = cnode && cnode.h3ui;
        /* 组模式：导演台已从画布组解析出阶段 DAG，走不依赖类名的新编排 */
        const groupDetected = cnode && cnode.bzStageDetected;
        let unifiedPosts = false;
        if (groupDetected && groupDetected.mode === "group") {
          const enabled = enabledStages(cnode).map((s) => s.id);
          const disabledPosts = disabledPostGroups(cnode).map((g) => g.id);
          /* 快照必须在提交这一刻抓：识别之后选路器档位/端口名还可能变。
             画布图不被提交裁剪改动，静音节点仍在画布上，正好是静音前完整接线。 */
          const snapshot = captureExecutionGraph(app.graph, groupDetected);
          const gscoped = applyGroupScope(workflow.output, groupDetected, enabled, cnode.id,
            { snapshot, disabledPostIds: disabledPosts });
          unifiedPosts = true;
          workflow.output = gscoped.output;
          if (gscoped.partialExecutionTargets) {
            rest[0] = { ...(rest[0] || {}),
              partialExecutionTargets: gscoped.partialExecutionTargets };
          }
          console.log("[班长·组编排] 启用=" + enabled.join("/")
            + (disabledPosts.length ? " 关后处理=" + disabledPosts.join("/") : "")
            + (gscoped.partialExecutionTargets
              ? " 出片口=" + gscoped.partialExecutionTargets.join(",") : " (整图)")
            + (gscoped.rewired.length
              ? " 改接线=" + gscoped.rewired.map((r) => r.live
                  ? "#" + r.node + "←#" + r.to[0] + "口" + r.to[1] + "(活源)"
                  : "#" + r.node + "←读档口" + r.port).join(",")
              : ""));
        } else {
        /* 无组旧图走旧阶段编排：范围来自 ui.runMode / ui.stage / ui.s3Mode。
           遥控节点已于 20261118 注销，运行范围统一由导演台拓扑区表达；
           有组时上面组分支已接管，这里只服务没有画布组的旧工作流。 */
        const mode = (cui && cui.runMode) || DEFAULT_RUN_MODE;
        const stage = (cui && cui.stage) || "s1";
        const s3Mode = (cui && cui.s3Mode) || DEFAULT_S3_MODE;
        const scoped = applyStageScope(workflow.output, mode, stage, s3Mode);
        if (scoped.s3Fallback) {
          console.warn("[班长·阶段编排] 三采方式钮选「" + s3Mode
            + "」但画布上没有对应子图 —— 已按画布实际接的那条三采子图跑（不拦运行）。");
        }
        if (scoped.partialExecutionTargets || (scoped.rewired && scoped.rewired.length)) {
          workflow.output = scoped.output;
          if (scoped.partialExecutionTargets) {
            rest[0] = { ...(rest[0] || {}), partialExecutionTargets: scoped.partialExecutionTargets };
          }
          console.log("[班长·阶段编排] 模式=" + mode + " 当前阶段=" + stage
            + " 三采方式=" + scoped.s3Mode
            + " 跑=" + scoped.targets.join("/")
            + " 出片口=" + (scoped.selected.length ? scoped.selected.join(",") : "(整图)")
            + (scoped.rewired.length
              ? " 改接线=" + scoped.rewired.map((r) => "#" + r.node + "←" + (r.port === "live" ? "二采实时口" : "读档口" + r.port)).join(",")
              : ""));
        }
        }
        /* 组模式已把后处理组并进同一份规划（disabledPostIds），不再跑第二遍；
           无组回退仍走旧后处理旁路，旧工作流零破坏。 */
        if (!unifiedPosts) {
          const disabled = disabledPostGroups(cnode);
          if (disabled.length) {
            const scoped = applyPostGroupScope(workflow.output, cnode.bzPostGroups,
              disabled.map((g) => g.id), rest[0]?.partialExecutionTargets || null);
            workflow.output = scoped.output;
            rest[0] = { ...(rest[0] || {}), partialExecutionTargets: scoped.partialExecutionTargets };
          }
        }
      }
    } catch (e) {
      if (castNodeOf()?.bzStageDetected?.mode === "group" || disabledPostGroups(castNodeOf()).length) {
        throw new Error("阶段编排失败，已停止提交：" + (e?.message || e));
      }
      console.warn("[班长] 阶段编排失败，已按全程提交：", e);
    }
    try {
      /* 「全部渲染」的循环里已经 flush + applyToPrompt 过了，它提交的每一段
         都会经过这里 —— 再做一遍纯属重复劳动，直接放行。 */
      if (batchPrompt) {
        return tracked(number, workflow, ...rest);
      }
      if (hasCastIn(workflow)) {
        const node = castNodeOf();
        const st = node && node.h3ui && node.h3ui.st;
        if (st) {
          const chain = st.chain || {};
          /* clip 只用于前端内部定位段记忆（媒体架 segs / 文案台 segs）。
             它不再写进 h3_data，后端按 chain.shot（分段 uid）认段，
             所以这里不需要、也不该再做「这个 clip 在不在档案里」的校验。 */
          const proj = node && node.properties && node.properties.gcast_project;
          const shots = (proj && Array.isArray(proj.shots)) ? proj.shots : [];
          const curShot = (proj && proj.idx >= 0 && proj.idx < shots.length) ? shots[proj.idx] : null;
          const clip = (curShot && curShot.clip) ? String(curShot.clip) : String(chain.clip || "");
          /* 等三节点在途落库，保证提交那一刻前端缓存 = 后端 */
          await projectStore.flushWrites(String(chain.name || ""));
          await flushSegWrites(String(chain.name || ""), clip);
          /* 窗口 1 修复（20261111）：编译前把驱动音频重切收口。「取消接续」的重切
             是 600ms 防抖、不等它 —— 紧接着点运行会拿旧切片出片（声画错位）。flush
             立即触发待发防抖、等在途完成，循环到空闲；它还会把末段缩短后的真实帧数
             写回面板（syncShrinkFrames），所以必须排在编译**之前**，编译才能读到新
             帧数。flush 永不抛（失败已在内部给过可见提示），不会拦下用户手点的运行。
             「全部渲染」批跑绕过本包装，由 csglide_cast_run.js 在批跑开头收口一次。 */
          try {
            if (typeof node.h3ui.flushDriverReslice === "function") {
              await node.h3ui.flushDriverReslice();
            }
          } catch (e) {
            console.warn("[班长] 渲染前驱动音频收口失败，已按原样提交：", e);
          }
          let msg = "";
          try {
            /* 编译：三个 *_data 整块换成本段数据（与「全部渲染」同一份函数） */
            const built = promptBuild.apply(workflow, node, clip);
            console.log("[编译] " + lineOf(built.receipt));
            noteCompile(built.receipt, node.h3ui);
            msg = "画布运行已编译到段 " + (clip || "(未登记)")
              + "（" + built.receipt.patched.join("/") + "）";
          } catch (e) {
            /* 编译不出来（面板还没就绪 / 段数据缺失）时退回旧的提交对齐：
               手点的运行不能被一个"编译错误"拦下，用户此刻要的是出画面。
               两条路径写 h3_data 时都会清掉 chain.clip，口径一致。 */
            console.warn("[班长] 画布运行编译失败，退回提交对齐：", e);
            const touched = projectStore.applyToPrompt(workflow, node, clip);
            if (touched.length) {
              msg = "画布运行已退回对齐到段 " + (clip || "(未指定)")
                + "（" + touched.join("/") + "）";
            }
          }
          if (msg) console.log("[班长] " + msg);
        }
      }
    } catch (e) {
      console.warn("[班长] 提交前对齐失败，已按原样提交：", e);
    }
    /* 提交前门禁：编译之后再查（此时三个 *_data 已是本段数据）。
       刻意放在对齐 catch 之外 —— 否则会被「对齐失败不拦用户」的兜底吞掉。 */
    const problems = isExplicit ? [] : preflightOf(workflow);
    if (problems.length && !(typeof window !== "undefined" && window.__bzSkipPreflight)) {
      console.error("[班长] 提交前校验未通过：", problems);
      throw new Error("提交前校验未通过：\n· " + problems.join("\n· ")
        + "\n（应急跳过：控制台执行 window.__bzSkipPreflight = true）");
    }
    /* 三节点单一真源守卫（开关 window.__bzSingleSource，默认关）。 */
    const snap = snapshotsOf(workflow);
    const single = isExplicit ? null : await verifySingleSource(
      String((snap.h3.chain || {}).name || ""), snap.clip, snap);
    if (single && single.ok === false && single.errors && single.errors.length) {
      console.error("[班长] 三节点状态漂移：", single.errors);
      throw new Error("三节点状态与 segment_bindings 不一致：\n· "
        + single.errors.join("\n· ")
        + "\n（应急跳过：控制台执行 window.__bzSingleSource = false）");
    }
    /* 提交失败的兜底：浏览器对 fetch 失败只给一句 "TypeError: Failed to fetch"，
       而这几乎总是「后端不可达」（进程崩溃 / OOM 退出 / 正在重启），不是脚本 bug。
       原始错误冒出去时会被算在本文件头上（因为 queuePrompt 是本文件包装的），
       所以这里换成一句能照着查的话再抛。 */
    try {
      return await tracked(number, workflow, ...rest);
    } catch (e) {
      if (e instanceof TypeError && /failed to fetch/i.test(String(e.message || ""))) {
        console.error("[班长] 提交失败：连不上 ComfyUI 后端（进程可能已崩溃/OOM 退出或正在重启）。"
                      + "请查看启动黑窗口的最后几行。");
        throw new Error("连不上 ComfyUI 后端（不是脚本问题）：请检查启动黑窗口是否已退出或报错。");
      }
      throw e;
    }
  };

  patched = true;
  console.log("[班长] 画布运行对齐已安装");
  return true;
}

/* api 与本模块的加载顺序不保证：装不上就退避重试，而不是一次失败就永久失效
   （首版就是因为顶层只试一次、又静默跳过，才看着像"补丁没生效"）。
   一直装不上只报错一次，绝不拖慢或阻断任何提交。 */
function ensurePatch(tries) {
  if (install()) return;
  if (tries > 0) { setTimeout(() => ensurePatch(tries - 1), 300); return; }
  console.error("[班长] 画布运行对齐未能安装：api.queuePrompt 一直不可用");
}

ensurePatch(20);
