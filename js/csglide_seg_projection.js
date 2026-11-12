/* 段身份投影：档案是唯一真值，工程段列表只是它的投影（20261110 骨架重写）。
 *
 * 以前每轮「增量补建」并读自己上一轮写进段对象里的 clip。任何一轮产物少
 * 写一个字段，下一轮就认不出已有段、再补一批 —— 段数每刷一次轴往上涨
 * （多人实测：档案 4 段、工程 266 段，渲染前预检因此拦下全部渲染）。
 *
 * 这里改成纯计算：同样输入永远同样输出，输出里对应档案的 cid 恰好各一条，
 * 物理上不可能膨胀。不碰档案、不登记、不改 ComfyUI 核心。
 */

/* 输入：
 *   rows  档案段清单，每项 { clip: { id, shot, frames, trim_frames, ... } }
 *   shots 当前工程段（只读身份，state / rack / name 原样继承）
 *   name  当前工程名（挡住外来工作流残留的 clip_0001 之类编号）
 *   seen  既往确认存在于档案的 cid 集合（跨轮记忆，只读）
 *   makeBlank() 造一个空白段 state，需带 chain / cont
 * 输出：
 *   { next, out, trusted }
 *   trusted=false 表示档案清单未就绪，调用方应整轮不产出（防误删）。
 */
export function projectShots(rows, shots, name, seen, makeBlank) {
  const out = { linked: 0, swept: 0, dropped: 0, created: 0 };
  const cur = Array.isArray(shots) ? shots : [];
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { next: null, out, trusted: false };

  const order = [], byCid = new Map(), byShot = new Map();
  for (const r of list) {
    const c = r && r.clip;
    if (!c || !c.id) continue;
    const cid = String(c.id);
    if (byCid.has(cid)) continue;      // 档案里撞号只认第一条
    byCid.set(cid, c);
    order.push(cid);
    if (c.shot) byShot.set(String(c.shot), cid);
  }
  const have = new Set(order);

  /* 输入可信度：档案里消失的 cid 若多到会把工程段摘光，判定清单未就绪
     （TTL 未刷 / 拉流超时），本轮不产出。沿用旧版护栏，不放宽。 */
  const prior = (seen instanceof Set) ? seen : new Set();
  const stale = cur.filter((sh) => sh && sh.clip
    && prior.has(String(sh.clip)) && !have.has(String(sh.clip)));
  if (stale.length && stale.length >= cur.length)
    return { next: null, out, trusted: false };

  /* 一次解析每个现存段属于哪个 cid。解析不出的分两类：档案已删 → 摘掉；
     未登记新段 / 清单未就绪 → 原样保留。同一 cid 只留第一条（撞号幽灵）。 */
  const claimed = new Map(), extra = [];
  for (const sh of cur) {
    if (!sh) continue;
    let cid = sh.clip ? String(sh.clip) : "";
    if (!have.has(cid)) cid = byShot.get(String(sh.id || "")) || "";
    if (!have.has(cid)) {
      const chain = sh.state && sh.state.chain;
      cid = (chain && chain.name === name && chain.clip && have.has(String(chain.clip)))
        ? String(chain.clip) : "";
    }
    if (!cid) {
      const raw = sh.clip ? String(sh.clip) : "";
      if (raw && prior.has(raw) && !have.has(raw)) out.dropped += 1;
      else extra.push(sh);
      continue;
    }
    if (claimed.has(cid)) { out.swept += 1; continue; }
    /* 身份回绑就地写一次：写完之后下一轮 sh.clip 有值，是幂等的。
       段对象在别处被共享引用，复制会让那些引用脱节。 */
    if (!sh.clip) { sh.clip = cid; out.linked += 1; }
    claimed.set(cid, sh);
  }

  /* 投影：按档案顺序、每 cid 恰好一条；缺的按档案造副本并写全身份。 */
  const next = [];
  for (const cid of order) {
    if (claimed.has(cid)) { next.push(claimed.get(cid)); continue; }
    const c = byCid.get(cid);
    const trim = Number(c.trim_frames) || 0;
    const s = makeBlank();
    const shotUid = String(c.shot || (s.chain && s.chain.shot) || cid);
    if (s.chain) {
      s.chain.shot = shotUid;
      s.chain.name = name;
      s.chain.clip = cid;
    }
    s.length = Math.max(0, (Number(c.frames) || 0) - trim);
    s.cont = Object.assign({}, s.cont || {}, { frames: trim });
    next.push({ id: shotUid, clip: cid, name: "", state: s });
    out.created += 1;
  }
  for (const sh of extra) next.push(sh);
  return { next, out, trusted: true };
}
