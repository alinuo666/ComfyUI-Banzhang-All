/* ============================================================
 * 工程里的「幽灵分段」判定
 * ------------------------------------------------------------
 * 一段 = 工程里一个 shot + 档案里一个 clip，一一对应。但这两个数据源是分开
 * 存的（工程在工作流节点属性里，档案在磁盘上），删段只清了一侧、或登记时撞
 * 到同一个 clip id，就会留下对不上的记录：
 *
 *   工程 4 段：[a→clip_0001, b→clip_0005, c→clip_0002, d→clip_0002]
 *   档案 3 条：[clip_0001, clip_0005, clip_0002]
 *
 * 结果：轴头（数工程）写 4 段、轴上（画档案）只有 3 块 —— "删了跟没删一样"。
 * 而「档案里没有这一段就补登记」的自愈救不了它：d 的 clip id 在档案里明明
 * 存在（只是归 c 用），答案永远是"有"，于是这段幽灵永不现身也永不被清理。
 *
 * 判据必须收得极紧才敢自动删：**后出现的那一段，它的 clip id 已经被前面
 * 某一段占用，而且确实存在于档案**。一段不可能同时属于两个分段，这条不会
 * 误伤正常段。
 *
 * 只摘工程里那条记录 —— 那个 clip 归前面那一段，跟着删档案就把真段子的
 * 成片 / 潜空间一起带走了。
 *
 * 这里刻意不 import 任何东西：导演台那些模块都拖着 ComfyUI 的运行时，
 * 拉进来这条纯判定就没法在 Node 里自测了。
 * ============================================================ */

/** 档案这一轮画出来的那些段的 clip id 集合。rows 是轴上每段的行。 */
export function clipIdsOf(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const id = r && r.clip && r.clip.id;
    if (id) set.add(id);
  }
  return set;
}

/**
 * 工程里「抢了别人的档案条目」的那些分段的下标（升序）。
 *
 * @param {Array<{clip?:string}>} shots  工程分段（顺序即片中的顺序）
 * @param {Array} rows                  轴上画出来的段（档案口径）
 * @returns {number[]} 幽灵分段下标
 */
export function ghostShotIndexes(shots, rows) {
  const list = Array.isArray(shots) ? shots : [];
  const have = clipIdsOf(rows);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const cid = list[i] && list[i].clip;
    /* 没登记过的（clip 为空）不归这里管 —— 那是自愈补登记的事。 */
    if (!cid) continue;
    /* 撞号但档案里根本没这个 id：两段都丢了档案，各自重新登记才是对的，
       不是谁抢了谁。 */
    if (seen.has(cid) && have.has(cid)) out.push(i);
    seen.add(cid);
  }
  return out;
}
