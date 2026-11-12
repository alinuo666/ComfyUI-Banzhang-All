/* ============================================================
 * H3 媒体架 — 素材落盘目录（按工程隔离）
 * ------------------------------------------------------------
 * input/cglide 原本是所有工程共用的**一个**目录，文件名即全局唯一身份：
 * 新工程导入同名素材若直接覆盖，会把别的工程里引用同一路径的槽位当场换成
 * 新图（跨工程污染）。20261020 方案2：素材按工程落子目录 cglide/<片名>/。
 *
 * 但有两条必须兼容，所以不能一律落子目录：
 *   1. 同工程内重新导入同名素材 = 「用新的替换旧的、名字不变」——必须落回
 *      本工程**正在用的那个目录**原地覆盖，槽位路径不动、内容换新；落到别的
 *      目录（哪怕是本工程子目录）槽位读的还是旧文件，等于没替换。
 *   2. 本方案之前的存档，槽位指向 cglide/ 根目录；这些老素材再导入时要能
 *      覆盖到根上那一份，否则老工程永远换不掉内容。
 * 因此规则是：本工程有槽位在用同名素材 → 用它**现在那个目录**；否则 → 本工程
 * 子目录（拿不到片名时退回根目录，行为与旧版一致）。
 *
 * 纯函数：不认识 ui，只吃槽位与片名——落盘目录是这次改动的核心决策，必须
 * 能脱离浏览器单跑自测（_selftest_asset_dir.mjs 从本文件真实抠函数跑）。
 *
 * 规则本体（assetDirOf / safeDirName / castSlotFiles）在 csglide_cast_core.js
 * —— 导演台与媒体架共用同一份，各写一份就会在某次改动后各错各的。本文件只
 * 负责「媒体架的槽位长什么样」（比导演台多了 segs 分段记忆），把正在用的
 * 路径收集出来交过去。
 * ============================================================ */
import { assetDirOf } from "./csglide_cast_core.js";

/* 本工程已有的所有槽位：分段记忆 segs 各段 + 当前正在编辑的 slots。
   segs 的值形如 {slots, fps, audio_out}，st.slots 直接就是 {images,…}。 */
function allSlotLists(st) {
  const racks = Object.values((st && st.segs) || {});
  if (st && st.slots) racks.push(st.slots);
  const out = [];
  for (const rack of racks) {
    const slots = (rack && rack.slots) || rack || {};
    for (const k of ["images", "videos", "audios"]) {
      if (Array.isArray(slots[k])) out.push(slots[k]);
    }
  }
  return out;
}

/**
 * 素材该落到 input 下的哪个子目录（不含文件名）。
 * @param st          媒体架状态（用到 st.segs 与 st.slots）
 * @param projectName 当前工程片名
 * @param fileName    本次要导入的文件名（或带路径，只取最后一段）
 */
export function assetDirFor(st, projectName, fileName) {
  const used = [];
  for (const list of allSlotLists(st)) {
    for (const s of list) if (s && s.file) used.push(String(s.file));
  }
  return assetDirOf(used, projectName, fileName);
}
